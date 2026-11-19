import { expect } from 'chai'
import { Utils } from '../utils'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import got from 'got'
import AdmZip = require('adm-zip')
import sinon = require('sinon')
import * as http from 'http'
import { AddressInfo } from 'net'
import { Logging } from '@aws/language-server-runtimes/server-interface'
import { stubInterface } from 'ts-sinon'

describe('Utils', () => {
    let tempDir: string
    let testFile: string
    let mockLogger: any

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utils-test-'))
        testFile = path.join(tempDir, 'test.txt')
        fs.writeFileSync(testFile, 'test content')
        mockLogger = stubInterface<Logging>()
    })

    afterEach(() => {
        sinon.restore()
        Utils.clearAllWorklogCache()
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true })
        }
    })

    describe('getSha256Async', () => {
        it('should calculate SHA256 hash of file contents', async () => {
            const result = await Utils.getSha256Async(testFile)

            expect(result).to.be.a('string')
            expect(result).to.have.length.greaterThan(0)
            // Verify it's a valid base64 string
            expect(() => Buffer.from(result, 'base64')).to.not.throw()
        })

        it('should return consistent hash for same content', async () => {
            const result1 = await Utils.getSha256Async(testFile)
            const result2 = await Utils.getSha256Async(testFile)

            expect(result1).to.equal(result2)
        })

        it('should handle empty file', async () => {
            const emptyFile = path.join(tempDir, 'empty.txt')
            fs.writeFileSync(emptyFile, '')

            const result = await Utils.getSha256Async(emptyFile)
            expect(result).to.be.a('string')
        })
    })

    describe('getWorkspacePath', () => {
        it('should create workspace path with UUID', () => {
            const solutionRoot = tempDir
            const result = Utils.getWorkspacePath(solutionRoot)

            expect(result).to.include(solutionRoot)
            expect(result).to.include('artifactWorkspace')
            expect(fs.existsSync(result)).to.be.true
        })

        it('should create different paths on multiple calls', () => {
            const solutionRoot = tempDir
            const result1 = Utils.getWorkspacePath(solutionRoot)
            const result2 = Utils.getWorkspacePath(solutionRoot)

            expect(result1).to.not.equal(result2)
        })

        it('should create directory if it does not exist', () => {
            const solutionRoot = path.join(tempDir, 'new-solution')
            const result = Utils.getWorkspacePath(solutionRoot)

            expect(fs.existsSync(result)).to.be.true
        })
    })

    describe('sleep', () => {
        it('should sleep for specified duration', async () => {
            const start = Date.now()
            await Utils.sleep(50)
            const elapsed = Date.now() - start

            expect(elapsed).to.be.at.least(45) // Allow some tolerance
        })

        it('should handle zero duration', async () => {
            const start = Date.now()
            await Utils.sleep(0)
            const elapsed = Date.now() - start

            expect(elapsed).to.be.at.least(0)
        })

        it('should handle negative duration as zero', async () => {
            const start = Date.now()
            await Utils.sleep(-100)
            const elapsed = Date.now() - start

            expect(elapsed).to.be.at.least(0)
        })

        it('should handle undefined duration', async () => {
            const start = Date.now()
            await Utils.sleep()
            const elapsed = Date.now() - start

            expect(elapsed).to.be.at.least(0)
        })
    })

    describe('uploadArtifact', () => {
        it('should upload artifact successfully', async () => {
            const putStub = sinon.stub(Utils, 'putFileFromWorker').resolves({ statusCode: 200 })

            const result = await Utils.uploadArtifact('http://test-url', testFile, {
                'Content-Type': 'application/zip',
            })

            expect(result).to.be.true
            expect(putStub.calledOnceWith('http://test-url', testFile, { 'Content-Type': 'application/zip' })).to.be
                .true
        })

        it('should handle array headers', async () => {
            const putStub = sinon.stub(Utils, 'putFileFromWorker').resolves({ statusCode: 200 })

            const result = await Utils.uploadArtifact('http://test-url', testFile, {
                'Content-Type': ['application/zip'],
            })

            expect(result).to.be.true
            expect(putStub.firstCall.args[2]).to.deep.equal({ 'Content-Type': 'application/zip' })
        })

        it('should return false on non-200 status', async () => {
            sinon.stub(Utils, 'putFileFromWorker').resolves({ statusCode: 400 })

            const result = await Utils.uploadArtifact('http://test-url', testFile)

            expect(result).to.be.false
        })

        it('should return false on error', async () => {
            sinon.stub(Utils, 'putFileFromWorker').rejects(new Error('Network error'))

            const result = await Utils.uploadArtifact('http://test-url', testFile)

            expect(result).to.be.false
        })

        it('should upload without headers', async () => {
            sinon.stub(Utils, 'putFileFromWorker').resolves({ statusCode: 200 })

            const result = await Utils.uploadArtifact('http://test-url', testFile)

            expect(result).to.be.true
        })

        it('should log file size when logger provided', async () => {
            sinon.stub(Utils, 'putFileFromWorker').resolves({ statusCode: 200 })

            const result = await Utils.uploadArtifact('http://test-url', testFile, {}, mockLogger)

            expect(result).to.be.true
            expect(mockLogger.info.calledWith(`Artifact upload size: ${'test content'.length} bytes`)).to.be.true
        })

        it('should log error when upload fails', async () => {
            sinon.stub(Utils, 'putFileFromWorker').rejects(new Error('Network error'))

            const result = await Utils.uploadArtifact('http://test-url', testFile, {}, mockLogger)

            expect(result).to.be.false
            expect(mockLogger.error.calledOnce).to.be.true
        })

        it('should log the status code on non-200 status', async () => {
            sinon.stub(Utils, 'putFileFromWorker').resolves({ statusCode: 400 })

            const result = await Utils.uploadArtifact('http://test-url', testFile, {}, mockLogger)

            expect(result).to.be.false
            expect(mockLogger.error.firstCall.args[0]).to.include('Response code 400')
        })
    })

    describe('putFileFromWorker', () => {
        let server: http.Server
        let url: string
        let received: { method?: string; headers?: http.IncomingHttpHeaders; body?: string }
        let respondWith: { status: number; body: string }

        beforeEach(async () => {
            received = {}
            respondWith = { status: 200, body: '' }
            server = http.createServer((req, res) => {
                let body = ''
                req.on('data', chunk => (body += chunk))
                req.on('end', () => {
                    received = { method: req.method, headers: req.headers, body }
                    res.writeHead(respondWith.status)
                    res.end(respondWith.body)
                })
            })
            await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
            url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload`
        })

        afterEach(async () => {
            await new Promise(resolve => server.close(resolve))
        })

        it('should PUT the file contents with headers and Content-Length', async () => {
            const result = await Utils.putFileFromWorker(url, testFile, { 'Content-Type': 'application/zip' })

            expect(result.statusCode).to.equal(200)
            expect(received.method).to.equal('PUT')
            expect(received.body).to.equal('test content')
            expect(received.headers?.['content-type']).to.equal('application/zip')
            expect(received.headers?.['content-length']).to.equal(String('test content'.length))
        })

        it('should return the status code of a failed upload', async () => {
            respondWith = { status: 400, body: '<Error><Code>RequestTimeout</Code></Error>' }

            const result = await Utils.putFileFromWorker(url, testFile, {})

            expect(result.statusCode).to.equal(400)
        })

        it('should reject when the connection fails', async () => {
            // Nothing listens on the original port any more; a fresh server keeps afterEach's close() valid.
            const deadUrl = url
            await new Promise(resolve => server.close(resolve))
            server = http.createServer()
            await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

            let error: unknown
            try {
                await Utils.putFileFromWorker(deadUrl, testFile, {})
            } catch (e) {
                error = e
            }
            expect(error).to.be.instanceOf(Error)
        })
    })

    describe('saveWorklogsToJson', () => {
        it('should create new worklog file', async () => {
            const jobId = 'test-job-id'
            const stepId = 'step1'
            const description = 'Test description'

            await Utils.saveWorklogsToJson(jobId, stepId, description, tempDir)

            const worklogPath = path.join(tempDir, 'artifactWorkspace', jobId, 'worklogs.json')
            expect(fs.existsSync(worklogPath)).to.be.true

            const content = JSON.parse(fs.readFileSync(worklogPath, 'utf8'))
            expect(content[stepId][0].text).to.equal(description)
        })

        it('should append to existing worklog file', async () => {
            const jobId = 'test-job-id'
            const stepId = 'step1'
            const description1 = 'First description'
            const description2 = 'Second description'

            await Utils.saveWorklogsToJson(jobId, stepId, description1, tempDir)
            await Utils.saveWorklogsToJson(jobId, stepId, description2, tempDir)

            const worklogPath = path.join(tempDir, 'artifactWorkspace', jobId, 'worklogs.json')
            const content = JSON.parse(fs.readFileSync(worklogPath, 'utf8'))

            expect(content[stepId].map((e: any) => e.text)).to.include(description1)
            expect(content[stepId].map((e: any) => e.text)).to.include(description2)
        })

        it('should handle null stepId', async () => {
            const jobId = 'test-job-id'
            const description = 'Test description'

            await Utils.saveWorklogsToJson(jobId, null, description, tempDir)

            const worklogPath = path.join(tempDir, 'artifactWorkspace', jobId, 'worklogs.json')
            const content = JSON.parse(fs.readFileSync(worklogPath, 'utf8'))

            expect(content['Progress'][0].text).to.equal(description)
        })

        it('should not add duplicate descriptions', async () => {
            const jobId = 'test-job-id'
            const stepId = 'step1'
            const description = 'Test description'

            await Utils.saveWorklogsToJson(jobId, stepId, description, tempDir)
            await Utils.saveWorklogsToJson(jobId, stepId, description, tempDir)

            const worklogPath = path.join(tempDir, 'artifactWorkspace', jobId, 'worklogs.json')
            const content = JSON.parse(fs.readFileSync(worklogPath, 'utf8'))

            expect(content[stepId]).to.have.length(1)
        })
    })

    describe('saveWorklogsToJson - dedup cache', () => {
        it('should skip duplicate entries without disk I/O', async () => {
            const jobId = 'cache-test-job'
            const stepId = 'step1'
            const description = 'Cached entry'

            await Utils.saveWorklogsToJson(jobId, stepId, description, tempDir)
            const worklogPath = path.join(tempDir, 'artifactWorkspace', jobId, 'worklogs.json')

            const statBefore = fs.statSync(worklogPath)
            await Utils.saveWorklogsToJson(jobId, stepId, description, tempDir)
            const statAfter = fs.statSync(worklogPath)

            expect(statAfter.mtimeMs).to.equal(statBefore.mtimeMs)
        })

        it('should allow same description in different steps', async () => {
            const jobId = 'cache-step-test'
            const description = 'Same description'

            await Utils.saveWorklogsToJson(jobId, 'step1', description, tempDir)
            await Utils.saveWorklogsToJson(jobId, 'step2', description, tempDir)

            const worklogPath = path.join(tempDir, 'artifactWorkspace', jobId, 'worklogs.json')
            const content = JSON.parse(fs.readFileSync(worklogPath, 'utf8'))

            expect(content['step1']).to.have.length(1)
            expect(content['step2']).to.have.length(1)
        })

        it('should seed cache from existing file on first access', async () => {
            const jobId = 'seed-test-job'
            const stepId = 'step1'
            const worklogDir = path.join(tempDir, 'artifactWorkspace', jobId)
            fs.mkdirSync(worklogDir, { recursive: true })
            const worklogPath = path.join(worklogDir, 'worklogs.json')

            fs.writeFileSync(
                worklogPath,
                JSON.stringify({ step1: [{ text: 'Existing entry', timestamp: new Date().toISOString() }] })
            )

            Utils.clearWorklogCacheForJob(jobId)
            await Utils.saveWorklogsToJson(jobId, stepId, 'Existing entry', tempDir)

            const content = JSON.parse(fs.readFileSync(worklogPath, 'utf8'))
            expect(content[stepId]).to.have.length(1)
        })

        it('should still dedup after clearWorklogCacheForJob (re-seeds from file)', async () => {
            const jobId = 'clear-cache-test'
            const stepId = 'step1'
            const description = 'Will not be duplicated'

            await Utils.saveWorklogsToJson(jobId, stepId, description, tempDir)
            Utils.clearWorklogCacheForJob(jobId)
            await Utils.saveWorklogsToJson(jobId, stepId, description, tempDir)

            const worklogPath = path.join(tempDir, 'artifactWorkspace', jobId, 'worklogs.json')
            const content = JSON.parse(fs.readFileSync(worklogPath, 'utf8'))

            expect(content[stepId]).to.have.length(1)
        })

        it('should allow new entries after clearWorklogCacheForJob', async () => {
            const jobId = 'clear-cache-test'
            const stepId = 'step1'

            await Utils.saveWorklogsToJson(jobId, stepId, 'First entry', tempDir)
            Utils.clearWorklogCacheForJob(jobId)
            await Utils.saveWorklogsToJson(jobId, stepId, 'New entry after clear', tempDir)

            const worklogPath = path.join(tempDir, 'artifactWorkspace', jobId, 'worklogs.json')
            const content = JSON.parse(fs.readFileSync(worklogPath, 'utf8'))

            expect(content[stepId]).to.have.length(2)
            expect(content[stepId].map((e: any) => e.text)).to.include('New entry after clear')
        })

        it('should include timestamp in worklog entries', async () => {
            const jobId = 'timestamp-test'
            const stepId = 'step1'
            const timestamp = new Date('2025-01-15T10:30:00.000Z')

            await Utils.saveWorklogsToJson(jobId, stepId, 'Entry with time', tempDir, timestamp)

            const worklogPath = path.join(tempDir, 'artifactWorkspace', jobId, 'worklogs.json')
            const content = JSON.parse(fs.readFileSync(worklogPath, 'utf8'))

            expect(content[stepId][0].timestamp).to.equal(timestamp.toISOString())
            expect(content[stepId][0].text).to.equal('Entry with time')
        })
    })

    describe('downloadAndExtractArchive', () => {
        it('should download and extract archive', async () => {
            const mockZipBuffer = Buffer.from('mock zip content')
            const getStub = sinon.stub(got, 'get').resolves({ body: mockZipBuffer })
            const extractStub = sinon.stub(Utils, 'extractArchiveFromBuffer').resolves('/extracted/path')

            const result = await Utils.downloadAndExtractArchive(
                'http://test-url',
                { Authorization: 'Bearer token' },
                tempDir,
                'test.zip',
                mockLogger
            )

            expect(result).to.equal('/extracted/path')
            expect(getStub.calledOnce).to.be.true
            expect(extractStub.calledOnce).to.be.true
        })

        it('should handle null headers', async () => {
            const mockZipBuffer = Buffer.from('mock zip content')
            const getStub = sinon.stub(got, 'get').resolves({ body: mockZipBuffer })
            const extractStub = sinon.stub(Utils, 'extractArchiveFromBuffer').resolves('/extracted/path')

            const result = await Utils.downloadAndExtractArchive(
                'http://test-url',
                null,
                tempDir,
                'test.zip',
                mockLogger
            )

            expect(result).to.equal('/extracted/path')
        })
    })

    describe('extractArchiveFromBuffer', () => {
        it('should extract archive from buffer', async () => {
            const extractStub = sinon.stub(Utils, 'extractAllEntriesTo').resolves()
            const directoryExistsStub = sinon.stub(Utils, 'directoryExists').resolves()
            const writeFileSyncStub = sinon.stub(fs, 'writeFileSync')

            // Create a real zip file buffer
            const zipPath = path.join(tempDir, 'test.zip')
            await Utils.zipFile(testFile, zipPath)
            const zipBuffer = fs.readFileSync(zipPath)

            const buffer = [zipBuffer]
            const result = await Utils.extractArchiveFromBuffer('test.zip', buffer, tempDir, mockLogger)

            expect(result).to.equal(tempDir)
            expect(directoryExistsStub.calledOnce).to.be.true
            expect(writeFileSyncStub.calledOnce).to.be.true
            expect(extractStub.calledOnce).to.be.true
        })
    })

    describe('directoryExists', () => {
        it('should not create directory if it exists', async () => {
            const accessStub = sinon.stub(fs.promises, 'access').resolves()
            const mkdirStub = sinon.stub(fs.promises, 'mkdir')

            await Utils.directoryExists(tempDir)

            expect(accessStub.calledOnce).to.be.true
            expect(mkdirStub.called).to.be.false
        })

        it('should create directory if it does not exist', async () => {
            const accessStub = sinon.stub(fs.promises, 'access').rejects(new Error('ENOENT'))
            const mkdirStub = sinon.stub(fs.promises, 'mkdir').resolves()

            await Utils.directoryExists('/non/existent/path')

            expect(accessStub.calledOnce).to.be.true
            expect(mkdirStub.calledOnce).to.be.true
        })
    })

    describe('extractAllEntriesTo', () => {
        it('should extract directory entries', async () => {
            const mkdirStub = sinon.stub(fs.promises, 'mkdir').resolves()
            const writeFileStub = sinon.stub(fs.promises, 'writeFile')

            const entries = [
                {
                    entryName: 'testdir/',
                    isDirectory: true,
                    getData: () => Buffer.from(''),
                },
            ]

            await Utils.extractAllEntriesTo(tempDir, entries as any, mockLogger)

            expect(mkdirStub.calledOnce).to.be.true
            expect(writeFileStub.called).to.be.false
        })

        it('should extract file entries', async () => {
            const mkdirStub = sinon.stub(fs.promises, 'mkdir').resolves()
            const writeFileStub = sinon.stub(fs.promises, 'writeFile').resolves()

            const entries = [
                {
                    entryName: 'test.txt',
                    isDirectory: false,
                    getData: () => Buffer.from('content'),
                },
            ]

            await Utils.extractAllEntriesTo(tempDir, entries as any, mockLogger)

            expect(mkdirStub.calledOnce).to.be.true
            expect(writeFileStub.calledOnce).to.be.true
        })

        it('should block zip-slip entries that escape the extraction directory', async () => {
            const mkdirStub = sinon.stub(fs.promises, 'mkdir').resolves()
            const writeFileStub = sinon.stub(fs.promises, 'writeFile').resolves()

            const entries = [
                {
                    entryName: `..${path.sep}..${path.sep}evil.txt`,
                    isDirectory: false,
                    getData: () => Buffer.from('malicious'),
                },
            ]

            await Utils.extractAllEntriesTo(tempDir, entries as any, mockLogger)

            // The traversal entry must be skipped — nothing written, and it's logged.
            expect(writeFileStub.called).to.be.false
            expect(mockLogger.error.calledOnce).to.be.true
            expect(mockLogger.error.firstCall.args[0]).to.include('escaping extraction directory')
        })

        it('should handle ENOENT error', async () => {
            const entries = [
                {
                    entryName: 'test.txt',
                    isDirectory: false,
                    getData: () => {
                        const error = new Error('ENOENT') as NodeJS.ErrnoException
                        error.code = 'ENOENT'
                        throw error
                    },
                },
            ]

            await Utils.extractAllEntriesTo(tempDir, entries as any, mockLogger)

            expect(mockLogger.error.calledOnce).to.be.true
            expect(mockLogger.error.firstCall.args[0]).to.include('does not exist')
        })

        it('should rethrow non-ENOENT errors', async () => {
            const entries = [
                {
                    entryName: 'test.txt',
                    isDirectory: false,
                    getData: () => {
                        throw new Error('Other error')
                    },
                },
            ]

            try {
                await Utils.extractAllEntriesTo(tempDir, entries as any, mockLogger)
                expect.fail('Should have thrown error')
            } catch (error) {
                expect((error as Error).message).to.equal('Other error')
            }
        })
    })

    describe('zipFile', () => {
        it('should create zip file from source file', async () => {
            const outputZip = path.join(tempDir, 'output.zip')

            await Utils.zipFile(testFile, outputZip)

            expect(fs.existsSync(outputZip)).to.be.true
        })

        it('should handle archiver errors', async () => {
            const outputZip = path.join(tempDir, 'output.zip')
            const nonExistentFile = path.join(tempDir, 'nonexistent.txt')

            try {
                await Utils.zipFile(nonExistentFile, outputZip)
                expect.fail('Should have thrown error')
            } catch (error) {
                expect(error).to.be.instanceOf(Error)
            }
        })
    })

    describe('getExpDelayForApiRetryMs', () => {
        it('should calculate exponential delay with jitter', () => {
            const delay0 = Utils.getExpDelayForApiRetryMs(0)
            const delay1 = Utils.getExpDelayForApiRetryMs(1)
            const delay2 = Utils.getExpDelayForApiRetryMs(2)

            expect(delay0).to.be.at.least(10)
            expect(delay0).to.be.at.most(30)
            expect(delay1).to.be.at.least(20)
            expect(delay1).to.be.at.most(40)
            expect(delay2).to.be.at.least(40)
            expect(delay2).to.be.at.most(60)
        })

        it('should include jitter in calculation', () => {
            const delays = Array.from({ length: 10 }, () => Utils.getExpDelayForApiRetryMs(1))
            const uniqueDelays = new Set(delays)

            // With jitter, we should get different values
            expect(uniqueDelays.size).to.be.greaterThan(1)
        })
    })
})
