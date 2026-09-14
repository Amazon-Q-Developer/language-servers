import { CommandValidation, InvokeOutput, validatePath } from './toolShared'
import { CancellationError, workspaceUtils } from '@aws/lsp-core'
import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { getWorkspaceFolderPaths } from '@aws/lsp-core/out/util/workspaceUtils'
import { CancellationToken } from '@aws/language-server-runtimes/protocol'
import { ChildProcess, ChildProcessOptions } from '@aws/lsp-core/out/util/processUtils'
import path = require('path')
import { dirname } from 'path'
import { pathToFileURL } from 'url'

export interface GrepSearchParams {
    path?: string
    query: string
    caseSensitive?: boolean
    excludePattern?: string
    includePattern?: string
}

const RIPGREP_DIR = (() => {
    if (require.main?.filename) {
        return path.join(dirname(require.main.filename), 'ripgrep')
    }
    return path.join(__dirname, 'ripgrep')
})()

/**
 * Represents the structured output from ripgrep search results
 */
export interface SanitizedRipgrepOutput {
    /** Total number of matches across all files */
    matchCount: number

    /** Array of file match details */
    fileMatches: Array<{
        /** Full path to the file */
        filePath: string

        /** Record of line numbers to matched content */
        matches: Record<string, string>[]
    }>
}

export class GrepSearch {
    private readonly logging: Features['logging']
    private readonly workspace: Features['workspace']
    private readonly lsp: Features['lsp']

    constructor(features: Pick<Features, 'logging' | 'workspace' | 'lsp'>) {
        this.logging = features.logging
        this.workspace = features.workspace
        this.lsp = features.lsp
    }

    public async validate(params: GrepSearchParams): Promise<void> {
        if (!params.query || params.query.trim().length === 0) {
            throw new Error('Grep search query cannot be empty.')
        }

        const path = this.getSearchDirectory(params.path)
        if (path.trim().length === 0) {
            throw new Error('Path cannot be empty or no workspace folder is available.')
        }

        await validatePath(path, this.workspace.fs.exists)
    }

    public async queueDescription(params: GrepSearchParams, updates: WritableStream, requiresAcceptance: boolean) {
        const writer = updates.getWriter()
        const closeWriter = async (w: WritableStreamDefaultWriter) => {
            await w.close()
            w.releaseLock()
        }
        if (!requiresAcceptance) {
            await writer.write('')
            await closeWriter(writer)
            return
        }
        await writer.write(`Searching for \"${params.query}\" in ${params.path || 'workspace'}`)
        await closeWriter(writer)
    }

    // TODO (workspace-boundary hardening): this acceptance check performs a
    // string-only, non-symlink-aware workspace containment test on the raw
    // search path. For parity with the file tools, route it through the
    // symlink-aware requiresPathAcceptance helper (as fsRead/fsWrite/
    // listDirectory do) before this tool is enabled. Note this tool is not
    // currently registered as an active tool (see toolServer.ts).
    public async requiresAcceptance(params: GrepSearchParams): Promise<CommandValidation> {
        const path = this.getSearchDirectory(params.path)
        return { requiresAcceptance: !workspaceUtils.isInWorkspace(getWorkspaceFolderPaths(this.workspace), path) }
    }

    public async invoke(params: GrepSearchParams, token?: CancellationToken): Promise<InvokeOutput> {
        const path = this.getSearchDirectory(params.path)
        try {
            const results = await this.executeRipgrep(params, path, token)
            return this.createOutput(results)
        } catch (error: any) {
            if (CancellationError.isUserCancelled(error)) {
                // bubble this up to the main agentic chat loop
                throw error
            }
            this.logging.error(`Failed to search in \"${path}\": ${error.message || error}`)
            throw new Error(`Failed to search in \"${path}\": ${error.message || error}`)
        }
    }

    private getRipgrepLibraryPath(): string {
        if (process.platform === 'win32') {
            return path.join(RIPGREP_DIR, 'rg.exe')
        }

        return path.join(RIPGREP_DIR, 'rg')
    }

    private getSearchDirectory(path?: string): string {
        if (path && path.trim().length !== 0) {
            return path
        }

        // Use current workspace folder as default if path is not provided
        const workspaceFolders = getWorkspaceFolderPaths(this.workspace)
        if (workspaceFolders && workspaceFolders.length !== 0) {
            this.logging.debug(`Using default workspace folder: ${workspaceFolders[0]}`)
            return workspaceFolders[0]
        }

        return ''
    }

