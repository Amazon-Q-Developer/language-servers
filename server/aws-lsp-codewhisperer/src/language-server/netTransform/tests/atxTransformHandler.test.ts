import { expect } from 'chai'
import * as sinon from 'sinon'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ATXTransformHandler } from '../atxTransformHandler'
import { workspaceFolderName } from '../utils'
import { AtxTokenServiceManager } from '../../../shared/amazonQServiceManager/AtxTokenServiceManager'
import { Logging, Runtime, Workspace } from '@aws/language-server-runtimes/server-interface'

describe('ATXTransformHandler - Chat APIs', () => {
    let handler: ATXTransformHandler
    let serviceManager: AtxTokenServiceManager
    let workspace: Workspace
    let logging: Logging
    let runtime: Runtime
    let sendStub: sinon.SinonStub
    let addAuthStub: sinon.SinonStub

    beforeEach(() => {
        serviceManager = sinon.createStubInstance(AtxTokenServiceManager) as any
        workspace = {} as Workspace
        logging = { log: sinon.stub(), error: sinon.stub() } as any
        runtime = {} as Runtime

        handler = new ATXTransformHandler(serviceManager, workspace, logging, runtime)

        // Stub the client initialization and auth
        sendStub = sinon.stub()
        addAuthStub = sinon.stub().resolves()

        sinon.stub(handler as any, 'initializeAtxClient').resolves(true)
        sinon.stub(handler as any, 'addAuthToCommand').callsFake(addAuthStub)
        ;(handler as any).atxClient = { send: sendStub }
    })

    afterEach(() => {
        sinon.restore()
    })

    describe('sendMessage', () => {
        it('should send message and return response without polling', async () => {
            const mockResponse = {
                message: { messageId: 'msg-123' },
            }
            sendStub.resolves(mockResponse)

            const result = await handler.sendMessage({
                workspaceId: 'ws-123',
                text: 'test message',
                skipPolling: true,
            })

            expect(result).to.deep.equal({ success: true, data: mockResponse })
            expect(sendStub.calledOnce).to.be.true
        })

        it('should send message with job context', async () => {
            const mockResponse = {
                message: { messageId: 'msg-123' },
            }
            sendStub.resolves(mockResponse)

            await handler.sendMessage({
                workspaceId: 'ws-123',
                jobId: 'job-456',
                text: 'test message',
                skipPolling: true,
            })

            const callArgs = sendStub.firstCall.args[0]
            expect(callArgs.input.metadata.resourcesOnScreen.workspace.jobs).to.exist
            expect(callArgs.input.metadata.resourcesOnScreen.workspace.jobs[0].jobId).to.equal('job-456')
        })

        it('should poll for response when skipPolling is false', async () => {
            // Instant poll cadence so this runs deterministically instead of sleeping a
            // real 5s interval (the same wall-clock dependency that made the no-response
            // test flaky). Keeps the suite fast and side-effect-free in the full run.
            ;(handler as any)._chatPollIntervalMs = 0

            const sendResponse = { message: { messageId: 'msg-123' } }
            const listResponse = { messageIds: ['msg-123', 'msg-456'] }
            const batchResponse = {
                messages: [
                    {
                        messageId: 'msg-456',
                        parentMessageId: 'msg-123',
                        messageOrigin: 'SYSTEM',
                        processingInfo: { messageType: 'FINAL_RESPONSE' },
                        text: 'Response text',
                        interactions: [],
                    },
                ],
            }

            sendStub.onFirstCall().resolves(sendResponse)
            sendStub.onSecondCall().resolves(listResponse)
            sendStub.onThirdCall().resolves(batchResponse)

            const result = await handler.sendMessage({
                workspaceId: 'ws-123',
                text: 'test message',
                skipPolling: false,
            })

            expect(result.success).to.be.true
            expect(result.data.response.text).to.equal('Response text')
            expect(sendStub.callCount).to.be.greaterThan(1)
        })

        it('should return note when polling exhausts with no final response', async () => {
            // Drive the poll cadence to instant + a few attempts so the exhaustion path
            // runs deterministically. Previously this slept real 5s intervals and relied
            // on the 20s mocha timeout firing first — which raced the runner's clock and
            // flaked on slow CI, bailing the whole coverage suite.
            ;(handler as any)._chatPollIntervalMs = 0
            ;(handler as any)._chatPollMaxAttempts = 3

            const sendResponse = { message: { messageId: 'msg-123' } }
            const listResponse = { messageIds: [] }

            sendStub.onFirstCall().resolves(sendResponse)
            sendStub.resolves(listResponse)

            const result = await handler.sendMessage({
                workspaceId: 'ws-123',
                text: 'test message',
                skipPolling: false,
            })

            expect(result.success).to.be.true
            expect(result.data.response).to.be.null
            expect(result.data.note).to.include('No final response')
        })
    })

    describe('listMessages', () => {
        it('should list messages for workspace', async () => {
            const mockResponse = {
                messageIds: ['msg-1', 'msg-2', 'msg-3'],
            }
            sendStub.resolves(mockResponse)

            const result = await handler.listMessages({
                workspaceId: 'ws-123',
            })

            expect(result.messageIds).to.have.lengthOf(3)
            expect(sendStub.calledOnce).to.be.true
        })

        it('should list messages with job context', async () => {
            const mockResponse = { messageIds: ['msg-1'] }
            sendStub.resolves(mockResponse)

            await handler.listMessages({
                workspaceId: 'ws-123',
                jobId: 'job-456',
            })

            const callArgs = sendStub.firstCall.args[0]
            expect(callArgs.input.metadata.resourcesOnScreen.workspace.jobs).to.exist
        })

        it('should support pagination parameters', async () => {
            const mockResponse = { messageIds: ['msg-1'], nextToken: 'token-123' }
            sendStub.resolves(mockResponse)

            await handler.listMessages({
                workspaceId: 'ws-123',
                maxResults: 10,
                nextToken: 'prev-token',
            })

            const callArgs = sendStub.firstCall.args[0]
            expect(callArgs.input.maxResults).to.equal(10)
            expect(callArgs.input.nextToken).to.equal('prev-token')
        })

        it('should support timestamp filter', async () => {
            const mockResponse = { messageIds: [] }
            sendStub.resolves(mockResponse)

            const timestamp = new Date('2024-01-01')
            await handler.listMessages({
                workspaceId: 'ws-123',
                startTimestamp: timestamp,
            })

            const callArgs = sendStub.firstCall.args[0]
            expect(callArgs.input.startTimestamp).to.equal(timestamp)
        })
    })

    describe('batchGetMessages', () => {
        it('should retrieve messages by IDs', async () => {
            const mockResponse = {
                messages: [
                    { messageId: 'msg-1', text: 'Message 1' },
                    { messageId: 'msg-2', text: 'Message 2' },
                ],
            }
            sendStub.resolves(mockResponse)

            const result = await handler.batchGetMessages({
                workspaceId: 'ws-123',
                messageIds: ['msg-1', 'msg-2'],
            })

            expect(result.messages).to.have.lengthOf(2)
            expect(sendStub.calledOnce).to.be.true
        })

        it('should pass workspace ID and message IDs correctly', async () => {
            const mockResponse = { messages: [] }
            sendStub.resolves(mockResponse)

            await handler.batchGetMessages({
                workspaceId: 'ws-123',
                messageIds: ['msg-1', 'msg-2', 'msg-3'],
            })

            const callArgs = sendStub.firstCall.args[0]
            expect(callArgs.input.workspaceId).to.equal('ws-123')
            expect(callArgs.input.messageIds).to.have.lengthOf(3)
        })
    })

    describe('error handling', () => {
        it('should throw error when client not initialized', async () => {
            ;(handler as any).atxClient = null
            sinon.restore()
            sinon.stub(handler as any, 'initializeAtxClient').resolves(false)

            try {
                await handler.sendMessage({
                    workspaceId: 'ws-123',
                    text: 'test',
                })
                expect.fail('Should have thrown error')
            } catch (error: any) {
                expect(error.message).to.include('not initialized')
            }
        })

        it('should log errors on API failure', async () => {
            sendStub.rejects(new Error('API Error'))

            try {
                await handler.sendMessage({
                    workspaceId: 'ws-123',
                    text: 'test',
                    skipPolling: true,
                })
                expect.fail('Should have thrown error')
            } catch (error: any) {
                expect((logging.error as sinon.SinonStub).called).to.be.true
            }
        })
    })

    describe('loadOlderWorklogs', () => {
        it('should return hasMore false when no token stored', async () => {
            const result = await handler.loadOlderWorklogs('ws-123', 'job-456', '/tmp/solution')

            expect(result.hasMore).to.be.false
            expect(sendStub.called).to.be.false
        })

        it('should use provided nextToken', async () => {
            sendStub.resolves({ worklogs: [], outputToken: undefined })

            const result = await handler.loadOlderWorklogs('ws-123', 'job-456', '/tmp/solution', 'my-token')

            expect(sendStub.calledOnce).to.be.true
            expect(result.hasMore).to.be.false
        })

        it('should return hasMore true when outputToken returned', async () => {
            sendStub.resolves({
                worklogs: [{ attributeMap: { STEP_ID: 'step1' }, description: 'entry' }],
                outputToken: 'next-page',
            })

            const result = await handler.loadOlderWorklogs('ws-123', 'job-456', '/tmp/solution', 'first-token')

            expect(result.hasMore).to.be.true
        })

        it('should use stored token when no nextToken provided', async () => {
            // First call stores a token via listWorklogs
            sendStub.resolves({ worklogs: [], outputToken: 'stored-token' })
            // Access private method to seed the token
            ;(handler as any)._worklogNextTokenByJob.set('job-456', 'stored-token')

            sendStub.resolves({ worklogs: [], outputToken: undefined })
            const result = await handler.loadOlderWorklogs('ws-123', 'job-456', '/tmp/solution')

            expect(sendStub.calledOnce).to.be.true
            expect(result.hasMore).to.be.false
        })

        it('should not overwrite stored token when polling calls listWorklogs without nextToken', async () => {
            // Simulate: loadOlderWorklogs stored page-3 token
            ;(handler as any)._worklogNextTokenByJob.set('job-456', 'page-3-token')

            // Polling calls listWorklogs without nextToken — returns page-1 outputToken
            sendStub.resolves({ worklogs: [], outputToken: 'page-2-token' })
            await (handler as any).listWorklogs('ws-123', 'job-456', '/tmp/solution')

            // Token should still be page-3 (polling must not overwrite)
            expect((handler as any)._worklogNextTokenByJob.get('job-456')).to.equal('page-3-token')
        })

        it('should seed token on first polling call when no token exists', async () => {
            sendStub.resolves({ worklogs: [], outputToken: 'page-2-token' })
            await (handler as any).listWorklogs('ws-123', 'job-456', '/tmp/solution')

            expect((handler as any)._worklogNextTokenByJob.get('job-456')).to.equal('page-2-token')
        })

        it('should advance token when loadOlderWorklogs fetches next page', async () => {
            ;(handler as any)._worklogNextTokenByJob.set('job-456', 'page-2-token')

            sendStub.resolves({ worklogs: [{ description: 'old entry' }], outputToken: 'page-3-token' })
            const result = await handler.loadOlderWorklogs('ws-123', 'job-456', '/tmp/solution')

            expect(result.hasMore).to.be.true
            expect((handler as any)._worklogNextTokenByJob.get('job-456')).to.equal('page-3-token')
        })

        it('should delete token when loadOlderWorklogs reaches last page', async () => {
            ;(handler as any)._worklogNextTokenByJob.set('job-456', 'last-page-token')

            sendStub.resolves({ worklogs: [{ description: 'final entry' }], outputToken: undefined })
            const result = await handler.loadOlderWorklogs('ws-123', 'job-456', '/tmp/solution')

            expect(result.hasMore).to.be.false
            expect((handler as any)._worklogNextTokenByJob.has('job-456')).to.be.false
        })

        it('should clear token and return hasMore false on API error', async () => {
            ;(handler as any)._worklogNextTokenByJob.set('job-456', 'stale-token')

            sendStub.rejects(new Error('InvalidNextTokenException'))
            const result = await handler.loadOlderWorklogs('ws-123', 'job-456', '/tmp/solution')

            expect(result.hasMore).to.be.false
            expect((handler as any)._worklogNextTokenByJob.has('job-456')).to.be.false
        })
    })
})

describe('ATXTransformHandler - getTransformInfo', () => {
    let handler: ATXTransformHandler
    let serviceManager: AtxTokenServiceManager
    let workspace: Workspace
    let logging: Logging
    let runtime: Runtime
    let getJobStub: sinon.SinonStub
    let getTransformationPlanStub: sinon.SinonStub
    let listHitlsStub: sinon.SinonStub
    let listWorklogsStub: sinon.SinonStub
    let downloadFinalArtifactStub: sinon.SinonStub
    let getHitlAgentArtifactStub: sinon.SinonStub

    const baseRequest: any = {
        TransformationJobId: 'job-123',
        WorkspaceId: 'ws-123',
        SolutionRootPath: 'C:/sln',
    }

    beforeEach(() => {
        serviceManager = sinon.createStubInstance(AtxTokenServiceManager) as any
        workspace = {} as Workspace
        logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub(), warn: sinon.stub() } as any
        runtime = {} as Runtime

        handler = new ATXTransformHandler(serviceManager, workspace, logging, runtime)
        sinon.stub(handler as any, 'initializeAtxClient').resolves(true)
        ;(handler as any).atxClient = { send: sinon.stub() }

        getJobStub = sinon.stub(handler, 'getJob')
        getTransformationPlanStub = sinon.stub(handler, 'getTransformationPlan')
        listHitlsStub = sinon.stub(handler, 'listHitls')
        listWorklogsStub = sinon.stub(handler as any, 'listWorklogs').resolves(undefined)
        downloadFinalArtifactStub = sinon.stub(handler, 'downloadFinalArtifact')
        getHitlAgentArtifactStub = sinon.stub(handler, 'getHitlAgentArtifact')
    })

    afterEach(() => {
        sinon.restore()
    })

    it('should return JOB_NOT_FOUND when getJob returns null', async () => {
        getJobStub.resolves(null)

        const result = await handler.getTransformInfo(baseRequest)

        expect(result?.ErrorString).to.equal('JOB_NOT_FOUND')
        expect((logging.error as sinon.SinonStub).called).to.be.true
    })

    it('should return COMPLETED with artifact path and plan', async () => {
        getJobStub.resolves({ statusDetails: { status: 'COMPLETED' } })
        downloadFinalArtifactStub.resolves('C:/sln/artifact.zip')
        getTransformationPlanStub.resolves({ Root: { Children: [] } })

        const result = await handler.getTransformInfo(baseRequest)

        expect(result?.TransformationJob.Status).to.equal('COMPLETED')
        expect(result?.ArtifactPath).to.equal('C:/sln/artifact.zip')
        expect(result?.TransformationPlan).to.deep.equal({ Root: { Children: [] } })
    })

    it('should return FAILED with failureReason', async () => {
        getJobStub.resolves({
            statusDetails: { status: 'FAILED', failureReason: 'compile error' },
        })

        const result = await handler.getTransformInfo(baseRequest)

        expect(result?.TransformationJob.Status).to.equal('FAILED')
        expect((result?.TransformationJob as any).FailureReason).to.equal('compile error')
        expect(result?.ErrorString).to.equal('Transformation job failed')
    })

    it('should return STOPPED with error string', async () => {
        getJobStub.resolves({ statusDetails: { status: 'STOPPED' } })

        const result = await handler.getTransformInfo(baseRequest)

        expect(result?.TransformationJob.Status).to.equal('STOPPED')
        expect(result?.ErrorString).to.equal('Transformation job stopped')
    })

    it('should return EXECUTING with plan when no HITLs pending', async () => {
        getJobStub.resolves({ statusDetails: { status: 'EXECUTING' } })
        getTransformationPlanStub.resolves({ Root: { Children: [{ StepId: 's1', Children: [] }] } })
        listHitlsStub.resolves([])

        const result = await handler.getTransformInfo(baseRequest)

        expect(result?.TransformationJob.Status).to.equal('EXECUTING')
        expect(result?.TransformationPlan?.Root.Children).to.have.lengthOf(1)
    })

    it('should surface AWAITING_HUMAN_INPUT when EXECUTING with pending HITL', async () => {
        getJobStub.resolves({ statusDetails: { status: 'EXECUTING' } })
        getTransformationPlanStub.resolves({ Root: { Children: [] } })
        listHitlsStub.resolves([{ tag: 'local-build-verification', taskId: 'task-1' }])

        const result = await handler.getTransformInfo(baseRequest)

        expect(result?.TransformationJob.Status).to.equal('AWAITING_HUMAN_INPUT')
        expect(result?.HitlTag).to.equal('local-build-verification')
        expect(result?.HitlTaskId).to.equal('task-1')
    })

    it('should prefer local-build-verification over other HITL tags', async () => {
        getJobStub.resolves({ statusDetails: { status: 'EXECUTING' } })
        getTransformationPlanStub.resolves({ Root: { Children: [] } })
        listHitlsStub.resolves([
            { tag: 'missing-packages', taskId: 'task-mp' },
            { tag: 'local-build-verification', taskId: 'task-lbv' },
            { tag: 'other', taskId: 'task-other' },
        ])

        const result = await handler.getTransformInfo(baseRequest)

        expect(result?.HitlTag).to.equal('local-build-verification')
        expect(result?.HitlTaskId).to.equal('task-lbv')
    })

    it('should default to PLANNING-like fallthrough for unknown statuses', async () => {
        getJobStub.resolves({ statusDetails: { status: 'PLANNING' } })
        getTransformationPlanStub.resolves({ Root: { Children: [] } })
        listHitlsStub.resolves([])

        const result = await handler.getTransformInfo(baseRequest)

        expect(result?.TransformationJob.Status).to.equal('PLANNING')
        expect(listWorklogsStub.calledOnce).to.be.true
    })

    it('should surface AWAITING_HUMAN_INPUT for LBV HITL when status is PLANNING', async () => {
        getJobStub.resolves({ statusDetails: { status: 'PLANNING' } })
        getTransformationPlanStub.resolves({ Root: { Children: [] } })
        listHitlsStub.resolves([{ tag: 'local-build-verification', taskId: 'task-lbv' }])

        const result = await handler.getTransformInfo(baseRequest)

        expect(result?.TransformationJob.Status).to.equal('AWAITING_HUMAN_INPUT')
        expect(result?.HitlTag).to.equal('local-build-verification')
        expect(result?.HitlTaskId).to.equal('task-lbv')
        expect((handler as any).jobsPastLocalBuild.has('job-123')).to.be.true
    })

    it('should NOT surface a sibling repo LBV when status is PLANNING and all pending LBVs are out of the loaded scope', async () => {
        // Beam multi-repo: the IDE loaded one repo (beamScopeStepIds = its subtree). Every pending
        // HITL is a local-build-verification for a DIFFERENT (sibling) repo's plan step. Surfacing
        // one would make the IDE build the loaded solution against a sibling's HITL → false-green.
        // Mirrors the EXECUTING/getHitlAgentArtifact guard: return the plan-only view instead.
        getJobStub.resolves({ statusDetails: { status: 'PLANNING' } })
        getTransformationPlanStub.resolves({ Root: { Children: [] } })
        listHitlsStub.resolves([
            { tag: 'local-build-verification', taskId: 'task-sib1', stepId: 'sibling-step-1' },
            { tag: 'local-build-verification', taskId: 'task-sib2', stepId: 'sibling-step-2' },
        ])

        const result = await handler.getTransformInfo({
            ...baseRequest,
            beamScopeStepIds: 'loaded-step-a,loaded-step-b',
        })

        // Plan-only view: original job status preserved, no HITL surfaced to the IDE.
        expect(result?.TransformationJob.Status).to.equal('PLANNING')
        expect(result?.HitlTag).to.be.undefined
        expect(result?.HitlTaskId).to.be.undefined
        expect(result?.TransformationPlan).to.deep.equal({ Root: { Children: [] } })
    })

    it('should filter pre-job mode-selection -checkpoint HITL before LBV has run', async () => {
        getJobStub.resolves({ statusDetails: { status: 'PLANNING' } })
        getTransformationPlanStub.resolves({ Root: { Children: [] } })
        listHitlsStub.resolves([{ tag: 'job-123-checkpoint', taskId: 'task-cp' }])

        const result = await handler.getTransformInfo(baseRequest)

        expect(result?.TransformationJob.Status).to.equal('PLANNING')
        expect(result?.HitlTag).to.be.undefined
    })

    it('should surface post-build -checkpoint HITL once LBV has been seen', async () => {
        ;(handler as any).jobsPastLocalBuild.add('job-123')
        getJobStub.resolves({ statusDetails: { status: 'PLANNING' } })
        getTransformationPlanStub.resolves({ Root: { Children: [] } })
        listHitlsStub.resolves([{ tag: 'job-123-checkpoint', taskId: 'task-postcp' }])

        const result = await handler.getTransformInfo(baseRequest)

        expect(result?.TransformationJob.Status).to.equal('AWAITING_HUMAN_INPUT')
        expect(result?.HitlTaskId).to.equal('task-postcp')
    })

    it('should defensively surface unhandled HITL tags when status is PLANNING', async () => {
        getJobStub.resolves({ statusDetails: { status: 'PLANNING' } })
        getTransformationPlanStub.resolves({ Root: { Children: [] } })
        listHitlsStub.resolves([{ tag: 'some-future-tag', taskId: 'task-x' }])

        const result = await handler.getTransformInfo(baseRequest)

        expect(result?.TransformationJob.Status).to.equal('AWAITING_HUMAN_INPUT')
        expect(result?.HitlTag).to.equal('some-future-tag')
        expect(result?.HitlTaskId).to.equal('task-x')
    })

    it('should set DiffApplyFailed flag when diff context records failures', async () => {
        getJobStub.resolves({ statusDetails: { status: 'EXECUTING' } })
        getTransformationPlanStub.callsFake(async () => {
            const ctx = (handler as any)._currentDiffContext
            if (ctx) {
                ctx.failed = true
                ctx.failedStepIds.push('step-x')
            }
            return { Root: { Children: [] } }
        })
        listHitlsStub.resolves([])

        const result = await handler.getTransformInfo(baseRequest)

        expect(result?.DiffApplyFailed).to.equal(true)
        expect(result?.DiffApplyFailedStepIds).to.deep.equal(['step-x'])
    })

    it('should clear diff context after the call (no leak across calls)', async () => {
        getJobStub.resolves({ statusDetails: { status: 'COMPLETED' } })
        downloadFinalArtifactStub.resolves('path')
        getTransformationPlanStub.resolves({ Root: { Children: [] } })

        await handler.getTransformInfo(baseRequest)

        expect((handler as any)._currentDiffContext).to.be.null
    })

    it('should parse interactive_mode from job objective on first call', async () => {
        getJobStub.resolves({
            statusDetails: { status: 'EXECUTING' },
            objective: '{"interactive_mode":"interactive"}',
        })
        getTransformationPlanStub.resolves({ Root: { Children: [] } })
        listHitlsStub.resolves([])

        await handler.getTransformInfo(baseRequest)

        expect((handler as any).cachedInteractiveMode).to.equal('Interactive')
    })

    it('should default cachedInteractiveMode to Autonomous when objective is unparseable', async () => {
        getJobStub.resolves({
            statusDetails: { status: 'EXECUTING' },
            objective: 'not-json',
        })
        getTransformationPlanStub.resolves({ Root: { Children: [] } })
        listHitlsStub.resolves([])

        await handler.getTransformInfo(baseRequest)

        expect((handler as any).cachedInteractiveMode).to.equal('Autonomous')
    })

    it('should return null when getJob throws', async () => {
        getJobStub.rejects(new Error('network'))

        const result = await handler.getTransformInfo(baseRequest)

        expect(result).to.be.null
        expect((logging.error as sinon.SinonStub).called).to.be.true
    })
})

