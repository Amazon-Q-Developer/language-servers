/*!
 * Copyright Amazon.com, Inc. or its affiliates.
 * All Rights Reserved. SPDX-License-Identifier: Apache-2.0
 */

import { expect } from 'chai'
import * as sinon from 'sinon'
import { AGENT_TOOLS_CHANGED, MCP_SERVER_STATUS_CHANGED, McpManager } from './mcpManager'
import * as mcpUtils from './mcpUtils'
import { McpPermissionType, McpServerStatus, type MCPServerConfig, type MCPServerPermission } from './mcpTypes'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ProfileStatusMonitor } from './profileStatusMonitor'

const fakeLogging = {
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
}
const fakeWorkspace = {
    fs: {
        exists: (_: string) => Promise.resolve(false),
        readFile: (_: string) => Promise.resolve(Buffer.from('{}')),
        writeFile: (_: string, _d: string) => Promise.resolve(),
        getUserHomeDir: () => '',
        mkdir: (_: string, __: any) => Promise.resolve(),
    },
    getUserHomeDir: () => '',
    getAllWorkspaceFolders: () => [{ uri: '/fake/workspace' }],
}
const features = {
    logging: fakeLogging,
    workspace: fakeWorkspace,
    lsp: {},
    telemetry: { emitMetric: () => {} },
    credentialsProvider: { getConnectionMetadata: () => ({}) },
    runtime: { serverInfo: { version: '1.0.0' } },
    agent: {
        getBuiltInToolNames: () => [
            'fsRead',
            'fsWrite',
            'executeBash',
            'listDirectory',
            'fileSearch',
            'codeReview',
            'displayFindings',
        ],
    },
} as any

function stubAgentConfig(): sinon.SinonStub {
    return sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
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
}

function stubInitOneServer(): sinon.SinonStub {
    return sinon.stub(McpManager.prototype as any, 'initOneServer' as keyof McpManager).callsFake(async function (
        this: any,
        ...args: any[]
    ) {
        const serverName = args[0] as string
        this.clients.set(serverName, new Client({ name: 'stub', version: '0.0.0' }))
        this.mcpTools.push({
            serverName,
            toolName: 'tool1',
            description: 'desc',
            inputSchema: {},
        })
        ;(this as any).setState(serverName, 'ENABLED', 1)
    })
}

describe('init()', () => {
    let loadStub: sinon.SinonStub

    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('returns the same instance', async () => {
        loadStub = stubAgentConfig()

        const m1 = await McpManager.init([], features)
        const m2 = await McpManager.init([], features)
        expect(m1).to.equal(m2)
    })
})

describe('getAllTools()', () => {
    let loadStub: sinon.SinonStub

    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('returns empty array when no servers', async () => {
        loadStub = stubAgentConfig()

        const mgr = await McpManager.init([], features)
        expect(mgr.getAllTools()).to.be.an('array').that.is.empty
    })
})

describe('callTool()', () => {
    let loadStub: sinon.SinonStub
    let initOneStub: sinon.SinonStub
    let callToolStub: sinon.SinonStub

    const enabledCfg: MCPServerConfig = {
        command: 'c',
        args: [],
        env: {},
        timeout: 0,
        disabled: false,
        __configPath__: 'p.json',
    }

    beforeEach(() => {
        initOneStub = stubInitOneServer()
        callToolStub = sinon.stub(Client.prototype as any, 'callTool' as any).resolves('ok' as any)
    })

    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('throws when server is unknown', async () => {
        loadStub = stubAgentConfig()
        const mgr = await McpManager.init([], features)

        try {
            await mgr.callTool('nope', 'foo', {})
            throw new Error('should have thrown')
        } catch (err: any) {
            expect(err.message).to.equal("MCP: server 'nope' is not configured")
        }
    })

    it('throws when server is disabled', async () => {
        const disabledCfg: MCPServerConfig = {
            command: 'c',
            args: [],
            env: {},
            timeout: 0,
            disabled: true,
            __configPath__: 'p.json',
        }

        loadStub = sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
            servers: new Map([['s1', disabledCfg]]),
            serverNameMapping: new Map(),
            errors: new Map(),
            agentConfig: {
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: { s1: disabledCfg },
                tools: ['@s1'],
                allowedTools: [],
                toolsSettings: {},
                includedFiles: [],
                resources: [],
            },
        })
        const mgr = await McpManager.init(['p.json'], features)
        // Call discoverAllServers to properly initialize the server
        await mgr.discoverAllServers()

        try {
            await mgr.callTool('s1', 'tool1', {})
            throw new Error('should have thrown')
        } catch (err: any) {
            expect(err.message).to.equal("MCP: server 's1' is disabled")
        }
    })

    it('invokes underlying client.callTool', async () => {
        loadStub = sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
            servers: new Map([['s1', enabledCfg]]),
            serverNameMapping: new Map(),
            errors: new Map(),
            agentConfig: {
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: { s1: enabledCfg },
                tools: ['@s1'],
                allowedTools: [],
                toolsSettings: {},
                includedFiles: [],
                resources: [],
            },
        })
        const mgr = await McpManager.init(['p.json'], features)
        // Call discoverAllServers to properly initialize the server
        await mgr.discoverAllServers()
        ;(mgr as any).clients.set('s1', new Client({ name: 'x', version: 'v' }))

        const res = await mgr.callTool('s1', 'tool1', { foo: 1 })
        expect(callToolStub.calledOnceWith({ name: 'tool1', arguments: { foo: 1 } })).to.be.true
        expect(res).to.equal('ok')
    })

    it('times out and logs error', async () => {
        const timeoutCfg = { ...enabledCfg, timeout: 1 }
        loadStub = sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
            servers: new Map([['s1', timeoutCfg]]),
            serverNameMapping: new Map(),
            errors: new Map(),
            agentConfig: {
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: { s1: timeoutCfg },
                tools: ['@s1'],
                allowedTools: [],
                toolsSettings: {},
                includedFiles: [],
                resources: [],
            },
        })
        const mgr = await McpManager.init(['p.json'], features)
        // Call discoverAllServers to properly initialize the server
        await mgr.discoverAllServers()

        callToolStub.resetBehavior()
        callToolStub.returns(new Promise(() => {}) as any)
        const spyErr = sinon.spy(fakeLogging, 'error')

        try {
            await mgr.callTool('s1', 'tool1', {})
            throw new Error('Expected callTool to throw on timeout')
        } catch (e: any) {
            expect(e.code).to.equal('MCPToolExecTimeout')
        }
        expect(spyErr.calledOnce).to.be.true
    })
})

