import * as assert from 'assert'
import { ChatItemType } from '@aws/mynah-ui'
import { pairProgrammingPromptInput, pairProgrammingModeOn, pairProgrammingModeOff } from './pairProgramming'

describe('pairProgramming', () => {
    describe('pairProgrammingPromptInput', () => {
        it('has correct properties', () => {
            assert.equal(pairProgrammingPromptInput.type, 'switch')
            assert.equal(pairProgrammingPromptInput.id, 'pair-programmer-mode')
            assert.equal(pairProgrammingPromptInput.tooltip, 'Turn OFF agentic coding')
            if (pairProgrammingPromptInput.type === 'switch') {
                // Type guard for switch type
                assert.equal(pairProgrammingPromptInput.alternateTooltip, 'Turn ON agentic coding')
            }
            assert.equal(pairProgrammingPromptInput.value, 'true')
            assert.equal(pairProgrammingPromptInput.icon, 'code-block')
        })
    })

    describe('pairProgrammingModeOn', () => {
        it('has correct properties', () => {
            assert.equal(pairProgrammingModeOn.type, ChatItemType.DIRECTIVE)
            assert.equal(pairProgrammingModeOn.contentHorizontalAlignment, 'center')
            assert.equal(pairProgrammingModeOn.fullWidth, true)
            assert.equal(pairProgrammingModeOn.body, 'Agentic coding - ON')
        })
    })

    describe('pairProgrammingModeOff', () => {
        it('has correct properties', () => {
            assert.equal(pairProgrammingModeOff.type, ChatItemType.DIRECTIVE)
            assert.equal(pairProgrammingModeOff.contentHorizontalAlignment, 'center')
            assert.equal(pairProgrammingModeOff.fullWidth, true)
            assert.equal(pairProgrammingModeOff.body, 'Agentic coding - OFF')
        })
    })
})
