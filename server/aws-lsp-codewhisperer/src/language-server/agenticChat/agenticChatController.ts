/**
 * Copied from ../chat/chatController.ts for the purpose of developing a divergent implementation.
 * Will be deleted or merged.
 */

import * as crypto from 'crypto'
import * as path from 'path'
import * as os from 'os'
import {
    ChatTriggerType,
    Origin,
    ToolResult,
    ToolResultContentBlock,
    ToolResultStatus,
    ToolUse,
    ToolUseEvent,
    ImageBlock,
} from '@amzn/codewhisperer-streaming'
import {
    FS_READ,
    FS_WRITE,
    FS_REPLACE,
    LIST_DIRECTORY,
    GREP_SEARCH,
    FILE_SEARCH,
    EXECUTE_BASH,
    BUTTON_RUN_SHELL_COMMAND,
    BUTTON_REJECT_SHELL_COMMAND,
    BUTTON_REJECT_MCP_TOOL,
    BUTTON_ALLOW_TOOLS,
    BUTTON_UNDO_CHANGES,
    BUTTON_UNDO_ALL_CHANGES,
    BUTTON_STOP_SHELL_COMMAND,
    BUTTON_PAIDTIER_UPGRADE_Q_LEARNMORE,
    BUTTON_PAIDTIER_UPGRADE_Q,
    SUFFIX_PERMISSION,
    SUFFIX_UNDOALL,
    SUFFIX_EXPLANATION,
} from './constants/toolConstants'
import { SendMessageCommandInput, ChatCommandInput, ChatCommandOutput } from '../../shared/streamingClientService'
import {
    Button,
    Status,
    ButtonClickParams,
    ButtonClickResult,
    ChatMessage,
    chatRequestType,
    FileDetails,
    InlineChatResultParams,
    PromptInputOptionChangeParams,
    TextDocument,
    RuleClickParams,
    ListRulesParams,
    ActiveEditorChangedParams,
    PinnedContextParams,
    ChatUpdateParams,
    MessageType,
    ExecuteCommandParams,
    FollowUpClickParams,
    ListAvailableModelsParams,
    ListAvailableModelsResult,
    OpenFileDialogParams,
    OpenFileDialogResult,
    ApplyWorkspaceEditParams,
    ErrorCodes,
    FeedbackParams,
    InsertToCursorPositionParams,
    TextDocumentEdit,
    TextEdit,
    InlineChatParams,
    ConversationClickParams,
    ListConversationsParams,
    ListMcpServersParams,
    McpServerClickParams,
    TabBarActionParams,
    CreatePromptParams,
    FileClickParams,
    Model,
} from '@aws/language-server-runtimes/protocol'
import {
    CancellationToken,
    Chat,
    ChatParams,
    ChatResult,
    FileList,
    EndChatParams,
    LSPErrorCodes,
    QuickActionParams,
    ResponseError,
    TabAddParams,
    TabRemoveParams,
    TabChangeParams,
    InlineChatResult,
} from '@aws/language-server-runtimes/server-interface'
import { v4 as uuid } from 'uuid'
import {
    AddMessageEvent,
    ChatConversationType,
    ChatInteractionType,
    ChatTelemetryEventName,
    CombinedConversationEvent,
    CompactHistoryActionType,
} from '../../shared/telemetry/types'
import { Features, LspHandlers, Result } from '../types'
import { ChatEventParser, ChatResultWithMetadata } from '../chat/chatEventParser'
import {
    createAuthFollowUpResult,
    getAuthFollowUpType,
    getDefaultChatResponse,
    getGovCloudUnsupportedResponse,
} from '../chat/utils'
import { ChatSessionManagementService } from '../chat/chatSessionManagementService'
import { ChatTelemetryController } from '../chat/telemetry/chatTelemetryController'
import { QuickAction } from '../chat/quickActions'
import { Metric } from '../../shared/telemetry/metric'
import {
    fmtError,
    getErrorMsg,
    getHttpStatusCode,
    getRequestID,
    getSsoConnectionType,
    isUsageLimitError,
    isNullish,
    getOriginFromClientInfo,
    getClientName,
    sanitizeInput,
    sanitizeRequestInput,
} from '../../shared/utils'
import { getCodeWhispererLanguageIdFromPath } from '../../shared/languageDetection'
import { HELP_MESSAGE, loadingMessage } from '../chat/constants'
import { TelemetryService } from '../../shared/telemetry/telemetryService'
import {
    AmazonQError,
    AmazonQServicePendingProfileError,
    AmazonQServicePendingSigninError,
} from '../../shared/amazonQServiceManager/errors'
import { AmazonQBaseServiceManager } from '../../shared/amazonQServiceManager/BaseAmazonQServiceManager'
import { AmazonQTokenServiceManager } from '../../shared/amazonQServiceManager/AmazonQTokenServiceManager'
import { AmazonQWorkspaceConfig } from '../../shared/amazonQServiceManager/configurationUtils'
import { TabBarController } from './tabBarController'
import { ChatDatabase, ToolResultValidationError } from './tools/chatDb/chatDb'
import {
    AgenticChatEventParser,
    ChatResultWithMetadata as AgenticChatResultWithMetadata,
} from './agenticChatEventParser'
import { ChatSessionService } from '../chat/chatSessionService'
import { AgenticChatResultStream, progressPrefix, ResultStreamWriter } from './agenticChatResultStream'
import { toolResultMessage } from './textFormatting'
import {
    AdditionalContentEntryAddition,
    AgenticChatTriggerContext,
    TriggerContext,
} from './context/agenticChatTriggerContext'
import { AdditionalContextProvider } from './context/additionalContextProvider'
import {
    getNewPromptFilePath,
    getNewRuleFilePath,
    getUserPromptsDirectory,
    promptFileExtension,
} from './context/contextUtils'
import { ContextCommandsProvider } from './context/contextCommandsProvider'
import { LocalProjectContextController } from '../../shared/localProjectContextController'
import { CancellationError, workspaceUtils } from '@aws/lsp-core'
import { FsRead, FsReadParams } from './tools/fsRead'
import { ListDirectory, ListDirectoryParams } from './tools/listDirectory'
import { FsWrite, FsWriteParams } from './tools/fsWrite'
import { ExecuteBash, ExecuteBashParams } from './tools/executeBash'
import { ExplanatoryParams, InvokeOutput, ToolApprovalException } from './tools/toolShared'
import { validatePathBasic, validatePathExists, validatePaths as validatePathsSync } from './utils/pathValidation'
import { calculateModifiedLines } from './utils/fileModificationMetrics'
import { TokenLimitsCalculator } from './utils/tokenLimitsCalculator'
import { GrepSearch, SanitizedRipgrepOutput } from './tools/grepSearch'
import { FileSearch, FileSearchParams, isFileSearchParams } from './tools/fileSearch'
import { FsReplace, FsReplaceParams } from './tools/fsReplace'
import { loggingUtils, timeoutUtils } from '@aws/lsp-core'
import { diffLines } from 'diff'
import {
    GENERIC_ERROR_MS,
    LOADING_THRESHOLD_MS,
    OUTPUT_LIMIT_EXCEEDS_PARTIAL_MSG,
    RESPONSE_TIMEOUT_MS,
    RESPONSE_TIMEOUT_PARTIAL_MSG,
    INCOMPLETE_TOOL_USE_RETRY_LIMIT_MSG,
    MAX_INCOMPLETE_TOOL_USE_RETRIES,
    INVOKE_LLM_REASON_INCOMPLETE_TOOL_USE_RETRYING,
    INVOKE_LLM_REASON_INCOMPLETE_TOOL_USE_EXHAUSTED,
    COMPACTION_BODY,
    COMPACTION_HEADER_BODY,
    DEFAULT_MACOS_RUN_SHORTCUT,
    DEFAULT_WINDOW_RUN_SHORTCUT,
    DEFAULT_MACOS_REJECT_SHORTCUT,
    DEFAULT_WINDOW_REJECT_SHORTCUT,
    DEFAULT_MACOS_STOP_SHORTCUT,
    DEFAULT_WINDOW_STOP_SHORTCUT,
    FSREAD_MEMORY_BANK_MAX_PER_FILE,
    FSREAD_MEMORY_BANK_MAX_TOTAL,
} from './constants/constants'
import {
    AgenticChatError,
    customerFacingErrorCodes,
    getCustomerFacingErrorMessage,
    isRequestAbortedError,
    isThrottlingRelated,
    unactionableErrorCodes,
} from './errors'
import { URI } from 'vscode-uri'
import { CommandCategory } from './tools/executeBash'
import { UserWrittenCodeTracker } from '../../shared/userWrittenCodeTracker'
import { CodeReview } from './tools/qCodeAnalysis/codeReview'
import { CodeReviewResult } from './tools/qCodeAnalysis/codeReviewTypes'
import {
    CODE_REVIEW_FINDINGS_MESSAGE_SUFFIX,
    DISPLAY_FINDINGS_MESSAGE_SUFFIX,
} from './tools/qCodeAnalysis/codeReviewConstants'
import { McpEventHandler } from './tools/mcp/mcpEventHandler'
import { enabledMCP, createNamespacedToolName } from './tools/mcp/mcpUtils'
import { McpManager } from './tools/mcp/mcpManager'
import { McpTool } from './tools/mcp/mcpTool'
import {
    freeTierLimitUserMsg,
    onPaidTierLearnMore,
    paidTierManageSubscription,
    PaidTierMode,
    qProName,
} from '../paidTier/paidTier'
import {
    estimateCharacterCountFromImageBlock,
    Message as DbMessage,
    messageToStreamingMessage,
} from './tools/chatDb/util'
import { FALLBACK_MODEL_OPTIONS, FALLBACK_MODEL_RECORD, BEDROCK_MODEL_TO_MODEL_ID } from './constants/modelSelection'
import { DEFAULT_IMAGE_VERIFICATION_OPTIONS, verifyServerImage } from '../../shared/imageVerification'
import { sanitize } from '@aws/lsp-core/out/util/path'
import { ActiveUserTracker } from '../../shared/activeUserTracker'
import { UserContext } from '@amzn/codewhisperer-runtime'
import { CodeWhispererServiceToken } from '../../shared/codeWhispererService'
import { DisplayFindings } from './tools/qCodeAnalysis/displayFindings'
import { IDE } from '../../shared/constants'
import { IdleWorkspaceManager } from '../workspaceContext/IdleWorkspaceManager'
import { SemanticSearch } from './tools/workspaceContext/semanticSearch'
import { MemoryBankController } from './context/memorybank/memoryBankController'

type ChatHandlers = Omit<
    LspHandlers<Chat>,
    | 'openTab'
    | 'sendChatUpdate'
    | 'sendContextCommands'
    | 'onListConversations'
    | 'onConversationClick'
    | 'onListMcpServers'
    | 'onMcpServerClick'
    | 'onTabBarAction'
    | 'getSerializedChat'
    | 'chatOptionsUpdate'
    | 'onListRules'
    | 'sendPinnedContext'
    | 'onActiveEditorChanged'
    | 'onPinnedContextAdd'
    | 'onPinnedContextRemove'
    | 'onOpenFileDialog'
    | 'onFilterContextCommands'
    | 'onListAvailableModels'
    | 'sendSubscriptionDetails'
    | 'onSubscriptionUpgrade'
>

export class AgenticChatController implements ChatHandlers {
    #features: Features
    #chatSessionManagementService: ChatSessionManagementService
    #telemetryController: ChatTelemetryController
    #triggerContext: AgenticChatTriggerContext
    #customizationArn?: string
    #telemetryService: TelemetryService
    #serviceManager?: AmazonQBaseServiceManager
    #tabBarController: TabBarController
    #chatHistoryDb: ChatDatabase
    #additionalContextProvider: AdditionalContextProvider
    #contextCommandsProvider: ContextCommandsProvider
    #memoryBankController: MemoryBankController
    #stoppedToolUses = new Set<string>()
    #userWrittenCodeTracker: UserWrittenCodeTracker | undefined
    #toolUseStartTimes: Record<string, number> = {}
    #toolUseLatencies: Array<{ toolName: string; toolUseId: string; latency: number }> = []
    #mcpEventHandler: McpEventHandler
    #paidTierMode: PaidTierMode | undefined
    #subscriptionStatusPromise: Promise<void> | undefined
    #origin: Origin
    #activeUserTracker: ActiveUserTracker

    // latency metrics
    #llmRequestStartTime: number = 0
    #toolCallLatencies: number[] = []
    #toolStartTime: number = 0
    #timeToFirstChunk: number = -1
    #timeBetweenChunks: number[] = []
    #lastChunkTime: number = 0

    // A/B testing allocation
    #abTestingFetchingTimeout: NodeJS.Timeout | undefined
    #abTestingAllocation:
        | {
              experimentName: string
              userVariation: string
          }
        | undefined

