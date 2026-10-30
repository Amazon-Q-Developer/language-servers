/*!
 * Copyright Amazon.com, Inc. or its affiliates.
 * All Rights Reserved. SPDX-License-Identifier: Apache-2.0
 */

import { Mutex } from 'async-mutex'
import { createHash, randomUUID } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { InitializeParams, Logging, Workspace } from '@aws/language-server-runtimes/server-interface'

/**
 * Workspace trust as reported by the client:
 * - `trusted`: the IDE has trusted the open workspace.
 * - `restricted`: the IDE has not trusted the open workspace yet.
 * - `prompt`: the IDE has no trust decision, so Amazon Q asks once per folder.
 *
 * A client that reports nothing is treated as `prompt`.
 */
export type WorkspaceTrustState = 'trusted' | 'restricted' | 'prompt'

/** `aws/updateConfiguration` section a client uses to report a trust change, with `settings: { state }`. */
export const WORKSPACE_TRUST_CONFIGURATION_SECTION = 'aws.q.workspaceTrust'

const FOLDERS_FILE = 'mcp-workspace-folders.json'
// v2 records the folder's identity next to the path hash
const STORE_VERSION = 2
// Store reads and writes run one at a time in this process. Writes also take a lock file shared with the language
// servers of other IDE windows, so a write never replaces a change another window made while it waited.
const storeLock = new Mutex()
const LOCK_RETRY_MS = 25
const LOCK_WAIT_MS = 2000
// A lock file older than this was left by a process that stopped while writing
const LOCK_STALE_MS = 10000

interface FolderApproval {
    folderHash: string
    identity: string
    approvedAt: string
}

interface FolderApprovalStore {
    version: number
    folders: FolderApproval[]
    // When the user last forgot all approvals, so other windows drop approvals they hold in memory
    forgottenAt?: string
}

export function isWorkspaceTrustState(value: unknown): value is WorkspaceTrustState {
    return value === 'trusted' || value === 'restricted' || value === 'prompt'
}

/** Reads the trust state the client sent in `initializationOptions.aws.awsClientCapabilities.q.workspaceTrust`. */
export function getInitialWorkspaceTrust(params: InitializeParams | undefined): WorkspaceTrustState {
    const value = (params?.initializationOptions as any)?.aws?.awsClientCapabilities?.q?.workspaceTrust
    return isWorkspaceTrustState(value) ? value : 'prompt'
}

/**
 * Reads a trust change from an `aws/updateConfiguration` request. Returns `undefined` for other sections,
 * and `'invalid'` for this section with an unknown state.
 */
export function readWorkspaceTrustUpdate(params: {
    section?: string
    settings?: unknown
}): WorkspaceTrustState | 'invalid' | undefined {
    if (params?.section !== WORKSPACE_TRUST_CONFIGURATION_SECTION) {
        return undefined
    }
    const state = (params.settings as { state?: unknown } | undefined)?.state
    return isWorkspaceTrustState(state) ? state : 'invalid'
}

/**
 * Hash of a folder path, used as the approval key. Separators and a trailing separator are normalized. Case is
 * folded only on Windows; on macOS, where volumes can be case-sensitive, a different case asks again.
 */
export function fingerprintFolder(folder: string): string {
    let normalized = path.resolve(folder).replace(/\\/g, '/').replace(/\/+$/, '')
    if (process.platform === 'win32') {
        normalized = normalized.toLowerCase()
    }
    return 'sha256:' + createHash('sha256').update(normalized).digest('hex')
}

// Larger git files are not read; their remotes count as missing
const MAX_GIT_FILE_BYTES = 256 * 1024

/**
 * Text of a git file, or undefined when it is missing, not a regular file, or too large. The file is checked
 * through the opened handle, and opened without blocking, so a pipe or device at the path is never read.
 */
async function readGitFile(file: string): Promise<string | undefined> {
    let handle: fs.promises.FileHandle | undefined
    try {
        handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0))
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > MAX_GIT_FILE_BYTES) {
            return undefined
        }
        const buffer = Buffer.alloc(MAX_GIT_FILE_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, MAX_GIT_FILE_BYTES, 0)
        return buffer.subarray(0, bytesRead).toString('utf8')
    } catch {
        return undefined
    } finally {
        await handle?.close().catch(() => {})
    }
}

/**
 * Remote URLs of the git repository in a folder, or an empty string when there is none. Only files inside the
 * folder are read, and links are described by their target text without being followed. For a worktree or
 * submodule, where `.git` is a file that points to the git directory, the pointer text is used.
 */
