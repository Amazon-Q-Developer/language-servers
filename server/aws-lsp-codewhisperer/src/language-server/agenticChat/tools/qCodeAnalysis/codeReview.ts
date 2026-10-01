/* eslint-disable import/no-nodejs-modules */

import { CodeWhispererServiceToken } from '../../../../shared/codeWhispererService'
import { Features } from '@aws/language-server-runtimes/server-interface/server'
import {
    CODE_REVIEW_TOOL_NAME,
    CODE_REVIEW_TOOL_DESCRIPTION,
    FULL_REVIEW,
    CODE_DIFF_REVIEW,
} from './codeReviewConstants'
import { CodeReviewUtils } from './codeReviewUtils'
import { CODE_REVIEW_INPUT_SCHEMA, Z_CODE_REVIEW_INPUT_SCHEMA, FINDINGS_SCHEMA } from './codeReviewSchemas'
import { randomUUID } from 'crypto'
import * as crypto from 'crypto'
import * as path from 'path'
import * as JSZip from 'jszip'
import * as fs from 'fs'
import { existsSync, statSync } from 'fs'
import { CancellationToken } from '@aws/language-server-runtimes/server-interface'
import { InvokeOutput } from '../toolShared'
import { CodeReviewInternalError, CodeReviewTimeoutError, CodeReviewValidationError } from './codeReviewErrors'
import {
    FileArtifacts,
    FolderArtifacts,
    RuleArtifacts,
    ValidatedArtifact,
    ValidateInputAndSetupResult,
    PrepareAndUploadArtifactsResult,
    StartCodeAnalysisResult,
    CodeReviewResult,
    CodeReviewFinding,
    FailedMetricName,
    SuccessMetricName,
} from './codeReviewTypes'
import { CancellationError, workspaceUtils } from '@aws/lsp-core'
import { Origin } from '@amzn/codewhisperer-streaming'

export class CodeReview {
    private static readonly CUSTOMER_CODE_BASE_PATH = 'customerCodeBaseFolder'
    private static readonly CODE_ARTIFACT_PATH = 'code_artifact'
    private static readonly CUSTOMER_CODE_ZIP_NAME = 'customerCode.zip'
    private static readonly CODE_DIFF_PATH = 'code_artifact/codeDiff/customerCodeDiff.diff'
    private static readonly USER_REQUIREMENT_PATH = 'code_artifact/userRequirement/userRequirement.txt'
    private static readonly RULE_ARTIFACT_PATH = '.amazonq/rules'
    private static readonly MAX_POLLING_ATTEMPTS = 90 // 90 * POLLING_INTERVAL_MS (10000) = 15 mins
    private static readonly MID_POLLING_ATTEMPTS = 20
    private static readonly POLLING_INTERVAL_MS = 10000 // 10 seconds
    private static readonly UPLOAD_INTENT = 'AGENTIC_CODE_REVIEW'
    private static readonly SCAN_SCOPE = 'AGENTIC'
    private static readonly MAX_FINDINGS_COUNT = 30

    private static readonly ERROR_MESSAGES = {
        MISSING_CLIENT: 'CodeWhisperer client not available',
        MISSING_ARTIFACTS: `Missing fileLevelArtifacts and folderLevelArtifacts for ${CODE_REVIEW_TOOL_NAME} tool. Ask user to provide a specific file / folder / workspace which has code that can be scanned.`,
        MISSING_FILES_TO_SCAN: `There are no valid files to scan in the input. Use other available tools to find the correct path to the files, otherwise ask user to provide a specific file which has code that can be scanned.`,
        UPLOAD_FAILED: `Failed to upload artifact for code review in ${CODE_REVIEW_TOOL_NAME} tool.`,
        START_CODE_ANALYSIS_FAILED: (scanName: string, errorMessage?: string) =>
            `Failed to start code analysis for scanName - ${scanName} due to - ${errorMessage}`,
        CODE_ANALYSIS_FAILED: (jobId: string, message: string) =>
            `Code analysis failed for jobId - ${jobId} due to ${message}`,
        SCAN_FAILED: 'Code scan failed',
        TIMEOUT: `Code review timed out. Ask user to provide a smaller size of code to scan.`,
        NO_WORKSPACE: `Cannot run ${CODE_REVIEW_TOOL_NAME}: no workspace folder is open. Ask the user to open the folder that contains the code to review.`,
        ARTIFACT_NOT_ABSOLUTE: (artifactPath: string) =>
            `Cannot review "${artifactPath}": provide an absolute path inside an open workspace folder.`,
        ARTIFACT_UNRESOLVABLE: (artifactPath: string) =>
            `Cannot review "${artifactPath}": it does not exist or cannot be resolved. Provide an existing path inside an open workspace folder.`,
        ARTIFACT_OUTSIDE_WORKSPACE: (artifactPath: string) =>
            `Cannot review "${artifactPath}": only paths inside an open workspace folder can be reviewed.`,
        ARTIFACT_NOT_A_FILE: (artifactPath: string) => `Cannot review "${artifactPath}": it is not a regular file.`,
        ARTIFACT_NOT_A_DIRECTORY: (artifactPath: string) => `Cannot review "${artifactPath}": it is not a directory.`,
        ARTIFACT_MULTIPLY_LINKED: (artifactPath: string) =>
            `Cannot review "${artifactPath}": it has more than one hard link, so its contents may also exist outside the workspace.`,
    }

    private readonly credentialsProvider: Features['credentialsProvider']
    private readonly logging: Features['logging']
    private readonly telemetry: Features['telemetry']
    private readonly workspace: Features['workspace']
    private codeWhispererClient?: CodeWhispererServiceToken
    private cancellationToken?: CancellationToken
    private writableStream?: WritableStream
    private toolStartTime: number = 0
    private overrideDiffScan = false

    constructor(
        features: Pick<Features, 'credentialsProvider' | 'logging' | 'telemetry' | 'workspace'> & Partial<Features>
    ) {
        this.credentialsProvider = features.credentialsProvider
        this.logging = features.logging
        this.telemetry = features.telemetry
        this.workspace = features.workspace
    }

    static readonly toolName = CODE_REVIEW_TOOL_NAME

    static readonly toolDescription = CODE_REVIEW_TOOL_DESCRIPTION

    static readonly inputSchema = CODE_REVIEW_INPUT_SCHEMA

