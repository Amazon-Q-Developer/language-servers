import { SendMessageCommandInput, SendMessageCommandOutput, ChatTriggerType } from '@amzn/codewhisperer-streaming'
import * as assert from 'assert'
import sinon, { StubbedInstance, stubInterface } from 'ts-sinon'
import { ChatSessionService } from './chatSessionService'
import { AmazonQTokenServiceManager } from '../../shared/amazonQServiceManager/AmazonQTokenServiceManager'
import { StreamingClientServiceToken, StreamingClientServiceIAM } from '../../shared/streamingClientService'
import { AmazonQBaseServiceManager } from '../../shared/amazonQServiceManager/BaseAmazonQServiceManager'
import { AmazonQIAMServiceManager } from '../../shared/amazonQServiceManager/AmazonQIAMServiceManager'
import * as sharedUtils from '../../shared/utils'
import { Utils } from 'vscode-uri'
import { wrapErrorWithCode } from '../agenticChat/errors'

describe('Chat Session Service', () => {
    let abortStub: sinon.SinonStub<any, any>
    let chatSessionService: ChatSessionService
    let amazonQServiceManager: StubbedInstance<AmazonQBaseServiceManager>
    let codeWhispererStreamingClient: StubbedInstance<StreamingClientServiceToken>
    const mockConversationId = 'mockConversationId'

    const mockRequestParams: SendMessageCommandInput = {
        conversationState: {
            chatTriggerType: ChatTriggerType.MANUAL,
            currentMessage: {
                userInputMessage: {
                    content: 'hello',
                },
            },
        },
    }

    const mockRequestResponse: SendMessageCommandOutput = {
        $metadata: {},
        sendMessageResponse: undefined,
    }

    beforeEach(() => {
        codeWhispererStreamingClient = stubInterface<StreamingClientServiceToken>()
        codeWhispererStreamingClient.sendMessage.callsFake(() => Promise.resolve(mockRequestResponse))

        amazonQServiceManager = stubInterface<AmazonQBaseServiceManager>()
        amazonQServiceManager.getStreamingClient.returns(codeWhispererStreamingClient)

        abortStub = sinon.stub(AbortController.prototype, 'abort')

        const mockLsp = {
            getClientInitializeParams: () => ({}),
        }

        chatSessionService = new ChatSessionService(amazonQServiceManager, mockLsp as any)

        // needed to identify the stubs as the actual class when checking 'instanceof' in generateAssistantResponse
        Object.setPrototypeOf(amazonQServiceManager, AmazonQTokenServiceManager.prototype)
        Object.setPrototypeOf(codeWhispererStreamingClient, StreamingClientServiceToken.prototype)
    })

    afterEach(() => {
        abortStub.restore()
    })

    describe('calling SendMessage', () => {
        it('throws error is AmazonQTokenServiceManager is not initialized', async () => {
            chatSessionService = new ChatSessionService(undefined)

            await assert.rejects(
                chatSessionService.sendMessage(mockRequestParams),
                new Error('amazonQServiceManager is not initialized')
            )
        })

        it('should fill in conversationId in the request if exists', async () => {
            await chatSessionService.sendMessage(mockRequestParams)
            sinon.assert.calledOnce(codeWhispererStreamingClient.sendMessage)
            sinon.assert.match(codeWhispererStreamingClient.sendMessage.firstCall.firstArg, mockRequestParams)

            chatSessionService.conversationId = mockConversationId

            await chatSessionService.sendMessage(mockRequestParams)

            const requestParamsWithConversationId = {
                conversationState: {
                    ...mockRequestParams.conversationState,
                    conversationId: mockConversationId,
                },
            }

            sinon.assert.match(
                codeWhispererStreamingClient.sendMessage.getCall(1).firstArg,
                requestParamsWithConversationId
            )
        })

        it('abortRequest() aborts request with AbortController', async () => {
            await chatSessionService.sendMessage(mockRequestParams)

            chatSessionService.abortRequest()

            sinon.assert.calledOnce(abortStub)
        })

        it('dispose() calls aborts outgoing requests', async () => {
            await chatSessionService.sendMessage(mockRequestParams)

            chatSessionService.dispose()

            sinon.assert.calledOnce(abortStub)
        })

        it('clear() resets conversation id and aborts outgoing request', async () => {
            await chatSessionService.sendMessage(mockRequestParams)
            chatSessionService.conversationId = mockConversationId

            assert.strictEqual(chatSessionService.conversationId, mockConversationId)

            chatSessionService.clear()

            sinon.assert.calledOnce(abortStub)
            assert.strictEqual(chatSessionService.conversationId, undefined)
        })
    })

    describe('calling GenerateAssistantResponse', () => {
        it('throws error is AmazonQTokenServiceManager is not initialized', async () => {
            chatSessionService = new ChatSessionService(undefined)

            await assert.rejects(
                chatSessionService.getChatResponse(mockRequestParams),
                new Error('amazonQServiceManager is not initialized')
            )
        })

        it('should fill in conversationId in the request if exists', async () => {
            await chatSessionService.getChatResponse(mockRequestParams)
            sinon.assert.calledOnce(codeWhispererStreamingClient.generateAssistantResponse)
            sinon.assert.match(
                codeWhispererStreamingClient.generateAssistantResponse.firstCall.firstArg,
                mockRequestParams
            )

            chatSessionService.conversationId = mockConversationId

            await chatSessionService.getChatResponse(mockRequestParams)

            const requestParamsWithConversationId = {
                conversationState: {
                    ...mockRequestParams.conversationState,
                    conversationId: mockConversationId,
                },
            }

            sinon.assert.match(
                codeWhispererStreamingClient.generateAssistantResponse.getCall(1).firstArg,
                requestParamsWithConversationId
            )
        })

        it('abortRequest() in IAM client, aborts request with AbortController', async () => {
            const codeWhispererStreamingClientIAM = stubInterface<StreamingClientServiceIAM>()
            codeWhispererStreamingClientIAM.sendMessage.callsFake(() => Promise.resolve(mockRequestResponse))

            const amazonQServiceManagerIAM = stubInterface<AmazonQIAMServiceManager>()
            amazonQServiceManagerIAM.getStreamingClient.returns(codeWhispererStreamingClientIAM)

            const chatSessionServiceIAM = new ChatSessionService(amazonQServiceManagerIAM)
            await chatSessionServiceIAM.sendMessage(mockRequestParams)

            chatSessionServiceIAM.abortRequest()

            sinon.assert.calledOnce(abortStub)
        })

        it('dispose() in IAM client, calls aborts outgoing requests', async () => {
            const codeWhispererStreamingClientIAM = stubInterface<StreamingClientServiceIAM>()
            codeWhispererStreamingClientIAM.sendMessage.callsFake(() => Promise.resolve(mockRequestResponse))

            const amazonQServiceManagerIAM = stubInterface<AmazonQIAMServiceManager>()
            amazonQServiceManagerIAM.getStreamingClient.returns(codeWhispererStreamingClientIAM)

            const chatSessionServiceIAM = new ChatSessionService(amazonQServiceManagerIAM)
            await chatSessionServiceIAM.sendMessage(mockRequestParams)

            chatSessionServiceIAM.dispose()

            sinon.assert.calledOnce(abortStub)
        })

        it('abortRequest() aborts request with AbortController', async () => {
            await chatSessionService.getChatResponse(mockRequestParams)

            chatSessionService.abortRequest()

            sinon.assert.calledOnce(abortStub)
        })

        it('dispose() calls aborts outgoing requests', async () => {
            await chatSessionService.getChatResponse(mockRequestParams)

            chatSessionService.dispose()

            sinon.assert.calledOnce(abortStub)
        })

        it('clear() resets conversation id and aborts outgoing request', async () => {
            await chatSessionService.getChatResponse(mockRequestParams)
            chatSessionService.conversationId = mockConversationId

            assert.strictEqual(chatSessionService.conversationId, mockConversationId)

            chatSessionService.clear()

            sinon.assert.calledOnce(abortStub)
            assert.strictEqual(chatSessionService.conversationId, undefined)
        })
    })

    it('clear() in IAM client, resets conversation id and aborts outgoing request', async () => {
        const codeWhispererStreamingClientIAM = stubInterface<StreamingClientServiceIAM>()
        codeWhispererStreamingClientIAM.sendMessage.callsFake(() => Promise.resolve(mockRequestResponse))

        const amazonQServiceManagerIAM = stubInterface<AmazonQIAMServiceManager>()
        amazonQServiceManagerIAM.getStreamingClient.returns(codeWhispererStreamingClientIAM)

        const chatSessionServiceIAM = new ChatSessionService(amazonQServiceManagerIAM)
        await chatSessionServiceIAM.sendMessage(mockRequestParams)

        chatSessionServiceIAM.conversationId = mockConversationId

        assert.strictEqual(chatSessionServiceIAM.conversationId, mockConversationId)

        chatSessionServiceIAM.clear()

        sinon.assert.calledOnce(abortStub)
        assert.strictEqual(chatSessionServiceIAM.conversationId, undefined)
    })

    describe('Prompt ID', () => {
        let chatSessionService: ChatSessionService

        beforeEach(() => {
            chatSessionService = new ChatSessionService()
        })

        it('should initialize with undefined promptId', () => {
            assert.strictEqual(chatSessionService.isCurrentPrompt('test-id'), false)
        })

        it('should set and check current prompt ID', () => {
            const promptId = 'test-prompt-id'
            chatSessionService.setCurrentPromptId(promptId)

            assert.strictEqual(chatSessionService.isCurrentPrompt(promptId), true)
            assert.strictEqual(chatSessionService.isCurrentPrompt('different-id'), false)
        })
    })

    describe('Approved Paths', () => {
        let chatSessionService: ChatSessionService

        beforeEach(() => {
            chatSessionService = new ChatSessionService()
        })

        it('should initialize with an empty map of approved paths', () => {
            const approvedPaths = chatSessionService.approvedPaths
            assert.strictEqual(approvedPaths.size, 0)
            assert.ok(approvedPaths instanceof Map)
        })

        it('should add a path to approved paths', () => {
            const testPath = '/test/path/file.js'
            const toolName = 'testTool'
            chatSessionService.addApprovedPath(testPath, toolName)

            const approvedPaths = chatSessionService.approvedPaths
            assert.strictEqual(approvedPaths.size, 1)
            assert.ok(approvedPaths.has(toolName))
            assert.ok(approvedPaths.get(toolName)!.has(testPath))
        })

        it('should not add empty paths', () => {
            chatSessionService.addApprovedPath('', 'testTool')
            chatSessionService.addApprovedPath(undefined as unknown as string, 'testTool')

            const approvedPaths = chatSessionService.approvedPaths
            assert.strictEqual(approvedPaths.size, 0)
        })

        it('should normalize Windows-style paths', () => {
            const windowsPath = 'C:\\Users\\test\\file.js'
            const normalizedPath = 'C:/Users/test/file.js'
            const toolName = 'testTool'

            chatSessionService.addApprovedPath(windowsPath, toolName)

            const approvedPaths = chatSessionService.approvedPaths
            assert.strictEqual(approvedPaths.size, 1)
            assert.ok(approvedPaths.has(toolName))
            assert.ok(approvedPaths.get(toolName)!.has(normalizedPath))
            assert.ok(!approvedPaths.get(toolName)!.has(windowsPath))
        })

        it('should handle multiple paths correctly', () => {
            const paths = ['/path/one/file.js', '/path/two/file.js', 'C:\\path\\three\\file.js']
            const toolName = 'testTool'

            paths.forEach(p => chatSessionService.addApprovedPath(p, toolName))

            const approvedPaths = chatSessionService.approvedPaths
            assert.strictEqual(approvedPaths.size, 1)
            assert.ok(approvedPaths.has(toolName))
            const toolPaths = approvedPaths.get(toolName)!
            assert.strictEqual(toolPaths.size, 3)
            assert.ok(toolPaths.has(paths[0]))
            assert.ok(toolPaths.has(paths[1]))
            assert.ok(toolPaths.has('C:/path/three/file.js'))
        })

        it('should not add duplicate paths', () => {
            const testPath = '/test/path/file.js'
            const toolName = 'testTool'

            chatSessionService.addApprovedPath(testPath, toolName)
            chatSessionService.addApprovedPath(testPath, toolName)

            const approvedPaths = chatSessionService.approvedPaths
            assert.strictEqual(approvedPaths.size, 1)
            assert.ok(approvedPaths.has(toolName))
            const toolPaths = approvedPaths.get(toolName)!
            assert.strictEqual(toolPaths.size, 1)
        })

        it('should treat normalized paths as the same path', () => {
            const unixPath = '/test/path/file.js'
            const windowsPath = '/test\\path\\file.js'
            const toolName = 'testTool'

            chatSessionService.addApprovedPath(unixPath, toolName)
            chatSessionService.addApprovedPath(windowsPath, toolName)

            const approvedPaths = chatSessionService.approvedPaths
            assert.strictEqual(approvedPaths.size, 1)
            assert.ok(approvedPaths.has(toolName))
            const toolPaths = approvedPaths.get(toolName)!
            assert.strictEqual(toolPaths.size, 1)
            assert.ok(toolPaths.has(unixPath))
        })

        it('keeps the file as approved when it has more than one hard link', () => {
            const linked = {
                path: '/test/path/linked.js',
                state: 'existing',
                dev: '1',
                ino: '2',
                linkCount: '2',
            } as const

            chatSessionService.addApprovedPath(linked.path, 'fsRead', linked)
            chatSessionService.addApprovedPath('/test/path/single.js', 'fsRead', { ...linked, linkCount: '1' })
            chatSessionService.addApprovedPath('/test/path/unverified.js', 'fsRead', {
                path: '/test/path/unverified.js',
                state: 'unverified',
            })

            assert.deepStrictEqual([...chatSessionService.approvedLinkedFiles], [['fsRead', [linked]]])
            assert.strictEqual(chatSessionService.approvedPaths.get('fsRead')!.size, 3)
        })
    })

    describe('setModel encapsulation', () => {
        let chatSessionService: ChatSessionService

        beforeEach(() => {
            chatSessionService = new ChatSessionService()
        })

        it('should initialize with undefined modelId and default token limits', () => {
            assert.strictEqual(chatSessionService.modelId, undefined)
            assert.strictEqual(chatSessionService.tokenLimits.maxInputTokens, 200_000)
        })

        it('should set modelId and calculate token limits together', () => {
            const models = [
                { id: 'model-1', name: 'Model 1', description: 'Test', tokenLimits: { maxInputTokens: 300_000 } },
            ]

            chatSessionService.setModel('model-1', models)

            assert.strictEqual(chatSessionService.modelId, 'model-1')
            assert.strictEqual(chatSessionService.tokenLimits.maxInputTokens, 300_000)
            assert.strictEqual(chatSessionService.tokenLimits.maxOverallCharacters, Math.floor(300_000 * 3.5))
        })

        it('should use default token limits when model not found in list', () => {
            chatSessionService.setModel('unknown-model', [])

            assert.strictEqual(chatSessionService.modelId, 'unknown-model')
            assert.strictEqual(chatSessionService.tokenLimits.maxInputTokens, 200_000)
        })

        it('should use default token limits when models list is undefined', () => {
            chatSessionService.setModel('some-model', undefined)

            assert.strictEqual(chatSessionService.modelId, 'some-model')
            assert.strictEqual(chatSessionService.tokenLimits.maxInputTokens, 200_000)
        })
    })

    describe('IAM client source property', () => {
        it('sets source to Origin.IDE when using StreamingClientServiceIAM', async () => {
            const codeWhispererStreamingClientIAM = stubInterface<StreamingClientServiceIAM>()
            codeWhispererStreamingClientIAM.sendMessage.callsFake(() => Promise.resolve(mockRequestResponse))

            const amazonQServiceManagerIAM = stubInterface<AmazonQIAMServiceManager>()
            amazonQServiceManagerIAM.getStreamingClient.returns(codeWhispererStreamingClientIAM)

            // Set prototype to make instanceof check work
            Object.setPrototypeOf(codeWhispererStreamingClientIAM, StreamingClientServiceIAM.prototype)
            Object.setPrototypeOf(amazonQServiceManagerIAM, AmazonQIAMServiceManager.prototype)

            const chatSessionServiceIAM = new ChatSessionService(amazonQServiceManagerIAM)

            // Create a request without source property
            const request = {
                conversationState: {
                    chatTriggerType: ChatTriggerType.MANUAL,
                    currentMessage: { userInputMessage: { content: 'test' } },
                },
            }

            // Call getChatResponse
            await chatSessionServiceIAM.getChatResponse(request)

            // Verify that sendMessage was called with source set to Origin.IDE
            sinon.assert.calledOnce(codeWhispererStreamingClientIAM.sendMessage)
            const actualRequest = codeWhispererStreamingClientIAM.sendMessage.firstCall.args[0]
            assert.strictEqual(actualRequest.source, 'IDE')
        })

        it('calls getOriginFromClientInfo and uses returned origin in SendMessage request', async () => {
            // Stub getOriginFromClientInfo to return a specific value
            const getOriginFromClientInfoStub = sinon
                .stub(sharedUtils, 'getOriginFromClientInfo')
                .returns('MD_IDE' as any)

            const codeWhispererStreamingClientIAM = stubInterface<StreamingClientServiceIAM>()
            codeWhispererStreamingClientIAM.sendMessage.callsFake(() => Promise.resolve(mockRequestResponse))

            const amazonQServiceManagerIAM = stubInterface<AmazonQIAMServiceManager>()
            amazonQServiceManagerIAM.getStreamingClient.returns(codeWhispererStreamingClientIAM)

            // Set prototype to make instanceof check work
            Object.setPrototypeOf(codeWhispererStreamingClientIAM, StreamingClientServiceIAM.prototype)
            Object.setPrototypeOf(amazonQServiceManagerIAM, AmazonQIAMServiceManager.prototype)

            const chatSessionServiceIAM = new ChatSessionService(amazonQServiceManagerIAM)

            // Create a request without source property
            const request = {
                conversationState: {
                    chatTriggerType: ChatTriggerType.MANUAL,
                    currentMessage: { userInputMessage: { content: 'test' } },
                },
            }

            // Call getChatResponse
            await chatSessionServiceIAM.getChatResponse(request)

            // Verify getOriginFromClientInfo was called
            sinon.assert.calledOnce(getOriginFromClientInfoStub)

            // Verify that sendMessage was called with source set to the value from getOriginFromClientInfo
            sinon.assert.calledOnce(codeWhispererStreamingClientIAM.sendMessage)
            const actualRequest = codeWhispererStreamingClientIAM.sendMessage.firstCall.args[0]
            assert.strictEqual(actualRequest.source, 'MD_IDE')

            // Restore the stub
            getOriginFromClientInfoStub.restore()
        })
    })

    describe('Error handling for model capacity issues', () => {
        let enabledModelSelectionStub: sinon.SinonStub

        beforeEach(() => {
            enabledModelSelectionStub = sinon.stub(sharedUtils, 'enabledModelSelection')
        })

        afterEach(() => {
            enabledModelSelectionStub.restore()
        })

        describe('getChatResponse error handling', () => {
            it('should handle HTTP 500 error with specific message when model selection is enabled', async () => {
                enabledModelSelectionStub.returns(true)

                const error = new Error(
                    'Encountered unexpectedly high load when processing the request, please try again.'
                ) as any
                error.$metadata = { httpStatusCode: 500 }

                codeWhispererStreamingClient.generateAssistantResponse.rejects(error)

                const requestWithModelId = {
                    conversationState: {
                        chatTriggerType: ChatTriggerType.MANUAL,
                        currentMessage: {
                            userInputMessage: {
                                content: 'hello',
                                modelId: 'test-model-id',
                            },
                        },
                    },
                }

                try {
                    await chatSessionService.getChatResponse(requestWithModelId)
                    assert.fail('Expected error to be thrown')
                } catch (e: any) {
                    assert.strictEqual(
                        e.message,
                        'The model you selected is temporarily unavailable. Please switch to a different model and try again.'
                    )
                }
            })

            it('should handle HTTP 500 error with specific message when model selection is disabled', async () => {
                enabledModelSelectionStub.returns(false)

                const error = new Error(
                    'Encountered unexpectedly high load when processing the request, please try again.'
                ) as any
                error.$metadata = { httpStatusCode: 500 }

                codeWhispererStreamingClient.generateAssistantResponse.rejects(error)

                const requestWithModelId = {
                    conversationState: {
                        chatTriggerType: ChatTriggerType.MANUAL,
                        currentMessage: {
                            userInputMessage: {
                                content: 'hello',
                                modelId: 'test-model-id',
                            },
                        },
                    },
                }

                try {
                    await chatSessionService.getChatResponse(requestWithModelId)
                    assert.fail('Expected error to be thrown')
                } catch (e: any) {
                    assert.strictEqual(e.message, 'I am experiencing high traffic, please try again shortly.')
                }
            })

            it('should handle HTTP 429 error with INSUFFICIENT_MODEL_CAPACITY when model selection is enabled', async () => {
                enabledModelSelectionStub.returns(true)

                const error = new Error('Some error message') as any
                error.$metadata = { httpStatusCode: 429 }
                error.reason = 'INSUFFICIENT_MODEL_CAPACITY'

                codeWhispererStreamingClient.generateAssistantResponse.rejects(error)

                const requestWithModelId = {
                    conversationState: {
                        chatTriggerType: ChatTriggerType.MANUAL,
                        currentMessage: {
                            userInputMessage: {
                                content: 'hello',
                                modelId: 'test-model-id',
                            },
                        },
                    },
                }

                try {
                    await chatSessionService.getChatResponse(requestWithModelId)
                    assert.fail('Expected error to be thrown')
                } catch (e: any) {
                    assert.strictEqual(
                        e.message,
                        'The model you selected is temporarily unavailable. Please switch to a different model and try again.'
                    )
                }
            })

            it('should handle HTTP 429 error with INSUFFICIENT_MODEL_CAPACITY when model selection is disabled', async () => {
                enabledModelSelectionStub.returns(false)

                const error = new Error('Some error message') as any
                error.$metadata = { httpStatusCode: 429 }
                error.reason = 'INSUFFICIENT_MODEL_CAPACITY'

                codeWhispererStreamingClient.generateAssistantResponse.rejects(error)

                const requestWithModelId = {
                    conversationState: {
                        chatTriggerType: ChatTriggerType.MANUAL,
                        currentMessage: {
                            userInputMessage: {
                                content: 'hello',
                                modelId: 'test-model-id',
                            },
                        },
                    },
                }

                try {
                    await chatSessionService.getChatResponse(requestWithModelId)
                    assert.fail('Expected error to be thrown')
                } catch (e: any) {
                    assert.strictEqual(e.message, 'I am experiencing high traffic, please try again shortly.')
                }
            })
        })

        describe('IAM client error handling', () => {
            let codeWhispererStreamingClientIAM: StubbedInstance<StreamingClientServiceIAM>
            let amazonQServiceManagerIAM: StubbedInstance<AmazonQIAMServiceManager>
            let chatSessionServiceIAM: ChatSessionService

            beforeEach(() => {
                codeWhispererStreamingClientIAM = stubInterface<StreamingClientServiceIAM>()
                amazonQServiceManagerIAM = stubInterface<AmazonQIAMServiceManager>()
                amazonQServiceManagerIAM.getStreamingClient.returns(codeWhispererStreamingClientIAM)

                Object.setPrototypeOf(codeWhispererStreamingClientIAM, StreamingClientServiceIAM.prototype)
                Object.setPrototypeOf(amazonQServiceManagerIAM, AmazonQIAMServiceManager.prototype)

                const mockLsp = {
                    getClientInitializeParams: () => ({}),
                }
                chatSessionServiceIAM = new ChatSessionService(amazonQServiceManagerIAM, mockLsp as any)
            })

            it('should handle HTTP 500 error with specific message when model selection is enabled', async () => {
                enabledModelSelectionStub.returns(true)

                const error = new Error(
                    'Encountered unexpectedly high load when processing the request, please try again.'
                ) as any
                error.$metadata = { httpStatusCode: 500 }

                codeWhispererStreamingClientIAM.sendMessage.rejects(error)

                const requestWithModelId = {
                    conversationState: {
                        chatTriggerType: ChatTriggerType.MANUAL,
                        currentMessage: {
                            userInputMessage: {
                                content: 'hello',
                                modelId: 'test-model-id',
                            },
                        },
                    },
                }

                try {
                    await chatSessionServiceIAM.getChatResponse(requestWithModelId)
                    assert.fail('Expected error to be thrown')
                } catch (e: any) {
                    assert.strictEqual(
                        e.message,
                        'The model you selected is temporarily unavailable. Please switch to a different model and try again.'
                    )
                }
            })

            it('should handle HTTP 429 error with INSUFFICIENT_MODEL_CAPACITY when model selection is disabled', async () => {
                enabledModelSelectionStub.returns(false)

                const error = new Error('Some error message') as any
                error.$metadata = { httpStatusCode: 429 }
                error.reason = 'INSUFFICIENT_MODEL_CAPACITY'

                codeWhispererStreamingClientIAM.sendMessage.rejects(error)

                const requestWithModelId = {
                    conversationState: {
                        chatTriggerType: ChatTriggerType.MANUAL,
                        currentMessage: {
                            userInputMessage: {
                                content: 'hello',
                                modelId: 'test-model-id',
                            },
                        },
                    },
                }

                try {
                    await chatSessionServiceIAM.getChatResponse(requestWithModelId)
                    assert.fail('Expected error to be thrown')
                } catch (e: any) {
                    assert.strictEqual(e.message, 'I am experiencing high traffic, please try again shortly.')
                }
            })
        })
    })
})