async function getGitRemotes(folder: string): Promise<string> {
    const dotGit = path.join(folder, '.git')
    const configFile = path.join(dotGit, 'config')
    try {
        const gitStat = await fs.promises.lstat(dotGit)
        if (gitStat.isSymbolicLink()) {
            return `link: ${await fs.promises.readlink(dotGit)}`
        }
        if (gitStat.isFile()) {
            return (await readGitFile(dotGit))?.trim() ?? ''
        }
        if (!gitStat.isDirectory()) {
            return ''
        }
        const configStat = await fs.promises.lstat(configFile)
        if (configStat.isSymbolicLink()) {
            return `config link: ${await fs.promises.readlink(configFile)}`
        }
        if (!configStat.isFile()) {
            return ''
        }
    } catch {
        return ''
    }
    return ((await readGitFile(configFile)) ?? '')
        .split(/\r?\n/)
        .map(line => /^\s*url\s*=\s*(.*?)\s*$/i.exec(line)?.[1])
        .filter((url): url is string => !!url)
        .sort()
        .join('\n')
}

/**
 * Identity of the folder at a path: its device, inode and creation time, and the remotes of the git repository
 * in it. A folder deleted and created again at the same path, for example by cloning or extracting into it, or
 * a repository cloned into an existing folder, gets a new identity. Returns undefined when the folder is missing
 * or the file system does not report an inode and creation time, so the folder can't be told apart from a
 * replacement.
 */
export async function getFolderIdentity(folder: string): Promise<string | undefined> {
    try {
        const stat = await fs.promises.stat(folder, { bigint: true })
        if (!stat.isDirectory() || stat.ino === BigInt(0) || stat.birthtimeNs === BigInt(0)) {
            return undefined
        }
        const remotes = await getGitRemotes(folder)
        return (
            'sha256:' +
            createHash('sha256').update(`${stat.dev}:${stat.ino}:${stat.birthtimeNs}\n${remotes}`).digest('hex')
        )
    } catch {
        return undefined
    }
}

/** Path of the folder approval file, or undefined when the home directory is unknown. */
export function getFolderApprovalsPath(workspace: Workspace): string | undefined {
    const home = workspace.fs.getUserHomeDir() || os.homedir()
    if (!home || !path.isAbsolute(home)) {
        return undefined
    }
    return path.join(home, '.aws', 'amazonq', FOLDERS_FILE)
}

async function readStore(workspace: Workspace, logging: Logging): Promise<FolderApprovalStore> {
    const file = getFolderApprovalsPath(workspace)
    if (!file) {
        return { version: STORE_VERSION, folders: [] }
    }
    try {
        if (!(await workspace.fs.exists(file))) {
            return { version: STORE_VERSION, folders: [] }
        }
        const parsed = JSON.parse((await workspace.fs.readFile(file)).toString()) as FolderApprovalStore
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.folders)) {
            logging.warn(`MCP folder approvals: unrecognized format at ${file}, treating as empty`)
            return { version: STORE_VERSION, folders: [] }
        }
        return parsed
    } catch (e: any) {
        logging.warn(`MCP folder approvals: failed to read ${file}: ${e?.message}`)
        return { version: STORE_VERSION, folders: [] }
    }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Replace the file, retrying briefly while another program has it open on Windows. */
async function replaceFile(from: string, to: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            await fs.promises.rename(from, to)
            return
        } catch (e: any) {
            if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(e?.code)) {
                throw e
            }
            await sleep(LOCK_RETRY_MS * attempt)
        }
    }
}

/**
 * Take the lock file next to the store. The lock file holds a random token, so a process only removes or
 * relies on a lock it owns. Returns the token, or undefined if another process holds the lock for too long.
 */
async function acquireLockFile(lockFile: string): Promise<string | undefined> {
    const deadline = Date.now() + LOCK_WAIT_MS
    const token = randomUUID()
    while (true) {
        try {
            await fs.promises.writeFile(lockFile, token, { flag: 'wx' })
            return token
        } catch (e: any) {
            if (e?.code !== 'EEXIST') {
                return undefined
            }
        }
        try {
            const owner = await fs.promises.readFile(lockFile, 'utf8')
            if (Date.now() - (await fs.promises.stat(lockFile)).mtimeMs > LOCK_STALE_MS) {
                // Move the lock aside before removing it. If another process took the lock in the meantime, the
                // token differs: put that lock back. That process also checks its token before it writes.
                const aside = `${lockFile}.${token}.stale`
                await fs.promises.rename(lockFile, aside)
                if ((await fs.promises.readFile(aside, 'utf8')) !== owner) {
                    await fs.promises.link(aside, lockFile).catch(() => {})
                }
                await fs.promises.rm(aside, { force: true })
                continue
            }
        } catch (e: any) {
            if (e?.code === 'ENOENT') {
                // Released or taken over while this checked it
                continue
            }
            // A lock that can't be read is waited on like a held one
        }
        if (Date.now() >= deadline) {
            return undefined
        }
        await sleep(LOCK_RETRY_MS)
    }
}

