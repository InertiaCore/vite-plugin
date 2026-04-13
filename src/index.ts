import fs from 'fs'
import { AddressInfo } from 'net'
import os from 'os'
import { fileURLToPath } from 'url'
import path from 'path'
import { execSync } from 'child_process'
import { globSync } from 'tinyglobby'
import colors from 'picocolors'
import { Plugin, loadEnv, UserConfig, ConfigEnv, ResolvedConfig, SSROptions, PluginOption, Rollup, createLogger } from 'vite'
import fullReload, { Config as FullReloadConfig } from 'vite-plugin-full-reload'

interface PluginConfig {
    /**
     * The path or paths of the entry points to compile.
     */
    input: Rollup.InputOption

    /**
     * InertiaCore's public directory.
     *
     * @default '../wwwroot'
     */
    publicDirectory?: string

    /**
     * The public subdirectory where compiled assets should be written.
     *
     * @default 'build'
     */
    buildDirectory?: string

    /**
     * The path to the "hot" file.
     *
     * @default `${publicDirectory}/hot`
     */
    hotFile?: string

    /**
     * The path of the SSR entry point.
     */
    ssr?: Rollup.InputOption

    /**
     * The directory where the SSR bundle should be written.
     *
     * @default 'bootstrap/ssr'
     */
    ssrOutputDirectory?: string

    /**
     * Configuration for performing full page refresh on blade (or other) file changes.
     *
     * {@link https://github.com/ElMassimo/vite-plugin-full-reload}
     * @default false
     */
    refresh?: boolean|string|string[]|RefreshConfig|RefreshConfig[]

    /**
     * Use the ASP.NET Core HTTPS development certificate to secure the Vite
     * dev server. Pass `true` to auto-detect (and auto-export) the cert from
     * `dotnet dev-certs https`, a string to use as the HMR host, or `false`
     * to explicitly disable.
     *
     * @default null
     */
    detectTls?: string | boolean | null,

    /**
     * Transform the code while serving.
     */
    transformOnServe?: (code: string, url: DevServerUrl) => string,
}

interface RefreshConfig {
    paths: string[],
    config?: FullReloadConfig,
}

interface InertiaCorePlugin extends Plugin {
    config: (config: UserConfig, env: ConfigEnv) => UserConfig
}

type DevServerUrl = `${'http'|'https'}://${string}:${number}`

let exitHandlersBound = false

export const refreshPaths = [
    'app/Livewire/**',
    'app/View/Components/**',
    'lang/**',
    'resources/lang/**',
    'resources/views/**',
    'routes/**',
].filter(path => fs.existsSync(path.replace(/\*\*$/, '')))

const logger = createLogger('info', {
    prefix: '[inertiacore-vite-plugin]'
})

/**
 * InertiaCore plugin for Vite.
 *
 * @param config - A config object or relative path(s) of the scripts to be compiled.
 */
export default function inertiacore(config: string | string[] | PluginConfig): [InertiaCorePlugin, ...Plugin[]] {
    const pluginConfig = resolvePluginConfig(config)

    return [
        resolveInertiaCorePlugin(pluginConfig),
        ...resolveFullReloadConfig(pluginConfig) as Plugin[],
    ];
}

/**
 * Resolve the InertiaCore Plugin configuration.
 */
