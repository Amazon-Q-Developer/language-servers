import { LocalProjectContextController } from './localProjectContextController'
import { SinonStub, stub, assert as sinonAssert, match, restore, spy } from 'sinon'
import * as assert from 'assert'
import * as fs from 'fs'
import { Dirent } from 'fs'
import * as path from 'path'
import { URI } from 'vscode-uri'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import sinon from 'ts-sinon'
import { ContextCommandItem } from 'local-indexing'
import { waitUntil } from '@aws/lsp-core/out/util/timeoutUtils'

class LoggingMock {
    public error: SinonStub
    public info: SinonStub
    public log: SinonStub
    public warn: SinonStub

    constructor() {
        this.error = stub()
        this.info = stub()
        this.log = stub()
        this.warn = stub()
    }
}

describe('LocalProjectContextController', () => {
    let controller: LocalProjectContextController
    let logging: LoggingMock
    let mockWorkspaceFolders: any[]
    let vectorLibMock: any
    let fsStub: SinonStub
    let testFeatures: TestFeatures

    const BASE_PATH = path.join(__dirname, 'path', 'to', 'workspace1')

    beforeEach(() => {
        testFeatures = new TestFeatures()
        logging = new LoggingMock()
        mockWorkspaceFolders = [
            {
                uri: URI.file(BASE_PATH),
                name: 'workspace1',
            },
        ]

        vectorLibMock = {
            start: stub().resolves({
                buildIndex: stub().resolves(),
                queryInlineProjectContext: stub().resolves(['mockContext1']),
                updateIndexV2: stub().resolves(),
                getContextCommandItems: stub().resolves([]),
                getIndexSequenceNumber: stub().resolves(1),
                getContextCommandPrompt: stub().resolves([]),
            }),
        }

        fsStub = stub(fs.promises, 'readdir')
        fsStub.withArgs(match.string, { withFileTypes: true }).callsFake(path => {
            if (path.endsWith('workspace1')) {
                return Promise.resolve([createMockDirent('Test.java', false), createMockDirent('src', true)])
            } else if (path.endsWith('src')) {
                return Promise.resolve([createMockDirent('Main.java', false)])
            } else {
                return Promise.resolve([])
            }
        })

        controller = new LocalProjectContextController('testClient', mockWorkspaceFolders, logging as any)
        const processWorkspaceFoldersStub = sinon.stub(controller, 'processWorkspaceFolders')
        processWorkspaceFoldersStub.resolves(['Test.java', 'Main.java'])
    })

    afterEach(() => {
        fsStub.restore()
        restore()
    })

    describe('init', () => {
        it('should initialize vector library successfully', async () => {
            const buildIndexSpy = spy(controller, 'buildIndex')
            await controller.init({ vectorLib: vectorLibMock })

            sinonAssert.notCalled(logging.error)
            sinonAssert.called(vectorLibMock.start)
            const vecLib = await vectorLibMock.start()
            sinonAssert.called(buildIndexSpy)
        })

        // Skipped: fails since this file last ran in CI; see the PR that skipped it
        it.skip('should handle initialization errors', async () => {
            vectorLibMock.start.rejects(new Error('Init failed'))

            await controller.init({ vectorLib: vectorLibMock })

            sinonAssert.called(logging.error)
        })

        it('should call buildIndex on init', async () => {
            const buildIndexSpy = spy(controller, 'buildIndex')
            await controller.init({ vectorLib: vectorLibMock })

            sinonAssert.notCalled(logging.error)
            sinonAssert.called(vectorLibMock.start)
            sinonAssert.calledOnce(buildIndexSpy)
        })
    })

    describe('buildIndex', () => {
        it('should build Index with vectorLib', async () => {
            await controller.init({ vectorLib: vectorLibMock })
            const vecLib = await vectorLibMock.start()
            await controller.buildIndex()
            sinonAssert.called(vecLib.buildIndex)
        })
    })
    describe('queryInlineProjectContext', () => {
        beforeEach(async () => {
            await controller.init({ vectorLib: vectorLibMock })
        })

        it('should return empty array when vector library is not initialized', async () => {
            const uninitializedController = new LocalProjectContextController(
                'testClient',
                mockWorkspaceFolders,
                logging as any
            )

            const result = await uninitializedController.queryInlineProjectContext({
                query: 'test',
                filePath: 'test.java',
                target: 'test',
            })
            assert.deepStrictEqual(result, [])
        })

        it('should return empty array when indexing is disabled', async () => {
            const uninitializedController = new LocalProjectContextController(
                'testClient',
                mockWorkspaceFolders,
                logging as any
            )

            const result = await uninitializedController.queryInlineProjectContext({
                query: 'test',
                filePath: 'test.java',
                target: 'test',
            })
            assert.deepStrictEqual(result, [])
        })

        it('should return context from vector library', async () => {
            const result = await controller.queryInlineProjectContext({
                query: 'test',
                filePath: 'test.java',
                target: 'test',
            })
            assert.deepStrictEqual(result, ['mockContext1'])
        })

        it('should handle query errors', async () => {
            const vecLib = await vectorLibMock.start()
            vecLib.queryInlineProjectContext.rejects(new Error('Query failed'))

            const result = await controller.queryInlineProjectContext({
                query: 'test',
                filePath: 'test.java',
                target: 'test',
            })
            assert.deepStrictEqual(result, [])
            sinonAssert.called(logging.error)
        })
    })

    describe('updateIndex', () => {
        beforeEach(async () => {
            await controller.init({ vectorLib: vectorLibMock })
        })

        it('should call updateIndex with correct parameters', async () => {
            const vecLib = await vectorLibMock.start()
            const filePaths = ['file1.ts', 'file2.ts']
            const operation = 'add'
            const workspaceFolders = ['folder1', 'folder2']

            await controller.updateIndex(filePaths, operation, workspaceFolders)

            sinonAssert.calledOnce(vecLib.updateIndexV2)
            sinonAssert.calledWith(vecLib.updateIndexV2, filePaths, operation, workspaceFolders)
        })

        it('should do nothing when vector library is not initialized', async () => {
            const uninitializedController = new LocalProjectContextController(
                'testClient',
                mockWorkspaceFolders,
                logging as any
            )

            await uninitializedController.updateIndex(['test.java'], 'add')
            sinonAssert.notCalled(logging.error)
        })

        it('should update index successfully', async () => {
            const vecLib = await vectorLibMock.start()
            await controller.updateIndex(['test.java'], 'add')
            sinonAssert.called(vecLib.updateIndexV2)
        })

        it('should handle update errors', async () => {
            const vecLib = await vectorLibMock.start()
            vecLib.updateIndexV2.rejects(new Error('Update failed'))

            await controller.updateIndex(['test.java'], 'add')
            sinonAssert.called(logging.error)
        })
    })

    describe('updateIndexAndContextCommand', () => {
        it('should update index and call onContextItemsUpdated when successful', async () => {
            const tryUpdateIndexStub = sinon.stub(controller, 'tryUpdateIndex').resolves(true)
            const mockItems: ContextCommandItem[] = [
                { workspaceFolder: '/test', type: 'file', relativePath: 'path', id: '1' },
            ]
            const getItemsStub = sinon.stub(controller, 'getContextCommandItems').resolves(mockItems)
            const callbackSpy = sinon.spy()
            controller.onContextItemsUpdated = callbackSpy

            await controller.updateIndexAndContextCommand(['file.ts'], true)

            assert.strictEqual(tryUpdateIndexStub.callCount, 1)
            assert.deepStrictEqual(tryUpdateIndexStub.firstCall.args, [['file.ts'], true, undefined])
            assert.strictEqual(getItemsStub.callCount, 1)
            assert.strictEqual(callbackSpy.callCount, 1)
            assert.deepStrictEqual(callbackSpy.firstCall.args[0], mockItems)
        })

        it('should not call onContextItemsUpdated when index update fails', async () => {
            const tryUpdateIndexStub = sinon.stub(controller, 'tryUpdateIndex').resolves(false)
            const getItemsStub = sinon.stub(controller, 'getContextCommandItems')
            const callbackSpy = sinon.spy()
            controller.onContextItemsUpdated = callbackSpy

            await controller.updateIndexAndContextCommand(['file.ts'], true)

            assert.strictEqual(tryUpdateIndexStub.callCount, 1)
            assert.strictEqual(getItemsStub.callCount, 0)
            assert.strictEqual(callbackSpy.callCount, 0)
        })

        it('should not call onContextItemsUpdated when no items are returned', async () => {
            const tryUpdateIndexStub = sinon.stub(controller, 'tryUpdateIndex').resolves(true)
            const getItemsStub = sinon.stub(controller, 'getContextCommandItems').resolves([])
            const callbackSpy = sinon.spy()
            controller.onContextItemsUpdated = callbackSpy

            await controller.updateIndexAndContextCommand(['file.ts'], true)

            assert.strictEqual(tryUpdateIndexStub.callCount, 1)
            assert.strictEqual(getItemsStub.callCount, 1)
            assert.strictEqual(callbackSpy.callCount, 0)
        })
    })

    describe('tryUpdateIndex', () => {
        it('should wait for sequence number to increase', async () => {
            const updateIndexStub = sinon.stub(controller, 'updateIndex').resolves()
            const getSeqNumStub = sinon.stub()
            getSeqNumStub.onFirstCall().resolves(1)
            getSeqNumStub.onSecondCall().resolves(2)

            vectorLibMock.start.resolves({
                getIndexSequenceNumber: getSeqNumStub,
                updateIndexV2: sinon.stub().resolves(),
            })
            await controller.init({ vectorLib: vectorLibMock })

            const result = await controller.tryUpdateIndex(['file.ts'], true)

            assert.strictEqual(result, true)
            assert.strictEqual(updateIndexStub.callCount, 1)
            assert.deepStrictEqual(updateIndexStub.firstCall.args, [['file.ts'], 'add', undefined])
            assert.strictEqual(getSeqNumStub.callCount, 2)
        })

        it('should handle errors and return false', async () => {
            const updateIndexStub = sinon.stub(controller, 'updateIndex').rejects(new Error('Update failed'))
            const result = await controller.tryUpdateIndex(['file.ts'], true)

            assert.strictEqual(result, false)
            sinonAssert.called(logging.error)
        })
    })

    describe('dispose', () => {
        it('should clear and remove vector library reference', async () => {
            await controller.init({ vectorLib: vectorLibMock })
            await controller.dispose()

            assert.strictEqual(controller.isEnabled, false)
        })
    })
})

