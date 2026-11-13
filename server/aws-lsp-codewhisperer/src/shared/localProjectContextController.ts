import { Logging, WorkspaceFolder, Chat, Workspace } from '@aws/language-server-runtimes/server-interface'
import { dirname } from 'path'
import { languageByExtension } from './languageDetection'
import { homedir } from 'os'
import type {
    AdditionalContextPrompt,
    Chunk,
    ContextCommandItem,
    InlineProjectContext,
    QueryInlineProjectContextRequestV2,
    UpdateMode,
    VectorLibAPI,
} from 'local-indexing'
import { URI } from 'vscode-uri'
import { sleep, waitUntil } from '@aws/lsp-core/out/util/timeoutUtils'

import * as fs from 'fs'
import * as path from 'path'

import { pathToFileURL } from 'url'
import * as ignore from 'ignore'
import { getFileExtensionName, listFilesWithGitignore } from './utils'

const LIBRARY_DIR = (() => {
    if (require.main?.filename) {
        return path.join(dirname(require.main.filename), 'indexing')
    }
    return path.join(__dirname, 'indexing')
})()

// Extensions of the files that the index library builds code context for. It stops handling a remove at the
// first path of another kind, so only these are removed. An extension that the library doesn't map, such as
// .cjs or .cts, must not be added.
const CODE_CONTEXT_EXTENSIONS = new Set(['.java', '.js', '.jsx', '.mjs', '.mts', '.py', '.ts', '.tsx'])

// Folders that the index library takes no files from when a folder is added, so they are not listed
const UNINDEXED_FOLDER_NAMES = new Set(['.git', 'node_modules'])

// The most entries to list under an added folder when looking for the files that the ignore patterns exclude
const MAX_ADDED_FOLDER_ENTRIES = 100_000

// The most files that a folder item brings into the context command prompts, as in the index library
const MAX_FILES_UNDER_FOLDER = 1000

async function isDirectory(filePath: string): Promise<boolean> {
    try {
        return (await fs.promises.stat(filePath)).isDirectory()
    } catch {
        return false
    }
}

export interface SizeConstraints {
    maxFileSize: number
    remainingIndexSize: number
}

export interface LocalProjectContextInitializationOptions {
    vectorLib?: any
    ignoreFilePatterns?: string[]
    respectUserGitIgnores?: boolean
    fileExtensions?: string[]
    includeSymlinks?: boolean
    maxFileSizeMB?: number
    maxIndexSizeMB?: number
}

export class LocalProjectContextController {
    // Event handler for context items updated
    public onContextItemsUpdated: ((contextItems: ContextCommandItem[]) => Promise<void>) | undefined
    private static instance: LocalProjectContextController | undefined

    private workspaceFolders: WorkspaceFolder[]
    private _vecLib?: VectorLibAPI
    private _contextCommandSymbolsUpdated = false
    private readonly clientName: string
    private readonly log: Logging
    private _isIndexingInProgress: boolean = false
    // Set when a build is asked for while one is running, so that it runs again with the latest settings
    private rebuildRequested: boolean = false
    private ignoreFilePatterns?: string[]
    // Matches the configured ignore patterns, built when first needed
    private ignoreMatcher?: ReturnType<typeof ignore>
    // The file items of the context command list that the ignore patterns leave, kept until the index changes
    private fileItemsCache?: { sequenceNumber: number; items: ContextCommandItem[] }
    // Overridden in tests
    private maxAddedFolderEntries = MAX_ADDED_FOLDER_ENTRIES
    private includeSymlinks?: boolean
    private maxFileSizeMB?: number
    private maxIndexSizeMB?: number
    private respectUserGitIgnores?: boolean

    private readonly fileExtensions: string[] = Object.keys(languageByExtension)
    private readonly DEFAULT_MAX_INDEX_SIZE_MB = 2048
    private readonly DEFAULT_MAX_FILE_SIZE_MB = 10
    private readonly MB_TO_BYTES = 1024 * 1024

    constructor(clientName: string, workspaceFolders: WorkspaceFolder[], logging: Logging) {
        this.workspaceFolders = workspaceFolders
        this.clientName = clientName
        this.log = logging
    }

    get isEnabled(): boolean {
        return this._vecLib !== undefined && this._vecLib !== null
    }

