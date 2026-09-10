import * as assert from 'assert'
import { WebFetch, WebFetchResult, extractSelectiveContent } from './webFetch'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import { InitializeParams } from '@aws/language-server-runtimes/protocol'
import { ToolUse } from '@amzn/codewhisperer-runtime'
import { WEB_FETCH } from '../constants/toolConstants'
import * as sinon from 'sinon'
import * as https from 'https'
import { EventEmitter } from 'events'
import { IncomingMessage, ClientRequest } from 'http'

describe('WebFetch', () => {
    let webFetch: WebFetch
    let testFeatures: TestFeatures
    let httpsGetStub: sinon.SinonStub

    beforeEach(() => {
        testFeatures = new TestFeatures()
        testFeatures.lsp.getClientInitializeParams.returns({} as InitializeParams)
        testFeatures.runtime.serverInfo = { name: 'test-server', version: '1.0.0' }

        webFetch = new WebFetch(testFeatures)
    })

    afterEach(() => {
        sinon.restore()
    })

    it('should create WebFetch instance', () => {
        assert.ok(webFetch)
    })

    it('should validate URL requirement', async () => {
        await assert.rejects(webFetch.validate({ url: '' }), /URL is required/)
    })

    it('should validate URL format', async () => {
        await assert.rejects(webFetch.validate({ url: 'invalid-url' }), /Invalid URL format/)
    })

    it('should pass validation for valid URL', async () => {
        await assert.doesNotReject(webFetch.validate({ url: 'https://example.com' }))
    })

    it('should return correct tool specification', () => {
        const spec = webFetch.getSpec()

        assert.strictEqual(spec.name, 'webFetch')
        assert.ok(spec.description.includes('Fetch and extract content'))
        assert.strictEqual(spec.inputSchema.type, 'object')
        assert.ok(spec.inputSchema.properties.url)
        assert.ok(spec.inputSchema.required.includes('url'))
    })

    describe('extractSelectiveContent', () => {
        it('should extract matching line with context', () => {
            const content = 'Para 1\nPara 2 with keyword\nPara 3\nPara 4'
            const result = extractSelectiveContent(content, 'keyword', 1)
            assert.strictEqual(result, 'Para 1 Para 2 with keyword Para 3')
        })

        it('should handle multiple context lines', () => {
            const content = 'L1\nL2\nL3\nL4\nMatch here\nL6\nL7\nL8\nL9'
            const result = extractSelectiveContent(content, 'match', 2)
            assert.strictEqual(result, 'L3 L4 Match here L6 L7')
        })

        it('should separate multiple matches with divider', () => {
            const content = 'First match\nMiddle\nSecond match'
            const result = extractSelectiveContent(content, 'match', 0)
            assert.strictEqual(result, 'First match\n\n---\n\nSecond match')
        })

        it('should deduplicate overlapping context', () => {
            const content = 'L0\nL1\nMatch A\nL3\nL4\nL5\nMatch B\nL7\nL8'
            const result = extractSelectiveContent(content, 'match', 1)
            // Match A at idx 2: [1,4], Match B at idx 6: [5,8] - no overlap
            assert.strictEqual(result, 'L1 Match A L3\n\n---\n\nL5 Match B L7')
        })

        it('should match multiple search terms', () => {
            const content = 'Apple\nBanana\nCherry'
            const result = extractSelectiveContent(content, 'apple cherry', 0)
            assert.strictEqual(result, 'Apple\n\n---\n\nCherry')
        })

        it('should be case insensitive', () => {
            const content = 'Para 1\nUPPERCASE text\nPara 3'
            const result = extractSelectiveContent(content, 'uppercase', 1)
            assert.ok(result.includes('UPPERCASE text'))
        })

        it('should fallback to truncated content when no match', () => {
            const content = 'x'.repeat(10000)
            const result = extractSelectiveContent(content, 'nomatch')
            assert.strictEqual(result.length, 8000)
        })

        it('should filter empty lines', () => {
            const content = 'L1\n\n\nMatch\n\n\nL2'
            const result = extractSelectiveContent(content, 'match', 1)
            assert.strictEqual(result, 'L1 Match L2')
        })

        it('should use default context of 10 lines', () => {
            const lines = Array.from({ length: 30 }, (_, i) => `Line ${i}`)
            lines[15] = 'Match'
            const content = lines.join('\n')
            const result = extractSelectiveContent(content, 'match')
            assert.ok(result.includes('Line 5'))
            assert.ok(result.includes('Line 25'))
            assert.ok(!result.includes('Line 4'))
        })

        it('should handle empty content', () => {
            const result = extractSelectiveContent('', 'match')
            assert.strictEqual(result, '')
        })

        it('should handle empty search terms', () => {
            const content = 'Line 1\nLine 2'
            const result = extractSelectiveContent(content, '')
            assert.strictEqual(result, content.substring(0, 8000))
        })

        it('should return full content when shorter than truncate length', () => {
            const content = 'Short content'
            const result = extractSelectiveContent(content, 'nomatch')
            assert.strictEqual(result, 'Short content')
        })

        it('should skip already-seen indices from overlapping contexts', () => {
            const content = 'L1\nMatch A\nL3\nMatch B\nL5'
            const result = extractSelectiveContent(content, 'match', 2)
            // Match A at idx 1: range [0,4], Match B at idx 3: already seen
            assert.ok(!result.includes('---'))
            assert.strictEqual(result, 'L1 Match A L3 Match B')
        })

        it('should respect custom truncate length', () => {
            const content = 'x'.repeat(10000)
            const result = extractSelectiveContent(content, 'nomatch', 10, 100)
            assert.strictEqual(result.length, 100)
        })
    })

    describe('static message methods', () => {
        const mockToolUse: ToolUse = {
            name: WEB_FETCH,
            toolUseId: 'test-id-123',
            input: { url: 'https://example.com', mode: 'selective' },
        }

        describe('getToolConfirmationMessage', () => {
            it('should return confirmation message with buttons', () => {
                const result = WebFetch.getToolConfirmationMessage(mockToolUse)
                const header = result.summary?.content?.header

                assert.strictEqual(result.type, 'tool')
                assert.strictEqual(result.messageId, 'test-id-123')
                assert.strictEqual(header?.icon, 'globe')
                assert.strictEqual(header.body, 'Web fetch')
                assert.strictEqual(header.buttons?.length, 2)
                assert.ok(result.summary?.collapsedContent?.[0].body?.includes('https://example.com'))
            })
        })

        describe('getToolConfirmationResultMessage', () => {
            it('should return success message when accepted', () => {
                const result = WebFetch.getToolConfirmationResultMessage(mockToolUse, true)
                const headerStatus = result.summary?.content?.header?.status

                assert.strictEqual(headerStatus?.status, 'success')
                assert.strictEqual(headerStatus.icon, 'ok')
                assert.strictEqual(headerStatus.text, 'Allowed')
            })

            it('should return error message when rejected', () => {
                const result = WebFetch.getToolConfirmationResultMessage(mockToolUse, false)
                const headerStatus = result.summary?.content?.header?.status

                assert.strictEqual(headerStatus?.status, 'error')
                assert.strictEqual(headerStatus.icon, 'cancel')
                assert.strictEqual(headerStatus.text, 'Rejected')
            })
        })

        describe('getToolResultMessage', () => {
            it('should return result message with parameters and result', () => {
                const mockResult = {
                    output: {
                        kind: 'json',
                        content: {
                            content: 'Page content',
                            url: 'https://example.com',
                            statusCode: 200,
                            bytesDownloaded: 1024,
                        },
                    },
                }
                const result = WebFetch.getToolResultMessage(mockToolUse, mockResult)

                assert.strictEqual(result.type, 'tool')
                assert.strictEqual(result.messageId, 'test-id-123')
                assert.strictEqual(result.summary?.content?.header?.body, 'Web fetch')
                assert.strictEqual(result.summary?.content?.header?.status?.text, 'Fetched 1.0 KB')
                assert.strictEqual(result.summary?.collapsedContent?.length, 2)
                assert.strictEqual(result.summary.collapsedContent?.[0].header?.body, 'Parameters')
                assert.strictEqual(result.summary.collapsedContent?.[1].header?.body, 'Result')
                assert.ok(result.summary.collapsedContent[1].body?.includes('Page content'))
            })

            it('should not show status when bytesDownloaded is missing', () => {
                const mockResult = {
                    output: { kind: 'json', content: { content: 'Page', url: 'https://example.com' } },
                }
                const result = WebFetch.getToolResultMessage(mockToolUse, mockResult)

                assert.strictEqual(result.summary?.content?.header?.status, undefined)
            })

            it('should not show status when bytesDownloaded is 0', () => {
                const mockResult = {
                    output: { kind: 'json', content: { bytesDownloaded: 0 } },
                }
                const result = WebFetch.getToolResultMessage(mockToolUse, mockResult)

                assert.strictEqual(result.summary?.content?.header?.status, undefined)
            })
        })
    })

    describe('invoke', () => {
        let clock: sinon.SinonFakeTimers

        afterEach(() => {
            if (clock) {
                clock.restore()
            }
        })

        it('should fetch and return HTML content', async () => {
            const mockHtml = '<html><body><p>Test content</p></body></html>'
            const mockResponse = new EventEmitter() as IncomingMessage
            mockResponse.statusCode = 200
            mockResponse.headers = { 'content-type': 'text/html' }

            const mockRequest = new EventEmitter() as ClientRequest
            mockRequest.setTimeout = sinon.stub().returnsThis()
            mockRequest.destroy = sinon.stub()

            sinon.stub(https, 'get').callsFake((_url, _options, callback) => {
                callback?.(mockResponse)
                setImmediate(() => {
                    mockResponse.emit('data', Buffer.from(mockHtml))
                    mockResponse.emit('end')
                })
                return mockRequest
            })

            const result = await webFetch.invoke({ url: 'https://example.com' })
            const content = result.output.content as WebFetchResult

            assert.strictEqual(result.output.kind, 'json')
            assert.ok(content.content)
            assert.strictEqual(content.statusCode, 200)
            assert.strictEqual(content.bytesDownloaded, mockHtml.length)
        })

        it('should reject non-HTML content', async () => {
            clock = sinon.useFakeTimers()

            const mockResponse = new EventEmitter() as IncomingMessage
            mockResponse.statusCode = 200
            mockResponse.headers = { 'content-type': 'application/json' }

            const mockRequest = new EventEmitter() as ClientRequest
            mockRequest.setTimeout = sinon.stub().returnsThis()
            mockRequest.destroy = sinon.stub()

            sinon.stub(https, 'get').callsFake((_url, _options, callback) => {
                callback?.(mockResponse)
                return mockRequest
            })

            const promise = webFetch.invoke({ url: 'https://example.com' })
            await clock.tickAsync(10000)

            await assert.rejects(promise, /Only HTML content is supported/)
        })

        it('should handle HTTP error status codes', async () => {
            const mockHtml = '<html><body><p>Error page</p></body></html>'
            const mockResponse = new EventEmitter() as IncomingMessage
            mockResponse.statusCode = 404
            mockResponse.headers = { 'content-type': 'text/html' }

            const mockRequest = new EventEmitter() as ClientRequest
            mockRequest.setTimeout = sinon.stub().returnsThis()
            mockRequest.destroy = sinon.stub()

            sinon.stub(https, 'get').callsFake((_url, _options, callback) => {
                callback?.(mockResponse)
                setImmediate(() => {
                    mockResponse.emit('data', Buffer.from(mockHtml))
                    mockResponse.emit('end')
                })
                return mockRequest
            })

            const result = await webFetch.invoke({ url: 'https://example.com' })
            const content = result.output.content as WebFetchResult

            assert.strictEqual(content.statusCode, 404)
            assert.strictEqual(content.url, 'https://example.com')
            assert.strictEqual(content.bytesDownloaded, mockHtml.length)
            assert.ok(content.content.length > 0)
        })

        it('should handle request timeout', async () => {
            clock = sinon.useFakeTimers()

            const mockRequest = new EventEmitter() as ClientRequest
            let timeoutCallback: (() => void) | undefined
            mockRequest.setTimeout = sinon.stub().callsFake((_ms, cb) => {
                timeoutCallback = cb
                return mockRequest
            })
            mockRequest.destroy = sinon.stub()

            sinon.stub(https, 'get').callsFake(() => {
                Promise.resolve().then(() => timeoutCallback?.())
                return mockRequest
            })

            const promise = webFetch.invoke({ url: 'https://example.com' })
            await clock.tickAsync(10000)

            await assert.rejects(promise, /Request timeout/)
        })

        it('should handle network errors', async () => {
            clock = sinon.useFakeTimers()

            const mockRequest = new EventEmitter() as ClientRequest
            mockRequest.setTimeout = sinon.stub().returnsThis()
            mockRequest.destroy = sinon.stub()

            sinon.stub(https, 'get').callsFake(() => {
                Promise.resolve().then(() => mockRequest.emit('error', new Error('Network error')))
                return mockRequest
            })

            const promise = webFetch.invoke({ url: 'https://example.com' })
            await clock.tickAsync(10000)

            await assert.rejects(promise, /Network error/)
        })

        it('should handle content size limit exceeded', async () => {
            clock = sinon.useFakeTimers()

            const mockResponse = new EventEmitter() as IncomingMessage
            mockResponse.statusCode = 200
            mockResponse.headers = { 'content-type': 'text/html' }

            const mockRequest = new EventEmitter() as ClientRequest
            mockRequest.setTimeout = sinon.stub().returnsThis()
            mockRequest.destroy = sinon.stub()

            sinon.stub(https, 'get').callsFake((_url, _options, callback) => {
                callback?.(mockResponse)
                Promise.resolve().then(() => {
                    const largeChunk = Buffer.alloc(11 * 1024 * 1024)
                    mockResponse.emit('data', largeChunk)
                })
                return mockRequest
            })

            const promise = webFetch.invoke({ url: 'https://example.com' })
            await clock.tickAsync(10000)

            await assert.rejects(promise, /exceeds 10MB limit/)
        })

        it('should handle selective mode with search terms', async () => {
            const mockHtml =
                '<html><body><p>First paragraph</p><p>Keyword match here</p><p>Last paragraph</p></body></html>'
            const mockResponse = new EventEmitter() as IncomingMessage
            mockResponse.statusCode = 200
            mockResponse.headers = { 'content-type': 'text/html' }

            const mockRequest = new EventEmitter() as ClientRequest
            mockRequest.setTimeout = sinon.stub().returnsThis()
            mockRequest.destroy = sinon.stub()

            sinon.stub(https, 'get').callsFake((_url, _options, callback) => {
                callback?.(mockResponse)
                setImmediate(() => {
                    mockResponse.emit('data', Buffer.from(mockHtml))
                    mockResponse.emit('end')
                })
                return mockRequest
            })

            const result = await webFetch.invoke({
                url: 'https://example.com',
                mode: 'selective',
                searchTerms: 'keyword',
            })
            const content = result.output.content as WebFetchResult

            assert.ok(content.content.includes('Keyword match here'))
        })

        it('should handle truncated mode', async () => {
            const longParagraph = 'A'.repeat(100)
            const longContent = '<html><body>' + `<p>${longParagraph}</p>`.repeat(100) + '</body></html>'
            const mockResponse = new EventEmitter() as IncomingMessage
            mockResponse.statusCode = 200
            mockResponse.headers = { 'content-type': 'text/html' }

            const mockRequest = new EventEmitter() as ClientRequest
            mockRequest.setTimeout = sinon.stub().returnsThis()
            mockRequest.destroy = sinon.stub()

            sinon.stub(https, 'get').callsFake((_url, _options, callback) => {
                callback?.(mockResponse)
                setImmediate(() => {
                    mockResponse.emit('data', Buffer.from(longContent))
                    mockResponse.emit('end')
                })
                return mockRequest
            })

            const result = await webFetch.invoke({ url: 'https://example.com', mode: 'truncated' })
            const content = result.output.content as WebFetchResult

            assert.ok(longContent.length > 8000)
            assert.ok(content.content.length <= 8000)
        })

        it('should handle full mode', async () => {
            const mockHtml = '<html><body><p>First</p><p>Second</p><p>Third</p></body></html>'
            const mockResponse = new EventEmitter() as IncomingMessage
            mockResponse.statusCode = 200
            mockResponse.headers = { 'content-type': 'text/html' }

            const mockRequest = new EventEmitter() as ClientRequest
            mockRequest.setTimeout = sinon.stub().returnsThis()
            mockRequest.destroy = sinon.stub()

            sinon.stub(https, 'get').callsFake((_url, _options, callback) => {
                callback?.(mockResponse)
                setImmediate(() => {
                    mockResponse.emit('data', Buffer.from(mockHtml))
                    mockResponse.emit('end')
                })
                return mockRequest
            })

            const result = await webFetch.invoke({ url: 'https://example.com', mode: 'full' })
            const content = result.output.content as WebFetchResult

            assert.ok(content.content.includes('First'))
            assert.ok(content.content.includes('Second'))
            assert.ok(content.content.includes('Third'))
        })

        it('should follow redirects', async () => {
            const mockHtml = '<html><body><p>Final content</p></body></html>'
            const redirectResponse = new EventEmitter() as IncomingMessage
            redirectResponse.statusCode = 302
            redirectResponse.headers = { 'content-type': 'text/html', location: 'https://example.com/final' }

            const finalResponse = new EventEmitter() as IncomingMessage
            finalResponse.statusCode = 200
            finalResponse.headers = { 'content-type': 'text/html' }

            const mockRequest = new EventEmitter() as ClientRequest
            mockRequest.setTimeout = sinon.stub().returnsThis()
            mockRequest.destroy = sinon.stub()

            let callCount = 0
            sinon.stub(https, 'get').callsFake((_url, _options, callback) => {
                if (callCount === 0) {
                    callCount++
                    callback?.(redirectResponse)
                    setImmediate(() => redirectResponse.emit('end'))
                } else {
                    callback?.(finalResponse)
                    setImmediate(() => {
                        finalResponse.emit('data', Buffer.from(mockHtml))
                        finalResponse.emit('end')
                    })
                }
                return mockRequest
            })

            const result = await webFetch.invoke({ url: 'https://example.com' })
            const content = result.output.content as WebFetchResult

            assert.strictEqual(content.statusCode, 200)
            assert.ok(content.content.includes('Final content'))
        })

        it('should reject when redirect limit exceeded', async () => {
            clock = sinon.useFakeTimers()

            let redirectCount = 0
            sinon.stub(https, 'get').callsFake((_url, _options, callback) => {
                redirectCount++
                const mockRequest = new EventEmitter() as ClientRequest
                mockRequest.setTimeout = sinon.stub().returnsThis()
                mockRequest.destroy = sinon.stub()

                const mockResponse = new EventEmitter() as IncomingMessage
                mockResponse.statusCode = 302
                mockResponse.headers = {
                    'content-type': 'text/html',
                    location: `https://example.com/redirect${redirectCount}`,
                }

                callback?.(mockResponse)
                Promise.resolve().then(() => mockResponse.emit('end'))
                return mockRequest
            })

            const promise = webFetch.invoke({ url: 'https://example.com' })
            await clock.tickAsync(100000)

            await assert.rejects(promise, /Too many redirects/)
            assert.ok(redirectCount > 10, 'Should have attempted more than 10 redirects')
        })

        it('should retry on transient failure', async () => {
            clock = sinon.useFakeTimers()

            const mockHtml = '<html><body><p>Success after retry</p></body></html>'
            const mockResponse = new EventEmitter() as IncomingMessage
            mockResponse.statusCode = 200
            mockResponse.headers = { 'content-type': 'text/html' }

            let attemptCount = 0
            sinon.stub(https, 'get').callsFake((_url, _options, callback) => {
                const mockRequest = new EventEmitter() as ClientRequest
                mockRequest.setTimeout = sinon.stub().returnsThis()
                mockRequest.destroy = sinon.stub()

                if (attemptCount === 0) {
                    attemptCount++
                    Promise.resolve().then(() => mockRequest.emit('error', new Error('Transient error')))
                } else {
                    callback?.(mockResponse)
                    Promise.resolve().then(() => {
                        mockResponse.emit('data', Buffer.from(mockHtml))
                        mockResponse.emit('end')
                    })
                }
                return mockRequest
            })

            const promise = webFetch.invoke({ url: 'https://example.com' })
            await clock.tickAsync(10000)

            const result = await promise
            const content = result.output.content as WebFetchResult

            assert.ok(content.content.includes('Success after retry'))
        })
    })
})
