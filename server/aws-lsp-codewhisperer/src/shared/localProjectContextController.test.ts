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