    public static async getInstance(): Promise<LocalProjectContextController> {
        try {
            await waitUntil(async () => this.instance, {
                interval: 1000,
                timeout: 60_000,
                truthy: true,
            })

            if (!this.instance) {
                throw new Error('LocalProjectContextController initialization timeout after 60 seconds')
            }

            return this.instance
        } catch (error) {
            throw new Error(`Failed to get LocalProjectContextController instance: ${error}`)
        }
    }

    public async init({
        vectorLib,
        ignoreFilePatterns,
        respectUserGitIgnores = true,
        includeSymlinks = false,
        maxFileSizeMB = this.DEFAULT_MAX_FILE_SIZE_MB,
        maxIndexSizeMB = this.DEFAULT_MAX_INDEX_SIZE_MB,
    }: LocalProjectContextInitializationOptions = {}): Promise<void> {
        try {
            // update states according to configuration
            // Patterns that are not given leave the current ones in place; an empty list clears them
            const newIgnoreFilePatterns = ignoreFilePatterns ?? this.ignoreFilePatterns ?? []
            const ignoreFilePatternsChanged =
                JSON.stringify(newIgnoreFilePatterns) !== JSON.stringify(this.ignoreFilePatterns ?? [])
            this.includeSymlinks = includeSymlinks
            this.maxFileSizeMB = maxFileSizeMB
            this.maxIndexSizeMB = maxIndexSizeMB
            this.respectUserGitIgnores = respectUserGitIgnores
            this.ignoreFilePatterns = newIgnoreFilePatterns
            this.ignoreMatcher = undefined
            this.fileItemsCache = undefined

            this.log.info('Initializing local project context')

            // skip re-init if vecLib already loaded
            if (this._vecLib) {
                // Files indexed before the ignore patterns changed may now be excluded
                if (ignoreFilePatternsChanged) {
                    this.buildIndex().catch(e => {
                        this.log.error(`Error building index after the ignore patterns changed: ${e}`)
                    })
                    // The context command list shown in chat may still have files that the new patterns exclude.
                    // An empty list is sent too, so that the files of the earlier list are not left in chat.
                    this.getContextCommandItems()
                        .then(async contextItems => {
                            if (this.onContextItemsUpdated) {
                                await this.onContextItemsUpdated(contextItems)
                            }
                        })
                        .catch(e => {
                            this.log.error(
                                `Error updating context command items after the ignore patterns changed: ${e}`
                            )
                        })
                }
                return
            }

            // initialize vecLib and index
            const libraryPath = this.getVectorLibraryPath()
            const vecLib = vectorLib ?? (await eval(`import("${libraryPath}")`))
            if (vecLib) {
                try {
                    this._vecLib = await vecLib.start(LIBRARY_DIR, this.clientName)
                } catch (startError) {
                    this.log.warn(`Vector library start() failed (native modules may be missing): ${startError}`)
                    this.log.warn('Context commands will be unavailable')
                }
                if (this._vecLib) {
                    this.buildIndex().catch(e => {
                        this.log.error(`Error building index on init: ${e}`)
                    })
                }
                LocalProjectContextController.instance = this
            } else {
                this.log.warn(`Vector library could not be imported from: ${libraryPath}`)
                LocalProjectContextController.instance = this
            }
        } catch (error) {
            this.log.error('Vector library failed to initialize:' + error)
            LocalProjectContextController.instance = this
        }
    }

    private getVectorLibraryPath(): string {
        const libraryPath = path.join(LIBRARY_DIR, 'dist', 'extension.js')

        if (process.platform === 'win32') {
            // On Windows, the path must be loaded using a URL.
            // Using the file path directly results in ERR_UNSUPPORTED_ESM_URL_SCHEME
            // More details: https://github.com/nodejs/node/issues/31710
            return pathToFileURL(libraryPath).toString()
        }

        return libraryPath
    }

    public async dispose(): Promise<void> {
        if (this._vecLib) {
            await this._vecLib?.clear?.()
            this._vecLib = undefined
        }
    }

    /**
     * Resolves to false when nothing was passed on to the index library because the ignore patterns exclude
     * every given path
     */
    public async updateIndex(
        filePaths: string[],
        operation: UpdateMode,
        workspaceFolders?: string[]
    ): Promise<boolean> {
        try {
            const { paths, folders } = await this.indexablePaths(filePaths, operation)
            // Nothing to do when the ignore patterns exclude every file
            if (paths.length === 0 && filePaths.length > 0 && !workspaceFolders?.length) {
                return false
            }
            await this._vecLib?.updateIndexV2(paths, operation, workspaceFolders)
            if (operation === 'add' && folders.length > 0) {
                await this.removeIgnoredPathsInFolders(folders)
            }
        } catch (error) {
            this.log.error(`Error updating index: ${error}`)
        }
        return true
    }

