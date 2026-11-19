import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { URI } from 'vscode-uri'
import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { isPathExactlyApproved, needsExactApproval, requiresPathAcceptance } from './toolShared'
import { checkedTarget, withCheckedFileOperations } from './checkedFileFixtures.test'
import { ExistingFileTarget } from '@aws/language-server-runtimes/server-interface'

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

    /** Runs `fn` with process.platform reporting `platform` */
    const onPlatform = async <T>(platform: NodeJS.Platform, fn: () => Promise<T> | T): Promise<T> => {
        const original = Object.getOwnPropertyDescriptor(process, 'platform')!
        Object.defineProperty(process, 'platform', { value: platform })
        try {
            return await fn()
        } finally {
            Object.defineProperty(process, 'platform', original)
        }
    }

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
                path.join(outside, '.kube', 'config'),
                path.join(outside, '.gnupg'),
                path.join(outside, '.docker', 'config.json'),
                path.join(outside, '.azure', 'msal_token_cache.json'),
                path.join(outside, '.config', 'gcloud', 'credentials.db'),
                path.join(outside, 'AppData', 'Roaming', 'gcloud', 'credentials.db'),
                path.join(outside, 'Library', 'Keychains', 'login.keychain-db'),
                path.join(outside, '.netrc'),
                path.join(outside, '_netrc'),
                path.join(outside, '.git-credentials'),
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
                path.join(outside, 'app', '.dockerignore'),
                path.join(outside, 'docker', 'compose.yml'),
                path.join(outside, '.config', 'gcloud-tools', 'notes.txt'),
                path.join(outside, 'notes.netrc.md'),
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

            for (const filePath of ['/etc/hosts', '/PRIVATE/ETC/hosts']) {
                const result = await requiresPathAcceptance(
                    filePath,
                    'fsRead',
                    makeWorkspace(ws),
                    noopLogging,
                    approvedFor('fsRead', '/')
                )

                assert.strictEqual(result.requiresAcceptance, true, filePath)
            }
        })

        it('requires acceptance on Windows for a path segment that Windows can open under another name', async () => {
            for (const filePath of [
                `${outside}/.aws./credentials`,
                `${outside}/.aws /credentials`,
                `${outside}/.aws::$INDEX_ALLOCATION/credentials`,
            ]) {
                const result = await onPlatform('win32', () =>
                    requiresPathAcceptance(
                        filePath,
                        'fsRead',
                        makeWorkspace(ws),
                        noopLogging,
                        approvedFor('fsRead', outside)
                    )
                )

                assert.strictEqual(result.requiresAcceptance, true, filePath)
            }
        })
    })

    describe('needsExactApproval', () => {
        it('matches Windows system and credential paths', () => {
            for (const filePath of [
                'C:\\Windows\\System32\\config\\SAM',
                'c:\\windows\\system32\\CONFIG',
                '\\\\localhost\\C$\\Windows\\System32\\config\\SAM',
                'C:\\Users\\me\\.aws\\credentials',
                'C:\\Users\\me\\AppData\\Roaming\\gcloud\\credentials.db',
                'C:\\Users\\me\\_netrc',
            ]) {
                assert.strictEqual(needsExactApproval(filePath), true, filePath)
            }
            assert.strictEqual(needsExactApproval('C:\\Windows\\System32\\drivers\\README.txt'), false)
            assert.strictEqual(needsExactApproval('C:\\Users\\me\\project\\config\\app.json'), false)
        })

        it('matches a segment that ends with a dot or a space, or contains a colon, only on Windows', async () => {
            const ambiguous = [
                'C:\\Users\\me\\notes.\\a.txt',
                'C:\\Users\\me\\notes \\a.txt',
                'C:\\Users\\me\\a.txt:stream',
            ]

            await onPlatform('win32', () => {
                for (const filePath of ambiguous) {
                    assert.strictEqual(needsExactApproval(filePath), true, filePath)
                }
                assert.strictEqual(needsExactApproval('C:\\Users\\me\\..\\me\\.\\a.txt'), false)
                assert.strictEqual(needsExactApproval('C:\\Users\\RUNNER~1\\a.txt'), false)
            })
            await onPlatform('linux', () => {
                for (const filePath of ambiguous) {
                    assert.strictEqual(needsExactApproval(filePath), false, filePath)
                }
            })
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

        it('requires acceptance for such a file when only its path is approved', async function () {
            const filePath = linkedFile(ws)
            if (!filePath) {
                return this.skip()
            }

            const result = await check(filePath, 'fsRead', approvedFor('fsRead', filePath))

            assert.strictEqual(result.requiresAcceptance, true)
            assert.strictEqual(result.acceptanceReason, 'multiplyLinkedFile')
        })

        describe('approved as it was when approved', () => {
            const checkApproved = (filePath: string, approvedFile: ExistingFileTarget) =>
                requiresPathAcceptance(
                    filePath,
                    'fsRead',
                    makeCheckedWorkspace(ws),
                    noopLogging,
                    approvedFor('fsRead', filePath),
                    { flagMultiplyLinkedFiles: 'read', approvedLinkedFiles: new Map([['fsRead', [approvedFile]]]) }
                )

            // The file, as the check captures it, while it has a second name
            const approvedLinkedFile = async (folder: string) => {
                const filePath = linkedFile(folder)
                const target = filePath ? await checkedTarget(filePath) : undefined
                return filePath && target?.state === 'existing' ? { filePath, target } : undefined
            }

            it('does not require acceptance for the same file', async function () {
                const approved = await approvedLinkedFile(outside)
                if (!approved) {
                    return this.skip()
                }

                const result = await checkApproved(approved.filePath, approved.target)

                assert.strictEqual(result.requiresAcceptance, false)
            })

            it('requires acceptance after the path names another file with a second name', async function () {
                const approved = await approvedLinkedFile(ws)
                if (!approved) {
                    return this.skip()
                }
                const replacement = path.join(root, 'replacement.txt')
                fs.writeFileSync(replacement, 'synthetic fixture only')
                fs.rmSync(approved.filePath)
                fs.linkSync(replacement, approved.filePath)

                const result = await checkApproved(approved.filePath, approved.target)

                assert.strictEqual(result.requiresAcceptance, true)
            })

            it('requires acceptance after the file gets another name', async function () {
                const approved = await approvedLinkedFile(ws)
                if (!approved) {
                    return this.skip()
                }
                fs.linkSync(approved.filePath, path.join(root, 'third-name.txt'))

                const result = await checkApproved(approved.filePath, approved.target)

                assert.strictEqual(result.requiresAcceptance, true)
            })

            it('does not cover the file for another tool', async function () {
                const approved = await approvedLinkedFile(ws)
                if (!approved) {
                    return this.skip()
                }

                const result = await requiresPathAcceptance(
                    approved.filePath,
                    'fsWrite',
                    makeCheckedWorkspace(ws),
                    noopLogging,
                    approvedFor('fsWrite', approved.filePath),
                    { flagMultiplyLinkedFiles: 'modify', approvedLinkedFiles: new Map([['fsRead', [approved.target]]]) }
                )

                assert.strictEqual(result.requiresAcceptance, true)
            })

            it('requires acceptance on Windows, where the check captures no file identity', async function () {
                const filePath = linkedFile(ws)
                if (!filePath) {
                    return this.skip()
                }
                const approvedFile = { path: filePath, state: 'existing', dev: '1', ino: '1', linkCount: '2' } as const

                const result = await onPlatform('win32', () => checkApproved(filePath, approvedFile))

                assert.strictEqual(result.requiresAcceptance, true)
            })
        })

        it('does not require acceptance for a file with one name under an approved directory', async () => {
            const filePath = path.join(outside, 'notes.txt')
            fs.writeFileSync(filePath, 'synthetic fixture only')

            const result = await check(filePath, 'fsRead', approvedFor('fsRead', outside))

            assert.strictEqual(result.requiresAcceptance, false)
        })
    })
})
