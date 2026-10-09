import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { URI } from 'vscode-uri'
import sinon from 'ts-sinon'
import { LocalProjectContextController } from '../../../shared/localProjectContextController'
import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { FileReadResult, FsRead } from './fsRead'
import { FsWrite } from './fsWrite'
import { FsReplace } from './fsReplace'
import { ListDirectory } from './listDirectory'
import { FileSearch } from './fileSearch'
import { resolveCanonicalPath, requiresPathAcceptance, validatePath } from './toolShared'

/**
 * Regression tests for `~` paths passed to the file tools.
 *
 * The approval check used to resolve a literal `~` as an ordinary directory
 * name relative to the process working directory, while the operation expanded
 * it to the home directory. With the language server running from the home
 * directory and a workspace folder literally named `~` inside it,
 * `~/q-tilde-test.txt` looked like `<home>/~/q-tilde-test.txt` (inside the
 * workspace, no prompt) but the read returned `<home>/q-tilde-test.txt`
 * (outside the workspace).
 *
 * Each test recreates that layout with a temporary home directory, so the tool
 * receives exactly the literal `~` input and no model can rewrite it first:
 *
 *   <root>/home/                    process cwd and home directory
 *   <root>/home/~/                  opened workspace folder
 *   <root>/home/~/q-tilde-test.txt  same-named file inside the workspace
 *   <root>/home/q-tilde-test.txt    the file `~` actually expands to
 *
 * `os.homedir()` reads HOME (POSIX) or USERPROFILE (Windows) on every call, so
 * pointing those at the temporary home is enough to redirect `~` expansion.
 */
