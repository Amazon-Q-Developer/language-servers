import { TransformationSpec, TransformationStep } from '@amzn/codewhisperer-runtime'
import { CodewhispererLanguage } from '../languageDetection'
import { CancellationJobStatus } from '../../language-server/netTransform/models'
import { UserDecision } from '../../language-server/inline-completion/session/sessionManager'

export type CodewhispererCompletionType = 'Block' | 'Line'

export interface CodeWhispererServiceInvocationEvent {
    codewhispererRequestId?: string
    codewhispererSessionId?: string
    codewhispererLastSuggestionIndex?: number
    codewhispererCompletionType?: CodewhispererCompletionType
    codewhispererTriggerType: string
    codewhispererAutomatedTriggerType?: string
    duration?: number
    codewhispererLineNumber?: number
    codewhispererCursorOffset?: number
    codewhispererLanguage: CodewhispererLanguage
    // TODO: Check if CodewhispererGettingStartedTask is necessary for LSP?
    codewhispererGettingStartedTask?: string
    reason?: string
    credentialStartUrl?: string
    codewhispererCustomizationArn?: string
    codewhispererSupplementalContextTimeout?: boolean
    codewhispererSupplementalContextIsUtg?: boolean
    codewhispererSupplementalContextLatency?: number
    codewhispererSupplementalContextLength?: number
    codewhispererImportRecommendationEnabled?: boolean
    result?: 'Succeeded' | 'Failed'
    traceId?: string
}

export interface CodeWhispererPerceivedLatencyEvent {
    codewhispererRequestId?: string
    codewhispererSessionId?: string
    codewhispererCompletionType?: CodewhispererCompletionType
    codewhispererTriggerType: string
    duration?: number
    codewhispererLanguage: CodewhispererLanguage
    credentialStartUrl?: string
    codewhispererCustomizationArn?: string
    passive?: boolean
    result?: 'Succeeded' | 'Failed'
}

export interface CodeWhispererUserTriggerDecisionEvent {
    codewhispererSessionId: string
    codewhispererFirstRequestId: string
    credentialStartUrl?: string
    codewhispererSuggestionState?: string
    codewhispererCompletionType?: string
    codewhispererLanguage: CodewhispererLanguage
    codewhispererTriggerType: string
    codewhispererAutomatedTriggerType?: string
    codewhispererTriggerCharacter?: string
    codewhispererLineNumber: number
    codewhispererCursorOffset: number
    codewhispererSuggestionCount: number
    codewhispererClassifierResult?: number
    codewhispererClassifierThreshold?: number
    codewhispererTotalShownTime: number
    codewhispererTypeaheadLength: number // TODO
    codewhispererTimeSinceLastDocumentChange?: number // TODO
    // Data about previous triggers may be not available if client results were not sent in order
    codewhispererTimeSinceLastUserDecision?: number
    codewhispererTimeToFirstRecommendation: number
    codewhispererPreviousSuggestionState?: string
    codewhispererCustomizationArn?: string
    codewhispererSupplementalContextTimeout?: boolean
    codewhispererSupplementalContextIsUtg?: boolean
    codewhispererSupplementalContextLength?: number
    codewhispererCharactersAccepted?: number
    codewhispererSuggestionImportCount?: number
    codewhispererSupplementalContextStrategyId?: string
}

export interface CodeWhispererUserModificationEvent {
    codewhispererRequestId?: string
    codewhispererSessionId?: string
    codewhispererCompletionType?: string
    codewhispererTriggerType: string
    codewhispererLanguage: string
    codewhispererModificationPercentage: number
    credentialStartUrl?: string
    codewhispererCharactersAccepted?: number
    codewhispererCharactersModified?: number
}

// 2tracker
export interface CodeWhispererCodePercentageEvent {
    codewhispererTotalTokens: number
    codewhispererLanguage: string
    codewhispererAcceptedTokens?: number
    codewhispererSuggestedTokens: number
    codewhispererPercentage: number
    successCount: number
    codewhispererCustomizationArn?: string
    credentialStartUrl?: string
}

