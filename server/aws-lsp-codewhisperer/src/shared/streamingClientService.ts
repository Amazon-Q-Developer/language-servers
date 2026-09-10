import {
    CodeWhispererStreaming,
    GenerateAssistantResponseCommandInput as GenerateAssistantResponseCommandInputCodeWhispererStreaming,
    GenerateAssistantResponseCommandOutput as GenerateAssistantResponseCommandOutputCodeWhispererStreaming,
    SendMessageCommandInput as SendMessageCommandInputCodeWhispererStreaming,
    SendMessageCommandOutput as SendMessageCommandOutputCodeWhispererStreaming,
    ExportResultArchiveCommandInput as ExportResultArchiveCommandInputCodeWhispererStreaming,
    ExportResultArchiveCommandOutput as ExportResultArchiveCommandOutputCodeWhispererStreaming,
    InvokeMCPCommandInput as InvokeMCPCommandInputCodeWhispererStreaming,
    InvokeMCPCommandOutput as InvokeMCPCommandOutputCodeWhispererStreaming,
} from '@amzn/codewhisperer-streaming'
import {
    QDeveloperStreaming,
    SendMessageCommandInput as SendMessageCommandInputQDeveloperStreaming,
    SendMessageCommandOutput as SendMessageCommandOutputQDeveloperStreaming,
} from '@amzn/amazon-q-developer-streaming-client'
import {
    CredentialsProvider,
    SDKInitializator,
    Logging,
    IamCredentials,
} from '@aws/language-server-runtimes/server-interface'
import { getBearerTokenFromProvider, isUsageLimitError } from './utils'
import { CLIENT_TIMEOUT_MS, MAX_REQUEST_ATTEMPTS } from '../language-server/agenticChat/constants/constants'

import { AmazonQUsageLimitError } from './amazonQServiceManager/errors'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@aws-sdk/types'
import { QRetryClassifier } from '../language-server/agenticChat/retry/retryClassifier'
import { QDelayTrackingInterceptor, DelayNotification } from '../language-server/agenticChat/retry/delayInterceptor'
import { QRetryStrategy } from '../language-server/agenticChat/retry/qRetryStrategy'

export type SendMessageCommandInput =
    | SendMessageCommandInputCodeWhispererStreaming
    | SendMessageCommandInputQDeveloperStreaming
export type SendMessageCommandOutput =
    | SendMessageCommandOutputCodeWhispererStreaming
    | SendMessageCommandOutputQDeveloperStreaming

export type ChatCommandInput = SendMessageCommandInput | GenerateAssistantResponseCommandInputCodeWhispererStreaming
export type ChatCommandOutput = SendMessageCommandOutput | GenerateAssistantResponseCommandOutputCodeWhispererStreaming

export abstract class StreamingClientServiceBase {
    protected readonly region
    protected readonly endpoint
    protected delayInterceptor: QDelayTrackingInterceptor
    public shareCodeWhispererContentWithAWS?: boolean

    inflightRequests: Set<AbortController> = new Set()

    abstract client: CodeWhispererStreaming | QDeveloperStreaming

    constructor(region: string, endpoint: string, logging?: Logging) {
        this.region = region
        this.endpoint = endpoint
        this.delayInterceptor = new QDelayTrackingInterceptor(logging)
    }

    abstract sendMessage(
        request: SendMessageCommandInput,
        abortController?: AbortController
    ): Promise<SendMessageCommandOutput>

    public abortInflightRequests() {
        this.inflightRequests.forEach(abortController => {
            abortController.abort()
        })
        this.inflightRequests.clear()
    }

    public setDelayNotificationCallback(callback: (notification: DelayNotification) => void): void {
        this.delayInterceptor.setDelayNotificationCallback(callback)
    }
}

export class StreamingClientServiceToken extends StreamingClientServiceBase {
    client: CodeWhispererStreaming
    public profileArn?: string
    private retryClassifier: QRetryClassifier

    constructor(
        credentialsProvider: CredentialsProvider,
        sdkInitializator: SDKInitializator,
        logging: Logging,
        region: string,
        endpoint: string,
        customUserAgent: string
    ) {
        super(region, endpoint, logging)
        this.retryClassifier = new QRetryClassifier(logging)

        const tokenProvider = async () => {
            const token = getBearerTokenFromProvider(credentialsProvider)
            // without setting expiration, the tokenProvider will only be called once
            return { token, expiration: new Date() }
        }

        logging.log(
            `Passing client for class CodeWhispererStreaming to sdkInitializator (v3) for additional setup (e.g. proxy)`
        )

        // Create Q-specific retry strategy with classifier and delay tracking
        const retryStrategy = new QRetryStrategy(
            this.retryClassifier,
            this.delayInterceptor,
            MAX_REQUEST_ATTEMPTS,
            logging
        )

        this.client = sdkInitializator(CodeWhispererStreaming, {
            region,
            endpoint,
            token: tokenProvider,
            retryStrategy: retryStrategy,
            requestHandler: new NodeHttpHandler({
                requestTimeout: CLIENT_TIMEOUT_MS,
            }),
            customUserAgent: customUserAgent,
        })

        this.client.middlewareStack.add(
            (next, context) => (args: any) => {
                if (credentialsProvider.getConnectionType() === 'external_idp') {
                    args.request.headers['TokenType'] = 'EXTERNAL_IDP'
                }
                if (this.shareCodeWhispererContentWithAWS !== undefined) {
                    args.request.headers['x-amzn-codewhisperer-optout'] = `${!this.shareCodeWhispererContentWithAWS}`
                }
                // Log headers for debugging
                logging.debug(`StreamingClient headers: ${JSON.stringify(args.request.headers)}`)
                return next(args)
            },
            {
                step: 'build',
            }
        )
    }

