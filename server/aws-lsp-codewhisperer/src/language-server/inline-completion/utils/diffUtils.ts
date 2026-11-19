/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { parsePatch, Hunk, createTwoFilesPatch } from 'diff'
import { CodeWhispererSupplementalContext, CodeWhispererSupplementalContextItem } from '../../../shared/models/model'
import { trimSupplementalContexts } from '../../../shared/supplementalContextUtil/supplementalContextUtil'
import { Position, TextDocument, Range } from '@aws/language-server-runtimes/protocol'
import { SuggestionType } from '../../../shared/codeWhispererService'
import { getPrefixSuffixOverlap, truncateOverlapWithRightContext } from './mergeRightUtils'

/**
 * Generates a unified diff format between old and new file contents
 *
 * @param oldFilePath - Path to the old version of the file
 * @param newFilePath - Path to the new version of the file
 * @param oldContent - Content of the old version
 * @param newContent - Content of the new version
 * @param oldTimestamp - Timestamp of the old version
 * @param newTimestamp - Timestamp of the new version
 * @param contextSize - Number of context lines to include in the diff
 * @returns Unified diff string
 */
export function generateUnifiedDiffWithTimestamps(
    oldFilePath: string,
    newFilePath: string,
    oldContent: string,
    newContent: string,
    oldTimestamp: number,
    newTimestamp: number,
    contextSize: number = 3
): string {
    const patchResult = createTwoFilesPatch(
        oldFilePath,
        newFilePath,
        oldContent,
        newContent,
        String(oldTimestamp),
        String(newTimestamp),
        { context: contextSize }
    )

    // Remove unused headers
    const lines = patchResult.split('\n')
    if (lines.length >= 2 && lines[0].startsWith('Index:')) {
        lines.splice(0, 2)
        return lines.join('\n')
    }

    return patchResult
}

/**
 * Represents a snapshot content of a file at a specific point in time
 */
export interface FileSnapshotContent {
    /** URI of the file */
    readonly filePath: string
    /** Content of the file */
    readonly content: string
    /** Timestamp when the snapshot was taken */
    readonly timestamp: number
}

/**
 * Generates supplemental contexts from snapshot contents and current content
 *
 * @param filePath - Path to the file
 * @param currentContent - Current content of the file
 * @param snapshotContents - List of snapshot contents sorted by timestamp (oldest first)
 * @param maxContexts - Maximum number of supplemental contexts to return
 * @returns CodeWhispererSupplementalContext object containing diffs between snapshots and current content
 */
export function generateDiffContexts(
    filePath: string,
    currentContent: string,
    snapshotContents: FileSnapshotContent[],
    maxContexts: number
): CodeWhispererSupplementalContext {
    if (snapshotContents.length === 0) {
        return {
            isUtg: false,
            isProcessTimeout: false,
            supplementalContextItems: [],
            contentsLength: 0,
            latency: 0,
            strategy: 'recentEdits',
        }
    }

    const startTime = Date.now()
    const supplementalContextItems: CodeWhispererSupplementalContextItem[] = []
    const currentTimestamp = Date.now()

    // Process snapshots from newest to oldest
    for (let i = snapshotContents.length - 1; i >= 0; i--) {
        const snapshot = snapshotContents[i]
        try {
            const unifiedDiff = generateUnifiedDiffWithTimestamps(
                snapshot.filePath,
                filePath,
                snapshot.content,
                currentContent,
                snapshot.timestamp,
                currentTimestamp
            )

            // Only add non-empty diffs
            if (unifiedDiff.trim().length > 0) {
                supplementalContextItems.push({
                    filePath: snapshot.filePath,
                    content: unifiedDiff,
                    score: 1.0, // Default score for recent edits
                })
            }
        } catch (err) {
            // TODO: logging
            // console.error(`Failed to generate diff: ${err}`)
        }
    }

    const trimmedContextItems = trimSupplementalContexts(supplementalContextItems, maxContexts)
    const contentsLength = trimmedContextItems.reduce((sum, ctx) => sum + ctx.content.length, 0)
    const latency = Date.now() - startTime

    return {
        isUtg: false,
        isProcessTimeout: false,
        supplementalContextItems: trimmedContextItems,
        contentsLength,
        latency,
        strategy: 'recentEdits',
    }
}

