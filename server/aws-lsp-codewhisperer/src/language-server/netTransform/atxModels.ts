import { ExecuteCommandParams } from 'vscode-languageserver'
import { PlanStepStatus } from '@amazon/elastic-gumby-frontend-client'

// Re-export for convenience
export { PlanStepStatus }

/**
 * Represents a step in an ATX transformation plan tree structure.
 * Matches C# AtxPlanStep class.
 */
export interface AtxPlanStep {
    StepId: string
    ParentStepId: string | null
    StepName: string
    Description: string
    Status: PlanStepStatus
    Children: AtxPlanStep[]
    HasCheckpoint?: boolean
    IsStatusOnly?: boolean
}

/**
 * Tree structure for transformation plan.
 * Matches C# AtxTransformationPlan class.
 */
export interface AtxTransformationPlan {
    Root: AtxPlanStep
}

/**
 * Creates an empty root node for the transformation plan tree.
 */
export function createEmptyRootNode(): AtxPlanStep {
    return {
        StepId: 'root',
        ParentStepId: null,
        StepName: 'Root',
        Description: '',
        Status: 'NOT_STARTED',
        Children: [],
    }
}

// ATX Workspace Models
export interface AtxWorkspaceInfo {
    Id: string
    Name: string
    Description?: string
    CreatedDate?: string
}

export interface AtxCreatedWorkspaceInfo {
    WorkspaceId: string
    WorkspaceName: string
}

// ATX Transformation Job
export interface AtxTransformationJob {
    WorkspaceId: string
    JobId: string
    Status: string
    FailureReason?: string
}

// ATX Consolidated API Request/Response Models
export interface AtxListOrCreateWorkspaceRequest extends ExecuteCommandParams {
    CreateWorkspaceName?: string // Optional - if provided, creates new workspace
    CreateWorkspaceDescription?: string // Optional - description for new workspace
}

export interface AtxListOrCreateWorkspaceResponse {
    AvailableWorkspaces: AtxWorkspaceInfo[]
    CreatedWorkspace?: AtxCreatedWorkspaceInfo
}

/**
 * Defines the interactive mode for transformation operations.
 * Matches C# InteractiveMode enum.
 */
export type InteractiveMode = 'Autonomous' | 'Interactive'
// ATX List Jobs Request/Response
export interface AtxListJobsRequest extends ExecuteCommandParams {
    WorkspaceId: string
}

export interface AtxListJobsResponse {
    Jobs: AtxJobInfo[]
}

export interface AtxJobInfo {
    JobId: string
    JobName?: string
    Status: string
    CreationTime?: string
    StartExecutionTime?: string
    EndExecutionTime?: string
    ClientSource?: string
}

// ATX Start Transform request/response (orchestration)
export interface AtxStartTransformRequest extends ExecuteCommandParams {
    WorkspaceId: string
    JobName?: string
    InteractiveMode?: InteractiveMode
    StartTransformRequest: object // Original RTS-style request for ZIP creation
    useOrchestratorAgent?: boolean
}

export interface AtxStartTransformResponse {
    TransformationJobId: string
    ArtifactPath: string
    UploadId: string
}

// ATX Get Transform Info request/response (orchestration)
export interface AtxGetTransformInfoRequest extends ExecuteCommandParams {
    TransformationJobId: string
    WorkspaceId: string
    SolutionRootPath: string
    GetCheckpoints?: boolean
    useOrchestratorAgent?: boolean
    // Beam-to-IDE: when true, this job was beamed to the IDE and its source is
    // ALREADY the transformed output. The prior transform job's per-step
    // checkpoint diffs must NOT be re-applied (they're baked into the beamed
    // source, and their checkpoint folders aren't in the beam bundle) — doing so
    // produces "Checkpoint folder not available for step" + DiffApplyFailed and
    // stalls the LBV loop. When set, getTransformInfo skips the completed-step
    // artifact download/apply pass and only surfaces NEW LBV-round diffs.
    IsBeam?: boolean
    // Beam-to-IDE: comma-separated plan-step ids of the LOADED beamed repo's subtree. Used to
    // select THIS repo's local-build-verification HITL instead of the first LBV HITL in the list
    // (which may be a sibling's, shadowing the loaded repo's own). Empty/absent = first-match.
    beamScopeStepIds?: string
}

