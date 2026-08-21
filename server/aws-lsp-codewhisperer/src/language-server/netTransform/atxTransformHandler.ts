import { Logging, Runtime, Workspace } from '@aws/language-server-runtimes/server-interface'
import * as fs from 'fs'
import * as archiver from 'archiver'
import got from 'got'
import * as path from 'path'
import * as crypto from 'crypto'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import AdmZip = require('adm-zip')
import { ArtifactManager } from './artifactManager'
import {
    ElasticGumbyFrontendClient,
    CreateJobCommand,
    CreateArtifactUploadUrlCommand,
    CompleteArtifactUploadCommand,
    CreateArtifactDownloadUrlCommand,
    GetHitlTaskCommand,
    ListHitlTasksCommand,
    SubmitCriticalHitlTaskCommand,
    SubmitStandardHitlTaskCommand,
    UpdateHitlTaskCommand,
    GetJobCommand,
    ListJobPlanStepsCommand,
    ListWorklogsCommand,
    ListArtifactsCommand,
    StartJobCommand,
    StopJobCommand,
    SendMessageCommand,
    ListMessagesCommand,
    BatchGetMessageCommand,
    CategoryType,
    FileType,
    JobInfo,
    SubmitCriticalHitlTaskResponse,
} from '@amazon/elastic-gumby-frontend-client'
import { AtxTokenServiceManager } from '../../shared/amazonQServiceManager/AtxTokenServiceManager'
import {
    DEFAULT_ATX_FES_REGION,
    ATX_FES_REGION_ENV_VAR,
    getAtxEndPointByRegion,
    getAtxOrchestratorAgent,
} from '../../shared/constants'
import {
    AtxListOrCreateWorkspaceRequest,
    AtxListOrCreateWorkspaceResponse,
    AtxListJobsResponse,
    AtxGetTransformInfoRequest,
    AtxGetTransformInfoResponse,
    AtxTransformationJob,
    AtxUploadPlanRequest,
    AtxUploadPlanResponse,
    AtxSetCheckpointsResponse,
    AtxTransformationPlan,
    AtxPlanStep,
    PlanStepStatus,
    createEmptyRootNode,
    AtxStepInformation,
    AtxUpdateWorkspaceResponse,
    AtxUploadPackagesRequest,
    AtxUploadPackagesResponse,
    InteractiveMode,
    AtxGetJobDashboardResponse,
    AtxDashboardRepo,
    AtxUploadCustomPlanRequest,
    AtxUploadCustomPlanResponse,
} from './atxModels'
import { v4 as uuidv4 } from 'uuid'
import { request } from 'http'

import { Utils, workspaceFolderName } from './utils'

/**
 * Context object for tracking diff apply failures within a single getTransformInfo call.
 */
interface DiffApplyContext {
    failed: boolean
    failedStepIds: string[]
}

/**
 * ATX Transform Handler - Business logic for ATX FES Transform operations
 * Parallel to RTS TransformHandler but uses AtxTokenServiceManager and ATX FES APIs
 */
export class ATXTransformHandler {
    private serviceManager: AtxTokenServiceManager
    private workspace: Workspace
    private logging: Logging
    private runtime: Runtime
    private atxClient: ElasticGumbyFrontendClient | null = null
    private cachedHitl: string | null = null
    private cachedStepHitl: string | null = null
    private cachedInteractiveMode: InteractiveMode | null = null
    private _applyingCheckpoints = false
    private _currentDiffContext: DiffApplyContext | null = null
    // sendMessage chat-poll cadence. Defaults give a 15-minute ceiling
    // (180 attempts x 5s). Held as fields rather than inline literals so a test can
    // drive the no-response path to completion instantly (interval 0, few attempts)
    // instead of racing the test runner's own wall-clock timeout.
    private _chatPollIntervalMs = 5000
    private _chatPollMaxAttempts = 180
    // Tracks jobs that have surfaced the LBV HITL, so we can distinguish the
    // pre-job mode-selection -checkpoint (filter) from the post-build -checkpoint
    // (surface for auto-approve).
    private jobsPastLocalBuild: Set<string> = new Set()

    constructor(serviceManager: AtxTokenServiceManager, workspace: Workspace, logging: Logging, runtime: Runtime) {
        this.serviceManager = serviceManager
        this.workspace = workspace
        this.logging = logging
        this.runtime = runtime

        this.serviceManager.registerCacheCallback(() => this.onProfileUpdate())
    }

    /**
     * Initialize ATX FES client
     */
    private async initializeAtxClient(): Promise<boolean> {
        try {
            this.logging.log('ATX: Starting client initialization')

            let region = process.env[ATX_FES_REGION_ENV_VAR]

            if (!region) {
                // Try to get region from active profile
                region = await this.getRegionFromProfile()
                if (!region) {
                    this.logging.error('ATX: No region available - cannot initialize client')
                    return false
                }
            }

            const endpoint = process.env.TCP_ENDPOINT || getAtxEndPointByRegion(region)
            this.logging.log(`ATX: Using region ${region} with endpoint ${endpoint}`)

            this.atxClient = new ElasticGumbyFrontendClient({
                region: region,
                endpoint: endpoint,
                requestHandler: new NodeHttpHandler({
                    requestTimeout: 30000,
                    connectionTimeout: 10000,
                }),
            })

            this.logging.log('ATX: Client initialization completed')
            return true
        } catch (error) {
            this.logging.error(`ATX: Failed to initialize client: ${String(error)}`)
            return false
        }
    }

    private async getRegionFromProfile(): Promise<string | undefined> {
        try {
            if (!this.serviceManager.hasValidCredentials()) {
                return undefined
            }

            // Get active profile applicationURL and extract region from it
            const atxServiceManager = AtxTokenServiceManager.getInstance()
            const applicationUrl = atxServiceManager.getActiveApplicationUrl()

            if (applicationUrl) {
                // Extract region from applicationURL: https://xxx.transform.REGION.on.aws
                const urlMatch = applicationUrl.match(/\.transform(?:-gamma)?\.([^.]+)\.on\.aws/)
                if (urlMatch && urlMatch[1]) {
                    return urlMatch[1]
                }
            }

            return DEFAULT_ATX_FES_REGION
        } catch (error) {
            this.logging.error(`ATX: Error getting region from profile: ${String(error)}`)
            return undefined
        }
    }

    /**
     * Add bearer token and Origin header to ATX FES commands
     */
    private async addAuthToCommand(command: any): Promise<void> {
        if (!this.serviceManager.isReady()) {
            throw new Error('Please select a valid Transform profile to continue')
        }

        const bearerToken = await this.serviceManager.getBearerToken()
        const applicationUrl = await this.getActiveTransformProfileApplicationUrl()

        command.middlewareStack?.add(
            (next: any) => async (args: any) => {
                if (!args.request.headers) {
                    args.request.headers = {}
                }
                args.request.headers['Authorization'] = `Bearer ${bearerToken}`

                // Add test classification header if running in test mode
                const testId = process.env.ATX_TEST_ID
                if (testId) {
                    args.request.headers['x-amzn-qt-test-id'] = testId
                }

                if (applicationUrl) {
                    const cleanOrigin = applicationUrl.endsWith('/') ? applicationUrl.slice(0, -1) : applicationUrl
                    args.request.headers['Origin'] = cleanOrigin
                }

                args.request.headers['Content-Type'] = 'application/json; charset=UTF-8'
                args.request.headers['Content-Encoding'] = 'amz-1.0'

                return next(args)
            },
            {
                step: 'build',
                name: 'addAtxAuthMiddleware',
                priority: 'high',
            }
        )
    }

    /**
     * Gets the applicationUrl for the active Transform profile with caching
     */
    async getActiveTransformProfileApplicationUrl(): Promise<string | null> {
        try {
            // Get applicationUrl from service manager (cached from configuration)
            const applicationUrl = this.serviceManager.getActiveApplicationUrl()

            if (!applicationUrl) {
                this.logging.error('ATX: No applicationUrl found - profile not selected')
                return null
            }

            return applicationUrl
        } catch (error) {
            this.logging.error(`ATX: Error getting applicationUrl: ${String(error)}`)
            return null
        }
    }

    /**
     * Reset atx client (for profile update scenarios)
     */
    onProfileUpdate(): void {
        this.atxClient = null
    }

    /**
     * Clear cached job state (for terminal job statuses)
     */
    private clearJobCache(jobId?: string): void {
        this.cachedHitl = null
        this.cachedStepHitl = null
        this.cachedInteractiveMode = null
        if (jobId) {
            this._worklogNextTokenByJob.delete(jobId)
            Utils.clearWorklogCacheForJob(jobId)
        }
        this.logging.log('ATX: Cleared job cache')
    }

    /**
     * Verify session (internal LSP method called before each ATX API)
     */
    private async verifySession(): Promise<boolean> {
        try {
            if (!(await this.initializeAtxClient())) {
                this.logging.error('ATX: Failed to initialize client for session verification')
                return false
            }

            // Verify authentication details
            await this.serviceManager.getBearerToken()
            await this.getActiveTransformProfileApplicationUrl()

            return true
        } catch (error) {
            this.logging.error(`ATX: Session verification error: ${String(error)}`)
            return false
        }
    }

