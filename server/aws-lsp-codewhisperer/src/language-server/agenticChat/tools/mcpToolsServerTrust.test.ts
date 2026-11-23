/*!
 * Copyright Amazon.com, Inc. or its affiliates.
 * All Rights Reserved. SPDX-License-Identifier: Apache-2.0
 */

import { expect } from 'chai'
import * as sinon from 'sinon'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import { McpToolsServer } from './toolServer'
import { McpManager } from './mcp/mcpManager'
import * as mcpUtils from './mcp/mcpUtils'

describe('McpToolsServer workspace trust updates', () => {
    let features: TestFeatures
    let setWorkspaceTrust: sinon.SinonStub
    let onWorkspaceFoldersChanged: sinon.SinonStub
    let managerReady: boolean

    const sendUpdate = (section: string, settings: unknown) =>
        features.doUpdateConfiguration({ section, settings } as any, {} as any)

    beforeEach(() => {
        features = new TestFeatures()
        setWorkspaceTrust = sinon.stub().resolves()
        onWorkspaceFoldersChanged = sinon.stub().resolves()
        managerReady = true
        sinon.stub(McpManager, 'isInitialized').callsFake(() => managerReady)
        sinon.stub(McpManager, 'instance').get(() => ({
            setWorkspaceTrust,
            onWorkspaceFoldersChanged,
            clearToolNameMapping: sinon.stub(),
        }))
    })

    afterEach(() => {
        sinon.restore()
        features.dispose()
    })

    it('applies a trust change sent in the workspace trust section', async () => {
        await features.start(McpToolsServer)
        await sendUpdate('aws.q.workspaceTrust', { state: 'trusted' })
        expect(setWorkspaceTrust.calledOnceWith('trusted')).to.be.true
    })

    it('ignores updates for other sections', async () => {
        await features.start(McpToolsServer)
        await sendUpdate('aws.q', { state: 'trusted' })
        expect(setWorkspaceTrust.called).to.be.false
    })

    it('ignores an unknown trust state', async () => {
        await features.start(McpToolsServer)
        await sendUpdate('aws.q.workspaceTrust', { state: 'yes' })
        expect(setWorkspaceTrust.called).to.be.false
    })

    it('keeps a trust change that arrives before initialization over the initialize value', async () => {
        managerReady = false
        features.setClientParams({
            initializationOptions: {
                aws: { awsClientCapabilities: { q: { mcp: true, workspaceTrust: 'restricted' } } },
            },
        } as any)
        const workspace = features.workspace as any
        workspace.getAllWorkspaceFolders = () => []
        workspace.fs.getUserHomeDir = () => '/home/user'
        workspace.fs.exists = async () => false
        sinon.stub(mcpUtils, 'migrateToAgentConfig').resolves()
        sinon.stub(McpManager, 'init').resolves({} as any)

        // Register the server's handlers without sending the initialized notification yet
        McpToolsServer(features as any)
        await sendUpdate('aws.q.workspaceTrust', { state: 'trusted' })
        expect(setWorkspaceTrust.called).to.be.false

        managerReady = true
        await features.lsp.onInitialized.args[0][0]({})

        expect(setWorkspaceTrust.calledWith('trusted')).to.be.true
        expect(setWorkspaceTrust.calledWith('restricted')).to.be.false
    })

    it('re-checks servers when the workspace folders change', async () => {
        await features.start(McpToolsServer)
        const handlers = features.lsp.workspace.onDidChangeWorkspaceFolders.args
        handlers.forEach(([handler]) => handler({ event: { added: [], removed: [] } }))
        expect(onWorkspaceFoldersChanged.calledOnce).to.be.true
    })

    it('ignores folder changes before the MCP manager starts', async () => {
        managerReady = false
        await features.start(McpToolsServer)
        const handlers = features.lsp.workspace.onDidChangeWorkspaceFolders.args
        handlers.forEach(([handler]) => handler({ event: { added: [], removed: [] } }))
        expect(onWorkspaceFoldersChanged.called).to.be.false
    })

    describe('folders that change while the MCP manager starts', () => {
        let folders: Array<{ uri: string; name: string }>
        let changeFoldersDuringMigration: boolean

        // Starts the server and runs its initialized handler, which starts the MCP manager
        async function startServer() {
            managerReady = false
            features.setClientParams({
                initializationOptions: { aws: { awsClientCapabilities: { q: { mcp: true } } } },
            } as any)
            const workspace = features.workspace as any
            workspace.getAllWorkspaceFolders = () => folders
            workspace.fs.getUserHomeDir = () => '/home/user'
            workspace.fs.exists = async () => false
            sinon.stub(mcpUtils, 'migrateToAgentConfig').callsFake(async () => {
                if (changeFoldersDuringMigration) {
                    // The folder arrives before the manager exists, so the folder change handler ignores it
                    folders = [...folders, { uri: 'file:///opened-later', name: 'opened-later' }]
                    features.lsp.workspace.onDidChangeWorkspaceFolders.args.forEach(([handler]) =>
                        handler({ event: { added: [], removed: [] } })
                    )
                }
            })
            sinon.stub(McpManager, 'init').callsFake(async () => {
                managerReady = true
                return {} as any
            })

            McpToolsServer(features as any)
            await features.lsp.onInitialized.args[0][0]({})
        }

        beforeEach(() => {
            folders = [{ uri: 'file:///open-at-start', name: 'open-at-start' }]
            changeFoldersDuringMigration = false
        })

        it('applies a folder change that arrived before the manager started', async () => {
            changeFoldersDuringMigration = true
            await startServer()
            expect(onWorkspaceFoldersChanged.calledOnce).to.be.true
        })

        it('does not re-check folders when they did not change during startup', async () => {
            await startServer()
            expect(onWorkspaceFoldersChanged.called).to.be.false
        })
    })
})
