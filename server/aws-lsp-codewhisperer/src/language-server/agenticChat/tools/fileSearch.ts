// FileSearch tool based on ListDirectory implementation
import {
    CommandValidation,
    InvokeOutput,
    requiresPathAcceptance,
    resolveCanonicalPath,
    validatePath,
} from './toolShared'
import { workspaceUtils } from '@aws/lsp-core'
import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { DEFAULT_EXCLUDE_DIRS, DEFAULT_EXCLUDE_FILES } from '../../chat/constants'
import { CancellationToken } from '@aws/language-server-runtimes/protocol'
const Fuse = require('fuse.js')

export interface FileSearchParams {
    path: string
    queryName: string
    maxDepth?: number
    caseSensitive?: boolean
    threshold?: number
}

export class FileSearch {
    private readonly logging: Features['logging']
    private readonly workspace: Features['workspace']
    private readonly lsp: Features['lsp']

    constructor(features: Pick<Features, 'logging' | 'workspace' | 'lsp'>) {
        this.logging = features.logging
        this.workspace = features.workspace
        this.lsp = features.lsp
    }

    public async validate(params: FileSearchParams): Promise<void> {
        if (params.maxDepth !== undefined && params.maxDepth < 0) {
            throw new Error('MaxDepth cannot be negative.')
        }
        await validatePath(params.path, this.workspace.fs.exists)

        if (params.queryName.trim() == '') {
            throw new Error('queryName cannot be empty')
        }

        if (params.threshold) {
            if (params.threshold > 1 || params.threshold < 0) {
                throw new Error('Invalid threshold, must be a number between 0 and 1')
            }
        }
    }

    public async queueDescription(params: FileSearchParams, updates: WritableStream, requiresAcceptance: boolean) {
        // deprecated, no-op
        return
    }

    public async requiresAcceptance(
        params: FileSearchParams,
        approvedPaths?: Map<string, Set<string>>
    ): Promise<CommandValidation> {
        return requiresPathAcceptance(params.path, 'fileSearch', this.workspace, this.logging, approvedPaths)
    }

    public async invoke(params: FileSearchParams, token?: CancellationToken): Promise<InvokeOutput> {
        const path = await resolveCanonicalPath(params.path)
        try {
            // Get all files and directories
            const listing = await workspaceUtils.readDirectoryRecursively(
                { workspace: this.workspace, logging: this.logging },
                path,
                { maxDepth: params.maxDepth, excludeDirs: DEFAULT_EXCLUDE_DIRS, excludeFiles: DEFAULT_EXCLUDE_FILES },
                token
            )

            const fuseOptions = {
                isCaseSensitive: false,
                threshold: 0.2,
                shouldSort: true,
                ignoreFieldNorm: true,
                includeScore: true,
                ignoreLocation: true,
            }
            if (params.caseSensitive) {
                fuseOptions.isCaseSensitive = true
            }
            if (params.threshold) {
                fuseOptions.threshold = params.threshold
            }

            const fuse = new Fuse(listing, fuseOptions)
            const queryResult = fuse.search(params.queryName)
            const results = queryResult.map((result: any) => result.item)

            if (results.length === 0) {
                return this.createOutput(
                    `No files or directories matching queryName "${params.queryName}" found in ${path} with threshold`
                )
            }

            return this.createOutput(results.join('\n'))
        } catch (error: any) {
            this.logging.error(`Failed to search directory "${path}": ${error.message || error}`)
            throw new Error(`Failed to search directory "${path}": ${error.message || error}`)
        }
    }

    private createOutput(content: string): InvokeOutput {
        return {
            output: {
                kind: 'text',
                content: content,
            },
        }
    }

    public getSpec() {
        return {
            name: 'fileSearch',
            description:
                'Search for files and directories in a target path using fuzzy name matching.\n\n' +
                '## Overview\n' +
                'This tool recursively traverses a directory and performs fuzzy matching on filenames and directory names based on a given query.\n' +
                'It ignores common build and dependency directories.\n\n' +
                '## When to use\n' +
                '- When you need to locate files or folders by approximate names\n' +
                "- When you don't know exact names of files or directories\n" +
                '- When you want to skip a listDirectory step\n\n' +
                '## When not to use\n' +
                '- When you need to search file contents\n' +
                '- When you already know the exact file path\n' +
                '- When you need to list all files in a directory (use listDirectory instead)\n\n' +
                '## Notes\n' +
                '- This tool is more effective than running a command like `find` using `executeBash` tool\n' +
                '- Results are prefixed [F] to indicate files and [D] to indicate directories in sorted order\n' +
                '- Case sensitivity can be controlled with the caseSensitive parameter and is off by default\n' +
                '- Use the `maxDepth` parameter to control how deep the directory traversal goes',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description:
                            'Absolute path to a directory, e.g. `/repo` for Unix-like system including Unix/Linux/macOS or `d:\\repo\\` for Windows',
                    },
                    queryName: {
                        type: 'string',
                        description: 'Name fragment to fuzzy match against file and directory names.',
                    },
                    maxDepth: {
                        type: 'number',
                        description:
                            'Maximum depth to traverse when searching files. Use `0` to search only under the specified directory, `1` to include immediate subdirectories, etc. If it is not provided, it will search all subdirectories recursively.',
                    },
                    caseSensitive: {
                        type: 'boolean',
                        description:
                            'Whether the pattern matching should be case-sensitive. Defaults to false if not provided.',
                    },
                    threshold: {
                        type: 'number',
                        description:
                            'Fuzzy match threshold (0-1). Lower = stricter match. A threshold of 0.0 requires a perfect match, a threshold of 1.0 would match anything. Default is 0.2.',
                    },
                },
                required: ['path', 'queryName'],
            },
        } as const
    }
}

export function isFileSearchParams(input: any): input is FileSearchParams {
    return input && typeof input.path === 'string' && typeof input.queryName === 'string'
}
