/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
    AuthFollowUpClickedParams,
    CopyCodeToClipboardParams,
    ErrorParams,
    GenericCommandParams,
    InsertToCursorPositionParams,
    SendToPromptParams,
    TriggerType,
    isValidAuthFollowUpType,
} from '@aws/chat-client-ui-types'
import {
    ButtonClickParams,
    ChatResult,
    ChatUpdateParams,
    ContextCommand,
    ContextCommandParams,
    ConversationClickResult,
    FeedbackParams,
    FollowUpClickParams,
    GetSerializedChatParams,
    InfoLinkClickParams,
    LinkClickParams,
    ListConversationsResult,
    ListRulesResult,
    ListMcpServersResult,
    McpServerClickResult,
    OPEN_WORKSPACE_INDEX_SETTINGS_BUTTON_ID,
    OpenFileDialogParams,
    OpenFileDialogResult,
    OpenTabParams,
    PinnedContextParams,
    RuleClickResult,
    SourceLinkClickParams,
    ListAvailableModelsResult,
    FilterContextCommandsResult,
    ExecuteShellCommandParams,
} from '@aws/language-server-runtimes-types'
import {
    ChatItem,
    ChatItemType,
    ChatPrompt,
    MynahUI,
    MynahUIDataModel,
    NotificationType,
    MynahUIProps,
    QuickActionCommand,
    MynahIcons,
    CustomQuickActionCommand,
    ConfigTexts,
} from '@aws/mynah-ui'
import { VoteParams } from '../contracts/telemetry'
import { Messager } from './messager'
import { McpMynahUi } from './mcpMynahUi'
import { ExportTabBarButtonId, ShowLogsTabBarButtonId, McpServerTabButtonId, TabFactory } from './tabs/tabFactory'
import { disclaimerAcknowledgeButtonId, disclaimerCard } from './texts/disclaimer'
import { ChatClientAdapter, ChatEventHandler } from '../contracts/chatClientAdapter'
import { withAdapter } from './withAdapter'
import {
    contextListToHeader,
    prepareChatItemFromMessage,
    toMynahButtons,
    toMynahContextCommand,
    toMynahFileList,
    toMynahHeader,
    toMynahIcon,
} from './utils'
import { ChatHistory, ChatHistoryList } from './features/history'
import { pairProgrammingModeOff, pairProgrammingModeOn, programmerModeCard } from './texts/pairProgramming'
import { deprecationCard } from './texts/deprecation'
import { ContextRule, RulesList } from './features/rules'
import { getModelSelectionChatItem, modelUnavailableBanner, modelThrottledBanner } from './texts/modelSelection'
import { getWelcomeTabHeader } from './texts/welcome'
import {
    freeTierLimitSticky,
    upgradeSuccessSticky,
    upgradePendingSticky,
    plansAndPricingTitle,
    freeTierLimitDirective,
} from './texts/paidTier'
import { isSupportedImageExtension, MAX_IMAGE_CONTEXT, verifyClientImages } from './imageVerification'

export interface InboundChatApi {
    addChatResponse(params: ChatResult, tabId: string, isPartialResult: boolean): void
    updateChat(params: ChatUpdateParams): void
    sendToPrompt(params: SendToPromptParams): void
    sendGenericCommand(params: GenericCommandParams): void
    showError(params: ErrorParams): void
    openTab(requestId: string, params: OpenTabParams): void
    sendContextCommands(params: ContextCommandParams): void
    listConversations(params: ListConversationsResult): void
    executeShellCommandShortCut(params: ExecuteShellCommandParams): void
    listRules(params: ListRulesResult): void
    conversationClicked(params: ConversationClickResult): void
    ruleClicked(params: RuleClickResult): void
    listMcpServers(params: ListMcpServersResult): void
    mcpServerClick(params: McpServerClickResult): void
    getSerializedChat(requestId: string, params: GetSerializedChatParams): void
    createTabId(openTab?: boolean): string | undefined
    addSelectedFilesToContext(params: OpenFileDialogParams): void
    sendPinnedContext(params: PinnedContextParams): void
    listAvailableModels(params: ListAvailableModelsResult): void
    filterContextCommandsResponse(params: FilterContextCommandsResult): void
}

type ContextCommandGroups = MynahUIDataModel['contextCommands']

const ContextPrompt = {
    CreateItemId: 'create-saved-prompt',
    CancelButtonId: 'cancel-create-prompt',
    SubmitButtonId: 'submit-create-prompt',
    PromptNameFieldId: 'prompt-name',
} as const

const getTabPromptInputValue = (mynahUi: MynahUI, tabId: string, optionId: string) => {
    const promptInputOptions = mynahUi.getTabData(tabId)?.getStore()?.promptInputOptions ?? []
    return promptInputOptions.find(item => item.id === optionId)?.value
}

const getTabPairProgrammingMode = (mynahUi: MynahUI, tabId: string) =>
    getTabPromptInputValue(mynahUi, tabId, 'pair-programmer-mode') === 'true'

const getTabModelSelection = (mynahUi: MynahUI, tabId: string) =>
    getTabPromptInputValue(mynahUi, tabId, 'model-selection')

export const handlePromptInputChange = (mynahUi: MynahUI, tabId: string, optionsValues: Record<string, string>) => {
    const previousPairProgrammerValue = getTabPairProgrammingMode(mynahUi, tabId)
    const currentPairProgrammerValue = optionsValues['pair-programmer-mode'] === 'true'

    if (currentPairProgrammerValue !== previousPairProgrammerValue) {
        mynahUi.addChatItem(tabId, currentPairProgrammerValue ? pairProgrammingModeOn : pairProgrammingModeOff)
    }

    const previousModelSelectionValue = getTabModelSelection(mynahUi, tabId)
    const currentModelSelectionValue = optionsValues['model-selection']

    const promptInputOptions = mynahUi.getTabData(tabId).getStore()?.promptInputOptions
    if (currentModelSelectionValue !== previousModelSelectionValue) {
        const modelSelectionPromptOption = promptInputOptions?.find(({ id }) => id === 'model-selection')
        if (modelSelectionPromptOption && modelSelectionPromptOption.type === 'select') {
            const selectedModelName = modelSelectionPromptOption.options?.find(
                ({ value }) => value === currentModelSelectionValue
            )?.label

            mynahUi.addChatItem(tabId, getModelSelectionChatItem(selectedModelName ?? currentModelSelectionValue))
        }
    }

    const updatedPromptInputOptions = promptInputOptions?.map(option => {
        option.value = optionsValues[option.id]
        return option
    })

    mynahUi.updateStore(tabId, {
        promptInputOptions: updatedPromptInputOptions,
    })

    // Store the updated values in tab defaults for new tabs
    mynahUi.updateTabDefaults({
        store: {
            promptInputOptions: updatedPromptInputOptions,
        },
    })
}

