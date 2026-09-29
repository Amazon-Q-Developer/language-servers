import * as assert from 'assert'
import * as sinon from 'sinon'
import { AtxTokenServiceManager } from '../../../shared/amazonQServiceManager/AtxTokenServiceManager'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import { CancellationToken, CredentialsType } from '@aws/language-server-runtimes/server-interface'

describe('AtxTokenServiceManager', () => {
    let features: TestFeatures
    let manager: AtxTokenServiceManager

    beforeEach(() => {
        features = new TestFeatures()
        AtxTokenServiceManager.resetInstance()
        manager = AtxTokenServiceManager.initInstance(features)
    })

    afterEach(() => {
        sinon.restore()
        AtxTokenServiceManager.resetInstance()
    })

    describe('initInstance', () => {
        it('creates new instance when none exists', () => {
            AtxTokenServiceManager.resetInstance()
            const instance = AtxTokenServiceManager.initInstance(features)
            assert(instance instanceof AtxTokenServiceManager)
        })

        it('returns existing instance when already initialized', () => {
            const firstInstance = AtxTokenServiceManager.initInstance(features)
            const secondInstance = AtxTokenServiceManager.initInstance(features)
            assert.strictEqual(firstInstance, secondInstance)
        })
    })

    describe('getInstance', () => {
        it('returns existing instance', () => {
            const instance = AtxTokenServiceManager.getInstance()
            assert.strictEqual(instance, manager)
        })

        it('throws error when no instance exists', () => {
            AtxTokenServiceManager.resetInstance()
            assert.throws(() => AtxTokenServiceManager.getInstance(), /not initialized/)
        })
    })

    describe('handleOnCredentialsDeleted', () => {
        it('clears all caches when credentials deleted', () => {
            const callback = sinon.stub()
            manager.registerCacheCallback(callback)

            manager.handleOnCredentialsDeleted('bearer' as CredentialsType)

            assert(callback.calledOnce)
        })
    })

    describe('registerCacheCallback', () => {
        it('registers callback and calls it on cache clear', () => {
            const callback = sinon.stub()
            manager.registerCacheCallback(callback)

            manager['clearAllCaches']()

            assert(callback.calledOnce)
        })
    })

    describe('IAM credentials support', () => {
        const iamCredentials = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret', sessionToken: 'token' }
        const tenantUrl = 'https://tenant.transform.ap-northeast-2.on.aws'

        // The runtime's ATX-scoped provider is bearer-only and throws on 'iam'; IAM creds live in
        // the main credentialsProvider. These helpers mirror that split.
        const stubIam = (present: boolean) => {
            features.credentialsProvider.hasCredentials.callsFake((type: CredentialsType) => type === 'iam' && present)
            features.credentialsProvider.getCredentials.callsFake((type: CredentialsType) =>
                type === 'iam' && present ? (iamCredentials as any) : undefined
            )
        }
        const stubBearer = (present: boolean) => {
            features.runtime.getAtxCredentialsProvider.returns({
                hasCredentials: (type: string) => type === 'bearer' && present,
                getCredentials: () => (present ? { token: 'bearer-token' } : undefined),
            } as any)
        }
        const setTenantUrl = async (url: string) =>
            manager.handleOnUpdateConfiguration(
                { section: 'aws.atx', settings: { applicationUrl: url } } as any,
                {} as CancellationToken
            )

        it('getIamCredentials returns the credentials stored in the iam slot', () => {
            stubIam(true)
            assert.deepStrictEqual(manager.getIamCredentials(), iamCredentials)
        })

        it('getIamCredentials throws when no IAM credentials are present', () => {
            stubIam(false)
            assert.throws(() => manager.getIamCredentials(), /No IAM credentials/)
        })

        it('hasValidCredentials is true when only IAM credentials are present', () => {
            stubIam(true)
            stubBearer(false)
            assert.strictEqual(manager.hasValidCredentials(), true)
        })

        it('stores the tenant URL from aws.atx configuration with the trailing slash stripped', async () => {
            await setTenantUrl(`${tenantUrl}/`)
            assert.strictEqual(manager.getActiveApplicationUrl(), tenantUrl)
        })

        it('getAuthType is iam only once both IAM credentials and the tenant URL are present', async () => {
            stubIam(true)
            stubBearer(false)
            assert.strictEqual(manager.getAuthType(), null)

            await setTenantUrl(tenantUrl)
            assert.strictEqual(manager.getAuthType(), 'iam')
        })

        it('getAuthType is bearer when only a bearer token is present', () => {
            stubIam(false)
            stubBearer(true)
            assert.strictEqual(manager.getAuthType(), 'bearer')
        })

        it('getAuthType prefers iam over bearer when both are present and the tenant URL is set', async () => {
            stubIam(true)
            stubBearer(true)
            await setTenantUrl(tenantUrl)
            assert.strictEqual(manager.getAuthType(), 'iam')
        })

        it('getAuthType is null when no credentials are present', () => {
            stubIam(false)
            stubBearer(false)
            assert.strictEqual(manager.getAuthType(), null)
        })
    })
})