describe('addServer()', () => {
    let loadStub: sinon.SinonStub
    let initOneStub: sinon.SinonStub
    let saveServerSpecificAgentConfigStub: sinon.SinonStub

    beforeEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
        loadStub = stubAgentConfig()
        initOneStub = stubInitOneServer()
        saveServerSpecificAgentConfigStub = sinon.stub(mcpUtils, 'saveServerSpecificAgentConfig').resolves()
    })

    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('persists config and initializes', async () => {
        const mgr = await McpManager.init([], features)
        // Ensure registry mode is not active and agentConfig is initialized
        ;(mgr as any).registryService = undefined
        ;(mgr as any).agentConfig = {
            name: 'test-agent',
            description: 'Test agent',
            mcpServers: {},
            tools: [],
            allowedTools: [],
            toolsSettings: {},
            includedFiles: [],
            resources: [],
        }

        const newCfg: MCPServerConfig = {
            command: 'c2',
            args: ['a'],
            env: { X: '1' },
            timeout: 0,
            disabled: false,
            __configPath__: 'path.json',
        }

        await mgr.addServer('newS', newCfg, 'path.json')

        expect(saveServerSpecificAgentConfigStub.calledOnce).to.be.true
        expect(initOneStub.called).to.be.true
    })

    it('persists and initializes an HTTP server', async () => {
        loadStub.resolves({
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
        const mgr = await McpManager.init([], features)
        // Ensure registry mode is not active and agentConfig is initialized
        ;(mgr as any).registryService = undefined
        ;(mgr as any).agentConfig = {
            name: 'test-agent',
            description: 'Test agent',
            mcpServers: {},
            tools: [],
            allowedTools: [],
            toolsSettings: {},
            includedFiles: [],
            resources: [],
        }

        const httpCfg: MCPServerConfig = {
            url: 'https://api.example.com/mcp',
            headers: { Authorization: 'Bearer 123' },
            timeout: 0,
            disabled: false,
            __configPath__: 'http.json',
        }

        await mgr.addServer('httpSrv', httpCfg, 'http.json')

        expect(saveServerSpecificAgentConfigStub.calledOnce).to.be.true
        expect(initOneStub.called).to.be.true
    })
})

describe('removeServer()', () => {
    let loadStub: sinon.SinonStub
    let saveServerSpecificAgentConfigStub: sinon.SinonStub
    let existsStub: sinon.SinonStub
    let readFileStub: sinon.SinonStub
    let writeFileStub: sinon.SinonStub
    let mkdirStub: sinon.SinonStub
    let getWorkspaceMcpConfigPathsStub: sinon.SinonStub
    let getGlobalMcpConfigPathStub: sinon.SinonStub

    beforeEach(() => {
        loadStub = stubAgentConfig()
        saveServerSpecificAgentConfigStub = sinon.stub(mcpUtils, 'saveServerSpecificAgentConfig').resolves()
        existsStub = sinon.stub(fakeWorkspace.fs, 'exists').resolves(true)
        readFileStub = sinon
            .stub(fakeWorkspace.fs, 'readFile')
            .resolves(Buffer.from(JSON.stringify({ mcpServers: { x: {} } })))
        writeFileStub = sinon.stub(fakeWorkspace.fs, 'writeFile').resolves()
        mkdirStub = sinon.stub(fakeWorkspace.fs, 'mkdir').resolves()
        getWorkspaceMcpConfigPathsStub = sinon
            .stub(mcpUtils, 'getWorkspaceMcpConfigPaths')
            .returns(['ws1/config.json', 'ws2/config.json'])
        getGlobalMcpConfigPathStub = sinon.stub(mcpUtils, 'getGlobalMcpConfigPath').returns('global/config.json')
    })

    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('shuts client and cleans state', async () => {
        const mgr = await McpManager.init([], features)
        const dummy = new Client({ name: 'c', version: 'v' })
        ;(mgr as any).clients.set('x', dummy)
        ;(mgr as any).mcpServers.set('x', {
            command: '',
            args: [],
            env: {},
            timeout: 0,
            disabled: false,
            __configPath__: 'c.json',
        } as MCPServerConfig)
        ;(mgr as any).serverNameMapping.set('x', 'x')
        ;(mgr as any).agentConfig = {
            name: 'test-agent',
            description: 'Test agent',
            mcpServers: { x: {} },
            tools: ['@x'],
            allowedTools: [],
            toolsSettings: {},
            includedFiles: [],
            resources: [],
        }

        await mgr.removeServer('x')
        expect(saveServerSpecificAgentConfigStub.calledOnce).to.be.true
        expect((mgr as any).clients.has('x')).to.be.false
    })

    it('removes server from agent config', async () => {
        const mgr = await McpManager.init([], features)
        const dummy = new Client({ name: 'c', version: 'v' })
        ;(mgr as any).clients.set('x', dummy)
        ;(mgr as any).mcpServers.set('x', {
            command: '',
            args: [],
            env: {},
            timeout: 0,
            disabled: false,
            __configPath__: 'c.json',
        } as MCPServerConfig)
        ;(mgr as any).serverNameMapping.set('x', 'x')
        ;(mgr as any).agentConfig = {
            name: 'test-agent',
            description: 'Test agent',
            mcpServers: { x: {} },
            tools: ['@x'],
            allowedTools: [],
            toolsSettings: {},
            includedFiles: [],
            resources: [],
        }

        await mgr.removeServer('x')

        // Verify that saveServerSpecificAgentConfig was called
        expect(saveServerSpecificAgentConfigStub.calledOnce).to.be.true
        expect((mgr as any).clients.has('x')).to.be.false

        // Verify server was removed from agent config
        expect((mgr as any).agentConfig.mcpServers).to.not.have.property('x')
        expect((mgr as any).agentConfig.tools).to.not.include('@x')
    })
})

describe('mutateConfigFile()', () => {
    let existsStub: sinon.SinonStub
    let readFileStub: sinon.SinonStub
    let writeFileStub: sinon.SinonStub
    let mkdirStub: sinon.SinonStub
    let mgr: McpManager

    beforeEach(async () => {
        sinon.restore()
        stubAgentConfig()
        existsStub = sinon.stub(fakeWorkspace.fs, 'exists').resolves(true)
        readFileStub = sinon
            .stub(fakeWorkspace.fs, 'readFile')
            .resolves(Buffer.from(JSON.stringify({ mcpServers: { test: {} } })))
        writeFileStub = sinon.stub(fakeWorkspace.fs, 'writeFile').resolves()
        mkdirStub = sinon.stub(fakeWorkspace.fs, 'mkdir').resolves()
        mgr = await McpManager.init([], features)
    })

    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('reads, mutates, and writes config file', async () => {
        // Access the private method using type assertion
        const mutateConfigFile = (mgr as any).mutateConfigFile.bind(mgr)

        await mutateConfigFile('test/path.json', (json: any) => {
            json.mcpServers.newServer = { command: 'test' }
            delete json.mcpServers.test
        })

        expect(readFileStub.calledOnce).to.be.true
        expect(writeFileStub.calledOnce).to.be.true

        // Verify the content was modified correctly
        const writtenContent = JSON.parse(writeFileStub.firstCall.args[1])
        expect(writtenContent.mcpServers).to.have.property('newServer')
        expect(writtenContent.mcpServers).to.not.have.property('test')
    })

    it('creates new config file if it does not exist', async () => {
        existsStub.resolves(false)
        readFileStub.rejects({ code: 'ENOENT' })

        // Access the private method using type assertion
        const mutateConfigFile = (mgr as any).mutateConfigFile.bind(mgr)

        await mutateConfigFile('test/path.json', (json: any) => {
            json.mcpServers.newServer = { command: 'test' }
        })

        expect(mkdirStub.calledOnce).to.be.true
        expect(writeFileStub.calledOnce).to.be.true

        // Verify the content was created correctly
        const writtenContent = JSON.parse(writeFileStub.firstCall.args[1])
        expect(writtenContent.mcpServers).to.have.property('newServer')
    })
})