    /**
     * List available workspaces
     */
    async listWorkspaces(): Promise<any> {
        try {
            this.logging.log('ATX: Starting ListWorkspaces operation')

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                throw new Error('ATX FES client not initialized')
            }

            const { ListWorkspacesCommand } = await import('@amazon/elastic-gumby-frontend-client')
            const command = new ListWorkspacesCommand({})
            await this.addAuthToCommand(command)

            const response = await this.atxClient!.send(command)
            this.logging.log(`ATX: ListWorkspaces completed - found ${response.items?.length || 0} workspaces`)
            this.logging.log(`ATX: ListWorkspaces RequestId: ${response.$metadata?.requestId}`)

            // Convert ATX API format to IDE expected format
            const workspaces = (response.items || []).map(workspace => ({
                Id: workspace.id,
                Name: workspace.name,
                Description: workspace.description,
                CreatedDate: new Date().toISOString(), // Use current date since createdDate not available
            }))

            const applicationUrl = this.serviceManager.getActiveApplicationUrl()
            this.logging.log(`ATX: ApplicationUrl: ${applicationUrl}`)

            return {
                workspaces,
                applicationUrl,
            }
        } catch (error) {
            this.logging.error(`ATX: ListWorkspaces error: ${String(error)}`)
            return { workspaces: [], applicationUrl: null }
        }
    }

    /**
     * Create a new workspace
     */
    async createWorkspace(
        workspaceName: string | null,
        workspaceDescription?: string
    ): Promise<{ workspaceId: string; workspaceName: string } | null> {
        try {
            this.logging.log(`ATX: Starting CreateWorkspace with name: ${workspaceName || 'auto-generated'}`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                throw new Error('ATX FES client not initialized')
            }

            const { CreateWorkspaceCommand } = await import('@amazon/elastic-gumby-frontend-client')
            const command = new CreateWorkspaceCommand({
                name: workspaceName || undefined,
                description:
                    workspaceDescription ||
                    (workspaceName ? `Workspace: ${workspaceName}` : 'Auto-generated workspace'),
            })
            await this.addAuthToCommand(command)

            const response = await this.atxClient!.send(command)
            this.logging.log(`ATX: CreateWorkspace RequestId: ${response.$metadata?.requestId}`)

            if (response.workspace?.id && response.workspace?.name) {
                const result = {
                    workspaceId: response.workspace.id,
                    workspaceName: response.workspace.name,
                }
                this.logging.log(`ATX: CreateWorkspace completed successfully: ${response.workspace.id}`)
                return result
            }

            this.logging.error('ATX: CreateWorkspace failed - no workspace in response')
            return null
        } catch (error) {
            this.logging.error(`ATX: CreateWorkspace error: ${String(error)}`)
            return null
        }
    }

    /**
     * List jobs in a workspace
     */
    async listJobs(workspaceId: string): Promise<AtxListJobsResponse | null> {
        try {
            this.logging.log(`ATX: ========== ListJobs called for workspace: ${workspaceId} ==========`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                throw new Error('ATX FES client not initialized')
            }

            const { ListJobsCommand } = await import('@amazon/elastic-gumby-frontend-client')
            const allJobs: any[] = []
            let nextToken: string | undefined

            // Paginate through all jobs
            do {
                const command = new ListJobsCommand({ workspaceId, nextToken })
                await this.addAuthToCommand(command)
                const response = await this.atxClient!.send(command)
                if (response.jobList) {
                    allJobs.push(...response.jobList)
                }
                nextToken = response.nextToken
            } while (nextToken)

            this.logging.log(`ATX: ListJobs completed - found ${allJobs.length} jobs`)

            const jobs = allJobs.map(entry => ({
                JobId: entry.jobInfo?.jobId || '',
                JobName: entry.jobInfo?.jobName,
                Status: entry.jobInfo?.statusDetails?.status || 'UNKNOWN',
                CreationTime: entry.jobInfo?.creationTime?.toISOString(),
                StartExecutionTime: entry.jobInfo?.startExecutionTime?.toISOString(),
                EndExecutionTime: entry.jobInfo?.endExecutionTime?.toISOString(),
                ClientSource: entry.jobInfo?.clientSource,
            }))

            return { Jobs: jobs }
        } catch (error) {
            this.logging.error(`ATX: ListJobs error: ${String(error)}`)
            return null
        }
    }

    /**
     * List workspaces and optionally create new workspace (CONSOLIDATED API)
     */
    async listOrCreateWorkspace(
        request: AtxListOrCreateWorkspaceRequest
    ): Promise<AtxListOrCreateWorkspaceResponse | null> {
        try {
            this.logging.log('ATX: Starting ListOrCreateWorkspace operation')
            this.logging.log(`ATX: Request received: ${JSON.stringify(request)}`)

            // Call verifySession ONCE at the beginning
            if (!(await this.verifySession())) {
                this.logging.error('ATX: Session verification failed for listOrCreateWorkspace')
                return null
            }

            // Always get list of existing workspaces
            const listResult = await this.listWorkspaces()

            const response: AtxListOrCreateWorkspaceResponse = {
                AvailableWorkspaces: listResult.workspaces || [],
                CreatedWorkspace: undefined,
            }

            // Optionally create new workspace
            this.logging.log(`ATX: CreateWorkspaceName = ${request.CreateWorkspaceName}`)
            if (request.CreateWorkspaceName !== undefined) {
                const newWorkspace = await this.createWorkspace(
                    request.CreateWorkspaceName,
                    request.CreateWorkspaceDescription
                )

                if (newWorkspace) {
                    response.CreatedWorkspace = {
                        WorkspaceId: newWorkspace.workspaceId,
                        WorkspaceName: newWorkspace.workspaceName,
                    }

                    // Add the new workspace to the available list
                    response.AvailableWorkspaces.push({
                        Id: newWorkspace.workspaceId,
                        Name: newWorkspace.workspaceName,
                        Description: request.CreateWorkspaceDescription,
                        CreatedDate: new Date().toISOString(),
                    })
                }
            }

            this.logging.log(
                `ATX: ListOrCreateWorkspace completed - ${response.AvailableWorkspaces.length} workspaces available`
            )
            return response
        } catch (error) {
            this.logging.error(`ATX: ListOrCreateWorkspace error: ${String(error)}`)
            return null
        }
    }

    /**
     * Create ATX transformation job
     */
    async createJob(request: {
        workspaceId: string
        jobName?: string
        targetFramework?: string
        interactiveMode?: InteractiveMode
        generateUnitTests?: boolean
    }): Promise<{ jobId: string; status: string } | null> {
        try {
            this.logging.log(`ATX: Starting CreateJob for workspace: ${request.workspaceId}`)

            // Call ATX FES createJob API
            if (!this.atxClient && !(await this.initializeAtxClient())) {
                throw new Error('ATX FES client not initialized')
            }

            // Map InteractiveMode enum to backend format (all strings)
            // Autonomous -> "auto", Interactive -> "interactive"
            let interactiveModeValue: string = 'auto'
            if (request.interactiveMode === 'Interactive') {
                interactiveModeValue = 'interactive'
            }

            // Build objective object with target_framework and interactive_mode
            const objective: any = {
                target_framework: request.targetFramework || 'net10.0',
                interactive_mode: interactiveModeValue,
            }

            // The customer's up-front unit-test choice. Only a real boolean counts as a choice:
            // clients that cannot express one omit the field, and the backend keeps legacy behavior.
            // Do NOT default this to false here - an explicit false is a decline, not "no choice".
            if (typeof request.generateUnitTests === 'boolean') {
                objective.generate_unit_tests = request.generateUnitTests
            }

            const orchestratorAgent = getAtxOrchestratorAgent()
            if (process.env.ATX_ORCHESTRATOR_AGENT) {
                this.logging.log(
                    `ATX: CreateJob using override orchestratorAgent='${orchestratorAgent}' (from ATX_ORCHESTRATOR_AGENT env var)`
                )
            }
            this.logging.log(`ATX: CreateJob objective: ${JSON.stringify(objective)}`)

            const command = new CreateJobCommand({
                workspaceId: request.workspaceId,
                objective: JSON.stringify(objective),
                // jobType: 'DOTNET_IDE' as any,
                orchestratorAgent: orchestratorAgent,
                jobName: request.jobName || `transform-job-${Date.now()}`,
                intent: 'LANGUAGE_UPGRADE',
                idempotencyToken: uuidv4(),
            })

            await this.addAuthToCommand(command)
            const response = (await this.atxClient!.send(command)) as any
            this.logging.log(`ATX: CreateJob completed - jobId: ${response.jobId}, status: ${response.status}`)
            this.logging.log(`ATX: CreateJob RequestId: ${response.$metadata?.requestId}`)

            if (response.jobId && response.status) {
                return { jobId: response.jobId, status: response.status }
            }

            this.logging.error('ATX: CreateJob failed - no jobId or status in response')
            return null
        } catch (error) {
            this.logging.error(`ATX: CreateJob error: ${String(error)}`)
            return null
        }
    }

    /**
     * Create artifact upload URL
     */
    async createArtifactUploadUrl(
        workspaceId: string,
        jobId: string,
        filePath: string,
        categoryType: CategoryType,
        fileType: FileType
    ): Promise<{ uploadId: string; uploadUrl: string; requestHeaders?: any } | null> {
        try {
            this.logging.log(`ATX: Starting CreateArtifactUploadUrl for job: ${jobId}`)

            // Initialize ATX client
            if (!this.atxClient && !(await this.initializeAtxClient())) {
                throw new Error('ATX FES client not initialized')
            }

            // Calculate file checksum - exact reference repo implementation
            const sha256 = await Utils.getSha256Async(filePath)

            const command = new CreateArtifactUploadUrlCommand({
                workspaceId: workspaceId,
                jobId: jobId,
                contentDigest: { Sha256: sha256 },
                artifactReference: {
                    artifactType: {
                        categoryType: categoryType,
                        fileType: fileType,
                    },
                },
            })

            await this.addAuthToCommand(command)
            const result = (await this.atxClient!.send(command)) as any
            this.logging.log(`ATX: CreateArtifactUploadUrl RequestId: ${result.$metadata?.requestId}`)

            if (result && result.artifactId && result.s3PreSignedUrl) {
                this.logging.log(`ATX: CreateArtifactUploadUrl completed successfully`)
                return {
                    uploadId: result.artifactId,
                    uploadUrl: result.s3PreSignedUrl,
                    requestHeaders: result.requestHeaders,
                }
            } else {
                this.logging.error('ATX: CreateArtifactUploadUrl failed - missing artifactId or s3PreSignedUrl')
                return null
            }
        } catch (error) {
            this.logging.error(`ATX: CreateArtifactUploadUrl error: ${String(error)}`)
            return null
        }
    }

    /**
     * Complete artifact upload
     */
    async completeArtifactUpload(
        workspaceId: string,
        jobId: string,
        artifactId: string
    ): Promise<{ success: boolean } | null> {
        try {
            this.logging.log(`ATX: Starting CompleteArtifactUpload for artifact: ${artifactId}`)

            // Initialize ATX client
            if (!this.atxClient && !(await this.initializeAtxClient())) {
                throw new Error('ATX FES client not initialized')
            }
            const command = new CompleteArtifactUploadCommand({
                workspaceId: workspaceId,
                jobId: jobId,
                artifactId: artifactId,
            })

            await this.addAuthToCommand(command)
            const result = (await this.atxClient!.send(command)) as any

            this.logging.log(`ATX: CompleteArtifactUpload completed successfully`)
            return { success: true }
        } catch (error) {
            this.logging.error(`ATX: CompleteArtifactUpload error: ${String(error)}`)
            return null
        }
    }

    /**
     * Start transformation job
     */
    async startJob(workspaceId: string, jobId: string): Promise<{ success: boolean } | null> {
        try {
            this.logging.log(`ATX: Starting job: ${jobId}`)

            // Initialize ATX client
            if (!this.atxClient && !(await this.initializeAtxClient())) {
                throw new Error('ATX FES client not initialized')
            }

            const command = new StartJobCommand({
                workspaceId: workspaceId,
                jobId: jobId,
            })

            await this.addAuthToCommand(command)
            const result = (await this.atxClient!.send(command)) as any
            this.logging.log(`ATX: StartJob RequestId: ${result.$metadata?.requestId}`)

            this.logging.log(`ATX: Job started successfully`)
            return { success: true }
        } catch (error) {
            this.logging.error(`ATX: StartJob error: ${String(error)}`)
            return null
        }
    }

    /**
     * Create ZIP file from solution using ArtifactManager
     */
    async createZip(request: any): Promise<string> {
        try {
            this.logging.log('ATX: Starting ZIP file creation from solution')

            const workspacePath = Utils.getWorkspacePath(request.SolutionRootPath)

            const artifactManager = new ArtifactManager(
                this.workspace,
                this.logging,
                workspacePath,
                request.SolutionRootPath
            )

            const zipFilePath = await artifactManager.createZip(request)
            this.logging.log(`ATX: ZIP file created successfully: ${zipFilePath}`)
            return zipFilePath
        } catch (error) {
            this.logging.error(`ATX: createZip error: ${String(error)}`)
            throw error
        }
    }

    /**
     * Start ATX Transform - Orchestrates the full workflow
     * Step 1: CreateJob ✅
     * Step 2: ZIP Creation and Upload
     */
    async startTransform(request: {
        workspaceId: string
        jobName?: string
        interactiveMode?: InteractiveMode
        startTransformRequest: object
        includeMissingPackageAnalysis?: boolean
    }): Promise<{ TransformationJobId: string; ArtifactPath: string; UploadId: string } | null> {
        try {
            this.logging.log(`ATX: Starting transform workflow for workspace: ${request.workspaceId}`)

            // Cache the interactive mode setting
            this.cachedInteractiveMode = request.interactiveMode || 'Autonomous'

            // Step 1: Create transformation job
            const createJobResponse = await this.createJob({
                workspaceId: request.workspaceId,
                jobName: request.jobName || 'Transform Job',
                targetFramework: (request.startTransformRequest as any).TargetFramework,
                interactiveMode: request.interactiveMode,
                generateUnitTests: (request.startTransformRequest as any).GenerateUnitTests,
            })

            if (!createJobResponse?.jobId) {
                throw new Error('Failed to create ATX transformation job')
            }

            // Step 2: Create ZIP file
            const zipFilePath = await this.createZip(request.startTransformRequest)

            if (!zipFilePath) {
                throw new Error('Failed to create ZIP file for ATX transformation')
            }

            // Step 3: Create artifact upload URL
            const uploadResponse = await this.createArtifactUploadUrl(
                request.workspaceId,
                createJobResponse.jobId,
                zipFilePath,
                CategoryType.CUSTOMER_INPUT,
                FileType.ZIP
            )

            if (!uploadResponse?.uploadUrl) {
                throw new Error('Failed to create artifact upload URL')
            }

            // Step 4: Upload ZIP file to S3
            const uploadSuccess = await Utils.uploadArtifact(
                uploadResponse.uploadUrl,
                zipFilePath,
                uploadResponse.requestHeaders,
                this.logging
            )

            if (!uploadSuccess) {
                throw new Error('Failed to upload ZIP file to S3')
            }

            // Step 5: Complete artifact upload
            const completeResponse = await this.completeArtifactUpload(
                request.workspaceId,
                createJobResponse.jobId,
                uploadResponse.uploadId
            )

            if (!completeResponse?.success) {
                throw new Error('Failed to complete artifact upload')
            }

            // Step 6: Start the transformation job
            const startJobResponse = await this.startJob(request.workspaceId, createJobResponse.jobId)

            if (!startJobResponse?.success) {
                throw new Error('Failed to start ATX transformation job')
            }

            // Step 7: Write source files list to checkpoints folder for tracking (only in interactive mode)
            if (request.interactiveMode && request.interactiveMode !== 'Autonomous') {
                const startTransformReq = request.startTransformRequest as any
                this.writeSourceFilesManifest(
                    startTransformReq.SolutionRootPath,
                    createJobResponse.jobId,
                    startTransformReq
                )
            }

            this.logging.log('ATX: Transform workflow completed successfully')

            return {
                TransformationJobId: createJobResponse.jobId,
                ArtifactPath: zipFilePath,
                UploadId: uploadResponse.uploadId,
            }
        } catch (error) {
            this.logging.error(`ATX: StartTransform workflow error: ${String(error)}`)
            return null
        }
    }

    async getJob(workspaceId: string, jobId: string, includeObjective: boolean = false): Promise<JobInfo | null> {
        try {
            this.logging.log(`ATX: Getting job: ${jobId} in workspace: ${workspaceId}`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                this.logging.error('ATX: GetJob client not initialized')
                return null
            }

            const command = new GetJobCommand({
                workspaceId: workspaceId,
                jobId: jobId,
                includeObjective: includeObjective,
            })

            await this.addAuthToCommand(command)
            const response = await this.atxClient!.send(command)

            this.logging.log(`ATX: GetJob completed - Job status: ${response.job?.statusDetails?.status}`)
            return response.job || null
        } catch (error) {
            this.logging.error(`ATX: GetJob error: ${String(error)}`)
            return null
        }
    }

    async createArtifactDownloadUrl(
        workspaceId: string,
        jobId: string,
        artifactId: string
    ): Promise<{ s3PresignedUrl: string; requestHeaders?: any } | null> {
        try {
            this.logging.log(`ATX: Starting CreateArtifactDownloadUrl for job: ${jobId}`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                throw new Error('ATX client not initialized')
            }

            const command = new CreateArtifactDownloadUrlCommand({
                workspaceId: workspaceId,
                jobId: jobId,
                artifactId: artifactId,
            })

            await this.addAuthToCommand(command)
            const result = (await this.atxClient!.send(command)) as any
            if (result && result.s3PreSignedUrl) {
                this.logging.log(`ATX: CreateArtifactDownloadUrl completed successfully`)

                const normalizedHeaders: Record<string, string> = {}
                if (result.requestHeaders) {
                    for (const [key, value] of Object.entries(result.requestHeaders)) {
                        normalizedHeaders[key] = Array.isArray(value) ? value[0] : value
                    }
                }

                return {
                    s3PresignedUrl: result.s3PreSignedUrl,
                    requestHeaders: normalizedHeaders,
                }
            } else {
                this.logging.error('ATX: CreateArtifactDownloadUrl failed - missing s3PreSignedUrl')
                return null
            }
        } catch (error) {
            this.logging.error(`ATX: CreateArtifactDownloadUrl error: ${String(error)}`)
            return null
        }
    }

    async listHitls(workspaceId: string, jobId: string): Promise<any[] | null> {
        try {
            this.logging.log(`ATX: Starting ListHitls for job: ${jobId}`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                this.logging.error('ATX: Failed to initialize client for ListHitls')
                return null
            }

            const command = new ListHitlTasksCommand({
                workspaceId: workspaceId,
                jobId: jobId,
                taskType: 'NORMAL',
                taskFilter: {
                    taskStatuses: ['AWAITING_HUMAN_INPUT'],
                },
            })

            await this.addAuthToCommand(command)
            const result = await this.atxClient!.send(command)

            this.logging.log(`ATX: ListHitls completed - Found ${result.hitlTasks?.length || 0} tasks`)
            return result.hitlTasks || []
        } catch (error) {
            this.logging.error(`ATX: ListHitls error: ${String(error)}`)
            return null
        }
    }

    async submitHitl(
        workspaceId: string,
        jobId: string,
        taskId: string,
        humanArtifactId: string
    ): Promise<SubmitCriticalHitlTaskResponse | null> {
        try {
            this.logging.log(`ATX: Starting SubmitHitl for task: ${taskId}`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                this.logging.error('ATX: Failed to initialize client for SubmitHitl')
                return null
            }

            const command = new SubmitCriticalHitlTaskCommand({
                workspaceId: workspaceId,
                jobId: jobId,
                taskId: taskId,
                action: 'APPROVE',
                humanArtifact: {
                    artifactId: humanArtifactId,
                },
            })

            await this.addAuthToCommand(command)
            const result = await this.atxClient!.send(command)

            this.logging.log(`ATX: SubmitHitl completed - task status: ${result.status || 'UNKNOWN'}`)
            return result
        } catch (error) {
            this.logging.error(`ATX: SubmitHitl error: ${String(error)}`)
            return null
        }
    }

    async updateHitl(workspaceId: string, jobId: string, taskId: string, humanArtifactId: string): Promise<any | null> {
        try {
            this.logging.log(`ATX: Starting UpdateHitl for task: ${taskId}`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                this.logging.error('ATX: Failed to initialize client for UpdateHitl')
                return null
            }

            const command = new UpdateHitlTaskCommand({
                workspaceId: workspaceId,
                jobId: jobId,
                taskId: taskId,
                humanArtifact: {
                    artifactId: humanArtifactId,
                },
            })

            await this.addAuthToCommand(command)
            const result = await this.atxClient!.send(command)

            this.logging.log(`ATX: UpdateHitl completed successfully with status ${result.status}`)
            return result
        } catch (error) {
            this.logging.error(`ATX: UpdateHitl error: ${String(error)}`)
            return null
        }
    }

    async completeHitlWithBuildResults(
        workspaceId: string,
        jobId: string,
        taskId: string,
        buildOutput: string,
        solutionRootPath: string
    ): Promise<{ Success: boolean; Error?: string }> {
        try {
            this.logging.log(`ATX: Completing HITL ${taskId} with build results`)

            // Write build output to temp file
            const tempDir = path.join(solutionRootPath, 'artifactWorkspace', jobId)
            await Utils.directoryExists(tempDir)
            const buildResultsPath = path.join(tempDir, 'build-results.txt')
            fs.writeFileSync(buildResultsPath, buildOutput)

            // Upload as artifact. The artifact must be categorized as HITL_FROM_USER
            // so the platform associates it with the HITL task; the subsequent submit
            // call will fail with ResourceNotFoundException if any other category is
            // used. The existing upload flows (plan, packages, generic completion)
            // all follow this pattern.
            const uploadResponse = await this.createArtifactUploadUrl(
                workspaceId,
                jobId,
                buildResultsPath,
                CategoryType.HITL_FROM_USER,
                FileType.OTHER
            )

            if (!uploadResponse?.uploadUrl) {
                return { Success: false, Error: 'Failed to create artifact upload URL' }
            }

            const uploadSuccess = await Utils.uploadArtifact(
                uploadResponse.uploadUrl,
                buildResultsPath,
                uploadResponse.requestHeaders,
                this.logging
            )

            if (!uploadSuccess) {
                return { Success: false, Error: 'Failed to upload build results' }
            }

            const completeResponse = await this.completeArtifactUpload(workspaceId, jobId, uploadResponse.uploadId)

            if (!completeResponse?.success) {
                return { Success: false, Error: 'Failed to complete artifact upload' }
            }

            // Submit the HITL with the uploaded artifact via SubmitCriticalHitlTaskCommand.
            // The backend creates the local-build-verification HITL with severity=CRITICAL
            // (matching the missing-packages HITL flow), so the Critical submit path
            // routes correctly and transitions the task directly to SUBMITTED — no
            // intermediate updateHitl call is required.
            const submitResult = await this.submitHitl(workspaceId, jobId, taskId, uploadResponse.uploadId)

            if (!submitResult) {
                return { Success: false, Error: 'Failed to submit HITL task' }
            }

            this.logging.log('ATX: HITL completed with build results successfully')
            return { Success: true }
        } catch (error) {
            this.logging.error(`ATX: completeHitlWithBuildResults error: ${String(error)}`)
            return { Success: false, Error: String(error) }
        }
    }

    async getHitl(workspaceId: string, jobId: string, taskId: string): Promise<any | null> {
        try {
            this.logging.log(`ATX: Getting Hitl task: ${taskId}`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                this.logging.error('ATX: Failed to initialize client for GetHitl')
                return null
            }

            const command = new GetHitlTaskCommand({
                workspaceId: workspaceId,
                jobId: jobId,
                taskId: taskId,
            })

            await this.addAuthToCommand(command)
            const result = await this.atxClient!.send(command)

            this.logging.log(`ATX: GetHitl completed successfully`)
            return result.task || null
        } catch (error) {
            this.logging.error(`ATX: GetHitl error: ${String(error)}`)
            return null
        }
    }

    async pollHitlTask(workspaceId: string, jobId: string, taskId: string): Promise<string | null> {
        this.logging.log('ATX: Starting polling for hitl after upload')

        try {
            var count = 0
            while (count < 100) {
                const jobStatus = await this.getHitl(workspaceId, jobId, taskId)
                this.logging.log(`ATX: Hitl polling status: ${jobStatus?.status}`)

                if (jobStatus && jobStatus.status == 'CLOSED') {
                    return 'Validation Success!'
                } else if (jobStatus && jobStatus.status == 'CLOSED_PENDING_NEXT_TASK') {
                    return 'Submitted plan did not pass validation, please check the plan for details....'
                } else if (jobStatus && jobStatus.status == 'CANCELLED') {
                    return 'Timeout occured during planning, proceeding with default plan....'
                } else {
                    await Utils.sleep(10 * 1000)
                    count++
                }
            }

            this.logging.log('ATX: Hitl polling timeout after 100 attempts')
            return null
        } catch (error) {
            this.logging.error(`ATX: Hitl polling error: ${String(error)}`)
            return null
        }
    }

    async getHitlAgentArtifact(
        workspaceId: string,
        jobId: string,
        solutionRootPath: string
    ): Promise<{
        PlanPath?: string
        ReportPath?: string
        MissingPackageJsonPath?: string
        HitlTag?: string
        TaskId?: string
    } | null> {
        let hitl: any = null
        try {
            this.logging.log(`ATX: Getting Hitl Agent Artifact for job: ${jobId}`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                this.logging.error('ATX: Failed to initialize client for GetHitlAgentArtifact')
                return null
            }

            const hitls = await this.listHitls(workspaceId, jobId)

            if (!hitls || hitls.length === 0) {
                this.logging.log(`ATX: No hitls available`)
                return null
            }

            if (hitls.length != 1) {
                this.logging.log(`ATX: Found ${hitls.length} hitls (expected 1)`)
            }

            hitl =
                hitls.find(h => h.tag === 'local-build-verification') ||
                hitls.find(h => h.tag === 'missing-packages' || h.tag === 'handle_missing_packages_hitl') ||
                hitls[0]
            this.logging.log(
                `ATX: getHitlAgentArtifact picked hitl tag: ${hitl.tag}, all tags: ${hitls.map(h => h.tag).join(',')}`
            )
            this.logging.log(
                `ATX: getHitlAgentArtifact - selected tag: ${hitl.tag}, artifactId: ${hitl.agentArtifact?.artifactId}, allTags: ${hitls.map((h: any) => h.tag)}`
            )
            this.cachedHitl = hitl.taskId
            const hitlTag = hitl.tag || null

            // local-build-verification: IDE handles the build, no artifact download needed
            if (hitlTag === 'local-build-verification') {
                this.logging.log('ATX: local-build-verification HITL — returning tag for IDE to handle')
                return { HitlTag: hitlTag, TaskId: hitl.taskId }
            }

            // If no agent artifact, return tag and taskId without downloading
            if (!hitl.agentArtifact?.artifactId) {
                this.logging.log(`ATX: HITL has no agent artifact (tag=${hitlTag}) — returning tag only`)
                return { HitlTag: hitlTag, TaskId: hitl.taskId }
            }
            const downloadInfo = await this.createArtifactDownloadUrl(workspaceId, jobId, hitl.agentArtifact.artifactId)

            if (!downloadInfo) {
                throw new Error('Failed to get ATX FES download URL')
            }

            const pathToDownload = path.join(solutionRootPath, workspaceFolderName, jobId)
            const fs = require('fs')
            await Utils.directoryExists(pathToDownload)

            // Missing-packages artifact is raw JSON, not a zip
            if (hitlTag === 'missing-packages' || hitlTag === 'handle_missing_packages_hitl') {
                const response = await got.get(downloadInfo.s3PresignedUrl, {
                    headers: downloadInfo.requestHeaders || {},
                    responseType: 'buffer',
                    timeout: { request: 30000 },
                })
                const rawPath = path.join(pathToDownload, 'missing-packages.json')
                fs.writeFileSync(rawPath, response.body)
                this.logging.log(
                    `ATX: Missing packages artifact saved as JSON: ${rawPath} (${response.body.length} bytes)`
                )
            } else {
                try {
                    await Utils.downloadAndExtractArchive(
                        downloadInfo.s3PresignedUrl,
                        downloadInfo.requestHeaders,
                        pathToDownload,
                        'transformation-plan-download.zip',
                        this.logging
                    )
                } catch (extractError) {
                    this.logging.error(`ATX: Zip extraction failed (${String(extractError)}), saving raw artifact`)
                    try {
                        const response = await got.get(downloadInfo.s3PresignedUrl, {
                            headers: downloadInfo.requestHeaders || {},
                            responseType: 'buffer',
                            timeout: { request: 30000 },
                        })
                        const rawPath = path.join(pathToDownload, `hitl-artifact-${hitlTag || 'unknown'}`)
                        fs.writeFileSync(rawPath, response.body)
                        this.logging.log(`ATX: Raw artifact saved to ${rawPath} (${response.body.length} bytes)`)
                    } catch (downloadError) {
                        this.logging.error(`ATX: Raw artifact save also failed: ${String(downloadError)}`)
                    }
                }
            }

            const extractedFiles = fs.readdirSync(pathToDownload)
            this.logging.log(`ATX: Files in ${pathToDownload}: ${JSON.stringify(extractedFiles)}`)

            const planPath = path.join(pathToDownload, 'transformation-plan.md')
            const reportPath = path.join(pathToDownload, 'assessment-report.md')
            const missingPackageJsonPath = path.join(pathToDownload, 'missing-packages.json')

            this.logging.log(`ATX: GetHitlAgentArtifact completed successfully`)
            return {
                PlanPath: fs.existsSync(planPath) ? planPath : undefined,
                ReportPath: fs.existsSync(reportPath) ? reportPath : undefined,
                MissingPackageJsonPath: fs.existsSync(missingPackageJsonPath) ? missingPackageJsonPath : undefined,
                HitlTag: hitlTag,
                TaskId: hitl.taskId,
            }
        } catch (error) {
            this.logging.error(`ATX: GetHitlAgentArtifact error: ${String(error)}`)
            // Guardrail: return tag/taskId even on download failure so IDE can still handle the HITL
            if (hitl) {
                return { HitlTag: hitl.tag || null, TaskId: hitl.taskId }
            }
            return null
        }
    }

    /**
     * Get transform info
     */
    async getTransformInfo(request: AtxGetTransformInfoRequest): Promise<AtxGetTransformInfoResponse | null> {
        const diffContext: DiffApplyContext = { failed: false, failedStepIds: [] }
        this._currentDiffContext = diffContext
        try {
            const result = await this._getTransformInfoInternal(request, diffContext)
            if (result && diffContext.failed) {
                result.DiffApplyFailed = true
                result.DiffApplyFailedStepIds = diffContext.failedStepIds
            }
            return result
        } finally {
            this._currentDiffContext = null
        }
    }

    private async _getTransformInfoInternal(
        request: AtxGetTransformInfoRequest,
        _diffContext: DiffApplyContext
    ): Promise<AtxGetTransformInfoResponse | null> {
        try {
            this.logging.log(`ATX: Getting transform info for job: ${request.TransformationJobId}`)

            // Check if we need to determine interactive mode from the job objective
            const needObjective = this.cachedInteractiveMode === null
            const job = await this.getJob(request.WorkspaceId, request.TransformationJobId, needObjective)

            if (!job) {
                this.logging.error(`ATX: Job not found: ${request.TransformationJobId}`)
                return {
                    TransformationJob: null,
                    ErrorString: 'JOB_NOT_FOUND',
                } as unknown as AtxGetTransformInfoResponse
            }

            // If interactive mode is not cached, try to get it from the job objective
            if (this.cachedInteractiveMode === null && job.objective) {
                try {
                    const objective = JSON.parse(job.objective)
                    // Map backend string format to InteractiveMode enum
                    // "interactive" -> Interactive, "auto" -> Autonomous
                    if (objective.interactive_mode === 'interactive') {
                        this.cachedInteractiveMode = 'Interactive'
                    } else {
                        this.cachedInteractiveMode = 'Autonomous'
                    }
                    this.logging.log(
                        `ATX: Determined interactive mode from job objective: ${this.cachedInteractiveMode}`
                    )
                } catch (e) {
                    this.logging.log('ATX: Could not parse job objective for interactive mode')
                    this.cachedInteractiveMode = 'Autonomous'
                }
            }

            const jobStatus = job.statusDetails?.status

            if (jobStatus === 'COMPLETED') {
                // Clear cached state for terminal job status
                this.clearJobCache(request.TransformationJobId)

                const pathToArtifact = await this.downloadFinalArtifact(
                    request.WorkspaceId,
                    request.TransformationJobId,
                    request.SolutionRootPath
                )
                const plan = await this.getTransformationPlan(
                    request.WorkspaceId,
                    request.TransformationJobId,
                    request.SolutionRootPath
                )

                return {
                    TransformationJob: {
                        WorkspaceId: request.WorkspaceId,
                        JobId: request.TransformationJobId,
                        Status: jobStatus,
                    } as AtxTransformationJob,
                    ArtifactPath: pathToArtifact,
                    TransformationPlan: plan,
                } as AtxGetTransformInfoResponse
            } else if (jobStatus === 'FAILED') {
                // Clear cached state for terminal job status
                this.clearJobCache(request.TransformationJobId)

                this.logging.error(`ATX: Job failed - Reason: ${job?.statusDetails?.failureReason ?? 'Unknown'}`)
                return {
                    TransformationJob: {
                        WorkspaceId: request.WorkspaceId,
                        JobId: request.TransformationJobId,
                        Status: jobStatus,
                        FailureReason: job?.statusDetails?.failureReason,
                    } as AtxTransformationJob,
                    ErrorString: 'Transformation job failed',
                } as AtxGetTransformInfoResponse
            } else if (jobStatus === 'STOPPING' || jobStatus === 'STOPPED') {
                // Clear cached state for terminal job status
                this.clearJobCache(request.TransformationJobId)

                return {
                    TransformationJob: {
                        WorkspaceId: request.WorkspaceId,
                        JobId: request.TransformationJobId,
                        Status: jobStatus,
                    } as AtxTransformationJob,
                    ErrorString: 'Transformation job stopped',
                } as AtxGetTransformInfoResponse
            } else if (jobStatus === 'EXECUTING') {
                const plan = await this.getTransformationPlan(
                    request.WorkspaceId,
                    request.TransformationJobId,
                    request.SolutionRootPath
                )

                // If GetCheckpoints is requested, populate HasCheckpoint field on steps
                if (request.GetCheckpoints) {
                    this.populateCheckpointsOnPlan(plan, request.TransformationJobId, request.SolutionRootPath)
                }

                // HITLs can be raised at task level while the job-level status remains
                // EXECUTING (the local-build-verification flow being the primary case).
                // Probe listHitls here so the IDE is notified of pending human input
                // without waiting for the job-level status to transition.
                const execHitls = await this.listHitls(request.WorkspaceId, request.TransformationJobId)
                const hitlTagSummary =
                    execHitls && execHitls.length > 0 ? execHitls.map(h => String(h.tag)).join(', ') : '<none>'
                this.logging.log(
                    `ATX: EXECUTING HITL probe for job ${request.TransformationJobId}: ${execHitls ? execHitls.length : 0} task(s) [${hitlTagSummary}]`
                )

                // Mark the job past-LBV the first time we see the LBV HITL, so subsequent
                // -checkpoint HITLs on this job get surfaced instead of filtered.
                const sawLbv = execHitls ? execHitls.some(h => String(h.tag) === 'local-build-verification') : false
                if (sawLbv && !this.jobsPastLocalBuild.has(request.TransformationJobId)) {
                    this.jobsPastLocalBuild.add(request.TransformationJobId)
                    this.logging.log(`ATX: marking job ${request.TransformationJobId} as past-LBV`)
                }
                const isPastLbv = this.jobsPastLocalBuild.has(request.TransformationJobId)

                // Pre-LBV: filter -checkpoint (it's the always-present mode-selection HITL).
                // Post-LBV: surface it so the IDE can auto-approve.
                const blockingHitls = execHitls
                    ? execHitls.filter(h => isPastLbv || !String(h.tag).endsWith('-checkpoint'))
                    : []

                if (blockingHitls.length > 0) {
                    const execHitl =
                        blockingHitls.find(h => h.tag === 'local-build-verification') ||
                        blockingHitls.find(
                            h => h.tag === 'missing-packages' || h.tag === 'handle_missing_packages_hitl'
                        ) ||
                        blockingHitls.find(h => String(h.tag).endsWith('-checkpoint')) ||
                        blockingHitls[0]
                    this.logging.log(
                        `ATX: EXECUTING job has pending HITL — tag=${execHitl.tag} taskId=${execHitl.taskId}; surfacing AWAITING_HUMAN_INPUT to IDE`
                    )
                    return {
                        TransformationJob: {
                            WorkspaceId: request.WorkspaceId,
                            JobId: request.TransformationJobId,
                            Status: 'AWAITING_HUMAN_INPUT',
                        } as AtxTransformationJob,
                        HitlTag: execHitl.tag,
                        HitlTaskId: execHitl.taskId,
                        TransformationPlan: plan,
                    } as AtxGetTransformInfoResponse
                }

                return {
                    TransformationJob: {
                        WorkspaceId: request.WorkspaceId,
                        JobId: request.TransformationJobId,
                        Status: jobStatus,
                    } as AtxTransformationJob,
                    TransformationPlan: plan,
                } as AtxGetTransformInfoResponse
            } else if (jobStatus === 'AWAITING_HUMAN_INPUT') {
                return await this.handleAwaitingHumanInput(request)
            } else {
                this.logging.log(`ATX: Job status is ${jobStatus} - checking for pending HITL tasks`)
                await this.listWorklogs(request.WorkspaceId, request.TransformationJobId, request.SolutionRootPath)

                // Try to get plan regardless of status
                let plan: any = undefined
                try {
                    plan = await this.getTransformationPlan(
                        request.WorkspaceId,
                        request.TransformationJobId,
                        request.SolutionRootPath
                    )
                } catch (e) {
                    // Plan not available yet
                }

                // Check for pending HITL tasks (e.g. missing packages) - job stays in PLANNING while HITL is pending
                const hitls = await this.listHitls(request.WorkspaceId, request.TransformationJobId)
                if (hitls && hitls.length > 0) {
                    const hitl =
                        hitls.find(h => h.tag === 'local-build-verification') ||
                        hitls.find(h => h.tag === 'missing-packages' || h.tag === 'handle_missing_packages_hitl') ||
                        hitls[0]
                    this.logging.log(`ATX: Found HITL task - tag: ${hitl.tag}, hasArtifact: ${!!hitl.agentArtifact}`)
                    // For missing packages HITL, try to download artifact if available
                    if (hitl.tag === 'handle_missing_packages_hitl' || hitl.tag === 'missing-packages') {
                        this.cachedHitl = hitl.taskId
                        let missingPkgPath: string | undefined
                        if (hitl.agentArtifact?.artifactId) {
                            try {
                                const result = await this.handlePlanningPhaseHitl(request)
                                missingPkgPath = result?.MissingPackageJsonPath ?? undefined
                                this.logging.log(`ATX: Missing packages artifact downloaded: ${missingPkgPath}`)
                            } catch (e) {
                                this.logging.log(`ATX: Missing packages artifact download failed: ${e}`)
                            }
                        }
                        return {
                            TransformationJob: {
                                WorkspaceId: request.WorkspaceId,
                                JobId: request.TransformationJobId,
                                Status: 'AWAITING_HUMAN_INPUT',
                            } as AtxTransformationJob,
                            HitlTag: hitl.tag,
                            HitlTaskId: hitl.taskId,
                            MissingPackageJsonPath: missingPkgPath,
                            TransformationPlan: plan,
                        } as AtxGetTransformInfoResponse
                    }
                    if (hitl.tag === 'local-build-verification') {
                        this.jobsPastLocalBuild.add(request.TransformationJobId)
                        this.logging.log(
                            `ATX: ${jobStatus} job has pending LBV HITL — taskId=${hitl.taskId}; surfacing AWAITING_HUMAN_INPUT to IDE`
                        )
                        return {
                            TransformationJob: {
                                WorkspaceId: request.WorkspaceId,
                                JobId: request.TransformationJobId,
                                Status: 'AWAITING_HUMAN_INPUT',
                            } as AtxTransformationJob,
                            HitlTag: hitl.tag,
                            HitlTaskId: hitl.taskId,
                            TransformationPlan: plan,
                        } as AtxGetTransformInfoResponse
                    }
                    // -checkpoint surfaces only post-LBV; pre-job mode-selection stays filtered.
                    if (
                        String(hitl.tag).endsWith('-checkpoint') &&
                        this.jobsPastLocalBuild.has(request.TransformationJobId)
                    ) {
                        this.logging.log(
                            `ATX: ${jobStatus} job has pending post-build checkpoint HITL — taskId=${hitl.taskId}; surfacing AWAITING_HUMAN_INPUT to IDE`
                        )
                        return {
                            TransformationJob: {
                                WorkspaceId: request.WorkspaceId,
                                JobId: request.TransformationJobId,
                                Status: 'AWAITING_HUMAN_INPUT',
                            } as AtxTransformationJob,
                            HitlTag: hitl.tag,
                            HitlTaskId: hitl.taskId,
                            TransformationPlan: plan,
                        } as AtxGetTransformInfoResponse
                    }
                    // Surface any other pending HITL so the IDE never silently misses one.
                    // The only tag we still filter here is a pre-LBV -checkpoint (the always-present
                    // mode-selection checkpoint that should not be surfaced before LBV has run).
                    const isPreLbvCheckpoint =
                        String(hitl.tag).endsWith('-checkpoint') &&
                        !this.jobsPastLocalBuild.has(request.TransformationJobId)
                    if (!isPreLbvCheckpoint) {
                        this.logging.warn(
                            `ATX: ${jobStatus} job has unhandled HITL tag '${hitl.tag}' taskId=${hitl.taskId}; surfacing as AWAITING_HUMAN_INPUT (defensive)`
                        )
                        return {
                            TransformationJob: {
                                WorkspaceId: request.WorkspaceId,
                                JobId: request.TransformationJobId,
                                Status: 'AWAITING_HUMAN_INPUT',
                            } as AtxTransformationJob,
                            HitlTag: hitl.tag,
                            HitlTaskId: hitl.taskId,
                            TransformationPlan: plan,
                        } as AtxGetTransformInfoResponse
                    }
                }

                return {
                    TransformationJob: {
                        WorkspaceId: request.WorkspaceId,
                        JobId: request.TransformationJobId,
                        Status: jobStatus,
                    } as AtxTransformationJob,
                    TransformationPlan: plan,
                } as AtxGetTransformInfoResponse
            }
        } catch (error) {
            this.logging.error(`ATX: GetTransformInfo error: ${String(error)}`)
            return null
        }
    }

    /**
     * Handles AWAITING_HUMAN_INPUT status.
     * Two scenarios:
     * 1. Planning phase: No plan exists yet, need to get HITL artifacts (plan.md, report.md)
     * 2. Execution phase: Plan exists, HITL raised for a specific step
     */
    private async handleAwaitingHumanInput(request: AtxGetTransformInfoRequest): Promise<AtxGetTransformInfoResponse> {
        // Check for local-build-verification HITL first — it can happen with or without a plan
        const hitlResponse = await this.getHitlAgentArtifact(
            request.WorkspaceId,
            request.TransformationJobId,
            request.SolutionRootPath
        )
        if (hitlResponse?.HitlTag === 'local-build-verification') {
            this.logging.log('ATX: local-build-verification HITL — returning directly to IDE')
            const plan = await this.getTransformationPlan(
                request.WorkspaceId,
                request.TransformationJobId,
                request.SolutionRootPath
            )
            return {
                TransformationJob: {
                    WorkspaceId: request.WorkspaceId,
                    JobId: request.TransformationJobId,
                    Status: 'AWAITING_HUMAN_INPUT',
                } as any,
                TransformationPlan: plan,
                HitlTag: 'local-build-verification',
                HitlTaskId: hitlResponse.TaskId,
            } as AtxGetTransformInfoResponse
        }

        // Try to get the transformation plan first
        const plan = await this.getTransformationPlan(
            request.WorkspaceId,
            request.TransformationJobId,
            request.SolutionRootPath
        )

        const hasPlan = plan.Root.Children.length > 0 && plan.Root.Children[0].Children.length > 0

        if (hasPlan) {
            // Execution phase: Plan exists, HITL raised during transformation
            return await this.handleExecutionPhaseHitl(request, plan)
        } else {
            // Planning phase: No plan yet, get HITL artifacts for plan review
            return await this.handlePlanningPhaseHitl(request)
        }
    }

    /**
     * Handles HITL during planning phase - downloads plan.md and report.md for user review.
     */
    private async handlePlanningPhaseHitl(request: AtxGetTransformInfoRequest): Promise<AtxGetTransformInfoResponse> {
        const response = await this.getHitlAgentArtifact(
            request.WorkspaceId,
            request.TransformationJobId,
            request.SolutionRootPath
        )

        this.logging.log(
            `ATX: Planning phase HITL - HitlTag: ${response?.HitlTag}, MissingPackageJsonPath: ${response?.MissingPackageJsonPath}, PlanPath: ${response?.PlanPath}`
        )

        return {
            TransformationJob: {
                WorkspaceId: request.WorkspaceId,
                JobId: request.TransformationJobId,
                Status: 'AWAITING_HUMAN_INPUT',
            } as AtxTransformationJob,
            PlanPath: response?.PlanPath,
            ReportPath: response?.ReportPath,
            MissingPackageJsonPath: response?.MissingPackageJsonPath,
            HitlTag: response?.HitlTag,
            HitlTaskId: response?.TaskId,
        } as AtxGetTransformInfoResponse
    }

    /**
     * Handles HITL during execution phase - plan exists, step-level HITL raised.
     */
    private async handleExecutionPhaseHitl(
        request: AtxGetTransformInfoRequest,
        plan: AtxTransformationPlan
    ): Promise<AtxGetTransformInfoResponse> {
        this.logging.log(`ATX: Execution phase HITL - plan has ${plan.Root.Children.length} steps`)

        // If GetCheckpoints is requested, populate HasCheckpoint field on steps
        if (request.GetCheckpoints) {
            this.populateCheckpointsOnPlan(plan, request.TransformationJobId, request.SolutionRootPath)
        }

        try {
            // Find the step with PENDING_HUMAN_INPUT status in the plan
            const pendingStep = this.findPendingHumanInputStep(plan.Root)

            if (!pendingStep) {
                this.logging.log('ATX: No step with PENDING_HUMAN_INPUT status found in plan')
                return {
                    TransformationJob: {
                        WorkspaceId: request.WorkspaceId,
                        JobId: request.TransformationJobId,
                        Status: 'AWAITING_HUMAN_INPUT',
                    } as AtxTransformationJob,
                    TransformationPlan: plan,
                } as AtxGetTransformInfoResponse
            }

            this.logging.log(`ATX: Found pending step: ${pendingStep.StepId}`)

            // Find the step-level HITL using tag: {stepId}-review
            const stepHitl = await this.findStepLevelHitl(
                request.WorkspaceId,
                request.TransformationJobId,
                pendingStep.StepId
            )

            if (!stepHitl) {
                this.logging.log('ATX: No step-level HITL found, returning plan only')
                return {
                    TransformationJob: {
                        WorkspaceId: request.WorkspaceId,
                        JobId: request.TransformationJobId,
                        Status: 'AWAITING_HUMAN_INPUT',
                    } as AtxTransformationJob,
                    TransformationPlan: plan,
                } as AtxGetTransformInfoResponse
            }

            // Download and parse the agent artifact JSON
            const stepInformation = await this.downloadAndParseStepHitlArtifact(
                request.WorkspaceId,
                request.TransformationJobId,
                stepHitl,
                pendingStep.StepId,
                request.SolutionRootPath
            )

            return {
                TransformationJob: {
                    WorkspaceId: request.WorkspaceId,
                    JobId: request.TransformationJobId,
                    Status: 'AWAITING_HUMAN_INPUT',
                } as AtxTransformationJob,
                TransformationPlan: plan,
                StepInformation: stepInformation,
            } as AtxGetTransformInfoResponse
        } catch (error) {
            this.logging.error(`ATX: handleExecutionPhaseHitl error: ${String(error)}`)
            return {
                TransformationJob: {
                    WorkspaceId: request.WorkspaceId,
                    JobId: request.TransformationJobId,
                    Status: 'AWAITING_HUMAN_INPUT',
                } as AtxTransformationJob,
                TransformationPlan: plan,
            } as AtxGetTransformInfoResponse
        }
    }

    /**
     * Recursively finds a step with PENDING_HUMAN_INPUT status in the plan tree.
     */
    private findPendingHumanInputStep(step: AtxPlanStep): AtxPlanStep | null {
        if (step.Status === 'PENDING_HUMAN_INPUT') {
            return step
        }

        for (const child of step.Children) {
            const found = this.findPendingHumanInputStep(child)
            if (found) {
                return found
            }
        }

        return null
    }

    /**
     * Finds the step-level HITL task by filtering for the "{stepId}-review" tag.
     */
    private async findStepLevelHitl(workspaceId: string, jobId: string, stepId: string): Promise<any | null> {
        try {
            this.logging.log(`ATX: Finding step-level HITL for job: ${jobId}, step: ${stepId}`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                this.logging.error('ATX: Failed to initialize client for findStepLevelHitl')
                return null
            }

            // List HITLs with "{stepId}-review" tag
            const command = new ListHitlTasksCommand({
                workspaceId: workspaceId,
                jobId: jobId,
                taskType: 'NORMAL',
                taskFilter: {
                    taskStatuses: ['AWAITING_HUMAN_INPUT', 'IN_PROGRESS'],
                    tag: `${stepId}-review`,
                },
            })

            await this.addAuthToCommand(command)
            const result = await this.atxClient!.send(command)

            if (!result.hitlTasks || result.hitlTasks.length === 0) {
                this.logging.log(`ATX: No step-level HITL found with tag ${stepId}-review`)
                return null
            }

            const stepHitl = result.hitlTasks[0]
            this.logging.log(`ATX: Found step-level HITL: ${stepHitl.taskId}`)

            // Cache the step HITL task ID for later use in checkpointAction
            this.cachedStepHitl = stepHitl.taskId || null

            return stepHitl
        } catch (error) {
            this.logging.error(`ATX: findStepLevelHitl error: ${String(error)}`)
            return null
        }
    }

    /**
     * Downloads and parses the step HITL agent artifact JSON, and extracts the diff artifact.
     */
    private async downloadAndParseStepHitlArtifact(
        workspaceId: string,
        jobId: string,
        hitlTask: any,
        stepId: string,
        solutionRootPath: string
    ): Promise<AtxStepInformation | null> {
        try {
            const taskId = hitlTask.taskId
            const agentArtifactId = hitlTask.agentArtifact?.artifactId

            if (!agentArtifactId) {
                this.logging.error('ATX: Step HITL has no agent artifact')
                return null
            }

            this.logging.log(`ATX: Downloading step HITL artifact: ${agentArtifactId}`)

            // Download the agent artifact JSON
            const downloadInfo = await this.createArtifactDownloadUrl(workspaceId, jobId, agentArtifactId)
            if (!downloadInfo) {
                throw new Error('Failed to get download URL for step HITL artifact')
            }

            // Download the JSON content
            const response = await got.get(downloadInfo.s3PresignedUrl, {
                headers: downloadInfo.requestHeaders || {},
                responseType: 'text',
                timeout: { request: 30000 },
            })

            const artifactJson = JSON.parse(response.body)
            this.logging.log(`ATX: Parsed step HITL artifact JSON`)

            // Extract diff artifact if present
            let diffArtifactPath = ''
            if (artifactJson.diffArtifactId) {
                diffArtifactPath = await this.downloadDiffArtifact(
                    workspaceId,
                    jobId,
                    artifactJson.diffArtifactId,
                    solutionRootPath,
                    stepId
                )
            }

            const diffApplyFailed = !!(artifactJson.diffArtifactId && diffArtifactPath === '')
            if (diffApplyFailed && this._currentDiffContext) {
                this._currentDiffContext.failed = true
                this._currentDiffContext.failedStepIds.push(stepId)
            }

            return {
                StepId: stepId,
                DiffArtifactPath: diffArtifactPath,
                DiffApplyFailed: diffApplyFailed,
                // Use retryInstruction if available, otherwise fall back to originalInstruction
                RetryInstruction: artifactJson.retryInstruction || artifactJson.originalInstruction,
                ...(artifactJson.isInvalid !== undefined && { IsInvalid: artifactJson.isInvalid }),
                ...(artifactJson.invalidInstruction && { InvalidInstruction: artifactJson.invalidInstruction }),
                ...(artifactJson.invalidReason && { InvalidReason: artifactJson.invalidReason }),
                ...(artifactJson.expiryTimestampUTC && { ExpiryTimestampUTC: artifactJson.expiryTimestampUTC }),
            }
        } catch (error) {
            this.logging.error(`ATX: downloadAndParseStepHitlArtifact error: ${String(error)}`)
            return null
        }
    }

    /**
     * Downloads and extracts the diff artifact ZIP, then immediately applies changes.
     * Retries up to 3 times on failure before giving up.
     */
    private async downloadDiffArtifact(
        workspaceId: string,
        jobId: string,
        diffArtifactId: string,
        solutionRootPath: string,
        stepId: string
    ): Promise<string> {
        const maxRetries = 3

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                this.logging.log(`ATX: Downloading diff artifact: ${diffArtifactId} (attempt ${attempt}/${maxRetries})`)

                const downloadInfo = await this.createArtifactDownloadUrl(workspaceId, jobId, diffArtifactId)
                if (!downloadInfo) {
                    throw new Error('Failed to get download URL for diff artifact')
                }

                const pathToDownload = path.join(solutionRootPath, workspaceFolderName, jobId, 'checkpoints', stepId)

                await Utils.downloadAndExtractArchive(
                    downloadInfo.s3PresignedUrl,
                    downloadInfo.requestHeaders,
                    pathToDownload,
                    `${stepId}.zip`,
                    this.logging
                )

                this.logging.log(`ATX: Diff artifact extracted to: ${pathToDownload}`)

                // Immediately apply changes after extraction
                const result = await this.applyChanges(pathToDownload, solutionRootPath, jobId)
                if (result.success) {
                    this.logging.log(`ATX: Changes applied immediately for step: ${stepId}`)

                    // Update source files manifest with newly added files
                    if (result.addedFiles && result.addedFiles.length > 0) {
                        this.updateSourceFilesManifest(solutionRootPath, jobId, result.addedFiles!)
                    }

                    // Mark this step as applied
                    this.saveAppliedCheckpoint(solutionRootPath, jobId, stepId)

                    // Save timestamp after changes are applied for tracking user modifications
                    this.saveLastAppliedTimestamp(solutionRootPath, jobId, stepId)

                    return pathToDownload
                } else {
                    throw new Error(`Failed to apply changes: ${result.error}`)
                }
            } catch (error) {
                this.logging.error(
                    `ATX: downloadDiffArtifact attempt ${attempt}/${maxRetries} failed: ${String(error)}`
                )
                if (attempt < maxRetries) {
                    const delayMs = Utils.getExpDelayForApiRetryMs(attempt)
                    this.logging.log(`ATX: Retrying in ${delayMs}ms...`)
                    await Utils.sleep(delayMs)
                }
            }
        }

        // All retries exhausted
        this.logging.error(`ATX: downloadDiffArtifact failed after ${maxRetries} attempts for step ${stepId}`)
        return ''
    }

    /**
     * Populates HasCheckpoint field on plan steps based on checkpoint-settings.json or defaults to true.
     */
    private populateCheckpointsOnPlan(plan: AtxTransformationPlan, jobId: string, solutionRootPath: string): void {
        try {
            const checkpointSettingsPath = path.join(
                solutionRootPath,
                workspaceFolderName,
                jobId,
                'checkpoints',
                'checkpoint-settings.json'
            )

            let checkpointSettings: Record<string, boolean> | null = null

            // Check if checkpoint-settings.json exists
            if (fs.existsSync(checkpointSettingsPath)) {
                try {
                    const fileContent = fs.readFileSync(checkpointSettingsPath, 'utf-8')
                    checkpointSettings = JSON.parse(fileContent)
                    this.logging.log(`ATX: Loaded checkpoint settings from ${checkpointSettingsPath}`)
                } catch (e) {
                    this.logging.error(`ATX: Failed to parse checkpoint-settings.json: ${String(e)}`)
                }
            } else {
                this.logging.log('ATX: No checkpoint-settings.json found, defaulting all steps to HasCheckpoint=true')
            }

            // Recursively set HasCheckpoint on all steps
            this.setCheckpointsOnSteps(plan.Root, checkpointSettings)
        } catch (error) {
            this.logging.error(`ATX: populateCheckpointsOnPlan error: ${String(error)}`)
        }
    }

    /**
     * Recursively sets HasCheckpoint on steps based on settings or defaults to true.
     */
    private setCheckpointsOnSteps(step: AtxPlanStep, settings: Record<string, boolean> | null): void {
        // Skip the root node
        if (step.StepId !== 'root') {
            if (settings && settings[step.StepId] !== undefined) {
                step.HasCheckpoint = settings[step.StepId]
            } else {
                // Default to true if no settings file or step not in settings
                step.HasCheckpoint = true
            }
        }

        // Recursively process children
        for (const child of step.Children) {
            this.setCheckpointsOnSteps(child, settings)
        }
    }

    /**
     * Writes a manifest of source files to the checkpoints folder for tracking changes.
     * Creates source-files.json containing all source code file paths from the transformation request.
     */
    private writeSourceFilesManifest(solutionRootPath: string, jobId: string, request: any): void {
        try {
            const checkpointsDir = path.join(solutionRootPath, workspaceFolderName, jobId, 'checkpoints')

            if (!fs.existsSync(checkpointsDir)) {
                fs.mkdirSync(checkpointsDir, { recursive: true })
            }

            const sourceFiles: string[] = []

            // Extract source file paths from project metadata
            if (request.ProjectMetadata) {
                for (const project of request.ProjectMetadata) {
                    if (project.SourceCodeFilePaths) {
                        for (const filePath of project.SourceCodeFilePaths) {
                            if (filePath) {
                                sourceFiles.push(filePath)
                            }
                        }
                    }
                    // Include project file itself
                    if (project.ProjectPath) {
                        sourceFiles.push(project.ProjectPath)
                    }
                }
            }

            // Include solution file
            if (request.SolutionFilePath) {
                sourceFiles.push(request.SolutionFilePath)
            }

            // Include solution config files
            if (request.SolutionConfigPaths) {
                for (const configPath of request.SolutionConfigPaths) {
                    if (configPath) {
                        sourceFiles.push(configPath)
                    }
                }
            }

            const manifest = {
                jobId: jobId,
                solutionRootPath: solutionRootPath,
                createdAt: new Date().toISOString(),
                sourceFiles: sourceFiles,
            }

            const manifestPath = path.join(checkpointsDir, 'source-files.json')
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

            this.logging.log(`ATX: Source files manifest written to ${manifestPath} with ${sourceFiles.length} files`)
        } catch (error) {
            this.logging.error(`ATX: Failed to write source files manifest: ${String(error)}`)
        }
    }

    /**
     * Updates the source files manifest with newly added files from HITL checkpoints.
     * Adds new file paths to the existing manifest, avoiding duplicates.
     */
    private updateSourceFilesManifest(solutionRootPath: string, jobId: string, newFiles: string[]): void {
        try {
            if (!newFiles || newFiles.length === 0) {
                return
            }

            const checkpointsDir = path.join(solutionRootPath, workspaceFolderName, jobId, 'checkpoints')
            const manifestPath = path.join(checkpointsDir, 'source-files.json')

            if (!fs.existsSync(manifestPath)) {
                this.logging.log('ATX: Source files manifest not found, skipping update')
                return
            }

            const manifestContent = fs.readFileSync(manifestPath, 'utf-8')
            const manifest = JSON.parse(manifestContent)

            // Convert new relative paths to absolute paths and add to manifest
            const existingFiles = new Set(manifest.sourceFiles || [])
            let addedCount = 0

            for (const relativePath of newFiles) {
                const absolutePath = path.join(solutionRootPath, relativePath)
                if (!existingFiles.has(absolutePath)) {
                    manifest.sourceFiles.push(absolutePath)
                    existingFiles.add(absolutePath)
                    addedCount++
                }
            }

            if (addedCount > 0) {
                manifest.lastUpdated = new Date().toISOString()
                fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
                this.logging.log(`ATX: Updated source files manifest with ${addedCount} new files`)
            }
        } catch (error) {
            this.logging.error(`ATX: Failed to update source files manifest: ${String(error)}`)
        }
    }

    /**
     * Saves the timestamp when changes were applied for a step.
     * Used to detect user modifications after checkpoint application.
     */
    private saveLastAppliedTimestamp(solutionRootPath: string, jobId: string, stepId: string): void {
        try {
            const checkpointsDir = path.join(solutionRootPath, workspaceFolderName, jobId, 'checkpoints')
            const manifestPath = path.join(checkpointsDir, 'source-files.json')

            if (!fs.existsSync(manifestPath)) {
                this.logging.log('ATX: Source files manifest not found, skipping timestamp save')
                return
            }

            const manifestContent = fs.readFileSync(manifestPath, 'utf-8')
            const manifest = JSON.parse(manifestContent)

            manifest.lastAppliedTimestamp = Date.now()
            manifest.lastAppliedStepId = stepId

            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
            this.logging.log(`ATX: Saved last applied timestamp for step: ${stepId}`)
        } catch (error) {
            this.logging.error(`ATX: Failed to save last applied timestamp: ${String(error)}`)
        }
    }

    /**
     * Gets the list of files that have been modified since the last checkpoint was applied.
     * Returns absolute paths of modified files.
     */
    private getModifiedFilesSinceCheckpoint(
        solutionRootPath: string,
        jobId: string,
        sinceJobStart: boolean = false
    ): string[] {
        try {
            const checkpointsDir = path.join(solutionRootPath, workspaceFolderName, jobId, 'checkpoints')
            const manifestPath = path.join(checkpointsDir, 'source-files.json')

            if (!fs.existsSync(manifestPath)) {
                this.logging.log('ATX: Source files manifest not found')
                return []
            }

            const manifestContent = fs.readFileSync(manifestPath, 'utf-8')
            const manifest = JSON.parse(manifestContent)

            // For the uplink (updateWorkspace), use createdAt as the baseline so edits to
            // files in not-yet-transformed projects are detected — their mtime is before
            // lastAppliedTimestamp (set when an earlier project's checkpoint applied) but
            // after the job started.
            let baseline: number | undefined
            if (sinceJobStart) {
                baseline = manifest.createdAt ? new Date(manifest.createdAt).getTime() : undefined
            } else {
                baseline = manifest.lastAppliedTimestamp
            }

            if (!baseline) {
                this.logging.log('ATX: No baseline timestamp found for modified file detection')
                return []
            }

            const sourceFiles: string[] = manifest.sourceFiles || []
            const modifiedFiles: string[] = []

            for (const filePath of sourceFiles) {
                try {
                    if (fs.existsSync(filePath)) {
                        const stats = fs.statSync(filePath)
                        if (stats.mtimeMs > baseline) {
                            modifiedFiles.push(filePath)
                        }
                    }
                } catch (e) {
                    this.logging.error(`ATX: Failed to check file modification time for ${filePath}: ${String(e)}`)
                }
            }

            this.logging.log(
                `ATX: Found ${modifiedFiles.length} modified files since ${sinceJobStart ? 'job start' : 'last checkpoint'}`
            )
            return modifiedFiles
        } catch (error) {
            this.logging.error(`ATX: Failed to get modified files: ${String(error)}`)
            return []
        }
    }

    /**
     * Creates a zip file containing the modified files for checkpoint action.
     * Returns the path to the created zip file, or empty string if no files or error.
     */
    private async createModifiedFilesZip(
        solutionRootPath: string,
        jobId: string,
        modifiedFiles: string[]
    ): Promise<string> {
        try {
            if (modifiedFiles.length === 0) {
                return ''
            }

            const checkpointsDir = path.join(solutionRootPath, workspaceFolderName, jobId, 'checkpoints')
            const zipPath = path.join(checkpointsDir, 'user-modifications.zip')

            const archive = archiver('zip', { zlib: { level: 9 } })
            const stream = fs.createWriteStream(zipPath)

            await new Promise<void>((resolve, reject) => {
                archive.on('error', err => reject(err))
                stream.on('close', () => resolve())

                archive.pipe(stream)

                for (const filePath of modifiedFiles) {
                    // Calculate relative path from solution root
                    const relativePath = path.relative(solutionRootPath, filePath)
                    archive.file(filePath, { name: relativePath })
                }

                void archive.finalize()
            })

            this.logging.log(`ATX: Created modified files zip with ${modifiedFiles.length} files at ${zipPath}`)
            return zipPath
        } catch (error) {
            this.logging.error(`ATX: Failed to create modified files zip: ${String(error)}`)
            return ''
        }
    }

    async uploadCustomPlan(request: AtxUploadCustomPlanRequest): Promise<AtxUploadCustomPlanResponse> {
        this.logging.log('ATX: Starting upload file')

        try {
            if (!this.atxClient && !(await this.initializeAtxClient())) {
                throw new Error('ATX FES client not initialized')
            }

            const fileName = path.basename(request.FilePath)
            const artifactStorePath = request.ArtifactStorePath
                ? `${request.ArtifactStorePath.replace(/\/+$/, '')}/${fileName}`
                : fileName

            const ext = path.extname(request.FilePath).toLowerCase()
            const fileTypeMap: Record<string, string> = {
                '.json': 'JSON',
                '.zip': 'ZIP',
                '.pdf': 'PDF',
                '.html': 'HTML',
                '.htm': 'HTML',
                '.txt': 'TXT',
                '.md': 'MARKDOWN',
                '.csv': 'CSV',
                '.pptx': 'PPTX',
                '.xlsx': 'XLSX',
            }
            const fileType = (fileTypeMap[ext] || 'OTHER') as FileType

            const sha256 = await Utils.getSha256Async(request.FilePath)

            const command = new CreateArtifactUploadUrlCommand({
                workspaceId: request.WorkspaceId,
                jobId: request.TransformationJobId,
                contentDigest: { Sha256: sha256 },
                artifactReference: {
                    artifactType: {
                        categoryType: CategoryType.CUSTOMER_INPUT,
                        fileType: fileType,
                    },
                },
                fileMetadata: {
                    path: artifactStorePath,
                    description: request.Description,
                },
            })

            await this.addAuthToCommand(command)
            const result = (await this.atxClient!.send(command)) as any

            if (!result?.artifactId || !result?.s3PreSignedUrl) {
                throw new Error('Failed to get upload URL from service')
            }

            const uploadSuccess = await Utils.uploadArtifact(
                result.s3PreSignedUrl,
                request.FilePath,
                result.requestHeaders,
                this.logging
            )

            if (!uploadSuccess) {
                throw new Error('Failed to upload file to S3')
            }

            const completeResponse = await this.completeArtifactUpload(
                request.WorkspaceId,
                request.TransformationJobId,
                result.artifactId
            )

            if (!completeResponse?.success) {
                throw new Error('Failed to complete artifact upload')
            }

            this.logging.log(`ATX: File uploaded successfully - artifactId: ${result.artifactId}`)
            return { Success: true, ArtifactId: result.artifactId }
        } catch (error) {
            this.logging.error(`ATX: UploadCustomPlan error: ${String(error)}`)
            return { Success: false, Error: String(error) }
        }
    }

    async uploadPlan(request: AtxUploadPlanRequest): Promise<AtxUploadPlanResponse | null> {
        this.logging.log('ATX: Starting upload plan')

        if (!this.cachedHitl) {
            this.logging.error('ATX: UploadPlan error: No cached hitl')
            return null
        }

        try {
            const pathToZip = path.join(path.dirname(request.PlanPath), 'transformation-plan-upload.zip')
            await Utils.zipFile(request.PlanPath, pathToZip)

            const uploadInfo = await this.createArtifactUploadUrl(
                request.WorkspaceId,
                request.TransformationJobId,
                pathToZip,
                CategoryType.HITL_FROM_USER,
                FileType.ZIP
            )

            if (!uploadInfo) {
                this.logging.error('ATX: UploadPlan error: Failed to get upload URL')
                return null
            }

            const uploadSuccess = await Utils.uploadArtifact(
                uploadInfo.uploadUrl,
                pathToZip,
                uploadInfo.requestHeaders,
                this.logging
            )

            if (!uploadSuccess) {
                throw new Error('Failed to upload ZIP file to S3')
            }

            const completeResponse = await this.completeArtifactUpload(
                request.WorkspaceId,
                request.TransformationJobId,
                uploadInfo.uploadId
            )

            if (!completeResponse?.success) {
                throw new Error('Failed to complete artifact upload')
            }

            this.logging.log('ATX: Plan uploaded, submitting hitl')

            const submitHitl = await this.submitHitl(
                request.WorkspaceId,
                request.TransformationJobId,
                this.cachedHitl,
                uploadInfo.uploadId
            )

            if (!submitHitl) {
                throw new Error('Failed to submit hitl')
            }

            this.logging.log('ATX: Hitl submitted, polling for status')

            const validation = await this.pollHitlTask(
                request.WorkspaceId,
                request.TransformationJobId,
                this.cachedHitl
            )

            if (!validation) {
                throw new Error('Failed to poll hitl task')
            }

            if (validation === 'Submitted plan did not pass validation, please check the plan for details....') {
                const response = await this.getHitlAgentArtifact(
                    request.WorkspaceId,
                    request.TransformationJobId,
                    path.dirname(path.dirname(path.dirname(request.PlanPath)))
                )

                return {
                    VerificationStatus: false,
                    Message: validation,
                    PlanPath: response?.PlanPath,
                    ReportPath: response?.ReportPath,
                } as AtxUploadPlanResponse
            } else {
                return {
                    VerificationStatus: true,
                    Message: validation,
                } as AtxUploadPlanResponse
            }
        } catch (error) {
            this.logging.error(`ATX: UploadPlan error: ${String(error)}`)
            return null
        }
    }

    // Upload Missing package dependencies
    async uploadPackages(request: AtxUploadPackagesRequest): Promise<AtxUploadPackagesResponse | null> {
        this.logging.log('ATX: Starting upload packages')

        if (!this.cachedHitl) {
            this.logging.error('ATX: UploadPackages error: No cached hitl')
            return { Success: false, Message: 'No cached HITL task' }
        }

        try {
            if (!request.PackagesZipPath) {
                this.logging.log('ATX: No packages to upload, submitting HITL without artifact')
                return { Success: false, Message: "No Package xip path found. Can't proceed with HITL" }
            }

            var humanArtifactId = await this.uploadArtifactAndComplete(
                request.WorkspaceId,
                request.TransformationJobId,
                request.PackagesZipPath
            )

            if (!humanArtifactId) {
                return { Success: false, Message: 'Failed to upload packages' }
            }

            this.logging.log('ATX: Packages uploaded successfully')

            // Submit HITL (with or without artifact)
            const submitHitl = await this.submitHitl(
                request.WorkspaceId,
                request.TransformationJobId,
                this.cachedHitl,
                humanArtifactId
            )

            if (!submitHitl) {
                throw new Error('Failed to submit hitl')
            }

            this.logging.log('ATX: HITL submitted successfully')

            return {
                Success: true,
                Message: 'Packages uploaded and HITL submitted successfully',
            }
        } catch (error) {
            this.logging.error(`ATX: UploadPackages error: ${String(error)}`)
            return { Success: false, Message: String(error) }
        }
    }

    private async uploadArtifactAndComplete(
        workspaceId: string,
        jobId: string,
        filePath: string
    ): Promise<string | null> {
        const uploadInfo = await this.createArtifactUploadUrl(
            workspaceId,
            jobId,
            filePath,
            CategoryType.HITL_FROM_USER,
            FileType.ZIP
        )

        if (!uploadInfo) {
            this.logging.error('ATX: Failed to get upload URL')
            return null
        }

        const uploadSuccess = await Utils.uploadArtifact(
            uploadInfo.uploadUrl,
            filePath,
            uploadInfo.requestHeaders,
            this.logging
        )

        if (!uploadSuccess) {
            this.logging.error('ATX: Failed to upload to S3')
            return null
        }

        const completeResponse = await this.completeArtifactUpload(workspaceId, jobId, uploadInfo.uploadId)

        if (!completeResponse?.success) {
            this.logging.error('ATX: Failed to complete artifact upload')
            return null
        }

        return uploadInfo.uploadId
    }

    /**
     * Stop ATX transformation job
     */
    async stopJob(workspaceId: string, jobId: string): Promise<string> {
        try {
            this.logging.log(`ATX: StopJob operation started for job: ${jobId}`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                throw new Error('ATX FES client not initialized')
            }

            const command = new StopJobCommand({
                workspaceId: workspaceId,
                jobId: jobId,
            })

            await this.addAuthToCommand(command)
            const response = await this.atxClient!.send(command)

            // Clear cached state when user initiates stop
            this.clearJobCache(jobId)

            this.logging.log(`ATX: StopJob SUCCESS - Status: ${response.status}`)
            this.logging.log(`ATX: StopJob RequestId: ${response.$metadata?.requestId}`)
            return response.status || 'STOPPED'
        } catch (error) {
            this.logging.error(`ATX: StopJob error: ${error instanceof Error ? error.message : 'Unknown error'}`)
            return 'FAILED'
        }
    }

    async downloadFinalArtifact(workspaceId: string, jobId: string, solutionRootPath: string): Promise<string | null> {
        try {
            this.logging.log(`ATX: Starting download final artifact for job: ${jobId}`)

            const artifacts = await this.listArtifacts(workspaceId, jobId)
            if (!artifacts || artifacts.length === 0) {
                throw new Error('No CUSTOMER_OUTPUT artifacts available for download')
            }

            const artifact = artifacts[0]
            const artifactId = artifact.artifactId
            this.logging.log(`ATX: Found artifact: ${artifactId}, size: ${artifact.sizeInBytes} bytes`)

            const downloadInfo = await this.createArtifactDownloadUrl(workspaceId, jobId, artifactId)
            if (!downloadInfo) {
                throw new Error('Failed to get ATX FES download URL')
            }

            const pathToDownload = path.join(solutionRootPath, workspaceFolderName, jobId)

            await Utils.downloadAndExtractArchive(
                downloadInfo.s3PresignedUrl,
                downloadInfo.requestHeaders,
                pathToDownload,
                'ExportResultsArchive.zip',
                this.logging
            )

            this.logging.log(`ATX: Download final artifact completed successfully`)
            return pathToDownload
        } catch (error) {
            this.logging.error(`ATX: Download final artifact failed: ${String(error)}`)
            return null
        }
    }

    async getTransformationPlan(
        workspaceId: string,
        jobId: string,
        solutionRootPath: string
    ): Promise<AtxTransformationPlan> {
        try {
            const plan = await this.fetchPlanTree(workspaceId, jobId)

            // Fetch worklogs in parallel (fire and forget, don't block plan return)
            this.fetchWorklogs(workspaceId, jobId, solutionRootPath).catch(e => {
                this.logging.log(`ATX: Could not get worklogs for workspace: ${workspaceId}, job: ${jobId}`)
            })

            // Download completed step artifacts if not already present (all modes)
            const anyFailed = await this.downloadCompletedStepArtifacts(workspaceId, jobId, solutionRootPath, plan)
            if (anyFailed && this._currentDiffContext) {
                this._currentDiffContext.failed = true
            }

            this.logging.log(`ATX: Successfully built plan tree with ${plan.Root.Children.length} root steps`)
            return plan
        } catch (error) {
            this.logging.error(`ATX: getTransformationPlan error: ${String(error)}`)
            return { Root: createEmptyRootNode() }
        }
    }

    /**
     * Downloads artifacts for completed steps in interactive mode if they don't already exist,
     * then applies the changes in order, tracking progress in checkpoints-applied.json.
     */
    private async downloadCompletedStepArtifacts(
        workspaceId: string,
        jobId: string,
        solutionRootPath: string,
        plan: AtxTransformationPlan
    ): Promise<boolean> {
        let anyFailed = false
        // Prevent concurrent execution
        if (this._applyingCheckpoints) {
            this.logging.log('ATX: downloadCompletedStepArtifacts already in progress, skipping')
            return false
        }
        this._applyingCheckpoints = true

        try {
            const completedSteps = this.findCompletedSteps(plan.Root)

            // Sort by score to ensure correct application order
            completedSteps.sort((a, b) => (a.score || 0) - (b.score || 0))

            this.logging.log(`ATX: Found ${completedSteps.length} completed steps to check for artifacts`)

            for (const step of completedSteps) {
                const stepCheckpointPath = path.join(
                    solutionRootPath,
                    workspaceFolderName,
                    jobId,
                    'checkpoints',
                    step.StepId
                )

                // Check if the checkpoint folder already exists
                if (!fs.existsSync(stepCheckpointPath)) {
                    // Download the artifact for this completed step
                    await this.downloadCompletedStepArtifact(workspaceId, jobId, step.StepId, solutionRootPath)
                }

                // Re-read applied steps each iteration — the diff-artifact path
                // (downloadDiffArtifact) may have already applied this step earlier
                // in the same getTransformInfo call, so a stale snapshot would cause
                // a redundant second apply that bypasses user-edit protection.
                const appliedSteps = this.loadAppliedCheckpoints(solutionRootPath, jobId)

                // Apply changes if not already applied
                if (!appliedSteps.includes(step.StepId)) {
                    // Check if checkpoint folder exists after download attempt
                    if (fs.existsSync(stepCheckpointPath)) {
                        const result = await this.applyChanges(stepCheckpointPath, solutionRootPath, jobId)
                        if (result.success) {
                            // Mark this step as applied
                            this.saveAppliedCheckpoint(solutionRootPath, jobId, step.StepId)
                            this.logging.log(`ATX: Applied changes for step: ${step.StepId}`)

                            // Update source files manifest with newly added files
                            if (result.addedFiles && result.addedFiles.length > 0) {
                                this.updateSourceFilesManifest(solutionRootPath, jobId, result.addedFiles)
                            }

                            // Stamp the apply watermark on THIS path too (the diff-artifact
                            // path at the downloadDiffArtifact call site already does). Without
                            // it, ``lastAppliedTimestamp`` stays absent here, so the user-edit
                            // protection in applyChanges sees an empty modified-set and is a
                            // no-op on the exact interactive path DealerFx lost edits on. The
                            // per-step re-stamp can't shrink later steps' protection because
                            // the byte-equal short-circuit ignores the agent's own re-writes.
                            this.saveLastAppliedTimestamp(solutionRootPath, jobId, step.StepId)
                        } else {
                            this.logging.error(`ATX: Failed to apply changes for step ${step.StepId}: ${result.error}`)
                            anyFailed = true
                            if (this._currentDiffContext) {
                                this._currentDiffContext.failedStepIds.push(step.StepId)
                            }
                        }
                    } else {
                        this.logging.error(
                            `ATX: Checkpoint folder not available for step: ${step.StepId}, skipping apply`
                        )
                        anyFailed = true
                        if (this._currentDiffContext) {
                            this._currentDiffContext.failedStepIds.push(step.StepId)
                        }
                    }
                } else {
                    this.logging.log(`ATX: Changes already applied for step: ${step.StepId}`)
                }
            }
        } catch (error) {
            this.logging.error(`ATX: downloadCompletedStepArtifacts error: ${String(error)}`)
            anyFailed = true
        } finally {
            this._applyingCheckpoints = false
        }
        return anyFailed
    }

    /**
     * Loads the list of step IDs that have already had their changes applied.
     */
    private loadAppliedCheckpoints(solutionRootPath: string, jobId: string): string[] {
        try {
            const appliedPath = path.join(
                solutionRootPath,
                workspaceFolderName,
                jobId,
                'checkpoints',
                'checkpoints-applied.json'
            )

            if (fs.existsSync(appliedPath)) {
                const content = fs.readFileSync(appliedPath, 'utf-8')
                const data = JSON.parse(content)
                return data.appliedSteps || []
            }

            return []
        } catch (error) {
            this.logging.error(`ATX: loadAppliedCheckpoints error: ${String(error)}`)
            return []
        }
    }

    /**
     * Saves a step ID to the list of applied checkpoints.
     */
    private saveAppliedCheckpoint(solutionRootPath: string, jobId: string, stepId: string): void {
        try {
            const checkpointsDir = path.join(solutionRootPath, workspaceFolderName, jobId, 'checkpoints')
            const appliedPath = path.join(checkpointsDir, 'checkpoints-applied.json')

            // Ensure directory exists
            if (!fs.existsSync(checkpointsDir)) {
                fs.mkdirSync(checkpointsDir, { recursive: true })
            }

            // Load existing data or create new
            let data: { appliedSteps: string[] } = { appliedSteps: [] }
            if (fs.existsSync(appliedPath)) {
                const content = fs.readFileSync(appliedPath, 'utf-8')
                data = JSON.parse(content)
            }

            // Add step if not already present
            if (!data.appliedSteps.includes(stepId)) {
                data.appliedSteps.push(stepId)
            }

            // Save back to file
            fs.writeFileSync(appliedPath, JSON.stringify(data, null, 2))
            this.logging.log(`ATX: Saved applied checkpoint: ${stepId}`)
        } catch (error) {
            this.logging.error(`ATX: saveAppliedCheckpoint error: ${String(error)}`)
        }
    }

    /**
     * Recursively finds all level 2 steps with SUCCEEDED status in the plan tree.
     * Level 2 steps are grandchildren of root (e.g., ClassLibrary1 under Transform Projects).
     * Returns steps sorted by their score to ensure correct application order.
     */
    private findCompletedSteps(step: AtxPlanStep, depth: number = 0): (AtxPlanStep & { score?: number })[] {
        const completedSteps: (AtxPlanStep & { score?: number })[] = []

        // Only count SUCCEEDED steps at depth 2 (grandchildren of root)
        if (depth === 2 && step.Status === 'SUCCEEDED') {
            completedSteps.push(step)
        }

        // Process children
        for (const child of step.Children) {
            completedSteps.push(...this.findCompletedSteps(child, depth + 1))
        }

        return completedSteps
    }

    /**
     * Downloads and extracts the artifact for a completed step.
     */
    private async downloadCompletedStepArtifact(
        workspaceId: string,
        jobId: string,
        stepId: string,
        solutionRootPath: string
    ): Promise<void> {
        try {
            this.logging.log(`ATX: Downloading artifact for completed step: ${stepId}`)

            // List artifacts filtered by stepId and CUSTOMER_OUTPUT category
            const artifacts = await this.listArtifactsForStep(workspaceId, jobId, stepId)

            if (!artifacts || artifacts.length === 0) {
                this.logging.log(`ATX: No CUSTOMER_OUTPUT artifact found for step: ${stepId}`)
                return
            }

            // There should be only one artifact that matches
            const artifact = artifacts[0]
            this.logging.log(`ATX: Found artifact ${artifact.artifactId} for step: ${stepId}`)

            // Download and extract the artifact
            await this.downloadDiffArtifact(workspaceId, jobId, artifact.artifactId, solutionRootPath, stepId)
        } catch (error) {
            this.logging.error(`ATX: downloadCompletedStepArtifact error for step ${stepId}: ${String(error)}`)
        }
    }

    /**
     * Lists artifacts filtered by stepId and CUSTOMER_OUTPUT category.
     */
    private async listArtifactsForStep(workspaceId: string, jobId: string, stepId: string): Promise<any[] | null> {
        try {
            this.logging.log(`ATX: Listing artifacts for step: ${stepId}`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                this.logging.error('ATX: Failed to initialize client for listArtifactsForStep')
                return null
            }

            const command = new ListArtifactsCommand({
                workspaceId: workspaceId,
                jobFilter: {
                    jobId: jobId,
                    categoryType: 'CUSTOMER_OUTPUT',
                    planStepId: stepId,
                },
            })

            await this.addAuthToCommand(command)
            const result = await this.atxClient!.send(command)

            this.logging.log(`ATX: Found ${result.artifacts?.length || 0} artifacts for step: ${stepId}`)
            return result.artifacts || []
        } catch (error) {
            this.logging.error(`ATX: listArtifactsForStep error: ${String(error)}`)
            return null
        }
    }

    /**
     * Fetches all plan steps in a single API call and builds the tree locally.
     */
    private async fetchPlanTree(workspaceId: string, jobId: string): Promise<AtxTransformationPlan> {
        const root = createEmptyRootNode()

        if (!this.atxClient && !(await this.initializeAtxClient())) {
            this.logging.error('ATX: Failed to initialize client for fetchPlanTree')
            return { Root: root }
        }

        // Fetch ALL steps in a single call (no parentStepId = returns all steps)
        const allSteps = await this.fetchAllSteps(workspaceId, jobId)
        if (!allSteps || allSteps.length === 0) {
            this.logging.log('ATX: No plan steps available yet')
            return { Root: root }
        }

        // Build tree from flat list
        root.Children = this.buildTreeFromFlatList(allSteps)

        // Log step labels including sub-steps for diagnostic visibility
        // during the build/fix loop polling cycle.
        const allLabels = allSteps.map((s: any) => s.stepLabel || s.stepName || s.stepId || '?')
        const errorFixRounds = allLabels.filter((l: string) => l.includes('error-fix-round'))
        this.logging.log(
            `ATX: fetchPlanTree completed - Built tree with ${root.Children.length} root steps from ${allSteps.length} total steps` +
                (errorFixRounds.length > 0
                    ? ` (includes ${errorFixRounds.length} error-fix-round sub-steps: ${errorFixRounds.join(', ')})`
                    : '')
        )
        return { Root: root }
    }

    /**
     * Fetches all steps in a single API call (no parentStepId filter).
     */
    private async fetchAllSteps(workspaceId: string, jobId: string): Promise<any[]> {
        const allSteps: any[] = []
        let nextToken: string | undefined

        try {
            do {
                const command = new ListJobPlanStepsCommand({
                    workspaceId: workspaceId,
                    jobId: jobId,
                    maxResults: 100,
                    ...(nextToken && { nextToken }),
                })

                await this.addAuthToCommand(command)
                const result = await this.atxClient!.send(command)

                if (result?.steps) {
                    allSteps.push(...result.steps)
                }
                nextToken = result?.nextToken
            } while (nextToken)

            this.logging.log(`ATX: Fetched ${allSteps.length} total steps`)
            return allSteps
        } catch (error) {
            this.logging.error(`ATX: Error fetching all steps: ${String(error)}`)
            return []
        }
    }

    /**
     * Builds a tree structure from a flat list of steps using ParentStepId relationships.
     */
    private buildTreeFromFlatList(flatSteps: any[]): AtxPlanStep[] {
        // Create a map of StepId -> AtxPlanStep for quick lookup
        const stepMap = new Map<string, AtxPlanStep>()

        // First pass: convert all API steps to AtxPlanStep objects
        for (const apiStep of flatSteps) {
            const step = this.mapApiStepToNode(apiStep)
            if (step.StepId) {
                stepMap.set(step.StepId, step)
            }
        }

        // Second pass: build parent-child relationships
        const rootChildren: AtxPlanStep[] = []

        for (const step of stepMap.values()) {
            if (step.ParentStepId === 'root' || !step.ParentStepId) {
                rootChildren.push(step)
            } else {
                const parent = stepMap.get(step.ParentStepId)
                if (parent) {
                    parent.Children.push(step)
                    // Substeps of the unit-test-generation step render status-only in the IDE
                    // (no checkpoint toggle / "View Results" button / checkpoint checkbox); the
                    // parent keeps its normal affordance. The service does not send a machine
                    // label, so we key off the parent's name. Only direct children are marked,
                    // so the parent "Generate Unit Tests" step itself stays interactive.
                    if (this.isUnitTestGenerationStep(parent.StepName)) {
                        step.IsStatusOnly = true
                    }
                } else {
                    // Orphan step - treat as root level
                    rootChildren.push(step)
                }
            }
        }

        // Sort all children arrays by score
        this.sortStepsByScore(rootChildren)
        for (const step of stepMap.values()) {
            if (step.Children.length > 0) {
                this.sortStepsByScore(step.Children)
            }
        }

        return rootChildren
    }

    /**
     * Maps an API step response to AtxPlanStep.
     * Converts from FES camelCase to C#-compatible PascalCase.
     */
    /**
     * True when a step's name identifies it as the unit-test-generation parent step, whose
     * direct substeps (plan / generate / merge / coverage) should render status-only in the IDE.
     * Matches on normalized name because the service sends no machine-readable step label.
     */
    private isUnitTestGenerationStep(stepName: string | undefined): boolean {
        return typeof stepName === 'string' && stepName.trim().toLowerCase() === 'generate unit tests'
    }

    private mapApiStepToNode(apiStep: any): AtxPlanStep & { score?: number } {
        return {
            StepId: apiStep.stepId || '',
            ParentStepId: apiStep.parentStepId === 'root' ? null : apiStep.parentStepId || null,
            StepName: apiStep.stepName || '',
            Description: apiStep.description || '',
            Status: this.mapApiStatus(apiStep.status),
            Children: [],
            // Defaults false here; the value is assigned structurally during tree assembly
            // (buildTreeFromFlatList) for substeps of the unit-test-generation step. The service
            // does not send a machine-readable step label, so parent identity — not a label —
            // drives this. PascalCase matches the other fields (StepId/HasCheckpoint/...) so it
            // binds onto the C# AtxPlanStep.IsStatusOnly.
            IsStatusOnly: false,
            // Keep score for sorting (not sent to C#)
            score: apiStep.score || 0,
        }
    }

    /**
     * Maps API status string to PlanStepStatus.
     * Returns the status directly if valid, otherwise defaults to NOT_STARTED.
     */
    private mapApiStatus(status: string | undefined): PlanStepStatus {
        if (!status) return 'NOT_STARTED'
        // The API returns valid PlanStepStatus values directly
        return status as PlanStepStatus
    }

    /**
     * Sorts steps by score (primary).
     */
    private sortStepsByScore(steps: (AtxPlanStep & { score?: number })[]): void {
        steps.sort((a, b) => (a.score || 0) - (b.score || 0))
    }

    /**
     * Fetches worklogs for a job and saves them to disk.
     */
    private async fetchWorklogs(workspaceId: string, jobId: string, solutionRootPath: string): Promise<void> {
        await this.listWorklogs(workspaceId, jobId, solutionRootPath)
    }

    /**
     * Lists artifacts using FES client with filtering - default to CUSTOMER_OUTPUT
     */
    private async listArtifacts(
        workspaceId: string,
        jobId: string,
        filter: CategoryType = 'CUSTOMER_OUTPUT'
    ): Promise<any[] | null> {
        try {
            this.logging.log(`ATX: Starting ListArtifacts for job: ${jobId}`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                this.logging.error('ATX: Failed to initialize client for ListArtifacts')
                return null
            }

            const command = new ListArtifactsCommand({
                workspaceId: workspaceId,
                jobFilter: {
                    jobId: jobId,
                    categoryType: filter, // Server-side filtering for customer output artifacts
                },
            })

            await this.addAuthToCommand(command)
            const result = await this.atxClient!.send(command)

            this.logging.log(`ATX: ListArtifacts completed - Found ${result.artifacts?.length || 0} artifacts`)
            return result.artifacts || []
        } catch (error) {
            this.logging.error(`ATX: ListArtifacts error: ${error instanceof Error ? error.message : 'Unknown error'}`)
            return null
        }
    }

    /**
     * Lists worklogs for a job and saves them to disk grouped by step ID.
     */
    private _worklogNextTokenByJob: Map<string, string> = new Map()

    private async listWorklogs(
        workspaceId: string,
        jobId: string,
        solutionRootPath: string,
        stepId?: string,
        saveLimit?: number,
        nextToken?: string
    ): Promise<any[] | null> {
        try {
            this.logging.log(`ATX: Starting ListWorklogs for job: ${jobId}`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                this.logging.error('ATX: Failed to initialize client for ListWorklogs')
                return null
            }

            const command = new ListWorklogsCommand({
                workspaceId: workspaceId,
                jobId: jobId,
                ...(stepId && {
                    worklogFilter: {
                        stepIdFilter: {
                            stepId: stepId,
                        },
                    },
                }),
                ...(nextToken && { nextToken }),
            })

            await this.addAuthToCommand(command)
            const result = await this.atxClient!.send(command)

            // SDK types don't include outputToken yet — field exists in FES API response
            const outputToken = (result as any).outputToken as string | undefined
            if (nextToken) {
                // Pagination call (loadOlderWorklogs) — always update token
                if (outputToken) {
                    this._worklogNextTokenByJob.set(jobId, outputToken)
                } else {
                    this._worklogNextTokenByJob.delete(jobId)
                }
            } else if (!this._worklogNextTokenByJob.has(jobId) && outputToken) {
                // First-page call from polling — only seed token if not already set
                this._worklogNextTokenByJob.set(jobId, outputToken)
            }
            this.logging.log(`ATX: ListWorklogs completed - Found ${result.worklogs?.length || 0} entries`)

            const worklogs = result.worklogs || []
            const entriesToSave = saveLimit ? worklogs.slice(0, saveLimit) : worklogs
            for (const value of entriesToSave) {
                const currentStepId = value.attributeMap?.STEP_ID || stepId || 'Progress'
                await Utils.saveWorklogsToJson(
                    jobId,
                    currentStepId,
                    value.description || '',
                    solutionRootPath,
                    value.timestamp
                )
            }

            return worklogs
        } catch (error) {
            this.logging.error(`ATX: ListWorklogs error: ${String(error)}`)
            return null
        }
    }

    async loadOlderWorklogs(
        workspaceId: string,
        jobId: string,
        solutionRootPath: string,
        nextToken?: string
    ): Promise<{ hasMore: boolean }> {
        const token = nextToken || this._worklogNextTokenByJob.get(jobId)
        if (!token) {
            return { hasMore: false }
        }

        const result = await this.listWorklogs(workspaceId, jobId, solutionRootPath, undefined, undefined, token)
        if (result === null) {
            this._worklogNextTokenByJob.delete(jobId)
            return { hasMore: false }
        }
        return { hasMore: this._worklogNextTokenByJob.has(jobId) }
    }

    /**
     * Set checkpoints for interactive mode transformation.
     * Lists HITLs with "checkpoint-settings" tag, uploads checkpoints as JSON artifact,
     * and updates the HITL task with the new artifact ID.
     */
    async setCheckpoints(
        workspaceId: string,
        jobId: string,
        solutionRootPath: string,
        checkpoints: Record<string, boolean>,
        interactiveMode?: InteractiveMode
    ): Promise<AtxSetCheckpointsResponse> {
        try {
            this.logging.log(`ATX: Starting setCheckpoints for job: ${jobId}`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                return { Success: false, Error: 'ATX FES client not initialized' }
            }

            // Step 1: List HITLs with "checkpoint-settings" tag
            const hitlTask = await this.findCheckpointSettingsHitl(workspaceId, jobId)

            if (!hitlTask) {
                return { Success: false, Error: 'No HITL task found with checkpoint-settings tag' }
            }

            this.logging.log(`ATX: Found checkpoint-settings HITL task: ${hitlTask.taskId}`)

            // Step 2: Create JSON file with checkpoints mapping in checkpoints folder
            const artifactDir = path.join(solutionRootPath, workspaceFolderName, jobId, 'checkpoints')
            if (!fs.existsSync(artifactDir)) {
                fs.mkdirSync(artifactDir, { recursive: true })
            }

            // Build JSON content with optional interactiveMode
            const jsonContent: Record<string, any> = { ...checkpoints }
            if (interactiveMode) {
                // Map PascalCase to backend format: Interactive->interactive, Autonomous->auto
                let mappedMode = 'auto'
                if (interactiveMode === 'Interactive') mappedMode = 'interactive'
                jsonContent.interactive_mode = mappedMode
                this.logging.log(`ATX: setCheckpoints interactive_mode=${mappedMode}`)
            }

            const jsonFilePath = path.join(artifactDir, 'checkpoint-settings.json')
            this.logging.log(`ATX: Writing checkpoint-settings.json to ${jsonFilePath}`)
            fs.writeFileSync(jsonFilePath, JSON.stringify(jsonContent, null, 2))

            // Step 3: Upload the JSON artifact
            const uploadInfo = await this.createArtifactUploadUrl(
                workspaceId,
                jobId,
                jsonFilePath,
                CategoryType.HITL_FROM_USER,
                FileType.JSON
            )

            if (!uploadInfo) {
                return { Success: false, Error: 'Failed to create artifact upload URL' }
            }

            const uploadSuccess = await Utils.uploadArtifact(
                uploadInfo.uploadUrl,
                jsonFilePath,
                uploadInfo.requestHeaders,
                this.logging
            )

            if (!uploadSuccess) {
                return { Success: false, Error: 'Failed to upload checkpoints artifact to S3' }
            }

            // Step 4: Complete artifact upload
            const completeResponse = await this.completeArtifactUpload(workspaceId, jobId, uploadInfo.uploadId)

            if (!completeResponse?.success) {
                return { Success: false, Error: 'Failed to complete artifact upload' }
            }

            // Step 5: Update HITL task with the new artifact ID
            const updateResult = await this.updateHitl(workspaceId, jobId, hitlTask.taskId, uploadInfo.uploadId)

            if (!updateResult) {
                return { Success: false, Error: 'Failed to update HITL task with checkpoints artifact' }
            }

            this.logging.log(`ATX: setCheckpoints completed successfully`)
            return { Success: true }
        } catch (error) {
            this.logging.error(`ATX: setCheckpoints error: ${String(error)}`)
            return { Success: false, Error: String(error) }
        }
    }

    /**
     * Find HITL task with "checkpoint-settings" tag
     */
    private async findCheckpointSettingsHitl(workspaceId: string, jobId: string): Promise<any | null> {
        try {
            this.logging.log(`ATX: Looking for HITL task with checkpoint-settings tag`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                this.logging.error('ATX: Failed to initialize client for findCheckpointSettingsHitl')
                return null
            }

            const command = new ListHitlTasksCommand({
                workspaceId: workspaceId,
                jobId: jobId,
                taskType: 'NORMAL',
                taskFilter: {
                    taskStatuses: ['AWAITING_HUMAN_INPUT', 'IN_PROGRESS'],
                    tag: `${jobId}-checkpoint`,
                },
            })

            await this.addAuthToCommand(command)
            const result = await this.atxClient!.send(command)

            if (result.hitlTasks && result.hitlTasks.length > 0) {
                this.logging.log(`ATX: Found ${result.hitlTasks.length} HITL task(s) with checkpoint-settings tag`)
                return result.hitlTasks[0]
            }

            this.logging.log('ATX: No HITL task found with checkpoint-settings tag')
            return null
        } catch (error) {
            this.logging.error(`ATX: findCheckpointSettingsHitl error: ${String(error)}`)
            return null
        }
    }

    /**
     * Update workspace by detecting modified files and submitting them to the step HITL.
     * Goes through source-files.json to find files with last modified date > recorded timestamp,
     * creates a zip with modified files and metadata.json containing filesUpdated with relative paths.
     */
    async updateWorkspace(
        workspaceId: string,
        jobId: string,
        solutionRootPath: string,
        stepId: string
    ): Promise<AtxUpdateWorkspaceResponse> {
        try {
            this.logging.log(`ATX: Starting updateWorkspace for job: ${jobId}, step: ${stepId}`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                return { Success: false, Error: 'ATX FES client not initialized' }
            }

            // Get the cached step HITL task ID, or query for it if not cached.
            // The client-supplied stepId is advisory — it may be a stale substep id that
            // doesn't match the backend's review HITL tag (which uses the top-level project
            // step id). When the client id misses, fall back to resolving the real pending
            // step server-side via the plan tree — the same pattern getTransformInfo uses.
            let taskId: string | null = this.cachedStepHitl
            if (!taskId) {
                this.logging.log('ATX: No cached step HITL, querying for active step HITL')
                let stepHitl = await this.findStepLevelHitl(workspaceId, jobId, stepId)

                // Fallback 1: resolve the real pending step from plan tree
                if (!stepHitl || !stepHitl.taskId) {
                    this.logging.log(
                        `ATX: Client stepId ${stepId} did not match a review HITL, resolving pending step from plan`
                    )
                    const plan = await this.fetchPlanTree(workspaceId, jobId)
                    const pendingStep = this.findPendingHumanInputStep(plan.Root)
                    if (pendingStep?.StepId && pendingStep.StepId !== stepId) {
                        this.logging.log(`ATX: Resolved pending step ${pendingStep.StepId}, retrying HITL lookup`)
                        stepHitl = await this.findStepLevelHitl(workspaceId, jobId, pendingStep.StepId)
                    }
                }

                // Fallback 2: list all active HITLs and find a -review one directly.
                // Covers the race where step status already flipped (e.g. to IN_PROGRESS
                // on retry) but the review HITL is still alive awaiting the workspace sync.
                if (!stepHitl || !stepHitl.taskId) {
                    this.logging.log('ATX: Plan-based resolution missed, scanning active HITLs for a review task')
                    const allHitls = await this.listHitls(workspaceId, jobId)
                    const reviewHitl = allHitls?.find(h => typeof h.tag === 'string' && h.tag.endsWith('-review'))
                    if (reviewHitl?.taskId) {
                        this.logging.log(
                            `ATX: Found active review HITL via scan: tag=${reviewHitl.tag}, taskId=${reviewHitl.taskId}`
                        )
                        stepHitl = reviewHitl
                    }
                }

                if (!stepHitl || !stepHitl.taskId) {
                    return { Success: false, Error: 'No active step HITL found' }
                }
                taskId = stepHitl.taskId
            }

            const validTaskId = taskId as string

            // Check for user-modified files since job start — not since last checkpoint.
            // Files in not-yet-transformed projects may have been edited before any checkpoint
            // applied (mtime < lastAppliedTimestamp) but still need to be uploaded so the agent
            // sees them when it starts those projects.
            const modifiedFiles = this.getModifiedFilesSinceCheckpoint(solutionRootPath, jobId, true)

            this.logging.log(`ATX: Found ${modifiedFiles.length} user-modified files, creating zip with metadata`)

            // Create zip with modified files and metadata.json (even if empty)
            const zipPath = await this.createUpdateWorkspaceZip(solutionRootPath, jobId, modifiedFiles)

            if (!zipPath) {
                return { Success: false, Error: 'Failed to create update workspace zip' }
            }

            // Upload the zip
            const uploadInfo = await this.createArtifactUploadUrl(
                workspaceId,
                jobId,
                zipPath,
                CategoryType.HITL_FROM_USER,
                FileType.ZIP
            )

            if (!uploadInfo) {
                return { Success: false, Error: 'Failed to create artifact upload URL' }
            }

            const uploadSuccess = await Utils.uploadArtifact(
                uploadInfo.uploadUrl,
                zipPath,
                uploadInfo.requestHeaders,
                this.logging
            )

            if (!uploadSuccess) {
                return { Success: false, Error: 'Failed to upload update workspace zip to S3' }
            }

            // Complete artifact upload
            const completeResponse = await this.completeArtifactUpload(workspaceId, jobId, uploadInfo.uploadId)

            if (!completeResponse?.success) {
                return { Success: false, Error: 'Failed to complete artifact upload' }
            }

            // Update the HITL task with the human artifact
            const updateResult = await this.updateHitl(workspaceId, jobId, validTaskId, uploadInfo.uploadId)

            if (!updateResult) {
                return { Success: false, Error: 'Failed to update workspace HITL' }
            }

            // Clear the cached step HITL after successful update
            this.cachedStepHitl = null

            // Reset the watermark so the incoming retry checkpoint isn't treated as a
            // conflict. The customer's edits have been uploaded — they expect the agent's
            // retry output to land on disk, not be skipped by edit-protection.
            this.saveLastAppliedTimestamp(solutionRootPath, jobId, 'updateWorkspace')

            this.logging.log(`ATX: updateWorkspace completed successfully`)
            return { Success: true }
        } catch (error) {
            this.logging.error(`ATX: updateWorkspace error: ${String(error)}`)
            return { Success: false, Error: String(error) }
        }
    }

    /**
     * Creates a zip file containing modified files and a metadata.json with filesUpdated list.
     * If no files are modified, creates a zip with just an empty metadata.json.
     * Returns the path to the created zip file, or empty string if error.
     */
    private async createUpdateWorkspaceZip(
        solutionRootPath: string,
        jobId: string,
        modifiedFiles: string[]
    ): Promise<string> {
        try {
            const checkpointsDir = path.join(solutionRootPath, workspaceFolderName, jobId, 'checkpoints')
            if (!fs.existsSync(checkpointsDir)) {
                fs.mkdirSync(checkpointsDir, { recursive: true })
            }

            const zipPath = path.join(checkpointsDir, 'update-workspace.zip')

            // Calculate relative paths for metadata
            const filesUpdated: string[] = modifiedFiles.map(filePath => path.relative(solutionRootPath, filePath))

            // Create metadata.json content (empty array if no files modified)
            const metadata = {
                filesUpdated: filesUpdated,
            }

            const archive = archiver('zip', { zlib: { level: 9 } })
            const stream = fs.createWriteStream(zipPath)

            await new Promise<void>((resolve, reject) => {
                archive.on('error', err => reject(err))
                stream.on('close', () => resolve())

                archive.pipe(stream)

                // Add metadata.json
                archive.append(JSON.stringify(metadata, null, 2), { name: 'metadata.json' })

                // Add modified files with relative paths
                for (const filePath of modifiedFiles) {
                    const relativePath = path.relative(solutionRootPath, filePath)
                    archive.file(filePath, { name: relativePath })
                }

                void archive.finalize()
            })

            this.logging.log(`ATX: Created update workspace zip with ${modifiedFiles.length} files at ${zipPath}`)
            return zipPath
        } catch (error) {
            this.logging.error(`ATX: Failed to create update workspace zip: ${String(error)}`)
            return ''
        }
    }

    /**
     * Submit a standard HITL task with a human artifact.
     */
    private async submitStandardHitl(
        workspaceId: string,
        jobId: string,
        taskId: string,
        humanArtifactId: string
    ): Promise<any | null> {
        try {
            this.logging.log(`ATX: Starting SubmitStandardHitl for task: ${taskId}`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                this.logging.error('ATX: Failed to initialize client for SubmitStandardHitl')
                return null
            }

            const command = new SubmitStandardHitlTaskCommand({
                workspaceId: workspaceId,
                jobId: jobId,
                taskId: taskId,
                action: 'APPROVE',
                humanArtifact: {
                    artifactId: humanArtifactId,
                },
            })

            await this.addAuthToCommand(command)
            const result = await this.atxClient!.send(command)

            this.logging.log(`ATX: SubmitStandardHitl completed - task status: ${result.status || 'UNKNOWN'}`)
            return result
        } catch (error) {
            this.logging.error(`ATX: SubmitStandardHitl error: ${String(error)}`)
            return null
        }
    }

    /**
     * Apply changes from a checkpoint folder to the solution root.
     * Reads metadata.json and applies file additions, removals, updates, and moves.
     */
    private async applyChanges(
        checkpointFolderPath: string,
        solutionRootPath: string,
        jobId: string = ''
    ): Promise<{
        success: boolean
        error?: string
        filesAdded?: number
        filesRemoved?: number
        filesUpdated?: number
        filesMoved?: number
        addedFiles?: string[]
        conflictedFiles?: string[]
    }> {
        try {
            this.logging.log(`ATX: Starting applyChanges from ${checkpointFolderPath} to ${solutionRootPath}`)

            // Read metadata.json from checkpoint folder
            const metadataPath = path.join(checkpointFolderPath, 'metadata.json')
            if (!fs.existsSync(metadataPath)) {
                return { success: false, error: `metadata.json not found at ${metadataPath}` }
            }

            const metadataContent = fs.readFileSync(metadataPath, 'utf-8')
            const metadata = JSON.parse(metadataContent)

            const filesAdded = metadata.filesAdded || []
            const filesRemoved = metadata.filesRemoved || []
            const filesUpdated = metadata.filesUpdated || []
            const movedFilesMap = metadata.movedFilesMap || []

            let addedCount = 0
            let removedCount = 0
            let updatedCount = 0
            let movedCount = 0
            const successfullyAddedFiles: string[] = []

            // Files the customer edited locally since the last checkpoint apply. Applying
            // the transform's version on top of these silently destroys the customer's
            // work (DealerFx P452432920 — edits to an already-transformed project clobbered
            // by a later sync). Compute the protected set ONCE up front (a per-step stamp
            // would shrink it for later steps in this run) and resolve to absolute paths so
            // it can be membership-tested against each resolved destination. ``getModified…``
            // returns absolute paths; an absent watermark (no prior apply) yields [], i.e.
            // first-apply is unprotected by necessity — no ``before/`` baseline ships, so a
            // 3-way merge is infeasible and the first write onto a virgin tree cannot conflict.
            const userModifiedFiles = new Set(
                (jobId ? this.getModifiedFilesSinceCheckpoint(solutionRootPath, jobId) : []).map(p => path.resolve(p))
            )
            const conflictedFiles: string[] = []

            // Handle filesAdded: Copy from {checkpointFolder}/after/{relativePath} to {solutionRootPath}/{relativePath}
            for (const relativePath of filesAdded) {
                try {
                    const sourcePath = path.join(checkpointFolderPath, 'after', relativePath)
                    const destPath = path.join(solutionRootPath, relativePath)

                    // Preserve a customer edit rather than clobber it (see userModifiedFiles).
                    if (
                        this.shouldPreserveUserFile(
                            destPath,
                            sourcePath,
                            userModifiedFiles,
                            conflictedFiles,
                            solutionRootPath,
                            jobId
                        )
                    ) {
                        continue
                    }

                    // Ensure destination directory exists
                    const destDir = path.dirname(destPath)
                    if (!fs.existsSync(destDir)) {
                        fs.mkdirSync(destDir, { recursive: true })
                    }

                    fs.copyFileSync(sourcePath, destPath)
                    addedCount++
                    successfullyAddedFiles.push(relativePath)
                    this.logging.log(`ATX: Added file: ${relativePath}`)
                } catch (e) {
                    this.logging.error(`ATX: Failed to add file ${relativePath}: ${String(e)}`)
                }
            }

            // Handle filesRemoved: Delete file at {solutionRootPath}/{relativePath}
            // Guard: if the customer edited the file since the last apply, preserve it
            // and record the conflict rather than silently deleting their work.
            for (const relativePath of filesRemoved) {
                try {
                    const filePath = path.join(solutionRootPath, relativePath)
                    if (fs.existsSync(filePath)) {
                        if (userModifiedFiles.size > 0 && userModifiedFiles.has(path.resolve(filePath))) {
                            try {
                                const backupPath = this.backupConflictedFile(filePath, jobId, solutionRootPath)
                                this.logging.log(
                                    `ATX: Preserved customer-modified file from deletion, backed up to ${backupPath}: ${filePath}`
                                )
                            } catch (e) {
                                this.logging.error(`ATX: Failed to back up conflicted file ${filePath}: ${String(e)}`)
                            }
                            conflictedFiles.push(path.resolve(filePath))
                            continue
                        }
                        fs.unlinkSync(filePath)
                        removedCount++
                        this.logging.log(`ATX: Removed file: ${relativePath}`)
                    }
                } catch (e) {
                    this.logging.error(`ATX: Failed to remove file ${relativePath}: ${String(e)}`)
                }
            }

            // Handle filesUpdated: Copy from {checkpointFolder}/after/{relativePath} to {solutionRootPath}/{relativePath}
            for (const relativePath of filesUpdated) {
                try {
                    const sourcePath = path.join(checkpointFolderPath, 'after', relativePath)
                    const destPath = path.join(solutionRootPath, relativePath)

                    // The DealerFx clobber: if the customer edited this already-applied file
                    // since the last sync, preserve their version instead of overwriting it.
                    if (
                        this.shouldPreserveUserFile(
                            destPath,
                            sourcePath,
                            userModifiedFiles,
                            conflictedFiles,
                            solutionRootPath,
                            jobId
                        )
                    ) {
                        continue
                    }

                    // Ensure destination directory exists
                    const destDir = path.dirname(destPath)
                    if (!fs.existsSync(destDir)) {
                        fs.mkdirSync(destDir, { recursive: true })
                    }

                    fs.copyFileSync(sourcePath, destPath)
                    updatedCount++
                    this.logging.log(`ATX: Updated file: ${relativePath}`)
                } catch (e) {
                    this.logging.error(`ATX: Failed to update file ${relativePath}: ${String(e)}`)
                }
            }

            // Handle filesMoved: Use movedFilesMap to copy content from before to after location, delete before file
            for (const mapping of movedFilesMap) {
                try {
                    const beforePath = path.join(solutionRootPath, mapping.before)
                    const afterPath = path.join(solutionRootPath, mapping.after)

                    // Ensure destination directory exists
                    const afterDir = path.dirname(afterPath)
                    if (!fs.existsSync(afterDir)) {
                        fs.mkdirSync(afterDir, { recursive: true })
                    }

                    // Copy content from before to after
                    if (fs.existsSync(beforePath)) {
                        // If the customer edited the move TARGET, preserve it — and skip the
                        // unlink too, so their edited source is neither clobbered nor deleted.
                        if (
                            this.shouldPreserveUserFile(
                                afterPath,
                                beforePath,
                                userModifiedFiles,
                                conflictedFiles,
                                solutionRootPath,
                                jobId
                            )
                        ) {
                            continue
                        }
                        // If the customer edited the move SOURCE, preserve it in place —
                        // the rename would delete their edited file from its original path.
                        if (userModifiedFiles.size > 0 && userModifiedFiles.has(path.resolve(beforePath))) {
                            try {
                                const backupPath = this.backupConflictedFile(beforePath, jobId, solutionRootPath)
                                this.logging.log(
                                    `ATX: Preserved customer-modified move source, backed up to ${backupPath}: ${beforePath}`
                                )
                            } catch (e) {
                                this.logging.error(`ATX: Failed to back up conflicted file ${beforePath}: ${String(e)}`)
                            }
                            conflictedFiles.push(path.resolve(beforePath))
                            continue
                        }
                        fs.copyFileSync(beforePath, afterPath)
                        // Delete the before file
                        fs.unlinkSync(beforePath)
                        movedCount++
                        this.logging.log(`ATX: Moved file: ${mapping.before} -> ${mapping.after}`)
                    }
                } catch (e) {
                    this.logging.error(`ATX: Failed to move file ${mapping.before} -> ${mapping.after}: ${String(e)}`)
                }
            }

            this.logging.log(
                `ATX: applyChanges completed - Added: ${addedCount}, Removed: ${removedCount}, Updated: ${updatedCount}, Moved: ${movedCount}, Preserved (conflicts): ${conflictedFiles.length}`
            )
            return {
                success: true,
                filesAdded: addedCount,
                filesRemoved: removedCount,
                filesUpdated: updatedCount,
                filesMoved: movedCount,
                addedFiles: successfullyAddedFiles,
                ...(conflictedFiles.length > 0 ? { conflictedFiles } : {}),
            }
        } catch (error) {
            this.logging.error(`ATX: applyChanges error: ${String(error)}`)
            return { success: false, error: String(error) }
        }
    }

    /**
     * Decide whether a destination file is a customer edit that must be preserved instead
     * of overwritten by the transform's version, and if so, back it up and record it.
     *
     * Returns ``true`` when the caller must SKIP its write (and, for a move, its unlink):
     * the customer's working file is left untouched and the transform's version stays in
     * the checkpoint ``after/`` dir, so neither side's content is lost. Returns ``false``
     * (let the write proceed) when there is no protection set, the destination does not yet
     * exist, the customer did not edit it since the last apply, or the incoming bytes are
     * identical (a benign agent re-emit — see ``filesEqual``, which keeps the per-job
     * watermark from flagging the agent's own re-writes as conflicts).
     */
    private shouldPreserveUserFile(
        destPath: string,
        sourcePath: string,
        userModifiedFiles: Set<string>,
        conflictedFiles: string[],
        solutionRootPath: string,
        jobId: string
    ): boolean {
        if (userModifiedFiles.size === 0) {
            return false
        }
        if (!fs.existsSync(destPath)) {
            return false
        }
        if (!userModifiedFiles.has(path.resolve(destPath))) {
            return false
        }
        if (this.filesEqual(sourcePath, destPath)) {
            return false
        }
        try {
            const backupPath = this.backupConflictedFile(destPath, jobId, solutionRootPath)
            this.logging.log(
                `ATX: Preserved customer-modified file (transform version kept in checkpoint), backed up to ${backupPath}: ${destPath}`
            )
        } catch (e) {
            // A failed backup must not cause us to fall through and overwrite the edit;
            // preserving the customer's file is the priority, the backup is a convenience.
            this.logging.error(`ATX: Failed to back up conflicted file ${destPath}: ${String(e)}`)
        }
        conflictedFiles.push(path.resolve(destPath))
        return true
    }

    /** Byte-compare two files; treats a read failure as "not equal" (conservative). */
    private filesEqual(a: string, b: string): boolean {
        try {
            const sa = fs.statSync(a)
            const sb = fs.statSync(b)
            if (sa.size !== sb.size) {
                return false
            }
            return fs.readFileSync(a).equals(fs.readFileSync(b))
        } catch {
            return false
        }
    }

    /**
     * Copy a conflicted destination file into the per-job checkpoints tree so the customer
     * can recover it. The location is deliberately UNDER ``{workspaceFolderName}/{jobId}/
     * checkpoints/`` — the manifest's ``sourceFiles`` only ever lists solution source paths,
     * never anything under that dir, so a backup here cannot be re-detected as a customer
     * edit and round-tripped back up on the next sync. Returns the backup path.
     */
    private backupConflictedFile(destPath: string, jobId: string, solutionRootPath: string): string {
        const backupRoot = path.join(solutionRootPath, workspaceFolderName, jobId, 'checkpoints', 'conflict-backups')
        const relForBackup = path.relative(solutionRootPath, destPath)
        const backupPath = path.join(backupRoot, relForBackup)
        fs.mkdirSync(path.dirname(backupPath), { recursive: true })
        fs.copyFileSync(destPath, backupPath)
        return backupPath
    }

    /**
     * Send chat message to Transform service
     */
    async sendMessage(request: {
        workspaceId: string
        jobId?: string
        text: string
        skipPolling?: boolean
    }): Promise<any> {
        try {
            this.logging.log(`ATX: Sending chat message for workspace: ${request.workspaceId}`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                throw new Error('ATX FES client not initialized')
            }

            const command = new SendMessageCommand({
                text: request.text,
                idempotencyToken: uuidv4(),
                metadata: {
                    resourcesOnScreen: {
                        workspace: {
                            workspaceId: request.workspaceId,
                            ...(request.jobId ? { jobs: [{ jobId: request.jobId, focusState: 'ACTIVE' }] } : {}),
                        },
                    },
                },
            })

            await this.addAuthToCommand(command)
            const sendResult = (await this.atxClient!.send(command)) as any
            const sentMessageId = sendResult?.message?.messageId

            if (!sentMessageId || request.skipPolling) {
                return { success: true, data: sendResult }
            }

            // Poll for response until the configured attempt ceiling (default 180 x 5s
            // = 15 minutes). Uses Utils.sleep for consistency with the other poll loops
            // in this file, and the cadence fields so tests stay deterministic.
            for (let attempt = 0; attempt < this._chatPollMaxAttempts; attempt++) {
                await Utils.sleep(this._chatPollIntervalMs)

                const listResult = await this.listMessages({
                    workspaceId: request.workspaceId,
                    jobId: request.jobId,
                    maxResults: 10,
                })

                const messageIds = listResult?.messageIds ?? []
                if (!messageIds.length) continue

                const batchResult = await this.batchGetMessages({
                    workspaceId: request.workspaceId,
                    messageIds,
                })

                const responses = (batchResult?.messages ?? []).filter(
                    (m: any) => m.parentMessageId === sentMessageId && m.messageOrigin === 'SYSTEM'
                )

                const finalResponse = responses.find((m: any) => m.processingInfo?.messageType === 'FINAL_RESPONSE')

                if (finalResponse) {
                    return {
                        success: true,
                        data: {
                            sentMessage: sendResult.message,
                            response: {
                                messageId: finalResponse.messageId,
                                text: finalResponse.text,
                                messageType: 'FINAL_RESPONSE',
                                interactions: finalResponse.interactions,
                                createdAt: finalResponse.createdAt,
                            },
                        },
                    }
                }
            }

            return {
                success: true,
                data: {
                    sentMessage: sendResult.message,
                    response: null,
                    note: 'No final response within 15 minutes. Use listMessages + batchGetMessages to check later.',
                },
            }
        } catch (error) {
            this.logging.error(`ATX: SendMessage error: ${String(error)}`)
            throw error
        }
    }

    /**
     * List chat messages
     */
    async listMessages(request: {
        workspaceId: string
        jobId?: string
        maxResults?: number
        nextToken?: string
        startTimestamp?: Date
    }): Promise<any> {
        try {
            this.logging.log(`ATX: Listing messages for workspace: ${request.workspaceId}`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                throw new Error('ATX FES client not initialized')
            }

            const workspace: any = { workspaceId: request.workspaceId }
            if (request.jobId) {
                workspace.jobs = [{ jobId: request.jobId, focusState: 'ACTIVE' }]
            }

            const command = new ListMessagesCommand({
                metadata: { resourcesOnScreen: { workspace } },
                ...(request.maxResults && { maxResults: request.maxResults }),
                ...(request.nextToken && { nextToken: request.nextToken }),
                ...(request.startTimestamp && { startTimestamp: request.startTimestamp }),
            })

            await this.addAuthToCommand(command)
            const result = await this.atxClient!.send(command)

            this.logging.log(`ATX: ListMessages completed - Found ${result.messageIds?.length || 0} messages`)
            return result
        } catch (error) {
            this.logging.error(`ATX: ListMessages error: ${String(error)}`)
            throw error
        }
    }

    /**
     * Batch get messages by IDs
     */
    async batchGetMessages(request: { workspaceId: string; messageIds: string[] }): Promise<any> {
        try {
            this.logging.log(`ATX: Batch getting ${request.messageIds.length} messages`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                throw new Error('ATX FES client not initialized')
            }

            const command = new BatchGetMessageCommand({
                messageIds: request.messageIds,
                workspaceId: request.workspaceId,
            })

            await this.addAuthToCommand(command)
            const result = await this.atxClient!.send(command)

            this.logging.log(`ATX: BatchGetMessages completed`)
            return result
        } catch (error) {
            this.logging.error(`ATX: BatchGetMessages error: ${String(error)}`)
            throw error
        }
    }

    async listArtifactsForDownload(workspaceId: string, jobId: string): Promise<{ Artifacts: any[]; Error?: string }> {
        try {
            const artifacts = await this.listArtifacts(workspaceId, jobId)
            if (!artifacts) {
                return { Artifacts: [], Error: 'Failed to list artifacts' }
            }

            this.logging.log(
                `ATX: listArtifactsForDownload raw artifacts: ${JSON.stringify(artifacts.map((a: any) => ({ id: a.artifactId, path: a.fileMetadata?.path, category: a.categoryType })))}`
            )
            const mapped = artifacts
                .filter((a: any) => a.fileMetadata?.path)
                .map((a: any) => ({
                    ArtifactId: a.artifactId,
                    Name: a.fileMetadata.path,
                    Description: a.fileMetadata.description || '',
                    SizeInBytes: a.sizeInBytes || 0,
                    CreatedTimestamp: a.artifactCreatedTimestamp || 0,
                }))
            return { Artifacts: mapped }
        } catch (error) {
            this.logging.error(`ATX: listArtifactsForDownload error: ${error}`)
            return { Artifacts: [], Error: String(error) }
        }
    }

    async downloadArtifactToPath(
        workspaceId: string,
        jobId: string,
        artifactId: string,
        savePath: string,
        artifactName?: string
    ): Promise<{ Success: boolean; FilePath?: string; Error?: string }> {
        try {
            const downloadInfo = await this.createArtifactDownloadUrl(workspaceId, jobId, artifactId)
            if (!downloadInfo) {
                return { Success: false, Error: 'Failed to get download URL' }
            }

            const response = await got.get(downloadInfo.s3PresignedUrl, {
                headers: downloadInfo.requestHeaders || {},
                responseType: 'buffer',
                timeout: { request: 30000 },
            })

            await Utils.directoryExists(savePath)
            const fileName = artifactName ? path.basename(artifactName) : 'artifact.zip'
            const filePath = path.join(savePath, fileName)
            fs.writeFileSync(filePath, Buffer.from(response.body))

            return { Success: true, FilePath: savePath }
        } catch (error) {
            return { Success: false, Error: String(error) }
        }
    }

    /**
     * Get job dashboard data — fetches dashboard HITL task, downloads artifact, parses repo/branch info
     */
    async getJobDashboard(workspaceId: string, jobId: string): Promise<AtxGetJobDashboardResponse | null> {
        try {
            this.logging.log(`getJobDashboard START - job: ${jobId}, workspace: ${workspaceId}`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                throw new Error('ATX client not initialized')
            }

            // Step 1: List DASHBOARD HITL tasks
            this.logging.log(`Step 1: ListHitlTasks taskType=DASHBOARD`)
            const command = new ListHitlTasksCommand({
                workspaceId,
                jobId,
                taskType: 'DASHBOARD',
            })
            await this.addAuthToCommand(command)
            const hitlResult = await this.atxClient!.send(command)
            this.logging.log(`Step 1: Found ${hitlResult.hitlTasks?.length || 0} DASHBOARD tasks`)

            const dashboardTask = hitlResult.hitlTasks?.[0]
            if (!dashboardTask?.agentArtifact?.artifactId) {
                this.logging.error(`No artifact. Task: ${JSON.stringify(dashboardTask)}`)
                return null
            }
            this.logging.log(`Step 1: artifactId=${dashboardTask.agentArtifact.artifactId}`)

            // Step 2: Download artifact
            this.logging.log(`Step 2: Getting download URL`)
            const downloadInfo = await this.createArtifactDownloadUrl(
                workspaceId,
                jobId,
                dashboardTask.agentArtifact.artifactId
            )
            if (!downloadInfo) {
                throw new Error('Failed to get dashboard artifact download URL')
            }

            this.logging.log(`Step 2: Downloading...`)
            const response = await got(downloadInfo.s3PresignedUrl, {
                headers: downloadInfo.requestHeaders,
                responseType: 'buffer',
            })

            // Step 3: Parse
            this.logging.log(`Step 3: Downloaded ${response.body.length} bytes`)
            this.logging.log(`Step 3: First 300 chars: ${response.body.toString('utf8').substring(0, 300)}`)

            let dashboardData: any = null
            try {
                dashboardData = JSON.parse(response.body.toString('utf8'))
                this.logging.log(`Step 3: Parsed as raw JSON OK`)
            } catch (jsonErr) {
                this.logging.log(`Step 3: JSON parse failed: ${jsonErr}, trying zip`)
                const zip = new AdmZip(response.body)
                for (const entry of zip.getEntries()) {
                    this.logging.log(`Step 3: Zip entry: ${entry.entryName}`)
                    if (entry.entryName.endsWith('.json') || entry.entryName.includes('dashboard')) {
                        dashboardData = JSON.parse(entry.getData().toString('utf8'))
                        break
                    }
                }
            }

            if (!dashboardData) {
                throw new Error('Could not parse dashboard artifact')
            }

            this.logging.log(`Step 3: Keys: ${Object.keys(dashboardData).join(', ')}`)
            this.logging.log(
                `Step 3: previousDashboards: ${JSON.stringify(dashboardData.previousDashboards)?.substring(0, 500)}`
            )

            // Step 4: Extract repos
            const projectDetail = dashboardData.projectDetail || {}
            const resources = dashboardData.resources || []
            this.logging.log(
                `Step 4: targetBranch=${projectDetail.targetBranch}, targetVersion=${projectDetail.targetVersion}, resources=${resources.length}`
            )

            const repos: AtxDashboardRepo[] = resources.map((r: any, i: number) => {
                this.logging.log(
                    `Step 4: repo[${i}] name=${r.repositoryName} url=${r.repositoryLocation?.url} status=${r.status} loc=${r.totalLoc}`
                )

                // Get solution paths from solutionSummaryFailureReasons keys, or project names as fallback
                let solutions: string[] = []
                if (r.solutionSummaryFailureReasons && Object.keys(r.solutionSummaryFailureReasons).length > 0) {
                    solutions = Object.keys(r.solutionSummaryFailureReasons)
                } else if (r.projects && r.projects.length > 0) {
                    // Extract unique project names
                    solutions = r.projects.map((p: any) => p.name || '').filter((n: string) => n)
                }
                this.logging.log(`Step 4: repo[${i}] solutions=${solutions.join(', ')}`)

                return {
                    repositoryName: r.repositoryName || '',
                    cloneUrl: r.repositoryLocation?.url || '',
                    targetBranch: projectDetail.targetBranch || '',
                    sourceBranch: r.sourceBranch || '',
                    status: r.status || '',
                    totalLoc: r.totalLoc,
                    totalProjects: r.totalProjects,
                    solutions,
                }
            })

            // Get report artifact IDs
            const reportArtifactId = dashboardData.jobTransformationSummaryArtifact || ''
            this.logging.log(`Step 4: reportArtifactId=${reportArtifactId}`)

            // Step 5: Get assessment report artifact IDs from DotnetCrossRepoSelector HITL
            let jobAssessmentReportArtifactId = ''
            const repoAssessmentMap: Record<string, string> = {} // repoName -> artifactId
            try {
                const normalHitlCmd = new ListHitlTasksCommand({ workspaceId, jobId, taskType: 'NORMAL' })
                await this.addAuthToCommand(normalHitlCmd)
                const normalHitlResult = await this.atxClient!.send(normalHitlCmd)
                const tasks = normalHitlResult.hitlTasks || []
                this.logging.log(`Step 5: ${tasks.length} NORMAL HITL tasks`)

                const selectorTask = tasks.find(t => t.uxComponentId === 'DotnetCrossRepoSelector')
                if (selectorTask?.agentArtifact?.artifactId) {
                    this.logging.log(
                        `Step 5: Downloading DotnetCrossRepoSelector artifact: ${selectorTask.agentArtifact.artifactId}`
                    )
                    const dlInfo = await this.createArtifactDownloadUrl(
                        workspaceId,
                        jobId,
                        selectorTask.agentArtifact.artifactId
                    )
                    if (dlInfo) {
                        const resp = await got(dlInfo.s3PresignedUrl, {
                            headers: dlInfo.requestHeaders,
                            responseType: 'text',
                        })
                        const selectorProps = JSON.parse(typeof resp.body === 'string' ? resp.body : String(resp.body))

                        // Job-level assessment report
                        const jobReports = selectorProps.properties?.jobAssessmentReports || []
                        jobAssessmentReportArtifactId = jobReports[0]?.artifactId || ''
                        this.logging.log(`Step 5: jobAssessmentReportArtifactId=${jobAssessmentReportArtifactId}`)

                        // Per-repo assessment reports
                        const discoveredResources = selectorProps.properties?.discoveredResources || []
                        for (const r of discoveredResources) {
                            const repoReports = r.repoAssessmentReports || []
                            if (repoReports.length > 0 && r.name) {
                                repoAssessmentMap[r.name] = repoReports[0].artifactId
                                this.logging.log(
                                    `Step 5: repo ${r.name} assessmentArtifactId=${repoReports[0].artifactId}`
                                )
                            }
                        }
                    }
                } else {
                    this.logging.log(`Step 5: DotnetCrossRepoSelector task not found`)
                }
            } catch (e) {
                this.logging.log(`Step 5: Failed to get assessment reports: ${e}`)
            }

            // Attach assessment + transformation report artifact IDs to repos
            // repoTransformationSummaryArtifacts is an array of {repoName: artifactId} objects
            const repoTransformationArtifactsRaw = dashboardData.repoTransformationSummaryArtifacts || []
            const repoTransformationMap: Record<string, string> = {}
            if (Array.isArray(repoTransformationArtifactsRaw)) {
                for (const entry of repoTransformationArtifactsRaw) {
                    for (const [name, id] of Object.entries(entry)) {
                        repoTransformationMap[name] = id as string
                    }
                }
            }
            this.logging.log(`Step 5: repoTransformationMap keys: ${Object.keys(repoTransformationMap).join(', ')}`)
            for (const repo of repos) {
                repo.assessmentReportArtifactId = repoAssessmentMap[repo.repositoryName] || ''
                repo.transformationReportArtifactId = repoTransformationMap[repo.repositoryName] || ''
                this.logging.log(
                    `Step 5: repo ${repo.repositoryName} assessment=${repo.assessmentReportArtifactId} transformation=${repo.transformationReportArtifactId}`
                )
            }

            this.logging.log(`getJobDashboard DONE - ${repos.length} repos`)
            return {
                targetBranch: projectDetail.targetBranch,
                targetVersion: projectDetail.targetVersion,
                repos,
                reportArtifactId,
                jobAssessmentReportArtifactId,
            }
        } catch (error) {
            this.logging.error(`getJobDashboard ERROR: ${String(error)}`)
            return null
        }
    }

    /**
     * Find and download the assessment report XLSX for a completed job
     */
    async getJobReport(
        workspaceId: string,
        jobId: string,
        artifactId: string
    ): Promise<{ reportBase64: string; fileName: string } | null> {
        try {
            this.logging.log(`getJobReport START - job: ${jobId}, artifact: ${artifactId}`)

            if (!this.atxClient && !(await this.initializeAtxClient())) {
                throw new Error('ATX client not initialized')
            }

            if (!artifactId) throw new Error('ArtifactId is required')

            const reportDl = await this.createArtifactDownloadUrl(workspaceId, jobId, artifactId)
            if (!reportDl) throw new Error('Failed to get report download URL')
            const reportResp = await got(reportDl.s3PresignedUrl, {
                headers: reportDl.requestHeaders,
                responseType: 'buffer',
            })
            this.logging.log(`getJobReport DONE - ${reportResp.body.length} bytes`)

            return {
                reportBase64: reportResp.body.toString('base64'),
                fileName: `report_${jobId.substring(0, 8)}_${artifactId.substring(0, 8)}.xlsx`,
            }
        } catch (error) {
            this.logging.error(`getJobReport ERROR: ${String(error)}`)
            return null
        }
    }
}
