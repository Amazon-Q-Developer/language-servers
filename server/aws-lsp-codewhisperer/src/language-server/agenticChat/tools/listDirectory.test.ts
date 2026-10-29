import * as assert from 'assert'
import { ListDirectory } from './listDirectory'
import { testFolder } from '@aws/lsp-core'
import * as path from 'path'
import * as fs from 'fs/promises'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import { Features } from '@aws/language-server-runtimes/server-interface/server'

describe('ListDirectory Tool', () => {
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
        const listDirectory = new ListDirectory(testFeatures)
        await assert.rejects(
            listDirectory.validate({ path: '', maxDepth: 0 }, ''),
            /Path cannot be empty/i,
            'Expected an error about empty path'
        )
    })

    it('invalidates negative maxDepth', async () => {
        const listDirectory = new ListDirectory(testFeatures)
        await assert.rejects(
            listDirectory.validate({ path: '~', maxDepth: -1 }, tempFolder.path),
            /MaxDepth cannot be negative/i,
            'Expected an error about negative maxDepth'
        )
    })

    it('lists directory contents', async () => {
        await tempFolder.nest('subfolder')
        await tempFolder.write('fileA.txt', 'fileA content')

        const listDirectory = new ListDirectory(testFeatures)
        const result = await listDirectory.invoke({ path: tempFolder.path, maxDepth: 0 }, tempFolder.path)

        assert.strictEqual(result.output.kind, 'text')
        const hasFileA = result.output.content.includes('`-- fileA.txt')
        const hasSubfolder = result.output.content.includes('subfolder/\n')

        assert.ok(hasFileA, 'Should list fileA.txt in the directory output')
        assert.ok(hasSubfolder, 'Should list the subfolder in the directory output')
    })

    it('lists directory contents recursively', async () => {
        await tempFolder.nest('subfolder')
        await tempFolder.write('fileA.txt', 'fileA content')
        await tempFolder.write(path.join('subfolder', 'fileB.md'), '# fileB')

        const listDirectory = new ListDirectory(testFeatures)
        const result = await listDirectory.invoke({ path: tempFolder.path }, tempFolder.path)

        assert.strictEqual(result.output.kind, 'text')
        const hasFileA = result.output.content.includes('`-- fileA.txt')
        const hasSubfolder = result.output.content.includes('subfolder/\n')
        const hasFileB = result.output.content.includes('`-- fileB.md')

        assert.ok(hasFileA, 'Should list fileA.txt in the directory output')
        assert.ok(hasSubfolder, 'Should list the subfolder in the directory output')
        assert.ok(hasFileB, 'Should list fileB.md in the subfolder in the directory output')
    })

    it('lists directory contents with ignored pattern', async () => {
        const nestedFolder = await tempFolder.nest('node_modules')
        await nestedFolder.write('fileC.md', '# fileC')

        const listDirectory = new ListDirectory(testFeatures)
        await listDirectory.validate({ path: tempFolder.path }, tempFolder.path)
        const result = await listDirectory.invoke({ path: tempFolder.path }, tempFolder.path)

        assert.strictEqual(result.output.kind, 'text')
        const hasNodeModules = result.output.content.includes('node_modules/\n')
        const hasFileC = result.output.content.includes('`-- fileC.md')

        assert.ok(!hasNodeModules, 'Should not list node_modules in the directory output')
        assert.ok(!hasFileC, 'Should not list fileC.md under node_modules in the directory output')
    })

    it('includes files that only start with ignored entry', async () => {
        const nestedFolder = await tempFolder.nest('foo')
        await nestedFolder.write('output.md', 'this is some text')

        const listDirectory = new ListDirectory(testFeatures)
        await listDirectory.validate({ path: tempFolder.path }, tempFolder.path)
        const result = await listDirectory.invoke({ path: tempFolder.path }, tempFolder.path)
        assert.strictEqual(result.output.kind, 'text')
        const hasOutput = result.output.content.includes('`-- output.md')

        assert.ok(hasOutput, 'Should list output.md under foo in the directory output')
    })

    it('throws error if path does not exist', async () => {
        const missingPath = path.join(tempFolder.path, 'no_such_file.txt')
        const listDirectory = new ListDirectory(testFeatures)

        await assert.rejects(listDirectory.invoke({ path: missingPath, maxDepth: 0 }, missingPath))
    })

    it('uses the expanded home path returned by acceptance', async () => {
        const listDirectory = new ListDirectory(testFeatures)
        const decision = await listDirectory.requiresAcceptance({ path: '~', maxDepth: 0 })
        assert.ok(decision.canonicalPaths?.length)
        const result = await listDirectory.invoke({ path: '~', maxDepth: 0 }, decision.canonicalPaths[0])

        assert.strictEqual(result.output.kind, 'text')
        assert.ok(result.output.content.length > 0)
    })
})
