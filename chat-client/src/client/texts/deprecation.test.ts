import * as assert from 'assert'
import { ChatItemType } from '@aws/mynah-ui'
import { deprecationCard } from './deprecation'

describe('deprecationCard', () => {
    it('uses the approved copy and warning presentation', () => {
        assert.equal(deprecationCard.type, ChatItemType.ANSWER)
        assert.equal(deprecationCard.messageId, 'client-deprecation-notice')
        assert.equal(deprecationCard.title, 'IMPORTANT')
        assert.equal(deprecationCard.status, 'warning')
        assert.equal(deprecationCard.border, true)
        assert.equal(deprecationCard.fullWidth, true)
        assert.equal(deprecationCard.canBeDismissed, true)
        assert.equal(deprecationCard.header?.icon, 'warning')
        assert.equal(deprecationCard.header?.iconStatus, 'warning')
        assert.equal(deprecationCard.header?.body, '### Deprecation notice')
        assert.equal(
            deprecationCard.body,
            'On April 30, 2027, AWS will discontinue support for Amazon Q Developer IDE plugins. For capabilities similar to Amazon Q Developer IDE plugins, explore Kiro to access the latest models and features, including agentic coding, chat and MCP support.\n\n[Learn more](https://kiro.dev)'
        )
    })
})
