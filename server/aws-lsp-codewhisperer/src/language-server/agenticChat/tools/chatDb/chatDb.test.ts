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

    describe('Pair Programming Mode Initialization', () => {
        // These tests exercise the window before the LokiJS database finishes
        // loading (isInitialized() === false). To make that window deterministic,
        // we build a dedicated instance whose filesystem `mkdir` never resolves,
        // so LokiJS autoload never completes and the instance stays uninitialized
        // until we explicitly call databaseInitialize().
        let modeDb: ChatDatabase

        beforeEach(() => {
            const neverResolvingMkdir = sinon.stub().returns(new Promise<void>(() => {}))
            const modeFeatures = {
                ...(mockFeatures as any),
                workspace: {
                    ...(mockFeatures.workspace as any),
                    fs: {
                        ...(mockFeatures.workspace as any).fs,
                        mkdir: neverResolvingMkdir,
                    },
                },
            } as unknown as Features
            // Use `new` (not getInstance) so this controlled instance is independent
            // of the singleton created by the outer beforeEach.
            modeDb = new ChatDatabase(modeFeatures)
        })

        afterEach(() => {
            modeDb.close()
        })

        it('pre-init reads: effective mode is false and settings are undefined with no pending choice', () => {
            assert.strictEqual(modeDb.isInitialized(), false, 'Database should be uninitialized')
            assert.strictEqual(modeDb.getPairProgrammingMode(), undefined, 'Global mode should be undefined')
            assert.strictEqual(modeDb.getTabPairProgrammingMode('tab-1'), undefined, 'Tab mode should be undefined')
            // Key regression: before init with no explicit choice, do NOT default to
            // true (agentic ON). Default to false so a possibly-persisted OFF is not
            // overridden before the database is ready.
            assert.strictEqual(
                modeDb.getEffectiveTabPairProgrammingMode('tab-1'),
                false,
                'Effective mode should be false when uninitialized with no pending choice'
            )
        })

        it('early OFF: an explicit global OFF before init is surfaced on reads and survives the flush', async () => {
            modeDb.setPairProgrammingMode(false)

            assert.strictEqual(modeDb.isInitialized(), false, 'Database should still be uninitialized')
            assert.strictEqual(modeDb.getPairProgrammingMode(), false, 'Pending OFF should be surfaced before init')
            assert.strictEqual(
                modeDb.getEffectiveTabPairProgrammingMode('tab-1'),
                false,
                'Effective mode should honor the pending OFF before init'
            )

            await modeDb.databaseInitialize(0)

            assert.strictEqual(modeDb.getPairProgrammingMode(), false, 'OFF should be flushed to global settings')
            assert.strictEqual(
                modeDb.getEffectiveTabPairProgrammingMode('tab-1'),
                false,
                'Effective mode should remain false after init'
            )
        })

        it('early OFF (per-tab): an explicit tab OFF before init is surfaced on reads', () => {
            modeDb.setTabPairProgrammingMode('tab-1', false)

            assert.strictEqual(modeDb.getTabPairProgrammingMode('tab-1'), false, 'Pending tab OFF should be surfaced')
            // Per-tab setters also mirror into the pending global default.
            assert.strictEqual(modeDb.getPairProgrammingMode(), false, 'Tab OFF should mirror into pending global')
            assert.strictEqual(
                modeDb.getEffectiveTabPairProgrammingMode('tab-1'),
                false,
                'Effective mode should honor the pending tab OFF before init'
            )
        })

        it('mixed tab choices: distinct per-tab selections before init are preserved through the flush', async () => {
            modeDb.setTabPairProgrammingMode('tab-a', true)
            modeDb.setTabPairProgrammingMode('tab-b', false)

            // Pre-init reads reflect each tab's own pending selection.
            assert.strictEqual(modeDb.getTabPairProgrammingMode('tab-a'), true, 'tab-a pending should be true')
            assert.strictEqual(modeDb.getTabPairProgrammingMode('tab-b'), false, 'tab-b pending should be false')
            assert.strictEqual(modeDb.getEffectiveTabPairProgrammingMode('tab-a'), true, 'tab-a effective pre-init')
            assert.strictEqual(modeDb.getEffectiveTabPairProgrammingMode('tab-b'), false, 'tab-b effective pre-init')

            await modeDb.databaseInitialize(0)

            // After flush, per-tab selections are persisted independently.
            assert.strictEqual(modeDb.getTabPairProgrammingMode('tab-a'), true, 'tab-a should persist true')
            assert.strictEqual(modeDb.getTabPairProgrammingMode('tab-b'), false, 'tab-b should persist false')
            assert.strictEqual(modeDb.getEffectiveTabPairProgrammingMode('tab-a'), true, 'tab-a effective post-init')
            assert.strictEqual(modeDb.getEffectiveTabPairProgrammingMode('tab-b'), false, 'tab-b effective post-init')
        })

        it('final global ordering: the last global selection wins across interleaved setters after flush', async () => {
            // Interleave per-tab setters (which mirror into global) with direct
            // global setters. The last global write (false) must be authoritative.
            modeDb.setTabPairProgrammingMode('tab-a', true) // global -> true
            modeDb.setPairProgrammingMode(false) // global -> false
            modeDb.setTabPairProgrammingMode('tab-b', true) // global -> true
            modeDb.setPairProgrammingMode(false) // global -> false (last)

            await modeDb.databaseInitialize(0)

            assert.strictEqual(
                modeDb.getPairProgrammingMode(),
                false,
                'Global mode should equal the last global selection, not the last tab mirror'
            )
            // Per-tab selections are still preserved independently of the global value.
            assert.strictEqual(modeDb.getTabPairProgrammingMode('tab-a'), true, 'tab-a should persist true')
            assert.strictEqual(modeDb.getTabPairProgrammingMode('tab-b'), true, 'tab-b should persist true')
            // A brand-new tab with no selection falls back to the final global value.
            assert.strictEqual(
                modeDb.getEffectiveTabPairProgrammingMode('tab-c'),
                false,
                'New tab should inherit the final global selection'
            )
        })

        it('loaded settings preserved: flushing pending mode merges into (does not clobber) existing settings', async () => {
            modeDb.setPairProgrammingMode(false) // pending global OFF

            // Simulate settings that were loaded from disk before the flush runs.
            // getSettings is what the flush reads before writing the merged record.
            const loadedSettings = {
                modelId: 'model-X',
                pairProgrammingMode: undefined,
                cachedModels: [{ id: 'm1', name: 'M1' }],
                cachedDefaultModelId: 'm1',
                modelCacheTimestamp: 123456,
            }
            const getSettingsStub = sinon.stub(modeDb, 'getSettings').returns(loadedSettings as any)

            await modeDb.databaseInitialize(0)

            getSettingsStub.restore()

            // The pending mode is applied...
            assert.strictEqual(modeDb.getPairProgrammingMode(), false, 'Pending OFF should be flushed')
            // ...without dropping unrelated loaded settings.
            assert.strictEqual(modeDb.getModelId(), 'model-X', 'modelId should be preserved')
            const cached = modeDb.getCachedModels()
            assert.ok(cached, 'Cached models should be preserved')
            assert.deepStrictEqual(cached.models, loadedSettings.cachedModels, 'Cached models should be intact')
            assert.strictEqual(cached.defaultModelId, 'm1', 'Cached default model should be intact')
            assert.strictEqual(cached.timestamp, 123456, 'Cache timestamp should be intact')
        })

        it('initialized defaults: effective mode is true when initialized with no explicit choice', async () => {
            await modeDb.databaseInitialize(0)

            assert.strictEqual(modeDb.getPairProgrammingMode(), undefined, 'No global setting should exist')
            assert.strictEqual(modeDb.getTabPairProgrammingMode('tab-1'), undefined, 'No tab setting should exist')
            // Once initialized with genuinely no stored preference, keep the
            // first-time-user default of true.
            assert.strictEqual(
                modeDb.getEffectiveTabPairProgrammingMode('tab-1'),
                true,
                'Effective mode should default to true when initialized with no choice'
            )
        })
    })
})
function uuid(): `${string}-${string}-${string}-${string}-${string}` {
    throw new Error('Function not implemented.')
}
