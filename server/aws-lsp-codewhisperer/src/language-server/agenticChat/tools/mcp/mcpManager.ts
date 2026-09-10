/*!
 * Copyright Amazon.com, Inc. or its affiliates.
 * All Rights Reserved. SPDX-License-Identifier: Apache-2.0
 */

import type { Features } from '@aws/language-server-runtimes/server-interface/server'
import { ChatTelemetryEventName } from '../../../../shared/telemetry/types'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
    StreamableHTTPClientTransport,
    StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport, SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js'
import {
    MCPServerConfig,
    McpToolDefinition,
    ListToolsResponse,
    McpServerRuntimeState,
    McpServerStatus,
    McpPermissionType,
    MCPServerPermission,
    AgentConfig,
    isMCPServerConfig,
    isRegistryServerConfig,
} from './mcpTypes'
import {
    isEmptyEnv,
    loadAgentConfig,
    saveAgentConfig,
    saveServerSpecificAgentConfig,
    sanitizeName,
    getGlobalAgentConfigPath,
    getWorkspaceMcpConfigPaths,
    getGlobalMcpConfigPath,
    getGlobalPersonaConfigPath,
    normalizePathFromUri,
} from './mcpUtils'
import { AgenticChatError } from '../../errors'
import { EventEmitter } from 'events'
import { Mutex } from 'async-mutex'
import path = require('path')
import { URI } from 'vscode-uri'
import { MessageType } from '@aws/language-server-runtimes/protocol'
import {
    hasApproval,
    recordApproval,
    removeApproval,
    fingerprintServerConfig,
    effectiveEnv,
    effectiveHeaders,
} from './mcpConsentStore'
import { sanitizeInput } from '../../../../shared/utils'
import { ProfileStatusMonitor } from './profileStatusMonitor'
import { OAuthClient } from './mcpOauthClient'
import { AgentPermissionManager } from './agentPermissionManager'
import { McpRegistryService } from './mcpRegistryService'
import { McpRegistryData } from './mcpTypes'

export const MCP_SERVER_STATUS_CHANGED = 'mcpServerStatusChanged'
export const AGENT_TOOLS_CHANGED = 'agentToolsChanged'
export enum AuthIntent {
    Interactive = 'interactive',
    Silent = 'silent',
}

/**
 * Manages MCP servers and their tools
 */
export class McpManager {
    static #instance?: McpManager
    private clients: Map<string, Client>
    private processPids: Map<string, number>
    private dockerContainers: Map<string, string>
    private mcpTools: McpToolDefinition[]
    private mcpServers: Map<string, MCPServerConfig>
    private mcpServerStates: Map<string, McpServerRuntimeState>
    public configLoadErrors: Map<string, string>
    private mcpServerPermissions: Map<string, MCPServerPermission>
    public readonly events: EventEmitter
    private static readonly configMutex = new Mutex()
    private static readonly personaMutex = new Mutex()
    private readonly serverInitMutexes = new Map<string, Mutex>()
    private toolNameMapping: Map<string, { serverName: string; toolName: string }>
    private serverNameMapping: Map<string, string>
    private agentConfig!: AgentConfig
    private permissionManager!: AgentPermissionManager
    private registryService?: McpRegistryService
    private currentRegistry: McpRegistryData | null = null
    private registryUrlProvided: boolean = false
    private isPeriodicSync: boolean = false
    private sessionDeniedConsent = new Set<string>()

    private constructor(
        private agentPaths: string[],
        private features: Pick<
            Features,
            'logging' | 'workspace' | 'lsp' | 'telemetry' | 'credentialsProvider' | 'runtime' | 'agent'
        >
    ) {
        this.mcpTools = []
        this.clients = new Map<string, Client>()
        this.processPids = new Map<string, number>()
        this.dockerContainers = new Map<string, string>()
        this.mcpServers = new Map<string, MCPServerConfig>()
        this.mcpServerStates = new Map<string, McpServerRuntimeState>()
        this.configLoadErrors = new Map<string, string>()
        this.mcpServerPermissions = new Map<string, MCPServerPermission>()
        this.events = new EventEmitter({ captureRejections: true }).on('error', console.error)
        this.features.logging.info(`MCP manager: initialized with ${agentPaths.length} configs`)
        this.toolNameMapping = new Map<string, { serverName: string; toolName: string }>()
        this.serverNameMapping = new Map<string, string>()
    }

    public static async init(
        agentPaths: string[],
        features: Pick<
            Features,
            'logging' | 'workspace' | 'lsp' | 'telemetry' | 'credentialsProvider' | 'runtime' | 'agent'
        >,
        options?: { registryUrl?: string }
    ): Promise<McpManager> {
        if (!McpManager.#instance) {
            const mgr = new McpManager(agentPaths, features)
            McpManager.#instance = mgr

            // Initialize registry service if URL provided
            if (options?.registryUrl) {
                mgr.registryUrlProvided = true
                try {
                    mgr.registryService = new McpRegistryService(features.logging)
                    const registry = await mgr.registryService.fetchRegistry(options.registryUrl)
                    if (registry) {
                        mgr.currentRegistry = registry
                        features.logging.info(
                            `MCP Registry: Registry mode ACTIVE - ${registry.servers.length} servers from ${options.registryUrl}`
                        )
                    }
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : String(error)
                    features.logging.error(`MCP Registry: Error during initialization: ${errorMsg}`)
                    // Store the specific registry error for display in UI
                    mgr.configLoadErrors.set('registry', errorMsg)
                }
            }

            // DO NOT discover servers here - wait for auth to be initialized
            features.logging.info('MCP: Manager initialized, waiting for auth before discovering servers')
        }
        return McpManager.#instance!
    }

    public static get instance(): McpManager {
        if (!McpManager.#instance) {
            throw new Error('McpManager not initialized—call McpManager.init(...) first')
        }
        return McpManager.#instance
    }

    /**
     * Check if McpManager has been initialized
     */
    public static isInitialized(): boolean {
        return !!McpManager.#instance
    }

    /**
     * Return the current runtime state for one server.
     */
    public getServerState(serverName: string): McpServerRuntimeState | undefined {
        return this.mcpServerStates.get(serverName)
    }

    /**
     * Return a copy of the entire server‑state map.
     */
    public getAllServerStates(): Map<string, McpServerRuntimeState> {
        return new Map(this.mcpServerStates)
    }

    /**
     * Emit MCP configuration telemetry metrics
     * Should be called after servers are discovered and initialized
     */
    public emitMcpConfigMetrics(): void {
        const serverConfigs = this.getAllServerConfigs()
        const activeServers = Array.from(serverConfigs.entries()).filter(([name, _]) => !this.isServerDisabled(name))

        // Count global vs project servers
        const globalServers = Array.from(serverConfigs.entries()).filter(
            ([_, config]) =>
                config?.__configPath__ === getGlobalAgentConfigPath(this.features.workspace.fs.getUserHomeDir())
        ).length
        const projectServers = serverConfigs.size - globalServers

        // Count tools by permission
        let toolsAlwaysAllowed = 0
        let toolsDenied = 0

        for (const [serverName, _] of activeServers) {
            const toolsWithPermissions = this.getAllToolsWithPermissions(serverName)
            toolsWithPermissions.forEach(item => {
                if (item.permission === McpPermissionType.alwaysAllow) {
                    toolsAlwaysAllowed++
                } else if (item.permission === McpPermissionType.deny) {
                    toolsDenied++
                }
            })
        }

        // Emit MCP configuration metrics
        if (this.features.telemetry) {
            this.features.telemetry.emitMetric({
                name: ChatTelemetryEventName.MCPConfig,
                data: {
                    credentialStartUrl: this.features.credentialsProvider?.getConnectionMetadata()?.sso?.startUrl,
                    languageServerVersion: this.features.runtime?.serverInfo.version,
                    numActiveServers: activeServers.length,
                    numGlobalServers: globalServers,
                    numProjectServers: projectServers,
                    numToolsAlwaysAllowed: toolsAlwaysAllowed,
                    numToolsDenied: toolsDenied,
                },
            })
        }

        this.features.logging.info(
            `MCP Config Metrics: ${activeServers.length} active servers, ${this.mcpTools.length} tools`
        )
    }

