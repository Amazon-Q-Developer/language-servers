import { BaseDependencyInfo, Dependency, LanguageDependencyHandler } from './LanguageDependencyHandler'
import { WorkspaceFolder } from '@aws/language-server-runtimes/server-interface'
import * as path from 'path'
import * as fs from 'fs'
import { resolvePathInside, isDirectory } from '../../util'
import { DependencyWatcher } from './DependencyWatcher'

export interface PythonDependencyInfo extends BaseDependencyInfo {
    vscCodeSettingsJsonPath: string
    sitePackagesPaths: string[]
}

/*
 * Python Dependency Handler
 *
 * This handler depends on .vscode/settings.json to discover dependency locations
 */
export class PythonDependencyHandler extends LanguageDependencyHandler<PythonDependencyInfo> {
    private pythonDependencyInfos: PythonDependencyInfo[] = []

    /**
     * It will return a boolean indicating whether it finds any dependency info.
     * The PythonDependencyInfo object contains the following properties:
     * - pkgDir: the package directory
     * - vscCodeSettingsJsonPath: the path to the .vscode/settings.json file
     * - sitePackagesPaths: the path to site-packages directory
     */
    discover(currentDir: string, workspaceFolder: WorkspaceFolder): boolean {
        let result: PythonDependencyInfo | null = null
        const vscCodeSettingsJsonPath = path.join(currentDir, '.vscode', 'settings.json')
        if (fs.existsSync(vscCodeSettingsJsonPath) && fs.statSync(vscCodeSettingsJsonPath).isFile()) {
            this.logging.log(`Found .vscode/settings.json in ${currentDir}`)
            let settingsContent
            try {
                settingsContent = JSON.parse(fs.readFileSync(vscCodeSettingsJsonPath, 'utf-8'))
            } catch (error) {
                this.logging.warn(`Can't parse settings.json, skipping`)
                return false
            }
            // Get and resolve paths from both settings
            const analysisPaths = (settingsContent['python.analysis.extraPaths'] || []).map((rawPath: string) =>
                this.resolvePath(rawPath, currentDir)
            )
            const autoCompletePaths = (settingsContent['python.autoComplete.extraPaths'] || []).map((rawPath: string) =>
                this.resolvePath(rawPath, currentDir)
            )
            // Find all unique site-packages directories
            const sitePackagesPaths = this.findSitePackagesPaths([...analysisPaths, ...autoCompletePaths])
            if (sitePackagesPaths.length === 0) {
                this.logging.log('No site-packages directories found in Python paths')
            } else {
                result = {
                    pkgDir: currentDir,
                    vscCodeSettingsJsonPath: vscCodeSettingsJsonPath,
                    sitePackagesPaths: sitePackagesPaths,
                    workspaceFolder: workspaceFolder,
                }
                this.pythonDependencyInfos.push(result)
            }
        }
        return result !== null
    }

    /**
     * It will create a dependency map from the site-packages
     * The dependency map will contain the following properties:
     * - name: the name of the dependency
     * - version: the version of the dependency
     * - path: the path to the dependency
     */
    initiateDependencyMap(folders: WorkspaceFolder[]): void {
        // Filter out the javaDependencyInfos that are in the folders
        const pythonDependencyInfoToBeInitiated = this.pythonDependencyInfos.filter(pythonDependencyInfo => {
            return folders.includes(pythonDependencyInfo.workspaceFolder)
        })

        pythonDependencyInfoToBeInitiated.forEach(pythonDependencyInfo => {
            // TODO, check if the try catch is necessary here
            try {
                let generatedDependencyMap: Map<string, Dependency> = this.generateDependencyMap(pythonDependencyInfo)
                this.compareAndUpdateDependencyMap(pythonDependencyInfo.workspaceFolder, generatedDependencyMap)
                // Log found dependencies
                this.logging.log(
                    `Total Python dependencies found: ${generatedDependencyMap.size} under ${pythonDependencyInfo.pkgDir}`
                )
            } catch (error) {
                this.logging.warn(`Error processing Python dependencies: ${error}`)
            }
        })

        return
    }

