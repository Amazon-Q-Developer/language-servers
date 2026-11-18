import { DiagnosticSeverity, Server } from '@aws/language-server-runtimes/server-interface'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { TextDocumentItem, CompletionList } from 'vscode-languageserver-types'
import { ANTLR4ServerFactory } from './server'
import { createANTLR4LanguageService } from '../language-service/service'
import { CancellationTokenSource } from 'vscode-languageserver'
import { CharStream, CommonTokenStream } from 'antlr4ng'
import { PartiQLTokens } from '../test-utils/PartiQLTokens'
import { PartiQLParser } from '../test-utils/PartiQLParser'

// Here we test that the language service doValidation handler gets called at
// the expected events. Tests that the service does what is expected can be found
// in the service test file.
describe('ANTLR Server', () => {
    let features: TestFeatures
    let server: Server

    let service: ReturnType<typeof createANTLR4LanguageService>
    let validationSpy: jest.SpyInstance
    let loggingSpy: jest.SpyInstance

    beforeEach(async () => {
        service = createANTLR4LanguageService(
            ['language-id'],
            (charStream: CharStream) => new PartiQLTokens(charStream),
            (tokenStream: CommonTokenStream) => new PartiQLParser(tokenStream),
            'root'
        )

        // Spy on the doValidation handler of the lanaguage service
        validationSpy = jest.spyOn(service, 'doValidation')

        server = ANTLR4ServerFactory(service)

        // Initialize the features, but don't start server yet
        features = new TestFeatures()

        // Spy on the log handler of the logging feature
        loggingSpy = jest.spyOn(features.logging, 'log')

        // Start the server and open a document
        await features.start(server)
        features.openDocument(validationFile)
    })

    afterEach(() => {
        jest.clearAllMocks()
        features.dispose()
    })

    it('should validate when change document', async () => {
        expect(validationSpy).toHaveBeenCalledTimes(0)
        await features.doChangeTextDocument({
            textDocument: validationFile,
            contentChanges: [],
        })
        expect(validationSpy).toHaveBeenCalledTimes(1)
    })

    it('should validate when open document', async () => {
        expect(validationSpy).toHaveBeenCalledTimes(0)
        await features.doOpenTextDocument({
            textDocument: validationOpenFileItem,
        })
        expect(validationSpy).toHaveBeenCalledTimes(1)
    })

    it('should log when receiving change notification for unknown file', async () => {
        await features.doChangeTextDocument({
            textDocument: unknownValidationFile,
            contentChanges: [],
        })
        expect(loggingSpy).toHaveBeenCalledWith('textDocument [file:///testUnknownANTLRvalidation.json] not found')
    })
})

const validationContent = `SELECT FROM env`
const validationFile = TextDocument.create('file:///testANTLRvalidation.json', 'partiql', 1, validationContent)
const validationOpenFileItem = TextDocumentItem.create(
    'file:///testANTLRnewfilevalidation.json',
    'partiql',
    1,
    validationContent
)
const unknownValidationFile = TextDocument.create(
    'file:///testUnknownANTLRvalidation.json',
    'partiql',
    1,
    validationContent
)

describe('ANTLR Server - Completion Functionality', () => {
    let service: ReturnType<typeof createANTLR4LanguageService>
    let server: Server
    let features: TestFeatures
    let completionSpy: jest.SpyInstance

    const testContent = `SELECT * FR'`
    const testDocument = TextDocument.create('file:///completionTest.ANTLR', 'partiql', 1, testContent)

    beforeEach(async () => {
        service = createANTLR4LanguageService(
            ['language-id'],
            (charStream: CharStream) => new PartiQLTokens(charStream),
            (tokenStream: CommonTokenStream) => new PartiQLParser(tokenStream),
            'root'
        )
        server = ANTLR4ServerFactory(service)
        features = new TestFeatures()

        await features.start(server)
        features.openDocument(testDocument)

        completionSpy = jest.spyOn(service, 'doComplete').mockImplementation(async (doc, position) => {
            if (position.line === 0 && position.character === 11) {
                return CompletionList.create([{ label: 'FROM' }], false)
            }
            return CompletionList.create([], false) // Return an empty list for other positions
        })
    })

    afterEach(() => {
        jest.clearAllMocks()
        features.dispose()
    })

    it('should provide correct completions within FROM clause', async () => {
        const completionParams = {
            textDocument: testDocument,
            position: { line: 0, character: 11 },
        }
        const cancellationToken = new CancellationTokenSource().token

        const result = await features.doCompletion(completionParams, cancellationToken)

        expect(completionSpy).toHaveBeenCalledWith(testDocument, { line: 0, character: 11 })
        expect(result).toEqual(
            expect.objectContaining({
                items: [expect.objectContaining({ label: 'FROM' })],
                isIncomplete: false,
            })
        )
    })

    it('should not provide completions outside FROM clause', async () => {
        const completionParams = {
            textDocument: testDocument,
            position: { line: 0, character: 3 }, // Position outside the 'LIKE' clause
        }
        const cancellationToken = new CancellationTokenSource().token

        const result = await features.doCompletion(completionParams, cancellationToken)

        expect(completionSpy).toHaveBeenCalledWith(testDocument, { line: 0, character: 3 })
        expect(result).toEqual(
            expect.objectContaining({
                items: [],
                isIncomplete: false,
            })
        )
    })
})

describe('ANTLR Server validation errors and parse limits', () => {
    let features: TestFeatures
    let service: ReturnType<typeof createANTLR4LanguageService>

    beforeEach(async () => {
        service = createANTLR4LanguageService(
            ['partiql'],
            (charStream: CharStream) => new PartiQLTokens(charStream),
            (tokenStream: CommonTokenStream) => new PartiQLParser(tokenStream),
            'root'
        )
        features = new TestFeatures()
        await features.start(ANTLR4ServerFactory(service))
    })

    afterEach(() => {
        jest.restoreAllMocks()
        features.dispose()
    })

    // The notification handlers are not awaited by the caller, so let them finish
    const settle = () => new Promise(resolve => setTimeout(resolve, 0))

    it('should log a validation error instead of throwing it', async () => {
        jest.spyOn(service, 'doValidation').mockImplementation(() => {
            throw new Error('validation failed')
        })
        const errorSpy = jest.spyOn(features.logging, 'error')

        await features.doOpenTextDocument({
            textDocument: TextDocumentItem.create('file:///error.partiql', 'partiql', 1, 'SELECT a FROM t'),
        })
        await settle()

        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('validation failed'))
        expect(features.lsp.publishDiagnostics.callCount).toBe(0)
    })

    it('should publish a note instead of syntax errors for a deeply nested document', async () => {
        const text = 'SELECT ' + '('.repeat(1000) + '1' + ')'.repeat(1000)

        await features.doOpenTextDocument({
            textDocument: TextDocumentItem.create('file:///nested.partiql', 'partiql', 1, text),
        })
        await settle()

        expect(features.lsp.publishDiagnostics.callCount).toBe(1)
        expect(features.lsp.publishDiagnostics.firstCall.args[0].diagnostics).toEqual([
            expect.objectContaining({ severity: DiagnosticSeverity.Information }),
        ])
    })
})
