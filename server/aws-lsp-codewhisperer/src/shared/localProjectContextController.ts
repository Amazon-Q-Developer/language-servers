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
import { getFileExtensionName, listFilesWithGitignore } from './utils'

const LIBRARY_DIR = (() => {
    if (require.main?.filename) {
        return path.join(dirname(require.main.filename), 'indexing')
    }
    return path.join(__dirname, 'indexing')
})()
/*
 * Using new Function(...) prevents webpack from statically analyzing and attempting
 * to resolve the dynamic import at build time. This works because the function
 * is created at runtime, thus webpack cannot parse it.
 */
const dynamicVecLibImport = new Function('path', 'return import(path)')

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
    private ignoreFilePatterns?: string[]
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
            this.includeSymlinks = includeSymlinks
            this.maxFileSizeMB = maxFileSizeMB
            this.maxIndexSizeMB = maxIndexSizeMB
            this.respectUserGitIgnores = respectUserGitIgnores
            this.ignoreFilePatterns = ignoreFilePatterns

            this.log.info('Initializing local project context')

            // skip re-init if vecLib already loaded
            if (this._vecLib) {
                return
            }

            // initialize vecLib and index
            const libraryPath = this.getVectorLibraryPath()
            const vecLib = vectorLib ?? (await dynamicVecLibImport(libraryPath))
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
            await this._vecLib?.updateIndexV2(filePaths, operation, workspaceFolders)
        } catch (error) {
            this.log.error(`Error updating index: ${error}`)
        }
    }

    // public for test
    async buildIndex(): Promise<void> {
        if (this._isIndexingInProgress) {
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
            return resp ?? []
        } catch (error) {
            this.log.error(`Error in getContextCommandItems: ${error}`)
            return []
        }
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
            const resp = await this._vecLib?.getContextCommandPrompt(contextCommandItems)
            return resp ?? []
        } catch (error) {
            this.log.error(`Error in getContextCommandPrompt: ${error}`)
            return []
        }
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
        for (const folder of workspaceFolders) {
            const absoluteFolderPath = path.resolve(URI.parse(folder.uri).fsPath)
            const filesUnderFolder = await listFilesWithGitignore(absoluteFolderPath)
            for (const file of filesUnderFolder) {
                const fileExtName = '.' + getFileExtensionName(file)
                if (!uniqueFilesToIndex.has(file) && fileExtensions?.includes(fileExtName)) {
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
