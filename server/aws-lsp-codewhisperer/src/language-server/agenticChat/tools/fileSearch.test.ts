import * as assert from 'assert'
import { FileSearch, FileSearchParams } from './fileSearch'
import { resolveCanonicalPath } from './toolShared'

async function invokeSearch(tool: FileSearch, params: FileSearchParams) {
    const target = await resolveCanonicalPath(params.path)
    return tool.invoke(params, target)
}
import { testFolder } from '@aws/lsp-core'
import * as path from 'path'
import * as fs from 'fs/promises'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import { Features } from '@aws/language-server-runtimes/server-interface/server'

describe('FileSearch Tool', () => {
    let tempFolder: testFolder.TestFolder
    let testFeatures: TestFeatures

    before(async () => {
        testFeatures = new TestFeatures()
        // @ts-ignore does not require all fs operations to be implemented
        testFeatures.workspace.fs = {
            exists: path =>
                fs
                    .access(path)
                    .then(() => true)
                    .catch(() => false),
            readdir: async dirPath => {
                const entries = await fs.readdir(dirPath, { withFileTypes: true })
                return entries.map(entry => {
                    ;(entry as any).parentPath = dirPath
                    return entry
                })
            },
        } as Features['workspace']['fs']
        tempFolder = await testFolder.TestFolder.create()
    })

    after(async () => {
        await tempFolder.delete()
    })

    it('invalidates empty path', async () => {
        const fileSearch = new FileSearch(testFeatures)
        await assert.rejects(
            fileSearch.validate({ path: '', queryName: 'test' }, ''),
            /Path cannot be empty/i,
            'Expected an error about empty path'
        )
    })

    it('invalidates invalid threshold pattern', async () => {
        const fileSearch = new FileSearch(testFeatures)
        await assert.rejects(
            fileSearch.validate({ path: tempFolder.path, queryName: 'test', threshold: -1 }, tempFolder.path),
            /Invalid threshold/i,
            'Expected an error about invalid threshold'
        )
    })

    it('invalidates empty maxDepth', async () => {
        const fileSearch = new FileSearch(testFeatures)
        await assert.rejects(
            fileSearch.validate({ path: tempFolder.path, queryName: 'test', maxDepth: -1 }, tempFolder.path),
            /MaxDepth cannot be negative/i,
            'Expected an error about negative maxDepth'
        )
    })

    it('invalidates empty queryName', async () => {
        const fileSearch = new FileSearch(testFeatures)
        await assert.rejects(
            fileSearch.validate({ path: tempFolder.path, queryName: '' }, tempFolder.path),
            /queryName cannot be empty/i,
            'Expected an error about empty queryName'
        )
    })

    it('searches for files matching pattern', async () => {
        await tempFolder.write('fileA.txt', 'fileA content')
        await tempFolder.write('fileB.md', '# fileB content')
        await tempFolder.write('fileC.js', 'console.log("fileC");')

        const fileSearch = new FileSearch(testFeatures)
        const result = await invokeSearch(fileSearch, {
            path: tempFolder.path,
            queryName: 'txt',
            maxDepth: 0,
        })

        assert.strictEqual(result.output.kind, 'text')
        const lines = result.output.content.split('\n')
        const hasFileA = lines.some(line => line.includes('[F] ') && line.includes('fileA.txt'))
        const hasFileB = lines.some(line => line.includes('[F] ') && line.includes('fileB.md'))

        assert.ok(hasFileA, 'Should find fileA.txt matching the pattern')
        assert.ok(!hasFileB, 'Should not find fileB.md as it does not match the pattern')
    })

    it('searches recursively in subdirectories', async () => {
        const subfolder = await tempFolder.nest('txts')
        await tempFolder.write('fileA.txt', 'fileA content')
        await subfolder.write('fileB.txt', 'fileB content')
        await tempFolder.write('fileC.md', '# fileC content')

        const fileSearch = new FileSearch(testFeatures)
        const result = await invokeSearch(fileSearch, {
            path: tempFolder.path,
            queryName: 'txt',
        })

        assert.strictEqual(result.output.kind, 'text')
        const lines = result.output.content.split('\n')
        const hasSubFolder = lines.some(line => line.includes('[D] ') && line.includes('txts'))
        const hasFileA = lines.some(line => line.includes('[F] ') && line.includes('fileA.txt'))
        const hasFileB = lines.some(line => line.includes('[F] ') && line.includes('fileB.txt'))
        const hasFileC = lines.some(line => line.includes('[F] ') && line.includes('fileC.md'))

        assert.ok(hasSubFolder, 'Should include txts directory')
        assert.ok(hasFileA, 'Should find fileA.txt in root directory')
        assert.ok(hasFileB, 'Should find fileB.txt in subfolder')
        assert.ok(!hasFileC, 'Should not find fileC.md as it does not match the pattern')
    })

    it('respects maxDepth parameter', async () => {
        const subfolder1 = await tempFolder.nest('subfolder1')
        const subfolder2 = await subfolder1.nest('subfolder2')

        await tempFolder.write('root.txt', 'root content')
        await subfolder1.write('level1.txt', 'level1 content')
        await subfolder2.write('level2.txt', 'level2 content')

        const fileSearch = new FileSearch(testFeatures)
        const result = await invokeSearch(fileSearch, {
            path: tempFolder.path,
            queryName: 'txt',
            maxDepth: 1,
        })

        assert.strictEqual(result.output.kind, 'text')
        const lines = result.output.content.split('\n')
        const hasRootFile = lines.some(line => line.includes('[F] ') && line.includes('root.txt'))
        const hasLevel1File = lines.some(line => line.includes('[F] ') && line.includes('level1.txt'))
        const hasLevel2File = lines.some(line => line.includes('[F] ') && line.includes('level2.txt'))

        assert.ok(hasRootFile, 'Should find root.txt in root directory')
        assert.ok(hasLevel1File, 'Should find level1.txt in subfolder1')
        assert.ok(!hasLevel2File, 'Should not find level2.txt as it exceeds maxDepth')
    })

    it('performs case-insensitive search by default', async () => {
        await tempFolder.write('FileUpper.txt', 'upper case filename')
        await tempFolder.write('fileLower.txt', 'lower case filename')

        const fileSearch = new FileSearch(testFeatures)
        const result = await invokeSearch(fileSearch, {
            path: tempFolder.path,
            queryName: 'file',
            maxDepth: 0,
        })

        assert.strictEqual(result.output.kind, 'text')
        const lines = result.output.content.split('\n')
        const hasUpperFile = lines.some(line => line.includes('[F] ') && line.includes('FileUpper.txt'))
        const hasLowerFile = lines.some(line => line.includes('[F] ') && line.includes('fileLower.txt'))

        assert.ok(hasUpperFile, 'Should find FileUpper.txt with case-insensitive search')
        assert.ok(hasLowerFile, 'Should find fileLower.txt with case-insensitive search')
    })

    it('performs case-sensitive search when specified', async () => {
        await tempFolder.write('FileUpper.txt', 'upper case filename')
        await tempFolder.write('fileLower.txt', 'lower case filename')

        const fileSearch = new FileSearch(testFeatures)
        const result = await invokeSearch(fileSearch, {
            path: tempFolder.path,
            queryName: 'file',
            maxDepth: 0,
            caseSensitive: true,
        })

        assert.strictEqual(result.output.kind, 'text')
        const lines = result.output.content.split('\n')
        const hasUpperFile = lines.some(line => line.includes('[F] ') && line.includes('FileUpper.txt'))
        const hasLowerFile = lines.some(line => line.includes('[F] ') && line.includes('fileLower.txt'))

        assert.ok(!hasUpperFile, 'Should not find FileUpper.txt with case-sensitive search')
        assert.ok(hasLowerFile, 'Should find fileLower.txt with case-sensitive search')
    })

    it('ignores excluded directories', async () => {
        const nodeModules = await tempFolder.nest('node_modules')
        await tempFolder.write('regular.txt', 'regular content')
        await nodeModules.write('excluded.txt', 'excluded content')

        const fileSearch = new FileSearch(testFeatures)
        const result = await invokeSearch(fileSearch, {
            path: tempFolder.path,
            queryName: 'txt',
        })

        assert.strictEqual(result.output.kind, 'text')
        const lines = result.output.content.split('\n')
        const hasRegularFile = lines.some(line => line.includes('[F] ') && line.includes('regular.txt'))
        const hasExcludedFile = lines.some(line => line.includes('[F] ') && line.includes('excluded.txt'))

        assert.ok(hasRegularFile, 'Should find regular.txt in root directory')
        assert.ok(!hasExcludedFile, 'Should not find excluded.txt in node_modules directory')
    })

    it('throws error if path does not exist', async () => {
        const missingPath = path.join(tempFolder.path, 'no_such_directory')
        const fileSearch = new FileSearch(testFeatures)

        await assert.rejects(
            invokeSearch(fileSearch, { path: missingPath, queryName: '.*' }),
            /Failed to search directory/i,
            'Expected an error about non-existent path'
        )
    })

    it('expands ~ path', async () => {
        const fileSearch = new FileSearch(testFeatures)
        const result = await invokeSearch(fileSearch, {
            path: '~',
            queryName: '.*',
            maxDepth: 0,
        })

        assert.strictEqual(result.output.kind, 'text')
        assert.ok(result.output.content.length > 0)
    })
})
