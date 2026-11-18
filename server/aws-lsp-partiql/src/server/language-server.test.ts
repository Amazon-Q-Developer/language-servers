import { DiagnosticSeverity, Server } from '@aws/language-server-runtimes/server-interface'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { TextDocumentItem, Hover, SignatureHelp, CompletionList } from 'vscode-languageserver-types'
import { PartiQLServerFactory } from './language-server'
import { createPartiQLLanguageService } from './language-service'
import { CancellationTokenSource } from 'vscode-languageserver'

// Here we test that the language service doValidation handler gets called at
// the expected events. Tests that the service does what is expected can be found
// in the service test file.
describe('PartiQL Server', () => {
    let features: TestFeatures
    let server: Server

    let service: ReturnType<typeof createPartiQLLanguageService>
    let validationSpy: jest.SpyInstance
    let loggingSpy: jest.SpyInstance

    beforeEach(async () => {
        service = createPartiQLLanguageService()

        // Spy on the doValidation handler of the lanaguage service
        validationSpy = jest.spyOn(service, 'doValidation')

        server = PartiQLServerFactory(service)

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
        expect(loggingSpy).toHaveBeenCalledWith('textDocument [file:///testUnknownPartiQLvalidation.json] not found')
    })
})

const validationContent = `SELECT FROM env`
const validationFile = TextDocument.create('file:///testPartiQLvalidation.json', 'partiql', 1, validationContent)
const validationOpenFileItem = TextDocumentItem.create(
    'file:///testPartiQLnewfilevalidation.json',
    'partiql',
    1,
    validationContent
)
const unknownValidationFile = TextDocument.create(
    'file:///testUnknownPartiQLvalidation.json',
    'partiql',
    1,
    validationContent
)

// Describes a test suite for testing the PartiQL Language Service's
// ability to respond semantic tokens request.
describe('PartiQL Language Service - Semantic Tokens', () => {
    // Declare variables for the service and a mock document.
    let service: ReturnType<typeof createPartiQLLanguageService>
    let mockDocument: TextDocument

    beforeEach(() => {
        // Initializes the PartiQL language service.
        service = createPartiQLLanguageService()

        // Creates a mock TextDocument representing a PartiQL script.
        // This is to simulate a user editing a document in an IDE.
        mockDocument = TextDocument.create(
            'file:///example.partiql', // URI of the document
            'partiql', // Language identifier
            1, // Version number of the document
            "SELECT * FROM my_table WHERE column = 'value'" // Content of the document
        )

        // Mocks the getText method of the TextDocument to always return a specific query.
        // This ensures consistent results when the document's content is retrieved in the tests.
        jest.spyOn(mockDocument, 'getText').mockReturnValue("SELECT * FROM my_table WHERE column = 'value'")
    })

    // Defines a test case to verify if semantic tokens are generated correctly when a request is received.
    it('should generate semantic tokens when receive request', async () => {
        // Calls the doSemanticTokens method which should analyze the text document and produce semantic tokens.
        const tokens = await service.doSemanticTokens(mockDocument)

        // Checks that tokens are defined after the function call, ensuring the method produces an output.
        expect(tokens).toBeDefined()

        // Confirm the document's text was accessed during token generation.
        expect(mockDocument.getText).toHaveBeenCalled()
    })

    afterEach(() => {
        jest.restoreAllMocks()
    })
})