    /**
     * Main execution method for the CodeReview tool
     * @param input User input parameters for code review
     * @param context Execution context containing clients and tokens
     * @returns Output containing code review results or error message
     */
    public async execute(input: any, context: any): Promise<InvokeOutput> {
        this.toolStartTime = Date.now()
        let chatStreamWriter: WritableStreamDefaultWriter<any> | undefined

        try {
            this.logging.info(`Executing ${CODE_REVIEW_TOOL_NAME}: ${JSON.stringify(input)}`)

            // 1. Validate input
            const setup = await this.validateInputAndSetup(input, context)
            this.checkCancellation()

            chatStreamWriter = this.writableStream?.getWriter()
            await chatStreamWriter?.write('Initiating code review...')

            // 2. Prepare code artifact and upload to service
            const uploadResult = await this.prepareAndUploadArtifacts(setup)
            this.checkCancellation()

            // 3. Start code analysis
            const analysisResult = await this.startCodeAnalysis(setup, uploadResult)
            this.checkCancellation()

            const nonRuleFiles = uploadResult.numberOfFilesInCustomerCodeZip - setup.ruleArtifacts.length
            const diffFiles = uploadResult.codeDiffFiles.size
            if (diffFiles == 0 && !setup.isFullReviewRequest) {
                setup.isFullReviewRequest = true
                this.overrideDiffScan = true
            }

            let reviewMessage: string
            if (nonRuleFiles == 1) {
                reviewMessage = setup.isFullReviewRequest
                    ? `Reviewing the code in ${path.basename(uploadResult.filePathsInZip.values().next().value as string)}...`
                    : `Reviewing uncommitted changes in ${path.basename(uploadResult.filePathsInZip.values().next().value as string)}...`
            } else {
                reviewMessage = setup.isFullReviewRequest
                    ? `Reviewing the code in ${nonRuleFiles} files...`
                    : `Reviewing uncommitted changes in ${diffFiles} of ${nonRuleFiles} files...`
            }

            await chatStreamWriter?.write(reviewMessage)

            // 4. Wait for scan to complete
            await this.pollForCompletion(analysisResult.jobId, setup, uploadResult, chatStreamWriter)
            this.checkCancellation()

            // 5. Process scan result
            const results = await this.processResults(setup, uploadResult, analysisResult.jobId)

            return {
                output: {
                    kind: 'json',
                    success: true,
                    content: results,
                },
            }
        } catch (error: any) {
            if (error instanceof CancellationError) {
                throw error
            }
            throw new Error(error.message)
        } finally {
            await chatStreamWriter?.close()
            chatStreamWriter?.releaseLock()
        }
    }

    /**
     * Validates user input and sets up the execution environment
     * @param input User input parameters for code review
     * @param context Execution context containing clients and tokens
     * @returns Setup object with validated parameters or error message
     */
    private async validateInputAndSetup(input: any, context: any): Promise<ValidateInputAndSetupResult> {
        this.cancellationToken = context.cancellationToken as CancellationToken

        this.writableStream = context.writableStream as WritableStream

        this.codeWhispererClient = context.codeWhispererClient as CodeWhispererServiceToken
        if (!this.codeWhispererClient) {
            throw new Error(CodeReview.ERROR_MESSAGES.MISSING_CLIENT)
        }

        // parse input
        const validatedInput = Z_CODE_REVIEW_INPUT_SCHEMA.parse(input)
        const userRequirement = validatedInput.userRequirement
        const fileArtifacts = validatedInput.fileLevelArtifacts || []
        const folderArtifacts = validatedInput.folderLevelArtifacts || []
        const ruleArtifacts = validatedInput.ruleArtifacts || []
        const modelId = validatedInput.modelId

        if (fileArtifacts.length === 0 && folderArtifacts.length === 0) {
            CodeReviewUtils.emitMetric(
                {
                    reason: FailedMetricName.MissingFileOrFolder,
                    result: 'Failed',
                    reasonDesc: CodeReview.ERROR_MESSAGES.MISSING_ARTIFACTS,
                    metadata: {
                        credentialStartUrl: this.credentialsProvider.getConnectionMetadata()?.sso?.startUrl,
                    },
                },
                this.logging,
                this.telemetry
            )
            throw new CodeReviewValidationError(CodeReview.ERROR_MESSAGES.MISSING_ARTIFACTS)
        }

        const isFullReviewRequest = validatedInput.scopeOfReview?.toUpperCase() === FULL_REVIEW
        const artifactType = fileArtifacts.length > 0 ? 'FILE' : 'FOLDER'
        // Setting java as default language
        // TODO: Remove requirement of programming language
        const programmingLanguage = 'java'
        const scanName = 'Standard-' + randomUUID()

        this.logging.info(
            `Agentic scan name: ${scanName} selectedModel: ${modelId} userRequirement: ${userRequirement}`
        )

        return {
            userRequirement,
            fileArtifacts,
            folderArtifacts,
            isFullReviewRequest,
            artifactType,
            programmingLanguage,
            scanName,
            ruleArtifacts,
            modelId,
        }
    }

    /**
     * Prepares and uploads code artifacts for analysis
     * @param setup Setup object with validated parameters
     * @returns Upload result with uploadId or error message
     */
    private async prepareAndUploadArtifacts(
        setup: ValidateInputAndSetupResult
    ): Promise<PrepareAndUploadArtifactsResult> {
        const {
            zipBuffer,
            md5Hash,
            isCodeDiffPresent,
            programmingLanguages,
            numberOfFilesInCustomerCodeZip,
            codeDiffFiles,
            filePathsInZip,
        } = await this.prepareFilesAndFoldersForUpload(
            setup.userRequirement,
            setup.fileArtifacts,
            setup.folderArtifacts,
            setup.ruleArtifacts,
            setup.isFullReviewRequest
        )

        const uploadUrlResponse = await this.codeWhispererClient!.createUploadUrl({
            contentLength: zipBuffer.length,
            contentMd5: md5Hash,
            uploadIntent: CodeReview.UPLOAD_INTENT,
            uploadContext: {
                codeAnalysisUploadContext: {
                    codeScanName: setup.scanName,
                },
            },
        })

        if (!uploadUrlResponse.uploadUrl || !uploadUrlResponse.uploadId) {
            CodeReviewUtils.emitMetric(
                {
                    reason: FailedMetricName.CreateUploadUrlFailed,
                    result: 'Failed',
                    reasonDesc: CodeReview.ERROR_MESSAGES.UPLOAD_FAILED,
                    metadata: {
                        artifactType: setup.artifactType,
                        codewhispererCodeScanJobId: setup.scanName,
                        codewhispererCodeScanSrcZipFileBytes: zipBuffer.length,
                        credentialStartUrl: this.credentialsProvider.getConnectionMetadata()?.sso?.startUrl,
                        programmingLanguages: programmingLanguages,
                    },
                },
                this.logging,
                this.telemetry
            )
            throw new CodeReviewValidationError(CodeReview.ERROR_MESSAGES.UPLOAD_FAILED)
        }

        await CodeReviewUtils.uploadFileToPresignedUrl(
            uploadUrlResponse.uploadUrl,
            zipBuffer,
            uploadUrlResponse.requestHeaders || {},
            this.logging
        )

        return {
            uploadId: uploadUrlResponse.uploadId,
            isCodeDiffPresent,
            artifactSize: zipBuffer.length,
            programmingLanguages: programmingLanguages,
            numberOfFilesInCustomerCodeZip,
            codeDiffFiles,
            filePathsInZip,
        }
    }

