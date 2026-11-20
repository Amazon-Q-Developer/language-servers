import * as assert from 'assert'
import sinon from 'ts-sinon'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { YamlLanguageService } from './yamlLanguageService'

const DEFAULT_SCHEMA_URI = 'https://schemas.example.com/default.json'

function schemaResponse(schema: object): Response {
    return new Response(JSON.stringify(schema))
}

let documentCount = 0

// Each document gets its own URI so schema associations from earlier tests do not carry over.
function yamlDocument(text: string): TextDocument {
    documentCount++
    return TextDocument.create(`file:///test-${documentCount}.yaml`, 'yaml', 1, text)
}

function fetchedUrls(fetchStub: sinon.SinonStub): string[] {
    return fetchStub.getCalls().map(call => String(call.args[0]))
}

function createService(): YamlLanguageService {
    return new YamlLanguageService({ displayName: 'test', defaultSchemaUri: DEFAULT_SCHEMA_URI })
}

describe('YamlLanguageService schema loading', () => {
    let fetchStub: sinon.SinonStub

    beforeEach(() => {
        fetchStub = sinon.stub(globalThis, 'fetch').callsFake(async () => schemaResponse({ type: 'object' }))
    })

    afterEach(() => {
        sinon.restore()
    })

    it('loads the default schema without following redirects', async () => {
        await createService().doValidation(yamlDocument('a: 1\n'))

        assert.deepStrictEqual(fetchedUrls(fetchStub), [DEFAULT_SCHEMA_URI])
        assert.deepStrictEqual(fetchStub.firstCall.args[1], { redirect: 'error' })
    })

    it('loads a document $schema on the same origin as the default schema', async () => {
        const schemaUrl = 'https://schemas.example.com/other.json'

        await createService().doValidation(yamlDocument(`# yaml-language-server: $schema=${schemaUrl}\na: 1\n`))

        assert.ok(fetchedUrls(fetchStub).includes(schemaUrl))
    })

    for (const schemaUrl of [
        'https://other.example.net/schema.json',
        'http://schemas.example.com/default.json',
        'http://127.0.0.1:8080/schema.json',
    ]) {
        it(`does not load a document $schema of ${schemaUrl}`, async () => {
            await createService().doValidation(yamlDocument(`# yaml-language-server: $schema=${schemaUrl}\na: 1\n`))

            assert.ok(!fetchedUrls(fetchStub).includes(schemaUrl))
        })
    }

    it('keeps the cached default schema after refusing a document $schema', async () => {
        const service = createService()
        await service.doValidation(yamlDocument('a: 1\n'))
        await service.doValidation(
            yamlDocument('# yaml-language-server: $schema=https://other.example.net/schema.json\na: 1\n')
        )
        await service.doValidation(yamlDocument('a: 2\n'))

        assert.deepStrictEqual(fetchedUrls(fetchStub), [DEFAULT_SCHEMA_URI])
    })

    it('passes every schema URL to a host uriResolver unchanged', async () => {
        const requested: string[] = []
        const service = new YamlLanguageService({
            displayName: 'test',
            defaultSchemaUri: DEFAULT_SCHEMA_URI,
            uriResolver: async (url: string) => {
                requested.push(url)
                return JSON.stringify({ type: 'object' })
            },
        })

        await service.doValidation(
            yamlDocument('# yaml-language-server: $schema=https://other.example.net/schema.json\na: 1\n')
        )

        assert.ok(requested.includes('https://other.example.net/schema.json'))
        assert.strictEqual(fetchStub.callCount, 0)
    })
})
