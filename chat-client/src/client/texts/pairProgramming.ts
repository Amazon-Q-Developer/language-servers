import { ChatItem, ChatItemFormItem, ChatItemType } from '@aws/mynah-ui'

export const pairProgrammingPromptInput: ChatItemFormItem = {
    type: 'switch',
    id: 'pair-programmer-mode',
    tooltip: 'Turn OFF agentic coding',
    alternateTooltip: 'Turn ON agentic coding',
    value: 'true',
    icon: 'code-block',
}

export const pairProgrammingModeOn: ChatItem = {
    type: ChatItemType.DIRECTIVE,
    contentHorizontalAlignment: 'center',
    fullWidth: true,
    body: 'Agentic coding - ON',
}

export const pairProgrammingModeOff: ChatItem = {
    type: ChatItemType.DIRECTIVE,
    contentHorizontalAlignment: 'center',
    fullWidth: true,
    body: 'Agentic coding - OFF',
}