export const handleChatPrompt = (
    mynahUi: MynahUI,
    tabId: string,
    prompt: ChatPrompt,
    messager: Messager,
    triggerType?: TriggerType,
    _eventId?: string,
    agenticMode?: boolean,
    tabFactory?: TabFactory
) => {
    let userPrompt = prompt.escapedPrompt

    // Hide the welcome splash (tabHeaderDetails) once the user starts a
    // conversation so it does not sit above their messages. The guard is
    // important: mynah-ui's chat-wrapper re-runs a 750ms tab-mode-switch
    // animation on every tabHeaderDetails write, so writing null again on
    // every prompt would re-trigger that animation.
    if (mynahUi.getTabData(tabId)?.getStore()?.tabHeaderDetails != null) {
        mynahUi.updateStore(tabId, { tabHeaderDetails: null })
    }

    // Check if there's an ongoing request
    const isLoading = mynahUi.getTabData(tabId)?.getStore()?.loadingChat

    if (isLoading) {
        // Stop the current response
        messager.onStopChatResponse(tabId)

        // Add cancellation message BEFORE showing the new prompt
        mynahUi.addChatItem(tabId, {
            type: ChatItemType.DIRECTIVE,
            messageId: 'stopped' + Date.now(),
            body: 'You stopped your current work and asked me to work on the following task instead.',
        })

        // Reset loading state
        mynahUi.updateStore(tabId, {
            loadingChat: false,
            cancelButtonWhenLoading: true,
            promptInputDisabledState: false,
        })
    } else {
        // If no ongoing request, just send the stop signal
        messager.onStopChatResponse(tabId)
    }

    const commandsToReroute = ['/dev', '/test', '/doc', '/review']

    const isReroutedCommand =
        agenticMode && tabFactory?.isRerouteEnabled() && prompt.command && commandsToReroute.includes(prompt.command)

    if (prompt.command && !isReroutedCommand && prompt.command !== '/compact') {
        // Send /compact quick action as normal regular chat prompt
        // Handle non-rerouted commands (/clear, /help, /transform, /review) as quick actions
        // Temporary solution to handle clear quick actions on the client side
        if (prompt.command === '/clear') {
            mynahUi.updateStore(tabId, {
                chatItems: [],
            })
        } else if (prompt.command === '/help') {
            userPrompt = DEFAULT_HELP_PROMPT
        }

        // Send prompt when quick action command attached
        messager.onQuickActionCommand({
            quickAction: prompt.command,
            prompt: userPrompt,
            tabId,
        })

        if (prompt.command === '/clear') {
            return
        }
    } else {
        // Go agentic chat workflow when:
        // 1. Regular prompts without commands
        // 2. Rerouted commands (/dev, /test, /doc, /review) when feature flag: reroute is enabled

        // Special handling for /doc command - always send fixed prompt for fixed response
        if (isReroutedCommand && prompt.command === '/doc') {
            const context = prompt.context?.map(c => (typeof c === 'string' ? { command: c } : c))
            messager.onChatPrompt(
                {
                    prompt: { ...prompt, escapedPrompt: DEFAULT_DOC_PROMPT, prompt: DEFAULT_DOC_PROMPT },
                    tabId,
                    context,
                },
                triggerType
            )
        } else if (isReroutedCommand && (!userPrompt || userPrompt.trim() === '')) {
            // For /dev and /test commands, provide meaningful defaults if no additional text
            let defaultPrompt = userPrompt
            switch (prompt.command) {
                case '/dev':
                    defaultPrompt = DEFAULT_DEV_PROMPT
                    break
                case '/test':
                    defaultPrompt = DEFAULT_TEST_PROMPT
                    break
                case '/doc':
                    defaultPrompt = DEFAULT_DOC_PROMPT
                    break
                case '/review':
                    defaultPrompt = DEFAULT_REVIEW_PROMPT
                    break
            }

            // Send the updated prompt with default text to server
            const context = prompt.context?.map(c => (typeof c === 'string' ? { command: c } : c))
            messager.onChatPrompt(
                {
                    prompt: { ...prompt, escapedPrompt: defaultPrompt, prompt: defaultPrompt },
                    tabId,
                    context,
                },
                triggerType
            )
        } else {
            const context = prompt.context?.map(c => (typeof c === 'string' ? { command: c } : c))
            messager.onChatPrompt({ prompt, tabId, context }, triggerType)
        }
    }

    // For /doc command, don't show any prompt in UI
    const displayPrompt = isReroutedCommand && prompt.command === '/doc' ? '' : userPrompt
    initializeChatResponse(mynahUi, tabId, displayPrompt, agenticMode)
}

const initializeChatResponse = (mynahUi: MynahUI, tabId: string, userPrompt?: string, agenticMode?: boolean) => {
    mynahUi.addChatItem(tabId, {
        type: ChatItemType.PROMPT,
        body: userPrompt,
    })

    // Set UI to loading state
    if (agenticMode) {
        mynahUi.updateStore(tabId, {
            loadingChat: true,
            cancelButtonWhenLoading: true,
            promptInputDisabledState: false,
        })
    } else {
        mynahUi.updateStore(tabId, {
            loadingChat: true,
            promptInputDisabledState: true,
        })
    }

    // Create initial empty response
    mynahUi.addChatItem(tabId, {
        type: ChatItemType.ANSWER_STREAM,
    })
}