export interface UserWrittenPercentageEvent {
    codewhispererLanguage: string
    userWrittenCodeCharacterCount: number
    userWrittenCodeLineCount: number
}

export interface CodeWhispererUserDecisionEvent {
    codewhispererRequestId?: string
    codewhispererSessionId?: string
    codewhispererCompletionType?: CodewhispererCompletionType
    codewhispererTriggerType: string
    codewhispererLanguage: CodewhispererLanguage
    credentialStartUrl?: string
    codewhispererSuggestionIndex: number
    codewhispererSuggestionState?: UserDecision
    codewhispererSuggestionReferences?: string[]
    codewhispererSuggestionReferenceCount: number
    codewhispererSupplementalContextTimeout?: boolean
    codewhispererSupplementalContextIsUtg?: boolean
    codewhispererSupplementalContextLength?: number
}

export type Result = 'Succeeded' | 'Failed' | 'Cancelled'

export interface SecurityScanEvent {
    codewhispererCodeScanJobId?: string
    codewhispererLanguage: CodewhispererLanguage
    codewhispererCodeScanProjectBytes?: number
    codewhispererCodeScanSrcPayloadBytes: number
    codewhispererCodeScanBuildPayloadBytes?: number
    codewhispererCodeScanSrcZipFileBytes: number
    codewhispererCodeScanBuildZipFileBytes?: number
    codewhispererCodeScanLines: number
    duration: number
    contextTruncationDuration: number
    artifactsUploadDuration: number
    codeScanServiceInvocationsDuration: number
    result: Result
    reason?: string
    codewhispererCodeScanTotalIssues: number
    codewhispererCodeScanIssuesWithFixes: number
    credentialStartUrl: string | undefined
}

export interface TransformationJobStartedEvent {
    category: string
    transformationJobId: string | undefined
    uploadId: string | undefined
    error: string
}

export interface TransformationJobReceivedEvent {
    category: string
    transformationJobId: string
    transformationJobStatus: string
    creationTime: Date
    startExecutionTime: Date
    endExecutionTime: Date
    reason: string
    transformationSpec: TransformationSpec
}

export interface TransformationPlanReceivedEvent {
    category: string
    transformationJobId: string
    transformationSteps: TransformationStep[] | undefined
}

export interface TransformationJobCancelledEvent {
    category: string
    transformationJobId: string
    cancellationJobStatus: CancellationJobStatus
}

export interface TransformationJobArtifactsDownloadedEvent {
    category: string
    transformationJobId: string
    error: string
}

export interface PollingCancelledEvent {
    CancelPollingEnabled: Boolean
}

export interface TransformationFailureEvent {
    [key: string]: any
    category: string
    transformationJobId?: string
}

export enum ChatTelemetryEventName {
    EnterFocusChat = 'amazonq_enterFocusChat',
    ExitFocusChat = 'amazonq_exitFocusChat',
    EnterFocusConversation = 'amazonq_enterFocusConversation',
    ExitFocusConversation = 'amazonq_exitFocusConversation',
    StartConversation = 'amazonq_startConversation',
    InteractWithMessage = 'amazonq_interactWithMessage',
    AddMessage = 'amazonq_addMessage',
    RunCommand = 'amazonq_runCommand',
    MessageResponseError = 'amazonq_messageResponseError',
    ModifyCode = 'amazonq_modifyCode',
    ToolUseSuggested = 'amazonq_toolUseSuggested',
    AgencticLoop_InvokeLLM = 'amazonq_invokeLLM',
    InteractWithAgenticChat = 'amazonq_interactWithAgenticChat',
    MCPConfig = 'amazonq_mcpConfig',
    MCPServerInit = 'amazonq_mcpServerInit',
    LoadHistory = 'amazonq_loadHistory',
    CompactHistory = 'amazonq_compactHistory',
    CompactNudge = 'amazonq_compactNudge',
    ChatHistoryAction = 'amazonq_performChatHistoryAction',
    ExportTab = 'amazonq_exportTab',
    UiClick = 'ui_click',
    ActiveUser = 'amazonq_activeUser',
    BashCommand = 'amazonq_bashCommand',
    ChatMessageRendered = 'amazonq_chatMessageRendered',
    ChatPostMessageRejected = 'amazonq_chatPostMessageRejected',
}

