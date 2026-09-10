import { TestFeatures } from '@aws/language-server-runtimes/testing'
import sinon from 'ts-sinon'
import { ChatTelemetryEventName } from '../../../shared/telemetry/types'
import { CONVERSATION_ID_METRIC_KEY, ChatTelemetryController } from './chatTelemetryController'
import assert = require('assert')
import { ChatUIEventName } from './clientTelemetry'
import { TelemetryService } from '../../../shared/telemetry/telemetryService'
import {
    INVOKE_LLM_REASON_INCOMPLETE_TOOL_USE_EXHAUSTED,
    INVOKE_LLM_REASON_INCOMPLETE_TOOL_USE_RETRYING,
} from '../../agenticChat/constants/constants'

describe('TelemetryController', () => {
    const mockTabId = 'mockTabId'
    const mockConversationId = 'mockConversationId'

    let testFeatures: TestFeatures
    let telemetryController: ChatTelemetryController

    beforeEach(() => {
        const telemetryServiceStub = <TelemetryService>{}
        testFeatures = new TestFeatures()
        telemetryController = new ChatTelemetryController(testFeatures, telemetryServiceStub)
    })

    it('able to set and get activeTabId', () => {
        assert.strictEqual(telemetryController.activeTabId, undefined)

        telemetryController.activeTabId = mockTabId

        assert.strictEqual(telemetryController.activeTabId, mockTabId)
    })

    it('able to set and get conversationId for a tab id', () => {
        assert.strictEqual(telemetryController.getConversationId(mockTabId), undefined)

        telemetryController.setConversationId(mockTabId, mockConversationId)

        assert.strictEqual(telemetryController.getConversationId(mockTabId), mockConversationId)
    })

    it('able to remove conversation id by tab id from the map', () => {
        telemetryController.setConversationId(mockTabId, mockConversationId)

        assert.strictEqual(telemetryController.getConversationId(mockTabId), mockConversationId)

        telemetryController.removeConversation(mockTabId)

        assert.strictEqual(telemetryController.getConversationId(mockTabId), undefined)
    })

    it('handles enter focus client telemetry', () => {
        const telemetryHandler = testFeatures.telemetry.onClientTelemetry.firstCall.firstArg

        telemetryHandler({
            name: ChatUIEventName.EnterFocusChat,
        })

        sinon.assert.calledOnceWithExactly(testFeatures.telemetry.emitMetric, {
            name: ChatTelemetryEventName.EnterFocusChat,
            data: { credentialStartUrl: undefined, result: 'Succeeded' },
        })
    })

    it('handles exit focus client telemetry', () => {
        const telemetryHandler = testFeatures.telemetry.onClientTelemetry.firstCall.firstArg

        telemetryHandler({
            name: ChatUIEventName.ExitFocusChat,
        })

        sinon.assert.calledOnceWithExactly(testFeatures.telemetry.emitMetric, {
            name: ChatTelemetryEventName.ExitFocusChat,
            data: { credentialStartUrl: undefined, result: 'Succeeded' },
        })
    })

    // Positive delivery signal.
    it('handles chatMessageRendered client telemetry', () => {
        testFeatures.runtime.serverInfo = { version: '1.70.0', name: 'AmazonQ' }
        const telemetryHandler = testFeatures.telemetry.onClientTelemetry.firstCall.firstArg

        telemetryHandler({
            name: ChatUIEventName.ChatMessageRendered,
        })

        sinon.assert.calledOnceWithExactly(testFeatures.telemetry.emitMetric, {
            name: ChatTelemetryEventName.ChatMessageRendered,
            data: { credentialStartUrl: undefined, result: 'Succeeded', languageServerVersion: '1.70.0' },
        })
    })

    // Negative signal, with reason. Note result stays 'Succeeded' (codebase convention).
    it('handles chatPostMessageRejected client telemetry', () => {
        testFeatures.runtime.serverInfo = { version: '1.70.0', name: 'AmazonQ' }
        const telemetryHandler = testFeatures.telemetry.onClientTelemetry.firstCall.firstArg

        telemetryHandler({
            name: ChatUIEventName.ChatPostMessageRejected,
            reason: 'unknownCommand',
            command: 'bogusCommand',
        })

        sinon.assert.calledOnceWithExactly(testFeatures.telemetry.emitMetric, {
            name: ChatTelemetryEventName.ChatPostMessageRejected,
            data: {
                credentialStartUrl: undefined,
                result: 'Succeeded',
                reason: 'unknownCommand',
                command: 'bogusCommand',
                languageServerVersion: '1.70.0',
            },
        })
    })

    // Double-emit guard: vscode-jsonrpc registers notification handlers in a Map keyed by
    // method (last registration wins), so a single telemetry/event must produce exactly ONE emit
    // even when multiple ChatTelemetryControllers exist. This locks in that behavior.
    it('emits a metric only once when multiple controllers are constructed', () => {
        const telemetryServiceStub = <TelemetryService>{}
        // Construct a second controller against the SAME features (each calls onClientTelemetry).
        new ChatTelemetryController(testFeatures, telemetryServiceStub)
        testFeatures.runtime.serverInfo = { version: '1.70.0', name: 'AmazonQ' }

        // Fire via the LAST-registered handler (what the jsonrpc Map.get would dispatch to).
        const telemetryHandler = testFeatures.telemetry.onClientTelemetry.lastCall.firstArg
        telemetryHandler({ name: ChatUIEventName.ChatMessageRendered })

        sinon.assert.calledOnce(testFeatures.telemetry.emitMetric)
    })

    it('does not handle unknown client telemetry', () => {
        const telemetryHandler = testFeatures.telemetry.onClientTelemetry.firstCall.firstArg

        telemetryHandler({
            params: { name: 'Unknown event' },
        })

        sinon.assert.notCalled(testFeatures.telemetry.emitMetric)
    })

    it('does not emit metrics if conversation id is not present', () => {
        telemetryController.emitConversationMetric({
            name: ChatTelemetryEventName.EnterFocusConversation,
            data: { credentialStartUrl: undefined },
        })

        sinon.assert.notCalled(testFeatures.telemetry.emitMetric)
    })

    it('emits metrics only if conversation id for active tab is present', () => {
        telemetryController.setConversationId(mockTabId, mockConversationId)
        telemetryController.activeTabId = mockTabId

        telemetryController.emitConversationMetric({
            name: ChatTelemetryEventName.EnterFocusConversation,
            data: {},
        })

        sinon.assert.calledOnceWithExactly(testFeatures.telemetry.emitMetric, {
            name: ChatTelemetryEventName.EnterFocusConversation,
            data: {
                [CONVERSATION_ID_METRIC_KEY]: mockConversationId,
                credentialStartUrl: undefined,
                result: 'Succeeded',
            },
        })
    })

    describe('emitAgencticLoop_InvokeLLM reason', () => {
        // The `reason` field lets downstream metrics tell a transient, self-recovering agent-loop
        // failure apart from a terminal one, so it must survive the emit unchanged.
        const emitInvokeLLM = (reason?: string) =>
            telemetryController.emitAgencticLoop_InvokeLLM(
                'mockRequestId',
                mockConversationId,
                'AgenticChatWithToolUse',
                undefined,
                undefined,
                'Failed',
                '1.0.0',
                'mockModelId',
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                reason
            )

        it('forwards the reason when one is supplied', () => {
            emitInvokeLLM(INVOKE_LLM_REASON_INCOMPLETE_TOOL_USE_RETRYING)

            sinon.assert.calledOnce(testFeatures.telemetry.emitMetric)
            const emitted = testFeatures.telemetry.emitMetric.firstCall.firstArg
            assert.strictEqual(emitted.name, ChatTelemetryEventName.AgencticLoop_InvokeLLM)
            assert.strictEqual(emitted.data.reason, INVOKE_LLM_REASON_INCOMPLETE_TOOL_USE_RETRYING)
            // `result` must stay 'Failed' so raw failure counts are unchanged for diagnostics.
            assert.strictEqual(emitted.data.result, 'Failed')
        })

        it('distinguishes the terminal give-up from the retrying case', () => {
            emitInvokeLLM(INVOKE_LLM_REASON_INCOMPLETE_TOOL_USE_EXHAUSTED)

            const emitted = testFeatures.telemetry.emitMetric.firstCall.firstArg
            assert.strictEqual(emitted.data.reason, INVOKE_LLM_REASON_INCOMPLETE_TOOL_USE_EXHAUSTED)
            assert.notStrictEqual(
                INVOKE_LLM_REASON_INCOMPLETE_TOOL_USE_EXHAUSTED,
                INVOKE_LLM_REASON_INCOMPLETE_TOOL_USE_RETRYING
            )
        })

        it('leaves reason undefined for failures with no specific classification', () => {
            emitInvokeLLM(undefined)

            const emitted = testFeatures.telemetry.emitMetric.firstCall.firstArg
            assert.strictEqual(emitted.data.reason, undefined)
            assert.strictEqual(emitted.data.result, 'Failed')
        })
    })

    describe('enqueueCodeDiffEntry', () => {
        const mockTextDocumentUri = 'file:///path/to/file.ts'
        const mockCode = 'const x = 42;'
        const mockCursorPosition = { line: 0, character: 0 }
        const mockMessageId = 'mockMessageId'
        const mockTabId = 'mockTabId'
        const mockConversationId = 'mockConversationId'
        const mockCustomizationArn = 'mockCustomizationArn'

        beforeEach(() => {
            sinon.stub(telemetryController, 'getCustomizationId').returns(mockCustomizationArn)
            telemetryController.setConversationId(mockTabId, mockConversationId)
        })

        afterEach(() => {
            telemetryController.dispose()
            sinon.restore()
        })

        it('should enqueue a code diff entry with single line insertion', () => {
            const insertToCursorPositionParams = {
                code: mockCode,
                cursorPosition: mockCursorPosition,
                textDocument: { uri: mockTextDocumentUri },
                messageId: mockMessageId,
                tabId: mockTabId,
            }

            telemetryController.enqueueCodeDiffEntry(insertToCursorPositionParams)

            const enqueuedEntry = telemetryController.codeDiffTracker.eventQueue[0]
            assert.deepStrictEqual(enqueuedEntry, {
                conversationId: mockConversationId,
                messageId: mockMessageId,
                fileUrl: mockTextDocumentUri,
                time: enqueuedEntry.time,
                originalString: mockCode,
                customizationArn: mockCustomizationArn,
                startPosition: mockCursorPosition,
                endPosition: { line: 0, character: mockCode.length },
            })
        })

        it('should enqueue a code diff entry with multi-line insertion', () => {
            const multiLineCode = 'const x = 42;\nconsole.log(x);'
            const insertToCursorPositionParams = {
                code: multiLineCode,
                cursorPosition: mockCursorPosition,
                textDocument: { uri: mockTextDocumentUri },
                messageId: mockMessageId,
                tabId: mockTabId,
            }

            telemetryController.enqueueCodeDiffEntry(insertToCursorPositionParams)

            const enqueuedEntry = telemetryController.codeDiffTracker.eventQueue[0]
            assert.deepStrictEqual(enqueuedEntry, {
                conversationId: mockConversationId,
                messageId: mockMessageId,
                fileUrl: mockTextDocumentUri,
                time: enqueuedEntry.time,
                originalString: multiLineCode,
                customizationArn: mockCustomizationArn,
                startPosition: mockCursorPosition,
                endPosition: { line: 1, character: 'console.log(x);'.length },
            })
        })

        it('should handle empty lines in multi-line code insertion', () => {
            const multiLineCodeWithEmptyLines = 'if (true) {\n\n  console.log("Hello");\n}'
            const mockCursorPosition = { line: 15, character: 5 }
            const insertToCursorPositionParams = {
                code: multiLineCodeWithEmptyLines,
                cursorPosition: mockCursorPosition,
                textDocument: { uri: mockTextDocumentUri },
                messageId: mockMessageId,
                tabId: mockTabId,
            }

            telemetryController.enqueueCodeDiffEntry(insertToCursorPositionParams)

            const enqueuedEntry = telemetryController.codeDiffTracker.eventQueue[0]
            assert.deepStrictEqual(enqueuedEntry, {
                conversationId: mockConversationId,
                messageId: mockMessageId,
                fileUrl: mockTextDocumentUri,
                time: enqueuedEntry.time,
                originalString: multiLineCodeWithEmptyLines,
                customizationArn: mockCustomizationArn,
                startPosition: mockCursorPosition,
                endPosition: { line: 18, character: 1 },
            })
        })

        it('should not enqueue a code diff entry if code is falsy', () => {
            const insertToCursorPositionParams = {
                code: '',
                cursorPosition: mockCursorPosition,
                textDocument: { uri: mockTextDocumentUri },
                messageId: mockMessageId,
                tabId: mockTabId,
            }

            telemetryController.enqueueCodeDiffEntry(insertToCursorPositionParams)

            assert.deepStrictEqual(telemetryController.codeDiffTracker.eventQueue, [])
        })

        it('should not enqueue a code diff entry if cursorPosition is falsy', () => {
            const insertToCursorPositionParams = {
                code: mockCode,
                cursorPosition: undefined,
                textDocument: { uri: mockTextDocumentUri },
                messageId: mockMessageId,
                tabId: mockTabId,
            }

            telemetryController.enqueueCodeDiffEntry(insertToCursorPositionParams)

            assert.deepStrictEqual(telemetryController.codeDiffTracker.eventQueue, [])
        })

        it('should not enqueue when required parameters are missing', () => {
            const params = {}
            telemetryController.enqueueCodeDiffEntry(params as any)
            assert.deepStrictEqual(telemetryController.codeDiffTracker.eventQueue, [])
        })
    })
})
