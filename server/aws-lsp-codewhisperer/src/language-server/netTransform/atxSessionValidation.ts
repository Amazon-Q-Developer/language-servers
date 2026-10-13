/**
 * Classifies a failed AWS Transform session validation call (ListWorkspaces) into the small set of reasons the
 * client turns into user-facing messages. Classification uses error names, faults, HTTP status and the modeled
 * AccessDeniedException reason; message text is only used for the token phrases below.
 */

export type AtxSessionValidationReason =
    | 'ExpiredCredentials'
    | 'MissingPermission'
    | 'TenantNotFound'
    | 'NetworkOrService'
    | 'Other'

export interface AtxSessionValidationFailure {
    Reason: AtxSessionValidationReason
    ErrorCode: string
    HttpStatus?: number
}

/**
 * FES returns AccessDeniedException (not ExpiredTokenException) when the SigV4 security token has expired or is
 * invalid, for example "AccessDeniedException: The security token included in the request is expired". These
 * standard AWS phrases are the only way to tell expired credentials apart from a real permission problem.
 * Compared lowercase.
 */
export const EXPIRED_TOKEN_PHRASES: readonly string[] = [
    'the security token included in the request is expired',
    'the security token included in the request is invalid',
]

/**
 * FES also returns AccessDeniedException for a SigV4 signature mismatch ("The request signature we calculated does
 * not match the signature you provided"). That points to a signer or clock-skew problem, not expired credentials or
 * a missing permission, so it is reported as Other. Compared lowercase.
 */
export const SIGNATURE_MISMATCH_PHRASES: readonly string[] = ['the request signature we calculated does not match']

const EXPIRED_TOKEN_ERROR_NAMES = new Set([
    'ExpiredToken',
    'ExpiredTokenException',
    'InvalidClientTokenId',
    'UnrecognizedClientException',
])

const SERVICE_ERROR_NAMES = new Set(['InternalServerException', 'ThrottlingException', 'ServiceUnavailableException'])

const NETWORK_ERROR_NAMES = new Set(['TimeoutError', 'RequestTimeout', 'RequestTimeoutException', 'NetworkingError'])

const NETWORK_ERROR_CODES = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'])

const TENANT_ERROR_NAMES = new Set(['ResourceNotFoundException', 'ValidationException'])

export function classifyAtxSessionValidationError(error: any): AtxSessionValidationFailure {
    const errorCode: string = error?.name || error?.code || 'Unknown'
    const httpStatus: number | undefined = error?.$metadata?.httpStatusCode

    const result = (reason: AtxSessionValidationReason): AtxSessionValidationFailure => ({
        Reason: reason,
        ErrorCode: errorCode,
        HttpStatus: httpStatus,
    })

    if (NETWORK_ERROR_NAMES.has(errorCode) || NETWORK_ERROR_CODES.has(error?.code)) {
        return result('NetworkOrService')
    }

    if (
        error?.$fault === 'server' ||
        (httpStatus !== undefined && httpStatus >= 500) ||
        SERVICE_ERROR_NAMES.has(errorCode)
    ) {
        return result('NetworkOrService')
    }

    if (EXPIRED_TOKEN_ERROR_NAMES.has(errorCode)) {
        return result('ExpiredCredentials')
    }

    if (errorCode === 'AccessDeniedException') {
        if (error?.reason === 'INVALID_SESSION' || containsPhrase(error?.message, EXPIRED_TOKEN_PHRASES)) {
            return result('ExpiredCredentials')
        }
        if (containsPhrase(error?.message, SIGNATURE_MISMATCH_PHRASES)) {
            return result('Other')
        }
        return result('MissingPermission')
    }

    if (TENANT_ERROR_NAMES.has(errorCode)) {
        return result('TenantNotFound')
    }

    return result('Other')
}

function containsPhrase(message: unknown, phrases: readonly string[]): boolean {
    if (typeof message !== 'string') {
        return false
    }
    const lower = message.toLowerCase()
    return phrases.some(phrase => lower.includes(phrase))
}
