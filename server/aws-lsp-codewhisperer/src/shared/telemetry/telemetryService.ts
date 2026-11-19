import { CodeWhispererServiceToken, SuggestionType } from '../codeWhispererService'
import {
    CredentialsProvider,
    CredentialsType,
    Logging,
    Telemetry,
} from '@aws/language-server-runtimes/server-interface'
import {
    CodeWhispererSession,
    UserTriggerDecision,
} from '../../language-server/inline-completion/session/sessionManager'
import {
    SuggestionState,
    UserTriggerDecisionEvent,
    UserContext,
    OptOutPreference,
    SendTelemetryEventRequest,
    ChatInteractWithMessageEvent,
    ChatMessageInteractionType,
    CodeCoverageEvent,
    TelemetryEvent,
    ChatAddMessageEvent,
    UserIntent,
    InlineChatEvent,
    IdeDiagnostic,
    UserModificationEvent,
    CompletionType,
    InlineChatUserDecision,
    AgenticChatEventStatus,
    UserDecisionReason,
} from '@amzn/codewhisperer-runtime'
import { getCompletionType, getSsoConnectionType, isServiceException } from '../utils'
import {
    ChatConversationType,
    ChatHistoryActionEvent,
    ChatInteractionType,
    ChatTelemetryEventName,
    CodeWhispererUserModificationEvent,
    CodeWhispererUserTriggerDecisionEvent,
    ExportTabEvent,
    InteractWithMessageEvent,
    LoadHistoryEvent,
    UiClickEvent,
} from './types'
import { CodewhispererLanguage, getRuntimeLanguage } from '../languageDetection'
import { CONVERSATION_ID_METRIC_KEY } from '../../language-server/chat/telemetry/chatTelemetryController'
import { AmazonQBaseServiceManager } from '../amazonQServiceManager/BaseAmazonQServiceManager'
import { InlineChatResultParams } from '@aws/language-server-runtimes/protocol'

export class TelemetryService {
    // Using Base service manager here to support fallback cases such as in codeWhispererServer
    private serviceManager: AmazonQBaseServiceManager
    private userContext: UserContext | undefined
    private optOutPreference!: OptOutPreference
    private enableTelemetryEventsToDestination: boolean
    private telemetry: Telemetry
    private credentialsProvider: CredentialsProvider
    private logging: Logging
    private profileArn: string | undefined
    private modelId: string | undefined

    private readonly cwInteractionTypeMap: Record<ChatInteractionType, ChatMessageInteractionType> = {
        [ChatInteractionType.InsertAtCursor]: 'INSERT_AT_CURSOR',
        [ChatInteractionType.CopySnippet]: 'COPY_SNIPPET',
        [ChatInteractionType.Copy]: 'COPY',
        [ChatInteractionType.ClickLink]: 'CLICK_LINK',
        [ChatInteractionType.ClickFollowUp]: 'CLICK_FOLLOW_UP',
        [ChatInteractionType.HoverReference]: 'HOVER_REFERENCE',
        [ChatInteractionType.Upvote]: 'UPVOTE',
        [ChatInteractionType.Downvote]: 'DOWNVOTE',
        [ChatInteractionType.ClickBodyLink]: 'CLICK_BODY_LINK',
        [ChatInteractionType.AgenticCodeAccepted]: 'AGENTIC_CODE_ACCEPTED',
    }

    constructor(
        serviceManager: AmazonQBaseServiceManager,
        credentialsProvider: CredentialsProvider,
        telemetry: Telemetry,
        logging: Logging
    ) {
        this.serviceManager = serviceManager
        this.credentialsProvider = credentialsProvider
        this.telemetry = telemetry
        this.logging = logging
        this.enableTelemetryEventsToDestination = true
    }

    public updateUserContext(userContext: UserContext | undefined): void {
        this.userContext = userContext
    }

    public updateOptOutPreference(optOutPreference: OptOutPreference): void {
        this.optOutPreference = optOutPreference
    }

    public updateProfileArn(profileArn: string) {
        this.profileArn = profileArn
    }

    public updateModelId(modelId: string | undefined) {
        this.modelId = modelId
    }

    public updateEnableTelemetryEventsToDestination(enableTelemetryEventsToDestination: boolean): void {
        this.enableTelemetryEventsToDestination = enableTelemetryEventsToDestination
    }

