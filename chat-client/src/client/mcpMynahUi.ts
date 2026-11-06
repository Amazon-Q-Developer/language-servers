/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { ChatItemButton, DetailedListItem, ListItemEntry, MynahUI, SingularFormItem } from '@aws/mynah-ui'
import { Button, ListMcpServersResult, McpServerClickResult } from '@aws/language-server-runtimes-types'
import { Messager } from './messager'
import { toMynahIcon } from './utils'

// MCP action and element IDs
export const MCP_IDS = {
    // Server actions
    DISABLE_SERVER: 'mcp-disable-server',
    DELETE_SERVER: 'mcp-delete-server',
    ENABLE_SERVER: 'mcp-enable-server',
    FIX_SERVER: 'mcp-fix-server',
    OPEN_SERVER: 'open-mcp-server',

    // Menu items
    DETAILS_MENU: 'mcp-details-menu',
    SERVER_CLICK: 'mcp-server-click',

    // List actions
    ADD_NEW: 'add-new-mcp',
    REFRESH_LIST: 'refresh-mcp-list',
    UPDATE_LIST: 'update-mcp-list',

    // Form actions
    EDIT: 'edit-mcp',
    SAVE: 'save-mcp',
    CANCEL: 'cancel-mcp',
    CHANGE_TRANSPORT: 'change-transport',

    // Permission actions
    PERMISSION_CHANGE: 'mcp-permission-change',
    SAVE_PERMISSION_CHANGE: 'save-permission-change',
}

// MCP UI display constants
export const MCP_UI_CONSTANTS = {
    MAX_SERVER_NAME_LENGTH: 25, // Maximum length for server name display before truncation when deleting a server
}

// Type definitions for MCP server parameters
export type McpFilterOption = {
    type: 'textarea' | 'textinput' | 'select' | 'numericinput' | 'radiogroup' | 'list'
    id: string
    title: string
    description?: string
    icon?: string
    options?: Array<{ label: string; value: string }>
    mandatory?: boolean
    value?: ListItemEntry[]
    items?: SingularFormItem[]
}

export type McpListItem = {
    title: string
    description?: string
    icon?: string
    actions?: any[]
    groupActions?: any
}

export type McpListGroup = {
    groupName?: string
    children?: McpListItem[]
}

export type McpServerParams = McpServerClickResult & {
    header?: {
        title?: string
        description?: string
        status?: any
        actions?: Button[]
    }
    filterOptions?: McpFilterOption[]
    filterActions?: Button[]
    list?: McpListGroup[]
}

export class McpMynahUi {
    private mynahUi: MynahUI
    private messager: Messager
    private isMcpServersListActive = false
    private mcpDetailedList: { close: () => void } | undefined

    constructor(mynahUi: MynahUI, messager: Messager) {
        this.mynahUi = mynahUi
        this.messager = messager
    }

    close() {
        this.mcpDetailedList?.close()
    }

    /**
     * Processes filter options by converting icons to Mynah icons
     */
    private processFilterOptions(filterOptions?: McpFilterOption[]) {
        return filterOptions?.map(filter => ({
            ...filter,
            icon: filter.icon ? toMynahIcon(filter.icon) : undefined,
            mandatory: filter.mandatory ?? false,
            value: filter.value ?? undefined,
            items: filter.items ?? undefined,
        }))
    }

    /**
     * Processes filter actions by converting icons to Mynah icons
     */
    private processFilterActions(filterActions?: Button[]) {
        return filterActions?.map(action => ({
            ...action,
            icon: action.icon ? toMynahIcon(action.icon) : undefined,
        }))
    }

    /**
     * Processes a list group for the detailed list UI
     */
    private processListGroup(group: McpListGroup, isServerView = false) {
        const children = group.children?.map(item => {
            if (isServerView) {
                return {
                    id: item.title,
                    title: item.title,
                    description: item.description,
                    icon: toMynahIcon('tools'),
                    groupActions: item.groupActions,
                }
            }
            return {
                title: item.title,
                description: item.description,
                icon: item.icon ? toMynahIcon(item.icon) : undefined,
                actions: item.groupActions,
            }
        })

        return {
            groupName: group.groupName,
            children,
        }
    }

