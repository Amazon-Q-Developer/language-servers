/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable import/no-nodejs-modules */

import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { SKIP_DIRECTORIES, EXTENSION_TO_LANGUAGE, CODE_REVIEW_METRICS_PARENT_NAME } from './codeReviewConstants'
import JSZip = require('jszip')
import { execFile } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as https from 'https'
import { InitializeParams } from '@aws/language-server-runtimes/server-interface'
import { QClientCapabilities } from '../../../configuration/qConfigurationServer'
import { CancellationError } from '@aws/lsp-core'
import { InvokeOutput } from '../toolShared'
import { CancellationToken } from '@aws/language-server-runtimes/server-interface'
import { CodeReviewMetric } from './codeReviewTypes'

/**
 * Utility functions for CodeReview
 */
export class CodeReviewUtils {
    /**
     * Check if a file should be skipped during zip creation
     * @param fileName Name of the file to check
     * @returns True if the file should be skipped, false otherwise
     */
    public static shouldSkipFile(fileName: string): boolean {
        const extension = path.extname(fileName).toLowerCase()
        if (!extension || extension.trim() === '') {
            return true
        } else {
            return !EXTENSION_TO_LANGUAGE.hasOwnProperty(extension)
        }
    }

    /**
     * Get language of a file based on extension
     * @param fileName Name of the file
     * @returns Language of file
     */
    public static getFileLanguage(fileName: string): string {
        const extension = path.extname(fileName).toLowerCase()
        return EXTENSION_TO_LANGUAGE[extension]
    }

    /**
     * Check if a directory should be skipped during zip creation
     * @param dirName Name of the directory to check
     * @returns True if the directory should be skipped, false otherwise
     */
    public static shouldSkipDirectory(dirName: string): boolean {
        return SKIP_DIRECTORIES.includes(dirName)
    }

    /**
     * Get the folder path from a file or folder path
     * @param inputPath Path to a file or folder
     * @returns The folder path
     */
    public static getFolderPath(inputPath: string): string {
        // Remove trailing slash and get dirname
        const cleanPath = inputPath.replace(/\/$/, '')

        // If it's a file (has extension), get its directory
        // If it's a directory (no extension), return it as-is
        return path.extname(cleanPath) ? path.dirname(cleanPath) : cleanPath
    }

    /**
     * Log a summary of the zip archive contents
     * @param zip JSZip instance to analyze
     * @param logging Logging interface
     */
    public static logZipSummary(zip: JSZip, logging: Features['logging']): void {
        try {
            const files = Object.keys(zip.files)
            const fileCount = files.filter(f => !zip.files[f].dir).length
            const folderCount = files.filter(f => zip.files[f].dir).length

            logging.info(`Zip summary: ${fileCount} files, ${folderCount} folders`)

            // Log the top-level structure
            const topLevel = files
                .filter(path => !path.includes('/') || path.split('/').length === 2)
                .map(path => `  - ${path}${zip.files[path].dir ? '/' : ''}`)
                .join('\n')

            logging.info(`Zip structure:\n${topLevel}`)
        } catch (error) {
            logging.warn(`Failed to generate zip summary: ${error}`)
        }
    }

    /**
     * Generate a unique client token for the request
     * @returns A unique string token
     */
    public static generateClientToken(): string {
        return `code-scan-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`
    }

    /**
     * Wrap a filesystem path as a literal git pathspec.
     *
     * The ":(literal)" prefix tells git to match the path exactly and to NOT
     * interpret pathspec "magic" (a leading ':') or glob wildcards ('*', '?',
     * '[', ']') that may appear in the path. Callers always pass the result
     * after a "--" separator so git treats it as a path, never as an option
     * or revision.
     *
     * @param artifactPath Path to a file or folder
     * @returns The path as a literal git pathspec
     */
    public static toLiteralPathspec(artifactPath: string): string {
        return `:(literal)${artifactPath}`
    }

    /**
     * Execute a git command with a fixed argument vector and return its
     * trimmed stdout.
     *
     * The command runs with execFile (no shell), so every argument — including
     * file paths that may contain shell metacharacters — is passed to git
     * verbatim and is never re-parsed by a shell. This removes the command
     * injection surface that string interpolation into a shell command line
     * would create. Callers pass any artifact-derived path as a literal git
     * pathspec (see {@link toLiteralPathspec}) after a "--" separator.
     *
     * @param args Argument vector passed to git (e.g. ['diff', '--', ':(literal)/repo/file.ts'])
     * @param cwd Working directory to run git in
     * @param type Type of command for logging
     * @param logging Logging interface
     * @returns Promise resolving to command output, or '' on failure
     */
    public static async executeGitCommand(
        args: string[],
        cwd: string,
        type: string,
        logging: Features['logging']
    ): Promise<string> {
        return new Promise<string>(resolve => {
            execFile('git', args, { cwd }, (error: any, stdout: string, stderr: string) => {
                if (error) {
                    logging.warn(`Git diff failed for ${type}: ${stderr || error.message}`)
                    resolve('')
                } else {
                    resolve(stdout.trim())
                }
            })
        })
    }

