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

function longestBacktickRun(text: string): number {
    return (String(text).match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0)
}

/**
 * Fence for a markdown code block that holds the text. It is longer than any run of backticks
 * in the text, so no line of the text can end the block.
 */
export function codeFence(text: string): string {
    return '`'.repeat(Math.max(3, longestBacktickRun(text) + 1))
}

/**
 * A markdown code span for the text, so markdown makes no links or emphasis in it. Its delimiter is
 * longer than any run of backticks in the text, so the text cannot end the span. Give the text on
 * one line: if the text has a line end, a delimiter of three or more backticks could open a fenced
 * code block, and markdown turns line ends in a code span into spaces anyway. The chat client can
 * still read <, > and & in a code span as HTML, so escape them first if the text can contain them,
 * as formatServerConfigForReview does.
 */
export function codeSpan(text: string): string {
    const delimiter = '`'.repeat(longestBacktickRun(text) + 1)
    // A space separates a backtick at the start or end of the text from the delimiter. Markdown removes it again.
    const padding = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
    return `${delimiter}${padding}${text}${padding}${delimiter}`
}

/** Start of a shell code block that shows the full command, for output to follow */
export function shellCommandBlockStart(command: string): string {
    return `${codeFence(command)}shell\n${command}`
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
