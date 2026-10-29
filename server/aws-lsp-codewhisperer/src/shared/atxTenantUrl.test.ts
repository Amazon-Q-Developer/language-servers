import { expect } from 'chai'
import { parseAtxTenantUrl } from './atxTenantUrl'

describe('parseAtxTenantUrl', () => {
    const valid: Array<[string, string, string]> = [
        ['https://workspace.transform.us-east-1.on.aws', 'https://workspace.transform.us-east-1.on.aws', 'us-east-1'],
        ['https://workspace.transform.us-east-1.on.aws/', 'https://workspace.transform.us-east-1.on.aws', 'us-east-1'],
        [
            'https://my-workspace.transform-gamma.us-west-2.on.aws',
            'https://my-workspace.transform-gamma.us-west-2.on.aws',
            'us-west-2',
        ],
        [
            '  https://abc123.transform.ap-northeast-2.on.aws  ',
            'https://abc123.transform.ap-northeast-2.on.aws',
            'ap-northeast-2',
        ],
        [
            'https://ABC123.Transform.AP-NORTHEAST-2.on.aws',
            'https://abc123.transform.ap-northeast-2.on.aws',
            'ap-northeast-2',
        ],
        [
            'https://workspace.transform.us-east-1.on.aws:443',
            'https://workspace.transform.us-east-1.on.aws',
            'us-east-1',
        ],
        // The console's Web application URL includes a path; only the origin is used, so it's dropped.
        [
            'https://abc123.transform.ap-northeast-2.on.aws/signin/',
            'https://abc123.transform.ap-northeast-2.on.aws',
            'ap-northeast-2',
        ],
        [
            'https://workspace.transform.us-east-1.on.aws/path?query=1#frag',
            'https://workspace.transform.us-east-1.on.aws',
            'us-east-1',
        ],
    ]

    for (const [input, origin, region] of valid) {
        it(`accepts ${input.trim()} as ${origin}`, () => {
            const parsed = parseAtxTenantUrl(input)
            expect(parsed?.origin).to.equal(origin)
            expect(parsed?.region).to.equal(region)
        })
    }

    const invalid: unknown[] = [
        undefined,
        null,
        42,
        '',
        '   ',
        'https://',
        'workspace.transform.us-east-1.on.aws', // no scheme
        'http://workspace.transform.us-east-1.on.aws', // http
        'ftp://workspace.transform.us-east-1.on.aws',
        'javascript:alert(1)',
        'https://u:p@workspace.transform.us-east-1.on.aws', // user name and password
        'https://workspace.transform.us-east-1.on.aws:8443', // non-default port
        'https://workspace.transform.us-east-1.on.aws.evil.com', // suffix extension
        'https://attacker.com/workspace.transform.us-east-1.on.aws',
        'https://attacker.com/x.transform.us-east-1.on.aws/callback',
        'https://evil.example.com',
        'https://transform.us-east-1.on.aws', // no tenant id
        'https://a.b.transform.us-east-1.on.aws', // extra label
        'https://-workspace.transform.us-east-1.on.aws',
        // Regions without an AWS Transform endpoint
        'https://workspace.transform.evil.on.aws',
        'https://workspace.transform.evil-region-x.on.aws',
        'https://workspace.transform.eu-west-1.on.aws',
        'https://workspace.transform-gamma.ap-northeast-2.on.aws',
    ]

    for (const input of invalid) {
        it(`rejects ${JSON.stringify(input)}`, () => {
            expect(parseAtxTenantUrl(input)).to.equal(undefined)
        })
    }
})