    /**
     * Initiates code analysis with the uploaded artifacts
     * @param setup Setup object with validated parameters
     * @param uploadResult Result from artifact upload containing uploadId
     * @returns Code scan jobId and status
     */
    private async startCodeAnalysis(
        setup: ValidateInputAndSetupResult,
        uploadResult: PrepareAndUploadArtifactsResult
    ): Promise<StartCodeAnalysisResult> {
        const createResponse = await this.codeWhispererClient!.startCodeAnalysis({
            artifacts: { SourceCode: uploadResult.uploadId },
            programmingLanguage: { languageName: setup.programmingLanguage },
            clientToken: CodeReviewUtils.generateClientToken(),
            codeScanName: setup.scanName,
            scope: CodeReview.SCAN_SCOPE,
            codeDiffMetadata: uploadResult.isCodeDiffPresent ? { codeDiffPath: '/code_artifact/codeDiff/' } : undefined,
            languageModelId: setup.modelId,
            clientType: Origin.IDE,
        })

        if (!createResponse.jobId) {
            CodeReviewUtils.emitMetric(
                {
                    reason: FailedMetricName.CodeScanFailed,
                    result: 'Failed',
                    reasonDesc: CodeReview.ERROR_MESSAGES.START_CODE_ANALYSIS_FAILED(
                        setup.scanName,
                        createResponse.errorMessage
                    ),
                    metadata: {
                        artifactType: setup.artifactType,
                        codewhispererCodeScanJobId: setup.scanName,
                        codewhispererCodeScanSrcZipFileBytes: uploadResult.artifactSize,
                        credentialStartUrl: this.credentialsProvider.getConnectionMetadata()?.sso?.startUrl,
                        customRules: setup.ruleArtifacts.length,
                        programmingLanguages: Array.from(uploadResult.programmingLanguages),
                        scope: setup.isFullReviewRequest ? FULL_REVIEW : CODE_DIFF_REVIEW,
                        modelId: setup.modelId,
                    },
                },
                this.logging,
                this.telemetry
            )
            throw new CodeReviewInternalError(
                CodeReview.ERROR_MESSAGES.START_CODE_ANALYSIS_FAILED(setup.scanName, createResponse.errorMessage)
            )
        }

        this.logging.info(`Code scan created with job ID: ${createResponse.jobId}`)
        return {
            jobId: createResponse.jobId,
            status: createResponse.status,
        }
    }

    /**
     * Polls for completion of the code analysis job
     * @param jobId ID of the code analysis job
     * @param scanName Name of the code scan
     * @param artifactType Type of artifact being scanned (FILE or FOLDER)
     * @param chatStreamWriter Stream writer for sending progress updates
     */
    private async pollForCompletion(
        jobId: string,
        setup: ValidateInputAndSetupResult,
        uploadResult: PrepareAndUploadArtifactsResult,
        chatStreamWriter: WritableStreamDefaultWriter<any> | undefined
    ) {
        let status: string | undefined = 'Pending'
        let attemptCount = 0

        while (status === 'Pending' && attemptCount < CodeReview.MAX_POLLING_ATTEMPTS) {
            this.logging.info(`Code scan status: ${status}, waiting...`)
            await new Promise(resolve => setTimeout(resolve, CodeReview.POLLING_INTERVAL_MS))

            const statusResponse = await this.getCodeAnalysisStatus(jobId)
            status = statusResponse.status
            attemptCount++

            if (statusResponse.errorMessage) {
                CodeReviewUtils.emitMetric(
                    {
                        reason: FailedMetricName.CodeScanFailed,
                        result: 'Failed',
                        reasonDesc: CodeReview.ERROR_MESSAGES.CODE_ANALYSIS_FAILED(jobId, statusResponse.errorMessage),
                        metadata: {
                            artifactType: setup.artifactType,
                            codewhispererCodeScanJobId: jobId,
                            codewhispererCodeScanSrcZipFileBytes: uploadResult.artifactSize,
                            credentialStartUrl: this.credentialsProvider.getConnectionMetadata()?.sso?.startUrl,
                            customRules: setup.ruleArtifacts.length,
                            programmingLanguages: Array.from(uploadResult.programmingLanguages),
                            scope: setup.isFullReviewRequest ? FULL_REVIEW : CODE_DIFF_REVIEW,
                            status: status,
                            modelId: setup.modelId,
                        },
                    },
                    this.logging,
                    this.telemetry
                )
                throw new CodeReviewInternalError(
                    CodeReview.ERROR_MESSAGES.CODE_ANALYSIS_FAILED(jobId, statusResponse.errorMessage)
                )
            }

            if (attemptCount == CodeReview.MID_POLLING_ATTEMPTS) {
                await chatStreamWriter?.write('Still reviewing your code, it is taking just a bit longer than usual...')
            }

            this.checkCancellation('Command execution cancelled while waiting for scan to complete')
        }

        if (status === 'Pending') {
            CodeReviewUtils.emitMetric(
                {
                    reason: FailedMetricName.CodeScanTimeout,
                    result: 'Failed',
                    reasonDesc: CodeReview.ERROR_MESSAGES.TIMEOUT,
                    metadata: {
                        artifactType: setup.artifactType,
                        codewhispererCodeScanJobId: jobId,
                        codewhispererCodeScanSrcZipFileBytes: uploadResult.artifactSize,
                        credentialStartUrl: this.credentialsProvider.getConnectionMetadata()?.sso?.startUrl,
                        customRules: setup.ruleArtifacts.length,
                        maxAttempts: CodeReview.MAX_POLLING_ATTEMPTS,
                        programmingLanguages: Array.from(uploadResult.programmingLanguages),
                        scope: setup.isFullReviewRequest ? FULL_REVIEW : CODE_DIFF_REVIEW,
                        status: status,
                        modelId: setup.modelId,
                    },
                },
                this.logging,
                this.telemetry
            )
            throw new CodeReviewTimeoutError(CodeReview.ERROR_MESSAGES.TIMEOUT)
        }

        this.logging.info(`Code scan completed with status: ${status}`)
    }

    /**
     * Processes the results of the completed code analysis
     * @param setup Setup object with validated parameters
     * @param isCodeDiffPresent If code diff is present in upload artifact
     * @param jobId ID of the code analysis job
     * @returns Processed results with findings grouped by file
     */
    private async processResults(
        setup: ValidateInputAndSetupResult,
        uploadResult: PrepareAndUploadArtifactsResult,
        jobId: string
    ): Promise<CodeReviewResult> {
        const { totalFindings, findingsExceededLimit } = await this.collectFindings(
            jobId,
            setup.isFullReviewRequest,
            uploadResult.isCodeDiffPresent,
            setup.programmingLanguage
        )

        CodeReviewUtils.emitMetric(
            {
                reason: SuccessMetricName.CodeScanSuccess,
                result: 'Succeeded',
                metadata: {
                    artifactType: setup.artifactType,
                    codewhispererCodeScanJobId: jobId,
                    codewhispererCodeScanSrcZipFileBytes: uploadResult.artifactSize,
                    codewhispererCodeScanTotalIssues: totalFindings.length,
                    credentialStartUrl: this.credentialsProvider.getConnectionMetadata()?.sso?.startUrl,
                    customRules: setup.ruleArtifacts.length,
                    programmingLanguages: Array.from(uploadResult.programmingLanguages),
                    scope: setup.isFullReviewRequest ? FULL_REVIEW : CODE_DIFF_REVIEW,
                    latency: Date.now() - this.toolStartTime,
                    modelId: setup.modelId,
                },
            },
            this.logging,
            this.telemetry
        )

        const aggregatedCodeScanIssueList = this.aggregateFindingsByFile(
            totalFindings,
            setup.fileArtifacts,
            setup.folderArtifacts
        )

        this.logging.info('Findings count grouped by file')
        aggregatedCodeScanIssueList.forEach(item => {
            this.logging.info(`File path - ${item.filePath} Findings count - ${item.issues.length}`)
            item.issues.forEach(issue =>
                CodeReviewUtils.emitMetric(
                    {
                        reason: SuccessMetricName.IssuesDetected,
                        result: 'Succeeded',
                        metadata: {
                            codewhispererCodeScanJobId: jobId,
                            credentialStartUrl: this.credentialsProvider.getConnectionMetadata()?.sso?.startUrl,
                            findingId: issue.findingId,
                            detectorId: issue.detectorId,
                            ruleId: issue.ruleId,
                            autoDetected: false,
                        },
                    },
                    this.logging,
                    this.telemetry
                )
            )
        })

        let scopeMessage = this.overrideDiffScan
            ? `Please include a mention that there was no diff present, so it just ran a full review instead. Be very explicit about this so that the user could not be confused.`
            : `Please include a mention that the scan was on the ${setup.isFullReviewRequest ? `entire` : `uncommitted`} code.`

        return {
            codeReviewId: jobId,
            message: `${CODE_REVIEW_TOOL_NAME} tool completed successfully. ${scopeMessage} ${
                findingsExceededLimit
                    ? ` Inform the user that because there were more than ${CodeReview.MAX_FINDINGS_COUNT} findings, you (the AI agent) will not have context about them. ` +
                      `They will need to use the Code Issues Panel to get more information.`
                    : ''
            }`,
            findingsByFile: JSON.stringify(aggregatedCodeScanIssueList),
            findingsExceededLimit,
        }
    }