    /**
     * Load configurations and initialize each enabled server.
     * Should only be called after auth is initialized and MCP is enabled.
     */
    public async discoverAllServers(): Promise<void> {
        // Load agent config with registry support
        const result = await loadAgentConfig(
            this.features.workspace,
            this.features.logging,
            this.agentPaths,
            this.currentRegistry,
            this.isRegistryModeActive()
        )

        // Extract agent config and other data
        this.agentConfig = result.agentConfig
        this.permissionManager = new AgentPermissionManager(
            this.agentConfig,
            (serverName: string) => this.getAvailableToolsForServer(serverName),
            () => this.getAllAvailableServerNames(),
            () => this.getAllBuiltinToolNames()
        )
        this.mcpServers = result.servers
        this.serverNameMapping = result.serverNameMapping

        // Reset the configuration errors after every refresh.
        // But preserve registry errors when registry mode is active
        const savedRegistryError = this.isRegistryModeActive() ? this.configLoadErrors.get('registry') : undefined
        this.configLoadErrors.clear()

        // Store any config load errors
        result.errors.forEach((errorMsg, key) => {
            this.configLoadErrors.set(key, errorMsg)
        })

        // Restore registry errors if they existed and no new registry errors were found
        if (savedRegistryError && !this.configLoadErrors.has('registry')) {
            this.configLoadErrors.set('registry', savedRegistryError)
        }

        this.features.logging.info('Using agent configuration')

        // Reset permissions map
        this.mcpServerPermissions.clear()
        // Create init state
        for (const [sanitizedName, _] of this.mcpServers.entries()) {
            // Set server status to UNINITIALIZED initially
            this.setState(sanitizedName, McpServerStatus.UNINITIALIZED, 0)
        }
        // Get all servers that need to be initialized
        const serversToInit: Array<[string, MCPServerConfig]> = []

        for (const [name, cfg] of this.mcpServers.entries()) {
            if (this.isServerDisabled(name)) {
                this.features.logging.info(`MCP: server '${name}' is disabled by persona settings, skipping`)
                this.setState(name, McpServerStatus.DISABLED, 0)
                this.emitToolsChanged(name)
                continue
            }
            if (!isMCPServerConfig(cfg)) {
                this.features.logging.warn(`MCP: server '${name}' has invalid config, skipping`)
                continue
            }
            // Check if this is a placeholder for a missing registry server
            if ((cfg as any).__registryError__) {
                this.features.logging.warn(`MCP: server '${name}' not found in registry, marking as failed`)
                this.setState(name, McpServerStatus.FAILED, 0, (cfg as any).__registryError__)
                this.emitToolsChanged(name)
                continue
            }
            serversToInit.push([name, cfg])
        }

        // Process servers in batches of 5 at a time
        const MAX_CONCURRENT_SERVERS = 5
        const totalServers = serversToInit.length

        if (totalServers > 0) {
            this.features.logging.info(
                `MCP: initializing ${totalServers} servers with max concurrency of ${MAX_CONCURRENT_SERVERS}`
            )

            // Process servers in batches
            for (let i = 0; i < totalServers; i += MAX_CONCURRENT_SERVERS) {
                const batch = serversToInit.slice(i, i + MAX_CONCURRENT_SERVERS)
                const batchPromises = batch.map(([name, cfg]) => this.initOneServer(name, cfg, AuthIntent.Silent))

                this.features.logging.debug(
                    `MCP: initializing batch of ${batch.length} servers (${i + 1}-${Math.min(i + MAX_CONCURRENT_SERVERS, totalServers)} of ${totalServers})`
                )
                await Promise.all(batchPromises)
            }

            this.features.logging.info(`MCP: completed initialization of ${totalServers} servers`)
        } else {
            // Emit event to refresh MCP list page when no servers are configured
            this.setState('no-servers', McpServerStatus.UNINITIALIZED, 0)
        }

        for (const [sanitizedName, _] of this.mcpServers.entries()) {
            const name = this.serverNameMapping.get(sanitizedName) || sanitizedName
            // Initialize permissions for this server
            const serverPrefix = `@${name}`

            // Extract tool permissions from agent config
            const toolPerms: Record<string, McpPermissionType> = {}

            // Check if the server is enabled as a whole (@server) or just specific tools (@server/tool)
            const isWholeServerEnabled = this.agentConfig.tools.includes(serverPrefix)

            if (isWholeServerEnabled) {
                // Check for specific tools in allowedTools
                this.agentConfig.allowedTools.forEach(allowedTool => {
                    if (allowedTool.startsWith(serverPrefix + '/')) {
                        const toolName = allowedTool.substring(serverPrefix.length + 1)
                        if (toolName) {
                            // This specific tool is in allowedTools
                            toolPerms[toolName] = McpPermissionType.alwaysAllow
                        }
                    }
                })
            } else {
                // Only specific tools are enabled
                // get allTools of this server, if it's not in tools --> it's denied
                // have to move the logic after all servers finish init, because that's when we have list of tools
                const deniedTools = new Set(
                    this.getAllTools()
                        .filter(tool => tool.serverName === name)
                        .map(tool => tool.toolName)
                )
                this.agentConfig.tools.forEach(tool => {
                    if (tool.startsWith(serverPrefix + '/')) {
                        // remove this from deniedTools
                        const toolName = tool.substring(serverPrefix.length + 1)
                        deniedTools.delete(toolName)
                        if (toolName) {
                            // Check if tool is in allowedTools
                            if (this.agentConfig.allowedTools.includes(tool)) {
                                toolPerms[toolName] = McpPermissionType.alwaysAllow
                            } else {
                                toolPerms[toolName] = McpPermissionType.ask
                            }
                        }
                    }
                })

                // update permission to deny for rest of the tools
                deniedTools.forEach(tool => {
                    toolPerms[tool] = McpPermissionType.deny
                })
            }

            this.mcpServerPermissions.set(sanitizedName, {
                enabled: true,
                toolPerms,
            })
        }
    }

    /**
     * Start a server process, connect client, and register its tools.
     * Errors are logged but do not stop discovery of other servers.
     */
    private async initOneServer(
        serverName: string,
        cfg: MCPServerConfig,
        authIntent: AuthIntent = AuthIntent.Silent
    ): Promise<void> {
        // Get or create mutex for this server to prevent concurrent initialization
        if (!this.serverInitMutexes.has(serverName)) {
            this.serverInitMutexes.set(serverName, new Mutex())
        }
        const serverMutex = this.serverInitMutexes.get(serverName)!

        return serverMutex.runExclusive(async () => {
            try {
                await this.initOneServerInternal(serverName, cfg, authIntent)
            } catch (error) {
                this.features.logging.error(`MCP: [${serverName}] initialization failed: ${error}`)
                throw error
            }
        })
    }