    /**
     * The paths to pass on for an index update, and the folders among them. An add or update leaves out the
     * files and folders that the ignore patterns exclude. Without patterns the paths are passed on as they
     * are, and no folders are given.
     */
    private async indexablePaths(
        filePaths: string[],
        operation: UpdateMode
    ): Promise<{ paths: string[]; folders: string[] }> {
        if ((operation !== 'add' && operation !== 'update') || !this.ignoreFilePatterns?.length) {
            return { paths: filePaths, folders: [] }
        }
        const folderPaths = this.workspaceFolderPaths()
        const isFolder = await Promise.all(filePaths.map(isDirectory))
        const paths: string[] = []
        const folders: string[] = []
        filePaths.forEach((filePath, i) => {
            if (!this.isIgnoredFile(filePath, folderPaths, isFolder[i])) {
                paths.push(filePath)
                if (isFolder[i]) {
                    folders.push(filePath)
                }
            }
        })
        if (paths.length < filePaths.length) {
            this.log.debug(
                `Ignore patterns: left ${filePaths.length - paths.length} of ${filePaths.length} paths out of an index ${operation}`
            )
        }
        return { paths, folders }
    }

    /**
     * The index library adds every code file in a folder that is added, so this removes the ones that the
     * ignore patterns exclude. Folders that are added as workspace folders are not given: the library lists
     * those for the context command list only, which is filtered when it is read.
     */
    private async removeIgnoredPathsInFolders(addedFolders: string[]): Promise<void> {
        try {
            const ignoredPaths: string[] = []
            for (const folder of addedFolders) {
                const ignoredPathsInFolder = await this.ignoredPathsInFolder(folder)
                if (ignoredPathsInFolder) {
                    ignoredPaths.push(...ignoredPathsInFolder)
                } else {
                    this.log.warn(
                        `Ignore patterns: an added folder has more than ${this.maxAddedFolderEntries} entries, so its files are left out of the index until the index is built again`
                    )
                    ignoredPaths.push(folder + path.sep)
                }
            }
            if (ignoredPaths.length > 0) {
                this.log.debug(`Ignore patterns: removing ${ignoredPaths.length} paths of added folders from the index`)
                await this._vecLib?.updateIndexV2(ignoredPaths, 'remove')
            }
        } catch (error) {
            this.log.warn(`Files that the ignore patterns exclude were not removed from an added folder: ${error}`)
        }
    }

    /**
     * The folders and the code files under an added folder that the ignore patterns exclude, for removing them
     * from the index. A folder is given with a trailing separator, which removes every file under it. The
     * listing follows links and does not read .gitignore files, as the index library's listing of an added
     * folder does, so that it finds every file that the library added. Undefined when the folder has more
     * entries than the limit.
     */
    private async ignoredPathsInFolder(addedFolder: string): Promise<string[] | undefined> {
        const folderPaths = this.workspaceFolderPaths()
        const ignoredPaths: string[] = []
        let entryCount = 0
        // Resolves to false when the limit is reached. The ancestors are the real paths of the folders that
        // contain this one.
        const listFolder = async (folder: string, ancestors: string[]): Promise<boolean> => {
            let names: string[]
            let realFolder: string
            try {
                realFolder = await fs.promises.realpath(folder)
                // A link back to a folder that contains this one
                if (ancestors.includes(realFolder)) {
                    return true
                }
                names = await fs.promises.readdir(folder)
            } catch {
                return true
            }
            for (const name of names) {
                if (UNINDEXED_FOLDER_NAMES.has(name)) {
                    continue
                }
                entryCount += 1
                if (entryCount > this.maxAddedFolderEntries) {
                    return false
                }
                const entryPath = path.join(folder, name)
                // Links are followed, as the index library follows them
                const stats = await fs.promises.stat(entryPath).catch(() => undefined)
                if (stats?.isDirectory()) {
                    if (this.isIgnoredFile(entryPath, folderPaths, true)) {
                        ignoredPaths.push(entryPath + path.sep)
                    } else if (!(await listFolder(entryPath, [...ancestors, realFolder]))) {
                        return false
                    }
                } else if (
                    stats?.isFile() &&
                    CODE_CONTEXT_EXTENSIONS.has(path.extname(name).toLowerCase()) &&
                    this.isIgnoredFile(entryPath, folderPaths)
                ) {
                    ignoredPaths.push(entryPath)
                }
            }
            return true
        }
        return (await listFolder(addedFolder, [])) ? ignoredPaths : undefined
    }

