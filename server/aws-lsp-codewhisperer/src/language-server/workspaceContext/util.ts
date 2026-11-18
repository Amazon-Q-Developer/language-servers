import { CredentialsProvider, WorkspaceFolder } from '@aws/language-server-runtimes/server-interface'
import { CreateUploadUrlResponse } from '@amzn/codewhisperer-runtime'
import { URI } from 'vscode-uri'
import * as fs from 'fs'
import * as crypto from 'crypto'
import * as path from 'path'
import axios from 'axios'
import { workspaceUtils } from '@aws/lsp-core'

export const findWorkspaceRootFolder = (
    fileUri: string,
    workspaceFolders: WorkspaceFolder[]
): WorkspaceFolder | undefined => {
    const parsedFileUri = URI.parse(fileUri)

    // Sort workspace folders by path length (descending) to find most specific match first
    const sortedFolders = [...workspaceFolders].sort((a, b) => {
        const aPath = URI.parse(a.uri).path
        const bPath = URI.parse(b.uri).path
        return bPath.length - aPath.length // Longest path first
    })

    const matchingFolder = sortedFolders.find(folder => {
        const parsedFolderUri = URI.parse(folder.uri)
        // Paths are normalized to use forward slashes in the .path property regardless of the underlying OS
        const folderPath = parsedFolderUri.path.endsWith('/') ? parsedFolderUri.path : parsedFolderUri.path + '/'
        return parsedFileUri.path.startsWith(folderPath)
    })

    return matchingFolder
}

/**
 * Helper function to normalize relative path e.g : src/java/test.java to file:///src/java/test/java for workspace context
 */
export const normalizeFileUri = (fileUri: string): string => {
    return fileUri.startsWith('file://') ? fileUri : `file://${fileUri.startsWith('/') ? fileUri : '/' + fileUri}`
}

export const cleanUrl = (s3Url: string): string => {
    return new URL(s3Url).origin + new URL(s3Url).pathname
}

export const uploadArtifactToS3 = async (content: Buffer, resp: CreateUploadUrlResponse) => {
    const encryptionContext = `{"WorkspaceId":"${resp.uploadId}"}`
    let headersObj = resp.requestHeaders
        ? {
              'x-amz-checksum-sha256': resp.requestHeaders['x-amz-checksum-sha256'],
              'x-amz-expected-bucket-owner': resp.requestHeaders['x-amz-expected-bucket-owner'],
              'Content-Type': resp.requestHeaders['content-type'],
          }
        : {}
    if (resp.kmsKeyArn) {
        Object.assign(headersObj, {
            'x-amz-server-side-encryption': 'aws:kms',
            'x-amz-server-side-encryption-aws-kms-key-id': resp.kmsKeyArn,
            'x-amz-server-side-encryption-context': Buffer.from(encryptionContext, 'utf8').toString('base64'),
        })
    }
    await axios.put(resp.uploadUrl ?? 'invalid-url', content, { headers: headersObj })
}

export const isDirectory = (path: string): boolean => {
    return fs.statSync(URI.parse(path).path).isDirectory()
}

/**
 * Real path of filePath if it is strictly inside rootPath once symlinks in both are resolved, otherwise
 * undefined. Also undefined when either path does not exist.
 */
export const resolvePathInside = (filePath: string, rootPath: string): string | undefined => {
    try {
        const realRoot = fs.realpathSync(rootPath)
        const realPath = fs.realpathSync(filePath)
        return workspaceUtils.isParentFolder(realRoot, realPath) ? realPath : undefined
    } catch {
        return undefined
    }
}

export const isEmptyDirectory = (path: string): boolean => {
    return fs.readdirSync(URI.parse(path).path).length === 0
}

export const isLoggedInUsingBearerToken = (credentialsProvider: CredentialsProvider): boolean => {
    return credentialsProvider.hasCredentials('bearer')
}

export const getSha256Async = async (content: string | Buffer): Promise<string> => {
    return crypto.createHash('sha256').update(content).digest('base64')
}

export const getRelativePath = (workspaceFolder: WorkspaceFolder, filePath: string): string => {
    const workspaceUri = URI.parse(workspaceFolder.uri)
    const fileUri = URI.parse(filePath)
    return path.relative(workspaceUri.path, fileUri.path)
}

export const getRelativePathWithUri = (uri: string, workspaceFolder?: WorkspaceFolder | null): string => {
    const documentUri = URI.parse(uri)
    const workspaceUri = workspaceFolder?.uri
    const workspaceRoot = workspaceUri ? URI.parse(workspaceUri).fsPath : process.cwd()
    const absolutePath = documentUri.fsPath
    return path.relative(workspaceRoot, absolutePath)
}

// Include workspace folder name to disambiguate files when there are multiple workspace folders
export const getRelativePathWithWorkspaceFolder = (workspaceFolder: WorkspaceFolder, filePath: string): string => {
    const workspaceUri = URI.parse(workspaceFolder.uri)
    const fileUri = URI.parse(filePath)
    const relativePath = path.relative(workspaceUri.fsPath, fileUri.fsPath)
    const workspaceFolderName = path.basename(workspaceUri.fsPath)
    return path.join(workspaceFolderName, relativePath)
}