    private async initOneServerInternal(
        serverName: string,
        cfg: MCPServerConfig,
        authIntent: AuthIntent = AuthIntent.Silent
    ): Promise<void> {
        const DEFAULT_SERVER_INIT_TIMEOUT_MS = 120_000

        // Consent gate for workspace-scoped MCP configs (P417451767).
        // Workspace-scoped configs live in a folder the user opened and may be attacker-controlled.
        // Global configs (~/.aws/amazonq/...) are user-authored and trusted implicitly.
        const home = this.features.workspace.fs.getUserHomeDir()
        const configPath = cfg.__configPath__
            ? normalizePathFromUri(cfg.__configPath__, this.features.logging)
            : undefined
        const globalMcp = getGlobalMcpConfigPath(home)
        const globalAgent = getGlobalAgentConfigPath(home)
        const globalPersona = getGlobalPersonaConfigPath(home)
        const isWorkspaceScoped =
            !!configPath && configPath !== globalMcp && configPath !== globalAgent && configPath !== globalPersona
        if (isWorkspaceScoped && configPath) {
            const denyKey = `${serverName}|${configPath}|${fingerprintServerConfig(cfg)}`
            if (this.sessionDeniedConsent.has(denyKey)) {
                this.setState(serverName, McpServerStatus.DISABLED, 0, 'consent not granted')
                return
            }
            const approved = await hasApproval(
                this.features.workspace,
                this.features.logging,
                serverName,
                cfg,
                configPath
            )
            if (!approved) {
                const cmdLine = [cfg.command ?? cfg.url ?? '(none)', ...(cfg.args ?? [])].join(' ').slice(0, 200)
                // Surface the environment variables and headers the server will actually be
                // launched with. Names only, never values: a config may legitimately hold
                // tokens, and this string is shown in a dialog and written to logs. Values are
                // covered by the fingerprint, so any value change re-prompts.
                const envKeys = Object.keys(effectiveEnv(cfg))
                const headerNames = Object.keys(effectiveHeaders(cfg))
                const envLine =
                    envKeys.length > 0
                        ? `Environment variables: ${envKeys.join(', ').slice(0, 200)}\n`
                        : `Environment variables: (none)\n`
                const headerLine = headerNames.length > 0 ? `Headers: ${headerNames.join(', ').slice(0, 200)}\n` : ''
                const allowBtn = { title: 'Allow for this server' }
                const denyBtn = { title: 'Deny' }
                let choice: { title: string } | null | undefined
                try {
                    choice = await this.features.lsp.window.showMessageRequest({
                        type: MessageType.Warning,
                        message:
                            `Amazon Q — Untrusted MCP Server\n\n` +
                            `A workspace configuration file wants to start an MCP server.\n` +
                            `Server: ${serverName}\n` +
                            `Command: ${cmdLine}\n` +
                            envLine +
                            headerLine +
                            `Source: ${configPath}\n\n` +
                            `Running this server executes the above command on your machine, ` +
                            `with the environment variables listed above. ` +
                            `Review them in the configuration file if you are unsure — variables such as ` +
                            `NODE_OPTIONS can cause additional code to run. ` +
                            `Only allow if you trust the authors of this workspace.\n\n` +
                            `Your choice will be remembered for this workspace. ` +
                            `If you allow, you won't be asked again unless the server configuration changes.`,
                        actions: [allowBtn, denyBtn],
                    })
                } catch (e: any) {
                    this.features.logging.warn(`MCP: consent prompt failed for '${serverName}': ${e?.message}`)
                    this.setState(serverName, McpServerStatus.FAILED, 0, 'consent prompt failed')
                    return
                }
                if (choice?.title !== allowBtn.title) {
                    this.features.logging.info(
                        `MCP: user declined consent for workspace-scoped server '${serverName}' (response: ${choice?.title ?? 'dismissed'})`
                    )
                    this.sessionDeniedConsent.add(denyKey)
                    this.setState(serverName, McpServerStatus.DISABLED, 0, 'consent not granted')
                    return
                }
                await recordApproval(this.features.workspace, this.features.logging, serverName, cfg, configPath)
                this.features.logging.info(`MCP: recorded consent for workspace-scoped server '${serverName}'`)
            }
        }

        // Lightweight cleanup - only kill our tracked processes
        await this.cleanupExistingServer(serverName)

        this.setState(serverName, McpServerStatus.INITIALIZING, 0)

        try {
            this.features.logging.debug(`MCP: initializing server [${serverName}]`)

            const client = new Client({
                name: `q-chat-plugin`, // Do not use server name in the client name to avoid polluting builder-mcp metrics
                version: '1.0.0',
            })

            let transport: any
            const isStdio = !!cfg.command
            const doConnect = async () => {
                if (isStdio) {
                    // stdio transport - merge additional env with base env
                    const finalEnv = { ...(cfg.env || {}), ...(cfg.__additionalEnv__ || {}) }
                    const mergedEnv = {
                        ...(process.env as Record<string, string>),
                        // Make sure we do not have empty key and value in mergedEnv, or adding server through UI will fail on Windows
                        ...(finalEnv && !isEmptyEnv(finalEnv)
                            ? Object.fromEntries(Object.entries(finalEnv).filter(([k, v]) => k.trim() && v.trim()))
                            : {}),
                    }
                    let cwd: string | undefined
                    try {
                        const folders = this.features.workspace.getAllWorkspaceFolders()
                        if (folders.length > 0) cwd = URI.parse(folders[0].uri).fsPath
                    } catch {
                        this.features.logging.debug(
                            `MCP: no workspace folder for [${serverName}], continuing without cwd`
                        )
                    }
                    const argsStr = (cfg.args ?? []).length > 0 ? ` ${(cfg.args ?? []).join(' ')}` : ''
                    const envKeys = Object.keys(finalEnv || {})
                    const envInfo = envKeys.length > 0 ? ` (env: ${envKeys.join(', ')})` : ''
                    this.features.logging.info(`MCP: Executing command: ${cfg.command}${argsStr}${envInfo}`)

                    transport = new StdioClientTransport({
                        command: cfg.command!,
                        args: cfg.args ?? [],
                        env: mergedEnv,
                        cwd,
                        stderr: 'pipe',
                    })

                    // Capture stderr from the transport
                    const stderrStream = transport.stderr
                    if (stderrStream) {
                        stderrStream.on('data', (data: Buffer) => {
                            const output = data.toString().trim()
                            if (output) {
                                this.features.logging.warn(`MCP [${serverName}] stderr: ${output}`)
                            }
                        })
                    }

                    this.features.logging.info(`MCP: Connecting MCP server using StdioClientTransport`)
                    try {
                        await client.connect(transport)
                    } catch (err: any) {
                        let errorMessage = err?.message ?? String(err)
                        if (err?.code === 'ENOENT') {
                            errorMessage = `Command '${cfg.command}' not found. Please ensure it's installed and on your PATH.`
                        } else if (err?.code === 'EINVAL') {
                            errorMessage = `Invalid arguments for command '${cfg.command}'.`
                        } else if (err?.code === -32000) {
                            errorMessage = `MCP protocol error. The server may not be properly configured.`
                        }
                        throw new AgenticChatError(
                            `MCP: server '${serverName}' failed to connect: ${errorMessage}`,
                            'MCPServerConnectionFailed'
                        )
                    }

                    // Store PID for process cleanup
                    if (transport.pid) {
                        this.processPids.set(serverName, transport.pid)

                        // Track Docker container for Docker commands (lightweight approach)
                        if (cfg.command && cfg.command.includes('docker')) {
                            try {
                                const { execSync } = require('child_process')
                                // Get the most recent container (likely ours)
                                const containerId = execSync('docker ps -q --latest', { encoding: 'utf8' }).trim()
                                if (containerId) {
                                    this.dockerContainers.set(serverName, containerId)
                                }
                            } catch (dockerError) {
                                this.features.logging.warn(
                                    `MCP: [${serverName}] error tracking Docker container: ${dockerError}`
                                )
                            }
                        }
                    }
                } else {
                    // streamable http/SSE transport - merge additional headers with base headers
                    const base = new URL(cfg.url!)
                    try {
                        // Use HEAD to check if it needs OAuth
                        let headers: Record<string, string> = {
                            ...(cfg.headers ?? {}),
                            ...(cfg.__additionalHeaders__ ?? {}),
                        }
                        let needsOAuth = false
                        try {
                            const headResp = await fetch(base, { method: 'HEAD', headers })
                            const www = headResp.headers.get('www-authenticate') || ''
                            this.features.logging.info(`MCP: HEAD response status: ${headResp.status}`)

                            if (headResp.status === 401 || headResp.status === 403 || /bearer/i.test(www)) {
                                needsOAuth = true
                                this.features.logging.info(`MCP: OAuth detected via HEAD (${headResp.status})`)
                            } else if (headResp.status === 405 || headResp.status === 404) {
                                // HEAD not supported (405) or endpoint not found for HEAD (404), try POST-based OAuth detection
                                this.features.logging.info(
                                    `MCP: HEAD returned ${headResp.status}, trying POST-based OAuth detection`
                                )
                                needsOAuth = await this.detectOAuthFromPostError(base, headers)
                                if (needsOAuth) {
                                    this.features.logging.info(`MCP: OAuth detected via POST error`)
                                }
                            }
                        } catch {
                            this.features.logging.info(`MCP: HEAD not available`)
                        }

                        if (needsOAuth) {
                            OAuthClient.initialize(this.features.workspace, this.features.logging, this.features.lsp)
                            try {
                                const bearer = await OAuthClient.getValidAccessToken(base, {
                                    interactive: authIntent === AuthIntent.Interactive,
                                })
                                if (bearer) {
                                    headers = { ...headers, Authorization: `Bearer ${bearer}` }
                                } else if (authIntent === AuthIntent.Silent) {
                                    throw new AgenticChatError(
                                        `Server '${serverName}' requires OAuth. Click on Save to reauthenticate.`,
                                        'MCPServerAuthFailed'
                                    )
                                }
                            } catch (e: any) {
                                const msg = e?.message || ''
                                const short = /authorization_timed_out/i.test(msg)
                                    ? 'Sign-in timed out. Please try again.'
                                    : /Authorization error|PKCE|access_denied|login|consent|token exchange failed/i.test(
                                            msg
                                        )
                                      ? 'Sign-in was cancelled or failed. Please try again.'
                                      : `OAuth failed: ${msg}`

                                throw new AgenticChatError(`MCP: ${short}`, 'MCPServerAuthFailed')
                            }
                        }

                        const headerKeys = Object.keys(headers)
                        const headerInfo = headerKeys.length > 0 ? ` (headers: ${headerKeys.join(', ')})` : ''
                        this.features.logging.info(`MCP: Connecting to URL: ${cfg.url}${headerInfo}`)

                        try {
                            // try streamable http first
                            transport = new StreamableHTTPClientTransport(base, this.buildHttpOpts(headers))

                            this.features.logging.info(`MCP: Connecting MCP server using StreamableHTTPClientTransport`)
                            await client.connect(transport)
                        } catch (err) {
                            // fallback to SSE
                            this.features.logging.info(
                                `MCP: streamable http connect failed for [${serverName}], fallback to SSEClientTransport: ${String(err)}`
                            )
                            transport = new SSEClientTransport(new URL(cfg.url!), this.buildSseOpts(headers))
                            await client.connect(transport)
                        }
                    } catch (err: any) {
                        let errorMessage = err?.message ?? String(err)
                        const oauthHint = /oauth/i.test(errorMessage) ? ' (OAuth)' : ''
                        throw new AgenticChatError(
                            `MCP: server '${serverName}' failed to connect${oauthHint}: ${errorMessage}`,
                            'MCPServerConnectionFailed'
                        )
                    }
                }
            }

            const connectPromise = doConnect()

            const timeoutMs =
                cfg.initializationTimeout === 0 || cfg.initializationTimeout === undefined
                    ? 0
                    : (cfg.initializationTimeout ?? DEFAULT_SERVER_INIT_TIMEOUT_MS)

            if (timeoutMs > 0) {
                await Promise.race([
                    connectPromise,
                    new Promise<never>((_, reject) => {
                        const t = setTimeout(
                            () =>
                                reject(
                                    new AgenticChatError(
                                        `MCP: server '${serverName}' initialization timed out after ${timeoutMs} ms`,
                                        'MCPServerInitTimeout'
                                    )
                                ),
                            timeoutMs
                        )
                        t.unref()
                    }),
                ])
            } else {
                await connectPromise
            }

            this.clients.set(serverName, client)
            this.mcpTools = this.mcpTools.filter(t => t.serverName !== serverName)

            const resp = (await client.listTools()) as ListToolsResponse
            for (const t of resp.tools) {
                if (!t.name) {
                    this.features.logging.warn(`MCP: server [${serverName}] returned tool with no name, skipping`)
                    continue
                }
                this.features.logging.info(`MCP: discovered tool ${serverName}::${t.name}`)
                this.mcpTools.push({
                    serverName,
                    toolName: t.name,
                    description: sanitizeInput(t.description ?? ''),
                    inputSchema: t.inputSchema ?? {},
                })
            }

            // Cache version for registry servers
            if (this.currentRegistry) {
                const unsanitizedName = this.serverNameMapping.get(serverName) || serverName
                const registryServer = this.currentRegistry.servers.find(s => s.name === unsanitizedName)
                if (registryServer) {
                    cfg.__cachedVersion__ = registryServer.version
                    this.features.logging.debug(
                        `MCP Registry: Cached version ${registryServer.version} for server '${unsanitizedName}'`
                    )
                }
            }

            this.setState(serverName, McpServerStatus.ENABLED, resp.tools.length)
            this.emitToolsChanged(serverName)
        } catch (e: any) {
            this.features.logging.warn(`MCP: server [${serverName}] init failed: ${e.message}`)
            const client = this.clients.get(serverName)
            if (client) {
                await client.close()
                this.clients.delete(serverName)
            }
            // Clean up PID and Docker container references
            const pid = this.processPids.get(serverName)
            if (pid) {
                try {
                    process.kill(pid, 'SIGTERM')
                } catch (killError: any) {
                    if (killError.code !== 'ESRCH') {
                        this.features.logging.warn(
                            `MCP: error terminating failed server process ${pid}: ${killError.message}`
                        )
                    }
                }
            }
            this.processPids.delete(serverName)

            const containerId = this.dockerContainers.get(serverName)
            if (containerId) {
                try {
                    const { execSync } = require('child_process')
                    execSync(`docker kill ${containerId}`, { stdio: 'ignore' })
                } catch (killError: any) {
                    this.features.logging.warn(
                        `MCP: error killing failed Docker container ${containerId}: ${killError.message}`
                    )
                }
            }
            this.dockerContainers.delete(serverName)
            this.mcpTools = this.mcpTools.filter(t => t.serverName !== serverName)
            this.handleError(serverName, e)
        }
    }