export interface ChatTelemetryEventMap {
    [ChatTelemetryEventName.EnterFocusChat]: EnterFocusChatEvent
    [ChatTelemetryEventName.ExitFocusChat]: ExitFocusChatEvent
    [ChatTelemetryEventName.EnterFocusConversation]: EnterFocusConversationEvent
    [ChatTelemetryEventName.ExitFocusConversation]: ExitFocusConversationEvent
    [ChatTelemetryEventName.StartConversation]: StartConversationEvent
    [ChatTelemetryEventName.InteractWithMessage]: InteractWithMessageEvent
    [ChatTelemetryEventName.AddMessage]: AddMessageEvent
    [ChatTelemetryEventName.RunCommand]: RunCommandEvent
    [ChatTelemetryEventName.MessageResponseError]: MessageResponseErrorEvent
    [ChatTelemetryEventName.ModifyCode]: ModifyCodeEvent
    [ChatTelemetryEventName.ToolUseSuggested]: ToolUseSuggestedEvent
    [ChatTelemetryEventName.AgencticLoop_InvokeLLM]: AgencticLoop_InvokeLLMEvent
    [ChatTelemetryEventName.InteractWithAgenticChat]: InteractWithAgenticChatEvent
    [ChatTelemetryEventName.MCPConfig]: MCPConfigEvent
    [ChatTelemetryEventName.MCPServerInit]: MCPServerInitializeEvent
    [ChatTelemetryEventName.LoadHistory]: LoadHistoryEvent
    [ChatTelemetryEventName.CompactHistory]: CompactHistoryEvent
    [ChatTelemetryEventName.CompactNudge]: CompactNudgeEvent
    [ChatTelemetryEventName.ChatHistoryAction]: ChatHistoryActionEvent
    [ChatTelemetryEventName.ExportTab]: ExportTabEvent
    [ChatTelemetryEventName.UiClick]: UiClickEvent
    [ChatTelemetryEventName.ActiveUser]: ActiveUserEvent
    [ChatTelemetryEventName.BashCommand]: BashCommandEvent
    [ChatTelemetryEventName.ChatMessageRendered]: ChatMessageRenderedEvent
    [ChatTelemetryEventName.ChatPostMessageRejected]: ChatPostMessageRejectedEvent
}

export type AgencticLoop_InvokeLLMEvent = {
    credentialStartUrl?: string
    cwsprChatConversationId: string
    cwsprChatConversationType: ChatConversationType
    cwsprToolName: string
    cwsprToolUseId: string
    enabled?: boolean
    languageServerVersion?: string
    latency?: string
    /**
     * Classifies *why* a call failed, for failures that are handled inside the agent loop and are
     * therefore not user-visible. Used by downstream metrics to exclude transient, self-recovering
     * iterations from per-call success rates. Absent when `result` is 'Succeeded', and absent for
     * failures that have no specific classification.
     */
    reason?: string
}

export type ToolUseSuggestedEvent = {
    credentialStartUrl?: string
    cwsprChatConversationId: string
    cwsprChatConversationType: ChatConversationType
    cwsprToolName: string
    cwsprToolUseId: string
    enabled?: boolean
    languageServerVersion?: string
    perfE2ELatency?: string
}

export type InteractWithAgenticChatEvent = {
    credentialStartUrl?: string
    cwsprChatConversationId: string
    cwsprChatConversationType: ChatConversationType
    cwsprAgenticChatInteractionType: AgenticChatInteractionType
    enabled?: boolean
}

export type ActiveUserEvent = {
    credentialStartUrl?: string
    result: string
}

