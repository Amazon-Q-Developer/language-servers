import { standalone } from '@aws/language-server-runtimes/runtimes'
import {
    AmazonQServiceServerIAM,
    AmazonQServiceServerToken,
    CodeWhispererSecurityScanServerTokenProxy,
    CodeWhispererServer,
    QAgenticChatServerProxy,
    QConfigurationServerTokenProxy,
    TransformConfigurationServerTokenProxy,
    AtxNetTransformServerTokenProxy,
    QLocalProjectContextServerProxy,
    QNetTransformServerTokenProxy,
    WorkspaceContextServerTokenProxy,
} from '@aws/lsp-codewhisperer'
import { IdentityServer } from '@aws/lsp-identity'
import {
    BashToolsServer,
    FsToolsServer,
    QCodeAnalysisServer,
    McpToolsServer,
    WebToolsServer,
} from '@aws/lsp-codewhisperer/out/language-server/agenticChat/tools/toolServer'
import { RuntimeProps } from '@aws/language-server-runtimes/runtimes/runtime'

const versionJson = require('./version.json')
const version = versionJson.agenticChat

const props = {
    version: version,
    servers: [
        CodeWhispererServer,
        CodeWhispererSecurityScanServerTokenProxy,
        QConfigurationServerTokenProxy,
        QNetTransformServerTokenProxy,
        QAgenticChatServerProxy,
        IdentityServer.create,
        FsToolsServer,
        QCodeAnalysisServer,
        BashToolsServer,
        QLocalProjectContextServerProxy,
        WorkspaceContextServerTokenProxy,
        McpToolsServer,
        WebToolsServer,
        // LspToolsServer,
        AmazonQServiceServerIAM,
        AmazonQServiceServerToken,
        // ATX Servers
        TransformConfigurationServerTokenProxy,
        AtxNetTransformServerTokenProxy,
    ],
    name: 'AWS CodeWhisperer',
} as RuntimeProps

;(async () => {
    await standalone(props)
})()
