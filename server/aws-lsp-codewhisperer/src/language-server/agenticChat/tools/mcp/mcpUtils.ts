/*!
 * Copyright Amazon.com, Inc. or its affiliates.
 * All Rights Reserved. SPDX-License-Identifier: Apache-2.0
 */

import { Agent, InitializeParams, Workspace } from '@aws/language-server-runtimes/server-interface'
import type { Logger } from '@aws/language-server-runtimes/server-interface'
import { URI } from 'vscode-uri'
import {
    MCPServerConfig,
    PersonaConfig,
    MCPServerPermission,
    McpPermissionType,
    AgentConfig,
    McpRegistryData,
    isRegistryServerConfig,
} from './mcpTypes'
import path = require('path')
import { QClientCapabilities } from '../../../configuration/qConfigurationServer'
import crypto = require('crypto')
import { McpServerConfigConverter } from './mcpServerConfigConverter'

/**
 * Load, validate, and parse MCP server configurations from JSON files.
 * - Deduplicates input paths.
 * - Normalizes file and URI inputs.
 * - Skips missing, unreadable, or invalid JSON files.
 * - Handle server name conflicts, prioritize workspace config over global when both define the same server.
 * - Validates required fields and logs warnings for issues.
 * - Captures and returns any errors that occur during loading
 */
export async function loadMcpServerConfigs(
    workspace: Workspace,
    logging: Logger,
    rawPaths: string[]
): Promise<{
    servers: Map<string, MCPServerConfig>
    serverNameMapping: Map<string, string>
    errors: Map<string, string>
}> {
    const servers = new Map<string, MCPServerConfig>()
    const serverNameMapping = new Map<string, string>()
    const configErrors = new Map<string, string>()
    const uniquePaths = Array.from(new Set(rawPaths))
    const globalConfigPath = getGlobalMcpConfigPath(workspace.fs.getUserHomeDir())
    for (const raw of uniquePaths) {
        // 1) normalize file:/ URIs → real fs paths
        let fsPath: string
        try {
            const uri = URI.parse(raw)
            fsPath = uri.scheme === 'file' ? uri.fsPath : raw
        } catch {
            fsPath = raw
        }
        fsPath = require('path').normalize(fsPath)

        // 2) skip missing
        let exists: boolean
        try {
            exists = await workspace.fs.exists(fsPath)
        } catch (e: any) {
            const errorMsg = `Could not stat MCP config at ${fsPath}: ${e.message}`
            logging.warn(errorMsg)
            continue
        }
        if (!exists) {
            const errorMsg = `MCP config not found at ${fsPath}, skipping.`
            logging.warn(errorMsg)
            continue
        }

        // 3) read + parse JSON
        let rawText: string
        try {
            rawText = (await workspace.fs.readFile(fsPath)).toString()
        } catch (e: any) {
            const errorMsg = `Failed to read MCP config at \`${fsPath}\`: ${e.message}`
            logging.warn(errorMsg)
            configErrors.set(`${fsPath}`, errorMsg)
            continue
        }

        let json: any
        try {
            json = JSON.parse(rawText)
        } catch (e: any) {
            const errorMsg = `Invalid JSON in MCP config at \`${fsPath}\`: ${e.message}`
            logging.warn(errorMsg)
            configErrors.set(`${fsPath}`, errorMsg)
            continue
        }

        if (!json.mcpServers || typeof json.mcpServers !== 'object') {
            const errorMsg = `MCP config at \`${fsPath}\` missing or invalid 'mcpServers' field`
            logging.warn(errorMsg)
            configErrors.set(`${fsPath}`, errorMsg)
            continue
        }

        // 4) dedupe and validate
        for (const [name, entryRaw] of Object.entries(json.mcpServers)) {
            const entry = entryRaw as any

            const hasCmd = typeof entry.command === 'string' && entry.command.trim() !== ''
            const hasUrl = typeof entry.url === 'string' && entry.url.trim() !== ''

            if ((hasCmd && hasUrl) || (!hasCmd && !hasUrl)) {
                const errorMsg = `MCP server '${name}' must specify *either* command or url (not both) – skipping`
                logging.warn(errorMsg)
                configErrors.set(`${name}`, errorMsg)
                continue
            }

            if ((entry as any).timeout !== undefined && typeof (entry as any).timeout !== 'number') {
                const errorMsg = `Invalid timeout value on '${name}', ignoring.`
                logging.warn(errorMsg)
                configErrors.set(`${name}_timeout`, errorMsg)
            }
            const cfg: MCPServerConfig = {
                command: (entry as any).command,
                url: (entry as any).url,
                args: Array.isArray((entry as any).args) ? (entry as any).args.map(String) : [],
                env: typeof (entry as any).env === 'object' && (entry as any).env !== null ? (entry as any).env : {},
                headers:
                    typeof (entry as any).headers === 'object' && (entry as any).headers !== null
                        ? (entry as any).headers
                        : undefined,
                initializationTimeout:
                    typeof (entry as any).initializationTimeout === 'number'
                        ? (entry as any).initializationTimeout
                        : undefined,
                timeout: typeof (entry as any).timeout === 'number' ? (entry as any).timeout : undefined,
                disabled: typeof (entry as any).disabled === 'boolean' ? (entry as any).disabled : false,
                __configPath__: fsPath,
            }

            const sanitizedName = sanitizeName(name)
            if (servers.has(sanitizedName)) {
                const existing = servers.get(sanitizedName)!
                const existingIsGlobal = existing.__configPath__ === globalConfigPath
                const currentIsGlobal = fsPath === globalConfigPath
                if (existingIsGlobal && !currentIsGlobal) {
                    logging.warn(
                        `Workspace override for MCP server '${name}' in ${fsPath}; replacing global configuration.`
                    )
                } else {
                    logging.warn(
                        `Ignoring ${existingIsGlobal ? 'global' : 'workspace'} MCP server duplicate for '${name}' in ${fsPath}.`
                    )
                    continue
                }
            }

            servers.set(sanitizedName, cfg)
            serverNameMapping.set(sanitizedName, name)
            logging.info(
                `Loaded MCP server with sanitizedName: '${sanitizedName}' and originalName : '${name}' from ${fsPath}`
            )
        }
    }

    return { servers, serverNameMapping, errors: configErrors }
}

