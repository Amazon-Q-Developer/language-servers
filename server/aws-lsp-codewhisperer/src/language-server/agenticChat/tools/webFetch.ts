import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { InvokeOutput } from './toolShared'
import * as https from 'https'
import * as http from 'http'
import { URL } from 'url'
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { ChatResult, InitializeParams, Status } from '@aws/language-server-runtimes/server-interface'
import { ToolUse } from '@amzn/codewhisperer-streaming'
import { BUTTON_ALLOW_TOOLS, BUTTON_REJECT_MCP_TOOL, WEB_FETCH } from '../constants/toolConstants'
import { getUserAgent } from '../../../shared/telemetryUtils'

// WebFetch Configuration Constants
const MAX_REDIRECT_COUNT = 10
const MAX_RETRY_ATTEMPTS = 3
const MAX_CONTENT_SIZE_MB = 10
const MAX_CONTENT_SIZE_BYTES = MAX_CONTENT_SIZE_MB * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30000
const TRUNCATED_CONTENT_LENGTH = 8000
const SELECTIVE_CONTEXT_LINES = 10
const RETRY_DELAY_BASE_MS = 1000

class TooManyRedirectsError extends Error {
    constructor() {
        super('Too many redirects')
        this.name = 'TooManyRedirectsError'
    }
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function extractSelectiveContent(
    content: string,
    searchTerms: string,
    contextLines = SELECTIVE_CONTEXT_LINES,
    truncateLength = TRUNCATED_CONTENT_LENGTH
): string {
    // Split by newlines (each line is a paragraph/heading/list item from Readability)
    const chunks = content.split('\n').filter(s => s.trim().length > 0)
    const terms = searchTerms
        .toLowerCase()
        .split(/\s+/)
        .filter(t => t.length > 0)
    const matchedSections: string[] = []
    const seenIndices = new Set<number>()

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i].toLowerCase()
        if (terms.some(term => chunk.includes(term)) && !seenIndices.has(i)) {
            const start = Math.max(0, i - contextLines)
            const end = Math.min(chunks.length, i + contextLines + 1)

            for (let j = start; j < end; j++) {
                seenIndices.add(j)
            }

            matchedSections.push(chunks.slice(start, end).join(' '))
        }
    }

    return matchedSections.length > 0 ? matchedSections.join('\n\n---\n\n') : content.substring(0, truncateLength)
}

export interface WebFetchParams {
    url: string
    mode?: 'selective' | 'truncated' | 'full' | string
    searchTerms?: string
}

export interface WebFetchResult {
    content: string
    url: string
    statusCode: number
    bytesDownloaded?: number
}

export class WebFetch {
    private readonly logging: Features['logging']
    private readonly lsp: Features['lsp']
    private readonly runtime: Features['runtime']

    constructor(features: Pick<Features, 'logging' | 'lsp' | 'runtime'>) {
        this.logging = features.logging
        this.lsp = features.lsp
        this.runtime = features.runtime
    }

    public async validate(params: WebFetchParams): Promise<void> {
        if (!params.url) {
            throw new Error('URL is required')
        }

        try {
            new URL(params.url)
        } catch {
            throw new Error('Invalid URL format')
        }
    }

    public async invoke(params: WebFetchParams): Promise<InvokeOutput> {
        this.logging.info(`WebFetch: Fetching ${params.url}`)

        const result = await this.fetchUrl(params.url, 0, params.mode || 'selective', params.searchTerms)

        return {
            output: {
                kind: 'json',
                content: result,
            },
        }
    }

