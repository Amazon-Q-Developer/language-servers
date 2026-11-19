/**
 * The service error code and HTTP status of a failed AWS Transform call, so the IDE can tell AccessDenied apart from
 * other failures. Never includes the error message, which can contain ARNs and account IDs.
 */
export interface AtxErrorInfo {
    errorCode?: string
    statusCode?: number
}

export function getAtxErrorInfo(error: any): AtxErrorInfo {
    // AWS SDK service errors are named after the modeled exception (e.g. AccessDeniedException); a plain Error isn't.
    const name: unknown = error?.name
    const errorCode = typeof name === 'string' && name.length > 0 && name !== 'Error' ? name : undefined
    const status: unknown = error?.$metadata?.httpStatusCode
    const statusCode = typeof status === 'number' ? status : undefined
    return { errorCode, statusCode }
}
