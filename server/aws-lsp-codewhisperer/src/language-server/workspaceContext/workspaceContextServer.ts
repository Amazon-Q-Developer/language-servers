import {
    CancellationToken,
    GetConfigurationFromServerParams,
    InitializeParams,
    Server,
    WorkspaceFolder,
} from '@aws/language-server-runtimes/server-interface'
import * as crypto from 'crypto'
import { getRelativePath, isDirectory, isEmptyDirectory, isLoggedInUsingBearerToken } from './util'
import {
    ArtifactManager,
    FileMetadata,
    IGNORE_PATTERNS,
    SUPPORTED_WORKSPACE_CONTEXT_LANGUAGES,
} from './artifactManager'
import { WorkspaceFolderManager } from './workspaceFolderManager'
import { URI } from 'vscode-uri'
import { DependencyDiscoverer } from './dependency/dependencyDiscoverer'
import { getCodeWhispererLanguageIdFromPath } from '../../shared/languageDetection'
import { makeUserContextObject } from '../../shared/telemetryUtils'
import { safeGet } from '../../shared/utils'
import { AmazonQTokenServiceManager } from '../../shared/amazonQServiceManager/AmazonQTokenServiceManager'
import { FileUploadJobManager, FileUploadJobType } from './fileUploadJobManager'
import { DependencyEvent, DependencyEventBundler } from './dependency/dependencyEventBundler'
import ignore = require('ignore')
import { BUILDER_ID_START_URL, INTERNAL_USER_START_URL } from '../../shared/constants'

const Q_CONTEXT_CONFIGURATION_SECTION = 'aws.q.workspaceContext'

const ig = ignore().add(IGNORE_PATTERNS)

function shouldIgnoreFile(workspaceFolder: WorkspaceFolder, fileUri: string): boolean {
    const relativePath = getRelativePath(workspaceFolder, fileUri).replace(/\\/g, '/') // normalize for cross-platform
    return ig.ignores(relativePath)
}

