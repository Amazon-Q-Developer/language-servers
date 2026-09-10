import { ToolResultContentBlock, ToolUse } from '@amzn/codewhisperer-streaming'
import { ChatResult, Status } from '@aws/language-server-runtimes/server-interface'
import { BUTTON_ALLOW_TOOLS, BUTTON_REJECT_MCP_TOOL } from '../constants/toolConstants'

interface WebSearchInput {
    query: string
}

interface SearchResultItem {
    title: string
    url: string
    snippet: string
    publishedDate: number | null
    id: string
    domain: string
    maxVerbatimWordLimit: number
    publicDomain: boolean
}

interface SearchData {
    results: SearchResultItem[]
    totalResults: number
    query: string
    error: string | null
}

interface WebSearchResult {
    content: ToolResultContentBlock[]
    isError: boolean
}

function isWebSearchInput(input: unknown): input is WebSearchInput {
    return typeof input === 'object' && input != null && 'query' in input
}

const MARKDOWN_ESCAPES: Record<string, string> = {
    '[': '&#91;',
    ']': '&#93;',
    '(': '&#40;',
    ')': '&#41;',
}

function escapeMarkdown(text: string): string {
    return text.replace(/[\[\]()]/g, m => MARKDOWN_ESCAPES[m])
}

function isValidUrl(url: string): boolean {
    try {
        new URL(url)
        return true
    } catch {
        return false
    }
}

export class WebSearch {
    static getToolConfirmationMessage(toolUse: ToolUse): ChatResult {
        if (!isWebSearchInput(toolUse.input)) {
            throw new Error('Invalid web search input: missing query parameter')
        }

        return {
            type: 'tool',
            messageId: toolUse.toolUseId,
            summary: {
                content: {
                    header: {
                        icon: 'globe',
                        body: `Web search: ${toolUse.input.query}`,
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
        if (!isWebSearchInput(toolUse.input)) {
            throw new Error('Invalid web search input: missing query parameter')
        }

        return {
            type: 'tool',
            messageId: toolUse.toolUseId,
            summary: {
                content: {
                    header: {
                        icon: 'globe',
                        body: `Web search: ${toolUse.input.query}`,
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

    static getToolResultMessage(toolUse: ToolUse, result: WebSearchResult): ChatResult {
        if (!isWebSearchInput(toolUse.input)) {
            throw new Error('Invalid web search input: missing query parameter')
        }

        if (result.isError) {
            throw new Error('Web search failed')
        }

        // Parse search results
        let searchResults: SearchResultItem[] = []
        let totalResults = 0
        try {
            const firstContent = result.content[0]
            const searchData: SearchData =
                'text' in firstContent && firstContent.text ? JSON.parse(firstContent.text) : firstContent.json

            if (searchData.error) {
                throw new Error(`Web search API error: ${searchData.error}`)
            }

            searchResults = searchData.results || []
            totalResults = searchData.totalResults || searchResults.length
        } catch (error) {
            throw new Error(`Error parsing web search results: ${error}`)
        }

        // Create collapsed content for each search result with valid URLs
        const collapsedContent = searchResults
            .filter(result => isValidUrl(result.url))
            .map(result => {
                const date = result.publishedDate
                    ? new Date(result.publishedDate).toLocaleDateString('en-US', {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                      })
                    : ''
                // Escape square brackets and parentheses in title and URL for markdown
                const escapedTitle = escapeMarkdown(result.title)
                const escapedUrl = escapeMarkdown(result.url)
                return {
                    body: `**${result.domain}**${date ? ` - ${date}` : ''}\n\n[${escapedTitle}](${escapedUrl})`,
                }
            })

        return {
            type: 'tool',
            messageId: toolUse.toolUseId,
            summary: {
                content: {
                    header: {
                        icon: 'globe',
                        body: `Web search: ${toolUse.input.query}`,
                        status: {
                            text: `${totalResults} ${totalResults === 1 ? 'result' : 'results'}`,
                        },
                    },
                },
                collapsedContent,
            },
        }
    }
}
