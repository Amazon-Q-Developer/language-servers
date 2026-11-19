import { ATX_FES_ENDPOINTS, ATX_FES_GAMMA_ENDPOINTS } from './constants'

/**
 * An AWS Transform web application (tenant) URL sent by the client for IAM sign-in:
 * https://<id>.transform[-gamma].<region>.on.aws. Only the origin is used (as the FES Origin header and to pick the
 * region), so a path, query or fragment is dropped. Anything else (http, another host, a user name or password, a
 * non-default port, a region without an AWS Transform endpoint) is rejected.
 */
export interface AtxTenantUrl {
    /** https://<host>, without a path or trailing slash. */
    origin: string
    region: string
    isGamma: boolean
}

// The whole host, anchored: <id>.transform[-gamma].<region>.on.aws
const TENANT_HOST_PATTERN = /^[a-z0-9][a-z0-9-]*\.transform(-gamma)?\.([a-z0-9-]+)\.on\.aws$/

/** The tenant URL, or undefined when it isn't an https AWS Transform URL in a region with an AWS Transform endpoint. */
export function parseAtxTenantUrl(tenantUrl: unknown): AtxTenantUrl | undefined {
    if (typeof tenantUrl !== 'string' || !tenantUrl.trim()) {
        return undefined
    }

    let url: URL
    try {
        url = new URL(tenantUrl.trim())
    } catch {
        return undefined
    }

    // URL lowercases the host and reports the default https port as ''.
    if (url.protocol !== 'https:' || url.username || url.password || url.port) {
        return undefined
    }

    const match = TENANT_HOST_PATTERN.exec(url.hostname)
    if (!match) {
        return undefined
    }

    const isGamma = match[1] !== undefined
    const region = match[2]
    const endpoints = isGamma ? ATX_FES_GAMMA_ENDPOINTS : ATX_FES_ENDPOINTS
    if (!endpoints.has(region)) {
        return undefined
    }

    return { origin: `https://${url.hostname}`, region, isGamma }
}
