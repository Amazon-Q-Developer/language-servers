import * as assert from 'assert'
import * as path from 'path'
import { Workspace } from '@aws/language-server-runtimes/server-interface'
import { GitIgnoreFilter } from './gitIgnoreFilter'

describe('GitIgnoreFilter', () => {
    const rootPath = path.resolve('gitignore-filter-root')
    const inRoot = (...segments: string[]) => path.join(rootPath, ...segments)

    async function filter(gitIgnoreFiles: Record<string, string>, files: string[]): Promise<string[]> {
        const workspace = {
            fs: {
                readFile: async (filePath: string) => {
                    const content = gitIgnoreFiles[filePath]
                    if (content === undefined) {
                        throw new Error(`unexpected read of ${filePath}`)
                    }
                    return content
                },
            },
        } as unknown as Workspace
        const gitIgnoreFilter = await GitIgnoreFilter.build(rootPath, Object.keys(gitIgnoreFiles), workspace)
        return gitIgnoreFilter.filterFiles(files)
    }

    it('applies the patterns of the root .gitignore file to the whole tree', async () => {
        const kept = await filter({ [inRoot('.gitignore')]: 'build/\n*.log\n' }, [
            inRoot('src', 'a.cs'),
            inRoot('build', 'a.cs'),
            inRoot('a.log'),
            inRoot('sub', 'b.log'),
        ])

        assert.deepStrictEqual(kept, [inRoot('src', 'a.cs')])
    })

    it('applies an anchored pattern relative to the folder of its .gitignore file', async () => {
        const kept = await filter({ [inRoot('sub', '.gitignore')]: '/x.cs\n' }, [
            inRoot('x.cs'),
            inRoot('sub', 'x.cs'),
            inRoot('sub', 'deeper', 'x.cs'),
        ])

        assert.deepStrictEqual(kept, [inRoot('x.cs'), inRoot('sub', 'deeper', 'x.cs')])
    })

    it('applies the patterns of a nested .gitignore file only inside its folder', async () => {
        const kept = await filter({ [inRoot('sub', '.gitignore')]: '*.tmp\nout/\n' }, [
            inRoot('a.tmp'),
            inRoot('other', 'a.tmp'),
            inRoot('sub2', 'a.tmp'),
            inRoot('out', 'a.cs'),
            inRoot('sub', 'a.tmp'),
            inRoot('sub', 'deeper', 'b.tmp'),
            inRoot('sub', 'out', 'a.cs'),
            inRoot('sub', 'a.cs'),
        ])

        assert.deepStrictEqual(kept, [
            inRoot('a.tmp'),
            inRoot('other', 'a.tmp'),
            inRoot('sub2', 'a.tmp'),
            inRoot('out', 'a.cs'),
            inRoot('sub', 'a.cs'),
        ])
    })

    it('keeps a file only when every .gitignore file that covers it accepts it', async () => {
        const kept = await filter(
            {
                [inRoot('.gitignore')]: '*.log\n',
                [inRoot('sub', '.gitignore')]: '/generated/\n',
            },
            [
                inRoot('generated', 'a.cs'),
                inRoot('sub', 'generated', 'a.cs'),
                inRoot('sub', 'a.log'),
                inRoot('sub', 'a.cs'),
            ]
        )

        assert.deepStrictEqual(kept, [inRoot('generated', 'a.cs'), inRoot('sub', 'a.cs')])
    })
})
