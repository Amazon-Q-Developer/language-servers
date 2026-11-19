import { QErrorTransformer } from './errorTransformer'
import { AgenticChatError } from '../errors'
import { expect } from 'chai'
import * as sinon from 'sinon'
import {
    MONTHLY_LIMIT_ERROR_MARKER,
    HIGH_LOAD_ERROR_MESSAGE,
    INSUFFICIENT_MODEL_CAPACITY,
    SERVICE_UNAVAILABLE_EXCEPTION,
} from '../constants/constants'

describe('QErrorTransformer', () => {
    let transformer: QErrorTransformer
    let mockLogging: any

    beforeEach(() => {
        mockLogging = {
            log: sinon.spy(),
            debug: sinon.spy(),
        }
        transformer = new QErrorTransformer(mockLogging, false)
    })

    describe('transformFinalError', () => {
        it('should transform usage limit errors', () => {
            const error = new Error('Usage limit exceeded')
            ;(error as any).code = 'AmazonQUsageLimitError'
            error.message = `${MONTHLY_LIMIT_ERROR_MARKER} exceeded`

            const result = transformer.transformFinalError(error)

            expect(result).to.be.instanceOf(AgenticChatError)
            expect(result.message).to.include('Request failed after 3 attempts')
            expect(result.message).to.include('reached your Amazon Q usage limit')
            expect((result as AgenticChatError).code).to.equal('AmazonQUsageLimitError')
        })

        it('should transform monthly limit errors from response body', () => {
            const error = new Error('Service error')
            ;(error as any).cause = {
                $metadata: {
                    body: `Error: ${MONTHLY_LIMIT_ERROR_MARKER} exceeded for user`,
                },
            }

            const result = transformer.transformFinalError(error)

            expect(result).to.be.instanceOf(AgenticChatError)
            expect(result.message).to.include('reached your monthly Amazon Q request limit')
            expect((result as AgenticChatError).code).to.equal('AmazonQUsageLimitError')
        })

        it('should not make a usage limit indistinguishable from generic retry exhaustion', () => {
            // A quota condition and a transport failure previously produced the identical
            // 'Request failed after 3 attempts' string, which is what clients that surface
            // ResponseError.message (rather than its structured data) show the user.
            const usageLimit = new Error('Usage limit exceeded')
            ;(usageLimit as any).code = 'AmazonQUsageLimitError'
            const generic = new Error('socket hang up')

            const usageLimitResult = transformer.transformFinalError(usageLimit)
            const genericResult = transformer.transformFinalError(generic)

            expect(usageLimitResult.message).to.not.equal(genericResult.message)
        })

        it('should keep the throttling message distinct from the usage limit message', () => {
            const throttling = new Error('Throttling')
            ;(throttling as any).code = 'ThrottlingException'
            ;(throttling as any).statusCode = 429

            const result = transformer.transformFinalError(throttling)

            expect((result as AgenticChatError).code).to.equal('RequestThrottled')
            expect(result.message).to.include('high traffic')
            expect(result.message).to.not.include('usage limit')
        })

        it('should transform abort errors', () => {
            const error = new Error('Request aborted')
            error.name = 'AbortError'

            const result = transformer.transformFinalError(error)

            expect(result).to.be.instanceOf(AgenticChatError)
            expect(result.message).to.equal('Request aborted')
            expect((result as AgenticChatError).code).to.equal('RequestAborted')
        })

        it('should transform input too long errors', () => {
            const error = new Error('input too long')
            ;(error as any).code = 'InputTooLong'

            const result = transformer.transformFinalError(error)

            expect(result).to.be.instanceOf(AgenticChatError)
            expect(result.message).to.include('Too much context loaded')
            expect((result as AgenticChatError).code).to.equal('InputTooLong')
        })

        it('should transform model unavailable errors with model selection enabled', () => {
            const transformerWithModelSelection = new QErrorTransformer(mockLogging, true)
            const error = new Error('Model unavailable')
            ;(error as any).statusCode = 429
            ;(error as any).cause = { reason: INSUFFICIENT_MODEL_CAPACITY }

            const result = transformerWithModelSelection.transformFinalError(error)

            expect(result).to.be.instanceOf(AgenticChatError)
            expect(result.message).to.include('model you selected is temporarily unavailable')
            expect((result as AgenticChatError).code).to.equal('QModelResponse')
        })

        it('should transform model unavailable errors without model selection', () => {
            const error = new Error('High load')
            ;(error as any).statusCode = 500
            error.message = HIGH_LOAD_ERROR_MESSAGE

            const result = transformer.transformFinalError(error)

            expect(result).to.be.instanceOf(AgenticChatError)
            expect(result.message).to.include('experiencing high traffic')
            expect((result as AgenticChatError).code).to.equal('QModelResponse')
        })

        it('should transform throttling errors', () => {
            const error = new Error('Throttling')
            ;(error as any).code = 'ThrottlingException'
            ;(error as any).statusCode = 429

            const result = transformer.transformFinalError(error)

            expect(result).to.be.instanceOf(AgenticChatError)
            expect(result.message).to.include('Service is currently experiencing high traffic')
            expect((result as AgenticChatError).code).to.equal('RequestThrottled')
        })

        it('should transform service overloaded errors', () => {
            const error = new Error('Service error')
            ;(error as any).statusCode = 500
            ;(error as any).cause = {
                $metadata: {
                    body: `${SERVICE_UNAVAILABLE_EXCEPTION}: Service temporarily unavailable`,
                },
            }

            const result = transformer.transformFinalError(error)

            expect(result).to.be.instanceOf(AgenticChatError)
            expect(result.message).to.include('Service is currently experiencing high traffic')
            expect((result as AgenticChatError).code).to.equal('RequestThrottled')
        })

        it('should handle unknown errors', () => {
            const error = new Error('Unknown error')

            const result = transformer.transformFinalError(error)

            expect(result).to.be.instanceOf(AgenticChatError)
            expect(result.message).to.equal('Unknown error')
            expect((result as AgenticChatError).code).to.equal('QModelResponse')
        })

        it('should use custom attempt count when provided', () => {
            const error = new Error('Throttling')
            ;(error as any).code = 'AmazonQUsageLimitError'

            const result = transformer.transformFinalError(error, 5)

            expect(result.message).to.include('Request failed after 5 attempts')
        })

        it('should extract request ID from error', () => {
            const error = new Error('Service error')
            ;(error as any).cause = {
                $metadata: { requestId: 'test-request-123' },
            }

            const result = transformer.transformFinalError(error) as AgenticChatError

            expect(result.requestId).to.equal('test-request-123')
        })

        it('should pass through authentication errors', () => {
            // Mock the instanceof check by creating a proper error type
            const authError = new Error('Auth error')
            ;(authError as any).constructor = { name: 'AmazonQServicePendingSigninError' }

            // Mock the instanceof check
            const originalTransform = transformer.transformFinalError
            transformer.transformFinalError = function (error: any, attemptCount?: number) {
                if (error.constructor?.name === 'AmazonQServicePendingSigninError') {
                    return error
                }
                return originalTransform.call(this, error, attemptCount)
            }

            const result = transformer.transformFinalError(authError)

            expect(result).to.equal(authError)
        })

        it('should handle model unavailable with reason property', () => {
            const error = new Error('Model unavailable')
            ;(error as any).statusCode = 429
            ;(error as any).reason = INSUFFICIENT_MODEL_CAPACITY

            const result = transformer.transformFinalError(error)

            expect(result).to.be.instanceOf(AgenticChatError)
            expect((result as AgenticChatError).code).to.equal('QModelResponse')
        })

        it('should handle non-Error objects', () => {
            const nonError = 'string error'

            const result = transformer.transformFinalError(nonError)

            expect(result).to.be.instanceOf(AgenticChatError)
            expect(result.message).to.equal('string error')
        })
    })

    describe('extractResponseBody', () => {
        it('should extract body from different error formats', () => {
            const transformer = new QErrorTransformer()

            // Test cause.$metadata.body
            let error: any = {
                cause: { $metadata: { body: 'test body 1' } },
            }
            expect((transformer as any).extractResponseBody(error)).to.equal('test body 1')

            // Test $metadata.body
            error = {
                $metadata: { body: 'test body 2' },
            }
            expect((transformer as any).extractResponseBody(error)).to.equal('test body 2')

            // Test message
            error = {
                message: 'test body 3',
            }
            expect((transformer as any).extractResponseBody(error)).to.equal('test body 3')
        })

        it('should handle extraction errors gracefully', () => {
            const transformer = new QErrorTransformer()

            // Test extractTextFromBody error handling
            const bodyThatThrows = {
                get toString() {
                    throw new Error('Access denied')
                },
            }

            const result = (transformer as any).extractTextFromBody(bodyThatThrows)
            expect(result).to.be.null
        })

        it('should extract from response data and body', () => {
            const transformer = new QErrorTransformer()

            // Test response.data
            let error: any = {
                response: { data: 'response data' },
            }
            expect((transformer as any).extractResponseBody(error)).to.equal('response data')

            // Test response.body
            error = {
                response: { body: 'response body' },
            }
            expect((transformer as any).extractResponseBody(error)).to.equal('response body')
        })
    })

    describe('getStatusCode', () => {
        it('should extract status code from different error formats', () => {
            const transformer = new QErrorTransformer()

            // Test cause.$metadata.httpStatusCode
            let error: any = {
                cause: { $metadata: { httpStatusCode: 429 } },
            }
            expect((transformer as any).getStatusCode(error)).to.equal(429)

            // Test $metadata.httpStatusCode
            error = {
                $metadata: { httpStatusCode: 500 },
            }
            expect((transformer as any).getStatusCode(error)).to.equal(500)

            // Test statusCode
            error = {
                statusCode: 404,
            }
            expect((transformer as any).getStatusCode(error)).to.equal(404)

            // Test status
            error = {
                status: 503,
            }
            expect((transformer as any).getStatusCode(error)).to.equal(503)
        })

        it('should handle status code extraction errors', () => {
            const transformer = new QErrorTransformer()
            const error: any = {
                get cause() {
                    throw new Error('Access denied')
                },
            }

            const result = (transformer as any).getStatusCode(error)

            expect(result).to.be.undefined
        })

        it('should extract status code from response patterns', () => {
            const transformer = new QErrorTransformer()

            // Test response.status
            let error: any = {
                response: { status: 429 },
            }
            expect((transformer as any).getStatusCode(error)).to.equal(429)

            // Test response.statusCode
            error = {
                response: { statusCode: 500 },
            }
            expect((transformer as any).getStatusCode(error)).to.equal(500)

            // Test cause.statusCode
            error = {
                cause: { statusCode: 404 },
            }
            expect((transformer as any).getStatusCode(error)).to.equal(404)

            // Test cause.status
            error = {
                cause: { status: 503 },
            }
            expect((transformer as any).getStatusCode(error)).to.equal(503)
        })
    })

    describe('isThrottlingError', () => {
        it('should identify throttling errors by status code', () => {
            const transformer = new QErrorTransformer()

            const error: any = { statusCode: 429 }
            expect((transformer as any).isThrottlingError(error)).to.be.true
        })

        it('should identify throttling errors by code', () => {
            const transformer = new QErrorTransformer()

            const error: any = { code: 'ThrottlingException' }
            expect((transformer as any).isThrottlingError(error)).to.be.true
        })

        it('should identify service overloaded errors', () => {
            const transformer = new QErrorTransformer()

            const error: any = {
                statusCode: 500,
                cause: {
                    $metadata: {
                        body: HIGH_LOAD_ERROR_MESSAGE,
                    },
                },
            }
            expect((transformer as any).isThrottlingError(error)).to.be.true
        })

        it('should not identify non-throttling errors', () => {
            const transformer = new QErrorTransformer()

            const error: any = { statusCode: 404 }
            expect((transformer as any).isThrottlingError(error)).to.be.false
        })

        it('should identify throttling by name', () => {
            const transformer = new QErrorTransformer()

            const error: any = { name: 'ThrottlingException' }
            expect((transformer as any).isThrottlingError(error)).to.be.true
        })

        it('should identify model capacity throttling', () => {
            const transformer = new QErrorTransformer()

            const error: any = {
                statusCode: 429,
                cause: { reason: INSUFFICIENT_MODEL_CAPACITY },
            }
            expect((transformer as any).isThrottlingError(error)).to.be.true
        })

        it('should log debug messages for service overloaded detection', () => {
            const transformer = new QErrorTransformer(mockLogging)

            const error: any = {
                statusCode: 500,
                cause: {
                    $metadata: {
                        body: `${SERVICE_UNAVAILABLE_EXCEPTION}: Service temporarily unavailable`,
                    },
                },
            }

            expect((transformer as any).isThrottlingError(error)).to.be.true
            expect(mockLogging.debug.called).to.be.true
        })

        it('should handle ArrayBuffer body extraction', () => {
            const transformer = new QErrorTransformer()
            const buffer = new TextEncoder().encode('test buffer').buffer

            const result = (transformer as any).extractTextFromBody(buffer)
            expect(result).to.equal('test buffer')
        })

        it('should handle object body extraction', () => {
            const transformer = new QErrorTransformer()
            const obj = { message: 'test object' }

            const result = (transformer as any).extractTextFromBody(obj)
            expect(result).to.equal('{"message":"test object"}')
        })

        it('should handle null body', () => {
            const transformer = new QErrorTransformer()

            const result = (transformer as any).extractTextFromBody(null)
            expect(result).to.be.null
        })

        it('should handle undefined body', () => {
            const transformer = new QErrorTransformer()

            const result = (transformer as any).extractTextFromBody(undefined)
            expect(result).to.be.null
        })
    })
})
