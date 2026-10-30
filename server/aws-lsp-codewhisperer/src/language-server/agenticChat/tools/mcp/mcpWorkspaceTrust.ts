/*!
 * Copyright Amazon.com, Inc. or its affiliates.
 * All Rights Reserved. SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'crypto'
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
const STORE_VERSION = 1

interface FolderApproval {
    folderHash: string
    approvedAt: string
}

interface FolderApprovalStore {
    version: number
    folders: FolderApproval[]
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

/** Approval store path, or undefined when the home directory is unknown. */
function getStorePath(workspace: Workspace): string | undefined {
    const home = workspace.fs.getUserHomeDir() || os.homedir()
    if (!home || !path.isAbsolute(home)) {
        return undefined
    }
    return path.join(home, '.aws', 'amazonq', FOLDERS_FILE)
}

async function readStore(workspace: Workspace, logging: Logging): Promise<FolderApprovalStore> {
    const file = getStorePath(workspace)
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

export async function isFolderApproved(workspace: Workspace, logging: Logging, folder: string): Promise<boolean> {
    const key = fingerprintFolder(folder)
    const store = await readStore(workspace, logging)
    return store.folders.some(f => f.folderHash === key)
}

export async function recordFolderApproval(workspace: Workspace, logging: Logging, folder: string): Promise<void> {
    const key = fingerprintFolder(folder)
    const store = await readStore(workspace, logging)
    if (store.folders.some(f => f.folderHash === key)) {
        return
    }
    store.folders.push({ folderHash: key, approvedAt: new Date().toISOString() })
    const file = getStorePath(workspace)
    if (!file) {
        logging.warn('MCP folder approvals: home directory is unknown, approval kept for this session only')
        return
    }
    try {
        await workspace.fs.mkdir(path.dirname(file), { recursive: true })
        await workspace.fs.writeFile(file, JSON.stringify(store, null, 2))
    } catch (e: any) {
        logging.warn(`MCP folder approvals: failed to write ${file}: ${e?.message}`)
    }
}