const DEFAULT_AGENT_RAW = `{
  "name": "q_ide_default",
  "description": "Default agent configuration",
  "prompt": "",
  "mcpServers": {},
  "tools": [
    "fs_read",
    "execute_bash",
    "fs_write",
    "report_issue",
    "use_aws"
  ],
  "toolAliases": {},
  "allowedTools": [
    "fs_read",
    "report_issue",
    "use_aws",
    "execute_bash",
    "fs_write"
  ],
  "toolsSettings": {
    "use_aws": { "preset": "readOnly" },
    "execute_bash": { "preset": "readOnly" }
  },
  "resources": [
    "file://AmazonQ.md",
    "file://README.md",
    "file://.amazonq/rules/**/*.md"
  ],
  "hooks": {
    "agentSpawn": [],
    "userPromptSubmit": []
  },
  "useLegacyMcpJson": true
}`

const DEFAULT_PERSONA_RAW = `{
  "mcpServers": [
    "*"
  ],
  "toolPerms": {
    "builtIn": {
      "execute_bash": {
        "alwaysAllow": [
          {
            "preset": "readOnly"
          }
        ]
      },
      "fs_read": "alwaysAllow",
      "fs_write": "ask",
      "report_issue": "alwaysAllow",
      "use_aws": {
        "alwaysAllow": [
          {
            "preset": "readOnly"
          }
        ]
      }
    }
  },
  "context": {
    "files": [
      "AmazonQ.md",
      "README.md",
      ".amazonq/rules/**/*.md"
    ]
  }
}`

/**
 * Load, validate, and parse agent configurations from JSON files.
 * - If both global and workspace files are missing, create a default global.
 * - Load global first (if exists), then workspace files—workspace overrides.
 * - Combines functionality of loadMcpServerConfigs and loadPersonaPermissions
 * - Handles server configurations and permissions from the same agent file
 * - Supports backwards compatibility with MCP config files when useLegacyMcpJson is true
 * - Supports registry-based server configuration when registry is provided
 */
