import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { URI } from 'vscode-uri'
import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { resolveSymlinkAwarePath, requiresPathAcceptance } from './toolShared'

/**
 * Real-filesystem tests for the symlink-aware workspace-boundary guard used by
 * the file-writing/reading tools (fsWrite, fsRead, fsReplace, listDirectory,
 * fileSearch) via requiresPathAcceptance. These exercise symlink resolution
 * against the actual filesystem, since the guard's whole purpose is to reason
 * about where a path physically lands, so they intentionally do not stub path
 * utilities.
 *
 * The tests are OS-agnostic: paths are built with `path.join`, and both sides
 * of every path assertion are normalized through the same fs.promises.realpath
 * the production code uses (see `canon`). This matters on Windows, where the
 * temp dir can surface as an 8.3 short name (e.g. RUNNER~1) that fs.realpath
 * expands to the long name (runneradmin); normalizing both sides identically
 * keeps the assertions stable. Any test that needs a symlink skips itself where
 * the platform or user cannot create one (e.g. Windows without the privilege).
 */
describe('workspace boundary symlink handling', () => {
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

    /**
     * Canonicalize a path the same way the production guard does
     * (fs.promises.realpath), resolving the deepest existing ancestor for paths
     * that do not exist yet. Used on BOTH sides of path assertions so a
     * Windows 8.3 short name never causes a spurious mismatch.
     */
    const canon = async (p: string): Promise<string> => {
        try {
            return await fs.promises.realpath(p)
        } catch {
            return path.join(await fs.promises.realpath(path.dirname(p)), path.basename(p))
        }
    }

    /** Create a symlink, returning false if the platform/user cannot. */
    const trySymlink = (target: string, linkPath: string): boolean => {
        try {
            fs.symlinkSync(target, linkPath)
            return true
        } catch {
            return false
        }
    }

    beforeEach(() => {
        const realTmp = fs.realpathSync(os.tmpdir())
        root = fs.mkdtempSync(path.join(realTmp, 'wsb-'))
        ws = path.join(root, 'workspace')
        outside = path.join(root, 'outside')
        fs.mkdirSync(ws)
        fs.mkdirSync(outside)
    })

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true })
    })

    describe('resolveSymlinkAwarePath', () => {
        it('resolves a dangling leaf symlink to its (outside) target', async function () {
            const target = path.join(outside, 'authorized_keys') // does not exist yet
            const link = path.join(ws, 'setup-notes.md')
            if (!trySymlink(target, link)) {
                return this.skip()
            }
            const resolved = await resolveSymlinkAwarePath(link)
            assert.strictEqual(await canon(resolved), await canon(target))
        })

        it('resolves a nonexistent leaf under a symlinked ancestor to the real (outside) location', async function () {
            const linkDir = path.join(ws, 'sub') // -> outside
            if (!trySymlink(outside, linkDir)) {
                return this.skip()
            }
            const resolved = await resolveSymlinkAwarePath(path.join(linkDir, 'newfile.txt'))
            assert.strictEqual(await canon(resolved), await canon(path.join(outside, 'newfile.txt')))
        })

        it('leaves a plain not-yet-created in-workspace path inside the workspace', async () => {
            const resolved = await resolveSymlinkAwarePath(path.join(ws, 'brand-new.txt'))
            assert.strictEqual(await canon(resolved), await canon(path.join(ws, 'brand-new.txt')))
        })

        it('canonicalizes an existing regular file', async () => {
            const file = path.join(ws, 'exists.txt')
            fs.writeFileSync(file, 'x')
            const resolved = await resolveSymlinkAwarePath(file)
            assert.strictEqual(await canon(resolved), await canon(file))
        })

        it('follows a chain of symlinks to the final (outside) target', async function () {
            const finalTarget = path.join(outside, 'chained.txt')
            const mid = path.join(ws, 'mid')
            const head = path.join(ws, 'head')
            if (!trySymlink(finalTarget, mid) || !trySymlink(mid, head)) {
                return this.skip()
            }
            const resolved = await resolveSymlinkAwarePath(head)
            assert.strictEqual(await canon(resolved), await canon(finalTarget))
        })
    })

    describe('requiresPathAcceptance (write/read guard)', () => {
        it('requires acceptance for a dangling in-workspace symlink that points outside', async function () {
            const target = path.join(outside, 'authorized_keys') // dangling: parent exists, file does not
            const link = path.join(ws, 'setup-notes.md')
            if (!trySymlink(target, link)) {
                return this.skip()
            }
            const result = await requiresPathAcceptance(link, 'fsWrite', makeWorkspace(ws), noopLogging)
            assert.strictEqual(result.requiresAcceptance, true)
        })

        it('does not require acceptance for a normal new in-workspace file', async () => {
            const result = await requiresPathAcceptance(
                path.join(ws, 'notes.md'),
                'fsWrite',
                makeWorkspace(ws),
                noopLogging
            )
            assert.strictEqual(result.requiresAcceptance, false)
        })

        it('still requires acceptance for a symlink to an existing outside file (regression)', async function () {
            const target = path.join(outside, 'existing.txt')
            fs.writeFileSync(target, 'secret')
            const link = path.join(ws, 'link.txt')
            if (!trySymlink(target, link)) {
                return this.skip()
            }
            const result = await requiresPathAcceptance(link, 'fsWrite', makeWorkspace(ws), noopLogging)
            assert.strictEqual(result.requiresAcceptance, true)
        })

        it('does not raise a false prompt when the workspace itself lives under a symlinked directory', async function () {
            // Simulate macOS-style /tmp -> /private/tmp: workspace reached via a symlink.
            const realWs = path.join(root, 'realws')
            fs.mkdirSync(realWs)
            const symWs = path.join(root, 'linkws')
            if (!trySymlink(realWs, symWs)) {
                return this.skip()
            }
            // A new file created through the symlinked workspace path is genuinely in-workspace.
            const result = await requiresPathAcceptance(
                path.join(symWs, 'inside.txt'),
                'fsWrite',
                makeWorkspace(symWs),
                noopLogging
            )
            assert.strictEqual(result.requiresAcceptance, false)
        })
    })
})