    private workspaceFolderPaths(): string[] {
        return this.workspaceFolders.map(folder => path.resolve(URI.parse(folder.uri).fsPath))
    }

    /**
     * True when a configured ignore pattern matches the file, or the folder when isFolder is set.
     * The patterns follow .gitignore syntax and apply relative to each workspace folder that contains the path.
     */
    private isIgnoredFile(filePath: string, folderPaths: string[], isFolder = false): boolean {
        if (!this.ignoreFilePatterns?.length) {
            return false
        }
        this.ignoreMatcher ??= ignore().add(this.ignoreFilePatterns)
        const matcher = this.ignoreMatcher
        return folderPaths.some(folderPath => {
            const relativePath = path.relative(folderPath, path.resolve(filePath))
            if (
                !relativePath ||
                relativePath === '..' ||
                relativePath.startsWith('..' + path.sep) ||
                path.isAbsolute(relativePath)
            ) {
                return false
            }
            return matcher.ignores(relativePath.split(path.sep).join('/') + (isFolder ? '/' : ''))
        })
    }

    // public for test
    async buildIndex(): Promise<void> {
        if (this._isIndexingInProgress) {
            this.rebuildRequested = true
            return
        }
        this._isIndexingInProgress = true
        try {
            // Builds again, one build after another, while a build was asked for during the one that just ended
            do {
                this.rebuildRequested = false
                await this.buildIndexOnce()
            } while (this.rebuildRequested)
        } finally {
            this._isIndexingInProgress = false
        }
    }

    private async buildIndexOnce(): Promise<void> {
        try {
            if (this._vecLib) {
                if (!this.workspaceFolders.length) {
                    this.log.info('skip building index because no workspace folder found')
                    return
                }
                const sourceFiles = await this.processWorkspaceFolders(
                    this.workspaceFolders,
                    this.fileExtensions,
                    this.maxFileSizeMB,
                    this.maxIndexSizeMB
                )

                const projectRoot = URI.parse(this.workspaceFolders.sort()[0].uri).fsPath
                await this._vecLib?.buildIndex(sourceFiles, projectRoot, 'default')
                this.log.info('Context index built successfully')
            }
        } catch (error) {
            this.log.error(`Error building index: ${error}`)
        }
    }

    public async updateWorkspaceFolders(added: WorkspaceFolder[], removed: WorkspaceFolder[]): Promise<void> {
        try {
            this.fileItemsCache = undefined
            const actualRemovals = this.workspaceFolders.filter(existing =>
                removed.some(removal => this.areWorkspaceFoldersEqual(existing, removal))
            )

            this.workspaceFolders = this.workspaceFolders.filter(
                existing => !actualRemovals.some(removal => this.areWorkspaceFoldersEqual(existing, removal))
            )

            const actualAdditions = added.filter(
                addition => !this.workspaceFolders.some(existing => this.areWorkspaceFoldersEqual(existing, addition))
            )

            this.workspaceFolders.push(...actualAdditions)
            // Only update index if we have actual changes and indexing library is present
            if (this._vecLib) {
                if (actualRemovals.length > 0) {
                    const removedPaths = actualRemovals.map(folder => URI.parse(folder.uri).fsPath)
                    await this.updateIndexAndContextCommand([], false, removedPaths)
                }

                if (actualAdditions.length > 0) {
                    const addedPaths = actualAdditions.map(folder => URI.parse(folder.uri).fsPath)
                    await this.updateIndexAndContextCommand([], true, addedPaths)
                }
            }
        } catch (error) {
            this.log.error(`Error in updateWorkspaceFolders: ${error}`)
        }
    }