    public async sendMessage(
        request: SendMessageCommandInputCodeWhispererStreaming,
        abortController?: AbortController
    ): Promise<SendMessageCommandOutputCodeWhispererStreaming> {
        const controller: AbortController = abortController ?? new AbortController()

        this.inflightRequests.add(controller)

        try {
            const response = await this.client.sendMessage(
                { ...request, profileArn: this.profileArn },
                {
                    abortSignal: controller.signal,
                }
            )

            return response
        } catch (e) {
            if (isUsageLimitError(e)) {
                throw new AmazonQUsageLimitError(e)
            }
            throw e
        } finally {
            this.inflightRequests.delete(controller)
        }
    }

    public async generateAssistantResponse(
        request: GenerateAssistantResponseCommandInputCodeWhispererStreaming,
        abortController?: AbortController
    ): Promise<GenerateAssistantResponseCommandOutputCodeWhispererStreaming> {
        const controller: AbortController = abortController ?? new AbortController()

        this.inflightRequests.add(controller)

        try {
            const response = await this.client.generateAssistantResponse(
                { ...request, profileArn: this.profileArn },
                {
                    abortSignal: controller.signal,
                }
            )

            return response
        } catch (e) {
            if (isUsageLimitError(e)) {
                throw new AmazonQUsageLimitError(e)
            }
            throw e
        } finally {
            this.inflightRequests.delete(controller)
        }
    }

    public async exportResultArchive(
        request: ExportResultArchiveCommandInputCodeWhispererStreaming,
        abortController?: AbortController
    ): Promise<ExportResultArchiveCommandOutputCodeWhispererStreaming> {
        const controller: AbortController = abortController ?? new AbortController()
        this.inflightRequests.add(controller)
        const response = await this.client.exportResultArchive(
            this.profileArn ? { ...request, profileArn: this.profileArn } : request
        )
        this.inflightRequests.delete(controller)
        return response
    }

    public async invokeMCP(
        request: InvokeMCPCommandInputCodeWhispererStreaming,
        abortController?: AbortController
    ): Promise<InvokeMCPCommandOutputCodeWhispererStreaming> {
        const controller: AbortController = abortController ?? new AbortController()

        this.inflightRequests.add(controller)

        try {
            const response = await this.client.invokeMCP(request, {
                abortSignal: controller.signal,
            })

            return response
        } catch (e) {
            if (isUsageLimitError(e)) {
                throw new AmazonQUsageLimitError(e)
            }
            throw e
        } finally {
            this.inflightRequests.delete(controller)
        }
    }
}

export class StreamingClientServiceIAM extends StreamingClientServiceBase {
    client: QDeveloperStreaming
    private retryClassifier: QRetryClassifier

    constructor(
        credentialsProvider: CredentialsProvider,
        sdkInitializator: SDKInitializator,
        logging: Logging,
        region: string,
        endpoint: string
    ) {
        super(region, endpoint, logging)
        this.retryClassifier = new QRetryClassifier(logging)

        logging.log(
            `Passing client for class QDeveloperStreaming to sdkInitializator (v3) for additional setup (e.g. proxy)`
        )

        // Create a credential provider that fetches fresh credentials on each request
        const iamCredentialProvider: AwsCredentialIdentityProvider = async (): Promise<AwsCredentialIdentity> => {
            const creds = (await credentialsProvider.getCredentials('iam')) as IamCredentials
            logging.log(`Fetching new IAM credentials`)
            if (!creds) {
                logging.log('Failed to fetch IAM credentials: No IAM credentials found')
                throw new Error('No IAM credentials found')
            }
            return {
                accessKeyId: creds.accessKeyId,
                secretAccessKey: creds.secretAccessKey,
                sessionToken: creds.sessionToken,
                expiration: creds.expiration ? new Date(creds.expiration) : new Date(), // Force refresh if expiration field is not available
            }
        }

        // Create Q-specific retry strategy with classifier and delay tracking
        const retryStrategy = new QRetryStrategy(
            this.retryClassifier,
            this.delayInterceptor,
            MAX_REQUEST_ATTEMPTS,
            logging
        )

        this.client = sdkInitializator(QDeveloperStreaming, {
            region: region,
            endpoint: endpoint,
            credentials: iamCredentialProvider,
            retryStrategy: retryStrategy,
        })

        this.client.middlewareStack.add(
            (next, context) => (args: any) => {
                if (this.shareCodeWhispererContentWithAWS !== undefined) {
                    args.request.headers['x-amzn-codewhisperer-optout'] = `${!this.shareCodeWhispererContentWithAWS}`
                }
                return next(args)
            },
            {
                step: 'build',
            }
        )
    }

    public async sendMessage(
        request: SendMessageCommandInputQDeveloperStreaming,
        abortController?: AbortController
    ): Promise<SendMessageCommandOutputQDeveloperStreaming> {
        const controller: AbortController = abortController ?? new AbortController()

        this.inflightRequests.add(controller)

        try {
            const response = await this.client.sendMessage(request, {
                abortSignal: controller.signal,
            })

            return response
        } catch (e) {
            throw e
        } finally {
            this.inflightRequests.delete(controller)
        }
    }
}
