/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { TextDocument } from '@aws/language-server-runtimes/server-interface'
import * as path from 'path'

const testFileNameRegex: Record<string, RegExp[]> = {
    python: [/^test_.*\.py$/, /.*_test\.py$/],
    java: [/^Tests?.*\.java$/, /.*Tests?\.java$/],
    typescript: [/.*\.(test|spec)\.ts$/],
    javascript: [/.*\.(test|spec)\.js$/],
}

const testKeywordsRegex: Record<string, RegExp[]> = {
    python: [/^import unittest/m, /^from unittest/m, /^def test_/m, /^import\s+pytest/m, /^from\s+pytest/m],
    java: [
        /@Test/m,
        /import\s+org\.junit\./m,
        /import\s+org\.testng\./m,
        /import\s+org\.mockito\./m,
        /^import\s+org\.assertj\./m,
        /^import\s+org\.springframework\.test\./m,
    ],
    typescript: [/describe\(/m, /(it|test)\(/m],
    javascript: [/describe\(/m, /(it|test)\(/m],
}

export class TestIntentDetector {
    constructor() {}

    detectUnitTestIntent(doc: TextDocument): boolean {
        const lang = doc.languageId
        const isTestFile = this.isTestFile(doc.uri, doc.getText(), lang)
        return isTestFile
    }

    // @VisibleForTesting
    isTestFile(filePath: string, fileContent: string, language: string): boolean {
        if (!testFileNameRegex[language]) {
            // TODO: logging
            return false
        }

        // Filename + file extension
        const basename = path.basename(filePath)
        const isTestFileByName = testFileNameRegex[language].some(regex => regex.test(basename))
        // Return early and no need to inspect further
        if (!isTestFileByName) {
            return false
        }

        return testKeywordsRegex[language].some(regex => regex.test(fileContent))
    }

    // The following methods are not used for now as we found they're too strict for test intent detection, could remove once we confirm we no longer need them
    // @VisibleForTesting
    javaTestIntent(content: string): boolean {
        const signaturePattern = new RegExp(
            '@Test(?:\\s*@\\w+(?:\\([^)]*\\))?)*' +
                '(?:\\s*(?:public|protected|private)\\s+)?' +
                '(?:static\\s+)?' +
                '\\s*void\\s+\\w+\\s*\\([^)]*\\)' +
                '(?:\\s*throws\\s+\\w+(?:,\\s*\\w+)*)?' +
                '\\s*\\{',
            'gm'
        )

        return this.curlyBracesSyntaxUtil(signaturePattern, content)
    }

    // @VisibleForTesting
    jsTsTestIntent(content: string): boolean {
        const signaturePattern = new RegExp(
            `(it|test)\\s*\\(\\s*["\\'].*?["\\']\\s*,\\s*(async\\s+)?\\(\\s*\\)\\s*=>\\s*\\{`,
            'gm'
        )

        return this.curlyBracesSyntaxUtil(signaturePattern, content)
    }

    // @VisibleForTesting
    pyTestIntent(content: string): boolean {
        const pattern = new RegExp(
            'def\\s+test_\\w+\\s*\\(.*\\):',
            'gms' // g: global, m: multiline, s: dotall
        )

        // Find all matches
        const matches = [...content.matchAll(pattern)]

        if (matches.length === 0) {
            return false
        }

        // Get content after the last test
        const lastMatch = matches[matches.length - 1]
        const lastMatchPos = lastMatch.index! + lastMatch[0].length
        const tailFromLastTest = content.slice(lastMatchPos)
        const lines = tailFromLastTest.split('\n')

        if (lines.length === 0) {
            return true
        }

        // Find first non-empty line
        const firstIndentedLine = lines.find(line => line.trim())
        if (!firstIndentedLine) {
            return true
        }

        // Calculate base indentation
        const baseIndent = firstIndentedLine.length - firstIndentedLine.trimLeft().length

        // Check if all non-empty lines maintain or exceed base indentation
        for (const line of lines) {
            if (line.trim() && line.length - line.trimLeft().length < baseIndent) {
                return false
            }
        }

        return true
    }

    private curlyBracesSyntaxUtil(regex: RegExp, content: string) {
        // Get all matches
        const matches: RegExpExecArray[] = [...content.matchAll(regex)]

        if (matches.length === 0) {
            return false
        }

        // Get the last match position
        const lastMatch = matches[matches.length - 1]
        const lastMatchPos = lastMatch.index + lastMatch[0].length

        // Get content after the last test
        const tailFromLastTest = content.slice(lastMatchPos)

        // Count braces
        const openBraces = (tailFromLastTest.match(/\{/g) || []).length
        const closeBraces = (tailFromLastTest.match(/\}/g) || []).length

        return openBraces >= closeBraces
    }
}