describe('updateServer()', () => {
    let loadStub: sinon.SinonStub
    let initOneStub: sinon.SinonStub
    let saveServerSpecificAgentConfigStub: sinon.SinonStub

    beforeEach(() => {
        initOneStub = stubInitOneServer()
        saveServerSpecificAgentConfigStub = sinon.stub(mcpUtils, 'saveServerSpecificAgentConfig').resolves()
    })

    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('re‑initializes when changing timeout', async () => {
        const oldCfg: MCPServerConfig = {
            command: 'cmd',
            args: [],
            env: {},
            timeout: 1,
            __configPath__: 'u.json',
        }

        loadStub = sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
            servers: new Map([['u1', oldCfg]]),
            serverNameMapping: new Map([['u1', 'u1']]),
            errors: new Map(),
            agentConfig: {
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: { u1: oldCfg },
                tools: ['@u1'],
                allowedTools: [],
                toolsSettings: {},
                includedFiles: [],
                resources: [],
            },
        })

        await McpManager.init([], features)
        const mgr = McpManager.instance
        await mgr.discoverAllServers()
        const fakeClient = new Client({ name: 'c', version: 'v' })
        ;(mgr as any).clients.set('u1', fakeClient)

        const closeStub = sinon.stub(fakeClient, 'close').resolves()
        initOneStub.resetHistory()
        saveServerSpecificAgentConfigStub.resetHistory()

        await mgr.updateServer('u1', { timeout: 999 }, 'u.json')

        expect(saveServerSpecificAgentConfigStub.calledOnce).to.be.true
        expect(closeStub.calledOnce).to.be.true
        expect(initOneStub.called).to.be.true
        expect(initOneStub.firstCall.args[0]).to.equal('u1')
    })

    it('switches from stdio to http by clearing command and setting url', async () => {
        const oldCfg: MCPServerConfig = {
            command: 'cmd',
            args: [],
            env: {},
            timeout: 0,
            disabled: false,
            __configPath__: 'z.json',
        }

        loadStub = sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
            servers: new Map([['srv', oldCfg]]),
            serverNameMapping: new Map([['srv', 'srv']]),
            errors: new Map(),
            agentConfig: {
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: { srv: oldCfg },
                tools: ['@srv'],
                allowedTools: [],
                toolsSettings: {},
                includedFiles: [],
                resources: [],
            },
        })

        await McpManager.init([], features)
        const mgr = McpManager.instance
        await mgr.discoverAllServers()

        initOneStub.resetHistory()
        saveServerSpecificAgentConfigStub.resetHistory()

        await mgr.updateServer('srv', { command: undefined, url: 'https://new.host/mcp' }, 'z.json')

        expect(saveServerSpecificAgentConfigStub.calledOnce).to.be.true
        expect(initOneStub.called).to.be.true
        expect(initOneStub.firstCall.args[0]).to.equal('srv')
    })
})

describe('requiresApproval()', () => {
    let loadStub: sinon.SinonStub

    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('returns true for unknown server', async () => {
        loadStub = stubAgentConfig()
        const mgr = await McpManager.init([], features)
        await mgr.discoverAllServers()
        expect(mgr.requiresApproval('x', 'y')).to.be.true
    })

    it('returns false when tool is in allowedTools', async () => {
        const cfg: MCPServerConfig = {
            command: 'c',
            args: [],
            env: {},
            timeout: 0,
            __configPath__: 'p',
        }
        loadStub = sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
            servers: new Map([['s', cfg]]),
            serverNameMapping: new Map([['s', 's']]),
            errors: new Map(),
            agentConfig: {
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: { s: cfg },
                tools: ['@s'],
                allowedTools: ['@s/foo'],
                toolsSettings: {},
                includedFiles: [],
                resources: [],
            },
        })

        const mgr = await McpManager.init(['p'], features)
        await mgr.discoverAllServers()
        expect(mgr.requiresApproval('s', 'foo')).to.be.false
        expect(mgr.requiresApproval('s', 'bar')).to.be.true
    })
})

describe('getAllServerConfigs()', () => {
    let loadStub: sinon.SinonStub

    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('returns snapshot', async () => {
        const cfg: MCPServerConfig = {
            command: 'cmd',
            args: [],
            env: {},
            timeout: 0,
            __configPath__: 'cfg.json',
        }
        loadStub = sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
            servers: new Map([['srv', cfg]]),
            serverNameMapping: new Map(),
            errors: new Map(),
            agentConfig: {
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: { srv: cfg },
                tools: ['@srv'],
                allowedTools: [],
                toolsSettings: {},
                includedFiles: [],
                resources: [],
            },
        })
        const mgr = await McpManager.init(['cfg.json'], features)
        await mgr.discoverAllServers()
        const snap = mgr.getAllServerConfigs()
        expect(snap.get('srv')).to.deep.equal(cfg)
        snap.delete('srv')
        expect(mgr.getAllServerConfigs().has('srv')).to.be.true
    })
})

function createStateStubs() {
    const loadStub = stubAgentConfig()
    const initOneStub = stubInitOneServer()
    return { loadStub, initOneStub }
}

describe('getServerState()', () => {
    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('returns runtime info', async () => {
        const { loadStub } = createStateStubs()
        const cfg: MCPServerConfig = {
            command: 'c',
            args: [],
            env: {},
            timeout: 0,
            disabled: false,
            __configPath__: 'state.json',
        }
        loadStub.resolves({
            servers: new Map([['srv', cfg]]),
            serverNameMapping: new Map(),
            errors: new Map(),
            agentConfig: {
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: { srv: cfg },
                tools: ['@srv'],
                allowedTools: [],
                toolsSettings: {},
                includedFiles: [],
                resources: [],
            },
        })
        const mgr = await McpManager.init(['state.json'], features)
        await mgr.discoverAllServers()
        expect(mgr.getServerState('srv')).to.deep.include({
            status: 'ENABLED',
            toolsCount: 1,
        })
    })
})

describe('getAllServerStates()', () => {
    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('returns a map with info', async () => {
        const { loadStub } = createStateStubs()
        const cfg: MCPServerConfig = {
            command: 'c',
            args: [],
            env: {},
            timeout: 0,
            disabled: false,
            __configPath__: 'state.json',
        }
        loadStub.resolves({
            servers: new Map([['srv', cfg]]),
            serverNameMapping: new Map(),
            errors: new Map(),
            agentConfig: {
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: { srv: cfg },
                tools: ['@srv'],
                allowedTools: [],
                toolsSettings: {},
                includedFiles: [],
                resources: [],
            },
        })
        const mgr = await McpManager.init(['state.json'], features)
        await mgr.discoverAllServers()
        const map = mgr.getAllServerStates()
        expect(map.get('srv')).to.deep.include({
            status: 'ENABLED',
            toolsCount: 1,
        })
    })
})