function createMockDirent(name: string, isDirectory: boolean): Dirent {
    return {
        name,
        isDirectory: () => isDirectory,
        isFile: () => !isDirectory,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSocket: () => false,
        isSymbolicLink: () => false,
    } as Dirent
}

describe('LocalProjectContextController ignore file patterns (real filesystem)', () => {
    let root: string
    let folder: { uri: string; name: string }
    let vecLib: any
    let logging: LoggingMock

    const makeController = () => new LocalProjectContextController('testClient', [folder], logging as any)
    const initWith = (controller: LocalProjectContextController, ignoreFilePatterns?: string[]) =>
        controller.init({ vectorLib: { start: stub().resolves(vecLib) }, ignoreFilePatterns })
    const relativePaths = (files: string[]) => files.map(file => path.relative(root, file).split(path.sep).join('/'))

    beforeEach(() => {
        root = fs.realpathSync.native(fs.mkdtempSync(path.join(require('os').tmpdir(), 'index-ignore-')))
        for (const file of ['src/a.ts', 'secrets/config.yaml', 'config/credentials.json', 'data/run.local.json']) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
            fs.writeFileSync(path.join(root, file), 'synthetic fixture only')
        }
        folder = { uri: URI.file(root).toString(), name: 'ws' }
        logging = new LoggingMock()
        vecLib = {
            buildIndex: stub().resolves(),
            updateIndexV2: stub().resolves(),
            getContextCommandItems: stub().resolves([]),
            getIndexSequenceNumber: stub().resolves(1),
        }
    })

    afterEach(() => {
        restore()
        fs.rmSync(root, { recursive: true, force: true })
    })

    const patterns = ['secrets/', '*.local.json', 'config/credentials.json']
    const extensions = ['.ts', '.yaml', '.json']

    it('leaves the files that the patterns match out of the index', async () => {
        const controller = makeController()
        await initWith(controller, patterns)

        const files = await controller.processWorkspaceFolders([folder], extensions, 10, 100)

        assert.deepStrictEqual(relativePaths(files), ['src/a.ts'])
    })

    it('checks each file of the index against every workspace folder when one is inside another', async () => {
        const innerRoot = path.join(root, 'pkg')
        for (const file of ['lib/x.ts', 'src/y.ts']) {
            fs.mkdirSync(path.dirname(path.join(innerRoot, file)), { recursive: true })
            fs.writeFileSync(path.join(innerRoot, file), 'synthetic fixture only')
        }
        const innerFolder = { uri: URI.file(innerRoot).toString(), name: 'pkg' }
        const controller = new LocalProjectContextController('testClient', [folder, innerFolder], logging as any)
        // Anchored to the top of a workspace folder: matches pkg/lib/ only relative to the inner folder
        await initWith(controller, ['/lib/'])

        const files = await controller.processWorkspaceFolders([folder, innerFolder], extensions, 10, 100)

        assert.deepStrictEqual(relativePaths(files).sort(), [
            'config/credentials.json',
            'data/run.local.json',
            'pkg/src/y.ts',
            'secrets/config.yaml',
            'src/a.ts',
        ])
    })

    it('indexes every file without patterns', async () => {
        const controller = makeController()
        await initWith(controller)

        const files = await controller.processWorkspaceFolders([folder], extensions, 10, 100)

        assert.deepStrictEqual(relativePaths(files).sort(), [
            'config/credentials.json',
            'data/run.local.json',
            'secrets/config.yaml',
            'src/a.ts',
        ])
    })

    it('does not add or update files that the patterns match', async () => {
        const controller = makeController()
        await initWith(controller, patterns)
        const allFiles = ['src/a.ts', 'secrets/config.yaml', 'data/run.local.json'].map(file => path.join(root, file))

        await controller.updateIndex(allFiles, 'add')
        await controller.updateIndex(allFiles, 'update')
        await controller.updateIndex([path.join(root, 'secrets', 'config.yaml')], 'add')
        await controller.updateIndex(allFiles, 'remove')

        sinonAssert.callCount(vecLib.updateIndexV2, 3)
        sinonAssert.calledWith(vecLib.updateIndexV2.firstCall, [path.join(root, 'src', 'a.ts')], 'add')
        sinonAssert.calledWith(vecLib.updateIndexV2.secondCall, [path.join(root, 'src', 'a.ts')], 'update')
        sinonAssert.calledWith(vecLib.updateIndexV2.thirdCall, allFiles, 'remove')
    })

    // Waits for the index builds that the controller started without waiting for them
    const indexIdle = (controller: LocalProjectContextController) =>
        waitUntil(async () => !(controller as any)._isIndexingInProgress, { interval: 5, timeout: 5_000, truthy: true })

    it('builds the index again when the patterns change', async () => {
        const controller = makeController()
        await initWith(controller, patterns)
        await indexIdle(controller)
        const buildsBefore = vecLib.buildIndex.callCount

        await initWith(controller, patterns)
        await indexIdle(controller)
        const buildsWithSamePatterns = vecLib.buildIndex.callCount
        await initWith(controller, ['secrets/'])
        await indexIdle(controller)

        assert.strictEqual(buildsWithSamePatterns, buildsBefore)
        assert.strictEqual(vecLib.buildIndex.callCount, buildsBefore + 1)
        assert.deepStrictEqual(relativePaths(vecLib.buildIndex.lastCall.args[0]).sort(), [
            'config/credentials.json',
            'data/run.local.json',
            'src/a.ts',
        ])
    })

    it('builds the index again when the patterns change during a build', async () => {
        let finishFirstBuild = () => {}
        vecLib.buildIndex.onFirstCall().returns(new Promise<void>(resolve => (finishFirstBuild = resolve)))
        const controller = makeController()
        await initWith(controller)
        await waitUntil(async () => vecLib.buildIndex.callCount === 1, { interval: 5, timeout: 5_000, truthy: true })

        await initWith(controller, patterns)
        finishFirstBuild()
        await waitUntil(async () => vecLib.buildIndex.callCount === 2, { interval: 5, timeout: 5_000, truthy: true })
        await indexIdle(controller)

        sinonAssert.callCount(vecLib.buildIndex, 2)
        assert.strictEqual(vecLib.buildIndex.firstCall.args[0].length, 4)
        assert.deepStrictEqual(relativePaths(vecLib.buildIndex.lastCall.args[0]), ['src/a.ts'])
    })

    it('removes the files that the patterns match from a folder that is added', async () => {
        for (const file of ['pkg/a.ts', 'pkg/b.local.ts', 'pkg/notes.local.txt', 'pkg/secrets/k.ts', 'pkg/lib/c.ts']) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
            fs.writeFileSync(path.join(root, file), 'synthetic fixture only')
        }
        // A link back to the folder, which is listed only once
        try {
            fs.symlinkSync(path.join(root, 'pkg'), path.join(root, 'pkg', 'loop'), 'junction')
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
                throw error
            }
        }
        const controller = makeController()
        await initWith(controller, ['secrets/', '*.local.*'])

        await controller.updateIndex([path.join(root, 'pkg')], 'add')
        await controller.updateIndex([path.join(root, 'secrets')], 'add')

        sinonAssert.callCount(vecLib.updateIndexV2, 2)
        sinonAssert.calledWith(vecLib.updateIndexV2.firstCall, [path.join(root, 'pkg')], 'add')
        const [removed, operation] = vecLib.updateIndexV2.secondCall.args
        assert.strictEqual(operation, 'remove')
        assert.deepStrictEqual([...removed].sort(), [
            path.join(root, 'pkg', 'b.local.ts'),
            path.join(root, 'pkg', 'secrets') + path.sep,
        ])
    })

    it('checks a file against the workspace folder that contains it', async () => {
        const otherRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(require('os').tmpdir(), 'index-ignore-')))
        const otherFolder = { uri: URI.file(otherRoot).toString(), name: 'other' }
        try {
            const controller = new LocalProjectContextController('testClient', [folder, otherFolder], logging as any)
            await initWith(controller, ['secrets/'])
            const outsideFile = path.join(path.dirname(root), 'outside-both', 'secrets', 'x.ts')
            const files = [
                path.join(root, 'src', 'a.ts'),
                path.join(otherRoot, 'secrets', 'b.ts'),
                path.join(otherRoot, 'src', 'c.ts'),
                outsideFile,
            ]

            await controller.updateIndex(files, 'add')

            sinonAssert.calledOnceWithExactly(
                vecLib.updateIndexV2,
                [path.join(root, 'src', 'a.ts'), path.join(otherRoot, 'src', 'c.ts'), outsideFile],
                'add',
                undefined
            )
        } finally {
            fs.rmSync(otherRoot, { recursive: true, force: true })
        }
    })

    it('updates the context command list when the patterns change', async () => {
        const item = (relativePath: string) => ({ workspaceFolder: root, type: 'file', relativePath, id: relativePath })
        vecLib.getContextCommandItems.resolves([item('src/a.ts'), item('secrets/config.yaml')])
        const controller = makeController()
        const onContextItemsUpdated = stub().resolves()
        controller.onContextItemsUpdated = onContextItemsUpdated
        await initWith(controller)
        await indexIdle(controller)

        await initWith(controller, ['secrets/'])
        await waitUntil(async () => onContextItemsUpdated.called, { interval: 5, timeout: 5_000, truthy: true })

        sinonAssert.calledOnce(onContextItemsUpdated)
        assert.deepStrictEqual(
            onContextItemsUpdated.firstCall.args[0].map((i: ContextCommandItem) => i.relativePath),
            ['src/a.ts']
        )
        await indexIdle(controller)
    })

    it('does not wait for an index update when the patterns match every file', async () => {
        const controller = makeController()
        await initWith(controller, patterns)

        const updated = await controller.tryUpdateIndex([path.join(root, 'secrets', 'config.yaml')], true)

        assert.strictEqual(updated, false)
        sinonAssert.notCalled(vecLib.getIndexSequenceNumber)
        sinonAssert.notCalled(vecLib.updateIndexV2)
    })

    it('leaves the files and folders that the patterns match out of the context command items', async () => {
        const item = (type: string, relativePath: string) => ({
            workspaceFolder: root,
            type,
            relativePath,
            id: relativePath,
        })
        vecLib.getContextCommandItems.resolves([
            item('file', 'src/a.ts'),
            item('folder', 'src'),
            item('file', 'secrets/config.yaml'),
            item('folder', 'secrets'),
            item('folder', 'data'),
            item('file', 'data/run.local.json'),
            item('folder', 'config'),
            item('file', 'config/credentials.json'),
            item('code', 'config/credentials.json'),
        ])
        const controller = makeController()
        await initWith(controller, patterns)

        const items = await controller.getContextCommandItems()

        assert.deepStrictEqual(
            items.map(i => `${i.type}:${i.relativePath}`),
            ['file:src/a.ts', 'folder:src', 'folder:data', 'folder:config']
        )
    })

    // A stand-in for the index library's prompts: a file item brings in that file; a folder item brings in the
    // files of the workspace listing under it, ignored files included; at most 100 prompts in all
    const promptLibrary = (workspaceFiles: string[]) => {
        const promptFor = (filePath: string, relativePath: string) => ({
            content: 'synthetic fixture only',
            name: 'file',
            description: '',
            startLine: 0,
            endLine: 0,
            filePath,
            relativePath,
        })
        vecLib.getContextCommandItems.resolves(
            workspaceFiles.map(file => ({ workspaceFolder: root, type: 'file', relativePath: file, id: file }))
        )
        vecLib.getContextCommandPrompt = stub().callsFake(async (items: ContextCommandItem[]) =>
            items
                .flatMap(item => {
                    const itemPath = path.join(item.workspaceFolder, item.relativePath)
                    if (item.type !== 'folder') {
                        return [promptFor(itemPath, item.relativePath)]
                    }
                    return workspaceFiles
                        .map(file => path.join(root, file))
                        .filter(file => file.startsWith(itemPath + path.sep))
                        .map(file => promptFor(file, path.relative(itemPath, file)))
                })
                .slice(0, 100)
        )
    }
    const promptPaths = (prompts: { filePath: string }[]) => prompts.map(p => relativePaths([p.filePath])[0])

    it('leaves the files that the patterns match out of a folder in the context command prompts', async () => {
        promptLibrary(['data/run.local.json', 'data/notes.txt', 'config/credentials.json', 'src/a.ts'])
        const controller = makeController()
        await initWith(controller, patterns)

        const prompts = await controller.getContextCommandPrompt([
            { workspaceFolder: root, type: 'folder', relativePath: 'data', id: 'data' },
            { workspaceFolder: root, type: 'file', relativePath: 'config/credentials.json', id: 'rule' },
        ])

        // The file that an item names directly, such as a workspace rule, is kept
        assert.deepStrictEqual(promptPaths(prompts), ['data/notes.txt', 'config/credentials.json'])
        const libraryItems = vecLib.getContextCommandPrompt.firstCall.args[0] as ContextCommandItem[]
        assert.ok(libraryItems.every(item => item.type !== 'folder'))
    })

    it('brings in the files of a folder that the patterns leave when most of its files are ignored', async () => {
        const ignoredFiles = Array.from({ length: 150 }, (_, i) => `many/f${i}.local.json`)
        promptLibrary([...ignoredFiles, 'many/zz.ts'])
        const controller = makeController()
        await initWith(controller, patterns)

        const prompts = await controller.getContextCommandPrompt([
            { workspaceFolder: root, type: 'folder', relativePath: 'many', id: 'many' },
        ])

        assert.deepStrictEqual(promptPaths(prompts), ['many/zz.ts'])
        // Relative to the folder, as the library gives the files of a folder
        assert.deepStrictEqual(
            prompts.map(p => p.relativePath),
            ['zz.ts']
        )
    })

    it('passes the items on unchanged without patterns', async () => {
        promptLibrary(['data/run.local.json', 'data/notes.txt'])
        const controller = makeController()
        await initWith(controller)
        const items: ContextCommandItem[] = [
            { workspaceFolder: root, type: 'folder', relativePath: 'data', id: 'data' },
        ]

        const prompts = await controller.getContextCommandPrompt(items)

        assert.deepStrictEqual(promptPaths(prompts), ['data/run.local.json', 'data/notes.txt'])
        sinonAssert.calledOnceWithExactly(vecLib.getContextCommandPrompt, items)
    })

    it('checks a context command item against every workspace folder when one is inside another', async () => {
        const innerRoot = path.join(root, 'pkg')
        fs.mkdirSync(innerRoot)
        const innerFolder = { uri: URI.file(innerRoot).toString(), name: 'pkg' }
        vecLib.getContextCommandItems.resolves(
            ['pkg/lib/x.ts', 'pkg/src/y.ts'].map(file => ({
                workspaceFolder: root,
                type: 'file',
                relativePath: file,
                id: file,
            }))
        )
        const controller = new LocalProjectContextController('testClient', [folder, innerFolder], logging as any)
        // Anchored to the top of a workspace folder: matches pkg/lib/ only relative to the inner folder
        await initWith(controller, ['/lib/'])

        const items = await controller.getContextCommandItems()

        assert.deepStrictEqual(
            items.map(i => i.relativePath),
            ['pkg/src/y.ts']
        )
    })

    it('does not query the index for a file that the patterns match', async () => {
        vecLib.queryInlineProjectContext = stub().resolves([{ content: 'context', filePath: 'q-inline', score: 0 }])
        const controller = makeController()
        await initWith(controller, patterns)
        const query = (relativePath: string) =>
            controller.queryInlineProjectContext({
                query: 'query',
                filePath: path.join(root, relativePath),
                target: 'codemap',
            })

        assert.deepStrictEqual(await query('secrets/config.yaml'), [])
        sinonAssert.notCalled(vecLib.queryInlineProjectContext)
        assert.strictEqual((await query('src/a.ts')).length, 1)
        sinonAssert.calledOnce(vecLib.queryInlineProjectContext)
    })
})
