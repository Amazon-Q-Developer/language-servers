import assert from 'assert'
import { IniFileType, SectionHeader, Setting } from './types'
import { IniSectionType } from '@smithy/types'

describe('sharedConfig.SectionHeader', () => {
    describe('toIniSectionName', () => {
        it('credentials file profile sections are not prefixed with "profile"', () => {
            const actual = new SectionHeader('test-profile').toIniSectionName(IniFileType.credentials)
            assert.equal(actual, '[test-profile]')
        })

        it('config file sections are prefixed', () => {
            Object.values(IniSectionType).forEach(section => {
                const actual = new SectionHeader('test-profile', section).toIniSectionName(IniFileType.config)
                assert.equal(actual, `[${section} test-profile]`)
            })
        })

        it('default profile is not prefixed with "profile" in either file', () => {
            Object.values(IniFileType).forEach(file => {
                const actual = new SectionHeader('default').toIniSectionName(file as IniFileType)
                assert.equal(actual, '[default]')
            })
        })
    })

    it('fromParsedSectionName', () => {
        ;[
            { parsedName: 'test-profile', name: 'test-profile', type: IniSectionType.PROFILE },
            { parsedName: 'sso-session.test-sso-session', name: 'test-sso-session', type: IniSectionType.SSO_SESSION },
            { parsedName: 'services.test-services', name: 'test-services', type: IniSectionType.SERVICES },
        ].forEach(expected => {
            const actual = SectionHeader.fromParsedSectionName(expected.parsedName)
            assert.equal(actual.name, expected.name)
            assert.equal(actual.type, expected.type)
        })
    })

    it('toParsedSectionName', () => {
        ;[
            { parsedName: 'test-profile', name: 'test-profile', type: IniSectionType.PROFILE },
            { parsedName: 'sso-session.test-sso-session', name: 'test-sso-session', type: IniSectionType.SSO_SESSION },
            { parsedName: 'services.test-services', name: 'test-services', type: IniSectionType.SERVICES },
        ].forEach(expected => {
            const actual = new SectionHeader(expected.name, expected.type).toParsedSectionName()
            assert.equal(actual, expected.parsedName)
        })
    })
})

describe('sharedConfig.Setting', () => {
    it('toIniSettingLine', () => {
        const actual = new Setting('setting-name', 'setting value').toIniSettingLine()
        assert.equal(actual, 'setting-name = setting value')
    })

    for (const lineBreak of ['\n', '\r', '\r\n']) {
        it(`refuses to serialize a line break ${JSON.stringify(lineBreak)}`, () => {
            const multiline = `x${lineBreak}y = z`

            assert.throws(() => new Setting('region', multiline).toIniSettingLine(), /cannot contain line breaks/)
            assert.throws(() => new Setting(multiline, 'value').toIniSettingLine(), /cannot contain line breaks/)
            assert.throws(
                () => new Setting('name', 'value', { subsection: multiline }).toIniSubsectionHeaderLine(),
                /cannot contain line breaks/
            )
            assert.throws(
                () => new SectionHeader(multiline).toIniSectionName(IniFileType.config),
                /cannot contain line breaks/
            )
        })
    }
})