    /**
     * Creates a detailed list configuration for adding a new MCP server
     */
    private createAddMcpServerDetailedList(params: McpServerParams) {
        const detailedList = {
            selectable: false,
            textDirection: 'row',
            header: {
                title: params.header?.title || 'Add MCP Server',
                description: params.header?.description || '',
                status: params.header?.status || {},
                actions: params.header?.actions?.map(action => ({
                    ...action,
                    icon: action.icon ? toMynahIcon(action.icon) : undefined,
                })),
            },
            filterOptions: this.processFilterOptions(params.filterOptions),
            filterActions: params.filterActions,
        } as any

        const isEditMode = params.header?.title === 'Edit MCP Server'
        const hasError = params.header?.status?.status === 'error'

        const serverName = (params.filterOptions?.[1] as any)?.value

        if (isEditMode && hasError) {
            detailedList.header.actions = [
                {
                    id: MCP_IDS.DETAILS_MENU,
                    icon: toMynahIcon('ellipsis'),
                    items: [
                        {
                            id: MCP_IDS.DISABLE_SERVER,
                            text: `Disable MCP server`,
                            data: { serverName },
                        },
                        {
                            id: MCP_IDS.DELETE_SERVER,
                            confirmation: {
                                cancelButtonText: 'Cancel',
                                confirmButtonText: 'Delete',
                                title: `Delete ${serverName.length > MCP_UI_CONSTANTS.MAX_SERVER_NAME_LENGTH ? serverName.slice(0, MCP_UI_CONSTANTS.MAX_SERVER_NAME_LENGTH) + '...' : serverName} MCP server`,
                                description:
                                    'This configuration will be deleted and no longer available in Q. \n\n This cannot be undone.',
                            },
                            text: `Delete MCP server`,
                            data: { serverName },
                        },
                    ],
                },
            ]
        }

        // Process list if present
        if (params.list && params.list.length > 0) {
            detailedList.list = params.list.map(group => this.processListGroup(group))
        }

        return detailedList
    }

    /**
     * Creates a detailed list configuration for viewing an MCP server
     */
    private createViewMcpServerDetailedList(params: McpServerParams, isMcpRegistry: boolean = false) {
        const detailedList = {
            selectable: false,
            textDirection: 'row',
            list: params.list?.map(group => this.processListGroup(group, true)),
            filterOptions: this.processFilterOptions(params.filterOptions),
        } as any

        // Process header if present
        if (params.header) {
            detailedList.header = {
                title: params.header.title,
                description: params.header.description,
                status: params.header.status,
                actions: params.header.actions?.map(action => ({
                    ...action,
                    icon: action.icon ? toMynahIcon(action.icon) : undefined,
                    ...(action.id === MCP_IDS.DETAILS_MENU
                        ? {
                              items: [
                                  ...(!isMcpRegistry
                                      ? [
                                            {
                                                id: MCP_IDS.DISABLE_SERVER,
                                                text: `Disable MCP server`,
                                            },
                                        ]
                                      : []),
                                  {
                                      id: MCP_IDS.DELETE_SERVER,
                                      confirmation: {
                                          cancelButtonText: 'Cancel',
                                          confirmButtonText: 'Delete',
                                          title: `Delete ${
                                              params.header?.title &&
                                              params.header.title.length > MCP_UI_CONSTANTS.MAX_SERVER_NAME_LENGTH
                                                  ? params.header.title.slice(
                                                        0,
                                                        MCP_UI_CONSTANTS.MAX_SERVER_NAME_LENGTH
                                                    ) + '...'
                                                  : params.header?.title
                                          } MCP server`,
                                          description:
                                              'This configuration will be deleted and no longer available in Q. \n\n This cannot be undone.',
                                      },
                                      text: `Delete MCP server`,
                                  },
                              ],
                          }
                        : {}),
                })),
            }
        }

        // Add filter actions if present
        if (params.filterActions && params.filterActions.length > 0) {
            detailedList.filterActions = this.processFilterActions(params.filterActions)
        }

        return detailedList
    }

