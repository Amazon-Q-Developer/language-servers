import { CodeWhispererStreamingClientConfig, Origin, ToolUse } from '@amzn/codewhisperer-streaming'
import {
    StreamingClientServiceToken,
    SendMessageCommandInput,
    SendMessageCommandOutput,
    StreamingClientServiceIAM,
    ChatCommandInput,
    ChatCommandOutput,
} from '../../shared/streamingClientService'
import { ChatResult } from '@aws/language-server-runtimes/server-interface'
import { AgenticChatError } from '../agenticChat/errors'
import { AmazonQBaseServiceManager } from '../../shared/amazonQServiceManager/BaseAmazonQServiceManager'
import { Logging } from '@aws/language-server-runtimes/server-interface'
import { Features } from '../types'
import { getOriginFromClientInfo, getClientName } from '../../shared/utils'
import { enabledModelSelection } from '../../shared/utils'
import { QErrorTransformer } from '../agenticChat/retry/errorTransformer'
import { DelayNotification } from '../agenticChat/retry/delayInterceptor'
import { MAX_REQUEST_ATTEMPTS } from '../agenticChat/constants/constants'
import { TokenLimits, TokenLimitsCalculator } from '../agenticChat/utils/tokenLimitsCalculator'
import { Model } from '@aws/language-server-runtimes/protocol'

export type ChatSessionServiceConfig = CodeWhispererStreamingClientConfig
type FileChange = { before?: string; after?: string }

type DeferredHandler = {
    resolve: () => void
    reject: (err: Error) => void
}
export class ChatSessionService {
    public pairProgrammingMode: boolean = true
    public contextListSent: boolean = false
    public isMemoryBankGeneration: boolean = false
    public didAutoCompactOnOverflow: boolean = false
    #modelId: string | undefined
    #lsp?: Features['lsp']
    #abortController?: AbortController
    #currentPromptId?: string
    #conversationId?: string
    #conversationType: string = 'AgenticChat'
    #deferredToolExecution: Record<string, DeferredHandler> = {}
    #toolUseLookup: Map<
        string,
        ToolUse & { fileChange?: FileChange; relatedToolUses?: Set<string>; chatResult?: ChatResult }
    > = new Map()
    #currentUndoAllId?: string
    // Map to store approved paths to avoid repeated validation
    #approvedPaths: Map<string, Set<string>> = new Map<string, Set<string>>()
    #serviceManager?: AmazonQBaseServiceManager
    #logging?: Logging
    #origin?: Origin
    #errorTransformer: QErrorTransformer
    #tokenLimits: TokenLimits

    public getConversationType(): string {
        return this.#conversationType
    }

    public setConversationType(value: string) {
        this.#conversationType = value
    }

    public get conversationId(): string | undefined {
        return this.#conversationId
    }

    public set conversationId(value: string | undefined) {
        this.#conversationId = value
    }

    public getDeferredToolExecution(messageId: string): DeferredHandler | undefined {
        return this.#deferredToolExecution[messageId]
    }

    public setDeferredToolExecution(messageId: string, resolve: any, reject: any) {
        this.#deferredToolExecution[messageId] = { resolve, reject }
    }

    public removeDeferredToolExecution(messageId: string) {
        if (messageId in this.#deferredToolExecution) {
            delete this.#deferredToolExecution[messageId]
        }
    }

    public getAllDeferredCompactMessageIds(): string[] {
        return Object.keys(this.#deferredToolExecution).filter(messageId => messageId.endsWith('_compact'))
    }

    public rejectAllDeferredToolExecutions(error: Error): void {
        Object.keys(this.#deferredToolExecution).forEach(messageId => {
            const handler = this.#deferredToolExecution[messageId]
            if (handler && handler.reject) {
                handler.reject(error)
            }
        })
        // Clear all handlers after rejecting them
        this.#deferredToolExecution = {}
    }

    public get toolUseLookup() {
        return this.#toolUseLookup
    }

    public set toolUseLookup(toolUseLookup) {
        this.#toolUseLookup = toolUseLookup
    }

    public get currentUndoAllId(): string | undefined {
        return this.#currentUndoAllId
    }

    public set currentUndoAllId(toolUseId: string | undefined) {
        this.#currentUndoAllId = toolUseId
    }

    /**
     * Gets the map of approved paths for this session
     */
    public get approvedPaths(): Map<string, Set<string>> {
        return this.#approvedPaths
    }

    /**
     * Adds a path to the approved paths list for this session
     * @param filePath The absolute path to add
     * @param toolName The name of the tool that should have access to this path
     */
    public addApprovedPath(filePath: string, toolName: string): void {
        if (!filePath || !toolName) {
            return
        }

        // Normalize path separators for consistent comparison
        const normalizedPath = filePath.replace(/\\/g, '/')

        if (!this.#approvedPaths.has(toolName)) {
            this.#approvedPaths.set(toolName, new Set<string>())
        }

        this.#approvedPaths.get(toolName)!.add(normalizedPath)
    }