    /**
     * Get git diff for a file or folder
     * @param artifactPath Path to the file or folder
     * @param logging Logging interface
     * @returns Git diff output as string or null if not in a git repository
     */
    public static async getGitDiff(artifactPath: string, logging: Features['logging']): Promise<string | null> {
        logging.info(`Get git diff for path - ${artifactPath}`)

        const directoryPath = CodeReviewUtils.getFolderPath(artifactPath)
        const pathspec = CodeReviewUtils.toLiteralPathspec(artifactPath)

        logging.info(`Running git diff (unstaged and staged) in ${directoryPath} for path - ${artifactPath}`)

        try {
            const [unstagedDiff, stagedDiff] = await Promise.all([
                CodeReviewUtils.executeGitCommand(['diff', '--', pathspec], directoryPath, 'unstaged', logging),
                CodeReviewUtils.executeGitCommand(
                    ['diff', '--staged', '--', pathspec],
                    directoryPath,
                    'staged',
                    logging
                ),
            ])

            const combinedDiff = [unstagedDiff, stagedDiff].filter(Boolean).join('\n\n')
            return combinedDiff || null
        } catch (error) {
            logging.error(`Error getting git diff: ${error}`)
            return null
        }
    }

    /**
     * Get git diff for a file or folder
     * @param artifactPath Path to the file or folder
     * @param logging Logging interface
     * @returns Git diff output as string or null if not in a git repository
     */
    public static async getGitDiffNames(artifactPath: string, logging: Features['logging']): Promise<Set<string>> {
        logging.info(`Get git diff names for path - ${artifactPath}`)

        const directoryPath = CodeReviewUtils.getFolderPath(artifactPath)
        const pathspec = CodeReviewUtils.toLiteralPathspec(artifactPath)

        logging.info(
            `Running git diff --name-only (unstaged and staged) in ${directoryPath} for path - ${artifactPath}`
        )

        try {
            const unstagedDiff = (
                await CodeReviewUtils.executeGitCommand(
                    ['diff', '--name-only', '--', pathspec],
                    directoryPath,
                    'unstaged name only',
                    logging
                )
            ).split('\n')
            const stagedDiff = (
                await CodeReviewUtils.executeGitCommand(
                    ['diff', '--name-only', '--staged', '--', pathspec],
                    directoryPath,
                    'staged name only',
                    logging
                )
            ).split('\n')
            unstagedDiff.push(...stagedDiff)

            return new Set(unstagedDiff.filter(item => item !== ''))
        } catch (error) {
            logging.error(`Error getting git diff: ${error}`)
            return new Set()
        }
    }

    /**
     * Log zip structure
     * @param zip JSZip instance
     * @param zipName Name of the zip for logging
     * @param logging Logging interface
     */
    public static logZipStructure(zip: JSZip, zipName: string, logging: Features['logging']): void {
        logging.info(`${zipName} zip structure:`)
        Object.keys(zip.files).forEach(filePath => {
            let item = zip.files[filePath]
            if (!item.dir) {
                logging.info(`  ${filePath}`)
            }
        })
    }

    /**
     * Count number of files in zip
     * @param zip JSZip instance
     * @returns number of files in zip
     */
    public static countZipFiles(zip: JSZip): [number, Set<string>] {
        let count = 0
        let filePaths: Set<string> = new Set()
        Object.keys(zip.files).forEach(filePath => {
            let item = zip.files[filePath]
            if (!item.dir) {
                count += 1
                filePaths.add(filePath)
            }
        })
        return [count, filePaths]
    }

    /**
     * Generate zip buffer with compression
     * @param zip JSZip instance
     * @returns Promise resolving to compressed buffer
     */
    public static async generateZipBuffer(zip: JSZip): Promise<Buffer> {
        return await zip.generateAsync({
            type: 'nodebuffer',
            compression: 'DEFLATE',
            compressionOptions: { level: 9 },
        })
    }

    /**
     * Save zip buffer to Downloads folder
     * @param zipBuffer Buffer to save
     * @param logging Logging interface
     */
    public static saveZipToDownloads(zipBuffer: Buffer, logging: Features['logging']): void {
        try {
            const downloadsPath = path.join(os.homedir(), 'Downloads')
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
            const zipFilePath = path.join(downloadsPath, `codeArtifact-${timestamp}.zip`)

            fs.writeFileSync(zipFilePath, zipBuffer)
            logging.info(`Saved code artifact zip to: ${zipFilePath}`)
        } catch (saveError) {
            logging.error(`Failed to save zip file to Downloads folder: ${saveError}`)
        }
    }

    /**
     * Process artifact with git diff
     * @param artifact Artifact with path
     * @param isCodeDiffScan Whether to scan for code diff
     * @param logging Logging interface
     * @returns Promise resolving to diff string
     */
    public static async processArtifactWithDiff(
        artifact: { path: string },
        isCodeDiffScan: boolean,
        logging: Features['logging']
    ): Promise<string> {
        if (!isCodeDiffScan) return ''

        try {
            const diff = await CodeReviewUtils.getGitDiff(artifact.path, logging)
            return diff ? `${diff}\n` : ''
        } catch (diffError) {
            logging.warn(`Failed to get git diff for ${artifact.path}: ${diffError}`)
            return ''
        }
    }

