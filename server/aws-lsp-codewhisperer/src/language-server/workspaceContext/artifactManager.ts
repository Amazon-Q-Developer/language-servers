import { Logging, Workspace, WorkspaceFolder } from '@aws/language-server-runtimes/server-interface'
import * as fs from 'fs'
import path = require('path')
import { URI } from 'vscode-uri'
import JSZip = require('jszip')
import { EclipseConfigGenerator, JavaProjectAnalyzer } from './javaManager'
import { resolveSymlink, isDirectory, isEmptyDirectory } from './util'
import glob = require('fast-glob')
import {
    CodewhispererLanguage,
    getCodeWhispererLanguageIdFromPath,
    isJavaProjectFileFromPath,
} from '../../shared/languageDetection'

export interface FileMetadata {
    filePath: string
    relativePath: string
    language: CodewhispererLanguage
    contentLength: number
    lastModified: number
    content: Buffer
    workspaceFolder: WorkspaceFolder
}

export const SUPPORTED_WORKSPACE_CONTEXT_LANGUAGES: CodewhispererLanguage[] = [
    'python',
    'javascript',
    'typescript',
    'java',
]
export const IGNORE_PATTERNS = [
    // Package management and git
    '**/node_modules/**',
    '**/.git/**',
    // Build outputs
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/coverage/**',
    // Hidden files
    '**/.*',
    '!**/.classpath',
    '!**/.project',
    '!**/.factorypath',
    // Logs and temporary files
    '**/logs/**',
    '**/tmp/**',
    // Environment and configuration
    '**/env/**',
    '**/venv/**',
    '**/bin/**',
    // Framework specific
    '**/target/**', // Maven/Gradle builds
]

const IGNORE_DEPENDENCY_PATTERNS = [
    // Package management and git
    '**/.git/**',
    // Build outputs
    '**/dist/**',
    // Logs and temporary files
    '**/logs/**',
]

interface FileSizeDetails {
    includedFileCount: number
    includedSize: number
    skippedFileCount: number
    skippedSize: number
}
const MAX_UNCOMPRESSED_SRC_SIZE_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB
const MAX_FILES = 500_000

export class ArtifactManager {
    private workspace: Workspace
    private logging: Logging
    private workspaceFolders: WorkspaceFolder[]
    // TODO, how to handle when two workspace folders have the same name but different URI
    private filesByWorkspaceFolderAndLanguage: Map<WorkspaceFolder, Map<CodewhispererLanguage, FileMetadata[]>>
    private isDisposed: boolean = false

    constructor(workspace: Workspace, logging: Logging, workspaceFolders: WorkspaceFolder[]) {
        this.workspace = workspace
        this.logging = logging
        this.workspaceFolders = workspaceFolders
        this.filesByWorkspaceFolderAndLanguage = new Map<WorkspaceFolder, Map<CodewhispererLanguage, FileMetadata[]>>()
    }

    updateWorkspaceFolders(workspaceFolders: WorkspaceFolder[]) {
        this.workspaceFolders = workspaceFolders
    }

    async addWorkspaceFolders(workspaceFolders: WorkspaceFolder[]): Promise<FileMetadata[]> {
        this.log(`Adding new workspace folders: ${workspaceFolders.map(f => f.name).join(', ')}`)
        this.workspaceFolders = [...this.workspaceFolders, ...workspaceFolders]
        const zipFileMetadata = await this.processWorkspaceFolders(workspaceFolders)
        return zipFileMetadata
    }

    async addNewDirectories(newDirectories: URI[]): Promise<FileMetadata[]> {
        let zipFileMetadata: FileMetadata[] = []
        const fileSizeDetails: FileSizeDetails = {
            includedFileCount: 0,
            includedSize: 0,
            skippedFileCount: 0,
            skippedSize: 0,
        }

        for (const directory of newDirectories) {
            const workspaceFolder = this.workspaceFolders.find(ws => directory.path.startsWith(URI.parse(ws.uri).path))

            if (!workspaceFolder) {
                // No workspace folder found for directory, it will not be processed
                continue
            }

            try {
                const workspacePath = URI.parse(workspaceFolder.uri).path
                const relativePath = path.relative(workspacePath, directory.path)

                const filesByLanguage = await this.processDirectory(workspaceFolder, directory.path, relativePath)
                zipFileMetadata = await this.processFilesByLanguage(
                    workspaceFolder,
                    fileSizeDetails,
                    filesByLanguage,
                    relativePath
                )
            } catch (error) {
                this.logging.warn(`Error processing new directory ${directory.path}: ${error}`)
            }
        }

        return zipFileMetadata
    }

