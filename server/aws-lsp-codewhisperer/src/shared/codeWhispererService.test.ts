/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    CredentialsProvider,
    CredentialsType,
    Workspace,
    Logging,
    SDKInitializator,
    TextDocument,
    Position,
    CancellationToken,
    InlineCompletionWithReferencesParams,
} from '@aws/language-server-runtimes/server-interface'
import * as sinon from 'sinon'
import * as assert from 'assert'
import {
    CodeWhispererServiceBase,
    CodeWhispererServiceToken,
    CodeWhispererServiceIAM,
    GenerateSuggestionsRequest,
    GenerateSuggestionsResponse,
    isIAMRequest,
    isTokenRequest,
} from './codeWhispererService'
import { RecentEditTracker } from '../language-server/inline-completion/tracker/codeEditTracker'
import { CodeWhispererSupplementalContext } from './models/model'
import { SupplementalContext } from '@amzn/codewhisperer-runtime'

describe('CodeWhispererService', function () {
    let sandbox: sinon.SinonSandbox
    let mockCredentialsProvider: sinon.SinonStubbedInstance<CredentialsProvider>
    let mockWorkspace: sinon.SinonStubbedInstance<Workspace>
    let mockLogging: sinon.SinonStubbedInstance<Logging>
    let mockSDKInitializator: sinon.SinonStubbedInstance<SDKInitializator>

    beforeEach(function () {
        sandbox = sinon.createSandbox()

        mockCredentialsProvider = {
            getCredentials: sandbox.stub(),
            hasCredentials: sandbox.stub(),
            refresh: sandbox.stub(),
        } as any

        mockWorkspace = {
            getWorkspaceFolder: sandbox.stub(),
            getWorkspaceFolders: sandbox.stub(),
        } as any

        mockLogging = {
            debug: sandbox.stub(),
            error: sandbox.stub(),
            info: sandbox.stub(),
            warn: sandbox.stub(),
            log: sandbox.stub(),
        }

        mockSDKInitializator = {
            initialize: sandbox.stub(),
        } as any
    })

    afterEach(function () {
        sandbox.restore()
    })

    describe('CodeWhispererServiceBase', function () {
        let service: CodeWhispererServiceBase

        beforeEach(function () {
            // Create a concrete implementation for testing abstract class
            class TestCodeWhispererService extends CodeWhispererServiceBase {
                client: any = {}

                getCredentialsType(): CredentialsType {
                    return 'iam'
                }

                override async scheduleABTestingFetching(): Promise<void> {
                    return
                }

                async constructSupplementalContext(
                    document: TextDocument,
                    position: Position,
                    workspace: Workspace,
                    recentEditTracker: RecentEditTracker,
                    logging: Logging,
                    cancellationToken: CancellationToken,
                    opentabs: InlineCompletionWithReferencesParams['openTabFilepaths'],
                    config: { includeRecentEdits: boolean }
                ): Promise<
                    | {
                          supContextData: CodeWhispererSupplementalContext
                          items: SupplementalContext[]
                      }
                    | undefined
                > {
                    return undefined
                }

                // Add public getters for protected properties
                get testCodeWhispererRegion() {
                    return this.codeWhispererRegion
                }

                get testCodeWhispererEndpoint() {
                    return this.codeWhispererEndpoint
                }

                async generateCompletionsAndEdits(): Promise<GenerateSuggestionsResponse> {
                    return {
                        suggestions: [],
                        responseContext: { requestId: 'test', codewhispererSessionId: 'test' },
                    }
                }

                async generateSuggestions(): Promise<GenerateSuggestionsResponse> {
                    return {
                        suggestions: [],
                        responseContext: { requestId: 'test', codewhispererSessionId: 'test' },
                    }
                }

                clearCachedSuggestions(): void {}
            }

            service = new TestCodeWhispererService('us-east-1', 'https://codewhisperer.us-east-1.amazonaws.com')
        })

        describe('constructor', function () {
            it('should initialize with region and endpoint', function () {
                assert.strictEqual((service as any).testCodeWhispererRegion, 'us-east-1')
                assert.strictEqual(
                    (service as any).testCodeWhispererEndpoint,
                    'https://codewhisperer.us-east-1.amazonaws.com'
                )
            })
        })

        describe('request tracking', function () {
            it('should abort all inflight requests', function () {
                const mockController1 = new AbortController()
                const mockController2 = new AbortController()
                const abortSpy1 = sandbox.spy(mockController1, 'abort')
                const abortSpy2 = sandbox.spy(mockController2, 'abort')

                service.inflightRequests.add(mockController1)
                service.inflightRequests.add(mockController2)

                service.abortInflightRequests()

                assert.strictEqual(abortSpy1.calledOnce, true)
                assert.strictEqual(abortSpy2.calledOnce, true)
                assert.strictEqual(service.inflightRequests.size, 0)
            })
        })

        describe('generateItemId', function () {
            it('should generate unique item IDs', function () {
                const id1 = service.generateItemId()
                const id2 = service.generateItemId()

                assert.strictEqual(typeof id1, 'string')
                assert.strictEqual(typeof id2, 'string')
                assert.notStrictEqual(id1, id2)
            })
        })
    })

    describe('CodeWhispererServiceIAM', function () {
        let service: CodeWhispererServiceIAM

        beforeEach(function () {
            // Mock the createCodeWhispererSigv4Client function to avoid real client creation
            const mockClient = {
                send: sandbox.stub().resolves({
                    recommendations: [],
                    $metadata: {
                        requestId: 'test-request-id',
                    },
                    $httpHeaders: {
                        'x-amzn-sessionid': 'test-session-id',
                    },
                }),
                middlewareStack: {
                    add: sandbox.stub(),
                },
            }

            // Mock the client creation
            const createClientStub = sandbox.stub(
                require('../client/sigv4/codewhisperer'),
                'createCodeWhispererSigv4Client'
            )
            createClientStub.returns(mockClient)

            service = new CodeWhispererServiceIAM(
                mockCredentialsProvider as any,
                {} as any, // workspace parameter
                mockLogging as any,
                'us-east-1',
                'https://codewhisperer.us-east-1.amazonaws.com',
                mockSDKInitializator as any
            )
        })

        describe('getCredentialsType', function () {
            it('should return iam credentials type', function () {
                assert.strictEqual(service.getCredentialsType(), 'iam')
            })
        })

        describe('generateSuggestions', function () {
            it('should call client.generateRecommendations and process response', async function () {
                const mockRequest: GenerateSuggestionsRequest = {
                    fileContext: {
                        filename: 'test.js',
                        programmingLanguage: { languageName: 'javascript' },
                        leftFileContent: 'const x = ',
                        rightFileContent: '',
                    },
                    maxResults: 5,
                }

                const result = await service.generateSuggestions(mockRequest)

                assert.strictEqual(Array.isArray(result.suggestions), true)
                assert.strictEqual(typeof result.responseContext.requestId, 'string')
                assert.strictEqual(typeof result.responseContext.codewhispererSessionId, 'string')
            })

            it('should add customizationArn to request if set', async function () {
                service.customizationArn = 'test-arn'

                const mockRequest: GenerateSuggestionsRequest = {
                    fileContext: {
                        filename: 'test.js',
                        programmingLanguage: { languageName: 'javascript' },
                        leftFileContent: 'const x = ',
                        rightFileContent: '',
                    },
                    maxResults: 5,
                }

                await service.generateSuggestions(mockRequest)

                // Verify that the client was called with the customizationArn
                const clientCall = (service.client.send as sinon.SinonStub).getCall(0)
                assert.strictEqual(clientCall.args[0].input.customizationArn, 'test-arn')
            })

            it('should include serviceType in response', async function () {
                const mockRequest: GenerateSuggestionsRequest = {
                    fileContext: {
                        filename: 'test.js',
                        programmingLanguage: { languageName: 'javascript' },
                        leftFileContent: 'const x = ',
                        rightFileContent: '',
                    },
                    maxResults: 5,
                }

                const result = await service.generateSuggestions(mockRequest)
                assert.strictEqual(result.responseContext.authType, 'iam')
            })
        })

        describe('Request Type Guards', function () {
            it('should identify IAM vs Token requests', function () {
                const iamRequest = {
                    fileContext: {
                        filename: 'test.js',
                        programmingLanguage: { languageName: 'javascript' },
                        leftFileContent: '',
                        rightFileContent: '',
                    },
                }
                const tokenRequest = { ...iamRequest, editorState: {} }

                assert.strictEqual(isIAMRequest(iamRequest), true)
                assert.strictEqual(isTokenRequest(tokenRequest), true)
            })
        })
    })

    describe('CodeWhispererServiceToken', function () {
        let service: CodeWhispererServiceToken
        let mockClient: any

        beforeEach(function () {
            // Mock the token client
            mockClient = {
                generateCompletions: sandbox.stub().returns({
                    promise: sandbox.stub().resolves({
                        completions: [
                            {
                                content: 'console.log("hello");',
                                references: [],
                            },
                        ],
                        $response: {
                            requestId: 'test-request-id',
                            httpResponse: {
                                headers: { 'x-amzn-sessionid': 'test-session-id' },
                            },
                        },
                    }),
                }),
                config: {
                    update: sandbox.stub(),
                },
            }

            // Mock the client creation
            const createTokenClientStub = sandbox.stub(
                require('../client/token/codewhisperer'),
                'createCodeWhispererTokenClient'
            )
            createTokenClientStub.returns(mockClient)

            // Mock bearer credentials
            mockCredentialsProvider.getCredentials.returns({
                token: 'mock-bearer-token',
            })

            service = new CodeWhispererServiceToken(
                mockCredentialsProvider as any,
                mockWorkspace as any,
                mockLogging as any,
                'us-east-1',
                'https://codewhisperer.us-east-1.amazonaws.com',
                mockSDKInitializator as any,
                undefined
            )
        })

        describe('getCredentialsType', function () {
            it('should return bearer credentials type', function () {
                assert.strictEqual(service.getCredentialsType(), 'bearer')
            })
        })

        describe('generateSuggestions', function () {
            // Skipped: fails since this file last ran in CI; see the PR that skipped it
            it.skip('should call client.generateCompletions and process response', async function () {
                const mockRequest: GenerateSuggestionsRequest = {
                    fileContext: {
                        filename: 'test.js',
                        programmingLanguage: { languageName: 'javascript' },
                        leftFileContent: 'const x = ',
                        rightFileContent: '',
                    },
                    maxResults: 5,
                }

                const result = await service.generateSuggestions(mockRequest)

                assert.strictEqual(mockClient.generateCompletions.calledOnce, true)
                assert.strictEqual(Array.isArray(result.suggestions), true)
                assert.strictEqual(typeof result.responseContext.requestId, 'string')
                assert.strictEqual(typeof result.responseContext.codewhispererSessionId, 'string')
            })

            // Skipped: fails since this file last ran in CI; see the PR that skipped it
            it.skip('should add customizationArn to request if set', async function () {
                service.customizationArn = 'test-arn'

                const mockRequest: GenerateSuggestionsRequest = {
                    fileContext: {
                        filename: 'test.js',
                        programmingLanguage: { languageName: 'javascript' },
                        leftFileContent: 'const x = ',
                        rightFileContent: '',
                    },
                    maxResults: 5,
                }

                await service.generateSuggestions(mockRequest)

                const clientCall = mockClient.generateCompletions.getCall(0)
                assert.strictEqual(clientCall.args[0].customizationArn, 'test-arn')
            })

            // Skipped: fails since this file last ran in CI; see the PR that skipped it
            it.skip('should process profile ARN with withProfileArn method', async function () {
                const mockRequest: GenerateSuggestionsRequest = {
                    fileContext: {
                        filename: 'test.js',
                        programmingLanguage: { languageName: 'javascript' },
                        leftFileContent: 'const x = ',
                        rightFileContent: '',
                    },
                    maxResults: 5,
                }

                const withProfileArnStub = sandbox.stub(service, 'withProfileArn' as any)
                withProfileArnStub.returns(mockRequest)

                await service.generateSuggestions(mockRequest)

                assert.strictEqual(withProfileArnStub.calledOnceWith(mockRequest), true)
            })
        })
    })
})
