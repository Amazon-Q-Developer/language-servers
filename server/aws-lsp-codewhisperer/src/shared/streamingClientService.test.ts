import { StreamingClientServiceToken, StreamingClientServiceIAM } from './streamingClientService'
import sinon from 'ts-sinon'
import { expect } from 'chai'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import { BearerCredentials } from '@aws/language-server-runtimes/server-interface'
import { DEFAULT_AWS_Q_ENDPOINT_URL, DEFAULT_AWS_Q_REGION } from './constants'
import {
    CodeWhispererStreaming,
    Origin,
    SendMessageCommandInput,
    SendMessageCommandOutput,
} from '@amzn/codewhisperer-streaming'
import { QDeveloperStreaming } from '@amzn/amazon-q-developer-streaming-client'
import { rejects } from 'assert'
import { initBaseTestServiceManager, TestAmazonQServiceManager } from './amazonQServiceManager/testUtils'
import { stubCodeWhispererService } from './testUtils'

const TIME_TO_ADVANCE_MS = 100

describe('StreamingClientServiceToken', () => {
    let streamingClientService: StreamingClientServiceToken
    let features: TestFeatures
    let clock: sinon.SinonFakeTimers
    let sendMessageStub: sinon.SinonStub
    let abortStub: sinon.SinonStub

    const MOCKED_TOKEN_ONE: BearerCredentials = { token: 'some-fake-token' }
    const MOCKED_TOKEN_TWO: BearerCredentials = { token: 'some-other-fake-token' }

    const MOCKED_SEND_MESSAGE_REQUEST: SendMessageCommandInput = {
        conversationState: {
            chatTriggerType: 'MANUAL',
            currentMessage: {
                userInputMessage: {
                    content: 'some-content',
                },
            },
        },
    }

    const MOCKED_SEND_MESSAGE_RESPONSE: SendMessageCommandOutput = {
        $metadata: {},
        sendMessageResponse: undefined,
    }

    beforeEach(() => {
        clock = sinon.useFakeTimers({ now: new Date() })
        features = new TestFeatures()

        features.credentialsProvider.hasCredentials.withArgs('bearer').returns(true)
        features.credentialsProvider.getCredentials.withArgs('bearer').returns(MOCKED_TOKEN_ONE)

        sendMessageStub = sinon
            .stub(CodeWhispererStreaming.prototype, 'sendMessage')
            .callsFake(() => Promise.resolve(MOCKED_SEND_MESSAGE_RESPONSE))
        streamingClientService = new StreamingClientServiceToken(
            features.credentialsProvider,
            features.sdkInitializator,
            features.logging,
            DEFAULT_AWS_Q_REGION,
            DEFAULT_AWS_Q_ENDPOINT_URL,
            'some-user-agent'
        )

        abortStub = sinon.stub(AbortController.prototype, 'abort')
    })

    afterEach(() => {
        clock.restore()
        sinon.restore()
    })

    it('provides the lastest token present in the credentials provider', async () => {
        const tokenProvider = streamingClientService.client.config.token
        expect(tokenProvider).not.to.be.undefined

        const firstTokenPromise = (tokenProvider as any)()
        await clock.tickAsync(TIME_TO_ADVANCE_MS)

        const firstToken = await firstTokenPromise
        expect(firstToken.token).to.deep.equal(MOCKED_TOKEN_ONE.token)

        features.credentialsProvider.getCredentials.withArgs('bearer').returns(MOCKED_TOKEN_TWO)

        const secondTokenPromise = (tokenProvider as any)()
        await clock.tickAsync(TIME_TO_ADVANCE_MS)
        const secondToken = await secondTokenPromise

        expect(secondToken.token).to.deep.equal(MOCKED_TOKEN_TWO.token)
    })

    it('aborts in flight requests', async () => {
        streamingClientService.sendMessage(MOCKED_SEND_MESSAGE_REQUEST)
        streamingClientService.sendMessage(MOCKED_SEND_MESSAGE_REQUEST)

        streamingClientService.abortInflightRequests()

        sinon.assert.calledTwice(abortStub)
        expect(streamingClientService['inflightRequests'].size).to.eq(0)
    })

    it('attaches known profileArn to request', async () => {
        const mockedProfileArn = 'some-profile-arn'
        streamingClientService.profileArn = mockedProfileArn
        const expectedRequest: SendMessageCommandInput = {
            ...MOCKED_SEND_MESSAGE_REQUEST,
            profileArn: mockedProfileArn,
        }
        const promise = streamingClientService.sendMessage(MOCKED_SEND_MESSAGE_REQUEST)

        await clock.tickAsync(TIME_TO_ADVANCE_MS)
        await promise

        sinon.assert.calledOnce(sendMessageStub)
        sinon.assert.match(sendMessageStub.firstCall.firstArg, expectedRequest)
    })

    it('creates client with shareCodeWhispererContentWithAWS parameter', () => {
        const streamingClientServiceWithOptout = new StreamingClientServiceToken(
            features.credentialsProvider,
            features.sdkInitializator,
            features.logging,
            DEFAULT_AWS_Q_REGION,
            DEFAULT_AWS_Q_ENDPOINT_URL,
            'some-user-agent'
        )
        streamingClientServiceWithOptout.shareCodeWhispererContentWithAWS = false

        expect(streamingClientServiceWithOptout['shareCodeWhispererContentWithAWS']).to.equal(false)
    })

    it('creates client without shareCodeWhispererContentWithAWS parameter', () => {
        const streamingClientServiceDefault = new StreamingClientServiceToken(
            features.credentialsProvider,
            features.sdkInitializator,
            features.logging,
            DEFAULT_AWS_Q_REGION,
            DEFAULT_AWS_Q_ENDPOINT_URL,
            'some-user-agent'
        )

        expect(streamingClientServiceDefault['shareCodeWhispererContentWithAWS']).to.be.undefined
    })

    describe('access-blocked observer', () => {
        it('registers exactly one named middleware on the initialize step', () => {
            // Guards the wiring rather than the callback: the harness stubs
            // CodeWhispererStreaming.prototype.sendMessage, which bypasses the middleware stack, so a
            // behavioural test here would pass without the middleware existing at all.
            //
            // The name matters. Without it a second registration stacks another observer instead of
            // replacing the first, which would report the same block twice.
            const registered = streamingClientService.client.middlewareStack
                .identify()
                .filter(entry => entry.includes('detectQDevPluginAccessBlocked'))

            expect(registered).to.have.lengthOf(1)
            expect(registered[0]).to.contain('initialize')
        })

        it('exposes a settable observer for the service manager to assign', () => {
            // Assigned after construction, so the middleware has to read it at call time. If this
            // became readonly or were dropped, chat-time blocks would go unobserved.
            const observer = () => {}
            streamingClientService.onAccessBlocked = observer

            expect(streamingClientService.onAccessBlocked).to.equal(observer)
        })
    })

    describe('generateAssistantResponse', () => {
        const MOCKED_GENERATE_RESPONSE_REQUEST = {
            conversationState: {
                chatTriggerType: 'MANUAL' as const,
                currentMessage: {
                    userInputMessage: {
                        content: 'some-content',
                    },
                },
            },
        }

        const MOCKED_GENERATE_RESPONSE_RESPONSE = {
            generateAssistantResponse: {
                conversationId: 'some-conversation-id',
                generateAssistantResponseResponse: undefined,
            },
        }

        it('calls generate assistant response with correct parameters', async () => {
            const generateAssistantResponseStub = sinon
                .stub(CodeWhispererStreaming.prototype, 'generateAssistantResponse')
                .callsFake(() => Promise.resolve(MOCKED_GENERATE_RESPONSE_RESPONSE))

            const promise = streamingClientService.generateAssistantResponse(MOCKED_GENERATE_RESPONSE_REQUEST)

            await clock.tickAsync(TIME_TO_ADVANCE_MS)
            await promise

            sinon.assert.calledOnce(generateAssistantResponseStub)
            sinon.assert.match(generateAssistantResponseStub.firstCall.firstArg, MOCKED_GENERATE_RESPONSE_REQUEST)
        })

        it('attaches known profileArn to generate assistant response request', async () => {
            const mockedProfileArn = 'some-profile-arn'
            const generateAssistantResponseStub = sinon
                .stub(CodeWhispererStreaming.prototype, 'generateAssistantResponse')
                .callsFake(() => Promise.resolve(MOCKED_GENERATE_RESPONSE_RESPONSE))

            streamingClientService.profileArn = mockedProfileArn
            const expectedRequest = {
                ...MOCKED_GENERATE_RESPONSE_REQUEST,
                profileArn: mockedProfileArn,
            }
            const promise = streamingClientService.generateAssistantResponse(MOCKED_GENERATE_RESPONSE_REQUEST)

            await clock.tickAsync(TIME_TO_ADVANCE_MS)
            await promise

            sinon.assert.calledOnce(generateAssistantResponseStub)
            sinon.assert.match(generateAssistantResponseStub.firstCall.firstArg, expectedRequest)
        })

        it('aborts in flight generate assistant response requests', async () => {
            streamingClientService.generateAssistantResponse(MOCKED_GENERATE_RESPONSE_REQUEST)
            streamingClientService.generateAssistantResponse(MOCKED_GENERATE_RESPONSE_REQUEST)

            streamingClientService.abortInflightRequests()

            sinon.assert.calledTwice(abortStub)
            expect(streamingClientService['inflightRequests'].size).to.eq(0)
        })

        it('aborts in flight generate assistant response requests with explicit abort controller', async () => {
            const controller1 = new AbortController()
            const controller2 = new AbortController()

            streamingClientService.generateAssistantResponse(MOCKED_GENERATE_RESPONSE_REQUEST, controller1)
            streamingClientService.generateAssistantResponse(MOCKED_GENERATE_RESPONSE_REQUEST, controller2)

            streamingClientService.abortInflightRequests()

            sinon.assert.calledTwice(abortStub)
            expect(streamingClientService['inflightRequests'].size).to.eq(0)
        })
    })
})

