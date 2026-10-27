import * as fs from 'fs'
import * as path from 'path'
import { FSWatcher, watch } from 'chokidar'
import {
    ContextCommand,
    ContextCommandGroup,
    FilterContextCommandsParams,
    FilterContextCommandsResult,
} from '@aws/language-server-runtimes/protocol'
import { Disposable } from 'vscode-languageclient/node'
import { Chat, Logging, Lsp, Workspace } from '@aws/language-server-runtimes/server-interface'
import { getCodeSymbolDescription, getUserPromptsDirectory, promptFileExtension } from './contextUtils'
import { ContextCommandItem } from 'local-indexing'
import { LocalProjectContextController } from '../../../shared/localProjectContextController'
import { URI } from 'vscode-uri'
import { activeFileCmd } from './additionalContextProvider'

/**
 * Maximum items in the initial `sendContextCommands` push.
 * The client shows these when the user presses `@` before typing.
 * Server-side filtering (onFilterContextCommands) searches the full set.
 */
export const CONTEXT_COMMAND_PAYLOAD_CAP = 2000

/** Maximum number of items returned by a single filter request. */
export const MAX_FILTER_RESULTS = 2000

/**
 * Score a candidate string against a search term.
 * Mirrors the scoring tiers used by mynah-ui's filterQuickPickItems:
 *   exact=100, prefix=80, word-start=60, contains=40, no-match=0
 */
export function calculateItemScore(text: string, searchTerm: string): number {
    const normalizedText = text.toLowerCase()
    const normalizedTerm = searchTerm.toLowerCase()

    if (normalizedText === normalizedTerm) return 100
    if (normalizedText.startsWith(normalizedTerm)) return 80
    if (normalizedText.split(/[\s/\\._\-]/).some(word => word.startsWith(normalizedTerm))) return 60
    if (normalizedText.includes(normalizedTerm)) return 40
    return 0
}

/**
 * Return the display name used by the picker for a given context command item.
 * Files/folders → basename of relativePath, code → symbol name.
 */
function getDisplayName(item: ContextCommandItem): string {
    if (item.symbol) return item.symbol.name
    return path.basename(item.relativePath)
}

/** Check whether the underlying file/folder still exists on disk. */
function existsOnDisk(item: ContextCommandItem): boolean {
    return fs.existsSync(path.join(item.workspaceFolder, item.relativePath))
}

export class ContextCommandsProvider implements Disposable {
    private promptFileWatcher?: FSWatcher
    private codeSymbolsPending = true
    private codeSymbolsFailed = false
    private filesAndFoldersPending = true
    private filesAndFoldersFailed = false
    private initialStateSent = false
    constructor(
        private readonly logging: Logging,
        private readonly chat: Chat,
        private readonly workspace: Workspace,
        private readonly lsp: Lsp
    ) {
        this.registerPromptFileWatcher()
        this.registerContextCommandHandler().catch(e =>
            this.logging.error(`Error registering context command handler: ${e}`)
        )
        this.registerFilterHandler()
    }

    onReady() {
        if (!this.initialStateSent) {
            this.initialStateSent = true
            void this.processContextCommandUpdate([]).catch(e =>
                this.logging.error(`Failed to send initial context commands: ${e}`)
            )
        }
    }

    private async registerContextCommandHandler() {
        try {
            const controller = await LocalProjectContextController.getInstance()
            controller.onContextItemsUpdated = async contextItems => {
                await this.processContextCommandUpdate(contextItems)
            }
        } catch (e) {
            this.logging.warn(`Error processing context command update: ${e}`)
        }
    }

    registerPromptFileWatcher() {
        this.promptFileWatcher = watch(getUserPromptsDirectory(), {
            persistent: true,
            interval: 2000,
            ignoreInitial: true,
        })

        this.promptFileWatcher.on('add', async () => {
            await this.processContextCommandUpdate(await this.getFreshItems())
        })

        this.promptFileWatcher.on('unlink', async () => {
            await this.processContextCommandUpdate(await this.getFreshItems())
        })
    }

