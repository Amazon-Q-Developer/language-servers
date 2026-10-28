/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import * as sinon from 'sinon'
import {
    RejectedEditTracker,
    DEFAULT_REJECTED_EDIT_TRACKER_CONFIG,
    MAX_SIMILARITY_INPUT_LENGTH,
} from './rejectedEditTracker'

describe('RejectedEditTracker', function () {
    let sandbox: sinon.SinonSandbox
    let tracker: RejectedEditTracker
    let mockLogging: any
    let clock: sinon.SinonFakeTimers

    beforeEach(function () {
        sandbox = sinon.createSandbox()
        // Set a base time for tests
        const startTime = new Date('2025-04-21T12:00:00Z').getTime()

        clock = sandbox.useFakeTimers({
            now: startTime,
            shouldAdvanceTime: true,
        })

        mockLogging = {
            debug: sandbox.stub(),
            error: sandbox.stub(),
            info: sandbox.stub(),
            warn: sandbox.stub(),
            log: sandbox.stub(),
        }

        tracker = new RejectedEditTracker(mockLogging)
    })

    afterEach(function () {
        sandbox.restore()
        clock.restore()
    })

    describe('recordRejectedEdit', function () {
        it('should add rejected edit to the beginning of the array', function () {
            const edit = {
                content: 'rejected content',
                timestamp: Date.now(),
                documentUri: 'file:///test.js',
                position: { line: 10, character: 5 },
            }

            tracker.recordRejectedEdit(edit)

            // Access private field for testing
            const rejectedEdits = (tracker as any).rejectedEdits
            assert.strictEqual(rejectedEdits.length, 1)
            assert.strictEqual(rejectedEdits[0], edit)
        })

        it('should enforce max entries limit', function () {
            // Create a tracker with a small max entries limit
            const customTracker = new RejectedEditTracker(mockLogging, {
                ...DEFAULT_REJECTED_EDIT_TRACKER_CONFIG,
                maxEntries: 3,
            })

            // Add more edits than the limit
            for (let i = 0; i < 5; i++) {
                customTracker.recordRejectedEdit({
                    content: `rejected content ${i}`,
                    timestamp: Date.now(),
                    documentUri: 'file:///test.js',
                    position: { line: 10, character: 5 },
                })
            }

            // Access private field for testing
            const rejectedEdits = (customTracker as any).rejectedEdits

            // Should only keep the most recent 3 edits
            assert.strictEqual(rejectedEdits.length, 3)
            assert.strictEqual(rejectedEdits[0].content, 'rejected content 4')
            assert.strictEqual(rejectedEdits[1].content, 'rejected content 3')
            assert.strictEqual(rejectedEdits[2].content, 'rejected content 2')
        })
    })

    describe('isSimilarToRejected', function () {
        it('should return false when no rejected edits exist', function () {
            const result = tracker.isSimilarToRejected('some content', 'file:///test.js')
            assert.strictEqual(result, false)
        })

        it('should return false when document URI does not match', function () {
            tracker.recordRejectedEdit({
                content: 'rejected content',
                timestamp: Date.now(),
                documentUri: 'file:///test.js',
                position: { line: 10, character: 5 },
            })

            const result = tracker.isSimilarToRejected('rejected content', 'file:///different.js')
            assert.strictEqual(result, false)
        })

        it('should return true for identical content', function () {
            const content = 'rejected content'

            tracker.recordRejectedEdit({
                content,
                timestamp: Date.now(),
                documentUri: 'file:///test.js',
                position: { line: 10, character: 5 },
            })

            const result = tracker.isSimilarToRejected(content, 'file:///test.js')
            assert.strictEqual(result, true)
        })

        it('should return true for similar content above threshold', function () {
            const originalContent = 'function calculateSum(a, b) {\n  return a + b;\n}'
            const similarContent = 'function calculateSum(a, b) {\n  return a + b; // Add two numbers\n}'

            // Create a tracker with a lower similarity threshold for this test
            const customTracker = new RejectedEditTracker(mockLogging, {
                ...DEFAULT_REJECTED_EDIT_TRACKER_CONFIG,
                similarityThreshold: 0.7, // Lower threshold to ensure the test passes
            })

            customTracker.recordRejectedEdit({
                content: originalContent,
                timestamp: Date.now(),
                documentUri: 'file:///test.js',
                position: { line: 10, character: 5 },
            })

            const result = customTracker.isSimilarToRejected(similarContent, 'file:///test.js')
            assert.strictEqual(result, true)
        })

        it('should return false for content below similarity threshold', function () {
            const originalContent = 'function calculateSum(a, b) {\n  return a + b;\n}'
            const differentContent = 'function multiply(a, b) {\n  return a * b;\n}'

            tracker.recordRejectedEdit({
                content: originalContent,
                timestamp: Date.now(),
                documentUri: 'file:///test.js',
                position: { line: 10, character: 5 },
            })

            const result = tracker.isSimilarToRejected(differentContent, 'file:///test.js')
            assert.strictEqual(result, false)
        })

        it('should normalize content before comparison', function () {
            const originalContent = '@@ -1,3 +1,3 @@\nfunction sum(a, b) {\n  return a + b;\n}'
            const normalizedContent = 'function sum(a, b) {\n  return a + b;\n}'

            tracker.recordRejectedEdit({
                content: originalContent,
                timestamp: Date.now(),
                documentUri: 'file:///test.js',
                position: { line: 10, character: 5 },
            })

            const result = tracker.isSimilarToRejected(normalizedContent, 'file:///test.js')
            assert.strictEqual(result, true)
        })

        it('should handle different line endings', function () {
            const originalContent = 'function sum(a, b) {\r\n  return a + b;\r\n}'
            const unixContent = 'function sum(a, b) {\n  return a + b;\n}'

            tracker.recordRejectedEdit({
                content: originalContent,
                timestamp: Date.now(),
                documentUri: 'file:///test.js',
                position: { line: 10, character: 5 },
            })

            const result = tracker.isSimilarToRejected(unixContent, 'file:///test.js')
            assert.strictEqual(result, true)
        })

        it('should handle common indentation', function () {
            const originalContent = '    function sum(a, b) {\n      return a + b;\n    }'
            const unindentedContent = 'function sum(a, b) {\n  return a + b;\n}'

            tracker.recordRejectedEdit({
                content: originalContent,
                timestamp: Date.now(),
                documentUri: 'file:///test.js',
                position: { line: 10, character: 5 },
            })

            const result = tracker.isSimilarToRejected(unindentedContent, 'file:///test.js')
            assert.strictEqual(result, true)
        })
    })

    describe('normalizeEditContent', function () {
        it('should remove diff line numbers', function () {
            const content = '@@ -1,3 +1,4 @@ function test() {\n  console.log("test");\n}'

            // Access private method for testing
            const normalized = (tracker as any).normalizeEditContent(content)

            assert.strictEqual(normalized.includes('@@ -1,3 +1,4 @@'), false)
            assert.strictEqual(normalized.includes('function test()'), true)
        })

        it('should normalize line endings', function () {
            const content = 'line1\r\nline2\r\nline3'

            // Access private method for testing
            const normalized = (tracker as any).normalizeEditContent(content)

            assert.strictEqual(normalized, 'line1\nline2\nline3')
        })

        it('should remove leading and trailing empty lines', function () {
            const content = '\n\nfunction test() {\n  console.log("test");\n}\n\n'

            // Access private method for testing
            const normalized = (tracker as any).normalizeEditContent(content)

            assert.strictEqual(normalized, 'function test() {\n  console.log("test");\n}')
        })

        it('should remove common indentation', function () {
            const content = '    function test() {\n      console.log("test");\n    }'

            // Access private method for testing
            const normalized = (tracker as any).normalizeEditContent(content)

            assert.strictEqual(normalized, 'function test() {\n  console.log("test");\n}')
        })

        it('should handle mixed indentation correctly', function () {
            const content = '    function test() {\n  console.log("test");\n    }'

            // Access private method for testing
            const normalized = (tracker as any).normalizeEditContent(content)

            // Should only remove the common indentation (0 spaces in this case due to mixed indentation)
            assert.strictEqual(normalized, 'function test() {\nconsole.log("test");\n  }')
        })
    })

    describe('calculateSimilarity', function () {
        it('should return 1.0 for identical strings', function () {
            const str = 'identical string'

            // Access private method for testing
            const similarity = (tracker as any).calculateSimilarity(str, str)

            assert.strictEqual(similarity, 1.0)
        })

        it('should return 0.0 when one string is empty', function () {
            const str = 'some string'

            // Access private method for testing
            const similarity1 = (tracker as any).calculateSimilarity(str, '')
            const similarity2 = (tracker as any).calculateSimilarity('', str)

            assert.strictEqual(similarity1, 0.0)
            assert.strictEqual(similarity2, 0.0)
        })

        it('should calculate similarity based on Levenshtein distance', function () {
            const str1 = 'kitten'
            const str2 = 'sitting'

            // Access private method for testing
            const similarity = (tracker as any).calculateSimilarity(str1, str2)

            // Levenshtein distance between 'kitten' and 'sitting' is 3
            // Similarity = 1 - (3 / 7) = 1 - 0.428... = 0.571...
            assert.strictEqual(similarity, 1 - 3 / 7)
        })

        it('should not compute edit distance above the length cap', function () {
            // The distance here is 1, so a computed similarity would not be 0
            const str1 = 'a'.repeat(200_000)
            const str2 = 'a'.repeat(199_999) + 'b'

            const similarity = (tracker as any).calculateSimilarity(str1, str2)

            assert.strictEqual(similarity, 0.0)
        })

        it('should still compute edit distance at the length cap', function () {
            const str1 = 'a'.repeat(MAX_SIMILARITY_INPUT_LENGTH)
            const str2 = 'a'.repeat(MAX_SIMILARITY_INPUT_LENGTH - 1) + 'b'

            const similarity = (tracker as any).calculateSimilarity(str1, str2)

            assert.strictEqual(similarity, 1 - 1 / MAX_SIMILARITY_INPUT_LENGTH)
        })
    })

    describe('isSimilarToRejected above the length cap', function () {
        const documentUri = 'file:///test.js'
        const longContent = 'x'.repeat(MAX_SIMILARITY_INPUT_LENGTH * 10)

        function recordRejections(content: string, count: number) {
            for (let i = 0; i < count; i++) {
                tracker.recordRejectedEdit({
                    content,
                    timestamp: Date.now(),
                    documentUri,
                    position: { line: 0, character: 0 },
                })
            }
        }

        it('should still match an identical rejection', function () {
            recordRejections(longContent, 1)

            assert.strictEqual(tracker.isSimilarToRejected(longContent, documentUri), true)
        })

        it('should not compare a different edit by edit distance', function () {
            // At this threshold a computed similarity (1 - 1/20,001) would match every stored rejection
            tracker = new RejectedEditTracker(mockLogging, { maxEntries: 50, similarityThreshold: 0.5 })
            recordRejections(longContent, 50)

            assert.strictEqual(tracker.isSimilarToRejected(longContent + 'y', documentUri), false)
        })
    })

    describe('clear', function () {
        it('should remove all rejected edits', function () {
            // Add some rejected edits
            for (let i = 0; i < 3; i++) {
                tracker.recordRejectedEdit({
                    content: `content ${i}`,
                    timestamp: Date.now(),
                    documentUri: 'file:///test.js',
                    position: { line: 10, character: 5 },
                })
            }

            // Verify edits were added
            assert.strictEqual(tracker.getCount(), 3)

            // Clear the tracker
            tracker.clear()

            // Verify edits were removed
            assert.strictEqual(tracker.getCount(), 0)
        })
    })

    describe('getCount', function () {
        it('should return the number of rejected edits', function () {
            assert.strictEqual(tracker.getCount(), 0)

            tracker.recordRejectedEdit({
                content: 'content',
                timestamp: Date.now(),
                documentUri: 'file:///test.js',
                position: { line: 10, character: 5 },
            })

            assert.strictEqual(tracker.getCount(), 1)

            tracker.recordRejectedEdit({
                content: 'content 2',
                timestamp: Date.now(),
                documentUri: 'file:///test.js',
                position: { line: 20, character: 10 },
            })

            assert.strictEqual(tracker.getCount(), 2)
        })
    })

    describe('dispose', function () {
        it('should clear all rejected edits', function () {
            // Add some rejected edits
            for (let i = 0; i < 3; i++) {
                tracker.recordRejectedEdit({
                    content: `content ${i}`,
                    timestamp: Date.now(),
                    documentUri: 'file:///test.js',
                    position: { line: 10, character: 5 },
                })
            }

            // Verify edits were added
            assert.strictEqual(tracker.getCount(), 3)

            // Dispose the tracker
            tracker.dispose()

            // Verify edits were removed
            assert.strictEqual(tracker.getCount(), 0)
        })
    })

    describe('getInstance', function () {
        it('should return the same instance when called multiple times', function () {
            const instance1 = RejectedEditTracker.getInstance(mockLogging)
            const instance2 = RejectedEditTracker.getInstance(mockLogging)

            assert.strictEqual(instance1, instance2)
        })

        it('should use provided config', function () {
            // Reset the singleton instance for this test
            ;(RejectedEditTracker as any)._instance = undefined

            const customConfig = {
                maxEntries: 25,
                similarityThreshold: 0.9,
            }

            const instance = RejectedEditTracker.getInstance(mockLogging, customConfig)

            // Access private field for testing
            assert.strictEqual((instance as any).config.maxEntries, 25)
            assert.strictEqual((instance as any).config.similarityThreshold, 0.9)
        })
    })
})