    public resetFromDisposal(): void {
        this.isDisposed = false
    }

    dispose(): void {
        this.filesByWorkspaceFolderAndLanguage.clear()
        this.workspaceFolders = []
        this.isDisposed = true
    }

    removeWorkspaceFolders(workspaceFolders: WorkspaceFolder[]): void {
        workspaceFolders.forEach(workspaceToRemove => {
            // Find the matching workspace folder by URI
            let folderToDelete: WorkspaceFolder | undefined

            for (const [existingFolder] of this.filesByWorkspaceFolderAndLanguage) {
                if (existingFolder.uri === workspaceToRemove.uri) {
                    folderToDelete = existingFolder
                    break
                }
            }

            if (!folderToDelete) {
                // No matching workspace found to remove, do nothing
                return
            }

            this.filesByWorkspaceFolderAndLanguage.delete(folderToDelete)
            this.workspaceFolders = this.workspaceFolders.filter(folder => folder.uri !== workspaceToRemove.uri)
        })
    }

    async getFileMetadata(
        currentWorkspace: WorkspaceFolder,
        filePath: string,
        languageOverride?: CodewhispererLanguage,
        filePathInZipOverride?: string
    ): Promise<FileMetadata[]> {
        let fileMetadataList: FileMetadata[] = []
        const language =
            languageOverride !== undefined ? languageOverride : getCodeWhispererLanguageIdFromPath(filePath)
        if (!language || !SUPPORTED_WORKSPACE_CONTEXT_LANGUAGES.includes(language)) {
            return Promise.reject('unsupported language')
        }

        if (isDirectory(filePath)) {
            let fileCount = 0
            const filesStream = glob.stream(['**/*'], {
                cwd: filePath,
                dot: false,
                ignore: IGNORE_DEPENDENCY_PATTERNS,
                followSymbolicLinks: true,
                absolute: false,
                onlyFiles: true,
            })

            for await (const entry of filesStream) {
                if (fileCount >= MAX_FILES) {
                    break
                }
                const relativePath = entry.toString()
                try {
                    const fullPath = resolveSymlink(path.join(filePath, relativePath))
                    const fileMetadata = await this.createFileMetadata(
                        fullPath,
                        path.join(filePathInZipOverride !== undefined ? filePathInZipOverride : '', relativePath),
                        language,
                        currentWorkspace
                    )
                    fileMetadataList.push(fileMetadata)
                } catch (error) {
                    this.logging.warn(`Error processing file ${relativePath}: ${error}`)
                }
                fileCount++
            }
        } else {
            const workspaceUri = URI.parse(currentWorkspace.uri)
            const fileUri = URI.parse(filePath)
            const relativePath =
                filePathInZipOverride !== undefined
                    ? filePathInZipOverride
                    : path.join(currentWorkspace.name, path.relative(workspaceUri.path, fileUri.path))

            const fileMetadata: FileMetadata = await this.createFileMetadata(
                fileUri.path,
                relativePath,
                language,
                currentWorkspace
            )
            fileMetadataList.push(fileMetadata)
        }
        return fileMetadataList
    }

