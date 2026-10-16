import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { workspaceUtils } from '@aws/lsp-core'
import { getWorkspaceFolderPaths } from '@aws/lsp-core/out/util/workspaceUtils'
import { sanitize, getUserHomeDir } from '@aws/lsp-core/out/util/path'
import * as fs from 'fs'
import * as path from 'path'
import { CommandCategory } from './executeBash'
import { EmptyPathError } from '../errors'
import { captureCheckedTarget, CheckedTarget } from './checkedFileIo'
import { FileUpdateOutcome } from '@aws/language-server-runtimes/server-interface'

const resolvedTargets = new WeakMap<object, { toolName: string; targets: readonly CheckedTarget[] }>()
const fileUpdates = new WeakMap<object, FileUpdateOutcome>()

/** Bind immutable checked targets to the exact object passed through the in-process runtime. */
export function withResolvedTargets<T extends object>(
    input: T,
    toolName: string,
    targets: readonly CheckedTarget[]
): T {
    const executionInput = { ...input }
    resolvedTargets.set(executionInput, {
        toolName,
        targets: Object.freeze(targets.map(target => Object.freeze({ ...target }))),
    })
    return executionInput
}

export function recordFileUpdate(input: object, outcome: FileUpdateOutcome | undefined): void {
    if (outcome) fileUpdates.set(input, outcome)
}

export function getFileUpdate(input: object): FileUpdateOutcome | undefined {
    return fileUpdates.get(input)
}

export function discardResolvedTargets(input: object): void {
    resolvedTargets.delete(input)
    fileUpdates.delete(input)
}

/** Consume the checked targets once; model fields and copied inputs cannot grant approval. */
export function requireResolvedTargets(
    input: object,
    toolName: string,
    expectedCount: number
): readonly CheckedTarget[] {
    const entry = resolvedTargets.get(input)
    if (!entry || entry.toolName !== toolName) {
        throw new Error('No checked targets for this operation.')
    }
    resolvedTargets.delete(input)
    if (expectedCount < 1 || entry.targets.length !== expectedCount) {
        throw new Error('Checked targets do not match this operation.')
    }
    return entry.targets
}

export function requireResolvedTarget(input: object, toolName: string): CheckedTarget {
    return requireResolvedTargets(input, toolName, 1)[0]
}

function errnoError(code: string, message: string): NodeJS.ErrnoException {
    return Object.assign(new Error(message), { code })
}

/**
 * Resolve a path to its canonical on-disk location in a symlink-aware way,
 * including when the final path segment is a symlink whose target does not
 * yet exist (a "dangling" symlink), or when an ancestor directory is a
 * symlink.
 *
 * Unlike fs.realpath, this does not throw for paths that do not exist yet.
 * It follows a symlink at the leaf (even a dangling one), resolves the
 * longest existing ancestor through the filesystem, then re-appends any
 * remaining not-yet-created segments. The returned path therefore reflects
 * where a subsequent read or write would actually land, so a workspace
 * boundary check cannot be fooled by an in-workspace link name whose target
 * points outside the workspace.
 *
 * Any other failure is propagated rather than recovered from, so a caller can
 * always distinguish a resolved location from one that could not be resolved.
 */
export async function resolveSymlinkAwarePath(inputPath: string): Promise<string> {
    let current = path.resolve(inputPath)
    const visited = new Set<string>()

    // eslint-disable-next-line no-constant-condition
    while (true) {
        let stats: fs.Stats
        try {
            stats = await fs.promises.lstat(current)
        } catch (error) {
            // Only ENOENT means "not created yet"; other errors are propagated.
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error
            }
            // `current` does not exist even as a symlink: resolve its existing
            // ancestor chain (which may traverse symlinked directories) and
            // re-append the final, not-yet-created segment.
            const parent = path.dirname(current)
            if (parent === current) {
                return current
            }
            const resolvedParent = await resolveSymlinkAwarePath(parent)
            return path.join(resolvedParent, path.basename(current))
        }

        if (stats.isSymbolicLink()) {
            if (visited.has(current)) {
                throw errnoError('ELOOP', `Too many levels of symbolic links: ${inputPath}`)
            }
            visited.add(current)
            const linkTarget = await fs.promises.readlink(current)
            current = path.resolve(path.dirname(current), linkTarget)
            continue
        }

        // `current` exists and is not a symlink: canonicalize it, which also
        // resolves any symlinked ancestor directories.
        return await fs.promises.realpath(current)
    }
}