async function ownsLockFile(lockFile: string, token: string): Promise<boolean> {
    return (await fs.promises.readFile(lockFile, 'utf8').catch(() => undefined)) === token
}

/**
 * Read the store, change it and write it back, holding both locks. The file is replaced in one step, so a
 * reader never sees a partly written file. Returns false when nothing was written.
 */
async function updateStore(
    workspace: Workspace,
    logging: Logging,
    change: (store: FolderApprovalStore) => FolderApprovalStore
): Promise<boolean> {
    const file = getFolderApprovalsPath(workspace)
    if (!file) {
        logging.warn('MCP folder approvals: home directory is unknown, not saved')
        return false
    }
    return storeLock.runExclusive(async () => {
        const lockFile = `${file}.lock`
        try {
            await workspace.fs.mkdir(path.dirname(file), { recursive: true })
        } catch (e: any) {
            logging.warn(`MCP folder approvals: failed to create ${path.dirname(file)}: ${e?.message}`)
            return false
        }
        const token = await acquireLockFile(lockFile)
        if (!token) {
            logging.warn(`MCP folder approvals: could not lock ${file}, not saved`)
            return false
        }
        const tmpFile = `${file}.${token}.tmp`
        try {
            const store = change(await readStore(workspace, logging))
            await workspace.fs.writeFile(tmpFile, JSON.stringify(store, null, 2))
            // Another process may have taken the lock over while this one was writing; then don't replace the file
            if (!(await ownsLockFile(lockFile, token))) {
                throw new Error('the lock was taken over by another process')
            }
            await replaceFile(tmpFile, file)
            return true
        } catch (e: any) {
            logging.warn(`MCP folder approvals: failed to write ${file}: ${e?.message}`)
            await fs.promises.rm(tmpFile, { force: true }).catch(() => {})
            return false
        } finally {
            if (await ownsLockFile(lockFile, token)) {
                await fs.promises.rm(lockFile, { force: true }).catch(() => {})
            }
        }
    })
}

/** Whether the folder at this path was allowed while it had this identity. */
export async function isFolderApproved(
    workspace: Workspace,
    logging: Logging,
    folder: string,
    identity: string
): Promise<boolean> {
    const key = fingerprintFolder(folder)
    const store = await storeLock.runExclusive(() => readStore(workspace, logging))
    return store.folders.some(f => f.folderHash === key && f.identity === identity)
}

/** When the user last forgot all folder approvals, in milliseconds since the epoch. */
export async function getFolderApprovalsForgottenAt(workspace: Workspace, logging: Logging): Promise<number> {
    const store = await storeLock.runExclusive(() => readStore(workspace, logging))
    const time = store.forgottenAt ? Date.parse(store.forgottenAt) : NaN
    return Number.isNaN(time) ? 0 : time
}

/**
 * Remember that the folder at this path was allowed while it had this identity. Returns false when the approval
 * could not be saved.
 */
export async function recordFolderApproval(
    workspace: Workspace,
    logging: Logging,
    folder: string,
    identity: string
): Promise<boolean> {
    const key = fingerprintFolder(folder)
    return updateStore(workspace, logging, store => ({
        ...store,
        // A folder approved earlier and since replaced keeps only its newest approval
        folders: [
            ...store.folders.filter(f => f.folderHash !== key),
            { folderHash: key, identity, approvedAt: new Date().toISOString() },
        ],
    }))
}

/**
 * Forget every folder approval. Returns false when the store could not be written, so approvals saved earlier
 * still apply after a restart.
 */
export async function forgetFolderApprovals(workspace: Workspace, logging: Logging): Promise<boolean> {
    if (!getFolderApprovalsPath(workspace)) {
        // Nothing can have been saved without a home directory
        return true
    }
    return updateStore(workspace, logging, () => ({
        version: STORE_VERSION,
        folders: [],
        forgottenAt: new Date().toISOString(),
    }))
}
