import { afterEach } from 'mocha'
import * as sinon from 'sinon'
import { assert } from 'sinon'
import {
    createMynahUi,
    InboundChatApi,
    handleChatPrompt,
    DEFAULT_HELP_PROMPT,
    handlePromptInputChange,
    uiComponentsTexts,
} from './mynahUi'
import { Messager, OutboundChatApi } from './messager'
import { TabFactory } from './tabs/tabFactory'
import { ChatItemType, MynahUI, NotificationType } from '@aws/mynah-ui'
import { ChatClientAdapter } from '../contracts/chatClientAdapter'
import { ChatMessage, ContextCommand, ListAvailableModelsResult } from '@aws/language-server-runtimes-types'
import { ChatHistory } from './features/history'
import { pairProgrammingModeOn, pairProgrammingModeOff } from './texts/pairProgramming'
import { strictEqual } from 'assert'

describe('MynahUI', function () {
    /**
     * These tests drive the real MynahUI against jsdom, so creating a tab performs several
     * hundred milliseconds of synchronous DOM work -- up to ~1.8s for the sendGenericCommand
     * cases on an idle developer machine. Mocha reports a synchronous test that overruns its
     * budget as "Timeout of Nms exceeded", so on a loaded CI runner (measured 4.6-7x slower)
     * the default 5s budget is exceeded and the suite fails on whichever test is unlucky.
     * One generous budget for the whole suite replaces the per-test 10s/30s patches that
     * were added for the same reason.
     */
    this.timeout(30_000)

    let messager: Messager
    let mynahUi: MynahUI
    let inboundChatApi: InboundChatApi
    let outboundChatApi: OutboundChatApi

    let getSelectedTabIdStub: sinon.SinonStub
    let createTabStub: sinon.SinonStub
    let getChatItemsStub: sinon.SinonStub
    let getAllTabsStub: sinon.SinonStub
    let updateStoreSpy: sinon.SinonSpy
    let addChatItemSpy: sinon.SinonSpy
    let onChatPromptSpy: sinon.SinonSpy
    let onQuickActionSpy: sinon.SinonSpy
    let onOpenTabSpy: sinon.SinonSpy
    let selectTabSpy: sinon.SinonSpy
    let serializeChatStub: sinon.SinonStub
    let notifySpy: sinon.SinonSpy
    const requestId = '1234'

    beforeEach(() => {
        outboundChatApi = {
            sendChatPrompt: sinon.stub(),
            sendQuickActionCommand: sinon.stub(),
            tabAdded: sinon.stub(),
            tabChanged: sinon.stub(),
            tabRemoved: sinon.stub(),
            telemetry: sinon.stub(),
            insertToCursorPosition: sinon.stub(),
            copyToClipboard: sinon.stub(),
            authFollowUpClicked: sinon.stub(),
            followUpClicked: sinon.stub(),
            sendFeedback: sinon.stub(),
            linkClick: sinon.stub(),
            sourceLinkClick: sinon.stub(),
            infoLinkClick: sinon.stub(),
            uiReady: sinon.stub(),
            disclaimerAcknowledged: sinon.stub(),
            chatPromptOptionAcknowledged: sinon.stub(),
            onOpenTab: sinon.stub(),
            createPrompt: sinon.stub(),
            fileClick: sinon.stub(),
            listConversations: sinon.stub(),
            conversationClick: sinon.stub(),
            listMcpServers: sinon.stub(),
            mcpServerClick: sinon.stub(),
            tabBarAction: sinon.stub(),
            onGetSerializedChat: sinon.stub(),
            promptInputOptionChange: sinon.stub(),
            promptInputButtonClick: sinon.stub(),
            stopChatResponse: sinon.stub(),
            sendButtonClickEvent: sinon.stub(),
            onOpenSettings: sinon.stub(),
            onRuleClick: sinon.stub(),
            listRules: sinon.stub(),
            onAddPinnedContext: sinon.stub(),
            onRemovePinnedContext: sinon.stub(),
            onListAvailableModels: sinon.stub(),
            onOpenFileDialogClick: sinon.stub(),
            onFilesDropped: sinon.stub(),
            filterContextCommands: sinon.stub(),
        }

        messager = new Messager(outboundChatApi)
        onChatPromptSpy = sinon.spy(messager, 'onChatPrompt')
        onQuickActionSpy = sinon.spy(messager, 'onQuickActionCommand')
        onOpenTabSpy = sinon.spy(messager, 'onOpenTab')

        const tabFactory = new TabFactory({})
        createTabStub = sinon.stub(tabFactory, 'createTab')
        createTabStub.returns({})
        getChatItemsStub = sinon.stub(tabFactory, 'getChatItems')
        getChatItemsStub.returns([])
        const mynahUiResult = createMynahUi(messager, tabFactory, true, true, undefined, undefined, true)
        mynahUi = mynahUiResult[0]
        inboundChatApi = mynahUiResult[1]
        getSelectedTabIdStub = sinon.stub(mynahUi, 'getSelectedTabId')
        getAllTabsStub = sinon.stub(mynahUi, 'getAllTabs').returns({})
        updateStoreSpy = sinon.spy(mynahUi, 'updateStore')
        addChatItemSpy = sinon.spy(mynahUi, 'addChatItem')
        selectTabSpy = sinon.spy(mynahUi, 'selectTab')
        serializeChatStub = sinon.stub(mynahUi, 'serializeChat')
        notifySpy = sinon.spy(mynahUi, 'notify')
    })

    afterEach(() => {
        sinon.restore()

        Object.keys(mynahUi.getAllTabs()).forEach(tabId => {
            mynahUi.removeTab(tabId, (mynahUi as any).lastEventId)
        })
    })

    describe('handleChatPrompt', () => {
        it('should handle normal chat prompt', () => {
            const tabId = 'tab-1'
            const prompt = { prompt: 'Test prompt', escapedPrompt: 'Test prompt' }

            handleChatPrompt(mynahUi, tabId, prompt, messager, undefined, undefined, true)

            assert.notCalled(onQuickActionSpy)
            assert.calledWith(onChatPromptSpy, { prompt, tabId, context: undefined })
            assert.calledWith(addChatItemSpy, tabId, { type: ChatItemType.PROMPT, body: prompt.escapedPrompt })
            assert.calledWith(updateStoreSpy, tabId, {
                loadingChat: true,
                promptInputDisabledState: false,
                cancelButtonWhenLoading: true,
            })
            assert.calledWith(addChatItemSpy, tabId, { type: ChatItemType.ANSWER_STREAM })
        })

        it('should handle clear quick action', () => {
            const tabId = 'tab-1'
            const prompt = { prompt: 'Test prompt', escapedPrompt: 'Test prompt', command: '/clear' }

            handleChatPrompt(mynahUi, tabId, prompt, messager)

            assert.notCalled(onChatPromptSpy)
            assert.calledWith(onQuickActionSpy, { quickAction: prompt.command, prompt: prompt.prompt, tabId })
            assert.calledOnce(updateStoreSpy)
            assert.calledWith(updateStoreSpy.firstCall, tabId, { chatItems: [] })
        })

        it('should handle quick actions', () => {
            const tabId = 'tab-1'
            const prompt = { prompt: 'Test prompt', escapedPrompt: 'Test prompt', command: '/help' }

            handleChatPrompt(mynahUi, tabId, prompt, messager, undefined, undefined, true)

            assert.notCalled(onChatPromptSpy)
            assert.calledWith(onQuickActionSpy, {
                quickAction: prompt.command,
                prompt: DEFAULT_HELP_PROMPT,
                tabId,
            })
            assert.calledOnce(updateStoreSpy)
            assert.calledWith(updateStoreSpy, tabId, {
                loadingChat: true,
                promptInputDisabledState: false,
                cancelButtonWhenLoading: true,
            })
        })
    })

    describe('openTab', () => {
        it('should create a new tab with welcome messages if tabId not passed and previous messages not passed', () => {
            createTabStub.resetHistory()
            getChatItemsStub.resetHistory()

            inboundChatApi.openTab(requestId, {})

            sinon.assert.calledOnceWithExactly(createTabStub, false)
            sinon.assert.calledOnceWithExactly(getChatItemsStub, true, false, undefined)
            sinon.assert.notCalled(selectTabSpy)
            sinon.assert.calledOnce(onOpenTabSpy)
        })

        it('should create a new tab with messages if tabId is not passed and previous messages are passed', () => {
            const mockMessages: ChatMessage[] = [
                {
                    messageId: 'msg1',
                    body: 'Test message 1',
                    type: ChatItemType.PROMPT,
                },
                {
                    messageId: 'msg2',
                    body: 'Test message 2',
                    type: ChatItemType.ANSWER,
                },
            ]

            createTabStub.resetHistory()
            getChatItemsStub.resetHistory()

            inboundChatApi.openTab(requestId, {
                newTabOptions: {
                    data: {
                        messages: mockMessages,
                    },
                },
            })

            sinon.assert.calledOnceWithExactly(createTabStub, false)
            sinon.assert.calledOnceWithExactly(getChatItemsStub, false, false, mockMessages)
            sinon.assert.notCalled(selectTabSpy)
            sinon.assert.calledOnce(onOpenTabSpy)
        })

        it('should call onOpenTab if a new tab if tabId not passed and tab not created', () => {
            createTabStub.resetHistory()
            getChatItemsStub.resetHistory()
            updateStoreSpy.restore()
            sinon.stub(mynahUi, 'updateStore').returns(undefined)

            inboundChatApi.openTab(requestId, {})

            sinon.assert.calledOnceWithExactly(createTabStub, false)
            sinon.assert.notCalled(selectTabSpy)
            sinon.assert.calledOnceWithMatch(onOpenTabSpy, requestId, { type: 'InvalidRequest' })
        })

        it('should open existing tab if tabId passed and tabId not selected', () => {
            createTabStub.resetHistory()

            getSelectedTabIdStub.returns('1')
            const tabId = '2'

            inboundChatApi.openTab(requestId, { tabId })

            sinon.assert.notCalled(createTabStub)
            sinon.assert.calledOnceWithExactly(selectTabSpy, tabId)
            sinon.assert.calledOnceWithExactly(onOpenTabSpy, requestId, { tabId })
        })

        it('should not open existing tab if tabId passed but tabId already selected', () => {
            createTabStub.resetHistory()

            const tabId = '1'
            getSelectedTabIdStub.returns(tabId)

            inboundChatApi.openTab(requestId, { tabId })

            sinon.assert.notCalled(createTabStub)
            sinon.assert.notCalled(selectTabSpy)
            sinon.assert.calledOnceWithExactly(onOpenTabSpy, requestId, { tabId })
        })
    })

    describe('sendGenericCommand', () => {
        it('should create a new tab if none exits', function () {
            // clear create tab stub since set up process calls it twice
            createTabStub.resetHistory()
            // Stub setTimeout to execute immediately
            const setTimeoutStub = sinon.stub(global, 'setTimeout').callsFake((fn: Function) => {
                fn()
                return {} as any
            })

            const genericCommand = 'Explain'
            const selection = 'const x = 5;'
            const tabId = ''
            const triggerType = 'click'
            getSelectedTabIdStub.returns(undefined)
            inboundChatApi.sendGenericCommand({ genericCommand, selection, tabId, triggerType })

            sinon.assert.calledOnceWithExactly(createTabStub, false)
            // updateStore is called four times for a brand new tab:
            //   1. onTabAdd seeds the tab (chatItems + welcome tabHeaderDetails)
            //   2. handleChatPrompt clears the welcome splash before the first prompt
            //   3. handleChatPrompt sets loadingChat / cancelButton state
            //   4. handleChatPrompt resets disabled state once streaming begins
            sinon.assert.callCount(updateStoreSpy, 4)
            setTimeoutStub.restore()
        })

        it('should create a new tab if current tab is loading', function () {
            // clear create tab stub since set up process calls it twice
            createTabStub.resetHistory()
            // Stub setTimeout to execute immediately
            const setTimeoutStub = sinon.stub(global, 'setTimeout').callsFake((fn: Function) => {
                fn()
                return {} as any
            })
            getAllTabsStub.returns({ 'tab-1': { store: { loadingChat: true } } })

            const genericCommand = 'Explain'
            const selection = 'const x = 5;'
            const tabId = 'tab-1'
            const triggerType = 'click'
            getSelectedTabIdStub.returns(tabId)
            inboundChatApi.sendGenericCommand({ genericCommand, selection, tabId, triggerType })

            sinon.assert.calledOnceWithExactly(createTabStub, false)
            // See note above on the four updateStore calls.
            sinon.assert.callCount(updateStoreSpy, 4)
            setTimeoutStub.restore()
        })

        it('should not create a new tab if one exists already', () => {
            createTabStub.resetHistory()
            // Stub setTimeout to execute immediately
            const setTimeoutStub = sinon.stub(global, 'setTimeout').callsFake((fn: Function) => {
                fn()
                return {} as any
            })
            const genericCommand = 'Explain'
            const selection = 'const x = 5;'
            const tabId = 'tab-1'
            const triggerType = 'click'
            getSelectedTabIdStub.returns(tabId)
            inboundChatApi.sendGenericCommand({ genericCommand, selection, tabId, triggerType })

            sinon.assert.notCalled(createTabStub)
            sinon.assert.calledOnce(updateStoreSpy)
            setTimeoutStub.restore()
        })

        it('should call handleChatPrompt when sendGenericCommand is called', () => {
            // Stub setTimeout to execute immediately
            const setTimeoutStub = sinon.stub(global, 'setTimeout').callsFake((fn: Function) => {
                fn()
                return {} as any
            })
            const genericCommand = 'Explain'
            const selection = 'const x = 5;'
            const tabId = 'tab-1'
            const triggerType = 'click'
            const expectedPrompt = `${genericCommand} the following part of my code:\n~~~~\n${selection}\n~~~~\n`

            getSelectedTabIdStub.returns(tabId)

            inboundChatApi.sendGenericCommand({ genericCommand, selection, tabId, triggerType })

            assert.calledOnceWithMatch(onChatPromptSpy, {
                prompt: { prompt: expectedPrompt, escapedPrompt: expectedPrompt },
            })

            sinon.assert.calledTwice(addChatItemSpy)

            sinon.assert.calledWithMatch(addChatItemSpy.firstCall, tabId, {
                type: ChatItemType.PROMPT,
                body: expectedPrompt,
            })

            sinon.assert.calledWithMatch(addChatItemSpy.secondCall, tabId, {
                type: ChatItemType.ANSWER_STREAM,
            })

            sinon.assert.calledOnceWithMatch(updateStoreSpy, tabId, {
                loadingChat: true,
                promptInputDisabledState: false,
            })
            setTimeoutStub.restore()
        })
    })

    describe('onTabBarButtonClick', () => {
        it('should list conversations when Chat History button is clicked', () => {
            const listConversationsSpy = sinon.spy(messager, 'onListConversations')

            // @ts-ignore
            mynahUi.props.onTabBarButtonClick('tab-123', ChatHistory.TabBarButtonId)

            sinon.assert.calledOnce(listConversationsSpy)
        })

        it('should export conversation when Export button is clicked', () => {
            const listConversationsSpy = sinon.spy(messager, 'onTabBarAction')

            // @ts-ignore
            mynahUi.props.onTabBarButtonClick('tab-123', 'export')

            sinon.assert.calledOnceWithExactly(listConversationsSpy, {
                tabId: 'tab-123',
                action: 'export',
            })
        })
    })

    describe('conversationClicked result', () => {
        it('should list conversations if successfully deleted conversation', () => {
            const listConversationsSpy = sinon.spy(messager, 'onListConversations')

            // Successful conversation deletion
            inboundChatApi.conversationClicked({
                success: true,
                action: 'delete',
                id: 'test-conversation-id',
            })

            sinon.assert.calledOnce(listConversationsSpy)
        })
        it('should not list conversarions if conversartion click processing failed', () => {
            const listConversationsSpy = sinon.spy(messager, 'onListConversations')

            // Unsuccessful conversation deletion
            inboundChatApi.conversationClicked({
                success: false,
                action: 'delete',
                id: 'test-conversation-id',
            })

            sinon.assert.neverCalledWith(listConversationsSpy)
        })
    })

    describe('handlePromptInputChange', () => {
        it('should add pairProgrammingModeOn message when switching from off to on', () => {
            const tabId = 'tab-1'
            const getTabDataStub = sinon.stub(mynahUi, 'getTabData')
            getTabDataStub.returns({
                getStore: () => ({
                    // @ts-expect-error partial object
                    promptInputOptions: [{ id: 'pair-programmer-mode', value: 'false' }],
                }),
            })

            handlePromptInputChange(mynahUi, tabId, { 'pair-programmer-mode': 'true' })

            sinon.assert.calledWith(addChatItemSpy, tabId, pairProgrammingModeOn)
        })

        it('should add pairProgrammingModeOff message when switching from on to off', () => {
            const tabId = 'tab-1'
            const getTabDataStub = sinon.stub(mynahUi, 'getTabData')
            getTabDataStub.returns({
                getStore: () => ({
                    // @ts-expect-error partial object
                    promptInputOptions: [{ id: 'pair-programmer-mode', value: 'true' }],
                }),
            })

            handlePromptInputChange(mynahUi, tabId, { 'pair-programmer-mode': 'false' })

            sinon.assert.calledWith(addChatItemSpy, tabId, pairProgrammingModeOff)
        })

        it('should not add any message when pair programming mode is not changed', () => {
            const tabId = 'tab-1'
            const getTabDataStub = sinon.stub(mynahUi, 'getTabData')
            getTabDataStub.returns({
                getStore: () => ({
                    // @ts-expect-error partial object
                    promptInputOptions: [{ id: 'pair-programmer-mode', value: 'true' }],
                }),
            })

            addChatItemSpy.resetHistory()
            handlePromptInputChange(mynahUi, tabId, { 'pair-programmer-mode': 'true' })

            sinon.assert.notCalled(addChatItemSpy)
        })

        it('should update all promptInputOptions with new values', () => {
            const tabId = 'tab-1'
            const promptInputOptions = [
                { id: 'pair-programmer-mode', value: 'true' },
                { id: 'model-selection', value: 'auto' },
            ]
            const getTabDataStub = sinon.stub(mynahUi, 'getTabData')
            getTabDataStub.returns({
                getStore: () => ({
                    // @ts-expect-error partial object
                    promptInputOptions,
                }),
            })

            const newValues = {
                'pair-programmer-mode': 'true',
                'model-selection': 'CLAUDE_3_7_SONNET_20250219_V1_0',
            }

            handlePromptInputChange(mynahUi, tabId, newValues)

            const expectedOptions = [
                { id: 'pair-programmer-mode', value: 'true' },
                { id: 'model-selection', value: 'CLAUDE_3_7_SONNET_20250219_V1_0' },
            ]

            sinon.assert.calledWith(updateStoreSpy, tabId, {
                promptInputOptions: expectedOptions,
            })
        })

        it('should add model selection notification when model is changed', () => {
            const tabId = 'tab-1'
            const modelOptions = [
                { value: 'CLAUDE_3_7_SONNET_20250219_V1_0', label: 'Claude Sonnet 3.7' },
                { value: 'CLAUDE_SONNET_4_20250514_V1_0', label: 'Claude Sonnet 4' },
            ]
            const promptInputOptions = [
                {
                    id: 'model-selection',
                    type: 'select',
                    value: 'CLAUDE_3_7_SONNET_20250219_V1_0',
                    options: modelOptions,
                },
            ]

            const getTabDataStub = sinon.stub(mynahUi, 'getTabData')
            getTabDataStub.returns({
                getStore: () => ({
                    // @ts-expect-error partial object
                    promptInputOptions,
                }),
            })

            // Reset addChatItem spy to track new calls
            addChatItemSpy.resetHistory()

            // Change model from Claude 3.7 to Claude 4
            const newValues = {
                'model-selection': 'CLAUDE_SONNET_4_20250514_V1_0',
            }

            handlePromptInputChange(mynahUi, tabId, newValues)

            // Verify that a model selection notification was added
            sinon.assert.calledOnce(addChatItemSpy)
            sinon.assert.calledWithMatch(addChatItemSpy, tabId, {
                type: ChatItemType.DIRECTIVE,
                contentHorizontalAlignment: 'center',
                fullWidth: true,
                body: 'Switched model to Claude Sonnet 4',
            })
        })
    })

    describe('getSerializedChat', () => {
        it('should return serialized chat content for supported formats', () => {
            const onGetSerializedChatSpy = sinon.spy(messager, 'onGetSerializedChat')
            serializeChatStub.returns('Test Serialized Chat')

            inboundChatApi.getSerializedChat(requestId, {
                format: 'markdown',
                tabId: 'tab-1',
            })

            sinon.assert.calledWith(onGetSerializedChatSpy, requestId, { content: 'Test Serialized Chat' })
        })

        it('should show an error if requested format is not supported', () => {
            const onGetSerializedChatSpy = sinon.spy(messager, 'onGetSerializedChat')
            serializeChatStub.returns('Test Serialized Chat')

            inboundChatApi.getSerializedChat(requestId, {
                // @ts-ignore
                format: 'unsupported-format',
                tabId: 'tab-1',
            })

            sinon.assert.calledWith(onGetSerializedChatSpy, requestId, {
                type: 'InvalidRequest',
                message: 'Failed to get serialized chat content, unsupported-format is not supported',
            })
            sinon.assert.calledWith(notifySpy, {
                content: `Failed to export chat`,
                type: NotificationType.ERROR,
            })
        })
    })

    describe('listAvailableModels', () => {
        it('should update promptInputOptions with available models', () => {
            const tabId = 'tab-1'

            // Setup tab data with existing promptInputOptions
            const getTabDataStub = sinon.stub(mynahUi, 'getTabData')
            getTabDataStub.returns({
                getStore: () => ({
                    // @ts-expect-error partial object
                    promptInputOptions: [{ id: 'model-selection', options: [] }],
                }),
            })

            // Simulate the response from the server
            const models = [
                { id: 'CLAUDE_3_7_SONNET_20250219_V1_0', name: 'Claude Sonnet 3.7' },
                { id: 'CLAUDE_SONNET_4_20250514_V1_0', name: 'Claude Sonnet 4', description: 'Test description' },
            ]

            const result: ListAvailableModelsResult = {
                tabId,
                models,
                selectedModelId: 'CLAUDE_3_7_SONNET_20250219_V1_0',
            }

            // Call the listAvailableModels method
            inboundChatApi.listAvailableModels(result)

            // Verify updateStore was called with the correct options
            sinon.assert.calledWith(updateStoreSpy, tabId, {
                promptInputOptions: [
                    {
                        id: 'model-selection',
                        options: [
                            { value: 'CLAUDE_3_7_SONNET_20250219_V1_0', label: 'Claude Sonnet 3.7', description: '' },
                            {
                                value: 'CLAUDE_SONNET_4_20250514_V1_0',
                                label: 'Claude Sonnet 4',
                                description: 'Test description',
                            },
                        ],
                        type: 'select',
                        value: 'CLAUDE_3_7_SONNET_20250219_V1_0',
                    },
                ],
            })
        })
    })

    describe('sendPinnedContext', () => {
        it('should update UI with pinned context items', () => {
            const tabId = 'tab-1'
            const pinnedContextCommands = [
                {
                    id: 'pinned-file-1',
                    command: 'File 1',
                    label: 'file',
                    route: ['/workspace', 'src/file1.ts'],
                    icon: 'file',
                },
            ] as ContextCommand[]

            // Call sendPinnedContext with pinned context items
            inboundChatApi.sendPinnedContext({
                tabId,
                contextCommandGroups: [{ commands: pinnedContextCommands }],
                showRules: true,
            })

            // Verify updateStore was called with the correct parameters
            sinon.assert.calledWith(updateStoreSpy, tabId, {
                promptTopBarContextItems: [
                    {
                        id: 'pinned-file-1',
                        command: 'File 1',
                        label: 'file',
                        route: ['/workspace', 'src/file1.ts'],
                        icon: 'file',
                        children: undefined,
                        disabled: false,
                    },
                ],
                promptTopBarTitle: '@',
                promptTopBarButton: {
                    id: 'Rules',
                    status: 'clear',
                    text: 'Rules',
                    icon: 'check-list',
                },
            })
        })

        it('should show full title when no pinned context items exist', () => {
            const tabId = 'tab-1'

            // Call sendPinnedContext with empty context items
            inboundChatApi.sendPinnedContext({
                tabId,
                contextCommandGroups: [{ commands: [] }],
                showRules: false,
            })

            // Verify updateStore was called with the correct parameters
            sinon.assert.calledWith(updateStoreSpy, tabId, {
                promptTopBarContextItems: [],
                promptTopBarTitle: '@Pin Context',
                promptTopBarButton: null,
            })
        })

        it('should handle active editor context item', () => {
            const tabId = 'tab-1'
            const activeEditorCommand = {
                id: 'active-editor',
                command: 'Active file',
                label: 'file',
                icon: 'file',
                description: '',
            }

            // Call sendPinnedContext with active editor context
            inboundChatApi.sendPinnedContext({
                tabId,
                contextCommandGroups: [{ commands: [activeEditorCommand] as ContextCommand[] }],
                showRules: true,
                textDocument: { uri: 'file:///workspace/src/active.ts' },
            })

            // Verify updateStore was called with the correct parameters
            // Active editor description should be updated with the URI
            sinon.assert.calledWith(updateStoreSpy, tabId, {
                promptTopBarContextItems: [
                    {
                        ...activeEditorCommand,
                        description: 'file:///workspace/src/active.ts',
                        children: undefined,
                        disabled: false,
                    },
                ],
                promptTopBarTitle: '@Pin Context',
                promptTopBarButton: {
                    id: 'Rules',
                    status: 'clear',
                    text: 'Rules',
                    icon: 'check-list',
                },
            })
        })

        it('should remove active editor when no textDocument is provided', () => {
            const tabId = 'tab-1'
            const activeEditorCommand = {
                id: 'active-editor',
                command: 'Active file',
                label: 'file',
                icon: 'file',
            }

            const fileCommand = {
                id: 'pinned-file-1',
                command: 'File 1',
                label: 'file',
                route: ['/workspace', 'src/file1.ts'],
                icon: 'file',
            }

            // Call sendPinnedContext with active editor context but no textDocument
            inboundChatApi.sendPinnedContext({
                tabId,
                contextCommandGroups: [{ commands: [activeEditorCommand, fileCommand] as ContextCommand[] }],
                showRules: false,
            })

            // Verify updateStore was called with empty context items
            // Active editor should be removed since no textDocument was provided
            sinon.assert.calledWith(updateStoreSpy, tabId, {
                promptTopBarContextItems: [{ ...fileCommand, children: undefined, disabled: false }],
                promptTopBarTitle: '@',
                promptTopBarButton: null,
            })
        })
    })

    describe('stringOverrides', () => {
        it('should apply string overrides to config texts', () => {
            const stringOverrides = {
                spinnerText: 'Custom loading message...',
                stopGenerating: 'Custom stop text',
                showMore: 'Custom show more text',
            }

            const messager = new Messager(outboundChatApi)
            const tabFactory = new TabFactory({})
            const [customMynahUi] = createMynahUi(
                messager,
                tabFactory,
                true,
                true,
                undefined,
                undefined,
                true,
                stringOverrides
            )

            // Access the config texts from the instance
            const configTexts = (customMynahUi as any).props.config.texts

            // Verify that string overrides were applied and defaults are preserved
            strictEqual(configTexts.spinnerText, 'Custom loading message...')
            strictEqual(configTexts.stopGenerating, 'Custom stop text')
            strictEqual(configTexts.showMore, 'Custom show more text')
            strictEqual(configTexts.clickFileToViewDiff, uiComponentsTexts.clickFileToViewDiff)
        })
    })
})