function resolveInertiaCorePlugin(pluginConfig: Required<PluginConfig>): InertiaCorePlugin {
    let viteDevServerUrl: DevServerUrl
    let resolvedConfig: ResolvedConfig
    let userConfig: UserConfig

    const defaultAliases: Record<string, string> = {
        '@': '/resources/js',
    };

    return {
        name: 'inertiacore',
        enforce: 'post',
        config: (config, { command, mode }) => {
            userConfig = config
            const ssr = !! userConfig.build?.ssr
            const env = loadEnv(mode, userConfig.envDir || process.cwd(), '')
            const assetUrl = env.ASSET_URL ?? ''
            const serverConfig = command === 'serve'
                ? (resolveDotnetHttpsServerConfig(pluginConfig.detectTls) ?? resolveEnvironmentServerConfig(env))
                : undefined

            ensureCommandShouldRunInEnvironment(command, env)

            return {
                base: userConfig.base ?? (command === 'build' ? resolveBase(pluginConfig, assetUrl) : ''),
                publicDir: userConfig.publicDir ?? false,
                build: {
                    manifest: userConfig.build?.manifest ?? (ssr ? false : 'manifest.json'),
                    ssrManifest: userConfig.build?.ssrManifest ?? (ssr ? 'ssr-manifest.json' : false),
                    outDir: userConfig.build?.outDir ?? resolveOutDir(pluginConfig, ssr),
                    rollupOptions: {
                        input: userConfig.build?.rollupOptions?.input ?? resolveInput(pluginConfig, ssr)
                    },
                    assetsInlineLimit: userConfig.build?.assetsInlineLimit ?? 0,
                },
                server: {
                    origin: userConfig.server?.origin ?? 'http://__inertiacore_vite_placeholder__.test',
                    cors: userConfig.server?.cors ?? {
                        origin: userConfig.server?.origin ?? [
                            defaultAllowedOrigins,
                            ...(env.APP_URL ? [env.APP_URL] : []),                                  // *               (APP_URL="http://my-app.tld")
                        ],
                    },
                    ...(serverConfig ? {
                        host: userConfig.server?.host ?? serverConfig.host,
                        hmr: userConfig.server?.hmr === false ? false : {
                            ...serverConfig.hmr,
                            ...(userConfig.server?.hmr === true ? {} : userConfig.server?.hmr),
                        },
                        https: userConfig.server?.https ?? serverConfig.https,
                    } : undefined),
                },
                resolve: {
                    alias: Array.isArray(userConfig.resolve?.alias)
                        ? [
                            ...userConfig.resolve?.alias ?? [],
                            ...Object.keys(defaultAliases).map(alias => ({
                                find: alias,
                                replacement: defaultAliases[alias]
                            }))
                        ]
                        : {
                            ...defaultAliases,
                            ...userConfig.resolve?.alias,
                        }
                },
                ssr: {
                    noExternal: noExternalInertiaHelpers(userConfig),
                },
            }
        },
        configResolved(config) {
            resolvedConfig = config
        },
        transform(code) {
            if (resolvedConfig.command === 'serve') {
                code = code.replace(/http:\/\/__inertiacore_vite_placeholder__\.test/g, viteDevServerUrl)

                return pluginConfig.transformOnServe(code, viteDevServerUrl)
            }
        },
        configureServer(server) {
            const envDir = resolvedConfig.envDir || process.cwd()
            const envAppUrl = loadEnv(resolvedConfig.mode, envDir, 'APP_URL').APP_URL
            const appUrl = envAppUrl ?? getAppUrlFromLaunchSettings() ?? getAppUrlFromAppSettings()

            server.httpServer?.once('listening', () => {
                const address = server.httpServer?.address()

                const isAddressInfo = (x: string|AddressInfo|null|undefined): x is AddressInfo => typeof x === 'object'
                if (isAddressInfo(address)) {
                    viteDevServerUrl = userConfig.server?.origin ? userConfig.server.origin as DevServerUrl : resolveDevServerUrl(address, server.config, userConfig)

                    const hotFileParentDirectory = path.dirname(pluginConfig.hotFile);

                    if (! fs.existsSync(hotFileParentDirectory)) {
                        fs.mkdirSync(hotFileParentDirectory, { recursive: true })

                        setTimeout(() => {
                            logger.info(`Hot file directory created ${colors.dim(fs.realpathSync(hotFileParentDirectory))}`, { clear: true, timestamp: true })
                        }, 200)
                    }

                    fs.writeFileSync(pluginConfig.hotFile, `${viteDevServerUrl}${server.config.base.replace(/\/$/, '')}`)

                    setTimeout(() => {
                        const dotnetVer = dotnetVersion()
                        const inertiaVer = inertiaCoreVersion()

                        server.config.logger.info(`\n  ${colors.red(`${colors.bold('INERTIACORE')} ${inertiaVer.version ? `v${inertiaVer.version}` : ''}`)}  ${colors.dim('plugin')} ${colors.bold(`v${pluginVersion()}`)}`)
                        if (dotnetVer) {
                            server.config.logger.info(`\n  ${colors.green('➜')}  ${colors.bold('.NET')}: ${colors.cyan(dotnetVer)}`)
                        }
                        server.config.logger.info('')
                        server.config.logger.info(`  ${colors.green('➜')}  ${colors.bold('APP_URL')}: ${colors.cyan(appUrl.replace(/:(\d+)/, (_, port) => `:${colors.bold(port)}`))}`)

                        if (typeof resolvedConfig.server.https === 'object' && typeof resolvedConfig.server.https.key === 'string') {
                            if (resolvedConfig.server.https.key.startsWith(dotnetHttpsConfigPath())) {
                                server.config.logger.info(`  ${colors.green('➜')}  Using .NET HTTPS certificate to secure Vite.`)
                            }
                        }

                        if (inertiaVer.isBeta) {
                            server.config.logger.warn('')
                            server.config.logger.warn(`  ${colors.yellow('⚠')}  Using beta package ${colors.bold('InertiaCorePreview')} v${inertiaVer.version.replace(' (beta)', '')}. Consider upgrading to the stable ${colors.bold('AspNetCore.InertiaCore')} package.`)
                        }
                    }, 100)
                }
            })

            if (! exitHandlersBound) {
                const clean = () => {
                    if (fs.existsSync(pluginConfig.hotFile)) {
                        fs.rmSync(pluginConfig.hotFile)
                    }
                }

                process.on('exit', clean)
                process.on('SIGINT', () => process.exit())
                process.on('SIGTERM', () => process.exit())
                process.on('SIGHUP', () => process.exit())

                exitHandlersBound = true
            }

            return () => server.middlewares.use((req, res, next) => {
                if (req.url === '/index.html') {
                    res.statusCode = 404

                    res.end(
                        fs.readFileSync(path.join(dirname(), 'dev-server-index.html')).toString().replace(/{{ APP_URL }}/g, appUrl)
                    )
                }

                next()
            })
        }
    }
}