export interface AtxGetTransformInfoResponse {
    TransformationJob: AtxTransformationJob
    PlanPath?: string | null
    ReportPath?: string | null
    WorklogPath?: string | null
    TransformationPlan?: AtxTransformationPlan | null
    ArtifactPath?: string | null
    ErrorString?: string | null
    StepInformation?: AtxStepInformation | null
    HitlTag?: string | null
    HitlTaskId?: string | null
    MissingPackageJsonPath?: string | null
    DiffApplyFailed?: boolean
    DiffApplyFailedStepIds?: string[]
    // Interactive mode as resolved from the backend job objective (interactive_mode).
    // Surfaced so the IDE can restore the correct mode instead of relying on its local
    // settings store, which may be missing/stale (e.g. cold restart on another machine).
    InteractiveMode?: InteractiveMode
    // ITGen (ATX_ITGEN_ENABLED only): every HITL open this poll, so a test-run HITL can't be
    // hidden behind the one HitlTag/HitlTaskId picks. Absent when the poll didn't list HITLs.
    OpenHitls?: AtxOpenHitl[]
}

/**
 * One open HITL task (contract v0 §3). Matches C# AtxOpenHitl class.
 */
export interface AtxOpenHitl {
    TaskId: string
    Tag?: string
    // The plan step the task belongs to (for ITGen: the test project's step)
    StepId?: string
    ExpiryTimestampUTC?: string
    // integ-app-launch / integ-test-run only: absolute path of the downloaded request.json
    // (artifactWorkspace/<job>/hitl/<taskId>/request.json). Absent when the request is missing,
    // can't be downloaded, or is rejected (RequestError says why).
    RequestPath?: string
    RequestError?: string
    // integ-test-run only: absolute path of the extracted repo artifact holding the generated test
    // projects (artifactWorkspace/<job>/itgen/<runId>/tests); the request's tests.projectPath is
    // relative to it. Downloaded again for every test-run task.
    TestsPath?: string
}

/**
 * Information about a step during execution phase HITL.
 */
export interface AtxStepInformation {
    StepId: string
    DiffArtifactPath: string
    RetryInstruction?: string
    IsInvalid?: boolean
    InvalidInstruction?: string
    InvalidReason?: string
    ExpiryTimestampUTC?: string
}

// ATX Stop Job request
export interface AtxStopJobRequest extends ExecuteCommandParams {
    WorkspaceId: string
    JobId: string
}
export interface AtxUploadPlanRequest extends ExecuteCommandParams {
    TransformationJobId: string
    WorkspaceId: string
    PlanPath: string
    useOrchestratorAgent?: boolean
}

export interface AtxUploadPlanResponse {
    VerificationStatus: boolean
    Message: string
    PlanPath?: string
    ReportPath?: string
}

// ATX Set Checkpoints request/response (interactive mode)
export interface AtxSetCheckpointsRequest extends ExecuteCommandParams {
    TransformationJobId: string
    WorkspaceId: string
    SolutionRootPath: string
    Checkpoints: Record<string, boolean>
    InteractiveMode?: InteractiveMode
}

export interface AtxSetCheckpointsResponse {
    Success: boolean
    Error?: string
}

// ATX Update Workspace request/response
export interface AtxUpdateWorkspaceRequest extends ExecuteCommandParams {
    TransformationJobId: string
    WorkspaceId: string
    SolutionRootPath: string
    StepId: string
}

export interface AtxUpdateWorkspaceResponse {
    Success: boolean
    Error?: string | null
}

// Metadata JSON structure for checkpoint changes (used by applyChanges helper)
export interface AtxCheckpointMetadata {
    filesAdded: string[]
    filesRemoved: string[]
    filesUpdated: string[]
    filesMoved: string[]
    movedFilesMap: AtxMovedFileMapping[]
}

export interface AtxMovedFileMapping {
    before: string
    after: string
}
export interface AtxUploadPackagesRequest extends ExecuteCommandParams {
    TransformationJobId: string
    WorkspaceId: string
    PackagesZipPath?: string | null
}