    async processNewFile(currentWorkspace: WorkspaceFolder, filePath: string): Promise<FileMetadata> {
        const workspaceUri = URI.parse(currentWorkspace.uri)
        const fileUri = URI.parse(filePath)
        // const relativePath = path.join(currentWorkspace.name, path.relative(workspaceUri.path, fileUri.path))

        const language = getCodeWhispererLanguageIdFromPath(filePath)
        if (!language || !SUPPORTED_WORKSPACE_CONTEXT_LANGUAGES.includes(language)) {
            return Promise.reject('unsupported language')
        }

        const fileMetadata: FileMetadata = await this.createFileMetadata(
            fileUri.path,
            path.relative(workspaceUri.path, fileUri.path),
            language,
            currentWorkspace
        )

        // Find existing workspace folder or use current one
        const workspaceKey = this.findWorkspaceFolder(currentWorkspace) || currentWorkspace

        // Update the internal map with the new file metadata
        if (!this.filesByWorkspaceFolderAndLanguage.has(workspaceKey)) {
            this.filesByWorkspaceFolderAndLanguage.set(workspaceKey, new Map<CodewhispererLanguage, FileMetadata[]>())
        }

        const workspaceMap = this.filesByWorkspaceFolderAndLanguage.get(workspaceKey)!
        if (!workspaceMap.has(language)) {
            workspaceMap.set(language, [])
        }

        // Replace or add the file metadata
        const files = workspaceMap.get(language)!
        const existingIndex = files.findIndex(f => f.filePath === fileMetadata.filePath)
        if (existingIndex !== -1) {
            files[existingIndex] = fileMetadata
        } else {
            files.push(fileMetadata)
        }

        const zippedMetadata = await this.createZipForFile(
            currentWorkspace,
            language,
            [fileMetadata],
            path.relative(workspaceUri.path, fileUri.path)
        )
        return zippedMetadata
    }

    handleDeletedPathAndGetLanguages(fileUri: string, workspaceRoot: WorkspaceFolder): CodewhispererLanguage[] {
        const fileLanguage = getCodeWhispererLanguageIdFromPath(fileUri)
        const programmingLanguages = new Set<CodewhispererLanguage>()

        // Add the file language if we can determine it, but don't return early
        if (fileLanguage && SUPPORTED_WORKSPACE_CONTEXT_LANGUAGES.includes(fileLanguage)) {
            programmingLanguages.add(fileLanguage)
        }

        const languagesMap = this.getLanguagesForWorkspaceFolder(workspaceRoot)
        if (!languagesMap) {
            return Array.from(programmingLanguages)
        }

        const deletedFilePath = URI.parse(fileUri).fsPath

        // Check and update the language maps
        for (const [language, files] of languagesMap.entries()) {
            const affectedFiles = files.filter(
                file => file.filePath.startsWith(deletedFilePath) || file.filePath === deletedFilePath
            )

            if (affectedFiles.length > 0) {
                programmingLanguages.add(language)

                // Update the map by removing affected files
                const remainingFiles = files.filter(file => !affectedFiles.includes(file))
                if (remainingFiles.length === 0) {
                    languagesMap.delete(language)
                } else {
                    languagesMap.set(language, remainingFiles)
                }
            }
        }
        return Array.from(programmingLanguages)
    }

    async handleRename(workspaceFolder: WorkspaceFolder, oldUri: string, newUri: string): Promise<FileMetadata[]> {
        // First remove the old entry
        this.handleDeletedPathAndGetLanguages(oldUri, workspaceFolder)

        // Then process the new path
        let filesMetadata: FileMetadata[] = []
        if (isDirectory(newUri)) {
            if (!isEmptyDirectory(newUri)) {
                filesMetadata = await this.addNewDirectories([URI.parse(newUri)])
            }
        } else {
            filesMetadata = [await this.processNewFile(workspaceFolder, newUri)]
        }

        return filesMetadata
    }

    getLanguagesForWorkspaceFolder(
        workspaceFolder: WorkspaceFolder
    ): Map<CodewhispererLanguage, FileMetadata[]> | undefined {
        // Find the matching workspace folder by URI
        for (const [existingFolder, languagesMap] of this.filesByWorkspaceFolderAndLanguage) {
            if (existingFolder.uri === workspaceFolder.uri) {
                return languagesMap
            }
        }
        return undefined
    }

    async createZipForDependencies(
        workspaceFolder: WorkspaceFolder,
        language: CodewhispererLanguage,
        files: FileMetadata[],
        subDirectory: string = '',
        zipChunkIndex: number
    ): Promise<FileMetadata> {
        const zipFileName = `${zipChunkIndex}_${Date.now()}.zip`
        const zipBuffer = await this.createZipBuffer(files)

        return {
            filePath: '', // Virtual file that only exists in memory
            relativePath: path.join(workspaceFolder.name, subDirectory, zipFileName),
            language,
            contentLength: zipBuffer.length,
            lastModified: Date.now(),
            content: zipBuffer,
            workspaceFolder: workspaceFolder,
        }
    }