/**
 * Resolve an input path to the canonical on-disk location a read, write, or
 * list should act on: `sanitize()` (expand `~`, make absolute) followed by
 * `resolveSymlinkAwarePath()` (follow symlinks at every segment). Tools resolve
 * through this helper so the workspace-boundary check and the operation itself
 * derive the path the same way.
 */
export async function resolveCanonicalPath(inputPath: string): Promise<string> {
    return resolveSymlinkAwarePath(sanitize(inputPath))
}

/**
 * Canonicalize workspace folder paths through the filesystem so boundary
 * comparisons stay accurate even when a workspace lives under a symlinked
 * directory (for example, macOS exposes temp directories under /var and /tmp
 * which are symlinks into /private). Falls back to a lexical resolve for any
 * folder that cannot be resolved.
 */
export async function canonicalizeWorkspaceFolders(workspaceFolderPaths: string[]): Promise<string[]> {
    return Promise.all(
        workspaceFolderPaths.map(async folder => {
            try {
                return await fs.promises.realpath(folder)
            } catch {
                return path.resolve(folder)
            }
        })
    )
}

/**
 * True when `canonicalPath` is a regular file reachable under more than one
 * name. The other names are not discoverable from this path — an inode has no
 * location and there is no reverse inode-to-paths lookup — so a boundary check
 * cannot prove they are inside the workspace: reading the path exposes data that
 * also lives elsewhere, and an in-place write changes it under every name.
 *
 * Directories are excluded because their link count is always above one ('.',
 * '..', and each subdirectory).
 */
export async function hasAdditionalHardLinks(canonicalPath: string): Promise<boolean> {
    try {
        const stats = await fs.promises.stat(canonicalPath)
        return stats.isFile() && stats.nlink > 1
    } catch {
        // Nothing on disk yet (for example a create), so no existing data is shared.
        return false
    }
}

/** How a tool accesses the path, which decides the wording of the prompt. */
export type FileAccessKind = 'read' | 'modify'

export const multiplyLinkedFileWarning = (access: FileAccessKind): string =>
    access === 'read'
        ? 'This file is also reachable under another name on disk, which may be outside the ' +
          'workspace. Its contents are shared with that name.'
        : 'This file is also reachable under another name on disk, which may be outside the ' +
          'workspace. Writing to it changes the contents under every name.'

export const configFileWarning = 'This file is part of the Amazon Q, editor, or Git configuration.'

// Folders inside a workspace that hold Amazon Q, editor, or Git configuration
const configFolderNames = new Set(['.amazonq', '.vscode', '.git'])

// How many folder levels to search for links inside each configuration folder. Git keeps the hooks
// of submodules three levels down (modules/<name>/hooks); its object and log folders are large and
// hold no configuration.
const linkSearchDepth: Record<string, number> = { '.amazonq': 8, '.vscode': 8, '.git': 3 }
const skippedGitFolders = new Set(['objects', 'lfs', 'logs'])

// The most entries to read when searching one configuration folder for links
const maxLinkSearchEntries = 2000
// Configuration folders whose link search stopped at that limit, logged once each
const truncatedLinkSearches = new Set<string>()

// Rules file that Amazon Q loads from the root of each workspace folder
const rootRulesFileName = 'AmazonQ.md'