/**
 * Validate the command can run in the given environment.
 */
function ensureCommandShouldRunInEnvironment(command: 'build' | 'serve', env: Record<string, string>): void {
    if (command === 'build' || env.INERTIACORE_BYPASS_ENV_CHECK === '1') {
        return;
    }

    if (typeof env.LARAVEL_VAPOR !== 'undefined') {
        throw Error('You should not run the Vite HMR server on Vapor. You should build your assets for production instead. To disable this ENV check you may set INERTIACORE_BYPASS_ENV_CHECK=1');
    }

    if (typeof env.LARAVEL_FORGE !== 'undefined') {
        throw Error('You should not run the Vite HMR server in your Forge deployment script. You should build your assets for production instead. To disable this ENV check you may set INERTIACORE_BYPASS_ENV_CHECK=1');
    }

    if (typeof env.LARAVEL_ENVOYER !== 'undefined') {
        throw Error('You should not run the Vite HMR server in your Envoyer hook. You should build your assets for production instead. To disable this ENV check you may set INERTIACORE_BYPASS_ENV_CHECK=1')
    }

    if (typeof env.CI !== 'undefined') {
        throw Error('You should not run the Vite HMR server in CI environments. You should build your assets for production instead. To disable this ENV check you may set INERTIACORE_BYPASS_ENV_CHECK=1')
    }
}

/**
 * The version of InertiaCore being run.
 */
