import { expect } from 'chai'
import { getAtxErrorInfo } from '../atxErrorInfo'

describe('getAtxErrorInfo', () => {
    it('returns the service error name and HTTP status', () => {
        const error = Object.assign(new Error('arn:aws:iam::123456789012:user/u is not authorized'), {
            name: 'AccessDeniedException',
            $metadata: { httpStatusCode: 403 },
        })

        expect(getAtxErrorInfo(error)).to.deep.equal({ errorCode: 'AccessDeniedException', statusCode: 403 })
    })

    it('never returns the message', () => {
        const error = Object.assign(new Error('arn:aws:iam::123456789012:user/u'), { name: 'AccessDeniedException' })

        expect(JSON.stringify(getAtxErrorInfo(error))).to.not.include('123456789012')
    })

    it('returns nothing for a plain error', () => {
        expect(getAtxErrorInfo(new Error('boom'))).to.deep.equal({ errorCode: undefined, statusCode: undefined })
    })

    it('handles a missing error', () => {
        expect(getAtxErrorInfo(undefined)).to.deep.equal({ errorCode: undefined, statusCode: undefined })
    })
})
