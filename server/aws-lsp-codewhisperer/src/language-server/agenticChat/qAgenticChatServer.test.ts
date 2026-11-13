/**
 * Copied from ../qChatServer.test.ts for the purpose of developing a divergent implementation.
 * Will be deleted or merged.
 */

import * as assert from 'assert'
import { CancellationToken, Server } from '@aws/language-server-runtimes/server-interface'
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
import { QAgenticChatServer } from './qAgenticChatServer'
import { AmazonQTokenServiceManager } from '../../shared/amazonQServiceManager/AmazonQTokenServiceManager'
import { AmazonQBaseServiceManager } from '../../shared/amazonQServiceManager/BaseAmazonQServiceManager'
import { LocalProjectContextController } from '../../shared/localProjectContextController'
import { unhandledRejectionsDuring } from '../../shared/testUtils'
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
        // Without an instance, the chat's context commands wait up to 60 seconds for one and then set
        // onContextItemsUpdated on whichever controller a later test file creates
        sinon.stub(LocalProjectContextController, 'getInstance').resolves({
            getContextCommandItems: sinon.stub().resolves([]),
        } as any)
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
                const failure = new Error(`${name} failed`)
                sinon.stub(AgenticChatController.prototype, name).rejects(failure)
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

            handler({ promptName: 'no-folder-rule', isRule: true })
            await new Promise(resolve => setImmediate(resolve))

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
})
