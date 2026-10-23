import { CodeWhispererStreaming } from '@amzn/codewhisperer-streaming'
import {
    Logging,
    Workspace,
    SDKInitializator,
    SDKClientConstructorV3,
    Runtime,
} from '@aws/language-server-runtimes/server-interface'
import * as assert from 'assert'
import { expect } from 'chai'
import * as fs from 'fs'
import got from 'got'
import { StubbedInstance, stubInterface } from 'ts-sinon'
import { StreamingClient, createStreamingClient } from '../../../client/streamingClient/codewhispererStreamingClient'
import { CodeWhispererServiceToken } from '../../../shared/codeWhispererService'
import { CancelTransformRequest, CancellationJobStatus, GetTransformPlanRequest, GetTransformRequest } from '../models'
import { TransformHandler } from '../transformHandler'
import sinon = require('sinon')
import { DEFAULT_AWS_Q_ENDPOINT_URL, DEFAULT_AWS_Q_REGION } from '../../../shared/constants'
import { Readable } from 'stream'
import { ArtifactManager } from '../artifactManager'
import path = require('path')
import * as os from 'os'
import AdmZip = require('adm-zip')
import { IZipEntry } from 'adm-zip'
import { AmazonQTokenServiceManager } from '../../../shared/amazonQServiceManager/AmazonQTokenServiceManager'

const testUploadId = 'test-upoload-id'
const testTransformId = 'test-transform-id'
const payloadFileName = 'C:\\test.zip'

