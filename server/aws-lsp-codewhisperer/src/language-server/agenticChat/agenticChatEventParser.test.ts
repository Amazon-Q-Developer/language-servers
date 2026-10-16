/**
 * Copied from ../chat/chatEventParser.test.ts for the purpose of developing a divergent implementation.
 * Will be deleted or merged.
 */

import { ChatResult } from '@aws/language-server-runtimes/protocol'
import * as assert from 'assert'
import sinon from 'ts-sinon'

import { AgenticChatEventParser } from './agenticChatEventParser'
import { Metric } from '../../shared/telemetry/metric'
import { AddMessageEvent } from '../../shared/telemetry/types'
import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { TestFeatures } from '@aws/language-server-runtimes/testing'

describe('AgenticChatEventParser', () => {
    const mockMessageId = 'mock-message-id'
    let logging: Features['logging']

    before(function () {
        logging = new TestFeatures().logging
    })

    it('set error if invalidState event is received', () => {
        const chatEventParser = new AgenticChatEventParser(mockMessageId, new Metric<AddMessageEvent>(), logging)

        sinon.assert.match(
            chatEventParser.processPartialEvent({
                invalidStateEvent: {
                    message: 'Invalid state!',
                    reason: 'INVALID_TASK_ASSIST_PLAN',
                },
            }),
            {
                success: false,
                data: {
                    chatResult: {
                        messageId: mockMessageId,
                        body: '',
                        canBeVoted: true,
                        codeReference: undefined,
                        followUp: undefined,
                        relatedContent: undefined,
                        contextList: undefined,
                    },
                    conversationId: undefined,
                },
                error: sinon.match.string,
            }
        )
    })

    it('set error if error event is received', () => {
        const chatEventParser = new AgenticChatEventParser(mockMessageId, new Metric<AddMessageEvent>(), logging)

        sinon.assert.match(
            chatEventParser.processPartialEvent({
                error: {
                    name: 'InternalServerException',
                    message: 'Error!',
                    $fault: 'server',
                    $retryable: false,
                    $metadata: {},
                },
            }),
            {
                success: false,
                data: {
                    chatResult: {
                        messageId: mockMessageId,
                        body: '',
                        canBeVoted: true,
                        codeReference: undefined,
                        followUp: undefined,
                        relatedContent: undefined,
                    },
                    conversationId: undefined,
                },
                error: sinon.match.string,
            }
        )

        assert.strictEqual(chatEventParser.error, 'Error!')
    })

    it('processPartialEvent appends new event on top of the previous result', () => {
        const chatEventParser = new AgenticChatEventParser(mockMessageId, new Metric<AddMessageEvent>(), logging)

        assert.deepStrictEqual(
            chatEventParser.processPartialEvent({
                assistantResponseEvent: {
                    content: 'This is an ',
                },
            }),
            {
                success: true,
                data: {
                    chatResult: {
                        messageId: mockMessageId,
                        body: 'This is an ',
                        canBeVoted: true,
                        codeReference: undefined,
                        followUp: undefined,
                        relatedContent: undefined,
                    },
                    conversationId: undefined,
                    toolUses: {},
                },
            }
        )

        assert.deepStrictEqual(
            chatEventParser.processPartialEvent({
                assistantResponseEvent: {
                    content: 'assistant response.',
                },
            }),
            {
                success: true,
                data: {
                    chatResult: {
                        messageId: mockMessageId,
                        body: 'This is an assistant response.',
                        canBeVoted: true,
                        codeReference: undefined,
                        followUp: undefined,
                        relatedContent: undefined,
                    },
                    conversationId: undefined,
                    toolUses: {},
                },
            }
        )
    })

    it('processPartialEvent with messageMetadataEvent appends conversation id', () => {
        const chatEventParser = new AgenticChatEventParser(mockMessageId, new Metric<AddMessageEvent>(), logging)

        chatEventParser.processPartialEvent({
            messageMetadataEvent: {
                conversationId: 'id-2345',
            },
        })
        chatEventParser.processPartialEvent({
            assistantResponseEvent: {
                content: 'assistant response',
            },
        })

        assert.deepStrictEqual(chatEventParser.getResult(), {
            success: true,
            data: {
                chatResult: {
                    messageId: mockMessageId,
                    body: 'assistant response',
                    canBeVoted: true,
                    codeReference: undefined,
                    followUp: undefined,
                    relatedContent: undefined,
                },
                conversationId: 'id-2345',
                toolUses: {},
            },
        })
    })

    it('ensures body is an empty string instead of undefined when adding to history', () => {
        const chatEventParser = new AgenticChatEventParser(mockMessageId, new Metric<AddMessageEvent>(), logging)

        // Only add messageMetadataEvent but no assistantResponseEvent
        chatEventParser.processPartialEvent({
            messageMetadataEvent: {
                conversationId: 'id-2345',
            },
        })

        // Get the result - body should be an empty string, not undefined
        const result = chatEventParser.getResult()

        assert.strictEqual(result.data?.chatResult.body, '')
    })

    it('getResult returns the accumulated result', () => {
        const chatEventParser = new AgenticChatEventParser(mockMessageId, new Metric<AddMessageEvent>(), logging)

        chatEventParser.processPartialEvent({
            assistantResponseEvent: {
                content: 'This is an ',
            },
        })

        chatEventParser.processPartialEvent({
            followupPromptEvent: {
                followupPrompt: {
                    content: 'follow up 1',
                },
            },
        })

        assert.deepStrictEqual(chatEventParser.getResult(), {
            success: true,
            data: {
                chatResult: {
                    messageId: mockMessageId,
                    body: 'This is an ',
                    canBeVoted: true,
                    codeReference: undefined,
                    followUp: {
                        text: AgenticChatEventParser.FOLLOW_UP_TEXT,
                        options: [
                            {
                                pillText: 'follow up 1',
                                prompt: 'follow up 1',
                            },
                        ],
                    },
                    relatedContent: undefined,
                },
                conversationId: undefined,
                toolUses: {},
            },
        })

        chatEventParser.processPartialEvent({
            followupPromptEvent: {
                followupPrompt: {
                    content: 'follow up 2',
                },
            },
        })

        chatEventParser.processPartialEvent({
            codeReferenceEvent: {
                references: [
                    {
                        licenseName: 'MIT',
                        repository: 'langauge-servers',
                    },
                ],
            },
        })

        chatEventParser.processPartialEvent({
            assistantResponseEvent: {
                content: 'assistant response.',
            },
        })
        chatEventParser.processPartialEvent({
            supplementaryWebLinksEvent: {
                supplementaryWebLinks: [
                    {
                        title: 'weblink1',
                        snippet: 'snippet1',
                        url: 'https://link1.com',
                    },
                ],
            },
        })

        const expectedResult: ChatResult = {
            messageId: mockMessageId,
            body: 'This is an assistant response.',
            canBeVoted: true,
            relatedContent: {
                content: [
                    {
                        title: 'weblink1',
                        body: 'snippet1',
                        url: 'https://link1.com',
                    },
                ],
            },
            codeReference: [
                {
                    licenseName: 'MIT',
                    repository: 'langauge-servers',
                    recommendationContentSpan: undefined,
                    information: AgenticChatEventParser.getReferencedInformation({
                        licenseName: 'MIT',
                        repository: 'langauge-servers',
                    }),
                },
            ],
            followUp: {
                text: AgenticChatEventParser.FOLLOW_UP_TEXT,
                options: [
                    {
                        pillText: 'follow up 1',
                        prompt: 'follow up 1',
                    },
                    {
                        pillText: 'follow up 2',
                        prompt: 'follow up 2',
                    },
                ],
            },
        }

        const expectedData = {
            chatResult: expectedResult,
            conversationId: undefined,
            toolUses: {},
        }

        assert.deepStrictEqual(chatEventParser.getResult(), { success: true, data: expectedData })
    })

    it('finalize flags an unterminated tool use (no stop event) as incomplete and marks it stopped', () => {
        const chatEventParser = new AgenticChatEventParser(mockMessageId, new Metric<AddMessageEvent>(), logging)

        // A tool use whose input streams in fragments but never receives a `stop` event
        // (e.g. the response hit the output-token limit mid tool-input).
        chatEventParser.processPartialEvent({
            toolUseEvent: {
                toolUseId: 'tool-1',
                name: 'fsWrite',
                input: '{"path":"out.py","fileText":"import os',
                stop: false,
            },
        })
        const midStream = chatEventParser.processPartialEvent({
            toolUseEvent: {
                toolUseId: 'tool-1',
                name: 'fsWrite',
                input: '\\nprint(1)',
                stop: false,
            },
        })

        // Mid-stream this looks like a clean success and would be filtered out (dropped) by the loop.
        assert.strictEqual(midStream.success, true)
        assert.strictEqual(midStream.data?.toolUses['tool-1'].stop, false)

        // After the stream ends, finalize() surfaces it as an error and marks it stopped so it
        // survives the pending-tool-use filter and is routed into the existing retry path.
        const result = chatEventParser.finalize()
        assert.strictEqual(result.success, false)
        assert.ok(result.error?.startsWith('ToolUse input is invalid JSON:'))
        assert.strictEqual(result.data?.toolUses['tool-1'].stop, true)
    })

    it('finalize leaves a properly stopped tool use untouched', () => {
        const chatEventParser = new AgenticChatEventParser(mockMessageId, new Metric<AddMessageEvent>(), logging)

        chatEventParser.processPartialEvent({
            toolUseEvent: {
                toolUseId: 'tool-1',
                name: 'fsWrite',
                input: '{"path":"out.py","fileText":"print(1)"}',
                stop: true,
            },
        })

        const result = chatEventParser.finalize()
        assert.strictEqual(result.success, true)
        assert.strictEqual(result.data?.toolUses['tool-1'].stop, true)
        assert.deepStrictEqual(result.data?.toolUses['tool-1'].input, { path: 'out.py', fileText: 'print(1)' })
    })

    it('finalize does not flag an unterminated tool use when no input was received', () => {
        const chatEventParser = new AgenticChatEventParser(mockMessageId, new Metric<AddMessageEvent>(), logging)

        // The model announced a tool use but never streamed any input before the stream ended.
        // There is nothing to truncate, so this must be dropped rather than retried.
        chatEventParser.processPartialEvent({
            toolUseEvent: {
                toolUseId: 'tool-1',
                name: 'fsWrite',
                input: '',
                stop: false,
            },
        })

        const result = chatEventParser.finalize()
        assert.strictEqual(result.success, true)
        assert.strictEqual(result.data?.toolUses['tool-1'].stop, false)
    })

    it('finalize does not flag an unterminated tool use when the request was aborted', () => {
        const chatEventParser = new AgenticChatEventParser(mockMessageId, new Metric<AddMessageEvent>(), logging)

        chatEventParser.processPartialEvent({
            toolUseEvent: {
                toolUseId: 'tool-1',
                name: 'fsWrite',
                input: '{"path":"out.py","fileText":"import os',
                stop: false,
            },
        })

        // An aborted request (response-processing timeout or cancellation) is expected to end
        // without a stop event, so it must not be reported as a truncated tool input.
        const result = chatEventParser.finalize({ aborted: true })
        assert.strictEqual(result.success, true)
        assert.strictEqual(result.data?.toolUses['tool-1'].stop, false)
    })
})