describe('ATXTransformHandler - getTransformationPlan & helpers', () => {
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
        sinon.stub(handler as any, 'initializeAtxClient').resolves(true)
        ;(handler as any).atxClient = { send: sinon.stub() }
    })

    afterEach(() => {
        sinon.restore()
    })

    describe('getTransformationPlan', () => {
        it('should return plan from fetchPlanTree on happy path', async () => {
            const plan = { Root: { StepId: 'root', Children: [{ StepId: 's1', Children: [] }] } } as any
            sinon.stub(handler as any, 'fetchPlanTree').resolves(plan)
            sinon.stub(handler as any, 'fetchWorklogs').resolves(undefined)
            sinon.stub(handler as any, 'downloadCompletedStepArtifacts').resolves(false)

            const result = await handler.getTransformationPlan('ws-1', 'job-1', 'C:/sln')

            expect(result.Root.Children).to.have.lengthOf(1)
            expect(result.Root.Children[0].StepId).to.equal('s1')
        })

        it('should return empty root when fetchPlanTree throws', async () => {
            sinon.stub(handler as any, 'fetchPlanTree').rejects(new Error('boom'))
            sinon.stub(handler as any, 'fetchWorklogs').resolves(undefined)

            const result = await handler.getTransformationPlan('ws-1', 'job-1', 'C:/sln')

            expect(result.Root.StepId).to.equal('root')
            expect(result.Root.Children).to.have.lengthOf(0)
            expect((logging.error as sinon.SinonStub).called).to.be.true
        })

        it('should mark diff context as failed when downloadCompletedStepArtifacts reports failure', async () => {
            const plan = { Root: { StepId: 'root', Children: [] } } as any
            sinon.stub(handler as any, 'fetchPlanTree').resolves(plan)
            sinon.stub(handler as any, 'fetchWorklogs').resolves(undefined)
            sinon.stub(handler as any, 'downloadCompletedStepArtifacts').resolves(true)
            ;(handler as any)._currentDiffContext = { failed: false, failedStepIds: [] }

            await handler.getTransformationPlan('ws-1', 'job-1', 'C:/sln')

            expect((handler as any)._currentDiffContext.failed).to.equal(true)
        })

        it('should not throw when fetchWorklogs rejects (fire-and-forget)', async () => {
            const plan = { Root: { StepId: 'root', Children: [] } } as any
            sinon.stub(handler as any, 'fetchPlanTree').resolves(plan)
            sinon.stub(handler as any, 'fetchWorklogs').rejects(new Error('worklog network'))
            sinon.stub(handler as any, 'downloadCompletedStepArtifacts').resolves(false)

            const result = await handler.getTransformationPlan('ws-1', 'job-1', 'C:/sln')

            expect(result.Root).to.exist
        })
    })

    describe('buildTreeFromFlatList', () => {
        it('should build a parent-child tree from flat list', () => {
            const flat = [
                { stepId: 'a', parentStepId: 'root', stepName: 'A', score: 1 },
                { stepId: 'b', parentStepId: 'a', stepName: 'B', score: 2 },
                { stepId: 'c', parentStepId: 'a', stepName: 'C', score: 3 },
            ]

            const tree = (handler as any).buildTreeFromFlatList(flat)

            expect(tree).to.have.lengthOf(1)
            expect(tree[0].StepId).to.equal('a')
            expect(tree[0].Children).to.have.lengthOf(2)
            expect(tree[0].Children.map((c: any) => c.StepId)).to.deep.equal(['b', 'c'])
        })

        it('should treat orphan steps (parent not in list) as root-level', () => {
            const flat = [
                { stepId: 'a', parentStepId: 'missing-parent', stepName: 'A' },
                { stepId: 'b', parentStepId: 'root', stepName: 'B' },
            ]

            const tree = (handler as any).buildTreeFromFlatList(flat)

            expect(tree).to.have.lengthOf(2)
            const ids = tree.map((s: any) => s.StepId).sort()
            expect(ids).to.deep.equal(['a', 'b'])
        })

        it('should sort children by score ascending', () => {
            const flat = [
                { stepId: 'p', parentStepId: 'root', stepName: 'P', score: 0 },
                { stepId: 'b', parentStepId: 'p', stepName: 'B', score: 30 },
                { stepId: 'a', parentStepId: 'p', stepName: 'A', score: 10 },
                { stepId: 'c', parentStepId: 'p', stepName: 'C', score: 20 },
            ]

            const tree = (handler as any).buildTreeFromFlatList(flat)

            expect(tree[0].Children.map((c: any) => c.StepId)).to.deep.equal(['a', 'c', 'b'])
        })

        it('should return empty array for empty input', () => {
            const tree = (handler as any).buildTreeFromFlatList([])
            expect(tree).to.deep.equal([])
        })
    })

    describe('mapApiStepToNode', () => {
        it('should map camelCase API fields to PascalCase node fields', () => {
            const node = (handler as any).mapApiStepToNode({
                stepId: 's1',
                parentStepId: 'p1',
                stepName: 'Name',
                description: 'Desc',
                status: 'SUCCEEDED',
                score: 5,
            })

            expect(node).to.deep.include({
                StepId: 's1',
                ParentStepId: 'p1',
                StepName: 'Name',
                Description: 'Desc',
                Status: 'SUCCEEDED',
                score: 5,
            })
            expect(node.Children).to.deep.equal([])
        })

        it('should convert parentStepId="root" to null', () => {
            const node = (handler as any).mapApiStepToNode({
                stepId: 's1',
                parentStepId: 'root',
                status: 'NOT_STARTED',
            })

            expect(node.ParentStepId).to.be.null
        })

        it('should default missing fields to safe values', () => {
            const node = (handler as any).mapApiStepToNode({})

            expect(node.StepId).to.equal('')
            expect(node.ParentStepId).to.be.null
            expect(node.Status).to.equal('NOT_STARTED')
            expect(node.score).to.equal(0)
        })
    })

    describe('findCompletedSteps', () => {
        it('should return only SUCCEEDED steps at depth 2', () => {
            // depth 0 = root, depth 1 = root's children, depth 2 = grandchildren
            const root = {
                StepId: 'root',
                Status: 'SUCCEEDED', // depth 0, must be ignored
                Children: [
                    {
                        StepId: 'lvl1',
                        Status: 'SUCCEEDED', // depth 1, must be ignored
                        Children: [
                            { StepId: 'g1', Status: 'SUCCEEDED', Children: [] },
                            { StepId: 'g2', Status: 'IN_PROGRESS', Children: [] },
                            { StepId: 'g3', Status: 'SUCCEEDED', Children: [] },
                        ],
                    },
                ],
            } as any

            const completed = (handler as any).findCompletedSteps(root)

            expect(completed.map((s: any) => s.StepId)).to.deep.equal(['g1', 'g3'])
        })

        it('should return empty when no SUCCEEDED at depth 2', () => {
            const root = {
                StepId: 'root',
                Status: 'NOT_STARTED',
                Children: [
                    {
                        StepId: 'lvl1',
                        Status: 'IN_PROGRESS',
                        Children: [{ StepId: 'g1', Status: 'IN_PROGRESS', Children: [] }],
                    },
                ],
            } as any

            const completed = (handler as any).findCompletedSteps(root)
            expect(completed).to.deep.equal([])
        })
    })

    describe('mapApiStatus', () => {
        it('should pass through valid statuses', () => {
            expect((handler as any).mapApiStatus('SUCCEEDED')).to.equal('SUCCEEDED')
            expect((handler as any).mapApiStatus('IN_PROGRESS')).to.equal('IN_PROGRESS')
        })

        it('should default to NOT_STARTED when status missing', () => {
            expect((handler as any).mapApiStatus(undefined)).to.equal('NOT_STARTED')
        })
    })
})

