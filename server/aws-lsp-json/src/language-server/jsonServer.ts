import { Server } from '@aws/language-server-runtimes/server-interface'
import {
    AwsLanguageService,
    MutuallyExclusiveLanguageService,
    textDocumentUtils,
    UriResolver,
} from '@aws/lsp-core/out/base'
import { TextDocument } from 'vscode-languageserver-textdocument'
import {
    Hover,
    HoverParams,
    DidOpenTextDocumentParams,
    DocumentFormattingParams,
    TextDocumentSyncKind,
    TextEdit,
} from 'vscode-languageserver'
import {
    CancellationToken,
    CompletionList,
    CompletionParams,
    DidChangeTextDocumentParams,
} from '@aws/language-server-runtimes/server-interface'
import { create, JsonLanguageService } from '../language-service/jsonLanguageService'

/**
 * This is a demonstration language server that handles both JSON and YAML files according to the
 * CloudFormation or SAM JSON-Schema.
 *
 * This illustrates how we can wrap LSP Connection calls around a provided language service.
 * In this case, the service is a composition of a JSON processor and a YAML processor.
 */

export const JsonServerFactory =
    (service: AwsLanguageService): Server =>
    ({ credentialsProvider, lsp, workspace, telemetry, logging }) => {
        const onInitializeHandler = () => {
            return {
                capabilities: {
                    completionProvider: { resolveProvider: false },
                    hoverProvider: true,
                    documentFormattingProvider: true,
                    textDocumentSync: {
                        openClose: true,
                        change: TextDocumentSyncKind.Incremental,
                    },
                },
            }
        }

        const onInitializedHandler = async () => {}

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

        const onHoverHandler = async (params: HoverParams, _token: CancellationToken): Promise<Hover | null> => {
            const textDocument = await workspace.getTextDocument(params.textDocument.uri)
            if (!textDocument) {
                logging.log(`textDocument [${params.textDocument.uri}] not found`)
                return null
            }
            const hover = await service.doHover(textDocument, params.position)
            return hover
        }

        const onDidChangeTextDocumentHandler = async (params: DidChangeTextDocumentParams): Promise<any> => {
            const textDocument = await workspace.getTextDocument(params.textDocument.uri)
            if (!textDocument) {
                logging.log(`textDocument [${params.textDocument.uri}] not found`)
                return
            }

            const diagnostics = await service.doValidation(textDocument)

            await lsp.publishDiagnostics({
                uri: params.textDocument.uri,
                diagnostics: diagnostics,
                version: textDocument.version,
            })
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

            const diagnostics = await service.doValidation(textDocument)

            await lsp.publishDiagnostics({
                uri: params.textDocument.uri,
                diagnostics: diagnostics,
                version: textDocument.version,
            })
        }

        const onFormatHandler = async (params: DocumentFormattingParams): Promise<TextEdit[] | null> => {
            const textDocument = await workspace.getTextDocument(params.textDocument.uri)
            if (!textDocument) {
                logging.log(`textDocument [${params.textDocument.uri}] not found`)
                return null
            }

            const format = service.format(textDocument, textDocumentUtils.getFullRange(textDocument), params.options)

            return format
        }

        const onValidationError = () => logging.error('Document validation failed.')

        lsp.onInitialized(onInitializedHandler)
        lsp.onCompletion(onCompletionHandler)
        lsp.onDidChangeTextDocument(params => onDidChangeTextDocumentHandler(params).catch(onValidationError))
        lsp.onDidOpenTextDocument(params => onDidOpenTextDocumentHandler(params).catch(onValidationError))
        lsp.onHover(onHoverHandler)
        lsp.onDidFormatDocument(onFormatHandler)
        lsp.addInitializer(onInitializeHandler)

        logging.log('The JSON LSP Language Server has been initialised')

        // disposable
        return () => {
            // Do nothing
        }
    }

export function createCustomJsonLanguageServer(customService: JsonLanguageService) {
    return JsonServerFactory(new MutuallyExclusiveLanguageService([customService]))
}

export const CreateJsonLanguageServer = (
    defaultSchemaUri: string,
    allowComments?: boolean,
    uriResolver?: UriResolver
) =>
    JsonServerFactory(
        create({
            defaultSchemaUri: defaultSchemaUri,
            allowComments: allowComments,
            uriResolver: uriResolver,
        })
    )
