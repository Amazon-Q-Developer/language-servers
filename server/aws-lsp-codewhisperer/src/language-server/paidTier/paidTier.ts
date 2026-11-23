import * as awsLsp from '@aws/language-server-runtimes/server-interface'

export type PaidTierMode = 'freetier' | 'freetier-limit' | 'upgrade-pending' | 'paidtier'

export const qProName = 'Q Developer Pro'
export const paidTierLearnMoreUrl = 'https://aws.amazon.com/q/pricing/'
export const paidTierManageSubscription =
    'https://us-east-1.console.aws.amazon.com/amazonq/developer/home?region=us-east-1#/subscriptions'
export const freeTierLimitUserMsg = `Monthly request limit reached. Connect your Builder ID to an AWS account to upgrade to ${qProName} and increase your monthly limits.`

// The service builds the subscription upgrade URL on https://signin.aws.amazon.com/oauth. Only this host is
// accepted, not its subdomains.
const SUBSCRIPTION_UPGRADE_HOST = 'signin.aws.amazon.com'

export type SubscriptionUpgradeUrlRejectionCategory =
    | 'missing-input'
    | 'malformed-url'
    | 'unsupported-scheme'
    | 'credentials'
    | 'non-default-port'
    | 'disallowed-host'

/**
 * The subscription upgrade URL from the service response, in normalized form. The client opens it in the external
 * browser, so anything other than an https URL on the AWS sign-in host (another scheme or host, a user name or
 * password, a non-default port) is rejected, and the result is undefined.
 * The optional rejection callback receives only a static category, never the input or URL components.
 */
export function parseSubscriptionUpgradeUrl(
    uri: string | undefined,
    onRejected?: (category: SubscriptionUpgradeUrlRejectionCategory) => void
): string | undefined {
    const reject = (category: SubscriptionUpgradeUrlRejectionCategory): undefined => {
        onRejected?.(category)
        return undefined
    }

    if (!uri) {
        return reject('missing-input')
    }

    let url: URL
    try {
        url = new URL(uri)
    } catch {
        return reject('malformed-url')
    }

    // URL lowercases the host and reports the default https port as ''.
    if (url.protocol !== 'https:') {
        return reject('unsupported-scheme')
    }
    if (url.username || url.password) {
        return reject('credentials')
    }
    if (url.port) {
        return reject('non-default-port')
    }
    if (url.hostname !== SUBSCRIPTION_UPGRADE_HOST) {
        return reject('disallowed-host')
    }

    return url.href
}

export function onPaidTierLearnMore(lsp: awsLsp.Lsp, log: awsLsp.Logging) {
    lsp.window
        .showDocument({
            external: true, // Client is expected to open the URL in a web browser.
            uri: paidTierLearnMoreUrl,
        })
        .catch(e => {
            log.log(`onPaidTierLearnMore: showDocument failed: ${(e as Error).message}`)
        })
}
