import { FeatureContext } from '@aws/chat-client-ui-types'
import { Button, ChatMessage, ChatResult } from '@aws/language-server-runtimes-types'
import { ChatItem, ChatItemButton, ChatItemContent, ChatItemType, MynahIcons, TreeNodeDetails } from '@aws/mynah-ui'
import { BUTTON_UNDO_ALL_CHANGES, BUTTON_UNDO_CHANGES, SUFFIX_PERMISSION } from './constants'

export function toMynahIcon(icon: string | undefined): MynahIcons | undefined {
    return icon && Object.values<string>(MynahIcons).includes(icon) ? (icon as MynahIcons) : undefined
}

export function toMynahButtons(buttons: Button[] | undefined): ChatItemButton[] | undefined {
    return buttons?.map(button => ({ ...button, icon: toMynahIcon(button.icon) }))
}

export function toMynahHeader(header: ChatMessage['header']): ChatItemContent['header'] {
    if (!header) return undefined

    // Create a new object with only the properties that are compatible with ChatItemContent['header']
    const { summary, ...headerWithoutSummary } = header

    return {
        ...headerWithoutSummary,
        icon: toMynahIcon(header.icon),
        buttons: toMynahButtons(header.buttons),
        status: header.status ? { ...header.status, icon: toMynahIcon(header.status.icon) } : undefined,
        summary: header.summary as ChatItemContent['summary'],
    }
}

export function toMynahFileList(fileList: ChatMessage['fileList']): ChatItemContent['fileList'] {
    if (!fileList) return undefined
    const fileListTree = {
        fileTreeTitle: '',
        filePaths: fileList.filePaths?.map(file => file),
        rootFolderTitle: fileList.rootFolderTitle ?? 'Context',
        flatList: true,
        hideFileCount: true,
        collapsed: true,
        details: Object.fromEntries(
            Object.entries(fileList.details || {}).map(([filePath, fileDetails]) => [
                filePath,
                {
                    label:
                        fileDetails.lineRanges
                            ?.map(range =>
                                range.first === -1 || range.second === -1 ? '' : `line ${range.first} - ${range.second}`
                            )
                            .join(', ') || '',
                    description: fileDetails.description,
                    visibleName:
                        filePath.split('/').filter(Boolean).pop() || filePath.split('/').slice(-2, -1)[0] || filePath,
                    clickable: true,
                    data: {
                        fullPath: fileDetails.fullPath || fileDetails.description || '',
                    },
                },
            ])
        ),
    }

    return fileListTree
}

export function toDetailsWithoutIcon(
    details: Record<string, TreeNodeDetails> | undefined
): Record<string, TreeNodeDetails> {
    return Object.fromEntries(
        Object.entries(details || {}).map(([filePath, fileDetails]) => [filePath, { ...fileDetails, icon: null }])
    )
}

export function toMynahContextCommand(feature?: FeatureContext): any {
    if (!feature || !feature.value.stringValue) {
        return {}
    }

    return {
        command: feature.value.stringValue,
        id: feature.value.stringValue,
        description: feature.variation,
    }
}

/**
 * Converts a contextList from ChatResult to a header format for ChatItem
 */
export function contextListToHeader(contextList?: ChatResult['contextList']): ChatItem['header'] {
    if (contextList === undefined) {
        return undefined
    }

    return {
        fileList: {
            fileTreeTitle: '',
            filePaths: contextList.filePaths?.map(file => file),
            rootFolderTitle: contextList.rootFolderTitle ?? 'Context',
            flatList: true,
            collapsed: true,
            hideFileCount: true,
            details: Object.fromEntries(
                Object.entries(contextList.details || {}).map(([filePath, fileDetails]) => [
                    filePath,
                    {
                        label:
                            fileDetails.lineRanges
                                ?.map(range =>
                                    range.first === -1 || range.second === -1
                                        ? ''
                                        : `line ${range.first} - ${range.second}`
                                )
                                .join(', ') || '',
                        description: fileDetails.description,
                        clickable: true,
                        data: {
                            fullPath: fileDetails.fullPath || fileDetails.description || '',
                        },
                    },
                ])
            ),
        },
    }
}