export function getAddedAndDeletedLines(unifiedDiff: string): { addedLines: string[]; deletedLines: string[] } {
    const lines = unifiedDiff.split('\n')
    const addedLines = lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1))
    const deletedLines = lines
        .filter(line => line.startsWith('-') && !line.startsWith('---'))
        .map(line => line.slice(1))
    return {
        addedLines,
        deletedLines,
    }
}

/**
 * Calculate character differences between added and deleted text blocks using LCS
 */
export interface CharDiffResult {
    charactersAdded: number
    charactersRemoved: number
}

/**
 * Largest LCS table, in cells, that is computed exactly (about 10 ms). The table grows with the product of both
 * lengths, so larger inputs are approximated.
 */
export const MAX_LCS_CELLS = 1_000_000

/**
 * Find longest common subsequence length between two strings, in O(m * n) time and O(n) memory
 */
function lcsLength(str1: string, str2: string): number {
    let previous = new Uint32Array(str2.length + 1)
    let current = new Uint32Array(str2.length + 1)

    for (let i = 1; i <= str1.length; i++) {
        for (let j = 1; j <= str2.length; j++) {
            if (str1[i - 1] === str2[j - 1]) {
                current[j] = previous[j - 1] + 1
            } else {
                current[j] = Math.max(previous[j], current[j - 1])
            }
        }
        ;[previous, current] = [current, previous]
    }

    return previous[str2.length]
}

/**
 * Calculate character differences between added and deleted blocks
 */
export function getCharacterDifferences(addedLines: string[], deletedLines: string[]): CharDiffResult {
    const addedText = addedLines.join('\n')
    const deletedText = deletedLines.join('\n')

    if (addedText.length === 0) {
        return { charactersAdded: 0, charactersRemoved: deletedText.length }
    }

    if (deletedText.length === 0) {
        return { charactersAdded: addedText.length, charactersRemoved: 0 }
    }

    // A common prefix and suffix are always part of the LCS, so only the text between them needs the table
    const shorterLength = Math.min(addedText.length, deletedText.length)
    let prefixLength = 0
    while (prefixLength < shorterLength && addedText[prefixLength] === deletedText[prefixLength]) {
        prefixLength++
    }
    let suffixLength = 0
    while (
        suffixLength < shorterLength - prefixLength &&
        addedText[addedText.length - 1 - suffixLength] === deletedText[deletedText.length - 1 - suffixLength]
    ) {
        suffixLength++
    }

    const addedMiddle = addedText.slice(prefixLength, addedText.length - suffixLength)
    const deletedMiddle = deletedText.slice(prefixLength, deletedText.length - suffixLength)

    // Above the cap, count the middle as entirely replaced
    const middleLcsLength =
        addedMiddle.length * deletedMiddle.length <= MAX_LCS_CELLS ? lcsLength(deletedMiddle, addedMiddle) : 0
    const lcsLen = prefixLength + suffixLength + middleLcsLength

    return {
        charactersAdded: addedText.length - lcsLen,
        charactersRemoved: deletedText.length - lcsLen,
    }
}

export function processEditSuggestion(
    unifiedDiff: string,
    triggerPosition: Position,
    document: TextDocument,
    rightContext: string
): { suggestionContent: string; type: SuggestionType } {
    // Assume it's an edit if anything goes wrong, at the very least it will not be rendered incorrectly
    let diffCategory: ReturnType<typeof categorizeUnifieddiff> = 'edit'
    try {
        diffCategory = categorizeUnifieddiff(unifiedDiff, triggerPosition.line)
    } catch (e) {
        // We dont have logger here....
        diffCategory = 'edit'
    }

    if (diffCategory === 'addOnly') {
        const preprocessAdd = extractAdditions(unifiedDiff)
        const leftContextAtTriggerLine = document.getText(
            Range.create(Position.create(triggerPosition.line, 0), triggerPosition)
        )
        /**
         * SHOULD NOT remove the entire overlapping string, the way inline suggestion prefix matching work depends on where it triggers
         * For example (^ note where user triggers)
         * console.lo
         *        ^
         * if LSP returns `g('foo')` instead of `.log()` the suggestion will be discarded because prefix doesnt match
         */
        const processedAdd = removeOverlapCodeFromSuggestion(leftContextAtTriggerLine, preprocessAdd)
        const mergedWithRightContext = truncateOverlapWithRightContext(rightContext, processedAdd)
        return {
            suggestionContent: mergedWithRightContext,
            type: SuggestionType.COMPLETION,
        }
    } else {
        return {
            suggestionContent: unifiedDiff,
            type: SuggestionType.EDIT,
        }
    }
}

