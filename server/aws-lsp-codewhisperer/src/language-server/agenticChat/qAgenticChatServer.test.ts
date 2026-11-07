/**
 * Copied from ../qChatServer.test.ts for the purpose of developing a divergent implementation.
 * Will be deleted or merged.
 */

import * as assert from 'assert'
import { CancellationToken, Logging, Server } from '@aws/language-server-runtimes/server-interface'
import {
    activeEditorChangedNotificationType,
    createPromptNotificationType,
    feedbackNotificationType,
    fileClickNotificationType,
    followUpClickNotificationType,
    inlineChatResultNotificationType,
    insertToCursorPositionNotificationType,
    onPinnedContextAddNotificationType,
    onPinnedContextRemoveNotificationType,
    promptInputOptionChangeNotificationType,
    readyNotificationType,
    tabAddNotificationType,
    tabChangeNotificationType,
    tabRemoveNotificationType,
} from '@aws/language-server-runtimes/protocol'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import sinon from 'ts-sinon'
import { AgenticChatController } from './agenticChatController'
import { ChatSessionManagementService } from '../chat/chatSessionManagementService'
import { logNotificationErrors, QAgenticChatServer } from './qAgenticChatServer'
import { AmazonQTokenServiceManager } from '../../shared/amazonQServiceManager/AmazonQTokenServiceManager'
import { AmazonQBaseServiceManager } from '../../shared/amazonQServiceManager/BaseAmazonQServiceManager'
import { Features } from '../types'

