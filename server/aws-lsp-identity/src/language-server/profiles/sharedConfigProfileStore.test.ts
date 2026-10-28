// eslint-disable-next-line @typescript-eslint/no-require-imports
import mock = require('mock-fs')
import { getHomeDir, SharedConfigInit } from '@smithy/shared-ini-file-loader'
import { DirectoryItems } from 'mock-fs/lib/filesystem'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { SharedConfigProfileStore } from './sharedConfigProfileStore'
import { expect, use } from 'chai'
import { ProfileData } from './profileService'
import {
    AwsErrorCodes,
    Logging,
    ProfileKind,
    SsoSession,
    Telemetry,
} from '@aws/language-server-runtimes/server-interface'
import { StubbedInstance, stubInterface } from 'ts-sinon'
import { AwsError, Observability } from '@aws/lsp-core'

// eslint-disable-next-line
use(require('chai-as-promised'))

let sut: SharedConfigProfileStore

let observability: StubbedInstance<Observability>

const config = `
[default]
region = us-west-2

[profile subsettings]
api_versions =
    ec2 = 2015-03-01
    cloudfront = 2015-09-17

[profile config-only.profile]
region = us-west-2
sso_session = test-sso-session

[sso-session test-sso-session]
sso_region = us-west-2
sso_start_url = https://nowhere
sso_registration_scopes = somescope

[services s3-specific]
s3 = 
  endpoint_url = http://localhost:4567`

const credentials = `# Credentials comment 1
[default]
aws_access_key_id = AAAAAAAA
aws_secret_access_key = BBBBBBBB

[credentials-only.profile]
region = us-east-1
sso_session = test-sso-session`

// mock-fs requires / even on Windows
const dir = join(getHomeDir(), '.aws').replaceAll('\\', '/')

// Must ignoreCache on all calls or data from prior tests will leak into current test
// This applies to parseKnownFiles, saveKnownFiles, and loadSharedConfigFiles
const init: SharedConfigInit = { ignoreCache: true }

function setupTest(config: string, credentials: string): void {
    // Just for sanity, safe to call restore if mock not currently active
    mock.restore()

    const mockConfig: DirectoryItems = {}
    mockConfig[dir] = {
        config,
        credentials,
    }

    mock(mockConfig)
}

