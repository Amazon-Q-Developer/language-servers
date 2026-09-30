/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { CodeReviewUtils } from './codeReviewUtils'
import { SKIP_DIRECTORIES, EXTENSION_TO_LANGUAGE } from './codeReviewConstants'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as https from 'https'
import JSZip = require('jszip')
import * as childProcess from 'child_process'
import * as sinon from 'sinon'
import { assert } from 'sinon'
import { expect } from 'chai'
import { CancellationError } from '@aws/lsp-core'
import { Features } from '@aws/language-server-runtimes/server-interface/server'
import { CodeReviewMetric, SuccessMetricName, FailedMetricName } from './codeReviewTypes'

describe('CodeReviewUtils', () => {
    // Sinon sandbox for managing stubs
    let sandbox: sinon.SinonSandbox

    // Mock logging object
    const mockLogging = {
        log: sinon.stub(),
        info: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
        debug: sinon.stub(),
    }

    beforeEach(() => {
        sandbox = sinon.createSandbox()
        // Reset stubs
        mockLogging.info.reset()
        mockLogging.warn.reset()
        mockLogging.error.reset()
        mockLogging.debug.reset()
    })

    afterEach(() => {
        sandbox.restore()
    })

    describe('shouldSkipFile', () => {
        it('should skip files with no extension', () => {
            expect(CodeReviewUtils.shouldSkipFile('file')).to.be.true
        })

        it('should skip files with empty extension', () => {
            expect(CodeReviewUtils.shouldSkipFile('file.')).to.be.true
        })

        it('should not skip files with supported extensions', () => {
            expect(CodeReviewUtils.shouldSkipFile('file.js')).to.be.false
            expect(CodeReviewUtils.shouldSkipFile('file.py')).to.be.false
            expect(CodeReviewUtils.shouldSkipFile('file.ts')).to.be.false
        })

        it('should skip files with unsupported extensions', () => {
            expect(CodeReviewUtils.shouldSkipFile('file.xyz')).to.be.true
        })

        it('should handle uppercase extensions', () => {
            expect(CodeReviewUtils.shouldSkipFile('file.JS')).to.be.false
            expect(CodeReviewUtils.shouldSkipFile('file.PY')).to.be.false
        })
    })

    describe('shouldSkipDirectory', () => {
        it('should skip directories in the skip list', () => {
            SKIP_DIRECTORIES.forEach(dir => {
                expect(CodeReviewUtils.shouldSkipDirectory(dir)).to.be.true
            })
        })

        it('should not skip directories not in the skip list', () => {
            expect(CodeReviewUtils.shouldSkipDirectory('src')).to.be.false
            expect(CodeReviewUtils.shouldSkipDirectory('app')).to.be.false
        })
    })

    describe('getFolderPath', () => {
        beforeEach(() => {
            // Stub path.extname and path.dirname
            sandbox.stub(path, 'extname').callsFake((p: string) => {
                const lastDotIndex = p.lastIndexOf('.')
                return lastDotIndex !== -1 ? p.substring(lastDotIndex) : ''
            })

            sandbox.stub(path, 'dirname').callsFake((p: string) => {
                const lastSlashIndex = p.lastIndexOf('/')
                return lastSlashIndex !== -1 ? p.substring(0, lastSlashIndex) : p
            })
        })

        it('should return directory path for file paths', () => {
            expect(CodeReviewUtils.getFolderPath('/path/to/file.js')).to.equal('/path/to')
        })

        it('should return the same path for directory paths', () => {
            expect(CodeReviewUtils.getFolderPath('/path/to/dir')).to.equal('/path/to/dir')
        })

        it('should handle paths with trailing slashes', () => {
            expect(CodeReviewUtils.getFolderPath('/path/to/dir/')).to.equal('/path/to/dir')
        })
    })

    describe('logZipSummary', () => {
        it('should log zip summary information', () => {
            const mockZip = {
                files: {
                    'file1.js': { dir: false },
                    'file2.ts': { dir: false },
                    'dir1/': { dir: true },
                    'dir2/': { dir: true },
                    'dir1/file3.py': { dir: false },
                },
            } as unknown as JSZip

            CodeReviewUtils.logZipSummary(mockZip, mockLogging)

            sinon.assert.calledWith(mockLogging.info, 'Zip summary: 3 files, 2 folders')
            sinon.assert.calledWith(
                mockLogging.info,
                sinon.match(str => str.includes('Zip structure:'))
            )
        })

        it('should handle errors gracefully', () => {
            const mockZip = {} as unknown as JSZip

            CodeReviewUtils.logZipSummary(mockZip, mockLogging)

            sinon.assert.calledWith(
                mockLogging.warn,
                sinon.match(str => str.includes('Failed to generate zip summary'))
            )
        })
    })

    describe('generateClientToken', () => {
        it('should generate a unique token', () => {
            const token1 = CodeReviewUtils.generateClientToken()
            const token2 = CodeReviewUtils.generateClientToken()

            expect(token1).to.match(/^code-scan-\d+-[a-z0-9]+$/)
            expect(token2).to.match(/^code-scan-\d+-[a-z0-9]+$/)
            expect(token1).to.not.equal(token2)
        })
    })

    describe('executeGitCommand', () => {
        it('should execute git via execFile (no shell) and return trimmed output on success', async () => {
            const execFileStub = sandbox
                .stub(childProcess, 'execFile')
                .callsFake((file: any, args: any, options: any, callback: any) => {
                    callback(null, 'command output\n', '')
                    return {} as childProcess.ChildProcess
                })

            const result = await CodeReviewUtils.executeGitCommand(
                ['diff', '--', ':(literal)/repo/file.ts'],
                '/repo',
                'unstaged',
                mockLogging
            )
            expect(result).to.equal('command output')

            // The binary is the literal 'git', the argv is passed verbatim, the
            // working directory is set via cwd, and no shell option is present.
            const [file, args, options] = execFileStub.firstCall.args as unknown as [string, string[], any]
            expect(file).to.equal('git')
            expect(args).to.deep.equal(['diff', '--', ':(literal)/repo/file.ts'])
            expect(options.cwd).to.equal('/repo')
            expect(options.shell).to.be.undefined
        })

        it('should handle errors and return empty string', async () => {
            sandbox.stub(childProcess, 'execFile').callsFake((file: any, args: any, options: any, callback: any) => {
                callback(new Error('git error'), '', 'error output')
                return {} as childProcess.ChildProcess
            })

            const result = await CodeReviewUtils.executeGitCommand(['diff'], '/repo', 'status', mockLogging)
            expect(result).to.equal('')
            sinon.assert.calledWith(
                mockLogging.warn,
                sinon.match(str => str.includes('Git diff failed for status'))
            )
        })
    })

    describe('git command construction (path-injection hardening)', () => {
        let executeGitCommandStub: sinon.SinonStub

        beforeEach(() => {
            executeGitCommandStub = sandbox.stub(CodeReviewUtils, 'executeGitCommand').resolves('')
        })

        it('getGitDiff builds argv with a -- separator and a literal pathspec (no shell string)', async () => {
            await CodeReviewUtils.getGitDiff('/repo/src/app.ts', mockLogging)

            sinon.assert.calledWithExactly(
                executeGitCommandStub,
                ['diff', '--', ':(literal)/repo/src/app.ts'],
                '/repo/src',
                'unstaged',
                mockLogging
            )
            sinon.assert.calledWithExactly(
                executeGitCommandStub,
                ['diff', '--staged', '--', ':(literal)/repo/src/app.ts'],
                '/repo/src',
                'staged',
                mockLogging
            )
        })

        it('getGitDiffNames builds --name-only argv with a -- separator and a literal pathspec', async () => {
            await CodeReviewUtils.getGitDiffNames('/repo/src/app.ts', mockLogging)

            sinon.assert.calledWithExactly(
                executeGitCommandStub,
                ['diff', '--name-only', '--', ':(literal)/repo/src/app.ts'],
                '/repo/src',
                'unstaged name only',
                mockLogging
            )
            sinon.assert.calledWithExactly(
                executeGitCommandStub,
                ['diff', '--name-only', '--staged', '--', ':(literal)/repo/src/app.ts'],
                '/repo/src',
                'staged name only',
                mockLogging
            )
        })

        it('passes shell-metacharacter and glob paths verbatim as a single literal pathspec argument', async () => {
            // Inert special-character names. A shell command line would split or
            // expand these; execFile + ':(literal)' + '--' pass them to git as a
            // single, literal argv element instead.
            const trickyPath = '/repo/notes; echo hi.txt'
            await CodeReviewUtils.getGitDiff(trickyPath, mockLogging)

            const firstArgv = executeGitCommandStub.firstCall.args[0] as string[]
            expect(firstArgv).to.deep.equal(['diff', '--', `:(literal)${trickyPath}`])
            // The entire path is exactly one argv element (no shell tokenization).
            expect(firstArgv[firstArgv.length - 1]).to.equal(`:(literal)${trickyPath}`)

            executeGitCommandStub.resetHistory()

            const globPath = '/repo/*.ts'
            await CodeReviewUtils.getGitDiffNames(globPath, mockLogging)
            const namesArgv = executeGitCommandStub.firstCall.args[0] as string[]
            expect(namesArgv).to.deep.equal(['diff', '--name-only', '--', `:(literal)${globPath}`])
        })
    })

    describe('getGitDiff', () => {
        let getFolderPathStub: sinon.SinonStub
        let executeGitCommandStub: sinon.SinonStub

        beforeEach(() => {
            // Stub getFolderPath and executeGitCommand
            getFolderPathStub = sandbox.stub(CodeReviewUtils, 'getFolderPath').returns('/mock/path')
            executeGitCommandStub = sandbox.stub(CodeReviewUtils, 'executeGitCommand')
            executeGitCommandStub.callsFake(async cmd => {
                if (cmd.includes('--staged')) {
                    return 'staged diff'
                }
                return 'unstaged diff'
            })
        })

        it('should get combined git diff for a path', async () => {
            const result = await CodeReviewUtils.getGitDiff('/mock/path/file.js', mockLogging)
            expect(result).to.equal('unstaged diff\n\nstaged diff')
            sinon.assert.calledTwice(executeGitCommandStub)
        })

        it('should return null if no diff is found', async () => {
            executeGitCommandStub.resolves('')
            const result = await CodeReviewUtils.getGitDiff('/mock/path/file.js', mockLogging)
            expect(result).to.be.null
        })

        it('should handle errors', async () => {
            executeGitCommandStub.rejects(new Error('git error'))
            const result = await CodeReviewUtils.getGitDiff('/mock/path/file.js', mockLogging)
            expect(result).to.be.null
            sinon.assert.calledWith(
                mockLogging.error,
                sinon.match(str => str.includes('Error getting git diff'))
            )
        })
    })

    describe('logZipStructure', () => {
        it('should log zip file structure', () => {
            const mockZip = {
                files: {
                    'file1.js': { dir: false },
                    'dir1/': { dir: true },
                    'dir1/file2.ts': { dir: false },
                },
            } as unknown as JSZip

            CodeReviewUtils.logZipStructure(mockZip, 'test-zip', mockLogging)

            sinon.assert.calledWith(mockLogging.info, 'test-zip zip structure:')
            sinon.assert.calledWith(mockLogging.info, '  file1.js')
            sinon.assert.calledWith(mockLogging.info, '  dir1/file2.ts')
        })
    })

    describe('countZipFiles', () => {
        it('should count files in zip correctly', () => {
            const mockZip = {
                files: {
                    'file1.js': { dir: false },
                    'dir1/': { dir: true },
                    'dir1/file2.ts': { dir: false },
                    'dir2/': { dir: true },
                    'dir2/file3.py': { dir: false },
                },
            } as unknown as JSZip

            const [count, files] = CodeReviewUtils.countZipFiles(mockZip)
            expect(count).to.equal(3)
            expect(files).to.deep.equal(new Set(['file1.js', 'dir1/file2.ts', 'dir2/file3.py']))
        })

        it('should return 0 for empty zip', () => {
            const mockZip = { files: {} } as unknown as JSZip
            const [count, files] = CodeReviewUtils.countZipFiles(mockZip)
            expect(count).to.equal(0)
            expect(files).to.deep.equal(new Set())
        })
    })

    describe('generateZipBuffer', () => {
        it('should call generateAsync with correct options', async () => {
            const generateAsyncStub = sandbox.stub().resolves(Buffer.from('zip-data'))
            const mockZip = {
                generateAsync: generateAsyncStub,
            } as unknown as JSZip

            await CodeReviewUtils.generateZipBuffer(mockZip)

            sinon.assert.calledWith(generateAsyncStub, {
                type: 'nodebuffer',
                compression: 'DEFLATE',
                compressionOptions: { level: 9 },
            })
        })
    })

    describe('saveZipToDownloads', () => {
        let homedirStub: sinon.SinonStub
        let pathJoinStub: sinon.SinonStub
        let toISOStringStub: sinon.SinonStub
        let writeFileSyncStub: sinon.SinonStub

        beforeEach(() => {
            homedirStub = sandbox.stub(os, 'homedir').returns('/home/user')
            pathJoinStub = sandbox.stub(path, 'join').callsFake((...args) => args.join('/'))
            toISOStringStub = sandbox.stub(Date.prototype, 'toISOString').returns('2023-01-01T12:00:00.000Z')
            writeFileSyncStub = sandbox.stub(fs, 'writeFileSync')
        })

        it('should save zip buffer to downloads folder', () => {
            const mockBuffer = Buffer.from('zip-data')

            CodeReviewUtils.saveZipToDownloads(mockBuffer, mockLogging)

            sinon.assert.calledWith(
                writeFileSyncStub,
                '/home/user/Downloads/codeArtifact-2023-01-01T12-00-00-000Z.zip',
                mockBuffer
            )
            sinon.assert.calledWith(
                mockLogging.info,
                sinon.match(str => str.includes('Saved code artifact zip to:'))
            )
        })

        it('should handle errors', () => {
            writeFileSyncStub.throws(new Error('write error'))

            const mockBuffer = Buffer.from('zip-data')
            CodeReviewUtils.saveZipToDownloads(mockBuffer, mockLogging)

            sinon.assert.calledWith(
                mockLogging.error,
                sinon.match(str => str.includes('Failed to save zip file'))
            )
        })
    })

    describe('processArtifactWithDiff', () => {
        let getGitDiffStub: sinon.SinonStub

        beforeEach(() => {
            getGitDiffStub = sandbox.stub(CodeReviewUtils, 'getGitDiff').resolves('mock diff')
        })

        it('should return empty string if not a code diff scan', async () => {
            const result = await CodeReviewUtils.processArtifactWithDiff({ path: '/path/file.js' }, false, mockLogging)
            expect(result).to.equal('')
            sinon.assert.notCalled(getGitDiffStub)
        })

        it('should return diff with newline if code diff scan', async () => {
            const result = await CodeReviewUtils.processArtifactWithDiff({ path: '/path/file.js' }, true, mockLogging)
            expect(result).to.equal('mock diff\n')
            sinon.assert.calledWith(getGitDiffStub, '/path/file.js', mockLogging)
        })

        it('should handle null diff result', async () => {
            getGitDiffStub.resolves(null)
            const result = await CodeReviewUtils.processArtifactWithDiff({ path: '/path/file.js' }, true, mockLogging)
            expect(result).to.equal('')
        })

        it('should handle errors', async () => {
            getGitDiffStub.rejects(new Error('diff error'))
            const result = await CodeReviewUtils.processArtifactWithDiff({ path: '/path/file.js' }, true, mockLogging)
            expect(result).to.equal('')
            sinon.assert.calledWith(
                mockLogging.warn,
                sinon.match(str => str.includes('Failed to get git diff'))
            )
        })
    })

    describe('withErrorHandling', () => {
        it('should return operation result on success', async () => {
            const operation = sandbox.stub().resolves('success')

            const result = await CodeReviewUtils.withErrorHandling(
                operation,
                'Error message',
                mockLogging,
                '/path/file.js'
            )

            expect(result).to.equal('success')
            sinon.assert.calledOnce(operation)
        })

        it('should handle errors and log them', async () => {
            const error = new Error('operation failed')
            const operation = sandbox.stub().rejects(error)

            try {
                await CodeReviewUtils.withErrorHandling(operation, 'Error message', mockLogging, '/path/file.js')
                // Should not reach here
                expect.fail('Expected error was not thrown')
            } catch (e: any) {
                // The error message is formatted with the error message prefix
                expect(e.message).to.include('operation failed')
                sinon.assert.calledWith(
                    mockLogging.error,
                    sinon.match(str => str.includes('Error message'))
                )
            }
        })

        it('should handle errors without path', async () => {
            const error = new Error('operation failed')
            const operation = sandbox.stub().rejects(error)

            try {
                await CodeReviewUtils.withErrorHandling(operation, 'Error message', mockLogging)
                expect.fail('Expected error was not thrown')
            } catch (e: any) {
                expect(e.message).to.include('operation failed')
                sinon.assert.calledWith(
                    mockLogging.error,
                    sinon.match(str => !str.includes('/path/file.js'))
                )
            }
        })
    })

    describe('isAgenticReviewEnabled', () => {
        it('should return true when codeReviewInChat is enabled', () => {
            const params = {
                initializationOptions: {
                    aws: {
                        awsClientCapabilities: {
                            q: {
                                codeReviewInChat: true,
                            },
                        },
                    },
                },
            }

            expect(CodeReviewUtils.isAgenticReviewEnabled(params as any)).to.be.true
        })

        it('should return false when codeReviewInChat is disabled', () => {
            const params = {
                initializationOptions: {
                    aws: {
                        awsClientCapabilities: {
                            q: {
                                codeReviewInChat: false,
                            },
                        },
                    },
                },
            }

            expect(CodeReviewUtils.isAgenticReviewEnabled(params as any)).to.be.false
        })

        it('should return false when q capabilities are undefined', () => {
            const params = {
                initializationOptions: {
                    aws: {
                        awsClientCapabilities: {},
                    },
                },
            }

            expect(CodeReviewUtils.isAgenticReviewEnabled(params as any)).to.be.false
        })

        it('should return false when params are undefined', () => {
            expect(CodeReviewUtils.isAgenticReviewEnabled(undefined)).to.be.false
        })
    })

    describe('convertToUnixPath', () => {
        let normalizeStub: sinon.SinonStub

        beforeEach(() => {
            // We need to directly test the implementation without relying on path.normalize
            normalizeStub = sandbox.stub(path, 'normalize')
        })

        it('should convert Windows path to Unix format', () => {
            // Setup the stub to return a Windows-style normalized path
            normalizeStub.returns('C:\\Users\\test\\file.js')

            const result = CodeReviewUtils.convertToUnixPath('C:\\Users\\test\\file.js')

            // Verify the regex replacements work correctly
            expect(result).to.match(/^\/Users\/test\/file\.js$/)
        })

        it('should handle paths without drive letter', () => {
            normalizeStub.returns('Users\\test\\file.js')

            const result = CodeReviewUtils.convertToUnixPath('Users\\test\\file.js')

            // Verify backslashes are converted to forward slashes
            expect(result).to.match(/^Users\/test\/file\.js$/)
        })

        it('should not modify Unix paths', () => {
            normalizeStub.returns('/Users/test/file.js')

            const result = CodeReviewUtils.convertToUnixPath('/Users/test/file.js')

            // Unix paths should remain unchanged
            expect(result).to.equal('/Users/test/file.js')
        })
    })

    describe('createErrorOutput', () => {
        it('should create standardized error output object', () => {
            const errorObj = { message: 'Test error' }
            const result = CodeReviewUtils.createErrorOutput(errorObj)

            expect(result).to.deep.equal({
                output: {
                    kind: 'json',
                    content: errorObj,
                    success: false,
                },
            })
        })
    })

    describe('uploadFileToPresignedUrl', () => {
        let httpsRequestStub: sinon.SinonStub
        let requestOnStub: sinon.SinonStub
        let requestWriteStub: sinon.SinonStub
        let requestEndStub: sinon.SinonStub
        let responseOnStub: sinon.SinonStub

        beforeEach(() => {
            requestOnStub = sandbox.stub()
            requestWriteStub = sandbox.stub()
            requestEndStub = sandbox.stub()
            responseOnStub = sandbox.stub()

            const mockRequest = {
                on: requestOnStub,
                write: requestWriteStub,
                end: requestEndStub,
            }

            const mockResponse = {
                statusCode: 200,
                on: responseOnStub,
            }

            httpsRequestStub = sandbox.stub(https, 'request').returns(mockRequest as any)

            // Setup response.on('data') and response.on('end')
            responseOnStub.withArgs('data').callsFake((event, callback) => {
                if (event === 'data') callback('response chunk')
            })

            responseOnStub.withArgs('end').callsFake((event, callback) => {
                if (event === 'end') callback()
            })

            // Setup the request callback to be called with the mock response
            httpsRequestStub.callsFake((options, callback) => {
                callback(mockResponse)
                return mockRequest as any
            })
        })

        it('should upload file to presigned URL successfully', async () => {
            const uploadUrl = 'https://example.com/upload'
            const fileContent = Buffer.from('test content')
            const requestHeaders = { 'Content-Type': 'application/octet-stream' }

            await CodeReviewUtils.uploadFileToPresignedUrl(uploadUrl, fileContent, requestHeaders, mockLogging)

            sinon.assert.calledOnce(httpsRequestStub)
            sinon.assert.calledWith(requestWriteStub, fileContent)
            sinon.assert.calledOnce(requestEndStub)
            sinon.assert.calledWith(mockLogging.info, sinon.match('File upload completed successfully'))
        })

        it('should handle upload failure with non-200 status code', async () => {
            const uploadUrl = 'https://example.com/upload'
            const fileContent = Buffer.from('test content')
            const requestHeaders = { 'Content-Type': 'application/octet-stream' }

            // Override the response status code
            httpsRequestStub.callsFake((options, callback) => {
                callback({ statusCode: 403, on: responseOnStub })
                return { on: requestOnStub, write: requestWriteStub, end: requestEndStub } as any
            })

            try {
                await CodeReviewUtils.uploadFileToPresignedUrl(uploadUrl, fileContent, requestHeaders, mockLogging)
                expect.fail('Expected error was not thrown')
            } catch (e: any) {
                expect(e.message).to.include('Upload failed with status code: 403')
            }
        })

        it('should handle network errors during upload', async () => {
            const uploadUrl = 'https://example.com/upload'
            const fileContent = Buffer.from('test content')
            const requestHeaders = { 'Content-Type': 'application/octet-stream' }

            // Create a request object that will emit an error
            const mockRequest = {
                on: sandbox.stub(),
                write: sandbox.stub(),
                end: sandbox.stub(),
            }

            // Make the request emit an error when 'error' event is registered
            mockRequest.on.withArgs('error').callsFake((event, callback) => {
                // Immediately call the callback with an error
                setTimeout(() => callback(new Error('Network error')), 0)
                return mockRequest
            })

            // Make https.request return our mock request
            httpsRequestStub.returns(mockRequest as any)

            try {
                await CodeReviewUtils.uploadFileToPresignedUrl(uploadUrl, fileContent, requestHeaders, mockLogging)
                expect.fail('Expected error was not thrown')
            } catch (e: any) {
                expect(e.message).to.equal('Network error')
                sinon.assert.calledWith(mockLogging.error, sinon.match('Error uploading file:'))
            }
        })
    })

    describe('checkCancellation', () => {
        it('should not throw when cancellation is not requested', () => {
            const cancellationToken = { isCancellationRequested: false }

            expect(() => {
                CodeReviewUtils.checkCancellation(cancellationToken as any, mockLogging)
            }).to.not.throw()
        })

        it('should throw CancellationError when cancellation is requested', () => {
            const cancellationToken = { isCancellationRequested: true }

            try {
                CodeReviewUtils.checkCancellation(cancellationToken as any, mockLogging)
                expect.fail('Expected error was not thrown')
            } catch (e: any) {
                expect(e).to.be.instanceOf(CancellationError)
                sinon.assert.calledWith(mockLogging.info, 'Command execution cancelled')
            }
        })

        it('should use custom message when provided', () => {
            const cancellationToken = { isCancellationRequested: true }
            const customMessage = 'Custom cancellation message'

            try {
                CodeReviewUtils.checkCancellation(cancellationToken as any, mockLogging, customMessage)
                expect.fail('Expected error was not thrown')
            } catch (e: any) {
                expect(e).to.be.instanceOf(CancellationError)
                sinon.assert.calledWith(mockLogging.info, customMessage)
            }
        })

        it('should not throw when cancellation token is undefined', () => {
            expect(() => {
                CodeReviewUtils.checkCancellation(undefined, mockLogging)
            }).to.not.throw()
        })
    })

    describe('emitMetric', () => {
        let mockTelemetry: Features['telemetry']

        beforeEach(() => {
            mockTelemetry = {
                emitMetric: sinon.stub(),
            } as unknown as Features['telemetry']
        })

        it('should emit a success metric with all parameters', () => {
            const metric = {
                reason: SuccessMetricName.CodeScanSuccess,
                result: 'Succeeded',
                metadata: { jobId: '123', scanType: 'full', credentialStartUrl: 'https://example.com' },
            } as CodeReviewMetric

            CodeReviewUtils.emitMetric(metric, mockLogging, mockTelemetry)

            sinon.assert.calledWith(mockTelemetry.emitMetric as sinon.SinonStub, {
                name: 'amazonq_codeReviewTool',
                data: {
                    jobId: '123',
                    scanType: 'full',
                    credentialStartUrl: 'https://example.com',
                    result: 'Succeeded',
                    reason: 'codeScanSuccess',
                },
            })

            sinon.assert.calledWith(mockLogging.info, sinon.match(/Emitting telemetry metric: codeScanSuccess/))
        })

        it('should emit a failure metric with required reason', () => {
            const metric = {
                reason: FailedMetricName.CodeScanFailed,
                result: 'Failed',
                reasonDesc: 'Required failure reason',
                metadata: { jobId: '456' },
            } as CodeReviewMetric

            CodeReviewUtils.emitMetric(metric, mockLogging, mockTelemetry)

            sinon.assert.calledWith(mockTelemetry.emitMetric as sinon.SinonStub, {
                name: 'amazonq_codeReviewTool',
                data: {
                    jobId: '456',
                    result: 'Failed',
                    reason: 'codeScanFailed',
                    reasonDesc: 'Required failure reason',
                },
            })
        })

        it('should handle metrics without metadata', () => {
            const metric = {
                reason: FailedMetricName.MissingFileOrFolder,
                result: 'Failed',
                reasonDesc: 'File not found',
            } as CodeReviewMetric

            CodeReviewUtils.emitMetric(metric, mockLogging, mockTelemetry)

            sinon.assert.calledWith(mockTelemetry.emitMetric as sinon.SinonStub, {
                name: 'amazonq_codeReviewTool',
                data: {
                    result: 'Failed',
                    reason: 'missingFileOrFolder',
                    reasonDesc: 'File not found',
                },
            })
        })
    })
})

