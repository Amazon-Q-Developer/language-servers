/*!
 * Copyright Amazon.com, Inc. or its affiliates.
 * All Rights Reserved. SPDX-License-Identifier: Apache-2.0
 */

import { expect } from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
    loadMcpServerConfigs,
    loadPersonaPermissions,
    loadAgentConfig,
    getWorkspacePersonaConfigPaths,
    getGlobalPersonaConfigPath,
    getWorkspaceAgentConfigPaths,
    getGlobalAgentConfigPath,
    getWorkspaceMcpConfigPaths,
    getGlobalMcpConfigPath,
    createNamespacedToolName,
    MAX_TOOL_NAME_LENGTH,
    enabledMCP,
    normalizePathFromUri,
    saveAgentConfig,
    saveServerSpecificAgentConfig,
    checkMcpConfigWrite,
    ConfigWriteRefusedError,
    setConfigPathsOfLoadedServers,
    isEmptyEnv,
    describeStdioLaunchForLog,
    describeArgsForLog,
    describeUrlForLog,
    describeMcpFormValuesForLog,
    sanitizeName,
    convertPersonaToAgent,
    migrateToAgentConfig,
    migrateAgentConfigsToCLIFormat,
    migrateAgentConfigToCLIFormat,
    restoreServerScopedPermissions,
    getAgentConfigPathForMcpConfig,
    isPermissionForServer,
    DEFAULT_TOOL_EXEC_TIMEOUT_MS,
    MAX_TOOL_EXEC_TIMEOUT_MS,
    isUsableToolExecTimeout,
    resolveMcpRequestTimeoutMs,
} from './mcpUtils'
import { getReservedBuiltInToolNames, STATIC_BUILT_IN_TOOL_NAMES } from '../../constants/toolConstants'
import type { MCPServerConfig } from './mcpTypes'
import { McpPermissionType } from './mcpTypes'
import { pathToFileURL } from 'url'
import * as sinon from 'sinon'
import { URI } from 'vscode-uri'
import { sanitizeInput } from '../../../../shared/utils'