export const createMynahUi = (
    messager: Messager,
    tabFactory: TabFactory,
    disclaimerAcknowledged: boolean,
    pairProgrammingCardAcknowledged: boolean,
    deprecationNoticeAcknowledged: boolean,
    customChatClientAdapter?: ChatClientAdapter,
    featureConfig?: Map<string, any>,
    agenticMode?: boolean,
    stringOverrides?: Partial<ConfigTexts>,
    os?: string
): [MynahUI, InboundChatApi] => {
    let disclaimerCardActive = !disclaimerAcknowledged
    let programmingModeCardActive = !pairProgrammingCardAcknowledged
    let deprecationCardActive = !deprecationNoticeAcknowledged
    let contextCommandGroups: ContextCommandGroups | undefined
    let lastFilterTabId: string | undefined

    let chatEventHandlers: ChatEventHandler = {
        onCodeInsertToCursorPosition(
            tabId,
            messageId,
            code,
            type,
            referenceTrackerInformation,
            eventId,
            codeBlockIndex,
            totalCodeBlocks
        ) {
            const payload: InsertToCursorPositionParams = {
                tabId,
                messageId,
                code,
                type,
                referenceTrackerInformation,
                eventId,
                codeBlockIndex,
                totalCodeBlocks,
            }
            messager.onInsertToCursorPosition(payload)
        },
        onFocusStateChanged(focusState: boolean) {
            messager.onFocusStateChanged(focusState)
        },
        onFollowUpClicked(tabId, messageId, followUp, eventId) {
            if (followUp.type !== undefined && isValidAuthFollowUpType(followUp.type)) {
                const payload: AuthFollowUpClickedParams = {
                    tabId,
                    messageId,
                    authFollowupType: followUp.type,
                }
                messager.onAuthFollowUpClicked(payload)
                mynahUi.updateStore(tabId, { promptInputDisabledState: false })
            } else {
                const prompt = followUp.prompt ? followUp.prompt : followUp.pillText
                handleChatPrompt(
                    mynahUi,
                    tabId,
                    { prompt: prompt, escapedPrompt: prompt },
                    messager,
                    'click',
                    eventId,
                    agenticMode,
                    tabFactory
                )

                const payload: FollowUpClickParams = {
                    tabId,
                    messageId,
                    followUp,
                }
                messager.onFollowUpClicked(payload)
            }
        },
        onChatPrompt(tabId, prompt, eventId) {
            handleChatPrompt(mynahUi, tabId, prompt, messager, 'click', eventId, agenticMode, tabFactory)
        },
        onReady: () => {
            messager.onUiReady()
            messager.onTabAdd(tabFactory.initialTabId)
            messager.onListAvailableModels({ tabId: tabFactory.initialTabId })
        },
        onFileClick: (tabId, filePath, deleted, messageId, eventId, fileDetails) => {
            messager.onFileClick({ tabId, filePath, messageId, fullPath: fileDetails?.data?.['fullPath'] })
        },
        onTabAdd: (tabId: string) => {
            const defaultTabBarData = tabFactory.getDefaultTabData()
            const defaultTabConfig: Partial<MynahUIDataModel> = {
                quickActionCommands: defaultTabBarData.quickActionCommands,
                tabBarButtons: defaultTabBarData.tabBarButtons,
                contextCommands: [
                    ...(contextCommandGroups || []),
                    ...(featureConfig?.get('highlightCommand')
                        ? [
                              {
                                  groupName: 'Additional commands',
                                  commands: [toMynahContextCommand(featureConfig.get('highlightCommand'))],
                              },
                          ]
                        : []),
                ],
                ...(disclaimerCardActive ? { promptInputStickyCard: disclaimerCard } : {}),
            }

            const tabStore = mynahUi.getTabData(tabId).getStore()
            const storedPromptInputOptions = mynahUi.getTabDefaults().store?.promptInputOptions

            // Retrieve stored model selection and pair programming mode from defaults
            if (storedPromptInputOptions) {
                defaultTabConfig.promptInputOptions = storedPromptInputOptions
            }

            // Tabs can be opened through different methods, including server-initiated 'openTab' requests.
            // The 'openTab' request is specifically used for loading historical chat sessions with pre-existing messages.
            // We check if tabMetadata.openTabKey exists - if it does and is set to true, we skip showing welcome messages
            // since this indicates we're loading a previous chat session rather than starting a new one.
            if (!tabStore?.tabMetadata || !tabStore.tabMetadata.openTabKey) {
                defaultTabConfig.chatItems = tabFactory.getChatItems(
                    true,
                    programmingModeCardActive,
                    deprecationCardActive,
                    []
                )
                // Roll a fresh "Did you know?" tip for every new tab. The
                // mynah-ui defaults.store is built once at startup, so without
                // this override every new tab would inherit the same cached tip.
                defaultTabConfig.tabHeaderDetails = getWelcomeTabHeader()
            } else {
                // Restoring a previous chat session: hide the welcome splash so
                // it does not appear above historical messages.
                defaultTabConfig.tabHeaderDetails = null
            }
            mynahUi.updateStore(tabId, defaultTabConfig)
            messager.onTabAdd(tabId, undefined, tabStore?.tabMetadata?.openTabKey === true)
            messager.onListAvailableModels({ tabId })
        },
        onTabRemove: (tabId: string) => {
            messager.onStopChatResponse(tabId)
            messager.onTabRemove(tabId)
        },
        onTabChange: (tabId: string) => {
            messager.onTabChange(tabId)
        },
        onResetStore: () => {},
        onCopyCodeToClipboard: (
            tabId,
            messageId,
            code,
            type,
            referenceTrackerInformation,
            eventId,
            codeBlockIndex,
            totalCodeBlocks
        ) => {
            const payload: CopyCodeToClipboardParams = {
                tabId,
                messageId,
                code,
                type,
                referenceTrackerInformation,
                eventId,
                codeBlockIndex,
                totalCodeBlocks,
            }
            messager.onCopyCodeToClipboard(payload)
        },
        onVote: (tabId, messageId, vote, eventId) => {
            const payload: VoteParams = {
                tabId,
                messageId,
                vote,
                eventId,
            }
            messager.onVote(payload)
        },
        onPromptTopBarItemAdded: (tabId, item, eventId) => {
            messager.onAddPinnedContext({ tabId, contextCommandGroups: [{ commands: [item as ContextCommand] }] })
        },
        onPromptTopBarItemRemoved: (tabId, item, eventId) => {
            messager.onRemovePinnedContext({ tabId, contextCommandGroups: [{ commands: [item as ContextCommand] }] })
        },
        onPromptTopBarButtonClick(tabId, button, eventId) {
            if (button.id === 'Rules') {
                rulesList.showLoading(tabId)
                messager.onListRules({ tabId })
            }
        },
        onSendFeedback: (tabId, feedbackPayload, eventId) => {
            const payload: FeedbackParams = {
                tabId,
                feedbackPayload,
                eventId,
            }
            messager.onSendFeedback(payload)

            mynahUi.notify({
                type: NotificationType.INFO,
                title: 'Your feedback is sent',
                content: 'Thanks for your feedback.',
            })
        },
        onLinkClick: (tabId, messageId, link, mouseEvent, eventId) => {
            mouseEvent?.preventDefault()
            mouseEvent?.stopPropagation()
            mouseEvent?.stopImmediatePropagation()

            const payload: LinkClickParams = {
                tabId,
                messageId,
                link,
                eventId,
            }
            messager.onLinkClick(payload)
        },
        onSourceLinkClick: (tabId, messageId, link, mouseEvent, eventId) => {
            mouseEvent?.preventDefault()
            mouseEvent?.stopPropagation()
            mouseEvent?.stopImmediatePropagation()

            const payload: SourceLinkClickParams = {
                tabId,
                messageId,
                link,
                eventId,
            }
            messager.onSourceLinkClick(payload)
        },
        onInfoLinkClick: (tabId, link, mouseEvent, eventId) => {
            mouseEvent?.preventDefault()
            mouseEvent?.stopPropagation()
            mouseEvent?.stopImmediatePropagation()

            const payload: InfoLinkClickParams = {
                tabId,
                link,
                eventId,
            }
            messager.onInfoLinkClick(payload)
        },
        onInBodyButtonClicked: (tabId, messageId, action, eventId) => {
            if (action.id === disclaimerAcknowledgeButtonId) {
                // Hide the legal disclaimer card
                disclaimerCardActive = false

                // Update the disclaimer getting acknowledged
                messager.onDisclaimerAcknowledged()

                // Remove all disclaimer cards from all tabs
                Object.keys(mynahUi.getAllTabs()).forEach(storeTabKey => {
                    mynahUi.updateStore(storeTabKey, { promptInputStickyCard: null })
                })
            } else if (action.id === OPEN_WORKSPACE_INDEX_SETTINGS_BUTTON_ID) {
                messager.onOpenSettings('amazonQ.workspaceIndex')
            } else {
                const payload: ButtonClickParams = {
                    tabId,
                    messageId,
                    buttonId: action.id,
                }
                messager.onButtonClick(payload)
            }
            if (action.id === 'stop-shell-command') {
                messager.onStopChatResponse(tabId)
            }
        },
        onContextSelected: (contextItem, tabId) => {
            if (contextItem.command === 'Image') {
                const imageContext = getImageContextCount(tabId)
                if (imageContext >= MAX_IMAGE_CONTEXT) {
                    mynahUi.notify({
                        content: `A maximum of ${MAX_IMAGE_CONTEXT} images can be added to a single message.`,
                        type: NotificationType.WARNING,
                    })
                    return false
                }
                const payload: OpenFileDialogParams = {
                    tabId,
                    fileType: contextItem.command.toLowerCase() as 'image' | '',
                }
                messager.onOpenFileDialogClick(payload)
                return false
            }
            if (contextItem.id === ContextPrompt.CreateItemId) {
                mynahUi.showCustomForm(
                    tabId,
                    [
                        {
                            id: ContextPrompt.PromptNameFieldId,
                            type: 'textinput',
                            mandatory: true,
                            autoFocus: true,
                            title: 'Prompt name',
                            placeholder: 'Enter prompt name',
                            validationPatterns: {
                                patterns: [
                                    {
                                        pattern: /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/,
                                        errorMessage:
                                            'Use only letters, numbers, hyphens, and underscores, starting with a letter or number. Maximum 100 characters.',
                                    },
                                ],
                            },
                            validateOnChange: true,
                            description: "Use this prompt by typing '@' followed by the prompt name.",
                        },
                    ],
                    [
                        {
                            id: ContextPrompt.CancelButtonId,
                            text: 'Cancel',
                            status: 'clear',
                            waitMandatoryFormItems: false,
                        },
                        {
                            id: ContextPrompt.SubmitButtonId,
                            text: 'Create',
                            status: 'primary',
                            waitMandatoryFormItems: true,
                        },
                    ],
                    `Create a saved prompt`
                )
                return false
            }
            return true
        },
        onCustomFormAction: (tabId, action) => {
            if (action.id === ContextPrompt.SubmitButtonId) {
                messager.onCreatePrompt({ promptName: action.formItemValues![ContextPrompt.PromptNameFieldId] })
            } else if (action.id === ContextRule.SubmitButtonId) {
                messager.onCreatePrompt({
                    promptName: action.formItemValues![ContextRule.RuleNameFieldId],
                    isRule: true,
                })
            }
        },
        onFormTextualItemKeyPress: (
            event: KeyboardEvent,
            formData: Record<string, string>,
            itemId: string,
            _tabId: string,
            _eventId?: string
        ) => {
            if (event.key === 'Enter') {
                if (itemId === ContextPrompt.PromptNameFieldId) {
                    event.preventDefault()
                    messager.onCreatePrompt({ promptName: formData[ContextPrompt.PromptNameFieldId] })
                    return true
                } else if (itemId === ContextRule.RuleNameFieldId) {
                    event.preventDefault()
                    messager.onCreatePrompt({ promptName: formData[ContextRule.RuleNameFieldId], isRule: true })
                    return true
                }
            }
            return false
        },
        onTabBarButtonClick: (tabId: string, buttonId: string) => {
            if (buttonId === McpServerTabButtonId) {
                messager.onListMcpServers()
                return
            }

            if (buttonId === ChatHistory.TabBarButtonId) {
                messager.onListConversations(undefined, true)
                return
            }

            if (buttonId === ShowLogsTabBarButtonId) {
                messager.onTabBarAction({
                    tabId,
                    action: 'show_logs',
                })
                return
            }

            if (buttonId === ExportTabBarButtonId) {
                messager.onTabBarAction({
                    tabId,
                    action: 'export',
                })
                return
            }

            throw new Error(`Unhandled tab bar button id: ${buttonId}`)
        },
        onPromptInputOptionChange: (tabId, optionsValues) => {
            if (agenticMode) {
                handlePromptInputChange(mynahUi, tabId, optionsValues)
            }
            messager.onPromptInputOptionChange({ tabId, optionsValues })
        },
        onPromptInputButtonClick: (tabId, buttonId, eventId) => {
            const payload: ButtonClickParams = {
                tabId,
                messageId: 'not-a-message',
                buttonId: buttonId,
            }
            messager.onPromptInputButtonClick(payload)
        },
        onMessageDismiss: (tabId, messageId) => {
            let promptOptionAcknowledged = false

            if (messageId === programmerModeCard.messageId) {
                programmingModeCardActive = false
                promptOptionAcknowledged = true
            } else if (messageId === deprecationCard.messageId) {
                deprecationCardActive = false
                promptOptionAcknowledged = true
            }

            if (promptOptionAcknowledged) {
                messager.onChatPromptOptionAcknowledged(messageId)

                // Update the tab defaults to hide acknowledged cards for new tabs.
                mynahUi.updateTabDefaults({
                    store: {
                        chatItems: tabFactory.getChatItems(true, programmingModeCardActive, deprecationCardActive),
                    },
                })
            }
        },
        onStopChatResponse: tabId => {
            handleUIStopChatResponse(messager, mynahUi, tabId)
        },
        onOpenFileDialogClick: (tabId, fileType, insertPosition) => {
            const imageContext = getImageContextCount(tabId)
            if (imageContext >= MAX_IMAGE_CONTEXT) {
                mynahUi.notify({
                    content: `A maximum of ${MAX_IMAGE_CONTEXT} images can be added to a single message.`,
                    type: NotificationType.WARNING,
                })
                return
            }
            const payload: OpenFileDialogParams = {
                tabId,
                fileType: fileType as 'image' | '',
                insertPosition,
            }
            messager.onOpenFileDialogClick(payload)
        },
        onFilesDropped: async (tabId: string, files: FileList, insertPosition: number) => {
            const imageContextCount = getImageContextCount(tabId)
            if (imageContextCount >= MAX_IMAGE_CONTEXT) {
                mynahUi.notify({
                    content: `A maximum of ${MAX_IMAGE_CONTEXT} images can be added to a single message.`,
                    type: NotificationType.WARNING,
                })
                return
            }
            // Verify dropped files and add valid ones to context
            const { validFiles, errors } = await verifyClientImages(files)
            if (validFiles.length > 0) {
                // Calculate how many files we can actually add
                const availableSlots = MAX_IMAGE_CONTEXT - imageContextCount
                const filesToAdd = validFiles.slice(0, availableSlots)
                const filesExceeded = validFiles.length - availableSlots

                // Add error message if we exceed the limit
                if (filesExceeded > 0) {
                    errors.push(`A maximum of ${MAX_IMAGE_CONTEXT} images can be added to a single message.`)
                }

                const commands: CustomQuickActionCommand[] = await Promise.all(
                    filesToAdd.map(async (file: File) => {
                        const fileName = file.name || 'Unknown file'
                        const filePath = file.name || ''

                        // Determine file type and appropriate icon
                        const fileExtension = filePath.split('.').pop()?.toLowerCase() || ''
                        const isImage = isSupportedImageExtension(fileExtension)

                        let icon = MynahIcons.FILE
                        if (isImage) {
                            icon = MynahIcons.IMAGE
                        }

                        const arrayBuffer = await file.arrayBuffer()
                        const bytes = new Uint8Array(arrayBuffer)

                        return {
                            command: fileName,
                            description: filePath,
                            route: [filePath],
                            label: 'image',
                            icon: icon,
                            content: bytes,
                            id: fileName,
                        }
                    })
                )

                // Add valid files to context commands
                mynahUi.addCustomContextToPrompt(tabId, commands, insertPosition)
            }

            if (errors.length > 0) {
                const imageVerificationBanner: Partial<ChatItem> = {
                    messageId: 'image-verification-banner',
                    header: {
                        icon: 'warning',
                        iconStatus: 'warning',
                        body: '### Invalid Image',
                    },
                    body: `${errors.join('\n')}`,
                    canBeDismissed: true,
                }

                mynahUi.updateStore(tabId, {
                    promptInputStickyCard: imageVerificationBanner,
                })
            }
        },
    }

    const mynahUiProps: MynahUIProps = {
        tabs: {
            [tabFactory.initialTabId]: {
                isSelected: true,
                store: {
                    ...tabFactory.createTab(disclaimerCardActive),
                    chatItems: tabFactory.getChatItems(true, programmingModeCardActive, deprecationCardActive),
                },
            },
        },
        defaults: {
            store: tabFactory.createTab(false),
        },
        onContextCommandFilter: (tabId, searchTerm) => {
            // Always forward to the server. Server pulls fresh items from
            // the indexer on every request (no client-side cache), so the
            // empty-term case (@ press) returns a fresh capped list and
            // non-empty terms return the scored top matches.
            lastFilterTabId = tabId
            messager.onFilterContextCommands({ tabId, searchTerm: searchTerm ?? '' })
        },
        config: {
            maxTabs: 10,
            test: true,
            dragOverlayIcon: MynahIcons.IMAGE,
            texts: {
                ...uiComponentsTexts,
                dragOverlayText: 'Add image to context',
                // Fallback to original texts in non-agentic chat mode
                stopGenerating: agenticMode ? uiComponentsTexts.stopGenerating : 'Stop generating',
                stopGeneratingTooltip: getStopGeneratingToolTipText(os, agenticMode),
                spinnerText: agenticMode ? uiComponentsTexts.spinnerText : 'Generating your answer...',
                ...stringOverrides,
            },
            // Total model context window limit 600k.
            // 500k for user input, 100k for context, history, system prompt.
            // beside, MynahUI will automatically crop it depending on the available chars left from the prompt field itself by using a 96 chars of threshold
            // if we want to max user input as 500000, need to configure the maxUserInput as 500096
            maxUserInput: 500096,
            userInputLengthWarningThreshold: 450000,
            disableTypewriterAnimation: true,
        },
    }

    const mynahUiRef = { mynahUI: undefined as MynahUI | undefined }
    if (customChatClientAdapter) {
        // Attach routing to custom adapter top of default message handlers
        chatEventHandlers = withAdapter(chatEventHandlers, mynahUiRef, customChatClientAdapter, tabFactory)
    }

    const mynahUi = new MynahUI({
        ...mynahUiProps,
        ...chatEventHandlers,
    })
    mynahUiRef.mynahUI = mynahUi

    const getTabStore = (tabId = mynahUi.getSelectedTabId()) => {
        return tabId ? mynahUi.getAllTabs()[tabId]?.store : undefined
    }

    // The 'openTab' parameter indicates whether this tab creation is initiated by 'openTab' server request
    // to restore a previous chat session (true) or if it's a new client-side tab creation (false/undefined).
    // This distinction helps maintain consistent tab behavior between fresh conversations and restored sessions.
    const createTabId = (openTab?: boolean) => {
        const tabId = mynahUi.updateStore('', {
            ...tabFactory.createTab(disclaimerCardActive),
            tabMetadata: { openTabKey: openTab ? true : false },
        })
        if (tabId === undefined) {
            mynahUi.notify({
                content: uiComponentsTexts.noMoreTabsTooltip,
                type: NotificationType.WARNING,
            })
            return undefined
        }

        return tabId
    }

    const getOrCreateTabId = () => {
        const tabId = mynahUi.getSelectedTabId()

        return tabId ?? createTabId()
    }

    const getImageContextCount = (tabId: string) => {
        const imageContextInPrompt =
            mynahUi
                .getTabData(tabId)
                ?.getStore()
                ?.customContextCommand?.filter(cm => cm.label === 'image').length || 0
        const imageContextInPin =
            mynahUi
                .getTabData(tabId)
                ?.getStore()
                ?.promptTopBarContextItems?.filter(cm => cm.label === 'image').length || 0
        return imageContextInPrompt + imageContextInPin
    }

    const addChatResponse = (chatResult: ChatResult, tabId: string, isPartialResult: boolean) => {
        if (agenticMode) {
            agenticAddChatResponse(chatResult, tabId, isPartialResult)
        } else {
            legacyAddChatResponse(chatResult, tabId, isPartialResult)
        }
    }

    // addChatResponse handler to support Agentic chat UX changes for handling responses streaming.
    const agenticAddChatResponse = (chatResult: ChatResult, tabId: string, isPartialResult: boolean) => {
        const { type, summary, ...chatResultWithoutTypeSummary } = chatResult
        let header = toMynahHeader(chatResult.header)
        const fileList = toMynahFileList(chatResult.fileList)
        const buttons = toMynahButtons(chatResult.buttons)

        if (chatResult.contextList !== undefined) {
            header = contextListToHeader(chatResult.contextList)
        }

        const store = mynahUi.getTabData(tabId)?.getStore() || {}
        const chatItems = store.chatItems || []
        const isPairProgrammingMode: boolean = getTabPairProgrammingMode(mynahUi, tabId)

        if (chatResult.additionalMessages?.length) {
            mynahUi.updateStore(tabId, {
                loadingChat: true,
                cancelButtonWhenLoading: true,
            })
            chatResult.additionalMessages.forEach(am => {
                const chatItem: ChatItem = {
                    messageId: am.messageId,
                    type:
                        am.type === 'tool'
                            ? ChatItemType.ANSWER
                            : am.type === 'directive'
                              ? ChatItemType.DIRECTIVE
                              : ChatItemType.ANSWER_STREAM,
                    ...prepareChatItemFromMessage(am, isPairProgrammingMode, isPartialResult),
                }

                if (!chatItems.find(ci => ci.messageId === am.messageId)) {
                    mynahUi.addChatItem(tabId, chatItem)
                } else {
                    mynahUi.updateChatAnswerWithMessageId(tabId, am.messageId!, chatItem)
                }
            })
        }

        if (isPartialResult) {
            mynahUi.updateStore(tabId, {
                loadingChat: true,
                cancelButtonWhenLoading: true,
            })
            const chatItem = {
                ...chatResultWithoutTypeSummary,
                body: chatResult.body,
                type: ChatItemType.ANSWER_STREAM,
                header: header,
                buttons: buttons,
                fileList,
                codeBlockActions: isPairProgrammingMode ? { 'insert-to-cursor': null } : undefined,
            }

            if (!chatItems.find(ci => ci.messageId === chatResult.messageId)) {
                mynahUi.addChatItem(tabId, chatItem)
            } else {
                mynahUi.updateChatAnswerWithMessageId(tabId, chatResult.messageId!, chatItem)
            }
            return
        }

        // If chat response from server is an empty object don't do anything
        if (Object.keys(chatResult).length === 0) {
            return
        }
        // If the response is auth follow-up show it as a system prompt
        const followUpOptions = chatResult.followUp?.options
        const isValidAuthFollowUp =
            followUpOptions &&
            followUpOptions.length > 0 &&
            followUpOptions[0].type &&
            isValidAuthFollowUpType(followUpOptions[0].type)
        if (chatResult.body === '' && isValidAuthFollowUp) {
            mynahUi.addChatItem(tabId, {
                ...chatResultWithoutTypeSummary,
                header: header,
                buttons: buttons,
                type: ChatItemType.SYSTEM_PROMPT,
            })

            // TODO, prompt should be disabled until user is authenticated
            // Currently we don't have a mechanism to notify chat-client about auth changes
            // mynahUi.updateStore(tabId, { promptInputDisabledState: true })
            return
        }
        const followUps = chatResult.followUp
            ? {
                  text: chatResult.followUp.text ?? 'Suggested follow up questions:',
                  options: chatResult.followUp.options,
              }
            : {}

        const chatItem = {
            ...chatResultWithoutTypeSummary,
            body: chatResult.body,
            type: ChatItemType.ANSWER_STREAM,
            header: header,
            buttons: buttons,
            codeBlockActions: isPairProgrammingMode ? { 'insert-to-cursor': null } : undefined,
        }

        if (!chatItems.find(ci => ci.messageId === chatResult.messageId)) {
            mynahUi.addChatItem(tabId, chatItem)
        }

        mynahUi.endMessageStream(tabId, chatResult.messageId ?? '', {
            header: header,
            buttons: buttons,
            body: chatResult.body,
            followUp: followUps,
            relatedContent: chatResult.relatedContent,
            canBeVoted: chatResult.canBeVoted,
            codeReference: chatResult.codeReference,
            fileList: chatResult.fileList,
            // messageId excluded
        })

        mynahUi.updateStore(tabId, {
            loadingChat: false,
            cancelButtonWhenLoading: true,
            promptInputDisabledState: false,
        })
    }

    // addChatResponse handler to support extensions that haven't migrated to agentic chat yet
    const legacyAddChatResponse = (chatResult: ChatResult, tabId: string, isPartialResult: boolean) => {
        const { type, summary, ...chatResultWithoutTypeSummary } = chatResult
        let header = undefined

        if (chatResult.contextList !== undefined) {
            header = {
                fileList: {
                    fileTreeTitle: '',
                    filePaths: chatResult.contextList.filePaths?.map(file => file),
                    rootFolderTitle: 'Context',
                    flatList: true,
                    collapsed: true,
                    hideFileCount: true,
                    details: Object.fromEntries(
                        Object.entries(chatResult.contextList.details || {}).map(([filePath, fileDetails]) => [
                            filePath,
                            {
                                label:
                                    fileDetails.lineRanges
                                        ?.map(range =>
                                            range.first === -1 || range.second === -1
                                                ? ''
                                                : `line ${range.first} - ${range.second}`
                                        )
                                        .join(', ') || '',
                                description: filePath,
                                clickable: true,
                            },
                        ])
                    ),
                },
            }
        }

        if (isPartialResult) {
            // @ts-expect-error - type for MynahUI differs from ChatResult types so we ignore it
            mynahUi.updateLastChatAnswer(tabId, { ...chatResultWithoutTypeSummary, header: header })
            return
        }

        // If chat response from server is an empty object don't do anything
        if (Object.keys(chatResult).length === 0) {
            return
        }
        // If the response is auth follow-up show it as a system prompt
        const followUpOptions = chatResult.followUp?.options
        const isValidAuthFollowUp =
            followUpOptions &&
            followUpOptions.length > 0 &&
            followUpOptions[0].type &&
            isValidAuthFollowUpType(followUpOptions[0].type)
        if (chatResult.body === '' && isValidAuthFollowUp) {
            // @ts-expect-error - type for MynahUI differs from ChatResult types so we ignore it
            mynahUi.addChatItem(tabId, {
                type: ChatItemType.SYSTEM_PROMPT,
                ...chatResultWithoutTypeSummary,
            })

            // TODO, prompt should be disabled until user is authenticated
            // Currently we don't have a mechanism to notify chat-client about auth changes
            // mynahUi.updateStore(tabId, { promptInputDisabledState: true })
            return
        }
        const followUps = chatResult.followUp
            ? {
                  text: chatResult.followUp.text ?? 'Suggested follow up questions:',
                  options: chatResult.followUp.options,
              }
            : {}

        mynahUi.updateLastChatAnswer(tabId, {
            header: header,
            body: chatResult.body,
            messageId: chatResult.messageId,
            followUp: followUps,
            relatedContent: chatResult.relatedContent,
            canBeVoted: chatResult.canBeVoted,
        })

        mynahUi.endMessageStream(tabId, chatResult.messageId ?? '')

        mynahUi.updateStore(tabId, {
            loadingChat: false,
            promptInputDisabledState: false,
        })
    }

    /**
     * Adjusts the UI when the user changes to/from free-tier/paid-tier.
     * Shows a message if the user reaches free-tier limit.
     * Shows a message if the user just upgraded to paid-tier.
     */
    const onPaidTierModeChange = (tabId: string, mode: string | undefined) => {
        if (!mode || !['freetier', 'freetier-limit', 'upgrade-pending', 'paidtier'].includes(mode)) {
            return false // invalid mode
        }

        tabId = tabId ? tabId : getOrCreateTabId()!
        const store = mynahUi.getTabData(tabId).getStore() || {}

        // Detect if the tab is already showing the "Upgrade Q" UI.
        const isFreeTierLimitUi = store.promptInputStickyCard?.messageId === freeTierLimitSticky.messageId
        const isUpgradePendingUi = store.promptInputStickyCard?.messageId === upgradePendingSticky.messageId
        const isPlansAndPricingTab = plansAndPricingTitle === store.tabTitle

        if (mode === 'freetier-limit') {
            mynahUi.updateStore(tabId, {
                promptInputStickyCard: freeTierLimitSticky,
            })

            if (!isFreeTierLimitUi) {
                // TODO: how to set a warning icon on the user's failed prompt?
                //
                // const chatItems = store.chatItems ?? []
                // const lastPrompt = chatItems.filter(ci => ci.type === ChatItemType.PROMPT).at(-1)
                // for (const c of chatItems) {
                //     c.body = 'xxx / ' + c.type
                //     c.icon = 'warning'
                //     c.iconStatus = 'warning'
                //     c.status = 'warning'
                // }
                //
                // if (lastPrompt && lastPrompt.messageId) {
                //     lastPrompt.icon = 'warning'
                //     lastPrompt.iconStatus = 'warning'
                //     lastPrompt.status = 'warning'
                //
                //     // Decorate the failed prompt with a warning icon.
                //     // mynahUi.updateChatAnswerWithMessageId(tabId, lastPrompt.messageId, lastPrompt)
                // }
                //
                // mynahUi.updateStore(tabId, {
                //     chatItems: chatItems,
                // })
            } else {
                // Show directive only on 2nd chat attempt, not the initial attempt.
                mynahUi.addChatItem(tabId, freeTierLimitDirective)
            }
        } else if (mode === 'upgrade-pending') {
            // Change the sticky banner to show a progress spinner.
            const card: typeof freeTierLimitSticky = {
                ...(isFreeTierLimitUi ? freeTierLimitSticky : upgradePendingSticky),
            }
            card.header = {
                ...card.header,
                icon: upgradePendingSticky.header?.icon,
                iconStatus: upgradePendingSticky.header?.iconStatus,
            }
            mynahUi.updateStore(tabId, {
                promptInputVisible: true,
                promptInputStickyCard: card,
            })
        } else if (mode === 'paidtier') {
            mynahUi.updateStore(tabId, {
                promptInputStickyCard: null,
                promptInputVisible: !isPlansAndPricingTab,
            })
            if (isFreeTierLimitUi || isUpgradePendingUi || isPlansAndPricingTab) {
                // Transitioning from 'upgrade-pending' to upgrade success.
                const card: typeof upgradeSuccessSticky = {
                    ...upgradeSuccessSticky,
                    canBeDismissed: !isPlansAndPricingTab,
                }
                mynahUi.updateStore(tabId, {
                    promptInputStickyCard: card,
                })
            }
        }

        mynahUi.updateStore(tabId, {
            // promptInputButtons: mode === 'freetier-limit' ? [upgradeQButton] : [],
            // promptInputDisabledState: mode === 'freetier-limit',
        })

        return true
    }

    const updateChat = (params: ChatUpdateParams) => {
        // HACK: Special field sent by `agenticChatController.ts:setPaidTierMode()`.
        if (onPaidTierModeChange(params.tabId, (params as any).paidTierMode as string)) {
            return
        }

        const isChatLoading = params.state?.inProgress
        mynahUi.updateStore(params.tabId, {
            loadingChat: isChatLoading,
            cancelButtonWhenLoading: agenticMode,
        })
        if (params.data?.messages.length) {
            const { tabId } = params
            const store = mynahUi.getTabData(tabId).getStore() || {}
            const chatItems = store.chatItems || []

            params.data?.messages.forEach(updatedMessage => {
                if (!updatedMessage.messageId) {
                    // Do not process messages without known ID.
                    return
                }

                if (updatedMessage.messageId === 'modelUnavailable') {
                    mynahUi.updateStore(tabId, {
                        promptInputStickyCard: modelUnavailableBanner,
                    })
                    return
                }

                if (updatedMessage.messageId === 'modelThrottled') {
                    mynahUi.updateStore(tabId, {
                        promptInputStickyCard: modelThrottledBanner,
                    })
                    return
                }

                const oldMessage = chatItems.find(ci => ci.messageId === updatedMessage.messageId)
                if (!oldMessage) return

                const chatItem: ChatItem = {
                    type: oldMessage.type,
                    ...prepareChatItemFromMessage(updatedMessage, getTabPairProgrammingMode(mynahUi, tabId)),
                }
                mynahUi.updateChatAnswerWithMessageId(tabId, updatedMessage.messageId, chatItem)
            })
        }
    }

    const sendToPrompt = (params: SendToPromptParams) => {
        const tabId = getOrCreateTabId()
        if (!tabId) return
        chatHistoryList.close()
        mcpMynahUi.close()
        if (params.autoSubmit && params.prompt) {
            messager.onChatPrompt({ prompt: params.prompt, tabId, context: undefined }, 'contextMenu')
            initializeChatResponse(mynahUi, tabId, params.prompt.prompt, agenticMode)
        } else {
            mynahUi.addToUserPrompt(tabId, params.selection, 'code')
        }
        messager.onSendToPrompt(params, tabId)
    }

    const sendGenericCommand = (params: GenericCommandParams) => {
        let tabId = getOrCreateTabId()

        if (!tabId) return
        chatHistoryList.close()
        mcpMynahUi.close()
        // send to a new tab if the current tab is loading
        if (getTabStore(tabId)?.loadingChat) {
            tabId = createTabId()
            if (!tabId) return
        }
        let body = ''
        let chatPrompt: ChatPrompt
        const genericCommandString = params.genericCommand as string
        if (genericCommandString.includes('Review')) {
            chatPrompt = { command: '/review' }
            if (!tabFactory?.isCodeReviewInChatEnabled()) {
                customChatClientAdapter?.handleQuickAction(chatPrompt, tabId, '')
                return
            }
        } else {
            body = [
                genericCommandString,
                ' the following part of my code:',
                '\n~~~~\n',
                params.selection,
                '\n~~~~\n',
            ].join('')
            chatPrompt = { prompt: body, escapedPrompt: body }
        }

        handleChatPrompt(mynahUi, tabId, chatPrompt, messager, params.triggerType, undefined, agenticMode, tabFactory)
    }

    const showError = (params: ErrorParams) => {
        const tabId = getOrCreateTabId()
        if (!tabId) return

        const answer: ChatItem = {
            type: ChatItemType.ANSWER,
            body: `**${params.title}**
${params.message}`,
        }

        mynahUi.updateStore(tabId, {
            loadingChat: false,
            cancelButtonWhenLoading: agenticMode,
            promptInputDisabledState: false,
        })

        mynahUi.addChatItem(params.tabId, answer)
        messager.onError(params)
    }

    const executeShellCommandShortCut = (params: ExecuteShellCommandParams) => {
        const activeElement = document.activeElement as HTMLElement

        const tabId = mynahUi.getSelectedTabId()
        if (!tabId) return

        const chatItems = mynahUi.getTabData(tabId)?.getStore()?.chatItems || []
        const buttonId = params.id

        let messageId
        for (const item of chatItems) {
            if (buttonId === 'stop-shell-command' && item.buttons && item.buttons.some(b => b.id === buttonId)) {
                messageId = item.messageId
                break
            }
            if (item.header?.buttons && item.header.buttons.some(b => b.id === buttonId)) {
                messageId = item.messageId
                break
            }
        }

        if (messageId) {
            const payload: ButtonClickParams = {
                tabId,
                messageId,
                buttonId,
            }
            messager.onButtonClick(payload)
            if (buttonId === 'stop-shell-command') {
                handleUIStopChatResponse(messager, mynahUi, tabId)
            }
        } else {
            // handle global stop
            const isLoading = mynahUi.getTabData(tabId)?.getStore()?.loadingChat
            if (isLoading && buttonId === 'stop-shell-command') {
                handleUIStopChatResponse(messager, mynahUi, tabId)
            }
        }
        // this is a short-term solution to re-gain focus after executing a shortcut
        // current behavior will emit exitFocus telemetry immediadately.
        // use this to re-gain focus, so that user can use shortcut after shortcut
        // without manually re-gain focus.
        setTimeout(() => {
            if (activeElement && activeElement.focus) {
                activeElement.focus()
            }
        }, 100)
    }

    const openTab = (requestId: string, params: OpenTabParams) => {
        if (params.tabId) {
            if (params.tabId !== mynahUi.getSelectedTabId()) {
                mynahUi.selectTab(params.tabId)
            }
            messager.onOpenTab(requestId, { tabId: params.tabId })
        } else {
            const messages = params.newTabOptions?.data?.messages
            const tabId = createTabId(true)
            if (tabId) {
                mynahUi.updateStore(tabId, {
                    chatItems: tabFactory.getChatItems(
                        messages ? false : true,
                        programmingModeCardActive,
                        deprecationCardActive,
                        messages
                    ),
                    // onTabAdd suppresses the welcome splash whenever
                    // openTabKey is true (which createTabId(true) sets), so
                    // re-establish it here for the no-messages case so a
                    // server-initiated "open a fresh tab" still shows the
                    // splash. When messages are provided we keep the splash
                    // hidden so it does not sit above the conversation.
                    tabHeaderDetails: messages ? null : getWelcomeTabHeader(),
                })
                messager.onOpenTab(requestId, { tabId })
            } else {
                messager.onOpenTab(requestId, {
                    type: 'InvalidRequest',
                    message: 'No more tabs available',
                })
            }
        }
    }

    const toContextCommands = (commands: ContextCommand[]): QuickActionCommand[] => {
        return commands.map(command => ({
            ...command,
            children: command.children?.map(child => ({
                ...child,
                commands: toContextCommands(child.commands),
            })),
            icon: toMynahIcon(command.icon),
            disabled: command.disabledText != null,
        }))
    }

    const sendPinnedContext = (params: PinnedContextParams) => {
        const pinnedContext = toContextCommands(params.contextCommandGroups[0]?.commands || [])
        let activeEditor = pinnedContext[0]?.id === ACTIVE_EDITOR_CONTEXT_ID
        // Update Active File pill description with active editor URI passed from IDE
        if (activeEditor) {
            if (params.textDocument != null) {
                pinnedContext[0].description = params.textDocument.uri
            } else {
                // IDE did not pass in active file, remove it from pinned context
                pinnedContext.shift()
                activeEditor = false
            }
        }
        let promptTopBarTitle = '@'
        // Show full `@Pin Context` title until user adds a pinned context item
        if (pinnedContext.length == 0 || (activeEditor && pinnedContext.length === 1)) {
            promptTopBarTitle = '@Pin Context'
        }
        mynahUi.updateStore(params.tabId, {
            promptTopBarContextItems: pinnedContext,
            promptTopBarTitle,
            promptTopBarButton: params.showRules
                ? { id: 'Rules', status: 'clear', text: 'Rules', icon: 'check-list' }
                : null,
        })
    }

    const sendContextCommands = (params: ContextCommandParams) => {
        contextCommandGroups = params.contextCommandGroups.map(group => ({
            ...group,
            commands: toContextCommands(group.commands),
        }))

        const commandsWithHighlight = [
            ...(contextCommandGroups || []),
            ...(featureConfig?.get('highlightCommand')
                ? [
                      {
                          groupName: 'Additional commands',
                          commands: [toMynahContextCommand(featureConfig.get('highlightCommand'))],
                      },
                  ]
                : []),
        ]

        Object.keys(mynahUi.getAllTabs()).forEach(tabId => {
            mynahUi.updateStore(tabId, {
                contextCommands: commandsWithHighlight,
            })
        })
    }

    const filterContextCommandsResponse = (params: FilterContextCommandsResult) => {
        if (!lastFilterTabId) return

        const filtered = params.contextCommandGroups.map(group => ({
            ...group,
            commands: toContextCommands(group.commands),
        }))

        mynahUi.updateStore(lastFilterTabId, {
            contextCommands: [
                ...filtered,
                ...(featureConfig?.get('highlightCommand')
                    ? [
                          {
                              groupName: 'Additional commands',
                              commands: [toMynahContextCommand(featureConfig.get('highlightCommand'))],
                          },
                      ]
                    : []),
            ],
        })
    }

    const addSelectedFilesToContext = (params: OpenFileDialogResult) => {
        if (params.errorMessage) {
            mynahUi.notify({
                content: params.errorMessage,
                type: NotificationType.ERROR,
            })
            return
        }
        const commands: QuickActionCommand[] = []
        for (const filePath of params.filePaths) {
            const fileName = filePath.split(/[\\/]/).pop() || filePath
            if (params.fileType === 'image') {
                commands.push({
                    command: fileName,
                    description: filePath,
                    label: 'image',
                    route: [filePath],
                    icon: MynahIcons.IMAGE,
                    id: fileName,
                })
            }
        }

        mynahUi.addCustomContextToPrompt(params.tabId, commands, params.insertPosition)
    }

    const chatHistoryList = new ChatHistoryList(mynahUi, messager)
    const listConversations = (params: ListConversationsResult) => {
        chatHistoryList.show(params)
    }

    const rulesList = new RulesList(mynahUi, messager)

    const listRules = (params: ListRulesResult) => {
        rulesList.show(params)
    }

    const ruleClicked = (params: RuleClickResult) => {
        if (!params.success) {
            mynahUi.notify({
                content: `Failed to toggle the workspace rule`,
                type: NotificationType.ERROR,
            })
            return
        }
        messager.onListRules({ tabId: params.tabId })
    }

    const conversationClicked = (params: ConversationClickResult) => {
        if (!params.success) {
            mynahUi.notify({
                content: `Failed to ${params.action ?? 'open'} the history`,
                type: NotificationType.ERROR,
            })
            return
        }

        // close history list if conversation item was successfully opened
        if (!params.action) {
            chatHistoryList.close()
            return
        }
        // request update conversations list if conversation item was successfully deleted
        if (params.action === 'delete') {
            messager.onListConversations()
        }
    }

    // Create an instance of McpMynahUi to handle MCP server functionality
    const mcpMynahUi = new McpMynahUi(mynahUi, messager)

    const listMcpServers = (params: ListMcpServersResult) => {
        mcpMynahUi.listMcpServers(params)
    }

    // MCP server functionality is now handled by the McpMynahUi class

    /**
     * Handles MCP server click events
     */
    const mcpServerClick = (params: McpServerClickResult) => {
        mcpMynahUi.mcpServerClick(params)
    }

    const getSerializedChat = (requestId: string, params: GetSerializedChatParams) => {
        const supportedFormats = ['markdown', 'html']

        if (!supportedFormats.includes(params.format)) {
            mynahUi.notify({
                content: `Failed to export chat`,
                type: NotificationType.ERROR,
            })

            messager.onGetSerializedChat(requestId, {
                type: 'InvalidRequest',
                message: `Failed to get serialized chat content, ${params.format} is not supported`,
            })

            return
        }

        try {
            const serializedChat = mynahUi.serializeChat(params.tabId, params.format)

            messager.onGetSerializedChat(requestId, {
                content: serializedChat,
            })
        } catch (err) {
            messager.onGetSerializedChat(requestId, {
                type: 'InternalError',
                message: 'Failed to get serialized chat content',
            })
        }
    }

    const listAvailableModels = (params: ListAvailableModelsResult) => {
        const tabId = params.tabId
        const promptInputOptions = mynahUi.getTabData(tabId).getStore()?.promptInputOptions
        mynahUi.updateStore(tabId, {
            promptInputOptions: promptInputOptions?.map(option =>
                option.id === 'model-selection'
                    ? {
                          ...option,
                          type: 'select',
                          options: params.models.map(model => ({
                              value: model.id,
                              label: model.name,
                              description: model.description ?? '',
                          })),
                          value: params.selectedModelId,
                      }
                    : option
            ),
        })
    }

    const api = {
        addChatResponse: addChatResponse,
        updateChat: updateChat,
        sendToPrompt: sendToPrompt,
        sendGenericCommand: sendGenericCommand,
        showError: showError,
        openTab: openTab,
        sendContextCommands: sendContextCommands,
        sendPinnedContext: sendPinnedContext,
        executeShellCommandShortCut: executeShellCommandShortCut,
        listConversations: listConversations,
        listRules: listRules,
        conversationClicked: conversationClicked,
        listMcpServers: listMcpServers,
        mcpServerClick: mcpServerClick,
        getSerializedChat: getSerializedChat,
        createTabId: createTabId,
        ruleClicked: ruleClicked,
        listAvailableModels: listAvailableModels,
        addSelectedFilesToContext: addSelectedFilesToContext,
        filterContextCommandsResponse: filterContextCommandsResponse,
    }

    return [mynahUi, api]
}