// End-to-end regression tests against a REAL temporary git repository. These
// prove the fix in practice: an inert special-character filename is matched
// literally (no shell tokenization) and a glob character in a filename is NOT
// expanded (literal pathspec). No command-injection payload is executed.
describe('CodeReviewUtils git diff (real repo, injection-safe)', () => {
    const noopLogging = {
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
        debug: () => {},
    } as unknown as Features['logging']

    let repo: string
    let gitReady = false

    const git = (args: string[], cwd: string) => childProcess.execFileSync('git', args, { cwd, stdio: 'pipe' })

    beforeEach(() => {
        gitReady = false
        try {
            childProcess.execFileSync('git', ['--version'], { stdio: 'pipe' })
        } catch {
            return
        }
        repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cru-git-'))
        try {
            git(['init', '-q'], repo)
            git(['config', 'user.email', 'test@example.com'], repo)
            git(['config', 'user.name', 'test'], repo)
            git(['config', 'commit.gpgsign', 'false'], repo)
            gitReady = true
        } catch {
            gitReady = false
        }
    })

    afterEach(() => {
        if (repo) {
            fs.rmSync(repo, { recursive: true, force: true })
        }
    })

    it('returns the changed file for an inert special-character filename without shell interpretation', async function () {
        if (!gitReady) {
            return this.skip()
        }
        // A shell parsing "git diff ... note;echo.txt" would split on ';' into a
        // second command; execFile + ':(literal)' + '--' pass it to git literally.
        const weird = 'note;echo.txt'
        const filePath = path.join(repo, weird)
        fs.writeFileSync(filePath, 'v1\n')
        git(['add', '-A'], repo)
        git(['commit', '-qm', 'init'], repo)
        fs.appendFileSync(filePath, 'v2\n')

        const names = await CodeReviewUtils.getGitDiffNames(filePath, noopLogging)
        expect(names.has(weird)).to.equal(true)

        const diff = await CodeReviewUtils.getGitDiff(filePath, noopLogging)
        expect(diff).to.be.a('string')
        expect((diff as string).includes(weird)).to.equal(true)

        // A shell split would have tried to run a second command; assert no artifact.
        expect(fs.existsSync(path.join(repo, 'echo.txt'))).to.equal(false)
    })

    it('does not expand a glob character in a filename (literal pathspec)', async function () {
        // Windows does not permit '*' in filenames. Argument construction is tested above on every platform.
        if (!gitReady || process.platform === 'win32') {
            return this.skip()
        }
        const star = 'star*.txt' // literal file whose NAME contains a glob char
        const other = 'starXYZ.txt' // would match if '*' were treated as a glob
        fs.writeFileSync(path.join(repo, star), 'v1\n')
        fs.writeFileSync(path.join(repo, other), 'v1\n')
        git(['add', '-A'], repo)
        git(['commit', '-qm', 'init'], repo)
        fs.appendFileSync(path.join(repo, star), 'v2\n')
        fs.appendFileSync(path.join(repo, other), 'v2\n')

        const names = await CodeReviewUtils.getGitDiffNames(path.join(repo, star), noopLogging)
        expect(names.has(star)).to.equal(true)
        expect(names.has(other)).to.equal(false)
    })
})

