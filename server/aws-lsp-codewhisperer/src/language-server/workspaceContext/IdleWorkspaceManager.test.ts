import { IdleWorkspaceManager } from './IdleWorkspaceManager'
import { WorkspaceFolderManager } from './workspaceFolderManager'
import sinon, { stubInterface, StubbedInstance } from 'ts-sinon'
import { expect } from 'chai'

describe('IdleWorkspaceManager', () => {
    let clock: sinon.SinonFakeTimers
    let mockWorkspaceFolderManager: StubbedInstance<WorkspaceFolderManager>

    beforeEach(() => {
        clock = sinon.useFakeTimers()
        mockWorkspaceFolderManager = stubInterface<WorkspaceFolderManager>()
        sinon.stub(WorkspaceFolderManager, 'getInstance').returns(mockWorkspaceFolderManager)
        sinon.stub(console, 'error')
    })

    afterEach(() => {
        clock.restore()
        sinon.restore()
    })

    describe('isSessionIdle', () => {
        it('should return false when session is not idle', () => {
            IdleWorkspaceManager.recordActivityTimestamp()

            const result = IdleWorkspaceManager.isSessionIdle()

            expect(result).to.equal(false)
        })

        it('should return true when session exceeds idle threshold', () => {
            IdleWorkspaceManager.recordActivityTimestamp()
            clock.tick(31 * 60 * 1000) // 31 minutes

            const result = IdleWorkspaceManager.isSessionIdle()

            expect(result).to.equal(true)
        })
    })

    describe('recordActivityTimestamp', () => {
        it('should update activity timestamp', async () => {
            IdleWorkspaceManager.recordActivityTimestamp()

            expect(IdleWorkspaceManager.isSessionIdle()).to.equal(false)
        })

        it('should not trigger workspace check when session was not idle', async () => {
            mockWorkspaceFolderManager.isContinuousMonitoringStopped.returns(false)

            IdleWorkspaceManager.recordActivityTimestamp()

            sinon.assert.notCalled(mockWorkspaceFolderManager.checkRemoteWorkspaceStatusAndReact)
        })

        it('should trigger workspace check when session was idle and monitoring is active', async () => {
            // Make session idle first
            clock.tick(31 * 60 * 1000)
            mockWorkspaceFolderManager.isContinuousMonitoringStopped.returns(false)
            mockWorkspaceFolderManager.checkRemoteWorkspaceStatusAndReact.resolves()

            IdleWorkspaceManager.recordActivityTimestamp()

            sinon.assert.calledOnce(mockWorkspaceFolderManager.checkRemoteWorkspaceStatusAndReact)
        })

        it('should not trigger workspace check when session was idle but monitoring is stopped', async () => {
            clock.tick(31 * 60 * 1000)
            mockWorkspaceFolderManager.isContinuousMonitoringStopped.returns(true)

            IdleWorkspaceManager.recordActivityTimestamp()

            sinon.assert.notCalled(mockWorkspaceFolderManager.checkRemoteWorkspaceStatusAndReact)
        })
    })
})
