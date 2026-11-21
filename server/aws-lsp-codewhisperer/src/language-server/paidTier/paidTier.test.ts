import { expect } from 'chai'
import * as sinon from 'sinon'
import { parseSubscriptionUpgradeUrl } from './paidTier'

describe('parseSubscriptionUpgradeUrl', () => {
    // The form of the URL that the service returns
    const signInUrl =
        'https://signin.aws.amazon.com/oauth?redirect_uri=https://us-east-1.console.aws.amazon.com/amazonq/developer/home?hashArgs=%23%2Fsubscriptions&isauthcode=true&region=us-east-1&client_id=arn:aws:signin:::console/codewhisperer&response_type=code'

    const accepted: Array<[string, string]> = [
        [signInUrl, signInUrl],
        ['HTTPS://SIGNIN.AWS.AMAZON.COM/oauth', 'https://signin.aws.amazon.com/oauth'],
        ['https://signin.aws.amazon.com:443/oauth', 'https://signin.aws.amazon.com/oauth'],
        // The URL that opens is the normalized one: a backslash is a path separator, and tabs, line breaks and
        // surrounding spaces are removed, so these URLs still open the sign-in host
        ['https://signin.aws.amazon.com\\@example.com/oauth', 'https://signin.aws.amazon.com/@example.com/oauth'],
        [' https://signin.aws.amazon.com/oa\tuth\n', 'https://signin.aws.amazon.com/oauth'],
    ]
    for (const [input, expected] of accepted) {
        it(`accepts ${JSON.stringify(input.slice(0, 60))} and returns it in normalized form`, () => {
            expect(parseSubscriptionUpgradeUrl(input)).to.equal(expected)
        })
    }

    const rejected: Array<string | undefined> = [
        undefined,
        '',
        'not a url',
        'http://signin.aws.amazon.com/oauth',
        'vscode://publisher.extension/path',
        'file:///tmp/file.txt',
        'data:text/plain,hello',
        'https://example.com/oauth',
        'https://signin.aws.amazon.com.example.com/oauth',
        'https://examplesignin.aws.amazon.com/oauth',
        'https://example.signin.aws.amazon.com/console',
        'https://us-east-1.signin.aws.amazon.com/oauth',
        'https://us-east-1.console.aws.amazon.com/amazonq/developer/home',
        'https://user:password@signin.aws.amazon.com/oauth',
        'https://example.com\\@signin.aws.amazon.com/oauth',
        'https://signin.aws.amazon.com:8443/oauth',
        'https://signin.aws.amazon.com./oauth',
    ]
    for (const input of rejected) {
        it(`rejects ${JSON.stringify(input)}`, () => {
            expect(parseSubscriptionUpgradeUrl(input)).to.be.undefined
        })
    }

    describe('rejection categories', () => {
        const cases: Array<[string | undefined, string]> = [
            [undefined, 'missing-input'],
            ['', 'missing-input'],
            ['not a url?activationToken=TEST-CATEGORY', 'malformed-url'],
            ['http://rejected.example:8443/private?activationToken=TEST-CATEGORY#fragment', 'unsupported-scheme'],
            ['https://user:password@signin.aws.amazon.com/private?activationToken=TEST-CATEGORY', 'credentials'],
            ['https://user@signin.aws.amazon.com/private?activationToken=TEST-CATEGORY', 'credentials'],
            ['https://:password@signin.aws.amazon.com/private?activationToken=TEST-CATEGORY', 'credentials'],
            ['https://signin.aws.amazon.com:8443/private?activationToken=TEST-CATEGORY', 'non-default-port'],
            ['https://rejected.example/private?activationToken=TEST-CATEGORY#fragment', 'disallowed-host'],
        ]

        for (const [input, category] of cases) {
            it(`reports only the static ${category} category for ${JSON.stringify(input)}`, () => {
                const onRejected = sinon.stub()

                expect(parseSubscriptionUpgradeUrl(input, onRejected)).to.be.undefined

                sinon.assert.calledOnceWithExactly(onRejected, category)
            })
        }

        for (const [input, expected] of accepted) {
            it(`does not report a rejection for ${input.slice(0, 60)}`, () => {
                const onRejected = sinon.stub()

                expect(parseSubscriptionUpgradeUrl(input, onRejected)).to.equal(expected)

                sinon.assert.notCalled(onRejected)
            })
        }
    })
})