/** The path relative to `folder` when `filePath` is inside it, otherwise undefined */
function pathInside(folder: string, filePath: string): string | undefined {
    // Case-insensitive where the file system usually is, as in isSamePath
    const comparable = (value: string) =>
        process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value
    const relativePath = path.relative(comparable(folder), comparable(filePath))
    if (
        !relativePath ||
        relativePath === '..' ||
        relativePath.startsWith('..' + path.sep) ||
        path.isAbsolute(relativePath)
    ) {
        return undefined
    }
    return relativePath
}

/** The git directory that a .git file names on its `gitdir:` line */
async function resolveGitDirFile(gitFile: string): Promise<string | undefined> {
    try {
        const handle = await fs.promises.open(gitFile, 'r')
        try {
            const buffer = Buffer.alloc(4096)
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
            const firstLine = buffer.toString('utf8', 0, bytesRead).split(/\r?\n/, 1)[0]
            const gitDir = /^gitdir:(.*)$/.exec(firstLine)?.[1].trim()
            return gitDir ? await resolveSymlinkAwarePath(path.resolve(path.dirname(gitFile), gitDir)) : undefined
        } finally {
            await handle.close()
        }
    } catch {
        return undefined
    }
}

/**
 * Where a configuration folder entry resolves to when it is a link, or the git directory that a
 * .git file names. Undefined for an ordinary folder or a missing entry.
 */
async function resolveConfigLink(entryPath: string): Promise<string | undefined> {
    let stats: fs.Stats
    try {
        stats = await fs.promises.lstat(entryPath)
    } catch {
        return undefined
    }
    if (stats.isSymbolicLink()) {
        return resolveSymlinkAwarePath(entryPath)
    }
    return stats.isFile() && path.basename(entryPath) === '.git' ? resolveGitDirFile(entryPath) : undefined
}

/**
 * Where the links inside a configuration folder resolve to, down to `depth` folder levels. The search
 * goes breadth first, so that a large folder cannot hide the links nearest the top.
 */
async function linkedLocationsInside(
    folder: string,
    depth: number,
    isGitFolder: boolean,
    logging?: Features['logging']
): Promise<string[]> {
    const links: string[] = []
    let remainingEntries = maxLinkSearchEntries
    let dirs = [folder]
    search: for (let level = 0; dirs.length > 0 && level <= depth; level++) {
        const nextDirs: string[] = []
        for (const dir of dirs) {
            let entries: fs.Dirent[]
            try {
                entries = await fs.promises.readdir(dir, { withFileTypes: true })
            } catch {
                continue
            }
            for (const entry of entries) {
                if (--remainingEntries < 0) {
                    if (!truncatedLinkSearches.has(folder)) {
                        truncatedLinkSearches.add(folder)
                        logging?.warn(`Searched only the first ${maxLinkSearchEntries} entries of ${folder} for links`)
                    }
                    break search
                }
                const entryPath = path.join(dir, entry.name)
                if (entry.isSymbolicLink()) {
                    links.push(entryPath)
                } else if (
                    entry.isDirectory() &&
                    level < depth &&
                    !(isGitFolder && skippedGitFolders.has(entry.name))
                ) {
                    nextDirs.push(entryPath)
                }
            }
        }
        dirs = nextDirs
    }
    return Promise.all(links.map(link => resolveSymlinkAwarePath(link)))
}

/** True for a Git directory: a folder with a HEAD file and objects and refs folders */
async function isGitDirectory(dir: string): Promise<boolean> {
    const [head, objects, refs] = await Promise.all(
        ['HEAD', 'objects', 'refs'].map(name => fs.promises.stat(path.join(dir, name)).catch(() => undefined))
    )
    return !!head?.isFile() && !!objects?.isDirectory() && !!refs?.isDirectory()
}

/**
 * Where the configuration folders of each workspace folder resolve to, including the git directory
 * a .git file names and the targets of links inside the folders, and the global configuration
 * folder and the targets of links inside it.
 */
