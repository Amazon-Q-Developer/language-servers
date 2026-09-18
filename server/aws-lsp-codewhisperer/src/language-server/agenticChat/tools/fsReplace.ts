import {
    CommandValidation,
    ExplanatoryParams,
    InvokeOutput,
    requiresPathAcceptance,
    resolveCanonicalPath,
} from './toolShared'
import { EmptyPathError, EmptyDiffsError, FileNotExistsError, TextNotFoundError, MultipleMatchesError } from '../errors'
import { Features } from '@aws/language-server-runtimes/server-interface/server'
import * as os from 'os'

interface BaseParams extends ExplanatoryParams {
    path: string
}

export interface Diff {
    oldStr: string
    newStr: string
}

export interface ReplaceParams extends BaseParams {
    diffs: Diff[]
}

export type FsReplaceParams = ReplaceParams

export class FsReplace {
    private readonly logging: Features['logging']
    private readonly workspace: Features['workspace']
    private readonly lsp: Features['lsp']

    constructor(features: Pick<Features, 'workspace' | 'logging' | 'lsp'> & Partial<Features>) {
        this.logging = features.logging
        this.workspace = features.workspace
        this.lsp = features.lsp
    }

    public async validate(params: FsReplaceParams): Promise<void> {
        if (!params.path) {
            throw new EmptyPathError()
        }
        if (!params.diffs || params.diffs.length === 0) {
            throw new EmptyDiffsError()
        }
        const sanitizedPath = await resolveCanonicalPath(params.path)
        const fileExists = await this.workspace.fs.exists(sanitizedPath)
        if (!fileExists) {
            throw new FileNotExistsError()
        }
    }

    public async invoke(params: FsReplaceParams): Promise<InvokeOutput> {
        const sanitizedPath = await resolveCanonicalPath(params.path)

        await this.handleReplace(params, sanitizedPath)

        return {
            output: {
                kind: 'text',
                content: 'File updated successfully',
            },
        }
    }

    public async requiresAcceptance(
        params: FsReplaceParams,
        approvedPaths?: Map<string, Set<string>>
    ): Promise<CommandValidation> {
        return requiresPathAcceptance(params.path, 'fsReplace', this.workspace, this.logging, approvedPaths)
    }

    private async handleReplace(params: ReplaceParams, sanitizedPath: string): Promise<void> {
        const fileContent = await this.workspace.fs.readFile(sanitizedPath)
        const newContent = getReplaceContent(params, fileContent)
        await this.workspace.fs.writeFile(sanitizedPath, newContent)
    }

    public getSpec() {
        return {
            name: 'fsReplace',
            description:
                'A tool for search and replace contents of an existing file.\n\n' +
                '## Overview\n' +
                'This tool replaces sections of content in an existing file using `oldStr`/`newStr` blocks that define exact changes to specific parts of the file. You MUST ALWAYS group as many changes as you can by populating the diffs array with multiple `oldStr`/`newStr` pairs, DO NOT be overly cautious and methodical by making one change at a time on the same file.\n\n' +
                '## When to use\n' +
                '- When you need to make targeted changes to specific parts of a file\n' +
                '- When you need to update multiple sections of the same file\n' +
                '## When not to use\n' +
                '- When you need to create a new file\n' +
                '- When you need to rename or move a file\n\n' +
                '## IMPORTANT Notes\n' +
                '- Use this tool to delete code by using empty `newStr` parameter\n' +
                '- The `oldStr` parameter should match EXACTLY one or more consecutive lines from the target file. Be mindful of whitespaces including the tabs and spaces! Include just the changing lines, and a few surrounding lines if needed for uniqueness. Do not include long runs of unchanging lines in `oldStr`\n' +
                '- When multiple edits to the same file are needed, ALWAYS populate the diffs array with MULTIPLE `oldStr` and `newStr` pairs. This improves efficiency by reducing the number of tool calls and ensures the file remains in a consistent state',
            inputSchema: {
                type: 'object',
                properties: {
                    explanation: {
                        description:
                            'One sentence explanation as to why this tool is being used, and how it contributes to the goal.',
                        type: 'string',
                    },
                    diffs: {
                        description:
                            'A list of `oldStr`/`newStr` pairs to replace content in an existing file. Example: `[{"oldStr": "existingContent", "newStr": "newContent"}]`. CRITICAL: Use JSON array syntax [{}], NOT string "[{}]". Common error: wrapping array in quotes.',
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                oldStr: {
                                    description:
                                        'The exact string content to be replaced in the file. Must match EXACTLY including whitespaces (indentations, tabs, spaces) and line breaks.',
                                    type: 'string',
                                },
                                newStr: {
                                    description:
                                        'The new string content that will replace the oldStr. Use empty string to delete content.',
                                    type: 'string',
                                },
                            },
                            required: ['oldStr'],
                        },
                    },
                    path: {
                        description:
                            'Absolute path to a file, e.g. `/repo/file.py` for Unix-like system including Unix/Linux/macOS or `d:\\repo\\file.py` for Windows.',
                        type: 'string',
                    },
                },
                required: ['diffs', 'path'],
            },
        } as const
    }
}

const getReplaceContent = (params: ReplaceParams, fileContent: string) => {
    // Detect line ending from oldContent (CRLF, LF, or CR)
    const match = fileContent.match(/\r\n|\r|\n/)
    const lineEnding = match ? match[0] : os.EOL

    for (const diff of params.diffs) {
        if (diff.newStr == undefined) {
            diff.newStr = ''
        }
        if (diff.oldStr === diff.newStr) {
            continue
        }

        // Normalize oldStr and newStr to match fileContent's line ending style
        const normalizedOldStr = diff.oldStr.split(/\r\n|\r|\n/).join(lineEnding)
        const normalizedNewStr = diff.newStr.split(/\r\n|\r|\n/).join(lineEnding)

        // Use string indexOf and substring for safer replacement with special characters
        const startIndex = fileContent.indexOf(normalizedOldStr)

        if (startIndex === -1) {
            throw new TextNotFoundError(diff.oldStr)
        }

        // Check for multiple occurrences
        const secondIndex = fileContent.indexOf(normalizedOldStr, startIndex + 1)
        if (secondIndex !== -1) {
            throw new MultipleMatchesError(diff.oldStr)
        }

        // Perform the replacement using string operations instead of regex
        fileContent =
            fileContent.substring(0, startIndex) +
            normalizedNewStr +
            fileContent.substring(startIndex + normalizedOldStr.length)
    }
    return fileContent
}
