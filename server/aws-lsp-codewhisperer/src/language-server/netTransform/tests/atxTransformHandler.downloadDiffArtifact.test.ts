import { expect } from 'chai'
import * as sinon from 'sinon'
import { ATXTransformHandler } from '../atxTransformHandler'
import { AtxTokenServiceManager } from '../../../shared/amazonQServiceManager/AtxTokenServiceManager'
import { Logging, Runtime, Workspace } from '@aws/language-server-runtimes/server-interface'
import { Utils } from '../utils'
import got from 'got'

describe('ATXTransformHandler - downloadDiffArtifact retry logic', () => {
    let handler: ATXTransformHandler
    let serviceManager: AtxTokenServiceManager
    let workspace: Workspace
    let logging: Logging
    let runtime: Runtime
    let createArtifactDownloadUrlStub: sinon.SinonStub
    let downloadAndExtractStub: sinon.SinonStub
    let applyChangesStub: sinon.SinonStub
    let saveAppliedCheckpointStub: sinon.SinonStub
    let saveLastAppliedTimestampStub: sinon.SinonStub
    let updateSourceFilesManifestStub: sinon.SinonStub

    beforeEach(() => {
        serviceManager = sinon.createStubInstance(AtxTokenServiceManager) as any
        workspace = {} as Workspace
        logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub() } as any
        runtime = {} as Runtime

        handler = new ATXTransformHandler(serviceManager, workspace, logging, runtime)

        createArtifactDownloadUrlStub = sinon.stub(handler as any, 'createArtifactDownloadUrl')
        downloadAndExtractStub = sinon.stub(Utils, 'downloadAndExtractArchive')
        applyChangesStub = sinon.stub(handler as any, 'applyChanges')
        saveAppliedCheckpointStub = sinon.stub(handler as any, 'saveAppliedCheckpoint')
        saveLastAppliedTimestampStub = sinon.stub(handler as any, 'saveLastAppliedTimestamp')
        updateSourceFilesManifestStub = sinon.stub(handler as any, 'updateSourceFilesManifest')
    })

    afterEach(() => {
        sinon.restore()
    })

    it('should succeed on first attempt when download and apply work', async () => {
        createArtifactDownloadUrlStub.resolves({
            s3PresignedUrl: 'https://s3.example.com/artifact.zip',
            requestHeaders: {},
        })
        downloadAndExtractStub.resolves()
        applyChangesStub.resolves({ success: true, addedFiles: ['file1.cs'] })

        const result = await (handler as any).downloadDiffArtifact(
            'ws-123',
            'job-456',
            'artifact-789',
            '/solution/root',
            'step-001'
        )

        expect(result.path).to.not.equal('')
        expect(result.outcome).to.equal('applied')
        expect(createArtifactDownloadUrlStub.calledOnce).to.be.true
        expect(applyChangesStub.calledOnce).to.be.true
        expect(saveAppliedCheckpointStub.calledOnce).to.be.true
    })

    it('should retry and succeed on second attempt', async () => {
        createArtifactDownloadUrlStub.onFirstCall().resolves(null)
        createArtifactDownloadUrlStub.onSecondCall().resolves({
            s3PresignedUrl: 'https://s3.example.com/artifact.zip',
            requestHeaders: {},
        })
        downloadAndExtractStub.resolves()
        applyChangesStub.resolves({ success: true, addedFiles: [] })

        const result = await (handler as any).downloadDiffArtifact(
            'ws-123',
            'job-456',
            'artifact-789',
            '/solution/root',
            'step-001'
        )

        expect(result.path).to.not.equal('')
        expect(result.outcome).to.equal('applied')
        expect(createArtifactDownloadUrlStub.calledTwice).to.be.true
        expect(applyChangesStub.calledOnce).to.be.true
    })

    it('should report a transfer failure, not an apply failure, when the download URL never comes', async () => {
        createArtifactDownloadUrlStub.resolves(null)

        const result = await (handler as any).downloadDiffArtifact(
            'ws-123',
            'job-456',
            'artifact-789',
            '/solution/root',
            'step-001'
        )

        expect(result.path).to.equal('')
        // The diff never arrived, so a caller that bounds its retries must not count this.
        expect(result.outcome).to.equal('transfer-failed')
        expect(createArtifactDownloadUrlStub.calledThrice).to.be.true
        expect(applyChangesStub.called).to.be.false
        expect(saveAppliedCheckpointStub.called).to.be.false
    })

    it('should retry when applyChanges fails', async () => {
        createArtifactDownloadUrlStub.resolves({
            s3PresignedUrl: 'https://s3.example.com/artifact.zip',
            requestHeaders: {},
        })
        downloadAndExtractStub.resolves()
        applyChangesStub.onFirstCall().resolves({ success: false, error: 'File locked' })
        applyChangesStub.onSecondCall().resolves({ success: true, addedFiles: [] })

        const result = await (handler as any).downloadDiffArtifact(
            'ws-123',
            'job-456',
            'artifact-789',
            '/solution/root',
            'step-001'
        )

        expect(result.path).to.not.equal('')
        expect(result.outcome).to.equal('applied')
        expect(applyChangesStub.calledTwice).to.be.true
        expect(saveAppliedCheckpointStub.calledOnce).to.be.true
    })

    it('does not retry a diff the apply refused, and says nothing was written', async () => {
        // The verdict comes from the diff's own contents, so each retry is another presigned URL
        // and another download against a throttling service, for the same answer.
        createArtifactDownloadUrlStub.resolves({
            s3PresignedUrl: 'https://s3.example.com/artifact.zip',
            requestHeaders: {},
        })
        downloadAndExtractStub.resolves()
        applyChangesStub.resolves({
            success: false,
            rejected: true,
            wroteNothing: true,
            error: 'it reaches outside the solution',
        })
        const told = sinon.stub(handler as any, 'tellCustomer').resolves(undefined)

        const result = await (handler as any).downloadDiffArtifact(
            'ws-123',
            'job-456',
            'artifact-789',
            '/solution/root',
            'step-001',
            true
        )

        expect(result.outcome).to.equal('rejected')
        expect(applyChangesStub.calledOnce).to.be.true
        expect(createArtifactDownloadUrlStub.calledOnce).to.be.true
        expect(saveAppliedCheckpointStub.called).to.be.false
        // The real reason, and no claim that files may have changed.
        const message = String(told.firstCall.args[3])
        expect(message).to.include('nothing in it was changed')
        expect(message).to.include('reaches outside the solution')
    })

    it('retries a refusal that depends on the tree, and reports it wrote nothing', async () => {
        // A wrong root is read off the customer's tree, so it can clear up: a .sln they moved for a
        // moment looks the same. It must stay retryable, but still say nothing was written.
        createArtifactDownloadUrlStub.resolves({
            s3PresignedUrl: 'https://s3.example.com/artifact.zip',
            requestHeaders: {},
        })
        downloadAndExtractStub.resolves()
        applyChangesStub.resolves({
            success: false,
            wroteNothing: true,
            error: 'it was computed against a different root',
        })

        const result = await (handler as any).downloadDiffArtifact(
            'ws-123',
            'job-456',
            'artifact-789',
            '/solution/root',
            'step-001',
            true
        )

        expect(result.outcome).to.equal('apply-refused')
        expect(saveAppliedCheckpointStub.called).to.be.false
    })

    it('should report an apply failure when applyChanges fails on all retries', async () => {
        createArtifactDownloadUrlStub.resolves({
            s3PresignedUrl: 'https://s3.example.com/artifact.zip',
            requestHeaders: {},
        })
        downloadAndExtractStub.resolves()
        applyChangesStub.resolves({ success: false, error: 'Permission denied' })

        const result = await (handler as any).downloadDiffArtifact(
            'ws-123',
            'job-456',
            'artifact-789',
            '/solution/root',
            'step-001'
        )

        expect(result.path).to.equal('')
        expect(result.outcome).to.equal('apply-failed')
        expect(applyChangesStub.calledThrice).to.be.true
        expect(saveAppliedCheckpointStub.called).to.be.false
    })

    it('should not save applied checkpoint when download fails', async () => {
        createArtifactDownloadUrlStub.resolves({
            s3PresignedUrl: 'https://s3.example.com/artifact.zip',
            requestHeaders: {},
        })
        downloadAndExtractStub.rejects(new Error('Network timeout'))

        const result = await (handler as any).downloadDiffArtifact(
            'ws-123',
            'job-456',
            'artifact-789',
            '/solution/root',
            'step-001'
        )

        expect(result.path).to.equal('')
        expect(result.outcome).to.equal('transfer-failed')
        expect(saveAppliedCheckpointStub.called).to.be.false
    })
})

