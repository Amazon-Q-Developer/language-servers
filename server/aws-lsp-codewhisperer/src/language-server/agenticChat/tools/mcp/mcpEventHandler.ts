import { Features } from '../../../types'
import { MCP_SERVER_STATUS_CHANGED, McpManager } from './mcpManager'
import { ChatTelemetryController } from '../../../chat/telemetry/chatTelemetryController'
import { ChokidarFileWatcher } from './chokidarFileWatcher'
// eslint-disable-next-line import/no-nodejs-modules
import {
    DetailedListGroup,
    DetailedListItem,
    FilterOption,
    ListMcpServersParams,
    McpServerClickParams,
    Status,
} from '@aws/language-server-runtimes/protocol'

import {
    getGlobalMcpConfigPath,
    getGlobalPersonaConfigPath,
    getWorkspaceMcpConfigPaths,
    getWorkspacePersonaConfigPaths,
    sanitizeName,
    normalizePathFromUri,
    getWorkspaceAgentConfigPaths,
    getGlobalAgentConfigPath,
} from './mcpUtils'
import {
    McpPermissionType,
    MCPServerConfig,
    MCPServerPermission,
    McpServerRuntimeState,
    McpServerStatus,
} from './mcpTypes'
import { TelemetryService } from '../../../../shared/telemetry/telemetryService'
import { ProfileStatusMonitor } from './profileStatusMonitor'
import { McpRegistryService } from './mcpRegistryService'
import { McpServerConfigConverter } from './mcpServerConfigConverter'

interface PermissionOption {
    label: string
    value: string
    description?: string
}

enum TransportType {
    STDIO = 'stdio',
    HTTP = 'http',
}

export class McpEventHandler {
    private static readonly FILE_WATCH_DEBOUNCE_MS = 2000
    #features: Features
    #eventListenerRegistered: boolean
    #currentEditingServerName: string | undefined
    #shouldDisplayListMCPServers: boolean
    #telemetryController: ChatTelemetryController
    #pendingPermissionConfig: { serverName: string; permission: MCPServerPermission } | undefined
    #newlyAddedServers: Set<string> = new Set()
    #fileWatcher: ChokidarFileWatcher
    #isProgrammaticChange: boolean = false
    #debounceTimer: NodeJS.Timeout | null = null
    #lastProgrammaticState: boolean = false
    #serverNameBeforeUpdate: string | undefined
    #converter: McpServerConfigConverter = new McpServerConfigConverter()

