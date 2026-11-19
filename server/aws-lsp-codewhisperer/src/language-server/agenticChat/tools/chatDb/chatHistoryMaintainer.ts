/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as Loki from 'lokijs'
import * as fs from 'fs'
import * as path from 'path'
import { Features } from '@aws/language-server-runtimes/server-interface/server'
import {
    FileSystemAdapter,
    Tab,
    TabWithDbMetadata,
    TabCollection,
    initializeHistoryPriorityQueue,
    getOldestMessageTimestamp,
    DbReference,
    calculateDatabaseSize,
} from './util'
import { PriorityQueue } from 'typescript-collections'

// Maximum history file size across all workspaces, 200MB
export const maxHistorySizeInBytes = 200 * 1024 * 1024
// 75% of the max size, 150MB
export const targetHistorySizeInBytes = 150 * 1024 * 1024
/**
 * The combination of batchDeleteIterations and messagePairPerBatchDelete can heavily impact the
 * latency of trimming history since calculating the history file size is slow. We can tune these numbers according to the average message size
 */
// Number of batch operations to perform before recalculating the total history size
// Higher values improve performance but may result in more data being deleted than necessary
export const batchDeleteIterations = 200
// Number of message pairs to delete from a single tab in each batch operation before re-evaluating the oldest messages across all workspaces
// Higher values improve performance but may cause more recent messages to be deleted unnecessarily
export const messagePairPerBatchDelete = 5
// In each iteration, we calculate the total history size and try to delete [messagePairPerBatchDelete * batchDeleteIterations] messages
export const maxTrimIterations = 100

/**
 * ChatHistoryMaintainer is responsible for maintaining the chat history database,
 * including trimming history when it exceeds size limits.
 */
export class ChatHistoryMaintainer {
    #features: Features
    #dbDirectory: string
    #dbName: string
    #db: Loki

    constructor(features: Features, dbDirectory: string, dbName: string, db: Loki) {
        this.#features = features
        this.#dbDirectory = dbDirectory
        this.#dbName = dbName
        this.#db = db
    }

    /**
     * If the sum of all history file size exceeds the limit, start trimming the oldest conversation
     * across all the workspaces until the folder size is below maxAfterTrimHistorySizeInBytes.
     */
    async trimHistoryToMaxSize() {
        // Get the size of all history DB files
        const historyTotalSizeInBytes = await this.calculateAllHistorySize()
        this.#features.logging.info(
            `Current history total size: ${historyTotalSizeInBytes} Bytes, max allowed: ${maxHistorySizeInBytes} Bytes`
        )

        // If we're under the limit, no need to trim
        if (historyTotalSizeInBytes <= maxHistorySizeInBytes) {
            return
        }
        this.#features.logging.info(`History total size exceeds limit, trimming history`)