// TODO: MAKE it a class and abstract all the business parsing logic within the classsssss so we dont need to redo the same thing again and again
interface UnifiedDiff {
    linesWithoutHeaders: string[]
    firstMinusIndex: number
    firstPlusIndex: number
    minusIndexes: number[]
    plusIndexes: number[]
    hunk: Hunk
}

// TODO: refine
export function readUdiff(unifiedDiff: string): UnifiedDiff {
    let hunk: Hunk | undefined
    try {
        const patches = parsePatch(unifiedDiff)
        if (patches.length !== 1) {
            throw new Error(`Provided unified diff from has 0 or more than 1 patches`)
        }
        hunk = patches[0].hunks[0]
        if (!hunk) {
            throw new Error(`Null hunk`)
        }
    } catch (e) {
        throw e
    }

    // TODO: Should use hunk instead of parsing manually
    const lines = unifiedDiff.split('\n')
    const headerEndIndex = lines.findIndex(l => l.startsWith('@@'))
    if (headerEndIndex === -1) {
        throw new Error('not able to parse')
    }
    const relevantLines = lines.slice(headerEndIndex + 1)
    if (relevantLines.length === 0) {
        throw new Error('not able to parse')
    }

    const minusIndexes: number[] = []
    const plusIndexes: number[] = []
    for (let i = 0; i < relevantLines.length; i++) {
        const l = relevantLines[i]
        if (l.startsWith('-')) {
            minusIndexes.push(i)
        } else if (l.startsWith('+')) {
            plusIndexes.push(i)
        }
    }

    const firstMinusIndex = relevantLines.findIndex(s => s.startsWith('-'))
    const firstPlusIndex = relevantLines.findIndex(s => s.startsWith('+'))

    // TODO: Comment these out as they are used for a different version of addonly type determination logic in case the current implementation doesn't work.
    // Could remove later if we are sure current imple works.
    /**
     * Concatenate all contiguous added lines (i.e., unbroken sequence of "+"s).
     * Exclude all newlines when concatenating, so we get a single line representing the new text
     */
    // let singleLine = ''
    // let prev: number | undefined
    // for (const idx of plusIndexes) {
    //     if (!prev || idx === prev + 1) {
    //         const removedPlus = relevantLines[idx].substring(1)
    //         const removedStartNewline = trimStartNewline(removedPlus)
    //         singleLine += removedStartNewline
    //     } else {
    //         break
    //     }
    // }

    return {
        linesWithoutHeaders: relevantLines,
        firstMinusIndex: firstMinusIndex,
        firstPlusIndex: firstPlusIndex,
        minusIndexes: minusIndexes,
        plusIndexes: plusIndexes,
        hunk: hunk,
    }
}

