import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { URI } from 'vscode-uri'
import sinon from 'ts-sinon'
import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { LocalProjectContextController } from '../../../shared/localProjectContextController'
import { FsRead } from './fsRead'
import { FsWrite } from './fsWrite'
import { resolveCanonicalPath } from './toolShared'
import { withCheckedFileOperations } from './checkedFileFixtures.test'

/**
 * Tests for paths whose canonical form cannot be computed.
 *
 * `fs.realpath` fails when the fully resolved path exceeds the platform limit,
 * even when the input string is short, while per-component kernel resolution
 * of the same string may still succeed. `resolveSymlinkAwarePath` propagates
 * that failure; the approval check reports it as a validation error and the
 * file tools receive no checked target to act on.
 *
 * Fixture: a real directory chain under <base>/outside, nested deep enough that
 * its absolute path exceeds the resolver's limit, reached from the workspace
 * through a few short relative symlink hops. Each hop target stays under 1024
 * characters so the links can be created on filesystems that cap symlink
 * length (macOS). Skips on Windows and where symlinks cannot be created.
 */
describe('path canonicalization failure', () => {
    const SEG = 'a'.repeat(200) // below NAME_MAX (255)
    const TOTAL_LEVELS = 24 // 24 * ~201 chars exceeds PATH_MAX (4096)
    const HOP_EVERY = 4 // hop target ~803 chars, under the 1024 symlink cap
    const SECRET = 'OUTSIDE-WORKSPACE-CONTENT\n'

    let base: string
    let ws: string
    let outside: string
    let startCwd: string
    let hopNames: string[] = []
    let supported = true

    const noopLogging = {
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
        debug: () => {},
    } as unknown as Features['logging']

    const exists = (p: string) =>
        fs.promises
            .access(p)
            .then(() => true)
            .catch(() => false)

    const makeFeatures = (): Pick<Features, 'logging' | 'workspace' | 'lsp'> => {
        const features = {
            logging: noopLogging,
            lsp: {},
            workspace: {
                getAllWorkspaceFolders: () => [{ uri: URI.file(ws).toString(), name: 'ws' }],
                fs: {
                    exists,
                    readFile: (p: string) => fs.promises.readFile(p, 'utf-8'),
                    writeFile: (p: string, content: string) => fs.promises.writeFile(p, content),
                },
            },
        } as unknown as Pick<Features, 'logging' | 'workspace' | 'lsp'>
        features.workspace.fs = withCheckedFileOperations(features.workspace.fs)
        return features
    }

    /** Descend from `outside` by `n` segments via chdir; an absolute path past PATH_MAX cannot be opened directly. */
    const descend = (n: number) => {
        process.chdir(outside)
        for (let i = 0; i < n; i++) process.chdir(SEG)
    }

    /** Read the fixture file through the kernel, independent of any code under test. */
    const readOutsideFile = (): string => {
        descend(TOTAL_LEVELS)
        try {
            return fs.readFileSync('target.txt', 'utf8')
        } finally {
            process.chdir(startCwd)
        }
    }

    /** Whether the not-yet-created leaf now exists at the outside location. */
    const outsideLeafExists = (name: string): boolean => {
        descend(TOTAL_LEVELS)
        try {
            return fs.existsSync(name)
        } finally {
            process.chdir(startCwd)
        }
    }

    /**
     * fs.rmSync builds absolute paths and fails with ENAMETOOLONG on this fixture
     * for the same reason the code under test does. Unwind the deep chain
     * bottom-up via chdir, then remove the (now shallow) rest.
     */
    const removeFixture = () => {
        try {
            process.chdir(startCwd)
        } catch {}
        try {
            process.chdir(outside)
            let depth = 0
            while (fs.existsSync(SEG)) {
                process.chdir(SEG)
                depth++
            }
            for (; depth > 0; depth--) {
                for (const entry of fs.readdirSync('.')) fs.rmSync(entry, { recursive: true, force: true })
                process.chdir('..')
                fs.rmdirSync(SEG)
            }
        } catch {
            // Best effort; the base removal below surfaces anything left.
        } finally {
            process.chdir(startCwd)
        }
        fs.rmSync(base, { recursive: true, force: true })
    }

    before(function () {
        if (process.platform === 'win32') {
            supported = false
            this.skip()
        }
        startCwd = process.cwd()
        // Canonicalize the base: the gate canonicalizes workspace folders, so a
        // symlinked prefix on the workspace itself would mask the behavior under
        // test rather than exercise it.
        base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canon-fail-')))
        ws = path.join(base, 'workspace')
        outside = path.join(base, 'outside')
        fs.mkdirSync(ws)
        fs.mkdirSync(outside)

        const numHops = TOTAL_LEVELS / HOP_EVERY - 1
        hopNames = Array.from({ length: numHops }, (_, i) => `hop${i + 1}`)

        try {
            process.chdir(outside)
            for (let i = 0; i < TOTAL_LEVELS; i++) {
                fs.mkdirSync(SEG)
                process.chdir(SEG)
            }
            fs.writeFileSync('target.txt', SECRET)
            process.chdir(startCwd)

            const jump = Array(HOP_EVERY).fill(SEG).join('/')
            for (let k = 1; k <= numHops; k++) {
                descend(k * HOP_EVERY)
                fs.symlinkSync(jump, hopNames[k - 1])
            }
            process.chdir(startCwd)
            fs.symlinkSync(['..', 'outside', ...Array(HOP_EVERY).fill(SEG)].join('/'), path.join(ws, 'link'))
        } catch (e: any) {
            removeFixture()
            if (e && (e.code === 'EPERM' || e.code === 'ENOSYS')) {
                supported = false
                this.skip()
            }
            throw e
        }
    })

    after(() => {
        if (base) removeFixture()
    })

    beforeEach(() => {
        sinon.stub(LocalProjectContextController, 'getInstance').resolves({
            updateIndexAndContextCommand: sinon.stub().resolves(),
        } as unknown as LocalProjectContextController)
    })

    afterEach(() => {
        sinon.restore()
    })

    const inputFor = (leaf: string) => path.join(ws, 'link', ...hopNames, leaf)
    const existingInput = () => inputFor('target.txt')
    const missingInput = () => inputFor('not-created-yet.txt')

    it('precondition: realpath fails on the short input while per-component resolution succeeds', function () {
        if (!supported) this.skip()
        const input = existingInput()
        assert.ok(input.length < 160, `input should be short, was ${input.length}`)
        assert.throws(
            () => fs.realpathSync(input),
            (e: NodeJS.ErrnoException) => e.code === 'ENAMETOOLONG'
        )
        assert.strictEqual(fs.lstatSync(input).isSymbolicLink(), false, 'leaf must be an ordinary file')
        assert.strictEqual(fs.readFileSync(input, 'utf8'), SECRET, 'kernel open+read must reach the target')
    })

    describe('resolver', () => {
        it('rejects for an existing leaf', async function () {
            if (!supported) this.skip()
            await assert.rejects(resolveCanonicalPath(existingInput()), (e: NodeJS.ErrnoException) => {
                assert.strictEqual(e.code, 'ENAMETOOLONG')
                return true
            })
        })

        it('rejects for a not-yet-created leaf whose parent cannot be canonicalized', async function () {
            if (!supported) this.skip()
            await assert.rejects(resolveCanonicalPath(missingInput()), (e: NodeJS.ErrnoException) => {
                assert.strictEqual(e.code, 'ENAMETOOLONG')
                return true
            })
        })
    })

    describe('file tools', () => {
        // The tools' acceptance checks run with the production options and the
        // real checked-I/O seam. With no checked target the controller does not
        // run the tool; these tests also confirm the fixture is unchanged.
        it('fsRead: acceptance reports a validation error and yields no target', async function () {
            if (!supported) this.skip()
            const tool = new FsRead(makeFeatures())
            const approval = await tool.requiresAcceptance({ paths: [existingInput()] })

            assert.strictEqual(approval.requiresAcceptance, true)
            assert.strictEqual((approval.validationError as NodeJS.ErrnoException)?.code, 'ENAMETOOLONG')
            assert.strictEqual(approval.checkedTargets, undefined)
            // invoke requires a target per path; it does not resolve the input itself.
            await assert.rejects(tool.invoke({ paths: [existingInput()] }, []))
        })

        it('fsWrite append: acceptance reports a validation error and the file is unchanged', async function () {
            if (!supported) this.skip()
            const tool = new FsWrite(makeFeatures())
            const params = { command: 'append' as const, path: existingInput(), fileText: 'APPENDED' }
            const approval = await tool.requiresAcceptance(params)

            assert.strictEqual(approval.requiresAcceptance, true)
            assert.strictEqual((approval.validationError as NodeJS.ErrnoException)?.code, 'ENAMETOOLONG')
            assert.strictEqual(approval.checkedTargets, undefined)
            assert.strictEqual(readOutsideFile(), SECRET)
        })

        it('fsWrite create: acceptance reports a validation error and no file is created', async function () {
            if (!supported) this.skip()
            const tool = new FsWrite(makeFeatures())
            const params = { command: 'create' as const, path: missingInput(), fileText: 'NEW' }
            const approval = await tool.requiresAcceptance(params)

            assert.strictEqual(approval.requiresAcceptance, true)
            assert.strictEqual((approval.validationError as NodeJS.ErrnoException)?.code, 'ENAMETOOLONG')
            assert.strictEqual(approval.checkedTargets, undefined)
            assert.strictEqual(outsideLeafExists('not-created-yet.txt'), false)
        })
    })
})
