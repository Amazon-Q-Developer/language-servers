import { CancellationToken, Server, ToolClassification } from '@aws/language-server-runtimes/server-interface'
import { FsRead, FsReadParams } from './fsRead'
import { FsWrite, FsWriteParams } from './fsWrite'
import { ListDirectory, ListDirectoryParams } from './listDirectory'
import { ExecuteBash, ExecuteBashParams } from './executeBash'
import { LspGetDocuments, LspGetDocumentsParams } from './lspGetDocuments'
import { LspReadDocumentContents, LspReadDocumentContentsParams } from './lspReadDocumentContents'
import { LspApplyWorkspaceEdit } from './lspApplyWorkspaceEdit'
import { AGENT_TOOLS_CHANGED, McpManager } from './mcp/mcpManager'
import { McpTool } from './mcp/mcpTool'
import { FileSearch, FileSearchParams } from './fileSearch'
import { GrepSearch } from './grepSearch'
import { CodeReview } from './qCodeAnalysis/codeReview'
import { CodeWhispererServiceIAM, CodeWhispererServiceToken } from '../../../shared/codeWhispererService'
import { McpToolDefinition } from './mcp/mcpTypes'
import {
    getGlobalAgentConfigPath,
    getWorkspaceAgentConfigPaths,
    createNamespacedToolName,
    enabledMCP,
    migrateToAgentConfig,
    migrateAgentConfigToCLIFormat,
    normalizePathFromUri,
} from './mcp/mcpUtils'
import { FsReplace, FsReplaceParams } from './fsReplace'
import { CodeReviewUtils } from './qCodeAnalysis/codeReviewUtils'
import { DEFAULT_AWS_Q_ENDPOINT_URL, DEFAULT_AWS_Q_REGION } from '../../../shared/constants'
import { getUserAgent, makeUserContextObject } from '../../../shared/telemetryUtils'
import { DisplayFindings } from './qCodeAnalysis/displayFindings'
import { ProfileStatusMonitor } from './mcp/profileStatusMonitor'
import { AmazonQTokenServiceManager } from '../../../shared/amazonQServiceManager/AmazonQTokenServiceManager'
import { SERVICE_MANAGER_TIMEOUT_MS, SERVICE_MANAGER_POLL_INTERVAL_MS } from '../constants/constants'
import { isUsingIAMAuth } from '../../../shared/utils'

export const FsToolsServer: Server = ({ workspace, logging, agent, lsp }) => {
    const fsReadTool = new FsRead({ workspace, lsp, logging })
    const fsWriteTool = new FsWrite({ workspace, lsp, logging })
    const listDirectoryTool = new ListDirectory({ workspace, logging, lsp })
    const fileSearchTool = new FileSearch({ workspace, lsp, logging })
    const fsReplaceTool = new FsReplace({ workspace, lsp, logging })

    agent.addTool(
        fsReadTool.getSpec(),
        async (input: FsReadParams) => {
            await fsReadTool.validate(input)
            return await fsReadTool.invoke(input)
        },
        ToolClassification.BuiltIn
    )

    agent.addTool(
        fsWriteTool.getSpec(),
        async (input: FsWriteParams) => {
            await fsWriteTool.validate(input)
            return await fsWriteTool.invoke(input)
        },
        ToolClassification.BuiltInCanWrite
    )

    agent.addTool(
        fsReplaceTool.getSpec(),
        async (input: FsReplaceParams) => {
            await fsReplaceTool.validate(input)
            return await fsReplaceTool.invoke(input)
        },
        ToolClassification.BuiltInCanWrite
    )

    agent.addTool(
        listDirectoryTool.getSpec(),
        async (input: ListDirectoryParams, token?: CancellationToken) => {
            await listDirectoryTool.validate(input)
            return await listDirectoryTool.invoke(input, token)
        },
        ToolClassification.BuiltIn
    )

    agent.addTool(
        fileSearchTool.getSpec(),
        async (input: FileSearchParams, token?: CancellationToken) => {
            await fileSearchTool.validate(input)
            return await fileSearchTool.invoke(input, token)
        },
        ToolClassification.BuiltIn
    )

    // Temporarily disable grep search
    // agent.addTool(grepSearchTool.getSpec(), async (input: GrepSearchParams, token?: CancellationToken) => {
    //     await grepSearchTool.validate(input)
    //     return await grepSearchTool.invoke(input, token)
    // }, ToolClassification.BuiltIn)

    return () => {}
}

