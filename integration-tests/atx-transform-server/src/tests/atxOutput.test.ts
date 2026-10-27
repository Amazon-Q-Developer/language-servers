/**
 * ATX .NET LSP — transform output and progress integration tests.
 *
 * Ground rules: no mocks and no environment changes. Every behavior is triggered by an input a real
 * client could send. Direct FES calls are used only for setup/cleanup the LSP can't do.
 *
 * The upload tests are fast: each starts a job, inspects the upload, and stops it. The other tests
 * share one real transform: chat is checked while the agent plans, then the job is polled to
 * COMPLETED the way VS does (with SolutionRootPath, so the LSP applies each step's changes and saves
 * worklogs), the final artifact is checked, and older worklogs are paged in from the finished job.
 * The slow job runs on a temp copy of the fixture, because polling with SolutionRootPath writes into
 * the solution folder.
 */
import { expect } from 'chai'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AtxTestSession, JOB_NAME_PREFIX, copyFixture, getSourceFiles, sleep } from './atxTestHarness'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip')

const ARTIFACT_FOLDER = 'artifactWorkspace'

function md5(file: string): string {
    return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex')
}

/** Zip entry names use '/', and the LSP builds relative paths with path.join (so '\' on Windows). */
const zipName = (relativePath: string) => relativePath.replace(/\\/g, '/')

function findFiles(dir: string, ext: string, skip: string[] = []): string[] {
    const found: string[] = []
    const walk = (current: string) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name)
            if (entry.isDirectory()) {
                if (!skip.includes(entry.name)) walk(full)
            } else if (entry.name.endsWith(ext)) {
                found.push(full)
            }
        }
    }
    walk(dir)
    return found
}

function readWorklogs(root: string, jobId: string): Record<string, { timestamp: string; text: string }[]> {
    const file = path.join(root, ARTIFACT_FOLDER, jobId, 'worklogs.json')
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
}

/** The TargetFramework(s) a project file declares, for logging. */
const targetFrameworks = (file: string) =>
    (fs.readFileSync(file, 'utf8').match(/<TargetFrameworks?(Version)?>[^<]*</g) ?? []).join(', ') || 'none'

const worklogCount = (logs: Record<string, any[]>) => Object.values(logs).reduce((n, e) => n + e.length, 0)

