/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import { fdir } from 'fdir'
import { TextDocument, Workspace } from '@aws/language-server-runtimes/server-interface'
import { URI } from 'vscode-uri'
import * as ignore from 'ignore'

type Metadata = {
    lang: string
    extensions: string[]
    testAffixes: string[]
    packageMarker?: RegExp
    importPatterns?: RegExp[]
    packageSeparator: string
    moduleAliases?: Record<string, string>
}

const LANGUAGE_CONFIG: Record<string, Metadata> = {
    java: {
        lang: 'java',
        extensions: ['.java'],
        testAffixes: ['Tests', 'Test'],
        packageMarker: /^package\s+([a-zA-Z0-9_.]+);/,
        packageSeparator: '.',
    },
    python: {
        lang: 'python',
        extensions: ['.py'],
        testAffixes: ['test_', '_test'],
        importPatterns: [/^import\s+([a-zA-Z0-9_.]+)/, /^from\s+([a-zA-Z0-9_.]+)/],
        packageSeparator: '.',
    },
    javascript: {
        lang: 'javascript',
        extensions: ['.js'],
        testAffixes: ['.test', '.spec'],
        importPatterns: [/^import.*from\s+[\'"](.+)[\'"]/],
        packageSeparator: '/',
    },
    typescript: {
        lang: 'typescript',
        extensions: ['.ts'],
        testAffixes: ['.test', '.spec'],
        importPatterns: [/^import.*from\s+[\'"](.+)[\'"]/],
        packageSeparator: '/',
        moduleAliases: {
            '@src': 'src',
        },
    },
}

export class FocalFileResolver {
    filter = ignore().add(['node_modules', '.git', '.aws', '.vscode', '.idea', '.gitignore', '.gitmodules'])

    constructor() {}

    // TODO: make [inferFocalFile] & [inferSourceFile] overload
    async inferFocalFile(doc: TextDocument, workspace: Workspace): Promise<string | undefined> {
        const lang = doc.languageId
        const p = URI.parse(doc.uri).fsPath
        return this.inferSourceFile(p, workspace, lang)
    }

    /**
     *
     * @param testFilePath absolute path
     * @param projectRoot absolute path
     * @param language
     * @returns
     */
    async inferSourceFile(testFilePath: string, workspace: Workspace, language: string): Promise<string | undefined> {
        const wsFolders = workspace.getAllWorkspaceFolders()
        if (wsFolders.length === 0) {
            return undefined
        }

        const config = LANGUAGE_CONFIG[language]
        if (!config) {
            return undefined
        }

        // TODO: is this correct way to get "Project Root" or should we pass all ws folders?
        const projectRoot = path.resolve(URI.parse(wsFolders[0].uri).fsPath)

        const inferredSrcFilename = this.inferFocalFilename(testFilePath, language)

        if (!inferredSrcFilename) {
            // TODO: logging
            return
        }

        // Find candidate focal files based on naming conventions
        const candidates: { fullPath: string; relativePath: string }[] = []
        const files = await this.walk(projectRoot, language)

        for (const file of files) {
            const ext = path.extname(file)
            const base = path.basename(file)

            if (base === inferredSrcFilename) {
                candidates.push({
                    fullPath: file,
                    relativePath: path.relative(projectRoot, file),
                })
            }
        }

        if (candidates.length === 0) {
            return undefined
        }

        if (candidates.length === 1) {
            return candidates[0].fullPath
        }

        // If there are multiple matches of source files, filter based on the imported path and symbols
        const importedFiles = this.extractImportedPaths(testFilePath, language, projectRoot)
        const filteredCandidate = []
        for (const candidate of candidates) {
            for (const importedFileAbsPath of importedFiles) {
                if (
                    candidate.fullPath.startsWith(importedFileAbsPath) ||
                    candidate.fullPath.includes(importedFileAbsPath)
                ) {
                    filteredCandidate.push(candidate)
                    break
                }
            }
        }

        if (filteredCandidate.length) {
            switch (language) {
                case 'javascript':
                case 'typescript':
                    const importedSymbols = this.extractImportedSymbols(testFilePath)
                    let bestMatch: { fullPath: string; relativePath: string } | undefined = undefined
                    let bestOverlap = 0

                    for (const candidate of filteredCandidate) {
                        const exportedSymbols = this.extractExportedSymbolsFromFile(candidate.fullPath)
                        const myOverlap = this.getOverlap(exportedSymbols, importedSymbols)
                        if (myOverlap.size > bestOverlap) {
                            bestOverlap = myOverlap.size
                            bestMatch = candidate
                        }
                    }

                    if (bestMatch) {
                        return bestMatch.fullPath
                    }
                    return undefined

                default:
                    return filteredCandidate[0].fullPath
            }
        }

        return undefined
    }

    // @VisibleForTesting
    inferFocalFilename(testFilePath: string, language: string): string | undefined {
        const config = LANGUAGE_CONFIG[language]
        const ext = path.extname(testFilePath)
        const filenameWithoutExt = path.basename(testFilePath, ext)

        let inferredSrcFilename: string | undefined
        for (const affix of config['testAffixes']) {
            if (filenameWithoutExt.endsWith(affix)) {
                inferredSrcFilename = filenameWithoutExt.substring(0, filenameWithoutExt.length - affix.length) + ext
                break
            } else if (filenameWithoutExt.startsWith(affix)) {
                inferredSrcFilename = filenameWithoutExt.substring(affix.length) + ext
                break
            }
        }

        return inferredSrcFilename
    }

    // @VisibleForTesting
    extractImportedPaths(testFilePath: string, lang: string, projectRoot: string): Set<string> {
        const config = LANGUAGE_CONFIG[lang]
        const content = fs.readFileSync(testFilePath)
        const lines = content.toString().split(/\r?\n/)

        const result: Set<string> = new Set()
        let buffer = ''
        let insideImportBlock = false
        try {
            for (const l of lines) {
                const line = l.trim()

                if (config.lang === 'java') {
                    const match = config.packageMarker?.exec(line)
                    if (match) {
                        const pkg = this.resolvePackageToPath(match[1], config.packageSeparator)
                        result.add(pkg)
                    }
                    continue
                }

                if (config.lang === 'python' && config.importPatterns) {
                    for (const pattern of config.importPatterns) {
                        const match = pattern.exec(line)
                        if (match) {
                            const imp = this.resolvePackageToPath(match[1], config.packageSeparator)
                            result.add(imp)
                        }
                    }
                    continue
                }

                if (line.startsWith('import') || insideImportBlock) {
                    buffer += ' ' + line
                    insideImportBlock = true

                    if ((line.includes(';') || line.includes('from')) && config.importPatterns) {
                        for (const pattern of config.importPatterns) {
                            const match = pattern.exec(buffer.trim())
                            if (match) {
                                const imp = match[1]
                                const absPath = this.resolveImportToAbsPath(testFilePath, imp, projectRoot, lang)
                                if (absPath) {
                                    result.add(absPath)
                                }
                            }
                        }
                        buffer = ''
                        insideImportBlock = false
                    }
                }
            }
        } catch (e) {
            // TODO: logging
        }

        return result
    }

    // @VisibleForTesting
    extractImportedSymbols(candidateAbsPath: string): Set<string> {
        const result: Set<string> = new Set()
        try {
            const content = fs.readFileSync(candidateAbsPath)
            const lines = content.toString().split(os.EOL)
            let buffer = ''
            let insideImportBlock = false

            for (const l of lines) {
                const line = l.trim()
                if (line.startsWith('import') || insideImportBlock) {
                    buffer += ' ' + line
                    insideImportBlock = true

                    // end of import block
                    if (line.includes('from') || line.includes(';')) {
                        const namedMatch = buffer.match(/{([^}]+)}/g)
                        if (namedMatch) {
                            for (const m of namedMatch) {
                                const innerContent = m.slice(1, -1)
                                const parts = innerContent
                                    .split(',')
                                    .map(s => s.trim())
                                    .filter(s => s.length > 0)

                                for (const p of parts) {
                                    result.add(p)
                                }
                            }
                        }

                        const defaultMatch = buffer.match(/import\s+([a-zA-Z_$][\w$]*)\s*(,|\s+from)/)
                        if (defaultMatch) {
                            result.add(defaultMatch[1])
                        }

                        buffer = ''
                        insideImportBlock = false
                    }
                }
            }
        } catch (e) {
            // TODO: logging
        }
        return result
    }

    // @VisibleForTesting
    extractExportedSymbolsFromFile(candidateAbsPath: string): Set<string> {
        const result: Set<string> = new Set()
        try {
            const content = fs.readFileSync(candidateAbsPath)
            const lines = content.toString().split(os.EOL)
            for (const l of lines) {
                const line = l.trim()

                const matchFunc = /export\s+function\s+([a-zA-Z_$][\w$]*)/.exec(line)
                if (matchFunc) {
                    result.add(matchFunc[1])
                }

                const matchClass = /export\s+class\s+([a-zA-Z_$][\w$]*)/.exec(line)
                if (matchClass) {
                    result.add(matchClass[1])
                }

                const matchConst = /export\s+const\s+([a-zA-Z_$][\w$]*)/.exec(line)
                if (matchConst) {
                    result.add(matchConst[1])
                }

                const matchNamedBlock = /export\s+{([^}]+)}/g.exec(line) || []
                if (matchNamedBlock[1]) {
                    const parts = matchNamedBlock[1]
                        .split(',')
                        .map(s => s.trim())
                        .filter(s => s.length > 0)

                    for (const p of parts) {
                        result.add(p)
                    }
                }

                const matchDefault = /export\s+default\s+([a-zA-Z_$][\w$]*)/.exec(line)
                if (matchDefault) {
                    result.add(matchDefault[1])
                }

                const matchDefaultFunc = /export\s+default\s+function\s+([a-zA-Z_$][\w$]*)/.exec(line)
                if (matchDefaultFunc) {
                    result.add(matchDefaultFunc[1])
                }
            }
        } catch (e) {
            // TODO: logging
        }

        return result
    }

    // @VisibleForTesting
    resolveImportToAbsPath(
        testFilePath: string,
        importPath: string,
        projectRoot: string,
        lang: string
    ): string | undefined {
        const config = LANGUAGE_CONFIG[lang]
        // Handle module aliases
        const moduleAlias = config.moduleAliases
        if (moduleAlias) {
            for (const [alias, relPath] of Object.entries(moduleAlias)) {
                if (importPath.startsWith(alias)) {
                    // TODO: python: import_path.replace(alias, real_path, 1), seems 1 is needed to ensure only replacement only happen once
                    const realPath = importPath.replace(alias, relPath)
                    return path.join(projectRoot, realPath)
                }
            }
        }

        // Handle relative or absolute paths
        if (importPath.startsWith('.') || importPath.startsWith('/')) {
            const testDir = path.dirname(testFilePath)
            const absPath = path.normalize(path.join(testDir, importPath))
            return absPath
        }

        // Try fallback roots
        const fallbackRoots = ['src', 'lib']
        for (const base of fallbackRoots) {
            const candidate = path.normalize(path.join(projectRoot, base, importPath))
            if (fs.existsSync(candidate) || fs.existsSync(candidate + '.ts') || fs.existsSync(candidate + '.js')) {
                return candidate
            }
        }

        return undefined
    }

    /**
     * @VisibleForTesting
     * @param pkg e.g. "com.amazon.q.service"
     * @param pkgSeparator e.g. "."
     */
    resolvePackageToPath(pkg: string, pkgSeparator: string): string {
        const normalized = pkg.replace(new RegExp(`\\` + pkgSeparator, 'g'), '/')
        return normalized.split('/').join(path.sep)
    }

    // TODO: Duplicate to what [localProjectContextController.ts] has implemented, should pull this to a util
    /**
     * @VisibleForTesting
     * @param projectRoot absolute path
     * @param lang java | python | typescript | javascript
     * @returns absolute path of files under project root
     */
    async walk(projectRoot: string, lang: string): Promise<string[]> {
        const config = LANGUAGE_CONFIG[lang]
        const exts = config.extensions

        try {
            // Skip links: one could point outside the project, or at a FIFO or device that blocks the read
            const crawler = new fdir({ excludeSymlinks: true })
                .withFullPaths()
                .exclude((dirName: string, dirPath: string) => {
                    const relativePath = path.relative(projectRoot, dirPath)
                    return dirName.startsWith('.') || relativePath.startsWith('..') || this.filter.ignores(relativePath)
                })
                .filter((filePath: string) => {
                    const myExt = path.extname(filePath)
                    return exts.includes(myExt)
                })
                .crawl(projectRoot)

            const files = await crawler.withPromise()

            return files
        } catch (error) {
            console.error(`Error walking directory ${projectRoot}:`, error)
            return []
        }
    }

    private getOverlap(s1: Set<string>, s2: Set<string>): Set<string> {
        const overlap = new Set<string>()
        for (const e of s1) {
            if (s2.has(e)) {
                overlap.add(e)
            }
        }

        return overlap
    }
}