// ---------------------------------------------------------------------------
// Expanded regression coverage for the git path-injection hardening in
// getGitDiff / getGitDiffNames. These complement the suites above by
// exercising the REAL child_process boundary: production must call execFile
// (no shell) and must never call the shell-using exec. All adversarial path
// strings below are inert, single argv elements — execFile is stubbed so no
// process runs, and exec is stubbed AND asserted never-called so nothing can
// reach a shell even against unfixed code. The real path library is used
// throughout (path.extname / path.dirname are never stubbed to invented
// semantics). No reporter payloads, network calls, or internal identifiers
// are used.
// ---------------------------------------------------------------------------
describe('CodeReviewUtils git argv construction (child_process boundary)', () => {
    let sandbox: sinon.SinonSandbox
    let execStub: sinon.SinonStub

    const noopLogging = {
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
        debug: () => {},
    } as unknown as Features['logging']

    // Every execFile invocation, recorded as {file, args, cwd, shell}. The stub
    // resolves with empty output so the real executeGitCommand completes without
    // spawning anything.
    let calls: Array<{ file: string; args: string[]; cwd: unknown; shell: unknown }>

    beforeEach(() => {
        sandbox = sinon.createSandbox()
        calls = []
        sandbox.stub(childProcess, 'execFile').callsFake((file: any, args: any, options: any, callback: any) => {
            calls.push({ file, args, cwd: options?.cwd, shell: options?.shell })
            callback(null, '', '')
            return {} as childProcess.ChildProcess
        })
        // Trap: production must never route git through the shell-using exec.
        execStub = sandbox.stub(childProcess, 'exec').throws(new Error('Unexpected shell-based Git execution'))
    })

    afterEach(() => {
        sandbox.restore()
    })

    const unstagedOf = () => calls.find(c => !c.args.includes('--staged'))
    const stagedOf = () => calls.find(c => c.args.includes('--staged'))

    it('getGitDiff runs unstaged and staged diffs via execFile with -- and a literal pathspec', async () => {
        const artifact = '/repo/src/app.ts'
        const dir = path.dirname(artifact)
        const lit = `:(literal)${artifact}`

        await CodeReviewUtils.getGitDiff(artifact, noopLogging)

        expect(calls.length).to.equal(2)
        const unstaged = unstagedOf()
        const staged = stagedOf()
        expect(unstaged, 'expected an unstaged diff call').to.not.be.undefined
        expect(staged, 'expected a staged diff call').to.not.be.undefined
        expect(unstaged!.args).to.deep.equal(['diff', '--', lit])
        expect(staged!.args).to.deep.equal(['diff', '--staged', '--', lit])
        for (const c of calls) {
            expect(c.file).to.equal('git')
            expect(c.cwd).to.equal(dir)
            expect(c.shell).to.be.undefined
        }
        sinon.assert.notCalled(execStub)
    })

    it('getGitDiffNames runs unstaged and staged --name-only diffs via execFile with -- and a literal pathspec', async () => {
        const artifact = '/repo/src/app.ts'
        const dir = path.dirname(artifact)
        const lit = `:(literal)${artifact}`

        await CodeReviewUtils.getGitDiffNames(artifact, noopLogging)

        expect(calls.length).to.equal(2)
        expect(unstagedOf()!.args).to.deep.equal(['diff', '--name-only', '--', lit])
        expect(stagedOf()!.args).to.deep.equal(['diff', '--name-only', '--staged', '--', lit])
        for (const c of calls) {
            expect(c.file).to.equal('git')
            expect(c.cwd).to.equal(dir)
            expect(c.shell).to.be.undefined
        }
        sinon.assert.notCalled(execStub)
    })

    // Inert, mocked names covering spaces + metacharacters in BOTH the directory
    // (cwd) and artifact (pathspec) slots, extension-bearing semicolon and
    // command-substitution forms, option-like leading dashes, pathspec-magic
    // leading colon, and glob characters. Each must survive verbatim as a single
    // literal pathspec argument placed after '--'.
    const trickyArtifacts: Array<{ label: string; artifact: string }> = [
        {
            label: 'spaces and semicolon in directory and artifact slots',
            artifact: '/a dir; fixture/b sub/app; end.ts',
        },
        { label: 'extension before semicolon and comment marker', artifact: '/repo/src/app.ts; fixture #' },
        { label: 'command-substitution syntax in filename (mocked)', artifact: '/repo/app$(fixture).ts' },
        { label: 'command-substitution syntax in directory (mocked)', artifact: '/repo/$(fixture)/app.ts' },
        { label: 'backtick syntax in filename (mocked)', artifact: '/repo/app`fixture`.ts' },
        { label: 'option-like relative path', artifact: '--output.ts' },
        { label: 'pathspec-magic relative path', artifact: ':(glob)*.ts' },
        { label: 'glob star', artifact: '/repo/*.ts' },
        { label: 'glob bracket class', artifact: '/repo/file[0-9].ts' },
    ]

    trickyArtifacts.forEach(({ label, artifact }) => {
        it(`passes ${label} literally in all four Git variants`, async () => {
            const dir = path.dirname(artifact)
            const lit = `:(literal)${artifact}`

            await CodeReviewUtils.getGitDiff(artifact, noopLogging)
            await CodeReviewUtils.getGitDiffNames(artifact, noopLogging)

            expect(calls.map(c => c.args)).to.deep.equal([
                ['diff', '--', lit],
                ['diff', '--staged', '--', lit],
                ['diff', '--name-only', '--', lit],
                ['diff', '--name-only', '--staged', '--', lit],
            ])
            for (const call of calls) {
                expect(call.file).to.equal('git')
                expect(call.cwd).to.equal(dir)
                expect(call.shell).to.be.undefined
            }
            sinon.assert.notCalled(execStub)
        })
    })

    it('getGitDiffNames passes an option-like + glob name verbatim as one literal pathspec after --', async () => {
        const artifact = '/repo/-rf *.ts'
        const lit = `:(literal)${artifact}`

        await CodeReviewUtils.getGitDiffNames(artifact, noopLogging)

        const unstaged = unstagedOf()!
        expect(unstaged.args).to.deep.equal(['diff', '--name-only', '--', lit])
        expect(unstaged.args[unstaged.args.length - 1]).to.equal(lit)
        sinon.assert.notCalled(execStub)
    })
})