    /**
     * Update server map
     */
    public updateServerMap(newMap: Map<string, MCPServerConfig>): void {
        this.mcpServers = new Map(newMap)
    }

    /**
     * Return a list of all discovered tools.
     */
    public getAllTools(): McpToolDefinition[] {
        return [...this.mcpTools]
    }

    /**
     * Return all tools and their permissions
     * If serverFilter is given, only tools from that server are returned.
     */
    public getAllToolsWithPermissions(serverFilter?: string): {
        tool: McpToolDefinition
        permission: McpPermissionType
    }[] {
        return this.mcpTools
            .filter(t => !serverFilter || t.serverName === serverFilter)
            .map(toolDef => ({
                tool: toolDef,
                requiresApproval: this.requiresApproval(toolDef.serverName, toolDef.toolName),
                permission: this.getToolPerm(toolDef.serverName, toolDef.toolName),
            }))
    }

    /**
     * Return a list of all enabled tools.
     */
    public getEnabledTools(): McpToolDefinition[] {
        return this.mcpTools.filter(
            t => !this.isServerDisabled(t.serverName) && !this.isToolDisabled(t.serverName, t.toolName)
        )
    }

    /**
     * Returns true if the given tool on the given server is currently disabled.
     */
    public isToolDisabled(server: string, tool: string): boolean {
        // built-in tools cannot be disabled
        if (server === 'builtIn') {
            return false
        }

        // Get unsanitized server name for prefix
        const unsanitizedServerName = this.serverNameMapping.get(server) || server
        return !this.permissionManager.isToolEnabled(server === 'builtIn' ? 'builtIn' : unsanitizedServerName, tool)
    }

    /**
     * Returns true if the given server is currently disabled.
     */
    public isServerDisabled(name: string): boolean {
        const cfg = this.mcpServers.get(name)
        return cfg?.disabled ?? false
    }

    /**
     * Returns tool permission type for a given tool.
     */
    public getToolPerm(server: string, tool: string): McpPermissionType {
        const unsanitizedServerName = this.serverNameMapping.get(server) || server
        return this.permissionManager.getToolPermission(server === 'builtIn' ? 'builtIn' : unsanitizedServerName, tool)
    }

    /**
     * Return a list of all server configurations.
     */
    public getAllServerConfigs(): Map<string, MCPServerConfig> {
        return new Map(this.mcpServers)
    }

    /**
     * Map server names to their available tool names.
     */
    public listServersAndTools(): Record<string, string[]> {
        const result: Record<string, string[]> = {}
        for (const { serverName, toolName } of this.mcpTools) {
            result[serverName] ||= []
            result[serverName].push(toolName)
        }
        return result
    }

    /**
     * Invoke a tool on a server after validating server and tool.
     * @throws if server or tool is missing, disabled, or disconnected(shouldn't happen).
     */
    public async callTool(server: string, tool: string, args: any): Promise<any> {
        const DEFAULT_TOOL_EXEC_TIMEOUT_MS = 60_000

        const cfg = this.mcpServers.get(server)
        if (!cfg) throw new Error(`MCP: server '${server}' is not configured`)
        if (this.isServerDisabled(server)) throw new Error(`MCP: server '${server}' is disabled`)

        const available = this.getEnabledTools()
            .filter(t => t.serverName === server)
            .map(t => t.toolName)
        if (!available.includes(tool)) {
            throw new Error(`MCP: tool '${tool}' not found on '${server}'. Available: ${available.join(', ')}`)
        }

        const client = this.clients.get(server)
        if (!client) throw new Error(`MCP: server '${server}' not connected`)

        const timeoutCfg = cfg.timeout
        const callPromise = client.callTool({ name: tool, arguments: args })

        // 0 -> no timeout
        if (timeoutCfg === 0) {
            return await callPromise
        }

        const execTimeout = timeoutCfg ?? DEFAULT_TOOL_EXEC_TIMEOUT_MS
        const timeoutPromise = new Promise<never>((_, reject) => {
            const timer = setTimeout(
                () =>
                    reject(
                        new AgenticChatError(
                            `MCP: tool '${server}::${tool}' execution timed out after ${execTimeout} ms`,
                            'MCPToolExecTimeout'
                        )
                    ),
                execTimeout
            )
            timer.unref()
        })

        try {
            return await Promise.race([callPromise, timeoutPromise])
        } catch (err: unknown) {
            if (err instanceof AgenticChatError && err.code === 'MCPToolExecTimeout') {
                this.features.logging.error(err.message)
            }
            throw err
        }
    }

    /**
     * Add a registry server: persist config, register in memory, and initialize.
     */
    public async addRegistryServer(
        serverName: string,
        cfg: MCPServerConfig,
        configPath: string,
        additionalHeaders?: Record<string, string>,
        additionalEnv?: Record<string, string>
    ): Promise<void> {
        const sanitizedName = sanitizeName(serverName)
        if (
            this.mcpServers.has(sanitizedName) &&
            this.getServerState(sanitizedName)?.status == McpServerStatus.ENABLED
        ) {
            throw new Error(`MCP: server '${sanitizedName}' already exists`)
        }

        // Filter out empty key-value pairs
        if (additionalHeaders) {
            additionalHeaders = Object.fromEntries(
                Object.entries(additionalHeaders).filter(([k, v]) => k.trim() && v.trim())
            )
        }
        if (additionalEnv) {
            additionalEnv = Object.fromEntries(Object.entries(additionalEnv).filter(([k, v]) => k.trim() && v.trim()))
        }

        // Save registry server config with type: 'registry', timeout, and additional headers/env
        const registryServerConfig: any = { type: 'registry' as const }
        if (cfg.timeout !== undefined) {
            registryServerConfig.timeout = cfg.timeout
        }
        if (additionalHeaders && Object.keys(additionalHeaders).length > 0) {
            registryServerConfig.headers = additionalHeaders
        }
        if (additionalEnv && Object.keys(additionalEnv).length > 0) {
            registryServerConfig.env = additionalEnv
        }
        this.agentConfig.mcpServers[serverName] = registryServerConfig

        const serverPrefix = `@${serverName}`
        if (!this.agentConfig.tools.includes(serverPrefix)) {
            this.agentConfig.tools.push(serverPrefix)
        }

        await saveServerSpecificAgentConfig(
            this.features.workspace,
            this.features.logging,
            serverName,
            registryServerConfig,
            [serverPrefix],
            [],
            configPath
        )

        // Store additional headers/env separately and merge for runtime
        const newCfg: MCPServerConfig = { ...cfg, __configPath__: configPath }
        if (additionalHeaders && Object.keys(additionalHeaders).length > 0) {
            newCfg.__additionalHeaders__ = additionalHeaders
        }
        if (additionalEnv && Object.keys(additionalEnv).length > 0) {
            newCfg.__additionalEnv__ = additionalEnv
        }
        this.mcpServers.set(sanitizedName, newCfg)
        this.serverNameMapping.set(sanitizedName, serverName)

        await this.initOneServer(sanitizedName, newCfg, AuthIntent.Interactive)
    }

