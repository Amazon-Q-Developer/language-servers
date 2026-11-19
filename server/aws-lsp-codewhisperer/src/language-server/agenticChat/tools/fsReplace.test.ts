import { testFolder } from '@aws/lsp-core'
import * as path from 'path'
import * as assert from 'assert'
import * as fs from 'fs/promises'
import { InvokeOutput } from './toolShared'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import { Workspace } from '@aws/language-server-runtimes/server-interface'
import { StubbedInstance } from 'ts-sinon'
import { FsReplace, ReplaceParams } from './fsReplace'
import * as os from 'os'
import { withCheckedFileOperations, checkedTarget } from './checkedFileFixtures.test'

describe('FsReplace Tool', function () {
    let tempFolder: testFolder.TestFolder
    let features: TestFeatures
    const expectedOutput: InvokeOutput = {
        output: {
            kind: 'text',
            content: 'File updated successfully',
        },
    }

    before(async function () {
        features = new TestFeatures()
        features.workspace = {
            // @ts-ignore writing a file does not require all of fs to be implemented
            fs: {
                writeFile: fs.writeFile,
                readFile: (path, options?) =>
                    fs.readFile(path, { encoding: (options?.encoding || 'utf-8') as BufferEncoding }),
                exists: path =>
                    fs
                        .access(path)
                        .then(() => true)
                        .catch(() => false),
            } as Workspace['fs'],
        } as StubbedInstance<Workspace>
        features.workspace.fs = withCheckedFileOperations(features.workspace.fs) as typeof features.workspace.fs
        tempFolder = await testFolder.TestFolder.create()
    })

    afterEach(async function () {
        await tempFolder.clear()
    })

    after(async function () {
        await tempFolder.delete()
    })

    describe('handleReplace', async function () {
        before(async function () {
            tempFolder = await testFolder.TestFolder.create()
        })

        it('replaces a single occurrence of a string', async function () {
            const filePath = path.join(tempFolder.path, 'file1.txt')
            await fs.writeFile(filePath, 'Hello World')

            const params: ReplaceParams = {
                path: filePath,
                diffs: [
                    {
                        oldStr: 'Hello',
                        newStr: 'Goodbye',
                    },
                ],
            }
            const fsReplace = new FsReplace(features)
            const output = await fsReplace.invoke(params, await checkedTarget(params.path))

            const content = await features.workspace.fs.readFile(filePath)
            assert.strictEqual(content, 'Goodbye World')

            assert.deepStrictEqual(output.output, expectedOutput.output)
        })

        it('throws error when no matches are found', async function () {
            const filePath = await tempFolder.write('file1.txt', 'some text is here')

            const params: ReplaceParams = {
                path: filePath,
                diffs: [
                    {
                        oldStr: 'Invalid',
                        newStr: 'Goodbye',
                    },
                ],
            }

            const fsReplace = new FsReplace(features)
            await assert.rejects(
                async () => fsReplace.invoke(params, await checkedTarget(params.path)),
                /No occurrences of "Invalid" were found/
            )
        })

        it('throws error when multiple matches are found', async function () {
            const filePath = path.join(tempFolder.path, 'file2.txt')
            await fs.writeFile(filePath, 'Hello Hello World')

            const params: ReplaceParams = {
                path: filePath,
                diffs: [
                    {
                        oldStr: 'Hello',
                        newStr: 'Goodbye',
                    },
                ],
            }

            const fsReplace = new FsReplace(features)
            await assert.rejects(
                async () => fsReplace.invoke(params, await checkedTarget(params.path)),
                /Multiple occurrences of "Hello" were found when only 1 is expected/
            )
        })

        it('handles regular expression special characters correctly', async function () {
            const filePath = path.join(tempFolder.path, 'file3.txt')
            await fs.writeFile(filePath, 'Text with special chars: .*+?^${}()|[]\\')

            const params: ReplaceParams = {
                path: filePath,
                diffs: [
                    {
                        oldStr: '.*+?^${}()|[]\\',
                        newStr: 'REPLACED',
                    },
                ],
            }
            const fsReplace = new FsReplace(features)
            const output = await fsReplace.invoke(params, await checkedTarget(params.path))

            const content = await features.workspace.fs.readFile(filePath)
            assert.strictEqual(content, 'Text with special chars: REPLACED')

            assert.deepStrictEqual(output.output, expectedOutput.output)
        })

        it('preserves whitespace and newlines during replacement', async function () {
            const filePath = path.join(tempFolder.path, 'file4.txt')
            await fs.writeFile(filePath, 'Line 1\n  Indented line\nLine 3')

            const params: ReplaceParams = {
                path: filePath,
                diffs: [
                    {
                        oldStr: '  Indented line\n',
                        newStr: '    Double indented\n',
                    },
                ],
            }
            const fsReplace = new FsReplace(features)
            const output = await fsReplace.invoke(params, await checkedTarget(params.path))

            const content = await features.workspace.fs.readFile(filePath)
            assert.strictEqual(content, 'Line 1\n    Double indented\nLine 3')

            assert.deepStrictEqual(output.output, expectedOutput.output)
        })
    })

    describe('getStrReplaceContent', function () {
        it('preserves CRLF line endings in file when oldStr uses LF', async () => {
            const filePath = await tempFolder.write('test1.txt', 'before\r\nline 1\r\nline 2\r\nline 3\r\nafter')

            const params: ReplaceParams = {
                path: filePath,
                diffs: [
                    {
                        oldStr: 'line 1\nline 2\nline 3',
                        newStr: 'new line 1\nnew line 2\nnew line 3',
                    },
                ],
            }

            const fsReplace = new FsReplace(features)
            await fsReplace.invoke(params, await checkedTarget(params.path))

            const result = await features.workspace.fs.readFile(filePath)
            assert.strictEqual(result, 'before\r\nnew line 1\r\nnew line 2\r\nnew line 3\r\nafter')
        })

        it('preserves LF line endings in file when oldStr uses CRLF', async () => {
            const filePath = await tempFolder.write('test2.txt', 'before\nline 1\nline 2\nline 3\nafter')

            const params: ReplaceParams = {
                path: filePath,
                diffs: [
                    {
                        oldStr: 'line 1\r\nline 2\r\nline 3',
                        newStr: 'new line 1\r\nnew line 2\r\nnew line 3',
                    },
                ],
            }

            const fsReplace = new FsReplace(features)
            await fsReplace.invoke(params, await checkedTarget(params.path))

            const result = await features.workspace.fs.readFile(filePath)
            assert.strictEqual(result, 'before\nnew line 1\nnew line 2\nnew line 3\nafter')
        })

        it('preserves CR line endings in file when oldStr uses LF', async () => {
            const filePath = await tempFolder.write('test3.txt', 'before\rline 1\rline 2\rline 3\rafter')

            const params: ReplaceParams = {
                path: filePath,
                diffs: [
                    {
                        oldStr: 'line 1\nline 2\nline 3',
                        newStr: 'new line 1\nnew line 2\nnew line 3',
                    },
                ],
            }

            const fsReplace = new FsReplace(features)
            await fsReplace.invoke(params, await checkedTarget(params.path))

            const result = await features.workspace.fs.readFile(filePath)
            assert.strictEqual(result, 'before\rnew line 1\rnew line 2\rnew line 3\rafter')
        })

        it('handles mixed line endings in newStr by normalizing to file line ending', async () => {
            const filePath = await tempFolder.write('test4.txt', 'before\r\nline 1\r\nline 2\r\nafter')

            const params: ReplaceParams = {
                path: filePath,
                diffs: [
                    {
                        oldStr: 'line 1\nline 2',
                        newStr: 'new line 1\r\nnew line 2\nnew line 3\rend',
                    },
                ],
            }

            const fsReplace = new FsReplace(features)
            await fsReplace.invoke(params, await checkedTarget(params.path))

            const result = await features.workspace.fs.readFile(filePath)
            assert.strictEqual(result, 'before\r\nnew line 1\r\nnew line 2\r\nnew line 3\r\nend\r\nafter')
        })

        it('handles content with no line endings', async () => {
            const filePath = await tempFolder.write('test5.txt', 'before simple text after')

            const params: ReplaceParams = {
                path: filePath,
                diffs: [
                    {
                        oldStr: 'simple text',
                        newStr: 'replacement',
                    },
                ],
            }

            const fsReplace = new FsReplace(features)
            await fsReplace.invoke(params, await checkedTarget(params.path))

            const result = await features.workspace.fs.readFile(filePath)
            assert.strictEqual(result, 'before replacement after')
        })

        it('uses OS default line ending when file has no line endings and adding new lines', async () => {
            const filePath = await tempFolder.write('test6.txt', 'before text after')

            const params: ReplaceParams = {
                path: filePath,
                diffs: [
                    {
                        oldStr: 'text',
                        newStr: 'line 1\nline 2',
                    },
                ],
            }

            const fsReplace = new FsReplace(features)
            await fsReplace.invoke(params, await checkedTarget(params.path))

            const result = await features.workspace.fs.readFile(filePath)
            assert.strictEqual(result, `before line 1${os.EOL}line 2 after`)
        })

        it('preserves line endings when only portion of line is replaced', async () => {
            const filePath = await tempFolder.write('test8.txt', 'start\r\nprefix middle suffix\r\nend')

            const params: ReplaceParams = {
                path: filePath,
                diffs: [
                    {
                        oldStr: 'middle',
                        newStr: 'center',
                    },
                ],
            }

            const fsReplace = new FsReplace(features)
            await fsReplace.invoke(params, await checkedTarget(params.path))

            const result = await features.workspace.fs.readFile(filePath)
            assert.strictEqual(result, 'start\r\nprefix center suffix\r\nend')
        })
    })
})
