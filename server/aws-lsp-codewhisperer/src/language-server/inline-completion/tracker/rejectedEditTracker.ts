/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Logging } from '@aws/language-server-runtimes/server-interface'
import { distance } from 'fastest-levenshtein'

/**
 * Interface for a rejected edit entry
 */
export interface RejectedEditEntry {
    content: string
    timestamp: number
    documentUri: string
    position: { line: number; character: number }
}

/**
 * Configuration for the RejectedEditTracker
 */
export interface RejectedEditTrackerConfig {
    maxEntries: number
    similarityThreshold: number
}

/**
 * Default configuration for RejectedEditTracker
 */
export const DEFAULT_REJECTED_EDIT_TRACKER_CONFIG: RejectedEditTrackerConfig = {
    maxEntries: 50,
    similarityThreshold: 1.0, // 100% similarity - only reject exact matches
}

/**
 * Longest edit, after normalization, that is compared by edit distance. Each suggestion is compared with up to
 * maxEntries rejections, so this keeps the check to a few milliseconds per comparison. Longer edits only match an
 * identical rejection.
 */
export const MAX_SIMILARITY_INPUT_LENGTH = 2_000

/**
 * Tracks rejected edit predictions to avoid showing similar edits again
 */
export class RejectedEditTracker {
    private static _instance?: RejectedEditTracker
    private rejectedEdits: RejectedEditEntry[] = []

    constructor(
        private readonly log: Logging,
        private readonly config: RejectedEditTrackerConfig = DEFAULT_REJECTED_EDIT_TRACKER_CONFIG
    ) {
        this.log.debug(
            `[REJECTED_EDIT_TRACKER] Initializing with config: maxEntries=${config.maxEntries}, similarityThreshold=${config.similarityThreshold}`
        )
    }

    public static getInstance(log: Logging, config?: RejectedEditTrackerConfig): RejectedEditTracker {
        if (!RejectedEditTracker._instance) {
            RejectedEditTracker._instance = new RejectedEditTracker(log, config)
        }
        return RejectedEditTracker._instance
    }

    public recordRejectedEdit(edit: RejectedEditEntry): void {
        this.rejectedEdits.unshift(edit)
        this.enforceMaxEntries()
        this.log.debug(
            `[REJECTED_EDIT_TRACKER] Recorded rejected edit: ${edit.content.substring(0, 20)}... at ${edit.documentUri}:${edit.position.line}:${edit.position.character}`
        )
    }

    /**
     * Checks if an edit is similar to a previously rejected edit
     */
    public isSimilarToRejected(content: string, documentUri: string): boolean {
        const relevantRejections = this.rejectedEdits.filter(edit => edit.documentUri === documentUri)
        const normalizedContent = this.normalizeEditContent(content)

        for (const rejection of relevantRejections) {
            const normalizedRejection = this.normalizeEditContent(rejection.content)

            const similarity = this.calculateSimilarity(normalizedContent, normalizedRejection)
            if (similarity >= this.config.similarityThreshold) {
                this.log.debug(
                    `[REJECTED_EDIT_TRACKER] Found similar rejected edit with similarity ${similarity.toFixed(2)}`
                )
                return true
            }
        }

        return false
    }

    /**
     * Normalizes edit content for comparison by:
     * - Removing line numbers from diff format
     * - Normalizing line endings
     * - Trimming whitespace
     * - Removing common indentation
     */
    private normalizeEditContent(content: string): string {
        // Remove line numbers from diff format (e.g., "@@ -1,3 +1,4 @@")
        let normalized = content.replace(/@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@/g, '')

        // Normalize line endings
        normalized = normalized.replace(/\r\n/g, '\n')

        // Split into lines for further processing
        const lines = normalized.split('\n')

        // Remove leading/trailing empty lines
        while (lines.length > 0 && lines[0].trim() === '') lines.shift()
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()

        // Remove common indentation
        if (lines.length > 0) {
            // Find minimum indentation across non-empty lines
            const minIndent =
                lines
                    .filter(line => line.trim().length > 0)
                    .reduce((min, line) => {
                        const indent = line.length - line.trimStart().length
                        return indent < min ? indent : min
                    }, Infinity) || 0

            // Remove that indentation from all lines
            if (minIndent > 0 && minIndent !== Infinity) {
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].length >= minIndent) {
                        lines[i] = lines[i].substring(minIndent)
                    }
                }
            }
        }

        return lines.join('\n').trim()
    }

    private calculateSimilarity(str1: string, str2: string): number {
        if (str1 === str2) return 1.0
        if (str1.length === 0 || str2.length === 0) return 0.0

        const maxLength = Math.max(str1.length, str2.length)
        if (maxLength > MAX_SIMILARITY_INPUT_LENGTH) return 0.0

        const levenshteinDistance = distance(str1, str2)

        return 1.0 - levenshteinDistance / maxLength
    }

    private enforceMaxEntries(): void {
        if (this.rejectedEdits.length > this.config.maxEntries) {
            const removed = this.rejectedEdits.splice(this.config.maxEntries)
            this.log.debug(`[REJECTED_EDIT_TRACKER] Removed ${removed.length} old entries due to max entries limit`)
        }
    }

    public clear(): void {
        this.rejectedEdits = []
        this.log.debug(`[REJECTED_EDIT_TRACKER] Cleared all rejected edits`)
    }

    public getCount(): number {
        return this.rejectedEdits.length
    }

    public dispose(): void {
        this.clear()
        this.log.debug(`[REJECTED_EDIT_TRACKER] Disposed`)
    }
}
