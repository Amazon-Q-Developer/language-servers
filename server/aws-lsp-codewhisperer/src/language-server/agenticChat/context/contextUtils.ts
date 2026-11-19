import { getUserHomeDir } from '@aws/lsp-core/out/util/path'
import * as path from 'path'
import { sanitizeFilename } from '@aws/lsp-core/out/util/text'
import { RelevantTextDocumentAddition } from './agenticChatTriggerContext'
import { FileDetails, FileList } from '@aws/language-server-runtimes/server-interface'
import { ContextCommandItem } from 'local-indexing'
export interface ContextInfo {
    pinnedContextCount: {
        fileContextCount: number
        folderContextCount: number
        promptContextCount: number
        codeContextCount: number
    }
    contextCount: {
        fileContextCount: number
        folderContextCount: number
        promptContextCount: number
        activeRuleContextCount: number
        totalRuleContextCount: number
        codeContextCount: number
    }
    contextLength: {
        fileContextLength: number
        ruleContextLength: number
        promptContextLength: number
        codeContextLength: number
    }
}

/**
 * Creates a new ContextInfo object with all values initialized to 0.
 * Use this function to get a fresh context info structure.
 * @returns A new ContextInfo object with zero-initialized values
 */
export function getInitialContextInfo(): ContextInfo {
    return {
        pinnedContextCount: {
            fileContextCount: 0,
            folderContextCount: 0,
            promptContextCount: 0,
            codeContextCount: 0,
        },
        contextCount: {
            fileContextCount: 0,
            folderContextCount: 0,
            promptContextCount: 0,
            activeRuleContextCount: 0,
            totalRuleContextCount: 0,
            codeContextCount: 0,
        },
        contextLength: {
            fileContextLength: 0,
            ruleContextLength: 0,
            promptContextLength: 0,
            codeContextLength: 0,
        },
    }
}

export const promptFileExtension = '.md'
export const additionalContentInnerContextLimit = 8192
export const additionalContentNameLimit = 1024

export const getUserPromptsDirectory = (): string => {
    return path.join(getUserHomeDir(), '.aws', 'amazonq', 'prompts')
}

/**
 * Truncates context content (e.g. an `@file` or pinned file) to `maxLength` characters.
 *
 * When the content is cut, an explicit marker is appended so the model knows it is only
 * seeing the beginning of the file and should read the rest via tools instead of assuming
 * the file ends where the excerpt ends. The returned string never exceeds `maxLength`.
 *
 * @param content - Full content of the context item
 * @param maxLength - Maximum number of characters allowed for the returned string
 * @returns The original content if it fits, otherwise a truncated prefix followed by a marker
 */
export function truncateContextContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
        return content
    }

    const marker = `\n\n[Content truncated: this file has ${content.length} characters, only the beginning is included above. Read the file directly to see the rest.]`

    if (marker.length >= maxLength) {
        return content.substring(0, maxLength)
    }

    return content.substring(0, maxLength - marker.length) + marker
}

/**
 * Creates a secure file path for a new prompt file.
 *
 * @param promptName - The user-provided name for the prompt
 * @returns A sanitized file path within the user prompts directory
 */
export const getNewPromptFilePath = (promptName: string): string => {
    const userPromptsDirectory = getUserPromptsDirectory()

    const trimmedName = promptName?.trim() || ''

    const truncatedName = trimmedName.slice(0, 100)

    const safePromptName = truncatedName ? sanitizeFilename(path.basename(truncatedName)) : 'default'

    const finalPath = path.join(userPromptsDirectory, `${safePromptName}${promptFileExtension}`)

    return finalPath
}

/**
 * Creates a secure file path for a new rule file.
 *
 * @param ruleName - The user-provided name for the prompt
 * @returns A sanitized file path within the user prompts directory
 */
export const getNewRuleFilePath = (ruleName: string, workspaceRulesDirectory: string): string => {
    const trimmedName = ruleName?.trim() || ''

    const truncatedName = trimmedName.slice(0, 100)

    const safePromptName = truncatedName ? sanitizeFilename(path.basename(truncatedName)) : 'default'

    const finalPath = path.join(workspaceRulesDirectory, `${safePromptName}${promptFileExtension}`)

    return finalPath
}

/**
 * Merges a RelevantTextDocumentAddition array into a FileList, which is used to display list of context files.
 * This function combines document fragments from the same file, merging overlapping
 * or consecutive line ranges to create a more compact representation.
 *
 * @param documents - Array of RelevantTextDocumentAddition objects containing file paths and line ranges
 * @returns A FileList object with merged file paths and consolidated line ranges
 *
 * Ported from https://github.com/aws/aws-toolkit-vscode/blob/master/packages/core/src/codewhispererChat/controllers/chat/controller.ts#L1239
 */