    /**
     * Add a new server: persist config, register in memory, and initialize.
     */
    public async addServer(
        serverName: string,
        cfg: MCPServerConfig,
        configPath: string,
        isLegacyMcpServer: boolean = false
    ): Promise<void> {
        try {
            // Reject manual server addition when registry is active
            if (this.isRegistryModeActive()) {
                throw new Error(
                    'MCP: Cannot add servers manually when registry mode is active. Please install servers from the registry.'
                )
            }

            const sanitizedName = sanitizeName(serverName)
            if (
                this.mcpServers.has(sanitizedName) &&
                this.getServerState(sanitizedName)?.status == McpServerStatus.ENABLED
            ) {
                throw new Error(`MCP: server '${sanitizedName}' already exists`)
            }

            if (isLegacyMcpServer) {
                // Handle legacy MCP config file
                await this.mutateConfigFile(configPath, (json: any) => {
                    if (!json.mcpServers) {
                        json.mcpServers = {}
                    }
                    json.mcpServers[serverName] = {
                        command: cfg.command,
                        url: cfg.url,
                        args: cfg.args,
                        env: cfg.env,
                        headers: cfg.headers,
                        timeout: cfg.timeout,
                        initializationTimeout: cfg.initializationTimeout,
                        disabled: cfg.disabled ?? false,
                    }
                })

                // Move tool permissions to corresponding agent path
                const agentPath = configPath.replace(
                    path.sep + 'mcp.json',
                    path.sep + 'agents' + path.sep + 'default.json'
                )

                const serverPrefix = `@${serverName}`
                let serverTools = this.agentConfig.tools.filter(
                    tool => tool === serverPrefix || tool.startsWith(`${serverPrefix}/`)
                )
                if (serverTools.length === 0) {
                    serverTools = [serverPrefix]
                }
                let serverAllowedTools = this.agentConfig.allowedTools.filter(
                    tool => tool === serverPrefix || tool.startsWith(`${serverPrefix}/`)
                )

                // Push to agent config after setup
                this.agentConfig.tools.push(...serverTools.filter(tool => !this.agentConfig.tools.includes(tool)))
                this.agentConfig.allowedTools.push(
                    ...serverAllowedTools.filter(tool => !this.agentConfig.allowedTools.includes(tool))
                )

                await saveServerSpecificAgentConfig(
                    this.features.workspace,
                    this.features.logging,
                    serverName,
                    null,
                    serverTools,
                    serverAllowedTools,
                    agentPath,
                    true
                )
            } else {
                // Add server to agent config
                const serverConfig: MCPServerConfig = {
                    command: cfg.command,
                    url: cfg.url,
                    initializationTimeout: cfg.initializationTimeout,
                    disabled: cfg.disabled ?? false,
                }
                // Only add timeout to agent config if it's not 0
                if (cfg.timeout !== undefined) {
                    serverConfig.timeout = cfg.timeout
                }
                if (cfg.args && cfg.args.length > 0) {
                    serverConfig.args = cfg.args
                }
                if (cfg.env && !isEmptyEnv(cfg.env)) {
                    serverConfig.env = cfg.env
                }
                if (cfg.headers && !isEmptyEnv(cfg.headers)) {
                    serverConfig.headers = cfg.headers
                }

                // Add to agent config
                this.agentConfig.mcpServers[serverName] = serverConfig

                // Check if the server already has permissions in the agent config
                const serverPrefix = `@${serverName}`
                const hasServerInTools = this.agentConfig.tools.some(
                    tool => tool === serverPrefix || tool.startsWith(`${serverPrefix}/`)
                )

                // Only set permissions if the server doesn't already have them
                if (!hasServerInTools) {
                    // Enable the server as a whole rather than individual tools
                    this.agentConfig.tools.push(serverPrefix)
                }

                // Save server-specific changes to agent config
                const serverTools = this.agentConfig.tools.filter(
                    tool => tool === serverPrefix || tool.startsWith(`${serverPrefix}/`)
                )
                const serverAllowedTools = this.agentConfig.allowedTools.filter(
                    tool => tool === serverPrefix || tool.startsWith(`${serverPrefix}/`)
                )

                await saveServerSpecificAgentConfig(
                    this.features.workspace,
                    this.features.logging,
                    serverName,
                    serverConfig,
                    serverTools,
                    serverAllowedTools,
                    configPath
                )
            }

            const newCfg: MCPServerConfig = { ...cfg, __configPath__: configPath }
            this.mcpServers.set(sanitizedName, newCfg)
            this.serverNameMapping.set(sanitizedName, serverName)

            // Add server tools to tools list after initialization
            await this.initOneServer(sanitizedName, newCfg, AuthIntent.Interactive)
        } catch (err) {
            this.features.logging.error(
                `Failed to add MCP server '${serverName}': ${err instanceof Error ? err.message : String(err)}`
            )
            this.handleError(serverName, err)
            return
        }
    }

    /**
     * Remove a server: shutdown client, remove tools, and delete disk entry.
     * @param skipAgentConfigRemoval - If true, only removes from mcpManager but keeps in agent config
     */
    public async removeServer(serverName: string, skipAgentConfigRemoval: boolean = false): Promise<void> {
        const cfg = this.mcpServers.get(serverName)
        const unsanitizedName = this.serverNameMapping.get(serverName)
        const permission = this.mcpServerPermissions.get(serverName)
        if (!cfg || !cfg.__configPath__) {
            throw new Error(`MCP: server '${serverName}' not found`)
        }

        const client = this.clients.get(serverName)
        if (client) {
            await client.close()
            this.clients.delete(serverName)
        }
        this.mcpTools = this.mcpTools.filter(t => t.serverName !== serverName)
        this.mcpServerStates.delete(serverName)

        // Clean up any persisted consent approval for this server
        if (cfg.__configPath__) {
            const normalizedPath = normalizePathFromUri(cfg.__configPath__, this.features.logging)
            await removeApproval(this.features.workspace, this.features.logging, serverName, normalizedPath)
        }

        // Check if this is a legacy MCP server (from MCP config file)
        const isLegacyMcpServer = cfg.__configPath__?.endsWith('mcp.json')
        let agentPath: string | undefined

        if (isLegacyMcpServer && unsanitizedName) {
            // Remove from MCP config file
            await this.mutateConfigFile(cfg.__configPath__, (json: any) => {
                if (json.mcpServers && json.mcpServers[unsanitizedName]) {
                    delete json.mcpServers[unsanitizedName]
                }
            })

            agentPath = cfg.__configPath__.replace(
                path.sep + 'mcp.json',
                path.sep + 'agents' + path.sep + 'default.json'
            )
        }

        // Remove from agent config (unless skipAgentConfigRemoval is true)
        if (!skipAgentConfigRemoval && unsanitizedName && this.agentConfig) {
            // Remove server from mcpServers
            delete this.agentConfig.mcpServers[unsanitizedName]

            // Remove server tools from tools list
            this.agentConfig.tools = this.agentConfig.tools.filter(tool => {
                if (tool.startsWith('@')) {
                    if (tool === `@${unsanitizedName}`) {
                        return false
                    }
                    if (tool.startsWith(`@${unsanitizedName}/`)) {
                        return false
                    }
                }
                return true
            })

            // Remove server tools from allowedTools
            this.agentConfig.allowedTools = this.agentConfig.allowedTools.filter(tool => {
                if (tool.startsWith('@')) {
                    if (tool === `@${unsanitizedName}`) {
                        return false
                    }
                    if (tool.startsWith(`@${unsanitizedName}/`)) {
                        return false
                    }
                }
                return true
            })

            // Save server removal to agent config
            await saveServerSpecificAgentConfig(
                this.features.workspace,
                this.features.logging,
                unsanitizedName,
                null, // null indicates server should be removed
                [],
                [],
                isLegacyMcpServer ? agentPath! : cfg.__configPath__,
                isLegacyMcpServer
            )
        }

        this.mcpServers.delete(serverName)
        this.serverNameMapping.delete(serverName)
        this.emitToolsChanged(serverName)
    }

    /**
     * Update a server: persist changes, teardown old client/tools, and re-init if enabled.
     */
    public async updateServer(
        serverName: string,
        configUpdates: Partial<Omit<MCPServerConfig, '__configPath__'>>,
        agentPath: string
    ): Promise<void> {
        try {
            const oldCfg = this.mcpServers.get(serverName)
            if (!oldCfg) {
                throw new Error(`MCP: server '${serverName}' not found`)
            }

            const unsanitizedServerName = this.serverNameMapping.get(serverName)!

            // Update agent config
            if (this.agentConfig && unsanitizedServerName) {
                const existingConfig = this.agentConfig.mcpServers[unsanitizedServerName]
                const updatedConfig = { ...(isMCPServerConfig(existingConfig) ? existingConfig : {}) }
                if (configUpdates.url !== undefined) updatedConfig.url = configUpdates.url
                if (configUpdates.headers !== undefined) {
                    if (configUpdates.headers && Object.keys(configUpdates.headers).length) {
                        updatedConfig.headers = configUpdates.headers
                    } else {
                        delete updatedConfig.headers // allow user to clear headers
                    }
                }
                if (configUpdates.command !== undefined) updatedConfig.command = configUpdates.command
                if (configUpdates.initializationTimeout !== undefined)
                    updatedConfig.initializationTimeout = configUpdates.initializationTimeout
                if (configUpdates.timeout !== undefined) updatedConfig.timeout = configUpdates.timeout
                if (configUpdates.args !== undefined) {
                    if (configUpdates.args.length > 0) {
                        updatedConfig.args = configUpdates.args
                    } else {
                        delete updatedConfig.args
                    }
                }
                if (configUpdates.env !== undefined) {
                    if (!isEmptyEnv(configUpdates.env)) {
                        updatedConfig.env = configUpdates.env
                    } else {
                        delete updatedConfig.env
                    }
                }
                if (configUpdates.disabled !== undefined) {
                    updatedConfig.disabled = configUpdates.disabled
                }
                this.agentConfig.mcpServers[unsanitizedServerName] = updatedConfig

                // Save server-specific changes to agent config
                const serverPrefix = `@${unsanitizedServerName}`
                const serverTools = this.agentConfig.tools.filter(
                    tool => tool === serverPrefix || tool.startsWith(`${serverPrefix}/`)
                )
                const serverAllowedTools = this.agentConfig.allowedTools.filter(
                    tool => tool === serverPrefix || tool.startsWith(`${serverPrefix}/`)
                )

                await saveServerSpecificAgentConfig(
                    this.features.workspace,
                    this.features.logging,
                    unsanitizedServerName,
                    updatedConfig,
                    serverTools,
                    serverAllowedTools,
                    agentPath
                )
            }

            const newCfg: MCPServerConfig = {
                ...oldCfg,
                ...configUpdates,
            }

            const oldClient = this.clients.get(serverName)
            if (oldClient) {
                await oldClient.close()
                this.clients.delete(serverName)
            }
            this.mcpTools = this.mcpTools.filter(t => t.serverName !== serverName)
            this.mcpServers.set(serverName, newCfg)
            this.serverNameMapping.set(serverName, unsanitizedServerName)

            if (this.isServerDisabled(serverName)) {
                this.setState(serverName, McpServerStatus.DISABLED, 0)
                this.emitToolsChanged(serverName)
            } else {
                await this.initOneServer(serverName, newCfg, AuthIntent.Interactive)
            }
        } catch (err) {
            this.handleError(serverName, err)
            return
        }
    }