    /**
     * Collects findings from the code analysis job
     * @param jobId ID of the code analysis job
     * @param isFullReviewRequest Whether this is a full review or diff review
     * @param isCodeDiffPresent Whether code diff is present in the artifacts
     * @param programmingLanguage Programming language
     * @returns Object containing collected findings and whether limit was exceeded
     */
    private async collectFindings(
        jobId: string,
        isFullReviewRequest: boolean,
        isCodeDiffPresent: boolean,
        programmingLanguage: string
    ): Promise<{ totalFindings: CodeReviewFinding[]; findingsExceededLimit: boolean }> {
        let totalFindings: CodeReviewFinding[] = []
        let nextFindingToken = undefined
        let findingsExceededLimit = false
        const lookForCodeDiffFindings = !isFullReviewRequest && isCodeDiffPresent

        this.logging.info(
            `Collect findings for jobId: ${jobId}, isFullReviewRequest: ${isFullReviewRequest}, isCodeDiffPresent: ${isCodeDiffPresent}`
        )
        this.logging.info(`Look for code diff findings only - ${lookForCodeDiffFindings}`)

        do {
            this.logging.info(`GetFindings for job ID: ${jobId}`)
            const findingsResponse = await this.getCodeAnalysisFindings(jobId, nextFindingToken)
            nextFindingToken = findingsResponse.nextToken

            const parsedFindings =
                this.parseFindings(findingsResponse.codeAnalysisFindings, jobId, programmingLanguage) || []
            const filteredFindings = lookForCodeDiffFindings
                ? parsedFindings.filter(finding => 'CodeDiff' === finding.findingContext)
                : parsedFindings
            totalFindings = totalFindings.concat(filteredFindings)
        } while (nextFindingToken)

        if (totalFindings.length > CodeReview.MAX_FINDINGS_COUNT) {
            findingsExceededLimit = true
        }

        this.logging.info(`Total findings: ${totalFindings.length}`)
        return { totalFindings, findingsExceededLimit }
    }

    /**
     * Gets the current status of a code analysis job
     * @param jobId ID of the code analysis job
     * @returns Status response from the CodeWhisperer service
     */
    private async getCodeAnalysisStatus(jobId: string) {
        return await this.codeWhispererClient!.getCodeAnalysis({ jobId })
    }

    /**
     * Retrieves findings from a code analysis job
     * @param jobId ID of the code analysis job
     * @param nextToken Pagination token for retrieving next batch of findings
     * @returns Findings response from the CodeWhisperer service
     */
    private async getCodeAnalysisFindings(jobId: string, nextToken?: string) {
        return await this.codeWhispererClient!.listCodeAnalysisFindings({
            jobId,
            nextToken,
            codeAnalysisFindingsSchema: 'codeanalysis/findings/1.0',
        })
    }

    /**
     * Canonicalize the open workspace folder roots with a STRICT realpath.
     *
     * A root that cannot be resolved on disk, or that resolves to something
     * other than a directory, is dropped rather than kept as a lexical path
     * (unlike the permissive shared canonicalizeWorkspaceFolders, which falls
     * back to path.resolve on failure): a root that is not a resolvable
     * directory cannot anchor a trustworthy containment check, so excluding it
     * can only make the boundary stricter. Callers treat an empty result as
     * "no workspace" and reject the request.
     * @returns Canonical, on-disk workspace root directories
     */
    private async getCanonicalWorkspaceRoots(): Promise<string[]> {
        const roots: string[] = []
        for (const folder of workspaceUtils.getWorkspaceFolderPaths(this.workspace)) {
            try {
                const resolved = await fs.promises.realpath(folder)
                // Strict stat: retain the root only when it resolves to a real
                // directory. A missing root throws here; a non-directory root
                // is skipped, since it cannot contain any artifact.
                const stats = await fs.promises.stat(resolved)
                if (stats.isDirectory()) {
                    roots.push(resolved)
                } else {
                    this.logging.warn(`Ignoring a workspace folder that is not a directory on disk: ${folder}`)
                }
            } catch (error) {
                this.logging.warn(`Ignoring a workspace folder that could not be resolved on disk: ${error}`)
            }
        }
        return roots
    }

    /**
     * Validate every submitted artifact (files, folders, and rules) against the
     * open workspace before ANY artifact content is read or any Git command
     * runs. Each path must be absolute, resolve on disk with a strict realpath,
     * be the expected type (regular file for files/rules, directory for
     * folders), have a single hard link when it is a regular file, and
     * canonicalize to a location inside a canonical workspace root. Any
     * violation throws CodeReviewValidationError and aborts the whole request.
     * @param fileArtifacts Submitted file artifacts
     * @param folderArtifacts Submitted folder artifacts
     * @param ruleArtifacts Submitted rule artifacts
     * @returns Canonical workspace roots and the validated artifacts with canonical paths
     */
    private async validateArtifactsWithinWorkspace(
        fileArtifacts: FileArtifacts,
        folderArtifacts: FolderArtifacts,
        ruleArtifacts: RuleArtifacts
    ): Promise<{
        canonicalWorkspaceRoots: string[]
        fileArtifacts: ValidatedArtifact[]
        folderArtifacts: ValidatedArtifact[]
        ruleArtifacts: ValidatedArtifact[]
    }> {
        const canonicalWorkspaceRoots = await this.getCanonicalWorkspaceRoots()
        if (canonicalWorkspaceRoots.length === 0) {
            throw new CodeReviewValidationError(CodeReview.ERROR_MESSAGES.NO_WORKSPACE)
        }

        // Validate all three arrays up front so a bad path in any one of them
        // aborts before the first content read or Git call on any of them.
        const validatedFiles: ValidatedArtifact[] = []
        for (const artifact of fileArtifacts) {
            validatedFiles.push(await this.validateArtifactPath(artifact.path, 'file', canonicalWorkspaceRoots))
        }
        const validatedFolders: ValidatedArtifact[] = []
        for (const artifact of folderArtifacts) {
            validatedFolders.push(await this.validateArtifactPath(artifact.path, 'folder', canonicalWorkspaceRoots))
        }
        const validatedRules: ValidatedArtifact[] = []
        for (const artifact of ruleArtifacts) {
            validatedRules.push(await this.validateArtifactPath(artifact.path, 'file', canonicalWorkspaceRoots))
        }

        return {
            canonicalWorkspaceRoots,
            fileArtifacts: validatedFiles,
            folderArtifacts: validatedFolders,
            ruleArtifacts: validatedRules,
        }
    }