// ---------------------------------------------------------------------------
// Result-combination contract for getGitDiff / getGitDiffNames: how staged and
// unstaged outputs are merged, de-duplicated, trimmed of empties, and reduced
// to null / an empty set. Uses the higher-level executeGitCommand stub (same
// style as the getGitDiff suite above); no process is spawned.
// ---------------------------------------------------------------------------
describe('CodeReviewUtils diff result combination and dedup', () => {
    let sandbox: sinon.SinonSandbox
    let execGit: sinon.SinonStub

    const noopLogging = {
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
        debug: () => {},
    } as unknown as Features['logging']

    beforeEach(() => {
        sandbox = sinon.createSandbox()
        sandbox.stub(CodeReviewUtils, 'getFolderPath').returns('/mock/dir')
        execGit = sandbox.stub(CodeReviewUtils, 'executeGitCommand')
    })

    afterEach(() => {
        sandbox.restore()
    })

    it('getGitDiff returns unstaged-only content when staged is empty', async () => {
        execGit.callsFake(async (args: string[]) => (args.includes('--staged') ? '' : 'U'))
        expect(await CodeReviewUtils.getGitDiff('/mock/dir/f.ts', noopLogging)).to.equal('U')
    })

    it('getGitDiff returns staged-only content when unstaged is empty', async () => {
        execGit.callsFake(async (args: string[]) => (args.includes('--staged') ? 'S' : ''))
        expect(await CodeReviewUtils.getGitDiff('/mock/dir/f.ts', noopLogging)).to.equal('S')
    })

    it('getGitDiff joins unstaged and staged with a blank line', async () => {
        execGit.callsFake(async (args: string[]) => (args.includes('--staged') ? 'S' : 'U'))
        expect(await CodeReviewUtils.getGitDiff('/mock/dir/f.ts', noopLogging)).to.equal('U\n\nS')
    })

    it('getGitDiff returns null when both unstaged and staged are empty', async () => {
        execGit.resolves('')
        expect(await CodeReviewUtils.getGitDiff('/mock/dir/f.ts', noopLogging)).to.be.null
    })

    it('getGitDiffNames de-duplicates names across staged and unstaged', async () => {
        execGit.callsFake(async (args: string[]) => (args.includes('--staged') ? 'b\nc' : 'a\nb'))
        const names = await CodeReviewUtils.getGitDiffNames('/mock/dir/f.ts', noopLogging)
        expect(Array.from(names).sort()).to.deep.equal(['a', 'b', 'c'])
    })

    it('getGitDiffNames returns unstaged-only names when staged is empty', async () => {
        execGit.callsFake(async (args: string[]) => (args.includes('--staged') ? '' : 'a\nb'))
        const names = await CodeReviewUtils.getGitDiffNames('/mock/dir/f.ts', noopLogging)
        expect(Array.from(names).sort()).to.deep.equal(['a', 'b'])
    })

    it('getGitDiffNames returns staged-only names when unstaged is empty', async () => {
        execGit.callsFake(async (args: string[]) => (args.includes('--staged') ? 'c' : ''))
        const names = await CodeReviewUtils.getGitDiffNames('/mock/dir/f.ts', noopLogging)
        expect(Array.from(names)).to.deep.equal(['c'])
    })

    it('getGitDiffNames returns an empty set when both are empty (blank lines filtered)', async () => {
        execGit.resolves('')
        const names = await CodeReviewUtils.getGitDiffNames('/mock/dir/f.ts', noopLogging)
        expect(names.size).to.equal(0)
    })
})