export async function loadAgentConfig(
    workspace: Workspace,
    logging: Logger,
    agentPaths: string[],
    registry: McpRegistryData | null,
    registryActive: boolean
): Promise<{
    servers: Map<string, MCPServerConfig>
    serverNameMapping: Map<string, string>
    errors: Map<string, string>
    agentConfig: AgentConfig
}> {
    // Initialize return values similar to loadMcpServerConfigs
    const servers = new Map<string, MCPServerConfig>()
    const serverNameMapping = new Map<string, string>()
    const configErrors = new Map<string, string>()

    // Create base agent config
    const agentConfig: AgentConfig = {
        name: 'q_ide_default',
        description: 'Agent configuration',
        mcpServers: {},
        tools: [],
        allowedTools: [],
        toolsSettings: {},
        resources: [],
        useLegacyMcpJson: true, // Default to true for backwards compatibility
    }

    // Normalize paths
    const uniquePaths = Array.from(
        new Set(
            agentPaths.map(raw => {
                try {
                    const uri = URI.parse(raw)
                    return uri.scheme === 'file' ? path.normalize(uri.fsPath) : path.normalize(raw)
                } catch {
                    return path.normalize(raw)
                }
            })
        )
    )

    const globalConfigPath = getGlobalAgentConfigPath(workspace.fs.getUserHomeDir())

    // Sort paths to process global config last
    const sortedPaths = uniquePaths.sort((a, b) => {
        if (a === globalConfigPath) return 1
        if (b === globalConfigPath) return -1
        return 0
    })

    // Track useLegacyMcpJson value - workspace takes precedence over global
    let useLegacyMcpJsonValue: boolean | undefined

    // Process each path like loadMcpServerConfigs
    for (const fsPath of sortedPaths) {
        // 1) Skip missing files or create default global
        let exists: boolean
        try {
            exists = await workspace.fs.exists(fsPath)
        } catch (e: any) {
            const errorMsg = `Could not stat agent config at ${fsPath}: ${e.message}`
            logging.warn(errorMsg)
            configErrors.set(fsPath, errorMsg)
            continue
        }

        if (!exists) {
            // Create default global agent file if this is the global path
            if (fsPath === globalConfigPath) {
                try {
                    await workspace.fs.mkdir(path.dirname(fsPath), { recursive: true })
                    await workspace.fs.writeFile(fsPath, DEFAULT_AGENT_RAW)
                    logging.info(`Created default agent file at ${fsPath}`)
                    exists = true
                } catch (e: any) {
                    const errorMsg = `Failed to create default agent file: ${e.message}`
                    logging.error(errorMsg)
                    configErrors.set(fsPath, errorMsg)
                    continue
                }
            } else {
                const errorMsg = `Agent config not found at ${fsPath}, skipping.`
                logging.warn(errorMsg)
                continue
            }
        }

        // 2) Read and parse JSON
        let rawText: string
        try {
            rawText = (await workspace.fs.readFile(fsPath)).toString()
        } catch (e: any) {
            const errorMsg = `Failed to read agent config at ${fsPath}: ${e.message}`
            logging.warn(errorMsg)
            configErrors.set(fsPath, errorMsg)
            continue
        }

        let json: any
        try {
            json = JSON.parse(rawText)
        } catch (e: any) {
            const errorMsg = `Invalid JSON in agent config at ${fsPath}: ${e.message}`
            logging.warn(errorMsg)
            configErrors.set(fsPath, errorMsg)
            continue
        }

        // 3) Process agent config metadata
        if (fsPath === globalConfigPath) {
            agentConfig.name = json.name || agentConfig.name
            agentConfig.description = json.description || agentConfig.description
        }

        // Track useLegacyMcpJson - workspace files take precedence
        if (json.useLegacyMcpJson !== undefined) {
            if (fsPath !== globalConfigPath) {
                // Workspace file - always takes precedence
                useLegacyMcpJsonValue = json.useLegacyMcpJson
            } else if (useLegacyMcpJsonValue === undefined) {
                // Global file - only use if no workspace value set
                useLegacyMcpJsonValue = json.useLegacyMcpJson
            }
        }

        // 4) Process permissions (tools and allowedTools)
        if (Array.isArray(json.tools)) {
            for (const tool of json.tools) {
                if (!tool.startsWith('@') && !agentConfig.tools.includes(tool)) {
                    agentConfig.tools.push(tool)
                }
            }
        }

        if (Array.isArray(json.allowedTools)) {
            for (const tool of json.allowedTools) {
                if (!tool.startsWith('@') && !agentConfig.allowedTools.includes(tool)) {
                    agentConfig.allowedTools.push(tool)
                }
            }
        }

        // 5) Process tool settings
        if (json.toolsSettings && typeof json.toolsSettings === 'object') {
            agentConfig.toolsSettings = {
                ...agentConfig.toolsSettings,
                ...json.toolsSettings,
            }
        }

        // 5b) Process resources
        if (Array.isArray(json.resources)) {
            for (const resource of json.resources) {
                if (typeof resource === 'string' && !agentConfig.resources!.includes(resource)) {
                    agentConfig.resources!.push(resource)
                }
            }
        }

        // 6) Process MCP servers (similar to loadMcpServerConfigs)
        if (json.mcpServers && typeof json.mcpServers === 'object') {
            for (const [name, entryRaw] of Object.entries(json.mcpServers)) {
                const entry = entryRaw as any

                // Check if this is a registry server
                const isRegistryServer = isRegistryServerConfig(entry)

                // Apply registry filtering logic
                if (registryActive) {
                    // When registry is active, only load registry servers
                    if (!isRegistryServer) {
                        logging.info(`MCP: registry active, ignoring manual server '${name}'`)
                        continue
                    }
                } else {
                    // When registry is not active, only load manual servers
                    if (isRegistryServer) {
                        logging.info(`MCP: no registry, ignoring registry server '${name}'`)
                        continue
                    }
                }

                let cfg: MCPServerConfig

                if (isRegistryServer) {
                    // Handle registry server: lookup in registry and convert
                    if (!registry) {
                        const errorMsg = `MCP Registry: Server '${name}' specified but no registry available`
                        logging.error(errorMsg)
                        configErrors.set(`${name}`, errorMsg)
                        continue
                    }

                    const registryServer = findServerInRegistry(registry, name)
                    if (!registryServer) {
                        // Create empty config for missing registry server - will fail during installation naturally
                        cfg = {
                            command: undefined,
                            url: undefined,
                            args: [],
                            env: {},
                            disabled: false,
                            __configPath__: fsPath,
                            __registryError__: `Server '${name}' not found in registry`,
                        } as MCPServerConfig

                        const sanitizedName = sanitizeName(name)
                        servers.set(sanitizedName, cfg)
                        serverNameMapping.set(sanitizedName, name)

                        // Still add to agent config to preserve user settings
                        const agentEntry: any = { type: 'registry' }
                        if (typeof entry.timeout === 'number') agentEntry.timeout = entry.timeout
                        if (entry.headers && Object.keys(entry.headers).length) agentEntry.headers = entry.headers
                        if (entry.env && Object.keys(entry.env).length) agentEntry.env = entry.env
                        agentConfig.mcpServers[name] = agentEntry

                        logging.info(
                            `Created empty config for missing registry server '${name}' - will fail during installation`
                        )
                        continue
                    }

                    // Convert registry server to MCPServerConfig
                    const converter = new McpServerConfigConverter()
                    try {
                        cfg = converter.convertRegistryServer(registryServer, entry.env)
                        cfg.__configPath__ = fsPath

                        // Apply timeout from registry server config if provided
                        if (typeof entry.timeout === 'number') {
                            cfg.timeout = entry.timeout
                        }

                        // Store additional headers/env separately and merge for runtime
                        if (entry.headers && typeof entry.headers === 'object') {
                            cfg.__additionalHeaders__ = entry.headers
                        }

                        if (entry.env && typeof entry.env === 'object') {
                            cfg.__additionalEnv__ = entry.env
                        }

                        logging.info(`MCP Registry: Successfully converted server '${name}' to MCPServerConfig`)
                    } catch (err: any) {
                        const errorMsg = `MCP Registry: Failed to convert server '${name}': ${err.message}`
                        logging.error(errorMsg)
                        configErrors.set(`${name}`, errorMsg)
                        continue
                    }
                } else {
                    // Handle manual server
                    const hasCmd = typeof entry.command === 'string' && entry.command.trim() !== ''
                    const hasUrl = typeof entry.url === 'string' && entry.url.trim() !== ''

                    if ((hasCmd && hasUrl) || (!hasCmd && !hasUrl)) {
                        const errorMsg = `MCP server '${name}' must specify *either* command or url (not both) – skipping`
                        logging.warn(errorMsg)
                        configErrors.set(`${name}`, errorMsg)
                        continue
                    }

                    // Create server config
                    cfg = {
                        command: (entry as any).command,
                        url: (entry as any).url,
                        args: Array.isArray((entry as any).args) ? (entry as any).args.map(String) : [],
                        env:
                            typeof (entry as any).env === 'object' && (entry as any).env !== null
                                ? (entry as any).env
                                : {},
                        headers:
                            typeof (entry as any).headers === 'object' && (entry as any).headers !== null
                                ? (entry as any).headers
                                : undefined,
                        initializationTimeout:
                            typeof (entry as any).initializationTimeout === 'number'
                                ? (entry as any).initializationTimeout
                                : undefined,
                        timeout: typeof (entry as any).timeout === 'number' ? (entry as any).timeout : undefined,
                        disabled: typeof (entry as any).disabled === 'boolean' ? (entry as any).disabled : false,
                        __configPath__: fsPath, // Store config path for determining global vs workspace
                    }
                }

                const sanitizedName = sanitizeName(name)

                // Handle server conflicts (workspace overrides global)
                if (servers.has(sanitizedName)) {
                    const existing = servers.get(sanitizedName)!
                    const existingIsGlobal = existing.__configPath__ === globalConfigPath
                    const currentIsGlobal = fsPath === globalConfigPath

                    if (existingIsGlobal && !currentIsGlobal) {
                        logging.warn(
                            `Workspace override for MCP server '${name}' in ${fsPath}; replacing global configuration.`
                        )
                    } else {
                        logging.warn(
                            `Ignoring ${existingIsGlobal ? 'global' : 'workspace'} MCP server duplicate for '${name}' in ${fsPath}.`
                        )
                        continue
                    }
                }

                // Add server to maps
                servers.set(sanitizedName, cfg)
                serverNameMapping.set(sanitizedName, name)

                // Add to agent config
                const agentEntry: any = {}
                if (cfg.command) agentEntry.command = cfg.command
                if (cfg.url) agentEntry.url = cfg.url
                if (cfg.args && cfg.args.length) agentEntry.args = cfg.args
                if (cfg.env && Object.keys(cfg.env).length) agentEntry.env = cfg.env
                if (cfg.headers && Object.keys(cfg.headers).length) agentEntry.headers = cfg.headers
                if (typeof cfg.initializationTimeout === 'number') {
                    agentEntry.initializationTimeout = cfg.initializationTimeout
                }
                if (typeof cfg.timeout === 'number') agentEntry.timeout = cfg.timeout
                agentEntry.disabled = cfg.disabled
                agentConfig.mcpServers[name] = agentEntry

                // Add MCP server-specific tools and allowedTools after server is successfully added
                if (Array.isArray(json.tools)) {
                    for (const tool of json.tools) {
                        if (
                            (tool === `@${name}` || tool.startsWith(`@${name}/`)) &&
                            !agentConfig.tools.includes(tool)
                        ) {
                            agentConfig.tools.push(tool)
                        }
                    }
                }

                if (Array.isArray(json.allowedTools)) {
                    for (const tool of json.allowedTools) {
                        if (
                            (tool === `@${name}` || tool.startsWith(`@${name}/`)) &&
                            !agentConfig.allowedTools.includes(tool)
                        ) {
                            agentConfig.allowedTools.push(tool)
                        }
                    }
                }

                logging.info(
                    `Loaded MCP server with sanitizedName: '${sanitizedName}' and originalName: '${name}' from ${fsPath}`
                )
            }
        }
    }

    // Set final useLegacyMcpJson value - default to true if not specified anywhere
    agentConfig.useLegacyMcpJson = useLegacyMcpJsonValue !== undefined ? useLegacyMcpJsonValue : true

    // Load MCP config files if useLegacyMcpJson is true and registry mode is not active
    // Legacy MCP configs are always manual servers, so skip them when registry is active
    if (agentConfig.useLegacyMcpJson && !registryActive) {
        const wsUris = workspace.getAllWorkspaceFolders()?.map(f => f.uri) ?? []
        const mcpPaths = [...getWorkspaceMcpConfigPaths(wsUris), getGlobalMcpConfigPath(workspace.fs.getUserHomeDir())]

        const mcpResult = await loadMcpServerConfigs(workspace, logging, mcpPaths)

        // MCP configs have precedence over agent configs
        // Merge MCP servers into the result, overriding any from agent config
        for (const [sanitizedName, mcpConfig] of mcpResult.servers) {
            const originalName = mcpResult.serverNameMapping.get(sanitizedName)
            if (originalName) {
                servers.set(sanitizedName, mcpConfig)
                serverNameMapping.set(sanitizedName, originalName)

                // Add MCP server tools to agent config for permission management
                const serverPrefix = `@${originalName}`
                if (!agentConfig.tools.includes(serverPrefix)) {
                    agentConfig.tools.push(serverPrefix)
                }

                logging.info(`Loaded MCP server '${originalName}' from legacy MCP config`)
            }
        }

        // Merge MCP config errors
        for (const [key, error] of mcpResult.errors) {
            configErrors.set(`mcp_${key}`, error)
        }

        logging.info(`Loaded ${mcpResult.servers.size} servers from legacy MCP configs`)
    }

    // Return the agent config, servers, server name mapping, and errors
    logging.info(
        `Successfully processed ${uniquePaths.length} agent config files and ${agentConfig.useLegacyMcpJson ? 'legacy MCP configs' : 'no legacy MCP configs'}`
    )
    return {
        servers,
        serverNameMapping,
        errors: configErrors,
        agentConfig,
    }
}

