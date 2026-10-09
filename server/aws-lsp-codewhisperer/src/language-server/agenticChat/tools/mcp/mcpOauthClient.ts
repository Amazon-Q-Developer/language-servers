/*!
 * Copyright Amazon.com, Inc. or its affiliates.
 * All Rights Reserved. SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'crypto'
import * as path from 'path'
import { URL, URLSearchParams } from 'url'
import * as http from 'http'
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
                    const meta = await this.discoverAS(mcpBase)
                    const refreshed = await this.refreshGrant(meta, savedReg, mcpBase, cachedTok.refresh_token)
                    if (refreshed) {
                        await this.write(tokPath, refreshed)
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

            const meta = await this.discoverAS(mcpBase)

            // Use scopes from discovery metadata, fall back to OIDC defaults
            const scopes =
                meta.scopes_supported && meta.scopes_supported.length > 0
                    ? meta.scopes_supported
                    : ['openid', 'offline_access']

            const reg = await this.obtainClient(meta, regPath, scopes, redirectUri)

            // Try refresh-token grant first
            if (cached?.refresh_token) {
                const refreshed = await this.refreshGrant(meta, reg, mcpBase, cached.refresh_token)
                if (refreshed) {
                    await this.write(tokPath, refreshed)
                    this.logger.info('OAuth: refresh grant succeeded')
                    return refreshed.access_token
                }
            }

            // PKCE interactive flow
            const fresh = await this.pkceGrant(meta, reg, mcpBase, scopes, redirectUri, server)
            await this.write(tokPath, fresh)
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
                    const asMeta = await this.discoverAuthorizationServerMetadata(new URL(asUrl))
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
            const h = await this.fetchCompat(rs.toString(), { method: 'HEAD' })
            const header = h.headers.get('www-authenticate') || ''
            const m = /resource_metadata=(?:"([^"]+)"|([^,\s]+))/i.exec(header)
            if (m) {
                const metaUrl = new URL(m[1] || m[2], rs).toString()
                const raw = await this.json<any>(metaUrl)
                return await this.fetchASFromResourceMeta(raw, metaUrl)
            }
        } catch (e) {
            this.logger.info(`OAuth: WWW-Authenticate discovery failed — ${e instanceof Error ? e.message : String(e)}`)
        }

        // Step 3: Well-known endpoints on the resource server
        const asMeta = await this.discoverAuthorizationServerMetadata(new URL('/', rs))
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
                const resp = await this.fetchCompat(url, {
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
    private static async discoverAuthorizationServerMetadata(asUrl: URL): Promise<Meta | undefined> {
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
                return await this.json<Meta>(url)
            } catch {
                // Try next URL
            }
        }
        return undefined
    }

    /** Follow authorization_server(s) in resource_metadata JSON */
    private static async fetchASFromResourceMeta(raw: any, metaUrl: string): Promise<Meta> {
        let asBase = raw.authorization_server
        if (!asBase && Array.isArray(raw.authorization_servers)) {
            asBase = raw.authorization_servers[0]
        }
        if (!asBase) {
            throw new Error(`resource_metadata at ${metaUrl} lacked authorization_server(s)`)
        }

        for (const p of ['.well-known/oauth-authorization-server', '.well-known/openid-configuration']) {
            try {
                return await this.json<Meta>(new URL(p, asBase).toString())
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
        redirectUri: string
    ): Promise<Registration> {
        const existing = await this.read<Registration>(file)
        if (existing && (!existing.expires_at || existing.expires_at * 1000 > Date.now())) {
            this.logger.info(`OAuth: reusing cached client_id ${existing.client_id}`)
            return existing
        }

        if (!meta.registration_endpoint) {
            throw new Error('OAuth: AS does not support dynamic registration')
        }

        // Let the server decide token_endpoint_auth_method and scope
        const body = {
            client_name: 'kiro',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            redirect_uris: [redirectUri],
        }
        const resp: any = await this.json(meta.registration_endpoint, {
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
        const DEFAULT_PKCE_TIMEOUT_MS = 90_000

        const verifier = this.b64url(crypto.randomBytes(32))
        const challenge = this.b64url(crypto.createHash('sha256').update(verifier).digest())
        const state = this.b64url(crypto.randomBytes(16))

        const authz = new URL(meta.authorization_endpoint)
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

    /** Fetch + error-check + parse JSON */
    private static async json<T>(url: string, init?: RequestInit): Promise<T> {
        const r = await this.fetchCompat(url, init)
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
        let url: URL
        try {
            url = new URL(endpoint)
        } catch {
            throw new Error('OAuth: token endpoint is not a valid URL')
        }

        if (url.protocol === 'https:') {
            return
        }

        const hostname = url.hostname.toLowerCase()
        const isLoopbackHttp =
            url.protocol === 'http:' &&
            (hostname === 'localhost' || hostname === '[::1]' || hostname.startsWith('127.'))
        if (isLoopbackHttp) {
            return
        }

        throw new Error('OAuth: token endpoint must use HTTPS unless it is a loopback address')
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
