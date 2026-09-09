import {
    BearerCredentials,
    CredentialsProvider,
    CredentialsType,
    Workspace,
    Logging,
    SDKInitializator,
    CancellationToken,
    CancellationTokenSource,
    TextDocument,
    Position,
    WorkspaceFolder,
    InlineCompletionWithReferencesParams,
} from '@aws/language-server-runtimes/server-interface'
import { waitUntil } from '@aws/lsp-core/out/util/timeoutUtils'
import { AwsCredentialIdentity } from '@aws-sdk/types'
import { v4 as uuidv4 } from 'uuid'
import {
    CodeWhispererSigv4Client,
    CodeWhispererSigv4ClientConfigurationOptions,
    createCodeWhispererSigv4Client,
} from '../client/sigv4/codewhisperer'
import {
    CodeWhispererTokenClientConfigurationOptions,
    createCodeWhispererTokenClient,
    CodeWhispererTokenClient,
} from '../client/token/codewhisperer'
import { getErrorId } from './utils'
import { getRelativePath } from '../language-server/workspaceContext/util'
import { CodewhispererLanguage, getRuntimeLanguage } from './languageDetection'
import { RecentEditTracker } from '../language-server/inline-completion/tracker/codeEditTracker'
import { CodeWhispererSupplementalContext } from './models/model'
import { fetchSupplementalContext } from './supplementalContextUtil/supplementalContextUtil'
import * as path from 'path'
import {
    CONTEXT_CHARACTERS_LIMIT,
    FILE_URI_CHARS_LIMIT,
    FILENAME_CHARS_LIMIT,
} from '../language-server/inline-completion/contants/constants'
import {
    Completion,
    CreateSubscriptionTokenCommand,
    CreateSubscriptionTokenRequest,
    CreateSubscriptionTokenResponse,
    CreateUploadUrlCommand,
    CreateUploadUrlRequest,
    CreateWorkspaceCommand,
    CreateWorkspaceRequest,
    DeleteWorkspaceCommand,
    DeleteWorkspaceRequest,
    FeatureEvaluation,
    GenerateCompletionsCommand,
    GenerateCompletionsRequest,
    GenerateCompletionsResponse,
    GetCodeAnalysisCommand,
    GetCodeAnalysisRequest,
    GetProfileCommand,
    GetProfileRequest,
    GetTransformationCommand,
    GetTransformationPlanCommand,
    GetTransformationPlanRequest,
    GetTransformationRequest,
    ListAvailableCustomizationsCommand,
    ListAvailableCustomizationsRequest,
    ListAvailableModelsCommand,
    ListAvailableModelsRequest,
    ListAvailableProfilesCommand,
    ListAvailableProfilesRequest,
    ListCodeAnalysisFindingsCommand,
    ListCodeAnalysisFindingsRequest,
    ListFeatureEvaluationsCommand,
    ListFeatureEvaluationsCommandOutput,
    ListFeatureEvaluationsRequest,
    ListWorkspaceMetadataCommand,
    ListWorkspaceMetadataRequest,
    SendTelemetryEventCommand,
    SendTelemetryEventRequest,
    StartCodeAnalysisCommand,
    StartCodeAnalysisRequest,
    StartTransformationCommand,
    StartTransformationRequest,
    StopTransformationCommand,
    StopTransformationRequest,
    SupplementalContext,
    SupplementalContextType,
    UserContext,
} from '@amzn/codewhisperer-runtime'
import {
    GenerateRecommendationsCommand,
    GenerateRecommendationsRequest,
    GenerateRecommendationsResponse,
    Recommendation,
} from '@amzn/codewhisperer'

const featureConfigPollIntervalInMs = 180 * 60 * 1000 // 180 mins

const experimentName = 'MHS_TO_MPS_BEDROCK_INFERENCE_MIGRATION_30b'

// Type guards for request classification
export function isTokenRequest(request: GenerateSuggestionsRequest): request is GenerateTokenSuggestionsRequest {
    return 'editorState' in request || 'predictionTypes' in request || 'supplementalContexts' in request
}

export function isIAMRequest(request: GenerateSuggestionsRequest): request is GenerateIAMSuggestionsRequest {
    return !isTokenRequest(request)
}

export interface Suggestion extends Completion, Recommendation {
    itemId: string
}