describe('ATXTransformHandler - updateWorkspace & applyChanges', () => {
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
        sinon.stub(handler as any, 'initializeAtxClient').resolves(true)
        ;(handler as any).atxClient = { send: sinon.stub() }
    })

    afterEach(() => {
        sinon.restore()
    })

    describe('updateWorkspace', () => {
        it('should return error when no active step HITL is found and no pending step in plan', async () => {
            sinon.stub(handler as any, 'findStepLevelHitl').resolves(null)
            sinon.stub(handler as any, 'fetchPlanTree').resolves({
                Root: { StepId: 'root', Children: [], Status: 'SUCCEEDED' },
            })
            sinon.stub(handler, 'listHitls').resolves([])

            const result = await handler.updateWorkspace('ws-1', 'job-1', 'C:/sln', 'step-1')

            expect(result.Success).to.be.false
            expect(result.Error).to.equal('No active step HITL found')
        })

        it('should resolve the real pending step when client stepId misses (C2-a fallback)', async () => {
            const findHitlStub = sinon.stub(handler as any, 'findStepLevelHitl')
            // First call with client's stale stepId returns null
            findHitlStub.withArgs('ws-1', 'job-1', 'stale-substep-id').resolves(null)
            // Second call with the resolved pending step id succeeds
            findHitlStub.withArgs('ws-1', 'job-1', 'real-project-step').resolves({ taskId: 'resolved-task' })

            sinon.stub(handler as any, 'fetchPlanTree').resolves({
                Root: {
                    StepId: 'root',
                    Status: 'IN_PROGRESS',
                    Children: [
                        {
                            StepId: 'real-project-step',
                            Status: 'PENDING_HUMAN_INPUT',
                            Children: [],
                        },
                    ],
                },
            })
            sinon.stub(handler as any, 'getModifiedFilesSinceCheckpoint').returns([])
            sinon.stub(handler as any, 'createUpdateWorkspaceZip').resolves('C:/zip.zip')
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadUrl: 'https://s3/upload',
                uploadId: 'upload-1',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true } as any)
            sinon.stub(handler, 'updateHitl').resolves({ ok: true })

            const result = await handler.updateWorkspace('ws-1', 'job-1', 'C:/sln', 'stale-substep-id')

            expect(result.Success).to.be.true
            expect(findHitlStub.calledWith('ws-1', 'job-1', 'real-project-step')).to.be.true
        })

        it('should not fetch plan when cachedStepHitl is set (no extra round-trip)', async () => {
            ;(handler as any).cachedStepHitl = 'cached-task-id'
            const fetchPlanStub = sinon.stub(handler as any, 'fetchPlanTree')
            sinon.stub(handler as any, 'getModifiedFilesSinceCheckpoint').returns([])
            sinon.stub(handler as any, 'createUpdateWorkspaceZip').resolves('C:/zip.zip')
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadUrl: 'https://s3/upload',
                uploadId: 'upload-1',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true } as any)
            sinon.stub(handler, 'updateHitl').resolves({ ok: true })

            const result = await handler.updateWorkspace('ws-1', 'job-1', 'C:/sln', 'step-1')

            expect(result.Success).to.be.true
            expect(fetchPlanStub.called).to.be.false
        })

        it('should not retry when pending step id equals client stepId', async () => {
            const findHitlStub = sinon.stub(handler as any, 'findStepLevelHitl').resolves(null)
            sinon.stub(handler as any, 'fetchPlanTree').resolves({
                Root: {
                    StepId: 'root',
                    Status: 'IN_PROGRESS',
                    Children: [{ StepId: 'step-1', Status: 'PENDING_HUMAN_INPUT', Children: [] }],
                },
            })
            sinon.stub(handler, 'listHitls').resolves([])

            const result = await handler.updateWorkspace('ws-1', 'job-1', 'C:/sln', 'step-1')

            expect(result.Success).to.be.false
            expect(result.Error).to.equal('No active step HITL found')
            // Should only call findStepLevelHitl once (no retry since pending.StepId === stepId)
            expect(findHitlStub.callCount).to.equal(1)
        })

        it('should find review HITL via scan when plan-based resolution misses (race condition)', async () => {
            sinon.stub(handler as any, 'findStepLevelHitl').resolves(null)
            // Plan has no PENDING_HUMAN_INPUT step (already flipped to IN_PROGRESS on retry)
            sinon.stub(handler as any, 'fetchPlanTree').resolves({
                Root: {
                    StepId: 'root',
                    Status: 'IN_PROGRESS',
                    Children: [{ StepId: 'project-step', Status: 'IN_PROGRESS', Children: [] }],
                },
            })
            // But the review HITL is still alive
            sinon.stub(handler, 'listHitls').resolves([{ tag: 'project-step-review', taskId: 'review-task-123' }])
            sinon.stub(handler as any, 'getModifiedFilesSinceCheckpoint').returns([])
            sinon.stub(handler as any, 'createUpdateWorkspaceZip').resolves('C:/zip.zip')
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadUrl: 'https://s3/upload',
                uploadId: 'upload-1',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true } as any)
            sinon.stub(handler, 'updateHitl').resolves({ ok: true })

            const result = await handler.updateWorkspace('ws-1', 'job-1', 'C:/sln', 'stale-step')

            expect(result.Success).to.be.true
        })

        it('should return error when createUpdateWorkspaceZip returns empty path', async () => {
            sinon.stub(handler as any, 'findStepLevelHitl').resolves({ taskId: 't1' })
            sinon.stub(handler as any, 'getModifiedFilesSinceCheckpoint').returns([])
            sinon.stub(handler as any, 'createUpdateWorkspaceZip').resolves('')

            const result = await handler.updateWorkspace('ws-1', 'job-1', 'C:/sln', 'step-1')

            expect(result.Success).to.be.false
            expect(result.Error).to.equal('Failed to create update workspace zip')
        })

        it('should return error when createArtifactUploadUrl fails', async () => {
            sinon.stub(handler as any, 'findStepLevelHitl').resolves({ taskId: 't1' })
            sinon.stub(handler as any, 'getModifiedFilesSinceCheckpoint').returns([])
            sinon.stub(handler as any, 'createUpdateWorkspaceZip').resolves('C:/zip.zip')
            sinon.stub(handler, 'createArtifactUploadUrl').resolves(null)

            const result = await handler.updateWorkspace('ws-1', 'job-1', 'C:/sln', 'step-1')

            expect(result.Success).to.be.false
            expect(result.Error).to.equal('Failed to create artifact upload URL')
        })

        it('should return success and clear cachedStepHitl on full happy path', async () => {
            ;(handler as any).cachedStepHitl = 'cached-task-id'
            sinon.stub(handler as any, 'getModifiedFilesSinceCheckpoint').returns([])
            sinon.stub(handler as any, 'createUpdateWorkspaceZip').resolves('C:/zip.zip')
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadUrl: 'https://s3/upload',
                uploadId: 'upload-1',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true } as any)
            sinon.stub(handler, 'updateHitl').resolves({ ok: true })

            const result = await handler.updateWorkspace('ws-1', 'job-1', 'C:/sln', 'step-1')

            expect(result.Success).to.be.true
            expect((handler as any).cachedStepHitl).to.be.null
        })

        it('should return error when uploadArtifact fails', async () => {
            sinon.stub(handler as any, 'findStepLevelHitl').resolves({ taskId: 't1' })
            sinon.stub(handler as any, 'getModifiedFilesSinceCheckpoint').returns([])
            sinon.stub(handler as any, 'createUpdateWorkspaceZip').resolves('C:/zip.zip')
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadUrl: 'https://s3/upload',
                uploadId: 'upload-1',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(false)

            const result = await handler.updateWorkspace('ws-1', 'job-1', 'C:/sln', 'step-1')

            expect(result.Success).to.be.false
            expect(result.Error).to.equal('Failed to upload update workspace zip to S3')
        })

        it('should return error when completeArtifactUpload fails', async () => {
            sinon.stub(handler as any, 'findStepLevelHitl').resolves({ taskId: 't1' })
            sinon.stub(handler as any, 'getModifiedFilesSinceCheckpoint').returns([])
            sinon.stub(handler as any, 'createUpdateWorkspaceZip').resolves('C:/zip.zip')
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadUrl: 'u',
                uploadId: 'upload-1',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: false } as any)

            const result = await handler.updateWorkspace('ws-1', 'job-1', 'C:/sln', 'step-1')

            expect(result.Success).to.be.false
            expect(result.Error).to.equal('Failed to complete artifact upload')
        })

        it('should return error when updateHitl returns null', async () => {
            sinon.stub(handler as any, 'findStepLevelHitl').resolves({ taskId: 't1' })
            sinon.stub(handler as any, 'getModifiedFilesSinceCheckpoint').returns([])
            sinon.stub(handler as any, 'createUpdateWorkspaceZip').resolves('C:/zip.zip')
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadUrl: 'u',
                uploadId: 'upload-1',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true } as any)
            sinon.stub(handler, 'updateHitl').resolves(null)

            const result = await handler.updateWorkspace('ws-1', 'job-1', 'C:/sln', 'step-1')

            expect(result.Success).to.be.false
            expect(result.Error).to.equal('Failed to update workspace HITL')
        })

        it('should return error when client cannot be initialized', async () => {
            sinon.restore()
            logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub() } as any
            handler = new ATXTransformHandler(serviceManager, workspace, logging, runtime)
            sinon.stub(handler as any, 'initializeAtxClient').resolves(false)
            ;(handler as any).atxClient = null

            const result = await handler.updateWorkspace('ws-1', 'job-1', 'C:/sln', 'step-1')

            expect(result.Success).to.be.false
            expect(result.Error).to.equal('ATX FES client not initialized')
        })
    })

    describe('applyChanges', () => {
        let tmpRoot: string
        let checkpointFolder: string
        let solutionRoot: string

        beforeEach(() => {
            // Create a fresh temp working tree for each test
            tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atx-applychanges-'))
            checkpointFolder = path.join(tmpRoot, 'checkpoint')
            solutionRoot = path.join(tmpRoot, 'sln')
            fs.mkdirSync(path.join(checkpointFolder, 'after'), { recursive: true })
            fs.mkdirSync(solutionRoot, { recursive: true })
        })

        afterEach(() => {
            try {
                fs.rmSync(tmpRoot, { recursive: true, force: true })
            } catch {
                // best effort
            }
        })

        const writeMetadata = (data: any) => {
            fs.writeFileSync(path.join(checkpointFolder, 'metadata.json'), JSON.stringify(data))
        }

        it('should fail when metadata.json is missing', async () => {
            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot)

            expect(result.success).to.be.false
            expect(result.error).to.include('metadata.json not found')
        })

        it('should add files from after/ directory', async () => {
            const relPath = 'src/Added.cs'
            fs.mkdirSync(path.join(checkpointFolder, 'after', 'src'), { recursive: true })
            fs.writeFileSync(path.join(checkpointFolder, 'after', relPath), '// added')
            writeMetadata({ filesAdded: [relPath] })

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot)

            expect(result.success).to.be.true
            expect(result.filesAdded).to.equal(1)
            expect(result.addedFiles).to.deep.equal([relPath])
            expect(fs.existsSync(path.join(solutionRoot, relPath))).to.be.true
        })

        it('should remove files listed in filesRemoved', async () => {
            const relPath = 'OldFile.cs'
            fs.writeFileSync(path.join(solutionRoot, relPath), '// old')
            writeMetadata({ filesRemoved: [relPath] })

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot)

            expect(result.success).to.be.true
            expect(result.filesRemoved).to.equal(1)
            expect(fs.existsSync(path.join(solutionRoot, relPath))).to.be.false
        })

        it('should update files from after/ directory', async () => {
            const relPath = 'Existing.cs'
            fs.writeFileSync(path.join(solutionRoot, relPath), '// old content')
            fs.writeFileSync(path.join(checkpointFolder, 'after', relPath), '// new content')
            writeMetadata({ filesUpdated: [relPath] })

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot)

            expect(result.success).to.be.true
            expect(result.filesUpdated).to.equal(1)
            expect(fs.readFileSync(path.join(solutionRoot, relPath), 'utf-8')).to.equal('// new content')
        })

        it('should move files according to movedFilesMap', async () => {
            fs.writeFileSync(path.join(solutionRoot, 'before.cs'), '// content')
            writeMetadata({
                movedFilesMap: [{ before: 'before.cs', after: 'newdir/after.cs' }],
            })

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot)

            expect(result.success).to.be.true
            expect(result.filesMoved).to.equal(1)
            expect(fs.existsSync(path.join(solutionRoot, 'before.cs'))).to.be.false
            expect(fs.existsSync(path.join(solutionRoot, 'newdir/after.cs'))).to.be.true
        })

        it('should succeed with zero counts when metadata is empty', async () => {
            writeMetadata({})

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot)

            expect(result.success).to.be.true
            expect(result.filesAdded).to.equal(0)
            expect(result.filesRemoved).to.equal(0)
            expect(result.filesUpdated).to.equal(0)
            expect(result.filesMoved).to.equal(0)
        })

        it('should skip removal when target file does not exist', async () => {
            writeMetadata({ filesRemoved: ['NotThere.cs'] })

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot)

            expect(result.success).to.be.true
            expect(result.filesRemoved).to.equal(0)
        })

        it('should fail gracefully when metadata.json is invalid JSON', async () => {
            fs.writeFileSync(path.join(checkpointFolder, 'metadata.json'), '{not json')

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot)

            expect(result.success).to.be.false
            expect(result.error).to.be.a('string')
        })

        // --- DealerFx P452432920: preserve customer edits instead of clobbering them ---

        const JOB_ID = 'job-dealerfx'

        // Seed the source-files manifest so getModifiedFilesSinceCheckpoint can flag the
        // listed dest paths as customer-edited since the last apply.
        const seedManifest = (relPaths: string[], lastAppliedTimestamp: number) => {
            const checkpointsDir = path.join(solutionRoot, workspaceFolderName, JOB_ID, 'checkpoints')
            fs.mkdirSync(checkpointsDir, { recursive: true })
            fs.writeFileSync(
                path.join(checkpointsDir, 'source-files.json'),
                JSON.stringify({
                    sourceFiles: relPaths.map(r => path.join(solutionRoot, r)),
                    lastAppliedTimestamp,
                })
            )
        }
        // Force a file's mtime to be newer than the watermark (the "customer edited it" signal).
        const touchAfter = (absPath: string, ts: number) => {
            const future = new Date(ts + 60_000)
            fs.utimesSync(absPath, future, future)
        }

        it('preserves a user-modified updated file and backs it up instead of clobbering', async () => {
            const relPath = 'ProjA/Edited.cs'
            const dest = path.join(solutionRoot, relPath)
            fs.mkdirSync(path.dirname(dest), { recursive: true })
            fs.writeFileSync(dest, '// USER EDIT')
            fs.mkdirSync(path.join(checkpointFolder, 'after', 'ProjA'), { recursive: true })
            fs.writeFileSync(path.join(checkpointFolder, 'after', relPath), '// agent version')
            writeMetadata({ filesUpdated: [relPath] })

            const watermark = Date.now() - 10_000
            seedManifest([relPath], watermark)
            touchAfter(dest, watermark)

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot, JOB_ID)

            expect(result.success).to.be.true
            expect(result.filesUpdated).to.equal(0)
            expect(fs.readFileSync(dest, 'utf-8')).to.equal('// USER EDIT')
            expect(result.conflictedFiles).to.include(path.resolve(dest))
            // Backup of the user's file exists under the per-job checkpoints tree.
            const backupRoot = path.join(solutionRoot, workspaceFolderName, JOB_ID, 'checkpoints', 'conflict-backups')
            const backup = path.join(backupRoot, relPath)
            expect(fs.existsSync(backup)).to.be.true
            expect(fs.readFileSync(backup, 'utf-8')).to.equal('// USER EDIT')
        })

        it('overwrites an updated file the user did NOT touch', async () => {
            const relPath = 'ProjA/Untouched.cs'
            const dest = path.join(solutionRoot, relPath)
            fs.mkdirSync(path.dirname(dest), { recursive: true })
            fs.writeFileSync(dest, '// old content')
            fs.mkdirSync(path.join(checkpointFolder, 'after', 'ProjA'), { recursive: true })
            fs.writeFileSync(path.join(checkpointFolder, 'after', relPath), '// agent version')
            writeMetadata({ filesUpdated: [relPath] })

            // Manifest exists, but this file is NOT in sourceFiles -> not flagged as edited.
            seedManifest(['ProjA/SomethingElse.cs'], Date.now() - 10_000)

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot, JOB_ID)

            expect(result.success).to.be.true
            expect(result.filesUpdated).to.equal(1)
            expect(fs.readFileSync(dest, 'utf-8')).to.equal('// agent version')
            expect(result.conflictedFiles).to.be.undefined
        })

        it('treats a byte-equal re-apply as no conflict (agent re-emit)', async () => {
            const relPath = 'ProjA/Same.cs'
            const dest = path.join(solutionRoot, relPath)
            fs.mkdirSync(path.dirname(dest), { recursive: true })
            fs.writeFileSync(dest, '// identical')
            fs.mkdirSync(path.join(checkpointFolder, 'after', 'ProjA'), { recursive: true })
            fs.writeFileSync(path.join(checkpointFolder, 'after', relPath), '// identical')
            writeMetadata({ filesUpdated: [relPath] })

            const watermark = Date.now() - 10_000
            seedManifest([relPath], watermark)
            touchAfter(dest, watermark)

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot, JOB_ID)

            expect(result.success).to.be.true
            expect(result.filesUpdated).to.equal(1)
            expect(result.conflictedFiles).to.be.undefined
            expect(
                fs.existsSync(path.join(solutionRoot, workspaceFolderName, JOB_ID, 'checkpoints', 'conflict-backups'))
            ).to.be.false
        })

        it('filesMoved: skips both copy and unlink when the move target is user-modified', async () => {
            const beforeRel = 'ProjA/Before.cs'
            const afterRel = 'ProjA/After.cs'
            const beforeAbs = path.join(solutionRoot, beforeRel)
            const afterAbs = path.join(solutionRoot, afterRel)
            fs.mkdirSync(path.dirname(beforeAbs), { recursive: true })
            fs.writeFileSync(beforeAbs, '// move source')
            fs.writeFileSync(afterAbs, '// USER EDIT at target')
            writeMetadata({ movedFilesMap: [{ before: beforeRel, after: afterRel }] })

            const watermark = Date.now() - 10_000
            seedManifest([afterRel], watermark)
            touchAfter(afterAbs, watermark)

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot, JOB_ID)

            expect(result.success).to.be.true
            expect(result.filesMoved).to.equal(0)
            expect(fs.existsSync(beforeAbs)).to.be.true // unlink skipped
            expect(fs.readFileSync(afterAbs, 'utf-8')).to.equal('// USER EDIT at target')
            expect(result.conflictedFiles).to.include(path.resolve(afterAbs))
        })

        it('filesMoved: skips move when the move SOURCE is user-modified', async () => {
            const beforeRel = 'ProjA/EditedSource.cs'
            const afterRel = 'ProjA/Renamed.cs'
            const beforeAbs = path.join(solutionRoot, beforeRel)
            const afterAbs = path.join(solutionRoot, afterRel)
            fs.mkdirSync(path.dirname(beforeAbs), { recursive: true })
            fs.writeFileSync(beforeAbs, '// USER EDIT at source')
            writeMetadata({ movedFilesMap: [{ before: beforeRel, after: afterRel }] })

            const watermark = Date.now() - 10_000
            seedManifest([beforeRel], watermark)
            touchAfter(beforeAbs, watermark)

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot, JOB_ID)

            expect(result.success).to.be.true
            expect(result.filesMoved).to.equal(0)
            expect(fs.existsSync(beforeAbs)).to.be.true // source preserved
            expect(fs.readFileSync(beforeAbs, 'utf-8')).to.equal('// USER EDIT at source')
            expect(fs.existsSync(afterAbs)).to.be.false // move target not created
            expect(result.conflictedFiles).to.include(path.resolve(beforeAbs))
            // Backup of customer's source file exists
            const backupRoot = path.join(solutionRoot, workspaceFolderName, JOB_ID, 'checkpoints', 'conflict-backups')
            const backup = path.join(backupRoot, beforeRel)
            expect(fs.existsSync(backup)).to.be.true
            expect(fs.readFileSync(backup, 'utf-8')).to.equal('// USER EDIT at source')
        })

        it('filesRemoved: preserves a customer-edited file instead of deleting it', async () => {
            const relPath = 'ProjA/Edited.cs'
            const filePath = path.join(solutionRoot, relPath)
            fs.mkdirSync(path.dirname(filePath), { recursive: true })
            fs.writeFileSync(filePath, '// USER EDIT')
            writeMetadata({ filesRemoved: [relPath] })

            const watermark = Date.now() - 10_000
            seedManifest([relPath], watermark)
            touchAfter(filePath, watermark)

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot, JOB_ID)

            expect(result.success).to.be.true
            expect(result.filesRemoved).to.equal(0)
            expect(fs.existsSync(filePath)).to.be.true // file NOT deleted
            expect(fs.readFileSync(filePath, 'utf-8')).to.equal('// USER EDIT')
            expect(result.conflictedFiles).to.include(path.resolve(filePath))
            // Backup of customer's file exists
            const backupRoot = path.join(solutionRoot, workspaceFolderName, JOB_ID, 'checkpoints', 'conflict-backups')
            const backup = path.join(backupRoot, relPath)
            expect(fs.existsSync(backup)).to.be.true
            expect(fs.readFileSync(backup, 'utf-8')).to.equal('// USER EDIT')
        })

        it('filesRemoved: deletes file if user did NOT edit it', async () => {
            const relPath = 'ProjA/Untouched.cs'
            const filePath = path.join(solutionRoot, relPath)
            fs.mkdirSync(path.dirname(filePath), { recursive: true })
            fs.writeFileSync(filePath, '// old content')
            writeMetadata({ filesRemoved: [relPath] })

            // File is NOT in the manifest's sourceFiles, so it's not flagged as modified
            seedManifest(['ProjA/SomethingElse.cs'], Date.now() - 10_000)

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot, JOB_ID)

            expect(result.success).to.be.true
            expect(result.filesRemoved).to.equal(1)
            expect(fs.existsSync(filePath)).to.be.false // file deleted
            expect(result.conflictedFiles).to.be.undefined
        })

        it('with no jobId / no manifest, overwrites exactly as before (back-compat)', async () => {
            const relPath = 'Existing.cs'
            const dest = path.join(solutionRoot, relPath)
            fs.writeFileSync(dest, '// old content')
            fs.writeFileSync(path.join(checkpointFolder, 'after', relPath), '// new content')
            writeMetadata({ filesUpdated: [relPath] })

            // Called with 2 args, exactly like the legacy call sites.
            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot)

            expect(result.success).to.be.true
            expect(result.filesUpdated).to.equal(1)
            expect(fs.readFileSync(dest, 'utf-8')).to.equal('// new content')
            expect(result.conflictedFiles).to.be.undefined
        })

        it('does not round-trip: a conflict backup is not seen as a modified source file', async () => {
            const relPath = 'ProjA/Edited.cs'
            const dest = path.join(solutionRoot, relPath)
            fs.mkdirSync(path.dirname(dest), { recursive: true })
            fs.writeFileSync(dest, '// USER EDIT')
            fs.mkdirSync(path.join(checkpointFolder, 'after', 'ProjA'), { recursive: true })
            fs.writeFileSync(path.join(checkpointFolder, 'after', relPath), '// agent version')
            writeMetadata({ filesUpdated: [relPath] })

            const watermark = Date.now() - 10_000
            seedManifest([relPath], watermark)
            touchAfter(dest, watermark)

            await (handler as any).applyChanges(checkpointFolder, solutionRoot, JOB_ID)

            // The backup lives under checkpoints/, which is never in sourceFiles, so the
            // uplink scan must not pick it up as a customer edit.
            const modified: string[] = (handler as any).getModifiedFilesSinceCheckpoint(solutionRoot, JOB_ID)
            expect(modified.some(p => p.includes('conflict-backups'))).to.be.false
        })

        it('downloadCompletedStepArtifacts applies a step and stamps the apply watermark (interactive path)', async () => {
            // The interactive download path must also stamp lastAppliedTimestamp after a
            // successful apply (the DealerFx co-fix — the diff-artifact path already did).
            // Drive it end-to-end: stub the per-step download to materialize a checkpoint,
            // let the real applyChanges run, and assert the step is marked applied AND the
            // watermark advances. (Kept in this block, which the coverage suite reliably
            // reaches, rather than a late describe.)
            const checkpointsDir = path.join(solutionRoot, workspaceFolderName, JOB_ID, 'checkpoints')
            fs.mkdirSync(checkpointsDir, { recursive: true })
            // The manifest must pre-exist for the watermark/manifest writes to apply (both
            // no-op without it), mirroring a job whose manifest was created on an earlier sync.
            fs.writeFileSync(
                path.join(checkpointsDir, 'source-files.json'),
                JSON.stringify({ sourceFiles: [], lastAppliedTimestamp: 1 })
            )
            const plan = {
                Root: {
                    StepId: 'root',
                    Status: 'NOT_STARTED',
                    Children: [
                        {
                            StepId: 'lvl1',
                            Status: 'NOT_STARTED',
                            Children: [{ StepId: 'g1', Status: 'SUCCEEDED', Children: [], score: 1 }],
                        },
                    ],
                },
            }
            const stepDir = path.join(checkpointsDir, 'g1')
            sinon.stub(handler as any, 'downloadCompletedStepArtifact').callsFake(async () => {
                fs.mkdirSync(path.join(stepDir, 'after', 'src'), { recursive: true })
                fs.writeFileSync(path.join(stepDir, 'after', 'src', 'New.cs'), '// added by step')
                fs.writeFileSync(path.join(stepDir, 'metadata.json'), JSON.stringify({ filesAdded: ['src/New.cs'] }))
            })

            // Returns `anyFailed`; false means the apply succeeded with no failures.
            const result = await (handler as any).downloadCompletedStepArtifacts('ws-1', JOB_ID, solutionRoot, plan)

            expect(result).to.be.false
            expect(fs.existsSync(path.join(solutionRoot, 'src', 'New.cs'))).to.be.true
            const appliedPath = path.join(checkpointsDir, 'checkpoints-applied.json')
            expect(JSON.parse(fs.readFileSync(appliedPath, 'utf-8')).appliedSteps).to.include('g1')
            const manifest = JSON.parse(fs.readFileSync(path.join(checkpointsDir, 'source-files.json'), 'utf-8'))
            expect(manifest.lastAppliedTimestamp).to.be.greaterThan(1)
            expect(manifest.sourceFiles).to.include(path.join(solutionRoot, 'src/New.cs'))
            // (the block's afterEach restores the stub)
        })

        it('filesAdded: preserves a user-modified file at the add target instead of overwriting', async () => {
            const relPath = 'ProjA/Added.cs'
            const dest = path.join(solutionRoot, relPath)
            fs.mkdirSync(path.dirname(dest), { recursive: true })
            fs.writeFileSync(dest, '// USER EDIT at add target')
            fs.mkdirSync(path.join(checkpointFolder, 'after', 'ProjA'), { recursive: true })
            fs.writeFileSync(path.join(checkpointFolder, 'after', relPath), '// agent add')
            writeMetadata({ filesAdded: [relPath] })

            const watermark = Date.now() - 10_000
            seedManifest([relPath], watermark)
            touchAfter(dest, watermark)

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot, JOB_ID)

            expect(result.success).to.be.true
            expect(result.filesAdded).to.equal(0)
            expect(fs.readFileSync(dest, 'utf-8')).to.equal('// USER EDIT at add target')
            expect(result.conflictedFiles).to.include(path.resolve(dest))
        })

        it('overwrites a user-edited file when the incoming size differs (filesEqual size short-circuit)', async () => {
            // Same-mtime "edited" flag, but content differs in LENGTH — exercises the
            // size-mismatch arm of filesEqual (returns false fast, so the file is a conflict).
            const relPath = 'ProjA/Diff.cs'
            const dest = path.join(solutionRoot, relPath)
            fs.mkdirSync(path.dirname(dest), { recursive: true })
            fs.writeFileSync(dest, '// short')
            fs.mkdirSync(path.join(checkpointFolder, 'after', 'ProjA'), { recursive: true })
            fs.writeFileSync(path.join(checkpointFolder, 'after', relPath), '// a much longer agent version body')
            writeMetadata({ filesUpdated: [relPath] })

            const watermark = Date.now() - 10_000
            seedManifest([relPath], watermark)
            touchAfter(dest, watermark)

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot, JOB_ID)

            expect(result.success).to.be.true
            // Different size => not equal => preserved as a conflict (not overwritten).
            expect(result.filesUpdated).to.equal(0)
            expect(fs.readFileSync(dest, 'utf-8')).to.equal('// short')
            expect(result.conflictedFiles).to.include(path.resolve(dest))
        })

        it('still preserves the customer file when the backup copy fails', async () => {
            // Force backupConflictedFile to throw; the customer edit must still be kept
            // (the catch logs and falls through to push the conflict + return true).
            const relPath = 'ProjA/BackupFails.cs'
            const dest = path.join(solutionRoot, relPath)
            fs.mkdirSync(path.dirname(dest), { recursive: true })
            fs.writeFileSync(dest, '// USER EDIT')
            fs.mkdirSync(path.join(checkpointFolder, 'after', 'ProjA'), { recursive: true })
            fs.writeFileSync(path.join(checkpointFolder, 'after', relPath), '// agent version')
            writeMetadata({ filesUpdated: [relPath] })

            const watermark = Date.now() - 10_000
            seedManifest([relPath], watermark)
            touchAfter(dest, watermark)

            const backupStub = sinon.stub(handler as any, 'backupConflictedFile').throws(new Error('disk full'))
            try {
                const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot, JOB_ID)

                expect(result.success).to.be.true
                expect(result.filesUpdated).to.equal(0)
                expect(fs.readFileSync(dest, 'utf-8')).to.equal('// USER EDIT') // preserved despite backup failure
                expect(result.conflictedFiles).to.include(path.resolve(dest))
            } finally {
                backupStub.restore()
            }
        })

        it('creates missing nested destination directories when updating an untouched file', async () => {
            // Dest dir does not exist yet -> exercises the mkdirSync branch in filesUpdated.
            const relPath = 'Deep/Nested/New.cs'
            fs.mkdirSync(path.join(checkpointFolder, 'after', 'Deep', 'Nested'), { recursive: true })
            fs.writeFileSync(path.join(checkpointFolder, 'after', relPath), '// fresh')
            writeMetadata({ filesUpdated: [relPath] })

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot, JOB_ID)

            expect(result.success).to.be.true
            expect(result.filesUpdated).to.equal(1)
            expect(fs.readFileSync(path.join(solutionRoot, relPath), 'utf-8')).to.equal('// fresh')
        })

        it('logs and continues when a single updated file errors (per-file catch)', async () => {
            // One updated file is missing from after/, so its copy throws and is caught;
            // the sibling file still applies. Exercises the filesUpdated catch arm.
            const good = 'Good.cs'
            const bad = 'Bad.cs'
            fs.writeFileSync(path.join(checkpointFolder, 'after', good), '// good')
            // 'after/Bad.cs' intentionally NOT created -> copyFileSync throws for it.
            writeMetadata({ filesUpdated: [bad, good] })

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot)

            expect(result.success).to.be.true
            expect(result.filesUpdated).to.equal(1)
            expect(fs.readFileSync(path.join(solutionRoot, good), 'utf-8')).to.equal('// good')
        })

        it('does NOT preserve a brand-new add target that does not exist yet (guard: dest absent)', async () => {
            // The modified-set is non-empty (some other file edited), and this added file
            // is in it, but the dest does not exist on disk yet -> shouldPreserveUserFile
            // returns false at the existsSync guard and the add proceeds normally.
            const relPath = 'ProjA/FreshAdd.cs'
            fs.mkdirSync(path.join(checkpointFolder, 'after', 'ProjA'), { recursive: true })
            fs.writeFileSync(path.join(checkpointFolder, 'after', relPath), '// agent add')
            writeMetadata({ filesAdded: [relPath] })

            // Manifest lists this path as a "source file", but since it doesn't exist on disk
            // it can't have an mtime past the watermark -> set stays effectively without it.
            const watermark = Date.now() - 10_000
            seedManifest(['ProjA/Other.cs'], watermark)
            const other = path.join(solutionRoot, 'ProjA/Other.cs')
            fs.mkdirSync(path.dirname(other), { recursive: true })
            fs.writeFileSync(other, '// other')
            touchAfter(other, watermark)

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot, JOB_ID)

            expect(result.success).to.be.true
            expect(result.filesAdded).to.equal(1)
            expect(fs.readFileSync(path.join(solutionRoot, relPath), 'utf-8')).to.equal('// agent add')
        })

        it('filesAdded: logs and continues when an add errors (per-file catch)', async () => {
            const bad = 'NoSource.cs'
            // 'after/NoSource.cs' intentionally missing -> copyFileSync throws, caught per-file.
            writeMetadata({ filesAdded: [bad] })

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot)

            expect(result.success).to.be.true
            expect(result.filesAdded).to.equal(0)
        })

        it('overwrites when another file was edited but THIS dest is not in the modified set', async () => {
            // modified-set is non-empty (Other.cs edited), this updated file exists on disk,
            // but is not itself in the set -> shouldPreserveUserFile returns false at the
            // `userModifiedFiles.has(dest)` guard and the overwrite proceeds.
            const relPath = 'ProjA/NotInSet.cs'
            const dest = path.join(solutionRoot, relPath)
            fs.mkdirSync(path.dirname(dest), { recursive: true })
            fs.writeFileSync(dest, '// old')
            fs.mkdirSync(path.join(checkpointFolder, 'after', 'ProjA'), { recursive: true })
            fs.writeFileSync(path.join(checkpointFolder, 'after', relPath), '// new')
            writeMetadata({ filesUpdated: [relPath] })

            const watermark = Date.now() - 10_000
            // Seed + touch a DIFFERENT file so the modified set is non-empty but excludes dest.
            const other = path.join(solutionRoot, 'ProjA/Other.cs')
            fs.writeFileSync(other, '// other')
            seedManifest(['ProjA/Other.cs'], watermark)
            touchAfter(other, watermark)

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot, JOB_ID)

            expect(result.success).to.be.true
            expect(result.filesUpdated).to.equal(1)
            expect(fs.readFileSync(dest, 'utf-8')).to.equal('// new')
            expect(result.conflictedFiles).to.be.undefined
        })

        it('filesEqual treats a read failure as not-equal (conservative)', async () => {
            // Two same-size files so the size check passes, but force readFileSync to throw
            // -> the catch returns false (treated as different => preserved as a conflict).
            const relPath = 'ProjA/ReadFail.cs'
            const dest = path.join(solutionRoot, relPath)
            fs.mkdirSync(path.dirname(dest), { recursive: true })
            fs.writeFileSync(dest, 'AAAA')
            fs.mkdirSync(path.join(checkpointFolder, 'after', 'ProjA'), { recursive: true })
            fs.writeFileSync(path.join(checkpointFolder, 'after', relPath), 'BBBB') // same size, diff bytes
            writeMetadata({ filesUpdated: [relPath] })

            const watermark = Date.now() - 10_000
            seedManifest([relPath], watermark)
            touchAfter(dest, watermark)

            // Throw only when filesEqual reads the conflict file's bytes; pass through for
            // metadata.json and everything else so the rest of applyChanges works normally.
            const realRead = fs.readFileSync
            const readStub = sinon.stub(fs, 'readFileSync').callsFake((p: any, ...rest: any[]) => {
                if (typeof p === 'string' && p.endsWith(path.join('ProjA', 'ReadFail.cs'))) {
                    throw new Error('EIO')
                }
                return (realRead as any)(p, ...rest)
            })
            try {
                const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot, JOB_ID)
                expect(result.success).to.be.true
                // read failed -> filesEqual false -> conflict -> preserved, not overwritten
                expect(result.filesUpdated).to.equal(0)
                expect(result.conflictedFiles).to.include(path.resolve(dest))
            } finally {
                readStub.restore()
            }
        })

        it('filesMoved: logs and continues when a move errors (per-file catch)', async () => {
            // before exists so we enter the copy branch, but make the copy throw by removing
            // read perms is unreliable cross-platform; instead point after at an un-creatable
            // path (a file occupies the parent dir slot) to force copyFileSync to throw.
            const beforeRel = 'mv-before.cs'
            fs.writeFileSync(path.join(solutionRoot, beforeRel), '// content')
            // Create a FILE named 'blocker' so 'blocker/After.cs' cannot be created as a dir.
            fs.writeFileSync(path.join(solutionRoot, 'blocker'), 'x')
            writeMetadata({ movedFilesMap: [{ before: beforeRel, after: 'blocker/After.cs' }] })

            const result = await (handler as any).applyChanges(checkpointFolder, solutionRoot)

            expect(result.success).to.be.true
            expect(result.filesMoved).to.equal(0)
            // before file is untouched because the move threw before unlink
            expect(fs.existsSync(path.join(solutionRoot, beforeRel))).to.be.true
        })
    })
})