function inertiaCoreVersion(): { version: string; isBeta: boolean } {
    try {
        const csprojFiles = fs.readdirSync('..').filter(file => file.endsWith('.csproj'))

        for (const file of csprojFiles) {
            try {
                const content = fs.readFileSync(path.join('..', file), 'utf8')

                // Look for PackageReference to InertiaCorePreview (beta) first
                const previewPackageRefMatch = content.match(/<PackageReference\s+Include="InertiaCorePreview"\s+Version="([^"]+)"/i)
                if (previewPackageRefMatch) {
                    return { version: `${previewPackageRefMatch[1]} (beta)`, isBeta: true }
                }

                // Look for PackageReference to AspNetCore.InertiaCore
                const packageRefMatch = content.match(/<PackageReference\s+Include="AspNetCore\.InertiaCore"\s+Version="([^"]+)"/i)
                if (packageRefMatch) {
                    return { version: packageRefMatch[1], isBeta: false }
                }

                // Look for ProjectReference to InertiaCore project and check its version
                const projectRefMatch = content.match(/<ProjectReference\s+Include="[^"]*InertiaCore[^"]*\.csproj"/i)
                if (projectRefMatch) {
                    // Try to find the referenced project and get its version
                    const referencedProjectPath = projectRefMatch[0].match(/Include="([^"]+)"/)?.[1]
                    if (referencedProjectPath) {
                        const fullPath = path.resolve('..', path.dirname(file), referencedProjectPath)
                        if (fs.existsSync(fullPath)) {
                            const referencedContent = fs.readFileSync(fullPath, 'utf8')
                            const versionMatch = referencedContent.match(/<Version>([^<]+)<\/Version>/i)
                            if (versionMatch) {
                                return { version: versionMatch[1], isBeta: false }
                            }
                        }
                    }
                }
            } catch {
                continue
            }
        }

        return { version: '', isBeta: false }
    } catch {
        return { version: '', isBeta: false }
    }
}

/**
 * The version of .NET being run.
 */
function dotnetVersion(): string {
    try {
        // First, try to get the highest .NET version from csproj target frameworks
        const csprojVersion = getHighestDotnetVersionFromCsproj()
        if (csprojVersion) {
            return csprojVersion
        }

        // Fallback to CLI version
        const result = execSync('dotnet --version', { encoding: 'utf8', stdio: 'pipe' })
        return result.trim()
    } catch {
        return ''
    }
}

/**
 * Get the highest .NET version from csproj target frameworks.
 */
function getHighestDotnetVersionFromCsproj(): string {
    try {
        const csprojFiles = fs.readdirSync('..').filter(file => file.endsWith('.csproj'))
        const versions: number[] = []

        for (const file of csprojFiles) {
            try {
                const content = fs.readFileSync(path.join('..', file), 'utf8')

                // Look for single TargetFramework
                const singleFrameworkMatch = content.match(/<TargetFramework>(net\d+\.\d+)<\/TargetFramework>/i)
                if (singleFrameworkMatch) {
                    const versionNum = parseFloat(singleFrameworkMatch[1].replace('net', ''))
                    if (!isNaN(versionNum)) {
                        versions.push(versionNum)
                    }
                }

                // Look for multiple TargetFrameworks
                const multiFrameworkMatch = content.match(/<TargetFrameworks>([^<]+)<\/TargetFrameworks>/i)
                if (multiFrameworkMatch) {
                    const frameworks = multiFrameworkMatch[1].split(';')
                    for (const framework of frameworks) {
                        const trimmed = framework.trim()
                        if (trimmed.startsWith('net')) {
                            const versionNum = parseFloat(trimmed.replace('net', ''))
                            if (!isNaN(versionNum)) {
                                versions.push(versionNum)
                            }
                        }
                    }
                }
            } catch {
                continue
            }
        }

        if (versions.length > 0) {
            const highestVersion = Math.max(...versions)
            return highestVersion.toString()
        }

        return ''
    } catch {
        return ''
    }
}

/**
 * The version of the InertiaCore Vite plugin being run.
 */
function pluginVersion(): string {
    try {
        return JSON.parse(fs.readFileSync(path.join(dirname(), '../package.json')).toString())?.version
    } catch {
        return ''
    }
}

/**
 * Get the application URL from Properties/launchSettings.json.
 */
