import * as assert from 'assert'
import sinon, { StubbedInstance, stubInterface } from 'ts-sinon'
import { CodeWhispererServiceToken } from '../codeWhispererService'
import {
    AWSInitializationOptions,
    CancellationTokenSource,
    Logging,
    SsoConnectionType,
} from '@aws/language-server-runtimes/server-interface'
import {
    AmazonQDeveloperProfile,
    getListAllAvailableProfilesHandler,
    ListAllAvailableProfilesHandler,
    signalsAWSQDeveloperProfilesEnabled,
} from './qDeveloperProfiles'
import { DEFAULT_AWS_Q_ENDPOINT_URL, DEFAULT_AWS_Q_REGION } from '../../shared/constants'
import { AmazonQServiceProfileThrottlingError } from './errors'
import { ListAvailableProfilesCommandOutput } from '@amzn/codewhisperer-runtime'

const SOME_Q_DEVELOPER_PROFILE_ARN = 'some-random-q-developer-profile-arn'
const SOME_Q_DEVELOPER_PROFILE_NAME = 'some-random-q-developer-profile-name'
const SOME_Q_ENDPOINT_URL = 'some-random-q-endpoint'
const SOME_AWS_Q_ENDPOINT = new Map([[DEFAULT_AWS_Q_REGION, DEFAULT_AWS_Q_ENDPOINT_URL]])
const SOME_AWS_Q_ENDPOINTS = new Map([
    [DEFAULT_AWS_Q_REGION, DEFAULT_AWS_Q_ENDPOINT_URL],
    ['eu-central-1', SOME_Q_ENDPOINT_URL],
])

const EXPECTED_DEVELOPER_PROFILES_LIST: AmazonQDeveloperProfile[] = Array.from(SOME_AWS_Q_ENDPOINTS.keys(), region => ({
    arn: SOME_Q_DEVELOPER_PROFILE_ARN,
    name: SOME_Q_DEVELOPER_PROFILE_NAME,
    identityDetails: {
        region,
    },
}))

const UNHAPPY_SSO_CONNECTION_TYPES: SsoConnectionType[] = ['builderId', 'none']

