import {
    CancellationToken,
    CredentialsType,
    InitializeParams,
    Server,
    UpdateConfigurationParams,
} from '@aws/language-server-runtimes/server-interface'
import { AmazonQBaseServiceManager, QServiceManagerFeatures } from './amazonQServiceManager/BaseAmazonQServiceManager'
import { initBaseIAMServiceManager } from './amazonQServiceManager/AmazonQIAMServiceManager'
import { initBaseTokenServiceManager } from './amazonQServiceManager/AmazonQTokenServiceManager'
import { AtxTokenServiceManager } from './amazonQServiceManager/AtxTokenServiceManager'
import { Q_CONFIGURATION_SECTION } from './constants'
import {
    TRANSFORM_PROFILES_CONFIGURATION_SECTION,
    ATX_CONFIGURATION_SECTION,
} from '../language-server/configuration/transformConfigurationServer'

const LOGGING_PREFIX = '[AMAZON Q SERVER]: '

/**
 * @param serverName Value for the server's `serverInfo.name`. Required, and required to be unique
 * across every server registered in the same runtime: the runtime rejects `initialize` outright with
 * `Duplicate servers defined` if two servers report the same name, which takes down the whole language
 * server rather than the offending one. This factory is instantiated more than once per runtime (IAM
 * and token), so a shared constant here breaks every bundle that registers both.
 */
export const AmazonQServiceServerFactory =
    (serviceManager: (features: QServiceManagerFeatures) => AmazonQBaseServiceManager, serverName: string): Server =>
    ({ credentialsProvider, lsp, workspace, logging, runtime, sdkInitializator, notification }) => {
        let amazonQServiceManager: AmazonQBaseServiceManager

        const log = (message: string) => {
            logging.debug(`${LOGGING_PREFIX}${message}`)
        }

        /*
             The service manager relies on client params to fully initialize, so the initialization needs
             to be deferred to the LSP handshake. Dependent servers may assume the service manager is 
             available when the initialized notification has been received.
            */
        lsp.addInitializer((_params: InitializeParams) => {
            amazonQServiceManager = serviceManager({
                credentialsProvider,
                lsp,
                workspace,
                logging,
                runtime,
                sdkInitializator,
                // Required for the service manager to be able to surface anything to the client. It is
                // optional on QServiceManagerFeatures so that existing constructions (including test
                // fixtures) keep compiling, which means omitting it here does not fail the build -- it
                // just silently disables client-facing reporting.
                notification,
            })

            /*
            TODO: Transform team to isolate tightly coupled Q and AWS Transform into AWS Transform as separate server
            Reference to suggestion -  https://github.com/aws/language-servers/pull/2521/files#r2558263205
            */
            // Initialize ATX Token Service Manager for ATX FES support
            AtxTokenServiceManager.initInstance({
                credentialsProvider,
                lsp,
                workspace,
                logging,
                runtime,
                sdkInitializator,
            })

            return {
                capabilities: {},
                awsServerCapabilities: {},
                // Required for anything to reach the client through the notification feature. The
                // runtime only builds a notification router when a server declares serverInfo, and
                // showNotification is a silent no-op without one. Not exposed to clients; it is used
                // internally to route notification followups back to the originating server, so the
                // name must stay stable.
                serverInfo: {
                    name: serverName,
                },
            }
        })

        lsp.onInitialized(async () => {
            log('Received onInitialized notification')
            await amazonQServiceManager.handleDidChangeConfiguration()
        })

        lsp.didChangeConfiguration(async () => {
            log('Received didChangeConfiguration notification')
            await amazonQServiceManager.handleDidChangeConfiguration()
        })

        lsp.workspace.onUpdateConfiguration(async (params: UpdateConfigurationParams, token: CancellationToken) => {
            log(`Received onUpdateConfiguration request for section: ${params.section}`)

            // Route to appropriate service manager based on configuration section
            if (params.section === Q_CONFIGURATION_SECTION) {
                await amazonQServiceManager.handleOnUpdateConfiguration(params, token)
            } else if (params.section === ATX_CONFIGURATION_SECTION) {
                const atxServiceManager = AtxTokenServiceManager.getInstance()
                await atxServiceManager.handleOnUpdateConfiguration(params, token)
            } else if (params.section === TRANSFORM_PROFILES_CONFIGURATION_SECTION) {
                const atxServiceManager = AtxTokenServiceManager.getInstance()
                await atxServiceManager.handleOnUpdateConfiguration(params, token)
            } else if (params.section === 'aws.transform') {
                const atxServiceManager = AtxTokenServiceManager.getInstance()
                await atxServiceManager.handleOnUpdateConfiguration(params, token)
            } else {
                log(`Unknown configuration section: ${params.section}`)
            }
        })

        credentialsProvider.onCredentialsDeleted((type: CredentialsType) => {
            log('Received onCredentialsDeleted notification')
            amazonQServiceManager.handleOnCredentialsDeleted(type)
        })

        // Optional chaining rather than a capability check: the event was added to the runtime after
        // this server, so a build running on an older runtime simply never receives it. Before that
        // runtime change this block was an `in` check plus an `any` cast that could never fire, which
        // is why service construction waited for whichever consumer asked first.
        credentialsProvider.onCredentialsUpdated?.((type: CredentialsType) => {
            log(`Received onCredentialsUpdated notification for type: ${type}`)
            amazonQServiceManager.handleOnCredentialsUpdated(type)
        })

        logging.log('Amazon Q Service server has been initialised')
        return () => {}
    }

// Must stay distinct from each other, and from every other server registered in the same runtime, or
// the runtime fails initialize with `Duplicate servers defined`. Must also stay stable over time: they
// are encoded into the id of every notification the client echoes back, so renaming strands followups
// for notifications already on screen. Exported so the uniqueness can be asserted in tests.
export const AMAZON_Q_SERVICE_SERVER_IAM_NAME = 'AWS Language Server for Amazon Q Developer (IAM)'
export const AMAZON_Q_SERVICE_SERVER_TOKEN_NAME = 'AWS Language Server for Amazon Q Developer (Token)'

export const AmazonQServiceServerIAM = AmazonQServiceServerFactory(
    initBaseIAMServiceManager,
    AMAZON_Q_SERVICE_SERVER_IAM_NAME
)
export const AmazonQServiceServerToken = AmazonQServiceServerFactory(
    initBaseTokenServiceManager,
    AMAZON_Q_SERVICE_SERVER_TOKEN_NAME
)