describe('ATXTransformHandler - the HITL caller reads the outcome, not the path', () => {
    let handler: ATXTransformHandler
    let logging: Logging

    beforeEach(() => {
        logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub() } as any
        handler = new ATXTransformHandler(
            sinon.createStubInstance(AtxTokenServiceManager) as any,
            {} as Workspace,
            logging,
            {} as Runtime
        )
        sinon.stub(handler as any, 'createArtifactDownloadUrl').resolves({
            s3PresignedUrl: 'https://s3.example.com/hitl.json',
            requestHeaders: {},
        })
        sinon.stub(got, 'get').resolves({ body: JSON.stringify({ diffArtifactId: 'diff-1' }) } as any)
    })

    afterEach(() => sinon.restore())

    const callHitl = async () =>
        (handler as any).downloadAndParseStepHitlArtifact(
            'ws-1',
            'job-1',
            { taskId: 't-1', agentArtifact: { artifactId: 'agent-1' } },
            'step-001',
            '/solution/root'
        )

    it('calls a half-applied diff a failure even though it returns a path', async () => {
        // A diff that was extracted and then only partly applied returns the folder it was
        // extracted to, so an empty path no longer means failure.
        sinon
            .stub(handler as any, 'downloadDiffArtifact')
            .resolves({ path: '/solution/root/.atx/job-1/checkpoints/step-001', outcome: 'apply-failed' })

        const result = await callHitl()

        expect(result.DiffApplyFailed).to.be.true
    })

    it('calls an applied diff applied', async () => {
        sinon
            .stub(handler as any, 'downloadDiffArtifact')
            .resolves({ path: '/solution/root/.atx/job-1/checkpoints/step-001', outcome: 'applied' })

        const result = await callHitl()

        expect(result.DiffApplyFailed).to.be.false
    })
})

