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
import { ChokidarFileWatcher } from './chokidarFileWatcher'
import { getFolderApprovalsPath } from './mcpWorkspaceTrust'

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
                    mkdir: sinon.stub().resolves(undefined),
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

        describe('servers held back by the workspace trust check', () => {
            const trustHoldCases = [
                {
                    trust: 'restricted',
                    hold: 'waiting',
                    reason: 'Waiting for workspace trust. Trust this project in your IDE to start it.',
                },
                { trust: 'prompt', hold: 'waiting', reason: 'Waiting for you to allow this folder.' },
                {
                    trust: 'prompt',
                    hold: 'declined',
                    reason: 'Not allowed in this folder. Refresh the server list to choose again.',
                },
                { trust: 'trusted', hold: 'waiting', reason: 'Waiting for workspace trust.' },
            ] as const

            for (const { trust, hold, reason } of trustHoldCases) {
                it(`lists a ${hold} server in ${trust} mode with what starts it`, async () => {
                    await setupServers(new Map([['held', { command: 'npx', disabled: false }]]), {
                        held: McpServerStatus.DISABLED,
                    })
                    sinon.stub(McpManager.instance, 'getTrustHold').returns(hold)
                    sinon.stub(McpManager.instance, 'getWorkspaceTrust').returns(trust)

                    const result = await eventHandler.onListMcpServers({})

                    expect(result.list.map(group => group.groupName)).to.deep.equal(['Waiting for trust'])
                    expect(result.list[0].children?.[0].description).to.equal(reason)
                })
            }

            it('shows the reason as a warning when opening a held server', async () => {
                await setupServers(
                    new Map([['held', { command: 'npx', disabled: false }]]),
                    { held: McpServerStatus.DISABLED },
                    { held: 'Waiting for workspace trust' }
                )
                sinon.stub(McpManager.instance, 'getTrustHold').returns('waiting')
                sinon.stub(McpManager.instance, 'getWorkspaceTrust').returns('restricted')

                const result = await eventHandler.onMcpServerClick({ id: 'open-mcp-server', title: 'held' })

                expect(result.header.status).to.deep.equal({
                    title: 'Waiting for workspace trust. Trust this project in your IDE to start it.',
                    icon: 'warning',
                    status: 'warning',
                })
            })

            describe('saving a server that the trust check holds back', () => {
                const saveParams = {
                    id: 'save-mcp',
                    optionsValues: {
                        name: 'held',
                        transport: 'stdio',
                        command: 'npx',
                        args: [],
                        env_variables: [],
                        timeout: '60',
                        scope: 'global',
                    },
                } as any

                async function save(hold: 'waiting' | undefined, lastError: string) {
                    await setupServers(
                        new Map([['held', { command: 'npx', disabled: false }]]),
                        { held: McpServerStatus.DISABLED },
                        { held: lastError }
                    )
                    const mgr = McpManager.instance
                    sinon.stub(mgr, 'getTrustHold').returns(hold)
                    sinon.stub(mgr, 'getWorkspaceTrust').returns('restricted')
                    sinon.stub(mgr, 'addServer').resolves()
                    const removeFromFile = sinon.stub(mgr, 'removeServerFromConfigFile').resolves()
                    const result = await eventHandler.onMcpServerClick(saveParams)
                    return { result, removeFromFile }
                }

                it('keeps the saved server and shows why it is not running yet', async () => {
                    const { result, removeFromFile } = await save('waiting', 'Waiting for workspace trust')

                    sinon.assert.notCalled(removeFromFile)
                    expect(result.header.status).to.deep.equal({
                        title: 'Waiting for workspace trust. Trust this project in your IDE to start it.',
                        icon: 'warning',
                        status: 'warning',
                    })
                })

                it('still removes a server that failed to start', async () => {
                    const { removeFromFile } = await save(undefined, 'spawn npx ENOENT')

                    sinon.assert.calledOnceWithExactly(removeFromFile, 'held')
                })
            })

            for (const registry of [false, true]) {
                it(`shows a held server as a warning with a normal Save when editing it${registry ? ' from a registry' : ''}`, async () => {
                    await setupServers(
                        new Map([['held', { command: 'npx', disabled: false }]]),
                        { held: McpServerStatus.DISABLED },
                        { held: 'Waiting for workspace trust' }
                    )
                    const mgr = McpManager.instance
                    sinon.stub(mgr, 'getTrustHold').returns('waiting')
                    sinon.stub(mgr, 'getWorkspaceTrust').returns('restricted')
                    sinon.stub(mgr, 'getRegistryService').returns({ isRegistryActive: () => registry } as any)

                    const result: any = await eventHandler.onMcpServerClick({ id: 'edit-mcp', title: 'held' })

                    expect(result.header.status.status).to.equal('warning')
                    expect(result.filterActions.find((a: any) => a.id === 'save-mcp').status).to.equal('primary')
                    if (registry) {
                        // Disable and delete stay available from the details menu
                        expect(result.header.actions.map((a: any) => a.id)).to.deep.equal(['mcp-details-menu'])
                    }
                })
            }

            it('keeps a server the user disabled in Disabled', async () => {
                await setupServers(new Map([['held', { command: 'npx', disabled: true }]]), {
                    held: McpServerStatus.DISABLED,
                })
                sinon.stub(McpManager.instance, 'getTrustHold').returns('waiting')

                const result = await eventHandler.onListMcpServers({})

                expect(result.list.map(group => group.groupName)).to.deep.equal(['Disabled'])
            })

            it('lists held servers after active ones and before denied and disabled ones', async () => {
                const configs = new Map([
                    ['allowed', { command: 'node', disabled: false }],
                    ['held', { command: 'npx', disabled: false }],
                    ['denied', { command: 'node', disabled: false }],
                    ['disabled', { command: 'node', disabled: true }],
                ])
                await setupServers(
                    configs,
                    {
                        allowed: McpServerStatus.ENABLED,
                        held: McpServerStatus.DISABLED,
                        denied: McpServerStatus.DISABLED,
                        disabled: McpServerStatus.DISABLED,
                    },
                    { denied: 'consent not granted' }
                )
                sinon
                    .stub(McpManager.instance, 'getTrustHold')
                    .callsFake(name => (name === 'held' ? 'waiting' : undefined))
                sinon.stub(McpManager.instance, 'getWorkspaceTrust').returns('restricted')

                const result = await eventHandler.onListMcpServers({})

                expect(
                    result.list.map(group => [group.groupName, group.children?.map(item => item.title)])
                ).to.deep.equal([
                    ['Active', ['allowed']],
                    ['Waiting for trust', ['held']],
                    ['Denied', ['denied']],
                    ['Disabled', ['disabled']],
                ])
            })
        })

        it('does not label other runtime-disabled states as consent denial', async () => {
            await setupServers(new Map([['disabled', { command: 'node', disabled: false }]]), {
                disabled: McpServerStatus.DISABLED,
            })

            const result = await eventHandler.onListMcpServers({})

            expect(result.list.map(group => group.groupName)).to.deep.equal(['Disabled'])
        })
    })

    describe('folders declined in the folder prompt', () => {
        beforeEach(async () => {
            sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
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
        })

        it('are asked again when the user refreshes the server list', async () => {
            const clear = sinon.spy(McpManager.instance, 'clearDeclinedFolders')
            sinon.stub(McpManager.instance, 'reinitializeMcpServers').resolves()

            await eventHandler.onMcpServerClick({ id: 'refresh-mcp-list' })

            expect(clear.calledOnce).to.be.true
        })

        it('are asked again when the user enables a server', async () => {
            const clear = sinon.spy(McpManager.instance, 'clearDeclinedFolders')
            sinon
                .stub(McpManager.instance, 'getAllServerConfigs')
                .returns(new Map([['svc', { command: 'node', __configPath__: '/fake/home/mcp.json' }]]))
            sinon.stub(McpManager.instance, 'getMcpServerPermissions').returns({ enabled: false, toolPerms: {} })
            const update = sinon.stub(McpManager.instance, 'updateServerPermission').resolves()

            await eventHandler.onMcpServerClick({ id: 'mcp-enable-server', title: 'svc' })

            expect(clear.calledOnce).to.be.true
            expect(clear.calledBefore(update)).to.be.true
        })

        const forgetActionShown = async () => {
            const result: any = await eventHandler.onListMcpServers({})
            return (result.header?.actions ?? []).some((a: any) => a.id === 'forget-mcp-folder-approvals')
        }

        it('offers to forget allowed folders only while Amazon Q asks about folders itself', async () => {
            const trust = sinon.stub(McpManager.instance, 'getWorkspaceTrust').returns('prompt')
            expect(await forgetActionShown()).to.be.true

            trust.returns('trusted')
            expect(await forgetActionShown()).to.be.false
            trust.returns('restricted')
            expect(await forgetActionShown()).to.be.false
        })

        it('re-checks servers when the folder approval file changes', async () => {
            const watch = sinon.stub(ChokidarFileWatcher.prototype, 'watchPaths')
            const changed = sinon.stub(McpManager.instance, 'onFolderApprovalsChanged').resolves()
            const mkdir = features.workspace.fs.mkdir as sinon.SinonStub
            mkdir.resetHistory()
            new McpEventHandler(features, telemetryService)
            await new Promise(resolve => setImmediate(resolve))

            // The folder is created first, because the watcher reports nothing for a file in a missing folder
            const file = getFolderApprovalsPath(features.workspace) as string
            expect(mkdir.calledWith(require('path').dirname(file), { recursive: true })).to.be.true
            const call = watch.getCalls().find(c => c.args[0][0] === file)
            expect(call && mkdir.firstCall.calledBefore(call)).to.be.true
            expect(call?.args[2]).to.deep.equal({ includeUnlink: true })
            call!.args[1]('changed')
            expect(changed.calledOnce).to.be.true
        })

        it('still watches the folder approval file when its folder cannot be created', async () => {
            const watch = sinon.stub(ChokidarFileWatcher.prototype, 'watchPaths')
            ;(features.workspace.fs.mkdir as sinon.SinonStub).rejects(new Error('read-only file system'))
            new McpEventHandler(features, telemetryService)
            await new Promise(resolve => setImmediate(resolve))

            const file = getFolderApprovalsPath(features.workspace)
            expect(watch.getCalls().some(c => c.args[0][0] === file)).to.be.true
        })

        it('does not start watching the folder approval file after it was disposed', async () => {
            const watch = sinon.stub(ChokidarFileWatcher.prototype, 'watchPaths')
            new McpEventHandler(features, telemetryService).dispose()
            await new Promise(resolve => setImmediate(resolve))

            const file = getFolderApprovalsPath(features.workspace)
            expect(watch.getCalls().some(c => c.args[0][0] === file)).to.be.false
        })

        describe('forgetting allowed folders', () => {
            let showMessageRequest: sinon.SinonStub
            let showMessage: sinon.SinonStub

            beforeEach(() => {
                showMessageRequest = sinon.stub()
                showMessage = sinon.stub().resolves()
                features.lsp.window = { showMessageRequest, showMessage }
            })

            afterEach(() => {
                delete features.lsp.window
            })

            it('forgets after the user confirms and asks the chat client to list the servers again', async () => {
                showMessageRequest.resolves({ title: 'Forget allowed folders' })
                const forget = sinon.stub(McpManager.instance, 'forgetFolderApprovals').resolves(true)

                const result = await eventHandler.onMcpServerClick({ id: 'forget-mcp-folder-approvals' })

                expect(showMessageRequest.firstCall.args[0].message).to.include('stop')
                expect(forget.calledOnce).to.be.true
                expect(showMessage.called).to.be.false
                expect(result).to.deep.equal({ id: 'update-mcp-list' })
            })

            it('forgets nothing when the user cancels or dismisses the confirmation', async () => {
                const forget = sinon.stub(McpManager.instance, 'forgetFolderApprovals').resolves(true)
                showMessageRequest.onFirstCall().resolves({ title: 'Cancel' })
                showMessageRequest.onSecondCall().resolves(null)
                showMessageRequest.onThirdCall().rejects(new Error('no dialog'))

                for (let i = 0; i < 3; i++) {
                    await eventHandler.onMcpServerClick({ id: 'forget-mcp-folder-approvals' })
                }

                expect(forget.called).to.be.false
            })

            it('tells the user when the saved approvals could not be cleared', async () => {
                showMessageRequest.resolves({ title: 'Forget allowed folders' })
                sinon.stub(McpManager.instance, 'forgetFolderApprovals').resolves(false)

                await eventHandler.onMcpServerClick({ id: 'forget-mcp-folder-approvals' })

                expect(showMessage.calledOnce).to.be.true
                expect(showMessage.firstCall.args[0].message).to.include(
                    getFolderApprovalsPath(features.workspace) as string
                )
            })

            it('tells the user when forgetting fails', async () => {
                showMessageRequest.resolves({ title: 'Forget allowed folders' })
                sinon.stub(McpManager.instance, 'forgetFolderApprovals').rejects(new Error('boom'))

                await eventHandler.onMcpServerClick({ id: 'forget-mcp-folder-approvals' })

                expect(showMessage.calledOnce).to.be.true
            })
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