    /**
     * Displays the list of MCP servers
     */
    public listMcpServers(params: ListMcpServersResult) {
        this.isMcpServersListActive = true
        // Convert the ListMcpServersResult to the format expected by mynahUi.openDetailedList
        const detailedList: any = {
            selectable: 'clickable',
            textDirection: 'row',
            header: params.header
                ? {
                      title: params.header.title,
                      description: params.header.description,
                      status: params.header.status,
                      actions:
                          params.header.actions?.map(action => ({
                              ...action,
                              icon: action.icon ? toMynahIcon(action.icon) : undefined,
                              text: undefined,
                          })) || [],
                  }
                : undefined,
            filterOptions: params.filterOptions?.map(filter => ({
                ...filter,
                icon: toMynahIcon(filter.icon),
            })),
            list: params.list.map(group => ({
                groupName: group.groupName,
                children: group.children?.map(item => {
                    // Determine icon based on group name and status
                    let icon
                    let iconForegroundStatus

                    // Extract status from serverInformation if available
                    const serverInfoGroup = item.children?.find(child => child.groupName === 'serverInformation')
                    const statusChild = serverInfoGroup?.children?.find(child => child.title === 'status')
                    const status = statusChild?.description || 'DISABLED'
                    const consentDenied = group.groupName === 'Denied'

                    if (status === 'ENABLED') {
                        icon = 'ok-circled'
                        iconForegroundStatus = 'success'
                    } else if (status === 'FAILED') {
                        icon = 'cancel-circle'
                        iconForegroundStatus = 'error'
                    } else if (status === 'INITIALIZING') {
                        icon = 'progress'
                        iconForegroundStatus = 'info'
                    } else if (consentDenied) {
                        icon = 'block'
                        iconForegroundStatus = 'warning'
                    } else if (group.groupName === 'Disabled') {
                        icon = 'block'
                        iconForegroundStatus = 'info'
                    }

                    // Create actions based on group name
                    const actions = []
                    if (group.groupName === 'Active') {
                        if (status !== 'FAILED') {
                            const getToolCount = () => {
                                const serverInfoGroup = item.children?.find(
                                    child => child.groupName === 'serverInformation'
                                )
                                if (serverInfoGroup) {
                                    const toolCountChild = serverInfoGroup.children?.find(
                                        child => child.title === 'toolcount'
                                    )
                                    if (toolCountChild) {
                                        return toolCountChild.description ?? '0'
                                    }
                                }
                                return '0'
                            }

                            const toolCount = getToolCount()
                            actions.push({
                                id: MCP_IDS.OPEN_SERVER,
                                icon: toMynahIcon('tools'),
                                description: `${toolCount} available tools`,
                                text: toolCount,
                            })
                            actions.push({
                                id: MCP_IDS.OPEN_SERVER,
                                icon: toMynahIcon('right-open'),
                            })
                        } else {
                            actions.push({
                                id: MCP_IDS.FIX_SERVER,
                                icon: toMynahIcon('pencil'),
                                text: 'Fix Configuration',
                                description: 'Fix Configuration',
                            })
                            actions.push({
                                id: MCP_IDS.OPEN_SERVER,
                                icon: toMynahIcon('right-open'),
                                disabled: true,
                            })
                        }
                    } else if (consentDenied) {
                        actions.push({
                            id: MCP_IDS.OPEN_SERVER,
                            icon: toMynahIcon('right-open'),
                            description: 'View consent status and server configuration',
                        })
                    } else if (group.groupName === 'Disabled') {
                        actions.push({
                            id: MCP_IDS.ENABLE_SERVER,
                            icon: toMynahIcon('ok'),
                            text: 'Enable',
                            description: 'Enable',
                        })
                        actions.push({
                            id: MCP_IDS.DELETE_SERVER,
                            icon: toMynahIcon('trash'),
                            text: 'Delete',
                            description: 'Delete',
                            confirmation: {
                                cancelButtonText: 'Cancel',
                                confirmButtonText: 'Delete',
                                title: `Delete ${item.title.length > MCP_UI_CONSTANTS.MAX_SERVER_NAME_LENGTH ? item.title.slice(0, MCP_UI_CONSTANTS.MAX_SERVER_NAME_LENGTH) + '...' : item.title} MCP server`,
                                description:
                                    'This configuration will be deleted and no longer available in Q. \n\n This cannot be undone.',
                            },
                        })
                        actions.push({
                            id: MCP_IDS.OPEN_SERVER,
                            icon: toMynahIcon('right-open'),
                            disabled: true,
                        })
                    }

                    return {
                        id: MCP_IDS.SERVER_CLICK,
                        title: item.title,
                        icon: toMynahIcon(icon),
                        iconForegroundStatus: iconForegroundStatus,
                        groupActions: false,
                        actions: actions,
                    }
                }),
            })),
        }

        if (detailedList.filterOptions && detailedList.filterOptions.length > 0) {
            // eslint-disable-next-line no-extra-semi
            ;(detailedList.filterOptions[0] as any).autoFocus = true
        }

        this.mcpDetailedList = this.mynahUi.openDetailedList({
            detailedList: detailedList,
            events: {
                onFilterValueChange: (filterValues: Record<string, any>) => {
                    this.messager.onListMcpServers(filterValues)
                },
                onKeyPress: (e: KeyboardEvent) => {
                    if (e.key === 'Escape') {
                        this.mcpDetailedList?.close()
                    }
                },
                onItemSelect: (item: DetailedListItem) => {
                    const actionId = item.actions?.[0].id
                    if (actionId) {
                        this.messager.onMcpServerClick(actionId, item.title)
                    }
                },
                onItemClick: (item: DetailedListItem) => {
                    // actionId: open-mcp-server if valid server or mcp-fix-server if server needs to be fixed
                    const actionId = item.actions?.[0].id
                    if (actionId) {
                        this.messager.onMcpServerClick(actionId, item.title)
                    }
                },
                onActionClick: (action: ChatItemButton, item?: DetailedListItem) => {
                    this.messager.onMcpServerClick(action.id, item?.title)
                },
                onClose: () => {
                    this.isMcpServersListActive = false
                    this.mcpDetailedList = undefined
                },
                onTitleActionClick: button => {
                    this.messager.onMcpServerClick(button.id)
                },
            },
        })
    }

