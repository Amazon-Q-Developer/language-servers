import {
    CancellationToken,
    ExecuteCommandParams,
    InitializeParams,
    MessageType,
    Server,
} from '@aws/language-server-runtimes/server-interface'
import { AtxTokenServiceManager } from '../../shared/amazonQServiceManager/AtxTokenServiceManager'
import { ATXTransformHandler } from './atxTransformHandler'
import { AtxTransformHandlerLegacy } from './atxTransformHandlerLegacy'
import {
    AtxListOrCreateWorkspaceRequest,
    AtxListJobsRequest,
    AtxStartTransformRequest,
    AtxGetTransformInfoRequest,
    AtxStopJobRequest,
    AtxUploadPlanRequest,
    AtxSetCheckpointsRequest,
    AtxUpdateWorkspaceRequest,
    AtxUploadPackagesRequest,
    AtxListArtifactsRequest,
    AtxDownloadArtifactRequest,
    AtxCompleteLocalBuildHitlRequest,
    AtxGetJobDashboardRequest,
    AtxGetJobReportRequest,
    AtxUploadCustomPlanRequest,
    AtxLoadOlderWorklogsRequest,
} from './atxModels'

// ATX FES Commands - Consolidated APIs
const AtxListOrCreateWorkspaceCommand = 'aws/atxTransform/listOrCreateWorkspace'
const AtxListJobsCommand = 'aws/atxTransform/listJobs'
const AtxStartTransformCommand = 'aws/atxTransform/startTransform'
const AtxGetTransformInfoCommand = 'aws/atxTransform/getTransformInfo'
const AtxStopJobCommand = 'aws/atxTransform/stopJob'
const AtxUploadPlanCommand = 'aws/atxTransform/uploadPlan'
const AtxSetCheckpointsCommand = 'aws/atxTransform/setCheckpoints'
const AtxUpdateWorkspaceCommand = 'aws/atxTransform/updateWorkspace'
const AtxUploadPackagesCommand = 'aws/atxTransform/uploadPackages'
const AtxSendMessageCommand = 'aws/atxTransform/sendMessage'
const AtxListMessagesCommand = 'aws/atxTransform/listMessages'
const AtxBatchGetMessagesCommand = 'aws/atxTransform/batchGetMessages'
const AtxListArtifactsCommand = 'aws/atxTransform/listArtifacts'
const AtxDownloadArtifactCommand = 'aws/atxTransform/downloadArtifact'
const AtxCompleteLocalBuildHitlCommand = 'aws/atxTransform/completeLocalBuildHitl'
const AtxGetJobDashboardCommand = 'aws/atxTransform/getJobDashboard'
const AtxGetJobReportCommand = 'aws/atxTransform/getJobReport'
const AtxUploadCustomPlanCommand = 'aws/atxTransform/uploadCustomPlan'
const AtxLoadOlderWorklogsCommand = 'aws/atxTransform/loadOlderWorklogs'
// Beam to IDE
const AtxListBeamedReposCommand = 'aws/atxTransform/listBeamedRepos'
const AtxDownloadBeamArtifactCommand = 'aws/atxTransform/downloadBeamArtifact'