    private async executeRipgrep(
        params: GrepSearchParams,
        path: string,
        token?: CancellationToken
    ): Promise<SanitizedRipgrepOutput> {
        return new Promise(async (resolve, reject) => {
            const args: string[] = []

            // Add search options
            if (!(params.caseSensitive ?? false)) {
                args.push('-i') // Case insensitive search
            }
            args.push('-n') // Show line numbers

            // No heading (don't group matches by file)
            args.push('--no-heading')

            // Don't use color in output
            args.push('--color=never')

            // Limit results to prevent overwhelming output
            args.push('-m', '20')

            // Add include/exclude patterns
            if (params.includePattern) {
                // Support multiple include patterns
                const patterns = params.includePattern.split(',')
                for (const pattern of patterns) {
                    args.push('-g', `${pattern.trim()}`)
                }
            }

            if (params.excludePattern) {
                // Support multiple exclude patterns
                const patterns = params.excludePattern.split(',')
                for (const pattern of patterns) {
                    args.push(`-g`, `!${pattern.trim()}`)
                }
            }

            // Add search pattern and path
            args.push(params.query, path)

            this.logging.debug(`Executing ripgrep with args: ${args.join(' ')}`)

            const options: ChildProcessOptions = {
                collect: true,
                logging: 'yes',
            }

            try {
                const rg = new ChildProcess(this.logging, this.getRipgrepLibraryPath(), args, options)
                const result = await rg.run()

                if ((result.exitCode != 0 && result.exitCode != 1) || result.stderr) {
                    throw Error(`Error running the tool with exit code: ${result.exitCode}, error: ${result.error}`)
                }

                // Process the output to format with file URLs and content previews
                resolve(this.processRipgrepOutput(result.stdout))
            } catch (err) {
                reject(err)
            }
        })
    }

    /**
     * Process ripgrep output to:
     * 1. Group results by file
     * 2. Return structured match details for each file
     */
    private processRipgrepOutput(output: string): SanitizedRipgrepOutput {
        if (!output || output.trim() === '') {
            return {
                matchCount: 0,
                fileMatches: [],
            }
        }
        const lines = output.split('\n')
        // Group by file path
        const fileGroups: Record<string, { lineNumbers: string[]; content: string[] }> = {}
        let matchCount = 0
        for (const line of lines) {
            if (!line || line.trim() === '') {
                continue
            }
            // Extract file path, line number, and content
            const parts = line.split(':')
            if (parts.length < 3) {
                continue
            }
            const filePath = parts[0]
            const lineNumber = parts[1]
            const content = parts.slice(2).join(':').trim()
            if (!fileGroups[filePath]) {
                fileGroups[filePath] = { lineNumbers: [], content: [] }
            }
            fileGroups[filePath].lineNumbers.push(lineNumber)
            fileGroups[filePath].content.push(content)
            matchCount++
        }
        // Sort files by match count (most matches first)
        const sortedFiles = Object.entries(fileGroups).sort((a, b) => b[1].lineNumbers.length - a[1].lineNumbers.length)
        // Create structured file matches
        const fileMatches = sortedFiles.map(([filePath, data]) => {
            const matches: Record<string, string>[] = []
            for (const [idx, lineNum] of data.lineNumbers.entries()) {
                matches.push({
                    lineNum,
                    content: data.content[idx],
                })
            }

            return {
                filePath,
                matches,
            }
        })

        return {
            matchCount,
            fileMatches,
        }
    }

    private createOutput(content: SanitizedRipgrepOutput): InvokeOutput {
        return {
            output: {
                kind: 'json',
                content: content,
            },
        }
    }

    public getSpec() {
        return {
            name: 'grepSearch',
            description:
                'A tool for searching text patterns across files.\n\n' +
                '## Overview\n' +
                'This tool searches for text content in files within a directory and its subdirectories.\n\n' +
                '## When to use\n' +
                '- When you need to find specific text patterns across multiple files\n' +
                '- When you need to locate code implementations, function definitions, or specific strings\n' +
                '- When you need to identify where certain features or components are used\n\n' +
                '## When not to use\n' +
                '- When you need to read the full content of specific files (use `fsRead` instead)\n' +
                '- When you need to search within binary files\n' +
                '- When you need to perform complex regex operations beyond simple text matching\n\n' +
                '## Notes\n' +
                '- Results include file paths, line numbers, and matching content\n' +
                '- Case sensitivity can be controlled with the caseSensitive parameter\n' +
                '- Include and exclude patterns can be specified to narrow down the search scope\n' +
                '- Results are limited to 20 matches per file to prevent overwhelming output\n' +
                '- This tool is more effective than running commands like `grep` or `find` using `executeBash` tool',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description:
                            'Absolute path to a directory to search in, e.g. `/repo` for Unix-like system including Unix/Linux/macOS or `d:\\repo` for Windows. If not provided, the current workspace folder will be used. Prefer searching over the whole repo to get a more comprehensive result.',
                    },
                    query: {
                        type: 'string',
                        description:
                            'The text pattern to search for in files. Can be a simple string or a regular expression pattern. Use the exact keyword from user prompts directly. If the keyword is in plural form, try to search for singular form for more matches.',
                    },
                    caseSensitive: {
                        type: 'boolean',
                        description: 'Whether the search should be case-sensitive. Defaults to false if not provided.',
                    },
                    includePattern: {
                        type: 'string',
                        description:
                            'Comma-separated glob patterns to include in the search, e.g., "*.js,*.ts,src/**/*.jsx". Only files matching these patterns will be searched.',
                    },
                    excludePattern: {
                        type: 'string',
                        description:
                            'Comma-separated glob patterns to exclude from the search, e.g., "*.min.js,*.d.ts,**/*.test.*". Files matching these patterns will be ignored.',
                    },
                },
                required: ['query'],
            },
        } as const
    }
}