describe('SharedConfigProfileStore', async () => {
    beforeEach(() => {
        observability = stubInterface<Observability>()
        observability.logging = stubInterface<Logging>()
        observability.telemetry = stubInterface<Telemetry>()

        sut = new SharedConfigProfileStore(observability)
    })

    afterEach(() => {
        mock.restore()
    })

    it('loads SSO token profiles and sso-sessions, but not services', async () => {
        setupTest(config, credentials)

        const actual = await sut.load()

        expect(actual).to.deep.equal({
            profiles: [
                {
                    kinds: [ProfileKind.Unknown],
                    name: 'default',
                    settings: {
                        region: 'us-west-2',
                        sso_session: undefined,
                    },
                },
                {
                    kinds: [ProfileKind.Unknown],
                    name: 'subsettings',
                    settings: {
                        region: undefined,
                        sso_session: undefined,
                    },
                },
                {
                    kinds: [ProfileKind.SsoTokenProfile],
                    name: 'config-only.profile',
                    settings: {
                        region: 'us-west-2',
                        sso_session: 'test-sso-session',
                    },
                },
                {
                    kinds: [ProfileKind.SsoTokenProfile],
                    name: 'credentials-only.profile',
                    settings: {
                        region: 'us-east-1',
                        sso_session: 'test-sso-session',
                    },
                },
            ],
            ssoSessions: [
                {
                    name: 'test-sso-session',
                    settings: {
                        sso_region: 'us-west-2',
                        sso_start_url: 'https://nowhere',
                        sso_registration_scopes: ['somescope'],
                    },
                },
            ],
        })
    })

    it('No changes if no profiles nor ssoSessions are provided', async () => {
        setupTest(config, credentials)

        const before = await sut.load()

        const data: ProfileData = {
            profiles: [],
            ssoSessions: [],
        }

        await sut.save(data)

        const after = await sut.load()

        expect(after).to.deep.equal(before)
    })

    for (const arg of [undefined, null, '', '   ', ' \n ']) {
        it(`Removes setting on save if [${arg}] is provided.`, async () => {
            setupTest(config, credentials)

            const data: ProfileData = {
                profiles: [
                    {
                        kinds: [ProfileKind.SsoTokenProfile],
                        name: 'config-only.profile',
                        settings: {
                            region: arg as unknown as string, // Unset region from us-west-2
                            sso_session: 'test-sso-session',
                        },
                    },
                ],
                ssoSessions: [
                    {
                        name: 'test-sso-session',
                        settings: {
                            sso_registration_scopes: undefined,
                        },
                    },
                ],
            }

            await sut.save(data)

            const after = await sut.load()

            expect(after).to.deep.equal({
                profiles: [
                    {
                        kinds: ['Unknown'],
                        name: 'default',
                        settings: {
                            region: 'us-west-2',
                            sso_session: undefined,
                        },
                    },
                    {
                        kinds: ['Unknown'],
                        name: 'subsettings',
                        settings: {
                            region: undefined,
                            sso_session: undefined,
                        },
                    },
                    {
                        kinds: [ProfileKind.SsoTokenProfile],
                        name: 'config-only.profile',
                        settings: {
                            region: undefined,
                            sso_session: 'test-sso-session',
                        },
                    },
                    {
                        kinds: ['SsoTokenProfile'],
                        name: 'credentials-only.profile',
                        settings: {
                            region: 'us-east-1',
                            sso_session: 'test-sso-session',
                        },
                    },
                ],
                ssoSessions: [
                    {
                        name: 'test-sso-session',
                        settings: {
                            sso_region: 'us-west-2',
                            sso_start_url: 'https://nowhere',
                        },
                    },
                ],
            })
        })
    }

    it(`Throw on save if object is provided for a setting value.`, async () => {
        setupTest(config, credentials)

        const data: ProfileData = {
            profiles: [
                {
                    kinds: [ProfileKind.SsoTokenProfile],
                    name: 'config-only.profile',
                    settings: {
                        region: {} as unknown as string, // Pass object for setting value
                        sso_session: 'test-sso-session',
                    },
                },
            ],
            ssoSessions: [
                {
                    name: 'test-sso-session',
                    settings: {
                        sso_registration_scopes: undefined,
                    },
                },
            ],
        }

        const error = await expect(sut.save(data)).rejectedWith(Error)
        expect(error.message).contains('cannot be an object.')
    })

    for (const arg of [undefined, null, {}]) {
        it(`Removes profiles and ssoSessions if [${arg}] is provided.`, async () => {
            setupTest(config, credentials)

            const data: ProfileData = {
                profiles: [
                    {
                        kinds: [ProfileKind.SsoTokenProfile],
                        name: 'config-only.profile',
                        settings: arg!,
                    },
                ],
                ssoSessions: [
                    {
                        name: 'test-sso-session',
                        settings: arg!,
                    },
                ],
            }

            await sut.save(data)

            const after = await sut.load()

            expect(after).to.deep.equal({
                profiles: [
                    {
                        kinds: ['Unknown'],
                        name: 'default',
                        settings: {
                            region: 'us-west-2',
                            sso_session: undefined,
                        },
                    },
                    {
                        kinds: ['Unknown'],
                        name: 'subsettings',
                        settings: {
                            region: undefined,
                            sso_session: undefined,
                        },
                    },
                    {
                        kinds: ['SsoTokenProfile'],
                        name: 'credentials-only.profile',
                        settings: {
                            region: 'us-east-1',
                            sso_session: 'test-sso-session',
                        },
                    },
                ],
                ssoSessions: [],
            })
        })
    }

    it('Saves if profiles and ssoSessions are provided', async () => {
        setupTest(config, credentials)

        const data: ProfileData = {
            profiles: [
                {
                    kinds: [ProfileKind.SsoTokenProfile],
                    name: 'config-only.profile',
                    settings: {
                        region: 'us-west-1',
                        sso_session: 'new-sso-session',
                    },
                },
            ],
            ssoSessions: [
                {
                    name: 'test-sso-session',
                    settings: {
                        sso_region: 'us-east-1',
                        sso_start_url: 'http://newnowhere',
                        sso_registration_scopes: ['my-scope'],
                    },
                },
                {
                    name: 'new-sso-session',
                    settings: {
                        sso_region: 'us-north-1',
                        sso_start_url: 'http://somewhere',
                    },
                },
            ],
        }

        await sut.save(data)

        const after = await sut.load()

        expect(after).to.deep.equal({
            profiles: [
                {
                    kinds: ['Unknown'],
                    name: 'default',
                    settings: {
                        region: 'us-west-2',
                        sso_session: undefined,
                    },
                },
                {
                    kinds: ['Unknown'],
                    name: 'subsettings',
                    settings: {
                        region: undefined,
                        sso_session: undefined,
                    },
                },
                {
                    kinds: [ProfileKind.SsoTokenProfile],
                    name: 'config-only.profile',
                    settings: {
                        region: 'us-west-1',
                        sso_session: 'new-sso-session',
                    },
                },
                {
                    kinds: [ProfileKind.SsoTokenProfile],
                    name: 'credentials-only.profile',
                    settings: {
                        region: 'us-east-1',
                        sso_session: 'test-sso-session',
                    },
                },
            ],
            ssoSessions: [
                {
                    name: 'test-sso-session',
                    settings: {
                        sso_region: 'us-east-1',
                        sso_registration_scopes: ['my-scope'],
                        sso_start_url: 'http://newnowhere',
                    },
                },
                {
                    name: 'new-sso-session',
                    settings: {
                        sso_region: 'us-north-1',
                        sso_start_url: 'http://somewhere',
                    },
                },
            ],
        })
    })
})