export async function loadPersonaPermissions(
    workspace: Workspace,
    logging: Logger,
    personaPaths: string[]
): Promise<Map<string, MCPServerPermission>> {
    const globalPath = getGlobalPersonaConfigPath(workspace.fs.getUserHomeDir())

    // normalize paths
    const normalized = Array.from(
        new Set(
            personaPaths.map(raw => {
                try {
                    const uri = URI.parse(raw)
                    return uri.scheme === 'file' ? path.normalize(uri.fsPath) : path.normalize(raw)
                } catch {
                    return path.normalize(raw)
                }
            })
        )
    )

    const wsFiles = (
        await Promise.all(
            normalized.map(async p => ((await workspace.fs.exists(p).catch(() => false)) ? p : undefined))
        )
    )
        .filter((p): p is string => Boolean(p))
        .filter(p => p !== globalPath)

    const globalExists = await workspace.fs.exists(globalPath).catch(() => false)
    // use workspace files if they exist, otherwise fall back to global
    let selectedFile: string | undefined
    if (wsFiles.length > 0) {
        selectedFile = wsFiles[0]
        logging.info(`Using workspace persona file: ${selectedFile}`)
    } else if (globalExists) {
        selectedFile = globalPath
        logging.info(`Using global persona file: ${selectedFile}`)
    } else {
        await workspace.fs.mkdir(path.dirname(globalPath), { recursive: true })
        await workspace.fs
            .writeFile(globalPath, DEFAULT_PERSONA_RAW)
            .then(() => logging.info(`Created default persona file at ${globalPath}`))
            .catch(e => {
                logging.error(`Failed to create default persona file: ${e.message}`)
            })
        selectedFile = globalPath
        logging.info(`Using newly created default persona file: ${selectedFile}`)
    }

    // read all persona files, including global and workspace
    const result = new Map<string, MCPServerPermission>()

    if (selectedFile) {
        let cfg: PersonaConfig
        try {
            const raw = (await workspace.fs.readFile(selectedFile)).toString().trim()
            cfg = raw ? (JSON.parse(raw) as PersonaConfig) : { mcpServers: [], toolPerms: {} }
        } catch (err: any) {
            logging.warn(`Invalid Persona config in ${selectedFile}: ${err.message}`)
            return result
        }

        // enable servers listed under mcpServers
        const enabled = new Set(cfg['mcpServers'] ?? [])
        for (const name of enabled) {
            result.set(name === '*' ? name : sanitizeName(name), {
                enabled: true,
                toolPerms: {},
                __configPath__: selectedFile,
            })
        }

        // Check if wildcard is present in mcpServers
        const hasWildcard = enabled.has('*')

        // apply toolPerms to servers
        for (const [name, perms] of Object.entries(cfg['toolPerms'] ?? {})) {
            // If there's a wildcard in mcpServers, or if this server is explicitly enabled
            if (hasWildcard || enabled.has(name)) {
                // Create entry for this server if it doesn't exist yet
                const sanitizedServerName = name === '*' ? name : sanitizeName(name)
                if (!result.has(sanitizedServerName)) {
                    result.set(sanitizedServerName, { enabled: true, toolPerms: {}, __configPath__: selectedFile })
                }

                const rec = result.get(sanitizedServerName)!
                rec.toolPerms = perms as Record<string, McpPermissionType>
            }
        }
    }
    const summary = [...result.entries()]
        .map(([srv, perm]) => {
            const tools = Object.keys(perm.toolPerms).length > 0 ? JSON.stringify(perm.toolPerms) : '{}'
            return `${srv} => enabled=${perm.enabled}, toolPerms=${tools}`
        })
        .join('; ')
    logging.info(`Persona permission merge-result: ${summary || '(empty map)'}`)

    return result
}