function getAppUrlFromLaunchSettings(): string | null {
    const launchSettingsPath = '../Properties/launchSettings.json'

    try {
        if (fs.existsSync(launchSettingsPath)) {
            const rawContent = fs.readFileSync(launchSettingsPath, 'utf8')
            // Remove BOM if present
            const cleanContent = rawContent.replace(/^\uFEFF/, '')
            const content = JSON.parse(cleanContent)

            // First try to get from profiles (prefer Project profile over IIS Express)
            if (content.profiles) {
                // Look for a Project profile first
                for (const [, profile] of Object.entries(content.profiles)) {
                    if (profile && typeof profile === 'object' && 'commandName' in profile && profile.commandName === 'Project') {
                        if ('applicationUrl' in profile && typeof profile.applicationUrl === 'string') {
                            // applicationUrl can be semicolon-separated, return all URLs
                            const urls = profile.applicationUrl.split(';').map((url: string) => url.trim())
                            return urls.join(' | ')
                        }
                    }
                }

                // Fallback to any profile with applicationUrl
                for (const [, profile] of Object.entries(content.profiles)) {
                    if (profile && typeof profile === 'object' && 'applicationUrl' in profile && typeof profile.applicationUrl === 'string') {
                        const urls = profile.applicationUrl.split(';').map((url: string) => url.trim())
                        return urls.join(';')
                    }
                }
            }

            // Fallback to IIS Express settings
            if (content.iisSettings?.iisExpress?.applicationUrl) {
                return content.iisSettings.iisExpress.applicationUrl
            }
        }
    } catch {
        // Continue to next fallback if parsing fails
    }

    return null
}

/**
 * Get the application URL from appsettings files (local, development, then default).
 */
function getAppUrlFromAppSettings(): string {
    const settingsFiles = [
        '../appsettings.Local.json',
        '../appsettings.Development.json',
        '../appsettings.json'
    ]

    for (const settingsFile of settingsFiles) {
        try {
            if (fs.existsSync(settingsFile)) {
                const content = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))

                // Check various possible locations for the URL
                if (content.ApplicationUrl) {
                    return content.ApplicationUrl
                }
                if (content.Kestrel?.Endpoints?.Http?.Url) {
                    return content.Kestrel.Endpoints.Http.Url
                }
                if (content.Kestrel?.Endpoints?.Https?.Url) {
                    return content.Kestrel.Endpoints.Https.Url
                }
                if (content.urls) {
                    // urls can be a semicolon-separated string, take the first one
                    return content.urls.split(';')[0]
                }
            }
        } catch {
            continue
        }
    }

    return 'https://localhost:5001' // Default fallback
}

/**
 * Convert the users configuration into a standard structure with defaults.
 */
function resolvePluginConfig(config: string|string[]|PluginConfig): Required<PluginConfig> {
    if (typeof config === 'undefined') {
        throw new Error('inertiacore-vite-plugin: missing configuration.')
    }

    if (typeof config === 'string' || Array.isArray(config)) {
        config = { input: config, ssr: config }
    }

    if (typeof config.input === 'undefined') {
        throw new Error('inertiacore-vite-plugin: missing configuration for "input".')
    }

    if (typeof config.publicDirectory === 'string') {
        config.publicDirectory = config.publicDirectory.trim().replace(/^\/+/, '')

        if (config.publicDirectory === '') {
            throw new Error('inertiacore-vite-plugin: publicDirectory must be a subdirectory. E.g. \'public\'.')
        }
    }

    if (typeof config.buildDirectory === 'string') {
        config.buildDirectory = config.buildDirectory.trim().replace(/^\/+/, '').replace(/\/+$/, '')

        if (config.buildDirectory === '') {
            throw new Error('inertiacore-vite-plugin: buildDirectory must be a subdirectory. E.g. \'build\'.')
        }
    }

    if (typeof config.ssrOutputDirectory === 'string') {
        config.ssrOutputDirectory = config.ssrOutputDirectory.trim().replace(/^\/+/, '').replace(/\/+$/, '')
    }

    if (config.refresh === true) {
        config.refresh = [{ paths: refreshPaths }]
    }

    return {
        input: config.input,
        publicDirectory: config.publicDirectory ?? '../wwwroot',
        buildDirectory: config.buildDirectory ?? 'build',
        ssr: config.ssr ?? config.input,
        ssrOutputDirectory: config.ssrOutputDirectory ?? 'bootstrap/ssr',
        refresh: config.refresh ?? false,
        hotFile: config.hotFile ?? path.join((config.publicDirectory ?? '../wwwroot'), 'hot'),
        detectTls: config.detectTls ?? null,
        transformOnServe: config.transformOnServe ?? ((code) => code),
    }
}