/**
 * Creates a properly formatted chat item for MCP tool summary with accordion view
 */
export function createMcpToolSummaryItem(message: ChatMessage, isPartialResult?: boolean): Partial<ChatItem> {
    return {
        type: ChatItemType.ANSWER,
        messageId: message.messageId,
        summary: {
            content: message.summary?.content
                ? {
                      padding: false,
                      wrapCodes: true,
                      header: message.summary.content.header
                          ? {
                                icon: message.summary.content.header.icon as any,
                                body: message.summary.content.header.body,
                                buttons: message.summary.content?.header?.buttons as any,
                                status: isPartialResult ? (message.summary.content?.header?.status as any) : undefined,
                                fileList: undefined,
                            }
                          : undefined,
                  }
                : undefined,
            collapsedContent:
                message.summary?.collapsedContent?.map(item => ({
                    body: item.body,
                    header: item.header
                        ? {
                              body: item.header.body,
                          }
                        : undefined,
                    fullWidth: true,
                    padding: false,
                    muted: false,
                    wrapCodes: item.header?.body === 'Parameters' ? true : false,
                    codeBlockActions: { copy: null, 'insert-to-cursor': null },
                })) || [],
        },
    }
}

/**
 * Prepares a ChatItem from a ChatMessage with proper formatting for tool cards,
 * file lists, MCP summaries, etc.
 */
export function prepareChatItemFromMessage(
    message: ChatMessage,
    isPairProgrammingMode: boolean,
    isPartialResult?: boolean
): Partial<ChatItem> {
    const contextHeader = contextListToHeader(message.contextList)
    const header = contextHeader || toMynahHeader(message.header) // Is this mutually exclusive?
    const fileList = toMynahFileList(message.fileList)

    let processedHeader = header
    if (message.type === 'tool') {
        // Handle MCP tool summary with accordion view
        if (message.summary) {
            return createMcpToolSummaryItem(message, isPartialResult)
        }
        processedHeader = { ...header }
        if (header?.buttons) {
            processedHeader.buttons = header.buttons.map(button => ({
                ...button,
                status: button.status ?? 'clear',
            }))
        }
        if (header?.fileList) {
            processedHeader.fileList = {
                ...header.fileList,
                fileTreeTitle: '',
                hideFileCount: true,
                details: toDetailsWithoutIcon(header.fileList.details),
                renderAsPills:
                    !header.fileList.details ||
                    (Object.values(header.fileList.details).every(detail => !detail.changes) &&
                        (!header.buttons || !header.buttons.some(button => button.id === BUTTON_UNDO_CHANGES)) &&
                        !header.status?.icon),
            }
        }
        if (!isPartialResult) {
            if (processedHeader && !message.header?.status) {
                processedHeader.status = undefined
            }
        }
    }

    // Check if header should be included
    const includeHeader =
        processedHeader &&
        ((processedHeader.buttons !== undefined &&
            processedHeader.buttons !== null &&
            processedHeader.buttons.length > 0) ||
            processedHeader.status !== undefined ||
            processedHeader.icon !== undefined ||
            processedHeader.fileList !== undefined)

    const padding =
        message.type === 'tool' ? (fileList ? true : message.messageId?.endsWith(SUFFIX_PERMISSION)) : undefined

    const processedButtons: ChatItemButton[] | undefined = toMynahButtons(message.buttons)?.map(button =>
        button.id === BUTTON_UNDO_ALL_CHANGES ? { ...button, position: 'outside' } : button
    )
    // Adding this conditional check to show the stop message in the center.
    const contentHorizontalAlignment: ChatItem['contentHorizontalAlignment'] = undefined

    // If message.header?.status?.text is Stopped or Rejected or Ignored etc.. card should be in disabled state.
    const shouldMute =
        message.header?.status?.text !== undefined &&
        ['Stopped', 'Rejected', 'Ignored', 'Failed', 'Error'].includes(message.header.status.text)

    return {
        body: message.body,
        header: includeHeader ? processedHeader : undefined,
        buttons: processedButtons,
        fileList,
        // file diffs in the header need space
        fullWidth: message.type === 'tool' && includeHeader ? true : undefined,
        padding,
        contentHorizontalAlignment,
        wrapCodes: message.type === 'tool',
        codeBlockActions:
            message.type === 'tool'
                ? { 'insert-to-cursor': null, copy: null }
                : isPairProgrammingMode
                  ? { 'insert-to-cursor': null }
                  : undefined,
        ...(shouldMute ? { muted: true } : {}),
    }
}