    public async queryInlineProjectContext(
        request: QueryInlineProjectContextRequestV2
    ): Promise<InlineProjectContext[]> {
        try {
            const folderPaths = this.workspaceFolderPaths()
            // The index library adds the queried file to the index, so a file that the ignore patterns exclude is not queried
            if (this.isIgnoredFile(request.filePath, folderPaths)) {
                this.log.debug('Ignore patterns: no project context for an excluded file')
                return []
            }
            const resp =
                (await this._vecLib?.queryInlineProjectContext(request.query, request.filePath, request.target)) ?? []
            if (!this.ignoreFilePatterns?.length) {
                return resp
            }
            // Context that names an excluded file as its source is left out. Code context from the index library
            // carries a label instead of a file path, and is left as it is.
            const contexts = resp.filter(
                context =>
                    typeof context.filePath !== 'string' ||
                    !path.isAbsolute(context.filePath) ||
                    !this.isIgnoredFile(context.filePath, folderPaths)
            )
            if (contexts.length < resp.length) {
                this.log.debug(
                    `Ignore patterns: left ${resp.length - contexts.length} of ${resp.length} project context items out`
                )
            }
            return contexts
        } catch (error) {
            this.log.error(`Error in queryInlineProjectContext: ${error}`)
            return []
        }
    }

    public async getContextCommandItems(): Promise<ContextCommandItem[]> {
        if (!this._vecLib) {
            return []
        }

        try {
            const foldersPath = this.workspaceFolders.map(folder => URI.parse(folder.uri).fsPath)
            const resp = await this._vecLib?.getContextCommandItems(foldersPath)
            this.log.log(`received ${resp.length} context command items`)
            if (!this.ignoreFilePatterns?.length) {
                return resp ?? []
            }
            // The index library lists the workspace files itself, so leave out the ones that the ignore patterns exclude
            const isIgnoredItem = this.ignoredItemCheck()
            const allItems = resp ?? []
            const items = allItems.filter(item => !isIgnoredItem(item))
            if (items.length < allItems.length) {
                this.log.debug(
                    `Ignore patterns: left ${allItems.length - items.length} of ${allItems.length} context command items out`
                )
            }
            return items
        } catch (error) {
            this.log.error(`Error in getContextCommandItems: ${error}`)
            return []
        }
    }

    /**
     * A check of whether the ignore patterns exclude a context command item. The list can have hundreds of
     * thousands of items, so an item's path relative to its workspace folder is matched directly when no
     * workspace folder is inside another, which is the usual case.
     */
    private ignoredItemCheck(): (item: ContextCommandItem) => boolean {
        const folderPaths = this.workspaceFolderPaths()
        this.ignoreMatcher ??= ignore().add(this.ignoreFilePatterns ?? [])
        const matcher = this.ignoreMatcher
        const nested = folderPaths.some(outer => folderPaths.some(inner => this.isInsideFolder(outer, inner)))
        const workspaceFolderPaths = new Set(folderPaths)
        // Whether each workspace folder string in the items is one of the workspace folders
        const isWorkspaceFolder = new Map<string, boolean>()
        return item => {
            const isFolder = item.type === 'folder'
            let known = isWorkspaceFolder.get(item.workspaceFolder)
            if (known === undefined) {
                known = !nested && workspaceFolderPaths.has(path.resolve(item.workspaceFolder))
                isWorkspaceFolder.set(item.workspaceFolder, known)
            }
            const relativePath = path.sep === '\\' ? item.relativePath.replace(/\\/g, '/') : item.relativePath
            if (
                known &&
                relativePath &&
                !relativePath.startsWith('../') &&
                relativePath !== '..' &&
                !path.isAbsolute(relativePath)
            ) {
                return matcher.ignores(relativePath + (isFolder ? '/' : ''))
            }
            return this.isIgnoredFile(path.join(item.workspaceFolder, item.relativePath), folderPaths, isFolder)
        }
    }

    private isInsideFolder(folderPath: string, filePath: string): boolean {
        const relativePath = path.relative(folderPath, filePath)
        return (
            !!relativePath &&
            relativePath !== '..' &&
            !relativePath.startsWith('..' + path.sep) &&
            !path.isAbsolute(relativePath)
        )
    }

    public async updateIndexAndContextCommand(filePaths: string[], isAdd: boolean, workspaceFolders?: string[]) {
        const result = await this.tryUpdateIndex(filePaths, isAdd, workspaceFolders)
        if (result) {
            const contextItems = await this.getContextCommandItems()
            if (this.onContextItemsUpdated && contextItems.length > 0) {
                await this.onContextItemsUpdated(contextItems)
            }
        }
    }

