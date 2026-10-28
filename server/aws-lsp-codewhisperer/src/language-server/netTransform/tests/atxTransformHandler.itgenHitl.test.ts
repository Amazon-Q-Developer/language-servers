import { expect } from 'chai'
import * as sinon from 'sinon'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import AdmZip = require('adm-zip')
import { CategoryType, FileType } from '@amazon/elastic-gumby-frontend-client'
import {
    ATXTransformHandler,
    ATX_HITL_TAG_INTEG_APP_LAUNCH,
    ATX_HITL_TAG_INTEG_TEST_RUN,
    ATX_ITGEN_ENABLED_ENV_VAR,
    itGenTestProjectDir,
} from '../atxTransformHandler'
import { Utils, workspaceFolderName } from '../utils'
import { AtxTokenServiceManager } from '../../../shared/amazonQServiceManager/AtxTokenServiceManager'
import { Logging, Runtime, Workspace } from '@aws/language-server-runtimes/server-interface'

const JOB_ID = 'job-itgen'
const WS_ID = 'ws-itgen'

const testRunRequest = (overrides: any = {}) => ({
    schemaVersion: '1.0',
    runId: 'r2',
    side: 'original',
    project: 'SampleWebApi',
    artifactId: 'repo-artifact',
    tests: { projectPath: 'GeneratedApiTests.SampleWebApi/GeneratedApiTests.SampleWebApi.csproj' },
    limits: { projectTimeoutSeconds: 1800 },
    ...overrides,
})

const testRunHitl = { taskId: 'task-run', tag: ATX_HITL_TAG_INTEG_TEST_RUN, planStepId: 'step-run' }
const appLaunchHitl = { taskId: 'task-launch', tag: ATX_HITL_TAG_INTEG_APP_LAUNCH, planStepId: 'step-launch' }