    /**
     * Close all clients, clear state, and reset singleton.
     */
    public async close(keepInstance: boolean = false): Promise<void> {
        this.features.logging.info('MCP: closing all clients and tracked processes')

        // Close all clients in parallel for faster shutdown
        const clientClosePromises = []
        for (const [name, client] of this.clients.entries()) {
            clientClosePromises.push(
                client
                    .close()
                    .catch(e => this.features.logging.error(`MCP: error closing client ${name}: ${e.message}`))
            )
        }

        // Kill our tracked processes (no timeout delays)
        for (const [name, pid] of this.processPids.entries()) {
            try {
                process.kill(pid, 'SIGTERM')
            } catch (e: any) {
                if (e.code !== 'ESRCH') {
                    this.features.logging.warn(`MCP: error terminating process ${pid} for ${name}: ${e.message}`)
                }
            }
        }

        // Kill our tracked Docker containers
        for (const [name, containerId] of this.dockerContainers.entries()) {
            try {
                const { execSync } = require('child_process')
                execSync(`docker kill ${containerId}`, { stdio: 'ignore' })
            } catch (e: any) {
                this.features.logging.warn(
                    `MCP: error killing Docker container ${containerId} for ${name}: ${e.message}`
                )
            }
        }

        // Wait for all clients to close
        await Promise.all(clientClosePromises)

        this.clients.clear()
        this.processPids.clear()
        this.dockerContainers.clear()
        this.mcpTools = []
        this.mcpServers.clear()
        this.mcpServerStates.clear()
        this.sessionDeniedConsent.clear()
        this.agentConfig = {
            name: 'q_ide_default',
            description: 'Agent configuration',
            mcpServers: {},
            tools: [],
            allowedTools: [],
            toolsSettings: {},
            resources: [],
            useLegacyMcpJson: true,
        }
        if (!keepInstance) {
            McpManager.#instance = undefined
        }
    }

    /**
     * Reinitialize all MCP servers by closing existing connections and rediscovering servers
     */
    public async reinitializeMcpServers(): Promise<void> {
        this.features.logging.info('Reinitializing MCP servers')

        try {
            // Save the current tool name mapping to preserve tool names across reinitializations
            const savedToolNameMapping = this.getToolNameMapping()
            // Save registry errors only if registry is active
            const isRegistryActive = this.isRegistryModeActive()
            const savedRegistryErrors = isRegistryActive ? this.configLoadErrors.get('registry') : undefined

            // close clients, clear state, but don't reset singleton
            await this.close(true)

            // Restore the saved tool name mapping
            this.setToolNameMapping(savedToolNameMapping)
            // Restore registry errors if they existed
            if (savedRegistryErrors) {
                this.configLoadErrors.set('registry', savedRegistryErrors)
            }

            const shouldDiscoverServers = ProfileStatusMonitor.getMcpState()
            if (shouldDiscoverServers) {
                await this.discoverAllServers()
            }
            const reinitializedServerCount = McpManager.#instance?.mcpServers.size
            this.features.logging.info(
                `MCP servers reinitialization completed. Total servers: ${reinitializedServerCount}`
            )
        } catch (err: any) {
            this.features.logging.error(`Error reinitializing MCP servers: ${err.message}`)
            throw err
        }
    }

    /**
     * Update permission for given server: if only tool permission changes, does not teardown and re-init.
     */
    public async updateServerPermission(serverName: string, perm: MCPServerPermission): Promise<void> {
        try {
            const unsanitizedServerName = this.serverNameMapping.get(serverName) || serverName

            // Get server config
            const serverConfig = this.mcpServers.get(serverName)
            if (!serverConfig) {
                throw new Error(`Server '${serverName}' not found`)
            }

            const serverPrefix = `@${unsanitizedServerName}`

            // Check if this is a legacy MCP server (from MCP config file)
            const isLegacyMcpServer = serverConfig.__configPath__?.endsWith('mcp.json')

            // For agent config servers, use the permission manager
            for (const [toolName, permission] of Object.entries(perm.toolPerms || {})) {
                this.permissionManager.setToolPermission(unsanitizedServerName, toolName, permission)
            }

            // Update the agent config from the permission manager
            this.agentConfig = this.permissionManager.getAgentConfig()

            if (isLegacyMcpServer) {
                // For legacy MCP servers, save permissions to agent config file and update MCP config for enable/disable
                const mcpConfigPath = serverConfig.__configPath__!
                const agentPath = mcpConfigPath.replace(
                    path.sep + 'mcp.json',
                    path.sep + 'agents' + path.sep + 'default.json'
                )

                // Update MCP config for enable/disable
                await this.mutateConfigFile(mcpConfigPath, (json: any) => {
                    if (!json.mcpServers[unsanitizedServerName]) {
                        json.mcpServers[unsanitizedServerName] = { ...serverConfig }
                        delete json.mcpServers[unsanitizedServerName].__configPath__
                    }
                    json.mcpServers[unsanitizedServerName].disabled = !perm.enabled
                })

                // Use the same function but with corrected agent path
                const serverPrefix = `@${unsanitizedServerName}`
                const serverTools = this.agentConfig.tools.filter(
                    tool => tool === serverPrefix || tool.startsWith(`${serverPrefix}/`)
                )
                const serverAllowedTools = this.agentConfig.allowedTools.filter(
                    tool => tool === serverPrefix || tool.startsWith(`${serverPrefix}/`)
                )

                await saveServerSpecificAgentConfig(
                    this.features.workspace,
                    this.features.logging,
                    unsanitizedServerName,
                    null, // Don't save server config to agent file for legacy servers
                    serverTools,
                    serverAllowedTools,
                    agentPath,
                    isLegacyMcpServer
                )
            }

            // Update mcpServerPermissions map immediately to reflect changes
            this.mcpServerPermissions.set(serverName, {
                enabled: perm.enabled,
                toolPerms: perm.toolPerms || {},
            })

            // Update server enabled/disabled state (only for non-legacy servers)
            if (!isLegacyMcpServer) {
                const serverCfg = this.agentConfig.mcpServers[unsanitizedServerName]
                if (serverCfg && isMCPServerConfig(serverCfg)) {
                    serverCfg.disabled = !perm.enabled
                }
            }

            // Always update the mcpServers map
            if (serverConfig) {
                serverConfig.disabled = !perm.enabled
            }

            // Save only server-specific changes to agent config (for non-legacy servers)
            if (!isLegacyMcpServer) {
                const agentPath = perm.__configPath__
                if (agentPath) {
                    // Collect server-specific tools and allowedTools
                    const serverPrefix = `@${unsanitizedServerName}`
                    const serverTools = this.agentConfig.tools.filter(
                        tool => tool === serverPrefix || tool.startsWith(`${serverPrefix}/`)
                    )
                    const serverAllowedTools = this.agentConfig.allowedTools.filter(
                        tool => tool === serverPrefix || tool.startsWith(`${serverPrefix}/`)
                    )

                    const serverCfg = this.agentConfig.mcpServers[unsanitizedServerName]
                    await saveServerSpecificAgentConfig(
                        this.features.workspace,
                        this.features.logging,
                        unsanitizedServerName,
                        isMCPServerConfig(serverCfg) ? serverCfg : null,
                        serverTools,
                        serverAllowedTools,
                        agentPath,
                        false,
                        this.isRegistryModeActive()
                    )
                }
            }

            // enable/disable server
            if (this.isServerDisabled(serverName)) {
                const client = this.clients.get(serverName)
                if (client) {
                    await client.close()
                    this.clients.delete(serverName)
                }
                this.setState(serverName, McpServerStatus.DISABLED, 0)
            } else {
                if (!this.clients.has(serverName) && serverName !== 'Built-in') {
                    await this.initOneServer(serverName, this.mcpServers.get(serverName)!, AuthIntent.Silent)
                }
            }

            this.features.logging.info(`Permissions updated for '${serverName}' in agent config`)
            this.emitToolsChanged(serverName)
        } catch (err) {
            this.handleError(serverName, err)
            return
        }
    }

