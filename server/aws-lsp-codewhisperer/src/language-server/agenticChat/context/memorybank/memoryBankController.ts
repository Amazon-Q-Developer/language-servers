/*!
 * Copyright Amazon.com, Inc. or its affiliates.
 * All Rights Reserved. SPDX-License-Identifier: Apache-2.0
 */

import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { MemoryBankPrompts } from './memoryBankPrompts'
import { normalizePathFromUri } from '../../tools/mcp/mcpUtils'
import { MAX_NUMBER_OF_FILES_FOR_MEMORY_BANK_RANKING } from '../../constants/constants'

const MEMORY_BANK_DIRECTORY = '.amazonq/rules/memory-bank'
const MEMORY_BANK_FILES = {
    PRODUCT: 'product.md',
    STRUCTURE: 'structure.md',
    TECH: 'tech.md',
    GUIDELINES: 'guidelines.md',
} as const

/**
 * Longest stretch of synchronous analysis work before yielding to the event loop, so the
 * language server keeps handling other messages (for example, opening a new chat tab).
 */
const ANALYSIS_YIELD_INTERVAL_MS = 30

/** Sparse TF-IDF vector: non-zero weights only, plus its precomputed L2 norm */
interface TfidfVector {
    weights: Map<string, number>
    norm: number
}

/**
 * Returns a function that yields to the event loop once at least `intervalMs` has passed since
 * the previous yield. Uses setTimeout so it also works in the web worker runtime.
 */
function createEventLoopYielder(intervalMs: number = ANALYSIS_YIELD_INTERVAL_MS): () => Promise<void> {
    let lastYield = Date.now()
    return async () => {
        if (Date.now() - lastYield >= intervalMs) {
            await new Promise<void>(resolve => setTimeout(resolve, 0))
            lastYield = Date.now()
        }
    }
}

/**
 * Controller for Memory Bank functionality
 * Handles memory bank creation detection and prompt generation
 */
export class MemoryBankController {
    private static instance: MemoryBankController | undefined

    constructor(private features: Features) {}

    static getInstance(features: Features): MemoryBankController {
        if (!MemoryBankController.instance) {
            MemoryBankController.instance = new MemoryBankController(features)
        }
        return MemoryBankController.instance
    }

    /**
     * Check if a prompt is requesting memory bank creation
     * Can be expanded based on feedbacks
     */
    isMemoryBankCreationRequest(prompt: string): boolean {
        const normalizedPrompt = prompt.toLowerCase().trim()

        const triggers = [
            'create a memory bank',
            'create memory bank',
            'generate a memory bank',
            'generate memory bank',
            'regenerate memory bank',
            'build memory bank',
            'make memory bank',
            'setup memory bank',
        ]

        return triggers.some(trigger => normalizedPrompt.includes(trigger))
    }