/**
 * Resolve the Vite base option from the configuration.
 */
function resolveBase(config: Required<PluginConfig>, assetUrl: string): string {
    return assetUrl + (! assetUrl.endsWith('/') ? '/' : '') + config.buildDirectory + '/'
}

/**
 * Resolve the Vite input path from the configuration.
 */
function resolveInput(config: Required<PluginConfig>, ssr: boolean): Rollup.InputOption|undefined {
    if (ssr) {
        return config.ssr
    }

    return config.input
}

/**
 * Resolve the Vite outDir path from the configuration.
 */
function resolveOutDir(config: Required<PluginConfig>, ssr: boolean): string|undefined {
    if (ssr) {
        return config.ssrOutputDirectory
    }

    return path.join(config.publicDirectory, config.buildDirectory)
}

function resolveFullReloadConfig({ refresh: config }: Required<PluginConfig>): PluginOption[]{
    if (typeof config === 'boolean') {
        return [];
    }

    if (typeof config === 'string') {
        config = [{ paths: [config]}]
    }

    if (! Array.isArray(config)) {
        config = [config]
    }

    if (config.some(c => typeof c === 'string')) {
        config = [{ paths: config }] as RefreshConfig[]
    }

    return (config as RefreshConfig[]).flatMap(c => {
        const plugin = fullReload(c.paths, c.config)

        /* eslint-disable-next-line @typescript-eslint/ban-ts-comment */
        /** @ts-ignore */
        plugin.__inertiacore_plugin_config = c

        return plugin
    })
}

/**
 * Resolve the dev server URL from the server address and configuration.
 */
function resolveDevServerUrl(address: AddressInfo, config: ResolvedConfig, userConfig: UserConfig): DevServerUrl {
    const configHmrProtocol = typeof config.server.hmr === 'object' ? config.server.hmr.protocol : null
    const clientProtocol = configHmrProtocol ? (configHmrProtocol === 'wss' ? 'https' : 'http') : null
    const serverProtocol = config.server.https ? 'https' : 'http'
    const protocol = clientProtocol ?? serverProtocol

    const configHmrHost = typeof config.server.hmr === 'object' ? config.server.hmr.host : null
    const configHost = typeof config.server.host === 'string' ? config.server.host : null
    const sailHost = process.env.LARAVEL_SAIL && ! userConfig.server?.host ? 'localhost' : null
    const serverAddress = isIpv6(address) ? `[${address.address}]` : address.address
    const host = configHmrHost ?? sailHost ?? configHost ?? serverAddress

    const configHmrClientPort = typeof config.server.hmr === 'object' ? config.server.hmr.clientPort : null
    const port = configHmrClientPort ?? address.port

    return `${protocol}://${host}:${port}`
}

function isIpv6(address: AddressInfo): boolean {
    return address.family === 'IPv6'
        // In node >=18.0 <18.4 this was an integer value. This was changed in a minor version.
        // See: https://github.com/laravel/vite-plugin/issues/103
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore-next-line
        || address.family === 6;
}

/**
 * Add the Inertia helpers to the list of SSR dependencies that aren't externalized.
 *
 * @see https://vitejs.dev/guide/ssr.html#ssr-externals
 */
function noExternalInertiaHelpers(config: UserConfig): true|Array<string|RegExp> {
    /* eslint-disable-next-line @typescript-eslint/ban-ts-comment */
    /* @ts-ignore */
    const userNoExternal = (config.ssr as SSROptions | undefined)?.noExternal
    const pluginNoExternal = ['inertiacore-vite-plugin']

    if (userNoExternal === true) {
        return true
    }

    if (typeof userNoExternal === 'undefined') {
        return pluginNoExternal
    }

    return [
        ...(Array.isArray(userNoExternal) ? userNoExternal : [userNoExternal]),
        ...pluginNoExternal,
    ]
}