export const QCodeAnalysisServer: Server = ({
    agent,
    credentialsProvider,
    logging,
    lsp,
    runtime,
    sdkInitializator,
    telemetry,
    workspace,
}) => {
    logging.info('QCodeAnalysisServer')
    const codeReviewTool = new CodeReview({
        credentialsProvider,
        logging,
        telemetry,
        workspace,
    })

    const displayFindingsTool = new DisplayFindings({
        logging,
        telemetry,
        workspace,
    })

    lsp.onInitialized(async () => {
        if (!CodeReviewUtils.isAgenticReviewEnabled(lsp.getClientInitializeParams())) {
            logging.warn('Agentic Review is currently not supported')
            return
        }

        logging.info('LSP on initialize for QCodeAnalysisServer')
        // Get credentials provider from the LSP context
        if (!credentialsProvider.hasCredentials) {
            logging.error('Credentials provider not available')
            return
        }

        // Create the CodeWhisperer client for review tool based on iam auth check
        const initializeParams = lsp.getClientInitializeParams()
        const customUserAgent = initializeParams ? getUserAgent(initializeParams, runtime.serverInfo) : undefined
        const userContext = initializeParams
            ? makeUserContextObject(initializeParams, runtime.platform, 'token', runtime.serverInfo)
            : undefined

        const codeWhispererClient = isUsingIAMAuth()
            ? new CodeWhispererServiceIAM(
                  credentialsProvider,
                  workspace,
                  logging,
                  process.env.CODEWHISPERER_REGION || DEFAULT_AWS_Q_REGION,
                  process.env.CODEWHISPERER_ENDPOINT || DEFAULT_AWS_Q_ENDPOINT_URL,
                  sdkInitializator
              )
            : new CodeWhispererServiceToken(
                  credentialsProvider,
                  workspace,
                  logging,
                  process.env.CODEWHISPERER_REGION || DEFAULT_AWS_Q_REGION,
                  process.env.CODEWHISPERER_ENDPOINT || DEFAULT_AWS_Q_ENDPOINT_URL,
                  sdkInitializator,
                  userContext,
                  customUserAgent
              )

        agent.addTool(
            {
                name: CodeReview.toolName,
                description: CodeReview.toolDescription,
                inputSchema: CodeReview.inputSchema,
            },
            async (input: any, token?: CancellationToken, updates?: WritableStream) => {
                return await codeReviewTool.execute(input, {
                    codeWhispererClient: codeWhispererClient,
                    cancellationToken: token,
                    writableStream: updates,
                })
            },
            ToolClassification.BuiltIn
        )

        if (!CodeReviewUtils.isDisplayFindingsEnabled(lsp.getClientInitializeParams())) {
            logging.warn('Display Findings is currently not supported')
            return
        }

        agent.addTool(
            {
                name: DisplayFindings.toolName,
                description: DisplayFindings.toolDescription,
                inputSchema: DisplayFindings.inputSchema,
            },
            async (input: any, token?: CancellationToken, updates?: WritableStream) => {
                return await displayFindingsTool.execute(input, {
                    cancellationToken: token,
                    writableStream: updates,
                })
            },
            ToolClassification.BuiltIn
        )
    })

    return () => {}
}

export const BashToolsServer: Server = ({ logging, workspace, agent, lsp, telemetry, credentialsProvider }) => {
    const bashTool = new ExecuteBash({ logging, workspace, lsp, telemetry, credentialsProvider })
    agent.addTool(
        bashTool.getSpec(),
        async (input: ExecuteBashParams, token?: CancellationToken, updates?: WritableStream) => {
            await bashTool.validate(input)
            return await bashTool.invoke(input, token, updates)
        },
        ToolClassification.BuiltInCanWrite
    )
    return () => {}
}

export const LspToolsServer: Server = ({ workspace, logging, lsp, agent }) => {
    const lspGetDocuments = new LspGetDocuments({ workspace, logging })
    const lspReadDocumentContents = new LspReadDocumentContents({ workspace, logging })
    const lspApplyWorkspaceEdit = new LspApplyWorkspaceEdit({ lsp, logging })

    agent.addTool(LspGetDocuments.getSpec(), (input: LspGetDocumentsParams) => lspGetDocuments.invoke(input))
    agent.addTool(LspReadDocumentContents.getSpec(), (input: LspReadDocumentContentsParams) =>
        lspReadDocumentContents.invoke(input)
    )
    agent.addTool(LspApplyWorkspaceEdit.getSpec(), input => lspApplyWorkspaceEdit.invoke(input))

    return () => {}
}

