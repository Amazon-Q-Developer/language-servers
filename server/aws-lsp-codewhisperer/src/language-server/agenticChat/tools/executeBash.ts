// Port from VSC https://github.com/aws/aws-toolkit-vscode/blob/741c2c481bcf0dca2d9554e32dc91d8514b1b1d1/packages/core/src/codewhispererChat/tools/executeBash.ts#L134

import { CommandValidation, ExplanatoryParams, InvokeOutput, isPathApproved } from './toolShared'
import { split } from 'shlex'
import { Logging } from '@aws/language-server-runtimes/server-interface'
import { CancellationError, processUtils, workspaceUtils } from '@aws/lsp-core'
import { CancellationToken } from 'vscode-languageserver'
import { ChildProcess, ChildProcessOptions } from '@aws/lsp-core/out/util/processUtils'
// eslint-disable-next-line import/no-nodejs-modules
import { isAbsolute, resolve, extname } from 'path' // Safe to import on web since this is part of path-browserify
import { Features } from '../../types'
import { getWorkspaceFolderPaths } from '@aws/lsp-core/out/util/workspaceUtils'
// eslint-disable-next-line import/no-nodejs-modules
import { existsSync, statSync } from 'fs'
import { parseBaseCommands } from '../utils/commandParser'
import { BashCommandEvent, ChatTelemetryEventName } from '../../../shared/telemetry/types'

export enum CommandCategory {
    ReadOnly,
    Mutate,
    Destructive,
}

export const splitOperators = new Set(['|', '&&', '||', '>'])
export const splitOperatorsArray = Array.from(splitOperators)
export const commandCategories = new Map<string, CommandCategory>([
    // ReadOnly commands
    ['ls', CommandCategory.ReadOnly],
    ['cat', CommandCategory.ReadOnly],
    ['pwd', CommandCategory.ReadOnly],
    ['which', CommandCategory.ReadOnly],
    ['head', CommandCategory.ReadOnly],
    ['tail', CommandCategory.ReadOnly],
    ['dir', CommandCategory.ReadOnly],
    ['type', CommandCategory.ReadOnly],

    // Mutable commands
    ['chmod', CommandCategory.Mutate],
    ['curl', CommandCategory.Mutate],
    ['wget', CommandCategory.Mutate],
    ['mount', CommandCategory.Mutate],
    ['umount', CommandCategory.Mutate],
    ['systemctl', CommandCategory.Mutate],
    ['service', CommandCategory.Mutate],
    ['crontab', CommandCategory.Mutate],
    ['at', CommandCategory.Mutate],
    ['nc', CommandCategory.Mutate],
    ['ssh', CommandCategory.Mutate],
    ['scp', CommandCategory.Mutate],
    ['ftp', CommandCategory.Mutate],
    ['sftp', CommandCategory.Mutate],
    ['rsync', CommandCategory.Mutate],
    ['chroot', CommandCategory.Mutate],
    ['strace', CommandCategory.Mutate],
    ['gdb', CommandCategory.Mutate],
    ['apt', CommandCategory.Mutate],
    ['yum', CommandCategory.Mutate],
    ['dnf', CommandCategory.Mutate],
    ['pacman', CommandCategory.Mutate],
    ['exec', CommandCategory.Mutate],
    ['eval', CommandCategory.Mutate],
    ['xargs', CommandCategory.Mutate],
    ['echo', CommandCategory.Mutate],
    ['grep', CommandCategory.Mutate],
    ['find', CommandCategory.Mutate],

    // Destructive commands
    ['rm', CommandCategory.Destructive],
    ['dd', CommandCategory.Destructive],
    ['mkfs', CommandCategory.Destructive],
    ['fdisk', CommandCategory.Destructive],
    ['shutdown', CommandCategory.Destructive],
    ['reboot', CommandCategory.Destructive],
    ['poweroff', CommandCategory.Destructive],
    ['sudo', CommandCategory.Destructive],
    ['su', CommandCategory.Destructive],
    ['useradd', CommandCategory.Destructive],
    ['userdel', CommandCategory.Destructive],
    ['passwd', CommandCategory.Destructive],
    ['visudo', CommandCategory.Destructive],
    ['insmod', CommandCategory.Destructive],
    ['rmmod', CommandCategory.Destructive],
    ['modprobe', CommandCategory.Destructive],
    ['kill', CommandCategory.Destructive],
    ['killall', CommandCategory.Destructive],
    ['pkill', CommandCategory.Destructive],
    ['iptables', CommandCategory.Destructive],
    ['route', CommandCategory.Destructive],
    ['chown', CommandCategory.Destructive],
])
export const maxToolResponseSize: number = 1024 * 1024 // 1MB
export const lineCount: number = 1024
export const destructiveCommandWarningMessage = 'WARNING: Potentially destructive command detected:\n\n'
export const mutateCommandWarningMessage = 'Mutation command:\n\n'
export const outOfWorkspaceWarningmessage = 'Execution out of workspace scope:\n\n'
export const credentialFileWarningMessage =
    'WARNING: Command involves credential files that require secure permissions:\n\n'
