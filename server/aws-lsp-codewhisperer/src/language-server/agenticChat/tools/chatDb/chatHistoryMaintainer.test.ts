/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import sinon from 'ts-sinon'
import { ChatHistoryMaintainer } from './chatHistoryMaintainer'
import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { Tab } from './util'
import * as Loki from 'lokijs'
import * as fs from 'fs'

/**
 * Helper function to create a mock tab with multiple conversations and messages
 * @param tabId The ID of the tab
 * @param numConversations Number of conversations to create
 * @param messagesPerConversation Number of messages per conversation
 * @returns A mock Tab object
 */
function createMockTabWithManyConversations(
    tabId: string,
    numConversations: number,
    messagesPerConversation: number
): Tab {
    const conversations = []

    for (let convIndex = 0; convIndex < numConversations; convIndex++) {
        const messages = []

        for (let msgIndex = 0; msgIndex < messagesPerConversation; msgIndex++) {
            // Add alternating prompt and answer messages
            if (msgIndex % 2 === 0) {
                messages.push({
                    type: 'prompt' as const,
                    body: `User message ${convIndex}-${msgIndex}`,
                })
            } else {
                messages.push({
                    type: 'answer' as const,
                    body: `Assistant response ${convIndex}-${msgIndex}`,
                })
            }
        }

        conversations.push({
            conversationId: `conv-${convIndex}`,
            clientType: 'test',
            messages: messages,
        })
    }

    return {
        historyId: tabId,
        isOpen: false,
        updatedAt: new Date(`2023-0${(tabId.charCodeAt(0) % 9) + 1}-01`), // Generate different dates based on tabId
        tabType: 'cwc',
        title: `Test Tab ${tabId}`,
        conversations: conversations,
    }
}