export const AtxNetTransformServerToken =
    (): Server =>
    ({ workspace, logging, lsp, telemetry, runtime }) => {
        let atxTokenServiceManager: AtxTokenServiceManager
        let atxTransformHandler: ATXTransformHandler
        let atxTransformHandlerLegacy: AtxTransformHandlerLegacy

        const runAtxTransformCommand = async (params: ExecuteCommandParams, _token: CancellationToken) => {
            try {
                switch (params.command) {
                    case AtxListOrCreateWorkspaceCommand: {
                        const request = params as AtxListOrCreateWorkspaceRequest
                        const result = await atxTransformHandler.listOrCreateWorkspace(request)
                        return result
                    }
                    case AtxListJobsCommand: {
                        const { WorkspaceId } = params as AtxListJobsRequest
                        if (!WorkspaceId) {
                            throw new Error('WorkspaceId is required for listJobs')
                        }
                        const result = await atxTransformHandler.listJobs(WorkspaceId)
                        return result
                    }
                    case AtxStartTransformCommand: {
                        const { WorkspaceId, JobName, InteractiveMode, StartTransformRequest, useOrchestratorAgent } =
                            params as AtxStartTransformRequest
                        const useNew = useOrchestratorAgent === true

                        if (!useNew) {
                            const msg =
                                'This version of AWS Toolkit with Amazon Q is no longer supported for transformations. Please update to the latest version of AWS Toolkit with Amazon Q to continue using AWS Transform.'
                            try {
                                await lsp.window.showMessage({ type: MessageType.Error, message: msg })
                            } catch {
                                // Best-effort notification — proceed with rejection regardless
                            }
                            throw new Error(msg)
                        }

                        if (!WorkspaceId) {
                            throw new Error('WorkspaceId is required for startTransform')
                        }

                        logging.log(`ATX Server: Routing startTransform -> NEW handler`)
                        const handler = atxTransformHandler
                        const result = await handler.startTransform({
                            workspaceId: WorkspaceId,
                            jobName: JobName,
                            interactiveMode: InteractiveMode,
                            startTransformRequest: StartTransformRequest,
                        })

                        if (!result) {
                            throw new Error('StartTransform workflow failed')
                        }

                        return {
                            TransformationJobId: result.TransformationJobId,
                            ArtifactPath: result.ArtifactPath || '',
                            UploadId: result.UploadId || '',
                            UnSupportedProjects: [],
                            ContainsUnsupportedViews: false,
                        }
                    }
                    case AtxGetTransformInfoCommand: {
                        const request = params as AtxGetTransformInfoRequest
                        const useNew = request.useOrchestratorAgent === true
                        logging.log(`ATX Server: Routing getTransformInfo -> ${useNew ? 'NEW' : 'LEGACY'} handler`)
                        return useNew
                            ? await atxTransformHandler.getTransformInfo(request)
                            : await atxTransformHandlerLegacy.getTransformInfo(request)
                    }
                    case AtxUploadPlanCommand: {
                        const request = params as AtxUploadPlanRequest
                        const useNew = request.useOrchestratorAgent === true
                        logging.log(`ATX Server: Routing uploadPlan -> ${useNew ? 'NEW' : 'LEGACY'} handler`)
                        return useNew
                            ? await atxTransformHandler.uploadPlan(request)
                            : await atxTransformHandlerLegacy.uploadPlan(request)
                    }
                    case AtxStopJobCommand: {
                        const { WorkspaceId, JobId } = params as AtxStopJobRequest

                        if (!WorkspaceId || !JobId) {
                            throw new Error('WorkspaceId and JobId are required for stopJob')
                        }

                        const result = await atxTransformHandler.stopJob(WorkspaceId, JobId)
                        return { Status: result }
                    }
                    case AtxSetCheckpointsCommand: {
                        const { WorkspaceId, TransformationJobId, SolutionRootPath, Checkpoints, InteractiveMode } =
                            params as AtxSetCheckpointsRequest

                        logging.info(
                            `ATX: setCheckpoints params - InteractiveMode=${InteractiveMode}, Checkpoints=${JSON.stringify(Checkpoints)}`
                        )

                        return await atxTransformHandler.setCheckpoints(
                            WorkspaceId,
                            TransformationJobId,
                            SolutionRootPath,
                            Checkpoints || {},
                            InteractiveMode
                        )
                    }
                    case AtxUpdateWorkspaceCommand: {
                        const { WorkspaceId, TransformationJobId, StepId, SolutionRootPath } =
                            params as AtxUpdateWorkspaceRequest

                        return await atxTransformHandler.updateWorkspace(
                            WorkspaceId,
                            TransformationJobId,
                            SolutionRootPath,
                            StepId
                        )
                    }
                    case AtxUploadPackagesCommand: {
                        const request = params as AtxUploadPackagesRequest
                        return await atxTransformHandler.uploadPackages(request)
                    }
                    case AtxSendMessageCommand: {
                        const { workspaceId, jobId, text, skipPolling, beamStepId } = params as any
                        return await atxTransformHandler.sendMessage({
                            workspaceId,
                            jobId,
                            text,
                            skipPolling,
                            beamStepId,
                        })
                    }
                    case AtxListMessagesCommand: {
                        const { workspaceId, jobId, maxResults, nextToken, startTimestamp } = params as any
                        return await atxTransformHandler.listMessages({
                            workspaceId,
                            jobId,
                            maxResults,
                            nextToken,
                            startTimestamp: startTimestamp ? new Date(startTimestamp) : undefined,
                        })
                    }
                    case AtxBatchGetMessagesCommand: {
                        const { workspaceId, messageIds } = params as any
                        return await atxTransformHandler.batchGetMessages({
                            workspaceId,
                            messageIds,
                        })
                    }
                    case AtxListArtifactsCommand: {
                        const { WorkspaceId, TransformationJobId } = params as AtxListArtifactsRequest
                        logging.log(
                            `ATX: ListArtifacts command received - WorkspaceId: ${WorkspaceId}, JobId: ${TransformationJobId}`
                        )
                        return await atxTransformHandler.listArtifactsForDownload(WorkspaceId, TransformationJobId)
                    }
                    case AtxDownloadArtifactCommand: {
                        const { WorkspaceId, TransformationJobId, ArtifactId, ArtifactName, SavePath } =
                            params as AtxDownloadArtifactRequest
                        return await atxTransformHandler.downloadArtifactToPath(
                            WorkspaceId,
                            TransformationJobId,
                            ArtifactId,
                            SavePath,
                            ArtifactName
                        )
                    }
                    case AtxCompleteLocalBuildHitlCommand: {
                        const { WorkspaceId, TransformationJobId, TaskId, BuildResultJson, SolutionRootPath } =
                            params as AtxCompleteLocalBuildHitlRequest

                        if (typeof BuildResultJson !== 'string' || BuildResultJson.length === 0) {
                            throw new Error('BuildResultJson is required for completeLocalBuildHitl')
                        }

                        logging.log(
                            `ATX: completeLocalBuildHitl received — jobId=${TransformationJobId} taskId=${TaskId} bodyLen=${BuildResultJson.length}`
                        )

                        return await atxTransformHandler.completeHitlWithBuildResults(
                            WorkspaceId,
                            TransformationJobId,
                            TaskId,
                            BuildResultJson,
                            SolutionRootPath
                        )
                    }
                    case AtxGetJobDashboardCommand: {
                        const { WorkspaceId, JobId } = params as AtxGetJobDashboardRequest

                        if (!WorkspaceId || !JobId) {
                            throw new Error('WorkspaceId and JobId are required for getJobDashboard')
                        }

                        return await atxTransformHandler.getJobDashboard(WorkspaceId, JobId)
                    }
                    case AtxGetJobReportCommand: {
                        const { WorkspaceId, JobId, ArtifactId } = params as AtxGetJobReportRequest

                        if (!WorkspaceId || !JobId || !ArtifactId) {
                            throw new Error('WorkspaceId, JobId and ArtifactId are required for getJobReport')
                        }

                        return await atxTransformHandler.getJobReport(WorkspaceId, JobId, ArtifactId)
                    }
                    case AtxUploadCustomPlanCommand: {
                        const request = params as AtxUploadCustomPlanRequest
                        return await atxTransformHandler.uploadCustomPlan(request)
                    }
                    case AtxLoadOlderWorklogsCommand: {
                        const request = params as AtxLoadOlderWorklogsRequest
                        if (!request.workspaceId || !request.jobId || !request.solutionRootPath) {
                            throw new Error(
                                'workspaceId, jobId and solutionRootPath are required for loadOlderWorklogs'
                            )
                        }
                        return await atxTransformHandler.loadOlderWorklogs(
                            request.workspaceId,
                            request.jobId,
                            request.solutionRootPath,
                            request.nextToken
                        )
                    }
                    // ---- Beam to IDE ----
                    case AtxListBeamedReposCommand: {
                        // PascalCase params/return to match the C# ExecuteCommandParams convention.
                        // Lightweight (optional): the poll-tick refresh sets it to skip the beam-map
                        // download scan (throttle-safe).
                        const { WorkspaceId, ParentJobId, Lightweight } = params as any
                        if (!WorkspaceId || !ParentJobId) {
                            throw new Error('WorkspaceId and ParentJobId are required for listBeamedRepos')
                        }
                        const repos = await atxTransformHandler.listBeamedRepos(
                            WorkspaceId,
                            ParentJobId,
                            Lightweight === true
                        )
                        return { Repos: repos }
                    }
                    case AtxDownloadBeamArtifactCommand: {
                        // PascalCase params to match the C# ExecuteCommandParams serialization
                        // convention used by every other C#-backed ATX command (e.g. downloadArtifact).
                        const { WorkspaceId, ParentJobId, BeamArtifactId, DestDir } = params as any
                        if (!WorkspaceId || !ParentJobId || !BeamArtifactId || !DestDir) {
                            throw new Error(
                                'WorkspaceId, ParentJobId, BeamArtifactId and DestDir are required for downloadBeamArtifact'
                            )
                        }
                        return await atxTransformHandler.downloadBeamArtifact(
                            WorkspaceId,
                            ParentJobId,
                            BeamArtifactId,
                            DestDir
                        )
                    }
                    default: {
                        throw new Error(`Unknown ATX FES command: ${params.command}`)
                    }
                }
            } catch (e: any) {
                logging.error(`ATXTransformServer: Error executing command: ${String(e)}`)
                return { error: true, message: e.message }
            }
        }

        const onExecuteCommandHandler = async (
            params: ExecuteCommandParams,
            _token: CancellationToken
        ): Promise<any> => {
            logging.info(`Received ATX FES command: ${params.command}`)
            return runAtxTransformCommand(params, _token)
        }

        const onInitializeHandler = async (params: InitializeParams) => {
            return {
                capabilities: {
                    executeCommandProvider: {
                        commands: [
                            AtxListOrCreateWorkspaceCommand,
                            AtxListJobsCommand,
                            AtxStartTransformCommand,
                            AtxGetTransformInfoCommand,
                            AtxUploadPlanCommand,
                            AtxStopJobCommand,
                            AtxSetCheckpointsCommand,
                            AtxUpdateWorkspaceCommand,
                            AtxUploadPackagesCommand,
                            AtxSendMessageCommand,
                            AtxListMessagesCommand,
                            AtxBatchGetMessagesCommand,
                            AtxListArtifactsCommand,
                            AtxDownloadArtifactCommand,
                            AtxCompleteLocalBuildHitlCommand,
                            AtxGetJobDashboardCommand,
                            AtxGetJobReportCommand,
                            AtxUploadCustomPlanCommand,
                            AtxLoadOlderWorklogsCommand,
                            AtxListBeamedReposCommand,
                            AtxDownloadBeamArtifactCommand,
                        ],
                    },
                },
            }
        }

        const onInitializedHandler = () => {
            logging.log('ATXTransformServer initialized (local-build-verification support enabled)')
            atxTokenServiceManager = AtxTokenServiceManager.getInstance()
            atxTransformHandler = new ATXTransformHandler(atxTokenServiceManager, workspace, logging, runtime)
            atxTransformHandlerLegacy = new AtxTransformHandlerLegacy(
                atxTokenServiceManager,
                workspace,
                logging,
                runtime
            )
        }

        lsp.addInitializer(onInitializeHandler)
        lsp.onInitialized(onInitializedHandler)
        lsp.onExecuteCommand(onExecuteCommandHandler)

        return () => {}
    }