describe('workspace boundary for ~ paths', () => {
    const fileName = 'q-tilde-test.txt'
    const tildePath = `~/${fileName}`
    const insideContent = 'INSIDE-LITERAL-DECOY'
    const outsideContent = 'OUTSIDE-EXPANDED-TARGET'

    let root: string
    let home: string
    let ws: string
    let insideFile: string
    let outsideFile: string
    let originalCwd: string
    let originalHome: string | undefined
    let originalUserProfile: string | undefined

    const noopLogging = {
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
        debug: () => {},
    } as unknown as Features['logging']

    const exists = (p: string) =>
        fs.promises
            .access(p)
            .then(() => true)
            .catch(() => false)

    const makeFeatures = (): Pick<Features, 'logging' | 'workspace' | 'lsp'> =>
        ({
            logging: noopLogging,
            lsp: {},
            workspace: {
                getAllWorkspaceFolders: () => [{ uri: URI.file(ws).toString(), name: '~' }],
                fs: {
                    exists,
                    readFile: (p: string) => fs.promises.readFile(p, 'utf-8'),
                    writeFile: (p: string, content: string) => fs.promises.writeFile(p, content),
                    readdir: async (p: string) => {
                        const entries = await fs.promises.readdir(p, { withFileTypes: true })
                        return entries.map(entry => {
                            // Match the workspace fs contract on older supported Node versions too.
                            ;(entry as any).parentPath = p
                            return entry
                        })
                    },
                },
            },
        }) as unknown as Pick<Features, 'logging' | 'workspace' | 'lsp'>

    const canon = async (p: string): Promise<string> => fs.promises.realpath(p)

    beforeEach(() => {
        originalCwd = process.cwd()
        originalHome = process.env.HOME
        originalUserProfile = process.env.USERPROFILE
        const realTmp = fs.realpathSync(os.tmpdir())
        root = fs.mkdtempSync(path.join(realTmp, 'tilde-'))
        home = path.join(root, 'home')
        ws = path.join(home, '~')
        insideFile = path.join(ws, fileName)
        outsideFile = path.join(home, fileName)
        fs.mkdirSync(ws, { recursive: true })
        fs.writeFileSync(insideFile, insideContent)
        fs.writeFileSync(outsideFile, outsideContent)

        process.chdir(home)
        process.env.HOME = home
        process.env.USERPROFILE = home
        assert.strictEqual(
            fs.realpathSync(os.homedir()),
            fs.realpathSync(home),
            'test setup must redirect os.homedir()'
        )
        sinon.stub(LocalProjectContextController, 'getInstance').resolves({
            updateIndexAndContextCommand: sinon.stub().resolves(),
        } as unknown as LocalProjectContextController)
    })

    afterEach(() => {
        sinon.restore()
        process.chdir(originalCwd)
        if (originalHome === undefined) {
            delete process.env.HOME
        } else {
            process.env.HOME = originalHome
        }
        if (originalUserProfile === undefined) {
            delete process.env.USERPROFILE
        } else {
            process.env.USERPROFILE = originalUserProfile
        }
        fs.rmSync(root, { recursive: true, force: true })
    })

    describe('resolveCanonicalPath', () => {
        it('expands a literal ~ to the home directory, not to a directory named ~ under cwd', async () => {
            const resolved = await resolveCanonicalPath(tildePath)
            assert.strictEqual(await canon(resolved), await canon(outsideFile))
            assert.notStrictEqual(await canon(resolved), await canon(insideFile))
        })
    })

    describe('requiresPathAcceptance', () => {
        it('requires acceptance for the expanded home path despite the literal ~ decoy inside the workspace', async () => {
            const result = await requiresPathAcceptance(tildePath, 'fsRead', makeFeatures().workspace, noopLogging)
            assert.strictEqual(result.requiresAcceptance, true)
        })

        it('flags ~/.aws/<file> as sensitive, not merely outside the workspace', async () => {
            fs.mkdirSync(path.join(home, '.aws'))
            fs.writeFileSync(path.join(home, '.aws', fileName), 'synthetic')
            const result = await requiresPathAcceptance(
                `~/.aws/${fileName}`,
                'fsRead',
                makeFeatures().workspace,
                noopLogging
            )
            assert.strictEqual(result.requiresAcceptance, true)
            assert.match(result.warning ?? '', /sensitive/i)
        })

        it('does not require acceptance once the expanded home path is approved', async () => {
            const approved = new Map<string, Set<string>>([['fsRead', new Set([await canon(outsideFile)])]])
            const result = await requiresPathAcceptance(
                tildePath,
                'fsRead',
                makeFeatures().workspace,
                noopLogging,
                approved
            )
            assert.strictEqual(result.requiresAcceptance, false)
        })

        it('does not treat approval of the literal decoy as approval of the expanded home file', async () => {
            const approved = new Map<string, Set<string>>([['fsRead', new Set([await canon(insideFile)])]])
            const result = await requiresPathAcceptance(
                tildePath,
                'fsRead',
                makeFeatures().workspace,
                noopLogging,
                approved
            )
            assert.strictEqual(result.requiresAcceptance, true)
        })

        it('does not require acceptance for the in-workspace file when addressed by its real path', async () => {
            const result = await requiresPathAcceptance(insideFile, 'fsRead', makeFeatures().workspace, noopLogging)
            assert.strictEqual(result.requiresAcceptance, false)
        })
    })

    describe('validatePath', () => {
        it('checks existence of the expanded home path rather than the literal ~ path', async () => {
            // Only the expanded target exists: the literal <cwd>/~/<file> does not.
            fs.rmSync(insideFile)
            await assert.doesNotReject(validatePath(tildePath, exists))

            // Only the literal path exists: validation must fail, because the tool would act on the missing home file.
            fs.writeFileSync(insideFile, insideContent)
            fs.rmSync(outsideFile)
            await assert.rejects(validatePath(tildePath, exists), /does not exist or cannot be accessed/i)
        })
    })

    describe('file tool approval, validation and I/O', () => {
        // These call the tool APIs directly. Invocation below represents an
        // approved operation; controller-level deny handling is not under test.
        it('fsRead: approval, validation and read all target the expanded home path', async () => {
            const tool = new FsRead(makeFeatures())
            const approval = await tool.requiresAcceptance({ paths: [tildePath] })
            assert.strictEqual(approval.requiresAcceptance, true)

            fs.rmSync(insideFile)
            await tool.validate({ paths: [tildePath] })
            const result = await tool.invoke({ paths: [tildePath] })
            assert.strictEqual(result.output.kind, 'json')
            const content = result.output.content as FileReadResult[]
            assert.strictEqual(content.length, 1)
            assert.strictEqual(content[0].content, outsideContent, 'read must return the file the gate was asked about')
        })

        it('fsWrite: approval and write target the expanded home path', async () => {
            const tool = new FsWrite(makeFeatures())
            const params = { command: 'create' as const, path: tildePath, fileText: 'CHANGED' }
            const approval = await tool.requiresAcceptance(params)
            assert.strictEqual(approval.requiresAcceptance, true)

            await tool.validate(params)
            await tool.invoke(params)
            assert.strictEqual(fs.readFileSync(outsideFile, 'utf-8'), 'CHANGED')
            assert.strictEqual(
                fs.readFileSync(insideFile, 'utf-8'),
                insideContent,
                'in-workspace decoy must be untouched'
            )
        })

        it('fsReplace: approval and replace target the expanded home path', async () => {
            const tool = new FsReplace(makeFeatures())
            const params = { path: tildePath, diffs: [{ oldStr: outsideContent, newStr: 'REPLACED' }] }
            const approval = await tool.requiresAcceptance(params)
            assert.strictEqual(approval.requiresAcceptance, true)

            await tool.validate(params)
            await tool.invoke(params)
            assert.strictEqual(fs.readFileSync(outsideFile, 'utf-8'), 'REPLACED')
            assert.strictEqual(
                fs.readFileSync(insideFile, 'utf-8'),
                insideContent,
                'in-workspace decoy must be untouched'
            )
        })

        it('listDirectory: approval, validation and listing target the expanded home directory', async () => {
            fs.writeFileSync(path.join(ws, 'workspace-only.txt'), insideContent)
            const tool = new ListDirectory(makeFeatures())
            const params = { path: '~', maxDepth: 0 }
            const approval = await tool.requiresAcceptance(params)
            assert.strictEqual(approval.requiresAcceptance, true)
            await tool.validate(params)
            const result = await tool.invoke(params)
            assert.strictEqual(result.output.kind, 'text')
            const content = result.output.content as string
            assert.strictEqual(content.split('\n')[0], `${await canon(home)}/`)
            assert.ok(content.includes(fileName))
            assert.ok(!content.includes('workspace-only.txt'), 'must not list the literal ~ directory instead')
        })

        it('fileSearch: approval, validation and search target the expanded home directory', async () => {
            const tool = new FileSearch(makeFeatures())
            const params = { path: '~', queryName: fileName, maxDepth: 0 }
            const approval = await tool.requiresAcceptance(params)
            assert.strictEqual(approval.requiresAcceptance, true)
            await tool.validate(params)
            const result = await tool.invoke(params)
            assert.strictEqual(result.output.kind, 'text')
            assert.strictEqual(result.output.content, `[F] ${await canon(outsideFile)}`)
        })
    })
})