/**
 * Recursively sanitize a JSON Schema for Ajv draft-07 compatibility.
 *
 * MCP spec (SEP-1613) defaults to JSON Schema 2020-12, but our Ajv instance
 * only supports draft-07. This function:
 *  - Strips `$schema` and `$id` meta-annotations that cause Ajv to throw
 *  - Converts `prefixItems` (2020-12 tuple syntax) to array-form `items` (draft-07)
 *  - Processes nested schemas so sub-schemas are also compatible
 *
 * Unknown 2020-12 keywords like `$dynamicRef` are left as-is — Ajv ignores
 * them with `strictSchema: false`, making validation more permissive (safe
 * direction; the MCP server validates inputs independently).
 */
function sanitizeSchemaForAjv(schema: any): any {
    if (schema === null || schema === undefined || typeof schema !== 'object') {
        return schema
    }

    if (Array.isArray(schema)) {
        return schema.map(sanitizeSchemaForAjv)
    }

    const result: any = {}
    for (const [key, value] of Object.entries(schema)) {
        // Strip meta-annotations that reference unsupported drafts
        if (key === '$schema' || key === '$id') {
            continue
        }

        // Convert draft-2020-12 prefixItems to draft-07 array-form items
        if (key === 'prefixItems') {
            result['items'] = Array.isArray(value) ? value.map(sanitizeSchemaForAjv) : sanitizeSchemaForAjv(value)
            continue
        }

        // Recurse into nested schema objects/arrays
        result[key] = sanitizeSchemaForAjv(value)
    }

    return result
}

