import { Logging, Workspace } from '@aws/language-server-runtimes/server-interface'
import { sleep } from './commonUtil'
import * as CodeWhispererConstants from './constants'
import { DependencyGraph, Truncation } from './dependencyGraph'
import path = require('path')

export const importRegex = /((global\s+)?using\s+(static\s+)?)([A-Z]\w*\s*?=\s*)?([A-Z]\w*(\.[A-Z]\w*)*);/gm

export class CsharpDependencyGraph extends DependencyGraph {
    // This contains a dictionary of namespace name and the set of filepaths, where namespace has been defined.
    namespaceToFilepathDirectory = new Map<string, Set<string>>()
    constructor(workspace: Workspace, logging: Logging, workspaceFolderPath: string) {
        super(workspace, logging, workspaceFolderPath)
    }

    /**
     * Creates a dictionary of namespace to associated filepaths. There is no direct way to find a file which contains the namespace
     * used as part of the dependecy of a file. Also, more than one file can have same namespace name. Hence, this method reads all
     * the files within given workspace and creates a dictionary of namespace name to set of filepaths.
     * @param workspacePath provides absolute path for workspace
     */
    async createNamespaceFilenameMapper(workspacePath: string) {
        const files = await this.getFiles(workspacePath)

        const csharpFiles = await this.filterFiles(workspacePath, files)

        const searchRegEx = new RegExp('namespace ([A-Z]\\w*(\\.[A-Z]\\w*)*)', 'g')
        for (const filePath of csharpFiles) {
            const content = await this.workspace.fs.readFile(filePath)
            if (!content) {
                continue
            }
            for (const matchedStr of content.matchAll(searchRegEx)) {
                if (this.namespaceToFilepathDirectory.has(matchedStr[1])) {
                    this.namespaceToFilepathDirectory.get(matchedStr[1])?.add(filePath)
                } else {
                    this.namespaceToFilepathDirectory.set(matchedStr[1], new Set([filePath]))
                }
            }
        }
    }

    async generateTruncation(filePath: string): Promise<Truncation> {
        try {
            const dirName = path.dirname(filePath)

            await this.createNamespaceFilenameMapper(dirName)

            if (!dirName) {
                this._pickedSourceFiles.add(filePath)
            } else {
                await this.searchDependency(filePath)
                await this.traverseDir(dirName)
            }
            await sleep(1000)
            const truncDirPath = this.getTruncDirPath()
            await this.copyFilesToTmpDir(this._pickedSourceFiles, truncDirPath)
            const { zipFileBuffer, zipFileSize } = this.createZip(truncDirPath)

            return {
                rootDir: truncDirPath,
                zipFileBuffer,
                scannedFiles: this._pickedSourceFiles,
                srcPayloadSizeInBytes: this._totalSize,
                zipFileSizeInBytes: zipFileSize,
                buildPayloadSizeInBytes: 0,
                lines: this._totalLines,
            }
        } catch (error) {
            this.logging.log(`ERROR: ${error}`)
            throw error
        }
    }

    async searchDependency(uri: string): Promise<Set<string>> {
        const filePath = uri
        const q: string[] = []
        q.push(filePath)
        while (q.length > 0) {
            let count: number = q.length
            while (count > 0) {
                if (this.exceedsSizeLimit(this._totalSize)) {
                    return this._pickedSourceFiles
                }
                count -= 1
                const currentFilePath = q.shift()

                if (currentFilePath === undefined) {
                    throw new Error('"undefined" is invalid for queued file.')
                }
                this._pickedSourceFiles.add(currentFilePath)
                this._totalSize += (await this.workspace.fs.getFileSize(currentFilePath)).size

                const content = await this.workspace.fs.readFile(currentFilePath)

                if (content) {
                    const imports = this.readImports(content)
                    const dependencies = this.getDependencies(imports)
                    dependencies.forEach(dependency => {
                        q.push(dependency)
                    })
                }
            }
        }
        return this._pickedSourceFiles
    }

    /**
     * Get a list of all the imports being used in the given input content.
     * @param content file content to detect import lines
     * @returns list of import lines
     */
    readImports(content: string) {
        const lineBreakRegex = new RegExp('\\r?\\n', 'g')
        this._totalLines += content.split(lineBreakRegex).length
        const importNamespaceRegex = new RegExp(
            '(\\s*(global\\s+)?using\\s+(static\\s+)?)([A-Z]\\w*\\s*?=\\s*)?([A-Z]\\w*(\\.[A-Z]\\w*)*);',
            'g'
        )
        const imports: string[] = []
        for (const matchedStr of content.matchAll(importNamespaceRegex)) {
            imports.push(matchedStr[5])
        }
        return imports
    }

    override getDependencies(imports: string[]) {
        const dep = imports.map(importStr => {
            const files = this.namespaceToFilepathDirectory.get(importStr)
            return files?.size ? Array.from(files) : []
        })
        return new Set(dep.flat())
    }

    override async traverseDir(dirPath: string) {
        if (this.exceedsSizeLimit(this._totalSize)) {
            return
        }

        const files = await this.getFiles(dirPath)

        const csharpFiles = await this.filterFiles(dirPath, files)

        for (const file of csharpFiles) {
            const fileSize = (await this.workspace.fs.getFileSize(file)).size
            const doesExceedsSize = this.exceedsSizeLimit(this._totalSize + fileSize)
            this.isProjectTruncated = this.isProjectTruncated || doesExceedsSize

            if (doesExceedsSize) {
                return
            }
            if (!this._pickedSourceFiles.has(file)) {
                await this.searchDependency(file)
            }
        }
    }

    // filters out gitIgnored and non-c# files
    async filterFiles(rootPath: string, files: string[]): Promise<string[]> {
        const gitAllowedFiles = await this.filterOutGitIgnoredFiles(rootPath, files)
        return gitAllowedFiles.filter(f => f.match(/.*.cs$/gi))
    }

    // Payload Size for C#: 1MB
    getPayloadSizeLimitInBytes(): number {
        return CodeWhispererConstants.codeScanCsharpPayloadSizeLimitBytes
    }
}

export class CsharpDependencyGraphError extends Error {}
