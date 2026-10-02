/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable import/no-nodejs-modules */

// Real-filesystem tests for the CodeReview artifact workspace-boundary guard.
// The guard's whole purpose is to reason about where an artifact path
// physically lands, so these tests exercise real symlinks, hard links, and
// directory walks against the actual filesystem instead of stubbing path
// utilities. Every fixture is synthetic: no credentials, tickets, hostnames,
// account IDs, or reporter payloads appear anywhere. Any test that needs a
// symlink or hard link skips itself where the platform or user cannot create
// one. Network I/O (createUploadUrl / the upload PUT / startCodeAnalysis) is
// stubbed and asserted; nothing is ever uploaded.

import { CodeReview } from './codeReview'
import { CodeReviewUtils } from './codeReviewUtils'
import { FULL_REVIEW } from './codeReviewConstants'
import * as sinon from 'sinon'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { expect } from 'chai'
import { URI } from 'vscode-uri'
import JSZip = require('jszip')

const noopLogging = {
    info: () => {},
    warn: () => {},
    error: () => {},
    log: () => {},
    debug: () => {},
} as any

/** Assert a promise rejects with a message matching `pattern` (no chai-as-promised in this package). */
const expectRejects = async (promise: Promise<unknown>, pattern: RegExp): Promise<void> => {
    let threw = false
    try {
        await promise
    } catch (e: any) {
        threw = true
        expect(e.message, `error message should match ${pattern}`).to.match(pattern)
    }
    expect(threw, 'expected the operation to reject').to.equal(true)
}

/** Canonicalize the same way the guard does, so a Win8.3 short name never causes a spurious mismatch. */
const canon = async (p: string): Promise<string> => {
    try {
        return await fs.promises.realpath(p)
    } catch {
        return path.join(await fs.promises.realpath(path.dirname(p)), path.basename(p))
    }
}

// Only skip a link-dependent test when the platform/user/filesystem genuinely
// cannot create the link. Any OTHER failure (a fixture bug, a wrong path) is
// rethrown so it surfaces as a failure instead of a silent skip.
const LINK_UNSUPPORTED_CODES = new Set(['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'])

/** Create a symlink, returning false only when the platform/user cannot; rethrows unexpected errors. */
const trySymlink = (target: string, link: string, type?: 'file' | 'dir' | 'junction'): boolean => {
    try {
        fs.symlinkSync(target, link, type)
        return true
    } catch (e: any) {
        if (e && LINK_UNSUPPORTED_CODES.has(e.code)) {
            return false
        }
        throw e
    }
}

/** Create a hard link, returning false only when the platform/filesystem cannot; rethrows unexpected errors. */
const tryHardlink = (target: string, link: string): boolean => {
    try {
        fs.linkSync(target, link)
        return true
    } catch (e: any) {
        // EXDEV: a hard link across devices is a filesystem limitation, not a bug.
        if (e && (LINK_UNSUPPORTED_CODES.has(e.code) || e.code === 'EXDEV')) {
            return false
        }
        throw e
    }
}

