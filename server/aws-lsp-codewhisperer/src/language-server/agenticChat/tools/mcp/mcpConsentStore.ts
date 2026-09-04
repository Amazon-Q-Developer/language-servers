/**
 * Copyright Amazon.com, Inc. or its affiliates.
 * All Rights Reserved. SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'crypto'
import * as path from 'path'
import type { Workspace, Logging } from '@aws/language-server-runtimes/server-interface'
import type { MCPServerConfig } from './mcpTypes'

const APPROVALS_FILE = 'mcp-approvals.json'
// v2: the fingerprint now covers the fully-merged spawn environment and headers
// (see fingerprintServerConfig). Bumping the version discards v1 approvals, which
// were computed over a narrower field set, so every workspace-scoped server is
// re-consented once after upgrade.
const STORE_VERSION = 2

interface Approval {
    serverName: string
    fingerprint: string
    workspaceHash: string
    approvedAt: string
}

interface ApprovalStore {
    version: number
    approvals: Approval[]
}

function sortedRecord(rec?: Record<string, string>): Record<string, string> {
    return rec ? Object.fromEntries(Object.entries(rec).sort(([a], [b]) => a.localeCompare(b))) : {}
}

/**
 * The environment the stdio transport will actually spawn the server with, as far
 * as the config controls it. Mirrors the merge in McpManager (`cfg.env` overlaid by
 * `cfg.__additionalEnv__`).
 *
 * `__additionalEnv__` carries workspace/agent-level `env` for registry servers and is
 * NOT folded into `cfg.env`, so it must be merged here or it escapes the fingerprint.
 */
export function effectiveEnv(cfg: MCPServerConfig): Record<string, string> {
    return sortedRecord({ ...(cfg.env ?? {}), ...(cfg.__additionalEnv__ ?? {}) })
}

/**
 * The headers the HTTP/SSE transport will actually send, as far as the config
 * controls it. Mirrors the merge in McpManager (`cfg.headers` overlaid by
 * `cfg.__additionalHeaders__`).
 */
export function effectiveHeaders(cfg: MCPServerConfig): Record<string, string> {
    return sortedRecord({ ...(cfg.headers ?? {}), ...(cfg.__additionalHeaders__ ?? {}) })
}

/**
 * SHA-256 of a canonical JSON form of the server's execution-relevant fields.
 * Any change to command/args/env/url/headers yields a new fingerprint, invalidating
 * prior approvals — so mutation of the config re-prompts.
 *
 * `env` and `headers` are hashed in their *merged* form (see effectiveEnv /
 * effectiveHeaders) so every field that reaches the spawned process is covered by
 * consent. Two configs that spawn an identical process share a fingerprint regardless
 * of which field supplied a value: consent is about what will execute, not how the
 * config is spelled.
 */
export function fingerprintServerConfig(cfg: MCPServerConfig): string {
    const canonical = {
        command: cfg.command ?? null,
        args: cfg.args ?? [],
        env: effectiveEnv(cfg),
        url: cfg.url ?? null,
        headers: effectiveHeaders(cfg),
    }
    return 'sha256:' + createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** Hash of the workspace path so approval is scoped to (workspace, config).
 *  Normalizes the path to forward slashes for cross-platform consistency. */
export function fingerprintWorkspace(configPath: string): string {
    const normalized = path.resolve(path.dirname(configPath)).replace(/\\/g, '/')
    return 'sha256:' + createHash('sha256').update(normalized).digest('hex')
}

function getStorePath(workspace: Workspace): string {
    return path.join(workspace.fs.getUserHomeDir(), '.aws', 'amazonq', APPROVALS_FILE)
}

async function readStore(workspace: Workspace, logging: Logging): Promise<ApprovalStore> {
    const file = getStorePath(workspace)
    try {
        if (!(await workspace.fs.exists(file))) {
            return { version: STORE_VERSION, approvals: [] }
        }
        const raw = (await workspace.fs.readFile(file)).toString()
        const parsed = JSON.parse(raw) as ApprovalStore
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.approvals)) {
            logging.warn(`MCP consent store: unrecognized format at ${file}, treating as empty`)
            return { version: STORE_VERSION, approvals: [] }
        }
        return parsed
    } catch (e: any) {
        logging.warn(`MCP consent store: failed to read ${file}: ${e?.message}`)
        return { version: STORE_VERSION, approvals: [] }
    }
}

