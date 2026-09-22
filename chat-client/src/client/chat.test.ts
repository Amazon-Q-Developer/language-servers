import { injectJSDOM } from '../test/jsDomInjector'
// This needs to be run before all other imports so that mynah ui gets loaded inside of jsdom
injectJSDOM()

import { CHAT_OPTIONS, ERROR_MESSAGE, GENERIC_COMMAND, SEND_TO_PROMPT } from '@aws/chat-client-ui-types'
import {
    CHAT_REQUEST_METHOD,
    GET_SERIALIZED_CHAT_REQUEST_METHOD,
    OPEN_TAB_REQUEST_METHOD,
    READY_NOTIFICATION_METHOD,
    TAB_ADD_NOTIFICATION_METHOD,
    TAB_CHANGE_NOTIFICATION_METHOD,
    TAB_REMOVE_NOTIFICATION_METHOD,
} from '@aws/language-server-runtimes-types'
import { afterEach } from 'mocha'
import { assert } from 'sinon'
import { createChat } from './chat'
import * as sinon from 'sinon'
import { TELEMETRY } from '../contracts/serverContracts'
import {
    ERROR_MESSAGE_TELEMETRY_EVENT,
    SEND_TO_PROMPT_TELEMETRY_EVENT,
    TAB_ADD_TELEMETRY_EVENT,
} from '../contracts/telemetry'
import { MynahUI } from '@aws/mynah-ui'
import { TabFactory } from './tabs/tabFactory'
import { ChatClientAdapter } from '../contracts/chatClientAdapter'
import { deprecationCard } from './texts/deprecation'

