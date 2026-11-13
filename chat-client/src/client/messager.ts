/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview
 * The Messager class serves as a communication bridge between the MynahUI chat interface
 * and the host application (e.g., IDE extension). It translates UI events into standardized
 * messages, handles telemetry collection, and provides a clean abstraction layer for sending
 * different types of messages through the OutboundChatApi.
 */

import {
    AuthFollowUpClickedParams,
    CopyCodeToClipboardParams,
    ErrorParams,
    ErrorResult,
    InsertToCursorPositionParams,
    SendToPromptParams,
    TriggerType,
} from '@aws/chat-client-ui-types'
import {
    ButtonClickParams,
    ChatParams,
    ConversationAction,
    ConversationClickParams,
    CreatePromptParams,
    FeedbackParams,
    FileClickParams,
    FilterContextCommandsParams,
    FilterValue,
    FollowUpClickParams,
    GetSerializedChatResult,
    InfoLinkClickParams,
    LinkClickParams,
    ListConversationsParams,
    ListRulesParams,
    ListMcpServersParams,
    McpServerClickParams,
    OpenFileDialogParams,
    OpenTabResult,
    PinnedContextParams,
    PromptInputOptionChangeParams,
    QuickActionParams,
    RuleClickParams,
    SourceLinkClickParams,
    TabAddParams,
    TabBarActionParams,
    TabChangeParams,
    TabRemoveParams,
    ListAvailableModelsParams,
} from '@aws/language-server-runtimes-types'
import { TelemetryParams } from '../contracts/serverContracts'
import {
    ADD_MESSAGE_TELEMETRY_EVENT,
    AUTH_FOLLOW_UP_CLICKED_TELEMETRY_EVENT,
    CHAT_MESSAGE_RENDERED_TELEMETRY_EVENT,
    CHAT_POST_MESSAGE_REJECTED_TELEMETRY_EVENT,
    COPY_TO_CLIPBOARD_TELEMETRY_EVENT,
    ENTER_FOCUS,
    ERROR_MESSAGE_TELEMETRY_EVENT,
    EXIT_FOCUS,
    HISTORY_BUTTON_CLICK_TELEMETRY_EVENT,
    INFO_LINK_CLICK_TELEMETRY_EVENT,
    INSERT_TO_CURSOR_POSITION_TELEMETRY_EVENT,
    LINK_CLICK_TELEMETRY_EVENT,
    SEND_TO_PROMPT_TELEMETRY_EVENT,
    SOURCE_LINK_CLICK_TELEMETRY_EVENT,
    TAB_ADD_TELEMETRY_EVENT,
    VOTE_TELEMETRY_EVENT,
    VoteParams,
} from '../contracts/telemetry'

/**
 * OutboundChatApi defines the interface for sending messages from the chat client
 * to the host application. It provides methods for all supported outbound events.
 */
export interface OutboundChatApi {
    sendChatPrompt(params: ChatParams): void
    sendQuickActionCommand(params: QuickActionParams): void
    tabAdded(params: TabAddParams): void
    tabChanged(params: TabChangeParams): void
    tabRemoved(params: TabRemoveParams): void
    telemetry(params: TelemetryParams): void
    insertToCursorPosition(params: InsertToCursorPositionParams): void
    copyToClipboard(params: CopyCodeToClipboardParams): void
    authFollowUpClicked(params: AuthFollowUpClickedParams): void
    followUpClicked(params: FollowUpClickParams): void
    sendFeedback(params: FeedbackParams): void
    linkClick(params: LinkClickParams): void
    sourceLinkClick(params: SourceLinkClickParams): void
    infoLinkClick(params: InfoLinkClickParams): void
    uiReady(): void
    disclaimerAcknowledged(): void
    chatPromptOptionAcknowledged(messageId: string): void
    onOpenTab(requestId: string, result: OpenTabResult | ErrorResult): void
    createPrompt(params: CreatePromptParams): void
    fileClick(params: FileClickParams): void
    listConversations(params: ListConversationsParams): void
    conversationClick(params: ConversationClickParams): void
    mcpServerClick(params: McpServerClickParams): void
    listMcpServers(params: ListMcpServersParams): void
    tabBarAction(params: TabBarActionParams): void
    onGetSerializedChat(requestId: string, result: GetSerializedChatResult | ErrorResult): void
    promptInputOptionChange(params: PromptInputOptionChangeParams): void
    promptInputButtonClick(params: ButtonClickParams): void
    stopChatResponse(tabId: string): void
    sendButtonClickEvent(params: ButtonClickParams): void
    onOpenSettings(settingKey: string): void
    onRuleClick(params: RuleClickParams): void
    listRules(params: ListRulesParams): void
    onAddPinnedContext(params: PinnedContextParams): void
    onRemovePinnedContext(params: PinnedContextParams): void
    onListAvailableModels(params: ListAvailableModelsParams): void
    onOpenFileDialogClick(params: OpenFileDialogParams): void
    onFilesDropped(params: { tabId: string; files: FileList; insertPosition: number }): void
    filterContextCommands(params: FilterContextCommandsParams): void
}

