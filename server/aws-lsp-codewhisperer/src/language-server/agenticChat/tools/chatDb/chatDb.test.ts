/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import sinon from 'ts-sinon'
import { ChatDatabase, ToolResultValidationError } from './chatDb'
import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { Message } from './util'
import { ChatMessage, ToolResultStatus } from '@amzn/codewhisperer-streaming'
import * as fs from 'fs'
import * as util from './util'
import { sleep } from '@aws/lsp-core/out/util/timeoutUtils'

describe('ChatDatabase', () => {
    let mockFeatures: Features
    let chatDb: ChatDatabase
    let logDebugStub: sinon.SinonStub
    let logWarnStub: sinon.SinonStub
    let writeFileStub: sinon.SinonStub

    beforeEach(() => {
        logDebugStub = sinon.stub()
        logWarnStub = sinon.stub()
        writeFileStub = sinon.stub(fs, 'writeFile').callsArgWith(3, null)

        mockFeatures = {
            logging: {
                debug: logDebugStub,
                warn: logWarnStub,
                log: sinon.stub(),
                info: sinon.stub(),
                error: sinon.stub(),
            },
            runtime: {
                platform: 'node',
            },
            lsp: {
                getClientInitializeParams: sinon.stub().returns({
                    clientInfo: { name: 'test-client' },
                }),
            },
            workspace: {
                fs: {
                    getServerDataDirPath: sinon.stub().returns('/tmp'),
                    getFileSize: sinon.stub().resolves({ size: 0 }),
                    mkdir: sinon.stub().resolves(undefined),
                    writeFile: sinon.stub().resolves(undefined),
                },
                getAllWorkspaceFolders: sinon.stub().returns([
                    {
                        uri: 'file:///workspace',
                        name: 'workspace',
                    },
                ]) as any,
            },
        } as unknown as Features

        chatDb = ChatDatabase.getInstance(mockFeatures)
    })

    afterEach(() => {
        chatDb.close()
        sinon.restore()
    })

    describe('pinned context', () => {
        beforeEach(async () => {
            await chatDb.databaseInitialize(0)
        })

        it('does not mutate the shared DEFAULT_PINNED_CONTEXT when pinning in a tab', () => {
            const defaultLengthBefore = util.DEFAULT_PINNED_CONTEXT.length
            const customContext = { id: 'custom-folder-ctx', command: 'myFolder', label: 'folder' } as any

            // Create the tab first (with tabContext but no pinnedContext yet) so that
            // addPinnedContext initializes pinnedContext from the shared default — the
            // code path that previously aliased and then mutated DEFAULT_PINNED_CONTEXT.
            chatDb.setRules('tab-1', { folders: {}, rules: {} } as any)
            chatDb.addPinnedContext('tab-1', customContext)

            // The shared module-level default must not be polluted by pinning in a tab,
            // otherwise every new chat window would inherit the custom pinned item.
            assert.strictEqual(util.DEFAULT_PINNED_CONTEXT.length, defaultLengthBefore)
            assert.ok(!util.DEFAULT_PINNED_CONTEXT.some((c: any) => c.id === 'custom-folder-ctx'))

            // A brand-new tab must only receive the default pinned context, not the item
            // that was pinned in a different tab.
            const freshTabPinned = chatDb.getPinnedContext('tab-2-fresh')
            assert.ok(!freshTabPinned.some((c: any) => c.id === 'custom-folder-ctx'))
        })
    })

    describe('replaceWithSummary', () => {
        it('should create a new history with summary message', async () => {
            await chatDb.databaseInitialize(0)
            const tabId = 'tab-1'
            const tabType = 'cwc'
            const conversationId = 'conv-1'
            const summaryMessage = {
                body: 'This is a summary of the conversation',
                type: 'prompt' as any,
                timestamp: new Date(),
            }

            // Call the method
            chatDb.replaceWithSummary(tabId, tabType, conversationId, summaryMessage)

            // Verify the messages array contains the summary and a dummy response
            const messages = chatDb.getMessages(tabId, 250)
            assert.strictEqual(messages.length, 2)
            assert.strictEqual(messages[0].body, summaryMessage.body)
            assert.strictEqual(messages[0].type, 'prompt')
            assert.strictEqual(messages[1].body, 'Working...')
            assert.strictEqual(messages[1].type, 'answer')
            assert.strictEqual(messages[1].shouldDisplayMessage, false)
        })
    })

    describe('ensureValidMessageSequence', () => {
        it('should preserve valid alternating sequence', () => {
            const messages: Message[] = [
                { type: 'prompt', body: 'User first message', userInputMessageContext: {} },
                { type: 'answer', body: 'Assistant first response' },
                { type: 'prompt', body: 'User second message', userInputMessageContext: {} },
                { type: 'answer', body: 'Assistant second response' },
            ]

            const originalMessages = [...messages]

            chatDb.ensureValidMessageSequence('tab-1', messages)

            assert.strictEqual(messages.length, 4, 'Should not modify valid sequence')
            assert.deepStrictEqual(messages, originalMessages, 'Messages should remain unchanged')
        })

        it('should remove assistant messages from the beginning', () => {
            const messages: Message[] = [
                { type: 'answer', body: 'Assistant first message' },
                { type: 'answer', body: 'Assistant second message' },
                { type: 'prompt', body: 'User message', userInputMessageContext: {} },
                { type: 'answer', body: 'Assistant response' },
            ]

            chatDb.ensureValidMessageSequence('tab-1', messages)

            assert.strictEqual(messages.length, 2, 'Should have removed assistant messages from the beginning')
            assert.strictEqual(messages[0].type, 'prompt', 'First message should be from user')
            assert.strictEqual(messages[1].type, 'answer', 'Last message should be from assistant')
        })

        it('should remove user messages with tool results from the beginning', () => {
            const messages: Message[] = [
                {
                    type: 'prompt',
                    body: 'User message with tool results',
                    userInputMessageContext: {
                        toolResults: [
                            { toolUseId: 'tool-1', status: ToolResultStatus.SUCCESS, content: [{ text: 'result' }] },
                        ],
                    },
                },
                { type: 'answer', body: 'Assistant response' },
                {
                    type: 'prompt',
                    body: 'User message without tool results',
                    userInputMessageContext: {},
                },
                { type: 'answer', body: 'Assistant final response' },
            ]

            chatDb.ensureValidMessageSequence('tab-1', messages)

            assert.strictEqual(messages.length, 2, 'Should have removed user-assistant pair with tool results')
            assert.strictEqual(messages[0].type, 'prompt', 'First message should be from user')
            assert.strictEqual(
                messages[0].body,
                'User message without tool results',
                'Should be the message without tool results'
            )
            assert.strictEqual(messages[1].type, 'answer', 'Last message should be from assistant')
        })

        it('should remove multiple user-assistant pairs with tool results from the beginning', () => {
            const messages: Message[] = [
                {
                    type: 'prompt',
                    body: 'User message with tool results 1',
                    userInputMessageContext: {
                        toolResults: [
                            { toolUseId: 'tool-1', status: ToolResultStatus.SUCCESS, content: [{ text: 'result 1' }] },
                        ],
                    },
                },
                { type: 'answer', body: 'Assistant response 1' },
                {
                    type: 'prompt',
                    body: 'User message with tool results 2',
                    userInputMessageContext: {
                        toolResults: [
                            { toolUseId: 'tool-2', status: ToolResultStatus.SUCCESS, content: [{ text: 'result 2' }] },
                        ],
                    },
                },
                { type: 'answer', body: 'Assistant response 2' },
                {
                    type: 'prompt',
                    body: 'User message without tool results',
                    userInputMessageContext: {},
                },
                { type: 'answer', body: 'Assistant final response' },
            ]

            chatDb.ensureValidMessageSequence('tab-1', messages)

            assert.strictEqual(messages.length, 2, 'Should have removed all user-assistant pairs with tool results')
            assert.strictEqual(messages[0].type, 'prompt', 'First message should be from user')
            assert.strictEqual(
                messages[0].body,
                'User message without tool results',
                'Should be the message without tool results'
            )
            assert.strictEqual(messages[1].type, 'answer', 'Last message should be from assistant')
        })

        it('should add a dummy response at the end', () => {
            const messages: Message[] = [
                { type: 'prompt', body: 'User first message', userInputMessageContext: {} },
                { type: 'answer', body: 'Assistant response' },
                { type: 'prompt', body: 'User trailing message', userInputMessageContext: {} },
            ]

            chatDb.ensureValidMessageSequence('tab-1', messages)

            assert.strictEqual(messages.length, 4, 'Should have added a dummy response')
            assert.strictEqual(messages[0].type, 'prompt', 'First message should be from user')
            assert.strictEqual(messages[3].type, 'answer', 'Last message should be from assistant')
            assert.strictEqual(messages[3].shouldDisplayMessage, false, 'The message should be hidden')
        })

        it('should handle empty message array', () => {
            const messages: Message[] = []

            chatDb.ensureValidMessageSequence('tab-1', messages)

            assert.strictEqual(messages.length, 0, 'Empty array should remain empty')
        })
    })

    describe('validateNewMessageToolResults', () => {
        it('should handle empty history message array', () => {
            const messages: Message[] = []

            const newUserMessage = {
                userInputMessage: {
                    content: '',
                    userInputMessageContext: {
                        toolResults: [
                            {
                                toolUseId: 'tool-1',
                                status: ToolResultStatus.SUCCESS,
                                content: [{ text: 'Valid result' }],
                            },
                        ],
                    },
                },
            } as ChatMessage

            assert.throws(() => {
                chatDb.validateAndFixNewMessageToolResults(messages, newUserMessage)
            }, ToolResultValidationError)
        })

        it('should handle new user message with valid tool results', () => {
            const messages: Message[] = [
                {
                    type: 'prompt',
                    body: 'User first message',
                },
                {
                    type: 'answer',
                    body: 'Assistant message with tool use',
                    toolUses: [{ toolUseId: 'tool-1', name: 'testTool', input: { key: 'value' } }],
                },
            ]

            const newUserMessage = {
                userInputMessage: {
                    content: '',
                    userInputMessageContext: {
                        toolResults: [
                            {
                                toolUseId: 'tool-1',
                                status: ToolResultStatus.SUCCESS,
                                content: [{ text: 'Valid result' }],
                            },
                        ],
                    },
                },
            } as ChatMessage

            // Should not throw an exception
            chatDb.validateAndFixNewMessageToolResults(messages, newUserMessage)

            const toolResults = newUserMessage.userInputMessage!.userInputMessageContext?.toolResults || []
            assert.strictEqual(toolResults.length, 1, 'Should keep valid tool results')
            assert.strictEqual(toolResults[0].toolUseId, 'tool-1', 'Should have correct tool ID')
            assert.strictEqual(toolResults[0].status, ToolResultStatus.SUCCESS, 'Should keep success status')
            assert.strictEqual(toolResults[0].content?.[0]?.text, 'Valid result', 'Should keep original content')
        })

        it('should handle new user message with missing tool results', () => {
            const messages: Message[] = [
                {
                    type: 'prompt',
                    body: 'User first message',
                },
                {
                    type: 'answer',
                    body: 'Assistant message with tool use',
                    toolUses: [{ toolUseId: 'tool-1', name: 'testTool', input: { key: 'value' } }],
                },
            ]

            const newUserMessage = {
                userInputMessage: {
                    content: 'New message',
                    userInputMessageContext: {},
                },
            } as ChatMessage

            // Should not throw an exception
            chatDb.validateAndFixNewMessageToolResults(messages, newUserMessage)

            const toolResults = newUserMessage.userInputMessage!.userInputMessageContext?.toolResults || []
            assert.strictEqual(toolResults.length, 1, 'Should have added tool results')

            // Check missing tool result was added
            assert.strictEqual(toolResults[0].toolUseId, 'tool-1', 'Should add missing tool ID')
            assert.strictEqual(toolResults[0].status, ToolResultStatus.ERROR, 'Should mark as error')
        })

        it('should handle new user message with tool results after assistant message without tool uses', () => {
            const messages: Message[] = [
                {
                    type: 'answer',
                    body: 'Assistant message with tool use',
                    toolUses: [],
                },
            ]

            const newUserMessage = {
                userInputMessage: {
                    content: '',
                    userInputMessageContext: {
                        toolResults: [
                            {
                                toolUseId: 'tool-1',
                                status: ToolResultStatus.SUCCESS,
                                content: [{ text: 'Valid result' }],
                            },
                        ],
                    },
                },
            } as ChatMessage

            assert.throws(() => {
                chatDb.validateAndFixNewMessageToolResults(messages, newUserMessage)
            }, ToolResultValidationError)
        })

        it('should handle new user message with invalid tool results ID', () => {
            const messages: Message[] = [
                {
                    type: 'answer',
                    body: 'Assistant message with tool use',
                    toolUses: [{ toolUseId: 'tool-2', name: 'testTool', input: { key: 'value' } }],
                },
            ]

            const newUserMessage = {
                userInputMessage: {
                    content: '',
                    userInputMessageContext: {
                        toolResults: [
                            {
                                toolUseId: 'tool-1',
                                status: ToolResultStatus.SUCCESS,
                                content: [{ text: 'Valid result' }],
                            },
                        ],
                    },
                },
            } as ChatMessage

            // Should not throw an exception
            chatDb.validateAndFixNewMessageToolResults(messages, newUserMessage)

            const toolResults = newUserMessage.userInputMessage!.userInputMessageContext?.toolResults || []
            assert.strictEqual(toolResults.length, 1, 'Should have only one tool results')
            assert.strictEqual(toolResults[0].toolUseId, 'tool-2', 'Tool ID should match previous message')
        })

        it('should handle multiple tool uses and results correctly', () => {
            const messages: Message[] = [
                {
                    type: 'prompt',
                    body: 'User first message',
                },
                {
                    type: 'answer',
                    body: 'Assistant first response',
                    toolUses: [{ toolUseId: 'tool-1', name: 'testTool', input: { key: 'value1' } }],
                },
                {
                    type: 'prompt',
                    body: 'User second message',
                    userInputMessageContext: {
                        toolResults: [
                            { toolUseId: 'tool-1', status: ToolResultStatus.SUCCESS, content: [{ text: 'Result 1' }] },
                        ],
                    },
                },
                {
                    type: 'answer',
                    body: 'Assistant second response',
                    toolUses: [
                        { toolUseId: 'tool-2', name: 'testTool', input: { key: 'value2' } },
                        { toolUseId: 'tool-3', name: 'testTool', input: { key: 'value3' } },
                    ],
                },
            ]

            const newUserMessage = {
                userInputMessage: {
                    content: 'New message',
                    userInputMessageContext: {
                        toolResults: [
                            { toolUseId: 'tool-2', status: ToolResultStatus.SUCCESS, content: [{ text: 'Result 2' }] },
                        ],
                    },
                },
            } as ChatMessage

            // Should not throw an exception
            chatDb.validateAndFixNewMessageToolResults(messages, newUserMessage)

            const toolResults = newUserMessage.userInputMessage!.userInputMessageContext?.toolResults || []
            assert.strictEqual(toolResults.length, 2, 'Should have correct number of tool results')

            // Check valid result is preserved
            assert.strictEqual(toolResults[0].toolUseId, 'tool-2', 'Should preserve valid tool ID')
            assert.strictEqual(toolResults[0].status, ToolResultStatus.SUCCESS, 'Should keep success status')

            // Check missing tool result was added
            assert.strictEqual(toolResults[1].toolUseId, 'tool-3', 'Should add missing tool ID')
            assert.strictEqual(toolResults[1].status, ToolResultStatus.ERROR, 'Should mark as error')
        })

        it('should handle new user message with no tool results and blank content', () => {
            const messages: Message[] = [
                {
                    type: 'prompt',
                    body: 'User first message',
                },
                {
                    type: 'answer',
                    body: 'Assistant message with tool use',
                },
            ]

            const newUserMessage = {
                userInputMessage: {
                    content: '',
                    userInputMessageContext: {
                        toolResults: [],
                    },
                },
            } as ChatMessage

            assert.throws(() => {
                chatDb.validateAndFixNewMessageToolResults(messages, newUserMessage)
            }, ToolResultValidationError)
        })
    })

    describe('calculateNewMessageCharacterCount', () => {
        it('should calculate character count for new message and pinned context', () => {
            const newUserMessage = {
                userInputMessage: {
                    content: 'Test message',
                    userInputMessageContext: {},
                },
            } as ChatMessage

            const pinnedContextMessages = [
                {
                    userInputMessage: {
                        content: 'Pinned context 1',
                    },
                },
                {
                    assistantResponseMessage: {
                        content: 'Pinned response 1',
                    },
                },
            ]

            // Stub the calculateMessagesCharacterCount method
            const calculateMessagesCharacterCountStub = sinon.stub(chatDb, 'calculateMessagesCharacterCount')
            calculateMessagesCharacterCountStub.onFirstCall().returns(11) // 'Test message'
            calculateMessagesCharacterCountStub.onSecondCall().returns(30) // Pinned context messages

            // Stub the calculateToolSpecCharacterCount method
            const calculateToolSpecCharacterCountStub = sinon.stub(chatDb as any, 'calculateToolSpecCharacterCount')
            calculateToolSpecCharacterCountStub.returns(50) // Tool spec count

            const result = chatDb.calculateNewMessageCharacterCount(newUserMessage, pinnedContextMessages)

            // Verify the result is the sum of all character counts
            assert.strictEqual(result, 91) // 11 + 30 + 50

            // Verify the methods were called with correct arguments
            sinon.assert.calledWith(calculateMessagesCharacterCountStub.firstCall, [
                {
                    body: 'Test message',
                    type: 'prompt',
                    userIntent: undefined,
                    origin: 'IDE',
                    userInputMessageContext: {},
                },
            ])

            // Clean up
            calculateMessagesCharacterCountStub.restore()
            calculateToolSpecCharacterCountStub.restore()
        })
    })

    describe('getWorkspaceIdentifier', () => {
        const MOCK_MD5_HASH = '5bc032692b81700eb516f317861fbf32'
        const MOCK_SHA256_HASH = 'bb6b72d3eab82acaabbda8ca6c85658b83e178bb57760913ccdd938bbeaede9f'

        let existsSyncStub: sinon.SinonStub
        let renameSyncStub: sinon.SinonStub
        let getMd5WorkspaceIdStub: sinon.SinonStub
        let getSha256WorkspaceIdStub: sinon.SinonStub

        beforeEach(() => {
            existsSyncStub = sinon.stub(fs, 'existsSync')
            renameSyncStub = sinon.stub(fs, 'renameSync')

            // Mock hash functions
            getMd5WorkspaceIdStub = sinon.stub(util, 'getMd5WorkspaceId')
            getMd5WorkspaceIdStub.withArgs('/path/to/workspace').returns(MOCK_MD5_HASH)

            getSha256WorkspaceIdStub = sinon.stub(util, 'getSha256WorkspaceId')
            getSha256WorkspaceIdStub.withArgs('/path/to/workspace.code-workspace').returns(MOCK_SHA256_HASH)
        })

        afterEach(() => {
            existsSyncStub.restore()
            renameSyncStub.restore()
            getMd5WorkspaceIdStub.restore()
            getSha256WorkspaceIdStub.restore()
        })

        it('case 1: old plugin, workspaceFilePath is not provided. Should return folder based ID', () => {
            // Setup: workspaceFilePath is undefined
            const lspStub = mockFeatures.lsp.getClientInitializeParams as sinon.SinonStub
            lspStub.returns({
                initializationOptions: {
                    aws: {
                        awsClientCapabilities: {
                            q: {},
                        },
                    },
                },
            })

            // Setup: single workspace folder
            const workspaceStub = mockFeatures.workspace.getAllWorkspaceFolders as sinon.SinonStub
            workspaceStub.returns([{ uri: 'file:///path/to/workspace' }])

            // Verify: should use folder-based identifier (MD5 hash)
            assert.strictEqual(
                MOCK_MD5_HASH,
                chatDb.getWorkspaceIdentifier(),
                'should use md5 hash for workspace folder'
            )
        })

        it('case 2: new plugin, workspaceFilePath is provided, no existing folder based history file. Should return ws file based ID', () => {
            // Setup: workspaceFilePath is provided
            const lspStub = mockFeatures.lsp.getClientInitializeParams as sinon.SinonStub
            lspStub.returns({
                initializationOptions: {
                    aws: {
                        awsClientCapabilities: {
                            q: {
                                workspaceFilePath: '/path/to/workspace.code-workspace',
                            },
                        },
                    },
                },
            })

            // Setup: new DB file exists, so no migration needed
            existsSyncStub.returns(true)

            // Verify: should use workspace file based identifier (sha256 hash)
            assert.strictEqual(
                MOCK_SHA256_HASH,
                chatDb.getWorkspaceIdentifier(),
                'should use sha256 hash for workspace file'
            )
            // Verify: should not attempt migration since new file exists
            assert.strictEqual(renameSyncStub.callCount, 0, 'Should not attempt migration when new file exists')
        })

        it('case 3: new plugin, workspaceFilePath is provided, folder based history file exists. Should migrate to ws file based ID', () => {
            // Setup: workspaceFilePath is provided
            const lspStub = mockFeatures.lsp.getClientInitializeParams as sinon.SinonStub
            lspStub.returns({
                initializationOptions: {
                    aws: {
                        awsClientCapabilities: {
                            q: {
                                workspaceFilePath: '/path/to/workspace.code-workspace',
                            },
                        },
                    },
                },
            })

            // Setup: single workspace folder
            const workspaceStub = mockFeatures.workspace.getAllWorkspaceFolders as sinon.SinonStub
            workspaceStub.returns([{ uri: 'file:///path/to/workspace' }])

            // Setup: new DB file doesn't exist, but old file exists
            // Use callsFake with a counter to control return values consistently
            let callCount = 0
            existsSyncStub.callsFake(() => {
                // First call returns false (new file doesn't exist)
                // All subsequent calls return true (old file exists)
                return callCount++ === 0 ? false : true
            })

            // Verify: should attempt migration
            assert.strictEqual(
                'bb6b72d3eab82acaabbda8ca6c85658b83e178bb57760913ccdd938bbeaede9f',
                chatDb.getWorkspaceIdentifier(),
                'should use sha256 hash for workspace file'
            )
            assert.strictEqual(renameSyncStub.callCount, 1, 'Should attempt migration when old file exists')
            // Verify: migration should rename old file to new file
            const renameCall = renameSyncStub.getCall(0)
            assert.ok(
                renameCall.args[0].endsWith('chat-history-5bc032692b81700eb516f317861fbf32.json'),
                'Should rename from old file path'
            )
            assert.ok(
                renameCall.args[1].endsWith(
                    'chat-history-bb6b72d3eab82acaabbda8ca6c85658b83e178bb57760913ccdd938bbeaede9f.json'
                ),
                'Should rename to new file path'
            )
        })
    })

    describe('Model Cache Management', () => {
        beforeEach(async () => {
            await chatDb.databaseInitialize(0)
        })

        it('should cache and retrieve models', () => {
            const models = [{ id: 'model-1', name: 'Test Model' }]
            const defaultModelId = 'model-1'

            chatDb.setCachedModels(models, defaultModelId)
            const cached = chatDb.getCachedModels()

            assert.ok(cached, 'Should return cached data')
            assert.deepStrictEqual(cached.models, models)
            assert.strictEqual(cached.defaultModelId, defaultModelId)
            assert.ok(cached.timestamp > 0, 'Should have timestamp')
        })

        it('should validate cache expiry', () => {
            const models = [{ id: 'model-1', name: 'Test Model' }]
            chatDb.setCachedModels(models)

            // Mock isCachedValid to return false (expired)
            const isCachedValidStub = sinon.stub(util, 'isCachedValid').returns(false)

            assert.strictEqual(chatDb.isCachedModelsValid(), false)

            isCachedValidStub.restore()
        })

        it('should clear cached models', () => {
            const models = [{ id: 'model-1', name: 'Test Model' }]
            chatDb.setCachedModels(models)

            // Verify cache exists
            assert.ok(chatDb.getCachedModels(), 'Cache should exist before clearing')

            chatDb.clearCachedModels()

            // Verify cache is cleared
            assert.strictEqual(chatDb.getCachedModels(), undefined, 'Cache should be cleared')
        })

        it('should clear model cache via static method when instance exists', () => {
            const models = [{ id: 'model-1', name: 'Test Model' }]
            chatDb.setCachedModels(models)

            // Verify cache exists
            assert.ok(chatDb.getCachedModels(), 'Cache should exist before clearing')

            ChatDatabase.clearModelCache()

            // Verify cache is cleared
            assert.strictEqual(chatDb.getCachedModels(), undefined, 'Cache should be cleared via static method')
        })

        it('should handle static clearModelCache when no instance exists', () => {
            // Close current instance
            chatDb.close()

            // Should not throw when no instance exists
            assert.doesNotThrow(() => {
                ChatDatabase.clearModelCache()
            }, 'Should not throw when no instance exists')
        })
    })
})
function uuid(): `${string}-${string}-${string}-${string}-${string}` {
    throw new Error('Function not implemented.')
}
