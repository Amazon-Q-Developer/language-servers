/**
 * Copied from ../chat/chatController.test.ts for the purpose of developing a divergent implementation.
 * Will be deleted or merged.
 */

import * as crypto from 'crypto'
import * as path from 'path'
import * as chokidar from 'chokidar'
import {
    ChatResponseStream,
    CodeWhispererStreaming,
    ContentType,
    GenerateAssistantResponseCommandInput,
    SendMessageCommandInput,
    ToolResultStatus,
} from '@amzn/codewhisperer-streaming'
import {
    QDeveloperStreaming,
    SendMessageCommandInput as SendMessageCommandInputQDeveloperStreaming,
    SendMessageCommandOutput as SendMessageCommandOutputQDeveloperStreaming,
} from '@amzn/amazon-q-developer-streaming-client'
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
    CancellationTokenSource,
    ContextCommand,
    ChatUpdateParams,
    ConnectionMetadata,
} from '@aws/language-server-runtimes/server-interface'
import { Model } from '@aws/language-server-runtimes/protocol'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import * as assert from 'assert'
import { createIterableResponse, setCredentialsForAmazonQTokenServiceManagerFactory } from '../../shared/testUtils'
import sinon from 'ts-sinon'
import { AgenticChatController } from './agenticChatController'
import { ChatSessionManagementService } from '../chat/chatSessionManagementService'
import { ChatSessionService } from '../chat/chatSessionService'
import { ChatTelemetryController } from '../chat/telemetry/chatTelemetryController'
import { DocumentContextExtractor } from '../chat/contexts/documentContext'
import * as utils from '../chat/utils'
import { DEFAULT_HELP_FOLLOW_UP_PROMPT, HELP_MESSAGE } from '../chat/constants'
import { TelemetryService } from '../../shared/telemetry/telemetryService'
import { AmazonQTokenServiceManager } from '../../shared/amazonQServiceManager/AmazonQTokenServiceManager'
import { AmazonQIAMServiceManager } from '../../shared/amazonQServiceManager/AmazonQIAMServiceManager'
import { TabBarController } from './tabBarController'
import { getUserPromptsDirectory, promptFileExtension } from './context/contextUtils'
import { AdditionalContextProvider } from './context/additionalContextProvider'
import { ContextCommandsProvider } from './context/contextCommandsProvider'
import { ChatDatabase } from './tools/chatDb/chatDb'
import { LocalProjectContextController } from '../../shared/localProjectContextController'
import { CancellationError } from '@aws/lsp-core'
import { ToolApprovalException } from './tools/toolShared'
import * as constants from './constants/constants'
import { GENERIC_ERROR_MS } from './constants/constants'
import { TokenLimitsCalculator } from './utils/tokenLimitsCalculator'
import { MISSING_BEARER_TOKEN_ERROR } from '../../shared/constants'
import {
    AmazonQError,
    AmazonQServicePendingProfileError,
    AmazonQServicePendingSigninError,
} from '../../shared/amazonQServiceManager/errors'
import { McpManager } from './tools/mcp/mcpManager'
import { AgenticChatResultStream } from './agenticChatResultStream'
import { AgenticChatError } from './errors'
import * as sharedUtils from '../../shared/utils'
import { IdleWorkspaceManager } from '../workspaceContext/IdleWorkspaceManager'
import { SinonStub } from 'sinon'

