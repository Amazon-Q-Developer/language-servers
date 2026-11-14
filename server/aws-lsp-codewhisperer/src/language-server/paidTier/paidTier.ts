import * as awsLsp from '@aws/language-server-runtimes/server-interface'

export type PaidTierMode = 'freetier' | 'freetier-limit' | 'upgrade-pending' | 'paidtier'

export const qProName = 'Q Developer Pro'
export const paidTierLearnMoreUrl = 'https://aws.amazon.com/q/pricing/'
export const paidTierManageSubscription =
    'https://us-east-1.console.aws.amazon.com/amazonq/developer/home?region=us-east-1#/subscriptions'
export const freeTierLimitUserMsg = `Monthly request limit reached. Connect your Builder ID to an AWS account to upgrade to ${qProName} and increase your monthly limits.`

// The service builds the subscription upgrade URL on https://signin.aws.amazon.com/oauth. Subdomains are not
// accepted, because AWS accounts can choose subdomains of this host for their own sign-in pages.
const SUBSCRIPTION_UPGRADE_HOST = 'signin.aws.amazon.com'

/**
 * The subscription upgrade URL from the service response, in normalized form. The client opens it in the external
 * browser, so anything other than an https URL on the AWS sign-in host (another scheme or host, a user name or
 * password, a non-default port) is rejected, and the result is undefined.
 */
export function parseSubscriptionUpgradeUrl(uri: string | undefined): string | undefined {
    if (!uri) {
        return undefined
    }

    let url: URL
    try {
        url = new URL(uri)
    } catch {
        return undefined
    }

    // URL lowercases the host and reports the default https port as ''.
    if (url.protocol !== 'https:' || url.username || url.password || url.port) {
        return undefined
    }

    return url.hostname === SUBSCRIPTION_UPGRADE_HOST ? url.href : undefined
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
