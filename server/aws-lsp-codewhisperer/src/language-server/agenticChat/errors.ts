import { CodeWhispererStreamingServiceException } from '@amzn/codewhisperer-streaming'

type AgenticChatErrorCode =
    | 'QModelResponse' // generic backend error.
    | 'AmazonQServiceManager' // AmazonQServiceManager failed to initialize.
    | 'FailedResult' // general error when processing tool results
    | 'InputTooLong' // too much context given to backend service.
    | 'PromptCharacterLimit' // customer prompt exceeds
    | 'AmazonQUsageLimitError' // Monthly usage limit was reached (usually free-tier user).
    | 'ResponseProcessingTimeout' // response didn't finish streaming in the allowed time
    | 'MCPServerInitTimeout' // mcp server failed to start within allowed time
    | 'MCPToolExecTimeout' // mcp tool call failed to complete within allowed time
    | 'MCPServerConnectionFailed' // mcp server failed to connect
    | 'MCPServerAuthFailed' // mcp server failed to complete auth flow
    | 'RequestAborted' // request was aborted by the user
    | 'RequestThrottled' // request was aborted by the user

export const customerFacingErrorCodes: AgenticChatErrorCode[] = [
    'QModelResponse',
    'InputTooLong',
    'PromptCharacterLimit',
    'AmazonQUsageLimitError',
]

export const unactionableErrorCodes: Partial<Record<AgenticChatErrorCode, string>> = {
    PromptCharacterLimit: 'User prompt contains too many characters',
}

export class AgenticChatError extends Error {
    constructor(
        message: string,
        public readonly code: AgenticChatErrorCode,
        cause?: Error,
        public readonly requestId?: string
    ) {
        super(message, { cause: cause })
    }
}

export function wrapErrorWithCode(error: unknown, code: AgenticChatErrorCode) {
    if (error instanceof CodeWhispererStreamingServiceException) {
        return new AgenticChatError(error.message, code, error, error.$metadata?.requestId)
    }

    if (error instanceof Error) {
        return new AgenticChatError(error.message, code, error)
    }
    return new AgenticChatError(String(error), code)
}

export function isInputTooLongError(error: unknown): boolean {
    if (error instanceof AgenticChatError && error.code === 'InputTooLong') {
        return true
    }

    if (error instanceof Error) {
        //  This is fragile (breaks if the backend changes their error message wording)
        return error.message.includes('Input is too long')
    }

    return false
}

/**
 * Detects context window overflow errors that can be resolved by compacting conversation history.
 * Covers various error patterns from different backends and API versions.
 */
export function isContextWindowOverflow(error: unknown): boolean {
    if (isInputTooLongError(error)) {
        return true
    }

    const message = (error as Error)?.message?.toLowerCase() ?? ''
    const name = (error as Error)?.name ?? ''
    return (
        name === 'ContextWindowOverflowException' ||
        message.includes('improperly formed request') ||
        message.includes('prompt is too long') ||
        message.includes('context window') ||
        message.includes('token limit') ||
        message.includes('maximum context')
    )
}

export function isRequestAbortedError(error: unknown): boolean {
    if (error instanceof AgenticChatError && error.code === 'RequestAborted') {
        return true
    }

    if (error instanceof Error) {
        //  This is fragile (breaks if the backend changes their error message wording)
        return error.message.includes('Request aborted')
    }

    return false
}

/**
 * Base class for file operation errors with customer-facing messages
 */
export class FileOperationError extends Error {
    constructor(
        message: string,
        public readonly customerMessage: string
    ) {
        super(message)
        this.name = this.constructor.name
    }
}

// Common file system errors
export class DirectoryNotFoundError extends FileOperationError {
    constructor(message: string) {
        super(message, 'The directory does not exist.')
    }
}

export class PermissionDeniedError extends FileOperationError {
    constructor(message: string) {
        super(message, 'Permission denied.')
    }
}

export class IsDirectoryError extends FileOperationError {
    constructor(message: string) {
        super(message, 'The specified path is a directory, not a file.')
    }
}

export class NoSpaceError extends FileOperationError {
    constructor(message: string) {
        super(message, 'No space left on device.')
    }
}