describe('ATXTransformHandler - DiffApplyFailed propagation', () => {
    let handler: ATXTransformHandler
    let serviceManager: AtxTokenServiceManager
    let workspace: Workspace
    let logging: Logging
    let runtime: Runtime

    beforeEach(() => {
        serviceManager = sinon.createStubInstance(AtxTokenServiceManager) as any
        workspace = {} as Workspace
        logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub() } as any
        runtime = {} as Runtime

        handler = new ATXTransformHandler(serviceManager, workspace, logging, runtime)
    })

    afterEach(() => {
        sinon.restore()
    })

    it('should set DiffApplyFailed on response when internal method signals failure', async () => {
        const mockResponse = {
            TransformationJob: { WorkspaceId: 'ws-123', JobId: 'job-456', Status: 'EXECUTING' },
            TransformationPlan: { Root: { Children: [] } },
        }

        sinon.stub(handler as any, '_getTransformInfoInternal').callsFake(async () => {
            // Simulate what happens when downloadCompletedStepArtifacts fails
            ;(handler as any)._currentDiffContext.failed = true
            ;(handler as any)._currentDiffContext.failedStepIds.push('step-001')
            return mockResponse
        })

        const result = await handler.getTransformInfo({
            TransformationJobId: 'job-456',
            WorkspaceId: 'ws-123',
            SolutionRootPath: '/root',
        } as any)

        expect(result).to.not.be.null
        expect(result!.DiffApplyFailed).to.be.true
        expect(result!.DiffApplyFailedStepIds).to.deep.equal(['step-001'])
    })

    it('should not set DiffApplyFailed when no failures occur', async () => {
        const mockResponse = {
            TransformationJob: { WorkspaceId: 'ws-123', JobId: 'job-456', Status: 'EXECUTING' },
            TransformationPlan: { Root: { Children: [] } },
        }

        sinon.stub(handler as any, '_getTransformInfoInternal').resolves(mockResponse)

        const result = await handler.getTransformInfo({
            TransformationJobId: 'job-456',
            WorkspaceId: 'ws-123',
            SolutionRootPath: '/root',
        } as any)

        expect(result).to.not.be.null
        expect(result!.DiffApplyFailed).to.be.undefined
    })

    it('should clear _currentDiffContext after call completes', async () => {
        sinon.stub(handler as any, '_getTransformInfoInternal').resolves(null)

        await handler.getTransformInfo({
            TransformationJobId: 'job-456',
            WorkspaceId: 'ws-123',
            SolutionRootPath: '/root',
        } as any)

        expect((handler as any)._currentDiffContext).to.be.null
    })
})

