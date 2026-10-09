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
            'http://[::1]/token',
        ]) {
            it(`allows ${endpoint}`, () => {
                expect(() => validate(endpoint)).not.to.throw()
            })
        }

        for (const endpoint of [
            'http://auth.example.com/token',
            'http://localhost.example.com/token',
            'ftp://auth.example.com/token',
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
})

describe('OAuthClient.obtainClient()', () => {
    let fetchStub: sinon.SinonStub

    beforeEach(() => {
        sinon.restore()
        OAuthClient.initialize(fakeWorkspace, fakeLogger as any, fakeLsp)
        fetchStub = sinon.stub(OAuthClient as any, 'fetchCompat')
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
            'http://localhost:12345/oauth/callback'
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
            await (OAuthClient as any).obtainClient(meta, '/tmp/test.json', [], 'http://localhost:12345/oauth/callback')
            expect.fail('should have thrown')
        } catch (e: any) {
            expect(e.message).to.include('does not support dynamic registration')
        }
    })
})

describe('OAuthClient.discoverProtectedResourceMetadata()', () => {
    let fetchStub: sinon.SinonStub

    beforeEach(() => {
        sinon.restore()
        OAuthClient.initialize(fakeWorkspace, fakeLogger as any, fakeLsp)
        fetchStub = sinon.stub(OAuthClient as any, 'fetchCompat')
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
})
