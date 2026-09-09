// Ported from VSC: https://github.com/aws/aws-toolkit-vscode/blob/91859e29b26ef1c58cbd957d81e1a0deb01a7880/packages/core/src/shared/utilities/processUtils.ts#L1
// Does not support Timeout Object since that is VSC specific.

import * as proc from 'child_process'
import * as crossSpawn from 'cross-spawn'
import { Logging } from '@aws/language-server-runtimes/server-interface'
import { PollingSet } from './pollingSet'
import { waitUntil } from './timeoutUtils'
import * as Encoding from 'encoding-japanese'

export interface RunParameterContext {
    /** Reports an error parsed from the stdin/stdout streams. */
    reportError(err: string | Error): void
    /** Attempts to stop the running process. See {@link ChildProcess.stop}. */
    stop(force?: boolean, signal?: string): void
    /** Send string to stdin */
    send(text: string): Promise<void>
    /** The logger being used by the process. */
    readonly logger: Logging
}

export interface ChildProcessOptions {
    /** Sets the logging behavior. (default: 'yes') */
    logging?: 'yes' | 'no' | 'noparams'
    /** Controls whether stdout/stderr is collected and returned in the `ChildProcessResult`. (default: true) */
    collect?: boolean
    /** Wait until streams close to resolve the process result. (default: true) */
    waitForStreams?: boolean
    /** Forcefully kill the process on an error. (default: false) */
    useForceStop?: boolean
    /** Rejects the Promise on any error. Can also use a callback for custom errors. (default: false) */
    rejectOnError?: boolean | ((error: Error) => Error)
    /** Rejects the Promise on non-zero exit codes. Can also use a callback for custom errors. (default: false) */
    rejectOnErrorCode?: boolean | ((code: number) => Error)
    /** Options sent to the `spawn` command. This is merged in with the base options if they exist. */
    spawnOptions?: proc.SpawnOptions
    /** Callback for intercepting text from the stdout stream. */
    onStdout?: (text: string, context: RunParameterContext) => void
    /** Callback for intercepting text from the stderr stream. */
    onStderr?: (text: string, context: RunParameterContext) => void
}

export interface ChildProcessRunOptions extends Omit<ChildProcessOptions, 'logging'> {
    /** Arguments applied in addition to the ones used in construction. */
    extraArgs?: string[]
}

export interface ChildProcessResult {
    exitCode: number
    error: Error | undefined
    /** All output emitted by the process, if it was started with `collect=true`, else empty. */
    stdout: string
    /** All stderr data emitted by the process, if it was started with `collect=true`, else empty. */
    stderr: string
    signal?: string
}

export const eof = Symbol('EOF')

/**
 * Decodes a Buffer chunk from a shell process using encoding-japanese
 * to handle various encodings including UTF-16LE (Windows cmd.exe /u)
 */
function decodeShellChunk(buf: Buffer): string {
    const byteArray = new Uint8Array(buf)
    const detectedEncoding = Encoding.detect(byteArray) || 'UTF8'

    return Encoding.convert(byteArray, {
        from: detectedEncoding,
        to: 'UNICODE',
        type: 'string',
    }) as string
}

export interface ProcessStats {
    memory: number
    cpu: number
}

/**
 * Parses the JSON emitted by the `Get-CimInstance ... | ConvertTo-Json` process-stats query.
 * Empty output (process already exited) yields zero usage. Exported for testing.
 */
export function parseCimProcessStats(output: string): ProcessStats {
    const trimmed = output.trim()
    if (!trimmed) {
        return { cpu: 0, memory: 0 }
    }
    const parsed = JSON.parse(trimmed)
    // ConvertTo-Json emits a bare object for a single match and an array for multiple.
    const stats = Array.isArray(parsed) ? parsed[0] : parsed
    const cpu = Number(stats?.PercentProcessorTime)
    const memory = Number(stats?.WorkingSet)
    return {
        cpu: isNaN(cpu) ? 0 : cpu,
        memory: isNaN(memory) ? 0 : memory,
    }
}
export class ChildProcessTracker {
    static #instance: ChildProcessTracker
    static readonly pollingInterval: number = 10000 // Check usage every 10 seconds
    static readonly thresholds: ProcessStats = {
        memory: 100 * 1024 * 1024, // 100 MB
        cpu: 50,
    }
    #processByPid: Map<number, ChildProcess> = new Map<number, ChildProcess>()
    #pids: PollingSet<number>