async function configFolderLocations(
    canonicalWorkspaceFolders: string[],
    logging?: Features['logging']
): Promise<string[]> {
    const locations = await Promise.all([
        ...canonicalWorkspaceFolders.flatMap(folder =>
            [...configFolderNames].map(async name => {
                const folderPath = path.join(folder, name)
                const [location, linked] = await Promise.all([
                    resolveSymlinkAwarePath(folderPath),
                    resolveConfigLink(folderPath),
                ])
                const searched = linked ?? location
                return [
                    location,
                    searched,
                    ...(await linkedLocationsInside(searched, linkSearchDepth[name], name === '.git', logging)),
                ]
            })
        ),
        resolveSymlinkAwarePath(path.join(getUserHomeDir(), '.aws', 'amazonq')).then(async location => [
            location,
            ...(await linkedLocationsInside(location, linkSearchDepth['.amazonq'], false, logging)),
        ]),
    ])
    return [...new Set(locations.flat())]
}

/**
 * Configuration locations in the folders above `canonicalPath`, inside the workspace: where
 * configuration folder links or .git files there resolve to, and any of those folders that is
 * itself a Git directory.
 */
async function configLocationsAbove(canonicalPath: string, canonicalWorkspaceFolders: string[]): Promise<string[]> {
    const folders: string[] = []
    for (
        let dir = path.dirname(canonicalPath);
        dir !== path.dirname(dir) && canonicalWorkspaceFolders.some(folder => pathInside(folder, dir) !== undefined);
        dir = path.dirname(dir)
    ) {
        folders.push(dir)
    }
    const locations = await Promise.all([
        ...folders.flatMap(dir => [...configFolderNames].map(name => resolveConfigLink(path.join(dir, name)))),
        ...folders.map(async dir => ((await isGitDirectory(dir)) ? dir : undefined)),
    ])
    return locations.filter((location): location is string => location !== undefined)
}

/**
 * True when `canonicalPath` is inside a workspace folder and is Amazon Q, editor, or Git configuration:
 * - in a configuration folder there, by the name of a folder on the path, or because it is where a
 *   top-level configuration folder, a link inside one, a configuration folder link in a folder above
 *   the path, or the git directory named by a .git file resolves to
 * - in a Git directory, such as a bare repository or the Git directory of a nested repository
 * - the AmazonQ.md rules file at the root of a workspace folder, or the file it links to
 * - in the global Amazon Q configuration folder (~/.aws/amazonq), or where a link inside it resolves
 *   to, when the workspace includes it
 */
async function isInConfigFolder(
    inputPath: string,
    canonicalPath: string,
    workspaceFolders: string[],
    canonicalWorkspaceFolders: string[],
    logging?: Features['logging']
): Promise<boolean> {
    // Paths outside the workspace keep the outside-workspace prompt
    if (!workspaceUtils.isInWorkspace(canonicalWorkspaceFolders, canonicalPath)) {
        return false
    }

    const hasConfigFolderName = (folder: string, filePath: string) =>
        pathInside(folder, filePath)
            ?.split(/[\\/]/)
            .some(segment => configFolderNames.has(segment.toLowerCase())) ?? false
    const inputFullPath = path.resolve(sanitize(inputPath))
    const folders = [...new Set([...workspaceFolders, ...canonicalWorkspaceFolders])]
    if (
        folders.some(folder => hasConfigFolderName(folder, canonicalPath) || hasConfigFolderName(folder, inputFullPath))
    ) {
        return true
    }

    const [locations, linkedAbove, rootRulesFiles] = await Promise.all([
        configFolderLocations(canonicalWorkspaceFolders, logging),
        configLocationsAbove(canonicalPath, canonicalWorkspaceFolders),
        Promise.all(
            canonicalWorkspaceFolders.map(folder => resolveSymlinkAwarePath(path.join(folder, rootRulesFileName)))
        ),
    ])
    return (
        [...locations, ...linkedAbove].some(
            location => isSamePath(location, canonicalPath) || pathInside(location, canonicalPath) !== undefined
        ) || rootRulesFiles.some(rulesFile => isSamePath(rulesFile, canonicalPath))
    )
}

