import * as assert from 'assert'
import { codeBlockLines, codeFence, codeSpan, shellCommandBlock, shellCommandBlockStart } from './textFormatting'

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

    describe('code spans', () => {
        it('wrap text with no backticks in single backticks', () => {
            assert.strictEqual(codeSpan('npx -y pkg@1'), '`npx -y pkg@1`')
        })

        it('use a delimiter longer than the longest run of backticks in the text', () => {
            assert.strictEqual(codeSpan('a`b'), '``a`b``')
            assert.strictEqual(codeSpan('a```b `c` d'), '````a```b `c` d````')
        })

        it('add a space between the delimiter and a backtick at the start or the end', () => {
            assert.strictEqual(codeSpan('`x'), '`` `x ``')
            assert.strictEqual(codeSpan('x`'), '`` x` ``')
            assert.strictEqual(codeSpan('``'), '``` `` ```')
        })

        it('leave markdown and HTML in the text unchanged', () => {
            assert.strictEqual(
                codeSpan('[docs](https://example.com) <b>x</b> **y**'),
                '`[docs](https://example.com) <b>x</b> **y**`'
            )
        })
    })

    describe('text inside a code block', () => {
        it('indents each line that starts with three or more backticks, after up to three spaces, to four spaces', () => {
            assert.strictEqual(
                codeBlockLines('```\nCompleted\n ````\n  ```\r   ```shell\r\n```'),
                '    ```\nCompleted\n    ````\n    ```\r    ```shell\r\n    ```'
            )
        })

        it('leaves other lines unchanged', () => {
            const text = 'echo `date`\n`x`\n``y``\n    ```\n\t```\n-- ```'

            assert.strictEqual(codeBlockLines(text), text)
        })
    })
})