    private getCredentialsType(): CredentialsType {
        return this.serviceManager.getCodewhispererService().getCredentialsType()
    }

    // NOTE : CWSPR Service GetManager
    private getService(): CodeWhispererServiceToken {
        const service = this.serviceManager.getCodewhispererService() as CodeWhispererServiceToken

        if (!service.sendTelemetryEvent) {
            throw new Error(
                `Service of type: ${service.getCredentialsType()} returned by service manager is not compatible with TelemetryService`
            )
        }

        return service
    }

    private getSuggestionState(userTriggerDecision: UserTriggerDecision): SuggestionState {
        let suggestionState: SuggestionState
        // Edits show one suggestion sequentially (with pagination), so use latest itemId state;
        // Completions show multiple suggestions together, so aggregate all states
        switch (userTriggerDecision) {
            case 'Accept':
                suggestionState = 'ACCEPT'
                break
            case 'Reject':
                suggestionState = 'REJECT'
                break
            case 'Discard':
                suggestionState = 'DISCARD'
                break
            default:
                suggestionState = 'EMPTY'
        }
        return suggestionState
    }

    private shouldSendTelemetry(): boolean {
        const ssoConnectionType = getSsoConnectionType(this.credentialsProvider)

        return (
            this.getCredentialsType() === 'bearer' &&
            ((ssoConnectionType === 'builderId' && this.optOutPreference === 'OPTIN') ||
                ssoConnectionType === 'identityCenter')
        )
    }

    private logSendTelemetryEventFailure(error: any) {
        let requestId: string | undefined
        if (isServiceException(error)) {
            requestId = error.$metadata.requestId
        }

        this.logging.log(
            `Failed to sendTelemetryEvent to CodeWhisperer, requestId: ${requestId ?? ''}, message: ${error?.message}`
        )
    }

    private async invokeSendTelemetryEvent(event: TelemetryEvent) {
        try {
            if (!this.shouldSendTelemetry()) {
                return
            }
            const request: SendTelemetryEventRequest = {
                telemetryEvent: event,
            }
            if (this.userContext !== undefined) {
                request.userContext = this.userContext
            }
            if (this.optOutPreference !== undefined) {
                request.optOutPreference = this.optOutPreference
            }
            if (this.profileArn !== undefined) {
                request.profileArn = this.profileArn
            }
            if (this.modelId !== undefined) {
                request.modelId = this.modelId
            }
            const r = await this.getService().sendTelemetryEvent(request)
            this.logging.log(`SendTelemetryEvent succeeded, requestId: ${r.$metadata.requestId}`)
        } catch (error) {
            this.logSendTelemetryEventFailure(error)
        }
    }

    private getCWClientTelemetryInteractionType(interactionType: ChatInteractionType): ChatMessageInteractionType {
        return this.cwInteractionTypeMap[interactionType] || 'UNKNOWN'
    }