    private constructor(private logging: Logging) {
        this.#pids = new PollingSet(ChildProcessTracker.pollingInterval, () => this.monitor())
    }

    public static getInstance(logging: Logging) {
        // Overwrite logging if it exists
        if (this.#instance) {
            this.#instance.logging = logging
            return this.#instance
        }
        return (this.#instance ??= new this(logging))
    }

    private cleanUp() {
        const terminatedProcesses = Array.from(this.#pids.values()).filter(
            (pid: number) => this.#processByPid.get(pid)?.stopped
        )
        for (const pid of terminatedProcesses) {
            this.delete(pid)
        }
    }

    private async monitor() {
        this.cleanUp()
        for (const pid of this.#pids.values()) {
            await this.checkProcessUsage(pid)
        }
    }

    private async checkProcessUsage(pid: number): Promise<void> {
        if (!this.#pids.has(pid)) {
            this.logging.warn(`Missing process with id ${pid}`)
            return
        }
        const stats = await this.getUsage(pid)
        if (stats) {
            this.logIfExceeds(pid, stats)
        }
    }

    public logIfExceeds(pid: number, stats: ProcessStats) {
        if (stats.memory > ChildProcessTracker.thresholds.memory) {
            this.logging.warn(`Process ${pid} exceeded memory threshold: ${stats.memory}`)
        }
        if (stats.cpu > ChildProcessTracker.thresholds.cpu) {
            this.logging.warn(`Process ${pid} exceeded cpu threshold: ${stats.cpu}`)
        }
    }

    public add(childProcess: ChildProcess) {
        const pid = childProcess.pid()
        this.#processByPid.set(pid, childProcess)
        this.#pids.add(pid)
    }

    public delete(childProcessId: number) {
        this.#processByPid.delete(childProcessId)
        this.#pids.delete(childProcessId)
    }

    public get size() {
        return this.#pids.size
    }

    public has(childProcess: ChildProcess) {
        return this.#pids.has(childProcess.pid())
    }

    public clear() {
        for (const childProcess of this.#processByPid.values()) {
            childProcess.stop(true)
        }
        this.#pids.clear()
        this.#processByPid.clear()
    }

    private async getUsage(pid: number): Promise<ProcessStats> {
        try {
            return process.platform === 'win32' ? await getWindowsUsage() : getUnixUsage()
        } catch (e) {
            this.logging.warn(`Failed to get process stats for ${pid}: ${e}`)
            return { cpu: 0, memory: 0 }
        }

        // wmic was removed from current Windows 11 builds; query CIM through PowerShell instead.
        // A single Win32_PerfFormattedData query provides both cpu percentage and working set,
        // and ConvertTo-Json keeps the output locale-independent.
        async function getWindowsUsage(): Promise<ProcessStats> {
            const output = await new Promise<string>((resolve, reject) => {
                proc.execFile(
                    'powershell.exe',
                    [
                        '-NoProfile',
                        '-NonInteractive',
                        '-Command',
                        `Get-CimInstance -ClassName Win32_PerfFormattedData_PerfProc_Process -Filter 'IDProcess=${pid}' | Select-Object PercentProcessorTime,WorkingSet | ConvertTo-Json`,
                    ],
                    { windowsHide: true },
                    (error, stdout) => (error ? reject(error) : resolve(stdout))
                )
            })
            return parseCimProcessStats(output)
        }

        function getUnixUsage() {
            const cpuMemOutput = proc.execFileSync('ps', ['-p', pid.toString(), '-o', '%cpu,%mem']).toString()
            const rssOutput = proc.execFileSync('ps', ['-p', pid.toString(), '-o', 'rss']).toString()

            const cpuMemLines = cpuMemOutput.split('\n')[1].trim().split(/\s+/)
            const cpuPercentage = parseFloat(cpuMemLines[0])
            const memoryBytes = parseInt(rssOutput.split('\n')[1]) * 1024

            return {
                cpu: isNaN(cpuPercentage) ? 0 : cpuPercentage,
                memory: memoryBytes,
            }
        }
    }
}

/**
 * Convenience class to manage a child process
 * To use:
 * - instantiate
 * - call and await run to get the results (pass or fail)
 */
export class ChildProcess {
    #runningProcesses: ChildProcessTracker
    static stopTimeout = 3000
    #childProcess: proc.ChildProcess | undefined
    #processErrors: Error[] = []
    #processResult: ChildProcessResult | undefined
    #log: Logging

    /** Collects stdout data if the process was started with `collect=true`. */
    #stdoutChunks: string[] = []
    /** Collects stderr data if the process was started with `collect=true`. */
    #stderrChunks: string[] = []

