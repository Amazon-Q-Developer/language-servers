import * as path from 'path'
import * as sinon from 'sinon'
import * as assert from 'assert'
import { expect } from 'chai'
import {
    getUserPromptsDirectory,
    getNewPromptFilePath,
    promptFileExtension,
    mergeRelevantTextDocuments,
    mergeFileLists,
    getCodeSymbolDescription,
    truncateContextContent,
} from './contextUtils'
import * as pathUtils from '@aws/lsp-core/out/util/path'
import { sanitizeFilename } from '@aws/lsp-core/out/util/text'
import { FileList } from '@aws/language-server-runtimes/server-interface'
import { RelevantTextDocumentAddition } from './agenticChatTriggerContext'
import { ContextCommandItem } from 'local-indexing'

describe('contextUtils', () => {
    let getUserHomeDirStub: sinon.SinonStub

    beforeEach(() => {
        getUserHomeDirStub = sinon.stub(pathUtils, 'getUserHomeDir')

        // Default behavior
        getUserHomeDirStub.returns('/home/user')
    })

    afterEach(() => {
        sinon.restore()
    })

    describe('getUserPromptsDirectory', () => {
        it('should return the correct prompts directory path', () => {
            const result = getUserPromptsDirectory()
            assert.strictEqual(result, path.join('/home/user', '.aws', 'amazonq', 'prompts'))
        })
    })

    describe('getNewPromptFilePath', () => {
        it('should use default name when promptName is empty', () => {
            const result = getNewPromptFilePath('')
            assert.strictEqual(
                result,
                path.join('/home/user', '.aws', 'amazonq', 'prompts', `default${promptFileExtension}`)
            )
        })

        it('should use default name when promptName is undefined', () => {
            const result = getNewPromptFilePath(undefined as unknown as string)
            assert.strictEqual(
                result,
                path.join('/home/user', '.aws', 'amazonq', 'prompts', `default${promptFileExtension}`)
            )
        })

        it('should trim whitespace from promptName', () => {
            const result = getNewPromptFilePath('  test-prompt  ')
            const expectedSanitized = sanitizeFilename('test-prompt')
            assert.strictEqual(
                result,
                path.join('/home/user', '.aws', 'amazonq', 'prompts', `${expectedSanitized}${promptFileExtension}`)
            )
        })

        it('should truncate promptName if longer than 100 characters', () => {
            const longName = 'a'.repeat(150)
            const truncatedName = 'a'.repeat(100)

            const result = getNewPromptFilePath(longName)
            const expectedSanitized = sanitizeFilename(truncatedName)

            assert.strictEqual(
                result,
                path.join('/home/user', '.aws', 'amazonq', 'prompts', `${expectedSanitized}${promptFileExtension}`)
            )
        })

        it('should sanitize the filename using sanitizeFilename', () => {
            const unsafeName = 'unsafe/name?with:invalid*chars'
            const expectedSanitized = sanitizeFilename(path.basename(unsafeName))

            const result = getNewPromptFilePath(unsafeName)

            assert.strictEqual(
                result,
                path.join('/home/user', '.aws', 'amazonq', 'prompts', `${expectedSanitized}${promptFileExtension}`)
            )
        })

        it('should handle path traversal attempts', () => {
            const traversalPath = '../../../etc/passwd'
            const expectedSanitized = sanitizeFilename(path.basename(traversalPath))

            const result = getNewPromptFilePath(traversalPath)

            assert.strictEqual(
                result,
                path.join('/home/user', '.aws', 'amazonq', 'prompts', `${expectedSanitized}${promptFileExtension}`)
            )
        })
    })

    describe('mergeRelevantTextDocuments', () => {
        it('should return empty FileList when input array is empty', () => {
            const result = mergeRelevantTextDocuments([])
            expect(result.filePaths).to.be.an('array').that.is.empty
            expect(result.details).to.deep.equal({})
        })

        it('should skip documents with missing required fields', () => {
            const docs: RelevantTextDocumentAddition[] = [
                {
                    text: 'content',
                    path: '/path/to/file.js',
                    relativeFilePath: undefined, // Missing required field
                    startLine: 1,
                    endLine: 5,
                } as unknown as RelevantTextDocumentAddition,
                {
                    text: 'content',
                    path: '/path/to/file2.js',
                    relativeFilePath: 'file2.js',
                    startLine: undefined, // Missing required field
                    endLine: 10,
                } as unknown as RelevantTextDocumentAddition,
            ]

            const result = mergeRelevantTextDocuments(docs)
            expect(result.filePaths).to.be.an('array').that.is.empty
            expect(result.details).to.deep.equal({})
        })

        it('should merge overlapping line ranges for the same file', () => {
            const docs: RelevantTextDocumentAddition[] = [
                {
                    text: 'content1',
                    path: '/path/to/file.js',
                    relativeFilePath: 'file.js',
                    startLine: 1,
                    endLine: 5,
                } as RelevantTextDocumentAddition,
                {
                    text: 'content2',
                    path: '/path/to/file.js',
                    relativeFilePath: 'file.js',
                    startLine: 4,
                    endLine: 8,
                } as RelevantTextDocumentAddition,
                {
                    text: 'content3',
                    path: '/path/to/file.js',
                    relativeFilePath: 'file.js',
                    startLine: 10,
                    endLine: 15,
                } as RelevantTextDocumentAddition,
            ]

            const result = mergeRelevantTextDocuments(docs)
            expect(result.filePaths).to.deep.equal(['file.js'])
            expect(result.details?.['file.js'].lineRanges).to.deep.equal([
                { first: 1, second: 8 },
                { first: 10, second: 15 },
            ])
        })

        it('should handle multiple files correctly', () => {
            const docs: RelevantTextDocumentAddition[] = [
                {
                    text: 'content1',
                    path: '/path/to/file1.js',
                    relativeFilePath: 'file1.js',
                    startLine: 1,
                    endLine: 5,
                } as RelevantTextDocumentAddition,
                {
                    text: 'content2',
                    path: '/path/to/file2.js',
                    relativeFilePath: 'file2.js',
                    startLine: 10,
                    endLine: 15,
                } as RelevantTextDocumentAddition,
            ]

            const result = mergeRelevantTextDocuments(docs)
            expect(result.filePaths).to.have.members(['file1.js', 'file2.js'])
            expect(result.details?.['file1.js'].lineRanges).to.deep.equal([{ first: 1, second: 5 }])
            expect(result.details?.['file2.js'].lineRanges).to.deep.equal([{ first: 10, second: 15 }])
        })
    })

    describe('mergeFileLists', () => {
        it('should return second FileList when first is empty', () => {
            const fileList1: FileList = { filePaths: [], details: {} }
            const fileList2: FileList = {
                filePaths: ['file.js'],
                details: {
                    'file.js': {
                        fullPath: 'file.js',
                        lineRanges: [{ first: 1, second: 5 }],
                    },
                },
            }

            const result = mergeFileLists(fileList1, fileList2)
            expect(result).to.deep.equal(fileList2)
        })

        it('should return first FileList when second is empty', () => {
            const fileList1: FileList = {
                filePaths: ['file.js'],
                details: {
                    'file.js': {
                        fullPath: 'file.js',
                        lineRanges: [{ first: 1, second: 5 }],
                    },
                },
            }
            const fileList2: FileList = { filePaths: [], details: {} }

            const result = mergeFileLists(fileList1, fileList2)
            expect(result).to.deep.equal(fileList1)
        })

        it('should merge non-overlapping files from both lists', () => {
            const fileList1: FileList = {
                filePaths: ['file1.js'],
                details: {
                    'file1.js': {
                        fullPath: 'file1.js',
                        lineRanges: [{ first: 1, second: 5 }],
                    },
                },
            }
            const fileList2: FileList = {
                filePaths: ['file2.js'],
                details: {
                    'file2.js': {
                        fullPath: 'file2.js',
                        lineRanges: [{ first: 10, second: 15 }],
                    },
                },
            }

            const result = mergeFileLists(fileList1, fileList2)
            expect(result.filePaths).to.have.members(['file1.js', 'file2.js'])
            expect(result.details?.['file1.js'].lineRanges).to.deep.equal([{ first: 1, second: 5 }])
            expect(result.details?.['file2.js'].lineRanges).to.deep.equal([{ first: 10, second: 15 }])
        })

        it('should merge overlapping line ranges for the same file', () => {
            const fileList1: FileList = {
                filePaths: ['file.js'],
                details: {
                    'file.js': {
                        fullPath: 'file.js',
                        lineRanges: [
                            { first: 1, second: 5 },
                            { first: 10, second: 15 },
                        ],
                    },
                },
            }
            const fileList2: FileList = {
                filePaths: ['file.js'],
                details: {
                    'file.js': {
                        fullPath: 'file.js',
                        lineRanges: [
                            { first: 4, second: 8 },
                            { first: 20, second: 25 },
                        ],
                    },
                },
            }

            const result = mergeFileLists(fileList1, fileList2)
            expect(result.filePaths).to.deep.equal(['file.js'])
            expect(result.details?.['file.js'].lineRanges).to.deep.equal([
                { first: 1, second: 8 },
                { first: 10, second: 15 },
                { first: 20, second: 25 },
            ])
        })

        it('should handle consecutive ranges by merging them', () => {
            const fileList1: FileList = {
                filePaths: ['file.js'],
                details: {
                    'file.js': {
                        fullPath: 'file.js',
                        lineRanges: [{ first: 1, second: 5 }],
                    },
                },
            }
            const fileList2: FileList = {
                filePaths: ['file.js'],
                details: {
                    'file.js': {
                        fullPath: 'file.js',
                        lineRanges: [{ first: 6, second: 10 }],
                    },
                },
            }

            const result = mergeFileLists(fileList1, fileList2)
            expect(result.filePaths).to.deep.equal(['file.js'])
            expect(result.details?.['file.js'].lineRanges).to.deep.equal([{ first: 1, second: 10 }])
        })

        it('should handle undefined lineRanges', () => {
            const fileList1: FileList = {
                filePaths: ['file.js'],
                details: {
                    'file.js': {
                        fullPath: 'file.js',
                        lineRanges: undefined,
                    },
                },
            }
            const fileList2: FileList = {
                filePaths: ['file.js'],
                details: {
                    'file.js': {
                        fullPath: 'file.js',
                        lineRanges: [{ first: 1, second: 5 }],
                    },
                },
            }

            const result = mergeFileLists(fileList1, fileList2)
            expect(result.filePaths).to.deep.equal(['file.js'])
            expect(result.details?.['file.js'].lineRanges).to.deep.equal([{ first: 1, second: 5 }])
        })
    })

    describe('getCodeSymbolDescription', () => {
        it('should return empty string when no symbol exists', () => {
            const item = {
                workspaceFolder: '/workspace',
                type: 'file',
                relativePath: 'src/file.ts',
                id: 'id1',
                // No symbol property
            } as ContextCommandItem

            const result = getCodeSymbolDescription(item)
            expect(result).to.equal('')
        })

        it('should format description without line numbers', () => {
            const item = {
                workspaceFolder: '/workspace',
                type: 'file',
                relativePath: 'src/utils.ts',
                id: 'id1',
                symbol: {
                    kind: 'Function',
                    name: 'myFunction',
                    range: {
                        start: { line: 9, column: 0 },
                        end: { line: 19, column: 1 },
                    },
                },
            } as ContextCommandItem

            const result = getCodeSymbolDescription(item, false)
            expect(result).to.equal(`Function, ${path.join('workspace', 'src', 'utils.ts')}`)
        })

        it('should format description with line numbers', () => {
            const item = {
                workspaceFolder: '/workspace',
                type: 'file',
                relativePath: 'src/utils.ts',
                id: 'id1',
                symbol: {
                    kind: 'Class',
                    name: 'MyClass',
                    range: {
                        start: { line: 9, column: 0 },
                        end: { line: 19, column: 1 },
                    },
                },
            } as ContextCommandItem

            const result = getCodeSymbolDescription(item, true)
            expect(result).to.equal(`Class, ${path.join('workspace', 'src', 'utils.ts')}, L10-20`)
        })

        it('should handle different workspace folder names', () => {
            const item = {
                workspaceFolder: '/projects/my-project',
                type: 'file',
                relativePath: 'src/utils.ts',
                id: 'id1',
                symbol: {
                    kind: 'Method',
                    name: 'myMethod',
                    range: {
                        start: { line: 4, column: 2 },
                        end: { line: 7, column: 3 },
                    },
                },
            } as ContextCommandItem

            const result = getCodeSymbolDescription(item, true)
            expect(result).to.equal(`Method, ${path.join('my-project', 'src', 'utils.ts')}, L5-8`)
        })

        it('should handle different symbol kinds', () => {
            const item = {
                workspaceFolder: '/workspace',
                type: 'file',
                relativePath: 'src/models.ts',
                id: 'id1',
                symbol: {
                    kind: 'Interface',
                    name: 'MyInterface',
                    range: {
                        start: { line: 0, column: 0 },
                        end: { line: 5, column: 1 },
                    },
                },
            } as ContextCommandItem

            const result = getCodeSymbolDescription(item, false)
            expect(result).to.equal(`Interface, ${path.join('workspace', 'src', 'models.ts')}`)
        })
    })

    describe('truncateContextContent', () => {
        it('returns content unchanged when it fits within the limit', () => {
            const content = 'short content'
            expect(truncateContextContent(content, 100)).to.equal(content)
        })

        it('returns content unchanged when it is exactly the limit', () => {
            const content = 'a'.repeat(50)
            expect(truncateContextContent(content, 50)).to.equal(content)
        })

        it('appends a truncation marker and never exceeds the limit', () => {
            const lines = Array.from({ length: 1000 }, (_, i) => `This is line ${i + 1} of a large file.`)
            const content = lines.join('\n')
            const maxLength = 4096

            const result = truncateContextContent(content, maxLength)

            expect(result.length).to.equal(maxLength)
            expect(result.startsWith('This is line 1 of a large file.')).to.equal(true)
            expect(result).to.include('[Content truncated:')
            expect(result).to.include(`${content.length} characters`)
            // The marker must be the tail of the result so the model sees it after the excerpt
            expect(result.endsWith('Read the file directly to see the rest.]')).to.equal(true)
        })

        it('falls back to a plain cut when the limit is too small for the marker', () => {
            const content = 'x'.repeat(500)
            const result = truncateContextContent(content, 10)

            expect(result).to.equal('x'.repeat(10))
        })
    })
})
