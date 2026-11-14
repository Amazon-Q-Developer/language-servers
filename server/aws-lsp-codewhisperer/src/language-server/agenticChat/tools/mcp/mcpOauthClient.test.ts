/*!
 * Copyright Amazon.com, Inc. or its affiliates.
 * All Rights Reserved. SPDX-License-Identifier: Apache-2.0
 */

import { expect } from 'chai'
import * as sinon from 'sinon'
import * as crypto from 'crypto'
import * as http from 'http'
import { EventEmitter } from 'events'
import * as path from 'path'
import { OAuthClient } from './mcpOauthClient'

const fakeLogger = {
    log: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
}

const fakeLsp = {
    window: {
        showDocument: sinon.stub().resolves({ success: true }),
    },
} as any

const fakeWorkspace = {
    fs: {
        exists: async (_path: string) => false,
        readFile: async (_path: string) => Buffer.from('{}'),
        writeFile: async (_path: string, _d: any) => {},
        mkdir: async (_dir: string, _opts: any) => {},
        rm: async (_path: string) => {},
    },
} as any

function stubFileSystem(tokenObj?: any, regObj?: any): void {
    const cacheDir = (OAuthClient as any).cacheDir as string
    const tokPath = path.join(cacheDir, 'testkey.token.json')
    const regPath = path.join(cacheDir, 'testkey.registration.json')

    const existsStub = sinon.stub(fakeWorkspace.fs, 'exists')
    existsStub.callsFake(async (p: any) => {
        if (p === tokPath && tokenObj) return true
        if (p === regPath && regObj) return true
        return false
    })

    const readStub = sinon.stub(fakeWorkspace.fs, 'readFile')
    readStub.callsFake(async (p: any) => {
        if (p === tokPath && tokenObj) return Buffer.from(JSON.stringify(tokenObj))
        if (p === regPath && regObj) return Buffer.from(JSON.stringify(regObj))
        return Buffer.from('{}')
    })

    sinon.stub(fakeWorkspace.fs, 'writeFile').resolves()
    sinon.stub(fakeWorkspace.fs, 'mkdir').resolves()
}

function stubHttpServer(): void {
    sinon.stub(http, 'createServer').callsFake(() => {
        const srv = new EventEmitter() as unknown as http.Server & EventEmitter
        ;(srv as any).address = () => ({ address: '127.0.0.1', port: 12345, family: 'IPv4' })
        ;(srv as any).listen = (_port?: any, _host?: any, _backlog?: any, cb?: any) => {
            if (typeof cb === 'function') cb()
            process.nextTick(() => srv.emit('listening'))
            return srv
        }
        ;(srv as any).close = (cb?: any) => {
            if (typeof cb === 'function') cb()
            srv.removeAllListeners()
            return srv
        }
        return srv
    })
}

/** Resolves every host name to a public address, so that the target check of OAuthClient needs no DNS */
function stubPublicDns(): sinon.SinonStub {
    return sinon.stub(OAuthClient as any, 'lookupHost').resolves([{ address: '93.184.216.34', family: 4 }])
}

describe('OAuthClient helpers', () => {
    it('computeKey() generates deterministic SHA-256 hex', () => {
        const url = new URL('https://example.com/api')
        const expected = crypto
            .createHash('sha256')
            .update(url.origin + url.pathname)
            .digest('hex')
        const actual = (OAuthClient as any).computeKey(url)
        expect(actual).to.equal(expected)
    })

    it('b64url() strips padding and is URL-safe', () => {
        const buf = Buffer.from('hello')
        const actual = (OAuthClient as any).b64url(buf)
        expect(actual).to.equal('aGVsbG8')
    })

    describe('validateTokenEndpoint()', () => {
        const validate = (endpoint: string) => (OAuthClient as any).validateTokenEndpoint(endpoint)

        for (const endpoint of [
            'https://auth.example.com/token',
            'http://localhost:8080/token',
            'http://127.0.0.1/token',
            'http://127.0.0.2/token',
            'http://127.255.255.254/token',
            'http://127.1/token',
            'http://2130706433/token',
            'http://0x7f000001/token',
            'http://[::1]/token',
        ]) {
            it(`allows ${endpoint}`, () => {
                expect(() => validate(endpoint)).not.to.throw()
            })
        }

        for (const endpoint of [
            'http://auth.example.com/token',
            'http://localhost.example.com/token',
            'http://127.example.com/token',
            'http://127.0.0.1.example.com/token',
            'http://128.0.0.1/token',
            'http://0.0.0.0/token',
            'http://[::]/token',
            'http://127.0.0.1@auth.example.com/token',
            'ftp://auth.example.com/token',
            'not a url',
        ]) {
            it(`rejects ${endpoint}`, () => {
                expect(() => validate(endpoint)).to.throw()
            })
        }
    })

    describe('validateAuthorizationEndpoint()', () => {
        const validate = (endpoint: string) => (OAuthClient as any).validateAuthorizationEndpoint(endpoint)

        for (const endpoint of [
            'https://auth.example.com/authorize',
            'http://localhost:8080/authorize',
            'http://127.0.0.1/authorize',
            'http://[::1]/authorize',
        ]) {
            it(`allows ${endpoint}`, () => {
                expect(() => validate(endpoint)).not.to.throw()
            })
        }

        it('returns the parsed URL for a valid endpoint', () => {
            const url = validate('https://auth.example.com/authorize')
            expect(url).to.be.instanceOf(URL)
            expect(url.href).to.equal('https://auth.example.com/authorize')
        })

        // A hostile MCP server must not be able to push a non-web URI into the OS browser.
        for (const endpoint of [
            'javascript:alert(document.domain)',
            'file:///etc/passwd',
            'data:text/html,<script>alert(1)</script>',
            'http://auth.example.com/authorize',
            'ftp://auth.example.com/authorize',
            'vscode://extension/evil',
            'not a url',
        ]) {
            it(`rejects ${endpoint}`, () => {
                expect(() => validate(endpoint)).to.throw()
            })
        }
    })
})

describe('OAuthClient.refreshGrant()', () => {
    let fetchStub: sinon.SinonStub

    beforeEach(() => {
        sinon.restore()
        OAuthClient.initialize(fakeWorkspace, fakeLogger as any, fakeLsp)
        fetchStub = sinon.stub(OAuthClient as any, 'fetchCompat')
        stubPublicDns()
    })

    afterEach(() => sinon.restore())

    it('rejects a non-loopback HTTP endpoint before exchanging credentials', async () => {
        const meta = {
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'http://auth.example.com/token',
        }
        const reg = { client_id: 'client-id', client_secret: 'client-secret' }

        try {
            await (OAuthClient as any).refreshGrant(meta, reg, new URL('https://mcp.example.com/mcp'), 'refresh-token')
            expect.fail('should have thrown')
        } catch (e: any) {
            expect(e.message).to.include('token endpoint must use HTTPS')
        }

        expect(fetchStub.called).to.be.false
    })
})