const ACTIVE_EDITOR_CONTEXT_ID = 'active-editor'

export const DEFAULT_HELP_PROMPT = 'What can Amazon Q help me with?'

const DEFAULT_DOC_PROMPT = `You are Amazon Q. Start with a warm greeting, then ask the user to specify what kind of documentation they need. Present common documentation types (like API docs, README, user guides, developer guides, or configuration guides) as clear options. Keep the question brief and friendly. Don't make assumptions about existing content or context. Wait for their response before providing specific guidance.`

const DEFAULT_TEST_PROMPT = `You are Amazon Q. Start with a warm greeting, then help me generate unit tests`

const DEFAULT_DEV_PROMPT = `You are Amazon Q. Start with a warm greeting, then ask the user to specify what kind of help they need in code development. Present common questions asked (like Creating a new project, Adding a new feature, Modifying your files). Keep the question brief and friendly. Don't make assumptions about existing content or context. Wait for their response before providing specific guidance.`

const DEFAULT_REVIEW_PROMPT = `You are Amazon Q. Start with a warm greeting, then use code review tool to perform a diff review code analysis of the open file. If there is no open file, ask what the user would like to review. Please tell the user that the scan is a diff scan.`

export const uiComponentsTexts = {
    mainTitle: 'Amazon Q (Preview)',
    copy: 'Copy',
    insertAtCursorLabel: 'Insert at cursor',
    feedbackFormTitle: 'Report an issue',
    feedbackFormOptionsLabel: 'What type of issue would you like to report?',
    feedbackFormCommentLabel: 'Description of issue (optional):',
    feedbackThanks: 'Thanks for your feedback!',
    feedbackReportButtonLabel: 'Report an issue',
    codeSuggestions: 'Code suggestions',
    files: 'file(s)',
    clickFileToViewDiff: 'Click on a file to view diff.',
    showMore: 'Show more',
    save: 'Save',
    cancel: 'Cancel',
    submit: 'Submit',
    stopGenerating: 'Stop',
    copyToClipboard: 'Copied to clipboard',
    noMoreTabsTooltip: 'You can only open ten conversation tabs at a time.',
    codeSuggestionWithReferenceTitle: 'Some suggestions contain code with references.',
    spinnerText: 'Working...',
    macStopButtonShortcut: '&#8679; &#8984; &#9003;',
    windowStopButtonShortcut: 'Ctrl + &#8679; + &#9003;',
}

const getStopGeneratingToolTipText = (os: string | undefined, agenticMode: boolean | undefined): string => {
    if (agenticMode && os) {
        return os === 'darwin'
            ? `Stop:  ${uiComponentsTexts.macStopButtonShortcut}`
            : `Stop:  ${uiComponentsTexts.windowStopButtonShortcut}`
    }

    return agenticMode ? uiComponentsTexts.stopGenerating : 'Stop generating'
}

const handleUIStopChatResponse = (messenger: Messager, mynahUi: MynahUI, tabId: string) => {
    messenger.onStopChatResponse(tabId)

    // Reset loading state
    mynahUi.updateStore(tabId, {
        loadingChat: false,
        cancelButtonWhenLoading: true,
        promptInputDisabledState: false,
    })

    // Add a small delay before adding the chat item
    setTimeout(() => {
        // Add cancellation message when stop button is clicked
        mynahUi.addChatItem(tabId, {
            type: ChatItemType.DIRECTIVE,
            messageId: 'stopped' + Date.now(),
            body: 'You stopped your current work, please provide additional examples or ask another question.',
        })
    }, 500) // 500ms delay
}