/** Given an array of workspace diretory, return each workspace persona config location */
export function getWorkspacePersonaConfigPaths(wsUris: string[]): string[] {
    return wsUris.map(uri => {
        const fsPath = normalizePathFromUri(uri)
        return path.join(fsPath, '.amazonq', 'personas', 'default.json')
    })
}

/** Given a user's home directory, return the global persona config location */
export function getGlobalPersonaConfigPath(home: string): string {
    return path.join(home, '.aws', 'amazonq', 'personas', 'default.json')
}

/** Given an array of workspace diretory, return each workspace agent config location */
export function getWorkspaceAgentConfigPaths(wsUris: string[]): string[] {
    return wsUris.map(uri => {
        const fsPath = normalizePathFromUri(uri)
        return path.join(fsPath, '.amazonq', 'agents', 'default.json')
    })
}

/** Given a user's home directory, return the global agent config location */
export function getGlobalAgentConfigPath(home: string): string {
    return path.join(home, '.aws', 'amazonq', 'agents', 'default.json')
}

/** Given an array of workspace diretory, return each workspace mcp config location */
export function getWorkspaceMcpConfigPaths(wsUris: string[]): string[] {
    return wsUris.map(uri => {
        const fsPath = normalizePathFromUri(uri)
        return path.join(fsPath, '.amazonq', 'mcp.json')
    })
}

/** Given a user's home directory, return the global mcp config location */
export function getGlobalMcpConfigPath(homeDir: string): string {
    return path.join(homeDir, '.aws', 'amazonq', 'mcp.json')
}

/** Returns true if env object is undefined, null, contains only empty keys or values */
export function isEmptyEnv(env: Record<string, string>): boolean {
    if (!env || typeof env !== 'object') {
        return true
    }
    for (const [key, value] of Object.entries(env)) {
        if (key.trim() !== '' && value.trim() !== '') {
            return false
        }
    }
    return true
}

export function enabledMCP(params: InitializeParams | undefined): boolean {
    const qCapabilities = params?.initializationOptions?.aws?.awsClientCapabilities?.q as
        | QClientCapabilities
        | undefined
    return qCapabilities?.mcp || false
}

/**
 * Convert from persona format to agent format
 */