async function writeStore(workspace: Workspace, logging: Logging, store: ApprovalStore): Promise<void> {
    const file = getStorePath(workspace)
    try {
        await workspace.fs.mkdir(path.dirname(file), { recursive: true })
        await workspace.fs.writeFile(file, JSON.stringify(store, null, 2))
    } catch (e: any) {
        logging.warn(`MCP consent store: failed to write ${file}: ${e?.message}`)
    }
}

export async function hasApproval(
    workspace: Workspace,
    logging: Logging,
    serverName: string,
    cfg: MCPServerConfig,
    configPath: string
): Promise<boolean> {
    const store = await readStore(workspace, logging)
    const fp = fingerprintServerConfig(cfg)
    const wh = fingerprintWorkspace(configPath)
    // Consent is bound to the full triple (serverName, fingerprint, workspaceHash)
    // and ALL three must match for a prior approval to apply:
    //   - serverName + fingerprint: the exact execution-relevant config
    //     (command/args/env/url). A mutated config yields a new fingerprint, so a
    //     config change re-prompts.
    //   - workspaceHash: the specific workspace folder that requested the server.
    //     Approvals are not portable across workspaces.
    // Requiring all three (logical AND) prevents two attacks (CVE-2026-12957):
    //   1. Cross-workspace reuse — a malicious workspace with an identical config
    //      (same fingerprint) cannot silently reuse an approval granted in a
    //      different, trusted workspace, because its workspaceHash differs. The
    //      server is spawned with cwd set to the requesting workspace, so reusing
    //      consent across workspaces would execute attacker-controlled files.
    //   2. Mutation variant — a previously-trusted workspace cannot turn malicious
    //      via a later config edit without re-prompting, because the edit changes
    //      the fingerprint even though the workspaceHash is unchanged.
    return store.approvals.some(a => a.serverName === serverName && a.fingerprint === fp && a.workspaceHash === wh)
}

export async function recordApproval(
    workspace: Workspace,
    logging: Logging,
    serverName: string,
    cfg: MCPServerConfig,
    configPath: string
): Promise<void> {
    const store = await readStore(workspace, logging)
    const fp = fingerprintServerConfig(cfg)
    const wh = fingerprintWorkspace(configPath)
    // Replace any prior approval for the same (server, workspace) — this evicts
    // stale entries when the config changes (fingerprint differs).
    store.approvals = store.approvals.filter(a => !(a.serverName === serverName && a.workspaceHash === wh))
    store.approvals.push({
        serverName,
        fingerprint: fp,
        workspaceHash: wh,
        approvedAt: new Date().toISOString(),
    })
    await writeStore(workspace, logging, store)
}

export async function removeApproval(
    workspace: Workspace,
    logging: Logging,
    serverName: string,
    configPath: string
): Promise<void> {
    const store = await readStore(workspace, logging)
    const wh = fingerprintWorkspace(configPath)
    const before = store.approvals.length
    // Scope removal to the (serverName, workspace) that requested it, mirroring how
    // recordApproval keys entries. Removing a server in one workspace must not
    // revoke consent for an identically-named server in a different workspace.
    store.approvals = store.approvals.filter(a => !(a.serverName === serverName && a.workspaceHash === wh))
    if (store.approvals.length < before) {
        await writeStore(workspace, logging, store)
        logging.info(`MCP consent store: removed approval for '${serverName}'`)
    }
}
