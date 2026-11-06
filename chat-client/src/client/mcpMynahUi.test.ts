/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as assert from 'assert'
import sinon from 'ts-sinon'
import { McpMynahUi } from './mcpMynahUi'
import { ListMcpServersResult, McpServerClickResult } from '@aws/language-server-runtimes-types'
import { ChatItemButton, DetailedListItem, MynahUI } from '@aws/mynah-ui'
import { Messager } from './messager'
import * as utils from './utils'

describe('McpMynahUi', () => {
    let mynahUi: MynahUI
    let messager: Messager
    let mcpMynahUi: McpMynahUi
    let toMynahIconStub: sinon.SinonStub

    beforeEach(() => {
        // Mock MynahUI
        mynahUi = {
            openDetailedList: sinon.stub().returns({
                close: sinon.stub(),
            }),
            toggleSplashLoader: sinon.stub(),
        } as unknown as MynahUI

        // Mock Messager
        messager = {
            onListMcpServers: sinon.stub(),
            onMcpServerClick: sinon.stub(),
        } as unknown as Messager

        // Mock toMynahIcon utility function
        toMynahIconStub = sinon.stub(utils, 'toMynahIcon').returns('mocked-icon' as any)

        // Create instance of McpMynahUi
        mcpMynahUi = new McpMynahUi(mynahUi, messager)
    })

    afterEach(() => {
        sinon.restore()
    })

    describe('listMcpServers', () => {
        it('should set isMcpServersListActive to true', () => {
            // Create mock params
            const params: ListMcpServersResult = {
                list: [],
            }

            // Call the method
            mcpMynahUi.listMcpServers(params)

            // Verify isMcpServersListActive is set to true
            // We can't directly access private properties, but we can test the behavior
            // by calling mcpServerClick with update-mcp-list
            const updateParams: McpServerClickResult = {
                id: 'update-mcp-list',
            }
            mcpMynahUi.mcpServerClick(updateParams)

            // If isMcpServersListActive is true, onListMcpServers should be called
            sinon.assert.calledOnce(messager.onListMcpServers as sinon.SinonStub)
        })

        it('should call mynahUi.openDetailedList with correct parameters', () => {
            // Create mock params with header
            const params: ListMcpServersResult = {
                header: {
                    title: 'Test Title',
                    description: 'Test Description',
                    status: { status: 'success' },
                },
                list: [
                    {
                        groupName: 'Active',
                        children: [
                            {
                                title: 'Server 1',
                                children: [
                                    {
                                        groupName: 'serverInformation',
                                        children: [
                                            { title: 'status', description: 'ENABLED' },
                                            { title: 'toolcount', description: '5' },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            }

            // Call the method
            mcpMynahUi.listMcpServers(params)

            // Verify openDetailedList was called
            sinon.assert.calledOnce(mynahUi.openDetailedList as sinon.SinonStub)

            // Verify the parameters
            const callArgs = (mynahUi.openDetailedList as sinon.SinonStub).firstCall.args[0]
            assert.strictEqual(callArgs.detailedList.selectable, 'clickable')
            assert.strictEqual(callArgs.detailedList.textDirection, 'row')
            assert.strictEqual(callArgs.detailedList.header.title, 'Test Title')
            assert.strictEqual(callArgs.detailedList.header.description, 'Test Description')
            assert.deepStrictEqual(callArgs.detailedList.header.status, { status: 'success' })

            // Verify the actions in the header (no default actions are added when header is provided)
            assert.strictEqual(callArgs.detailedList.header.actions.length, 0)

            // Verify the list structure
            assert.strictEqual(callArgs.detailedList.list.length, 1)
            assert.strictEqual(callArgs.detailedList.list[0].groupName, 'Active')
            assert.strictEqual(callArgs.detailedList.list[0].children.length, 1)
            assert.strictEqual(callArgs.detailedList.list[0].children[0].title, 'Server 1')

            // Verify the icon and status are set correctly for ENABLED server
            assert.strictEqual(callArgs.detailedList.list[0].children[0].iconForegroundStatus, 'success')

            // Verify the actions for the server
            assert.strictEqual(callArgs.detailedList.list[0].children[0].actions.length, 2)
            assert.strictEqual(callArgs.detailedList.list[0].children[0].actions[0].id, 'open-mcp-server')
            assert.strictEqual(callArgs.detailedList.list[0].children[0].actions[0].text, '5')
            assert.strictEqual(callArgs.detailedList.list[0].children[0].actions[1].id, 'open-mcp-server')
        })

        it('opens consent details for denied servers in their own section', () => {
            mcpMynahUi.listMcpServers({
                list: [
                    {
                        groupName: 'Denied',
                        children: [
                            {
                                title: 'Denied server',
                                description: 'consent not granted',
                                children: [
                                    {
                                        groupName: 'serverInformation',
                                        children: [
                                            { title: 'status', description: 'DISABLED' },
                                            { title: 'toolcount', description: '0' },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            })

            const { detailedList, events } = (mynahUi.openDetailedList as sinon.SinonStub).firstCall.args[0]
            const row = detailedList.list[0].children[0]
            assert.strictEqual(detailedList.list[0].groupName, 'Denied')
            assert.strictEqual(row.description, undefined)
            assert.strictEqual(row.iconForegroundStatus, 'warning')
            sinon.assert.calledWith(toMynahIconStub, 'block')
            assert.strictEqual(row.actions.length, 1)
            assert.strictEqual(row.actions[0].id, 'open-mcp-server')
            assert.strictEqual(row.actions[0].text, undefined)
            assert.strictEqual(row.actions[0].description, 'View consent status and server configuration')
            sinon.assert.calledWith(toMynahIconStub, 'right-open')
            assert.notStrictEqual(row.actions[0].disabled, true)

            // Mouse, keyboard and the explicit action all open details, never Enable.
            events.onItemClick(row)
            events.onItemSelect(row)
            events.onActionClick(row.actions[0], row)
            const clickStub = messager.onMcpServerClick as sinon.SinonStub
            sinon.assert.calledThrice(clickStub)
            for (const call of clickStub.getCalls()) {
                assert.deepStrictEqual(call.args, ['open-mcp-server', 'Denied server'])
            }
        })

        it('should handle disabled servers correctly', () => {
            // Create mock params with a disabled server
            const params: ListMcpServersResult = {
                list: [
                    {
                        groupName: 'Disabled',
                        children: [
                            {
                                title: 'Server 2',
                                children: [],
                            },
                        ],
                    },
                ],
            }

            // Call the method
            mcpMynahUi.listMcpServers(params)

            // Verify openDetailedList was called
            sinon.assert.calledOnce(mynahUi.openDetailedList as sinon.SinonStub)

            // Verify the parameters
            const callArgs = (mynahUi.openDetailedList as sinon.SinonStub).firstCall.args[0]

            // Verify the list structure
            assert.strictEqual(callArgs.detailedList.list.length, 1)
            assert.strictEqual(callArgs.detailedList.list[0].groupName, 'Disabled')
            assert.strictEqual(callArgs.detailedList.list[0].children.length, 1)
            assert.strictEqual(callArgs.detailedList.list[0].children[0].title, 'Server 2')

            // Verify the icon and status are set correctly for disabled server
            assert.strictEqual(callArgs.detailedList.list[0].children[0].iconForegroundStatus, 'info')

            // Verify the actions for the disabled server
            assert.strictEqual(callArgs.detailedList.list[0].children[0].actions.length, 3)
            assert.strictEqual(callArgs.detailedList.list[0].children[0].actions[0].id, 'mcp-enable-server')
            assert.strictEqual(callArgs.detailedList.list[0].children[0].actions[1].id, 'mcp-delete-server')
            assert.strictEqual(callArgs.detailedList.list[0].children[0].actions[2].id, 'open-mcp-server')
            assert.strictEqual(callArgs.detailedList.list[0].children[0].actions[2].disabled, true)
        })

        it('should handle failed servers correctly', () => {
            // Create mock params with a failed server
            const params: ListMcpServersResult = {
                list: [
                    {
                        groupName: 'Active',
                        children: [
                            {
                                title: 'Server 3',
                                children: [
                                    {
                                        groupName: 'serverInformation',
                                        children: [{ title: 'status', description: 'FAILED' }],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            }

            // Call the method
            mcpMynahUi.listMcpServers(params)

            // Verify openDetailedList was called
            sinon.assert.calledOnce(mynahUi.openDetailedList as sinon.SinonStub)

            // Verify the parameters
            const callArgs = (mynahUi.openDetailedList as sinon.SinonStub).firstCall.args[0]

            // Verify the list structure
            assert.strictEqual(callArgs.detailedList.list.length, 1)
            assert.strictEqual(callArgs.detailedList.list[0].groupName, 'Active')
            assert.strictEqual(callArgs.detailedList.list[0].children.length, 1)
            assert.strictEqual(callArgs.detailedList.list[0].children[0].title, 'Server 3')

            // Verify the icon and status are set correctly for failed server
            assert.strictEqual(callArgs.detailedList.list[0].children[0].iconForegroundStatus, 'error')

            // Verify the actions for the failed server
            assert.strictEqual(callArgs.detailedList.list[0].children[0].actions.length, 2)
            assert.strictEqual(callArgs.detailedList.list[0].children[0].actions[0].id, 'mcp-fix-server')
            assert.strictEqual(callArgs.detailedList.list[0].children[0].actions[1].id, 'open-mcp-server')
            assert.strictEqual(callArgs.detailedList.list[0].children[0].actions[1].disabled, true)
        })

        it('should handle events correctly', () => {
            // Create mock params
            const params: ListMcpServersResult = {
                list: [],
            }

            // Create mock sheet with close method
            const mockSheet = {
                close: sinon.stub(),
            }
            ;(mynahUi.openDetailedList as sinon.SinonStub).returns(mockSheet)

            // Call the method
            mcpMynahUi.listMcpServers(params)

            // Get the events object
            const callArgs = (mynahUi.openDetailedList as sinon.SinonStub).firstCall.args[0]
            const events = callArgs.events

            // Test onFilterValueChange event
            const filterValues = { filter1: 'value1' }
            events.onFilterValueChange(filterValues)
            sinon.assert.calledWith(messager.onListMcpServers as sinon.SinonStub, filterValues)

            // Test onKeyPress event with Escape key
            const escapeEvent = { key: 'Escape' } as KeyboardEvent
            events.onKeyPress(escapeEvent)
            sinon.assert.calledOnce(mockSheet.close)

            // Test onItemSelect event
            const mockSelectItem = {
                id: 'mcp-server-click',
                title: 'Server 1',
                actions: [{ id: 'open-mcp-server' }],
            } as DetailedListItem
            events.onItemSelect(mockSelectItem)
            sinon.assert.calledWith(messager.onMcpServerClick as sinon.SinonStub, 'open-mcp-server', 'Server 1')

            // Test onItemClick event
            const mockClickItem = {
                id: 'mcp-server-click',
                title: 'Server 1',
                actions: [{ id: 'open-mcp-server' }],
            } as DetailedListItem
            events.onItemClick(mockClickItem)
            sinon.assert.calledWith(messager.onMcpServerClick as sinon.SinonStub, 'open-mcp-server', 'Server 1')

            // Test onActionClick event
            const mockAction = { id: 'add-new-mcp' } as ChatItemButton
            const mockActionItem = { title: 'Server 1' } as DetailedListItem
            events.onActionClick(mockAction, mockActionItem)
            sinon.assert.calledWith(messager.onMcpServerClick as sinon.SinonStub, 'add-new-mcp', 'Server 1')

            // Test onClose event
            events.onClose()
            // We can't directly verify isMcpServersListActive is set to false,
            // but we can test the behavior by calling mcpServerClick with update-mcp-list again
            ;(messager.onListMcpServers as sinon.SinonStub).resetHistory()
            const updateParams: McpServerClickResult = {
                id: 'update-mcp-list',
            }
            mcpMynahUi.mcpServerClick(updateParams)
            // If isMcpServersListActive is false, onListMcpServers should not be called
            sinon.assert.notCalled(messager.onListMcpServers as sinon.SinonStub)

            // Test onTitleActionClick event
            const mockButton = { id: 'refresh-mcp-list' }
            events.onTitleActionClick(mockButton)
            sinon.assert.calledWith(messager.onMcpServerClick as sinon.SinonStub, 'refresh-mcp-list')
        })
    })

    describe('mcpServerClick', () => {
        // This test is skipped until the implementation is fixed
        it.skip('should handle open-mcp-server action correctly', () => {
            // Create mock params
            const params: McpServerClickResult = {
                id: 'open-mcp-server',
                header: {
                    title: 'Server Details',
                },
                list: [],
            }

            // Call the method
            mcpMynahUi.mcpServerClick(params)

            // Verify toggleSplashLoader was called
            sinon.assert.calledWith(mynahUi.toggleSplashLoader as sinon.SinonStub, false)

            // Verify openDetailedList was called
            sinon.assert.calledOnce(mynahUi.openDetailedList as sinon.SinonStub)

            // Verify the second parameter (replace) is true
            assert.strictEqual((mynahUi.openDetailedList as sinon.SinonStub).firstCall.args[1], true)

            // Get the events object
            const callArgs = (mynahUi.openDetailedList as sinon.SinonStub).firstCall.args[0]
            const events = callArgs.events

            // Test onFilterValueChange event
            const filterValues = { permission: 'read' }
            events.onFilterValueChange(filterValues)
            sinon.assert.calledWith(
                messager.onMcpServerClick as sinon.SinonStub,
                'mcp-permission-change',
                'Server Details',
                filterValues
            )

            // Test onTitleActionClick event
            const mockAction = { id: 'mcp-details-menu' }
            events.onTitleActionClick(mockAction)
            sinon.assert.calledWith(messager.onMcpServerClick as sinon.SinonStub, 'mcp-details-menu', 'Server Details')

            // Test onKeyPress event with Escape key
            const mockSheet = {
                close: sinon.stub(),
            }
            ;(mynahUi.openDetailedList as sinon.SinonStub).returns(mockSheet)
            const escapeEvent = { key: 'Escape' } as KeyboardEvent
            events.onKeyPress(escapeEvent)
            sinon.assert.calledOnce(mockSheet.close)

            // Test onActionClick event
            const mockActionButton = { id: 'save-permission' }
            events.onActionClick(mockActionButton)
            sinon.assert.calledWith(messager.onMcpServerClick as sinon.SinonStub, 'save-permission')

            // Test onClose event
            events.onClose()
            sinon.assert.calledWith(messager.onMcpServerClick as sinon.SinonStub, 'save-permission-change')

            // Test onBackClick event
            events.onBackClick()
            sinon.assert.calledWith(messager.onMcpServerClick as sinon.SinonStub, 'save-permission-change')
            sinon.assert.calledOnce(messager.onListMcpServers as sinon.SinonStub)
        })

        it('should handle server management actions correctly', () => {
            // First set isMcpServersListActive to true by calling listMcpServers
            const listParams: ListMcpServersResult = {
                list: [],
            }
            mcpMynahUi.listMcpServers(listParams)

            // Reset call history after listMcpServers
            ;(messager.onListMcpServers as sinon.SinonStub).resetHistory()

            // Test mcp-disable-server
            const disableParams: McpServerClickResult = {
                id: 'mcp-disable-server',
            }
            mcpMynahUi.mcpServerClick(disableParams)
            sinon.assert.calledOnce(messager.onListMcpServers as sinon.SinonStub)

            // Reset call history
            ;(messager.onListMcpServers as sinon.SinonStub).resetHistory()

            // Test mcp-delete-server
            const deleteParams: McpServerClickResult = {
                id: 'mcp-delete-server',
            }
            mcpMynahUi.mcpServerClick(deleteParams)
            sinon.assert.calledOnce(messager.onListMcpServers as sinon.SinonStub)

            // Reset call history
            ;(messager.onListMcpServers as sinon.SinonStub).resetHistory()

            // Test mcp-enable-server (should work when isMcpServersListActive is true)
            const enableParams: McpServerClickResult = {
                id: 'mcp-enable-server',
            }
            mcpMynahUi.mcpServerClick(enableParams)
            sinon.assert.calledOnce(messager.onListMcpServers as sinon.SinonStub)
        })

        it('should handle update-mcp-list action correctly', () => {
            // First set isMcpServersListActive to true
            const listParams: ListMcpServersResult = {
                list: [],
            }
            mcpMynahUi.listMcpServers(listParams)

            // Reset call history
            ;(messager.onListMcpServers as sinon.SinonStub).resetHistory()

            // Test update-mcp-list when isMcpServersListActive is true
            const updateParams: McpServerClickResult = {
                id: 'update-mcp-list',
            }
            mcpMynahUi.mcpServerClick(updateParams)
            sinon.assert.calledOnce(messager.onListMcpServers as sinon.SinonStub)

            // Reset call history
            ;(messager.onListMcpServers as sinon.SinonStub).resetHistory()

            // Set isMcpServersListActive to false
            const mockSheet = {
                close: sinon.stub(),
            }
            ;(mynahUi.openDetailedList as sinon.SinonStub).returns(mockSheet)
            const callArgs = (mynahUi.openDetailedList as sinon.SinonStub).firstCall.args[0]
            callArgs.events.onClose()

            // Test update-mcp-list when isMcpServersListActive is false
            mcpMynahUi.mcpServerClick(updateParams)
            sinon.assert.notCalled(messager.onListMcpServers as sinon.SinonStub)
        })
    })

    describe('private helper methods', () => {
        it('should process filter options correctly', () => {
            // Create mock params with filter options
            const params: ListMcpServersResult = {
                filterOptions: [
                    {
                        id: 'filter1',
                        title: 'Filter 1',
                        type: 'textinput',
                        icon: 'search',
                    },
                ],
                list: [],
            }

            // Call the method
            mcpMynahUi.listMcpServers(params)

            // Verify toMynahIcon was called for the filter icon
            sinon.assert.calledWith(toMynahIconStub, 'search')

            // Verify the filter options in the detailed list
            const callArgs = (mynahUi.openDetailedList as sinon.SinonStub).firstCall.args[0]
            assert.strictEqual(callArgs.detailedList.filterOptions.length, 1)
            assert.strictEqual(callArgs.detailedList.filterOptions[0].id, 'filter1')
            assert.strictEqual(callArgs.detailedList.filterOptions[0].title, 'Filter 1')
            assert.strictEqual(callArgs.detailedList.filterOptions[0].type, 'textinput')
            assert.strictEqual(callArgs.detailedList.filterOptions[0].icon, 'mocked-icon')
        })

        it('should create detailed list for adding MCP server correctly', () => {
            // Create mock params for add-new-mcp
            const params: McpServerClickResult = {
                id: 'add-new-mcp',
                header: {
                    title: 'Add MCP Server',
                    description: 'Add a new MCP server',
                    status: { status: 'info' },
                    actions: [
                        {
                            id: 'action1',
                            text: 'Action 1',
                            icon: 'plus',
                        },
                    ],
                },
                filterOptions: [
                    {
                        id: 'filter1',
                        title: 'Filter 1',
                        type: 'textinput',
                    },
                ],
                filterActions: [
                    {
                        id: 'save-mcp',
                        text: 'Save',
                    },
                ],
                list: [
                    {
                        groupName: 'Group 1',
                        children: [
                            {
                                title: 'Item 1',
                                description: 'Description 1',
                            },
                        ],
                    },
                ],
            }

            // Call the method
            mcpMynahUi.mcpServerClick(params)

            // Verify the detailed list structure
            const callArgs = (mynahUi.openDetailedList as sinon.SinonStub).firstCall.args[0]
            const detailedList = callArgs.detailedList

            assert.strictEqual(detailedList.selectable, false)
            assert.strictEqual(detailedList.textDirection, 'row')
            assert.strictEqual(detailedList.header.title, 'Add MCP Server')
            assert.strictEqual(detailedList.header.description, 'Add a new MCP server')
            assert.deepStrictEqual(detailedList.header.status, { status: 'info' })
            assert.strictEqual(detailedList.header.actions.length, 1)
            assert.strictEqual(detailedList.header.actions[0].id, 'action1')
            assert.strictEqual(detailedList.filterOptions.length, 1)
            assert.strictEqual(detailedList.filterOptions[0].id, 'filter1')
            assert.strictEqual(detailedList.filterActions.length, 1)
            assert.strictEqual(detailedList.filterActions[0].id, 'save-mcp')
            assert.strictEqual(detailedList.list.length, 1)
            assert.strictEqual(detailedList.list[0].groupName, 'Group 1')
            assert.strictEqual(detailedList.list[0].children.length, 1)
            assert.strictEqual(detailedList.list[0].children[0].title, 'Item 1')
            assert.strictEqual(detailedList.list[0].children[0].description, 'Description 1')
        })

        it('should create detailed list for viewing MCP server correctly', () => {
            // Create mock params for open-mcp-server
            const params: McpServerClickResult = {
                id: 'open-mcp-server',
                header: {
                    title: 'Server Details',
                    description: 'MCP server details',
                    status: { status: 'success' },
                    actions: [
                        {
                            id: 'mcp-details-menu',
                            text: 'Menu',
                            icon: 'ellipsis',
                        },
                    ],
                },
                filterOptions: [
                    {
                        id: 'permission',
                        title: 'Permission',
                        type: 'select',
                        options: [
                            { label: 'Read', value: 'read' },
                            { label: 'Write', value: 'write' },
                        ],
                    },
                ],
                filterActions: [
                    {
                        id: 'save-permission',
                        text: 'Save',
                    },
                ],
                list: [
                    {
                        groupName: 'Tools',
                        children: [
                            {
                                title: 'Tool 1',
                                description: 'Description 1',
                            },
                        ],
                    },
                ],
            }

            // Call the method
            mcpMynahUi.mcpServerClick(params)

            // Verify the detailed list structure
            const callArgs = (mynahUi.openDetailedList as sinon.SinonStub).firstCall.args[0]
            const detailedList = callArgs.detailedList

            assert.strictEqual(detailedList.selectable, false)
            assert.strictEqual(detailedList.textDirection, 'row')
            assert.strictEqual(detailedList.header.title, 'Server Details')
            assert.strictEqual(detailedList.header.description, 'MCP server details')
            assert.deepStrictEqual(detailedList.header.status, { status: 'success' })
            assert.strictEqual(detailedList.header.actions.length, 1)
            assert.strictEqual(detailedList.header.actions[0].id, 'mcp-details-menu')

            // Verify the mcp-details-menu items
            assert.strictEqual(detailedList.header.actions[0].items.length, 2)
            assert.strictEqual(detailedList.header.actions[0].items[0].id, 'mcp-disable-server')
            assert.strictEqual(detailedList.header.actions[0].items[1].id, 'mcp-delete-server')

            assert.strictEqual(detailedList.filterOptions.length, 1)
            assert.strictEqual(detailedList.filterOptions[0].id, 'permission')
            assert.strictEqual(detailedList.filterActions.length, 1)
            assert.strictEqual(detailedList.filterActions[0].id, 'save-permission')
            assert.strictEqual(detailedList.list.length, 1)
            assert.strictEqual(detailedList.list[0].groupName, 'Tools')
            assert.strictEqual(detailedList.list[0].children.length, 1)
            assert.strictEqual(detailedList.list[0].children[0].id, 'Tool 1')
            assert.strictEqual(detailedList.list[0].children[0].title, 'Tool 1')
            assert.strictEqual(detailedList.list[0].children[0].description, 'Description 1')
            assert.strictEqual(detailedList.list[0].children[0].icon, 'mocked-icon')
        })
    })
})