describe('ATXTransformHandler - setCheckpoints, getHitlAgentArtifact, getJobDashboard', () => {
    let handler: ATXTransformHandler
    let serviceManager: AtxTokenServiceManager
    let workspace: Workspace
    let logging: Logging
    let runtime: Runtime
    let tmpRoot: string

    beforeEach(() => {
        serviceManager = sinon.createStubInstance(AtxTokenServiceManager) as any
        workspace = {} as Workspace
        logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub() } as any
        runtime = {} as Runtime

        handler = new ATXTransformHandler(serviceManager, workspace, logging, runtime)
        sinon.stub(handler as any, 'initializeAtxClient').resolves(true)
        ;(handler as any).atxClient = { send: sinon.stub() }

        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atx-batch-'))
    })

    afterEach(() => {
        sinon.restore()
        try {
            fs.rmSync(tmpRoot, { recursive: true, force: true })
        } catch {
            // best effort
        }
    })

    describe('setCheckpoints', () => {
        it('should return error when no checkpoint-settings HITL is found', async () => {
            sinon.stub(handler as any, 'findCheckpointSettingsHitl').resolves(null)

            const result = await handler.setCheckpoints('ws-1', 'job-1', tmpRoot, {})

            expect(result.Success).to.be.false
            expect(result.Error).to.equal('No HITL task found with checkpoint-settings tag')
        })

        it('should return error when client cannot be initialized', async () => {
            sinon.restore()
            logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub() } as any
            handler = new ATXTransformHandler(serviceManager, workspace, logging, runtime)
            sinon.stub(handler as any, 'initializeAtxClient').resolves(false)
            ;(handler as any).atxClient = null

            const result = await handler.setCheckpoints('ws-1', 'job-1', tmpRoot, {})

            expect(result.Success).to.be.false
            expect(result.Error).to.equal('ATX FES client not initialized')
        })

        it('should write checkpoint-settings.json with mapped interactive_mode and succeed', async () => {
            sinon.stub(handler as any, 'findCheckpointSettingsHitl').resolves({ taskId: 't1' })
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadUrl: 'u',
                uploadId: 'upload-1',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true } as any)
            sinon.stub(handler, 'updateHitl').resolves({ ok: true })

            const result = await handler.setCheckpoints(
                'ws-1',
                'job-1',
                tmpRoot,
                { 'step-a': true, 'step-b': false },
                'Interactive'
            )

            expect(result.Success).to.be.true
            const settingsPath = path.join(
                tmpRoot,
                workspaceFolderName,
                'job-1',
                'checkpoints',
                'checkpoint-settings.json'
            )
            expect(fs.existsSync(settingsPath)).to.be.true
            const written = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
            expect(written['step-a']).to.equal(true)
            expect(written.interactive_mode).to.equal('interactive')
        })

        it('should map Autonomous mode to "auto"', async () => {
            sinon.stub(handler as any, 'findCheckpointSettingsHitl').resolves({ taskId: 't1' })
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadUrl: 'u',
                uploadId: 'upload-1',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true } as any)
            sinon.stub(handler, 'updateHitl').resolves({ ok: true })

            await handler.setCheckpoints('ws-1', 'job-1', tmpRoot, {}, 'Autonomous')

            const settingsPath = path.join(
                tmpRoot,
                workspaceFolderName,
                'job-1',
                'checkpoints',
                'checkpoint-settings.json'
            )
            const written = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
            expect(written.interactive_mode).to.equal('auto')
        })

        it('should return error when uploadArtifact fails', async () => {
            sinon.stub(handler as any, 'findCheckpointSettingsHitl').resolves({ taskId: 't1' })
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadUrl: 'u',
                uploadId: 'upload-1',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(false)

            const result = await handler.setCheckpoints('ws-1', 'job-1', tmpRoot, {})

            expect(result.Success).to.be.false
            expect(result.Error).to.equal('Failed to upload checkpoints artifact to S3')
        })

        it('should return error when updateHitl fails', async () => {
            sinon.stub(handler as any, 'findCheckpointSettingsHitl').resolves({ taskId: 't1' })
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadUrl: 'u',
                uploadId: 'upload-1',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true } as any)
            sinon.stub(handler, 'updateHitl').resolves(null)

            const result = await handler.setCheckpoints('ws-1', 'job-1', tmpRoot, {})

            expect(result.Success).to.be.false
            expect(result.Error).to.equal('Failed to update HITL task with checkpoints artifact')
        })
    })

    describe('getHitlAgentArtifact', () => {
        it('should return null when listHitls returns empty', async () => {
            sinon.stub(handler, 'listHitls').resolves([])

            const result = await handler.getHitlAgentArtifact('ws-1', 'job-1', tmpRoot)

            expect(result).to.be.null
        })

        it('should return null when listHitls returns null', async () => {
            sinon.stub(handler, 'listHitls').resolves(null)

            const result = await handler.getHitlAgentArtifact('ws-1', 'job-1', tmpRoot)

            expect(result).to.be.null
        })

        it('should return tag and taskId early for local-build-verification HITL (no download)', async () => {
            sinon.stub(handler, 'listHitls').resolves([{ tag: 'local-build-verification', taskId: 'task-lbv' }])
            const downloadStub = sinon.stub(handler, 'createArtifactDownloadUrl')

            const result = await handler.getHitlAgentArtifact('ws-1', 'job-1', tmpRoot)

            expect(result).to.deep.equal({ HitlTag: 'local-build-verification', TaskId: 'task-lbv' })
            expect(downloadStub.called).to.be.false
            expect((handler as any).cachedHitl).to.equal('task-lbv')
        })

        it('should return tag and taskId when HITL has no agentArtifact', async () => {
            sinon.stub(handler, 'listHitls').resolves([{ tag: 'some-tag', taskId: 'task-1' /* no agentArtifact */ }])

            const result = await handler.getHitlAgentArtifact('ws-1', 'job-1', tmpRoot)

            expect(result?.HitlTag).to.equal('some-tag')
            expect(result?.TaskId).to.equal('task-1')
        })

        it('should pick local-build-verification over other HITL tags when both present', async () => {
            sinon.stub(handler, 'listHitls').resolves([
                { tag: 'missing-packages', taskId: 'task-mp' },
                { tag: 'local-build-verification', taskId: 'task-lbv' },
            ])

            const result = await handler.getHitlAgentArtifact('ws-1', 'job-1', tmpRoot)

            expect(result?.HitlTag).to.equal('local-build-verification')
            expect(result?.TaskId).to.equal('task-lbv')
        })

        it('should return guardrail tag/taskId when download URL fails', async () => {
            sinon.stub(handler, 'listHitls').resolves([
                {
                    tag: 'plan-review',
                    taskId: 'task-1',
                    agentArtifact: { artifactId: 'art-1' },
                },
            ])
            sinon.stub(handler, 'createArtifactDownloadUrl').resolves(null)

            const result = await handler.getHitlAgentArtifact('ws-1', 'job-1', tmpRoot)

            expect(result?.HitlTag).to.equal('plan-review')
            expect(result?.TaskId).to.equal('task-1')
        })
    })

    describe('getJobDashboard', () => {
        it('should throw and return null when client cannot initialize', async () => {
            sinon.restore()
            logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub() } as any
            handler = new ATXTransformHandler(serviceManager, workspace, logging, runtime)
            sinon.stub(handler as any, 'initializeAtxClient').resolves(false)
            ;(handler as any).atxClient = null

            const result = await handler.getJobDashboard('ws-1', 'job-1')

            expect(result).to.be.null
            expect((logging.error as sinon.SinonStub).called).to.be.true
        })

        it('should return null when no DASHBOARD HITL task exists', async () => {
            const sendStub = (handler as any).atxClient.send as sinon.SinonStub
            sendStub.resolves({ hitlTasks: [] })

            const result = await handler.getJobDashboard('ws-1', 'job-1')

            expect(result).to.be.null
        })

        it('should return null when DASHBOARD task has no agent artifact', async () => {
            const sendStub = (handler as any).atxClient.send as sinon.SinonStub
            sendStub.resolves({ hitlTasks: [{ taskId: 't1' /* no agentArtifact */ }] })

            const result = await handler.getJobDashboard('ws-1', 'job-1')

            expect(result).to.be.null
        })

        it('should return null on send error (caught and logged)', async () => {
            const sendStub = (handler as any).atxClient.send as sinon.SinonStub
            sendStub.rejects(new Error('AWS SDK failure'))

            const result = await handler.getJobDashboard('ws-1', 'job-1')

            expect(result).to.be.null
            expect((logging.error as sinon.SinonStub).called).to.be.true
        })
    })
})