    /**
     * Check if a tool requires approval.
     */
    public requiresApproval(server: string, tool: string): boolean {
        // For built-in tools, check directly without prefix
        if (server === 'builtIn') {
            return !this.agentConfig.allowedTools.includes(tool)
        }

        // Get unsanitized server name for prefix
        const unsanitizedServerName = this.serverNameMapping.get(server) || server
        const toolId = `@${unsanitizedServerName}/${tool}`
        return !this.agentConfig.allowedTools.includes(toolId)
    }

    /**
     * Get available tools for a specific server
     */
    private getAvailableToolsForServer(serverName: string): string[] {
        return this.mcpTools.filter(tool => tool.serverName === serverName).map(tool => tool.toolName)
    }

    /**
     * Get all available server names
     */
    private getAllAvailableServerNames(): string[] {
        const serverNames = new Set<string>()
        for (const tool of this.mcpTools) {
            serverNames.add(tool.serverName)
        }
        return Array.from(serverNames)
    }

    /**
     * Detect OAuth requirement from POST error response
     * Used when HEAD method returns 405 (Method Not Allowed)
     */
    private async detectOAuthFromPostError(url: URL, headers: Record<string, string>): Promise<boolean> {
        try {
            const testPayload = { jsonrpc: '2.0', method: 'initialize', id: 1 }
            const response = await fetch(url, {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify(testPayload),
            })

            if (response.status === 401) {
                const errorText = await response.text()
                // Check for OAuth-related error messages
                return /bearer|token|auth|missing.*auth/i.test(errorText)
            }
        } catch (e) {
            // Ignore errors, assume no OAuth required
        }
        return false
    }

    /**
     * Get all builtin tool names
     */
    private getAllBuiltinToolNames(): string[] {
        return this.features.agent?.getBuiltInToolNames() || []
    }

    /**
     * get server's tool permission
     */
    public getMcpServerPermissions(serverName: string): MCPServerPermission | undefined {
        return this.mcpServerPermissions.get(serverName)
    }

    /**
     * Returns any errors that occurred during loading of MCP configuration files
     */
    public getConfigLoadErrors(): string | undefined {
        if (this.configLoadErrors.size === 0) {
            return undefined
        }

        return Array.from(this.configLoadErrors.entries())
            .map(([server, error]) => {
                // For registry errors, just return the error message without prefix
                if (server === 'registry') {
                    return error
                }
                // Wrap the file path/server name in a code span. This message is rendered
                // as markdown in the UI, so an unescaped Windows path (e.g. a segment like
                // "\.aws") would have its backslash stripped and be shown incorrectly.
                return `File: \`${server}\`, Error: ${error}`
            })
            .join('\n\n')
    }

    /**
     * Remove a server from the agent config file but keep it in memory.
     * This is used when there's a server status error during initialization.
     */
    public async removeServerFromConfigFile(serverName: string): Promise<void> {
        try {
            const sanitized = sanitizeName(serverName)
            const cfg = this.mcpServers.get(sanitized)
            if (!cfg || !cfg.__configPath__) {
                this.features.logging.warn(
                    `Cannot remove config for server '${serverName}': Config not found or missing path`
                )
                return
            }

            const unsanitizedName = this.serverNameMapping.get(sanitized) || serverName

            // Remove from agent config
            if (unsanitizedName && this.agentConfig) {
                // Remove server from mcpServers
                delete this.agentConfig.mcpServers[unsanitizedName]

                // Remove server tools from tools list
                this.agentConfig.tools = this.agentConfig.tools.filter(tool => {
                    if (tool.startsWith('@')) {
                        if (tool === `@${unsanitizedName}`) {
                            return false
                        }
                        if (tool.startsWith(`@${unsanitizedName}/`)) {
                            return false
                        }
                    }
                    return true
                })

                // Remove server tools from allowedTools
                this.agentConfig.allowedTools = this.agentConfig.allowedTools.filter(tool => {
                    if (tool.startsWith('@')) {
                        if (tool === `@${unsanitizedName}`) {
                            return false
                        }
                        if (tool.startsWith(`@${unsanitizedName}/`)) {
                            return false
                        }
                    }
                    return true
                })

                // Save server removal to agent config
                await saveServerSpecificAgentConfig(
                    this.features.workspace,
                    this.features.logging,
                    unsanitizedName,
                    null, // null indicates server should be removed
                    [],
                    [],
                    cfg.__configPath__
                )
            }
        } catch (err) {
            this.features.logging.error(`Error removing server '${serverName}' from agent config file: ${err}`)
        }
    }

    /**
     * Read, mutate, and write the MCP JSON config at the given path.
     * @private
     */
    private async mutateConfigFile(configPath: string, mutator: (json: any) => void): Promise<void> {
        return McpManager.configMutex
            .runExclusive(async () => {
                let json: any = { mcpServers: {} }
                try {
                    const raw = await this.features.workspace.fs.readFile(configPath)
                    this.features.logging.info(`Updating MCP config file: ${configPath}`)
                    const existing = JSON.parse(raw.toString())
                    json = { mcpServers: {}, ...existing }
                } catch (err: any) {
                    // ignore fire not exist error
                    if (err?.code !== 'ENOENT') throw err
                }
                mutator(json)

                let fsPath: string
                try {
                    const uri = URI.parse(configPath)
                    fsPath = uri.scheme === 'file' ? uri.fsPath : configPath
                } catch {
                    fsPath = configPath
                }
                fsPath = path.normalize(fsPath)

                const dir = path.dirname(fsPath)
                await this.features.workspace.fs.mkdir(dir, { recursive: true })

                await this.features.workspace.fs.writeFile(fsPath, JSON.stringify(json, null, 2))
                this.features.logging.debug(`MCP config file write complete: ${configPath}`)
            })
            .catch((e: any) => {
                this.features.logging.error(`MCP: failed to update config at ${configPath}: ${e.message}`)
                throw e
            })
    }

    public getOriginalToolNames(namespacedName: string): { serverName: string; toolName: string } | undefined {
        return this.toolNameMapping.get(namespacedName)
    }

    public clearToolNameMapping(): void {
        this.toolNameMapping.clear()
    }

    public getToolNameMapping(): Map<string, { serverName: string; toolName: string }> {
        return new Map(this.toolNameMapping)
    }

    /**
     * Determines if a server is global or workspace-specific
     * @param serverName The name of the server to check
     * @returns true if the server is global, false if workspace-specific
     */
    public isServerGlobal(serverName: string): boolean {
        const config = this.mcpServers.get(serverName)
        if (!config) return false

        const globalAgentPath = getGlobalAgentConfigPath(this.features.workspace.fs.getUserHomeDir())
        const globalMcpPath = getGlobalMcpConfigPath(this.features.workspace.fs.getUserHomeDir())
        return config.__configPath__ === globalAgentPath || config.__configPath__ === globalMcpPath
    }

    public setToolNameMapping(mapping: Map<string, { serverName: string; toolName: string }>): void {
        this.toolNameMapping = new Map(mapping)
    }

    /**
     * Updates the runtime state for a given server, including status, tool count, and optional error message.
     * This is used by the UI to reflect real-time server status.
     * @private
     */
    private setState(server: string, status: McpServerStatus, toolsCount: number, lastError?: string) {
        const st: McpServerRuntimeState = { status, toolsCount, lastError }
        this.mcpServerStates.set(server, st)
        this.events.emit(MCP_SERVER_STATUS_CHANGED, server, { ...st })
    }

    /**
     * Emits an event when the tools associated with a server change.
     * Used to refresh the Agent's tool list.
     * @private
     */
    private emitToolsChanged(server: string) {
        const enabled = this.getEnabledTools()
            .filter(t => t.serverName === server)
            .map(t => ({ ...t }))
        this.features.logging.debug(`ToolsChanged | server=${server} | toolCount=${enabled.length}`)
        this.events.emit(AGENT_TOOLS_CHANGED, server, enabled)
    }

    /**
     * Centralized error handling: logs the error, updates the status, and emits an event.
     * Exceptions are no longer thrown to ensure the remaining workflow continues uninterrupted.
     */
    private handleError(server: string | undefined, err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)

        const isBenignSseDisconnect =
            /SSE error:\s*TypeError:\s*terminated:\s*Body Timeout Error/i.test(msg) ||
            /TypeError:\s*terminated:\s*Body Timeout Error/i.test(msg) ||
            /TypeError:\s*terminated:\s*other side closed/i.test(msg) ||
            /ECONNRESET|ENETRESET|EPIPE/i.test(msg)