describe('PartiQL Server - Hover Functionality', () => {
    let service: ReturnType<typeof createPartiQLLanguageService>
    let server: Server
    let features: TestFeatures
    let hoverSpy: jest.SpyInstance

    const testContent = `SELECT * FROM my_table WHERE id = 1;\n `
    const testDocument = TextDocument.create('file:///hoverTest.partiql', 'partiql', 1, testContent)

    beforeEach(async () => {
        service = createPartiQLLanguageService()
        server = PartiQLServerFactory(service)
        features = new TestFeatures()

        await features.start(server)
        features.openDocument(testDocument)

        // Adjust the hover handler mocking
        hoverSpy = jest.spyOn(service, 'doHover').mockImplementation((doc, position) => {
            if (position.line === 1 && position.character === 0) {
                // Explicitly returning a promise that resolves to null
                return Promise.resolve(null)
            }
            // Default hover info for other positions
            return Promise.resolve({
                contents: { kind: 'markdown', value: 'Details about keyword `SELECT`' },
            } as Hover)
        })
    })

    afterEach(() => {
        jest.clearAllMocks()
        features.dispose()
    })

    it('should provide correct hover information for the SELECT keyword', async () => {
        const hoverParams = {
            textDocument: testDocument,
            position: { line: 0, character: 1 }, // Position within 'SELECT'
        }
        const cancellationToken = new CancellationTokenSource().token

        const result = await features.doHover(hoverParams, cancellationToken)

        expect(hoverSpy).toHaveBeenCalledWith(testDocument, { line: 0, character: 1 }, false)
        expect(result).toEqual(
            expect.objectContaining({
                contents: expect.objectContaining({
                    kind: 'markdown',
                    value: 'Details about keyword `SELECT`',
                }),
            })
        )
    })

    it('should not provide hover information for whitespace', async () => {
        const hoverParams = {
            textDocument: testDocument,
            position: { line: 1, character: 0 }, // New line
        }
        const cancellationToken = new CancellationTokenSource().token

        const result = await features.doHover(hoverParams, cancellationToken)

        expect(hoverSpy).toHaveBeenCalledWith(testDocument, { line: 1, character: 0 }, false)
        expect(result).toBeNull()
    })
})

describe('PartiQL Server - SignatureHelp Functionality', () => {
    let service: ReturnType<typeof createPartiQLLanguageService>
    let server: Server
    let features: TestFeatures
    let signatureHelpSpy: jest.SpyInstance

    const testContent = `SELECT BIT_LENGTH(test1, test2)
                         FROM my_table`
    const testDocument = TextDocument.create('file:///signatureHelpTest.partiql', 'partiql', 1, testContent)

    beforeEach(async () => {
        service = createPartiQLLanguageService()
        server = PartiQLServerFactory(service)
        features = new TestFeatures()

        await features.start(server)
        features.openDocument(testDocument)

        signatureHelpSpy = jest.spyOn(service, 'doSignatureHelp').mockImplementation((doc, position) => {
            if (position.line === 0 && position.character === 20) {
                return {
                    signatures: [
                        {
                            label: 'BIT_LENGTH',
                            documentation: 'Returns the length of the bit string.',
                        },
                    ],
                } as SignatureHelp
            } else if (position.line === 1 && position.character === 2) {
                return null
            }
            return null
        })
    })

    afterEach(() => {
        jest.clearAllMocks()
        features.dispose()
    })

    it('should provide correct signatureHelp for BIT_LENGTH function', async () => {
        const signatureHelpParams = {
            textDocument: testDocument,
            position: { line: 0, character: 20 },
        }
        const cancellationToken = new CancellationTokenSource().token

        const result = await features.doSignatureHelp(signatureHelpParams, cancellationToken)

        expect(signatureHelpSpy).toHaveBeenCalledWith(testDocument, { line: 0, character: 20 })
        expect(result).toEqual(
            expect.objectContaining({
                signatures: [
                    {
                        label: 'BIT_LENGTH',
                        documentation: 'Returns the length of the bit string.',
                    },
                ],
            })
        )
    })

    it('should not provide signatureHelp out of function scope', async () => {
        const signatureHelpParams = {
            textDocument: testDocument,
            position: { line: 1, character: 2 },
        }
        const cancellationToken = new CancellationTokenSource().token

        const result = await features.doSignatureHelp(signatureHelpParams, cancellationToken)

        expect(signatureHelpSpy).toHaveBeenCalledWith(testDocument, { line: 1, character: 2 })
        expect(result).toBeNull()
    })
})

describe('PartiQL Server - Completion Functionality', () => {
    let service: ReturnType<typeof createPartiQLLanguageService>
    let server: Server
    let features: TestFeatures
    let completionSpy: jest.SpyInstance

    const testContent = `SELECT * FR'`
    const testDocument = TextDocument.create('file:///completionTest.partiql', 'partiql', 1, testContent)

    beforeEach(async () => {
        service = createPartiQLLanguageService()
        server = PartiQLServerFactory(service)
        features = new TestFeatures()

        await features.start(server)
        features.openDocument(testDocument)

        completionSpy = jest.spyOn(service, 'doComplete').mockImplementation((doc, position) => {
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

describe('PartiQL Server validation errors and parse limits', () => {
    let features: TestFeatures
    let service: ReturnType<typeof createPartiQLLanguageService>

    beforeEach(async () => {
        service = createPartiQLLanguageService()
        features = new TestFeatures()
        await features.start(PartiQLServerFactory(service))
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