export function convertPersonaToAgent(
    persona: PersonaConfig,
    mcpServers: Record<string, MCPServerConfig>,
    featureAgent: Agent
): AgentConfig {
    const agent: AgentConfig = JSON.parse(DEFAULT_AGENT_RAW)

    // Include all servers from MCP config
    Object.entries(mcpServers).forEach(([name, config]) => {
        agent.mcpServers[name] = {
            command: config.command,
            args: config.args,
            env: config.env,
            timeout: config.timeout,
            initializationTimeout: config.initializationTimeout,
        }
    })

    // Add all server names to tools section
    Object.keys(mcpServers).forEach(serverName => {
        const serverPrefix = `@${serverName}`
        if (!agent.tools.includes(serverPrefix)) {
            agent.tools.push(serverPrefix)
        }
    })

    // Check persona for alwaysAllowed tools
    if (persona.toolPerms) {
        // Handle server-specific tools
        for (const [serverName, toolPerms] of Object.entries(persona.toolPerms)) {
            if (serverName === 'builtIn' || serverName === 'Built-in') {
                continue // Already handled above
            }

            // Add specific tools that are alwaysAllow
            for (const [toolName, permission] of Object.entries(toolPerms)) {
                if (permission === McpPermissionType.alwaysAllow) {
                    const toolId = `@${serverName}/${toolName}`
                    if (!agent.allowedTools.includes(toolId)) {
                        agent.allowedTools.push(toolId)
                    }
                }

                // Add tool settings if any
                if (typeof permission === 'object') {
                    const toolId = `@${serverName}/${toolName}`
                    agent.toolsSettings![toolId] = permission
                }
            }
        }
    }

    // Handle built-in tools
    // Add default built-in tools
    for (const toolName of featureAgent.getBuiltInToolNames()) {
        if (!agent.tools.includes(toolName)) {
            agent.tools.push(toolName)
        }
    }

    // Add default allowed tools
    const writeToolNames = new Set(featureAgent.getBuiltInWriteToolNames())
    const defaultAllowedTools = featureAgent.getBuiltInToolNames().filter(toolName => !writeToolNames.has(toolName))
    for (const toolName of defaultAllowedTools) {
        if (!agent.allowedTools.includes(toolName)) {
            agent.allowedTools.push(toolName)
        }
    }

    // Add default tool settings
    if (!agent.toolsSettings) {
        agent.toolsSettings = {}
    }

    agent.toolsSettings['execute_bash'] = {
        alwaysAllow: [
            {
                preset: 'readOnly',
            },
        ],
    }

    agent.toolsSettings['use_aws'] = {
        alwaysAllow: [
            {
                preset: 'readOnly',
            },
        ],
    }

    return agent
}

/**
 * Sanitizes a name by:
 * 1. Returning the original if it matches the regex and doesn't contain namespace delimiter(__)
 * 2. Filtering to only allow ascii alphanumeric, underscore characters, and hyphen.
 * 3. Handling empty or invalid
 * 4. Using hash of original string when needed
 */
export function sanitizeName(orig: string): string {
    const regex: RegExp = /^[a-zA-Z0-9_-]+$/
    // Return original if it matches regex and doesn't contain the namespace delimiter
    if (regex.test(orig) && !orig.includes('___')) {
        return orig
    }

    // Filter to allowed characters
    let sanitized = orig
        .split('')
        .filter(c => /[a-zA-Z0-9_-]/.test(c))
        .join('')
        .replace('___', '')

    if (sanitized.length === 0) {
        // Create hash for empty sanitized string
        const hash = crypto.createHash('md5').update(orig).digest('hex')
        const shortHash = hash.substring(0, 3)
        return shortHash
    }

    return sanitized
}

/**
 * Safely converts a path that might be in URI format to a filesystem path
 * @param path The path that might be in URI format
 * @param logging Optional logger for error reporting
 * @returns The normalized filesystem path
 */
export function normalizePathFromUri(path: string, logging?: Logger): string {
    if (!path) {
        return path
    }

    try {
        if (path.startsWith('file:')) {
            return URI.parse(path).fsPath
        }
        return path
    } catch (e) {
        if (logging) {
            logging.warn(`Failed to parse URI path: ${path}. Error: ${e}`)
        }
        return path // Return original path if parsing fails
    }
}

/**
 * Save agent configuration to the specified path
 */
/**
 * Migrate MCP servers and their permissions from config and persona files to agent config
 */
export async function migrateToAgentConfig(workspace: Workspace, logging: Logger, agent: Agent): Promise<void> {
    // Process global and workspace paths separately
    const globalConfigPath = getGlobalMcpConfigPath(workspace.fs.getUserHomeDir())
    const globalPersonaPath = getGlobalPersonaConfigPath(workspace.fs.getUserHomeDir())
    const globalAgentPath = getGlobalAgentConfigPath(workspace.fs.getUserHomeDir())

    // Get workspace paths
    const wsUris = workspace.getAllWorkspaceFolders()?.map(f => f.uri) ?? []
    const wsConfigPaths = getWorkspaceMcpConfigPaths(wsUris)
    const wsPersonaPaths = getWorkspacePersonaConfigPaths(wsUris)
    const wsAgentPaths = getWorkspaceAgentConfigPaths(wsUris)

    // Migrate global config
    await migrateConfigToAgent(workspace, logging, globalConfigPath, globalPersonaPath, globalAgentPath, agent, true)

    // Migrate workspace configs
    for (let i = 0; i < wsUris.length; i++) {
        if (wsConfigPaths[i] && wsPersonaPaths[i] && wsAgentPaths[i]) {
            // Normalize and check if the workspace config path exists before migrating
            const normalizedWsConfigPath = normalizePathFromUri(wsConfigPaths[i], logging)
            const wsConfigExists = await workspace.fs.exists(normalizedWsConfigPath).catch(() => false)
            if (wsConfigExists) {
                await migrateConfigToAgent(
                    workspace,
                    logging,
                    wsConfigPaths[i],
                    wsPersonaPaths[i],
                    wsAgentPaths[i],
                    agent
                )
            }
        }
    }
}

/**
 * Migrate a specific config and persona to an agent config
 */