export interface PathAcceptanceOptions {
    /**
     * Require approval for an in-workspace path that resolves to a file with
     * more than one hard link, because the file's other names may be outside
     * the workspace. Set to 'modify' by tools that write the file in place and
     * 'read' by tools that return its contents.
     */
    flagMultiplyLinkedFiles?: FileAccessKind
    /**
     * Require approval for Amazon Q, editor, or Git configuration inside the workspace (see
     * isInConfigFolder), unless that exact path is approved. Set by tools that modify files.
     */
    flagConfigFiles?: boolean
}

interface Output<Kind, Content> {
    kind: Kind
    content: Content
    success?: boolean
}

export interface InvokeOutput {
    output: Output<'text', string> | Output<'json', object>
    /** Internal bookkeeping removed by the tool server before returning model output. */
    fileUpdate?: FileUpdateOutcome
}

export interface CommandValidation {
    requiresAcceptance: boolean
    warning?: string
    commandCategory?: CommandCategory
    /**
     * Why acceptance is required, when the reason is not simply that the path
     * lies outside the workspace. The confirmation prompt uses this to describe
     * the right situation: a multiply linked path or a configuration file is
     * inside the workspace, so the usual "outside of your workspace" wording
     * would be wrong.
     */
    acceptanceReason?: 'multiplyLinkedFile' | 'configFile'
    /**
     * The canonical on-disk paths the check evaluated, in input order. Callers
     * that go on to act on these paths must use exactly these values rather
     * than resolving the input again, so the operation lands where the check
     * looked.
     */
    canonicalPaths?: string[]
    checkedTargets?: readonly CheckedTarget[]
    validationError?: Error
}

export async function validatePath(path: string, exists: (p: string) => Promise<boolean>) {
    if (!path || path.trim().length === 0) {
        throw new Error('Path cannot be empty.')
    }
    // Check the location the tool will actually operate on. Checking the raw
    // input instead would resolve `~` relative to the process working
    // directory, while the approval check and the operation expand it to the
    // home directory, so validation could pass or fail on a different file.
    const pathExists = await exists(await resolveCanonicalPath(path))
    if (!pathExists) {
        throw new Error(`Path "${path}" does not exist or cannot be accessed.`)
    }
}

export class ToolApprovalException extends Error {
    public override readonly message: string
    public readonly shouldShowMessage: boolean

    constructor(message: string = 'Tool execution invalidated', shouldShowMessage: boolean = true) {
        super(message)
        this.message = message
        this.shouldShowMessage = shouldShowMessage
    }
}
export interface ExplanatoryParams {
    explanation?: string
}

export enum OutputKind {
    Text = 'text',
    Json = 'json',
}

/**
 * Path separators written the way `ChatSessionService.addApprovedPath` stores
 * them, so the approval check and the recorded form agree. Without this, a
 * Windows path recorded as `C:/project/file.ts` is never recognised when it
 * comes back as `C:\project\file.ts`, and the user is asked about the same
 * file on every call.
 */
function normalizePathSeparators(filePath: string): string {
    return filePath.replace(/\\/g, '/')
}

/**
 * Whether two paths name the same file. `isParentFolder` is a strict ancestor
 * check — it reports two equal paths as unrelated — so identity is compared
 * separately. Case is ignored on the platforms whose filesystems ignore it,
 * which is the precedent `isParentFolder` already follows, and a trailing
 * separator does not change identity.
 */
