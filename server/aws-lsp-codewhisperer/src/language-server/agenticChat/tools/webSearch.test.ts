import * as assert from 'assert'
import { WebSearch } from './webSearch'
import { ToolUse } from '@amzn/codewhisperer-streaming'

describe('WebSearch Tool', () => {
    const createToolUse = (query: string, toolUseId = 'test-tool-id'): ToolUse => ({
        toolUseId,
        name: 'web_search',
        input: { query },
    })

    const createInvalidToolUse = (input: any, toolUseId = 'test-tool-id'): ToolUse => ({
        toolUseId,
        name: 'web_search',
        input,
    })

    describe('getToolConfirmationMessage', () => {
        it('returns confirmation message with query', () => {
            const toolUse = createToolUse('test query')
            const result = WebSearch.getToolConfirmationMessage(toolUse)

            assert.strictEqual(result.type, 'tool')
            assert.strictEqual(result.messageId, 'test-tool-id')
            assert.strictEqual(result.summary?.content?.header?.icon, 'globe')
            assert.strictEqual(result.summary?.content?.header?.body, 'Web search: test query')
            assert.strictEqual(result.summary?.content?.header?.buttons?.length, 2)
        })

        it('throws error for missing query', () => {
            const toolUse = createInvalidToolUse({})
            assert.throws(
                () => WebSearch.getToolConfirmationMessage(toolUse),
                /Invalid web search input: missing query parameter/
            )
        })

        it('throws error for null input', () => {
            const toolUse = createInvalidToolUse(null)
            assert.throws(
                () => WebSearch.getToolConfirmationMessage(toolUse),
                /Invalid web search input: missing query parameter/
            )
        })
    })

    describe('getToolConfirmationResultMessage', () => {
        it('returns success message when accepted', () => {
            const toolUse = createToolUse('test query')
            const result = WebSearch.getToolConfirmationResultMessage(toolUse, true)

            assert.strictEqual(result.type, 'tool')
            assert.strictEqual(result.messageId, 'test-tool-id')
            assert.strictEqual(result.summary?.content?.header?.status?.status, 'success')
            assert.strictEqual(result.summary?.content?.header?.status?.text, 'Allowed')
        })

        it('returns error message when rejected', () => {
            const toolUse = createToolUse('test query')
            const result = WebSearch.getToolConfirmationResultMessage(toolUse, false)

            assert.strictEqual(result.type, 'tool')
            assert.strictEqual(result.summary?.content?.header?.status?.status, 'error')
            assert.strictEqual(result.summary?.content?.header?.status?.text, 'Rejected')
        })

        it('throws error for invalid input', () => {
            const toolUse = createInvalidToolUse({})
            assert.throws(
                () => WebSearch.getToolConfirmationResultMessage(toolUse, true),
                /Invalid web search input: missing query parameter/
            )
        })
    })

    describe('getToolResultMessage', () => {
        it('formats search results with text content', () => {
            const toolUse = createToolUse('test query')
            const result = {
                content: [
                    {
                        text: JSON.stringify({
                            results: [
                                {
                                    title: 'Test Result',
                                    url: 'https://example.com',
                                    snippet: 'Test snippet',
                                    publishedDate: 1704067200000,
                                    id: '1',
                                    domain: 'example.com',
                                    maxVerbatimWordLimit: 100,
                                    publicDomain: true,
                                },
                            ],
                            totalResults: 1,
                            query: 'test query',
                            error: null,
                        }),
                    },
                ],
                isError: false,
            }

            const chatResult = WebSearch.getToolResultMessage(toolUse, result)

            assert.strictEqual(chatResult.type, 'tool')
            assert.strictEqual(chatResult.summary?.content?.header?.status?.text, '1 result')
            assert.strictEqual(chatResult.summary?.collapsedContent?.length, 1)
            assert.ok(chatResult.summary?.collapsedContent?.[0].body?.includes('example.com'))
            assert.ok(chatResult.summary?.collapsedContent?.[0].body?.includes('Test Result'))
        })

        it('formats search results with json content', () => {
            const toolUse = createToolUse('test query')
            const result = {
                content: [
                    {
                        json: {
                            results: [
                                {
                                    title: 'Test Result',
                                    url: 'https://example.com',
                                    snippet: 'Test snippet',
                                    publishedDate: null,
                                    id: '1',
                                    domain: 'example.com',
                                    maxVerbatimWordLimit: 100,
                                    publicDomain: true,
                                },
                            ],
                            totalResults: 1,
                            query: 'test query',
                            error: null,
                        },
                    },
                ],
                isError: false,
            }

            const chatResult = WebSearch.getToolResultMessage(toolUse, result)

            assert.strictEqual(chatResult.type, 'tool')
            assert.strictEqual(chatResult.summary?.collapsedContent?.length, 1)
        })

        it('handles multiple results', () => {
            const toolUse = createToolUse('test query')
            const result = {
                content: [
                    {
                        text: JSON.stringify({
                            results: [
                                {
                                    title: 'Result 1',
                                    url: 'https://example1.com',
                                    snippet: 'Snippet 1',
                                    publishedDate: 1704067200000,
                                    id: '1',
                                    domain: 'example1.com',
                                    maxVerbatimWordLimit: 100,
                                    publicDomain: true,
                                },
                                {
                                    title: 'Result 2',
                                    url: 'https://example2.com',
                                    snippet: 'Snippet 2',
                                    publishedDate: null,
                                    id: '2',
                                    domain: 'example2.com',
                                    maxVerbatimWordLimit: 100,
                                    publicDomain: true,
                                },
                            ],
                            totalResults: 2,
                            query: 'test query',
                            error: null,
                        }),
                    },
                ],
                isError: false,
            }

            const chatResult = WebSearch.getToolResultMessage(toolUse, result)

            assert.strictEqual(chatResult.summary?.content?.header?.status?.text, '2 results')
            assert.strictEqual(chatResult.summary?.collapsedContent?.length, 2)
        })

        it('escapes square brackets in titles', () => {
            const toolUse = createToolUse('test query')
            const result = {
                content: [
                    {
                        text: JSON.stringify({
                            results: [
                                {
                                    title: 'Test [Result]',
                                    url: 'https://example.com',
                                    snippet: 'Test snippet',
                                    publishedDate: null,
                                    id: '1',
                                    domain: 'example.com',
                                    maxVerbatimWordLimit: 100,
                                    publicDomain: true,
                                },
                            ],
                            totalResults: 1,
                            query: 'test query',
                            error: null,
                        }),
                    },
                ],
                isError: false,
            }

            const chatResult = WebSearch.getToolResultMessage(toolUse, result)

            assert.ok(chatResult.summary?.collapsedContent?.[0].body?.includes('&#91;Result&#93;'))
        })

        it('throws error when isError is true', () => {
            const toolUse = createToolUse('test query')
            const result = {
                content: [],
                isError: true,
            }

            assert.throws(() => WebSearch.getToolResultMessage(toolUse, result), /Web search failed/)
        })

        it('throws error when API returns error', () => {
            const toolUse = createToolUse('test query')
            const result = {
                content: [
                    {
                        text: JSON.stringify({
                            results: [],
                            totalResults: 0,
                            query: 'test query',
                            error: 'Rate limit exceeded',
                        }),
                    },
                ],
                isError: false,
            }

            assert.throws(
                () => WebSearch.getToolResultMessage(toolUse, result),
                /Web search API error: Rate limit exceeded/
            )
        })

        it('throws error for invalid JSON', () => {
            const toolUse = createToolUse('test query')
            const result = {
                content: [{ text: 'invalid json' }],
                isError: false,
            }

            assert.throws(() => WebSearch.getToolResultMessage(toolUse, result), /Error parsing web search results/)
        })

        it('throws error for invalid input', () => {
            const toolUse = createInvalidToolUse({})
            const result = {
                content: [],
                isError: false,
            }

            assert.throws(
                () => WebSearch.getToolResultMessage(toolUse, result),
                /Invalid web search input: missing query parameter/
            )
        })

        it('handles empty results', () => {
            const toolUse = createToolUse('test query')
            const result = {
                content: [
                    {
                        text: JSON.stringify({
                            results: [],
                            totalResults: 0,
                            query: 'test query',
                            error: null,
                        }),
                    },
                ],
                isError: false,
            }

            const chatResult = WebSearch.getToolResultMessage(toolUse, result)

            assert.strictEqual(chatResult.summary?.content?.header?.status?.text, '0 results')
            assert.strictEqual(chatResult.summary?.collapsedContent?.length, 0)
        })

        it('includes date when publishedDate is provided', () => {
            const toolUse = createToolUse('test query')
            const result = {
                content: [
                    {
                        text: JSON.stringify({
                            results: [
                                {
                                    title: 'Test Result',
                                    url: 'https://example.com',
                                    snippet: 'Test snippet',
                                    publishedDate: 1704067200000,
                                    id: '1',
                                    domain: 'example.com',
                                    maxVerbatimWordLimit: 100,
                                    publicDomain: true,
                                },
                            ],
                            totalResults: 1,
                            query: 'test query',
                            error: null,
                        }),
                    },
                ],
                isError: false,
            }

            const chatResult = WebSearch.getToolResultMessage(toolUse, result)
            const body = chatResult.summary?.collapsedContent?.[0].body

            assert.ok(body?.includes('example.com'))
            assert.ok(
                body?.includes('Dec 31, 2023') || body?.includes('Jan 1, 2024'),
                'Should include date (Dec 31, 2023 or Jan 1, 2024 depending on timezone)'
            )
        })

        it('omits date when publishedDate is null', () => {
            const toolUse = createToolUse('test query')
            const result = {
                content: [
                    {
                        text: JSON.stringify({
                            results: [
                                {
                                    title: 'Test Result',
                                    url: 'https://example.com',
                                    snippet: 'Test snippet',
                                    publishedDate: null,
                                    id: '1',
                                    domain: 'example.com',
                                    maxVerbatimWordLimit: 100,
                                    publicDomain: true,
                                },
                            ],
                            totalResults: 1,
                            query: 'test query',
                            error: null,
                        }),
                    },
                ],
                isError: false,
            }

            const chatResult = WebSearch.getToolResultMessage(toolUse, result)
            const body = chatResult.summary?.collapsedContent?.[0].body

            assert.ok(body?.includes('example.com'))
            assert.ok(!body?.includes(' - '), 'Should not include date separator when no date')
        })

        it('escapes parentheses and brackets in URLs', () => {
            const toolUse = createToolUse('test query')
            const result = {
                content: [
                    {
                        text: JSON.stringify({
                            results: [
                                {
                                    title: 'Test (Article)',
                                    url: 'https://example.com/wiki/Test_(Article)[1]',
                                    snippet: 'Test article description',
                                    publishedDate: null,
                                    id: '1',
                                    domain: 'example.com',
                                    maxVerbatimWordLimit: -1,
                                    publicDomain: false,
                                },
                            ],
                            totalResults: 1,
                            query: 'test query',
                            error: null,
                        }),
                    },
                ],
                isError: false,
            }

            const chatResult = WebSearch.getToolResultMessage(toolUse, result)
            const body = chatResult.summary?.collapsedContent?.[0].body

            assert.ok(
                body?.includes('[Test &#40;Article&#41;](https://example.com/wiki/Test_&#40;Article&#41;&#91;1&#93;)'),
                'Should produce correctly escaped markdown link'
            )
        })

        it('filters out invalid URLs from search results', () => {
            const toolUse = createToolUse('test query')
            const result = {
                content: [
                    {
                        text: JSON.stringify({
                            results: [
                                {
                                    title: 'Valid Result',
                                    url: 'https://example.com',
                                    snippet: 'Valid snippet',
                                    publishedDate: null,
                                    id: '1',
                                    domain: 'example.com',
                                    maxVerbatimWordLimit: 100,
                                    publicDomain: true,
                                },
                                {
                                    title: 'Invalid Result',
                                    url: 'not-a-valid-url',
                                    snippet: 'Invalid snippet',
                                    publishedDate: null,
                                    id: '2',
                                    domain: 'invalid.com',
                                    maxVerbatimWordLimit: 100,
                                    publicDomain: true,
                                },
                            ],
                            totalResults: 2,
                            query: 'test query',
                            error: null,
                        }),
                    },
                ],
                isError: false,
            }

            const chatResult = WebSearch.getToolResultMessage(toolUse, result)

            assert.strictEqual(chatResult.summary?.collapsedContent?.length, 1)
            assert.ok(chatResult.summary?.collapsedContent?.[0].body?.includes('Valid Result'))
            assert.ok(chatResult.summary?.collapsedContent?.[0].body?.includes('https://example.com'))
        })

        it('handles all invalid URLs', () => {
            const toolUse = createToolUse('test query')
            const result = {
                content: [
                    {
                        text: JSON.stringify({
                            results: [
                                {
                                    title: 'Invalid Result 1',
                                    url: 'invalid-url-1',
                                    snippet: 'Snippet 1',
                                    publishedDate: null,
                                    id: '1',
                                    domain: 'test.com',
                                    maxVerbatimWordLimit: 100,
                                    publicDomain: true,
                                },
                                {
                                    title: 'Invalid Result 2',
                                    url: 'also-invalid',
                                    snippet: 'Snippet 2',
                                    publishedDate: null,
                                    id: '2',
                                    domain: 'test2.com',
                                    maxVerbatimWordLimit: 100,
                                    publicDomain: true,
                                },
                            ],
                            totalResults: 2,
                            query: 'test query',
                            error: null,
                        }),
                    },
                ],
                isError: false,
            }

            const chatResult = WebSearch.getToolResultMessage(toolUse, result)

            assert.strictEqual(chatResult.summary?.collapsedContent?.length, 0)
        })
    })
})