// Theoretically, we should always pass userTriggerAtLine, keeping it nullable for easier testing for now
export function categorizeUnifieddiff(
    unifiedDiff: string,
    userTriggerAtLine?: number
): 'addOnly' | 'deleteOnly' | 'edit' {
    try {
        const d = readUdiff(unifiedDiff)
        const hunk = d.hunk
        const firstMinusIndex = d.firstMinusIndex
        const firstPlusIndex = d.firstPlusIndex
        const diffWithoutHeaders = d.linesWithoutHeaders

        // Shouldn't be the case but if there is no - nor +, assume it's an edit
        if (firstMinusIndex === -1 && firstPlusIndex === -1) {
            return 'edit'
        }

        // If first "EDIT" line is not where users trigger, it must be EDIT
        // Note hunk.start is 1 based index
        const firstLineEdited = hunk.oldStart - 1 + Math.min(...d.minusIndexes, ...d.plusIndexes)
        if (userTriggerAtLine !== undefined && userTriggerAtLine !== firstLineEdited) {
            return 'edit'
        }

        // Naive case, only +
        if (firstMinusIndex === -1 && firstPlusIndex !== -1) {
            return 'addOnly'
        }

        // Naive case, only -
        if (firstMinusIndex !== -1 && firstPlusIndex === -1) {
            return 'deleteOnly'
        }

        const minusIndexes = d.minusIndexes
        const plusIndexes = d.plusIndexes

        // If there are multiple (> 1) non empty '-' lines, it must be edit
        const c = minusIndexes.reduce((acc: number, cur: number): number => {
            if (diffWithoutHeaders[cur].trim().length > 0) {
                return acc++
            }

            return acc
        }, 0)

        if (c > 1) {
            return 'edit'
        }

        // If last '-' line is followed by '+' block, it could be addonly
        if (plusIndexes[0] === minusIndexes[minusIndexes.length - 1] + 1) {
            /**
            -------------------------------
            -  return 
            +  return a - b;
            -------------------------------
            commonPrefix = "return "
            minusLinesDelta = ""

            --------------------------------
            -\t\t\t
            +\treturn a - b;
            --------------------------------
            commonPrefix = "\t"
            minusLinesDelta = "\t\t"

             * 
             * 
             * 
             */
            const minusLine = diffWithoutHeaders[minusIndexes[minusIndexes.length - 1]].substring(1)
            const pluscode = extractAdditions(unifiedDiff)

            // If minusLine subtract the longest common substring of minusLine and plugcode and it's empty string, it's addonly
            const commonPrefix = longestCommonPrefix(minusLine, pluscode)
            const minusLinesDelta = minusLine.substring(commonPrefix.length)
            if (minusLinesDelta.trim().length === 0) {
                return 'addOnly'
            }

            /**
            -------------------------------
             -  return a * b;
             +  return a * b * c;
            -------------------------------
            commonPrefix = "return a * b"
            minusLinesDelta = ";"
            pluscodeDelta = " * c;"
             *
             */
            const pluscodeDelta = pluscode.substring(commonPrefix.length)
            if (pluscodeDelta.endsWith(minusLinesDelta)) {
                return 'addOnly'
            }
        }

        return 'edit'
    } catch (e) {
        return 'edit'
    }
}

// TODO: current implementation here assumes service only return 1 chunk of edits (consecutive lines) and hacky
export function extractAdditions(unifiedDiff: string): string {
    const lines = unifiedDiff.split('\n')
    let completionSuggestion = ''
    let isInAdditionBlock = false

    for (const line of lines) {
        // Skip diff headers (files)
        if (line.startsWith('+++') || line.startsWith('---')) {
            continue
        }

        // Skip hunk headers (@@ lines)
        if (line.startsWith('@@')) {
            continue
        }

        // Handle additions
        if (line.startsWith('+')) {
            completionSuggestion += line.substring(1) + '\n'
            isInAdditionBlock = true
        } else if (isInAdditionBlock && !line.startsWith('+')) {
            // End of addition block
            isInAdditionBlock = false
        }
    }

    // Remove trailing newline
    return completionSuggestion.trimEnd()
}

/**
 *
 * example
 * code = 'return'
 * suggestion = 'return a + b;'
 * output = ' a + b;'
 */
export function removeOverlapCodeFromSuggestion(code: string, suggestion: string): string {
    const suggestionLines = suggestion.split('\n')
    const firstLineSuggestion = suggestionLines[0]

    // Find the common string in code surfix and prefix of suggestion
    const s = getPrefixSuffixOverlap(code, firstLineSuggestion)

    // Remove overlap s from suggestion
    return suggestion.substring(s.length)
}

export function longestCommonPrefix(str1: string, str2: string): string {
    const minLength = Math.min(str1.length, str2.length)
    let prefix = ''

    for (let i = 0; i < minLength; i++) {
        if (str1[i] === str2[i]) {
            prefix += str1[i]
        } else {
            break
        }
    }

    return prefix
}

// TODO: They are used for a different version of addonly type determination logic in case the current implementation doesn't work.
// Could remove later if we are sure current impl works.
// function trimStartNewline(str: string): string {
//     return str.replace(/^[\n\r]+/, '')
// }

// function hasOneContiguousInsert(original: string, changed: string) {
//     const delta = changed.length - original.length
//     if (delta <= 0) {
//         // Changed string must be longer
//         return false
//     }

//     let p, s
//     for (p = 0; original[p] === changed[p] && p < original.length; ++p);
//     for (s = original.length - 1; original[s] === changed[s + delta] && s >= 0; --s);

//     return p === s + 1
// }
