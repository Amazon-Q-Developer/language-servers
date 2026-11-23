import { Logging } from '@aws/language-server-runtimes/server-interface'
import { loggingUtils } from '@aws/lsp-core'

/**
 * Wraps a chat notification handler so that a failure is logged and does not escape. The JSON-RPC layer ignores the
 * value that a notification handler returns, so a rejected promise from an async controller method would otherwise
 * be an unhandled rejection.
 */
export function logNotificationErrors<P>(
    logging: Logging,
    method: string,
    handler: (params: P) => unknown
): (params: P) => void {
    const logError = (error: unknown) => {
        try {
            logging.error(`Chat notification ${method} failed: ${loggingUtils.formatErr(error)}`)
        } catch {
            // An error that cannot be formatted, or a logger that throws, must not become an unhandled rejection
        }
    }
    return params => {
        try {
            void Promise.resolve(handler(params)).catch(logError)
        } catch (error) {
            logError(error)
        }
    }
}