    /**
     * Validate one submitted artifact path and return both the path as
     * submitted (kept to preserve the caller's intended name and extension
     * filter) and its strict canonical location (used for the read and Git).
     * @param submittedPath Path exactly as submitted by the caller
     * @param kind Whether the path must be a regular file or a directory
     * @param canonicalWorkspaceRoots Canonical workspace roots to contain the path
     * @returns The validated artifact
     * @throws CodeReviewValidationError on any boundary violation
     */
    private async validateArtifactPath(
        submittedPath: string,
        kind: 'file' | 'folder',
        canonicalWorkspaceRoots: string[]
    ): Promise<ValidatedArtifact> {
        // Absolute only: rejects relative paths and a leading "~", which is not
        // expanded here on purpose so a tilde path cannot smuggle in a home path.
        if (typeof submittedPath !== 'string' || !path.isAbsolute(submittedPath)) {
            throw new CodeReviewValidationError(CodeReview.ERROR_MESSAGES.ARTIFACT_NOT_ABSOLUTE(String(submittedPath)))
        }

        // Strict canonicalization: realpath throws for a missing, dangling, or
        // cyclic path, and that failure rejects (no permissive lexical fallback).
        let canonicalPath: string
        try {
            canonicalPath = await fs.promises.realpath(submittedPath)
        } catch {
            throw new CodeReviewValidationError(CodeReview.ERROR_MESSAGES.ARTIFACT_UNRESOLVABLE(submittedPath))
        }

        const stats = await this.strictStat(canonicalPath, submittedPath)

        if (kind === 'file' && !stats.isFile()) {
            throw new CodeReviewValidationError(CodeReview.ERROR_MESSAGES.ARTIFACT_NOT_A_FILE(submittedPath))
        }
        if (kind === 'folder' && !stats.isDirectory()) {
            throw new CodeReviewValidationError(CodeReview.ERROR_MESSAGES.ARTIFACT_NOT_A_DIRECTORY(submittedPath))
        }

        // A regular file reachable under more than one name may also live
        // outside the workspace; directories legitimately have a link count
        // above one ('.', '..', and each subdirectory), so only files are
        // rejected for multiple links.
        if (stats.isFile() && stats.nlink > 1) {
            throw new CodeReviewValidationError(CodeReview.ERROR_MESSAGES.ARTIFACT_MULTIPLY_LINKED(submittedPath))
        }

        if (!workspaceUtils.isInWorkspace(canonicalWorkspaceRoots, canonicalPath)) {
            throw new CodeReviewValidationError(CodeReview.ERROR_MESSAGES.ARTIFACT_OUTSIDE_WORKSPACE(submittedPath))
        }

        return { path: submittedPath, canonicalPath }
    }

    /**
     * Strict stat that rejects on failure (fail closed) instead of reporting a
     * benign default the way the shared hasAdditionalHardLinks does when stat
     * throws. Used both up front and immediately before each read.
     * @param canonicalPath Canonical path to stat
     * @param submittedPath Submitted path, used only for the error message
     * @returns The fs.Stats for the canonical path
     * @throws CodeReviewValidationError when the path cannot be stat'd
     */
    private async strictStat(canonicalPath: string, submittedPath: string): Promise<fs.Stats> {
        try {
            return await fs.promises.stat(canonicalPath)
        } catch {
            throw new CodeReviewValidationError(CodeReview.ERROR_MESSAGES.ARTIFACT_UNRESOLVABLE(submittedPath))
        }
    }

    /**
     * Re-validate a resolved file immediately before its contents are read and
     * return the path that the read and Git must use. The stored canonical
     * input is re-resolved with a strict realpath, then the resolved path is
     * required to be a single-linked regular file inside the workspace. Running
     * the realpath, the stat, and the checks together right before the read (and
     * returning the same resolved path for the read and Git) keeps the check and
     * the use pinned to one location, rather than trusting a path string
     * resolved earlier. This runs for every file, including each file discovered
     * during a folder walk, so a folder traversal cannot read a hard-linked or
     * out-of-workspace file that an earlier check missed. This narrows, but does
     * not eliminate, the window between the check and the read (no full TOCTOU
     * immunity).
     * @param canonicalPath Canonical path recorded at validation time
     * @param submittedPath Path used only for the error message
     * @param canonicalWorkspaceRoots Canonical workspace roots to contain the path
     * @returns The freshly resolved path to use for the read and Git
     * @throws CodeReviewValidationError on any boundary violation
     */
    private async assertFileReadableWithinWorkspace(
        canonicalPath: string,
        submittedPath: string,
        canonicalWorkspaceRoots: string[]
    ): Promise<string> {
        // Re-resolve the stored canonical input right before use so the type,
        // link, and boundary checks below act on the current on-disk location.
        let resolvedPath: string
        try {
            resolvedPath = await fs.promises.realpath(canonicalPath)
        } catch {
            throw new CodeReviewValidationError(CodeReview.ERROR_MESSAGES.ARTIFACT_UNRESOLVABLE(submittedPath))
        }
        const stats = await this.strictStat(resolvedPath, submittedPath)
        if (!stats.isFile()) {
            throw new CodeReviewValidationError(CodeReview.ERROR_MESSAGES.ARTIFACT_NOT_A_FILE(submittedPath))
        }
        if (stats.nlink > 1) {
            throw new CodeReviewValidationError(CodeReview.ERROR_MESSAGES.ARTIFACT_MULTIPLY_LINKED(submittedPath))
        }
        if (!workspaceUtils.isInWorkspace(canonicalWorkspaceRoots, resolvedPath)) {
            throw new CodeReviewValidationError(CodeReview.ERROR_MESSAGES.ARTIFACT_OUTSIDE_WORKSPACE(submittedPath))
        }
        return resolvedPath
    }

