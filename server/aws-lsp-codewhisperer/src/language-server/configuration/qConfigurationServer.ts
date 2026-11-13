import {
    CancellationToken,
    CredentialsProvider,
    GetConfigurationFromServerParams,
    InitializeParams,
    Logging,
    LSPErrorCodes,
    ResponseError,
    Server,
} from '@aws/language-server-runtimes/server-interface'
import {
    AmazonQDeveloperProfile,
    getListAllAvailableProfilesHandler,
    ListAllAvailableProfilesHandler,
} from '../../shared/amazonQServiceManager/qDeveloperProfiles'
import { Customization } from '@amzn/codewhisperer-runtime'
import { AmazonQTokenServiceManager } from '../../shared/amazonQServiceManager/AmazonQTokenServiceManager'
import { AWS_Q_ENDPOINTS, Q_CONFIGURATION_SECTION } from '../../shared/constants'
import { AmazonQError } from '../../shared/amazonQServiceManager/errors'

const Q_CUSTOMIZATIONS = 'customizations'
const Q_DEVELOPER_PROFILES = 'developerProfiles'

export const Q_CUSTOMIZATIONS_CONFIGURATION_SECTION = `${Q_CONFIGURATION_SECTION}.${Q_CUSTOMIZATIONS}`
export const Q_DEVELOPER_PROFILES_CONFIGURATION_SECTION = `${Q_CONFIGURATION_SECTION}.${Q_DEVELOPER_PROFILES}`

interface CustomizationWithMetadata extends Customization {
    profile?: AmazonQDeveloperProfile
    isDefault?: boolean
}

interface QConfigurationSections {
    customizations: CustomizationWithMetadata[]
    developerProfiles?: AmazonQDeveloperProfile[]
}

// Feature flag interface for client capabilities
export interface QClientCapabilities {
    developerProfiles?: boolean
    customizationsWithMetadata?: boolean
    mcp?: boolean
    /** Trust state of the open workspace; see `WorkspaceTrustState` in mcpWorkspaceTrust.ts. Defaults to 'prompt'. */
    workspaceTrust?: 'trusted' | 'restricted' | 'prompt'
    modelSelection?: boolean
    reroute?: boolean
    codeReviewInChat?: boolean
    displayFindings?: boolean
    compaction?: boolean
    shortcut?: boolean
}

type QConfigurationResponse =
    | QConfigurationSections
    | QConfigurationSections['customizations']
    | QConfigurationSections['developerProfiles']

