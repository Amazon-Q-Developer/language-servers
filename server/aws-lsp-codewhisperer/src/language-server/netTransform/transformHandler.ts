import { ExportIntent } from '@amzn/codewhisperer-streaming'
import { Logging, Runtime, Workspace } from '@aws/language-server-runtimes/server-interface'
import * as fs from 'fs'
import got from 'got'
import { v4 as uuidv4 } from 'uuid'
import {
    CreateUploadUrlResponse,
    GetTransformationRequest,
    StopTransformationRequest,
    TransformationJob,
} from '@amzn/codewhisperer-runtime'
import { ArtifactManager } from './artifactManager'
import { getCWStartTransformRequest, getCWStartTransformResponse } from './converter'
import {
    CancelTransformRequest,
    CancelTransformResponse,
    CancellationJobStatus,
    DownloadArtifactsResponse,
    GetTransformPlanRequest,
    GetTransformPlanResponse,
    GetTransformRequest,
    GetTransformResponse,
    StartTransformRequest,
    StartTransformResponse,
    TransformProjectMetadata,
    PollTransformationStatus,
} from './models'
import * as validation from './validation'
import path = require('path')
import AdmZip = require('adm-zip')
import { AmazonQTokenServiceManager } from '../../shared/amazonQServiceManager/AmazonQTokenServiceManager'

import { Utils, workspaceFolderName } from './utils'

export class TransformHandler {
    private serviceManager: AmazonQTokenServiceManager
    private workspace: Workspace
    private logging: Logging
    private runtime: Runtime
    private cancelPollingEnabled: Boolean = false

    constructor(serviceManager: AmazonQTokenServiceManager, workspace: Workspace, logging: Logging, runtime: Runtime) {
        this.serviceManager = serviceManager
        this.workspace = workspace
        this.logging = logging
        this.runtime = runtime
    }

    async startTransformation(userInputrequest: StartTransformRequest): Promise<StartTransformResponse> {
        var unsupportedProjects: string[] = []
        const isProject = validation.isProject(userInputrequest)
        const containsUnsupportedViews = await validation.checkForUnsupportedViews(
            userInputrequest,
            isProject,
            this.logging
        )

        const artifactManager = new ArtifactManager(
            this.workspace,
            this.logging,
            Utils.getWorkspacePath(userInputrequest.SolutionRootPath),
            userInputrequest.SolutionRootPath
        )
        try {
            const payloadFilePath = await this.zipCodeAsync(userInputrequest, artifactManager)
            this.logging.log('Payload path: ' + payloadFilePath)

            const uploadId = await this.preTransformationUploadCode(payloadFilePath)
            const request = getCWStartTransformRequest(userInputrequest, uploadId, this.logging)
            this.logging.log('Sending request to start transform api: ' + JSON.stringify(request))
            const response = await this.serviceManager
                .getCodewhispererService()
                .codeModernizerStartCodeTransformation(request)
            this.logging.log('Received transformation job Id: ' + response?.transformationJobId)
            return getCWStartTransformResponse(
                response,
                uploadId,
                payloadFilePath,
                unsupportedProjects,
                containsUnsupportedViews
            )
        } catch (error) {
            let errorMessage = (error as Error).message ?? 'Error in StartTransformation API call'
            if (errorMessage.includes('Invalid transformation specification')) {
                errorMessage =
                    'Your profile credentials are not allow-listed or lack the necessary access. Please check your credentials.'
            }
            this.logging.log(errorMessage)
            throw new Error(errorMessage)
        } finally {
            const env = this.runtime.getConfiguration('RUNENV') ?? ''
            if (env.toUpperCase() != 'TEST') {
                artifactManager.cleanup()
            }
        }
    }

    async preTransformationUploadCode(payloadFilePath: string): Promise<string | undefined> {
        try {
            const uploadId = await this.uploadPayloadAsync(payloadFilePath)
            this.logging.log('Artifact was successfully uploaded. Upload tracking id: ' + uploadId)
            return uploadId
        } catch (error) {
            const errorMessage = (error as Error).message ?? 'Failed to upload zip file'
            throw new Error(errorMessage)
        }
    }