async function migrateConfigToAgent(
    workspace: Workspace,
    logging: Logger,
    configPath: string,
    personaPath: string,
    agentPath: string,
    agent: Agent,
    isGlobalDefault: boolean = false
): Promise<void> {
    // Normalize all paths to ensure consistent handling
    const normalizedConfigPath = normalizePathFromUri(configPath, logging)
    const normalizedPersonaPath = normalizePathFromUri(personaPath, logging)
    agentPath = normalizePathFromUri(agentPath)

    // Check if config and agent files exist
    const configExists = await workspace.fs.exists(normalizedConfigPath).catch(() => false)
    const agentExists = await workspace.fs.exists(agentPath).catch(() => false)

    // Only migrate if agent file does not exist
    // If config exists, migrate from it; if not, create default agent config
    if (agentExists) {
        return
    }

    // Read MCP server configs directly from file
    const serverConfigs: Record<string, MCPServerConfig> = {}
    try {
        const raw = (await workspace.fs.readFile(normalizedConfigPath)).toString().trim()
        if (raw) {
            const config = JSON.parse(raw)

            if (config.mcpServers && typeof config.mcpServers === 'object') {
                // Add each server to the serverConfigs
                for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
                    serverConfigs[name] = {
                        command: (serverConfig as any).command,
                        args: Array.isArray((serverConfig as any).args) ? (serverConfig as any).args : undefined,
                        env: typeof (serverConfig as any).env === 'object' ? (serverConfig as any).env : undefined,
                        initializationTimeout:
                            typeof (serverConfig as any).initializationTimeout === 'number'
                                ? (serverConfig as any).initializationTimeout
                                : undefined,
                        timeout:
                            typeof (serverConfig as any).timeout === 'number'
                                ? (serverConfig as any).timeout
                                : undefined,
                    }
                    logging.info(`Added server ${name} to serverConfigs`)
                }
            }
        }
    } catch (err) {
        logging.warn(`Failed to read MCP config file ${normalizedConfigPath}: ${err}`)
    }

    // Read persona config directly from file
    let personaConfig: any = { mcpServers: [], toolPerms: {} }
    try {
        const personaExists = await workspace.fs.exists(normalizedPersonaPath)

        if (personaExists) {
            const raw = (await workspace.fs.readFile(normalizedPersonaPath)).toString().trim()
            if (raw) {
                const config = JSON.parse(raw)
                if (config.mcpServers || config.toolPerms) {
                    personaConfig = config
                }
            }
        }
    } catch (err) {
        logging.warn(`Failed to read persona config at ${normalizedPersonaPath}: ${err}`)
    }

    // Convert to agent config
    const agentConfig = convertPersonaToAgent(personaConfig, serverConfigs, agent)

    // Parse default values from DEFAULT_AGENT_RAW
    const defaultAgent = JSON.parse(DEFAULT_AGENT_RAW)

    // Add complete agent format sections using default values
    agentConfig.name = defaultAgent.name
    agentConfig.description = defaultAgent.description
    agentConfig.includedFiles = defaultAgent.includedFiles
    agentConfig.resources = defaultAgent.resources
    agentConfig.createHooks = defaultAgent.createHooks
    agentConfig.promptHooks = defaultAgent.promptHooks

    // Save agent config
    try {
        await saveAgentConfig(workspace, logging, agentConfig, agentPath)
        logging.info(`Successfully created agent config at ${agentPath}`)
    } catch (err) {
        logging.error(`Failed to save agent config to ${agentPath}: ${err}`)
        throw err
    }
}

export async function saveAgentConfig(
    workspace: Workspace,
    logging: Logger,
    config: AgentConfig,
    configPath: string
): Promise<void> {
    try {
        await workspace.fs.mkdir(path.dirname(configPath), { recursive: true })
        // Save the whole config
        await workspace.fs.writeFile(configPath, JSON.stringify(config, null, 2))
        logging.info(`Saved agent config to ${configPath}`)
    } catch (err: any) {
        logging.error(`Failed to save agent config to ${configPath}: ${err.message}`)
        throw err
    }
}

/**
 * Save only server-specific changes to agent config file
 */
export async function saveServerSpecificAgentConfig(
    workspace: Workspace,
    logging: Logger,
    serverName: string,
    serverConfig: any,
    serverTools: string[],
    serverAllowedTools: string[],
    configPath: string,
    isLegacyMcpServer: boolean = false,
    skipMcpServerConfig: boolean = false
): Promise<void> {
    try {
        await workspace.fs.mkdir(path.dirname(configPath), { recursive: true })

        // Read existing config
        let existingConfig: AgentConfig
        try {
            const raw = await workspace.fs.readFile(configPath)
            existingConfig = JSON.parse(raw.toString())
        } catch {
            // If file doesn't exist, create minimal config
            existingConfig = JSON.parse(DEFAULT_AGENT_RAW)
        }

        // Remove existing server tools from arrays
        const serverPrefix = `@${serverName}`
        existingConfig.tools = existingConfig.tools.filter(
            tool => tool !== serverPrefix && !tool.startsWith(`${serverPrefix}/`)
        )
        existingConfig.allowedTools = existingConfig.allowedTools.filter(
            tool => tool !== serverPrefix && !tool.startsWith(`${serverPrefix}/`)
        )

        if (!isLegacyMcpServer && !skipMcpServerConfig) {
            if (serverConfig === null) {
                // Remove server entirely
                delete existingConfig.mcpServers[serverName]
            } else {
                // Update or add server
                existingConfig.mcpServers[serverName] = serverConfig
            }
        }

        // Add new server tools
        existingConfig.tools.push(...serverTools)
        existingConfig.allowedTools.push(...serverAllowedTools)

        await workspace.fs.writeFile(configPath, JSON.stringify(existingConfig, null, 2))
        logging.info(`Saved server-specific agent config for ${serverName} to ${configPath}`)
    } catch (err: any) {
        logging.error(`Failed to save server-specific agent config to ${configPath}: ${err.message}`)
        throw err
    }
}

/**
 * Migrate existing agent config to CLI format
 */