export const binaryFileWarningMessage = 'WARNING: Command involves binary files that require secure permissions:\n\n'

/**
 * Parameters for executing a command on the system shell.
 * Works cross-platform: uses cmd.exe on Windows and bash on Unix-like systems.
 */
export interface ExecuteBashParams extends ExplanatoryParams {
    command: string
    cwd?: string
}

interface TimestampedChunk {
    timestamp: number
    isStdout: boolean
    content: string
    isFirst: boolean
}

/**
 * Output from executing a command on the system shell.
 * Format is consistent across platforms (Windows, macOS, Linux).
 */
export interface ExecuteBashOutput {
    exitStatus: string
    stdout: string
    stderr: string
}

/**
 * Static determination if the current platform should use Windows-style commands
 * true if the platform should use Windows command shell, false for Unix-like shells
 */
const IS_WINDOWS_PLATFORM = process.platform === 'win32'

export class ExecuteBash {
    private childProcess?: ChildProcess
    private readonly logging: Features['logging']
    private readonly workspace: Features['workspace']
    private readonly telemetry: Features['telemetry']
    private readonly credentialsProvider: Features['credentialsProvider']
    private readonly features: Pick<Features, 'logging' | 'workspace' | 'telemetry' | 'credentialsProvider'> &
        Partial<Features>
    constructor(
        features: Pick<Features, 'logging' | 'workspace' | 'telemetry' | 'credentialsProvider'> & Partial<Features>
    ) {
        this.features = features
        this.logging = features.logging
        this.workspace = features.workspace
        this.telemetry = features.telemetry
        this.credentialsProvider = features.credentialsProvider
    }

    public async validate(input: ExecuteBashParams): Promise<void> {
        const command = input.command
        if (!command.trim()) {
            throw new Error('Command cannot be empty.')
        }

        const args = split(command)
        if (!args || args.length === 0) {
            throw new Error('No command found.')
        }

        try {
            await ExecuteBash.whichCommand(this.logging, args[0])
        } catch {
            throw new Error(`Command '${args[0]}' not found on PATH.`)
        }
    }

    private static handleTimestampedChunk(
        chunk: TimestampedChunk,
        stdoutBuffer: string[],
        stderrBuffer: string[],
        writer?: WritableStreamDefaultWriter
    ): void {
        const buffer = chunk.isStdout ? stdoutBuffer : stderrBuffer
        ExecuteBash.handleChunk(chunk.content, buffer, writer)
    }