    private async fetchUrl(
        url: string,
        redirectCount = 0,
        mode: string = 'selective',
        searchTerms?: string
    ): Promise<WebFetchResult> {
        for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
            try {
                return await this.performFetch(url, redirectCount, mode, searchTerms)
            } catch (error) {
                // Don't retry non-transient errors
                if (error instanceof TooManyRedirectsError) {
                    throw error
                }
                if (attempt === MAX_RETRY_ATTEMPTS - 1) throw error
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_BASE_MS * (attempt + 1)))
            }
        }
        throw new Error('Max retries exceeded')
    }

    private extractReadableContent(html: string, url: string, mode: string, searchTerms?: string): string {
        const dom = new JSDOM(html, { url })
        const reader = new Readability(dom.window.document)
        const article = reader.parse()

        if (!article || !article.content) {
            return html.substring(0, TRUNCATED_CONTENT_LENGTH)
        }

        // Parse article.content (cleaned HTML) to preserve paragraph structure
        const contentDom = new JSDOM(article.content)
        const lines: string[] = []

        // Extract text from paragraphs, headings, and list items
        contentDom.window.document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li').forEach(el => {
            const text = el.textContent?.trim()
            if (text) {
                lines.push(text)
            }
        })

        const normalizedText = lines.join('\n').trim()

        if (mode === 'full') {
            return normalizedText
        } else if (mode === 'truncated') {
            return normalizedText.substring(0, TRUNCATED_CONTENT_LENGTH)
        } else if (mode === 'selective' && searchTerms) {
            const result = extractSelectiveContent(normalizedText, searchTerms)
            return result
        } else {
            return normalizedText.substring(0, TRUNCATED_CONTENT_LENGTH)
        }
    }

    private async performFetch(
        url: string,
        redirectCount: number,
        mode: string,
        searchTerms?: string
    ): Promise<WebFetchResult> {
        if (redirectCount > MAX_REDIRECT_COUNT) {
            throw new TooManyRedirectsError()
        }

        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(url)
            const client = parsedUrl.protocol === 'https:' ? https : http
            const userAgent = getUserAgent(
                this.lsp.getClientInitializeParams() as InitializeParams,
                this.runtime.serverInfo
            )

            const options = {
                headers: {
                    'User-Agent': userAgent,
                    Accept: 'text/html',
                },
            }

            const req = client.get(url, options, res => {
                const contentType = res.headers['content-type'] || ''
                if (!contentType.includes('text/html')) {
                    reject(new Error('Only HTML content is supported'))
                    return
                }

                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    resolve(this.fetchUrl(res.headers.location, redirectCount + 1, mode, searchTerms))
                    return
                }

                let data = ''
                let size = 0

                res.on('data', chunk => {
                    size += chunk.length
                    if (size > MAX_CONTENT_SIZE_BYTES) {
                        req.destroy()
                        reject(new Error(`Content exceeds ${MAX_CONTENT_SIZE_MB}MB limit`))
                        return
                    }
                    data += chunk
                })

                res.on('end', () => {
                    const readableContent = this.extractReadableContent(data, url, mode, searchTerms)
                    resolve({
                        content: readableContent,
                        url,
                        statusCode: res.statusCode || 0,
                        bytesDownloaded: size,
                    })
                })
            })

            req.on('error', reject)
            req.setTimeout(REQUEST_TIMEOUT_MS, () => {
                req.destroy()
                reject(new Error(`Request timeout after ${REQUEST_TIMEOUT_MS / 1000} seconds`))
            })
        })
    }

    public getSpec() {
        return {
            name: WEB_FETCH,
            description: `Fetch and extract content from a specific URL. Supports three modes: 'selective' (default, extracts relevant sections around search terms), 'truncated' (first ${TRUNCATED_CONTENT_LENGTH} chars), 'full' (complete content). Use 'selective' mode to read specific parts of a page multiple times without filling context. Provide 'searchTerms' in selective mode to find relevant sections (e.g., 'pricing', 'installation').`,
            inputSchema: {
                type: 'object' as const,
                properties: {
                    url: {
                        type: 'string' as const,
                        description: 'URL to fetch content from',
                    },
                    mode: {
                        type: 'string' as const,
                        enum: ['selective', 'truncated', 'full'],
                        description: `Extraction mode: 'selective' for smart extraction (default), 'truncated' for first ${TRUNCATED_CONTENT_LENGTH} chars, 'full' for complete content`,
                    },
                    searchTerms: {
                        type: 'string' as const,
                        description: `Optional: Keywords to find in selective mode (e.g., 'pricing cost', 'installation setup'). Returns ~${SELECTIVE_CONTEXT_LINES} lines before and after matches. If not provided, returns beginning of page.`,
                    },
                },
                required: ['url'],
            },
        }
    }

    static getToolConfirmationMessage(toolUse: ToolUse): ChatResult {
        return {
            type: 'tool',
            messageId: toolUse.toolUseId,
            summary: {
                content: {
                    header: {
                        icon: 'globe',
                        body: 'Web fetch',
                        buttons: [
                            { id: BUTTON_ALLOW_TOOLS, text: 'Run', icon: 'play', status: 'clear' },
                            {
                                id: BUTTON_REJECT_MCP_TOOL,
                                text: 'Reject',
                                icon: 'cancel',
                                status: 'dimmed-clear' as Status,
                            },
                        ],
                    },
                },
                collapsedContent: [
                    {
                        header: { body: 'Parameters' },
                        body: '```json\n' + JSON.stringify(toolUse.input, null, 2) + '\n```',
                    },
                ],
            },
        }
    }

    static getToolConfirmationResultMessage(toolUse: ToolUse, isAccept: boolean): ChatResult {
        return {
            type: 'tool',
            messageId: toolUse.toolUseId,
            summary: {
                content: {
                    header: {
                        icon: 'globe',
                        body: 'Web fetch',
                        status: {
                            status: isAccept ? 'success' : 'error',
                            icon: isAccept ? 'ok' : 'cancel',
                            text: isAccept ? 'Allowed' : 'Rejected',
                        },
                        fileList: undefined,
                    },
                },
                collapsedContent: [
                    {
                        header: { body: 'Parameters' },
                        body: '```json\n' + JSON.stringify(toolUse.input, null, 2) + '\n```',
                    },
                ],
            },
        }
    }

    static getToolResultMessage(toolUse: ToolUse, result: any): ChatResult {
        const byteCount = result?.output?.content?.bytesDownloaded || 0

        return {
            type: 'tool',
            messageId: toolUse.toolUseId,
            summary: {
                content: {
                    header: {
                        icon: 'globe',
                        body: 'Web fetch',
                        status: byteCount > 0 ? { text: `Fetched ${formatBytes(byteCount)}` } : undefined,
                    },
                },
                collapsedContent: [
                    {
                        header: { body: 'Parameters' },
                        body: '```json\n' + JSON.stringify(toolUse.input, null, 2) + '\n```',
                    },
                    {
                        header: { body: 'Result' },
                        body: '```json\n' + JSON.stringify(result, null, 2) + '\n```',
                    },
                ],
            },
        }
    }
}