export async function migrateAgentConfigToCLIFormat(
    workspace: Workspace,
    logging: Logger,
    configPath: string
): Promise<void> {
    try {
        const exists = await workspace.fs.exists(configPath)
        if (!exists) return

        const raw = await workspace.fs.readFile(configPath)
        const config = JSON.parse(raw.toString())

        let updated = false

        // Rename default-agent to q_ide_default
        if (config.name !== 'q_ide_default') {
            config.name = 'q_ide_default'
            updated = true
        }

        // Add missing CLI fields
        if (!config.hasOwnProperty('prompt')) {
            config.prompt = ''
            updated = true
        }
        if (!config.hasOwnProperty('toolAliases')) {
            config.toolAliases = {}
            updated = true
        }

        // Remove deprecated fields
        if (config.hasOwnProperty('version')) {
            delete config.version
            updated = true
        }

        // Migrate includedFiles to resources with file:// prefix
        if (config.includedFiles && Array.isArray(config.includedFiles)) {
            if (!config.resources) config.resources = []
            for (const file of config.includedFiles) {
                const resourcePath = file.startsWith('file://') ? file : `file://${file}`
                if (!config.resources.includes(resourcePath)) {
                    config.resources.push(resourcePath)
                }
            }
            delete config.includedFiles
            updated = true
        }

        // Migrate hooks format
        if (config.promptHooks || config.createHooks) {
            if (!config.hooks) config.hooks = {}
            if (!config.hooks.agentSpawn) config.hooks.agentSpawn = []
            if (!config.hooks.userPromptSubmit) config.hooks.userPromptSubmit = []

            if (config.createHooks && Array.isArray(config.createHooks)) {
                config.hooks.agentSpawn.push(...config.createHooks)
                delete config.createHooks
                updated = true
            }
            if (config.promptHooks && Array.isArray(config.promptHooks)) {
                config.hooks.userPromptSubmit.push(...config.promptHooks)
                delete config.promptHooks
                updated = true
            }
        }

        config.useLegacyMcpJson = true
        updated = true

        if (updated) {
            await workspace.fs.writeFile(configPath, JSON.stringify(config, null, 2))
            logging.info(`Migrated agent config to CLI format: ${configPath}`)
        }
    } catch (err: any) {
        logging.error(`Failed to migrate agent config ${configPath}: ${err.message}`)
    }
}

export const MAX_TOOL_NAME_LENGTH = 64

/**
 * Find a server in the registry by name with O(1) lookup performance.
 * Uses Map-based lookup for large registries (200+ servers).
 */
export function findServerInRegistry(registry: McpRegistryData, serverName: string): any | undefined {
    return registry.servers.find(s => s.name === serverName)
}

/**
 * Create a namespaced tool name from server and tool names.
 * Handles truncation and conflicts according to specific rules.
 * Also stores the mapping from namespaced name back to original names.
 */
export function createNamespacedToolName(
    serverName: string,
    toolName: string,
    allNamespacedTools: Set<string>,
    toolNameMapping: Map<string, { serverName: string; toolName: string }>
): string {
    // First, check if this server/tool combination already has a mapping
    // If it does, reuse that name to maintain consistency across reinitializations
    for (const [existingName, mapping] of toolNameMapping.entries()) {
        if (mapping.serverName === serverName && mapping.toolName === toolName) {
            // If the name is already in the set, it's already registered
            // If not, add it to the set
            if (!allNamespacedTools.has(existingName)) {
                allNamespacedTools.add(existingName)
            }
            return existingName
        }
    }

    // Sanitize the tool name
    const sanitizedToolName = sanitizeName(toolName)

    // First try to use just the tool name if it's not already in use and fits within length limit
    if (sanitizedToolName.length <= MAX_TOOL_NAME_LENGTH && !allNamespacedTools.has(sanitizedToolName)) {
        allNamespacedTools.add(sanitizedToolName)
        toolNameMapping.set(sanitizedToolName, { serverName, toolName })
        return sanitizedToolName
    }

    // If tool name is already in use, then use the namespaced version with server name
    const sep = '___'
    const fullName = `${serverName}${sep}${sanitizedToolName}`

    // If the full name fits and is unique, use it
    if (fullName.length <= MAX_TOOL_NAME_LENGTH && !allNamespacedTools.has(fullName)) {
        allNamespacedTools.add(fullName)
        toolNameMapping.set(fullName, { serverName, toolName })
        return fullName
    }

    // If the full name is too long, truncate the server name
    if (fullName.length > MAX_TOOL_NAME_LENGTH) {
        const maxServerLength = MAX_TOOL_NAME_LENGTH - sep.length - sanitizedToolName.length
        if (maxServerLength > 0) {
            const truncatedServer = serverName.substring(0, maxServerLength)
            const namespacedName = `${truncatedServer}${sep}${sanitizedToolName}`

            if (!allNamespacedTools.has(namespacedName)) {
                allNamespacedTools.add(namespacedName)
                toolNameMapping.set(namespacedName, { serverName, toolName })
                return namespacedName
            }
        }
    }

    // If we get here, either:
    // 1. The tool name was already taken
    // 2. The full name was already taken
    // 3. Server truncation resulted in a duplicate
    // In all cases, fall back to numeric suffix on the tool name

    let duplicateNum = 1
    while (true) {
        const suffix = duplicateNum.toString()
        const maxToolLength = MAX_TOOL_NAME_LENGTH - suffix.length

        let candidateName: string
        if (sanitizedToolName.length <= maxToolLength) {
            candidateName = `${sanitizedToolName}${suffix}`
        } else {
            // Truncate tool name to make room for suffix
            const truncatedTool = sanitizedToolName.substring(0, maxToolLength)
            candidateName = `${truncatedTool}${suffix}`
        }

        if (!allNamespacedTools.has(candidateName)) {
            allNamespacedTools.add(candidateName)
            toolNameMapping.set(candidateName, { serverName, toolName })
            return candidateName
        }

        duplicateNum++
    }
}