describe('ATXTransformHandler - lifecycle (startTransform & helpers)', () => {
    let handler: ATXTransformHandler
    let serviceManager: AtxTokenServiceManager
    let workspace: Workspace
    let logging: Logging
    let runtime: Runtime
    let sendStub: sinon.SinonStub

    beforeEach(() => {
        serviceManager = sinon.createStubInstance(AtxTokenServiceManager) as any
        workspace = {} as Workspace
        logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub() } as any
        runtime = {} as Runtime

        handler = new ATXTransformHandler(serviceManager, workspace, logging, runtime)
        sendStub = sinon.stub()
        sinon.stub(handler as any, 'initializeAtxClient').resolves(true)
        sinon.stub(handler as any, 'addAuthToCommand').resolves()
        ;(handler as any).atxClient = { send: sendStub }
    })

    afterEach(() => {
        sinon.restore()
    })

    describe('createJob', () => {
        it('should return jobId/status on success', async () => {
            sendStub.resolves({ jobId: 'job-123', status: 'CREATED' })

            const result = await handler.createJob({ workspaceId: 'ws-1' })

            expect(result).to.deep.equal({ jobId: 'job-123', status: 'CREATED' })
        })

        it('should return null when response missing jobId', async () => {
            sendStub.resolves({ status: 'CREATED' /* no jobId */ })

            const result = await handler.createJob({ workspaceId: 'ws-1' })

            expect(result).to.be.null
            expect((logging.error as sinon.SinonStub).called).to.be.true
        })

        it('should return null and log error when send rejects', async () => {
            sendStub.rejects(new Error('AWS down'))

            const result = await handler.createJob({ workspaceId: 'ws-1' })

            expect(result).to.be.null
            expect((logging.error as sinon.SinonStub).called).to.be.true
        })

        it('should map Interactive interactive_mode to "interactive" in objective', async () => {
            sendStub.resolves({ jobId: 'j', status: 'CREATED' })

            await handler.createJob({ workspaceId: 'ws-1', interactiveMode: 'Interactive' })

            const command = sendStub.firstCall.args[0]
            const objective = JSON.parse(command.input.objective)
            expect(objective.interactive_mode).to.equal('interactive')
        })

        it('should default interactive_mode to "auto" when mode not specified', async () => {
            sendStub.resolves({ jobId: 'j', status: 'CREATED' })

            await handler.createJob({ workspaceId: 'ws-1' })

            const command = sendStub.firstCall.args[0]
            const objective = JSON.parse(command.input.objective)
            expect(objective.interactive_mode).to.equal('auto')
        })
    })

    describe('createArtifactUploadUrl', () => {
        it('should return uploadId/uploadUrl on success', async () => {
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'getSha256Async').resolves('abc-sha256')
            sendStub.resolves({
                artifactId: 'art-1',
                s3PreSignedUrl: 'https://s3/upload',
                requestHeaders: { 'x-foo': 'bar' },
            })

            const result = await handler.createArtifactUploadUrl(
                'ws-1',
                'job-1',
                'C:/file.zip',
                'CUSTOMER_INPUT' as any,
                'ZIP' as any
            )

            expect(result?.uploadId).to.equal('art-1')
            expect(result?.uploadUrl).to.equal('https://s3/upload')
            expect(result?.requestHeaders).to.deep.equal({ 'x-foo': 'bar' })
        })

        it('should return null when response missing required fields', async () => {
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'getSha256Async').resolves('sha')
            sendStub.resolves({ artifactId: 'art-1' /* no s3PreSignedUrl */ })

            const result = await handler.createArtifactUploadUrl(
                'ws-1',
                'job-1',
                'C:/file.zip',
                'CUSTOMER_INPUT' as any,
                'ZIP' as any
            )

            expect(result).to.be.null
            expect((logging.error as sinon.SinonStub).called).to.be.true
        })

        it('should return null and log on send error', async () => {
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'getSha256Async').resolves('sha')
            sendStub.rejects(new Error('boom'))

            const result = await handler.createArtifactUploadUrl(
                'ws-1',
                'job-1',
                'C:/file.zip',
                'CUSTOMER_INPUT' as any,
                'ZIP' as any
            )

            expect(result).to.be.null
        })
    })

    describe('completeArtifactUpload', () => {
        it('should return success=true on resolve', async () => {
            sendStub.resolves({
                /* server response */
            })

            const result = await handler.completeArtifactUpload('ws-1', 'job-1', 'art-1')

            expect(result).to.deep.equal({ success: true })
        })

        it('should return null on send error', async () => {
            sendStub.rejects(new Error('boom'))

            const result = await handler.completeArtifactUpload('ws-1', 'job-1', 'art-1')

            expect(result).to.be.null
            expect((logging.error as sinon.SinonStub).called).to.be.true
        })
    })

    describe('startJob', () => {
        it('should return success=true on resolve', async () => {
            sendStub.resolves({
                /* aws ack */
            })

            const result = await handler.startJob('ws-1', 'job-1')

            expect(result).to.deep.equal({ success: true })
        })

        it('should return null on send error', async () => {
            sendStub.rejects(new Error('boom'))

            const result = await handler.startJob('ws-1', 'job-1')

            expect(result).to.be.null
            expect((logging.error as sinon.SinonStub).called).to.be.true
        })
    })

    describe('startTransform', () => {
        it('should return null when createJob returns null', async () => {
            sinon.stub(handler, 'createJob').resolves(null)

            const result = await handler.startTransform({
                workspaceId: 'ws-1',
                startTransformRequest: { TargetFramework: 'net8.0' },
            })

            expect(result).to.be.null
        })

        it('should return null when createZip throws', async () => {
            sinon.stub(handler, 'createJob').resolves({ jobId: 'job-1', status: 'CREATED' })
            sinon.stub(handler, 'createZip').rejects(new Error('zip fail'))

            const result = await handler.startTransform({
                workspaceId: 'ws-1',
                startTransformRequest: {},
            })

            expect(result).to.be.null
            expect((logging.error as sinon.SinonStub).called).to.be.true
        })

        it('should return null when createArtifactUploadUrl returns null', async () => {
            sinon.stub(handler, 'createJob').resolves({ jobId: 'job-1', status: 'CREATED' })
            sinon.stub(handler, 'createZip').resolves('C:/zip.zip')
            sinon.stub(handler, 'createArtifactUploadUrl').resolves(null)

            const result = await handler.startTransform({
                workspaceId: 'ws-1',
                startTransformRequest: {},
            })

            expect(result).to.be.null
        })

        it('should return null when uploadArtifact returns false', async () => {
            sinon.stub(handler, 'createJob').resolves({ jobId: 'job-1', status: 'CREATED' })
            sinon.stub(handler, 'createZip').resolves('C:/zip.zip')
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadId: 'u',
                uploadUrl: 'https://s3',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(false)

            const result = await handler.startTransform({
                workspaceId: 'ws-1',
                startTransformRequest: {},
            })

            expect(result).to.be.null
        })

        it('should return null when completeArtifactUpload returns null', async () => {
            sinon.stub(handler, 'createJob').resolves({ jobId: 'job-1', status: 'CREATED' })
            sinon.stub(handler, 'createZip').resolves('C:/zip.zip')
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadId: 'u',
                uploadUrl: 'https://s3',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves(null)

            const result = await handler.startTransform({
                workspaceId: 'ws-1',
                startTransformRequest: {},
            })

            expect(result).to.be.null
        })

        it('should return null when startJob returns null', async () => {
            sinon.stub(handler, 'createJob').resolves({ jobId: 'job-1', status: 'CREATED' })
            sinon.stub(handler, 'createZip').resolves('C:/zip.zip')
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadId: 'u',
                uploadUrl: 'https://s3',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true })
            sinon.stub(handler, 'startJob').resolves(null)

            const result = await handler.startTransform({
                workspaceId: 'ws-1',
                startTransformRequest: {},
            })

            expect(result).to.be.null
        })

        it('should return TransformationJobId on full happy path', async () => {
            sinon.stub(handler, 'createJob').resolves({ jobId: 'job-1', status: 'CREATED' })
            sinon.stub(handler, 'createZip').resolves('C:/zip.zip')
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadId: 'upload-1',
                uploadUrl: 'https://s3',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true })
            sinon.stub(handler, 'startJob').resolves({ success: true })

            const result = await handler.startTransform({
                workspaceId: 'ws-1',
                startTransformRequest: {},
            })

            expect(result?.TransformationJobId).to.equal('job-1')
            expect(result?.ArtifactPath).to.equal('C:/zip.zip')
            expect(result?.UploadId).to.equal('upload-1')
        })

        it('should cache interactive mode from request', async () => {
            sinon.stub(handler, 'createJob').resolves({ jobId: 'job-1', status: 'CREATED' })
            sinon.stub(handler, 'createZip').resolves('C:/zip.zip')
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadId: 'u',
                uploadUrl: 'https://s3',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true })
            sinon.stub(handler, 'startJob').resolves({ success: true })

            await handler.startTransform({
                workspaceId: 'ws-1',
                interactiveMode: 'Interactive',
                startTransformRequest: {},
            })

            expect((handler as any).cachedInteractiveMode).to.equal('Interactive')
        })

        it('should default cached interactive mode to Autonomous when not specified', async () => {
            sinon.stub(handler, 'createJob').resolves({ jobId: 'job-1', status: 'CREATED' })
            sinon.stub(handler, 'createZip').resolves('C:/zip.zip')
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadId: 'u',
                uploadUrl: 'https://s3',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true })
            sinon.stub(handler, 'startJob').resolves({ success: true })

            await handler.startTransform({
                workspaceId: 'ws-1',
                startTransformRequest: {},
            })

            expect((handler as any).cachedInteractiveMode).to.equal('Autonomous')
        })
    })
})

describe('ATXTransformHandler - workspace, job, artifact, HITL helpers', () => {
    let handler: ATXTransformHandler
    let serviceManager: any
    let workspace: Workspace
    let logging: Logging
    let runtime: Runtime
    let sendStub: sinon.SinonStub

    beforeEach(() => {
        serviceManager = sinon.createStubInstance(AtxTokenServiceManager) as any
        // Stub the methods getActiveTransformProfileApplicationUrl etc. depend on
        serviceManager.getActiveApplicationUrl = sinon.stub().returns('https://app.example.com')
        serviceManager.getBearerToken = sinon.stub().resolves('token')
        workspace = {} as Workspace
        logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub() } as any
        runtime = {} as Runtime

        handler = new ATXTransformHandler(serviceManager, workspace, logging, runtime)
        sendStub = sinon.stub()
        sinon.stub(handler as any, 'initializeAtxClient').resolves(true)
        sinon.stub(handler as any, 'addAuthToCommand').resolves()
        ;(handler as any).atxClient = { send: sendStub }
    })

    afterEach(() => {
        sinon.restore()
    })

    describe('getActiveTransformProfileApplicationUrl', () => {
        it('should return the cached application URL', async () => {
            const result = await handler.getActiveTransformProfileApplicationUrl()
            expect(result).to.equal('https://app.example.com')
        })

        it('should return null and log error when no URL cached', async () => {
            serviceManager.getActiveApplicationUrl = sinon.stub().returns(null)

            const result = await handler.getActiveTransformProfileApplicationUrl()

            expect(result).to.be.null
            expect((logging.error as sinon.SinonStub).called).to.be.true
        })
    })

    describe('onProfileUpdate', () => {
        it('should null-out the cached atxClient', () => {
            ;(handler as any).atxClient = { send: () => null }
            handler.onProfileUpdate()
            expect((handler as any).atxClient).to.be.null
        })
    })

    describe('listWorkspaces', () => {
        it('should map workspace items to PascalCase response shape', async () => {
            sendStub.resolves({
                items: [
                    { id: 'ws-1', name: 'One', description: 'first' },
                    { id: 'ws-2', name: 'Two', description: 'second' },
                ],
            })

            const result = await handler.listWorkspaces()

            expect(result.workspaces).to.have.lengthOf(2)
            expect(result.workspaces[0]).to.include({ Id: 'ws-1', Name: 'One', Description: 'first' })
            expect(result.applicationUrl).to.equal('https://app.example.com')
        })

        it('should return empty workspaces and null URL on send error', async () => {
            sendStub.rejects(new Error('boom'))

            const result = await handler.listWorkspaces()

            expect(result.workspaces).to.deep.equal([])
            expect(result.applicationUrl).to.be.null
        })

        it('should handle missing items array gracefully', async () => {
            sendStub.resolves({
                /* no items */
            })

            const result = await handler.listWorkspaces()

            expect(result.workspaces).to.deep.equal([])
        })
    })

    describe('createWorkspace', () => {
        it('should return workspace info on success', async () => {
            sendStub.resolves({ workspace: { id: 'ws-9', name: 'New' } })

            const result = await handler.createWorkspace('New', 'desc')

            expect(result).to.deep.equal({ workspaceId: 'ws-9', workspaceName: 'New' })
        })

        it('should return null when response missing workspace fields', async () => {
            sendStub.resolves({ workspace: { id: 'ws-9' /* no name */ } })

            const result = await handler.createWorkspace('New')

            expect(result).to.be.null
        })

        it('should return null on send error', async () => {
            sendStub.rejects(new Error('boom'))

            const result = await handler.createWorkspace(null)

            expect(result).to.be.null
        })

        it('should auto-generate description when name is provided without description', async () => {
            sendStub.resolves({ workspace: { id: 'ws-9', name: 'New' } })

            await handler.createWorkspace('MyWorkspace')

            const command = sendStub.firstCall.args[0]
            expect(command.input.description).to.include('MyWorkspace')
        })
    })

    describe('listJobs', () => {
        it('should paginate and aggregate jobs from multiple pages', async () => {
            sendStub.onFirstCall().resolves({
                jobList: [{ jobInfo: { jobId: 'j1', statusDetails: { status: 'COMPLETED' } } }],
                nextToken: 'page-2',
            })
            sendStub.onSecondCall().resolves({
                jobList: [{ jobInfo: { jobId: 'j2', statusDetails: { status: 'EXECUTING' } } }],
                nextToken: undefined,
            })

            const result = await handler.listJobs('ws-1')

            expect(result?.Jobs).to.have.lengthOf(2)
            expect(result?.Jobs[0].JobId).to.equal('j1')
            expect(result?.Jobs[1].Status).to.equal('EXECUTING')
        })

        it('should return null on send error', async () => {
            sendStub.rejects(new Error('boom'))

            const result = await handler.listJobs('ws-1')

            expect(result).to.be.null
        })

        it('should default Status to UNKNOWN when missing in response', async () => {
            sendStub.resolves({
                jobList: [{ jobInfo: { jobId: 'j1' /* no statusDetails */ } }],
            })

            const result = await handler.listJobs('ws-1')

            expect(result?.Jobs[0].Status).to.equal('UNKNOWN')
        })
    })

    describe('listOrCreateWorkspace', () => {
        it('should return AvailableWorkspaces when CreateWorkspaceName not provided', async () => {
            sinon.stub(handler, 'listWorkspaces').resolves({
                workspaces: [{ Id: 'ws-1', Name: 'One' }],
                applicationUrl: 'u',
            })
            const createStub = sinon.stub(handler, 'createWorkspace')

            const result = await handler.listOrCreateWorkspace({} as any)

            expect(result?.AvailableWorkspaces).to.have.lengthOf(1)
            expect(result?.CreatedWorkspace).to.be.undefined
            expect(createStub.called).to.be.false
        })

        it('should create workspace and append it to AvailableWorkspaces when name is provided', async () => {
            sinon.stub(handler, 'listWorkspaces').resolves({
                workspaces: [],
                applicationUrl: 'u',
            })
            sinon.stub(handler, 'createWorkspace').resolves({
                workspaceId: 'ws-new',
                workspaceName: 'Brand New',
            })

            const result = await handler.listOrCreateWorkspace({
                CreateWorkspaceName: 'Brand New',
                CreateWorkspaceDescription: 'desc',
            } as any)

            expect(result?.CreatedWorkspace).to.deep.equal({
                WorkspaceId: 'ws-new',
                WorkspaceName: 'Brand New',
            })
            expect(result?.AvailableWorkspaces).to.have.lengthOf(1)
            expect(result?.AvailableWorkspaces[0].Id).to.equal('ws-new')
        })

        it('should return null when verifySession fails', async () => {
            sinon.stub(handler as any, 'verifySession').resolves(false)

            const result = await handler.listOrCreateWorkspace({} as any)

            expect(result).to.be.null
        })
    })

    describe('getJob', () => {
        it('should return the job from response on success', async () => {
            sendStub.resolves({ job: { statusDetails: { status: 'COMPLETED' } } })

            const result = await handler.getJob('ws-1', 'job-1')

            expect(result?.statusDetails?.status).to.equal('COMPLETED')
        })

        it('should return null when response has no job', async () => {
            sendStub.resolves({})

            const result = await handler.getJob('ws-1', 'job-1')

            expect(result).to.be.null
        })

        it('should return null on send error', async () => {
            sendStub.rejects(new Error('boom'))

            const result = await handler.getJob('ws-1', 'job-1')

            expect(result).to.be.null
        })
    })

    describe('createArtifactDownloadUrl', () => {
        it('should return s3PresignedUrl and normalized headers on success', async () => {
            sendStub.resolves({
                s3PreSignedUrl: 'https://s3/dl',
                requestHeaders: { 'x-foo': ['bar'], 'x-baz': 'qux' },
            })

            const result = await handler.createArtifactDownloadUrl('ws-1', 'job-1', 'art-1')

            expect(result?.s3PresignedUrl).to.equal('https://s3/dl')
            expect(result?.requestHeaders).to.deep.equal({ 'x-foo': 'bar', 'x-baz': 'qux' })
        })

        it('should return null when s3PreSignedUrl missing', async () => {
            sendStub.resolves({
                /* no s3PreSignedUrl */
            })

            const result = await handler.createArtifactDownloadUrl('ws-1', 'job-1', 'art-1')

            expect(result).to.be.null
        })

        it('should return null on send error', async () => {
            sendStub.rejects(new Error('boom'))

            const result = await handler.createArtifactDownloadUrl('ws-1', 'job-1', 'art-1')

            expect(result).to.be.null
        })
    })

    describe('listHitls', () => {
        it('should return hitlTasks array on success', async () => {
            sendStub.resolves({ hitlTasks: [{ taskId: 't1' }] })

            const result = await handler.listHitls('ws-1', 'job-1')

            expect(result).to.have.lengthOf(1)
            expect(result?.[0].taskId).to.equal('t1')
        })

        it('should return empty array when hitlTasks is missing', async () => {
            sendStub.resolves({})

            const result = await handler.listHitls('ws-1', 'job-1')

            expect(result).to.deep.equal([])
        })

        it('should return null on send error', async () => {
            sendStub.rejects(new Error('boom'))

            const result = await handler.listHitls('ws-1', 'job-1')

            expect(result).to.be.null
        })
    })

    describe('submitHitl & updateHitl & getHitl', () => {
        it('submitHitl should return result on success', async () => {
            sendStub.resolves({ status: 'SUBMITTED' })
            const result = await handler.submitHitl('ws-1', 'job-1', 't1', 'art-1')
            expect(result?.status).to.equal('SUBMITTED')
        })

        it('submitHitl should return null on send error', async () => {
            sendStub.rejects(new Error('boom'))
            expect(await handler.submitHitl('ws-1', 'job-1', 't1', 'art-1')).to.be.null
        })

        it('updateHitl should return result on success', async () => {
            sendStub.resolves({ status: 'UPDATED' })
            const result = await handler.updateHitl('ws-1', 'job-1', 't1', 'art-1')
            expect(result?.status).to.equal('UPDATED')
        })

        it('updateHitl should return null on send error', async () => {
            sendStub.rejects(new Error('boom'))
            expect(await handler.updateHitl('ws-1', 'job-1', 't1', 'art-1')).to.be.null
        })

        it('getHitl should return task object on success', async () => {
            sendStub.resolves({ task: { status: 'CLOSED' } })
            const result = await handler.getHitl('ws-1', 'job-1', 't1')
            expect(result?.status).to.equal('CLOSED')
        })

        it('getHitl should return null when no task in response', async () => {
            sendStub.resolves({})
            expect(await handler.getHitl('ws-1', 'job-1', 't1')).to.be.null
        })
    })

    describe('stopJob', () => {
        it('should return status on success and clear job cache', async () => {
            sendStub.resolves({ status: 'STOPPING' })
            ;(handler as any).cachedHitl = 'h1'

            const result = await handler.stopJob('ws-1', 'job-1')

            expect(result).to.equal('STOPPING')
            expect((handler as any).cachedHitl).to.be.null
        })

        it('should return "FAILED" on send error', async () => {
            sendStub.rejects(new Error('boom'))

            const result = await handler.stopJob('ws-1', 'job-1')

            expect(result).to.equal('FAILED')
        })

        it('should default to "STOPPED" when response status is missing', async () => {
            sendStub.resolves({
                /* no status */
            })

            const result = await handler.stopJob('ws-1', 'job-1')

            expect(result).to.equal('STOPPED')
        })
    })

    describe('downloadFinalArtifact', () => {
        it('should return null when no artifacts available', async () => {
            sinon.stub(handler as any, 'listArtifacts').resolves([])

            const result = await handler.downloadFinalArtifact('ws-1', 'job-1', 'C:/sln')

            expect(result).to.be.null
        })

        it('should return null when listArtifacts returns null', async () => {
            sinon.stub(handler as any, 'listArtifacts').resolves(null)

            const result = await handler.downloadFinalArtifact('ws-1', 'job-1', 'C:/sln')

            expect(result).to.be.null
        })

        it('should return null when createArtifactDownloadUrl fails', async () => {
            sinon.stub(handler as any, 'listArtifacts').resolves([{ artifactId: 'art-1' }])
            sinon.stub(handler, 'createArtifactDownloadUrl').resolves(null)

            const result = await handler.downloadFinalArtifact('ws-1', 'job-1', 'C:/sln')

            expect(result).to.be.null
        })

        it('should return download path on full happy flow', async () => {
            sinon.stub(handler as any, 'listArtifacts').resolves([{ artifactId: 'art-1' }])
            sinon.stub(handler, 'createArtifactDownloadUrl').resolves({
                s3PresignedUrl: 'https://s3/dl',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'downloadAndExtractArchive').resolves(undefined)

            const result = await handler.downloadFinalArtifact('ws-1', 'job-1', 'C:/sln')

            expect(result).to.be.a('string')
            expect(result).to.include('job-1')
        })
    })

    describe('completeHitlWithBuildResults', () => {
        let tmpRoot: string

        beforeEach(() => {
            tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atx-hitlbuild-'))
        })

        afterEach(() => {
            try {
                fs.rmSync(tmpRoot, { recursive: true, force: true })
            } catch {
                // best effort
            }
        })

        it('should return error when createArtifactUploadUrl fails', async () => {
            sinon.stub(handler, 'createArtifactUploadUrl').resolves(null)

            const result = await handler.completeHitlWithBuildResults('ws-1', 'job-1', 't1', 'BUILD OK', tmpRoot)

            expect(result.Success).to.be.false
            expect(result.Error).to.equal('Failed to create artifact upload URL')
        })

        it('should return error when uploadArtifact fails', async () => {
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadUrl: 'u',
                uploadId: 'upload-1',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(false)

            const result = await handler.completeHitlWithBuildResults('ws-1', 'job-1', 't1', 'BUILD OK', tmpRoot)

            expect(result.Success).to.be.false
            expect(result.Error).to.equal('Failed to upload build results')
        })

        it('should return success on full happy path', async () => {
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadUrl: 'u',
                uploadId: 'upload-1',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true })
            sinon.stub(handler, 'submitHitl').resolves({ status: 'SUBMITTED' } as any)

            const result = await handler.completeHitlWithBuildResults('ws-1', 'job-1', 't1', 'BUILD OK', tmpRoot)

            expect(result.Success).to.be.true
        })

        it('should return error when submitHitl returns null', async () => {
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadUrl: 'u',
                uploadId: 'upload-1',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true })
            sinon.stub(handler, 'submitHitl').resolves(null)

            const result = await handler.completeHitlWithBuildResults('ws-1', 'job-1', 't1', 'BUILD OK', tmpRoot)

            expect(result.Success).to.be.false
            expect(result.Error).to.equal('Failed to submit HITL task')
        })
    })
})