export const WorkspaceContextServer = (): Server => features => {
    const { agent, credentialsProvider, workspace, logging, lsp, runtime, sdkInitializator } = features

    let workspaceIdentifier: string = ''
    let workspaceFolders: WorkspaceFolder[] = []
    let artifactManager: ArtifactManager
    let dependencyDiscoverer: DependencyDiscoverer
    let workspaceFolderManager: WorkspaceFolderManager
    let fileUploadJobManager: FileUploadJobManager
    let dependencyEventBundler: DependencyEventBundler
    let workflowInitializationInterval: NodeJS.Timeout
    let isWorkflowInitializing: boolean = false
    let isWorkflowInitialized: boolean = false
    let isOptedIn: boolean = false
    let abTestingEvaluated = false
    let abTestingEnabled = false
    let semanticSearchAbTestingEnabled = false
    let amazonQServiceManager: AmazonQTokenServiceManager
    let allowedExtension: string[] = ['AmazonQ-For-VSCode', 'Amazon Q For JetBrains']
    let isSupportedExtension = false

    lsp.addInitializer((params: InitializeParams) => {
        let clientExtension = params.initializationOptions?.aws?.clientInfo?.extension.name || ''
        if (!allowedExtension.includes(clientExtension)) {
            logging.warn(`Server context is currently not supported in ${clientExtension}`)
            return {
                capabilities: {},
            }
        } else {
            isSupportedExtension = true
        }

        workspaceIdentifier = params.initializationOptions?.aws?.contextConfiguration?.workspaceIdentifier || ''
        if (!workspaceIdentifier) {
            logging.warn(`No workspaceIdentifier set. Treating this workspace as a temporary session.`)
            workspaceIdentifier = crypto.randomUUID()
        }

        const folders = workspace.getAllWorkspaceFolders()
        workspaceFolders = folders || params.workspaceFolders || []

        if (!folders) {
            logging.warn(`No workspace folders set during initialization`)
        }

        return {
            capabilities: {
                workspace: {
                    workspaceFolders: {
                        supported: true,
                        changeNotifications: true,
                    },
                    fileOperations: {
                        didCreate: {
                            filters: [
                                { pattern: { glob: '**/*.{ts,js,py,java}', matches: 'file' } },
                                { pattern: { glob: '**/*', matches: 'folder' } },
                            ],
                        },
                        didRename: {
                            filters: [
                                { pattern: { glob: '**/*.{ts,js,py,java}', matches: 'file' } },
                                { pattern: { glob: '**/*', matches: 'folder' } },
                            ],
                        },
                        didDelete: {
                            filters: [
                                { pattern: { glob: '**/*.{ts,js,py,java}', matches: 'file' } },
                                { pattern: { glob: '**/*', matches: 'folder' } },
                            ],
                        },
                    },
                },
            },
            awsServerCapabilities: {
                configurationProvider: { sections: [Q_CONTEXT_CONFIGURATION_SECTION] },
            },
        }
    })

    lsp.extensions.onGetConfigurationFromServer(
        async (params: GetConfigurationFromServerParams, token: CancellationToken) => {
            if (params.section === Q_CONTEXT_CONFIGURATION_SECTION) {
                // Only append workspaceId to GenerateCompletions when WebSocket client is connected
                if (
                    !workspaceFolderManager.getWorkspaceState().webSocketClient?.isConnected() ||
                    !workspaceFolderManager.getWorkspaceState().workspaceId
                ) {
                    return {
                        workspaces: [],
                    }
                }

                return {
                    workspaces: workspaceFolders.map(workspaceFolder => ({
                        workspaceRoot: workspaceFolder.uri,
                        workspaceId: workspaceFolderManager.getWorkspaceState().workspaceId,
                    })),
                }
            }
            return {
                workspace: [],
            }
        }
    )

    const updateConfiguration = async () => {
        try {
            // Guard: workspaceFolderManager may not be initialized yet if didChangeConfiguration
            // fires before onInitialized completes (race condition observed in V2160933004)
            if (!workspaceFolderManager) {
                logging.log(`updateConfiguration called before workspaceFolderManager initialized, skipping`)
                return
            }

            const clientInitializParams = safeGet(lsp.getClientInitializeParams())
            const extensionName = clientInitializParams.initializationOptions?.aws?.clientInfo?.extension.name
            logging.log(
                `updateConfiguration: extensionName=${extensionName}, isSupportedExtension=${isSupportedExtension}`
            )
            if (extensionName === 'AmazonQ-For-VSCode') {
                const amazonQSettings = (await lsp.workspace.getConfiguration('amazonQ'))?.['server-sideContext']
                isOptedIn = amazonQSettings || false

                // We want this temporary override for Amazon internal users and BuilderId users who are still using
                // the old VSCode extension versions. Will remove this later.
                if (amazonQSettings === undefined) {
                    const startUrl = credentialsProvider.getConnectionMetadata()?.sso?.startUrl
                    const isInternalOrBuilderIdUser =
                        startUrl &&
                        (startUrl.includes(INTERNAL_USER_START_URL) || startUrl.includes(BUILDER_ID_START_URL))
                    if (isInternalOrBuilderIdUser) {
                        isOptedIn = true
                    }
                }
            } else {
                isOptedIn = (await lsp.workspace.getConfiguration('aws.codeWhisperer'))?.['workspaceContext'] || false
            }
            logging.log(`Workspace context server opt-in flag is: ${isOptedIn}`)

            if (!isOptedIn) {
                logging.log(
                    `User opted out, clearing workspace resources. isWorkflowInitialized=${isWorkflowInitialized}`
                )
                isWorkflowInitialized = false
                fileUploadJobManager?.dispose()
                dependencyEventBundler?.dispose()
                workspaceFolderManager.clearAllWorkspaceResources()
                // Delete remote workspace when user chooses to opt-out
                await workspaceFolderManager.deleteRemoteWorkspace()
            }
        } catch (error) {
            logging.error(`Error in getConfiguration: ${error}`)
        }
    }

    const evaluateABTesting = async () => {
        if (abTestingEvaluated) {
            return
        }

        try {
            const clientParams = safeGet(lsp.getClientInitializeParams())
            const userContext = makeUserContextObject(
                clientParams,
                runtime.platform,
                'CodeWhisperer',
                amazonQServiceManager.serverInfo
            ) ?? {
                ideCategory: 'VSCODE',
                operatingSystem: 'MAC',
                product: 'CodeWhisperer',
            }
            const result = await amazonQServiceManager.getCodewhispererService().listFeatureEvaluations({ userContext })
            result.featureEvaluations?.forEach(feature => {
                logging.log(`A/B Cohort Assignment feature: ${feature.feature} - variation: ${feature.variation}`)
            })
            abTestingEnabled =
                result.featureEvaluations?.some(
                    feature =>
                        feature.feature === 'BuilderIdServiceSideProjectContext' && feature.variation === 'TREATMENT'
                ) ?? false
            semanticSearchAbTestingEnabled =
                result.featureEvaluations?.some(
                    feature => feature.feature === 'SematicSearchTool' && feature.variation === 'TREATMENT'
                ) ?? false
            const startUrl = credentialsProvider.getConnectionMetadata()?.sso?.startUrl
            if (startUrl && startUrl.includes(INTERNAL_USER_START_URL)) {
                // Overriding abTestingEnabled to true for all internal users
                abTestingEnabled = true
            }
            logging.info(
                `A/B testing enabled: ${abTestingEnabled} semantic search enabled ${semanticSearchAbTestingEnabled}`
            )
            abTestingEvaluated = true
        } catch (error: any) {
            logging.error(`Error while checking A/B status: ${error.code}`)
            abTestingEnabled = false
            abTestingEvaluated = true
        }
    }

    const isUserEligibleForWorkspaceContext = () => {
        return (
            isOptedIn &&
            isLoggedInUsingBearerToken(credentialsProvider) &&
            abTestingEnabled &&
            !workspaceFolderManager.getOptOutStatus() &&
            !workspaceFolderManager.isFeatureDisabled() &&
            workspaceIdentifier
        )
    }

    lsp.onInitialized(async params => {
        try {
            if (!isSupportedExtension) {
                return {}
            }
            amazonQServiceManager = AmazonQTokenServiceManager.getInstance()

            artifactManager = new ArtifactManager(workspace, logging, workspaceFolders)
            dependencyDiscoverer = new DependencyDiscoverer(workspace, logging, workspaceFolders, artifactManager)
            workspaceFolderManager = WorkspaceFolderManager.createInstance(
                agent,
                amazonQServiceManager,
                logging,
                artifactManager,
                dependencyDiscoverer,
                workspaceFolders,
                credentialsProvider,
                workspaceIdentifier
            )
            fileUploadJobManager = new FileUploadJobManager(logging, workspaceFolderManager)
            dependencyEventBundler = new DependencyEventBundler(logging, dependencyDiscoverer, workspaceFolderManager)
            await updateConfiguration()

            lsp.workspace.onDidChangeWorkspaceFolders(async params => {
                const addedFolders = params.event.added

                if (addedFolders.length > 0) {
                    workspaceFolders.push(...addedFolders)
                }

                const removedFolders = params.event.removed
                if (removedFolders.length > 0) {
                    for (const folder of removedFolders) {
                        const index = workspaceFolders.findIndex(f => f.uri === folder.uri)
                        if (index !== -1) {
                            workspaceFolders.splice(index, 1)
                        }
                    }
                }

                workspaceFolderManager.updateWorkspaceFolders(workspaceFolders)

                if (!isUserEligibleForWorkspaceContext()) {
                    return
                }

                if (addedFolders.length > 0) {
                    await workspaceFolderManager.processNewWorkspaceFolders(addedFolders)
                }
                if (removedFolders.length > 0) {
                    await workspaceFolderManager.processWorkspaceFoldersDeletion(removedFolders)
                }
            })
            /**
             * The below code checks the login state of the workspace and initializes the workspace
             * folders. *isWorkflowInitialized* variable is used to keep track if the workflow has been initialized
             * or not to prevent it from initializing again. However, there can be a case when user logs out, does some
             * activity with removing or adding workspace folders, and logs back in. To handle this case- the new state
             * of workspace folders is updated using *artifactManager.updateWorkspaceFolders(workspaceFolders)* before
             * initializing again.
             */
            const initializeWorkflow = async () => {
                if (!isOptedIn) {
                    return
                }
                const isLoggedIn = isLoggedInUsingBearerToken(credentialsProvider)
                if (isLoggedIn && !isWorkflowInitialized) {
                    try {
                        // getCodewhispererService only returns the cwspr client if the service manager was initialized i.e. profile was selected otherwise it throws an error
                        // we will not evaluate a/b status until profile is selected and service manager is fully initialized
                        amazonQServiceManager.getCodewhispererService()
                    } catch (e) {
                        return
                    }

                    await evaluateABTesting()
                    isWorkflowInitialized = true
                    workspaceFolderManager.setSemanticSearchToolStatus(semanticSearchAbTestingEnabled)

                    workspaceFolderManager.resetAdminOptOutAndFeatureDisabledStatus()
                    if (!isUserEligibleForWorkspaceContext()) {
                        return
                    }

                    fileUploadJobManager.startFileUploadJobConsumer()
                    dependencyEventBundler.startDependencyEventBundler()

                    workspaceFolderManager.initializeWorkspaceStatusMonitor()
                    logging.log(`Workspace context workflow initialized`)
                } else if (!isLoggedIn) {
                    if (isWorkflowInitialized) {
                        // If user is not logged in but the workflow is marked as initialized, it means user was logged in and is now logged out
                        // In this case, clear the resources and stop the monitoring
                        fileUploadJobManager?.dispose()
                        dependencyEventBundler?.dispose()
                        workspaceFolderManager.clearAllWorkspaceResources()
                    }
                    isWorkflowInitialized = false
                }
            }
            if (workflowInitializationInterval) {
                return
            }
            workflowInitializationInterval = setInterval(async () => {
                // Prevent multiple initializeWorkflow() execution from overlapping
                if (isWorkflowInitializing) {
                    return
                }
                isWorkflowInitializing = true
                try {
                    await initializeWorkflow()
                } catch (error) {
                    logging.error(`Error while initializing workflow: ${error}`)
                } finally {
                    isWorkflowInitializing = false
                }
            }, 5000)
        } catch (error) {
            logging.error(`Failed to initialize workspace context server: ${error}`)
        }
    })

    lsp.didChangeConfiguration(updateConfiguration)

    lsp.onDidSaveTextDocument(async event => {
        try {
            if (!isUserEligibleForWorkspaceContext()) {
                return
            }

            logging.log(`Received didSave event for ${event.textDocument.uri}`)

            const programmingLanguage = getCodeWhispererLanguageIdFromPath(event.textDocument.uri)
            if (!programmingLanguage || !SUPPORTED_WORKSPACE_CONTEXT_LANGUAGES.includes(programmingLanguage)) {
                return
            }

            const workspaceFolder = workspaceFolderManager.getWorkspaceFolder(event.textDocument.uri, workspaceFolders)
            if (!workspaceFolder) {
                return
            }

            if (shouldIgnoreFile(workspaceFolder, event.textDocument.uri)) {
                return
            }

            const fileMetadata = await artifactManager.processNewFile(workspaceFolder, event.textDocument.uri)

            fileUploadJobManager.jobQueue.push({
                eventType: FileUploadJobType.DID_SAVE_TEXT_DOCUMENT,
                fileMetadata: fileMetadata,
                file: event.textDocument,
            })
        } catch (error) {
            logging.error(`Error handling save event: ${error}`)
        }
    })

    lsp.workspace.onDidCreateFiles(async event => {
        try {
            if (!isUserEligibleForWorkspaceContext()) {
                return
            }
            logging.log(`Received didCreateFiles event of length ${event.files.length}`)

            for (const file of event.files) {
                const isDir = isDirectory(file.uri)
                const workspaceFolder = workspaceFolderManager.getWorkspaceFolder(file.uri, workspaceFolders)
                if (!workspaceFolder) {
                    continue
                }

                if (shouldIgnoreFile(workspaceFolder, file.uri)) {
                    continue
                }

                const programmingLanguage = getCodeWhispererLanguageIdFromPath(file.uri)
                if (!programmingLanguage || !SUPPORTED_WORKSPACE_CONTEXT_LANGUAGES.includes(programmingLanguage)) {
                    continue
                }

                let filesMetadata: FileMetadata[] = []
                if (isDir && isEmptyDirectory(file.uri)) {
                    continue
                } else if (isDir) {
                    filesMetadata = await artifactManager.addNewDirectories([URI.parse(file.uri)], workspaceFolder)
                } else {
                    filesMetadata = [await artifactManager.processNewFile(workspaceFolder, file.uri)]
                }

                for (const fileMetadata of filesMetadata) {
                    fileUploadJobManager.jobQueue.push({
                        eventType: FileUploadJobType.DID_CREATE_FILE,
                        fileMetadata: fileMetadata,
                        file: file,
                    })
                }
            }
        } catch (error) {
            logging.error(`Error handling create event: ${error}`)
        }
    })

    lsp.workspace.onDidDeleteFiles(async event => {
        try {
            if (!isUserEligibleForWorkspaceContext()) {
                return
            }

            logging.log(`Received didDeleteFiles event of length ${event.files.length}`)

            const workspaceState = workspaceFolderManager.getWorkspaceState()
            for (const file of event.files) {
                const workspaceFolder = workspaceFolderManager.getWorkspaceFolder(file.uri, workspaceFolders)
                if (!workspaceFolder) {
                    continue
                }

                const programmingLanguages = artifactManager.handleDeletedPathAndGetLanguages(file.uri, workspaceFolder)
                if (programmingLanguages.length === 0) {
                    continue
                }

                const workspaceId = workspaceState.workspaceId
                if (!workspaceId) {
                    continue
                }

                // Send notification for each programming language
                for (const language of programmingLanguages) {
                    const message = JSON.stringify({
                        method: 'workspace/didDeleteFiles',
                        params: {
                            files: [
                                {
                                    uri: file.uri,
                                },
                            ],
                            workspaceChangeMetadata: {
                                workspaceId: workspaceId,
                                programmingLanguage: language,
                            },
                        },
                    })
                    workspaceState.messageQueue.push(message)
                }
            }
        } catch (error) {
            logging.error(`Error handling delete event: ${error}`)
        }
    })

    lsp.workspace.onDidRenameFiles(async event => {
        try {
            if (!isUserEligibleForWorkspaceContext()) {
                return
            }

            logging.log(`Received didRenameFiles event of length ${event.files.length}`)

            for (const file of event.files) {
                const workspaceFolder = workspaceFolderManager.getWorkspaceFolder(file.newUri, workspaceFolders)
                if (!workspaceFolder) {
                    continue
                }

                if (shouldIgnoreFile(workspaceFolder, file.newUri)) {
                    continue
                }

                const filesMetadata = await artifactManager.handleRename(workspaceFolder, file.oldUri, file.newUri)

                for (const fileMetadata of filesMetadata) {
                    fileUploadJobManager.jobQueue.push({
                        eventType: FileUploadJobType.DID_RENAME_FILE,
                        fileMetadata: fileMetadata,
                        file: file,
                    })
                }
            }
        } catch (error) {
            logging.error(`Error handling rename event: ${error}`)
        }
    })

    lsp.extensions.onDidChangeDependencyPaths(async params => {
        try {
            const dependencyEvent: DependencyEvent = {
                language: params.runtimeLanguage,
                paths: params.paths,
                workspaceFolderUri: params.moduleName,
            }
            DependencyEventBundler.recordDependencyEvent(dependencyEvent)

            if (!isUserEligibleForWorkspaceContext()) {
                return
            }

            // Only send events separately when dependency discovery has finished ingesting previous recorded events
            if (dependencyDiscoverer.isDependencyEventsIngested(params.moduleName)) {
                dependencyEventBundler.sendDependencyEvent(dependencyEvent)
                logging.log(`Processed onDidChangeDependencyPaths event for ${params.moduleName}`)
            }
        } catch (error) {
            logging.error(`Error handling didChangeDependencyPaths event: ${error}`)
        }
    })

    logging.log('Workspace context server has been initialized')

    return () => {
        clearInterval(workflowInitializationInterval)
        if (fileUploadJobManager) {
            fileUploadJobManager.dispose()
        }
        if (dependencyEventBundler) {
            dependencyEventBundler.dispose()
        }
        if (workspaceFolderManager) {
            workspaceFolderManager.clearAllWorkspaceResources()
        }
    }
}