describe('StreamingClientServiceIAM', () => {
    let streamingClientServiceIAM: StreamingClientServiceIAM
    let features: TestFeatures
    let clock: sinon.SinonFakeTimers
    let sendMessageStub: sinon.SinonStub
    let abortStub: sinon.SinonStub

    const MOCKED_IAM_CREDENTIALS = {
        accessKeyId: 'mock-access-key',
        secretAccessKey: 'mock-secret-key',
        sessionToken: 'mock-session-token',
    }

    const MOCKED_SEND_MESSAGE_REQUEST: SendMessageCommandInput = {
        conversationState: {
            chatTriggerType: 'MANUAL',
            currentMessage: {
                userInputMessage: {
                    content: 'some-content',
                },
            },
        },
    }

    const MOCKED_SEND_MESSAGE_RESPONSE: SendMessageCommandOutput = {
        $metadata: {},
        sendMessageResponse: undefined,
    }

    beforeEach(() => {
        clock = sinon.useFakeTimers({ now: new Date() })
        features = new TestFeatures()

        features.credentialsProvider.hasCredentials.withArgs('iam').returns(true)
        features.credentialsProvider.getCredentials.withArgs('iam').returns(MOCKED_IAM_CREDENTIALS)

        sendMessageStub = sinon
            .stub(QDeveloperStreaming.prototype, 'sendMessage')
            .callsFake(() => Promise.resolve(MOCKED_SEND_MESSAGE_RESPONSE))

        streamingClientServiceIAM = new StreamingClientServiceIAM(
            features.credentialsProvider,
            features.sdkInitializator,
            features.logging,
            DEFAULT_AWS_Q_REGION,
            DEFAULT_AWS_Q_ENDPOINT_URL
        )

        abortStub = sinon.stub(AbortController.prototype, 'abort')
    })

    afterEach(() => {
        clock.restore()
        sinon.restore()
    })

    it('initializes with IAM credentials', () => {
        expect(streamingClientServiceIAM.client).to.not.be.undefined
        expect(streamingClientServiceIAM.client.config.credentials).to.not.be.undefined
    })

    it('sends message with correct parameters', async () => {
        const promise = streamingClientServiceIAM.sendMessage(MOCKED_SEND_MESSAGE_REQUEST)

        await clock.tickAsync(TIME_TO_ADVANCE_MS)
        await promise

        sinon.assert.calledOnce(sendMessageStub)
        sinon.assert.match(sendMessageStub.firstCall.firstArg, MOCKED_SEND_MESSAGE_REQUEST)
    })

    it('aborts in flight requests', async () => {
        streamingClientServiceIAM.sendMessage(MOCKED_SEND_MESSAGE_REQUEST)
        streamingClientServiceIAM.sendMessage(MOCKED_SEND_MESSAGE_REQUEST)

        streamingClientServiceIAM.abortInflightRequests()

        sinon.assert.calledTwice(abortStub)
        expect(streamingClientServiceIAM['inflightRequests'].size).to.eq(0)
    })

    it('uses expiration from credentials when available', async () => {
        // Get the credential provider function from the client config
        const credentialProvider = streamingClientServiceIAM.client.config.credentials
        expect(credentialProvider).to.not.be.undefined

        // Reset call count on the stub
        features.credentialsProvider.getCredentials.resetHistory()

        // Set up credentials with expiration
        const futureDate = new Date(Date.now() + 3600000) // 1 hour in the future
        const CREDENTIALS_WITH_EXPIRY = {
            ...MOCKED_IAM_CREDENTIALS,
            expiration: futureDate,
        }
        features.credentialsProvider.getCredentials.withArgs('iam').returns(CREDENTIALS_WITH_EXPIRY)

        // Call the credential provider
        const credentialsPromise = (credentialProvider as any)()
        await clock.tickAsync(TIME_TO_ADVANCE_MS)
        const credentials = await credentialsPromise

        // Verify expiration is set to the expiration from credentials
        expect(credentials.expiration).to.be.instanceOf(Date)
        expect(credentials.expiration.getTime()).to.equal(futureDate.getTime())
    })

    it('forces refresh when expiration is not available in credentials', async () => {
        // Get the credential provider function from the client config
        const credentialProvider = streamingClientServiceIAM.client.config.credentials
        expect(credentialProvider).to.not.be.undefined

        // Reset call count on the stub
        features.credentialsProvider.getCredentials.resetHistory()

        // Set up credentials without expiration
        features.credentialsProvider.getCredentials.withArgs('iam').returns(MOCKED_IAM_CREDENTIALS)

        // Call the credential provider
        const credentialsPromise = (credentialProvider as any)()
        await clock.tickAsync(TIME_TO_ADVANCE_MS)
        const credentials = await credentialsPromise

        // Verify expiration is set to current date to force refresh when not provided in credentials
        expect(credentials.expiration).to.be.instanceOf(Date)
        expect(credentials.expiration.getTime()).to.be.closeTo(Date.now(), 1000)
    })

    it('creates client with shareCodeWhispererContentWithAWS parameter', () => {
        const streamingClientServiceWithOptout = new StreamingClientServiceIAM(
            features.credentialsProvider,
            features.sdkInitializator,
            features.logging,
            DEFAULT_AWS_Q_REGION,
            DEFAULT_AWS_Q_ENDPOINT_URL
        )
        streamingClientServiceWithOptout.shareCodeWhispererContentWithAWS = false

        expect(streamingClientServiceWithOptout['shareCodeWhispererContentWithAWS']).to.equal(false)
    })

    it('creates client without shareCodeWhispererContentWithAWS parameter', () => {
        const streamingClientServiceDefault = new StreamingClientServiceIAM(
            features.credentialsProvider,
            features.sdkInitializator,
            features.logging,
            DEFAULT_AWS_Q_REGION,
            DEFAULT_AWS_Q_ENDPOINT_URL
        )

        expect(streamingClientServiceDefault['shareCodeWhispererContentWithAWS']).to.be.undefined
    })
})