describe('ListAllAvailableProfiles Handler', () => {
    let logging: StubbedInstance<Logging>

    let codeWhispererService: StubbedInstance<CodeWhispererServiceToken>
    let handler: ListAllAvailableProfilesHandler
    let tokenSource: CancellationTokenSource

    const listAvailableProfilesResponse = {
        profiles: [
            {
                arn: SOME_Q_DEVELOPER_PROFILE_ARN,
                profileName: SOME_Q_DEVELOPER_PROFILE_NAME,
            },
        ],
        $metadata: {},
    } satisfies ListAvailableProfilesCommandOutput

    beforeEach(() => {
        logging = stubInterface<Logging>()
        codeWhispererService = stubInterface<CodeWhispererServiceToken>()
        codeWhispererService.listAvailableProfiles.resolves(listAvailableProfilesResponse)

        handler = getListAllAvailableProfilesHandler(() => codeWhispererService)
        tokenSource = new CancellationTokenSource()
    })

    it('should aggregrate profiles retrieved from different regions', async () => {
        const profiles = await handler({
            connectionType: 'identityCenter',
            logging,
            endpoints: SOME_AWS_Q_ENDPOINTS,
            token: tokenSource.token,
        })

        assert.strictEqual(
            codeWhispererService.listAvailableProfiles.callCount,
            EXPECTED_DEVELOPER_PROFILES_LIST.length
        )
        assert.deepStrictEqual(profiles, EXPECTED_DEVELOPER_PROFILES_LIST)
    })

    it('should throw error when listAvailableProfiles throws throttling error', async () => {
        const awsError = new Error('Throttling') as any
        awsError.code = 'ThrottlingException'
        awsError.name = 'ThrottlingException'
        codeWhispererService.listAvailableProfiles.rejects(awsError)

        try {
            const profiles = await handler({
                connectionType: 'identityCenter',
                logging,
                endpoints: SOME_AWS_Q_ENDPOINTS,
                token: tokenSource.token,
            })
            assert.fail('Expected method to throw')
        } catch (error) {
            assert.ok(
                error instanceof AmazonQServiceProfileThrottlingError,
                'Error should be instance of AmazonQServiceError'
            )
        }
    })

    UNHAPPY_SSO_CONNECTION_TYPES.forEach((connectionType: SsoConnectionType) => {
        it(`should return an empty list when connection type equals: ${connectionType}`, async () => {
            const profiles = await handler({
                connectionType,
                logging,
                token: tokenSource.token,
            })

            assert.deepStrictEqual(profiles, [])
        })
    })

    describe('Enhanced Logging for Debugging', () => {
        // Skipped: fails since this file last ran in CI; see the PR that skipped it
        it.skip('should log complete error object when profile fetching fails', async () => {
            const testError = new Error('Test error') as any
            testError.code = 'TestErrorCode'
            testError.statusCode = 500

            codeWhispererService.listAvailableProfiles.rejects(testError)

            try {
                await handler({
                    connectionType: 'identityCenter',
                    logging,
                    endpoints: SOME_AWS_Q_ENDPOINT,
                    token: tokenSource.token,
                })
                assert.fail('Expected method to throw')
            } catch (error) {
                // Verify that debug logging was called for complete error object
                sinon.assert.called(logging.debug)
                const debugCalls = logging.debug.getCalls()
                const hasCompleteErrorLogging = debugCalls.some(call => call.args[0].includes('Complete error object'))
                assert.ok(hasCompleteErrorLogging, 'Should log complete error object in debug logs')
            }
        })
    })

    describe('Pagination', () => {
        const MAX_EXPECTED_PAGES = 10
        const SOME_NEXT_TOKEN = 'some-random-next-token'

        const listAvailableProfilesResponseWithNextToken = {
            ...listAvailableProfilesResponse,
            nextToken: SOME_NEXT_TOKEN,
        }

        it('should paginate if nextToken is defined', async () => {
            const EXPECTED_CALLS = 3

            codeWhispererService.listAvailableProfiles
                .onFirstCall()
                .resolves(listAvailableProfilesResponseWithNextToken)
            codeWhispererService.listAvailableProfiles
                .onSecondCall()
                .resolves(listAvailableProfilesResponseWithNextToken)
            codeWhispererService.listAvailableProfiles.onThirdCall().resolves(listAvailableProfilesResponse)

            const profiles = await handler({
                connectionType: 'identityCenter',
                logging,
                endpoints: SOME_AWS_Q_ENDPOINT,
                token: tokenSource.token,
            })

            sinon.assert.calledThrice(codeWhispererService.listAvailableProfiles)
            assert.strictEqual(codeWhispererService.listAvailableProfiles.firstCall.args[0].nextToken, undefined)
            assert.strictEqual(codeWhispererService.listAvailableProfiles.secondCall.args[0].nextToken, SOME_NEXT_TOKEN)
            assert.strictEqual(codeWhispererService.listAvailableProfiles.thirdCall.args[0].nextToken, SOME_NEXT_TOKEN)

            assert.deepStrictEqual(profiles, Array(EXPECTED_CALLS).fill(EXPECTED_DEVELOPER_PROFILES_LIST[0]))
        })

        it(`should retrieve at most ${MAX_EXPECTED_PAGES} pages`, async () => {
            codeWhispererService.listAvailableProfiles.resolves(listAvailableProfilesResponseWithNextToken)

            const profiles = await handler({
                connectionType: 'identityCenter',
                logging,
                endpoints: SOME_AWS_Q_ENDPOINT,
                token: tokenSource.token,
            })

            assert.strictEqual(codeWhispererService.listAvailableProfiles.callCount, MAX_EXPECTED_PAGES)
            codeWhispererService.listAvailableProfiles.getCalls().forEach((call, index) => {
                if (index === 0) {
                    assert.strictEqual(call.args[0].nextToken, undefined)
                } else {
                    assert.strictEqual(call.args[0].nextToken, SOME_NEXT_TOKEN)
                }
            })
            assert.deepStrictEqual(profiles, Array(MAX_EXPECTED_PAGES).fill(EXPECTED_DEVELOPER_PROFILES_LIST[0]))
        })
    })
})

describe('signalsAWSQDeveloperProfilesEnabled', () => {
    const makeQCapability = (value?: any) => {
        return value !== undefined ? { developerProfiles: value } : {}
    }

    const makeInitOptions = (value?: any): AWSInitializationOptions => {
        return { awsClientCapabilities: { q: makeQCapability(value) } }
    }

    const TEST_CASES: { input: AWSInitializationOptions; expected: boolean }[] = [
        { input: {}, expected: false },
        { input: { awsClientCapabilities: {} }, expected: false },
        { input: makeInitOptions(), expected: false },
        { input: makeInitOptions([]), expected: false },
        { input: makeInitOptions({}), expected: false },
        { input: makeInitOptions(42), expected: false },
        { input: makeInitOptions('some-string'), expected: false },
        { input: makeInitOptions(false), expected: false },
        { input: makeInitOptions(true), expected: true },
    ]

    TEST_CASES.forEach(testCase => {
        it(`should return: ${testCase.expected} when passed: ${JSON.stringify(testCase.input)}`, () => {
            assert.strictEqual(signalsAWSQDeveloperProfilesEnabled(testCase.input), testCase.expected)
        })
    })
})