    /**
     * Prepare comprehensive memory bank creation prompt with all necessary input
     * This does all the programmatic work upfront and creates a single comprehensive prompt
     */
    async prepareComprehensiveMemoryBankPrompt(
        workspaceFolderUri: string,
        llmCallFunction: (prompt: string) => Promise<string>
    ): Promise<string> {
        try {
            this.features.logging.info(`Memory Bank: Starting pre-processing for workspace: "${workspaceFolderUri}"`)

            // Step 1: Clean directory
            await this.cleanMemoryBankDirectory(workspaceFolderUri)

            // Step 2: Execute deterministic analysis (TF-IDF)
            this.features.logging.info(`Memory Bank: running analysis for workspace`)
            const analysisResults = await this.executeGuidelinesGenerationPipeline(workspaceFolderUri)

            // Step 3: Make LLM call for file ranking
            const rankingPrompt = MemoryBankPrompts.getFileRankingPrompt(
                analysisResults.formattedFilesString,
                MAX_NUMBER_OF_FILES_FOR_MEMORY_BANK_RANKING
            )
            const rankedFilesResponse = await llmCallFunction(rankingPrompt)

            // Step 4: Parse ranked files
            let rankedFilesList: string[] = []
            try {
                // Clean the response - remove any markdown formatting or extra text
                let cleanResponse = rankedFilesResponse.trim()

                // Extract JSON array if it's wrapped in markdown or other text
                const jsonMatch = cleanResponse.match(/\[.*\]/s)
                if (jsonMatch) {
                    cleanResponse = jsonMatch[0]
                } else {
                    // Handle case where LLM returns comma-separated quoted strings without brackets
                    if (cleanResponse.includes('",') && cleanResponse.includes('"')) {
                        // Add brackets to make it a valid JSON array
                        cleanResponse = `[${cleanResponse}]`
                    }
                }

                rankedFilesList = JSON.parse(cleanResponse)
                if (!Array.isArray(rankedFilesList)) {
                    throw new Error('Invalid ranking response format - not an array')
                }

                // Validate that all items are strings (file paths)
                rankedFilesList = rankedFilesList.filter(item => typeof item === 'string' && item.length > 0)

                if (rankedFilesList.length === 0) {
                    throw new Error('No valid file paths in ranking response')
                }

                this.features.logging.info(
                    `Memory Bank: parsed ${rankedFilesList.length} ranked files from LLM response`
                )
            } catch (error) {
                this.features.logging.warn(
                    `Memory Bank: failed to parse LLM ranking response, using TF-IDF fallback: ${error}`
                )
                rankedFilesList = analysisResults.rankedFilesList.slice(0, MAX_NUMBER_OF_FILES_FOR_MEMORY_BANK_RANKING)
            }

            this.features.logging.info(
                `Memory Bank: using ${rankedFilesList.length} files for documentation generation`
            )

            // Step 5: Create the comprehensive prompt with ranked files and workspace path
            const normalizedWorkspacePath = normalizePathFromUri(workspaceFolderUri, this.features.logging)

            this.features.logging.info(`Memory Bank: Generating final prompt with path: "${normalizedWorkspacePath}"`)
            const finalPrompt = MemoryBankPrompts.getCompleteMemoryBankPrompt(rankedFilesList, normalizedWorkspacePath)
            return finalPrompt
        } catch (error) {
            this.features.logging.error(`Memory Bank preparation failed: ${error}`)
            throw error
        }
    }

    /**
     * Clean and recreate memory bank directory
     */
    async cleanMemoryBankDirectory(workspaceFolderUri: string): Promise<void> {
        try {
            const normalizedWorkspacePath = normalizePathFromUri(workspaceFolderUri, this.features.logging)
            const memoryBankPath = `${normalizedWorkspacePath}/${MEMORY_BANK_DIRECTORY}`

            // Remove all existing memory bank files to ensure clean recreation
            const filesToRemove = ['product.md', 'structure.md', 'tech.md', 'guidelines.md']
            let removedCount = 0
            for (const fileName of filesToRemove) {
                const filePath = `${memoryBankPath}/${fileName}`
                try {
                    const exists = await this.features.workspace.fs.exists(filePath)
                    if (exists) {
                        await this.features.workspace.fs.rm(filePath)
                        removedCount++
                    }
                } catch (error) {
                    // Ignore errors when removing files that don't exist
                    this.features.logging.error(`Could not remove ${fileName}: ${error}`)
                }
            }

            if (removedCount > 0) {
                this.features.logging.info(`Memory Bank: cleaned ${removedCount} existing files`)
            }

            // Create the directory structure using mkdir with recursive option
            await this.features.workspace.fs.mkdir(memoryBankPath, { recursive: true })
        } catch (error) {
            this.features.logging.error(`Memory Bank directory creation failed: ${error}`)
            throw error
        }
    }