describe('ATXTransformHandler - EXECUTING HITL probe filtering', () => {
    let handler: ATXTransformHandler
    let serviceManager: AtxTokenServiceManager
    let workspace: Workspace
    let logging: Logging
    let runtime: Runtime
    let getJobStub: sinon.SinonStub
    let listHitlsStub: sinon.SinonStub
    let getTransformationPlanStub: sinon.SinonStub

    beforeEach(() => {
        serviceManager = sinon.createStubInstance(AtxTokenServiceManager) as any
        workspace = {} as Workspace
        logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub() } as any
        runtime = {} as Runtime

        handler = new ATXTransformHandler(serviceManager, workspace, logging, runtime)

        getJobStub = sinon.stub(handler as any, 'getJob')
        listHitlsStub = sinon.stub(handler as any, 'listHitls')
        getTransformationPlanStub = sinon.stub(handler as any, 'getTransformationPlan')
        sinon.stub(handler as any, 'listWorklogs').resolves()
    })

    afterEach(() => {
        sinon.restore()
    })

    it('should not override status when only checkpoint HITL is present', async () => {
        getJobStub.resolves({
            statusDetails: { status: 'EXECUTING' },
        })
        listHitlsStub.resolves([{ tag: 'job123-checkpoint', taskId: 'task-1' }])
        getTransformationPlanStub.resolves({ Root: { Children: [] } })

        const result = await handler.getTransformInfo({
            TransformationJobId: 'job-123',
            WorkspaceId: 'ws-123',
            SolutionRootPath: '/root',
        } as any)

        expect(result).to.not.be.null
        expect(result!.TransformationJob.Status).to.equal('EXECUTING')
    })

    it('should override status when a blocking HITL is present', async () => {
        getJobStub.resolves({
            statusDetails: { status: 'EXECUTING' },
        })
        listHitlsStub.resolves([
            { tag: 'job123-checkpoint', taskId: 'task-1' },
            { tag: 'local-build-verification', taskId: 'task-2' },
        ])
        getTransformationPlanStub.resolves({ Root: { Children: [] } })

        const result = await handler.getTransformInfo({
            TransformationJobId: 'job-123',
            WorkspaceId: 'ws-123',
            SolutionRootPath: '/root',
        } as any)

        expect(result).to.not.be.null
        expect(result!.TransformationJob.Status).to.equal('AWAITING_HUMAN_INPUT')
        expect(result!.HitlTag).to.equal('local-build-verification')
    })

    it('should override status for review HITLs', async () => {
        getJobStub.resolves({
            statusDetails: { status: 'EXECUTING' },
        })
        listHitlsStub.resolves([
            { tag: 'job123-checkpoint', taskId: 'task-1' },
            { tag: 'step001-review', taskId: 'task-2' },
        ])
        getTransformationPlanStub.resolves({ Root: { Children: [] } })

        const result = await handler.getTransformInfo({
            TransformationJobId: 'job-123',
            WorkspaceId: 'ws-123',
            SolutionRootPath: '/root',
        } as any)

        expect(result).to.not.be.null
        expect(result!.TransformationJob.Status).to.equal('AWAITING_HUMAN_INPUT')
        expect(result!.HitlTag).to.equal('step001-review')
    })

    it('should pass through EXECUTING status when no HITLs exist', async () => {
        getJobStub.resolves({
            statusDetails: { status: 'EXECUTING' },
        })
        listHitlsStub.resolves([])
        getTransformationPlanStub.resolves({ Root: { Children: [] } })

        const result = await handler.getTransformInfo({
            TransformationJobId: 'job-123',
            WorkspaceId: 'ws-123',
            SolutionRootPath: '/root',
        } as any)

        expect(result).to.not.be.null
        expect(result!.TransformationJob.Status).to.equal('EXECUTING')
    })

    it('should override status for missing-packages HITL', async () => {
        getJobStub.resolves({
            statusDetails: { status: 'EXECUTING' },
        })
        listHitlsStub.resolves([
            { tag: 'job123-checkpoint', taskId: 'task-1' },
            { tag: 'missing-packages', taskId: 'task-2' },
        ])
        getTransformationPlanStub.resolves({ Root: { Children: [] } })

        const result = await handler.getTransformInfo({
            TransformationJobId: 'job-123',
            WorkspaceId: 'ws-123',
            SolutionRootPath: '/root',
        } as any)

        expect(result).to.not.be.null
        expect(result!.TransformationJob.Status).to.equal('AWAITING_HUMAN_INPUT')
        expect(result!.HitlTag).to.equal('missing-packages')
    })
})

