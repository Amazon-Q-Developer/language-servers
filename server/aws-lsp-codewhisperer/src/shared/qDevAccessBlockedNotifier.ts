/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Logging, Notification } from '@aws/language-server-runtimes/server-interface'
import { MessageType } from '@aws/language-server-runtimes/protocol'

/**
 * Fallback text, used only if the service somehow rejects the request without a message. Normally the
 * service's own message is shown verbatim: RTS reuses `FEATURE_NOT_SUPPORTED` across several gates, so
 * the reason tells us *that* access is blocked while only the message says *why* and what to do about
 * it. Substituting our own copy here would risk telling the customer the wrong thing.
 */
const FALLBACK_TEXT = 'Amazon Q Developer is not available for this account.'

const TITLE = 'Amazon Q Developer'

/**
 * Stable identifier so clients can recognise this notification without inspecting its text. Clients
 * must not match on the message: it is the service's own copy and is expected to change.
 */
export const Q_DEV_ACCESS_BLOCKED_NOTIFICATION_ID = 'qDevPluginAccessBlocked'

/**
 * Builds the reaction to RTS blocking Q Developer plugin access for the current identity, for use as
 * {@link CodeWhispererServiceToken.onAccessBlocked}.
 *
 * Surfaces the service's message through the existing `showNotification` channel. That channel was
 * chosen deliberately for backwards compatibility: the language server ships ahead of the plugins, and
 * every plugin version already in the market will pick up this server. Because
 * `showNotification` is a no-op in the runtime unless the client advertised
 * `initializationOptions.aws.awsClientCapabilities.window.notifications`, older plugins that know
 * nothing about this are unaffected -- they neither receive nor need to handle anything new. Plugins
 * that do advertise it get the real reason surfaced instead of failing silently. No new protocol
 * message, and no client-side change, is required for that to hold.
 *
 * Notifies at most once per instance. RTS gates plugin traffic before the activity runs, so a blocked
 * identity fails *every* request; without this the customer would get one notification per API call.
 * The dedupe is intentionally scoped to the instance rather than the process: a new service instance is
 * built when the connection changes, so switching accounts correctly gets a fresh notification rather
 * than being silently suppressed.
 *
 * Never throws -- it is invoked from a client middleware error path, and must not be able to interfere
 * with the service error being propagated to the caller.
 */
export function createQDevAccessBlockedNotifier(
    notification: Notification,
    logging: Logging
): (error: unknown) => void {
    let alreadyNotified = false

    return (error: unknown) => {
        if (alreadyNotified) {
            return
        }
        alreadyNotified = true

        const serviceMessage = (error as Error | undefined)?.message?.trim()
        const text = serviceMessage && serviceMessage.length > 0 ? serviceMessage : FALLBACK_TEXT

        try {
            logging.warn(`Q Developer plugin access is blocked for this identity: ${text}`)
            notification.showNotification({
                id: Q_DEV_ACCESS_BLOCKED_NOTIFICATION_ID,
                type: MessageType.Error,
                content: {
                    title: TITLE,
                    text,
                },
            })
        } catch (e) {
            logging.debug(`Failed to surface Q Developer access-blocked notification: ${(e as Error)?.message}`)
        }
    }
}