describe('CodeReview artifact workspace boundary (real filesystem)', () => {
    let sandbox: sinon.SinonSandbox
    let root: string
    let ws: string
    let outside: string
    let readFileStub: sinon.SinonStub
    let readdirStub: sinon.SinonStub
    let getGitDiffNamesStub: sinon.SinonStub
    let processArtifactWithDiffStub: sinon.SinonStub

    const makeCodeReview = (wsFolders: string[]): CodeReview => {
        readFileStub = sandbox.stub().callsFake((p: string) => fs.promises.readFile(p))
        readdirStub = sandbox.stub().callsFake((p: string) => fs.promises.readdir(p, { withFileTypes: true }))
        const features: any = {
            credentialsProvider: {
                getConnectionMetadata: () => ({ sso: { startUrl: 'https://example.test' } }),
            },
            logging: noopLogging,
            telemetry: { emitMetric: () => {} },
            workspace: {
                getAllWorkspaceFolders: () =>
                    wsFolders.map(f => ({ uri: URI.file(f).toString(), name: path.basename(f) })),
                fs: { readFile: readFileStub, readdir: readdirStub },
            },
        }
        return new CodeReview(features)
    }

    const prepare = (
        cr: CodeReview,
        files: Array<{ path: string }>,
        folders: Array<{ path: string }>,
        rules: Array<{ path: string }>,
        isFullReview = true
    ): Promise<any> => (cr as any).prepareFilesAndFoldersForUpload('Review please', files, folders, rules, isFullReview)

    /** Write a synthetic fixture file and return its path. */
    const mk = (dir: string, name: string, content: string): string => {
        const p = path.join(dir, name)
        fs.writeFileSync(p, content)
        return p
    }

    /** No artifact content was read and no Git command ran. */
    const assertNoReadOrGit = () => {
        sinon.assert.notCalled(readFileStub)
        sinon.assert.notCalled(getGitDiffNamesStub)
        sinon.assert.notCalled(processArtifactWithDiffStub)
    }

    const readFileArgs = (): string[] => readFileStub.getCalls().map(c => c.args[0] as string)

    /** Entries of the nested customer-code zip inside the prepared code-artifact zip. */
    const customerZipEntries = async (zipBuffer: Buffer): Promise<string[]> => {
        const outer = await JSZip.loadAsync(zipBuffer)
        const nested = await outer.file('code_artifact/customerCode.zip')!.async('nodebuffer')
        const inner = await JSZip.loadAsync(nested)
        return Object.keys(inner.files).filter(k => !inner.files[k].dir)
    }

    const customerZipEntryContent = async (zipBuffer: Buffer, suffix: string): Promise<string> => {
        const outer = await JSZip.loadAsync(zipBuffer)
        const nested = await outer.file('code_artifact/customerCode.zip')!.async('nodebuffer')
        const inner = await JSZip.loadAsync(nested)
        const key = Object.keys(inner.files).find(k => k.endsWith(suffix))
        expect(key, `expected a zip entry ending with ${suffix}`).to.not.be.undefined
        return inner.file(key!)!.async('string')
    }

    beforeEach(() => {
        sandbox = sinon.createSandbox()
        const realTmp = fs.realpathSync(os.tmpdir())
        root = fs.mkdtempSync(path.join(realTmp, 'cr-boundary-'))
        ws = path.join(root, 'workspace')
        outside = path.join(root, 'outside')
        fs.mkdirSync(ws)
        fs.mkdirSync(outside)
        // Keep the tests off the real git binary and let us assert Git never ran.
        getGitDiffNamesStub = sandbox.stub(CodeReviewUtils, 'getGitDiffNames').resolves(new Set<string>())
        sandbox.stub(CodeReviewUtils, 'getGitDiff').resolves(null)
        processArtifactWithDiffStub = sandbox.stub(CodeReviewUtils, 'processArtifactWithDiff').resolves('')
    })

    afterEach(() => {
        sandbox.restore()
        fs.rmSync(root, { recursive: true, force: true })
    })

    describe('rejects before any content read or Git command', () => {
        // Preparation never reaches the upload, so these cases assert only that
        // no artifact was read and no Git command ran. Cases that need no link
        // are table-driven; link/stat cases that must self-skip are individual.
        type RejectCase = {
            name: string
            pattern: RegExp
            wsFolders?: () => string[]
            build: () => {
                files?: Array<{ path: string }>
                folders?: Array<{ path: string }>
                rules?: Array<{ path: string }>
            }
        }

        const cases: RejectCase[] = [
            {
                name: 'no workspace folder is open',
                pattern: /no workspace folder is open/,
                wsFolders: () => [],
                build: () => ({ files: [{ path: mk(root, 'loose.js', 'x') }] }),
            },
            {
                name: 'a relative file path',
                pattern: /absolute path/,
                build: () => ({ files: [{ path: path.join('relative', 'file.js') }] }),
            },
            {
                name: 'a tilde (non-absolute) file path',
                pattern: /absolute path/,
                build: () => ({ files: [{ path: '~/file.js' }] }),
            },
            {
                name: 'a file artifact with a non-string path (shape invalid)',
                pattern: /absolute path/,
                build: () => ({ files: [{ path: undefined as any }] }),
            },
            {
                name: 'a missing file path (resolution error)',
                pattern: /does not exist or cannot be resolved/,
                build: () => ({ files: [{ path: path.join(ws, 'nope.js') }] }),
            },
            {
                name: 'a file that resolves outside the workspace',
                pattern: /inside an open workspace/,
                build: () => ({ files: [{ path: mk(outside, 'secret.js', 'secret') }] }),
            },
            {
                name: 'a folder that resolves outside the workspace',
                pattern: /inside an open workspace/,
                build: () => ({ folders: [{ path: outside }] }),
            },
            {
                name: 'a rule that resolves outside the workspace',
                pattern: /inside an open workspace/,
                build: () => ({ rules: [{ path: mk(outside, 'rule.json', '{}') }] }),
            },
            {
                name: 'a directory submitted as a file artifact',
                pattern: /not a regular file/,
                build: () => ({ files: [{ path: ws }] }),
            },
            {
                name: 'a file submitted as a folder artifact',
                pattern: /not a directory/,
                build: () => ({ folders: [{ path: mk(ws, 'app.js', 'x') }] }),
            },
            {
                name: 'a mixed good + bad file batch (before reading the good file)',
                pattern: /inside an open workspace/,
                build: () => ({
                    files: [{ path: mk(ws, 'good.js', 'ok') }, { path: mk(outside, 'secret.js', 'secret') }],
                }),
            },
        ]

        cases.forEach(c => {
            it(`rejects ${c.name}`, async () => {
                const { files = [], folders = [], rules = [] } = c.build()
                const cr = makeCodeReview(c.wsFolders ? c.wsFolders() : [ws])
                await expectRejects(prepare(cr, files, folders, rules), c.pattern)
                assertNoReadOrGit()
            })
        })

        it('rejects a dangling in-workspace symlink (unresolvable)', async function () {
            const link = path.join(ws, 'dangling.js')
            if (!trySymlink(path.join(ws, 'missing-target.js'), link)) {
                return this.skip()
            }
            const cr = makeCodeReview([ws])
            await expectRejects(prepare(cr, [{ path: link }], [], []), /does not exist or cannot be resolved/)
            assertNoReadOrGit()
        })

        it('rejects a cyclic in-workspace symlink (unresolvable)', async function () {
            const loopA = path.join(ws, 'loopA.js')
            const loopB = path.join(ws, 'loopB.js')
            if (!trySymlink(loopB, loopA) || !trySymlink(loopA, loopB)) {
                return this.skip()
            }
            const cr = makeCodeReview([ws])
            await expectRejects(prepare(cr, [{ path: loopA }], [], []), /does not exist or cannot be resolved/)
            assertNoReadOrGit()
        })

        it('rejects an in-workspace symlink whose target escapes the workspace', async function () {
            const secret = mk(outside, 'secret.js', 'secret')
            const link = path.join(ws, 'escape.js')
            if (!trySymlink(secret, link)) {
                return this.skip()
            }
            const cr = makeCodeReview([ws])
            await expectRejects(prepare(cr, [{ path: link }], [], []), /inside an open workspace/)
            assertNoReadOrGit()
            // The escape target's contents were never read.
            expect(readFileArgs()).to.not.include(await canon(secret))
        })

        it('rejects a regular file with more than one hard link', async function () {
            const target = mk(outside, 'target.js', 'shared')
            const hard = path.join(ws, 'hard.js')
            if (!tryHardlink(target, hard)) {
                return this.skip()
            }
            const cr = makeCodeReview([ws])
            await expectRejects(prepare(cr, [{ path: hard }], [], []), /more than one hard link/)
            assertNoReadOrGit()
        })

        it('rejects a rule artifact with more than one hard link', async function () {
            const target = mk(outside, 'ruletarget.json', '{}')
            const hard = path.join(ws, 'rule.json')
            if (!tryHardlink(target, hard)) {
                return this.skip()
            }
            const cr = makeCodeReview([ws])
            await expectRejects(prepare(cr, [], [], [{ path: hard }]), /more than one hard link/)
            assertNoReadOrGit()
        })

        it('rejects when stat fails on an otherwise-resolvable file (fail closed)', async () => {
            const file = mk(ws, 'app.js', 'x')
            const canonFile = await fs.promises.realpath(file)
            const realStat = fs.promises.stat.bind(fs.promises)
            const statStub = sandbox.stub(fs.promises, 'stat')
            statStub.callsFake(((p: any, ...rest: any[]) => realStat(p, ...rest)) as any)
            statStub.withArgs(canonFile).rejects(Object.assign(new Error('simulated stat failure'), { code: 'EIO' }))
            const cr = makeCodeReview([ws])
            await expectRejects(prepare(cr, [{ path: file }], [], []), /does not exist or cannot be resolved/)
            assertNoReadOrGit()
        })
    })

    describe('accepts in-workspace artifacts and preserves intended names/filters', () => {
        it('includes an in-workspace file, folder contents, and rule in the synthetic zip', async () => {
            fs.writeFileSync(path.join(ws, 'app.js'), 'console.log(1)\n')
            fs.mkdirSync(path.join(ws, 'lib'))
            fs.writeFileSync(path.join(ws, 'lib', 'util.js'), 'export const a = 1\n')
            const rule = path.join(ws, 'r.json')
            fs.writeFileSync(rule, '{}')

            const cr = makeCodeReview([ws])
            const result = await prepare(
                cr,
                [{ path: path.join(ws, 'app.js') }],
                [{ path: path.join(ws, 'lib') }],
                [{ path: rule }]
            )

            const entries = await customerZipEntries(result.zipBuffer)
            expect(entries.some(e => e.endsWith('/app.js'))).to.equal(true)
            expect(entries.some(e => e.endsWith('/util.js'))).to.equal(true)
            expect(entries.some(e => e.includes('.amazonq/rules/r.json'))).to.equal(true)
        })

        it('accepts a benign symlink whose target is inside the workspace and keeps the submitted name', async function () {
            const realTarget = path.join(ws, 'real.js')
            fs.writeFileSync(realTarget, 'REAL-CONTENT')
            const link = path.join(ws, 'link.js')
            if (!trySymlink(realTarget, link)) {
                return this.skip()
            }
            const cr = makeCodeReview([ws])
            const result = await prepare(cr, [{ path: link }], [], [])

            const entries = await customerZipEntries(result.zipBuffer)
            // Zip entry keeps the submitted (link) name...
            expect(entries.some(e => e.endsWith('/link.js'))).to.equal(true)
            // ...while the content comes from the resolved target.
            expect(await customerZipEntryContent(result.zipBuffer, '/link.js')).to.equal('REAL-CONTENT')
        })

        it('accepts an artifact under any of several workspace roots (multi-root)', async () => {
            const wsB = path.join(root, 'workspaceB')
            fs.mkdirSync(wsB)
            fs.writeFileSync(path.join(wsB, 'b.js'), 'b')
            const cr = makeCodeReview([ws, wsB])
            const result = await prepare(cr, [{ path: path.join(wsB, 'b.js') }], [], [])
            const entries = await customerZipEntries(result.zipBuffer)
            expect(entries.some(e => e.endsWith('/b.js'))).to.equal(true)
        })

        it('accepts an artifact under a workspace reached through a symlinked directory', async function () {
            const realWs = path.join(root, 'realws')
            fs.mkdirSync(realWs)
            fs.writeFileSync(path.join(realWs, 'c.js'), 'c')
            const symWs = path.join(root, 'linkws')
            if (!trySymlink(realWs, symWs, 'dir')) {
                return this.skip()
            }
            const cr = makeCodeReview([symWs])
            const result = await prepare(cr, [{ path: path.join(symWs, 'c.js') }], [], [])
            const entries = await customerZipEntries(result.zipBuffer)
            expect(entries.some(e => e.endsWith('/c.js'))).to.equal(true)
        })

        it('keeps the existing extension allowlist: an in-workspace non-code file is validated but its content is skipped', async () => {
            fs.writeFileSync(path.join(ws, 'keep.js'), 'k')
            fs.writeFileSync(path.join(ws, 'skip.bin'), 'binary')
            const cr = makeCodeReview([ws])
            const result = await prepare(
                cr,
                [{ path: path.join(ws, 'keep.js') }, { path: path.join(ws, 'skip.bin') }],
                [],
                []
            )
            const entries = await customerZipEntries(result.zipBuffer)
            expect(entries.some(e => e.endsWith('/keep.js'))).to.equal(true)
            expect(entries.some(e => e.endsWith('/skip.bin'))).to.equal(false)
        })
    })

    describe('a full review performs no Git work (file and folder scans)', () => {
        // FULL_REVIEW does not use any diff, so neither the name-only call nor
        // the per-file getGitDiff runs. Artifacts are still validated and read,
        // and unsafe inputs are still rejected.
        it('does not call Git for a valid in-workspace file', async () => {
            const file = mk(ws, 'app.js', 'console.log(1)\n')
            const cr = makeCodeReview([ws])
            const result = await prepare(cr, [{ path: file }], [], [], true)
            const entries = await customerZipEntries(result.zipBuffer)
            expect(entries.some(e => e.endsWith('/app.js'))).to.equal(true)
            expect(result.isCodeDiffPresent).to.equal(false)
            sinon.assert.notCalled(getGitDiffNamesStub)
            sinon.assert.notCalled(processArtifactWithDiffStub)
        })

        it('does not call Git while walking a valid in-workspace folder', async () => {
            const dir = path.join(ws, 'pkg')
            fs.mkdirSync(dir)
            fs.writeFileSync(path.join(dir, 'a.js'), 'a')
            fs.writeFileSync(path.join(dir, 'b.js'), 'b')
            const cr = makeCodeReview([ws])
            const result = await prepare(cr, [], [{ path: dir }], [], true)
            const entries = await customerZipEntries(result.zipBuffer)
            expect(entries.some(e => e.endsWith('/a.js'))).to.equal(true)
            expect(entries.some(e => e.endsWith('/b.js'))).to.equal(true)
            sinon.assert.notCalled(getGitDiffNamesStub)
            sinon.assert.notCalled(processArtifactWithDiffStub)
        })

        it('still rejects an out-of-workspace file under a full review, with no read and no Git', async () => {
            const cr = makeCodeReview([ws])
            await expectRejects(
                prepare(cr, [{ path: mk(outside, 'secret.js', 'secret') }], [], [], true),
                /inside an open workspace/
            )
            assertNoReadOrGit()
        })
    })

    describe('folder walk cannot escape the workspace', () => {
        it('skips a symlink entry pointing outside and still zips the real sibling', async function () {
            const mixdir = path.join(ws, 'mixdir')
            fs.mkdirSync(mixdir)
            fs.writeFileSync(path.join(mixdir, 'inside.js'), 'inside')
            const secret = mk(outside, 'secret.js', 'secret')
            if (!trySymlink(secret, path.join(mixdir, 'out.js'))) {
                return this.skip()
            }
            const cr = makeCodeReview([ws])
            const result = await prepare(cr, [], [{ path: mixdir }], [])
            const entries = await customerZipEntries(result.zipBuffer)
            expect(entries.some(e => e.endsWith('/inside.js'))).to.equal(true)
            expect(entries.some(e => e.endsWith('/out.js'))).to.equal(false)
            // The symlink target was never read.
            expect(readFileArgs()).to.not.include(await canon(secret))
        })

        it('aborts the whole request without upload when a walked file resolves outside (mis-reported dirent)', async function () {
            const misdir = path.join(ws, 'misdir')
            fs.mkdirSync(misdir)
            const secret = mk(outside, 'secret.js', 'secret')
            // On disk evil.js is a symlink out of the workspace...
            if (!trySymlink(secret, path.join(misdir, 'evil.js'))) {
                return this.skip()
            }
            const cr = makeCodeReview([ws])
            const misdirCanon = await canon(misdir)
            // ...but readdir mis-reports it as an ordinary file. The realpath +
            // containment re-check must still catch the escape.
            readdirStub.withArgs(misdirCanon).resolves([
                {
                    name: 'evil.js',
                    parentPath: misdirCanon,
                    isFile: () => true,
                    isDirectory: () => false,
                    isSymbolicLink: () => false,
                },
            ] as any)

            await expectRejects(prepare(cr, [], [{ path: misdir }], []), /inside an open workspace/)
            // The escaping file was never read.
            expect(readFileArgs()).to.not.include(await canon(secret))
        })

        it('aborts on a hard-linked file discovered during a folder walk and never reads it', async function () {
            const hldir = path.join(ws, 'hldir')
            fs.mkdirSync(hldir)
            fs.writeFileSync(path.join(hldir, 'good.js'), 'good')
            const target = mk(outside, 'target.js', 'shared')
            const bad = path.join(hldir, 'bad.js')
            if (!tryHardlink(target, bad)) {
                return this.skip()
            }
            const cr = makeCodeReview([ws])
            await expectRejects(prepare(cr, [], [{ path: hldir }], []), /more than one hard link/)
            // The multiply-linked file was never read (a prior read of good.js is allowed).
            expect(readFileArgs()).to.not.include(await canon(bad))
        })
    })

    describe('folder zip entries preserve the submitted (display) layout', () => {
        // Benign symlinked workspace: the user opened /root/linkws (a symlink to
        // /root/realws). A folder artifact under the submitted (link) path must
        // map findings back to the submitted layout, so the zip entries — which
        // drive the service-returned finding path — carry the submitted layout.
        // Reads still use the resolved (real) path.
        const buildSymlinkedWorkspace = (): { linkWs: string; submittedFolder: string } | undefined => {
            const realWs = path.join(root, 'realws')
            fs.mkdirSync(realWs)
            const sub = path.join(realWs, 'sub')
            fs.mkdirSync(sub)
            const nested = path.join(sub, 'nested')
            fs.mkdirSync(nested)
            fs.writeFileSync(path.join(sub, 'top.js'), 'TOP')
            fs.writeFileSync(path.join(nested, 'deep.js'), 'DEEP')
            const linkWs = path.join(root, 'linkws')
            if (!trySymlink(realWs, linkWs, 'dir')) {
                return undefined
            }
            return { linkWs, submittedFolder: path.join(linkWs, 'sub') }
        }

        it('maps nested folder files to the submitted path, not the resolved path', async function () {
            const fixture = buildSymlinkedWorkspace()
            if (!fixture) {
                return this.skip()
            }
            const cr = makeCodeReview([fixture.linkWs])
            const result = await prepare(cr, [], [{ path: fixture.submittedFolder }], [])

            const entries = await customerZipEntries(result.zipBuffer)
            // Entries carry the submitted (linkws) layout at every nesting level...
            expect(entries.some(e => e.includes('/linkws/sub/top.js'))).to.equal(true)
            expect(entries.some(e => e.includes('/linkws/sub/nested/deep.js'))).to.equal(true)
            // ...and never leak the resolved (realws) layout.
            expect(entries.some(e => e.includes('/realws/'))).to.equal(false)
        })

        it('resolves a nested folder finding (submitted layout) back to the submitted path', async function () {
            const fixture = buildSymlinkedWorkspace()
            if (!fixture) {
                return this.skip()
            }
            const cr = makeCodeReview([fixture.linkWs])
            // A finding path reported relative to the submitted folder maps to
            // the submitted (linkws) absolute path the editor actually opened.
            const resolved = (cr as any).resolveFilePath('sub/nested/deep.js', [], [{ path: fixture.submittedFolder }])
            expect(resolved).to.equal(path.normalize(path.join(fixture.submittedFolder, 'nested', 'deep.js')))
        })
    })

    describe('canonical workspace roots are filtered to real on-disk directories', () => {
        // getCanonicalWorkspaceRoots drops a root that resolves to a
        // non-directory, or that cannot be resolved at all, rather than keeping
        // a lexical path. A dropped root must not break a surviving valid root,
        // and when NO root survives the request is rejected as "no workspace".
        it('drops a workspace folder that is not a directory on disk but keeps a valid root', async () => {
            // Second "root" is a regular file: realpath succeeds, the strict
            // stat is not a directory, so it is dropped (else -> warn).
            const fileRoot = mk(root, 'not-a-dir', 'x')
            const file = mk(ws, 'app.js', 'console.log(1)\n')
            const cr = makeCodeReview([ws, fileRoot])
            const result = await prepare(cr, [{ path: file }], [], [])
            const entries = await customerZipEntries(result.zipBuffer)
            // The surviving valid root still works.
            expect(entries.some(e => e.endsWith('/app.js'))).to.equal(true)
        })

        it('drops a workspace folder that cannot be resolved on disk but keeps a valid root', async () => {
            // Second "root" does not exist: realpath throws, so it is dropped
            // (catch -> warn) instead of being kept as a lexical path.
            const missingRoot = path.join(root, 'ghost-root')
            const file = mk(ws, 'app.js', 'console.log(1)\n')
            const cr = makeCodeReview([ws, missingRoot])
            const result = await prepare(cr, [{ path: file }], [], [])
            const entries = await customerZipEntries(result.zipBuffer)
            expect(entries.some(e => e.endsWith('/app.js'))).to.equal(true)
        })

        it('rejects when every workspace root is invalid (non-directory and unresolvable only)', async () => {
            // No root survives canonicalization -> treated as "no workspace" and
            // rejected before any content read or Git command.
            const fileRoot = mk(root, 'not-a-dir', 'x')
            const missingRoot = path.join(root, 'ghost-root')
            const cr = makeCodeReview([fileRoot, missingRoot])
            await expectRejects(prepare(cr, [{ path: mk(ws, 'app.js', 'x') }], [], []), /no workspace folder is open/)
            assertNoReadOrGit()
        })
    })

    describe('pre-read re-validation fails closed (check-to-use window)', () => {
        // assertFileReadableWithinWorkspace re-resolves and re-checks a file
        // immediately before the read. These scoped stubs let the up-front
        // validation pass, then make only the pre-read re-check fail, so the
        // defensive realpath-catch and not-a-regular-file branches run with no
        // dependency on OS permissions. Nothing is ever read in either case.
        it('rejects a file that becomes unresolvable between validation and the pre-read re-check', async () => {
            const file = mk(ws, 'app.js', 'console.log(1)\n')
            const canonFile = await fs.promises.realpath(file)
            const realRealpath = fs.promises.realpath.bind(fs.promises)
            let seen = 0
            const rp = sandbox.stub(fs.promises, 'realpath')
            rp.callsFake(((p: any, ...rest: any[]) => {
                if (p === canonFile) {
                    seen++
                    // 1st call = up-front validation (passes); 2nd = pre-read re-check (fails closed).
                    if (seen >= 2) {
                        return Promise.reject(Object.assign(new Error('vanished'), { code: 'ENOENT' }))
                    }
                }
                return realRealpath(p, ...rest)
            }) as any)
            const cr = makeCodeReview([ws])
            await expectRejects(prepare(cr, [{ path: file }], [], []), /does not exist or cannot be resolved/)
            assertNoReadOrGit()
        })

        it('rejects a file that turns into a directory between validation and the pre-read re-check', async () => {
            const file = mk(ws, 'app.js', 'console.log(1)\n')
            const canonFile = await fs.promises.realpath(file)
            const realStat = fs.promises.stat.bind(fs.promises)
            let seen = 0
            const st = sandbox.stub(fs.promises, 'stat')
            st.callsFake(((p: any, ...rest: any[]) => {
                if (p === canonFile) {
                    seen++
                    // 1st stat = validation (real regular file); 2nd stat = pre-read re-check (now a directory).
                    if (seen >= 2) {
                        return Promise.resolve({ isFile: () => false, isDirectory: () => true, nlink: 1 } as any)
                    }
                }
                return realStat(p, ...rest)
            }) as any)
            const cr = makeCodeReview([ws])
            await expectRejects(prepare(cr, [{ path: file }], [], []), /not a regular file/)
            assertNoReadOrGit()
        })
    })

    describe('folder walk re-checks each discovered entry and fails closed', () => {
        // Every file and subdirectory discovered during the walk is re-resolved
        // before use. A realpath failure, or a subdirectory that resolves out of
        // the workspace, aborts the whole request and reads nothing unsafe.
        it('aborts the walk when a discovered file becomes unresolvable before its realpath', async () => {
            const dir = path.join(ws, 'walk')
            fs.mkdirSync(dir)
            const vanish = path.join(dir, 'vanish.js')
            fs.writeFileSync(vanish, 'x')
            const realRealpath = fs.promises.realpath.bind(fs.promises)
            const rp = sandbox.stub(fs.promises, 'realpath')
            rp.callsFake(((p: any, ...rest: any[]) =>
                p === vanish
                    ? Promise.reject(Object.assign(new Error('vanished'), { code: 'ENOENT' }))
                    : realRealpath(p, ...rest)) as any)
            const cr = makeCodeReview([ws])
            await expectRejects(prepare(cr, [], [{ path: dir }], []), /does not exist or cannot be resolved/)
            expect(readFileArgs()).to.not.include(vanish)
        })

        it('aborts the walk when a discovered subdirectory becomes unresolvable before its realpath', async () => {
            const dir = path.join(ws, 'walk')
            fs.mkdirSync(dir)
            const subdir = path.join(dir, 'sub')
            fs.mkdirSync(subdir)
            fs.writeFileSync(path.join(subdir, 'deep.js'), 'x')
            const realRealpath = fs.promises.realpath.bind(fs.promises)
            const rp = sandbox.stub(fs.promises, 'realpath')
            rp.callsFake(((p: any, ...rest: any[]) =>
                p === subdir
                    ? Promise.reject(Object.assign(new Error('vanished'), { code: 'ENOENT' }))
                    : realRealpath(p, ...rest)) as any)
            const cr = makeCodeReview([ws])
            await expectRejects(prepare(cr, [], [{ path: dir }], []), /does not exist or cannot be resolved/)
        })

        it('aborts the walk when a discovered subdirectory resolves outside the workspace', async () => {
            // The subdirectory's realpath lands outside the workspace; the
            // containment re-check rejects before any descent into it.
            const dir = path.join(ws, 'walk')
            fs.mkdirSync(dir)
            const subdir = path.join(dir, 'sub')
            fs.mkdirSync(subdir)
            const realRealpath = fs.promises.realpath.bind(fs.promises)
            const rp = sandbox.stub(fs.promises, 'realpath')
            rp.callsFake(((p: any, ...rest: any[]) =>
                p === subdir ? Promise.resolve(outside) : realRealpath(p, ...rest)) as any)
            const cr = makeCodeReview([ws])
            await expectRejects(prepare(cr, [], [{ path: dir }], []), /inside an open workspace/)
        })
    })

    describe('plain nested folders recurse without symlinks', () => {
        it('archives a plain nested subdirectory, merging languages across the recursion', async () => {
            // An ordinary nested directory (no symlink, never skipped) exercises
            // the recursive descent, the canonical-dir containment check, and the
            // merge of the child language set into the parent.
            const outer = path.join(ws, 'outer')
            fs.mkdirSync(outer)
            fs.writeFileSync(path.join(outer, 'top.js'), 'const a = 1\n')
            const inner = path.join(outer, 'inner')
            fs.mkdirSync(inner)
            fs.writeFileSync(path.join(inner, 'deep.py'), 'a = 1\n')
            const cr = makeCodeReview([ws])
            const result = await prepare(cr, [], [{ path: outer }], [])
            const entries = await customerZipEntries(result.zipBuffer)
            // Both nesting levels archived under the submitted (outer) layout.
            expect(entries.some(e => e.endsWith('/outer/top.js'))).to.equal(true)
            expect(entries.some(e => e.endsWith('/outer/inner/deep.py'))).to.equal(true)
            // Languages from both levels are present (the recursion merges them).
            expect(result.programmingLanguages.has('javascript')).to.equal(true)
            expect(result.programmingLanguages.has('python')).to.equal(true)
        })
    })

    describe('execute() aborts before createUploadUrl / upload / startCodeAnalysis', () => {
        // Build a full execute() context with spies on the three network steps.
        const makeExecuteContext = () => {
            const createUploadUrl = sandbox.stub().resolves({ uploadUrl: 'https://upload.example', uploadId: 'id' })
            const startCodeAnalysis = sandbox.stub().resolves({ jobId: 'job' })
            const upload = sandbox.stub(CodeReviewUtils, 'uploadFileToPresignedUrl').resolves()
            const writer = {
                write: sandbox.stub().resolves(),
                close: sandbox.stub().resolves(),
                releaseLock: sandbox.stub(),
            }
            const context = {
                cancellationToken: { isCancellationRequested: false },
                writableStream: { getWriter: () => writer },
                codeWhispererClient: {
                    createUploadUrl,
                    startCodeAnalysis,
                    getCodeAnalysis: sandbox.stub(),
                    listCodeAnalysisFindings: sandbox.stub(),
                },
            }
            return { context, createUploadUrl, startCodeAnalysis, upload }
        }

        const assertNoService = (s: {
            createUploadUrl: sinon.SinonStub
            startCodeAnalysis: sinon.SinonStub
            upload: sinon.SinonStub
        }) => {
            sinon.assert.notCalled(s.createUploadUrl)
            sinon.assert.notCalled(s.upload)
            sinon.assert.notCalled(s.startCodeAnalysis)
            sinon.assert.notCalled(getGitDiffNamesStub)
        }

        type ExecuteCase = { name: string; pattern: RegExp; wsFolders?: () => string[]; input: () => any }

        const cases: ExecuteCase[] = [
            {
                name: 'a file artifact outside the workspace',
                pattern: /inside an open workspace/,
                input: () => ({
                    scopeOfReview: FULL_REVIEW,
                    userRequirement: 'Review please',
                    fileLevelArtifacts: [{ path: mk(outside, 'secret.js', 'secret') }],
                    modelId: 'test-model',
                }),
            },
            {
                name: 'a folder artifact outside the workspace',
                pattern: /inside an open workspace/,
                input: () => ({
                    scopeOfReview: FULL_REVIEW,
                    userRequirement: 'Review please',
                    folderLevelArtifacts: [{ path: outside }],
                    modelId: 'test-model',
                }),
            },
            {
                name: 'no open workspace folder',
                pattern: /no workspace folder is open/,
                wsFolders: () => [],
                input: () => ({
                    scopeOfReview: FULL_REVIEW,
                    userRequirement: 'Review please',
                    fileLevelArtifacts: [{ path: mk(root, 'loose.js', 'x') }],
                    modelId: 'test-model',
                }),
            },
            {
                name: 'a valid file mixed with an out-of-workspace folder',
                pattern: /inside an open workspace/,
                input: () => ({
                    scopeOfReview: FULL_REVIEW,
                    userRequirement: 'Review please',
                    fileLevelArtifacts: [{ path: mk(ws, 'good.js', 'ok') }],
                    folderLevelArtifacts: [{ path: outside }],
                    modelId: 'test-model',
                }),
            },
            {
                name: 'a valid file mixed with an out-of-workspace rule',
                pattern: /inside an open workspace/,
                input: () => ({
                    scopeOfReview: FULL_REVIEW,
                    userRequirement: 'Review please',
                    fileLevelArtifacts: [{ path: mk(ws, 'good.js', 'ok') }],
                    ruleArtifacts: [{ path: mk(outside, 'rule.json', '{}') }],
                    modelId: 'test-model',
                }),
            },
        ]

        cases.forEach(c => {
            it(`never contacts the service for ${c.name}`, async () => {
                const cr = makeCodeReview(c.wsFolders ? c.wsFolders() : [ws])
                const s = makeExecuteContext()
                await expectRejects(cr.execute(c.input(), s.context), c.pattern)
                assertNoService(s)
                // Every case here rejects during validation, before any read.
                sinon.assert.notCalled(readFileStub)
            })
        })

        it('never contacts the service when a folder walk finds a hard-linked file', async function () {
            const hldir = path.join(ws, 'hldir')
            fs.mkdirSync(hldir)
            fs.writeFileSync(path.join(hldir, 'good.js'), 'good')
            const target = mk(outside, 'target.js', 'shared')
            const bad = path.join(hldir, 'bad.js')
            if (!tryHardlink(target, bad)) {
                return this.skip()
            }
            const cr = makeCodeReview([ws])
            const s = makeExecuteContext()
            await expectRejects(
                cr.execute(
                    {
                        scopeOfReview: FULL_REVIEW,
                        userRequirement: 'Review please',
                        folderLevelArtifacts: [{ path: hldir }],
                        modelId: 'test-model',
                    },
                    s.context
                ),
                /more than one hard link/
            )
            assertNoService(s)
            // A good sibling may be read before the abort, but the hard-linked file never is.
            expect(readFileArgs()).to.not.include(await canon(bad))
        })
    })
})

