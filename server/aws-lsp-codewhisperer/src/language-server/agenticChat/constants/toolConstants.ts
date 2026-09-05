/**
 * Constants related to tools used in agenticChatController.ts
 * This file centralizes all tool names and related constants to improve code quality and maintainability.
 */

// File system tools
export const FS_READ = 'fsRead'
export const FS_WRITE = 'fsWrite'
export const FS_REPLACE = 'fsReplace'

// Directory tools
export const LIST_DIRECTORY = 'listDirectory'

// Search tools
export const GREP_SEARCH = 'grepSearch'
export const FILE_SEARCH = 'fileSearch'

// Shell tools
export const EXECUTE_BASH = 'executeBash'

// Code analysis tools
export const CODE_REVIEW = 'codeReview'

// Built-in tools that mutate filesystem or process state. When the user disables
// pair-programming/agentic mode (plan mode), these always require explicit approval
// regardless of workspace location, sensitive-path checks, or session-approved paths.
export const MUTATING_BUILTIN_TOOLS: ReadonlySet<string> = new Set([FS_WRITE, FS_REPLACE, EXECUTE_BASH])

export function isMutatingBuiltinTool(toolName: string): boolean {
    return MUTATING_BUILTIN_TOOLS.has(toolName)
}

/**
 * Returns the effective `requiresAcceptance` flag after applying plan-mode rules.
 *
 * Plan mode is triggered by `pairProgrammingMode === false` (the user toggled
 * agentic coding off). In plan mode every mutating built-in tool must prompt for
 * approval — even for in-workspace paths or session-approved paths — so the
 * model cannot silently change code. Read-only tools are unaffected.
 */
export function shouldRequireAcceptanceForBuiltinTool(
    toolName: string,
    pairProgrammingMode: boolean,
    toolRequiresAcceptance: boolean
): boolean {
    if (!pairProgrammingMode && isMutatingBuiltinTool(toolName)) {
        return true
    }
    return toolRequiresAcceptance
}

/**
 * Returns the effective `requiresAcceptance` flag for an MCP tool after applying
 * plan-mode rules. In plan mode every MCP tool requires approval — MCP servers
 * can do anything, and the user toggling agentic mode off is an explicit
 * "review everything" intent that overrides per-tool alwaysAllow until the
 * toggle is turned back on.
 */
export function shouldRequireAcceptanceForMcpTool(
    pairProgrammingMode: boolean,
    mcpRequiresAcceptance: boolean
): boolean {
    if (!pairProgrammingMode) {
        return true
    }
    return mcpRequiresAcceptance
}

// Tool use button IDs
export const BUTTON_RUN_SHELL_COMMAND = 'run-shell-command'
export const BUTTON_REJECT_SHELL_COMMAND = 'reject-shell-command'
export const BUTTON_REJECT_MCP_TOOL = 'reject-mcp-tool'
export const BUTTON_ALLOW_TOOLS = 'allow-tools'
export const BUTTON_UNDO_CHANGES = 'undo-changes'
export const BUTTON_UNDO_ALL_CHANGES = 'undo-all-changes'
export const BUTTON_STOP_SHELL_COMMAND = 'stop-shell-command'
export const BUTTON_PAIDTIER_UPGRADE_Q_LEARNMORE = 'paidtier-upgrade-q-learnmore'
export const BUTTON_PAIDTIER_UPGRADE_Q = 'paidtier-upgrade-q'

// Message ID suffixes
export const SUFFIX_PERMISSION = '_permission'
export const SUFFIX_UNDOALL = '_undoall'
export const SUFFIX_EXPLANATION = '_explanation'
