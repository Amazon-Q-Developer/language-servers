/*!
 * Copyright Amazon.com, Inc. or its affiliates.
 * All Rights Reserved. SPDX-License-Identifier: Apache-2.0
 */

import { expect } from 'chai'
import * as sinon from 'sinon'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
    fingerprintFolder,
    forgetFolderApprovals,
    getFolderApprovalsForgottenAt,
    getFolderApprovalsPath,
    getFolderIdentity,
    getInitialWorkspaceTrust,
    isFolderApproved,
    isWorkspaceTrustState,
    readWorkspaceTrustUpdate,
    recordFolderApproval,
} from './mcpWorkspaceTrust'

describe('mcpWorkspaceTrust', () => {
    describe('getInitialWorkspaceTrust', () => {
        const withTrust = (workspaceTrust: unknown) =>
            ({ initializationOptions: { aws: { awsClientCapabilities: { q: { mcp: true, workspaceTrust } } } } }) as any

        it('reads each reported state', () => {
            expect(getInitialWorkspaceTrust(withTrust('trusted'))).to.equal('trusted')
            expect(getInitialWorkspaceTrust(withTrust('restricted'))).to.equal('restricted')
            expect(getInitialWorkspaceTrust(withTrust('prompt'))).to.equal('prompt')
        })

        it('falls back to prompt when the client reports nothing or an unknown value', () => {
            expect(getInitialWorkspaceTrust(undefined)).to.equal('prompt')
            expect(getInitialWorkspaceTrust({} as any)).to.equal('prompt')
            expect(getInitialWorkspaceTrust(withTrust(undefined))).to.equal('prompt')
            expect(getInitialWorkspaceTrust(withTrust(true))).to.equal('prompt')
            expect(getInitialWorkspaceTrust(withTrust('TRUSTED'))).to.equal('prompt')
        })

        it('accepts only the three states', () => {
            expect(isWorkspaceTrustState('trusted')).to.be.true
            expect(isWorkspaceTrustState('yes')).to.be.false
            expect(isWorkspaceTrustState(undefined)).to.be.false
        })
    })

    describe('readWorkspaceTrustUpdate', () => {
        it('reads a state change sent for the workspace trust section', () => {
            expect(
                readWorkspaceTrustUpdate({ section: 'aws.q.workspaceTrust', settings: { state: 'trusted' } })
            ).to.equal('trusted')
            expect(
                readWorkspaceTrustUpdate({ section: 'aws.q.workspaceTrust', settings: { state: 'restricted' } })
            ).to.equal('restricted')
        })

        it('ignores other sections, including the Amazon Q profile section', () => {
            expect(readWorkspaceTrustUpdate({ section: 'aws.q', settings: { state: 'trusted' } })).to.be.undefined
            expect(readWorkspaceTrustUpdate({ section: 'aws.q.workspaceTrustX', settings: {} })).to.be.undefined
            expect(readWorkspaceTrustUpdate({} as any)).to.be.undefined
        })

        it('rejects an unknown state for the workspace trust section', () => {
            expect(readWorkspaceTrustUpdate({ section: 'aws.q.workspaceTrust', settings: { state: 'yes' } })).to.equal(
                'invalid'
            )
            expect(readWorkspaceTrustUpdate({ section: 'aws.q.workspaceTrust', settings: undefined })).to.equal(
                'invalid'
            )
        })
    })

    describe('fingerprintFolder', () => {
        it('treats a trailing separator as the same folder', () => {
            const folder = path.join(os.tmpdir(), 'ws-a')
            expect(fingerprintFolder(folder + path.sep)).to.equal(fingerprintFolder(folder))
        })

        it('gives different folders different keys', () => {
            expect(fingerprintFolder(path.join(os.tmpdir(), 'ws-a'))).to.not.equal(
                fingerprintFolder(path.join(os.tmpdir(), 'ws-b'))
            )
        })

        it('does not treat a parent folder as the same folder', () => {
            const parent = path.join(os.tmpdir(), 'ws-a')
            expect(fingerprintFolder(path.join(parent, 'sub'))).to.not.equal(fingerprintFolder(parent))
        })

        describe('case', () => {
            const realPlatform = process.platform
            const setPlatform = (value: string) => Object.defineProperty(process, 'platform', { value })

            afterEach(() => setPlatform(realPlatform))

            it('treats a different case as a different folder on macOS', () => {
                setPlatform('darwin')
                expect(fingerprintFolder('/x/Repo')).to.not.equal(fingerprintFolder('/x/repo'))
            })

            it('treats a different case as the same folder on Windows', () => {
                setPlatform('win32')
                expect(fingerprintFolder('/x/Repo')).to.equal(fingerprintFolder('/x/repo'))
            })
        })
    })

    describe('folder identity', () => {
        let tmp: string

        beforeEach(() => {
            tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpFolderIdentityTest-'))
        })

        afterEach(() => {
            fs.rmSync(tmp, { recursive: true, force: true })
        })

        it('stays the same while files inside the folder change', async () => {
            const folder = path.join(tmp, 'repo')
            fs.mkdirSync(folder)
            const before = await getFolderIdentity(folder)
            fs.writeFileSync(path.join(folder, 'package.json'), '{}')
            fs.mkdirSync(path.join(folder, 'node_modules'))

            expect(before).to.be.a('string')
            expect(await getFolderIdentity(folder)).to.equal(before)
        })

        it('changes when the folder is deleted and created again at the same path', async () => {
            const folder = path.join(tmp, 'repo')
            fs.mkdirSync(folder)
            const before = await getFolderIdentity(folder)
            fs.rmSync(folder, { recursive: true })
            fs.mkdirSync(folder)

            expect(await getFolderIdentity(folder)).to.not.equal(before)
        })

        it('changes when a repository is cloned into the folder or its remote changes', async () => {
            const folder = path.join(tmp, 'repo')
            fs.mkdirSync(folder)
            const empty = await getFolderIdentity(folder)
            fs.mkdirSync(path.join(folder, '.git'))
            fs.writeFileSync(
                path.join(folder, '.git', 'config'),
                '[remote "origin"]\n\turl = https://example.com/a.git\n'
            )
            const cloned = await getFolderIdentity(folder)
            fs.writeFileSync(
                path.join(folder, '.git', 'config'),
                '[remote "origin"]\n\turl = https://example.com/b.git\n'
            )

            expect(cloned).to.not.equal(empty)
            expect(await getFolderIdentity(folder)).to.not.equal(cloned)
        })

        it('stays the same when git settings other than remotes change', async () => {
            const folder = path.join(tmp, 'repo')
            fs.mkdirSync(path.join(folder, '.git'), { recursive: true })
            const remote = '[remote "origin"]\n\turl = https://example.com/a.git\n'
            fs.writeFileSync(path.join(folder, '.git', 'config'), remote)
            const before = await getFolderIdentity(folder)
            fs.writeFileSync(path.join(folder, '.git', 'config'), remote + '[core]\n\tfilemode = false\n')

            expect(await getFolderIdentity(folder)).to.equal(before)
        })

        it('uses the .git file of a worktree', async () => {
            const folder = path.join(tmp, 'wt')
            fs.mkdirSync(folder)
            fs.writeFileSync(path.join(folder, '.git'), 'gitdir: /a/.git/worktrees/wt\n')
            const before = await getFolderIdentity(folder)
            fs.writeFileSync(path.join(folder, '.git'), 'gitdir: /b/.git/worktrees/wt\n')

            expect(await getFolderIdentity(folder)).to.not.equal(before)
        })

        it('does not open the git directory a worktree or submodule .git file points to', async () => {
            const folder = path.join(tmp, 'wt')
            fs.mkdirSync(folder)
            fs.writeFileSync(path.join(folder, '.git'), 'gitdir: //host.invalid/share/x\n')
            const opened: string[] = []
            const realOpen = fs.promises.open
            const openStub = sinon.stub(fs.promises, 'open').callsFake(((p: any, ...rest: any[]) => {
                opened.push(String(p))
                return (realOpen as any)(p, ...rest)
            }) as any)
            const lstat = sinon.spy(fs.promises, 'lstat')
            const stat = sinon.spy(fs.promises, 'stat')
            try {
                expect(await getFolderIdentity(folder)).to.be.a('string')
            } finally {
                openStub.restore()
                lstat.restore()
                stat.restore()
            }
            const touched = [...opened, ...lstat.args.map(a => String(a[0])), ...stat.args.map(a => String(a[0]))]
            expect(touched.every(p => p.startsWith(folder))).to.be.true
        })

        it('does not follow a .git or .git/config link, and notices when its target changes', async function () {
            if (process.platform === 'win32') {
                this.skip()
            }
            const folder = path.join(tmp, 'repo')
            fs.mkdirSync(folder)
            fs.symlinkSync('//host.invalid/share/a', path.join(folder, '.git'))
            const linkA = await getFolderIdentity(folder)
            fs.rmSync(path.join(folder, '.git'))
            fs.symlinkSync('//host.invalid/share/b', path.join(folder, '.git'))
            const linkB = await getFolderIdentity(folder)
            fs.rmSync(path.join(folder, '.git'))
            fs.mkdirSync(path.join(folder, '.git'))
            fs.symlinkSync('//host.invalid/share/config', path.join(folder, '.git', 'config'))

            expect(linkA).to.be.a('string')
            expect(linkB).to.not.equal(linkA)
            expect(await getFolderIdentity(folder)).to.be.a('string')
        })

        describe('git files that are not regular files', function () {
            // Named pipes and device files are POSIX-only in these tests
            before(function () {
                if (process.platform === 'win32') {
                    this.skip()
                }
            })

            const withTimeout = <T>(p: Promise<T>) =>
                Promise.race([
                    p,
                    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), 2000)),
                ])
            const mkfifo = (file: string) => require('child_process').execFileSync('mkfifo', [file])

            it('does not read a named pipe at .git', async () => {
                const folder = path.join(tmp, 'repo')
                fs.mkdirSync(folder)
                mkfifo(path.join(folder, '.git'))
                expect(await withTimeout(getFolderIdentity(folder))).to.be.a('string')
            })

            it('does not read a named pipe at .git/config', async () => {
                const folder = path.join(tmp, 'repo')
                fs.mkdirSync(path.join(folder, '.git'), { recursive: true })
                mkfifo(path.join(folder, '.git', 'config'))
                expect(await withTimeout(getFolderIdentity(folder))).to.be.a('string')
            })

            it('does not read a device file that .git links to', async () => {
                const folder = path.join(tmp, 'repo')
                fs.mkdirSync(folder)
                fs.symlinkSync('/dev/zero', path.join(folder, '.git'))
                expect(await withTimeout(getFolderIdentity(folder))).to.be.a('string')
            })

            it('does not read a device file that a worktree commondir points to', async () => {
                const folder = path.join(tmp, 'wt')
                const gitDir = path.join(tmp, 'gitdir')
                fs.mkdirSync(folder)
                fs.mkdirSync(gitDir)
                fs.writeFileSync(path.join(folder, '.git'), `gitdir: ${gitDir}\n`)
                fs.symlinkSync('/dev/zero', path.join(gitDir, 'commondir'))
                expect(await withTimeout(getFolderIdentity(folder))).to.be.a('string')
            })
        })

        it('is missing for a path that does not exist or is a file', async () => {
            const file = path.join(tmp, 'file')
            fs.writeFileSync(file, 'x')

            expect(await getFolderIdentity(path.join(tmp, 'missing'))).to.be.undefined
            expect(await getFolderIdentity(file)).to.be.undefined
        })
    })

    describe('folder approvals', () => {
        let tmpHome: string
        let workspace: any
        const logger = { warn: () => {}, info: () => {}, error: () => {} } as any
        const storeFile = () => path.join(tmpHome, '.aws', 'amazonq', 'mcp-workspace-folders.json')

        beforeEach(() => {
            tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpFolderTrustTest-'))
            workspace = {
                fs: {
                    exists: (p: string) => Promise.resolve(fs.existsSync(p)),
                    readFile: (p: string) => Promise.resolve(Buffer.from(fs.readFileSync(p))),
                    writeFile: (p: string, d: string) => Promise.resolve(fs.writeFileSync(p, d)),
                    mkdir: (p: string, _opts: any) => Promise.resolve(fs.mkdirSync(p, { recursive: true })),
                    getUserHomeDir: () => tmpHome,
                },
            }
        })

        afterEach(() => {
            fs.rmSync(tmpHome, { recursive: true, force: true })
        })

        it('remembers an approved folder and only that folder', async () => {
            const folderA = path.join(tmpHome, 'ws-a')
            const folderB = path.join(tmpHome, 'ws-b')
            expect(await isFolderApproved(workspace, logger, folderA, 'id-a')).to.be.false

            await recordFolderApproval(workspace, logger, folderA, 'id-a')

            expect(await isFolderApproved(workspace, logger, folderA, 'id-a')).to.be.true
            expect(await isFolderApproved(workspace, logger, folderB, 'id-a')).to.be.false
            expect(await isFolderApproved(workspace, logger, path.join(folderA, 'sub'), 'id-a')).to.be.false
        })

        it('does not cover a different folder later created at the same path', async () => {
            const folder = path.join(tmpHome, 'ws-a')
            await recordFolderApproval(workspace, logger, folder, 'id-original')

            expect(await isFolderApproved(workspace, logger, folder, 'id-replacement')).to.be.false
        })

        it('keeps only the newest approval for a path', async () => {
            const folder = path.join(tmpHome, 'ws-a')
            await recordFolderApproval(workspace, logger, folder, 'id-1')
            await recordFolderApproval(workspace, logger, folder, 'id-2')

            expect(JSON.parse(fs.readFileSync(storeFile(), 'utf8')).folders).to.have.length(1)
            expect(await isFolderApproved(workspace, logger, folder, 'id-1')).to.be.false
            expect(await isFolderApproved(workspace, logger, folder, 'id-2')).to.be.true
        })

        it('forgets every approval', async () => {
            const folderA = path.join(tmpHome, 'ws-a')
            const folderB = path.join(tmpHome, 'ws-b')
            await recordFolderApproval(workspace, logger, folderA, 'id-a')
            await recordFolderApproval(workspace, logger, folderB, 'id-b')

            expect(await forgetFolderApprovals(workspace, logger)).to.be.true

            expect(await isFolderApproved(workspace, logger, folderA, 'id-a')).to.be.false
            expect(await isFolderApproved(workspace, logger, folderB, 'id-b')).to.be.false
        })

        it('reports that approvals could not be forgotten when the store cannot be written', async () => {
            const folder = path.join(tmpHome, 'ws-a')
            await recordFolderApproval(workspace, logger, folder, 'id-a')
            workspace.fs.writeFile = () => Promise.reject(new Error('read-only file system'))

            expect(await forgetFolderApprovals(workspace, logger)).to.be.false
            expect(await isFolderApproved(workspace, logger, folder, 'id-a')).to.be.true
        })

        it('does not bring back forgotten approvals when an approval is saved at the same time', async () => {
            const folderA = path.join(tmpHome, 'ws-a')
            const folderB = path.join(tmpHome, 'ws-b')
            await recordFolderApproval(workspace, logger, folderA, 'id-a')
            // Hold the next read until the forget has been requested
            const realRead = workspace.fs.readFile
            let releaseRead!: () => void
            const readHeld = new Promise<void>(resolve => (releaseRead = resolve))
            workspace.fs.readFile = async (p: string) => {
                await readHeld
                return realRead(p)
            }

            const recording = recordFolderApproval(workspace, logger, folderB, 'id-b')
            const forgetting = forgetFolderApprovals(workspace, logger)
            releaseRead()
            await Promise.all([recording, forgetting])
            workspace.fs.readFile = realRead

            expect(await isFolderApproved(workspace, logger, folderA, 'id-a')).to.be.false
            expect(await isFolderApproved(workspace, logger, folderB, 'id-b')).to.be.false
        })

        it('reports whether an approval was saved', async () => {
            expect(await recordFolderApproval(workspace, logger, path.join(tmpHome, 'ws-a'), 'id-a')).to.be.true
            workspace.fs.writeFile = () => Promise.reject(new Error('read-only file system'))
            expect(await recordFolderApproval(workspace, logger, path.join(tmpHome, 'ws-b'), 'id-b')).to.be.false
        })

        it('records when approvals were forgotten, and keeps it when a new approval is saved', async () => {
            expect(await getFolderApprovalsForgottenAt(workspace, logger)).to.equal(0)
            const before = Date.now()
            await forgetFolderApprovals(workspace, logger)
            const forgotten = await getFolderApprovalsForgottenAt(workspace, logger)
            await recordFolderApproval(workspace, logger, path.join(tmpHome, 'ws-a'), 'id-a')

            expect(forgotten).to.be.at.least(before)
            expect(await getFolderApprovalsForgottenAt(workspace, logger)).to.equal(forgotten)
        })

        it('replaces the file in one step and leaves no lock or temporary file behind', async () => {
            await recordFolderApproval(workspace, logger, path.join(tmpHome, 'ws-a'), 'id-a')
            await forgetFolderApprovals(workspace, logger)
            expect(fs.readdirSync(path.dirname(storeFile()))).to.deep.equal([path.basename(storeFile())])
            expect(getFolderApprovalsPath(workspace)).to.equal(storeFile())
        })

        it('waits for another window that is writing the file', async () => {
            fs.mkdirSync(path.dirname(storeFile()), { recursive: true })
            const lockFile = storeFile() + '.lock'
            fs.writeFileSync(lockFile, '')
            const recording = recordFolderApproval(workspace, logger, path.join(tmpHome, 'ws-a'), 'id-a')
            await new Promise(resolve => setTimeout(resolve, 100))
            expect(fs.existsSync(storeFile())).to.be.false
            fs.rmSync(lockFile)

            expect(await recording).to.be.true
            expect(await isFolderApproved(workspace, logger, path.join(tmpHome, 'ws-a'), 'id-a')).to.be.true
        })

        it('takes over a lock file left by a window that stopped while writing', async () => {
            fs.mkdirSync(path.dirname(storeFile()), { recursive: true })
            const lockFile = storeFile() + '.lock'
            fs.writeFileSync(lockFile, '')
            const old = new Date(Date.now() - 60_000)
            fs.utimesSync(lockFile, old, old)

            expect(await recordFolderApproval(workspace, logger, path.join(tmpHome, 'ws-a'), 'id-a')).to.be.true
            expect(fs.existsSync(lockFile)).to.be.false
        })

        it('keeps a fresh lock that another window took while this one removed a stale one', async () => {
            fs.mkdirSync(path.dirname(storeFile()), { recursive: true })
            const lockFile = storeFile() + '.lock'
            fs.writeFileSync(lockFile, '')
            const old = new Date(Date.now() - 60_000)
            fs.utimesSync(lockFile, old, old)
            // Another window removes the stale lock and takes its own between this window's stat and rename
            const realRename = fs.promises.rename
            let swapped = false
            const renameStub = sinon.stub(fs.promises, 'rename').callsFake(async (from: any, to: any) => {
                if (!swapped && from === lockFile) {
                    swapped = true
                    fs.rmSync(lockFile)
                    fs.writeFileSync(lockFile, 'other window')
                    setTimeout(() => fs.rmSync(lockFile, { force: true }), 100)
                }
                return realRename(from, to)
            })
            try {
                const recording = recordFolderApproval(workspace, logger, path.join(tmpHome, 'ws-a'), 'id-a')
                await new Promise(resolve => setTimeout(resolve, 50))
                // The other window's lock was put back, so this window is still waiting
                expect(fs.readFileSync(lockFile, 'utf8')).to.equal('other window')
                expect(await recording).to.be.true
            } finally {
                renameStub.restore()
            }
        })

        it('does not replace the file when another window took the lock over during the write', async () => {
            const folder = path.join(tmpHome, 'ws-a')
            await recordFolderApproval(workspace, logger, folder, 'id-a')
            const lockFile = storeFile() + '.lock'
            const realWrite = workspace.fs.writeFile
            workspace.fs.writeFile = async (p: string, d: string) => {
                fs.writeFileSync(lockFile, 'other window')
                return realWrite(p, d)
            }

            expect(await forgetFolderApprovals(workspace, logger)).to.be.false
            // The other window's lock stays, and the approval saved earlier is unchanged
            expect(fs.readFileSync(lockFile, 'utf8')).to.equal('other window')
            workspace.fs.writeFile = realWrite
            fs.rmSync(lockFile)
            expect(await isFolderApproved(workspace, logger, folder, 'id-a')).to.be.true
            expect(fs.readdirSync(path.dirname(storeFile()))).to.deep.equal([path.basename(storeFile())])
        })

        it('waits on a lock that is a folder, then gives up without saving', async function () {
            this.timeout(10000)
            fs.mkdirSync(storeFile() + '.lock', { recursive: true })
            const started = Date.now()

            expect(await recordFolderApproval(workspace, logger, path.join(tmpHome, 'ws-a'), 'id-a')).to.be.false
            expect(Date.now() - started).to.be.below(5000)
            // Reads are not held up afterwards
            expect(await isFolderApproved(workspace, logger, path.join(tmpHome, 'ws-a'), 'id-a')).to.be.false
        })

        it('waits on a lock that cannot be read, then gives up without saving', async function () {
            if (process.platform === 'win32' || process.getuid?.() === 0) {
                this.skip()
            }
            this.timeout(10000)
            fs.mkdirSync(path.dirname(storeFile()), { recursive: true })
            const lockFile = storeFile() + '.lock'
            fs.writeFileSync(lockFile, 'other user')
            fs.chmodSync(lockFile, 0o000)
            try {
                expect(await forgetFolderApprovals(workspace, logger)).to.be.false
            } finally {
                fs.chmodSync(lockFile, 0o600)
            }
        })

        it('does not save when another window holds the lock for too long', async function () {
            this.timeout(10000)
            fs.mkdirSync(path.dirname(storeFile()), { recursive: true })
            fs.writeFileSync(storeFile() + '.lock', '')

            expect(await recordFolderApproval(workspace, logger, path.join(tmpHome, 'ws-a'), 'id-a')).to.be.false
            expect(await forgetFolderApprovals(workspace, logger)).to.be.false
        })

        it('does not store the folder path itself', async () => {
            await recordFolderApproval(workspace, logger, path.join(tmpHome, 'ws-a'), 'id-a')
            expect(fs.readFileSync(storeFile(), 'utf8')).to.not.include('ws-a')
        })

        it('ignores a store written in the earlier format, which has no folder identity', async () => {
            const folder = path.join(tmpHome, 'ws-a')
            fs.mkdirSync(path.dirname(storeFile()), { recursive: true })
            fs.writeFileSync(
                storeFile(),
                JSON.stringify({ version: 1, folders: [{ folderHash: fingerprintFolder(folder), approvedAt: '' }] })
            )

            expect(await isFolderApproved(workspace, logger, folder, 'id-a')).to.be.false
        })

        it('treats an unreadable store as no approvals', async () => {
            fs.mkdirSync(path.dirname(storeFile()), { recursive: true })
            fs.writeFileSync(storeFile(), 'not json')
            expect(await isFolderApproved(workspace, logger, path.join(tmpHome, 'ws-a'), 'id-a')).to.be.false
        })

        it('neither reads nor writes a store when the home directory is not an absolute path', async () => {
            const calls: string[] = []
            const relativeHome = {
                fs: {
                    exists: async (p: string) => (calls.push(`exists ${p}`), false),
                    readFile: async (p: string) => (calls.push(`read ${p}`), Buffer.from('{}')),
                    writeFile: async (p: string) => void calls.push(`write ${p}`),
                    mkdir: async (p: string) => void calls.push(`mkdir ${p}`),
                    getUserHomeDir: () => 'relative-home',
                },
            } as any

            await recordFolderApproval(relativeHome, logger, path.join(tmpHome, 'ws-a'), 'id-a')
            // Nothing can have been saved, so there is nothing left to forget
            expect(await forgetFolderApprovals(relativeHome, logger)).to.be.true

            expect(await isFolderApproved(relativeHome, logger, path.join(tmpHome, 'ws-a'), 'id-a')).to.be.false
            expect(calls).to.deep.equal([])
        })
    })
})