describe('OAuthClient.pkceGrant() authorization endpoint', () => {
    // showDocument rejects loudly: if validation is ever skipped and the browser
    // is launched, the grant rejects with this marker instead of the validation
    // error, so the test fails fast rather than waiting on the real PKCE timeout.
    let showDocument: sinon.SinonStub

    beforeEach(() => {
        sinon.restore()
        showDocument = sinon.stub().rejects(new Error('BROWSER_LAUNCHED'))
        OAuthClient.initialize(fakeWorkspace, fakeLogger as any, { window: { showDocument } } as any)
        stubPublicDns()
    })

    afterEach(() => sinon.restore())

    // The token endpoint is a valid public https URL so the flow reaches the browser step;
    // only the server-supplied authorization_endpoint is hostile.
    for (const authorization_endpoint of [
        'javascript:alert(document.domain)',
        'file:///etc/passwd',
        'data:text/html,<script>alert(1)</script>',
        'http://evil.example.com/authorize',
        'vscode://extension/evil',
    ]) {
        it(`refuses to open ${authorization_endpoint} and never calls showDocument`, async () => {
            const meta = { authorization_endpoint, token_endpoint: 'https://auth.example.com/token' }
            const reg = { client_id: 'cid', redirect_uri: 'http://localhost:12345/oauth/callback' }
            const fetchStub = sinon.stub(OAuthClient as any, 'fetchCompat')

            try {
                await (OAuthClient as any).pkceGrant(
                    meta,
                    reg,
                    new URL('https://mcp.example.com/mcp'),
                    ['openid'],
                    'http://localhost:12345/oauth/callback',
                    new EventEmitter()
                )
                expect.fail('should have thrown')
            } catch (e: any) {
                expect(e.message).to.include('authorization endpoint')
            }

            expect(showDocument.called).to.be.false
            expect(fetchStub.called).to.be.false
        })
    }
})