    public emitUserTriggerDecision(
        session: CodeWhispererSession,
        userTriggerDecision: UserTriggerDecision,
        timeSinceLastUserModification?: number,
        addedCharacterCount?: number,
        deletedCharacterCount?: number,
        addedIdeDiagnostics?: IdeDiagnostic[],
        removedIdeDiagnostics?: IdeDiagnostic[],
        streakLength?: number,
        userDecisionReason?: UserDecisionReason
    ) {
        session.decisionMadeTimestamp = Date.now()
        // Toolkit telemetry API
        if (this.enableTelemetryEventsToDestination) {
            const data: CodeWhispererUserTriggerDecisionEvent = {
                codewhispererSessionId: session.codewhispererSessionId || '',
                codewhispererFirstRequestId: session.responseContext?.requestId || '',
                credentialStartUrl: session.credentialStartUrl,
                codewhispererSuggestionState: session.getAggregatedUserTriggerDecision(),
                codewhispererCompletionType:
                    session.suggestions.length > 0 ? getCompletionType(session.suggestions[0]) : undefined,
                codewhispererLanguage: session.language,
                codewhispererTriggerType: session.triggerType,
                codewhispererAutomatedTriggerType: session.autoTriggerType,
                codewhispererTriggerCharacter:
                    session.autoTriggerType === 'SpecialCharacters' ? session.triggerCharacter : undefined,
                codewhispererLineNumber: session.startPosition.line,
                codewhispererCursorOffset: session.startPosition.character,
                codewhispererSuggestionCount: session.suggestions.length,
                codewhispererClassifierResult: session.classifierResult,
                codewhispererClassifierThreshold: session.classifierThreshold,
                codewhispererTotalShownTime: session.totalSessionDisplayTime || 0,
                codewhispererTypeaheadLength: session.typeaheadLength || 0,
                // Global time between any 2 document changes
                codewhispererTimeSinceLastDocumentChange: timeSinceLastUserModification,
                codewhispererTimeSinceLastUserDecision: session.previousTriggerDecisionTime
                    ? session.startTime - session.previousTriggerDecisionTime
                    : undefined,
                codewhispererTimeToFirstRecommendation: session.timeToFirstRecommendation,
                codewhispererPreviousSuggestionState: session.previousTriggerDecision,
                codewhispererSupplementalContextTimeout: session.supplementalMetadata?.isProcessTimeout,
                codewhispererSupplementalContextIsUtg: session.supplementalMetadata?.isUtg,
                codewhispererSupplementalContextLength: session.supplementalMetadata?.contentsLength,
                codewhispererCustomizationArn: session.customizationArn,
                codewhispererCharactersAccepted: this.getAcceptedCharacterCount(session),
                codewhispererSuggestionImportCount: session.codewhispererSuggestionImportCount,
                codewhispererSupplementalContextStrategyId: session.supplementalMetadata?.strategy,
            }
            this.telemetry.emitMetric({
                name: 'codewhisperer_userTriggerDecision',
                data: data,
            })
        }
        const acceptedSuggestion = session.suggestions.find(s => s.itemId === session.acceptedSuggestionId)
        const generatedLines =
            acceptedSuggestion === undefined || acceptedSuggestion.content?.trim() === ''
                ? 0
                : acceptedSuggestion.content?.split('\n').length
        const referenceCount =
            acceptedSuggestion === undefined
                ? 0
                : acceptedSuggestion.references && acceptedSuggestion.references.length > 0
                  ? 1
                  : 0
        const acceptedCharacterCount =
            acceptedSuggestion && acceptedSuggestion.content ? acceptedSuggestion.content.length : 0
        const perceivedLatencyMilliseconds =
            session.triggerType === 'OnDemand' ? session.timeToFirstRecommendation : timeSinceLastUserModification
        const isInlineEdit = session.predictionType === SuggestionType.EDIT

        // RTS STE API
        const event: UserTriggerDecisionEvent = {
            sessionId: session.codewhispererSessionId || '',
            requestId: session.responseContext?.requestId || '',
            customizationArn: session.customizationArn === '' ? undefined : session.customizationArn,
            programmingLanguage: {
                languageName: getRuntimeLanguage(session.language),
            },
            completionType:
                session.suggestions.length > 0
                    ? getCompletionType(session.suggestions[0]) === 'Line'
                        ? CompletionType.Line
                        : CompletionType.Block
                    : CompletionType.Line,
            suggestionState: this.getSuggestionState(userTriggerDecision),
            recommendationLatencyMilliseconds: session.firstCompletionDisplayLatency ?? 0,
            timestamp: new Date(Date.now()),
            triggerToResponseLatencyMilliseconds: session.timeToFirstRecommendation,
            suggestionReferenceCount: referenceCount,
            generatedLine: generatedLines,
            numberOfRecommendations: session.suggestions.length,
            perceivedLatencyMilliseconds: perceivedLatencyMilliseconds,
            acceptedCharacterCount: isInlineEdit ? addedCharacterCount : acceptedCharacterCount,
            addedCharacterCount: isInlineEdit ? addedCharacterCount : acceptedCharacterCount,
            deletedCharacterCount: isInlineEdit ? deletedCharacterCount : 0,
            addedIdeDiagnostics: addedIdeDiagnostics,
            removedIdeDiagnostics: removedIdeDiagnostics,
            streakLength: streakLength ?? 0,
            suggestionType: session.predictionType,
            userDecisionReason: userDecisionReason,
        }
        this.logging.info(`Invoking SendTelemetryEvent:UserTriggerDecisionEvent:
            "requestId": ${event.requestId}
            "suggestionState": ${event.suggestionState}
            "acceptedCharacterCount": ${event.acceptedCharacterCount}
            "addedCharacterCount": ${event.addedCharacterCount}
            "deletedCharacterCount": ${event.deletedCharacterCount}
            "streakLength": ${event.streakLength},
            "preprocessLatency": ${session.preprocessLatency},
            "triggerToResponseLatencyMilliseconds: ${event.triggerToResponseLatencyMilliseconds}",
            "firstCompletionDisplayLatency: ${event.recommendationLatencyMilliseconds},
            "suggestionType": ${event.suggestionType}
            "userDecisionReason": ${event.userDecisionReason}`)
        return this.invokeSendTelemetryEvent({
            userTriggerDecisionEvent: event,
        })
    }

