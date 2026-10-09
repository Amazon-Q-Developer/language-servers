import { ChildProcess, spawn } from 'child_process'
import * as net from 'net'

export interface JsonRpcMessage {
    jsonrpc: string
    id?: number
    method?: string
    params?: any
    result?: any
    error?: any
}

export class LspClient {
    private process: ChildProcess | null = null
    private socket: net.Socket | null = null
    private server: net.Server | null = null
    private requestId = 100
    private pendingRequests: Map<number, { resolve: (value: any) => void; reject: (reason: any) => void }> = new Map()
    private rawBuffer: Buffer = Buffer.alloc(0)
    private port: number
    private runtimeFile: string

    constructor(runtimeFile: string) {
        this.port = 30000 + Math.floor(Math.random() * 10000)
        this.runtimeFile = runtimeFile
    }

    async initialize(): Promise<any> {
        await this.startServerAndConnect()
        return this.sendRequest('initialize', {
            processId: process.pid,
            capabilities: {},
            rootUri: null,
            initializationOptions: { aws: { awsConfigSectionName: 'aws' } },
        })
    }

    private startServerAndConnect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = net.createServer(socket => {
                this.socket = socket
                this.socket.on('data', (data: Buffer) => {
                    this.rawBuffer = Buffer.concat([this.rawBuffer, data])
                    this.processBuffer()
                })
                this.socket.on('error', err => {
                    console.error('Socket error:', err.message)
                })
                resolve()
            })

            this.server.listen(this.port, '127.0.0.1', () => {
                const lspLogFile = process.env.LSP_LOG_FILE
                this.process = spawn('node', [this.runtimeFile, `--socket=${this.port}`], {
                    stdio: lspLogFile ? ['ignore', 'pipe', 'pipe'] : 'ignore',
                })
                if (lspLogFile) {
                    const out = require('fs').createWriteStream(lspLogFile, { flags: 'a' })
                    this.process.stdout?.pipe(out)
                    this.process.stderr?.pipe(out)
                }
                this.process.on('error', err => {
                    reject(new Error(`Failed to spawn LSP: ${err.message}`))
                })
            })

            this.server.on('error', err => {
                reject(new Error(`Failed to start TCP server: ${err.message}`))
            })

            setTimeout(() => {
                if (!this.socket) {
                    if (this.process) this.process.kill()
                    if (this.server) this.server.close()
                    reject(new Error('LSP did not connect within 10 seconds'))
                }
            }, 10000)
        })
    }

    private processBuffer(): void {
        while (true) {
            const headerEnd = this.rawBuffer.indexOf('\r\n\r\n')
            if (headerEnd === -1) break

            const header = this.rawBuffer.slice(0, headerEnd).toString('utf8')
            const match = header.match(/Content-Length: (\d+)/)
            if (!match) {
                this.rawBuffer = this.rawBuffer.slice(headerEnd + 4)
                continue
            }

            const contentLength = parseInt(match[1], 10)
            const messageStart = headerEnd + 4
            const messageEnd = messageStart + contentLength

            if (this.rawBuffer.length < messageEnd) break

            const content = this.rawBuffer.slice(messageStart, messageEnd).toString('utf8')
            this.rawBuffer = this.rawBuffer.slice(messageEnd)

            try {
                const message: JsonRpcMessage = JSON.parse(content)

                if (message.method === 'workspace/configuration' && message.id !== undefined) {
                    this.sendResponse(message.id, [{}])
                    continue
                }

                if (message.method === 'window/logMessage') {
                    if (process.env.LSP_LOG_FILE) {
                        require('fs').appendFileSync(
                            process.env.LSP_LOG_FILE,
                            `[${new Date().toISOString()}] [logMessage t=${message.params?.type}] ${message.params?.message}\n`
                        )
                    }
                    continue
                }

                if (message.id !== undefined && this.pendingRequests.has(message.id)) {
                    const { resolve, reject } = this.pendingRequests.get(message.id)!
                    this.pendingRequests.delete(message.id)
                    if (message.error) {
                        reject(new Error(message.error.message))
                    } else {
                        resolve(message.result)
                    }
                }
            } catch (e) {
                // Ignore parse errors
            }
        }
    }

    private send(obj: JsonRpcMessage): void {
        if (!this.socket) throw new Error('Socket not connected')
        const content = JSON.stringify(obj)
        const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`
        this.socket.write(header + content)
    }

    private sendResponse(id: number, result: any): void {
        this.send({ jsonrpc: '2.0', id, result })
    }

    async sendRequest(method: string, params: any): Promise<any> {
        const id = ++this.requestId
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject })
            this.send({ jsonrpc: '2.0', id, method, params })
        })
    }

    sendNotification(method: string, params: any): void {
        this.send({ jsonrpc: '2.0', method, params })
    }

    close(): void {
        if (this.socket) {
            this.socket.destroy()
        }
        if (this.server) {
            this.server.close()
        }
        if (this.process) {
            this.process.kill()
        }
    }
}