// IAM-specific request interface that directly extends the SigV4 client request
export interface GenerateIAMSuggestionsRequest extends GenerateRecommendationsRequest {}

// Token-specific request interface that directly extends the Token client request
export interface GenerateTokenSuggestionsRequest extends GenerateCompletionsRequest {}

// Union type for backward compatibility
export type GenerateSuggestionsRequest = GenerateIAMSuggestionsRequest | GenerateTokenSuggestionsRequest

// FileContext type that's compatible with both clients
export type FileContext = {
    fileUri?: string // Optional in both clients
    filename: string
    programmingLanguage: {
        languageName: string
    }
    leftFileContent: string
    rightFileContent: string
}

export interface ResponseContext {
    requestId: string | undefined
    codewhispererSessionId: string
    nextToken?: string
    authType?: 'iam' | 'token'
}

export enum SuggestionType {
    EDIT = 'EDITS',
    COMPLETION = 'COMPLETIONS',
}

export interface GenerateSuggestionsResponse {
    suggestions: Suggestion[]
    suggestionType?: SuggestionType
    responseContext: ResponseContext
}

export class ClientFileContextClss {
    readonly leftFileContent: string
    readonly rightFileContent: string
    readonly filename: string
    readonly fileUri: string
    readonly programmingLanguage: {
        languageName: CodewhispererLanguage
    }
    readonly leftContextAtCurLine: string
    readonly rightContextAtCurLine: string

    constructor(params: {
        textDocument: TextDocument
        position: Position
        inferredLanguageId: CodewhispererLanguage
        workspaceFolder: WorkspaceFolder | null | undefined
    }) {
        const left = params.textDocument.getText({
            start: { line: 0, character: 0 },
            end: params.position,
        })
        const trimmedLeft = left.slice(-CONTEXT_CHARACTERS_LIMIT).replaceAll('\r\n', '\n')

        const right = params.textDocument.getText({
            start: params.position,
            end: params.textDocument.positionAt(params.textDocument.getText().length),
        })
        const trimmedRight = right.slice(0, CONTEXT_CHARACTERS_LIMIT).replaceAll('\r\n', '\n')

        const relativeFilePath = params.workspaceFolder
            ? getRelativePath(params.workspaceFolder, params.textDocument.uri)
            : path.basename(params.textDocument.uri)

        this.fileUri = params.textDocument.uri.substring(0, FILE_URI_CHARS_LIMIT)
        this.filename = relativeFilePath.substring(0, FILENAME_CHARS_LIMIT)
        this.programmingLanguage = {
            languageName: getRuntimeLanguage(params.inferredLanguageId),
        }
        this.leftFileContent = trimmedLeft
        this.rightFileContent = trimmedRight

        this.leftContextAtCurLine = params.textDocument.getText({
            start: { line: params.position.line, character: 0 },
            end: { line: params.position.line, character: params.position.character },
        })

        this.rightContextAtCurLine = params.textDocument.getText({
            start: { line: params.position.line, character: params.position.character },
            end: { line: params.position.line, character: Number.MAX_VALUE },
        })
    }

    toServiceModel(): FileContext {
        return {
            fileUri: this.fileUri,
            filename: this.filename,
            programmingLanguage: this.programmingLanguage,
            leftFileContent: this.leftFileContent,
            rightFileContent: this.rightFileContent,
        }
    }
}

export function getFileContext(params: {
    textDocument: TextDocument
    position: Position
    inferredLanguageId: CodewhispererLanguage
    workspaceFolder: WorkspaceFolder | null | undefined
}): ClientFileContextClss {
    return new ClientFileContextClss(params)
}

// This abstract class can grow in the future to account for any additional changes across the clients
export abstract class CodeWhispererServiceBase {
    protected readonly codeWhispererRegion
    protected readonly codeWhispererEndpoint
    public shareCodeWhispererContentWithAWS = false
    public customizationArn?: string
    public profileArn?: string
    abstract client: CodeWhispererSigv4Client | CodeWhispererTokenClient

    private _userContext: UserContext | undefined
    set userContext(u: UserContext | undefined) {
        this._userContext = u
    }
    get userContext(): UserContext | undefined {
        return this._userContext
    }