describe('getEnabledTools()', () => {
    let loadStub: sinon.SinonStub
    let initOneStub: sinon.SinonStub

    beforeEach(() => {
        initOneStub = stubInitOneServer()
    })

    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('filters out disabled tools', async () => {
        const cfg: MCPServerConfig = {
            command: 'c',
            args: [],
            env: {},
            timeout: 0,
            disabled: false,
            __configPath__: 't.json',
        }

        loadStub = sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
            servers: new Map([['srv', cfg]]),
            serverNameMapping: new Map([['srv', 'srv']]),
            errors: new Map(),
            agentConfig: {
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: { srv: cfg },
                tools: ['@srv'],
                allowedTools: [],
                toolsSettings: {},
                includedFiles: [],
                resources: [],
            },
        })

        const mgr = await McpManager.init(['t.json'], features)
        await mgr.discoverAllServers()
        expect(mgr.getEnabledTools()).to.have.length(1)

        // Update the agentConfig to disable the tool
        if (!(mgr as any).agentConfig) {
            ;(mgr as any).agentConfig = {
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: {},
                tools: [],
                allowedTools: [],
                toolsSettings: {},
                includedFiles: [],
                resources: [],
            }
        } else {
            ;(mgr as any).agentConfig.tools = []
        }
        expect(mgr.getEnabledTools()).to.be.empty
    })

    it('filters out tools from disabled servers', async () => {
        const disabledCfg: MCPServerConfig = {
            command: 'c',
            args: [],
            env: {},
            timeout: 0,
            disabled: true,
            __configPath__: 't.json',
        }

        loadStub = sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
            servers: new Map([['srv', disabledCfg]]),
            serverNameMapping: new Map([['srv', 'srv']]),
            errors: new Map(),
            agentConfig: {
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: { srv: disabledCfg },
                tools: ['@srv'],
                allowedTools: [],
                toolsSettings: {},
                includedFiles: [],
                resources: [],
            },
        })

        const mgr = await McpManager.init(['t.json'], features)
        await mgr.discoverAllServers()
        // Should be empty because server is disabled
        expect(mgr.getEnabledTools()).to.be.empty
    })
})

describe('getAllToolsWithPermissions()', () => {
    let loadStub: sinon.SinonStub
    let initOneStub: sinon.SinonStub
    let mgr: McpManager

    const cfg: MCPServerConfig = {
        command: 'c',
        args: [],
        env: {},
        timeout: 0,
        disabled: false,
        __configPath__: 'p.json',
    }

    beforeEach(async () => {
        loadStub = sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
            servers: new Map([['s1', cfg]]),
            serverNameMapping: new Map([['s1', 's1']]),
            errors: new Map(),
            agentConfig: {
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: { s1: cfg },
                tools: ['@s1'],
                allowedTools: [],
                toolsSettings: {},
                includedFiles: [],
                resources: [],
            },
        })
        initOneStub = stubInitOneServer()
        mgr = await McpManager.init(['p.json'], features)
        await mgr.discoverAllServers()
    })

    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('reports permission value', () => {
        const [info] = mgr.getAllToolsWithPermissions()
        expect(info.permission).to.equal('ask')
    })

    it('honours serverFilter', () => {
        ;(mgr as any).mcpTools.push({
            serverName: 's2',
            toolName: 'foo',
            description: '',
            inputSchema: {},
        })
        expect(mgr.getAllToolsWithPermissions()).to.have.length(2)
        expect(mgr.getAllToolsWithPermissions('s1')).to.have.length(1)
        expect(mgr.getAllToolsWithPermissions('s2')).to.have.length(1)
    })
})

describe('isServerDisabled()', () => {
    let loadStub: sinon.SinonStub

    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('returns true when server is disabled', async () => {
        const disabledCfg: MCPServerConfig = {
            command: 'c',
            args: [],
            env: {},
            timeout: 0,
            disabled: true,
            __configPath__: 'p.json',
        }

        loadStub = sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
            servers: new Map([['srv', disabledCfg]]),
            serverNameMapping: new Map(),
            errors: new Map(),
            agentConfig: {
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: { srv: disabledCfg },
                tools: ['@srv'],
                allowedTools: [],
                toolsSettings: {},
                includedFiles: [],
                resources: [],
            },
        })

        const mgr = await McpManager.init(['p.json'], features)
        await mgr.discoverAllServers()
        expect(mgr.isServerDisabled('srv')).to.be.true
    })

    it('returns false when server is enabled', async () => {
        const enabledCfg: MCPServerConfig = {
            command: 'c',
            args: [],
            env: {},
            timeout: 0,
            disabled: false,
            __configPath__: 'p.json',
        }

        loadStub = sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
            servers: new Map([['srv', enabledCfg]]),
            serverNameMapping: new Map(),
            errors: new Map(),
            agentConfig: {
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: { srv: enabledCfg },
                tools: ['@srv'],
                allowedTools: [],
                toolsSettings: {},
                includedFiles: [],
                resources: [],
            },
        })

        const mgr = await McpManager.init(['p.json'], features)
        await mgr.discoverAllServers()
        expect(mgr.isServerDisabled('srv')).to.be.false
    })

    it('returns false when disabled property is undefined', async () => {
        const undefinedCfg: MCPServerConfig = {
            command: 'c',
            args: [],
            env: {},
            timeout: 0,
            __configPath__: 'p.json',
        }

        loadStub = sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
            servers: new Map([['srv', undefinedCfg]]),
            serverNameMapping: new Map(),
            errors: new Map(),
            agentConfig: {
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: { srv: undefinedCfg },
                tools: ['@srv'],
                allowedTools: [],
                toolsSettings: {},
                includedFiles: [],
                resources: [],
            },
        })

        const mgr = await McpManager.init(['p.json'], features)
        await mgr.discoverAllServers()
        expect(mgr.isServerDisabled('srv')).to.be.false
    })
})

describe('close()', () => {
    let loadStub: sinon.SinonStub

    afterEach(() => sinon.restore())

    it('shuts all clients and resets singleton', async () => {
        loadStub = stubAgentConfig()
        await McpManager.init([], features)
        const mgr = McpManager.instance

        const c1 = new Client({ name: 'c1', version: 'v' })
        const c2 = new Client({ name: 'c2', version: 'v' })
        const s1 = sinon.spy(c1, 'close')
        const s2 = sinon.spy(c2, 'close')
        ;(mgr as any).clients.set('a', c1)
        ;(mgr as any).clients.set('b', c2)

        await mgr.close()
        expect(s1.calledOnce).to.be.true
        expect(s2.calledOnce).to.be.true
        expect(() => McpManager.instance).to.throw()
    })
})

// Note: isServerDisabled method has been removed in the new implementation
// The functionality is now handled by checking if the server is in the tools list

describe('listServersAndTools()', () => {
    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('lists names grouped by server', async () => {
        stubAgentConfig()
        const initStub = stubInitOneServer()
        const mgr = await McpManager.init([], features)
        ;(mgr as any).mcpTools.push({
            serverName: 'srv2',
            toolName: 'extra',
            description: '',
            inputSchema: {},
        })
        const map = mgr.listServersAndTools()
        expect(map['srv2']).to.deep.equal(['extra'])
        expect(initStub.called).to.be.false
    })
})

