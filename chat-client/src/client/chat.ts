/* eslint-disable prefer-const */
/**
 * @fileoverview
 * Core module for the Q Chat Client that initializes the chat interface and establishes
 * bidirectional communication between the UI and the host application.
 *
 * This module follows a layered architecture pattern:
 * - UI Layer: MynahUI component renders the chat interface
 * - Messaging Layer: Handles communication between UI and host application
 * - Event Handling Layer: Routes events to appropriate handlers
 */
import {
    AUTH_FOLLOW_UP_CLICKED,
    AuthFollowUpClickedParams,
    CHAT_OPTIONS,
    ChatOptionsMessage,
    COPY_TO_CLIPBOARD,
    CopyCodeToClipboardParams,
    ERROR_MESSAGE,
    ErrorMessage,
    FeatureContext,
    GENERIC_COMMAND,
    GenericCommandMessage,
    INSERT_TO_CURSOR_POSITION,
    InsertToCursorPositionParams,
    SEND_TO_PROMPT,
    SendToPromptMessage,
    UiMessage,
    DISCLAIMER_ACKNOWLEDGED,
    ErrorResult,
    UiResultMessage,
    CHAT_PROMPT_OPTION_ACKNOWLEDGED,
    STOP_CHAT_RESPONSE,
    OPEN_SETTINGS,
    OPEN_FILE_DIALOG,
    FILES_DROPPED,
} from '@aws/chat-client-ui-types'
import {
    BUTTON_CLICK_REQUEST_METHOD,
    CHAT_OPTIONS_UPDATE_NOTIFICATION_METHOD,
    CHAT_REQUEST_METHOD,
    CHAT_UPDATE_NOTIFICATION_METHOD,
    CONTEXT_COMMAND_NOTIFICATION_METHOD,
    CONVERSATION_CLICK_REQUEST_METHOD,
    CREATE_PROMPT_NOTIFICATION_METHOD,
    ChatMessage,
    ChatOptionsUpdateParams,
    ChatParams,
    ChatUpdateParams,
    ContextCommandParams,
    ConversationClickParams,
    ConversationClickResult,
    CreatePromptParams,
    FEEDBACK_NOTIFICATION_METHOD,
    FILE_CLICK_NOTIFICATION_METHOD,
    FOLLOW_UP_CLICK_NOTIFICATION_METHOD,
    FeedbackParams,
    FileClickParams,
    FollowUpClickParams,
    GET_SERIALIZED_CHAT_REQUEST_METHOD,
    GetSerializedChatParams,
    GetSerializedChatResult,
    INFO_LINK_CLICK_NOTIFICATION_METHOD,
    InfoLinkClickParams,
    LINK_CLICK_NOTIFICATION_METHOD,
    LIST_CONVERSATIONS_REQUEST_METHOD,
    LIST_RULES_REQUEST_METHOD,
    LIST_MCP_SERVERS_REQUEST_METHOD,
    LinkClickParams,
    ListConversationsParams,
    ListConversationsResult,
    ListRulesParams,
    ListRulesResult,
    ListMcpServersParams,
    ListMcpServersResult,
    MCP_SERVER_CLICK_REQUEST_METHOD,
    McpServerClickParams,
    McpServerClickResult,
    OPEN_TAB_REQUEST_METHOD,
    OpenTabParams,
    OpenTabResult,
    PINNED_CONTEXT_ADD_NOTIFICATION_METHOD,
    PINNED_CONTEXT_NOTIFICATION_METHOD,
    PINNED_CONTEXT_REMOVE_NOTIFICATION_METHOD,
    PROMPT_INPUT_OPTION_CHANGE_METHOD,
    PinnedContextParams,
    PromptInputOptionChangeParams,
    QUICK_ACTION_REQUEST_METHOD,
    QuickActionParams,
    READY_NOTIFICATION_METHOD,
    RULE_CLICK_REQUEST_METHOD,
    RuleClickParams,
    RuleClickResult,
    SOURCE_LINK_CLICK_NOTIFICATION_METHOD,
    SourceLinkClickParams,
    TAB_ADD_NOTIFICATION_METHOD,
    TAB_BAR_ACTION_REQUEST_METHOD,
    TAB_CHANGE_NOTIFICATION_METHOD,
    TAB_REMOVE_NOTIFICATION_METHOD,
    TabAddParams,
    TabBarActionParams,
    TabChangeParams,
    TabRemoveParams,
    ListAvailableModelsParams,
    LIST_AVAILABLE_MODELS_REQUEST_METHOD,
    ListAvailableModelsResult,
    OpenFileDialogParams,
    OPEN_FILE_DIALOG_METHOD,
    OpenFileDialogResult,
    EXECUTE_SHELL_COMMAND_SHORTCUT_METHOD,
    FILTER_CONTEXT_COMMANDS_REQUEST_METHOD,
    FilterContextCommandsParams,
    FilterContextCommandsResult,
} from '@aws/language-server-runtimes-types'
import { ConfigTexts, MynahUIDataModel, MynahUITabStoreModel } from '@aws/mynah-ui'
import { ServerMessage, TELEMETRY, TelemetryParams } from '../contracts/serverContracts'
import { Messager, OutboundChatApi } from './messager'
import { InboundChatApi, createMynahUi } from './mynahUi'
import { TabFactory } from './tabs/tabFactory'
import { ChatClientAdapter } from '../contracts/chatClientAdapter'
import { toMynahContextCommand, toMynahIcon } from './utils'

