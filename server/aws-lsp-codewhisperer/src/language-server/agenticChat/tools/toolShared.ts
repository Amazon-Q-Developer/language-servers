import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { workspaceUtils } from '@aws/lsp-core'
import { getWorkspaceFolderPaths } from '@aws/lsp-core/out/util/workspaceUtils'
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
}

export async function validatePath(path: string, exists: (p: string) => Promise<boolean>) {
    if (!path || path.trim().length === 0) {
        throw new Error('Path cannot be empty.')
    }
    const pathExists = await exists(path)
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
    const normalizedFilePath = filePath.replace(/\\\\/g, '/')

    // Check if the exact path is approved for this tool
    if (toolPaths.has(filePath) || toolPaths.has(normalizedFilePath)) {
        return true
    }

    // Get the root directory for traversal limits
    const rootDir = path.parse(filePath).root.replace(/\\\\/g, '/')

    // Check if any approved path is a parent of the file path using isParentFolder
    for (const approvedPath of toolPaths) {
        const normalizedApprovedPath = approvedPath.replace(/\\\\/g, '/')

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
 * @returns CommandValidation object with requiresAcceptance flag
 */
export async function requiresPathAcceptance(
    inputPath: string,
    toolName: string,
    workspace: Features['workspace'],
    logging: Features['logging'],
    approvedPaths?: Map<string, Set<string>>
): Promise<CommandValidation> {
    try {
        // Canonicalize the path in a symlink-aware way before the
        // workspace-boundary check. This resolves symlinks at every segment,
        // including a symlink at the leaf whose target does not exist yet
        // (a "dangling" symlink). A string-only resolve, or an fs.realpath
        // that silently falls back to the literal link name when the target
        // is missing, would treat such a link as in-workspace based on its
        // name alone even though a write or read through it would land
        // outside the workspace.
        const canonicalPath = await resolveSymlinkAwarePath(inputPath)

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

    return sensitivePatterns.some(pattern => pattern.test(filePath))
}
