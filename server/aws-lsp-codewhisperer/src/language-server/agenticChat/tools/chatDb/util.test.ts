/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import sinon from 'ts-sinon'
import * as path from 'path'
import {
    FileSystemAdapter,
    Message,
    Tab,
    TabType,
    chatMessageToMessage,
    getOldestMessageTimestamp,
    groupTabsByDate,
    initializeHistoryPriorityQueue,
    messageToChatMessage,
    messageToStreamingMessage,
    updateOrCreateConversation,
    estimateCharacterCountFromImageBlock,
    toolUseToToolChatMessage,
} from './util'
import { ChatMessage } from '@aws/language-server-runtimes/protocol'
import { Workspace } from '@aws/language-server-runtimes/server-interface'
import { ChatMessage as StreamingMessage } from '@amzn/codewhisperer-streaming'
import { describe, it } from 'mocha'
import { ImageBlock } from '@amzn/codewhisperer-streaming'

describe('ChatDb Utilities', () => {
    describe('messageToStreamingMessage', () => {
        it('should convert prompt message to userInputMessage', () => {
            const message: Message = {
                body: 'Hello',
                type: 'prompt',
            }

            const result = messageToStreamingMessage(message)

            assert.deepStrictEqual(result, {
                userInputMessage: {
                    content: 'Hello',
                    images: [],
                    userInputMessageContext: undefined,
                    userIntent: undefined,
                    origin: 'IDE',
                },
            })
        })

        it('should preserve userInputMessageContext when provided', () => {
            const message: Message = {
                body: 'Hello',
                type: 'prompt',
                userInputMessageContext: {
                    editorState: { document: { relativeFilePath: 'test.ts' } },
                },
            }

            const result = messageToStreamingMessage(message)

            assert.deepStrictEqual(result, {
                userInputMessage: {
                    content: 'Hello',
                    images: [],
                    userInputMessageContext: {
                        editorState: { document: { relativeFilePath: 'test.ts' } },
                    },
                    userIntent: undefined,
                    origin: 'IDE',
                },
            })
        })

        it('should convert answer message to assistantResponseMessage', () => {
            const message: Message = {
                body: 'Response',
                type: 'answer',
                messageId: 'msg-1',
                codeReference: [{ url: 'test.js', recommendationContentSpan: { start: 10, end: 15 }, information: '' }],
            }

            const result = messageToStreamingMessage(message)

            assert.deepStrictEqual(result, {
                assistantResponseMessage: {
                    messageId: 'msg-1',
                    content: 'Response',
                    toolUses: [],
                },
            })
        })
    })

    describe('messageToChatMessage', () => {
        it('should convert Message to ChatMessage', () => {
            const message: Message = {
                body: 'Hello',
                type: 'prompt',
                codeReference: [{ url: 'test.js', recommendationContentSpan: { start: 10, end: 15 }, information: '' }],
                relatedContent: { content: [{ title: 'Sources', url: 'google.com' }] },
            }

            const result = messageToChatMessage(message)

            assert.deepStrictEqual(result, [
                {
                    body: 'Hello',
                    type: 'prompt',
                    codeReference: [
                        { url: 'test.js', recommendationContentSpan: { start: 10, end: 15 }, information: '' },
                    ],
                    relatedContent: { content: [{ title: 'Sources', url: 'google.com' }] },
                },
            ])
        })

        it('should omit relatedContent when content array is empty', () => {
            const message: Message = {
                body: 'Hello',
                type: 'prompt',
                relatedContent: { content: [] },
            }

            const result = messageToChatMessage(message)

            assert.deepStrictEqual(result, [
                {
                    body: 'Hello',
                    type: 'prompt',
                    relatedContent: undefined,
                    codeReference: undefined,
                },
            ])
        })
    })

    describe('chatMessageToMessage', () => {
        it('should convert userInputMessage to prompt Message', () => {
            const chatMessage: StreamingMessage = {
                userInputMessage: {
                    content: 'Hello',
                    userInputMessageContext: {
                        toolResults: [],
                    },
                },
            }

            const result = chatMessageToMessage(chatMessage)

            assert.deepStrictEqual(result, {
                body: 'Hello',
                origin: 'IDE',
                type: 'prompt',
                userInputMessageContext: {
                    toolResults: [],
                },
                userIntent: undefined,
            })
        })

        it('should handle undefined userInputMessageContext', () => {
            const chatMessage: StreamingMessage = {
                userInputMessage: {
                    content: 'Hello',
                },
            }

            const result = chatMessageToMessage(chatMessage)

            assert.deepStrictEqual(result, {
                body: 'Hello',
                origin: 'IDE',
                type: 'prompt',
                userInputMessageContext: undefined,
                userIntent: undefined,
            })
        })

        it('should convert assistantResponseMessage to answer Message', () => {
            const chatMessage: StreamingMessage = {
                assistantResponseMessage: {
                    messageId: 'msg-123',
                    content: 'Response content',
                    toolUses: [
                        {
                            toolUseId: 'tool-1',
                            name: 'testTool',
                            input: { key: 'value' },
                        },
                    ],
                },
            }

            const result = chatMessageToMessage(chatMessage)

            assert.deepStrictEqual(result, {
                body: 'Response content',
                type: 'answer',
                messageId: 'msg-123',
                toolUses: [
                    {
                        toolUseId: 'tool-1',
                        name: 'testTool',
                        input: { key: 'value' },
                    },
                ],
            })
        })
    })

    describe('updateOrCreateConversation', () => {
        it('should add message to existing conversation', () => {
            const conversations = [
                {
                    conversationId: 'conv-1',
                    clientType: 'vscode',
                    messages: [{ body: 'Message 1', type: 'prompt' as ChatMessage['type'] }],
                },
            ]

            const newMessage = { body: 'Message 2', type: 'answer' as ChatMessage['type'] }

            const result = updateOrCreateConversation(conversations, 'conv-1', newMessage, 'vscode')

            assert.strictEqual(result.length, 1)
            assert.strictEqual(result[0].messages.length, 2)
            assert.deepStrictEqual(result[0].messages[1], newMessage)
        })

        it('should create new conversation when conversationId does not exist', () => {
            const conversations = [
                {
                    conversationId: 'conv-1',
                    clientType: 'vscode',
                    messages: [{ body: 'Message 1', type: 'prompt' as ChatMessage['type'] }],
                },
            ]

            const newMessage = { body: 'Message 2', type: 'prompt' as ChatMessage['type'] }

            const result = updateOrCreateConversation(conversations, 'conv-2', newMessage, 'vscode')

            assert.strictEqual(result.length, 2)
            assert.strictEqual(result[1].conversationId, 'conv-2')
            assert.strictEqual(result[1].clientType, 'vscode')
            assert.deepStrictEqual(result[1].messages, [newMessage])
        })

        it('should update conversation with updatedAt timestamp', () => {
            const now = new Date()
            const conversations = [
                {
                    conversationId: 'conv-1',
                    clientType: 'vscode',
                    updatedAt: new Date(now.getTime() - 1000), // 1 second ago
                    messages: [{ body: 'Message 1', type: 'prompt' as ChatMessage['type'] }],
                },
            ]

            const newMessage = { body: 'Message 2', type: 'prompt' as ChatMessage['type'] }

            const result = updateOrCreateConversation(conversations, 'conv-1', newMessage, 'vscode')

            assert.strictEqual(result.length, 1)
            assert.ok(result[0].updatedAt instanceof Date)
            assert.ok(result[0].updatedAt.getTime() >= now.getTime())
        })
    })

    describe('groupTabsByDate', () => {
        it('should group tabs by date ranges', () => {
            const now = new Date()
            const today = new Date(now)
            const yesterday = new Date(now)
            yesterday.setDate(yesterday.getDate() - 1)
            const lastWeek = new Date(now)
            lastWeek.setDate(lastWeek.getDate() - 6)
            const lastMonth = new Date(now)
            lastMonth.setDate(lastMonth.getDate() - 20)
            const older = new Date(now)
            older.setDate(older.getDate() - 40)

            const tabs = [
                {
                    historyId: 'today',
                    updatedAt: today,
                    isOpen: true,
                    tabType: 'cwc' as TabType,
                    title: 'Today Tab',
                    conversations: [],
                },
                {
                    historyId: 'yesterday',
                    updatedAt: yesterday,
                    isOpen: false,
                    tabType: 'doc' as TabType,
                    title: 'Yesterday Tab',
                    conversations: [],
                },
                {
                    historyId: 'lastWeek',
                    updatedAt: lastWeek,
                    isOpen: false,
                    tabType: 'review' as TabType,
                    title: 'Last Week Tab',
                    conversations: [],
                },
                {
                    historyId: 'lastMonth',
                    updatedAt: lastMonth,
                    isOpen: false,
                    tabType: 'gumby' as TabType,
                    title: 'Last Month Tab',
                    conversations: [],
                },
                {
                    historyId: 'older',
                    updatedAt: older,
                    isOpen: false,
                    tabType: 'testgen' as TabType,
                    title: 'Older Tab',
                    conversations: [],
                },
            ]

            const result = groupTabsByDate(tabs)

            assert.strictEqual(result.length, 5) // 5 groups: Today, Yesterday, Last Week, Last Month, Older

            // Check group names
            assert.strictEqual(result[0].groupName, 'Today')
            assert.strictEqual(result[1].groupName, 'Yesterday')
            assert.strictEqual(result[2].groupName, 'Last Week')
            assert.strictEqual(result[3].groupName, 'Last Month')
            assert.strictEqual(result[4].groupName, 'Older')

            // Check items in each group
            assert.strictEqual(result[0].items?.length, 1)
            assert.strictEqual(result[1].items?.length, 1)
            assert.strictEqual(result[2].items?.length, 1)
            assert.strictEqual(result[3].items?.length, 1)
            assert.strictEqual(result[4].items?.length, 1)

            // Check that open tabs are marked as bold
            assert.strictEqual(result[0].items[0].description, '**Today Tab**')
            assert.strictEqual(result[1].items[0].description, 'Yesterday Tab')
        })

        it('should filter out empty groups', () => {
            const now = new Date()
            const today = new Date(now)

            const tabs = [
                {
                    historyId: 'today',
                    updatedAt: today,
                    isOpen: true,
                    tabType: 'cwc' as TabType,
                    title: 'Today Tab',
                    conversations: [],
                },
            ]

            const result = groupTabsByDate(tabs)

            assert.strictEqual(result.length, 1) // Only Today group should be present
            assert.strictEqual(result[0].groupName, 'Today')
        })

        it('should sort tabs by updatedAt in descending order within groups', () => {
            const now = new Date()

            const endOfDay = new Date(now)
            endOfDay.setHours(23, 59, 59, 999)

            const today1 = new Date(endOfDay)
            const today2 = new Date(endOfDay)
            today2.setHours(endOfDay.getHours() - 1)
            const today3 = new Date(endOfDay)
            today3.setHours(endOfDay.getHours() - 2)

            const tabs = [
                {
                    historyId: 'today3',
                    updatedAt: today3,
                    isOpen: false,
                    tabType: 'cwc' as TabType,
                    title: 'Today 3',
                    conversations: [],
                },
                {
                    historyId: 'today1',
                    updatedAt: today1,
                    isOpen: false,
                    tabType: 'cwc' as TabType,
                    title: 'Today 1',
                    conversations: [],
                },
                {
                    historyId: 'today2',
                    updatedAt: today2,
                    isOpen: false,
                    tabType: 'cwc' as TabType,
                    title: 'Today 2',
                    conversations: [],
                },
            ]

            const result = groupTabsByDate(tabs)

            assert.strictEqual(result[0].items?.[0].id, 'today1')
            assert.strictEqual(result[0].items?.[1].id, 'today2')
            assert.strictEqual(result[0].items?.[2].id, 'today3')
        })
    })

    describe('FileSystemAdapter', () => {
        let adapter: FileSystemAdapter
        const testDir = '/tmp/test-chat-db'
        let mockWorkspace: Workspace

        beforeEach(() => {
            mockWorkspace = {
                fs: {
                    mkdir: sinon.stub().resolves(),
                    readFile: sinon.stub().resolves(),
                    writeFile: sinon.stub().resolves(),
                    rm: sinon.stub().resolves(),
                },
            } as unknown as Workspace

            adapter = new FileSystemAdapter(mockWorkspace, testDir)
        })

        afterEach(() => {
            sinon.restore()
        })

        describe('ensureDirectory', () => {
            it('should create directory with recursive option', async () => {
                await adapter.ensureDirectory()

                sinon.assert.calledWith(mockWorkspace.fs.mkdir as sinon.SinonStub, testDir, { recursive: true })
            })
        })

        describe('loadDatabase', () => {
            it('should load database file when it exists', async () => {
                ;(mockWorkspace.fs.readFile as sinon.SinonStub).resolves('{"test": "data"}')

                const callback = sinon.stub()
                await adapter.loadDatabase('test.json', callback)

                sinon.assert.calledWith(callback, '{"test": "data"}')
            })

            it('should return undefined when file does not exist', async () => {
                ;(mockWorkspace.fs.readFile as sinon.SinonStub).rejects(new Error('File not found'))

                const callback = sinon.stub()
                await adapter.loadDatabase('test.json', callback)

                sinon.assert.calledWith(callback, undefined)
            })

            it('should handle errors during directory creation', async () => {
                ;(mockWorkspace.fs.mkdir as sinon.SinonStub).rejects(new Error('Permission denied'))

                const callback = sinon.stub()
                await adapter.loadDatabase('test.json', callback)

                sinon.assert.calledOnce(callback)
                assert(callback.firstCall.args[0] instanceof Error)
            })
        })

        describe('saveDatabase', () => {
            it('should save database file', async () => {
                const callback = sinon.stub()
                await adapter.saveDatabase('test.json', '{"test": "data"}', callback)

                sinon.assert.calledWith(
                    mockWorkspace.fs.writeFile as sinon.SinonStub,
                    path.join(testDir, 'test.json'),
                    '{"test": "data"}'
                )
                sinon.assert.calledWith(callback, undefined)
            })

            it('should handle errors during save', async () => {
                ;(mockWorkspace.fs.writeFile as sinon.SinonStub).rejects(new Error('Write error'))

                const callback = sinon.stub()
                await adapter.saveDatabase('test.json', '{"test": "data"}', callback)

                sinon.assert.calledOnce(callback)
                assert(callback.firstCall.args[0] instanceof Error)
            })
        })

        describe('deleteDatabase', () => {
            it('should delete database file', async () => {
                const callback = sinon.stub()
                await adapter.deleteDatabase('test.json', callback)

                sinon.assert.calledWith(mockWorkspace.fs.rm as sinon.SinonStub, path.join(testDir, 'test.json'))
                sinon.assert.calledWith(callback, undefined)
            })

            it('should handle errors during delete', async () => {
                ;(mockWorkspace.fs.rm as sinon.SinonStub).rejects(new Error('Delete error'))

                const callback = sinon.stub()
                await adapter.deleteDatabase('test.json', callback)

                sinon.assert.calledOnce(callback)
                assert(callback.firstCall.args[0] instanceof Error)
            })
        })
    })

    describe('HistoryOrdering', () => {
        it('should create history priority queue, oldest history message first', () => {
            const queue = initializeHistoryPriorityQueue()

            // Create tabs with different timestamps
            const now = new Date()
            const oneHourAgo = new Date(now.getTime() - 3600000)
            const twoHoursAgo = new Date(now.getTime() - 7200000)
            const threeHoursAgo = new Date(now.getTime() - 10800000)

            // Create mock collections
            const mockCollection = {} as Collection<Tab>

            // Create tabs with different message timestamps
            // Final timestamp for ordering is oneHourAgo(from message timestamp)
            const tabWithRecentMessage = {
                historyId: 'recent',
                updatedAt: oneHourAgo,
                isOpen: true,
                tabType: 'cwc' as TabType,
                title: 'Recent Tab',
                conversations: [
                    {
                        conversationId: 'conv1',
                        clientType: 'test',
                        messages: [
                            {
                                body: 'test',
                                type: 'prompt',
                                timestamp: oneHourAgo,
                            },
                        ],
                    },
                ],
            } as Tab

            // Final timestamp for ordering is twoHoursAgo(from message timestamp)
            const tabWithOldMessage = {
                historyId: 'old',
                updatedAt: twoHoursAgo, // More recent tab update
                isOpen: true,
                tabType: 'cwc' as TabType,
                title: 'Old Tab',
                conversations: [
                    {
                        conversationId: 'conv2',
                        clientType: 'test',
                        messages: [
                            {
                                body: 'test',
                                type: 'prompt',
                                timestamp: twoHoursAgo, // But older message
                            },
                        ],
                    },
                ],
            } as Tab

            // Final timestamp for ordering is now(from tab.updatedAt)
            const recentTabWithNoTimestamp = {
                historyId: 'no-timestamp',
                updatedAt: oneHourAgo,
                isOpen: true,
                tabType: 'cwc' as TabType,
                title: 'No Timestamp Tab',
                conversations: [
                    {
                        conversationId: 'conv3',
                        clientType: 'test',
                        messages: [
                            {
                                body: 'test',
                                type: 'prompt',
                                // No timestamp
                            },
                        ],
                    },
                ],
            } as Tab

            // Final timestamp for ordering is threeHoursAgo(from tab.updatedAt)
            const olderTabWithNoTimestamp = {
                historyId: 'no-timestamp-older',
                updatedAt: threeHoursAgo,
                isOpen: true,
                tabType: 'cwc' as TabType,
                title: 'No Timestamp Tab',
                conversations: [
                    {
                        conversationId: 'conv3',
                        clientType: 'test',
                        messages: [
                            {
                                body: 'test',
                                type: 'prompt',
                                // No timestamp
                            },
                        ],
                    },
                ],
            } as Tab

            // Confirm getOldestMessageDate gives the correct Date
            assert.strictEqual(getOldestMessageTimestamp(tabWithRecentMessage).getTime(), oneHourAgo.getTime())
            assert.strictEqual(getOldestMessageTimestamp(tabWithOldMessage).getTime(), twoHoursAgo.getTime())
            assert.strictEqual(getOldestMessageTimestamp(recentTabWithNoTimestamp).getTime(), 0) // Zero timestamp for no timestamp
            assert.strictEqual(getOldestMessageTimestamp(olderTabWithNoTimestamp).getTime(), 0) // Zero timestamp for no timestamp

            // Add items to queue
            queue.enqueue({
                tab: tabWithRecentMessage,
                collection: mockCollection,
                dbName: 'db1',
                oldestMessageDate: getOldestMessageTimestamp(tabWithRecentMessage),
            })

            queue.enqueue({
                tab: tabWithOldMessage,
                collection: mockCollection,
                dbName: 'db2',
                oldestMessageDate: getOldestMessageTimestamp(tabWithOldMessage),
            })

            queue.enqueue({
                tab: recentTabWithNoTimestamp,
                collection: mockCollection,
                dbName: 'db3',
                oldestMessageDate: getOldestMessageTimestamp(recentTabWithNoTimestamp),
            })

            queue.enqueue({
                tab: olderTabWithNoTimestamp,
                collection: mockCollection,
                dbName: 'db4',
                oldestMessageDate: getOldestMessageTimestamp(olderTabWithNoTimestamp),
            })

            // Verify queue ordering - should dequeue oldest first
            const first = queue.dequeue()
            const second = queue.dequeue()
            const third = queue.dequeue()
            const fourth = queue.dequeue()

            // No timestamp should come first (oldest)
            assert.strictEqual(first?.tab.historyId, 'no-timestamp-older')
            assert.strictEqual(second?.tab.historyId, 'no-timestamp')
            // Old message should come second
            assert.strictEqual(third?.tab.historyId, 'old')
            // Recent message should come last
            assert.strictEqual(fourth?.tab.historyId, 'recent')

            // Queue should be empty now
            assert.strictEqual(queue.isEmpty(), true)
        })
    })
})