export class TooManyOpenFilesError extends FileOperationError {
    constructor(message: string) {
        super(message, 'Too many open files.')
    }
}

// fsWrite specific errors
export class EmptyPathError extends FileOperationError {
    constructor() {
        super('Path must not be empty', 'The file path cannot be empty.')
    }
}

export class MissingContentError extends FileOperationError {
    constructor() {
        super('fileText must be provided for create command', 'No content provided for the file.')
    }
}

export class FileExistsWithSameContentError extends FileOperationError {
    constructor() {
        super(
            'The file already exists with the same content',
            'The file already exists with identical content. No changes were made.'
        )
    }
}

export class EmptyAppendContentError extends FileOperationError {
    constructor() {
        super('Content to append must not be empty', 'No content provided to append.')
    }
}

// fsReplace specific errors
export class EmptyDiffsError extends FileOperationError {
    constructor() {
        super('Diffs must not be empty', 'No changes specified.')
    }
}

export class FileNotExistsError extends FileOperationError {
    constructor() {
        super('The provided path must exist in order to replace contents into it', 'The file does not exist.')
    }
}

export class TextNotFoundError extends FileOperationError {
    constructor(text: string) {
        super(`No occurrences of "${text}" were found`, 'The text to replace was not found in the file.')
    }
}

export class MultipleMatchesError extends FileOperationError {
    constructor(text: string) {
        super(
            `Multiple occurrences of "${text}" were found when only 1 is expected`,
            'Multiple instances of the text to replace were found.'
        )
    }
}

/**
 * Maps a standard Error to the appropriate FileOperationError type
 * @param error The original error
 * @returns A FileOperationError with customer-facing message
 */
export function createFileOperationError(error: Error): FileOperationError {
    const message = error.message

    // Common file system errors
    if (message.includes('ENOENT') || message.includes('no such file or directory')) {
        return new DirectoryNotFoundError(message)
    }
    if (message.includes('EACCES') || message.includes('permission denied')) {
        return new PermissionDeniedError(message)
    }
    if (message.includes('EISDIR')) {
        return new IsDirectoryError(message)
    }
    if (message.includes('ENOSPC')) {
        return new NoSpaceError(message)
    }
    if (message.includes('EMFILE') || message.includes('ENFILE')) {
        return new TooManyOpenFilesError(message)
    }

    // fsWrite specific errors
    if (message === 'Path must not be empty') {
        return new EmptyPathError()
    }
    if (message === 'fileText must be provided for create command') {
        return new MissingContentError()
    }
    if (message === 'The file already exists with the same content') {
        return new FileExistsWithSameContentError()
    }
    if (message === 'Content to append must not be empty') {
        return new EmptyAppendContentError()
    }

    // fsReplace specific errors
    if (message === 'Diffs must not be empty') {
        return new EmptyDiffsError()
    }
    if (message === 'The provided path must exist in order to replace contents into it') {
        return new FileNotExistsError()
    }

    // Pattern matching for errors with dynamic content
    const noOccurrencesMatch = message.match(/No occurrences of "(.+)" were found/)
    if (noOccurrencesMatch) {
        return new TextNotFoundError(noOccurrencesMatch[1])
    }

    const multipleOccurrencesMatch = message.match(/Multiple occurrences of "(.+)" were found/)
    if (multipleOccurrencesMatch) {
        return new MultipleMatchesError(multipleOccurrencesMatch[1])
    }

    // Default fallback - wrap the original error with the same message
    return new FileOperationError(message, message)
}

/**
 * Maps an error to a customer-facing message
 * @param error The original error (can be any type)
 * @returns A customer-facing error message
 */
export function getCustomerFacingErrorMessage(error: unknown): string {
    if (error instanceof FileOperationError) {
        return error.customerMessage
    }

    if (error instanceof Error) {
        return createFileOperationError(error).customerMessage
    }

    return String(error)
}

export function isThrottlingRelated(error: unknown): boolean {
    if (error instanceof AgenticChatError && error.code === 'RequestThrottled') {
        return true
    }

    if (error instanceof Error) {
        //  Only depend on the exception name, not the stack trace
        return error.name === 'ServiceUnavailableException'
    }
    return false
}
