/*!
 * Copyright Amazon.com, Inc. or its affiliates.
 * All Rights Reserved. SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'crypto'
import { promises as dns } from 'dns'
import * as path from 'path'
import { URL, URLSearchParams } from 'url'
import * as http from 'http'
import { isIPv4, isIPv6 } from 'net'
import * as os from 'os'
import { Logger, Workspace, Lsp } from '@aws/language-server-runtimes/server-interface'

interface Token {
    access_token: string
    expires_in: number
    refresh_token?: string
    obtained_at: number
}

interface Meta {
    authorization_endpoint: string
    token_endpoint: string
    registration_endpoint?: string
    scopes_supported?: string[]
    token_endpoint_auth_methods_supported?: string[]
}

interface Registration {
    client_id: string
    client_secret?: string
    expires_at?: number
    redirect_uri: string
    token_endpoint_auth_method?: string
}

/**
 * Where an address is, for the check of the URLs that an MCP server supplies during an OAuth sign-in (see
 * OAuthClient.assertAllowedTarget). 'blocked' covers addresses that no MCP server may send the client to.
 */
type AddressScope = 'public' | 'private' | 'loopback' | 'blocked'

/** Order of the scopes that an MCP server may send the client to. A higher rank is closer to this computer. */
const SCOPE_RANK: Record<Exclude<AddressScope, 'blocked'>, number> = { public: 0, private: 1, loopback: 2 }

/** Redirects that the client follows for one discovery request */
const MAX_DISCOVERY_REDIRECTS = 5

function ipv4Scope([a, b, c]: number[]): AddressScope {
    if (a === 127) {
        return 'loopback'
    }
    // "This network", link-local (where cloud instance metadata services are), multicast, reserved and broadcast
    if (a === 0 || (a === 169 && b === 254) || a >= 224) {
        return 'blocked'
    }
    if (
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127) || // shared address space (carrier-grade NAT)
        (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
        (a === 198 && (b === 18 || b === 19)) // benchmarking
    ) {
        return 'private'
    }
    return 'public'
}

/** The eight 16-bit groups of an IPv6 address, or undefined if the text is not one */
function ipv6Groups(address: string): number[] | undefined {
    let host: string
    try {
        // The URL parser writes the address in canonical form, with an embedded IPv4 address in hexadecimal
        host = new URL(`http://[${address.replace(/%.*$/, '')}]/`).hostname.slice(1, -1)
    } catch {
        return undefined
    }
    const [head, tail] = host.split('::')
    const left = head ? head.split(':') : []
    const right = tail ? tail.split(':') : []
    const zeros = tail === undefined ? 0 : 8 - left.length - right.length
    const groups = [...left, ...Array<string>(Math.max(zeros, 0)).fill('0'), ...right].map(g => parseInt(g, 16))
    return groups.length === 8 && groups.every(g => g >= 0 && g <= 0xffff) ? groups : undefined
}

function ipv6Scope(g: number[]): AddressScope {
    if (g.every(x => x === 0)) {
        return 'blocked' // unspecified
    }
    if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) {
        return 'loopback'
    }
    const embedsIPv4 =
        (g.slice(0, 5).every(x => x === 0) && (g[5] === 0xffff || g[5] === 0)) || // IPv4-mapped and IPv4-compatible
        (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) // NAT64
    if (embedsIPv4) {
        return ipv4Scope([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff])
    }
    if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00) {
        return 'blocked' // link-local, multicast
    }
    if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfec0) {
        return 'private' // unique local, site-local
    }
    return 'public'
}

/** The scope of an IP address, or undefined if the text is not an IP address */
function addressScope(address: string): AddressScope | undefined {
    if (isIPv4(address)) {
        return ipv4Scope(address.split('.').map(Number))
    }
    const groups = isIPv6(address) ? ipv6Groups(address) : undefined
    return groups ? ipv6Scope(groups) : undefined
}

export class OAuthClient {
    private static logger: Logger
    private static workspace: Workspace
    private static lsp: Lsp

    public static initialize(ws: Workspace, logger: Logger, lsp: Lsp): void {
        this.workspace = ws
        this.logger = logger
        this.lsp = lsp
    }