describe('ATXTransformHandler - EXECUTING HITL probe null handling', () => {
    let handler: ATXTransformHandler
    let serviceManager: AtxTokenServiceManager
    let workspace: Workspace
    let logging: Logging
    let runtime: Runtime
    let getJobStub: sinon.SinonStub
    let listHitlsStub: sinon.SinonStub
    let getTransformationPlanStub: sinon.SinonStub

    beforeEach(() => {
        serviceManager = sinon.createStubInstance(AtxTokenServiceManager) as any
        workspace = {} as Workspace
        logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub() } as any
        runtime = {} as Runtime

        handler = new ATXTransformHandler(serviceManager, workspace, logging, runtime)

        getJobStub = sinon.stub(handler as any, 'getJob')
        listHitlsStub = sinon.stub(handler as any, 'listHitls')
        getTransformationPlanStub = sinon.stub(handler as any, 'getTransformationPlan')
        sinon.stub(handler as any, 'listWorklogs').resolves()
    })

    afterEach(() => {
        sinon.restore()
    })

    it('should pass through EXECUTING status when listHitls returns null', async () => {
        getJobStub.resolves({
            statusDetails: { status: 'EXECUTING' },
        })
        listHitlsStub.resolves(null)
        getTransformationPlanStub.resolves({ Root: { Children: [] } })

        const result = await handler.getTransformInfo({
            TransformationJobId: 'job-123',
            WorkspaceId: 'ws-123',
            SolutionRootPath: '/root',
        } as any)

        expect(result).to.not.be.null
        expect(result!.TransformationJob.Status).to.equal('EXECUTING')
    })
})
