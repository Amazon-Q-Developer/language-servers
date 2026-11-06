/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import { COMPACTION_BODY } from './constants'

describe('COMPACTION_BODY', () => {
    describe('below 100% used', () => {
        it('uses the "almost full" wording and shows the percentage', () => {
            for (const percentUsed of [1, 70, 79, 99]) {
                const body = COMPACTION_BODY(percentUsed)

                assert.ok(
                    body.includes('almost full'),
                    `Expected "almost full" wording at ${percentUsed}%, got: ${body}`
                )
                assert.ok(body.includes(`${percentUsed}%`), `Expected "${percentUsed}%" in body, got: ${body}`)
            }
        })
    })

    describe('at or above 100% used', () => {
        it('does not claim the context window is "almost" full', () => {
            // A long agentic session (many serialized tool specs plus accumulated
            // tool_use / tool_result history) can legitimately exceed the budget.
            for (const percentUsed of [100, 121, 244, 300]) {
                const body = COMPACTION_BODY(percentUsed)

                assert.ok(
                    !body.includes('almost full'),
                    `"almost full" is self-contradictory at ${percentUsed}%, got: ${body}`
                )
                assert.ok(body.includes('is full'), `Expected "is full" wording at ${percentUsed}%, got: ${body}`)
            }
        })

        it('preserves the real percentage rather than capping it at 100', () => {
            assert.ok(
                COMPACTION_BODY(300).includes('300%'),
                'Over-budget percentage should stay visible so it remains diagnosable'
            )
        })
    })

    it('always offers compaction as the alternative', () => {
        for (const percentUsed of [70, 99, 100, 300]) {
            assert.ok(
                COMPACTION_BODY(percentUsed).includes('Amazon Q can compact your history instead.'),
                `Expected the compaction offer at ${percentUsed}%`
            )
        }
    })
})
