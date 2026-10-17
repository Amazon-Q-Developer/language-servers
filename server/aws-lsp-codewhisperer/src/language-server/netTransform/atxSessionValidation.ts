/**
 * Classifies a failed AWS Transform session validation call (ListWorkspaces) into the small set of reasons the
 * client turns into user-facing messages. Classification uses error names, faults, HTTP status and the modeled
 * AccessDeniedException reason; message text is only used for the phrases below.
 */

export type AtxSessionValidationReason =
    | 'ExpiredCredentials'
    | 'MissingPermission'
    | 'IamAuthNotEnabled'
    | 'IamAuthNotEnabledForAccount'
    | 'TenantMismatch'
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

/**
 * AccessDeniedException messages FES sends with reason INVALID_SESSION on the SigV4 path. None of them means expired
 * credentials. Matched on these phrases only; if FES changes the wording, the error is reported as Other. Compared
 * lowercase. The message itself is never logged or returned (the account message contains the account ID).
 */
export const INVALID_SESSION_PHRASES: ReadonlyArray<{ phrase: string; reason: AtxSessionValidationReason }> = [
    // FES SigV4ProfileResolutionHandler: "SigV4 access is not enabled for this profile. Enable IAM authentication in
    // profile preferences." (the tenant's AWS Transform profile has IAM authentication turned off).
    { phrase: 'sigv4 access is not enabled for this profile', reason: 'IamAuthNotEnabled' },
    // FES SigV4FeatureFlagHandler: "SigV4 access is not enabled for account <account id>" (service-side flag).
    { phrase: 'sigv4 access is not enabled for account', reason: 'IamAuthNotEnabledForAccount' },
    // FES SigV4ProfileResolutionHandler: "Credentials do not match the provided tenant." (the credentials' account
    // doesn't own the tenant).
    { phrase: 'credentials do not match the provided tenant', reason: 'TenantMismatch' },
]

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
        if (containsPhrase(error?.message, EXPIRED_TOKEN_PHRASES)) {
            return result('ExpiredCredentials')
        }
        if (containsPhrase(error?.message, SIGNATURE_MISMATCH_PHRASES)) {
            return result('Other')
        }
        const invalidSession = INVALID_SESSION_PHRASES.find(entry => containsPhrase(error?.message, [entry.phrase]))
        if (invalidSession) {
            return result(invalidSession.reason)
        }
        // INVALID_SESSION with a message we don't recognize: not necessarily expired credentials.
        if (error?.reason === 'INVALID_SESSION') {
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
