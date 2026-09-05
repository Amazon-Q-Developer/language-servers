import * as assert from 'assert'
import { TextDocument } from 'vscode-languageserver-textdocument'
import {
    getLanguageId,
    getSupportedLanguageId,
    languageByExtension,
    qLanguageIdByDocumentLanguageId,
    getCodeWhispererLanguageIdFromPath,
    isJavaProjectFileFromPath,
} from './languageDetection'

describe('LanguageDetection', () => {
    describe('getLanguageId', () => {
        it('matches all document language ids that are defined in qLanguageIdByDocumentId', () => {
            for (const [documentLanguageId, qLanguageId] of Object.entries(qLanguageIdByDocumentLanguageId)) {
                assert.strictEqual(
                    getLanguageId(TextDocument.create(`test://test.xxx`, documentLanguageId, 1, '')),
                    qLanguageId
                )
            }
        })

        it('able to match language ids regardless of casing', () => {
            assert.strictEqual(getLanguageId(TextDocument.create(`test://test.xxx`, 'CSHarp', 1, '')), 'csharp')
            assert.strictEqual(getLanguageId(TextDocument.create(`test://test.xxx`, 'TyPeScRipT', 1, '')), 'typescript')
        })

        it(`fallbacks to extension check if document's languageId does not exist`, () => {
            for (const [extension, languageId] of Object.entries(languageByExtension)) {
                assert.strictEqual(
                    getLanguageId(TextDocument.create(`test://test.${extension}`, undefined as any, 1, '')),
                    languageId
                )
            }
        })

        it(`maps the 'dockercompose' language id (used by some IDEs for docker-compose files) to yaml`, () => {
            assert.strictEqual(
                getLanguageId(TextDocument.create('test://docker-compose.yaml', 'dockercompose', 1, '')),
                'yaml'
            )
        })
    })

    describe('getSupportedLanguageId', () => {
        const typescriptDocument = TextDocument.create('test://test.ts', 'typescript', 1, '')
        it('should return language id if it is in the list of supported languages', () => {
            assert.ok(getSupportedLanguageId(typescriptDocument, ['typescript', 'javascript']))
            assert.ok(!getSupportedLanguageId(typescriptDocument, ['javascript']))
        })

        it('should support docker-compose files reported with the dockercompose language id', () => {
            const dockerComposeDocument = TextDocument.create('test://docker-compose.yaml', 'dockercompose', 1, '')
            assert.strictEqual(getSupportedLanguageId(dockerComposeDocument), 'yaml')
        })
    })

    describe('getCodeWhispererLanguageIdFromPath', () => {
        it('should return language type with override', () => {
            assert.strictEqual(getCodeWhispererLanguageIdFromPath('test/test.java'), 'java')
            assert.strictEqual(getCodeWhispererLanguageIdFromPath('test/package.json'), 'javascript')
            assert.strictEqual(getCodeWhispererLanguageIdFromPath('test/test.js'), 'javascript')
            assert.strictEqual(getCodeWhispererLanguageIdFromPath('test/test.ts'), 'typescript')
            assert.strictEqual(getCodeWhispererLanguageIdFromPath('test/test.py'), 'python')
        })
    })

    describe('isJavaProjectFileFromPath', () => {
        it('should return project file as java language', () => {
            assert.ok(isJavaProjectFileFromPath('test/build.gradle'))
            assert.ok(isJavaProjectFileFromPath('test/pom.xml'))
            assert.ok(isJavaProjectFileFromPath('test/build.gradle.kts'))
            assert.ok(isJavaProjectFileFromPath('test/build.xml'))
            assert.ok(!isJavaProjectFileFromPath('test/package.json'))
        })
    })
})
