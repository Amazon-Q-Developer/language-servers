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
// first path of another kind, so only these are removed.
const CODE_CONTEXT_EXTENSIONS = new Set(['.java', '.js', '.jsx', '.mjs', '.mts', '.py', '.ts', '.tsx'])

function isDirectory(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isDirectory()
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
        ignoreFilePatterns = [],
        respectUserGitIgnores = true,
        includeSymlinks = false,
        maxFileSizeMB = this.DEFAULT_MAX_FILE_SIZE_MB,
        maxIndexSizeMB = this.DEFAULT_MAX_INDEX_SIZE_MB,
    }: LocalProjectContextInitializationOptions = {}): Promise<void> {
        try {
            // update states according to configuration
            const ignoreFilePatternsChanged =
                JSON.stringify(ignoreFilePatterns) !== JSON.stringify(this.ignoreFilePatterns ?? [])
            this.includeSymlinks = includeSymlinks
            this.maxFileSizeMB = maxFileSizeMB
            this.maxIndexSizeMB = maxIndexSizeMB
            this.respectUserGitIgnores = respectUserGitIgnores
            this.ignoreFilePatterns = ignoreFilePatterns
            this.ignoreMatcher = undefined

            this.log.info('Initializing local project context')

            // skip re-init if vecLib already loaded
            if (this._vecLib) {
                // Files indexed before the ignore patterns changed may now be excluded
                if (ignoreFilePatternsChanged) {
                    this.buildIndex().catch(e => {
                        this.log.error(`Error building index after the ignore patterns changed: ${e}`)
                    })
                    // The context command list shown in chat may still have files that the new patterns exclude
                    this.getContextCommandItems()
                        .then(async contextItems => {
                            if (this.onContextItemsUpdated && contextItems.length > 0) {
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

    public async updateIndex(filePaths: string[], operation: UpdateMode, workspaceFolders?: string[]): Promise<void> {
        try {
            const indexablePaths = this.indexablePaths(filePaths, operation)
            // Nothing to do when the ignore patterns exclude every file
            if (indexablePaths.length === 0 && filePaths.length > 0 && !workspaceFolders?.length) {
                return
            }
            await this._vecLib?.updateIndexV2(indexablePaths, operation, workspaceFolders)
            if (operation === 'add') {
                // The index library adds every file in an added folder, so remove the ones that the patterns exclude
                const ignoredPaths = await this.ignoredPathsInFolders(indexablePaths)
                if (ignoredPaths.length > 0) {
                    await this._vecLib?.updateIndexV2(ignoredPaths, 'remove')
                }
            }
        } catch (error) {
            this.log.error(`Error updating index: ${error}`)
        }
    }

    /**
     * The paths to pass on for an index update: an add or update leaves out files and folders that the ignore
     * patterns exclude
     */
    private indexablePaths(filePaths: string[], operation: UpdateMode): string[] {
        if ((operation !== 'add' && operation !== 'update') || !this.ignoreFilePatterns?.length) {
            return filePaths
        }
        const folderPaths = this.workspaceFolderPaths()
        return filePaths.filter(filePath => !this.isIgnoredFile(filePath, folderPaths, isDirectory(filePath)))
    }

    /**
     * The folders and the code files under the given folders that the ignore patterns exclude, for removing them
     * from the index after the folders are added. A folder is given with a trailing separator, which removes
     * every file under it.
     */
    private async ignoredPathsInFolders(paths: string[]): Promise<string[]> {
        if (!this.ignoreFilePatterns?.length) {
            return []
        }
        const folderPaths = this.workspaceFolderPaths()
        const ignoredPaths: string[] = []
        // Real paths of the folders already listed, as links can lead back to them
        const listedFolders = new Set<string>()
        const listFolder = async (folder: string): Promise<void> => {
            let names: string[]
            try {
                const realFolder = await fs.promises.realpath(folder)
                if (listedFolders.has(realFolder)) {
                    return
                }
                listedFolders.add(realFolder)
                names = await fs.promises.readdir(folder)
            } catch {
                return
            }
            for (const name of names) {
                const entryPath = path.join(folder, name)
                // Links are followed, as the index library follows them
                const stats = await fs.promises.stat(entryPath).catch(() => undefined)
                if (stats?.isDirectory()) {
                    if (this.isIgnoredFile(entryPath, folderPaths, true)) {
                        ignoredPaths.push(entryPath + path.sep)
                    } else {
                        await listFolder(entryPath)
                    }
                } else if (
                    stats?.isFile() &&
                    CODE_CONTEXT_EXTENSIONS.has(path.extname(name).toLowerCase()) &&
                    this.isIgnoredFile(entryPath, folderPaths)
                ) {
                    ignoredPaths.push(entryPath)
                }
            }
        }
        for (const folder of paths.filter(isDirectory)) {
            await listFolder(folder)
        }
        return ignoredPaths
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
        try {
            this._isIndexingInProgress = true
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
        } finally {
            this._isIndexingInProgress = false
            if (this.rebuildRequested) {
                this.rebuildRequested = false
                await this.buildIndex()
            }
        }
    }

    public async updateWorkspaceFolders(added: WorkspaceFolder[], removed: WorkspaceFolder[]): Promise<void> {
        try {
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
            // The index library adds the queried file to the index, so a file that the ignore patterns exclude is not queried
            if (this.isIgnoredFile(request.filePath, this.workspaceFolderPaths())) {
                return []
            }
            const resp = await this._vecLib?.queryInlineProjectContext(request.query, request.filePath, request.target)
            return resp ?? []
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
            return (resp ?? []).filter(item => !isIgnoredItem(item))
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
            // Nothing to wait for when the ignore patterns exclude every file
            if (
                filePaths.length > 0 &&
                !workspaceFolders?.length &&
                this.indexablePaths(filePaths, isAdd ? 'add' : 'remove').length === 0
            ) {
                return false
            }
            const indexSeqNum = await this._vecLib?.getIndexSequenceNumber()
            await this.updateIndex(filePaths, isAdd ? 'add' : 'remove', workspaceFolders)
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

    public async getContextCommandPrompt(
        contextCommandItems: ContextCommandItem[]
    ): Promise<AdditionalContextPrompt[]> {
        if (!this._vecLib) {
            return []
        }

        try {
            if (!this.ignoreFilePatterns?.length) {
                return (await this._vecLib?.getContextCommandPrompt(contextCommandItems)) ?? []
            }
            const resp = await this._vecLib?.getContextCommandPrompt(await this.withFolderFiles(contextCommandItems))
            // Leave out the files that the ignore patterns exclude. Files that an item names, such as workspace
            // rules, are kept.
            const namedFiles = new Set(
                contextCommandItems
                    .filter(item => item.type !== 'folder')
                    .map(item => path.resolve(item.workspaceFolder, item.relativePath))
            )
            const folderPaths = this.workspaceFolderPaths()
            return (resp ?? []).filter(
                prompt =>
                    namedFiles.has(path.resolve(prompt.filePath)) || !this.isIgnoredFile(prompt.filePath, folderPaths)
            )
        } catch (error) {
            this.log.error(`Error in getContextCommandPrompt: ${error}`)
            return []
        }
    }

    /**
     * The items with each folder item replaced by items for the files under it that the ignore patterns leave.
     * The index library brings in only a fixed number of the files under a folder, ignored files included, so a
     * folder of mostly ignored files would otherwise bring in few or none.
     */
    private async withFolderFiles(contextCommandItems: ContextCommandItem[]): Promise<ContextCommandItem[]> {
        if (!contextCommandItems.some(item => item.type === 'folder')) {
            return contextCommandItems
        }
        // The files the index library lists for the workspace, which follow the .gitignore files as its own
        // folder listing does, without the ones that the ignore patterns exclude
        const workspaceFiles = (await this.getContextCommandItems())
            // Files and images: the library also lists images, which its types don't name
            .filter(item => item.type !== 'folder' && item.type !== 'code')
            .map(item => ({ item, filePath: path.join(item.workspaceFolder, item.relativePath) }))
        return contextCommandItems.flatMap(item => {
            if (item.type !== 'folder') {
                return [item]
            }
            const folderPath = path.join(item.workspaceFolder, item.relativePath)
            return workspaceFiles
                .filter(file => this.isInsideFolder(folderPath, file.filePath))
                .map(file => ({
                    ...file.item,
                    workspaceFolder: folderPath,
                    relativePath: path.relative(folderPath, file.filePath),
                }))
        })
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
