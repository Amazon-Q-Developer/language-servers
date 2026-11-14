// Port from VSC https://github.com/aws/aws-toolkit-vscode/blob/741c2c481bcf0dca2d9554e32dc91d8514b1b1d1/packages/core/src/codewhispererChat/tools/executeBash.ts#L134

import {
    CommandValidation,
    ExplanatoryParams,
    InvokeOutput,
    isPathApproved,
    isPathExactlyApproved,
    isSamePath,
    multiplyLinkedFileWarning,
    needsExactApproval,
    resolveSymlinkAwarePath,
    canonicalizeWorkspaceFolders,
} from './toolShared'
import { split } from 'shlex'
import { Logging } from '@aws/language-server-runtimes/server-interface'
import { CancellationError, processUtils, workspaceUtils } from '@aws/lsp-core'
import { CancellationToken } from 'vscode-languageserver'
import { ChildProcess, ChildProcessOptions } from '@aws/lsp-core/out/util/processUtils'
// eslint-disable-next-line import/no-nodejs-modules
import { isAbsolute, resolve, extname, join, parse, win32 } from 'path' // Safe to import on web since this is part of path-browserify
import { Features } from '../../types'
import { getWorkspaceFolderPaths } from '@aws/lsp-core/out/util/workspaceUtils'
// eslint-disable-next-line import/no-nodejs-modules
import { existsSync, statSync, lstatSync } from 'fs'
// eslint-disable-next-line import/no-nodejs-modules
import { homedir } from 'os'
import { parseBaseCommands } from '../utils/commandParser'
import { shellCommandBlock } from '../textFormatting'
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

/**
 * On Windows the shell is `cmd.exe`, which runs the raw command string verbatim, but
 * {@link ExecuteBash.requiresAcceptance} tokenizes the command with shlex, whose POSIX rules treat
 * a backslash as an escape character and delete it. A Windows drive path such as
 * `C:\Users\alice\.aws\credentials` therefore collapses into the single token
 * `C:Usersalice.awscredentials`, which no longer looks absolute, resolves inside the working
 * directory, and so slips past the workspace, credential, and traversal checks below while
 * `cmd.exe` still opens the real file.
 *
 * This detects a drive-letter path in the raw command so such a command can fail closed (require
 * approval). It matches a single drive letter followed by a colon at a token boundary, which also
 * covers a forward-slash drive path (`C:/Users/...`) and a bare drive-relative path (`C:name`).
 * Requiring a token boundary keeps a URI scheme such as `https:` from being read as a drive.
 *
 * The function is platform-independent so it can be unit-tested on any host; the caller applies it
 * only on Windows.
 */