export function isSamePath(left: string, right: string): boolean {
    const comparable = (value: string) => {
        const normalized = path.normalize(value).replace(/[\\/]+$/, '')
        return process.platform === 'win32' || process.platform === 'darwin' ? normalized.toLowerCase() : normalized
    }

    return comparable(left) === comparable(right)
}

/**
 * Checks if this exact path, rather than one of its parent directories, has been approved for a specific tool
 */
export function isPathExactlyApproved(
    filePath: string,
    toolName: string,
    approvedPaths?: Map<string, Set<string>>
): boolean {
    const toolPaths = approvedPaths?.get(toolName)
    if (!toolPaths || toolPaths.size === 0) {
        return false
    }

    const normalizedFilePath = normalizePathSeparators(filePath)
    return [...toolPaths].some(approvedPath => isSamePath(normalizePathSeparators(approvedPath), normalizedFilePath))
}

/**
 * Checks if a path has already been approved for a specific tool
 * @param path The path to check
 * @param toolName The name of the tool requesting access
 * @param approvedPaths Map of tool names to their approved paths
 * @returns True if the path or any parent directory has been approved for this tool
 */
export function isPathApproved(filePath: string, toolName: string, approvedPaths?: Map<string, Set<string>>): boolean {
    if (!approvedPaths || approvedPaths.size === 0) {
        return false
    }

    const toolPaths = approvedPaths.get(toolName)
    if (!toolPaths || toolPaths.size === 0) {
        return false
    }

    // Normalize path separators for consistent comparison
    const normalizedFilePath = normalizePathSeparators(filePath)

    // Check if the exact path is approved for this tool
    if (toolPaths.has(filePath) || toolPaths.has(normalizedFilePath)) {
        return true
    }

    // Check if any approved path is the file itself or one of its parents
    for (const approvedPath of toolPaths) {
        const normalizedApprovedPath = normalizePathSeparators(approvedPath)

        // The approval may be for this very file, which isParentFolder does
        // not report, and the two forms may differ only in case or a trailing
        // separator.
        if (isSamePath(normalizedApprovedPath, normalizedFilePath)) {
            return true
        }

        // Check using the isParentFolder utility
        if (workspaceUtils.isParentFolder(normalizedApprovedPath, normalizedFilePath)) {
            return true
        }

        // Also check with trailing slash variations to ensure consistency
        if (normalizedApprovedPath.endsWith('/')) {
            // Try without trailing slash
            const withoutSlash = normalizedApprovedPath.slice(0, -1)
            if (workspaceUtils.isParentFolder(withoutSlash, normalizedFilePath)) {
                return true
            }
        } else {
            // Try with trailing slash
            const withSlash = normalizedApprovedPath + '/'
            if (workspaceUtils.isParentFolder(withSlash, normalizedFilePath)) {
                return true
            }
        }
    }

    return false
}

/**
 * Shared implementation to check if a file path requires user acceptance.
 * Returns true when the file is not resolvable within our workspace (i.e., is outside of our workspace).
 * If the path has already been approved (in approvedPaths), returns false.
 * With flagConfigFiles, a configuration file in the workspace returns false only when that exact path has been approved.
 *
 * @param path The file path to check
 * @param toolName The name of the tool requesting access
 * @param workspace The workspace feature to get workspace folders
 * @param logging Optional logging feature for better error reporting
 * @param approvedPaths Optional map of tool names to their approved paths
 * @param options Optional additional checks; see PathAcceptanceOptions
 * @returns CommandValidation object with requiresAcceptance flag
 */