    private getAcceptedCharacterCount(session: CodeWhispererSession) {
        let acceptedSuggestion = session.suggestions.find(s => s.itemId === session.acceptedSuggestionId)
        return acceptedSuggestion && acceptedSuggestion.content ? acceptedSuggestion.content.length : 0
    }

    public emitChatInteractWithMessage(
        metric: Omit<InteractWithMessageEvent, 'cwsprChatConversationId'>,
        options?: {
            conversationId?: string
            acceptedLineCount?: number
            programmingLanguage?: CodewhispererLanguage
        }
    ) {
        if (options?.conversationId === undefined) {
            return
        }
        if (this.enableTelemetryEventsToDestination) {
            this.telemetry.emitMetric({
                name: ChatTelemetryEventName.InteractWithMessage,
                data: {
                    ...metric,
                    [CONVERSATION_ID_METRIC_KEY]: options.conversationId,
                    credentialStartUrl: this.credentialsProvider.getConnectionMetadata()?.sso?.startUrl,
                    result: 'Succeeded',
                },
            })
        }
        const event: ChatInteractWithMessageEvent = {
            conversationId: options.conversationId,
            messageId: metric.cwsprChatMessageId,
            interactionType: this.getCWClientTelemetryInteractionType(metric.cwsprChatInteractionType),
            interactionTarget: metric.cwsprChatInteractionTarget,
            acceptedCharacterCount: metric.cwsprChatAcceptedCharactersLength,
            acceptedLineCount: options.acceptedLineCount,
            acceptedSnippetHasReference: false,
            hasProjectLevelContext: false,
            programmingLanguage: metric.cwsprChatProgrammingLanguage
                ? { languageName: metric.cwsprChatProgrammingLanguage }
                : undefined,
        }
        if (metric.codewhispererCustomizationArn) {
            event.customizationArn = metric.codewhispererCustomizationArn
        }
        if (options.programmingLanguage) {
            event.programmingLanguage = {
                languageName: getRuntimeLanguage(options.programmingLanguage),
            }
        }
        return this.invokeSendTelemetryEvent({
            chatInteractWithMessageEvent: event,
        })
    }

    public emitChatUserModificationEvent(params: {
        conversationId: string
        messageId: string
        modificationPercentage: number
        customizationArn?: string
    }) {
        if (this.enableTelemetryEventsToDestination) {
            this.telemetry.emitMetric({
                name: ChatTelemetryEventName.ModifyCode,
                data: {
                    [CONVERSATION_ID_METRIC_KEY]: params.conversationId,
                    cwsprChatMessageId: params.messageId,
                    cwsprChatModificationPercentage: params.modificationPercentage,
                    codewhispererCustomizationArn: params.customizationArn,
                    credentialStartUrl: this.credentialsProvider.getConnectionMetadata()?.sso?.startUrl,
                    result: 'Succeeded',
                },
            })
        }
        return this.invokeSendTelemetryEvent({
            chatUserModificationEvent: params,
        })
    }