describe('QAgenticChatServer', () => {
    const mockTabId = 'mockTabId'
    let disposeStub: sinon.SinonStub
    let withAmazonQServiceSpy: sinon.SinonSpy<
        [serviceManager: AmazonQBaseServiceManager, lsp?: Features['lsp'] | undefined],
        ChatSessionManagementService
    >
    let testFeatures: TestFeatures
    let amazonQServiceManager: AmazonQTokenServiceManager
    let disposeServer: () => void
    let chatSessionManagementService: ChatSessionManagementService

    beforeEach(async () => {
        testFeatures = new TestFeatures()

        testFeatures.workspace.fs = {
            ...testFeatures.workspace.fs,
            getServerDataDirPath: sinon.stub().returns('/mock/server/data/path'),
            mkdir: sinon.stub().resolves(),
            readFile: sinon.stub().resolves(),
            writeFile: sinon.stub().resolves(),
            rm: sinon.stub().resolves(),
            getFileSize: sinon.stub().resolves(),
        }

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

        AmazonQTokenServiceManager.resetInstance()

        AmazonQTokenServiceManager.initInstance(testFeatures)
        amazonQServiceManager = AmazonQTokenServiceManager.getInstance()

        disposeStub = sinon.stub(ChatSessionManagementService.prototype, 'dispose')
        chatSessionManagementService = ChatSessionManagementService.getInstance()
        withAmazonQServiceSpy = sinon.spy(chatSessionManagementService, 'withAmazonQServiceManager')

        const chatServerFactory: Server = QAgenticChatServer()

        disposeServer = chatServerFactory(testFeatures)

        testFeatures.doSendInitializedNotification()
    })

    afterEach(() => {
        sinon.restore()
        ChatSessionManagementService.reset()
        disposeServer()
        testFeatures.dispose()
    })

    it('should initialize ChatSessionManagementService with AmazonQTokenServiceManager instance', () => {
        sinon.assert.calledOnceWithExactly(withAmazonQServiceSpy, amazonQServiceManager, testFeatures.lsp)
    })

    it('dispose should dispose all chat session services', () => {
        disposeServer()

        sinon.assert.calledOnce(disposeStub)
    })

    it('calls the corresponding controller when tabAdd notification is received', () => {
        const tabAddStub = sinon.stub(AgenticChatController.prototype, 'onTabAdd')

        testFeatures.chat.onTabAdd.firstCall.firstArg({ tabId: mockTabId })

        sinon.assert.calledOnce(tabAddStub)
    })

    it('calls the corresponding controller when tabRemove notification is received', () => {
        const tabRemoveStub = sinon.stub(AgenticChatController.prototype, 'onTabRemove')

        testFeatures.chat.onTabRemove.firstCall.firstArg({ tabId: mockTabId })

        sinon.assert.calledOnce(tabRemoveStub)
    })

    it('calls the corresponding controller when endChat request is received', () => {
        const endChatStub = sinon.stub(AgenticChatController.prototype, 'onEndChat')

        testFeatures.chat.onEndChat.firstCall.firstArg({ tabId: mockTabId })

        sinon.assert.calledOnce(endChatStub)
    })

    it('calls the corresponding controller when chatPrompt request is received', () => {
        const chatPromptStub = sinon.stub(AgenticChatController.prototype, 'onChatPrompt')

        testFeatures.chat.onChatPrompt.firstCall.firstArg({ tabId: mockTabId, prompt: { prompt: 'Hello' } }, {})

        sinon.assert.calledOnce(chatPromptStub)
    })

    it('calls the corresponding controller when inlineChatPrompt request is received', () => {
        const inlineChatPromptStub = sinon.stub(AgenticChatController.prototype, 'onInlineChatPrompt')
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

    it('calls the corresponding controller when tabBarAction request is received', () => {
        const tabBarActionStub = sinon.stub(AgenticChatController.prototype, 'onTabBarAction')

        testFeatures.chat.onTabBarAction.firstCall.firstArg({ tabId: mockTabId, action: 'export' })

        sinon.assert.calledOnce(tabBarActionStub)
    })

    /**
     * Runs `action`, lets pending promise callbacks run, and returns the rejections that had no handler.
     * Mocha re-emits an unhandled rejection from test code instead of failing on it, so a listener added here
     * receives it, possibly more than once.
     */
    async function unhandledRejectionsDuring(action: () => void): Promise<unknown[]> {
        const rejections: unknown[] = []
        const listener = (reason: unknown) => rejections.push(reason)
        process.on('unhandledRejection', listener)
        try {
            action()
            await new Promise(resolve => setImmediate(resolve))
        } finally {
            process.removeListener('unhandledRejection', listener)
        }
        return rejections
    }

    describe('request handler results', () => {
        // The chat registrations that the runtime binds to JSON-RPC requests. They must return the controller's
        // result, because the JSON-RPC layer sends it as the response.
        const requestRegistrations = [
            'onEndChat',
            'onChatPrompt',
            'onOpenFileDialog',
            'onInlineChatPrompt',
            'onQuickAction',
            'onListConversations',
            'onListRules',
            'onConversationClick',
            'onRuleClick',
            'onListMcpServers',
            'onMcpServerClick',
            'onTabBarAction',
            'onButtonClick',
            'onListAvailableModels',
        ] as const

        for (const name of requestRegistrations) {
            it(`returns the controller result from the ${name} handler`, () => {
                const result = { marker: name }
                sinon.stub(AgenticChatController.prototype, name).returns(result as any)
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
            ['onReady', readyNotificationType.method],
            ['onTabChange', tabChangeNotificationType.method],
            ['onTabRemove', tabRemoveNotificationType.method],
            ['onSendFeedback', feedbackNotificationType.method],
            ['onCodeInsertToCursorPosition', insertToCursorPositionNotificationType.method],
            ['onCreatePrompt', createPromptNotificationType.method],
            ['onFileClicked', fileClickNotificationType.method],
            ['onFollowUpClicked', followUpClickNotificationType.method],
            ['onPromptInputOptionChange', promptInputOptionChangeNotificationType.method],
            ['onInlineChatResult', inlineChatResultNotificationType.method],
            ['onActiveEditorChanged', activeEditorChangedNotificationType.method],
            ['onPinnedContextAdd', onPinnedContextAddNotificationType.method],
            ['onPinnedContextRemove', onPinnedContextRemoveNotificationType.method],
        ] as const

        for (const [name, method] of notificationRegistrations) {
            it(`logs a rejected ${name} handler and leaves no unhandled rejection`, async () => {
                sinon.stub(AgenticChatController.prototype, name).rejects(new Error(`${name} failed`))
                const handler = (testFeatures.chat[name] as sinon.SinonStub).firstCall.firstArg

                const rejections = await unhandledRejectionsDuring(() => handler({ tabId: mockTabId }))

                assert.deepStrictEqual(rejections, [])
                sinon.assert.calledWithMatch(
                    testFeatures.logging.error as sinon.SinonStub,
                    sinon.match(method).and(sinon.match(`${name} failed`))
                )
            })
        }

        it('logs a notification handler that throws instead of throwing to the caller', () => {
            sinon.stub(AgenticChatController.prototype, 'onTabAdd').throws(new Error('onTabAdd threw'))

            assert.doesNotThrow(() => testFeatures.chat.onTabAdd.firstCall.firstArg({ tabId: mockTabId }))

            sinon.assert.calledWithMatch(
                testFeatures.logging.error as sinon.SinonStub,
                sinon.match(tabAddNotificationType.method).and(sinon.match('onTabAdd threw'))
            )
        })

        it('creates a saved prompt when a rule is requested with no workspace folder open', async () => {
            testFeatures.workspace.getAllWorkspaceFolders.returns([])
            const handler = testFeatures.chat.onCreatePrompt.firstCall.firstArg

            const rejections = await unhandledRejectionsDuring(() =>
                handler({ promptName: 'no-folder-rule', isRule: true })
            )

            assert.deepStrictEqual(rejections, [])
            sinon.assert.neverCalledWithMatch(
                testFeatures.logging.error as sinon.SinonStub,
                sinon.match(createPromptNotificationType.method)
            )
            sinon.assert.calledWithMatch(
                testFeatures.workspace.fs.writeFile as sinon.SinonStub,
                sinon.match(/no-folder-rule\.md$/)
            )
        })
    })

    describe('logNotificationErrors()', () => {
        let logError: sinon.SinonStub
        let logging: Logging

        beforeEach(() => {
            logError = sinon.stub()
            logging = { error: logError } as unknown as Logging
        })

        it('passes the params to the handler and logs nothing when the handler succeeds', async () => {
            const syncHandler = sinon.stub().returns(undefined)
            const asyncHandler = sinon.stub().resolves('done')

            logNotificationErrors(logging, 'test/sync', syncHandler)({ value: 1 })
            logNotificationErrors(logging, 'test/async', asyncHandler)({ value: 2 })
            await new Promise(resolve => setImmediate(resolve))

            sinon.assert.calledOnceWithExactly(syncHandler, { value: 1 })
            sinon.assert.calledOnceWithExactly(asyncHandler, { value: 2 })
            sinon.assert.notCalled(logError)
        })

        it('logs a rejection reason that is not an Error', async () => {
            logNotificationErrors(logging, 'test/reject', () => Promise.reject('plain reason'))(undefined)
            await new Promise(resolve => setImmediate(resolve))

            sinon.assert.calledOnceWithMatch(logError, sinon.match('test/reject').and(sinon.match('plain reason')))
        })

        it('leaves no unhandled rejection when the rejection reason cannot be formatted', async () => {
            // JSON serialization, which formatErr uses, throws on a bigint
            const rejections = await unhandledRejectionsDuring(() =>
                logNotificationErrors(logging, 'test/bigint', () => Promise.reject(10n))(undefined)
            )

            assert.deepStrictEqual(rejections, [])
        })

        it('leaves no unhandled rejection or exception when the logger throws', async () => {
            logError.throws(new Error('logger failed'))

            const rejections = await unhandledRejectionsDuring(() => {
                logNotificationErrors(logging, 'test/reject', () => Promise.reject(new Error('rejected')))(undefined)
                logNotificationErrors(logging, 'test/throw', () => {
                    throw new Error('thrown')
                })(undefined)
            })

            assert.deepStrictEqual(rejections, [])
            sinon.assert.calledTwice(logError)
        })
    })
})
