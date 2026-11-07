// Beam-to-IDE: which plan steps of a beamed repo the language server applies locally, and which files of the beamed
// solution it tracks as the customer's (the checkpoints/source-files.json manifest).
import * as fs from 'fs'
import * as path from 'path'

/** The Local Build Verification plan step. Its rounds reach a beamed repo through the step-HITL diff path. */
export const LOCAL_BUILD_VERIFICATION_STEP_NAME = 'Local Build Verification'

/** The most files a beamed repo's manifest lists. */
export const BEAM_MANIFEST_MAX_FILES = 50_000

// Build output, VCS and IDE folders. NuGet's packages folder is checked separately (isNuGetPackagesFolder).
const SKIPPED_FOLDERS = new Set(['bin', 'obj', '.git', '.vs', 'node_modules'])

export interface PlanNode {
    StepId?: string
    StepName?: string
    Children?: PlanNode[]
}

/**
 * The beamed repo's steps whose completed diffs are applied locally: those in `scope` (the repo card's subtree) under
 * the card, so not the card's own step(s), whose artifacts are beam bookkeeping (the transformed bundle, beam-status)
 * rather than diffs, and not Local Build Verification steps or the steps under them.
 */
export function beamApplyStepIds(root: PlanNode, scope: ReadonlySet<string>): Set<string> {
    const ids = new Set<string>()
    const walk = (step: PlanNode, parentInScope: boolean, inLbv: boolean) => {
        const inScope = !!step.StepId && scope.has(step.StepId)
        const lbv = inLbv || step.StepName === LOCAL_BUILD_VERIFICATION_STEP_NAME
        if (inScope && parentInScope && !lbv) {
            ids.add(step.StepId!)
        }
        for (const child of step.Children || []) {
            walk(child, inScope, lbv)
        }
    }
    for (const child of root.Children || []) {
        walk(child, false, false)
    }
    return ids
}

/**
 * The files under a beamed solution's root, for its customer-changes manifest: without build output, VCS and IDE
 * folders, `workspaceFolder` (artifactWorkspace) and a NuGet packages folder, and at most `maxFiles`. Symbolic links
 * aren't followed.
 */
export async function listBeamRepoFiles(
    solutionRootPath: string,
    workspaceFolder: string,
    maxFiles: number = BEAM_MANIFEST_MAX_FILES
): Promise<string[]> {
    const files: string[] = []
    const skipped = new Set([...SKIPPED_FOLDERS, workspaceFolder.toLowerCase()])
    const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
            if (files.length >= maxFiles) {
                return
            }
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) {
                const name = entry.name.toLowerCase()
                if (!skipped.has(name) && !(name === 'packages' && (await isNuGetPackagesFolder(full)))) {
                    await walk(full)
                }
            } else if (entry.isFile()) {
                files.push(full)
            }
        }
    }
    await walk(solutionRootPath)
    return files
}

// packages.config restores to packages/<Id>.<Version>/<Id>.<Version>.nupkg; a source folder named packages has none.
async function isNuGetPackagesFolder(dir: string): Promise<boolean> {
    try {
        for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                const inner = await fs.promises.readdir(path.join(dir, entry.name))
                if (inner.some(name => name.toLowerCase().endsWith('.nupkg'))) {
                    return true
                }
            }
        }
    } catch {
        // unreadable: treat it as source, so it's walked and its own errors surface there
    }
    return false
}