describe('withAdapter', () => {
    let mynahUi: MynahUI
    let mynahUIRef: { mynahUI: MynahUI | undefined }
    let chatClientAdapter: ChatClientAdapter

    beforeEach(() => {
        // Set up chat client adapter
        chatClientAdapter = {
            createChatEventHandler: newMynahUIRef => {
                mynahUIRef = newMynahUIRef

                return {}
            },
            isSupportedTab: sinon.stub().callsFake(tabId => tabId === 'supported-tab'),
            isSupportedQuickAction: sinon.stub().callsFake(command => command === '/supported-command'),
            handleMessageReceive: sinon.stub(),
            handleQuickAction: sinon.stub(),
        }

        // @ts-ignore
        const messager: Partial<Messager> = new Messager({
            uiReady: sinon.stub(),
            tabAdded: sinon.stub(),
            telemetry: sinon.stub(),
            onListAvailableModels: sinon.stub(),
        } as OutboundChatApi)
        const tabFactory = new TabFactory({})
        const mynahUiResult = createMynahUi(
            messager as Messager,
            tabFactory,
            true,
            true,
            chatClientAdapter,
            undefined,
            true
        )
        mynahUi = mynahUiResult[0]
    })

    it('should instantiate and inject mynahUIRef to Adapter', () => {
        assert.match(mynahUIRef.mynahUI, mynahUi)
    })
})