    /**
     * Creates a detailed list for registry server view
     */
    private createRegistryServerDetailedList(params: McpServerParams): any {
        return {
            selectable: false,
            textDirection: 'column' as const,
            header: {
                title: params.header?.title || 'Add MCP Server',
                description: params.header?.description || '',
                status: params.header?.status,
                actions: params.header?.actions?.map(action => ({
                    ...action,
                    icon: action.icon ? toMynahIcon(action.icon) : undefined,
                    ...(action.id === MCP_IDS.DETAILS_MENU
                        ? {
                              items: [
                                  {
                                      id: MCP_IDS.DELETE_SERVER,
                                      confirmation: {
                                          cancelButtonText: 'Cancel',
                                          confirmButtonText: 'Delete',
                                          title: `Delete ${
                                              params.header?.title &&
                                              params.header.title.length > MCP_UI_CONSTANTS.MAX_SERVER_NAME_LENGTH
                                                  ? params.header.title.slice(
                                                        0,
                                                        MCP_UI_CONSTANTS.MAX_SERVER_NAME_LENGTH
                                                    ) + '...'
                                                  : params.header?.title
                                          } MCP server`,
                                          description:
                                              'This configuration will be deleted and no longer available in Q. \n\n This cannot be undone.',
                                      },
                                      text: `Delete MCP server`,
                                  },
                              ],
                          }
                        : {}),
                })),
            },
            filterOptions: this.processFilterOptions(params.filterOptions),
            filterActions: params.filterActions,
            list: params.list?.map(group => ({
                groupName: group.groupName,
                children: group.children?.map((item: any) => ({
                    title: item.title,
                    description: item.description,
                    icon: toMynahIcon(item.icon || 'folder'),
                    actions: (item.actions || []).map((action: any) => ({
                        id: action.id,
                        text: action.text,
                        status: action.status,
                        disabled: action.disabled,
                    })),
                    groupActions: item.groupActions,
                })),
            })),
        }
    }

    /**
     * Creates events for registry server view
     */
    private createRegistryServerEvents(isEditMode: boolean = false, serverName?: string) {
        return {
            onBackClick: () => this.messager.onListMcpServers(),
            onActionClick: (action: ChatItemButton, item?: DetailedListItem) => {
                if (action.id === 'install-registry-server') {
                    this.mynahUi.toggleSplashLoader(true, '**Installing MCP Server**')
                    this.messager.onMcpServerClick(action.id, item?.title)
                }
            },
            onFilterActionClick: (actionParams: McpServerClickResult, filterValues?: Record<string, string>) => {
                if (actionParams.id === MCP_IDS.CANCEL) {
                    this.messager.onListMcpServers()
                    return
                }

                if (actionParams.id === MCP_IDS.SAVE) {
                    this.mynahUi.toggleSplashLoader(true, '**Installing MCP Server**')
                    this.messager.onMcpServerClick(actionParams.id, serverName, filterValues)
                }
            },
            onTitleActionClick: (action: ChatItemButton) => {
                const actionServerName = (action as any).data?.serverName || serverName
                this.messager.onMcpServerClick(action.id, actionServerName)
            },
        }
    }

    /**
     * Creates events for manual MCP server form
     */
    private createManualServerEvents(lastTransport: string) {
        let _lastTransport = lastTransport
        return {
            onBackClick: () => {
                this.messager.onListMcpServers()
            },
            onFilterValueChange: (filterValues: Record<string, any>) => {
                const newTransport = filterValues?.transport
                if (!newTransport || newTransport === _lastTransport) {
                    return
                }

                _lastTransport = newTransport
                this.messager.onMcpServerClick(MCP_IDS.CHANGE_TRANSPORT, filterValues.name, filterValues)
            },
            onFilterActionClick: (
                actionParams: McpServerClickResult,
                filterValues?: Record<string, string>,
                isValid?: boolean
            ) => {
                if (actionParams.id === MCP_IDS.CANCEL) {
                    this.messager.onListMcpServers()
                    return
                }

                // new and update will share the same save-mcp
                if (actionParams.id === MCP_IDS.SAVE) {
                    this.mynahUi.toggleSplashLoader(true, '**Activating MCP Server**')
                    this.messager.onMcpServerClick(actionParams.id, 'Save configuration', filterValues)
                }
            },
            onTitleActionClick: (action: ChatItemButton) => {
                const serverName = (action as any).data?.serverName
                this.messager.onMcpServerClick(action.id, serverName)
            },
        }
    }