describe('updateServerPermission()', () => {
    let saveAgentConfigStub: sinon.SinonStub
    let saveServerSpecificAgentConfigStub: sinon.SinonStub

    beforeEach(() => {
        saveAgentConfigStub = sinon.stub(mcpUtils, 'saveAgentConfig').resolves()
        saveServerSpecificAgentConfigStub = sinon.stub(mcpUtils, 'saveServerSpecificAgentConfig').resolves()
    })

    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('updates tool permissions', async () => {
        const cfg: MCPServerConfig = {
            command: 'c',
            args: [],
            env: {},
            timeout: 0,
            disabled: false,
            __configPath__: 'x.json',
        }

        sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
            servers: new Map([['srv', cfg]]),
            serverNameMapping: new Map([['srv', 'srv']]),
            errors: new Map(),
            agentConfig: {
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: { srv: cfg },
                tools: ['@srv'],
                allowedTools: [],
                toolsSettings: {},
                includedFiles: [],
                resources: [],
            },
        })

        const initStub = stubInitOneServer()

        await McpManager.init(['x.json'], features)
        const mgr = McpManager.instance
        await mgr.discoverAllServers()

        // Update permissions for a tool
        await mgr.updateServerPermission('srv', {
            enabled: true,
            toolPerms: { tool1: McpPermissionType.alwaysAllow },
            __configPath__: '/p',
        })

        // Verify saveServerSpecificAgentConfig was called
        expect(saveServerSpecificAgentConfigStub.calledOnce).to.be.true

        // Verify the tool permission was updated
        expect(mgr.requiresApproval('srv', 'tool1')).to.be.false
    })
})

describe('reinitializeMcpServers()', () => {
    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('closes and reloads servers', async () => {
        const cfg1: MCPServerConfig = {
            command: 'c',
            args: [],
            env: {},
            timeout: 0,
            disabled: false,
            __configPath__: 'a.json',
        }
        const cfg2: MCPServerConfig = {
            command: 'd',
            args: [],
            env: {},
            timeout: 0,
            disabled: false,
            __configPath__: 'b.json',
        }
        const loadStub = sinon
            .stub(mcpUtils, 'loadAgentConfig')
            .onFirstCall()
            .resolves({
                servers: new Map([['srvA', cfg1]]),
                serverNameMapping: new Map(),
                errors: new Map(),
                agentConfig: {
                    name: 'test-agent',
                    description: 'Test agent',
                    mcpServers: { srvA: cfg1 },
                    tools: ['@srvA'],
                    allowedTools: [],
                    toolsSettings: {},
                    includedFiles: [],
                    resources: [],
                },
            })
            .onSecondCall()
            .resolves({
                servers: new Map([['srvB', cfg2]]),
                serverNameMapping: new Map(),
                errors: new Map(),
                agentConfig: {
                    name: 'test-agent',
                    description: 'Test agent',
                    mcpServers: { srvB: cfg2 },
                    tools: ['@srvB'],
                    allowedTools: [],
                    toolsSettings: {},
                    includedFiles: [],
                    resources: [],
                },
            })
        stubInitOneServer()

        const mgr = await McpManager.init(['a.json'], features)
        await mgr.discoverAllServers()
        expect(mgr.getAllServerConfigs().has('srvA')).to.be.true

        const closeSpy = sinon.spy(mgr, 'close' as any)
        await mgr.reinitializeMcpServers()
        expect(closeSpy.calledOnce).to.be.true
        expect(loadStub.callCount).to.equal(2)
        expect(mgr.getAllServerConfigs().has('srvB')).to.be.true
    })
})

describe('handleError()', () => {
    let mgr: McpManager
    let loadStub: sinon.SinonStub
    let errorSpy: sinon.SinonSpy
    let statusEvents: Array<{ server: string; state: any }>
    let toolsEvents: Array<{ server: string; tools: any[] }>

    beforeEach(async () => {
        loadStub = stubAgentConfig()
        mgr = await McpManager.init([], features)
        errorSpy = sinon.spy(fakeLogging, 'error')

        // Capture emitted events
        statusEvents = []
        toolsEvents = []
        mgr.events.on(MCP_SERVER_STATUS_CHANGED, (srv, st) => {
            statusEvents.push({ server: srv, state: st })
        })
        mgr.events.on(AGENT_TOOLS_CHANGED, (srv, tools) => {
            toolsEvents.push({ server: srv, tools })
        })
    })

    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('logs error and emits FAILED state + toolsChanged', () => {
        ;(mgr as any).handleError('srvX', new Error('boom!'))

        expect(errorSpy.calledOnce).to.be.true
        expect(errorSpy.firstCall.args[0]).to.match(/MCP ERROR \[srvX\]: boom!/)

        expect(statusEvents).to.have.length(1)
        expect(statusEvents[0].server).to.equal('srvX')
        expect(statusEvents[0].state.status).to.equal(McpServerStatus.FAILED)
        expect(statusEvents[0].state.lastError).to.equal('boom!')

        expect(toolsEvents).to.have.length(1)
        expect(toolsEvents[0].server).to.equal('srvX')
        expect(toolsEvents[0].tools).to.be.an('array').that.is.empty
    })
})