describe('Chat', () => {
    const sandbox = sinon.createSandbox()
    const initialTabId = 'tab-1'
    let mynahUi: MynahUI
    let clientApi: { postMessage: sinon.SinonStub }
    let messageHandler: ((event: MessageEvent) => void) | undefined

    before(() => {
        // Mock global observers for test environment
        // @ts-expect-error: mock implementation for testing
        global.ResizeObserver = null
        // @ts-expect-error: mock implementation for testing
        global.IntersectionObserver = null
        // @ts-expect-error: mock implementation for testing
        global.MutationObserver = null
    })

    beforeEach(() => {
        sandbox.stub(TabFactory, 'generateUniqueId').returns(initialTabId)
        sandbox.stub(TabFactory.prototype, 'enableHistory')
        sandbox.stub(TabFactory.prototype, 'enableExport')

        clientApi = {
            postMessage: sandbox.stub(),
        }

        const originalAddEventListener = window.addEventListener.bind(window)
        sandbox.stub(window, 'addEventListener').callsFake((type: string, handler: any, ...rest: any[]) => {
            if (type === 'message') {
                messageHandler = handler
            }
            return originalAddEventListener(type, handler, ...rest)
        })

        mynahUi = createChat(clientApi, {
            agenticMode: true,
        })
    })

    afterEach(() => {
        if (messageHandler) {
            window.removeEventListener('message', messageHandler as EventListener)
            messageHandler = undefined
        }
        mynahUi.destroy()
        sandbox.restore()
    })

    after(() => {
        // @ts-expect-error: mock implementation for testing
        global.ResizeObserver = undefined
        // @ts-expect-error: mock implementation for testing
        global.MutationObserver = undefined
    })

    it('publishes ready event when initialized', () => {
        assert.callCount(clientApi.postMessage, 5)

        assert.calledWithExactly(clientApi.postMessage.getCall(0), {
            command: TELEMETRY,
            params: { name: 'enterFocus' },
        })
        assert.calledWithExactly(clientApi.postMessage.getCall(1), { command: READY_NOTIFICATION_METHOD })

        assert.calledWithExactly(clientApi.postMessage.getCall(2), {
            command: TAB_ADD_NOTIFICATION_METHOD,
            params: { tabId: initialTabId, restoredTab: undefined },
        })

        assert.calledWithExactly(clientApi.postMessage.getCall(3), {
            command: TELEMETRY,
            params: {
                triggerType: 'click',
                name: TAB_ADD_TELEMETRY_EVENT,
                tabId: initialTabId,
            },
        })

        assert.calledWithMatch(clientApi.postMessage.getCall(4), {
            command: 'aws/chat/listAvailableModels',
            params: { tabId: initialTabId },
        })
    })

    it('hides the deprecation notice when it was previously acknowledged', () => {
        mynahUi.destroy()
        mynahUi = createChat(clientApi, {
            agenticMode: true,
            deprecationNoticeAcknowledged: true,
        })

        const tabId = mynahUi.getSelectedTabId()
        const chatItems = tabId ? mynahUi.getTabData(tabId).getStore()?.chatItems : undefined

        assert.match(chatItems?.some(item => item.messageId === deprecationCard.messageId) ?? false, false)
    })

    it('publishes telemetry event, when send to prompt is triggered', () => {
        const eventParams = { command: SEND_TO_PROMPT, params: { prompt: 'hey' } }
        const sendToPromptEvent = createInboundEvent(eventParams)
        window.dispatchEvent(sendToPromptEvent)

        assert.calledWithExactly(clientApi.postMessage, {
            command: TELEMETRY,
            params: {
                name: SEND_TO_PROMPT_TELEMETRY_EVENT,
                tabId: mynahUi.getSelectedTabId(),
                ...eventParams.params,
            },
        })
    })

    it('publishes telemetry event, when show error is triggered', () => {
        const eventParams = { command: ERROR_MESSAGE, params: { tabId: '123' } }
        const errorEvent = createInboundEvent(eventParams)
        window.dispatchEvent(errorEvent)

        assert.calledWithExactly(clientApi.postMessage, {
            command: TELEMETRY,
            params: {
                name: ERROR_MESSAGE_TELEMETRY_EVENT,
                ...eventParams.params,
            },
        })
    })

    it('rejects inbound messages from a foreign origin (P389799154)', () => {
        // Simulates a cross-origin postMessage from an attacker page. The
        // handleInboundMessage same-origin check should drop the event before
        // any command is dispatched.
        clientApi.postMessage.resetHistory()

        const foreignEvent = new window.MessageEvent('message', {
            data: { command: SEND_TO_PROMPT, params: { prompt: 'pwn' } },
            origin: 'https://attacker.example.com',
        })
        window.dispatchEvent(foreignEvent)

        assert.notCalled(clientApi.postMessage)
    })

    it('accepts inbound messages with empty origin (Eclipse SWT Browser)', () => {
        // Eclipse SWT Browser loads content via file:// protocol, so
        // postMessage events arrive with an empty string origin.
        const warnStub = sandbox.stub(console, 'warn')

        const eclipseEvent = new window.MessageEvent('message', {
            data: { command: 'noop-test-command' },
            origin: '',
        })
        window.dispatchEvent(eclipseEvent)

        assert.notCalled(warnStub)
    })

    it('accepts inbound messages with "null" origin (sandboxed iframes)', () => {
        // Sandboxed iframes without allow-same-origin report origin as
        // the string "null".
        const warnStub = sandbox.stub(console, 'warn')

        const nullOriginEvent = new window.MessageEvent('message', {
            data: { command: 'noop-test-command' },
            origin: 'null',
        })
        window.dispatchEvent(nullOriginEvent)

        assert.notCalled(warnStub)
    })

    it('accepts inbound messages with non-HTTP origin (file:// protocol)', () => {
        const warnStub = sandbox.stub(console, 'warn')

        const fileEvent = new window.MessageEvent('message', {
            data: { command: 'noop-test-command' },
            origin: 'file://',
        })
        window.dispatchEvent(fileEvent)

        assert.notCalled(warnStub)
    })

    it('publishes tab added event, when UI tab is added', () => {
        const tabId = mynahUi.updateStore('', {})

        assert.calledWithMatch(clientApi.postMessage, {
            command: TAB_ADD_NOTIFICATION_METHOD,
            params: { tabId: tabId },
        })
    })

    it('publishes tab removed event, when UI tab is removed', () => {
        const tabId = mynahUi.updateStore('', {})
        mynahUi.removeTab(tabId!, (mynahUi as any).lastEventId)

        assert.calledWithMatch(clientApi.postMessage, {
            command: TAB_REMOVE_NOTIFICATION_METHOD,
            params: { tabId: tabId },
        })
    })

    it('publishes tab changed event, when UI tab is changed', () => {
        const tabId = mynahUi.updateStore('', {})
        mynahUi.updateStore('', {})
        clientApi.postMessage.resetHistory()
        mynahUi.selectTab(tabId!, (mynahUi as any).lastEventId)

        assert.calledOnceWithExactly(clientApi.postMessage, {
            command: TAB_CHANGE_NOTIFICATION_METHOD,
            params: { tabId: tabId },
        })
    })

    it('generic command creates a chat request', () => {
        const genericCommand = 'Fix'
        const selection = 'some code'
        const tabId = '123'
        const triggerType = 'click'
        const expectedPrompt = `${genericCommand} the following part of my code:\n~~~~\n${selection}\n~~~~\n`

        const genericCommandEvent = createInboundEvent({
            command: GENERIC_COMMAND,
            params: { tabId, selection, triggerType, genericCommand },
        })

        window.dispatchEvent(genericCommandEvent)
        assert.calledWithMatch(clientApi.postMessage, {
            command: CHAT_REQUEST_METHOD,
            params: {
                prompt: {
                    prompt: expectedPrompt,
                    escapedPrompt: expectedPrompt,
                },
            },
        })
    })

    it('open tab requestId was propagated from inbound to outbound message', () => {
        const requestId = 'request-1234'

        const openTabEvent = createInboundEvent({
            command: OPEN_TAB_REQUEST_METHOD,
            params: {
                newTabOptions: {
                    data: {
                        messages: [],
                    },
                },
            },
            requestId: requestId,
        })
        window.dispatchEvent(openTabEvent)

        // Verify that postMessage was called with the correct requestId
        assert.calledWithExactly(clientApi.postMessage, {
            command: OPEN_TAB_REQUEST_METHOD,
            requestId,
            params: {
                success: true,
                result: sinon.match({
                    tabId: sinon.match.string,
                }),
            },
        })
    })

    it('complete chat response triggers ui events', () => {
        const endMessageStreamStub = sandbox.stub(mynahUi, 'endMessageStream')
        const updateStoreStub = sandbox.stub(mynahUi, 'updateStore')

        const tabId = '123'
        const body = 'some response'

        const chatEvent = createInboundEvent({
            command: CHAT_REQUEST_METHOD,
            tabId,
            params: { body },
        })
        window.dispatchEvent(chatEvent)

        assert.calledOnceWithExactly(endMessageStreamStub, tabId, '', {
            header: undefined,
            buttons: undefined,
            body: 'some response',
            followUp: {},
            relatedContent: undefined,
            canBeVoted: undefined,
            codeReference: undefined,
            fileList: undefined,
        })
        assert.calledOnceWithExactly(updateStoreStub, tabId, {
            loadingChat: false,
            promptInputDisabledState: false,
            cancelButtonWhenLoading: true,
        })
    })

    it('partial chat response triggers ui events', () => {
        const endMessageStreamStub = sandbox.stub(mynahUi, 'endMessageStream')
        const updateStoreStub = sandbox.stub(mynahUi, 'updateStore')

        const tabId = '123'
        const body = 'some response'

        const chatEvent = createInboundEvent({
            command: CHAT_REQUEST_METHOD,
            tabId,
            params: { body },
            isPartialResult: true,
        })
        window.dispatchEvent(chatEvent)
        assert.notCalled(endMessageStreamStub)
        assert.calledOnce(updateStoreStub)
    })

    it('partial chat response with header triggers ui events', () => {
        const endMessageStreamStub = sandbox.stub(mynahUi, 'endMessageStream')
        const updateStoreStub = sandbox.stub(mynahUi, 'updateStore')

        const tabId = '123'
        const body = 'some response'

        const contextList = {
            filePaths: ['file1', 'file2'],
            details: {
                file1: {
                    lineRanges: [{ first: 1, second: 2 }],
                },
            },
        }
        const params = { body, contextList }

        const mockHeader = {
            fileList: {
                fileTreeTitle: '',
                filePaths: ['file1', 'file2'],
                rootFolderTitle: 'Context',
                flatList: true,
                collapsed: true,
                hideFileCount: true,
                details: {
                    file1: {
                        label: 'line 1 - 2',
                        description: 'file1',
                        clickable: true,
                    },
                },
            },
        }

        const chatEvent = createInboundEvent({
            command: CHAT_REQUEST_METHOD,
            tabId,
            params,
            isPartialResult: true,
        })

        window.dispatchEvent(chatEvent)
        assert.notCalled(endMessageStreamStub)
        assert.calledOnce(updateStoreStub)
    })

    describe('chatOptions', () => {
        it('enables history and export features support', () => {
            const chatOptionsRequest = createInboundEvent({
                command: CHAT_OPTIONS,
                params: {
                    history: true,
                    export: true,
                },
            })
            window.dispatchEvent(chatOptionsRequest)

            // @ts-expect-error: accessing prototype method
            assert.called(TabFactory.prototype.enableHistory)
            // @ts-expect-error: accessing prototype method
            assert.called(TabFactory.prototype.enableExport)
        }).timeout(20000)

        it('does not enable history and export features support if flags are falsy', async () => {
            const chatOptionsRequest = createInboundEvent({
                command: CHAT_OPTIONS,
                params: {
                    history: false,
                    export: false,
                },
            })
            window.dispatchEvent(chatOptionsRequest)

            // @ts-expect-error: accessing prototype method
            assert.notCalled(TabFactory.prototype.enableHistory)
            // @ts-expect-error: accessing prototype method
            assert.notCalled(TabFactory.prototype.enableExport)
        }).timeout(20000)

        it('enables MCP when params.mcpServers is true and config.agenticMode is true', function () {
            // Create a separate sandbox for this test
            const testSandbox = sinon.createSandbox()
            let localMynahUi: MynahUI | undefined

            // Save original window functions
            const originalAddEventListener = window.addEventListener
            const originalDispatchEvent = window.dispatchEvent

            try {
                // Create a clean stub for this test
                const enableMcpStub = testSandbox.stub(TabFactory.prototype, 'enableMcp')
                const localClientApi = { postMessage: testSandbox.stub() }

                // Mock the event handling to isolate this test
                let messageHandler: any
                window.addEventListener = (type: string, handler: any) => {
                    if (type === 'message') {
                        messageHandler = handler
                    }
                    return undefined as any
                }

                // Create a new chat instance specifically for this test
                localMynahUi = createChat(localClientApi, { agenticMode: true })

                // Create a new event
                const chatOptionsRequest = createInboundEvent({
                    command: CHAT_OPTIONS,
                    params: {
                        mcpServers: true,
                        chatNotifications: [],
                    },
                })

                // Manually call the handler with our event
                if (messageHandler) {
                    messageHandler(chatOptionsRequest)
                }

                // Verify enableMcp was called exactly once
                assert.calledOnce(enableMcpStub)
            } finally {
                // Restore window functions
                window.addEventListener = originalAddEventListener
                window.dispatchEvent = originalDispatchEvent
                localMynahUi?.destroy()
                testSandbox.restore()
            }
        })

        it('does not enable MCP when params.mcpServers is true but config.agenticMode is false', function () {
            // Create a separate sandbox for this test
            const testSandbox = sinon.createSandbox()
            let localMynahUi: MynahUI | undefined

            // Save original window functions
            const originalAddEventListener = window.addEventListener
            const originalDispatchEvent = window.dispatchEvent

            try {
                // Create a clean stub for this test
                const enableMcpStub = testSandbox.stub(TabFactory.prototype, 'enableMcp')
                const localClientApi = { postMessage: testSandbox.stub() }

                // Mock the event handling to isolate this test
                let messageHandler: any
                window.addEventListener = (type: string, handler: any) => {
                    if (type === 'message') {
                        messageHandler = handler
                    }
                    return undefined as any
                }

                // Create a new chat instance specifically for this test
                localMynahUi = createChat(localClientApi, { agenticMode: false })

                // Create a new event
                const chatOptionsRequest = createInboundEvent({
                    command: CHAT_OPTIONS,
                    params: {
                        mcpServers: true,
                        chatNotifications: [],
                    },
                })

                // Manually call the handler with our event
                if (messageHandler) {
                    messageHandler(chatOptionsRequest)
                }

                // Verify enableMcp was not called
                assert.notCalled(enableMcpStub)
            } finally {
                // Restore window functions
                window.addEventListener = originalAddEventListener
                window.dispatchEvent = originalDispatchEvent
                localMynahUi?.destroy()
                testSandbox.restore()
            }
        })

        it('does not enable MCP when params.mcpServers is false and config.agenticMode is true', function () {
            // Create a separate sandbox for this test
            const testSandbox = sinon.createSandbox()
            let localMynahUi: MynahUI | undefined

            // Save original window functions
            const originalAddEventListener = window.addEventListener
            const originalDispatchEvent = window.dispatchEvent

            try {
                // Create a clean stub for this test
                const enableMcpStub = testSandbox.stub(TabFactory.prototype, 'enableMcp')
                const localClientApi = { postMessage: testSandbox.stub() }

                // Mock the event handling to isolate this test
                let messageHandler: any
                window.addEventListener = (type: string, handler: any) => {
                    if (type === 'message') {
                        messageHandler = handler
                    }
                    return undefined as any
                }

                // Create a new chat instance specifically for this test
                localMynahUi = createChat(localClientApi, { agenticMode: true })

                // Create a new event
                const chatOptionsRequest = createInboundEvent({
                    command: CHAT_OPTIONS,
                    params: {
                        mcpServers: false,
                        chatNotifications: [],
                    },
                })

                // Manually call the handler with our event
                if (messageHandler) {
                    messageHandler(chatOptionsRequest)
                }

                // Verify enableMcp was not called
                assert.notCalled(enableMcpStub)
            } finally {
                // Restore window functions
                window.addEventListener = originalAddEventListener
                window.dispatchEvent = originalDispatchEvent
                localMynahUi?.destroy()
                testSandbox.restore()
            }
        })

        it('does not enable MCP when params.mcpServers is undefined and config.agenticMode is true', function () {
            // Create a separate sandbox for this test
            const testSandbox = sinon.createSandbox()
            let localMynahUi: MynahUI | undefined

            // Save original window functions
            const originalAddEventListener = window.addEventListener
            const originalDispatchEvent = window.dispatchEvent

            try {
                // Create a clean stub for this test
                const enableMcpStub = testSandbox.stub(TabFactory.prototype, 'enableMcp')
                const localClientApi = { postMessage: testSandbox.stub() }

                // Mock the event handling to isolate this test
                let messageHandler: any
                window.addEventListener = (type: string, handler: any) => {
                    if (type === 'message') {
                        messageHandler = handler
                    }
                    return undefined as any
                }

                // Create a new chat instance specifically for this test
                localMynahUi = createChat(localClientApi, { agenticMode: true })

                // Create a new event
                const chatOptionsRequest = createInboundEvent({
                    command: CHAT_OPTIONS,
                    params: {
                        chatNotifications: [],
                    },
                })

                // Manually call the handler with our event
                if (messageHandler) {
                    messageHandler(chatOptionsRequest)
                }

                // Verify enableMcp was not called
                assert.notCalled(enableMcpStub)
            } finally {
                // Restore window functions
                window.addEventListener = originalAddEventListener
                window.dispatchEvent = originalDispatchEvent
                localMynahUi?.destroy()
                testSandbox.restore()
            }
        })
    })

    describe('onGetSerializedChat', () => {
        it('getSerializedChat requestId was propagated from inbound to outbound message', () => {
            const requestId = 'request-1234'
            const tabId = mynahUi.updateStore('', {})

            const setSerializedChatEvent = createInboundEvent({
                command: GET_SERIALIZED_CHAT_REQUEST_METHOD,
                params: {
                    tabId: tabId,
                    format: 'markdown',
                },
                requestId: requestId,
            })
            window.dispatchEvent(setSerializedChatEvent)

            // Verify that postMessage was called with the correct requestId
            assert.calledWithExactly(clientApi.postMessage, {
                requestId,
                command: GET_SERIALIZED_CHAT_REQUEST_METHOD,
                params: {
                    success: true,
                    result: sinon.match({
                        content: sinon.match.string,
                    }),
                },
            })
        })
    })

    function createInboundEvent(params: any) {
        // Use MessageEvent (not CustomEvent) and set origin to window.location.origin
        // so that handleInboundMessage's same-origin check accepts it. See
        // chat.ts handleInboundMessage origin validation (P389799154).
        // window.MessageEvent is the jsdom event class; using the global Node
        // MessageEvent fails dispatchEvent's instanceof check.
        return new window.MessageEvent('message', {
            data: params,
            origin: window.location.origin,
        })
    }

    describe('with client adapter', () => {
        it('should route inbound message to client adapter', () => {
            const handleMessageReceiveStub = sandbox.stub()
            const createChatEventHandlerStub = sandbox.stub().returns({})
            const clientAdapter: Partial<ChatClientAdapter> = {
                createChatEventHandler: createChatEventHandlerStub,
                handleMessageReceive: handleMessageReceiveStub,
                isSupportedTab: () => false,
            }
            mynahUi.destroy()
            mynahUi = createChat(
                clientApi,
                {
                    agenticMode: true,
                },
                clientAdapter as ChatClientAdapter
            )

            const tabId = '123'
            const body = 'some response'

            const chatEvent = createInboundEvent({
                command: CHAT_REQUEST_METHOD,
                tabId,
                params: { body },
                sender: 'ide-extension',
            })
            window.dispatchEvent(chatEvent)

            assert.calledOnce(handleMessageReceiveStub)
            assert.match(handleMessageReceiveStub.getCall(0).args[0].data, JSON.stringify(chatEvent.data))
        })
    })
})