    public async requiresAcceptance(
        params: ExecuteBashParams,
        approvedPaths?: Map<string, Set<string>>
    ): Promise<CommandValidation> {
        try {
            // On Windows, pre-check the raw command for backslash-based traversal patterns
            // before shlex parsing. shlex.split() treats backslashes as escape characters
            // (Unix shell semantics), which mangles Windows paths like "src\..\..\..\etc"
            // into "src......etc", hiding ".." traversal sequences from downstream checks.
            if (IS_WINDOWS_PLATFORM && /\\\.\./.test(params.command)) {
                return {
                    requiresAcceptance: true,
                    warning: outOfWorkspaceWarningmessage,
                    commandCategory: CommandCategory.ReadOnly,
                }
            }

            const args = split(params.command)
            if (!args || args.length === 0) {
                return { requiresAcceptance: true }
            }

            // Split commands by operators and process each segment
            let currentCmd: string[] = []
            const allCommands: string[][] = []

            for (const arg of args) {
                if (splitOperators.has(arg)) {
                    if (currentCmd.length > 0) {
                        allCommands.push(currentCmd)
                    }
                    currentCmd = []
                } else if (splitOperatorsArray.some(op => arg.includes(op))) {
                    return { requiresAcceptance: true }
                } else {
                    currentCmd.push(arg)
                }
            }

            if (currentCmd.length > 0) {
                allCommands.push(currentCmd)
            }

            // Track highest command category (ReadOnly < Mutate < Destructive)
            let highestCommandCategory = CommandCategory.ReadOnly

            for (const cmdArgs of allCommands) {
                if (cmdArgs.length === 0) {
                    return { requiresAcceptance: true, commandCategory: highestCommandCategory }
                }

                // For each command, validate arguments for path safety within workspace
                for (const arg of cmdArgs) {
                    if (this.looksLikePath(arg)) {
                        // Special handling for tilde paths in Unix-like systems
                        let fullPath: string
                        if (!IS_WINDOWS_PLATFORM && arg.startsWith('~')) {
                            // Treat tilde paths as absolute paths (they will be expanded by the shell)
                            return {
                                requiresAcceptance: true,
                                warning: destructiveCommandWarningMessage,
                                commandCategory: CommandCategory.Destructive,
                            }
                        } else if (!isAbsolute(arg) && params.cwd) {
                            // If not absolute, resolve to canonical path (eliminates ".." traversal)
                            fullPath = resolve(params.cwd, arg)
                        } else {
                            // Resolve absolute paths too to canonicalize any ".." sequences
                            fullPath = resolve(arg)
                        }

                        // Check if the path is already approved
                        if (approvedPaths && isPathApproved(fullPath, 'executeBash', approvedPaths)) {
                            continue
                        }

                        // Check if this is a credential file that needs protection
                        try {
                            if (existsSync(fullPath) && statSync(fullPath).isFile()) {
                                // Check for credential files
                                if (this.isLikelyCredentialFile(fullPath)) {
                                    this.logging.info(`Detected credential file in command: ${fullPath}`)
                                    return {
                                        requiresAcceptance: true,
                                        warning: credentialFileWarningMessage,
                                        commandCategory: CommandCategory.Mutate,
                                    }
                                }

                                // Check for binary files
                                if (this.isLikelyBinaryFile(fullPath)) {
                                    this.logging.info(`Detected binary file in command: ${fullPath}`)
                                    return {
                                        requiresAcceptance: true,
                                        warning: binaryFileWarningMessage,
                                        commandCategory: CommandCategory.Mutate,
                                    }
                                }
                            }
                        } catch (err) {
                            // Ignore errors for files that don't exist or can't be accessed
                            this.logging.debug(`Error checking file ${fullPath}: ${(err as Error).message}`)
                        }

                        const isInWorkspace = workspaceUtils.isInWorkspace(
                            getWorkspaceFolderPaths(this.workspace),
                            fullPath
                        )
                        if (!isInWorkspace) {
                            return {
                                requiresAcceptance: true,
                                warning: outOfWorkspaceWarningmessage,
                                commandCategory: highestCommandCategory,
                            }
                        }
                    }
                }

                const command = cmdArgs[0]
                const category = commandCategories.get(command)

                // Special case: curl/wget with pipes should be treated as destructive (curl | bash pattern)
                if ((command === 'curl' || command === 'wget') && params.command.includes('|')) {
                    return {
                        requiresAcceptance: true,
                        warning: 'WARNING: Downloading and piping to shell execution is dangerous:\n\n',
                        commandCategory: CommandCategory.Destructive,
                    }
                }

                // Update the highest command category if current command has higher risk
                if (category === CommandCategory.Destructive) {
                    highestCommandCategory = CommandCategory.Destructive
                } else if (
                    category === CommandCategory.Mutate &&
                    highestCommandCategory !== CommandCategory.Destructive
                ) {
                    highestCommandCategory = CommandCategory.Mutate
                }

                switch (category) {
                    case CommandCategory.Destructive:
                        return {
                            requiresAcceptance: true,
                            warning: destructiveCommandWarningMessage,
                            commandCategory: CommandCategory.Destructive,
                        }
                    case CommandCategory.Mutate:
                        return {
                            requiresAcceptance: true,
                            warning: mutateCommandWarningMessage,
                            commandCategory: CommandCategory.Mutate,
                        }
                    case CommandCategory.ReadOnly:
                        continue
                    default:
                        return {
                            requiresAcceptance: true,
                            commandCategory: highestCommandCategory,
                        }
                }
            }
            // Finally, check if the cwd is outside the workspace
            if (params.cwd) {
                // Check if the cwd is already approved
                if (!(approvedPaths && isPathApproved(params.cwd, 'executeBash', approvedPaths))) {
                    const workspaceFolders = getWorkspaceFolderPaths(this.workspace)

                    // If there are no workspace folders, we can't validate the path
                    if (!workspaceFolders || workspaceFolders.length === 0) {
                        return {
                            requiresAcceptance: true,
                            warning: outOfWorkspaceWarningmessage,
                            commandCategory: highestCommandCategory,
                        }
                    }

                    // Resolve the cwd to canonicalize any ".." traversal sequences
                    const resolvedCwd = resolve(params.cwd).replace(/\\/g, '/')
                    const normalizedWorkspaceFolders = workspaceFolders.map(folder =>
                        resolve(folder).replace(/\\/g, '/')
                    )

                    // Check if the resolved cwd is in any of the resolved workspace folders
                    const isInWorkspace = normalizedWorkspaceFolders.some(
                        folder => resolvedCwd === folder || resolvedCwd.startsWith(folder + '/')
                    )

                    if (!isInWorkspace) {
                        return {
                            requiresAcceptance: true,
                            warning: outOfWorkspaceWarningmessage,
                            commandCategory: highestCommandCategory,
                        }
                    }
                }
            }

            // If we've checked all commands and none required acceptance, we're good
            return { requiresAcceptance: false, commandCategory: highestCommandCategory }
        } catch (error) {
            this.logging.warn(`Error while checking acceptance: ${(error as Error).message}`)
            return { requiresAcceptance: true, commandCategory: CommandCategory.ReadOnly }
        }
    }