    async processDirectory(
        workspaceFolder: WorkspaceFolder,
        directoryPath: string,
        baseRelativePath: string = ''
    ): Promise<Map<CodewhispererLanguage, FileMetadata[]>> {
        const filesByLanguage = new Map<CodewhispererLanguage, FileMetadata[]>()

        const files = []
        const filesStream = glob.stream(['**/*'], {
            cwd: directoryPath,
            dot: false,
            ignore: IGNORE_PATTERNS,
            followSymbolicLinks: false,
            absolute: false,
            onlyFiles: true,
        })

        for await (const entry of filesStream) {
            if (files.length >= MAX_FILES) {
                break
            }
            files.push(entry.toString())
        }

        const hasJavaFile = files.some(file => file.endsWith('.java'))

        for (const relativePath of files) {
            const fullPath = path.join(directoryPath, relativePath)
            const isJavaProjectFile = isJavaProjectFileFromPath(fullPath)
            const language = isJavaProjectFileFromPath(fullPath) ? 'java' : getCodeWhispererLanguageIdFromPath(fullPath)

            if (
                !language ||
                !SUPPORTED_WORKSPACE_CONTEXT_LANGUAGES.includes(language) ||
                // skip processing the java project file if there's no java source file
                (!hasJavaFile && isJavaProjectFile)
            ) {
                continue
            }

            try {
                const fileMetadata = await this.createFileMetadata(
                    fullPath,
                    path.join(baseRelativePath, relativePath),
                    language,
                    workspaceFolder
                )

                if (!filesByLanguage.has(language)) {
                    filesByLanguage.set(language, [])
                }
                filesByLanguage.get(language)!.push(fileMetadata)
            } catch (error) {
                this.logging.warn(`Error processing file ${fullPath}: ${error}`)
            }
        }

        return filesByLanguage
    }

    // TODO, if MD5 hash is not needed, better to remove this function and remove content from FileMetadata interface to be memory efficient
    // Doing the readfile call inside this function and storing the contents in the FileMetadata allows us to call readFile only once
    // instead of calling it twice: once in md5 calculation and once during zip creation
    private async createFileMetadata(
        filePath: string,
        relativePath: string,
        language: CodewhispererLanguage,
        workspaceFolder: WorkspaceFolder
    ): Promise<FileMetadata> {
        const fileContent = fs.readFileSync(filePath)
        return {
            filePath,
            contentLength: fileContent.length,
            lastModified: fs.statSync(filePath).mtimeMs,
            content: fileContent,
            language,
            relativePath,
            workspaceFolder,
        }
    }

    private async createZipForLanguage(
        workspaceFolder: WorkspaceFolder,
        fileSizeDetails: FileSizeDetails,
        language: CodewhispererLanguage,
        files: FileMetadata[],
        subDirectory: string = ''
    ): Promise<FileMetadata | undefined> {
        let skippedSize = 0
        let skippedFiles = 0
        const filesToInclude: FileMetadata[] = []

        // Don't add files to the zip if the total size of uncompressed source code would go over the limit
        // Currently there is no ordering on the files. If the first file added to the zip is equal to the limit, only it will be added and no other files will be added
        for (const file of files) {
            if (fileSizeDetails.includedSize + file.contentLength <= MAX_UNCOMPRESSED_SRC_SIZE_BYTES) {
                filesToInclude.push(file)
                fileSizeDetails.includedSize += file.contentLength
                fileSizeDetails.includedFileCount += 1
            } else {
                skippedSize += file.contentLength
                skippedFiles += 1
                fileSizeDetails.skippedSize += file.contentLength
                fileSizeDetails.skippedFileCount += 1
            }
        }

        if (skippedFiles > 0) {
            this.log(
                `Skipped ${skippedFiles} ${language} files of total size ${skippedSize} bytes due to exceeding the maximum zip size`
            )
        }

        if (filesToInclude.length === 0) {
            return undefined
        }

        const zipBuffer = await this.createZipBuffer(filesToInclude)

        return {
            filePath: '', // Virtual file that only exists in memory
            relativePath: path.join(workspaceFolder.name, subDirectory, `files.zip`),
            language,
            contentLength: zipBuffer.length,
            lastModified: Date.now(),
            content: zipBuffer,
            workspaceFolder: workspaceFolder,
        }
    }

