import { ChokidarFileWatcher } from './chokidarFileWatcher'
import { Logging } from '@aws/language-server-runtimes/server-interface'
import * as mcpUtils from './mcpUtils'
import { stub, SinonStub } from 'sinon'
import { expect } from 'chai'

describe('ChokidarFileWatcher', () => {
    let fileWatcher: ChokidarFileWatcher
    let mockLogger: Logging
    let mockWatcher: any
    let watchStub: SinonStub
    let normalizePathStub: SinonStub

    beforeEach(() => {
        mockLogger = {
            info: stub() as any,
            warn: stub() as any,
        } as any

        mockWatcher = {
            on: stub() as any,
            close: stub().resolves() as any,
        }

        watchStub = stub(require('chokidar'), 'watch').returns(mockWatcher)
        normalizePathStub = stub(mcpUtils, 'normalizePathFromUri').callsFake(path => path)

        fileWatcher = new ChokidarFileWatcher(mockLogger)
    })

    afterEach(() => {
        watchStub.restore()
        normalizePathStub.restore()
    })

    describe('watchPaths', () => {
        it('should create watcher with correct paths and options', () => {
            const paths = ['/path1', '/path2']
            const callback = stub()

            fileWatcher.watchPaths(paths, callback)

            expect(watchStub.calledOnce).to.be.true
            expect(watchStub.firstCall.args[0]).to.deep.equal(paths)
            expect(watchStub.firstCall.args[1]).to.deep.equal({
                ignoreInitial: true,
                persistent: true,
                awaitWriteFinish: {
                    stabilityThreshold: 300,
                    pollInterval: 100,
                },
            })
        })

        it('reports removed files only when asked to', () => {
            const callback = stub()
            fileWatcher.watchPaths(['/path'], callback)
            expect((mockWatcher.on as any).calledWith('unlink')).to.be.false

            fileWatcher.watchPaths(['/path'], callback, { includeUnlink: true })
            const unlink = (mockWatcher.on as any).getCalls().find((c: any) => c.args[0] === 'unlink')
            unlink.args[1]('/path')
            expect(callback.calledWith('/path')).to.be.true
        })

        it('should register event handlers', () => {
            const callback = stub()
            fileWatcher.watchPaths(['/path'], callback)

            expect((mockWatcher.on as any).calledWith('add')).to.be.true
            expect((mockWatcher.on as any).calledWith('change')).to.be.true
            expect((mockWatcher.on as any).calledWith('error')).to.be.true
        })

        it('should call callback on file add', () => {
            const callback = stub()
            fileWatcher.watchPaths(['/path'], callback)

            const addCall = mockWatcher.on.getCalls().find((call: any) => call.args[0] === 'add')
            const addHandler = addCall?.args[1]
            addHandler('/test/path')

            expect((callback as any).calledWith('/test/path')).to.be.true
            expect((mockLogger.info as any).calledWith('MCP config file created: /test/path')).to.be.true
        })

        it('should call callback on file change', () => {
            const callback = stub()
            fileWatcher.watchPaths(['/path'], callback)

            const changeCall = mockWatcher.on.getCalls().find((call: any) => call.args[0] === 'change')
            const changeHandler = changeCall?.args[1]
            changeHandler('/test/path')

            expect((callback as any).calledWith('/test/path')).to.be.true
            expect((mockLogger.info as any).calledWith('MCP config file changed: /test/path')).to.be.true
        })

        it('should handle errors', () => {
            const callback = stub()
            fileWatcher.watchPaths(['/path'], callback)

            const errorCall = mockWatcher.on.getCalls().find((call: any) => call.args[0] === 'error')
            const errorHandler = errorCall?.args[1]
            const error = new Error('test error')
            errorHandler(error)

            expect((mockLogger.warn as any).calledWith('File watcher error: test error')).to.be.true
        })

        it('should close existing watcher before creating new one', () => {
            const callback = stub()
            fileWatcher.watchPaths(['/path1'], callback)
            fileWatcher.watchPaths(['/path2'], callback)

            expect((mockWatcher.close as any).calledOnce).to.be.true
        })
    })

    describe('close', () => {
        it('should close watcher and reset to null', () => {
            fileWatcher.watchPaths(['/path'], stub())
            fileWatcher.close()

            expect((mockWatcher.close as any).calledOnce).to.be.true
            expect((mockLogger.info as any).calledWith('Closed chokidar file watcher')).to.be.true
        })

        it('should do nothing if no watcher exists', () => {
            fileWatcher.close()

            expect((mockWatcher.close as any).called).to.be.false
        })
    })
})
