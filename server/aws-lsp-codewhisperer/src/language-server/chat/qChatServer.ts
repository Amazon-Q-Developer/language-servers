import { InitializeParams, Server } from '@aws/language-server-runtimes/server-interface'
import {
    feedbackNotificationType,
    inlineChatResultNotificationType,
    insertToCursorPositionNotificationType,
    tabAddNotificationType,
    tabChangeNotificationType,
    tabRemoveNotificationType,
} from '@aws/language-server-runtimes/protocol'
import { ChatController } from './chatController'
import { ChatSessionManagementService } from './chatSessionManagementService'
import { logNotificationErrors } from './notificationErrors'
import { CLEAR_QUICK_ACTION, HELP_QUICK_ACTION } from './quickActions'
import { TelemetryService } from '../../shared/telemetry/telemetryService'
import { makeUserContextObject } from '../../shared/telemetryUtils'
import { AmazonQBaseServiceManager } from '../../shared/amazonQServiceManager/BaseAmazonQServiceManager'
import { getOrThrowBaseTokenServiceManager } from '../../shared/amazonQServiceManager/AmazonQTokenServiceManager'
import { getOrThrowBaseIAMServiceManager } from '../../shared/amazonQServiceManager/AmazonQIAMServiceManager'

import { AmazonQWorkspaceConfig } from '../../shared/amazonQServiceManager/configurationUtils'
import { AmazonQServiceInitializationError } from '../../shared/amazonQServiceManager/errors'
import { safeGet } from '../../shared/utils'

export const QChatServerFactory =
    (serviceManager: () => AmazonQBaseServiceManager): Server =>
    features => {
        const { chat, credentialsProvider, lsp, telemetry, logging, runtime } = features

        // AmazonQTokenServiceManager and TelemetryService are initialized in `onInitialized` handler to make sure Language Server connection is started
        let amazonQServiceManager: AmazonQBaseServiceManager
        let telemetryService: TelemetryService

        let chatController: ChatController
        let chatSessionManagementService: ChatSessionManagementService

        lsp.addInitializer((params: InitializeParams) => {
            return {
                capabilities: {},
                awsServerCapabilities: {
                    chatOptions: {
                        quickActions: {
                            quickActionsCommandGroups: [
                                {
                                    commands: [HELP_QUICK_ACTION, CLEAR_QUICK_ACTION],
                                },
                            ],
                        },
                    },
                },
            }
        })

        const updateConfigurationHandler = (updatedConfig: AmazonQWorkspaceConfig) => {
            logging.debug('Updating configuration of chat server')
            chatController.updateConfiguration(updatedConfig)
        }

        lsp.onInitialized(async () => {
            // Get initialized service manager and inject it to chatSessionManagementService to pass it down
            amazonQServiceManager = serviceManager()
            chatSessionManagementService =
                ChatSessionManagementService.getInstance().withAmazonQServiceManager(amazonQServiceManager)

            telemetryService = new TelemetryService(amazonQServiceManager, credentialsProvider, telemetry, logging)
            const clientParams = safeGet(
                lsp.getClientInitializeParams(),
                new AmazonQServiceInitializationError(
                    'TelemetryService initialized before LSP connection was initialized.'
                )
            )
            telemetryService.updateUserContext(
                makeUserContextObject(clientParams, runtime.platform, 'CHAT', amazonQServiceManager.serverInfo)
            )

            chatController = new ChatController(
                chatSessionManagementService,
                features,
                telemetryService,
                amazonQServiceManager
            )

            await amazonQServiceManager.addDidChangeConfigurationListener(updateConfigurationHandler)
        })

        // Wrap each chat notification handler in logNotificationErrors. Request handlers need no wrapper, because the
        // JSON-RPC layer sends an error response when a request handler fails.
        chat.onTabAdd(
            logNotificationErrors(logging, tabAddNotificationType.method, params => {
                logging.log(`Adding tab: ${params.tabId}`)

                return chatController.onTabAdd(params)
            })
        )

        chat.onTabChange(
            logNotificationErrors(logging, tabChangeNotificationType.method, params => {
                logging.log(`Changing to tab: ${params.tabId}`)

                return chatController.onTabChange(params)
            })
        )

        chat.onTabRemove(
            logNotificationErrors(logging, tabRemoveNotificationType.method, params => {
                logging.log(`Removing tab: ${params.tabId}`)

                return chatController.onTabRemove(params)
            })
        )

        chat.onEndChat((...params) => {
            logging.log('Received end chat request')
            return chatController.onEndChat(...params)
        })

        chat.onChatPrompt((...params) => {
            logging.log('Received chat prompt')
            return chatController.onChatPrompt(...params)
        })

        chat.onInlineChatPrompt((...params) => {
            logging.log('Received inline chat prompt')
            return chatController.onInlineChatPrompt(...params)
        })

        chat.onQuickAction((...params) => {
            return chatController.onQuickAction(...params)
        })

        chat.onSendFeedback(
            logNotificationErrors(logging, feedbackNotificationType.method, params => {
                return chatController.onSendFeedback(params)
            })
        )

        chat.onCodeInsertToCursorPosition(
            logNotificationErrors(logging, insertToCursorPositionNotificationType.method, params => {
                return chatController.onCodeInsertToCursorPosition(params)
            })
        )

        chat.onInlineChatResult(
            logNotificationErrors(logging, inlineChatResultNotificationType.method, params => {
                return chatController.onInlineChatResult(params)
            })
        )

        logging.log('Q Chat server has been initialized')

        return () => {
            chatController?.dispose()
        }
    }

export const QChatServerIAM = QChatServerFactory(getOrThrowBaseIAMServiceManager)
export const QChatServerToken = QChatServerFactory(getOrThrowBaseTokenServiceManager)