    private async createZipForFile(
        workspaceFolder: WorkspaceFolder,
        language: CodewhispererLanguage,
        files: FileMetadata[],
        subDirectory: string = ''
    ): Promise<FileMetadata> {
        const zip = new JSZip()
        for (const file of files) {
            zip.file(path.basename(file.relativePath), file.content)
        }
        const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' })

        return {
            filePath: '', // Virtual file that only exists in memory
            relativePath: path.join(workspaceFolder.name, subDirectory, 'files.zip'),
            language,
            contentLength: zipBuffer.length,
            lastModified: Date.now(),
            content: zipBuffer,
            workspaceFolder: workspaceFolder,
        }
    }

    private async createZipBuffer(files: FileMetadata[]): Promise<Buffer> {
        const zip = new JSZip()

        // Common compressed file extensions
        const compressedExtensions = new Set(['.jar', '.zip', '.gz', '.bz2', '.7z', '.rar', '.war', '.ear', '.apk'])

        for (const file of files) {
            const fileExt = path.extname(file.relativePath).toLowerCase()

            if (compressedExtensions.has(fileExt)) {
                // Store already compressed files without additional compression
                zip.file(file.relativePath, file.content, {
                    compression: 'STORE', // No compression, just store
                })
            } else {
                // Use default compression for other files
                zip.file(file.relativePath, file.content, {
                    compression: 'DEFLATE',
                    compressionOptions: {
                        level: 9, // Maximum compression (0-9)
                    },
                })
            }
        }

        return await zip.generateAsync({ type: 'nodebuffer' })
    }

    private findWorkspaceFolder(workspace: WorkspaceFolder): WorkspaceFolder | undefined {
        for (const [existingWorkspace] of this.filesByWorkspaceFolderAndLanguage) {
            if (existingWorkspace.uri === workspace.uri) {
                return existingWorkspace
            }
        }
        return undefined
    }

    private async updateWorkspaceFiles(
        workspaceFolder: WorkspaceFolder,
        filesByLanguage: Map<CodewhispererLanguage, FileMetadata[]>
    ): Promise<void> {
        // Find existing workspace folder or use current one
        const workspaceKey = this.findWorkspaceFolder(workspaceFolder) || workspaceFolder

        // Initialize map for new workspace folders
        if (!this.filesByWorkspaceFolderAndLanguage.has(workspaceKey)) {
            this.filesByWorkspaceFolderAndLanguage.set(workspaceKey, new Map<CodewhispererLanguage, FileMetadata[]>())
        }

        const workspaceMap = this.filesByWorkspaceFolderAndLanguage.get(workspaceKey)!
        for (const [language, files] of filesByLanguage.entries()) {
            if (!workspaceMap.has(language)) {
                workspaceMap.set(language, [])
            }
            workspaceMap.get(language)!.push(...files)
        }
    }

    private async processWorkspaceFolders(workspaceFolders: WorkspaceFolder[]): Promise<FileMetadata[]> {
        const startTime = performance.now()
        let zipFileMetadata: FileMetadata[] = []
        const fileSizeDetails: FileSizeDetails = {
            includedFileCount: 0,
            includedSize: 0,
            skippedFileCount: 0,
            skippedSize: 0,
        }

        for (const workspaceFolder of workspaceFolders) {
            if (this.isDisposed) {
                break
            }
            const workspacePath = URI.parse(workspaceFolder.uri).path

            try {
                const filesByLanguage = await this.processDirectory(workspaceFolder, workspacePath)
                const fileMetadata = await this.processFilesByLanguage(
                    workspaceFolder,
                    fileSizeDetails,
                    filesByLanguage
                )
                zipFileMetadata.push(...fileMetadata)
            } catch (error) {
                this.logging.warn(`Error processing workspace folder ${workspacePath}: ${error}`)
            }
        }
        if (fileSizeDetails.skippedFileCount > 0) {
            this.logging.warn(
                `Skipped ${fileSizeDetails.skippedFileCount} files (total size: ` +
                    `${fileSizeDetails.skippedSize} bytes) due to exceeding the maximum artifact size`
            )
        }

        const totalTime = performance.now() - startTime
        this.log(`Creating workspace source code artifacts took: ${totalTime.toFixed(2)}ms`)

        return zipFileMetadata
    }

