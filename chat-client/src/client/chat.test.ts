import { injectJSDOM } from '../test/jsDomInjector'
// This needs to be run before all other imports so that mynah ui gets loaded inside of jsdom
injectJSDOM()

import { JSDOM } from 'jsdom'

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
    CHAT_MESSAGE_RENDERED_TELEMETRY_EVENT,
    CHAT_POST_MESSAGE_REJECTED_TELEMETRY_EVENT,
    ERROR_MESSAGE_TELEMETRY_EVENT,
    SEND_TO_PROMPT_TELEMETRY_EVENT,
    TAB_ADD_TELEMETRY_EVENT,
} from '../contracts/telemetry'
import { MynahUI } from '@aws/mynah-ui'
import { TabFactory } from './tabs/tabFactory'
import { ChatClientAdapter } from '../contracts/chatClientAdapter'

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
        sandbox.restore()

        Object.keys(mynahUi.getAllTabs()).forEach(tabId => {
            mynahUi.removeTab(tabId, (mynahUi as any).lastEventId)
        })
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

    it('publishes chatMessageRendered telemetry on a terminal (non-partial) chat response', () => {
        clientApi.postMessage.resetHistory()
        const event = createInboundEvent({
            command: CHAT_REQUEST_METHOD,
            params: { body: 'hello' },
            tabId: initialTabId,
            isPartialResult: false,
        })
        window.dispatchEvent(event)

        assert.calledWithExactly(clientApi.postMessage, {
            command: TELEMETRY,
            params: { name: CHAT_MESSAGE_RENDERED_TELEMETRY_EVENT, tabId: initialTabId },
        })
    })

    it('does NOT publish chatMessageRendered telemetry on a partial chat response chunk', () => {
        clientApi.postMessage.resetHistory()
        const event = createInboundEvent({
            command: CHAT_REQUEST_METHOD,
            params: { body: 'partial…' },
            tabId: initialTabId,
            isPartialResult: true,
        })
        window.dispatchEvent(event)

        assert.neverCalledWithMatch(clientApi.postMessage, {
            command: TELEMETRY,
            params: { name: CHAT_MESSAGE_RENDERED_TELEMETRY_EVENT },
        })
    })

    it('publishes chatPostMessageRejected telemetry for an unknown command', () => {
        clientApi.postMessage.resetHistory()
        const event = createInboundEvent({ command: 'totally-bogus-command' })
        window.dispatchEvent(event)

        assert.calledWithExactly(clientApi.postMessage, {
            command: TELEMETRY,
            params: {
                name: CHAT_POST_MESSAGE_REJECTED_TELEMETRY_EVENT,
                reason: 'unknownCommand',
                command: 'totally-bogus-command',
                tabId: undefined,
            },
        })
    })

    it('publishes chatPostMessageRejected telemetry when inbound data is undefined', () => {
        clientApi.postMessage.resetHistory()
        // NOTE: a dispatched jsdom/browser MessageEvent always coerces `data` to null (never
        // undefined), so this branch can't be reached via window.dispatchEvent. We invoke the
        // captured handler directly with a synthetic event to exercise the event.data===undefined
        // drop branch deterministically.
        if (!messageHandler) {
            throw new Error('message handler was not registered')
        }
        messageHandler({ origin: window.location.origin, data: undefined } as MessageEvent)

        assert.calledOnceWithExactly(clientApi.postMessage, {
            command: TELEMETRY,
            params: {
                name: CHAT_POST_MESSAGE_REJECTED_TELEMETRY_EVENT,
                reason: 'undefinedData',
                command: undefined,
                tabId: undefined,
            },
        })
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
                const localMynahUi = createChat(localClientApi, { agenticMode: true })

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
                testSandbox.restore()
            }
        })

        it('does not enable MCP when params.mcpServers is true but config.agenticMode is false', function () {
            // Create a separate sandbox for this test
            const testSandbox = sinon.createSandbox()

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
                const localMynahUi = createChat(localClientApi, { agenticMode: false })

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
                testSandbox.restore()
            }
        })

        it('does not enable MCP when params.mcpServers is false and config.agenticMode is true', function () {
            // Create a separate sandbox for this test
            const testSandbox = sinon.createSandbox()

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
                const localMynahUi = createChat(localClientApi, { agenticMode: true })

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
                testSandbox.restore()
            }
        })

        it('does not enable MCP when params.mcpServers is undefined and config.agenticMode is true', function () {
            // Create a separate sandbox for this test
            const testSandbox = sinon.createSandbox()

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
                const localMynahUi = createChat(localClientApi, { agenticMode: true })

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

    describe('postMessage origin check regression (P389799154)', () => {
        // Regression tests for the same-origin guard in handleInboundMessage.
        // The guard prevents cross-origin XSS via crafted postMessage events.

        const foreignOrigins = [
            'https://attacker.example.com',
            'http://evil.localhost',
            'https://phishing.internal.corp',
        ]

        // Commands that exercise different switch branches in handleInboundMessage
        const commandPayloads = [
            { command: CHAT_REQUEST_METHOD, tabId: 'tab-1', params: { body: 'injected' } },
            { command: SEND_TO_PROMPT, params: { prompt: 'injected' } },
            { command: ERROR_MESSAGE, params: { tabId: 'tab-1' } },
            { command: GENERIC_COMMAND, params: { genericCommand: 'Fix', selection: 'x', triggerType: 'click' } },
            { command: CHAT_OPTIONS, params: { history: true, export: true } },
            {
                command: OPEN_TAB_REQUEST_METHOD,
                params: { newTabOptions: { data: { messages: [] } } },
                requestId: 'r1',
            },
        ]

        describe('rejects foreign-origin messages across command types', () => {
            commandPayloads.forEach(payload => {
                it(`drops ${payload.command} from a foreign origin`, () => {
                    clientApi.postMessage.resetHistory()

                    const foreignEvent = new window.MessageEvent('message', {
                        data: payload,
                        origin: 'https://attacker.example.com',
                    })
                    window.dispatchEvent(foreignEvent)

                    // The rejection path emits a telemetry event
                    // (chatPostMessageRejected) but must NOT process the
                    // command payload itself.
                    clientApi.postMessage.getCalls().forEach(call => {
                        const msg = call.args[0]
                        // Every call should be the rejection telemetry, not
                        // the payload's command being dispatched.
                        sinon.assert.match(msg, {
                            command: TELEMETRY,
                            params: sinon.match({ name: 'chatPostMessageRejected' }),
                        })
                    })
                })
            })
        })

        describe('rejects messages from various untrusted origins', () => {
            foreignOrigins.forEach(origin => {
                it(`rejects origin "${origin}"`, () => {
                    clientApi.postMessage.resetHistory()

                    const event = new window.MessageEvent('message', {
                        data: { command: SEND_TO_PROMPT, params: { prompt: 'pwn' } },
                        origin,
                    })
                    window.dispatchEvent(event)

                    // Only rejection telemetry should fire, not the SEND_TO_PROMPT handler
                    clientApi.postMessage.getCalls().forEach(call => {
                        const msg = call.args[0]
                        sinon.assert.match(msg, {
                            command: TELEMETRY,
                            params: sinon.match({ name: 'chatPostMessageRejected' }),
                        })
                    })
                })
            })
        })

        describe('same-origin messages are processed normally', () => {
            it('processes SEND_TO_PROMPT from same origin', () => {
                clientApi.postMessage.resetHistory()

                const event = new window.MessageEvent('message', {
                    data: { command: SEND_TO_PROMPT, params: { prompt: 'hello' } },
                    origin: window.location.origin,
                })
                window.dispatchEvent(event)

                // SEND_TO_PROMPT triggers a telemetry event — proves the handler ran
                assert.called(clientApi.postMessage)
            })

            it('processes CHAT_REQUEST_METHOD from same origin', () => {
                const endMessageStreamStub = sandbox.stub(mynahUi, 'endMessageStream')

                const event = new window.MessageEvent('message', {
                    data: { command: CHAT_REQUEST_METHOD, tabId: 'tab-1', params: { body: 'hi' } },
                    origin: window.location.origin,
                })
                window.dispatchEvent(event)

                assert.calledOnce(endMessageStreamStub)
            })

            it('processes OPEN_TAB_REQUEST_METHOD from same origin', () => {
                clientApi.postMessage.resetHistory()

                const requestId = 'origin-test-req'
                const event = new window.MessageEvent('message', {
                    data: {
                        command: OPEN_TAB_REQUEST_METHOD,
                        params: { newTabOptions: { data: { messages: [] } } },
                        requestId,
                    },
                    origin: window.location.origin,
                })
                window.dispatchEvent(event)

                assert.calledWithMatch(clientApi.postMessage, {
                    requestId,
                    command: OPEN_TAB_REQUEST_METHOD,
                    params: { success: true },
                })
            })
        })

        describe('rejection is observable without throwing', () => {
            it('logs console.warn for foreign-origin messages', () => {
                const warnStub = sandbox.stub(console, 'warn')

                const foreignEvent = new window.MessageEvent('message', {
                    data: { command: SEND_TO_PROMPT, params: { prompt: 'pwn' } },
                    origin: 'https://attacker.example.com',
                })
                window.dispatchEvent(foreignEvent)

                assert.called(warnStub)
                assert.calledWithMatch(
                    warnStub,
                    'Chat client rejected message from untrusted origin:',
                    'https://attacker.example.com'
                )
            })

            it('does not throw on foreign-origin messages', () => {
                // Verify the handler gracefully returns without exceptions
                const foreignEvent = new window.MessageEvent('message', {
                    data: { command: CHAT_REQUEST_METHOD, tabId: 'tab-1', params: { body: 'x' } },
                    origin: 'https://attacker.example.com',
                })

                // dispatchEvent is synchronous — any throw would propagate here
                window.dispatchEvent(foreignEvent)
                // If we reach this line, no exception was thrown
            })

            it('does not log a warning for same-origin messages', () => {
                const warnStub = sandbox.stub(console, 'warn')

                const event = new window.MessageEvent('message', {
                    data: { command: SEND_TO_PROMPT, params: { prompt: 'hello' } },
                    origin: window.location.origin,
                })
                window.dispatchEvent(event)

                // The warn should NOT fire for same-origin traffic
                sinon.assert.neverCalledWithMatch(warnStub, 'Chat client rejected message from untrusted origin:')
            })
        })
    })
})

