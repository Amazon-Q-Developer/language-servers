import { AwsLanguageService, MutuallyExclusiveLanguageService, UriResolver } from '@aws/lsp-core/out/base'
import { JSONDocument, LanguageService, getLanguageService } from 'vscode-json-languageservice'
import { CompletionList, Diagnostic, FormattingOptions, Hover, Range } from 'vscode-languageserver'
import { Position, TextDocument, TextEdit } from 'vscode-languageserver-textdocument'
import { SchemaUrlNotAllowedError, isAllowedSchemaUrl } from './schemaUrl'

export type JsonLanguageServiceProps = {
    defaultSchemaUri?: string
    uriResolver?: UriResolver
    allowComments?: boolean
}

/**
 * This is a thin wrapper around the VS Code Json Language Service
 * https://github.com/microsoft/vscode-json-languageservice/
 */
export class JsonLanguageService implements AwsLanguageService {
    private jsonService: LanguageService

    constructor(private readonly props: JsonLanguageServiceProps) {
        const resolveUri = props.uriResolver ?? ((url: string) => fetchSchema(url, props.defaultSchemaUri))

        this.jsonService = getLanguageService({
            schemaRequestService: resolveUri.bind(this),
        })
        const schemas = props.defaultSchemaUri ? [{ fileMatch: ['*'], uri: props.defaultSchemaUri }] : undefined
        this.jsonService.configure({ allowComments: props.allowComments ?? true, schemas })
    }

    public isSupported(document: TextDocument): boolean {
        const languageId = document.languageId
        // placeholder-test-json comes from the sample Visual Studio Client (Extension) in the repo
        // see client/visualStudio/IdesLspPoc/ContentDefinitions/JsonContentType.cs
        return languageId === 'json' || languageId === 'placeholder-test-json'
    }

    public doValidation(textDocument: TextDocument): Thenable<Diagnostic[]> {
        const jsonDocument = this.parse(textDocument)

        return this.jsonService.doValidation(textDocument, jsonDocument)
    }

    public doComplete(textDocument: TextDocument, position: Position): Thenable<CompletionList | null> {
        const jsonDocument = this.parse(textDocument)

        return this.jsonService.doComplete(textDocument, position, jsonDocument)
    }

    public doHover(textDocument: TextDocument, position: Position): Thenable<Hover | null> {
        const jsonDocument = this.parse(textDocument)

        return this.jsonService.doHover(textDocument, position, jsonDocument)
    }

    public format(textDocument: TextDocument, range: Range, options: FormattingOptions): TextEdit[] {
        return this.jsonService.format(textDocument, range, options)
    }

    private parse(textDocument: TextDocument): JSONDocument {
        const jsonDocument = this.jsonService.parseJSONDocument(textDocument)

        if (!jsonDocument) {
            throw new Error(`Unable to parse document with uri: ${textDocument.uri}`)
        }

        return jsonDocument
    }
}

async function fetchSchema(url: string, defaultSchemaUri: string | undefined): Promise<string> {
    if (!isAllowedSchemaUrl(url, defaultSchemaUri)) {
        throw new SchemaUrlNotAllowedError(url)
    }
    const response = await fetch(url, { redirect: 'error' })
    const schema = await (await response.blob()).text()

    return schema
}

export function create(props: JsonLanguageServiceProps): AwsLanguageService {
    const jsonService = new JsonLanguageService(props)
    return new MutuallyExclusiveLanguageService([jsonService])
}