    async uploadPayloadAsync(payloadFileName: string): Promise<string | undefined> {
        const sha256 = await ArtifactManager.getSha256Async(payloadFileName)
        let response: CreateUploadUrlResponse
        try {
            response = await this.serviceManager.getCodewhispererService().codeModernizerCreateUploadUrl({
                contentChecksum: sha256,
                contentChecksumType: 'SHA_256',
                uploadIntent: 'TRANSFORMATION',
            })
        } catch (e: any) {
            const errorMessage = (e as Error).message ?? 'Error in CreateUploadUrl API call'
            this.logging.log('Error when creating upload url: ' + errorMessage)
            throw new Error(errorMessage)
        }

        try {
            await this.uploadArtifactToS3Async(payloadFileName, response, sha256)
        } catch (e: any) {
            const errorMessage = (e as Error).message ?? 'Error in uploadArtifactToS3 call'
            this.logging.log('Error when calling uploadArtifactToS3Async: ' + errorMessage)
            throw new Error(errorMessage)
        }
        return response.uploadId
    }

    async zipCodeAsync(request: StartTransformRequest, artifactManager: ArtifactManager): Promise<string> {
        try {
            return await artifactManager.createZip(request)
        } catch (e: any) {
            this.logging.log('Error creating zip: ' + e)
            throw e
        }
    }

    async uploadArtifactToS3Async(fileName: string, resp: CreateUploadUrlResponse, sha256: string) {
        const headersObj = this.getHeadersObj(sha256, resp.kmsKeyArn)
        try {
            const fileStream = fs.createReadStream(fileName)
            const response = await got.put(resp.uploadUrl ?? 'invalid-url', {
                body: fileStream,
                headers: headersObj,
            })

            this.logging.log(`CodeTransform: Response from S3 Upload = ${response.statusCode}`)
        } catch (e: any) {
            const error = e as Error
            const errorMessage = `error: ${error.message || 'Error in S3 UploadZip API call'}, please see https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/troubleshooting-code-transformation.html#project-upload-fail`
            this.logging.log(errorMessage)
            throw new Error(errorMessage)
        }
    }

    getHeadersObj(sha256: string, kmsKeyArn: string | undefined) {
        let headersObj = {}
        if (kmsKeyArn === undefined || kmsKeyArn.length === 0) {
            headersObj = {
                'x-amz-checksum-sha256': sha256,
                'Content-Type': 'application/zip',
            }
        } else {
            headersObj = {
                'x-amz-checksum-sha256': sha256,
                'Content-Type': 'application/zip',
                'x-amz-server-side-encryption': 'aws:kms',
                'x-amz-server-side-encryption-aws-kms-key-id': kmsKeyArn,
            }
        }
        return headersObj
    }
    /**
     * Retrieves the status and details of a transformation job.
     * Includes error code when the job has failed.
     *
     * @param request - The request containing the transformation job ID
     * @returns The transformation job details with error code if applicable, or null if the request fails
     */
    async getTransformation(request: GetTransformRequest) {
        try {
            const getCodeTransformationRequest = {
                transformationJobId: request.TransformationJobId,
            } as GetTransformationRequest
            const response = await this.serviceManager
                .getCodewhispererService()
                .codeModernizerGetCodeTransformation(getCodeTransformationRequest)
            this.logging.log('Transformation status: ' + response.transformationJob?.status)

            // Use validation function to determine the error code
            const errorCode = validation.getTransformationErrorCode(response.transformationJob)

            return {
                TransformationJob: response.transformationJob,
                ErrorCode: errorCode,
            } as GetTransformResponse
        } catch (e: any) {
            const errorMessage = (e as Error).message ?? 'Error in GetTransformation API call'
            this.logging.log('Error: ' + errorMessage)
            return null
        }
    }
    async getTransformationPlan(request: GetTransformPlanRequest) {
        let getTransformationPlanAttempt = 0
        let getTransformationPlanMaxAttempts = 3
        while (true) {
            try {
                const getCodeTransformationPlanRequest = {
                    transformationJobId: request.TransformationJobId,
                } as GetTransformationRequest
                const response = await this.serviceManager
                    .getCodewhispererService()
                    .codeModernizerGetCodeTransformationPlan(getCodeTransformationPlanRequest)
                return {
                    TransformationPlan: response.transformationPlan,
                } as GetTransformPlanResponse
            } catch (e: any) {
                const errorMessage = (e as Error).message ?? 'Error in GetTransformationPlan API call'
                this.logging.log('Error: ' + errorMessage)

                getTransformationPlanAttempt += 1
                if (getTransformationPlanAttempt >= getTransformationPlanMaxAttempts) {
                    this.logging.log(`GetTransformationPlan failed after ${getTransformationPlanMaxAttempts} attempts.`)
                    throw e
                }

                const expDelayMs = Utils.getExpDelayForApiRetryMs(getTransformationPlanAttempt)
                this.logging.log(
                    `Attempt ${getTransformationPlanAttempt}/${getTransformationPlanMaxAttempts} to get transformation plan failed, retry in ${expDelayMs} seconds`
                )
                await Utils.sleep(expDelayMs * 1000)
            }
        }
    }

