import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { URI } from 'vscode-uri'
import { Logging, Workspace, WorkspaceFolder } from '@aws/language-server-runtimes/server-interface'
import { ArtifactManager } from './artifactManager'
import { resolvePathInside } from './util'
import { JSTSDependencyHandler, isPackageName } from './dependency/dependencyHandler/JSTSDependencyHandler'
import { PythonDependencyHandler } from './dependency/dependencyHandler/PythonDependencyHandler'
import { JavaDependencyHandler } from './dependency/dependencyHandler/JavaDependencyHandler'
import { Dependency } from './dependency/dependencyHandler/LanguageDependencyHandler'

/**
 * Real-filesystem tests for which files dependency discovery and zipping may pick up. Symlink tests
 * skip themselves where the platform or user cannot create links (e.g. Windows without the privilege).
 */
describe('dependency upload paths', () => {
    const logging = {
        log: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
    } as unknown as Logging

    let root: string
    let ws: string
    let outside: string
    let workspaceFolder: WorkspaceFolder

    function linkOrSkip(ctx: Mocha.Context, target: string, linkPath: string, type: 'file' | 'dir'): void {
        try {
            fs.symlinkSync(target, linkPath, type === 'dir' ? 'junction' : 'file')
        } catch {
            ctx.skip()
        }
    }

    function write(filePath: string, content = 'x'): void {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, content)
    }

    function newHandler<T>(Handler: new (...args: any[]) => T, language: string, artifactManager?: ArtifactManager): T {
        return new Handler(language, {} as Workspace, logging, [workspaceFolder], artifactManager ?? {}, 'deps', {
            isDisposed: false,
            dependencyUploadedSizeSum: 0,
        })
    }

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dep-paths-')))
        ws = path.join(root, 'ws')
        outside = path.join(root, 'outside')
        fs.mkdirSync(ws)
        write(path.join(outside, 'secret.js'), 'secret')
        workspaceFolder = { uri: URI.file(ws).toString(), name: 'ws' }
    })

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true })
    })

    describe('resolvePathInside', () => {
        it('returns the real path of a file inside the root', () => {
            write(path.join(ws, 'a.js'))
            assert.strictEqual(resolvePathInside(path.join(ws, 'a.js'), ws), path.join(ws, 'a.js'))
        })

        it('rejects the root itself, a missing path and a ../ path', () => {
            assert.strictEqual(resolvePathInside(ws, ws), undefined)
            assert.strictEqual(resolvePathInside(path.join(ws, 'missing.js'), ws), undefined)
            assert.strictEqual(resolvePathInside(path.join(ws, '..', 'outside', 'secret.js'), ws), undefined)
        })

        it('rejects a link that resolves outside the root', function () {
            linkOrSkip(this, path.join(outside, 'secret.js'), path.join(ws, 'link.js'), 'file')
            assert.strictEqual(resolvePathInside(path.join(ws, 'link.js'), ws), undefined)
        })

        it('accepts a link that resolves inside the root', function () {
            write(path.join(ws, 'real', 'a.js'))
            linkOrSkip(this, path.join(ws, 'real'), path.join(ws, 'alias'), 'dir')
            assert.strictEqual(resolvePathInside(path.join(ws, 'alias', 'a.js'), ws), path.join(ws, 'real', 'a.js'))
        })
    })

    describe('isPackageName', () => {
        it('accepts plain and scoped names', () => {
            for (const name of ['lodash', '@aws/lsp-core', 'a.b-c_d']) {
                assert.ok(isPackageName(name), name)
            }
        })

        it('rejects names that would reach another directory', () => {
            for (const name of ['..', '.', '../x', '@scope/..', 'a/b', '@scope/a/b', '/etc', 'a\\..\\b', 'C:x', '']) {
                assert.ok(!isPackageName(name), name)
            }
        })
    })

    describe('JSTSDependencyHandler', () => {
        function jstsMap(dependencies: Record<string, string>): Map<string, Dependency> {
            write(path.join(ws, 'package.json'), JSON.stringify({ dependencies }))
            fs.mkdirSync(path.join(ws, 'node_modules'), { recursive: true })
            const handler = newHandler(JSTSDependencyHandler, 'javascript')
            assert.ok(handler.discover(ws, workspaceFolder))
            return handler.generateDependencyMap({
                pkgDir: ws,
                packageJsonPath: path.join(ws, 'package.json'),
                nodeModulesPath: path.join(ws, 'node_modules'),
                workspaceFolder,
            })
        }

        it('keeps a package installed in node_modules', () => {
            write(path.join(ws, 'node_modules', 'good', 'package.json'), '{"version":"1.0.0"}')
            assert.deepStrictEqual([...jstsMap({ good: '^1.0.0' }).keys()], ['good'])
        })

        it('skips a declared name that walks out of node_modules', () => {
            write(path.join(outside, 'package.json'), '{}')
            assert.strictEqual(jstsMap({ '../../outside': '1.0.0' }).size, 0)
        })

        it('skips a declared or unlisted package linked outside the workspace folder', function () {
            write(path.join(outside, 'package.json'), '{"version":"1.0.0"}')
            fs.mkdirSync(path.join(ws, 'node_modules'), { recursive: true })
            linkOrSkip(this, outside, path.join(ws, 'node_modules', 'declared'), 'dir')
            linkOrSkip(this, outside, path.join(ws, 'node_modules', 'unlisted'), 'dir')
            assert.strictEqual(jstsMap({ declared: '1.0.0' }).size, 0)
        })

        it('keeps a package linked to another folder in the same workspace', function () {
            write(path.join(ws, 'packages', 'shared', 'package.json'), '{"version":"2.0.0"}')
            fs.mkdirSync(path.join(ws, 'node_modules'), { recursive: true })
            linkOrSkip(this, path.join(ws, 'packages', 'shared'), path.join(ws, 'node_modules', 'shared'), 'dir')
            assert.deepStrictEqual([...jstsMap({ shared: '2.0.0' }).keys()], ['shared'])
        })
    })

    describe('PythonDependencyHandler', () => {
        // isDirectory() parses the path as a URI, which drops the drive letter of a Windows path
        before(function () {
            if (process.platform === 'win32') {
                this.skip()
            }
        })

        it('skips a site-packages entry linked outside site-packages', function () {
            const sitePackages = path.join(ws, '.venv', 'lib', 'site-packages')
            write(path.join(sitePackages, 'requests', '__init__.py'))
            linkOrSkip(this, outside, path.join(sitePackages, 'evil'), 'dir')
            const handler = newHandler(PythonDependencyHandler, 'python')
            const map = new Map<string, Dependency>()

            handler.transformPathToDependency('requests', path.join(sitePackages, 'requests'), map)
            handler.transformPathToDependency('evil', path.join(sitePackages, 'evil'), map)

            assert.deepStrictEqual([...map.keys()], ['requests'])
        })
    })

    describe('JavaDependencyHandler', () => {
        it('skips a .jar name that links to a file that is not a jar', function () {
            write(path.join(ws, 'lib', 'real-1.0.jar'))
            linkOrSkip(this, path.join(outside, 'secret.js'), path.join(ws, 'lib', 'fake-1.0.jar'), 'file')
            const handler = newHandler(JavaDependencyHandler, 'java')
            const map = new Map<string, Dependency>()

            handler.transformPathToDependency('real-1.0.jar', path.join(ws, 'lib', 'real-1.0.jar'), map)
            handler.transformPathToDependency('fake-1.0.jar', path.join(ws, 'lib', 'fake-1.0.jar'), map)

            assert.deepStrictEqual([...map.keys()], ['real'])
        })
    })

    describe('ArtifactManager.getFileMetadata', () => {
        // isDirectory() parses the path as a URI, which drops the drive letter of a Windows path
        before(function () {
            if (process.platform === 'win32') {
                this.skip()
            }
        })

        it('zips files inside a dependency directory but not links that leave it', async function () {
            const dependencyDir = path.join(ws, 'node_modules', 'pkg')
            write(path.join(dependencyDir, 'index.js'))
            linkOrSkip(this, path.join(outside, 'secret.js'), path.join(dependencyDir, 'file-link.js'), 'file')
            linkOrSkip(this, outside, path.join(dependencyDir, 'dir-link'), 'dir')
            const artifactManager = new ArtifactManager({} as Workspace, logging, [workspaceFolder])

            const files = await artifactManager.getFileMetadata(workspaceFolder, dependencyDir, 'javascript', 'pkg')

            assert.deepStrictEqual(
                files.map(f => f.relativePath),
                [path.join('pkg', 'index.js')]
            )
        })

        it('zips a dependency directory that is itself a link, such as a pnpm or workspace package', async function () {
            write(path.join(ws, 'packages', 'shared', 'index.js'))
            fs.mkdirSync(path.join(ws, 'node_modules'), { recursive: true })
            const link = path.join(ws, 'node_modules', 'shared')
            linkOrSkip(this, path.join(ws, 'packages', 'shared'), link, 'dir')
            const artifactManager = new ArtifactManager({} as Workspace, logging, [workspaceFolder])

            const files = await artifactManager.getFileMetadata(workspaceFolder, link, 'javascript', 'shared')

            assert.deepStrictEqual(
                files.map(f => f.relativePath),
                [path.join('shared', 'index.js')]
            )
        })
    })
})
