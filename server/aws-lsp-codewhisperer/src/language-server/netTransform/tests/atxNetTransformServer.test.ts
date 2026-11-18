import { expect } from 'chai'
import * as sinon from 'sinon'
import { AtxNetTransformServerToken } from '../atxNetTransformServer'
import { ATXTransformHandler } from '../atxTransformHandler'
import { AtxTransformHandlerLegacy } from '../atxTransformHandlerLegacy'
import { AtxTokenServiceManager } from '../../../shared/amazonQServiceManager/AtxTokenServiceManager'

const AtxStartTransformCommand = 'aws/atxTransform/startTransform'
const AtxGetTransformInfoCommand = 'aws/atxTransform/getTransformInfo'
const AtxUploadPlanCommand = 'aws/atxTransform/uploadPlan'

describe('AtxNetTransformServer - routing', () => {
    let executeCommandHandler: any
    let onInitializedFn: any
    let logging: any

    let newStartTransform: sinon.SinonStub
    let legacyStartTransform: sinon.SinonStub
    let newGetTransformInfo: sinon.SinonStub
    let legacyGetTransformInfo: sinon.SinonStub
    let newUploadPlan: sinon.SinonStub
    let legacyUploadPlan: sinon.SinonStub

    beforeEach(() => {
        // Stub the singleton getInstance with a minimal fake satisfying handler ctors
        const fakeServiceManager: any = {
            registerCacheCallback: sinon.stub(),
            getActiveApplicationUrl: sinon.stub().returns('https://app.example.com'),
            getBearerToken: sinon.stub().resolves('token'),
            hasValidCredentials: sinon.stub().returns(true),
            isReady: sinon.stub().returns(true),
        }
        sinon.stub(AtxTokenServiceManager, 'getInstance').returns(fakeServiceManager)

        // Stub the handler methods we route to. Default the start methods to a
        // valid response so the server doesn't throw "StartTransform workflow failed".
        newStartTransform = sinon
            .stub(ATXTransformHandler.prototype, 'startTransform')
            .resolves({ TransformationJobId: 'j-new', ArtifactPath: 'p', UploadId: 'u' })
        legacyStartTransform = sinon
            .stub(AtxTransformHandlerLegacy.prototype, 'startTransform')
            .resolves({ TransformationJobId: 'j-legacy', ArtifactPath: 'p', UploadId: 'u' })

        newGetTransformInfo = sinon
            .stub(ATXTransformHandler.prototype, 'getTransformInfo')
            .resolves({ TransformationJob: { Status: 'NEW-RESULT' } } as any)
        legacyGetTransformInfo = sinon
            .stub(AtxTransformHandlerLegacy.prototype, 'getTransformInfo')
            .resolves({ TransformationJob: { Status: 'LEGACY-RESULT' } } as any)

        newUploadPlan = sinon
            .stub(ATXTransformHandler.prototype, 'uploadPlan')
            .resolves({ VerificationStatus: true, Message: 'NEW' } as any)
        legacyUploadPlan = sinon
            .stub(AtxTransformHandlerLegacy.prototype, 'uploadPlan')
            .resolves({ VerificationStatus: true, Message: 'LEGACY' } as any)

        // Capture the LSP handlers the server registers so we can invoke them in tests.
        logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub() }
        const lspMock = {
            addInitializer: sinon.stub(),
            onInitialized: (fn: any) => {
                onInitializedFn = fn
            },
            onExecuteCommand: (fn: any) => {
                executeCommandHandler = fn
            },
            window: {
                showMessage: sinon.stub(),
            },
        }

        const features: any = {
            workspace: {},
            logging,
            lsp: lspMock,
            telemetry: {},
            runtime: {},
        }

        // Building the server returns the inner closure that wires the handlers.
        const serverFactory = AtxNetTransformServerToken()
        serverFactory(features)

        // Run onInitialized to construct both handlers
        onInitializedFn()
    })

    afterEach(() => {
        sinon.restore()
    })

    describe('startTransform', () => {
        it('should route to NEW handler when useOrchestratorAgent=true', async () => {
            await executeCommandHandler(
                {
                    command: AtxStartTransformCommand,
                    WorkspaceId: 'ws-1',
                    StartTransformRequest: {},
                    useOrchestratorAgent: true,
                } as any,
                {} as any
            )

            expect(newStartTransform.calledOnce).to.be.true
            expect(legacyStartTransform.called).to.be.false
        })

        it('should reject with upgrade message when useOrchestratorAgent=false', async () => {
            const result = await executeCommandHandler(
                {
                    command: AtxStartTransformCommand,
                    WorkspaceId: 'ws-1',
                    StartTransformRequest: {},
                    useOrchestratorAgent: false,
                } as any,
                {} as any
            )

            expect(result.error).to.be.true
            expect(result.message).to.include('no longer supported')
            expect(result.message).to.include('update')
            expect(newStartTransform.called).to.be.false
            expect(legacyStartTransform.called).to.be.false
        })

        it('should reject with upgrade message when useOrchestratorAgent is omitted (old IDE)', async () => {
            const result = await executeCommandHandler(
                {
                    command: AtxStartTransformCommand,
                    WorkspaceId: 'ws-1',
                    StartTransformRequest: {},
                } as any,
                {} as any
            )

            expect(result.error).to.be.true
            expect(result.message).to.include('no longer supported')
            expect(result.message).to.include('update')
            expect(newStartTransform.called).to.be.false
            expect(legacyStartTransform.called).to.be.false
        })
    })

    describe('getTransformInfo', () => {
        it('should route to NEW handler when useOrchestratorAgent=true', async () => {
            await executeCommandHandler(
                {
                    command: AtxGetTransformInfoCommand,
                    TransformationJobId: 'j',
                    WorkspaceId: 'ws-1',
                    SolutionRootPath: 'C:/sln',
                    useOrchestratorAgent: true,
                } as any,
                {} as any
            )

            expect(newGetTransformInfo.calledOnce).to.be.true
            expect(legacyGetTransformInfo.called).to.be.false
        })

        it('should route to LEGACY handler when useOrchestratorAgent is omitted', async () => {
            await executeCommandHandler(
                {
                    command: AtxGetTransformInfoCommand,
                    TransformationJobId: 'j',
                    WorkspaceId: 'ws-1',
                    SolutionRootPath: 'C:/sln',
                } as any,
                {} as any
            )

            expect(legacyGetTransformInfo.calledOnce).to.be.true
            expect(newGetTransformInfo.called).to.be.false
        })

        it('should route per-request, not based on prior startTransform flag', async () => {
            // Simulate: prior startTransform set NEW, then a getTransformInfo without flag arrives
            await executeCommandHandler(
                {
                    command: AtxStartTransformCommand,
                    WorkspaceId: 'ws-1',
                    StartTransformRequest: {},
                    useOrchestratorAgent: true,
                } as any,
                {} as any
            )

            await executeCommandHandler(
                {
                    command: AtxGetTransformInfoCommand,
                    TransformationJobId: 'j',
                    WorkspaceId: 'ws-1',
                    SolutionRootPath: 'C:/sln',
                    // no useOrchestratorAgent here
                } as any,
                {} as any
            )

            // The startTransform NEW call doesn't bleed into the next request:
            // getTransformInfo without flag must route LEGACY.
            expect(legacyGetTransformInfo.calledOnce).to.be.true
            expect(newGetTransformInfo.called).to.be.false
        })
    })

    describe('uploadPlan', () => {
        it('should route to NEW handler when useOrchestratorAgent=true', async () => {
            await executeCommandHandler(
                {
                    command: AtxUploadPlanCommand,
                    TransformationJobId: 'j',
                    WorkspaceId: 'ws-1',
                    PlanPath: 'C:/plan.md',
                    useOrchestratorAgent: true,
                } as any,
                {} as any
            )

            expect(newUploadPlan.calledOnce).to.be.true
            expect(legacyUploadPlan.called).to.be.false
        })

        it('should route to LEGACY handler when useOrchestratorAgent is omitted', async () => {
            await executeCommandHandler(
                {
                    command: AtxUploadPlanCommand,
                    TransformationJobId: 'j',
                    WorkspaceId: 'ws-1',
                    PlanPath: 'C:/plan.md',
                } as any,
                {} as any
            )

            expect(legacyUploadPlan.calledOnce).to.be.true
            expect(newUploadPlan.called).to.be.false
        })
    })

    describe('loadOlderWorklogs', () => {
        it('should route loadOlderWorklogs to NEW handler', async () => {
            const loadOlderWorklogsStub = sinon
                .stub(ATXTransformHandler.prototype, 'loadOlderWorklogs')
                .resolves({ hasMore: false })

            await executeCommandHandler(
                {
                    command: 'aws/atxTransform/loadOlderWorklogs',
                    workspaceId: 'ws-1',
                    jobId: 'job-1',
                    solutionRootPath: 'C:/sln',
                    nextToken: 'token-123',
                } as any,
                {} as any
            )

            expect(loadOlderWorklogsStub.calledOnce).to.be.true
            expect(loadOlderWorklogsStub.firstCall.args).to.deep.equal(['ws-1', 'job-1', 'C:/sln', 'token-123'])
        })
    })

    describe('error result', () => {
        const serviceError = () =>
            Object.assign(new Error('User arn:aws:sts::123456789012:assumed-role/r/s is not authorized'), {
                name: 'AccessDeniedException',
                $metadata: { httpStatusCode: 403 },
            })

        it('adds the service error code and HTTP status', async () => {
            sinon.stub(ATXTransformHandler.prototype, 'listMessages').rejects(serviceError())

            const result = await executeCommandHandler(
                { command: 'aws/atxTransform/listMessages', workspaceId: 'ws-1', jobId: 'job-1' } as any,
                {} as any
            )

            expect(result.error).to.be.true
            expect(result.errorCode).to.equal('AccessDeniedException')
            expect(result.statusCode).to.equal(403)
        })

        it('has no error code or status for a plain error', async () => {
            sinon.stub(ATXTransformHandler.prototype, 'listMessages').rejects(new Error('client not initialized'))

            const result = await executeCommandHandler(
                { command: 'aws/atxTransform/listMessages', workspaceId: 'ws-1' } as any,
                {} as any
            )

            expect(result.error).to.be.true
            expect(result.errorCode).to.be.undefined
            expect(result.statusCode).to.be.undefined
        })
    })

    describe('routing log messages', () => {
        it('should log NEW handler routing decision for startTransform', async () => {
            await executeCommandHandler(
                {
                    command: AtxStartTransformCommand,
                    WorkspaceId: 'ws-1',
                    StartTransformRequest: {},
                    useOrchestratorAgent: true,
                } as any,
                {} as any
            )

            const logCalls = (logging.log as sinon.SinonStub).getCalls().map(c => c.args[0])
            expect(logCalls.some((m: string) => m.includes('startTransform') && m.includes('NEW'))).to.be.true
        })

        it('should log LEGACY handler routing decision for getTransformInfo', async () => {
            await executeCommandHandler(
                {
                    command: AtxGetTransformInfoCommand,
                    TransformationJobId: 'j',
                    WorkspaceId: 'ws-1',
                    SolutionRootPath: 'C:/sln',
                } as any,
                {} as any
            )

            const logCalls = (logging.log as sinon.SinonStub).getCalls().map(c => c.args[0])
            expect(logCalls.some((m: string) => m.includes('getTransformInfo') && m.includes('LEGACY'))).to.be.true
        })
    })
})
