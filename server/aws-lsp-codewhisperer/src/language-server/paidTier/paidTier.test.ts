import { expect } from 'chai'
import { parseSubscriptionUpgradeUrl } from './paidTier'

describe('parseSubscriptionUpgradeUrl', () => {
    // The form of the URL that the service returns
    const signInUrl =
        'https://signin.aws.amazon.com/oauth?redirect_uri=https://us-east-1.console.aws.amazon.com/amazonq/developer/home?hashArgs=%23%2Fsubscriptions&isauthcode=true&region=us-east-1&client_id=arn:aws:signin:::console/codewhisperer&response_type=code'

    const accepted: Array<[string, string]> = [
        [signInUrl, signInUrl],
        ['HTTPS://SIGNIN.AWS.AMAZON.COM/oauth', 'https://signin.aws.amazon.com/oauth'],
        ['https://signin.aws.amazon.com:443/oauth', 'https://signin.aws.amazon.com/oauth'],
    ]
    for (const [input, expected] of accepted) {
        it(`accepts ${input.slice(0, 60)} and returns it in normalized form`, () => {
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
})
