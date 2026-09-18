import {
    CommandValidation,
    ExplanatoryParams,
    InvokeOutput,
    requiresPathAcceptance,
    resolveCanonicalPath,
} from './toolShared'
import { EmptyPathError, MissingContentError, FileExistsWithSameContentError, EmptyAppendContentError } from '../errors'
import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { LocalProjectContextController } from '../../../shared/localProjectContextController'
import { URI } from 'vscode-uri'

interface BaseParams extends ExplanatoryParams {
    path: string
}

export interface CreateParams extends BaseParams {
    command: 'create'
    fileText: string
}

export interface AppendParams extends BaseParams {
    command: 'append'
    fileText: string
}

export type FsWriteParams = CreateParams | AppendParams

export interface FsWriteBackup {
    content: string
    isNew: boolean
}

export class FsWrite {
    private readonly logging: Features['logging']
    private readonly workspace: Features['workspace']
    private readonly lsp: Features['lsp']

    constructor(features: Pick<Features, 'workspace' | 'logging' | 'lsp'> & Partial<Features>) {
        this.logging = features.logging
        this.workspace = features.workspace
        this.lsp = features.lsp
    }

    public async validate(params: FsWriteParams): Promise<void> {
        if (!params.path) {
            throw new EmptyPathError()
        }
        const sanitizedPath = await resolveCanonicalPath(params.path)
        switch (params.command) {
            case 'create': {
                if (params.fileText === undefined) {
                    throw new MissingContentError()
                }
                const fileExists = await this.workspace.fs.exists(sanitizedPath)
                if (fileExists) {
                    const oldContent = await this.workspace.fs.readFile(sanitizedPath)
                    if (oldContent === params.fileText) {
                        throw new FileExistsWithSameContentError()
                    }
                }
                break
            }
            case 'append':
                if (!params.fileText) {
                    throw new EmptyAppendContentError()
                }
                break
        }
    }

    public async invoke(params: FsWriteParams): Promise<InvokeOutput> {
        const sanitizedPath = await resolveCanonicalPath(params.path)
        let content = ''
        switch (params.command) {
            case 'create':
                await this.handleCreate(params, sanitizedPath)
                content = 'File created successfully'
                break
            case 'append':
                await this.handleAppend(params, sanitizedPath)
                content = 'File appended successfully'
                break
        }

        return {
            output: {
                kind: 'text',
                content,
            },
        }
    }

    public async queueDescription(updates: WritableStream): Promise<void> {
        const updateWriter = updates.getWriter()
        // Write an empty string because FsWrite should only show a chat message with header
        await updateWriter.write(' ')
        await updateWriter.close()
        updateWriter.releaseLock()
    }

    public async requiresAcceptance(
        params: FsWriteParams,
        approvedPaths?: Map<string, Set<string>>
    ): Promise<CommandValidation> {
        return requiresPathAcceptance(params.path, 'fsWrite', this.workspace, this.logging, approvedPaths)
    }

    private async handleCreate(params: CreateParams, sanitizedPath: string): Promise<void> {
        const content = params.fileText
        await this.workspace.fs.writeFile(sanitizedPath, content)

        // Add created file to @Files list
        void LocalProjectContextController.getInstance().then(controller => {
            const filePath = URI.file(sanitizedPath).fsPath
            return controller.updateIndexAndContextCommand([filePath], true)
        })
    }

    private async handleAppend(params: AppendParams, sanitizedPath: string): Promise<void> {
        const fileContent = await this.workspace.fs.readFile(sanitizedPath)
        const newContent = getAppendContent(params, fileContent)
        await this.workspace.fs.writeFile(sanitizedPath, newContent)
    }

    public getSpec() {
        const commands = ['create', 'append']
        return {
            name: 'fsWrite',
            description:
                'A tool for creating and appending files. This tool does NOT automatically create parent directories if they do not exist, so you must ensure the directory exists before file creation.\n\n' +
                '## Overview\n' +
                'This tool provides commands for file operations including creating new files and appending content to existing files.\n\n' +
                '## When to use\n' +
                '- When creating new files or overwriting existing files with new content (create)\n' +
                '- When adding text to the end of an existing file (append)\n\n' +
                '## When not to use\n' +
                '- When you need to modify or delete specific portions of a file (use fsReplace instead)\n' +
                '- When you need to rename, move, or delete a file\n\n' +
                '## Command details\n' +
                '- `create`: Creates a new file at `path` with the specified `fileText` content. If the file already exists, it will be overwritten. Use this command for initial file creation, scaffolding new projects, or replacing entire file contents.\n' +
                '- `append`: Adds the specified `fileText` content to the end of an existing file at `path`. Automatically adds a newline if the file does not end with one. The file must exist before using this command.',
            inputSchema: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        enum: commands,
                        description: 'The command to run. Allowed options are: `create`, `append`.',
                    },
                    explanation: {
                        description:
                            'One sentence explanation as to why this tool is being used, and how it contributes to the goal.',
                        type: 'string',
                    },
                    fileText: {
                        description:
                            'The content to write to the file. For `create`, this is the entire file content. For `append`, this is the content to add to the end of the file.',
                        type: 'string',
                    },
                    path: {
                        description:
                            'Absolute path to a file, e.g. `/repo/file.py` for Unix-like system including Unix/Linux/macOS or `d:\\repo\\file.py` for Windows.',
                        type: 'string',
                    },
                },
                required: ['command', 'path', 'fileText'],
            },
        } as const
    }
}

const getAppendContent = (params: AppendParams, oldContent: string) => {
    const needsNewline = oldContent.length !== 0 && !oldContent.endsWith('\n')

    let contentToAppend = params.fileText
    if (needsNewline) {
        contentToAppend = '\n' + contentToAppend
    }

    return oldContent + contentToAppend
}
