import { Features } from '@aws/language-server-runtimes/server-interface/server'
import {
    CheckedFileOperations,
    CheckedFileTarget,
    FileUpdateOutcome,
} from '@aws/language-server-runtimes/server-interface'
import { FileOperationError } from '../errors'

export type CheckedTarget = CheckedFileTarget | Readonly<{ path: string; state: 'unverified' }>
type DebugLogger = Pick<Features['logging'], 'debug'>

/** Diagnostic failures must not change the operation. Never pass content or full tool inputs here. */
export function logFileAccess(
    logging: DebugLogger | undefined,
    event: string,
    details: {
        toolUseId?: string
        toolName?: string
        targetPath?: string
        canonicalPaths?: string[]
        requiresAcceptance?: boolean
        operation?: string
        fd?: number
    },
    error?: unknown
): void {
    try {
        logging?.debug(
            `[file-access] ${JSON.stringify({
                event,
                ...details,
                ...(error === undefined
                    ? {}
                    : {
                          errorName: error instanceof Error ? error.name : 'UnknownError',
                          errorCode: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
                      }),
            })}`
        )
    } catch {
        // Logging is best effort, including while handling an I/O failure.
    }
}

/** Lowest `checkedFiles` contract version this consumer needs; later versions are additive. */
const REQUIRED_CHECKED_FILES_VERSION = 1

function checkedFiles(workspace: Features['workspace']): CheckedFileOperations {
    const operations = workspace.fs.checkedFiles
    if (
        typeof operations?.version !== 'number' ||
        !Number.isInteger(operations.version) ||
        operations.version < REQUIRED_CHECKED_FILES_VERSION ||
        typeof operations.capture !== 'function' ||
        typeof operations.read !== 'function' ||
        typeof operations.update !== 'function'
    ) {
        throw new FileOperationError(
            `Filesystem contract version ${REQUIRED_CHECKED_FILES_VERSION} or later with capture, read, and update is unavailable in this runtime`,
            'The language-server runtime must be updated before this file operation can run.'
        )
    }
    return operations
}

export async function captureCheckedTarget(workspace: Features['workspace'], path: string): Promise<CheckedTarget> {
    if (process.platform === 'win32') return Object.freeze({ path, state: 'unverified' })
    return Object.freeze({ ...(await checkedFiles(workspace).capture(path)) })
}

export async function readCheckedFile(
    workspace: Features['workspace'],
    target: CheckedTarget,
    logging?: DebugLogger
): Promise<string> {
    try {
        if (process.platform === 'win32') return await workspace.fs.readFile(target.path)
        if (target.state === 'unverified') throw new Error('No checked file identity for this operation.')
        return await checkedFiles(workspace).read(target)
    } catch (error) {
        logFileAccess(logging, 'io.failed', { targetPath: target.path, operation: 'read' }, error)
        throw error
    }
}

export async function updateCheckedFile(
    workspace: Features['workspace'],
    target: CheckedTarget,
    transform: (content: string) => string,
    options: { create?: boolean; readExisting?: boolean } = {},
    logging?: DebugLogger
): Promise<FileUpdateOutcome> {
    try {
        if (process.platform === 'win32') {
            const content = options.readExisting === false ? '' : await workspace.fs.readFile(target.path)
            await workspace.fs.writeFile(target.path, transform(content))
            return { mayHaveChanged: true, complete: true }
        }
        if (target.state === 'unverified') throw new Error('No checked file identity for this operation.')
        return await checkedFiles(workspace).update(target, transform, options)
    } catch (error) {
        logFileAccess(logging, 'io.failed', { targetPath: target.path, operation: 'update' }, error)
        throw error
    }
}
