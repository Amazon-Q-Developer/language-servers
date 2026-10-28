import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { URI } from 'vscode-uri'
import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { isPathExactlyApproved, requiresPathAcceptance } from './toolShared'
import { withCheckedFileOperations } from './checkedFileFixtures.test'

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

        it('requires acceptance for credential folders, and other spellings of credential paths, under an approved directory', async () => {
            for (const filePath of [
                path.join(outside, '.ssh'),
                path.join(outside, '.aws'),
                path.join(outside, '.SSH', 'authorized_keys'),
                path.join(outside, 'app', '.ENV'),
                path.join(outside, 'app', '.env.local'),
            ]) {
                const result = await requiresPathAcceptance(
                    filePath,
                    'fsRead',
                    makeWorkspace(ws),
                    noopLogging,
                    approvedFor('fsRead', outside)
                )

                assert.strictEqual(result.requiresAcceptance, true, filePath)
                assert.strictEqual(result.warning, 'Access to sensitive system files requires explicit approval')
            }
        })

        it('does not require acceptance for ordinary files with sensitive-looking names under an approved directory', async () => {
            for (const filePath of [
                path.join(outside, 'dev', 'repo', 'src', 'index.ts'),
                path.join(outside, 'src', 'secretManager.ts'),
                path.join(outside, 'docs', 'password-reset.md'),
            ]) {
                const result = await requiresPathAcceptance(
                    filePath,
                    'fsRead',
                    makeWorkspace(ws),
                    noopLogging,
                    approvedFor('fsRead', outside)
                )

                assert.strictEqual(result.requiresAcceptance, false, filePath)
            }
        })

        it('requires acceptance for a system folder path when only the root is approved', async function () {
            if (process.platform === 'win32') {
                return this.skip()
            }

            const result = await requiresPathAcceptance(
                '/etc/hosts',
                'fsRead',
                makeWorkspace(ws),
                noopLogging,
                approvedFor('fsRead', '/')
            )

            assert.strictEqual(result.requiresAcceptance, true)
        })
    })

    describe('files that share their data with another name', () => {
        const makeCheckedWorkspace = (folder: string): Features['workspace'] =>
            ({
                getAllWorkspaceFolders: () => [{ uri: URI.file(folder).toString(), name: 'ws' }],
                fs: withCheckedFileOperations({} as Features['workspace']['fs']),
            }) as unknown as Features['workspace']

        const check = (filePath: string, toolName: string, approvedPaths: Map<string, Set<string>>) =>
            requiresPathAcceptance(filePath, toolName, makeCheckedWorkspace(ws), noopLogging, approvedPaths, {
                flagMultiplyLinkedFiles: toolName === 'fsRead' ? 'read' : 'modify',
            })

        // A file in `folder` that has a second name elsewhere
        const linkedFile = (folder: string): string | undefined => {
            const other = path.join(root, 'other.txt')
            fs.writeFileSync(other, 'synthetic fixture only')
            const filePath = path.join(folder, 'alias.txt')
            try {
                fs.linkSync(other, filePath)
                return filePath
            } catch {
                return undefined
            }
        }

        for (const toolName of ['fsRead', 'fsWrite']) {
            it(`requires acceptance for such a file under an approved directory outside the workspace (${toolName})`, async function () {
                const filePath = linkedFile(outside)
                if (!filePath) {
                    return this.skip()
                }

                const result = await check(filePath, toolName, approvedFor(toolName, outside))

                assert.strictEqual(result.requiresAcceptance, true)
                assert.strictEqual(result.acceptanceReason, undefined)
                assert.ok(result.warning)
            })
        }

        it('requires acceptance for such a file in the workspace when a folder above it is approved', async function () {
            const filePath = linkedFile(ws)
            if (!filePath) {
                return this.skip()
            }

            const result = await check(filePath, 'fsWrite', approvedFor('fsWrite', root))

            assert.strictEqual(result.requiresAcceptance, true)
            assert.strictEqual(result.acceptanceReason, 'multiplyLinkedFile')
        })

        it('does not require acceptance for such a file when the file itself is approved', async function () {
            const filePath = linkedFile(outside)
            if (!filePath) {
                return this.skip()
            }

            const result = await check(filePath, 'fsRead', approvedFor('fsRead', filePath))

            assert.strictEqual(result.requiresAcceptance, false)
        })

        it('does not require acceptance for a file with one name under an approved directory', async () => {
            const filePath = path.join(outside, 'notes.txt')
            fs.writeFileSync(filePath, 'synthetic fixture only')

            const result = await check(filePath, 'fsRead', approvedFor('fsRead', outside))

            assert.strictEqual(result.requiresAcceptance, false)
        })
    })
})