    protected lastFeatureConfigResp: ListFeatureEvaluationsCommandOutput | undefined

    inflightRequests: Set<AbortController> = new Set()

    abortInflightRequests() {
        this.inflightRequests.forEach(request => {
            request.abort()
        })
        this.inflightRequests.clear()
    }

    abstract getCredentialsType(): CredentialsType

    abstract generateSuggestions(request: GenerateSuggestionsRequest): Promise<GenerateSuggestionsResponse>

    abstract constructSupplementalContext(
        document: TextDocument,
        position: Position,
        workspace: Workspace,
        recentEditTracker: RecentEditTracker,
        logging: Logging,
        cancellationToken: CancellationToken,
        opentabs: InlineCompletionWithReferencesParams['openTabFilepaths'],
        config: { includeRecentEdits: boolean }
    ): Promise<
        | {
              supContextData: CodeWhispererSupplementalContext
              items: SupplementalContext[]
          }
        | undefined
    >

    abstract scheduleABTestingFetching(): Promise<void>

    constructor(codeWhispererRegion: string, codeWhispererEndpoint: string) {
        this.codeWhispererRegion = codeWhispererRegion
        this.codeWhispererEndpoint = codeWhispererEndpoint
    }

    generateItemId = () => uuidv4()

    async getSubscriptionStatus(
        statusOnly?: boolean
    ): Promise<{ status: 'active' | 'active-expiring' | 'none'; encodedVerificationUrl?: string }> {
        // No-op/default implementation: assume no subscription
        return {
            status: 'none',
        }
    }

    async waitUntilSubscriptionActive(_cancelToken?: CancellationToken): Promise<boolean> {
        // No-op: base class doesn't support subscription polling
        return false
    }
}

export class CodeWhispererServiceIAM extends CodeWhispererServiceBase {
    client: CodeWhispererSigv4Client
    constructor(
        credentialsProvider: CredentialsProvider,
        workspace: Workspace,
        logging: Logging,
        codeWhispererRegion: string,
        codeWhispererEndpoint: string,
        sdkInitializator: SDKInitializator
    ) {
        super(codeWhispererRegion, codeWhispererEndpoint)
        const options: CodeWhispererSigv4ClientConfigurationOptions = {
            region: this.codeWhispererRegion,
            endpoint: this.codeWhispererEndpoint,
            credentials: async () => {
                logging.info('CodeWhispererService IAM: Attempting to get credentials')

                try {
                    const creds = credentialsProvider.getCredentials('iam') as AwsCredentialIdentity
                    logging.info('CodeWhispererService IAM: Successfully got credentials')

                    return {
                        accessKeyId: creds.accessKeyId,
                        secretAccessKey: creds.secretAccessKey,
                        sessionToken: creds.sessionToken,
                        expiration: creds.expiration,
                    }
                } catch (err) {
                    if (err instanceof Error) {
                        logging.error(`CodeWhispererServiceIAM: Failed to get credentials: ${err.message}`)
                    }
                    throw err
                }
            },
        }
        this.client = createCodeWhispererSigv4Client(
            options,
            sdkInitializator,
            logging,
            this.shareCodeWhispererContentWithAWS
        )
    }

    getCredentialsType(): CredentialsType {
        return 'iam'
    }

    override async scheduleABTestingFetching(): Promise<void> {
        return
    }

    async constructSupplementalContext(
        document: TextDocument,
        position: Position,
        workspace: Workspace,
        recentEditTracker: RecentEditTracker,
        logging: Logging,
        cancellationToken: CancellationToken,
        opentabs: InlineCompletionWithReferencesParams['openTabFilepaths'],
        config: { includeRecentEdits: boolean }
    ): Promise<
        | {
              supContextData: CodeWhispererSupplementalContext
              items: SupplementalContext[]
          }
        | undefined
    > {
        return undefined
    }

