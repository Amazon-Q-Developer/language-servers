import * as assert from 'assert'
import { CancellationToken, Server } from '@aws/language-server-runtimes/server-interface'
import {
    feedbackNotificationType,
    inlineChatResultNotificationType,
    insertToCursorPositionNotificationType,
    tabAddNotificationType,
    tabChangeNotificationType,
    tabRemoveNotificationType,
} from '@aws/language-server-runtimes/protocol'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import sinon from 'ts-sinon'
import { ChatController } from './chatController'
import { ChatSessionManagementService } from './chatSessionManagementService'
import { QChatServerFactory } from './qChatServer'
import { initBaseTestServiceManager, TestAmazonQServiceManager } from '../../shared/amazonQServiceManager/testUtils'
import { unhandledRejectionsDuring } from '../../shared/testUtils'

describe('QChatServer', () => {
    const mockTabId = 'mockTabId'
    let disposeStub: sinon.SinonStub
    let withAmazonQServiceSpy: sinon.SinonSpy
    let testFeatures: TestFeatures
    let amazonQServiceManager: TestAmazonQServiceManager
    let disposeServer: () => void
    let chatSessionManagementService: ChatSessionManagementService

    beforeEach(() => {
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

        TestAmazonQServiceManager.resetInstance()
        amazonQServiceManager = initBaseTestServiceManager(testFeatures)
        disposeStub = sinon.stub(ChatSessionManagementService.prototype, 'dispose')
        chatSessionManagementService = ChatSessionManagementService.getInstance()
        withAmazonQServiceSpy = sinon.spy(chatSessionManagementService, 'withAmazonQServiceManager')

        const chatServerFactory: Server = QChatServerFactory(() => amazonQServiceManager)

        disposeServer = chatServerFactory(testFeatures)

        // Trigger initialize notification
        testFeatures.doSendInitializedNotification()
    })

    afterEach(() => {
        sinon.restore()
        ChatSessionManagementService.reset()
        testFeatures.dispose()
    })

    it('should initialize ChatSessionManagementService with AmazonQTokenServiceManager instance', () => {
        sinon.assert.calledOnceWithExactly(withAmazonQServiceSpy, amazonQServiceManager)
    })

    it('dispose should dispose all chat session services', () => {
        disposeServer()

        sinon.assert.calledOnce(disposeStub)
    })

    it('calls the corresponding controller when tabAdd notification is received', () => {
        const tabAddStub = sinon.stub(ChatController.prototype, 'onTabAdd')

        testFeatures.chat.onTabAdd.firstCall.firstArg({ tabId: mockTabId })

        sinon.assert.calledOnce(tabAddStub)
    })

    it('calls the corresponding controller when tabRemove notification is received', () => {
        const tabRemoveStub = sinon.stub(ChatController.prototype, 'onTabRemove')

        testFeatures.chat.onTabRemove.firstCall.firstArg({ tabId: mockTabId })

        sinon.assert.calledOnce(tabRemoveStub)
    })

    it('calls the corresponding controller when endChat request is received', () => {
        const endChatStub = sinon.stub(ChatController.prototype, 'onEndChat')

        testFeatures.chat.onEndChat.firstCall.firstArg({ tabId: mockTabId })

        sinon.assert.calledOnce(endChatStub)
    })

    it('calls the corresponding controller when chatPrompt request is received', () => {
        const chatPromptStub = sinon.stub(ChatController.prototype, 'onChatPrompt')

        testFeatures.chat.onChatPrompt.firstCall.firstArg({ tabId: mockTabId, prompt: { prompt: 'Hello' } }, {})

        sinon.assert.calledOnce(chatPromptStub)
    })

    it('calls the corresponding controller when inlineChatPrompt request is received', () => {
        const inlineChatPromptStub = sinon.stub(ChatController.prototype, 'onInlineChatPrompt')
        const mockCancellationToken: CancellationToken = {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => {} }),
        }
        testFeatures.chat.onInlineChatPrompt.firstCall.firstArg({ prompt: { prompt: 'Hello' } }, mockCancellationToken)

        sinon.assert.calledOnce(inlineChatPromptStub)
        sinon.assert.calledWith(
            inlineChatPromptStub,
            {
                prompt: { prompt: 'Hello' },
            },
            mockCancellationToken
        )
    })

    describe('request handler results', () => {
        // The chat registrations that the runtime binds to JSON-RPC requests. They must return the controller's
        // result, because the JSON-RPC layer sends it as the response.
        const requestRegistrations = ['onEndChat', 'onChatPrompt', 'onInlineChatPrompt', 'onQuickAction'] as const

        for (const name of requestRegistrations) {
            it(`returns the controller result from the ${name} handler`, () => {
                const result = { marker: name }
                sinon.stub(ChatController.prototype, name).returns(result as any)
                const handler = (testFeatures.chat[name] as sinon.SinonStub).firstCall.firstArg

                assert.strictEqual(handler({ tabId: mockTabId }, {}), result)
            })
        }
    })

    describe('notification handler failures', () => {
        // The chat registrations that the runtime binds to JSON-RPC notifications, with their method names. Each
        // registration has the same name as the controller method that it calls.
        const notificationRegistrations = [
            ['onTabAdd', tabAddNotificationType.method],
            ['onTabChange', tabChangeNotificationType.method],
            ['onTabRemove', tabRemoveNotificationType.method],
            ['onSendFeedback', feedbackNotificationType.method],
            ['onCodeInsertToCursorPosition', insertToCursorPositionNotificationType.method],
            ['onInlineChatResult', inlineChatResultNotificationType.method],
        ] as const

        for (const [name, method] of notificationRegistrations) {
            it(`logs a rejected ${name} handler and leaves no unhandled rejection`, async () => {
                const failure = new Error(`${name} failed`)
                sinon.stub(ChatController.prototype, name).rejects(failure)
                const handler = (testFeatures.chat[name] as sinon.SinonStub).firstCall.firstArg

                const rejections = await unhandledRejectionsDuring(() => handler({ tabId: mockTabId }))

                assert.ok(!rejections.includes(failure), `the ${name} failure was left as an unhandled rejection`)
                sinon.assert.calledWithMatch(
                    testFeatures.logging.error as sinon.SinonStub,
                    sinon.match(method).and(sinon.match(`${name} failed`))
                )
            })
        }

        it('logs a notification handler that throws instead of throwing to the caller', () => {
            sinon.stub(ChatController.prototype, 'onTabAdd').throws(new Error('onTabAdd threw'))

            assert.doesNotThrow(() => testFeatures.chat.onTabAdd.firstCall.firstArg({ tabId: mockTabId }))

            sinon.assert.calledWithMatch(
                testFeatures.logging.error as sinon.SinonStub,
                sinon.match(tabAddNotificationType.method).and(sinon.match('onTabAdd threw'))
            )
        })

        it('logs an insert notification whose code is not a string', async () => {
            const handler = testFeatures.chat.onCodeInsertToCursorPosition.firstCall.firstArg

            handler({
                tabId: mockTabId,
                textDocument: { uri: 'file:///insert-check.ts' },
                cursorPosition: { line: 0, character: 0 },
                code: 123,
            })
            await new Promise(resolve => setImmediate(resolve))

            sinon.assert.calledWithMatch(
                testFeatures.logging.error as sinon.SinonStub,
                sinon
                    .match(insertToCursorPositionNotificationType.method)
                    .and(sinon.match('TypeError'))
                    .and(sinon.match('is not a function'))
            )
        })
    })
})