export async function requiresPathAcceptance(
    inputPath: string,
    toolName: string,
    workspace: Features['workspace'],
    logging: Features['logging'],
    approvedPaths?: Map<string, Set<string>>,
    options?: PathAcceptanceOptions
): Promise<CommandValidation> {
    try {
        if (typeof inputPath !== 'string' || !inputPath.trim()) {
            throw new EmptyPathError()
        }
        // Canonicalize in a symlink-aware way before the workspace-boundary
        // check: a link whose name sits inside the workspace can point outside
        // it, including when the target does not exist yet (a dangling link).
        // The resolved path is returned in `canonicalPaths` so the caller acts
        // on the exact value the check evaluated instead of resolving again.
        const canonicalPath = await resolveCanonicalPath(inputPath)
        const target: CheckedTarget = options?.flagMultiplyLinkedFiles
            ? await captureCheckedTarget(workspace, canonicalPath)
            : Object.freeze({ path: canonicalPath, state: 'unverified' })
        const checked = { canonicalPaths: [canonicalPath], checkedTargets: Object.freeze([target]) }
        const multiplyLinked = async () =>
            target.state === 'existing'
                ? BigInt(target.linkCount) > 1n
                : target.state === 'unverified' && options?.flagMultiplyLinkedFiles
                  ? await hasAdditionalHardLinks(canonicalPath)
                  : false

        if (options?.flagConfigFiles && !isPathExactlyApproved(canonicalPath, toolName, approvedPaths)) {
            const folders = getWorkspaceFolderPaths(workspace) ?? []
            const canonicalFolders = await canonicalizeWorkspaceFolders(folders)
            if (await isInConfigFolder(inputPath, canonicalPath, folders, canonicalFolders, logging)) {
                // A configuration file can also share its data with another name on disk
                const sharedFileWarning =
                    options.flagMultiplyLinkedFiles && (await multiplyLinked())
                        ? multiplyLinkedFileWarning(options.flagMultiplyLinkedFiles)
                        : undefined
                return {
                    requiresAcceptance: true,
                    warning: sharedFileWarning ? `${configFileWarning}\n\n${sharedFileWarning}` : configFileWarning,
                    acceptanceReason: 'configFile',
                    ...checked,
                }
            }
        }

        // Then check if the path is already approved for this specific tool
        if (isPathApproved(canonicalPath, toolName, approvedPaths)) {
            return { requiresAcceptance: false, ...checked }
        }

        const workspaceFolders = getWorkspaceFolderPaths(workspace)
        if (!workspaceFolders || workspaceFolders.length === 0) {
            logging?.debug('No workspace folders found when checking file acceptance')
            return { requiresAcceptance: true, ...checked }
        }

        const canonicalWorkspaceFolders = await canonicalizeWorkspaceFolders(workspaceFolders)
        if (workspaceUtils.isInWorkspace(canonicalWorkspaceFolders, canonicalPath)) {
            if (options?.flagMultiplyLinkedFiles && (await multiplyLinked())) {
                return {
                    requiresAcceptance: true,
                    warning: multiplyLinkedFileWarning(options.flagMultiplyLinkedFiles),
                    acceptanceReason: 'multiplyLinkedFile',
                    ...checked,
                }
            }
            return { requiresAcceptance: false, ...checked }
        }

        if (isSensitivePath(inputPath) || isSensitivePath(canonicalPath)) {
            return {
                requiresAcceptance: true,
                warning: 'Access to sensitive system files requires explicit approval',
                ...checked,
            }
        }
        return { requiresAcceptance: true, ...checked }
    } catch (error) {
        if (logging) {
            logging.error(`Error checking file acceptance: ${error}`)
        }
        // In case of error, safer to require acceptance. No canonical path is
        // returned, so a caller that needs one to proceed will refuse.
        return { requiresAcceptance: true, validationError: error instanceof Error ? error : new Error(String(error)) }
    }
}

function isSensitivePath(filePath: string): boolean {
    const sensitivePatterns = [
        /\/\.ssh\//,
        /\/\.aws\//,
        /\/\.env$/,
        /\/\.env\./,
        /password/i,
        /secret/i,
        /credential/i,
        /private.*key/i,
        /\/etc\//,
        /\/proc\//,
        /\/sys\//,
        /\/dev\//,
    ]

    return sensitivePatterns.some(pattern => pattern.test(filePath))
}
