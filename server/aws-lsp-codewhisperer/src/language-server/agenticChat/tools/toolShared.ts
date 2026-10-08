import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { workspaceUtils } from '@aws/lsp-core'
import { getWorkspaceFolderPaths } from '@aws/lsp-core/out/util/workspaceUtils'
import { sanitize } from '@aws/lsp-core/out/util/path'
import * as fs from 'fs'
import * as path from 'path'
import { CommandCategory } from './executeBash'

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
 * points outside the workspace. A `visited` set bounds symlink-cycle
 * traversal.
 */
export async function resolveSymlinkAwarePath(inputPath: string): Promise<string> {
    let current = path.resolve(inputPath)
    const visited = new Set<string>()

    // eslint-disable-next-line no-constant-condition
    while (true) {
        let stats: fs.Stats
        try {
            stats = await fs.promises.lstat(current)
        } catch {
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
                // Cyclic symlink: stop resolving and return what we have.
                return current
            }
            visited.add(current)
            const linkTarget = await fs.promises.readlink(current)
            current = path.resolve(path.dirname(current), linkTarget)
            continue
        }

        // `current` exists and is not a symlink: canonicalize it, which also
        // resolves any symlinked ancestor directories.
        try {
            return await fs.promises.realpath(current)
        } catch {
            return current
        }
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

export interface PathAcceptanceOptions {
    /**
     * Require approval for an in-workspace path that resolves to a file with
     * more than one hard link, because the file's other names may be outside
     * the workspace. Set to 'modify' by tools that write the file in place and
     * 'read' by tools that return its contents.
     */
    flagMultiplyLinkedFiles?: FileAccessKind
}

interface Output<Kind, Content> {
    kind: Kind
    content: Content
    success?: boolean
}

export interface InvokeOutput {
    output: Output<'text', string> | Output<'json', object>
}

export interface CommandValidation {
    requiresAcceptance: boolean
    warning?: string
    commandCategory?: CommandCategory
    /**
     * Why acceptance is required, when the reason is not simply that the path
     * lies outside the workspace. The confirmation prompt uses this to describe
     * the right situation: a multiply linked path is inside the workspace, so
     * the usual "outside of your workspace" wording would be wrong.
     */
    acceptanceReason?: 'multiplyLinkedFile'
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
    const normalizedFilePath = filePath.replace(/\\/g, '/')

    // Check if the exact path is approved for this tool
    if (toolPaths.has(filePath) || toolPaths.has(normalizedFilePath)) {
        return true
    }

    // Get the root directory for traversal limits
    const rootDir = path.parse(filePath).root.replace(/\\\\/g, '/')

    // Check if any approved path is a parent of the file path using isParentFolder
    for (const approvedPath of toolPaths) {
        const normalizedApprovedPath = approvedPath.replace(/\\/g, '/')

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
        // Canonicalize in a symlink-aware way before the workspace-boundary
        // check: a link whose name sits inside the workspace can point outside
        // it, including when the target does not exist yet (a dangling link).
        // The I/O tools resolve through the same helper, so the boundary check
        // and the operation derive the path the same way.
        const canonicalPath = await resolveCanonicalPath(inputPath)

        // Then check if the path is already approved for this specific tool
        if (isPathApproved(canonicalPath, toolName, approvedPaths)) {
            return { requiresAcceptance: false }
        }

        const workspaceFolders = getWorkspaceFolderPaths(workspace)
        if (!workspaceFolders || workspaceFolders.length === 0) {
            if (logging) {
                logging.debug('No workspace folders found when checking file acceptance')
            }
            return { requiresAcceptance: true }
        }

        // Check if the canonicalized path is inside the workspace.
        // This is the primary security check — files genuinely inside the workspace
        // are trusted regardless of their filename (e.g. "PasswordService.java",
        // "credentials/auth.ts", or paths under a "/dev/" folder).
        // Workspace folders are canonicalized too so the comparison holds even
        // when the workspace itself lives under a symlinked directory.
        const canonicalWorkspaceFolders = await canonicalizeWorkspaceFolders(workspaceFolders)
        const isInWs = workspaceUtils.isInWorkspace(canonicalWorkspaceFolders, canonicalPath)
        if (isInWs) {
            // Being inside the workspace by path is not sufficient for a file
            // that has more than one name. `lstat` reports a hard link as an
            // ordinary file, so the resolver above cannot follow it and the
            // canonical path is the in-workspace name; the file's other names
            // stay invisible to this check and may be outside the workspace.
            // Reading it returns data that lives under those names too, and
            // modifying it in place changes the contents under all of them.
            if (options?.flagMultiplyLinkedFiles && (await hasAdditionalHardLinks(canonicalPath))) {
                return {
                    requiresAcceptance: true,
                    warning: multiplyLinkedFileWarning(options.flagMultiplyLinkedFiles),
                    acceptanceReason: 'multiplyLinkedFile',
                }
            }
            return { requiresAcceptance: false }
        }

        // For paths OUTSIDE the workspace, check if they target sensitive system
        // locations. We check both the raw input and the resolved path to catch
        // traversal attempts like "/workspace/../../etc/passwd".
        if (isSensitivePath(inputPath) || isSensitivePath(canonicalPath)) {
            return {
                requiresAcceptance: true,
                warning: 'Access to sensitive system files requires explicit approval',
            }
        }

        // Path is outside workspace but not a known sensitive location
        return { requiresAcceptance: true }
    } catch (error) {
        if (logging) {
            logging.error(`Error checking file acceptance: ${error}`)
        }
        // In case of error, safer to require acceptance
        return { requiresAcceptance: true }
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

    const normalizedPath = process.platform === 'win32' ? filePath.replace(/\\/g, '/') : filePath
    return sensitivePatterns.some(pattern => pattern.test(normalizedPath))
}