    async getUserPromptsCommand(): Promise<ContextCommand[]> {
        const createPromptCommand = {
            command: 'Create a new prompt',
            id: 'create-saved-prompt',
            icon: 'list-add',
        }
        try {
            const userPromptsDirectory = getUserPromptsDirectory()
            const directoryExists = await this.workspace.fs.exists(userPromptsDirectory)
            if (directoryExists) {
                const files = await this.workspace.fs.readdir(userPromptsDirectory)
                const systemPromptFiles = files.filter(file => file.name.endsWith(promptFileExtension))
                const promptCommands = systemPromptFiles.map(
                    file =>
                        ({
                            command: path.basename(file.name, promptFileExtension),
                            icon: 'magic',
                            label: 'file',
                            id: 'prompt',
                            route: [userPromptsDirectory, file.name],
                        }) as ContextCommand
                )
                promptCommands.push(createPromptCommand)
                return promptCommands
            } else {
                return [createPromptCommand]
            }
        } catch (e) {
            this.logging.warn(`Error reading user prompts directory: ${e}`)
            return [createPromptCommand]
        }
    }

    private registerFilterHandler() {
        this.chat.onFilterContextCommands(
            async (params: FilterContextCommandsParams): Promise<FilterContextCommandsResult> => {
                const items = await this.getFreshItems()
                const searchTerm = params.searchTerm?.trim() ?? ''

                if (!searchTerm) {
                    const capped = this.capItems(items.filter(existsOnDisk))
                    const mapped = await this.mapContextCommandItems(capped)
                    return { contextCommandGroups: mapped }
                }

                // Score every cached item and keep only matches (score > 0).
                const scored: { score: number; item: ContextCommandItem }[] = []
                for (let i = 0; i < items.length; i++) {
                    const displayName = getDisplayName(items[i])
                    const score = calculateItemScore(displayName, searchTerm)
                    if (score > 0) {
                        scored.push({ score, item: items[i] })
                    }
                }

                scored.sort((a, b) => b.score - a.score || getDisplayName(a.item).localeCompare(getDisplayName(b.item)))
                const filtered = scored
                    .filter(s => existsOnDisk(s.item))
                    .slice(0, MAX_FILTER_RESULTS)
                    .map(s => s.item)
                this.logging.log(
                    `onFilterContextCommands: searchTerm="${searchTerm}", matched=${scored.length}, returning=${filtered.length}`
                )
                const mapped = await this.mapContextCommandItems(filtered)
                return { contextCommandGroups: mapped }
            }
        )
    }

    /**
     * Cap items with reserved budgets for folders and code symbols so neither
     * is starved by file-heavy repos. Default split is 25/25/50 (folders /
     * code / files); slack from an under-filled folder or code budget flows
     * automatically into the file budget via the subtraction below.
     *
     * NOTE: this only affects the **empty-search** picker view (initial open).
     * The non-empty filter path scores every item in the full indexer set —
     * a search term will find a code symbol or file regardless of whether it
     * fit into the cap.
     */
    private capItems(items: ContextCommandItem[]): ContextCommandItem[] {
        const folders = items.filter(i => i.type === 'folder')
        const code = items.filter(i => i.type === 'code')
        const files = items.filter(i => i.type === 'file')
        const folderBudget = Math.min(folders.length, Math.ceil(CONTEXT_COMMAND_PAYLOAD_CAP * 0.25))
        const codeBudget = Math.min(code.length, Math.ceil(CONTEXT_COMMAND_PAYLOAD_CAP * 0.25))
        const fileBudget = CONTEXT_COMMAND_PAYLOAD_CAP - folderBudget - codeBudget
        return [...folders.slice(0, folderBudget), ...code.slice(0, codeBudget), ...files.slice(0, fileBudget)]
    }

    /**
     * Pull fresh items from the indexer. Returns empty array on failure.
     */
    private async getFreshItems(): Promise<ContextCommandItem[]> {
        try {
            const controller = await LocalProjectContextController.getInstance()
            return await controller.getContextCommandItems()
        } catch (e) {
            this.logging.error(`Error fetching fresh context command items: ${e}`)
            return []
        }
    }

    async processContextCommandUpdate(items: ContextCommandItem[]) {
        const capped = this.capItems(items.filter(existsOnDisk))
        const allItems = await this.mapContextCommandItems(capped)
        this.chat.sendContextCommands({ contextCommandGroups: allItems })
    }