    /**
     * Return a valid Bearer token, reusing cache or refresh-token if possible,
     * otherwise (when interactive) driving one PKCE flow that may launch a browser.
     */
    public static async getValidAccessToken(
        mcpBase: URL,
        opts: { interactive?: boolean } = { interactive: false }
    ): Promise<string | undefined> {
        const interactive = opts?.interactive === true
        const key = this.computeKey(mcpBase)
        const regPath = path.join(this.cacheDir, `${key}.registration.json`)
        const tokPath = path.join(this.cacheDir, `${key}.token.json`)
        const metaPath = path.join(this.cacheDir, `${key}.meta.json`)

        // Silent branch: try cached token, then refresh, never opens a browser
        if (!interactive) {
            const cachedTok = await this.read<Token>(tokPath)
            if (cachedTok) {
                const expiry = cachedTok.obtained_at + cachedTok.expires_in * 1000
                if (Date.now() < expiry) {
                    this.logger.info('OAuth: using still-valid cached token (silent)')
                    return cachedTok.access_token
                }
                this.logger.info('OAuth: cached token expired, trying refresh (silent)')
            }

            const savedReg = await this.read<Registration>(regPath)
            if (cachedTok?.refresh_token && savedReg) {
                try {
                    const { meta, pinned } = await this.pinnedOrDiscoveredMeta(metaPath, mcpBase)
                    const refreshed = await this.refreshGrant(meta, savedReg, mcpBase, cachedTok.refresh_token)
                    if (refreshed) {
                        await this.write(tokPath, refreshed)
                        if (!pinned) {
                            // Migrate a legacy or invalidated pin: remember the endpoints that
                            // just worked so later silent refreshes reuse them instead of
                            // re-discovering, which would re-expose the refresh token.
                            await this.write(metaPath, meta)
                        }
                        this.logger.info('OAuth: refresh grant succeeded (silent)')
                        return refreshed.access_token
                    }
                } catch (e) {
                    this.logger.warn(`OAuth: silent refresh failed — ${e instanceof Error ? e.message : String(e)}`)
                }
            }

            return undefined
        }

        // Interactive branch: may open a browser (PKCE)
        let server: http.Server | null = null
        let redirectUri: string
        const savedReg = await this.read<Registration>(regPath)
        if (savedReg) {
            const port = Number(new URL(savedReg.redirect_uri).port)
            const normalized = `http://localhost:${port}/oauth/callback`
            server = http.createServer()
            try {
                await this.listen(server, port, 'localhost')
                redirectUri = normalized
            } catch (e: any) {
                if (e.code === 'EADDRINUSE') {
                    try {
                        server.close()
                    } catch {
                        /* ignore */
                    }
                    this.logger.warn(`OAuth: port ${port} in use, falling back to new random port`)
                    ;({ server, redirectUri } = await this.buildCallbackServer())
                    await this.workspace.fs.rm(regPath)
                } else {
                    throw e
                }
            }
        } else {
            ;({ server, redirectUri } = await this.buildCallbackServer())
        }

        try {
            const cached = await this.read<Token>(tokPath)
            if (cached) {
                const expiry = cached.obtained_at + cached.expires_in * 1000
                if (Date.now() < expiry) {
                    this.logger.info('OAuth: using still-valid cached token')
                    return cached.access_token
                }
            }

            // Try the refresh token before opening a browser, but only with the endpoints and the client
            // registration of the last sign-in. Discovery results come from the server, so sending the refresh
            // token to a token endpoint that discovery finds now would let the server take the token.
            if (cached?.refresh_token) {
                const refreshed = await this.refreshWithPinnedEndpoints(
                    metaPath,
                    regPath,
                    mcpBase,
                    cached.refresh_token
                )
                if (refreshed) {
                    await this.write(tokPath, refreshed)
                    this.logger.info('OAuth: refresh grant succeeded')
                    return refreshed.access_token
                }
            }

            const meta = await this.discoverAS(mcpBase)

            // Use scopes from discovery metadata, fall back to OIDC defaults
            const scopes =
                meta.scopes_supported && meta.scopes_supported.length > 0
                    ? meta.scopes_supported
                    : ['openid', 'offline_access']

            const reg = await this.obtainClient(meta, regPath, scopes, redirectUri, mcpBase)

            // PKCE flow in the browser. The endpoints found now are pinned only after it succeeds.
            const fresh = await this.pkceGrant(meta, reg, mcpBase, scopes, redirectUri, server)
            await this.write(tokPath, fresh)
            await this.write(metaPath, meta)
            return fresh.access_token
        } finally {
            if (server) {
                await new Promise<void>(res => server!.close(() => res()))
            }
        }
    }

