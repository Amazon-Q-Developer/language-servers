import assert from 'assert'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { saveSharedConfigFile } from './saveSharedConfigFile'
import { IniFileType } from './types'

// Uses the real file system, because the mode is the behavior under test. POSIX modes do not apply on Windows.
;(process.platform === 'win32' ? describe.skip : describe)('sharedConfig.saveSharedConfigFile file mode', () => {
    let dir: string
    let previousUmask: number

    // Octal strings, so a failure reads as 644 != 600
    const octal = (mode: number) => (mode & 0o777).toString(8)

    async function modeOf(filepath: string): Promise<string> {
        return octal((await stat(filepath)).mode)
    }

    async function createFile(filepath: string, mode: number): Promise<void> {
        await writeFile(filepath, '[default]\naws_access_key_id = AAAAAAAA\n')
        await chmod(filepath, mode)
    }

    beforeEach(async () => {
        // The default on most systems
        previousUmask = process.umask(0o022)
        dir = await mkdtemp(join(tmpdir(), 'shared-config-mode-'))
    })

    afterEach(async () => {
        process.umask(previousUmask)
        await rm(dir, { recursive: true, force: true })
    })

    it('keeps a 0600 credentials file and its backup at 0600 across saves', async () => {
        const filepath = join(dir, 'credentials')
        await createFile(filepath, 0o600)

        await saveSharedConfigFile(filepath, IniFileType.credentials, { default: { aws_access_key_id: 'CCCCCCCC' } })
        await saveSharedConfigFile(filepath, IniFileType.credentials, { default: { aws_access_key_id: 'DDDDDDDD' } })

        assert.equal(await modeOf(filepath), octal(0o600))
        assert.equal(await modeOf(filepath + '~'), octal(0o600))
        assert.match(await readFile(filepath, 'utf-8'), /aws_access_key_id = DDDDDDDD/)
    })

    for (const mode of [0o644, 0o640, 0o604]) {
        it(`removes group and other access from a ${mode.toString(8)} credentials file and its backup`, async () => {
            const filepath = join(dir, 'credentials')
            await createFile(filepath, mode)

            await saveSharedConfigFile(filepath, IniFileType.credentials, {
                default: { aws_access_key_id: 'CCCCCCCC' },
            })

            assert.equal(await modeOf(filepath), octal(mode & 0o700))
            assert.equal(await modeOf(filepath + '~'), octal(mode & 0o700))
        })
    }

    for (const mode of [0o600, 0o640, 0o644]) {
        it(`keeps the ${mode.toString(8)} mode of an existing config file`, async () => {
            const filepath = join(dir, 'config')
            await createFile(filepath, mode)

            await saveSharedConfigFile(filepath, IniFileType.config, { default: { region: 'us-east-1' } })

            assert.equal(await modeOf(filepath), octal(mode))
            assert.equal(await modeOf(filepath + '~'), octal(mode))
        })
    }

    for (const filetype of [IniFileType.config, IniFileType.credentials]) {
        it(`creates a new ${IniFileType[filetype]} file at 0600 in a new 0700 directory`, async () => {
            const filepath = join(dir, '.aws', IniFileType[filetype])

            await saveSharedConfigFile(filepath, filetype, { default: { region: 'us-east-1' } })

            assert.equal(await modeOf(filepath), octal(0o600))
            assert.equal(await modeOf(join(dir, '.aws')), octal(0o700))
        })
    }

    it('does not change the mode of an existing directory', async () => {
        const awsDir = join(dir, '.aws')
        await mkdir(awsDir)
        await chmod(awsDir, 0o755)

        await saveSharedConfigFile(join(awsDir, 'credentials'), IniFileType.credentials, {
            default: { aws_access_key_id: 'CCCCCCCC' },
        })

        assert.equal(await modeOf(awsDir), octal(0o755))
    })
})