describe('concurrent server initialization', () => {
    let loadStub: sinon.SinonStub
    let initOneServerStub: sinon.SinonStub
    let promiseAllSpy: sinon.SinonSpy

    beforeEach(() => {
        sinon.restore()
        // Create a spy on Promise.all to verify it's called with the correct arguments
        promiseAllSpy = sinon.spy(Promise, 'all')
    })

    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('initializes multiple servers concurrently with a limit of 5', async () => {
        // Create 7 server configs to test batching (more than the MAX_CONCURRENT_SERVERS of 5)
        const serverConfigs: Record<string, MCPServerConfig> = {}
        for (let i = 1; i <= 7; i++) {
            serverConfigs[`server${i}`] = {
                command: `server${i}`,
                args: [],
                env: {},
                timeout: 0,
                disabled: false,
                __configPath__: `config${i}.json`,
            }
        }

        // Set up the loadAgentConfig stub to return multiple servers
        const serversMap = new Map(Object.entries(serverConfigs))
        const agentConfig = {
            name: 'test-agent',
            description: 'Test agent',
            mcpServers: Object.fromEntries(Object.entries(serverConfigs)),
            tools: Object.keys(serverConfigs).map(name => `@${name}`),
            allowedTools: [],
            toolsSettings: {},
            includedFiles: [],
            resources: [],
        }

        loadStub = sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
            servers: serversMap,
            serverNameMapping: new Map(),
            errors: new Map(),
            agentConfig,
        })

        // Create a controlled stub for initOneServer that resolves after a delay
        // This helps verify that servers are initialized in batches
        const initStartTimes: Record<string, number> = {}
        const initEndTimes: Record<string, number> = {}
        const batchAssignments: Record<string, number> = {} // Track which batch each server is in

        // Spy on the debug logging to capture batch information
        const debugSpy = sinon.spy(fakeLogging, 'debug')

        initOneServerStub = sinon
            .stub(McpManager.prototype as any, 'initOneServer' as keyof McpManager)
            .callsFake(async function (this: any, ...args: any[]) {
                const serverName = args[0] as string
                initStartTimes[serverName] = Date.now()

                // Create a promise that resolves after a short delay
                return new Promise<void>(resolve => {
                    setTimeout(() => {
                        // Set up the server state as the original method would
                        this.clients.set(serverName, new Client({ name: `mcp-client-${serverName}`, version: '1.0.0' }))
                        this.mcpTools.push({
                            serverName,
                            toolName: `tool-${serverName}`,
                            description: `Tool for ${serverName}`,
                            inputSchema: {},
                        })
                        this.setState(serverName, 'ENABLED', 1)

                        initEndTimes[serverName] = Date.now()
                        resolve()
                    }, 50) // Small delay to simulate async initialization
                })
            })

        // Initialize the McpManager
        const mgr = await McpManager.init(['config1.json'], features)
        await mgr.discoverAllServers()

        // Verify that Promise.all was called at least twice (once for each batch)
        expect(promiseAllSpy.called).to.be.true
        expect(promiseAllSpy.callCount).to.be.at.least(2) // At least 2 batches for 7 servers with max 5 per batch

        // Verify that initOneServer was called for each server
        expect(initOneServerStub.callCount).to.equal(7)
        for (let i = 1; i <= 7; i++) {
            expect(initOneServerStub.calledWith(`server${i}`, serverConfigs[`server${i}`])).to.be.true
        }

        // Verify that all servers were initialized
        const serverStates = mgr.getAllServerStates()
        for (let i = 1; i <= 7; i++) {
            expect(serverStates.get(`server${i}`)?.status).to.equal('ENABLED')
        }

        // Verify that debug logging shows batch processing
        expect(debugSpy.called).to.be.true

        // Instead of checking individual calls, convert the entire debug log to a string
        // This avoids TypeScript errors with array access
        let debugLogString = ''

        // Safely collect all debug messages into a single string
        debugSpy.getCalls().forEach(call => {
            try {
                if (call && call.args) {
                    // Convert all arguments to string and concatenate
                    for (let i = 0; i < call.args.length; i++) {
                        debugLogString += String(call.args[i] || '') + ' '
                    }
                }
            } catch (e) {
                // Ignore any errors during string conversion
            }
        })

        // Now check if the combined log contains our expected phrases
        const batchLogFound =
            debugLogString.indexOf('initializing batch of') >= 0 && debugLogString.indexOf('of 7') >= 0
        expect(batchLogFound).to.be.true

        // Verify that Promise.all was called with the correct batch sizes
        let firstBatchFound = false
        let secondBatchFound = false

        for (const call of promiseAllSpy.getCalls()) {
            if (call.args && call.args.length > 0) {
                const args = call.args[0]
                if (Array.isArray(args)) {
                    if (args.length === 5) {
                        firstBatchFound = true
                    } else if (args.length === 2) {
                        secondBatchFound = true
                    }
                }
            }
        }

        expect(firstBatchFound).to.be.true // First batch should have 5 servers
        expect(secondBatchFound).to.be.true // Second batch should have 2 servers
    })
})