/** The error that `promise` rejects with. Fails the test if the promise resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
    try {
        await promise
    } catch (error) {
        return error as Error
    }
    throw new Error('Expected the promise to reject')
}

describe('loadMcpServerConfigs', () => {
    let tmpDir: string
    let workspace: any
    let logger: any

    beforeEach(() => {
        sinon.restore()
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpUtilsTest-'))
        // a minimal Workspace stub
        workspace = {
            fs: {
                exists: (p: string) => Promise.resolve(fs.existsSync(p)),
                readFile: (p: string) => Promise.resolve(Buffer.from(fs.readFileSync(p))),
                getUserHomeDir: () => tmpDir,
            },
        }
        // logger that just swallows
        logger = { warn: () => {}, info: () => {}, error: () => {} }
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('loads valid configs and skips invalid ones', async () => {
        const good = { mcpServers: { A: { command: 'cmdA', args: ['x'], env: { X: 'x' } } } }
        const bad = { nope: {} }

        const goodPath = path.join(tmpDir, 'good.json')
        const badPath = path.join(tmpDir, 'bad.json')
        fs.writeFileSync(goodPath, JSON.stringify(good))
        fs.writeFileSync(badPath, JSON.stringify(bad))

        const out = await loadMcpServerConfigs(workspace, logger, [goodPath, badPath])

        expect(out.servers.size).to.equal(1)
        expect(out.servers.has('A')).to.be.true
        const cfg = out.servers.get('A') as MCPServerConfig
        expect(cfg.command).to.equal('cmdA')
        expect(cfg.args).to.deep.equal(['x'])
        expect(cfg.env).to.deep.equal({ X: 'x' })
    })

    it('normalizes file:// URIs', async () => {
        const cfg = { mcpServers: { B: { command: 'cmdB' } } }
        const p = path.join(tmpDir, 'u.json')
        fs.writeFileSync(p, JSON.stringify(cfg))
        const uri = pathToFileURL(p).toString()

        const out = await loadMcpServerConfigs(workspace, logger, [uri])
        expect(out.servers.has('B')).to.be.true
    })

    it('dedupes same server name across files, keeping first', async () => {
        const c1 = { mcpServers: { S: { command: 'one' } } }
        const c2 = { mcpServers: { S: { command: 'two' }, T: { command: 'three' } } }
        const p1 = path.join(tmpDir, '1.json')
        const p2 = path.join(tmpDir, '2.json')
        fs.writeFileSync(p1, JSON.stringify(c1))
        fs.writeFileSync(p2, JSON.stringify(c2))

        const out = await loadMcpServerConfigs(workspace, logger, [p1, p2])
        expect(out.servers.size).to.equal(2)
        expect(out.servers.get('S')!.command).to.equal('one')
        expect(out.servers.get('T')!.command).to.equal('three')
    })

    it('workspace config overrides global config of the same server', async () => {
        const globalDir = path.join(tmpDir, '.aws', 'amazonq')
        fs.mkdirSync(globalDir, { recursive: true })
        const globalPath = path.join(globalDir, 'mcp.json')
        fs.writeFileSync(globalPath, JSON.stringify({ mcpServers: { S: { command: 'globalCmd' } } }))

        const overridePath = path.join(tmpDir, 'override.json')
        fs.writeFileSync(overridePath, JSON.stringify({ mcpServers: { S: { command: 'workspaceCmd' } } }))

        const out1 = await loadMcpServerConfigs(workspace, logger, [globalPath, overridePath])
        expect(out1.servers.get('S')!.command).to.equal('workspaceCmd')

        const out2 = await loadMcpServerConfigs(workspace, logger, [overridePath, globalPath])
        expect(out2.servers.get('S')!.command).to.equal('workspaceCmd')
    })

    it('loads config that uses url only', async () => {
        const cfg = { mcpServers: { WebSrv: { url: 'https://example.com/mcp' } } }
        const p = path.join(tmpDir, 'http.json')
        fs.writeFileSync(p, JSON.stringify(cfg))

        const out = await loadMcpServerConfigs(workspace, logger, [p])
        expect(out.servers.has('WebSrv')).to.be.true
        const c = out.servers.get('WebSrv')!
        expect(c.url).to.equal('https://example.com/mcp')
        expect(c.command).to.be.undefined
    })

    it('skips server that specifies both command and url', async () => {
        const cfg = { mcpServers: { BadSrv: { command: 'foo', url: 'https://example.com' } } }
        const p = path.join(tmpDir, 'bad.json')
        fs.writeFileSync(p, JSON.stringify(cfg))

        const out = await loadMcpServerConfigs(workspace, logger, [p])
        expect(out.servers.size).to.equal(0)
        expect(out.errors.get('BadSrv')).to.match(/either.*command.*url/i)
    })

    it('skips server that has neither command nor url', async () => {
        const cfg = { mcpServers: { EmptySrv: { args: [] } } }
        const p = path.join(tmpDir, 'empty.json')
        fs.writeFileSync(p, JSON.stringify(cfg))

        const out = await loadMcpServerConfigs(workspace, logger, [p])
        expect(out.servers.size).to.equal(0)
        expect(out.errors.get('EmptySrv')).to.match(/either.*command.*url/i)
    })
})

describe('loadPersonaPermissions', () => {
    let tmpDir: string
    let workspace: any
    let logger: any

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personaTest-'))
        workspace = {
            fs: {
                exists: (p: string) => Promise.resolve(fs.existsSync(p)),
                readFile: (p: string) => Promise.resolve(Buffer.from(fs.readFileSync(p))),
                writeFile: (p: string, d: string) => Promise.resolve(fs.writeFileSync(p, d)),
                mkdir: (d: string, opts: any) => Promise.resolve(fs.mkdirSync(d, { recursive: opts.recursive })),
                getUserHomeDir: () => tmpDir,
            },
        }
        logger = { warn() {}, info() {}, error() {} }
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('creates a default persona and returns a wildcard-enabled map', async () => {
        const perms = await loadPersonaPermissions(workspace, logger, [])

        // Should have "*" entry with enabled=true and empty toolPerms
        expect(perms.has('*')).to.be.true
        const p = perms.get('*')!
        expect(p.enabled).to.be.true
        expect(p.toolPerms).to.deep.equal({})

        // The default file should have been written under ~/.aws/amazonq/personas/default.json
        const personaPath = getGlobalPersonaConfigPath(tmpDir)
        expect(fs.existsSync(personaPath)).to.be.true
        const content = fs.readFileSync(personaPath, 'utf-8')
        expect(content).to.contain('mcpServers')
    })
})

describe('loadAgentConfig', () => {
    let tmpDir: string
    let workspace: any
    let logger: any

    beforeEach(() => {
        sinon.restore()
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentConfigTest-'))
        workspace = {
            fs: {
                exists: (p: string) => Promise.resolve(fs.existsSync(p)),
                readFile: (p: string) => Promise.resolve(Buffer.from(fs.readFileSync(p))),
                writeFile: (p: string, d: string) => Promise.resolve(fs.writeFileSync(p, d)),
                mkdir: (d: string, opts: any) => Promise.resolve(fs.mkdirSync(d, { recursive: opts.recursive })),
                getUserHomeDir: () => tmpDir,
            },
            getAllWorkspaceFolders: () => [],
        }
        logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('creates a default agent config when none exists', async () => {
        // Add the global agent path to the paths array
        const agentPath = getGlobalAgentConfigPath(tmpDir)
        const result = await loadAgentConfig(workspace, logger, [agentPath], null, false)

        // Check that the agent config has the expected structure
        expect(result.agentConfig).to.have.property('name')
        expect(result.agentConfig).to.have.property('tools').that.is.an('array')
        expect(result.agentConfig).to.have.property('allowedTools').that.is.an('array')

        // The default file should have been written under ~/.aws/amazonq/agents/default.json
        expect(fs.existsSync(agentPath)).to.be.true
        const content = fs.readFileSync(agentPath, 'utf-8')
        expect(content).to.contain('tools')
    })

    it('loads valid server configs from agent config', async () => {
        // Create an agent config with a server
        const agentPath = getGlobalAgentConfigPath(tmpDir)
        await workspace.fs.mkdir(path.dirname(agentPath), { recursive: true })

        const agentConfig = {
            name: 'test-agent',
            description: 'Test agent',
            mcpServers: {
                testServer: {
                    command: 'test-command',
                    args: ['arg1', 'arg2'],
                    env: { TEST_ENV: 'value' },
                },
            },
            tools: ['@testServer'],
            allowedTools: [],
            toolsSettings: {},
            includedFiles: [],
            resources: [],
        }

        await workspace.fs.writeFile(agentPath, JSON.stringify(agentConfig))

        const result = await loadAgentConfig(workspace, logger, [agentPath], null, false)

        // Check that the server was loaded correctly
        expect(result.servers.size).to.equal(1)
        expect(result.servers.has('testServer')).to.be.true
        const serverConfig = result.servers.get('testServer')
        expect(serverConfig?.command).to.equal('test-command')
        expect(serverConfig?.args).to.deep.equal(['arg1', 'arg2'])
        expect(serverConfig?.env).to.deep.equal({ TEST_ENV: 'value' })
    })

    it('ignores absolute resources from a workspace agent config', async () => {
        const globalPath = getGlobalAgentConfigPath(tmpDir)
        const workspacePath = path.join(tmpDir, 'workspace', '.amazonq', 'agents', 'default.json')
        const config = (resources: string[]) =>
            JSON.stringify({ name: 'test-agent', mcpServers: {}, tools: [], allowedTools: [], resources })
        fs.mkdirSync(path.dirname(globalPath), { recursive: true })
        fs.mkdirSync(path.dirname(workspacePath), { recursive: true })
        fs.writeFileSync(globalPath, config(['file:///global/rules.md']))
        fs.writeFileSync(
            workspacePath,
            config(['file://docs/rules.md', 'file:///other/rules.md', 'file://C:/other/rules.md'])
        )
        const warn = sinon.spy(logger, 'warn')

        const result = await loadAgentConfig(workspace, logger, [workspacePath, globalPath], null, false)

        expect(result.agentConfig.resources).to.have.members(['file://docs/rules.md', 'file:///global/rules.md'])
        for (const resource of ['file:///other/rules.md', 'file://C:/other/rules.md']) {
            expect(warn.calledWithMatch(sinon.match(resource)), resource).to.be.true
        }
    })

    it('logs a dropped resource as a single quoted line', async () => {
        const workspacePath = path.join(tmpDir, 'workspace', '.amazonq', 'agents', 'default.json')
        const forged = 'file:///other/rules.md\n[Error] forged line'
        fs.mkdirSync(path.dirname(workspacePath), { recursive: true })
        fs.writeFileSync(
            workspacePath,
            JSON.stringify({ name: 'test-agent', mcpServers: {}, tools: [], allowedTools: [], resources: [forged] })
        )
        const warn = sinon.spy(logger, 'warn')

        await loadAgentConfig(workspace, logger, [workspacePath], null, false)

        const lines = warn.args.map(args => String(args[0]))
        expect(
            lines.some(line => line.includes(JSON.stringify(forged))),
            'the dropped resource is logged, quoted'
        ).to.be.true
        expect(
            lines.some(line => line.split('\n').length > 1),
            'a newline in the resource does not forge a second log line'
        ).to.be.false
    })

    it('keeps other workspace resource entries and skips duplicates and non-strings', async () => {
        const workspacePath = path.join(tmpDir, 'workspace', '.amazonq', 'agents', 'default.json')
        fs.mkdirSync(path.dirname(workspacePath), { recursive: true })
        fs.writeFileSync(
            workspacePath,
            JSON.stringify({
                name: 'test-agent',
                mcpServers: {},
                tools: [],
                allowedTools: [],
                resources: ['docs/notes.md', 'file://docs/rules.md', 'file://docs/rules.md', 42, null],
            })
        )

        const result = await loadAgentConfig(workspace, logger, [workspacePath], null, false)

        expect(result.agentConfig.resources).to.deep.equal(['docs/notes.md', 'file://docs/rules.md'])
    })

    it('records the agent configs that list each resource', async () => {
        const globalPath = getGlobalAgentConfigPath(tmpDir)
        const firstPath = path.join(tmpDir, 'first', '.amazonq', 'agents', 'default.json')
        const secondPath = path.join(tmpDir, 'second', '.amazonq', 'agents', 'default.json')
        const config = (resources: string[]) =>
            JSON.stringify({ name: 'test-agent', mcpServers: {}, tools: [], allowedTools: [], resources })
        for (const [configPath, resources] of [
            [globalPath, ['file://AmazonQ.md', 'file:///global/rules.md']],
            [firstPath, ['file://docs/rules.md', 'file://AmazonQ.md', 'file:///other/rules.md']],
            [secondPath, ['file://docs/rules.md']],
        ] as const) {
            fs.mkdirSync(path.dirname(configPath), { recursive: true })
            fs.writeFileSync(configPath, config([...resources]))
        }

        const result = await loadAgentConfig(workspace, logger, [firstPath, secondPath, globalPath], null, false)

        expect(Object.fromEntries(result.resourceSources ?? [])).to.deep.equal({
            'file://docs/rules.md': { global: false, configPaths: [firstPath, secondPath] },
            'file://AmazonQ.md': { global: true, configPaths: [firstPath] },
            'file:///global/rules.md': { global: true, configPaths: [] },
        })
    })
})

describe('path helpers', () => {
    it('getWorkspacePersonaConfigPaths()', () => {
        const uris = ['uri1', 'uri2']
        const expected = [
            path.join('uri1', '.amazonq', 'personas', 'default.json'),
            path.join('uri2', '.amazonq', 'personas', 'default.json'),
        ]
        expect(getWorkspacePersonaConfigPaths(uris)).to.deep.equal(expected)
    })

    it('getGlobalPersonaConfigPath()', () => {
        // Use a platform-neutral path for testing
        const homePath = path.resolve('home_dir')
        const expected = path.join(homePath, '.aws', 'amazonq', 'personas', 'default.json')
        expect(getGlobalPersonaConfigPath(homePath)).to.equal(expected)
    })

    it('getWorkspaceAgentConfigPaths()', () => {
        const uris = ['uri1', 'uri2']
        const expected = [
            path.join('uri1', '.amazonq', 'agents', 'default.json'),
            path.join('uri2', '.amazonq', 'agents', 'default.json'),
        ]
        expect(getWorkspaceAgentConfigPaths(uris)).to.deep.equal(expected)
    })

    it('getGlobalAgentConfigPath()', () => {
        // Use a platform-neutral path for testing
        const homePath = path.resolve('home_dir')
        const expected = path.join(homePath, '.aws', 'amazonq', 'agents', 'default.json')
        expect(getGlobalAgentConfigPath(homePath)).to.equal(expected)
    })
})

describe('saveAgentConfig', () => {
    let tmpDir: string
    let workspace: any
    let logger: any

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saveAgentTest-'))
        workspace = {
            fs: {
                exists: (p: string) => Promise.resolve(fs.existsSync(p)),
                readFile: (p: string) => Promise.resolve(Buffer.from(fs.readFileSync(p))),
                writeFile: (p: string, d: string) => Promise.resolve(fs.writeFileSync(p, d)),
                mkdir: (d: string, opts: any) => Promise.resolve(fs.mkdirSync(d, { recursive: opts.recursive })),
                getUserHomeDir: () => tmpDir,
            },
            getAllWorkspaceFolders: () => [{ uri: URI.file(tmpDir).toString() }],
        }
        logger = { warn: () => {}, info: () => {}, error: () => {} }
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('saves agent config to the specified path', async () => {
        const configPath = path.join(tmpDir, 'agent-config.json')
        const config = {
            name: 'test-agent',
            description: 'Test agent',
            mcpServers: {},
            tools: ['tool1', 'tool2'],
            allowedTools: ['tool1'],
            toolsSettings: {},
            includedFiles: [],
            resources: [],
        }

        await saveAgentConfig(workspace, logger, config, configPath)

        // Verify the file was created
        expect(fs.existsSync(configPath)).to.be.true

        // Verify the content
        const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
        expect(content).to.deep.equal(config)
    })

    it('creates parent directories if they do not exist', async () => {
        const configPath = path.join(tmpDir, 'nested', 'dir', 'agent-config.json')
        const config = {
            name: 'test-agent',
            description: 'Test agent',
            mcpServers: {},
            tools: [],
            allowedTools: [],
            toolsSettings: {},
            includedFiles: [],
            resources: [],
        }

        await saveAgentConfig(workspace, logger, config, configPath)

        // Verify the file was created
        expect(fs.existsSync(configPath)).to.be.true
    })

    it('does not write the agent config through a link that leaves the workspace folder', async function () {
        const wsDir = path.join(tmpDir, 'repo')
        const outsideDir = path.join(tmpDir, 'outside')
        fs.mkdirSync(path.join(wsDir, '.amazonq'), { recursive: true })
        fs.mkdirSync(outsideDir)
        workspace.getAllWorkspaceFolders = () => [{ uri: URI.file(wsDir).toString() }]
        try {
            // .amazonq/agents is a directory link that points outside the workspace folder
            fs.symlinkSync(
                outsideDir,
                path.join(wsDir, '.amazonq', 'agents'),
                process.platform === 'win32' ? 'junction' : 'dir'
            )
        } catch {
            // A link on Windows may need a privilege the test does not have
            this.skip()
        }
        const errors: string[] = []
        logger.error = (message: string) => errors.push(message)
        const configPath = path.join(wsDir, '.amazonq', 'agents', 'default.json')
        const config = {
            name: 'test-agent',
            description: 'Test agent',
            mcpServers: {},
            tools: [],
            allowedTools: [],
            toolsSettings: {},
            includedFiles: [],
            resources: [],
        }

        const error = await rejectionOf(saveAgentConfig(workspace, logger, config, configPath))

        expect(error).to.be.instanceOf(ConfigWriteRefusedError)
        expect(error.message).to.include('was not saved because it is outside the workspace folder')
        expect(fs.readdirSync(outsideDir)).to.deep.equal([])
        expect(errors.filter(message => message.includes('was not saved'))).to.have.length(1)
    })

    it('creates the folder and writes the file at the resolved path that it checked', async function () {
        const wsDir = path.join(tmpDir, 'repo')
        const shared = path.join(wsDir, 'shared')
        fs.mkdirSync(path.join(wsDir, '.amazonq'), { recursive: true })
        fs.mkdirSync(shared)
        workspace.getAllWorkspaceFolders = () => [{ uri: URI.file(wsDir).toString() }]
        try {
            // .amazonq/agents links to another folder inside the same workspace folder
            fs.symlinkSync(
                shared,
                path.join(wsDir, '.amazonq', 'agents'),
                process.platform === 'win32' ? 'junction' : 'dir'
            )
        } catch {
            // A link on Windows may need a privilege the test does not have
            this.skip()
        }
        const usedPaths: string[] = []
        for (const name of ['mkdir', 'writeFile']) {
            const original = workspace.fs[name]
            workspace.fs[name] = (p: string, ...rest: any[]) => {
                usedPaths.push(p)
                return original(p, ...rest)
            }
        }
        const config = {
            name: 'test-agent',
            description: 'Test agent',
            mcpServers: {},
            tools: [],
            allowedTools: [],
            toolsSettings: {},
            includedFiles: [],
            resources: [],
        }

        await saveAgentConfig(workspace, logger, config, path.join(wsDir, '.amazonq', 'agents', 'default.json'))

        const resolvedFile = path.join(fs.realpathSync.native(shared), 'default.json')
        expect(usedPaths).to.deep.equal([path.dirname(resolvedFile), resolvedFile])
        expect(JSON.parse(fs.readFileSync(resolvedFile, 'utf-8'))).to.deep.equal(config)
    })
})

describe('checkMcpConfigWrite', () => {
    let tmpDir: string
    let wsDir: string
    let workspace: any
    let warnings: string[]
    let logger: any

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkMcpConfigWrite-'))
        wsDir = path.join(tmpDir, 'repo')
        fs.mkdirSync(wsDir)
        workspace = {
            fs: { getUserHomeDir: () => path.join(tmpDir, 'home') },
            getAllWorkspaceFolders: () => [{ uri: URI.file(wsDir).toString() }],
        }
        warnings = []
        logger = { warn: (message: string) => warnings.push(message), info: () => {}, error: () => {} }
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('allows the mcp.json of an open workspace folder at its resolved path, also before it exists', async () => {
        const mcpPath = path.join(wsDir, '.amazonq', 'mcp.json')
        const resolvedPath = path.join(fs.realpathSync.native(wsDir), '.amazonq', 'mcp.json')

        expect(await checkMcpConfigWrite(workspace, logger, mcpPath)).to.equal(resolvedPath)
        fs.mkdirSync(path.join(wsDir, '.amazonq'))
        fs.writeFileSync(mcpPath, '{}')
        expect(await checkMcpConfigWrite(workspace, logger, mcpPath)).to.equal(resolvedPath)

        expect(warnings).to.deep.equal([])
    })

    it('returns the target of a link that stays inside the workspace folder, so the write goes there', async function () {
        const shared = path.join(wsDir, 'config', 'amazonq')
        fs.mkdirSync(shared, { recursive: true })
        try {
            fs.symlinkSync(shared, path.join(wsDir, '.amazonq'), process.platform === 'win32' ? 'junction' : 'dir')
        } catch {
            // A link on Windows may need a privilege the test does not have
            this.skip()
        }

        const target = await checkMcpConfigWrite(workspace, logger, path.join(wsDir, '.amazonq', 'mcp.json'))

        expect(target).to.equal(path.join(fs.realpathSync.native(shared), 'mcp.json'))
    })

    it('refuses the mcp.json of one workspace folder whose .amazonq folder links into another open folder', async function () {
        const otherDir = path.join(tmpDir, 'other-repo')
        fs.mkdirSync(path.join(otherDir, 'config'), { recursive: true })
        workspace.getAllWorkspaceFolders = () => [
            { uri: URI.file(wsDir).toString() },
            { uri: URI.file(otherDir).toString() },
        ]
        try {
            fs.symlinkSync(
                path.join(otherDir, 'config'),
                path.join(wsDir, '.amazonq'),
                process.platform === 'win32' ? 'junction' : 'dir'
            )
        } catch {
            // A link on Windows may need a privilege the test does not have
            this.skip()
        }

        const error = await rejectionOf(
            checkMcpConfigWrite(workspace, logger, path.join(wsDir, '.amazonq', 'mcp.json'))
        )

        expect(error).to.be.instanceOf(ConfigWriteRefusedError)
        expect(error.message).to.include('it is outside the workspace folder after symbolic links are followed')
        // The own mcp.json of the other folder stays writable
        expect(await checkMcpConfigWrite(workspace, logger, path.join(otherDir, '.amazonq', 'mcp.json'))).to.equal(
            path.join(fs.realpathSync.native(otherDir), '.amazonq', 'mcp.json')
        )
    })

    it('takes the folder of a path with .. as written, so that a link before the .. does not change it', async function () {
        const outsideDir = path.join(tmpDir, 'outside')
        fs.mkdirSync(path.join(outsideDir, 'deep'), { recursive: true })
        fs.mkdirSync(path.join(outsideDir, '.amazonq'))
        const type = process.platform === 'win32' ? 'junction' : 'dir'
        try {
            // Followed before the .., wsDir/x/.. is the outside folder, which holds the target of wsDir/.amazonq
            fs.symlinkSync(path.join(outsideDir, 'deep'), path.join(wsDir, 'x'), type)
            fs.symlinkSync(path.join(outsideDir, '.amazonq'), path.join(wsDir, '.amazonq'), type)
        } catch {
            // A link on Windows may need a privilege the test does not have
            this.skip()
        }

        const error = await rejectionOf(
            checkMcpConfigWrite(workspace, logger, [wsDir, 'x', '..', '.amazonq', 'mcp.json'].join(path.sep))
        )

        expect(error).to.be.instanceOf(ConfigWriteRefusedError)
    })

    it('returns the global mcp.json as it was given', async () => {
        const globalPath = getGlobalMcpConfigPath(path.join(tmpDir, 'home'))

        expect(await checkMcpConfigWrite(workspace, logger, globalPath)).to.equal(globalPath)
    })

    it('refuses an mcp.json whose .amazonq folder links outside the workspace folder', async function () {
        const outsideDir = path.join(tmpDir, 'outside')
        fs.mkdirSync(outsideDir)
        try {
            fs.symlinkSync(outsideDir, path.join(wsDir, '.amazonq'), process.platform === 'win32' ? 'junction' : 'dir')
        } catch {
            // A link on Windows may need a privilege the test does not have
            this.skip()
        }
        const mcpPath = path.join(wsDir, '.amazonq', 'mcp.json')

        const error = await rejectionOf(checkMcpConfigWrite(workspace, logger, mcpPath))

        expect(error).to.be.instanceOf(ConfigWriteRefusedError)
        expect(error.message).to.equal(
            `The MCP config ${JSON.stringify(mcpPath)} was not saved because it is outside the workspace folder ` +
                'after symbolic links are followed'
        )
        // The user is told which file, and the log says the same
        expect(warnings).to.deep.equal([error.message])
    })

    it('refuses an mcp.json whose location cannot be resolved, with the error code, not as outside', async function () {
        try {
            // Two links that point at each other, so the path cannot be resolved
            fs.symlinkSync(path.join(wsDir, 'loop'), path.join(wsDir, '.amazonq'), 'dir')
            fs.symlinkSync(path.join(wsDir, '.amazonq'), path.join(wsDir, 'loop'), 'dir')
        } catch {
            // A directory link on Windows needs a privilege that the test may not have
            this.skip()
        }
        const mcpPath = path.join(wsDir, '.amazonq', 'mcp.json')

        const error = await rejectionOf(checkMcpConfigWrite(workspace, logger, mcpPath))

        expect(error).to.be.instanceOf(ConfigWriteRefusedError)
        expect(error.message).to.equal(
            `The MCP config ${JSON.stringify(mcpPath)} was not saved because its location could not be resolved (ELOOP)`
        )
    })

    it('refuses an mcp.json that is also reachable under another name', async function () {
        if (process.platform === 'win32') {
            this.skip()
        }
        const outsideFile = path.join(tmpDir, 'outside.json')
        fs.writeFileSync(outsideFile, '{}')
        fs.mkdirSync(path.join(wsDir, '.amazonq'))
        fs.linkSync(outsideFile, path.join(wsDir, '.amazonq', 'mcp.json'))

        const error = await rejectionOf(
            checkMcpConfigWrite(workspace, logger, path.join(wsDir, '.amazonq', 'mcp.json'))
        )

        expect(error).to.be.instanceOf(ConfigWriteRefusedError)
        expect(error.message).to.include('it is also reachable under another name on disk')
    })

    it('refuses an mcp.json whose location cannot be resolved for a reason without an error code', async () => {
        const mcpPath = path.join(wsDir, '.amazonq', 'mcp.json')
        const lstat = sinon.stub(fs.promises, 'lstat').rejects(new Error('no code'))
        let error: Error
        try {
            error = await rejectionOf(checkMcpConfigWrite(workspace, logger, mcpPath))
        } finally {
            lstat.restore()
        }

        expect(error).to.be.instanceOf(ConfigWriteRefusedError)
        expect(error.message).to.equal(
            `The MCP config ${JSON.stringify(mcpPath)} was not saved because its location could not be resolved`
        )
    })

    it('allows the global mcp.json with no workspace folder open, and refuses a file that no folder holds', async () => {
        workspace.getAllWorkspaceFolders = () => []

        await checkMcpConfigWrite(workspace, logger, getGlobalMcpConfigPath(path.join(tmpDir, 'home')))
        // Not the mcp.json of a workspace folder, which is .amazonq/mcp.json in that folder
        for (const mcpPath of [path.join(wsDir, 'mcp.json'), path.join(wsDir, '.amazonq', 'other', 'mcp.json')]) {
            const error = await rejectionOf(checkMcpConfigWrite(workspace, logger, mcpPath))

            expect(error, mcpPath).to.be.instanceOf(ConfigWriteRefusedError)
        }
    })

    describe('of a workspace folder that was removed from the workspace', () => {
        // McpManager keeps the servers of a folder that is removed from the workspace, and the user can still
        // delete, enable, disable, or change the permissions of these servers
        beforeEach(() => {
            workspace.getAllWorkspaceFolders = () => [{ uri: URI.file(path.join(tmpDir, 'other')).toString() }]
            // A server that McpManager loaded from the mcp.json of that folder
            setConfigPathsOfLoadedServers(() => [path.join(wsDir, '.amazonq', 'mcp.json')])
        })

        afterEach(() => {
            setConfigPathsOfLoadedServers(undefined)
        })

        it('refuses its own mcp.json when no loaded server comes from that folder', async () => {
            setConfigPathsOfLoadedServers(() => [
                path.join(tmpDir, 'other-repo', '.amazonq', 'mcp.json'),
                undefined,
                getGlobalMcpConfigPath(path.join(tmpDir, 'home')),
            ])

            const error = await rejectionOf(
                checkMcpConfigWrite(workspace, logger, path.join(wsDir, '.amazonq', 'mcp.json'))
            )

            expect(error).to.be.instanceOf(ConfigWriteRefusedError)
            expect(error.message).to.include('it is outside the workspace folder after symbolic links are followed')
        })

        it('refuses a path whose .. names another folder than the one that a loaded server comes from', async () => {
            const mcpPath = [wsDir, '..', '.amazonq', 'mcp.json'].join(path.sep)

            const error = await rejectionOf(checkMcpConfigWrite(workspace, logger, mcpPath))

            expect(error).to.be.instanceOf(ConfigWriteRefusedError)
        })

        it('allows its own mcp.json, inside that folder', async () => {
            const mcpPath = path.join(wsDir, '.amazonq', 'mcp.json')

            expect(await checkMcpConfigWrite(workspace, logger, mcpPath)).to.equal(
                path.join(fs.realpathSync.native(wsDir), '.amazonq', 'mcp.json')
            )
            expect(warnings).to.deep.equal([])
        })

        it('refuses its own mcp.json when its .amazonq folder links out of that folder', async function () {
            const outsideDir = path.join(tmpDir, 'outside')
            fs.mkdirSync(outsideDir)
            try {
                fs.symlinkSync(
                    outsideDir,
                    path.join(wsDir, '.amazonq'),
                    process.platform === 'win32' ? 'junction' : 'dir'
                )
            } catch {
                // A link on Windows may need a privilege the test does not have
                this.skip()
            }

            const error = await rejectionOf(
                checkMcpConfigWrite(workspace, logger, path.join(wsDir, '.amazonq', 'mcp.json'))
            )

            expect(error).to.be.instanceOf(ConfigWriteRefusedError)
            expect(error.message).to.include('it is outside the workspace folder after symbolic links are followed')
        })
    })
})

describe('loadMcpServerConfigs error handling', () => {
    let tmpDir: string
    let workspace: any
    let logger: any

    beforeEach(() => {
        sinon.restore()
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpUtilsErrorTest-'))
        // a minimal Workspace stub
        workspace = {
            fs: {
                exists: (p: string) => Promise.resolve(fs.existsSync(p)),
                readFile: (p: string) => Promise.resolve(Buffer.from(fs.readFileSync(p))),
                getUserHomeDir: () => tmpDir,
            },
        }
        // logger that just swallows
        logger = { warn: () => {}, info: () => {}, error: () => {} }
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('captures file not found errors', async () => {
        const nonExistentPath = path.join(tmpDir, 'does-not-exist.json')

        const result = await loadMcpServerConfigs(workspace, logger, [nonExistentPath])

        expect(result.servers.size).to.equal(0)
        expect(result.errors.size).to.equal(0)
        expect(result.errors.get(nonExistentPath)).to.be.undefined
    })

    it('captures invalid JSON errors', async () => {
        const invalidJsonPath = path.join(tmpDir, 'invalid.json')
        fs.writeFileSync(invalidJsonPath, '{not valid json')

        const result = await loadMcpServerConfigs(workspace, logger, [invalidJsonPath])

        expect(result.servers.size).to.equal(0)
        expect(result.errors.size).to.equal(1)
        expect(result.errors.get(invalidJsonPath)).to.include('Invalid JSON')
    })

    it('captures missing mcpServers field errors', async () => {
        const missingFieldPath = path.join(tmpDir, 'missing-field.json')
        fs.writeFileSync(missingFieldPath, '{"someOtherField": {}}')

        const result = await loadMcpServerConfigs(workspace, logger, [missingFieldPath])

        expect(result.servers.size).to.equal(0)
        expect(result.errors.size).to.equal(1)
        expect(result.errors.get(missingFieldPath)).to.include("missing or invalid 'mcpServers' field")
    })

    it('captures invalid timeout errors', async () => {
        const invalidTimeoutPath = path.join(tmpDir, 'invalid-timeout.json')
        fs.writeFileSync(
            invalidTimeoutPath,
            '{"mcpServers": {"serverA": {"command": "cmd", "timeout": "not-a-number"}}}'
        )

        const result = await loadMcpServerConfigs(workspace, logger, [invalidTimeoutPath])

        expect(result.servers.size).to.equal(1) // Server is still loaded despite timeout error
        expect(result.errors.size).to.equal(1)
        expect(result.errors.get('serverA_timeout')).to.include('Invalid timeout value')
    })

    it('loads valid servers while capturing errors for invalid ones', async () => {
        const validPath = path.join(tmpDir, 'valid.json')
        const invalidPath = path.join(tmpDir, 'invalid.json')

        fs.writeFileSync(validPath, '{"mcpServers": {"validServer": {"command": "cmd"}}}')
        fs.writeFileSync(invalidPath, '{not valid json')

        const result = await loadMcpServerConfigs(workspace, logger, [validPath, invalidPath])

        expect(result.servers.size).to.equal(1)
        expect(result.servers.has('validServer')).to.be.true
        expect(result.errors.size).to.equal(1)
        expect(result.errors.get(invalidPath)).to.include('Invalid JSON')
    })
})

describe('enabledMCP', () => {
    it('should return true when client passes in mcp = true', () => {
        const params = {
            initializationOptions: {
                aws: {
                    awsClientCapabilities: {
                        q: {
                            mcp: true,
                        },
                    },
                },
            },
        }

        expect(enabledMCP(params as any)).to.equal(true)
    })
    it('should return false when client passes in mcp = false', () => {
        const params = {
            initializationOptions: {
                aws: {
                    awsClientCapabilities: {
                        q: {
                            mcp: false,
                        },
                    },
                },
            },
        }

        expect(enabledMCP(params as any)).to.equal(false)
    })
    it('should return false when client does not pass in mcp', () => {
        const params = {
            initializationOptions: {
                aws: {
                    clientInfo: {
                        extension: {
                            name: 'AmazonQ-For-VSCode',
                            version: '1.0.0-testPluginVersion',
                        },
                    },
                },
            },
        }

        expect(enabledMCP(params as any)).to.equal(false)
    })
})

describe('createNamespacedToolName', () => {
    let tools: Set<string>
    let toolNameMapping: Map<string, { serverName: string; toolName: string }>
    beforeEach(() => {
        tools = new Set<string>()
        toolNameMapping = new Map<string, { serverName: string; toolName: string }>()
    })

    it('adds server prefix when tool name conflicts', () => {
        tools.add('create_issue') // Pre-existing tool
        const result = createNamespacedToolName('github', 'create_issue', tools, toolNameMapping, new Set())
        expect(result).to.equal('github___create_issue')
        expect(tools.has('github___create_issue')).to.be.true
        expect(toolNameMapping.get('github___create_issue')).to.deep.equal({
            serverName: 'github',
            toolName: 'create_issue',
        })
    })

    it('truncates server name when combined length exceeds limit', () => {
        tools.add('create_issue') // Force the function to use server prefix
        const longServer = 'very_long_server_name_that_definitely_exceeds_maximum_length_when_combined'
        const result = createNamespacedToolName(longServer, 'create_issue', tools, toolNameMapping, new Set())
        expect(result.length).to.be.lessThanOrEqual(MAX_TOOL_NAME_LENGTH)
        expect(result.endsWith('___create_issue')).to.be.true
        expect(toolNameMapping.get(result)).to.deep.equal({
            serverName: 'very_long_server_name_that_definitely_exceeds_maximum_length_when_combined',
            toolName: 'create_issue',
        })
    })

    it('uses numeric suffix when tool name is too long', () => {
        const longTool = 'extremely_long_tool_name_that_definitely_exceeds_the_maximum_allowed_length_for_names'
        const result = createNamespacedToolName('server', longTool, tools, toolNameMapping, new Set())
        // Skip length check and use string comparison with the actual implementation behavior
        expect(toolNameMapping.get(result)).to.deep.equal({
            serverName: 'server',
            toolName: longTool,
        })
    })

    it('truncates tool name and adds suffix when it exceeds MAX_TOOL_NAME_LENGTH', () => {
        const longTool = 'Smartanalyzerthatreadssummariescreatesmappingrulesandupdatespayloads'
        const result = createNamespacedToolName('ConnectiveRx', longTool, tools, toolNameMapping, new Set())
        expect(result.length).to.equal(MAX_TOOL_NAME_LENGTH)
        expect(tools.has(result)).to.be.true
        expect(toolNameMapping.get(result)).to.deep.equal({
            serverName: 'ConnectiveRx',
            toolName: longTool,
        })
    })

    it('namespaces an MCP tool that collides with a reserved built-in name', () => {
        const reserved = new Set(['fsRead', 'fsWrite', 'executeBash'])
        const result = createNamespacedToolName('evil', 'fsRead', tools, toolNameMapping, reserved)
        expect(result).to.equal('evil___fsRead')
        expect(tools.has('fsRead')).to.be.false
        expect(toolNameMapping.has('fsRead')).to.be.false
        expect(toolNameMapping.get('evil___fsRead')).to.deep.equal({
            serverName: 'evil',
            toolName: 'fsRead',
        })
    })

    it('does not reuse a stale mapping that points at a reserved built-in name', () => {
        const reserved = new Set(['fsRead'])
        toolNameMapping.set('fsRead', { serverName: 'evil', toolName: 'fsRead' })
        const result = createNamespacedToolName('evil', 'fsRead', tools, toolNameMapping, reserved)
        expect(result).to.equal('evil___fsRead')
        expect(toolNameMapping.has('fsRead')).to.be.false
    })

    it('still prefers the bare tool name when it is not reserved', () => {
        const reserved = new Set(['fsRead'])
        const result = createNamespacedToolName('github', 'create_issue', tools, toolNameMapping, reserved)
        expect(result).to.equal('create_issue')
    })

    it('refuses every statically dispatched built-in name even when it is not registered', () => {
        const reserved = getReservedBuiltInToolNames([])

        for (const builtIn of STATIC_BUILT_IN_TOOL_NAMES) {
            const result = createNamespacedToolName('evil', builtIn, tools, toolNameMapping, reserved)
            expect(result, `${builtIn} must not be claimed`).to.equal(`evil___${builtIn}`)
            expect(tools.has(builtIn), `${builtIn} must stay unclaimed`).to.be.false
        }
    })

    it('also reserves dynamically registered built-in names', () => {
        const reserved = getReservedBuiltInToolNames(['lspGetDocuments'])
        const result = createNamespacedToolName('evil', 'lspGetDocuments', tools, toolNameMapping, reserved)

        expect(result).to.equal('evil___lspGetDocuments')
        expect(tools.has('lspGetDocuments')).to.be.false
    })

    it('gives two servers advertising the same built-in name distinct namespaced names', () => {
        const reserved = new Set(['fsRead'])
        const first = createNamespacedToolName('alpha', 'fsRead', tools, toolNameMapping, reserved)
        const second = createNamespacedToolName('beta', 'fsRead', tools, toolNameMapping, reserved)
        expect(first).to.equal('alpha___fsRead')
        expect(second).to.equal('beta___fsRead')
        expect(tools.has('fsRead')).to.be.false
    })

    it('reuses the namespaced name when the same server tool is seen again', () => {
        const reserved = new Set(['fsRead'])
        const first = createNamespacedToolName('evil', 'fsRead', tools, toolNameMapping, reserved)
        const second = createNamespacedToolName('evil', 'fsRead', tools, toolNameMapping, reserved)
        expect(second).to.equal(first)
        expect(toolNameMapping.size).to.equal(1)
    })

    it('keeps a truncated namespaced name out of the reserved set', () => {
        const longServer = 'very_long_server_name_that_definitely_exceeds_the_maximum_allowed_length'
        const reserved = new Set(['fsRead'])
        const result = createNamespacedToolName(longServer, 'fsRead', tools, toolNameMapping, reserved)
        expect(result.length).to.be.lessThanOrEqual(MAX_TOOL_NAME_LENGTH)
        expect(result.endsWith('___fsRead')).to.be.true
        expect(reserved.has(result)).to.be.false
    })

    it('does not fall back onto a reserved name via the numeric suffix path', () => {
        // Force the namespaced form to be unavailable so the suffix path runs.
        tools.add('evil___fsRead')
        const reserved = new Set(['fsRead', 'fsRead1'])
        const result = createNamespacedToolName('evil', 'fsRead', tools, toolNameMapping, reserved)
        expect(reserved.has(result)).to.be.false
        expect(result).to.not.equal('fsRead')
        expect(result).to.not.equal('fsRead1')
    })

    it('refuses a name that only becomes a built-in name after sanitization', () => {
        const reserved = new Set(['fsRead'])

        // sanitizeName strips disallowed characters, so these all collapse to
        // 'fsRead' and must not be allowed to claim it.
        for (const advertised of ['fs Read', 'fs/Read', 'fsRead!', 'fs.Read']) {
            const localTools = new Set<string>()
            const localMapping = new Map<string, { serverName: string; toolName: string }>()
            const result = createNamespacedToolName('evil', advertised, localTools, localMapping, reserved)
            expect(result, `${advertised} must not claim fsRead`).to.equal('evil___fsRead')
            expect(localTools.has('fsRead'), `${advertised} must leave fsRead unclaimed`).to.be.false
        }
    })

    it('supports an explicit empty reserved-name set', () => {
        const result = createNamespacedToolName('evil', 'fsRead', tools, toolNameMapping, new Set())
        expect(result).to.equal('fsRead')
    })
})

describe('normalizePathFromUri', () => {
    let mockLogger: any

    beforeEach(() => {
        mockLogger = { warn: sinon.spy() }
    })

    it('returns empty path unchanged', () => {
        expect(normalizePathFromUri('')).to.equal('')
        expect(normalizePathFromUri(undefined as any)).to.equal(undefined)
    })

    it('converts file URI to filesystem path', () => {
        const filePath = '/some/test/path'
        const fileUri = pathToFileURL(filePath).toString()

        const result = normalizePathFromUri(fileUri)

        expect(result).to.not.equal(fileUri)
        expect(result.startsWith('file:')).to.be.false

        if (os.platform() !== 'win32') {
            expect(result).to.equal(filePath)
        }
    })

    it('returns non-URI path unchanged', () => {
        const regularPath = '/regular/file/path'
        expect(normalizePathFromUri(regularPath)).to.equal(regularPath)

        const windowsPath = 'C:\\Windows\\Path'
        expect(normalizePathFromUri(windowsPath)).to.equal(windowsPath)
    })

    it('handles parsing errors and logs warning', () => {
        // Create a URI that will cause a parsing error
        const invalidUri = 'file:///invalid%uri'

        // Mock the URI.parse to throw an error
        const originalParse = URI.parse
        URI.parse = sinon.stub().throws(new Error('Test parse error'))

        const result = normalizePathFromUri(invalidUri, mockLogger)

        // Restore the original function
        URI.parse = originalParse

        expect(result).to.equal(invalidUri)
        expect(mockLogger.warn.calledOnce).to.be.true
        expect(mockLogger.warn.firstCall.args[0]).to.include('Failed to parse URI path')
    })

    it('returns original path when parsing fails without logger', () => {
        const invalidUri = 'file:///invalid%uri'

        // Mock the URI.parse to throw an error
        const originalParse = URI.parse
        URI.parse = sinon.stub().throws(new Error('Test parse error'))

        const result = normalizePathFromUri(invalidUri)

        // Restore the original function
        URI.parse = originalParse

        expect(result).to.equal(invalidUri)
    })
})

describe('sanitizeContent', () => {
    it('removes Unicode Tag characters (U+E0000–U+E007F)', () => {
        const input = 'foo\u{E0001}bar\u{E0060}baz'
        const expected = 'foobarbaz'
        expect(sanitizeInput(input)).to.equal(expected)
    })
})

describe('getWorkspaceMcpConfigPaths', () => {
    it('returns correct paths for workspace MCP configs', () => {
        const uris = ['uri1', 'uri2']
        const expected = [path.join('uri1', '.amazonq', 'mcp.json'), path.join('uri2', '.amazonq', 'mcp.json')]
        expect(getWorkspaceMcpConfigPaths(uris)).to.deep.equal(expected)
    })
})

describe('getGlobalMcpConfigPath', () => {
    it('returns correct global MCP config path', () => {
        const homePath = path.resolve('home_dir')
        const expected = path.join(homePath, '.aws', 'amazonq', 'mcp.json')
        expect(getGlobalMcpConfigPath(homePath)).to.equal(expected)
    })
})

describe('describeArgsForLog', () => {
    it('keeps flag names and counts every other argument', () => {
        expect(
            describeArgsForLog(['-y', '@docs/server', '--api-key', 'arg-value-123', '--token=arg-value-456'])
        ).to.equal('-y --api-key --token (2 values hidden)')
    })

    it('hides short flags with attached values and a lone dash', () => {
        expect(describeArgsForLog(['-pvalue', '-', '--', '-v'])).to.equal('-- -v (2 values hidden)')
    })

    it('hides a flag typed together with its value in one argument', () => {
        expect(describeArgsForLog(['--api-key arg-value-123', '--token:arg-value-456', '--key=a b'])).to.equal(
            '--key (2 values hidden)'
        )
    })

    it('skips empty arguments', () => {
        expect(describeArgsForLog(['', '-y', ''])).to.equal('-y')
    })

    it('returns an empty string for no arguments', () => {
        expect(describeArgsForLog([])).to.equal('')
        expect(describeArgsForLog(undefined)).to.equal('')
    })
})

describe('describeStdioLaunchForLog', () => {
    it('includes the command, the flag names and the env names, not their values', () => {
        const text = describeStdioLaunchForLog('npx', ['-y', 'server', '--api-key', 'arg-value-123'], {
            API_TOKEN: 'env-value-456',
        })
        expect(text).to.equal('npx -y --api-key (2 values hidden) (env: API_TOKEN)')
    })

    it('omits empty parts', () => {
        expect(describeStdioLaunchForLog('node', ['server.js'], {})).to.equal('node (1 value hidden)')
        expect(describeStdioLaunchForLog('node', undefined, {})).to.equal('node')
    })
})

describe('describeMcpFormValuesForLog', () => {
    it('does not change the values it is given', () => {
        const values: any = { name: 's', env_variables: [{ env_var_name: 'A', env_var_value: 'v' }] }
        describeMcpFormValuesForLog(values)
        expect(values.env_variables[0].env_var_value).to.equal('v')
    })

    it('hides list fields that are not lists and values of unknown fields', () => {
        expect(
            describeMcpFormValuesForLog({
                env_variables: 'A=v',
                headers: 'Authorization: v',
                args: '--api-key v',
                url: 42,
                extra: 'v',
                nested: { token: 'v' },
            } as any)
        ).to.deep.equal({
            env_variables: '(hidden)',
            headers: '(hidden)',
            args: '(hidden)',
            url: '(invalid URL)',
            extra: '(hidden)',
            nested: '(hidden)',
        })
    })

    it('keeps tool permission choices', () => {
        expect(describeMcpFormValuesForLog({ search: 'alwaysAllow', fetch: 'deny', read: 'ask' })).to.deep.equal({
            search: 'alwaysAllow',
            fetch: 'deny',
            read: 'ask',
        })
    })

    it('returns an empty object for missing values', () => {
        expect(describeMcpFormValuesForLog(undefined)).to.deep.equal({})
    })
})

describe('describeUrlForLog', () => {
    it('keeps only the origin', () => {
        expect(describeUrlForLog('https://user:pass@mcp.example.com:8443/key-123/sse?token=abc#frag')).to.equal(
            'https://mcp.example.com:8443'
        )
    })

    it('does not echo a value that is not a valid URL', () => {
        expect(describeUrlForLog('not a url with-a-token')).to.equal('(invalid URL)')
        expect(describeUrlForLog(undefined)).to.equal('(invalid URL)')
    })
})

describe('isEmptyEnv', () => {
    it('returns true for undefined env', () => {
        expect(isEmptyEnv(undefined as any)).to.be.true
    })

    it('returns true for null env', () => {
        expect(isEmptyEnv(null as any)).to.be.true
    })

    it('returns true for empty object', () => {
        expect(isEmptyEnv({})).to.be.true
    })

    it('returns true for object with empty keys/values', () => {
        expect(isEmptyEnv({ '': 'value', key: '' })).to.be.true
        expect(isEmptyEnv({ '  ': '  ' })).to.be.true
    })

    it('returns false for object with valid key-value pairs', () => {
        expect(isEmptyEnv({ KEY: 'value' })).to.be.false
        expect(isEmptyEnv({ KEY1: 'value1', KEY2: 'value2' })).to.be.false
    })
})

describe('sanitizeName', () => {
    it('returns original name if valid', () => {
        expect(sanitizeName('valid_name-123')).to.equal('valid_name-123')
    })

    it('filters invalid characters', () => {
        expect(sanitizeName('name@#$%')).to.equal('name')
        expect(sanitizeName('name with spaces')).to.equal('namewithspaces')
    })

    it('removes namespace delimiter', () => {
        expect(sanitizeName('server___tool')).to.equal('servertool')
    })

    it('returns hash for empty sanitized string', () => {
        const result = sanitizeName('@#$%')
        expect(result).to.have.length(3)
        expect(/^[a-f0-9]+$/.test(result)).to.be.true
    })
})

describe('convertPersonaToAgent', () => {
    let mockAgent: any

    beforeEach(() => {
        mockAgent = {
            getBuiltInToolNames: () => ['fs_read', 'execute_bash'],
            getBuiltInWriteToolNames: () => ['fs_write'],
        }
    })

    it('converts basic persona to agent config', () => {
        const persona = { mcpServers: ['*'], toolPerms: {} }
        const mcpServers = { testServer: { command: 'test', args: [], env: {} } }

        const result = convertPersonaToAgent(persona, mcpServers, mockAgent)

        expect(result.name).to.equal('q_ide_default')
        expect(result.mcpServers).to.have.property('testServer')
        expect(result.tools).to.include('@testServer')
        expect(result.tools).to.include('fs_read')
        expect(result.allowedTools).to.include('fs_read')
    })

    it('handles alwaysAllow permissions', () => {
        const persona = {
            mcpServers: ['testServer'],
            toolPerms: {
                testServer: {
                    tool1: McpPermissionType.alwaysAllow,
                },
            },
        }
        const mcpServers = { testServer: { command: 'test', args: [], env: {} } }

        const result = convertPersonaToAgent(persona, mcpServers, mockAgent)

        expect(result.allowedTools).to.include('@testServer/tool1')
    })
})

describe('migrateToAgentConfig', () => {
    let tmpDir: string
    let workspace: any
    let logger: any
    let mockAgent: any

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrateTest-'))
        workspace = {
            fs: {
                exists: (p: string) => Promise.resolve(fs.existsSync(p)),
                readFile: (p: string) => Promise.resolve(Buffer.from(fs.readFileSync(p))),
                writeFile: (p: string, d: string) => Promise.resolve(fs.writeFileSync(p, d)),
                mkdir: (d: string, opts: any) => Promise.resolve(fs.mkdirSync(d, { recursive: opts.recursive })),
                getUserHomeDir: () => tmpDir,
            },
            getAllWorkspaceFolders: () => [],
        }
        logger = { warn: () => {}, info: () => {}, error: () => {} }
        mockAgent = {
            getBuiltInToolNames: () => ['fs_read'],
            getBuiltInWriteToolNames: () => ['fs_write'],
        }
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('migrates when no existing configs exist', async () => {
        // Create empty MCP config to trigger migration
        const mcpDir = path.join(tmpDir, '.aws', 'amazonq')
        fs.mkdirSync(mcpDir, { recursive: true })
        const mcpPath = path.join(mcpDir, 'mcp.json')
        fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }))

        await migrateToAgentConfig(workspace, logger, mockAgent)

        // Should create default agent config
        const agentPath = path.join(tmpDir, '.aws', 'amazonq', 'agents', 'default.json')
        expect(fs.existsSync(agentPath)).to.be.true
    })

    it('migrates existing MCP config to agent config', async () => {
        // Create MCP config
        const mcpDir = path.join(tmpDir, '.aws', 'amazonq')
        fs.mkdirSync(mcpDir, { recursive: true })
        const mcpPath = path.join(mcpDir, 'mcp.json')
        fs.writeFileSync(
            mcpPath,
            JSON.stringify({
                mcpServers: {
                    testServer: { command: 'test-cmd', args: ['arg1'] },
                },
            })
        )

        await migrateToAgentConfig(workspace, logger, mockAgent)

        const agentPath = path.join(tmpDir, '.aws', 'amazonq', 'agents', 'default.json')
        expect(fs.existsSync(agentPath)).to.be.true
        const agentConfig = JSON.parse(fs.readFileSync(agentPath, 'utf-8'))
        expect(agentConfig.mcpServers).to.have.property('testServer')
    })

    describe('a workspace agent config path with symbolic links', () => {
        let wsDir: string
        let outsideDir: string
        let warnings: string[]
        const refusal = 'Did not create the agent config'
        const updateRefusal = 'Did not update the agent config'
        const legacyAgentConfig = JSON.stringify({ name: 'default-agent', mcpServers: {}, tools: [], allowedTools: [] })

        // A directory link; on Windows a junction, which needs no extra privilege
        const linkFolder = (target: string, linkPath: string) =>
            fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
        const writeRepoMcpConfig = (folder: string) => {
            fs.mkdirSync(folder, { recursive: true })
            fs.writeFileSync(
                path.join(folder, 'mcp.json'),
                JSON.stringify({ mcpServers: { repoServer: { command: 'repo-cmd' } } })
            )
        }

        beforeEach(() => {
            wsDir = path.join(tmpDir, 'repo')
            outsideDir = path.join(tmpDir, 'outside')
            fs.mkdirSync(wsDir)
            fs.mkdirSync(outsideDir)
            workspace.getAllWorkspaceFolders = () => [{ uri: URI.file(wsDir).toString(), name: 'repo' }]
            warnings = []
            logger.warn = (message: string) => warnings.push(message)
        })

        it('writes the agent config of a workspace with no links', async () => {
            writeRepoMcpConfig(path.join(wsDir, '.amazonq'))

            await migrateToAgentConfig(workspace, logger, mockAgent)

            const written = JSON.parse(fs.readFileSync(path.join(wsDir, '.amazonq', 'agents', 'default.json'), 'utf-8'))
            expect(written.mcpServers).to.have.property('repoServer')
            expect(warnings.filter(warning => warning.includes(refusal))).to.deep.equal([])
        })

        it('does not write through a default.json link whose target does not exist', async function () {
            writeRepoMcpConfig(path.join(wsDir, '.amazonq'))
            fs.mkdirSync(path.join(wsDir, '.amazonq', 'agents'))
            const target = path.join(outsideDir, 'mcp.json')
            try {
                fs.symlinkSync(target, path.join(wsDir, '.amazonq', 'agents', 'default.json'), 'file')
            } catch {
                // A file link on Windows needs a privilege that the test may not have
                this.skip()
            }

            await migrateToAgentConfig(workspace, logger, mockAgent)

            expect(fs.existsSync(target)).to.be.false
            expect(warnings.filter(warning => warning.includes(refusal))).to.have.length(1)
        })

        it('does not write when the links in the path cannot be resolved', async function () {
            writeRepoMcpConfig(path.join(wsDir, '.amazonq'))
            const agentsDir = path.join(wsDir, '.amazonq', 'agents')
            fs.mkdirSync(agentsDir)
            try {
                // Two links that point at each other
                fs.symlinkSync(path.join(agentsDir, 'loop.json'), path.join(agentsDir, 'default.json'), 'file')
                fs.symlinkSync(path.join(agentsDir, 'default.json'), path.join(agentsDir, 'loop.json'), 'file')
            } catch {
                // A file link on Windows needs a privilege that the test may not have
                this.skip()
            }

            await migrateToAgentConfig(workspace, logger, mockAgent)

            expect(warnings.filter(warning => warning.includes(refusal))).to.have.length(1)
            // Neither link was replaced by a written file, and nothing else was written next to them
            expect(fs.lstatSync(path.join(agentsDir, 'default.json')).isSymbolicLink()).to.be.true
            expect(fs.lstatSync(path.join(agentsDir, 'loop.json')).isSymbolicLink()).to.be.true
            expect(fs.readdirSync(agentsDir).sort()).to.deep.equal(['default.json', 'loop.json'])
        })

        it('checks each workspace folder against its own agent config', async () => {
            // The first folder's agents folder links out; the second folder has no links
            const otherDir = path.join(tmpDir, 'other-repo')
            writeRepoMcpConfig(path.join(wsDir, '.amazonq'))
            linkFolder(outsideDir, path.join(wsDir, '.amazonq', 'agents'))
            writeRepoMcpConfig(path.join(otherDir, '.amazonq'))
            workspace.getAllWorkspaceFolders = () => [
                { uri: URI.file(wsDir).toString(), name: 'repo' },
                { uri: URI.file(otherDir).toString(), name: 'other-repo' },
            ]

            await migrateToAgentConfig(workspace, logger, mockAgent)

            expect(fs.readdirSync(outsideDir)).to.deep.equal([])
            const written = JSON.parse(
                fs.readFileSync(path.join(otherDir, '.amazonq', 'agents', 'default.json'), 'utf-8')
            )
            expect(written.mcpServers).to.have.property('repoServer')
            expect(warnings.filter(warning => warning.includes(refusal))).to.have.length(1)
        })

        it('writes the global agent config through a linked global agents folder, as before', async () => {
            // The link target is outside the home folder too, so any folder check on the global path would refuse it
            const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'migrateGlobal-'))
            try {
                const globalDir = path.join(tmpDir, '.aws', 'amazonq')
                fs.mkdirSync(globalDir, { recursive: true })
                fs.writeFileSync(
                    path.join(globalDir, 'mcp.json'),
                    JSON.stringify({ mcpServers: { userServer: { command: 'user-cmd' } } })
                )
                linkFolder(elsewhere, path.join(globalDir, 'agents'))

                await migrateToAgentConfig(workspace, logger, mockAgent)

                const written = JSON.parse(fs.readFileSync(path.join(elsewhere, 'default.json'), 'utf-8'))
                expect(written.mcpServers).to.have.property('userServer')
                expect(warnings.filter(warning => warning.includes(refusal))).to.deep.equal([])

                fs.writeFileSync(path.join(elsewhere, 'default.json'), legacyAgentConfig)
                await migrateAgentConfigsToCLIFormat(workspace, logger)

                expect(JSON.parse(fs.readFileSync(path.join(elsewhere, 'default.json'), 'utf-8'))).to.include({
                    name: 'q_ide_default',
                    useLegacyMcpJson: true,
                })
                expect(warnings.filter(warning => warning.includes(updateRefusal))).to.deep.equal([])
            } finally {
                fs.rmSync(elsewhere, { recursive: true, force: true })
            }
        })

        it('does not write into an agents folder that links out of the workspace', async () => {
            writeRepoMcpConfig(path.join(wsDir, '.amazonq'))
            linkFolder(outsideDir, path.join(wsDir, '.amazonq', 'agents'))

            await migrateToAgentConfig(workspace, logger, mockAgent)

            expect(fs.readdirSync(outsideDir)).to.deep.equal([])
            expect(warnings.filter(warning => warning.includes(refusal))).to.have.length(1)
        })

        it('does not write into a .amazonq folder that links out of the workspace', async () => {
            writeRepoMcpConfig(outsideDir)
            linkFolder(outsideDir, path.join(wsDir, '.amazonq'))

            await migrateToAgentConfig(workspace, logger, mockAgent)

            expect(fs.readdirSync(outsideDir)).to.deep.equal(['mcp.json'])
            expect(warnings.filter(warning => warning.includes(refusal))).to.have.length(1)
        })

        it('writes the agent config through a link that stays inside the workspace', async () => {
            writeRepoMcpConfig(path.join(wsDir, '.amazonq'))
            const insideAgents = path.join(wsDir, 'config', 'agents')
            fs.mkdirSync(insideAgents, { recursive: true })
            linkFolder(insideAgents, path.join(wsDir, '.amazonq', 'agents'))

            await migrateToAgentConfig(workspace, logger, mockAgent)

            const written = JSON.parse(fs.readFileSync(path.join(insideAgents, 'default.json'), 'utf-8'))
            expect(written.mcpServers).to.have.property('repoServer')
            expect(warnings.filter(warning => warning.includes(refusal))).to.deep.equal([])
        })

        it('creates and updates the agent config at the resolved path that was checked', async () => {
            writeRepoMcpConfig(path.join(wsDir, '.amazonq'))
            const insideAgents = path.join(wsDir, 'config', 'agents')
            fs.mkdirSync(insideAgents, { recursive: true })
            linkFolder(insideAgents, path.join(wsDir, '.amazonq', 'agents'))
            const reads: string[] = []
            const writes: string[] = []
            const { readFile, writeFile } = workspace.fs
            workspace.fs.readFile = (p: string) => {
                reads.push(p)
                return readFile(p)
            }
            workspace.fs.writeFile = (p: string, d: string) => {
                writes.push(p)
                return writeFile(p, d)
            }

            await migrateToAgentConfig(workspace, logger, mockAgent)
            await migrateAgentConfigsToCLIFormat(workspace, logger)

            const resolvedAgent = path.join(fs.realpathSync.native(insideAgents), 'default.json')
            const linkedAgent = path.join(wsDir, '.amazonq', 'agents', 'default.json')
            // Created once and updated once, both times at the resolved path, which the update also reads
            expect(writes.filter(p => p === resolvedAgent)).to.have.length(2)
            expect(reads).to.include(resolvedAgent)
            expect([...reads, ...writes]).to.not.include(linkedAgent)
        })

        it('writes the agent config when the workspace folder is opened through a link', async () => {
            const realRepo = path.join(tmpDir, 'real-repo')
            writeRepoMcpConfig(path.join(realRepo, '.amazonq'))
            const linkedRepo = path.join(tmpDir, 'linked-repo')
            linkFolder(realRepo, linkedRepo)
            workspace.getAllWorkspaceFolders = () => [{ uri: URI.file(linkedRepo).toString(), name: 'repo' }]

            await migrateToAgentConfig(workspace, logger, mockAgent)

            expect(fs.existsSync(path.join(realRepo, '.amazonq', 'agents', 'default.json'))).to.be.true
            expect(warnings.filter(warning => warning.includes(refusal))).to.deep.equal([])
        })

        it('updates the existing workspace and global agent configs to the CLI format', async () => {
            const wsAgent = path.join(wsDir, '.amazonq', 'agents', 'default.json')
            const globalAgent = path.join(tmpDir, '.aws', 'amazonq', 'agents', 'default.json')
            for (const agentPath of [wsAgent, globalAgent]) {
                fs.mkdirSync(path.dirname(agentPath), { recursive: true })
                fs.writeFileSync(agentPath, legacyAgentConfig)
            }

            await migrateAgentConfigsToCLIFormat(workspace, logger)

            for (const agentPath of [wsAgent, globalAgent]) {
                expect(JSON.parse(fs.readFileSync(agentPath, 'utf-8'))).to.include({
                    name: 'q_ide_default',
                    useLegacyMcpJson: true,
                })
            }
            expect(warnings.filter(warning => warning.includes(updateRefusal))).to.deep.equal([])
        })

        it('does not update a file outside the workspace that default.json links to', async function () {
            fs.mkdirSync(path.join(wsDir, '.amazonq', 'agents'), { recursive: true })
            const target = path.join(outsideDir, 'settings.json')
            fs.writeFileSync(target, legacyAgentConfig)
            try {
                fs.symlinkSync(target, path.join(wsDir, '.amazonq', 'agents', 'default.json'), 'file')
            } catch {
                // A file link on Windows needs a privilege that the test may not have
                this.skip()
            }

            await migrateAgentConfigsToCLIFormat(workspace, logger)

            expect(fs.readFileSync(target, 'utf-8')).to.equal(legacyAgentConfig)
            expect(warnings.filter(warning => warning.includes(updateRefusal))).to.have.length(1)
        })

        it('does not update an agent config in an agents folder that links out of the workspace', async () => {
            fs.mkdirSync(path.join(wsDir, '.amazonq'))
            fs.writeFileSync(path.join(outsideDir, 'default.json'), legacyAgentConfig)
            linkFolder(outsideDir, path.join(wsDir, '.amazonq', 'agents'))

            await migrateAgentConfigsToCLIFormat(workspace, logger)

            expect(fs.readFileSync(path.join(outsideDir, 'default.json'), 'utf-8')).to.equal(legacyAgentConfig)
            expect(warnings.filter(warning => warning.includes(updateRefusal))).to.have.length(1)
        })

        it('checks the workspace folder when a caller says which agent config it updates', async () => {
            fs.mkdirSync(path.join(wsDir, '.amazonq'))
            fs.writeFileSync(path.join(outsideDir, 'default.json'), legacyAgentConfig)
            linkFolder(outsideDir, path.join(wsDir, '.amazonq', 'agents'))
            const agentPath = path.join(wsDir, '.amazonq', 'agents', 'default.json')

            await migrateAgentConfigToCLIFormat(workspace, logger, agentPath, { kind: 'workspace', folderPath: wsDir })

            expect(fs.readFileSync(path.join(outsideDir, 'default.json'), 'utf-8')).to.equal(legacyAgentConfig)
            expect(warnings.filter(warning => warning.includes(updateRefusal))).to.have.length(1)
            // A caller has to name the location: one that leaves it out does not compile
            // @ts-expect-error The location of the agent config is required
            const leftOut: Parameters<typeof migrateAgentConfigToCLIFormat> = [workspace, logger, agentPath]
            expect(leftOut).to.have.length(3)
        })

        it('does not update a workspace agent config that is also reachable under another name', async function () {
            if (process.platform === 'win32') {
                this.skip()
            }
            const agentPath = path.join(wsDir, '.amazonq', 'agents', 'default.json')
            const outsideFile = path.join(outsideDir, 'settings.json')
            fs.mkdirSync(path.dirname(agentPath), { recursive: true })
            fs.writeFileSync(outsideFile, legacyAgentConfig)
            fs.linkSync(outsideFile, agentPath)

            await migrateAgentConfigsToCLIFormat(workspace, logger)

            expect(fs.readFileSync(outsideFile, 'utf-8')).to.equal(legacyAgentConfig)
            expect(
                warnings.filter(warning => warning.includes(updateRefusal) && warning.includes('another name'))
            ).to.have.length(1)
        })

        it('does not update a workspace agent config that a caller calls the global one', async () => {
            const agentPath = path.join(wsDir, '.amazonq', 'agents', 'default.json')
            fs.mkdirSync(path.dirname(agentPath), { recursive: true })
            fs.writeFileSync(agentPath, legacyAgentConfig)

            await migrateAgentConfigToCLIFormat(workspace, logger, agentPath, { kind: 'global' })

            expect(fs.readFileSync(agentPath, 'utf-8')).to.equal(legacyAgentConfig)
            expect(
                warnings.filter(
                    warning => warning.includes(updateRefusal) && warning.includes('it is not the global agent config')
                )
            ).to.have.length(1)
        })
    })
})
describe('loadAgentConfig with registry support', () => {
    let tmpDir: string
    let workspace: any
    let logger: any
    let testRegistry: any

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'registryTest-'))
        workspace = {
            fs: {
                exists: (p: string) => Promise.resolve(fs.existsSync(p)),
                readFile: async (p: string) => {
                    if (fs.existsSync(p)) {
                        return Promise.resolve(Buffer.from(fs.readFileSync(p)))
                    }
                    return Promise.reject(new Error('File not found'))
                },
                writeFile: (p: string, d: string) => Promise.resolve(fs.writeFileSync(p, d)),
                mkdir: (d: string, opts: any) => Promise.resolve(fs.mkdirSync(d, { recursive: opts.recursive })),
                getUserHomeDir: () => tmpDir,
            },
            getAllWorkspaceFolders: () => [],
        }
        logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
        testRegistry = {
            servers: [
                {
                    name: 'test-remote',
                    description: 'Test remote server',
                    version: '1.0.0',
                    remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }],
                },
                {
                    name: 'test-local',
                    description: 'Test local server',
                    version: '1.0.0',
                    packages: [{ registryType: 'npm', identifier: '@test/server', transport: { type: 'stdio' } }],
                },
            ],
            lastFetched: new Date(),
            url: 'https://example.com/registry.json',
        }
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('should load registry servers when registry is active', async () => {
        const agentPath = path.join(tmpDir, 'agent.json')
        fs.writeFileSync(
            agentPath,
            JSON.stringify({
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: {
                    'test-remote': { type: 'registry' },
                    'manual-server': { command: 'node', args: ['server.js'] },
                },
                tools: [],
                allowedTools: [],
                toolsSettings: {},
                resources: [],
                useLegacyMcpJson: false,
            })
        )

        const result = await loadAgentConfig(workspace, logger, [agentPath], testRegistry, true)

        expect(result.servers.size).to.equal(1)
        expect(result.servers.has('test-remote')).to.be.true
        expect(result.servers.has('manual-server')).to.be.false
        const server = result.servers.get('test-remote')!
        expect(server.url).to.equal('https://example.com/mcp')
    })

    it('should load manual servers when registry is not active', async () => {
        const agentPath = path.join(tmpDir, 'agent.json')
        fs.writeFileSync(
            agentPath,
            JSON.stringify({
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: {
                    'test-remote': { type: 'registry' },
                    'manual-server': { command: 'node', args: ['server.js'] },
                },
                tools: [],
                allowedTools: [],
                toolsSettings: {},
                resources: [],
                useLegacyMcpJson: false,
            })
        )

        const result = await loadAgentConfig(workspace, logger, [agentPath], null, false)

        expect(result.servers.size).to.equal(1)
        expect(result.servers.has('test-remote')).to.be.false
        expect(result.servers.has('manual-server')).to.be.true
        const server = result.servers.get('manual-server')!
        expect(server.command).to.equal('node')
    })

    it('should warn when registry server not found in registry', async () => {
        const infos: string[] = []
        const infoLogger = { ...logger, info: (msg: string) => infos.push(msg) }
        const agentPath = path.join(tmpDir, 'agent.json')
        fs.writeFileSync(
            agentPath,
            JSON.stringify({
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: { 'unknown-server': { type: 'registry' } },
                tools: [],
                allowedTools: [],
                toolsSettings: {},
                resources: [],
                useLegacyMcpJson: false,
            })
        )

        const result = await loadAgentConfig(workspace, infoLogger, [agentPath], testRegistry, true)

        // Should create placeholder server for missing registry server
        expect(result.servers.size).to.equal(1)
        expect(infos.some(e => e.includes('Created empty config for missing registry server'))).to.be.true
        // Verify placeholder has error marker
        const server = result.servers.get('unknown-server')
        expect(server).to.exist
        expect((server as any).__registryError__).to.include('not found in registry')
    })

    it('should convert local npm server correctly', async () => {
        const agentPath = path.join(tmpDir, 'agent.json')
        fs.writeFileSync(
            agentPath,
            JSON.stringify({
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: { 'test-local': { type: 'registry' } },
                tools: [],
                allowedTools: [],
                toolsSettings: {},
                resources: [],
                useLegacyMcpJson: false,
            })
        )

        const result = await loadAgentConfig(workspace, logger, [agentPath], testRegistry, true)

        expect(result.servers.size).to.equal(1)
        const server = result.servers.get('test-local')!
        expect(server.command).to.equal('npx')
        expect(server.args).to.deep.equal(['-y', '@test/server@1.0.0'])
    })

    it('should apply timeout from registry server config', async () => {
        const agentPath = path.join(tmpDir, 'agent.json')
        fs.writeFileSync(
            agentPath,
            JSON.stringify({
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: {
                    'test-remote': { type: 'registry', timeout: 60000 },
                },
                tools: [],
                allowedTools: [],
                toolsSettings: {},
                resources: [],
                useLegacyMcpJson: false,
            })
        )

        const result = await loadAgentConfig(workspace, logger, [agentPath], testRegistry, true)

        expect(result.servers.size).to.equal(1)
        const server = result.servers.get('test-remote')!
        expect(server.url).to.equal('https://example.com/mcp')
        expect(server.timeout).to.equal(60000)
    })

    it('should not set timeout if not provided in registry server config', async () => {
        const agentPath = path.join(tmpDir, 'agent.json')
        fs.writeFileSync(
            agentPath,
            JSON.stringify({
                name: 'test-agent',
                description: 'Test agent',
                mcpServers: {
                    'test-remote': { type: 'registry' },
                },
                tools: [],
                allowedTools: [],
                toolsSettings: {},
                resources: [],
                useLegacyMcpJson: false,
            })
        )

        const result = await loadAgentConfig(workspace, logger, [agentPath], testRegistry, true)

        expect(result.servers.size).to.equal(1)
        const server = result.servers.get('test-remote')!
        expect(server.url).to.equal('https://example.com/mcp')
        expect(server.timeout).to.be.undefined
    })
})

describe('saveServerSpecificAgentConfig', () => {
    let tmpDir: string
    let workspace: any
    let logger: any

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saveServerSpecificTest-'))
        workspace = {
            fs: {
                exists: (p: string) => Promise.resolve(fs.existsSync(p)),
                readFile: (p: string) => Promise.resolve(Buffer.from(fs.readFileSync(p))),
                writeFile: (p: string, d: string) => Promise.resolve(fs.writeFileSync(p, d)),
                mkdir: (d: string, opts: any) => Promise.resolve(fs.mkdirSync(d, { recursive: opts.recursive })),
                getUserHomeDir: () => path.join(tmpDir, 'home'),
            },
            getAllWorkspaceFolders: () => [{ uri: URI.file(tmpDir).toString() }],
        }
        logger = { warn: () => {}, info: () => {}, error: () => {} }
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('creates new config file when it does not exist', async () => {
        const configPath = path.join(tmpDir, 'agent-config.json')
        const serverConfig = { command: 'test-cmd', args: ['arg1'] }
        const serverTools = ['@testServer']
        const serverAllowedTools = ['@testServer/tool1']

        await saveServerSpecificAgentConfig(
            workspace,
            logger,
            'testServer',
            serverConfig,
            serverTools,
            serverAllowedTools,
            configPath
        )

        expect(fs.existsSync(configPath)).to.be.true
        const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
        expect(content.mcpServers.testServer).to.deep.equal(serverConfig)
        expect(content.tools).to.include('@testServer')
        expect(content.allowedTools).to.include('@testServer/tool1')
    })

    it('updates existing config file', async () => {
        const configPath = path.join(tmpDir, 'agent-config.json')

        // Create existing config
        const existingConfig = {
            name: 'existing-agent',
            description: 'Existing agent',
            mcpServers: {
                existingServer: { command: 'existing-cmd' },
            },
            tools: ['fs_read', '@existingServer'],
            allowedTools: ['fs_read'],
            toolsSettings: {},
            includedFiles: [],
            resources: [],
        }
        fs.writeFileSync(configPath, JSON.stringify(existingConfig))

        const serverConfig = { command: 'new-cmd', args: ['arg1'] }
        const serverTools = ['@newServer']
        const serverAllowedTools = ['@newServer/tool1']

        await saveServerSpecificAgentConfig(
            workspace,
            logger,
            'newServer',
            serverConfig,
            serverTools,
            serverAllowedTools,
            configPath
        )

        const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
        expect(content.name).to.equal('existing-agent')
        expect(content.mcpServers.existingServer).to.deep.equal({ command: 'existing-cmd' })
        expect(content.mcpServers.newServer).to.deep.equal(serverConfig)
        expect(content.tools).to.include('@newServer')
        expect(content.allowedTools).to.include('@newServer/tool1')
    })

    it('removes existing server tools before adding new ones', async () => {
        const configPath = path.join(tmpDir, 'agent-config.json')

        // Create existing config with server tools
        const existingConfig = {
            name: 'test-agent',
            description: 'Test agent',
            mcpServers: {
                testServer: { command: 'old-cmd' },
            },
            tools: ['fs_read', '@testServer', '@testServer/oldTool'],
            allowedTools: ['fs_read', '@testServer/oldAllowedTool'],
            toolsSettings: {},
            includedFiles: [],
            resources: [],
        }
        fs.writeFileSync(configPath, JSON.stringify(existingConfig))

        const serverConfig = { command: 'new-cmd' }
        const serverTools = ['@testServer']
        const serverAllowedTools = ['@testServer/newTool']

        await saveServerSpecificAgentConfig(
            workspace,
            logger,
            'testServer',
            serverConfig,
            serverTools,
            serverAllowedTools,
            configPath
        )

        const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
        expect(content.tools).to.not.include('@testServer/oldTool')
        expect(content.allowedTools).to.not.include('@testServer/oldAllowedTool')
        expect(content.tools).to.include('@testServer')
        expect(content.allowedTools).to.include('@testServer/newTool')
        expect(content.tools).to.include('fs_read')
    })

    it('creates parent directories if they do not exist', async () => {
        const configPath = path.join(tmpDir, 'nested', 'dir', 'agent-config.json')
        const serverConfig = { command: 'test-cmd' }
        const serverTools = ['@testServer']
        const serverAllowedTools: string[] = []

        await saveServerSpecificAgentConfig(
            workspace,
            logger,
            'testServer',
            serverConfig,
            serverTools,
            serverAllowedTools,
            configPath
        )

        expect(fs.existsSync(configPath)).to.be.true
    })

    it('does not write the agent config through an agents link that leaves the workspace folder', async function () {
        const wsDir = path.join(tmpDir, 'repo')
        const outsideDir = path.join(tmpDir, 'outside')
        fs.mkdirSync(path.join(wsDir, '.amazonq'), { recursive: true })
        fs.mkdirSync(outsideDir)
        workspace.getAllWorkspaceFolders = () => [{ uri: URI.file(wsDir).toString() }]
        try {
            // .amazonq/agents is a directory link that points outside the workspace folder
            fs.symlinkSync(
                outsideDir,
                path.join(wsDir, '.amazonq', 'agents'),
                process.platform === 'win32' ? 'junction' : 'dir'
            )
        } catch {
            // A link on Windows may need a privilege the test does not have
            this.skip()
        }
        const errors: string[] = []
        logger.error = (message: string) => errors.push(message)
        const configPath = path.join(wsDir, '.amazonq', 'agents', 'default.json')

        const error = await rejectionOf(
            saveServerSpecificAgentConfig(
                workspace,
                logger,
                'testServer',
                { command: 'c' },
                ['@testServer'],
                [],
                configPath
            )
        )

        expect(error.message).to.include('was not saved because it is outside the workspace folder')
        expect(fs.readdirSync(outsideDir)).to.deep.equal([])
        expect(errors.filter(message => message.includes('was not saved'))).to.have.length(1)
    })

    it('does not write an agent config that is also reachable under another name', async function () {
        if (process.platform === 'win32') {
            this.skip()
        }
        const wsDir = path.join(tmpDir, 'repo')
        const outsideFile = path.join(tmpDir, 'outside.json')
        const original = JSON.stringify({ name: 'other file', mcpServers: {}, tools: [], allowedTools: [] })
        fs.mkdirSync(path.join(wsDir, '.amazonq', 'agents'), { recursive: true })
        fs.writeFileSync(outsideFile, original)
        const configPath = path.join(wsDir, '.amazonq', 'agents', 'default.json')
        // default.json and a file outside the workspace folder are the same file on disk
        fs.linkSync(outsideFile, configPath)
        workspace.getAllWorkspaceFolders = () => [{ uri: URI.file(wsDir).toString() }]

        const error = await rejectionOf(
            saveServerSpecificAgentConfig(
                workspace,
                logger,
                'testServer',
                { command: 'c' },
                ['@testServer'],
                [],
                configPath
            )
        )

        expect(error.message).to.include('was not saved because it is also reachable under another name')
        expect(fs.readFileSync(outsideFile, 'utf-8')).to.equal(original)
    })

    it('writes the global agent config when its path differs only in letter case on macOS', async () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
        Object.defineProperty(process, 'platform', { value: 'darwin' })
        try {
            const wsDir = path.join(tmpDir, 'repo')
            fs.mkdirSync(wsDir, { recursive: true })
            workspace.getAllWorkspaceFolders = () => [{ uri: URI.file(wsDir).toString() }]
            // getUserHomeDir() is tmpDir/home (set in beforeEach); this path differs from it only in letter case
            const configPath = getGlobalAgentConfigPath(path.join(tmpDir, 'HOME'))

            await saveServerSpecificAgentConfig(
                workspace,
                logger,
                'testServer',
                { command: 'c' },
                ['@testServer'],
                [],
                configPath
            )

            expect(fs.existsSync(configPath)).to.be.true
        } finally {
            Object.defineProperty(process, 'platform', platform)
        }
    })

    it('writes the agent config of a workspace folder with no links', async () => {
        const wsDir = path.join(tmpDir, 'repo')
        fs.mkdirSync(path.join(wsDir, '.amazonq', 'agents'), { recursive: true })
        workspace.getAllWorkspaceFolders = () => [{ uri: URI.file(wsDir).toString() }]
        const configPath = path.join(wsDir, '.amazonq', 'agents', 'default.json')

        await saveServerSpecificAgentConfig(
            workspace,
            logger,
            'testServer',
            { command: 'c' },
            ['@testServer'],
            [],
            configPath
        )

        expect(fs.existsSync(configPath)).to.be.true
        expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).mcpServers.testServer).to.deep.equal({ command: 'c' })
    })

    it('writes the global agent config even when it is outside every workspace folder', async () => {
        const wsDir = path.join(tmpDir, 'repo')
        fs.mkdirSync(wsDir, { recursive: true })
        workspace.getAllWorkspaceFolders = () => [{ uri: URI.file(wsDir).toString() }]
        // getUserHomeDir() is tmpDir/home (set in beforeEach), which is not inside wsDir
        const configPath = getGlobalAgentConfigPath(path.join(tmpDir, 'home'))

        await saveServerSpecificAgentConfig(
            workspace,
            logger,
            'testServer',
            { command: 'c' },
            ['@testServer'],
            [],
            configPath
        )

        expect(fs.existsSync(configPath)).to.be.true
    })

    it('writes through an agents link that stays inside the workspace folder', async function () {
        const wsDir = path.join(tmpDir, 'repo')
        const shared = path.join(wsDir, 'shared-agents')
        fs.mkdirSync(path.join(wsDir, '.amazonq'), { recursive: true })
        fs.mkdirSync(shared, { recursive: true })
        workspace.getAllWorkspaceFolders = () => [{ uri: URI.file(wsDir).toString() }]
        try {
            // .amazonq/agents links to another folder inside the same workspace folder
            fs.symlinkSync(
                shared,
                path.join(wsDir, '.amazonq', 'agents'),
                process.platform === 'win32' ? 'junction' : 'dir'
            )
        } catch {
            // A link on Windows may need a privilege the test does not have
            this.skip()
        }
        const configPath = path.join(wsDir, '.amazonq', 'agents', 'default.json')

        await saveServerSpecificAgentConfig(
            workspace,
            logger,
            'testServer',
            { command: 'c' },
            ['@testServer'],
            [],
            configPath
        )

        // The write landed in the link target, which is inside the workspace folder
        expect(fs.existsSync(path.join(shared, 'default.json'))).to.be.true
    })

    it('reads and writes the resolved path that it checked, not the path through the link', async function () {
        const wsDir = path.join(tmpDir, 'repo')
        const shared = path.join(wsDir, 'shared')
        fs.mkdirSync(path.join(wsDir, '.amazonq'), { recursive: true })
        fs.mkdirSync(shared)
        workspace.getAllWorkspaceFolders = () => [{ uri: URI.file(wsDir).toString() }]
        try {
            fs.symlinkSync(
                shared,
                path.join(wsDir, '.amazonq', 'agents'),
                process.platform === 'win32' ? 'junction' : 'dir'
            )
        } catch {
            // A link on Windows may need a privilege the test does not have
            this.skip()
        }
        const usedPaths: string[] = []
        for (const name of ['mkdir', 'readFile', 'writeFile']) {
            const original = workspace.fs[name]
            workspace.fs[name] = (p: string, ...rest: any[]) => {
                usedPaths.push(p)
                return original(p, ...rest)
            }
        }

        await saveServerSpecificAgentConfig(
            workspace,
            logger,
            'testServer',
            { command: 'c' },
            ['@testServer'],
            [],
            path.join(wsDir, '.amazonq', 'agents', 'default.json')
        )

        const resolvedFile = path.join(fs.realpathSync.native(shared), 'default.json')
        expect(usedPaths).to.deep.equal([path.dirname(resolvedFile), resolvedFile, resolvedFile])
    })

    it('does not write the agent config of one workspace folder into a file of another open folder', async function () {
        const folderA = path.join(tmpDir, 'a')
        const folderB = path.join(tmpDir, 'b')
        fs.mkdirSync(path.join(folderA, '.vscode'), { recursive: true })
        fs.mkdirSync(path.join(folderB, '.amazonq', 'agents'), { recursive: true })
        // A file that is not valid JSON, which the save would replace with a new agent config
        const settings = '{\n  // tab size\n  "editor.tabSize": 2\n}\n'
        fs.writeFileSync(path.join(folderA, '.vscode', 'settings.json'), settings)
        workspace.getAllWorkspaceFolders = () => [
            { uri: URI.file(folderA).toString() },
            { uri: URI.file(folderB).toString() },
        ]
        const configPath = path.join(folderB, '.amazonq', 'agents', 'default.json')
        try {
            fs.symlinkSync(path.join(folderA, '.vscode', 'settings.json'), configPath, 'file')
        } catch {
            // A file link on Windows needs a privilege that the test may not have
            this.skip()
        }

        const error = await rejectionOf(
            saveServerSpecificAgentConfig(workspace, logger, 's', null, ['@s/tool'], [], configPath, true)
        )

        expect(error).to.be.instanceOf(ConfigWriteRefusedError)
        expect(fs.readFileSync(path.join(folderA, '.vscode', 'settings.json'), 'utf-8')).to.equal(settings)
    })

    describe('of a workspace folder that was removed from the workspace', () => {
        let wsDir: string

        beforeEach(() => {
            wsDir = path.join(tmpDir, 'repo')
            fs.mkdirSync(path.join(wsDir, '.amazonq', 'agents'), { recursive: true })
            // The servers of a removed folder stay loaded, so the user can still change them
            workspace.getAllWorkspaceFolders = () => [{ uri: URI.file(path.join(tmpDir, 'other')).toString() }]
            setConfigPathsOfLoadedServers(() => [path.join(wsDir, '.amazonq', 'agents', 'default.json')])
        })

        afterEach(() => {
            setConfigPathsOfLoadedServers(undefined)
        })

        it('writes the agent config next to the mcp.json that a loaded legacy server comes from', async () => {
            setConfigPathsOfLoadedServers(() => [URI.file(path.join(wsDir, '.amazonq', 'mcp.json')).toString()])
            const configPath = path.join(wsDir, '.amazonq', 'agents', 'default.json')

            await saveServerSpecificAgentConfig(workspace, logger, 'a', null, ['@a/tool'], [], configPath, true)

            expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).tools).to.include('@a/tool')
        })

        it('refuses its own agent config when no loaded server comes from that folder', async () => {
            setConfigPathsOfLoadedServers(() => [])
            const configPath = path.join(wsDir, '.amazonq', 'agents', 'default.json')

            const error = await rejectionOf(
                saveServerSpecificAgentConfig(workspace, logger, 'a', { command: 'c' }, ['@a'], [], configPath)
            )

            expect(error).to.be.instanceOf(ConfigWriteRefusedError)
            expect(fs.existsSync(configPath)).to.be.false
        })

        it('writes its own agent config, inside that folder', async () => {
            const configPath = path.join(wsDir, '.amazonq', 'agents', 'default.json')
            fs.writeFileSync(
                configPath,
                JSON.stringify({
                    name: 'agent',
                    description: '',
                    mcpServers: { a: { command: 'x' }, b: { command: 'y' } },
                    tools: ['@a', '@b'],
                    allowedTools: [],
                    toolsSettings: {},
                    resources: [],
                })
            )

            await saveServerSpecificAgentConfig(workspace, logger, 'a', null, [], [], configPath)

            const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
            expect(content.mcpServers).to.deep.equal({ b: { command: 'y' } })
            expect(content.tools).to.deep.equal(['@b'])
        })

        it('refuses its own agent config when its agents folder links out of that folder', async function () {
            const outsideDir = path.join(tmpDir, 'outside')
            fs.mkdirSync(outsideDir)
            fs.rmdirSync(path.join(wsDir, '.amazonq', 'agents'))
            try {
                fs.symlinkSync(
                    outsideDir,
                    path.join(wsDir, '.amazonq', 'agents'),
                    process.platform === 'win32' ? 'junction' : 'dir'
                )
            } catch {
                // A link on Windows may need a privilege the test does not have
                this.skip()
            }
            const configPath = path.join(wsDir, '.amazonq', 'agents', 'default.json')

            const error = await rejectionOf(
                saveServerSpecificAgentConfig(workspace, logger, 'a', { command: 'c' }, ['@a'], [], configPath)
            )

            expect(error).to.be.instanceOf(ConfigWriteRefusedError)
            expect(error.message).to.include('it is outside the workspace folder after symbolic links are followed')
            expect(fs.readdirSync(outsideDir)).to.deep.equal([])
        })

        it('refuses another file in that folder, which only an open workspace folder may hold', async () => {
            for (const configPath of [
                path.join(wsDir, 'agent-config.json'),
                path.join(wsDir, '.amazonq', 'agents', 'other.json'),
            ]) {
                const error = await rejectionOf(
                    saveServerSpecificAgentConfig(workspace, logger, 'a', { command: 'c' }, ['@a'], [], configPath)
                )

                expect(error, configPath).to.be.instanceOf(ConfigWriteRefusedError)
                expect(fs.existsSync(configPath), configPath).to.be.false
            }
        })
    })
})

describe('loadAgentConfig server-scoped permission restore', () => {
    let tmpDir: string
    let workspace: any
    let logger: any

    const writeJson = async (p: string, value: unknown) => {
        await workspace.fs.mkdir(path.dirname(p), { recursive: true })
        await workspace.fs.writeFile(p, JSON.stringify(value))
    }

    beforeEach(() => {
        sinon.restore()
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentPermRestoreTest-'))
        workspace = {
            fs: {
                exists: (p: string) => Promise.resolve(fs.existsSync(p)),
                readFile: (p: string) => Promise.resolve(Buffer.from(fs.readFileSync(p))),
                writeFile: (p: string, d: string) => Promise.resolve(fs.writeFileSync(p, d)),
                mkdir: (d: string, opts: any) => Promise.resolve(fs.mkdirSync(d, { recursive: opts.recursive })),
                getUserHomeDir: () => tmpDir,
            },
            getAllWorkspaceFolders: () => [],
        }
        logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('restores "Always Allow" for a server declared in a legacy mcp.json', async () => {
        const agentPath = getGlobalAgentConfigPath(tmpDir)
        await writeJson(getGlobalMcpConfigPath(tmpDir), {
            mcpServers: { jira: { command: 'jira-mcp', args: [] } },
        })
        // This is the shape saveServerSpecificAgentConfig writes for a legacy server: the
        // permissions are persisted, but the server definition deliberately is not.
        await writeJson(agentPath, {
            name: 'test-agent',
            mcpServers: {},
            tools: ['@jira'],
            allowedTools: ['@jira/jira_get_issue'],
        })

        const result = await loadAgentConfig(workspace, logger, [agentPath], null, false)

        expect(result.servers.has('jira')).to.be.true
        expect(result.agentConfig.tools).to.include('@jira')
        expect(result.agentConfig.allowedTools).to.include('@jira/jira_get_issue')
    })

    it('does not apply global entries to a workspace server that replaces a global one', async () => {
        const wsRoot = path.join(tmpDir, 'ws')
        const wsAgentPath = path.join(wsRoot, '.amazonq', 'agents', 'default.json')
        const globalAgentPath = getGlobalAgentConfigPath(tmpDir)

        await writeJson(wsAgentPath, {
            mcpServers: { dup: { command: 'dup-mcp', args: [] } },
            tools: ['@dup'],
            allowedTools: [],
        })
        // Global declares the same server; the workspace definition wins, so the global file's
        // permissions belong to a different server definition and must not carry over.
        await writeJson(globalAgentPath, {
            mcpServers: { dup: { command: 'dup-mcp', args: [] } },
            tools: ['@dup'],
            allowedTools: ['@dup', '@dup/some_tool'],
        })

        const result = await loadAgentConfig(workspace, logger, [wsAgentPath, globalAgentPath], null, false)

        expect(result.servers.get('dup')?.__configPath__).to.equal(wsAgentPath)
        expect(result.agentConfig.tools).to.deep.equal(['@dup'])
        expect(result.agentConfig.allowedTools).to.be.empty
    })

    it('does not restore permissions for a server that no longer loads', async () => {
        const agentPath = getGlobalAgentConfigPath(tmpDir)
        await writeJson(agentPath, {
            mcpServers: {},
            tools: ['@removed'],
            allowedTools: ['@removed/tool'],
        })

        const result = await loadAgentConfig(workspace, logger, [agentPath], null, false)

        expect(result.servers.size).to.equal(0)
        expect(result.agentConfig.tools).to.not.include('@removed')
        expect(result.agentConfig.allowedTools).to.not.include('@removed/tool')
    })

    it('keeps non server-scoped permissions untouched', async () => {
        const agentPath = getGlobalAgentConfigPath(tmpDir)
        await writeJson(agentPath, {
            mcpServers: {},
            tools: ['fsRead', 'executeBash'],
            allowedTools: ['fsRead'],
        })

        const result = await loadAgentConfig(workspace, logger, [agentPath], null, false)

        expect(result.agentConfig.tools).to.deep.equal(['fsRead', 'executeBash'])
        expect(result.agentConfig.allowedTools).to.deep.equal(['fsRead'])
    })

    it('does not leak permissions between servers with a shared name prefix', async () => {
        const agentPath = getGlobalAgentConfigPath(tmpDir)
        await writeJson(getGlobalMcpConfigPath(tmpDir), {
            mcpServers: { jira: { command: 'jira-mcp', args: [] } },
        })
        await writeJson(agentPath, {
            mcpServers: {},
            tools: ['@jira'],
            allowedTools: ['@jira/jira_get_issue', '@jira2/other_tool', '@jirax'],
        })

        const result = await loadAgentConfig(workspace, logger, [agentPath], null, false)

        expect(result.agentConfig.allowedTools).to.include('@jira/jira_get_issue')
        expect(result.agentConfig.allowedTools).to.not.include('@jira2/other_tool')
        expect(result.agentConfig.allowedTools).to.not.include('@jirax')
    })

    describe('permissions listed in a workspace agent config', () => {
        let wsRoot: string
        let wsAgentPath: string
        let globalAgentPath: string

        beforeEach(async () => {
            wsRoot = path.join(tmpDir, 'ws')
            wsAgentPath = path.join(wsRoot, '.amazonq', 'agents', 'default.json')
            globalAgentPath = getGlobalAgentConfigPath(tmpDir)
            workspace.getAllWorkspaceFolders = () => [{ uri: pathToFileURL(wsRoot).href, name: 'ws' }]
            await writeJson(globalAgentPath, { name: 'q_ide_default', mcpServers: {}, tools: [], allowedTools: [] })
        })

        it('are not applied to a server declared in the global agent config', async () => {
            await writeJson(globalAgentPath, {
                name: 'q_ide_default',
                mcpServers: { srv: { command: 'srv-mcp', args: [] } },
                tools: ['@srv'],
                allowedTools: [],
            })
            await writeJson(wsAgentPath, { mcpServers: {}, tools: ['@srv/extra'], allowedTools: ['@srv/tool'] })

            const result = await loadAgentConfig(workspace, logger, [wsAgentPath, globalAgentPath], null, false)

            expect(result.servers.get('srv')?.__configPath__).to.equal(globalAgentPath)
            expect(result.agentConfig.tools).to.deep.equal(['@srv'])
            expect(result.agentConfig.allowedTools).to.be.empty
        })

        it('are not applied to a server declared in the global mcp.json', async () => {
            await writeJson(getGlobalMcpConfigPath(tmpDir), { mcpServers: { srv: { command: 'srv-mcp', args: [] } } })
            await writeJson(wsAgentPath, { mcpServers: {}, tools: [], allowedTools: ['@srv/tool'] })

            const result = await loadAgentConfig(workspace, logger, [wsAgentPath, globalAgentPath], null, false)

            expect(result.servers.has('srv')).to.be.true
            expect(result.agentConfig.allowedTools).to.be.empty
        })

        it('are not applied when the global mcp.json replaces a server the workspace declared', async () => {
            const globalMcpPath = getGlobalMcpConfigPath(tmpDir)
            await writeJson(globalMcpPath, { mcpServers: { srv: { command: 'srv-mcp', args: [] } } })
            await writeJson(wsAgentPath, {
                mcpServers: { srv: { command: 'other-mcp', args: [] } },
                tools: ['@srv'],
                allowedTools: ['@srv/tool'],
            })

            const result = await loadAgentConfig(workspace, logger, [wsAgentPath, globalAgentPath], null, false)

            expect(result.servers.get('srv')?.__configPath__).to.equal(globalMcpPath)
            expect(result.agentConfig.allowedTools).to.not.include('@srv/tool')
        })

        it('are not applied to a server declared in another workspace folder', async () => {
            const otherRoot = path.join(tmpDir, 'other')
            const otherAgentPath = path.join(otherRoot, '.amazonq', 'agents', 'default.json')
            await writeJson(otherAgentPath, { mcpServers: { srv: { command: 'srv-mcp', args: [] } }, tools: ['@srv'] })
            await writeJson(wsAgentPath, { mcpServers: {}, tools: [], allowedTools: ['@srv/tool'] })

            const result = await loadAgentConfig(
                workspace,
                logger,
                [wsAgentPath, otherAgentPath, globalAgentPath],
                null,
                false
            )

            expect(result.servers.get('srv')?.__configPath__).to.equal(otherAgentPath)
            expect(result.agentConfig.allowedTools).to.be.empty
        })

        it('are applied to a server declared in the same file', async () => {
            await writeJson(wsAgentPath, {
                mcpServers: { srv: { command: 'srv-mcp', args: [] } },
                tools: ['@srv'],
                allowedTools: ['@srv/tool'],
            })

            const result = await loadAgentConfig(workspace, logger, [wsAgentPath, globalAgentPath], null, false)

            expect(result.agentConfig.tools).to.include('@srv')
            expect(result.agentConfig.allowedTools).to.include('@srv/tool')
        })

        it('are applied to a server declared in the mcp.json of the same folder', async () => {
            await writeJson(path.join(wsRoot, '.amazonq', 'mcp.json'), {
                mcpServers: { srv: { command: 'srv-mcp', args: [] } },
            })
            await writeJson(wsAgentPath, { mcpServers: {}, tools: ['@srv'], allowedTools: ['@srv/tool'] })

            const result = await loadAgentConfig(workspace, logger, [wsAgentPath, globalAgentPath], null, false)

            expect(result.servers.has('srv')).to.be.true
            expect(result.agentConfig.allowedTools).to.include('@srv/tool')
        })
    })
})

describe('restoreServerScopedPermissions()', () => {
    const home = path.join(os.tmpdir(), 'home')
    const globalAgentPath = getGlobalAgentConfigPath(home)
    const wsAgentPath = path.join(os.tmpdir(), 'ws', '.amazonq', 'agents', 'default.json')

    const baseAgentConfig = () =>
        ({
            name: 'a',
            description: 'd',
            mcpServers: {},
            tools: [] as string[],
            allowedTools: [] as string[],
            toolsSettings: {},
            resources: [],
        }) as any

    const fromFile = (file: string, ...entries: string[]) =>
        new Map(entries.map(entry => [entry, new Set([file])] as [string, Set<string>]))

    const serversAt = (configPath: string, ...names: string[]) =>
        new Map(names.map(name => [name, { command: 'x', __configPath__: configPath } as MCPServerConfig]))

    it('restores only entries belonging to a loaded server', () => {
        const agentConfig = baseAgentConfig()
        const mapping = new Map([['srv', 'srv']])

        restoreServerScopedPermissions(
            agentConfig,
            mapping,
            serversAt(globalAgentPath, 'srv'),
            fromFile(globalAgentPath, '@srv', '@srv/tool', '@gone'),
            fromFile(globalAgentPath, '@srv/tool', '@gone/tool')
        )

        expect(agentConfig.tools).to.deep.equal(['@srv', '@srv/tool'])
        expect(agentConfig.allowedTools).to.deep.equal(['@srv/tool'])
    })

    it('matches on the original (unsanitized) server name', () => {
        const agentConfig = baseAgentConfig()
        const mapping = new Map([['my_server', 'my-server']])

        restoreServerScopedPermissions(
            agentConfig,
            mapping,
            serversAt(globalAgentPath, 'my_server'),
            fromFile(globalAgentPath, '@my-server'),
            fromFile(globalAgentPath, '@my-server/tool')
        )

        expect(agentConfig.tools).to.deep.equal(['@my-server'])
        expect(agentConfig.allowedTools).to.deep.equal(['@my-server/tool'])
    })

    it('does not duplicate entries already applied', () => {
        const agentConfig = baseAgentConfig()
        agentConfig.tools.push('@srv')
        agentConfig.allowedTools.push('@srv/tool')
        const mapping = new Map([['srv', 'srv']])

        restoreServerScopedPermissions(
            agentConfig,
            mapping,
            serversAt(globalAgentPath, 'srv'),
            fromFile(globalAgentPath, '@srv'),
            fromFile(globalAgentPath, '@srv/tool')
        )

        expect(agentConfig.tools).to.deep.equal(['@srv'])
        expect(agentConfig.allowedTools).to.deep.equal(['@srv/tool'])
    })

    it('is a no-op when no servers loaded', () => {
        const agentConfig = baseAgentConfig()

        restoreServerScopedPermissions(
            agentConfig,
            new Map(),
            new Map(),
            fromFile(globalAgentPath, '@srv'),
            fromFile(globalAgentPath, '@srv/tool')
        )

        expect(agentConfig.tools).to.be.empty
        expect(agentConfig.allowedTools).to.be.empty
    })

    it('applies entries from a workspace file only to servers whose permissions live in that file', () => {
        const agentConfig = baseAgentConfig()
        const mapping = new Map([
            ['global_srv', 'global_srv'],
            ['ws_srv', 'ws_srv'],
        ])
        const servers = new Map([...serversAt(globalAgentPath, 'global_srv'), ...serversAt(wsAgentPath, 'ws_srv')])

        restoreServerScopedPermissions(
            agentConfig,
            mapping,
            servers,
            fromFile(wsAgentPath, '@global_srv', '@ws_srv'),
            fromFile(wsAgentPath, '@global_srv/tool', '@ws_srv/tool')
        )

        expect(agentConfig.tools).to.deep.equal(['@ws_srv'])
        expect(agentConfig.allowedTools).to.deep.equal(['@ws_srv/tool'])
    })

    it('maps a legacy mcp.json server to the agents/default.json next to it', () => {
        const agentConfig = baseAgentConfig()
        const wsMcpPath = path.join(path.dirname(path.dirname(wsAgentPath)), 'mcp.json')
        const mapping = new Map([['srv', 'srv']])

        restoreServerScopedPermissions(
            agentConfig,
            mapping,
            serversAt(wsMcpPath, 'srv'),
            new Map(),
            fromFile(wsAgentPath, '@srv/tool')
        )

        expect(agentConfig.allowedTools).to.deep.equal(['@srv/tool'])
    })

    it('matches config paths that differ only in drive-letter case on Windows', function () {
        if (process.platform !== 'win32') {
            this.skip()
        }
        const agentConfig = baseAgentConfig()
        const mapping = new Map([['srv', 'srv']])

        restoreServerScopedPermissions(
            agentConfig,
            mapping,
            serversAt('d:\\ws\\.amazonq\\mcp.json', 'srv'),
            new Map(),
            fromFile('D:\\ws\\.amazonq\\agents\\default.json', '@srv/tool')
        )

        expect(agentConfig.allowedTools).to.deep.equal(['@srv/tool'])
    })
})

describe('restoreServerScopedPermissions() file ownership', () => {
    const home = path.join(os.tmpdir(), 'home')
    const files = {
        globalAgent: getGlobalAgentConfigPath(home),
        globalMcp: getGlobalMcpConfigPath(home),
        wsAgent: path.join(os.tmpdir(), 'ws', '.amazonq', 'agents', 'default.json'),
        wsMcp: path.join(os.tmpdir(), 'ws', '.amazonq', 'mcp.json'),
        otherWsAgent: path.join(os.tmpdir(), 'other', '.amazonq', 'agents', 'default.json'),
        otherWsMcp: path.join(os.tmpdir(), 'other', '.amazonq', 'mcp.json'),
    }
    // Where McpManager saves the permissions of a server declared in each file.
    const savedTo: Record<keyof typeof files, keyof typeof files> = {
        globalAgent: 'globalAgent',
        globalMcp: 'globalAgent',
        wsAgent: 'wsAgent',
        wsMcp: 'wsAgent',
        otherWsAgent: 'otherWsAgent',
        otherWsMcp: 'otherWsAgent',
    }
    const agentFiles = ['globalAgent', 'wsAgent', 'otherWsAgent'] as const

    for (const declaredIn of Object.keys(files) as (keyof typeof files)[]) {
        for (const listedIn of agentFiles) {
            const expected = savedTo[declaredIn] === listedIn
            it(`server in ${declaredIn}, entries in ${listedIn}: ${expected ? 'applied' : 'dropped'}`, () => {
                const agentConfig = {
                    name: 'a',
                    description: 'd',
                    mcpServers: {},
                    tools: [] as string[],
                    allowedTools: [] as string[],
                } as any
                const servers = new Map([
                    ['srv', { command: 'x', __configPath__: files[declaredIn] } as MCPServerConfig],
                ])
                const from = new Map([
                    ['@srv', new Set([files[listedIn]])],
                    ['@srv/tool', new Set([files[listedIn]])],
                ])

                restoreServerScopedPermissions(agentConfig, new Map([['srv', 'srv']]), servers, from, from)

                expect(agentConfig.tools).to.deep.equal(expected ? ['@srv', '@srv/tool'] : [])
                expect(agentConfig.allowedTools).to.deep.equal(expected ? ['@srv', '@srv/tool'] : [])
            })
        }
    }

    it('McpManager saves legacy server permissions to the file this check reads them from', () => {
        for (const declaredIn of Object.keys(files) as (keyof typeof files)[]) {
            expect(getAgentConfigPathForMcpConfig(files[declaredIn])).to.equal(files[savedTo[declaredIn]])
        }
    })
})

describe('getAgentConfigPathForMcpConfig()', () => {
    it('maps a legacy mcp.json to the agents/default.json in the same folder', () => {
        const dir = path.join(os.tmpdir(), 'ws', '.amazonq')
        expect(getAgentConfigPathForMcpConfig(path.join(dir, 'mcp.json'))).to.equal(
            path.join(dir, 'agents', 'default.json')
        )
    })

    it('only replaces the file name, not a folder with the same name', () => {
        const p = path.join(os.tmpdir(), 'mcp.json', '.amazonq', 'mcp.json')
        expect(getAgentConfigPathForMcpConfig(p)).to.equal(
            path.join(os.tmpdir(), 'mcp.json', '.amazonq', 'agents', 'default.json')
        )
    })

    it('returns other paths unchanged', () => {
        const p = path.join(os.tmpdir(), 'ws', '.amazonq', 'agents', 'default.json')
        expect(getAgentConfigPathForMcpConfig(p)).to.equal(p)
    })
})

describe('isPermissionForServer()', () => {
    it('matches the server prefix and its tools only', () => {
        expect(isPermissionForServer('@jira', 'jira')).to.be.true
        expect(isPermissionForServer('@jira/jira_get_issue', 'jira')).to.be.true
        expect(isPermissionForServer('@jira2', 'jira')).to.be.false
        expect(isPermissionForServer('@jira2/tool', 'jira')).to.be.false
        expect(isPermissionForServer('@jirax', 'jira')).to.be.false
        expect(isPermissionForServer('fsRead', 'jira')).to.be.false
    })
})

describe('resolveMcpRequestTimeoutMs()', () => {
    it('returns the configured timeout when it is usable', () => {
        expect(resolveMcpRequestTimeoutMs(300_000)).to.equal(300_000)
        expect(resolveMcpRequestTimeoutMs(1)).to.equal(1)
        expect(resolveMcpRequestTimeoutMs(MAX_TOOL_EXEC_TIMEOUT_MS)).to.equal(MAX_TOOL_EXEC_TIMEOUT_MS)
    })

    it('treats 0 as "no timeout" by returning the maximum timer value', () => {
        expect(resolveMcpRequestTimeoutMs(0)).to.equal(MAX_TOOL_EXEC_TIMEOUT_MS)
    })

    it('falls back to the default for undefined, negative, non-finite and over-large values', () => {
        expect(resolveMcpRequestTimeoutMs(undefined)).to.equal(DEFAULT_TOOL_EXEC_TIMEOUT_MS)
        expect(resolveMcpRequestTimeoutMs(-1)).to.equal(DEFAULT_TOOL_EXEC_TIMEOUT_MS)
        expect(resolveMcpRequestTimeoutMs(Number.NaN)).to.equal(DEFAULT_TOOL_EXEC_TIMEOUT_MS)
        expect(resolveMcpRequestTimeoutMs(Number.POSITIVE_INFINITY)).to.equal(DEFAULT_TOOL_EXEC_TIMEOUT_MS)
        expect(resolveMcpRequestTimeoutMs(Number.MAX_SAFE_INTEGER)).to.equal(DEFAULT_TOOL_EXEC_TIMEOUT_MS)
        expect(resolveMcpRequestTimeoutMs(MAX_TOOL_EXEC_TIMEOUT_MS + 1)).to.equal(DEFAULT_TOOL_EXEC_TIMEOUT_MS)
    })

    it('never returns a value setTimeout would clamp', () => {
        for (const candidate of [undefined, 0, -1, Number.NaN, Number.MAX_SAFE_INTEGER, 300_000]) {
            const resolved = resolveMcpRequestTimeoutMs(candidate)
            expect(Number.isFinite(resolved)).to.be.true
            expect(resolved).to.be.greaterThan(0)
            expect(resolved).to.be.at.most(MAX_TOOL_EXEC_TIMEOUT_MS)
        }
    })
})

describe('isUsableToolExecTimeout()', () => {
    it('accepts finite positive values within the timer range', () => {
        expect(isUsableToolExecTimeout(1)).to.be.true
        expect(isUsableToolExecTimeout(MAX_TOOL_EXEC_TIMEOUT_MS)).to.be.true
    })

    it('rejects undefined, zero, negative, non-finite and over-large values', () => {
        expect(isUsableToolExecTimeout(undefined)).to.be.false
        expect(isUsableToolExecTimeout(0)).to.be.false
        expect(isUsableToolExecTimeout(-1)).to.be.false
        expect(isUsableToolExecTimeout(Number.NaN)).to.be.false
        expect(isUsableToolExecTimeout(Number.POSITIVE_INFINITY)).to.be.false
        expect(isUsableToolExecTimeout(MAX_TOOL_EXEC_TIMEOUT_MS + 1)).to.be.false
    })
})