    async mapContextCommandItems(items: ContextCommandItem[]): Promise<ContextCommandGroup[]> {
        let imageContextEnabled =
            this.lsp.getClientInitializeParams()?.initializationOptions?.aws?.awsClientCapabilities?.q
                ?.imageContextEnabled === true
        const folderCmds: ContextCommand[] = []
        const folderCmdGroup: ContextCommand = {
            command: 'Folders',
            children: [
                {
                    groupName: 'Folders',
                    commands: folderCmds,
                },
            ],
            description: 'Add all files in a folder to context',
            icon: 'folder',
            disabledText: this.filesAndFoldersFailed ? 'failed' : this.filesAndFoldersPending ? 'pending' : undefined,
        }

        const fileCmds: ContextCommand[] = [activeFileCmd]
        const fileCmdGroup: ContextCommand = {
            command: 'Files',
            children: [
                {
                    groupName: 'Files',
                    commands: fileCmds,
                },
            ],
            description: 'Add a file to context',
            icon: 'file',
            disabledText: this.filesAndFoldersFailed ? 'failed' : this.filesAndFoldersPending ? 'pending' : undefined,
        }

        const codeCmds: ContextCommand[] = []
        const codeCmdGroup: ContextCommand = {
            command: 'Code',
            children: [
                {
                    groupName: 'Code',
                    commands: codeCmds,
                },
            ],
            description: 'Add code to context',
            icon: 'code-block',
            disabledText: this.codeSymbolsFailed ? 'failed' : this.codeSymbolsPending ? 'pending' : undefined,
        }

        const promptCmds: ContextCommand[] = []
        const promptCmdGroup: ContextCommand = {
            command: 'Prompts',
            children: [
                {
                    groupName: 'Prompts',
                    commands: promptCmds,
                },
            ],
            description: 'Add a saved prompt to context',
            icon: 'magic',
        }

        const imageCmdGroup: ContextCommand = {
            command: 'Image',
            description: 'Add image to context',
            icon: 'image',
            placeholder: 'Select an image file',
        }

        const commands = [folderCmdGroup, fileCmdGroup, codeCmdGroup, promptCmdGroup]

        if (imageContextEnabled) {
            commands.push(imageCmdGroup)
        }

        const allCommands: ContextCommandGroup[] = [
            {
                commands: commands,
            },
        ]

        for (const item of items) {
            const wsFolderName = path.basename(item.workspaceFolder)
            let baseItem = {
                command: path.basename(item.relativePath),
                description: path.join(wsFolderName, item.relativePath),
                route: [item.workspaceFolder, item.relativePath],
                id: item.id,
            }
            if (item.type === 'file') {
                fileCmds.push({
                    ...baseItem,
                    label: 'file',
                    icon: 'file',
                })
            } else if (item.type === 'folder') {
                folderCmds.push({
                    ...baseItem,
                    label: 'folder',
                    icon: 'folder',
                })
            } else if (item.symbol) {
                codeCmds.push({
                    ...baseItem,
                    command: item.symbol.name,
                    description: getCodeSymbolDescription(item, true),
                    label: 'code',
                    icon: 'code-block',
                })
            } else if (item.type === 'image') {
                fileCmds.push({
                    ...baseItem,
                    label: 'image',
                    icon: 'image',
                })
            }
        }
        const userPromptsItem = await this.getUserPromptsCommand()
        promptCmds.push(...userPromptsItem)
        return allCommands
    }

    async maybeUpdateCodeSymbols() {
        try {
            const needUpdate = await (
                await LocalProjectContextController.getInstance()
            ).shouldUpdateContextCommandSymbolsOnce()
            if (needUpdate) {
                this.codeSymbolsPending = false
                const items = await (await LocalProjectContextController.getInstance()).getContextCommandItems()
                await this.processContextCommandUpdate(items)
            }
        } catch (error) {
            this.codeSymbolsFailed = true
            this.codeSymbolsPending = false
            await this.processContextCommandUpdate([])
            throw error
        }
    }

    setFilesAndFoldersPending(value: boolean) {
        this.filesAndFoldersPending = value
    }

    setFilesAndFoldersFailed(value: boolean) {
        this.filesAndFoldersFailed = value
        if (value) {
            this.filesAndFoldersPending = false
        }
    }

    dispose() {
        void this.promptFileWatcher?.close()
    }
}