export const QConfigurationServerToken =
    (): Server =>
    ({ credentialsProvider, lsp, logging }) => {
        let amazonQServiceManager: AmazonQTokenServiceManager
        let serverConfigurationProvider: ServerConfigurationProvider
        let enableCustomizationsWithMetadata = false

        const isCustomizationsWithDeveloperProfileEnabled = (): boolean => {
            return enableCustomizationsWithMetadata && amazonQServiceManager.getEnableDeveloperProfileSupport()
        }

        const enhancedCustomizationsWithMetadata = async (
            token: CancellationToken
        ): Promise<CustomizationWithMetadata[]> => {
            logging.debug('Using enhanced customizations with metadata')

            // Fetch profiles first
            const developerProfiles = await serverConfigurationProvider.listAvailableProfiles(token)

            // Then use those profiles to fetch customizations
            const customizations = await serverConfigurationProvider.listAllAvailableCustomizationsWithMetadata(
                developerProfiles,
                token
            )

            return customizations
        }

        lsp.addInitializer((params: InitializeParams) => {
            // Check for feature flag in client capabilities
            const qCapabilities = params.initializationOptions?.aws?.awsClientCapabilities?.q as
                | QClientCapabilities
                | undefined
            enableCustomizationsWithMetadata = !!qCapabilities?.customizationsWithMetadata

            logging.debug(`Feature flag enableCustomizationsWithMetadata: ${enableCustomizationsWithMetadata}`)

            return {
                capabilities: {},
                awsServerCapabilities: {
                    configurationProvider: {
                        sections: [
                            Q_CONFIGURATION_SECTION,
                            Q_CUSTOMIZATIONS_CONFIGURATION_SECTION,
                            Q_DEVELOPER_PROFILES_CONFIGURATION_SECTION,
                        ],
                    },
                },
            }
        })

        lsp.onInitialized(async () => {
            amazonQServiceManager = AmazonQTokenServiceManager.getInstance()

            serverConfigurationProvider = new ServerConfigurationProvider(
                amazonQServiceManager,
                credentialsProvider,
                logging
            )
        })

        lsp.extensions.onGetConfigurationFromServer(
            async (
                params: GetConfigurationFromServerParams,
                token: CancellationToken
            ): Promise<QConfigurationResponse | void> => {
                const section = params.section

                let customizations: Customization[] | CustomizationWithMetadata[] = []
                let developerProfiles: AmazonQDeveloperProfile[] = []

                try {
                    switch (section) {
                        case Q_CONFIGURATION_SECTION:
                            if (isCustomizationsWithDeveloperProfileEnabled()) {
                                customizations = await enhancedCustomizationsWithMetadata(token)
                            } else {
                                ;[customizations, developerProfiles] = await Promise.all([
                                    serverConfigurationProvider.listAvailableCustomizations(),
                                    serverConfigurationProvider.listAvailableProfiles(token),
                                ])
                            }

                            throwIfCancelled(token)

                            return amazonQServiceManager.getEnableDeveloperProfileSupport()
                                ? { customizations, developerProfiles }
                                : { customizations }
                        case Q_CUSTOMIZATIONS_CONFIGURATION_SECTION:
                            if (isCustomizationsWithDeveloperProfileEnabled()) {
                                customizations = await enhancedCustomizationsWithMetadata(token)
                            } else {
                                customizations = await serverConfigurationProvider.listAvailableCustomizations()
                            }

                            return customizations
                        case Q_DEVELOPER_PROFILES_CONFIGURATION_SECTION:
                            developerProfiles = await serverConfigurationProvider.listAvailableProfiles(token)

                            throwIfCancelled(token)

                            return developerProfiles
                        default:
                            break
                    }
                } catch (error) {
                    if (error instanceof ResponseError) {
                        throw error
                    }

                    logging.error(`Failed to fetch resources for section ${section}: ${error}`)
                    throw new ResponseError(
                        LSPErrorCodes.RequestFailed,
                        `An unexpected error occured while fetching resource(s) for section: ${section}`
                    )
                }
            }
        )

        logging.log('Amazon Q Configuration server has been initialised')
        return () => {}
    }

function throwIfCancelled(token: CancellationToken) {
    if (token.isCancellationRequested) {
        throw new ResponseError(LSPErrorCodes.RequestCancelled, 'Request cancelled')
    }
}

const ON_GET_CONFIGURATION_FROM_SERVER_ERROR_PREFIX = 'Failed to fetch: '

export class ServerConfigurationProvider {
    private listAllAvailableProfilesHandler: ListAllAvailableProfilesHandler

    constructor(
        private serviceManager: AmazonQTokenServiceManager,
        private credentialsProvider: CredentialsProvider,
        private logging: Logging
    ) {
        this.listAllAvailableProfilesHandler = getListAllAvailableProfilesHandler(
            this.serviceManager.getServiceFactory()
        )
    }