    /**
     * Create a zip archive of the files and folders to be scanned and calculate MD5 hash
     * @param fileArtifacts Array of file artifacts containing path and programming language
     * @param folderArtifacts Array of folder artifacts containing path
     * @param ruleArtifacts Array of file paths to user selected rules
     * @param isFullReviewRequest If user asked for Full review or Partial review
     * @returns An object containing the zip file buffer and its MD5 hash
     */
    private async prepareFilesAndFoldersForUpload(
        userRequirement: string,
        fileArtifacts: FileArtifacts,
        folderArtifacts: FolderArtifacts,
        ruleArtifacts: RuleArtifacts,
        isFullReviewRequest: boolean
    ): Promise<{
        zipBuffer: Buffer
        md5Hash: string
        isCodeDiffPresent: boolean
        programmingLanguages: Set<string>
        numberOfFilesInCustomerCodeZip: number
        codeDiffFiles: Set<string>
        filePathsInZip: Set<string>
    }> {
        try {
            this.logging.info(
                `Preparing ${fileArtifacts.length} files and ${folderArtifacts.length} folders for upload`
            )

            // Validate every submitted artifact (files, folders, and rules)
            // against the open workspace BEFORE any content is read or any Git
            // command runs. A single violation throws here, which aborts the
            // whole request before createUploadUrl, the upload PUT, and
            // startCodeAnalysis are ever reached. The validated result carries
            // strict canonical paths that the reads and Git calls below use.
            const validatedArtifacts = await this.validateArtifactsWithinWorkspace(
                fileArtifacts,
                folderArtifacts,
                ruleArtifacts
            )

            const codeArtifactZip = new JSZip()
            const customerCodeZip = new JSZip()

            // Process files and folders
            const { codeDiff, programmingLanguages, codeDiffFiles } = await this.processArtifacts(
                validatedArtifacts.fileArtifacts,
                validatedArtifacts.folderArtifacts,
                validatedArtifacts.ruleArtifacts,
                validatedArtifacts.canonicalWorkspaceRoots,
                customerCodeZip,
                !isFullReviewRequest
            )

            let [numberOfFilesInCustomerCodeZip, filePathsInZip] = CodeReviewUtils.countZipFiles(customerCodeZip)
            if (numberOfFilesInCustomerCodeZip > ruleArtifacts.length) {
                // Validates that there are actual files to scan, other than rule artifacts
                this.logging.info(`Total files in customerCodeZip - ${numberOfFilesInCustomerCodeZip}`)
            } else {
                throw new CodeReviewValidationError(CodeReview.ERROR_MESSAGES.MISSING_FILES_TO_SCAN)
            }

            // Generate user code zip buffer
            const customerCodeBuffer = await CodeReviewUtils.generateZipBuffer(customerCodeZip)
            CodeReviewUtils.logZipStructure(customerCodeZip, 'User code', this.logging)

            // Add user code zip to the main artifact zip
            codeArtifactZip.file(
                `${CodeReview.CODE_ARTIFACT_PATH}/${CodeReview.CUSTOMER_CODE_ZIP_NAME}`,
                customerCodeBuffer
            )

            let isCodeDiffPresent = false

            // Add code diff file if we have any diffs
            if (codeDiff.trim()) {
                this.logging.info(`Adding code diff to zip of size: ${codeDiff.length}`)
                isCodeDiffPresent = true
                codeArtifactZip.file(CodeReview.CODE_DIFF_PATH, codeDiff)
            }

            // Add user requirement
            codeArtifactZip.file(CodeReview.USER_REQUIREMENT_PATH, userRequirement)

            // Generate the final code artifact zip
            const zipBuffer = await CodeReviewUtils.generateZipBuffer(codeArtifactZip)
            CodeReviewUtils.logZipStructure(codeArtifactZip, 'Code artifact', this.logging)

            // Calculate MD5 hash of the zip buffer
            const md5Hash = crypto.createHash('md5').update(zipBuffer).digest('hex')

            this.logging.info(`Created zip archive, size: ${zipBuffer.byteLength} bytes, MD5: ${md5Hash}`)

            return {
                zipBuffer,
                md5Hash,
                isCodeDiffPresent,
                programmingLanguages,
                numberOfFilesInCustomerCodeZip,
                codeDiffFiles,
                filePathsInZip,
            }
        } catch (error) {
            this.logging.error(`Error preparing files for upload: ${error}`)
            throw error
        }
    }

    /**
     * Processes file, folder, and rule artifacts for inclusion in the zip archive
     * @param fileArtifacts Validated file artifacts to process
     * @param folderArtifacts Validated folder artifacts to process
     * @param ruleArtifacts Validated rule artifacts to process
     * @param canonicalWorkspaceRoots Canonical workspace roots used for the pre-read re-checks
     * @param customerCodeZip JSZip instance for the customer code
     * @param isCodeDiffScan Whether this is a code diff scan
     * @returns Combined code diff string from all artifacts
     */
    private async processArtifacts(
        fileArtifacts: ValidatedArtifact[],
        folderArtifacts: ValidatedArtifact[],
        ruleArtifacts: ValidatedArtifact[],
        canonicalWorkspaceRoots: string[],
        customerCodeZip: JSZip,
        isCodeDiffScan: boolean
    ): Promise<{ codeDiff: string; programmingLanguages: Set<string>; codeDiffFiles: Set<string> }> {
        // Process files
        let { codeDiff, programmingLanguages, codeDiffFiles } = await this.processFileArtifacts(
            fileArtifacts,
            canonicalWorkspaceRoots,
            customerCodeZip,
            isCodeDiffScan
        )

        // Process folders
        const folderResult = await this.processFolderArtifacts(
            folderArtifacts,
            canonicalWorkspaceRoots,
            customerCodeZip,
            isCodeDiffScan
        )
        codeDiff += folderResult.codeDiff
        folderResult.programmingLanguages.forEach(item => programmingLanguages.add(item))
        folderResult.codeDiffFiles.forEach(item => codeDiffFiles.add(item))

        // Process rule artifacts
        await this.processRuleArtifacts(ruleArtifacts, canonicalWorkspaceRoots, customerCodeZip)

        return { codeDiff, programmingLanguages, codeDiffFiles }
    }

    /**
     * Processes file artifacts for inclusion in the zip archive
     * @param fileArtifacts Validated file artifacts to process
     * @param canonicalWorkspaceRoots Canonical workspace roots used for the pre-read re-check
     * @param customerCodeZip JSZip instance for the customer code
     * @param isCodeDiffScan Whether this is a code diff scan
     * @returns Combined code diff string from file artifacts
     */
    private async processFileArtifacts(
        fileArtifacts: ValidatedArtifact[],
        canonicalWorkspaceRoots: string[],
        customerCodeZip: JSZip,
        isCodeDiffScan: boolean
    ): Promise<{ codeDiff: string; programmingLanguages: Set<string>; codeDiffFiles: Set<string> }> {
        let codeDiff = ''
        let programmingLanguages: Set<string> = new Set()
        let codeDiffFiles: Set<string> = new Set()

        for (const artifact of fileArtifacts) {
            // The dot/extension filter gates BOTH the zip entry and the Git
            // diff: a filtered-out file is neither read nor diffed, so its
            // content cannot reach the upload through customerCode OR codeDiff.
            // Existence and type are already guaranteed by the up-front
            // validation; the zip entry name and this filter decision use the
            // path as submitted, so a symlink whose name is in the workspace
            // cannot broaden or narrow the extension allowlist through canonical
            // renaming.
            const fileName = path.basename(artifact.path)
            if (fileName.startsWith('.') || CodeReviewUtils.shouldSkipFile(fileName)) {
                this.logging.info(`Skipping file - ${artifact.path}`)
                continue
            }

            let readPath: string | undefined
            await CodeReviewUtils.withErrorHandling(
                async () => {
                    // Re-validate the resolved path immediately before reading
                    // it, and read from the same freshly resolved location.
                    readPath = await this.assertFileReadableWithinWorkspace(
                        artifact.canonicalPath,
                        artifact.path,
                        canonicalWorkspaceRoots
                    )
                    const fileLanguage = CodeReviewUtils.getFileLanguage(fileName)
                    const fileContent = await this.workspace.fs.readFile(readPath)
                    let normalizedArtifactPath = CodeReviewUtils.convertToUnixPath(artifact.path)
                    customerCodeZip.file(`${CodeReview.CUSTOMER_CODE_BASE_PATH}${normalizedArtifactPath}`, fileContent)
                    programmingLanguages.add(fileLanguage)
                },
                'Failed to read file',
                this.logging,
                artifact.path
            )

            // Only a file that passed the filter and was read (readPath set)
            // feeds Git, and the diff derives from the SAME resolved location
            // that was read into the zip — never an unread or filtered path.
            if (readPath !== undefined) {
                const artifactFileDiffs = await CodeReviewUtils.getGitDiffNames(readPath, this.logging)
                artifactFileDiffs.forEach(filepath => codeDiffFiles.add(filepath))
                codeDiff += await CodeReviewUtils.processArtifactWithDiff(
                    { path: readPath },
                    isCodeDiffScan,
                    this.logging
                )
            }
        }

        return { codeDiff, programmingLanguages, codeDiffFiles }
    }

