import { DiagnosticSeverity } from '@aws/language-server-runtimes/server-interface'
import { TextDocument } from 'vscode-languageserver-textdocument'
import {
    MAX_PARSED_DOCUMENT_LENGTH,
    MAX_PARSED_NESTING_DEPTH,
    parseLimitDiagnostic,
    parseLimitReason,
} from './parseLimits'
import { CharStream, CommonTokenStream } from 'antlr4ng'
import { createANTLR4LanguageService } from '../service'
import { PartiQLTokens } from '../../test-utils/PartiQLTokens'
import { PartiQLParser } from '../../test-utils/PartiQLParser'

describe('parse limits', () => {
    it('should parse a document within the limits', () => {
        expect(parseLimitReason('SELECT a FROM t WHERE (b = 1)')).toBeUndefined()
        expect(parseLimitDiagnostic('SELECT a FROM t WHERE (b = 1)')).toBeUndefined()
    })

    it('should parse a document at the length limit', () => {
        expect(parseLimitReason('a'.repeat(MAX_PARSED_DOCUMENT_LENGTH))).toBeUndefined()
    })

    it('should not parse a document over the length limit', () => {
        expect(parseLimitReason('a'.repeat(MAX_PARSED_DOCUMENT_LENGTH + 1))).toBe('it is too large')
    })

    it('should parse a document nested to the depth limit', () => {
        for (const [open, close] of [
            ['(', ')'],
            ['[', ']'],
            ['{', '}'],
        ]) {
            const text = open.repeat(MAX_PARSED_NESTING_DEPTH) + close.repeat(MAX_PARSED_NESTING_DEPTH)
            expect(parseLimitReason(text)).toBeUndefined()
        }
    })

    it('should not parse a document nested deeper than the depth limit', () => {
        for (const open of ['(', '[', '{']) {
            expect(parseLimitReason(open.repeat(MAX_PARSED_NESTING_DEPTH + 1))).toBe('it is too deeply nested')
        }
    })

    it('should count nesting across bracket kinds', () => {
        const text = '([{'.repeat(Math.ceil((MAX_PARSED_NESTING_DEPTH + 1) / 3))
        expect(parseLimitReason(text)).toBe('it is too deeply nested')
    })

    it('should count sibling groups separately', () => {
        const text = '(1), '.repeat(MAX_PARSED_NESTING_DEPTH * 2)
        expect(parseLimitReason(text)).toBeUndefined()
    })

    it('should not let unmatched closing brackets lower the depth', () => {
        const text = ')'.repeat(MAX_PARSED_NESTING_DEPTH) + '('.repeat(MAX_PARSED_NESTING_DEPTH)
        expect(parseLimitReason(text)).toBeUndefined()
    })

    it('should describe a document that is not parsed with an information diagnostic', () => {
        const diagnostic = parseLimitDiagnostic('('.repeat(MAX_PARSED_NESTING_DEPTH + 1))
        expect(diagnostic).toEqual({
            message: 'Syntax errors are not shown for this document because it is too deeply nested.',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            severity: DiagnosticSeverity.Information,
        })
    })
})

describe('ANTLR4 language service beyond the parse limits', () => {
    const service = createANTLR4LanguageService(
        ['language-id'],
        (charStream: CharStream) => new PartiQLTokens(charStream),
        (tokenStream: CommonTokenStream) => new PartiQLParser(tokenStream),
        'root'
    )
    const depth = MAX_PARSED_NESTING_DEPTH + 1
    const nested = TextDocument.create(
        'file:///nested.partiql',
        'language-id',
        1,
        'SELECT ' + '('.repeat(depth) + '1' + ')'.repeat(depth)
    )

    it('should return only the note from validation', async () => {
        const diagnostics = await service.doValidation(nested)
        expect(diagnostics).toEqual([expect.objectContaining({ severity: DiagnosticSeverity.Information })])
    })

    it('should return no completions', async () => {
        expect(await service.doComplete(nested, { line: 0, character: 3 })).toBeNull()
    })

    it('should still report syntax errors in a document within the limits', async () => {
        const document = TextDocument.create('file:///small.partiql', 'language-id', 1, 'SELECT FROM env')
        const diagnostics = await service.doValidation(document)
        expect(diagnostics.length).toBeGreaterThan(0)
        expect(diagnostics.every(d => d.severity === DiagnosticSeverity.Error)).toBe(true)
    })
})
