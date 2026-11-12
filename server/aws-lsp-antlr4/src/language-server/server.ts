import {
    TextDocument,
    TextDocumentSyncKind,
    CancellationToken,
    CompletionParams,
    CompletionList,
    type DidChangeTextDocumentParams,
    type DidOpenTextDocumentParams,
    type Server,
} from '@aws/language-server-runtimes/server-interface'
import { createANTLR4LanguageService, type ANTLR4LanguageService } from '../language-service/service'
import type { Lexer, Parser, CharStream, CommonTokenStream } from 'antlr4ng'
import { MutuallyExclusiveLanguageService } from '@aws/lsp-core/out/base'

export const ANTLR4ServerFactory =
    (service: any): Server =>
    ({ lsp, workspace, telemetry, logging }) => {
        const onInitializeHandler = () => {
            return {
                capabilities: {
                    completionProvider: {
                        resolveProvider: false,
                    },
                    textDocumentSync: {
                        openClose: true,
                        change: TextDocumentSyncKind.Incremental,
                    },
                },
            }
        }

        const onInitializedHandler = async () => {}

        // Publishes the diagnostics of the document. A validation error is logged rather than thrown.
        const publishDiagnostics = async (textDocument: TextDocument, uri: string) => {
            let diagnostics
            try {
                diagnostics = await service.doValidation(textDocument)
            } catch (error) {
                logging.error(`Validation of [${uri}] failed: ${error}`)
                return
            }

            await lsp.publishDiagnostics({
                uri,
                diagnostics,
                version: textDocument.version,
            })
        }

        const onDidChangeTextDocumentHandler = async (params: DidChangeTextDocumentParams): Promise<any> => {
            const textDocument = await workspace.getTextDocument(params.textDocument.uri)
            if (!textDocument) {
                logging.log(`textDocument [${params.textDocument.uri}] not found`)
                return
            }

            await publishDiagnostics(textDocument, params.textDocument.uri)
        }

        const onDidOpenTextDocumentHandler = async (params: DidOpenTextDocumentParams): Promise<any> => {
            let textDocument = await workspace.getTextDocument(params.textDocument.uri)
            if (!textDocument) {
                textDocument = TextDocument.create(
                    params.textDocument.uri,
                    params.textDocument.languageId,
                    params.textDocument.version,
                    params.textDocument.text
                )
            }

            await publishDiagnostics(textDocument, params.textDocument.uri)
        }

        const onCompletionHandler = async (
            params: CompletionParams,
            _token: CancellationToken
        ): Promise<CompletionList | null> => {
            const emptyCompletionList = CompletionList.create([])

            const textDocument = await workspace.getTextDocument(params.textDocument.uri)
            if (!textDocument) {
                logging.log(`textDocument [${params.textDocument.uri}] not found`)
                return emptyCompletionList
            }
            const completions = await service.doComplete(textDocument, params.position)
            return completions ?? emptyCompletionList
        }

        lsp.onInitialized(onInitializedHandler)
        lsp.onDidChangeTextDocument(onDidChangeTextDocumentHandler)
        lsp.onDidOpenTextDocument(onDidOpenTextDocumentHandler)
        lsp.addInitializer(onInitializeHandler)
        lsp.onCompletion(onCompletionHandler)

        logging.log('The ANTLR Language Server has been initialised')

        // disposable
        return () => {
            // Do nothing
        }
    }

export function createCustomAntlr4LanguageServer(customService: ANTLR4LanguageService) {
    return ANTLR4ServerFactory(new MutuallyExclusiveLanguageService([customService]))
}

export const ANTLR4LanguageServer = (
    supportedLanguageIds: string[],
    antlrLexerConstructor: (charStream: CharStream) => Lexer,
    antlrParserConstructor: (tokenStream: CommonTokenStream) => Parser,
    parserRoot: string,
    ignoredTokens?: number[]
) =>
    ANTLR4ServerFactory(
        createANTLR4LanguageService(
            supportedLanguageIds,
            antlrLexerConstructor,
            antlrParserConstructor,
            parserRoot,
            ignoredTokens
        )
    )