    private looksLikePath(arg: string): boolean {
        // Detect path traversal sequences anywhere in the argument (e.g. "folder/../../../etc")
        const containsTraversal = arg.includes('..') || arg.includes('%2e%2e') || arg.includes('%2E%2E')

        if (IS_WINDOWS_PLATFORM) {
            // Windows path patterns
            return (
                containsTraversal ||
                arg.startsWith('/') ||
                arg.startsWith('./') ||
                arg.startsWith('../') ||
                arg.startsWith('\\\\') || // UNC path
                arg.startsWith('.\\') ||
                arg.startsWith('..\\') ||
                /^[a-zA-Z]:[/\\]/.test(arg) ||
                arg.startsWith('%') // Windows environment variables like %USERPROFILE%
            ) // Drive letter paths like C:\ or C:/
        } else {
            // Unix path patterns
            return (
                containsTraversal ||
                arg.startsWith('/') ||
                arg.startsWith('./') ||
                arg.startsWith('../') ||
                arg.startsWith('~')
            )
        }
    }

    // Static patterns for faster lookups - defined once, used many times
    private static readonly CREDENTIAL_PATTERNS = new Set([
        'credential',
        'secret',
        'token',
        'password',
        'key',
        'cert',
        'auth',
        '.aws',
        '.ssh',
        '.pgp',
        '.gpg',
        '.pem',
        '.crt',
        '.key',
        '.p12',
        '.pfx',
        'config.json',
        'settings.json',
        '.env',
        '.npmrc',
        '.yarnrc',
    ])

    private static readonly BINARY_EXTENSIONS_WINDOWS = new Set(['.exe', '.dll', '.bat', '.cmd'])

    /**
     * Efficiently checks if a file is likely to contain credentials based on name or extension
     * @param filePath Path to check
     * @returns true if the file likely contains credentials
     */
    private isLikelyCredentialFile(filePath: string): boolean {
        const fileName = filePath.toLowerCase()

        // Fast check using Set for O(1) lookups instead of array iteration
        for (const pattern of ExecuteBash.CREDENTIAL_PATTERNS) {
            if (fileName.includes(pattern)) {
                return true
            }
        }

        return false
    }