    public async tryUpdateIndex(filePaths: string[], isAdd: boolean, workspaceFolders?: string[]): Promise<boolean> {
        try {
            const indexSeqNum = await this._vecLib?.getIndexSequenceNumber()
            // Nothing to wait for when the ignore patterns exclude every file
            if ((await this.updateIndex(filePaths, isAdd ? 'add' : 'remove', workspaceFolders)) === false) {
                return false
            }
            await waitUntil(
                async () => {
                    const newIndexSeqNum = await this._vecLib?.getIndexSequenceNumber()
                    if (newIndexSeqNum && indexSeqNum && newIndexSeqNum > indexSeqNum) {
                        return true
                    }
                    return false
                },
                { interval: 500, timeout: 5_000, truthy: true }
            )
            return true
        } catch (error) {
            this.log.error(`Error in update index: ${error}`)
            return false
        }
    }

    public async shouldUpdateContextCommandSymbolsOnce(): Promise<boolean> {
        if (this._contextCommandSymbolsUpdated) {
            return false
        }
        this._contextCommandSymbolsUpdated = true
        try {
            const indexSeqNum = await this._vecLib?.getIndexSequenceNumber()
            await this.updateIndex([], 'context_command_symbol_update')
            await waitUntil(
                async () => {
                    const newIndexSeqNum = await this._vecLib?.getIndexSequenceNumber()
                    if (newIndexSeqNum && indexSeqNum && newIndexSeqNum > indexSeqNum) {
                        return true
                    }
                    return false
                },
                { interval: 1000, timeout: 60_000, truthy: true }
            )
            return true
        } catch (error) {
            this.log.error(`Error in shouldUpdateContextCommandSymbolsOnce: ${error}`)
            return false
        }
    }

    /**
     * The prompts for the given context command items. Files that the ignore patterns exclude are left out,
     * also when an item names the file. The files of the kept items stay: these are for items that apply
     * whatever the patterns are, such as workspace rules.
     */
    public async getContextCommandPrompt(
        contextCommandItems: ContextCommandItem[],
        keptItems: ContextCommandItem[] = []
    ): Promise<AdditionalContextPrompt[]> {
        if (!this._vecLib) {
            return []
        }

        try {
            if (!this.ignoreFilePatterns?.length) {
                return (await this._vecLib?.getContextCommandPrompt(contextCommandItems)) ?? []
            }
            const resp = await this._vecLib?.getContextCommandPrompt(await this.withFolderFiles(contextCommandItems))
            const keptFiles = new Set(
                keptItems
                    .filter(item => item.type !== 'folder')
                    .map(item => path.resolve(item.workspaceFolder, item.relativePath))
            )
            const folderPaths = this.workspaceFolderPaths()
            const allPrompts = resp ?? []
            const prompts = allPrompts.filter(
                prompt =>
                    keptFiles.has(path.resolve(prompt.filePath)) || !this.isIgnoredFile(prompt.filePath, folderPaths)
            )
            if (prompts.length < allPrompts.length) {
                this.log.debug(
                    `Ignore patterns: left ${allPrompts.length - prompts.length} of ${allPrompts.length} context command prompts out`
                )
            }
            return prompts
        } catch (error) {
            this.log.error(`Error in getContextCommandPrompt: ${error}`)
            return []
        }
    }

    /**
     * The items with each folder item replaced by items for the files under it that the ignore patterns leave,
     * up to the number of files that the index library brings in for a folder. The library counts ignored files
     * towards that number, so a folder of mostly ignored files would otherwise bring in few or none.
     */
    private async withFolderFiles(contextCommandItems: ContextCommandItem[]): Promise<ContextCommandItem[]> {
        if (!contextCommandItems.some(item => item.type === 'folder')) {
            return contextCommandItems
        }
        const workspaceFiles = await this.workspaceFileItems()
        return contextCommandItems.flatMap(item => {
            if (item.type !== 'folder') {
                return [item]
            }
            const folderPath = path.join(item.workspaceFolder, item.relativePath)
            const folderFiles: ContextCommandItem[] = []
            for (const file of workspaceFiles) {
                const filePath = path.join(file.workspaceFolder, file.relativePath)
                if (this.isInsideFolder(folderPath, filePath)) {
                    folderFiles.push({
                        ...file,
                        workspaceFolder: folderPath,
                        relativePath: path.relative(folderPath, filePath),
                    })
                    if (folderFiles.length >= MAX_FILES_UNDER_FOLDER) {
                        break
                    }
                }
            }
            return folderFiles
        })
    }