export function mergeRelevantTextDocuments(documents: RelevantTextDocumentAddition[]): FileList {
    if (documents.length === 0) {
        return { filePaths: [], details: {} }
    }

    const details: Record<string, FileDetails> = {}

    Object.entries(
        documents.reduce<Record<string, { first: number; second: number }[]>>((acc, doc) => {
            if (!doc.relativeFilePath || doc.startLine === undefined || doc.endLine === undefined) {
                return acc // Skip invalid documents
            }

            if (!acc[doc.relativeFilePath]) {
                acc[doc.relativeFilePath] = []
            }
            acc[doc.relativeFilePath].push({ first: doc.startLine, second: doc.endLine })
            return acc
        }, {})
    ).forEach(([relativeFilePath, ranges]) => {
        // Sort by startLine
        const sortedRanges = ranges.sort((a, b) => a.first - b.first)

        const mergedRanges: { first: number; second: number }[] = []
        for (const { first, second } of sortedRanges) {
            if (mergedRanges.length === 0 || mergedRanges[mergedRanges.length - 1].second < first - 1) {
                // If no overlap, add new range
                mergedRanges.push({ first, second })
            } else {
                // Merge overlapping or consecutive ranges
                mergedRanges[mergedRanges.length - 1].second = Math.max(
                    mergedRanges[mergedRanges.length - 1].second,
                    second
                )
            }
        }

        const fullPath = documents.find(doc => doc.relativeFilePath === relativeFilePath)?.path
        details[relativeFilePath] = {
            fullPath: fullPath,
            description: fullPath,
            lineRanges: mergedRanges,
        }
    })

    return {
        filePaths: Object.keys(details),
        details: details,
    }
}

/**
 * Merges two FileList objects into a single FileList
 * @param fileList1 The first FileList
 * @param fileList2 The second FileList
 * @returns A merged FileList
 */
export function mergeFileLists(fileList1: FileList, fileList2: FileList): FileList {
    // Handle empty lists
    if (!fileList1.filePaths?.length) {
        return fileList2
    }
    if (!fileList2.filePaths?.length) {
        return fileList1
    }

    // Initialize the result
    const mergedFilePaths: string[] = []
    const mergedDetails: Record<string, FileDetails> = {}

    // Process all files from fileList1
    fileList1.filePaths?.forEach(filePath => {
        mergedFilePaths.push(filePath)
        mergedDetails[filePath] = { ...fileList1.details?.[filePath] }
    })

    // Process all files from fileList2
    fileList2.filePaths?.forEach(filePath => {
        // If the file already exists in the merged result, merge the line ranges
        if (mergedDetails[filePath]) {
            const existingRanges = mergedDetails[filePath].lineRanges || []
            const newRanges = fileList2.details?.[filePath].lineRanges || []

            // Combine and sort all ranges
            const combinedRanges = [...existingRanges, ...newRanges].sort((a, b) => a.first - b.first)

            // Merge overlapping ranges
            const mergedRanges: Array<{ first: number; second: number }> = []
            for (const range of combinedRanges) {
                if (mergedRanges.length === 0 || mergedRanges[mergedRanges.length - 1].second < range.first - 1) {
                    // No overlap, add new range
                    mergedRanges.push({ ...range })
                } else {
                    // Merge overlapping or consecutive ranges
                    mergedRanges[mergedRanges.length - 1].second = Math.max(
                        mergedRanges[mergedRanges.length - 1].second,
                        range.second
                    )
                }
            }

            mergedDetails[filePath].lineRanges = mergedRanges
        } else {
            // If the file doesn't exist in the merged result, add it
            mergedFilePaths.push(filePath)
            mergedDetails[filePath] = { ...fileList2.details?.[filePath] }
        }
    })

    return {
        filePaths: mergedFilePaths,
        details: mergedDetails,
    }
}

/**
 * Generates a description string for a code symbol with optional line numbers.
 *
 * @param item - The ContextCommandItem containing symbol and workspace information
 * @param includeLineNumbers - Whether to include line number range in the description
 * @returns A formatted string containing the symbol kind, path and optionally line numbers,
 *          or empty string if no symbol exists
 * @example
 * // Without line numbers:
 * // "Function, myProject/src/utils.ts"
 *
 * // With line numbers:
 * // "Function, myProject/src/utils.ts, L10-L20"
 */
export function getCodeSymbolDescription(item: ContextCommandItem, includeLineNumbers?: boolean): string {
    const wsFolderName = path.basename(item.workspaceFolder)

    if (item.symbol) {
        const symbolKind = item.symbol.kind
        const symbolPath = path.join(wsFolderName, item.relativePath)
        const symbolLineNumbers = `L${item.symbol.range.start.line + 1}-${item.symbol.range.end.line + 1}`
        const parts = [symbolKind, symbolPath]
        if (includeLineNumbers) {
            parts.push(symbolLineNumbers)
        }
        return parts.join(', ')
    }
    return ''
}