/**
 * Origin-validation coverage for `handleInboundMessage` across every supported IDE host.
 * Extends the Eclipse regression tests from #2740 to the full host matrix so a future
 * origin-validation change cannot silently break a single host environment (e.g. Eclipse on
 * Windows, aws/amazon-q-eclipse#555). `HOST_ORIGIN_CASES` is the executable form of the
 * "Host environments" table in chat-client/README.md; keep the two in lockstep.
 *
 * The check accepts a message when `event.origin` is non-HTTP (vscode-webview://, file://,
 * "", "null") OR is an HTTP origin equal to `window.location.origin`, and rejects it only
 * when `event.origin` is an HTTP(S) origin *different* from the page. So the accept/reject
 * outcome is a function of (pageOrigin, eventOrigin) — which is why each case sets both, and
 * why every case runs in its own JSDOM at that pageOrigin (the shared about:blank harness
 * reports origin "null", under which the same-origin HTTP hosts would pass without ever
 * exercising the `origin === window.location.origin` comparison the check hinges on). One
 * reject case deliberately uses an opaque ("null") page origin to model Eclipse/Windows and
 * prove an attacker is still rejected on the very host the origin fix was written for.
 *
 * Each accepted case asserts positively that the message cleared the origin gate and reached
 * the command router (the unknown-command telemetry fires once), not merely that it was not
 * rejected — so a regression that silently swallowed messages would still fail.
 */