    /**
     * files discovery
     */
    async discoverAllSourceFiles(
        workspaceFolderUri: string,
        extensions: string[]
    ): Promise<Array<{ path: string; size: number; characters: number }>> {
        try {
            // Recursively discover all source files
            const allWorkspaceFolders = this.features.workspace.getAllWorkspaceFolders()

            const workspaceFolders = allWorkspaceFolders?.map(({ uri }) => {
                return normalizePathFromUri(uri, this.features.logging)
            }) ?? [normalizePathFromUri(workspaceFolderUri, this.features.logging)]

            // Collect files from all workspace folders
            let allSourceFiles: string[] = []

            for (const folder of workspaceFolders) {
                const sourceFiles = await this.discoverSourceFiles(folder, extensions)
                this.features.logging.info(`Found ${sourceFiles.length} files in "${folder}"`)
                allSourceFiles.push(...sourceFiles)
            }

            this.features.logging.info(`Total files discovered: ${allSourceFiles.length}`)

            // OPTIMIZATION: Parallel file size calculation with batching
            const batchSize = 10 // Process 10 files at a time
            const files: Array<{ path: string; size: number; characters: number }> = []

            for (let i = 0; i < allSourceFiles.length; i += batchSize) {
                const batch = allSourceFiles.slice(i, i + batchSize)
                const batchResults = await Promise.all(
                    batch.map(async filePath => {
                        const { lines, characters } = await this.readFileStats(filePath)
                        return { path: filePath, size: lines, characters }
                    })
                )
                files.push(...batchResults)
            }

            return files
        } catch (error) {
            this.features.logging.error(`Error in getAllFiles: ${error}`)
            return []
        }
    }

    /**
     * line counting
     */
    async calculateFileLineCount(filePath: string): Promise<number> {
        return (await this.readFileStats(filePath)).lines
    }

    /**
     * Line and character counts of a file; both are 0 if the file cannot be read
     */
    private async readFileStats(filePath: string): Promise<{ lines: number; characters: number }> {
        try {
            const content = await this.features.workspace.fs.readFile(filePath)
            return { lines: content.split('\n').length, characters: content.length }
        } catch (error) {
            this.features.logging.error(`Error reading file ${filePath}: ${error}`)
            return { lines: 0, characters: 0 }
        }
    }

    /**
     * lexical dissimilarity calculation
     */
    async calculateLexicalDissimilarity(
        files: Array<{ path: string; size: number }>
    ): Promise<Array<{ path: string; size: number; dissimilarity: number }>> {
        try {
            // OPTIMIZATION: Parallel file reading with batching
            const batchSize = 20 // Process 20 files at a time to reduce I/O overhead
            const fileContents: string[] = []
            let hasReadErrors = false

            for (let i = 0; i < files.length; i += batchSize) {
                const batch = files.slice(i, i + batchSize)
                const batchContents = await Promise.all(
                    batch.map(async file => {
                        try {
                            return await this.features.workspace.fs.readFile(file.path)
                        } catch (error) {
                            this.features.logging.warn(`Could not read file for TF-IDF analysis: ${file.path}`)
                            hasReadErrors = true
                            return '' // Empty content for unreadable files
                        }
                    })
                )
                fileContents.push(...batchContents)
            }

            // Check if all files are empty (no content to analyze)
            const hasContent = fileContents.some(content => content.trim().length > 0)
            if (!hasContent) {
                // If no files have content due to read errors, log as error
                if (hasReadErrors) {
                    this.features.logging.error(
                        'All files failed to read or are empty, using fallback dissimilarity values'
                    )
                }
                // If no files have content, return fallback values
                return files.map(f => ({ ...f, dissimilarity: 0.85 }))
            }

            // Step 2: Build sparse TF-IDF vectors for each file (TfidfVectorizer-style weighting)
            const tfidfVectors = await this.createTfidfVectors(fileContents)

            // Step 3: Mean cosine similarity of each file to all files, including itself
            const meanSimilarities = await this.calculateMeanCosineSimilarities(tfidfVectors)

            // Step 4: Lexical dissimilarity of each file (1 - mean similarity)
            return files.map((file, i) => ({
                path: file.path,
                size: file.size,
                dissimilarity: Math.max(0.0, Math.min(1.0, 1 - meanSimilarities[i])), // Ensure bounds [0,1]
            }))
        } catch (error) {
            this.features.logging.error(`Error in calculateLexicalDissimilarity: ${error}`)
            // Fallback to reasonable defaults if TF-IDF calculation fails
            return files.map(f => ({ ...f, dissimilarity: 0.85 }))
        }
    }