export class Messager {
    constructor(private readonly chatApi: OutboundChatApi) {}

    onTabAdd = (tabId: string, triggerType?: TriggerType, restoredTab?: boolean): void => {
        this.chatApi.tabAdded({ tabId, restoredTab })
        this.chatApi.telemetry({ triggerType: triggerType ?? 'click', tabId, name: TAB_ADD_TELEMETRY_EVENT })
    }

    onRuleClick = (params: RuleClickParams): void => {
        this.chatApi.onRuleClick(params)
    }

    onTabChange = (tabId: string): void => {
        this.chatApi.tabChanged({ tabId })
    }

    onTabRemove = (tabId: string): void => {
        this.chatApi.tabRemoved({ tabId })
    }

    onUiReady = (): void => {
        this.chatApi.uiReady()
    }

    onDisclaimerAcknowledged = (): void => {
        this.chatApi.disclaimerAcknowledged()
    }

    onChatPromptOptionAcknowledged = (messageId: string): void => {
        this.chatApi.chatPromptOptionAcknowledged(messageId)
    }

    onFocusStateChanged = (focusState: boolean): void => {
        this.chatApi.telemetry({ name: focusState ? ENTER_FOCUS : EXIT_FOCUS })
    }

    // Positive delivery signal — an inbound message was handed to mynah-ui.
    onInboundMessageRendered = (tabId?: string): void => {
        this.chatApi.telemetry({ name: CHAT_MESSAGE_RENDERED_TELEMETRY_EVENT, tabId })
    }

    // Negative signal — an inbound message was rejected/dropped in
    // handleInboundMessage. `reason` distinguishes the drop branch; `command` is included
    // for the unknown-command case.
    onInboundMessageRejected = (reason: string, command?: string, tabId?: string): void => {
        this.chatApi.telemetry({ name: CHAT_POST_MESSAGE_REJECTED_TELEMETRY_EVENT, reason, command, tabId })
    }

    onSendToPrompt = (params: SendToPromptParams, tabId: string): void => {
        this.chatApi.telemetry({ ...params, tabId, name: SEND_TO_PROMPT_TELEMETRY_EVENT })
    }

    onChatPrompt = (params: ChatParams, triggerType?: string): void => {
        this.chatApi.sendChatPrompt(params)

        // Let the server know about the latest trigger interaction on the tabId
        this.chatApi.telemetry({
            triggerType: triggerType ?? 'click',
            tabId: params.tabId,
            name: ADD_MESSAGE_TELEMETRY_EVENT,
        })
    }

    onQuickActionCommand = (params: QuickActionParams): void => {
        this.chatApi.sendQuickActionCommand(params)
    }

    onInsertToCursorPosition = (params: InsertToCursorPositionParams): void => {
        this.chatApi.insertToCursorPosition(params)
        this.chatApi.telemetry({ ...params, name: INSERT_TO_CURSOR_POSITION_TELEMETRY_EVENT })
    }

    onAuthFollowUpClicked = (params: AuthFollowUpClickedParams): void => {
        this.chatApi.authFollowUpClicked(params)
        this.chatApi.telemetry({ ...params, name: AUTH_FOLLOW_UP_CLICKED_TELEMETRY_EVENT })
    }

    onFollowUpClicked = (params: FollowUpClickParams): void => {
        this.chatApi.followUpClicked(params)
    }

    onCopyCodeToClipboard = (params: CopyCodeToClipboardParams): void => {
        this.chatApi.copyToClipboard(params)
        this.chatApi.telemetry({ ...params, name: COPY_TO_CLIPBOARD_TELEMETRY_EVENT })
    }

    onVote = (params: VoteParams): void => {
        this.chatApi.telemetry({ ...params, name: VOTE_TELEMETRY_EVENT })
    }