/**
 * Resolve the server config from the environment.
 */
function resolveEnvironmentServerConfig(env: Record<string, string>): {
    hmr?: { host: string }
    host?: string,
    https?: { cert: Buffer, key: Buffer }
}|undefined {
    if (! env.VITE_DEV_SERVER_KEY && ! env.VITE_DEV_SERVER_CERT) {
        return
    }

    if (! fs.existsSync(env.VITE_DEV_SERVER_KEY) || ! fs.existsSync(env.VITE_DEV_SERVER_CERT)) {
        throw Error(`Unable to find the certificate files specified in your environment. Ensure you have correctly configured VITE_DEV_SERVER_KEY: [${env.VITE_DEV_SERVER_KEY}] and VITE_DEV_SERVER_CERT: [${env.VITE_DEV_SERVER_CERT}].`)
    }

    const host = resolveHostFromEnv(env)

    if (! host) {
        throw Error(`Unable to determine the host from the environment's APP_URL: [${env.APP_URL}].`)
    }

    return {
        hmr: { host },
        host,
        https: {
            key: fs.readFileSync(env.VITE_DEV_SERVER_KEY),
            cert: fs.readFileSync(env.VITE_DEV_SERVER_CERT),
        },
    }
}

/**
 * Resolve the host name from the environment.
 */
function resolveHostFromEnv(env: Record<string, string>): string|undefined
{
    try {
        return new URL(env.APP_URL).host
    } catch {
        return
    }
}

/**
 * Resolve the ASP.NET Core HTTPS development certificate for the Vite dev
 * server. When `host === false` this returns `undefined`. When `true` or a
 * string, the cert is read from the standard .NET dev-certs directory and
 * auto-exported via `dotnet dev-certs https` if missing.
 */
function resolveDotnetHttpsServerConfig(host: string|boolean|null): {
    hmr?: { host: string }
    host?: string,
    https?: { cert: string, key: string }
}|undefined {
    if (host === false) {
        return
    }

    const httpsConfigPath = dotnetHttpsConfigPath()
    const certificateName = getDotnetCertificateName()

    if (!fs.existsSync(httpsConfigPath)) {
        try {
            fs.mkdirSync(httpsConfigPath, { recursive: true })
        } catch {
            return
        }
    }

    const keyPath = path.resolve(httpsConfigPath, `${certificateName}.key`)
    const certPath = path.resolve(httpsConfigPath, `${certificateName}.crt`)

    // If either file is missing, try to export the .NET dev cert as PEM.
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
        if (host === null) {
            return
        }

        try {
            execSync(
                `dotnet dev-certs https --export-path "${certPath}" --format Pem --no-password`,
                { stdio: 'pipe' },
            )
        } catch {
            return
        }
    }

    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
        return
    }

    const resolvedHost = typeof host === 'string' ? host : 'localhost'

    return {
        hmr: { host: resolvedHost },
        host: resolvedHost,
        https: {
            key: keyPath,
            cert: certPath,
        },
    }
}

/**
 * The directory of the current file.
 */
function dirname(): string {
    return fileURLToPath(new URL('.', import.meta.url))
}

/**
 * .NET HTTPS certificate configuration directory.
 */
function dotnetHttpsConfigPath(): string {
    // Check for Windows APPDATA path first, then fallback to Unix-style home path
    const baseFolder = process.env.APPDATA
        ? path.resolve(process.env.APPDATA, 'ASP.NET', 'https')
        : path.resolve(os.homedir(), '.aspnet', 'https')

    return baseFolder
}

/**
 * Get the certificate name for .NET HTTPS certificates.
 */
function getDotnetCertificateName(): string {
    // Check command line arguments for --name parameter
    const certificateArg = process.argv
        .map(arg => arg.match(/--name=(.+)/i))
        .filter(Boolean)[0]

    if (certificateArg) {
        return certificateArg[1]
    }

    // Fallback to npm package name or project directory name
    return process.env.npm_package_name || path.basename(process.cwd())
}
