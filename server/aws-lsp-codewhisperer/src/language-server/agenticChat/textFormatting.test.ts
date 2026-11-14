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

        it('show bidirectional, zero-width and other hidden characters as escapes', () => {
            const cases: [string, string][] = [
                // A right-to-left override makes "rm -rf ~ #" look like other text
                ['echo safe \u202E# ~ fr- mr', 'echo safe \\u202E# ~ fr- mr'],
                ['\u2066rm -rf ~\u2069 \u2067x\u2068', '\\u2066rm -rf ~\\u2069 \\u2067x\\u2068'],
                [
                    'cat \u200Bsecret \u200C\u200D\u2060\uFEFF\u061C\u200E\u200F',
                    'cat \\u200Bsecret \\u200C\\u200D\\u2060\\uFEFF\\u061C\\u200E\\u200F',
                ],
                // Tag characters can hold text that is not shown at all
                ['ls \u{E0041}\u{E0042}', 'ls \\u{E0041}\\u{E0042}'],
                // Interlinear annotation characters can hide the text between them
                ['echo \uFFF9ok\uFFFArm -rf ~\uFFFB', 'echo \\uFFF9ok\\uFFFArm -rf ~\\uFFFB'],
                // A carriage return or a line separator can split one line of the command into two lines on screen
                ['echo a\rrm -rf b', 'echo a\\u000Drm -rf b'],
                ['echo a\u2028rm -rf b\u2029', 'echo a\\u2028rm -rf b\\u2029'],
                // A space other than U+0020 looks like a space but is part of a word for the shell
                ['rm -rf ./build\u00A0~ \u3000x', 'rm -rf ./build\\u00A0~ \\u3000x'],
                ['echo \u001B[2Jdone\u0007\u0000', 'echo \\u001B[2Jdone\\u0007\\u0000'],
                ['echo \u3164 \u115F \uFE0F', 'echo \\u3164 \\u115F \\uFE0F'],
            ]
            for (const [command, shown] of cases) {
                assert.strictEqual(shellCommandBlock(command), '```shell\n' + shown + '\n```')
                assert.strictEqual(shellCommandBlockStart(command), '```shell\n' + shown)
            }
        })

        it('show line feeds, tabs, spaces and other visible text as they are', () => {
            const command = 'for f in *.ts; do\n\techo "$f" > out.txt && cat < in.txt | grep -i \'ü€中😀\'\ndone'

            assert.strictEqual(shellCommandBlock(command), '```shell\n' + command + '\n```')
        })

        it('keep the fence of the command, so the fence that closes the output still matches', () => {
            for (const command of ['echo `\u202E`', 'echo ``\u200B```', '```\u2028````', 'echo \u{E0060}`````']) {
                const start = shellCommandBlockStart(command)
                assert.ok(start.startsWith(codeFence(command) + 'shell\n'), JSON.stringify(start))
                assert.strictEqual(shellCommandBlock(command), start + '\n' + codeFence(command))
            }
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