describe('ChatHistoryMaintainer', () => {
    let mockFeatures: Features
    let mockDb: Loki
    let historyMaintainer: ChatHistoryMaintainer
    let listDatabaseFilesStub: sinon.SinonStub
    let calculateAllHistorySizeStub: sinon.SinonStub
    let loadAllDbFilesStub: sinon.SinonStub
    let mockTab1: Tab
    let mockTab2: Tab
    let mockCollection1: {
        update: any
        remove: any
        find?: sinon.SinonStub<any[], any>
        findOne?: sinon.SinonStub<any[], any>
    }
    let mockCollection2: {
        update: any
        remove: any
        find?: sinon.SinonStub<any[], any>
        findOne?: sinon.SinonStub<any[], any>
    }
    let mockDb1: { saveDatabase: any; close: any; getCollection?: sinon.SinonStub<any[], any> }
    let mockDb2: { saveDatabase: any; close: any; getCollection?: sinon.SinonStub<any[], any> }

    beforeEach(() => {
        mockFeatures = {
            logging: {
                debug: sinon.stub(),
                warn: sinon.stub(),
                log: sinon.stub(),
                info: sinon.stub(),
                error: sinon.stub(),
            },
            runtime: {
                platform: 'node',
            },
            workspace: {
                fs: {
                    getServerDataDirPath: sinon.stub().returns('/tmp'),
                    getFileSize: sinon.stub().resolves({ size: 0 }),
                    mkdir: sinon.stub().resolves(undefined),
                    writeFile: sinon.stub().resolves(undefined),
                    readdir: sinon.stub().resolves([
                        { name: 'chat-history-1.json', isFile: () => true },
                        { name: 'chat-history-2.json', isFile: () => true },
                    ]),
                },
            },
        } as unknown as Features

        mockDb = {
            getCollection: sinon.stub(),
            close: sinon.stub(),
        } as unknown as Loki

        // Create mock tab with 20 conversations, each with 100 messages
        mockTab1 = createMockTabWithManyConversations('tab1', 20, 100)

        // Create a smaller mock tab for comparison
        mockTab2 = createMockTabWithManyConversations('tab2', 2, 10)

        // Create mock collections
        mockCollection1 = {
            find: sinon.stub().returns([mockTab1]),
            findOne: sinon.stub().returns(mockTab1),
            update: sinon.stub(),
            remove: sinon.stub(),
        }

        mockCollection2 = {
            find: sinon.stub().returns([mockTab2]),
            findOne: sinon.stub().returns(mockTab2),
            update: sinon.stub(),
            remove: sinon.stub(),
        }

        // Create mock databases
        mockDb1 = {
            getCollection: sinon.stub().returns(mockCollection1),
            saveDatabase: sinon.stub().callsArg(0),
            close: sinon.stub(),
        }

        mockDb2 = {
            getCollection: sinon.stub().returns(mockCollection2),
            saveDatabase: sinon.stub().callsArg(0),
            close: sinon.stub(),
        }

        // Create the history maintainer with test methods for easier mocking
        historyMaintainer = new ChatHistoryMaintainer(
            mockFeatures,
            '/tmp/.aws/amazonq/history',
            'chat-history-test.json',
            mockDb
        )

        // Mock the methods we need to test
        calculateAllHistorySizeStub = sinon.stub(historyMaintainer, 'calculateAllHistorySize' as any)
        calculateAllHistorySizeStub.onFirstCall().resolves(250 * 1024 * 1024) // First call: over the limit
        calculateAllHistorySizeStub.onSecondCall().resolves(250 * 1024 * 1024) // Second call: Start trimming, over the limit
        calculateAllHistorySizeStub.onThirdCall().resolves(140 * 1024 * 1024) // Third call: Finished triming, under the limit

        loadAllDbFilesStub = sinon.stub(historyMaintainer, 'loadAllDbFiles' as any).resolves(
            new Map([
                ['chat-history-1.json', { collection: mockCollection1, db: mockDb1 }],
                ['chat-history-2.json', { collection: mockCollection2, db: mockDb2 }],
            ])
        )
    })

    afterEach(() => {
        sinon.restore()
    })

    describe('trimHistoryToMaxSize', () => {
        it('should trim history until size is below the limit', async () => {
            // Call the method being tested
            await historyMaintainer.trimHistoryToMaxSize()

            // Verify workspace.fs.readdir was called
            assert.strictEqual(
                (mockFeatures.workspace.fs.readdir as sinon.SinonStub).called,
                true,
                'workspace.fs.readdir should be called'
            )

            // Verify loadAllDbFiles was called
            assert.strictEqual(loadAllDbFilesStub.callCount, 1, 'loadAllDbFiles should be called once')

            // Verify calculateAllHistorySize was called
            assert.strictEqual(
                calculateAllHistorySizeStub.callCount,
                3,
                'calculateAllHistorySize should be called three times'
            )

            // Verify update or remove operation was performed
            assert.strictEqual(
                mockCollection1.update.called,
                true,
                'Update should be called because collection has many messages and deletion cannot be done in one batch'
            )
            assert.strictEqual(
                mockCollection1.remove.called,
                false,
                'Remove should not be called because the number of messages under collection1 has exceeded the single trimming loop (messageBatchDeleteSizeForSingleTab * messageBatchDeleteIterationBeforeRecalculateDBSize)'
            )
            assert.strictEqual(mockCollection2.update.called, true, 'Update should be called for collection2')
            assert.strictEqual(
                mockCollection2.remove.called,
                true,
                'Remove should be called after all messages are deleted from the conversation'
            )

            // Verify database save operations
            assert.strictEqual(
                mockDb1.saveDatabase.called && mockDb2.saveDatabase.called,
                true,
                'SaveDatabase should be called'
            )

            // Verify database close operations
            assert.strictEqual(mockDb1.close.callCount, 1, 'Database1 close should be called')
            assert.strictEqual(mockDb2.close.callCount, 1, 'Database2 close should be called')
        })

        it('should handle already under limit case', async () => {
            // Override calculateAllHistorySize to return size under limit
            calculateAllHistorySizeStub.onFirstCall().resolves(100 * 1024 * 1024) // Under the limit

            // Call the method being tested
            await historyMaintainer.trimHistoryToMaxSize()

            // Verify calculateAllHistorySize was called just once
            assert.strictEqual(
                calculateAllHistorySizeStub.callCount,
                1,
                'calculateAllHistorySize should be called once'
            )
        })
    })

    describe('empty file deletion', () => {
        let unlinkStub: sinon.SinonStub
        let emptyCollection: any
        let emptyDb: any

        beforeEach(() => {
            unlinkStub = sinon.stub(fs.promises, 'unlink').resolves()

            // Create empty collection mock
            emptyCollection = {
                find: sinon.stub().returns([]),
                findOne: sinon.stub().returns(null),
                update: sinon.stub(),
                remove: sinon.stub(),
            }

            // Create empty database mock
            emptyDb = {
                getCollection: sinon.stub().returns(emptyCollection),
                saveDatabase: sinon.stub().callsArg(0),
                close: sinon.stub(),
            }
        })

        afterEach(() => {
            unlinkStub.restore()
        })

        it('should delete empty database files during loading', async () => {
            const deleteEmptyDbFilesStub = sinon.stub(historyMaintainer, 'deleteEmptyDbFiles' as any)

            // Call the original method through the stub
            await deleteEmptyDbFilesStub.wrappedMethod.call(historyMaintainer, [
                'chat-history-empty.json',
                'chat-history-another.json',
            ])

            assert.strictEqual(unlinkStub.callCount, 2, 'fs.unlink should be called twice')
            assert.strictEqual(unlinkStub.firstCall.args[0], '/tmp/.aws/amazonq/history/chat-history-empty.json')
            assert.strictEqual(unlinkStub.secondCall.args[0], '/tmp/.aws/amazonq/history/chat-history-another.json')
            assert.strictEqual(
                (mockFeatures.logging.info as sinon.SinonStub).callCount,
                2,
                'Success message should be logged twice'
            )
        })

        it('should not delete current workspace database even if empty', async () => {
            const deleteEmptyDbFilesStub = sinon.stub(historyMaintainer, 'deleteEmptyDbFiles' as any)

            // Call deleteEmptyDbFiles with current workspace DB name
            // The current workspace DB name is 'chat-history-test.json' as set in the constructor
            await deleteEmptyDbFilesStub.wrappedMethod.call(historyMaintainer, ['chat-history-test.json'])

            assert.strictEqual(unlinkStub.callCount, 0, 'fs.unlink should not be called for current workspace DB')
        })

        it('should handle file deletion errors gracefully', async () => {
            unlinkStub.rejects(new Error('Permission denied'))
            const deleteEmptyDbFilesStub = sinon.stub(historyMaintainer, 'deleteEmptyDbFiles' as any)

            // Should not throw error
            await deleteEmptyDbFilesStub.wrappedMethod.call(historyMaintainer, ['chat-history-empty.json'])

            assert.strictEqual(unlinkStub.callCount, 1, 'fs.unlink should be called once')
            assert.strictEqual((mockFeatures.logging.error as sinon.SinonStub).called, true, 'Error should be logged')
        })
    })
})
