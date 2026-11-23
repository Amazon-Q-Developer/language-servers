import { ChatResponseStream, CodeWhispererStreaming, SendMessageCommandInput } from '@amzn/codewhisperer-streaming'
import {
    ChatResult,
    LSPErrorCodes,
    ResponseError,
    TextDocument,
    CredentialsProvider,
    Telemetry,
    Logging,
    Position,
    InsertToCursorPositionParams,
    TextDocumentEdit,
    InlineChatResult,
} from '@aws/language-server-runtimes/server-interface'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import * as assert from 'assert'

import { createIterableResponse, setCredentialsForAmazonQTokenServiceManagerFactory } from '../../shared/testUtils'
import sinon from 'ts-sinon'

import { ChatController } from './chatController'
import { ChatSessionManagementService } from './chatSessionManagementService'
import { ChatSessionService } from './chatSessionService'
import { ChatTelemetryController } from './telemetry/chatTelemetryController'
import { DocumentContextExtractor } from './contexts/documentContext'
import * as utils from './utils'
import { DEFAULT_HELP_FOLLOW_UP_PROMPT, HELP_MESSAGE } from './constants'
import { TelemetryService } from '../../shared/telemetry/telemetryService'
import { AmazonQTokenServiceManager } from '../../shared/amazonQServiceManager/AmazonQTokenServiceManager'
import {
    AmazonQError,
    AmazonQServicePendingProfileError,
    AmazonQServicePendingSigninError,
} from '../../shared/amazonQServiceManager/errors'
import { MISSING_BEARER_TOKEN_ERROR } from '../../shared/constants'

