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
export const DISPLAY_FINDINGS = 'displayFindings'
export const SEMANTIC_SEARCH = 'semanticSearch'

/**
 * Names routed through built-in controller branches even when the corresponding
 * tool is disabled, conditionally registered, or registered later. MCP tools
 * must never claim one of these bare names.
 */
export const STATIC_BUILT_IN_TOOL_NAMES = [
    FS_READ,
    FS_WRITE,
    FS_REPLACE,
    LIST_DIRECTORY,
    GREP_SEARCH,
    FILE_SEARCH,
    EXECUTE_BASH,
    CODE_REVIEW,
    DISPLAY_FINDINGS,
    SEMANTIC_SEARCH,
] as const

/** Include both statically dispatched and currently registered built-in names. */
export function getReservedBuiltInToolNames(registeredNames: Iterable<string>): Set<string> {
    return new Set([...STATIC_BUILT_IN_TOOL_NAMES, ...registeredNames])
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