describe('ATXTransformHandler - upload flows, polling, and small wrappers', () => {
    let handler: ATXTransformHandler
    let serviceManager: any
    let workspace: Workspace
    let logging: Logging
    let runtime: Runtime
    let sendStub: sinon.SinonStub

    beforeEach(() => {
        serviceManager = sinon.createStubInstance(AtxTokenServiceManager) as any
        serviceManager.getActiveApplicationUrl = sinon.stub().returns('https://app.example.com')
        workspace = {} as Workspace
        logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub() } as any
        runtime = {} as Runtime

        handler = new ATXTransformHandler(serviceManager, workspace, logging, runtime)
        sendStub = sinon.stub()
        sinon.stub(handler as any, 'initializeAtxClient').resolves(true)
        sinon.stub(handler as any, 'addAuthToCommand').resolves()
        ;(handler as any).atxClient = { send: sendStub }
    })

    afterEach(() => {
        sinon.restore()
    })

    describe('uploadCustomPlan', () => {
        it('should return Success=false when send returns missing fields', async () => {
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'getSha256Async').resolves('sha')
            sendStub.resolves({
                /* no artifactId / s3PreSignedUrl */
            })

            const result = await handler.uploadCustomPlan({
                WorkspaceId: 'ws-1',
                TransformationJobId: 'job-1',
                FilePath: 'C:/plan.json',
                Description: 'desc',
            } as any)

            expect(result.Success).to.be.false
        })

        it('should return Success=false when uploadArtifact fails', async () => {
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'getSha256Async').resolves('sha')
            sendStub.resolves({ artifactId: 'a', s3PreSignedUrl: 'u', requestHeaders: {} })
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(false)

            const result = await handler.uploadCustomPlan({
                WorkspaceId: 'ws-1',
                TransformationJobId: 'job-1',
                FilePath: 'C:/plan.json',
            } as any)

            expect(result.Success).to.be.false
        })

        it('should return Success=true with ArtifactId on full happy path', async () => {
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'getSha256Async').resolves('sha')
            sendStub.resolves({ artifactId: 'art-1', s3PreSignedUrl: 'u', requestHeaders: {} })
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true })

            const result = await handler.uploadCustomPlan({
                WorkspaceId: 'ws-1',
                TransformationJobId: 'job-1',
                FilePath: 'C:/plan.json',
            } as any)

            expect(result.Success).to.be.true
            expect(result.ArtifactId).to.equal('art-1')
        })

        it('should map common file extensions to FileType', async () => {
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'getSha256Async').resolves('sha')
            sendStub.resolves({ artifactId: 'a', s3PreSignedUrl: 'u', requestHeaders: {} })
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true })

            await handler.uploadCustomPlan({
                WorkspaceId: 'ws-1',
                TransformationJobId: 'job-1',
                FilePath: 'C:/plan.csv',
            } as any)

            const command = sendStub.firstCall.args[0]
            expect(command.input.artifactReference.artifactType.fileType).to.equal('CSV')
        })
    })

    describe('uploadPlan', () => {
        it('should return null when no cachedHitl', async () => {
            ;(handler as any).cachedHitl = null

            const result = await handler.uploadPlan({
                WorkspaceId: 'ws-1',
                TransformationJobId: 'job-1',
                PlanPath: 'C:/sln/plan.md',
            } as any)

            expect(result).to.be.null
            expect((logging.error as sinon.SinonStub).called).to.be.true
        })

        it('should return null when createArtifactUploadUrl fails', async () => {
            ;(handler as any).cachedHitl = 'task-1'
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'zipFile').resolves(undefined)
            sinon.stub(handler, 'createArtifactUploadUrl').resolves(null)

            const result = await handler.uploadPlan({
                WorkspaceId: 'ws-1',
                TransformationJobId: 'job-1',
                PlanPath: 'C:/sln/plan.md',
            } as any)

            expect(result).to.be.null
        })

        it('should return VerificationStatus=true on validation success', async () => {
            ;(handler as any).cachedHitl = 'task-1'
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'zipFile').resolves(undefined)
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadUrl: 'u',
                uploadId: 'up-1',
                requestHeaders: {},
            } as any)
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true })
            sinon.stub(handler, 'submitHitl').resolves({ status: 'SUBMITTED' } as any)
            sinon.stub(handler, 'pollHitlTask').resolves('Validation Success!')

            const result = await handler.uploadPlan({
                WorkspaceId: 'ws-1',
                TransformationJobId: 'job-1',
                PlanPath: 'C:/sln/plan.md',
            } as any)

            expect(result?.VerificationStatus).to.equal(true)
            expect(result?.Message).to.equal('Validation Success!')
        })

        it('should return VerificationStatus=false with retry artifact paths on validation failure', async () => {
            ;(handler as any).cachedHitl = 'task-1'
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'zipFile').resolves(undefined)
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadUrl: 'u',
                uploadId: 'up-1',
                requestHeaders: {},
            } as any)
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true })
            sinon.stub(handler, 'submitHitl').resolves({ status: 'SUBMITTED' } as any)
            sinon
                .stub(handler, 'pollHitlTask')
                .resolves('Submitted plan did not pass validation, please check the plan for details....')
            sinon.stub(handler, 'getHitlAgentArtifact').resolves({
                PlanPath: '/p',
                ReportPath: '/r',
            } as any)

            const result = await handler.uploadPlan({
                WorkspaceId: 'ws-1',
                TransformationJobId: 'job-1',
                PlanPath: 'C:/sln/plan.md',
            } as any)

            expect(result?.VerificationStatus).to.equal(false)
            expect(result?.PlanPath).to.equal('/p')
            expect(result?.ReportPath).to.equal('/r')
        })

        it('should return null when submitHitl fails', async () => {
            ;(handler as any).cachedHitl = 'task-1'
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'zipFile').resolves(undefined)
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadUrl: 'u',
                uploadId: 'up-1',
                requestHeaders: {},
            } as any)
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true })
            sinon.stub(handler, 'submitHitl').resolves(null)

            const result = await handler.uploadPlan({
                WorkspaceId: 'ws-1',
                TransformationJobId: 'job-1',
                PlanPath: 'C:/sln/plan.md',
            } as any)

            expect(result).to.be.null
        })
    })

    describe('uploadPackages', () => {
        it('should return Success=false when no cachedHitl', async () => {
            ;(handler as any).cachedHitl = null

            const result = await handler.uploadPackages({
                WorkspaceId: 'ws-1',
                TransformationJobId: 'job-1',
                PackagesZipPath: 'C:/pkg.zip',
            } as any)

            expect(result?.Success).to.be.false
            expect(result?.Message).to.equal('No cached HITL task')
        })

        it('should return Success=false when no PackagesZipPath provided', async () => {
            ;(handler as any).cachedHitl = 'task-1'

            const result = await handler.uploadPackages({
                WorkspaceId: 'ws-1',
                TransformationJobId: 'job-1',
            } as any)

            expect(result?.Success).to.be.false
            expect(result?.Message).to.match(/No Package/i)
        })

        it('should return Success=true on full happy path', async () => {
            ;(handler as any).cachedHitl = 'task-1'
            sinon.stub(handler as any, 'uploadArtifactAndComplete').resolves('artifact-1')
            sinon.stub(handler, 'submitHitl').resolves({ status: 'SUBMITTED' } as any)

            const result = await handler.uploadPackages({
                WorkspaceId: 'ws-1',
                TransformationJobId: 'job-1',
                PackagesZipPath: 'C:/pkg.zip',
            } as any)

            expect(result?.Success).to.be.true
        })

        it('should return Success=false when uploadArtifactAndComplete fails', async () => {
            ;(handler as any).cachedHitl = 'task-1'
            sinon.stub(handler as any, 'uploadArtifactAndComplete').resolves(null)

            const result = await handler.uploadPackages({
                WorkspaceId: 'ws-1',
                TransformationJobId: 'job-1',
                PackagesZipPath: 'C:/pkg.zip',
            } as any)

            expect(result?.Success).to.be.false
            expect(result?.Message).to.equal('Failed to upload packages')
        })

        it('should return Success=false when submitHitl fails after upload', async () => {
            ;(handler as any).cachedHitl = 'task-1'
            sinon.stub(handler as any, 'uploadArtifactAndComplete').resolves('artifact-1')
            sinon.stub(handler, 'submitHitl').resolves(null)

            const result = await handler.uploadPackages({
                WorkspaceId: 'ws-1',
                TransformationJobId: 'job-1',
                PackagesZipPath: 'C:/pkg.zip',
            } as any)

            expect(result?.Success).to.be.false
        })
    })

    describe('pollHitlTask', () => {
        it('should return success message when task transitions to CLOSED', async () => {
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'sleep').resolves(undefined)
            sinon.stub(handler, 'getHitl').resolves({ status: 'CLOSED' })

            const result = await handler.pollHitlTask('ws-1', 'job-1', 't1')

            expect(result).to.equal('Validation Success!')
        })

        it('should return validation-failed message on CLOSED_PENDING_NEXT_TASK', async () => {
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'sleep').resolves(undefined)
            sinon.stub(handler, 'getHitl').resolves({ status: 'CLOSED_PENDING_NEXT_TASK' })

            const result = await handler.pollHitlTask('ws-1', 'job-1', 't1')

            expect(result).to.equal('Submitted plan did not pass validation, please check the plan for details....')
        })

        it('should return timeout message on CANCELLED', async () => {
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'sleep').resolves(undefined)
            sinon.stub(handler, 'getHitl').resolves({ status: 'CANCELLED' })

            const result = await handler.pollHitlTask('ws-1', 'job-1', 't1')

            expect(result).to.equal('Timeout occured during planning, proceeding with default plan....')
        })

        it('should poll multiple times before transitioning to CLOSED', async () => {
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'sleep').resolves(undefined)
            const getHitlStub = sinon.stub(handler, 'getHitl')
            getHitlStub.onFirstCall().resolves({ status: 'AWAITING_HUMAN_INPUT' })
            getHitlStub.onSecondCall().resolves({ status: 'IN_PROGRESS' })
            getHitlStub.onThirdCall().resolves({ status: 'CLOSED' })

            const result = await handler.pollHitlTask('ws-1', 'job-1', 't1')

            expect(result).to.equal('Validation Success!')
            expect(getHitlStub.callCount).to.equal(3)
        })
    })

    describe('listArtifactsForDownload', () => {
        it('should map artifacts with fileMetadata.path to download shape', async () => {
            sinon.stub(handler as any, 'listArtifacts').resolves([
                {
                    artifactId: 'a1',
                    fileMetadata: { path: 'reports/r1.xlsx', description: 'Report' },
                    sizeInBytes: 1024,
                    artifactCreatedTimestamp: 12345,
                },
                {
                    artifactId: 'a2',
                    /* no fileMetadata - should be filtered out */
                },
            ])

            const result = await handler.listArtifactsForDownload('ws-1', 'job-1')

            expect(result.Artifacts).to.have.lengthOf(1)
            expect(result.Artifacts[0]).to.deep.include({
                ArtifactId: 'a1',
                Name: 'reports/r1.xlsx',
                Description: 'Report',
                SizeInBytes: 1024,
                CreatedTimestamp: 12345,
            })
        })

        it('should return error when listArtifacts returns null', async () => {
            sinon.stub(handler as any, 'listArtifacts').resolves(null)

            const result = await handler.listArtifactsForDownload('ws-1', 'job-1')

            expect(result.Artifacts).to.deep.equal([])
            expect(result.Error).to.equal('Failed to list artifacts')
        })
    })

    describe('downloadArtifactToPath', () => {
        it('should return Success=false when createArtifactDownloadUrl fails', async () => {
            sinon.stub(handler, 'createArtifactDownloadUrl').resolves(null)

            const result = await handler.downloadArtifactToPath('ws-1', 'job-1', 'art-1', 'C:/save')

            expect(result.Success).to.be.false
            expect(result.Error).to.equal('Failed to get download URL')
        })
    })

    describe('getJobReport', () => {
        it('should return null when no artifactId provided', async () => {
            const result = await handler.getJobReport('ws-1', 'job-1', '')

            expect(result).to.be.null
        })

        it('should return null when createArtifactDownloadUrl fails', async () => {
            sinon.stub(handler, 'createArtifactDownloadUrl').resolves(null)

            const result = await handler.getJobReport('ws-1', 'job-1', 'art-1')

            expect(result).to.be.null
        })
    })
})