describe('BaseAmazonQServiceManager streaming client cache updates', () => {
    let features: TestFeatures
    let serviceManager: TestAmazonQServiceManager
    let streamingClientMock: StreamingClientServiceToken

    beforeEach(() => {
        features = new TestFeatures()
        const serviceStub = stubCodeWhispererService()

        streamingClientMock = Object.assign(sinon.createStubInstance(StreamingClientServiceToken), {
            region: DEFAULT_AWS_Q_REGION,
            endpoint: DEFAULT_AWS_Q_ENDPOINT_URL,
        }) as unknown as StreamingClientServiceToken
        serviceManager = initBaseTestServiceManager(features, serviceStub, streamingClientMock)
    })

    afterEach(() => {
        sinon.restore()
        TestAmazonQServiceManager.resetInstance()
    })

    it('updates shareCodeWhispererContentWithAWS on cached streaming client when configuration changes', async () => {
        // Set initial configuration
        features.lsp.workspace.getConfiguration.resolves({ shareCodeWhispererContentWithAWS: true })

        await serviceManager.handleDidChangeConfiguration()

        expect(streamingClientMock.shareCodeWhispererContentWithAWS).to.equal(true)

        // Change configuration
        features.lsp.workspace.getConfiguration.resolves({ shareCodeWhispererContentWithAWS: false })

        await serviceManager.handleDidChangeConfiguration()

        expect(streamingClientMock.shareCodeWhispererContentWithAWS).to.equal(false)
    })

    it('does not update streaming client when no cached client exists', async () => {
        TestAmazonQServiceManager.resetInstance()
        const serviceManagerWithoutClient = initBaseTestServiceManager(features, stubCodeWhispererService())

        features.lsp.workspace.getConfiguration.resolves({ shareCodeWhispererContentWithAWS: false })

        // Should not throw when no cached streaming client exists
        await serviceManagerWithoutClient.handleDidChangeConfiguration()

        expect(serviceManagerWithoutClient['cachedStreamingClient']).to.be.undefined
    })
})