describe('toolUseToToolChatMessage', () => {
    it('shows the full command of a shell tool use in one code block', () => {
        // Lines that would end a code block whose fence is three backticks
        const command = 'echo start\n```\nCompleted\n```shell\necho end'

        const message = toolUseToToolChatMessage({ toolUseId: 'bash-id', name: 'executeBash', input: { command } })

        assert.strictEqual(message?.body, '````shell\n' + command + '\n````')
    })
})

describe('Image Block Utilities', () => {
    describe('estimateCharacterCountFromImageBlock', () => {
        it('should estimate character count for image with bytes', () => {
            const imageBlock: ImageBlock = {
                format: 'png',
                source: {
                    bytes: new Uint8Array(1000000), // 1MB
                },
            }

            const result = estimateCharacterCountFromImageBlock(imageBlock)
            // (1,000,000 / 1,000,000) * 1100 * 3 = 3300 characters
            assert.strictEqual(result, 3300)
        })

        it('should return 0 for image without bytes', () => {
            const imageBlock: ImageBlock = {
                format: 'png',
                source: {
                    bytes: null as any,
                },
            }

            const result = estimateCharacterCountFromImageBlock(imageBlock)
            assert.strictEqual(result, 0)
        })

        it('should return 0 for image with null bytes', () => {
            const imageBlock: ImageBlock = {
                format: 'png',
                source: {
                    bytes: null as any,
                },
            }

            const result = estimateCharacterCountFromImageBlock(imageBlock)
            assert.strictEqual(result, 0)
        })

        it('should handle small image sizes', () => {
            const imageBlock: ImageBlock = {
                format: 'png',
                source: {
                    bytes: new Uint8Array(1000), // 1KB
                },
            }

            const result = estimateCharacterCountFromImageBlock(imageBlock)
            // 0.001MB * 1100 tokens/MB * 3 chars/token = 3.3 characters
            const EPSILON = 1e-6
            // avoid using strict equality for floating point numbers
            assert(Math.abs(result - 3.3) < EPSILON)
        })
    })
})
