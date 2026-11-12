import * as assert from 'assert'
import {
    codeBlockLines,
    codeFence,
    MAX_SHOWN_TOOL_NAME_LENGTH,
    shellCommandBlock,
    shellCommandBlockStart,
    toolNameText,
} from './textFormatting'
import { AgenticChatResultStream } from './agenticChatResultStream'

describe('textFormatting', () => {
    describe('shell command blocks', () => {
        it('use a fence of three backticks for a command without backticks', () => {
            assert.strictEqual(shellCommandBlock('ls -la'), '```shell\nls -la\n```')
        })

        it('use a fence longer than any run of backticks in the command', () => {
            const command = 'echo start\n```\nCompleted\n`````\necho `date`'

            assert.strictEqual(codeFence(command), '``````')
            assert.strictEqual(shellCommandBlock(command), '``````shell\n' + command + '\n``````')
        })

        it('start a block for output to follow, which the same fence closes', () => {
            const command = 'echo ```'

            assert.strictEqual(shellCommandBlockStart(command), '````shell\necho ```')
            assert.strictEqual(codeFence(command), '````')
        })
    })

    describe('text inside a code block', () => {
        it('indents each line that starts with three or more backticks, after up to three spaces, to four spaces', () => {
            assert.strictEqual(
                codeBlockLines('```\nCompleted\n ````\n  ```\r   ```shell\r\n```'),
                '    ```\nCompleted\n    ````\n    ```\r    ```shell\r\n    ```'
            )
        })

        it('keeps a run of backticks that is split between two writes from ending the block', () => {
            // The result stream joins the writes of one card with a line break, so each write starts a line
            for (const writes of [
                ['out\n``', '`'],
                ['out\n`', '``'],
                ['out', '```'],
                ['out\n ', '```'],
            ]) {
                const body = writes.map(codeBlockLines).join(AgenticChatResultStream.resultDelimiter)

                assert.ok(!/^ {0,3}```/m.test(body), JSON.stringify(body))
            }
        })

        it('leaves other lines unchanged', () => {
            const text = 'echo `date`\n`x`\n``y``\n    ```\n\t```\n-- ```'

            assert.strictEqual(codeBlockLines(text), text)
        })
    })

    describe('MCP tool names', () => {
        it('leave letters, digits and spaces unchanged', () => {
            assert.strictEqual(toolNameText('Search docs 2'), 'Search docs 2')
        })

        it('escape markdown punctuation', () => {
            assert.strictEqual(toolNameText('get_weather-v1.2'), 'get\\_weather\\-v1\\.2')
            assert.strictEqual(
                toolNameText('**a** [b](c) `d` <e> #f'),
                '\\*\\*a\\*\\* \\[b\\]\\(c\\) \\`d\\` \\<e\\> \\#f'
            )
            assert.strictEqual(toolNameText('a\\b'), 'a\\\\b')
        })

        it('show the name on one line', () => {
            assert.strictEqual(toolNameText('  a\n\nb\r\n\tc\u0007d\u2028e  '), 'a b c d e')
        })

        it('remove invisible formatting characters', () => {
            assert.strictEqual(toolNameText('report\u202Efdp.exe\u200B'), 'reportfdp\\.exe')
        })

        it('keep a name of the maximum length', () => {
            const name = 'a'.repeat(MAX_SHOWN_TOOL_NAME_LENGTH)

            assert.strictEqual(toolNameText(name), name)
        })

        it('cut a longer name short with an ellipsis', () => {
            const shown = toolNameText('a'.repeat(MAX_SHOWN_TOOL_NAME_LENGTH + 10))

            assert.strictEqual(shown, 'a'.repeat(MAX_SHOWN_TOOL_NAME_LENGTH - 1) + '\u2026')
        })

        it('do not split a character made of two code units', () => {
            const shown = toolNameText('\u{1F600}'.repeat(MAX_SHOWN_TOOL_NAME_LENGTH + 1))

            assert.strictEqual(shown, '\u{1F600}'.repeat(MAX_SHOWN_TOOL_NAME_LENGTH - 1) + '\u2026')
        })
    })
})
