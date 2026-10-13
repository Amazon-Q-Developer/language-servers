import { expect } from 'chai'
import * as sinon from 'sinon'
import { AccessDeniedException, ResourceNotFoundException } from '@amazon/elastic-gumby-frontend-client'
import { Logging, Runtime, Workspace } from '@aws/language-server-runtimes/server-interface'
import { classifyAtxSessionValidationError, EXPIRED_TOKEN_PHRASES } from '../atxSessionValidation'
import { ATXTransformHandler } from '../atxTransformHandler'
import { AtxTokenServiceManager } from '../../../shared/amazonQServiceManager/AtxTokenServiceManager'

const serviceError = (name: string, httpStatusCode?: number, extra: Record<string, any> = {}) => ({
    name,
    message: `${name} message`,
    $metadata: { httpStatusCode },
    ...extra,
})

describe('classifyAtxSessionValidationError', () => {
    describe('expired credentials', () => {
        it('recognizes the POC message: AccessDeniedException for an expired security token', () => {
            const error = new AccessDeniedException({
                message: 'The security token included in the request is expired',
                $metadata: { httpStatusCode: 403 },
            })

            const result = classifyAtxSessionValidationError(error)

            expect(result.Reason).to.equal('ExpiredCredentials')
            expect(result.ErrorCode).to.equal('AccessDeniedException')
            expect(result.HttpStatus).to.equal(403)
        })

        it('recognizes AccessDeniedException with reason INVALID_SESSION', () => {
            const error = serviceError('AccessDeniedException', 403, { reason: 'INVALID_SESSION' })
            expect(classifyAtxSessionValidationError(error).Reason).to.equal('ExpiredCredentials')
        })

        it('recognizes every listed token phrase, case-insensitively', () => {
            for (const phrase of EXPIRED_TOKEN_PHRASES) {
                const error = serviceError('AccessDeniedException', 403, { message: phrase.toUpperCase() })
                expect(classifyAtxSessionValidationError(error).Reason).to.equal('ExpiredCredentials')
            }
        })

        for (const name of [
            'ExpiredToken',
            'ExpiredTokenException',
            'InvalidClientTokenId',
            'UnrecognizedClientException',
        ]) {
            it(`recognizes ${name} by name`, () => {
                expect(classifyAtxSessionValidationError(serviceError(name, 403)).Reason).to.equal('ExpiredCredentials')
            })
        }
    })

    describe('missing permission', () => {
        it('treats any other AccessDeniedException as a permission problem', () => {
            const error = new AccessDeniedException({
                message: 'User is not authorized to perform transform:AccessTransformProfile',
                $metadata: { httpStatusCode: 403 },
            })
            expect(classifyAtxSessionValidationError(error).Reason).to.equal('MissingPermission')
        })
    })

    describe('tenant not found', () => {
        it('maps ResourceNotFoundException', () => {
            const error = new ResourceNotFoundException({ message: 'not found', $metadata: { httpStatusCode: 404 } })
            expect(classifyAtxSessionValidationError(error).Reason).to.equal('TenantNotFound')
        })

        it('maps ValidationException', () => {
            expect(classifyAtxSessionValidationError(serviceError('ValidationException', 400)).Reason).to.equal(
                'TenantNotFound'
            )
        })
    })

    describe('network or service', () => {
        it('maps server faults and 5xx', () => {
            expect(classifyAtxSessionValidationError(serviceError('Whatever', 503)).Reason).to.equal('NetworkOrService')
            expect(
                classifyAtxSessionValidationError(serviceError('InternalServerException', 500, { $fault: 'server' }))
                    .Reason
            ).to.equal('NetworkOrService')
            expect(classifyAtxSessionValidationError(serviceError('ThrottlingException', 429)).Reason).to.equal(
                'NetworkOrService'
            )
        })

        it('maps timeouts and connection failures', () => {
            expect(classifyAtxSessionValidationError({ name: 'TimeoutError' }).Reason).to.equal('NetworkOrService')
            const connectionError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
            expect(classifyAtxSessionValidationError(connectionError).Reason).to.equal('NetworkOrService')
        })
    })

    describe('other', () => {
        it('counts a signature mismatch as Other (a signer or clock problem, not expired credentials)', () => {
            // The POC message, which FES reports as AccessDeniedException.
            const error = serviceError('AccessDeniedException', 403, {
                message:
                    'The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method.',
            })
            const result = classifyAtxSessionValidationError(error)
            expect(result.Reason).to.equal('Other')
            expect(result.ErrorCode).to.equal('AccessDeniedException')
        })

        it('falls back to Other with the error code for unknown errors', () => {
            const result = classifyAtxSessionValidationError(serviceError('SomethingNew', 418))
            expect(result).to.deep.equal({ Reason: 'Other', ErrorCode: 'SomethingNew', HttpStatus: 418 })
        })

        it('never echoes the error message', () => {
            const result = classifyAtxSessionValidationError(
                serviceError('SomethingNew', 400, { message: 'secret AKIAEXAMPLE value' })
            )
            expect(JSON.stringify(result)).to.not.contain('AKIAEXAMPLE')
        })
    })
})

describe('ATXTransformHandler.validateSession', () => {
    let handler: ATXTransformHandler
    let logging: Logging
    let sendStub: sinon.SinonStub

    beforeEach(() => {
        const serviceManager = sinon.createStubInstance(AtxTokenServiceManager) as any
        logging = { log: sinon.stub(), error: sinon.stub() } as any
        handler = new ATXTransformHandler(serviceManager, {} as Workspace, logging, {} as Runtime)
        sendStub = sinon.stub()
        sinon.stub(handler as any, 'verifySession').resolves(true)
        sinon.stub(handler as any, 'addAuthToCommand').resolves()
        ;(handler as any).atxClient = { send: sendStub }
    })

    afterEach(() => {
        sinon.restore()
    })

    it('makes one ListWorkspaces call with maxResults 1 and reports success', async () => {
        sendStub.resolves({ items: [] })

        const result = await handler.validateSession()

        expect(result).to.deep.equal({ Valid: true })
        expect(sendStub.calledOnce).to.be.true
        const command = sendStub.firstCall.args[0]
        expect(command.constructor.name).to.equal('ListWorkspacesCommand')
        expect(command.input).to.deep.equal({ maxResults: 1 })
    })

    it('never creates a workspace', async () => {
        sendStub.resolves({ items: [] })
        const createSpy = sinon.spy(handler as any, 'createWorkspace')

        await handler.validateSession()

        expect(createSpy.notCalled).to.be.true
    })

    it('returns the classified failure and logs only reason, code and status', async () => {
        sendStub.rejects(
            new AccessDeniedException({
                message: 'The security token included in the request is expired',
                $metadata: { httpStatusCode: 403 },
            })
        )

        const result = await handler.validateSession()

        expect(result).to.deep.equal({
            Valid: false,
            Reason: 'ExpiredCredentials',
            ErrorCode: 'AccessDeniedException',
            HttpStatus: 403,
        })
        const logged = (logging.error as sinon.SinonStub).args.map(a => String(a[0])).join('\n')
        expect(logged).to.contain('reason=ExpiredCredentials')
        expect(logged).to.not.contain('security token')
    })

    it('fails without calling FES when the session is not ready', async () => {
        ;(handler as any).verifySession.resolves(false)

        const result = await handler.validateSession()

        expect(result).to.deep.equal({ Valid: false, Reason: 'Other', ErrorCode: 'SessionNotReady' })
        expect(sendStub.notCalled).to.be.true
    })
})