    async cancelTransformation(request: CancelTransformRequest) {
        let cancelTransformationAttempt = 0
        let cancelTransformationMaxAttempts = 3
        while (true) {
            try {
                const stopCodeTransformationRequest = {
                    transformationJobId: request.TransformationJobId,
                } as StopTransformationRequest
                this.logging.log(
                    'Sending CancelTransformRequest with job Id: ' + stopCodeTransformationRequest.transformationJobId
                )
                const response = await this.serviceManager
                    .getCodewhispererService()
                    .codeModernizerStopCodeTransformation(stopCodeTransformationRequest)
                this.logging.log('Transformation status: ' + response.transformationStatus)
                let status: CancellationJobStatus
                switch (response.transformationStatus) {
                    case 'STOPPED':
                        status = CancellationJobStatus.SUCCESSFULLY_CANCELLED
                        break
                    default:
                        status = CancellationJobStatus.FAILED_TO_CANCEL
                        break
                }
                return {
                    TransformationJobStatus: status,
                } as CancelTransformResponse
            } catch (e: any) {
                const errorMessage = (e as Error).message ?? 'Error in CancelTransformation API call'
                this.logging.log('Error: ' + errorMessage)

                cancelTransformationAttempt += 1
                if (cancelTransformationAttempt >= cancelTransformationMaxAttempts) {
                    this.logging.log(`CancelTransformation failed after ${cancelTransformationMaxAttempts} attempts.`)
                    return {
                        TransformationJobStatus: CancellationJobStatus.FAILED_TO_CANCEL,
                    } as CancelTransformResponse
                }

                const expDelayMs = Utils.getExpDelayForApiRetryMs(cancelTransformationAttempt)
                this.logging.log(
                    `Attempt ${cancelTransformationAttempt}/${cancelTransformationMaxAttempts} to get transformation plan failed, retry in ${expDelayMs} seconds`
                )
                await Utils.sleep(expDelayMs * 1000)
            }
        }
    }

    async pollTransformation(request: GetTransformRequest, validExitStatus: string[], failureStates: string[]) {
        let timer = 0
        let getTransformAttempt = 0
        let getTransformMaxAttempts = 3
        const getCodeTransformationRequest = {
            transformationJobId: request.TransformationJobId,
        } as GetTransformationRequest
        let response = await this.serviceManager
            .getCodewhispererService()
            .codeModernizerGetCodeTransformation(getCodeTransformationRequest)
        this.logging.log('Start polling for transformation plan.')
        this.logging.log('The valid status to exit polling are: ' + validExitStatus)
        this.logging.log('The failure status are: ' + failureStates)

        this.logging.log('Transformation status: ' + response.transformationJob?.status)
        let status = response?.transformationJob?.status ?? PollTransformationStatus.NOT_FOUND

        while (status != PollTransformationStatus.TIMEOUT && !failureStates.includes(status)) {
            try {
                if (this.cancelPollingEnabled) {
                    // Reset the flag
                    this.cancelPollingEnabled = false
                    return {
                        TransformationJob: response.transformationJob,
                    } as GetTransformResponse
                }
                const apiStartTime = Date.now()

                const getCodeTransformationRequest = {
                    transformationJobId: request.TransformationJobId,
                } as GetTransformationRequest
                response = await this.serviceManager
                    .getCodewhispererService()
                    .codeModernizerGetCodeTransformation(getCodeTransformationRequest)
                this.logging.log('Transformation status: ' + response.transformationJob?.status)

                if (validExitStatus.includes(status)) {
                    this.logging.log('Exiting polling for transformation plan with transformation status: ' + status)
                    break
                }

                status = response.transformationJob?.status!
                await Utils.sleep(10 * 1000)
                timer += 10

                if (timer > 24 * 3600 * 1000) {
                    status = PollTransformationStatus.TIMEOUT
                    break
                }
                getTransformAttempt = 0 // a successful polling will reset attempt
            } catch (e: any) {
                const errorMessage = (e as Error).message ?? 'Error in GetTransformation API call'
                this.logging.log('Error polling transformation job from the server: ' + errorMessage)

                getTransformAttempt += 1
                if (getTransformAttempt >= getTransformMaxAttempts) {
                    this.logging.log(`GetTransformation failed after ${getTransformMaxAttempts} attempts.`)
                    status = PollTransformationStatus.NOT_FOUND
                    break
                }

                const expDelayMs = Utils.getExpDelayForApiRetryMs(getTransformAttempt)
                this.logging.log(
                    `Attempt ${getTransformAttempt}/${getTransformMaxAttempts} to get transformation plan failed, retry in ${expDelayMs} seconds`
                )
                await Utils.sleep(expDelayMs * 1000)
            }
        }
        this.logging.log('Returning response from server : ' + JSON.stringify(response))
        this.logSuggestionForFailureResponse(request, response.transformationJob, failureStates)
        return {
            TransformationJob: response.transformationJob,
        } as GetTransformResponse
    }