describe('McpManager error handling', () => {
    let loadStub: sinon.SinonStub

    beforeEach(() => {
        sinon.restore()
    })

    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('stores and returns config load errors', async () => {
        // Create a mock response with errors
        const mockErrors = new Map<string, string>([
            ['file1.json', 'File not found error'],
            ['serverA', 'Missing command error'],
        ])

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

        const mgr = await McpManager.init([], features)

        // Call discoverAllServers to load the config and populate errors
        await mgr.discoverAllServers()

        // Test that getConfigLoadErrors returns the expected error messages
        const errors = mgr.getConfigLoadErrors()
        expect(errors).to.not.be.undefined
        expect(errors).to.include('File: `file1.json`, Error: File not found error')
        expect(errors).to.include('File: `serverA`, Error: Missing command error')
    })

    it('wraps file paths in code spans so Windows paths render correctly in markdown', async () => {
        // A Windows path segment like "\.aws" would have its backslash stripped when
        // rendered as markdown unless the path is wrapped in a code span.
        const windowsPath = 'C:\\Users\\me\\.aws\\amazonq\\mcp.json'
        const mockErrors = new Map<string, string>([[windowsPath, 'Invalid JSON error']])

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

        const mgr = await McpManager.init([], features)
        await mgr.discoverAllServers()

        const errors = mgr.getConfigLoadErrors()
        expect(errors).to.include(`File: \`${windowsPath}\`, Error: Invalid JSON error`)
    })

    it('returns undefined when no errors exist', async () => {
        // Create a mock response with no errors
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

        const mgr = await McpManager.init([], features)

        // Test that getConfigLoadErrors returns undefined when no errors
        const errors = mgr.getConfigLoadErrors()
        expect(errors).to.be.undefined
    })

    it('logs error and updates server state', async () => {
        // Create a mock response with no errors initially
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

        const mgr = await McpManager.init([], features)

        // Spy on logging.error and setState
        const errorSpy = sinon.spy(fakeLogging, 'error')
        const setStateSpy = sinon.spy(mgr as any, 'setState')

        // Access the private handleError method using type assertion
        const handleError = (mgr as any).handleError.bind(mgr)

        // Call handleError with a server name and error
        handleError('testServer', new Error('Test error message'))

        // Verify error is logged
        expect(errorSpy.calledOnce).to.be.true
        // We can't check the exact arguments due to the function signature,
        // so we'll focus on verifying the behavior through other means

        // Verify setState is called with correct parameters
        expect(setStateSpy.calledWith('testServer', McpServerStatus.FAILED, 0, 'Test error message')).to.be.true
    })

    it('clears errors when reloading configurations', async () => {
        // First load with errors
        loadStub = sinon
            .stub(mcpUtils, 'loadAgentConfig')
            .onFirstCall()
            .resolves({
                servers: new Map(),
                serverNameMapping: new Map(),
                errors: new Map([['file1.json', 'Initial error']]),
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
            // Second load with no errors
            .onSecondCall()
            .resolves({
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

        const mgr = await McpManager.init([], features)

        // Call discoverAllServers to load initial config with errors
        await mgr.discoverAllServers()

        // Verify initial errors exist
        let errors = mgr.getConfigLoadErrors()
        expect(errors).to.not.be.undefined
        expect(errors).to.include('Initial error')

        // Reinitialize to clear errors - this will call discoverAllServers internally
        await mgr.reinitializeMcpServers()

        // Verify errors are cleared
        errors = mgr.getConfigLoadErrors()
        expect(errors).to.be.undefined
    })
})

describe('Registry Synchronization', () => {
    let mgr: McpManager
    let mockFeatures: any
    let sandbox: sinon.SinonSandbox

    beforeEach(async () => {
        sandbox = sinon.createSandbox()
        mockFeatures = {
            logging: fakeLogging,
            workspace: fakeWorkspace,
            lsp: {},
            telemetry: { emitMetric: () => {} },
            credentialsProvider: { getConnectionMetadata: () => ({}) },
            runtime: { serverInfo: { version: '1.0.0' } },
            agent: { getBuiltInToolNames: () => [] },
        }
        stubAgentConfig()
        mgr = await McpManager.init([], mockFeatures)
    })

    afterEach(async () => {
        sandbox.restore()
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    describe('updateRegistryUrl', () => {
        it('should fetch and update registry when URL provided', async () => {
            const registry = {
                servers: [{ name: 'test-server', description: 'Test', version: '1.0.0', remotes: [] as any }],
                lastFetched: new Date(),
                url: 'https://example.com/registry.json',
            }

            const mockRegistryService = {
                fetchRegistry: sandbox.stub().resolves(registry),
            }
            ;(mgr as any).registryService = mockRegistryService

            await mgr.updateRegistryUrl('https://example.com/registry.json')

            expect(mockRegistryService.fetchRegistry.calledWith('https://example.com/registry.json')).to.be.true
            expect((mgr as any).currentRegistry).to.equal(registry)
        })

        it('should clear current registry and throw when fetch fails', async () => {
            const mockRegistryService = {
                fetchRegistry: sandbox.stub().rejects(new Error('Failed to fetch or validate registry')),
            }
            ;(mgr as any).registryService = mockRegistryService

            try {
                await mgr.updateRegistryUrl('https://example.com/registry.json')
                throw new Error('Expected updateRegistryUrl to throw')
            } catch (error: any) {
                expect(error.message).to.equal('Failed to fetch or validate registry')
            }

            expect((mgr as any).currentRegistry).to.be.null
        })
    })

    describe('syncWithRegistry', () => {
        it('should remove servers removed from registry', async () => {
            const saveStub = sandbox.stub(mcpUtils, 'saveServerSpecificAgentConfig').resolves()
            ;(mgr as any).mcpServers.set('test-server', {
                command: 'npx',
                args: ['-y', '@test/server@1.0.0'],
                disabled: false,
                __configPath__: '/test/config.json',
            })
            ;(mgr as any).serverNameMapping.set('test-server', 'test-server')
            ;(mgr as any).agentConfig = {
                mcpServers: { 'test-server': { type: 'registry' } },
                tools: ['@test-server'],
                allowedTools: [],
                toolsSettings: {},
                resources: [],
                includedFiles: [],
                useLegacyMcpJson: false,
                name: 'test',
                description: 'test',
            }

            const mockClient = { close: sandbox.stub().resolves() }
            ;(mgr as any).clients.set('test-server', mockClient)

            const registry = {
                servers: [],
                lastFetched: new Date(),
                url: 'https://example.com/registry.json',
            }

            const mockRegistryService = {
                fetchRegistry: sandbox.stub().resolves(registry),
            }
            ;(mgr as any).registryService = mockRegistryService

            await mgr.updateRegistryUrl('https://example.com/registry.json', true)

            expect(mockClient.close.called).to.be.true
            // Server should remain in map but marked as FAILED
            const config = (mgr as any).mcpServers.get('test-server')
            expect(config).to.exist
            // Verify server state is FAILED
            const serverState = mgr.getServerState('test-server')
            expect(serverState?.status).to.equal('FAILED')
            expect(serverState?.lastError).to.include('removed from registry')
        })

        it('should skip non-registry servers during sync', async () => {
            ;(mgr as any).mcpServers.set('manual-server', {
                command: 'npx',
                args: ['@test/server'],
                disabled: false,
            })
            ;(mgr as any).serverNameMapping.set('manual-server', 'manual-server')
            ;(mgr as any).agentConfig = {
                mcpServers: { 'manual-server': { command: 'npx', args: ['@test/server'] } },
                tools: [],
                allowedTools: [],
                toolsSettings: {},
                resources: [],
                useLegacyMcpJson: false,
                name: 'test',
                description: 'test',
            }

            const registry = {
                servers: [],
                lastFetched: new Date(),
                url: 'https://example.com/registry.json',
            }

            const mockRegistryService = {
                fetchRegistry: sandbox.stub().resolves(registry),
            }
            ;(mgr as any).registryService = mockRegistryService

            await mgr.updateRegistryUrl('https://example.com/registry.json', true)

            const config = (mgr as any).mcpServers.get('manual-server')
            expect(config.disabled).to.be.false
        })
    })

    describe('version checking', () => {
        it('should detect version mismatch for local servers', async () => {
            ;(mgr as any).mcpServers.set('test-server', {
                command: 'npx',
                args: ['-y', '@test/server@1.0.0'],
                disabled: false,
                __cachedVersion__: '1.0.0',
                __configPath__: '/test/config.json',
            })
            ;(mgr as any).serverNameMapping.set('test-server', 'test-server')
            ;(mgr as any).agentConfig = {
                mcpServers: { 'test-server': { type: 'registry' } },
                tools: [],
                allowedTools: [],
                toolsSettings: {},
                resources: [],
                useLegacyMcpJson: false,
                name: 'test',
                description: 'test',
            }

            const mockClient = { close: sandbox.stub().resolves() }
            ;(mgr as any).clients.set('test-server', mockClient)

            const removeServerStub = sandbox.stub(mgr, 'removeServer').resolves()
            const addRegistryServerStub = sandbox.stub(mgr, 'addRegistryServer').resolves()

            const registry = {
                servers: [
                    {
                        name: 'test-server',
                        description: 'Test',
                        version: '2.0.0',
                        packages: [
                            {
                                registryType: 'npm',
                                identifier: '@test/server',
                                transport: { type: 'stdio' },
                            },
                        ],
                    } as any,
                ],
                lastFetched: new Date(),
                url: 'https://example.com/registry.json',
            }

            const mockRegistryService = {
                fetchRegistry: sandbox.stub().resolves(registry),
            }
            ;(mgr as any).registryService = mockRegistryService

            await mgr.updateRegistryUrl('https://example.com/registry.json', true)

            expect(removeServerStub.called).to.be.true
            expect(addRegistryServerStub.called).to.be.true
        })
    })
})

describe('addRegistryServer with additional headers/env', () => {
    let loadStub: sinon.SinonStub
    let initOneStub: sinon.SinonStub
    let saveServerSpecificAgentConfigStub: sinon.SinonStub

    beforeEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
        loadStub = stubAgentConfig()
        initOneStub = stubInitOneServer()
        saveServerSpecificAgentConfigStub = sinon.stub(mcpUtils, 'saveServerSpecificAgentConfig').resolves()
    })

    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('stores additional headers for HTTP registry servers', async () => {
        const mgr = await McpManager.init([], features)
        ;(mgr as any).agentConfig = {
            name: 'test-agent',
            description: 'Test agent',
            mcpServers: {},
            tools: [],
            allowedTools: [],
            toolsSettings: {},
            includedFiles: [],
            resources: [],
        }

        const cfg: MCPServerConfig = {
            url: 'https://example.com/mcp',
            headers: { 'X-Base': 'base-value' },
            timeout: 60000,
            __configPath__: 'path.json',
        }

        const additionalHeaders = { 'X-Custom': 'custom-value' }

        await mgr.addRegistryServer('httpServer', cfg, 'path.json', additionalHeaders, undefined)

        expect(saveServerSpecificAgentConfigStub.calledOnce).to.be.true

        const storedCfg = (mgr as any).mcpServers.get('httpServer')
        expect(storedCfg.__additionalHeaders__).to.deep.equal(additionalHeaders)

        const agentCfg = (mgr as any).agentConfig.mcpServers['httpServer']
        expect(agentCfg.headers).to.deep.equal(additionalHeaders)
    })

    it('stores additional env for STDIO registry servers', async () => {
        const mgr = await McpManager.init([], features)
        ;(mgr as any).agentConfig = {
            name: 'test-agent',
            description: 'Test agent',
            mcpServers: {},
            tools: [],
            allowedTools: [],
            toolsSettings: {},
            includedFiles: [],
            resources: [],
        }

        const cfg: MCPServerConfig = {
            command: 'npx',
            args: ['-y', '@test/server'],
            env: { BASE_VAR: 'base' },
            timeout: 60000,
            __configPath__: 'path.json',
        }

        const additionalEnv = { CUSTOM_VAR: 'custom' }

        await mgr.addRegistryServer('stdioServer', cfg, 'path.json', undefined, additionalEnv)

        expect(saveServerSpecificAgentConfigStub.calledOnce).to.be.true

        const storedCfg = (mgr as any).mcpServers.get('stdioServer')
        expect(storedCfg.__additionalEnv__).to.deep.equal(additionalEnv)

        const agentCfg = (mgr as any).agentConfig.mcpServers['stdioServer']
        expect(agentCfg.env).to.deep.equal(additionalEnv)
    })

    it('omits additional fields when empty', async () => {
        const mgr = await McpManager.init([], features)
        ;(mgr as any).agentConfig = {
            name: 'test-agent',
            description: 'Test agent',
            mcpServers: {},
            tools: [],
            allowedTools: [],
            toolsSettings: {},
            includedFiles: [],
            resources: [],
        }

        const cfg: MCPServerConfig = {
            url: 'https://example.com/mcp',
            timeout: 60000,
            __configPath__: 'path.json',
        }

        await mgr.addRegistryServer('server', cfg, 'path.json', {}, {})

        const agentCfg = (mgr as any).agentConfig.mcpServers['server']
        expect(agentCfg.headers).to.be.undefined
        expect(agentCfg.env).to.be.undefined
    })
})

describe('consent gate for workspace-scoped MCP servers (P417451767)', () => {
    const fakeHome = '/home/testuser'
    const globalMcp = mcpUtils.getGlobalMcpConfigPath(fakeHome)
    const workspaceMcp = '/tmp/ws-a/.amazonq/mcp.json'

    let showMessageStub: sinon.SinonStub
    let hasApprovalStub: sinon.SinonStub
    let recordApprovalStub: sinon.SinonStub
    let setStateSpy: sinon.SinonSpy

    async function buildMgr(): Promise<any> {
        const consentStore = require('./mcpConsentStore')
        hasApprovalStub = sinon.stub(consentStore, 'hasApproval').resolves(false)
        recordApprovalStub = sinon.stub(consentStore, 'recordApproval').resolves()

        showMessageStub = sinon.stub()
        const featuresWithPrompt = {
            ...features,
            workspace: {
                ...fakeWorkspace,
                fs: { ...fakeWorkspace.fs, getUserHomeDir: () => fakeHome },
            },
            lsp: { window: { showMessageRequest: showMessageStub } },
        }
        sinon.stub(mcpUtils, 'loadAgentConfig').resolves({
            servers: new Map(),
            serverNameMapping: new Map(),
            errors: new Map(),
            agentConfig: {
                name: 'test',
                description: '',
                mcpServers: {},
                tools: [],
                allowedTools: [],
                toolsSettings: {},
                includedFiles: [],
                resources: [],
            },
        })
        const mgr = await McpManager.init([], featuresWithPrompt as any)
        setStateSpy = sinon.spy(mgr as any, 'setState')
        return mgr
    }

    afterEach(async () => {
        sinon.restore()
        try {
            await McpManager.instance.close()
        } catch {}
    })

    it('does not prompt for global-scoped config', async () => {
        const mgr = await buildMgr()
        const cfg: MCPServerConfig = { command: 'sh', args: [], __configPath__: globalMcp }
        // Fail fast after gate (cleanupExistingServer is safe to call on unknown server)
        try {
            await (mgr as any).initOneServerInternal('svc', cfg)
        } catch {}
        expect(showMessageStub.called).to.be.false
    })

    it('does not prompt for global agent config path', async () => {
        const mgr = await buildMgr()
        const globalAgent = mcpUtils.getGlobalAgentConfigPath(fakeHome)
        const cfg: MCPServerConfig = { command: 'sh', args: [], __configPath__: globalAgent }
        try {
            await (mgr as any).initOneServerInternal('svc', cfg)
        } catch {}
        expect(showMessageStub.called).to.be.false
    })

    it('does not prompt for global persona config path', async () => {
        const mgr = await buildMgr()
        const globalPersona = mcpUtils.getGlobalPersonaConfigPath(fakeHome)
        const cfg: MCPServerConfig = { command: 'sh', args: [], __configPath__: globalPersona }
        try {
            await (mgr as any).initOneServerInternal('svc', cfg)
        } catch {}
        expect(showMessageStub.called).to.be.false
    })

    it('prompts for workspace-scoped config when no prior approval', async () => {
        const mgr = await buildMgr()
        showMessageStub.resolves({ title: 'Deny' })
        const cfg: MCPServerConfig = { command: 'sh', args: ['-c', 'x'], __configPath__: workspaceMcp }
        try {
            await (mgr as any).initOneServerInternal('svc', cfg)
        } catch {}
        expect(showMessageStub.calledOnce).to.be.true
    })

    it('denial sets DISABLED state and caches the decision', async () => {
        const mgr = await buildMgr()
        showMessageStub.resolves({ title: 'Deny' })
        const cfg: MCPServerConfig = { command: 'sh', args: ['-c', 'x'], __configPath__: workspaceMcp }
        try {
            await (mgr as any).initOneServerInternal('svc', cfg)
        } catch {}
        expect(setStateSpy.calledWith('svc', McpServerStatus.DISABLED, 0, 'consent not granted')).to.be.true

        // Second call with same cfg should not re-prompt
        showMessageStub.resetHistory()
        try {
            await (mgr as any).initOneServerInternal('svc', cfg)
        } catch {}
        expect(showMessageStub.called).to.be.false
    })

    it('mutation of args invalidates session denial (fingerprint change)', async () => {
        const mgr = await buildMgr()
        showMessageStub.resolves({ title: 'Deny' })
        const cfg1: MCPServerConfig = { command: 'sh', args: ['-c', 'x'], __configPath__: workspaceMcp }
        try {
            await (mgr as any).initOneServerInternal('svc', cfg1)
        } catch {}
        expect(showMessageStub.calledOnce).to.be.true

        // Mutate args — fingerprint changes, denial cache key differs, prompt should fire again
        showMessageStub.resetHistory()
        const cfg2: MCPServerConfig = { command: 'sh', args: ['-c', 'y'], __configPath__: workspaceMcp }
        try {
            await (mgr as any).initOneServerInternal('svc', cfg2)
        } catch {}
        expect(showMessageStub.calledOnce).to.be.true
    })

    it('prior approval short-circuits prompt', async () => {
        const mgr = await buildMgr()
        hasApprovalStub.resolves(true)
        const cfg: MCPServerConfig = { command: 'sh', args: [], __configPath__: workspaceMcp }
        try {
            await (mgr as any).initOneServerInternal('svc', cfg)
        } catch {}
        expect(showMessageStub.called).to.be.false
    })

    it('allow records approval', async () => {
        const mgr = await buildMgr()
        showMessageStub.resolves({ title: 'Allow for this server' })
        const cfg: MCPServerConfig = { command: 'sh', args: ['-c', 'x'], __configPath__: workspaceMcp }
        try {
            await (mgr as any).initOneServerInternal('svc', cfg)
        } catch {}
        expect(recordApprovalStub.calledOnce).to.be.true
    })
})
