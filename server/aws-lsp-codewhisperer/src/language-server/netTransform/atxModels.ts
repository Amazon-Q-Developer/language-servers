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
