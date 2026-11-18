import { BaseDependencyInfo, Dependency, LanguageDependencyHandler } from './LanguageDependencyHandler'
import * as path from 'path'
import * as fs from 'fs'
import * as xml2js from 'xml2js'
import { WorkspaceFolder } from '@aws/language-server-runtimes/server-interface'
import { DependencyWatcher } from './DependencyWatcher'

export interface JavaDependencyInfo extends BaseDependencyInfo {
    dotClasspathPath: string
}

/*
 * Java Dependency Handler
 *
 * This handler depends on .classpath to discover dependency locations
 */
export class JavaDependencyHandler extends LanguageDependencyHandler<JavaDependencyInfo> {
    private javaDependencyInfos: JavaDependencyInfo[] = []
    private RELATIVE_PATH: string = 'dependencies'

    /*
     * It will return a boolean indicating whether it finds any dependency info.
     * The JavaDependencyInfo object contains the following properties:
     * - pkgDir: the package directory
     * - dotClasspathPath: the path to the .classpath file
     */
    discover(currentDir: string, workspaceFolder: WorkspaceFolder): boolean {
        let result: JavaDependencyInfo | null = null
        const dotClasspathPath = path.join(currentDir, '.classpath')
        if (fs.existsSync(dotClasspathPath) && fs.statSync(dotClasspathPath).isFile()) {
            this.logging.log(`Found .classpath in ${currentDir}`)
            result = {
                pkgDir: currentDir,
                dotClasspathPath: dotClasspathPath,
                workspaceFolder: workspaceFolder,
            }
            this.javaDependencyInfos.push(result)
        }

        return result !== null
    }

    /*
     * It will create a dependency map from the .classpath file.
     * The dependency map will contain the following properties:
     * - name: the name of the dependency
     * - version: the version of the dependency
     * - path: the path to the dependency
     */
    initiateDependencyMap(folders: WorkspaceFolder[]): void {
        // Filter out the javaDependencyInfos that are in the folders
        const javaDependencyInfoToBeInitiated = this.javaDependencyInfos.filter(javaDependencyInfo => {
            return folders.includes(javaDependencyInfo.workspaceFolder)
        })

        for (const javaDependencyInfo of javaDependencyInfoToBeInitiated) {
            // TODO, check if try catch is necessary here
            try {
                let generatedDependencyMap: Map<string, Dependency> = this.generateDependencyMap(javaDependencyInfo)
                this.compareAndUpdateDependencyMap(javaDependencyInfo.workspaceFolder, generatedDependencyMap)
                // Log found dependencies
                this.logging.log(
                    `Total Java dependencies found:  ${generatedDependencyMap.size} under ${javaDependencyInfo.pkgDir}`
                )
            } catch (error) {
                this.logging.warn(`Error processing Java dependencies: ${error}`)
            }
        }
    }

    /*
     * It will setup watchers for the .classpath files.
     * When a change is detected, it will update the dependency map.
     */
    setupWatchers(folders: WorkspaceFolder[]): void {
        // Filter out the javaDependencyInfos that are in the folders
        const javaDependencyInfoToBeWatched = this.javaDependencyInfos.filter(javaDependencyInfo => {
            return folders.includes(javaDependencyInfo.workspaceFolder)
        })

        javaDependencyInfoToBeWatched.forEach((javaDependencyInfo: JavaDependencyInfo) => {
            const dotClasspathPath = javaDependencyInfo.dotClasspathPath
            if (this.dependencyWatchers.has(dotClasspathPath)) {
                return
            }
            this.logging.log(`Setting up Java dependency watcher for ${dotClasspathPath}`)
            try {
                const callBackDependencyUpdate = async (events: string[]) => {
                    this.logging.log(`Change detected in ${dotClasspathPath}`)
                    const updatedDependencyMap = this.generateDependencyMap(javaDependencyInfo)
                    const changedDependencyList = this.compareAndUpdateDependencyMap(
                        javaDependencyInfo.workspaceFolder,
                        updatedDependencyMap
                    )
                    await this.zipAndUploadDependenciesByChunk(
                        changedDependencyList,
                        javaDependencyInfo.workspaceFolder
                    )
                }
                const watcher = new DependencyWatcher(
                    dotClasspathPath,
                    callBackDependencyUpdate,
                    this.logging,
                    this.DEPENDENCY_WATCHER_EVENT_BATCH_INTERVAL
                )
                this.dependencyWatchers.set(dotClasspathPath, watcher)
            } catch (error) {
                this.logging.warn(`Error setting up watcher for ${dotClasspathPath}: ${error}`)
            }
        })
    }

