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
    let managerReady: boolean

    const sendUpdate = (section: string, settings: unknown) =>
        features.doUpdateConfiguration({ section, settings } as any, {} as any)

    beforeEach(() => {
        features = new TestFeatures()
        setWorkspaceTrust = sinon.stub().resolves()
        managerReady = true
        sinon.stub(McpManager, 'isInitialized').callsFake(() => managerReady)
        sinon.stub(McpManager, 'instance').get(() => ({
            setWorkspaceTrust,
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
})