describe('CodeReview folder code-diff excludes skipped files (real git)', () => {
    // A real temporary Git repository, driven by execFile('git', argv) with a
    // fixed argument vector and no shell. Git is NOT stubbed here, so a fix that
    // merely disabled Git would fail the "marker present" assertion. Fixtures
    // are synthetic benign markers; no secrets, no network.
    let sandbox: sinon.SinonSandbox
    let root: string
    let ws: string
    let readFileStub: sinon.SinonStub
    let readdirStub: sinon.SinonStub
    let gitReady = false

    // A real, EMPTY git config file used for both GIT_CONFIG_GLOBAL and
    // GIT_CONFIG_SYSTEM, created once in its own temp dir OUTSIDE any test git
    // repo. os.devNull must NOT be used here: on Windows it is '\\.\nul', which
    // git rejects with "fatal: Invalid argument" when it opens it as a config
    // file. That broke `git --version` and turned the Windows CI run into a
    // failure instead of running (or skipping) these tests. The env is built
    // per git invocation and never mutates the operator's real git config.
    let gitConfigDir: string
    let emptyGitConfig: string

    const runGit = (args: string[], cwd: string): void => {
        execFileSync('git', args, {
            cwd,
            stdio: 'pipe',
            env: {
                ...process.env,
                GIT_CONFIG_GLOBAL: emptyGitConfig,
                GIT_CONFIG_SYSTEM: emptyGitConfig,
                GIT_TERMINAL_PROMPT: '0',
                GIT_AUTHOR_NAME: 'CR Boundary Test',
                GIT_AUTHOR_EMAIL: 'cr-boundary@example.invalid',
                GIT_COMMITTER_NAME: 'CR Boundary Test',
                GIT_COMMITTER_EMAIL: 'cr-boundary@example.invalid',
            },
        })
    }

    before(() => {
        gitConfigDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cr-gitcfg-'))
        emptyGitConfig = path.join(gitConfigDir, 'empty.gitconfig')
        fs.writeFileSync(emptyGitConfig, '')
    })

    after(() => {
        fs.rmSync(gitConfigDir, { recursive: true, force: true })
    })

    const makeCr = (wsFolders: string[]): CodeReview => {
        readFileStub = sandbox.stub().callsFake((p: string) => fs.promises.readFile(p))
        readdirStub = sandbox.stub().callsFake((p: string) => fs.promises.readdir(p, { withFileTypes: true }))
        const features: any = {
            credentialsProvider: {
                getConnectionMetadata: () => ({ sso: { startUrl: 'https://example.test' } }),
            },
            logging: noopLogging,
            telemetry: { emitMetric: () => {} },
            workspace: {
                getAllWorkspaceFolders: () =>
                    wsFolders.map(f => ({ uri: URI.file(f).toString(), name: path.basename(f) })),
                fs: { readFile: readFileStub, readdir: readdirStub },
            },
        }
        return new CodeReview(features)
    }

    const codeDiffText = async (zipBuffer: Buffer): Promise<string> => {
        const outer = await JSZip.loadAsync(zipBuffer)
        const f = outer.file('code_artifact/codeDiff/customerCodeDiff.diff')
        return f ? await f.async('string') : ''
    }

    beforeEach(function () {
        sandbox = sinon.createSandbox()
        const realTmp = fs.realpathSync(os.tmpdir())
        root = fs.mkdtempSync(path.join(realTmp, 'cr-gitdiff-'))
        ws = root
        try {
            runGit(['--version'], ws)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                gitReady = false
                return this.skip()
            }
            throw error
        }
        runGit(['init', '-q'], ws)
        gitReady = true
    })

    afterEach(() => {
        sandbox.restore()
        fs.rmSync(root, { recursive: true, force: true })
    })

    it('includes the tracked allowlisted file diff but excludes skipped dotfile and non-allowlisted diffs', async function () {
        if (!gitReady) {
            return this.skip()
        }
        const proj = path.join(ws, 'proj')
        fs.mkdirSync(proj)
        const appJs = path.join(proj, 'app.js') // allowlisted -> included in the diff
        const notesBin = path.join(proj, 'notes.bin') // non-allowlisted extension -> skipped
        const hiddenJs = path.join(proj, '.hidden.js') // dotfile (allowlisted ext) -> skipped
        fs.writeFileSync(appJs, 'const a = 1\n')
        fs.writeFileSync(notesBin, 'orig-bin\n')
        fs.writeFileSync(hiddenJs, 'const h = 1\n')
        runGit(['add', '-A'], ws)
        runGit(['commit', '-q', '-m', 'init'], ws)
        // Modify all three with distinct benign markers.
        fs.appendFileSync(appJs, '// NORMAL_DIFF_MARKER_ALLOWED\n')
        fs.appendFileSync(notesBin, 'SKIPPED_BIN_MARKER\n')
        fs.appendFileSync(hiddenJs, '// SKIPPED_DOT_MARKER\n')

        const cr = makeCr([ws])
        // CODE_DIFF_REVIEW: isFullReview = false, so the per-file git diff runs.
        const result = await (cr as any).prepareFilesAndFoldersForUpload(
            'Review please',
            [],
            [{ path: proj }],
            [],
            false
        )

        const diff = await codeDiffText(result.zipBuffer)
        expect(result.isCodeDiffPresent, 'a diff should be present').to.equal(true)
        expect(diff, 'the allowlisted file diff must be present').to.include('NORMAL_DIFF_MARKER_ALLOWED')
        expect(diff, 'the non-allowlisted file diff must be excluded').to.not.include('SKIPPED_BIN_MARKER')
        expect(diff, 'the dotfile diff must be excluded').to.not.include('SKIPPED_DOT_MARKER')

        // The skipped files were never read into the customer-code zip either.
        const readArgs = readFileStub.getCalls().map(c => c.args[0] as string)
        expect(readArgs.some(p => p.endsWith('notes.bin'))).to.equal(false)
        expect(readArgs.some(p => p.endsWith('.hidden.js'))).to.equal(false)
    })

    it('counts each changed file once (staged and unstaged) and derives it from the per-file diff, not a name-only call', async function () {
        if (!gitReady) {
            return this.skip()
        }
        const proj = path.join(ws, 'proj')
        fs.mkdirSync(proj)
        const unstaged = path.join(proj, 'unstaged.js')
        const staged = path.join(proj, 'staged.js')
        const unchanged = path.join(proj, 'unchanged.js')
        fs.writeFileSync(unstaged, 'const u = 1\n')
        fs.writeFileSync(staged, 'const s = 1\n')
        fs.writeFileSync(unchanged, 'const c = 1\n')
        runGit(['add', '-A'], ws)
        runGit(['commit', '-q', '-m', 'init'], ws)
        // One working-tree (unstaged) change, one staged change, one untouched.
        fs.appendFileSync(unstaged, '// UNSTAGED_MARKER\n')
        fs.appendFileSync(staged, '// STAGED_MARKER\n')
        runGit(['add', '--', 'proj/staged.js'], ws)

        // Prove the name-only git call is never used to build the changed set.
        const nameOnlySpy = sandbox.spy(CodeReviewUtils, 'getGitDiffNames')

        const cr = makeCr([ws])
        const result = await (cr as any).prepareFilesAndFoldersForUpload(
            'Review please',
            [],
            [{ path: proj }],
            [],
            false
        )

        const diff = await codeDiffText(result.zipBuffer)
        expect(result.isCodeDiffPresent, 'a diff should be present').to.equal(true)
        expect(diff, 'the unstaged change must be in the diff').to.include('UNSTAGED_MARKER')
        expect(diff, 'the staged change must be in the diff').to.include('STAGED_MARKER')
        // Exactly the two changed files are counted; the unchanged file is not.
        expect(result.codeDiffFiles.size, 'only the two changed files are counted').to.equal(2)
        sinon.assert.notCalled(nameOnlySpy)
    })

    it('reports an empty changed-file set and no diff when nothing changed', async function () {
        if (!gitReady) {
            return this.skip()
        }
        const proj = path.join(ws, 'proj')
        fs.mkdirSync(proj)
        fs.writeFileSync(path.join(proj, 'app.js'), 'const a = 1\n')
        runGit(['add', '-A'], ws)
        runGit(['commit', '-q', '-m', 'init'], ws)
        // No modification after the commit, so there is no diff.
        const cr = makeCr([ws])
        const result = await (cr as any).prepareFilesAndFoldersForUpload(
            'Review please',
            [],
            [{ path: proj }],
            [],
            false
        )
        expect(result.codeDiffFiles.size, 'no changed files').to.equal(0)
        expect(result.isCodeDiffPresent, 'no diff present').to.equal(false)
    })
})