    /**
     * Efficiently checks if a file is a binary executable
     * @param filePath Path to check
     * @returns true if the file is likely a binary executable
     */
    private isLikelyBinaryFile(filePath: string): boolean {
        if (IS_WINDOWS_PLATFORM) {
            const ext = extname(filePath).toLowerCase()
            return ExecuteBash.BINARY_EXTENSIONS_WINDOWS.has(ext)
        }

        try {
            // Check if file exists and is executable
            const stats = statSync(filePath)
            return stats.isFile() && (stats.mode & 0o111) !== 0 // Check if any execute bit is set
        } catch (error) {
            this.logging.debug(`Failed to check if file is binary: ${filePath}, error: ${(error as Error).message}`)
            return false
        }
    }

    // TODO: generalize cancellation logic for tools.
    public async invoke(
        params: ExecuteBashParams,
        cancellationToken?: CancellationToken,
        updates?: WritableStream
    ): Promise<InvokeOutput> {
        // use absoluate file path
        const { shellName, shellFlag } = IS_WINDOWS_PLATFORM
            ? { shellName: 'C:\\Windows\\System32\\cmd.exe', shellFlag: '/c' }
            : { shellName: '/bin/bash', shellFlag: '-c' }
        this.logging.info(`Invoking ${shellName} command: "${params.command}" in cwd: "${params.cwd}"`)

        return new Promise(async (resolve, reject) => {
            let finished = false
            const abort = (err: Error) => {
                if (!finished) {
                    finished = true
                    reject(err) // <─ propagate the error to caller
                }
            }

            // Check if cancelled before starting
            if (cancellationToken?.isCancellationRequested) {
                this.logging.debug('Command execution cancelled before starting')
                return abort(new CancellationError('user'))
            }

            this.logging.debug(
                `Spawning process with command: ${shellName} ${shellFlag} "${params.command}" (cwd=${params.cwd})`
            )

            const stdoutBuffer: string[] = []
            const stderrBuffer: string[] = []

            // Use a closure boolean value firstChunk and a function to get and set its value
            let isFirstChunk = true
            const getAndSetFirstChunk = (newValue: boolean): boolean => {
                const oldValue = isFirstChunk
                isFirstChunk = newValue
                return oldValue
            }

            // Use a queue to maintain chronological order of chunks
            // This ensures that the output is processed in the exact order it was generated by the child process.
            const outputQueue: TimestampedChunk[] = []
            let processingQueue = false

            const writer = updates?.getWriter()
            // Process the queue in order
            const processQueue = () => {
                if (processingQueue || outputQueue.length === 0) {
                    return
                }

                processingQueue = true

                try {
                    // Sort by timestamp to ensure chronological order
                    outputQueue.sort((a, b) => a.timestamp - b.timestamp)

                    while (outputQueue.length > 0) {
                        const chunk = outputQueue.shift()!
                        ExecuteBash.handleTimestampedChunk(chunk, stdoutBuffer, stderrBuffer, writer)
                    }
                } finally {
                    processingQueue = false
                }
            }

            // Set up environment variables with AWS CLI identifier for CloudTrail auditability
            const env = { ...process.env }

            // Add Q Developer IDE identifier for AWS CLI commands
            // Check if command contains 'aws ' anywhere (handles multi-command scenarios)
            if (params.command.includes('aws ')) {
                let extensionVersion = 'unknown'
                try {
                    const clientInfo = this.features?.lsp?.getClientInitializeParams()?.clientInfo
                    const initOptions = this.features?.lsp?.getClientInitializeParams()?.initializationOptions
                    extensionVersion =
                        initOptions?.aws?.clientInfo?.extension?.version || clientInfo?.version || 'unknown'
                } catch {
                    extensionVersion = 'unknown'
                }
                const userAgentMetadata = `AmazonQ-For-IDE Version/${extensionVersion}`
                this.logging.info(
                    `AWS command detected: ${params.command}, setting AWS_EXECUTION_ENV to: ${userAgentMetadata}`
                )

                if (env.AWS_EXECUTION_ENV) {
                    env.AWS_EXECUTION_ENV = env.AWS_EXECUTION_ENV.trim()
                        ? `${env.AWS_EXECUTION_ENV} ${userAgentMetadata}`
                        : userAgentMetadata
                } else {
                    env.AWS_EXECUTION_ENV = userAgentMetadata
                }

                this.logging.info(`Final AWS_EXECUTION_ENV value: ${env.AWS_EXECUTION_ENV}`)
            } else {
                this.logging.debug(`Non-AWS command: ${params.command}`)
            }

            const childProcessOptions: ChildProcessOptions = {
                spawnOptions: {
                    cwd: params.cwd,
                    env,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsVerbatimArguments: IS_WINDOWS_PLATFORM, // if true, then arguments are passed exactly as provided. no quoting or escaping is done.
                },
                collect: false,
                waitForStreams: true,
                onStdout: async (chunk: string) => {
                    if (cancellationToken?.isCancellationRequested) {
                        this.logging.debug('Command execution cancelled during stdout processing')
                        return abort(new CancellationError('user'))
                    }
                    const isFirst = getAndSetFirstChunk(false)
                    const timestamp = Date.now()
                    outputQueue.push({
                        timestamp,
                        isStdout: true,
                        content: chunk,
                        isFirst,
                    })
                    processQueue()
                },
                onStderr: async (chunk: string) => {
                    if (cancellationToken?.isCancellationRequested) {
                        this.logging.debug('Command execution cancelled during stderr processing')
                        return abort(new CancellationError('user'))
                    }
                    const isFirst = getAndSetFirstChunk(false)
                    const timestamp = Date.now()
                    outputQueue.push({
                        timestamp,
                        isStdout: false,
                        content: chunk,
                        isFirst,
                    })
                    processQueue()
                },
            }

            const shellArgs = IS_WINDOWS_PLATFORM
                ? ['/u', shellFlag, params.command] // Windows: no need to split arguments when using windowsVerbatimArguments: true
                : [shellFlag, params.command]

            this.childProcess = new ChildProcess(this.logging, shellName, shellArgs, childProcessOptions)

            // Set up cancellation listener
            if (cancellationToken) {
                cancellationToken.onCancellationRequested(() => {
                    this.logging.debug('cancellation detected, killing child process')

                    // Kill the process
                    this.childProcess?.stop(false, 'SIGTERM')

                    // After a short delay, force kill with SIGKILL if still running
                    setTimeout(() => {
                        if (this.childProcess && !this.childProcess.stopped) {
                            this.logging.debug('Process still running after SIGTERM, sending SIGKILL')

                            // Try to kill the process group with SIGKILL
                            this.childProcess.stop(true, 'SIGKILL')
                        }
                    }, 500)
                    // Return from the function after cancellation
                    return abort(new CancellationError('user'))
                })
            }

            let success = false
            try {
                const result = await this.childProcess.run()

                // Check if cancelled after execution
                if (cancellationToken?.isCancellationRequested) {
                    this.logging.debug('Command execution cancelled after completion')
                    return abort(new CancellationError('user'))
                }

                const exitStatus = result.exitCode ?? 0
                const stdout = stdoutBuffer.join('\n')
                const stderr = stderrBuffer.join('\n')
                success = exitStatus === 0 && !stderr
                const [stdoutTrunc, stdoutSuffix] = ExecuteBash.truncateSafelyWithSuffix(
                    stdout,
                    maxToolResponseSize / 3
                )
                const [stderrTrunc, stderrSuffix] = ExecuteBash.truncateSafelyWithSuffix(
                    stderr,
                    maxToolResponseSize / 3
                )

                const outputJson: ExecuteBashOutput = {
                    exitStatus: exitStatus.toString(),
                    stdout: stdoutTrunc + (stdoutSuffix ? ' ... truncated' : ''),
                    stderr: stderrTrunc + (stderrSuffix ? ' ... truncated' : ''),
                }

                resolve({
                    output: {
                        kind: 'json',
                        content: outputJson,
                        success,
                    },
                })
            } catch (err: any) {
                // Check if this was due to cancellation
                if (cancellationToken?.isCancellationRequested) {
                    return abort(new CancellationError('user'))
                } else {
                    this.logging.error(`Failed to execute ${shellName} command '${params.command}': ${err.message}`)
                    reject(new Error(`Failed to execute command: ${err.message}`))
                }
            } finally {
                // Extract individual base commands for telemetry purposes
                const args = split(params.command)
                const baseCommands = parseBaseCommands(args)
                baseCommands.forEach(command => {
                    const metricPayload = {
                        name: ChatTelemetryEventName.BashCommand,
                        data: {
                            credentialStartUrl: this.credentialsProvider.getConnectionMetadata()?.sso?.startUrl,
                            result: cancellationToken?.isCancellationRequested
                                ? 'Cancelled'
                                : success
                                  ? 'Succeeded'
                                  : 'Failed',
                            command: command,
                        } as BashCommandEvent,
                    }
                    this.telemetry.emitMetric(metricPayload)
                })

                await writer?.close()
                writer?.releaseLock()
            }
        })
    }

