/*!
 * Copyright Amazon.com, Inc. or its affiliates.
 * All Rights Reserved. SPDX-License-Identifier: Apache-2.0
 */

import { expect } from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
    fingerprintFolder,
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

    describe('folder approvals', () => {
        let tmpHome: string
        let workspace: any
        const logger = { warn: () => {}, info: () => {}, error: () => {} } as any

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
            expect(await isFolderApproved(workspace, logger, folderA)).to.be.false

            await recordFolderApproval(workspace, logger, folderA)

            expect(await isFolderApproved(workspace, logger, folderA)).to.be.true
            expect(await isFolderApproved(workspace, logger, folderB)).to.be.false
            expect(await isFolderApproved(workspace, logger, path.join(folderA, 'sub'))).to.be.false
        })

        it('does not store the folder path itself', async () => {
            const folder = path.join(tmpHome, 'ws-a')
            await recordFolderApproval(workspace, logger, folder)
            const raw = fs.readFileSync(path.join(tmpHome, '.aws', 'amazonq', 'mcp-workspace-folders.json'), 'utf8')
            expect(raw).to.not.include('ws-a')
        })

        it('does not record the same folder twice', async () => {
            const folder = path.join(tmpHome, 'ws-a')
            await recordFolderApproval(workspace, logger, folder)
            await recordFolderApproval(workspace, logger, folder)
            const raw = fs.readFileSync(path.join(tmpHome, '.aws', 'amazonq', 'mcp-workspace-folders.json'), 'utf8')
            expect(JSON.parse(raw).folders).to.have.length(1)
        })

        it('treats an unreadable store as no approvals', async () => {
            const dir = path.join(tmpHome, '.aws', 'amazonq')
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(path.join(dir, 'mcp-workspace-folders.json'), 'not json')
            expect(await isFolderApproved(workspace, logger, path.join(tmpHome, 'ws-a'))).to.be.false
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

            await recordFolderApproval(relativeHome, logger, path.join(tmpHome, 'ws-a'))

            expect(await isFolderApproved(relativeHome, logger, path.join(tmpHome, 'ws-a'))).to.be.false
            expect(calls).to.deep.equal([])
        })
    })
})