    #command: string
    #args: string[]
    #baseOptions: ChildProcessOptions

    #makeResult(code: number, signal?: NodeJS.Signals): ChildProcessResult {
        return {
            exitCode: code,
            stdout: this.#stdoutChunks.join('').trim(),
            stderr: this.#stderrChunks.join('').trim(),
            error: this.#processErrors[0], // Only use the first since that one usually cascades.
            signal,
        }
    }

    public constructor(logging: Logging, command: string, args: string[] = [], baseOptions: ChildProcessOptions = {}) {
        this.#command = command
        this.#args = args
        this.#baseOptions = baseOptions
        this.#runningProcesses = ChildProcessTracker.getInstance(logging)
        // TODO: allow caller to use the various loggers instead of just the single one
        this.#log = logging
    }
    public static async run(
        logging: Logging,
        command: string,
        args: string[] = [],
        options?: ChildProcessOptions
    ): Promise<ChildProcessResult> {
        return await new ChildProcess(logging, command, args, options).run()
    }

    // Inspired by 'got'
    /**
     * Creates a one-off {@link ChildProcess} class that always uses the specified options.
     */
    public static extend(logging: Logging, options: ChildProcessOptions) {
        return class extends this {
            public constructor(command: string, args: string[] = []) {
                super(logging, command, args, options)
            }
        }
    }

    /**
     * Runs the child process. Options passed here are merged with the options passed in during construction.
     * Priority is given to `run` options, overriding the previous value.
     */
    public async run(params: ChildProcessRunOptions = {}): Promise<ChildProcessResult> {
        if (this.#childProcess) {
            throw new Error('process already started')
        }

        const options = {
            collect: true,
            waitForStreams: true,
            ...this.#baseOptions,
            ...params,
            spawnOptions: { ...this.#baseOptions.spawnOptions, ...params.spawnOptions },
        }

        const { rejectOnError, rejectOnErrorCode } = options
        const args = this.#args.concat(options.extraArgs ?? [])

        this.#log.info(`Command: ${this.toString(options.logging === 'noparams')}`)
        this.#log.debug(`running processes: ${this.#runningProcesses.size}`)

        const cleanup = () => {
            this.#childProcess?.stdout?.removeAllListeners()
            this.#childProcess?.stderr?.removeAllListeners()
        }

        return new Promise<ChildProcessResult>((resolve, reject) => {
            const errorHandler = (error: Error, force = options.useForceStop) => {
                this.#processErrors.push(error)
                if (!this.stopped) {
                    this.stop(force)
                }
                if (rejectOnError) {
                    if (typeof rejectOnError === 'function') {
                        reject(rejectOnError(error))
                    } else {
                        reject(error)
                    }
                }
            }

            const paramsContext: RunParameterContext = {
                logger: this.#log,
                stop: this.stop.bind(this),
                send: this.send.bind(this),
                reportError: err => errorHandler(err instanceof Error ? err : new Error(err)),
            }

            // Async.
            // See also crossSpawn.spawnSync().
            // Arguments are forwarded[1] to node `child_process` module, see its documentation[2].
            // [1] https://github.com/moxystudio/node-cross-spawn/blob/master/index.js
            // [2] https://nodejs.org/api/child_process.html
            try {
                this.#childProcess = crossSpawn.spawn(this.#command, args, options.spawnOptions)
                this.#registerLifecycleListeners(this.#childProcess)
            } catch (err) {
                return reject(err)
            }

            // Emitted whenever:
            //  1. Process could not be spawned, or
            //  2. Process could not be killed, or
            //  3. Sending a message to the child process failed.
            // https://nodejs.org/api/child_process.html#child_process_class_childprocess
            // We also register error event handlers on the output/error streams in case a lower level library fails
            this.#childProcess.on('error', errorHandler)
            this.#childProcess.stdout?.on('error', errorHandler)
            this.#childProcess.stderr?.on('error', errorHandler)

            this.#childProcess.stdout?.on('data', (chunk: Buffer) => {
                const decoded = decodeShellChunk(chunk)

                if (options.collect) {
                    this.#stdoutChunks.push(decoded)
                }

                options.onStdout?.(decoded, paramsContext)
            })

            this.#childProcess.stderr?.on('data', (chunk: Buffer) => {
                const decoded = decodeShellChunk(chunk)

                if (options.collect) {
                    this.#stderrChunks.push(decoded)
                }

                options.onStderr?.(decoded, paramsContext)
            })