        if (isBenignSseDisconnect) {
            this.features.logging.debug(`MCP SSE idle timeout${server ? ` [${server}]` : ''}: ${msg}`)
        } else {
            // default path for real errors
            this.features.logging.error(`MCP ERROR${server ? ` [${server}]` : ''}: ${msg}`)
            if (server) {
                this.setState(server, McpServerStatus.FAILED, 0, msg)
                this.emitToolsChanged(server)
            }
        }
    }

    /**
     * Clean up existing server instance (only our tracked processes)
     * @private
     */
    private async cleanupExistingServer(serverName: string): Promise<void> {
        const existingClient = this.clients.get(serverName)
        const existingPid = this.processPids.get(serverName)
        const existingContainer = this.dockerContainers.get(serverName)

        if (!existingClient && !existingPid && !existingContainer) {
            return // Nothing to clean up
        }

        // Close client first
        if (existingClient) {
            try {
                await existingClient.close()
            } catch (e) {
                this.features.logging.warn(`MCP: [${serverName}] error closing client: ${e}`)
            }
            this.clients.delete(serverName)
        }

        // Kill our tracked process
        if (existingPid) {
            try {
                process.kill(existingPid, 'SIGTERM')
            } catch (e: any) {
                if (e.code !== 'ESRCH') {
                    this.features.logging.warn(`MCP: [${serverName}] error killing process: ${e.message}`)
                }
            }
            this.processPids.delete(serverName)
        }

        // Kill our tracked container
        if (existingContainer) {
            try {
                const { execSync } = require('child_process')
                execSync(`docker kill ${existingContainer}`, { stdio: 'ignore' })
            } catch (e) {
                this.features.logging.warn(`MCP: [${serverName}] error killing container: ${e}`)
            }
            this.dockerContainers.delete(serverName)
        }
    }

    /**
     * Ensure the server-specific config is internally consistent.
     * Mutates `cfg` in-place, trimming fields that don't belong to the selected transport.
     * @private
     */
    private validateServerCfg(cfg: MCPServerConfig): void {
        const hasCmd = !!cfg.command?.trim()
        const hasUrl = !!cfg.url?.trim()

        if (hasCmd && hasUrl) throw new Error('Specify either command or url, not both')
        if (!hasCmd && !hasUrl) throw new Error('Either command or url is required')

        if (hasCmd) {
            if (!cfg.command!.trim()) throw new Error('Stdio transport requires "command"')
            delete cfg.url
            delete cfg.headers
        } else {
            if (!cfg.url!.trim()) throw new Error('HTTP transport requires "url"')
            delete cfg.command
            delete cfg.args
            delete cfg.env
        }
    }

    /**
     * Creates the option bag for SSEClientTransport
     * @private
     */
    private buildSseOpts(headers?: Record<string, string>): SSEClientTransportOptions | undefined {
        if (!headers || Object.keys(headers).length === 0) {
            return
        }
        const requestInit: RequestInit = { headers }

        // override only the SSE‐GET:
        const eventSourceInit = {
            fetch: (input: RequestInfo | URL | string, init: RequestInit = {}) => {
                const merged = new Headers(init.headers || {})
                for (const [k, v] of Object.entries(headers)) {
                    merged.set(k, v)
                }
                return fetch(input, {
                    ...init,
                    headers: merged,
                })
            },
        } as any

        return { requestInit, eventSourceInit }
    }

    /**
     * Creates the option bag for StreamableHTTPClientTransport
     * @private
     */
    private buildHttpOpts(headers?: Record<string, string>): StreamableHTTPClientTransportOptions | undefined {
        if (!headers || Object.keys(headers).length === 0) {
            return
        }
        return { requestInit: { headers } }
    }

    /**
     * Get the registry service instance
     */
    public getResources(): string[] {
        return this.agentConfig?.resources ?? []
    }

    public getRegistryService(): McpRegistryService | undefined {
        return this.registryService
    }

    /**
     * Check if registry mode is active
     */
    public isRegistryModeActive(): boolean {
        return this.registryUrlProvided
    }

    /**
     * Set registry mode active state
     */
    public setRegistryActive(active: boolean): void {
        this.registryUrlProvided = active
        if (!active) {
            // Clear registry data and errors when deactivating
            this.currentRegistry = null
            this.configLoadErrors.delete('registry')
        }
    }

    /**
     * Update registry URL and refetch registry
     * @throws Error if registry fetch or validation fails
     */
    public async updateRegistryUrl(registryUrl: string, isPeriodicSync: boolean = false): Promise<void> {
        if (!this.registryService) {
            this.registryService = new McpRegistryService(this.features.logging)
        }

        const wasActive = this.registryUrlProvided

        try {
            const registry = await this.registryService.fetchRegistry(registryUrl)
            if (registry) {
                this.currentRegistry = registry
                // Clear any previous registry errors on success
                this.configLoadErrors.delete('registry')

                if (!wasActive) {
                    this.features.logging.info(
                        `MCP Registry: Registry mode ACTIVATED - ${registry.servers.length} servers`
                    )
                    // Only discover servers when registry is newly activated and not during periodic sync
                    if (!isPeriodicSync) {
                        await this.discoverAllServers()
                        this.features.logging.info(
                            `MCP: discovered ${this.getAllTools().length} tools after registry activation`
                        )
                    }
                } else {
                    this.features.logging.info(`MCP Registry: Updated registry with ${registry.servers.length} servers`)
                }

                // Only sync during periodic updates, not at startup
                if (isPeriodicSync) {
                    this.isPeriodicSync = true
                    await this.syncWithRegistry()
                    this.isPeriodicSync = false
                }
            }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            this.features.logging.error(`MCP Registry: ${errorMsg}`)
            this.currentRegistry = null
            // Store the specific registry error for display in UI
            this.configLoadErrors.set('registry', errorMsg)
            throw error
        }
    }

    /**
     * Synchronize client configurations with registry updates
     * Note: Version checking only works with explicit versions, not "latest"
     */
    private async syncWithRegistry(): Promise<void> {
        if (!this.currentRegistry) {
            this.features.logging.debug('MCP Registry: No active registry for synchronization')
            return
        }

        this.features.logging.info('MCP Registry: Starting periodic registry synchronization')
        const registryServerNames = new Set(this.currentRegistry.servers.map(s => s.name))
        const configuredServers = Array.from(this.mcpServers.entries())
        let serversDisabled = 0
        let versionsUpdated = 0

        for (const [sanitizedName, config] of configuredServers) {
            const unsanitizedName = this.serverNameMapping.get(sanitizedName) || sanitizedName
            const agentConfig = this.agentConfig.mcpServers[unsanitizedName]

            // Skip non-registry servers
            if (!agentConfig || !isRegistryServerConfig(agentConfig)) {
                continue
            }

            // Check if server still exists in registry
            if (!registryServerNames.has(unsanitizedName)) {
                this.features.logging.warn(
                    `MCP Registry: Server '${unsanitizedName}' removed from registry during periodic sync`
                )
                // Close client and mark as failed, but keep in agent config
                const client = this.clients.get(sanitizedName)
                if (client) {
                    await client.close()
                    this.clients.delete(sanitizedName)
                }
                this.mcpTools = this.mcpTools.filter(t => t.serverName !== sanitizedName)
                this.setState(sanitizedName, McpServerStatus.FAILED, 0, 'Server removed from registry')
                this.emitToolsChanged(sanitizedName)
                serversDisabled++
                continue
            }

            // Check version mismatch for local servers during periodic sync
            const registryServer = this.currentRegistry.servers.find(s => s.name === unsanitizedName)
            if (registryServer && registryServer.packages) {
                const updated = await this.checkAndUpdateVersion(sanitizedName, unsanitizedName, registryServer, config)
                if (updated) versionsUpdated++
            }
        }

        this.features.logging.info(
            `MCP Registry: Periodic synchronization complete - ${serversDisabled} servers disabled, ${versionsUpdated} versions updated`
        )
    }

    /**
     * Check version and reinstall if needed
     * Note: Version checking doesn't work with "latest" versions - only explicit versions are supported
     */
    private async checkAndUpdateVersion(
        sanitizedName: string,
        unsanitizedName: string,
        registryServer: any,
        currentConfig: MCPServerConfig
    ): Promise<boolean> {
        if (!isMCPServerConfig(currentConfig)) {
            return false
        }

        // Use cached version for comparison
        const cachedVersion = currentConfig.__cachedVersion__
        const registryVersion = registryServer.version

        if (cachedVersion && cachedVersion !== registryVersion) {
            const msg = `MCP Registry: Server '${unsanitizedName}' version changed from ${cachedVersion} to ${registryVersion} - reinstalling`
            this.features.logging.warn(msg)
            if (this.isPeriodicSync) {
                this.features.logging.warn(`WARNING: ${msg}`)
            }
            try {
                await this.reinstallServer(sanitizedName, unsanitizedName, registryServer)
                return true
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error)
                this.features.logging.error(
                    `MCP Registry: Failed to reinstall server '${unsanitizedName}': ${errorMsg}`
                )
                return false
            }
        }
        return false
    }

    /**
     * Reinstall server with new version
     */
    private async reinstallServer(sanitizedName: string, unsanitizedName: string, registryServer: any): Promise<void> {
        this.features.logging.info(
            `MCP Registry: Reinstalling server '${unsanitizedName}' with version ${registryServer.version}`
        )

        const configPath =
            this.mcpServers.get(sanitizedName)?.__configPath__ ||
            getGlobalAgentConfigPath(this.features.workspace.fs.getUserHomeDir())

        await this.removeServer(sanitizedName)

        const converter = new (await import('./mcpServerConfigConverter')).McpServerConfigConverter()
        const newConfig = converter.convertRegistryServer(registryServer)

        await this.addRegistryServer(unsanitizedName, newConfig, configPath)
    }
}