    /**
     * Create sparse TF-IDF vectors (tf * ln(numDocs / df)), one per document.
     *
     * Only non-zero weights are stored, so cost scales with the tokens in each document rather
     * than with the size of the combined vocabulary. Terms present in every document have an IDF
     * of 0 and are omitted, which leaves dot products and norms unchanged.
     */
    private async createTfidfVectors(documents: string[]): Promise<TfidfVector[]> {
        const yieldIfNeeded = createEventLoopYielder()
        const numDocs = documents.length

        // Term frequencies per document, and document frequencies across all documents
        const termFrequencies: Map<string, number>[] = []
        const documentFrequencies = new Map<string, number>()
        for (const document of documents) {
            const frequencies = new Map<string, number>()
            for (const token of this.tokenizeDocument(document)) {
                frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
            }
            for (const term of frequencies.keys()) {
                documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1)
            }
            termFrequencies.push(frequencies)
            await yieldIfNeeded()
        }

        const vectors: TfidfVector[] = []
        for (const frequencies of termFrequencies) {
            const weights = new Map<string, number>()
            let squaredNorm = 0
            for (const [term, tf] of frequencies) {
                const weight = tf * Math.log(numDocs / (documentFrequencies.get(term) ?? numDocs))
                if (weight !== 0) {
                    weights.set(term, weight)
                    squaredNorm += weight * weight
                }
            }
            vectors.push({ weights, norm: Math.sqrt(squaredNorm) })
            await yieldIfNeeded()
        }
        return vectors
    }

    /**
     * Mean cosine similarity of each vector to every vector, including itself.
     *
     * Self-similarity is 1 for a non-zero vector and 0 for a zero vector. The matrix is
     * symmetric, so each pair is computed once.
     */
    private async calculateMeanCosineSimilarities(vectors: TfidfVector[]): Promise<number[]> {
        const yieldIfNeeded = createEventLoopYielder()
        const vectorCount = vectors.length
        const similarityTotals = new Array<number>(vectorCount).fill(0)

        for (let sourceIndex = 0; sourceIndex < vectorCount; sourceIndex++) {
            if (vectors[sourceIndex].norm > 0) {
                similarityTotals[sourceIndex] += 1
            }
            for (let comparisonIndex = sourceIndex + 1; comparisonIndex < vectorCount; comparisonIndex++) {
                const similarity = this.calculateCosineSimilarity(vectors[sourceIndex], vectors[comparisonIndex])
                similarityTotals[sourceIndex] += similarity
                similarityTotals[comparisonIndex] += similarity
            }
            await yieldIfNeeded()
        }

        return similarityTotals.map(total => (vectorCount > 0 ? total / vectorCount : 0))
    }

    /**
     * Cosine similarity of two sparse vectors, iterating the smaller one
     */
    private calculateCosineSimilarity(vectorA: TfidfVector, vectorB: TfidfVector): number {
        if (vectorA.norm === 0 || vectorB.norm === 0) {
            return 0
        }
        const [smaller, larger] =
            vectorA.weights.size <= vectorB.weights.size
                ? [vectorA.weights, vectorB.weights]
                : [vectorB.weights, vectorA.weights]

        let dotProduct = 0
        for (const [term, weight] of smaller) {
            const other = larger.get(term)
            if (other !== undefined) {
                dotProduct += weight * other
            }
        }
        return dotProduct / (vectorA.norm * vectorB.norm)
    }

    /**
     * Tokenize document into terms (simple whitespace + punctuation splitting)
     */
    private tokenizeDocument(document: string): string[] {
        return document
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
            .split(/\s+/) // Split on whitespace
            .filter(token => token.length > 2) // Filter out very short tokens
    }

    /**
     * Execute the complete guidelines generation pipeline
     * https://code.amazon.com/packages/QIDEPersonalization/blobs/mainline/--/src/stylefile-gen.ipynb
     */
    async executeGuidelinesGenerationPipeline(workspaceFolderUri: string): Promise<{
        discoveredFiles: Array<{ path: string; size: number }>
        filesWithDissimilarity: Array<{ path: string; size: number; dissimilarity: number }>
        formattedFilesString: string
        rankedFilesList: string[]
    }> {
        try {
            // Step 1: Discover all source files
            // OPTIMIZATION: Prioritize common extensions first for faster discovery
            const extensions = [
                '.ts',
                '.js',
                '.tsx',
                '.jsx',
                '.py',
                '.java',
                '.cpp',
                '.c',
                '.h',
                '.cs',
                '.go',
                '.rs',
                '.php',
                '.rb',
                '.swift',
                '.kt',
                '.scala',
            ]

            const discoveredFiles = await this.discoverAllSourceFiles(workspaceFolderUri, extensions)

            if (discoveredFiles.length === 0) {
                throw new Error('No source files found in workspace')
            }

            // Filter out very large files to prevent conversation overflow. `size` is a line count,
            // so compare character length here; a single-line generated file can be megabytes.
            const MAX_FILE_SIZE_FOR_MEMORY_BANK = 20000 // characters (~20KB)
            const reasonableSizedFiles = discoveredFiles
                .filter(file => file.characters <= MAX_FILE_SIZE_FOR_MEMORY_BANK)
                .map(({ path, size }) => ({ path, size }))

            this.features.logging.debug(
                `Memory Bank analysis: filtered ${discoveredFiles.length - reasonableSizedFiles.length} files over ${MAX_FILE_SIZE_FOR_MEMORY_BANK} characters`
            )

            // Limit files to prevent memory exhaustion on large projects
            const MAX_FILES_FOR_ANALYSIS = 200
            let filesToAnalyze: Array<{ path: string; size: number }>

            if (reasonableSizedFiles.length > MAX_FILES_FOR_ANALYSIS) {
                const shuffled = [...reasonableSizedFiles].sort(() => Math.random() - 0.5)
                filesToAnalyze = shuffled.slice(0, MAX_FILES_FOR_ANALYSIS)
                this.features.logging.info(
                    `Memory Bank analysis: randomly selected ${filesToAnalyze.length} files (from ${reasonableSizedFiles.length} reasonable-sized files for ranking)`
                )
            } else {
                filesToAnalyze = reasonableSizedFiles
            }

            // Step 2: Calculate lexical dissimilarity using TF-IDF
            const filesWithDissimilarity = await this.calculateLexicalDissimilarity(filesToAnalyze)

            // Step 3: Sort by size
            filesWithDissimilarity.sort((a, b) => b.size - a.size)

            // Step 4: Format files string for LLM ranking
            const formattedFilesString = this.formatFilesForRanking(filesWithDissimilarity)

            // Step 5: Create fallback ranking (deterministic, for when LLM fails)
            const rankedFilesList = filesWithDissimilarity
                .sort((a, b) => b.dissimilarity - a.dissimilarity)
                .slice(0, MAX_NUMBER_OF_FILES_FOR_MEMORY_BANK_RANKING)
                .map(f => f.path)

            return {
                discoveredFiles: filesToAnalyze,
                filesWithDissimilarity,
                formattedFilesString,
                rankedFilesList,
            }
        } catch (error) {
            this.features.logging.error(`Memory Bank analysis pipeline failed: ${error}`)
            throw error
        }
    }

    /**
     * Format files for processing pipeline
     */
    formatFilesForRanking(files: Array<{ path: string; size: number; dissimilarity: number }>): string {
        // Files are already sorted by size in executeGuidelinesGenerationPipeline()
        return files
            .map(
                f =>
                    `${f.path} has ${f.size} lines and a mean lexical dissimilarity of ${f.dissimilarity.toFixed(6)} to the other files`
            )
            .join('\n')
    }

    /**
     * Recursively discover source files with given extensions
     */
    private async discoverSourceFiles(workspaceFolderUri: string, extensions: string[]): Promise<string[]> {
        const sourceFiles: string[] = []
        const traverseDirectory = async (dirPath: string): Promise<void> => {
            try {
                const entries = await this.features.workspace.fs.readdir(dirPath)

                for (const entry of entries) {
                    const fullPath = `${dirPath}/${entry.name}`

                    // Skip common directories that don't contain source code
                    if (entry.isDirectory() && this.shouldSkipDirectory(entry.name)) {
                        continue
                    }

                    if (entry.isDirectory()) {
                        // Directory - recurse
                        await traverseDirectory(fullPath)
                    } else {
                        // File - check if it's a source file
                        if (extensions.some(ext => entry.name.endsWith(ext))) {
                            sourceFiles.push(fullPath)
                        }
                    }
                }
            } catch (error) {
                this.features.logging.error(`Could not read directory ${dirPath}: ${error}`)
            }
        }

        await traverseDirectory(workspaceFolderUri)

        return sourceFiles
    }

    /**
     * Check if a directory should be skipped during source file discovery
     */
    private shouldSkipDirectory(dirName: string): boolean {
        // Comprehensive language-agnostic directory exclusions
        const skipDirs = [
            // Version Control Systems
            '.git',
            '.svn',
            '.hg',
            '.bzr',
            '.fossil-settings',

            // Package Managers & Dependencies
            'node_modules',
            'bower_components',
            'jspm_packages',
            'vendor',
            'packages',
            'deps',
            '_deps',
            'third_party',
            'external',
            'Pods',
            'Carthage',
            'DerivedData', // iOS/macOS
            'venv',
            'env',
            '.venv',
            '.env',
            'virtualenv',
            '__pycache__',
            '.tox', // Python
            'gems',
            '.bundle', // Ruby
            'composer', // PHP
            'node_modules',
            'elm-stuff', // Elm
            'target',
            'project/target',
            'project/project', // Scala/SBT

            // Build Outputs & Artifacts
            'build',
            'builds',
            'dist',
            'out',
            'output',
            'bin',
            'obj',
            'lib',
            'release',
            'debug',
            'Release',
            'Debug',
            'x64',
            'x86',
            'AnyCPU',
            '.next',
            '.nuxt',
            '.output',
            '.vercel',
            '.netlify', // Web frameworks
            'public/build',
            'static/build',
            'assets/build',
            'cmake-build-debug',
            'cmake-build-release', // CMake
            '_build',
            'ebin',
            'deps', // Erlang/Elixir
            'zig-cache',
            'zig-out', // Zig

            // IDE & Editor Directories
            '.vscode',
            '.idea',
            '.vs',
            '.vscode-test',
            '.eclipse',
            '.metadata',
            '.settings',
            '.project',
            '.classpath',
            '.atom',
            '.sublime-project',
            '.sublime-workspace',
            '__pycache__',
            '.mypy_cache',
            '.dmypy.json', // Python
            '.dart_tool',
            '.flutter-plugins',
            '.flutter-plugins-dependencies', // Dart/Flutter

            // Testing & Coverage
            'coverage',
            '.coverage',
            '.nyc_output',
            '.pytest_cache',
            '.cache',
            'htmlcov',
            'test-results',
            'test-reports',
            'allure-results',
            'junit',
            'xunit',
            'nunit',
            'TestResults',
            '.jest',
            'jest_html_reporters.html',

            // Logs & Temporary Files
            'logs',
            'log',
            'tmp',
            'temp',
            '.tmp',
            '.temp',
            'crash-reports',
            'error-reports',

            // Documentation Build Outputs
            '_site',
            '.jekyll-cache',
            '.jekyll-metadata', // Jekyll
            'docs/_build',
            'doc/_build',
            'documentation/_build', // Sphinx
            '.docusaurus',
            'website/build', // Docusaurus
            'book',
            '_book', // GitBook/mdBook

            // Language-Specific Caches & Artifacts
            '.gradle',
            'gradle', // Gradle
            '.m2',
            '.ivy2', // Maven/Ivy
            '.stack-work',
            '.cabal-sandbox',
            'cabal.sandbox.config', // Haskell
            '_opam',
            '.opam', // OCaml
            'Cargo.lock', // Rust (keep Cargo.toml but skip lock in some cases)
            '.cargo', // Rust cache
            '.mix',
            '_build', // Elixir
            'rebar3.crashdump',
            '_checkouts', // Erlang
            '.rebar',
            '.rebar3',
            'priv/static', // Phoenix framework

            // OS-Specific
            '.DS_Store',
            'Thumbs.db',
            'Desktop.ini',
            '$RECYCLE.BIN',
            '.Trash-*',
            '.fuse_hidden*',

            // Cloud & Deployment
            '.serverless',
            '.aws-sam',
            '.terraform',
            '.pulumi',
            'cdk.out',
            '.cdk.staging',
            'amplify',

            // Mobile Development
            'ios/build',
            'android/build',
            'android/.gradle',
            'ios/Pods',
            'android/app/build',

            // Game Development
            'Library',
            'Temp',
            'Obj',
            'Build',
            'Builds', // Unity
            'Intermediate',
            'Binaries',
            'DerivedDataCache', // Unreal

            // Database
            '*.db-journal',
            '*.sqlite-journal',

            // Backup & Archive
            'backup',
            'backups',
            '.backup',
            'archive',
            'archives',
        ]

        // Skip any directory starting with . (hidden directories) except some important ones
        if (dirName.startsWith('.')) {
            const allowedHiddenDirs = ['.github', '.gitlab', '.circleci', '.travis', '.azure', '.devcontainer']
            return !allowedHiddenDirs.includes(dirName)
        }

        return skipDirs.includes(dirName)
    }

    /**
     * Check if memory bank exists in workspace
     */
    async memoryBankExists(workspaceFolderUri: string): Promise<boolean> {
        try {
            const normalizedWorkspacePath = normalizePathFromUri(workspaceFolderUri, this.features.logging)
            const memoryBankPath = `${normalizedWorkspacePath}/${MEMORY_BANK_DIRECTORY}`

            this.features.logging.info(`Memory Bank: Checking existence at path: "${memoryBankPath}"`)

            const exists = await this.features.workspace.fs.exists(memoryBankPath)
            if (!exists) {
                this.features.logging.info(`Memory Bank: Directory does not exist: "${memoryBankPath}"`)
                return false
            }

            // Check if at least one memory bank file exists
            const files = Object.values(MEMORY_BANK_FILES)
            let foundFiles = 0
            for (const file of files) {
                const filePath = `${memoryBankPath}/${file}`
                const fileExists = await this.features.workspace.fs.exists(filePath)
                if (fileExists) {
                    foundFiles++
                }
            }

            const hasFiles = foundFiles > 0
            if (hasFiles) {
                this.features.logging.info(`Memory Bank: Found ${foundFiles} existing memory bank files`)
            } else {
                this.features.logging.info(`Memory Bank: No existing memory bank files found`)
            }

            return hasFiles
        } catch (error) {
            this.features.logging.error(`Error checking memory bank existence: ${error}`)
            return false
        }
    }
}