    private static handleChunk(chunk: string, buffer: string[], writer?: WritableStreamDefaultWriter<any>) {
        try {
            // Trim trailing newlines from the chunk before writing
            const trimmedChunk = chunk.replace(/\r?\n$/, '')
            void writer?.write(trimmedChunk)

            const lines = chunk.split(/\r?\n/)
            for (const line of lines) {
                buffer.push(line)
                if (buffer.length > lineCount) {
                    buffer.shift()
                }
            }
        } catch (error) {
            // Log the error but don't let it crash the process
            throw new Error('Error handling output chunk')
        }
    }

    private static truncateSafelyWithSuffix(str: string, maxLength: number): [string, boolean] {
        if (str.length > maxLength) {
            return [str.substring(0, maxLength), true]
        }
        return [str, false]
    }

    private static async whichCommand(logger: Logging, cmd: string): Promise<void> {
        if (IS_WINDOWS_PLATFORM) {
            await this.resolveWindowsCommand(logger, cmd)
        } else {
            await this.resolveUnixCommand(logger, cmd)
        }
    }

    // cmd.exe internal commands that have no executable on PATH, so 'where' cannot find them.
    // Kept as a static set because probing 'cmd.exe /c help <cmd>' is locale-dependent: the
    // "not supported" marker is localized (e.g. German Windows), which made every unknown
    // command pass validation on non-English systems.
    private static readonly CMD_BUILTINS = new Set([
        'assoc',
        'break',
        'call',
        'cd',
        'chdir',
        'cls',
        'color',
        'copy',
        'date',
        'del',
        'dir',
        'dpath',
        'echo',
        'endlocal',
        'erase',
        'exit',
        'for',
        'ftype',
        'goto',
        'if',
        'md',
        'mkdir',
        'mklink',
        'move',
        'path',
        'pause',
        'popd',
        'prompt',
        'pushd',
        'rd',
        'rem',
        'ren',
        'rename',
        'rmdir',
        'set',
        'setlocal',
        'shift',
        'start',
        'time',
        'title',
        'type',
        'ver',
        'verify',
        'vol',
    ])