    /** Spin up a one-time HTTP listener on localhost:randomPort */
    private static async buildCallbackServer(): Promise<{ server: http.Server; redirectUri: string }> {
        const server = http.createServer()
        await this.listen(server, 0, 'localhost')
        const port = (server.address() as any).port as number
        return { server, redirectUri: `http://localhost:${port}/oauth/callback` }
    }

    /**
     * Resolve the endpoints for a silent refresh. Prefer the endpoints pinned
     * when the user first signed in; only fall back to live discovery for
     * tokens cached before pinning existed or when the pin is no longer valid.
     * Re-running discovery on every refresh would let a server that later turns
     * malicious (or a network attacker on the discovery response) redirect the
     * refresh token to a new token endpoint without the user ever being
     * prompted again.
     *
     * Returns `pinned` so the caller can migrate a legacy token by pinning the
     * endpoints that just worked. A legitimately rotated token endpoint is
     * recovered on the next sign-in in the browser, which re-pins.
     */
    private static async pinnedOrDiscoveredMeta(
        metaPath: string,
        mcpBase: URL
    ): Promise<{ meta: Meta; pinned: boolean }> {
        const pinned = await this.readPinnedMeta(metaPath)
        if (pinned) {
            return { meta: pinned, pinned: true }
        }
        return { meta: await this.discoverAS(mcpBase), pinned: false }
    }

    /**
     * The endpoints pinned at the last sign-in, or undefined when none were pinned (a token cached before
     * pinning existed) or when the pinned token endpoint is not secure.
     */
    private static async readPinnedMeta(metaPath: string): Promise<Meta | undefined> {
        const pinned = await this.read<Meta>(metaPath)
        if (!pinned?.token_endpoint) {
            return undefined
        }
        try {
            this.validateTokenEndpoint(pinned.token_endpoint)
            return pinned
        } catch (e) {
            this.logger.warn(
                `OAuth: ignoring invalid pinned token endpoint — ${e instanceof Error ? e.message : String(e)}`
            )
            return undefined
        }
    }

    /**
     * One refresh_token grant for an interactive sign-in, with the pinned endpoints and the client registration on
     * disk only. Returns undefined, and sends nothing, when no valid endpoints were pinned or no registration is
     * saved. Also returns undefined when the grant fails, so that the caller signs in in the browser instead.
     * Unlike a silent refresh, this never falls back to discovery: the browser sign-in that follows re-pins the
     * endpoints, so a token cached before pinning existed does not need to be sent to discovered endpoints.
     */
    private static async refreshWithPinnedEndpoints(
        metaPath: string,
        regPath: string,
        mcpBase: URL,
        refreshToken: string
    ): Promise<Token | undefined> {
        const pinned = await this.readPinnedMeta(metaPath)
        const reg = await this.read<Registration>(regPath)
        if (!pinned || !reg) {
            this.logger.info('OAuth: no pinned endpoints or client registration; skipping the refresh grant')
            return undefined
        }
        try {
            return await this.refreshGrant(pinned, reg, mcpBase, refreshToken)
        } catch (e) {
            this.logger.warn(
                `OAuth: refresh grant with the pinned endpoints failed — ${e instanceof Error ? e.message : String(e)}`
            )
            return undefined
        }
    }

    /**
     * Discover OAuth endpoints using the following chain (aligned with MCP SDK):
     * 1. RFC 9728 Protected Resource Metadata
     * 2. WWW-Authenticate header resource_metadata link
     * 3. RFC 8414 / OIDC well-known endpoints on the resource server
     * 4. Fallback to synthesized static endpoints
     */
    private static async discoverAS(rs: URL): Promise<Meta> {
        // Step 1: RFC 9728 Protected Resource Metadata
        try {
            const prm = await this.discoverProtectedResourceMetadata(rs)
            if (prm) {
                const asUrl = prm.authorization_servers?.[0]
                if (asUrl) {
                    this.assertSecureEndpoint(String(asUrl), 'authorization server')
                    const asMeta = await this.discoverAuthorizationServerMetadata(new URL(asUrl), rs)
                    if (asMeta) {
                        if (!asMeta.scopes_supported && prm.scopes_supported) {
                            asMeta.scopes_supported = prm.scopes_supported
                        }
                        return asMeta
                    }
                }
            }
        } catch (e) {
            this.logger.info(`OAuth: RFC 9728 discovery failed — ${e instanceof Error ? e.message : String(e)}`)
        }

        // Step 2: HEAD → WWW-Authenticate → resource_metadata link
        try {
            const h = await this.discoveryFetch(rs.toString(), rs, 'MCP server', { method: 'HEAD' })
            const header = h.headers.get('www-authenticate') || ''
            const m = /resource_metadata=(?:"([^"]+)"|([^,\s]+))/i.exec(header)
            if (m) {
                const metaUrl = new URL(m[1] || m[2], rs).toString()
                // The resource_metadata link comes from a server-supplied header; require a secure transport.
                this.assertSecureEndpoint(metaUrl, 'resource metadata')
                const raw = await this.json<any>(metaUrl, rs, 'resource metadata')
                return await this.fetchASFromResourceMeta(raw, metaUrl, rs)
            }
        } catch (e) {
            this.logger.info(`OAuth: WWW-Authenticate discovery failed — ${e instanceof Error ? e.message : String(e)}`)
        }