describe('Test Transform handler ', () => {
    let client: StubbedInstance<CodeWhispererServiceToken>
    let workspace: StubbedInstance<Workspace>
    let runtime: StubbedInstance<Runtime>
    let transformHandler: TransformHandler
    const mockedLogging = stubInterface<Logging>()
    const awsQRegion: string = DEFAULT_AWS_Q_REGION
    const awsQEndpointUrl: string = DEFAULT_AWS_Q_ENDPOINT_URL
    beforeEach(async () => {
        // Set up the server with a mock service
        client = stubInterface<CodeWhispererServiceToken>()
        workspace = stubInterface<Workspace>()
        runtime = stubInterface<Runtime>()

        const serviceManager = stubInterface<AmazonQTokenServiceManager>()
        client = stubInterface<CodeWhispererServiceToken>()
        serviceManager.getCodewhispererService.returns(client)

        transformHandler = new TransformHandler(serviceManager, workspace, mockedLogging, runtime)
    })

    describe('test upload artifact', () => {
        it('call upload method correctly with stream', async () => {
            const putStub = sinon.stub(got, 'put').resolves({ statusCode: 200 })
            const createReadStreamStub = sinon.stub(fs, 'createReadStream').returns(new Readable() as fs.ReadStream)
            await transformHandler.uploadArtifactToS3Async(
                payloadFileName,
                {
                    uploadId: testUploadId,
                    uploadUrl: 'dummy-upload-url',
                    kmsKeyArn: 'ResourceArn',
                },
                'dummy-256'
            )
            sinon.assert.calledOnce(putStub)
            sinon.assert.calledOnce(createReadStreamStub)

            putStub.restore()
            createReadStreamStub.restore()
        })

        it('handles upload failure correctly', async () => {
            const putStub = sinon.stub(got, 'put').rejects(new Error('Upload failed'))
            const createReadStreamStub = sinon.stub(fs, 'createReadStream').returns(new Readable() as fs.ReadStream)

            try {
                await transformHandler.uploadArtifactToS3Async(
                    payloadFileName,
                    {
                        uploadId: testUploadId,
                        uploadUrl: 'dummy-upload-url',
                        kmsKeyArn: 'ResourceArn',
                    },
                    'dummy-256'
                )
                assert.fail('Should have thrown an error')
            } catch (error) {
                expect((error as Error).message).to.include('Upload failed')
                expect((error as Error).message).to.include(
                    'please see https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/troubleshooting-code-transformation.html'
                )
            } finally {
                putStub.restore()
                createReadStreamStub.restore()
            }
        })
    })

    describe('Test transform create presign url and upload', () => {
        beforeEach(async () => {
            // mock default return value for createUploadUrl
            client.codeModernizerCreateUploadUrl.resolves({
                uploadId: testUploadId,
                uploadUrl: 'dummy-upload-url',
                kmsKeyArn: 'ResourceArn',
                $metadata: {},
            })
        })

        it('returns upload id correctly with streaming', async () => {
            const createReadStreamStub = sinon.stub(fs, 'createReadStream').returns(new Readable() as fs.ReadStream)
            const uploadStub = sinon.stub(transformHandler, 'uploadArtifactToS3Async').resolves()
            const getSha256AsyncStub = sinon.stub(ArtifactManager, 'getSha256Async').resolves('dummy-sha256')
            const res = await transformHandler.uploadPayloadAsync(payloadFileName)

            sinon.assert.calledOnce(uploadStub)
            expect(res).to.equal(testUploadId)

            uploadStub.restore()
            createReadStreamStub.restore()
            getSha256AsyncStub.restore()
        })

        it('should throw error if uploadArtifactToS3Async fails', async () => {
            const mockError = new Error('Error in uploadArtifactToS3 call')
            const createReadStreamStub = sinon.stub(fs, 'createReadStream').returns(new Readable() as fs.ReadStream)
            const getSha256AsyncStub = sinon.stub(ArtifactManager, 'getSha256Async').resolves('dummy-sha256')
            sinon.stub(transformHandler, 'uploadArtifactToS3Async').rejects(mockError)

            // Call the method to be tested
            try {
                await transformHandler.uploadPayloadAsync(payloadFileName)
                assert.fail('Should have thrown an error')
            } catch (error) {
                // Assertions
                expect((error as Error).message).to.equal(mockError.message)
            } finally {
                createReadStreamStub.restore()
                getSha256AsyncStub.restore()
            }
        })
        /*
        it('should upload payload and return uploadId', async () => {
            workspace.fs.getTempDirPath = simon.stub().returns('C:\\tmp')
            const zipStub = sinon.stub(transformHandler, 'zipCodeAsync').returns(Promise.resolve(payloadFileName))
            const uploadStub = sinon.stub(transformHandler, 'uploadPayloadAsync').returns(Promise.resolve(testUploadId))
            const result = await transformHandler.preTransformationUploadCode(payloadFileName)
            expect(result).to.equal(testUploadId)
            sinon.assert.calledOnce(zipStub)
            sinon.assert.calledOnce(uploadStub)
            zipStub.restore()
            uploadStub.restore()
        })

        it('should throw error if upload fails', async () => {
            // Mocking necessary dependencies and methods
            const mockError = new Error('Upload failed')
            const requestString = JSON.stringify(EXAMPLE_REQUEST)
            const request = JSON.parse(requestString) as StartTransformRequest
            workspace.fs.getTempDirPath = simon.stub().returns('C:\\tmp')
            const zipStub = sinon.stub(transformHandler, 'zipCodeAsync').returns(Promise.resolve(payloadFileName))
            sinon.stub(transformHandler, 'uploadPayloadAsync').rejects(mockError)
            try {
                await transformHandler.preTransformationUploadCode(request)
            } catch (error) {
                sinon.assert.calledOnce(zipStub)
                expect((error as Error).message).to.equal(mockError.message)
                zipStub.restore()
            }
        })
            */
    })

    describe('Test cancel transform job', () => {
        beforeEach(async () => {
            // mock default return value for cancelTransform
            client.codeModernizerStopCodeTransformation.returns(
                Promise.resolve({
                    transformationStatus: 'STOPPED',
                    $metadata: {},
                })
            )
        })

        it('should cancel transform', async () => {
            const requestString = JSON.stringify({ TransformationJobId: testTransformId })
            const request = JSON.parse(requestString) as CancelTransformRequest
            const res = await transformHandler.cancelTransformation(request)

            expect(res.TransformationJobStatus).to.equal(CancellationJobStatus.SUCCESSFULLY_CANCELLED)
        })

        it('should throw error if cancellation fails', async () => {
            client.codeModernizerStopCodeTransformation.returns(
                Promise.resolve({
                    transformationStatus: 'COMPLETED',
                    $metadata: {},
                })
            )

            const requestString = JSON.stringify({ TransformationJobId: testTransformId })
            const request = JSON.parse(requestString) as CancelTransformRequest
            const res = await transformHandler.cancelTransformation(request)

            expect(res.TransformationJobStatus).to.equal(CancellationJobStatus.FAILED_TO_CANCEL)
        })
    })
    const mockedCredentialsProvider = {
        getCredentials: sinon.stub().returns({ token: 'mockedToken' }),
    }

    const mockSdkInitializator: SDKInitializator = Object.assign(
        // Default callable function for v3 clients
        <T, P>(Ctor: SDKClientConstructorV3<T, P>, current_config: P): T => new Ctor({ ...current_config })
    )

    describe('StreamingClient', () => {
        it('should create a new streaming client', async () => {
            const streamingClient = new StreamingClient()
            const client = await streamingClient.getStreamingClient(
                mockedCredentialsProvider,
                awsQRegion,
                awsQEndpointUrl,
                mockSdkInitializator,
                mockedLogging
            )
            expect(client).to.be.instanceOf(CodeWhispererStreaming)
        })
    })

    describe('createStreamingClient', () => {
        it('should create a new streaming client with correct configurations', async () => {
            const client = await createStreamingClient(
                mockedCredentialsProvider,
                awsQRegion,
                awsQEndpointUrl,
                mockSdkInitializator,
                mockedLogging
            )
            expect(client).to.be.instanceOf(CodeWhispererStreaming)
        })
    })

    describe('Test get transformJob', () => {
        beforeEach(async () => {
            // mock default return value for Transformation Job
            client.codeModernizerGetCodeTransformation.returns(
                Promise.resolve({
                    transformationJob: {
                        jobId: testTransformId,
                        status: 'COMPLETED',
                    },
                    $metadata: {},
                })
            )
        })

        it('should get transform', async () => {
            const requestString = JSON.stringify({ TransformationJobId: testTransformId })
            const request = JSON.parse(requestString) as GetTransformRequest
            const res = await transformHandler.getTransformation(request)

            expect(res?.TransformationJob.status).to.equal('COMPLETED')
        })
    })

    describe('Test get transformJob for failed case', () => {
        beforeEach(async () => {
            // mock default return value for Transformation Job
            client.codeModernizerGetCodeTransformation.returns(
                Promise.resolve({
                    transformationJob: {
                        jobId: testTransformId,
                        status: 'FAILED',
                    },
                    $metadata: {},
                })
            )
        })

        it('should get transform for failed case', async () => {
            const requestString = JSON.stringify({ TransformationJobId: testTransformId })
            const request = JSON.parse(requestString) as GetTransformRequest
            const res = await transformHandler.getTransformation(request)

            expect(res?.TransformationJob.status).to.equal('FAILED')
        })
    })

    describe('Test get transform plan', () => {
        beforeEach(async () => {
            // mock default return value for Transformation plan

            const mockPlanString = JSON.stringify({
                transformationPlan: {
                    transformationSteps: [
                        {
                            id: '1',
                            name: 'PlanStepName 1',
                            description: 'PlanStepDescription 1',
                            status: 'COMPLETED',
                            progressUpdates: [
                                {
                                    name: 'ProgressUpdateName 1 for PlanStep 1',
                                    status: 'COMPLETED',
                                    description: 'ProgressUpdateDescription 1 for PlanStep 1',
                                    startTime: '2024-03-11T23:27:33.935Z',
                                    endTime: '2024-03-11T23:27:34.038Z',
                                },
                            ],
                            startTime: '2024-03-12T18:49:41.431Z',
                            endTime: '2024-03-12T18:49:42.431Z',
                        },
                    ],
                },
            })
            const response = JSON.parse(mockPlanString)
            client.codeModernizerGetCodeTransformationPlan.returns(Promise.resolve(response))
        })

        it('should get transform plan', async () => {
            const requestString = JSON.stringify({ TransformationJobId: testTransformId })
            const request = JSON.parse(requestString) as GetTransformPlanRequest
            const res = await transformHandler.getTransformationPlan(request)

            expect(res.TransformationPlan.transformationSteps?.[0].status).to.equal('COMPLETED')
            expect(res.TransformationPlan.transformationSteps?.[0].name).to.equal('PlanStepName 1')
            if (res.TransformationPlan.transformationSteps?.[0].progressUpdates) {
                expect(res.TransformationPlan.transformationSteps[0].progressUpdates[0].name).to.equal(
                    'ProgressUpdateName 1 for PlanStep 1'
                )
            }
        })
    })

    describe('Test extract all tntries to a path', () => {
        let sandbox: sinon.SinonSandbox
        let mkdirStub: sinon.SinonStub
        let writeFileStub: sinon.SinonStub

        beforeEach(() => {
            sandbox = sinon.createSandbox()

            sandbox.stub(path, 'join').callsFake((...args) => args.join('/'))
            sandbox.stub(path, 'dirname').callsFake(p => p.split('/').slice(0, -1).join('/'))
            mkdirStub = sinon.stub(fs.promises, 'mkdir')
            writeFileStub = sinon.stub(fs.promises, 'writeFile')
        })

        afterEach(() => {
            sandbox.restore()
            if (mkdirStub?.restore) {
                mkdirStub.restore()
            }
            if (writeFileStub?.restore) {
                writeFileStub.restore()
            }
        })

        function createMockZipEntry(entryName: string, isDirectory: boolean, content?: string): IZipEntry {
            return {
                entryName,
                isDirectory,
                getData: content ? () => Buffer.from(content) : () => Buffer.from(''),
                header: {} as any,
                attr: 0,
                getCompressedData: () => Buffer.from(''),
                name: entryName,
                rawEntryName: Buffer.from(entryName),
                extra: Buffer.from(''),
                comment: '',
                getCompressedDataAsync: function (callback: (data: Buffer) => void): void {
                    throw new Error('Function not implemented.')
                },
                setData: function (value: string | Buffer): void {
                    throw new Error('Function not implemented.')
                },
                getDataAsync: function (callback: (data: Buffer, err: string) => void): void {
                    throw new Error('Function not implemented.')
                },
                packHeader: function (): Buffer {
                    throw new Error('Function not implemented.')
                },
                toString: function (): string {
                    throw new Error('Function not implemented.')
                },
            }
        }

        it('should create directories and extract files successfully', async () => {
            const pathContainingArchive = '/test/path'
            const zipEntries = [
                createMockZipEntry('dir1/', true),
                createMockZipEntry('dir1/file1.txt', false, 'content1'),
                createMockZipEntry('file2.txt', false, 'content2'),
            ]

            await transformHandler.extractAllEntriesTo(pathContainingArchive, zipEntries)

            sinon.assert.calledThrice(mkdirStub)
            sinon.assert.calledTwice(writeFileStub)
        })

        it('should handle ENOENT errors gracefully', async () => {
            const pathContainingArchive = '/test/path'
            const enoentError = new Error('ENOENT') as NodeJS.ErrnoException
            enoentError.code = 'ENOENT'

            const zipEntries = [createMockZipEntry('file1.txt', false)]
            zipEntries[0].getData = () => {
                throw enoentError
            }

            await transformHandler.extractAllEntriesTo(pathContainingArchive, zipEntries)
            expect(mockedLogging.error.args.flat()).to.include(
                'Attempted to extract a file that does not exist: file1.txt'
            )
        })

        it('should throw non-ENOENT errors', async () => {
            const pathContainingArchive = '/test/path'
            const otherError = new Error('Some other error')

            const zipEntries = [createMockZipEntry('file1.txt', false)]
            zipEntries[0].getData = () => {
                throw otherError
            }

            return transformHandler
                .extractAllEntriesTo(pathContainingArchive, zipEntries)
                .then(() => {
                    expect.fail('Expected "Some other error" to be thrown, but no error was thrown.')
                })
                .catch(error => {
                    expect(error.message).to.equal('Some other error')
                })
        })

        it('should handle nested directory structures', async () => {
            const pathContainingArchive = '/test/path'
            const zipEntries = [
                createMockZipEntry('dir1/', true),
                createMockZipEntry('dir1/dir2/', true),
                createMockZipEntry('dir1/dir2/file1.txt', false, 'content1'),
            ]

            await transformHandler.extractAllEntriesTo(pathContainingArchive, zipEntries)

            sinon.assert.calledThrice(mkdirStub)
            sinon.assert.calledOnce(writeFileStub)
            sinon.assert.calledWith(writeFileStub, '/test/path/dir1/dir2/file1.txt')
        })

        it('should handle empty entry list', async () => {
            const pathContainingArchive = '/test/path'
            const zipEntries: IZipEntry[] = []

            await transformHandler.extractAllEntriesTo(pathContainingArchive, zipEntries)

            sinon.assert.notCalled(mkdirStub)
            sinon.assert.notCalled(writeFileStub)
        })

        it('should handle files without directories', async () => {
            const pathContainingArchive = '/test/path'
            const zipEntries = [
                createMockZipEntry('file1.txt', false, 'content1'),
                createMockZipEntry('file2.txt', false, 'content2'),
            ]

            await transformHandler.extractAllEntriesTo(pathContainingArchive, zipEntries)

            sinon.assert.calledTwice(mkdirStub)
            sinon.assert.calledTwice(writeFileStub)
        })

        it('should handle mixed content with files and directories', async () => {
            const pathContainingArchive = '/test/path'
            const zipEntries = [
                createMockZipEntry('dir1/', true),
                createMockZipEntry('file1.txt', false, 'content1'),
                createMockZipEntry('dir1/file2.txt', false, 'content2'),
            ]

            await transformHandler.extractAllEntriesTo(pathContainingArchive, zipEntries)

            sinon.assert.calledThrice(mkdirStub)
            sinon.assert.calledTwice(writeFileStub)
            sinon.assert.calledWith(mkdirStub, '/test/path/dir1')
        })

        it('should throw directory creation errors', async () => {
            const pathContainingArchive = '/test/path'
            const invalidError = new Error('Invalid path') as NodeJS.ErrnoException
            invalidError.code = 'EINVAL'

            const zipEntries = [createMockZipEntry('invalid/file.txt', false, 'content')]

            ;(fs.promises.mkdir as sinon.SinonStub).rejects(invalidError)

            return transformHandler
                .extractAllEntriesTo(pathContainingArchive, zipEntries)
                .then(() => {
                    expect.fail('Expected "Invalid path" to be thrown, but no error was thrown.')
                })
                .catch(error => {
                    expect(error.message).to.equal('Invalid path')
                })
        })

        it('should only extract entries inside the destination folder', async () => {
            const pathContainingArchive = '/test/path'
            const outsideEntryNames = ['../file1.txt', 'dir1/../../file2.txt', '../path-other/file3.txt']
            const zipEntries = [
                ...outsideEntryNames.map(entryName => createMockZipEntry(entryName, false, 'content')),
                createMockZipEntry('../path-other/', true),
                createMockZipEntry('dir1/file4.txt', false, 'content'),
            ]

            await transformHandler.extractAllEntriesTo(pathContainingArchive, zipEntries)

            sinon.assert.calledOnce(writeFileStub)
            sinon.assert.calledWith(writeFileStub, '/test/path/dir1/file4.txt')
            sinon.assert.calledOnce(mkdirStub)
            sinon.assert.calledWith(mkdirStub, '/test/path/dir1')
            const errors = mockedLogging.error.args.flat()
            for (const entryName of [...outsideEntryNames, '../path-other/']) {
                expect(errors).to.include(`Blocked zip entry escaping extraction directory: ${entryName}`)
            }
        })
    })

    describe('archivePathGenerator', () => {
        let tmpDir: string
        let saveToDir: string

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transform-archive-'))
            saveToDir = path.join(tmpDir, 'solution', 'artifactWorkspace')
            mockedLogging.error.resetHistory()
        })

        afterEach(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true })
        })

        // An archive with these file entries. adm-zip changes some entry names when it writes an
        // archive, so each name is written as a placeholder of the same length and then replaced.
        function archiveWithEntries(entries: Record<string, string>): Buffer {
            const zip = new AdmZip()
            const names = Object.keys(entries)
            const placeholders = names.map((name, i) => `${i}`.padStart(name.length, 'Q'))
            names.forEach((name, i) => zip.addFile(placeholders[i], Buffer.from(entries[name])))
            const archive = zip.toBuffer()
            names.forEach((name, i) => {
                const placeholder = Buffer.from(placeholders[i])
                for (let at = archive.indexOf(placeholder); at !== -1; at = archive.indexOf(placeholder, at + 1)) {
                    Buffer.from(name).copy(archive, at)
                }
            })
            return archive
        }

        it('should only extract the entries of an archive that are inside the job folder', async () => {
            const outsideEntryNames = ['../escape1.txt', 'nested/../../escape2.txt']
            const archive = archiveWithEntries({
                [outsideEntryNames[0]]: 'outside',
                [outsideEntryNames[1]]: 'outside',
                'inside.txt': 'inside',
                'dir/inside.txt': 'inside',
            })

            const result = await transformHandler.archivePathGenerator('job-1', [archive], saveToDir)

            const jobFolder = path.join(saveToDir, 'job-1')
            expect(result).to.equal(jobFolder)
            expect(fs.readFileSync(path.join(jobFolder, 'inside.txt'), 'utf-8')).to.equal('inside')
            expect(fs.readFileSync(path.join(jobFolder, 'dir', 'inside.txt'), 'utf-8')).to.equal('inside')
            expect(fs.readdirSync(saveToDir)).to.deep.equal(['job-1'])
            const errors = mockedLogging.error.args.flat()
            for (const entryName of outsideEntryNames) {
                expect(errors).to.include(`Blocked zip entry escaping extraction directory: ${entryName}`)
            }
        })

        it('should not extract an archive for a job ID that is not a folder name', async () => {
            const archive = archiveWithEntries({ 'inside.txt': 'inside' })

            for (const jobId of [
                '',
                '.',
                '..',
                path.join('..', 'job-2'),
                ['job-1', '..', '..', 'job-2'].join(path.sep),
            ]) {
                const rejected = await transformHandler.archivePathGenerator(jobId, [archive], saveToDir).then(
                    () => false,
                    () => true
                )
                expect(rejected, jobId).to.be.true
            }
            expect(fs.readdirSync(tmpDir)).to.deep.equal([])
        })
    })
})