/**
 * Converts a ChatMessage (e.g., from history restoration) to a ChatItem for MynahUI rendering.
 * This applies the same transformations as prepareChatItemFromMessage to ensure tool cards,
 * file lists, MCP summaries, etc. render correctly.
 */
export function chatMessageToChatItem(message: ChatMessage, isPairProgrammingMode: boolean = false): ChatItem {
    // Convert message type to ChatItemType
    const typeMap: Record<string, ChatItemType> = {
        prompt: ChatItemType.PROMPT,
        answer: ChatItemType.ANSWER,
        'answer-stream': ChatItemType.ANSWER_STREAM,
        directive: ChatItemType.DIRECTIVE,
        tool: ChatItemType.ANSWER,
        'system-prompt': ChatItemType.SYSTEM_PROMPT,
    }
    const msgType = message.type ?? 'answer'
    const chatItemType = typeMap[msgType] ?? ChatItemType.ANSWER

    // Use prepareChatItemFromMessage for consistent rendering
    const preparedItem = prepareChatItemFromMessage(message, isPairProgrammingMode, false)

    return {
        type: chatItemType,
        messageId: message.messageId,
        relatedContent: message.relatedContent,
        codeReference: message.codeReference,
        canBeVoted: message.canBeVoted,
        followUp: message.followUp as any,
        ...preparedItem,
    }
}

export type ChatLinkTarget = { kind: 'link' } | { kind: 'file'; filePath: string; fullPath?: string } | { kind: 'none' }

/**
 * Decides where a link clicked in a chat answer goes: http(s) URLs open as links, local paths
 * go to the file-click handler, and everything else (other schemes, `//host` paths) is dropped.
 */
export function classifyChatLink(href: string | undefined): ChatLinkTarget {
    if (!href) {
        return { kind: 'none' }
    }

    try {
        const url = new URL(href)
        if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) {
            return { kind: 'link' }
        }
    } catch {
        // Not an absolute URL; check below whether it is a local path.
    }

    // Split off the query and fragment before decoding so an encoded `#` or `?` stays part of the file name.
    let decoded: string
    try {
        decoded = decodeURIComponent(href.split(/[?#]/)[0])
    } catch {
        return { kind: 'none' }
    }

    // `\\host\share`, `\/host` and `%2F%2Fhost` all reach a remote host or device once normalized.
    if (!decoded || decoded.replace(/\\/g, '/').startsWith('//')) {
        return { kind: 'none' }
    }

    // `src/foo.ts:10` and `foo.ts:10:5` name a file and a line. Requiring a `.` or separator before the line keeps
    // `scheme:123` links classified as schemes below.
    const withoutLine = decoded.replace(/:\d+(?::\d+)?$/, '')
    const filePath = withoutLine !== decoded && /[./\\]/.test(withoutLine) ? withoutLine : decoded

    const normalizedFilePath = filePath.replace(/\\/g, '/')
    // A Windows drive letter resembles a URI scheme but denotes an absolute local path.
    if (/^[a-zA-Z]:\//.test(normalizedFilePath)) {
        return { kind: 'file', filePath, fullPath: filePath }
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalizedFilePath)) {
        return { kind: 'none' }
    }

    return normalizedFilePath.startsWith('/')
        ? { kind: 'file', filePath, fullPath: filePath }
        : { kind: 'file', filePath }
}