            // Emitted when streams are closed.
            // This will not be fired if `waitForStreams` is false
            this.#childProcess.once('close', (code, signal) => {
                this.#processResult = this.#makeResult(code ?? -1, signal ?? undefined)
                resolve(this.#processResult)
            })

            // Emitted when process exits or terminates.
            // https://nodejs.org/api/child_process.html#child_process_class_childprocess
            // - If the process exited, `code` is the final exit code of the process, else null.
            // - If the process terminated because of a signal, `signal` is the name of the signal, else null.
            // - One of `code` or `signal` will always be non-null.
            this.#childProcess.once('exit', (code, signal) => {
                this.#processResult = this.#makeResult(
                    typeof code === 'number' ? code : -1,
                    typeof signal === 'string' ? signal : undefined
                )
                if (code && rejectOnErrorCode) {
                    if (typeof rejectOnErrorCode === 'function') {
                        reject(rejectOnErrorCode(code))
                    } else {
                        reject(new Error(`Command exited with non-zero code: ${code}`))
                    }
                }
                if (options.waitForStreams === false) {
                    resolve(this.#processResult)
                }
            })
        }).finally(() => cleanup())
    }

    /**
     * Gets the `run()` result after the child process has finished.
     *
     * stdout/stderr will be empty unless the process was started with `collect=true`.
     *
     * @returns `run()` result, or undefined if the process has not yet started or is still running.
     */
    public result(): ChildProcessResult | undefined {
        return this.#processResult
    }

    public proc(): proc.ChildProcess | undefined {
        return this.#childProcess
    }

    public pid(): number {
        return this.#childProcess?.pid ?? -1
    }

    public exitCode(): number {
        return this.#childProcess?.exitCode ?? -1
    }

    /**
     * Stops the process.
     *
     * SIGTERM won't kill a terminal process, use SIGHUP instead.
     *
     * @param force  Tries SIGKILL if the process is not stopped after a few seconds.
     * @param signal  Signal to send, defaults to SIGTERM (node default).
     *
     */
    public stop(force: boolean = false, signal?: NodeJS.Signals): void {
        const child = this.#childProcess
        if (!child || child.stdin?.destroyed) {
            return
        }
        const command = this.#command
        const pid = this.pid()
        if (!this.stopped) {
            child.kill(signal)

            if (force === true) {
                waitUntil(async () => this.stopped, { timeout: ChildProcess.stopTimeout, interval: 200, truthy: true })
                    .then(stopped => {
                        if (!stopped) {
                            child.kill('SIGKILL')
                        }
                    })
                    .catch(e => {
                        this.#log.warn(`stop(): SIGKILL failed: pid=${pid} command=${command}`)
                    })
            }
        } else {
            throw new Error('Attempting to kill a process that has already been killed')
        }
    }

    #registerLifecycleListeners(process: proc.ChildProcess): void {
        const pid = process.pid
        if (pid === undefined) {
            return
        }
        this.#runningProcesses.add(this)

        const dispose = () => {
            this.#runningProcesses.delete(this.pid())
        }

        process.on('exit', dispose)
        process.on('error', dispose)
    }

    /**
     * Sends data to the process
     *
     * This throws if the process hasn't started or if the write fails.
     */
    public async send(input: string | Buffer | typeof eof) {
        if (this.#childProcess === undefined) {
            throw new Error('Cannot write to non-existent process')
        }

        const stdin = this.#childProcess.stdin
        if (!stdin) {
            throw new Error('Cannot write to non-existent stdin')
        }

        if (input === eof) {
            return new Promise<void>(resolve => stdin.end('', resolve))
        }

        return new Promise<void>((resolve, reject) => stdin.write(input, e => (e ? reject(e) : resolve())))
    }

    /**
     * Returns true if the process has ended, or false if the process was not
     * started or is still running.
     *
     * "Ended" means any of:
     * - error prevented start, or
     * - streams closed, or
     * - process exited, or
     * - exit-code was set.
     */
    public get stopped(): boolean {
        if (!this.#childProcess) {
            return false // Not started yet.
        }
        return !!this.#processResult
    }

    /**
     * Gets a string representation of the process invocation.
     *
     * @param noparams Omit parameters in the result (to protect sensitive info).
     */
    public toString(noparams = false): string {
        const pid = this.pid() > 0 ? `PID ${this.pid()}:` : '(not started)'
        return `${pid} [${this.#command} ${noparams ? '...' : this.#args.join(' ')}]`
    }
}