    /**
     * Error handling wrapper
     * @param operation Operation to execute
     * @param errorMessage Error message prefix
     * @param logging Logging interface
     * @param path Optional path for error context
     * @returns Promise resolving to operation result
     */
    public static async withErrorHandling<T>(
        operation: () => Promise<T>,
        errorMessage: string,
        logging: Features['logging'],
        path?: string
    ): Promise<T> {
        try {
            return await operation()
        } catch (error) {
            const fullMessage = path ? `${errorMessage} ${path}: ${error}` : `${errorMessage}: ${error}`
            logging.error(fullMessage)
            throw new Error(fullMessage)
        }
    }

    /**
     * Check if agentic review capability is enabled in client capabilities
     * @param params Initialize parameters from client
     * @returns True if agentic reviewer is enabled, false otherwise
     */
    public static isAgenticReviewEnabled(params: InitializeParams | undefined): boolean {
        const qCapabilities = params?.initializationOptions?.aws?.awsClientCapabilities?.q as
            | QClientCapabilities
            | undefined
        return qCapabilities?.codeReviewInChat || false
    }

    /**
     * Check if storing display findings in the Code Issues panel is enabled.
     * @param params Initialize parameters from client
     * @returns True if display findings is enabled, false otherwise
     */
    public static isDisplayFindingsEnabled(params: InitializeParams | undefined): boolean {
        const qCapabilities = params?.initializationOptions?.aws?.awsClientCapabilities?.q as
            | QClientCapabilities
            | undefined
        return qCapabilities?.displayFindings || false
    }

    /**
     * Converts a Windows absolute file path to Unix format and removes the drive letter
     * @param windowsPath The Windows path to convert
     * @returns The Unix formatted path without drive letter
     */
    public static convertToUnixPath(windowsPath: string): string {
        // Remove drive letter (e.g., C:/) if present
        // Normalize the path and convert backslashes to forward slashes
        return path
            .normalize(windowsPath)
            .replace(/^[a-zA-Z]:\/?/, '')
            .replace(/\\/g, '/')
    }

    /**
     * Create a standardized error output object
     * @param errorObj Error object or message
     * @returns Formatted InvokeOutput with error details
     */
    public static createErrorOutput(errorObj: any): InvokeOutput {
        return {
            output: {
                kind: 'json',
                content: errorObj,
                success: false,
            },
        }
    }

    /**
     * Upload file content to the pre-signed URL
     * @param uploadUrl Pre-signed URL for uploading the file
     * @param fileContent Buffer containing the file content
     * @param requestHeaders Additional headers for the request
     * @param logging Logging interface
     */
    public static uploadFileToPresignedUrl(
        uploadUrl: string,
        fileContent: Buffer,
        requestHeaders: Record<string, string>,
        logging: Features['logging']
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const url = new URL(uploadUrl)

            const options = {
                hostname: url.hostname,
                path: url.pathname + url.search,
                method: 'PUT',
                headers: {
                    'Content-Length': fileContent.length,
                    ...requestHeaders,
                },
            }

            logging.info(`Uploading file to ${url.hostname}${url.pathname}`)

            const req = https.request(options, (res: any) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Upload failed with status code: ${res.statusCode}`))
                    return
                }
                let responseData = ''
                res.on('data', (chunk: string) => {
                    responseData += chunk
                })
                res.on('end', () => {
                    logging.info('File upload completed successfully')
                    resolve()
                })
            })

            req.on('error', (error: any) => {
                logging.error(`Error uploading file: ${error}`)
                reject(error)
            })

            req.write(fileContent)
            req.end()
        })
    }

    /**
     * Emit a telemetry metric with standard formatting
     * @param metricSuffix Suffix for the metric name
     * @param metricData Additional metric data
     * @param toolName Tool name for the metric prefix
     * @param logging Logging interface
     * @param telemetry Telemetry interface
     * @param credentialStartUrl Optional credential start URL
     */
    public static emitMetric(
        metric: CodeReviewMetric,
        logging: Features['logging'],
        telemetry: Features['telemetry']
    ): void {
        const { metadata, ...metricDetails } = metric
        const metricPayload = {
            name: CODE_REVIEW_METRICS_PARENT_NAME,
            data: {
                // metadata is optional attribute
                ...(metadata || {}),
                ...metricDetails,
            },
        }
        logging.info(`Emitting telemetry metric: ${metric.reason} with data: ${JSON.stringify(metricPayload.data)}`)
        telemetry.emitMetric(metricPayload)
    }

    /**
     * Check if cancellation has been requested and throw if it has
     * @param cancellationToken Cancellation token to check
     * @param message Optional message for the error
     * @param logging Logging interface
     */
    public static checkCancellation(
        cancellationToken: CancellationToken | undefined,
        logging: Features['logging'],
        message: string = 'Command execution cancelled'
    ): void {
        if (cancellationToken?.isCancellationRequested) {
            logging.info(message)
            throw new CancellationError('user')
        }
    }
}
