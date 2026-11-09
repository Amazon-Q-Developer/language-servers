import { Logging, Workspace } from '@aws/language-server-runtimes/server-interface'
import * as assert from 'assert'
import * as path from 'path'
import * as Sinon from 'sinon'
import { StubbedInstance, stubInterface } from 'ts-sinon'
import { CsharpDependencyGraph } from './csharpDependencyGraph'

describe('Test CsharpDependencyGraph', () => {
    let csharpDependencyGraph: CsharpDependencyGraph
    const mockedGetWorkspaceFolder = Sinon.mock()
    let mockedLogging: StubbedInstance<Logging>
    const projectPathUri = path.resolve(path.join(__dirname, 'sampleWs'))
    const tempDirPath = path.resolve('\\Temp')
    const mockedFs = {
        copyFile: Sinon.mock(),
        getFileSize: Sinon.mock(),
        getTempDirPath: () => tempDirPath,
        readdir: Sinon.stub(),
        readFile: Sinon.stub(),
        isFile: Sinon.mock(),
    }

    const mockedWorkspace: Workspace = {
        getTextDocument: Sinon.mock(),
        getAllTextDocuments: Sinon.mock(),
        getWorkspaceFolder: mockedGetWorkspaceFolder,
        // @ts-ignore mockedFs doesn't need to mock every fs function for this test to work
        fs: mockedFs,
    }

    beforeEach(() => {
        mockedGetWorkspaceFolder.reset()
        mockedGetWorkspaceFolder.returns(undefined)
        mockedLogging = stubInterface<Logging>()
        csharpDependencyGraph = new CsharpDependencyGraph(mockedWorkspace, mockedLogging, projectPathUri)
    })

    describe('Test getPayloadSizeLimitInBytes', () => {
        it('should return correct payload size', () => {
            const expectedPayloadSize = Math.pow(2, 20)
            assert.strictEqual(csharpDependencyGraph.getPayloadSizeLimitInBytes(), expectedPayloadSize)
        })
    })

    describe('Test getProjectName', () => {
        beforeEach(() => {
            mockedFs.isFile.reset()
            mockedFs.isFile.resolves(false)
        })
        it('should return current folder name for given file path outside workspace folder', async () => {
            mockedFs.isFile.resolves(true)
            assert.strictEqual(
                await csharpDependencyGraph.getProjectName(path.join(projectPathUri, 'sample.cs')),
                'sampleWs'
            )
        })
        it('should return correct project name for given forlder path within workspace folder', async () => {
            const expectedProjectName = 'sampleWs'
            mockedGetWorkspaceFolder.returns({ uri: projectPathUri, name: expectedProjectName })
            assert.strictEqual(
                await csharpDependencyGraph.getProjectName(path.join(projectPathUri, 'src')),
                expectedProjectName
            )
        })
    })

    describe('Test getProjectPath', () => {
        beforeEach(() => {
            mockedFs.isFile.reset()
            mockedFs.isFile.resolves(false)
        })
        it('should not find workspace folder path for given path', async () => {
            const fileFolderPath = path.resolve('\\workspace\\src')
            const fileUri = path.join(fileFolderPath, 'sample.cs')
            mockedFs.isFile.resolves(true)

            const response = await csharpDependencyGraph.getProjectPath(fileUri)
            assert.strictEqual(response, fileFolderPath)
        })
        it('should return project name for within project file', async () => {
            const expectedProjectName = 'sampleWs'

            mockedGetWorkspaceFolder.returns({ uri: projectPathUri, name: expectedProjectName })
            assert.strictEqual(
                await csharpDependencyGraph.getProjectPath(path.join(projectPathUri, 'src')),
                projectPathUri
            )
            mockedGetWorkspaceFolder.reset()
        })
    })

    describe('Test getReadableSizeLimit', () => {
        it('should return size 1 MB', () => {
            assert.strictEqual(csharpDependencyGraph.getReadableSizeLimit(), '1MB')
        })
    })

    describe('Test exceedsSizeLimit', () => {
        it('should not exceed size limit', () => {
            const size = 100
            const expectedResult = false
            assert.strictEqual(csharpDependencyGraph.exceedsSizeLimit(size), expectedResult)
        })
        it('should exceed size limit', () => {
            const size = Math.pow(2, 21)
            const expectedResult = true
            assert.strictEqual(csharpDependencyGraph.exceedsSizeLimit(size), expectedResult)
        })
    })

    describe('Test createNamespaceFilenameMapper', () => {
        beforeEach(() => {
            mockedFs.readdir.reset()
            mockedFs.readFile.reset()
            mockedFs.readdir.callsFake(async dirpath => {
                switch (dirpath) {
                    case projectPathUri:
                        return [
                            {
                                isFile: () => false,
                                isDirectory: () => true,
                                name: 'src',
                                path: projectPathUri,
                            },
                        ]
                    case path.join(projectPathUri, 'src'):
                        return [
                            {
                                isFile: () => true,
                                isDirectory: () => false,
                                name: 'sample.cs',
                                path: path.join(projectPathUri, 'src'),
                            },
                            {
                                isFile: () => true,
                                isDirectory: () => false,
                                name: 'model.cs',
                                path: path.join(projectPathUri, 'src'),
                            },
                        ]
                    default:
                        return []
                }
            })
        })

        it('should create the map with namespace to filepath mapping', async () => {
            mockedFs.readFile.callsFake(async filePath => {
                if (filePath === path.join(projectPathUri, 'src', 'sample.cs')) {
                    return `namespace Amazon.Cw.Utils.Sample {}`
                }
                if (filePath === path.join(projectPathUri, 'src', 'model.cs')) {
                    return `namespace Amazon.Cw.Model {}`
                }
            })
            await csharpDependencyGraph.createNamespaceFilenameMapper(projectPathUri)
            assert.deepStrictEqual(
                csharpDependencyGraph.namespaceToFilepathDirectory,
                new Map([
                    ['Amazon.Cw.Model', new Set([path.join(projectPathUri, 'src', 'model.cs')])],
                    ['Amazon.Cw.Utils.Sample', new Set([path.join(projectPathUri, 'src', 'sample.cs')])],
                ])
            )
        })
        it('should create empty map', async () => {
            csharpDependencyGraph.namespaceToFilepathDirectory = new Map<string, Set<string>>()
            mockedFs.readFile.callsFake(async filePath => {
                if (filePath === path.join(projectPathUri, 'src', 'sample.cs')) {
                    return `using static Amazon.Cw.Sample;`
                }
                if (filePath === path.join(projectPathUri, 'src', 'model.cs')) {
                    return ``
                }
            })
            await csharpDependencyGraph.createNamespaceFilenameMapper(projectPathUri)
            assert.deepStrictEqual(csharpDependencyGraph.namespaceToFilepathDirectory, new Map([]))
        })
        it('should treat the dot between namespace names as a literal dot', async () => {
            csharpDependencyGraph.namespaceToFilepathDirectory = new Map<string, Set<string>>()
            mockedFs.readFile.callsFake(async filePath => {
                if (filePath === path.join(projectPathUri, 'src', 'sample.cs')) {
                    return `namespace Foo.Bar {}`
                }
                if (filePath === path.join(projectPathUri, 'src', 'model.cs')) {
                    return `namespace Foo Bar {}`
                }
            })
            await csharpDependencyGraph.createNamespaceFilenameMapper(projectPathUri)
            assert.deepStrictEqual(
                csharpDependencyGraph.namespaceToFilepathDirectory,
                new Map([
                    ['Foo.Bar', new Set([path.join(projectPathUri, 'src', 'sample.cs')])],
                    ['Foo', new Set([path.join(projectPathUri, 'src', 'model.cs')])],
                ])
            )
        })
    })
    describe('Test searchDependency', () => {
        beforeEach(() => {
            mockedFs.getFileSize.reset()
            mockedFs.readFile.reset()

            csharpDependencyGraph.namespaceToFilepathDirectory = new Map([
                ['Amazon.Cw.Model', new Set([path.join(projectPathUri, 'src', 'model.cs')])],
                ['Amazon.Cw.Utils.Sample', new Set([path.join(projectPathUri, 'src', 'sample.cs')])],
                [
                    'Amazon.Cw.Props',
                    new Set([
                        path.join(projectPathUri, 'src', 'interface', 'model.cs'),
                        path.join(projectPathUri, 'src', 'interface', 'recommendations.cs'),
                    ]),
                ],
            ])
        })

        it('should return source file only for no dependencies', async () => {
            mockedFs.readFile.resolves(`var total = 5 + 4;`)
            mockedFs.getFileSize.resolves({ size: 1000 })
            const filePath = path.join(projectPathUri, 'main.cs')

            const pickedSourceFiles = await csharpDependencyGraph.searchDependency(filePath)
            assert.deepStrictEqual(pickedSourceFiles, new Set([filePath]))
        })

        it("should return source file with its dependecies' file path", async () => {
            mockedFs.getFileSize.atLeast(1).resolves({ size: 1000 })

            mockedFs.readFile.onFirstCall().resolves(
                `using Amazon.Cw.Props;
        var total = 5 + 4;`
            )
            const pickedSourceFiles = await csharpDependencyGraph.searchDependency(path.join(projectPathUri, 'main.cs'))
            assert.deepStrictEqual(
                pickedSourceFiles,
                new Set([
                    path.join(projectPathUri, 'main.cs'),
                    path.join(projectPathUri, 'src', 'interface', 'recommendations.cs'),
                    path.join(projectPathUri, 'src', 'interface', 'model.cs'),
                ])
            )
        })

        it("should return source file with its dependecies' until it reaches to payload size limit", async () => {
            mockedFs.getFileSize.onFirstCall().resolves({ size: Math.pow(2, 19) })
            mockedFs.getFileSize.onSecondCall().resolves({ size: Math.pow(2, 19) })

            mockedFs.readFile.onFirstCall().resolves(
                `using Amazon.Cw.Props;
        var total = 5 + 4;`
            )
            const pickedSourceFiles = await csharpDependencyGraph.searchDependency(path.join(projectPathUri, 'main.cs'))
            assert.deepStrictEqual(
                pickedSourceFiles,
                new Set([
                    path.join(projectPathUri, 'main.cs'),
                    path.join(projectPathUri, 'src', 'interface', 'model.cs'),
                ])
            )
        })
    })
    describe('Test traverseDir', () => {
        beforeEach(() => {
            mockedFs.getFileSize.reset()
            mockedFs.readFile.reset()
            mockedFs.readdir.reset()
            csharpDependencyGraph.namespaceToFilepathDirectory = new Map([
                ['Amazon.Cw.Model', new Set([path.join(projectPathUri, 'src', 'model.cs')])],
                ['Amazon.Cw.Utils.Sample', new Set([path.join(projectPathUri, 'src', 'sample.cs')])],
                [
                    'Amazon.Cw.Props',
                    new Set([
                        path.join(projectPathUri, 'src', 'interface', 'scan.cs'),
                        path.join(projectPathUri, 'src', 'interface', 'recommendations.cs'),
                    ]),
                ],
            ])
            mockedFs.readdir.callsFake(async dirpath => {
                switch (dirpath) {
                    case projectPathUri:
                        return [
                            {
                                isFile: () => false,
                                isDirectory: () => true,
                                name: 'src',
                                path: projectPathUri,
                            },
                        ]
                    case path.join(projectPathUri, 'src'):
                        return [
                            {
                                isFile: () => true,
                                isDirectory: () => false,
                                name: 'sample.cs',
                                path: path.join(projectPathUri, 'src'),
                            },
                            {
                                isFile: () => true,
                                isDirectory: () => false,
                                name: 'model.cs',
                                path: path.join(projectPathUri, 'src'),
                            },
                            {
                                isFile: () => false,
                                isDirectory: () => true,
                                name: 'props',
                                path: path.join(projectPathUri, 'src'),
                            },
                        ]
                    case path.join(projectPathUri, 'src', 'props'):
                        return [
                            {
                                isFile: () => true,
                                isDirectory: () => false,
                                name: 'scan.cs',
                                path: path.join(projectPathUri, 'src', 'props'),
                            },
                            {
                                isFile: () => true,
                                isDirectory: () => false,
                                name: 'recommendation.cs',
                                path: path.join(projectPathUri, 'src', 'props'),
                            },
                        ]
                    default:
                        return []
                }
            })
        })
        it('should return without traversing due to payload size limit reached', async () => {
            mockedFs.getFileSize.resolves({ size: Math.pow(2, 20) })
            await csharpDependencyGraph.searchDependency(path.join(projectPathUri, 'main.cs'))
            await csharpDependencyGraph.traverseDir(projectPathUri)
            assert.strictEqual(mockedFs.readFile.calledWith(projectPathUri), false)
        })
        it('should traverse through files until it reaches payload size limit', async () => {
            mockedFs.getFileSize.atLeast(1).resolves({ size: Math.pow(2, 19) })
            await csharpDependencyGraph.traverseDir(projectPathUri)
            assert.strictEqual(csharpDependencyGraph.isProjectTruncated, true)
        })
        it('should traverse through all files', async () => {
            mockedFs.getFileSize.atLeast(1).resolves({ size: Math.pow(2, 10) })
            await csharpDependencyGraph.traverseDir(projectPathUri)
            assert.strictEqual(csharpDependencyGraph.isProjectTruncated, false)
        })
    })
    describe('Test getDependencies', () => {
        beforeEach(() => {
            csharpDependencyGraph.namespaceToFilepathDirectory = new Map([
                ['Amazon.Cw.Model', new Set([path.join(projectPathUri, 'src', 'model.cs')])],
                ['Amazon.Cw.Utils.Sample', new Set([path.join(projectPathUri, 'src', 'sample.cs')])],
                [
                    'Amazon.Cw.Props',
                    new Set([
                        path.join(projectPathUri, 'src', 'interface', 'scan.cs'),
                        path.join(projectPathUri, 'src', 'interface', 'recommendations.cs'),
                    ]),
                ],
            ])
        })
        it('should return file paths for given imports', () => {
            const expectedResponse = new Set([
                path.join(projectPathUri, 'src', 'model.cs'),
                path.join(projectPathUri, 'src', 'sample.cs'),
            ])
            assert.deepStrictEqual(
                csharpDependencyGraph.getDependencies(['Amazon.Cw.Utils.Sample', 'Amazon.Cw.Model']),
                expectedResponse
            )
        })
        it('should return empty list', () => {
            assert.deepStrictEqual(csharpDependencyGraph.getDependencies(['Amazon.Cw']), new Set())
        })
    })
    describe('Test readImports', () => {
        it('should return list of imports ', () => {
            const content = `
global using static Amazon.Cw.Utils;
using Amazon.Cw.Model;
using Proto = Amazon.Cw.Prototypes;
namespace Amazon.Toolkit.Demo {
  class Main {
    pulbic print() {

    }
  }
}
        `
            const response = csharpDependencyGraph.readImports(content)
            const expectedImports = ['Amazon.Cw.Utils', 'Amazon.Cw.Model', 'Amazon.Cw.Prototypes']
            assert.deepStrictEqual(response, expectedImports)
        })
        it('should return empty list', () => {
            const content = `
namespace Amazon.Toolkit.Demo {
  class Main {
    pulbic print() {
    }
  }
}
        `
            const response = csharpDependencyGraph.readImports(content)
            assert.deepStrictEqual(response, [])
        })
        it('should read indented, aliased and static imports', () => {
            const content = [
                '    using System.Collections.Generic;',
                '\tglobal using static System.Math;',
                'using   Alias   =   Foo.Bar.Baz;',
                'using X;',
            ].join('\r\n')
            assert.deepStrictEqual(csharpDependencyGraph.readImports(content), [
                'System.Collections.Generic',
                'System.Math',
                'Foo.Bar.Baz',
                'X',
            ])
        })
        it('should treat the dot between names as a literal dot', () => {
            const content = ['using Foo Bar;', 'using Foo,Bar;', 'using Foo-Bar;', 'using Foo.Bar;'].join('\n')
            assert.deepStrictEqual(csharpDependencyGraph.readImports(content), ['Foo.Bar'])
        })

        // None of these lines has a ';', so the pattern must fail on each of them in linear time. The two names
        // without dots and the run of whitespace took the old pattern seconds or more. Each line now takes well under
        // a millisecond, so the limit only has to catch a regression, not measure speed.
        const slowInputs: { name: string; content: string }[] = [
            { name: 'a long name without a semicolon', content: `using ${'A'.repeat(40)}` },
            { name: 'a long aliased name without a semicolon', content: `using Alias = ${'A'.repeat(40)}` },
            { name: 'a long dotted name without a semicolon', content: `using ${Array(5000).fill('Ab').join('.')}` },
            { name: 'a long run of whitespace', content: `${' '.repeat(100000)}x` },
        ]
        for (const { name, content } of slowInputs) {
            it(`should read ${name} in linear time`, () => {
                const start = process.hrtime.bigint()
                const response = csharpDependencyGraph.readImports(content)
                const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6

                assert.deepStrictEqual(response, [])
                assert.ok(elapsedMs < 500, `readImports took ${elapsedMs.toFixed(1)} ms`)
            })
        }
    })
    describe('Test generateTruncation', () => {
        before(() => {
            Sinon.stub(Date, 'now').returns(111111111)
        })
        it('should call zip dir', async () => {
            const zipSize = Math.pow(2, 19)
            const zipFileBuffer = 'dummy-zip-data'
            mockedFs.getFileSize.atLeast(1).resolves({ size: zipSize })
            csharpDependencyGraph.createZip = Sinon.stub().returns({
                zipFileBuffer,
                zipFileSize: zipSize,
            })
            const expectedResult = {
                rootDir: path.join(tempDirPath, 'codewhisperer_scan_111111111'),
                zipFileBuffer,
                scannedFiles: new Set([path.join(projectPathUri, 'main.cs')]),
                srcPayloadSizeInBytes: zipSize,
                zipFileSizeInBytes: zipSize,
                buildPayloadSizeInBytes: 0,
                lines: 0,
            }

            const trucation = await csharpDependencyGraph.generateTruncation(path.join(projectPathUri, 'main.cs'))

            assert.deepStrictEqual(trucation, expectedResult)
        })
    })

    describe('Test filterFiles', () => {
        beforeEach(() => {
            mockedFs.isFile.reset()
            mockedFs.isFile.resolves(false)
            mockedFs.readdir.reset()
            mockedFs.readFile.reset()
            // setup sample directory structure
            mockedFs.readdir.callsFake(async dirpath => {
                switch (dirpath) {
                    case projectPathUri:
                        return [
                            {
                                isFile: () => false,
                                isDirectory: () => true,
                                name: 'src',
                                path: projectPathUri,
                            },
                        ]
                    case path.join(projectPathUri, 'src'):
                        return [
                            {
                                isFile: () => true,
                                isDirectory: () => false,
                                name: '.gitignore',
                                path: path.join(projectPathUri, 'src'),
                            },
                            {
                                isFile: () => true,
                                isDirectory: () => false,
                                name: 'sample.cs',
                                path: path.join(projectPathUri, 'src'),
                            },
                            {
                                isFile: () => true,
                                isDirectory: () => false,
                                name: 'model.cs',
                                path: path.join(projectPathUri, 'src'),
                            },
                            {
                                isFile: () => false,
                                isDirectory: () => true,
                                name: 'bin',
                                path: path.join(projectPathUri, 'src'),
                            },
                            {
                                isFile: () => false,
                                isDirectory: () => true,
                                name: 'Obj',
                                path: path.join(projectPathUri, 'src'),
                            },
                            {
                                isFile: () => true,
                                isDirectory: () => false,
                                name: 'ignoredFile1.cs',
                                path: path.join(projectPathUri, 'src'),
                            },
                        ]
                    case path.join(projectPathUri, 'src', 'bin'):
                        return [
                            {
                                isFile: () => true,
                                isDirectory: () => false,
                                name: 'bin-file.cs',
                                path: path.join(projectPathUri, 'src', 'bin'),
                            },
                        ]
                    case path.join(projectPathUri, 'src', 'Obj'):
                        return [
                            {
                                isFile: () => true,
                                isDirectory: () => false,
                                name: 'obj-file.cs',
                                path: path.join(projectPathUri, 'src', 'Obj'),
                            },
                        ]
                    default:
                        return []
                }
            })
        })

        it('should return all files in the workspace not excluded by gitignore', async function () {
            const gitignoreContent = `
ignoredFile1.cs

# Build results
[Dd]ebug/
[Dd]ebugPublic/
[Rr]elease/
[Rr]eleases/
x64/
x86/
[Ww][Ii][Nn]32/
[Aa][Rr][Mm]/
[Aa][Rr][Mm]64/
bld/
[Bb]in/
[Oo]bj/
`
            mockedFs.readFile.callsFake(async filePath => {
                if (filePath.endsWith('.gitignore')) {
                    return gitignoreContent
                }
                return ''
            })

            const allFiles = await csharpDependencyGraph.getFiles(projectPathUri)

            const csharpFiles = await csharpDependencyGraph.filterFiles(projectPathUri, allFiles)

            assert.strictEqual(csharpFiles.length, 2)

            // returns git allowed c# files
            assert.deepStrictEqual(csharpFiles, [
                path.join(projectPathUri, 'src', 'sample.cs'),
                path.join(projectPathUri, 'src', 'model.cs'),
            ])
        })
    })
})
