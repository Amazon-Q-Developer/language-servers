import { ChatTriggerType } from '@amzn/codewhisperer-streaming'
import {
    ApplyWorkspaceEditParams,
    ErrorCodes,
    FeedbackParams,
    InlineChatParams,
    InsertToCursorPositionParams,
    TextDocumentEdit,
    TextEdit,
    chatRequestType,
    InlineChatResultParams,
    ButtonClickParams,
    ButtonClickResult,
    OpenFileDialogParams,
    OpenFileDialogResult,
} from '@aws/language-server-runtimes/protocol'
import {
    CancellationToken,
    Chat,
    ChatParams,
    ChatResult,
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
    ChatInteractionType,
    ChatTelemetryEventName,
    CombinedConversationEvent,
} from '../../shared/telemetry/types'
import { Features, LspHandlers, Result } from '../types'
import { ChatEventParser, ChatResultWithMetadata } from './chatEventParser'
import { createAuthFollowUpResult, getAuthFollowUpType, getDefaultChatResponse } from './utils'
import { ChatSessionManagementService } from './chatSessionManagementService'
import { ChatTelemetryController } from './telemetry/chatTelemetryController'
import { QuickAction } from './quickActions'
import {
    getErrorId,
    getErrorMessage,
    isNullish,
    isObject,
    isServiceException,
    sanitizeRequestInput,
} from '../../shared/utils'
import { Metric } from '../../shared/telemetry/metric'
import { QChatTriggerContext, TriggerContext } from './contexts/triggerContext'
import { HELP_MESSAGE } from './constants'
import {
    AmazonQServicePendingProfileError,
    AmazonQServicePendingSigninError,
} from '../../shared/amazonQServiceManager/errors'
import { TelemetryService } from '../../shared/telemetry/telemetryService'
import { AmazonQWorkspaceConfig } from '../../shared/amazonQServiceManager/configurationUtils'
import { SendMessageCommandInput, SendMessageCommandOutput } from '../../shared/streamingClientService'
import { AmazonQBaseServiceManager } from '../../shared/amazonQServiceManager/BaseAmazonQServiceManager'
import { DEFAULT_IMAGE_VERIFICATION_OPTIONS } from '../../shared/imageVerification'

type ChatHandlers = Omit<
    LspHandlers<Chat>,
    | 'openTab'
    | 'sendChatUpdate'
    | 'onFileClicked'
    | 'onInlineChatPrompt'
    | 'sendContextCommands'
    | 'onCreatePrompt'
    | 'onListConversations'
    | 'onConversationClick'
    | 'onListMcpServers'
    | 'onMcpServerClick'
    | 'getSerializedChat'
    | 'onTabBarAction'
    | 'chatOptionsUpdate'
    | 'onRuleClick'
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

export class ChatController implements ChatHandlers {
    #features: Features
    #chatSessionManagementService: ChatSessionManagementService
    #telemetryController: ChatTelemetryController
    #triggerContext: QChatTriggerContext
    #customizationArn?: string
    #telemetryService: TelemetryService
    #serviceManager: AmazonQBaseServiceManager

    #inlineChatRequestStartTime: number = 0
    #inlineChatResponseLatency: number = 0
    #inlineChatRequestId?: string
    #inlineChatLanguage?: string
    #inlineChatTriggerType: string = 'OnDemand'
    #inlineChatCredentialStartUrl?: string
    #inlineChatCustomizationArn?: string
    #inlineChatResponseLength: number = 0
    #inlineChatRequestPromptLength: number = 0

    constructor(
        chatSessionManagementService: ChatSessionManagementService,
        features: Features,
        telemetryService: TelemetryService,
        serviceManager: AmazonQBaseServiceManager
    ) {
        this.#features = features
        this.#chatSessionManagementService = chatSessionManagementService
        this.#triggerContext = new QChatTriggerContext(features.workspace, features.logging, serviceManager)
        this.#telemetryController = new ChatTelemetryController(features, telemetryService)
        this.#telemetryService = telemetryService
        this.#serviceManager = serviceManager
    }