describe('ATXTransformHandler - HITL state branches and fs helpers', () => {
    let handler: ATXTransformHandler
    let serviceManager: any
    let workspace: Workspace
    let logging: Logging
    let runtime: Runtime
    let sendStub: sinon.SinonStub
    let tmpRoot: string

    beforeEach(() => {
        serviceManager = sinon.createStubInstance(AtxTokenServiceManager) as any
        serviceManager.getActiveApplicationUrl = sinon.stub().returns('https://app.example.com')
        serviceManager.getBearerToken = sinon.stub().resolves('token')
        workspace = {} as Workspace
        logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub() } as any
        runtime = {} as Runtime

        handler = new ATXTransformHandler(serviceManager, workspace, logging, runtime)
        sendStub = sinon.stub()
        sinon.stub(handler as any, 'initializeAtxClient').resolves(true)
        sinon.stub(handler as any, 'addAuthToCommand').resolves()
        ;(handler as any).atxClient = { send: sendStub }

        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atx-statebranch-'))
    })

    afterEach(() => {
        sinon.restore()
        try {
            fs.rmSync(tmpRoot, { recursive: true, force: true })
        } catch {
            // best effort
        }
    })

    describe('handleAwaitingHumanInput (via getTransformInfo)', () => {
        const baseRequest: any = {
            TransformationJobId: 'job-1',
            WorkspaceId: 'ws-1',
            SolutionRootPath: 'C:/sln',
        }

        it('should route AWAITING_HUMAN_INPUT + local-build-verification HITL straight back', async () => {
            sinon.stub(handler, 'getJob').resolves({
                statusDetails: { status: 'AWAITING_HUMAN_INPUT' },
            } as any)
            sinon.stub(handler, 'getHitlAgentArtifact').resolves({
                HitlTag: 'local-build-verification',
                TaskId: 'lbv-task',
            } as any)
            sinon.stub(handler, 'getTransformationPlan').resolves({
                Root: { Children: [] },
            } as any)

            const result = await handler.getTransformInfo(baseRequest as any)

            expect(result?.HitlTag).to.equal('local-build-verification')
            expect(result?.HitlTaskId).to.equal('lbv-task')
            expect(result?.TransformationJob.Status).to.equal('AWAITING_HUMAN_INPUT')
        })

        it('should route to handlePlanningPhaseHitl when no plan yet', async () => {
            sinon.stub(handler, 'getJob').resolves({
                statusDetails: { status: 'AWAITING_HUMAN_INPUT' },
            } as any)
            const getHitlStub = sinon.stub(handler, 'getHitlAgentArtifact')
            getHitlStub.onFirstCall().resolves(null) // no local-build-verification
            getHitlStub.onSecondCall().resolves({
                PlanPath: '/p',
                ReportPath: '/r',
                HitlTag: 'plan-review',
                TaskId: 'task-1',
            } as any)
            sinon.stub(handler, 'getTransformationPlan').resolves({
                Root: { Children: [] }, // empty plan -> planning phase
            } as any)

            const result = await handler.getTransformInfo(baseRequest as any)

            expect(result?.PlanPath).to.equal('/p')
            expect(result?.ReportPath).to.equal('/r')
            expect(result?.HitlTag).to.equal('plan-review')
        })

        it('should route to handleExecutionPhaseHitl when plan exists', async () => {
            sinon.stub(handler, 'getJob').resolves({
                statusDetails: { status: 'AWAITING_HUMAN_INPUT' },
            } as any)
            sinon.stub(handler, 'getHitlAgentArtifact').resolves(null)
            sinon.stub(handler, 'getTransformationPlan').resolves({
                Root: {
                    StepId: 'root',
                    Children: [
                        {
                            StepId: 'lvl1',
                            Status: 'IN_PROGRESS',
                            Children: [{ StepId: 'g1', Status: 'PENDING_HUMAN_INPUT', Children: [] }],
                        },
                    ],
                },
            } as any)
            sinon.stub(handler as any, 'findStepLevelHitl').resolves({
                taskId: 'step-task',
                agentArtifact: { artifactId: 'art-1' },
            })
            sinon
                .stub(handler as any, 'downloadAndParseStepHitlArtifact')
                .resolves({ StepId: 'g1', DiffArtifactPath: '/d' })

            const result = await handler.getTransformInfo(baseRequest as any)

            expect(result?.TransformationJob.Status).to.equal('AWAITING_HUMAN_INPUT')
            expect(result?.StepInformation?.StepId).to.equal('g1')
        })

        it('should return plan only when no pending step found in execution phase', async () => {
            sinon.stub(handler, 'getJob').resolves({
                statusDetails: { status: 'AWAITING_HUMAN_INPUT' },
            } as any)
            sinon.stub(handler, 'getHitlAgentArtifact').resolves(null)
            sinon.stub(handler, 'getTransformationPlan').resolves({
                Root: {
                    StepId: 'root',
                    Children: [
                        {
                            StepId: 'lvl1',
                            Status: 'SUCCEEDED',
                            Children: [{ StepId: 'g1', Status: 'SUCCEEDED', Children: [] }],
                        },
                    ],
                },
            } as any)

            const result = await handler.getTransformInfo(baseRequest as any)

            expect(result?.TransformationJob.Status).to.equal('AWAITING_HUMAN_INPUT')
            expect(result?.StepInformation).to.be.undefined
        })
    })

    describe('findPendingHumanInputStep', () => {
        it('should find a deeply nested PENDING_HUMAN_INPUT step', () => {
            const root = {
                StepId: 'root',
                Status: 'NOT_STARTED',
                Children: [
                    {
                        StepId: 'a',
                        Status: 'NOT_STARTED',
                        Children: [
                            {
                                StepId: 'a-b',
                                Status: 'PENDING_HUMAN_INPUT',
                                Children: [],
                            },
                        ],
                    },
                ],
            } as any

            const found = (handler as any).findPendingHumanInputStep(root)
            expect(found?.StepId).to.equal('a-b')
        })

        it('should return null when no pending step exists', () => {
            const root = {
                StepId: 'root',
                Status: 'NOT_STARTED',
                Children: [{ StepId: 'a', Status: 'SUCCEEDED', Children: [] }],
            } as any

            expect((handler as any).findPendingHumanInputStep(root)).to.be.null
        })
    })

    describe('findStepLevelHitl', () => {
        it('should return first task and cache its taskId', async () => {
            sendStub.resolves({ hitlTasks: [{ taskId: 'step-task-1' }] })

            const result = await (handler as any).findStepLevelHitl('ws-1', 'job-1', 'step-1')

            expect(result?.taskId).to.equal('step-task-1')
            expect((handler as any).cachedStepHitl).to.equal('step-task-1')
        })

        it('should return null when no tasks present', async () => {
            sendStub.resolves({ hitlTasks: [] })
            expect(await (handler as any).findStepLevelHitl('ws-1', 'job-1', 'step-1')).to.be.null
        })

        it('should return null on send error', async () => {
            sendStub.rejects(new Error('boom'))
            expect(await (handler as any).findStepLevelHitl('ws-1', 'job-1', 'step-1')).to.be.null
        })
    })

    describe('findCheckpointSettingsHitl', () => {
        it('should return first task on success', async () => {
            sendStub.resolves({ hitlTasks: [{ taskId: 'cs-1' }] })

            const result = await (handler as any).findCheckpointSettingsHitl('ws-1', 'job-1')
            expect(result?.taskId).to.equal('cs-1')
        })

        it('should return null when no tasks', async () => {
            sendStub.resolves({ hitlTasks: [] })
            expect(await (handler as any).findCheckpointSettingsHitl('ws-1', 'job-1')).to.be.null
        })

        it('should return null on send error', async () => {
            sendStub.rejects(new Error('boom'))
            expect(await (handler as any).findCheckpointSettingsHitl('ws-1', 'job-1')).to.be.null
        })
    })

    describe('loadAppliedCheckpoints', () => {
        it('should return empty array when checkpoints-applied.json missing', () => {
            const result = (handler as any).loadAppliedCheckpoints(tmpRoot, 'job-1')
            expect(result).to.deep.equal([])
        })

        it('should return appliedSteps from disk', () => {
            const dir = path.join(tmpRoot, workspaceFolderName, 'job-1', 'checkpoints')
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(path.join(dir, 'checkpoints-applied.json'), JSON.stringify({ appliedSteps: ['s1', 's2'] }))

            const result = (handler as any).loadAppliedCheckpoints(tmpRoot, 'job-1')

            expect(result).to.deep.equal(['s1', 's2'])
        })

        it('should return empty array on parse error', () => {
            const dir = path.join(tmpRoot, workspaceFolderName, 'job-1', 'checkpoints')
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(path.join(dir, 'checkpoints-applied.json'), '{not json')

            const result = (handler as any).loadAppliedCheckpoints(tmpRoot, 'job-1')

            expect(result).to.deep.equal([])
        })
    })

    describe('saveAppliedCheckpoint', () => {
        it('should create checkpoints-applied.json with the step and ensure dir exists', () => {
            ;(handler as any).saveAppliedCheckpoint(tmpRoot, 'job-1', 's1')

            const filePath = path.join(tmpRoot, workspaceFolderName, 'job-1', 'checkpoints', 'checkpoints-applied.json')
            expect(fs.existsSync(filePath)).to.be.true
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
            expect(data.appliedSteps).to.deep.equal(['s1'])
        })

        it('should append step when file already exists', () => {
            const dir = path.join(tmpRoot, workspaceFolderName, 'job-1', 'checkpoints')
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(path.join(dir, 'checkpoints-applied.json'), JSON.stringify({ appliedSteps: ['s1'] }))
            ;(handler as any).saveAppliedCheckpoint(tmpRoot, 'job-1', 's2')

            const data = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoints-applied.json'), 'utf-8'))
            expect(data.appliedSteps).to.deep.equal(['s1', 's2'])
        })

        it('should not duplicate already-recorded steps', () => {
            ;(handler as any).saveAppliedCheckpoint(tmpRoot, 'job-1', 's1')
            ;(handler as any).saveAppliedCheckpoint(tmpRoot, 'job-1', 's1')

            const filePath = path.join(tmpRoot, workspaceFolderName, 'job-1', 'checkpoints', 'checkpoints-applied.json')
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
            expect(data.appliedSteps).to.deep.equal(['s1'])
        })
    })

    describe('populateCheckpointsOnPlan', () => {
        it('should default HasCheckpoint=true for every step when no settings file', () => {
            const plan = {
                Root: {
                    StepId: 'root',
                    Children: [
                        {
                            StepId: 's1',
                            Status: 'NOT_STARTED',
                            Children: [{ StepId: 's2', Status: 'NOT_STARTED', Children: [] }],
                        },
                    ],
                },
            } as any

            ;(handler as any).populateCheckpointsOnPlan(plan, 'job-1', tmpRoot)

            expect(plan.Root.HasCheckpoint).to.be.undefined // root skipped
            expect(plan.Root.Children[0].HasCheckpoint).to.equal(true)
            expect(plan.Root.Children[0].Children[0].HasCheckpoint).to.equal(true)
        })

        it('should apply settings from checkpoint-settings.json', () => {
            const dir = path.join(tmpRoot, workspaceFolderName, 'job-1', 'checkpoints')
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(path.join(dir, 'checkpoint-settings.json'), JSON.stringify({ s1: false, s2: true }))

            const plan = {
                Root: {
                    StepId: 'root',
                    Children: [
                        { StepId: 's1', Status: 'NOT_STARTED', Children: [] },
                        { StepId: 's2', Status: 'NOT_STARTED', Children: [] },
                        { StepId: 's3', Status: 'NOT_STARTED', Children: [] }, // not in settings -> default true
                    ],
                },
            } as any

            ;(handler as any).populateCheckpointsOnPlan(plan, 'job-1', tmpRoot)

            expect(plan.Root.Children[0].HasCheckpoint).to.equal(false)
            expect(plan.Root.Children[1].HasCheckpoint).to.equal(true)
            expect(plan.Root.Children[2].HasCheckpoint).to.equal(true)
        })

        it('should handle malformed checkpoint-settings.json gracefully', () => {
            const dir = path.join(tmpRoot, workspaceFolderName, 'job-1', 'checkpoints')
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(path.join(dir, 'checkpoint-settings.json'), '{not json')

            const plan = {
                Root: {
                    StepId: 'root',
                    Children: [{ StepId: 's1', Status: 'NOT_STARTED', Children: [] }],
                },
            } as any

            expect(() => (handler as any).populateCheckpointsOnPlan(plan, 'job-1', tmpRoot)).to.not.throw()
            expect(plan.Root.Children[0].HasCheckpoint).to.equal(true)
        })
    })

    describe('writeSourceFilesManifest & updateSourceFilesManifest', () => {
        it('should write source-files.json with project paths', () => {
            ;(handler as any).writeSourceFilesManifest(tmpRoot, 'job-1', {
                ProjectMetadata: [
                    {
                        SourceCodeFilePaths: ['C:/sln/A.cs', 'C:/sln/B.cs'],
                        ProjectPath: 'C:/sln/Proj.csproj',
                    },
                ],
                SolutionFilePath: 'C:/sln/Proj.sln',
                SolutionConfigPaths: ['C:/sln/Directory.Build.props'],
            })

            const filePath = path.join(tmpRoot, workspaceFolderName, 'job-1', 'checkpoints', 'source-files.json')
            expect(fs.existsSync(filePath)).to.be.true
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
            expect(data.sourceFiles).to.include.members([
                'C:/sln/A.cs',
                'C:/sln/B.cs',
                'C:/sln/Proj.csproj',
                'C:/sln/Proj.sln',
                'C:/sln/Directory.Build.props',
            ])
        })

        it('should append new files to existing manifest', () => {
            ;(handler as any).writeSourceFilesManifest(tmpRoot, 'job-1', {
                ProjectMetadata: [{ SourceCodeFilePaths: ['C:/sln/A.cs'] }],
            })
            ;(handler as any).updateSourceFilesManifest(tmpRoot, 'job-1', ['NewFile.cs'])

            const filePath = path.join(tmpRoot, workspaceFolderName, 'job-1', 'checkpoints', 'source-files.json')
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
            expect(data.sourceFiles).to.have.lengthOf(2)
            expect(data.lastUpdated).to.be.a('string')
        })

        it('should be a no-op when manifest does not exist (updateSourceFilesManifest)', () => {
            expect(() => (handler as any).updateSourceFilesManifest(tmpRoot, 'job-1', ['NewFile.cs'])).to.not.throw()
        })

        it('should be a no-op when newFiles is empty', () => {
            expect(() => (handler as any).updateSourceFilesManifest(tmpRoot, 'job-1', [])).to.not.throw()
        })
    })

    describe('verifySession', () => {
        it('should return true when init + bearer token + applicationUrl all succeed', async () => {
            const result = await (handler as any).verifySession()
            expect(result).to.be.true
        })

        it('should return false when initializeAtxClient returns false', async () => {
            sinon.restore()
            logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub() } as any
            handler = new ATXTransformHandler(serviceManager, workspace, logging, runtime)
            sinon.stub(handler as any, 'initializeAtxClient').resolves(false)

            const result = await (handler as any).verifySession()

            expect(result).to.be.false
        })
    })
})