    private static async resolveWindowsCommand(logger: Logging, cmd: string): Promise<void> {
        // 1. Check for built-in command
        if (ExecuteBash.CMD_BUILTINS.has(cmd.toLowerCase())) {
            return
        }

        // 2. Check for external command or alias
        try {
            const whereProc = new processUtils.ChildProcess(logger, 'where', [cmd], {
                collect: true,
                waitForStreams: true,
            })
            const result = await whereProc.run()
            const output = result.stdout.trim()

            if (result.exitCode === 0 && output) {
                return
            }
        } catch (err) {
            logger.debug(`'where ${cmd}' failed: ${(err as Error).message}`)
        }

        throw new Error(`Command '${cmd}' not found as executable or Windows built-in command`)
    }

    private static async resolveUnixCommand(logger: Logging, cmd: string): Promise<void> {
        try {
            const proc = new processUtils.ChildProcess(logger, 'sh', ['-c', `command -v ${cmd}`], {
                collect: true,
                waitForStreams: true,
            })
            const result = await proc.run()
            const output = result.stdout.trim()

            if (result.exitCode === 0 && output) {
                return
            }
        } catch (err) {
            logger.debug(`'command -v ${cmd}' failed: ${(err as Error).message}`)
        }

        throw new Error(`Command '${cmd}' not found as executable or shell built-in`)
    }