    dispose() {
        this.#chatSessionManagementService.dispose()
        this.#telemetryController.dispose()
    }

    async onButtonClick(params: ButtonClickParams): Promise<ButtonClickResult> {
        return {
            success: false,
            failureReason: 'not implemented',
        }
    }

    async onChatPrompt(params: ChatParams, token: CancellationToken): Promise<ChatResult | ResponseError<ChatResult>> {
        const maybeDefaultResponse = getDefaultChatResponse(params.prompt.prompt)

        if (maybeDefaultResponse) {
            return maybeDefaultResponse
        }

        const sessionResult = this.#chatSessionManagementService.getSession(params.tabId)

        const { data: session, success } = sessionResult

        if (!success) {
            return new ResponseError<ChatResult>(ErrorCodes.InternalError, sessionResult.error)
        }

        const metric = new Metric<CombinedConversationEvent>({
            cwsprChatConversationType: 'Chat',
        })

        const triggerContext = await this.#getTriggerContext(params, metric)
        const isNewConversation = !session.conversationId

        token.onCancellationRequested(() => {
            this.#log('cancellation requested')
            session.abortRequest()
        })

        let response: SendMessageCommandOutput
        let requestInput: SendMessageCommandInput

        const conversationIdentifier = session?.conversationId ?? 'New conversation'
        try {
            this.#log('Request for conversation id:', conversationIdentifier)
            // Remove invisible characters from the whole request, as the agentic chat server does
            requestInput = sanitizeRequestInput(
                this.#triggerContext.getChatParamsFromTrigger(
                    params,
                    triggerContext,
                    ChatTriggerType.MANUAL,
                    this.#customizationArn
                )
            )

            metric.recordStart()
            response = await session.sendMessage(requestInput)
            this.#log('Response for conversation id:', conversationIdentifier, JSON.stringify(response.$metadata))
        } catch (err) {
            if (
                isServiceException(err) ||
                (isObject(err) && 'statusCode' in err && typeof err.statusCode === 'number')
            ) {
                metric.setDimension('cwsprChatRepsonseCode', err.$metadata.httpStatusCode ?? 400)
                const modelId = session.modelId
                this.#telemetryController.emitMessageResponseError(
                    params.tabId,
                    metric.metric,
                    undefined,
                    undefined,
                    undefined,
                    modelId
                )
            }

            const authFollowType = getAuthFollowUpType(err)

            if (authFollowType) {
                this.#log(`Q auth error: ${getErrorMessage(err)}`)

                return createAuthFollowUpResult(authFollowType)
            }

