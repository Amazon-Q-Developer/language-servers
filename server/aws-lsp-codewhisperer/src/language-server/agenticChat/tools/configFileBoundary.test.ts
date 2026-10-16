import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { URI } from 'vscode-uri'
import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { configFileWarning, requiresPathAcceptance } from './toolShared'
import { FsWrite } from './fsWrite'
import { FsReplace } from './fsReplace'
import { withCheckedFileOperations } from './checkedFileFixtures.test'

/**
 * Real-filesystem tests for configuration files inside the workspace.
 */
describe('workspace configuration files', () => {
    let root: string
    let ws: string

    const noopLogging = {
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
        debug: () => {},
    } as unknown as Features['logging']

    const makeWorkspace = (folder: string): Features['workspace'] =>
        ({
            getAllWorkspaceFolders: () => [{ uri: URI.file(folder).toString(), name: 'ws' }],
            fs: withCheckedFileOperations({} as Features['workspace']['fs']),
        }) as unknown as Features['workspace']

    const checkWrite = (filePath: string, approvedPaths?: Map<string, Set<string>>) =>
        requiresPathAcceptance(filePath, 'fsWrite', makeWorkspace(ws), noopLogging, approvedPaths, {
            flagConfigFiles: true,
        })

    beforeEach(async () => {
        const realTmp = fs.realpathSync(os.tmpdir())
        root = fs.mkdtempSync(path.join(realTmp, 'cfb-'))
        ws = path.join(root, 'workspace')
        fs.mkdirSync(ws)
        ws = await fs.promises.realpath(ws)
    })

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true })
    })

    for (const relativePath of [
        '.amazonq/agents/default.json',
        '.amazonq/mcp.json',
        '.amazonq/rules/team.md',
        '.AmazonQ/mcp.json',
        '.vscode/tasks.json',
        '.git/config',
        'packages/app/.git/config',
    ]) {
        it(`requires acceptance to modify ${relativePath}`, async () => {
            const filePath = path.join(ws, ...relativePath.split('/'))

            const result = await checkWrite(filePath)

            assert.strictEqual(result.requiresAcceptance, true)
            assert.strictEqual(result.acceptanceReason, 'configFile')
            assert.strictEqual(result.warning, configFileWarning)
            assert.deepStrictEqual(result.canonicalPaths, [filePath])
        })
    }

    for (const relativePath of ['src/index.ts', 'README.md', 'docs/amazonq.md', '.gitignore', '.github/ci.yml']) {
        it(`does not require acceptance to modify ${relativePath}`, async () => {
            const result = await checkWrite(path.join(ws, ...relativePath.split('/')))

            assert.strictEqual(result.requiresAcceptance, false)
        })
    }

    describe('linked configuration folders', () => {
        const trySymlink = (target: string, linkPath: string): boolean => {
            try {
                fs.symlinkSync(target, linkPath, 'dir')
                return true
            } catch {
                return false
            }
        }

        it('requires acceptance to modify a file through a configuration folder linked to another workspace folder', async function () {
            fs.mkdirSync(path.join(ws, 'config'))
            if (!trySymlink(path.join(ws, 'config'), path.join(ws, '.amazonq'))) {
                return this.skip()
            }

            const result = await checkWrite(path.join(ws, '.amazonq', 'mcp.json'))

            assert.strictEqual(result.requiresAcceptance, true)
            assert.strictEqual(result.acceptanceReason, 'configFile')
        })

        it('requires acceptance to modify the folder that a configuration folder links to', async function () {
            fs.mkdirSync(path.join(ws, 'config'))
            if (!trySymlink(path.join(ws, 'config'), path.join(ws, '.amazonq'))) {
                return this.skip()
            }

            const result = await checkWrite(path.join(ws, 'config', 'mcp.json'))

            assert.strictEqual(result.requiresAcceptance, true)
            assert.strictEqual(result.acceptanceReason, 'configFile')
        })

        it('treats a configuration folder linked outside the workspace as outside the workspace', async function () {
            const outside = path.join(root, 'outside')
            fs.mkdirSync(outside)
            if (!trySymlink(outside, path.join(ws, '.amazonq'))) {
                return this.skip()
            }

            const result = await checkWrite(path.join(ws, '.amazonq', 'mcp.json'))

            assert.strictEqual(result.requiresAcceptance, true)
            assert.strictEqual(result.acceptanceReason, undefined)
        })
    })

    it('checks each folder of a multi-root workspace', async () => {
        const second = path.join(root, 'second')
        fs.mkdirSync(second)
        const workspace = {
            getAllWorkspaceFolders: () => [
                { uri: URI.file(ws).toString(), name: 'ws' },
                { uri: URI.file(second).toString(), name: 'second' },
            ],
            fs: withCheckedFileOperations({} as Features['workspace']['fs']),
        } as unknown as Features['workspace']
        const check = (filePath: string) =>
            requiresPathAcceptance(filePath, 'fsWrite', workspace, noopLogging, undefined, { flagConfigFiles: true })

        const configResult = await check(path.join(second, '.vscode', 'settings.json'))
        const sourceResult = await check(path.join(second, 'src', 'index.ts'))

        assert.strictEqual(configResult.acceptanceReason, 'configFile')
        assert.strictEqual(sourceResult.requiresAcceptance, false)
    })

    it('does not require acceptance for a configuration file whose exact path is approved', async () => {
        const filePath = path.join(ws, '.amazonq', 'mcp.json')

        const result = await checkWrite(filePath, new Map([['fsWrite', new Set([filePath])]]))

        assert.strictEqual(result.requiresAcceptance, false)
    })

    it('requires acceptance for a configuration file when only its folder is approved', async () => {
        const result = await checkWrite(
            path.join(ws, '.amazonq', 'mcp.json'),
            new Map([['fsWrite', new Set([path.join(ws, '.amazonq')])]])
        )

        assert.strictEqual(result.requiresAcceptance, true)
        assert.strictEqual(result.acceptanceReason, 'configFile')
    })

    it('does not flag configuration files when the option is not set', async () => {
        const result = await requiresPathAcceptance(
            path.join(ws, '.amazonq', 'mcp.json'),
            'fsRead',
            makeWorkspace(ws),
            noopLogging
        )

        assert.strictEqual(result.requiresAcceptance, false)
    })

    it('flags configuration files for fsWrite and fsReplace', async () => {
        const features = { workspace: makeWorkspace(ws), logging: noopLogging } as unknown as Features
        const filePath = path.join(ws, '.amazonq', 'mcp.json')

        const writeResult = await new FsWrite(features).requiresAcceptance({
            command: 'create',
            path: filePath,
            fileText: '{}',
        })
        const replaceResult = await new FsReplace(features).requiresAcceptance({
            path: filePath,
            diffs: [{ oldStr: '{}', newStr: '{ }' }],
        })

        assert.strictEqual(writeResult.acceptanceReason, 'configFile')
        assert.strictEqual(replaceResult.acceptanceReason, 'configFile')
    })
})