    #releaseProgrammaticAfterDebounce(padMs = 500) {
        setTimeout(() => {
            this.#isProgrammaticChange = false
        }, McpEventHandler.FILE_WATCH_DEBOUNCE_MS + padMs)
    }

    constructor(features: Features, telemetryService: TelemetryService) {
        this.#features = features
        this.#eventListenerRegistered = false
        this.#currentEditingServerName = undefined
        this.#shouldDisplayListMCPServers = true
        this.#telemetryController = new ChatTelemetryController(features, telemetryService)
        this.#pendingPermissionConfig = undefined
        this.#fileWatcher = new ChokidarFileWatcher(features.logging)
        this.#setupFileWatchers()
    }

    /**
     * Handles MCP server state changes and notifies the client
     */
    handleServerStateChange(serverName: string, state: McpServerRuntimeState) {
        this.#features.logging.info(`MCP server state changed: ${serverName} - ${state.status}`)

        if (this.#shouldDisplayListMCPServers) {
            // Send chat options update with notification
            try {
                this.#features.logging.info(`Sending chatOptionsUpdate with notification for server: ${serverName}`)
                this.#features.chat.sendChatUpdate({
                    tabId: 'mcpserver',
                    data: {
                        placeholderText: 'mcp-server-update',
                        messages: [],
                    },
                })
                this.#features.logging.info('chatOptionsUpdate event for MCP server status update sent successfully')
            } catch (error) {
                this.#features.logging.error(`Failed to send chatOptionsUpdate: ${error}`)
            }
        }
    }

    /**
     * Handles the list MCP servers event
     */
    async onListMcpServers(params: ListMcpServersParams) {
        this.#currentEditingServerName = undefined
        let mcpManager
        try {
            mcpManager = McpManager.instance
        } catch (error) {
            this.#features.logging.debug(`McpManager not initialized, returning empty list: ${error}`)
            return { header: { title: 'MCP Servers', description: '', actions: [] }, list: [] }
        }

        // Check for errors in loading MCP config files
        const configLoadErrors = mcpManager.getConfigLoadErrors()

        // Only register the event listener once
        if (!this.#eventListenerRegistered) {
            mcpManager.events.on(MCP_SERVER_STATUS_CHANGED, (serverName: string, state: McpServerRuntimeState) => {
                this.#features.logging.info(`Received MCP_SERVER_STATUS_CHANGED event: ${serverName} - ${state.status}`)
                this.handleServerStateChange(serverName, state)
            })
            this.#eventListenerRegistered = true
        }
        const mcpManagerServerConfigs = mcpManager.getAllServerConfigs()

        // Validate server configurations and get any error messages
        let combinedErrors = this.#validateMcpServerConfigs(mcpManagerServerConfigs)

        // Add config load errors if any
        if (configLoadErrors) {
            combinedErrors = combinedErrors ? `${configLoadErrors}\n\n${combinedErrors}` : configLoadErrors
        }

        // Parse validation errors to identify which servers have errors
        const serversWithErrors = new Set<string>()
        if (combinedErrors) {
            this.#features.logging.error(`MCP configuration and validation errors: ${combinedErrors}`)
            const validationErrors = this.#getValidationErrors(mcpManagerServerConfigs)
            validationErrors.forEach(error => {
                if (error.serverName) {
                    serversWithErrors.add(error.serverName)
                }
            })
        }

        // Transform server configs into DetailedListItem objects
        const activeItems: DetailedListItem[] = []
        const consentDeniedItems: DetailedListItem[] = []
        const disabledItems: DetailedListItem[] = []
        const builtInItems: DetailedListItem[] = []

        // Get built-in tools programmatically
        const allTools = this.#features.agent.getTools({ format: 'bedrock' })
        const mcpToolNames = new Set(mcpManager.getAllTools().map(tool => tool.toolName))
        const builtInTools = allTools
            .filter(tool => !mcpToolNames.has(tool.toolSpecification.name))
            .map(tool => ({
                name: tool.toolSpecification.name,
                description: tool.toolSpecification.description || `${tool.toolSpecification.name} tool`,
            }))

        // Add built-in tools as a server in the active items
        // activeItems.push({
        //     title: 'Built-in',
        //     description: `${builtInTools.length} tools`,
        //     children: [
        //         {
        //             groupName: 'serverInformation',
        //             children: [
        //                 {
        //                     title: 'status',
        //                     description: 'ENABLED',
        //                 },
        //                 {
        //                     title: 'toolcount',
        //                     description: `${builtInTools.length}`,
        //                 },
        //             ],
        //         },
        //     ],
        // })

        Array.from(mcpManagerServerConfigs.entries()).forEach(([serverName, config]) => {
            const toolsWithPermissions = mcpManager.getAllToolsWithPermissions(serverName)
            const toolsCount = toolsWithPermissions.length
            let serverState
            try {
                serverState = McpManager.instance.getServerState(serverName)
            } catch (error) {
                this.#features.logging.debug(`McpManager not initialized for getServerState: ${error}`)
                serverState = undefined
            }

            // Check if this server has validation errors
            const hasValidationErrors = serversWithErrors.has(serverName)
            // Keep consent denial distinct from an explicitly disabled server.
            const consentDenied =
                !mcpManager.isServerDisabled(serverName) &&
                serverState?.status === McpServerStatus.DISABLED &&
                serverState.lastError === 'consent not granted'
            const item: DetailedListItem = {
                title: serverName,
                description: `Command: ${config.command}`,
                children: [
                    {
                        groupName: 'serverInformation',
                        children: [
                            {
                                title: 'status',
                                description: hasValidationErrors ? 'FAILED' : serverState?.status || 'DISABLED',
                            },
                            {
                                title: 'toolcount',
                                description: `${toolsCount}`,
                            },
                        ],
                    },
                ],
            }

            if (consentDenied) {
                consentDeniedItems.push({ ...item, description: 'consent not granted' })
            } else if (mcpManager.isServerDisabled(serverName) || serverState?.status === McpServerStatus.DISABLED) {
                disabledItems.push(item)
            } else {
                activeItems.push({
                    ...item,
                    description: `${toolsCount}`,
                })
            }
        })

        // Create the groups
        const groups: DetailedListGroup[] = []

        if (activeItems.length > 0) {
            groups.push({
                groupName: 'Active',
                children: activeItems,
                actions: [
                    {
                        id: 'active-servers',
                        text: `${activeItems.length} servers with tools`,
                    },
                ],
            })
        }

        if (consentDeniedItems.length > 0) {
            groups.push({
                groupName: 'Denied',
                children: consentDeniedItems,
            })
        }

        if (disabledItems.length > 0) {
            groups.push({
                groupName: 'Disabled',
                children: disabledItems,
            })
        }

        // Return the result in the expected format
        const mcpState = ProfileStatusMonitor.getMcpState()
        const isRegistryActive = mcpManager.isRegistryModeActive()
        const hasRegistryErrors = !!(configLoadErrors && configLoadErrors.includes('MCP Registry:'))

        // Treat MCP as disabled if there are registry errors
        const effectiveMcpState = hasRegistryErrors ? false : mcpState

        const header = {
            title: 'MCP Servers',
            description: effectiveMcpState === false ? '' : "Add MCP servers to extend Q's capabilities.",
            status: this.#getListMcpServersStatus(configLoadErrors, mcpState, hasRegistryErrors),
            actions: this.#getListMcpServersActions(configLoadErrors, effectiveMcpState, isRegistryActive),
        }

        // Return empty list when MCP is effectively disabled
        if (effectiveMcpState === false) {
            return { header, list: [] }
        }

        return { header, list: groups }
    }

    /**
     * Gets the status for the list MCP servers header
     */
    #getListMcpServersStatus(
        configLoadErrors: string | undefined,
        mcpState: boolean | undefined,
        hasRegistryErrors: boolean = false
    ): { title: string; icon: string; status: Status } | undefined {
        // Show registry errors first, even if MCP is disabled
        if (hasRegistryErrors && configLoadErrors) {
            return { title: configLoadErrors, icon: 'cancel-circle', status: 'error' as Status }
        }

        if (mcpState === false) {
            // Always show generic MCP disabled message when MCP is administratively disabled
            return {
                title: 'MCP functionality has been disabled by your administrator',
                icon: 'info',
                status: 'info' as Status,
            }
        }

        if (configLoadErrors) {
            return { title: configLoadErrors, icon: 'cancel-circle', status: 'error' as Status }
        }

        return undefined
    }

    /**
     * Gets the actions for the list MCP servers header
     */
    #getListMcpServersActions(
        configLoadErrors: string | undefined,
        effectiveMcpState: boolean | undefined,
        isRegistryActive: boolean = false
    ) {
        // Show buttons only if MCP is effectively enabled AND no registry errors
        const hasRegistryErrors = !!(configLoadErrors && configLoadErrors.includes('MCP Registry:'))

        return effectiveMcpState !== false && !hasRegistryErrors
            ? [
                  {
                      id: 'add-new-mcp',
                      icon: 'plus',
                      status: 'clear',
                      text: 'Add new MCP server',
                      description: 'Add new MCP server',
                  },
                  {
                      id: 'refresh-mcp-list',
                      icon: 'refresh',
                      status: 'clear',
                      text: 'Refresh MCP servers',
                      description: 'Refresh MCP servers',
                  },
              ]
            : []
    }

    /**
     * Handles MCP server click events
     */

    async onMcpServerClick(params: McpServerClickParams) {
        this.#features.logging.log(`onMcpServerClick event with params: ${JSON.stringify(params)}`)

        // Use a map of handlers for different action types
        const handlers: Record<string, () => Promise<any>> = {
            'add-new-mcp': () => {
                this.#currentEditingServerName = undefined
                return this.#handleAddNewMcp(params)
            },
            'save-mcp': () => this.#handleSaveMcp(params),
            'change-transport': () => this.#handleChangeTransport(params),
            'open-mcp-server': () => this.#handleOpenMcpServer(params),
            'edit-mcp': () => this.#handleEditMcpServer(params),
            'mcp-permission-change': () => this.#handleMcpPermissionChange(params),
            'save-permission-change': () => this.#handleSavePermissionChange(params),
            'refresh-mcp-list': () => this.#handleRefreshMCPList(params),
            'mcp-enable-server': () => this.#handleEnableMcpServer(params),
            'mcp-disable-server': () => this.#handleDisableMcpServer(params),
            'mcp-delete-server': () => this.#handleDeleteMcpServer(params),
            'mcp-fix-server': () => this.#handleEditMcpServer(params),
            'install-registry-server': () => this.#handleInstallRegistryServer(params),
        }

        // Execute the appropriate handler or return default response
        const handler = handlers[params.id]
        if (handler) {
            return await handler()
        }

        return this.#getDefaultMcpResponse(params.id)
    }

    /**
     * Returns the default MCP servers response
     */
    #getDefaultMcpResponse(id: string) {
        return {
            id,
            header: {
                title: 'MCP Servers',
                status: {},
                description: `Add MCP servers to extend Q's capabilities.`,
                actions: [],
            },
            list: [],
        }
    }

    async #handleAddNewMcp(params: McpServerClickParams, error?: string): Promise<any> {
        // Check if registry is active (but skip if editing existing server)
        const isRegistryModeActive = McpManager.instance.getRegistryService()?.isRegistryActive()
        const isEditingExistingServer = !!(
            params.optionsValues?.name &&
            McpManager.instance.getAllServerConfigs().has(sanitizeName(params.optionsValues.name))
        )

        if (isRegistryModeActive && !error && !isEditingExistingServer) {
            const result = await this.#handleShowRegistryServers(params)
            return { ...result, isMcpRegistry: true }
        }

        const existingValues = params.optionsValues || {}

        // Arguments (stdio)
        let argsValue = [{ persistent: true, value: { arg_key: '' } }]
        if (existingValues.args && Array.isArray(existingValues.args)) {
            argsValue = existingValues.args.map((arg, index) => ({
                persistent: index === 0,
                value: { arg_key: arg.arg_key || '' },
            }))
        }

        // Environment variables (stdio)
        let envVarsValue = [
            {
                persistent: true,
                value: { env_var_name: '', env_var_value: '' },
            },
        ]
        if (existingValues.env_variables && Array.isArray(existingValues.env_variables)) {
            envVarsValue = existingValues.env_variables.map((env, index) => ({
                persistent: index === 0,
                value: {
                    env_var_name: env.env_var_name || '',
                    env_var_value: env.env_var_value || '',
                },
            }))
        }

        // Headers (http)
        let headersValue: any[] = []
        if (existingValues.headers && Array.isArray(existingValues.headers)) {
            headersValue = existingValues.headers.map(hdr => ({
                persistent: false, // allow every row to be deleted
                value: {
                    key: hdr.key || '',
                    value: hdr.value || '',
                },
            }))
        }

        if (existingValues.name) {
            const serverName = existingValues.name
            const sanitizedServerName = sanitizeName(serverName)
            let serverConfig
            try {
                serverConfig = McpManager.instance.getAllServerConfigs().get(sanitizedServerName)
            } catch (error) {
                this.#features.logging.debug(`McpManager not initialized for getAllServerConfigs: ${error}`)
                serverConfig = undefined
            }

            if (serverConfig) {
                // Use the helper method to determine if the server is global
                try {
                    existingValues.scope = McpManager.instance.isServerGlobal(sanitizedServerName)
                        ? 'global'
                        : 'workspace'
                } catch (error) {
                    this.#features.logging.debug(`McpManager not initialized for isServerGlobal: ${error}`)
                    existingValues.scope = 'global'
                }
            } else {
                // Default to global scope for new servers
                existingValues.scope = 'global'
            }
        }

        const serverStatusError = this.#getServerStatusError(existingValues.name) || {}

        // Determine which transport is selected (default to stdio)
        const selectedTransport = existingValues.transport || TransportType.STDIO

        return {
            id: params.id,
            header: {
                title: 'Add MCP Server',
                status: error ? { title: error, icon: 'cancel-circle', status: 'error' as Status } : serverStatusError,
                actions: [],
            },
            list: [],
            filterActions: [
                { id: 'cancel-mcp', text: 'Cancel' },
                { id: 'save-mcp', text: 'Save', status: error ? ('error' as Status) : 'primary' },
            ],
            filterOptions: (() => {
                const common = [
                    {
                        type: 'radiogroup',
                        id: 'scope',
                        title: 'Scope',
                        options: [
                            { label: 'Global - Used globally.', value: 'global' },
                            { label: 'This workspace - Only used in this workspace.', value: 'workspace' },
                        ],
                        value: existingValues.scope || 'global',
                    },
                    {
                        type: 'textinput',
                        id: 'name',
                        title: 'Name',
                        value: existingValues.name || '',
                        mandatory: true,
                    },
                    {
                        type: 'select',
                        id: 'transport',
                        title: 'Transport',
                        mandatory: true,
                        options: [
                            { label: TransportType.STDIO, value: TransportType.STDIO },
                            { label: TransportType.HTTP, value: TransportType.HTTP },
                        ],
                        value: selectedTransport,
                    },
                ]

                if (selectedTransport === TransportType.HTTP) {
                    return [
                        ...common,
                        {
                            type: 'textinput',
                            id: 'url',
                            title: 'URL',
                            value: existingValues.url || '',
                            mandatory: true,
                        },
                        {
                            type: 'list',
                            id: 'headers',
                            title: 'Headers - optional',
                            items: [
                                { id: 'key', title: 'Key', type: 'textinput' },
                                { id: 'value', title: 'Value', type: 'textinput' },
                            ],
                            ...(headersValue.length > 0 ? { value: headersValue } : {}),
                        },
                        {
                            type: 'numericinput',
                            id: 'timeout',
                            title: 'Timeout - use 0 to disable',
                            value: existingValues.timeout || 60,
                        },
                    ]
                } else {
                    // stdio transport
                    return [
                        ...common,
                        {
                            type: 'textinput',
                            id: 'command',
                            title: 'Command',
                            value: existingValues.command || '',
                            mandatory: true,
                        },
                        {
                            type: 'list',
                            id: 'args',
                            title: 'Arguments - optional',
                            items: [{ id: 'arg_key', type: 'textinput' }],
                            value: argsValue,
                        },
                        {
                            type: 'list',
                            id: 'env_variables',
                            title: 'Environment variables - optional',
                            items: [
                                { id: 'env_var_name', title: 'Name', type: 'textinput' },
                                { id: 'env_var_value', title: 'Value', type: 'textinput' },
                            ],
                            value: envVarsValue,
                        },
                        {
                            type: 'numericinput',
                            id: 'timeout',
                            title: 'Timeout - use 0 to disable',
                            value: existingValues.timeout || 60,
                        },
                    ]
                }
            })(),
        }
    }

    /**
     * Validates all MCP server configurations and returns combined error messages
     * @param serverConfigs Map of server configurations to validate
     * @returns Combined error messages or undefined if no errors
     */
    /**
     * Gets validation errors for all server configurations
     * @param serverConfigs Map of server configurations to validate
     * @returns Array of validation errors with server names
     */
    #getValidationErrors(serverConfigs: Map<string, MCPServerConfig>): { serverName: string; errors: string[] }[] {
        const validationErrors: { serverName: string; errors: string[] }[] = []

        for (const [serverName, config] of serverConfigs.entries()) {
            // Create a values object that matches the expected format for validateMcpServerForm
            const values = {
                name: serverName,
                command: config.command,
                timeout: config.timeout?.toString() || '',
                env: config.env,
                args: config.args,
                url: config.url,
                headers: config.headers,
            }

            const validation = this.#validateMcpServerForm(values, false)
            if (!validation.isValid) {
                this.#features.logging.debug(
                    `MCP server validation error for ${serverName}: ${validation.errors.join(', ')}`
                )
                validationErrors.push({ serverName, errors: validation.errors })
            }
        }

        return validationErrors
    }

    /**
     * Validates all MCP server configurations and returns combined error messages
     * @param serverConfigs Map of server configurations to validate
     * @returns Combined error messages or undefined if no errors
     */
    #validateMcpServerConfigs(serverConfigs: Map<string, MCPServerConfig>): string | undefined {
        // Get validation errors for all server configurations
        const validationErrors = this.#getValidationErrors(serverConfigs)

        // Return validation errors if any were found
        if (validationErrors.length > 0) {
            // Combine all error messages
            return validationErrors
                .map(error => {
                    return error.serverName
                        ? `Server name: ${error.serverName} Error: ${error.errors.join('')}`
                        : `Error: ${error.errors.join('')}`
                })
                .join('\n\n')
        }

        return undefined
    }

    /**
     * Validates the MCP server form values
     */
    #validateMcpServerForm(
        values: Record<string, any>,
        checkExistingServerName: boolean,
        originalServerName?: string
    ): { isValid: boolean; errors: string[] } {
        const errors: string[] = []

        if (!values.name || values.name.trim() === '') {
            errors.push('Server name cannot be empty')
        } else {
            if (checkExistingServerName) {
                let existingServers, serverState
                try {
                    existingServers = McpManager.instance.getAllServerConfigs()
                    serverState = McpManager.instance.getServerState(values.name)
                } catch (error) {
                    this.#features.logging.debug(`McpManager not initialized for validation: ${error}`)
                    existingServers = new Map()
                    serverState = undefined
                }

                if (
                    existingServers.has(values.name) &&
                    values.name !== originalServerName &&
                    serverState?.status === McpServerStatus.ENABLED
                ) {
                    errors.push(`Server name "${values.name}" already exists`)
                }
            }
        }

        const transport = values.transport
        const command = values.command?.trim() || ''
        const url = values.url?.trim() || ''

        // Basic validation for command/url presence and exclusivity
        if (!command && !url) {
            errors.push('Either command or url is required')
        } else if (command && url) {
            errors.push('Provide either command OR url, not both')
        } else if (
            transport &&
            ((transport === TransportType.STDIO && !command) || (transport !== TransportType.STDIO && !url))
        ) {
            errors.push(
                `${transport === TransportType.STDIO ? 'Command' : 'URL'} is required for ${transport} transport`
            )
        }

        if (values.timeout && values.timeout.trim() !== '') {
            const timeoutNum = Number(values.timeout.trim())
            if (timeoutNum < 0) {
                errors.push('Timeout must be zero or a positive number')
            }
        }

        // Environment variables must have both name and value, or neither
        if (Array.isArray(values.env_variables)) {
            const envVars = values.env_variables as Array<{ env_var_name: string; env_var_value: string }>
            const hasEmptyNameWithValue = envVars.some(
                env =>
                    (!env.env_var_name || env.env_var_name.trim() === '') &&
                    env.env_var_value &&
                    env.env_var_value.trim() !== ''
            )
            const hasNameWithEmptyValue = envVars.some(
                env =>
                    env.env_var_name &&
                    env.env_var_name.trim() !== '' &&
                    (!env.env_var_value || env.env_var_value.trim() === '')
            )
            if (hasEmptyNameWithValue) {
                errors.push('Environment variable name cannot be empty when value is provided')
            }
            if (hasNameWithEmptyValue) {
                errors.push('Environment variable value cannot be empty when name is provided')
            }
        }

        if (Array.isArray(values.headers)) {
            const hdrs = values.headers as Array<{ key: string; value: string }>
            const invalidHeaders = hdrs.find(h => {
                const key = h.key?.trim() || ''
                const value = h.value?.trim() || ''
                return (key === '' && value !== '') || (key !== '' && value === '')
            })

            if (invalidHeaders) {
                const hasKey = invalidHeaders.key?.trim()
                errors.push(
                    hasKey
                        ? 'Header value cannot be empty when key is provided'
                        : 'Header key cannot be empty when value is provided'
                )
            }
        }

        return {
            isValid: errors.length === 0,
            errors,
        }
    }

    /**
     * Handles saving a new MCP server configuration
     */
    async #handleSaveMcp(params: McpServerClickParams) {
        if (!params.optionsValues) {
            return this.#getDefaultMcpResponse(params.id)
        }

        const isRegistryModeActive = McpManager.instance.getRegistryService()?.isRegistryActive()
        const serverName = params.optionsValues.name
        const sanitizedServerName = sanitizeName(serverName)
        const originalServerName = this.#currentEditingServerName
        let isEditMode = false
        try {
            isEditMode = !!(originalServerName && McpManager.instance.getAllServerConfigs().has(originalServerName))
        } catch (error) {
            this.#features.logging.debug(`McpManager not initialized for isEditMode check: ${error}`)
        }

        // Handle registry server updates (headers/env only)
        if (isRegistryModeActive) {
            return this.#handleSaveRegistryMcp(params)
        }

        const selectedTransport = params.optionsValues.transport

        // Validate form values
        const validation = this.#validateMcpServerForm(
            params.optionsValues,
            true,
            isEditMode ? originalServerName : undefined
        )
        if (!validation.isValid) {
            const error = validation.errors[0]
            params.id = isEditMode ? 'edit-mcp' : 'add-new-mcp'
            return isEditMode
                ? this.#handleEditMcpServer({ ...params, title: originalServerName! }, error)
                : this.#handleAddNewMcp(params, error)
        }

        // stdio‑specific parsing
        let args: string[] = []
        let env: Record<string, string> = {}
        if (selectedTransport === TransportType.STDIO) {
            try {
                args = (Array.isArray(params.optionsValues.args) ? params.optionsValues.args : [])
                    .map((item: any) =>
                        item && typeof item === 'object' && 'arg_key' in item ? String(item.arg_key) : ''
                    )
                    .filter(Boolean)
            } catch (e) {
                this.#features.logging.warn(`MCP: Failed to process args: ${e}`)
            }

            try {
                env = (
                    Array.isArray(params.optionsValues.env_variables) ? params.optionsValues.env_variables : []
                ).reduce((acc: Record<string, string>, item: any) => {
                    if (item && 'env_var_name' in item && 'env_var_value' in item) {
                        acc[String(item.env_var_name)] = String(item.env_var_value)
                    }
                    return acc
                }, {})
            } catch (e) {
                this.#features.logging.warn(`MCP: Failed to process env variables: ${e}`)
            }
        }

        // http‑specific parsing
        let headers: Record<string, string> = {}
        if (selectedTransport === TransportType.HTTP) {
            try {
                const raw = Array.isArray(params.optionsValues.headers) ? params.optionsValues.headers : []
                headers = raw.reduce((acc: Record<string, string>, item: any) => {
                    const k = item.key?.toString().trim() ?? ''
                    const v = item.value?.toString().trim() ?? ''
                    // both empty → skip
                    if (k === '' && v === '') {
                        return acc
                    }
                    // otherwise keep (validation layer handles partial-empty cases)
                    acc[k] = item.value ?? ''
                    return acc
                }, {})
            } catch (e) {
                this.#features.logging.warn(`MCP: Failed to process headers: ${e}`)
            }
        }

        // Config file requires timeout in milliseconds
        const timeoutInMs = (parseInt(params.optionsValues.timeout) ?? 60) * 1000

        // build final config (no transport field persisted)
        let config: MCPServerConfig
        if (selectedTransport === TransportType.HTTP) {
            config = {
                url: params.optionsValues.url,
                headers,
                timeout: timeoutInMs,
            }
        } else {
            config = {
                command: params.optionsValues.command,
                args,
                env,
                timeout: timeoutInMs,
            }
        }

        // Get agent path based on scope
        const isGlobal = params.optionsValues['scope'] === 'global'
        const agentPath = await this.#getAgentPath(isGlobal)

        // We still need a configPath for backward compatibility, but it's not used anymore
        const configPath = ''

        // needs to false BEFORE changing any server state, to prevent going to list servers page after clicking save button
        this.#shouldDisplayListMCPServers = false

        // Set flag to ignore file changes during server operations
        this.#isProgrammaticChange = true

        try {
            if (isEditMode && originalServerName) {
                const serverToRemove = this.#serverNameBeforeUpdate || originalServerName
                let serverConfig
                try {
                    serverConfig = McpManager.instance.getAllServerConfigs().get(serverToRemove)
                } catch (error) {
                    this.#features.logging.error(`McpManager not initialized for server removal: ${error}`)
                    throw error
                }
                const isLegacyMcpServer = serverConfig?.__configPath__?.endsWith('mcp.json') ?? false
                const configPath = isLegacyMcpServer ? await this.#getMcpConfigPath(isGlobal) : agentPath
                try {
                    await McpManager.instance.removeServer(serverToRemove)
                    await McpManager.instance.addServer(serverName, config, configPath, isLegacyMcpServer)
                } catch (error) {
                    this.#features.logging.error(`McpManager operation failed: ${error}`)
                    throw error
                }
            } else {
                // Create new server
                try {
                    await McpManager.instance.addServer(serverName, config, agentPath)
                } catch (error) {
                    this.#features.logging.error(`McpManager not initialized for addServer: ${error}`)
                    throw error
                }
                this.#newlyAddedServers.add(serverName)
            }
        } catch (error) {
            this.#features.logging.error(`Failed to enable MCP server: ${error}`)
        }

        this.#currentEditingServerName = undefined
        this.#serverNameBeforeUpdate = undefined

        // need to check server state now, as there is possibility of error during server initialization
        const serverStatusError = this.#getServerStatusError(serverName)

        let numTools = 0
        try {
            numTools = McpManager.instance.getAllToolsWithPermissions(sanitizedServerName).length
        } catch (error) {
            this.#features.logging.debug(`McpManager not initialized for getAllToolsWithPermissions: ${error}`)
        }
        this.#telemetryController?.emitMCPServerInitializeEvent({
            source: isEditMode ? 'updateServer' : 'addServer',
            command: selectedTransport === TransportType.STDIO ? params.optionsValues.command : undefined,
            url: selectedTransport === TransportType.HTTP ? params.optionsValues.url : undefined,
            enabled: true,
            numTools,
            scope: params.optionsValues['scope'] === 'global' ? 'global' : 'workspace',
            transportType: selectedTransport,
            languageServerVersion: this.#features.runtime.serverInfo.version,
        })

        if (serverStatusError) {
            try {
                await McpManager.instance.removeServerFromConfigFile(serverName)
            } catch (error) {
                this.#features.logging.error(`McpManager not initialized for removeServerFromConfigFile: ${error}`)
            }

            if (this.#newlyAddedServers.has(serverName)) {
                this.#newlyAddedServers.delete(serverName)
            }

            // Stay on add/edit page and show error to user
            // Keep isProgrammaticChange true during error handling to prevent file watcher triggers
            this.#releaseProgrammaticAfterDebounce()
            if (isEditMode) {
                params.id = 'edit-mcp'
                params.title = sanitizedServerName
                return this.#handleEditMcpServer(params)
            } else {
                params.id = 'add-new-mcp'
                return this.#handleAddNewMcp(params)
            }
        } else {
            // Success case: if this was a newly added server, remove it from tracking
            if (this.#newlyAddedServers.has(serverName)) {
                this.#newlyAddedServers.delete(serverName)
            }

            this.#releaseProgrammaticAfterDebounce()

            // Go to tools permissions page
            return this.#handleOpenMcpServer({ id: 'open-mcp-server', title: sanitizedServerName })
        }
    }

    /**
     * Handles opening an MCP server details view
     */
    async #handleOpenMcpServer(params: McpServerClickParams) {
        const serverName = params.title
        if (!serverName) {
            return { id: params.id }
        }
        const serverStatusError = this.#getServerStatusError(serverName)

        let filterOptions: FilterOption[] = []
        if (serverName === 'Built-in') {
            // Handle Built-in server specially
            const allTools = this.#features.agent.getTools({ format: 'bedrock' })
            let mcpToolNames = new Set<string>()
            try {
                mcpToolNames = new Set(McpManager.instance.getAllTools().map(tool => tool.toolName))
            } catch (error) {
                this.#features.logging.debug(`McpManager not initialized for getAllTools: ${error}`)
            }
            const builtInTools = allTools
                .filter(tool => !mcpToolNames.has(tool.toolSpecification.name))
                .map(tool => {
                    // Set default permission based on tool name
                    const permission = 'alwaysAllow'

                    return {
                        tool: {
                            toolName: tool.toolSpecification.name,
                            description: tool.toolSpecification.description || `${tool.toolSpecification.name} tool`,
                        },
                        permission,
                    }
                })

            filterOptions = this.#buildServerFilterOptions(serverName, builtInTools)

            return {
                id: params.id,
                header: {
                    title: serverName,
                    status: serverStatusError || {},
                    actions: [],
                },
                list: [],
                filterActions: [],
                filterOptions,
            }
        } else {
            // Handle regular MCP servers
            let toolsWithPermissions: { tool: any; permission: any }[] = []
            try {
                toolsWithPermissions = McpManager.instance.getAllToolsWithPermissions(serverName)
            } catch (error) {
                this.#features.logging.debug(`McpManager not initialized for getAllToolsWithPermissions: ${error}`)
            }
            filterOptions = this.#buildServerFilterOptions(serverName, toolsWithPermissions)

            const isMcpRegistry = McpManager.instance.getRegistryService()?.isRegistryActive() ?? false
            return {
                id: params.id,
                isMcpRegistry,
                header: {
                    title: serverName,
                    status: serverStatusError || {},
                    actions: [
                        {
                            id: 'edit-mcp',
                            icon: 'pencil',
                            text: 'Edit setup',
                        },
                        {
                            id: 'mcp-details-menu',
                            icon: 'ellipsis-h',
                            text: '',
                        },
                    ],
                },
                list: [],
                filterActions: [],
                filterOptions,
            }
        }
    }

    /**
     * Handles enabling an MCP server
     */
    async #handleEnableMcpServer(params: McpServerClickParams) {
        const serverName = params.title
        if (!serverName) {
            return { id: params.id }
        }

        let mcpManager, agentPath
        try {
            mcpManager = McpManager.instance
            // Get the appropriate agent path
            agentPath = mcpManager.getAllServerConfigs().get(serverName)?.__configPath__
        } catch (error) {
            this.#features.logging.error(`McpManager not initialized for enable server: ${error}`)
            return { id: params.id }
        }
        // Set flag to ignore file changes during permission update
        this.#isProgrammaticChange = true

        try {
            const perm = mcpManager.getMcpServerPermissions(serverName)!
            perm.enabled = true
            perm.__configPath__ = agentPath
            await mcpManager.updateServerPermission(serverName, perm)
            this.#emitMCPConfigEvent()
            this.#releaseProgrammaticAfterDebounce()
        } catch (error) {
            this.#features.logging.error(`Failed to enable MCP server: ${error}`)
            this.#releaseProgrammaticAfterDebounce()
        }
        return { id: params.id }
    }

    /**
     * Handles disabling an MCP server
     */
    async #handleDisableMcpServer(params: McpServerClickParams) {
        const serverName = params.title
        if (!serverName) {
            return { id: params.id }
        }
        let mcpManager, agentPath
        try {
            mcpManager = McpManager.instance
            // Set flag to ignore file changes during permission update
            agentPath = mcpManager.getAllServerConfigs().get(serverName)?.__configPath__
        } catch (error) {
            this.#features.logging.error(`McpManager not initialized for disable server:${error}`)
            return { id: params.id }
        }
        // Set flag to ignore file changes during permission update
        this.#isProgrammaticChange = true
        try {
            const perm = mcpManager.getMcpServerPermissions(serverName)!
            perm.enabled = false
            perm.__configPath__ = agentPath
            await mcpManager.updateServerPermission(serverName, perm)
            this.#emitMCPConfigEvent()
            this.#releaseProgrammaticAfterDebounce()
        } catch (error) {
            this.#features.logging.error(`Failed to disable MCP server: ${error}`)
            this.#releaseProgrammaticAfterDebounce()
        }

        return { id: params.id }
    }

    /**
     * Handles deleting an MCP server
     */
    async #handleDeleteMcpServer(params: McpServerClickParams) {
        const serverName = params.title
        if (!serverName) {
            return { id: params.id }
        }

        // Set flag to ignore file changes during server deletion
        this.#isProgrammaticChange = true

        try {
            try {
                await McpManager.instance.removeServer(serverName)
            } catch (error) {
                this.#features.logging.error(`McpManager not initialized for removeServer: ${error}`)
                throw error
            }
            this.#releaseProgrammaticAfterDebounce()
            return { id: params.id }
        } catch (error) {
            this.#features.logging.error(`Failed to delete MCP server: ${error}`)
            this.#releaseProgrammaticAfterDebounce()
            return { id: params.id }
        }
    }

    /**
     * Handles edit MCP configuration
     */
    async #handleEditMcpServer(params: McpServerClickParams, error?: string) {
        const serverName = params.title
        if (!serverName) return { id: params.id }

        const isRegistryModeActive = McpManager.instance.getRegistryService()?.isRegistryActive()
        if (isRegistryModeActive) {
            return this.#handleEditRegistryMcpServer(params, error)
        }

        // Set programmatic change flag to true to prevent file watcher triggers
        this.#isProgrammaticChange = true
        await this.#handleSavePermissionChange({ id: 'save-mcp-permission' })

        if (!serverName) {
            this.#isProgrammaticChange = false
            return { id: params.id }
        }
        this.#currentEditingServerName = serverName

        let config
        try {
            config = McpManager.instance.getAllServerConfigs().get(serverName)
        } catch (error) {
            this.#features.logging.error(`McpManager not initialized for getAllServerConfigs: ${error}`)
            return {
                id: params.id,
                header: {
                    title: 'Edit MCP Server',
                    status: {
                        title: 'MCP Manager not initialized',
                        icon: 'cancel-circle',
                        status: 'error' as Status,
                    },
                },
                list: [],
            }
        }
        if (!config) {
            return {
                id: params.id,
                header: {
                    title: 'Edit MCP Server',
                    status: {
                        title: `Server "${serverName}" not found`,
                        icon: 'cancel-circle',
                        status: 'error' as Status,
                    },
                },
                list: [],
            }
        }

        // Respect a user flip first; otherwise fall back to what the stored configuration implies.
        const transport = params.optionsValues?.transport ?? (config.url ? TransportType.HTTP : TransportType.STDIO)

        // Convert stored structures to UI‑friendly lists
        const argsList = (config.args ?? []).map(a => ({ arg_key: a })) // for stdio
        const envList = Object.entries(config.env ?? {}).map(([k, v]) => ({
            env_var_name: k,
            env_var_value: v,
        })) // for stdio
        const headersList = Object.entries(config.headers ?? {}).map(([k, v]) => ({
            key: k,
            value: v,
        })) // for http

        // UI must display timeout to user in seconds
        const timeoutInSeconds =
            params.optionsValues?.timeout || Math.floor((config.timeout ?? 60000) / 1000).toString()

        const existingValues: Record<string, any> = {
            name: params.optionsValues?.name || serverName,
            transport,
            command: params.optionsValues?.command || config.command,
            args: params.optionsValues?.args || argsList,
            env_variables: params.optionsValues?.env_variables || envList,
            url: params.optionsValues?.url || config.url,
            headers: params.optionsValues?.headers || headersList,
            timeout: timeoutInSeconds,
            scope: params.optionsValues?.scope,
        }

        const view = await this.#handleAddNewMcp(
            {
                ...params,
                id: 'add-new-mcp',
                optionsValues: existingValues,
            },
            error
        )

        view.id = params.id
        if (view.header) {
            view.header.title = 'Edit MCP Server'
        }
        return view
    }

    /**
     * Handles edit registry MCP server (read-only view)
     */
    async #handleEditRegistryMcpServer(params: McpServerClickParams, error?: string) {
        this.#isProgrammaticChange = true
        await this.#handleSavePermissionChange({ id: 'save-mcp-permission' })

        const serverName = params.title!
        this.#currentEditingServerName = serverName

        const config = McpManager.instance.getAllServerConfigs().get(serverName)
        if (!config) {
            return {
                id: params.id,
                header: {
                    title: 'Edit MCP Server',
                    status: {
                        title: `Server "${serverName}" not found`,
                        icon: 'cancel-circle',
                        status: 'error' as Status,
                    },
                },
                list: [],
            }
        }

        const transport = config.url ? TransportType.HTTP : TransportType.STDIO
        const argsList = (config.args ?? []).map(a => ({ arg_key: a }))
        const envList = Object.entries(config.env ?? {}).map(([k, v]) => ({ env_var_name: k, env_var_value: v }))
        const headersList = Object.entries(config.headers ?? {}).map(([k, v]) => ({ key: k, value: v }))
        const additionalHeadersList = Object.entries(config.__additionalHeaders__ ?? {}).map(([k, v]) => ({
            key: k,
            value: v,
        }))
        const additionalEnvList = Object.entries(config.__additionalEnv__ ?? {}).map(([k, v]) => ({
            env_var_name: k,
            env_var_value: v,
        }))
        const timeoutInSeconds = Math.floor((config.timeout ?? 60000) / 1000).toString()

        const argsValue = argsList.map((arg, index) => ({ persistent: index === 0, value: arg }))
        const envVarsValue = envList.map((env, index) => ({ persistent: index === 0, value: env }))
        const headersValue = headersList.map(hdr => ({ persistent: false, value: hdr }))
        const additionalHeadersValue = additionalHeadersList.map(hdr => ({ persistent: false, value: hdr }))
        const additionalEnvValue = additionalEnvList.map((env, index) => ({ persistent: index === 0, value: env }))

        const mcpManager = McpManager.instance
        const scope = mcpManager.isServerGlobal(sanitizeName(serverName)) ? 'global' : 'workspace'

        const common = [
            {
                type: 'radiogroup',
                id: 'scope',
                title: 'Scope',
                options: [
                    { label: 'Global - Used globally.', value: 'global' },
                    { label: 'This workspace - Only used in this workspace.', value: 'workspace' },
                ],
                value: scope,
            },
            {
                type: 'textinput',
                id: 'name',
                title: 'Name',
                value: serverName,
                disabled: true,
            },
            {
                type: 'select',
                id: 'transport',
                title: 'Transport',
                options: [
                    { label: TransportType.STDIO, value: TransportType.STDIO },
                    { label: TransportType.HTTP, value: TransportType.HTTP },
                ],
                value: transport,
                disabled: true,
            },
        ]

        const filterOptions =
            transport === TransportType.HTTP
                ? [
                      ...common,
                      {
                          type: 'textinput',
                          id: 'url',
                          title: 'URL',
                          value: config.url || '',
                          disabled: true,
                      },
                      {
                          type: 'list',
                          id: 'headers',
                          title: 'Headers - optional',
                          items: [
                              { id: 'key', title: 'Key', type: 'textinput' },
                              { id: 'value', title: 'Value', type: 'textinput' },
                          ],
                          ...(headersValue.length > 0 ? { value: headersValue } : {}),
                          disabled: true,
                      },
                      {
                          type: 'list',
                          id: 'additional_headers',
                          title: 'Additional headers - optional',
                          items: [
                              { id: 'key', title: 'Key', type: 'textinput' },
                              { id: 'value', title: 'Value', type: 'textinput' },
                          ],
                          ...(additionalHeadersValue.length > 0 ? { value: additionalHeadersValue } : {}),
                      },
                      {
                          type: 'numericinput',
                          id: 'timeout',
                          title: 'Timeout - use 0 to disable',
                          value: timeoutInSeconds,
                          disabled: true,
                      },
                  ]
                : [
                      ...common,
                      {
                          type: 'textinput',
                          id: 'command',
                          title: 'Command',
                          value: config.command || '',
                          disabled: true,
                      },
                      {
                          type: 'list',
                          id: 'args',
                          title: 'Arguments - optional',
                          items: [{ id: 'arg_key', type: 'textinput' }],
                          value: argsValue,
                          disabled: true,
                      },
                      {
                          type: 'list',
                          id: 'env_variables',
                          title: 'Environment variables - optional',
                          items: [
                              { id: 'env_var_name', title: 'Name', type: 'textinput' },
                              { id: 'env_var_value', title: 'Value', type: 'textinput' },
                          ],
                          value: envVarsValue,
                          disabled: true,
                      },
                      {
                          type: 'list',
                          id: 'additional_env_variables',
                          title: 'Additional variables - optional',
                          items: [
                              { id: 'env_var_name', title: 'Name', type: 'textinput' },
                              { id: 'env_var_value', title: 'Value', type: 'textinput' },
                          ],
                          ...(additionalEnvValue.length > 0 ? { value: additionalEnvValue } : {}),
                      },
                      {
                          type: 'numericinput',
                          id: 'timeout',
                          title: 'Timeout - use 0 to disable',
                          value: timeoutInSeconds,
                          disabled: false,
                      },
                  ]

        const serverStatusError = error
            ? { title: error, icon: 'cancel-circle', status: 'error' as Status }
            : this.#getServerStatusError(serverName) || {}
        const hasError = !!serverStatusError.status

        return {
            id: params.id,
            isMcpRegistry: true,
            header: {
                title: 'Edit MCP Server',
                status: serverStatusError,
                actions: hasError
                    ? [
                          {
                              id: 'mcp-details-menu',
                              icon: 'ellipsis-h',
                              text: '',
                              data: { serverName },
                          },
                      ]
                    : [],
            },
            list: [],
            filterActions: [
                { id: 'cancel-mcp', text: 'Cancel' },
                { id: 'save-mcp', text: 'Save', status: hasError ? ('error' as Status) : 'primary' },
            ],
            filterOptions,
        }
    }

    /**
     * Builds filter options for server configuration
     */
    #buildServerFilterOptions(serverName: string, toolsWithPermissions: any[]) {
        const filterOptions: FilterOption[] = []

        // Add tool select options
        toolsWithPermissions.forEach(item => {
            const toolName = item.tool.toolName
            // For Built-in server, use a special function that doesn't include the 'Deny' option
            let permissionOptions = this.#buildPermissionOptions()

            filterOptions.push({
                type: 'select',
                id: `${toolName}`,
                title: toolName,
                description: item.tool.description,
                options: permissionOptions,
                ...{ value: item.permission, boldTitle: true, mandatory: true, hideMandatoryIcon: true },
            })
        })

        return filterOptions
    }

    async #handleChangeTransport(params: McpServerClickParams) {
        const { optionsValues, title } = params
        const editingServerName = this.#currentEditingServerName

        // Clean up transport-specific fields
        if (optionsValues) {
            const transport = optionsValues.transport ?? TransportType.STDIO // Maintain default to 'stdio'
            const fieldsToDelete =
                transport === TransportType.HTTP ? ['command', 'args', 'env_variables'] : ['url', 'headers']

            fieldsToDelete.forEach(field => delete optionsValues[field])
        }

        // Handle server name change in edit mode
        if (editingServerName && title && editingServerName !== title) {
            const servers = McpManager.instance.getAllServerConfigs()
            const existingConfig = servers.get(editingServerName)

            if (existingConfig) {
                const updatedServers = new Map(servers)
                updatedServers.delete(editingServerName)
                updatedServers.set(title, existingConfig)
                await McpManager.instance.updateServerMap(updatedServers)
            }
            this.#serverNameBeforeUpdate = editingServerName
        }

        params.id = editingServerName ? 'edit-mcp' : 'add-new-mcp'
        return editingServerName ? this.#handleEditMcpServer(params) : this.#handleAddNewMcp(params)
    }

    /**
     * Gets the current permission setting for a tool
     */
    #getCurrentPermission(permission: string): string {
        if (permission === McpPermissionType.alwaysAllow) {
            return 'Always allow'
        } else if (permission === McpPermissionType.deny) {
            return 'Deny'
        } else {
            return 'Ask'
        }
    }

    /**
     * Builds permission options excluding the current one
     */
    #buildPermissionOptions() {
        const permissionOptions: PermissionOption[] = []

        permissionOptions.push({
            label: 'Ask',
            value: McpPermissionType.ask,
            description: 'Ask for your approval each time this tool is run',
        })

        permissionOptions.push({
            label: 'Always allow',
            value: McpPermissionType.alwaysAllow,
            description: 'Always allow this tool to run without asking for approval',
        })

        permissionOptions.push({ label: 'Deny', value: McpPermissionType.deny, description: 'Never run this tool' })

        return permissionOptions
    }

    /**
     * Builds permission options for Built-in tools (no 'Disable' option)
     */
    // #buildBuiltInPermissionOptions(currentPermission: string) {
    //     const permissionOptions: PermissionOption[] = []

    //     if (currentPermission !== 'alwaysAllow') {
    //         permissionOptions.push({
    //             label: 'Always run',
    //             value: 'alwaysAllow',
    //         })
    //     }

    //     if (currentPermission !== 'ask') {
    //         permissionOptions.push({
    //             label: 'Ask to run',
    //             value: 'ask',
    //         })
    //     }

    //     return permissionOptions
    // }

    /**
     * Handles MCP permission change events to update the pending permission config without applying changes
     */
    async #handleMcpPermissionChange(params: McpServerClickParams) {
        const serverName = params.title
        const updatedPermissionConfig = params.optionsValues

        if (!serverName || !updatedPermissionConfig) {
            return { id: params.id }
        }

        try {
            // Skip server config check for Built-in server
            let serverConfig
            try {
                serverConfig = McpManager.instance.getAllServerConfigs().get(serverName)
            } catch (error) {
                this.#features.logging.error(`McpManager not initialized for getAllServerConfigs: ${error}`)
                return { id: params.id }
            }
            if (serverName !== 'Built-in') {
                if (!serverConfig) {
                    throw new Error(`Server '${serverName}' not found`)
                }
            }

            const mcpServerPermission = await this.#processPermissionUpdates(
                serverName,
                updatedPermissionConfig,
                serverConfig?.__configPath__
            )

            // Store the permission config instead of applying it immediately
            this.#pendingPermissionConfig = {
                serverName,
                permission: mcpServerPermission,
            }

            this.#features.logging.info(`Stored pending permission change for server: ${serverName}`)

            return { id: params.id }
        } catch (error) {
            this.#features.logging.error(`Failed to process MCP permissions: ${error}`)
            return { id: params.id }
        }
    }

    /**
     * Handles saving MCP permission changes
     * Applies the stored permission changes
     */
    async #handleSavePermissionChange(params: McpServerClickParams) {
        if (!this.#pendingPermissionConfig) {
            this.#features.logging.warn('No pending permission changes to save')
            return { id: params.id }
        }

        // Set flag to ignore file changes during permission update
        this.#isProgrammaticChange = true

        try {
            const { serverName, permission } = this.#pendingPermissionConfig

            // Apply the stored permission changes
            try {
                await McpManager.instance.updateServerPermission(serverName, permission)
            } catch (error) {
                this.#features.logging.error(`McpManager not initialized for updateServerPermission: ${error}`)
                throw error
            }
            this.#emitMCPConfigEvent()

            // Get server config to emit telemetry
            let serverConfig
            try {
                serverConfig = McpManager.instance.getAllServerConfigs().get(serverName)
            } catch (error) {
                this.#features.logging.debug(`McpManager not initialized for getAllServerConfigs: ${error}`)
            }
            if (serverConfig) {
                // Emit server initialize event after permission change
                const transportType = serverConfig.command?.trim() ? TransportType.STDIO : TransportType.HTTP
                this.#telemetryController?.emitMCPServerInitializeEvent({
                    source: 'updatePermission',
                    command: transportType === TransportType.STDIO ? serverConfig.command : undefined,
                    url: transportType === TransportType.HTTP ? serverConfig.url : undefined,
                    enabled: true,
                    numTools: (() => {
                        try {
                            return McpManager.instance.getAllToolsWithPermissions(serverName).length
                        } catch (error) {
                            this.#features.logging.debug(
                                `McpManager not initialized for getAllToolsWithPermissions: ${error}`
                            )
                            return 0
                        }
                    })(),
                    scope:
                        serverConfig.__configPath__ ===
                            getGlobalAgentConfigPath(this.#features.workspace.fs.getUserHomeDir()) ||
                        serverConfig.__configPath__ ===
                            getGlobalMcpConfigPath(this.#features.workspace.fs.getUserHomeDir())
                            ? 'global'
                            : 'workspace',
                    transportType: transportType,
                    languageServerVersion: this.#features.runtime.serverInfo.version,
                })
            }

            // Clear the pending permission config after applying
            this.#pendingPermissionConfig = undefined

            this.#features.logging.info(`Applied permission changes for server: ${serverName}`)
            this.#releaseProgrammaticAfterDebounce()
            return { id: params.id }
        } catch (error) {
            this.#features.logging.error(`Failed to save MCP permissions: ${error}`)
            this.#releaseProgrammaticAfterDebounce()
            return { id: params.id }
        }
    }

    #emitMCPConfigEvent() {
        // Emit MCP config event after reinitialization
        let mcpManager, serverConfigs
        try {
            mcpManager = McpManager.instance
            serverConfigs = mcpManager.getAllServerConfigs()
        } catch (error) {
            this.#features.logging.debug(`McpManager not initialized for emitMCPConfigEvent with error: ${error}`)
            return
        }
        const activeServers = Array.from(serverConfigs.entries()).filter(
            ([name, _]: [string, MCPServerConfig]) => !mcpManager.isServerDisabled(name)
        ) as Array<[string, MCPServerConfig]>

        // Get the global paths
        const globalAgentPath = getGlobalAgentConfigPath(this.#features.workspace.fs.getUserHomeDir())
        const globalMcpPath = getGlobalMcpConfigPath(this.#features.workspace.fs.getUserHomeDir())

        // Count global vs project servers
        const globalServers = Array.from(serverConfigs.entries()).filter(
            ([_, config]) => config.__configPath__ === globalAgentPath || config.__configPath__ === globalMcpPath
        ).length
        const projectServers = serverConfigs.size - globalServers

        // Count tools by permission
        let toolsAlwaysAllowed = 0
        let toolsDenied = 0

        for (const [serverName, _] of activeServers) {
            const toolsWithPermissions = mcpManager.getAllToolsWithPermissions(serverName)
            toolsWithPermissions.forEach(item => {
                if (item.permission === McpPermissionType.alwaysAllow) {
                    toolsAlwaysAllowed++
                } else if (item.permission === McpPermissionType.deny) {
                    toolsDenied++
                }
            })
        }

        this.#telemetryController?.emitMCPConfigEvent({
            numActiveServers: activeServers.length,
            numGlobalServers: globalServers,
            numProjectServers: projectServers,
            numToolsAlwaysAllowed: toolsAlwaysAllowed,
            numToolsDenied: toolsDenied,
            languageServerVersion: this.#features.runtime.serverInfo.version,
        })

        // Emit server initialize events for all active servers
        for (const [serverName, config] of serverConfigs.entries()) {
            const transportType = config.command ? TransportType.STDIO : TransportType.HTTP
            const enabled = !mcpManager.isServerDisabled(serverName)
            this.#telemetryController?.emitMCPServerInitializeEvent({
                source: 'reload',
                command: transportType === TransportType.STDIO ? config.command : undefined,
                url: transportType === TransportType.HTTP ? config.url : undefined,
                enabled: enabled,
                numTools: mcpManager.getAllToolsWithPermissions(serverName).length,
                scope:
                    config.__configPath__ === globalAgentPath || config.__configPath__ === globalMcpPath
                        ? 'global'
                        : 'workspace',
                transportType: transportType,
                languageServerVersion: this.#features.runtime.serverInfo.version,
            })
        }
    }

    /**
     * Handled refresh MCP list events
     * @param params The click parameters
     * @param isProgrammatic Whether this refresh was triggered by a programmatic change
     */
    async #handleRefreshMCPList(params: McpServerClickParams, isProgrammatic: boolean = false) {
        this.#shouldDisplayListMCPServers = true

        // Set flag to ignore file changes during reinitialization if this is a programmatic change
        this.#isProgrammaticChange = isProgrammatic

        try {
            try {
                await McpManager.instance.reinitializeMcpServers()
            } catch (error) {
                this.#features.logging.error(`McpManager not initialized for reinitializeMcpServers: ${error}`)
                throw error
            }
            this.#emitMCPConfigEvent()

            // Reset flag after reinitialization
            this.#isProgrammaticChange = false

            return {
                id: params.id,
            }
        } catch (err) {
            this.#features.logging.error(`Failed to reinitialize MCP servers: ${err}`)

            // Reset flag in case of error
            this.#isProgrammaticChange = false

            return {
                id: params.id,
            }
        }
    }

    /**
     * Gets the appropriate agent path, checking workspace path first if it exists
     * @returns The agent path to use (workspace if exists, otherwise global)
     */
    async #getAgentPath(isGlobal: boolean = true): Promise<string> {
        const globalAgentPath = getGlobalAgentConfigPath(this.#features.workspace.fs.getUserHomeDir())
        if (isGlobal) {
            return globalAgentPath
        }
        // Get workspace folders and check for workspace agent path
        const workspaceFolders = this.#features.workspace.getAllWorkspaceFolders()
        if (workspaceFolders && workspaceFolders.length > 0) {
            const workspacePaths = workspaceFolders.map(folder => folder.uri)
            const workspaceAgentPaths = getWorkspaceAgentConfigPaths(workspacePaths)

            if (Array.isArray(workspaceAgentPaths) && workspaceAgentPaths.length > 0) {
                try {
                    // Convert URI format to filesystem path if needed using the utility function
                    const agentPath = normalizePathFromUri(workspaceAgentPaths[0], this.#features.logging)

                    return agentPath
                } catch (e) {
                    this.#features.logging.warn(`Failed to check if workspace agent path exists: ${e}`)
                }
            }
        }

        // Return global path if workspace path doesn't exist or there was an error
        return globalAgentPath
    }

    /**
     * Gets the appropriate MCP config path, checking workspace path first if it exists
     * @returns The MCP config path to use (workspace if exists, otherwise global)
     */
    async #getMcpConfigPath(isGlobal: boolean = true): Promise<string> {
        const globalMcpPath = getGlobalMcpConfigPath(this.#features.workspace.fs.getUserHomeDir())
        if (isGlobal) {
            return globalMcpPath
        }
        // Get workspace folders and check for workspace MCP path
        const workspaceFolders = this.#features.workspace.getAllWorkspaceFolders()
        if (workspaceFolders && workspaceFolders.length > 0) {
            const workspacePaths = workspaceFolders.map(folder => folder.uri)
            const workspaceMcpPaths = getWorkspaceMcpConfigPaths(workspacePaths)

            if (Array.isArray(workspaceMcpPaths) && workspaceMcpPaths.length > 0) {
                try {
                    // Convert URI format to filesystem path if needed using the utility function
                    const mcpPath = normalizePathFromUri(workspaceMcpPaths[0], this.#features.logging)

                    return mcpPath
                } catch (e) {
                    this.#features.logging.warn(`Failed to check if workspace MCP path exists: ${e}`)
                }
            }
        }

        // Return global path if workspace path doesn't exist or there was an error
        return globalMcpPath
    }

    /**
     * Processes permission updates from the UI
     */
    async #processPermissionUpdates(serverName: string, updatedPermissionConfig: any, agentPath: string | undefined) {
        const builtInToolAgentPath = await this.#getAgentPath()
        const perm: MCPServerPermission = {
            enabled: true,
            toolPerms: {},
            __configPath__: serverName === 'Built-in' ? builtInToolAgentPath : agentPath,
        }

        // Process each tool permission setting
        for (const [key, val] of Object.entries(updatedPermissionConfig)) {
            if (key === 'scope') continue

            const currentPerm = McpManager.instance.getToolPerm(serverName, key)
            if (val === currentPerm) continue
            switch (val) {
                case McpPermissionType.alwaysAllow:
                    perm.toolPerms[key] = McpPermissionType.alwaysAllow
                    break
                case McpPermissionType.deny:
                    perm.toolPerms[key] = McpPermissionType.deny
                    break
                case McpPermissionType.ask:
                default:
                    perm.toolPerms[key] = McpPermissionType.ask
            }
        }

        return perm
    }

    /**
     * Gets the UI status object for a specific MCP server
     */
    #getServerStatusError(serverName: string): { title: string; icon: string; status: Status } | undefined {
        let serverStates
        try {
            serverStates = McpManager.instance.getAllServerStates()
        } catch (error) {
            this.#features.logging.debug(`McpManager not initialized for getAllServerStates: ${error}`)
            return undefined
        }
        const key = serverName ? sanitizeName(serverName) : serverName
        const serverState = key ? serverStates.get(key) : undefined

        if (!serverState) {
            return undefined
        }

        // Only return status if there's an error
        if (serverState.lastError) {
            return {
                title: serverState.lastError,
                icon: 'cancel-circle',
                status: 'error',
            }
        }

        return undefined
    }

    /**
     * Setup file watchers for MCP config and persona files
     */
    #setupFileWatchers(): void {
        const wsUris = this.#features.workspace.getAllWorkspaceFolders()?.map(f => f.uri) ?? []
        let homeDir: string | undefined
        try {
            homeDir = this.#features.workspace.fs.getUserHomeDir?.()
        } catch (e) {
            this.#features.logging.warn(`Failed to get user home directory: ${e}`)
        }

        // Watch both agent config files and MCP config files
        const agentPaths = [
            ...getWorkspaceAgentConfigPaths(wsUris),
            ...(homeDir ? [getGlobalAgentConfigPath(homeDir)] : []),
        ]

        const mcpPaths = [...getWorkspaceMcpConfigPaths(wsUris), ...(homeDir ? [getGlobalMcpConfigPath(homeDir)] : [])]

        const allPaths = [...agentPaths, ...mcpPaths]

        this.#fileWatcher.watchPaths(allPaths, () => {
            // Store the current programmatic state when the event is triggered
            this.#lastProgrammaticState = this.#isProgrammaticChange

            // Log the values for debugging
            this.#features.logging.info(
                `File watcher triggered - isProgrammaticChange: ${this.#isProgrammaticChange}, ` +
                    `lastProgrammaticState: ${this.#lastProgrammaticState}`
            )

            // Clear any existing timer
            if (this.#debounceTimer) {
                clearTimeout(this.#debounceTimer)
            }

            // Set a new timer with 2 second debounce
            this.#debounceTimer = setTimeout(async () => {
                // Log the values again when the timer fires
                this.#features.logging.debug(
                    `Debounce timer fired - lastProgrammaticState: ${this.#lastProgrammaticState}`
                )

                // Only proceed if the stored state allows it
                if (!this.#lastProgrammaticState) {
                    await this.#handleRefreshMCPList({ id: 'refresh-mcp-list' })
                } else {
                    this.#features.logging.debug('Skipping refresh due to programmatic change')
                }
                this.#debounceTimer = null
            }, McpEventHandler.FILE_WATCH_DEBOUNCE_MS)
        })
    }

    /**
     * Shows registry servers for installation
     */
    async #handleShowRegistryServers(params: McpServerClickParams): Promise<any> {
        const registry = McpManager.instance.getRegistryService()?.getInMemoryRegistry()
        if (!registry) {
            return this.#handleAddNewMcp(params, 'Registry not available')
        }

        const installedServers = McpManager.instance.getAllServerConfigs()

        return {
            id: 'add-new-mcp',
            isMcpRegistry: true,
            header: {
                title: 'Add MCP Server',
                description: 'Select a server from the registry',
            },
            filterOptions: [],
            list: [
                {
                    children: registry.servers.map(server => {
                        const isInstalled = installedServers.has(server.name)
                        const isRemote = !!server.remotes

                        return {
                            title: `${server.name} ${server.version || ''}`,
                            description: server.description || 'No description available',
                            icon: isRemote ? 'globe' : 'desktop',
                            actions: [
                                {
                                    id: 'install-registry-server',
                                    text: isInstalled ? 'Installed' : 'Install',
                                    status: isInstalled ? 'clear' : 'main',
                                    disabled: isInstalled,
                                },
                            ],
                            groupActions: false,
                        }
                    }),
                },
            ],
        }
    }

    /**
     * Handles saving registry MCP server (headers/env updates only)
     */
    async #handleSaveRegistryMcp(params: McpServerClickParams) {
        const serverName = params.optionsValues!.name
        const sanitizedServerName = sanitizeName(serverName)
        const registryService = McpManager.instance.getRegistryService()
        const registryServer = registryService?.getServerByName(sanitizedServerName)
        if (!registryServer) {
            return this.#handleEditRegistryMcpServer(params, 'Server not found')
        }

        const isRemote = !!registryServer.remotes
        let additionalHeaders: Record<string, string> | undefined
        let additionalEnv: Record<string, string> | undefined

        // Parse additional headers from form
        if (isRemote) {
            const additionalHeadersList = Array.isArray(params.optionsValues!.additional_headers)
                ? params.optionsValues!.additional_headers
                : []
            const additionalHeadersObj = additionalHeadersList.reduce((acc: Record<string, string>, item: any) => {
                const k = item.key?.toString().trim() ?? ''
                const v = item.value?.toString().trim() ?? ''
                if (k && v) acc[k] = v
                return acc
            }, {})
            if (Object.keys(additionalHeadersObj).length > 0) {
                additionalHeaders = additionalHeadersObj
            }
        }

        // Parse additional env from form
        if (!isRemote) {
            const additionalEnvList = Array.isArray(params.optionsValues!.additional_env_variables)
                ? params.optionsValues!.additional_env_variables
                : []
            const additionalEnvObj = additionalEnvList.reduce((acc: Record<string, string>, item: any) => {
                if (item && 'env_var_name' in item && 'env_var_value' in item) {
                    acc[String(item.env_var_name)] = String(item.env_var_value)
                }
                return acc
            }, {})
            if (Object.keys(additionalEnvObj).length > 0) {
                additionalEnv = additionalEnvObj
            }
        }

        const timeoutInMs = (parseInt(params.optionsValues!.timeout) ?? 60) * 1000
        const agentPath = await this.#getAgentPath(params.optionsValues!.scope === 'global')

        const config = this.#converter.convertRegistryServer(registryServer, additionalEnv)
        config.__cachedVersion__ = registryServer.version
        config.timeout = timeoutInMs

        this.#isProgrammaticChange = true

        try {
            await McpManager.instance.removeServer(sanitizedServerName)
            await McpManager.instance.addRegistryServer(
                sanitizedServerName,
                config,
                agentPath,
                additionalHeaders,
                additionalEnv
            )
            this.#releaseProgrammaticAfterDebounce()
            return this.#handleOpenMcpServer({ id: 'open-mcp-server', title: sanitizedServerName })
        } catch (error) {
            this.#features.logging.error(`Failed to update registry server: ${error}`)
            this.#releaseProgrammaticAfterDebounce()
            return this.#handleEditRegistryMcpServer(params, String(error))
        }
    }

    /**
     * Installs a server from the registry
     */
    async #handleInstallRegistryServer(params: McpServerClickParams) {
        const serverName = params.title?.split(' ')[0]
        if (!serverName) return

        const registryService = McpManager.instance.getRegistryService()
        const registryServer = registryService?.getServerByName(serverName)
        if (!registryServer) {
            this.#features.logging.error(`Registry server not found: ${serverName}`)
            return this.#handleShowRegistryServers(params)
        }

        const config = this.#converter.convertRegistryServer(registryServer)
        config.__cachedVersion__ = registryServer.version

        const agentPath = await this.#getAgentPath(true)
        this.#isProgrammaticChange = true

        try {
            await McpManager.instance.addRegistryServer(serverName, config, agentPath)
            this.#releaseProgrammaticAfterDebounce()
            return this.#handleOpenMcpServer({ id: 'open-mcp-server', title: serverName })
        } catch (error) {
            this.#features.logging.error(`Failed to install registry server: ${error}`)
            this.#releaseProgrammaticAfterDebounce()
            return this.#handleShowRegistryServers(params)
        }
    }

    /**
     * Cleanup file watchers
     */
    dispose(): void {
        if (this.#debounceTimer) {
            clearTimeout(this.#debounceTimer)
            this.#debounceTimer = null
        }
        this.#fileWatcher.close()
    }
}
