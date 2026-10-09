import { ExecuteCommandParams } from 'vscode-languageserver'
import { TransformationJob, TransformationPlan } from '@amzn/codewhisperer-runtime'

/**
 * Error codes for transformation job failures.
 * Additional error codes can be added here as needed for different failure scenarios.
 */
export enum TransformationErrorCode {
    NONE = 'NONE',
    QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
    UNKNOWN_ERROR = 'UNKNOWN_ERROR',
    // TODO: Add more error codes as needed for different failure scenarios
}

export interface StartTransformRequest extends ExecuteCommandParams {
    SolutionRootPath: string
    SolutionFilePath: string
    SelectedProjectPath: string
    ProgramLanguage: string
    TargetFramework: string
    SolutionConfigPaths: string[]
    ProjectMetadata: TransformProjectMetadata[]
    TransformNetStandardProjects: boolean
    EnableRazorViewTransform: boolean
    EnableWebFormsTransform: boolean
    // Customer's up-front unit-test choice, forwarded to the ATX job objective as
    // `generate_unit_tests`. Optional: absent means "no choice sent" (legacy behavior).
    GenerateUnitTests?: boolean
    PackageReferences?: PackageReferenceMetadata[]
    DmsArn?: string
    DatabaseSettings?: DatabaseSettings
    IncludeMissingPackageAnalysis?: boolean
}

export interface StartTransformResponse {
    UploadId: string | undefined
    TransformationJobId: string | undefined
    ArtifactPath: string
    Error?: string
    IsSupported?: boolean
    UnSupportedProjects?: string[]
    ContainsUnsupportedViews?: boolean
}

export interface GetTransformRequest extends ExecuteCommandParams {
    TransformationJobId: string
}

/**
 * Response for a get transformation request.
 * Contains the transformation job details and any error information.
 */
export interface GetTransformResponse {
    /**
     * The transformation job details
     */
    TransformationJob: TransformationJob

    /**
     * Error code if the transformation job failed
     */
    ErrorCode: TransformationErrorCode
}

export interface GetTransformPlanRequest extends ExecuteCommandParams {
    TransformationJobId: string
}

export interface GetTransformPlanResponse {
    TransformationPlan: TransformationPlan
}

export interface CancelTransformRequest extends ExecuteCommandParams {
    TransformationJobId: string
}

export interface DownloadArtifactsRequest extends ExecuteCommandParams {
    TransformationJobId: string
    SolutionRootPath: string
}

export enum CancellationJobStatus {
    NOT_STARTED,
    IN_PROGRESS,
    SUCCESSFULLY_CANCELLED,
    FAILED_TO_CANCEL,
    TIMED_OUT,
}

// status specific to pollTransformation
export enum PollTransformationStatus {
    TIMEOUT = 'TIMEOUT',
    NOT_FOUND = 'NOT_FOUND',
    FAILED = 'FAILED',
}

export interface CancelTransformResponse {
    TransformationJobStatus: CancellationJobStatus
}

export interface DownloadArtifactsResponse {
    PathTosave: string
    Error: string
}

export interface RequirementJson {
    EntryPath: string
    SolutionPath: string
    Projects: Project[]
    TransformNetStandardProjects: boolean
    EnableRazorViewTransform: boolean
    EnableWebFormsTransform: boolean
}

export interface TransformationPreferences {
    Transformations: TransformationSettings
    Metadata: TransformationMetadata
}

export interface TransformationSettings {
    DatabaseModernization?: DatabaseModernizationTransformation
}

export interface DatabaseModernizationTransformation {
    Enabled: boolean
    DmsArn?: string
    DatabaseSettings?: DatabaseSettings
}

export interface DatabaseSettings {
    Tools?: Tool[]
    Source?: DatabaseInfo
    Target?: DatabaseInfo
}

export interface Tool {
    Name?: string
    Properties?: Object
}

export interface DatabaseInfo {
    DatabaseName?: string
    DatabaseVersion?: string
}
export interface TransformationMetadata {
    GeneratedAt: string
}

export interface ExternalReference {
    ProjectPath: string
    RelativePath: string
    AssemblyFullPath: string
    IncludedInArtifact: boolean
}

export interface TransformProjectMetadata {
    Name: string
    ProjectTargetFramework: string
    ProjectPath: string
    SourceCodeFilePaths: string[]
    ProjectLanguage: string
    ProjectType: string
    ExternalReferences: ExternalReference[]
}

export interface Project {
    projectFilePath: string
    projectTarget: string
    codeFiles: CodeFile[]
    references: References[]
}

export interface CodeFile {
    contentMd5Hash: string
    relativePath: string
}

export interface References {
    includedInArtifact: boolean
    relativePath: string
    isThirdPartyPackage: boolean
    netCompatibleRelativePath?: string
    netCompatibleVersion?: string
    packageId?: string
}

export interface PackageReferenceMetadata {
    Id: string
    Versions: string[]
    IsPrivatePackage: boolean
    NetCompatiblePackageVersion?: string
    NetCompatibleAssemblyPath?: string
    NetCompatibleAssemblyRelativePath?: string
    NetCompatiblePackageFilePath?: string
    CurrentVersionAssemblyPath?: string
    SourceNupkgFilePath?: string
}