    async downloadExportResultArchive(exportId: string, saveToDir: string) {
        let result
        try {
            result = await this.serviceManager.getStreamingClient().exportResultArchive({
                exportId,
                exportIntent: ExportIntent.TRANSFORMATION,
            })

            const buffer = []
            this.logging.log('Artifact was successfully downloaded.')

            if (result.body === undefined) {
                throw new Error('Empty response from CodeWhisperer streaming service.')
            }

            for await (const chunk of result.body) {
                if (chunk.binaryPayloadEvent) {
                    const chunkData = chunk.binaryPayloadEvent
                    if (chunkData.bytes) {
                        buffer.push(chunkData.bytes)
                    }
                }
            }
            const saveToWorkspace = path.join(saveToDir, workspaceFolderName)
            this.logging.log(`Identified path of directory to save artifacts is ${saveToDir}`)
            const pathContainingArchive = await this.archivePathGenerator(exportId, buffer, saveToWorkspace)
            this.logging.log('PathContainingArchive :' + pathContainingArchive)
            return {
                PathTosave: pathContainingArchive,
            } as DownloadArtifactsResponse
        } catch (error) {
            const errorMessage = (error as Error).message ?? 'Failed to download the artifacts'
            return {
                Error: errorMessage,
            } as DownloadArtifactsResponse
        }
    }

    async cancelPollingAsync() {
        this.cancelPollingEnabled = true
    }

    async extractAllEntriesTo(pathContainingArchive: string, zipEntries: AdmZip.IZipEntry[]) {
        // Skips any entry that would be written outside pathContainingArchive
        await Utils.extractAllEntriesTo(pathContainingArchive, zipEntries, this.logging)
    }

    async archivePathGenerator(exportId: string, buffer: Uint8Array[], saveToDir: string) {
        // The job ID names the folder in saveToDir that the archive is extracted to
        if (!exportId || exportId === '.' || exportId === '..' || path.basename(exportId) !== exportId) {
            throw new Error('Invalid transformation job ID')
        }
        try {
            const tempDir = path.join(saveToDir, exportId)
            const pathToArchive = path.join(tempDir, 'ExportResultsArchive.zip')
            await Utils.directoryExists(tempDir)
            await fs.writeFileSync(pathToArchive, Buffer.concat(buffer))
            let pathContainingArchive = ''
            pathContainingArchive = path.dirname(pathToArchive)
            const zip = new AdmZip(pathToArchive)
            const zipEntries = zip.getEntries()
            await this.extractAllEntriesTo(pathContainingArchive, zipEntries)
            return pathContainingArchive
        } catch (error) {
            this.logging.log(`error received ${JSON.stringify(error)}`)
            return ''
        }
    }

    logSuggestionForFailureResponse(
        request: GetTransformRequest,
        job: TransformationJob | undefined,
        failureStates: string[]
    ) {
        let status = job?.status ?? PollTransformationStatus.NOT_FOUND
        let reason = job?.reason ?? ''
        if (failureStates.includes(status)) {
            let suggestion = ''
            if (reason.toLowerCase().includes('build validation failed')) {
                suggestion =
                    'Please close Visual Studio, delete the directories where build artifacts are generated (e.g. bin and obj), and try running the transformation again.'
            }
            this.logging.log(`Transformation job for job ${request.TransformationJobId} is ${status} due to "${reason}".
                ${suggestion}`)
        }
    }
}
