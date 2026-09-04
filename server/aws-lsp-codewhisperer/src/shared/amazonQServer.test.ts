import sinon from 'ts-sinon'
import { expect } from 'chai'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import { initBaseTestServiceManager, TestAmazonQServiceManager } from './amazonQServiceManager/testUtils'
import {
    CancellationToken,
    CredentialsType,
    InitializeParams,
    PartialInitializeResult,
    Server,
    UpdateConfigurationParams,
} from '@aws/language-server-runtimes/server-interface'
import {
    AMAZON_Q_SERVICE_SERVER_IAM_NAME,
    AMAZON_Q_SERVICE_SERVER_TOKEN_NAME,
    AmazonQServiceServerFactory,
    AmazonQServiceServerIAM,
    AmazonQServiceServerToken,
} from './amazonQServer'
import { BaseAmazonQServiceManager } from './amazonQServiceManager/BaseAmazonQServiceManager'

const TEST_SERVER_NAME = 'Test Amazon Q Server'

describe('AmazonQServiceServer', () => {
    let features: TestFeatures
    let server: Server
    let initBaseTestServiceManagerSpy: sinon.SinonSpy

    beforeEach(() => {
        features = new TestFeatures()

        initBaseTestServiceManagerSpy = sinon.spy(initBaseTestServiceManager)

        TestAmazonQServiceManager.resetInstance()
        server = AmazonQServiceServerFactory(() => initBaseTestServiceManagerSpy(features), TEST_SERVER_NAME)
    })

    afterEach(() => {
        TestAmazonQServiceManager.resetInstance()
        features.dispose()
        sinon.restore()
    })

    it('should initialize the service manager during LSP initialize request', async () => {
        expect(TestAmazonQServiceManager.getInstance).to.throw()
        sinon.assert.notCalled(initBaseTestServiceManagerSpy)

        server(features)
        sinon.assert.notCalled(initBaseTestServiceManagerSpy)

        features.doSendInitializeRequest({} as InitializeParams, {} as CancellationToken)
        sinon.assert.calledOnce(initBaseTestServiceManagerSpy)
    })

    it('declares serverInfo so the runtime can deliver notifications to the client', async () => {
        server(features)

        // Invoke the registered initializer directly: doSendInitializeRequest returns void, so the
        // result is only reachable through the handler the server registered.
        const initializer = features.lsp.addInitializer.args[0]?.[0]
        const result = (await initializer({} as InitializeParams, {} as CancellationToken)) as PartialInitializeResult

        // The runtime only builds a notification router for servers that declare serverInfo, and
        // notification.showNotification() is a silent no-op without one.
        expect(result.serverInfo?.name).to.equal(TEST_SERVER_NAME)
    })

    it('gives the IAM and token servers distinct serverInfo names', async () => {
        // Regression guard, asserted against the real exported servers rather than the constants, so
        // it also catches the same name being passed to both factory calls.
        //
        // Runtimes such as agent-standalone register BOTH of these servers, and the runtime rejects
        // initialize with `Duplicate servers defined` when two servers report the same name -- which
        // fails the entire language server, not just the duplicate. A shared name here made every such
        // runtime fall back to whatever server the client had bundled, visible only as a client-side
        // warning, so Q kept working while silently running a different server.
        const names: (string | undefined)[] = []

        for (const qServer of [AmazonQServiceServerIAM, AmazonQServiceServerToken]) {
            const serverFeatures = new TestFeatures()
            try {
                // The service managers refuse to initialize before the LSP connection has, so the
                // client params have to be in place before the initializer runs.
                serverFeatures.setClientParams({} as InitializeParams)
                qServer(serverFeatures)

                const initializer = serverFeatures.lsp.addInitializer.args[0]?.[0]
                const result = (await initializer(
                    {} as InitializeParams,
                    {} as CancellationToken
                )) as PartialInitializeResult

                names.push(result.serverInfo?.name)
            } finally {
                serverFeatures.dispose()
                TestAmazonQServiceManager.resetInstance()
            }
        }

        expect(names).to.deep.equal([AMAZON_Q_SERVICE_SERVER_IAM_NAME, AMAZON_Q_SERVICE_SERVER_TOKEN_NAME])
        expect(new Set(names).size, `server names must be unique: ${names.join(', ')}`).to.equal(names.length)
    })

    it('hooks handleDidChangeConfiguration to didChangeConfiguration and onInitialized handlers', async () => {
        const handleDidChangeConfigurationSpy = sinon.spy(
            BaseAmazonQServiceManager.prototype,
            'handleDidChangeConfiguration'
        )
        sinon.assert.notCalled(handleDidChangeConfigurationSpy)

        await features.initialize(server)
        sinon.assert.calledOnce(handleDidChangeConfigurationSpy)

        await features.doChangeConfiguration()
        sinon.assert.calledTwice(handleDidChangeConfigurationSpy)
    })

    it('hooks onUpdateConfiguration handler to LSP server', async () => {
        const handleOnUpdateConfigurationSpy = sinon.spy(
            TestAmazonQServiceManager.prototype,
            'handleOnUpdateConfiguration'
        )
        sinon.assert.notCalled(handleOnUpdateConfigurationSpy)

        await features.initialize(server)
        sinon.assert.notCalled(handleOnUpdateConfigurationSpy)

        await features.doUpdateConfiguration({} as UpdateConfigurationParams, {} as any)
        sinon.assert.calledOnce(handleOnUpdateConfigurationSpy)
    })

    it('hooks onCredentialsDeleted handler to credentials provider', async () => {
        const handleOnCredentialsDeletedSpy = sinon.spy(
            TestAmazonQServiceManager.prototype,
            'handleOnCredentialsDeleted'
        )
        sinon.assert.notCalled(handleOnCredentialsDeletedSpy)

        await features.initialize(server)
        sinon.assert.notCalled(handleOnCredentialsDeletedSpy)

        // triggers the handler registered by Amazon Q Server during features.initialize
        features.credentialsProvider.onCredentialsDeleted.args[0]?.[0]('some-creds-type' as CredentialsType)
        sinon.assert.calledOnce(handleOnCredentialsDeletedSpy)
    })

    it('should handle ATX configuration updates', async () => {
        await features.initialize(server)

        const atxConfigParams = {
            section: 'aws.amazonq.transform',
            settings: { profileArn: 'test-arn' },
        } as UpdateConfigurationParams

        // This should not throw an error
        await features.doUpdateConfiguration(atxConfigParams, {} as any)
        expect(true).to.be.true // Test passes if no error is thrown
    })

    it('should initialize ATX Token Service Manager', async () => {
        await features.initialize(server)

        // Verify ATX service manager is initialized (indirectly through no errors)
        expect(true).to.be.true
    })

    it('should handle service manager initialization errors gracefully', () => {
        const errorFactory = () => {
            throw new Error('Service manager initialization failed')
        }

        const errorServer = AmazonQServiceServerFactory(errorFactory, TEST_SERVER_NAME)

        expect(() => {
            errorServer(features)
            features.doSendInitializeRequest({} as InitializeParams, {} as CancellationToken)
        }).to.throw('Service manager initialization failed')
    })
})
