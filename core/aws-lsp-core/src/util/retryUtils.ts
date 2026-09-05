/*!
 * Copyright Amazon.com, Inc. or its affiliates.
 * All Rights Reserved. SPDX-License-Identifier: Apache-2.0
 */

// Default retry configuration constants
export const DEFAULT_MAX_RETRIES = 2
export const DEFAULT_BASE_DELAY = 500
export const DEFAULT_EXPONENTIAL_BACKOFF = true

// HTTP status code constants
const CLIENT_ERROR_MIN = 400
const CLIENT_ERROR_MAX = 500
const INTERNAL_SERVER_ERROR = 500
const SERVICE_UNAVAILABLE = 503

// AWS error code constants
const THROTTLING_EXCEPTION = 'ThrottlingException'
const INTERNAL_SERVER_EXCEPTION = 'InternalServerException'

export interface RetryOptions {
    /** Maximum number of retry attempts (default: DEFAULT_MAX_RETRIES) */
    maxRetries?: number
    /** Base delay in milliseconds (default: DEFAULT_BASE_DELAY) */
    baseDelay?: number
    /** Whether to use exponential backoff (default: DEFAULT_EXPONENTIAL_BACKOFF) */
    exponentialBackoff?: boolean
    /** Custom function to determine if an error is retryable */
    isRetryable?: (error: any) => boolean
}

/**
 * Default AWS error retry logic
 */
function defaultIsRetryable(error: any): boolean {
    const errorCode = error.code || error.name
    const statusCode = error.statusCode || error?.$metadata?.httpStatusCode

    // Fast fail on non-retryable client errors (except throttling)
    if (statusCode >= CLIENT_ERROR_MIN && statusCode < CLIENT_ERROR_MAX && errorCode !== THROTTLING_EXCEPTION) {
        return false
    }

    // Retry on throttling, server errors (5xx), and specific status codes
    return (
        errorCode === THROTTLING_EXCEPTION ||
        errorCode === INTERNAL_SERVER_EXCEPTION ||
        statusCode >= 500 ||
        statusCode === SERVICE_UNAVAILABLE
    )
}

/**
 * Executes a function with retry logic and exponential backoff
 */
export async function retryWithBackoff<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
    const {
        maxRetries = DEFAULT_MAX_RETRIES,
        baseDelay = DEFAULT_BASE_DELAY,
        exponentialBackoff = DEFAULT_EXPONENTIAL_BACKOFF,
        isRetryable = defaultIsRetryable,
    } = options

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn()
        } catch (error: any) {
            if (!isRetryable(error) || attempt === maxRetries - 1) {
                throw error
            }

            const delay = exponentialBackoff ? baseDelay * (attempt + 1) : baseDelay
            await new Promise(resolve => setTimeout(resolve, delay))
        }
    }
    throw new Error('Retry failed')
}
