import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { URI } from 'vscode-uri'
import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { isPathExactlyApproved, requiresPathAcceptance } from './toolShared'

/**
 * Real-filesystem tests for how approved paths apply in requiresPathAcceptance.
 * Paths are canonicalized with fs.promises.realpath on both sides, so a Windows
 * 8.3 short name in the temp directory does not cause a mismatch.
 */
describe('approved path handling', () => {
    let root: string
    let ws: string
    let outside: string

    const noopLogging = {
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
        debug: () => {},
    } as unknown as Features['logging']

    const makeWorkspace = (folder: string): Features['workspace'] =>
        ({
            getAllWorkspaceFolders: () => [{ uri: URI.file(folder).toString(), name: 'ws' }],
        }) as unknown as Features['workspace']

    const approvedFor = (toolName: string, ...paths: string[]) => new Map([[toolName, new Set(paths)]])

    beforeEach(async () => {
        const realTmp = fs.realpathSync(os.tmpdir())
        root = fs.mkdtempSync(path.join(realTmp, 'apb-'))
        ws = path.join(root, 'workspace')
        outside = path.join(root, 'outside')
        fs.mkdirSync(ws)
        fs.mkdirSync(outside)
        outside = await fs.promises.realpath(outside)
    })

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true })
    })

    describe('isPathExactlyApproved', () => {
        it('matches only the approved path, not paths under it', () => {
            const approved = approvedFor('fsRead', '/approved/dir')

            assert.strictEqual(isPathExactlyApproved('/approved/dir', 'fsRead', approved), true)
            assert.strictEqual(isPathExactlyApproved('/approved/dir/file.txt', 'fsRead', approved), false)
            assert.strictEqual(isPathExactlyApproved('/approved/dir', 'fsWrite', approved), false)
            assert.strictEqual(isPathExactlyApproved('/approved/dir', 'fsRead', undefined), false)
        })
    })

    describe('requiresPathAcceptance', () => {
        for (const toolName of ['fsRead', 'fsWrite', 'fsReplace', 'listDirectory', 'fileSearch']) {
            it(`does not require acceptance for an ordinary file under an approved directory (${toolName})`, async () => {
                const result = await requiresPathAcceptance(
                    path.join(outside, 'notes.txt'),
                    toolName,
                    makeWorkspace(ws),
                    noopLogging,
                    approvedFor(toolName, outside)
                )

                assert.strictEqual(result.requiresAcceptance, false)
            })

            it(`requires acceptance for a sensitive path under an approved directory (${toolName})`, async () => {
                const result = await requiresPathAcceptance(
                    `${outside}/.aws/credentials`,
                    toolName,
                    makeWorkspace(ws),
                    noopLogging,
                    approvedFor(toolName, outside)
                )

                assert.strictEqual(result.requiresAcceptance, true)
                assert.strictEqual(result.warning, 'Access to sensitive system files requires explicit approval')
            })
        }

        it('does not require acceptance for a sensitive path that was itself approved', async () => {
            const sensitivePath = path.join(outside, '.aws', 'credentials')

            const result = await requiresPathAcceptance(
                sensitivePath,
                'fsRead',
                makeWorkspace(ws),
                noopLogging,
                approvedFor('fsRead', sensitivePath)
            )

            assert.strictEqual(result.requiresAcceptance, false)
        })

        it('treats a sensitive path written with backslashes as sensitive', async () => {
            const result = await requiresPathAcceptance(
                `${outside}\\.ssh\\id_ed25519`,
                'fsRead',
                makeWorkspace(ws),
                noopLogging,
                approvedFor('fsRead', outside)
            )

            assert.strictEqual(result.requiresAcceptance, true)
            assert.strictEqual(result.warning, 'Access to sensitive system files requires explicit approval')
        })

        it('does not treat a folder named dev in a Windows path as sensitive', async () => {
            const result = await requiresPathAcceptance(
                `${outside}\\dev\\notes.txt`,
                'fsRead',
                makeWorkspace(ws),
                noopLogging,
                approvedFor('fsRead', outside)
            )

            assert.strictEqual(result.warning, undefined)
        })

        it('does not change acceptance for sensitive-looking names inside the workspace', async () => {
            const canonicalWs = await fs.promises.realpath(ws)

            const result = await requiresPathAcceptance(
                path.join(ws, 'config', 'credentials.ts'),
                'fsWrite',
                makeWorkspace(ws),
                noopLogging,
                approvedFor('fsWrite', canonicalWs)
            )

            assert.strictEqual(result.requiresAcceptance, false)
        })
    })
})