export function hasWindowsDrivePath(command: string): boolean {
    return /(?:^|[\s"'=,;(){}<>|&])[a-zA-Z]:/.test(command)
}

/**
 * Detects a Windows UNC path (`\\host\share`) or its forward-slash form (`//host/share`) in a raw
 * command. Like a drive path, a UNC path is corrupted by shlex tokenization (`\\host\share` becomes
 * `\hostshare`), so the token-based checks cannot recognize it, while `cmd.exe` still opens the
 * share, which on Windows can trigger outbound SMB authentication to an attacker-named host. This
 * branch already blocks these forms incidentally, through an unrelated tokenizer side effect; this
 * makes the control explicit at the raw-command layer and independent of that side effect.
 *
 * Matches a `\\` or `//` prefix at a token boundary. Requiring a token boundary keeps a URI
 * authority such as `https://` from being read as a UNC path. The function is platform-independent
 * so it can be unit-tested on any host; the caller applies it only on Windows.
 */
export function hasWindowsUncPath(command: string): boolean {
    return /(?:^|[\s"'=,;(){}<>|&])(?:\\\\|\/\/)/.test(command)
}

/**
 * Detects a Windows root-relative path that begins with a backslash, such as
 * `\Users\alice\.aws\credentials` (and, as a superset, the UNC form `\\host\share`). shlex deletes a
 * single leading backslash, so `\Users\alice\x` collapses to the token `Usersalicex`, which looks
 * like an ordinary in-workspace name and passes the boundary check, while `cmd.exe` reads the path
 * from the root of the working directory's drive. Without this, dropping the `C:` from a drive path
 * reproduces the drive-path bypass. Fail closed on any token that begins with a backslash.
 *
 * Only a leading backslash is matched. A path with a backslash inside a word (`sub\file`) is relative
 * to the working directory, but it can still name a credential file or pass through a junction to a
 * folder outside the workspace, so requiresAcceptance checks it as cmd.exe reads it (see
 * {@link windowsCommandWords}). A `..\` traversal is left to the traversal checks: the `\..`
 * pre-check catches `..\..\`, and the checks of the words that cmd.exe reads catch a single-hop
 * `..\name`. The function is platform-independent so it can be unit-tested on any host; the caller
 * applies it only on Windows.
 */
export function hasWindowsRootedPath(command: string): boolean {
    return /(?:^|[\s"'=,;(){}<>|&])\\/.test(command)
}

/**
 * Splits a command into the words that cmd.exe gives to a built-in command such as `type` or `dir`.
 * Whitespace, a comma, or an equals sign outside double quotes ends a word, and the double quotes are
 * removed. A backslash stays in its word. cmd.exe also splits at a semicolon, but requiresAcceptance
 * always asks for approval for a command that contains a semicolon.
 *
 * shlex reads the same command with POSIX rules, so a token can name a different path than the word
 * that cmd.exe reads: shlex deletes the backslash in `app\.env` (the token is `app.env`), and it keeps
 * `notes.txt,.env` as one token. Returns undefined when a double quote is not closed, so the caller
 * can ask for approval.
 *
 * The function is platform-independent so it can be unit-tested on any host; the caller applies it
 * only on Windows.
 */
export function windowsCommandWords(command: string): string[] | undefined {
    const words: string[] = []
    let word = ''
    let isQuoted = false
    for (const char of command) {
        if (char === '"') {
            isQuoted = !isQuoted
        } else if (!isQuoted && /[\s,=]/.test(char)) {
            if (word) {
                words.push(word)
            }
            word = ''
        } else {
            word += char
        }
    }
    if (isQuoted) {
        return undefined
    }
    if (word) {
        words.push(word)
    }
    return words
}

/**
 * True for a UNC or device path (`\\host\share`, `//host/share`, `\\?\C:\...`) that is not in a
 * workspace folder. A file system call on a UNC path makes Windows connect to the host that the path
 * names, which can send the user's credentials to that host, so such a path is not checked on disk. A
 * path in a workspace folder on a share is on a host that the IDE already uses.
 *
 * The function uses Windows path rules on every host so it can be unit-tested anywhere; the caller
 * applies it only on Windows.
 */
export function isRemoteWindowsPath(windowsPath: string, workspaceFolders: string[]): boolean {
    const resolvedPath = win32.resolve(windowsPath)
    if (!/^[\\/]{2}/.test(resolvedPath)) {
        return false
    }
    return !workspaceFolders.some(folder => {
        const relativePath = win32.relative(win32.resolve(folder), resolvedPath)
        return !relativePath.startsWith('..') && !win32.isAbsolute(relativePath)
    })
}

/** What the path checks of {@link ExecuteBash.requiresAcceptance} need to know about the command */
interface PathCheckContext {
    cwd?: string
    canonicalWorkspaceFolders: string[]
    isReadOnlyCommand: boolean
    approvedPaths?: Map<string, Set<string>>
}

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

            // Tokenization does not evaluate shell syntax. Retain the raw approval requirement,
            // including quoted or escaped markers, while collecting category and warning metadata.
            const expansionPattern = IS_WINDOWS_PLATFORM ? /[%!^*?[\]]/ : /[$`{}*?[\]]/
            const requiresShellApproval =
                expansionPattern.test(params.command) ||
                /[<>();&|\r\n]/.test(params.command) ||
                // On Windows, shlex tokenization deletes the backslashes in a drive path, a UNC
                // path, or a root-relative `\...` path, so a command such as
                // `type C:\Users\alice\.aws\credentials`, `dir \\host\share`, or
                // `type \Users\alice\.aws\credentials` would otherwise slip past the path checks
                // below while cmd.exe reads the real location. Fail closed on any of those raw forms.
                (IS_WINDOWS_PLATFORM &&
                    (hasWindowsDrivePath(params.command) ||
                        hasWindowsUncPath(params.command) ||
                        hasWindowsRootedPath(params.command)))

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

            // Canonicalize the workspace folders once so every boundary check below
            // is symlink-aware: a workspace reached through a symlinked directory
            // (e.g. macOS /tmp -> /private/tmp) still compares correctly.
            const canonicalWorkspaceFolders = await canonicalizeWorkspaceFolders(
                getWorkspaceFolderPaths(this.workspace)
            )
            // On Windows, do not check a UNC or device cwd outside the workspace on disk (see
            // isRemoteWindowsPath): the checks below would make Windows connect to its host.
            if (IS_WINDOWS_PLATFORM && params.cwd && isRemoteWindowsPath(params.cwd, canonicalWorkspaceFolders)) {
                return {
                    requiresAcceptance: true,
                    warning: outOfWorkspaceWarningmessage,
                    commandCategory: highestCommandCategory,
                }
            }
            // The cwd, when running in it needs approval. An approval of an out-of-workspace prompt
            // allows the cwd for later commands only for a read-only command without shell syntax,
            // and only for a cwd that canAllowCwd accepts: the card does not show the cwd.
            const cwdNeedingApproval = params.cwd
                ? await this.cwdNeedingApproval(params.cwd, canonicalWorkspaceFolders, approvedPaths)
                : undefined
            const isReadOnlyCommand = allCommands.every(
                cmdArgs => commandCategories.get(cmdArgs[0]) === CommandCategory.ReadOnly
            )
            const cwdApproval =
                cwdNeedingApproval &&
                isReadOnlyCommand &&
                !requiresShellApproval &&
                (await ExecuteBash.canAllowCwd(params.cwd!, cwdNeedingApproval))
                    ? { approvalPaths: [cwdNeedingApproval] }
                    : {}

            const pathCheck: PathCheckContext = {
                cwd: params.cwd,
                canonicalWorkspaceFolders,
                isReadOnlyCommand,
                approvedPaths,
            }

            for (const cmdArgs of allCommands) {
                if (cmdArgs.length === 0) {
                    return { requiresAcceptance: true, commandCategory: highestCommandCategory }
                }

                // For each command, validate arguments for path safety within workspace
                for (const arg of cmdArgs) {
                    const approval = await this.pathArgumentApproval(arg, pathCheck, highestCommandCategory)
                    if (approval) {
                        return approval
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

            // On Windows, cmd.exe reads the words of the raw command, and a word can name a different
            // path than the shlex token that the loop above checked. Check those words too.
            if (IS_WINDOWS_PLATFORM) {
                const approval = await this.windowsWordsApproval(
                    params.command,
                    args,
                    pathCheck,
                    highestCommandCategory
                )
                if (approval) {
                    return approval
                }
            }

            // Finally, check if the cwd is outside the workspace
            if (cwdNeedingApproval) {
                return {
                    requiresAcceptance: true,
                    warning: outOfWorkspaceWarningmessage,
                    commandCategory: highestCommandCategory,
                    ...cwdApproval,
                }
            }

            // Only simple commands that passed every check can run without approval.
            return { requiresAcceptance: requiresShellApproval, commandCategory: highestCommandCategory }
        } catch (error) {
            this.logging.warn(`Error while checking acceptance: ${(error as Error).message}`)
            return { requiresAcceptance: true, commandCategory: CommandCategory.ReadOnly }
        }
    }

    /**
     * The approval that one argument of a command needs, or undefined when the argument is not a
     * path, or is a path that passes the credential, binary, hard link, and workspace checks
     */
    private async pathArgumentApproval(
        arg: string,
        context: PathCheckContext,
        commandCategory: CommandCategory
    ): Promise<CommandValidation | undefined> {
        // looksLikePath catches obvious paths (absolute, ./, ../, ".."
        // traversal, Windows drive letters, tilde, ...).
        // looksLikeRelativePath additionally catches bare relative
        // arguments such as "notes.txt" or "sub/notes.txt" that would
        // otherwise bypass the boundary and credential checks. Flags and
        // plain-text tokens are intentionally not treated as paths.
        if (!this.looksLikePath(arg) && !this.looksLikeRelativePath(arg, context.cwd)) {
            return undefined
        }

        // Special handling for tilde paths in Unix-like systems
        if (!IS_WINDOWS_PLATFORM && arg.startsWith('~')) {
            // Treat tilde paths as absolute paths (they will be expanded by the shell)
            return {
                requiresAcceptance: true,
                warning: destructiveCommandWarningMessage,
                commandCategory: CommandCategory.Destructive,
            }
        }

        // Resolve to an absolute path against cwd, then canonicalize it in
        // a symlink-aware way (eliminates ".." traversal AND follows a
        // symlink whose name is in-workspace but whose target is outside).
        let candidate: string
        if (!isAbsolute(arg) && context.cwd) {
            candidate = resolve(context.cwd, arg)
        } else {
            candidate = resolve(arg)
        }

        // On Windows, do not check a UNC or device path outside the workspace on disk (see
        // isRemoteWindowsPath): the file system call could connect to a host before the user approves.
        if (IS_WINDOWS_PLATFORM && isRemoteWindowsPath(candidate, context.canonicalWorkspaceFolders)) {
            return { requiresAcceptance: true, warning: outOfWorkspaceWarningmessage, commandCategory }
        }

        const fullPath = await resolveSymlinkAwarePath(candidate)

        // Check if this is a credential or binary file that needs
        // protection. The existence / regular-file guard stays on the
        // canonical fullPath (as before), but the sensitivity
        // heuristic considers BOTH the lexical spelling (candidate)
        // and the canonical target (fullPath). Otherwise a symlink
        // named ".env" or "tool.exe" whose target is an ordinary file
        // would hide a credential/binary name behind an innocuous
        // canonical name. This only widens the warning; approval
        // (isPathApproved) and the workspace boundary remain
        // canonical-only and are unchanged.
        try {
            if (existsSync(fullPath) && statSync(fullPath).isFile()) {
                // Check for credential files by lexical name OR canonical target.
                if (this.isLikelyCredentialFile(candidate) || this.isLikelyCredentialFile(fullPath)) {
                    this.logging.info(`Detected credential file in command: ${fullPath}`)
                    return {
                        requiresAcceptance: true,
                        warning: credentialFileWarningMessage,
                        commandCategory: CommandCategory.Mutate,
                    }
                }

                // Check for binary files by lexical name OR canonical target.
                if (this.isLikelyBinaryFile(candidate) || this.isLikelyBinaryFile(fullPath)) {
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

        // A file that shares its data with another name on disk, which may be outside the
        // workspace, needs approval wherever it is
        if (ExecuteBash.hasOtherNames(fullPath)) {
            return {
                requiresAcceptance: true,
                warning: multiplyLinkedFileWarning(context.isReadOnlyCommand ? 'read' : 'modify'),
                commandCategory,
            }
        }

        // An approved path skips the workspace check, not the file checks above
        if (context.approvedPaths && this.isApprovedArgument(candidate, fullPath, context.approvedPaths)) {
            return undefined
        }

        const isInWorkspace = workspaceUtils.isInWorkspace(context.canonicalWorkspaceFolders, fullPath)
        if (!isInWorkspace) {
            return {
                requiresAcceptance: true,
                warning: outOfWorkspaceWarningmessage,
                commandCategory,
            }
        }
        return undefined
    }

    /**
     * On Windows, the approval that the words of the raw command need, or undefined when every word
     * passes the path checks. cmd.exe reads the words that {@link windowsCommandWords} returns, and
     * shlex can make a different token of the same text: `app\.env` becomes `app.env`,
     * `link\data.txt` becomes `linkdata.txt`, and `notes.txt,.env` stays one token. Only a word that
     * is not also a token is checked, because the loop over the tokens already checked the others.
     */
    private async windowsWordsApproval(
        command: string,
        tokens: string[],
        context: PathCheckContext,
        commandCategory: CommandCategory
    ): Promise<CommandValidation | undefined> {
        const words = windowsCommandWords(command)
        if (!words) {
            return { requiresAcceptance: true, commandCategory }
        }
        const checkedTokens = new Set(tokens)
        for (const word of words) {
            if (checkedTokens.has(word)) {
                continue
            }
            const approval = await this.pathArgumentApproval(word, context, commandCategory)
            if (approval) {
                return approval
            }
        }
        return undefined
    }

    /**
     * The canonical cwd when it is outside the workspace and not approved, otherwise undefined. A
     * credential or system folder needs an approval of that folder itself.
     */
    private async cwdNeedingApproval(
        cwd: string,
        canonicalWorkspaceFolders: string[],
        approvedPaths?: Map<string, Set<string>>
    ): Promise<string | undefined> {
        // Canonicalize the cwd in a symlink-aware way so a symlinked cwd is
        // compared at its real location (and any ".." is eliminated).
        const canonicalCwd = await resolveSymlinkAwarePath(cwd)
        const isCwdApproved =
            approvedPaths &&
            (needsExactApproval(cwd) || needsExactApproval(canonicalCwd)
                ? isPathExactlyApproved(canonicalCwd, 'executeBash', approvedPaths)
                : isPathApproved(canonicalCwd, 'executeBash', approvedPaths))
        if (isCwdApproved) {
            return undefined
        }
        // Without workspace folders the cwd cannot be validated
        return workspaceUtils.isInWorkspace(canonicalWorkspaceFolders, canonicalCwd) ? undefined : canonicalCwd
    }

    /**
     * True when an approved path covers a path argument. A credential or system path needs an
     * approval of that path itself.
     */
    private isApprovedArgument(candidate: string, fullPath: string, approvedPaths: Map<string, Set<string>>): boolean {
        return needsExactApproval(candidate) || needsExactApproval(fullPath)
            ? isPathExactlyApproved(fullPath, 'executeBash', approvedPaths)
            : isPathApproved(fullPath, 'executeBash', approvedPaths)
    }

    /**
     * True when an approval can allow the cwd for later commands: it is not a credential or system
     * folder, a hidden folder or a folder in one, the home folder or a folder above it, a folder for
     * application settings in the home folder (Library, AppData\Roaming), or a file system root
     */
    private static async canAllowCwd(cwd: string, canonicalCwd: string): Promise<boolean> {
        if (
            needsExactApproval(cwd) ||
            needsExactApproval(canonicalCwd) ||
            parse(canonicalCwd).root === canonicalCwd ||
            canonicalCwd.split(/[\\/]/).some(segment => segment.startsWith('.'))
        ) {
            return false
        }
        const isSameOrInside = (folder: string) =>
            isSamePath(canonicalCwd, folder) || workspaceUtils.isParentFolder(folder, canonicalCwd)
        const home = homedir()
        const canonicalHome = await resolveSymlinkAwarePath(home).catch(() => home)
        return [home, canonicalHome].every(
            homeFolder =>
                !isSamePath(canonicalCwd, homeFolder) &&
                !workspaceUtils.isParentFolder(canonicalCwd, homeFolder) &&
                !isSameOrInside(join(homeFolder, 'Library')) &&
                !isSameOrInside(join(homeFolder, 'AppData', 'Roaming'))
        )
    }

    /** True for a file that shares its data with another name on disk (a hard link) */
    private static hasOtherNames(filePath: string): boolean {
        try {
            const stats = statSync(filePath, { throwIfNoEntry: false })
            return stats !== undefined && stats.isFile() && stats.nlink > 1
        } catch {
            return false
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

    /**
     * Detects bare relative path arguments that {@link looksLikePath} does not,
     * for example "notes.txt" or "sub/notes.txt". Without this, such arguments
     * skip the workspace-boundary and credential checks entirely.
     *
     * To avoid forcing harmless command flags and plain-text arguments
     * out-of-workspace, an argument is treated as a path ONLY when a cwd is
     * available to resolve it against, it is not a flag, and one of:
     *   - it contains a path separator ("sub/notes.txt"), or
     *   - it has a file extension ("notes.txt"), or
     *   - a real filesystem entry exists at cwd/arg (including a dangling
     *     symlink, detected with lstat rather than stat).
     *
     * A bare relative name resolves inside cwd, so an in-workspace file is not
     * flagged as out-of-workspace. The check exists to catch a bare name that
     * is a symlink escaping the workspace, or that targets a credential file.
     */
    private looksLikeRelativePath(arg: string, cwd?: string): boolean {
        // Without a cwd there is no base to resolve a relative argument against,
        // so keep the previous behavior and do not treat it as a path.
        if (!cwd || arg.length === 0 || arg.startsWith('-')) {
            return false
        }

        // A path separator or a file extension is a strong path signal on its own.
        if (arg.includes('/') || (IS_WINDOWS_PLATFORM && arg.includes('\\'))) {
            return true
        }
        if (extname(arg).length > 1) {
            return true
        }

        // Otherwise, only treat it as a path when a real filesystem entry exists
        // at cwd/arg. lstat (not stat) is used so a dangling symlink still counts,
        // while plain-text tokens and command names that do not exist do not.
        try {
            lstatSync(resolve(cwd, arg))
            return true
        } catch {
            return false
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

                // A command stopped by a signal has no exit code, which is not a success
                const exitStatus = result.signal !== undefined ? -1 : (result.exitCode ?? -1)
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

    private static async resolveWindowsCommand(logger: Logging, cmd: string): Promise<void> {
        // 1. Check for external command or alias
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

        // 2. Check for built-in command
        try {
            const helpProc = new processUtils.ChildProcess(logger, 'cmd.exe', ['/c', 'help', cmd], {
                collect: true,
                waitForStreams: true,
            })
            const result = await helpProc.run()
            const output = result.stdout.trim()

            if (output && !output.includes('This command is not supported by the help utility')) {
                return
            }
        } catch (err) {
            logger.debug(`'help ${cmd}' failed: ${(err as Error).message}`)
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
        await writer.write(shellCommandBlock(command))
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
