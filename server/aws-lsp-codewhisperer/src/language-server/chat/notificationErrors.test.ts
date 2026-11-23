import * as assert from 'assert'
import { Logging } from '@aws/language-server-runtimes/server-interface'
import sinon from 'ts-sinon'
import { logNotificationErrors } from './notificationErrors'
import { unhandledRejectionsDuring } from '../../shared/testUtils'

describe('logNotificationErrors()', () => {
    let logError: sinon.SinonStub
    let logging: Logging

    beforeEach(() => {
        logError = sinon.stub()
        logging = { error: logError } as unknown as Logging
    })

    afterEach(() => {
        sinon.restore()
    })

    it('passes the params to the handler and logs nothing when the handler succeeds', async () => {
        const syncHandler = sinon.stub().returns(undefined)
        const asyncHandler = sinon.stub().resolves('done')

        logNotificationErrors(logging, 'test/sync', syncHandler)({ value: 1 })
        logNotificationErrors(logging, 'test/async', asyncHandler)({ value: 2 })
        await new Promise(resolve => setImmediate(resolve))

        sinon.assert.calledOnceWithExactly(syncHandler, { value: 1 })
        sinon.assert.calledOnceWithExactly(asyncHandler, { value: 2 })
        sinon.assert.notCalled(logError)
    })

    it('calls the handler before it returns', () => {
        const handler = sinon.stub()

        logNotificationErrors(logging, 'test/sync', handler)({ value: 1 })

        sinon.assert.calledOnce(handler)
    })

    it('logs a rejection with the notification method and the reason', async () => {
        const failure = new Error('rejected')

        const rejections = await unhandledRejectionsDuring(() =>
            logNotificationErrors(logging, 'test/reject', () => Promise.reject(failure))(undefined)
        )

        assert.ok(!rejections.includes(failure), 'the rejection was left unhandled')
        sinon.assert.calledOnceWithMatch(logError, sinon.match('test/reject').and(sinon.match('rejected')))
    })

    it('logs a handler that throws instead of throwing to the caller', () => {
        const handler = logNotificationErrors(logging, 'test/throw', () => {
            throw new Error('thrown')
        })

        assert.doesNotThrow(() => handler(undefined))

        sinon.assert.calledOnceWithMatch(logError, sinon.match('test/throw').and(sinon.match('thrown')))
    })

    it('logs a rejection reason that is not an Error', async () => {
        logNotificationErrors(logging, 'test/reject', () => Promise.reject('plain reason'))(undefined)
        await new Promise(resolve => setImmediate(resolve))

        sinon.assert.calledOnceWithMatch(logError, sinon.match('test/reject').and(sinon.match('plain reason')))
    })

    it('leaves no unhandled rejection when the rejection reason cannot be formatted', async () => {
        // JSON serialization, which formatErr uses, throws a TypeError on a bigint
        const rejections = await unhandledRejectionsDuring(() =>
            logNotificationErrors(logging, 'test/bigint', () => Promise.reject(10n))(undefined)
        )

        assert.ok(
            !rejections.some(
                reason => reason === 10n || (reason instanceof TypeError && /BigInt/.test(reason.message))
            ),
            'the rejection or the formatting error was left unhandled'
        )
    })

    it('leaves no unhandled rejection or exception when the logger throws', async () => {
        const loggerFailure = new Error('logger failed')
        const failure = new Error('rejected')
        logError.throws(loggerFailure)

        const rejections = await unhandledRejectionsDuring(() => {
            logNotificationErrors(logging, 'test/reject', () => Promise.reject(failure))(undefined)
            logNotificationErrors(logging, 'test/throw', () => {
                throw new Error('thrown')
            })(undefined)
        })

        assert.ok(!rejections.includes(failure), 'the rejection was left unhandled')
        assert.ok(!rejections.includes(loggerFailure), 'the logger error was left unhandled')
        sinon.assert.calledTwice(logError)
    })
})
