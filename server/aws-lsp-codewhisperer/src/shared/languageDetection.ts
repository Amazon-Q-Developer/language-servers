import { TextDocument } from '@aws/language-server-runtimes/server-interface'

export type CodewhispererLanguage =
    | 'abap'
    | 'c'
    | 'cpp'
    | 'csharp'
    | 'dart'
    | 'go'
    | 'java'
    | 'javascript'
    | 'json'
    | 'jsx'
    | 'kotlin'
    | 'lua'
    | 'php'
    | 'plaintext'
    | 'powershell'
    | 'python'
    | 'r'
    | 'ruby'
    | 'rust'
    | 'scala'
    | 'shell'
    | 'sql'
    | 'swift'
    | 'systemverilog'
    | 'tf'
    | 'tsx'
    | 'typescript'
    | 'vue'
    | 'yaml'
    | 'systemVerilog'

type RuntimeLanguage = Exclude<CodewhispererLanguage, 'jsx' | 'tsx' | 'systemVerilog'> | 'systemverilog'

const runtimeLanguageSet: ReadonlySet<RuntimeLanguage> = new Set([
    'abap',
    'c',
    'cpp',
    'csharp',
    'go',
    'java',
    'javascript',
    'kotlin',
    'php',
    'python',
    'ruby',
    'rust',
    'scala',
    'shell',
    'sql',
    'typescript',
    'json',
    'yaml',
    'tf',
    'systemverilog',
])

// This will be extended as more language features
// are integrated into the language server and clients.
// See: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.18/specification/#textDocumentItem
const supportedFileTypes: CodewhispererLanguage[] = [
    'abap',
    'c',
    'cpp',
    'csharp',
    'dart',
    'go',
    'java',
    'javascript',
    'json',
    'jsx',
    'kotlin',
    'lua',
    'php',
    'powershell',
    'python',
    'r',
    'ruby',
    'rust',
    'scala',
    'shell',
    'sql',
    'swift',
    'systemverilog',
    'tf',
    'typescript',
    'vue',
    'yaml',
    'tsx',
]

export const supportedSecurityScanLanguages: CodewhispererLanguage[] = ['csharp']

export const supportedWorkspaceContextLanguages: CodewhispererLanguage[] = [
    'java',
    'python',
    'javascript',
    'typescript',
]

export const languageByExtension: { [key: string]: CodewhispererLanguage } = {
    '.abap': 'abap',
    '.c': 'c',
    '.cpp': 'cpp',
    '.cs': 'csharp',
    '.dart': 'dart',
    '.h': 'c',
    '.hcl': 'tf',
    '.cc': 'cpp',
    '.hpp': 'cpp',
    '.go': 'go',
    '.java': 'java',
    '.js': 'javascript',
    '.json': 'json',
    '.jsonc': 'json',
    '.jsx': 'jsx',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.lua': 'lua',
    '.wlua': 'lua',
    '.php': 'php',
    '.ps1': 'powershell',
    '.psm1': 'powershell',
    '.py': 'python',
    '.r': 'r',
    '.rb': 'ruby',
    '.rs': 'rust',
    '.sc': 'scala',
    '.scala': 'scala',
    '.sh': 'shell',
    '.sql': 'sql',
    '.sv': 'systemverilog',
    '.svh': 'systemverilog',
    '.swift': 'swift',
    '.tf': 'tf',
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.vh': 'systemverilog',
    '.vue': 'vue',
    '.yaml': 'yaml',
    '.yml': 'yaml',
}

// some are exact match and some like javascriptreact and shellscript are not
export const qLanguageIdByDocumentLanguageId: { [key: string]: CodewhispererLanguage } = {
    abap: 'abap',
    c: 'c',
    cpp: 'cpp',
    csharp: 'csharp',
    dart: 'dart',
    go: 'go',
    java: 'java',
    javascript: 'javascript',
    javascriptreact: 'jsx',
    json: 'json',
    jsx: 'jsx',
    kotlin: 'kotlin',
    lua: 'lua',
    powershell: 'powershell',
    php: 'php',
    python: 'python',
    r: 'r',
    ruby: 'ruby',
    rust: 'rust',
    scala: 'scala',
    shell: 'shell',
    shellscript: 'shell',
    sql: 'sql',
    swift: 'swift',
    systemverilog: 'systemverilog',
    tf: 'tf',
    terraform: 'tf',
    typescript: 'typescript',
    typescriptreact: 'tsx',
    vue: 'vue',
    yaml: 'yaml',
    yml: 'yaml',
    // Some IDEs (e.g. VS Code) report docker-compose files with the 'dockercompose'
    // language id rather than 'yaml'; treat it as YAML so completions are provided.
    dockercompose: 'yaml',
}

export const getSupportedLanguageId = (
    textDocument: TextDocument | undefined,
    supportedLanguageIds: CodewhispererLanguage[] = supportedFileTypes
): CodewhispererLanguage | undefined => {
    if (!textDocument) {
        return
    }

    const languageId = getLanguageId(textDocument)

    return languageId && supportedLanguageIds.includes(languageId) ? languageId : undefined
}