    public async queueDescription(command: string, updates: WritableStream) {
        const writer = updates.getWriter()
        await writer.write('```shell\n' + command + '\n```')
        await writer.close()
        writer.releaseLock()
    }

    public getSpec() {
        if (IS_WINDOWS_PLATFORM) {
            return this.getWindowsSpec()
        } else {
            return this.getMacOSSpec()
        }
    }

    private getWindowsSpec() {
        return {
            name: 'executeBash',
            description:
                'Execute the specified command on Windows cmd.exe.\n\n' +
                '## Overview\n' +
                'This tool executes commands on Windows cmd.exe and returns the output.\n\n' +
                '## Windows Commands\n' +
                "- ONLY use Windows-specific commands like 'dir', 'type', 'copy', 'move', 'del', 'mkdir'.\n" +
                "- DO NOT use -p flag with mkdir. Use 'mkdir dir1 && mkdir dir2' for multiple directories.\n" +
                "- For multiple directories, use multiple commands with && (e.g., 'mkdir main && mkdir main\\src && mkdir main\\test').\n\n" +
                '## When to use\n' +
                "- When you need to run Windows system commands that aren't covered by specialized tools.\n" +
                '- When you need to interact with Windows applications or utilities.\n' +
                '- When you need to perform Windows-specific operations.\n\n' +
                '## When not to use\n' +
                '- When specialized tools would be more appropriate for the task.\n' +
                '- When you need to perform file operations (use dedicated file tools instead).\n' +
                '- When you need to search through files (use dedicated search tools instead).\n\n' +
                '## Notes\n' +
                '- Output is limited to prevent overwhelming responses.\n',
            inputSchema: {
                type: 'object',
                properties: {
                    explanation: {
                        type: 'string',
                        description:
                            'One sentence explanation as to why this tool is being used, and how it contributes to the goal.',
                    },
                    command: {
                        type: 'string',
                        description: 'Windows command to execute in cmd.exe. Use cmd.exe syntax and commands.',
                    },
                    cwd: {
                        type: 'string',
                        description:
                            'Parameter to set the current working directory for the command execution. Use Windows path format with backslashes (e.g., C:\\Users\\username\\folder\\subfolder).',
                    },
                },
                required: ['command', 'cwd'],
            },
        } as const
    }

    private getMacOSSpec() {
        return {
            name: 'executeBash',
            description:
                'Execute the specified command on the macOS/Unix shell (bash).\n\n' +
                '## Overview\n' +
                'This tool executes commands on macOS/Unix shell and returns the output.\n\n' +
                '## macOS/Unix Commands\n' +
                "- Use Unix commands like 'ls', 'cat', 'cp', 'mv', 'rm', 'mkdir -p', 'grep', 'find'.\n\n" +
                '## When to use\n' +
                "- When you need to run Unix/macOS system commands that aren't covered by specialized tools.\n" +
                '- When you need to interact with installed applications or utilities.\n' +
                '- When you need to perform operations that require shell capabilities.\n\n' +
                '## When not to use\n' +
                '- When specialized tools would be more appropriate for the task.\n' +
                '- When you need to perform file operations (use dedicated file tools instead).\n' +
                '- When you need to search through files (use dedicated search tools instead).\n\n' +
                '## Notes\n' +
                '- Output is limited to prevent overwhelming responses.\n',
            inputSchema: {
                type: 'object',
                properties: {
                    explanation: {
                        type: 'string',
                        description:
                            'One sentence explanation as to why this tool is being used, and how it contributes to the goal.',
                    },
                    command: {
                        type: 'string',
                        description: 'Unix/macOS command to execute in bash. Use Unix-specific syntax and commands.',
                    },
                    cwd: {
                        type: 'string',
                        description: 'Parameter to set the current working directory for the command execution.',
                    },
                },
                required: ['command', 'cwd'],
            },
        } as const
    }
}
