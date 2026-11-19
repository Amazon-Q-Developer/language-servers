/*!
 * Copyright Amazon.com, Inc. or its affiliates.
 * All Rights Reserved. SPDX-License-Identifier: Apache-2.0
 */

import { expect } from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
    effectiveEnv,
    effectiveHeaders,
    fingerprintServerConfig,
    fingerprintWorkspace,
    hasApproval,
    recordApproval,
    removeApproval,
} from './mcpConsentStore'
import type { MCPServerConfig } from './mcpTypes'

describe('mcpConsentStore', () => {
    let tmpHome: string
    let workspace: any
    let logger: any

    beforeEach(() => {
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpConsentTest-'))
        workspace = {
            fs: {
                exists: (p: string) => Promise.resolve(fs.existsSync(p)),
                readFile: (p: string) => Promise.resolve(Buffer.from(fs.readFileSync(p))),
                writeFile: (p: string, d: string) => Promise.resolve(fs.writeFileSync(p, d)),
                mkdir: (p: string, _opts: any) => Promise.resolve(fs.mkdirSync(p, { recursive: true })),
                getUserHomeDir: () => tmpHome,
            },
        }
        logger = { warn: () => {}, info: () => {}, error: () => {} }
    })

    afterEach(() => {
        fs.rmSync(tmpHome, { recursive: true, force: true })
    })

    describe('fingerprintServerConfig', () => {
        it('is deterministic for identical config', () => {
            const cfg: MCPServerConfig = { command: 'sh', args: ['-c', 'echo hi'] }
            expect(fingerprintServerConfig(cfg)).to.equal(fingerprintServerConfig({ ...cfg }))
        })

        it('differs when command changes', () => {
            const a: MCPServerConfig = { command: 'sh', args: ['-c', 'echo hi'] }
            const b: MCPServerConfig = { command: 'bash', args: ['-c', 'echo hi'] }
            expect(fingerprintServerConfig(a)).to.not.equal(fingerprintServerConfig(b))
        })

        it('differs when args change', () => {
            const a: MCPServerConfig = { command: 'sh', args: ['-c', 'echo hi'] }
            const b: MCPServerConfig = { command: 'sh', args: ['-c', 'echo bye'] }
            expect(fingerprintServerConfig(a)).to.not.equal(fingerprintServerConfig(b))
        })

        it('differs when env changes', () => {
            const a: MCPServerConfig = { command: 'sh', args: [], env: { FOO: '1' } }
            const b: MCPServerConfig = { command: 'sh', args: [], env: { FOO: '2' } }
            expect(fingerprintServerConfig(a)).to.not.equal(fingerprintServerConfig(b))
        })

        it('is stable regardless of env key order', () => {
            const a: MCPServerConfig = { command: 'sh', args: [], env: { A: '1', B: '2' } }
            const b: MCPServerConfig = { command: 'sh', args: [], env: { B: '2', A: '1' } }
            expect(fingerprintServerConfig(a)).to.equal(fingerprintServerConfig(b))
        })

        it('differs when url changes', () => {
            const a: MCPServerConfig = { url: 'https://a.example' }
            const b: MCPServerConfig = { url: 'https://b.example' }
            expect(fingerprintServerConfig(a)).to.not.equal(fingerprintServerConfig(b))
        })

        // __additionalEnv__ / __additionalHeaders__ are merged into the spawn env/headers,
        // so they must be covered by the fingerprint alongside the raw fields — otherwise a
        // post-approval config edit to those fields would not re-prompt.
        it('differs when __additionalEnv__ is added', () => {
            const a: MCPServerConfig = { command: 'npx', args: ['-y', 's'], env: { LOG_LEVEL: 'info' } }
            const b: MCPServerConfig = {
                ...a,
                __additionalEnv__: { EXTRA: '1' },
            }
            expect(fingerprintServerConfig(a)).to.not.equal(fingerprintServerConfig(b))
        })

        it('differs when __additionalEnv__ overrides an existing env value', () => {
            const a: MCPServerConfig = { command: 'sh', args: [], env: { FOO: '1' } }
            const b: MCPServerConfig = { command: 'sh', args: [], env: { FOO: '1' }, __additionalEnv__: { FOO: '2' } }
            expect(fingerprintServerConfig(a)).to.not.equal(fingerprintServerConfig(b))
        })

        it('differs when headers change', () => {
            const a: MCPServerConfig = { url: 'https://a.example', headers: { Authorization: 'Bearer good' } }
            const b: MCPServerConfig = { url: 'https://a.example', headers: { Authorization: 'Bearer attacker' } }
            expect(fingerprintServerConfig(a)).to.not.equal(fingerprintServerConfig(b))
        })

        it('differs when __additionalHeaders__ overrides an existing header', () => {
            const a: MCPServerConfig = { url: 'https://a.example', headers: { Authorization: 'Bearer good' } }
            const b: MCPServerConfig = {
                url: 'https://a.example',
                headers: { Authorization: 'Bearer good' },
                __additionalHeaders__: { Authorization: 'Bearer attacker' },
            }
            expect(fingerprintServerConfig(a)).to.not.equal(fingerprintServerConfig(b))
        })

        // Consent is about what will execute, not how the config is spelled: two configs
        // that spawn the process with the identical effective env share a fingerprint.
        it('hashes the merged spawn env, so the same effective env matches either field', () => {
            const viaEnv: MCPServerConfig = { command: 'sh', args: [], env: { FOO: '1' } }
            const viaAdditional: MCPServerConfig = { command: 'sh', args: [], __additionalEnv__: { FOO: '1' } }
            expect(fingerprintServerConfig(viaEnv)).to.equal(fingerprintServerConfig(viaAdditional))
        })

        it('is stable regardless of __additionalEnv__ key order', () => {
            const a: MCPServerConfig = { command: 'sh', args: [], __additionalEnv__: { A: '1', B: '2' } }
            const b: MCPServerConfig = { command: 'sh', args: [], __additionalEnv__: { B: '2', A: '1' } }
            expect(fingerprintServerConfig(a)).to.equal(fingerprintServerConfig(b))
        })
    })

    describe('effectiveEnv / effectiveHeaders', () => {
        it('merges __additionalEnv__ over env, matching the spawn-time merge', () => {
            const cfg: MCPServerConfig = { env: { A: '1', B: '2' }, __additionalEnv__: { B: 'override', C: '3' } }
            expect(effectiveEnv(cfg)).to.deep.equal({ A: '1', B: 'override', C: '3' })
        })

        it('merges __additionalHeaders__ over headers', () => {
            const cfg: MCPServerConfig = { headers: { X: '1' }, __additionalHeaders__: { X: '2', Y: '3' } }
            expect(effectiveHeaders(cfg)).to.deep.equal({ X: '2', Y: '3' })
        })

        it('returns an empty object when nothing is set', () => {
            expect(effectiveEnv({})).to.deep.equal({})
            expect(effectiveHeaders({})).to.deep.equal({})
        })
    })

    describe('fingerprintWorkspace', () => {
        it('is keyed on the directory of the config, not the filename', () => {
            const a = fingerprintWorkspace('/foo/bar/.amazonq/mcp.json')
            const b = fingerprintWorkspace('/foo/bar/.amazonq/agents/default.json')
            // both live under /foo/bar/.amazonq's parent-dir once; path.dirname differs though
            expect(a).to.not.equal(b)
        })

        it('is deterministic for the same path', () => {
            const p = '/foo/bar/.amazonq/mcp.json'
            expect(fingerprintWorkspace(p)).to.equal(fingerprintWorkspace(p))
        })
    })

    describe('hasApproval / recordApproval', () => {
        const cfg: MCPServerConfig = { command: 'sh', args: ['-c', 'echo ok'] }
        const configPath = '/tmp/ws-a/.amazonq/mcp.json'

        it('returns false when store is empty', async () => {
            expect(await hasApproval(workspace, logger, 'poc', cfg, configPath)).to.be.false
        })

        it('records and finds an approval for same (name, config, workspace)', async () => {
            await recordApproval(workspace, logger, 'poc', cfg, configPath)
            expect(await hasApproval(workspace, logger, 'poc', cfg, configPath)).to.be.true
        })

        // CVE-2026-12957 — cross-workspace reuse. An approval granted in one
        // workspace MUST NOT be reused in a different workspace, even when the
        // server config (and thus fingerprint) is byte-for-byte identical. The
        // server is spawned with cwd set to the requesting workspace, so reusing
        // consent across workspaces would execute attacker-controlled files
        // (zero-prompt RCE). This mirrors the reported PoC, in which an identical
        // config appears in a seed (trusted) workspace and a malicious workspace.
        it('does NOT match across workspaces when only the fingerprint is identical', async () => {
            await recordApproval(workspace, logger, 'poc', cfg, '/tmp/seed-workspace/.amazonq/mcp.json')
            expect(await hasApproval(workspace, logger, 'poc', cfg, '/tmp/malicious-workspace/.amazonq/mcp.json')).to.be
                .false
        })

        // CVE-2026-12957 — mutation variant. Within the same workspace, editing the
        // server config changes the fingerprint and MUST force a re-prompt, so a
        // previously-trusted workspace cannot turn malicious via a later edit.
        it('does NOT match in the same workspace when the fingerprint changed', async () => {
            await recordApproval(workspace, logger, 'poc', cfg, configPath)
            const mutated: MCPServerConfig = { command: 'sh', args: ['-c', 'echo different'] }
            expect(await hasApproval(workspace, logger, 'poc', mutated, configPath)).to.be.false
        })

        it('treats consent per-workspace: approving one workspace does not grant the other', async () => {
            const seedPath = '/tmp/seed-workspace/.amazonq/mcp.json'
            const maliciousPath = '/tmp/malicious-workspace/.amazonq/mcp.json'
            await recordApproval(workspace, logger, 'poc', cfg, seedPath)
            // Seed workspace is trusted; malicious workspace with identical config is not.
            expect(await hasApproval(workspace, logger, 'poc', cfg, seedPath)).to.be.true
            expect(await hasApproval(workspace, logger, 'poc', cfg, maliciousPath)).to.be.false
            // Explicitly approving the second workspace grants only that workspace.
            await recordApproval(workspace, logger, 'poc', cfg, maliciousPath)
            expect(await hasApproval(workspace, logger, 'poc', cfg, maliciousPath)).to.be.true
        })

        it('still matches after re-approving a mutated config in the same workspace', async () => {
            await recordApproval(workspace, logger, 'poc', cfg, configPath)
            const mutated: MCPServerConfig = { command: 'sh', args: ['-c', 'echo different'] }
            await recordApproval(workspace, logger, 'poc', mutated, configPath)
            expect(await hasApproval(workspace, logger, 'poc', mutated, configPath)).to.be.true
            // The original (now stale) config no longer matches.
            expect(await hasApproval(workspace, logger, 'poc', cfg, configPath)).to.be.false
        })

        it('does not match when both fingerprint and workspace differ', async () => {
            await recordApproval(workspace, logger, 'poc', cfg, configPath)
            const mutated: MCPServerConfig = { command: 'sh', args: ['-c', 'curl evil'] }
            // Different fingerprint AND different workspace — no match
            expect(await hasApproval(workspace, logger, 'poc', mutated, '/tmp/ws-other/.amazonq/mcp.json')).to.be.false
        })

        it('does not match when server name differs', async () => {
            await recordApproval(workspace, logger, 'poc', cfg, configPath)
            expect(await hasApproval(workspace, logger, 'other', cfg, configPath)).to.be.false
        })

        it('dedupes repeated approvals for the same key', async () => {
            await recordApproval(workspace, logger, 'poc', cfg, configPath)
            await recordApproval(workspace, logger, 'poc', cfg, configPath)
            const stored = JSON.parse(
                fs.readFileSync(path.join(tmpHome, '.aws', 'amazonq', 'mcp-approvals.json')).toString()
            )
            expect(stored.approvals).to.have.lengthOf(1)
        })

        it('evicts stale entry when config changes for same server and workspace', async () => {
            await recordApproval(workspace, logger, 'poc', cfg, configPath)
            const mutated: MCPServerConfig = { command: 'sh', args: ['-c', 'echo changed'] }
            await recordApproval(workspace, logger, 'poc', mutated, configPath)
            const stored = JSON.parse(
                fs.readFileSync(path.join(tmpHome, '.aws', 'amazonq', 'mcp-approvals.json')).toString()
            )
            // Should have exactly 1 entry — the old fingerprint was evicted
            expect(stored.approvals).to.have.lengthOf(1)
            expect(stored.approvals[0].fingerprint).to.equal(fingerprintServerConfig(mutated))
        })

        it('ignores a store with unrecognized version', async () => {
            const storeDir = path.join(tmpHome, '.aws', 'amazonq')
            fs.mkdirSync(storeDir, { recursive: true })
            fs.writeFileSync(path.join(storeDir, 'mcp-approvals.json'), JSON.stringify({ version: 999, approvals: [] }))
            // record should still work (overwrites with the current version)
            await recordApproval(workspace, logger, 'poc', cfg, configPath)
            expect(await hasApproval(workspace, logger, 'poc', cfg, configPath)).to.be.true
        })

        // STORE_VERSION 1 -> 2: v1 fingerprints were computed over a narrower field set and
        // cannot be trusted to cover the merged env/headers, so they are discarded and the
        // user is re-prompted once per workspace-scoped server after upgrade.
        it('discards legacy v1 approvals so the user is re-prompted once after upgrade', async () => {
            const storeDir = path.join(tmpHome, '.aws', 'amazonq')
            fs.mkdirSync(storeDir, { recursive: true })
            fs.writeFileSync(
                path.join(storeDir, 'mcp-approvals.json'),
                JSON.stringify({
                    version: 1,
                    approvals: [
                        {
                            serverName: 'poc',
                            fingerprint: fingerprintServerConfig(cfg),
                            workspaceHash: fingerprintWorkspace(configPath),
                            approvedAt: new Date().toISOString(),
                        },
                    ],
                })
            )
            expect(await hasApproval(workspace, logger, 'poc', cfg, configPath)).to.be.false
        })

        it('treats a malformed store as empty', async () => {
            const storeDir = path.join(tmpHome, '.aws', 'amazonq')
            fs.mkdirSync(storeDir, { recursive: true })
            fs.writeFileSync(path.join(storeDir, 'mcp-approvals.json'), 'not json')
            expect(await hasApproval(workspace, logger, 'poc', cfg, configPath)).to.be.false
        })

        it('removeApproval clears a previously recorded approval', async () => {
            await recordApproval(workspace, logger, 'poc', cfg, configPath)
            expect(await hasApproval(workspace, logger, 'poc', cfg, configPath)).to.be.true
            await removeApproval(workspace, logger, 'poc', configPath)
            expect(await hasApproval(workspace, logger, 'poc', cfg, configPath)).to.be.false
        })

        it('removeApproval is a no-op when no matching server name exists', async () => {
            await recordApproval(workspace, logger, 'poc', cfg, configPath)
            await removeApproval(workspace, logger, 'other', configPath)
            // Original approval should still be there
            expect(await hasApproval(workspace, logger, 'poc', cfg, configPath)).to.be.true
        })

        it('removeApproval is scoped to the workspace it was called for', async () => {
            const wsA = '/tmp/ws-a/.amazonq/mcp.json'
            const wsB = '/tmp/ws-b/.amazonq/mcp.json'
            await recordApproval(workspace, logger, 'poc', cfg, wsA)
            await recordApproval(workspace, logger, 'poc', cfg, wsB)
            // Removing the server in workspace A must not revoke workspace B's consent.
            await removeApproval(workspace, logger, 'poc', wsA)
            expect(await hasApproval(workspace, logger, 'poc', cfg, wsA)).to.be.false
            expect(await hasApproval(workspace, logger, 'poc', cfg, wsB)).to.be.true
        })
    })
})
