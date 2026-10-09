import { AppendParams, CreateParams, FsWrite } from './fsWrite'
import { testFolder } from '@aws/lsp-core'
import * as path from 'path'
import * as assert from 'assert'
import * as fs from 'fs/promises'
import { InvokeOutput } from './toolShared'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import { Workspace } from '@aws/language-server-runtimes/server-interface'
import { StubbedInstance } from 'ts-sinon'
import * as sinon from 'sinon'
import { LocalProjectContextController } from '../../../shared/localProjectContextController'
import { URI } from 'vscode-uri'

describe('FsWrite Tool', function () {
    let tempFolder: testFolder.TestFolder
    let features: TestFeatures
    let localProjectContextControllerStub: sinon.SinonStub
    let mockController: {
        updateIndexAndContextCommand: sinon.SinonStub
    }
    const expectedOutput: InvokeOutput = {
        output: {
            kind: 'text',
            content: 'File created successfully',
        },
    }
    const expectedOutputAppend: InvokeOutput = {
        output: {
            kind: 'text',
            content: 'File appended successfully',
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
        tempFolder = await testFolder.TestFolder.create()

        // Set up LocalProjectContextController mock
        mockController = {
            updateIndexAndContextCommand: sinon.stub().resolves(),
        }
        localProjectContextControllerStub = sinon
            .stub(LocalProjectContextController, 'getInstance')
            .resolves(mockController as any)
    })

    afterEach(async function () {
        await tempFolder.clear()
        // Reset the mock between tests
        mockController.updateIndexAndContextCommand.resetHistory()
    })

    after(async function () {
        await tempFolder.delete()
        // Restore the stub
        localProjectContextControllerStub.restore()
    })

    it('writes a empty space to updates stream', async function () {
        const fsRead = new FsWrite(features)
        const chunks: string[] = []
        const stream = new WritableStream({
            write: c => {
                chunks.push(c)
            },
        })
        await fsRead.queueDescription(stream)
        assert.strictEqual(chunks.length, 1)
        assert.ok(chunks[0], ' ')
        assert.ok(!stream.locked)
    })

    describe('handleCreate', function () {
        it('creates a new file with fileText content', async function () {
            const filePath = path.join(tempFolder.path, 'file1.txt')
            const fileExists = await features.workspace.fs.exists(filePath)
            assert.ok(!fileExists)

            const params: CreateParams = {
                command: 'create',
                fileText: 'Hello World',
                path: filePath,
            }
            const fsWrite = new FsWrite(features)
            const output = await fsWrite.invoke(params)

            const content = await features.workspace.fs.readFile(filePath)
            assert.strictEqual(content, 'Hello World')

            assert.deepStrictEqual(output, expectedOutput)

            // Verify LocalProjectContextController was called
            assert.ok(localProjectContextControllerStub.calledOnce)

            // Wait a bit for the async void call to complete
            await new Promise(resolve => setTimeout(resolve, 10))

            // Verify updateIndexAndContextCommand was called with correct parameters.
            // The tool writes to the resolved path, so the indexed path is the
            // canonical one (on Windows that expands 8.3 short names such as
            // RUNNER~1 to their long form).
            assert.ok(mockController.updateIndexAndContextCommand.calledOnce)
            const [paths, isAdded] = mockController.updateIndexAndContextCommand.firstCall.args
            assert.deepStrictEqual(paths, [URI.file(await fs.realpath(filePath)).fsPath])
            assert.strictEqual(isAdded, true)
        })

        it('replaces existing file with fileText content', async function () {
            const filePath = await tempFolder.write('file1.txt', 'Hello World')
            const fileExists = await features.workspace.fs.exists(filePath)
            assert.ok(fileExists)

            const params: CreateParams = {
                command: 'create',
                fileText: 'Goodbye',
                path: filePath,
            }
            const fsWrite = new FsWrite(features)
            const output = await fsWrite.invoke(params)

            const content = await features.workspace.fs.readFile(filePath)
            assert.strictEqual(content, 'Goodbye')

            assert.deepStrictEqual(output, expectedOutput)
        })
    })

    describe('handleAppend', function () {
        it('appends text to the end of a file', async function () {
            const filePath = path.join(tempFolder.path, 'file1.txt')
            await fs.writeFile(filePath, 'Line 1\nLine 2\nLine 3\n')

            const params: AppendParams = {
                command: 'append',
                path: filePath,
                fileText: 'Line 4',
            }

            const fsWrite = new FsWrite(features)
            const output = await fsWrite.invoke(params)

            const newContent = await features.workspace.fs.readFile(filePath)
            assert.strictEqual(newContent, 'Line 1\nLine 2\nLine 3\nLine 4')

            assert.deepStrictEqual(output, expectedOutputAppend)
        })

        it('adds a newline before appending if file does not end with one', async function () {
            const filePath = path.join(tempFolder.path, 'file2.txt')
            await fs.writeFile(filePath, 'Line 1\nLine 2\nLine 3')

            const params: AppendParams = {
                command: 'append',
                path: filePath,
                fileText: 'Line 4',
            }

            const fsWrite = new FsWrite(features)
            const output = await fsWrite.invoke(params)

            const newContent = await features.workspace.fs.readFile(filePath)
            assert.strictEqual(newContent, 'Line 1\nLine 2\nLine 3\nLine 4')

            assert.deepStrictEqual(output, expectedOutputAppend)
        })

        it('appends to an empty file', async function () {
            const filePath = path.join(tempFolder.path, 'file3.txt')
            await fs.writeFile(filePath, '')

            const params: AppendParams = {
                command: 'append',
                path: filePath,
                fileText: 'Line 1',
            }
            const fsWrite = new FsWrite(features)
            const output = await fsWrite.invoke(params)

            const newContent = await features.workspace.fs.readFile(filePath)
            assert.strictEqual(newContent, 'Line 1')

            assert.deepStrictEqual(output, expectedOutputAppend)
        })

        it('appends multiple lines correctly', async function () {
            const filePath = await tempFolder.write('multiLineAppend.txt', 'Line 1')

            const params: AppendParams = {
                command: 'append',
                path: filePath,
                fileText: 'Line 2\nLine 3',
            }
            const fsWrite = new FsWrite(features)
            const output = await fsWrite.invoke(params)

            const newContent = await features.workspace.fs.readFile(filePath)
            assert.strictEqual(newContent, 'Line 1\nLine 2\nLine 3')

            assert.deepStrictEqual(output, expectedOutputAppend)
        })

        it('throws error when file does not exist', async function () {
            const filePath = path.join(tempFolder.path, 'nonexistent.txt')

            const params: AppendParams = {
                command: 'append',
                path: filePath,
                fileText: 'New Line',
            }

            const fsWrite = new FsWrite(features)
            await assert.rejects(() => fsWrite.invoke(params), /no such file or directory/)
        })
    })
})