    /**
     * Determines the appropriate message ID for a tool use based on tool type and name
     * @param toolType The type of tool being used
     * @param toolUse The tool use object
     * @returns The message ID to use
     */
    #getMessageIdForToolUse(toolType: string | undefined, toolUse: ToolUse): string {
        const toolUseId = toolUse.toolUseId!
        // Return plain toolUseId for executeBash, add "_permission" suffix for all other tools
        return toolUse.name === EXECUTE_BASH || toolType === EXECUTE_BASH
            ? toolUseId
            : `${toolUseId}${SUFFIX_PERMISSION}`
    }

    /**
     * Logs system information that can be helpful for debugging customer issues
     */
    private logSystemInformation(): void {
        const clientInfo = this.#features.lsp.getClientInitializeParams()?.clientInfo
        const systemInfo = {
            languageServerVersion: this.#features.runtime.serverInfo.version ?? 'unknown',
            clientName: clientInfo?.name ?? 'unknown',
            clientVersion: clientInfo?.version ?? 'unknown',
            OS: os.platform(),
            OSVersion: os.release(),
            ComputeEnv: process.env.COMPUTE_ENV ?? 'unknown',
            extensionVersion:
                this.#features.lsp.getClientInitializeParams()?.initializationOptions?.aws?.clientInfo?.extension
                    ?.version,
        }

        this.#features.logging.info(`System Information: ${JSON.stringify(systemInfo)}`)
    }

    /**
     * Determines the appropriate message ID for a compaction confirmation
     * @param messageId The original messageId
     * @returns The message ID to use
     */
    #getMessageIdForCompact(messageId: string): string {
        return `${messageId}_compact`
    }

    constructor(
        chatSessionManagementService: ChatSessionManagementService,
        features: Features,
        telemetryService: TelemetryService,
        serviceManager?: AmazonQBaseServiceManager
    ) {
        this.#features = features
        this.#chatSessionManagementService = chatSessionManagementService
        this.#triggerContext = new AgenticChatTriggerContext(features)
        this.#telemetryController = new ChatTelemetryController(features, telemetryService)
        this.#telemetryService = telemetryService
        this.#serviceManager = serviceManager
        this.#serviceManager?.onRegionChange(region => {
            // @ts-ignore
            this.#features.chat.chatOptionsUpdate({ region })
        })
        this.#chatHistoryDb = ChatDatabase.getInstance(features)
        this.#tabBarController = new TabBarController(
            features,
            this.#chatHistoryDb,
            telemetryService,
            (tabId: string) => this.sendPinnedContext(tabId)
        )

        // Inject McpManager.getResources as a callback to avoid importing McpManager directly
        // in AdditionalContextProvider, which would pull Node.js-only MCP SDK dependencies
        // (node:process, node:stream) into the webworker webpack bundle and break packaging.
        this.#additionalContextProvider = new AdditionalContextProvider(features, this.#chatHistoryDb, () => {
            try {
                return McpManager.isInitialized() ? McpManager.instance.getResources() : []
            } catch {
                return []
            }
        })
        this.#contextCommandsProvider = new ContextCommandsProvider(
            this.#features.logging,
            this.#features.chat,
            this.#features.workspace,
            this.#features.lsp
        )
        this.#mcpEventHandler = new McpEventHandler(features, telemetryService)
        this.#origin = getOriginFromClientInfo(getClientName(this.#features.lsp.getClientInitializeParams()))
        this.#activeUserTracker = ActiveUserTracker.getInstance(this.#features)
        this.#memoryBankController = MemoryBankController.getInstance(features)
    }

    async onExecuteCommand(params: ExecuteCommandParams, _token: CancellationToken): Promise<any> {
        this.#log(`onExecuteCommand: ${params.command}`)
        switch (params.command) {
            case 'aws/chat/manageSubscription': {
                const awsAccountId = params.arguments?.[0]
                return this.onManageSubscription('', awsAccountId)
            }
            default:
                // Unknown command.
                return
        }
    }

    async onButtonClick(params: ButtonClickParams): Promise<ButtonClickResult> {
        this.#log(`onButtonClick event with params: ${JSON.stringify(params)}`)
        const session = this.#chatSessionManagementService.getSession(params.tabId)
        if (
            params.buttonId === BUTTON_RUN_SHELL_COMMAND ||
            params.buttonId === BUTTON_REJECT_SHELL_COMMAND ||
            params.buttonId === BUTTON_REJECT_MCP_TOOL ||
            params.buttonId === BUTTON_ALLOW_TOOLS
        ) {
            if (!session.data) {
                return { success: false, failureReason: `could not find chat session for tab: ${params.tabId} ` }
            }
            // For 'allow-tools', remove suffix as permission card needs to be seperate from file list card
            const messageId =
                params.buttonId === BUTTON_ALLOW_TOOLS && params.messageId.endsWith(SUFFIX_PERMISSION)
                    ? params.messageId.replace(SUFFIX_PERMISSION, '')
                    : params.messageId

            const handler = session.data.getDeferredToolExecution(messageId)
            if (!handler?.reject || !handler.resolve) {
                return {
                    success: false,
                    failureReason: `could not find deferred tool execution for message: ${messageId} `,
                }
            }
            params.buttonId === BUTTON_REJECT_SHELL_COMMAND || params.buttonId === BUTTON_REJECT_MCP_TOOL
                ? (() => {
                      handler.reject(new ToolApprovalException('Command was rejected.', true))
                      this.#stoppedToolUses.add(messageId)
                  })()
                : handler.resolve()
            return {
                success: true,
            }
        } else if (params.buttonId === BUTTON_UNDO_CHANGES) {
            const toolUseId = params.messageId
            try {
                await this.#undoFileChange(toolUseId, session.data)
                this.#updateUndoButtonAfterClick(params.tabId, toolUseId, session.data)
                this.#telemetryController.emitInteractWithAgenticChat(
                    'RejectDiff',
                    params.tabId,
                    session.data?.pairProgrammingMode,
                    session.data?.getConversationType(),
                    this.#abTestingAllocation?.experimentName,
                    this.#abTestingAllocation?.userVariation
                )
            } catch (err: any) {
                return { success: false, failureReason: err.message }
            }
            return {
                success: true,
            }
        } else if (params.buttonId === BUTTON_UNDO_ALL_CHANGES) {
            const toolUseId = params.messageId.replace(SUFFIX_UNDOALL, '')
            await this.#undoAllFileChanges(params.tabId, toolUseId, session.data)
            return {
                success: true,
            }
        } else if (params.buttonId === BUTTON_STOP_SHELL_COMMAND) {
            this.#stoppedToolUses.add(params.messageId)
            await this.#renderStoppedShellCommand(params.tabId, params.messageId)
            return { success: true }
        } else if (params.buttonId === BUTTON_PAIDTIER_UPGRADE_Q_LEARNMORE) {
            onPaidTierLearnMore(this.#features.lsp, this.#features.logging)

            return { success: true }
        } else if (params.buttonId === BUTTON_PAIDTIER_UPGRADE_Q) {
            await this.onManageSubscription(params.tabId)

            return { success: true }
        } else {
            return {
                success: false,
                failureReason: 'not implemented',
            }
        }
    }

    async #undoFileChange(toolUseId: string, session: ChatSessionService | undefined): Promise<void> {
        this.#log(`Reverting file change for tooluseId: ${toolUseId}`)
        const toolUse = session?.toolUseLookup.get(toolUseId)

        const input = toolUse?.input as unknown as FsWriteParams | FsReplaceParams
        if (toolUse?.fileChange?.before) {
            await this.#features.workspace.fs.writeFile(input.path, toolUse.fileChange.before)
        } else {
            await this.#features.workspace.fs.rm(input.path)
            void LocalProjectContextController.getInstance().then(controller => {
                const filePath = URI.file(input.path).fsPath
                return controller.updateIndexAndContextCommand([filePath], false)
            })
        }
    }

    #updateUndoButtonAfterClick(tabId: string, toolUseId: string, session: ChatSessionService | undefined) {
        const cachedToolUse = session?.toolUseLookup.get(toolUseId)
        if (!cachedToolUse) {
            return
        }
        const fileList = cachedToolUse.chatResult?.header?.fileList
        const button = cachedToolUse.chatResult?.header?.buttons?.filter(button => button.id !== BUTTON_UNDO_CHANGES)

        const updatedHeader = {
            ...cachedToolUse.chatResult?.header,
            buttons: button,
            status: {
                status: 'error' as const,
                icon: 'cancel',
                text: 'Change discarded',
            },
            muted: true,
        }

        if (fileList && fileList.filePaths && fileList.details) {
            const updatedFileList = {
                ...fileList,
                muted: true,
            }
            const updatedDetails = { ...fileList.details }
            for (const filePath of fileList.filePaths) {
                if (updatedDetails[filePath]) {
                    ;(updatedDetails[filePath] as any) = {
                        ...updatedDetails[filePath],
                        clickable: false,
                    } as Partial<FileDetails>
                }
            }
            updatedFileList.details = updatedDetails
            updatedHeader.fileList = updatedFileList
        }

        this.#features.chat.sendChatUpdate({
            tabId,
            data: {
                messages: [
                    {
                        ...cachedToolUse.chatResult,
                        header: updatedHeader,
                    },
                ],
            },
        })
    }

    async #undoAllFileChanges(
        tabId: string,
        toolUseId: string,
        session: ChatSessionService | undefined
    ): Promise<void> {
        this.#log(`Reverting all file changes starting from ${toolUseId}`)
        const toUndo = session?.toolUseLookup.get(toolUseId)?.relatedToolUses
        if (!toUndo) {
            return
        }
        for (const messageId of [...toUndo].reverse()) {
            await this.onButtonClick({ buttonId: BUTTON_UNDO_CHANGES, messageId, tabId })
        }
    }

    async onOpenFileDialog(params: OpenFileDialogParams, token: CancellationToken): Promise<OpenFileDialogResult> {
        if (params.fileType === 'image') {
            // 1. Prompt user for file selection
            const supportedExtensions = DEFAULT_IMAGE_VERIFICATION_OPTIONS.supportedExtensions
            const filters = { 'Image Files': supportedExtensions }
            const result = await this.#features.lsp.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters,
            })

            if (!result.uris || result.uris.length === 0) {
                return {
                    tabId: params.tabId,
                    filePaths: [],
                    fileType: params.fileType,
                    insertPosition: params.insertPosition,
                    errorMessage: 'No file selected.',
                }
            }

            const validFilePaths: string[] = []
            let errorMessage: string | undefined
            for (const filePath of result.uris) {
                // Extract filename from the URI for error messages
                const fileName = path.basename(filePath) || ''
                const sanitizedPath = sanitize(filePath)

                // Get file size and content for verification
                const size = await this.#features.workspace.fs.getFileSize(sanitizedPath)
                const fileContent = await this.#features.workspace.fs.readFile(sanitizedPath, {
                    encoding: 'binary',
                })
                const imageBuffer = Buffer.from(fileContent, 'binary')

                // Use centralized verification utility
                const verificationResult = await verifyServerImage(fileName, size.size, imageBuffer)

                if (verificationResult.isValid) {
                    validFilePaths.push(filePath)
                } else {
                    errorMessage = verificationResult.errors[0] // Use first error message
                }
            }

            if (validFilePaths.length === 0) {
                return {
                    tabId: params.tabId,
                    filePaths: [],
                    fileType: params.fileType,
                    insertPosition: params.insertPosition,
                    errorMessage: errorMessage || 'No valid image selected.',
                }
            }

            // All valid files
            return {
                tabId: params.tabId,
                filePaths: validFilePaths,
                fileType: params.fileType,
                insertPosition: params.insertPosition,
            }
        }
        return {
            tabId: params.tabId,
            filePaths: [],
            fileType: params.fileType,
            insertPosition: params.insertPosition,
        }
    }

    async onCreatePrompt(params: CreatePromptParams): Promise<void> {
        if (params.isRule) {
            let workspaceFolders = workspaceUtils.getWorkspaceFolderPaths(this.#features.workspace)
            let workspaceRulesDirectory = path.join(workspaceFolders[0], '.amazonq', 'rules')
            if (workspaceFolders.length > 0) {
                const newFilePath = getNewRuleFilePath(params.promptName, workspaceRulesDirectory)
                const newFileContent = ''
                try {
                    await this.#features.workspace.fs.mkdir(workspaceRulesDirectory, { recursive: true })
                    await this.#features.workspace.fs.writeFile(newFilePath, newFileContent, { mode: 0o600 })
                    await this.#features.lsp.window.showDocument({ uri: URI.file(newFilePath).toString() })
                } catch (e) {
                    this.#features.logging.warn(`Error creating rule file: ${e}`)
                }
                return
            }
        }

        const newFilePath = getNewPromptFilePath(params.promptName)
        const newFileContent = ''
        try {
            await this.#features.workspace.fs.mkdir(getUserPromptsDirectory(), { recursive: true })
            await this.#features.workspace.fs.writeFile(newFilePath, newFileContent, { mode: 0o600 })
            await this.#features.lsp.window.showDocument({ uri: URI.file(newFilePath).toString() })
        } catch (e) {
            this.#features.logging.warn(`Error creating prompt file: ${e}`)
        }
    }

    dispose() {
        this.#chatSessionManagementService.dispose()
        this.#telemetryController.dispose()
        this.#chatHistoryDb.close()
        this.#contextCommandsProvider?.dispose()
        this.#userWrittenCodeTracker?.dispose()
        this.#mcpEventHandler.dispose()
        this.#activeUserTracker.dispose()
        clearInterval(this.#abTestingFetchingTimeout)
    }

    async onListConversations(params: ListConversationsParams) {
        return this.#tabBarController.onListConversations(params)
    }

    async onConversationClick(params: ConversationClickParams) {
        return this.#tabBarController.onConversationClick(params)
    }

    async onRuleClick(params: RuleClickParams) {
        return this.#additionalContextProvider.onRuleClick(params)
    }

    async onListRules(params: ListRulesParams) {
        return this.#additionalContextProvider.onListRules(params)
    }

    async onListMcpServers(params: ListMcpServersParams) {
        return this.#mcpEventHandler.onListMcpServers(params)
    }

    async onMcpServerClick(params: McpServerClickParams) {
        return this.#mcpEventHandler.onMcpServerClick(params)
    }

    /**
     * Fetches available models either from cache or API
     * If cache is valid (less than 5 minutes old), returns cached models
     * If cache is invalid or empty, makes an API call and stores results in cache
     * If the API throws errors (e.g., throttling), falls back to default models
     */
    async #fetchModelsWithCache(): Promise<{ models: Model[]; defaultModelId?: string; errorFromAPI: boolean }> {
        let models: Model[] = []
        let defaultModelId: string | undefined
        let errorFromAPI = false

        // Check if cache is valid (less than 5 minutes old)
        if (this.#chatHistoryDb.isCachedModelsValid()) {
            const cachedData = this.#chatHistoryDb.getCachedModels()
            if (cachedData && cachedData.models && cachedData.models.length > 0) {
                this.#log('Using cached models, last updated at:', new Date(cachedData.timestamp).toISOString())
                return {
                    models: cachedData.models,
                    defaultModelId: cachedData.defaultModelId,
                    errorFromAPI: false,
                }
            }
        }

        // If cache is invalid or empty, make an API call
        this.#log('Cache miss or expired, fetching models from API')
        try {
            const client = AmazonQTokenServiceManager.getInstance().getCodewhispererService()
            const responseResult = await client.listAvailableModels({
                origin: IDE,
                profileArn: AmazonQTokenServiceManager.getInstance().getConnectionType()
                    ? AmazonQTokenServiceManager.getInstance().getActiveProfileArn()
                    : undefined,
            })

            // Wait for the response to be completed before proceeding
            this.#log('Model Response: ', JSON.stringify(responseResult, null, 2))
            if (responseResult.models) {
                models = Object.values(responseResult.models).map(
                    ({ modelId, modelName, description, tokenLimits }) => ({
                        id: modelId ?? 'unknown',
                        name: modelName ?? modelId ?? 'unknown',
                        description: description ?? '',
                        tokenLimits: tokenLimits
                            ? {
                                  maxInputTokens: tokenLimits.maxInputTokens,
                              }
                            : undefined,
                    })
                )
            }
            defaultModelId = responseResult.defaultModel?.modelId

            // Cache the models with defaultModelId
            this.#chatHistoryDb.setCachedModels(models, defaultModelId)
        } catch (err) {
            // In case of API throttling or other errors, fall back to hardcoded models
            this.#log('Error fetching models from API, using fallback models:', fmtError(err))
            errorFromAPI = true
            models = FALLBACK_MODEL_OPTIONS
        }

        return {
            models,
            defaultModelId,
            errorFromAPI,
        }
    }

    /**
     * This function handles the model selection process for the chat interface.
     * It first attempts to retrieve models from cache or API, then determines the appropriate model to select
     * based on the following priority:
     * 1. When errors occur or session is invalid: Use the default model as a fallback
     * 2. When user has previously selected a model: Use that model (or its mapped version if the model ID has changed)
     * 3. When there's a default model from the API: Use the server-recommended default model
     * 4. Last resort: Use the newest model defined in modelSelection constants
     *
     * This ensures users maintain consistent model selection across sessions while also handling
     * API failures and model ID migrations gracefully.
     */
    async onListAvailableModels(params: ListAvailableModelsParams): Promise<ListAvailableModelsResult> {
        // Get models from cache or API
        const { models, defaultModelId, errorFromAPI } = await this.#fetchModelsWithCache()

        // Get the first fallback model option as default
        const defaultModelOption = FALLBACK_MODEL_OPTIONS[0]
        const DEFAULT_MODEL_ID = defaultModelId || defaultModelOption?.id

        const sessionResult = this.#chatSessionManagementService.getSession(params.tabId)
        const { data: session, success } = sessionResult

        // Handle error cases by returning default model
        if (!success || errorFromAPI) {
            // Even in error cases, set the model with token limits
            if (success && session) {
                session.setModel(DEFAULT_MODEL_ID, models)
                this.#log(
                    `Model set for fallback (error case): ${DEFAULT_MODEL_ID}, tokenLimits: ${JSON.stringify(session.tokenLimits)}`
                )
            }
            return {
                tabId: params.tabId,
                models: models,
                selectedModelId: DEFAULT_MODEL_ID,
            }
        }

        // Determine selected model ID based on priority
        let selectedModelId: string
        let modelId = this.#chatHistoryDb.getModelId()

        // Helper function to get model label from FALLBACK_MODEL_RECORD
        const getModelLabel = (modelKey: string) =>
            FALLBACK_MODEL_RECORD[modelKey as keyof typeof FALLBACK_MODEL_RECORD]?.label || modelKey

        // Helper function to map enum model ID to API model ID
        const getMappedModelId = (modelKey: string) =>
            BEDROCK_MODEL_TO_MODEL_ID[modelKey as keyof typeof BEDROCK_MODEL_TO_MODEL_ID] || modelKey

        // Determine selected model ID based on priority
        if (modelId) {
            const mappedModelId = getMappedModelId(modelId)

            // Priority 1: Use mapped modelId if it exists in available models from backend
            if (models.some(model => model.id === mappedModelId)) {
                selectedModelId = mappedModelId
            }
            // Priority 2: Use mapped version if modelId exists in FALLBACK_MODEL_RECORD and no backend models available
            else if (models.length === 0 && modelId in FALLBACK_MODEL_RECORD) {
                selectedModelId = getModelLabel(modelId)
            }
            // Priority 3: Fall back to default or system default
            else {
                selectedModelId = defaultModelId || getMappedModelId(DEFAULT_MODEL_ID)
            }
        } else {
            // No user-selected model - use API default or system default
            selectedModelId = defaultModelId || getMappedModelId(DEFAULT_MODEL_ID)
        }

        // Store the selected model in the session (automatically calculates token limits)
        session.setModel(selectedModelId, models)
        this.#log(
            `Model set for initial selection: ${selectedModelId}, tokenLimits: ${JSON.stringify(session.tokenLimits)}`
        )

        return {
            tabId: params.tabId,
            models: models,
            selectedModelId: selectedModelId,
        }
    }

    async #sendProgressToClient(chunk: ChatResult | string, partialResultToken?: string | number) {
        if (!isNullish(partialResultToken)) {
            await this.#features.lsp.sendProgress(chatRequestType, partialResultToken, chunk)
        }
    }

    #getChatResultStream(partialResultToken?: string | number): AgenticChatResultStream {
        return new AgenticChatResultStream(async (result: ChatResult | string) => {
            return this.#sendProgressToClient(result, partialResultToken)
        })
    }

    async onChatPrompt(params: ChatParams, token: CancellationToken): Promise<ChatResult | ResponseError<ChatResult>> {
        const clientRegion = this.#features.lsp.getClientInitializeParams()?.initializationOptions?.aws?.region
        const maybeGovResponse = getGovCloudUnsupportedResponse(clientRegion)
        if (maybeGovResponse) {
            return maybeGovResponse
        }

        // Phase 1: Initial Setup - This happens only once
        params.prompt.prompt = sanitizeInput(params.prompt.prompt || '', true)

        IdleWorkspaceManager.recordActivityTimestamp()

        const sessionResult = this.#chatSessionManagementService.getSession(params.tabId)
        const { data: session, success } = sessionResult

        if (!success) {
            return new ResponseError<ChatResult>(ErrorCodes.InternalError, sessionResult.error)
        }

        // Memory Bank Creation Flow - Delegate to MemoryBankController
        if (this.#memoryBankController.isMemoryBankCreationRequest(params.prompt.prompt)) {
            this.#features.logging.info(`Memory Bank creation request detected for tabId: ${params.tabId}`)
            session.isMemoryBankGeneration = true

            // Store original prompt to prevent data loss on failure
            const originalPrompt = params.prompt.prompt

            try {
                const workspaceFolders = workspaceUtils.getWorkspaceFolderPaths(this.#features.workspace)
                const workspaceUri = workspaceFolders.length > 0 ? workspaceFolders[0] : ''

                if (!workspaceUri) {
                    throw new Error('No workspace folder found for Memory Bank creation')
                }

                // Check if memory bank already exists to provide appropriate user feedback
                const memoryBankExists = await this.#memoryBankController.memoryBankExists(workspaceUri)
                const actionType = memoryBankExists ? 'Regenerating' : 'Generating'
                this.#features.logging.info(`${actionType} Memory Bank for workspace: ${workspaceUri}`)

                const resultStream = this.#getChatResultStream(params.partialResultToken)
                await resultStream.writeResultBlock({
                    body: `Preparing to analyze your project...`,
                    type: 'answer',
                    messageId: crypto.randomUUID(),
                })

                const comprehensivePrompt = await this.#memoryBankController.prepareComprehensiveMemoryBankPrompt(
                    workspaceUri,
                    async (prompt: string) => {
                        // Direct LLM call for ranking - no agentic loop
                        try {
                            if (!this.#serviceManager) {
                                throw new Error('amazonQServiceManager is not initialized')
                            }

                            const client = this.#serviceManager.getStreamingClient()
                            const requestInput: SendMessageCommandInput = {
                                conversationState: {
                                    chatTriggerType: ChatTriggerType.MANUAL,
                                    currentMessage: {
                                        userInputMessage: {
                                            content: prompt,
                                        },
                                    },
                                },
                            }

                            const response = await client.sendMessage(requestInput)

                            let responseContent = ''
                            const maxResponseSize = 50000 // 50KB limit

                            if (response.sendMessageResponse) {
                                for await (const chatEvent of response.sendMessageResponse) {
                                    if (chatEvent.assistantResponseEvent?.content) {
                                        responseContent += chatEvent.assistantResponseEvent.content
                                        if (responseContent.length > maxResponseSize) {
                                            this.#features.logging.warn('LLM response exceeded size limit, truncating')
                                            break
                                        }
                                    }
                                }
                            }

                            return responseContent.trim()
                        } catch (error) {
                            this.#features.logging.error(`Memory Bank LLM ranking failed: ${error}`)
                            return '' // Empty string triggers TF-IDF fallback
                        }
                    }
                )

                // Only update prompt if we got a valid comprehensive prompt
                if (comprehensivePrompt && comprehensivePrompt.trim().length > 0) {
                    params.prompt.prompt = comprehensivePrompt
                } else {
                    this.#features.logging.warn('Empty comprehensive prompt received, using original prompt')
                    params.prompt.prompt = originalPrompt
                }
            } catch (error) {
                this.#features.logging.error(`Memory Bank preparation failed: ${error}`)
                // Restore original prompt to ensure no data loss
                params.prompt.prompt = originalPrompt
                // Reset memory bank flag since preparation failed
                session.isMemoryBankGeneration = false
            }
        }

        const maybeDefaultResponse = !params.prompt.command && getDefaultChatResponse(params.prompt.prompt)
        if (maybeDefaultResponse) {
            return maybeDefaultResponse
        }

        const compactIds = session.getAllDeferredCompactMessageIds()
        await this.#invalidateCompactCommand(params.tabId, compactIds)
        session.rejectAllDeferredToolExecutions(new ToolApprovalException('Command ignored: new prompt', false))
        await this.#invalidateAllShellCommands(params.tabId, session)

        // Capture the modelId at request time so telemetry always reports the model
        // that was actually selected in this tab when the request was initiated,
        // even if the user switches models before the response/error is processed.
        const requestModelId = session.modelId

        const metric = new Metric<CombinedConversationEvent>({
            cwsprChatConversationType: 'AgenticChat',
            experimentName: this.#abTestingAllocation?.experimentName,
            userVariation: this.#abTestingAllocation?.userVariation,
        })

        const isNewActiveUser = this.#activeUserTracker.isNewActiveUser()
        if (isNewActiveUser) {
            this.#telemetryController.emitActiveUser()
        }

        try {
            const triggerContext = await this.#getTriggerContext(params, metric)
            if (triggerContext.programmingLanguage?.languageName) {
                this.#userWrittenCodeTracker?.recordUsageCount(triggerContext.programmingLanguage.languageName)
            }
            const isNewConversation = !session.conversationId
            session.contextListSent = false
            if (isNewConversation) {
                // agentic chat does not support conversationId in API response,
                // so we set it to random UUID per session, as other chat functionality
                // depends on it
                session.conversationId = uuid()
            }
            const chatResultStream = this.#getChatResultStream(params.partialResultToken)
            token.onCancellationRequested(async () => {
                this.#log('cancellation requested')

                // Abort all operations immediately
                session.abortRequest()
                const compactIds = session.getAllDeferredCompactMessageIds()
                await this.#invalidateCompactCommand(params.tabId, compactIds)
                void this.#invalidateAllShellCommands(params.tabId, session)
                session.rejectAllDeferredToolExecutions(new CancellationError('user'))

                // Then update UI to inform the user
                await this.#showUndoAllIfRequired(chatResultStream, session)
                await chatResultStream.updateOngoingProgressResult('Canceled')

                // Finally, send telemetry/metrics
                this.#telemetryController.emitInteractWithAgenticChat(
                    'StopChat',
                    params.tabId,
                    session.pairProgrammingMode,
                    session.getConversationType(),
                    this.#abTestingAllocation?.experimentName,
                    this.#abTestingAllocation?.userVariation
                )
                metric.setDimension('languageServerVersion', this.#features.runtime.serverInfo.version)
                metric.setDimension('codewhispererCustomizationArn', this.#customizationArn)
                metric.setDimension('enabled', session.pairProgrammingMode)
                await this.#telemetryController.emitAddMessageMetric(
                    params.tabId,
                    metric.metric,
                    'Cancelled',
                    undefined,
                    undefined,
                    requestModelId
                )
            })
            session.setConversationType('AgenticChat')

            // Set up delay notification callback to show retry progress to users
            session.setDelayNotificationCallback(notification => {
                if (notification.thresholdExceeded) {
                    this.#log(`Updating progress message: ${notification.message}`)
                    void chatResultStream.updateProgressMessage(notification.message)
                }
            })

            const additionalContext = await this.#additionalContextProvider.getAdditionalContext(
                triggerContext,
                params.tabId,
                params.context,
                params.prompt.prompt
            )
            // Add active file to context list if it's not already there
            const activeFile =
                triggerContext.activeFilePath &&
                triggerContext.relativeFilePath &&
                !additionalContext.some(item => item.path === triggerContext.activeFilePath)
                    ? [
                          {
                              name: path.basename(triggerContext.relativeFilePath),
                              description: '',
                              type: 'file',
                              relativePath: triggerContext.relativeFilePath,
                              path: triggerContext.activeFilePath,
                              startLine: -1,
                              endLine: -1,
                          },
                      ]
                    : []

            // Combine additional context with active file and get file list to display at top of response
            const contextItems = [...additionalContext, ...activeFile]
            triggerContext.documentReference = this.#additionalContextProvider.getFileListFromContext(contextItems)

            const customContext = await this.#additionalContextProvider.getImageBlocksFromContext(
                params.context,
                params.tabId
            )

            let finalResult
            if (params.prompt.command === QuickAction.Compact) {
                // Get the compaction request input
                const compactionRequestInput = this.#getCompactionRequestInput(session)
                // Generate a unique ID for this prompt
                const promptId = crypto.randomUUID()
                session.setCurrentPromptId(promptId)

                // Start the compaction call
                finalResult = await this.#runCompaction(
                    compactionRequestInput,
                    session,
                    metric,
                    chatResultStream,
                    params.tabId,
                    promptId,
                    CompactHistoryActionType.Manual,
                    session.conversationId,
                    token,
                    triggerContext.documentReference
                )
            } else {
                // Get the initial request input
                const initialRequestInput = await this.#prepareRequestInput(
                    params,
                    session,
                    triggerContext,
                    additionalContext,
                    chatResultStream,
                    customContext
                )

                // Generate a unique ID for this prompt
                const promptId = crypto.randomUUID()
                session.setCurrentPromptId(promptId)

                // Start the agent loop
                finalResult = await this.#runAgentLoop(
                    initialRequestInput,
                    session,
                    metric,
                    chatResultStream,
                    params.tabId,
                    promptId,
                    session.conversationId,
                    token,
                    triggerContext.documentReference,
                    additionalContext
                )
            }

            // Result Handling - This happens only once
            return await this.#handleFinalResult(
                finalResult,
                session,
                params.tabId,
                metric,
                triggerContext,
                isNewConversation,
                chatResultStream,
                requestModelId
            )
        } catch (err) {
            // HACK: the chat-client needs to have a partial event with the associated messageId sent before it can accept the final result.
            // Without this, the `working` indicator never goes away.
            // Note: buttons being explicitly empty is required for this hack to work.
            const errorMessageId = `error-message-id-${uuid()}`
            await this.#sendProgressToClient(
                {
                    type: 'answer',
                    body: '',
                    messageId: errorMessageId,
                    buttons: [],
                },
                params.partialResultToken
            )
            if (this.isUserAction(err, token)) {
                /**
                 * when the session is aborted it generates an error.
                 * we need to resolve this error with an answer so the
                 * stream stops
                 */
                return {
                    type: 'answer',
                    body: '',
                    messageId: errorMessageId,
                    buttons: [],
                }
            }
            return this.#handleRequestError(
                session.conversationId,
                err,
                errorMessageId,
                params.tabId,
                metric,
                session.pairProgrammingMode,
                requestModelId
            )
        }
    }

    /**
     * Prepares the initial request input for the chat prompt
     */
    async #prepareRequestInput(
        params: ChatParams,
        session: ChatSessionService,
        triggerContext: TriggerContext,
        additionalContext: AdditionalContentEntryAddition[],
        chatResultStream: AgenticChatResultStream,
        images: ImageBlock[]
    ): Promise<ChatCommandInput> {
        this.#debug('Preparing request input')
        // Get profileArn from the service manager if available
        const profileArn = this.#serviceManager?.getActiveProfileArn()
        const requestInput = await this.#triggerContext.getChatParamsFromTrigger(
            params,
            triggerContext,
            ChatTriggerType.MANUAL,
            this.#customizationArn,
            chatResultStream,
            profileArn,
            this.#getTools(session),
            additionalContext,
            session.modelId,
            this.#origin,
            images,
            session.conversationId
        )
        return requestInput
    }

    /**
     * Prepares the initial request input for the chat prompt
     */
    #getCompactionRequestInput(session: ChatSessionService): ChatCommandInput {
        this.#debug('Preparing compaction request input')
        // Get profileArn from the service manager if available
        const profileArn = this.#serviceManager?.getActiveProfileArn()
        const requestInput = this.#triggerContext.getCompactionChatCommandInput(
            profileArn,
            this.#getTools(session),
            session.modelId,
            this.#origin,
            session.conversationId
        )
        return requestInput
    }

    /**
     * Runs the compaction, making requests and processing tool uses until completion
     */
    #shouldCompact(currentRequestCount: number, compactionThreshold: number): boolean {
        if (currentRequestCount > compactionThreshold) {
            this.#debug(`Current request total character count is: ${currentRequestCount}, prompting user to compact`)
            return true
        } else {
            return false
        }
    }

    /**
     * Runs the compaction to compact history into a single summary
     */
    async #runCompaction(
        compactionRequestInput: ChatCommandInput,
        session: ChatSessionService,
        metric: Metric<CombinedConversationEvent>,
        chatResultStream: AgenticChatResultStream,
        tabId: string,
        promptId: string,
        type: CompactHistoryActionType,
        conversationIdentifier?: string,
        token?: CancellationToken,
        documentReference?: FileList
    ): Promise<Result<AgenticChatResultWithMetadata, string>> {
        let currentRequestInput = { ...compactionRequestInput }
        let finalResult: Result<AgenticChatResultWithMetadata, string> | null = null
        metric.recordStart()

        this.#debug(`Running compaction for conversation id:`, conversationIdentifier || '')

        this.#timeToFirstChunk = -1
        this.#timeBetweenChunks = []

        // Check for cancellation
        if (this.#isPromptCanceled(token, session, promptId)) {
            this.#debug('Stopping compaction loop - cancelled by user')
            throw new CancellationError('user')
        }

        const currentMessage = currentRequestInput.conversationState?.currentMessage
        let messages: DbMessage[] = []
        let characterCount = 0
        if (currentMessage) {
            //  Get and process the messages from history DB to maintain invariants for service requests
            try {
                const { history: historyMessages, historyCount: historyCharCount } =
                    this.#chatHistoryDb.fixAndGetHistory(tabId, currentMessage, [])
                messages = historyMessages
                characterCount = historyCharCount
            } catch (err) {
                if (err instanceof ToolResultValidationError) {
                    this.#features.logging.error(`Tool validation error: ${err.message}`)
                    return (
                        finalResult || {
                            success: false,
                            error: 'Compaction loop failed to produce a final result',
                            data: { chatResult: {}, toolUses: {} },
                        }
                    )
                }
            }
        }

        currentRequestInput.conversationState!.history = messages.map(msg => messageToStreamingMessage(msg))

        const resultStreamWriter = chatResultStream.getResultStreamWriter()

        if (currentRequestInput.conversationState!.history.length == 0) {
            // early terminate
            await resultStreamWriter.write({
                type: 'answer',
                body: 'History is empty, there is nothing to compact.',
                messageId: uuid(),
            })
            return {
                success: true,
                data: {
                    chatResult: {},
                    toolUses: {},
                },
            }
        } else {
            await resultStreamWriter.write({
                type: 'answer',
                body: 'Compacting your chat history, this may take a moment.',
                messageId: uuid(),
            })
        }
        await resultStreamWriter.close()

        session.setConversationType('AgenticChatWithCompaction')
        const conversationType = session.getConversationType() as ChatConversationType
        metric.setDimension('cwsprChatConversationType', conversationType)
        this.#telemetryController.emitCompactHistory(
            type,
            characterCount,
            this.#features.runtime.serverInfo.version ?? ''
        )

        // Add loading message before making the request
        const loadingMessageId = `loading-${uuid()}`
        await chatResultStream.writeResultBlock({ ...loadingMessage, messageId: loadingMessageId })

        this.#debug(`Compacting history with ${characterCount} characters`)
        this.#llmRequestStartTime = Date.now()
        // Phase 3: Request Execution
        currentRequestInput = sanitizeRequestInput(currentRequestInput)
        this.#debug(`Compaction Request: ${JSON.stringify(currentRequestInput, undefined, 2)}`)
        const response = await session.getChatResponse(currentRequestInput)
        if (response.$metadata.requestId) {
            metric.mergeWith({
                requestIds: [response.$metadata.requestId],
            })
        }
        this.#features.logging.info(`Compaction ResponseMetadata: ${loggingUtils.formatObj(response.$metadata)}`)
        await chatResultStream.removeResultBlock(loadingMessageId)

        // Phase 4: Response Processing
        const result = await this.#processAgenticChatResponseWithTimeout(
            response,
            metric.mergeWith({
                cwsprChatResponseCode: response.$metadata.httpStatusCode,
                cwsprChatMessageId: response.$metadata.requestId,
            }),
            chatResultStream,
            session,
            documentReference,
            true
        )

        const llmLatency = Date.now() - this.#llmRequestStartTime
        this.#debug(`LLM Response Latency for compaction: ${llmLatency}`)
        this.#telemetryController.emitAgencticLoop_InvokeLLM(
            response.$metadata.requestId!,
            conversationIdentifier ?? '',
            'AgenticChatWithCompaction',
            undefined,
            undefined,
            'Succeeded',
            this.#features.runtime.serverInfo.version ?? '',
            session.modelId,
            llmLatency,
            [],
            this.#timeToFirstChunk,
            this.#timeBetweenChunks,
            session.pairProgrammingMode
        )

        // replace the history with summary in history DB
        if (result.data?.chatResult.body !== undefined) {
            this.#chatHistoryDb.replaceWithSummary(tabId, 'cwc', conversationIdentifier ?? '', {
                body: result.data?.chatResult.body,
                type: 'prompt' as ChatMessage['type'],
                shouldDisplayMessage: true,
                timestamp: new Date(),
            })
        } else {
            this.#features.logging.warn('No ChatResult body in response, skipping adding to history')
        }

        return result
    }

    /**
     * Runs the agent loop, making requests and processing tool uses until completion
     */
    async #runAgentLoop(
        initialRequestInput: ChatCommandInput,
        session: ChatSessionService,
        metric: Metric<CombinedConversationEvent>,
        chatResultStream: AgenticChatResultStream,
        tabId: string,
        promptId: string,
        conversationIdentifier?: string,
        token?: CancellationToken,
        documentReference?: FileList,
        additionalContext?: AdditionalContentEntryAddition[]
    ): Promise<Result<AgenticChatResultWithMetadata, string>> {
        let currentRequestInput = { ...initialRequestInput }
        let finalResult: Result<AgenticChatResultWithMetadata, string> | null = null
        let iterationCount = 0
        let shouldDisplayMessage = true
        let currentRequestCount = 0
        // Number of consecutive responses that produced an incomplete tool-use input. Bounded
        // so a model that keeps truncating cannot keep the agent loop running indefinitely.
        let consecutiveIncompleteToolUses = 0
        const pinnedContext = additionalContext?.filter(item => item.pinned)

        metric.recordStart()
        this.logSystemInformation()
        while (true) {
            iterationCount++
            this.#debug(`Agent loop iteration ${iterationCount} for conversation id:`, conversationIdentifier || '')

            this.#toolCallLatencies = []
            this.#timeToFirstChunk = -1
            this.#timeBetweenChunks = []

            // Check for cancellation
            if (this.#isPromptCanceled(token, session, promptId)) {
                this.#debug('Stopping agent loop - cancelled by user')
                throw new CancellationError('user')
            }

            this.truncateRequest(currentRequestInput, additionalContext, session.tokenLimits.inputLimit)
            const currentMessage = currentRequestInput.conversationState?.currentMessage
            const conversationId = conversationIdentifier ?? ''
            if (!currentMessage || !conversationId) {
                this.#debug(
                    `Warning: ${!currentMessage ? 'currentMessage' : ''}${!currentMessage && !conversationId ? ' and ' : ''}${!conversationId ? 'conversationIdentifier' : ''} is empty in agent loop iteration ${iterationCount}.`
                )
            }
            let messages: DbMessage[] = []
            // Prepend pinned context to history as a fake message pair
            // This ensures pinned context doesn't get added to history file, and fulfills API contract requiring message pairs.
            let pinnedContextMessages = await this.#additionalContextProvider.convertPinnedContextToChatMessages(
                pinnedContext,
                this.#features.workspace.getWorkspaceFolder
            )

            if (currentMessage) {
                //  Get and process the messages from history DB to maintain invariants for service requests
                try {
                    const {
                        history: historyMessages,
                        historyCount: historyCharacterCount,
                        currentCount: currentInputCount,
                    } = this.#chatHistoryDb.fixAndGetHistory(tabId, currentMessage, pinnedContextMessages)
                    messages = historyMessages
                    currentRequestCount = currentInputCount + historyCharacterCount
                    this.#debug(`Request total character count: ${currentRequestCount}`)
                } catch (err) {
                    if (err instanceof ToolResultValidationError) {
                        this.#features.logging.warn(`Tool validation error: ${err.message}`)
                        break
                    }
                }
            }

            // Do not include chatHistory for requests going to Mynah Backend
            currentRequestInput.conversationState!.history = currentRequestInput.conversationState?.currentMessage
                ?.userInputMessage?.userIntent
                ? []
                : messages.map(msg => messageToStreamingMessage(msg))

            // Add loading message before making the request
            const loadingMessageId = `loading-${uuid()}`
            await chatResultStream.writeResultBlock({ ...loadingMessage, messageId: loadingMessageId })

            this.#llmRequestStartTime = Date.now()
            // Phase 3: Request Execution
            currentRequestInput = sanitizeRequestInput(currentRequestInput)
            // Note: these logs are very noisy, but contain information redacted on the backend.
            this.#debug(
                `generateAssistantResponse/SendMessage Request: ${JSON.stringify(currentRequestInput, this.#imageReplacer, 2)}`
            )
            const response = await session.getChatResponse(currentRequestInput)
            if (response.$metadata.requestId) {
                metric.mergeWith({
                    requestIds: [response.$metadata.requestId],
                })
            }
            this.#features.logging.info(
                `generateAssistantResponse/SendMessage ResponseMetadata: ${loggingUtils.formatObj(response.$metadata)}`
            )
            await chatResultStream.removeResultBlock(loadingMessageId)

            // Add the current user message to the history DB
            if (currentMessage && conversationIdentifier) {
                if (this.#isPromptCanceled(token, session, promptId)) {
                    // Only skip adding message to history, continue executing to avoid unexpected stop for the conversation
                    this.#debug('Skipping adding user message to history - cancelled by user')
                } else {
                    this.#chatHistoryDb.addMessage(tabId, 'cwc', conversationIdentifier, {
                        body: currentMessage.userInputMessage?.content ?? '',
                        type: 'prompt' as ChatMessage['type'],
                        userIntent: currentMessage.userInputMessage?.userIntent,
                        origin: currentMessage.userInputMessage?.origin,
                        userInputMessageContext: currentMessage.userInputMessage?.userInputMessageContext,
                        shouldDisplayMessage:
                            shouldDisplayMessage &&
                            !currentMessage.userInputMessage?.content?.startsWith('You are Amazon Q'),
                        timestamp: new Date(),
                        images: currentMessage.userInputMessage?.images,
                    })
                }
            }
            shouldDisplayMessage = true
            // Phase 4: Response Processing
            const result = await this.#processAgenticChatResponseWithTimeout(
                response,
                metric.mergeWith({
                    cwsprChatResponseCode: response.$metadata.httpStatusCode,
                    cwsprChatMessageId: response.$metadata.requestId,
                }),
                chatResultStream,
                session,
                documentReference
            )
            const llmLatency = Date.now() - this.#llmRequestStartTime
            this.#debug(`LLM Response Latency: ${llmLatency}`)
            // This is needed to handle the case where the response stream times out
            // and we want to auto-retry
            if (!result.success && result.error.startsWith(RESPONSE_TIMEOUT_PARTIAL_MSG)) {
                const content =
                    'You took too long to respond - try to split up the work into smaller steps. Do not apologize.'
                if (this.#isPromptCanceled(token, session, promptId)) {
                    // Only skip adding message to the history DB, continue executing to avoid unexpected stop for the conversation
                    this.#debug('Skipping adding messages to history - cancelled by user')
                } else {
                    this.#chatHistoryDb.addMessage(tabId, 'cwc', conversationIdentifier ?? '', {
                        body: 'Response timed out - message took too long to generate',
                        type: 'answer',
                        shouldDisplayMessage: false,
                        timestamp: new Date(),
                    })
                }
                currentRequestInput = this.#updateRequestInputWithToolResults(currentRequestInput, [], content)
                shouldDisplayMessage = false
                // set the in progress tool use UI status to Error
                await chatResultStream.updateOngoingProgressResult('Error')

                // emit invokeLLM event with status Failed for timeout calls
                this.#telemetryController.emitAgencticLoop_InvokeLLM(
                    response.$metadata.requestId!,
                    conversationId,
                    'AgenticChat',
                    undefined,
                    undefined,
                    'Failed',
                    this.#features.runtime.serverInfo.version ?? '',
                    session.modelId,
                    llmLatency,
                    this.#toolCallLatencies,
                    this.#timeToFirstChunk,
                    this.#timeBetweenChunks,
                    session.pairProgrammingMode,
                    this.#abTestingAllocation?.experimentName,
                    this.#abTestingAllocation?.userVariation
                )
                continue
            }

            // Add the current assistantResponse message to the history DB
            if (result.data?.chatResult.body !== undefined) {
                if (this.#isPromptCanceled(token, session, promptId)) {
                    // Only skip adding message to the history DB, continue executing to avoid unexpected stop for the conversation
                    this.#debug('Skipping adding messages to history - cancelled by user')
                } else {
                    this.#chatHistoryDb.addMessage(tabId, 'cwc', conversationIdentifier ?? '', {
                        body: result.data?.chatResult.body,
                        type: 'answer' as ChatMessage['type'],
                        codeReference: result.data.chatResult.codeReference,
                        relatedContent:
                            result.data.chatResult.relatedContent?.content &&
                            result.data.chatResult.relatedContent.content.length > 0
                                ? result.data?.chatResult.relatedContent
                                : undefined,
                        toolUses: Object.keys(result.data?.toolUses!)
                            .filter(k => result.data!.toolUses[k].stop)
                            .map(k => ({
                                toolUseId: result.data!.toolUses[k].toolUseId,
                                name: result.data!.toolUses[k].name,
                                input: result.data!.toolUses[k].input,
                            })),
                        shouldDisplayMessage: shouldDisplayMessage,
                        timestamp: new Date(),
                    })
                }
            } else {
                this.#features.logging.warn('No ChatResult body in response, skipping adding to history')
            }

            // Check if we have any tool uses that need to be processed
            const pendingToolUses = this.#getPendingToolUses(result.data?.toolUses || {})

            if (pendingToolUses.length === 0) {
                this.recordChunk('agent_loop_done')
                // No more tool uses, we're done
                this.#telemetryController.emitAgencticLoop_InvokeLLM(
                    response.$metadata.requestId!,
                    conversationId,
                    'AgenticChat',
                    undefined,
                    undefined,
                    result.success ? 'Succeeded' : 'Failed',
                    this.#features.runtime.serverInfo.version ?? '',
                    session.modelId,
                    llmLatency,
                    this.#toolCallLatencies,
                    this.#timeToFirstChunk,
                    this.#timeBetweenChunks,
                    session.pairProgrammingMode,
                    this.#abTestingAllocation?.experimentName,
                    this.#abTestingAllocation?.userVariation
                )
                finalResult = result
                break
            }

            let content = ''
            let toolResults: ToolResult[]
            session.setConversationType('AgenticChatWithToolUse')
            if (result.success) {
                // A complete tool use was received, so the incomplete-input streak is over.
                consecutiveIncompleteToolUses = 0
                // Process tool uses and update the request input for the next iteration
                toolResults = await this.processToolUses(
                    pendingToolUses,
                    chatResultStream,
                    session,
                    tabId,
                    token,
                    additionalContext
                )
                if (toolResults.some(toolResult => this.#shouldSendBackErrorContent(toolResult))) {
                    content = 'There was an error processing one or more tool uses. Try again, do not apologize.'
                    shouldDisplayMessage = false
                }
                const toolCallLatency = Date.now() - this.#toolStartTime
                this.#toolCallLatencies.push(toolCallLatency)
                const conversationType = session.getConversationType() as ChatConversationType
                metric.setDimension('cwsprChatConversationType', conversationType)
                metric.setDimension('requestIds', metric.metric.requestIds)
                const toolNames = this.#toolUseLatencies.map(item => item.toolName)
                const toolUseIds = this.#toolUseLatencies.map(item => item.toolUseId)
                this.#telemetryController.emitAgencticLoop_InvokeLLM(
                    response.$metadata.requestId!,
                    conversationId,
                    'AgenticChatWithToolUse',
                    toolNames ?? undefined,
                    toolUseIds ?? undefined,
                    'Succeeded',
                    this.#features.runtime.serverInfo.version ?? '',
                    session.modelId,
                    llmLatency,
                    this.#toolCallLatencies,
                    this.#timeToFirstChunk,
                    this.#timeBetweenChunks,
                    session.pairProgrammingMode,
                    this.#abTestingAllocation?.experimentName,
                    this.#abTestingAllocation?.userVariation
                )
            } else {
                // Send an error card to UI?
                toolResults = pendingToolUses.map(toolUse => ({
                    toolUseId: toolUse.toolUseId,
                    status: ToolResultStatus.ERROR,
                    content: [{ text: result.error }],
                }))
                // Classify the failure *before* emitting telemetry. An incomplete tool-use input is
                // retried inside this loop and usually recovers within the same user turn, so it is
                // not a user-visible failure and should not depress a per-call success rate. Because
                // the retry budget is bounded we already know here whether this iteration will be
                // retried, which lets us distinguish the transient case from the terminal give-up.
                const isIncompleteToolUse = result.error.startsWith('ToolUse input is invalid JSON:')
                let willRetryIncompleteToolUse = false
                let invokeLlmReason: string | undefined
                if (isIncompleteToolUse) {
                    consecutiveIncompleteToolUses++
                    willRetryIncompleteToolUse = consecutiveIncompleteToolUses <= MAX_INCOMPLETE_TOOL_USE_RETRIES
                    invokeLlmReason = willRetryIncompleteToolUse
                        ? INVOKE_LLM_REASON_INCOMPLETE_TOOL_USE_RETRYING
                        : INVOKE_LLM_REASON_INCOMPLETE_TOOL_USE_EXHAUSTED
                }
                this.#telemetryController.emitAgencticLoop_InvokeLLM(
                    response.$metadata.requestId!,
                    conversationId,
                    'AgenticChatWithToolUse',
                    undefined,
                    undefined,
                    'Failed',
                    this.#features.runtime.serverInfo.version ?? '',
                    session.modelId,
                    llmLatency,
                    this.#toolCallLatencies,
                    this.#timeToFirstChunk,
                    this.#timeBetweenChunks,
                    session.pairProgrammingMode,
                    this.#abTestingAllocation?.experimentName,
                    this.#abTestingAllocation?.userVariation,
                    invokeLlmReason
                )
                if (isIncompleteToolUse) {
                    if (!willRetryIncompleteToolUse) {
                        // The model has failed to produce a complete tool request several times
                        // in a row. Retrying again is unlikely to help and would keep the agent
                        // loop running, so stop and surface a real error to the user instead.
                        this.#features.logging.error(
                            `Giving up after ${consecutiveIncompleteToolUses} consecutive incomplete tool uses: ${result.error}`
                        )
                        await chatResultStream.updateOngoingProgressResult('Error')
                        finalResult = {
                            success: false,
                            error: INCOMPLETE_TOOL_USE_RETRY_LIMIT_MSG,
                            data: result.data,
                        }
                        break
                    }
                    content =
                        'Your toolUse input is incomplete, try again. If the error happens consistently, break this task down into multiple tool uses with smaller input. Do not apologize.'
                    shouldDisplayMessage = false
                }
                // set the in progress tool use UI status to Error
                await chatResultStream.updateOngoingProgressResult('Error')
            }
            if (result.success && this.#toolUseLatencies.length > 0) {
                // Clear latencies for the next LLM call
                this.#toolUseLatencies = []
            }
            currentRequestInput = this.#updateRequestInputWithToolResults(currentRequestInput, toolResults, content)
        }

        if (this.#shouldCompact(currentRequestCount, session.tokenLimits.compactionThreshold)) {
            this.#telemetryController.emitCompactNudge(
                currentRequestCount,
                this.#features.runtime.serverInfo.version ?? ''
            )
            const messageId = this.#getMessageIdForCompact(uuid())
            const confirmationResult = this.#processCompactConfirmation(
                messageId,
                currentRequestCount,
                session.tokenLimits.maxOverallCharacters
            )
            const cachedButtonBlockId = await chatResultStream.writeResultBlock(confirmationResult)
            await this.waitForCompactApproval(messageId, chatResultStream, cachedButtonBlockId, session)
            // Get the compaction request input
            const compactionRequestInput = this.#getCompactionRequestInput(session)
            // Start the compaction call
            return await this.#runCompaction(
                compactionRequestInput,
                session,
                metric,
                chatResultStream,
                tabId,
                promptId,
                CompactHistoryActionType.Nudge,
                session.conversationId,
                token,
                documentReference
            )
        }

        return (
            finalResult || {
                success: false,
                error: 'Agent loop failed to produce a final result',
                data: { chatResult: {}, toolUses: {} },
            }
        )
    }

    truncatePinnedContext(remainingCharacterBudget: number, pinnedContext?: AdditionalContentEntryAddition[]): number {
        if (!pinnedContext) {
            return remainingCharacterBudget
        }

        for (const [i, pinnedContextEntry] of pinnedContext.entries()) {
            const pinnedContextEntryLength = pinnedContextEntry.innerContext?.length || 0
            if (remainingCharacterBudget >= pinnedContextEntryLength) {
                remainingCharacterBudget -= pinnedContextEntryLength
            } else {
                // Budget exceeded, truncate the array at this point
                pinnedContext.splice(i)
                remainingCharacterBudget = 0
                break
            }
        }

        return remainingCharacterBudget
    }

    /**
     * performs truncation of request before sending to backend service.
     * Returns the remaining character budget for chat history.
     * @param request
     * @param additionalContext
     * @param inputLimit - The dynamic input limit from the session's token limits
     */
    truncateRequest(
        request: ChatCommandInput,
        additionalContext?: AdditionalContentEntryAddition[],
        inputLimit?: number
    ): number {
        // Use dynamic inputLimit from session, or fall back to default calculated value
        const effectiveInputLimit = inputLimit ?? TokenLimitsCalculator.calculate().inputLimit
        let remainingCharacterBudget = effectiveInputLimit
        if (!request?.conversationState?.currentMessage?.userInputMessage) {
            return remainingCharacterBudget
        }
        const message = request.conversationState?.currentMessage?.userInputMessage?.content

        // 1. prioritize user input message
        let truncatedUserInputMessage = ''
        if (message) {
            if (message.length > effectiveInputLimit) {
                this.#debug(`Truncating userInputMessage to ${effectiveInputLimit} characters}`)
                truncatedUserInputMessage = message.substring(0, effectiveInputLimit)
                remainingCharacterBudget = remainingCharacterBudget - truncatedUserInputMessage.length
                request.conversationState.currentMessage.userInputMessage.content = truncatedUserInputMessage
            } else {
                remainingCharacterBudget = remainingCharacterBudget - message.length
            }
        }

        // 2. try to fit @context and images into budget together
        const docs =
            request.conversationState.currentMessage.userInputMessage.userInputMessageContext?.editorState
                ?.relevantDocuments ?? []
        const images = request.conversationState.currentMessage.userInputMessage.images ?? []

        // Combine docs and images, preserving the order from additionalContext
        let combined
        if (additionalContext && additionalContext.length > 0) {
            let docIdx = 0
            let imageIdx = 0
            combined = additionalContext
                .map(entry => {
                    if (entry.type === 'image') {
                        return { type: 'image', value: images[imageIdx++] }
                    } else {
                        return { type: 'doc', value: docs[docIdx++] }
                    }
                })
                .filter(item => item.value !== undefined)
        } else {
            combined = [
                ...docs.map(d => ({ type: 'doc', value: d })),
                ...images.map(i => ({ type: 'image', value: i })),
            ]
        }

        const truncatedDocs: typeof docs = []
        const truncatedImages: typeof images = []
        for (const item of combined) {
            let itemLength = 0
            if (item.type === 'doc') {
                itemLength = (item.value as any)?.text?.length || 0
                if (remainingCharacterBudget >= itemLength) {
                    truncatedDocs.push(item.value as (typeof docs)[number])
                    remainingCharacterBudget -= itemLength
                }
            } else if (item.type === 'image') {
                // Type guard: only call on ImageBlock
                if (item.value && typeof item.value === 'object' && 'format' in item.value && 'source' in item.value) {
                    itemLength = estimateCharacterCountFromImageBlock(item.value)
                    if (remainingCharacterBudget >= itemLength) {
                        truncatedImages.push(item.value as (typeof images)[number])
                        remainingCharacterBudget -= itemLength
                    }
                }
            }
        }

        // Assign truncated lists back to request
        if (
            request.conversationState.currentMessage.userInputMessage.userInputMessageContext?.editorState
                ?.relevantDocuments
        ) {
            request.conversationState.currentMessage.userInputMessage.userInputMessageContext.editorState.relevantDocuments =
                truncatedDocs
        }

        if (
            request.conversationState.currentMessage.userInputMessage.images !== undefined &&
            request.conversationState.currentMessage.userInputMessage.images.length > 0
        ) {
            request.conversationState.currentMessage.userInputMessage.images = truncatedImages
        }

        // 3. try to fit current file context
        let truncatedCurrentDocument = undefined
        if (request.conversationState.currentMessage.userInputMessage.userInputMessageContext?.editorState?.document) {
            const docLength =
                request.conversationState.currentMessage.userInputMessage.userInputMessageContext?.editorState?.document
                    .text?.length || 0
            if (remainingCharacterBudget > docLength) {
                truncatedCurrentDocument =
                    request.conversationState.currentMessage.userInputMessage.userInputMessageContext?.editorState
                        ?.document
                remainingCharacterBudget = remainingCharacterBudget - docLength
            }
            request.conversationState.currentMessage.userInputMessage.userInputMessageContext.editorState.document =
                truncatedCurrentDocument
        }

        const pinnedContext = additionalContext?.filter(item => item.pinned)

        // 4. try to fit pinned context into budget
        if (pinnedContext && pinnedContext.length > 0) {
            remainingCharacterBudget = this.truncatePinnedContext(remainingCharacterBudget, pinnedContext)
        }
        return remainingCharacterBudget
    }

    /**
     * Extracts tool uses that need to be processed
     */
    #getPendingToolUses(toolUses: Record<string, ToolUse & { stop: boolean }>): Array<ToolUse & { stop: boolean }> {
        return Object.values(toolUses).filter(toolUse => toolUse.stop)
    }

    /**
     * Creates a promise that does not resolve until the user accepts or rejects the tool usage.
     * @param toolUseId
     * @param toolUseName
     * @param resultStream
     * @param promptBlockId id of approval block. This allows us to overwrite the buttons with 'accepted' or 'rejected' text.
     * @param session
     */
    async waitForToolApproval(
        toolUse: ToolUse,
        resultStream: AgenticChatResultStream,
        promptBlockId: number,
        session: ChatSessionService,
        toolName: string
    ) {
        const deferred = this.#createDeferred()
        session.setDeferredToolExecution(toolUse.toolUseId!, deferred.resolve, deferred.reject)
        this.#log(`Prompting for tool approval for tool: ${toolName ?? toolUse.name}`)
        await deferred.promise
        // Note: we want to overwrite the button block because it already exists in the stream.
        await resultStream.overwriteResultBlock(
            this.#getUpdateToolConfirmResult(toolUse, true, toolName),
            promptBlockId
        )
    }

    /**
     * Processes tool uses by running the tools and collecting results
     */
    async processToolUses(
        toolUses: Array<ToolUse & { stop: boolean }>,
        chatResultStream: AgenticChatResultStream,
        session: ChatSessionService,
        tabId: string,
        token?: CancellationToken,
        additionalContext?: AdditionalContentEntryAddition[]
    ): Promise<ToolResult[]> {
        const results: ToolResult[] = []

        for (const toolUse of toolUses) {
            // Store buttonBlockId to use it in `catch` block if needed
            let cachedButtonBlockId
            if (!toolUse.name || !toolUse.toolUseId) continue
            session.toolUseLookup.set(toolUse.toolUseId, toolUse)

            // Record the start time for this tool use for latency calculation
            if (toolUse.toolUseId) {
                this.#toolUseStartTimes[toolUse.toolUseId] = Date.now()
            }

            try {
                // TODO: Can we move this check in the event parser before the stream completes?
                const availableToolNames = this.#getTools(session).map(tool => tool.toolSpecification.name)
                if (!availableToolNames.includes(toolUse.name)) {
                    throw new Error(`Tool ${toolUse.name} is not available in the current mode`)
                }

                this.recordChunk(`tool_execution_start - ${toolUse.name}`)
                this.#toolStartTime = Date.now()

                // remove progress UI
                await chatResultStream.removeResultBlockAndUpdateUI(progressPrefix + toolUse.toolUseId)

                if (![FS_WRITE, FS_REPLACE].includes(toolUse.name)) {
                    await this.#showUndoAllIfRequired(chatResultStream, session)
                }
                // fsWrite can take a long time, so we render fsWrite  Explanatory upon partial streaming responses.
                if (toolUse.name !== FS_WRITE && toolUse.name !== FS_REPLACE) {
                    const { explanation } = toolUse.input as unknown as ExplanatoryParams
                    if (explanation) {
                        await chatResultStream.writeResultBlock({
                            type: 'directive',
                            messageId: toolUse.toolUseId + SUFFIX_EXPLANATION,
                            body: explanation,
                        })
                    }
                }
                switch (toolUse.name) {
                    case FS_READ:
                    case LIST_DIRECTORY:
                    case GREP_SEARCH:
                    case FILE_SEARCH:
                    case FS_WRITE:
                    case FS_REPLACE:
                    case EXECUTE_BASH: {
                        const toolMap = {
                            [FS_READ]: { Tool: FsRead },
                            [LIST_DIRECTORY]: { Tool: ListDirectory },
                            [FS_WRITE]: { Tool: FsWrite },
                            [FS_REPLACE]: { Tool: FsReplace },
                            [EXECUTE_BASH]: { Tool: ExecuteBash },
                            [GREP_SEARCH]: { Tool: GrepSearch },
                            [FILE_SEARCH]: { Tool: FileSearch },
                        }

                        const { Tool } = toolMap[toolUse.name as keyof typeof toolMap]
                        const tool =
                            toolUse.name === FS_READ && session.isMemoryBankGeneration
                                ? new Tool(
                                      this.#features,
                                      FSREAD_MEMORY_BANK_MAX_PER_FILE,
                                      FSREAD_MEMORY_BANK_MAX_TOTAL
                                  )
                                : new Tool(this.#features)

                        // For MCP tools, get the permission from McpManager
                        // const permission = McpManager.instance.getToolPerm('Built-in', toolUse.name)
                        // If permission is 'alwaysAllow', we don't need to ask for acceptance
                        // const builtInPermission = permission !== 'alwaysAllow'

                        // Get the approved paths from the session
                        const approvedPaths = session.approvedPaths

                        // Pass the approved paths to the tool's requiresAcceptance method
                        const { requiresAcceptance, warning, commandCategory } = await tool.requiresAcceptance(
                            toolUse.input as any,
                            approvedPaths
                        )

                        // Honor built-in permission if available, otherwise use tool's requiresAcceptance
                        // const requiresAcceptance = builtInPermission || toolRequiresAcceptance

                        if (requiresAcceptance || toolUse.name === EXECUTE_BASH) {
                            // for executeBash, we till send the confirmation message without action buttons
                            const confirmationResult = this.#processToolConfirmation(
                                toolUse,
                                requiresAcceptance,
                                warning,
                                commandCategory
                            )
                            cachedButtonBlockId = await chatResultStream.writeResultBlock(confirmationResult)
                            const isExecuteBash = toolUse.name === EXECUTE_BASH
                            if (isExecuteBash) {
                                this.#telemetryController.emitInteractWithAgenticChat(
                                    'GeneratedCommand',
                                    tabId,
                                    session.pairProgrammingMode,
                                    session.getConversationType(),
                                    this.#abTestingAllocation?.experimentName,
                                    this.#abTestingAllocation?.userVariation
                                )
                            }
                            if (requiresAcceptance) {
                                await this.waitForToolApproval(
                                    toolUse,
                                    chatResultStream,
                                    cachedButtonBlockId,
                                    session,
                                    toolUse.name
                                )
                            }
                            if (isExecuteBash) {
                                this.#telemetryController.emitInteractWithAgenticChat(
                                    'RunCommand',
                                    tabId,
                                    session.pairProgrammingMode,
                                    session.getConversationType(),
                                    this.#abTestingAllocation?.experimentName,
                                    this.#abTestingAllocation?.userVariation
                                )
                            }
                        }
                        break
                    }
                    case CodeReview.toolName:
                    case DisplayFindings.toolName:
                    // no need to write tool message for CodeReview or DisplayFindings
                    case SemanticSearch.toolName:
                        // For internal A/B we don't need tool message
                        break
                    // — DEFAULT ⇒ Only MCP tools, but can also handle generic tool execution messages
                    default:
                        // Get original server and tool names from the mapping
                        let originalNames
                        try {
                            originalNames = McpManager.instance.getOriginalToolNames(toolUse.name)
                        } catch (error) {
                            // McpManager not initialized, skip MCP tool handling
                            this.#features.logging.debug(
                                `McpManager not initialized, skipping MCP tool handling with error: ${error}`
                            )
                            originalNames = undefined
                        }

                        // Remove explanation field from toolUse.input for MCP tools
                        // many MCP servers do not support explanation field and it will break the tool if this is altered
                        if (
                            originalNames &&
                            toolUse.input &&
                            typeof toolUse.input === 'object' &&
                            'explanation' in toolUse.input
                        ) {
                            const { explanation, ...inputWithoutExplanation } = toolUse.input as any
                            toolUse.input = inputWithoutExplanation
                        }

                        if (originalNames) {
                            const { serverName, toolName } = originalNames
                            let def
                            try {
                                def = McpManager.instance
                                    .getAllTools()
                                    .find(d => d.serverName === serverName && d.toolName === toolName)
                            } catch (error) {
                                this.#features.logging.debug(
                                    `McpManager not initialized, cannot get tool definitions with error: ${error}`
                                )
                                def = undefined
                            }
                            if (def) {
                                const mcpTool = new McpTool(this.#features, def)
                                const { requiresAcceptance, warning } = await mcpTool.requiresAcceptance(
                                    serverName,
                                    toolName
                                )
                                if (requiresAcceptance) {
                                    const confirmation = this.#processToolConfirmation(
                                        toolUse,
                                        requiresAcceptance,
                                        warning,
                                        undefined,
                                        toolName // Pass the original tool name here
                                    )
                                    cachedButtonBlockId = await chatResultStream.writeResultBlock(confirmation)
                                    await this.waitForToolApproval(
                                        toolUse,
                                        chatResultStream,
                                        cachedButtonBlockId,
                                        session,
                                        toolName
                                    )
                                }

                                // Store the blockId in the session for later use
                                if (toolUse.toolUseId) {
                                    // Use a type assertion to add the runningCardBlockId property
                                    const toolUseWithBlockId = {
                                        ...toolUse,
                                        cachedButtonBlockId,
                                    } as typeof toolUse & { cachedButtonBlockId: number }

                                    session.toolUseLookup.set(toolUse.toolUseId, toolUseWithBlockId)
                                }
                                break
                            }
                        }
                        break
                }

                if (toolUse.name === FS_WRITE || toolUse.name === FS_REPLACE) {
                    const input = toolUse.input as unknown as FsWriteParams | FsReplaceParams
                    const document = await this.#triggerContext.getTextDocumentFromPath(input.path, true, true)

                    session.toolUseLookup.set(toolUse.toolUseId, {
                        ...toolUse,
                        fileChange: { before: document?.getText() },
                    })
                }

                if (toolUse.name === CodeReview.toolName) {
                    try {
                        let initialInput = JSON.parse(JSON.stringify(toolUse.input))

                        if (additionalContext !== undefined) {
                            initialInput['ruleArtifacts'] = additionalContext
                                .filter(c => c.type === 'rule')
                                .map(c => ({ path: c.path }))
                        }
                        initialInput['modelId'] = session.modelId
                        toolUse.input = initialInput
                    } catch (e) {
                        this.#features.logging.warn(`could not parse CodeReview tool input: ${e}`)
                    }
                }

                // After approval, add the path to the approved paths in the session
                const inputPath = (toolUse.input as any)?.path || (toolUse.input as any)?.cwd
                if (inputPath) {
                    session.addApprovedPath(inputPath, toolUse.name)
                }

                const ws = this.#getWritableStream(chatResultStream, toolUse)
                const result = await this.#features.agent.runTool(toolUse.name, toolUse.input, token, ws)

                let toolResultContent: ToolResultContentBlock

                if (toolUse.name === CodeReview.toolName) {
                    // no need to write tool result for code review, this is handled by model via chat
                    // Push result in message so that it is picked by IDE plugin to show in issues panel
                    const codeReviewResult = result as InvokeOutput
                    if (
                        codeReviewResult?.output?.kind === 'json' &&
                        codeReviewResult.output.success &&
                        (codeReviewResult.output.content as CodeReviewResult)?.findingsByFile
                    ) {
                        await chatResultStream.writeResultBlock({
                            type: 'tool',
                            messageId: toolUse.toolUseId + CODE_REVIEW_FINDINGS_MESSAGE_SUFFIX,
                            body: (codeReviewResult.output.content as CodeReviewResult).findingsByFile,
                        })
                        if ((codeReviewResult.output.content as CodeReviewResult).findingsExceededLimit) {
                            codeReviewResult.output.content = {
                                codeReviewId: (codeReviewResult.output.content as CodeReviewResult).codeReviewId,
                                message: (codeReviewResult.output.content as CodeReviewResult).message,
                                findingsExceededLimit: (codeReviewResult.output.content as CodeReviewResult)
                                    .findingsExceededLimit,
                            }
                        }
                    }
                }

                if (typeof result === 'string') {
                    toolResultContent = { text: result }
                } else if (Array.isArray(result)) {
                    toolResultContent = { json: { items: result } }
                } else if (typeof result === 'object') {
                    toolResultContent = { json: result }
                } else toolResultContent = { text: JSON.stringify(result) }
                this.#validateToolResult(toolUse, toolResultContent)

                results.push({
                    toolUseId: toolUse.toolUseId,
                    status: 'success',
                    content: [toolResultContent],
                })

                switch (toolUse.name) {
                    case FS_READ:
                    case LIST_DIRECTORY:
                        const readToolResult = await this.#processReadTool(toolUse, chatResultStream)
                        if (readToolResult) {
                            await chatResultStream.writeResultBlock(readToolResult)
                        }
                        break
                    case FILE_SEARCH:
                        if (isFileSearchParams(toolUse.input)) {
                            await this.#processFileSearchTool(
                                toolUse.input,
                                toolUse.toolUseId,
                                result,
                                chatResultStream
                            )
                        }
                        break
                    // no need to write tool result for listDir,fsRead,fileSearch into chat stream
                    case EXECUTE_BASH:
                        // no need to write tool result for listDir and fsRead into chat stream
                        // executeBash will stream the output instead of waiting until the end
                        break
                    case GREP_SEARCH:
                        const grepSearchResult = this.#processGrepSearchResult(toolUse, result, chatResultStream)
                        if (grepSearchResult) {
                            await chatResultStream.writeResultBlock(grepSearchResult)
                        }
                        break
                    case FS_REPLACE:
                    case FS_WRITE:
                        const input = toolUse.input as unknown as FsWriteParams | FsReplaceParams
                        // Load from the filesystem instead of workspace.
                        // Workspace is likely out of date - when files
                        // are modified external to the IDE, many IDEs
                        // will only update their file contents (which
                        // then propagates to the LSP) if/when that
                        // document receives focus.
                        const doc = await this.#triggerContext.getTextDocumentFromPath(input.path, false, true)
                        const chatResult = await this.#getFsWriteChatResult(toolUse, doc, session)
                        const cachedToolUse = session.toolUseLookup.get(toolUse.toolUseId)
                        if (cachedToolUse) {
                            session.toolUseLookup.set(toolUse.toolUseId, {
                                ...cachedToolUse,
                                chatResult,
                                fileChange: { ...cachedToolUse.fileChange, after: doc?.getText() },
                            })
                        }
                        this.#telemetryController.emitInteractWithAgenticChat(
                            'GeneratedDiff',
                            tabId,
                            session.pairProgrammingMode,
                            session.getConversationType(),
                            this.#abTestingAllocation?.experimentName,
                            this.#abTestingAllocation?.userVariation
                        )
                        // Emit acceptedLineCount when write tool is used and code changes are accepted
                        const acceptedLineCount = calculateModifiedLines(toolUse, doc?.getText())
                        const programmingLanguage = getCodeWhispererLanguageIdFromPath(input.path)
                        await this.#telemetryController.emitInteractWithMessageMetric(
                            tabId,
                            {
                                cwsprChatMessageId: chatResult.messageId ?? toolUse.toolUseId,
                                cwsprChatInteractionType: ChatInteractionType.AgenticCodeAccepted,
                                codewhispererCustomizationArn: this.#customizationArn,
                                cwsprChatProgrammingLanguage: programmingLanguage,
                            },
                            acceptedLineCount,
                            session.conversationId
                        )
                        await chatResultStream.writeResultBlock(chatResult)
                        break
                    case CodeReview.toolName:
                        break
                    case DisplayFindings.toolName:
                        // no need to write tool result for code review, this is handled by model via chat
                        // Push result in message so that it is picked by IDE plugin to show in issues panel
                        const displayFindingsResult = result as InvokeOutput
                        if (
                            displayFindingsResult?.output?.kind === 'json' &&
                            displayFindingsResult.output.success &&
                            displayFindingsResult.output.content !== undefined
                        ) {
                            await chatResultStream.writeResultBlock({
                                type: 'tool',
                                messageId: toolUse.toolUseId + DISPLAY_FINDINGS_MESSAGE_SUFFIX,
                                body: JSON.stringify(displayFindingsResult.output.content),
                            })
                        }
                        break
                    case SemanticSearch.toolName:
                        await this.#handleSemanticSearchToolResult(toolUse, result, session, chatResultStream)
                        break
                    // — DEFAULT ⇒ MCP tools
                    default:
                        await this.#handleMcpToolResult(toolUse, result, session, chatResultStream)
                        break
                }
                this.#updateUndoAllState(toolUse, session)

                if (toolUse.name && toolUse.toolUseId) {
                    // Calculate latency if we have a start time for this tool use
                    let latency: number | undefined = undefined
                    if (this.#toolUseStartTimes[toolUse.toolUseId]) {
                        latency = Date.now() - this.#toolUseStartTimes[toolUse.toolUseId]
                        delete this.#toolUseStartTimes[toolUse.toolUseId]

                        if (latency !== undefined) {
                            this.#toolUseLatencies.push({
                                toolName: toolUse.name,
                                toolUseId: toolUse.toolUseId,
                                latency: latency,
                            })
                        }
                    }

                    this.#telemetryController.emitToolUseSuggested(
                        toolUse,
                        session.conversationId ?? '',
                        this.#features.runtime.serverInfo.version ?? '',
                        latency,
                        session.pairProgrammingMode,
                        this.#abTestingAllocation?.experimentName,
                        this.#abTestingAllocation?.userVariation,
                        'Succeeded'
                    )
                }
            } catch (err) {
                await this.#showUndoAllIfRequired(chatResultStream, session)
                if (this.isUserAction(err, token)) {
                    // Handle ToolApprovalException for any tool
                    if (err instanceof ToolApprovalException && cachedButtonBlockId) {
                        await chatResultStream.overwriteResultBlock(
                            this.#getUpdateToolConfirmResult(toolUse, false, toolUse.name),
                            cachedButtonBlockId
                        )
                        if (err.shouldShowMessage) {
                            await chatResultStream.writeResultBlock({
                                type: 'answer',
                                messageId: `reject-message-${toolUse.toolUseId}`,
                                body: err.message || 'Command was rejected.',
                            })
                        }
                    } else if (err instanceof ToolApprovalException) {
                        this.#features.logging.warn('Failed to update tool block: no blockId is available.')
                    }

                    // Handle CancellationError
                    if (err instanceof CancellationError) {
                        results.push({
                            toolUseId: toolUse.toolUseId,
                            status: ToolResultStatus.ERROR,
                            content: [{ text: 'Command stopped by user' }],
                        })
                        continue
                    }

                    // Rethrow error for executeBash or any named tool
                    if (toolUse.name === EXECUTE_BASH || toolUse.name) {
                        throw err
                    }
                } else {
                    // only emit if this is an actual tool error (not a user rejecting/canceling tool)
                    this.#telemetryController.emitToolUseSuggested(
                        toolUse,
                        session.conversationId ?? '',
                        this.#features.runtime.serverInfo.version ?? '',
                        undefined,
                        session.pairProgrammingMode,
                        this.#abTestingAllocation?.experimentName,
                        this.#abTestingAllocation?.userVariation,
                        'Failed'
                    )
                }

                // Handle MCP tool failures
                let originalNames
                try {
                    originalNames = McpManager.instance.getOriginalToolNames(toolUse.name)
                } catch (error) {
                    // McpManager not initialized, skip MCP error handling
                    this.#features.logging.debug(
                        `McpManager not initialized, skipping MCP error handling with error: ${error}`
                    )
                    originalNames = undefined
                }
                if (originalNames && toolUse.toolUseId) {
                    const { toolName } = originalNames
                    const cachedToolUse = session.toolUseLookup.get(toolUse.toolUseId)
                    const cachedButtonBlockId = (cachedToolUse as any)?.cachedButtonBlockId
                    const customerFacingError = getCustomerFacingErrorMessage(err)

                    const errorResult = {
                        type: 'tool',
                        messageId: toolUse.toolUseId,
                        summary: {
                            content: {
                                header: {
                                    icon: 'tools',
                                    body: `${toolName}`,
                                    status: {
                                        status: 'error',
                                        icon: 'cancel-circle',
                                        text: 'Error',
                                        description: customerFacingError,
                                    },
                                },
                            },
                            collapsedContent: [
                                {
                                    header: { body: 'Parameters' },
                                    body: `\`\`\`json\n${JSON.stringify(toolUse.input, null, 2)}\n\`\`\``,
                                },
                                {
                                    header: { body: 'Error' },
                                    body: customerFacingError,
                                },
                            ],
                        },
                    } as ChatResult

                    if (cachedButtonBlockId !== undefined) {
                        await chatResultStream.overwriteResultBlock(errorResult, cachedButtonBlockId)
                    } else {
                        await chatResultStream.writeResultBlock(errorResult)
                    }
                }

                // display fs write failure status in the UX of that file card
                if ((toolUse.name === FS_WRITE || toolUse.name === FS_REPLACE) && toolUse.toolUseId) {
                    const existingCard = chatResultStream.getMessageBlockId(toolUse.toolUseId)
                    const fsParam = toolUse.input as unknown as FsWriteParams | FsReplaceParams
                    if (fsParam.path) {
                        const fileName = path.basename(fsParam.path)
                        const customerFacingError = getCustomerFacingErrorMessage(err)
                        const errorResult = {
                            type: 'tool',
                            messageId: toolUse.toolUseId,
                            header: {
                                fileList: {
                                    filePaths: [fileName],
                                    details: {
                                        [fileName]: {
                                            description: fsParam.path,
                                        },
                                    },
                                },
                                status: {
                                    status: 'error',
                                    icon: 'cancel-circle',
                                    text: 'Error',
                                    description: customerFacingError,
                                },
                            },
                        } as ChatResult

                        if (existingCard) {
                            await chatResultStream.overwriteResultBlock(errorResult, existingCard)
                        } else {
                            await chatResultStream.writeResultBlock(errorResult)
                        }
                    }
                } else if (toolUse.name === EXECUTE_BASH && toolUse.toolUseId) {
                    const existingCard = chatResultStream.getMessageBlockId(toolUse.toolUseId)
                    const command = (toolUse.input as unknown as ExecuteBashParams).command
                    const completedErrorResult = {
                        type: 'tool',
                        messageId: toolUse.toolUseId,
                        body: `\`\`\`shell\n${command}\n\`\`\``,
                        header: {
                            body: 'shell',
                            status: {
                                status: 'success',
                                icon: 'ok',
                                text: 'Completed',
                            },
                            buttons: [],
                        },
                    } as ChatResult

                    if (existingCard) {
                        await chatResultStream.overwriteResultBlock(completedErrorResult, existingCard)
                    } else {
                        this.#features.chat.sendChatUpdate({
                            tabId,
                            state: { inProgress: false },
                            data: {
                                messages: [completedErrorResult],
                            },
                        })
                    }
                    this.#stoppedToolUses.add(toolUse.toolUseId)
                }
                const errMsg = err instanceof Error ? err.message : 'unknown error'
                this.#log(`Error running tool ${toolUse.name}:`, errMsg)
                results.push({
                    toolUseId: toolUse.toolUseId,
                    status: ToolResultStatus.ERROR,
                    content: [{ json: { error: err instanceof Error ? err.message : 'Unknown error' } }],
                })
            }
        }

        return results
    }

    #shouldSendBackErrorContent(toolResult: ToolResult) {
        if (toolResult.status === ToolResultStatus.ERROR) {
            for (const content of toolResult.content ?? []) {
                if (content.json && JSON.stringify(content.json).includes(OUTPUT_LIMIT_EXCEEDS_PARTIAL_MSG)) {
                    // do not send the content response back for this case to avoid unnecessary messages
                    return false
                }
            }
            return true
        }
        return false
    }

    /**
     * Updates the currentUndoAllId state in the session
     */
    #updateUndoAllState(toolUse: ToolUse, session: ChatSessionService) {
        if (toolUse.name === FS_READ || toolUse.name === LIST_DIRECTORY) {
            return
        }
        if (toolUse.name === FS_WRITE || toolUse.name === FS_REPLACE) {
            if (session.currentUndoAllId === undefined) {
                session.currentUndoAllId = toolUse.toolUseId
            }
            if (session.currentUndoAllId) {
                const prev = session.toolUseLookup.get(session.currentUndoAllId)
                if (prev && toolUse.toolUseId) {
                    const relatedToolUses = prev.relatedToolUses || new Set()
                    relatedToolUses.add(toolUse.toolUseId)

                    session.toolUseLookup.set(session.currentUndoAllId, {
                        ...prev,
                        relatedToolUses,
                    })
                }
            }
        } else {
            session.currentUndoAllId = undefined
        }
    }

    /**
     * Shows an "Undo all changes" button if there are multiple related file changes
     * that can be undone together.
     */
    async #showUndoAllIfRequired(chatResultStream: AgenticChatResultStream, session: ChatSessionService) {
        if (session.currentUndoAllId === undefined) {
            return
        }

        const toUndo = session.toolUseLookup.get(session.currentUndoAllId)?.relatedToolUses
        if (!toUndo || toUndo.size <= 1) {
            session.currentUndoAllId = undefined
            return
        }

        await chatResultStream.writeResultBlock({
            type: 'answer',
            messageId: `${session.currentUndoAllId}${SUFFIX_UNDOALL}`,
            buttons: [
                {
                    id: BUTTON_UNDO_ALL_CHANGES,
                    text: 'Undo all changes',
                    icon: 'undo',
                    status: 'clear',
                    keepCardAfterClick: false,
                },
            ],
        })
        session.currentUndoAllId = undefined
    }

    /**
     * Determines if error is thrown as a result of a user action (Ex. rejecting tool, stop button)
     * @param err
     * @returns
     */
    isUserAction(err: unknown, token?: CancellationToken, session?: ChatSessionService): boolean {
        return (
            !isUsageLimitError(err) &&
            (CancellationError.isUserCancelled(err) ||
                err instanceof ToolApprovalException ||
                isRequestAbortedError(err) ||
                (token?.isCancellationRequested ?? false))
        )
    }

    #isPromptCanceled(token: CancellationToken | undefined, session: ChatSessionService, promptId: string): boolean {
        return token?.isCancellationRequested === true || !session.isCurrentPrompt(promptId)
    }

    #validateToolResult(toolUse: ToolUse, result: ToolResultContentBlock) {
        let maxToolResponseSize
        switch (toolUse.name) {
            case FS_READ:
            case EXECUTE_BASH:
                // fsRead and executeBash already have truncation logic
                return
            case LIST_DIRECTORY:
                maxToolResponseSize = 50_000
                break
            default:
                maxToolResponseSize = 100_000
                break
        }
        if (
            (result.text && result.text.length > maxToolResponseSize) ||
            (result.json && JSON.stringify(result.json).length > maxToolResponseSize)
        ) {
            throw Error(`${toolUse.name} ${OUTPUT_LIMIT_EXCEEDS_PARTIAL_MSG} ${maxToolResponseSize}`)
        }
    }

    /**
     * Get a description for the tooltip based on command category
     * @param commandCategory The category of the command
     * @returns A descriptive message for the tooltip
     */
    #getCommandCategoryDescription(category: CommandCategory): string | undefined {
        switch (category) {
            case CommandCategory.Mutate:
                return 'This command may modify your code and/or files.'
            case CommandCategory.Destructive:
                return 'This command may cause significant data loss or damage.'
            default:
                return undefined
        }
    }

    #getToolOverWritableStream(
        chatResultStream: AgenticChatResultStream,
        toolUse: ToolUse
    ): WritableStream | undefined {
        const toolMsgId = toolUse.toolUseId!

        return new WritableStream({
            write: async chunk => {
                if (this.#stoppedToolUses.has(toolMsgId)) return

                await chatResultStream.removeResultBlockAndUpdateUI(toolMsgId)

                await chatResultStream.writeResultBlock({
                    type: 'tool',
                    messageId: toolMsgId,
                    body: chunk,
                })
            },
            close: async () => {
                if (this.#stoppedToolUses.has(toolMsgId)) return

                await chatResultStream.removeResultBlockAndUpdateUI(toolMsgId)

                this.#stoppedToolUses.add(toolMsgId)
            },
        })
    }

    #getWritableStream(chatResultStream: AgenticChatResultStream, toolUse: ToolUse): WritableStream | undefined {
        if (toolUse.name === CodeReview.toolName) {
            return this.#getToolOverWritableStream(chatResultStream, toolUse)
        }
        if (toolUse.name !== EXECUTE_BASH) {
            return
        }

        const toolMsgId = toolUse.toolUseId!
        let headerEmitted = false

        const initialHeader: ChatMessage['header'] = {
            body: 'shell',
            buttons: [this.#renderStopShellCommandButton()],
        }

        const completedHeader: ChatMessage['header'] = {
            body: 'shell',
            status: { status: 'success', icon: 'ok', text: 'Completed' },
            buttons: [],
        }

        return new WritableStream({
            write: async chunk => {
                if (this.#stoppedToolUses.has(toolMsgId)) return

                await chatResultStream.writeResultBlock({
                    type: 'tool',
                    messageId: toolMsgId,
                    body: chunk,
                    header: headerEmitted ? undefined : initialHeader,
                })

                headerEmitted = true
            },

            close: async () => {
                if (this.#stoppedToolUses.has(toolMsgId)) return

                await chatResultStream.writeResultBlock({
                    type: 'tool',
                    messageId: toolMsgId,
                    body: '```',
                    header: completedHeader,
                })

                this.#stoppedToolUses.add(toolMsgId)
            },
        })
    }

    /**
     * Creates an updated ChatResult for tool confirmation based on tool type
     * @param toolUse The tool use object
     * @param isAccept Whether the tool was accepted or rejected
     * @param toolType Optional tool type for specialized handling
     * @returns ChatResult with appropriate confirmation UI
     */
    #getUpdateToolConfirmResult(
        toolUse: ToolUse,
        isAccept: boolean,
        originalToolName: string,
        toolType?: string
    ): ChatResult {
        const toolName = originalToolName ?? (toolType || toolUse.name)

        // Handle bash commands with special formatting
        if (toolName === EXECUTE_BASH) {
            return {
                messageId: toolUse.toolUseId,
                type: 'tool',
                body: '```shell\n' + (toolUse.input as unknown as ExecuteBashParams).command,
                header: {
                    body: 'shell',
                    ...(isAccept
                        ? {}
                        : {
                              status: {
                                  status: 'error',
                                  icon: 'cancel',
                                  text: 'Rejected',
                              },
                          }),
                    buttons: isAccept ? [this.#renderStopShellCommandButton()] : [],
                },
            }
        }

        // For file operations and other tools, create appropriate confirmation UI
        let header: {
            body: string | undefined
            status: { status: 'info' | 'success' | 'warning' | 'error'; icon: string; text: string }
        }
        let body: string | undefined

        switch (toolName) {
            case FS_REPLACE:
            case FS_WRITE:
            case FS_READ:
            case LIST_DIRECTORY:
                header = {
                    body: undefined,
                    status: {
                        status: 'success',
                        icon: 'ok',
                        text: 'Allowed',
                    },
                }
                break

            case FILE_SEARCH:
                const searchPath = (toolUse.input as unknown as FileSearchParams).path
                header = {
                    body: 'File Search',
                    status: {
                        status: isAccept ? 'success' : 'error',
                        icon: isAccept ? 'ok' : 'cancel',
                        text: isAccept ? 'Allowed' : 'Rejected',
                    },
                }
                body = `File search ${isAccept ? 'allowed' : 'rejected'}: \`${searchPath}\``
                break

            default:
                // Default tool (not only MCP)
                return {
                    type: 'tool',
                    messageId: toolUse.toolUseId!,
                    summary: {
                        content: {
                            header: {
                                icon: 'tools',
                                body: `${originalToolName ?? (toolType || toolUse.name)}`,
                                status: {
                                    status: isAccept ? 'success' : 'error',
                                    icon: isAccept ? 'ok' : 'cancel',
                                    text: isAccept ? 'Accepted' : 'Rejected',
                                },
                                fileList: undefined,
                            },
                        },
                        collapsedContent: [
                            {
                                header: {
                                    body: 'Parameters',
                                    status: undefined,
                                },
                                body: `\`\`\`json\n${JSON.stringify(toolUse.input, null, 2)}\n\`\`\``,
                            },
                        ],
                    },
                }
        }

        return {
            messageId: this.#getMessageIdForToolUse(toolType, toolUse),
            type: 'tool',
            body,
            header,
        }
    }

    async #renderStoppedShellCommand(tabId: string, messageId: string): Promise<void> {
        const session = this.#chatSessionManagementService.getSession(tabId).data
        const toolUse = session?.toolUseLookup.get(messageId)
        const command = (toolUse!.input as unknown as ExecuteBashParams).command
        await this.#features.chat.sendChatUpdate({
            tabId,
            state: { inProgress: false },
            data: {
                messages: [
                    {
                        messageId,
                        type: 'tool',
                        body: `\`\`\`shell\n${command}\n\`\`\``,
                        header: {
                            body: 'shell',
                            status: {
                                status: 'error',
                                icon: 'stop',
                                text: 'Stopped',
                            },
                            buttons: [],
                        },
                    },
                ],
            },
        })
    }

    #processCompactConfirmation(messageId: string, characterCount: number, maxOverallCharacters: number): ChatResult {
        const buttons = [{ id: 'allow-tools', text: 'Allow', icon: 'ok', status: 'clear' }]
        const header = {
            icon: 'warning',
            iconForegroundStatus: 'warning',
            body: COMPACTION_HEADER_BODY,
            buttons,
        } as any
        const body = COMPACTION_BODY(Math.round((characterCount / maxOverallCharacters) * 100))
        return {
            type: 'tool',
            messageId,
            header,
            body,
        }
    }

    /**
     * Creates a promise that does not resolve until the user accepts or rejects the compaction usage.
     * @param messageId
     * @param resultStream
     * @param promptBlockId id of approval block. This allows us to overwrite the buttons with 'accepted' or 'rejected' text.
     */
    async waitForCompactApproval(
        messageId: string,
        resultStream: AgenticChatResultStream,
        promptBlockId: number,
        session: ChatSessionService
    ) {
        const deferred = this.#createDeferred()
        session.setDeferredToolExecution(messageId, deferred.resolve, deferred.reject)
        this.#log(`Prompting for compaction approval for messageId: ${messageId}`)
        await deferred.promise
        session.removeDeferredToolExecution(messageId)
        // Note: we want to overwrite the button block because it already exists in the stream.
        await resultStream.overwriteResultBlock(this.#getUpdateCompactConfirmResult(messageId), promptBlockId)
    }

    /**
     * Creates an updated ChatResult for compaction confirmation
     * @param messageId The messageId
     * @returns ChatResult with appropriate confirmation UI
     */
    #getUpdateCompactConfirmResult(messageId: string): ChatResult {
        let header: {
            body: string | undefined
            status: { status: 'info' | 'success' | 'warning' | 'error'; icon: string; text: string }
        }
        let body: string | undefined

        header = {
            body: undefined,
            status: {
                status: 'success',
                icon: 'ok',
                text: 'Allowed',
            },
        }

        return {
            messageId,
            type: 'tool',
            body,
            header,
        }
    }

    #renderStopShellCommandButton() {
        const stopKey = this.#getKeyBinding('aws.amazonq.stopCmdExecution')
        return {
            id: BUTTON_STOP_SHELL_COMMAND,
            text: 'Stop',
            icon: 'stop',
            ...(stopKey ? { description: `Stop:  ${stopKey}` } : {}),
        }
    }

    #getKeyBinding(commandId: string): string | null {
        // Check for feature flag
        const shortcut =
            this.#features.lsp.getClientInitializeParams()?.initializationOptions?.aws?.awsClientCapabilities?.q
                ?.shortcut
        if (!shortcut) {
            return null
        }
        let defaultKey = ''
        const OS = os.platform()

        switch (commandId) {
            case 'aws.amazonq.runCmdExecution':
                defaultKey = OS === 'darwin' ? DEFAULT_MACOS_RUN_SHORTCUT : DEFAULT_WINDOW_RUN_SHORTCUT
                break
            case 'aws.amazonq.rejectCmdExecution':
                defaultKey = OS === 'darwin' ? DEFAULT_MACOS_REJECT_SHORTCUT : DEFAULT_WINDOW_REJECT_SHORTCUT
                break
            case 'aws.amazonq.stopCmdExecution':
                defaultKey = OS === 'darwin' ? DEFAULT_MACOS_STOP_SHORTCUT : DEFAULT_WINDOW_STOP_SHORTCUT
                break
            default:
                this.#log(`#getKeyBinding: ${commandId} shortcut is supported by Q `)
                break
        }

        if (defaultKey === '') {
            return null
        }

        //TODO: handle case: user change default keybind, suggestion: read `keybinding.json` provided by VSC

        return defaultKey
    }

    #processToolConfirmation(
        toolUse: ToolUse,
        requiresAcceptance: Boolean,
        warning?: string,
        commandCategory?: CommandCategory,
        toolType?: string,
        builtInPermission?: boolean
    ): ChatResult {
        const toolName = toolType || toolUse.name
        let buttons: Button[] = []
        let header: {
            body: string
            buttons: Button[]
            icon?: string
            iconForegroundStatus?: string
            status?: {
                status?: Status
                position?: 'left' | 'right'
                description?: string
                icon?: string
                text?: string
            }
        }
        let body: string | undefined

        // Configure tool-specific UI elements
        switch (toolName) {
            case EXECUTE_BASH: {
                const commandString = (toolUse.input as unknown as ExecuteBashParams).command
                // get feature flag
                const shortcut =
                    this.#features.lsp.getClientInitializeParams()?.initializationOptions?.aws?.awsClientCapabilities?.q
                        ?.shortcut

                const runKey = this.#getKeyBinding('aws.amazonq.runCmdExecution')
                const rejectKey = this.#getKeyBinding('aws.amazonq.rejectCmdExecution')

                buttons = requiresAcceptance
                    ? [
                          {
                              id: BUTTON_RUN_SHELL_COMMAND,
                              text: 'Run',
                              icon: 'play',
                              ...(runKey ? { description: `Run:  ${runKey}` } : {}),
                          },
                          {
                              id: BUTTON_REJECT_SHELL_COMMAND,
                              status: 'dimmed-clear' as Status,
                              text: 'Reject',
                              icon: 'cancel',
                              ...(rejectKey ? { description: `Reject:  ${rejectKey}` } : {}),
                          },
                      ]
                    : []

                const statusIcon =
                    commandCategory === CommandCategory.Destructive
                        ? 'warning'
                        : commandCategory === CommandCategory.Mutate
                          ? 'info'
                          : 'none'
                const statusType =
                    commandCategory === CommandCategory.Destructive
                        ? 'warning'
                        : commandCategory === CommandCategory.Mutate
                          ? 'info'
                          : undefined

                header = {
                    status: requiresAcceptance
                        ? {
                              icon: statusIcon,
                              status: statusType,
                              position: 'left',
                              description: this.#getCommandCategoryDescription(
                                  commandCategory ?? CommandCategory.ReadOnly
                              ),
                          }
                        : {},
                    body: 'shell',
                    buttons,
                }
                body = '```shell\n' + commandString
                break
            }

            case FS_WRITE: {
                const writeFilePath = (toolUse.input as unknown as FsWriteParams).path

                // Validate the path using our synchronous utility
                validatePathBasic(writeFilePath)

                this.#debug(`Processing ${toolUse.name} for path: ${writeFilePath}`)
                buttons = [{ id: BUTTON_ALLOW_TOOLS, text: 'Allow', icon: 'ok', status: 'clear' }]
                header = {
                    icon: 'warning',
                    iconForegroundStatus: 'warning',
                    body: builtInPermission
                        ? '#### Allow file modification'
                        : '#### Allow file modification outside of your workspace',
                    buttons,
                }
                body = builtInPermission
                    ? `I need permission to modify files.\n\`${writeFilePath}\``
                    : `I need permission to modify files outside of your workspace.\n\`${writeFilePath}\``
                break
            }

            case FS_REPLACE: {
                const writeFilePath = (toolUse.input as unknown as FsReplaceParams).path

                // For replace, we need to verify the file exists
                validatePathExists(writeFilePath)

                this.#debug(`Processing ${toolUse.name} for path: ${writeFilePath}`)
                buttons = [{ id: BUTTON_ALLOW_TOOLS, text: 'Allow', icon: 'ok', status: 'clear' }]
                header = {
                    icon: 'warning',
                    iconForegroundStatus: 'warning',
                    body: builtInPermission
                        ? '#### Allow file modification'
                        : '#### Allow file modification outside of your workspace',
                    buttons,
                }
                body = builtInPermission
                    ? `I need permission to modify files.\n\`${writeFilePath}\``
                    : `I need permission to modify files outside of your workspace.\n\`${writeFilePath}\``
                break
            }

            case FS_READ:
            case LIST_DIRECTORY: {
                buttons = [{ id: BUTTON_ALLOW_TOOLS, text: 'Allow', icon: 'ok', status: 'clear' }]
                header = {
                    icon: 'tools',
                    iconForegroundStatus: 'tools',
                    body: builtInPermission
                        ? '#### Allow read-only tools'
                        : '#### Allow read-only tools outside your workspace',
                    buttons,
                }

                if (toolName === FS_READ) {
                    const paths = (toolUse.input as unknown as FsReadParams).paths

                    // Validate paths using our synchronous utility
                    validatePathsSync(paths)

                    this.#debug(`Processing ${toolUse.name} for paths: ${JSON.stringify(paths)}`)
                    const formattedPaths: string[] = []
                    paths.forEach(element => formattedPaths.push(`\`${element}\``))
                    body = builtInPermission
                        ? `I need permission to read files.\n${formattedPaths.join('\n')}`
                        : `I need permission to read files outside the workspace.\n${formattedPaths.join('\n')}`
                } else {
                    const readFilePath = (toolUse.input as unknown as ListDirectoryParams).path

                    // Validate the path using our synchronous utility
                    validatePathExists(readFilePath)

                    this.#debug(`Processing ${toolUse.name} for path: ${readFilePath}`)
                    body = builtInPermission
                        ? `I need permission to list directories.\n\`${readFilePath}\``
                        : `I need permission to list directories outside the workspace.\n\`${readFilePath}\``
                }
                break
            }

            default: {
                // — DEFAULT ⇒ MCP tools
                buttons = [{ id: BUTTON_ALLOW_TOOLS, text: 'Allow', icon: 'ok', status: 'clear' }]
                header = {
                    icon: 'tools',
                    iconForegroundStatus: 'warning',
                    body: `#### ${toolName}`,
                    buttons,
                }
                body = ' '
                break
            }
        }

        // Determine if this is a built-in tool or MCP tool
        const isStandardTool = toolName !== undefined && this.#features.agent.getBuiltInToolNames().includes(toolName)

        if (isStandardTool) {
            return {
                type: 'tool',
                messageId: this.#getMessageIdForToolUse(toolType, toolUse),
                header,
                body: warning ? (toolName === EXECUTE_BASH ? '' : '\n\n') + body : body,
            }
        } else {
            return {
                type: 'tool',
                messageId: toolUse.toolUseId,
                summary: {
                    content: {
                        header: {
                            icon: 'tools',
                            body: `${toolName}`,
                            buttons: [
                                { id: BUTTON_ALLOW_TOOLS, text: 'Run', icon: 'play', status: 'clear' },
                                {
                                    id: BUTTON_REJECT_MCP_TOOL,
                                    text: 'Reject',
                                    icon: 'cancel',
                                    status: 'dimmed-clear' as Status,
                                },
                            ],
                        },
                    },
                    collapsedContent: [
                        {
                            header: { body: 'Parameters' },
                            body: `\`\`\`json\n${JSON.stringify(toolUse.input, null, 2)}\n\`\`\``,
                        },
                    ],
                },
            }
        }
    }

    async #getFsWriteChatResult(
        toolUse: ToolUse,
        doc: TextDocument | undefined,
        session: ChatSessionService
    ): Promise<ChatMessage> {
        const input = toolUse.input as unknown as FsWriteParams | FsReplaceParams
        const oldContent = session.toolUseLookup.get(toolUse.toolUseId!)?.fileChange?.before ?? ''
        // Get just the filename instead of the full path
        const fileName = path.basename(input.path)
        const diffChanges = diffLines(oldContent, doc?.getText() ?? '')
        const changes = diffChanges.reduce(
            (acc, { count = 0, added, removed }) => {
                if (added) {
                    acc.added += count
                } else if (removed) {
                    acc.deleted += count
                }
                return acc
            },
            { added: 0, deleted: 0 }
        )
        return {
            type: 'tool',
            messageId: toolUse.toolUseId,
            header: {
                fileList: {
                    filePaths: [fileName],
                    details: {
                        [fileName]: {
                            changes,
                            description: input.path,
                        },
                    },
                },
                buttons: [{ id: BUTTON_UNDO_CHANGES, text: 'Undo', icon: 'undo' }],
            },
        }
    }

    async #processFileSearchTool(
        toolInput: FileSearchParams,
        toolUseId: string,
        result: InvokeOutput,
        chatResultStream: AgenticChatResultStream
    ): Promise<void> {
        if (typeof result.output.content !== 'string') return

        const { queryName, path: inputPath } = toolInput
        const resultCount = result.output.content
            .split('\n')
            .filter(line => line.trim().startsWith('[F]') || line.trim().startsWith('[D]')).length

        const chatMessage: ChatMessage = {
            type: 'tool',
            messageId: toolUseId,
            header: {
                body: `Searched for "${queryName}" in `,
                icon: 'search',
                status: {
                    text: `${resultCount} result${resultCount !== 1 ? 's' : ''} found`,
                },
                fileList: {
                    filePaths: [inputPath],
                    details: {
                        [inputPath]: {
                            description: inputPath,
                            visibleName: path.basename(inputPath),
                            clickable: false,
                        },
                    },
                },
            },
        }
        await chatResultStream.writeResultBlock(chatMessage)
    }

    async #processReadTool(
        toolUse: ToolUse,
        chatResultStream: AgenticChatResultStream
    ): Promise<ChatMessage | undefined> {
        let currentPaths: string[] = []
        if (toolUse.name === FS_READ) {
            currentPaths = (toolUse.input as unknown as FsReadParams)?.paths || []
        } else if (toolUse.name === LIST_DIRECTORY) {
            const singlePath = (toolUse.input as unknown as ListDirectoryParams)?.path
            if (singlePath) {
                currentPaths = [singlePath]
            }
        } else if (toolUse.name === FILE_SEARCH) {
            const queryName = (toolUse.input as unknown as FileSearchParams)?.queryName
            if (queryName) {
                currentPaths = [queryName]
            }
        } else {
            return
        }

        if (currentPaths.length === 0) return

        // Check if the last message is the same tool type
        const lastMessage = chatResultStream.getLastMessage()
        const isSameToolType =
            lastMessage?.type === 'tool' && lastMessage.header?.icon === this.#toolToIcon(toolUse.name)

        let allPaths = currentPaths

        if (isSameToolType && lastMessage.messageId) {
            // Combine with existing paths and overwrite the last message
            const existingPaths = lastMessage.header?.fileList?.filePaths || []
            allPaths = [...existingPaths, ...currentPaths]

            const blockId = chatResultStream.getMessageBlockId(lastMessage.messageId)
            if (blockId !== undefined) {
                // Create the updated message with combined paths
                const updatedMessage = this.#createFileListToolMessage(toolUse, allPaths, lastMessage.messageId)
                // Overwrite the existing block
                await chatResultStream.overwriteResultBlock(updatedMessage, blockId)
                return undefined // Don't return a message since we already wrote it
            }
        }

        // Create new message with current paths
        return this.#createFileListToolMessage(toolUse, allPaths, toolUse.toolUseId!)
    }

    #createFileListToolMessage(toolUse: ToolUse, filePaths: string[], messageId: string): ChatMessage {
        const itemCount = filePaths.length
        let title: string
        if (itemCount === 0) {
            title = 'Gathering context'
        } else {
            title =
                toolUse.name === FS_READ
                    ? `${itemCount} file${itemCount > 1 ? 's' : ''} read`
                    : toolUse.name === LIST_DIRECTORY
                      ? `${itemCount} ${itemCount === 1 ? 'directory' : 'directories'} listed`
                      : ''
        }
        const details: Record<string, FileDetails> = {}
        for (const filePath of filePaths) {
            details[filePath] = {
                description: filePath,
                visibleName: path.basename(filePath),
                clickable: toolUse.name === FS_READ,
            }
        }
        return {
            type: 'tool',
            header: {
                body: title,
                icon: this.#toolToIcon(toolUse.name),
                fileList: {
                    filePaths,
                    details,
                },
            },
            messageId,
        }
    }

    #toolToIcon(toolName: string | undefined): string | undefined {
        switch (toolName) {
            case FS_READ:
                return 'eye'
            case LIST_DIRECTORY:
                return 'check-list'
            default:
                return undefined
        }
    }

    /**
     * Process grep search results and format them for display in the chat UI
     */
    #processGrepSearchResult(
        toolUse: ToolUse,
        result: any,
        chatResultStream: AgenticChatResultStream
    ): ChatMessage | undefined {
        if (toolUse.name !== GREP_SEARCH) {
            return undefined
        }

        const messageIdToUpdate = toolUse.toolUseId!

        // Extract search results from the tool output
        const output = result.output.content as SanitizedRipgrepOutput
        if (!output || !output.fileMatches || !Array.isArray(output.fileMatches)) {
            return {
                type: 'tool',
                messageId: messageIdToUpdate,
                body: 'No search results found.',
            }
        }

        // Process the matches into a structured format
        const matches = output.fileMatches
        const fileDetails: Record<string, FileDetails> = {}

        // Create file details directly from matches
        for (const match of matches) {
            const filePath = match.filePath
            if (!filePath) continue

            fileDetails[`${filePath} (${match.matches.length} ${match.matches.length <= 1 ? 'result' : 'results'})`] = {
                description: filePath,
                lineRanges: [{ first: -1, second: -1 }],
            }
        }

        // Create sorted array of file paths
        const sortedFilePaths = Object.keys(fileDetails)

        // Create the context list for display
        const query = (toolUse.input as any)?.query || 'search term'

        const contextList: FileList = {
            rootFolderTitle: `Grepped for "${query}", ${output.matchCount}  ${output.matchCount <= 1 ? 'result' : 'results'} found`,
            filePaths: sortedFilePaths,
            details: fileDetails,
        }

        return {
            type: 'tool',
            fileList: contextList,
            messageId: messageIdToUpdate,
            body: '',
        }
    }

    /**
     * Updates the request input with tool results for the next iteration
     */
    #updateRequestInputWithToolResults(
        requestInput: ChatCommandInput,
        toolResults: ToolResult[],
        content: string
    ): ChatCommandInput {
        // Create a deep copy of the request input
        const updatedRequestInput = structuredClone(requestInput) as ChatCommandInput

        // Add tool results to the request
        updatedRequestInput.conversationState!.currentMessage!.userInputMessage!.userInputMessageContext!.toolResults =
            []
        updatedRequestInput.conversationState!.currentMessage!.userInputMessage!.content = content
        // don't pass in IDE context again in the followup toolUse/toolResult loop as it confuses the model and is not necessary
        updatedRequestInput.conversationState!.currentMessage!.userInputMessage!.userInputMessageContext!.editorState =
            {
                ...updatedRequestInput.conversationState!.currentMessage!.userInputMessage!.userInputMessageContext!
                    .editorState,
                document: undefined,
                relevantDocuments: undefined,
                cursorState: undefined,
                useRelevantDocuments: false,
            }

        // Clear images to avoid passing them again in follow-up toolUse/toolResult loops, as it is may confuse the model
        updatedRequestInput.conversationState!.currentMessage!.userInputMessage!.images = []

        for (const toolResult of toolResults) {
            this.#debug(`ToolResult: ${JSON.stringify(toolResult)}`)
            updatedRequestInput.conversationState!.currentMessage!.userInputMessage!.userInputMessageContext!.toolResults.push(
                {
                    ...toolResult,
                }
            )
        }

        return updatedRequestInput
    }

    /**
     * Handles the final result after the agent loop completes
     */
    async #handleFinalResult(
        result: Result<AgenticChatResultWithMetadata, string>,
        session: ChatSessionService,
        tabId: string,
        metric: Metric<CombinedConversationEvent>,
        triggerContext: TriggerContext,
        isNewConversation: boolean,
        chatResultStream: AgenticChatResultStream,
        requestModelId?: string
    ): Promise<ChatResult> {
        if (!result.success) {
            throw new AgenticChatError(result.error, 'FailedResult')
        }
        const conversationId = session.conversationId
        this.#debug('Final session conversation id:', conversationId || '')

        if (conversationId) {
            this.#telemetryController.setConversationId(tabId, conversationId)

            if (isNewConversation) {
                this.#telemetryController.updateTriggerInfo(tabId, {
                    startTrigger: {
                        hasUserSnippet: metric.metric.cwsprChatHasCodeSnippet ?? false,
                        triggerType: triggerContext.triggerType,
                    },
                })

                this.#telemetryController.emitStartConversationMetric(tabId, metric.metric)
            }
        }

        metric.setDimension('codewhispererCustomizationArn', this.#customizationArn)
        metric.setDimension('languageServerVersion', this.#features.runtime.serverInfo.version)
        metric.setDimension('enabled', session.pairProgrammingMode)
        const profileArn = this.#serviceManager?.getActiveProfileArn()
        if (profileArn) {
            this.#telemetryService.updateProfileArn(profileArn)
        }
        const modelId = session.modelId
        if (modelId) {
            this.#telemetryService.updateModelId(modelId)
        }
        if (triggerContext.contextInfo) {
            metric.mergeWith({
                cwsprChatHasContextList: triggerContext.documentReference?.filePaths?.length ? true : false,
                cwsprChatFolderContextCount: triggerContext.contextInfo.contextCount.folderContextCount,
                cwsprChatFileContextCount: triggerContext.contextInfo.contextCount.fileContextCount,
                cwsprChatRuleContextCount: triggerContext.contextInfo.contextCount.activeRuleContextCount,
                cwsprChatTotalRuleContextCount: triggerContext.contextInfo.contextCount.totalRuleContextCount,
                cwsprChatPromptContextCount: triggerContext.contextInfo.contextCount.promptContextCount,
                cwsprChatFileContextLength: triggerContext.contextInfo.contextLength.fileContextLength,
                cwsprChatRuleContextLength: triggerContext.contextInfo.contextLength.ruleContextLength,
                cwsprChatPromptContextLength: triggerContext.contextInfo.contextLength.promptContextLength,
                cwsprChatCodeContextCount: triggerContext.contextInfo.contextCount.codeContextCount,
                cwsprChatCodeContextLength: triggerContext.contextInfo.contextLength.codeContextLength,
                cwsprChatFocusFileContextLength: triggerContext.text?.length,
                cwsprChatPinnedCodeContextCount: triggerContext.contextInfo.pinnedContextCount.codeContextCount,
                cwsprChatPinnedFileContextCount: triggerContext.contextInfo.pinnedContextCount.fileContextCount,
                cwsprChatPinnedFolderContextCount: triggerContext.contextInfo.pinnedContextCount.folderContextCount,
                cwsprChatPinnedPromptContextCount: triggerContext.contextInfo.pinnedContextCount.promptContextCount,
            })
        }
        await this.#telemetryController.emitAddMessageMetric(
            tabId,
            metric.metric,
            'Succeeded',
            undefined,
            undefined,
            requestModelId ?? session.modelId
        )

        this.#telemetryController.updateTriggerInfo(tabId, {
            lastMessageTrigger: {
                ...triggerContext,
                messageId: result.data?.chatResult.messageId,
                followUpActions: new Set(
                    result.data?.chatResult.followUp?.options
                        ?.map(option => option.prompt ?? '')
                        .filter(prompt => prompt.length > 0)
                ),
            },
        })

        // Reset memory bank flag after completion
        session.isMemoryBankGeneration = false

        return chatResultStream.getResult()
    }

    /**
     * Handles errors that occur during the request
     */
    async #handleRequestError(
        conversationId: string | undefined,
        err: any,
        errorMessageId: string,
        tabId: string,
        metric: Metric<CombinedConversationEvent>,
        agenticCodingMode: boolean,
        requestModelId?: string
    ): Promise<ChatResult | ResponseError<ChatResult>> {
        const errorMessage = (getErrorMsg(err) ?? GENERIC_ERROR_MS).replace(/[\r\n]+/g, ' ') // replace new lines with empty space
        const requestID = getRequestID(err) ?? ''
        metric.setDimension('cwsprChatResponseCode', getHttpStatusCode(err) ?? 0)
        metric.setDimension('languageServerVersion', this.#features.runtime.serverInfo.version)
        metric.setDimension('codewhispererCustomizationArn', this.#customizationArn)
        metric.setDimension('enabled', agenticCodingMode)

        metric.metric.requestIds = [requestID]
        metric.metric.cwsprChatMessageId = errorMessageId
        metric.metric.cwsprChatConversationId = conversationId
        const errorCode = err.code ?? ''
        await this.#telemetryController.emitAddMessageMetric(
            tabId,
            metric.metric,
            'Failed',
            errorMessage,
            errorCode,
            requestModelId
        )

        // Reset memory bank flag on request error
        const sessionResult = this.#chatSessionManagementService.getSession(tabId)
        const modelId = requestModelId ?? (sessionResult.success ? sessionResult.data.modelId : undefined)
        if (sessionResult.success) {
            sessionResult.data.isMemoryBankGeneration = false
        }

        if (isUsageLimitError(err)) {
            if (this.#paidTierMode !== 'paidtier') {
                this.setPaidTierMode(tabId, 'freetier-limit')
            }
            return new ResponseError<ChatResult>(LSPErrorCodes.RequestFailed, err.message, {
                type: 'answer',
                body: `AmazonQUsageLimitError: Monthly limit reached. ${requestID ? `\n\nRequest ID: ${requestID}` : ''}`,
                messageId: 'monthly-usage-limit',
                buttons: [],
            })
        }

        if (isThrottlingRelated(err)) {
            this.#telemetryController.emitMessageResponseError(
                tabId,
                metric.metric,
                requestID,
                err.message,
                agenticCodingMode,
                modelId
            )
            new ResponseError<ChatResult>(LSPErrorCodes.RequestFailed, err.message, {
                type: 'answer',
                body: requestID ? `${err.message} \n\nRequest ID: ${requestID}` : err.message,
                messageId: errorMessageId,
                buttons: [],
            })
        }

        // use custom error message for unactionable errors (user-dependent errors like PromptCharacterLimit)
        if (err.code && err.code in unactionableErrorCodes) {
            const customErrMessage = unactionableErrorCodes[err.code as keyof typeof unactionableErrorCodes]
            this.#telemetryController.emitMessageResponseError(
                tabId,
                metric.metric,
                requestID,
                customErrMessage,
                agenticCodingMode,
                modelId
            )
        } else {
            this.#telemetryController.emitMessageResponseError(
                tabId,
                metric.metric,
                requestID,
                errorMessage,
                agenticCodingMode,
                modelId
            )
        }

        let authFollowType: ReturnType<typeof getAuthFollowUpType> = undefined
        // first check if there is an AmazonQ related auth follow up
        if (err.cause instanceof AmazonQError) {
            authFollowType = getAuthFollowUpType(err.cause)
        }

        // if not check full error for auth follow up
        if (!authFollowType) {
            authFollowType = getAuthFollowUpType(err)
        }

        if (authFollowType) {
            this.#log(`Q auth error: ${getErrorMsg(err)}`)

            return createAuthFollowUpResult(authFollowType)
        }

        if (isUsageLimitError(err) || customerFacingErrorCodes.includes(err.code)) {
            this.#features.logging.error(`${loggingUtils.formatErr(err)}`)
            if (err.code === 'InputTooLong') {
                // Clear the chat history in the database for this tab
                this.#chatHistoryDb.clearTab(tabId)
            }
            const errorBody =
                err.code === 'QModelResponse' && requestID
                    ? `${err.message} \n\nRequest ID: ${requestID} `
                    : err.message
            const responseData: ChatResult = {
                type: 'answer',
                body: errorBody,
                messageId: errorMessageId,
                buttons: [],
            }
            if (err.code === 'QModelResponse') {
                // special case for throttling where we show error card instead of chat message
                if (
                    err.message ===
                    `The model you selected is temporarily unavailable. Please switch to a different model and try again.`
                ) {
                    this.#features.chat.sendChatUpdate({
                        tabId: tabId,
                        data: { messages: [{ messageId: 'modelUnavailable' }] },
                    })
                    const emptyChatResult: ChatResult = {
                        type: 'answer',
                        body: '',
                        messageId: errorMessageId,
                        buttons: [],
                    }
                    return emptyChatResult
                }
                if (err.message === `I am experiencing high traffic, please try again shortly.`) {
                    this.#features.chat.sendChatUpdate({
                        tabId: tabId,
                        data: { messages: [{ messageId: 'modelThrottled' }] },
                    })
                    const emptyChatResult: ChatResult = {
                        type: 'answer',
                        body: '',
                        messageId: errorMessageId,
                        buttons: [],
                    }
                    return emptyChatResult
                }
                return responseData
            }
            return new ResponseError<ChatResult>(LSPErrorCodes.RequestFailed, err.message, responseData)
        }
        this.#features.logging.error(`Unknown Error: ${loggingUtils.formatErr(err)}`)
        return new ResponseError<ChatResult>(LSPErrorCodes.RequestFailed, err.message, {
            type: 'answer',
            body: requestID ? `${GENERIC_ERROR_MS} \n\nRequest ID: ${requestID}` : GENERIC_ERROR_MS,
            messageId: errorMessageId,
            buttons: [],
        })
    }

    async onInlineChatPrompt(
        params: InlineChatParams,
        token: CancellationToken
    ): Promise<InlineChatResult | ResponseError<InlineChatResult>> {
        const clientRegion = this.#features.lsp.getClientInitializeParams()?.initializationOptions?.aws?.region
        const maybeGovResponse = getGovCloudUnsupportedResponse(clientRegion)
        if (maybeGovResponse) {
            return maybeGovResponse as InlineChatResult
        }

        // TODO: This metric needs to be removed later, just added for now to be able to create a ChatEventParser object
        const metric = new Metric<AddMessageEvent>({
            cwsprChatConversationType: 'Chat',
        })

        IdleWorkspaceManager.recordActivityTimestamp()

        const triggerContext = await this.#getInlineChatTriggerContext(params)

        let response: ChatCommandOutput
        let requestInput: ChatCommandInput

        try {
            requestInput = await this.#triggerContext.getChatParamsFromTrigger(
                params,
                triggerContext,
                ChatTriggerType.INLINE_CHAT,
                this.#customizationArn
            )

            if (!this.#serviceManager) {
                throw new Error('amazonQServiceManager is not initialized')
            }

            const session = new ChatSessionService(this.#serviceManager, this.#features.lsp, this.#features.logging)
            response = await session.getChatResponse(requestInput)
            this.#log('Response for inline chat', JSON.stringify(response.$metadata), JSON.stringify(response))
        } catch (err) {
            if (err instanceof AmazonQServicePendingSigninError || err instanceof AmazonQServicePendingProfileError) {
                this.#log(`Q Inline Chat SSO Connection error: ${getErrorMsg(err)}`)
                return new ResponseError<ChatResult>(LSPErrorCodes.RequestFailed, err.message)
            }
            this.#log(`Q api request error ${err instanceof Error ? JSON.stringify(err) : 'unknown'}`)
            return new ResponseError<ChatResult>(
                LSPErrorCodes.RequestFailed,
                err instanceof Error ? err.message : 'Unknown request error'
            )
        }

        try {
            const result = await this.#processSendMessageResponseForInlineChat(
                response,
                metric,
                params.partialResultToken
            )

            return result.success
                ? {
                      ...result.data.chatResult,
                      requestId: response.$metadata.requestId,
                  }
                : new ResponseError<ChatResult>(LSPErrorCodes.RequestFailed, result.error)
        } catch (err) {
            this.#log(
                'Error encountered during inline chat response streaming:',
                err instanceof Error ? err.message : 'unknown'
            )
            return new ResponseError<ChatResult>(
                LSPErrorCodes.RequestFailed,
                err instanceof Error ? err.message : 'Unknown error occurred during inline chat response stream'
            )
        }
    }

    async onInlineChatResult(params: InlineChatResultParams) {
        await this.#telemetryService.emitInlineChatResultLog(params)
    }

    async onActiveEditorChanged(params: ActiveEditorChangedParams): Promise<void> {
        if (this.#telemetryController.activeTabId) {
            this.sendPinnedContext(this.#telemetryController.activeTabId)
        }
    }

    async onCodeInsertToCursorPosition(params: InsertToCursorPositionParams) {
        // Implementation based on https://github.com/aws/aws-toolkit-vscode/blob/1814cc84228d4bf20270574c5980b91b227f31cf/packages/core/src/amazonq/commons/controllers/contentController.ts#L38
        if (!params.textDocument || !params.cursorPosition || !params.code) {
            const missingParams = []

            if (!params.textDocument) missingParams.push('textDocument')
            if (!params.cursorPosition) missingParams.push('cursorPosition')
            if (!params.code) missingParams.push('code')

            this.#log(
                `Q Chat server failed to insert code.Missing required parameters for insert code: ${missingParams.join(', ')}`
            )
            return
        }

        let cursorPosition = params.cursorPosition

        const indentRange = {
            start: { line: cursorPosition.line, character: 0 },
            end: cursorPosition,
        }
        const documentContent = await this.#features.workspace.getTextDocument(params.textDocument.uri)
        // linePrefix is the raw text that is between the start of the line and the current cursor position
        let linePrefix = documentContent?.getText(indentRange)
        // calculatedIndent is the indent we calculate inside this function and apply to the text to be inserted
        let calculatedIndent = ''
        let hasVirtualSpace = false

        if (linePrefix) {
            // If linePrefix object is not empty, there are two possibilities:
            // Case 1: If linePrefix contains only whitespace: Use the entire linePrefix as is for the indent
            // Case 2: If linePrefix contains non-whitespace characters: Extract leading whitespace from linePrefix (if any), ignore rest of text
            calculatedIndent =
                linePrefix.trim().length == 0
                    ? linePrefix
                    : ' '.repeat(linePrefix.length - linePrefix.trimStart().length)
        } else if (documentContent && cursorPosition.character > 0) {
            // When the cursor is not at the start of the line (position > 0) but there's no actual text at the indentation range
            // It means there are virtual spaces that is being rendered by the IDE
            // In this case, the indentation is determined by the cursorPosition
            this.#log('Indent is nullish and the cursor position is greater than zero while inserting code')
            calculatedIndent = ' '.repeat(cursorPosition.character)
            hasVirtualSpace = true
            cursorPosition.character = 0
        }

        const textWithIndent = params.code
            .split('\n')
            .map((line, index) => {
                if (index === 0) {
                    return hasVirtualSpace && line ? calculatedIndent + line : line
                }
                // Only indent non-empty lines
                return line ? calculatedIndent + line : ''
            })
            .join('\n')

        const workspaceEdit: ApplyWorkspaceEditParams = {
            edit: {
                documentChanges: [
                    TextDocumentEdit.create({ uri: params.textDocument.uri, version: 0 }, [
                        TextEdit.insert(cursorPosition, textWithIndent),
                    ]),
                ],
            },
        }

        this.#userWrittenCodeTracker?.onQStartsMakingEdits()
        const applyResult = await this.#features.lsp.workspace.applyWorkspaceEdit(workspaceEdit)
        this.#userWrittenCodeTracker?.onQFinishesEdits()

        if (applyResult.applied) {
            this.#log(`Q Chat server inserted code successfully`)
            this.#telemetryController.enqueueCodeDiffEntry({ ...params, code: textWithIndent })
        } else {
            this.#log(
                `Q Chat server failed to insert code: ${applyResult.failureReason ?? 'No failure reason provided'}`
            )
        }
    }
    onCopyCodeToClipboard() {}

    onEndChat(params: EndChatParams, _token: CancellationToken): boolean {
        const { success } = this.#chatSessionManagementService.deleteSession(params.tabId)

        return success
    }

    async onFileClicked(params: FileClickParams) {
        const session = this.#chatSessionManagementService.getSession(params.tabId)
        const toolUseId = params.messageId
        const toolUse = toolUseId ? session.data?.toolUseLookup.get(toolUseId) : undefined

        try {
            if (toolUse?.name === FS_WRITE || toolUse?.name === FS_REPLACE) {
                const input = toolUse.input as unknown as FsWriteParams | FsReplaceParams
                this.#features.lsp.workspace.openFileDiff({
                    originalFileUri: input.path,
                    originalFileContent: toolUse.fileChange?.before,
                    isDeleted: false,
                    fileContent: toolUse.fileChange?.after,
                })
            } else if (toolUse?.name === FS_READ) {
                await this.#features.lsp.window.showDocument({ uri: URI.file(params.filePath).toString() })
            } else {
                const absolutePath = params.fullPath ?? (await this.#resolveAbsolutePath(params.filePath))
                if (absolutePath) {
                    await this.#features.lsp.window.showDocument({ uri: URI.file(absolutePath).toString() })
                }
            }
        } catch (e: any) {
            this.#features.logging.error(`Error opening file: ${e.message}`)
        }
    }

    async onFollowUpClicked(params: FollowUpClickParams) {
        this.#log(`onFollowUpClicked: ${JSON.stringify(params)}`)

        // if (params.followUp.type === '...') {
        //     ...
        // }
    }

    onInfoLinkClick() {}

    onLinkClick() {}

    /**
     * After the Chat UI (mynah-ui) is ready.
     */
    async onReady() {
        await this.restorePreviousChats()
        this.#contextCommandsProvider.onReady()
        try {
            const localProjectContextController = await LocalProjectContextController.getInstance()
            const contextItems = await localProjectContextController.getContextCommandItems()
            this.#contextCommandsProvider.setFilesAndFoldersPending(false)
            await this.#contextCommandsProvider.processContextCommandUpdate(contextItems)
            void this.#contextCommandsProvider.maybeUpdateCodeSymbols()
        } catch (error) {
            this.#contextCommandsProvider.setFilesAndFoldersFailed(true)
            await this.#contextCommandsProvider.processContextCommandUpdate([])
            this.#log('Error initializing context commands: ' + error)
        }
    }

    onSendFeedback({ tabId, feedbackPayload }: FeedbackParams) {
        this.#features.telemetry.emitMetric({
            name: 'amazonq_sendFeedback',
            data: {
                comment: JSON.stringify({
                    type: 'codewhisperer-chat-answer-feedback',
                    conversationId: this.#telemetryController.getConversationId(tabId) ?? '',
                    messageId: feedbackPayload.messageId,
                    reason: feedbackPayload.selectedOption,
                    userComment: feedbackPayload.comment,
                }),
                // this is always Negative because only thumbs down has a form
                sentiment: 'Negative',
            },
        })
    }

    onSourceLinkClick() {}

    onTabAdd(params: TabAddParams) {
        this.#telemetryController.activeTabId = params.tabId

        if (!params.restoredTab) {
            this.sendPinnedContext(params.tabId)
        }

        const sessionResult = this.#chatSessionManagementService.createSession(params.tabId)
        const { data: session, success } = sessionResult
        if (!success) {
            return new ResponseError<ChatResult>(ErrorCodes.InternalError, sessionResult.error)
        }

        // Get the saved pair programming mode from the database or default to true if not found
        const savedPairProgrammingMode = this.#chatHistoryDb.getPairProgrammingMode()
        session.pairProgrammingMode = savedPairProgrammingMode !== undefined ? savedPairProgrammingMode : true
        if (session) {
            // Set the logging object on the session
            session.setLogging(this.#features.logging)
        }

        // Update the client with the initial pair programming mode
        this.#features.chat.chatOptionsUpdate({
            tabId: params.tabId,
            // Type assertion to support pairProgrammingMode
            ...(session.pairProgrammingMode !== undefined ? { pairProgrammingMode: session.pairProgrammingMode } : {}),
        } as ChatUpdateParams)
        this.setPaidTierMode(params.tabId)
    }

    onTabChange(params: TabChangeParams) {
        this.#telemetryController.emitConversationMetric({
            name: ChatTelemetryEventName.ExitFocusConversation,
            data: {},
        })

        this.#telemetryController.activeTabId = params.tabId

        this.sendPinnedContext(params.tabId)

        this.#telemetryController.emitConversationMetric({
            name: ChatTelemetryEventName.EnterFocusConversation,
            data: {},
        })

        this.setPaidTierMode(params.tabId)
    }

    sendPinnedContext(tabId: string) {
        this.#additionalContextProvider.sendPinnedContext(tabId)
    }

    onTabRemove(params: TabRemoveParams) {
        if (this.#telemetryController.activeTabId === params.tabId) {
            this.#telemetryController.emitConversationMetric({
                name: ChatTelemetryEventName.ExitFocusConversation,
                data: {},
            })
            this.#telemetryController.activeTabId = undefined
        }
        this.#chatHistoryDb.updateTabOpenState(params.tabId, false)
        this.#chatSessionManagementService.deleteSession(params.tabId)
        this.#telemetryController.removeConversation(params.tabId)
    }

    onQuickAction(params: QuickActionParams, _cancellationToken: CancellationToken) {
        switch (params.quickAction) {
            case QuickAction.Clear: {
                const sessionResult = this.#chatSessionManagementService.getSession(params.tabId)

                this.#telemetryController.emitChatMetric({
                    name: ChatTelemetryEventName.RunCommand,
                    data: {
                        cwsprChatCommandType: params.quickAction,
                    },
                })

                this.#telemetryController.removeConversation(params.tabId)
                this.#chatHistoryDb.clearTab(params.tabId)

                sessionResult.data?.clear()

                return {}
            }

            case QuickAction.Help:
                this.#telemetryController.emitChatMetric({
                    name: ChatTelemetryEventName.RunCommand,
                    data: {
                        cwsprChatCommandType: params.quickAction,
                    },
                })
                return {
                    messageId: uuid(),
                    body: HELP_MESSAGE,
                }

            default:
                return {}
        }
    }

    onPinnedContextAdd(params: PinnedContextParams) {
        this.#additionalContextProvider.onPinnedContextAdd(params)
    }

    onPinnedContextRemove(params: PinnedContextParams) {
        this.#additionalContextProvider.onPinnedContextRemove(params)
    }

    async onTabBarAction(params: TabBarActionParams) {
        return this.#tabBarController.onTabBarAction(params)
    }

    async #getInlineChatTriggerContext(params: InlineChatParams) {
        let triggerContext: TriggerContext = await this.#triggerContext.getNewTriggerContext(params)
        return triggerContext
    }

    async #resolveAbsolutePath(relativePath: string): Promise<string | undefined> {
        try {
            const workspaceFolders = workspaceUtils.getWorkspaceFolderPaths(this.#features.workspace)
            for (const workspaceRoot of workspaceFolders) {
                const candidatePath = path.join(workspaceRoot, relativePath)
                if (await this.#features.workspace.fs.exists(candidatePath)) {
                    return candidatePath
                }
            }

            // handle prompt file outside of workspace
            if (relativePath.endsWith(promptFileExtension)) {
                const promptPath = path.join(getUserPromptsDirectory(), relativePath)
                if (await this.#features.workspace.fs.exists(promptPath)) {
                    return promptPath
                }
            }

            this.#features.logging.error(`File not found: ${relativePath}`)
        } catch (e: any) {
            this.#features.logging.error(`Error resolving absolute path: ${e.message}`)
        }

        return undefined
    }

    async #getTriggerContext(params: ChatParams, metric: Metric<CombinedConversationEvent>) {
        const lastMessageTrigger = this.#telemetryController.getLastMessageTrigger(params.tabId)

        let triggerContext: TriggerContext

        // this is the only way we can detect a follow up action
        // we can reuse previous trigger information
        if (lastMessageTrigger?.followUpActions?.has(params.prompt?.prompt ?? '')) {
            await this.#telemetryController.emitInteractWithMessageMetric(params.tabId, {
                cwsprChatMessageId: lastMessageTrigger.messageId!,
                cwsprChatInteractionType: ChatInteractionType.ClickFollowUp,
            })

            triggerContext = lastMessageTrigger
        } else {
            triggerContext = await this.#triggerContext.getNewTriggerContext(params)
            triggerContext.triggerType = this.#telemetryController.getCurrentTrigger(params.tabId) ?? 'click'
        }

        metric.mergeWith({
            cwsprChatUserIntent: triggerContext?.userIntent,
            cwsprChatProgrammingLanguage: triggerContext?.programmingLanguage?.languageName,
            cwsprChatRequestLength: params.prompt?.prompt?.length ?? 0,
            cwsprChatTriggerInteraction: triggerContext?.triggerType,
            cwsprChatHasCodeSnippet: triggerContext.hasCodeSnippet ?? false,
            cwsprChatActiveEditorTotalCharacters: triggerContext.totalEditorCharacters ?? 0,
        })

        return triggerContext
    }

    async #invalidateCompactCommand(tabId: string, messageIds: string[]) {
        for (const messageId of messageIds) {
            await this.#features.chat.sendChatUpdate({
                tabId,
                state: { inProgress: false },
                data: {
                    messages: [
                        {
                            messageId,
                            type: 'tool',
                            body: 'Compaction is skipped.',
                            header: {
                                body: COMPACTION_HEADER_BODY,
                                status: { icon: 'block', text: 'Ignored' },
                                buttons: [],
                            },
                        },
                    ],
                },
            })
        }
    }

    async #invalidateAllShellCommands(tabId: string, session: ChatSessionService) {
        for (const [toolUseId, toolUse] of session.toolUseLookup.entries()) {
            if (toolUse.name !== EXECUTE_BASH || this.#stoppedToolUses.has(toolUseId)) continue

            const params = toolUse.input as unknown as ExecuteBashParams
            const command = params.command

            await this.#features.chat.sendChatUpdate({
                tabId,
                state: { inProgress: false },
                data: {
                    messages: [
                        {
                            messageId: toolUseId,
                            type: 'tool',
                            body: `\`\`\`shell\n${command}\n\`\`\``,
                            header: {
                                body: 'shell',
                                status: { icon: 'block', text: 'Ignored' },
                                buttons: [],
                            },
                        },
                    ],
                },
            })

            this.#stoppedToolUses.add(toolUseId)
        }
    }

    /**
     * Shows a "limit reached" message in the client, with action buttons.
     */
    showFreeTierLimitMsgOnClient(tabId?: string) {
        const upgradeBtn = { title: `Subscribe to ${qProName}` }
        const learnBtn = { title: 'Learn More' }
        this.#features.lsp.window
            .showMessageRequest({
                type: MessageType.Warning,
                message: freeTierLimitUserMsg,
                actions: [upgradeBtn, learnBtn],
            })
            .then(r => {
                if (r?.title === upgradeBtn.title) {
                    return this.onManageSubscription(tabId ?? '')
                } else if (r?.title === learnBtn.title) {
                    onPaidTierLearnMore(this.#features.lsp, this.#features.logging)
                }
            })
            .catch((e: any) => {
                if (e instanceof timeoutUtils.AsyncTimeoutError) {
                    return // Message is optional, does not require user action.
                }
                this.#log(`setPaidTierMode: showMessageRequest failed: ${(e as Error).message}`)
            })
    }

    /**
     * Updates the "Upgrade Q" (subscription tier) state of the UI in the chat component. If `mode` is not given, the user's subscription status is checked by calling the Q service.
     *
     * `mode` behavior:
     *  - 'freetier': chat-ui clears "limit reached" UI, if any.
     *  - 'freetier-limit':
     *      - client (IDE) shows a message.
     *      - chat-ui shows a chat card.
     *  - 'paidtier': disable any "free-tier limit" UI.
     *  - 'upgrade-pending': chat-ui shows a progress spinner.
     */
    setPaidTierMode(tabId?: string, mode?: PaidTierMode) {
        const isBuilderId = getSsoConnectionType(this.#features.credentialsProvider) === 'builderId'
        if (!isBuilderId) {
            return
        }

        if (mode === 'freetier' && this.#paidTierMode === 'freetier-limit') {
            // mode = 'freetier-limit' // Sticky while 'freetier'.
        } else if (mode === 'freetier-limit' && mode !== this.#paidTierMode) {
            this.showFreeTierLimitMsgOnClient(tabId)
        } else if (!mode) {
            // Use cached status if already known, to avoid excessive CreateSubscriptionToken calls.
            if (this.#paidTierMode) {
                mode = this.#paidTierMode
            } else {
                // Deduplicate in-flight requests: if a getSubscriptionStatus call is already
                // in progress (e.g. multiple tabs opened before the first promise settles),
                // reuse the same promise instead of firing additional API calls.
                if (!this.#subscriptionStatusPromise) {
                    this.#subscriptionStatusPromise =
                        this.#serviceManager
                            ?.getCodewhispererService()
                            .getSubscriptionStatus(true)
                            .then(o => {
                                this.#log(
                                    `setPaidTierMode: getSubscriptionStatus: ${o.status} ${o.encodedVerificationUrl}`
                                )
                                this.setPaidTierMode(tabId, o.status !== 'none' ? 'paidtier' : 'freetier')
                            })
                            .catch(err => {
                                // Clear the promise so the next call can retry.
                                this.#subscriptionStatusPromise = undefined
                                this.#log(`setPaidTierMode: getSubscriptionStatus failed: ${(err as Error).message}`)
                                const isAccessDenied = (err as Error).name === 'AccessDeniedException'
                                const message = isAccessDenied
                                    ? `To increase your limit, subscribe to a Kiro subscription. Choose the right [plan](https://kiro.dev/pricing/) and log in to [app.kiro.dev](https://app.kiro.dev/signin), pick the plan, and once active, you should be able to continue and use Q and Kiro services with the new limits. If you have questions, refer to our [FAQs](https://aws.amazon.com/q/developer/faqs/?p=qdev&z=subnav&loc=8#general)`
                                    : `setPaidTierMode: getSubscriptionStatus failed: ${fmtError(err)}`
                                this.#features.lsp.window
                                    .showMessage({
                                        message,
                                        type: MessageType.Error,
                                    })
                                    .catch(e => {
                                        this.#log(`setPaidTierMode: showMessage failed: ${(e as Error).message}`)
                                    })
                            }) ?? Promise.resolve()
                }
                return
            }
        }

        this.#paidTierMode = mode
        this.#log(`setPaidTierMode: mode=${mode}`)

        const o: ChatUpdateParams = {
            tabId: tabId ?? '',
            // data: { messages: [] },
        }
        // Special flag recognized by `chat-client/src/client/mynahUi.ts`.
        ;(o as any).paidTierMode = mode
        this.#features.chat.sendChatUpdate(o)
    }

    /**
     * Handles when a builder-id (not IdC) user invoked "Manage Subscription" or "Upgrade Q".
     *
     * - Navigates to the "Manage Subscription" page for PAID-TIER user.
     * - Starts the "Upgrade Q" flow for a FREE-TIER user:
     *   1. `awsAccountId` was provided by the IDE extension.
     *   2. Call `createSubscriptionToken(awsAccountId)`.
     *   3. Set the UI to show "Waiting…" progress indicator.
     *   4. Return result, and...
     *   5. ASYNCHRONOUSLY poll subscription status until success.
     *      - Update the UI on success/failure.
     *
     * If `awsAccountId` is not given:
     * - For FREE-TIER user: prompts for AWS account.
     * - For PAID-TIER user: navigates to the "Manage Subscription" AWS console page.
     *
     * @param awsAccountId AWS account ID to create subscription for
     * @returns `undefined` on success, or error message on failure.
     */
    async onManageSubscription(tabId: string, awsAccountId?: string): Promise<string | undefined> {
        const client = this.#serviceManager?.getCodewhispererService()
        if (!awsAccountId) {
            // If no awsAccountId was provided:
            // 1. Check if the user is subscribed.
            //    - If not subscribed, start the "Upgrade Q" flow (request awsAccountId).
            //    - If subscribed, navigate user to the generic "Manage Subscriptions" AWS console page.
            //
            // Note: intentionally async.
            client
                ?.getSubscriptionStatus()
                .then(o => {
                    this.#log(`onManageSubscription: getSubscriptionStatus: ${o.status} ${o.encodedVerificationUrl}`)

                    if (o.status !== 'none') {
                        // Paid-tier user: navigate them to the "Manage Subscriptions" AWS console page.
                        const uri = paidTierManageSubscription
                        this.#features.lsp.window
                            .showDocument({
                                external: true, // Client is expected to open the URL in a web browser.
                                uri: uri,
                            })
                            .catch(e => {
                                this.#log(`onManageSubscription: showDocument failed: ${fmtError(e)}`)
                            })
                    } else {
                        // Free-tier user: navigate them to "Upgrade Q" flow in AWS console.
                        const uri = o.encodedVerificationUrl

                        if (!uri) {
                            this.#log('onManageSubscription: missing encodedVerificationUrl in server response')
                            this.#features.lsp.window
                                .showMessage({
                                    message: 'Subscription request failed.',
                                    type: MessageType.Error,
                                })
                                .catch(e => {
                                    this.#log(`onManageSubscription: showMessage failed: ${(e as Error).message}`)
                                })
                            return 'missing encodedVerificationUrl in server response'
                        }

                        try {
                            URI.parse(uri)
                        } catch (e) {
                            this.#log(
                                `onManageSubscription: invalid encodedVerificationUrl: '${uri}': ${(e as Error).message}`
                            )
                            return 'invalid encodedVerificationUrl'
                        }

                        this.#log(
                            `onManageSubscription: createSubscriptionToken status: ${o.status} encodedVerificationUrl: '${uri}'`
                        )
                        // Set UI to "progress" mode.
                        this.setPaidTierMode(tabId, 'upgrade-pending')

                        // Navigate user to the browser, where they will complete "Upgrade Q" flow.
                        this.#features.lsp.window
                            .showDocument({
                                external: true, // Client is expected to open the URL in a web browser.
                                uri: uri,
                            })
                            .catch(e => {
                                this.#log(`showDocument failed: ${(e as Error).message}`)
                            })

                        // Now asynchronously wait for the user to complete the "Upgrade Q" flow.
                        client
                            .waitUntilSubscriptionActive()
                            .then(r => {
                                if (r !== true) {
                                    this.setPaidTierMode(tabId, 'freetier')

                                    this.#features.lsp.window
                                        .showMessage({
                                            message: 'Timeout or cancellation while waiting for Amazon Q subscription',
                                            type: MessageType.Error,
                                        })
                                        .catch(e => {
                                            this.#log(
                                                `onManageSubscription: showMessage failed: ${(e as Error).message}`
                                            )
                                        })

                                    return
                                }

                                this.setPaidTierMode(tabId, 'paidtier')

                                this.#features.lsp.window
                                    .showMessage({
                                        message: `Upgraded to ${qProName}`,
                                        type: MessageType.Info,
                                    })
                                    .catch(e => {
                                        this.#log(`onManageSubscription: showMessage failed: ${(e as Error).message}`)
                                    })
                            })
                            .catch((e: any) => {
                                this.#log(
                                    `onManageSubscription: waitUntilSubscriptionActive failed: ${(e as Error).message}`
                                )
                            })
                    }
                })
                .catch(e => {
                    this.#log(`onManageSubscription: getSubscriptionStatus failed: ${(e as Error).message}`)
                    const isAccessDenied = (e as Error).name === 'AccessDeniedException'
                    const message = isAccessDenied
                        ? `To increase your limit, subscribe to a Kiro subscription. Choose the right [plan](https://kiro.dev/pricing/) and log in to [app.kiro.dev](https://app.kiro.dev/signin), pick the plan, and once active, you should be able to continue and use Q and Kiro services with the new limits. If you have questions, refer to our [FAQs](https://aws.amazon.com/q/developer/faqs/?p=qdev&z=subnav&loc=8#general)`
                        : `onManageSubscription: getSubscriptionStatus failed: ${fmtError(e)}`
                    this.#features.lsp.window
                        .showMessage({
                            message,
                            type: MessageType.Error,
                        })
                        .catch(e => {
                            this.#log(`onManageSubscription: showMessage failed: ${(e as Error).message}`)
                        })
                })

            return
        }
    }

    async #processAgenticChatResponseWithTimeout(
        response: ChatCommandOutput,
        metric: Metric<AddMessageEvent>,
        chatResultStream: AgenticChatResultStream,
        session: ChatSessionService,
        contextList?: FileList,
        isCompaction?: boolean
    ): Promise<Result<AgenticChatResultWithMetadata, string>> {
        const abortController = new AbortController()
        let timeoutId: NodeJS.Timeout | undefined
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
                abortController.abort()
                reject(
                    new AgenticChatError(
                        `${RESPONSE_TIMEOUT_PARTIAL_MSG} ${RESPONSE_TIMEOUT_MS}ms`,
                        'ResponseProcessingTimeout'
                    )
                )
            }, RESPONSE_TIMEOUT_MS)
        })
        const streamWriter = chatResultStream.getResultStreamWriter()
        const processResponsePromise = this.#processAgenticChatResponse(
            response,
            metric,
            chatResultStream,
            streamWriter,
            session,
            contextList,
            abortController.signal,
            isCompaction
        )
        try {
            const result = await Promise.race([processResponsePromise, timeoutPromise])
            clearTimeout(timeoutId)
            return result
        } catch (err) {
            clearTimeout(timeoutId)
            await streamWriter.close()
            if (err instanceof AgenticChatError && err.code === 'ResponseProcessingTimeout') {
                return { success: false, error: err.message }
            }
            throw err
        }
    }

    async #showToolUseIntermediateResult(
        data: AgenticChatResultWithMetadata,
        chatResultStream: AgenticChatResultStream,
        streamWriter: ResultStreamWriter
    ) {
        // extract the key value from incomplete JSON response stream
        function extractKey(incompleteJson: string, key: string): string | undefined {
            const pattern = new RegExp(`"${key}":\\s*"([^"]*)"`, 'g')
            const match = pattern.exec(incompleteJson)
            return match?.[1]
        }
        const toolUses = Object.values(data.toolUses)
        for (const toolUse of toolUses) {
            if ((toolUse.name === FS_WRITE || toolUse.name === FS_REPLACE) && typeof toolUse.input === 'string') {
                const filepath = extractKey(toolUse.input, 'path')
                const msgId = progressPrefix + toolUse.toolUseId
                // render fs write UI as soon as fs write starts
                if (filepath && !chatResultStream.hasMessage(msgId)) {
                    const fileName = path.basename(filepath)
                    await streamWriter.close()
                    await chatResultStream.writeResultBlock({
                        type: 'tool',
                        messageId: msgId,
                        header: {
                            fileList: {
                                filePaths: [fileName],
                                details: {
                                    [fileName]: {
                                        description: filepath,
                                    },
                                },
                            },
                            status: {
                                status: 'info',
                                icon: 'progress',
                                text: '',
                            },
                        },
                    })
                }
                // render the tool use explanatory as soon as this is received for fsWrite/fsReplace
                const explanation = extractKey(toolUse.input, 'explanation')
                const messageId = progressPrefix + toolUse.toolUseId + SUFFIX_EXPLANATION
                if (explanation && !chatResultStream.hasMessage(messageId)) {
                    await streamWriter.close()
                    await chatResultStream.writeResultBlock({
                        type: 'directive',
                        messageId: messageId,
                        body: explanation,
                    })
                }
            }
        }
    }

    async #processAgenticChatResponse(
        response: ChatCommandOutput,
        metric: Metric<AddMessageEvent>,
        chatResultStream: AgenticChatResultStream,
        streamWriter: ResultStreamWriter,
        session: ChatSessionService,
        contextList?: FileList,
        abortSignal?: AbortSignal,
        isCompaction?: boolean
    ): Promise<Result<AgenticChatResultWithMetadata, string>> {
        const requestId = response.$metadata.requestId!
        const chatEventParser = new AgenticChatEventParser(requestId, metric, this.#features.logging)

        // Display context transparency list once at the beginning of response
        // Use a flag to track if contextList has been sent already to avoid ux flickering
        if (!isCompaction && contextList?.filePaths && contextList.filePaths.length > 0 && !session.contextListSent) {
            await streamWriter.write({ body: '', contextList })
            session.contextListSent = true
        }
        const toolUseStartTimes: Record<string, number> = {}
        const toolUseLoadingTimeouts: Record<string, NodeJS.Timeout> = {}
        let chatEventStream = undefined
        if ('generateAssistantResponseResponse' in response) {
            chatEventStream = response.generateAssistantResponseResponse
        } else if ('sendMessageResponse' in response) {
            chatEventStream = response.sendMessageResponse
        }
        let isEmptyResponse = true
        for await (const chatEvent of chatEventStream!) {
            isEmptyResponse = false
            if (abortSignal?.aborted) {
                throw new Error('Operation was aborted')
            }
            // assistantResponseEvent is present in ChatResponseStream - used by both SendMessage and GenerateAssistantResponse
            // https://code.amazon.com/packages/AWSVectorConsolasPlatformModel/blobs/mainline/--/model/types/conversation_types.smithy
            if (chatEvent.assistantResponseEvent) {
                await this.#showUndoAllIfRequired(chatResultStream, session)
            }
            const result = chatEventParser.processPartialEvent(chatEvent)

            // terminate early when there is an error
            if (!result.success) {
                await streamWriter.close()
                return result
            }

            // Track when chunks appear to user
            if (chatEvent.assistantResponseEvent && result.data.chatResult.body) {
                this.recordChunk('chunk')
            }

            // update the UI with response
            if (chatEvent.assistantResponseEvent || chatEvent.codeReferenceEvent) {
                await streamWriter.write(result.data.chatResult)
            }

            if (chatEvent.toolUseEvent) {
                await this.#showLoadingIfRequired(
                    chatEvent.toolUseEvent,
                    streamWriter,
                    toolUseStartTimes,
                    toolUseLoadingTimeouts
                )
                await this.#showToolUseIntermediateResult(result.data, chatResultStream, streamWriter)
            }
        }
        if (isEmptyResponse) {
            // If the response is empty, we need to send an empty answer message to remove the Working... indicator
            await streamWriter.write({ type: 'answer', body: '', messageId: uuid() })
        }

        if (isCompaction) {
            // Show a dummy message to the UI for compaction completion
            await streamWriter.write({
                type: 'answer',
                body: 'Conversation history has been compacted successfully!',
                messageId: uuid(),
            })
        }
        await streamWriter.close()

        metric.mergeWith({
            cwsprChatFullResponseLatency: metric.getTimeElapsed(),
            cwsprChatFollowUpCount: chatEventParser.totalEvents.followupPromptEvent,
            cwsprChatReferencesCount: chatEventParser.totalEvents.codeReferenceEvent,
            cwsprChatSourceLinkCount: chatEventParser.totalEvents.supplementaryWebLinksEvent,
            cwsprChatResponseLength: chatEventParser.body?.length ?? 0,
        })

        // Use finalize() (not getResult()) so a tool use whose stream ended before its
        // terminating `stop` event is surfaced as an incomplete-input error and retried,
        // rather than being silently dropped and reported as a successful turn. The abort
        // state is passed in so a timed-out/cancelled request is not misreported as a
        // truncated tool input.
        return chatEventParser.finalize({ aborted: abortSignal?.aborted === true })
    }

    /**
     * This is needed to handle the case where a toolUseEvent takes a long time to resolve the stream and looks like
     * nothing is happening.
     */
    async #showLoadingIfRequired(
        toolUseEvent: ToolUseEvent,
        streamWriter: ResultStreamWriter,
        toolUseStartTimes: Record<string, number>,
        toolUseLoadingTimeouts: Record<string, NodeJS.Timeout>
    ) {
        const canWrite = new Set(this.#features.agent.getBuiltInWriteToolNames())
        if (toolUseEvent.name && canWrite.has(toolUseEvent.name)) {
            return
        }

        const toolUseId = toolUseEvent.toolUseId
        if (!toolUseEvent.stop && toolUseId) {
            if (!toolUseStartTimes[toolUseId]) {
                toolUseStartTimes[toolUseId] = Date.now()
                // Also record in the class-level toolUseStartTimes for latency calculation
                if (!this.#toolUseStartTimes[toolUseId]) {
                    this.#toolUseStartTimes[toolUseId] = Date.now()
                }
                this.#debug(`ToolUseEvent ${toolUseId} started`)
                toolUseLoadingTimeouts[toolUseId] = setTimeout(async () => {
                    this.#debug(
                        `ToolUseEvent ${toolUseId} is taking longer than ${LOADING_THRESHOLD_MS}ms, showing loading indicator`
                    )
                    await streamWriter.write({ ...loadingMessage, messageId: `loading-${toolUseId}` })
                }, LOADING_THRESHOLD_MS)
            }
        } else if (toolUseEvent.stop && toolUseId) {
            if (toolUseStartTimes[toolUseId]) {
                const duration = Date.now() - toolUseStartTimes[toolUseId]
                this.#debug(`ToolUseEvent ${toolUseId} finished streaming after ${duration}ms`)
                if (toolUseLoadingTimeouts[toolUseId]) {
                    clearTimeout(toolUseLoadingTimeouts[toolUseId])
                    delete toolUseLoadingTimeouts[toolUseId]
                }
                delete toolUseStartTimes[toolUseId]
            }
        }
    }

    async #processSendMessageResponseForInlineChat(
        response: ChatCommandOutput,
        metric: Metric<AddMessageEvent>,
        partialResultToken?: string | number
    ): Promise<Result<ChatResultWithMetadata, string>> {
        const requestId = response.$metadata.requestId!
        const chatEventParser = new ChatEventParser(requestId, metric)

        let chatEventStream = undefined
        if ('generateAssistantResponseResponse' in response) {
            chatEventStream = response.generateAssistantResponseResponse
        } else if ('sendMessageResponse' in response) {
            chatEventStream = response.sendMessageResponse
        }

        for await (const chatEvent of chatEventStream!) {
            const result = chatEventParser.processPartialEvent(chatEvent)

            // terminate early when there is an error
            if (!result.success) {
                return result
            }

            await this.#sendProgressToClient(result.data.chatResult, partialResultToken)
        }

        return chatEventParser.getResult()
    }

    /**
     * Calculates time to first chunk and time between chunks
     */
    recordChunk(chunkType: string) {
        if (this.#timeToFirstChunk === -1) {
            this.#timeToFirstChunk = Date.now() - this.#llmRequestStartTime
            this.#lastChunkTime = Date.now()
        } else {
            const timeBetweenChunks = Date.now() - this.#lastChunkTime
            this.#timeBetweenChunks.push(timeBetweenChunks)
            this.#lastChunkTime = Date.now()
            if (chunkType !== 'chunk') {
                this.#debug(
                    `Time between chunks [${chunkType}]: ${timeBetweenChunks}ms (total chunks: ${this.#timeBetweenChunks.length})`
                )
            }
        }
    }

    onPromptInputOptionChange(params: PromptInputOptionChangeParams) {
        const sessionResult = this.#chatSessionManagementService.getSession(params.tabId)
        const { data: session, success } = sessionResult

        if (!success) {
            this.#log('onPromptInputOptionChange: on valid session found')
            return
        }

        session.pairProgrammingMode = params.optionsValues['pair-programmer-mode'] === 'true'
        const newModelId = params.optionsValues['model-selection']

        // Set model (automatically recalculates token limits)
        if (newModelId !== session.modelId) {
            const cachedData = this.#chatHistoryDb.getCachedModels()
            session.setModel(newModelId, cachedData?.models)
            this.#log(`Model set for model switch: ${newModelId}, tokenLimits: ${JSON.stringify(session.tokenLimits)}`)
        }

        this.#chatHistoryDb.setTabModelId(params.tabId, session.modelId)
        this.#chatHistoryDb.setTabPairProgrammingMode(params.tabId, session.pairProgrammingMode)
    }

    updateConfiguration = (newConfig: AmazonQWorkspaceConfig) => {
        this.#customizationArn = newConfig.customizationArn
        if (newConfig.sendUserWrittenCodeMetrics) {
            this.#userWrittenCodeTracker = UserWrittenCodeTracker.getInstance(this.#telemetryService)
        }
        this.#log(`Chat configuration updated customizationArn to ${this.#customizationArn}`)
        /*
            The flag enableTelemetryEventsToDestination is set to true temporarily. It's value will be determined through destination
            configuration post all events migration to STE. It'll be replaced by qConfig['enableTelemetryEventsToDestination'] === true
        */
        // const enableTelemetryEventsToDestination = true
        // this.#telemetryService.updateEnableTelemetryEventsToDestination(enableTelemetryEventsToDestination)
        const updatedOptOutPreference = newConfig.optOutTelemetryPreference
        this.#telemetryService.updateOptOutPreference(updatedOptOutPreference)
        this.#log(`Chat configuration telemetry preference to ${updatedOptOutPreference}`)

        // Force a service request to get current Q user subscription status.
        this.#paidTierMode = undefined
        this.#subscriptionStatusPromise = undefined
    }

    #getTools(session: ChatSessionService) {
        const builtInWriteTools = new Set(this.#features.agent.getBuiltInWriteToolNames())
        const allTools = this.#features.agent.getTools({ format: 'bedrock' })
        if (!enabledMCP(this.#features.lsp.getClientInitializeParams())) {
            if (!session.pairProgrammingMode) {
                return allTools.filter(tool => !builtInWriteTools.has(tool.toolSpecification?.name || ''))
            }
            return allTools
        }

        // Clear tool name mapping to avoid conflicts from previous registrations
        try {
            McpManager.instance.clearToolNameMapping()
        } catch (error) {
            // McpManager not initialized, return tools without MCP
            this.#features.logging.debug(
                `McpManager not initialized in #getTools, returning non-MCP tools with error: ${error}`
            )
            return session.pairProgrammingMode
                ? allTools
                : allTools.filter(tool => !builtInWriteTools.has(tool.toolSpecification?.name || ''))
        }

        const tempMapping = new Map<string, { serverName: string; toolName: string }>()

        // Read Only Tools = All Tools - Restricted Tools (MCP + Write Tools)
        // TODO: mcp tool spec name will be server___tool.
        // TODO: Will also need to handle rare edge cases of long server name + long tool name > 64 char
        const allNamespacedTools = new Set<string>()
        let mcpToolSpecNames: Set<string>
        try {
            mcpToolSpecNames = new Set(
                McpManager.instance
                    .getAllTools()
                    .map(tool =>
                        createNamespacedToolName(tool.serverName, tool.toolName, allNamespacedTools, tempMapping)
                    )
            )
        } catch (error) {
            // McpManager not initialized, use empty set
            this.#features.logging.debug(`McpManager not initialized, cannot get MCP tools because of error: ${error}`)
            mcpToolSpecNames = new Set()
        }

        try {
            McpManager.instance.setToolNameMapping(tempMapping)
        } catch (error) {
            // McpManager not initialized, skip setting mapping
            this.#features.logging.debug(
                `McpManager not initialized, cannot set tool name mapping because of error: ${error}`
            )
        }

        const restrictedToolNames = new Set([...mcpToolSpecNames, ...builtInWriteTools])

        const readOnlyTools = allTools.filter(tool => {
            const toolName = tool.toolSpecification.name
            return !restrictedToolNames.has(toolName)
        })
        return session.pairProgrammingMode ? allTools : readOnlyTools
    }

    async restorePreviousChats() {
        try {
            await this.#tabBarController.loadChats()
        } catch (error) {
            this.#log('Error restoring previous chats: ' + error)
        }
    }

    #createDeferred() {
        let resolve
        let reject
        const promise = new Promise((res, rej) => {
            resolve = res
            reject = (e: Error) => rej(e)
        })
        return { promise, resolve, reject }
    }

    /**
     * Handles the result of an MCP tool execution
     * @param toolUse The tool use object
     * @param result The result from running the tool
     * @param session The chat session
     * @param chatResultStream The chat result stream for writing/updating blocks
     */
    async #handleMcpToolResult(
        toolUse: ToolUse,
        result: any,
        session: ChatSessionService,
        chatResultStream: AgenticChatResultStream
    ): Promise<void> {
        // Early return if name or toolUseId is undefined
        if (!toolUse.name || !toolUse.toolUseId) {
            this.#log(`Cannot handle MCP tool result: missing name or toolUseId`)
            return
        }

        // Get original server and tool names from the mapping
        let originalNames
        try {
            originalNames = McpManager.instance.getOriginalToolNames(toolUse.name)
        } catch (error) {
            // McpManager not initialized, skip MCP tool result handling
            this.#features.logging.debug(
                `McpManager not initialized, cannot handle MCP tool result because of error: ${error}`
            )
            originalNames = undefined
        }

        if (originalNames) {
            const { serverName, toolName } = originalNames
            let def
            try {
                def = McpManager.instance
                    .getAllTools()
                    .find(d => d.serverName === serverName && d.toolName === toolName)
            } catch (error) {
                this.#features.logging.debug(
                    `McpManager not initialized, cannot get tool definitions because of error: ${error}`
                )
                def = undefined
            }
            if (def) {
                // Format the tool result and input as JSON strings
                const toolInput = JSON.stringify(toolUse.input, null, 2)
                const toolResultContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2)

                const toolResultCard: ChatMessage = {
                    type: 'tool',
                    messageId: toolUse.toolUseId,
                    summary: {
                        content: {
                            header: {
                                icon: 'tools',
                                body: `${toolName}`,
                                fileList: undefined,
                            },
                        },
                        collapsedContent: [
                            {
                                header: {
                                    body: 'Parameters',
                                },
                                body: `\`\`\`json\n${toolInput}\n\`\`\``,
                            },
                            {
                                header: {
                                    body: 'Result',
                                },
                                body: `\`\`\`json\n${toolResultContent}\n\`\`\``,
                            },
                        ],
                    },
                }

                // Get the stored blockId for this tool use
                const cachedToolUse = session.toolUseLookup.get(toolUse.toolUseId)
                const cachedButtonBlockId = (cachedToolUse as any)?.cachedButtonBlockId

                if (cachedButtonBlockId !== undefined) {
                    // Update the existing card with the results
                    await chatResultStream.overwriteResultBlock(toolResultCard, cachedButtonBlockId)
                } else {
                    // Fallback to creating a new card
                    if (toolResultCard.summary?.content?.header) {
                        toolResultCard.summary.content.header.status = {
                            status: 'success',
                            icon: 'ok',
                            text: 'Completed',
                        }
                    }
                    this.#log(`Warning: No blockId found for tool use ${toolUse.toolUseId}, creating new card`)
                    await chatResultStream.writeResultBlock(toolResultCard)
                }
                return
            }
        }

        // Fallback for tools not found in mapping
        await chatResultStream.writeResultBlock({
            type: 'tool',
            messageId: toolUse.toolUseId,
            body: toolResultMessage(toolUse, result),
        })
    }

    async #handleSemanticSearchToolResult(
        toolUse: ToolUse,
        result: any,
        session: ChatSessionService,
        chatResultStream: AgenticChatResultStream
    ): Promise<void> {
        // Early return if toolUseId is undefined
        if (!toolUse.toolUseId) {
            this.#log(`Cannot handle semantic search tool result: missing toolUseId`)
            return
        }

        // Format the tool result and input as JSON strings
        const toolInput = JSON.stringify(toolUse.input, null, 2)
        const toolResultContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2)

        const toolResultCard: ChatMessage = {
            type: 'tool',
            messageId: toolUse.toolUseId,
            summary: {
                content: {
                    header: {
                        icon: 'tools',
                        body: `${SemanticSearch.toolName}`,
                        fileList: undefined,
                    },
                },
                collapsedContent: [
                    {
                        header: {
                            body: 'Parameters',
                        },
                        body: `\`\`\`json\n${toolInput}\n\`\`\``,
                    },
                    {
                        header: {
                            body: 'Result',
                        },
                        body: `\`\`\`json\n${toolResultContent}\n\`\`\``,
                    },
                ],
            },
        }

        // Get the stored blockId for this tool use
        const cachedToolUse = session.toolUseLookup.get(toolUse.toolUseId)
        const cachedButtonBlockId = (cachedToolUse as any)?.cachedButtonBlockId

        if (cachedButtonBlockId !== undefined) {
            // Update the existing card with the results
            await chatResultStream.overwriteResultBlock(toolResultCard, cachedButtonBlockId)
        } else {
            // Fallback to creating a new card
            this.#log(`Warning: No blockId found for tool use ${toolUse.toolUseId}, creating new card`)
            await chatResultStream.writeResultBlock(toolResultCard)
        }
    }

    scheduleABTestingFetching(userContext: UserContext | undefined) {
        if (!userContext) {
            return
        }

        this.#abTestingFetchingTimeout = setInterval(() => {
            let codeWhispererServiceToken: CodeWhispererServiceToken
            try {
                codeWhispererServiceToken = AmazonQTokenServiceManager.getInstance().getCodewhispererService()
            } catch (error) {
                // getCodewhispererService only returns the cwspr client if the service manager was initialized
                // i.e. profile was selected otherwise it throws an error
                // we will not evaluate a/b status until profile is selected and service manager is fully initialized
                return
            }

            // Clear interval once we have the CodewhispererService
            clearInterval(this.#abTestingFetchingTimeout)
            this.#abTestingFetchingTimeout = undefined

            codeWhispererServiceToken
                .listFeatureEvaluations({ userContext })
                .then(result => {
                    const feature = result.featureEvaluations?.find(
                        feature =>
                            feature.feature &&
                            ['MaestroWorkspaceContext', 'SematicSearchTool'].includes(feature.feature)
                    )
                    if (feature && feature.feature && feature.variation) {
                        this.#abTestingAllocation = {
                            experimentName: feature.feature,
                            userVariation: feature.variation,
                        }
                    }
                })
                .catch(error => {
                    this.#features.logging.debug(`Error fetching AB testing result: ${error}`)
                })
        }, 5000)
    }

    #log(...messages: string[]) {
        this.#features.logging.log(messages.join(' '))
    }

    #debug(...messages: string[]) {
        this.#features.logging.debug(messages.join(' '))
    }

    // Helper function to sanitize the 'images' field for logging by replacing large binary data (e.g., Uint8Array) with a concise summary.
    // This prevents logs from being overwhelmed by raw byte arrays and keeps log output readable.
    #imageReplacer(key: string, value: any): string | any {
        if (key === 'bytes' && value && typeof value.length === 'number') {
            return `[Uint8Array, length: ${value.length}]`
        }
        return value
    }
}
