/*!
 * Copyright Amazon.com, Inc. or its affiliates.
 * All Rights Reserved. SPDX-License-Identifier: Apache-2.0
 */

import { strict as assert } from 'assert'
import { EventEmitter } from 'events'
import * as http from 'http'
import { AddressInfo } from 'net'
import * as sinon from 'sinon'
import { OAuthClient } from './mcpOauthClient'

// Exercise fetchCompat itself: both implementations must stop at the original endpoint.
for (const implementation of ['native', 'fallback'] as const) {
    describe(`OAuthClient token requests (${implementation} fetch)`, function () {
        this.timeout(10_000)

        let endpoint: http.Server
        let destination: http.Server
        let endpointUrl: string
        let destinationUrl: string
        let responseStatus: number
        let destinationRequests: number
        let requests: { method: string | undefined; body: URLSearchParams; authorization?: string }[]
        let callback: EventEmitter
        let showDocument: sinon.SinonStub
        let timers: ReturnType<typeof setTimeout>[]

        async function start(server: http.Server): Promise<string> {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject)
                server.listen(0, '127.0.0.1', resolve)
            })
            return `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`
        }

        async function close(server?: http.Server): Promise<void> {
            if (!server?.listening) return
            await new Promise<void>((resolve, reject) => {
                server.close(error => (error ? reject(error) : resolve()))
                server.closeAllConnections()
            })
        }

        beforeEach(async () => {
            requests = []
            timers = []
            destinationRequests = 0
            responseStatus = 200
            callback = new EventEmitter()
            showDocument = sinon.stub().callsFake(async ({ uri }: { uri: string }) => {
                const state = new URL(uri).searchParams.get('state')!
                // Deliver consent after pkceGrant has registered its callback listener.
                setImmediate(() => {
                    const response = { writeHead: () => response, end: () => response }
                    callback.emit('request', { url: `/oauth/callback?code=test-code&state=${state}` }, response)
                })
                return { success: true }
            })
            OAuthClient.initialize(
                {} as any,
                { info: () => {}, warn: () => {} } as any,
                { window: { showDocument } } as any
            )

            // Retain real network timers while cleaning up the existing PKCE timeout after each test.
            const realSetTimeout = globalThis.setTimeout
            sinon.stub(globalThis, 'setTimeout').callsFake(((...args: Parameters<typeof setTimeout>) => {
                const timer = realSetTimeout(...args)
                if (args[1] === 90_000) timers.push(timer)
                return timer
            }) as typeof setTimeout)
            if (implementation === 'fallback') {
                sinon.stub(globalThis, 'fetch').value(undefined)
            } else {
                assert.equal(typeof globalThis.fetch, 'function', 'native fetch requires Node 18 or later')
            }

            destination = http.createServer((req, res) => {
                destinationRequests++
                req.resume()
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ access_token: 'redirected-token', expires_in: 3600 }))
            })
            destinationUrl = await start(destination)
            endpoint = http.createServer((req, res) => {
                const chunks: Buffer[] = []
                req.on('data', chunk => chunks.push(Buffer.from(chunk)))
                req.on('end', () => {
                    requests.push({
                        method: req.method,
                        body: new URLSearchParams(Buffer.concat(chunks).toString()),
                        authorization: req.headers.authorization,
                    })
                    if (responseStatus >= 300 && responseStatus < 400) {
                        res.writeHead(responseStatus, { location: destinationUrl }).end()
                    } else {
                        res.writeHead(responseStatus, { 'content-type': 'application/json' })
                        res.end(JSON.stringify({ access_token: 'test-access-token', expires_in: 3600 }))
                    }
                })
            })
            endpointUrl = await start(endpoint)
        })

        afterEach(async () => {
            for (const timer of timers) clearTimeout(timer)
            callback.removeAllListeners()
            sinon.restore()
            await Promise.all([close(endpoint), close(destination)])
        })

        function exchange(grant: 'refresh' | 'authorization_code', authMethod: string, url = endpointUrl) {
            const meta = {
                authorization_endpoint: 'https://auth.example.com/authorize',
                token_endpoint: url,
            }
            const reg = {
                client_id: 'test-client',
                client_secret: 'test-secret',
                token_endpoint_auth_method: authMethod,
                redirect_uri: 'http://localhost:12345/oauth/callback',
            }
            const resource = new URL('https://mcp.example.com/mcp')
            if (grant === 'refresh') {
                return (OAuthClient as any).refreshGrant(meta, reg, resource, 'test-refresh-token')
            }
            return (OAuthClient as any).pkceGrant(meta, reg, resource, [], reg.redirect_uri, callback)
        }

        for (const grant of ['refresh', 'authorization_code'] as const) {
            for (const authMethod of ['client_secret_post', 'client_secret_basic', 'none']) {
                for (const status of [301, 302, 303, 307, 308]) {
                    it(`rejects HTTP ${status} during ${grant} with ${authMethod}`, async () => {
                        responseStatus = status
                        await assert.rejects(exchange(grant, authMethod))
                        assert.equal(requests.length, 1)
                        assert.equal(requests[0].method, 'POST')
                        assert.equal(destinationRequests, 0)
                    })
                }

                it(`accepts a direct response during ${grant} with ${authMethod}`, async () => {
                    const token = await exchange(grant, authMethod)
                    assert.equal(token.access_token, 'test-access-token')
                    assert.equal(requests.length, 1)
                    const { method, body, authorization } = requests[0]
                    assert.equal(method, 'POST')
                    assert.equal(body.get('grant_type'), grant === 'refresh' ? 'refresh_token' : 'authorization_code')
                    if (grant === 'refresh') {
                        assert.equal(body.get('refresh_token'), 'test-refresh-token')
                    } else {
                        assert.equal(body.get('code'), 'test-code')
                        assert.ok(body.get('code_verifier'))
                    }
                    if (authMethod === 'client_secret_basic') {
                        assert.equal(
                            authorization,
                            `Basic ${Buffer.from('test-client:test-secret').toString('base64')}`
                        )
                        assert.equal(body.has('client_secret'), false)
                    } else {
                        assert.equal(authorization, undefined)
                        assert.equal(body.get('client_id'), 'test-client')
                        assert.equal(
                            body.get('client_secret'),
                            authMethod === 'client_secret_post' ? 'test-secret' : null
                        )
                    }
                    assert.equal(destinationRequests, 0)
                })
            }

            for (const url of ['http://auth.example.com/token', 'http://127.example.com/token']) {
                it(`rejects ${url} before starting ${grant}`, async () => {
                    const fetch = sinon.stub(OAuthClient as any, 'fetchCompat')
                    await assert.rejects(exchange(grant, 'client_secret_post', url), /token endpoint must use HTTPS/)
                    sinon.assert.notCalled(fetch)
                    sinon.assert.notCalled(showDocument)
                })
            }
        }

        it('returns no token or cache update after a redirected silent refresh', async () => {
            responseStatus = 307
            sinon.stub(OAuthClient as any, 'read').callsFake(async (file: unknown) =>
                String(file).endsWith('.token.json')
                    ? {
                          access_token: 'expired',
                          refresh_token: 'test-refresh-token',
                          obtained_at: 0,
                          expires_in: 1,
                      }
                    : { client_id: 'test-client', client_secret: 'test-secret' }
            )
            sinon.stub(OAuthClient as any, 'discoverAS').resolves({ token_endpoint: endpointUrl })
            const write = sinon.stub(OAuthClient as any, 'write')
            const token = await OAuthClient.getValidAccessToken(new URL('https://mcp.example.com/mcp'), {
                interactive: false,
            })
            assert.equal(token, undefined)
            assert.equal(requests.length, 1)
            assert.equal(destinationRequests, 0)
            sinon.assert.notCalled(write)
            sinon.assert.notCalled(showDocument)
        })
    })
}
