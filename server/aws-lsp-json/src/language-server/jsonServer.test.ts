import { Server } from '@aws/language-server-runtimes/server-interface'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import { AwsLanguageService } from '@aws/lsp-core/out/base'
import sinon, { StubbedInstance, stubInterface } from 'ts-sinon'
import { CancellationToken, FormattingOptions } from 'vscode-languageserver'
import {
    JSON_COMPLETION_FILE,
    JSON_COMPLETION_POSITION,
    JSON_VALIDATION_FILE,
    JSON_VALIDATION_OPEN_FILE,
    JSON_VALIDATION_OPEN_FILE_ITEM,
    JSON_HOVER_FILE,
    JSON_HOVER_POSITION,
    JSON_FORMAT_FILE,
    JSON_FORMAT_RANGE,
} from './testUtils'
import { JsonServerFactory } from './jsonServer'
import { JsonLanguageService } from '../language-service/jsonLanguageService'

describe('Json Server', () => {
    let features: TestFeatures
    let server: Server
    let service: StubbedInstance<AwsLanguageService>

    beforeEach(async () => {
        service = stubInterface<AwsLanguageService>()

        server = JsonServerFactory(service)

        // Initialize the features, but don't start server yet
        features = new TestFeatures()

        // Start the server and open a document
        await features.start(server)

        features.openDocument(JSON_COMPLETION_FILE)
        features.openDocument(JSON_VALIDATION_FILE)
        features.openDocument(JSON_HOVER_FILE)
        features.openDocument(JSON_FORMAT_FILE)
    })

    afterEach(() => {
        features.dispose()
    })

    it('should validate when change document', async () => {
        await features.doChangeTextDocument({
            textDocument: JSON_VALIDATION_FILE,
            contentChanges: [],
        })

        sinon.assert.calledOnceWithExactly(service.doValidation, JSON_VALIDATION_FILE)
    })

    it('should validate when open document', async () => {
        await features.doOpenTextDocument({
            textDocument: JSON_VALIDATION_OPEN_FILE_ITEM,
        })

        sinon.assert.calledOnceWithExactly(service.doValidation, JSON_VALIDATION_OPEN_FILE)
    })

    for (const notification of ['open', 'change'] as const) {
        for (const failure of ['throw', 'reject'] as const) {
            it(`contains ${failure} failures during document ${notification} and validates the next change`, async () => {
                if (failure === 'throw') {
                    service.doValidation.throws(new RangeError('invalid document'))
                } else {
                    service.doValidation.rejects(new RangeError('invalid document'))
                }

                // TestFeatures discards notification promises, so await the registered handlers directly.
                if (notification === 'open') {
                    await features.lsp.onDidOpenTextDocument.firstCall.args[0]({
                        textDocument: JSON_VALIDATION_OPEN_FILE_ITEM,
                    })
                } else {
                    await features.lsp.onDidChangeTextDocument.firstCall.args[0]({
                        textDocument: JSON_VALIDATION_FILE,
                        contentChanges: [],
                    })
                }

                sinon.assert.notCalled(features.lsp.publishDiagnostics)
                sinon.assert.calledOnceWithExactly(features.logging.error, 'Document validation failed.')
                service.doValidation.resetBehavior()
                service.doValidation.resolves([])
                await features.lsp.onDidChangeTextDocument.firstCall.args[0]({
                    textDocument: JSON_VALIDATION_FILE,
                    contentChanges: [],
                })

                sinon.assert.calledTwice(service.doValidation)
                sinon.assert.calledOnceWithExactly(features.lsp.publishDiagnostics, {
                    uri: JSON_VALIDATION_FILE.uri,
                    diagnostics: [],
                    version: JSON_VALIDATION_FILE.version,
                })
            })
        }
    }

    it('contains document lookup failures', async () => {
        features.workspace.getTextDocument.rejects(new Error('unavailable document'))

        await features.lsp.onDidChangeTextDocument.firstCall.args[0]({
            textDocument: JSON_VALIDATION_FILE,
            contentChanges: [],
        })

        sinon.assert.notCalled(service.doValidation)
        sinon.assert.calledOnceWithExactly(features.logging.error, 'Document validation failed.')
    })

    it('contains diagnostic publication failures', async () => {
        service.doValidation.resolves([])
        features.lsp.publishDiagnostics.rejects(new Error('unavailable connection'))

        await features.lsp.onDidChangeTextDocument.firstCall.args[0]({
            textDocument: JSON_VALIDATION_FILE,
            contentChanges: [],
        })

        sinon.assert.calledOnceWithExactly(features.logging.error, 'Document validation failed.')
    })

    it('continues validating after a deeply nested document', async () => {
        const realFeatures = new TestFeatures()
        await realFeatures.start(JsonServerFactory(new JsonLanguageService({})))
        const onOpen = realFeatures.lsp.onDidOpenTextDocument.firstCall.args[0]
        const document = { ...JSON_VALIDATION_OPEN_FILE_ITEM, text: '['.repeat(10_000) + '0' + ']'.repeat(10_000) }

        try {
            await onOpen({ textDocument: document })
            await onOpen({ textDocument: { ...document, version: document.version + 1, text: '{}' } })

            sinon.assert.calledWithExactly(realFeatures.lsp.publishDiagnostics, {
                uri: document.uri,
                diagnostics: [],
                version: document.version + 1,
            })
        } finally {
            realFeatures.dispose()
        }
    })

    it('should complete', async () => {
        await features.doCompletion(
            { textDocument: JSON_COMPLETION_FILE, position: JSON_COMPLETION_POSITION },
            CancellationToken.None
        )

        sinon.assert.calledOnceWithExactly(service.doComplete, JSON_COMPLETION_FILE, JSON_COMPLETION_POSITION)
    })

    it('should hover', async () => {
        await features.doHover({ textDocument: JSON_HOVER_FILE, position: JSON_HOVER_POSITION }, CancellationToken.None)

        sinon.assert.calledOnceWithExactly(service.doHover, JSON_HOVER_FILE, JSON_HOVER_POSITION)
    })

    it('should format', async () => {
        await features.doFormat(
            { textDocument: JSON_FORMAT_FILE, options: {} as FormattingOptions },
            CancellationToken.None
        )

        sinon.assert.calledOnceWithExactly(service.format, JSON_FORMAT_FILE, JSON_FORMAT_RANGE, {} as FormattingOptions)
    })
})