    private async processFilesByLanguage(
        workspaceFolder: WorkspaceFolder,
        fileSizeDetails: FileSizeDetails,
        filesByLanguage: Map<CodewhispererLanguage, FileMetadata[]>,
        relativePath?: string
    ): Promise<FileMetadata[]> {
        const zipFileMetadata: FileMetadata[] = []
        await this.updateWorkspaceFiles(workspaceFolder, filesByLanguage)
        for (const [language, files] of filesByLanguage.entries()) {
            if (this.isDisposed) {
                break
            }
            // Generate java .classpath and .project files
            const processedFiles =
                language === 'java' ? await this.processJavaProjectConfig(workspaceFolder, files) : files

            const zipMetadata = await this.createZipForLanguage(
                workspaceFolder,
                fileSizeDetails,
                language,
                processedFiles,
                relativePath
            )

            if (zipMetadata) {
                this.log(
                    `Created zip for language ${language} out of ${processedFiles.length} files in ${workspaceFolder.name}`
                )
                zipFileMetadata.push(zipMetadata)
            }
        }
        return zipFileMetadata
    }

    private log(...messages: string[]) {
        this.logging.log(messages.join(' '))
    }

    private async processJavaProjectConfig(
        workspaceFolder: WorkspaceFolder,
        files: FileMetadata[]
    ): Promise<FileMetadata[]> {
        const workspacePath = URI.parse(workspaceFolder.uri).path
        const hasJavaFiles = files.some(file => file.language === 'java' && file.relativePath.endsWith('.java'))

        if (!hasJavaFiles) {
            return files
        }

        // Extract project roots from file paths for scenarios that workspace were not opened up from project roots
        const projectRoots = this.extractJavaProjectRoots(files)
        const additionalFiles: FileMetadata[] = []

        // Process each project root separately
        for (const projectRoot of projectRoots) {
            const isRootProject = projectRoot === '.'
            const projectPath = path.join(workspacePath, projectRoot)

            // Create project-specific "workspace folder" for analyzing
            const projectWorkspaceFolder: WorkspaceFolder = {
                ...workspaceFolder,
                uri: URI.file(projectPath).toString(),
            }

            const javaManager = new JavaProjectAnalyzer(projectPath)
            const structure = await javaManager.analyze()
            const generator = new EclipseConfigGenerator(projectWorkspaceFolder, this.logging)

            const classpathFiles = await generator.generateDotClasspath(structure)
            const projectConfigFiles = await generator.generateDotProject(
                isRootProject ? workspaceFolder.name : projectRoot,
                structure
            )

            // Update relativePath to include project directory for zip upload
            const updatedFiles = [...classpathFiles, ...projectConfigFiles].map(file => ({
                ...file,
                relativePath: isRootProject ? file.relativePath : path.join(projectRoot, file.relativePath),
            }))

            additionalFiles.push(...updatedFiles)
        }

        // Fallback methods to generate a .classpath at workspace folder root
        if (projectRoots.length == 0) {
            const javaManager = new JavaProjectAnalyzer(workspacePath)
            const structure = await javaManager.analyze()
            const generator = new EclipseConfigGenerator(workspaceFolder, this.logging)
            const classpathFiles = await generator.generateDotClasspath(structure)
            for (const classpathFile of classpathFiles) {
                additionalFiles.push(classpathFile)
            }
            const projectFiles = await generator.generateDotProject(path.basename(workspacePath), structure)
            for (const projectFile of projectFiles) {
                additionalFiles.push(projectFile)
            }
        }

        return [...files, ...additionalFiles]
    }

    private extractJavaProjectRoots(files: FileMetadata[]): string[] {
        const projectRoots = new Set<string>()
        files
            .filter(file => isJavaProjectFileFromPath(file.relativePath))
            .map(file => path.dirname(file.relativePath))
            .forEach(projectRoot => projectRoots.add(projectRoot))
        return Array.from(projectRoots)
    }
}