// Emitted when the chat client successfully delivers an inbound message to the chat UI (mynah-ui).
// Used as the positive signal for client-side delivery health: a drop in this rate (per product/os)
// surfaces a silent delivery failure even when the backend reports success. A strict postMessage
// origin check can drop inbound messages on some IDE webview hosts while the backend still returns
// HTTP 200, making the failure invisible server-side. See aws/amazon-q-eclipse#555.
export type ChatMessageRenderedEvent = {
    credentialStartUrl?: string
    languageServerVersion?: string
}

// Emitted when the chat client rejects/drops an inbound message in handleInboundMessage
// (e.g. untrusted origin, undefined payload, unrecognized command). `reason` distinguishes the
// drop branch. Note: result stays 'Succeeded' per the codebase convention (failures are conveyed
// via a distinct metric name + reason, not result:'Failed').
export type ChatPostMessageRejectedEvent = {
    credentialStartUrl?: string
    reason: string
    command?: string
    languageServerVersion?: string
}

export type BashCommandEvent = {
    credentialStartUrl: string
    result: string
    command: string
}

export type ModifyCodeEvent = {
    cwsprChatConversationId: string
    cwsprChatMessageId: string
    cwsprChatModificationPercentage: number
    codewhispererCustomizationArn?: string
}

export type AddMessageEvent = {
    credentialStartUrl?: string
    cwsprChatConversationId: string
    cwsprChatMessageId: string
    cwsprChatTriggerInteraction: string
    cwsprChatUserIntent?: string
    cwsprChatHasCodeSnippet: boolean
    cwsprChatProgrammingLanguage?: string
    cwsprChatActiveEditorTotalCharacters?: number
    cwsprChatActiveEditorImportCount?: number
    cwsprChatResponseCodeSnippetCount?: number
    cwsprChatResponseCode: number
    cwsprChatSourceLinkCount?: number
    cwsprChatReferencesCount?: number
    cwsprChatFollowUpCount?: number
    cwsprTimeToFirstChunk: number
    cwsprChatFullResponseLatency: number
    cwsprChatTimeBetweenChunks: number[]
    cwsprChatResponseType?: string
    cwsprChatRequestLength?: number
    cwsprChatResponseLength?: number
    cwsprChatConversationType: ChatConversationType
    codewhispererCustomizationArn?: string
    enabled?: boolean
    languageServerVersion?: string
    requestIds?: string[]
    experimentName?: string
    userVariation?: string

    // context related metrics
    cwsprChatHasContextList?: boolean
    cwsprChatHasWorkspaceContext?: boolean
    cwsprChatFolderContextCount?: number
    cwsprChatFileContextCount?: number
    cwsprChatFileContextLength?: number
    cwsprChatRuleContextCount?: number
    cwsprChatRuleContextLength?: number
    cwsprChatTotalRuleContextCount?: number
    cwsprChatPromptContextCount?: number
    cwsprChatPromptContextLength?: number
    cwsprChatFocusFileContextLength?: number
    cwsprChatCodeContextCount?: number
    cwsprChatCodeContextLength?: number

    //pinned context metrics
    cwsprChatPinnedCodeContextCount?: number
    cwsprChatPinnedFileContextCount?: number
    cwsprChatPinnedFolderContextCount?: number
    cwsprChatPinnedPromptContextCount?: number
}

// Agentic MCP Telemetry
export type MCPConfigEvent = {
    credentialStartUrl?: string
    languageServerVersion?: string
    numActiveServers?: number
    numGlobalServers?: number
    numProjectServers?: number
    numToolsAlwaysAllowed?: number
    numToolsDenied?: number
}

export type MCPServerInitializeEvent = {
    command?: string
    credentialStartUrl?: string
    enabled?: boolean
    initializeTime?: number
    languageServerVersion?: string
    numTools?: number
    scope?: string
    source?: string
    transportType?: string
}

export type EnterFocusChatEvent = {
    credentialStartUrl?: string
}

