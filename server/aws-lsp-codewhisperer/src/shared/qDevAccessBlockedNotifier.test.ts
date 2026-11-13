/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { MessageType } from '@aws/language-server-runtimes/protocol'
import { Logging, Notification } from '@aws/language-server-runtimes/server-interface'
import * as assert from 'assert'
import * as sinon from 'sinon'
import { createQDevAccessBlockedNotifier, Q_DEV_ACCESS_BLOCKED_NOTIFICATION_ID } from './qDevAccessBlockedNotifier'

describe('createQDevAccessBlockedNotifier', function () {
    let showNotification: sinon.SinonStub
    let notification: Notification
    let logging: Logging

    // The real service message, from ExceptionConstants.BUILDER_ID_ACCOUNT_LINK_BLOCKED_EXCEPTION_MESSAGE.
    const serviceMessage =
        'Please visit https://kiro.dev/ to purchase a Kiro subscription, which can be used with Amazon Q Developer.'

    beforeEach(function () {
        showNotification = sinon.stub()
        notification = {
            showNotification,
            onNotificationFollowup: sinon.stub(),
        } as unknown as Notification
        logging = {
            log: sinon.stub(),
            info: sinon.stub(),
            warn: sinon.stub(),
            error: sinon.stub(),
            debug: sinon.stub(),
        } as unknown as Logging
    })

    it('surfaces the service message verbatim as an error notification', function () {
        createQDevAccessBlockedNotifier(notification, logging)(new Error(serviceMessage))

        sinon.assert.calledOnce(showNotification)
        const params = showNotification.firstCall.args[0]
        assert.strictEqual(params.type, MessageType.Error)
        assert.strictEqual(params.content.text, serviceMessage)
        // Clients key off the id rather than the message text, which is service-owned copy.
        assert.strictEqual(params.id, Q_DEV_ACCESS_BLOCKED_NOTIFICATION_ID)
    })

    it('notifies at most once, since every request from a blocked identity fails', function () {
        const notify = createQDevAccessBlockedNotifier(notification, logging)

        notify(new Error(serviceMessage))
        notify(new Error(serviceMessage))
        notify(new Error(serviceMessage))

        sinon.assert.calledOnce(showNotification)
    })

    it('dedupes per instance, so a new connection can notify again', function () {
        createQDevAccessBlockedNotifier(notification, logging)(new Error(serviceMessage))
        createQDevAccessBlockedNotifier(notification, logging)(new Error(serviceMessage))

        sinon.assert.calledTwice(showNotification)
    })

    it('falls back to generic text when the service gave no message', function () {
        createQDevAccessBlockedNotifier(notification, logging)(new Error(''))

        const params = showNotification.firstCall.args[0]
        assert.ok(params.content.text.length > 0)
        assert.notStrictEqual(params.content.text, '')
    })

    it('does not throw when showNotification throws', function () {
        // Invoked from a client middleware error path: it must never be able to replace or mask the
        // service error that is being propagated to the caller.
        showNotification.throws(new Error('client exploded'))

        assert.doesNotThrow(() => createQDevAccessBlockedNotifier(notification, logging)(new Error(serviceMessage)))
    })

    it('does not throw for a non-Error argument', function () {
        assert.doesNotThrow(() => createQDevAccessBlockedNotifier(notification, logging)(undefined))
        sinon.assert.calledOnce(showNotification)
    })
})
