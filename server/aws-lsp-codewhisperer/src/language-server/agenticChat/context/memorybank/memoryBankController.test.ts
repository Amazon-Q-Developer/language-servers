/*!
 * Copyright Amazon.com, Inc. or its affiliates.
 * All Rights Reserved. SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import * as sinon from 'sinon'
import { MemoryBankController } from './memoryBankController'
import { MemoryBankPrompts } from './memoryBankPrompts'

describe('MemoryBankController', () => {
    let controller: MemoryBankController
    let mockFeatures: any
    let mockWorkspace: any
    let mockFs: any
    let mockLogging: any

    beforeEach(() => {
        mockFs = {
            exists: sinon.stub(),
            mkdir: sinon.stub(),
            readFile: sinon.stub(),
            readdir: sinon.stub(),
        }

        mockWorkspace = {
            fs: mockFs,
        }

        mockLogging = {
            info: sinon.stub(),
            error: sinon.stub(),
            warn: sinon.stub(),
            debug: sinon.stub(),
        }

        mockFeatures = {
            workspace: mockWorkspace,
            logging: mockLogging,
        }

        controller = new MemoryBankController(mockFeatures)
    })

    afterEach(() => {
        sinon.restore()
        // Reset singleton instance
        ;(MemoryBankController as any).instance = undefined
    })

    describe('getInstance', () => {
        it('should return singleton instance', () => {
            const instance1 = MemoryBankController.getInstance(mockFeatures)
            const instance2 = MemoryBankController.getInstance(mockFeatures)

            assert.strictEqual(instance1, instance2)
        })

        it('should create new instance if none exists', () => {
            const instance = MemoryBankController.getInstance(mockFeatures)

            assert.ok(instance instanceof MemoryBankController)
        })
    })

    describe('isMemoryBankCreationRequest', () => {
        it('should detect memory bank creation requests', () => {
            const testCases = [
                'create a memory bank',
                'Create a Memory Bank',
                'CREATE MEMORY BANK',
                'Create a Memory Bank for this project',
                'generate memory bank for this project',
                'generate memory bank',
                'build memory bank',
                'make memory bank',
                'setup memory bank',
            ]

            testCases.forEach(prompt => {
                const result = controller.isMemoryBankCreationRequest(prompt)
                assert.strictEqual(result, true, `Failed to detect: "${prompt}"`)
            })
        })

        it('should not detect non-memory bank requests', () => {
            const testCases = [
                'create a file',
                'help me with code',
                'explain this function',
                'memory usage optimization',
                'bank account management',
            ]

            testCases.forEach(prompt => {
                const result = controller.isMemoryBankCreationRequest(prompt)
                assert.strictEqual(result, false, `False positive for: "${prompt}"`)
            })
        })
    })

    describe('prompt delegation', () => {
        it('should delegate prompt generation to MemoryBankPrompts class', () => {
            // Test that controller properly delegates to MemoryBankPrompts
            // This ensures clean separation of concerns
            const filesString = 'test.ts has 100 lines and a mean lexical dissimilarity of 0.85'
            const prompt = MemoryBankPrompts.getFileRankingPrompt(filesString, 15)

            assert.ok(typeof prompt === 'string')
            assert.ok(prompt.length > 100)
            assert.ok(prompt.includes('JSON list'))
            assert.ok(prompt.includes('15'))
            assert.ok(prompt.includes(filesString))
        })
    })

    describe('Science Pipeline Methods', () => {
        it('should delegate file ranking prompt to MemoryBankPrompts', () => {
            const filesString = 'test.ts has 100 lines and a mean lexical dissimilarity of 0.85'
            const prompt = MemoryBankPrompts.getFileRankingPrompt(filesString, 15)

            assert.ok(typeof prompt === 'string')
            assert.ok(prompt.includes('JSON list'))
            assert.ok(prompt.includes('15'))
            assert.ok(prompt.includes(filesString))
        })

        describe('TF-IDF Lexical Dissimilarity', () => {
            it('should calculate TF-IDF dissimilarity for multiple files', async () => {
                const files = [
                    { path: 'file1.ts', size: 50 },
                    { path: 'file2.ts', size: 75 },
                    { path: 'file3.ts', size: 100 },
                ]

                // Mock file contents with different lexical patterns
                mockFs.readFile.onFirstCall().resolves('function calculateSum(a, b) { return a + b; }')
                mockFs.readFile.onSecondCall().resolves('class UserService { constructor() {} getUser() {} }')
                mockFs.readFile.onThirdCall().resolves('const config = { apiUrl: "https://api.example.com" }')

                const result = await controller.calculateLexicalDissimilarity(files)

                assert.strictEqual(result.length, 3)
                assert.ok(result.every(f => f.dissimilarity >= 0 && f.dissimilarity <= 1))
                assert.ok(result.every(f => typeof f.dissimilarity === 'number'))

                // Verify all original properties are preserved
                result.forEach((file, index) => {
                    assert.strictEqual(file.path, files[index].path)
                    assert.strictEqual(file.size, files[index].size)
                })
            })

            it('should handle empty or unreadable files gracefully', async () => {
                const files = [
                    { path: 'readable.ts', size: 50 },
                    { path: 'unreadable.ts', size: 25 },
                ]

                mockFs.readFile.onFirstCall().resolves('function test() { return true; }')
                mockFs.readFile.onSecondCall().rejects(new Error('File not found'))

                const result = await controller.calculateLexicalDissimilarity(files)

                assert.strictEqual(result.length, 2)
                assert.ok(result.every(f => f.dissimilarity >= 0 && f.dissimilarity <= 1))
                sinon.assert.calledOnce(mockLogging.warn)
            })

            it('should return fallback values on calculation error', async () => {
                const files = [{ path: 'test.ts', size: 50 }]

                mockFs.readFile.rejects(new Error('Filesystem error'))

                const result = await controller.calculateLexicalDissimilarity(files)

                assert.strictEqual(result.length, 1)
                assert.strictEqual(result[0].dissimilarity, 0.85)
                sinon.assert.calledOnce(mockLogging.error)
            })

            describe('matches the original dense TF-IDF implementation', () => {
                // Reference: the previous dense implementation (vocabulary-wide vectors, full N x N
                // cosine matrix), kept here as an oracle for the sparse version.
                function referenceDissimilarities(documents: string[]): number[] {
                    const tokenize = (doc: string) =>
                        doc
                            .toLowerCase()
                            .replace(/[^\w\s]/g, ' ')
                            .split(/\s+/)
                            .filter(token => token.length > 2)
                    const tokenizedDocs = documents.map(tokenize)
                    const vocabArray = Array.from(new Set(tokenizedDocs.flat()))
                    const numDocs = documents.length
                    const df = new Map<string, number>()
                    vocabArray.forEach(term => df.set(term, tokenizedDocs.filter(t => t.includes(term)).length))
                    const matrix = tokenizedDocs.map(tokens => {
                        const tf = new Map<string, number>()
                        tokens.forEach(t => tf.set(t, (tf.get(t) || 0) + 1))
                        const vector = new Map<string, number>()
                        vocabArray.forEach(term =>
                            vector.set(term, (tf.get(term) || 0) * Math.log(numDocs / (df.get(term) || 1)))
                        )
                        return vector
                    })
                    const cosine = (a: Map<string, number>, b: Map<string, number>) => {
                        let dot = 0
                        let na = 0
                        let nb = 0
                        new Set([...a.keys(), ...b.keys()]).forEach(term => {
                            const x = a.get(term) || 0
                            const y = b.get(term) || 0
                            dot += x * y
                            na += x * x
                            nb += y * y
                        })
                        return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb))
                    }
                    return matrix.map(row => {
                        const mean = matrix.reduce((sum, other) => sum + cosine(row, other), 0) / numDocs
                        return Math.max(0, Math.min(1, 1 - mean))
                    })
                }

                async function assertMatchesReference(documents: string[]) {
                    const files = documents.map((_, i) => ({ path: `file${i}.ts`, size: i }))
                    documents.forEach((doc, i) => mockFs.readFile.onCall(i).resolves(doc))

                    const result = await controller.calculateLexicalDissimilarity(files)
                    const expected = referenceDissimilarities(documents)

                    assert.strictEqual(result.length, documents.length)
                    result.forEach((file, i) => {
                        assert.strictEqual(file.path, files[i].path)
                        assert.strictEqual(file.size, files[i].size)
                        assert.ok(
                            Math.abs(file.dissimilarity - expected[i]) < 1e-9,
                            `file ${i}: got ${file.dissimilarity}, expected ${expected[i]}`
                        )
                    })
                }

                it('for varied source files', async () => {
                    await assertMatchesReference([
                        'function calculateSum(a, b) { return a + b; }\nexport default calculateSum',
                        'class UserService { constructor() {} getUser(id) { return this.users.get(id) } }',
                        'const config = { apiUrl: "https://api.example.com", retries: 3 }\nexport default config',
                        'import { UserService } from "./user"\nconst service = new UserService()\nservice.getUser(42)',
                        'def calculate_sum(a, b):\n    return a + b\n\nclass UserService:\n    pass',
                    ])
                })

                it('when one file is empty', async () => {
                    await assertMatchesReference([
                        'function alpha() { return beta(); }',
                        '',
                        'class Gamma { delta() {} }',
                    ])
                })

                it('when files contain only short tokens', async () => {
                    await assertMatchesReference(['a = b + c', 'x(y); z;', 'function useful() {}'])
                })

                it('when all files are identical (every term has zero IDF)', async () => {
                    const doc = 'export function sharedHelper(value) { return value * 2 }'
                    await assertMatchesReference([doc, doc, doc])
                })

                it('for a single file', async () => {
                    await assertMatchesReference(['function lonely() { return "only file" }'])
                })

                it('for tokens that are Object.prototype property names', async () => {
                    await assertMatchesReference([
                        'constructor __proto__ hasOwnProperty toString valueOf',
                        'constructor prototype isPrototypeOf __defineGetter__',
                        'unrelated content without special names',
                    ])
                })

                it('for repeated terms (term frequency > 1)', async () => {
                    await assertMatchesReference([
                        'repeat repeat repeat unique',
                        'repeat other other',
                        'something else entirely different',
                    ])
                })
            })

            it('should yield to the event loop during analysis', async () => {
                // Make every check see the yield interval as elapsed, so the analysis yields at each step
                let now = 0
                sinon.stub(Date, 'now').callsFake(() => (now += 1000))

                const files = Array.from({ length: 5 }, (_, i) => ({ path: `file${i}.ts`, size: 10 }))
                files.forEach((_, i) =>
                    mockFs.readFile.onCall(i).resolves(`function handler${i}() { return value${i} }`)
                )

                let timerFired = false
                setTimeout(() => (timerFired = true), 0)

                await controller.calculateLexicalDissimilarity(files)

                assert.ok(timerFired, 'expected a macrotask to run while the analysis was in progress')
            })
        })

        describe('executeGuidelinesGenerationPipeline file size filter', () => {
            const file = (name: string) => ({ name, isDirectory: () => false })

            beforeEach(() => {
                mockWorkspace.getAllWorkspaceFolders = sinon.stub().returns([{ uri: '/workspace', name: 'workspace' }])
                mockFs.readdir
                    .withArgs('/workspace')
                    .resolves([file('small.ts'), file('generated.ts'), file('long.ts')])
                // Few lines but far more than 20,000 characters (e.g. an inlined, generated blob)
                mockFs.readFile.withArgs('/workspace/generated.ts').resolves('x'.repeat(50000))
                // Under 20,000 characters but many lines
                mockFs.readFile.withArgs('/workspace/long.ts').resolves('let a = 1\n'.repeat(1500))
                mockFs.readFile.withArgs('/workspace/small.ts').resolves('export const answer = 42\n')
            })

            it('excludes files over 20,000 characters even when they have few lines', async () => {
                const result = await controller.executeGuidelinesGenerationPipeline('/workspace')

                const analyzed = result.discoveredFiles.map(f => f.path).sort()
                assert.deepStrictEqual(analyzed, ['/workspace/long.ts', '/workspace/small.ts'])
            })

            it('keeps line counts as the reported size', async () => {
                const result = await controller.executeGuidelinesGenerationPipeline('/workspace')

                const long = result.discoveredFiles.find(f => f.path === '/workspace/long.ts')
                assert.strictEqual(long?.size, 1501)
            })
        })

        it('should provide TF-IDF analysis methods', () => {
            assert.ok(typeof controller.discoverAllSourceFiles === 'function')
            assert.ok(typeof controller.calculateFileLineCount === 'function')
            assert.ok(typeof controller.calculateLexicalDissimilarity === 'function')
            assert.ok(typeof controller.executeGuidelinesGenerationPipeline === 'function')
        })

        it('should format files for ranking correctly', () => {
            const files = [
                { path: 'test1.ts', size: 100, dissimilarity: 0.85 },
                { path: 'test2.ts', size: 200, dissimilarity: 0.75 },
            ]

            const formatted = controller.formatFilesForRanking(files)

            assert.ok(typeof formatted === 'string')
            assert.ok(formatted.includes('test1.ts has 100 lines'))
            assert.ok(formatted.includes('test2.ts has 200 lines'))
            assert.ok(formatted.includes('0.850000'))
            assert.ok(formatted.includes('0.750000'))
        })
    })

    describe('memoryBankExists', () => {
        const workspaceFolder = '/test/workspace'

        it('should return false if memory bank directory does not exist', async () => {
            mockFs.exists.resolves(false)

            const result = await controller.memoryBankExists(workspaceFolder)

            assert.strictEqual(result, false)
            sinon.assert.calledOnce(mockFs.exists)
        })

        it('should return false if directory exists but no files exist', async () => {
            mockFs.exists.onFirstCall().resolves(true) // directory exists
            mockFs.exists.onSecondCall().resolves(false) // product.md doesn't exist
            mockFs.exists.onThirdCall().resolves(false) // structure.md doesn't exist
            mockFs.exists.onCall(3).resolves(false) // tech.md doesn't exist
            mockFs.exists.onCall(4).resolves(false) // guidelines.md doesn't exist

            const result = await controller.memoryBankExists(workspaceFolder)

            assert.strictEqual(result, false)
        })

        it('should return true if directory exists and at least one file exists', async () => {
            mockFs.exists.onFirstCall().resolves(true) // directory exists
            mockFs.exists.onSecondCall().resolves(true) // product.md exists

            const result = await controller.memoryBankExists(workspaceFolder)

            assert.strictEqual(result, true)
        })

        it('should handle filesystem errors gracefully', async () => {
            mockFs.exists.rejects(new Error('File system error'))

            const result = await controller.memoryBankExists(workspaceFolder)

            assert.strictEqual(result, false)
            sinon.assert.calledOnce(mockLogging.error)
        })
    })
})
