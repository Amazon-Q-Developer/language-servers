import { CodeWhispererServiceIAM } from '../codeWhispererService'
import {
    AmazonQBaseServiceManager,
    BaseAmazonQServiceManager,
    QServiceManagerFeatures,
} from './BaseAmazonQServiceManager'
import { getAmazonQRegionAndEndpoint } from './configurationUtils'
import { StreamingClientServiceIAM } from '../streamingClientService'
import {
    AmazonQServiceAlreadyInitializedError,
    AmazonQServiceInitializationError,
    AmazonQServicePendingSigninError,
} from './errors'
import {
    CancellationToken,
    CredentialsType,
    UpdateConfigurationParams,
} from '@aws/language-server-runtimes/server-interface'

export class AmazonQIAMServiceManager extends BaseAmazonQServiceManager<
    CodeWhispererServiceIAM,
    StreamingClientServiceIAM
> {
    hasValidCredentials(): boolean {
        return this.features.credentialsProvider.hasCredentials('iam')
    }
    private static instance: AmazonQIAMServiceManager | null = null
    private region: string
    private endpoint: string

    private constructor(features: QServiceManagerFeatures) {
        super(features)
        const amazonQRegionAndEndpoint = getAmazonQRegionAndEndpoint(features.runtime, features.logging)
        this.region = amazonQRegionAndEndpoint.region
        this.endpoint = amazonQRegionAndEndpoint.endpoint
    }

    public static initInstance(features: QServiceManagerFeatures): AmazonQIAMServiceManager {
        if (!AmazonQIAMServiceManager.instance) {
            AmazonQIAMServiceManager.instance = new AmazonQIAMServiceManager(features)

            return AmazonQIAMServiceManager.instance
        }

        throw new AmazonQServiceAlreadyInitializedError()
    }

    public static getInstance(): AmazonQIAMServiceManager {
        if (!AmazonQIAMServiceManager.instance) {
            throw new AmazonQServiceInitializationError(
                'Amazon Q service has not been initialized yet. Make sure the Amazon Q service server is present and properly initialized.'
            )
        }

        return AmazonQIAMServiceManager.instance
    }

    public getCodewhispererService() {
        // Mirror the token-based manager: do not hand out a service that cannot authenticate.
        // Without this, the SDK credential callback dereferences `undefined` and every
        // inline-completion trigger fails with a bare TypeError until credentials arrive.
        if (!this.hasValidCredentials()) {
            throw new AmazonQServicePendingSigninError('No IAM credentials available')
        }

        if (!this.cachedCodewhispererService) {
            this.cachedCodewhispererService = new CodeWhispererServiceIAM(
                this.features.credentialsProvider,
                this.features.workspace,
                this.features.logging,
                this.region,
                this.endpoint,
                this.features.sdkInitializator
            )

            this.updateCachedServiceConfig()
        }

        return this.cachedCodewhispererService
    }
    public getAtxCodewhispererService() {
        if (!this.cachedAtxCodewhispererService) {
            this.cachedAtxCodewhispererService = new CodeWhispererServiceIAM(
                this.features.credentialsProvider,
                this.features.workspace,
                this.features.logging,
                this.region,
                this.endpoint,
                this.features.sdkInitializator
            )

            this.updateCachedServiceConfig()
        }

        return this.cachedAtxCodewhispererService
    }

    public getStreamingClient() {
        if (!this.cachedStreamingClient) {
            this.cachedStreamingClient = new StreamingClientServiceIAM(
                this.features.credentialsProvider,
                this.features.sdkInitializator,
                this.features.logging,
                this.region,
                this.endpoint
            )
            this.cachedStreamingClient.shareCodeWhispererContentWithAWS = this.configurationCache.getProperty(
                'shareCodeWhispererContentWithAWS'
            )
        }
        return this.cachedStreamingClient
    }

    public handleOnCredentialsDeleted(type: CredentialsType): void {
        if (type === 'iam') {
            this.cachedCodewhispererService?.abortInflightRequests()
            this.cachedCodewhispererService = undefined
            this.cachedStreamingClient?.abortInflightRequests()
            this.cachedStreamingClient = undefined
        }
    }

    public override handleOnUpdateConfiguration(
        _params: UpdateConfigurationParams,
        _token: CancellationToken
    ): Promise<void> {
        return Promise.resolve()
    }

    // For Unit Tests
    public static resetInstance(): void {
        AmazonQIAMServiceManager.instance = null
    }
}

export const initBaseIAMServiceManager = (features: QServiceManagerFeatures) =>
    AmazonQIAMServiceManager.initInstance(features)

export const getOrThrowBaseIAMServiceManager = (): AmazonQBaseServiceManager => AmazonQIAMServiceManager.getInstance()