export const McpToolsServer: Server = ({
    credentialsProvider,
    workspace,
    logging,
    lsp,
    agent,
    telemetry,
    runtime,
    chat,
}) => {
    const registered: Record<string, string[]> = {}
    const allNamespacedTools = new Set<string>()
    let profileStatusMonitor: ProfileStatusMonitor | undefined

    function removeAllMcpTools(): void {
        logging.info('Removing all MCP tools due to admin configuration')
        for (const [server, toolNames] of Object.entries(registered)) {
            for (const name of toolNames) {
                agent.removeTool(name)
                allNamespacedTools.delete(name)
                logging.info(`MCP: removed tool ${name}`)
            }
            registered[server] = []
        }

        // Only close McpManager if it has been initialized
        try {
            if (McpManager.instance) {
                void McpManager.instance.close(true) //keep the instance but close all servers.
            }
        } catch (error) {
            // McpManager not initialized, skip closing
            logging.debug('McpManager not initialized, skipping close operation')
        }

        try {
            chat?.sendChatUpdate({
                tabId: 'mcpserver',
                data: {
                    placeholderText: 'mcp-server-update',
                    messages: [],
                },
            })
        } catch (error) {
            logging.error(`Failed to send chatOptionsUpdate: ${error}`)
        }
    }

    function registerServerTools(server: string, defs: McpToolDefinition[]) {
        // 1) remove old tools
        for (const name of registered[server] ?? []) {
            agent.removeTool(name)
            allNamespacedTools.delete(name)
        }
        registered[server] = []

        // 2) add new enabled tools
        for (const def of defs) {
            // Sanitize the tool name

            // Check if this tool name is already in use
            let toolNameMapping = new Map()
            try {
                toolNameMapping = McpManager.instance.getToolNameMapping()
            } catch (error) {
                // McpManager not initialized, use empty mapping
                logging.debug('McpManager not initialized, using empty tool name mapping')
            }

            const namespaced = createNamespacedToolName(
                def.serverName,
                def.toolName,
                allNamespacedTools,
                toolNameMapping
            )
            const tool = new McpTool({ logging, workspace, lsp }, def)

            // Sanitize schema for Ajv compatibility. MCP spec (SEP-1613) defaults to
            // JSON Schema 2020-12, but our Ajv instance only supports draft-07. Strip
            // $schema/$id meta-annotations that cause Ajv to throw, and convert
            // draft-2020-12 keywords (prefixItems) to their draft-07 equivalents so
            // validation still works for tuple-style arrays.
            const sanitizedSchema = sanitizeSchemaForAjv(def.inputSchema ?? {})

            // Add explanation field to input schema
            const inputSchemaWithExplanation = {
                ...sanitizedSchema,
                properties: {
                    ...sanitizedSchema.properties,
                    explanation: {
                        type: 'string',
                        description:
                            'One sentence explanation as to why this tool is being used, and how it contributes to the goal.',
                    },
                },
            }

            const loggedToolName = `${namespaced} (original: ${def.toolName})`
            try {
                agent.addTool(
                    {
                        name: namespaced,
                        description: (def.description?.trim() || 'undefined').substring(0, 10240),
                        inputSchema: inputSchemaWithExplanation,
                    },
                    input => tool.invoke(input),
                    ToolClassification.MCP
                )
                registered[server].push(namespaced)
                logging.info(`MCP: registered tool ${loggedToolName}`)
            } catch (e) {
                console.warn(`Failed to register tool ${loggedToolName}:`, e)
            }
        }
    }

    async function initializeMcpManager() {
        try {
            const wsUris = workspace.getAllWorkspaceFolders()?.map(f => f.uri) ?? []
            const wsAgentPaths = getWorkspaceAgentConfigPaths(wsUris)
            const globalAgentPath = getGlobalAgentConfigPath(workspace.fs.getUserHomeDir())
            const allAgentPaths = [...wsAgentPaths, globalAgentPath]

            await migrateToAgentConfig(workspace, logging, agent)

            // Migrate existing agent configs to CLI format
            for (const agentPath of allAgentPaths) {
                const normalizedAgentPath = normalizePathFromUri(agentPath)
                const exists = await workspace.fs.exists(normalizedAgentPath).catch(() => false)
                if (exists) {
                    await migrateAgentConfigToCLIFormat(workspace, logging, normalizedAgentPath)
                }
            }

            // Get registry URL from profile monitor if available
            let registryUrl: string | null = null
            if (profileStatusMonitor) {
                registryUrl = await profileStatusMonitor.getRegistryUrl()
            }

            // Always initialize McpManager regardless of MCP state
            await McpManager.init(
                allAgentPaths,
                {
                    logging,
                    workspace,
                    lsp,
                    telemetry,
                    credentialsProvider,
                    runtime,
                    agent,
                },
                registryUrl ? { registryUrl } : undefined
            )

            McpManager.instance.clearToolNameMapping()
        } catch (e) {
            logging.error(`Failed to initialize MCP Manager: ${e}`)
        }
    }

    function registerAllMcpTools() {
        if (!ProfileStatusMonitor.getMcpState()) {
            return
        }

        const byServer: Record<string, McpToolDefinition[]> = {}
        for (const d of McpManager.instance.getEnabledTools()) {
            ;(byServer[d.serverName] ||= []).push(d)
        }
        for (const [server, defs] of Object.entries(byServer)) {
            registerServerTools(server, defs)
        }

        // Emit metrics after tools are registered
        McpManager.instance.emitMcpConfigMetrics()
    }

    lsp.onInitialized(async () => {
        try {
            if (!enabledMCP(lsp.getClientInitializeParams())) {
                logging.warn('MCP is currently not supported')
                return
            }

            // Initialize McpManager first, before profile monitor
            await initializeMcpManager()

            const sendMcpUpdate = () => {
                try {
                    chat?.sendChatUpdate({
                        tabId: 'mcpserver',
                        data: {
                            placeholderText: 'mcp-server-update',
                            messages: [],
                        },
                    })
                } catch (error) {
                    logging.error(`Failed to send chatOptionsUpdate: ${error}`)
                }
            }

            profileStatusMonitor = new ProfileStatusMonitor(
                logging,
                () => {
                    logging.info('MCP configuration disabled - removing tools')
                    // Clear registry errors when MCP is administratively disabled
                    try {
                        if (McpManager.instance) {
                            McpManager.instance.configLoadErrors.clear()
                        }
                    } catch (error) {
                        logging.debug('McpManager not initialized for clearing errors')
                    }
                    removeAllMcpTools()
                },
                async () => {
                    logging.info('MCP enabled by profile status monitor')
                    // Don't clear registry errors when re-enabling MCP
                    const existingErrors = McpManager.instance.getConfigLoadErrors()
                    await McpManager.instance.discoverAllServers()
                    // Restore registry errors if they existed
                    if (existingErrors && existingErrors.includes('MCP Registry:')) {
                        McpManager.instance.configLoadErrors.set('registry', existingErrors)
                    }
                    logging.info(`MCP: discovered ${McpManager.instance.getAllTools().length} tools after re-enable`)
                    registerAllMcpTools()
                    sendMcpUpdate()
                },
                async (registryUrl: string | null, isPeriodicSync: boolean = false) => {
                    try {
                        if (registryUrl) {
                            McpManager.instance.setRegistryActive(true)
                            await McpManager.instance.updateRegistryUrl(registryUrl, isPeriodicSync)
                            // Registry URL update handles server discovery internally
                        } else {
                            // No registry URL - ensure registry is not active and discover manual servers
                            McpManager.instance.setRegistryActive(false)
                            await McpManager.instance.discoverAllServers()
                        }
                        sendMcpUpdate()
                    } catch (error) {
                        const errorMsg = error instanceof Error ? error.message : String(error)
                        logging.error(`Registry URL update failed: ${errorMsg}`)
                        // Error is already stored in McpManager.configLoadErrors by updateRegistryUrl
                        sendMcpUpdate()
                    }
                }
            )

            // Wait for profile ARN to be available before checking MCP state
            const checkAndInitialize = async () => {
                try {
                    // Check if MCP is enabled via get Mcp state
                    const mcpEnabled = ProfileStatusMonitor.getMcpState()

                    if (mcpEnabled) {
                        logging.info('MCP is enabled, discovering servers')
                        // Preserve any existing registry errors before discovering servers
                        const existingErrors = McpManager.instance.getConfigLoadErrors()
                        await McpManager.instance.discoverAllServers()
                        // Restore registry errors if they existed
                        if (existingErrors && existingErrors.includes('MCP Registry:')) {
                            McpManager.instance.configLoadErrors.set('registry', existingErrors)
                        }
                        logging.info(
                            `MCP: discovered ${McpManager.instance.getAllTools().length} tools across all servers`
                        )
                        registerAllMcpTools()
                    } else {
                        logging.info('MCP is disabled, skipping server discovery')
                        removeAllMcpTools()
                    }

                    profileStatusMonitor!.start()
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : String(error)
                    logging.error(`MCP initialization failed: ${errorMsg}`)
                    // Store registry errors in McpManager for display in server list
                    if (errorMsg.includes('MCP Registry:')) {
                        try {
                            McpManager.instance.configLoadErrors.set('registry', errorMsg)
                        } catch (e) {
                            logging.debug('Failed to store registry error in McpManager')
                        }
                    }
                    throw error
                }
            }

            // Wait for auth to be initialized before discovering servers
            const waitForAuthAndDiscover = async () => {
                try {
                    // Set up event listener for tool changes during server initialization
                    McpManager.instance.events.on(AGENT_TOOLS_CHANGED, (server: string, defs: McpToolDefinition[]) => {
                        if (!ProfileStatusMonitor.getMcpState()) {
                            return
                        }
                        registerServerTools(server, defs)
                    })

                    const serviceManager = AmazonQTokenServiceManager.getInstance()
                    const authState = serviceManager.getState()

                    if (authState === 'INITIALIZED') {
                        logging.info('Auth is initialized, checking MCP state and discovering servers')
                        await checkAndInitialize()
                    } else {
                        logging.info(`Auth not ready (state: ${authState}), waiting before discovering MCP servers`)
                        // Poll for auth to be ready with 10s timeout
                        const startTime = Date.now()
                        const pollForReady = async () => {
                            const currentState = serviceManager.getState()
                            if (currentState === 'INITIALIZED') {
                                logging.info('Auth initialized, proceeding with MCP discovery')
                                await checkAndInitialize()
                            } else if (Date.now() - startTime < SERVICE_MANAGER_TIMEOUT_MS) {
                                setTimeout(pollForReady, SERVICE_MANAGER_POLL_INTERVAL_MS)
                            } else {
                                logging.warn(
                                    `Auth not ready after ${SERVICE_MANAGER_TIMEOUT_MS}ms, starting profile monitor without discovery`
                                )
                                profileStatusMonitor!.start()
                            }
                        }
                        setTimeout(pollForReady, SERVICE_MANAGER_POLL_INTERVAL_MS)
                    }
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : String(error)
                    logging.error(`Failed to initialize MCP: ${errorMsg}`)
                    // Don't start profile monitor if there's an error
                }
            }

            await waitForAuthAndDiscover()
        } catch (error) {
            console.warn('Caught error during MCP tool initialization; initialization may be incomplete:', error)
            logging.error(`Failed to initialize MCP in onInitialized: ${error}`)
        }
    })

    return async () => {
        profileStatusMonitor?.stop()
        await McpManager.instance.close()
    }
}