export type ExitFocusChatEvent = {
    credentialStartUrl?: string
}

export type EnterFocusConversationEvent = {
    credentialStartUrl?: string
    cwsprChatConversationId: string
}

export type ExitFocusConversationEvent = {
    credentialStartUrl?: string
    cwsprChatConversationId: string
}

export type UiClickEvent = {
    elementId: string
}

export type LoadHistoryEvent = {
    amazonqTimeToLoadHistory: number
    amazonqHistoryFileSize: number
    openTabCount: number
    result: Result
    languageServerVersion?: string
}

export type CompactHistoryEvent = {
    type: CompactHistoryActionType
    characters: number
    credentialStartUrl?: string
    languageServerVersion?: string
}

export type CompactNudgeEvent = {
    characters: number
    credentialStartUrl?: string
    languageServerVersion?: string
}

export type ChatHistoryActionEvent = {
    action: ChatHistoryActionType
    result: Result
    languageServerVersion?: string
    filenameExt?: string
    amazonqTimeToSearchHistory?: number
    amazonqHistoryFileSize?: number
}

export type ExportTabEvent = {
    filenameExt: string
    result: Result
    languageServerVersion?: string
}

export enum ChatInteractionType {
    InsertAtCursor = 'insertAtCursor',
    CopySnippet = 'copySnippet',
    Copy = 'copy',
    ClickLink = 'clickLink',
    ClickFollowUp = 'clickFollowUp',
    HoverReference = 'hoverReference',
    Upvote = 'upvote',
    Downvote = 'downvote',
    ClickBodyLink = 'clickBodyLink',
    AgenticCodeAccepted = 'agenticCodeAccepted',
}

export enum ChatHistoryActionType {
    Search = 'search',
    Export = 'export',
    Open = 'open',
    Delete = 'delete',
}

export enum CompactHistoryActionType {
    Manual = 'manual',
    Nudge = 'nudge',
}

export type ChatConversationType = 'Chat' | 'Assign' | 'Transform' | 'AgenticChat' | 'AgenticChatWithToolUse'

export type AgenticChatInteractionType = 'RejectDiff' | 'GeneratedDiff' | 'RunCommand' | 'GeneratedCommand' | 'StopChat'

export type InteractWithMessageEvent = {
    credentialStartUrl?: string
    cwsprChatConversationId: string
    cwsprChatMessageId: string
    cwsprChatInteractionType: ChatInteractionType
    cwsprChatInteractionTarget?: string
    cwsprChatAcceptedCharactersLength?: number
    cwsprChatHasReference?: boolean
    cwsprChatCodeBlockIndex?: number
    cwsprChatTotalCodeBlocks?: number
    codewhispererCustomizationArn?: string
    cwsprChatProgrammingLanguage?: string
}

export type StartConversationEvent = {
    credentialStartUrl?: string
    cwsprChatConversationId: string
    cwsprChatTriggerInteraction?: string
    cwsprChatUserIntent?: string
    cwsprChatHasCodeSnippet?: boolean
    cwsprChatProgrammingLanguage?: string
    cwsprChatConversationType: ChatConversationType
}

export type MessageResponseErrorEvent = {
    credentialStartUrl?: string
    cwsprChatConversationId: string
    cwsprChatTriggerInteraction: string
    cwsprChatUserIntent?: string
    cwsprChatHasCodeSnippet?: boolean
    cwsprChatProgrammingLanguage?: string
    cwsprChatActiveEditorTotalCharacters?: number
    cwsprChatActiveEditorImportCount?: number
    cwsprChatRepsonseCode: number
    cwsprChatRequestLength?: number
    cwsprChatConversationType: ChatConversationType
    enabled?: boolean
    languageServerVersion?: string
    modelId?: string
}

export type RunCommandEvent = {
    credentialStartUrl?: string
    cwsprChatCommandType: string
    cwsprChatCommandName?: string
}

export type CombinedConversationEvent = AddMessageEvent & StartConversationEvent & MessageResponseErrorEvent