    public emitUserModificationEvent(
        params: {
            sessionId: string
            requestId: string
            languageId: CodewhispererLanguage
            customizationArn?: string
            timestamp: Date
            modificationPercentage: number
            acceptedCharacterCount: number
            unmodifiedAcceptedCharacterCount: number
        },
        additionalParams: {
            completionType: string
            triggerType: string
            credentialStartUrl: string | undefined
        }
    ) {
        if (this.enableTelemetryEventsToDestination) {
            const data: CodeWhispererUserModificationEvent = {
                codewhispererRequestId: params.requestId,
                codewhispererSessionId: params.sessionId,
                codewhispererCompletionType: additionalParams.completionType,
                codewhispererTriggerType: additionalParams.triggerType,
                codewhispererLanguage: getRuntimeLanguage(params.languageId),
                codewhispererModificationPercentage: params.modificationPercentage,
                codewhispererCharactersAccepted: params.acceptedCharacterCount,
                codewhispererCharactersModified: params.unmodifiedAcceptedCharacterCount,
                credentialStartUrl: additionalParams.credentialStartUrl,
            }
            this.telemetry.emitMetric({
                name: 'codewhisperer_userModification',
                data: data,
            })
        }

        const event: UserModificationEvent = {
            sessionId: params.sessionId,
            requestId: params.requestId,
            programmingLanguage: {
                languageName: getRuntimeLanguage(params.languageId),
            },
            // deprecated % value and should not be used by service side
            modificationPercentage: params.modificationPercentage,
            customizationArn: params.customizationArn,
            timestamp: params.timestamp,
            acceptedCharacterCount: params.acceptedCharacterCount,
            unmodifiedAcceptedCharacterCount: params.unmodifiedAcceptedCharacterCount,
            addedCharacterCount: params.acceptedCharacterCount,
            unmodifiedAddedCharacterCount: params.unmodifiedAcceptedCharacterCount,
        }

        this.logging.info(`Invoking SendTelemetryEvent:UserModificationEvent with:
            "acceptedCharacterCount": ${event.acceptedCharacterCount}
            "unmodifiedAcceptedCharacterCount": ${event.unmodifiedAcceptedCharacterCount}
            "addedCharacterCount": ${event.addedCharacterCount}
            "unmodifiedAddedCharacterCount": ${event.unmodifiedAddedCharacterCount}`)

        return this.invokeSendTelemetryEvent({
            userModificationEvent: event,
        })
    }

    public emitCodeCoverageEvent(
        params: {
            languageId: CodewhispererLanguage
            acceptedCharacterCount: number
            totalCharacterCount: number
            customizationArn?: string
            userWrittenCodeCharacterCount?: number
            userWrittenCodeLineCount?: number
        },
        additionalParams: Partial<{
            percentage: number
            successCount: number
            credentialStartUrl?: string
        }>
    ) {
        if (this.enableTelemetryEventsToDestination) {
            this.telemetry.emitMetric({
                name: 'codewhisperer_codePercentage',
                data: {
                    codewhispererTotalTokens: params.totalCharacterCount,
                    codewhispererLanguage: params.languageId,
                    codewhispererSuggestedTokens: params.acceptedCharacterCount,
                    // codewhispererPercentage does not allow null and UserWrittenTracker returns null for this field so added an extra 0 for type safety
                    codewhispererPercentage: additionalParams.percentage ?? 0,
                    successCount: additionalParams.successCount,
                    codewhispererCustomizationArn: params.customizationArn,
                    credentialStartUrl: additionalParams.credentialStartUrl,
                },
            })
        }
        const event: CodeCoverageEvent = {
            programmingLanguage: {
                languageName: getRuntimeLanguage(params.languageId),
            },
            acceptedCharacterCount: params.acceptedCharacterCount,
            totalCharacterCount: params.totalCharacterCount,
            timestamp: new Date(Date.now()),
            addedCharacterCount: params.acceptedCharacterCount,
            userWrittenCodeCharacterCount: params.userWrittenCodeCharacterCount,
            userWrittenCodeLineCount: params.userWrittenCodeLineCount,
        }
        if (params.customizationArn) event.customizationArn = params.customizationArn

        this.logging.info(`Invoking SendTelemetryEvent:CodeCoverageEvent with:
            "acceptedCharacterCount": ${event.acceptedCharacterCount}
            "totalCharacterCount": ${event.totalCharacterCount}
            "addedCharacterCount": ${event.addedCharacterCount}`)

        return this.invokeSendTelemetryEvent({
            codeCoverageEvent: event,
        })
    }

    public emitExportTab(event: ExportTabEvent) {
        if (this.enableTelemetryEventsToDestination) {
            this.telemetry.emitMetric({
                name: ChatTelemetryEventName.ExportTab,
                data: event,
            })
        }
    }

    public emitLoadHistory(event: LoadHistoryEvent) {
        if (this.enableTelemetryEventsToDestination) {
            this.telemetry.emitMetric({
                name: ChatTelemetryEventName.LoadHistory,
                data: event,
            })
        }
    }