    onSendFeedback = (params: FeedbackParams): void => {
        this.chatApi.sendFeedback(params)
    }

    onLinkClick = (params: LinkClickParams): void => {
        this.chatApi.linkClick(params)
        this.onLinkClickTelemetry(params)
    }

    /** Records an answer-link click that chat handled itself (a file link or an unsupported link). */
    onLinkClickTelemetry = (params: LinkClickParams): void => {
        this.chatApi.telemetry({ ...params, name: LINK_CLICK_TELEMETRY_EVENT })
    }

    onSourceLinkClick = (params: SourceLinkClickParams): void => {
        this.chatApi.sourceLinkClick(params)
        this.chatApi.telemetry({ ...params, name: SOURCE_LINK_CLICK_TELEMETRY_EVENT })
    }

    onInfoLinkClick = (params: InfoLinkClickParams): void => {
        this.chatApi.infoLinkClick(params)
        this.onInfoLinkClickTelemetry(params)
    }

    /** Records an info-link click that chat handled itself (a file link or an unsupported link). */
    onInfoLinkClickTelemetry = (params: InfoLinkClickParams): void => {
        this.chatApi.telemetry({ ...params, name: INFO_LINK_CLICK_TELEMETRY_EVENT })
    }

    onError = (params: ErrorParams): void => {
        this.chatApi.telemetry({ ...params, name: ERROR_MESSAGE_TELEMETRY_EVENT })
    }

    onOpenTab = (requestId: string, result: OpenTabResult | ErrorResult): void => {
        this.chatApi.onOpenTab(requestId, result)
    }

    onCreatePrompt = (params: CreatePromptParams): void => {
        this.chatApi.createPrompt(params)
    }

    onFileClick = (params: FileClickParams): void => {
        this.chatApi.fileClick(params)
    }

    onListConversations = (filter?: Record<string, FilterValue>, tabButtonClicked?: boolean): void => {
        this.chatApi.listConversations({ filter })
        if (tabButtonClicked) {
            this.chatApi.telemetry({ triggerType: 'click', name: HISTORY_BUTTON_CLICK_TELEMETRY_EVENT })
        }
    }

    onListRules = (params: ListRulesParams): void => {
        this.chatApi.listRules(params)
    }

    onConversationClick = (conversationId: string, action?: ConversationAction): void => {
        this.chatApi.conversationClick({ id: conversationId, action })
    }

    onListMcpServers = (filter?: Record<string, FilterValue>): void => {
        this.chatApi.listMcpServers({ filter })
    }

    onMcpServerClick = (id: string, title?: string, options?: Record<string, string>): void => {
        this.chatApi.mcpServerClick({ id: id, title: title, optionsValues: options })
    }

    onTabBarAction = (params: TabBarActionParams): void => {
        this.chatApi.tabBarAction(params)
    }

    onGetSerializedChat = (requestId: string, result: GetSerializedChatResult | ErrorResult): void => {
        this.chatApi.onGetSerializedChat(requestId, result)
    }

    onPromptInputOptionChange = (params: PromptInputOptionChangeParams): void => {
        this.chatApi.promptInputOptionChange(params)
    }

    onPromptInputButtonClick = (params: ButtonClickParams): void => {
        this.chatApi.promptInputButtonClick(params)
    }

    onStopChatResponse = (tabId: string): void => {
        this.chatApi.stopChatResponse(tabId)
    }

    onButtonClick = (params: ButtonClickParams): void => {
        this.chatApi.sendButtonClickEvent(params)
    }

    onOpenSettings = (settingKey: string): void => {
        this.chatApi.onOpenSettings(settingKey)
    }

    onAddPinnedContext = (params: PinnedContextParams) => {
        this.chatApi.onAddPinnedContext(params)
    }

    onRemovePinnedContext = (params: PinnedContextParams) => {
        this.chatApi.onRemovePinnedContext(params)
    }

    onListAvailableModels = (params: ListAvailableModelsParams): void => {
        this.chatApi.onListAvailableModels(params)
    }

    onOpenFileDialogClick = (params: OpenFileDialogParams): void => {
        this.chatApi.onOpenFileDialogClick(params)
    }

    onFilesDropped = (params: { tabId: string; files: FileList; insertPosition: number }): void => {
        this.chatApi.onFilesDropped(params)
    }

    onFilterContextCommands = (params: FilterContextCommandsParams): void => {
        this.chatApi.filterContextCommands(params)
    }
}
