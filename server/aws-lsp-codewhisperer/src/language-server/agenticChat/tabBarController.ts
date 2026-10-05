/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { ChatDatabase, EMPTY_CONVERSATION_LIST_ID } from './tools/chatDb/chatDb'
import { Conversation, messageToChatMessage, Tab } from './tools/chatDb/util'
import { Features } from '@aws/language-server-runtimes/server-interface/server'
import {
    Action as ConversationItemAction,
    ConversationClickParams,
    ConversationClickResult,
    ListConversationsParams,
    ListConversationsResult,
    TabBarActionParams,
    ConversationItemGroup,
} from '@aws/language-server-runtimes-types'
import { URI, Utils } from 'vscode-uri'
import { InitializeParams } from '@aws/language-server-runtimes/server-interface'
import { TelemetryService } from '../../shared/telemetry/telemetryService'
import { ChatHistoryActionType } from '../../shared/telemetry/types'
import { CancellationError } from '@aws/lsp-core'

const MaxRestoredHistoryMessages = 250
const JUPYTERLAB_APP_TYPE_VALUE = 'jupyterlab'

/**
 * Controller for managing chat history and export functionality.
 *
 * Handles chat conversation management including:
 * - Loading and restoring conversations from chat history
 * - Handling chat history operations (list, search, delete)
 * - Export chat
 *
 * Ported from https://github.com/aws/aws-toolkit-vscode/blob/master/packages/core/src/codewhispererChat/controllers/chat/tabBarController.ts
 *
 */
export class TabBarController {
    #loadedChats: boolean = false
    #searchTimeout: NodeJS.Timeout | undefined = undefined
    readonly #DebounceTime = 300 // milliseconds
    #features: Features
    #chatHistoryDb: ChatDatabase
    #telemetryService: TelemetryService
    #sendPinnedContext: (tabId: string) => void
    #restorePairProgrammingMode: (tabId: string, enabled: boolean) => void

    constructor(
        features: Features,
        chatHistoryDb: ChatDatabase,
        telemetryService: TelemetryService,
        sendPinnedContext: (tabId: string) => void,
        restorePairProgrammingMode: (tabId: string, enabled: boolean) => void
    ) {
        this.#features = features
        this.#chatHistoryDb = chatHistoryDb
        this.#telemetryService = telemetryService
        this.#sendPinnedContext = sendPinnedContext
        this.#restorePairProgrammingMode = restorePairProgrammingMode
    }

    /**
     * Retrieves a list of conversations to display in chat history.
     * If a search filter is provided, performs a debounced search on messages.
     * Otherwise, returns the full conversation history with filter options.
     */
    async onListConversations(params: ListConversationsParams): Promise<ListConversationsResult> {
        const searchFilter = params.filter?.['search']

        if (this.#searchTimeout) {
            clearTimeout(this.#searchTimeout)
        }

        const attachActionsToConversationList = (list: ConversationItemGroup[]) => {
            return list.map(group => {
                const items =
                    group.items?.map(item => ({
                        ...item,
                        ...(item.id !== EMPTY_CONVERSATION_LIST_ID
                            ? { actions: this.getConversationActions(item.id) }
                            : {}),
                    })) || []

                return {
                    ...group,
                    ...(items.length > 0 ? { items } : {}),
                }
            })
        }

        if (searchFilter) {
            const dbSize = this.#chatHistoryDb.getDatabaseFileSize()

            let list: ConversationItemGroup[] = await new Promise<any[]>(resolve => {
                this.#searchTimeout = setTimeout(() => {
                    const { results, searchTime } = this.#chatHistoryDb.searchMessages(searchFilter)

                    this.#telemetryService.emitChatHistoryAction({
                        action: ChatHistoryActionType.Search,
                        languageServerVersion: this.#features.runtime.serverInfo.version,
                        amazonqHistoryFileSize: dbSize,
                        amazonqTimeToSearchHistory: searchTime,
                        result: 'Succeeded',
                    })

                    resolve(results)
                }, this.#DebounceTime)
            })
            list = attachActionsToConversationList(list)

