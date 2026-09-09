import {
    FileDetails,
    FileList,
    ContextCommand,
    ListRulesParams,
    ListRulesResult,
    RuleClickParams,
    RuleClickResult,
    RulesFolder,
    PinnedContextParams,
    WorkspaceFolder,
} from '@aws/language-server-runtimes/protocol'
import { AdditionalContextPrompt, ContextCommandItem, ContextCommandItemType } from 'local-indexing'
import * as path from 'path'
import {
    AdditionalContentEntryAddition,
    additionalContextMaxLength,
    TriggerContext,
    workspaceChunkMaxSize,
} from './agenticChatTriggerContext'
import { URI } from 'vscode-uri'
import { pathUtils, workspaceUtils } from '@aws/lsp-core'
import {
    additionalContentNameLimit,
    getUserPromptsDirectory,
    getInitialContextInfo,
    promptFileExtension,
    getCodeSymbolDescription,
} from './contextUtils'
import { LocalProjectContextController } from '../../../shared/localProjectContextController'
import { Features } from '../../types'
import { ChatDatabase } from '../tools/chatDb/chatDb'
import { ChatMessage, ImageBlock, ImageFormat } from '@amzn/codewhisperer-streaming'
import { getRelativePathWithUri, getRelativePathWithWorkspaceFolder } from '../../workspaceContext/util'
import { isSupportedImageExtension, MAX_IMAGE_CONTEXT_COUNT } from '../../../shared/imageVerification'
import { MemoryBankController } from './memorybank/memoryBankController'

export const ACTIVE_EDITOR_CONTEXT_ID = 'active-editor'

export const activeFileCmd = {
    command: 'Active file',
    id: ACTIVE_EDITOR_CONTEXT_ID,
    icon: 'file',
    description: 'Reference active text file',
}

type ContextCommandInfo = ContextCommand & { pinned: boolean }

/**
 * AdditionalContextProvider manages context information for Amazon Q chat sessions.
 * It handles workspace rules, pinned context, and file context for chat interactions.
 * The provider retrieves available rules whenever requested by the client.
 */
export class AdditionalContextProvider {
    private totalRulesCount: number = 0

    /**
     * Callback to retrieve resource paths from the agent configuration (default.json).
     * Injected via constructor to avoid a direct import of McpManager, which would pull
     * Node.js-only dependencies (node:process, node:stream via @modelcontextprotocol/sdk)
     * into the webworker webpack bundle and break packaging.
     */
    private readonly getResources: () => string[]

    constructor(
        private readonly features: Features,
        private readonly chatDb: ChatDatabase,
        getResources?: () => string[]
    ) {
        this.getResources = getResources ?? (() => [])
    }

    /**
     * Recursively collects markdown files from a directory and its subdirectories
     * @param workspaceFolder The root workspace folder path
     * @param dirPath The directory to search in
     * @param rulesFiles Array to collect the found files
     */
    private async collectMarkdownFilesRecursively(
        workspaceFolder: string,
        dirPath: string,
        rulesFiles: ContextCommandItem[],
        seenIds?: Set<string>
    ): Promise<void> {
        const entries = await this.features.workspace.fs.readdir(dirPath)

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name)