        // Step 3: Well-known endpoints on the resource server
        const asMeta = await this.discoverAuthorizationServerMetadata(new URL('/', rs), rs)
        if (asMeta) {
            return asMeta
        }

        // Step 4: Fallback to static endpoints
        const base = (rs.origin + rs.pathname).replace(/\/+$/, '')
        this.logger.warn(`OAuth: all discovery failed, synthesizing endpoints from ${base}`)
        return {
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/access_token`,
        }
    }

    /**
     * RFC 9728: Discover OAuth Protected Resource Metadata.
     * Tries path-aware URL first, then root fallback.
     */
    private static async discoverProtectedResourceMetadata(rs: URL): Promise<any | undefined> {
        const pathname = rs.pathname.endsWith('/') ? rs.pathname.slice(0, -1) : rs.pathname
        const urlsToTry = [new URL(`/.well-known/oauth-protected-resource${pathname}`, rs.origin).toString()]
        if (pathname && pathname !== '/') {
            urlsToTry.push(new URL('/.well-known/oauth-protected-resource', rs.origin).toString())
        }

        for (const url of urlsToTry) {
            try {
                const resp = await this.discoveryFetch(url, rs, 'resource metadata', {
                    headers: { 'MCP-Protocol-Version': '2025-03-26' },
                })
                if (resp.ok) {
                    return await resp.json()
                }
            } catch {
                // Try next URL
            }
        }
        return undefined
    }

    /**
     * Discover Authorization Server Metadata via RFC 8414 and OIDC Discovery.
     * Matches the MCP SDK's buildDiscoveryUrls pattern.
     */
    private static async discoverAuthorizationServerMetadata(asUrl: URL, rs: URL): Promise<Meta | undefined> {
        const pathname = asUrl.pathname.endsWith('/') ? asUrl.pathname.slice(0, -1) : asUrl.pathname
        const hasPath = pathname !== '' && pathname !== '/'

        const urlsToTry: string[] = []
        if (!hasPath) {
            urlsToTry.push(new URL('/.well-known/oauth-authorization-server', asUrl.origin).toString())
            urlsToTry.push(new URL('/.well-known/openid-configuration', asUrl.origin).toString())
        } else {
            urlsToTry.push(new URL(`/.well-known/oauth-authorization-server${pathname}`, asUrl.origin).toString())
            urlsToTry.push(new URL(`/.well-known/openid-configuration${pathname}`, asUrl.origin).toString())
            urlsToTry.push(new URL(`${pathname}/.well-known/openid-configuration`, asUrl.origin).toString())
        }

        for (const url of urlsToTry) {
            try {
                return await this.json<Meta>(url, rs, 'authorization server')
            } catch {
                // Try next URL
            }
        }
        return undefined
    }

    /** Follow authorization_server(s) in resource_metadata JSON */
    private static async fetchASFromResourceMeta(raw: any, metaUrl: string, rs: URL): Promise<Meta> {
        let asBase = raw.authorization_server
        if (!asBase && Array.isArray(raw.authorization_servers)) {
            asBase = raw.authorization_servers[0]
        }
        if (!asBase) {
            throw new Error(`resource_metadata at ${metaUrl} lacked authorization_server(s)`)
        }
        this.assertSecureEndpoint(String(asBase), 'authorization server')

        for (const p of ['.well-known/oauth-authorization-server', '.well-known/openid-configuration']) {
            try {
                return await this.json<Meta>(new URL(p, asBase).toString(), rs, 'authorization server')
            } catch {
                // next
            }
        }
        this.logger.warn(`OAuth: no well-known on ${asBase}, falling back to static endpoints`)
        return {
            authorization_endpoint: `${asBase}/authorize`,
            token_endpoint: `${asBase}/access_token`,
        }
    }

    /** DCR: POST client metadata → client_id; cache to disk */
    private static async obtainClient(
        meta: Meta,
        file: string,
        _scopes: string[],
        redirectUri: string,
        rs: URL
    ): Promise<Registration> {
        const existing = await this.read<Registration>(file)
        if (existing && (!existing.expires_at || existing.expires_at * 1000 > Date.now())) {
            this.logger.info(`OAuth: reusing cached client_id ${existing.client_id}`)
            return existing
        }

        if (!meta.registration_endpoint) {
            throw new Error('OAuth: AS does not support dynamic registration')
        }
        // The registration endpoint is server-supplied via discovery; require a secure transport.
        this.assertSecureEndpoint(meta.registration_endpoint, 'registration endpoint')

        // Let the server decide token_endpoint_auth_method and scope
        const body = {
            client_name: 'kiro',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            redirect_uris: [redirectUri],
        }
        const resp: any = await this.json(meta.registration_endpoint, rs, 'registration endpoint', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        })

        const reg: Registration = {
            client_id: resp.client_id,
            client_secret: resp.client_secret,
            expires_at: resp.client_secret_expires_at,
            redirect_uri: redirectUri,
            token_endpoint_auth_method: resp.token_endpoint_auth_method,
        }
        await this.write(file, reg)
        return reg
    }

    /** Try one refresh_token grant; returns new Token or undefined */
    private static async refreshGrant(
        meta: Meta,
        reg: Registration,
        rs: URL,
        refresh: string
    ): Promise<Token | undefined> {
        this.validateTokenEndpoint(meta.token_endpoint)
        await this.assertAllowedTarget(new URL(meta.token_endpoint), rs, 'token endpoint')
        const formParams: Record<string, string> = {
            grant_type: 'refresh_token',
            refresh_token: refresh,
            resource: rs.toString(),
        }
        const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }

        const authMethod = this.selectAuthMethod(reg, meta)
        this.applyAuth(authMethod, reg, headers, formParams)

        const res = await this.fetchCompat(meta.token_endpoint, {
            method: 'POST',
            redirect: 'error',
            headers,
            body: new URLSearchParams(formParams),
        })
        if (!res.ok) {
            const msg = await res.text().catch(() => '')
            this.logger.warn(`OAuth: refresh grant HTTP ${res.status} — ${msg?.slice(0, 300)}`)
            return undefined
        }
        const tokenResponse = (await res.json()) as Record<string, unknown>
        return { ...(tokenResponse as object), obtained_at: Date.now() } as Token
    }

    /** One PKCE flow: browser + loopback → code → token */
    private static async pkceGrant(
        meta: Meta,
        reg: Registration,
        rs: URL,
        scopes: string[],
        redirectUri: string,
        server: http.Server
    ): Promise<Token> {
        this.validateTokenEndpoint(meta.token_endpoint)
        // Check the token endpoint before the browser opens, so that a sign-in that cannot finish does not start
        await this.assertAllowedTarget(new URL(meta.token_endpoint), rs, 'token endpoint')
        const DEFAULT_PKCE_TIMEOUT_MS = 90_000

        const verifier = this.b64url(crypto.randomBytes(32))
        const challenge = this.b64url(crypto.createHash('sha256').update(verifier).digest())
        const state = this.b64url(crypto.randomBytes(16))

        const authz = this.validateAuthorizationEndpoint(meta.authorization_endpoint)
        authz.search = new URLSearchParams({
            client_id: reg.client_id,
            response_type: 'code',
            code_challenge: challenge,
            code_challenge_method: 'S256',
            resource: rs.toString(),
            scope: scopes.join(' '),
            redirect_uri: redirectUri,
            state,
        }).toString()

        await this.lsp.window.showDocument({ uri: authz.toString(), external: true })

        const waitForFlow = new Promise<{ code: string; rxState: string; err?: string; errDesc?: string }>(resolve => {
            server.on('request', (req, res) => {
                const u = new URL(req.url || '/', redirectUri)
                const c = u.searchParams.get('code') || ''
                const s = u.searchParams.get('state') || ''
                const e = u.searchParams.get('error') || undefined
                const ed = u.searchParams.get('error_description') || undefined
                res.writeHead(200, { 'content-type': 'text/html' }).end('<h2>You may close this tab.</h2>')
                resolve({ code: c, rxState: s, err: e, errDesc: ed })
            })
        })
        const { code, rxState, err, errDesc } = await Promise.race([
            waitForFlow,
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('authorization_timed_out')), DEFAULT_PKCE_TIMEOUT_MS)
            ),
        ])
        if (err) {
            throw new Error(`Authorization error: ${err}${errDesc ? ` - ${errDesc}` : ''}`)
        }
        if (!code || rxState !== state) throw new Error('Invalid authorization response (state mismatch)')

        // Exchange code for token using the auth method from DCR
        this.validateTokenEndpoint(meta.token_endpoint)
        const tokenParams: Record<string, string> = {
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            redirect_uri: redirectUri,
            resource: rs.toString(),
        }
        const tokenHeaders: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }

        const authMethod = this.selectAuthMethod(reg, meta)
        this.applyAuth(authMethod, reg, tokenHeaders, tokenParams)

        const res2 = await this.fetchCompat(meta.token_endpoint, {
            method: 'POST',
            redirect: 'error',
            headers: tokenHeaders,
            body: new URLSearchParams(tokenParams),
        })
        if (!res2.ok) {
            const txt = await res2.text().catch(() => '')
            throw new Error(`Token exchange failed (HTTP ${res2.status}): ${txt?.slice(0, 300)}`)
        }
        const tk = (await res2.json()) as Record<string, unknown>
        return { ...(tk as object), obtained_at: Date.now() } as Token
    }

    /**
     * Fetch + error-check + parse JSON, for the MCP server at `rs`. A GET follows redirects through discoveryFetch.
     * Any other request, such as the client registration, is sent once, after the target check, and fails on a
     * redirect.
     */
    private static async json<T>(url: string, rs: URL, label: string, init?: RequestInit): Promise<T> {
        const method = (init?.method ?? 'GET').toUpperCase()
        let r: any
        if (method === 'GET') {
            r = await this.discoveryFetch(url, rs, label, init)
        } else {
            await this.assertAllowedTarget(new URL(url), rs, label)
            r = await this.fetchCompat(url, { ...init, redirect: 'error' })
        }
        if (!r.ok) {
            const txt = await r.text().catch(() => '')
            throw new Error(`HTTP ${r.status}@${url} — ${txt}`)
        }
        return (await r.json()) as T
    }

    /** Read & parse JSON file via workspace.fs */
    private static async read<T>(file: string): Promise<T | undefined> {
        try {
            if (!(await this.workspace.fs.exists(file))) return undefined
            const buf = await this.workspace.fs.readFile(file)
            return JSON.parse(buf.toString()) as T
        } catch {
            return undefined
        }
    }

    /** Write JSON, then clamp file perms to 0600 (owner read/write) */
    private static async write(file: string, obj: unknown): Promise<void> {
        const dir = path.dirname(file)
        await this.workspace.fs.mkdir(dir, { recursive: true })
        await this.workspace.fs.writeFile(file, JSON.stringify(obj, null, 2), { mode: 0o600 })
    }

    /** SHA-256 of resourceServer URL → hex key */
    private static computeKey(rs: URL): string {
        return crypto
            .createHash('sha256')
            .update(rs.origin + rs.pathname)
            .digest('hex')
    }

    /** RFC-7636 base64url without padding */
    private static b64url(buf: Buffer): string {
        return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
    }

    /** Directory for caching registration + tokens */
    private static readonly cacheDir = path.join(os.homedir(), '.aws', 'sso', 'cache')

    /**
     * Select the client authentication method, matching the MCP SDK's selectClientAuthMethod logic.
     * Priority: token_endpoint_auth_method from DCR > server-supported methods > defaults.
     */
    private static selectAuthMethod(reg: Registration, meta?: Meta): string {
        const hasSecret = !!reg.client_secret
        const supported = meta?.token_endpoint_auth_methods_supported ?? []

        if (reg.token_endpoint_auth_method) {
            if (supported.length === 0 || supported.includes(reg.token_endpoint_auth_method)) {
                return reg.token_endpoint_auth_method
            }
        }

        if (supported.length > 0) {
            if (hasSecret && supported.includes('client_secret_basic')) return 'client_secret_basic'
            if (hasSecret && supported.includes('client_secret_post')) return 'client_secret_post'
            if (supported.includes('none')) return 'none'
        }

        return hasSecret ? 'client_secret_post' : 'none'
    }

    /** Apply client authentication to headers and params based on the selected method. */
    private static applyAuth(
        method: string,
        reg: Registration,
        headers: Record<string, string>,
        params: Record<string, string>
    ): void {
        switch (method) {
            case 'client_secret_basic':
                if (!reg.client_secret) throw new Error('client_secret_basic requires a client_secret')
                headers['authorization'] =
                    `Basic ${Buffer.from(`${reg.client_id}:${reg.client_secret}`).toString('base64')}`
                break
            case 'client_secret_post':
                params.client_id = reg.client_id
                if (reg.client_secret) params.client_secret = reg.client_secret
                break
            case 'none':
            default:
                params.client_id = reg.client_id
                break
        }
    }

    /**
     * Token exchanges carry refresh tokens, authorization codes, and potentially client credentials.
     * Require HTTPS for remote endpoints while retaining the OAuth loopback exception for local development.
     */
    private static validateTokenEndpoint(endpoint: string): void {
        this.assertSecureEndpoint(endpoint, 'token endpoint')
    }

    /**
     * The authorization endpoint is handed to the OS browser via showDocument,
     * and an MCP server supplies it through discovery. Restrict it to HTTPS (or
     * a loopback HTTP address for local development) so a hostile server cannot
     * launch a javascript:, file:, data: or other non-web URI, or send the user
     * to a plaintext remote login page. Returns the parsed URL for the caller.
     */
    private static validateAuthorizationEndpoint(endpoint: string): URL {
        return this.assertSecureEndpoint(endpoint, 'authorization endpoint')
    }

    /**
     * Require HTTPS for a remote OAuth endpoint, keeping the loopback HTTP
     * exception for local development. Rejects every other scheme (javascript:,
     * file:, data:, ftp:, ...) and malformed URLs. Returns the parsed URL so
     * callers can reuse it without parsing twice.
     */
    private static assertSecureEndpoint(endpoint: string, label: string): URL {
        let url: URL
        try {
            url = new URL(endpoint)
        } catch {
            throw new Error(`OAuth: ${label} is not a valid URL`)
        }

        if (url.protocol === 'https:') {
            return url
        }

        const hostname = url.hostname.toLowerCase()
        const isLoopbackHttp =
            url.protocol === 'http:' &&
            (hostname === 'localhost' || hostname === '[::1]' || (isIPv4(hostname) && hostname.startsWith('127.')))
        if (isLoopbackHttp) {
            return url
        }

        throw new Error(`OAuth: ${label} must use HTTPS unless it is a loopback address`)
    }

    /**
     * Throws unless the client may send a request to `target`, a URL from the OAuth metadata of the MCP server at
     * `rs` or a redirect of a discovery request. The MCP server controls these URLs, so they must not reach
     * addresses that this computer can reach and the MCP server cannot: a public MCP server may send the client
     * to public addresses only, an MCP server on a private network also to private addresses, and an MCP server
     * on this computer also to loopback addresses. Link-local addresses, where cloud instance metadata services
     * are, and unspecified, multicast and reserved addresses are never allowed. Where the MCP server is comes from
     * serverScope, which takes its address farthest from this computer.
     *
     * A host name is checked by the addresses that it resolves to now: one blocked address blocks it, and otherwise
     * the address closest to this computer decides. A name that does not resolve is refused, so that a lookup that
     * fails for the check cannot let a later lookup for the request choose the address. A URL on the host name of
     * the MCP server is allowed, because the user chose that host.
     */
    private static async assertAllowedTarget(target: URL, rs: URL, label: string): Promise<void> {
        if (target.hostname === rs.hostname) {
            return
        }
        const targetScope = await this.hostScope(target.hostname)
        if (targetScope === 'public') {
            return
        }
        if (targetScope === undefined) {
            throw new Error(`OAuth: ${label} has a host name that could not be resolved`)
        }
        if (targetScope !== 'blocked') {
            const serverRank = SCOPE_RANK[await this.serverScope(rs.hostname)]
            if (serverRank >= SCOPE_RANK[targetScope]) {
                return
            }
        }
        const where = targetScope === 'blocked' ? 'a link-local or reserved' : `a ${targetScope}`
        throw new Error(`OAuth: ${label} is on ${where} address, which this MCP server cannot send the client to`)
    }

    /**
     * The scope of a URL host as a target: the scope of the address, or of the addresses that the name resolves to,
     * where a blocked address decides first and then the address closest to this computer. Undefined when the name
     * does not resolve.
     */
    private static async hostScope(hostname: string): Promise<AddressScope | undefined> {
        const scopes = await this.hostScopes(hostname)
        if (scopes === undefined) {
            return undefined
        }
        if (scopes.includes('blocked')) {
            return 'blocked'
        }
        return (scopes as Exclude<AddressScope, 'blocked'>[]).reduce<Exclude<AddressScope, 'blocked'> | undefined>(
            (closest, s) => (closest === undefined || SCOPE_RANK[s] > SCOPE_RANK[closest] ? s : closest),
            undefined
        )
    }

    /**
     * The scope of the host of the MCP server, which decides where it may send the client. The server controls the
     * addresses of its own name, so the address farthest from this computer decides: a name with any public or
     * blocked address counts as public, and so does a name that does not resolve.
     */
    private static async serverScope(hostname: string): Promise<Exclude<AddressScope, 'blocked'>> {
        const scopes = (await this.hostScopes(hostname)) ?? []
        if (scopes.length === 0 || scopes.some(s => s === 'public' || s === 'blocked')) {
            return 'public'
        }
        return scopes.includes('private') ? 'private' : 'loopback'
    }

    /**
     * The scopes of a URL host: one for an IP address or a localhost name, or one for each address that the name
     * resolves to. Undefined when the name does not resolve.
     */
    private static async hostScopes(hostname: string): Promise<AddressScope[] | undefined> {
        const host = hostname
            .replace(/^\[(.*)\]$/, '$1')
            .replace(/\.$/, '')
            .toLowerCase()
        const literal = addressScope(host)
        if (literal) {
            return [literal]
        }
        if (host === 'localhost' || host.endsWith('.localhost')) {
            return ['loopback']
        }
        let addresses: { address: string }[]
        try {
            addresses = await this.lookupHost(host)
        } catch {
            return undefined
        }
        const scopes = addresses.map(a => addressScope(a.address)).filter((s): s is AddressScope => s !== undefined)
        return scopes.length > 0 ? scopes : undefined
    }

    /** Resolves a host name to all its addresses. A separate method so that tests can replace it. */
    private static lookupHost(host: string): Promise<{ address: string; family: number }[]> {
        return dns.lookup(host, { all: true })
    }

    /**
     * Sends a GET or HEAD discovery request for the MCP server at `rs`. Follows up to MAX_DISCOVERY_REDIRECTS
     * redirects itself, so that every URL passes assertAllowedTarget, a redirect does not switch from https to
     * http, and a redirect to another host over http needs a loopback address, as assertSecureEndpoint requires.
     */
    private static async discoveryFetch(url: string, rs: URL, label: string, init: RequestInit = {}): Promise<any> {
        let current = new URL(url)
        for (let redirects = 0; ; redirects++) {
            await this.assertAllowedTarget(current, rs, label)
            const response = await this.fetchCompat(current.toString(), { ...init, redirect: 'manual' })
            const status = typeof response?.status === 'number' ? response.status : 0
            const location = status >= 300 && status < 400 ? response.headers?.get?.('location') : undefined
            if (!location) {
                return response
            }
            // Release the connection of the redirect response: a web stream with the built-in fetch, a Node stream
            // with the fallback
            try {
                const body = response.body
                await (typeof body?.cancel === 'function' ? body.cancel() : body?.destroy?.())
            } catch {
                // The body is not needed
            }
            if (redirects >= MAX_DISCOVERY_REDIRECTS) {
                throw new Error(`OAuth: too many redirects for the ${label}`)
            }
            const next = new URL(location, current)
            if (
                (next.protocol !== 'https:' && next.protocol !== 'http:') ||
                (current.protocol === 'https:' && next.protocol !== 'https:')
            ) {
                throw new Error(`OAuth: the ${label} redirected to a URL that does not use HTTPS`)
            }
            if (next.protocol === 'http:' && next.host !== current.host) {
                this.assertSecureEndpoint(next.toString(), label)
            }
            current = next
        }
    }

    /** Await server.listen() with error rejection for immediate handling. */
    private static listen(server: http.Server, port: number, host: string = 'localhost'): Promise<void> {
        return new Promise((resolve, reject) => {
            const onListening = () => {
                server.off('error', onError)
                resolve()
            }
            const onError = (err: NodeJS.ErrnoException) => {
                server.off('listening', onListening)
                reject(err)
            }
            server.once('listening', onListening)
            server.once('error', onError)
            server.listen(port, host)
        })
    }

    /** Fetch compatibility: use global fetch on Node >= 18, otherwise dynamically import('node-fetch'). */
    private static async fetchCompat(url: string, init?: RequestInit): Promise<any> {
        const globalObj = globalThis as any
        if (typeof globalObj.fetch === 'function') {
            return globalObj.fetch(url as any, init as any)
        }
        const mod = await (Function('return import("node-fetch")')() as Promise<any>)
        const f = mod.default ?? mod
        return f(url as any, init as any)
    }
}