    /**
     * Processes folder artifacts for inclusion in the zip archive
     * @param folderArtifacts Validated folder artifacts to process
     * @param canonicalWorkspaceRoots Canonical workspace roots used for the per-file re-checks
     * @param customerCodeZip JSZip instance for the customer code
     * @param isCodeDiffScan Whether this is a code diff scan
     * @returns Combined code diff string from folder artifacts
     */
    private async processFolderArtifacts(
        folderArtifacts: ValidatedArtifact[],
        canonicalWorkspaceRoots: string[],
        customerCodeZip: JSZip,
        isCodeDiffScan: boolean
    ): Promise<{ codeDiff: string; programmingLanguages: Set<string>; codeDiffFiles: Set<string> }> {
        let codeDiff = ''
        let programmingLanguages = new Set<string>()
        let codeDiffFiles: Set<string> = new Set()

        for (const folderArtifact of folderArtifacts) {
            // Collect the canonical paths of the files actually read into the
            // zip — those that passed the same dot/extension/skip-directory
            // filters, are single-linked regular files, and resolve inside the
            // workspace. The folder's Git diff is derived ONLY from these files;
            // there is no whole-folder git request, so a skipped dotfile or
            // non-allowlisted file cannot contribute diff text to the uploaded
            // codeDiff.
            const includedFiles = new Set<string>()
            await CodeReviewUtils.withErrorHandling(
                async () => {
                    let languages = await this.addFolderToZip(
                        customerCodeZip,
                        folderArtifact.canonicalPath,
                        CodeReview.CUSTOMER_CODE_BASE_PATH,
                        canonicalWorkspaceRoots,
                        includedFiles
                    )
                    languages.forEach(item => programmingLanguages.add(item))
                },
                'Failed to add folder',
                this.logging,
                folderArtifact.path
            )

            // Per-file Git, over the included files only. Each path is the same
            // resolved, in-workspace, single-linked file that was read into the
            // zip, so the diff never carries content from a skipped or
            // out-of-workspace file.
            for (const includedFile of includedFiles) {
                const artifactFileDiffs = await CodeReviewUtils.getGitDiffNames(includedFile, this.logging)
                artifactFileDiffs.forEach(filepath => codeDiffFiles.add(filepath))
                codeDiff += await CodeReviewUtils.processArtifactWithDiff(
                    { path: includedFile },
                    isCodeDiffScan,
                    this.logging
                )
            }
        }

        return { codeDiff, programmingLanguages, codeDiffFiles }
    }

    /**
     * Processes rule artifacts for inclusion in the zip archive
     * @param ruleArtifacts Validated rule artifacts to process
     * @param canonicalWorkspaceRoots Canonical workspace roots used for the pre-read re-check
     * @param customerCodeZip JSZip instance for the customer code
     */
    private async processRuleArtifacts(
        ruleArtifacts: ValidatedArtifact[],
        canonicalWorkspaceRoots: string[],
        customerCodeZip: JSZip
    ): Promise<void> {
        let ruleNameSet = new Set<string>()
        for (const artifact of ruleArtifacts) {
            await CodeReviewUtils.withErrorHandling(
                async () => {
                    // The rule file name (and its allowlist decision) comes from
                    // the submitted path; existence and type are guaranteed by
                    // the up-front validation.
                    let fileName = path.basename(artifact.path)
                    if (!fileName.startsWith('.') && !CodeReviewUtils.shouldSkipFile(fileName)) {
                        const readPath = await this.assertFileReadableWithinWorkspace(
                            artifact.canonicalPath,
                            artifact.path,
                            canonicalWorkspaceRoots
                        )
                        if (ruleNameSet.has(fileName)) {
                            fileName = fileName.split('.')[0] + '_' + crypto.randomUUID() + '.' + fileName.split('.')[1]
                        }
                        ruleNameSet.add(fileName)
                        const fileContent = await this.workspace.fs.readFile(readPath)
                        customerCodeZip.file(
                            `${CodeReview.CUSTOMER_CODE_BASE_PATH}/${CodeReview.RULE_ARTIFACT_PATH}/${fileName}`,
                            fileContent
                        )
                    } else {
                        this.logging.info(`Skipping file - ${artifact.path}`)
                    }
                },
                'Failed to read file',
                this.logging,
                artifact.path
            )
        }
    }

    /**
     * Recursively add a folder and its contents to a zip archive
     * @param zip JSZip instance to add files to
     * @param folderPath Canonical path to the folder to add
     * @param zipPath Relative path within the zip archive
     * @param canonicalWorkspaceRoots Canonical workspace roots used for the per-entry re-checks
     * @param includedFiles Accumulator of the canonical file paths actually read
     *   into the zip; the caller derives the folder's Git diff only from these,
     *   so a skipped or out-of-workspace file never contributes diff text.
     */
    private async addFolderToZip(
        zip: JSZip,
        folderPath: string,
        zipPath: string,
        canonicalWorkspaceRoots: string[],
        includedFiles: Set<string>
    ): Promise<Set<string>> {
        try {
            let programmingLanguages = new Set<string>()
            const entries = await this.workspace.fs.readdir(folderPath)

            for (const entry of entries) {
                const name = entry.name
                // Build the child path from the canonical directory we control,
                // NOT from entry.parentPath, so a crafted or mis-reported dirent
                // cannot redirect the walk outside the folder being scanned.
                const fullPath = path.join(folderPath, name)

                if (entry.isFile()) {
                    if (name.startsWith('.') || CodeReviewUtils.shouldSkipFile(name)) {
                        this.logging.info(`Skipping file - ${fullPath}`)
                        continue
                    }

                    // Resolve and re-validate every discovered file before
                    // reading it: a folder walk must not become a way to read a
                    // hard-linked or out-of-workspace file. A realpath failure
                    // rejects (fail closed) and aborts the whole request; the
                    // rejected path is never read. The read and the recorded
                    // path both use the freshly resolved location.
                    let canonicalFile: string
                    try {
                        canonicalFile = await fs.promises.realpath(fullPath)
                    } catch {
                        throw new CodeReviewValidationError(CodeReview.ERROR_MESSAGES.ARTIFACT_UNRESOLVABLE(fullPath))
                    }
                    const readPath = await this.assertFileReadableWithinWorkspace(
                        canonicalFile,
                        fullPath,
                        canonicalWorkspaceRoots
                    )

                    const fileLanguage = CodeReviewUtils.getFileLanguage(name)
                    const content = await this.workspace.fs.readFile(readPath)
                    let normalizedArtifactPath = CodeReviewUtils.convertToUnixPath(readPath)
                    zip.file(`${zipPath}${normalizedArtifactPath}`, content)
                    programmingLanguages.add(fileLanguage)
                    // Record the exact location read into the zip so the folder's
                    // Git diff is computed only over the files it actually included.
                    includedFiles.add(readPath)
                } else if (entry.isDirectory()) {
                    if (CodeReviewUtils.shouldSkipDirectory(name)) {
                        this.logging.info(`Skipping directory - ${fullPath}`)
                        continue
                    }

                    // Resolve the subdirectory and confirm it stays inside the
                    // workspace before recursing into it. A symlinked entry is
                    // already skipped above because a symlink dirent is neither a
                    // file nor a directory, so the walk never follows a link out
                    // of the workspace; this containment check is defense in
                    // depth against a mis-reported dirent.
                    let canonicalDir: string
                    try {
                        canonicalDir = await fs.promises.realpath(fullPath)
                    } catch {
                        throw new CodeReviewValidationError(CodeReview.ERROR_MESSAGES.ARTIFACT_UNRESOLVABLE(fullPath))
                    }
                    if (!workspaceUtils.isInWorkspace(canonicalWorkspaceRoots, canonicalDir)) {
                        throw new CodeReviewValidationError(
                            CodeReview.ERROR_MESSAGES.ARTIFACT_OUTSIDE_WORKSPACE(fullPath)
                        )
                    }

                    let languages = await this.addFolderToZip(
                        zip,
                        canonicalDir,
                        zipPath,
                        canonicalWorkspaceRoots,
                        includedFiles
                    )
                    languages.forEach(item => programmingLanguages.add(item))
                }
            }
            return programmingLanguages
        } catch (error) {
            this.logging.error(`Error adding folder to zip: ${error}`)
            throw error
        }
    }