describe('ATXTransformHandler - final coverage push', () => {
    let handler: ATXTransformHandler
    let serviceManager: any
    let workspace: Workspace
    let logging: Logging
    let runtime: Runtime
    let sendStub: sinon.SinonStub
    let tmpRoot: string

    beforeEach(() => {
        serviceManager = sinon.createStubInstance(AtxTokenServiceManager) as any
        serviceManager.getActiveApplicationUrl = sinon.stub().returns('https://app.example.com')
        serviceManager.getBearerToken = sinon.stub().resolves('token')
        workspace = {} as Workspace
        logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub() } as any
        runtime = {} as Runtime

        handler = new ATXTransformHandler(serviceManager, workspace, logging, runtime)
        sendStub = sinon.stub()
        sinon.stub(handler as any, 'initializeAtxClient').resolves(true)
        sinon.stub(handler as any, 'addAuthToCommand').resolves()
        ;(handler as any).atxClient = { send: sendStub }

        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atx-final-'))
    })

    afterEach(() => {
        sinon.restore()
        try {
            fs.rmSync(tmpRoot, { recursive: true, force: true })
        } catch {
            // best effort
        }
    })

    describe('listArtifacts (private)', () => {
        it('should return artifacts array on success', async () => {
            sendStub.resolves({ artifacts: [{ artifactId: 'a1' }, { artifactId: 'a2' }] })
            const result = await (handler as any).listArtifacts('ws-1', 'job-1')
            expect(result).to.have.lengthOf(2)
        })

        it('should return empty array when artifacts missing', async () => {
            sendStub.resolves({})
            const result = await (handler as any).listArtifacts('ws-1', 'job-1')
            expect(result).to.deep.equal([])
        })

        it('should return null on send error', async () => {
            sendStub.rejects(new Error('boom'))
            const result = await (handler as any).listArtifacts('ws-1', 'job-1')
            expect(result).to.be.null
        })
    })

    describe('listArtifactsForStep (private)', () => {
        it('should return artifacts array on success', async () => {
            sendStub.resolves({ artifacts: [{ artifactId: 'step-art-1' }] })
            const result = await (handler as any).listArtifactsForStep('ws-1', 'job-1', 'step-1')
            expect(result).to.have.lengthOf(1)
        })

        it('should return null on send error', async () => {
            sendStub.rejects(new Error('boom'))
            const result = await (handler as any).listArtifactsForStep('ws-1', 'job-1', 'step-1')
            expect(result).to.be.null
        })
    })

    describe('fetchAllSteps (private)', () => {
        it('should paginate when nextToken is returned', async () => {
            sendStub.onFirstCall().resolves({ steps: [{ stepId: 's1' }], nextToken: 'page-2' })
            sendStub.onSecondCall().resolves({ steps: [{ stepId: 's2' }] })

            const result = await (handler as any).fetchAllSteps('ws-1', 'job-1')

            expect(result).to.have.lengthOf(2)
            expect(sendStub.callCount).to.equal(2)
        })

        it('should return empty array on send error', async () => {
            sendStub.rejects(new Error('boom'))
            const result = await (handler as any).fetchAllSteps('ws-1', 'job-1')
            expect(result).to.deep.equal([])
        })
    })

    describe('fetchPlanTree (private)', () => {
        it('should return empty plan when fetchAllSteps returns empty', async () => {
            sinon.stub(handler as any, 'fetchAllSteps').resolves([])
            const result = await (handler as any).fetchPlanTree('ws-1', 'job-1')
            expect(result.Root.Children).to.deep.equal([])
        })

        it('should build tree from fetched steps', async () => {
            sinon.stub(handler as any, 'fetchAllSteps').resolves([
                { stepId: 'a', parentStepId: 'root', stepName: 'A' },
                { stepId: 'b', parentStepId: 'a', stepName: 'B' },
            ])

            const result = await (handler as any).fetchPlanTree('ws-1', 'job-1')

            expect(result.Root.Children).to.have.lengthOf(1)
            expect(result.Root.Children[0].StepId).to.equal('a')
            expect(result.Root.Children[0].Children[0].StepId).to.equal('b')
        })
    })

    describe('downloadCompletedStepArtifacts (private)', () => {
        const buildPlan = (g1Status = 'SUCCEEDED'): any => ({
            Root: {
                StepId: 'root',
                Status: 'NOT_STARTED',
                Children: [
                    {
                        StepId: 'lvl1',
                        Status: 'NOT_STARTED',
                        Children: [{ StepId: 'g1', Status: g1Status, Children: [], score: 1 }],
                    },
                ],
            },
        })

        it('should skip when _applyingCheckpoints is already true', async () => {
            ;(handler as any)._applyingCheckpoints = true
            const result = await (handler as any).downloadCompletedStepArtifacts('ws-1', 'job-1', tmpRoot, buildPlan())
            expect(result).to.be.false
        })

        it('should return false when no completed steps at depth 2', async () => {
            const result = await (handler as any).downloadCompletedStepArtifacts(
                'ws-1',
                'job-1',
                tmpRoot,
                buildPlan('IN_PROGRESS')
            )
            expect(result).to.be.false
            expect((handler as any)._applyingCheckpoints).to.be.false
        })

        it('should report failure when checkpoint folder is missing after download attempt', async () => {
            sinon.stub(handler as any, 'downloadCompletedStepArtifact').resolves(undefined)

            const result = await (handler as any).downloadCompletedStepArtifacts('ws-1', 'job-1', tmpRoot, buildPlan())

            expect(result).to.be.true
        })

        it('should skip already-applied steps', async () => {
            const dir = path.join(tmpRoot, workspaceFolderName, 'job-1', 'checkpoints')
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(path.join(dir, 'checkpoints-applied.json'), JSON.stringify({ appliedSteps: ['g1'] }))

            const result = await (handler as any).downloadCompletedStepArtifacts('ws-1', 'job-1', tmpRoot, buildPlan())

            expect(result).to.be.false
        })

        it('should record failure into diff context', async () => {
            ;(handler as any)._currentDiffContext = { failed: false, failedStepIds: [] }
            sinon.stub(handler as any, 'downloadCompletedStepArtifact').resolves(undefined)

            await (handler as any).downloadCompletedStepArtifacts('ws-1', 'job-1', tmpRoot, buildPlan())

            expect((handler as any)._currentDiffContext.failedStepIds).to.deep.equal(['g1'])
        })
    })

    describe('createUpdateWorkspaceZip (private)', () => {
        it('should create zip at expected path with empty modifiedFiles list', async function () {
            this.timeout(15000)
            const zipPath = await (handler as any).createUpdateWorkspaceZip(tmpRoot, 'job-1', [])

            expect(zipPath).to.include('update-workspace.zip')
            expect(fs.existsSync(zipPath)).to.be.true
        })
    })

    describe('getModifiedFilesSinceCheckpoint (private)', () => {
        it('should return empty when manifest is missing', () => {
            const result = (handler as any).getModifiedFilesSinceCheckpoint(tmpRoot, 'job-1')
            expect(result).to.deep.equal([])
        })

        it('should return empty when no lastAppliedTimestamp', () => {
            const dir = path.join(tmpRoot, workspaceFolderName, 'job-1', 'checkpoints')
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(path.join(dir, 'source-files.json'), JSON.stringify({ sourceFiles: ['/a.cs'] }))

            const result = (handler as any).getModifiedFilesSinceCheckpoint(tmpRoot, 'job-1')
            expect(result).to.deep.equal([])
        })

        it('should return files modified after lastAppliedTimestamp', () => {
            const dir = path.join(tmpRoot, workspaceFolderName, 'job-1', 'checkpoints')
            fs.mkdirSync(dir, { recursive: true })
            const trackedFile = path.join(tmpRoot, 'tracked.cs')
            fs.writeFileSync(trackedFile, 'content')

            const oldTimestamp = Date.now() - 60_000
            fs.writeFileSync(
                path.join(dir, 'source-files.json'),
                JSON.stringify({ sourceFiles: [trackedFile], lastAppliedTimestamp: oldTimestamp })
            )

            const result = (handler as any).getModifiedFilesSinceCheckpoint(tmpRoot, 'job-1')
            expect(result).to.include(trackedFile)
        })

        it('should skip files that no longer exist on disk', () => {
            const dir = path.join(tmpRoot, workspaceFolderName, 'job-1', 'checkpoints')
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(
                path.join(dir, 'source-files.json'),
                JSON.stringify({
                    sourceFiles: ['C:/totally-missing-file.cs'],
                    lastAppliedTimestamp: 1,
                })
            )

            const result = (handler as any).getModifiedFilesSinceCheckpoint(tmpRoot, 'job-1')
            expect(result).to.deep.equal([])
        })
    })

    describe('saveLastAppliedTimestamp (private)', () => {
        it('should be no-op when manifest does not exist', () => {
            expect(() => (handler as any).saveLastAppliedTimestamp(tmpRoot, 'job-1', 's1')).to.not.throw()
        })

        it('should set lastAppliedTimestamp and lastAppliedStepId on existing manifest', () => {
            const dir = path.join(tmpRoot, workspaceFolderName, 'job-1', 'checkpoints')
            fs.mkdirSync(dir, { recursive: true })
            const manifestPath = path.join(dir, 'source-files.json')
            fs.writeFileSync(manifestPath, JSON.stringify({ sourceFiles: [] }))
            ;(handler as any).saveLastAppliedTimestamp(tmpRoot, 'job-1', 'step-x')

            const data = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
            expect(data.lastAppliedTimestamp).to.be.a('number')
            expect(data.lastAppliedStepId).to.equal('step-x')
        })
    })

    describe('submitStandardHitl (private)', () => {
        it('should return result on success', async () => {
            sendStub.resolves({ status: 'SUBMITTED' })
            const result = await (handler as any).submitStandardHitl('ws-1', 'job-1', 't1', 'art-1')
            expect(result?.status).to.equal('SUBMITTED')
        })

        it('should return null on send error', async () => {
            sendStub.rejects(new Error('boom'))
            const result = await (handler as any).submitStandardHitl('ws-1', 'job-1', 't1', 'art-1')
            expect(result).to.be.null
        })
    })

    describe('uploadArtifactAndComplete (private)', () => {
        it('should return uploadId on full happy path', async () => {
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadUrl: 'u',
                uploadId: 'art-1',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true })

            const result = await (handler as any).uploadArtifactAndComplete('ws-1', 'job-1', 'C:/file.zip')

            expect(result).to.equal('art-1')
        })

        it('should return null when createArtifactUploadUrl returns null', async () => {
            sinon.stub(handler, 'createArtifactUploadUrl').resolves(null)
            const result = await (handler as any).uploadArtifactAndComplete('ws-1', 'job-1', 'C:/file.zip')
            expect(result).to.be.null
        })

        it('should return null when uploadArtifact fails', async () => {
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadUrl: 'u',
                uploadId: 'art-1',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(false)

            const result = await (handler as any).uploadArtifactAndComplete('ws-1', 'job-1', 'C:/file.zip')

            expect(result).to.be.null
        })

        it('should return null when completeArtifactUpload fails', async () => {
            sinon.stub(handler, 'createArtifactUploadUrl').resolves({
                uploadUrl: 'u',
                uploadId: 'art-1',
                requestHeaders: {},
            } as any)
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves(null)

            const result = await (handler as any).uploadArtifactAndComplete('ws-1', 'job-1', 'C:/file.zip')

            expect(result).to.be.null
        })
    })

    describe('downloadCompletedStepArtifact (private)', () => {
        it('should return early when no artifacts found for step', async () => {
            sinon.stub(handler as any, 'listArtifactsForStep').resolves([])
            const dlSpy = sinon.stub(handler as any, 'downloadDiffArtifact').resolves('')

            await (handler as any).downloadCompletedStepArtifact('ws-1', 'job-1', 's1', tmpRoot)

            expect(dlSpy.called).to.be.false
        })

        it('should call downloadDiffArtifact when artifact is found', async () => {
            sinon.stub(handler as any, 'listArtifactsForStep').resolves([{ artifactId: 'art-1' }])
            const dlSpy = sinon.stub(handler as any, 'downloadDiffArtifact').resolves('')

            await (handler as any).downloadCompletedStepArtifact('ws-1', 'job-1', 's1', tmpRoot)

            expect(dlSpy.calledOnce).to.be.true
        })

        it('should swallow errors and not throw', async () => {
            sinon.stub(handler as any, 'listArtifactsForStep').rejects(new Error('boom'))

            await (handler as any).downloadCompletedStepArtifact('ws-1', 'job-1', 's1', tmpRoot)

            expect((logging.error as sinon.SinonStub).called).to.be.true
        })
    })

    describe('clearJobCache (private)', () => {
        it('should null-out all cached HITL state', () => {
            ;(handler as any).cachedHitl = 'h'
            ;(handler as any).cachedStepHitl = 's'
            ;(handler as any).cachedInteractiveMode = 'Interactive'
            ;(handler as any).clearJobCache()

            expect((handler as any).cachedHitl).to.be.null
            expect((handler as any).cachedStepHitl).to.be.null
            expect((handler as any).cachedInteractiveMode).to.be.null
        })
    })

    describe('getTransformInfo - PLANNING + missing-packages HITL', () => {
        const baseRequest: any = {
            TransformationJobId: 'job-1',
            WorkspaceId: 'ws-1',
            SolutionRootPath: 'C:/sln',
        }

        it('should surface AWAITING_HUMAN_INPUT for missing-packages HITL with no artifact', async () => {
            sinon.stub(handler, 'getJob').resolves({
                statusDetails: { status: 'PLANNING' },
            } as any)
            sinon.stub(handler as any, 'listWorklogs').resolves(undefined)
            sinon.stub(handler, 'getTransformationPlan').resolves({
                Root: { Children: [] },
            } as any)
            sinon.stub(handler, 'listHitls').resolves([{ tag: 'missing-packages', taskId: 'mp-task' }])

            const result = await handler.getTransformInfo(baseRequest as any)

            expect(result?.TransformationJob.Status).to.equal('AWAITING_HUMAN_INPUT')
            expect(result?.HitlTag).to.equal('missing-packages')
            expect(result?.HitlTaskId).to.equal('mp-task')
            expect((handler as any).cachedHitl).to.equal('mp-task')
        })

        it('should surface MissingPackageJsonPath when artifact is present', async () => {
            sinon.stub(handler, 'getJob').resolves({
                statusDetails: { status: 'PLANNING' },
            } as any)
            sinon.stub(handler as any, 'listWorklogs').resolves(undefined)
            sinon.stub(handler, 'getTransformationPlan').resolves({
                Root: { Children: [] },
            } as any)
            sinon.stub(handler, 'listHitls').resolves([
                {
                    tag: 'handle_missing_packages_hitl',
                    taskId: 'mp-task',
                    agentArtifact: { artifactId: 'art-1' },
                },
            ])
            sinon.stub(handler as any, 'handlePlanningPhaseHitl').resolves({
                MissingPackageJsonPath: 'C:/missing.json',
            })

            const result = await handler.getTransformInfo(baseRequest as any)

            expect(result?.MissingPackageJsonPath).to.equal('C:/missing.json')
            expect(result?.HitlTag).to.equal('handle_missing_packages_hitl')
        })

        it('should ignore missing-packages download failures and still surface HITL', async () => {
            sinon.stub(handler, 'getJob').resolves({
                statusDetails: { status: 'PLANNING' },
            } as any)
            sinon.stub(handler as any, 'listWorklogs').resolves(undefined)
            sinon.stub(handler, 'getTransformationPlan').resolves({
                Root: { Children: [] },
            } as any)
            sinon.stub(handler, 'listHitls').resolves([
                {
                    tag: 'missing-packages',
                    taskId: 'mp-task',
                    agentArtifact: { artifactId: 'art-1' },
                },
            ])
            sinon.stub(handler as any, 'handlePlanningPhaseHitl').rejects(new Error('download failed'))

            const result = await handler.getTransformInfo(baseRequest as any)

            expect(result?.TransformationJob.Status).to.equal('AWAITING_HUMAN_INPUT')
            expect(result?.MissingPackageJsonPath).to.be.undefined
        })

        it('should swallow getTransformationPlan errors in fallthrough branch', async () => {
            sinon.stub(handler, 'getJob').resolves({
                statusDetails: { status: 'PLANNING' },
            } as any)
            sinon.stub(handler as any, 'listWorklogs').resolves(undefined)
            sinon.stub(handler, 'getTransformationPlan').rejects(new Error('plan not ready'))
            sinon.stub(handler, 'listHitls').resolves([])

            const result = await handler.getTransformInfo(baseRequest as any)

            expect(result?.TransformationJob.Status).to.equal('PLANNING')
            expect(result?.TransformationPlan).to.be.undefined
        })
    })

    describe('createModifiedFilesZip (private)', () => {
        it('should return empty string when modifiedFiles is empty', async () => {
            const result = await (handler as any).createModifiedFilesZip(tmpRoot, 'job-1', [])
            expect(result).to.equal('')
        })

        it('should create zip when files are provided', async function () {
            this.timeout(15000)
            const dir = path.join(tmpRoot, workspaceFolderName, 'job-1', 'checkpoints')
            fs.mkdirSync(dir, { recursive: true })
            const file1 = path.join(tmpRoot, 'a.cs')
            fs.writeFileSync(file1, 'content')

            const result = await (handler as any).createModifiedFilesZip(tmpRoot, 'job-1', [file1])

            expect(result).to.include('user-modifications.zip')
            expect(fs.existsSync(result)).to.be.true
        })
    })

    describe('writeSourceFilesManifest edge cases', () => {
        it('should produce empty sourceFiles when request has no metadata', () => {
            ;(handler as any).writeSourceFilesManifest(tmpRoot, 'job-1', {})

            const filePath = path.join(tmpRoot, workspaceFolderName, 'job-1', 'checkpoints', 'source-files.json')
            expect(fs.existsSync(filePath)).to.be.true
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
            expect(data.sourceFiles).to.deep.equal([])
        })

        it('should skip falsy file paths in SourceCodeFilePaths', () => {
            ;(handler as any).writeSourceFilesManifest(tmpRoot, 'job-1', {
                ProjectMetadata: [{ SourceCodeFilePaths: ['', null, 'C:/real.cs'] }],
            })

            const filePath = path.join(tmpRoot, workspaceFolderName, 'job-1', 'checkpoints', 'source-files.json')
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
            expect(data.sourceFiles).to.deep.equal(['C:/real.cs'])
        })
    })

    describe('listOrCreateWorkspace - createWorkspace returns null', () => {
        it('should still return AvailableWorkspaces even when createWorkspace fails', async () => {
            sinon.stub(handler as any, 'verifySession').resolves(true)
            sinon.stub(handler, 'listWorkspaces').resolves({
                workspaces: [{ Id: 'ws-1', Name: 'Existing' }],
                applicationUrl: 'u',
            })
            sinon.stub(handler, 'createWorkspace').resolves(null)

            const result = await handler.listOrCreateWorkspace({
                CreateWorkspaceName: 'fail-me',
            } as any)

            expect(result?.AvailableWorkspaces).to.have.lengthOf(1)
            expect(result?.CreatedWorkspace).to.be.undefined
        })
    })

    describe('listJobs - empty page handling', () => {
        it('should return empty Jobs array when first page has no jobList', async () => {
            sendStub.resolves({})

            const result = await handler.listJobs('ws-1')

            expect(result?.Jobs).to.deep.equal([])
        })
    })

    describe('createWorkspace - bare-name input', () => {
        it('should call API with auto-generated description for null name', async () => {
            sendStub.resolves({ workspace: { id: 'ws-9', name: 'Auto' } })

            await handler.createWorkspace(null)

            const command = sendStub.firstCall.args[0]
            expect(command.input.description).to.equal('Auto-generated workspace')
        })
    })

    describe('uploadCustomPlan - more file extension and path branches', () => {
        it('should default to OTHER for unknown extension', async () => {
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'getSha256Async').resolves('sha')
            sendStub.resolves({ artifactId: 'a', s3PreSignedUrl: 'u', requestHeaders: {} })
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true })

            await handler.uploadCustomPlan({
                WorkspaceId: 'ws-1',
                TransformationJobId: 'job-1',
                FilePath: 'C:/random.xyz',
            } as any)

            const command = sendStub.firstCall.args[0]
            expect(command.input.artifactReference.artifactType.fileType).to.equal('OTHER')
        })

        it('should respect ArtifactStorePath prefix', async () => {
            const utilsModule = require('../utils')
            sinon.stub(utilsModule.Utils, 'getSha256Async').resolves('sha')
            sendStub.resolves({ artifactId: 'a', s3PreSignedUrl: 'u', requestHeaders: {} })
            sinon.stub(utilsModule.Utils, 'uploadArtifact').resolves(true)
            sinon.stub(handler, 'completeArtifactUpload').resolves({ success: true })

            await handler.uploadCustomPlan({
                WorkspaceId: 'ws-1',
                TransformationJobId: 'job-1',
                FilePath: 'C:/plan.json',
                ArtifactStorePath: 'subdir/',
            } as any)

            const command = sendStub.firstCall.args[0]
            expect(command.input.fileMetadata.path).to.equal('subdir/plan.json')
        })
    })

    describe('client init failure paths', () => {
        it('startJob should return null when client cannot init', async () => {
            sinon.restore()
            logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub() } as any
            handler = new ATXTransformHandler(serviceManager, workspace, logging, runtime)
            sinon.stub(handler as any, 'initializeAtxClient').resolves(false)

            const result = await handler.startJob('ws-1', 'job-1')

            expect(result).to.be.null
        })

        it('createArtifactDownloadUrl should return null when client cannot init', async () => {
            sinon.restore()
            logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub() } as any
            handler = new ATXTransformHandler(serviceManager, workspace, logging, runtime)
            sinon.stub(handler as any, 'initializeAtxClient').resolves(false)

            const result = await handler.createArtifactDownloadUrl('ws-1', 'job-1', 'art-1')

            expect(result).to.be.null
        })

        it('createJob should return null when client cannot init', async () => {
            sinon.restore()
            logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub() } as any
            handler = new ATXTransformHandler(serviceManager, workspace, logging, runtime)
            sinon.stub(handler as any, 'initializeAtxClient').resolves(false)

            const result = await handler.createJob({ workspaceId: 'ws-1' })

            expect(result).to.be.null
        })

        it('completeArtifactUpload should return null when client cannot init', async () => {
            sinon.restore()
            logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub() } as any
            handler = new ATXTransformHandler(serviceManager, workspace, logging, runtime)
            sinon.stub(handler as any, 'initializeAtxClient').resolves(false)

            const result = await handler.completeArtifactUpload('ws-1', 'job-1', 'art-1')

            expect(result).to.be.null
        })
    })
})

describe('ATXTransformHandler - Beam to IDE', () => {
    let handler: ATXTransformHandler
    let serviceManager: AtxTokenServiceManager
    let workspace: Workspace
    let logging: Logging
    let runtime: Runtime
    let sendStub: sinon.SinonStub

    beforeEach(() => {
        serviceManager = sinon.createStubInstance(AtxTokenServiceManager) as any
        workspace = {} as Workspace
        logging = { log: sinon.stub(), error: sinon.stub(), info: sinon.stub() } as any
        runtime = {} as Runtime
        handler = new ATXTransformHandler(serviceManager, workspace, logging, runtime)
        sinon.stub(handler as any, 'initializeAtxClient').resolves(true)
        sinon.stub(handler as any, 'addAuthToCommand').resolves()
        sendStub = sinon.stub()
        ;(handler as any).atxClient = { send: sendStub }
        // No plan by default → IsLbvOpen defaults true; individual tests can restub.
        sinon.stub(handler as any, 'getTransformationPlan').resolves(null)
    })

    afterEach(() => {
        sinon.restore()
    })

    // --- getStepId: the centralized field-coalescing helper (contract-tolerant) ---
    describe('getStepId', () => {
        it('coalesces stepId / planStepId / parentStepId in priority order', () => {
            const g = (o: any) => (handler as any).getStepId(o)
            expect(g({ stepId: 'a', planStepId: 'b', parentStepId: 'c' })).to.equal('a')
            expect(g({ planStepId: 'b', parentStepId: 'c' })).to.equal('b')
            expect(g({ parentStepId: 'c' })).to.equal('c')
        })

        it('returns undefined for null / non-object / no matching field', () => {
            const g = (o: any) => (handler as any).getStepId(o)
            expect(g(null)).to.be.undefined
            expect(g(undefined)).to.be.undefined
            expect(g('str')).to.be.undefined
            expect(g({ other: 'x' })).to.be.undefined
        })

        it('skips an empty-string stepId and falls through to planStepId / parentStepId (|| not ??)', () => {
            const g = (o: any) => (handler as any).getStepId(o)
            // Empty stepId must NOT short-circuit coalescing (the ??→|| hardening) — an empty
            // string is falsy under ||, so the non-empty planStepId is returned.
            expect(g({ stepId: '', planStepId: 'step-1' })).to.equal('step-1')
            // Empty stepId + empty planStepId → fall all the way through to parentStepId.
            expect(g({ stepId: '', planStepId: '', parentStepId: 'parent-1' })).to.equal('parent-1')
        })
    })

    // --- normalizeBeamRepo: tolerant wire-shape mapping ---
    describe('normalizeBeamRepo', () => {
        it('maps varied key spellings to the PascalCase IDE shape', () => {
            const nr = (handler as any).normalizeBeamRepo({
                repositoryName: 'alice',
                beamArtifactId: 'art-9',
                planStepId: 'step-1',
                tfm: 'net8.0',
                scenario: 'transformed',
            })
            expect(nr.RepositoryName).to.equal('alice')
            expect(nr.BeamArtifactId).to.equal('art-9')
            expect(nr.BeamStepId).to.equal('step-1')
            expect(nr.BeamTargetFramework).to.equal('net8.0')
            expect(nr.BeamScenario).to.equal('transformed')
        })

        it('defaults empty fields and scenario=transformed on a bare object', () => {
            const nr = (handler as any).normalizeBeamRepo({})
            expect(nr.RepositoryName).to.equal('')
            expect(nr.BeamScenario).to.equal('transformed')
        })
    })

    // --- listBeamedRepos: the core discovery function (empty / beam-map / beam-status / regex) ---
    describe('listBeamedRepos', () => {
        const zipArtifacts = (repo: string, hash = 'abc123') => [
            { artifactId: `zip-${repo}`, fileMetadata: { path: `${repo}_${hash}/${repo}.zip` } },
        ]

        it('returns [] when the job has no artifacts (never beamed)', async () => {
            sendStub.resolves({ artifacts: [] })
            const result = await handler.listBeamedRepos('ws-1', 'job-1')
            expect(result).to.deep.equal([])
        })

        it('returns [] when only transformed zips exist but no beam-map / beam-status', async () => {
            sendStub.resolves({ artifacts: zipArtifacts('alice') })
            const result = await handler.listBeamedRepos('ws-1', 'job-1')
            // A transform-only job must NOT over-list its transformed zips as "beamed".
            expect(result).to.deep.equal([])
        })

        it('filters discovery to beam-map membership when a beam-map is present', async () => {
            sendStub.resolves({
                artifacts: [
                    ...zipArtifacts('alice'),
                    ...zipArtifacts('bob'),
                    { artifactId: 'beammap-1', fileMetadata: { path: '' } },
                ],
            })
            sinon
                .stub(handler as any, 'downloadJsonArtifact')
                .resolves({ repos: [{ repoName: 'alice', stepId: 's1', scenario: 'transformed' }] })
            const result = await handler.listBeamedRepos('ws-1', 'job-1')
            expect(result.map((r: any) => r.RepositoryName)).to.deep.equal(['alice'])
            expect(result[0].BeamArtifactId).to.equal('zip-alice')
        })

        it('rejects malformed beam-map entries (no usable repo name)', async () => {
            sendStub.resolves({
                artifacts: [...zipArtifacts('alice'), { artifactId: 'beammap-1', fileMetadata: { path: '' } }],
            })
            sinon
                .stub(handler as any, 'downloadJsonArtifact')
                .resolves({ repos: [{ repoName: 'alice' }, { junk: true }, null, 'not-an-object'] })
            const result = await handler.listBeamedRepos('ws-1', 'job-1')
            // Only the well-formed 'alice' entry survives validation.
            expect(result.map((r: any) => r.RepositoryName)).to.deep.equal(['alice'])
        })

        it('falls back to beam-status filenames when no beam-map is present', async () => {
            sendStub.resolves({
                artifacts: [
                    ...zipArtifacts('alice'),
                    { artifactId: 'status-1', fileMetadata: { path: 'beam-status-job-1-alice.json' } },
                ],
            })
            const result = await handler.listBeamedRepos('ws-1', 'job-1')
            expect(result.map((r: any) => r.RepositoryName)).to.deep.equal(['alice'])
            expect(result[0].BeamArtifactId).to.equal('zip-alice')
        })

        it('strips the -<8hex> suffix on beam-status filenames to resolve the repo', async () => {
            sendStub.resolves({
                artifacts: [
                    ...zipArtifacts('alice'),
                    { artifactId: 'status-1', fileMetadata: { path: 'beam-status-job-1-alice-0a1b2c3d.json' } },
                ],
            })
            const result = await handler.listBeamedRepos('ws-1', 'job-1')
            expect(result.map((r: any) => r.RepositoryName)).to.deep.equal(['alice'])
        })

        it('does not throw or mismatch when the jobId contains regex metacharacters', async () => {
            const jobId = 'job.(v1)+[x]'
            sendStub.resolves({
                artifacts: [
                    ...zipArtifacts('alice'),
                    { artifactId: 'status-1', fileMetadata: { path: `beam-status-${jobId}-alice.json` } },
                ],
            })
            // Without escaping, `new RegExp` would throw or mismatch on these metachars.
            const result = await handler.listBeamedRepos('ws-1', jobId)
            expect(result.map((r: any) => r.RepositoryName)).to.deep.equal(['alice'])
        })

        it('returns [] and logs on send failure (no throw)', async () => {
            sendStub.rejects(new Error('FES down'))
            const result = await handler.listBeamedRepos('ws-1', 'job-1')
            expect(result).to.deep.equal([])
            expect((logging.error as sinon.SinonStub).called).to.be.true
        })
    })

    // --- downloadBeamArtifact: destDir path validation (zip-slip defense) ---
    describe('downloadBeamArtifact', () => {
        it('rejects a relative destDir', async () => {
            const result = await handler.downloadBeamArtifact('ws-1', 'job-1', 'art-1', 'relative/dir')
            expect(result.Success).to.be.false
            expect(result.Error).to.match(/Invalid destination directory/)
        })

        it('rejects a destDir containing ".." traversal', async () => {
            // Absolute but with an un-normalized ".." segment — must be rejected.
            const bad = `${path.sep}root${path.sep}ws${path.sep}..${path.sep}evil`
            const result = await handler.downloadBeamArtifact('ws-1', 'job-1', 'art-1', bad)
            expect(result.Success).to.be.false
            expect(result.Error).to.match(/Invalid destination directory/)
        })

        it('rejects an empty destDir', async () => {
            const result = await handler.downloadBeamArtifact('ws-1', 'job-1', 'art-1', '')
            expect(result.Success).to.be.false
        })
    })
})
