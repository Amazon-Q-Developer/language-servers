import * as assert from 'assert'
import { FileReadResult, FsRead } from './fsRead'
import * as path from 'path'
import * as fs from 'fs/promises'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import { TextDocument, Workspace } from '@aws/language-server-runtimes/server-interface'
import { testFolder } from '@aws/lsp-core'
import { StubbedInstance } from 'ts-sinon'

describe('FsRead Tool', () => {
    let features: TestFeatures
    let tempFolder: testFolder.TestFolder

    before(async () => {
        features = new TestFeatures()
        features.workspace = {
            // @ts-ignore reading a file does not require all of fs to be implemented.
            fs: {
                readFile: (path, options?) =>
                    fs.readFile(path, { encoding: (options?.encoding || 'utf-8') as BufferEncoding }),
                readdir: path => fs.readdir(path, { withFileTypes: true }),
                exists: path =>
                    fs
                        .access(path)
                        .then(() => true)
                        .catch(() => false),
            } as Workspace['fs'],
        } as StubbedInstance<Workspace>
        tempFolder = await testFolder.TestFolder.create()
    })

    after(async () => {
        await tempFolder.delete()
    })

    afterEach(async () => {
        await tempFolder.clear()
    })

    it('invalidates empty path', async () => {
        const fsRead = new FsRead(features)
        await assert.rejects(
            fsRead.validate({ paths: [''] }),
            /Path cannot be empty/i,
            'Expected an error about empty path'
        )
    })

    it('invalidates non-existent paths', async () => {
        const filePath = path.join(tempFolder.path, 'no_such_file.txt')
        const fsRead = new FsRead(features)

        await assert.rejects(
            fsRead.validate({ paths: [filePath] }),
            /does not exist or cannot be accessed/i,
            'Expected an error indicating the path does not exist'
        )
    })

    it('truncate output if too large', async () => {
        const fileContent = 'A'.repeat(FsRead.maxResponseSize + 10)
        const filePath = await tempFolder.write('largeFile.txt', fileContent)
        const fsRead = new FsRead(features)
        await fsRead.validate({ paths: [filePath] })
        const result = await fsRead.invoke({ paths: [filePath] })

        verifyResult(result, [
            { path: filePath, content: 'A'.repeat(FsRead.maxResponseSize - 3) + '...', truncated: true },
        ])
    })

    it('reads entire file', async () => {
        const fileContent = 'Line 1\nLine 2\nLine 3'
        const filePath = await tempFolder.write('fullFile.txt', fileContent)

        const fsRead = new FsRead(features)
        const result = await fsRead.invoke({ paths: [filePath] })
        verifyResult(result, [{ path: filePath, content: fileContent, truncated: false }])
    })

    it('reads multiple files', async () => {
        const fileContent = 'Line 1\nLine 2\nLine 3'
        const fileContent1 = 'Line 1\n'
        const filePath = await tempFolder.write('fullFile.txt', fileContent)
        const filePath1 = await tempFolder.write('fullFile1.txt', fileContent1)

        const fsRead = new FsRead(features)
        const result = await fsRead.invoke({ paths: [filePath, filePath1] })
        verifyResult(result, [
            { path: filePath, content: fileContent, truncated: false },
            { path: filePath1, content: fileContent1, truncated: false },
        ])
    })

    it('should require acceptance if fsPath is outside the workspace', async () => {
        const fsRead = new FsRead({
            ...features,
            workspace: {
                ...features.workspace,
                getTextDocument: async s => undefined,
            },
        })
        const result = await fsRead.requiresAcceptance({ paths: ['/not/in/workspace/file.txt'] })
        assert.equal(
            result.requiresAcceptance,
            true,
            'Expected requiresAcceptance to be true for a path outside the workspace'
        )
    })

    it('should not require acceptance if fsPath is inside the workspace', async () => {
        const fsRead = new FsRead({
            ...features,
            lsp: {
                ...features.lsp,
            },
            workspace: {
                ...features.workspace,
                getTextDocument: async s => ({}) as TextDocument,
                getAllWorkspaceFolders: () => [{ uri: 'file:///workspace/folder', name: 'workspace' }],
            },
        })
        const result = await fsRead.requiresAcceptance({ paths: ['/workspace/folder/file.txt'] })
        assert.equal(
            result.requiresAcceptance,
            false,
            'Expected requiresAcceptance to be false for a path inside the workspace'
        )
    })

    it('should require acceptance for an in-workspace name that a hard link shares with a file outside it', async function () {
        if (process.platform === 'win32') {
            this.skip()
            return
        }

        // A file outside the workspace, given a second name inside it. lstat
        // reports that name as an ordinary file, so nothing is there for a
        // symlink-aware resolver to follow, yet reading it returns the outside
        // file's contents.
        const workspaceDir = path.join(tempFolder.path, 'workspace')
        await fs.mkdir(workspaceDir)
        const outsideTarget = path.join(tempFolder.path, 'outside-secret.txt')
        await fs.writeFile(outsideTarget, 'SENSITIVE')
        const hardLinkInWorkspace = path.join(workspaceDir, 'looks-normal.txt')
        await fs.link(outsideTarget, hardLinkInWorkspace)

        const fsRead = new FsRead({
            ...features,
            workspace: {
                ...features.workspace,
                getTextDocument: async s => ({}) as TextDocument,
                getAllWorkspaceFolders: () => [{ uri: `file://${workspaceDir}`, name: 'workspace' }],
            },
        })

        const result = await fsRead.requiresAcceptance({ paths: [hardLinkInWorkspace] })
        assert.equal(
            result.requiresAcceptance,
            true,
            'Reading a file that is also named outside the workspace should be confirmed by the user'
        )
        assert.equal(result.acceptanceReason, 'multiplyLinkedFile')
    })
})

function verifyResult(result: any, expected: FileReadResult[]) {
    assert.strictEqual(result.output.kind, 'json', 'Output kind should be "json"')
    const resultContent = result.output.content as FileReadResult[]
    // Compare array length
    assert.strictEqual(resultContent.length, expected.length, 'Arrays should have the same length')

    // Compare each element in the arrays
    for (let i = 0; i < resultContent.length; i++) {
        assert.strictEqual(resultContent[i].path, expected[i].path, `Path at index ${i} should match`)
        assert.strictEqual(resultContent[i].content, expected[i].content, `Content at index ${i} should match`)
        assert.strictEqual(
            resultContent[i].truncated,
            expected[i].truncated,
            `Truncated flag at index ${i} should match`
        )
    }
}
