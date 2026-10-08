/**
 * ATX .NET LSP — job lifecycle integration tests.
 *
 * Ground rules: no mocks and no environment changes. Every behavior is triggered by an input a real
 * client could send. Direct FES calls are used only for setup/cleanup the LSP can't do (creating or
 * deleting a workspace, deleting a job).
 *
 * Isolation: the suite runs in its own workspace, created in before() and deleted in after(), so the
 * orphan check never sees jobs from other runs sharing the account.
 */
import { expect } from 'chai'
import * as crypto from 'crypto'
import * as os from 'os'
import * as path from 'path'
import { AtxTestSession, JOB_NAME_PREFIX, getSourceFiles, sleep } from './atxTestHarness'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip')

describe('ATX .NET LSP job lifecycle', function (this: Mocha.Suite) {
    this.timeout(30 * 60000)

    const runtimeFile = process.env.TEST_RUNTIME_FILE || ''
    const token = process.env.TEST_SSO_TOKEN || ''
    const startUrl = process.env.TEST_SSO_START_URL || ''
    const fixtureRoot = path.resolve(__dirname, 'testFixture', 'bobs-used-bookstore-classic')

    let session: AtxTestSession
    let workspaceId: string
    let sourceFiles: string[]
    let before_: Set<string>
    const orphansFound: string[] = []

    const jobName = (id: string) => `${JOB_NAME_PREFIX}${id}-${Date.now()}`
    const start = (id: string, overrides: Partial<{ workspaceId: string; root: string; files: string[] }> = {}) =>
        session.startTransform({
            workspaceId: overrides.workspaceId ?? workspaceId,
            jobName: jobName(id),
            solutionRootPath: overrides.root ?? fixtureRoot,
            sourceFiles: overrides.files ?? sourceFiles,
        })
    const stop = (jobId: string, ws = workspaceId) =>
        session.command({ command: 'aws/atxTransform/stopJob', WorkspaceId: ws, JobId: jobId })

    before(async function (this: Mocha.Context) {
        if (!runtimeFile || !token || !startUrl) {
            throw new Error('TEST_RUNTIME_FILE, TEST_SSO_TOKEN and TEST_SSO_START_URL must be set')
        }
        sourceFiles = getSourceFiles(fixtureRoot)
        session = new AtxTestSession(runtimeFile, token, startUrl)
        await session.start()
        workspaceId = await session.fesCreateWorkspace(`${JOB_NAME_PREFIX}Lifecycle-${Date.now()}`)
        console.log(`[setup] workspace=${workspaceId} profile=${session.profileArn} sourceFiles=${sourceFiles.length}`)
    })

    after(async function (this: Mocha.Context) {
        this.timeout(15 * 60000)
        if (session && workspaceId) {
            await session.checkAndCleanup(workspaceId, new Set())
            try {
                await session.fesDeleteWorkspace(workspaceId)
            } catch (e) {
                console.error(`[teardown] could not delete workspace ${workspaceId}: ${e}`)
            }
        }
        session?.close()
    })

    beforeEach(async function (this: Mocha.Context) {
        before_ = await session.snapshot(workspaceId)
    })

    afterEach(async function (this: Mocha.Context) {
        this.timeout(15 * 60000)
        const orphans = await session.checkAndCleanup(workspaceId, before_)
        if (orphans.length) {
            console.error(`[orphan check] ${this.currentTest?.title}: orphaned job(s) ${orphans.join(', ')}`)
            orphansFound.push(...orphans.map(o => `${this.currentTest?.title}: ${o}`))
        }
    })

    // ---------------------------------------------------------------- startTransform failures

    describe('CreateJob rejects a well-formed but unusable workspace', () => {
        it('random workspace ID', async () => {
            const t0 = Date.now()
            const result = await start('RandomWorkspace', { workspaceId: crypto.randomUUID() })
            console.log(`random workspace: ${JSON.stringify(result)} (${Date.now() - t0}ms)`)
            expect(result?.error, 'error flag').to.equal(true)
            expect(result?.TransformationJobId, 'no job ID').to.be.undefined
        })

        it('workspace that was deleted (stale cached ID)', async () => {
            const staleId = await session.fesCreateWorkspace(`${JOB_NAME_PREFIX}DeletedWorkspace-${Date.now()}`)
            await session.fesDeleteWorkspace(staleId)
            const result = await start('DeletedWorkspace', { workspaceId: staleId })
            console.log(`deleted workspace: ${JSON.stringify(result)}`)
            expect(result?.error, 'error flag').to.equal(true)
            expect(result?.TransformationJobId, 'no job ID').to.be.undefined
        })
    })

    it('source files no longer exist (solution moved after selection)', async () => {
        // Same file list VS captured, but the solution has since moved: none of the paths exist.
        const movedRoot = path.join(os.tmpdir(), `atx-moved-${Date.now()}`, 'bobs-used-bookstore-classic')
        const movedFiles = sourceFiles.map(f => path.join(movedRoot, path.relative(fixtureRoot, f)))
        const result = await start('MovedSolution', { root: movedRoot, files: movedFiles })
        console.log(`moved solution: ${JSON.stringify(result)}`)

        // Records today's behavior: the job is created and started with an empty upload.
        expect(result?.error, 'expected today: no error').to.not.equal(true)
        expect(result?.TransformationJobId, 'expected today: a job ID').to.be.a('string')
        // The LSP creates each target folder before attempting the copy, so the zip keeps the empty
        // directory tree. Count files only.
        const entries: any[] = new AdmZip(result.ArtifactPath).getEntries()
        const sourceFiles_ = entries.filter(
            e => !e.isDirectory && e.entryName.replace(/\\/g, '/').startsWith('sourceCode/')
        )
        console.log(`moved solution: upload has ${entries.length} entries, ${sourceFiles_.length} source files`)
        expect(sourceFiles_, 'expected today: no source files uploaded').to.have.length(0)
    })

    // ---------------------------------------------------------------- stopping a job

    describe('stop a job before planning', () => {
        let jobId: string

        it('stop right after start, then reaches STOPPED', async () => {
            const started = await start('StopEarly')
            jobId = started?.TransformationJobId
            expect(jobId, `startTransform: ${JSON.stringify(started)}`).to.be.a('string')

            const stopResult = await stop(jobId)
            console.log(`stop early: stopJob -> ${JSON.stringify(stopResult)}`)
            expect(stopResult?.Status).to.be.oneOf(['STOPPING', 'STOPPED'])

            const t0 = Date.now()
            const info = await session.pollUntil(workspaceId, jobId, ['STOPPED'], 5 * 60000, 5000)
            console.log(`stop early: STOPPED after ${Math.round((Date.now() - t0) / 1000)}s: ${JSON.stringify(info)}`)
            expect(info.ErrorString).to.equal('Transformation job stopped')
            expect(info.TransformationPlan, 'no plan for a stopped job').to.be.undefined
            expect((await session.listJobIds(workspaceId)).get(jobId), 'listJobs agrees').to.equal('STOPPED')

            // A second click on Stop. Record today's behavior.
            const second = await stop(jobId)
            console.log(`stop early: second stopJob -> ${JSON.stringify(second)}`)
            expect(second?.Status).to.be.oneOf(['STOPPING', 'STOPPED', 'FAILED'])
        })
    })

    it('stop a job that was deleted elsewhere', async () => {
        const started = await start('StopDeleted')
        const jobId = started?.TransformationJobId
        expect(jobId, `startTransform: ${JSON.stringify(started)}`).to.be.a('string')
        await stop(jobId)
        await session.pollUntil(workspaceId, jobId, ['STOPPED'], 5 * 60000, 5000)
        await session.fesDeleteJob(workspaceId, jobId)

        const t0 = Date.now()
        const result = await stop(jobId)
        console.log(`stop deleted: stopJob on deleted job -> ${JSON.stringify(result)} (${Date.now() - t0}ms)`)
        expect(result?.Status, 'expected today: FAILED').to.equal('FAILED')
    })

    it('stop during EXECUTING', async function (this: Mocha.Context) {
        this.timeout(45 * 60000)
        const started = await start('StopExecuting')
        const jobId = started?.TransformationJobId
        expect(jobId, `startTransform: ${JSON.stringify(started)}`).to.be.a('string')

        // Same trigger the IDE flow uses to start the orchestrator.
        await sleep(30000)
        await session.command({
            command: 'aws/atxTransform/sendMessage',
            workspaceId,
            jobId,
            text: 'I have uploaded the code, please start the assessment',
            skipPolling: true,
        })

        const t0 = Date.now()
        await session.pollUntil(workspaceId, jobId, ['EXECUTING'], 35 * 60000, 15000)
        console.log(`stop executing: EXECUTING after ${Math.round((Date.now() - t0) / 60000)} min`)

        const stopResult = await stop(jobId)
        console.log(`stop executing: stopJob -> ${JSON.stringify(stopResult)}`)
        expect(stopResult?.Status).to.be.oneOf(['STOPPING', 'STOPPED'])
        const t1 = Date.now()
        await session.pollUntil(workspaceId, jobId, ['STOPPED'], 5 * 60000, 5000)
        console.log(`stop executing: STOPPED after ${Math.round((Date.now() - t1) / 1000)}s`)

        const t2 = Date.now()
        const after = await session.getStatus(workspaceId, jobId)
        expect(after?.TransformationJob?.Status).to.equal('STOPPED')
        expect(Date.now() - t2, 'getTransformInfo on a stopped job returns promptly').to.be.below(30000)
    })

    // ---------------------------------------------------------------- listing and profiles

    it('listJobs shows the new job; profile discovery found IAD', async () => {
        expect(session.profileArn, 'IAD profile discovered').to.match(/^arn:aws:transform:us-east-1:/)
        const started = await start('ListJobs')
        const jobId = started?.TransformationJobId
        expect(jobId, `startTransform: ${JSON.stringify(started)}`).to.be.a('string')

        const result = await session.command({ command: 'aws/atxTransform/listJobs', WorkspaceId: workspaceId })
        const job = result?.Jobs?.find((j: any) => j.JobId === jobId)
        console.log(`listJobs: ${JSON.stringify(job)}`)
        expect(job, 'job is listed').to.exist
        expect(job.JobName).to.match(/^IntegTest-ListJobs-/)
        expect(job.Status).to.be.a('string').and.not.equal('UNKNOWN')
    })

    // ---------------------------------------------------------------- router validation

    describe('router input validation', () => {
        const required: Array<[string, any, RegExp]> = [
            ['listJobs', {}, /WorkspaceId is required/],
            ['startTransform', { useOrchestratorAgent: true }, /WorkspaceId is required/],
            ['stopJob', {}, /WorkspaceId and JobId are required/],
            ['completeLocalBuildHitl', {}, /BuildResultJson is required/],
            ['getJobDashboard', {}, /WorkspaceId and JobId are required/],
            ['getJobReport', {}, /WorkspaceId, JobId and ArtifactId are required/],
            ['loadOlderWorklogs', {}, /workspaceId, jobId and solutionRootPath are required/],
            ['listBeamedRepos', {}, /WorkspaceId and ParentJobId are required/],
            ['downloadBeamArtifact', {}, /are required for downloadBeamArtifact/],
        ]
        for (const [name, params, message] of required) {
            it(`${name} without required parameters`, async () => {
                const result = await session.command({ command: `aws/atxTransform/${name}`, ...params }, 30000)
                expect(result?.error, JSON.stringify(result)).to.equal(true)
                expect(result?.message).to.match(message)
            })
        }

        it('startTransform with useOrchestratorAgent:false is rejected', async () => {
            const result = await session.command(
                { command: 'aws/atxTransform/startTransform', WorkspaceId: workspaceId, useOrchestratorAgent: false },
                30000
            )
            expect(result?.error).to.equal(true)
            expect(result?.message).to.match(/no longer supported/)
        })

        it('unknown command', async () => {
            const result = await session.command({ command: 'aws/atxTransform/doesNotExist' }, 30000)
            console.log(`unknown command: ${JSON.stringify(result)}`)
            // Record today's behavior: either the ATX router's error or no handler at all.
            expect(result === null || result === undefined || result?.error === true, JSON.stringify(result)).to.equal(
                true
            )
        })

        it('malformed (non-UUID) workspace ID', async () => {
            const result = await start('MalformedWorkspace', { workspaceId: 'not-a-workspace' })
            expect(result?.error).to.equal(true)
            expect(result?.TransformationJobId).to.be.undefined
        })
    })

    // ---------------------------------------------------------------- harness orphan check

    it('no orphaned jobs across the suite', () => {
        expect(orphansFound, `orphaned jobs: ${orphansFound.join('; ')}`).to.be.empty
    })
})
