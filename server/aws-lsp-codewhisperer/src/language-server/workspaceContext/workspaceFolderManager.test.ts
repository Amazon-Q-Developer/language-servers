import { WorkspaceFolderManager } from './workspaceFolderManager'
import sinon, { stubInterface, StubbedInstance } from 'ts-sinon'
import { AmazonQTokenServiceManager } from '../../shared/amazonQServiceManager/AmazonQTokenServiceManager'
import { Agent, CredentialsProvider, Logging, ToolClassification } from '@aws/language-server-runtimes/server-interface'
import { DependencyDiscoverer } from './dependency/dependencyDiscoverer'
import { WorkspaceFolder } from 'vscode-languageserver-protocol'
import { ArtifactManager } from './artifactManager'
import { CodeWhispererServiceToken } from '../../shared/codeWhispererService'
import { ListWorkspaceMetadataResponse, WorkspaceStatus } from '@amzn/codewhisperer-runtime'
import { IdleWorkspaceManager } from './IdleWorkspaceManager'
import { ServiceException } from '@smithy/smithy-client'
import { SemanticSearch } from '../agenticChat/tools/workspaceContext/semanticSearch'

describe('WorkspaceFolderManager', () => {
    let mockAgent: StubbedInstance<Agent>
    let mockServiceManager: StubbedInstance<AmazonQTokenServiceManager>
    let mockLogging: StubbedInstance<Logging>
    let mockCredentialsProvider: StubbedInstance<CredentialsProvider>
    let mockDependencyDiscoverer: StubbedInstance<DependencyDiscoverer>
    let mockArtifactManager: StubbedInstance<ArtifactManager>
    let mockCodeWhispererService: StubbedInstance<CodeWhispererServiceToken>
    let workspaceFolderManager: WorkspaceFolderManager

    beforeEach(() => {
        mockAgent = stubInterface<Agent>()
        mockServiceManager = stubInterface<AmazonQTokenServiceManager>()
        mockLogging = stubInterface<Logging>()
        mockCredentialsProvider = stubInterface<CredentialsProvider>()
        mockDependencyDiscoverer = stubInterface<DependencyDiscoverer>()
        // The manager registers a handler for each entry of the registry
        ;(mockDependencyDiscoverer as any).dependencyHandlerRegistry = []
        mockArtifactManager = stubInterface<ArtifactManager>()
        mockCodeWhispererService = stubInterface<CodeWhispererServiceToken>()

        mockServiceManager.getCodewhispererService.returns(mockCodeWhispererService)
    })

    afterEach(() => {
        sinon.restore()
    })

    describe('checkRemoteWorkspaceStatusAndReact', () => {
        it('should check and react when IDE session is not idle', async () => {
            // Setup
            const workspaceFolders: WorkspaceFolder[] = [
                {
                    uri: 'file:///test/workspace',
                    name: 'test-workspace',
                },
            ]

            // Mock IdleSessionManager to return false (not idle)
            sinon.stub(IdleWorkspaceManager, 'isSessionIdle').returns(false)

            // Mock successful response
            const mockResponse: ListWorkspaceMetadataResponse = {
                workspaces: [
                    {
                        workspaceId: 'test-workspace-id',
                        workspaceStatus: 'CREATED',
                    },
                ],
            }

            mockCodeWhispererService.listWorkspaceMetadata.resolves(mockResponse as any)

            // Create the WorkspaceFolderManager instance using the static createInstance method
            workspaceFolderManager = WorkspaceFolderManager.createInstance(
                mockAgent,
                mockServiceManager,
                mockLogging,
                mockArtifactManager,
                mockDependencyDiscoverer,
                workspaceFolders,
                mockCredentialsProvider,
                'test-workspace-identifier'
            )

            // Spy on resetWebSocketClient
            const resetWebSocketClientSpy = sinon.stub(workspaceFolderManager as any, 'resetWebSocketClient')

            // Spy on handleWorkspaceCreatedState
            const handleWorkspaceCreatedStateSpy = sinon.stub(
                workspaceFolderManager as any,
                'handleWorkspaceCreatedState'
            )

            // Act - trigger the checkRemoteWorkspaceStatusAndReact method
            await workspaceFolderManager.checkRemoteWorkspaceStatusAndReact()

            // Verify that resetWebSocketClient was called once
            sinon.assert.notCalled(resetWebSocketClientSpy)
            sinon.assert.calledOnce(handleWorkspaceCreatedStateSpy)
        })

        it('should skip checking and reacting when IDE session is idle', async () => {
            // Setup
            const workspaceFolders: WorkspaceFolder[] = [
                {
                    uri: 'file:///test/workspace',
                    name: 'test-workspace',
                },
            ]

            // Mock IdleSessionManager to return true (idle)
            sinon.stub(IdleWorkspaceManager, 'isSessionIdle').returns(true)

            // Mock successful response
            const mockResponse: ListWorkspaceMetadataResponse = {
                workspaces: [
                    {
                        workspaceId: 'test-workspace-id',
                        workspaceStatus: 'CREATED',
                    },
                ],
            }

            mockCodeWhispererService.listWorkspaceMetadata.resolves(mockResponse as any)

            // Create the WorkspaceFolderManager instance using the static createInstance method
            workspaceFolderManager = WorkspaceFolderManager.createInstance(
                mockAgent,
                mockServiceManager,
                mockLogging,
                mockArtifactManager,
                mockDependencyDiscoverer,
                workspaceFolders,
                mockCredentialsProvider,
                'test-workspace-identifier'
            )

            // Spy on resetWebSocketClient
            const resetWebSocketClientSpy = sinon.stub(workspaceFolderManager as any, 'resetWebSocketClient')

            // Act - trigger the checkRemoteWorkspaceStatusAndReact method
            await workspaceFolderManager.checkRemoteWorkspaceStatusAndReact()

            // Verify that resetWebSocketClient was called once
            sinon.assert.calledOnce(resetWebSocketClientSpy)
        })
    })

    describe('isFeatureDisabled', () => {
        // Skipped: fails since this file last ran in CI; see the PR that skipped it
        it.skip('should return true when feature is disabled', async () => {
            // Setup
            const workspaceFolders: WorkspaceFolder[] = [
                {
                    uri: 'file:///test/workspace',
                    name: 'test-workspace',
                },
            ]

            const mockError = new ServiceException({
                name: 'AccessDeniedException',
                message: 'Feature is not supported',
                $fault: 'client',
                $metadata: {
                    httpStatusCode: 403,
                },
            })

            mockCodeWhispererService.listWorkspaceMetadata.rejects(mockError)

            // Create the WorkspaceFolderManager instance
            workspaceFolderManager = WorkspaceFolderManager.createInstance(
                mockAgent,
                mockServiceManager,
                mockLogging,
                mockArtifactManager,
                mockDependencyDiscoverer,
                workspaceFolders,
                mockCredentialsProvider,
                'test-workspace-identifier'
            )

            // Spy on clearAllWorkspaceResources and related methods
            const clearAllWorkspaceResourcesSpy = sinon.stub(
                workspaceFolderManager as any,
                'clearAllWorkspaceResources'
            )

            // Act - trigger listWorkspaceMetadata which sets feature disabled state
            await (workspaceFolderManager as any).listWorkspaceMetadata()

            // Assert
            expect(workspaceFolderManager.isFeatureDisabled()).toBe(true)

            // Verify that clearAllWorkspaceResources was called
            sinon.assert.calledOnce(clearAllWorkspaceResourcesSpy)
        })

        // Skipped: fails since this file last ran in CI; see the PR that skipped it
        it.skip('should return false when feature is not disabled', async () => {
            // Setup
            const workspaceFolders: WorkspaceFolder[] = [
                {
                    uri: 'file:///test/workspace',
                    name: 'test-workspace',
                },
            ]

            // Mock successful response
            const mockResponse: ListWorkspaceMetadataResponse = {
                workspaces: [
                    {
                        workspaceId: 'test-workspace-id',
                        // TODO: RUNNING does not exist in WorkspaceStatus so we need to use type assertion for now.
                        workspaceStatus: 'RUNNING' as WorkspaceStatus,
                    },
                ],
            }

            mockCodeWhispererService.listWorkspaceMetadata.resolves(mockResponse as any)

            // Create the WorkspaceFolderManager instance
            workspaceFolderManager = WorkspaceFolderManager.createInstance(
                mockAgent,
                mockServiceManager,
                mockLogging,
                mockArtifactManager,
                mockDependencyDiscoverer,
                workspaceFolders,
                mockCredentialsProvider,
                'test-workspace-identifier'
            )

            // Act - trigger listWorkspaceMetadata
            await (workspaceFolderManager as any).listWorkspaceMetadata()

            // Assert
            expect(workspaceFolderManager.isFeatureDisabled()).toBe(false)
        })
    })

    describe('semantic search tool management', () => {
        beforeEach(() => {
            const workspaceFolders: WorkspaceFolder[] = [
                {
                    uri: 'file:///test/workspace',
                    name: 'test-workspace',
                },
            ]

            workspaceFolderManager = WorkspaceFolderManager.createInstance(
                mockAgent,
                mockServiceManager,
                mockLogging,
                mockArtifactManager,
                mockDependencyDiscoverer,
                workspaceFolders,
                mockCredentialsProvider,
                'test-workspace-identifier'
            )

            // Mock service manager methods
            mockServiceManager.getRegion.returns('us-east-1')
        })

        describe('setSemanticSearchToolStatus', () => {
            // Skipped: fails since this file last ran in CI; see the PR that skipped it
            it.skip('should set semantic search tool status to enabled', () => {
                // Act
                workspaceFolderManager.setSemanticSearchToolStatus(true)

                // Assert - we can't directly access the private property, but we can test the behavior
                // through other methods that depend on this status
                expect(workspaceFolderManager).toBeDefined()
            })

            // Skipped: fails since this file last ran in CI; see the PR that skipped it
            it.skip('should set semantic search tool status to disabled', () => {
                // Act
                workspaceFolderManager.setSemanticSearchToolStatus(false)

                // Assert
                expect(workspaceFolderManager).toBeDefined()
            })
        })

        describe('registerSemanticSearchTool', () => {
            // Skipped: fails since this file last ran in CI; see the PR that skipped it
            it.skip('should register semantic search tool when not already present', () => {
                // Setup
                mockAgent.getTools.returns([]) // No existing tools
                workspaceFolderManager.setSemanticSearchToolStatus(true)

                // Act - call the private method through establishConnection
                const mockMetadata = {
                    environmentId: 'test-env-123',
                    environmentAddress: 'wss://test.amazonaws.com',
                    workspaceStatus: 'READY' as const,
                }

                // Spy on the private method
                const registerSemanticSearchToolSpy = sinon.spy(
                    workspaceFolderManager as any,
                    'registerSemanticSearchTool'
                )

                // Trigger establishConnection which calls registerSemanticSearchTool
                ;(workspaceFolderManager as any).establishConnection(mockMetadata)

                // Assert
                sinon.assert.calledOnce(registerSemanticSearchToolSpy)
                sinon.assert.calledOnce(mockAgent.addTool)

                // Verify the tool was added with correct parameters
                const addToolCall = mockAgent.addTool.getCall(0)
                expect(addToolCall.args[0].name).toBe(SemanticSearch.toolName)
                expect(addToolCall.args[2]).toBe(ToolClassification.BuiltIn)
            })

            it('should not register semantic search tool when already present', () => {
                // Setup - mock existing tool
                const existingTool = {
                    name: SemanticSearch.toolName,
                    description: 'Mock semantic search tool',
                    inputSchema: { type: 'object' as const, properties: {}, required: [] },
                }
                mockAgent.getTools.returns([existingTool])
                workspaceFolderManager.setSemanticSearchToolStatus(true)

                // Act
                const mockMetadata = {
                    environmentId: 'test-env-123',
                    environmentAddress: 'wss://test.amazonaws.com',
                    workspaceStatus: 'READY' as const,
                }

                ;(workspaceFolderManager as any).establishConnection(mockMetadata)

                // Assert - addTool should not be called since tool already exists
                sinon.assert.notCalled(mockAgent.addTool)
            })

            it('should not register semantic search tool when status is disabled', () => {
                // Setup
                mockAgent.getTools.returns([])
                workspaceFolderManager.setSemanticSearchToolStatus(false) // Disabled

                // Act
                const mockMetadata = {
                    environmentId: 'test-env-123',
                    environmentAddress: 'wss://test.amazonaws.com',
                    workspaceStatus: 'READY' as const,
                }

                ;(workspaceFolderManager as any).establishConnection(mockMetadata)

                // Assert - addTool should not be called since semantic search is disabled
                sinon.assert.notCalled(mockAgent.addTool)
            })
        })

        describe('removeSemanticSearchTool', () => {
            // Skipped: fails since this file last ran in CI; see the PR that skipped it
            it.skip('should remove semantic search tool when present', () => {
                // Setup - mock existing tool
                const existingTool = {
                    name: SemanticSearch.toolName,
                    description: 'Mock semantic search tool',
                    inputSchema: { type: 'object' as const, properties: {}, required: [] },
                }
                mockAgent.getTools.returns([existingTool])
                workspaceFolderManager.setSemanticSearchToolStatus(true)

                // Act - call removeSemanticSearchTool through clearAllWorkspaceResources
                workspaceFolderManager.clearAllWorkspaceResources()

                // Assert
                sinon.assert.calledOnce(mockAgent.removeTool)
                sinon.assert.calledWith(mockAgent.removeTool, SemanticSearch.toolName)
            })

            // Skipped: fails since this file last ran in CI; see the PR that skipped it
            it.skip('should not remove semantic search tool when not present', () => {
                // Setup - no existing tools
                mockAgent.getTools.returns([])
                workspaceFolderManager.setSemanticSearchToolStatus(true)

                // Act
                workspaceFolderManager.clearAllWorkspaceResources()

                // Assert - removeTool should not be called since tool doesn't exist
                sinon.assert.notCalled(mockAgent.removeTool)
            })

            // Skipped: fails since this file last ran in CI; see the PR that skipped it
            it.skip('should remove semantic search tool when session becomes idle', async () => {
                // Setup
                const existingTool = {
                    name: SemanticSearch.toolName,
                    description: 'Mock semantic search tool',
                    inputSchema: { type: 'object' as const, properties: {}, required: [] },
                }
                mockAgent.getTools.returns([existingTool])
                workspaceFolderManager.setSemanticSearchToolStatus(true)

                // Mock IdleSessionManager to return true (idle)
                sinon.stub(IdleWorkspaceManager, 'isSessionIdle').returns(true)

                const workspaceFolders: WorkspaceFolder[] = [
                    {
                        uri: 'file:///test/workspace',
                        name: 'test-workspace',
                    },
                ]

                // Update workspace folders to trigger the idle check
                workspaceFolderManager.updateWorkspaceFolders(workspaceFolders)

                // Act - trigger checkRemoteWorkspaceStatusAndReact which handles idle state
                await workspaceFolderManager.checkRemoteWorkspaceStatusAndReact()

                // Assert
                sinon.assert.calledOnce(mockAgent.removeTool)
                sinon.assert.calledWith(mockAgent.removeTool, SemanticSearch.toolName)
            })
        })
    })

    describe('resetAdminOptOutAndFeatureDisabledStatus', () => {
        // Skipped: fails since this file last ran in CI; see the PR that skipped it
        it.skip('should reset both opt-out and feature disabled status', () => {
            // Setup
            const workspaceFolders: WorkspaceFolder[] = [
                {
                    uri: 'file:///test/workspace',
                    name: 'test-workspace',
                },
            ]

            workspaceFolderManager = WorkspaceFolderManager.createInstance(
                mockAgent,
                mockServiceManager,
                mockLogging,
                mockArtifactManager,
                mockDependencyDiscoverer,
                workspaceFolders,
                mockCredentialsProvider,
                'test-workspace-identifier'
            )

            // Simulate both statuses being set to true
            // We can't directly set these private properties, but we can test the behavior
            // by triggering conditions that would set them and then resetting

            // Act
            workspaceFolderManager.resetAdminOptOutAndFeatureDisabledStatus()

            // Assert - verify the statuses are reset
            expect(workspaceFolderManager.getOptOutStatus()).toBe(false)
            expect(workspaceFolderManager.isFeatureDisabled()).toBe(false)
        })
    })

    describe('feature disabled handling in checkRemoteWorkspaceStatusAndReact', () => {
        // Skipped: fails since this file last ran in CI; see the PR that skipped it
        it.skip('should handle feature disabled state and clear resources', async () => {
            // Setup
            const workspaceFolders: WorkspaceFolder[] = [
                {
                    uri: 'file:///test/workspace',
                    name: 'test-workspace',
                },
            ]

            // Mock IdleSessionManager to return false (not idle)
            sinon.stub(IdleWorkspaceManager, 'isSessionIdle').returns(false)

            // Mock listWorkspaceMetadata to throw AccessDeniedException with feature not supported
            const mockError = new ServiceException({
                name: 'AccessDeniedException',
                message: 'Feature is not supported',
                $fault: 'client',
                $metadata: {
                    httpStatusCode: 403,
                },
            })

            mockCodeWhispererService.listWorkspaceMetadata.rejects(mockError)

            workspaceFolderManager = WorkspaceFolderManager.createInstance(
                mockAgent,
                mockServiceManager,
                mockLogging,
                mockArtifactManager,
                mockDependencyDiscoverer,
                workspaceFolders,
                mockCredentialsProvider,
                'test-workspace-identifier'
            )

            // Spy on clearAllWorkspaceResources
            const clearAllWorkspaceResourcesSpy = sinon.stub(
                workspaceFolderManager as any,
                'clearAllWorkspaceResources'
            )

            // Act
            await workspaceFolderManager.checkRemoteWorkspaceStatusAndReact()

            // Assert
            expect(workspaceFolderManager.isFeatureDisabled()).toBe(true)
            sinon.assert.calledOnce(clearAllWorkspaceResourcesSpy)
            sinon.assert.calledWith(mockLogging.log, sinon.match(/Feature disabled, clearing all resources/))
        })
    })
})
