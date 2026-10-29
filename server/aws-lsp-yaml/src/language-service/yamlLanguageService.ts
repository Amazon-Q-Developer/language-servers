import { AwsLanguageService, MutuallyExclusiveLanguageService, UriResolver } from '@aws/lsp-core/out/base'
import { CompletionList, Diagnostic, Hover, Position, Range, TextEdit } from 'vscode-languageserver'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { LanguageService, getLanguageService } from 'yaml-language-server'
import { YamlFormattingOptions } from './formattingOptions'

export type YamlLanguageServiceProps = {
    displayName: string
    defaultSchemaUri: string
    uriResolver?: UriResolver
}

/**
 * This is a thin wrapper around the Redhat Yaml Language Service
 * https://github.com/redhat-developer/yaml-language-server/
 */
export class YamlLanguageService implements AwsLanguageService {
    private yamlService: LanguageService

    constructor(private readonly props: YamlLanguageServiceProps) {
        let resolveUri: (url: string) => Promise<string>
        if (props.uriResolver) {
            resolveUri = props.uriResolver
        } else {
            resolveUri = getSchema
        }

        const workspaceContext = {
            resolveRelativePath(relativePath: string, resource: string) {
                return new URL(relativePath, resource).href
            },
        }

        this.yamlService = getLanguageService({
            schemaRequestService: resolveUri,
            workspaceContext,
        })

        // Configure once: every configure() call clears the schema cache, so the
        // schema would otherwise be downloaded and parsed again for each request.
        this.yamlService.configure({
            hover: true,
            hoverSettings: { showSource: false, showTitle: false },
            completion: true,
            format: true,
            validate: true,
            customTags: [],
            schemas: [
                {
                    fileMatch: ['*'],
                    uri: this.props.defaultSchemaUri,
                    name: this.props.displayName,
                    description: 'some description,',
                },
            ],
        })
    }

    public isSupported(document: TextDocument): boolean {
        return document.languageId === 'yaml'
    }

    public doValidation(document: TextDocument): Promise<Diagnostic[]> {
        return this.yamlService.doValidation(document, false)
    }

    public doComplete(document: TextDocument, position: Position): Promise<CompletionList> {
        return this.yamlService.doComplete(document, position, false)
    }

    public doHover(document: TextDocument, position: Position): Promise<Hover | null> {
        return this.yamlService.doHover(document, position)
    }

    public format(document: TextDocument, range: Range, options: YamlFormattingOptions): TextEdit[] {
        return this.yamlService.doFormat(document, options)
    }
}

async function getSchema(url: string) {
    const response = await fetch(url)
    const schema = await (await response.blob()).text()

    return schema
}

export function create(props: YamlLanguageServiceProps): AwsLanguageService {
    const jsonService = new YamlLanguageService(props)

    return new MutuallyExclusiveLanguageService([jsonService])
}