const getDefaultTabConfig = (agenticMode?: boolean) => {
    return {
        tabTitle: 'Chat',
        promptInputPlaceholder: `Ask a question. Use${agenticMode ? ' @ to add context,' : ''} / for quick actions`,
    }
}

type ChatClientConfig = Pick<MynahUIDataModel, 'quickActionCommands'> & {
    disclaimerAcknowledged?: boolean
    // Retained for compatibility with clients that still send the former feature-card state.
    pairProgrammingAcknowledged?: boolean
    deprecationNoticeAcknowledged?: boolean
    agenticMode?: boolean
    modelSelectionEnabled?: boolean
    stringOverrides?: Partial<ConfigTexts>
    os?: string
}

export const createChat = (
    clientApi: { postMessage: (msg: UiMessage | UiResultMessage | ServerMessage) => void },
    config?: ChatClientConfig,
    chatClientAdapter?: ChatClientAdapter,
    featureConfigSerialized?: string
) => {
    let mynahApi: InboundChatApi

    const sendMessageToClient = (message: UiMessage | UiResultMessage | ServerMessage) => {
        clientApi.postMessage(message)
    }

    const parseFeatureConfig = (featureConfigSerialized?: string): Map<string, FeatureContext> => {
        try {
            const parsed = JSON.parse(featureConfigSerialized || '[]')
            return new Map<string, FeatureContext>(parsed)
        } catch (error) {
            console.error('Error parsing feature config:', featureConfigSerialized, error)
        }
        return new Map()
    }

    const featureConfig: Map<string, FeatureContext> = parseFeatureConfig(featureConfigSerialized)

    /**
     * Handles incoming messages from the IDE or other sources.
     * Routes messages to appropriate handlers based on command type.
     *
     * 1. Messages with a 'sender' property are routed to the external connector
     *    if one is configured. This supports legacy systems and extensions.
     *
     * 2. Messages without a 'sender' property are processed by the standard
     *    command-based router, which dispatches based on the 'command' field.
     *
     * Security: rejects messages from cross-origin HTTP(S) pages to prevent
     * DOM XSS via untrusted postMessage senders.
     *
     * IMPORTANT: `event.origin` is NOT uniform across the IDE host environments
     * that embed this chat client. The host browser engine -- and, for Eclipse,
     * the engine differs by operating system -- determines the origin value:
     *   - VS Code / JetBrains / Visual Studio webviews: same-origin
     *     (`event.origin` matches `window.location.origin`).
     *   - SageMaker JupyterLab: same-origin (iframe loaded from same domain).
     *   - Eclipse SWT Browser on macOS/Linux (WebKit / WebKitGTK): a normal
     *     HTTP(S) origin derived from the local asset server.
     *   - Eclipse SWT Browser on Windows (Edge WebView2): the chat HTML is
     *     injected via `browser.setText()`, which WebView2 treats as an opaque
     *     origin, so `event.origin` is the empty string "" or the literal
     *     "null". A strict same-origin check (origin !== window.location.origin)
     *     would silently drop EVERY message on this host while the backend still
     *     returns HTTP 200 and the chat appears to hang.
     *
     * Therefore we reject only a real HTTP(S) cross-origin postMessage (the only
     * case reachable by an attacker page) and allow empty, "null", and file://
     * origins through. Any change to this check MUST be validated against every
     * host environment listed above -- especially Eclipse on Windows -- not just
     * the same-origin hosts. See Bug Bounty ticket P389799154.
     *
     * @param event - The message event containing data from the IDE
     */
    const handleInboundMessage = (event: MessageEvent): void => {
        const origin = event.origin
        if (origin && origin !== 'null' && origin.startsWith('http') && origin !== window.location.origin) {
            // Log so any unexpected host environment surfaces in logs rather
            // than silently breaking the chat.
            console.warn('Chat client rejected message from untrusted origin:', origin)
            return
        }
        if (event.data === undefined) {
            return
        }
        const message = event.data

        // 'message.sender' field is used by IDE connector logic to route messages through Chat Client to injected Connector.
        // When detected, chat client will delegate message handling back to IDE connectors.
        if (message?.sender && chatClientAdapter) {
            const connectorEvent = new MessageEvent('message', { data: JSON.stringify(message) })
            chatClientAdapter.handleMessageReceive(connectorEvent)
            return
        }

        switch (message?.command) {
            case EXECUTE_SHELL_COMMAND_SHORTCUT_METHOD:
                mynahApi.executeShellCommandShortCut(message.params)
                break
            case CHAT_REQUEST_METHOD:
                mynahApi.addChatResponse(message.params, message.tabId, message.isPartialResult)
                break
            case CHAT_UPDATE_NOTIFICATION_METHOD: {
                const messageParams = message.params as ChatUpdateParams
                if (messageParams?.tabId === 'mcpserver') {
                    mynahApi.mcpServerClick({ id: 'update-mcp-list' })
                    break
                } else {
                    mynahApi.updateChat(message.params as ChatUpdateParams)
                    break
                }
            }
            case OPEN_TAB_REQUEST_METHOD:
                mynahApi.openTab(message.requestId, message.params as OpenTabParams)
                break
            case SEND_TO_PROMPT:
                mynahApi.sendToPrompt((message as SendToPromptMessage).params)
                break
            case GENERIC_COMMAND:
                mynahApi.sendGenericCommand((message as GenericCommandMessage).params)
                break
            case ERROR_MESSAGE:
                mynahApi.showError((message as ErrorMessage).params)
                break
            case CONTEXT_COMMAND_NOTIFICATION_METHOD:
                mynahApi.sendContextCommands(message.params as ContextCommandParams)
                break
            case FILTER_CONTEXT_COMMANDS_REQUEST_METHOD:
                mynahApi.filterContextCommandsResponse(message.params as FilterContextCommandsResult)
                break
            case PINNED_CONTEXT_NOTIFICATION_METHOD:
                mynahApi.sendPinnedContext(message.params as PinnedContextParams)
                break
            case LIST_CONVERSATIONS_REQUEST_METHOD:
                mynahApi.listConversations(message.params as ListConversationsResult)
                break
            case LIST_RULES_REQUEST_METHOD:
                mynahApi.listRules(message.params as ListRulesResult)
                break
            case RULE_CLICK_REQUEST_METHOD:
                mynahApi.ruleClicked(message.params as RuleClickResult)
                break
            case CONVERSATION_CLICK_REQUEST_METHOD:
                mynahApi.conversationClicked(message.params as ConversationClickResult)
                break
            case LIST_MCP_SERVERS_REQUEST_METHOD:
                mynahApi.listMcpServers(message.params as ListMcpServersResult)
                break
            case MCP_SERVER_CLICK_REQUEST_METHOD:
                mynahApi.mcpServerClick(message.params as McpServerClickResult)
                break
            case OPEN_FILE_DIALOG_METHOD:
                mynahApi.addSelectedFilesToContext(message.params as OpenFileDialogResult)
                break
            case GET_SERIALIZED_CHAT_REQUEST_METHOD:
                mynahApi.getSerializedChat(message.requestId, message.params as GetSerializedChatParams)
                break
            case LIST_AVAILABLE_MODELS_REQUEST_METHOD:
                mynahApi.listAvailableModels(message.params as ListAvailableModelsResult)
                break
            case CHAT_OPTIONS_UPDATE_NOTIFICATION_METHOD:
                if (message.params.modelId !== undefined || message.params.pairProgrammingMode !== undefined) {
                    const tabId = message.params.tabId
                    const options = mynahUi.getTabData(tabId).getStore()?.promptInputOptions
                    mynahUi.updateStore(tabId, {
                        promptInputOptions: options?.map(option => {
                            if (option.id === 'model-selection' && message.params.modelId !== undefined) {
                                return { ...option, value: message.params.modelId }
                            }
                            if (
                                option.id === 'pair-programmer-mode' &&
                                message.params.pairProgrammingMode !== undefined
                            ) {
                                return { ...option, value: message.params.pairProgrammingMode ? 'true' : 'false' }
                            }
                            return option
                        }),
                    })
                } else {
                    tabFactory.setInfoMessages((message.params as ChatOptionsUpdateParams).chatNotifications)
                }
                break
            case CHAT_OPTIONS: {
                const params = (message as ChatOptionsMessage).params

                if (params?.chatNotifications) {
                    tabFactory.setInfoMessages((message.params as ChatOptionsUpdateParams).chatNotifications)
                }

                // Enable reroute FIRST before processing other options
                if ((params as any)?.reroute) {
                    tabFactory.enableReroute()
                }

                if ((params as any)?.codeReviewInChat) {
                    tabFactory.enableCodeReviewInChat()
                }

                if (params?.quickActions?.quickActionsCommandGroups) {
                    const quickActionCommandGroups = params.quickActions.quickActionsCommandGroups.map(group => ({
                        ...group,
                        commands: group.commands.map(command => ({
                            ...command,
                            icon: toMynahIcon(command.icon),
                        })),
                    }))
                    tabFactory.updateQuickActionCommands(quickActionCommandGroups)
                }

                if (params?.mcpServers && config?.agenticMode) {
                    tabFactory.enableMcp()
                }

                if (params?.history) {
                    tabFactory.enableHistory()
                }

                if (params?.export) {
                    tabFactory.enableExport()
                }

                if (params?.showLogs) {
                    tabFactory.enableShowLogs()
                }

                const allExistingTabs: MynahUITabStoreModel = mynahUi.getAllTabs()
                const highlightCommand = featureConfig.get('highlightCommand')

                if (tabFactory.initialTabId && allExistingTabs[tabFactory.initialTabId] && params?.chatNotifications) {
                    // Edge case: push banner message to initial tab when ChatOptions are received
                    // Because initial tab is added to MynahUi store at initialisation,
                    // that tab does not have banner message, which arrives in ChatOptions above.
                    const store = mynahUi.getTabData(tabFactory.initialTabId)?.getStore() || {}
                    const chatItems = store.chatItems || []
                    const updatedInitialItems = tabFactory.getChatItems(false, false, chatItems as ChatMessage[])

                    // First clear the tab, so that messages are not appended https://github.com/aws/mynah-ui/blob/38608dff905b3790d85c73e2911ec7071c8a8cdf/docs/USAGE.md#using-updatestore-function
                    mynahUi.updateStore(tabFactory.initialTabId, {
                        chatItems: [],
                    })
                    mynahUi.updateStore(tabFactory.initialTabId, {
                        chatItems: updatedInitialItems,
                    })
                }

                for (const tabId in allExistingTabs) {
                    mynahUi.updateStore(tabId, {
                        ...tabFactory.getDefaultTabData(),
                        contextCommands: highlightCommand
                            ? [
                                  {
                                      groupName: 'Additional Commands',
                                      commands: [toMynahContextCommand(highlightCommand)],
                                  },
                              ]
                            : [],
                    })
                }
                break
            }
            default:
                // TODO: Report error?
                break
        }
    }

    const chatApi: OutboundChatApi = {
        sendChatPrompt: (params: ChatParams) => {
            sendMessageToClient({ command: CHAT_REQUEST_METHOD, params })
        },
        sendQuickActionCommand: (params: QuickActionParams) => {
            sendMessageToClient({ command: QUICK_ACTION_REQUEST_METHOD, params })
        },
        telemetry: (params: TelemetryParams) => {
            sendMessageToClient({ command: TELEMETRY, params })
        },
        tabAdded: (params: TabAddParams) => {
            sendMessageToClient({ command: TAB_ADD_NOTIFICATION_METHOD, params })
        },
        tabChanged: (params: TabChangeParams) => {
            sendMessageToClient({ command: TAB_CHANGE_NOTIFICATION_METHOD, params })
        },
        tabRemoved: (params: TabRemoveParams) => {
            sendMessageToClient({ command: TAB_REMOVE_NOTIFICATION_METHOD, params })
        },
        insertToCursorPosition: (params: InsertToCursorPositionParams) => {
            sendMessageToClient({ command: INSERT_TO_CURSOR_POSITION, params })
        },
        copyToClipboard: (params: CopyCodeToClipboardParams) => {
            sendMessageToClient({ command: COPY_TO_CLIPBOARD, params })
        },
        authFollowUpClicked: (params: AuthFollowUpClickedParams) => {
            sendMessageToClient({ command: AUTH_FOLLOW_UP_CLICKED, params })
        },
        followUpClicked: (params: FollowUpClickParams) => {
            sendMessageToClient({ command: FOLLOW_UP_CLICK_NOTIFICATION_METHOD, params })
        },
        sendFeedback: (params: FeedbackParams) => {
            sendMessageToClient({ command: FEEDBACK_NOTIFICATION_METHOD, params })
        },
        linkClick: (params: LinkClickParams) => {
            sendMessageToClient({ command: LINK_CLICK_NOTIFICATION_METHOD, params })
        },
        sourceLinkClick: (params: SourceLinkClickParams) => {
            sendMessageToClient({ command: SOURCE_LINK_CLICK_NOTIFICATION_METHOD, params })
        },
        infoLinkClick: (params: InfoLinkClickParams) => {
            sendMessageToClient({ command: INFO_LINK_CLICK_NOTIFICATION_METHOD, params })
        },
        uiReady: () => {
            sendMessageToClient({
                command: READY_NOTIFICATION_METHOD,
            })

            window.addEventListener('message', handleInboundMessage)
        },
        disclaimerAcknowledged: () => {
            sendMessageToClient({ command: DISCLAIMER_ACKNOWLEDGED })
        },
        chatPromptOptionAcknowledged: (messageId: string) => {
            sendMessageToClient({
                command: CHAT_PROMPT_OPTION_ACKNOWLEDGED,
                params: {
                    messageId,
                },
            })
        },
        onOpenTab: (requestId: string, params: OpenTabResult | ErrorResult) => {
            if ('tabId' in params) {
                sendMessageToClient({
                    requestId: requestId,
                    command: OPEN_TAB_REQUEST_METHOD,
                    params: {
                        success: true,
                        result: params as OpenTabResult,
                    },
                })
            } else {
                sendMessageToClient({
                    requestId: requestId,
                    command: OPEN_TAB_REQUEST_METHOD,
                    params: {
                        success: false,
                        error: params as ErrorResult,
                    },
                })
            }
        },
        createPrompt: (params: CreatePromptParams) => {
            sendMessageToClient({ command: CREATE_PROMPT_NOTIFICATION_METHOD, params })
        },
        fileClick: (params: FileClickParams) => {
            sendMessageToClient({ command: FILE_CLICK_NOTIFICATION_METHOD, params: params })
        },
        listConversations: (params: ListConversationsParams) => {
            sendMessageToClient({ command: LIST_CONVERSATIONS_REQUEST_METHOD, params })
        },
        conversationClick: (params: ConversationClickParams) => {
            sendMessageToClient({ command: CONVERSATION_CLICK_REQUEST_METHOD, params })
        },
        listMcpServers: (params: ListMcpServersParams) => {
            sendMessageToClient({ command: LIST_MCP_SERVERS_REQUEST_METHOD, params })
        },
        mcpServerClick: function (params: McpServerClickParams): void {
            sendMessageToClient({ command: MCP_SERVER_CLICK_REQUEST_METHOD, params })
        },
        tabBarAction: (params: TabBarActionParams) => {
            sendMessageToClient({ command: TAB_BAR_ACTION_REQUEST_METHOD, params })
        },
        onGetSerializedChat: (requestId: string, params: GetSerializedChatResult | ErrorResult) => {
            if ('content' in params) {
                sendMessageToClient({
                    requestId: requestId,
                    command: GET_SERIALIZED_CHAT_REQUEST_METHOD,
                    params: {
                        success: true,
                        result: params as GetSerializedChatResult,
                    },
                })
            } else {
                sendMessageToClient({
                    requestId: requestId,
                    command: GET_SERIALIZED_CHAT_REQUEST_METHOD,
                    params: {
                        success: false,
                        error: params as ErrorResult,
                    },
                })
            }
        },
        promptInputOptionChange: (params: PromptInputOptionChangeParams) => {
            sendMessageToClient({ command: PROMPT_INPUT_OPTION_CHANGE_METHOD, params })
        },
        promptInputButtonClick: params => {
            // TODO
            sendMessageToClient({ command: BUTTON_CLICK_REQUEST_METHOD, params })
        },
        stopChatResponse: (tabId: string) => {
            sendMessageToClient({ command: STOP_CHAT_RESPONSE, params: { tabId } })
        },
        sendButtonClickEvent: params => {
            sendMessageToClient({ command: BUTTON_CLICK_REQUEST_METHOD, params: params })
        },
        onOpenSettings: (settingKey: string) => {
            sendMessageToClient({ command: OPEN_SETTINGS, params: { settingKey } })
        },
        onRuleClick: (params: RuleClickParams) => {
            sendMessageToClient({ command: RULE_CLICK_REQUEST_METHOD, params })
        },
        listRules: (params: ListRulesParams) => {
            sendMessageToClient({ command: LIST_RULES_REQUEST_METHOD, params })
        },
        onAddPinnedContext: (params: PinnedContextParams) => {
            sendMessageToClient({ command: PINNED_CONTEXT_ADD_NOTIFICATION_METHOD, params })
        },
        onRemovePinnedContext: (params: PinnedContextParams) => {
            sendMessageToClient({ command: PINNED_CONTEXT_REMOVE_NOTIFICATION_METHOD, params })
        },
        onListAvailableModels(params: ListAvailableModelsParams) {
            sendMessageToClient({ command: LIST_AVAILABLE_MODELS_REQUEST_METHOD, params })
        },
        onOpenFileDialogClick: (params: OpenFileDialogParams) => {
            sendMessageToClient({ command: OPEN_FILE_DIALOG, params: params })
        },
        onFilesDropped: (params: { tabId: string; files: FileList; insertPosition: number }) => {
            sendMessageToClient({ command: FILES_DROPPED, params: params })
        },
        filterContextCommands: (params: FilterContextCommandsParams) => {
            sendMessageToClient({ command: FILTER_CONTEXT_COMMANDS_REQUEST_METHOD, params })
        },
    }

    const messager = new Messager(chatApi)
    const tabFactory = new TabFactory(getDefaultTabConfig(config?.agenticMode), [
        ...(config?.quickActionCommands ? config.quickActionCommands : []),
    ])

    if (config?.agenticMode) {
        tabFactory.enableAgenticMode()
    }

    if (config?.modelSelectionEnabled) {
        tabFactory.enableModelSelection()
    }

    const [mynahUi, api] = createMynahUi(
        messager,
        tabFactory,
        config?.disclaimerAcknowledged ?? false,
        config?.deprecationNoticeAcknowledged ?? false,
        chatClientAdapter,
        featureConfig,
        !!config?.agenticMode,
        config?.stringOverrides,
        config?.os
    )

    mynahApi = api

    return mynahUi
}
