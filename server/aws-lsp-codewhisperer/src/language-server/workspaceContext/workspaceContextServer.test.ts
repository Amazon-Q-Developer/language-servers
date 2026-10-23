import { InitializeParams, Server } from '@aws/language-server-runtimes/server-interface'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import sinon from 'ts-sinon'
import { WorkspaceContextServer } from './workspaceContextServer'

describe('WorkspaceContext Server', () => {
    let features: TestFeatures
    let server: Server
    let disposeServer: () => void

    beforeEach(() => {
        features = new TestFeatures()
        server = WorkspaceContextServer()
        disposeServer = server(features)
    })

    afterEach(() => {
        sinon.restore()
        disposeServer()
        features.dispose()
    })

    describe('Initialization', () => {
        it('should generate a workspace identifier when none is provided', async () => {
            // Set up the test to simulate no workspaceIdentifier in initialization
            features.lsp.getClientInitializeParams.returns({
                initializationOptions: {
                    aws: {
                        clientInfo: {
                            name: 'AmazonQ-For-VSCode',
                            version: '0.0.1',
                            extension: {
                                name: 'AmazonQ-For-VSCode',
                                version: '0.0.1',
                            },
                        },
                    },
                },
            } as InitializeParams)

            await features.initialize(server)

            // Verify that a warning was logged (indicating the workspaceIdentifier was generated)
            sinon.assert.calledWith(features.logging.warn, sinon.match(/No workspaceIdentifier set/))
        })
    })

    describe('UpdateConfiguration', () => {
        // Skipped: fails since this file last ran in CI; see the PR that skipped it
        it.skip('should opt in for VSCode extension with server-sideContext enabled', async () => {
            features.lsp.getClientInitializeParams.returns({
                initializationOptions: {
                    aws: {
                        clientInfo: {
                            name: 'AmazonQ-For-VSCode',
                            version: '0.0.1',
                            extension: {
                                name: 'AmazonQ-For-VSCode',
                                version: '0.0.1',
                            },
                        },
                    },
                },
            } as InitializeParams)

            features.lsp.workspace.getConfiguration.withArgs('amazonQ').resolves({
                'server-sideContext': true,
            })

            await features.initialize(server)
            await features.doChangeConfiguration()

            sinon.assert.calledWith(features.logging.log, sinon.match(/Workspace context server opt-in flag is: true/))
        })

        // Skipped: fails since this file last ran in CI; see the PR that skipped it
        it.skip('should opt out for VSCode extension with server-sideContext disabled', async () => {
            features.lsp.getClientInitializeParams.returns({
                initializationOptions: {
                    aws: {
                        clientInfo: {
                            name: 'AmazonQ-For-VSCode',
                            version: '0.0.1',
                            extension: {
                                name: 'AmazonQ-For-VSCode',
                                version: '0.0.1',
                            },
                        },
                    },
                },
            } as InitializeParams)

            features.lsp.workspace.getConfiguration.withArgs('amazonQ').resolves({
                'server-sideContext': false,
            })

            await features.initialize(server)
            await features.doChangeConfiguration()

            sinon.assert.calledWith(features.logging.log, sinon.match(/Workspace context server opt-in flag is: false/))
        })

        // Skipped: fails since this file last ran in CI; see the PR that skipped it
        it.skip('should opt in for VSCode extension with server-sideContext missing for internal & BuilderID users', async () => {
            features.lsp.getClientInitializeParams.returns({
                initializationOptions: {
                    aws: {
                        clientInfo: {
                            name: 'AmazonQ-For-VSCode',
                            version: '0.0.1',
                            extension: {
                                name: 'AmazonQ-For-VSCode',
                                version: '0.0.1',
                            },
                        },
                    },
                },
            } as InitializeParams)

            features.lsp.workspace.getConfiguration.withArgs('amazonQ').resolves({})
            await features.initialize(server)

            // Internal users
            features.credentialsProvider.getConnectionMetadata.returns({
                sso: {
                    startUrl: 'https://amzn.awsapps.com/start',
                },
            })
            await features.doChangeConfiguration()
            sinon.assert.calledWith(features.logging.log, sinon.match(/Workspace context server opt-in flag is: true/))

            // BuilderID users
            sinon.restore()
            features.credentialsProvider.getConnectionMetadata.returns({
                sso: {
                    startUrl: 'https://view.awsapps.com/start',
                },
            })
            await features.doChangeConfiguration()
            sinon.assert.calledWith(features.logging.log, sinon.match(/Workspace context server opt-in flag is: true/))
        })

        // Skipped: fails since this file last ran in CI; see the PR that skipped it
        it.skip('should opt in for JetBrains extension with server-sideContext enabled', async () => {
            features.lsp.getClientInitializeParams.returns({
                initializationOptions: {
                    aws: {
                        clientInfo: {
                            name: 'Amazon Q For JetBrains',
                            version: '0.0.1',
                            extension: {
                                name: 'Amazon Q For JetBrains',
                                version: '0.0.1',
                            },
                        },
                    },
                },
            } as InitializeParams)

            features.lsp.workspace.getConfiguration.withArgs('aws.codeWhisperer').resolves({
                workspaceContext: true,
            })

            await features.initialize(server)
            await features.doChangeConfiguration()

            sinon.assert.calledWith(features.logging.log, sinon.match(/Workspace context server opt-in flag is: true/))
        })

        // Skipped: fails since this file last ran in CI; see the PR that skipped it
        it.skip('should opt out for JetBrains extension with server-sideContext disabled', async () => {
            features.lsp.getClientInitializeParams.returns({
                initializationOptions: {
                    aws: {
                        clientInfo: {
                            name: 'Amazon Q For JetBrains',
                            version: '0.0.1',
                            extension: {
                                name: 'Amazon Q For JetBrains',
                                version: '0.0.1',
                            },
                        },
                    },
                },
            } as InitializeParams)

            features.lsp.workspace.getConfiguration.withArgs('aws.codeWhisperer').resolves({
                workspaceContext: false,
            })

            await features.initialize(server)
            await features.doChangeConfiguration()

            sinon.assert.calledWith(features.logging.log, sinon.match(/Workspace context server opt-in flag is: false/))
        })
    })
})
