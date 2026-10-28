import { BaseDependencyInfo, Dependency, LanguageDependencyHandler } from './LanguageDependencyHandler'
import * as path from 'path'
import * as fs from 'fs'
import { URI } from 'vscode-uri'
import { WorkspaceFolder } from '@aws/language-server-runtimes/server-interface'
import { DependencyWatcher } from './DependencyWatcher'
import { resolvePathInside } from '../../util'

interface JSTSDependencyInfo extends BaseDependencyInfo {
    packageJsonPath: string
    nodeModulesPath: string
}

/**
 * Whether a package.json dependency key is an npm package name ("name" or "@scope/name"), so joining it
 * to node_modules cannot reach a different directory.
 */
export function isPackageName(name: string): boolean {
    const segments = name.split('/')
    if (segments.length > 2 || (segments.length === 2 && !segments[0].startsWith('@'))) {
        return false
    }
    return segments.every(
        segment => /^[^\\:]+$/.test(segment) && segment !== '.' && segment !== '..' && segment !== '@'
    )
}

/*
 * JSTS Dependency Handler
 *
 * This handler depends on package.json and /node_modules to discover dependency locations
 */
export class JSTSDependencyHandler extends LanguageDependencyHandler<JSTSDependencyInfo> {
    private jstsDependencyInfos: JSTSDependencyInfo[] = []

    /*
     * It will return a boolean indicating whether it finds any dependency info.
     * The JSTSDependencyInfo object contains the following properties:
     * - pkgDir: the package directory
     * - packageJsonPath: the path to the package.json file
     * - nodeModulesPath: the path to /node_modules directory
     */
    discover(currentDir: string, workspaceFolder: WorkspaceFolder): boolean {
        let result: JSTSDependencyInfo | null = null
        const packageJsonPath = path.join(currentDir, 'package.json')
        const nodeModulesPath = path.join(currentDir, 'node_modules')
        if (
            fs.existsSync(packageJsonPath) &&
            fs.existsSync(nodeModulesPath) &&
            fs.statSync(nodeModulesPath).isDirectory()
        ) {
            this.logging.log(`Found package.json and node_modules in ${currentDir}`)
            result = {
                pkgDir: currentDir,
                packageJsonPath: packageJsonPath,
                nodeModulesPath: nodeModulesPath,
                workspaceFolder: workspaceFolder,
            }
            this.jstsDependencyInfos.push(result)
        }
        return result !== null
    }

    /*
     * It will create a dependency map from the package.json file and node_modules
     * The dependency map will contain the following properties:
     * - name: the name of the dependency
     * - version: the version of the dependency
     * - path: the path to the dependency
     */
    initiateDependencyMap(folders: WorkspaceFolder[]): void {
        // Filter out the jstsDependencyInfos that are in the folders
        const jstsDependencyInfoToBeInitiated = this.jstsDependencyInfos.filter(jstsDependencyInfo => {
            return folders.includes(jstsDependencyInfo.workspaceFolder)
        })

        jstsDependencyInfoToBeInitiated.forEach(jstsDependencyInfo => {
            // TODO, check if try catch is necessary here
            try {
                let generatedDependencyMap: Map<string, Dependency> = this.generateDependencyMap(jstsDependencyInfo)
                // If the dependency map doesn't exist, create a new one
                if (!this.dependencyMap.has(jstsDependencyInfo.workspaceFolder)) {
                    this.dependencyMap.set(jstsDependencyInfo.workspaceFolder, new Map<string, Dependency>())
                }
                generatedDependencyMap.forEach((dep, name) => {
                    this.dependencyMap.get(jstsDependencyInfo.workspaceFolder)?.set(name, dep)
                })
                // Log found dependencies
                this.logging.log(
                    `Total Javascript/Typescript dependencies found: ${generatedDependencyMap.size} under ${jstsDependencyInfo.pkgDir}`
                )
            } catch (error) {
                this.logging.warn(`Error parsing dependencies: ${error}`)
            }
        })
    }

    /*
     * First, it will record dependencies with version under node_modules based on package.json
     * Then, it will also record dependencies with version under node_modules which are not declared in package.json
     */
    generateDependencyMap(jstsDependencyInfo: JSTSDependencyInfo): Map<string, Dependency> {
        const dependencyMap = new Map<string, Dependency>()
        let packageJsonPath = jstsDependencyInfo.packageJsonPath
        let nodeModulesPath = jstsDependencyInfo.nodeModulesPath
        // Read and parse package.json
        let packageJsonContent
        let allDependencies = {}
        try {
            packageJsonContent = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))

