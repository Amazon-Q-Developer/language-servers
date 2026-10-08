import * as fs from 'fs'
import * as path from 'path'
import { LspClient } from './lspClient'

// The LSP has no delete command, so cleanup (and workspace setup for stale-ID cases) talks to FES
// directly with the same bearer token + Origin the LSP uses. These are test-harness actions, not
// part of the behavior under test.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fes = require('@amazon/elastic-gumby-frontend-client')

export const TERMINAL_STATUSES = ['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'STOPPED']
export const JOB_NAME_PREFIX = 'IntegTest-'
const REGION = 'us-east-1'
const FES_ENDPOINT = `https://api.transform.${REGION}.on.aws/`

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export function getSourceFiles(
    dir: string,
    extensions: string[] = ['.cs', '.csproj', '.sln', '.config', '.json', '.cshtml', '.razor']
): string[] {
    const files: string[] = []
    const excluded = ['.git', 'bin', 'obj', 'node_modules', '.vs', '.idea', 'artifactWorkspace']
    const walk = (current: string) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name)
            if (entry.isDirectory()) {
                if (!excluded.includes(entry.name)) walk(full)
            } else if (extensions.some(ext => entry.name.endsWith(ext))) {
                files.push(full)
            }
        }
    }
    walk(dir)
    return files
}

export interface StartTransformInputs {
    workspaceId: string
    jobName: string
    solutionRootPath: string
    sourceFiles: string[]
}

/** The StartTransform payload VS sends for Bobs Bookstore (same shape as the existing E2E test). */
export function buildStartTransformRequest(inputs: StartTransformInputs) {
    const root = inputs.solutionRootPath
    const project = (name: string, type: string) => ({
        Name: name,
        ProjectPath: path.join(root, 'app', name, `${name}.csproj`),
        ProjectTargetFramework: 'net48',
        ProjectLanguage: 'csharp',
        ProjectType: type,
        SourceCodeFilePaths: inputs.sourceFiles,
        ExternalReferences: [],
    })
    return {
        command: 'aws/atxTransform/startTransform',
        WorkspaceId: inputs.workspaceId,
        JobName: inputs.jobName,
        useOrchestratorAgent: true,
        StartTransformRequest: {
            SolutionRootPath: root,
            SolutionFilePath: path.join(root, 'BobsBookstoreClassic.sln'),
            SelectedProjectPath: path.join(root, 'app', 'Bookstore.Web', 'Bookstore.Web.csproj'),
            ProgramLanguage: 'csharp',
            TargetFramework: 'net8.0',
            SolutionConfigPaths: [],
            ProjectMetadata: [
                project('Bookstore.Web', 'Web'),
                project('Bookstore.Common', 'Library'),
                project('Bookstore.Data', 'Library'),
                project('Bookstore.Domain', 'Library'),
            ],
            TransformNetStandardProjects: false,
            EnableRazorViewTransform: true,
            EnableWebFormsTransform: false,
        },
    }
}

/**
 * One LSP process, signed in and pointed at the IAD Transform profile, plus a direct FES client
 * for cleanup. Tracks every job the tests create so the orphan check can tell a leaked job
 * from an expected one.
 */
export class AtxTestSession {
    readonly client: LspClient
    profileArn = ''
    applicationUrl = ''
    private fesClient: any
    private readonly createdJobs = new Map<string, string>() // jobId -> workspaceId

    constructor(
        private readonly runtimeFile: string,
        private readonly token: string,
        private readonly startUrl: string
    ) {
        this.client = new LspClient(runtimeFile)
    }

    async start(): Promise<void> {
        await this.client.initialize()
        await sleep(2000)
        this.client.sendNotification('initialized', {})
        await sleep(1000)
        await this.updateToken(this.token)
        await sleep(5000)
        const profiles = await this.request('aws/getConfigurationFromServer', { section: 'aws.transformProfiles' })
        const iad = profiles?.find((p: any) => p.identityDetails?.region === REGION)
        if (!iad) throw new Error('No us-east-1 Transform profile found')
        this.profileArn = iad.arn
        this.applicationUrl = iad.applicationUrl
        await this.request('aws/updateConfiguration', {
            section: 'aws.atx',
            settings: { profileArn: iad.arn, applicationUrl: iad.applicationUrl },
        })
        await sleep(3000)
        this.fesClient = new fes.ElasticGumbyFrontendClient({
            region: REGION,
            endpoint: FES_ENDPOINT,
            credentials: { accessKeyId: 'unused', secretAccessKey: 'unused' },
        })
    }

    close(): void {
        this.client.close()
    }

    async updateToken(token: string): Promise<void> {
        await this.request('aws/credentials/token/update', {
            data: { token },
            credentialkey: 'atx-bearer',
            metadata: { sso: { startUrl: this.startUrl } },
        })
    }