describe('ChatController', () => {
    const mockTabId = 'tab-1'
    const mockConversationId = 'mock-conversation-id'
    const mockMessageId = 'mock-message-id'

    const mockChatResponseList: ChatResponseStream[] = [
        {
            messageMetadataEvent: {
                conversationId: mockConversationId,
            },
        },
        {
            assistantResponseEvent: {
                content: 'Hello ',
            },
        },
        {
            assistantResponseEvent: {
                content: 'World',
            },
        },
        {
            assistantResponseEvent: {
                content: '!',
            },
        },
    ]

    const expectedCompleteChatResult: ChatResult = {
        messageId: mockMessageId,
        body: 'Hello World!',
        canBeVoted: true,
        codeReference: undefined,
        followUp: undefined,
        relatedContent: undefined,
    }

    const expectedCompleteInlineChatResult: InlineChatResult = {
        messageId: mockMessageId,
        body: 'Hello World!',
        canBeVoted: true,
        codeReference: undefined,
        followUp: undefined,
        relatedContent: undefined,
        requestId: mockMessageId,
    }

    const mockCancellationToken = {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => null }),
    }

    const logging: Logging = {
        log: (message: string) => {
            console.log(message)
        },
    } as Logging

    let sendMessageStub: sinon.SinonStub
    let disposeStub: sinon.SinonStub
    let activeTabSpy: {
        get: sinon.SinonSpy<[], string | undefined>
        set: sinon.SinonSpy<[string | undefined], void>
    }
    let removeConversationSpy: sinon.SinonSpy
    let emitConversationMetricStub: sinon.SinonStub

    let testFeatures: TestFeatures
    let serviceManager: AmazonQTokenServiceManager
    let chatSessionManagementService: ChatSessionManagementService
    let chatController: ChatController
    let telemetryService: TelemetryService
    let telemetry: Telemetry

    const setCredentials = setCredentialsForAmazonQTokenServiceManagerFactory(() => testFeatures)

    beforeEach(() => {
        sendMessageStub = sinon.stub(CodeWhispererStreaming.prototype, 'sendMessage').callsFake(() => {
            return new Promise(resolve =>
                setTimeout(() => {
                    resolve({
                        $metadata: {
                            requestId: mockMessageId,
                        },
                        sendMessageResponse: createIterableResponse(mockChatResponseList),
                    })
                })
            )
        })

        testFeatures = new TestFeatures()

        // @ts-ignore
        const cachedInitializeParams: InitializeParams = {
            initializationOptions: {
                aws: {
                    awsClientCapabilities: {
                        q: {
                            developerProfiles: false,
                        },
                    },
                },
            },
        }
        testFeatures.setClientParams(cachedInitializeParams)
        setCredentials('builderId')

        activeTabSpy = sinon.spy(ChatTelemetryController.prototype, 'activeTabId', ['get', 'set'])
        removeConversationSpy = sinon.spy(ChatTelemetryController.prototype, 'removeConversation')
        emitConversationMetricStub = sinon.stub(ChatTelemetryController.prototype, 'emitConversationMetric')

        disposeStub = sinon.stub(ChatSessionService.prototype, 'dispose')

        AmazonQTokenServiceManager.resetInstance()

        serviceManager = AmazonQTokenServiceManager.initInstance(testFeatures)

        chatSessionManagementService = ChatSessionManagementService.getInstance()
        chatSessionManagementService.withAmazonQServiceManager(serviceManager)

        const mockCredentialsProvider: CredentialsProvider = {
            hasCredentials: sinon.stub().returns(true),
            getCredentials: sinon.stub().returns({ token: 'token' }),
            getConnectionMetadata: sinon.stub().returns({
                sso: {
                    startUrl: undefined,
                },
            }),
            getConnectionType: sinon.stub().returns('none'),
            onCredentialsDeleted: sinon.stub(),
        }

        telemetry = {
            emitMetric: sinon.stub(),
            onClientTelemetry: sinon.stub(),
        }

        telemetryService = new TelemetryService(serviceManager, mockCredentialsProvider, telemetry, logging)
        chatController = new ChatController(
            chatSessionManagementService,
            testFeatures,
            telemetryService,
            serviceManager
        )
    })

    afterEach(() => {
        sinon.restore()
        ChatSessionManagementService.reset()
    })

    it('creates a session when a tab add notifcation is received', () => {
        chatController.onTabAdd({ tabId: mockTabId })

        const sessionResult = chatSessionManagementService.getSession(mockTabId)
        sinon.assert.match(sessionResult, {
            success: true,
            data: sinon.match.instanceOf(ChatSessionService),
        })
    })

    it('deletes a session by tab id when a tab remove notifcation is received', () => {
        chatController.onTabAdd({ tabId: mockTabId })

        assert.ok(chatSessionManagementService.getSession(mockTabId).data instanceof ChatSessionService)

        chatController.onTabRemove({ tabId: mockTabId })

        sinon.assert.calledOnce(disposeStub)

        const hasSession = chatSessionManagementService.hasSession(mockTabId)

        assert.ok(!hasSession)
    })

    it('deletes a session by tab id an end chat request is received', () => {
        chatController.onTabAdd({ tabId: mockTabId })

        chatController.onEndChat({ tabId: mockTabId }, mockCancellationToken)

        sinon.assert.calledOnce(disposeStub)

        const hasSession = chatSessionManagementService.hasSession(mockTabId)

        assert.ok(!hasSession)
    })

    it('onTabAdd sets active tab id in telemetryController', () => {
        chatController.onTabAdd({ tabId: mockTabId })

        sinon.assert.calledWithExactly(activeTabSpy.set, mockTabId)
    })

    it('onTabChange sets active tab id in telemetryController and emits metrics', () => {
        chatController.onTabChange({ tabId: mockTabId })

        sinon.assert.calledWithExactly(activeTabSpy.set, mockTabId)
        sinon.assert.calledTwice(emitConversationMetricStub)
    })

    it('onTabRemove unsets tab id if current tab is removed and emits metrics', () => {
        chatController.onTabAdd({ tabId: mockTabId })

        emitConversationMetricStub.resetHistory()
        activeTabSpy.set.resetHistory()

        chatController.onTabRemove({ tabId: mockTabId })

        sinon.assert.calledWithExactly(removeConversationSpy, mockTabId)
        sinon.assert.calledOnce(emitConversationMetricStub)
    })

    it('onTabRemove does not unset tabId if current tab is not being removed', () => {
        chatController.onTabAdd({ tabId: mockTabId })
        chatController.onTabAdd({ tabId: 'mockTabId-2' })

        testFeatures.telemetry.emitMetric.resetHistory()
        activeTabSpy.set.resetHistory()

        chatController.onTabRemove({ tabId: mockTabId })

        sinon.assert.notCalled(activeTabSpy.set)
        sinon.assert.calledWithExactly(removeConversationSpy, mockTabId)
        sinon.assert.notCalled(emitConversationMetricStub)
    })

    describe('onChatPrompt', () => {
        beforeEach(() => {
            chatController.onTabAdd({ tabId: mockTabId })
        })

        it('read all the response streams and return compiled results', async () => {
            const chatResultPromise = chatController.onChatPrompt(
                { tabId: mockTabId, prompt: { prompt: 'Hello' } },
                mockCancellationToken
            )

            const chatResult = await chatResultPromise

            sinon.assert.callCount(testFeatures.lsp.sendProgress, 0)
            assert.deepStrictEqual(chatResult, expectedCompleteChatResult)
        })

        it('returns help message if it is a help follow up action', async () => {
            const chatResultPromise = chatController.onChatPrompt(
                { tabId: mockTabId, prompt: { prompt: DEFAULT_HELP_FOLLOW_UP_PROMPT } },
                mockCancellationToken
            )

            const chatResult = await chatResultPromise

            sinon.assert.match(chatResult, {
                messageId: sinon.match.string,
                body: HELP_MESSAGE,
            })
        })

        it('read all the response streams and send progress as partial result is received', async () => {
            const chatResultPromise = chatController.onChatPrompt(
                { tabId: mockTabId, prompt: { prompt: 'Hello' }, partialResultToken: 1 },
                mockCancellationToken
            )

            const chatResult = await chatResultPromise

            sinon.assert.callCount(testFeatures.lsp.sendProgress, mockChatResponseList.length)
            assert.deepStrictEqual(chatResult, expectedCompleteChatResult)
        })

        it('can use 0 as progress token', async () => {
            const chatResultPromise = chatController.onChatPrompt(
                { tabId: mockTabId, prompt: { prompt: 'Hello' }, partialResultToken: 0 },
                mockCancellationToken
            )

            const chatResult = await chatResultPromise

            sinon.assert.callCount(testFeatures.lsp.sendProgress, mockChatResponseList.length)
            assert.deepStrictEqual(chatResult, expectedCompleteChatResult)
        })

        it('returns a ResponseError if sendMessage returns an error', async () => {
            sendMessageStub.callsFake(() => {
                throw new Error('Error')
            })

            const chatResult = await chatController.onChatPrompt(
                { tabId: mockTabId, prompt: { prompt: 'Hello' } },
                mockCancellationToken
            )

            assert.ok(chatResult instanceof ResponseError)
        })

        const authFollowUpTestCases = [
            {
                expectedAuthFollowUp: 'full-auth',
                error: new Error(MISSING_BEARER_TOKEN_ERROR),
            },
            {
                expectedAuthFollowUp: 'full-auth',
                error: new AmazonQServicePendingSigninError(),
            },
            {
                expectedAuthFollowUp: 'use-supported-auth',
                error: new AmazonQServicePendingProfileError(),
            },
        ]

        authFollowUpTestCases.forEach(testCase => {
            it(`returns ${testCase.expectedAuthFollowUp} follow up action when sendMessage throws ${testCase.error instanceof AmazonQError ? testCase.error.code : testCase.error.message}`, async () => {
                sendMessageStub.callsFake(() => {
                    throw testCase.error
                })

                const chatResultPromise = chatController.onChatPrompt(
                    { tabId: mockTabId, prompt: { prompt: 'Hello' }, partialResultToken: 1 },
                    mockCancellationToken
                )

                const chatResult = await chatResultPromise

                sinon.assert.callCount(testFeatures.lsp.sendProgress, 0)
                // @ts-ignore
                assert.deepStrictEqual(chatResult, utils.createAuthFollowUpResult(testCase.expectedAuthFollowUp))
            })
        })

        it('returns a ResponseError if response streams return an error event', async () => {
            sendMessageStub.callsFake(() => {
                return Promise.resolve({
                    $metadata: {
                        requestId: mockMessageId,
                    },
                    sendMessageResponse: createIterableResponse([
                        // ["Hello ", "World"]
                        ...mockChatResponseList.slice(1, 3),
                        { error: { message: 'some error' } },
                        // ["!"]
                        ...mockChatResponseList.slice(3),
                    ]),
                })
            })

            const chatResult = await chatController.onChatPrompt(
                { tabId: mockTabId, prompt: { prompt: 'Hello' } },
                mockCancellationToken
            )

            assert.deepStrictEqual(chatResult, new ResponseError(LSPErrorCodes.RequestFailed, 'some error'))
        })

        it('returns a ResponseError if response streams return an invalid state event', async () => {
            sendMessageStub.callsFake(() => {
                return Promise.resolve({
                    $metadata: {
                        requestId: mockMessageId,
                    },
                    sendMessageResponse: createIterableResponse([
                        // ["Hello ", "World"]
                        ...mockChatResponseList.slice(1, 3),
                        { invalidStateEvent: { message: 'invalid state' } },
                        // ["!"]
                        ...mockChatResponseList.slice(3),
                    ]),
                })
            })

            const chatResult = await chatController.onChatPrompt(
                { tabId: mockTabId, prompt: { prompt: 'Hello' } },
                mockCancellationToken
            )

            assert.deepStrictEqual(chatResult, new ResponseError(LSPErrorCodes.RequestFailed, 'invalid state'))
        })

        it('removes invisible characters from the prompt and the document text without escaping HTML', async () => {
            testFeatures.openDocument(
                TextDocument.create('file:///chat.ts', 'typescript', 1, 'const a = 1\u{E0041}\u{E0100}\u{E0158}\n')
            )

            await chatController.onChatPrompt(
                {
                    tabId: mockTabId,
                    prompt: { prompt: 'Make a < b \u26A0\uFE0F\u{E0041}\u{E0100}\uFE01' },
                    textDocument: { uri: 'file:///chat.ts' },
                    cursorState: [{ position: { line: 0, character: 0 } }],
                },
                mockCancellationToken
            )

            const requestInput: SendMessageCommandInput = sendMessageStub.firstCall.firstArg
            const userInputMessage = requestInput.conversationState?.currentMessage?.userInputMessage
            assert.strictEqual(userInputMessage?.content, 'Make a < b \u26A0\uFE0F')
            assert.strictEqual(userInputMessage?.userInputMessageContext?.editorState?.document?.text, 'const a = 1\n')
        })

        describe('#extractDocumentContext', () => {
            const typescriptDocument = TextDocument.create('file:///test.ts', 'typescript', 1, 'test')
            let extractDocumentContextStub: sinon.SinonStub

            const mockCursorState = {
                range: {
                    start: {
                        line: 1,
                        character: 1,
                    },
                    end: {
                        line: 1,
                        character: 1,
                    },
                },
            }

            beforeEach(() => {
                extractDocumentContextStub = sinon.stub(DocumentContextExtractor.prototype, 'extractDocumentContext')
                testFeatures.openDocument(typescriptDocument)
            })

            afterEach(() => {
                extractDocumentContextStub.restore()
            })

            it('leaves editor state as undefined if cursorState is not passed', async () => {
                const documentContextObject = {
                    programmingLanguage: 'typescript',
                    cursorState: undefined,
                    relativeFilePath: 'file:///test.ts',
                }
                extractDocumentContextStub.resolves(documentContextObject)

                await chatController.onChatPrompt(
                    {
                        tabId: mockTabId,
                        prompt: { prompt: 'Hello' },
                        textDocument: { uri: 'file:///test.ts' },
                        cursorState: undefined,
                    },
                    mockCancellationToken
                )

                const calledRequestInput: SendMessageCommandInput = sendMessageStub.firstCall.firstArg

                assert.strictEqual(
                    calledRequestInput.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
                        ?.editorState,
                    undefined
                )
            })

            it('leaves editor state as undefined if relative file path is undefined', async () => {
                const documentContextObject = {
                    programmingLanguage: 'typescript',
                    cursorState: [],
                    relativeFilePath: undefined,
                }
                extractDocumentContextStub.resolves(documentContextObject)

                await chatController.onChatPrompt(
                    {
                        tabId: mockTabId,
                        prompt: { prompt: 'Hello' },
                        cursorState: [mockCursorState],
                    },
                    mockCancellationToken
                )

                const calledRequestInput: SendMessageCommandInput = sendMessageStub.firstCall.firstArg

                assert.strictEqual(
                    calledRequestInput.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
                        ?.editorState,
                    undefined
                )
            })

            it('parses editor state context and includes as requestInput if both cursor state and text document are found', async () => {
                const documentContextObject = {
                    programmingLanguage: 'typescript',
                    cursorState: [],
                    relativeFilePath: typescriptDocument.uri,
                }
                extractDocumentContextStub.resolves(documentContextObject)

                await chatController.onChatPrompt(
                    {
                        tabId: mockTabId,
                        prompt: { prompt: 'Hello' },
                        textDocument: { uri: 'file:///test.ts' },
                        cursorState: [mockCursorState],
                    },
                    mockCancellationToken
                )

                const calledRequestInput: SendMessageCommandInput = sendMessageStub.firstCall.firstArg

                assert.deepStrictEqual(
                    calledRequestInput.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
                        ?.editorState,
                    {
                        cursorState: [],
                        document: {
                            programmingLanguage: 'typescript',
                            relativeFilePath: 'file:///test.ts',
                            text: undefined,
                        },
                    }
                )
            })
        })
    })

    describe('onInlineChatPrompt', () => {
        it('read all the response streams and return compiled results', async () => {
            const chatResultPromise = chatController.onInlineChatPrompt(
                { prompt: { prompt: 'Hello' } },
                mockCancellationToken
            )

            const chatResult = await chatResultPromise

            sinon.assert.callCount(testFeatures.lsp.sendProgress, 0)
            assert.deepStrictEqual(chatResult, expectedCompleteInlineChatResult)
        })

        it('read all the response streams and send progress as partial result is received', async () => {
            const chatResultPromise = chatController.onInlineChatPrompt(
                { prompt: { prompt: 'Hello' }, partialResultToken: 1 },
                mockCancellationToken
            )

            const chatResult = await chatResultPromise

            sinon.assert.callCount(testFeatures.lsp.sendProgress, mockChatResponseList.length)
            assert.deepStrictEqual(chatResult, expectedCompleteInlineChatResult)
        })

        it('can use 0 as progress token', async () => {
            const chatResultPromise = chatController.onInlineChatPrompt(
                { prompt: { prompt: 'Hello' }, partialResultToken: 0 },
                mockCancellationToken
            )

            const chatResult = await chatResultPromise

            sinon.assert.callCount(testFeatures.lsp.sendProgress, mockChatResponseList.length)
            assert.deepStrictEqual(chatResult, expectedCompleteInlineChatResult)
        })

        it('returns a ResponseError if sendMessage returns an error', async () => {
            sendMessageStub.callsFake(() => {
                throw new Error('Error')
            })

            const chatResult = await chatController.onInlineChatPrompt(
                { prompt: { prompt: 'Hello' } },
                mockCancellationToken
            )

            assert.ok(chatResult instanceof ResponseError)
        })

        it('returns a Response error if sendMessage returns an auth error', async () => {
            sendMessageStub.callsFake(() => {
                throw new Error('Error')
            })

            const chatResultPromise = chatController.onInlineChatPrompt(
                { prompt: { prompt: 'Hello' }, partialResultToken: 1 },
                mockCancellationToken
            )

            const chatResult = await chatResultPromise

            sinon.assert.callCount(testFeatures.lsp.sendProgress, 0)
            assert.ok(chatResult instanceof ResponseError)
        })

        it('returns a ResponseError if response streams return an error event', async () => {
            sendMessageStub.callsFake(() => {
                return Promise.resolve({
                    $metadata: {
                        requestId: mockMessageId,
                    },
                    sendMessageResponse: createIterableResponse([
                        // ["Hello ", "World"]
                        ...mockChatResponseList.slice(1, 3),
                        { error: { message: 'some error' } },
                        // ["!"]
                        ...mockChatResponseList.slice(3),
                    ]),
                })
            })

            const chatResult = await chatController.onInlineChatPrompt(
                { prompt: { prompt: 'Hello' } },
                mockCancellationToken
            )

            assert.deepStrictEqual(chatResult, new ResponseError(LSPErrorCodes.RequestFailed, 'some error'))
        })

        it('returns a ResponseError if response streams return an invalid state event', async () => {
            sendMessageStub.callsFake(() => {
                return Promise.resolve({
                    $metadata: {
                        requestId: mockMessageId,
                    },
                    sendMessageResponse: createIterableResponse([
                        // ["Hello ", "World"]
                        ...mockChatResponseList.slice(1, 3),
                        { invalidStateEvent: { message: 'invalid state' } },
                        // ["!"]
                        ...mockChatResponseList.slice(3),
                    ]),
                })
            })

            const chatResult = await chatController.onInlineChatPrompt(
                { prompt: { prompt: 'Hello' } },
                mockCancellationToken
            )

            assert.deepStrictEqual(chatResult, new ResponseError(LSPErrorCodes.RequestFailed, 'invalid state'))
        })

        it('emits telemetry on successful inline chat response', async () => {
            await chatController.onInlineChatPrompt({ prompt: { prompt: 'Hello' } }, mockCancellationToken)

            sinon.assert.calledWith(
                testFeatures.telemetry.emitMetric,
                sinon.match.has('name', 'codewhisperer_inlineChatServiceInvocation')
            )
        })

        it('emits failure telemetry when inline chat service invocation fails', async () => {
            sendMessageStub.callsFake(() => {
                throw new Error('Service Error')
            })

            await chatController.onInlineChatPrompt({ prompt: { prompt: 'Hello' } }, mockCancellationToken)

            sinon.assert.calledWith(
                testFeatures.telemetry.emitMetric,
                sinon.match({
                    name: 'codewhisperer_inlineChatServiceInvocation',
                    result: 'Failed',
                })
            )
        })

        it('removes invisible characters from the prompt and the document text without escaping HTML', async () => {
            testFeatures.openDocument(
                TextDocument.create('file:///inline.ts', 'typescript', 1, 'const a = 1\u{E0041}\u{E0100}\u{E0158}\n')
            )

            await chatController.onInlineChatPrompt(
                {
                    prompt: { prompt: 'Make a < b \u26A0\uFE0F\u{E0041}\u{E0100}\uFE01' },
                    textDocument: { uri: 'file:///inline.ts' },
                    cursorState: [{ position: { line: 0, character: 0 } }],
                },
                mockCancellationToken
            )

            const requestInput: SendMessageCommandInput = sendMessageStub.firstCall.firstArg
            const userInputMessage = requestInput.conversationState?.currentMessage?.userInputMessage
            assert.strictEqual(userInputMessage?.content, 'Make a < b \u26A0\uFE0F')
            assert.strictEqual(userInputMessage?.userInputMessageContext?.editorState?.document?.text, 'const a = 1\n')
        })

        describe('#extractDocumentContext', () => {
            const typescriptDocument = TextDocument.create('file:///test.ts', 'typescript', 1, 'test')
            let extractDocumentContextStub: sinon.SinonStub

            const mockCursorState = {
                range: {
                    start: {
                        line: 1,
                        character: 1,
                    },
                    end: {
                        line: 1,
                        character: 1,
                    },
                },
            }

            beforeEach(() => {
                extractDocumentContextStub = sinon.stub(DocumentContextExtractor.prototype, 'extractDocumentContext')
                testFeatures.openDocument(typescriptDocument)
            })

            afterEach(() => {
                extractDocumentContextStub.restore()
            })

            it('leaves editor state as undefined if cursorState is not passed', async () => {
                const documentContextObject = {
                    programmingLanguage: 'typescript',
                    cursorState: undefined,
                    relativeFilePath: 'file:///test.ts',
                }
                extractDocumentContextStub.resolves(documentContextObject)

                await chatController.onInlineChatPrompt(
                    {
                        prompt: { prompt: 'Hello' },
                        textDocument: { uri: 'file:///test.ts' },
                        cursorState: undefined,
                    },
                    mockCancellationToken
                )

                const calledRequestInput: SendMessageCommandInput = sendMessageStub.firstCall.firstArg

                assert.strictEqual(
                    calledRequestInput.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
                        ?.editorState,
                    undefined
                )
            })

            it('leaves editor state as undefined if relative file path is undefined', async () => {
                const documentContextObject = {
                    programmingLanguage: 'typescript',
                    cursorState: [],
                    relativeFilePath: undefined,
                }
                extractDocumentContextStub.resolves(documentContextObject)

                await chatController.onInlineChatPrompt(
                    {
                        prompt: { prompt: 'Hello' },
                        cursorState: [mockCursorState],
                    },
                    mockCancellationToken
                )

                const calledRequestInput: SendMessageCommandInput = sendMessageStub.firstCall.firstArg

                assert.strictEqual(
                    calledRequestInput.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
                        ?.editorState,
                    undefined
                )
            })

            it('parses editor state context and includes as requestInput if both cursor state and text document are found', async () => {
                const documentContextObject = {
                    programmingLanguage: 'typescript',
                    cursorState: [],
                    relativeFilePath: typescriptDocument.uri,
                }
                extractDocumentContextStub.resolves(documentContextObject)

                await chatController.onInlineChatPrompt(
                    {
                        prompt: { prompt: 'Hello' },
                        textDocument: { uri: 'file:///test.ts' },
                        cursorState: [mockCursorState],
                    },
                    mockCancellationToken
                )

                const calledRequestInput: SendMessageCommandInput = sendMessageStub.firstCall.firstArg

                assert.deepStrictEqual(
                    calledRequestInput.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
                        ?.editorState,
                    {
                        cursorState: [],
                        document: {
                            programmingLanguage: 'typescript',
                            relativeFilePath: 'file:///test.ts',
                            text: undefined,
                        },
                    }
                )
            })
        })
    })

    describe('onCodeInsertToCursorPosition', () => {
        beforeEach(() => {
            chatController.onTabAdd({ tabId: mockTabId })
            testFeatures.lsp.workspace.applyWorkspaceEdit.resolves({ applied: true })
            testFeatures.workspace.getTextDocument = sinon.stub()
        })

        afterEach(() => {
            chatController.dispose()
        })

        it('handles regular insertion correctly', async () => {
            const document: TextDocument = TextDocument.create('test.ts', 'typescript', 1, ' ')
            testFeatures.workspace.getTextDocument.resolves(document)

            const cursorPosition = Position.create(0, 0)
            const params: InsertToCursorPositionParams = {
                textDocument: { uri: 'test.ts' },
                cursorPosition,
                code: 'const x = 1\n   const y = 2',
                tabId: mockTabId,
                messageId: 'XXX',
            }
            await chatController.onCodeInsertToCursorPosition(params)

            assert.deepStrictEqual(testFeatures.lsp.workspace.applyWorkspaceEdit.firstCall.args[0], {
                edit: {
                    documentChanges: [
                        {
                            textDocument: { uri: 'test.ts', version: 0 },
                            edits: [
                                {
                                    range: {
                                        start: cursorPosition,
                                        end: cursorPosition,
                                    },
                                    newText: params.code,
                                },
                            ],
                        },
                    ],
                },
            })
        })

        it('handles tab-based indentation correctly', async () => {
            const documentContent = 'function test() {\n\tif (true) {\n\t\t// cursor here\n\t}'
            const document: TextDocument = TextDocument.create('test.ts', 'typescript', 1, documentContent)
            testFeatures.workspace.getTextDocument.resolves(document)

            const cursorPosition = Position.create(2, 2)
            const params: InsertToCursorPositionParams = {
                textDocument: { uri: 'test.ts' },
                cursorPosition,
                code: 'console.log("test");\nconsole.log("test2")',
                tabId: mockTabId,
                messageId: 'XXX',
            }

            await chatController.onCodeInsertToCursorPosition(params)

            const documentChanges = testFeatures.lsp.workspace.applyWorkspaceEdit.firstCall.args[0].edit.documentChanges
            assert(documentChanges)
            const insertedText = (documentChanges[0] as TextDocumentEdit).edits[0].newText
            // Should maintain tab-based indentation
            assert.deepStrictEqual(insertedText, 'console.log("test");\n\t\tconsole.log("test2")')
        })

        it('handles insertion at mixed indentation levels correctly', async () => {
            const documentContent = `function test() {
    if (true) {
            // cursor here
        console.log("test");
    }
}`
            const document: TextDocument = TextDocument.create('test.ts', 'typescript', 1, documentContent)
            testFeatures.workspace.getTextDocument.resolves(document)

            const cursorPosition = Position.create(2, 12)
            const params: InsertToCursorPositionParams = {
                textDocument: { uri: 'test.ts' },
                cursorPosition,
                code: 'const x = 1;\nconst y = 2;',
                tabId: mockTabId,
                messageId: 'XXX',
            }

            await chatController.onCodeInsertToCursorPosition(params)

            // Verify that the inserted code maintains the indentation level of the insertion point
            const documentChanges = testFeatures.lsp.workspace.applyWorkspaceEdit.firstCall.args[0].edit.documentChanges
            assert(documentChanges)
            const insertedText = (documentChanges[0] as TextDocumentEdit).edits[0].newText
            assert.deepStrictEqual(insertedText, `const x = 1;\n${' '.repeat(12)}const y = 2;`)
        })

        it('handles code starting with multiple blank lines correctly', async () => {
            // Create a document with some existing indentation
            const documentContent = `${' '.repeat(4)}const existingCode = true;`
            const document: TextDocument = TextDocument.create('test.ts', 'typescript', 1, documentContent)
            testFeatures.workspace.getTextDocument.resolves(document)

            // Position cursor at an indented position
            const cursorPosition = Position.create(0, 4)
            const params: InsertToCursorPositionParams = {
                textDocument: { uri: 'test.ts' },
                cursorPosition,
                // Code starts with 3 blank lines, followed by actual code
                code: '\n\n\nfunction test() {\n    console.log("test");\n}',
                tabId: mockTabId,
                messageId: 'XXX',
            }
            await chatController.onCodeInsertToCursorPosition(params)

            const documentChanges = testFeatures.lsp.workspace.applyWorkspaceEdit.firstCall.args[0].edit.documentChanges
            assert(documentChanges)
            const insertedText = (documentChanges[0] as TextDocumentEdit).edits[0].newText
            // The blank lines should have no indentation
            // Only the actual code lines should be indented
            // First three lines should be empty with no indentation
            // Following lines should have the indentation
            assert.deepStrictEqual(
                insertedText,
                `\n\n\n${' '.repeat(4)}function test() {\n${' '.repeat(8)}console.log("test");\n${' '.repeat(4)}}`
            )
        })

        it('handles insertion of code with multiple leading blank lines into empty document at position 0', async () => {
            const documentContent = ''
            const document: TextDocument = TextDocument.create('test.py', 'python', 1, documentContent)
            testFeatures.workspace.getTextDocument.resolves(document)

            const cursorPosition = Position.create(0, 0)
            const params: InsertToCursorPositionParams = {
                textDocument: { uri: 'test.ts' },
                cursorPosition,
                // Code with 5 blank lines at the beginning
                code: '\n\n\n\n\ndef multiply(x, y):\n    result = x * y\n    return result\n\nprint(multiply(4, 5))',
                tabId: mockTabId,
                messageId: 'XXX',
            }

            await chatController.onCodeInsertToCursorPosition(params)

            const documentChanges = testFeatures.lsp.workspace.applyWorkspaceEdit.firstCall.args[0].edit.documentChanges
            assert(documentChanges)
            const insertedText = (documentChanges[0] as TextDocumentEdit).edits[0].newText
            // Since document is empty and cursor is at 0,0:
            // - Leading blank lines should be preserved exactly as is
            // - No additional indentation should be added to any lines
            assert.deepStrictEqual(insertedText, params.code)
        })

        it('handles undefined document content correctly', async () => {
            testFeatures.workspace.getTextDocument.resolves(undefined)

            const cursorPosition = Position.create(0, 0)
            const params: InsertToCursorPositionParams = {
                textDocument: { uri: 'test.ts' },
                cursorPosition,
                code: 'const x = 1;\nconst y = 2;',
                tabId: mockTabId,
                messageId: 'XXX',
            }

            await chatController.onCodeInsertToCursorPosition(params)

            // When document content is undefined, the code should:
            // 1. Still attempt to insert the code
            // 2. Not add any indentation

            const documentChanges = testFeatures.lsp.workspace.applyWorkspaceEdit.firstCall.args[0].edit.documentChanges
            assert(documentChanges)
            const edit = (documentChanges[0] as TextDocumentEdit).edits[0]

            assert.deepStrictEqual(edit.newText, params.code)
            assert.deepStrictEqual(edit.range.start, cursorPosition)
            assert.deepStrictEqual(edit.range.end, cursorPosition)
        })

        it('handles indentation correctly when inserting after an indent', async () => {
            // Text document contains 8 space characters
            const documentContent = ' '.repeat(8)
            const document: TextDocument = TextDocument.create('test.ts', 'typescript', 1, documentContent)
            testFeatures.workspace.getTextDocument.resolves(document)

            // Cursor is positioned at the end of the first line, after the 8 spaces
            const cursorPosition = Position.create(0, documentContent.length)
            const params: InsertToCursorPositionParams = {
                textDocument: { uri: 'test.ts' },
                cursorPosition,
                code: 'const x = 1\nconst y = 2',
                tabId: mockTabId,
                messageId: 'XXX',
            }
            await chatController.onCodeInsertToCursorPosition(params)

            assert.deepStrictEqual(testFeatures.lsp.workspace.applyWorkspaceEdit.firstCall.args[0], {
                edit: {
                    documentChanges: [
                        {
                            textDocument: { uri: 'test.ts', version: 0 },
                            edits: [
                                {
                                    range: {
                                        start: cursorPosition,
                                        end: cursorPosition,
                                    },
                                    // We expect new text to be added to the end of the existing line and also apply indentation on the next line
                                    newText: `const x = 1\n${' '.repeat(8)}const y = 2`,
                                },
                            ],
                        },
                    ],
                },
            })
        })

        it('handles indentation correctly when inserting at the end of a single line that does not have any indentation', async () => {
            const documentContent = 'console.log("Hello world")'
            const document: TextDocument = TextDocument.create('test.ts', 'typescript', 1, documentContent)
            testFeatures.workspace.getTextDocument.resolves(document)

            const forLoop = `for (let i = 2; i <= n; i++) {
                const next = prev + current;
                prev = current;
                current = next;
            }`

            const cursorPosition = Position.create(0, documentContent.length)
            const params: InsertToCursorPositionParams = {
                textDocument: { uri: 'test.ts' },
                cursorPosition,
                code: forLoop,
                tabId: mockTabId,
                messageId: 'XXX',
            }

            await chatController.onCodeInsertToCursorPosition(params)

            const documentChanges = testFeatures.lsp.workspace.applyWorkspaceEdit.firstCall.args[0].edit.documentChanges
            assert(documentChanges)
            const insertedText = (documentChanges[0] as TextDocumentEdit).edits[0].newText
            // For loop should be inserted as is in this case
            assert.deepStrictEqual(insertedText, forLoop)
        })

        it('handles indentation correctly when inserting inside an indented block', async () => {
            const fibonacci = `function fibonacci(n) {
    if (n <= 1) return n;

    let prev = 0, 
    let current = 1;

    for (let i = 2; i <= n; i++) {
        // Insertion will happen on the line below
        
        const next = prev + current;
        prev = current;
        current = next;
    }

    return current;
}
`

            // This test will insert an extra for loop inside the existing for loop in the fibonacci function above
            const forLoop = `for (let i = 2; i <= n; i++) {
    const next = prev + current;
    prev = current;
    current = next;
}
`
            // Given the for loop is inside a function and we will be inserting a new for loop inside, the for loop to be inserted will have 8 prefix spaces
            const twiceIndentedForLoop = `for (let i = 2; i <= n; i++) {
${' '.repeat(8)}    const next = prev + current;
${' '.repeat(8)}    prev = current;
${' '.repeat(8)}    current = next;
${' '.repeat(8)}}
`

            let document: TextDocument = TextDocument.create('test.ts', 'typescript', 1, fibonacci)
            testFeatures.workspace.getTextDocument.resolves(document)

            const cursorPosition = Position.create(8, 8)
            const params: InsertToCursorPositionParams = {
                textDocument: { uri: 'test.ts' },
                cursorPosition,
                code: forLoop,
                tabId: mockTabId,
                messageId: 'XXX',
            }

            await chatController.onCodeInsertToCursorPosition(params)

            const documentChanges = testFeatures.lsp.workspace.applyWorkspaceEdit.firstCall.args[0].edit.documentChanges
            assert(documentChanges)
            const insertedText = (documentChanges[0] as TextDocumentEdit).edits[0].newText
            assert.deepStrictEqual(insertedText, twiceIndentedForLoop)
        })

        it('handles virtual spaces when cursor is in empty line with virtual indent', async () => {
            // Create an empty document
            const document: TextDocument = TextDocument.create('test.ts', 'typescript', 1, '')
            testFeatures.workspace.getTextDocument.resolves(document)

            // Position cursor at character 8 in an empty line (virtual space)
            const cursorPosition = Position.create(0, 8)
            const params: InsertToCursorPositionParams = {
                textDocument: { uri: 'test.ts' },
                cursorPosition,
                code: 'const x = 1\nconst y = 2',
                tabId: mockTabId,
                messageId: 'XXX',
            }

            await chatController.onCodeInsertToCursorPosition(params)

            // The code should be indented with 8 spaces for both lines
            // and cursor should be moved to position 0
            assert.deepStrictEqual(testFeatures.lsp.workspace.applyWorkspaceEdit.firstCall.args[0], {
                edit: {
                    documentChanges: [
                        {
                            textDocument: { uri: 'test.ts', version: 0 },
                            edits: [
                                {
                                    range: {
                                        start: Position.create(0, 0), // Note: cursor moved to start
                                        end: Position.create(0, 0),
                                    },
                                    newText: `${' '.repeat(8)}const x = 1\n${' '.repeat(8)}const y = 2`,
                                },
                            ],
                        },
                    ],
                },
            })
        })

        it('handles virtual spaces with multiline code containing empty lines', async () => {
            // Create an empty document
            let document: TextDocument = TextDocument.create('test.ts', 'typescript', 1, '')
            testFeatures.workspace.getTextDocument.resolves(document)

            // Position cursor at character 4 in an empty line (virtual space)
            const cursorPosition = Position.create(0, 4)
            const params: InsertToCursorPositionParams = {
                textDocument: { uri: 'test.ts' },
                cursorPosition,
                code: 'if (condition) {\n\n    console.log("test");\n}',
                tabId: mockTabId,
                messageId: 'XXX',
            }

            await chatController.onCodeInsertToCursorPosition(params)

            // The code should be indented with 4 spaces, empty lines should remain empty
            assert.deepStrictEqual(testFeatures.lsp.workspace.applyWorkspaceEdit.firstCall.args[0], {
                edit: {
                    documentChanges: [
                        {
                            textDocument: { uri: 'test.ts', version: 0 },
                            edits: [
                                {
                                    range: {
                                        start: Position.create(0, 0), // Note: cursor moved to start
                                        end: Position.create(0, 0),
                                    },
                                    newText: `${' '.repeat(4)}if (condition) {\n\n${' '.repeat(8)}console.log("test");\n    }`,
                                },
                            ],
                        },
                    ],
                },
            })
        })

        it('handles virtual spaces correctly when code starts with empty line', async () => {
            const document: TextDocument = TextDocument.create('test.ts', 'typescript', 1, '')
            testFeatures.workspace.getTextDocument.resolves(document)

            // Position cursor at character 6 in an empty line (virtual space)
            const cursorPosition = Position.create(0, 6)
            const params: InsertToCursorPositionParams = {
                textDocument: { uri: 'test.ts' },
                cursorPosition,
                // Code starts with an empty line, followed by actual code
                code: '\nfunction test() {\n    console.log("test");\n}',
                tabId: mockTabId,
                messageId: 'XXX',
            }

            await chatController.onCodeInsertToCursorPosition(params)

            // The first empty line should have no indentation
            // Subsequent lines should be indented with 6 spaces
            assert.deepStrictEqual(testFeatures.lsp.workspace.applyWorkspaceEdit.firstCall.args[0], {
                edit: {
                    documentChanges: [
                        {
                            textDocument: { uri: 'test.ts', version: 0 },
                            edits: [
                                {
                                    range: {
                                        start: Position.create(0, 0), // Note: cursor moved to start
                                        end: Position.create(0, 0),
                                    },
                                    // First line is empty (no indentation)
                                    // Following lines get the virtual space indentation
                                    newText: `\n${' '.repeat(6)}function test() {\n${' '.repeat(10)}console.log("test");\n${' '.repeat(6)}}`,
                                },
                            ],
                        },
                    ],
                },
            })
        })
    })
})