    /**
     * It will setup watchers for the .classpath files.
     * When a change is detected, it will update the dependency map.
     */
    setupWatchers(folders: WorkspaceFolder[]): void {
        // Filter out the javaDependencyInfos that are in the folders
        const pythonDependencyInfoToBeWatched = this.pythonDependencyInfos.filter(pythonDependencyInfo => {
            return folders.includes(pythonDependencyInfo.workspaceFolder)
        })

        pythonDependencyInfoToBeWatched.forEach(pythonDependencyInfo => {
            pythonDependencyInfo.sitePackagesPaths.forEach(sitePackagesPath => {
                if (this.dependencyWatchers.has(sitePackagesPath)) {
                    return
                }

                this.logging.log(`Setting up Python dependency watcher for ${sitePackagesPath}`)
                try {
                    const callBackDependencyUpdate = async (events: string[]) => {
                        const updatedDependencyMap: Map<string, Dependency> = new Map<string, Dependency>()
                        for (const fileName of events) {
                            if (this.isMetadataDirectory(fileName)) {
                                this.handleMetadataChange(sitePackagesPath, fileName, updatedDependencyMap)
                            } else {
                                this.handlePackageChange(sitePackagesPath, fileName, updatedDependencyMap)
                            }
                        }
                        const changedDependencyList = this.compareAndUpdateDependencyMap(
                            pythonDependencyInfo.workspaceFolder,
                            updatedDependencyMap
                        )
                        await this.zipAndUploadDependenciesByChunk(
                            changedDependencyList,
                            pythonDependencyInfo.workspaceFolder
                        )
                    } // end of callback function

                    const watcher = new DependencyWatcher(
                        sitePackagesPath,
                        callBackDependencyUpdate,
                        this.logging,
                        this.DEPENDENCY_WATCHER_EVENT_BATCH_INTERVAL
                    )
                    this.dependencyWatchers.set(sitePackagesPath, watcher)
                } catch (error) {
                    this.logging.warn(`Error setting up watcher for ${sitePackagesPath}: ${error}`)
                }
            })
        })
    }

    /**
     * It will generate a dependency map from the site-packages
     * The dependency map will contain the following properties:
     *
     * @param pythonDependencyInfo
     * @param dependencyMap
     */
    generateDependencyMap(pythonDependencyInfo: PythonDependencyInfo) {
        const dependencyMap = new Map<string, Dependency>()
        // Process each site-packages directory
        for (const sitePackagesPath of pythonDependencyInfo.sitePackagesPaths) {
            const sitePackagesContent = fs.readdirSync(sitePackagesPath)

            for (const item of sitePackagesContent) {
                const itemPath = path.join(sitePackagesPath, item)
                try {
                    this.transformPathToDependency(item, itemPath, dependencyMap)
                } catch (error) {
                    this.logging.warn(`Error processing item ${item} in ${sitePackagesPath}: ${error}`)
                }
            }
        }
        return dependencyMap
    }

    transformPathToDependency(
        dependencyName: string,
        dependencyPath: string,
        dependencyMap: Map<string, Dependency>
    ): void {
        // Skip if it's a metadata directory
        if (this.isMetadataDirectory(dependencyPath)) {
            return
        }

        try {
            // Add to dependency map if not already present
            if (!dependencyMap.has(dependencyName)) {
                let dependencySize: number = 0
                // A site-packages entry that links elsewhere must not pull in files from outside site-packages
                const truePath = resolvePathInside(dependencyPath, path.dirname(dependencyPath))
                if (truePath === undefined) {
                    this.logging.warn(`Skipping dependency ${dependencyName}: it resolves outside its parent directory`)
                    return
                }

                if (isDirectory(truePath)) {
                    dependencySize = this.getDirectorySize(truePath)
                } else {
                    dependencySize = fs.statSync(truePath).size
                }
                dependencyMap.set(dependencyName, {
                    name: dependencyName,
                    version: 'unknown',
                    path: truePath,
                    size: dependencySize,
                    zipped: false,
                })
            }
        } catch (error) {
            this.logging.warn(`Error processing dependency ${dependencyName}: ${error}`)
        }
    }