describe('SharedConfigProfileStore save validation', () => {
    const ssoSession = {
        name: 'test-sso-session',
        settings: { sso_region: 'us-west-2', sso_start_url: 'https://nowhere' },
    }

    function profile(name: string, settings: object = { sso_session: 'test-sso-session' }) {
        return { kinds: [ProfileKind.SsoTokenProfile], name, settings } as ProfileData['profiles'][number]
    }

    async function readFiles(): Promise<string[]> {
        return [await readFile(join(dir, 'config'), 'utf-8'), await readFile(join(dir, 'credentials'), 'utf-8')]
    }

    async function expectRejectedWithoutChanges(data: ProfileData, awsErrorCode: string): Promise<void> {
        const before = await readFiles()

        const error = await expect(sut.save(data)).rejectedWith(AwsError)

        expect(error.awsErrorCode).to.equal(awsErrorCode)
        expect(await readFiles()).to.deep.equal(before)
    }

    beforeEach(() => {
        observability = stubInterface<Observability>()
        observability.logging = stubInterface<Logging>()
        observability.telemetry = stubInterface<Telemetry>()

        sut = new SharedConfigProfileStore(observability)
        setupTest(config, credentials)
    })

    afterEach(() => {
        mock.restore()
    })

    for (const name of ['x]\n[default]\ny = z\n[profile w', 'x]\r[default', 'x] # comment', 'x y', ' x', 'x\t', '']) {
        it(`rejects profile name ${JSON.stringify(name)} without changing files`, async () => {
            await expectRejectedWithoutChanges(
                { profiles: [profile(name)], ssoSessions: [] },
                AwsErrorCodes.E_INVALID_PROFILE
            )
        })
    }

    it('rejects an sso-session name with a line break without changing files', async () => {
        await expectRejectedWithoutChanges(
            {
                profiles: [],
                ssoSessions: [{ ...ssoSession, name: 'x]\n[default]\ny = z\n[sso-session w' }],
            },
            AwsErrorCodes.E_INVALID_SSO_SESSION
        )
    })

    // Names that are valid characters but parse back as a different section, or as an Object.prototype member
    for (const name of [
        'sso-session.test-sso-session',
        'services.s3-specific',
        'profile.default',
        '__proto__',
        'toString',
    ]) {
        it(`rejects profile name ${name} that does not read back as the same profile`, async () => {
            await expectRejectedWithoutChanges(
                { profiles: [profile(name)], ssoSessions: [] },
                AwsErrorCodes.E_INVALID_PROFILE
            )
        })
    }

    for (const setting of ['output', 'cli_pager', 'region\nx']) {
        it(`rejects unsupported profile setting ${JSON.stringify(setting)} without changing files`, async () => {
            await expectRejectedWithoutChanges(
                {
                    profiles: [profile('default', { sso_session: 'test-sso-session', [setting]: 'value' })],
                    ssoSessions: [],
                },
                AwsErrorCodes.E_INVALID_PROFILE
            )
        })
    }

    it('rejects unsupported sso-session settings without changing files', async () => {
        await expectRejectedWithoutChanges(
            {
                profiles: [],
                ssoSessions: [
                    {
                        ...ssoSession,
                        settings: { ...ssoSession.settings, output: 'json' } as SsoSession['settings'],
                    },
                ],
            },
            AwsErrorCodes.E_INVALID_SSO_SESSION
        )
    })

    for (const name of ['default', 'team.dev', 'team-profile_1', 'team@work', 'a+b%c:d/e']) {
        it(`saves profile name ${name} and reads it back`, async () => {
            await sut.save({
                profiles: [profile(name, { sso_session: 'test-sso-session', region: 'us-east-1' })],
                ssoSessions: [],
            })

            const actual = await sut.load()

            expect(actual.profiles.find(p => p.name === name)?.settings).to.deep.equal({
                region: 'us-east-1',
                sso_session: 'test-sso-session',
            })
        })
    }
})