            // Combine all types of dependencies
            allDependencies = {
                ...(packageJsonContent.dependencies || {}),
                ...(packageJsonContent.devDependencies || {}),
                ...(packageJsonContent.peerDependencies || {}),
            }
        } catch (e) {
            this.logging.warn(`Can't parse package.json skipping `)
        }

        // process each dependency
        for (const [name, declaredVersion] of Object.entries(allDependencies)) {
            if (!isPackageName(name)) {
                this.logging.warn(`Skipping dependency with an invalid package name: ${name}`)
                continue
            }
            // Handle scoped packages (@scope/package) by splitting on '/' for cross-platform compatibility
            const dependencyPath = path.join(nodeModulesPath, ...name.split('/'))
            // Check if dependency exists in node_modules
            if (fs.existsSync(dependencyPath) && this.isInsideWorkspaceFolder(dependencyPath, jstsDependencyInfo)) {
                // Read the actual version from the dependency's package.json
                const depPackageJsonPath = path.join(dependencyPath, 'package.json')
                let actualVersion: string = typeof declaredVersion === 'string' ? declaredVersion : 'unknown'

                if (fs.existsSync(depPackageJsonPath)) {
                    try {
                        const depPackageJson = JSON.parse(fs.readFileSync(depPackageJsonPath, 'utf-8'))
                        actualVersion = depPackageJson.version
                    } catch (e) {
                        this.logging.warn(`Can't parse ${depPackageJsonPath}, skipping`)
                    }
                }

                dependencyMap.set(name, {
                    name,
                    version: actualVersion.toString().replace(/[\^~]/g, ''), // Remove ^ and ~ from version
                    path: dependencyPath,
                    pathInZipOverride: name, // either package or @scope/package
                    size: this.getDirectorySize(dependencyPath),
                    zipped: false,
                })
            }
        }

        // Also check node_modules directory for unlisted dependencies
        if (fs.existsSync(nodeModulesPath)) {
            const nodeModulesContent = fs.readdirSync(nodeModulesPath)
            for (const item of nodeModulesContent) {
                // Skip hidden files and scope directories
                if (item.startsWith('.') || item.startsWith('@')) continue

                const itemPath = path.join(nodeModulesPath, item)
                if (!fs.statSync(itemPath).isDirectory()) continue
                if (!this.isInsideWorkspaceFolder(itemPath, jstsDependencyInfo)) continue

                // If not already in dependencyMap, add it
                if (!dependencyMap.has(item)) {
                    const depPackageJsonPath = path.join(itemPath, 'package.json')
                    if (fs.existsSync(depPackageJsonPath)) {
                        try {
                            const depPackageJson = JSON.parse(fs.readFileSync(depPackageJsonPath, 'utf-8'))
                            dependencyMap.set(item, {
                                name: item,
                                version: depPackageJson.version || 'unknown',
                                path: itemPath,
                                size: this.getDirectorySize(itemPath),
                                zipped: false,
                            })
                        } catch (e) {
                            this.logging.warn(`Can't parse ${depPackageJsonPath}, skipping`)
                        }
                    }
                }
            }
        }
        return dependencyMap
    }

    /*
     * It will setup watchers for the .classpath files.
     * When a change is detected, it will update the dependency map.
     */
    setupWatchers(folders: WorkspaceFolder[]): void {
        // Filter out the jstsDependencyInfos that are in the folders
        const jstsDependencyInfoToBeWatched = this.jstsDependencyInfos.filter(jstsDependencyInfo => {
            return folders.includes(jstsDependencyInfo.workspaceFolder)
        })

        jstsDependencyInfoToBeWatched.forEach((jstsDependencyInfo: JSTSDependencyInfo) => {
            const packageJsonPath = jstsDependencyInfo.packageJsonPath
            if (this.dependencyWatchers.has(packageJsonPath)) {
                return
            }
            this.logging.log(`Setting up Javascript/Typescript dependency watcher for ${packageJsonPath}`)
            try {
                const callBackDependencyUpdate = async (events: string[]) => {
                    this.logging.log(`Change detected in ${packageJsonPath}`)
                    const updatedDependencyMap = this.generateDependencyMap(jstsDependencyInfo)
                    const changedDependencyList = this.compareAndUpdateDependencyMap(
                        jstsDependencyInfo.workspaceFolder,
                        updatedDependencyMap
                    )
                    await this.zipAndUploadDependenciesByChunk(
                        changedDependencyList,
                        jstsDependencyInfo.workspaceFolder
                    )
                }
                const watcher = new DependencyWatcher(
                    packageJsonPath,
                    callBackDependencyUpdate,
                    this.logging,
                    this.DEPENDENCY_WATCHER_EVENT_BATCH_INTERVAL
                )
                this.dependencyWatchers.set(packageJsonPath, watcher)
            } catch (error) {
                this.logging.warn(`Error setting up watcher for ${packageJsonPath}: ${error}`)
            }
        })
    }

    // JS and TS are not using LSP to sync dependencies
    override updateDependencyMapBasedOnLSP(paths: string[], workspaceFolder?: WorkspaceFolder): Dependency[] {
        return []
    }

    // node_modules entries are often links (workspaces, pnpm), so judge where the link resolves
    private isInsideWorkspaceFolder(dependencyPath: string, jstsDependencyInfo: JSTSDependencyInfo): boolean {
        const workspaceFolderPath = URI.parse(jstsDependencyInfo.workspaceFolder.uri).fsPath
        if (resolvePathInside(dependencyPath, workspaceFolderPath) !== undefined) {
            return true
        }
        this.logging.warn(`Skipping dependency outside the workspace folder: ${dependencyPath}`)
        return false
    }
    override transformPathToDependency(
        dependencyName: string,
        dependencyPath: string,
        dependencyMap: Map<string, Dependency>
    ): void {}

    disposeWatchers(workspaceFolder: WorkspaceFolder): void {
        this.jstsDependencyInfos.forEach((jstsDependencyInfo: JSTSDependencyInfo) => {
            if (workspaceFolder.uri === jstsDependencyInfo.workspaceFolder.uri) {
                const packageJsonPath = jstsDependencyInfo.packageJsonPath
                if (this.dependencyWatchers.has(packageJsonPath)) {
                    this.logging.log(`Disposing dependency watcher for ${packageJsonPath}`)
                    this.dependencyWatchers.get(packageJsonPath)?.dispose()
                    this.dependencyWatchers.delete(packageJsonPath)
                }
            }
        })
    }

    disposeDependencyInfo(workspaceFolder: WorkspaceFolder): void {
        // Remove the dependency info for the workspace folder
        this.jstsDependencyInfos = this.jstsDependencyInfos.filter(
            (jstsDependencyInfo: JSTSDependencyInfo) => jstsDependencyInfo.workspaceFolder.uri !== workspaceFolder.uri
        )
    }
}