    /**
     * Parse and validate findings JSON response
     * @param findingsJson Raw JSON string from the code analysis response
     * @param jobId Code scan job Id
     * @param programmingLanguage programming language
     * @returns Parsed and validated findings array
     */
    private parseFindings(
        findingsJson: string | undefined,
        jobId: string,
        programmingLanguage: string
    ): CodeReviewFinding[] {
        if (findingsJson === undefined) {
            return []
        }
        try {
            const findingsResponseJSON = JSON.parse(findingsJson)

            // Normalize ruleId fields
            for (const finding of findingsResponseJSON) {
                if (finding['ruleId'] == null) {
                    finding['ruleId'] = undefined
                }
            }

            return FINDINGS_SCHEMA.parse(findingsResponseJSON).map(issue => ({
                startLine: issue.startLine - 1 >= 0 ? issue.startLine - 1 : 0,
                endLine: issue.endLine,
                comment: `${issue.title.trim()}: ${issue.description.text.trim()}`,
                title: issue.title,
                description: issue.description,
                detectorId: issue.detectorId,
                detectorName: issue.detectorName,
                findingId: issue.findingId,
                ruleId: issue.ruleId != null ? issue.ruleId : undefined,
                relatedVulnerabilities: issue.relatedVulnerabilities,
                severity: issue.severity,
                recommendation: issue.remediation.recommendation,
                suggestedFixes: issue.suggestedFixes != undefined ? issue.suggestedFixes : [],
                scanJobId: jobId,
                language: programmingLanguage,
                autoDetected: false,
                filePath: issue.filePath,
                findingContext: issue.findingContext,
            }))
        } catch (e) {
            this.logging.error(`Error parsing findings in response: ${e}`)
            throw new CodeReviewInternalError('Error parsing findings in response')
        }
    }

    /**
     * Aggregate findings by file path
     * @param findings Array of findings
     * @param fileArtifacts Array of file artifacts being scanned
     * @param folderArtifacts Array of folder artifacts being scanned
     * @returns Array of findings grouped by resolved file path
     */
    private aggregateFindingsByFile(
        findings: CodeReviewFinding[],
        fileArtifacts: FileArtifacts,
        folderArtifacts: FolderArtifacts
    ): { filePath: string; issues: CodeReviewFinding[] }[] {
        const aggregatedCodeScanIssueMap = new Map<string, CodeReviewFinding[]>()

        for (const finding of findings) {
            const resolvedPath = this.resolveFilePath(finding.filePath, fileArtifacts, folderArtifacts)
            if (resolvedPath) {
                if (aggregatedCodeScanIssueMap.has(resolvedPath)) {
                    aggregatedCodeScanIssueMap.get(resolvedPath)?.push(finding)
                } else {
                    aggregatedCodeScanIssueMap.set(resolvedPath, [finding])
                }
            } else {
                this.logging.warn(`Could not resolve finding file path: ${finding.filePath}`)
            }
        }

        return Array.from(aggregatedCodeScanIssueMap.entries()).map(([filePath, issues]) => ({
            filePath,
            issues,
        }))
    }

    /**
     * Resolve finding file path to actual file path
     * @param findingPath Relative file path from the finding
     * @param fileArtifacts Array of file artifacts being scanned
     * @param folderArtifacts Array of folder artifacts being scanned
     * @returns Resolved absolute file path or null if not found
     */
    private resolveFilePath(
        findingPath: string,
        fileArtifacts: FileArtifacts,
        folderArtifacts: FolderArtifacts
    ): string | null {
        // 1. Check if finding path matches one of the file artifacts
        for (const fileArtifact of fileArtifacts) {
            const normalizedFilePath = path.normalize(fileArtifact.path)
            const normalizedFindingPath = path.normalize(findingPath)

            if (normalizedFilePath.endsWith(normalizedFindingPath)) {
                return normalizedFilePath
            }
        }

        // 2. Check if finding path falls under one of the folder artifacts
        for (const folderArtifact of folderArtifacts) {
            const normalizedFolderPath = path.normalize(folderArtifact.path)
            const normalizedFindingPath = path.normalize(findingPath)

            // 2.1. Check if finding path falls under one of the subdirectories in folder artifact path
            const folderSegments = normalizedFolderPath.split(path.sep)

            // Find common suffix between folder path and finding path
            let matchIndex = -1
            for (let i = folderSegments.length - 1; i >= 0; i--) {
                const folderSuffix = folderSegments.slice(i).join(path.sep)
                if (normalizedFindingPath.startsWith(folderSuffix + path.sep)) {
                    matchIndex = i
                    break
                }
            }
            // If common suffix is found, create the absolute path with it
            if (matchIndex !== -1) {
                const remainingPath = normalizedFindingPath.substring(
                    folderSegments.slice(matchIndex).join(path.sep).length + 1
                )
                const absolutePath = path.join(normalizedFolderPath, remainingPath)
                if (existsSync(absolutePath) && statSync(absolutePath).isFile()) {
                    return absolutePath
                }
            }

            // 2.2. Check if folder path + finding path gives the absolute file path
            const filePath = path.join(folderArtifact.path, findingPath)
            if (existsSync(filePath) && statSync(filePath).isFile()) {
                return filePath
            }
        }

        // 3. Check if finding already has absolute file path
        const maybeAbsolutePath = path.normalize(findingPath)
        if (existsSync(maybeAbsolutePath) && statSync(maybeAbsolutePath).isFile()) {
            return maybeAbsolutePath
        }

        return null
    }

    /**
     * Checks if the operation has been cancelled by the user
     * @param message Optional message to include in the cancellation error
     * @throws Error if the operation has been cancelled
     */
    private checkCancellation(message: string = 'Command execution cancelled'): void {
        CodeReviewUtils.checkCancellation(this.cancellationToken, this.logging, message)
    }
}