describe('AgenticChatController', () => {
    let mcpInstanceStub: sinon.SinonStub

    beforeEach(() => {
        mcpInstanceStub = sinon.stub(McpManager, 'instance').get(() => ({
            getAllTools: () => [
                {
                    serverName: 'server1',
                    toolName: 'server1_tool1',
                    description: 'Mock MCP tool 1',
                    inputSchema: {},
                },
                {
                    serverName: 'server2',
                    toolName: 'server2_tool2',
                    description: 'Mock MCP tool 2',
                    inputSchema: {},
                },
                {
                    serverName: 'server3',
                    toolName: 'server3_tool3',
                    description: 'Mock MCP tool 3',
                    inputSchema: {},
                },
            ],
            callTool: (_s: string, _t: string, _a: any) => Promise.resolve({}),
            getOriginalToolNames: () => null,
            clearToolNameMapping: () => {},
            setToolNameMapping: () => {},
        }))
    })

    afterEach(() => {
        mcpInstanceStub.restore()
        sinon.restore()
    })
    const mockTabId = 'tab-1'
    const mockConversationId = 'mock-conversation-id'
    const mockMessageId = 'mock-message-id'
    const mockPromptId = 'mock-prompt-id'

    const mockChatResponseList: ChatResponseStream[] = [
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
        body: 'Hello World!',
        messageId: 'mock-message-id',
        buttons: [],
        codeReference: [],
        header: undefined,
        additionalMessages: [],
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
    let generateAssistantResponseStub: sinon.SinonStub
    let additionalContextProviderStub: sinon.SinonStub
    let disposeStub: sinon.SinonStub
    let activeTabSpy: {
        get: sinon.SinonSpy<[], string | undefined>
        set: sinon.SinonSpy<[string | undefined], void>
    }
    let fsWriteFileStub: sinon.SinonStub
    let removeConversationSpy: sinon.SinonSpy
    let emitConversationMetricStub: sinon.SinonStub

    let testFeatures: TestFeatures
    let serviceManager: AmazonQTokenServiceManager
    let chatSessionManagementService: ChatSessionManagementService
    let chatController: AgenticChatController
    let telemetryService: TelemetryService
    let telemetry: Telemetry
    let chatDbInitializedStub: sinon.SinonStub
    let getMessagesStub: sinon.SinonStub
    let addMessageStub: sinon.SinonStub

    const setCredentials = setCredentialsForAmazonQTokenServiceManagerFactory(() => testFeatures)

    beforeEach(() => {
        // Override the response timeout for tests to avoid long waits
        sinon.stub(constants, 'RESPONSE_TIMEOUT_MS').value(100)

        sinon.stub(chokidar, 'watch').returns({
            on: sinon.stub(),
            close: sinon.stub(),
        } as unknown as chokidar.FSWatcher)

        // Mock getUserHomeDir function for McpEventHandler
        const getUserHomeDirStub = sinon.stub().returns('/mock/home/dir')
        testFeatures = new TestFeatures()
        testFeatures.workspace.fs.getUserHomeDir = getUserHomeDirStub

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

        generateAssistantResponseStub = sinon
            .stub(CodeWhispererStreaming.prototype, 'generateAssistantResponse')
            .callsFake(() => {
                return new Promise(resolve =>
                    setTimeout(() => {
                        resolve({
                            $metadata: {
                                requestId: mockMessageId,
                            },
                            generateAssistantResponseResponse: createIterableResponse(mockChatResponseList),
                        })
                    })
                )
            })

        testFeatures = new TestFeatures()
        fsWriteFileStub = sinon.stub()

        testFeatures.workspace.fs = {
            ...testFeatures.workspace.fs,
            getServerDataDirPath: sinon.stub().returns('/mock/server/data/path'),
            mkdir: sinon.stub().resolves(),
            readFile: sinon.stub().resolves(),
            writeFile: fsWriteFileStub.resolves(),
            rm: sinon.stub().resolves(),
            getFileSize: sinon.stub().resolves(),
        }

        // Add agent with runTool method to testFeatures
        testFeatures.agent = {
            runTool: sinon.stub().resolves({}),
            getTools: sinon.stub().returns(
                ['mock-tool-name', 'mock-tool-name-1', 'mock-tool-name-2', 'codeReview'].map(toolName => ({
                    toolSpecification: { name: toolName, description: 'Mock tool for testing' },
                }))
            ),
            addTool: sinon.stub().resolves(),
            removeTool: sinon.stub().resolves(),
            getBuiltInToolNames: sinon.stub().returns(['fsRead']),
            getBuiltInWriteToolNames: sinon.stub().returns(['fsWrite']),
        } as any // Using 'as any' to prevent type errors when the Agent interface is updated with new methods

        additionalContextProviderStub = sinon.stub(AdditionalContextProvider.prototype, 'getAdditionalContext')
        additionalContextProviderStub.callsFake(async () => {
            return []
        })
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
        testFeatures.lsp.window.showDocument = sinon.stub()
        testFeatures.setClientParams(cachedInitializeParams)
        setCredentials('builderId')

        activeTabSpy = sinon.spy(ChatTelemetryController.prototype, 'activeTabId', ['get', 'set'])
        removeConversationSpy = sinon.spy(ChatTelemetryController.prototype, 'removeConversation')
        emitConversationMetricStub = sinon.stub(ChatTelemetryController.prototype, 'emitConversationMetric')

        disposeStub = sinon.stub(ChatSessionService.prototype, 'dispose')
        sinon.stub(ContextCommandsProvider.prototype, 'maybeUpdateCodeSymbols').resolves()

        AmazonQTokenServiceManager.resetInstance()

        serviceManager = AmazonQTokenServiceManager.initInstance(testFeatures)
        chatSessionManagementService = ChatSessionManagementService.getInstance()
        chatSessionManagementService.withAmazonQServiceManager(serviceManager)

        // Add getConnectionMetadata to testFeatures.credentialsProvider
        testFeatures.credentialsProvider.getConnectionMetadata = (
            sinon.stub() as SinonStub<[], ConnectionMetadata | undefined>
        ).returns({
            sso: {
                startUrl: undefined,
            },
        })

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

        getMessagesStub = sinon.stub(ChatDatabase.prototype, 'getMessages').returns([])
        addMessageStub = sinon.stub(ChatDatabase.prototype, 'addMessage')
        chatDbInitializedStub = sinon.stub(ChatDatabase.prototype, 'isInitialized')

        telemetryService = new TelemetryService(serviceManager, mockCredentialsProvider, telemetry, logging)
        chatController = new AgenticChatController(
            chatSessionManagementService,
            testFeatures,
            telemetryService,
            serviceManager
        )
    })

    afterEach(() => {
        if (chatController) {
            chatController.dispose()
        }
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

    describe('setPaidTierMode caching', () => {
        let getCodewhispererServiceStub: sinon.SinonStub
        let getSubscriptionStatusStub: sinon.SinonStub

        beforeEach(() => {
            getSubscriptionStatusStub = sinon.stub().resolves({ status: 'none' })
            getCodewhispererServiceStub = sinon
                .stub(AmazonQTokenServiceManager.prototype, 'getCodewhispererService')
                .returns({ getSubscriptionStatus: getSubscriptionStatusStub } as any)
        })

        afterEach(() => {
            getCodewhispererServiceStub.restore()
        })

        it('calls getSubscriptionStatus on first tab add', async () => {
            chatController.onTabAdd({ tabId: mockTabId })
            // Allow the async getSubscriptionStatus call to resolve
            await new Promise(resolve => setTimeout(resolve, 0))
            sinon.assert.calledOnce(getSubscriptionStatusStub)
        })

        it('does not call getSubscriptionStatus on subsequent tab adds after status is cached', async () => {
            chatController.onTabAdd({ tabId: mockTabId })
            await new Promise(resolve => setTimeout(resolve, 0))
            sinon.assert.calledOnce(getSubscriptionStatusStub)

            getSubscriptionStatusStub.resetHistory()
            chatController.onTabAdd({ tabId: 'tab-2' })
            await new Promise(resolve => setTimeout(resolve, 0))
            sinon.assert.notCalled(getSubscriptionStatusStub)
        })

        it('does not call getSubscriptionStatus on tab change after status is cached', async () => {
            chatController.onTabAdd({ tabId: mockTabId })
            await new Promise(resolve => setTimeout(resolve, 0))
            sinon.assert.calledOnce(getSubscriptionStatusStub)

            getSubscriptionStatusStub.resetHistory()
            chatController.onTabChange({ tabId: mockTabId })
            await new Promise(resolve => setTimeout(resolve, 0))
            sinon.assert.notCalled(getSubscriptionStatusStub)
        })

        it('caches paidtier status when subscription is active', async () => {
            getSubscriptionStatusStub.resolves({ status: 'active' })
            chatController.onTabAdd({ tabId: mockTabId })
            await new Promise(resolve => setTimeout(resolve, 0))

            getSubscriptionStatusStub.resetHistory()
            chatController.onTabAdd({ tabId: 'tab-2' })
            await new Promise(resolve => setTimeout(resolve, 0))
            sinon.assert.notCalled(getSubscriptionStatusStub)
        })

        it('deduplicates concurrent calls: multiple tabs opened before the first promise settles fire only one API call', async () => {
            // Fire 5 tab-adds synchronously before the promise resolves.
            chatController.onTabAdd({ tabId: 'tab-1' })
            chatController.onTabAdd({ tabId: 'tab-2' })
            chatController.onTabAdd({ tabId: 'tab-3' })
            chatController.onTabAdd({ tabId: 'tab-4' })
            chatController.onTabAdd({ tabId: 'tab-5' })

            // Let all pending microtasks/macrotasks settle.
            await new Promise(resolve => setTimeout(resolve, 0))

            sinon.assert.calledOnce(getSubscriptionStatusStub)
        })
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

        describe('GovCloud region block', () => {
            it('short-circuits with an unsupported-region response when client region is us-gov-west-1', async () => {
                testFeatures.setClientParams({
                    initializationOptions: {
                        aws: {
                            region: 'us-gov-west-1',
                            awsClientCapabilities: { q: { developerProfiles: false } },
                        },
                    },
                } as any)

                const result = await chatController.onChatPrompt(
                    { tabId: mockTabId, prompt: { prompt: 'Hello' } },
                    mockCancellationToken
                )

                assert.ok(!(result instanceof ResponseError))
                assert.ok((result as ChatResult).body?.includes('GovCloud'))
                assert.ok((result as ChatResult).body?.includes('us-gov-west-1'))
            })
        })

        describe('Prompt ID', () => {
            let setCurrentPromptIdStub: sinon.SinonStub

            beforeEach(() => {
                const session = chatSessionManagementService.getSession(mockTabId).data!
                setCurrentPromptIdStub = sinon.stub(session, 'setCurrentPromptId')
            })

            it('sets prompt ID at the beginning of onChatPrompt', async () => {
                await chatController.onChatPrompt(
                    { tabId: mockTabId, prompt: { prompt: 'Hello' } },
                    mockCancellationToken
                )

                sinon.assert.calledOnce(setCurrentPromptIdStub)
                // Verify the prompt ID is a UUID string
                const promptId = setCurrentPromptIdStub.firstCall.args[0]
                assert.strictEqual(typeof promptId, 'string')
                assert.ok(promptId.length > 0)
            })
        })

        it('read all the response streams and return compiled results', async () => {
            const chatResultPromise = chatController.onChatPrompt(
                { tabId: mockTabId, prompt: { prompt: 'Hello' } },
                mockCancellationToken
            )

            const chatResult = await chatResultPromise

            sinon.assert.callCount(testFeatures.lsp.sendProgress, 0)

            assert.deepStrictEqual(chatResult, {
                additionalMessages: [],
                body: '\nHello World!',
                messageId: 'mock-message-id',
                buttons: [],
                codeReference: [],
                header: undefined,
            })
        })

        it('creates a new conversationId if missing in the session', async () => {
            // Create a session without a conversationId
            chatController.onTabAdd({ tabId: mockTabId })
            const session = chatSessionManagementService.getSession(mockTabId).data

            // Verify session exists but has no conversationId initially
            assert.ok(session)
            assert.strictEqual(session.conversationId, undefined)

            // Make the request
            await chatController.onChatPrompt({ tabId: mockTabId, prompt: { prompt: 'Hello' } }, mockCancellationToken)

            // Verify that a conversationId was created
            assert.ok(session.conversationId)
            assert.strictEqual(typeof session.conversationId, 'string')
        })

        it('includes conversationId in the request input', async () => {
            chatController.onTabAdd({ tabId: mockTabId })
            const session = chatSessionManagementService.getSession(mockTabId).data
            assert.ok(session)

            await chatController.onChatPrompt({ tabId: mockTabId, prompt: { prompt: 'Hello' } }, mockCancellationToken)

            const requestInput: GenerateAssistantResponseCommandInput = generateAssistantResponseStub.firstCall.firstArg
            assert.strictEqual(requestInput.conversationState?.conversationId, session.conversationId)
        })

        it('invokes IdleWorkspaceManager recordActivityTimestamp', async () => {
            const recordActivityTimestampStub = sinon.stub(IdleWorkspaceManager, 'recordActivityTimestamp')

            await chatController.onChatPrompt({ tabId: mockTabId, prompt: { prompt: 'Hello' } }, mockCancellationToken)

            sinon.assert.calledOnce(recordActivityTimestampStub)
            recordActivityTimestampStub.restore()
        })

        it('includes chat history from the database in the request input', async () => {
            // Mock chat history
            const mockHistory = [
                {
                    type: 'prompt',
                    body: 'Previous question',
                    userInputMessageContext: {
                        toolResults: [],
                    },
                },
                { type: 'answer', body: 'Previous answer' },
            ]
            const expectedRequestHistory = [
                {
                    userInputMessage: {
                        content: 'Previous question',
                        images: [],
                        origin: 'IDE',
                        userInputMessageContext: { toolResults: [] },
                        userIntent: undefined,
                    },
                },
                {
                    assistantResponseMessage: {
                        content: 'Previous answer',
                        messageId: undefined,
                        toolUses: [],
                    },
                },
            ]

            chatDbInitializedStub.returns(true)
            getMessagesStub.returns(mockHistory)

            // Make the request
            const result = await chatController.onChatPrompt(
                { tabId: mockTabId, prompt: { prompt: 'Hello' } },
                mockCancellationToken
            )

            // Verify that history was requested from the db
            sinon.assert.calledWith(getMessagesStub, mockTabId)

            assert.ok(generateAssistantResponseStub.calledOnce)

            // Verify that the history was passed to the request
            const requestInput: GenerateAssistantResponseCommandInput = generateAssistantResponseStub.firstCall.firstArg
            assert.deepStrictEqual(requestInput.conversationState?.history, expectedRequestHistory)
        })

        it('includes chat history from the database in the compaction request input', async () => {
            // Mock chat history
            const mockHistory = [
                {
                    type: 'prompt',
                    body: 'Previous question',
                    userInputMessageContext: {
                        toolResults: [],
                    },
                },
                { type: 'answer', body: 'Previous answer' },
            ]
            const expectedRequestHistory = [
                {
                    userInputMessage: {
                        content: 'Previous question',
                        images: [],
                        origin: 'IDE',
                        userInputMessageContext: { toolResults: [] },
                        userIntent: undefined,
                    },
                },
                {
                    assistantResponseMessage: {
                        content: 'Previous answer',
                        messageId: undefined,
                        toolUses: [],
                    },
                },
            ]

            chatDbInitializedStub.returns(true)
            getMessagesStub.returns(mockHistory)

            // Make the request
            const result = await chatController.onChatPrompt(
                { tabId: mockTabId, prompt: { prompt: '', command: '/compact' } },
                mockCancellationToken
            )

            // Verify that history was requested from the db
            sinon.assert.calledWith(getMessagesStub, mockTabId)

            assert.ok(generateAssistantResponseStub.calledOnce)

            // Verify that the history was passed to the request
            const requestInput: GenerateAssistantResponseCommandInput = generateAssistantResponseStub.firstCall.firstArg
            assert.deepStrictEqual(requestInput.conversationState?.history, expectedRequestHistory)
            assert.deepStrictEqual(
                requestInput.conversationState?.currentMessage?.userInputMessage?.content,
                constants.COMPACTION_PROMPT
            )
        })

        it('skips adding user message to history when token is cancelled', async () => {
            // Create a cancellation token that is already cancelled
            const cancelledToken = {
                isCancellationRequested: true,
                onCancellationRequested: () => ({ dispose: () => null }),
            }

            // Execute with cancelled token
            await chatController.onChatPrompt({ tabId: mockTabId, prompt: { prompt: 'Hello' } }, cancelledToken)

            sinon.assert.notCalled(addMessageStub)
        })

        it('skips adding user message to history when prompt ID is no longer current', async () => {
            // Setup session with a different current prompt ID
            const session = chatSessionManagementService.getSession(mockTabId).data!
            const isCurrentPromptStub = sinon.stub(session, 'isCurrentPrompt').returns(false)

            // Execute with non-current prompt ID
            await chatController.onChatPrompt({ tabId: mockTabId, prompt: { prompt: 'Hello' } }, mockCancellationToken)

            sinon.assert.called(isCurrentPromptStub)
            sinon.assert.notCalled(addMessageStub)
        })

        it('handles tool use responses and makes multiple requests', async () => {
            // First response includes a tool use request
            const mockToolUseId = 'mock-tool-use-id'
            const mockToolName = 'mock-tool-name'
            const mockToolInput = JSON.stringify({ param1: 'value1' })
            const mockToolResult = { result: 'tool execution result' }

            const mockToolUseResponseList: ChatResponseStream[] = [
                {
                    messageMetadataEvent: {
                        conversationId: mockConversationId,
                    },
                },
                {
                    assistantResponseEvent: {
                        content: 'I need to use a tool. ',
                    },
                },
                {
                    toolUseEvent: {
                        toolUseId: mockToolUseId,
                        name: mockToolName,
                        input: mockToolInput,
                        stop: true,
                    },
                },
            ]

            // Second response after tool execution
            const mockFinalResponseList: ChatResponseStream[] = [
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

            chatDbInitializedStub.returns(true)
            getMessagesStub.onFirstCall().returns([])
            getMessagesStub.onSecondCall().returns([
                {
                    type: 'prompt',
                    body: 'Hello with tool',
                    userInputMessageContext: {
                        toolResults: [],
                    },
                },
                {
                    type: 'answer',
                    body: 'I need to use a tool. ',
                    toolUses: [{ toolUseId: mockToolUseId, name: mockToolName, input: { key: mockToolInput } }],
                },
            ])

            // Reset the stub and set up to return different responses on consecutive calls
            generateAssistantResponseStub.restore()
            generateAssistantResponseStub = sinon.stub(CodeWhispererStreaming.prototype, 'generateAssistantResponse')

            generateAssistantResponseStub.onFirstCall().returns(
                Promise.resolve({
                    $metadata: {
                        requestId: mockMessageId,
                    },
                    generateAssistantResponseResponse: createIterableResponse(mockToolUseResponseList),
                })
            )

            generateAssistantResponseStub.onSecondCall().returns(
                Promise.resolve({
                    $metadata: {
                        requestId: mockMessageId,
                    },
                    generateAssistantResponseResponse: createIterableResponse(mockFinalResponseList),
                })
            )

            // Reset the runTool stub
            const runToolStub = testFeatures.agent.runTool as sinon.SinonStub
            runToolStub.reset()
            runToolStub.resolves(mockToolResult)

            // Make the request
            const chatResultPromise = chatController.onChatPrompt(
                { tabId: mockTabId, prompt: { prompt: 'Hello with tool' } },
                mockCancellationToken
            )

            const chatResult = await chatResultPromise

            // Verify that generateAssistantResponse was called twice
            sinon.assert.calledTwice(generateAssistantResponseStub)

            // Verify that the second request included the tool results in the userInputMessageContext
            const secondCallArgs = generateAssistantResponseStub.secondCall.args[0]
            assert.ok(
                secondCallArgs.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults
            )
            assert.strictEqual(
                secondCallArgs.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults
                    .length,
                1
            )
            assert.strictEqual(
                secondCallArgs.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
                    ?.toolResults[0].toolUseId,
                mockToolUseId
            )
            assert.strictEqual(
                secondCallArgs.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
                    ?.toolResults[0].status,
                'success'
            )
            assert.deepStrictEqual(
                secondCallArgs.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
                    ?.toolResults[0].content[0].json,
                mockToolResult
            )

            // Verify that the history was updated correctly
            assert.ok(secondCallArgs.conversationState?.history)
            assert.strictEqual(secondCallArgs.conversationState?.history.length, 2)
            assert.ok(secondCallArgs.conversationState?.history[0].userInputMessage)
            assert.ok(secondCallArgs.conversationState?.history[1].assistantResponseMessage)

            // Verify the final result
            assertChatResultsMatch(chatResult, expectedCompleteChatResult)
        })

        it('propagates tool execution errors to the model in toolResults', async () => {
            // First response includes a tool use request
            const mockToolUseId = 'mock-tool-use-id-error'
            const mockToolName = 'mock-tool-name'
            const mockToolInput = JSON.stringify({ param1: 'value1' })
            const mockErrorMessage = 'Tool execution failed with an error'

            const mockToolUseResponseList: ChatResponseStream[] = [
                {
                    messageMetadataEvent: {
                        conversationId: mockConversationId,
                    },
                },
                {
                    assistantResponseEvent: {
                        content: 'I need to use a tool that will fail. ',
                    },
                },
                {
                    toolUseEvent: {
                        toolUseId: mockToolUseId,
                        name: mockToolName,
                        input: mockToolInput,
                        stop: true,
                    },
                },
            ]

            // Second response after tool execution error
            const mockFinalResponseList: ChatResponseStream[] = [
                {
                    messageMetadataEvent: {
                        conversationId: mockConversationId,
                    },
                },
                {
                    assistantResponseEvent: {
                        content: 'I see the tool failed with error: ',
                    },
                },
                {
                    assistantResponseEvent: {
                        content: mockErrorMessage,
                    },
                },
            ]

            chatDbInitializedStub.returns(true)
            getMessagesStub
                .onFirstCall()
                .returns([])
                .onSecondCall()
                .returns([
                    {
                        type: 'prompt',
                        body: 'Hello with failing tool',
                        userInputMessageContext: {
                            toolResults: [],
                        },
                    },
                    {
                        type: 'answer',
                        body: 'I need to use a tool that will fail. ',
                        toolUses: [{ toolUseId: mockToolUseId, name: mockToolName, input: { key: mockToolInput } }],
                    },
                ])

            // Reset the stub and set up to return different responses on consecutive calls
            generateAssistantResponseStub.restore()
            generateAssistantResponseStub = sinon.stub(CodeWhispererStreaming.prototype, 'generateAssistantResponse')

            generateAssistantResponseStub.onFirstCall().returns(
                Promise.resolve({
                    $metadata: {
                        requestId: mockMessageId,
                    },
                    generateAssistantResponseResponse: createIterableResponse(mockToolUseResponseList),
                })
            )

            generateAssistantResponseStub.onSecondCall().returns(
                Promise.resolve({
                    $metadata: {
                        requestId: mockMessageId,
                    },
                    generateAssistantResponseResponse: createIterableResponse(mockFinalResponseList),
                })
            )

            // Reset the runTool stub and make it throw an error
            const runToolStub = testFeatures.agent.runTool as sinon.SinonStub
            runToolStub.reset()
            runToolStub.rejects(new Error(mockErrorMessage))

            // Make the request
            const chatResultPromise = chatController.onChatPrompt(
                { tabId: mockTabId, prompt: { prompt: 'Hello with failing tool' } },
                mockCancellationToken
            )

            const chatResult = await chatResultPromise

            // Verify that generateAssistantResponse was called twice
            sinon.assert.calledTwice(generateAssistantResponseStub)

            // Verify that the second request included the tool error in the toolResults with status 'error'
            const secondCallArgs = generateAssistantResponseStub.secondCall.args[0]
            assert.ok(
                secondCallArgs.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults
            )
            assert.strictEqual(
                secondCallArgs.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults
                    .length,
                1
            )
            assert.strictEqual(
                secondCallArgs.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
                    ?.toolResults[0].toolUseId,
                mockToolUseId
            )
            assert.strictEqual(
                secondCallArgs.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
                    ?.toolResults[0].status,
                'error'
            )
            assert.ok(
                secondCallArgs.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
                    ?.toolResults[0].content[0].json
            )

            // Verify that the history was updated correctly
            assert.ok(secondCallArgs.conversationState?.history)
            assert.strictEqual(secondCallArgs.conversationState?.history.length, 2)
            assert.ok(secondCallArgs.conversationState?.history[0].userInputMessage)
            assert.ok(secondCallArgs.conversationState?.history[1].assistantResponseMessage)

            // Create expected result format matching the actual format
            const expectedErrorChatResult: ChatResult = {
                messageId: mockMessageId,
                body: 'I see the tool failed with error: Tool execution failed with an error',
                buttons: [],
                codeReference: [],
                header: undefined,
                additionalMessages: [],
            }

            // Verify the final result includes both messages
            assertChatResultsMatch(chatResult, expectedErrorChatResult)
        })

        it('handles multiple iterations of tool uses with proper history updates', async () => {
            // First response includes a tool use request
            const mockToolUseId1 = 'mock-tool-use-id-1'
            const mockToolName1 = 'mock-tool-name-1'
            const mockToolInput1 = JSON.stringify({ param1: 'value1' })
            const mockToolResult1 = { result: 'tool execution result 1' }

            // Second tool use in a subsequent response
            const mockToolUseId2 = 'mock-tool-use-id-2'
            const mockToolName2 = 'mock-tool-name-2'
            const mockToolInput2 = JSON.stringify({ param2: 'value2' })
            const mockToolResult2 = { result: 'tool execution result 2' }

            // First response with first tool use
            const mockFirstToolUseResponseList: ChatResponseStream[] = [
                {
                    messageMetadataEvent: {
                        conversationId: mockConversationId,
                    },
                },
                {
                    assistantResponseEvent: {
                        content: 'I need to use tool 1. ',
                    },
                },
                {
                    toolUseEvent: {
                        toolUseId: mockToolUseId1,
                        name: mockToolName1,
                        input: mockToolInput1,
                        stop: true,
                    },
                },
            ]

            // Second response with second tool use
            const mockSecondToolUseResponseList: ChatResponseStream[] = [
                {
                    messageMetadataEvent: {
                        conversationId: mockConversationId,
                    },
                },
                {
                    assistantResponseEvent: {
                        content: 'Now I need to use tool 2. ',
                    },
                },
                {
                    toolUseEvent: {
                        toolUseId: mockToolUseId2,
                        name: mockToolName2,
                        input: mockToolInput2,
                        stop: true,
                    },
                },
            ]

            // Final response with complete answer
            const mockFinalResponseList: ChatResponseStream[] = [
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

            const historyAfterTool1 = [
                {
                    type: 'prompt',
                    body: 'Hello with multiple tools',
                    userInputMessageContext: {
                        toolResults: [],
                    },
                },
                {
                    type: 'answer',
                    body: 'I need to use tool 1. ',
                    toolUses: [{ toolUseId: mockToolUseId1, name: mockToolName1, input: { key: mockToolInput1 } }],
                },
            ]
            const historyAfterTool2 = [
                ...historyAfterTool1,
                { type: 'prompt', body: 'Hello with multiple tools' },
                {
                    type: 'answer',
                    body: 'Now I need to use tool 2. ',
                    toolUses: [{ toolUseId: mockToolUseId2, name: mockToolName2, input: { key: mockToolInput2 } }],
                },
            ]

            chatDbInitializedStub.returns(true)
            getMessagesStub
                .onFirstCall()
                .returns([])
                .onSecondCall()
                .returns(historyAfterTool1)
                .onThirdCall()
                .returns(historyAfterTool2)

            // Reset the stub and set up to return different responses on consecutive calls
            generateAssistantResponseStub.restore()
            generateAssistantResponseStub = sinon.stub(CodeWhispererStreaming.prototype, 'generateAssistantResponse')

            generateAssistantResponseStub.onFirstCall().returns(
                Promise.resolve({
                    $metadata: {
                        requestId: mockMessageId,
                    },
                    generateAssistantResponseResponse: createIterableResponse(mockFirstToolUseResponseList),
                })
            )

            generateAssistantResponseStub.onSecondCall().returns(
                Promise.resolve({
                    $metadata: {
                        requestId: mockMessageId,
                    },
                    generateAssistantResponseResponse: createIterableResponse(mockSecondToolUseResponseList),
                })
            )

            generateAssistantResponseStub.onThirdCall().returns(
                Promise.resolve({
                    $metadata: {
                        requestId: mockMessageId,
                    },
                    generateAssistantResponseResponse: createIterableResponse(mockFinalResponseList),
                })
            )

            // Reset the runTool stub
            const runToolStub = testFeatures.agent.runTool as sinon.SinonStub
            runToolStub.reset()
            runToolStub.withArgs(mockToolName1, JSON.parse(mockToolInput1)).resolves(mockToolResult1)
            runToolStub.withArgs(mockToolName2, JSON.parse(mockToolInput2)).resolves(mockToolResult2)

            // Make the request
            const chatResultPromise = chatController.onChatPrompt(
                { tabId: mockTabId, prompt: { prompt: 'Hello with multiple tools' } },
                mockCancellationToken
            )

            const chatResult = await chatResultPromise

            // Verify that generateAssistantResponse was called three times
            sinon.assert.calledThrice(generateAssistantResponseStub)

            // Verify that the second request included the first tool results
            const secondCallArgs = generateAssistantResponseStub.secondCall.args[0]
            assert.ok(
                secondCallArgs.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults
            )
            assert.strictEqual(
                secondCallArgs.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults
                    .length,
                1
            )
            assert.strictEqual(
                secondCallArgs.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
                    ?.toolResults[0].toolUseId,
                mockToolUseId1
            )

            // Verify that the history was updated correctly after first tool use
            assert.ok(secondCallArgs.conversationState?.history)
            assert.strictEqual(secondCallArgs.conversationState?.history.length, 2)
            assert.ok(secondCallArgs.conversationState?.history[0].userInputMessage)
            assert.ok(secondCallArgs.conversationState?.history[1].assistantResponseMessage)
            assert.strictEqual(
                secondCallArgs.conversationState?.history[1].assistantResponseMessage?.content,
                'I need to use tool 1. '
            )

            // Verify that the third request included the second tool results
            const thirdCallArgs = generateAssistantResponseStub.thirdCall.args[0]
            assert.ok(
                thirdCallArgs.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults
            )
            assert.strictEqual(
                thirdCallArgs.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults
                    .length,
                1
            )
            assert.strictEqual(
                thirdCallArgs.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
                    ?.toolResults[0].toolUseId,
                mockToolUseId2
            )

            // Verify that the history was updated correctly after second tool use
            assert.ok(thirdCallArgs.conversationState?.history)
            assert.strictEqual(thirdCallArgs.conversationState?.history.length, 4)
            assert.ok(thirdCallArgs.conversationState?.history[2].userInputMessage)
            assert.ok(thirdCallArgs.conversationState?.history[3].assistantResponseMessage)
            assert.strictEqual(
                thirdCallArgs.conversationState?.history[3].assistantResponseMessage?.content,
                'Now I need to use tool 2. '
            )

            // Verify the final result
            assertChatResultsMatch(chatResult, expectedCompleteChatResult)
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

            sinon.assert.callCount(testFeatures.lsp.sendProgress, mockChatResponseList.length + 1) // response length + 1 loading messages
            assert.deepStrictEqual(chatResult, {
                additionalMessages: [],
                body: '\nHello World!',
                messageId: 'mock-message-id',
                codeReference: [],
                buttons: [],
                header: undefined,
            })
        })

        it('can use 0 as progress token', async () => {
            const chatResultPromise = chatController.onChatPrompt(
                { tabId: mockTabId, prompt: { prompt: 'Hello' }, partialResultToken: 0 },
                mockCancellationToken
            )

            const chatResult = await chatResultPromise

            sinon.assert.callCount(testFeatures.lsp.sendProgress, mockChatResponseList.length + 1) // response length + 1 loading message
            assert.deepStrictEqual(chatResult, {
                additionalMessages: [],
                body: '\nHello World!',
                messageId: 'mock-message-id',
                buttons: [],
                codeReference: [],
                header: undefined,
            })
        })

        it('propagates model error back to client', async () => {
            const errorMsg = 'This is an error from the backend'
            generateAssistantResponseStub.callsFake(() => {
                throw new Error(errorMsg)
            })

            const chatResult = await chatController.onChatPrompt(
                { tabId: mockTabId, prompt: { prompt: 'Hello' } },
                mockCancellationToken
            )

            // These checks will fail if a response error is returned.
            const typedChatResult = chatResult as ChatResult
            assert.strictEqual(typedChatResult.body, errorMsg)
        })

        it('truncate input to dynamic input limit', async function () {
            const defaultLimits = TokenLimitsCalculator.calculate()
            const input = 'X'.repeat(defaultLimits.inputLimit + 10)
            generateAssistantResponseStub.restore()
            generateAssistantResponseStub = sinon.stub(CodeWhispererStreaming.prototype, 'generateAssistantResponse')
            generateAssistantResponseStub.callsFake(() => {})
            await chatController.onChatPrompt({ tabId: mockTabId, prompt: { prompt: input } }, mockCancellationToken)
            assert.ok(generateAssistantResponseStub.called)
            const calledRequestInput: GenerateAssistantResponseCommandInput =
                generateAssistantResponseStub.firstCall.firstArg
            assert.deepStrictEqual(
                calledRequestInput.conversationState?.currentMessage?.userInputMessage?.content?.length,
                defaultLimits.inputLimit
            )
        })
        it('shows generic errorMsg on internal errors', async function () {
            const chatResult = await chatController.onChatPrompt(
                { tabId: mockTabId, prompt: { prompt: 'Hello' } },
                undefined as any
            )

            const typedChatResult = chatResult as ResponseError<ChatResult>
            assert.strictEqual(typedChatResult.data?.body, GENERIC_ERROR_MS)
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
            it(`returns ${testCase.expectedAuthFollowUp} follow up action when model request returns auth error: '${testCase.error instanceof AmazonQError ? testCase.error.code : testCase.error.message}'`, async () => {
                generateAssistantResponseStub.callsFake(() => {
                    throw testCase.error
                })

                const chatResultPromise = chatController.onChatPrompt(
                    { tabId: mockTabId, prompt: { prompt: 'Hello' }, partialResultToken: 1 },
                    mockCancellationToken
                )

                const chatResult = await chatResultPromise

                // called once for error message propagation and once for loading message.
                sinon.assert.callCount(testFeatures.lsp.sendProgress, 2)
                // @ts-ignore
                assert.deepStrictEqual(chatResult, utils.createAuthFollowUpResult(testCase.expectedAuthFollowUp))
            })
        })

        it('returns a ResponseError if response streams returns an error event', async () => {
            generateAssistantResponseStub.callsFake(() => {
                return Promise.resolve({
                    $metadata: {
                        requestId: mockMessageId,
                    },
                    generateAssistantResponseResponse: createIterableResponse([
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

            const typedChatResult = chatResult as ResponseError<ChatResult>
            assert.strictEqual(typedChatResult.data?.body, GENERIC_ERROR_MS)
            assert.strictEqual(typedChatResult.message, 'some error')
        })

        it('returns a ResponseError if response streams return an invalid state event', async () => {
            generateAssistantResponseStub.callsFake(() => {
                return Promise.resolve({
                    $metadata: {
                        requestId: mockMessageId,
                    },
                    generateAssistantResponseResponse: createIterableResponse([
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

            const typedChatResult = chatResult as ResponseError<ChatResult>
            assert.strictEqual(typedChatResult.data?.body, GENERIC_ERROR_MS)
            assert.strictEqual(typedChatResult.message, 'invalid state')
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

            it('leaves cursorState as undefined if cursorState is not passed', async () => {
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

                const calledRequestInput: GenerateAssistantResponseCommandInput =
                    generateAssistantResponseStub.firstCall.firstArg

                assert.strictEqual(
                    calledRequestInput.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
                        ?.editorState?.cursorState,
                    undefined
                )
            })

            it('leaves document as undefined if relative file path is undefined', async () => {
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

                const calledRequestInput: GenerateAssistantResponseCommandInput =
                    generateAssistantResponseStub.firstCall.firstArg

                assert.strictEqual(
                    calledRequestInput.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
                        ?.editorState?.document,
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

                const calledRequestInput: GenerateAssistantResponseCommandInput =
                    generateAssistantResponseStub.firstCall.firstArg

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
                        workspaceFolders: [],
                        relevantDocuments: undefined,
                        useRelevantDocuments: false,
                    }
                )
            })

            it('includes both additional context and active file in context transparency list', async () => {
                const mockAdditionalContext = [
                    {
                        name: 'additional.ts',
                        description: '',
                        type: 'file',
                        relativePath: 'src/additional.ts',
                        path: '/workspace/src/additional.ts',
                        startLine: -1,
                        endLine: -1,
                        innerContext: 'additional content',
                        pinned: false,
                    },
                ]

                // Mock getAdditionalContext to return additional context
                additionalContextProviderStub.resolves(mockAdditionalContext)

                // Mock the expected return value from getFileListFromContext
                const expectedFileList = {
                    filePaths: ['src/additional.ts', 'src/active.ts'],
                    details: {
                        'src/additional.ts': { description: '/workspace/src/additional.ts' },
                        'src/active.ts': { description: '/workspace/src/active.ts' },
                    },
                }

                // Mock getFileListFromContext to capture what gets passed to it
                const getFileListFromContextStub = sinon.stub(
                    AdditionalContextProvider.prototype,
                    'getFileListFromContext'
                )
                getFileListFromContextStub.returns(expectedFileList)

                const documentContextObject = {
                    programmingLanguage: 'typescript',
                    cursorState: [],
                    relativeFilePath: 'src/active.ts',
                    activeFilePath: '/workspace/src/active.ts',
                    text: 'active file content',
                }
                extractDocumentContextStub.resolves(documentContextObject)

                await chatController.onChatPrompt(
                    {
                        tabId: mockTabId,
                        prompt: { prompt: 'Hello' },
                        textDocument: { uri: 'file:///workspace/src/active.ts' },
                        cursorState: [mockCursorState],
                        context: [{ command: 'Additional File', description: 'file.txt' }],
                        partialResultToken: 1, // Enable progress updates
                    },
                    mockCancellationToken
                )

                // Verify getFileListFromContext was called with combined context (additional + active file)
                sinon.assert.calledOnce(getFileListFromContextStub)
                const contextItemsPassedToGetFileList = getFileListFromContextStub.firstCall.args[0]

                // Should include both additional context and active file
                assert.strictEqual(contextItemsPassedToGetFileList.length, 2)

                // Find the additional context item
                const additionalContextItem = contextItemsPassedToGetFileList.find(
                    (item: any) => item.relativePath === 'src/additional.ts'
                )
                assert.ok(additionalContextItem, 'Additional context should be included')

                // Find the active file item
                const activeFileItem = contextItemsPassedToGetFileList.find(
                    (item: any) => item.relativePath === 'src/active.ts'
                )
                assert.ok(activeFileItem, 'Active file should be included in context transparency list')

                // Verify that sendProgress was called with a message containing the expected context list
                sinon.assert.called(testFeatures.lsp.sendProgress)

                // Find the progress call that contains contextList
                const progressCallWithContext = (testFeatures.lsp.sendProgress as sinon.SinonStub)
                    .getCalls()
                    .find(call => {
                        const progressData = call.args[2] // Third argument is the progress data
                        return progressData && progressData.contextList
                    })

                assert.ok(progressCallWithContext, 'Should have sent progress with contextList')
                const contextList = progressCallWithContext.args[2].contextList
                assert.deepStrictEqual(
                    contextList,
                    expectedFileList,
                    'Context list in progress update should match expected file list'
                )

                getFileListFromContextStub.restore()
            })
        })
    })
    describe('truncateRequest', () => {
        // Use dynamic input limit from TokenLimitsCalculator for all truncation tests
        const defaultLimits = TokenLimitsCalculator.calculate()
        const inputLimit = defaultLimits.inputLimit // 600_000 for default 200K tokens

        it('should truncate user input message if exceeds limit', () => {
            const request: GenerateAssistantResponseCommandInput = {
                conversationState: {
                    currentMessage: {
                        userInputMessage: {
                            content: 'a'.repeat(inputLimit + 100_000),
                            userInputMessageContext: {
                                editorState: {
                                    relevantDocuments: [
                                        {
                                            relativeFilePath: '',
                                            text: 'a'.repeat(inputLimit - 10_000),
                                        },
                                    ],
                                    document: {
                                        relativeFilePath: '',
                                        text: 'a'.repeat(inputLimit - 10_000),
                                    },
                                },
                            },
                        },
                    },
                    history: [
                        {
                            userInputMessage: {
                                content: 'a'.repeat(inputLimit - 10_000),
                            },
                        },
                    ],
                    chatTriggerType: undefined,
                },
            }
            const result = chatController.truncateRequest(request)
            assert.strictEqual(request.conversationState?.currentMessage?.userInputMessage?.content?.length, inputLimit)
            assert.strictEqual(
                request.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.editorState
                    ?.document?.text?.length || 0,
                0
            )
            assert.strictEqual(
                request.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.editorState
                    ?.relevantDocuments?.length || 0,
                0
            )
            assert.strictEqual(request.conversationState?.history?.length || 0, 1)
            assert.strictEqual(result, 0)
        })

        it('should not modify user input message if within limit', () => {
            const message = 'hello world'
            const request: GenerateAssistantResponseCommandInput = {
                conversationState: {
                    currentMessage: {
                        userInputMessage: {
                            content: message,
                        },
                    },
                    chatTriggerType: undefined,
                },
            }
            chatController.truncateRequest(request)
            assert.strictEqual(request.conversationState?.currentMessage?.userInputMessage?.content, message)
        })

        it('should truncate relevant documents if combined length exceeds remaining budget', () => {
            // Use content that leaves room for some docs but not all
            const contentLength = 510_000
            const request: GenerateAssistantResponseCommandInput = {
                conversationState: {
                    currentMessage: {
                        userInputMessage: {
                            content: 'a'.repeat(contentLength),
                            userInputMessageContext: {
                                editorState: {
                                    relevantDocuments: [
                                        {
                                            relativeFilePath: 'a',
                                            text: 'a'.repeat(100),
                                        },
                                        {
                                            relativeFilePath: 'b',
                                            text: 'a'.repeat(200),
                                        },
                                        {
                                            relativeFilePath: 'c',
                                            text: 'a'.repeat(100_000),
                                        },
                                    ],
                                    document: {
                                        relativeFilePath: '',
                                        text: 'a'.repeat(inputLimit - 10_000),
                                    },
                                },
                            },
                        },
                    },
                    history: [
                        {
                            userInputMessage: {
                                content: 'a'.repeat(inputLimit - 10_000),
                            },
                        },
                    ],
                    chatTriggerType: undefined,
                },
            }
            const result = chatController.truncateRequest(request)
            assert.strictEqual(
                request.conversationState?.currentMessage?.userInputMessage?.content?.length,
                contentLength
            )
            assert.strictEqual(
                request.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.editorState
                    ?.document?.text?.length || 0,
                0
            )
            assert.strictEqual(
                request.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.editorState
                    ?.relevantDocuments?.length || 0,
                2
            )
            assert.strictEqual(request.conversationState?.history?.length || 0, 1)
            // Remaining budget = inputLimit - contentLength - 100 - 200 = 600_000 - 510_000 - 300 = 89_700
            assert.strictEqual(result, inputLimit - contentLength - 100 - 200)
        })
        it('should truncate current editor if combined length exceeds remaining budget', () => {
            const request: GenerateAssistantResponseCommandInput = {
                conversationState: {
                    currentMessage: {
                        userInputMessage: {
                            content: 'a'.repeat(510_000),
                            userInputMessageContext: {
                                editorState: {
                                    relevantDocuments: [
                                        {
                                            relativeFilePath: '',
                                            text: 'a'.repeat(1000),
                                        },
                                        {
                                            relativeFilePath: '',
                                            text: 'a'.repeat(1000),
                                        },
                                    ],
                                    document: {
                                        relativeFilePath: '',
                                        text: 'a'.repeat(100_000),
                                    },
                                },
                            },
                        },
                    },
                    history: [
                        {
                            userInputMessage: {
                                content: 'a'.repeat(100),
                            },
                        },
                        {
                            userInputMessage: {
                                content: 'a'.repeat(100),
                            },
                        },
                        {
                            userInputMessage: {
                                content: 'a'.repeat(100_000),
                            },
                        },
                    ],
                    chatTriggerType: undefined,
                },
            }
            chatController.truncateRequest(request)
            assert.strictEqual(request.conversationState?.currentMessage?.userInputMessage?.content?.length, 510_000)
            assert.strictEqual(
                request.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.editorState
                    ?.document?.text?.length || 0,
                0
            )
            assert.strictEqual(
                request.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.editorState
                    ?.relevantDocuments?.length || 0,
                2
            )
            assert.strictEqual(request.conversationState?.history?.length || 0, 3)
        })
        it('should return remaining budget for history', () => {
            const contentLength = 100_000
            const docLength = 100_000
            const relevantDoc1Length = 1000
            const relevantDoc2Length = 1000
            const request: GenerateAssistantResponseCommandInput = {
                conversationState: {
                    currentMessage: {
                        userInputMessage: {
                            content: 'a'.repeat(contentLength),
                            userInputMessageContext: {
                                editorState: {
                                    relevantDocuments: [
                                        {
                                            relativeFilePath: '',
                                            text: 'a'.repeat(relevantDoc1Length),
                                        },
                                        {
                                            relativeFilePath: '',
                                            text: 'a'.repeat(relevantDoc2Length),
                                        },
                                    ],
                                    document: {
                                        relativeFilePath: '',
                                        text: 'a'.repeat(docLength),
                                    },
                                },
                            },
                        },
                    },
                    history: [
                        {
                            userInputMessage: {
                                content: 'a'.repeat(100),
                            },
                        },
                        {
                            userInputMessage: {
                                content: 'a'.repeat(100),
                            },
                        },
                        {
                            userInputMessage: {
                                content: 'a'.repeat(100_000),
                            },
                        },
                    ],
                    chatTriggerType: undefined,
                },
            }
            const result = chatController.truncateRequest(request)
            assert.strictEqual(
                request.conversationState?.currentMessage?.userInputMessage?.content?.length,
                contentLength
            )
            assert.strictEqual(
                request.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.editorState
                    ?.document?.text?.length || 0,
                docLength
            )
            assert.strictEqual(
                request.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.editorState
                    ?.relevantDocuments?.length || 2,
                2
            )
            assert.strictEqual(request.conversationState?.history?.length || 0, 3)
            // Remaining budget = inputLimit - contentLength - relevantDoc1Length - relevantDoc2Length - docLength
            // = 600_000 - 100_000 - 1000 - 1000 - 100_000 = 398_000
            assert.strictEqual(result, inputLimit - contentLength - relevantDoc1Length - relevantDoc2Length - docLength)
        })

        it('should truncate images when they exceed budget', () => {
            // Content that leaves small room for images
            const contentLength = inputLimit - 6_600 // Leave room for small images but not large one
            const smallImageChars = 3.3 // 1000 bytes * 3.3 / 1000
            const request: GenerateAssistantResponseCommandInput = {
                conversationState: {
                    currentMessage: {
                        userInputMessage: {
                            content: 'a'.repeat(contentLength),
                            images: [
                                {
                                    format: 'png',
                                    source: {
                                        bytes: new Uint8Array(1000), // 3.3 chars
                                    },
                                },
                                {
                                    format: 'png',
                                    source: {
                                        bytes: new Uint8Array(2000000), //6600 chars - should be removed
                                    },
                                },
                                {
                                    format: 'png',
                                    source: {
                                        bytes: new Uint8Array(1000), // 3.3 chars
                                    },
                                },
                            ],
                        },
                    },
                    chatTriggerType: undefined,
                },
            }
            const result = chatController.truncateRequest(request)

            // Should only keep the first and third images (small ones)
            assert.strictEqual(request.conversationState?.currentMessage?.userInputMessage?.images?.length, 2)
            assert.strictEqual(result, inputLimit - contentLength - smallImageChars - smallImageChars) // remaining budget after content and images
        })

        it('should handle images without bytes', () => {
            const contentLength = 400_000
            const smallImageChars = 3.3 // 1000 bytes * 3.3 / 1000
            const request: GenerateAssistantResponseCommandInput = {
                conversationState: {
                    currentMessage: {
                        userInputMessage: {
                            content: 'a'.repeat(contentLength),
                            images: [
                                {
                                    format: 'png',
                                    source: {
                                        bytes: null as any,
                                    },
                                },
                                {
                                    format: 'png',
                                    source: {
                                        bytes: new Uint8Array(1000), // 3.3 chars
                                    },
                                },
                            ],
                        },
                    },
                    chatTriggerType: undefined,
                },
            }
            const result = chatController.truncateRequest(request)

            // Should keep both images since the first one has 0 chars
            assert.strictEqual(request.conversationState?.currentMessage?.userInputMessage?.images?.length, 2)
            assert.strictEqual(result, inputLimit - contentLength - smallImageChars) // remaining budget after content and second image
        })

        it('should truncate relevantDocuments and images together with equal priority', () => {
            // 510_000 for content, 100 for doc, 3.3 for image, 100_000 for doc (should be truncated)
            const request: GenerateAssistantResponseCommandInput = {
                conversationState: {
                    currentMessage: {
                        userInputMessage: {
                            content: 'a'.repeat(510_000),
                            userInputMessageContext: {
                                editorState: {
                                    relevantDocuments: [
                                        { relativeFilePath: 'a', text: 'a'.repeat(100) },
                                        { relativeFilePath: 'b', text: 'a'.repeat(100_000) }, // should be truncated
                                    ],
                                },
                            },
                            images: [
                                {
                                    format: 'png',
                                    source: { bytes: new Uint8Array(1000000000) }, // 3300000 chars
                                },
                                {
                                    format: 'png',
                                    source: { bytes: new Uint8Array(1000) }, // 3.3 chars
                                },
                            ],
                        },
                    },
                    chatTriggerType: undefined,
                },
            }
            const result = chatController.truncateRequest(request)
            // Only the first doc and the image should fit
            assert.strictEqual(
                request.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.editorState
                    ?.relevantDocuments?.length,
                1
            )
            assert.strictEqual(request.conversationState?.currentMessage?.userInputMessage?.images?.length, 1)
            assert.strictEqual(result, inputLimit - 510_000 - 100 - 3.3)
        })

        it('should respect additionalContext order for mixed file and image truncation', () => {
            const request: GenerateAssistantResponseCommandInput = {
                conversationState: {
                    currentMessage: {
                        userInputMessage: {
                            content: 'a'.repeat(500_000),
                            userInputMessageContext: {
                                editorState: {
                                    relevantDocuments: [
                                        { relativeFilePath: 'file1.ts', text: 'a'.repeat(30_000) },
                                        { relativeFilePath: 'file2.ts', text: 'b'.repeat(40_000) },
                                        { relativeFilePath: 'file3.ts', text: 'c'.repeat(50_000) },
                                    ],
                                },
                            },
                            images: [
                                {
                                    format: 'png',
                                    source: { bytes: new Uint8Array(10_000_000) }, // 33k chars
                                },
                                {
                                    format: 'png',
                                    source: { bytes: new Uint8Array(20_000_000) }, // 66k chars
                                },
                                {
                                    format: 'png',
                                    source: { bytes: new Uint8Array(5_000_000) }, // 16.5k chars
                                },
                            ],
                        },
                    },
                    chatTriggerType: undefined,
                },
            }

            const additionalContext = [
                {
                    type: 'image',
                    name: 'image1.png',
                    description: 'First image',
                    relativePath: 'images/image1.png',
                    path: '/workspace/images/image1.png',
                    startLine: -1,
                    endLine: -1,
                }, // maps to images[0]: 33k chars (should be kept)
                {
                    type: 'file',
                    name: 'file1.ts',
                    description: 'First file',
                    relativePath: 'src/file1.ts',
                    path: '/workspace/src/file1.ts',
                    startLine: 1,
                    endLine: 100,
                }, // maps to docs[0]: 30k chars (should be kept)
                {
                    type: 'image',
                    name: 'image2.png',
                    description: 'Second image',
                    relativePath: 'images/image2.png',
                    path: '/workspace/images/image2.png',
                    startLine: -1,
                    endLine: -1,
                }, // maps to images[1]: 66k chars (should be truncated)
                {
                    type: 'file',
                    name: 'file2.ts',
                    description: 'Second file',
                    relativePath: 'src/file2.ts',
                    path: '/workspace/src/file2.ts',
                    startLine: 1,
                    endLine: 200,
                }, // maps to docs[1]: 40k chars (should be truncated)
                {
                    type: 'file',
                    name: 'file3.ts',
                    description: 'Third file',
                    relativePath: 'src/file3.ts',
                    path: '/workspace/src/file3.ts',
                    startLine: 1,
                    endLine: 300,
                }, // maps to docs[2]: 50k chars (should be truncated)
                {
                    type: 'image',
                    name: 'image3.png',
                    description: 'Third image',
                    relativePath: 'images/image3.png',
                    path: '/workspace/images/image3.png',
                    startLine: -1,
                    endLine: -1,
                }, // maps to images[2]: 16.5k chars (should be kept)
            ]

            const result = chatController.truncateRequest(request, additionalContext)

            // With 100k budget remaining after user message:
            // 1. images[0] (33k) fits -> 67k remaining
            // 2. docs[0] (30k) fits -> 37k remaining
            // 3. images[1] (66k) doesn't fit -> skipped
            // 4. docs[1] (40k) doesn't fit -> skipped
            // 5. docs[2] (50k) doesn't fit -> skipped
            // 6. images[2] (16.5k) fits in 37k remaining -> 20.5k remaining

            // Should keep first image, first doc, and third image based on additionalContext order
            assert.strictEqual(request.conversationState?.currentMessage?.userInputMessage?.images?.length, 2)
            assert.strictEqual(
                request.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.editorState
                    ?.relevantDocuments?.length,
                1
            )

            const keptImages = request.conversationState?.currentMessage?.userInputMessage?.images
            const keptDoc =
                request.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.editorState
                    ?.relevantDocuments?.[0]

            assert.strictEqual(keptImages?.[0]?.source?.bytes?.length, 10_000_000) // images[0]
            assert.strictEqual(keptImages?.[1]?.source?.bytes?.length, 5_000_000) // images[2]
            assert.strictEqual(keptDoc?.relativeFilePath, 'file1.ts') // docs[0]
            assert.strictEqual(keptDoc?.text, 'a'.repeat(30_000))

            // Remaining budget = inputLimit - 500000 - 33000 - 30000 - 16500
            assert.strictEqual(result, inputLimit - 500_000 - 33000 - 30000 - 16500)
        })
    })

    describe('onCreatePrompt', () => {
        it('should create prompt file with given name', async () => {
            const promptName = 'testPrompt'
            const expectedPath = path.join(getUserPromptsDirectory(), `testPrompt${promptFileExtension}`)

            await chatController.onCreatePrompt({ promptName })

            sinon.assert.calledOnceWithExactly(fsWriteFileStub, expectedPath, '', { mode: 0o600 })
        })

        it('should create default prompt file when no name provided', async () => {
            const expectedPath = path.join(getUserPromptsDirectory(), `default${promptFileExtension}`)

            await chatController.onCreatePrompt({ promptName: '' })

            sinon.assert.calledOnceWithExactly(fsWriteFileStub, expectedPath, '', { mode: 0o600 })
        })
    })

    describe('onInlineChatPrompt', () => {
        describe('GovCloud region block', () => {
            it('short-circuits with an unsupported-region response when client region is us-gov-east-1', async () => {
                testFeatures.setClientParams({
                    initializationOptions: {
                        aws: {
                            region: 'us-gov-east-1',
                            awsClientCapabilities: { q: { developerProfiles: false } },
                        },
                    },
                } as any)

                const result = await chatController.onInlineChatPrompt(
                    { prompt: { prompt: 'Hello' } },
                    mockCancellationToken
                )

                assert.ok(!(result instanceof ResponseError))
                assert.ok((result as InlineChatResult).body?.includes('GovCloud'))
                assert.ok((result as InlineChatResult).body?.includes('us-gov-east-1'))
            })
        })

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

        it('returns a ResponseError if generateAssistantResponse returns an error', async () => {
            generateAssistantResponseStub.callsFake(() => {
                throw new Error('Error')
            })

            const chatResult = await chatController.onInlineChatPrompt(
                { prompt: { prompt: 'Hello' } },
                mockCancellationToken
            )

            assert.ok(chatResult instanceof ResponseError)
        })

        it('returns a Response error if generateAssistantResponse returns an auth error', async () => {
            generateAssistantResponseStub.callsFake(() => {
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
            generateAssistantResponseStub.callsFake(() => {
                return Promise.resolve({
                    $metadata: {
                        requestId: mockMessageId,
                    },
                    generateAssistantResponseResponse: createIterableResponse([
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
            generateAssistantResponseStub.callsFake(() => {
                return Promise.resolve({
                    $metadata: {
                        requestId: mockMessageId,
                    },
                    generateAssistantResponseResponse: createIterableResponse([
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

            it('leaves cursorState as undefined if cursorState is not passed', async () => {
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

                const calledRequestInput: GenerateAssistantResponseCommandInput =
                    generateAssistantResponseStub.firstCall.firstArg

                assert.strictEqual(
                    calledRequestInput.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
                        ?.editorState?.cursorState,
                    undefined
                )
            })

            it('leaves document as undefined if relative file path is undefined', async () => {
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

                const calledRequestInput: GenerateAssistantResponseCommandInput =
                    generateAssistantResponseStub.firstCall.firstArg

                assert.strictEqual(
                    calledRequestInput.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
                        ?.editorState?.document,
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

                const calledRequestInput: GenerateAssistantResponseCommandInput =
                    generateAssistantResponseStub.firstCall.firstArg

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
                        workspaceFolders: [],
                        relevantDocuments: undefined,
                        useRelevantDocuments: false,
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

    it('calls TabBarControlled when tabBarAction request is received', async () => {
        const tabBarActionStub = sinon.stub(TabBarController.prototype, 'onTabBarAction')

        await chatController.onTabBarAction({ tabId: mockTabId, action: 'export' })

        sinon.assert.calledOnce(tabBarActionStub)
    })

    it('determines when an error is a user action', function () {
        const nonUserAction = new Error('User action error')
        const cancellationError = new CancellationError('user')
        const rejectionError = new ToolApprovalException()
        const tokenSource = new CancellationTokenSource()
        const requestAbortedError = new AgenticChatError('Request aborted', 'RequestAborted')

        assert.ok(!chatController.isUserAction(nonUserAction))
        assert.ok(chatController.isUserAction(cancellationError))
        assert.ok(chatController.isUserAction(rejectionError))
        assert.ok(chatController.isUserAction(requestAbortedError))

        assert.ok(!chatController.isUserAction(nonUserAction, tokenSource.token))

        tokenSource.cancel()

        assert.ok(chatController.isUserAction(nonUserAction, tokenSource.token))
    })

    describe('Undo All Behavior', () => {
        let session: ChatSessionService
        let chatResultStream: AgenticChatResultStream
        let writeResultBlockStub: sinon.SinonStub
        let onButtonClickStub: sinon.SinonStub

        beforeEach(() => {
            // Create a session
            chatController.onTabAdd({ tabId: mockTabId })
            session = chatSessionManagementService.getSession(mockTabId).data!

            // Mock the chat result stream
            writeResultBlockStub = sinon.stub().resolves(1)
            chatResultStream = {
                writeResultBlock: writeResultBlockStub,
                getResult: sinon.stub().returns({ type: 'answer', body: '', messageId: 'test-message' }),
                overwriteResultBlock: sinon.stub().resolves(),
            } as unknown as AgenticChatResultStream

            // Mock onButtonClick for undo all tests
            onButtonClickStub = sinon.stub(chatController, 'onButtonClick').resolves({ success: true })
        })

        afterEach(() => {
            onButtonClickStub.restore()
        })

        describe('fsWrite tool sequence tracking', () => {
            it('should track fsWrite tools and reset tracking on non-fsWrite tools', async () => {
                // Set initial state
                session.currentUndoAllId = undefined
                session.toolUseLookup = new Map()

                // Process fsRead tool - should not affect undo state
                const fsReadToolUse = {
                    name: 'fsRead',
                    toolUseId: 'read-tool-id',
                    input: { path: '/test/file.txt' },
                }

                // Simulate processing a tool use by directly setting session state
                // This is an indirect way to test the updateUndoAllState behavior
                session.toolUseLookup.set(fsReadToolUse.toolUseId, fsReadToolUse)

                // Verify state wasn't changed for read-only tool
                assert.strictEqual(session.currentUndoAllId, undefined)

                // Process first fsWrite tool
                const firstWriteToolUse = {
                    name: 'fsWrite',
                    toolUseId: 'write-tool-id-1',
                    input: { path: '/test/file1.txt', command: 'create' },
                    relatedToolUses: new Set<string>(),
                }

                // Simulate the first fsWrite tool being processed
                session.currentUndoAllId = firstWriteToolUse.toolUseId
                session.toolUseLookup.set(firstWriteToolUse.toolUseId, firstWriteToolUse)

                // Verify state was updated for first fsWrite tool
                assert.strictEqual(session.currentUndoAllId, 'write-tool-id-1')

                // Process second fsWrite tool
                const secondWriteToolUse = {
                    name: 'fsWrite',
                    toolUseId: 'write-tool-id-2',
                    input: { path: '/test/file2.txt', command: 'create' },
                }

                // Simulate the second fsWrite tool being processed and added to related tools
                session.toolUseLookup.set(secondWriteToolUse.toolUseId, secondWriteToolUse)
                const firstToolUseData = session.toolUseLookup.get('write-tool-id-1')
                if (firstToolUseData && firstToolUseData.relatedToolUses) {
                    firstToolUseData.relatedToolUses.add('write-tool-id-2')
                }

                // Verify the related tool uses set was updated
                assert.ok(firstToolUseData?.relatedToolUses?.has('write-tool-id-2'))

                // Process executeBash tool - should reset undo state
                const bashToolUse = {
                    name: 'executeBash',
                    toolUseId: 'bash-tool-id',
                    input: { command: 'echo "test"', cwd: '/test' },
                }

                // Simulate the executeBash tool being processed
                session.currentUndoAllId = undefined
                session.toolUseLookup.set(bashToolUse.toolUseId, bashToolUse)

                // Verify state was reset for non-fsWrite tool
                assert.strictEqual(session.currentUndoAllId, undefined)
            })
        })

        describe('Undo all button display', () => {
            it('should show undo all button when there are multiple related tool uses', async () => {
                // Set up the state that would trigger showing the undo all button
                const toolUseId = 'write-tool-id-1'
                session.currentUndoAllId = toolUseId
                session.toolUseLookup = new Map()
                session.toolUseLookup.set(toolUseId, {
                    relatedToolUses: new Set([toolUseId, 'write-tool-id-2']),
                } as any)

                // Directly call writeResultBlock with the expected parameters
                await chatResultStream.writeResultBlock({
                    type: 'answer',
                    messageId: `${toolUseId}_undoall`,
                    buttons: [
                        {
                            id: 'undo-all-changes',
                            text: 'Undo all changes',
                            icon: 'undo',
                            status: 'clear',
                            keepCardAfterClick: false,
                        },
                    ],
                })

                // Reset the currentUndoAllId as the real method would
                session.currentUndoAllId = undefined

                // Verify button was shown with correct properties
                sinon.assert.calledOnce(writeResultBlockStub)
                const buttonBlock = writeResultBlockStub.firstCall.args[0]
                assert.strictEqual(buttonBlock.type, 'answer')
                assert.strictEqual(buttonBlock.messageId, `${toolUseId}_undoall`)
                assert.strictEqual(buttonBlock.buttons.length, 1)
                assert.strictEqual(buttonBlock.buttons[0].id, 'undo-all-changes')
                assert.strictEqual(buttonBlock.buttons[0].text, 'Undo all changes')
                assert.strictEqual(buttonBlock.buttons[0].icon, 'undo')

                // Verify currentUndoAllId was reset
                assert.strictEqual(session.currentUndoAllId, undefined)
            })
        })

        describe('Undo all file changes', () => {
            it('should handle undo all changes button click', async () => {
                // Set up tool uses
                const toolUseId = 'write-tool-id-1'
                const relatedToolUses = new Set(['write-tool-id-1', 'write-tool-id-2', 'write-tool-id-3'])

                // Set initial state
                session.toolUseLookup = new Map()
                session.toolUseLookup.set(toolUseId, {
                    relatedToolUses,
                } as any)

                // Simulate clicking the "Undo all changes" button
                await chatController.onButtonClick({
                    buttonId: 'undo-all-changes',
                    messageId: `${toolUseId}_undoall`,
                    tabId: mockTabId,
                })

                // Verify onButtonClick was called
                assert.ok(onButtonClickStub.called)
            })
        })

        describe('Integration tests', () => {
            it('should handle the complete undo all workflow', async () => {
                // This test simulates the entire workflow:
                // 1. Multiple fsWrite operations occur
                // 2. Undo all button is shown
                // 3. User clicks undo all button

                // Set up initial state
                const firstToolUseId = 'write-tool-id-1'
                const secondToolUseId = 'write-tool-id-2'

                // Simulate first fsWrite
                session.currentUndoAllId = firstToolUseId
                session.toolUseLookup = new Map()
                session.toolUseLookup.set(firstToolUseId, {
                    name: 'fsWrite',
                    toolUseId: firstToolUseId,
                    input: { path: '/test/file1.txt', command: 'create' },
                    relatedToolUses: new Set([firstToolUseId]),
                })

                // Simulate second fsWrite and update related tools
                session.toolUseLookup.set(secondToolUseId, {
                    name: 'fsWrite',
                    toolUseId: secondToolUseId,
                    input: { path: '/test/file2.txt', command: 'create' },
                })

                const firstToolUseData = session.toolUseLookup.get(firstToolUseId)
                if (firstToolUseData && firstToolUseData.relatedToolUses) {
                    firstToolUseData.relatedToolUses.add(secondToolUseId)
                }

                // Verify the related tool uses set was updated
                assert.ok(firstToolUseData?.relatedToolUses?.has(secondToolUseId))

                // Simulate showing the undo all button
                await chatResultStream.writeResultBlock({
                    type: 'answer',
                    messageId: `${firstToolUseId}_undoall`,
                    buttons: [
                        {
                            id: 'undo-all-changes',
                            text: 'Undo all changes',
                            icon: 'undo',
                            status: 'clear',
                            keepCardAfterClick: false,
                        },
                    ],
                })

                // Reset onButtonClickStub to track new calls
                onButtonClickStub.resetHistory()

                // Simulate clicking the undo all button
                await chatController.onButtonClick({
                    buttonId: 'undo-all-changes',
                    messageId: `${firstToolUseId}_undoall`,
                    tabId: mockTabId,
                })

                // Verify onButtonClick was called
                assert.ok(onButtonClickStub.called)
            })
        })
    })

    describe('onPromptInputOptionChange', () => {
        it('should set model ID from prompt input options', () => {
            const mockTabId = 'tab-1'
            const modelId = 'CLAUDE_3_7_SONNET_20250219_V1_0'
            const setTabModelIdStub = sinon.stub(ChatDatabase.prototype, 'setTabModelId')

            // Create a session
            chatController.onTabAdd({ tabId: mockTabId })

            // Call onPromptInputOptionChange with model selection
            chatController.onPromptInputOptionChange({
                tabId: mockTabId,
                optionsValues: { 'model-selection': modelId },
            })

            // Verify the session has the model ID set
            const session = chatSessionManagementService.getSession(mockTabId).data
            assert.strictEqual(session!.modelId, modelId)

            // Verify the model ID was saved to the database
            sinon.assert.called(setTabModelIdStub)

            setTabModelIdStub.restore()
        })

        it('should recalculate token limits when model changes', () => {
            const mockTabId = 'tab-1'
            const initialModelId = 'model-1'
            const newModelId = 'model-2'
            const setTabModelIdStub = sinon.stub(ChatDatabase.prototype, 'setTabModelId')

            // Mock getCachedModels to return models with different token limits
            const cachedModels: Model[] = [
                {
                    id: 'model-1',
                    name: 'Model 1',
                    description: 'Test',
                    tokenLimits: { maxInputTokens: 200000 },
                },
                {
                    id: 'model-2',
                    name: 'Model 2',
                    description: 'Test',
                    tokenLimits: { maxInputTokens: 300000 },
                },
            ]
            const getCachedModelsStub = sinon.stub(ChatDatabase.prototype, 'getCachedModels').returns({
                models: cachedModels,
                defaultModelId: 'model-1',
                timestamp: Date.now(),
            })

            // Create a session and set initial model
            chatController.onTabAdd({ tabId: mockTabId })
            const session = chatSessionManagementService.getSession(mockTabId).data!
            session.setModel(initialModelId, cachedModels)

            // Get initial token limits (default 200K)
            const initialLimits = session.tokenLimits
            assert.strictEqual(initialLimits.maxInputTokens, 200000)

            // Switch to a model with different token limits
            chatController.onPromptInputOptionChange({
                tabId: mockTabId,
                optionsValues: { 'model-selection': newModelId },
            })

            // Verify token limits were recalculated based on new model's maxInputTokens (300K)
            const newLimits = session.tokenLimits
            assert.strictEqual(newLimits.maxInputTokens, 300000)
            assert.strictEqual(newLimits.maxOverallCharacters, Math.floor(300000 * 3.5))
            assert.strictEqual(newLimits.inputLimit, newLimits.maxOverallCharacters - 100_000)
            assert.strictEqual(newLimits.compactionThreshold, Math.floor(0.7 * newLimits.maxOverallCharacters))

            setTabModelIdStub.restore()
            getCachedModelsStub.restore()
        })
    })

    describe('onListAvailableModels', () => {
        let isCachedModelsValidStub: sinon.SinonStub
        let getCachedModelsStub: sinon.SinonStub
        let setCachedModelsStub: sinon.SinonStub
        let getConnectionTypeStub: sinon.SinonStub
        let getActiveProfileArnStub: sinon.SinonStub
        let getCodewhispererServiceStub: sinon.SinonStub
        let listAvailableModelsStub: sinon.SinonStub

        beforeEach(() => {
            // Create a session
            chatController.onTabAdd({ tabId: mockTabId })

            // Stub ChatDatabase methods
            isCachedModelsValidStub = sinon.stub(ChatDatabase.prototype, 'isCachedModelsValid')
            getCachedModelsStub = sinon.stub(ChatDatabase.prototype, 'getCachedModels')
            setCachedModelsStub = sinon.stub(ChatDatabase.prototype, 'setCachedModels')

            // Stub AmazonQTokenServiceManager methods
            getConnectionTypeStub = sinon.stub(AmazonQTokenServiceManager.prototype, 'getConnectionType')
            getActiveProfileArnStub = sinon.stub(AmazonQTokenServiceManager.prototype, 'getActiveProfileArn')
            getCodewhispererServiceStub = sinon.stub(AmazonQTokenServiceManager.prototype, 'getCodewhispererService')

            // Mock listAvailableModels method
            listAvailableModelsStub = sinon.stub()
            getCodewhispererServiceStub.returns({
                listAvailableModels: listAvailableModelsStub,
            })
        })

        afterEach(() => {
            isCachedModelsValidStub.restore()
            getCachedModelsStub.restore()
            setCachedModelsStub.restore()
            getConnectionTypeStub.restore()
            getActiveProfileArnStub.restore()
            getCodewhispererServiceStub.restore()
        })

        describe('ListAvailableModels Cache scenarios', () => {
            it('should return cached models when cache is valid', async () => {
                // Setup valid cache
                isCachedModelsValidStub.returns(true)
                const cachedData = {
                    models: [
                        { id: 'model1', name: 'Model 1', description: 'Test description 1' },
                        { id: 'model2', name: 'Model 2', description: 'Test description 2' },
                    ],
                    defaultModelId: 'model1',
                    timestamp: Date.now(),
                }
                getCachedModelsStub.returns(cachedData)

                const session = chatSessionManagementService.getSession(mockTabId).data!
                session.setModel('model1', cachedData.models)

                const result = await chatController.onListAvailableModels({ tabId: mockTabId })

                // Verify cached data is used
                assert.strictEqual(result.tabId, mockTabId)
                assert.deepStrictEqual(result.models, cachedData.models)
                assert.strictEqual(result.selectedModelId, 'model1')

                // Verify API was not called
                sinon.assert.notCalled(listAvailableModelsStub)
                sinon.assert.notCalled(setCachedModelsStub)
            })

            it('should return cached models when cache is valid but has empty models array', async () => {
                // Setup cache with empty models
                isCachedModelsValidStub.returns(true)
                const cachedData = {
                    models: [],
                    defaultModelId: undefined,
                    timestamp: Date.now(),
                }
                getCachedModelsStub.returns(cachedData)

                // Should fall back to API call since models array is empty
                getConnectionTypeStub.returns('builderId')
                getActiveProfileArnStub.returns('test-arn')
                listAvailableModelsStub.resolves({
                    models: {
                        model1: { modelId: 'model1' },
                        model2: { modelId: 'model2' },
                    },
                    defaultModel: { modelId: 'model1' },
                })

                await chatController.onListAvailableModels({ tabId: mockTabId })

                // Verify API was called due to empty cached models
                sinon.assert.calledOnce(listAvailableModelsStub)
                sinon.assert.calledOnce(setCachedModelsStub)
            })

            it('should return cached models when cache is valid but cachedData is null', async () => {
                // Setup cache as valid but returns null
                isCachedModelsValidStub.returns(true)
                getCachedModelsStub.returns(null)

                // Should fall back to API call
                getConnectionTypeStub.returns('builderId')
                getActiveProfileArnStub.returns('test-arn')
                listAvailableModelsStub.resolves({
                    models: {
                        model1: { modelId: 'model1' },
                    },
                    defaultModel: { modelId: 'model1' },
                })

                await chatController.onListAvailableModels({ tabId: mockTabId })

                // Verify API was called
                sinon.assert.calledOnce(listAvailableModelsStub)
            })
        })

        describe('ListAvailableModels API call scenarios', () => {
            beforeEach(() => {
                // Setup invalid cache to force API call
                isCachedModelsValidStub.returns(false)
            })

            it('should fetch models from API when cache is invalid', async () => {
                getConnectionTypeStub.returns('builderId')
                getActiveProfileArnStub.returns('test-profile-arn')

                const mockApiResponse = {
                    models: {
                        'claude-3-sonnet': {
                            modelId: 'claude-3-sonnet',
                            modelName: 'Claude 3 Sonnet',
                            description: 'Advanced AI model',
                            tokenLimits: { maxInputTokens: 200000 },
                        },
                        'claude-4-sonnet': {
                            modelId: 'claude-4-sonnet',
                            modelName: 'Claude 4 Sonnet',
                            description: 'Latest AI model',
                            tokenLimits: { maxInputTokens: 300000 },
                        },
                    },
                    defaultModel: { modelId: 'claude-3-sonnet' },
                }
                listAvailableModelsStub.resolves(mockApiResponse)

                const result = await chatController.onListAvailableModels({ tabId: mockTabId })

                // Verify API call was made with correct parameters
                sinon.assert.calledOnceWithExactly(listAvailableModelsStub, {
                    origin: 'IDE',
                    profileArn: 'test-profile-arn',
                })

                // Verify result structure
                assert.strictEqual(result.tabId, mockTabId)
                assert.strictEqual(result.models.length, 2)
                assert.deepStrictEqual(result.models, [
                    {
                        id: 'claude-3-sonnet',
                        name: 'Claude 3 Sonnet',
                        description: 'Advanced AI model',
                        tokenLimits: { maxInputTokens: 200000 },
                    },
                    {
                        id: 'claude-4-sonnet',
                        name: 'Claude 4 Sonnet',
                        description: 'Latest AI model',
                        tokenLimits: { maxInputTokens: 300000 },
                    },
                ])

                // Verify cache was updated
                sinon.assert.calledOnceWithExactly(setCachedModelsStub, result.models, 'claude-3-sonnet')
            })

            it('should fall back to hardcoded models when API call fails', async () => {
                getConnectionTypeStub.returns('builderId')
                listAvailableModelsStub.rejects(new Error('API Error'))

                const result = await chatController.onListAvailableModels({ tabId: mockTabId })

                // Verify fallback to FALLBACK_MODEL_OPTIONS
                assert.strictEqual(result.tabId, mockTabId)
                assert.strictEqual(result.models.length, 1) // FALLBACK_MODEL_OPTIONS length

                // Verify cache was not updated due to error
                sinon.assert.notCalled(setCachedModelsStub)
            })

            it('should handle API response with no defaultModel', async () => {
                getConnectionTypeStub.returns('builderId')

                const mockApiResponse = {
                    models: {
                        model1: { modelId: 'model1' },
                    },
                    defaultModel: undefined, // No default model
                }
                listAvailableModelsStub.resolves(mockApiResponse)

                const result = await chatController.onListAvailableModels({ tabId: mockTabId })

                // Verify cache was updated with undefined defaultModelId
                sinon.assert.calledOnceWithExactly(setCachedModelsStub, result.models, undefined)
            })
        })

        describe('Session and model selection scenarios', () => {
            beforeEach(() => {
                // Setup cache to avoid API calls in these tests
                isCachedModelsValidStub.returns(true)
                getCachedModelsStub.returns({
                    models: [
                        { id: 'model1', name: 'Model 1' },
                        { id: 'model2', name: 'Model 2' },
                    ],
                    defaultModelId: 'model1',
                    timestamp: Date.now(),
                })
            })

            it('should return default model when session fails to load', async () => {
                const getSessionStub = sinon.stub(chatSessionManagementService, 'getSession')
                getSessionStub.returns({
                    data: undefined,
                    success: false,
                    error: 'Session not found',
                })

                const result = await chatController.onListAvailableModels({ tabId: 'invalid-tab' })

                assert.strictEqual(result.tabId, 'invalid-tab')
                assert.strictEqual(result.selectedModelId, 'model1')

                getSessionStub.restore()
            })

            it('should use defaultModelId from cache when session has no modelId', async () => {
                const session = chatSessionManagementService.getSession(mockTabId).data!
                session.setModel(undefined, undefined)

                const result = await chatController.onListAvailableModels({ tabId: mockTabId })

                assert.strictEqual(result.selectedModelId, 'model1') // defaultModelId from cache
                // Verify session modelId is updated
                assert.strictEqual(session.modelId, 'model1')
            })

            it('should fall back to default model when session has no modelId and no defaultModelId in cache', async () => {
                getCachedModelsStub.returns({
                    models: [{ id: 'model1', name: 'Model 1', description: 'Test model' }],
                    defaultModelId: undefined, // No default model
                    timestamp: Date.now(),
                })

                const session = chatSessionManagementService.getSession(mockTabId).data!
                session.setModel(undefined, undefined)

                const result = await chatController.onListAvailableModels({ tabId: mockTabId })

                assert.strictEqual(result.selectedModelId, 'claude-sonnet-4') // FALLBACK_MODEL_RECORD[DEFAULT_MODEL_ID].label
                // Verify session modelId is updated
                assert.strictEqual(session.modelId, 'claude-sonnet-4')
            })
        })
    })

    describe('IAM Authentication', () => {
        let iamServiceManager: AmazonQIAMServiceManager
        let iamChatController: AgenticChatController
        let iamChatSessionManagementService: ChatSessionManagementService

        beforeEach(() => {
            sendMessageStub = sinon.stub(QDeveloperStreaming.prototype, 'sendMessage').callsFake(() => {
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
            // Reset the singleton instance
            ChatSessionManagementService.reset()

            // Create IAM service manager
            AmazonQIAMServiceManager.resetInstance()
            iamServiceManager = AmazonQIAMServiceManager.initInstance(testFeatures)

            // Create chat session management service with IAM service manager
            iamChatSessionManagementService = ChatSessionManagementService.getInstance()
            iamChatSessionManagementService.withAmazonQServiceManager(iamServiceManager)
            // Create controller with IAM service manager
            iamChatController = new AgenticChatController(
                iamChatSessionManagementService,
                testFeatures,
                telemetryService,
                iamServiceManager
            )
        })

        afterEach(() => {
            iamChatController.dispose()
            ChatSessionManagementService.reset()
            AmazonQIAMServiceManager.resetInstance()
        })

        it('creates a session with IAM service manager', () => {
            iamChatController.onTabAdd({ tabId: mockTabId })

            const sessionResult = iamChatSessionManagementService.getSession(mockTabId)
            sinon.assert.match(sessionResult, {
                success: true,
                data: sinon.match.instanceOf(ChatSessionService),
            })
        })

        it('uses sendMessage instead of generateAssistantResponse with IAM service manager', async () => {
            // Create a session
            iamChatController.onTabAdd({ tabId: mockTabId })

            // Reset the sendMessage stub to track new calls
            sendMessageStub.resetHistory()
            generateAssistantResponseStub.resetHistory()

            // Make a chat request
            await iamChatController.onChatPrompt(
                { tabId: mockTabId, prompt: { prompt: 'Hello' } },
                mockCancellationToken
            )

            // Verify sendMessage was called and generateAssistantResponse was not
            sinon.assert.called(sendMessageStub)
            sinon.assert.notCalled(generateAssistantResponseStub)
        })

        it('sets source to Origin.IDE when using IAM service manager', async () => {
            // Create a session
            iamChatController.onTabAdd({ tabId: mockTabId })

            // Reset the sendMessage stub to track new calls
            sendMessageStub.resetHistory()

            // Make a chat request
            await iamChatController.onChatPrompt(
                { tabId: mockTabId, prompt: { prompt: 'Hello' } },
                mockCancellationToken
            )

            // Verify sendMessage was called with source set to IDE
            sinon.assert.called(sendMessageStub)
            const request = sendMessageStub.firstCall.args[0]
            assert.strictEqual(request.source, 'IDE')
        })

        it('sets source to origin from client info when using IAM service manager', async () => {
            // Stub getOriginFromClientInfo to return a specific value
            const getOriginFromClientInfoStub = sinon
                .stub(sharedUtils, 'getOriginFromClientInfo')
                .returns('MD_IDE' as any)
            // Create a session
            iamChatController.onTabAdd({ tabId: mockTabId })

            // Reset the sendMessage stub to track new calls
            sendMessageStub.resetHistory()

            // Make a chat request
            await iamChatController.onChatPrompt(
                { tabId: mockTabId, prompt: { prompt: 'Hello' } },
                mockCancellationToken
            )
            // Verify getOriginFromClientInfo was called
            sinon.assert.calledOnce(getOriginFromClientInfoStub)
            // Verify sendMessage was called with source set to IDE
            sinon.assert.called(sendMessageStub)
            const request = sendMessageStub.firstCall.args[0]
            assert.strictEqual(request.source, 'MD_IDE')
            // Restore the stub
            getOriginFromClientInfoStub.restore()
        })

        it('does not call onManageSubscription with IAM service manager', async () => {
            // Create a spy on onManageSubscription
            const onManageSubscriptionSpy = sinon.spy(iamChatController, 'onManageSubscription')

            // Call onManageSubscription directly
            await iamChatController.onManageSubscription('tabId')

            // Verify the method returns early without doing anything
            sinon.assert.calledOnce(onManageSubscriptionSpy)
            const returnValue = await onManageSubscriptionSpy.returnValues[0]
            assert.strictEqual(returnValue, undefined)
        })
    })

    describe('processToolUses', () => {
        it('filters rule artifacts from additionalContext for CodeReview tool', async () => {
            const mockAdditionalContext = [
                {
                    type: 'file',
                    description: '',
                    name: '',
                    relativePath: '',
                    startLine: 0,
                    endLine: 0,
                    path: '/test/file.js',
                },
                {
                    type: 'rule',
                    description: '',
                    name: '',
                    relativePath: '',
                    startLine: 0,
                    endLine: 0,
                    path: '/test/rule1.json',
                },
                {
                    type: 'rule',
                    description: '',
                    name: '',
                    relativePath: '',
                    startLine: 0,
                    endLine: 0,
                    path: '/test/rule2.json',
                },
            ]

            const toolUse = {
                toolUseId: 'test-id',
                name: 'codeReview',
                input: { fileLevelArtifacts: [{ path: '/test/file.js' }] },
                stop: true,
            }

            const runToolStub = testFeatures.agent.runTool as sinon.SinonStub
            runToolStub.resolves({})

            // Create a mock session with toolUseLookup
            const mockSession = {
                toolUseLookup: new Map(),
                pairProgrammingMode: true,
            } as any

            // Create a minimal mock of AgenticChatResultStream
            const mockChatResultStream = {
                removeResultBlockAndUpdateUI: sinon.stub().resolves(),
                writeResultBlock: sinon.stub().resolves(1),
                overwriteResultBlock: sinon.stub().resolves(),
                removeResultBlock: sinon.stub().resolves(),
                getMessageBlockId: sinon.stub().returns(undefined),
                hasMessage: sinon.stub().returns(false),
                updateOngoingProgressResult: sinon.stub().resolves(),
                getResult: sinon.stub().returns({ messageId: 'test', body: '' }),
                setMessageIdToUpdateForTool: sinon.stub(),
                getMessageIdToUpdateForTool: sinon.stub().returns(undefined),
                addMessageOperation: sinon.stub(),
                getMessageOperation: sinon.stub().returns(undefined),
            }

            // Call processToolUses directly
            await chatController.processToolUses(
                [toolUse],
                mockChatResultStream as any,
                mockSession,
                'tabId',
                mockCancellationToken,
                mockAdditionalContext
            )

            // Verify runTool was called with ruleArtifacts
            sinon.assert.calledOnce(runToolStub)
            const toolInput = runToolStub.firstCall.args[1]
            assert.ok(toolInput.ruleArtifacts)
            assert.strictEqual(toolInput.ruleArtifacts.length, 2)
            assert.strictEqual(toolInput.ruleArtifacts[0].path, '/test/rule1.json')
            assert.strictEqual(toolInput.ruleArtifacts[1].path, '/test/rule2.json')
        })
    })

    describe('processToolUses with an MCP tool named after a built-in tool', () => {
        // An MCP server advertises a tool called `fsRead`. Registration namespaces it
        // to `probe___fsRead`, but the controller still receives the server's
        // original name (`fsRead`) alongside the registered one for display. These
        // tests pin that the original name never selects built-in behavior.
        const SERVER = 'probe'
        const REGISTERED = `${SERVER}___fsRead`
        const ORIGINAL = 'fsRead'

        function mcpStub(overrides: Record<string, any> = {}) {
            return {
                getAllTools: () => [{ serverName: SERVER, toolName: ORIGINAL, description: 'probe', inputSchema: {} }],
                getOriginalToolNames: (name: string) =>
                    name === REGISTERED ? { serverName: SERVER, toolName: ORIGINAL } : undefined,
                requiresApproval: () => true,
                callTool: sinon.stub().resolves({ content: [{ type: 'text', text: 'PROBE' }] }),
                clearToolNameMapping: () => {},
                setToolNameMapping: () => {},
                getToolNameMapping: () => new Map([[REGISTERED, { serverName: SERVER, toolName: ORIGINAL }]]),
                ...overrides,
            }
        }

        function makeStream() {
            return {
                removeResultBlockAndUpdateUI: sinon.stub().resolves(),
                writeResultBlock: sinon.stub().resolves(1),
                overwriteResultBlock: sinon.stub().resolves(),
                removeResultBlock: sinon.stub().resolves(),
                getMessageBlockId: sinon.stub().returns(undefined),
                hasMessage: sinon.stub().returns(false),
                updateOngoingProgressResult: sinon.stub().resolves(),
                getResult: sinon.stub().returns({ messageId: 'test', body: '' }),
                setMessageIdToUpdateForTool: sinon.stub(),
                getMessageIdToUpdateForTool: sinon.stub().returns(undefined),
                addMessageOperation: sinon.stub(),
                getMessageOperation: sinon.stub().returns(undefined),
            }
        }

        function makeSession() {
            const session: any = {
                toolUseLookup: new Map(),
                pairProgrammingMode: true,
                approvedPaths: new Set(),
                conversationId: 'conv',
                modelId: undefined,
                getConversationType: () => 'AgenticChat',
                setDeferredToolExecution: sinon.stub(),
            }
            return session
        }

        // Cards written to the stream, excluding the `explanation` directive that
        // precedes the confirmation card.
        function toolCards(stub: sinon.SinonStub) {
            return stub
                .getCalls()
                .map(c => c.args[0])
                .filter(block => block?.type === 'tool')
        }

        // The MCP tool arrives with no `paths`; a built-in fsRead card would throw on it.
        const toolUse = {
            toolUseId: 'collision-id',
            name: REGISTERED,
            input: { explanation: 'probe' },
            stop: true,
        }

        beforeEach(() => {
            ;(testFeatures.agent.getBuiltInToolNames as sinon.SinonStub).returns([
                'fsRead',
                'fsWrite',
                'fsReplace',
                'listDirectory',
                'grepSearch',
                'fileSearch',
                'executeBash',
            ])
            // processToolUses rejects any tool not present in agent.getTools(), so
            // the registered (namespaced) MCP names must be offered there.
            ;(testFeatures.agent.getTools as sinon.SinonStub).returns(
                ['fsRead', REGISTERED, `${SERVER}___executeBash`].map(name => ({
                    toolSpecification: { name, description: 'Mock tool for testing' },
                }))
            )
        })

        it('renders the MCP confirmation card, not the built-in fsRead card', async () => {
            mcpInstanceStub.get(() => mcpStub())
            const stream = makeStream()
            const session = makeSession()
            // Approve as soon as the deferred is registered so the flow continues.
            session.setDeferredToolExecution.callsFake((_id: string, resolve: () => void) => resolve())

            const results = await chatController.processToolUses(
                [toolUse],
                stream as any,
                session,
                'tabId',
                mockCancellationToken
            )

            // No ERROR result: the built-in card's path validation never ran.
            const errors = results.filter(r => r.status === ToolResultStatus.ERROR)
            assert.deepStrictEqual(errors, [], `unexpected error results: ${JSON.stringify(errors)}`)

            // The confirmation card is the MCP card: a collapsible summary showing
            // the original name with Run/Reject, not a "read-only tools" header.
            const cards = toolCards(stream.writeResultBlock)
            assert.ok(cards.length >= 1, 'a confirmation card was written')
            const confirmation = cards[0]
            assert.ok(confirmation.summary, 'MCP confirmation uses a summary block')
            assert.strictEqual(confirmation.summary.content.header.body, ORIGINAL)
            assert.strictEqual(confirmation.header, undefined, 'built-in card header must not be present')
        })

        it('does not emit the built-in path validation error for the MCP tool', async () => {
            mcpInstanceStub.get(() => mcpStub())
            const stream = makeStream()
            const session = makeSession()
            session.setDeferredToolExecution.callsFake((_id: string, resolve: () => void) => resolve())

            const results = await chatController.processToolUses(
                [toolUse],
                stream as any,
                session,
                'tabId',
                mockCancellationToken
            )

            const text = JSON.stringify(results)
            assert.ok(!text.includes('Paths array cannot be empty'), `built-in validation leaked: ${text}`)
            assert.ok(!text.includes('paths is not iterable'), `built-in handler leaked: ${text}`)
        })

        it('consults the MCP permission for the tool and prompts when it requires approval', async () => {
            const requiresApproval = sinon.stub().returns(true)
            mcpInstanceStub.get(() => mcpStub({ requiresApproval }))
            const stream = makeStream()
            const session = makeSession()
            session.setDeferredToolExecution.callsFake((_id: string, resolve: () => void) => resolve())

            await chatController.processToolUses([toolUse], stream as any, session, 'tabId', mockCancellationToken)

            // The permission lookup is keyed on the server and the original tool
            // name, and the prompt was shown because it returned true.
            sinon.assert.calledWith(requiresApproval, SERVER, ORIGINAL)
            sinon.assert.calledOnce(session.setDeferredToolExecution)
        })

        it('runs the tool under its registered name after approval', async () => {
            mcpInstanceStub.get(() => mcpStub())
            const runToolStub = testFeatures.agent.runTool as sinon.SinonStub
            runToolStub.resolves({ output: { kind: 'text', content: 'PROBE' } })
            const stream = makeStream()
            const session = makeSession()
            session.setDeferredToolExecution.callsFake((_id: string, resolve: () => void) => resolve())

            await chatController.processToolUses([toolUse], stream as any, session, 'tabId', mockCancellationToken)

            sinon.assert.calledOnce(runToolStub)
            assert.strictEqual(runToolStub.firstCall.args[0], REGISTERED)
        })

        it('renders the accepted-result card as an MCP card showing the original name', async () => {
            mcpInstanceStub.get(() => mcpStub())
            const runToolStub = testFeatures.agent.runTool as sinon.SinonStub
            runToolStub.resolves({ output: { kind: 'text', content: 'PROBE' } })
            const stream = makeStream()
            const session = makeSession()
            session.setDeferredToolExecution.callsFake((_id: string, resolve: () => void) => resolve())

            await chatController.processToolUses([toolUse], stream as any, session, 'tabId', mockCancellationToken)

            // After approval the confirmation block is overwritten with the result
            // card. For an MCP tool that is the generic summary card, not the
            // built-in "Allowed" file card and not the shell card.
            const accepted = toolCards(stream.overwriteResultBlock)[0]
            assert.ok(accepted, 'an accepted-result card was written')
            assert.ok(accepted.summary, 'accepted MCP card uses a summary block')
            assert.strictEqual(accepted.summary.content.header.body, ORIGINAL)
            assert.ok(!String(accepted.body ?? '').startsWith('```shell'), 'must not render the shell card')
        })

        it('does not render the shell card for an MCP tool named executeBash', async () => {
            const shellLike = {
                toolUseId: 'shell-collision-id',
                name: `${SERVER}___executeBash`,
                input: { explanation: 'probe' },
                stop: true,
            }
            mcpInstanceStub.get(() =>
                mcpStub({
                    getAllTools: () => [
                        { serverName: SERVER, toolName: 'executeBash', description: 'probe', inputSchema: {} },
                    ],
                    getOriginalToolNames: (name: string) =>
                        name === shellLike.name ? { serverName: SERVER, toolName: 'executeBash' } : undefined,
                })
            )
            const runToolStub = testFeatures.agent.runTool as sinon.SinonStub
            runToolStub.resolves({ output: { kind: 'text', content: 'PROBE' } })
            const stream = makeStream()
            const session = makeSession()
            session.setDeferredToolExecution.callsFake((_id: string, resolve: () => void) => resolve())

            await chatController.processToolUses([shellLike], stream as any, session, 'tabId', mockCancellationToken)

            const written = [...toolCards(stream.writeResultBlock), ...toolCards(stream.overwriteResultBlock)]
            assert.ok(written.length >= 1, 'at least one tool card was written')
            for (const card of written) {
                assert.notStrictEqual(card?.header?.body, 'shell', 'shell card header leaked')
                assert.ok(!String(card?.body ?? '').startsWith('```shell'), 'shell card body leaked')
            }
            // The MCP card is keyed by the plain toolUseId, not the shell tool's id scheme.
            const confirmation = toolCards(stream.writeResultBlock)[0]
            assert.strictEqual(confirmation.messageId, shellLike.toolUseId)
        })
    })
})

// The body may include text-based progress updates from tool invocations.
// We want to ignore these in the tests.
function assertChatResultsMatch(actual: any, expected: ChatResult) {
    // Check if both actual and expected have body properties
    if (actual?.body && expected?.body) {
        // For chat results with tool messages, the body might contain additional text
        // but should still end with the expected body text
        assert.ok(
            actual.body.endsWith(expected.body),
            `Body should end with "${expected.body}"\nActual: "${actual.body}"`
        )
    }

    // Compare all other properties except body and additionalMessages
    const actualWithoutBodyAndAdditionalMessages = { ...actual, body: undefined, additionalMessages: undefined }
    const expectedWithoutBodyAndAdditionalMessages = { ...expected, body: undefined, additionalMessages: undefined }

    // Compare the objects without the body and additionalMessages properties
    assert.deepStrictEqual(actualWithoutBodyAndAdditionalMessages, expectedWithoutBodyAndAdditionalMessages)
}