    /*
     * It will parse .classpath file and find location of dependency jars with version
     */
    generateDependencyMap(javaDependencyInfo: JavaDependencyInfo): Map<string, Dependency> {
        const dependencyMap = new Map<string, Dependency>()
        // Read and parse .classpath XML file
        const dotClasspathPath = javaDependencyInfo.dotClasspathPath
        const parser = new xml2js.Parser()
        const classpathContent = fs.readFileSync(dotClasspathPath, 'utf-8')

        parser.parseString(classpathContent, (err: any, result: any) => {
            if (err) {
                this.logging.log(`Error parsing .classpath: ${err}`)
                return
            }

            // Process classpathentry elements
            if (result.classpath && result.classpath.classpathentry) {
                result.classpath.classpathentry.forEach((entry: any) => {
                    if (entry.$ && entry.$.kind === 'lib' && entry.$.path) {
                        const jarPath = entry.$.path
                        const jarName = path.basename(jarPath)
                        this.transformPathToDependency(jarName, jarPath, dependencyMap)
                    }
                })
            }
        })
        return dependencyMap
    }

    transformPathToDependency(
        dependencyName: string,
        dependencyPath: string,
        dependencyMap: Map<string, Dependency>
    ): void {
        // Extract name and version from jar path
        // Example path patterns:
        // - lib/dependency-1.2.3.jar
        // - lib/dependency-1.2.3-SNAPSHOT.jar
        // - ~/.m2/repository/com/example/dependency/1.2.3/dependency-1.2.3.jar
        const match = dependencyName.match(/^(.*?)(?:-([\d.]+(?:-SNAPSHOT)?))?.jar$/)

        if (match) {
            const name = match[1]
            const version = match[2] || 'unknown'
            if (fs.existsSync(dependencyPath) && path.isAbsolute(dependencyPath)) {
                // A .jar name can be a link to any file, so check what it resolves to
                let realPath: string
                try {
                    realPath = fs.realpathSync(dependencyPath)
                } catch {
                    return
                }
                if (path.extname(realPath).toLowerCase() !== '.jar' || !fs.statSync(realPath).isFile()) {
                    this.logging.warn(`Skipping dependency ${dependencyName}: it is not a jar file`)
                    return
                }
                dependencyMap.set(name, {
                    name,
                    version,
                    path: dependencyPath,
                    size: fs.statSync(dependencyPath).size,
                    zipped: false,
                })
            }
        }
    }

    disposeWatchers(workspaceFolder: WorkspaceFolder): void {
        this.javaDependencyInfos.forEach((javaDependencyInfo: JavaDependencyInfo) => {
            if (workspaceFolder.uri === javaDependencyInfo.workspaceFolder.uri) {
                const dotClasspathPath = javaDependencyInfo.dotClasspathPath
                if (this.dependencyWatchers.has(dotClasspathPath)) {
                    this.logging.log(`Disposing dependency watcher for ${dotClasspathPath}`)
                    this.dependencyWatchers.get(dotClasspathPath)?.dispose()
                    this.dependencyWatchers.delete(dotClasspathPath)
                }
            }
        })
    }

    disposeDependencyInfo(workspaceFolder: WorkspaceFolder): void {
        // Remove the dependency info for the workspace folder
        this.javaDependencyInfos = this.javaDependencyInfos.filter(
            (javaDependencyInfo: JavaDependencyInfo) => javaDependencyInfo.workspaceFolder.uri !== workspaceFolder.uri
        )
    }
}
