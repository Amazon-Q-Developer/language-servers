import * as assert from 'assert'
import sinon from 'ts-sinon'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { JsonLanguageService } from './jsonLanguageService'

const DEFAULT_SCHEMA_URI = 'https://schemas.example.com/default.json'

function schemaResponse(schema: object): Response {
    return new Response(JSON.stringify(schema))
}

function jsonDocument(content: object): TextDocument {
    return TextDocument.create('file:///test.json', 'json', 1, JSON.stringify(content))
}

function fetchedUrls(fetchStub: sinon.SinonStub): string[] {
    return fetchStub.getCalls().map(call => String(call.args[0]))
}

describe('JsonLanguageService schema loading', () => {
    let fetchStub: sinon.SinonStub

    beforeEach(() => {
        fetchStub = sinon.stub(globalThis, 'fetch').callsFake(async () => schemaResponse({ type: 'object' }))
    })

    afterEach(() => {
        sinon.restore()
    })

    it('loads the default schema without following redirects', async () => {
        const service = new JsonLanguageService({ defaultSchemaUri: DEFAULT_SCHEMA_URI })

        await service.doValidation(jsonDocument({ a: 1 }))

        assert.deepStrictEqual(fetchedUrls(fetchStub), [DEFAULT_SCHEMA_URI])
        assert.deepStrictEqual(fetchStub.firstCall.args[1], { redirect: 'error' })
    })

    it('loads a $ref on the same origin as the default schema', async () => {
        const refUri = 'https://schemas.example.com/part.json'
        fetchStub.callsFake(async (url: string) =>
            url === DEFAULT_SCHEMA_URI ? schemaResponse({ $ref: refUri }) : schemaResponse({ type: 'object' })
        )
        const service = new JsonLanguageService({ defaultSchemaUri: DEFAULT_SCHEMA_URI })

        await service.doValidation(jsonDocument({ a: 1 }))

        assert.deepStrictEqual(fetchedUrls(fetchStub), [DEFAULT_SCHEMA_URI, refUri])
    })

    for (const schemaUrl of [
        'https://other.example.net/schema.json',
        'http://schemas.example.com/default.json',
        'https://schemas.example.com:8443/default.json',
        'file:///etc/hosts',
        'http://127.0.0.1:8080/schema.json',
    ]) {
        it(`does not load a document $schema of ${schemaUrl}`, async () => {
            const service = new JsonLanguageService({ defaultSchemaUri: DEFAULT_SCHEMA_URI })

            await service.doValidation(jsonDocument({ $schema: schemaUrl, a: 1 }))

            assert.ok(!fetchedUrls(fetchStub).includes(schemaUrl))
        })
    }

    it('does not load a $ref to another origin from the default schema', async () => {
        const refUri = 'https://other.example.net/part.json'
        fetchStub.callsFake(async (url: string) =>
            url === DEFAULT_SCHEMA_URI ? schemaResponse({ $ref: refUri }) : schemaResponse({ type: 'object' })
        )
        const service = new JsonLanguageService({ defaultSchemaUri: DEFAULT_SCHEMA_URI })

        await service.doValidation(jsonDocument({ a: 1 }))

        assert.deepStrictEqual(fetchedUrls(fetchStub), [DEFAULT_SCHEMA_URI])
    })

    it('does not load any document $schema when no default schema is set', async () => {
        const service = new JsonLanguageService({})

        await service.doValidation(jsonDocument({ $schema: 'https://other.example.net/schema.json', a: 1 }))

        assert.strictEqual(fetchStub.callCount, 0)
    })

    it('passes every schema URL to a host uriResolver unchanged', async () => {
        const requested: string[] = []
        const service = new JsonLanguageService({
            defaultSchemaUri: DEFAULT_SCHEMA_URI,
            uriResolver: async (url: string) => {
                requested.push(url)
                return JSON.stringify({ type: 'object' })
            },
        })

        await service.doValidation(jsonDocument({ $schema: 'https://other.example.net/schema.json', a: 1 }))

        assert.deepStrictEqual(requested, ['https://other.example.net/schema.json'])
        assert.strictEqual(fetchStub.callCount, 0)
    })
})
