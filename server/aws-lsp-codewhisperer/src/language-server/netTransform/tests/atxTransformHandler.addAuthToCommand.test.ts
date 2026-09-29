import { expect } from 'chai'
import * as sinon from 'sinon'
import { ATXTransformHandler } from '../atxTransformHandler'
import { AtxTokenServiceManager } from '../../../shared/amazonQServiceManager/AtxTokenServiceManager'
import { Logging, Runtime, Workspace } from '@aws/language-server-runtimes/server-interface'

/**
 * Exercises the auth branch point (addAuthToCommand) for both the bearer (IdC) and IAM (SigV4)
 * paths, plus the not-signed-in negative case. The bearer assertions lock the existing wire
 * behavior so the IAM branch cannot regress it.
 */
describe('ATXTransformHandler - addAuthToCommand auth branching', () => {
    const TENANT_URL = 'https://tenant.transform.ap-northeast-2.on.aws'
    const BEARER_TOKEN = 'my-bearer-token'
    const IAM_CREDENTIALS = {
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'secretExampleKey',
        sessionToken: 'sessionTokenExample',
    }

    let handler: ATXTransformHandler
    let serviceManager: sinon.SinonStubbedInstance<AtxTokenServiceManager>
    let logging: Logging

    beforeEach(() => {
        serviceManager = sinon.createStubInstance(AtxTokenServiceManager)
        logging = { log: sinon.stub(), error: sinon.stub() } as any
        handler = new ATXTransformHandler(serviceManager as any, {} as Workspace, logging, {} as Runtime)

        // getRegionFromProfile reads the active application URL from the singleton; point it at the stub.
        sinon.stub(AtxTokenServiceManager, 'getInstance').returns(serviceManager as any)

        serviceManager.isReady.returns(true)
        serviceManager.hasValidCredentials.returns(true)
        serviceManager.getActiveApplicationUrl.returns(TENANT_URL)
        serviceManager.getBearerToken.resolves(BEARER_TOKEN)
        serviceManager.getIamCredentials.returns(IAM_CREDENTIALS as any)
    })

    afterEach(() => {
        sinon.restore()
    })

    // Runs addAuthToCommand, captures the middleware it registers, and executes it against a
    // representative FES request, returning the resulting request headers.
    const runAuthMiddleware = async (): Promise<Record<string, string>> => {
        let middlewareFactory: any
        const command = {
            middlewareStack: {
                add: (factory: any) => {
                    middlewareFactory = factory
                },
            },
        }

        await handler['addAuthToCommand'](command)
        expect(middlewareFactory, 'auth middleware was registered').to.be.a('function')

        const args = {
            request: {
                method: 'POST',
                protocol: 'https:',
                hostname: 'api.transform.ap-northeast-2.on.aws',
                path: '/',
                query: {},
                headers: {
                    host: 'api.transform.ap-northeast-2.on.aws',
                    'content-type': 'application/x-amz-json-1.0',
                    'x-amz-target': 'ElasticGumbyFrontEndService.ListWorkspaces',
                },
                body: '{}',
            },
        }
        const next = sinon.stub().callsFake(async (a: any) => a)
        await middlewareFactory(next)(args)
        expect(next.calledOnce).to.equal(true)
        return args.request.headers as Record<string, string>
    }

    describe('bearer path (unchanged)', () => {
        it('attaches the bearer token, Origin, and content headers', async () => {
            serviceManager.getAuthType.returns('bearer')

            const headers = await runAuthMiddleware()

            expect(headers['Authorization']).to.equal(`Bearer ${BEARER_TOKEN}`)
            expect(headers['Origin']).to.equal(TENANT_URL)
            expect(headers['Content-Type']).to.equal('application/json; charset=UTF-8')
            expect(headers['Content-Encoding']).to.equal('amz-1.0')
            // The bearer path never SigV4-signs.
            expect(headers['authorization']).to.equal(undefined)
            expect(headers['x-amz-date']).to.equal(undefined)
        })
    })

    describe('iam path (SigV4)', () => {
        it('produces a SigV4 signature over the transform service with the tenant-URL region', async () => {
            serviceManager.getAuthType.returns('iam')

            const headers = await runAuthMiddleware()

            expect(headers['authorization']).to.be.a('string')
            expect(headers['authorization']).to.match(/^AWS4-HMAC-SHA256 /)
            // Region derived from the tenant URL host; service name is `transform`.
            expect(headers['authorization']).to.contain('/ap-northeast-2/transform/aws4_request')
            expect(headers['x-amz-date']).to.be.a('string')
            // STS session token surfaced as the security-token header.
            expect(headers['x-amz-security-token']).to.equal(IAM_CREDENTIALS.sessionToken)
            // Origin matches the stored tenant URL, same as the bearer path.
            expect(headers['origin']).to.equal(TENANT_URL)
            // No bearer Authorization on the IAM path.
            expect(headers['Authorization']).to.equal(undefined)
        })

        it('omits the security-token header when there is no session token', async () => {
            serviceManager.getAuthType.returns('iam')
            serviceManager.getIamCredentials.returns({
                accessKeyId: IAM_CREDENTIALS.accessKeyId,
                secretAccessKey: IAM_CREDENTIALS.secretAccessKey,
            } as any)

            const headers = await runAuthMiddleware()

            expect(headers['authorization']).to.match(/^AWS4-HMAC-SHA256 /)
            expect(headers['x-amz-security-token']).to.equal(undefined)
        })
    })

    describe('no active auth', () => {
        it('throws before any request is made when auth type is null', async () => {
            serviceManager.getAuthType.returns(null)

            let threw = false
            try {
                await handler['addAuthToCommand']({ middlewareStack: { add: () => {} } })
            } catch (e) {
                threw = true
                expect(String(e)).to.match(/not signed in/i)
            }
            expect(threw, 'addAuthToCommand should reject when not signed in').to.equal(true)
        })
    })
})