            this.#log(`Q api request error ${err instanceof Error ? err.message : 'unknown'}`)
            return new ResponseError<ChatResult>(
                LSPErrorCodes.RequestFailed,
                err instanceof Error ? err.message : 'Unknown request error'
            )
        }

        try {
            const result = await this.#processSendMessageResponse(
                response,
                metric.mergeWith({
                    cwsprChatResponseCode: response.$metadata.httpStatusCode,
                    cwsprChatMessageId: response.$metadata.requestId,
                }),
                params.partialResultToken
            )

            session.conversationId = result.data?.conversationId
            this.#log('Session conversation id:', session.conversationId || '')

            if (session.conversationId) {
                this.#telemetryController.setConversationId(params.tabId, session.conversationId)

                if (isNewConversation) {
                    this.#telemetryController.updateTriggerInfo(params.tabId, {
                        startTrigger: {
                            hasUserSnippet: metric.metric.cwsprChatHasCodeSnippet ?? false,
                            triggerType: triggerContext.triggerType,
                        },
                    })

                    this.#telemetryController.emitStartConversationMetric(params.tabId, metric.metric)
                }
            }

            metric.setDimension('codewhispererCustomizationArn', requestInput.conversationState?.customizationArn)
            await this.#telemetryController.emitAddMessageMetric(
                params.tabId,
                metric.metric,
                undefined,
                undefined,
                undefined,
                session.modelId
            )

            this.#telemetryController.updateTriggerInfo(params.tabId, {
                lastMessageTrigger: {
                    ...triggerContext,
                    messageId: response.$metadata.requestId,
                    followUpActions: new Set(
                        result.data?.chatResult.followUp?.options
                            ?.map(option => option.prompt ?? '')
                            .filter(prompt => prompt.length > 0)
                    ),
                },
            })

            return result.success
                ? result.data.chatResult
                : new ResponseError<ChatResult>(LSPErrorCodes.RequestFailed, result.error)
        } catch (err) {
            this.#log('Error encountered during response streaming:', err instanceof Error ? err.message : 'unknown')

            return new ResponseError<ChatResult>(
                LSPErrorCodes.RequestFailed,
                err instanceof Error ? err.message : 'Unknown error occured during response stream'
            )
        }
    }

    async onInlineChatPrompt(
        params: InlineChatParams,
        token: CancellationToken
    ): Promise<InlineChatResult | ResponseError<InlineChatResult>> {
        // TODO: This metric needs to be removed later, just added for now to be able to create a ChatEventParser object
        const metric = new Metric<AddMessageEvent>({
            cwsprChatConversationType: 'Chat',
        })
        const triggerContext = await this.#getInlineChatTriggerContext(params)

        let response: SendMessageCommandOutput
        let requestInput: SendMessageCommandInput

        try {
            // Remove invisible characters from the whole request, as the agentic chat server does
            requestInput = sanitizeRequestInput(
                this.#triggerContext.getChatParamsFromTrigger(
                    params,
                    triggerContext,
                    ChatTriggerType.INLINE_CHAT,
                    this.#customizationArn
                )
            )

            this.#inlineChatRequestStartTime = Date.now()
            this.#inlineChatRequestId = undefined
            this.#inlineChatLanguage = triggerContext.programmingLanguage?.languageName
            this.#inlineChatTriggerType = ChatTriggerType.MANUAL
            this.#inlineChatCustomizationArn = this.#customizationArn
            this.#inlineChatRequestPromptLength = params.prompt?.prompt?.length ?? 0

            const client = this.#serviceManager.getStreamingClient()
            response = await client.sendMessage(requestInput)

            this.#inlineChatRequestId = response.$metadata.requestId

            this.#log('Response for inline chat', JSON.stringify(response.$metadata), JSON.stringify(response))
        } catch (err) {
            this.#log(`Inline Chat Service Invocation Failed: ${err instanceof Error ? err.message : 'unknown'}`)

            this.#inlineChatResponseLatency = Date.now() - this.#inlineChatRequestStartTime
            this.#features.telemetry.emitMetric({
                name: 'codewhisperer_inlineChatServiceInvocation',
                result: 'Failed',
                data: {
                    codewhispererRequestId: isServiceException(err) ? err.$metadata.requestId : undefined,
                    codewhispererTriggerType: this.#inlineChatTriggerType,
                    duration: this.#inlineChatResponseLatency,
                    codewhispererLanguage: this.#inlineChatLanguage,
                    credentialStartUrl: this.#inlineChatCredentialStartUrl,
                    codewhispererCustomizationArn: this.#inlineChatCustomizationArn,
                    result: 'Failed',
                    requestLength: this.#inlineChatRequestPromptLength,
                    responseLength: 0,
                    reason: `Inline Chat Invocation Exception: ${err instanceof Error ? err.name : 'UnknownError'}`,
                },
                errorData: {
                    reason: err instanceof Error ? err.name : 'UnknownError',
                    errorCode: err instanceof Error ? getErrorId(err) : undefined,
                    httpStatusCode: isServiceException(err) ? err.$metadata.httpStatusCode : undefined,
                },
            })

            if (err instanceof AmazonQServicePendingSigninError || err instanceof AmazonQServicePendingProfileError) {
                this.#log(`Q Inline Chat SSO Connection error: ${getErrorMessage(err)}`)
                return new ResponseError<ChatResult>(LSPErrorCodes.RequestFailed, err.message)
            }
            this.#log(`Q api request error ${err instanceof Error ? err.message : 'unknown'}`)
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
            this.#inlineChatResponseLatency = Date.now() - this.#inlineChatRequestStartTime
            this.#inlineChatResponseLength = result.data?.chatResult.body?.length ?? 0
            this.#features.telemetry.emitMetric({
                name: 'codewhisperer_inlineChatServiceInvocation',
                data: {
                    codewhispererRequestId: this.#inlineChatRequestId,
                    codewhispererTriggerType: this.#inlineChatTriggerType,
                    duration: this.#inlineChatResponseLatency,
                    codewhispererLanguage: this.#inlineChatLanguage,
                    credentialStartUrl: this.#inlineChatCredentialStartUrl,
                    codewhispererCustomizationArn: this.#inlineChatCustomizationArn,
                    result: 'Succeeded',
                    requestLength: this.#inlineChatRequestPromptLength,
                    responseLength: this.#inlineChatResponseLength,
                },
            })

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
            this.#inlineChatResponseLatency = Date.now() - this.#inlineChatRequestStartTime
            this.#features.telemetry.emitMetric({
                name: 'codewhisperer_inlineChatServiceInvocation',
                result: 'Failed',
                data: {
                    codewhispererRequestId: this.#inlineChatRequestId,
                    codewhispererTriggerType: this.#inlineChatTriggerType,
                    duration: this.#inlineChatResponseLatency,
                    codewhispererLanguage: this.#inlineChatLanguage,
                    credentialStartUrl: this.#inlineChatCredentialStartUrl,
                    codewhispererCustomizationArn: this.#inlineChatCustomizationArn,
                    result: 'Failed',
                    requestLength: this.#inlineChatRequestPromptLength,
                    responseLength: 0,
                    reason: `Inline Chat Response Streaming Exception: ${err instanceof Error ? err.name : 'UnknownError'}`,
                },
                errorData: {
                    reason: err instanceof Error ? err.name : 'UnknownError',
                    errorCode: err instanceof Error ? getErrorId(err) : undefined,
                    httpStatusCode: isServiceException(err) ? err.$metadata.httpStatusCode : undefined,
                },
            })

            return new ResponseError<ChatResult>(
                LSPErrorCodes.RequestFailed,
                err instanceof Error ? err.message : 'Unknown error occurred during inline chat response stream'
            )
        }
    }

    async onInlineChatResult(params: InlineChatResultParams) {
        await this.#telemetryService.emitInlineChatResultLog(params)
    }

    async onCodeInsertToCursorPosition(params: InsertToCursorPositionParams) {
        // Implementation based on https://github.com/aws/aws-toolkit-vscode/blob/1814cc84228d4bf20270574c5980b91b227f31cf/packages/core/src/amazonq/commons/controllers/contentController.ts#L38
        if (!params.textDocument || !params.cursorPosition || !params.code) {
            const missingParams = []

            if (!params.textDocument) missingParams.push('textDocument')
            if (!params.cursorPosition) missingParams.push('cursorPosition')
            if (!params.code) missingParams.push('code')

            this.#log(
                `Q Chat server failed to insert code. Missing required parameters for insert code: ${missingParams.join(', ')}`
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
        const applyResult = await this.#features.lsp.workspace.applyWorkspaceEdit(workspaceEdit)

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

    onFollowUpClicked() {}

    onInfoLinkClick() {}

    onLinkClick() {}

    onReady() {}

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

        this.#chatSessionManagementService.createSession(params.tabId)
    }

    onTabChange(params: TabChangeParams) {
        this.#telemetryController.emitConversationMetric({
            name: ChatTelemetryEventName.ExitFocusConversation,
            data: {},
        })

        this.#telemetryController.activeTabId = params.tabId

        this.#telemetryController.emitConversationMetric({
            name: ChatTelemetryEventName.EnterFocusConversation,
            data: {},
        })
    }

    onTabRemove(params: TabRemoveParams) {
        if (this.#telemetryController.activeTabId === params.tabId) {
            this.#telemetryController.emitConversationMetric({
                name: ChatTelemetryEventName.ExitFocusConversation,
                data: {},
            })
            this.#telemetryController.activeTabId = undefined
        }

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

    async #getInlineChatTriggerContext(params: InlineChatParams) {
        let triggerContext: TriggerContext = await this.#triggerContext.getNewTriggerContext(params)
        return triggerContext
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

    async #processSendMessageResponse(
        response: SendMessageCommandOutput,
        metric: Metric<AddMessageEvent>,
        partialResultToken?: string | number
    ): Promise<Result<ChatResultWithMetadata, string>> {
        const requestId = response.$metadata.requestId!
        const chatEventParser = new ChatEventParser(requestId, metric)

        for await (const chatEvent of response.sendMessageResponse!) {
            const result = chatEventParser.processPartialEvent(chatEvent)

            // terminate early when there is an error
            if (!result.success) {
                return result
            }

            if (!isNullish(partialResultToken)) {
                await this.#features.lsp.sendProgress(chatRequestType, partialResultToken, result.data.chatResult)
            }
        }

        metric.mergeWith({
            cwsprChatFullResponseLatency: metric.getTimeElapsed(),
            cwsprChatFollowUpCount: chatEventParser.totalEvents.followupPromptEvent,
            cwsprChatReferencesCount: chatEventParser.totalEvents.codeReferenceEvent,
            cwsprChatSourceLinkCount: chatEventParser.totalEvents.supplementaryWebLinksEvent,
            cwsprChatResponseLength: chatEventParser.body?.length ?? 0,
        })

        return chatEventParser.getResult()
    }

    async #processSendMessageResponseForInlineChat(
        response: SendMessageCommandOutput,
        metric: Metric<AddMessageEvent>,
        partialResultToken?: string | number
    ): Promise<Result<ChatResultWithMetadata, string>> {
        const requestId = response.$metadata.requestId!
        const chatEventParser = new ChatEventParser(requestId, metric)

        for await (const chatEvent of response.sendMessageResponse!) {
            const result = chatEventParser.processPartialEvent(chatEvent)

            // terminate early when there is an error
            if (!result.success) {
                return result
            }

            if (!isNullish(partialResultToken)) {
                await this.#features.lsp.sendProgress(chatRequestType, partialResultToken, result.data.chatResult)
            }
        }

        return chatEventParser.getResult()
    }

    onPromptInputOptionChange() {}

    updateConfiguration = (newConfig: AmazonQWorkspaceConfig) => {
        this.#customizationArn = newConfig.customizationArn
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
    }

    #log(...messages: string[]) {
        this.#features.logging.log(messages.join(' '))
    }

    async onOpenFileDialog(params: OpenFileDialogParams, token: CancellationToken): Promise<OpenFileDialogResult> {
        if (params.fileType === 'image') {
            try {
                const supportedExtensions = DEFAULT_IMAGE_VERIFICATION_OPTIONS.supportedExtensions
                const filters = { 'Image Files': supportedExtensions.map(ext => `*.${ext}`) }

                const result = await this.#features.lsp.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    filters,
                })

                if (result.uris && result.uris.length > 0) {
                    return {
                        tabId: params.tabId,
                        filePaths: result.uris,
                        fileType: params.fileType,
                        insertPosition: params.insertPosition,
                    }
                } else {
                    return {
                        tabId: params.tabId,
                        filePaths: [],
                        fileType: params.fileType,
                        insertPosition: params.insertPosition,
                    }
                }
            } catch (error) {
                this.#log('Error opening file dialog:', error instanceof Error ? error.message : String(error))
                return {
                    tabId: params.tabId,
                    filePaths: [],
                    errorMessage: 'Failed to open file dialog',
                    fileType: params.fileType,
                    insertPosition: params.insertPosition,
                }
            }
        }
        return {
            tabId: params.tabId,
            filePaths: [],
            errorMessage: 'File type not supported',
            fileType: params.fileType,
            insertPosition: params.insertPosition,
        }
    }
}
