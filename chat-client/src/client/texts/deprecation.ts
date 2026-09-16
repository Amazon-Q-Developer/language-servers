import { ChatItem, ChatItemType } from '@aws/mynah-ui'

export const deprecationCard: ChatItem = {
    type: ChatItemType.ANSWER,
    messageId: 'client-deprecation-notice',
    title: 'IMPORTANT',
    status: 'warning',
    border: true,
    fullWidth: true,
    canBeDismissed: true,
    header: {
        icon: 'warning',
        iconStatus: 'warning',
        body: '### Deprecation notice',
    },
    body: 'On April 30, 2027, AWS will discontinue support for Amazon Q Developer IDE plugins. For capabilities similar to Amazon Q Developer IDE plugins, explore Kiro to access the latest models and features, including agentic coding, chat and MCP support.\n\n[Learn more](https://kiro.dev)',
}
