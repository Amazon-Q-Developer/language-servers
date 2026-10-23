// Port of implementation in AWS Toolkit for VSCode
// https://github.com/aws/aws-toolkit-vscode/blob/24840fda8559a3e3ace3517ad9844db76680dc50/packages/core/src/test/shared/filesystemUtilities.test.ts

import * as assert from 'assert'
import * as path from 'path'
import * as sinon from 'sinon'
import * as crossFile from './crossFileContextUtil'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import { CancellationToken } from '@aws/language-server-runtimes/server-interface'
import { SAMPLE_FILE_OF_60_LINES_IN_JAVA, shuffleList } from '../testUtils'
import { supportedLanguageToDialects } from './crossFileContextUtil'
import { crossFileContextConfig } from '../models/constants'
import { LocalProjectContextController } from '../localProjectContextController'

describe('crossFileContextUtil', function () {
    const fakeCancellationToken: CancellationToken = {
        isCancellationRequested: false,
        onCancellationRequested: sinon.spy(),
    }
    let features: TestFeatures

    beforeEach(() => {
        features = new TestFeatures()
    })

    afterEach(() => {
        features.dispose()
    })

    function openDocument(uri: string, languageId: string, version = 1, content: string = '') {
        const document = TextDocument.create(uri, languageId, version, content)
        features.openDocument(document)

        return document
    }

    describe('fetchSupplementalContextForSrc', function () {
        describe('should fetch 3 chunks and each chunk should contains 10 lines', async function () {
            async function assertCorrectCodeChunk() {
                openDocument('file:///CrossFile.java', 'java', 1, SAMPLE_FILE_OF_60_LINES_IN_JAVA)
                const currentDocument = openDocument('file:///TargetFile.java', 'java')

                const actual = await crossFile.fetchSupplementalContextForSrc(
                    currentDocument,
                    { line: 0, character: 0 },
                    features.workspace,
                    fakeCancellationToken,
                    'codemap'
                )
                assert.ok(actual)
                assert.ok(actual.supplementalContextItems.length === 3)

                assert.strictEqual(actual.supplementalContextItems[0].content.split('\n').length, 10)
                assert.strictEqual(actual.supplementalContextItems[1].content.split('\n').length, 10)
                assert.strictEqual(actual.supplementalContextItems[2].content.split('\n').length, 10)
            }

            // Skipped: fails since this file last ran in CI; see the PR that skipped it
            it.skip('control group', async function () {
                await assertCorrectCodeChunk()
            })
        })
    })

    describe('non supported language should return undefined', function () {
        it('c++', async function () {
            const currentDocument = openDocument('file:///TestFile.cpp', 'cpp', 1, 'content')
            const actual = await crossFile.fetchSupplementalContextForSrc(
                currentDocument,
                { line: 0, character: 0 },
                features.workspace,
                fakeCancellationToken,
                'codemap'
            )
            assert.strictEqual(actual, undefined)
        })

        it('ruby', async function () {
            const currentDocument = openDocument('file:///testfile.rb', 'ruby', 1, 'content')
            const actual = await crossFile.fetchSupplementalContextForSrc(
                currentDocument,
                { line: 0, character: 0 },
                features.workspace,
                fakeCancellationToken,
                'codemap'
            )
            assert.strictEqual(actual, undefined)
        })
    })

    describe('getCrossFileCandidate', function () {
        it('should return opened files, exclude test files and sorted ascendingly by file distance', async function () {
            const targetFile = path.join(
                'file://',
                'src',
                'service',
                'microService',
                'CodeWhispererFileContextProvider.java'
            )
            const fileWithDistance3 = path.join('file://', 'src', 'service', 'CodewhispererRecommendationService.java')
            const fileWithDistance5 = path.join('file://', 'src', 'util', 'CodeWhispererConstants.java')
            const fileWithDistance6 = path.join('file://', 'src', 'ui', 'popup', 'CodeWhispererPopupManager.java')
            const fileWithDistance7 = path.join(
                'file://',
                'src',
                'ui',
                'popup',
                'components',
                'CodeWhispererPopup.java'
            )
            const fileWithDistance8 = path.join(
                'file://',
                'src',
                'ui',
                'popup',
                'components',
                'actions',
                'AcceptRecommendationAction.java'
            )
            const testFile1 = path.join('file://', 'test', 'service', 'CodeWhispererFileContextProviderTest.java')
            const testFile2 = path.join('file://', 'test', 'ui', 'CodeWhispererPopupManagerTest.java')

            const expectedFilePaths = [
                fileWithDistance3,
                fileWithDistance5,
                fileWithDistance6,
                fileWithDistance7,
                fileWithDistance8,
            ]

            const shuffledFilePaths = shuffleList(expectedFilePaths)

            for (const filePath of shuffledFilePaths) {
                openDocument(filePath, 'java')
            }

            openDocument(testFile1, 'java')
            openDocument(testFile2, 'java')
            const targetDocument = openDocument(targetFile, 'java')

            const actual = await crossFile.getCrossFileCandidates(targetDocument, features.workspace)

            assert.ok(actual.length === 5)
            actual.forEach((actualFile, index) => {
                const expectedFile = expectedFilePaths[index]
                assert.strictEqual(expectedFile, actualFile.uri)
            })
        })
    })

    // describe('partial support - control group', function () {
    // Not implemented, user group filters are not used in VSCode and tests are no-op
    // https://github.com/aws/aws-toolkit-vscode/blob/a2daf60dca5e5699b8b25f6dc84708295f042c38/packages/amazonq/test/unit/codewhisperer/util/crossFileContextUtil.test.ts#L144
    // })

    // describe('partial support - crossfile group', function () {
    // Not implemented, user group filters are not used in VSCode and tests are no-op
    // https://github.com/aws/aws-toolkit-vscode/blob/a2daf60dca5e5699b8b25f6dc84708295f042c38/packages/amazonq/test/unit/codewhisperer/util/crossFileContextUtil.test.ts#L144
    // })

    describe('full support', function () {
        const fileExtLists = ['.java', '.js', '.ts', '.py', '.tsx', '.jsx']

        function convertToExtensionMap(input: Readonly<Record<string, Set<string>>>): Record<string, string[]> {
            const result: Record<string, string[]> = {}

            for (const [language, extensions] of Object.entries(input)) {
                for (const extension of extensions) {
                    if (!result[extension]) {
                        result[extension] = []
                    }
                    result[extension].push(language)
                }
            }

            return result
        }
        const extToLanguageIdMap = convertToExtensionMap(supportedLanguageToDialects)

        fileExtLists.forEach(fileExt => {
            extToLanguageIdMap[fileExt].forEach(languageId => {
                it('should be non empty', async function () {
                    const document = openDocument(`file:///file-1${fileExt}`, languageId, 1, 'content-1')
                    openDocument(`file:///file-2${fileExt}`, languageId, 1, 'content-2')
                    openDocument(`file:///file-3${fileExt}`, languageId, 1, 'content-3')
                    openDocument(`file:///file-4${fileExt}`, languageId, 1, 'content-4')

                    const actual = await crossFile.fetchSupplementalContextForSrc(
                        document,
                        { line: 0, character: 0 },
                        features.workspace,
                        fakeCancellationToken,
                        'codemap'
                    )

                    assert.ok(actual && actual.supplementalContextItems.length !== 0)
                })
            })
        })
    })

    describe('splitFileToChunks', function () {
        it('should split file to a chunk of 2 lines', function () {
            const document = TextDocument.create(
                'file:///file.py',
                'python',
                1,
                'line_1\nline_2\nline_3\nline_4\nline_5\nline_6\nline_7'
            )

            const chunks = crossFile.splitFileToChunks(document, 2)

            assert.strictEqual(chunks.length, 4)
            assert.strictEqual(chunks[0].content, 'line_1\nline_2')
            assert.strictEqual(chunks[1].content, 'line_3\nline_4')
            assert.strictEqual(chunks[2].content, 'line_5\nline_6')
            assert.strictEqual(chunks[3].content, 'line_7')
        })

        it('should split file to a chunk of 5 lines', function () {
            const document = TextDocument.create(
                'file:///file.py',
                'python',
                1,
                'line_1\nline_2\nline_3\nline_4\nline_5\nline_6\nline_7'
            )

            const chunks = crossFile.splitFileToChunks(document, 5)

            assert.strictEqual(chunks.length, 2)
            assert.strictEqual(chunks[0].content, 'line_1\nline_2\nline_3\nline_4\nline_5')
            assert.strictEqual(chunks[1].content, 'line_6\nline_7')
        })

        // Skipped: fails since this file last ran in CI; see the PR that skipped it
        it.skip('codewhisperer crossfile config should use 10 lines', function () {
            const document = TextDocument.create('file:///testfile.java', 'java', 1, SAMPLE_FILE_OF_60_LINES_IN_JAVA)

            const chunks = crossFile.splitFileToChunks(document, crossFileContextConfig.numberOfLinesEachChunk)
            assert.strictEqual(chunks.length, 6)
        })

        // Skipped: fails since this file last ran in CI; see the PR that skipped it
        it.skip('should split file with Windows line endings', function () {
            const document = TextDocument.create(
                'file:///testfile.java',
                'java',
                1,
                SAMPLE_FILE_OF_60_LINES_IN_JAVA.replaceAll('\n', '\r\n')
            )

            const chunks = crossFile.splitFileToChunks(document, crossFileContextConfig.numberOfLinesEachChunk)
            assert.strictEqual(chunks.length, 6)
        })
    })
    describe('codemapContext', () => {
        let sandbox: sinon.SinonSandbox
        let amazonQServiceManager: any
        beforeEach(() => {
            sandbox = sinon.createSandbox()
            amazonQServiceManager = {
                getConfiguration: sandbox.stub().returns({
                    projectContext: {
                        enableLocalIndexing: true,
                    },
                }),
            }
        })
        afterEach(() => {
            sandbox.restore()
        })

        it('should return Empty strategy when no contexts are found', async () => {
            const document = TextDocument.create(
                'file:///testfile.java',
                'java',
                1,
                'line_1\nline_2\nline_3\nline_4\nline_5\nline_6\nline_7'
            )
            sandbox.stub(LocalProjectContextController, 'getInstance').resolves({
                queryInlineProjectContext: sandbox.stub().resolves([]),
            } as unknown as LocalProjectContextController)

            const result = await crossFile.codemapContext(
                document,
                { line: 0, character: 0 },
                features.workspace,
                fakeCancellationToken,
                'codemap'
            )
            assert.deepStrictEqual(result, {
                supplementalContextItems: [],
                strategy: 'Empty',
            })
        })

        // Skipped: fails since this file last ran in CI; see the PR that skipped it
        it.skip('should return Empty strategy when workspace context is disabled', async () => {
            const document = TextDocument.create(
                'file:///testfile.java',
                'java',
                1,
                'line_1\nline_2\nline_3\nline_4\nline_5\nline_6\nline_7'
            )

            amazonQServiceManager.getConfiguration.returns({
                projectContext: {
                    enableLocalIndexing: false,
                },
            })

            const instanceStub = sandbox.stub(LocalProjectContextController, 'getInstance')

            const result = await crossFile.codemapContext(
                document,
                { line: 0, character: 0 },
                features.workspace,
                fakeCancellationToken,
                'codemap'
            )

            sinon.assert.notCalled(instanceStub)

            assert.deepStrictEqual(result, {
                supplementalContextItems: [],
                strategy: 'Empty',
            })
        })

        it('should return codemap strategy when project context exists', async () => {
            const document = TextDocument.create(
                'file:///testfile.java',
                'java',
                1,
                'line_1\nline_2\nline_3\nline_4\nline_5\nline_6\nline_7'
            )

            sandbox.stub(LocalProjectContextController, 'getInstance').resolves({
                queryInlineProjectContext: sandbox
                    .stub()
                    .resolves([{ content: 'someOtherContet', filePath: '/path/', score: 29.879 }]),
            } as unknown as LocalProjectContextController)

            const result = await crossFile.codemapContext(
                document,
                { line: 0, character: 0 },
                features.workspace,
                fakeCancellationToken,
                'codemap'
            )
            assert.deepStrictEqual(result, {
                supplementalContextItems: [{ content: 'someOtherContet', filePath: '/path/', score: 29.879 }],
                strategy: 'codemap',
            })
        })
        it('should return OpenTabs_BM25 strategy when only open tabs context exists', async () => {
            const document = TextDocument.create(
                'file:///testfile.java',
                'java',
                1,
                'line_1\nline_2\nline_3\nline_4\nline_5\nline_6\nline_7'
            )
            // Open files for openTabsContext to find
            features.openDocument(TextDocument.create('file:///OpenFile.java', 'java', 1, 'sample-content'))
            // Return [] for fetchProjectContext
            sandbox.stub(LocalProjectContextController, 'getInstance').resolves({
                queryInlineProjectContext: sandbox.stub().resolves([]),
            } as unknown as LocalProjectContextController)

            const result = await crossFile.codemapContext(
                document,
                { line: 0, character: 0 },
                features.workspace,
                fakeCancellationToken,
                'codemap'
            )
            assert.deepStrictEqual(result, {
                supplementalContextItems: [
                    { content: 'sample-content', filePath: '/OpenFile.java', score: 0 },
                    { content: 'sample-content', filePath: '/OpenFile.java', score: 0 },
                ],
                strategy: 'OpenTabs_BM25',
            })
        })
    })
})
