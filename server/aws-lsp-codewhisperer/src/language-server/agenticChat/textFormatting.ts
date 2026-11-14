import { ToolUse } from '@amzn/codewhisperer-streaming'

function codeBlocked(s: string) {
    const codeBlock = `\`\`\`\``

    return `${codeBlock}${s}${codeBlock}`
}

function boldText(s: string) {
    return `**${s}**`
}

function formatJson(s: any) {
    return codeBlocked(JSON.stringify(s, null, 2))
}

export function executeToolMessage(toolUse: ToolUse) {
    return `⚡️ Executing: tool **${toolUse.name}**
                Arguments: ${formatJson(toolUse.input)}`
}

export function toolResultMessage(toolUse: ToolUse, result: any) {
    return `✅ Tool ${boldText(toolUse.name ?? 'unknown tool')} completed with result: 
                ${formatJson(result)}`
}

export function toolErrorMessage(toolUse: ToolUse, errorMessage: string) {
    return `❌ Tool ${boldText(toolUse.name ?? 'unknown tool')} failed
    \`Error: ${errorMessage}\``
}

/**
 * Fence for a markdown code block that holds the text. It is longer than any run of backticks
 * in the text, so no line of the text can end the block.
 */
export function codeFence(text: string): string {
    const longestRun = (String(text).match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0)
    return '`'.repeat(Math.max(3, longestRun + 1))
}

/**
 * Characters that a command card shows as escapes, because they can hide part of a command, change the order in
 * which its text appears, or look like another character: control characters other than line feeds and tabs,
 * format characters (such as bidirectional overrides and isolates, zero-width characters and tag characters), line
 * and paragraph separators, spaces other than U+0020, and the other default ignorable characters.
 */
const HIDDEN_COMMAND_CHARACTERS = /(?![\n\t ])[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu

/**
 * The command as a card shows it, with each hidden character written as \uXXXX, or as \u{XXXXX} above U+FFFF. Only
 * the shown copy changes: the command that runs is the original. An escape has no backticks, so the shown copy
 * needs the same code fence as the command.
 */
function shownCommand(command: string): string {
    return String(command).replace(HIDDEN_COMMAND_CHARACTERS, character => {
        const codePoint = character.codePointAt(0)!
        const hex = codePoint.toString(16).toUpperCase()
        return codePoint > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`
    })
}

/** Start of a shell code block that shows the full command, for output to follow */
export function shellCommandBlockStart(command: string): string {
    const shown = shownCommand(command)
    return `${codeFence(shown)}shell\n${shown}`
}

/** A shell code block that shows the full command */
export function shellCommandBlock(command: string): string {
    return `${shellCommandBlockStart(command)}\n${codeFence(command)}`
}

/**
 * Text to show inside a code block, with each line that starts with three or more backticks
 * indented by four spaces, so that no line of it can end the block
 */
export function codeBlockLines(text: string): string {
    return text.replace(/^( {0,3})(?=```)/gm, (_match, indent: string) => indent + ' '.repeat(4 - indent.length))
}