            if (entry.isDirectory()) {
                // Recursively search subdirectories
                await this.collectMarkdownFilesRecursively(workspaceFolder, fullPath, rulesFiles, seenIds)
            } else if (entry.isFile() && entry.name.endsWith(promptFileExtension)) {
                // Skip duplicate rules (same file resolved from multiple workspace folders)
                if (seenIds?.has(fullPath)) {
                    continue
                }
                seenIds?.add(fullPath)
                // Add markdown file to the list
                const relativePath = path.relative(workspaceFolder, fullPath)
                rulesFiles.push({
                    workspaceFolder: workspaceFolder,
                    type: 'file',
                    relativePath,
                    id: fullPath,
                })
            }
        }
    }
    /**
     * Filesystem fallback for reading context command prompts when the local indexing library
     * (vecLib) is not available. Reads file contents directly from the filesystem.
     *
     * This ensures that rules in .amazonq/rules, README.md, AmazonQ.md, and other context files
     * are still loaded even when the indexing library fails to initialize (e.g., in certain
     * remote development environments like Red Hat OpenShift Dev Spaces).
     *
     * @param contextCommandItems The context command items to read content for
     * @returns Array of AdditionalContextPrompt with file contents read from disk
     */
    private async readContextCommandPromptsFromFilesystem(
        contextCommandItems: ContextCommandItem[]
    ): Promise<AdditionalContextPrompt[]> {
        const prompts: AdditionalContextPrompt[] = []

        for (const item of contextCommandItems) {
            try {
                // The item.id contains the full file path for workspace rules
                const filePath = item.id
                if (!filePath) {
                    continue
                }

                const fileExists = await this.features.workspace.fs.exists(filePath)
                if (!fileExists) {
                    continue
                }

                const content = await this.features.workspace.fs.readFile(filePath, { encoding: 'utf-8' })
                const fileName = path.basename(filePath, promptFileExtension)

                prompts.push({
                    filePath: filePath,
                    relativePath: item.relativePath,
                    content: content,
                    name: fileName,
                    description: '',
                    startLine: -1,
                    endLine: -1,
                })
            } catch (error) {
                this.features.logging.warn(`Failed to read context file from filesystem: ${item.id}: ${error}`)
            }
        }

        if (prompts.length > 0) {
            this.features.logging.info(
                `Filesystem fallback: successfully loaded ${prompts.length} context file(s) directly from disk`
            )
        }

        return prompts
    }

    /**
     * Resolves a resource URI (file://relative or file:///absolute) against a workspace folder.
     * Returns the absolute fs path, or undefined if the resource is not a file:// URI.
     */
    private resolveResourcePath(resource: string, workspaceFolder: string): string | undefined {
        if (!resource.startsWith('file://')) {
            return undefined
        }
        const withoutScheme = resource.slice('file://'.length)
        // Absolute path: file:///abs/path or file://C:/... on Windows
        if (withoutScheme.startsWith('/') || /^[a-zA-Z]:/.test(withoutScheme)) {
            return path.normalize(withoutScheme)
        }
        // Relative path: file://relative/path
        return path.join(workspaceFolder, withoutScheme)
    }

    /**
     * Internal method to collect workspace rules without tab filtering.
     * Resolves paths from agentConfig.resources when available, falling back to hardcoded defaults.
     */
    private async collectWorkspaceRulesInternal(): Promise<ContextCommandItem[]> {
        const rulesFiles: ContextCommandItem[] = []
        // Track seen rule IDs (resolved absolute paths) to avoid duplicates when
        // multiple workspace folders resolve to the same file (e.g. absolute-path resources)
        const seenIds = new Set<string>()
        let workspaceFolders = workspaceUtils.getWorkspaceFolderPaths(this.features.workspace)

        if (!workspaceFolders.length) {
            return rulesFiles
        }

        // Get resources from agentConfig via injected callback
        let resources: string[]
        try {
            resources = this.getResources()
        } catch {
            resources = []
        }

        // Fall back to default resources if none configured
        if (resources.length === 0) {
            resources = ['file://AmazonQ.md', 'file://README.md', 'file://.amazonq/rules/**/*.md']
        }

        for (const workspaceFolder of workspaceFolders) {
            for (const resource of resources) {
                const resolved = this.resolveResourcePath(resource, workspaceFolder)
                if (!resolved) {
                    continue
                }

                // Handle glob pattern for rules directory
                if (resolved.endsWith(path.join('.amazonq', 'rules', '**', '*.md'))) {
                    const rulesPath = path.join(workspaceFolder, '.amazonq', 'rules')
                    const folderExists = await this.features.workspace.fs.exists(rulesPath)
                    if (folderExists) {
                        await this.collectMarkdownFilesRecursively(workspaceFolder, rulesPath, rulesFiles, seenIds)
                    }
                    continue
                }

                // Handle absolute paths (custom resources outside workspace)
                const isAbsolute = path.isAbsolute(
                    resource.startsWith('file://') ? resource.slice('file://'.length) : resource
                )
                if (isAbsolute) {
                    if (seenIds.has(resolved)) {
                        continue
                    }
                    const exists = await this.features.workspace.fs.exists(resolved)
                    if (exists) {
                        seenIds.add(resolved)
                        rulesFiles.push({
                            workspaceFolder: path.dirname(resolved),
                            type: 'file',
                            relativePath: path.basename(resolved),
                            id: resolved,
                        })
                    }
                    continue
                }

                // Handle workspace-relative file
                if (seenIds.has(resolved)) {
                    continue
                }
                const exists = await this.features.workspace.fs.exists(resolved)
                if (exists) {
                    seenIds.add(resolved)
                    rulesFiles.push({
                        workspaceFolder,
                        type: 'file',
                        relativePath: path.relative(workspaceFolder, resolved),
                        id: resolved,
                    })
                }
            }
        }

        return rulesFiles
    }

    async collectWorkspaceRules(tabId?: string): Promise<ContextCommandItem[]> {
        // Always collect rules directly from the filesystem
        const rulesFiles = await this.collectWorkspaceRulesInternal()
        this.totalRulesCount = rulesFiles.length

        // If no tabId, return all rules without filtering
        if (!tabId) {
            return rulesFiles
        }

        // Filter rules based on user's rules preferences for current tab
        let rulesState = this.chatDb.getRules(tabId) || { folders: {}, rules: {} }

        // Ensure memory bank files are active by default when first discovered
        const memoryBankFiles = rulesFiles.filter(rule => rule.id?.includes('memory-bank'))
        if (memoryBankFiles.length > 0) {
            let needsUpdate = false

            const memoryBankFolderName = 'memory-bank'
            if (rulesState.folders[memoryBankFolderName] === undefined) {
                rulesState.folders[memoryBankFolderName] = true
                needsUpdate = true
            }

            memoryBankFiles.forEach(file => {
                if (rulesState.rules[file.id] === undefined) {
                    rulesState.rules[file.id] = true
                    needsUpdate = true
                }
            })

            if (needsUpdate) {
                this.chatDb.setRules(tabId, rulesState)
            }
        }

        return rulesFiles.filter(rule => {
            // If the rule has an explicit state in rulesState, use that value
            if (rulesState.rules[rule.id] !== undefined) {
                return rulesState.rules[rule.id]
            }

            // Otherwise, check the parent folder's state
            const dirPath = path.dirname(rule.relativePath)
            const folderName = dirPath === '.' ? '' : dirPath

            // If folder state is explicitly set to false, the rule inherits that state
            if (rulesState.folders[folderName] === false) {
                return false
            }

            // Default to true for all other cases
            return true
        })
    }

    getContextType(prompt: AdditionalContextPrompt): string {
        if (prompt.name === 'symbol') {
            return 'code'
        }
        if (prompt.filePath.endsWith(promptFileExtension)) {
            if (
                pathUtils.isInDirectory(path.join('.amazonq', 'rules'), prompt.relativePath) ||
                path.basename(prompt.relativePath) === 'AmazonQ.md' ||
                path.basename(prompt.relativePath) === 'README.md'
            ) {
                return 'rule'
            } else if (pathUtils.isInDirectory(getUserPromptsDirectory(), prompt.filePath)) {
                return 'prompt'
            }
            // Custom resources from agentConfig.resources (absolute paths outside workspace)
            try {
                const resources = this.getResources()
                if (
                    resources.some(
                        (r: string) =>
                            r.startsWith('file:///') && prompt.filePath === path.normalize(r.slice('file://'.length))
                    )
                ) {
                    return 'rule'
                }
            } catch {
                // ignore
            }
        }
        return 'file'
    }

    /**
     * Retrieves and processes additional context for Amazon Q chat sessions.
     *
     * This method combines various types of context including workspace rules, pinned context,
     * and explicit user-specified context (@-mentions) to send in GenerateAssistantResponse API.
     *
     */
    async getAdditionalContext(
        triggerContext: TriggerContext,
        tabId: string,
        context?: ContextCommand[],
        prompt?: string
    ): Promise<AdditionalContentEntryAddition[]> {
        triggerContext.contextInfo = getInitialContextInfo()

        /**
         * Explicit context specified by user in a prompt (using `@`)
         * Sent in GenerateAssistantResponse request: conversationState.currentMessage.userInputMessageContext.editorState.relevantDocuments
         */
        const promptContextCommands: ContextCommandItem[] = []
        /**
         * Non message-specific context, such as pinned context and workspace rules
         * Sent in GenerateAssistantResponse request: First message in conversationState.history
         */
        const pinnedContextCommands: ContextCommandItem[] = []

        const workspaceRules = await this.collectWorkspaceRules(tabId)
        let workspaceFolderPath = triggerContext.workspaceFolder?.uri
            ? URI.parse(triggerContext.workspaceFolder.uri).fsPath
            : workspaceUtils.getWorkspaceFolderPaths(this.features.workspace)[0]

        if (workspaceRules.length > 0) {
            // Check if this is a memory bank generation request
            const isMemoryBankRequest = prompt
                ? new MemoryBankController(this.features).isMemoryBankCreationRequest(prompt)
                : false

            let rulesToInclude = workspaceRules

            if (isMemoryBankRequest) {
                // Exclude memory bank files from context when regenerating memory bank
                const memoryBankFiles = workspaceRules.filter(rule => rule.id?.includes('memory-bank'))
                rulesToInclude = workspaceRules.filter(rule => !rule.id?.includes('memory-bank'))

                if (memoryBankFiles.length > 0) {
                    this.features.logging.info(
                        `Memory Bank: excluding ${memoryBankFiles.length} existing memory bank files from context`
                    )
                }
            } else {
                // Normal behavior: include all workspace rules (including memory bank files)
                const memoryBankFiles = workspaceRules.filter(rule => rule.id?.includes('memory-bank'))
                if (memoryBankFiles.length > 0) {
                    this.features.logging.info(`Including ${memoryBankFiles.length} memory bank files in chat context`)
                }
            }

            // Add the filtered rules to pinned context
            pinnedContextCommands.push(...rulesToInclude)
        }

        // Merge pinned context with context added to prompt, avoiding duplicates
        let contextInfo: ContextCommandInfo[] = (context?.map(item => ({ ...item, pinned: false })) || []).concat(
            this.chatDb
                .getPinnedContext(tabId)
                .filter(item =>
                    item.label === 'image'
                        ? !context?.find(
                              innerItem => innerItem.label === 'image' && innerItem.description === item.description
                          )
                        : !context?.find(innerItem => item.id === innerItem.id)
                )
                .map(item => ({ ...item, pinned: true }))
        )
        // If Active File context pill was removed from pinned context, remove it from payload
        if (!contextInfo?.find(item => item.id === ACTIVE_EDITOR_CONTEXT_ID)) {
            triggerContext.text = undefined
            triggerContext.cursorState = undefined
        } else {
            // Remove Active File from context list since its contents have already been added to triggerContext.text
            contextInfo = contextInfo.filter(item => item.id !== ACTIVE_EDITOR_CONTEXT_ID)
        }

        // Handle code symbol ID mismatches between indexing sessions
        // When a workspace is re-indexed, code symbols receive new IDs
        // If a pinned symbol's ID is no longer found in the current index:
        // 1. Extract the symbol's name, filepath, and kind (without line numbers)
        // 2. Search for a matching symbol in the current index with the same attributes
        // 3. Update the pinned symbol's ID to reference the newly indexed equivalent
        try {
            let pinnedCodeItems = contextInfo.filter(item => item.pinned).filter(item => item.label === 'code')
            if (pinnedCodeItems.length > 0) {
                const localProjectContextController = await LocalProjectContextController.getInstance()

                const availableContextItems = await localProjectContextController.getContextCommandItems()
                const availableCodeContextItems = availableContextItems.filter(item => item.symbol)
                for (const command of pinnedCodeItems) {
                    // First check if the pinned symbol's ID still exists in the current index
                    let matchedId = availableCodeContextItems.find(item => item.id === command.id)
                    if (!matchedId) {
                        // If ID no longer exists, try to find a matching symbol by name and description
                        // Remove line numbers from description for comparison
                        const pinnedItemDescription = command.description?.replace(/,\s*L\d+[-]\d+$/, '')
                        if (pinnedItemDescription) {
                            const matchedDescription = availableCodeContextItems.find(availableItem => {
                                let availableItemDescription = getCodeSymbolDescription(availableItem, false)
                                return (
                                    command.command === availableItem.symbol?.name &&
                                    availableItemDescription === pinnedItemDescription
                                )
                            })

                            if (matchedDescription) {
                                command.id = matchedDescription.id
                            }
                        }
                    }
                }
            }
        } catch {
            // Do nothing if local project indexing fails
        }

        const contextCounts = getInitialContextInfo()

        promptContextCommands.push(
            ...this.mapToContextCommandItems(
                contextInfo.filter(item => !item.pinned),
                workspaceFolderPath
            )
        )

        pinnedContextCommands.push(
            ...this.mapToContextCommandItems(
                contextInfo.filter(item => item.pinned),
                workspaceFolderPath
            )
        )

        for (const c of contextInfo) {
            if (c.id === 'prompt') {
                c.pinned
                    ? contextCounts.pinnedContextCount.promptContextCount++
                    : contextCounts.contextCount.promptContextCount++
            } else if (c.label === 'file') {
                c.pinned
                    ? contextCounts.pinnedContextCount.fileContextCount++
                    : contextCounts.contextCount.fileContextCount++
            } else if (c.label === 'folder') {
                c.pinned
                    ? contextCounts.pinnedContextCount.folderContextCount++
                    : contextCounts.contextCount.folderContextCount++
            } else if (c.label === 'code') {
                c.pinned
                    ? contextCounts.pinnedContextCount.codeContextCount++
                    : contextCounts.contextCount.codeContextCount++
            }
        }
        triggerContext.contextInfo = {
            ...triggerContext.contextInfo,
            contextCount: {
                ...contextCounts.contextCount,
                activeRuleContextCount: workspaceRules.length,
                totalRuleContextCount: this.totalRulesCount,
            },

            pinnedContextCount: contextCounts.pinnedContextCount,
        }

        if (promptContextCommands.length === 0 && pinnedContextCommands.length === 0) {
            // image context does not come from workspace
            const imageContext = this.getImageContextEntries(tabId, context)
            return [...imageContext.nonPinned, ...imageContext.pinned]
        }

        let promptContextPrompts: AdditionalContextPrompt[] = []
        let pinnedContextPrompts: AdditionalContextPrompt[] = []
        try {
            const localProjectContextController = await LocalProjectContextController.getInstance()
            promptContextPrompts = await localProjectContextController.getContextCommandPrompt(promptContextCommands)
            pinnedContextPrompts = await localProjectContextController.getContextCommandPrompt(pinnedContextCommands)
        } catch (error) {
            this.features.logging.info(
                `LocalProjectContextController unavailable, using filesystem fallback for context: ${error}`
            )
        }

        // Filesystem fallback: if LocalProjectContextController returned empty results but we have
        // context commands to process, read the file contents directly from the filesystem.
        // This handles environments where the local indexing library (vecLib) is not available.
        if (promptContextPrompts.length === 0 && promptContextCommands.length > 0) {
            promptContextPrompts = await this.readContextCommandPromptsFromFilesystem(promptContextCommands)
        }
        if (pinnedContextPrompts.length === 0 && pinnedContextCommands.length > 0) {
            pinnedContextPrompts = await this.readContextCommandPromptsFromFilesystem(pinnedContextCommands)
        }

        const contextEntry: AdditionalContentEntryAddition[] = []
        let ruleContextLength = 0
        let fileContextLength = 0
        let promptContextLength = 0
        let codeContextLength = 0
        for (const prompt of promptContextPrompts
            .map(item => ({ ...item, pinned: false }))
            .concat(pinnedContextPrompts.map(item => ({ ...item, pinned: true })))
            .slice(0, additionalContextMaxLength)) {
            const contextType = this.getContextType(prompt)

            const relativePath = prompt.filePath.startsWith(getUserPromptsDirectory())
                ? path.basename(prompt.filePath)
                : path.relative(workspaceFolderPath, prompt.filePath)
            const entry = {
                name: prompt.name.substring(0, additionalContentNameLimit),
                description: '',
                innerContext: prompt.content.substring(0, workspaceChunkMaxSize),
                type: contextType,
                path: prompt.filePath,
                relativePath: relativePath,
                startLine: prompt.startLine,
                endLine: prompt.endLine,
                pinned: prompt.pinned,
            }
            contextEntry.push(entry)

            if (contextType === 'rule') {
                ruleContextLength += prompt.content.length
            } else if (contextType === 'prompt') {
                promptContextLength += prompt.content.length
            } else if (contextType === 'code') {
                codeContextLength += prompt.content.length
            } else {
                fileContextLength += prompt.content.length
            }
        }
        triggerContext.contextInfo.contextLength = {
            ruleContextLength,
            fileContextLength,
            promptContextLength,
            codeContextLength,
        }
        const imageContext = this.getImageContextEntries(tabId, context)
        // Build maps for fast lookup
        const docEntries = Array.isArray(contextEntry) ? contextEntry : [contextEntry]
        const docMap = new Map(docEntries.map(entry => [entry.path, entry]))
        const imageMap = new Map(imageContext.nonPinned.map(entry => [entry.description, entry]))

        // Maintain order of context (excluding pinned) using contextInfo
        const ordered: any[] = []
        for (const item of (contextInfo ?? []).filter(c => !c.pinned)) {
            if (item.label === 'image') {
                const image = imageMap.get(item.description)
                if (image) ordered.push(image)
            } else {
                const itemPath = item.route ? path.join(...item.route) : undefined
                if (itemPath) {
                    const doc = docMap.get(itemPath)
                    if (doc) {
                        ordered.push(doc)
                    } else if (item.label === 'folder') {
                        // Folder expands into multiple file entries — match all children
                        const children = docEntries.filter(
                            entry => !entry.pinned && entry.path.startsWith(itemPath + path.sep)
                        )
                        ordered.push(...children)
                    }
                }
            }
        }
        // Append pinned context entries (docs and images)
        const pinnedDocs = docEntries.filter(entry => entry.pinned)
        const pinnedImages = imageContext.pinned
        return [...ordered, ...pinnedDocs, ...pinnedImages]
    }

    getFileListFromContext(context: AdditionalContentEntryAddition[]): FileList {
        const fileDetails: Record<string, FileDetails> = {}
        for (const item of context) {
            fileDetails[item.relativePath] = {
                lineRanges: [
                    {
                        first: item.name === 'symbol' ? item.startLine : -1,
                        second: item.name === 'symbol' ? item.endLine : -1,
                    },
                ],
                description: item.path,
                fullPath: item.path,
            }
        }
        const fileList: FileList = {
            filePaths: [...new Set(context.map(item => item.relativePath))],
            details: fileDetails,
        }
        return fileList
    }

    mapToContextCommandItems(context: ContextCommand[], workspaceFolderPath: string): ContextCommandItem[] {
        const contextCommands: ContextCommandItem[] = []
        for (const item of context) {
            if (item.route && item.route.length === 2) {
                contextCommands.push({
                    workspaceFolder: item.route?.[0] ?? workspaceFolderPath,
                    type: item.label ?? '',
                    relativePath: item.route?.[1] ?? '',
                    id: item.id ?? '',
                } as ContextCommandItem)
            }
        }
        return contextCommands
    }

    sendPinnedContext(tabId: string): void {
        let pinnedContextEnabled =
            this.features.lsp.getClientInitializeParams()?.initializationOptions?.aws?.awsClientCapabilities?.q
                ?.pinnedContextEnabled === true
        if (pinnedContextEnabled) {
            let pinnedContext = this.chatDb.getPinnedContext(tabId)
            this.features.chat.sendPinnedContext({
                tabId,
                contextCommandGroups: [
                    {
                        commands: pinnedContext,
                    },
                ],
                showRules: workspaceUtils.getWorkspaceFolderPaths(this.features.workspace).length > 0,
            })
        }
    }

    /**
     * Returns merged image context from params.context and DB, deduplicated and limited to 20 items.
     */
    private getMergedImageContext(contextArr?: ContextCommand[], tabId?: string): ContextCommand[] {
        let mergedContext: ContextCommand[] = contextArr ? [...contextArr] : []
        if (tabId) {
            const pinnedContext = this.chatDb.getPinnedContext(tabId)
            for (const pc of pinnedContext) {
                if (
                    pc.label === 'image' &&
                    !mergedContext.some(c => c.label === 'image' && c.description === pc.description)
                ) {
                    mergedContext.push(pc)
                }
            }
        }
        return mergedContext.slice(0, MAX_IMAGE_CONTEXT_COUNT)
    }

    /**
     * Returns image context items as two arrays: non-pinned and pinned.
     * nonPinned: images from context (pinned: false)
     * pinned: images from DB not present in context (pinned: true)
     */
    public getImageContextEntries(
        tabId: string,
        context?: ContextCommand[]
    ): { nonPinned: AdditionalContentEntryAddition[]; pinned: AdditionalContentEntryAddition[] } {
        const contextImages = (context ?? []).filter(item => item.label === 'image')
        const pinnedImages = this.chatDb
            .getPinnedContext(tabId)
            .filter(item => item.label === 'image')
            .filter(item => !contextImages.find(ctx => ctx.description === item.description))

        const buildPath = (route: string[] | undefined) => {
            if (!route?.length) return ''
            if (route.length === 1) return route[0]
            if (route.length === 2) return `${route[0]}/${route[1]}`
            return ''
        }

        const buildRelativePath = (route: string[] | undefined) => {
            if (!route?.length) return ''
            if (route.length === 1) return route[0]
            if (route.length === 2) return route[1]
            return ''
        }

        const toEntry = (item: any, pinned: boolean) => ({
            name: item.command?.substring(0, additionalContentNameLimit) ?? '',
            description: item.description ?? '',
            innerContext: '',
            type: 'image',
            path: buildPath(item.route),
            relativePath: buildRelativePath(item.route),
            startLine: -1,
            endLine: -1,
            pinned,
        })

        return {
            nonPinned: contextImages.map(item => toEntry(item, false)),
            pinned: pinnedImages.map(item => toEntry(item, true)),
        }
    }

    /**
     * Extracts image blocks from a context array, reading image files and returning them as ImageBlock objects.
     * Optionally, appends pinned image context from chatDb for the given tabId.
     * @param contextArr The context array to extract image blocks from.
     * @param tabId Optional tabId to fetch pinned image context from chatDb.
     */
    public async getImageBlocksFromContext(contextArr?: ContextCommand[], tabId?: string): Promise<ImageBlock[]> {
        const imageBlocks: ImageBlock[] = []

        // Use the helper to get merged and deduplicated image context
        const mergedContext: ContextCommand[] = this.getMergedImageContext(contextArr, tabId)

        // Process all image contexts in mergedContext
        for (const context of mergedContext) {
            if (context.label === 'image' && context.route && context.route.length > 0) {
                try {
                    // Route array handling:
                    // Selected from file dialog: size 1 = full path ["/User/image.jpg"]
                    // From workspaceL size 2 = ["/User", "image.jpg"]
                    const imagePath = context.route.join('/')
                    let format = imagePath.split('.').pop()?.toLowerCase() || ''
                    // Both .jpg and .jpeg files use the exact same JPEG compression algorithm and file structure.
                    if (format === 'jpg') {
                        format = 'jpeg'
                    }
                    if (!isSupportedImageExtension(format)) {
                        this.features.logging.warn(`Unsupported image format: ${format}`)
                        continue
                    }
                    if ('content' in context && context.content) {
                        // Validate content has actual byte data before creating Uint8Array
                        // After JSON deserialization, Uint8Array becomes plain object with numeric keys
                        const values = Object.values(context.content)
                        if (values.length > 0 && values.every((v): v is number => typeof v === 'number')) {
                            imageBlocks.push({
                                format: format as ImageFormat,
                                source: {
                                    bytes: new Uint8Array(values),
                                },
                            })
                            continue
                        }
                        // Invalid content data, fall through to read from file
                        this.features.logging.warn(
                            `Invalid image content data for ${imagePath}, attempting to read from file`
                        )
                    }
                    const fileContent = await this.features.workspace.fs.readFile(imagePath, {
                        encoding: 'binary',
                    })
                    const imageBuffer = Buffer.from(fileContent, 'binary')
                    const imageBytes = new Uint8Array(imageBuffer)
                    imageBlocks.push({
                        format: format as ImageFormat,
                        source: {
                            bytes: imageBytes,
                        },
                    })
                } catch (err) {
                    this.features.logging.error(`Failed to read image file: ${err}`)
                }
            }
        }
        return imageBlocks
    }

    async getRulesFolders(tabId: string): Promise<RulesFolder[]> {
        const workspaceRules = await this.collectWorkspaceRules()
        return this.convertRulesToRulesFolders(workspaceRules, tabId)
    }

    async onRuleClick(params: RuleClickParams): Promise<RuleClickResult> {
        let rulesState = { ...this.chatDb.getRules(params.tabId) }
        if (params.type === 'folder') {
            // Get current state (default to true if not set)
            const currentActive = rulesState.folders[params.id] !== false
            // Toggle the state
            rulesState.folders[params.id] = !currentActive

            // Get all rules in this folder to update their states
            const rulesFolders = await this.getRulesFolders(params.tabId)
            const folder = rulesFolders.find(folder => folder.folderName === params.id)

            if (folder && folder.rules) {
                // Update all rules in this folder to match folder state
                folder.rules.forEach(rule => {
                    rulesState.rules[rule.id] = !currentActive
                })
            }
            this.chatDb.setRules(params.tabId, rulesState)

            return { ...params, success: true }
        } else if (params.type === 'rule') {
            // Get current state (default to true if not set)
            const currentActive = rulesState.rules[params.id] !== false
            // Toggle the state
            rulesState.rules[params.id] = !currentActive

            // Check if we need to update parent folder state
            const rulesFolders = await this.getRulesFolders(params.tabId)
            const folder = rulesFolders.find(folder => folder.rules.some(rule => rule.id === params.id))

            if (folder) {
                // Check if all rules in folder are now active/inactive
                const allRulesInFolder = folder.rules.map(r => r.id)
                const activeRulesCount = allRulesInFolder.filter(ruleId => rulesState.rules[ruleId] !== false).length

                // Update folder state based on its rules
                if (activeRulesCount === 0) {
                    rulesState.folders[folder.folderName || ''] = false
                } else if (activeRulesCount === allRulesInFolder.length) {
                    rulesState.folders[folder.folderName || ''] = true
                }
            }
            this.chatDb.setRules(params.tabId, rulesState)

            return { ...params, success: true }
        }

        return { ...params, success: false }
    }

    async onListRules(params: ListRulesParams): Promise<ListRulesResult> {
        return {
            tabId: params.tabId,
            rules: await this.getRulesFolders(params.tabId),
        }
    }

    onPinnedContextAdd(params: PinnedContextParams) {
        let itemToAdd = params.contextCommandGroups[0]?.commands?.[0]
        if (itemToAdd) {
            this.chatDb.addPinnedContext(params.tabId, itemToAdd)
        }
        this.sendPinnedContext(params.tabId)
    }

    onPinnedContextRemove(params: PinnedContextParams) {
        let itemToRemove = params.contextCommandGroups[0]?.commands?.[0]
        if (itemToRemove) {
            this.chatDb.removePinnedContext(params.tabId, itemToRemove)
        }
        this.sendPinnedContext(params.tabId)
    }

    convertRulesToRulesFolders(workspaceRules: ContextCommandItem[], tabId: string): RulesFolder[] {
        // Check if there's only one workspace folder
        const workspaceFolders = workspaceUtils.getWorkspaceFolderPaths(this.features.workspace)
        const isSingleWorkspace = workspaceFolders.length <= 1

        // Group rules by their parent folder
        const folderMap = new Map<string, ContextCommandItem[]>()

        for (const rule of workspaceRules) {
            // Extract the folder path from the relativePath
            let folderName: string | undefined

            // Get directory path
            const dirPath = path.dirname(rule.relativePath)

            if (isSingleWorkspace) {
                // In single workspace: root files have undefined folder name
                if (dirPath === '.') {
                    folderName = undefined
                } else {
                    // Special handling for memory bank files
                    if (dirPath === '.amazonq/rules/memory-bank') {
                        folderName = 'memory-bank'
                    } else {
                        folderName = dirPath
                    }
                }
            } else {
                // In multi-workspace: include workspace folder name for all files
                // Root files will use the workspace folder name
                // Subdir files will use workspace folder name + subdir
                const workspaceFolderName = path.basename(rule.workspaceFolder)
                folderName =
                    dirPath === '.'
                        ? workspaceFolderName
                        : // Escape backslashes since folderName is displayed in innerHTML
                          path.join(workspaceFolderName, dirPath).replace(/\\/g, '\\\\')
            }

            // Get or create the folder's rule list
            const folderRules = folderMap.get(folderName || '') || []
            folderRules.push(rule)
            folderMap.set(folderName || '', folderRules)
        }

        // Convert the map to RulesFolder array
        const rulesFolders: RulesFolder[] = []
        let rulesState = this.chatDb.getRules(tabId)
        for (const [folderName, rules] of folderMap.entries()) {
            // Map rules to their active states
            const ruleStates = rules.map(rule => {
                const ruleId = rule.id
                // For rule active state:
                // 1. If explicitly set in rules map, use that value
                // 2. Otherwise, new rules are active by default
                const folderDefaultState =
                    rulesState.folders[folderName] !== undefined ? rulesState.folders[folderName] : true

                return rulesState.rules[ruleId] !== undefined ? rulesState.rules[ruleId] : folderDefaultState
            })

            // Determine folder active state
            let folderActive: boolean | 'indeterminate'

            // If explicitly set in folders map, start with that value
            if (rulesState.folders[folderName] !== undefined) {
                folderActive = rulesState.folders[folderName]
            } else {
                // Default to true for new folders
                folderActive = true
            }

            // Check if we need to set indeterminate state
            // Count active and inactive rules
            const activeRules = ruleStates.filter(state => state === true).length
            const inactiveRules = ruleStates.filter(state => state === false).length

            // If there are both active and inactive rules, set to indeterminate
            if (activeRules > 0 && inactiveRules > 0) {
                folderActive = 'indeterminate'
            }

            const rulesFolder: RulesFolder = {
                folderName: folderName || undefined,
                active: folderActive,
                rules: rules.map((rule, index) => {
                    return {
                        name: path.basename(rule.relativePath, promptFileExtension),
                        active: ruleStates[index],
                        id: rule.id,
                    }
                }),
            }

            rulesFolders.push(rulesFolder)
        }

        // Sort the folders: undefined folderName first, then alphabetically
        rulesFolders.sort((a, b) => {
            // If a has undefined folderName, it should come first
            if (a.folderName === undefined) {
                return -1
            }
            // If b has undefined folderName, it should come first
            if (b.folderName === undefined) {
                return 1
            }
            // Otherwise sort alphabetically
            return a.folderName.localeCompare(b.folderName)
        })

        return rulesFolders
    }

    /**
     * Converts pinned context entries into a fake user/assistant message pair for chat history.
     *
     * This utility method takes pinned context entries and formats them into XML structure
     * with appropriate tags based on context type, creating a fake conversation pair that
     * can be prepended to chat history. This allows the assistant to have access to relevant
     * context information throughout the conversation.
     *
     * @param pinnedContext - Array of pinned context entries to convert to chat messages
     * @returns Promise resolving to an array containing the fake user/assistant message pair,
     *          or an empty array if no context is provided
     *
     * The method creates XML-structured content with the following tags:
     * - `<promptInstruction>` - For rules and prompt instructions that must be followed
     * - `<fileContext>` - For file content and documentation
     * - `<codeContext>` - For code symbols, functions, and code snippets
     *
     * The returned fake message pair consists of:
     * 1. User message containing all pinned context wrapped in `<pinnedContext>` XML tags
     * 2. Assistant response message (empty content). API and Model requires every user message to be followed by an assistant response message.
     *
     */
    public async convertPinnedContextToChatMessages(
        pinnedContext?: AdditionalContentEntryAddition[],
        getWorkspaceFolder?: (uri: string) => WorkspaceFolder | null | undefined
    ): Promise<ChatMessage[]> {
        if (!pinnedContext || pinnedContext.length === 0) {
            return []
        }

        // Build the pinned context XML content
        let pinnedContextXml = '<pinnedContext>\n'

        for (const prompt of pinnedContext) {
            const { type, innerContext, path } = prompt

            const workspaceFolder = getWorkspaceFolder?.(URI.file(path).toString())

            let relativePath
            if (workspaceFolder) {
                relativePath = getRelativePathWithWorkspaceFolder(workspaceFolder, path)
            } else {
                relativePath = getRelativePathWithUri(path, workspaceFolder)
            }

            if (type === 'rule' || type === 'prompt') {
                pinnedContextXml += `<promptInstruction>\n<relativeFilePath>\n${relativePath}\n</relativeFilePath>\n<text>\n${innerContext}\n</text>\n</promptInstruction>\n`
            } else if (type === 'file') {
                pinnedContextXml += `<fileContext>\n<relativeFilePath>\n${relativePath}\n</relativeFilePath>\n<text>\n${innerContext}\n</text>\n</fileContext>\n`
            } else if (type === 'code') {
                pinnedContextXml += `<codeContext>\n<relativeFilePath>\n${relativePath}\n</relativeFilePath>\n<text>\n${innerContext}\n</text>\n</codeContext>\n`
            }
        }

        pinnedContextXml += '</pinnedContext>'

        // Create fake user message with pinned context
        const userMessage: ChatMessage = {
            userInputMessage: {
                content: pinnedContextXml,
            },
        }

        // Create fake assistant response
        const assistantMessage: ChatMessage = {
            assistantResponseMessage: {
                content: 'Working...',
            },
        }

        return [userMessage, assistantMessage]
    }
}
