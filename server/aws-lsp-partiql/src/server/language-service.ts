import type { Diagnostic } from '@aws/language-server-runtimes/server-interface'
import {
    DiagnosticSeverity,
    TextDocument,
    SemanticTokenTypes,
    SemanticTokens,
    SemanticTokensLegend,
    Hover,
    SignatureHelp,
    CompletionList,
} from '@aws/language-server-runtimes/server-interface'
// Commented out code is to use the PartiQL Rust parser, should be used again after
// https://github.com/partiql/partiql-lang-rust/issues/472 is resolved.
// import partiQlServerBinary from '../partiql-parser-wasm/partiql-wasm-parser-inline'
// import { initSync, parse_as_json } from '../partiql-parser-wasm/partiql_playground'
// import { convertObjectToParserError } from './error-parsing/parser-errors'
import { CommonTokenStream, Token, CharStream, ATNSimulator, Recognizer, BaseErrorListener } from 'antlr4ng'
import { PartiQLParser } from '../antlr-generated/PartiQLParser'
import { PartiQLTokens } from '../antlr-generated/PartiQLTokens'
import { findNodes, encodeSemanticTokens, SemanticToken, string2TokenTypes } from './syntax-highlighting/parser-tokens'
import { type2Hover } from './hover-info/parser-type'
import { findSignatureInfo } from './signature-help/signature-info'
import { getSuggestions } from './completion-hint/parser-completion'
import { parseLimitDiagnostic, parseLimitReason } from './parse-limits'

// This is a constant that is used to determine if the language server supports multi-line tokens.
const MULTILINETOKENSUPPORT = true

export const semanticTokensLegend = {
    tokenTypes: [
        SemanticTokenTypes.keyword,
        SemanticTokenTypes.type,
        SemanticTokenTypes.number,
        SemanticTokenTypes.string,
        SemanticTokenTypes.function,
        SemanticTokenTypes.variable,
        SemanticTokenTypes.comment,
        SemanticTokenTypes.operator,
    ],
    tokenModifiers: [],
} as SemanticTokensLegend

export function normalizeQuery(data: string): string {
    return data != null ? data : ''
}

export function createPartiQLLanguageService() {
    return new PartiQLLanguageService()
}

// Collector used to give to the ANTLR parser and lexer to store the diagnostics.
class DiagnosticsCollector extends BaseErrorListener {
    private _diagnostics: Diagnostic[] = []
    private _document: TextDocument

    constructor(textDocumnt: TextDocument) {
        super()
        this._document = textDocumnt
    }

    // We only use the parser for diagnostics, so we're only interested in the syntaxError method for this class.
    override syntaxError(recognizer: Recognizer<ATNSimulator>, offendingSymbol: Token | null) {
        this._diagnostics.push({
            message: `Unexpected token: ${offendingSymbol?.text}`,
            range: {
                start: this._document.positionAt(offendingSymbol?.start ?? 0),
                end: this._document.positionAt(offendingSymbol?.stop ?? 0),
            },
            severity: DiagnosticSeverity.Error,
        })
    }

    get errors() {
        return this._diagnostics
    }
}

export function doAntlrValidation(textDocument: TextDocument): Diagnostic[] {
    const diagnosticsCollector = new DiagnosticsCollector(textDocument)

    // Set up ANTLR lexer
    const inputStream = CharStream.fromString(normalizeQuery(textDocument.getText()))
    const lexer = new PartiQLTokens(inputStream)
    lexer.removeErrorListeners()
    lexer.addErrorListener(diagnosticsCollector)

    // Set up ANTLR parser
    const tokenStream = new CommonTokenStream(lexer)
    const parser = new PartiQLParser(tokenStream)
    parser.removeErrorListeners()
    parser.addErrorListener(diagnosticsCollector)

    // Try to create the parser tree, will report errors to collector if not possible.
    parser.root()
    return diagnosticsCollector.errors
}

class PartiQLLanguageService {
    constructor() {
        // Commented out code is to use the PartiQL Rust parser, should be used again after
        // https://github.com/partiql/partiql-lang-rust/issues/472 is resolved.
        // initSync(partiQlServerBinary)
    }

    public doValidation(textDocument: TextDocument): Diagnostic[] {
        const limitDiagnostic = parseLimitDiagnostic(textDocument.getText())
        if (limitDiagnostic) {
            return [limitDiagnostic]
        }

        const diagnostics: Diagnostic[] = []

        diagnostics.push(...doAntlrValidation(textDocument))

        // Commented out code is to use the PartiQL Rust parser, should be used again after
        // https://github.com/partiql/partiql-lang-rust/issues/472 is resolved.
        // const parsedQuery = JSON.parse(parse_as_json(normalizeQuery(textDocument.getText())))

        // for (const error of parsedQuery.errors || []) {
        //     const { message, location } = convertObjectToParserError(error)

        //     diagnostics.push({
        //         severity: DiagnosticSeverity.Error,
        //         range: {
        //             start: textDocument.positionAt(location.start),
        //             end: textDocument.positionAt(location.end),
        //         },
        //         message: message,
        //     })
        // }

        return diagnostics
    }

    public async doSemanticTokens(textDocument: TextDocument): Promise<SemanticTokens | null> {
        const text = textDocument.getText()
        const data: SemanticToken[] = []
        for (const nodeType of semanticTokensLegend.tokenTypes) {
            const tokens = await findNodes(text, nodeType as SemanticTokenTypes)
            data.push(...tokens)
        }
        for (const nodeType in string2TokenTypes) {
            const tokens = await findNodes(text, nodeType)
            data.push(...tokens)
        }
        const encodedTokens = encodeSemanticTokens(data, MULTILINETOKENSUPPORT)
        return encodedTokens
    }

    public async doHover(
        textDocument: TextDocument,
        position: { line: number; character: number },
        supportHoverMarkdown: boolean
    ): Promise<Hover | null> {
        return type2Hover(textDocument.getText(), position, supportHoverMarkdown)
    }

    public doSignatureHelp(
        textDocument: TextDocument,
        position: { line: number; character: number }
    ): SignatureHelp | null {
        const lineText = textDocument.getText({
            start: { line: position.line, character: 0 },
            end: { line: position.line, character: position.character },
        })
        const signatureHelp = findSignatureInfo(lineText)
        return signatureHelp
    }

    public doComplete(
        textDocument: TextDocument,
        position: { line: number; character: number }
    ): CompletionList | null {
        const text = normalizeQuery(textDocument.getText())
        if (parseLimitReason(text) !== undefined) {
            return null
        }
        return getSuggestions(text, position)
    }
}