    constructor(serviceManager?: AmazonQBaseServiceManager, lsp?: Features['lsp'], logging?: Logging) {
        this.#serviceManager = serviceManager
        this.#lsp = lsp
        this.#logging = logging
        this.#origin = getOriginFromClientInfo(getClientName(this.#lsp?.getClientInitializeParams()))

        // Initialize Q-specific error transformation
        this.#errorTransformer = new QErrorTransformer(logging, () => this.isModelSelectionEnabled())

        // Initialize token limits with default values
        this.#tokenLimits = TokenLimitsCalculator.calculate()
    }

    /**
     * Gets the model ID for this session
     */
    public get modelId(): string | undefined {
        return this.#modelId
    }

    /**
     * Gets the token limits for this session
     */
    public get tokenLimits(): TokenLimits {
        return this.#tokenLimits
    }

    /**
     * Sets the model for this session, automatically calculating token limits.
     * This encapsulates model ID and token limits as a single entity.
     * @param modelId The model ID to set
     * @param models Optional list of available models to look up token limits from
     */
    public setModel(modelId: string | undefined, models?: Model[]): void {
        this.#modelId = modelId
        const maxInputTokens = TokenLimitsCalculator.extractMaxInputTokens(models?.find(m => m.id === modelId))
        this.#tokenLimits = TokenLimitsCalculator.calculate(maxInputTokens)
    }

    public async sendMessage(request: SendMessageCommandInput): Promise<SendMessageCommandOutput> {
        this.#abortController = new AbortController()

        if (this.#conversationId && request.conversationState) {
            request.conversationState.conversationId = this.#conversationId
        }

        if (!this.#serviceManager) {
            throw new Error('amazonQServiceManager is not initialized')
        }

        const client = this.#serviceManager.getStreamingClient()

        // AWS SDK handles retries natively, we just transform final errors
        try {
            return await client.sendMessage(request, this.#abortController)
        } catch (error) {
            throw this.#errorTransformer.transformFinalError(error)
        }
    }

    private isModelSelectionEnabled(): boolean {
        return enabledModelSelection(this.#lsp?.getClientInitializeParams())
    }

    public async getChatResponse(request: ChatCommandInput): Promise<ChatCommandOutput> {
        this.#abortController = new AbortController()

        if (this.#conversationId && request.conversationState) {
            request.conversationState.conversationId = this.#conversationId
        }

        if (!this.#serviceManager) {
            throw new AgenticChatError('amazonQServiceManager is not initialized', 'AmazonQServiceManager')
        }

        const client = this.#serviceManager.getStreamingClient()

        // AWS SDK handles retries natively, we just transform final errors
        try {
            return await this.#performChatRequest(client, request)
        } catch (error) {
            throw this.#errorTransformer.transformFinalError(error)
        }
    }

    async #performChatRequest(client: any, request: ChatCommandInput): Promise<ChatCommandOutput> {
        if (client instanceof StreamingClientServiceToken) {
            return await client.generateAssistantResponse(request, this.#abortController)
        } else if (client instanceof StreamingClientServiceIAM) {
            // @ts-ignore
            // SendMessageStreaming checks for origin from request source
            // https://code.amazon.com/packages/AWSVectorConsolasRuntimeService/blobs/ac917609a28dbcb6757a8427bcc585a42fd15bf2/--/src/com/amazon/aws/vector/consolas/runtimeservice/activity/SendMessageStreamingActivity.java#L246
            request.source = this.#origin ? this.#origin : 'IDE'
            return await client.sendMessage(request, this.#abortController)
        } else {
            // error
            return Promise.reject(
                'Client is not instance of StreamingClientServiceToken, generateAssistantResponse not available for IAM client.'
            )
        }
    }

    public clear(): void {
        this.#abortController?.abort()
        this.#conversationId = undefined
        this.contextListSent = false
    }

    public dispose(): void {
        this.#abortController?.abort()
    }

    /**
     * Sets the current prompt ID
     * @param promptId The unique ID of the current prompt
     */
    public setCurrentPromptId(promptId: string): void {
        this.#currentPromptId = promptId
    }

    /**
     * Checks if the given prompt ID matches the current one
     * @param promptId The prompt ID to check
     * @returns True if the given prompt ID matches the current one
     */
    public isCurrentPrompt(promptId: string): boolean {
        return this.#currentPromptId === promptId
    }

    public abortRequest(): void {
        this.#abortController?.abort()
    }

    /**
     * Sets the logging object for this session
     * @param logging The logging object to use
     */
    public setLogging(logging: Logging): void {
        this.#logging = logging
    }

    /**
     * Sets the delay notification callback for UI integration
     * @param callback Function to call when delay notifications occur
     */
    public setDelayNotificationCallback(callback: (notification: DelayNotification) => void): void {
        if (this.#serviceManager) {
            const client = this.#serviceManager.getStreamingClient()
            client.setDelayNotificationCallback(callback)
        }
    }
}