    /** JSON-RPC request with a timeout, so a hung handler fails the test instead of the build. */
    async request(method: string, params: any, timeoutMs = 60000): Promise<any> {
        let timer: NodeJS.Timeout | undefined
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs)
        })
        try {
            return await Promise.race([this.client.sendRequest(method, params), timeout])
        } finally {
            if (timer) clearTimeout(timer)
        }
    }

    async command(params: any, timeoutMs = 60000): Promise<any> {
        return this.request('workspace/executeCommand', params, timeoutMs)
    }

    /**
     * Every startTransform goes through here. A job ID is recorded for cleanup; an error
     * response is returned as-is so the caller decides, but never leads to polling.
     */
    async startTransform(inputs: StartTransformInputs): Promise<any> {
        const result = await this.command(buildStartTransformRequest(inputs), 300000)
        if (result?.TransformationJobId) this.createdJobs.set(result.TransformationJobId, inputs.workspaceId)
        return result
    }

    trackJob(jobId: string, workspaceId: string): void {
        this.createdJobs.set(jobId, workspaceId)
    }

    async listJobIds(workspaceId: string): Promise<Map<string, string>> {
        const result = await this.command({ command: 'aws/atxTransform/listJobs', WorkspaceId: workspaceId })
        if (!result?.Jobs) throw new Error(`listJobs failed: ${JSON.stringify(result)}`)
        return new Map(result.Jobs.map((j: any) => [j.JobId, j.Status]))
    }

    async getStatus(workspaceId: string, jobId: string): Promise<any> {
        return this.command({
            command: 'aws/atxTransform/getTransformInfo',
            TransformationJobId: jobId,
            WorkspaceId: workspaceId,
            useOrchestratorAgent: true,
        })
    }

    /** Poll getTransformInfo until the status is in `want` or the deadline passes. */
    async pollUntil(workspaceId: string, jobId: string, want: string[], timeoutMs: number, intervalMs = 10000) {
        const deadline = Date.now() + timeoutMs
        let last: any
        while (Date.now() < deadline) {
            last = await this.getStatus(workspaceId, jobId)
            const status = last?.TransformationJob?.Status
            if (want.includes(status)) return last
            if (status === 'FAILED' && !want.includes('FAILED')) {
                throw new Error(`Job ${jobId} FAILED while waiting for ${want}: ${JSON.stringify(last)}`)
            }
            await sleep(intervalMs)
        }
        throw new Error(`Job ${jobId} did not reach ${want} within ${timeoutMs}ms; last=${JSON.stringify(last)}`)
    }

    // ---- direct FES calls (harness only) ----

    private async fesSend(command: any): Promise<any> {
        const token = this.token
        const origin = this.applicationUrl.replace(/\/+$/, '').replace(/^(https:\/\/[^/]+).*/, '$1')
        command.middlewareStack.add(
            (next: any) => async (args: any) => {
                args.request.headers['Authorization'] = `Bearer ${token}`
                args.request.headers['Origin'] = origin
                args.request.headers['Content-Type'] = 'application/json; charset=UTF-8'
                args.request.headers['Content-Encoding'] = 'amz-1.0'
                if (process.env.ATX_TEST_ID) args.request.headers['x-amzn-qt-test-id'] = process.env.ATX_TEST_ID
                return next(args)
            },
            { step: 'finalizeRequest', name: 'atxTestAuth', priority: 'low' }
        )
        try {
            this.fesClient.middlewareStack.remove('httpSigningMiddleware')
        } catch {
            // already removed
        }
        return this.fesClient.send(command)
    }

    async fesCreateWorkspace(name: string): Promise<string> {
        const r = await this.fesSend(new fes.CreateWorkspaceCommand({ name, description: 'ATX LSP integ test' }))
        return r.workspace.id
    }

    async fesDeleteWorkspace(id: string): Promise<void> {
        await this.fesSend(new fes.DeleteWorkspaceCommand({ id }))
    }

    async fesDeleteJob(workspaceId: string, jobId: string): Promise<void> {
        await this.fesSend(new fes.DeleteJobCommand({ workspaceId, jobId }))
    }

    /** Stop (if still running) and delete one job, waiting for a terminal status in between. */
    async stopAndDelete(workspaceId: string, jobId: string): Promise<void> {
        let status = (await this.listJobIds(workspaceId)).get(jobId)
        if (status === undefined) return // already gone
        if (!TERMINAL_STATUSES.includes(status)) {
            await this.command({ command: 'aws/atxTransform/stopJob', WorkspaceId: workspaceId, JobId: jobId })
            const deadline = Date.now() + 5 * 60000
            while (Date.now() < deadline && !TERMINAL_STATUSES.includes(status!)) {
                await sleep(10000)
                status = (await this.listJobIds(workspaceId)).get(jobId)
            }
        }
        await this.fesDeleteJob(workspaceId, jobId)
    }

    /**
     * Orphan check. Call `snapshot` before a test and `checkAndCleanup` after it: any job that
     * appeared in the workspace but was never returned to the test is an orphan. Everything the
     * test created (and every orphan) is stopped and deleted. Returns the orphan IDs.
     */
    async snapshot(workspaceId: string): Promise<Set<string>> {
        return new Set((await this.listJobIds(workspaceId)).keys())
    }

    async checkAndCleanup(workspaceId: string, before: Set<string>): Promise<string[]> {
        const after = await this.listJobIds(workspaceId)
        const orphans = [...after.keys()].filter(id => !before.has(id) && !this.createdJobs.has(id))
        const toClean = [...this.createdJobs.entries()]
        for (const id of orphans) toClean.push([id, workspaceId])
        for (const [jobId, wsId] of toClean) {
            try {
                await this.stopAndDelete(wsId, jobId)
            } catch (e) {
                console.error(`[cleanup] failed for ${jobId}: ${e}`)
            }
        }
        this.createdJobs.clear()
        return orphans
    }
}
