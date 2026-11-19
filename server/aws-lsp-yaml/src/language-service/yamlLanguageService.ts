import { AwsLanguageService, MutuallyExclusiveLanguageService, UriResolver } from '@aws/lsp-core/out/base'
import { CompletionList, Diagnostic, Hover, Position, Range, TextEdit } from 'vscode-languageserver'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { LanguageService, LanguageSettings, getLanguageService } from 'yaml-language-server'
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
    private readonly settings: LanguageSettings
    private schemaLoadFailed = false

    constructor(private readonly props: YamlLanguageServiceProps) {
        let resolveUri: (url: string) => Promise<string>
        if (props.uriResolver) {
            resolveUri = props.uriResolver
        } else {
            resolveUri = url => this.fetchSchema(url)
        }

        const workspaceContext = {
            resolveRelativePath(relativePath: string, resource: string) {
                return new URL(relativePath, resource).href
            },
        }

        this.yamlService = getLanguageService({
            schemaRequestService: uri => this.requestSchema(resolveUri, uri),
            workspaceContext,
        })

        this.settings = {
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
        }

        // Configure once: every configure() call clears the schema cache, so the
        // schema would otherwise be downloaded and parsed again for each request.
        this.yamlService.configure(this.settings)
    }

    public isSupported(document: TextDocument): boolean {
        return document.languageId === 'yaml'
    }

    public doValidation(document: TextDocument): Promise<Diagnostic[]> {
        this.retryFailedSchemaLoad()
        return this.yamlService.doValidation(document, false)
    }

    public doComplete(document: TextDocument, position: Position): Promise<CompletionList> {
        this.retryFailedSchemaLoad()
        return this.yamlService.doComplete(document, position, false)
    }

    public doHover(document: TextDocument, position: Position): Promise<Hover | null> {
        this.retryFailedSchemaLoad()
        return this.yamlService.doHover(document, position)
    }

    public format(document: TextDocument, range: Range, options: YamlFormattingOptions): TextEdit[] {
        this.retryFailedSchemaLoad()
        return this.yamlService.doFormat(document, options)
    }

    private async requestSchema(resolveUri: (url: string) => Promise<string>, uri: string): Promise<string> {
        try {
            const content = await resolveUri(uri)
            if (!isJson(content)) {
                this.schemaLoadFailed = true
            }
            return content
        } catch (error) {
            this.schemaLoadFailed = true
            throw error
        }
    }

    private async fetchSchema(url: string): Promise<string> {
        const response = await fetch(url)
        if (!response.ok) {
            this.schemaLoadFailed = true
        }
        const schema = await (await response.blob()).text()

        return schema
    }

    // A failed load stays cached, so clear it the way the per-request configure() used
    // to, letting the next request fetch the schema again.
    private retryFailedSchemaLoad(): void {
        if (this.schemaLoadFailed) {
            this.schemaLoadFailed = false
            this.yamlService.configure(this.settings)
        }
    }
}

function isJson(content: string): boolean {
    try {
        JSON.parse(content)
        return true
    } catch {
        return false
    }
}

export function create(props: YamlLanguageServiceProps): AwsLanguageService {
    const jsonService = new YamlLanguageService(props)

    return new MutuallyExclusiveLanguageService([jsonService])
}
