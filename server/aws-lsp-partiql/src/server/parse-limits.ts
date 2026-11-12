import { Diagnostic, DiagnosticSeverity } from '@aws/language-server-runtimes/server-interface'

/** Longest document, in characters, that is parsed for diagnostics and completions */
export const MAX_PARSED_DOCUMENT_LENGTH = 50_000

/** Deepest nesting of parentheses, brackets and braces in a document that is parsed for diagnostics and completions */
export const MAX_PARSED_NESTING_DEPTH = 200

/**
 * Why the document is not parsed, or undefined when it is: a document is parsed when it is no longer than
 * MAX_PARSED_DOCUMENT_LENGTH and nests parentheses, brackets and braces no deeper than MAX_PARSED_NESTING_DEPTH.
 */
export function parseLimitReason(text: string): string | undefined {
    if (text.length > MAX_PARSED_DOCUMENT_LENGTH) {
        return 'it is too large'
    }
    let depth = 0
    for (const character of text) {
        if (character === '(' || character === '[' || character === '{') {
            depth++
            if (depth > MAX_PARSED_NESTING_DEPTH) {
                return 'it is too deeply nested'
            }
        } else if ((character === ')' || character === ']' || character === '}') && depth > 0) {
            depth--
        }
    }
    return undefined
}

/** A diagnostic saying that syntax errors are not shown for the document, or undefined when the document is parsed */
export function parseLimitDiagnostic(text: string): Diagnostic | undefined {
    const reason = parseLimitReason(text)
    if (reason === undefined) {
        return undefined
    }
    return {
        message: `Syntax errors are not shown for this document because ${reason}.`,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        severity: DiagnosticSeverity.Information,
    }
}
