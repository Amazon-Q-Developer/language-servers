/**
 * Thrown when the default schema loader refuses a URL. It is not a load failure of the default schema,
 * so it must not trigger a schema cache reset.
 */
export class SchemaUrlNotAllowedError extends Error {
    constructor(url: string) {
        super(`Schema not loaded: ${url}`)
        this.name = 'SchemaUrlNotAllowedError'
    }
}

/**
 * The default schema loader, used when the host passes no uriResolver, loads only https URLs on the same
 * origin as the default schema, so a `$schema` URL written in an edited document cannot make requests to
 * other hosts.
 */
export function isAllowedSchemaUrl(url: string, defaultSchemaUri: string | undefined): boolean {
    const allowedOrigin = httpsOrigin(defaultSchemaUri)
    return allowedOrigin !== undefined && httpsOrigin(url) === allowedOrigin
}

function httpsOrigin(url: string | undefined): string | undefined {
    if (!url) {
        return undefined
    }
    try {
        const parsed = new URL(url)
        return parsed.protocol === 'https:' ? parsed.origin : undefined
    } catch {
        return undefined
    }
}
