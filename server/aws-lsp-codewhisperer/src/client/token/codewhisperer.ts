import { CodeWhispererRuntimeClient, CodeWhispererRuntimeClientConfig } from '@amzn/codewhisperer-runtime'
import { SDKInitializator, Logging, CredentialsProvider } from '@aws/language-server-runtimes/server-interface'
import { HttpResponse, HttpRequest } from '@smithy/types'
import { isQDevPluginAccessBlockedError } from '../../shared/utils'

export interface CodeWhispererTokenClientConfigurationOptions extends CodeWhispererRuntimeClientConfig {
    // Add any custom options if needed
}

export function createCodeWhispererTokenClient(
    options: CodeWhispererTokenClientConfigurationOptions,
    sdkInitializator: SDKInitializator,
    logging: Logging,
    credentialsProvider: CredentialsProvider,
    shareCodeWhispererContentWithAWS: () => boolean,
    onAccessBlocked?: (error: unknown) => void
): CodeWhispererRuntimeClient {
    logging.log(
        `Passing client for class CodeWhispererRuntimeClient to sdkInitializator (v3) for additional setup (e.g. proxy)`
    )

    const client = sdkInitializator(CodeWhispererRuntimeClient, {
        ...options,
    })

    // Add middleware for custom headers
    client.middlewareStack.add(
        next => async args => {
            const request = args.request as HttpRequest
            request.headers['x-amzn-codewhisperer-optout'] = `${!shareCodeWhispererContentWithAWS()}`

            if (credentialsProvider.getConnectionType() === 'external_idp') {
                request.headers['TokenType'] = 'EXTERNAL_IDP'
            }

            return next(args)
        },
        { step: 'build', priority: 'high' }
    )

    // Add middleware to capture HTTP headers
    client.middlewareStack.add(
        next => async args => {
            const result = await next(args)

            // Store headers on the response metadata
            if (result.response) {
                const httpResponse = result.response as HttpResponse
                if (httpResponse.headers && result.output?.$metadata) {
                    // Extend metadata to include headers
                    ;(result.output.$metadata as any).httpHeaders = httpResponse.headers
                }
            }

            return result
        },
        {
            step: 'deserialize',
            name: 'captureHeaders',
            priority: 'high',
        }
    )

    // Observe (never alter) errors that indicate RTS has blocked Q Developer plugin access for this
    // identity. RTS gates plugin traffic before the activity runs, so a blocked identity fails *every*
    // operation this way -- observing centrally here is what lets callers react to the first failure
    // instead of each call site having to classify the error itself.
    //
    // Deliberately a pure passthrough:
    //   - the original error is always rethrown unchanged, so error handling and retry behaviour of
    //     every existing operation are untouched;
    //   - the observer is invoked inside its own try/catch, so a faulty observer cannot convert a
    //     service error into a different one or mask it;
    //   - when no observer is supplied the middleware only rethrows, so existing callers that do not
    //     pass one behave exactly as before.
    //
    // Registered on the outermost (initialize) step so the error is observed once per operation, after
    // the SDK's retries are exhausted, rather than once per attempt.
    if (onAccessBlocked) {
        client.middlewareStack.add(
            next => async args => {
                try {
                    return await next(args)
                } catch (e) {
                    if (isQDevPluginAccessBlockedError(e)) {
                        try {
                            onAccessBlocked(e)
                        } catch (observerError) {
                            logging.debug(
                                `onAccessBlocked observer threw, ignoring: ${(observerError as Error)?.message}`
                            )
                        }
                    }
                    throw e
                }
            },
            {
                step: 'initialize',
                name: 'detectQDevPluginAccessBlocked',
            }
        )
    }

    return client
}

// Export the V3 client type for compatibility
export type CodeWhispererTokenClient = CodeWhispererRuntimeClient