describe('Chat handleInboundMessage origin validation across host environments', () => {
    const sandbox = sinon.createSandbox()
    let savedGlobals: { window: typeof global.window; document: typeof global.document; self: typeof global.self }
    let activeDom: JSDOM | undefined

    interface HostOriginCase {
        host: string
        pageOrigin: string // window.location.origin the chat client renders under
        eventOrigin: string // event.origin on the inbound postMessage
        accepted: boolean
    }

    const HOST_ORIGIN_CASES: HostOriginCase[] = [
        {
            host: 'VS Code (vscode-webview://)',
            pageOrigin: 'https://toolkitasset',
            eventOrigin: 'vscode-webview://abc123',
            accepted: true,
        },
        {
            host: 'JetBrains (https://toolkitasset)',
            pageOrigin: 'https://toolkitasset',
            eventOrigin: 'https://toolkitasset',
            accepted: true,
        },
        {
            host: 'Visual Studio (WebView2, same-origin)',
            pageOrigin: 'https://visualstudiowebview',
            eventOrigin: 'https://visualstudiowebview',
            accepted: true,
        },
        {
            host: 'Eclipse/Windows (WebView2, empty origin)',
            pageOrigin: 'https://toolkitasset',
            eventOrigin: '',
            accepted: true,
        },
        {
            host: 'Eclipse/Windows (WebView2, "null" origin)',
            pageOrigin: 'https://toolkitasset',
            eventOrigin: 'null',
            accepted: true,
        },
        {
            host: 'Eclipse/macOS-Linux (WebKit, same-origin)',
            pageOrigin: 'http://localhost:8137',
            eventOrigin: 'http://localhost:8137',
            accepted: true,
        },
        {
            host: 'SageMaker JupyterLab (same-origin)',
            pageOrigin: 'https://abc.studio.us-east-1.sagemaker.aws',
            eventOrigin: 'https://abc.studio.us-east-1.sagemaker.aws',
            accepted: true,
        },
        {
            host: 'file:// (sandboxed/opaque context)',
            pageOrigin: 'https://toolkitasset',
            eventOrigin: 'file://',
            accepted: true,
        },
        // The cross-origin check enforcement: a foreign HTTP(S) origin delivered to a legitimate
        // host page must be rejected (Bug Bounty P389799154). These are the only rows that
        // exercise the `origin !== window.location.origin` branch.
        {
            host: 'cross-origin HTTP(S) attacker page',
            pageOrigin: 'https://toolkitasset',
            eventOrigin: 'https://attacker.example.com',
            accepted: false,
        },
        {
            host: 'same-host different-origin (subdomain) page',
            pageOrigin: 'https://toolkitasset',
            eventOrigin: 'https://evil.toolkitasset',
            accepted: false,
        },
        // The security dual of the "Eclipse/Windows accepts empty origin" case above, and the one
        // that guards the incident host itself: when the page origin is opaque ("null"), a real
        // cross-origin attacker must STILL be rejected. A refactor that only enforced the check on
        // http(s) pages would silently disable it here (the empty/"null" origins are indistinguishable
        // from an opaque page unless the attacker's http(s) origin is compared regardless of page).
        {
            host: 'cross-origin attacker on an opaque-origin host page (Eclipse/Windows)',
            pageOrigin: 'null',
            eventOrigin: 'https://attacker.example.com',
            accepted: false,
        },
    ]

    // Point the globals the chat client reads at a fresh JSDOM served from `pageOrigin`, so the
    // message handler createChat registers closes over that origin. Mirrors injectJSDOM()'s setup.
    // A `pageOrigin` of 'null' models an opaque host origin (Eclipse/Windows, whose
    // Browser.setText()-injected page reports origin "null"); about:blank is the URL that yields it.
    function loadHostDom(pageOrigin: string): JSDOM {
        const url = pageOrigin === 'null' ? 'about:blank' : `${pageOrigin}/`
        const dom = new JSDOM('', { url, pretendToBeVisual: true })
        global.window = dom.window as unknown as Window & typeof globalThis
        global.document = dom.window.document
        global.self = dom.window as unknown as Window & typeof globalThis
        global.CustomEvent = dom.window.CustomEvent
        global.Image = dom.window.Image
        global.FileReader = dom.window.FileReader
        Object.defineProperty(dom.window.Element.prototype, 'innerText', {
            configurable: true,
            get() {
                return this.textContent
            },
        })
        global.structuredClone = val => JSON.parse(JSON.stringify(val))
        return dom
    }

    before(() => {
        // @ts-expect-error: mock implementation for testing
        global.ResizeObserver = null
        // @ts-expect-error: mock implementation for testing
        global.IntersectionObserver = null
        // @ts-expect-error: mock implementation for testing
        global.MutationObserver = null
    })

    beforeEach(() => {
        savedGlobals = { window: global.window, document: global.document, self: global.self }
        sandbox.stub(TabFactory, 'generateUniqueId').returns('tab-1')
        sandbox.stub(TabFactory.prototype, 'enableHistory')
        sandbox.stub(TabFactory.prototype, 'enableExport')
    })

    afterEach(() => {
        sandbox.restore()
        // Tear down this case's JSDOM (stops its timers/observers) so state does not accumulate
        // across the shared global window — the mynah-ui state-leak class from #2741 / #2746.
        activeDom?.window.close()
        activeDom = undefined
        // Restore the shared globals loadHostDom() swapped out.
        global.window = savedGlobals.window
        global.document = savedGlobals.document
        global.self = savedGlobals.self
    })

    HOST_ORIGIN_CASES.forEach(({ host, pageOrigin, eventOrigin, accepted }) => {
        it(`${accepted ? 'accepts' : 'rejects'} messages from ${host}`, () => {
            const dom = loadHostDom(pageOrigin)
            activeDom = dom
            const clientApi = { postMessage: sandbox.stub() as sinon.SinonStub }
            createChat(clientApi as any, { agenticMode: true })
            clientApi.postMessage.resetHistory() // drop the init messages (ready/tab-add/etc.)
            const warnStub = sandbox.stub(console, 'warn')

            // Unknown command so the accepted path stays out of mynah-ui DOM code (see #2741) while
            // still flowing all the way through the origin gate into the command router.
            const command = 'noop-test-command'
            dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { command }, origin: eventOrigin }))

            if (accepted) {
                // Passing the origin gate is asserted positively, not just as an absence: the message
                // reaches the command router, whose default case reports the unknown command exactly
                // once. An origin regression that silently swallowed the message (returned without a
                // warning) would fail this — a bare `neverCalled(untrustedOrigin)` would not.
                assert.notCalled(warnStub)
                assert.calledOnceWithExactly(clientApi.postMessage, {
                    command: TELEMETRY,
                    params: {
                        name: CHAT_POST_MESSAGE_REJECTED_TELEMETRY_EVENT,
                        reason: 'unknownCommand',
                        command,
                        tabId: undefined,
                    },
                })
            } else {
                // Rejected at the origin gate: the warning fires and the drop is recorded once as an
                // untrustedOrigin event; the command never reaches the router (reason is not unknownCommand).
                assert.called(warnStub)
                assert.calledOnceWithExactly(clientApi.postMessage, {
                    command: TELEMETRY,
                    params: {
                        name: CHAT_POST_MESSAGE_REJECTED_TELEMETRY_EVENT,
                        reason: 'untrustedOrigin',
                        command: undefined,
                        tabId: undefined,
                    },
                })
            }
        })
    })
})