    /**
     * Handles adding/editing MCP server (registry or manual)
     */
    private handleAddOrEditServer(params: McpServerClickResult) {
        // User is navigating away from list page
        this.isMcpServersListActive = false

        const typedParams = params as McpServerParams
        this.mynahUi.toggleSplashLoader(false)

        const isMcpRegistry = (params as any).isMcpRegistry === true
        const isEditMode = typedParams.header?.title === 'Edit MCP Server'

        if (isMcpRegistry) {
            const detailedList = this.createRegistryServerDetailedList(typedParams)
            const serverName = (typedParams.filterOptions?.find(f => f.id === 'name') as any)?.value as string
            const events = this.createRegistryServerEvents(isEditMode, serverName)
            this.mynahUi.openDetailedList({ detailedList, events }, true)
        } else {
            const uiFilters = (typedParams.filterOptions ?? []) as McpFilterOption[]
            const initial = uiFilters.find(f => f.id === 'transport')
            const lastTransport = initial?.value as unknown as string

            const detailedList = this.createAddMcpServerDetailedList(typedParams)
            const events = this.createManualServerEvents(lastTransport)
            this.mynahUi.openDetailedList({ detailedList, events }, true)
        }
    }

    /**
     * Handles opening MCP server details
     */
    private handleOpenServer(params: McpServerClickResult) {
        const typedParams = params as McpServerParams
        this.mynahUi.toggleSplashLoader(false)

        // User is navigating away from list page
        this.isMcpServersListActive = false

        const isMcpRegistry = (params as any).isMcpRegistry === true
        const detailedList = this.createViewMcpServerDetailedList(typedParams, isMcpRegistry)

        const mcpServerSheet = this.mynahUi.openDetailedList(
            {
                detailedList: detailedList,
                events: {
                    onFilterValueChange: (filterValues: Record<string, string>) => {
                        // Handle filter value changes for tool permissions
                        this.messager.onMcpServerClick(
                            MCP_IDS.PERMISSION_CHANGE,
                            detailedList.header?.title,
                            filterValues
                        )
                    },
                    onFilterActionClick: () => {},
                    onTitleActionClick: (action: ChatItemButton) => {
                        this.messager.onMcpServerClick(action.id, detailedList.header?.title)
                    },
                    onKeyPress: (e: KeyboardEvent) => {
                        if (e.key === 'Escape') {
                            mcpServerSheet.close()
                        }
                    },
                    onActionClick: (action: ChatItemButton) => {
                        // Handle action clicks (save, cancel, etc.)
                        this.messager.onMcpServerClick(action.id)
                    },
                    onClose: () => {
                        this.messager.onMcpServerClick(MCP_IDS.SAVE_PERMISSION_CHANGE)
                        this.isMcpServersListActive = false
                    },
                    onBackClick: () => {
                        this.messager.onMcpServerClick(MCP_IDS.SAVE_PERMISSION_CHANGE)
                        this.messager.onListMcpServers()
                    },
                },
            },
            true
        )
    }

    /**
     * Handles MCP server click events
     */
    public mcpServerClick(params: McpServerClickResult) {
        if (params.id === MCP_IDS.ADD_NEW || params.id === MCP_IDS.EDIT || params.id === MCP_IDS.FIX_SERVER) {
            this.handleAddOrEditServer(params)
        } else if (params.id === MCP_IDS.OPEN_SERVER) {
            this.handleOpenServer(params)
        } else if ([MCP_IDS.DISABLE_SERVER, MCP_IDS.DELETE_SERVER, MCP_IDS.ENABLE_SERVER].includes(params.id)) {
            if (params.id === MCP_IDS.ENABLE_SERVER && !this.isMcpServersListActive) {
                return
            }
            this.messager.onListMcpServers()
        } else if (params.id === MCP_IDS.UPDATE_LIST) {
            if (this.isMcpServersListActive) {
                this.messager.onListMcpServers()
            }
        }
    }
}