describe('ATX .NET LSP transform output and progress', function (this: Mocha.Suite) {
    this.timeout(30 * 60000)

    const runtimeFile = process.env.TEST_RUNTIME_FILE || ''
    const token = process.env.TEST_SSO_TOKEN || ''
    const startUrl = process.env.TEST_SSO_START_URL || ''
    const fixtureRoot = path.resolve(__dirname, 'testFixture', 'bobs-used-bookstore-classic')

    let session: AtxTestSession
    let workspaceId: string
    const tempDirs: string[] = []

    const jobName = (id: string) => session.jobName(id)

    before(async function (this: Mocha.Context) {
        if (!runtimeFile || !token || !startUrl) {
            throw new Error('TEST_RUNTIME_FILE, TEST_SSO_TOKEN and TEST_SSO_START_URL must be set')
        }
        session = new AtxTestSession(runtimeFile, token, startUrl)
        await session.start()
        session.startTokenRefresh()
        workspaceId = await session.fesCreateWorkspace(`${JOB_NAME_PREFIX}Output-${Date.now()}`)
        console.log(`[setup] workspace=${workspaceId} profile=${session.profileArn}`)
    })

    after(async function (this: Mocha.Context) {
        this.timeout(15 * 60000)
        if (session && workspaceId) {
            await session.checkAndCleanup(workspaceId, new Set())
            await session.deleteWorkspaceIfEmpty(workspaceId)
        }
        session?.close()
        for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
    })

    // ---------------------------------------------------------------- upload contents (fast)

    describe('upload contents match the request', () => {
        let before_: Set<string>
        const orphans: string[] = []

        beforeEach(async () => {
            before_ = await session.snapshot(workspaceId)
        })

        afterEach(async function (this: Mocha.Context) {
            this.timeout(15 * 60000)
            orphans.push(...(await session.checkAndCleanup(workspaceId, before_)))
        })

        after(() => {
            expect(orphans, `orphaned jobs: ${orphans.join(', ')}`).to.be.empty
        })

        // Each case flips the request flags the LSP copies into requirement.json.
        const cases = [
            {
                id: 'DefaultFlags',
                TransformNetStandardProjects: false,
                EnableRazorViewTransform: true,
                EnableWebFormsTransform: false,
            },
            {
                id: 'FlippedFlags',
                TransformNetStandardProjects: true,
                EnableRazorViewTransform: false,
                EnableWebFormsTransform: true,
            },
        ]

        for (const flags of cases) {
            it(`${flags.id}: requirement.json, preferences and source files`, async () => {
                const sourceFiles = getSourceFiles(fixtureRoot)
                const request = {
                    workspaceId,
                    jobName: jobName(flags.id),
                    solutionRootPath: fixtureRoot,
                    sourceFiles,
                }
                const result = await session.startTransform(request, {
                    TransformNetStandardProjects: flags.TransformNetStandardProjects,
                    EnableRazorViewTransform: flags.EnableRazorViewTransform,
                    EnableWebFormsTransform: flags.EnableWebFormsTransform,
                })
                expect(result?.TransformationJobId, `startTransform: ${JSON.stringify(result)}`).to.be.a('string')
                const zip = new AdmZip(result.ArtifactPath)
                const entries = new Map<string, any>(
                    zip
                        .getEntries()
                        .filter((e: any) => !e.isDirectory)
                        .map((e: any) => [zipName(e.entryName), e])
                )

                const requirement = JSON.parse(zip.readAsText(entries.get('requirement.json')))
                const rel = (p: string) => path.join('sourceCode', path.relative(fixtureRoot, p))
                expect(requirement.EntryPath).to.equal(
                    rel(path.join(fixtureRoot, 'app', 'Bookstore.Web', 'Bookstore.Web.csproj'))
                )
                expect(requirement.SolutionPath).to.equal(rel(path.join(fixtureRoot, 'BobsBookstoreClassic.sln')))
                expect(requirement.TransformNetStandardProjects).to.equal(flags.TransformNetStandardProjects)
                expect(requirement.EnableRazorViewTransform).to.equal(flags.EnableRazorViewTransform)
                expect(requirement.EnableWebFormsTransform).to.equal(flags.EnableWebFormsTransform)
                expect(requirement.Packages, 'no package references sent').to.deep.equal([])
                expect(requirement.Projects.map((p: any) => p.projectFilePath)).to.deep.equal(
                    ['Bookstore.Web', 'Bookstore.Common', 'Bookstore.Data', 'Bookstore.Domain'].map(n =>
                        rel(path.join(fixtureRoot, 'app', n, `${n}.csproj`))
                    )
                )

                // Every source file sent is listed with its MD5 and is in the zip with the same bytes.
                const web = requirement.Projects[0]
                expect(web.projectTarget).to.equal('net48')
                expect(web.references).to.deep.equal([])
                const byPath = new Map<string, string>(
                    web.codeFiles.map((f: any) => [f.relativePath, f.contentMd5Hash])
                )
                expect(byPath.size, 'codeFiles count').to.equal(sourceFiles.length)
                for (const file of sourceFiles) {
                    const relativePath = rel(file)
                    expect(byPath.get(relativePath), `md5 of ${relativePath}`).to.equal(md5(file))
                    const entry = entries.get(zipName(relativePath))
                    expect(entry, `${relativePath} in zip`).to.exist
                    expect(crypto.createHash('md5').update(entry.getData()).digest('hex')).to.equal(md5(file))
                }

                // No database settings were sent, so no transformation is switched on.
                const preferences = JSON.parse(zip.readAsText(entries.get('transformation-preferences.json')))
                expect(preferences.Transformations).to.deep.equal({})
                expect(new Date(preferences.Metadata.GeneratedAt).getTime(), 'GeneratedAt is a date').to.be.above(0)
                console.log(`${flags.id}: ${entries.size} files in upload, ${byPath.size} code files verified`)
            })
        }
    })

    // ---------------------------------------------------------------- one real transform (slow)

    describe('one transform from start to COMPLETED', function (this: Mocha.Suite) {
        let root: string
        let jobId: string
        let kickoffMessageId: string
        let completed: any
        let before_: Set<string>

        before(async () => {
            root = copyFixture(fixtureRoot, 'output')
            tempDirs.push(path.dirname(root))
            before_ = await session.snapshot(workspaceId)
        })

        after(async function (this: Mocha.Context) {
            this.timeout(15 * 60000)
            const orphans = await session.checkAndCleanup(workspaceId, before_)
            expect(orphans, `orphaned jobs: ${orphans.join(', ')}`).to.be.empty
        })

        it('starts the job and sends the kickoff message', async () => {
            const result = await session.startTransform({
                workspaceId,
                jobName: jobName('FullTransform'),
                solutionRootPath: root,
                sourceFiles: getSourceFiles(root),
            })
            jobId = result?.TransformationJobId
            expect(jobId, `startTransform: ${JSON.stringify(result)}`).to.be.a('string')

            // Same trigger the IDE flow uses to start the orchestrator; the agent needs ~30s to come up.
            await sleep(30000)
            const sent = await session.command({
                command: 'aws/atxTransform/sendMessage',
                workspaceId,
                jobId,
                text: 'I have uploaded the code, please start the assessment',
                skipPolling: true,
            })
            console.log(`kickoff: ${JSON.stringify(sent)}`)
            expect(sent?.success).to.equal(true)
            kickoffMessageId = sent?.data?.sentMessage?.messageId
            expect(kickoffMessageId, 'sent message ID').to.be.a('string')
        })

        it('chat round trip (listMessages, batchGetMessages, pagination, startTimestamp)', async function (this: Mocha.Context) {
            if (!kickoffMessageId) this.skip()
            const list = (extra: Record<string, any> = {}) =>
                session.command({ command: 'aws/atxTransform/listMessages', workspaceId, jobId, ...extra })
            const batchGet = (messageIds: string[]) =>
                session.command({ command: 'aws/atxTransform/batchGetMessages', workspaceId, messageIds })

            // Wait for the agent's answer to the kickoff: a final response, or an error message.
            const answered = (m: any) =>
                m.messageOrigin !== 'USER' && ['FINAL_RESPONSE', 'ERROR'].includes(m.processingInfo?.messageType)
            const deadline = Date.now() + 20 * 60000
            let messages: any[] = []
            while (Date.now() < deadline) {
                const ids: string[] = (await list({ maxResults: 50 }))?.messageIds ?? []
                messages = ids.length ? ((await batchGet(ids))?.messages ?? []) : []
                if (messages.some(answered)) break
                await sleep(15000)
            }
            console.log(`chat: ${messages.length} message(s):`)
            for (const m of messages) {
                const text = String(m.text ?? '')
                    .replace(/\s+/g, ' ')
                    .slice(0, 120)
                console.log(`  ${m.createdAt} ${m.messageOrigin}:${m.processingInfo?.messageType ?? '-'} "${text}"`)
            }
            expect(
                messages.map(m => m.messageId),
                'the kickoff message is listed'
            ).to.include(kickoffMessageId)
            const reply = messages.find(answered)
            expect(reply, 'a final response or error from the agent within 20 min').to.exist
            // The platform sometimes fails the first message ("internal error communicating with the
            // agent"); the job then never leaves PLANNING, so fail here with the agent's own words.
            expect(reply.processingInfo.messageType, `agent replied with an error: ${reply.text}`).to.equal(
                'FINAL_RESPONSE'
            )
            expect(reply.text ?? reply.interactions, 'the reply has content').to.exist

            // Pagination: one message per page, and the next page doesn't repeat it.
            const page1 = await list({ maxResults: 1 })
            expect(page1?.messageIds).to.have.length(1)
            expect(page1?.nextToken, 'nextToken when more than one message exists').to.be.a('string')
            const page2 = await list({ maxResults: 1, nextToken: page1.nextToken })
            expect(page2?.messageIds).to.have.length(1)
            expect(page2.messageIds[0]).to.not.equal(page1.messageIds[0])

            // startTimestamp: only messages created at or after it come back.
            const newest = Math.max(...messages.map(m => new Date(m.createdAt).getTime()))
            const since = await list({ maxResults: 50, startTimestamp: new Date(newest).toISOString() })
            const sinceMessages = since?.messageIds?.length ? (await batchGet(since.messageIds)).messages : []
            console.log(`chat: ${sinceMessages.length} message(s) since ${new Date(newest).toISOString()}`)
            for (const m of sinceMessages) {
                expect(new Date(m.createdAt).getTime(), `${m.messageId} createdAt`).to.be.at.least(newest)
            }
            expect(sinceMessages.length, 'startTimestamp filters out older messages').to.be.below(messages.length)
        })

        it("polls to COMPLETED with SolutionRootPath; each step's changes apply locally", async function (this: Mocha.Context) {
            this.timeout(4 * 60 * 60000)
            if (!jobId) this.skip()
            const diffFailures: string[] = []
            const failedSteps = new Set<string>()
            const answeredLbv = new Set<string>()
            let sawExecutingPlan = false
            let status = ''
            let polls = 0
            const t0 = Date.now()
            const deadline = t0 + 3.75 * 60 * 60000

            while (Date.now() < deadline) {
                const info = await session.getStatus(workspaceId, jobId, {
                    SolutionRootPath: root,
                    GetCheckpoints: true,
                })
                polls++
                status = info?.TransformationJob?.Status ?? ''
                const steps: any[] = info?.TransformationPlan?.Root?.Children ?? []
                if (info?.DiffApplyFailed) {
                    diffFailures.push(`poll ${polls} (${status}): ${JSON.stringify(info.DiffApplyFailedStepIds)}`)
                    for (const id of info.DiffApplyFailedStepIds ?? []) failedSteps.add(id)
                }
                // Planning normally produces plan steps within ~5 min. A job with none after 30 min is
                // stuck (seen when the agent never got the kickoff message), so stop waiting.
                if (status === 'PLANNING' && !steps.length && Date.now() - t0 > 30 * 60000) {
                    throw new Error(`job still PLANNING with no plan steps after 30 min (${polls} polls)`)
                }
                if (polls % 10 === 1 || info?.HitlTag) {
                    const mins = Math.round((Date.now() - t0) / 60000)
                    console.log(
                        `poll ${polls} (${mins} min): ${status} steps=${steps.length} hitl=${info?.HitlTag ?? '-'}`
                    )
                }

                // GetCheckpoints:true fills HasCheckpoint on every plan step while the job is executing.
                if (status === 'EXECUTING' && steps.length) {
                    sawExecutingPlan = true
                    const unset: string[] = []
                    const walk = (s: any) => {
                        if (typeof s.HasCheckpoint !== 'boolean') unset.push(s.StepId)
                        s.Children?.forEach(walk)
                    }
                    steps.forEach(walk)
                    expect(unset, 'steps without HasCheckpoint').to.be.empty
                }

                // Same answers as today's E2E flow: a passing local build, then ask the agent to finish.
                if (
                    info?.HitlTag === 'local-build-verification' &&
                    info.HitlTaskId &&
                    !answeredLbv.has(info.HitlTaskId)
                ) {
                    answeredLbv.add(info.HitlTaskId)
                    const now = new Date().toISOString()
                    const lbv = await session.command({
                        command: 'aws/atxTransform/completeLocalBuildHitl',
                        WorkspaceId: workspaceId,
                        TransformationJobId: jobId,
                        TaskId: info.HitlTaskId,
                        BuildResultJson: JSON.stringify({
                            status: 'SUCCESS',
                            errorCount: 0,
                            errors: [],
                            warningCount: 0,
                            timedOut: false,
                            startedAt: now,
                            finishedAt: now,
                            durationSeconds: 1,
                        }),
                        SolutionRootPath: root,
                    })
                    console.log(`completeLocalBuildHitl ${info.HitlTaskId} -> ${JSON.stringify(lbv)}`)
                    await sleep(10000)
                    await session.command({
                        command: 'aws/atxTransform/sendMessage',
                        workspaceId,
                        jobId,
                        text: 'Mark this job as complete',
                        skipPolling: true,
                    })
                }

                if (status === 'FAILED') {
                    throw new Error(`job FAILED: ${info?.TransformationJob?.FailureReason ?? info?.ErrorString}`)
                }
                if (status === 'COMPLETED' || status === 'PARTIALLY_COMPLETED') {
                    completed = info
                    break
                }
                await sleep(30000)
            }

            console.log(`${status} after ${Math.round((Date.now() - t0) / 60000)} min, ${polls} polls`)
            expect(status).to.be.oneOf(['COMPLETED', 'PARTIALLY_COMPLETED'])
            expect(sawExecutingPlan, 'saw the plan while EXECUTING').to.equal(true)
            expect(completed.TransformationPlan?.Root?.Children ?? [], 'plan on the final poll').to.not.be.empty

            // The agent's changes were applied to the local solution, so the web project now targets net8.0.
            const webProject = fs.readFileSync(path.join(root, 'app', 'Bookstore.Web', 'Bookstore.Web.csproj'), 'utf8')
            const webProjectPath = path.join(root, 'app', 'Bookstore.Web', 'Bookstore.Web.csproj')
            console.log(`local Bookstore.Web.csproj after apply: ${targetFrameworks(webProjectPath)}`)
            expect(webProject, 'local Bookstore.Web.csproj after apply').to.match(/net8\.0/)

            // Worklogs were saved while polling: one list per step, each entry a timestamp and text, no repeats.
            const logs = readWorklogs(root, jobId)
            console.log(`${worklogCount(logs)} worklog entries across ${Object.keys(logs).length} step(s)`)
            expect(worklogCount(logs), 'worklog entries').to.be.above(0)
            for (const [step, entries] of Object.entries(logs)) {
                for (const e of entries) {
                    expect(new Date(e.timestamp).getTime(), `${step} timestamp`).to.be.above(0)
                    expect(e.text, `${step} text`).to.be.a('string')
                }
                expect(new Set(entries.map(e => e.text)).size, `${step} has no repeated entries`).to.equal(
                    entries.length
                )
            }

            // A step can show as COMPLETED a poll before its changes can be downloaded, so one poll may
            // report DiffApplyFailed. Allow that, but every such step must be applied on a later poll and
            // the final poll must report no failure.
            console.log(`polls with DiffApplyFailed: ${diffFailures.length ? diffFailures.join('; ') : 'none'}`)
            const appliedFile = path.join(root, ARTIFACT_FOLDER, jobId, 'checkpoints', 'checkpoints-applied.json')
            const applied: string[] = fs.existsSync(appliedFile)
                ? (JSON.parse(fs.readFileSync(appliedFile, 'utf8')).appliedSteps ?? [])
                : []
            console.log(
                `applied steps: ${applied.length}; steps that failed on some poll: ${failedSteps.size ? [...failedSteps].join(', ') : 'none'}`
            )
            expect(
                [...failedSteps].filter(id => !applied.includes(id)),
                'failed steps never applied'
            ).to.be.empty
            expect(completed.DiffApplyFailed, 'DiffApplyFailed on the final poll').to.not.equal(true)
        })

        it('final artifact downloads, extracts, and targets net8.0', async function (this: Mocha.Context) {
            if (!completed) this.skip()
            // The IDE's "download artifact" path: listArtifacts, then downloadArtifact to a folder.
            const listed = await session.command({
                command: 'aws/atxTransform/listArtifacts',
                WorkspaceId: workspaceId,
                TransformationJobId: jobId,
            })
            const summary = listed?.Artifacts?.map((a: any) => `${a.Name} (${a.SizeInBytes} B, id ${a.ArtifactId})`)
            console.log(`listArtifacts -> ${JSON.stringify(summary)}`)
            expect(listed?.Error).to.be.undefined
            expect(listed?.Artifacts, 'customer output artifacts').to.not.be.empty
            const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atx-download-'))
            tempDirs.push(saveDir)
            for (const artifact of listed.Artifacts) {
                const download = await session.command(
                    {
                        command: 'aws/atxTransform/downloadArtifact',
                        WorkspaceId: workspaceId,
                        TransformationJobId: jobId,
                        ArtifactId: artifact.ArtifactId,
                        ArtifactName: artifact.Name,
                        SavePath: saveDir,
                    },
                    300000
                )
                expect(download?.Success, `${artifact.Name}: ${JSON.stringify(download)}`).to.equal(true)
                const file = path.join(saveDir, path.basename(artifact.Name))
                expect(fs.statSync(file).size, `${artifact.Name} size matches listArtifacts`).to.equal(
                    artifact.SizeInBytes
                )
            }

            // The transformed solution is the one zip among the job's outputs. The agent names it (seen:
            // TransformedSource.zip, BobsBookstoreClassic_Migrated.zip), so match on the extension.
            const zips = listed.Artifacts.filter((a: any) => path.extname(a.Name).toLowerCase() === '.zip')
            expect(zips, 'exactly one .zip in listArtifacts').to.have.length(1)
            const zipFile = path.join(saveDir, path.basename(zips[0].Name))
            const extracted = path.join(saveDir, 'transformed')
            new AdmZip(zipFile).extractAllTo(extracted, true)
            const projects = findFiles(extracted, '.csproj')
            console.log(`${zips[0].Name} has ${projects.length} .csproj file(s):`)
            for (const p of projects) console.log(`  ${path.relative(extracted, p)}: ${targetFrameworks(p)}`)
            expect(projects, `.csproj files in ${zips[0].Name}`).to.not.be.empty
            for (const p of projects) {
                expect(fs.readFileSync(p, 'utf8'), path.relative(extracted, p)).to.match(/net8\.0/)
            }

            // On COMPLETED the LSP also downloads a final artifact and extracts it under the solution
            // root. Records today's behavior: it takes the first CUSTOMER_OUTPUT artifact, which is
            // Transformation_Report.html rather than the zip, so the extract fails and ArtifactPath is null.
            const first = listed.Artifacts[0]
            console.log(
                `COMPLETED poll ArtifactPath=${completed.ArtifactPath}; first listed artifact: ${first.Name} (id ${first.ArtifactId})`
            )
            expect(completed.ArtifactPath, 'expected today: no ArtifactPath on the COMPLETED poll').to.equal(null)
        })

        it('loadOlderWorklogs pages back through the finished job', async function (this: Mocha.Context) {
            if (!completed) this.skip()
            // The COMPLETED poll fetches the newest worklog page in the background; let it land.
            await sleep(10000)
            const counts = [worklogCount(readWorklogs(root, jobId))]
            let hasMore = true
            let pages = 0
            while (hasMore && pages < 50) {
                const result = await session.command({
                    command: 'aws/atxTransform/loadOlderWorklogs',
                    workspaceId,
                    jobId,
                    solutionRootPath: root,
                })
                expect(result?.error, JSON.stringify(result)).to.not.equal(true)
                hasMore = result?.hasMore === true
                pages++
                counts.push(worklogCount(readWorklogs(root, jobId)))
            }
            console.log(`older worklogs: ${pages} page(s), worklog entries per page: ${counts.join(' -> ')}`)
            expect(hasMore, 'paging ends (hasMore:false) within 50 pages').to.equal(false)
            for (let i = 1; i < counts.length; i++) {
                expect(counts[i], `entries never shrink (page ${i})`).to.be.at.least(counts[i - 1])
            }
            for (const [step, entries] of Object.entries(readWorklogs(root, jobId))) {
                expect(new Set(entries.map(e => e.text)).size, `${step} has no repeated entries`).to.equal(
                    entries.length
                )
            }
        })
    })
})
