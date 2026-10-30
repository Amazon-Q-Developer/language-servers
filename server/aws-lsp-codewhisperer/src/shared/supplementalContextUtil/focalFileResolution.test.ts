/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execFileSync } from 'child_process'
import { URI } from 'vscode-uri'
import { Workspace } from '@aws/language-server-runtimes/server-interface'
import { FocalFileResolver } from './focalFileResolution'

describe('focalFileResolver', function () {
    let sut: FocalFileResolver
    let tmpProjectRoot: string

    beforeEach(() => {
        sut = new FocalFileResolver()
        tmpProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'focalFileResolutionTest-'))
    })

    afterEach(() => {
        fs.rmSync(tmpProjectRoot, { recursive: true, force: true })
    })

    describe('inferFocalFilename', function () {
        describe('java', function () {
            const testCases = ['FooTest.java', 'FooTests.java', 'TestFoo.java', 'TestsFoo.java']

            for (let i = 0; i < testCases.length; i++) {
                const testCase = testCases[i]
                it(`should infer and return correct source focal file name case ${i}`, () => {
                    const result = sut.inferFocalFilename(testCase, 'java')
                    assert.strictEqual(result, 'Foo.java')
                })
            }
        })

        describe('python', function () {
            const testCases = ['test_py_class.py', 'py_class_test.py']

            for (let i = 0; i < testCases.length; i++) {
                const testCase = testCases[i]
                it(`should infer and return correct source focal file name case ${i}`, () => {
                    const result = sut.inferFocalFilename(testCase, 'python')
                    assert.strictEqual(result, 'py_class.py')
                })
            }
        })

        describe('js', function () {
            const testCases = ['foo.test.js', 'foo.spec.js']

            for (let i = 0; i < testCases.length; i++) {
                const testCase = testCases[i]
                it(`should infer and return correct source focal file name case ${i}`, () => {
                    const result = sut.inferFocalFilename(testCase, 'javascript')
                    assert.strictEqual(result, 'foo.js')
                })
            }
        })

        describe('ts', function () {
            const testCases = ['foo.test.ts', 'foo.spec.ts']

            for (let i = 0; i < testCases.length; i++) {
                const testCase = testCases[i]
                it(`should infer and return correct source focal file name case ${i}`, () => {
                    const result = sut.inferFocalFilename(testCase, 'typescript')
                    assert.strictEqual(result, 'foo.ts')
                })
            }
        })
    })

    describe('extractImportedPaths', function () {
        describe('java', function () {
            it('case1', function () {
                const p = path.join(tmpProjectRoot, 'FooTest.java')
                fs.writeFileSync(
                    p,
                    `
package com.amazon.q.service;

import com.amazon.q.foo.FooClass;
import com.amazon.q.bar.BarClass;
import com.amazon.q.baz1.baz2.BazClass;

public class TestClass {}
`
                )

                const actual = sut.extractImportedPaths(p, 'java', tmpProjectRoot)
                assert.strictEqual(actual.size, 1)
                assert.ok(actual.has(path.join('com', 'amazon', 'q', 'service')))
            })
        })

        describe('python', function () {
            it('case1', function () {
                const p = path.join(tmpProjectRoot, 'test_py_class.py')
                fs.writeFileSync(
                    p,
                    `
import pytest
import sys
import os
from py_class import PyClass
from util import (foo,bar,baz)

def test_py_class():
    assert True
`
                )

                const actual = sut.extractImportedPaths(p, 'python', tmpProjectRoot)
                assert.strictEqual(actual.size, 5)
                assert.ok(actual.has('py_class'))
                assert.ok(actual.has('pytest'))
                assert.ok(actual.has('sys'))
                assert.ok(actual.has('os'))
                assert.ok(actual.has('util'))
            })
        })

        describe('ts', function () {
            it('case1', function () {
                const p = path.join(tmpProjectRoot, 'src', 'test', 'foo.test.ts')
                fs.mkdirSync(path.join(tmpProjectRoot, 'src', 'test'), { recursive: true })
                fs.writeFileSync(
                    p,
                    `
import { foo } from '../foo';
import baz from '../baz';
import * as util from '../utils/util';

test('foo', () => {
    expect(foo()).toBe('foo');
});
`
                )

                const actual = sut.extractImportedPaths(p, 'typescript', tmpProjectRoot)
                assert.strictEqual(actual.size, 3)
                assert.ok(actual.has(path.join(tmpProjectRoot, 'src', 'foo')))
                assert.ok(actual.has(path.join(tmpProjectRoot, 'src', 'baz')))
                assert.ok(actual.has(path.join(tmpProjectRoot, 'src', 'utils', 'util')))
            })
        })

        describe('js', function () {})
    })

    describe('extractImportedSymbols', function () {
        it('case1', function () {
            const p = path.join(tmpProjectRoot, 'foo.js')
            fs.writeFileSync(
                p,
                `
import { foo, bar } from '../src/sample';
import baz from '../src/sample';`
            )

            const actual = sut.extractImportedSymbols(p)
            assert.strictEqual(actual.size, 3)
            assert.ok(actual.has('foo'))
            assert.ok(actual.has('bar'))
            assert.ok(actual.has('baz'))
        })
    })

    describe('extractExportedSymbolsFromFile', function () {
        it('', function () {
            fs.mkdirSync(path.join(tmpProjectRoot, 'src', 'test'), { recursive: true })
            const p = path.join(tmpProjectRoot, 'src', 'test', 'sample.js')
            fs.writeFileSync(
                p,
                `
export function foo() {}
export const bar = 1;
export default baz;
export { alpha, beta };`
            )

            const actual = sut.extractExportedSymbolsFromFile(p)
            assert.strictEqual(actual.size, 5)
            assert.ok(actual.has('foo'))
            assert.ok(actual.has('bar'))
            assert.ok(actual.has('baz'))
            assert.ok(actual.has('alpha'))
            assert.ok(actual.has('beta'))
        })
    })

    describe('resolveImportToAbsPath', function () {
        it('', function () {
            fs.mkdirSync(path.join(tmpProjectRoot, 'src', 'test'), { recursive: true })
            const p = path.join(tmpProjectRoot, 'src', 'test', 'foo.test.ts')
            const actual = sut.resolveImportToAbsPath(p, '../helper', tmpProjectRoot, 'typescript')
            assert.strictEqual(actual, path.join(tmpProjectRoot, 'src', 'helper'))
        })

        it('alias', function () {
            fs.mkdirSync(path.join(tmpProjectRoot, 'src', 'test'), { recursive: true })
            const p = path.join(tmpProjectRoot, 'src', 'test', 'foo.test.ts')
            const actual = sut.resolveImportToAbsPath('foo.test.ts', '@src/utils', tmpProjectRoot, 'typescript')
            assert.strictEqual(actual, path.join(tmpProjectRoot, 'src', 'utils'))
        })
    })

    describe('resolvePackageToPath', function () {
        it('dot', function () {
            const actual = sut.resolvePackageToPath('com.amazon.q.service', '.')
            assert.strictEqual(actual, path.join('com', 'amazon', 'q', 'service'))
        })

        it('slash', function () {
            const actual = sut.resolvePackageToPath('com/amazon/q/service', '/')
            assert.strictEqual(actual, path.join('com', 'amazon', 'q', 'service'))
        })
    })

    describe('walk should exclude hidden files and only include files with correct extensions', function () {
        /**
         * - root/
         *   - src/
         *     - foo.ts
         *     - bar.ts
         *     - ui/
         *       - frontend.vue
         *       - ui.html
         *       - theme.css
         *     - test/
         *       - foo.test.ts
         *       - bar.test.ts
         *   - .github/
         *     - workflows/
         *       - foo.yml
         *     - pull_request_template.md
         *   - .idea
         *     - aws.xml
         *   - package.json
         *   - package-lock.json
         *   - webpack.config
         */
        it('case 1', async function () {
            fs.mkdirSync(path.join(tmpProjectRoot, 'src'), { recursive: true })
            fs.writeFileSync(path.join(tmpProjectRoot, 'src', 'foo.ts'), 'class Foo')
            fs.writeFileSync(path.join(tmpProjectRoot, 'src', 'bar.ts'), 'class Bar')

            fs.mkdirSync(path.join(tmpProjectRoot, 'src', 'ui'), { recursive: true })
            fs.writeFileSync(path.join(tmpProjectRoot, 'src', 'ui', 'frontend.vue'), '')
            fs.writeFileSync(path.join(tmpProjectRoot, 'src', 'ui', 'ui.html'), '')
            fs.writeFileSync(path.join(tmpProjectRoot, 'src', 'ui', 'theme.css'), '')

            fs.mkdirSync(path.join(tmpProjectRoot, 'src', 'test'), { recursive: true })
            fs.writeFileSync(path.join(tmpProjectRoot, 'src', 'test', 'foo.test.ts'), 'class FooTest')
            fs.writeFileSync(path.join(tmpProjectRoot, 'src', 'test', 'bar.test.ts'), 'class BarTest')

            fs.mkdirSync(path.join(tmpProjectRoot, '.github'), { recursive: true })
            fs.mkdirSync(path.join(tmpProjectRoot, '.github', 'workflows'), { recursive: true })
            fs.writeFileSync(path.join(tmpProjectRoot, '.github', 'workflows', 'foo.yml'), '')
            fs.writeFileSync(path.join(tmpProjectRoot, '.github', 'pull_request_template.md'), '')

            fs.mkdirSync(path.join(tmpProjectRoot, '.idea'), { recursive: true })
            fs.writeFileSync(path.join(tmpProjectRoot, '.idea', 'aws.xml'), '')

            fs.writeFileSync(path.join(tmpProjectRoot, 'package.json'), '')
            fs.writeFileSync(path.join(tmpProjectRoot, 'package-lock.json'), '')
            fs.writeFileSync(path.join(tmpProjectRoot, 'webpack.config'), '')

            const files = await sut.walk(tmpProjectRoot, 'typescript')
            const basenames = files.map(it => path.basename(it))

            assert.ok(files.length === 4)
            assert.ok(basenames.includes('foo.ts'))
            assert.ok(basenames.includes('bar.ts'))
            assert.ok(basenames.includes('foo.test.ts'))
            assert.ok(basenames.includes('bar.test.ts'))
        })
    })

    describe('walk should return only regular files inside the project', function () {
        let outsideDir: string

        beforeEach(() => {
            outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'focalFileResolutionOutside-'))
            fs.writeFileSync(path.join(outsideDir, 'secret.ts'), 'export const secret = 1')
            fs.mkdirSync(path.join(tmpProjectRoot, 'src'))
            fs.writeFileSync(path.join(tmpProjectRoot, 'src', 'foo.ts'), 'export class Foo {}')
        })

        afterEach(() => {
            fs.rmSync(outsideDir, { recursive: true, force: true })
        })

        function linkOrSkip(ctx: Mocha.Context, target: string, linkPath: string, type: 'file' | 'junction'): void {
            try {
                fs.symlinkSync(target, linkPath, type)
            } catch {
                ctx.skip()
            }
        }

        it('skips a file link that points outside the project', async function () {
            linkOrSkip(this, path.join(outsideDir, 'secret.ts'), path.join(tmpProjectRoot, 'src', 'bar.ts'), 'file')

            const files = await sut.walk(tmpProjectRoot, 'typescript')

            assert.deepStrictEqual(files, [path.join(tmpProjectRoot, 'src', 'foo.ts')])
        })

        it('does not descend into a directory link that points outside the project', async function () {
            linkOrSkip(this, outsideDir, path.join(tmpProjectRoot, 'src', 'linked'), 'junction')

            const files = await sut.walk(tmpProjectRoot, 'typescript')

            assert.deepStrictEqual(files, [path.join(tmpProjectRoot, 'src', 'foo.ts')])
        })

        it('skips a link to a named pipe so the read cannot block', async function () {
            if (process.platform === 'win32') {
                return this.skip()
            }
            const pipe = path.join(outsideDir, 'pipe')
            try {
                execFileSync('mkfifo', [pipe])
            } catch {
                return this.skip()
            }
            linkOrSkip(this, pipe, path.join(tmpProjectRoot, 'src', 'pipe.ts'), 'file')

            const files = await sut.walk(tmpProjectRoot, 'typescript')

            assert.deepStrictEqual(files, [path.join(tmpProjectRoot, 'src', 'foo.ts')])
        })

        it('does not infer a linked file as the focal file', async function () {
            fs.rmSync(path.join(tmpProjectRoot, 'src', 'foo.ts'))
            linkOrSkip(this, path.join(outsideDir, 'secret.ts'), path.join(tmpProjectRoot, 'src', 'foo.ts'), 'file')
            const testFile = path.join(tmpProjectRoot, 'src', 'foo.test.ts')
            fs.writeFileSync(testFile, "import { Foo } from './foo'")
            const workspace = {
                getAllWorkspaceFolders: () => [{ uri: URI.file(tmpProjectRoot).toString(), name: 'root' }],
            } as unknown as Workspace

            const focalFile = await sut.inferSourceFile(testFile, workspace, 'typescript')

            assert.strictEqual(focalFile, undefined)
        })
    })
})
