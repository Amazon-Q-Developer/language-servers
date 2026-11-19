import * as assert from 'assert'
import { codeBlockLines, codeFence, shellCommandBlock, shellCommandBlockStart } from './textFormatting'
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
})