    public emitChatHistoryAction(event: ChatHistoryActionEvent) {
        if (this.enableTelemetryEventsToDestination) {
            this.telemetry.emitMetric({
                name: ChatTelemetryEventName.ChatHistoryAction,
                data: event,
            })
        }
    }

    public emitUiClick(event: UiClickEvent) {
        if (this.enableTelemetryEventsToDestination) {
            this.telemetry.emitMetric({
                name: ChatTelemetryEventName.UiClick,
                data: { elementId: event.elementId },
            })
        }
    }

    public emitChatAddMessage(
        params: {
            conversationId?: string
            messageId?: string
            customizationArn?: string
            userIntent?: UserIntent
            hasCodeSnippet?: boolean
            programmingLanguage?: CodewhispererLanguage
            activeEditorTotalCharacters?: number
            timeToFirstChunkMilliseconds?: number
            timeBetweenChunks?: number[]
            fullResponselatency?: number
            requestLength?: number
            responseLength?: number
            numberOfCodeBlocks?: number
            hasProjectLevelContext?: number
            agenticCodingMode?: boolean
            result?: string
            modelId?: string
        },
        additionalParams: Partial<{
            chatTriggerInteraction: string
            chatResponseCode: number
            chatSourceLinkCount?: number
            chatReferencesCount?: number
            chatFollowUpCount?: number
            chatConversationType: ChatConversationType
            chatActiveEditorImportCount?: number
            cwsprChatHasContextList: boolean
            cwsprChatFolderContextCount: number
            cwsprChatFileContextCount: number
            cwsprChatFileContextLength: number
            cwsprChatRuleContextCount: number
            cwsprChatRuleContextLength: number
            cwsprChatTotalRuleContextCount: number
            cwsprChatPromptContextCount: number
            cwsprChatPromptContextLength: number
            cwsprChatCodeContextCount: number
            cwsprChatCodeContextLength: number
            cwsprChatFocusFileContextLength: number
            cwsprChatPinnedCodeContextCount?: number
            cwsprChatPinnedFileContextCount?: number
            cwsprChatPinnedFolderContextCount?: number
            cwsprChatPinnedPromptContextCount?: number
            languageServerVersion?: string
            requestIds?: string[]
            experimentName?: string
            userVariation?: string
            errorMessage?: string
            errorCode?: string
        }>
    ) {
        const timeBetweenChunks = params.timeBetweenChunks?.slice(0, 100)
        // truncate requestIds if longer than 875 so it does not go over field limit
        const truncatedRequestIds = additionalParams.requestIds?.slice(0, 875)

        if (this.enableTelemetryEventsToDestination) {
            this.telemetry.emitMetric({
                name: ChatTelemetryEventName.AddMessage,
                data: {
                    credentialStartUrl: this.credentialsProvider.getConnectionMetadata()?.sso?.startUrl,
                    [CONVERSATION_ID_METRIC_KEY]: params.conversationId,
                    cwsprChatHasCodeSnippet: params.hasCodeSnippet,
                    cwsprChatTriggerInteraction: additionalParams.chatTriggerInteraction,
                    cwsprChatMessageId: params.messageId,
                    cwsprChatUserIntent: params.userIntent,
                    cwsprChatProgrammingLanguage: params.programmingLanguage,
                    cwsprChatResponseCodeSnippetCount: params.numberOfCodeBlocks,
                    cwsprChatResponseCode: additionalParams.chatResponseCode,
                    cwsprChatSourceLinkCount: additionalParams.chatSourceLinkCount,
                    cwsprChatReferencesCount: additionalParams.chatReferencesCount,
                    cwsprChatFollowUpCount: additionalParams.chatFollowUpCount,
                    cwsprChatTimeToFirstChunk: params.timeToFirstChunkMilliseconds,
                    cwsprChatFullResponseLatency: params.fullResponselatency,
                    cwsprChatTimeBetweenChunks: timeBetweenChunks,
                    cwsprChatRequestLength: params.requestLength,
                    cwsprChatResponseLength: params.responseLength,
                    cwsprChatConversationType: additionalParams.chatConversationType,
                    cwsprChatActiveEditorTotalCharacters: params.activeEditorTotalCharacters,
                    cwsprChatActiveEditorImportCount: additionalParams.chatActiveEditorImportCount,
                    codewhispererCustomizationArn: params.customizationArn,
                    cwsprChatHasContextList: additionalParams.cwsprChatHasContextList,
                    cwsprChatFolderContextCount: additionalParams.cwsprChatFolderContextCount,
                    cwsprChatFileContextCount: additionalParams.cwsprChatFileContextCount,
                    cwsprChatRuleContextCount: additionalParams.cwsprChatRuleContextCount,
                    cwsprChatPromptContextCount: additionalParams.cwsprChatPromptContextCount,
                    cwsprChatFileContextLength: additionalParams.cwsprChatFileContextLength,
                    cwsprChatRuleContextLength: additionalParams.cwsprChatRuleContextLength,
                    cwsprChatTotalRuleContextCount: additionalParams.cwsprChatTotalRuleContextCount,
                    cwsprChatPromptContextLength: additionalParams.cwsprChatPromptContextLength,
                    cwsprChatFocusFileContextLength: additionalParams.cwsprChatFocusFileContextLength,
                    cwsprChatCodeContextCount: additionalParams.cwsprChatCodeContextCount,
                    cwsprChatCodeContextLength: additionalParams.cwsprChatCodeContextLength,
                    cwsprChatPinnedCodeContextCount: additionalParams.cwsprChatPinnedCodeContextCount,
                    cwsprChatPinnedFileContextCount: additionalParams.cwsprChatPinnedFileContextCount,
                    cwsprChatPinnedFolderContextCount: additionalParams.cwsprChatPinnedFolderContextCount,
                    cwsprChatPinnedPromptContextCount: additionalParams.cwsprChatPinnedPromptContextCount,
                    result: params.result ?? 'Succeeded',
                    enabled: params.agenticCodingMode,
                    languageServerVersion: additionalParams.languageServerVersion,
                    requestIds: truncatedRequestIds,
                    experimentName: additionalParams.experimentName,
                    userVariation: additionalParams.userVariation,
                    errorMessage: additionalParams.errorMessage,
                    errorCode: additionalParams.errorCode,
                    modelId: params.modelId,
                },
            })
        }

        const event: ChatAddMessageEvent = {
            // Fields conversationId and messageId are required, but failed or cancelled events may not have those values, then just set them as dummy value
            conversationId: params.conversationId ?? 'DummyConversationId',
            messageId: params.messageId ?? 'DummyMessageId',
            userIntent: params.userIntent,
            hasCodeSnippet: params.hasCodeSnippet,
            activeEditorTotalCharacters: params.activeEditorTotalCharacters,
            timeToFirstChunkMilliseconds: params.timeToFirstChunkMilliseconds,
            timeBetweenChunks: timeBetweenChunks,
            fullResponselatency: params.fullResponselatency,
            requestLength: params.requestLength,
            responseLength: params.responseLength,
            numberOfCodeBlocks: params.numberOfCodeBlocks,
            hasProjectLevelContext: false,
            result: (params.result?.toUpperCase() ?? AgenticChatEventStatus.Succeeded) as AgenticChatEventStatus,
        }
        if (params.customizationArn) {
            event.customizationArn = params.customizationArn
        }
        if (params.programmingLanguage) {
            event.programmingLanguage = {
                languageName: getRuntimeLanguage(params.programmingLanguage),
            }
        }
        return this.invokeSendTelemetryEvent({
            chatAddMessageEvent: event,
        })
    }

    public emitInlineChatResultLog(params: InlineChatResultParams) {
        const event: InlineChatEvent = {
            requestId: params.requestId,
            timestamp: new Date(),
            inputLength: params.inputLength,
            numSelectedLines: params.selectedLines,
            numSuggestionAddChars: params.suggestionAddedChars,
            numSuggestionAddLines: params.suggestionAddedLines,
            numSuggestionDelChars: params.suggestionDeletedChars,
            numSuggestionDelLines: params.suggestionDeletedLines,
            codeIntent: params.codeIntent,
            userDecision: params.userDecision as InlineChatUserDecision,
            responseStartLatency: params.responseStartLatency,
            responseEndLatency: params.responseEndLatency,
        }
        if (params.programmingLanguage) {
            event.programmingLanguage = {
                languageName: getRuntimeLanguage(params.programmingLanguage.languageName as CodewhispererLanguage),
            }
        }
        return this.invokeSendTelemetryEvent({
            inlineChatEvent: event,
        })
    }
}
