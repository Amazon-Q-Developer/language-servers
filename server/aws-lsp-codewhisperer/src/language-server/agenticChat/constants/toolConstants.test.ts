import * as assert from 'assert'
import {
    EXECUTE_BASH,
    FILE_SEARCH,
    FS_READ,
    FS_REPLACE,
    FS_WRITE,
    GREP_SEARCH,
    LIST_DIRECTORY,
    isMutatingBuiltinTool,
    shouldRequireAcceptanceForBuiltinTool,
    shouldRequireAcceptanceForMcpTool,
} from './toolConstants'

describe('toolConstants.isMutatingBuiltinTool', () => {
    it('returns true for fsWrite (creates/overwrites files)', () => {
        assert.strictEqual(isMutatingBuiltinTool(FS_WRITE), true)
    })

    it('returns true for fsReplace (edits files)', () => {
        assert.strictEqual(isMutatingBuiltinTool(FS_REPLACE), true)
    })

    it('returns true for executeBash (runs shell commands)', () => {
        assert.strictEqual(isMutatingBuiltinTool(EXECUTE_BASH), true)
    })

    it('returns false for fsRead', () => {
        assert.strictEqual(isMutatingBuiltinTool(FS_READ), false)
    })

    it('returns false for listDirectory', () => {
        assert.strictEqual(isMutatingBuiltinTool(LIST_DIRECTORY), false)
    })

    it('returns false for grepSearch', () => {
        assert.strictEqual(isMutatingBuiltinTool(GREP_SEARCH), false)
    })

    it('returns false for fileSearch', () => {
        assert.strictEqual(isMutatingBuiltinTool(FILE_SEARCH), false)
    })

    it('returns false for unknown tool names', () => {
        assert.strictEqual(isMutatingBuiltinTool('codeReview'), false)
        assert.strictEqual(isMutatingBuiltinTool('semanticSearch'), false)
        assert.strictEqual(isMutatingBuiltinTool(''), false)
        assert.strictEqual(isMutatingBuiltinTool('mystery_tool'), false)
    })
})

describe('toolConstants.shouldRequireAcceptanceForBuiltinTool (plan-mode gate)', () => {
    describe('agentic mode ON (pairProgrammingMode === true)', () => {
        it('preserves the tool-supplied flag for fsWrite when path is approved', () => {
            assert.strictEqual(shouldRequireAcceptanceForBuiltinTool(FS_WRITE, true, false), false)
        })

        it('preserves the tool-supplied flag for fsWrite when path is outside workspace', () => {
            assert.strictEqual(shouldRequireAcceptanceForBuiltinTool(FS_WRITE, true, true), true)
        })

        it('preserves the tool-supplied flag for fsRead', () => {
            assert.strictEqual(shouldRequireAcceptanceForBuiltinTool(FS_READ, true, false), false)
            assert.strictEqual(shouldRequireAcceptanceForBuiltinTool(FS_READ, true, true), true)
        })
    })

    describe('plan mode (pairProgrammingMode === false)', () => {
        it('forces approval for fsWrite even when in-workspace', () => {
            // In plan mode, in-workspace fsWrite must prompt — otherwise the user's
            // explicit "review everything" intent is silently ignored.
            assert.strictEqual(shouldRequireAcceptanceForBuiltinTool(FS_WRITE, false, false), true)
        })

        it('forces approval for fsReplace even when in-workspace', () => {
            assert.strictEqual(shouldRequireAcceptanceForBuiltinTool(FS_REPLACE, false, false), true)
        })

        it('keeps requiring approval for fsWrite when also outside workspace', () => {
            assert.strictEqual(shouldRequireAcceptanceForBuiltinTool(FS_WRITE, false, true), true)
        })

        it('forces approval for executeBash regardless of tool-supplied flag', () => {
            assert.strictEqual(shouldRequireAcceptanceForBuiltinTool(EXECUTE_BASH, false, false), true)
            assert.strictEqual(shouldRequireAcceptanceForBuiltinTool(EXECUTE_BASH, false, true), true)
        })

        it('does NOT force approval for read-only tools — chat must still investigate code in plan mode', () => {
            assert.strictEqual(shouldRequireAcceptanceForBuiltinTool(FS_READ, false, false), false)
            assert.strictEqual(shouldRequireAcceptanceForBuiltinTool(LIST_DIRECTORY, false, false), false)
            assert.strictEqual(shouldRequireAcceptanceForBuiltinTool(GREP_SEARCH, false, false), false)
            assert.strictEqual(shouldRequireAcceptanceForBuiltinTool(FILE_SEARCH, false, false), false)
        })

        it('still respects the tool-supplied flag for read-only tools', () => {
            // e.g. fsRead returns true when reading a path outside the workspace
            assert.strictEqual(shouldRequireAcceptanceForBuiltinTool(FS_READ, false, true), true)
        })
    })
})

describe('toolConstants.shouldRequireAcceptanceForMcpTool (plan-mode gate)', () => {
    it('preserves the MCP-supplied flag when agentic mode is on', () => {
        // alwaysAllow MCP tool: validator returned false → still false
        assert.strictEqual(shouldRequireAcceptanceForMcpTool(true, false), false)
        // ask MCP tool: validator returned true → still true
        assert.strictEqual(shouldRequireAcceptanceForMcpTool(true, true), true)
    })

    it('forces approval for every MCP tool in plan mode, including alwaysAllow', () => {
        // This is the strict plan-mode policy: user toggled off agentic mode
        // means review everything, even MCP tools the user previously marked alwaysAllow.
        assert.strictEqual(shouldRequireAcceptanceForMcpTool(false, false), true)
        assert.strictEqual(shouldRequireAcceptanceForMcpTool(false, true), true)
    })
})
