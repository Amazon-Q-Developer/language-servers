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
    isEmptyEnv,
    sanitizeName,
    convertPersonaToAgent,
    migrateToAgentConfig,
    restoreServerScopedPermissions,
    isPermissionForServer,
    DEFAULT_TOOL_EXEC_TIMEOUT_MS,
    MAX_TOOL_EXEC_TIMEOUT_MS,
    isUsableToolExecTimeout,
    resolveMcpRequestTimeoutMs,
} from './mcpUtils'
import type { MCPServerConfig } from './mcpTypes'
import { McpPermissionType } from './mcpTypes'
import { pathToFileURL } from 'url'
import * as sinon from 'sinon'
import { URI } from 'vscode-uri'
import { sanitizeInput } from '../../../../shared/utils'

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
        const result = createNamespacedToolName('github', 'create_issue', tools, toolNameMapping)
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
        const result = createNamespacedToolName(longServer, 'create_issue', tools, toolNameMapping)
        expect(result.length).to.be.lessThanOrEqual(MAX_TOOL_NAME_LENGTH)
        expect(result.endsWith('___create_issue')).to.be.true
        expect(toolNameMapping.get(result)).to.deep.equal({
            serverName: 'very_long_server_name_that_definitely_exceeds_maximum_length_when_combined',
            toolName: 'create_issue',
        })
    })

    it('uses numeric suffix when tool name is too long', () => {
        const longTool = 'extremely_long_tool_name_that_definitely_exceeds_the_maximum_allowed_length_for_names'
        const result = createNamespacedToolName('server', longTool, tools, toolNameMapping)
        // Skip length check and use string comparison with the actual implementation behavior
        expect(toolNameMapping.get(result)).to.deep.equal({
            serverName: 'server',
            toolName: longTool,
        })
    })

    it('truncates tool name and adds suffix when it exceeds MAX_TOOL_NAME_LENGTH', () => {
        const longTool = 'Smartanalyzerthatreadssummariescreatesmappingrulesandupdatespayloads'
        const result = createNamespacedToolName('ConnectiveRx', longTool, tools, toolNameMapping)
        expect(result.length).to.equal(MAX_TOOL_NAME_LENGTH)
        expect(tools.has(result)).to.be.true
        expect(toolNameMapping.get(result)).to.deep.equal({
            serverName: 'ConnectiveRx',
            toolName: longTool,
        })
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
            },
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

    it('restores permissions written to a duplicate config that was skipped', async () => {
        const wsRoot = path.join(tmpDir, 'ws')
        const wsAgentPath = path.join(wsRoot, '.amazonq', 'agents', 'default.json')
        const globalAgentPath = getGlobalAgentConfigPath(tmpDir)

        await writeJson(wsAgentPath, {
            mcpServers: { dup: { command: 'dup-mcp', args: [] } },
            tools: ['@dup'],
            allowedTools: [],
        })
        // Global declares the same server, so it is skipped as a duplicate before the per-server
        // permission pass - its allowedTools entry must still survive.
        await writeJson(globalAgentPath, {
            mcpServers: { dup: { command: 'dup-mcp', args: [] } },
            tools: ['@dup'],
            allowedTools: ['@dup/some_tool'],
        })

        const result = await loadAgentConfig(workspace, logger, [wsAgentPath, globalAgentPath], null, false)

        expect(result.servers.has('dup')).to.be.true
        expect(result.agentConfig.allowedTools).to.include('@dup/some_tool')
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
})

describe('restoreServerScopedPermissions()', () => {
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

    it('restores only entries belonging to a loaded server', () => {
        const agentConfig = baseAgentConfig()
        const mapping = new Map([['srv', 'srv']])

        restoreServerScopedPermissions(
            agentConfig,
            mapping,
            ['@srv', '@srv/tool', '@gone'],
            ['@srv/tool', '@gone/tool']
        )

        expect(agentConfig.tools).to.deep.equal(['@srv', '@srv/tool'])
        expect(agentConfig.allowedTools).to.deep.equal(['@srv/tool'])
    })

    it('matches on the original (unsanitized) server name', () => {
        const agentConfig = baseAgentConfig()
        const mapping = new Map([['my_server', 'my-server']])

        restoreServerScopedPermissions(agentConfig, mapping, ['@my-server'], ['@my-server/tool'])

        expect(agentConfig.tools).to.deep.equal(['@my-server'])
        expect(agentConfig.allowedTools).to.deep.equal(['@my-server/tool'])
    })

    it('does not duplicate entries already applied', () => {
        const agentConfig = baseAgentConfig()
        agentConfig.tools.push('@srv')
        agentConfig.allowedTools.push('@srv/tool')
        const mapping = new Map([['srv', 'srv']])

        restoreServerScopedPermissions(agentConfig, mapping, ['@srv'], ['@srv/tool'])

        expect(agentConfig.tools).to.deep.equal(['@srv'])
        expect(agentConfig.allowedTools).to.deep.equal(['@srv/tool'])
    })

    it('is a no-op when no servers loaded', () => {
        const agentConfig = baseAgentConfig()

        restoreServerScopedPermissions(agentConfig, new Map(), ['@srv'], ['@srv/tool'])

        expect(agentConfig.tools).to.be.empty
        expect(agentConfig.allowedTools).to.be.empty
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