// ---------------------------------------------------------------------------
// getFolderPath contract pinned against the REAL path library (no stubbing of
// path.extname / path.dirname). Covers the file-vs-directory decision and the
// missing/empty inputs. These assert only the existing behavior; they do not
// add any new policy.
// ---------------------------------------------------------------------------
describe('CodeReviewUtils.getFolderPath contract (real path library)', () => {
    it('returns the parent directory for a file path with an extension', () => {
        expect(CodeReviewUtils.getFolderPath('/repo/src/app.ts')).to.equal(path.dirname('/repo/src/app.ts'))
    })

    it('returns a directory path (no extension) unchanged', () => {
        expect(CodeReviewUtils.getFolderPath('/repo/src')).to.equal('/repo/src')
    })

    it('strips a single trailing slash from a directory path', () => {
        expect(CodeReviewUtils.getFolderPath('/repo/src/')).to.equal('/repo/src')
    })

    it('treats a dotfile as a directory (path.extname of a dotfile is empty)', () => {
        expect(path.extname('.env')).to.equal('')
        expect(CodeReviewUtils.getFolderPath('/repo/.env')).to.equal('/repo/.env')
    })

    it('returns an empty string for empty input (existing contract; no policy added)', () => {
        expect(CodeReviewUtils.getFolderPath('')).to.equal('')
    })
})