        const trimStart = performance.now()
        await this.trimHistoryForAllWorkspaces()
        const trimEnd = performance.now()
        this.#features.logging.info(`Trimming history took ${trimEnd - trimStart} ms`)
    }

    /**
     * Trims chat history across all workspaces to reduce storage size.
     *
     * This method:
     * 1. Loads all database files from the history directory
     * 2. Creates a priority queue of tabs sorted by oldest message date
     * 3. Iteratively removes oldest messages in batches until total size is below target
     * 4. Saves changes to databases and closes connections when complete
     *
     * Uses batch deletion to minimize file size recalculations and prioritizes
     * removing the oldest messages first across all workspaces.
     */
    private async trimHistoryForAllWorkspaces() {
        // Load all databases
        const allDbFiles = (await this.listDatabaseFiles()).map(file => file.name)
        // DB name to {collection, db} Map
        const allDbsMap = await this.loadAllDbFiles(allDbFiles)

        this.#features.logging.info(`Loaded ${allDbsMap.size} databases from ${this.#dbDirectory} for history trimming`)
        if (allDbsMap.size < allDbFiles.length) {
            this.#features.logging.warn(
                `${allDbFiles.length - allDbsMap.size} DB files can't be loaded or have empty tab collection, will skip them when calculating history size`
            )
        }

        const tabQueue = initializeHistoryPriorityQueue()

        // Add tabs to the queue(with ordering, the tab which contains the oldest message first)
        for (const [dbName, dbRef] of allDbsMap.entries()) {
            const tabCollection = dbRef.collection
            if (!tabCollection) continue

            const tabs = tabCollection.find()
            for (const tab of tabs) {
                const oldestMessageDate = getOldestMessageTimestamp(tab)
                tabQueue.add({
                    tab: tab,
                    collection: tabCollection,
                    dbName: dbName,
                    oldestMessageDate: oldestMessageDate,
                })
            }
        }

        // Keep trimming until we're under the target size
        await this.runHistoryTrimmingLoop(tabQueue, allDbsMap)

        this.closeAllDbs(allDbsMap)
    }

    /**
     * Calculates the total size of all history database files in the directory
     * @returns The total size of all database files in bytes
     */
    private async calculateAllHistorySize(dbFiles?: string[]): Promise<number> {
        if (!dbFiles) {
            dbFiles = (await this.listDatabaseFiles()).map(file => file.name)
        }

        // Calculate the total size of all database files
        let totalSize = 0
        for (const file of dbFiles) {
            const filePath = path.join(this.#dbDirectory, file)
            let fileSize
            try {
                fileSize = await calculateDatabaseSize(this.#features, filePath)
            } catch (err) {
                this.#features.logging.error(`Error getting db file size: ${err}`)
                fileSize = 0
            }
            totalSize += fileSize
        }

        return totalSize
    }

    /**
     * Lists all database files in the history directory
     * @returns Promise that resolves to an array of database file entries
     */
    private async listDatabaseFiles() {
        try {
            // List all files in the directory using readdir
            const dirEntries = await this.#features.workspace.fs.readdir(this.#dbDirectory)

            // Filter for database files (they should follow the pattern chat-history-*.json)
            return dirEntries.filter(
                entry => entry.isFile() && entry.name.startsWith('chat-history-') && entry.name.endsWith('.json')
            )
        } catch (err) {
            this.#features.logging.error(`Error listing database files: ${err}`)
            return []
        }
    }

    /**
     * Executes the main trimming loop that iteratively removes oldest messages until
     * the total database size is below the target threshold.
     *
     * The loop continues until one of these conditions is met:
     * 1. The total size is reduced below the target threshold
     * 2. Maximum iteration count is reached (to prevent infinite loops)
     *
     * Each iteration performs a batch of deletions to minimize size recalculations.
     *
     * @param tabQueue Priority queue of tabs sorted by oldest message date
     * @param allDbsMap Map of database names to their collection and DB references
     */
    private async runHistoryTrimmingLoop(
        tabQueue: PriorityQueue<TabWithDbMetadata>,
        allDbsMap: Map<string, DbReference>
    ) {
        let iterationCount = 0
        while (!tabQueue.isEmpty()) {
            // Check current total size
            const totalSize = await this.calculateAllHistorySize(Array.from(allDbsMap.keys()))

            // If we're under the target size, we're done
            if (totalSize <= targetHistorySizeInBytes) {
                this.#features.logging.info(
                    `History size ${totalSize} bytes is below the threshold ${maxHistorySizeInBytes}`
                )
                break
            }
            // Infinite loop protection
            if (++iterationCount > maxTrimIterations) {
                this.#features.logging.warn(
                    `Exceeded max iteration count (${maxTrimIterations}) when trimming history, current total size: ${totalSize}`
                )
                break
            }

            // Do a batch deletion so that we don't re-calculate the size for every deletion,
            const updatedDbs = this.batchDeleteMessagePairs(tabQueue)

            await this.saveUpdatedDbs(allDbsMap, updatedDbs)
        }
    }

    /**
     * Performs batch deletion of message pairs from tabs in the priority queue.
     *
     * Processes the tabs from the top of the queue, removing the oldest message pairs
     * from each tab up to a configured limit. Tabs with remaining messages are re-added
     * to the queue with updated timestamps, while empty tabs are removed completely.
     *
     * @param tabQueue Priority queue of tabs sorted by oldest message date
     * @returns Set of database names that were modified and need to be saved
     */
    private batchDeleteMessagePairs(tabQueue: PriorityQueue<TabWithDbMetadata>): Set<string> {
        let updatedDbs = new Set<string>()
        for (let i = 0; i < batchDeleteIterations / 2; i++) {
            const queueItem = tabQueue.dequeue()
            const tab = queueItem?.tab
            const collection = queueItem?.collection
            const dbName = queueItem?.dbName
            if (!tab || !collection || !dbName) break

            // Start deleting old messages
            updatedDbs.add(dbName)

            // Remove messages under a tab, until reaching the batchDeleteSize or the Tab is empty
            for (let pairsRemoved = 0; pairsRemoved < messagePairPerBatchDelete; pairsRemoved++) {
                if (!this.removeOldestMessagePairFromTab(tab)) {
                    break
                }
            }

            if (!tab.conversations || tab.conversations.length === 0) {
                // If the tab has no conversations left, remove it
                collection.remove(tab)
            } else {
                collection.update(tab)
                // Re-add the tab to the queue with updated oldest date
                const newOldestDate = getOldestMessageTimestamp(tab)
                tabQueue.enqueue({ tab: tab, collection, dbName: dbName, oldestMessageDate: newOldestDate })
            }
        }
        return updatedDbs
    }

    // Save the updated database if it's not the current one, the current db should have autosave enabled
    private async saveUpdatedDbs(allDbsMap: Map<string, DbReference>, updatedDbs: Set<string>) {
        for (const [dbName, dbRef] of allDbsMap.entries()) {
            if (updatedDbs.has(dbName)) {
                this.#features.logging.debug(`Removed old messages from ${dbName}, saving changes`)
                try {
                    await this.saveDatabase(dbRef.db, dbName)
                } catch (err) {
                    this.#features.logging.error(`Error saving database ${dbName}: ${err}`)
                }
            }
        }
    }

    // Close the databases except the current workspace DB
    private closeAllDbs(allDbsMap: Map<string, DbReference>) {
        for (const [dbName, dbRef] of allDbsMap.entries()) {
            if (dbName !== this.#dbName) {
                dbRef.db.close()
            }
        }
    }

    /**
     * Deletes empty database files from the filesystem
     * @param emptyDbFiles Array of database file names that are empty
     */
    private async deleteEmptyDbFiles(emptyDbFiles: string[]) {
        for (const dbFile of emptyDbFiles) {
            if (dbFile === this.#dbName) {
                // Never delete the current workspace database
                continue
            }

            try {
                const filePath = path.join(this.#dbDirectory, dbFile)
                await fs.promises.unlink(filePath)
                this.#features.logging.info(`Deleted empty database file: ${dbFile}`)
            } catch (err) {
                this.#features.logging.error(`Error deleting empty database file ${dbFile}: ${err}`)
            }
        }
    }

    /**
     * Safely saves a database with proper error handling
     * @param db The Loki database instance to save
     * @param dbName The name of the database for logging purposes
     * @returns Promise that resolves when save completes or rejects on error
     */
    private async saveDatabase(db: Loki, dbName: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            db.saveDatabase(err => {
                if (err) {
                    reject(err)
                } else {
                    resolve()
                }
            })
        })
    }

    private async loadAllDbFiles(allDbFiles: string[]) {
        const allDbsMap = new Map<string, DbReference>()
        for (const dbFile of allDbFiles) {
            try {
                if (dbFile === this.#dbName) {
                    // Current workspace DB
                    const collection = this.#db.getCollection<Tab>(TabCollection)
                    allDbsMap.set(dbFile, { collection: collection, db: this.#db })
                    continue
                }

                const db = new Loki(dbFile, {
                    adapter: new FileSystemAdapter(this.#features.workspace, this.#dbDirectory),
                    persistenceMethod: 'fs',
                })
                await new Promise<void>(resolve => {
                    db.loadDatabase({}, () => resolve())
                })
                const collection = db.getCollection<Tab>(TabCollection)

                if (!this.isEmptyCollection(collection)) {
                    allDbsMap.set(dbFile, { collection: collection, db: db })
                } else {
                    this.#features.logging.debug(`Empty database file found: ${dbFile}, will be deleted`)
                    db.close()
                    await this.deleteEmptyDbFiles([dbFile])
                }
            } catch (err) {
                this.#features.logging.error(`Error loading DB file ${dbFile}: ${err}`)
            }
        }
        return allDbsMap
    }

    /**
     * Checks if a collection is null or empty
     * @param collection The collection to check
     * @returns True if the collection is null or empty, false otherwise
     */
    private isEmptyCollection(collection: Collection<Tab>): boolean {
        return collection === undefined || collection.findOne() === null
    }

    /**
     * Remove the oldest message pair, based on assumptions:
     * 1. The messages are always stored in pairs(prompt, answer)
     * 2. The messages are always stored in chronological order(new messages are added to the tail of the list)
     * @returns True if successfully trimmed the history.
     */
    private removeOldestMessagePairFromTab(tabData: Tab): boolean {
        if (!tabData.conversations || tabData.conversations.length === 0) {
            this.#features.logging.debug(`No conversations found in tab ${tabData.historyId}`)
            return false
        }

        const conversation = tabData.conversations[0]

        // Remove messages in pairs from the beginning
        if (conversation.messages?.length > 2) {
            conversation.messages.splice(0, 2)
        } else {
            // Remove the entire conversation if it has few messages
            tabData.conversations.splice(0, 1)
        }
        return true
    }
}