export interface AtxUploadPackagesResponse {
    Success: boolean
    Message?: string
}

// ATX List Artifacts request/response
export interface AtxListArtifactsRequest extends ExecuteCommandParams {
    WorkspaceId: string
    TransformationJobId: string
}

export interface AtxArtifactInfo {
    ArtifactId: string
    Name: string
    Description: string
    SizeInBytes: number
    CreatedTimestamp: number
}

export interface AtxListArtifactsResponse {
    Artifacts: AtxArtifactInfo[]
    Error?: string
}

// ATX Download Artifact request/response
export interface AtxDownloadArtifactRequest extends ExecuteCommandParams {
    WorkspaceId: string
    TransformationJobId: string
    ArtifactId: string
    ArtifactName?: string
    SavePath: string
}

export interface AtxDownloadArtifactResponse {
    Success: boolean
    FilePath?: string
    Error?: string
}

// ATX Complete Local Build HITL request/response
export interface AtxCompleteLocalBuildHitlRequest extends ExecuteCommandParams {
    WorkspaceId: string
    TransformationJobId: string
    TaskId: string
    BuildResultJson: string
    SolutionRootPath: string
}

/**
 * Completes an integ-test-run HITL (contract v0 §5: summary.json, plus trx/<project>/<runId>.trx
 * or build-errors.json) or an integ-app-launch HITL (§6: launch-result.json, plus the startup
 * log): uploads the result ZIP and submits the task by ID.
 * ResultZipPath may be absolute or relative to SolutionRootPath.
 */
export interface AtxCompleteHitlWithTestResultsRequest extends ExecuteCommandParams {
    WorkspaceId: string
    TransformationJobId: string
    TaskId: string
    ResultZipPath: string
    SolutionRootPath: string
}

export interface AtxCompleteLocalBuildHitlResponse {
    Success: boolean
    Error?: string
}

// ATX Get Job Dashboard request/response
export interface AtxGetJobDashboardRequest extends ExecuteCommandParams {
    WorkspaceId: string
    JobId: string
}

export interface AtxDashboardRepo {
    repositoryName: string
    cloneUrl: string
    targetBranch: string
    sourceBranch?: string
    status?: string
    totalLoc?: number
    totalProjects?: number
    solutions?: string[]
    assessmentReportArtifactId?: string
    transformationReportArtifactId?: string
}

export interface AtxGetJobDashboardResponse {
    targetBranch?: string
    targetVersion?: string
    repos: AtxDashboardRepo[]
    reportArtifactId?: string
    jobAssessmentReportArtifactId?: string
}

// ATX Get Job Report request/response
export interface AtxGetJobReportRequest extends ExecuteCommandParams {
    WorkspaceId: string
    JobId: string
    ArtifactId: string
}

export interface AtxGetJobReportResponse {
    reportBase64: string
    fileName: string
}

// ATX Upload Custom Plan request/response
export interface AtxUploadCustomPlanRequest extends ExecuteCommandParams {
    WorkspaceId: string
    TransformationJobId: string
    FilePath: string
    ArtifactStorePath?: string
    Description?: string
}

export interface AtxUploadCustomPlanResponse {
    Success: boolean
    ArtifactId?: string
    Error?: string
}

// ATX Load Older Worklogs request
export interface AtxLoadOlderWorklogsRequest extends ExecuteCommandParams {
    workspaceId: string
    jobId: string
    solutionRootPath: string
    nextToken?: string
}

// ITGen test-run HITL payloads (ITGen–IDE contract v0, schema 1.1). Draft: names follow the v0
// proposal and match C# AtxTestRunRequest / AtxTestRunSummary / AtxAppLaunchRequest /
// AtxAppLaunchResult in the VS extension.

// 1.1 (10/26) added launch-result launchedBy and dropped NOT_LOCALHOST; 1.0 payloads are still accepted
export const ATX_TEST_RUN_SCHEMA_VERSION = '1.1'
export const ATX_TEST_RUN_BASE_URL_ENV = 'AB_BASE_URL'

export type AtxTestRunSide = 'original' | 'transformed'