    async generateSuggestions(request: GenerateSuggestionsRequest): Promise<GenerateSuggestionsResponse> {
        // Cast is now safe because GenerateIAMSuggestionsRequest extends GenerateRecommendationsRequest
        const iamRequest = request as GenerateIAMSuggestionsRequest

        // Add customization ARN if configured
        if (this.customizationArn) {
            ;(iamRequest as any).customizationArn = this.customizationArn
        }

        // Warn about unsupported features for IAM auth
        if ('editorState' in request || 'predictionTypes' in request || 'supplementalContexts' in request) {
            console.warn('Advanced features not supported - using basic completion')
        }

        const response = await this.client.send(new GenerateRecommendationsCommand(iamRequest))

        return this.mapCodeWhispererApiResponseToSuggestion(response, {
            requestId: response?.$metadata?.requestId ?? 'unknown',
            codewhispererSessionId: (response as any)?.$httpHeaders?.['x-amzn-sessionid'] ?? 'unknown',
            nextToken: response.nextToken,
            authType: 'iam' as const,
        })
    }

    private mapCodeWhispererApiResponseToSuggestion(
        apiResponse: GenerateRecommendationsResponse,
        responseContext: ResponseContext
    ): GenerateSuggestionsResponse {
        for (const recommendation of apiResponse?.recommendations ?? []) {
            Object.assign(recommendation, { itemId: this.generateItemId() })
        }

        return {
            suggestions: apiResponse.recommendations as Suggestion[],
            suggestionType: SuggestionType.COMPLETION,
            responseContext,
        }
    }
}

/**
 * Hint: to get an instance of this: `AmazonQTokenServiceManager.getInstance().getCodewhispererService()`
 */
export class CodeWhispererServiceToken extends CodeWhispererServiceBase {
    client: CodeWhispererTokenClient
    /** Debounce createSubscriptionToken by storing the current, pending promise (if any). */
    #createSubscriptionTokenPromise?: Promise<CreateSubscriptionTokenResponse>
    /** If user clicks "Upgrade" multiple times, cancel the previous wait-promise. */
    #waitUntilSubscriptionCancelSource?: CancellationTokenSource

    #abTestingFetchingTimeout: NodeJS.Timeout | undefined
    #features: FeatureEvaluation[] | undefined

    /**
     * Invoked when any request from this client is rejected because RTS has blocked Q Developer plugin
     * access for this identity (see {@link isQDevPluginAccessBlockedError}).
     *
     * Assigned after construction -- deliberately, so that whoever owns the client lifecycle (and has
     * access to the client-facing features needed to surface it) can supply the reaction without this
     * service taking a dependency on it. Follows the same late-binding approach already used for
     * `shareCodeWhispererContentWithAWS`. When unset, detection is inert.
     *
     * The service error itself is always still thrown to the caller; this is purely an observation
     * hook and must not be used to suppress it.
     */
    public onAccessBlocked?: (error: unknown) => void

    constructor(
        private credentialsProvider: CredentialsProvider,
        workspace: Workspace,
        private logging: Logging,
        codeWhispererRegion: string,
        codeWhispererEndpoint: string,
        sdkInitializator: SDKInitializator,
        userContext: UserContext | undefined,
        customUserAgent?: string
    ) {
        super(codeWhispererRegion, codeWhispererEndpoint)

        const tokenProvider = async () => {
            const creds = credentialsProvider.getCredentials('bearer') as BearerCredentials
            if (!creds?.token) {
                throw new Error('Authorization failed, bearer token is not set')
            }
            return { token: creds.token, expiration: new Date() }
        }

        const options: CodeWhispererTokenClientConfigurationOptions = {
            region: this.codeWhispererRegion,
            endpoint: this.codeWhispererEndpoint,
            token: tokenProvider,
            ...(customUserAgent && { customUserAgent }),
        }
        this.client = createCodeWhispererTokenClient(
            options,
            sdkInitializator,
            logging,
            credentialsProvider,
            () => this.shareCodeWhispererContentWithAWS,
            error => this.onAccessBlocked?.(error)
        )
        this.userContext = userContext
        this.scheduleABTestingFetching()
            .then()
            .catch(e => {})
    }

    getCredentialsType(): CredentialsType {
        return 'bearer'
    }