    private isMetadataDirectory(filename: string): boolean {
        return filename.endsWith('.egg-info') || filename.endsWith('.dist-info') || filename.endsWith('-info')
    }

    private handleMetadataChange(
        sitePackagesPath: string,
        metadataDir: string,
        updatedDependencyMap: Map<string, Dependency>
    ): void {
        // Extract package name from metadata directory name
        // Example: 'requests-2.28.1.dist-info' -> 'requests'
        const dependencyName = metadataDir.split('-')[0]

        // Check if we have this package in our dependency map
        const dependencyPath = resolvePathInside(path.join(sitePackagesPath, dependencyName), sitePackagesPath)
        if (dependencyPath !== undefined) {
            // Mark the package as updated
            const updatedDependency = {
                name: dependencyName,
                version: 'unknown',
                path: dependencyPath,
                size: this.getDirectorySize(dependencyPath),
                zipped: false,
            }
            updatedDependencyMap.set(dependencyName, updatedDependency)
            this.logging.log(`Python package updated (metadata change): ${dependencyPath}`)
        }
    }

    private handlePackageChange(
        sitePackagesPath: string,
        fileName: string,
        updatedDependencyMap: Map<string, Dependency>
    ): void {
        const dependencyPath = resolvePathInside(path.join(sitePackagesPath, fileName), sitePackagesPath)
        if (dependencyPath !== undefined) {
            const updatedDependency = {
                name: fileName,
                version: 'unknown',
                path: dependencyPath,
                size: this.getDirectorySize(dependencyPath),
                zipped: false,
            }
            updatedDependencyMap.set(fileName, updatedDependency)
            this.logging.log(`Python package updated: ${fileName}`)
        }
    }

    private resolvePath(rawPath: string, workspaceFolder: string): string {
        // resolve the path which may contain variables
        return rawPath
            .replace(/\${workspaceFolder}/g, workspaceFolder)
            .replace(/\${env:([^}]+)}/g, (_, envVar) => process.env[envVar] || '')
            .replace(/\${userHome}/g, process.env.HOME || process.env.USERPROFILE || '')
    }

    private findSitePackagesPaths(pythonPaths: string[]): string[] {
        // Normalize paths and remove duplicates
        const normalizedPaths = new Set(
            pythonPaths.map(p => path.normalize(p)).filter(p => p.includes('site-packages') && fs.existsSync(p))
        )

        return Array.from(normalizedPaths)
    }

    disposeWatchers(workspaceFolder: WorkspaceFolder): void {
        this.pythonDependencyInfos.forEach((pythonDependencyInfo: PythonDependencyInfo) => {
            if (workspaceFolder.uri === pythonDependencyInfo.workspaceFolder.uri) {
                pythonDependencyInfo.sitePackagesPaths.forEach((sitePackagesPath: string) => {
                    if (this.dependencyWatchers.has(sitePackagesPath)) {
                        this.logging.log(`Disposing dependency watcher for ${sitePackagesPath}`)
                        this.dependencyWatchers.get(sitePackagesPath)?.dispose()
                        this.dependencyWatchers.delete(sitePackagesPath)
                    }
                })
            }
        })
    }

    disposeDependencyInfo(workspaceFolder: WorkspaceFolder): void {
        // Remove the dependency info for the workspace folder
        this.pythonDependencyInfos = this.pythonDependencyInfos.filter(
            (pythonDependencyInfo: PythonDependencyInfo) =>
                pythonDependencyInfo.workspaceFolder.uri !== workspaceFolder.uri
        )
    }
}