    /**
     * The files the index library lists for the workspace, which follow the .gitignore files as its own folder
     * listing does, without the ones that the ignore patterns exclude. The list is kept until the index
     * changes, so that it is not made again for each prompt.
     */
    private async workspaceFileItems(): Promise<ContextCommandItem[]> {
        const sequenceNumber = await this._vecLib?.getIndexSequenceNumber()
        if (this.fileItemsCache && this.fileItemsCache.sequenceNumber === sequenceNumber) {
            return this.fileItemsCache.items
        }
        // Files and images: the library also lists images, which its types don't name
        const items = (await this.getContextCommandItems()).filter(
            item => item.type !== 'folder' && item.type !== 'code'
        )
        if (typeof sequenceNumber === 'number' && items.length > 0) {
            this.fileItemsCache = { sequenceNumber, items }
        }
        return items
    }

    async processWorkspaceFolders(
        workspaceFolders?: WorkspaceFolder[] | null,
        fileExtensions?: string[],
        maxFileSizeMB?: number,
        maxIndexSizeMB?: number
    ): Promise<string[]> {
        if (!workspaceFolders?.length) {
            this.log.info(`Skipping indexing: no workspace folders available`)
            return []
        }

        this.log.info(`Processing ${workspaceFolders.length} workspace folders...`)

        maxFileSizeMB = Math.min(maxFileSizeMB ?? Infinity, this.DEFAULT_MAX_FILE_SIZE_MB)
        maxIndexSizeMB = Math.min(maxIndexSizeMB ?? Infinity, this.DEFAULT_MAX_INDEX_SIZE_MB)

        const sizeConstraints: SizeConstraints = {
            maxFileSize: maxFileSizeMB * this.MB_TO_BYTES,
            remainingIndexSize: maxIndexSizeMB * this.MB_TO_BYTES,
        }

        const uniqueFilesToIndex = new Set<string>()
        let filesExceedingMaxSize = 0
        // A file is checked against every workspace folder that contains it, as in the other checks, so that a
        // pattern anchored to a workspace folder applies when that folder is inside another one
        const folderPaths = workspaceFolders.map(folder => path.resolve(URI.parse(folder.uri).fsPath))
        for (const folder of workspaceFolders) {
            const absoluteFolderPath = path.resolve(URI.parse(folder.uri).fsPath)
            const filesUnderFolder = await listFilesWithGitignore(absoluteFolderPath)
            for (const file of filesUnderFolder) {
                const fileExtName = '.' + getFileExtensionName(file)
                if (
                    !uniqueFilesToIndex.has(file) &&
                    fileExtensions?.includes(fileExtName) &&
                    !this.isIgnoredFile(file, folderPaths)
                ) {
                    try {
                        const fileSize = fs.statSync(file).size
                        if (fileSize < sizeConstraints.maxFileSize) {
                            if (sizeConstraints.remainingIndexSize > fileSize) {
                                uniqueFilesToIndex.add(file)
                                sizeConstraints.remainingIndexSize = sizeConstraints.remainingIndexSize - fileSize
                            } else {
                                this.log.info(
                                    `Reaching max file collection size limit ${this.maxIndexSizeMB} MB. ${uniqueFilesToIndex.size} files found. ${filesExceedingMaxSize} files exceeded ${maxFileSizeMB} MB `
                                )
                                return [...uniqueFilesToIndex]
                            }
                        } else {
                            filesExceedingMaxSize += 1
                        }
                        // yeild event loop for other tasks like network I/O
                        await sleep(1)
                    } catch (error) {
                        this.log.error(`Failed to include file in index. ${file}`)
                    }
                }
            }
        }

        this.log.info(
            `ProcessWorkspaceFolders complete. ${uniqueFilesToIndex.size} files found. ${filesExceedingMaxSize} files exceeded ${maxFileSizeMB} MB`
        )
        return [...uniqueFilesToIndex]
    }

    private areWorkspaceFoldersEqual(a: WorkspaceFolder, b: WorkspaceFolder): boolean {
        return a.uri === b.uri && a.name === b.name
    }
}
