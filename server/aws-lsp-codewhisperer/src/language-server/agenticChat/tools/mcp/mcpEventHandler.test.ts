/*!
 * Copyright Amazon.com, Inc. or its affiliates.
 * All Rights Reserved. SPDX-License-Identifier: Apache-2.0
 */

import { expect } from 'chai'
import * as sinon from 'sinon'
import { McpEventHandler } from './mcpEventHandler'
import { McpManager } from './mcpManager'
import { MCPServerConfig, McpServerStatus } from './mcpTypes'
import { ProfileStatusMonitor } from './profileStatusMonitor'
import * as mcpUtils from './mcpUtils'
import { getGlobalAgentConfigPath } from './mcpUtils'
import { TelemetryService } from '../../../../shared/telemetry/telemetryService'

describe('McpEventHandler error handling', () => {
    // Mock getGlobalAgentConfigPath to return a test path
    beforeEach(() => {
        sinon.stub(mcpUtils, 'getGlobalAgentConfigPath').returns('/fake/home/.aws/amazonq/agents/default.json')
        saveAgentConfigStub = sinon.stub(mcpUtils, 'saveAgentConfig').resolves()
    })
    let eventHandler: McpEventHandler
    let features: any
    let telemetryService: TelemetryService
    let loadStub: sinon.SinonStub
    let saveAgentConfigStub: sinon.SinonStub

    beforeEach(() => {
        sinon.restore()

        // Create fake features
        features = {
            logging: {
                log: sinon.spy(),
                info: sinon.spy(),
                warn: sinon.spy(),
                error: sinon.spy(),
                debug: sinon.spy(),
            },
            workspace: {
                fs: {
                    exists: sinon.stub().resolves(false),
                    readFile: sinon.stub().resolves(Buffer.from('{}')),
                    writeFile: sinon.stub().resolves(undefined),
                    getUserHomeDir: sinon.stub().returns('/fake/home'),
                },
                getAllWorkspaceFolders: sinon.stub().returns([{ uri: '/fake/workspace' }]),
            },
            chat: {
                sendChatUpdate: sinon.spy(),
            },
            agent: {
                getTools: sinon.stub().returns([]),
                getBuiltInToolNames: sinon
                    .stub()
                    .returns([
                        'fsRead',
                        'fsWrite',
                        'executeBash',
                        'listDirectory',
                        'fileSearch',
                        'codeReview',
                        'displayFindings',
                    ]),
            },
            lsp: {},
            telemetry: {
                emitMetric: sinon.spy(),
                onClientTelemetry: sinon.stub(),
            },
            credentialsProvider: {
                getConnectionMetadata: sinon.stub().returns({}),
            },
            runtime: {
                serverInfo: {},
            },
        }

        // Create mock telemetry service
        telemetryService = {
            emitUserTriggerDecision: sinon.stub(),
            emitChatInteractWithMessage: sinon.stub(),
            emitUserModificationEvent: sinon.stub(),
            emitCodeCoverageEvent: sinon.stub(),
        } as unknown as TelemetryService

        // Create the event handler
        eventHandler = new McpEventHandler(features, telemetryService)

        // Default loadAgentConfig stub will be set in each test as needed
    })

    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('displays config load errors in the header status', async () => {
        // Create mock errors
        const mockErrors = new Map<string, string>([
            ['file1.json', 'File not found error'],
            ['serverA', 'Missing command error'],
        ])

        // Stub loadAgentConfig to return errors
        loadStub = sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
            servers: new Map(),
            serverNameMapping: new Map(),
            errors: mockErrors,
            agentConfig: {
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: {},
                tools: [],
                allowedTools: [],
                toolsSettings: {},
                includedFiles: [],
                resources: [],
            },
        })

        // Initialize McpManager with errors
        await McpManager.init([], features)

        // Stub getConfigLoadErrors to return formatted errors
        sinon
            .stub(McpManager.instance, 'getConfigLoadErrors')
            .returns('File: file1.json, Error: File not found error\n\nFile: serverA, Error: Missing command error')

        // Call onListMcpServers
        const result = await eventHandler.onListMcpServers({})

        // Verify error is displayed in header status
        expect(result.header).to.not.be.undefined
        if ('status' in result.header) {
            expect(result.header.status).to.not.be.undefined
            expect(result.header.status!.status).to.equal('error')
            expect(result.header.status!.title).to.include('File: file1.json, Error: File not found error')
            expect(result.header.status!.title).to.include('File: serverA, Error: Missing command error')
        }
    })

    it('marks servers with validation errors as FAILED', async () => {
        // Create a server config with an error
        const serverConfig = new Map([
            [
                'errorServer',
                {
                    command: '', // Invalid - missing command
                    args: [],
                    env: {},
                    disabled: false,
                    __configPath__: 'config.json',
                },
            ],
        ])

        // Make sure previous stubs are restored
        sinon.restore()
        sinon.stub(mcpUtils, 'getGlobalAgentConfigPath').returns('/fake/home/.aws/amazonq/agents/default.json')
        saveAgentConfigStub = sinon.stub(mcpUtils, 'saveAgentConfig').resolves()

        // Stub loadAgentConfig to return a server with validation errors
        loadStub = sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
            servers: serverConfig,
            serverNameMapping: new Map(),
            errors: new Map([['errorServer', 'Missing command error']]),
            agentConfig: {
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: { errorServer: { command: '' } },
                tools: ['@errorServer'],
                allowedTools: [],
                toolsSettings: {},
                includedFiles: [],
                resources: [],
            },
        })

        // Initialize McpManager with the problematic server
        await McpManager.init([], features)

        // Stub getAllServerConfigs to return our test server
        sinon.stub(McpManager.instance, 'getAllServerConfigs').returns(serverConfig)

        // Stub getConfigLoadErrors to return formatted errors
        sinon
            .stub(McpManager.instance, 'getConfigLoadErrors')
            .returns('File: errorServer, Error: Missing command error')

        // Call onListMcpServers
        const result = await eventHandler.onListMcpServers({})

        // Find the server in the result
        const serverGroup = result.list.find(
            group => group.children && group.children.some(item => item.title === 'errorServer')
        )

        expect(serverGroup).to.not.be.undefined
        expect(serverGroup?.children).to.not.be.undefined

        const serverItem = serverGroup?.children?.find(item => item.title === 'errorServer')
        expect(serverItem).to.not.be.undefined
        expect(serverItem?.children).to.not.be.undefined
        expect(serverItem?.children?.[0]).to.not.be.undefined
        expect(serverItem?.children?.[0].children).to.not.be.undefined

        // Find the status in the server item's children
        const statusItem = serverItem?.children?.[0].children?.find(item => item.title === 'status')
        expect(statusItem).to.not.be.undefined
        expect(statusItem?.description).to.equal('FAILED')
    })

    describe('MCP server list regressions', () => {
        async function setupServers(
            configs: Map<string, MCPServerConfig>,
            statuses: Record<string, McpServerStatus>,
            reasons: Record<string, string> = {}
        ) {
            sinon.stub(ProfileStatusMonitor, 'getMcpState').returns(true)
            const mgr = await McpManager.init([], features)
            sinon.stub(mgr, 'getAllServerConfigs').returns(configs)
            sinon.stub(mgr, 'getAllToolsWithPermissions').returns([])
            sinon.stub(mgr, 'isServerDisabled').callsFake(name => configs.get(name)?.disabled ?? false)
            const states = new Map(
                Object.entries(statuses).map(([name, status]) => [
                    name,
                    { status, toolsCount: 0, lastError: reasons[name] },
                ])
            )
            sinon.stub(mgr, 'getServerState').callsFake(name => states.get(name))
            sinon.stub(mgr, 'getAllServerStates').returns(states)
        }

        for (const [name, status, disabled, command, expectedGroup] of [
            ['allowed', McpServerStatus.ENABLED, false, 'node', 'Active'],
            ['initializing', McpServerStatus.INITIALIZING, false, 'node', 'Active'],
            ['untrusted', McpServerStatus.UNINITIALIZED, false, 'node', 'Active'],
            ['invalid', McpServerStatus.FAILED, false, '', 'Active'],
            ['denied', McpServerStatus.DISABLED, false, 'node', 'Denied'],
            ['disabled', McpServerStatus.DISABLED, true, 'node', 'Disabled'],
        ] as const) {
            it(`includes a single ${name} server in ${expectedGroup}`, async () => {
                const configs = new Map([[name, { command, disabled }]])
                await setupServers(
                    configs,
                    { [name]: status },
                    name === 'denied' ? { [name]: 'consent not granted' } : {}
                )

                const result = await eventHandler.onListMcpServers({})

                expect(result.list).to.have.lengthOf(1)
                expect(result.list[0].groupName).to.equal(expectedGroup)
                expect(result.list[0].children?.map(item => item.title)).to.deep.equal([name])
                expect(result.list[0].children?.[0].children?.[0].children?.[0].description).to.equal(status)
                expect(configs.get(name)?.disabled).to.equal(disabled)
            })
        }

        it('keeps the remaining server after deleting from two down to one', async () => {
            const configs = new Map([
                ['first', { command: 'node' }],
                ['second', { command: 'node' }],
            ])
            await setupServers(configs, { first: McpServerStatus.ENABLED, second: McpServerStatus.ENABLED })
            const before = await eventHandler.onListMcpServers({})
            expect(before.list[0].children).to.have.lengthOf(2)

            configs.delete('first')
            const after = await eventHandler.onListMcpServers({})
            expect(after.list).to.have.lengthOf(1)
            expect(after.list[0].children?.map(item => item.title)).to.deep.equal(['second'])
        })

        it('separates consent denial from both active and explicitly disabled servers', async () => {
            const configs = new Map([
                ['allowed', { command: 'node', disabled: false }],
                ['denied', { command: 'node', disabled: false }],
                ['disabled', { command: 'node', disabled: true }],
            ])
            await setupServers(
                configs,
                {
                    allowed: McpServerStatus.ENABLED,
                    denied: McpServerStatus.DISABLED,
                    disabled: McpServerStatus.DISABLED,
                },
                { denied: 'consent not granted' }
            )

            const result = await eventHandler.onListMcpServers({})

            expect(result.list.map(group => [group.groupName, group.children?.map(item => item.title)])).to.deep.equal([
                ['Active', ['allowed']],
                ['Denied', ['denied']],
                ['Disabled', ['disabled']],
            ])
            expect(result.list[1].children?.[0].description).to.equal('consent not granted')
            expect(configs.get('denied')?.disabled).to.be.false
        })

        it('preserves the consent explanation when opening a denied server', async () => {
            await setupServers(
                new Map([['denied', { command: 'node', disabled: false }]]),
                { denied: McpServerStatus.DISABLED },
                { denied: 'consent not granted' }
            )
            const permissionUpdate = sinon.spy(McpManager.instance, 'updateServerPermission')

            const result = await eventHandler.onMcpServerClick({ id: 'open-mcp-server', title: 'denied' })

            expect(result.header.status.title).to.equal('consent not granted')
            sinon.assert.notCalled(permissionUpdate)
        })

        it('keeps an explicit disable in Disabled even if a prior denial reason remains', async () => {
            await setupServers(
                new Map([['disabled', { command: 'node', disabled: true }]]),
                { disabled: McpServerStatus.DISABLED },
                { disabled: 'consent not granted' }
            )

            const result = await eventHandler.onListMcpServers({})

            expect(result.list.map(group => group.groupName)).to.deep.equal(['Disabled'])
        })

        it('does not label other runtime-disabled states as consent denial', async () => {
            await setupServers(new Map([['disabled', { command: 'node', disabled: false }]]), {
                disabled: McpServerStatus.DISABLED,
            })

            const result = await eventHandler.onListMcpServers({})

            expect(result.list.map(group => group.groupName)).to.deep.equal(['Disabled'])
        })
    })

    it('handles server click events for fixing failed servers', async () => {
        // Make sure previous stubs are restored
        sinon.restore()
        sinon.stub(mcpUtils, 'getGlobalAgentConfigPath').returns('/fake/home/.aws/amazonq/agents/default.json')
        saveAgentConfigStub = sinon.stub(mcpUtils, 'saveAgentConfig').resolves()

        // Stub loadAgentConfig
        loadStub = sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
            servers: new Map(),
            serverNameMapping: new Map(),
            errors: new Map(),
            agentConfig: {
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: {},
                tools: [],
                allowedTools: [],
                toolsSettings: {},
                includedFiles: [],
                resources: [],
            },
        })

        // Initialize McpManager
        await McpManager.init([], features)

        // Call onMcpServerClick with mcp-fix-server action
        const result = await eventHandler.onMcpServerClick({
            id: 'mcp-fix-server',
            title: 'errorServer',
        })

        // Verify it redirects to edit server view
        expect(result.id).to.equal('mcp-fix-server')
        expect(result.header).to.not.be.undefined
        expect(result.header.title).to.equal('Edit MCP Server')
    })

    describe('#getListMcpServersStatus', () => {
        beforeEach(() => {
            sinon.restore()
            sinon.stub(mcpUtils, 'getGlobalAgentConfigPath').returns('/fake/home/.aws/amazonq/agents/default.json')
            saveAgentConfigStub = sinon.stub(mcpUtils, 'saveAgentConfig').resolves()
        })

        it('returns admin disabled status when MCP state is false and no config errors', async () => {
            // Stub ProfileStatusMonitor.getMcpState to return false
            const { ProfileStatusMonitor } = await import('./profileStatusMonitor')
            sinon.stub(ProfileStatusMonitor, 'getMcpState').returns(false)

            loadStub = sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
                servers: new Map(),
                serverNameMapping: new Map(),
                errors: new Map(),
                agentConfig: {
                    name: 'test-agent',
                    description: 'Test agent',
                    mcpServers: {},
                    tools: [],
                    allowedTools: [],
                    toolsSettings: {},
                    includedFiles: [],
                    resources: [],
                },
            })

            await McpManager.init([], features)
            const result = await eventHandler.onListMcpServers({})

            if ('status' in result.header) {
                expect(result.header.status).to.deep.equal({
                    title: 'MCP functionality has been disabled by your administrator',
                    icon: 'info',
                    status: 'info',
                })
            }
        })

        it('returns config error status when MCP state is false but config errors exist', async () => {
            // Stub ProfileStatusMonitor.getMcpState to return false
            const { ProfileStatusMonitor } = await import('./profileStatusMonitor')
            sinon.stub(ProfileStatusMonitor, 'getMcpState').returns(false)

            const mockErrors = new Map([['file1.json', 'Config error']])
            loadStub = sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
                servers: new Map(),
                serverNameMapping: new Map(),
                errors: mockErrors,
                agentConfig: {
                    name: 'test-agent',
                    description: 'Test agent',
                    mcpServers: {},
                    tools: [],
                    allowedTools: [],
                    toolsSettings: {},
                    includedFiles: [],
                    resources: [],
                },
            })

            await McpManager.init([], features)
            sinon.stub(McpManager.instance, 'getConfigLoadErrors').returns('File: file1.json, Error: Config error')

            const result = await eventHandler.onListMcpServers({})

            // Admin disabled message should take priority over non-registry config errors
            if ('status' in result.header) {
                expect(result.header.status).to.deep.equal({
                    title: 'MCP functionality has been disabled by your administrator',
                    icon: 'info',
                    status: 'info',
                })
            }
        })

        it('returns config error status when MCP state is not false but config errors exist', async () => {
            // Stub ProfileStatusMonitor.getMcpState to return true
            const { ProfileStatusMonitor } = await import('./profileStatusMonitor')
            sinon.stub(ProfileStatusMonitor, 'getMcpState').returns(true)

            const mockErrors = new Map([['file1.json', 'Config error']])
            loadStub = sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
                servers: new Map(),
                serverNameMapping: new Map(),
                errors: mockErrors,
                agentConfig: {
                    name: 'test-agent',
                    description: 'Test agent',
                    mcpServers: {},
                    tools: [],
                    allowedTools: [],
                    toolsSettings: {},
                    includedFiles: [],
                    resources: [],
                },
            })

            await McpManager.init([], features)
            sinon.stub(McpManager.instance, 'getConfigLoadErrors').returns('File: file1.json, Error: Config error')

            const result = await eventHandler.onListMcpServers({})

            if ('status' in result.header) {
                expect(result.header.status).to.deep.equal({
                    title: 'File: file1.json, Error: Config error',
                    icon: 'cancel-circle',
                    status: 'error',
                })
            }
        })

        it('returns undefined status when MCP state is not false and no config errors', async () => {
            // Stub ProfileStatusMonitor.getMcpState to return true
            const { ProfileStatusMonitor } = await import('./profileStatusMonitor')
            sinon.stub(ProfileStatusMonitor, 'getMcpState').returns(true)

            loadStub = sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
                servers: new Map(),
                serverNameMapping: new Map(),
                errors: new Map(),
                agentConfig: {
                    name: 'test-agent',
                    description: 'Test agent',
                    mcpServers: {},
                    tools: [],
                    allowedTools: [],
                    toolsSettings: {},
                    includedFiles: [],
                    resources: [],
                },
            })

            await McpManager.init([], features)
            sinon.stub(McpManager.instance, 'getConfigLoadErrors').returns(undefined)

            const result = await eventHandler.onListMcpServers({})

            if ('status' in result.header) {
                expect(result.header.status).to.be.undefined
            }
        })
    })
})