    override async scheduleABTestingFetching(): Promise<void> {
        const userContext = this.userContext
        if (!userContext) {
            this.logging.error(`empty user context, skipping ab config fetching`)
            return
        }

        let logstr = ''
        try {
            this.#features = (await this.listFeatureEvaluations({ userContext: userContext })).featureEvaluations
            logstr += `abconfig: ${JSON.stringify(this.#features)}`
        } catch (e) {
            logstr += `abconfig error: ${e}`
        } finally {
            this.logging.info(logstr)
        }

        this.#abTestingFetchingTimeout = setInterval(() => {
            let logs = `abconfig: pulling latest result after ${featureConfigPollIntervalInMs}ms:`
            clearInterval(this.#abTestingFetchingTimeout)
            this.#abTestingFetchingTimeout = undefined

            this.listFeatureEvaluations({ userContext })
                .then(result => {
                    const features = result.featureEvaluations
                    this.#features = features
                    logs += `${JSON.stringify(features)}`
                })
                .catch(error => {
                    logs += `${(error as Error).message}`
                })
                .finally(() => {
                    this.logging.info(logs)
                })
        }, featureConfigPollIntervalInMs)
    }

    async constructSupplementalContext(
        document: TextDocument,
        position: Position,
        workspace: Workspace,
        recentEditTracker: RecentEditTracker,
        logging: Logging,
        cancellationToken: CancellationToken,
        opentabs: InlineCompletionWithReferencesParams['openTabFilepaths'],
        config: { includeRecentEdits: boolean }
    ): Promise<
        | {
              supContextData: CodeWhispererSupplementalContext
              items: SupplementalContext[]
          }
        | undefined
    > {
        const getRepomapTarget = () => {
            const feat = this.#features?.find(f => {
                return f.feature === experimentName
            })
            const group = feat?.variation
            return group === 'TREATMENT' ? 'codemap-2hop' : 'codemap'
        }

        const items: SupplementalContext[] = []

        const projectContext = await fetchSupplementalContext(
            document,
            position,
            workspace,
            logging,
            cancellationToken,
            getRepomapTarget(),
            opentabs
        )
        if (projectContext) {
            items.push(
                ...projectContext.supplementalContextItems.map(v => ({
                    content: v.content,
                    filePath: v.filePath,
                }))
            )
        }

        const recentEditsContext = config.includeRecentEdits
            ? await recentEditTracker.generateEditBasedContext(document)
            : undefined
        if (recentEditsContext) {
            items.push(
                ...recentEditsContext.supplementalContextItems.map(item => ({
                    content: item.content,
                    filePath: item.filePath,
                    type: SupplementalContextType.PREVIOUS_EDITOR_STATE,
                    metadata: {
                        previousEditorStateMetadata: {
                            timeOffset: 1000,
                        },
                    },
                }))
            )
        }

        const merged: CodeWhispererSupplementalContext | undefined = recentEditsContext
            ? {
                  contentsLength: (projectContext?.contentsLength || 0) + (recentEditsContext?.contentsLength || 0),
                  latency: Math.max(projectContext?.latency || 0, recentEditsContext?.latency || 0),
                  isUtg: projectContext?.isUtg || false,
                  isProcessTimeout: projectContext?.isProcessTimeout || false,
                  strategy: recentEditsContext ? 'recentEdits' : projectContext?.strategy || 'Empty',
                  supplementalContextItems: [
                      ...(projectContext?.supplementalContextItems || []),
                      ...(recentEditsContext?.supplementalContextItems || []),
                  ],
              }
            : projectContext

        return merged
            ? {
                  supContextData: merged,
                  items: items,
              }
            : undefined
    }

    private withProfileArn<T extends object>(request: T): T {
        if (!this.profileArn) return request

        return { ...request, profileArn: this.profileArn }
    }

    async generateSuggestions(request: GenerateSuggestionsRequest): Promise<GenerateSuggestionsResponse> {
        // Cast is now safe because GenerateTokenSuggestionsRequest extends GenerateCompletionsRequest
        // add cancellation check
        // add error check
        let logstr = `GenerateCompletion activity:\n`
        try {
            const tokenRequest = request as GenerateTokenSuggestionsRequest

            // Add customizationArn if available
            if (this.customizationArn) {
                tokenRequest.customizationArn = this.customizationArn
            }

            const beforeApiCall = Date.now()
            // TODO: Should make context log as a dev option, too noisy, comment it out temporarily
            // let recentEditsLogStr = ''
            // const recentEdits = tokenRequest.supplementalContexts?.filter(it => it.type === 'PreviousEditorState')
            // if (recentEdits) {
            //     if (recentEdits.length === 0) {
            //         recentEditsLogStr += `No recent edits`
            //     } else {
            //         recentEditsLogStr += '\n'
            //         for (let i = 0; i < recentEdits.length; i++) {
            //             const e = recentEdits[i]
            //             recentEditsLogStr += `[recentEdits ${i}th]:\n`
            //             recentEditsLogStr += `${e.content}\n`
            //         }
            //     }
            // }

            logstr += `@@request metadata@@
    "version": "!!!!!!!!!!!!!!!!",
    "endpoint": ${this.codeWhispererEndpoint},
    "predictionType": ${tokenRequest.predictionTypes?.toString() ?? 'Not specified (COMPLETIONS)'},
    "filename": ${tokenRequest.fileContext?.filename},
    "leftContextLength": ${tokenRequest.fileContext?.leftFileContent?.length},
    rightContextLength: ${tokenRequest.fileContext?.rightFileContent?.length},
    "language": ${tokenRequest.fileContext?.programmingLanguage?.languageName},
    "supplementalContextCount": ${tokenRequest.supplementalContexts?.length ?? 0},
    "request.nextToken": ${tokenRequest.nextToken},\n`
            // "recentEdits": ${recentEditsLogStr}\n`

            const response = await this.client.send(new GenerateCompletionsCommand(this.withProfileArn(tokenRequest)))

            const responseContext: ResponseContext = {
                requestId: response?.$metadata?.requestId ?? 'unknown',
                codewhispererSessionId: (response?.$metadata as any)?.httpHeaders?.['x-amzn-sessionid'] ?? 'unknown',
                nextToken: response.nextToken,
                // CRITICAL: Add service type for proper error handling
                authType: 'token' as const,
            }

            const r = this.mapCodeWhispererApiResponseToSuggestion(response, responseContext)
            const firstSuggestionLogstr = r.suggestions.length > 0 ? `\n${r.suggestions[0].content}` : 'No suggestion'

            logstr += `@@response metadata@@
    "requestId": ${responseContext.requestId},
    "sessionId": ${responseContext.codewhispererSessionId},
    "response.completions.length": ${response.completions?.length ?? 0},
    "response.predictions.length": ${response.predictions?.length ?? 0},
    "predictionType": ${tokenRequest.predictionTypes?.toString() ?? 'Not specified (COMPLETIONS)'},
    "latency": ${Date.now() - beforeApiCall},
    "response.nextToken": ${response.nextToken},
    "firstSuggestion": ${firstSuggestionLogstr}`

            return r
        } catch (e) {
            logstr += `error: ${(e as Error).message}`
            throw e
        } finally {
            this.logging.info(logstr)
        }
    }

    private mapCodeWhispererApiResponseToSuggestion(
        apiResponse: GenerateCompletionsResponse,
        responseContext: ResponseContext
    ): GenerateSuggestionsResponse {
        if (apiResponse?.predictions && apiResponse.predictions.length > 0) {
            const suggestionType = apiResponse.predictions[0].edit ? SuggestionType.EDIT : SuggestionType.COMPLETION
            const predictionType = suggestionType === SuggestionType.COMPLETION ? 'completion' : 'edit'

            return {
                suggestions: apiResponse.predictions.map(prediction => ({
                    content: prediction[predictionType]?.content ?? '',
                    references: prediction[predictionType]?.references ?? [],
                    itemId: this.generateItemId(),
                })),
                suggestionType,
                responseContext,
            }
        }

        // Backward compatibility, completions will be returned if predictionType is not specified (either Completion or Edit)
        for (const recommendation of apiResponse?.completions ?? []) {
            Object.assign(recommendation, { itemId: this.generateItemId() })
        }

        return {
            suggestions: apiResponse.completions as Suggestion[],
            suggestionType: SuggestionType.COMPLETION,
            responseContext,
        }
    }

    public async codeModernizerCreateUploadUrl(request: CreateUploadUrlRequest) {
        return this.client.send(new CreateUploadUrlCommand(this.withProfileArn(request)))
    }
    /**
     * @description Use this function to start the transformation job.
     * @param request
     * @returns transformationJobId - String id for the Job
     */

    public async codeModernizerStartCodeTransformation(request: StartTransformationRequest) {
        return await this.client.send(new StartTransformationCommand(this.withProfileArn(request)))
    }

    /**
     * @description Use this function to stop the transformation job.
     * @param request
     * @returns transformationJobId - String id for the Job
     */
    public async codeModernizerStopCodeTransformation(request: StopTransformationRequest) {
        return await this.client.send(new StopTransformationCommand(this.withProfileArn(request)))
    }

    /**
     * @description Use this function to get the status of the code transformation. We should
     * be polling this function periodically to get updated results. When this function
     * returns COMPLETED we know the transformation is done.
     */
    public async codeModernizerGetCodeTransformation(request: GetTransformationRequest) {
        return await this.client.send(new GetTransformationCommand(this.withProfileArn(request)))
    }

    /**
     * @description After starting a transformation use this function to display the LLM
     * transformation plan to the user.
     * @params tranformationJobId - String id returned from StartCodeTransformationResponse
     */
    public async codeModernizerGetCodeTransformationPlan(request: GetTransformationPlanRequest) {
        return this.client.send(new GetTransformationPlanCommand(this.withProfileArn(request)))
    }

    /**
     * @description get a pre-signed url to upload source code into S3 bucket
     */
    async createUploadUrl(request: CreateUploadUrlRequest) {
        return this.client.send(new CreateUploadUrlCommand(this.withProfileArn(request)))
    }

    /**
     * @description Once source code uploaded to S3, send a request to run security scan on uploaded source code.
     */
    async startCodeAnalysis(request: StartCodeAnalysisRequest) {
        return this.client.send(new StartCodeAnalysisCommand(this.withProfileArn(request)))
    }

    /**
     * @description Send a request to get the code scan status detail.
     */
    async getCodeAnalysis(request: GetCodeAnalysisRequest) {
        return this.client.send(new GetCodeAnalysisCommand(this.withProfileArn(request)))
    }

    /**
     * @description Get profile details
     */
    async getProfile(request: GetProfileRequest) {
        return this.client.send(new GetProfileCommand(request))
    }

    /**
     * @description Once scan completed successfully, send a request to get list of all the findings for the given scan.
     */
    async listCodeAnalysisFindings(request: ListCodeAnalysisFindingsRequest) {
        return this.client.send(new ListCodeAnalysisFindingsCommand(this.withProfileArn(request)))
    }

    /**
     * @description Get list of available customizations
     */
    async listAvailableCustomizations(request: ListAvailableCustomizationsRequest) {
        return this.client.send(new ListAvailableCustomizationsCommand(this.withProfileArn(request)))
    }

    /**
     * @description Get list of available profiles
     */
    async listAvailableProfiles(request: ListAvailableProfilesRequest) {
        return this.client.send(new ListAvailableProfilesCommand(request))
    }

    /**
     * @description Get list of available models
     */
    async listAvailableModels(request: ListAvailableModelsRequest) {
        return this.client.send(new ListAvailableModelsCommand(request))
    }

    /**
     * @description send telemetry event to code whisperer data warehouse
     */
    async sendTelemetryEvent(request: SendTelemetryEventRequest) {
        return this.client.send(new SendTelemetryEventCommand(this.withProfileArn(request)))
    }

    /**
     * @description create a remote workspace
     */
    async createWorkspace(request: CreateWorkspaceRequest) {
        return this.client.send(new CreateWorkspaceCommand(this.withProfileArn(request)))
    }

    /**
     * @description get list of workspace metadata
     */
    async listWorkspaceMetadata(request: ListWorkspaceMetadataRequest) {
        return this.client.send(new ListWorkspaceMetadataCommand(this.withProfileArn(request)))
    }

    /**
     * @description delete the remote workspace
     */
    async deleteWorkspace(request: DeleteWorkspaceRequest) {
        return this.client.send(new DeleteWorkspaceCommand(this.withProfileArn(request)))
    }

    /*
     * @description get the list of feature evaluations
     */
    async listFeatureEvaluations(request: ListFeatureEvaluationsRequest) {
        return this.client.send(new ListFeatureEvaluationsCommand(this.withProfileArn(request)))
    }

    /**
     * (debounced by default)
     *
     * cool api you have there 🥹
     */
    async createSubscriptionToken(request: CreateSubscriptionTokenRequest) {
        // Debounce.
        if (this.#createSubscriptionTokenPromise) {
            return this.#createSubscriptionTokenPromise
        }

        this.#createSubscriptionTokenPromise = (async () => {
            try {
                const r = await this.client.send(new CreateSubscriptionTokenCommand(this.withProfileArn(request)))
                if (!r.encodedVerificationUrl) {
                    this.logging.error(`setpaidtier
    request: ${JSON.stringify(request)}
    response: ${JSON.stringify(r as any)}
    requestId: ${(r as any).$response?.requestId}
    httpStatusCode: ${(r as any).$response?.httpResponse?.statusCode}
    headers: ${JSON.stringify((r as any).$response?.httpResponse?.headers)}`)
                }
                return r
            } finally {
                this.#createSubscriptionTokenPromise = undefined
            }
        })()

        return this.#createSubscriptionTokenPromise
    }

    /**
     * Gets the Subscription status of the given user.
     *
     * @param statusOnly use this if you don't need the encodedVerificationUrl, else a ConflictException is treated as "ACTIVE"
     */
    override async getSubscriptionStatus(
        statusOnly?: boolean
    ): Promise<{ status: 'active' | 'active-expiring' | 'none'; encodedVerificationUrl?: string }> {
        // NOTE: The subscription API behaves in a non-intuitive way.
        // https://github.com/aws/amazon-q-developer-cli-autocomplete/blob/86edd86a338b549b5192de67c9fdef240e6014b7/crates/chat-cli/src/cli/chat/mod.rs#L4079-L4102
        //
        // If statusOnly=true, the service only returns "ACTIVE" and "INACTIVE".
        // If statusOnly=false, the following spec applies:
        //
        // 1. "ACTIVE" => 'active-expiring':
        //    - Active but cancelled. User *has* a subscription, but set to *not auto-renew* (i.e., cancelled).
        // 2. "INACTIVE" => 'none':
        //    - User has no subscription at all (no Pro access).
        // 3. ConflictException => 'active':
        //    - User has an active subscription *with auto-renewal enabled*.
        //
        // Also, it is currently not possible to subscribe or re-subscribe via console, only IDE/CLI.
        try {
            const r = await this.createSubscriptionToken({
                statusOnly: !!statusOnly,
                // clientToken: this.credentialsProvider.getCredentials('bearer').token,
            })
            const status = r.status === 'ACTIVE' ? 'active-expiring' : 'none'

            return {
                status: status,
                encodedVerificationUrl: r.encodedVerificationUrl,
            }
        } catch (e) {
            if (getErrorId(e as Error) === 'ConflictException') {
                return {
                    status: 'active',
                }
            }

            throw e
        }
    }

    /**
     * Polls the service until subscription status changes to "ACTIVE".
     *
     * Returns true on success, or false on timeout/cancellation.
     */
    override async waitUntilSubscriptionActive(cancelToken?: CancellationToken): Promise<boolean> {
        // If user clicks "Upgrade" multiple times, cancel any pending waitUntil().
        if (this.#waitUntilSubscriptionCancelSource) {
            this.#waitUntilSubscriptionCancelSource.cancel()
            this.#waitUntilSubscriptionCancelSource.dispose()
        }

        this.#waitUntilSubscriptionCancelSource = new CancellationTokenSource()

        // Combine the external cancelToken (if provided) with our internal one.
        const combinedToken = cancelToken
            ? {
                  isCancellationRequested: () =>
                      cancelToken.isCancellationRequested ||
                      this.#waitUntilSubscriptionCancelSource!.token.isCancellationRequested,
              }
            : this.#waitUntilSubscriptionCancelSource.token

        const r = await waitUntil(
            async () => {
                if (combinedToken.isCancellationRequested) {
                    this.logging.info('waitUntilSubscriptionActive: cancelled')
                    return false
                }
                const s = await this.getSubscriptionStatus(true)
                this.logging.info(`waitUntilSubscriptionActive: ${s.status}`)
                if (s.status !== 'none') {
                    return true
                }
            },
            {
                timeout: 60 * 60 * 1000, // 1 hour
                interval: 2000,
                truthy: true,
            }
        ).finally(() => {
            this.#waitUntilSubscriptionCancelSource?.dispose()
            this.#waitUntilSubscriptionCancelSource = undefined
        })

        return !!r
    }
}
