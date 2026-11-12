import {
    Diagnostic,
    Hover,
    DiagnosticSeverity,
    TextDocument,
    CompletionList,
    CompletionItem,
} from '@aws/language-server-runtimes/server-interface'

import { type AwsLanguageService } from '@aws/lsp-core'
import {
    CommonTokenStream,
    Token,
    CharStream,
    ATNSimulator,
    Recognizer,
    BaseErrorListener,
    type Lexer,
    type Parser,
} from 'antlr4ng'
import { getPosition, getTokenIndexFromParseTree, getCandidates } from './utils/completion'
import { parseLimitDiagnostic, parseLimitReason } from './utils/parseLimits'
import type { TextEdit } from 'vscode-languageserver-textdocument'

export function normalizeQuery(data: string): string {
    return data != null ? data : ''
}

export function createANTLR4LanguageService(
    supportedLanguageIds: string[],
    antlrLexerConstructor: (charStream: CharStream) => Lexer,
    antlrParserConstructor: (tokenStream: CommonTokenStream) => Parser,
    parserRoot: string,
    ignoredTokens?: number[]
) {
    return new ANTLR4LanguageService(
        supportedLanguageIds,
        antlrLexerConstructor,
        antlrParserConstructor,
        parserRoot,
        ignoredTokens
    )
}

// Collector used to give to the ANTLR parser and lexer to store the diagnostics.
class DiagnosticsCollector extends BaseErrorListener {
    private _diagnostics: Diagnostic[] = []

    constructor(private _document: TextDocument) {
        super()
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

export class ANTLR4LanguageService implements AwsLanguageService {
    private lexerConstructor
    private parserConstructor
    protected parserRoot
    protected ignoredTokens

    constructor(
        private supportedLanguageIds: string[],
        lexerConstructor: (charStream: CharStream) => Lexer,
        parserConstructor: (tokenStream: CommonTokenStream) => Parser,
        parserRoot: string,
        ignoredTokens?: number[]
    ) {
        this.lexerConstructor = lexerConstructor
        this.parserConstructor = parserConstructor
        this.parserRoot = parserRoot
        this.ignoredTokens = new Set(ignoredTokens ?? [])
    }
    isSupported(document: TextDocument): boolean {
        return this.supportedLanguageIds.includes(document.languageId)
    }

    public async doValidation(textDocument: TextDocument): Promise<Diagnostic[]> {
        const limitDiagnostic = parseLimitDiagnostic(textDocument.getText())
        if (limitDiagnostic) {
            return [limitDiagnostic]
        }

        const diagnosticsCollector = new DiagnosticsCollector(textDocument)

        const parser = this.createAntlrParser(textDocument.getText(), diagnosticsCollector)

        // Try to create the syntax tree, will report errors to collector if encounters errors.
        // @ts-ignore the root name depends on the Parser grammar, we assume what the integrators provides actually exists.
        parser[this.parserRoot]()
        return diagnosticsCollector.errors
    }

    public async doComplete(
        textDocument: TextDocument,
        position: { line: number; character: number }
    ): Promise<CompletionList | null> {
        if (parseLimitReason(textDocument.getText()) !== undefined) {
            return null
        }
        position = getPosition(textDocument.getText(), position)
        const parser = this.createAntlrParser(textDocument.getText())
        const tokenIndex = getTokenIndexFromParseTree(parser, this.parserRoot, position)
        const candidates = getCandidates(parser, tokenIndex, this.ignoredTokens)
        const items: CompletionItem[] = []
        candidates.tokens.forEach((_, token) => {
            let symbolicName = parser.vocabulary.getLiteralName(token)
            if (symbolicName) {
                symbolicName = symbolicName.replace(/["']/g, '')
                items.push({
                    label: symbolicName.toUpperCase(),
                })
            }
        })

        return {
            isIncomplete: false,
            items,
        }
    }
    public async doHover(): Promise<Hover | null> {
        // not supported
        return null
    }
    public format(): TextEdit[] {
        // not supported
        return []
    }

    protected createAntlrParser(input: string, diagnosticsCollector = new BaseErrorListener()) {
        // Set up ANTLR lexer
        const inputStream = CharStream.fromString(normalizeQuery(input))
        const lexer = this.lexerConstructor(inputStream)
        lexer.removeErrorListeners()
        lexer.addErrorListener(diagnosticsCollector)

        // Set up ANTLR parser
        const tokenStream = new CommonTokenStream(lexer)
        const parser = this.parserConstructor(tokenStream)
        parser.removeErrorListeners()
        parser.addErrorListener(diagnosticsCollector)

        return parser
    }
}