            return { list }
        }

        let list = this.#chatHistoryDb.getHistory()
        list = attachActionsToConversationList(list)

        return {
            header: { title: 'Chat history' },
            filterOptions: [
                {
                    type: 'textinput',
                    icon: 'search',
                    id: 'search',
                    placeholder: 'Search...',
                },
            ],
            list,
        }
    }

    private getConversationActions(historyId: string): ConversationItemAction[] {
        const actions = []

        if (TabBarController.enableChatExport(this.#features.lsp.getClientInitializeParams())) {
            actions.push({
                text: 'Export',
                icon: 'external',
                id: historyId,
            })
        }

        actions.push({
            text: 'Delete',
            icon: 'trash',
            id: historyId,
        })

        return actions
    }

    /**
     * Handles a click event on a conversation in the chat history.
     *
     * This method performs different actions based on the click parameters:
     * - If no action is specified, it attempts to open or focus the conversation tab.
     * - If the action is 'delete', it removes the conversation from the chat history.
     *
     */
    async onConversationClick(params: ConversationClickParams): Promise<ConversationClickResult> {
        const historyID = params.id

        if (historyID === EMPTY_CONVERSATION_LIST_ID) {
            this.#features.logging.debug('Empty conversation history list item clicked')
            return { ...params, success: true }
        }

        // Handle user click on conversation in history
        if (!params.action) {
            const openTabID = this.#chatHistoryDb.getOpenTabId(historyID)
            // If conversation is already open, focus its tab. Otherwise, open new tab with conversation.
            if (openTabID) {
                await this.#features.chat.openTab({ tabId: openTabID })
            } else {
                const selectedTab = this.#chatHistoryDb.getTab(historyID)
                await this.restoreTab(selectedTab)
            }
            this.#telemetryService.emitChatHistoryAction({
                action: ChatHistoryActionType.Open,
                languageServerVersion: this.#features.runtime.serverInfo.version,
                result: 'Succeeded',
            })
        } else if (params.action === 'delete') {
            this.#chatHistoryDb.deleteHistory(historyID)
            this.#telemetryService.emitChatHistoryAction({
                action: ChatHistoryActionType.Delete,
                languageServerVersion: this.#features.runtime.serverInfo.version,
                result: 'Succeeded',
            })
        } else if (params.action === 'export') {
            let openTabID = this.#chatHistoryDb.getOpenTabId(historyID)

            // Restore tab if it is not open in Chat Client, this is needed to request serialized content from Chat Client later on.
            if (!openTabID) {
                const selectedTab = this.#chatHistoryDb.getTab(historyID)
                await this.restoreTab(selectedTab)

                openTabID = this.#chatHistoryDb.getOpenTabId(historyID)
            }

            if (!openTabID) {
                // If still not tab id - return error
                this.#features.logging.error('Failed to restore Chat Client Tab from history')
                return { ...params, success: false }
            }

            const exportTabResponse = await this.onExportTab(openTabID)

            this.#telemetryService.emitChatHistoryAction({
                action: ChatHistoryActionType.Export,
                languageServerVersion: this.#features.runtime.serverInfo.version,
                filenameExt: exportTabResponse.format,
                result: exportTabResponse.result,
            })
            if (exportTabResponse.result !== 'Succeeded') {
                return { ...params, success: false }
            }
        } else {
            this.#features.logging.error(`Unsupported action: ${params.action}`)
            return { ...params, success: false }
        }

        return { ...params, success: true }
    }

    async onTabBarAction(params: TabBarActionParams) {
        if (params.action === 'export' && params.tabId) {
            const exportTabResponse = await this.onExportTab(params.tabId)

            this.#telemetryService.emitExportTab({
                filenameExt: exportTabResponse.format,
                languageServerVersion: this.#features.runtime.serverInfo.version,
                result: exportTabResponse.result,
            })

            const actionResult = exportTabResponse.result === 'Succeeded'

            return { ...params, success: actionResult }
        }

        this.#features.logging.error(`Unsupported action ${params.action}`)
        return { ...params, success: false }
    }

    async onExportTab(tabId: string) {
        const defaultFileName = `q-dev-chat-${new Date().toISOString().split('T')[0]}.md`
        try {
            let defaultUri
            let workspaceFolders = this.#features.workspace.getAllWorkspaceFolders()
            if (workspaceFolders && workspaceFolders.length > 0) {
                const workspaceUri = URI.parse(workspaceFolders[0].uri)
                defaultUri = Utils.joinPath(workspaceUri, defaultFileName)
            } else {
                defaultUri = URI.file(defaultFileName)
            }

            const { targetUri } = await this.#features.lsp.window.showSaveFileDialog({
                supportedFormats: ['markdown', 'html'],
                defaultUri: defaultUri.toString(),
            })

            if (targetUri === null || targetUri === '') {
                // If user cancelled the show save file dialog, targetUri will be empty.
                throw new CancellationError('user')
            }

            const targetPath = URI.parse(targetUri)
            const format = targetPath.fsPath.endsWith('.md') ? 'markdown' : 'html'
            const { content } = await this.#features.chat.getSerializedChat({
                tabId,
                format,
            })

            await this.#features.workspace.fs.writeFile(targetPath.fsPath, content)

            return {
                format: format,
                result: 'Succeeded' as const,
            }
        } catch (error: any) {
            if (error instanceof CancellationError) {
                this.#features.logging.debug('Export cancelled by user')
                return {
                    format: '',
                    result: 'Cancelled' as const,
                }
            }

            this.#features.logging.error(`Unable to export tab "${tabId}": ${error.message || error}`)
            return {
                format: '',
                result: 'Failed' as const,
            }
        }
    }

    /**
     * Opens new tab with a conversation from history.
     * Restores the tab's messages and per-tab preferences (model selection and agentic coding mode).
     */
    async restoreTab(selectedTab?: Tab | null) {
        if (selectedTab) {
            const messages = selectedTab.conversations
                .flatMap((conv: Conversation) =>
                    conv.messages
                        .filter(msg => msg.shouldDisplayMessage != false)
                        .flatMap(msg => messageToChatMessage(msg))
                )
                .slice(-MaxRestoredHistoryMessages)

            const { tabId } = await this.#features.chat.openTab({ newTabOptions: { data: { messages } } })
            this.#chatHistoryDb.setHistoryIdMapping(tabId, selectedTab.historyId)
            this.#chatHistoryDb.updateTabOpenState(tabId, true)
            this.#sendPinnedContext(tabId)

            // Restore per-tab preferences (model selection and agentic coding mode)
            const preferences = this.#chatHistoryDb.getTabPreferences(selectedTab.historyId)
            // Update the execution state before displaying the restored mode. The
            // history mapping is not available when the client first adds this tab.
            const pairProgrammingMode = this.#chatHistoryDb.getEffectiveTabPairProgrammingMode(tabId)
            this.#restorePairProgrammingMode(tabId, pairProgrammingMode)
            if (preferences.modelId !== undefined || preferences.pairProgrammingMode !== undefined) {
                // Validate modelId against current available models
                let validModelId = preferences.modelId
                if (preferences.modelId !== undefined) {
                    const cachedModels = this.#chatHistoryDb.getCachedModels()
                    const isValidModel = cachedModels?.models?.some(m => m.id === preferences.modelId)

                    if (!isValidModel) {
                        // Model is invalid or no longer available, fall back to default
                        validModelId = cachedModels?.defaultModelId
                        this.#features.logging.warn(
                            `Restored modelId "${preferences.modelId}" is invalid. Falling back to default: "${validModelId}"`
                        )
                    }
                }

                this.#features.chat.chatOptionsUpdate({
                    tabId,
                    ...(validModelId !== undefined ? { modelId: validModelId } : {}),
                    ...(preferences.pairProgrammingMode !== undefined
                        ? { pairProgrammingMode: preferences.pairProgrammingMode }
                        : {}),
                })
            }
        }
    }

    /**
     * When IDE is opened, restore chats that were previously open in IDE for the current workspace.
     */
    async loadChats() {
        const isJupyterLab = this.isJupyterLabEnvironment()

        // For non-JupyterLab environments, prevent multiple loads
        if (!isJupyterLab && this.#loadedChats) {
            return
        }

        if (!isJupyterLab) {
            this.#loadedChats = true
        }

        const openConversations = this.#chatHistoryDb.getOpenTabs()
        if (openConversations) {
            for (const conversation of openConversations) {
                await this.restoreTab(conversation)
            }
            this.#telemetryService.emitLoadHistory({
                amazonqTimeToLoadHistory: this.#chatHistoryDb.getLoadTime() ?? -1,
                amazonqHistoryFileSize: this.#chatHistoryDb.getDatabaseFileSize() ?? -1,
                openTabCount: openConversations.length,
                languageServerVersion: this.#features.runtime.serverInfo.version,
                result: 'Succeeded',
            })
        }
    }

    /**
     * Determines if the environment is JupyterLab.
     */
    private isJupyterLabEnvironment(): boolean {
        try {
            return process.env.SAGEMAKER_APP_TYPE_LOWERCASE === JUPYTERLAB_APP_TYPE_VALUE
        } catch (error) {
            this.#features.logging.error(`Failed to read SAGEMAKER_APP_TYPE_LOWERCASE environment variable: ${error}`)
            return false
        }
    }

    public static enableChatExport(params?: InitializeParams) {
        if (params?.initializationOptions?.aws?.awsClientCapabilities?.window?.showSaveFileDialog) {
            // Export Chat UX flow relies on show Save File dialog protocol supported by client
            return true
        }

        return false
    }

    public static enableShowLogs(params?: InitializeParams) {
        if (params?.initializationOptions?.aws?.awsClientCapabilities?.window?.showLogs) {
            // Export Chat UX flow relies on show Save File dialog protocol supported by client
            return true
        }

        return false
    }
}