export const getLanguageId = (textDocument: TextDocument | undefined): CodewhispererLanguage | undefined => {
    if (!textDocument) {
        return undefined
    }

    return (
        getCodeWhispererLanguageIdByTextDocumentLanguageId(textDocument.languageId) ||
        getCodeWhispererLanguageIdByExtension(textDocument)
    )
}

/**
 * Used to map different IDE values for TextDocument languageIds to CodeWhisperer languageIds.
 * Examples of the CodeWhisperer defined language ids can be found in service-2.json, near "ProgrammingLanguageLanguageNameString"
 * @param textDocumentLanguageId Value of the TextDocument's language id, provided by the IDE
 * @returns Corresponding CodeWhisperer language id
 */
function getCodeWhispererLanguageIdByTextDocumentLanguageId(
    textDocumentLanguageId: CodewhispererLanguage | string
): CodewhispererLanguage | undefined {
    if (textDocumentLanguageId === undefined) {
        return undefined
    } else if (qLanguageIdByDocumentLanguageId[textDocumentLanguageId]) {
        return qLanguageIdByDocumentLanguageId[textDocumentLanguageId]
    }

    // IDEs can identify a file's languageId using non-standardized values
    // Eg: 'CSHARP', 'CSharp' => 'csharp'
    // Try to map case-insensitive matches to increase the likelihood of supporting the file in an IDE.
    for (const [languageId, cwprLanguageId] of Object.entries(qLanguageIdByDocumentLanguageId)) {
        if (textDocumentLanguageId.toLowerCase() === languageId.toLowerCase()) {
            return cwprLanguageId
        }
    }

    return undefined
}

function getCodeWhispererLanguageIdByExtension(textDocument: TextDocument) {
    for (const [extension, languageId] of Object.entries(languageByExtension)) {
        if (textDocument.uri.endsWith(extension)) {
            return languageId
        }
    }

    return undefined
}

/**
 * Normalize client side language id to service aware language id (service is not aware of jsx/tsx)
 * Only used when invoking CodeWhisperer service API, for client usage please use normalizeLanguage
 * Client side CodewhispererLanguage is a superset of NormalizedLanguageId
 */
export const getRuntimeLanguage = (language: CodewhispererLanguage): RuntimeLanguage => {
    switch (language) {
        case 'jsx':
            return 'javascript'

        case 'tsx':
            return 'typescript'

        case 'systemVerilog':
            return 'systemverilog'

        default:
            if (!runtimeLanguageSet.has(language)) {
                // return passed one in case passed one does not lie in the runtimeLanguageSet
            }
            return language
    }
}

/**
 * Determines the CodeWhisperer language identifier based on a file path's extension.
 * This function maps file extensions to their corresponding CodeWhisperer language IDs
 * using the languageByExtension mapping.
 *
 * @param filePath - The complete file path to analyze. This should include the file extension
 *                  (e.g., '/path/to/file.js', 'script.py', etc.)
 *
 * @returns {CodewhispererLanguage | undefined} - Returns the corresponding CodeWhisperer
 *          language identifier if a matching extension is found, undefined otherwise.
 *          The returned language ID is compatible with CodeWhisperer's expected format.
 *
 * @example
 * // Returns 'javascript' for a .js file
 * getCodeWhispererLanguageIdFromPath('src/app.js')
 *
 * // Returns 'python' for a .py file
 * getCodeWhispererLanguageIdFromPath('script.py')
 *
 * // Returns undefined for unsupported extensions
 * getCodeWhispererLanguageIdFromPath('document.txt')
 *
 * @remarks
 * - This function is extension-based only
 */
export function getCodeWhispererLanguageIdFromPath(filePath: string): CodewhispererLanguage | undefined {
    if (filePath.endsWith(`package.json`)) {
        return 'javascript'
    }

    for (const [extension, languageId] of Object.entries(languageByExtension)) {
        if (filePath.endsWith(extension)) {
            return getRuntimeLanguage(languageId)
        }
    }

    return undefined
}

/**
 * For project context we're treating these file name as java project file to be uploaded to container & using it's location to identify java roots
 * Kotlin may also have these file but for project context we're only considering it for java until we have language support for kotlin
 * @param filePath
 * @returns boolean indicate the java file override
 *
 * @example
 * // Returns 'true' for a build.gradle file
 * isJavaProjectFileFromPath('src/build.gradle')
 *
 * @remarks
 * - This function is extension-based only
 */
export function isJavaProjectFileFromPath(filePath: string): boolean {
    return (
        filePath.endsWith(`build.gradle`) ||
        filePath.endsWith(`build.gradle.kts`) ||
        filePath.endsWith(`pom.xml`) ||
        filePath.endsWith(`build.xml`)
    )
}
