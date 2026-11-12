import {
    InitializeParams,
    TextDocument,
    TextDocumentSyncKind,
    SemanticTokensParams,
    SemanticTokens,
    CancellationToken,
    HoverParams,
    Hover,
    SignatureHelpParams,
    SignatureHelp,
    CompletionParams,
    CompletionList,
    type DidChangeTextDocumentParams,
    type DidOpenTextDocumentParams,
    type Server,
} from '@aws/language-server-runtimes/server-interface'
import { createPartiQLLanguageService, semanticTokensLegend } from './language-service'

export const PartiQLServerFactory =
    (service: any): Server =>
    ({ lsp, workspace, telemetry, logging }) => {
        // This variable is used to determine whether the hover content should be markdown or plain text
        let supportHoverMarkdown = false
        const onInitializeHandler = (initParams: InitializeParams) => {
            supportHoverMarkdown =
                initParams.capabilities.textDocument?.hover?.contentFormat?.includes('markdown') ?? false
            return {
                capabilities: {
                    hoverProvider: true,
                    textDocumentSync: {
                        openClose: true,
                        change: TextDocumentSyncKind.Incremental,
                    },
                    semanticTokensProvider: {
                        legend: semanticTokensLegend,
                        full: true,
                    },
                    signatureHelpProvider: {
                        triggerCharacters: ['('],
                    },
                    completionProvider: {
                        resolveProvider: false,
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

        const onSemanticTokensHandler = async (
            params: SemanticTokensParams,
            _token: CancellationToken
        ): Promise<SemanticTokens | null> => {
            const textDocument = await workspace.getTextDocument(params.textDocument.uri)
            if (!textDocument) {
                logging.log(`textDocument [${params.textDocument.uri}] not found`)
                return null
            }

            const tokens = await service.doSemanticTokens(textDocument)
            return tokens
        }

        const onHoverHandler = async (params: HoverParams, _token: CancellationToken): Promise<Hover | null> => {
            const textDocument = await workspace.getTextDocument(params.textDocument.uri)
            if (!textDocument) {
                logging.log(`textDocument [${params.textDocument.uri}] not found`)
                return null
            }
            const hover = await service.doHover(textDocument, params.position, supportHoverMarkdown)
            return hover
        }

        const onSignatureHelpHandler = async (
            params: SignatureHelpParams,
            _token: CancellationToken
        ): Promise<SignatureHelp | null> => {
            const textDocument = await workspace.getTextDocument(params.textDocument.uri)
            if (!textDocument) {
                logging.log(`textDocument [${params.textDocument.uri}] not found`)
                return null
            }

            const signatureHelp = await service.doSignatureHelp(textDocument, params.position)
            return signatureHelp
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
        lsp.onSemanticTokens(onSemanticTokensHandler)
        lsp.onHover(onHoverHandler)
        lsp.onSignatureHelp(onSignatureHelpHandler)
        lsp.onCompletion(onCompletionHandler)

        logging.log('The PartiQL LSP Language Server has been initialised')

        // disposable
        return () => {
            // Do nothing
        }
    }

export const PartiQLLanguageServer = PartiQLServerFactory(createPartiQLLanguageService())
