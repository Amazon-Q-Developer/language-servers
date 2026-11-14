import * as sinon from 'sinon'
import { URI } from 'vscode-uri'
import { Logging, Workspace, WorkspaceFolder } from '@aws/language-server-runtimes/server-interface'
import { ArtifactManager } from './artifactManager'
import * as util from './util'

describe('ArtifactManager', () => {
    const logging = {
        log: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
    } as unknown as Logging
    const proj: WorkspaceFolder = { uri: URI.file('/work/proj').toString(), name: 'proj' }
    const projOther: WorkspaceFolder = { uri: URI.file('/work/proj-other').toString(), name: 'proj-other' }

    let artifactManager: ArtifactManager
    let processDirectory: sinon.SinonStub

    beforeEach(() => {
        // The path of proj is a prefix of the path of proj-other
        artifactManager = new ArtifactManager({} as Workspace, logging, [proj, projOther])
        // The directory processing reads the disk, so these tests check only the workspace folder that it gets
        processDirectory = sinon.stub(artifactManager, 'processDirectory').resolves(new Map())
        sinon.stub(artifactManager as any, 'processFilesByLanguage').resolves([])
    })

    afterEach(() => {
        sinon.restore()
    })

    describe('addNewDirectories', () => {
        it('processes a new directory with the workspace folder that the caller found', async () => {
            await artifactManager.addNewDirectories([URI.file('/work/proj-other/src')], projOther)

            sinon.assert.calledOnceWithExactly(processDirectory, projOther, '/work/proj-other/src', 'src')
        })

        it('processes a new directory with a workspace folder whose URI has an uppercase drive letter', async () => {
            const driveFolder: WorkspaceFolder = { uri: 'file:///C:/work/proj', name: 'proj' }

            await artifactManager.addNewDirectories([URI.parse('file:///C:/work/proj/lib')], driveFolder)

            sinon.assert.calledOnceWithExactly(processDirectory, driveFolder, '/C:/work/proj/lib', 'lib')
        })
    })

    describe('handleRename', () => {
        it('processes a renamed directory with the workspace folder of its new path', async () => {
            sinon.stub(util, 'isDirectory').returns(true)
            sinon.stub(util, 'isEmptyDirectory').returns(false)

            await artifactManager.handleRename(
                projOther,
                URI.file('/work/proj-other/old').toString(),
                URI.file('/work/proj-other/src').toString()
            )

            sinon.assert.calledOnceWithExactly(processDirectory, projOther, '/work/proj-other/src', 'src')
        })
    })
})