describe('OAuthClient.selectAuthMethod()', () => {
    const selectAuthMethod = (reg: any, meta?: any) => (OAuthClient as any).selectAuthMethod(reg, meta)

    it('prefers token_endpoint_auth_method from DCR when no server-supported list', () => {
        const reg = { client_id: 'c', client_secret: 's', token_endpoint_auth_method: 'client_secret_basic' }
        expect(selectAuthMethod(reg)).to.equal('client_secret_basic')
    })

    it('prefers token_endpoint_auth_method from DCR when it is in server-supported list', () => {
        const reg = { client_id: 'c', client_secret: 's', token_endpoint_auth_method: 'client_secret_post' }
        const meta = { token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'] }
        expect(selectAuthMethod(reg, meta)).to.equal('client_secret_post')
    })

    it('ignores DCR method when not in server-supported list, picks best supported', () => {
        const reg = { client_id: 'c', client_secret: 's', token_endpoint_auth_method: 'none' }
        const meta = { token_endpoint_auth_methods_supported: ['client_secret_basic'] }
        expect(selectAuthMethod(reg, meta)).to.equal('client_secret_basic')
    })

    it('picks client_secret_basic over client_secret_post when both supported', () => {
        const reg = { client_id: 'c', client_secret: 's' }
        const meta = { token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'] }
        expect(selectAuthMethod(reg, meta)).to.equal('client_secret_basic')
    })

    it('picks none when no secret and server supports it', () => {
        const reg = { client_id: 'c' }
        const meta = { token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'] }
        expect(selectAuthMethod(reg, meta)).to.equal('none')
    })

    it('defaults to client_secret_post when secret present and no server metadata', () => {
        const reg = { client_id: 'c', client_secret: 's' }
        expect(selectAuthMethod(reg)).to.equal('client_secret_post')
    })

    it('defaults to none when no secret and no server metadata', () => {
        const reg = { client_id: 'c' }
        expect(selectAuthMethod(reg)).to.equal('none')
    })
})

describe('OAuthClient.applyAuth()', () => {
    const applyAuth = (method: string, reg: any, headers: any, params: any) =>
        (OAuthClient as any).applyAuth(method, reg, headers, params)

    it('client_secret_basic sets Authorization header with base64 credentials', () => {
        const headers: Record<string, string> = {}
        const params: Record<string, string> = {}
        const reg = { client_id: 'myid', client_secret: 'mysecret' }
        applyAuth('client_secret_basic', reg, headers, params)

        const expected = `Basic ${Buffer.from('myid:mysecret').toString('base64')}`
        expect(headers['authorization']).to.equal(expected)
        expect(params).to.not.have.property('client_id')
    })

    it('client_secret_basic throws when no client_secret', () => {
        const reg = { client_id: 'myid' }
        expect(() => applyAuth('client_secret_basic', reg, {}, {})).to.throw(
            'client_secret_basic requires a client_secret'
        )
    })

    it('client_secret_post puts client_id and client_secret in params', () => {
        const headers: Record<string, string> = {}
        const params: Record<string, string> = {}
        const reg = { client_id: 'myid', client_secret: 'mysecret' }
        applyAuth('client_secret_post', reg, headers, params)

        expect(params.client_id).to.equal('myid')
        expect(params.client_secret).to.equal('mysecret')
        expect(headers).to.not.have.property('authorization')
    })

    it('none puts only client_id in params', () => {
        const headers: Record<string, string> = {}
        const params: Record<string, string> = {}
        const reg = { client_id: 'myid', client_secret: 'mysecret' }
        applyAuth('none', reg, headers, params)

        expect(params.client_id).to.equal('myid')
        expect(params).to.not.have.property('client_secret')
        expect(headers).to.not.have.property('authorization')
    })
})

describe('OAuthClient.discoverAS()', () => {
    let fetchStub: sinon.SinonStub

    beforeEach(() => {
        sinon.restore()
        OAuthClient.initialize(fakeWorkspace, fakeLogger as any, fakeLsp)
        fetchStub = sinon.stub(OAuthClient as any, 'fetchCompat')
        stubPublicDns()
    })

    afterEach(() => sinon.restore())

    it('discovers via RFC 9728 Protected Resource Metadata', async () => {
        const prmResponse = {
            resource: 'https://mcp.example.com/mcp',
            authorization_servers: ['https://auth.example.com'],
            scopes_supported: ['mcp:connect'],
        }
        const asMeta = {
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            registration_endpoint: 'https://auth.example.com/register',
        }

        fetchStub.callsFake(async (url: string) => {
            if (url.includes('.well-known/oauth-protected-resource')) {
                return { ok: true, json: async () => prmResponse }
            }
            if (url.includes('.well-known/oauth-authorization-server')) {
                return { ok: true, json: async () => asMeta }
            }
            return { ok: false, status: 404, text: async () => 'Not Found' }
        })

        const result = await (OAuthClient as any).discoverAS(new URL('https://mcp.example.com/mcp'))
        expect(result.authorization_endpoint).to.equal('https://auth.example.com/authorize')
        expect(result.token_endpoint).to.equal('https://auth.example.com/token')
        // scopes_supported should be carried from PRM since AS meta doesn't have them
        expect(result.scopes_supported).to.deep.equal(['mcp:connect'])
    })

    it('falls back to well-known endpoints when PRM is not available', async () => {
        const asMeta = {
            authorization_endpoint: 'https://example.com/authorize',
            token_endpoint: 'https://example.com/token',
        }

        fetchStub.callsFake(async (url: string) => {
            if (url.includes('.well-known/oauth-protected-resource')) {
                return { ok: false, status: 404 }
            }
            if (url.includes('.well-known/oauth-authorization-server')) {
                // HEAD returns no www-authenticate
                if (url === 'https://example.com/mcp') {
                    return { ok: true, status: 200, headers: { get: () => '' } }
                }
                return { ok: true, json: async () => asMeta }
            }
            // HEAD request
            if (!url.includes('.well-known')) {
                return { ok: true, status: 200, headers: { get: () => '' } }
            }
            return { ok: false, status: 404, text: async () => '' }
        })

        const result = await (OAuthClient as any).discoverAS(new URL('https://example.com/mcp'))
        expect(result.authorization_endpoint).to.equal('https://example.com/authorize')
    })

    it('falls back to static endpoints when all discovery fails', async () => {
        fetchStub.rejects(new Error('network error'))

        const result = await (OAuthClient as any).discoverAS(new URL('https://example.com/mcp'))
        expect(result.authorization_endpoint).to.equal('https://example.com/mcp/authorize')
        expect(result.token_endpoint).to.equal('https://example.com/mcp/access_token')
    })

    it('carries scopes from PRM when AS metadata lacks them', async () => {
        const prmResponse = {
            resource: 'https://mcp.example.com/mcp',
            authorization_servers: ['https://auth.example.com'],
            scopes_supported: ['custom:scope'],
        }
        const asMeta = {
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            // no scopes_supported
        }

        fetchStub.callsFake(async (url: string) => {
            if (url.includes('.well-known/oauth-protected-resource')) {
                return { ok: true, json: async () => prmResponse }
            }
            if (url.includes('.well-known/oauth-authorization-server')) {
                return { ok: true, json: async () => asMeta }
            }
            return { ok: false, status: 404, text: async () => '' }
        })

        const result = await (OAuthClient as any).discoverAS(new URL('https://mcp.example.com/mcp'))
        expect(result.scopes_supported).to.deep.equal(['custom:scope'])
    })

    it('ignores a plaintext HTTP authorization server from PRM and never fetches it', async () => {
        fetchStub.callsFake(async (url: string) => {
            if (url.includes('.well-known/oauth-protected-resource')) {
                return { ok: true, json: async () => ({ authorization_servers: ['http://evil.example.com'] }) }
            }
            return { ok: false, status: 404, text: async () => '', headers: { get: () => '' } }
        })

        const result = await (OAuthClient as any).discoverAS(new URL('https://mcp.example.com/mcp'))

        // Falls through to synthesized endpoints on the original https server, never the http AS.
        expect(result.authorization_endpoint).to.equal('https://mcp.example.com/mcp/authorize')
        const fetchedEvil = fetchStub
            .getCalls()
            .some((c: sinon.SinonSpyCall) => String(c.args[0]).includes('evil.example.com'))
        expect(fetchedEvil).to.be.false
    })

    it('ignores a plaintext resource_metadata URL from the WWW-Authenticate header', async () => {
        fetchStub.callsFake(async (url: string, init?: any) => {
            if (url.includes('.well-known/oauth-protected-resource')) {
                return { ok: false, status: 404 } // step 1 (PRM) fails
            }
            if (init?.method === 'HEAD') {
                return {
                    ok: true,
                    status: 401,
                    headers: {
                        get: (h: string) =>
                            h.toLowerCase() === 'www-authenticate'
                                ? 'Bearer resource_metadata="http://169.254.169.254/meta"'
                                : '',
                    },
                }
            }
            return { ok: false, status: 404, text: async () => '' } // step 3 well-known fails
        })

        const result = await (OAuthClient as any).discoverAS(new URL('https://mcp.example.com/mcp'))

        // The insecure resource_metadata link is rejected; discovery falls through to synthesized endpoints,
        // and the internal address is never fetched.
        expect(result.authorization_endpoint).to.equal('https://mcp.example.com/mcp/authorize')
        const fetchedMeta = fetchStub
            .getCalls()
            .some((c: sinon.SinonSpyCall) => String(c.args[0]).includes('169.254.169.254'))
        expect(fetchedMeta).to.be.false
    })
})

describe('OAuthClient.fetchASFromResourceMeta()', () => {
    beforeEach(() => {
        sinon.restore()
        OAuthClient.initialize(fakeWorkspace, fakeLogger as any, fakeLsp)
        stubPublicDns()
    })

    afterEach(() => sinon.restore())

    for (const authServer of ['http://auth.example.com', 'ftp://auth.example.com', 'http://169.254.169.254']) {
        it(`rejects a non-secure authorization server URL (${authServer}) before fetching`, async () => {
            const fetchStub = sinon.stub(OAuthClient as any, 'fetchCompat')
            try {
                await (OAuthClient as any).fetchASFromResourceMeta(
                    { authorization_server: authServer },
                    'https://mcp.example.com/.well-known/oauth-protected-resource',
                    new URL('https://mcp.example.com/mcp')
                )
                expect.fail('should have thrown')
            } catch (e: any) {
                expect(e.message).to.include('authorization server')
            }
            expect(fetchStub.called).to.be.false
        })
    }

    it('allows an https authorization server URL', async () => {
        const asMeta = {
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
        }
        sinon.stub(OAuthClient as any, 'fetchCompat').callsFake(async (url: unknown) => {
            if (String(url).includes('.well-known/oauth-authorization-server')) {
                return { ok: true, json: async () => asMeta }
            }
            return { ok: false, status: 404, text: async () => '' }
        })

        const result = await (OAuthClient as any).fetchASFromResourceMeta(
            { authorization_server: 'https://auth.example.com' },
            'https://mcp.example.com/.well-known/oauth-protected-resource',
            new URL('https://mcp.example.com/mcp')
        )
        expect(result.token_endpoint).to.equal('https://auth.example.com/token')
    })
})

describe('OAuthClient.obtainClient()', () => {
    let fetchStub: sinon.SinonStub

    beforeEach(() => {
        sinon.restore()
        OAuthClient.initialize(fakeWorkspace, fakeLogger as any, fakeLsp)
        fetchStub = sinon.stub(OAuthClient as any, 'fetchCompat')
        stubPublicDns()
        sinon.stub(fakeWorkspace.fs, 'exists').resolves(false)
        sinon.stub(fakeWorkspace.fs, 'readFile').resolves(Buffer.from('{}'))
        sinon.stub(fakeWorkspace.fs, 'writeFile').resolves()
        sinon.stub(fakeWorkspace.fs, 'mkdir').resolves()
    })

    afterEach(() => sinon.restore())

    it('sends DCR without token_endpoint_auth_method or scope in body', async () => {
        const dcrResponse = {
            client_id: 'new_id',
            client_secret: 'new_secret',
            client_secret_expires_at: 0,
            token_endpoint_auth_method: 'client_secret_basic',
            scope: 'mcp:connect',
        }

        let capturedBody: any
        fetchStub.callsFake(async (_url: string, init: any) => {
            capturedBody = JSON.parse(init.body)
            return { ok: true, json: async () => dcrResponse }
        })

        const meta = {
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            registration_endpoint: 'https://auth.example.com/register',
        }

        const reg = await (OAuthClient as any).obtainClient(
            meta,
            '/tmp/test.registration.json',
            ['mcp:connect'],
            'http://localhost:12345/oauth/callback',
            new URL('https://mcp.example.com/mcp')
        )

        // DCR body should NOT contain token_endpoint_auth_method or scope
        expect(capturedBody).to.not.have.property('token_endpoint_auth_method')
        expect(capturedBody).to.not.have.property('scope')
        expect(capturedBody.client_name).to.equal('kiro')
        expect(capturedBody.redirect_uris).to.deep.equal(['http://localhost:12345/oauth/callback'])

        // Registration should capture token_endpoint_auth_method from response
        expect(reg.client_id).to.equal('new_id')
        expect(reg.client_secret).to.equal('new_secret')
        expect(reg.token_endpoint_auth_method).to.equal('client_secret_basic')
    })

    it('throws when AS does not support dynamic registration', async () => {
        const meta = {
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            // no registration_endpoint
        }

        try {
            await (OAuthClient as any).obtainClient(
                meta,
                '/tmp/test.json',
                [],
                'http://localhost:12345/oauth/callback',
                new URL('https://mcp.example.com/mcp')
            )
            expect.fail('should have thrown')
        } catch (e: any) {
            expect(e.message).to.include('does not support dynamic registration')
        }
    })

    for (const registration_endpoint of ['http://evil.example.com/register', 'http://169.254.169.254/register']) {
        it(`rejects a non-secure registration endpoint (${registration_endpoint}) before sending DCR`, async () => {
            const meta = {
                authorization_endpoint: 'https://auth.example.com/authorize',
                token_endpoint: 'https://auth.example.com/token',
                registration_endpoint,
            }

            try {
                await (OAuthClient as any).obtainClient(
                    meta,
                    '/tmp/test.json',
                    [],
                    'http://localhost:12345/oauth/callback',
                    new URL('https://mcp.example.com/mcp')
                )
                expect.fail('should have thrown')
            } catch (e: any) {
                expect(e.message).to.include('registration endpoint')
            }

            expect(fetchStub.called).to.be.false
        })
    }
})

describe('OAuthClient.discoverProtectedResourceMetadata()', () => {
    let fetchStub: sinon.SinonStub

    beforeEach(() => {
        sinon.restore()
        OAuthClient.initialize(fakeWorkspace, fakeLogger as any, fakeLsp)
        fetchStub = sinon.stub(OAuthClient as any, 'fetchCompat')
        stubPublicDns()
    })

    afterEach(() => sinon.restore())

    it('tries path-aware URL first for servers with a path', async () => {
        const prmData = { resource: 'https://mcp.example.com/mcp', authorization_servers: ['https://auth.example.com'] }
        const urlsCalled: string[] = []

        fetchStub.callsFake(async (url: string) => {
            urlsCalled.push(url)
            if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') {
                return { ok: true, json: async () => prmData }
            }
            return { ok: false, status: 404 }
        })

        const result = await (OAuthClient as any).discoverProtectedResourceMetadata(
            new URL('https://mcp.example.com/mcp')
        )
        expect(result).to.deep.equal(prmData)
        expect(urlsCalled[0]).to.equal('https://mcp.example.com/.well-known/oauth-protected-resource/mcp')
    })

    it('falls back to root URL when path-aware fails', async () => {
        const prmData = { resource: 'https://mcp.example.com/mcp', authorization_servers: ['https://auth.example.com'] }
        const urlsCalled: string[] = []

        fetchStub.callsFake(async (url: string) => {
            urlsCalled.push(url)
            if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource') {
                return { ok: true, json: async () => prmData }
            }
            return { ok: false, status: 404 }
        })

        const result = await (OAuthClient as any).discoverProtectedResourceMetadata(
            new URL('https://mcp.example.com/mcp')
        )
        expect(result).to.deep.equal(prmData)
        expect(urlsCalled).to.include('https://mcp.example.com/.well-known/oauth-protected-resource/mcp')
        expect(urlsCalled).to.include('https://mcp.example.com/.well-known/oauth-protected-resource')
    })

    it('sends MCP-Protocol-Version header', async () => {
        let capturedHeaders: any
        fetchStub.callsFake(async (_url: string, init: any) => {
            capturedHeaders = init?.headers
            return { ok: false, status: 404 }
        })

        await (OAuthClient as any).discoverProtectedResourceMetadata(new URL('https://example.com/'))
        expect(capturedHeaders?.['MCP-Protocol-Version']).to.equal('2025-03-26')
    })
})

describe('OAuthClient getValidAccessToken()', () => {
    const now = Date.now()

    beforeEach(() => {
        sinon.restore()
        OAuthClient.initialize(fakeWorkspace, fakeLogger as any, fakeLsp)
        sinon.stub(OAuthClient as any, 'computeKey').returns('testkey')
        stubHttpServer()
        stubPublicDns()
        ;(fakeLsp.window.showDocument as sinon.SinonStub).resetHistory()
    })

    afterEach(() => sinon.restore())

    it('returns cached token when still valid', async () => {
        const cachedToken = {
            access_token: 'cached_access',
            expires_in: 3600,
            obtained_at: now - 1_000,
        }
        const cachedReg = {
            client_id: 'cid',
            redirect_uri: 'http://localhost:12345/oauth/callback',
        }

        stubFileSystem(cachedToken, cachedReg)

        const token = await OAuthClient.getValidAccessToken(new URL('https://api.example.com/mcp'), {
            interactive: true,
        })
        expect(token).to.equal('cached_access')
        expect((fakeLsp.window.showDocument as sinon.SinonStub).called).to.be.false
    })

    it('returns undefined in silent mode when no cached token', async () => {
        stubFileSystem()

        const token = await OAuthClient.getValidAccessToken(new URL('https://api.example.com/mcp'), {
            interactive: false,
        })
        expect(token).to.be.undefined
    })

    it('does not send an expired refresh token to a non-loopback HTTP endpoint', async () => {
        const expiredToken = {
            access_token: 'expired',
            expires_in: 1,
            refresh_token: 'refresh-token',
            obtained_at: now - 10_000,
        }
        const cachedReg = {
            client_id: 'cid',
            client_secret: 'csecret',
            redirect_uri: 'http://localhost:12345/oauth/callback',
        }
        stubFileSystem(expiredToken, cachedReg)
        sinon.stub(OAuthClient as any, 'discoverAS').resolves({
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'http://auth.example.com/token',
        })
        const fetchStub = sinon.stub(OAuthClient as any, 'fetchCompat')

        const token = await OAuthClient.getValidAccessToken(new URL('https://api.example.com/mcp'), {
            interactive: false,
        })

        expect(token).to.be.undefined
        expect(fetchStub.called).to.be.false
    })

    it('uses scopes from discovery metadata when available', async () => {
        const expiredToken = {
            access_token: 'expired',
            expires_in: 1,
            obtained_at: now - 10_000,
        }
        stubFileSystem(expiredToken)

        const meta = {
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            registration_endpoint: 'https://auth.example.com/register',
            scopes_supported: ['mcp:connect'],
        }

        sinon.stub(OAuthClient as any, 'discoverAS').resolves(meta)

        const dcrResponse = {
            client_id: 'cid',
            client_secret: 'csecret',
            client_secret_expires_at: 0,
            token_endpoint_auth_method: 'client_secret_basic',
        }
        sinon.stub(OAuthClient as any, 'obtainClient').resolves({
            client_id: 'cid',
            client_secret: 'csecret',
            redirect_uri: 'http://localhost:12345/oauth/callback',
            token_endpoint_auth_method: 'client_secret_basic',
        })

        const tokenResponse = {
            access_token: 'new_token',
            expires_in: 3600,
            token_type: 'bearer',
        }
        const pkceStub = sinon.stub(OAuthClient as any, 'pkceGrant').resolves({
            ...tokenResponse,
            obtained_at: Date.now(),
        })

        const token = await OAuthClient.getValidAccessToken(new URL('https://api.example.com/mcp'), {
            interactive: true,
        })

        expect(token).to.equal('new_token')
        // Verify scopes passed to pkceGrant are from discovery metadata
        const scopesArg = pkceStub.firstCall.args[3]
        expect(scopesArg).to.deep.equal(['mcp:connect'])
    })

    it('falls back to OIDC scopes when discovery has no scopes_supported', async () => {
        const expiredToken = {
            access_token: 'expired',
            expires_in: 1,
            obtained_at: now - 10_000,
        }
        stubFileSystem(expiredToken)

        const meta = {
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            registration_endpoint: 'https://auth.example.com/register',
            // no scopes_supported
        }

        sinon.stub(OAuthClient as any, 'discoverAS').resolves(meta)
        sinon.stub(OAuthClient as any, 'obtainClient').resolves({
            client_id: 'cid',
            redirect_uri: 'http://localhost:12345/oauth/callback',
        })

        const pkceStub = sinon.stub(OAuthClient as any, 'pkceGrant').resolves({
            access_token: 'new_token',
            expires_in: 3600,
            obtained_at: Date.now(),
        })

        await OAuthClient.getValidAccessToken(new URL('https://api.example.com/mcp'), {
            interactive: true,
        })

        const scopesArg = pkceStub.firstCall.args[3]
        expect(scopesArg).to.deep.equal(['openid', 'offline_access'])
    })

    it('pins the discovered endpoints to disk after an interactive sign-in', async () => {
        stubFileSystem()
        const meta = {
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            registration_endpoint: 'https://auth.example.com/register',
        }
        sinon.stub(OAuthClient as any, 'discoverAS').resolves(meta)
        sinon.stub(OAuthClient as any, 'obtainClient').resolves({
            client_id: 'cid',
            redirect_uri: 'http://localhost:12345/oauth/callback',
        })
        sinon.stub(OAuthClient as any, 'pkceGrant').resolves({
            access_token: 'new_token',
            expires_in: 3600,
            obtained_at: Date.now(),
        })
        const write = sinon.stub(OAuthClient as any, 'write').resolves()

        const token = await OAuthClient.getValidAccessToken(new URL('https://api.example.com/mcp'), {
            interactive: true,
        })

        expect(token).to.equal('new_token')
        const metaWrite = write.getCalls().find((c: sinon.SinonSpyCall) => String(c.args[0]).endsWith('.meta.json'))
        expect(metaWrite, 'expected a .meta.json write').to.not.be.undefined
        expect(metaWrite!.args[1]).to.deep.equal(meta)
    })

    it('silent refresh reuses the pinned token endpoint and does not re-discover', async () => {
        const expiredToken = {
            access_token: 'expired',
            expires_in: 1,
            refresh_token: 'refresh-token',
            obtained_at: now - 10_000,
        }
        const cachedReg = { client_id: 'cid', client_secret: 'csecret' }
        const pinnedMeta = {
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://pinned.example.com/token',
        }

        sinon.stub(OAuthClient as any, 'read').callsFake(async (file: unknown) => {
            if (String(file).endsWith('.token.json')) return expiredToken
            if (String(file).endsWith('.registration.json')) return cachedReg
            if (String(file).endsWith('.meta.json')) return pinnedMeta
            return undefined
        })
        const discover = sinon.stub(OAuthClient as any, 'discoverAS').resolves({
            authorization_endpoint: 'https://discovered.example.com/authorize',
            token_endpoint: 'https://discovered.example.com/token',
        })
        const refresh = sinon.stub(OAuthClient as any, 'refreshGrant').resolves({
            access_token: 'refreshed_access',
            expires_in: 3600,
            obtained_at: Date.now(),
        })
        const write = sinon.stub(OAuthClient as any, 'write').resolves()

        const token = await OAuthClient.getValidAccessToken(new URL('https://api.example.com/mcp'), {
            interactive: false,
        })

        expect(token).to.equal('refreshed_access')
        expect(discover.called).to.be.false
        expect(refresh.calledOnce).to.be.true
        // refreshGrant must receive the pinned endpoints, not freshly discovered ones.
        expect(refresh.firstCall.args[0]).to.deep.equal(pinnedMeta)
        // A valid pin is reused as-is, not rewritten.
        const metaWrite = write.getCalls().find((c: sinon.SinonSpyCall) => String(c.args[0]).endsWith('.meta.json'))
        expect(metaWrite, 'a valid pin must not be rewritten on silent refresh').to.be.undefined
    })

    it('silent refresh falls back to discovery when no endpoints were pinned', async () => {
        const expiredToken = {
            access_token: 'expired',
            expires_in: 1,
            refresh_token: 'refresh-token',
            obtained_at: now - 10_000,
        }
        const cachedReg = { client_id: 'cid', client_secret: 'csecret' }

        const discovered = {
            authorization_endpoint: 'https://discovered.example.com/authorize',
            token_endpoint: 'https://discovered.example.com/token',
        }
        sinon.stub(OAuthClient as any, 'read').callsFake(async (file: unknown) => {
            if (String(file).endsWith('.token.json')) return expiredToken
            if (String(file).endsWith('.registration.json')) return cachedReg
            return undefined // legacy token: no pinned meta on disk
        })
        const discover = sinon.stub(OAuthClient as any, 'discoverAS').resolves(discovered)
        sinon.stub(OAuthClient as any, 'refreshGrant').resolves({
            access_token: 'refreshed_access',
            expires_in: 3600,
            obtained_at: Date.now(),
        })
        const write = sinon.stub(OAuthClient as any, 'write').resolves()

        const token = await OAuthClient.getValidAccessToken(new URL('https://api.example.com/mcp'), {
            interactive: false,
        })

        expect(token).to.equal('refreshed_access')
        expect(discover.calledOnce).to.be.true
        // A legacy token (no pin) is migrated: the endpoints that just worked get pinned.
        const metaWrite = write.getCalls().find((c: sinon.SinonSpyCall) => String(c.args[0]).endsWith('.meta.json'))
        expect(metaWrite, 'a legacy token should be migrated to a pinned meta').to.not.be.undefined
        expect(metaWrite!.args[1]).to.deep.equal(discovered)
    })

    it('silent refresh falls back to discovery and re-pins when the pinned token endpoint is insecure', async () => {
        const expiredToken = {
            access_token: 'expired',
            expires_in: 1,
            refresh_token: 'refresh-token',
            obtained_at: now - 10_000,
        }
        const cachedReg = { client_id: 'cid', client_secret: 'csecret' }
        const discovered = {
            authorization_endpoint: 'https://discovered.example.com/authorize',
            token_endpoint: 'https://discovered.example.com/token',
        }

        sinon.stub(OAuthClient as any, 'read').callsFake(async (file: unknown) => {
            if (String(file).endsWith('.token.json')) return expiredToken
            if (String(file).endsWith('.registration.json')) return cachedReg
            if (String(file).endsWith('.meta.json')) return { token_endpoint: 'http://evil.example.com/token' }
            return undefined
        })
        const discover = sinon.stub(OAuthClient as any, 'discoverAS').resolves(discovered)
        const refresh = sinon.stub(OAuthClient as any, 'refreshGrant').resolves({
            access_token: 'refreshed_access',
            expires_in: 3600,
            obtained_at: Date.now(),
        })
        const write = sinon.stub(OAuthClient as any, 'write').resolves()

        const token = await OAuthClient.getValidAccessToken(new URL('https://api.example.com/mcp'), {
            interactive: false,
        })

        expect(token).to.equal('refreshed_access')
        expect(discover.calledOnce).to.be.true
        // The insecure pin must not be forwarded to refreshGrant; the discovered secure endpoints are used.
        expect(refresh.firstCall.args[0]).to.deep.equal(discovered)
        // The insecure pin is replaced with the freshly discovered secure endpoints.
        const metaWrite = write.getCalls().find((c: sinon.SinonSpyCall) => String(c.args[0]).endsWith('.meta.json'))
        expect(metaWrite, 'an insecure pin should be replaced').to.not.be.undefined
        expect(metaWrite!.args[1]).to.deep.equal(discovered)
    })

    describe('interactive refresh', () => {
        const expiredToken = {
            access_token: 'expired',
            expires_in: 1,
            refresh_token: 'refresh-token',
            obtained_at: now - 10_000,
        }
        const cachedReg = {
            client_id: 'cid',
            client_secret: 'csecret',
            redirect_uri: 'http://localhost:12345/oauth/callback',
        }
        const pinnedMeta = {
            authorization_endpoint: 'https://pinned.example.com/authorize',
            token_endpoint: 'https://pinned.example.com/token',
        }
        const discovered = {
            authorization_endpoint: 'https://discovered.example.com/authorize',
            token_endpoint: 'https://discovered.example.com/token',
            registration_endpoint: 'https://discovered.example.com/register',
        }
        const browserToken = { access_token: 'browser_access', expires_in: 3600, obtained_at: now }

        function stubDisk(meta: unknown, reg: unknown = cachedReg): void {
            sinon.stub(OAuthClient as any, 'read').callsFake(async (file: unknown) => {
                if (String(file).endsWith('.token.json')) return expiredToken
                if (String(file).endsWith('.registration.json')) return reg
                if (String(file).endsWith('.meta.json')) return meta
                return undefined
            })
        }

        function pinsWritten(write: sinon.SinonStub): unknown[] {
            return write
                .getCalls()
                .filter((c: sinon.SinonSpyCall) => String(c.args[0]).endsWith('.meta.json'))
                .map((c: sinon.SinonSpyCall) => c.args[1])
        }

        function signIn(): Promise<string | undefined> {
            return OAuthClient.getValidAccessToken(new URL('https://api.example.com/mcp'), { interactive: true })
        }

        it('refreshes with the pinned endpoints, does not run discovery, and keeps the pin', async () => {
            stubDisk(pinnedMeta)
            const discover = sinon.stub(OAuthClient as any, 'discoverAS').resolves(discovered)
            const refresh = sinon.stub(OAuthClient as any, 'refreshGrant').resolves({
                access_token: 'refreshed_access',
                expires_in: 3600,
                obtained_at: now,
            })
            const pkce = sinon.stub(OAuthClient as any, 'pkceGrant')
            const write = sinon.stub(OAuthClient as any, 'write').resolves()

            expect(await signIn()).to.equal('refreshed_access')
            expect(discover.called).to.be.false
            expect(pkce.called).to.be.false
            expect(refresh.calledOnce).to.be.true
            expect(refresh.firstCall.args[0]).to.deep.equal(pinnedMeta)
            expect(refresh.firstCall.args[1]).to.deep.equal(cachedReg)
            expect(pinsWritten(write)).to.deep.equal([])
        })

        it('does not send the refresh token when no endpoints were pinned, and pins after the browser sign-in', async () => {
            stubDisk(undefined)
            sinon.stub(OAuthClient as any, 'discoverAS').resolves(discovered)
            sinon.stub(OAuthClient as any, 'obtainClient').resolves(cachedReg)
            const refresh = sinon.stub(OAuthClient as any, 'refreshGrant')
            const pkce = sinon.stub(OAuthClient as any, 'pkceGrant').resolves(browserToken)
            const write = sinon.stub(OAuthClient as any, 'write').resolves()

            expect(await signIn()).to.equal('browser_access')
            expect(refresh.called).to.be.false
            expect(pkce.firstCall.args[0]).to.deep.equal(discovered)
            expect(pinsWritten(write)).to.deep.equal([discovered])
        })

        it('does not send the refresh token to a pinned token endpoint that is not secure', async () => {
            stubDisk({ token_endpoint: 'http://evil.example.com/token' })
            sinon.stub(OAuthClient as any, 'discoverAS').resolves(discovered)
            sinon.stub(OAuthClient as any, 'obtainClient').resolves(cachedReg)
            const fetchStub = sinon.stub(OAuthClient as any, 'fetchCompat')
            sinon.stub(OAuthClient as any, 'pkceGrant').resolves(browserToken)
            const write = sinon.stub(OAuthClient as any, 'write').resolves()

            expect(await signIn()).to.equal('browser_access')
            expect(fetchStub.called).to.be.false
            expect(pinsWritten(write)).to.deep.equal([discovered])
        })

        it('does not send the refresh token when no client registration is saved', async () => {
            stubDisk(pinnedMeta, null)
            sinon.stub(OAuthClient as any, 'discoverAS').resolves(discovered)
            sinon.stub(OAuthClient as any, 'obtainClient').resolves(cachedReg)
            const refresh = sinon.stub(OAuthClient as any, 'refreshGrant')
            sinon.stub(OAuthClient as any, 'pkceGrant').resolves(browserToken)
            sinon.stub(OAuthClient as any, 'write').resolves()

            expect(await signIn()).to.equal('browser_access')
            expect(refresh.called).to.be.false
        })

        for (const [failure, outcome] of [
            ['is rejected', () => Promise.resolve(undefined)],
            ['throws', () => Promise.reject(new Error('connection reset'))],
        ] as const) {
            it(`signs in in the browser and re-pins when the refresh with the pinned endpoints ${failure}`, async () => {
                stubDisk(pinnedMeta)
                sinon.stub(OAuthClient as any, 'discoverAS').resolves(discovered)
                sinon.stub(OAuthClient as any, 'obtainClient').resolves(cachedReg)
                const refresh = sinon.stub(OAuthClient as any, 'refreshGrant').callsFake(outcome)
                const pkce = sinon.stub(OAuthClient as any, 'pkceGrant').resolves(browserToken)
                const write = sinon.stub(OAuthClient as any, 'write').resolves()

                expect(await signIn()).to.equal('browser_access')
                // The refresh token went to the pinned token endpoint only, never to a discovered one
                expect(refresh.callCount).to.equal(1)
                expect(refresh.firstCall.args[0]).to.deep.equal(pinnedMeta)
                expect(pkce.firstCall.args[0]).to.deep.equal(discovered)
                expect(pinsWritten(write)).to.deep.equal([discovered])
            })
        }
    })
})

describe('OAuthClient check of the addresses that an MCP server sends the client to', () => {
    const publicServer = new URL('https://mcp.example.com/mcp')
    let lookup: sinon.SinonStub

    beforeEach(() => {
        sinon.restore()
        OAuthClient.initialize(fakeWorkspace, fakeLogger as any, fakeLsp)
        lookup = sinon.stub(OAuthClient as any, 'lookupHost').callsFake(async (host: unknown) => {
            const addresses: Record<string, string[]> = {
                'mcp.example.com': ['93.184.216.34'],
                'auth.example.com': ['93.184.216.35'],
                'metadata.example.com': ['169.254.169.254'],
                'intranet.example.com': ['10.1.2.3'],
                'mixed.example.com': ['93.184.216.36', '192.168.0.10'],
                'mcp.corp.example.com': ['10.0.0.2'],
                'sso.corp.example.com': ['10.0.0.3'],
                // MCP server names that add addresses close to this computer to a public one
                'mcp.mixed.example.com': ['93.184.216.34', '127.0.0.1'],
                'mcp.metadata.example.com': ['93.184.216.34', '169.254.169.254'],
                'mcp.split.example.com': ['10.0.0.4', '127.0.0.1'],
            }
            const found = addresses[String(host)]
            if (!found) {
                throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' })
            }
            return found.map(address => ({ address, family: 4 }))
        })
    })

    afterEach(() => sinon.restore())

    describe('hostScope()', () => {
        const cases: [string, string | undefined][] = [
            ['https://93.184.216.34/', 'public'],
            ['https://[2606:4700::1111]/', 'public'],
            ['https://172.32.0.1/', 'public'],
            ['https://100.128.0.1/', 'public'],
            ['https://10.0.0.5/', 'private'],
            ['https://172.16.0.1/', 'private'],
            ['https://172.31.255.255/', 'private'],
            ['https://192.168.1.1/', 'private'],
            ['https://100.64.0.1/', 'private'],
            ['https://[fd12:3456::1]/', 'private'],
            ['https://127.0.0.1/', 'loopback'],
            ['https://127.1.2.3/', 'loopback'],
            ['https://0x7f.1/', 'loopback'],
            ['https://2130706433/', 'loopback'],
            ['https://[::1]/', 'loopback'],
            ['https://[::ffff:127.0.0.1]/', 'loopback'],
            ['https://localhost/', 'loopback'],
            ['https://app.localhost./', 'loopback'],
            ['https://169.254.169.254/', 'blocked'],
            ['https://0.0.0.0/', 'blocked'],
            ['https://224.0.0.1/', 'blocked'],
            ['https://255.255.255.255/', 'blocked'],
            ['https://[::]/', 'blocked'],
            ['https://[fe80::1]/', 'blocked'],
            ['https://[ff02::1]/', 'blocked'],
            ['https://[::ffff:169.254.169.254]/', 'blocked'],
            ['https://[64:ff9b::a9fe:a9fe]/', 'blocked'],
            ['https://auth.example.com/', 'public'],
            ['https://intranet.example.com/', 'private'],
            ['https://metadata.example.com/', 'blocked'],
            ['https://mixed.example.com/', 'private'],
            ['https://unknown.example.com/', undefined],
        ]
        for (const [url, scope] of cases) {
            it(`classifies ${url} as ${scope ?? 'unknown'}`, async () => {
                expect(await (OAuthClient as any).hostScope(new URL(url).hostname)).to.equal(scope)
            })
        }

        it('does not resolve an IP address or a localhost name', async () => {
            await (OAuthClient as any).hostScope('10.0.0.5')
            await (OAuthClient as any).hostScope('[::1]')
            await (OAuthClient as any).hostScope('localhost')
            expect(lookup.called).to.be.false
        })
    })

    describe('assertAllowedTarget()', () => {
        const cases: [string, string, boolean][] = [
            // A public MCP server may send the client to public addresses only
            ['https://mcp.example.com/mcp', 'https://auth.example.com/token', true],
            ['https://mcp.example.com/mcp', 'https://10.0.0.5/token', false],
            ['https://mcp.example.com/mcp', 'https://intranet.example.com/token', false],
            ['https://mcp.example.com/mcp', 'https://mixed.example.com/token', false],
            ['https://mcp.example.com/mcp', 'http://127.0.0.1:8080/token', false],
            ['https://mcp.example.com/mcp', 'http://localhost:8080/token', false],
            ['https://mcp.example.com/mcp', 'https://169.254.169.254/latest/meta-data/', false],
            ['https://mcp.example.com/mcp', 'https://metadata.example.com/', false],
            // An MCP server on a private network may also use private addresses
            ['https://mcp.corp.example.com/mcp', 'https://sso.corp.example.com/token', true],
            ['https://mcp.corp.example.com/mcp', 'https://auth.example.com/token', true],
            ['https://mcp.corp.example.com/mcp', 'http://127.0.0.1:8080/token', false],
            ['https://mcp.corp.example.com/mcp', 'https://169.254.169.254/', false],
            // An MCP server on this computer may also use loopback addresses
            ['http://localhost:3000/mcp', 'http://127.0.0.1:8080/token', true],
            ['http://localhost:3000/mcp', 'https://10.0.0.5/token', true],
            ['http://localhost:3000/mcp', 'https://[fe80::1]/token', false],
            // The host that the user chose is allowed
            ['https://10.9.9.9/mcp', 'https://10.9.9.9:8443/token', true],
            // The address of the MCP server farthest from this computer decides where it may send the client
            ['https://mcp.mixed.example.com/mcp', 'http://127.0.0.1:8080/token', false],
            ['https://mcp.mixed.example.com/mcp', 'https://10.0.0.5/token', false],
            ['https://mcp.metadata.example.com/mcp', 'https://10.0.0.5/token', false],
            ['https://mcp.split.example.com/mcp', 'https://10.0.0.5/token', true],
            ['https://mcp.split.example.com/mcp', 'http://127.0.0.1:8080/token', false],
            ['https://169.254.1.1/mcp', 'https://10.0.0.5/token', false],
        ]
        for (const [server, target, allowed] of cases) {
            it(`${allowed ? 'allows' : 'rejects'} ${target} for the MCP server ${server}`, async () => {
                const check = (OAuthClient as any).assertAllowedTarget(new URL(target), new URL(server), 'endpoint')
                if (allowed) {
                    await check
                } else {
                    try {
                        await check
                        expect.fail('should have thrown')
                    } catch (e: any) {
                        expect(e.message).to.match(/^OAuth: endpoint is on a .* address/)
                    }
                }
            })
        }

        it('rejects a host name that does not resolve, unless it is the host of the MCP server', async () => {
            try {
                await (OAuthClient as any).assertAllowedTarget(
                    new URL('https://unknown.example.com/token'),
                    publicServer,
                    'token endpoint'
                )
                expect.fail('should have thrown')
            } catch (e: any) {
                expect(e.message).to.equal('OAuth: token endpoint has a host name that could not be resolved')
            }
            await (OAuthClient as any).assertAllowedTarget(
                new URL('https://unknown.example.com/token'),
                new URL('https://unknown.example.com/mcp'),
                'token endpoint'
            )
        })
    })

    describe('discoveryFetch()', () => {
        function redirectTo(location: string) {
            return {
                ok: false,
                status: 302,
                headers: { get: (name: string) => (name === 'location' ? location : null) },
            }
        }
        const done = { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }

        it('follows a redirect itself and checks its target', async () => {
            const fetchStub = sinon.stub(OAuthClient as any, 'fetchCompat')
            fetchStub.onFirstCall().resolves(redirectTo('/.well-known/oauth-authorization-server/next'))
            fetchStub.onSecondCall().resolves(done)

            const response = await (OAuthClient as any).discoveryFetch(
                'https://auth.example.com/.well-known/oauth-authorization-server',
                publicServer,
                'authorization server'
            )

            expect(response).to.equal(done)
            expect(fetchStub.secondCall.args[0]).to.equal(
                'https://auth.example.com/.well-known/oauth-authorization-server/next'
            )
            for (const call of fetchStub.getCalls()) {
                expect(call.args[1].redirect).to.equal('manual')
            }
        })

        for (const location of [
            'http://169.254.169.254/latest/meta-data/',
            'https://10.0.0.5/internal',
            'https://metadata.example.com/',
            'http://auth.example.com/plaintext',
            'file:///etc/passwd',
        ]) {
            it(`does not follow a redirect to ${location}`, async () => {
                const fetchStub = sinon.stub(OAuthClient as any, 'fetchCompat').resolves(redirectTo(location))
                try {
                    await (OAuthClient as any).discoveryFetch(
                        'https://auth.example.com/.well-known/openid-configuration',
                        publicServer,
                        'authorization server'
                    )
                    expect.fail('should have thrown')
                } catch (e: any) {
                    expect(e.message).to.include('authorization server')
                }
                expect(fetchStub.calledOnce).to.be.true
            })
        }

        it('stops after five redirects', async () => {
            const cancel = sinon.stub().resolves()
            const fetchStub = sinon
                .stub(OAuthClient as any, 'fetchCompat')
                .resolves({ ...redirectTo('https://auth.example.com/again'), body: { cancel } })
            try {
                await (OAuthClient as any).discoveryFetch(
                    'https://auth.example.com/',
                    publicServer,
                    'resource metadata'
                )
                expect.fail('should have thrown')
            } catch (e: any) {
                expect(e.message).to.include('too many redirects')
            }
            expect(fetchStub.callCount).to.equal(6)
            // The body of the last redirect response is released too
            expect(cancel.callCount).to.equal(6)
        })

        it('releases a Node stream body, as the fallback fetch returns', async () => {
            const destroy = sinon.stub()
            const fetchStub = sinon.stub(OAuthClient as any, 'fetchCompat')
            fetchStub.onFirstCall().resolves({ ...redirectTo('/next'), body: { destroy } })
            fetchStub.onSecondCall().resolves(done)

            await (OAuthClient as any).discoveryFetch('https://auth.example.com/', publicServer, 'authorization server')

            sinon.assert.calledOnce(destroy)
        })

        it('releases the body of a redirect response before it follows the redirect', async () => {
            const cancel = sinon.stub().resolves()
            const fetchStub = sinon.stub(OAuthClient as any, 'fetchCompat')
            fetchStub.onFirstCall().resolves({ ...redirectTo('/next'), body: { cancel } })
            fetchStub.onSecondCall().resolves(done)

            await (OAuthClient as any).discoveryFetch('https://auth.example.com/', publicServer, 'authorization server')

            sinon.assert.calledOnce(cancel)
            sinon.assert.callOrder(cancel, fetchStub.withArgs('https://auth.example.com/next'))
        })

        describe('over http, for an MCP server on this computer', () => {
            const loopbackServer = new URL('http://localhost:3000/mcp')

            it('follows a redirect to a loopback address', async () => {
                const fetchStub = sinon.stub(OAuthClient as any, 'fetchCompat')
                fetchStub.onFirstCall().resolves(redirectTo('http://127.0.0.1:9/metadata'))
                fetchStub.onSecondCall().resolves(done)

                const response = await (OAuthClient as any).discoveryFetch(
                    'http://localhost:3000/.well-known/oauth-protected-resource',
                    loopbackServer,
                    'resource metadata'
                )

                expect(response).to.equal(done)
                expect(fetchStub.secondCall.args[0]).to.equal('http://127.0.0.1:9/metadata')
            })

            it('does not follow a redirect over http to another host', async () => {
                const fetchStub = sinon
                    .stub(OAuthClient as any, 'fetchCompat')
                    .resolves(redirectTo('http://other.example.com/metadata'))
                try {
                    await (OAuthClient as any).discoveryFetch(
                        'http://localhost:3000/.well-known/oauth-protected-resource',
                        loopbackServer,
                        'resource metadata'
                    )
                    expect.fail('should have thrown')
                } catch (e: any) {
                    expect(e.message).to.equal(
                        'OAuth: resource metadata must use HTTPS unless it is a loopback address'
                    )
                }
                expect(fetchStub.calledOnce).to.be.true
            })
        })
    })

    it('sends the client registration once, and fails on a redirect', async () => {
        const fetchStub = sinon.stub(OAuthClient as any, 'fetchCompat').resolves({
            ok: true,
            status: 201,
            json: async () => ({ client_id: 'new_id' }),
        })
        sinon.stub(fakeWorkspace.fs, 'exists').resolves(false)
        sinon.stub(fakeWorkspace.fs, 'writeFile').resolves()
        sinon.stub(fakeWorkspace.fs, 'mkdir').resolves()

        await (OAuthClient as any).obtainClient(
            {
                authorization_endpoint: 'https://auth.example.com/authorize',
                token_endpoint: 'https://auth.example.com/token',
                registration_endpoint: 'https://auth.example.com/register',
            },
            '/tmp/test.json',
            [],
            'http://localhost:12345/oauth/callback',
            publicServer
        )

        sinon.assert.calledOnce(fetchStub)
        expect(fetchStub.firstCall.args[1]).to.include({ method: 'POST', redirect: 'error' })
    })

    it('discovery skips an authorization server on a private address for a public MCP server', async () => {
        const fetchStub = sinon.stub(OAuthClient as any, 'fetchCompat').callsFake(async (url: unknown) => {
            if (String(url).includes('oauth-protected-resource')) {
                return { ok: true, status: 200, json: async () => ({ authorization_servers: ['https://10.0.0.5'] }) }
            }
            return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' }
        })

        const meta = await (OAuthClient as any).discoverAS(publicServer)

        expect(fetchStub.getCalls().some((c: sinon.SinonSpyCall) => String(c.args[0]).includes('10.0.0.5'))).to.be.false
        // Discovery falls through to the endpoints on the MCP server itself
        expect(meta.token_endpoint).to.equal('https://mcp.example.com/mcp/access_token')
    })

    it('does not send the client registration to a link-local address', async () => {
        const fetchStub = sinon.stub(OAuthClient as any, 'fetchCompat')
        sinon.stub(fakeWorkspace.fs, 'exists').resolves(false)
        try {
            await (OAuthClient as any).obtainClient(
                {
                    authorization_endpoint: 'https://auth.example.com/authorize',
                    token_endpoint: 'https://auth.example.com/token',
                    registration_endpoint: 'https://169.254.169.254/register',
                },
                '/tmp/test.json',
                [],
                'http://localhost:12345/oauth/callback',
                publicServer
            )
            expect.fail('should have thrown')
        } catch (e: any) {
            expect(e.message).to.include('registration endpoint')
        }
        expect(fetchStub.called).to.be.false
    })

    it('does not send the refresh token to a token endpoint on a private address', async () => {
        const fetchStub = sinon.stub(OAuthClient as any, 'fetchCompat')
        try {
            await (OAuthClient as any).refreshGrant(
                {
                    authorization_endpoint: 'https://auth.example.com/authorize',
                    token_endpoint: 'https://10.0.0.5/token',
                },
                { client_id: 'cid', redirect_uri: 'http://localhost:12345/oauth/callback' },
                publicServer,
                'refresh-token'
            )
            expect.fail('should have thrown')
        } catch (e: any) {
            expect(e.message).to.include('token endpoint')
        }
        expect(fetchStub.called).to.be.false
    })

    it('does not open the browser when the token endpoint is on a loopback address of a public MCP server', async () => {
        const showDocument = sinon.stub().resolves({ success: true })
        OAuthClient.initialize(fakeWorkspace, fakeLogger as any, { window: { showDocument } } as any)
        const fetchStub = sinon.stub(OAuthClient as any, 'fetchCompat')
        try {
            await (OAuthClient as any).pkceGrant(
                {
                    authorization_endpoint: 'https://auth.example.com/authorize',
                    token_endpoint: 'http://127.0.0.1:9/token',
                },
                { client_id: 'cid', redirect_uri: 'http://localhost:12345/oauth/callback' },
                publicServer,
                ['openid'],
                'http://localhost:12345/oauth/callback',
                new EventEmitter()
            )
            expect.fail('should have thrown')
        } catch (e: any) {
            expect(e.message).to.include('token endpoint')
        }
        expect(showDocument.called).to.be.false
        expect(fetchStub.called).to.be.false
    })
})
