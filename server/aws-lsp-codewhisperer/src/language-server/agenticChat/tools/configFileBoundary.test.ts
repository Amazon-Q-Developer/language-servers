import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { URI } from 'vscode-uri'
import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { configFileWarning, isPathExactlyApproved, requiresPathAcceptance, resolveCanonicalPath } from './toolShared'
import { FsWrite } from './fsWrite'
import { FsReplace } from './fsReplace'
import { withCheckedFileOperations } from './checkedFileFixtures.test'
import { ChatSessionService } from '../../chat/chatSessionService'

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
        'AmazonQ.md',
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

    for (const relativePath of [
        'src/index.ts',
        'README.md',
        'docs/amazonq.md',
        'docs/AmazonQ.md',
        '.gitignore',
        '.github/ci.yml',
    ]) {
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

        it('requires acceptance to modify a file through a nested configuration folder that is a link', async function () {
            fs.mkdirSync(path.join(ws, 'pkg', 'git-data', 'hooks'), { recursive: true })
            if (!trySymlink(path.join(ws, 'pkg', 'git-data'), path.join(ws, 'pkg', '.git'))) {
                return this.skip()
            }

            const result = await checkWrite(path.join(ws, 'pkg', '.git', 'hooks', 'pre-commit'))

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

        it('requires acceptance to modify the folder that a link inside a configuration folder points to', async function () {
            fs.mkdirSync(path.join(ws, '.amazonq'))
            fs.mkdirSync(path.join(ws, 'docs', 'rules'), { recursive: true })
            if (!trySymlink(path.join(ws, 'docs', 'rules'), path.join(ws, '.amazonq', 'rules'))) {
                return this.skip()
            }

            const result = await checkWrite(path.join(ws, 'docs', 'rules', 'team.md'))

            assert.strictEqual(result.acceptanceReason, 'configFile')
        })

        it('requires acceptance to modify the file that a file link inside a configuration folder points to', async function () {
            fs.mkdirSync(path.join(ws, '.vscode'))
            fs.mkdirSync(path.join(ws, 'config'))
            fs.writeFileSync(path.join(ws, 'config', 'vscode.json'), '{}')
            try {
                fs.symlinkSync(
                    path.join(ws, 'config', 'vscode.json'),
                    path.join(ws, '.vscode', 'settings.json'),
                    'file'
                )
            } catch {
                return this.skip()
            }

            const linkedResult = await checkWrite(path.join(ws, 'config', 'vscode.json'))
            const otherResult = await checkWrite(path.join(ws, 'config', 'other.json'))

            assert.strictEqual(linkedResult.acceptanceReason, 'configFile')
            assert.strictEqual(otherResult.requiresAcceptance, false)
        })

        it('requires acceptance to modify the file that a link in the Git hooks folder points to', async function () {
            fs.mkdirSync(path.join(ws, '.git', 'hooks'), { recursive: true })
            fs.mkdirSync(path.join(ws, 'scripts'))
            fs.writeFileSync(path.join(ws, 'scripts', 'pre-commit'), 'synthetic fixture only')
            try {
                fs.symlinkSync(
                    path.join(ws, 'scripts', 'pre-commit'),
                    path.join(ws, '.git', 'hooks', 'pre-commit'),
                    'file'
                )
            } catch {
                return this.skip()
            }

            const result = await checkWrite(path.join(ws, 'scripts', 'pre-commit'))

            assert.strictEqual(result.acceptanceReason, 'configFile')
        })

        it('requires acceptance to modify the folder that a nested configuration folder link points to', async function () {
            fs.mkdirSync(path.join(ws, 'pkg', 'git-data', 'hooks'), { recursive: true })
            if (!trySymlink(path.join(ws, 'pkg', 'git-data'), path.join(ws, 'pkg', '.git'))) {
                return this.skip()
            }

            const result = await checkWrite(path.join(ws, 'pkg', 'git-data', 'hooks', 'pre-commit'))

            assert.strictEqual(result.acceptanceReason, 'configFile')
        })

        it('checks the requested name in a workspace opened through a link', async function () {
            // A link deeper in a configuration folder than the search for links goes
            const deepFolder = path.join(ws, '.amazonq', 'rules', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h')
            fs.mkdirSync(deepFolder, { recursive: true })
            fs.mkdirSync(path.join(ws, 'docs'))
            const openedAs = path.join(root, 'opened')
            if (!trySymlink(ws, openedAs) || !trySymlink(path.join(ws, 'docs'), path.join(deepFolder, 'link'))) {
                return this.skip()
            }
            const workspace = {
                getAllWorkspaceFolders: () => [{ uri: URI.file(openedAs).toString(), name: 'ws' }],
                fs: withCheckedFileOperations({} as Features['workspace']['fs']),
            } as unknown as Features['workspace']
            const requestedPath = path.join(openedAs, path.relative(ws, deepFolder), 'link', 'team.md')

            const result = await requiresPathAcceptance(requestedPath, 'fsWrite', workspace, noopLogging, undefined, {
                flagConfigFiles: true,
            })

            assert.deepStrictEqual(result.canonicalPaths, [path.join(ws, 'docs', 'team.md')])
            assert.strictEqual(result.acceptanceReason, 'configFile')
        })

        it('does not flag a file in the workspace that a link outside it with a configuration folder name points to', async function () {
            const outsideConfig = path.join(root, 'outside', '.vscode')
            fs.mkdirSync(outsideConfig, { recursive: true })
            fs.mkdirSync(path.join(ws, 'src'))
            fs.writeFileSync(path.join(ws, 'src', 'a.ts'), 'synthetic fixture only')
            try {
                fs.symlinkSync(path.join(ws, 'src', 'a.ts'), path.join(outsideConfig, 'link.ts'), 'file')
            } catch {
                return this.skip()
            }

            const result = await checkWrite(path.join(outsideConfig, 'link.ts'))

            assert.strictEqual(result.requiresAcceptance, false)
        })
    })

    describe('Git directories that a .git file names', () => {
        it('requires acceptance to modify the Git directory that the top-level .git file names', async () => {
            fs.mkdirSync(path.join(ws, 'gitstuff', 'hooks'), { recursive: true })
            fs.writeFileSync(path.join(ws, '.git'), 'gitdir: ./gitstuff\n')

            const result = await checkWrite(path.join(ws, 'gitstuff', 'hooks', 'pre-commit'))

            assert.strictEqual(result.acceptanceReason, 'configFile')
        })

        it('requires acceptance to modify the Git directory that a nested .git file names', async () => {
            fs.mkdirSync(path.join(ws, 'pkg', 'gitdata'), { recursive: true })
            fs.writeFileSync(path.join(ws, 'pkg', '.git'), 'gitdir: gitdata\n')

            const result = await checkWrite(path.join(ws, 'pkg', 'gitdata', 'config'))

            assert.strictEqual(result.acceptanceReason, 'configFile')
        })

        it('does not flag other files next to a .git file', async () => {
            fs.mkdirSync(path.join(ws, 'gitstuff'))
            fs.writeFileSync(path.join(ws, '.git'), 'gitdir: ./gitstuff\n')

            const result = await checkWrite(path.join(ws, 'src', 'index.ts'))

            assert.strictEqual(result.requiresAcceptance, false)
        })

        // A folder laid out like a Git directory
        const makeGitDirectory = (dir: string) => {
            fs.mkdirSync(path.join(dir, 'objects'), { recursive: true })
            fs.mkdirSync(path.join(dir, 'refs'))
            fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n')
        }

        it('requires acceptance to modify a Git directory next to the folder whose .git file names it', async () => {
            makeGitDirectory(path.join(ws, 'pkg-git'))
            fs.mkdirSync(path.join(ws, 'pkg'))
            fs.writeFileSync(path.join(ws, 'pkg', '.git'), 'gitdir: ../pkg-git\n')

            const configResult = await checkWrite(path.join(ws, 'pkg-git', 'config'))
            const hookResult = await checkWrite(path.join(ws, 'pkg-git', 'hooks', 'pre-commit'))

            assert.strictEqual(configResult.acceptanceReason, 'configFile')
            assert.strictEqual(hookResult.acceptanceReason, 'configFile')
        })

        it('requires acceptance to modify a bare repository', async () => {
            makeGitDirectory(path.join(ws, 'proj.git'))

            const result = await checkWrite(path.join(ws, 'proj.git', 'hooks', 'pre-commit'))

            assert.strictEqual(result.acceptanceReason, 'configFile')
        })

        it('does not flag a folder that only looks partly like a Git directory', async () => {
            fs.mkdirSync(path.join(ws, 'notes', 'refs'), { recursive: true })
            fs.writeFileSync(path.join(ws, 'notes', 'HEAD'), 'synthetic fixture only')

            const result = await checkWrite(path.join(ws, 'notes', 'todo.md'))

            assert.strictEqual(result.requiresAcceptance, false)
        })
    })

    describe('links deeper in configuration folders', () => {
        const trySymlink = (target: string, linkPath: string, type: 'file' | 'dir'): boolean => {
            try {
                fs.symlinkSync(target, linkPath, type)
                return true
            } catch {
                return false
            }
        }

        it('requires acceptance to modify the folder that a link two levels into .amazonq points to', async function () {
            fs.mkdirSync(path.join(ws, '.amazonq', 'rules', 'team'), { recursive: true })
            fs.mkdirSync(path.join(ws, 'docs', 'shared'), { recursive: true })
            if (
                !trySymlink(
                    path.join(ws, 'docs', 'shared'),
                    path.join(ws, '.amazonq', 'rules', 'team', 'shared'),
                    'dir'
                )
            ) {
                return this.skip()
            }

            const result = await checkWrite(path.join(ws, 'docs', 'shared', 'team.md'))

            assert.strictEqual(result.acceptanceReason, 'configFile')
        })

        it('requires acceptance to modify the file that a submodule hook link points to', async function () {
            fs.mkdirSync(path.join(ws, '.git', 'modules', 'sub', 'hooks'), { recursive: true })
            fs.mkdirSync(path.join(ws, 'scripts'))
            fs.writeFileSync(path.join(ws, 'scripts', 'pre-commit'), 'synthetic fixture only')
            const hook = path.join(ws, '.git', 'modules', 'sub', 'hooks', 'pre-commit')
            if (!trySymlink(path.join(ws, 'scripts', 'pre-commit'), hook, 'file')) {
                return this.skip()
            }

            const result = await checkWrite(path.join(ws, 'scripts', 'pre-commit'))

            assert.strictEqual(result.acceptanceReason, 'configFile')
        })

        it('does not search the Git object folders for links', async function () {
            fs.mkdirSync(path.join(ws, '.git', 'objects'), { recursive: true })
            fs.mkdirSync(path.join(ws, 'scripts'))
            if (!trySymlink(path.join(ws, 'scripts'), path.join(ws, '.git', 'objects', 'linked'), 'dir')) {
                return this.skip()
            }

            const result = await checkWrite(path.join(ws, 'scripts', 'build.sh'))

            assert.strictEqual(result.requiresAcceptance, false)
        })

        it('finds a link at the top of a configuration folder whatever else the folder holds', async function () {
            const agents = path.join(ws, '.amazonq', 'agents')
            fs.mkdirSync(agents, { recursive: true })
            for (let i = 0; i < 2100; i++) {
                fs.writeFileSync(path.join(agents, `agent-${i}.json`), '{}')
            }
            fs.mkdirSync(path.join(ws, 'tools'))
            fs.writeFileSync(path.join(ws, 'tools', 'mcp.json'), '{}')
            if (!trySymlink(path.join(ws, 'tools', 'mcp.json'), path.join(ws, '.amazonq', 'mcp.json'), 'file')) {
                return this.skip()
            }

            const result = await checkWrite(path.join(ws, 'tools', 'mcp.json'))

            assert.strictEqual(result.acceptanceReason, 'configFile')
        })
    })

    it('shows the shared-file warning too for a configuration file with another name on disk', async function () {
        const filePath = path.join(ws, '.amazonq', 'mcp.json')
        fs.mkdirSync(path.dirname(filePath))
        fs.writeFileSync(path.join(root, 'other.json'), '{}')
        try {
            fs.linkSync(path.join(root, 'other.json'), filePath)
        } catch {
            return this.skip()
        }

        const features = { workspace: makeWorkspace(ws), logging: noopLogging } as unknown as Features
        const result = await new FsWrite(features).requiresAcceptance({
            command: 'create',
            path: filePath,
            fileText: '{}',
        })

        assert.strictEqual(result.acceptanceReason, 'configFile')
        assert.ok(result.warning?.startsWith(configFileWarning), result.warning)
        assert.ok(result.warning?.includes('another name on disk'), result.warning)
    })

    describe('relative and home folder paths', () => {
        const homeVariables = ['HOME', 'USERPROFILE'] as const
        let savedHome: Partial<Record<(typeof homeVariables)[number], string>>

        beforeEach(() => {
            savedHome = Object.fromEntries(homeVariables.map(name => [name, process.env[name]]))
            fs.mkdirSync(path.join(root, 'home'))
            for (const name of homeVariables) {
                process.env[name] = path.join(root, 'home')
            }
        })

        afterEach(() => {
            for (const name of homeVariables) {
                if (savedHome[name] === undefined) {
                    delete process.env[name]
                } else {
                    process.env[name] = savedHome[name]
                }
            }
        })

        it('treats a home folder path outside the workspace as outside the workspace', async () => {
            const result = await checkWrite('~/.vscode/settings.json')

            assert.deepStrictEqual(result.canonicalPaths, [
                path.join(fs.realpathSync.native(path.join(root, 'home')), '.vscode', 'settings.json'),
            ])
            assert.strictEqual(result.requiresAcceptance, true)
            assert.strictEqual(result.acceptanceReason, undefined)
        })

        it('resolves a relative path the way the tools do, not against the workspace', async () => {
            const result = await checkWrite(path.join('.amazonq', 'mcp.json'))

            assert.deepStrictEqual(result.canonicalPaths, [
                await resolveCanonicalPath(path.join('.amazonq', 'mcp.json')),
            ])
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
        const rulesResult = await check(path.join(second, 'AmazonQ.md'))
        const sourceResult = await check(path.join(second, 'src', 'index.ts'))

        assert.strictEqual(configResult.acceptanceReason, 'configFile')
        assert.strictEqual(rulesResult.acceptanceReason, 'configFile')
        assert.strictEqual(sourceResult.requiresAcceptance, false)
    })

    it('requires acceptance to modify the file that the root AmazonQ.md links to', async function () {
        fs.mkdirSync(path.join(ws, 'docs'))
        fs.writeFileSync(path.join(ws, 'docs', 'rules.md'), 'synthetic fixture only')
        try {
            fs.symlinkSync(path.join(ws, 'docs', 'rules.md'), path.join(ws, 'AmazonQ.md'), 'file')
        } catch {
            return this.skip()
        }

        const result = await checkWrite(path.join(ws, 'docs', 'rules.md'))

        assert.strictEqual(result.requiresAcceptance, true)
        assert.strictEqual(result.acceptanceReason, 'configFile')
    })

    describe('global Amazon Q configuration', () => {
        const homeVariables = ['HOME', 'USERPROFILE'] as const
        let savedHome: Partial<Record<(typeof homeVariables)[number], string>>

        beforeEach(() => {
            savedHome = Object.fromEntries(homeVariables.map(name => [name, process.env[name]]))
            // The workspace is the home folder
            for (const name of homeVariables) {
                process.env[name] = ws
            }
        })

        afterEach(() => {
            for (const name of homeVariables) {
                if (savedHome[name] === undefined) {
                    delete process.env[name]
                } else {
                    process.env[name] = savedHome[name]
                }
            }
        })

        for (const relativePath of ['.aws/amazonq/mcp.json', '.aws/amazonq/agents/default.json']) {
            it(`requires acceptance to modify ${relativePath} when the workspace includes it`, async () => {
                const result = await checkWrite(path.join(ws, ...relativePath.split('/')))

                assert.strictEqual(result.requiresAcceptance, true)
                assert.strictEqual(result.acceptanceReason, 'configFile')
            })
        }

        it('does not flag other files in the home folder workspace', async () => {
            const result = await checkWrite(path.join(ws, 'projects', 'notes.md'))

            assert.strictEqual(result.requiresAcceptance, false)
        })

        it('requires acceptance to modify the files that links inside the global configuration point to', async function () {
            fs.mkdirSync(path.join(ws, '.aws', 'amazonq'), { recursive: true })
            fs.mkdirSync(path.join(ws, 'dotfiles', 'amazonq'), { recursive: true })
            fs.writeFileSync(path.join(ws, 'dotfiles', 'amazonq', 'mcp.json'), '{}')
            try {
                fs.symlinkSync(
                    path.join(ws, 'dotfiles', 'amazonq', 'mcp.json'),
                    path.join(ws, '.aws', 'amazonq', 'mcp.json'),
                    'file'
                )
            } catch {
                return this.skip()
            }

            const result = await checkWrite(path.join(ws, 'dotfiles', 'amazonq', 'mcp.json'))

            assert.strictEqual(result.acceptanceReason, 'configFile')
        })

        it('requires acceptance to modify the folder that the global configuration links to', async function () {
            fs.mkdirSync(path.join(ws, '.aws'))
            fs.mkdirSync(path.join(ws, 'dotfiles', 'amazonq', 'agents'), { recursive: true })
            try {
                fs.symlinkSync(path.join(ws, 'dotfiles', 'amazonq'), path.join(ws, '.aws', 'amazonq'), 'dir')
            } catch {
                return this.skip()
            }

            const result = await checkWrite(path.join(ws, 'dotfiles', 'amazonq', 'agents', 'default.json'))

            assert.strictEqual(result.acceptanceReason, 'configFile')
        })
    })

    it('does not require acceptance for a configuration file whose exact path is approved', async () => {
        const filePath = path.join(ws, '.amazonq', 'mcp.json')

        const result = await checkWrite(filePath, new Map([['fsWrite', new Set([filePath])]]))

        assert.strictEqual(result.requiresAcceptance, false)
    })

    it('does not require acceptance for a configuration file approved in the form the session records', async () => {
        const filePath = path.join(ws, '.amazonq', 'mcp.json')
        const session = new ChatSessionService()
        session.addApprovedPath(filePath, 'fsWrite')

        const result = await checkWrite(filePath, session.approvedPaths)

        assert.strictEqual(result.requiresAcceptance, false)
    })

    it('matches an exact approval regardless of path separators', () => {
        const approvedPaths = new Map([['fsWrite', new Set(['C:/ws/.amazonq/mcp.json'])]])

        assert.strictEqual(isPathExactlyApproved('C:\\ws\\.amazonq\\mcp.json', 'fsWrite', approvedPaths), true)
        assert.strictEqual(isPathExactlyApproved('C:\\ws\\.amazonq\\other.json', 'fsWrite', approvedPaths), false)
    })

    it('requires acceptance for a configuration file when only its folder is approved', async () => {
        const result = await checkWrite(
            path.join(ws, '.amazonq', 'mcp.json'),
            new Map([['fsWrite', new Set([path.join(ws, '.amazonq')])]])
        )

        assert.strictEqual(result.requiresAcceptance, true)
        assert.strictEqual(result.acceptanceReason, 'configFile')
    })

    it('requires acceptance for a configuration file when the workspace root is approved', async () => {
        const result = await checkWrite(path.join(ws, '.amazonq', 'mcp.json'), new Map([['fsWrite', new Set([ws])]]))

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