// NOT_LOCALHOST was removed in 1.1: published URLs are allowed on the original side
export type AtxTestRunStatus = 'COMPLETED' | 'TEST_BUILD_FAILED' | 'TIMED_OUT'

/**
 * Request from the Transform agent to run one test project (request.json of an integ-test-run HITL)
 * against the app the IDE started for the preceding integ-app-launch. Only what the IDE can't work
 * out itself is sent: the IDE sets ATX_TEST_RUN_BASE_URL_ENV, AB_SIDE and AB_RUN_ID for the test
 * process, and the language server picks the download folder.
 * Matches C# AtxTestRunRequest class.
 */
export interface AtxTestRunRequest {
    schemaVersion: string
    // Names the TRX file (trx/<project>/<runId>.trx) and is echoed in the summary
    runId: string
    // Also says where the app runs from: original = the copy of the original solution the IDE takes
    // at job start (artifactWorkspace/before/), transformed = the customer's solution
    side: AtxTestRunSide
    project: string
    // The repo artifact the agent rewrites, holding the generated test projects: one per repo,
    // rewritten under the same id, so download it again for every request
    artifactId: string
    // projectPath is inside the artifact, relative to the repo root
    tests: {
        projectPath: string
    }
    limits: {
        projectTimeoutSeconds: number
    }
}

/**
 * App to start for an app-launch request. The IDE picks the host from the project type and a free
 * localhost port. Matches C# AtxAppLaunchApp class.
 */
export interface AtxAppLaunchApp {
    webProject: string
    // Default ['/']: connection refused or HTTP 5xx means not started
    healthCheckPaths?: string[]
    // Default 120
    startTimeoutSeconds?: number
}

export type AtxAppLaunchStatus = 'STARTED' | 'APP_NOT_STARTED'

// Who started the app: the IDE, or the customer (who started it themselves or gave a URL)
export type AtxAppLaunchedBy = 'ide' | 'customer'

/**
 * Request from the Transform agent to start one web project (request.json of an integ-app-launch HITL),
 * one per launch attempt. Contract v0 defines only the result, so this shape is a proposal. Like LBV's
 * rounds, the number of attempts is the agent's decision, so there's no limit field.
 * Matches C# AtxAppLaunchRequest class.
 */
export interface AtxAppLaunchRequest {
    schemaVersion: string
    side: AtxTestRunSide
    project: string
    attempt: number
    app: AtxAppLaunchApp
}

/**
 * Result of one launch attempt (launch-result.json), with the startup log uploaded as logFile.
 * Matches C# AtxAppLaunchResult class.
 */
export interface AtxAppLaunchResult {
    schemaVersion: string
    side: AtxTestRunSide
    project: string
    attempt: number
    status: AtxAppLaunchStatus
    // Since 1.1; absent means ide. For customer, appUrl is the URL the customer gave: localhost or
    // published on the original side, localhost only on the transformed side
    launchedBy?: AtxAppLaunchedBy
    appUrl?: string
    // The last health check; httpStatus is absent when the app didn't answer
    healthCheck?: {
        path: string
        httpStatus?: number
    }
    error?: string
    logFile?: string
    durationSeconds: number
}

/**
 * Result of one project run (summary.json in the result ZIP; the TRX is at trx/<project>/<runId>.trx).
 * Matches C# AtxTestRunSummary class.
 */
export interface AtxTestRunSummary {
    schemaVersion: string
    runId: string
    side: AtxTestRunSide
    project: string
    status: AtxTestRunStatus
    appUrl?: string
    startedAt?: string
    finishedAt?: string
    durationSeconds: number
    counts: {
        total: number
        passed: number
        failed: number
        pending: number
    }
    failingTests: {
        name: string
        message: string
    }[]
}

/**
 * True when a test-run payload's schemaVersion has the same major version as
 * ATX_TEST_RUN_SCHEMA_VERSION; minor versions only add optional fields.
 */
export function isSupportedAtxTestRunSchemaVersion(schemaVersion: unknown): boolean {
    if (typeof schemaVersion !== 'string') {
        return false
    }
    const match = /^(\d+)\.\d+$/.exec(schemaVersion)
    return match !== null && match[1] === ATX_TEST_RUN_SCHEMA_VERSION.split('.')[0]
}