    async listAvailableProfiles(token: CancellationToken): Promise<AmazonQDeveloperProfile[]> {
        if (!this.serviceManager.getEnableDeveloperProfileSupport()) {
            this.logging.debug('Q developer profiles disabled - returning empty list')
            return []
        }

        try {
            const profiles = await this.listAllAvailableProfilesHandler({
                connectionType: this.credentialsProvider.getConnectionType(),
                logging: this.logging,
                token: token,
            })

            return profiles
        } catch (error) {
            if (error instanceof AmazonQError) {
                this.logging.error(error.message)
                throw new ResponseError(
                    LSPErrorCodes.RequestFailed,
                    `${ON_GET_CONFIGURATION_FROM_SERVER_ERROR_PREFIX}${Q_DEVELOPER_PROFILES}`,
                    {
                        awsErrorCode: error.code,
                    }
                )
            }
            throw this.getResponseError(
                `${ON_GET_CONFIGURATION_FROM_SERVER_ERROR_PREFIX}${Q_DEVELOPER_PROFILES}`,
                error
            )
        }
    }

    async listAvailableCustomizations(): Promise<Customization[]> {
        try {
            const customizations = (
                await this.serviceManager.getCodewhispererService().listAvailableCustomizations({ maxResults: 100 })
            ).customizations

            return customizations ?? []
        } catch (error) {
            throw this.getResponseError(`${ON_GET_CONFIGURATION_FROM_SERVER_ERROR_PREFIX}${Q_CUSTOMIZATIONS}`, error)
        }
    }

    async listAvailableCustomizationsForProfileAndRegion(
        profileArn: string | undefined,
        region: string
    ): Promise<Customization[]> {
        try {
            // Create a new service for the specific region
            const service = this.serviceManager.getServiceFactory()(region, AWS_Q_ENDPOINTS.get(region) || '')
            service.profileArn = profileArn

            const customizations = (await service.listAvailableCustomizations({ maxResults: 100 })).customizations

            return customizations ?? []
        } catch (error) {
            throw this.getResponseError(`${ON_GET_CONFIGURATION_FROM_SERVER_ERROR_PREFIX}${Q_CUSTOMIZATIONS}`, error)
        }
    }

    async listAllAvailableCustomizationsWithMetadata(
        availableProfiles: AmazonQDeveloperProfile[],
        token?: CancellationToken
    ): Promise<CustomizationWithMetadata[]> {
        try {
            if (token?.isCancellationRequested) {
                throw new ResponseError(LSPErrorCodes.RequestCancelled, 'Request cancelled')
            }

            // Filter out profiles without region information
            const validProfiles = availableProfiles.filter(profile => profile.identityDetails?.region)

            if (validProfiles.length === 0) {
                return []
            }

            const customizationPromises = validProfiles.map(profile => {
                const region = profile.identityDetails!.region
                return this.listAvailableCustomizationsForProfileAndRegion(profile.arn, region)
                    .then(customizations => {
                        if (token?.isCancellationRequested) {
                            throw new ResponseError(LSPErrorCodes.RequestCancelled, 'Request cancelled')
                        }

                        // The default customization is added for each profile.
                        const defaultCustomization = {
                            arn: '',
                            name: 'Amazon Q foundation (Default)',
                            description: '',
                            isDefault: true,
                            profile: profile,
                        }

                        return [
                            defaultCustomization,
                            ...(customizations?.map(customization => ({
                                ...customization,
                                isDefault: false,
                                profile: profile,
                            })) ?? []),
                        ]
                    })
                    .catch(error => {
                        if (error instanceof ResponseError) {
                            throw error
                        }

                        this.logging.error(
                            `Failed to fetch customizations for profile ${profile.arn} in region ${region}: ${error}`
                        )
                        return [
                            {
                                arn: '',
                                name: 'Amazon Q foundation (Default)',
                                description: '',
                                isDefault: true,
                                profile: profile,
                            },
                        ] as CustomizationWithMetadata[]
                    })
            })

            const results = await Promise.all(customizationPromises)

            return results.flat()
        } catch (error) {
            if (error instanceof ResponseError) {
                throw error
            }
            throw this.getResponseError(`Failed to fetch customizations with metadata`, error)
        }
    }

    private getResponseError(message: string, error: any): ResponseError {
        this.logging.error(`${message}: ${error}`)
        return new ResponseError(LSPErrorCodes.RequestFailed, message)
    }
}