describe('ATXTransformHandler - ITGen test HITLs', () => {
    let handler: ATXTransformHandler
    let logging: Logging
    let tmpRoot: string
    let hitls: any[]
    let jobStatus: string
    let downloadJsonStub: sinon.SinonStub
    let downloadUrlStub: sinon.SinonStub
    let zipDownloadStub: sinon.SinonStub
    let requestsByArtifact: Record<string, any>

    const poll = () =>
        handler.getTransformInfo({
            TransformationJobId: JOB_ID,
            WorkspaceId: WS_ID,
            SolutionRootPath: tmpRoot,
        } as any)

    beforeEach(() => {
        process.env[ATX_ITGEN_ENABLED_ENV_VAR] = 'true'
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atx-itgen-hitl-'))
        logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub(), warn: sinon.stub() } as any
        handler = new ATXTransformHandler(
            sinon.createStubInstance(AtxTokenServiceManager) as any,
            {} as Workspace,
            logging,
            {} as Runtime
        )
        sinon.stub(handler as any, 'initializeAtxClient').resolves(true)
        sinon.stub(handler as any, 'addAuthToCommand').resolves()
        // Skip the interactive-mode lookups, which make their own ListHitlTasks calls.
        ;(handler as any).interactiveModeByJob.set(JOB_ID, { mode: 'Interactive', source: 'test' })

        hitls = []
        jobStatus = 'EXECUTING'
        // The real listHitls runs against this fake, so OpenHitls sees exactly what selection saw.
        ;(handler as any).atxClient = {
            send: sinon.stub().callsFake(async (command: any) => {
                if (command.constructor.name === 'ListHitlTasksCommand') {
                    return { hitlTasks: hitls }
                }
                throw new Error(`unexpected ${command.constructor.name}`)
            }),
        }
        sinon.stub(handler, 'getJob').callsFake(async () => ({ statusDetails: { status: jobStatus } }) as any)
        sinon.stub(handler, 'getTransformationPlan').resolves({ Root: { Children: [] } } as any)
        sinon.stub(handler as any, 'listWorklogs').resolves(undefined)

        requestsByArtifact = {
            'art-run': testRunRequest(),
            'art-launch': { schemaVersion: '1.0', side: 'transformed' },
        }
        downloadJsonStub = sinon
            .stub(handler as any, 'downloadJsonArtifact')
            .callsFake(async (...args: any[]) => requestsByArtifact[args[2]] ?? null)
        // The tests artifact is the whole repo: app source, a root build file and the test project, plus the
        // ZIP the real code leaves behind.
        downloadUrlStub = sinon
            .stub(handler, 'createArtifactDownloadUrl')
            .callsFake(async (...args: any[]) => ({ s3PresignedUrl: `url-${args[2]}`, requestHeaders: {} }))
        zipDownloadStub = sinon
            .stub(Utils, 'downloadAndExtractArchive')
            .callsFake(async (_url: string, _headers: any, saveToDir: string, exportName: string) => {
                fs.mkdirSync(path.join(saveToDir, 'GeneratedApiTests.SampleWebApi'), { recursive: true })
                fs.writeFileSync(path.join(saveToDir, 'GeneratedApiTests.SampleWebApi', 'Tests.csproj'), '<Project/>')
                fs.mkdirSync(path.join(saveToDir, 'SampleWebApi'), { recursive: true })
                fs.writeFileSync(path.join(saveToDir, 'SampleWebApi', 'Program.cs'), '// app')
                fs.writeFileSync(path.join(saveToDir, 'Directory.Build.props'), '<Project/>')
                fs.writeFileSync(path.join(saveToDir, exportName), 'zip')
                return saveToDir
            })
    })

    afterEach(() => {
        sinon.restore()
        delete process.env[ATX_ITGEN_ENABLED_ENV_VAR]
        fs.rmSync(tmpRoot, { recursive: true, force: true })
    })

    describe('HITL selection order', () => {
        it('picks integ-app-launch before integ-test-run', async () => {
            hitls = [testRunHitl, appLaunchHitl]

            const result = await poll()

            expect(result?.TransformationJob.Status).to.equal('AWAITING_HUMAN_INPUT')
            expect(result?.HitlTag).to.equal(ATX_HITL_TAG_INTEG_APP_LAUNCH)
            expect(result?.HitlTaskId).to.equal('task-launch')
            expect(result?.StepInformation?.StepId).to.equal('step-launch')
        })

        it('keeps LBV and missing-packages ahead of the ITGen tags', async () => {
            hitls = [testRunHitl, { taskId: 'task-lbv', tag: 'local-build-verification' }]
            expect((await poll())?.HitlTag).to.equal('local-build-verification')

            hitls = [testRunHitl, { taskId: 'task-pkg', tag: 'missing-packages' }]
            expect((await poll())?.HitlTag).to.equal('missing-packages')
        })

        it('puts integ-test-run ahead of a post-LBV checkpoint only when the flag is on', async () => {
            ;(handler as any).jobsPastLocalBuild.add(JOB_ID)
            hitls = [{ taskId: 'task-cp', tag: `${JOB_ID}-checkpoint` }, testRunHitl]

            expect((await poll())?.HitlTag).to.equal(ATX_HITL_TAG_INTEG_TEST_RUN)

            delete process.env[ATX_ITGEN_ENABLED_ENV_VAR]
            expect((await poll())?.HitlTag).to.equal(`${JOB_ID}-checkpoint`)
        })

        it('surfaces an ITGen HITL with its step on a PLANNING job, not as an unhandled tag', async () => {
            jobStatus = 'PLANNING'
            hitls = [testRunHitl]

            const result = await poll()

            expect(result?.TransformationJob.Status).to.equal('AWAITING_HUMAN_INPUT')
            expect(result?.HitlTag).to.equal(ATX_HITL_TAG_INTEG_TEST_RUN)
            expect(result?.StepInformation?.StepId).to.equal('step-run')
            expect((logging.warn as sinon.SinonStub).called).to.be.false
        })

        it('returns an ITGen HITL directly on an AWAITING_HUMAN_INPUT job, without a plan-ZIP download', async () => {
            jobStatus = 'AWAITING_HUMAN_INPUT'
            hitls = [{ ...testRunHitl, agentArtifact: { artifactId: 'art-run' } }]

            const result = await poll()

            expect(result?.HitlTag).to.equal(ATX_HITL_TAG_INTEG_TEST_RUN)
            expect(result?.HitlTaskId).to.equal('task-run')
            expect(result?.StepInformation?.StepId).to.equal('step-run')
            // Only the tests artifact is extracted, never the request as a plan ZIP.
            const zipNames = zipDownloadStub.getCalls().map(c => c.args[3])
            expect(zipNames).to.not.include('transformation-plan-download.zip')
        })
    })

    // With the flag off an integ-* tag is just an unknown tag: every path must behave exactly as it
    // did before ITGen, and nothing ITGen-specific (request.json, tests download) may happen.
    describe('flag off: existing behavior unchanged', () => {
        beforeEach(() => {
            delete process.env[ATX_ITGEN_ENABLED_ENV_VAR]
        })

        const noItGenFiles = () => {
            expect(fs.existsSync(path.join(tmpRoot, workspaceFolderName, JOB_ID, 'hitl'))).to.be.false
            expect(fs.existsSync(path.join(tmpRoot, workspaceFolderName, JOB_ID, 'itgen'))).to.be.false
            expect(downloadJsonStub.called).to.be.false
        }

        it('EXECUTING: an integ-* HITL is surfaced by the generic first-in-list rule, without OpenHitls', async () => {
            hitls = [{ ...testRunHitl, agentArtifact: { artifactId: 'art-run' } }]

            const result = await poll()

            expect(result?.HitlTag).to.equal(ATX_HITL_TAG_INTEG_TEST_RUN)
            expect(result?.OpenHitls).to.be.undefined
            expect(zipDownloadStub.called).to.be.false
            noItGenFiles()
        })

        it('PLANNING: an integ-* HITL goes down the defensive unhandled-tag path, as before', async () => {
            jobStatus = 'PLANNING'
            hitls = [testRunHitl]

            const result = await poll()

            expect(result?.HitlTag).to.equal(ATX_HITL_TAG_INTEG_TEST_RUN)
            expect(result?.StepInformation).to.be.undefined
            expect((logging.warn as sinon.SinonStub).calledWithMatch(/unhandled HITL tag/)).to.be.true
            noItGenFiles()
        })

        it('AWAITING_HUMAN_INPUT: an integ-* HITL still takes the old agent-artifact ZIP path', async () => {
            jobStatus = 'AWAITING_HUMAN_INPUT'
            hitls = [{ ...testRunHitl, agentArtifact: { artifactId: 'art-run' } }]

            const result = await poll()

            expect(result?.HitlTag).to.equal(ATX_HITL_TAG_INTEG_TEST_RUN)
            expect(result?.OpenHitls).to.be.undefined
            const zipNames = zipDownloadStub.getCalls().map(c => c.args[3])
            expect(zipNames).to.include('transformation-plan-download.zip')
            expect(zipNames).to.not.include('tests-artifact.zip')
            noItGenFiles()
        })
    })

    describe('OpenHitls', () => {
        it('lists every open HITL, with the downloaded request for ITGen ones', async () => {
            const expiry = new Date('2026-10-20T19:30:00Z')
            hitls = [
                { ...testRunHitl, agentArtifact: { artifactId: 'art-run' }, expiredAt: expiry },
                { taskId: 'task-cp', tag: `${JOB_ID}-checkpoint` },
            ]

            const result = await poll()

            const expectedPath = path.join(tmpRoot, workspaceFolderName, JOB_ID, 'hitl', 'task-run', 'request.json')
            const expectedTests = path.join(tmpRoot, workspaceFolderName, JOB_ID, 'itgen', 'r2', 'tests')
            expect(result?.OpenHitls).to.deep.equal([
                {
                    TaskId: 'task-run',
                    Tag: ATX_HITL_TAG_INTEG_TEST_RUN,
                    StepId: 'step-run',
                    ExpiryTimestampUTC: '2026-10-20T19:30:00.000Z',
                    RequestPath: expectedPath,
                    TestsPath: expectedTests,
                },
                { TaskId: 'task-cp', Tag: `${JOB_ID}-checkpoint` },
            ])
            expect(JSON.parse(fs.readFileSync(expectedPath, 'utf-8'))).to.deep.equal(testRunRequest())
            // The repo artifact named in the request, extracted with its ZIP removed.
            expect(downloadUrlStub.firstCall.args[2]).to.equal('repo-artifact')
            expect(fs.existsSync(path.join(expectedTests, 'GeneratedApiTests.SampleWebApi', 'Tests.csproj'))).to.be.true
            expect(fs.existsSync(path.join(expectedTests, 'tests-artifact.zip'))).to.be.false
            // Only the test project's folder is kept, not the rest of the repo.
            expect(fs.readdirSync(expectedTests)).to.deep.equal(['GeneratedApiTests.SampleWebApi'])
            expect(fs.existsSync(path.join(path.dirname(expectedTests), 'tests-download'))).to.be.false
        })

        it('keeps the whole artifact when the test project folder is not in it', async () => {
            requestsByArtifact['art-run'] = testRunRequest({ tests: { projectPath: 'Other/Other.csproj' } })
            hitls = [{ ...testRunHitl, agentArtifact: { artifactId: 'art-run' } }]

            const [open] = (await poll())!.OpenHitls!

            expect(fs.readdirSync(open.TestsPath!).sort()).to.deep.equal([
                'Directory.Build.props',
                'GeneratedApiTests.SampleWebApi',
                'SampleWebApi',
            ])
            expect((logging.warn as sinon.SinonStub).calledWithMatch(/Other isn't in tests artifact/)).to.be.true
        })

        it('refuses a tests.projectPath that is rooted or climbs out of the artifact', async () => {
            requestsByArtifact['art-run'] = testRunRequest({ tests: { projectPath: '../outside/Evil.csproj' } })
            hitls = [{ ...testRunHitl, agentArtifact: { artifactId: 'art-run' } }]

            const [open] = (await poll())!.OpenHitls!

            expect(open.TestsPath).to.be.undefined
            expect(open.RequestError).to.contain('Unsafe integ-test-run tests.projectPath')
            expect(zipDownloadStub.called).to.be.false
        })

        it('removes the tests of earlier runs of the same project, and only those', async () => {
            const itgen = path.join(tmpRoot, workspaceFolderName, JOB_ID, 'itgen')
            requestsByArtifact['art-run'] = testRunRequest({ runId: 'r1' })
            requestsByArtifact['art-admin'] = testRunRequest({ runId: 'r5', project: 'SampleWebApi.Admin' })
            hitls = [{ ...testRunHitl, agentArtifact: { artifactId: 'art-run' } }]
            await poll()
            hitls = [{ ...testRunHitl, taskId: 'task-admin', agentArtifact: { artifactId: 'art-admin' } }]
            await poll()
            // The IDE's result ZIP for r1 sits next to its tests.
            fs.writeFileSync(path.join(itgen, 'r1', 'results.zip'), 'zip')

            requestsByArtifact['art-run-2'] = testRunRequest({ runId: 'r2' })
            hitls = [{ ...testRunHitl, taskId: 'task-run-2', agentArtifact: { artifactId: 'art-run-2' } }]
            await poll()

            expect(fs.existsSync(path.join(itgen, 'r1', 'tests'))).to.be.false
            expect(fs.existsSync(path.join(itgen, 'r1', 'results.zip'))).to.be.true
            expect(fs.existsSync(path.join(itgen, 'r5', 'tests'))).to.be.true
            expect(fs.existsSync(path.join(itgen, 'r2', 'tests'))).to.be.true
        })

        it('downloads a task request and its tests once and reuses ListHitls (one call per poll)', async () => {
            hitls = [{ ...testRunHitl, agentArtifact: { artifactId: 'art-run' } }]

            await poll()
            await poll()

            expect(downloadJsonStub.callCount).to.equal(1)
            expect(zipDownloadStub.callCount).to.equal(1)
            const send = (handler as any).atxClient.send as sinon.SinonStub
            expect(send.callCount).to.equal(2)
        })

        it('downloads the tests again for a new test-run task, since the artifact is rewritten under the same id', async () => {
            hitls = [{ ...testRunHitl, agentArtifact: { artifactId: 'art-run' } }]
            await poll()

            // The agent fixed the tests and opened a new run with a new task (same artifact id).
            requestsByArtifact['art-run-2'] = testRunRequest({ runId: 'r3' })
            hitls = [{ ...testRunHitl, taskId: 'task-run-2', agentArtifact: { artifactId: 'art-run-2' } }]
            const [open] = (await poll())!.OpenHitls!

            expect(zipDownloadStub.callCount).to.equal(2)
            expect(downloadUrlStub.secondCall.args[2]).to.equal('repo-artifact')
            expect(open.TestsPath).to.equal(path.join(tmpRoot, workspaceFolderName, JOB_ID, 'itgen', 'r3', 'tests'))
        })

        it('does not download tests for an app launch', async () => {
            hitls = [{ ...appLaunchHitl, agentArtifact: { artifactId: 'art-launch' } }]

            const [open] = (await poll())!.OpenHitls!

            expect(open.RequestPath).to.not.be.undefined
            expect(open.TestsPath).to.be.undefined
            expect(zipDownloadStub.called).to.be.false
        })

        it('refuses a runId or task id that could leave the job folder', async () => {
            requestsByArtifact['art-run'] = testRunRequest({ runId: '..\\..\\evil' })
            hitls = [
                { ...testRunHitl, agentArtifact: { artifactId: 'art-run' } },
                { ...appLaunchHitl, taskId: '../task', agentArtifact: { artifactId: 'art-launch' } },
            ]

            const [run, launch] = (await poll())!.OpenHitls!

            expect(run.TestsPath).to.be.undefined
            expect(run.RequestError).to.contain('Unsafe integ-test-run runId')
            expect(launch.RequestPath).to.be.undefined
            expect(launch.RequestError).to.contain('Unsafe task id')
            expect(zipDownloadStub.called).to.be.false
        })

        it('reports a tests artifact that cannot be downloaded', async () => {
            downloadUrlStub.resolves(null)
            hitls = [{ ...testRunHitl, agentArtifact: { artifactId: 'art-run' } }]

            const [open] = (await poll())!.OpenHitls!

            expect(open.RequestPath).to.not.be.undefined
            expect(open.TestsPath).to.be.undefined
            expect(open.RequestError).to.contain('Could not download the tests artifact repo-artifact')
        })

        it('rejects a request whose schemaVersion major is not 1', async () => {
            requestsByArtifact['art-run'] = testRunRequest({ schemaVersion: '2.0' })
            hitls = [{ ...testRunHitl, agentArtifact: { artifactId: 'art-run' } }]

            const [open] = (await poll())!.OpenHitls!

            expect(open.RequestPath).to.be.undefined
            expect(open.RequestError).to.contain('schemaVersion: 2.0')
        })

        it('reports an ITGen HITL without an agent artifact', async () => {
            hitls = [appLaunchHitl]

            const [open] = (await poll())!.OpenHitls!

            expect(open.RequestPath).to.be.undefined
            expect(open.RequestError).to.contain('no agent artifact')
        })

        it('is absent when the flag is off', async () => {
            delete process.env[ATX_ITGEN_ENABLED_ENV_VAR]
            hitls = [{ ...testRunHitl, agentArtifact: { artifactId: 'art-run' } }]

            const result = await poll()

            expect(result?.OpenHitls).to.be.undefined
            expect(downloadJsonStub.called).to.be.false
        })

        it('is absent for terminal job statuses, which do not list HITLs', async () => {
            jobStatus = 'STOPPED'
            hitls = [testRunHitl]

            expect((await poll())?.OpenHitls).to.be.undefined
        })
    })

    describe('completeHitlWithTestResults', () => {
        let uploadUrlStub: sinon.SinonStub
        let uploadStub: sinon.SinonStub
        let submitStub: sinon.SinonStub

        const writeZip = (rel: string, entries: Record<string, string>) => {
            const zip = new AdmZip()
            for (const [name, content] of Object.entries(entries)) {
                zip.addFile(name, Buffer.from(content))
            }
            const full = path.join(tmpRoot, rel)
            fs.mkdirSync(path.dirname(full), { recursive: true })
            zip.writeZip(full)
            return full
        }
        const summary = (schemaVersion = '1.0') => JSON.stringify({ schemaVersion, runId: 'r2', status: 'COMPLETED' })

        beforeEach(() => {
            uploadUrlStub = sinon
                .stub(handler, 'createArtifactUploadUrl')
                .resolves({ uploadUrl: 'u', uploadId: 'upload-1', requestHeaders: {} } as any)
            uploadStub = sinon.stub(Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true })
            submitStub = sinon.stub(handler, 'submitHitl').resolves({ status: 'SUBMITTED' } as any)
        })

        it('uploads the ZIP as HITL_FROM_USER and submits the task by ID', async () => {
            const rel = path.join(workspaceFolderName, JOB_ID, 'itgen', 'r2', 'results.zip')
            const full = writeZip(rel, { 'summary.json': summary(), 'trx/SampleWebApi/r2.trx': '<TestRun/>' })

            // Relative to SolutionRootPath, as in the contract example.
            const result = await handler.completeHitlWithTestResults(WS_ID, JOB_ID, 'task-run', rel, tmpRoot)

            expect(result).to.deep.equal({ Success: true })
            expect(uploadUrlStub.firstCall.args).to.deep.equal([
                WS_ID,
                JOB_ID,
                full,
                CategoryType.HITL_FROM_USER,
                FileType.ZIP,
            ])
            expect(uploadStub.firstCall.args[1]).to.equal(full)
            expect(submitStub.firstCall.args).to.deep.equal([WS_ID, JOB_ID, 'task-run', 'upload-1'])
        })

        it('refuses when the flag is off', async () => {
            delete process.env[ATX_ITGEN_ENABLED_ENV_VAR]
            const full = writeZip('results.zip', { 'summary.json': summary() })

            const result = await handler.completeHitlWithTestResults(WS_ID, JOB_ID, 'task-run', full, tmpRoot)

            expect(result.Success).to.be.false
            expect(result.Error).to.contain(ATX_ITGEN_ENABLED_ENV_VAR)
            expect(uploadUrlStub.called).to.be.false
        })

        it('refuses a missing ZIP', async () => {
            const result = await handler.completeHitlWithTestResults(WS_ID, JOB_ID, 'task-run', 'nope.zip', tmpRoot)

            expect(result.Success).to.be.false
            expect(result.Error).to.contain('Result ZIP not found')
        })

        describe('customer changes (workspace/) on the transformed side', () => {
            // The updateWorkspace manifest: tracked files, and the job start as the baseline.
            const seedManifest = (files: Record<string, string>, jobStartMsAgo = 60_000) => {
                const checkpoints = path.join(tmpRoot, workspaceFolderName, JOB_ID, 'checkpoints')
                fs.mkdirSync(checkpoints, { recursive: true })
                const absolute = Object.keys(files).map(rel => path.join(tmpRoot, rel))
                for (const [rel, content] of Object.entries(files)) {
                    fs.mkdirSync(path.dirname(path.join(tmpRoot, rel)), { recursive: true })
                    fs.writeFileSync(path.join(tmpRoot, rel), content)
                }
                fs.writeFileSync(
                    path.join(checkpoints, 'source-files.json'),
                    JSON.stringify({
                        createdAt: new Date(Date.now() - jobStartMsAgo).toISOString(),
                        sourceFiles: absolute,
                    })
                )
            }
            const uploaded = () => new AdmZip(uploadStub.firstCall.args[1])
            const launchResult = (side: string) =>
                JSON.stringify({ schemaVersion: '1.1', side, status: 'APP_NOT_STARTED', attempt: 2 })

            it('adds the files the customer changed since job start, in the updateWorkspace format', async () => {
                seedManifest({ 'Web/appsettings.json': '{ "fixed": true }' })
                const full = writeZip('launch.zip', {
                    'launch-result.json': launchResult('transformed'),
                    'app-startup.log': 'boom',
                })

                const result = await handler.completeHitlWithTestResults(WS_ID, JOB_ID, 'task-launch', full, tmpRoot)

                expect(result).to.deep.equal({ Success: true })
                expect(uploadStub.firstCall.args[1]).to.equal(full.replace(/\.zip$/, '.with-workspace.zip'))
                const zip = uploaded()
                expect(JSON.parse(zip.getEntry('workspace/metadata.json')!.getData().toString())).to.deep.equal({
                    filesUpdated: [path.join('Web', 'appsettings.json')],
                })
                expect(zip.getEntry('workspace/Web/appsettings.json')!.getData().toString()).to.equal(
                    '{ "fixed": true }'
                )
                // The IDE's own entries are kept, and its ZIP isn't modified.
                expect(zip.getEntry('app-startup.log')).to.not.be.null
                expect(new AdmZip(full).getEntry('workspace/metadata.json')).to.be.null
            })

            it('adds them to transformed-side test-run results too', async () => {
                seedManifest({ 'Web/Controllers/BookController.cs': '// customer edit between runs' })
                const summaryJson = JSON.stringify({ schemaVersion: '1.1', side: 'transformed', status: 'COMPLETED' })
                const full = writeZip('results.zip', { 'summary.json': summaryJson })

                await handler.completeHitlWithTestResults(WS_ID, JOB_ID, 'task-run', full, tmpRoot)

                expect(uploaded().getEntry('workspace/Web/Controllers/BookController.cs')).to.not.be.null
            })

            it('sends an empty filesUpdated when nothing changed', async () => {
                const full = writeZip('launch.zip', { 'launch-result.json': launchResult('transformed') })

                await handler.completeHitlWithTestResults(WS_ID, JOB_ID, 'task-launch', full, tmpRoot)

                const metadata = uploaded().getEntry('workspace/metadata.json')!.getData().toString()
                expect(JSON.parse(metadata)).to.deep.equal({ filesUpdated: [] })
            })

            it('sends nothing back on the original side', async () => {
                seedManifest({ 'Web/appsettings.json': '{}' })
                const full = writeZip('launch.zip', { 'launch-result.json': launchResult('original') })

                await handler.completeHitlWithTestResults(WS_ID, JOB_ID, 'task-launch', full, tmpRoot)

                expect(uploadStub.firstCall.args[1]).to.equal(full)
                expect(uploaded().getEntry('workspace/metadata.json')).to.be.null
            })

            it('keeps a workspace/ the IDE already added', async () => {
                seedManifest({ 'Web/appsettings.json': '{}' })
                const full = writeZip('launch.zip', {
                    'launch-result.json': launchResult('transformed'),
                    'workspace/metadata.json': JSON.stringify({ filesUpdated: [] }),
                })

                await handler.completeHitlWithTestResults(WS_ID, JOB_ID, 'task-launch', full, tmpRoot)

                expect(uploadStub.firstCall.args[1]).to.equal(full)
            })
        })

        it('accepts an app-launch result ZIP (launch-result.json + startup log)', async () => {
            const launchResult = JSON.stringify({ schemaVersion: '1.0', status: 'APP_NOT_STARTED', attempt: 1 })
            const full = writeZip('launch.zip', { 'launch-result.json': launchResult, 'app-startup.log': 'boom' })

            const result = await handler.completeHitlWithTestResults(WS_ID, JOB_ID, 'task-launch', full, tmpRoot)

            expect(result).to.deep.equal({ Success: true })
            expect(submitStub.firstCall.args[2]).to.equal('task-launch')
        })

        it('refuses a launch-result.json with an unsupported schemaVersion', async () => {
            const full = writeZip('launch.zip', { 'launch-result.json': JSON.stringify({ schemaVersion: '2.1' }) })

            const result = await handler.completeHitlWithTestResults(WS_ID, JOB_ID, 'task-launch', full, tmpRoot)

            expect(result.Error).to.equal('Unsupported launch-result.json schemaVersion: 2.1')
            expect(uploadUrlStub.called).to.be.false
        })

        it('refuses a ZIP with neither result file, before uploading', async () => {
            const full = writeZip('results.zip', { 'trx/SampleWebApi/r2.trx': '<TestRun/>' })

            const result = await handler.completeHitlWithTestResults(WS_ID, JOB_ID, 'task-run', full, tmpRoot)

            expect(result.Error).to.contain('neither summary.json nor launch-result.json')
            expect(uploadUrlStub.called).to.be.false
        })

        it('refuses a summary.json with an unsupported schemaVersion', async () => {
            const full = writeZip('results.zip', { 'summary.json': summary('2.0') })

            const result = await handler.completeHitlWithTestResults(WS_ID, JOB_ID, 'task-run', full, tmpRoot)

            expect(result.Error).to.contain('schemaVersion: 2.0')
            expect(uploadUrlStub.called).to.be.false
        })

        it('reports a failed submit', async () => {
            submitStub.resolves(null)
            const full = writeZip('results.zip', { 'summary.json': summary() })

            const result = await handler.completeHitlWithTestResults(WS_ID, JOB_ID, 'task-run', full, tmpRoot)

            expect(result).to.deep.equal({ Success: false, Error: 'Failed to submit HITL task' })
        })
    })

    describe('itGenTestProjectDir', () => {
        it('returns the project folder, with or without nesting', () => {
            expect(
                itGenTestProjectDir('GeneratedApiTests.SampleWebApi/GeneratedApiTests.SampleWebApi.csproj')
            ).to.equal('GeneratedApiTests.SampleWebApi')
            expect(itGenTestProjectDir('tests\\Api\\Api.csproj')).to.equal(path.join('tests', 'Api'))
            expect(itGenTestProjectDir('./Api/Api.csproj')).to.equal('Api')
        })

        it('returns an empty folder for a project at the artifact root', () => {
            expect(itGenTestProjectDir('Api.csproj')).to.equal('')
        })

        it('refuses missing, rooted and climbing paths', () => {
            for (const bad of [
                undefined,
                '',
                '   ',
                '/abs/Api.csproj',
                'C:\\x\\Api.csproj',
                'a/../../Api.csproj',
                42,
            ]) {
                expect(itGenTestProjectDir(bad), String(bad)).to.be.undefined
            }
        })
    })
})
