import {
    Server,
    InlineCompletionListWithReferences,
    CancellationToken,
    InlineCompletionTriggerKind,
    InitializeParams,
} from '@aws/language-server-runtimes/server-interface'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import * as assert from 'assert'
import sinon, { StubbedInstance, stubInterface } from 'ts-sinon'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { CodewhispererServerFactory } from '../codeWhispererServer'
import {
    CodeWhispererServiceBase,
    ResponseContext,
    Suggestion,
    SuggestionType,
} from '../../../shared/codeWhispererService'
import { CodeWhispererSession, SessionManager } from '../session/sessionManager'
import { TelemetryService } from '../../../shared/telemetry/telemetryService'
import { initBaseTestServiceManager, TestAmazonQServiceManager } from '../../../shared/amazonQServiceManager/testUtils'
import { getNormalizeOsName } from '../auto-trigger/autoTrigger'

describe('Telemetry', () => {
    const sandbox = sinon.createSandbox()
    let SESSION_IDS_LOG: string[] = []
    let sessionManager: SessionManager
    let sessionManagerSpy: sinon.SinonSpiedInstance<SessionManager>
    let generateSessionIdStub: sinon.SinonStub
    let clock: sinon.SinonFakeTimers
    let telemetryServiceSpy: sinon.SinonSpy

    beforeEach(() => {
        const StubSessionIdGenerator = () => {
            let id = 'some-random-session-uuid-' + SESSION_IDS_LOG.length
            SESSION_IDS_LOG.push(id)

            return id
        }
        generateSessionIdStub = sinon
            .stub(CodeWhispererSession.prototype, 'generateSessionId')
            .callsFake(StubSessionIdGenerator)
        SessionManager.reset()
        sessionManager = SessionManager.getInstance()
        sessionManagerSpy = sandbox.spy(sessionManager)
        SESSION_IDS_LOG = []

        clock = sinon.useFakeTimers({
            now: 1483228800000,
        })
        telemetryServiceSpy = sinon.spy(TelemetryService.prototype, 'emitUserTriggerDecision')
    })

    afterEach(() => {
        generateSessionIdStub.restore()
        clock.restore()
        sandbox.restore()
        telemetryServiceSpy.restore()
    })

    describe('User Trigger Decision telemetry', () => {
        const HELLO_WORLD_IN_CSHARP = `class HelloWorld
{
    static void Main()
    {
        Console.WriteLine("Hello World!");
    }
}
`
        const AUTO_TRIGGER_POSITION = { line: 2, character: 21 }
        const SOME_FILE = TextDocument.create('file:///test.cs', 'csharp', 1, HELLO_WORLD_IN_CSHARP)
        const SOME_FILE_WITH_ALT_CASED_LANGUAGE_ID = TextDocument.create(
            // Use unsupported extension, so that we can test that we get a match based on the LanguageId
            'file:///test.seesharp',
            'CSharp',
            1,
            HELLO_WORLD_IN_CSHARP
        )
        const EXPECTED_REFERENCE = {
            licenseName: 'test license',
            repository: 'test repository',
            url: 'test url',
            recommendationContentSpan: { start: 0, end: 1 },
        }
        const DEFAULT_SUGGESTIONS: Suggestion[] = [
            { itemId: 'cwspr-item-id-1', content: 'recommendation' },
            { itemId: 'cwspr-item-id-2', content: 'recommendation' },
            { itemId: 'cwspr-item-id-3', content: 'recommendation' },
        ]
        const EXPECTED_RESULT = {
            sessionId: 'some-random-session-uuid-0',
            items: [
                {
                    itemId: DEFAULT_SUGGESTIONS[0].itemId,
                    insertText: DEFAULT_SUGGESTIONS[0].content,
                    range: undefined,
                    references: undefined,
                    mostRelevantMissingImports: undefined,
                },
                {
                    itemId: DEFAULT_SUGGESTIONS[1].itemId,
                    insertText: DEFAULT_SUGGESTIONS[1].content,
                    range: undefined,
                    references: undefined,
                    mostRelevantMissingImports: undefined,
                },
                {
                    itemId: DEFAULT_SUGGESTIONS[2].itemId,
                    insertText: DEFAULT_SUGGESTIONS[2].content,
                    range: undefined,
                    references: undefined,
                    mostRelevantMissingImports: undefined,
                },
            ],
            partialResultToken: undefined,
        }
        const EXPECTED_RESPONSE_CONTEXT: ResponseContext = {
            requestId: 'cwspr-request-id',
            codewhispererSessionId: 'cwspr-session-id',
        }
        const DEFAULT_SESSION_RESULT_DATA = {
            sessionId: 'some-random-session-uuid-0',
            completionSessionResult: {
                'cwspr-item-id-1': {
                    seen: true,
                    accepted: false,
                    discarded: false,
                },
                'cwspr-item-id-2': {
                    seen: true,
                    accepted: false,
                    discarded: false,
                },
                'cwspr-item-id-3': {
                    seen: true,
                    accepted: false,
                    discarded: false,
                },
            },
        }
        const EMPTY_RESULT = { items: [], sessionId: '' }
        const classifierResult = getNormalizeOsName() !== 'Linux' ? 0.6014326616203989 : 0.61475353067264

        let features: TestFeatures
        let server: Server
        // TODO move more of the service code out of the stub and into the testable realm
        // See: https://aws.amazon.com/blogs/developer/mocking-modular-aws-sdk-for-javascript-v3-in-unit-tests/
        // for examples on how to mock just the SDK client
        let service: StubbedInstance<CodeWhispererServiceBase>
        const setServiceResponse = (
            suggestions: Suggestion[],
            responseContext: ResponseContext,
            time: number = 2000
        ) => {
            service.generateSuggestions.callsFake(_request => {
                clock.tick(time)

                return Promise.resolve({
                    suggestions,
                    responseContext,
                    suggestionType: SuggestionType.COMPLETION,
                })
            })
        }

        const autoTriggerInlineCompletionWithReferences = async () =>
            await features.doInlineCompletionWithReferences(
                {
                    textDocument: { uri: SOME_FILE.uri },
                    position: AUTO_TRIGGER_POSITION,
                    context: { triggerKind: InlineCompletionTriggerKind.Automatic },
                },
                CancellationToken.None
            )

        const manualTriggerInlineCompletionWithReferences = async () =>
            await features.doInlineCompletionWithReferences(
                {
                    textDocument: { uri: SOME_FILE.uri },
                    position: { line: 0, character: 0 },
                    context: { triggerKind: InlineCompletionTriggerKind.Invoked },
                },
                CancellationToken.None
            )

        beforeEach(async () => {
            // Set up the server with a mock service, returning predefined recommendations
            service = stubInterface<CodeWhispererServiceBase>()
            setServiceResponse(DEFAULT_SUGGESTIONS, EXPECTED_RESPONSE_CONTEXT)

            // Initialize the features, but don't start server yet
            features = new TestFeatures()
            server = CodewhispererServerFactory(() => initBaseTestServiceManager(features, service))

            // Return no specific configuration for CodeWhisperer
            features.lsp.workspace.getConfiguration.returns(Promise.resolve({}))

            // Return credentialsStartUrl value
            features.credentialsProvider.getConnectionMetadata.returns({
                sso: {
                    startUrl: 'teststarturl',
                },
            })

            // Start the server and open a document
            await features.initialize(server)
            await TestAmazonQServiceManager.getInstance().handleDidChangeConfiguration()

            features.openDocument(SOME_FILE).openDocument(SOME_FILE_WITH_ALT_CASED_LANGUAGE_ID)
        })

        afterEach(() => {
            TestAmazonQServiceManager.resetInstance()
            features.dispose()
        })

        const aUserTriggerDecision = (override: object = {}) => {
            return {
                id: 'some-random-session-uuid-0',
                document: {
                    _uri: 'file:///test.cs',
                    _languageId: 'csharp',
                    _version: 1,
                    _content:
                        'class HelloWorld\n' +
                        '{\n' +
                        '    static void Main()\n' +
                        '    {\n' +
                        '        Console.WriteLine("Hello World!");\n' +
                        '    }\n' +
                        '}\n',
                    _lineOffsets: [0, 17, 19, 42, 48, 91, 97, 99],
                },
                startTime: 1483228800000,
                closeTime: 1483228802000,
                state: 'CLOSED',
                codewhispererSessionId: 'cwspr-session-id',
                startPosition: { line: 2, character: 21 },
                suggestionsAfterRightContextMerge: [],
                suggestions: [
                    { itemId: 'cwspr-item-id-1', content: '' },
                    { itemId: 'cwspr-item-id-2', content: '' },
                    { itemId: 'cwspr-item-id-3', content: '' },
                ],
                suggestionsStates: new Map([
                    ['cwspr-item-id-1', 'Empty'],
                    ['cwspr-item-id-2', 'Empty'],
                    ['cwspr-item-id-3', 'Empty'],
                ]),
                acceptedSuggestionId: undefined,
                responseContext: {
                    requestId: 'cwspr-request-id',
                    codewhispererSessionId: 'cwspr-session-id',
                },
                triggerType: 'AutoTrigger',
                autoTriggerType: 'SpecialCharacters',
                triggerCharacter: '(',
                classifierResult: classifierResult,
                classifierThreshold: 0.43,
                language: 'csharp',
                requestContext: {
                    fileContext: {
                        filename: 'test.cs',
                        programmingLanguage: {
                            languageName: 'csharp',
                        },
                        leftFileContent: 'class HelloWorld\n{\n    static void Main(',
                        rightFileContent: ')\n    {\n        Console.WriteLine("Hello World!");\n    }\n}\n',
                        workspaceFolder: undefined,
                    },
                    maxResults: 1,
                },
                supplementalMetadata: undefined,
                timeToFirstRecommendation: 2000,
                credentialStartUrl: 'teststarturl',
                completionSessionResult: undefined,
                firstCompletionDisplayLatency: undefined,
                totalSessionDisplayTime: undefined,
                typeaheadLength: undefined,
                previousTriggerDecision: undefined,
                previousTriggerDecisionTime: undefined,
                reportedUserDecision: true,
                customizationArn: undefined,
                ...override,
            }
        }

        describe('Case 1. Session is processed by server without sending results', () => {
            it('should send Empty user desicion when Codewhisperer returned list of empty suggestions and close session', async () => {
                const SUGGESTIONS = [
                    { itemId: 'cwspr-item-id-1', content: '' },
                    { itemId: 'cwspr-item-id-2', content: '' },
                    { itemId: 'cwspr-item-id-3', content: '' },
                ]
                setServiceResponse(SUGGESTIONS, EXPECTED_RESPONSE_CONTEXT)

                await autoTriggerInlineCompletionWithReferences()

                const currentSession = sessionManager.getCurrentSession()
                assert(currentSession)
                assert.equal(currentSession.state, 'CLOSED')
                sinon.assert.calledOnceWithExactly(sessionManagerSpy.closeSession, currentSession)

                const expectedUserTriggerDecisionMetric = aUserTriggerDecision()
                sinon.assert.calledWithMatch(telemetryServiceSpy, expectedUserTriggerDecisionMetric, 'Empty')
            })

            it('should send Empty User Decision when Codewhisperer returned empty list of suggestions', async () => {
                const SUGGESTIONS: Suggestion[] = []
                setServiceResponse(SUGGESTIONS, EXPECTED_RESPONSE_CONTEXT)

                await autoTriggerInlineCompletionWithReferences()

                const currentSession = sessionManager.getCurrentSession()
                assert(currentSession)
                assert.equal(currentSession.state, 'CLOSED')
                sinon.assert.calledOnceWithExactly(sessionManagerSpy.closeSession, currentSession)

                const expectedUserTriggerDecisionMetric = aUserTriggerDecision({
                    suggestions: [],
                    suggestionsStates: new Map([]),
                })
                sinon.assert.calledWithMatch(telemetryServiceSpy, expectedUserTriggerDecisionMetric, 'Empty')
            })

            it('should send Discard User Decision when all suggestions are filtered out by includeSuggestionsWithCodeReferences setting filter', async () => {
                features.lsp.workspace.getConfiguration.returns(
                    Promise.resolve({ includeSuggestionsWithCodeReferences: false })
                )
                const SUGGESTIONS: Suggestion[] = [
                    {
                        itemId: 'cwspr-item-id-1',
                        content: 'recommendation with reference',
                        references: [EXPECTED_REFERENCE],
                    },
                    {
                        itemId: 'cwspr-item-id-2',
                        content: 'recommendation with reference',
                        references: [EXPECTED_REFERENCE],
                    },
                    {
                        itemId: 'cwspr-item-id-3',
                        content: 'recommendation with reference',
                        references: [EXPECTED_REFERENCE],
                    },
                ]
                setServiceResponse(SUGGESTIONS, EXPECTED_RESPONSE_CONTEXT)

                await autoTriggerInlineCompletionWithReferences()

                const currentSession = sessionManager.getCurrentSession()
                assert(currentSession)
                assert.equal(currentSession.state, 'CLOSED')
                sinon.assert.calledOnceWithExactly(sessionManagerSpy.closeSession, currentSession)

                const expectedUserTriggerDecisionMetric = aUserTriggerDecision({
                    suggestions: [
                        {
                            itemId: 'cwspr-item-id-1',
                            content: 'recommendation with reference',
                            references: [EXPECTED_REFERENCE],
                        },
                        {
                            itemId: 'cwspr-item-id-2',
                            content: 'recommendation with reference',
                            references: [EXPECTED_REFERENCE],
                        },
                        {
                            itemId: 'cwspr-item-id-3',
                            content: 'recommendation with reference',
                            references: [EXPECTED_REFERENCE],
                        },
                    ],
                    suggestionsStates: new Map([
                        ['cwspr-item-id-1', 'Filter'],
                        ['cwspr-item-id-2', 'Filter'],
                        ['cwspr-item-id-3', 'Filter'],
                    ]),
                })
                sinon.assert.calledWithMatch(telemetryServiceSpy, expectedUserTriggerDecisionMetric, 'Discard')
            })

            it('should send Discard User Decision when all suggestions are discarded after right context merge', async () => {
                const SUGGESTIONS: Suggestion[] = [
                    { itemId: 'cwspr-item-id-1', content: HELLO_WORLD_IN_CSHARP },
                    { itemId: 'cwspr-item-id-2', content: HELLO_WORLD_IN_CSHARP },
                    { itemId: 'cwspr-item-id-3', content: HELLO_WORLD_IN_CSHARP },
                ]
                setServiceResponse(SUGGESTIONS, EXPECTED_RESPONSE_CONTEXT)

                await manualTriggerInlineCompletionWithReferences()

                const currentSession = sessionManager.getCurrentSession()
                assert(currentSession)
                assert.equal(currentSession?.state, 'CLOSED')
                sinon.assert.calledOnceWithExactly(sessionManagerSpy.closeSession, currentSession)

                const expectedUserTriggerDecisionMetric = aUserTriggerDecision({
                    startPosition: { line: 0, character: 0 },
                    suggestions: [
                        {
                            itemId: 'cwspr-item-id-1',
                            content:
                                'class HelloWorld\n' +
                                '{\n' +
                                '    static void Main()\n' +
                                '    {\n' +
                                '        Console.WriteLine("Hello World!");\n' +
                                '    }\n' +
                                '}\n',
                        },
                        {
                            itemId: 'cwspr-item-id-2',
                            content:
                                'class HelloWorld\n' +
                                '{\n' +
                                '    static void Main()\n' +
                                '    {\n' +
                                '        Console.WriteLine("Hello World!");\n' +
                                '    }\n' +
                                '}\n',
                        },
                        {
                            itemId: 'cwspr-item-id-3',
                            content:
                                'class HelloWorld\n' +
                                '{\n' +
                                '    static void Main()\n' +
                                '    {\n' +
                                '        Console.WriteLine("Hello World!");\n' +
                                '    }\n' +
                                '}\n',
                        },
                    ],
                    suggestionsStates: new Map([
                        ['cwspr-item-id-1', 'Discard'],
                        ['cwspr-item-id-2', 'Discard'],
                        ['cwspr-item-id-3', 'Discard'],
                    ]),
                    triggerType: 'OnDemand',
                    autoTriggerType: undefined,
                    triggerCharacter: '',
                    classifierResult: undefined,
                    classifierThreshold: undefined,
                    requestContext: {
                        fileContext: {
                            filename: 'test.cs',
                            programmingLanguage: {
                                languageName: 'csharp',
                            },
                            leftFileContent: '',
                            rightFileContent:
                                'class HelloWorld\n' +
                                '{\n' +
                                '    static void Main()\n' +
                                '    {\n' +
                                '        Console.WriteLine("Hello World!");\n' +
                                '    }\n' +
                                '}\n',
                        },
                        maxResults: 5,
                    },
                })
                sinon.assert.calledWithMatch(telemetryServiceSpy, expectedUserTriggerDecisionMetric, 'Discard')
            })
        })

        describe('Case 2. Session returns recommendation to client and is closed by LogInlineCompletionSessionResults notification', () => {
            it('should emit User Decision event for active completion session when session results are received', async () => {
                setServiceResponse(DEFAULT_SUGGESTIONS, EXPECTED_RESPONSE_CONTEXT)

                await autoTriggerInlineCompletionWithReferences()

                const currentSession = sessionManager.getCurrentSession()
                assert(currentSession)
                assert.equal(currentSession?.state, 'ACTIVE')
                sinon.assert.notCalled(sessionManagerSpy.closeSession)
                sinon.assert.notCalled(telemetryServiceSpy)

                await features.doLogInlineCompletionSessionResults(DEFAULT_SESSION_RESULT_DATA)
                sinon.assert.called(telemetryServiceSpy)
            })

            it('should emit User Decision event with correct typeaheadLength value when session results are received', async () => {
                setServiceResponse(DEFAULT_SUGGESTIONS, EXPECTED_RESPONSE_CONTEXT)

                await autoTriggerInlineCompletionWithReferences()

                const currentSession = sessionManager.getCurrentSession()
                assert(currentSession)
                assert.equal(currentSession?.state, 'ACTIVE')
                sinon.assert.notCalled(sessionManagerSpy.closeSession)
                sinon.assert.notCalled(telemetryServiceSpy)

                await features.doLogInlineCompletionSessionResults({
                    ...DEFAULT_SESSION_RESULT_DATA,
                    typeaheadLength: 20,
                })
                sinon.assert.called(telemetryServiceSpy)
            })

            it('should not emit User Decision event after second trigger is received', async () => {
                setServiceResponse(DEFAULT_SUGGESTIONS, {
                    ...EXPECTED_RESPONSE_CONTEXT,
                    codewhispererSessionId: 'cwspr-session-id-1',
                })

                await autoTriggerInlineCompletionWithReferences()

                const firstSession = sessionManager.getCurrentSession()
                assert(firstSession)
                assert.equal(firstSession.state, 'ACTIVE')
                sinon.assert.notCalled(sessionManagerSpy.closeSession)
                sinon.assert.notCalled(telemetryServiceSpy)

                // Send second completion request should not close first one
                setServiceResponse(DEFAULT_SUGGESTIONS, {
                    ...EXPECTED_RESPONSE_CONTEXT,
                    codewhispererSessionId: 'cwspr-session-id-2',
                })
                await autoTriggerInlineCompletionWithReferences()

                assert.equal(firstSession.state, 'DISCARD')
                assert.notEqual(firstSession, sessionManager.getCurrentSession())
                sinon.assert.notCalled(sessionManagerSpy.closeSession)
                // Test that session reports it's status when second request is received
                const expectedEvent = aUserTriggerDecision({
                    state: 'DISCARD',
                    codewhispererSessionId: 'cwspr-session-id-1',
                    suggestions: [
                        { itemId: 'cwspr-item-id-1', content: 'recommendation', insertText: 'recommendation' },
                        { itemId: 'cwspr-item-id-2', content: 'recommendation', insertText: 'recommendation' },
                        { itemId: 'cwspr-item-id-3', content: 'recommendation', insertText: 'recommendation' },
                    ],
                    suggestionsAfterRightContextMerge: [
                        {
                            itemId: 'cwspr-item-id-1',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                        {
                            itemId: 'cwspr-item-id-2',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                        {
                            itemId: 'cwspr-item-id-3',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                    ],
                    suggestionsStates: new Map([
                        ['cwspr-item-id-1', 'Discard'],
                        ['cwspr-item-id-2', 'Discard'],
                        ['cwspr-item-id-3', 'Discard'],
                    ]),
                    responseContext: {
                        requestId: 'cwspr-request-id',
                        codewhispererSessionId: 'cwspr-session-id-1',
                    },
                })
                sinon.assert.calledWithMatch(telemetryServiceSpy, expectedEvent, 'Discard')

                telemetryServiceSpy.resetHistory()

                // Send session results for closed first session
                await features.doLogInlineCompletionSessionResults({
                    ...DEFAULT_SESSION_RESULT_DATA,
                    sessionId: firstSession.id,
                })
                sinon.assert.notCalled(telemetryServiceSpy)
            })

            it('should not emit User Decision event when session results received for session that does not exist', async () => {
                // Send session results for closed first session
                await features.doLogInlineCompletionSessionResults({
                    ...DEFAULT_SESSION_RESULT_DATA,
                    sessionId: 'cwspr-session-id-never-created',
                })
                sinon.assert.notCalled(telemetryServiceSpy)
            })

            it('should emit Accept User Decision event for current active completion session when session results are received with accepted suggestion', async () => {
                setServiceResponse(DEFAULT_SUGGESTIONS, EXPECTED_RESPONSE_CONTEXT)
                const SESSION_RESULT_DATA = {
                    sessionId: 'some-random-session-uuid-0',
                    completionSessionResult: {
                        'cwspr-item-id-1': {
                            seen: true,
                            accepted: false,
                            discarded: false,
                        },
                        'cwspr-item-id-2': {
                            seen: true,
                            accepted: true, // Second suggestion was accepted
                            discarded: false,
                        },
                        'cwspr-item-id-3': {
                            seen: true,
                            accepted: false,
                            discarded: false,
                        },
                    },
                }

                await autoTriggerInlineCompletionWithReferences()
                sinon.assert.notCalled(telemetryServiceSpy)

                // Send session results for closed first session
                await features.doLogInlineCompletionSessionResults(SESSION_RESULT_DATA)

                const expectedUserTriggerDecisionMetric = aUserTriggerDecision({
                    completionSessionResult: {
                        'cwspr-item-id-1': { seen: true, accepted: false, discarded: false },
                        'cwspr-item-id-2': { seen: true, accepted: true, discarded: false },
                        'cwspr-item-id-3': { seen: true, accepted: false, discarded: false },
                    },
                    suggestions: [
                        { itemId: 'cwspr-item-id-1', content: 'recommendation', insertText: 'recommendation' },
                        { itemId: 'cwspr-item-id-2', content: 'recommendation', insertText: 'recommendation' },
                        { itemId: 'cwspr-item-id-3', content: 'recommendation', insertText: 'recommendation' },
                    ],
                    suggestionsAfterRightContextMerge: [
                        {
                            itemId: 'cwspr-item-id-1',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                        {
                            itemId: 'cwspr-item-id-2',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                        {
                            itemId: 'cwspr-item-id-3',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                    ],
                    suggestionsStates: new Map([
                        ['cwspr-item-id-1', 'Ignore'],
                        ['cwspr-item-id-2', 'Accept'],
                        ['cwspr-item-id-3', 'Ignore'],
                    ]),
                    acceptedSuggestionId: 'cwspr-item-id-2',
                })
                sinon.assert.calledWithMatch(telemetryServiceSpy, expectedUserTriggerDecisionMetric, 'Accept')
            })

            it('should emit Reject User Decision event for current active completion session when session results are received without accepted suggestion', async () => {
                setServiceResponse(DEFAULT_SUGGESTIONS, EXPECTED_RESPONSE_CONTEXT)
                const SESSION_RESULT_DATA = {
                    sessionId: 'some-random-session-uuid-0',
                    completionSessionResult: {
                        'cwspr-item-id-1': {
                            seen: true, // Reject
                            accepted: false,
                            discarded: false,
                        },
                        'cwspr-item-id-2': {
                            seen: false, // Unseen
                            accepted: false,
                            discarded: true,
                        },
                        'cwspr-item-id-3': {
                            seen: false, // Discard
                            accepted: false,
                            discarded: true,
                        },
                    },
                }

                await autoTriggerInlineCompletionWithReferences()
                sinon.assert.notCalled(telemetryServiceSpy)

                // Send session results for closed first session
                await features.doLogInlineCompletionSessionResults(SESSION_RESULT_DATA)

                const expectedUserTriggerDecisionMetric = aUserTriggerDecision({
                    suggestions: [
                        { itemId: 'cwspr-item-id-1', content: 'recommendation', insertText: 'recommendation' },
                        { itemId: 'cwspr-item-id-2', content: 'recommendation', insertText: 'recommendation' },
                        { itemId: 'cwspr-item-id-3', content: 'recommendation', insertText: 'recommendation' },
                    ],
                    suggestionsAfterRightContextMerge: [
                        {
                            itemId: 'cwspr-item-id-1',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                        {
                            itemId: 'cwspr-item-id-2',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                        {
                            itemId: 'cwspr-item-id-3',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                    ],
                    suggestionsStates: new Map([
                        ['cwspr-item-id-1', 'Reject'],
                        ['cwspr-item-id-2', 'Discard'],
                        ['cwspr-item-id-3', 'Discard'],
                    ]),
                    completionSessionResult: {
                        'cwspr-item-id-1': { seen: true, accepted: false, discarded: false },
                        'cwspr-item-id-2': { seen: false, accepted: false, discarded: true },
                        'cwspr-item-id-3': { seen: false, accepted: false, discarded: true },
                    },
                })
                sinon.assert.calledWithMatch(telemetryServiceSpy, expectedUserTriggerDecisionMetric, 'Reject')
            })

            it('should send Discard User Decision when all suggestions have Discard state', async () => {
                setServiceResponse(DEFAULT_SUGGESTIONS, EXPECTED_RESPONSE_CONTEXT)
                const SESSION_RESULT_DATA = {
                    sessionId: 'some-random-session-uuid-0',
                    completionSessionResult: {
                        'cwspr-item-id-1': {
                            seen: false, // Discard
                            accepted: false,
                            discarded: true,
                        },
                        'cwspr-item-id-2': {
                            seen: false, // Discard
                            accepted: false,
                            discarded: true,
                        },
                        'cwspr-item-id-3': {
                            seen: false, // Discard
                            accepted: false,
                            discarded: true,
                        },
                    },
                }

                await autoTriggerInlineCompletionWithReferences()
                sinon.assert.notCalled(telemetryServiceSpy)

                // Send session results for closed first session
                await features.doLogInlineCompletionSessionResults(SESSION_RESULT_DATA)

                const expectedUserTriggerDecisionMetric = aUserTriggerDecision({
                    suggestions: [
                        { itemId: 'cwspr-item-id-1', content: 'recommendation', insertText: 'recommendation' },
                        { itemId: 'cwspr-item-id-2', content: 'recommendation', insertText: 'recommendation' },
                        { itemId: 'cwspr-item-id-3', content: 'recommendation', insertText: 'recommendation' },
                    ],
                    suggestionsAfterRightContextMerge: [
                        {
                            itemId: 'cwspr-item-id-1',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                        {
                            itemId: 'cwspr-item-id-2',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                        {
                            itemId: 'cwspr-item-id-3',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                    ],
                    suggestionsStates: new Map([
                        ['cwspr-item-id-1', 'Discard'],
                        ['cwspr-item-id-2', 'Discard'],
                        ['cwspr-item-id-3', 'Discard'],
                    ]),
                    completionSessionResult: {
                        'cwspr-item-id-1': { seen: false, accepted: false, discarded: true },
                        'cwspr-item-id-2': { seen: false, accepted: false, discarded: true },
                        'cwspr-item-id-3': { seen: false, accepted: false, discarded: true },
                    },
                })
                sinon.assert.calledWithMatch(telemetryServiceSpy, expectedUserTriggerDecisionMetric, 'Discard')
            })

            it('should set codewhispererTimeSinceLastDocumentChange as difference between 2 any document changes', async () => {
                const typeSomething = async () =>
                    await features.doChangeTextDocument({
                        textDocument: { uri: SOME_FILE.uri, version: 1 },
                        contentChanges: [
                            {
                                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                                text: 'f',
                            },
                        ],
                    })
                await autoTriggerInlineCompletionWithReferences()

                await typeSomething()

                clock.tick(1234)
                await typeSomething()

                clock.tick(5678)
                await typeSomething()

                await features.doLogInlineCompletionSessionResults(DEFAULT_SESSION_RESULT_DATA)

                const expectedUserTriggerDecisionMetric = aUserTriggerDecision({
                    completionSessionResult: {
                        'cwspr-item-id-1': { seen: true, accepted: false, discarded: false },
                        'cwspr-item-id-2': { seen: true, accepted: false, discarded: false },
                        'cwspr-item-id-3': { seen: true, accepted: false, discarded: false },
                    },
                    suggestions: [
                        { itemId: 'cwspr-item-id-1', content: 'recommendation', insertText: 'recommendation' },
                        { itemId: 'cwspr-item-id-2', content: 'recommendation', insertText: 'recommendation' },
                        { itemId: 'cwspr-item-id-3', content: 'recommendation', insertText: 'recommendation' },
                    ],
                    suggestionsAfterRightContextMerge: [
                        {
                            itemId: 'cwspr-item-id-1',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                        {
                            itemId: 'cwspr-item-id-2',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                        {
                            itemId: 'cwspr-item-id-3',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                    ],
                    suggestionsStates: new Map([
                        ['cwspr-item-id-1', 'Reject'],
                        ['cwspr-item-id-2', 'Reject'],
                        ['cwspr-item-id-3', 'Reject'],
                    ]),
                    closeTime: clock.now,
                })
                sinon.assert.calledWithMatch(telemetryServiceSpy, expectedUserTriggerDecisionMetric, 'Reject', 5678)
            })
        })

        describe('Case 3. Active session is closed by subsequent trigger', function () {
            it('should close ACTIVE session and emit Discard user trigger decision event on Manual trigger', async () => {
                setServiceResponse(DEFAULT_SUGGESTIONS, {
                    ...EXPECTED_RESPONSE_CONTEXT,
                    codewhispererSessionId: 'cwspr-session-id-1',
                })
                await autoTriggerInlineCompletionWithReferences()

                setServiceResponse(DEFAULT_SUGGESTIONS, {
                    ...EXPECTED_RESPONSE_CONTEXT,
                    codewhispererSessionId: 'cwspr-session-id-2',
                })
                await manualTriggerInlineCompletionWithReferences()

                const expectedUserTriggerDecisionMetric = aUserTriggerDecision({
                    state: 'DISCARD',
                    codewhispererSessionId: 'cwspr-session-id-1',
                    suggestions: [
                        { itemId: 'cwspr-item-id-1', content: 'recommendation', insertText: 'recommendation' },
                        { itemId: 'cwspr-item-id-2', content: 'recommendation', insertText: 'recommendation' },
                        { itemId: 'cwspr-item-id-3', content: 'recommendation', insertText: 'recommendation' },
                    ],
                    suggestionsAfterRightContextMerge: [
                        {
                            itemId: 'cwspr-item-id-1',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                        {
                            itemId: 'cwspr-item-id-2',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                        {
                            itemId: 'cwspr-item-id-3',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                    ],
                    suggestionsStates: new Map([
                        ['cwspr-item-id-1', 'Discard'],
                        ['cwspr-item-id-2', 'Discard'],
                        ['cwspr-item-id-3', 'Discard'],
                    ]),
                    responseContext: {
                        requestId: 'cwspr-request-id',
                        codewhispererSessionId: 'cwspr-session-id-1',
                    },
                })
                sinon.assert.calledWithMatch(telemetryServiceSpy, expectedUserTriggerDecisionMetric, 'Discard')
                sinon.assert.neverCalledWithMatch(
                    telemetryServiceSpy,
                    {
                        codewhispererSessionId: 'cwspr-session-id-2',
                    },
                    0
                )
            })

            it('should close ACTIVE session and emit Discard user trigger decision event on Auto trigger', async () => {
                setServiceResponse(DEFAULT_SUGGESTIONS, {
                    ...EXPECTED_RESPONSE_CONTEXT,
                    codewhispererSessionId: 'cwspr-session-id-1',
                })
                await autoTriggerInlineCompletionWithReferences()

                setServiceResponse(DEFAULT_SUGGESTIONS, {
                    ...EXPECTED_RESPONSE_CONTEXT,
                    codewhispererSessionId: 'cwspr-session-id-2',
                })
                await autoTriggerInlineCompletionWithReferences()

                const expectedUserTriggerDecisionMetric = aUserTriggerDecision({
                    state: 'DISCARD',
                    codewhispererSessionId: 'cwspr-session-id-1',
                    suggestions: [
                        { itemId: 'cwspr-item-id-1', content: 'recommendation', insertText: 'recommendation' },
                        { itemId: 'cwspr-item-id-2', content: 'recommendation', insertText: 'recommendation' },
                        { itemId: 'cwspr-item-id-3', content: 'recommendation', insertText: 'recommendation' },
                    ],
                    suggestionsAfterRightContextMerge: [
                        {
                            itemId: 'cwspr-item-id-1',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                        {
                            itemId: 'cwspr-item-id-2',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                        {
                            itemId: 'cwspr-item-id-3',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                    ],
                    suggestionsStates: new Map([
                        ['cwspr-item-id-1', 'Discard'],
                        ['cwspr-item-id-2', 'Discard'],
                        ['cwspr-item-id-3', 'Discard'],
                    ]),
                    responseContext: {
                        requestId: 'cwspr-request-id',
                        codewhispererSessionId: 'cwspr-session-id-1',
                    },
                })
                sinon.assert.calledWithMatch(telemetryServiceSpy, expectedUserTriggerDecisionMetric, 'Discard')
                sinon.assert.neverCalledWithMatch(
                    telemetryServiceSpy,
                    {
                        codewhispererSessionId: 'cwspr-session-id-2',
                    },
                    0
                )
            })

            it('should attach previous session trigger decision', async () => {
                setServiceResponse(DEFAULT_SUGGESTIONS, {
                    ...EXPECTED_RESPONSE_CONTEXT,
                    codewhispererSessionId: 'cwspr-session-id-1',
                })
                await autoTriggerInlineCompletionWithReferences()
                const firstSession = sessionManager.getCurrentSession()

                setServiceResponse(DEFAULT_SUGGESTIONS, {
                    ...EXPECTED_RESPONSE_CONTEXT,
                    codewhispererSessionId: 'cwspr-session-id-2',
                })
                await autoTriggerInlineCompletionWithReferences()

                setServiceResponse(DEFAULT_SUGGESTIONS, {
                    ...EXPECTED_RESPONSE_CONTEXT,
                    codewhispererSessionId: 'cwspr-session-id-3',
                })
                await autoTriggerInlineCompletionWithReferences()

                sinon.assert.calledTwice(telemetryServiceSpy)
                const firstCallArgs = telemetryServiceSpy.getCall(0).args[0]
                const secondCallArgs = telemetryServiceSpy.getCall(1).args[0]
                sinon.assert.match(firstCallArgs, {
                    id: 'some-random-session-uuid-0',
                    document: {
                        _uri: 'file:///test.cs',
                        _languageId: 'csharp',
                        _version: 1,
                        _content:
                            'class HelloWorld\n{\n    static void Main()\n    {\n        Console.WriteLine("Hello World!");\n    }\n}\n',
                        _lineOffsets: [0, 17, 19, 42, 48, 91, 97, 99],
                    },
                    startTime: 1483228800000,
                    closeTime: 1483228802000,
                    state: 'DISCARD',
                    codewhispererSessionId: 'cwspr-session-id-1',
                    startPosition: { line: 2, character: 21 },
                    suggestions: [
                        { itemId: 'cwspr-item-id-1', content: 'recommendation', insertText: 'recommendation' },
                        { itemId: 'cwspr-item-id-2', content: 'recommendation', insertText: 'recommendation' },
                        { itemId: 'cwspr-item-id-3', content: 'recommendation', insertText: 'recommendation' },
                    ],
                    suggestionsStates: {},
                    responseContext: { requestId: 'cwspr-request-id', codewhispererSessionId: 'cwspr-session-id-1' },
                    triggerType: 'AutoTrigger',
                    autoTriggerType: 'SpecialCharacters',
                    triggerCharacter: '(',
                    classifierResult: classifierResult,
                    classifierThreshold: 0.43,
                    language: 'csharp',
                    requestContext: {
                        fileContext: {
                            filename: 'test.cs',
                            programmingLanguage: { languageName: 'csharp' },
                            leftFileContent: 'class HelloWorld\n{\n    static void Main(',
                            rightFileContent: ')\n    {\n        Console.WriteLine("Hello World!");\n    }\n}\n',
                            workspaceFolder: undefined,
                        },
                        maxResults: 1,
                    },
                    timeToFirstRecommendation: 2000,
                    credentialStartUrl: 'teststarturl',
                    reportedUserDecision: true,
                })
                sinon.assert.match(
                    secondCallArgs,
                    aUserTriggerDecision({
                        previousTriggerDecision: 'Discard',
                        previousTriggerDecisionTime: 1483228802000,
                        responseContext: {
                            requestId: 'cwspr-request-id',
                            codewhispererSessionId: 'cwspr-session-id-2',
                        },
                        id: 'some-random-session-uuid-1',
                        startTime: 1483228802000,
                        closeTime: 1483228804000,
                        state: 'DISCARD',
                        codewhispererSessionId: 'cwspr-session-id-2',
                        suggestions: [
                            { itemId: 'cwspr-item-id-1', content: 'recommendation', insertText: 'recommendation' },
                            { itemId: 'cwspr-item-id-2', content: 'recommendation', insertText: 'recommendation' },
                            { itemId: 'cwspr-item-id-3', content: 'recommendation', insertText: 'recommendation' },
                        ],
                        suggestionsAfterRightContextMerge: [
                            {
                                itemId: 'cwspr-item-id-1',
                                insertText: 'recommendation',
                                range: undefined,
                                references: undefined,
                                mostRelevantMissingImports: undefined,
                            },
                            {
                                itemId: 'cwspr-item-id-2',
                                insertText: 'recommendation',
                                range: undefined,
                                references: undefined,
                                mostRelevantMissingImports: undefined,
                            },
                            {
                                itemId: 'cwspr-item-id-3',
                                insertText: 'recommendation',
                                range: undefined,
                                references: undefined,
                                mostRelevantMissingImports: undefined,
                            },
                        ],
                        suggestionsStates: new Map([
                            ['cwspr-item-id-1', 'Discard'],
                            ['cwspr-item-id-2', 'Discard'],
                            ['cwspr-item-id-3', 'Discard'],
                        ]),
                    })
                )
                sinon.assert.neverCalledWithMatch(
                    telemetryServiceSpy,
                    aUserTriggerDecision({
                        codewhispererSessionId: 'cwspr-session-id-3',
                    }),
                    0
                )
            })

            it('should set correct values for past trigger result fields', async () => {
                setServiceResponse(DEFAULT_SUGGESTIONS, {
                    ...EXPECTED_RESPONSE_CONTEXT,
                    codewhispererSessionId: 'cwspr-session-id-1',
                })
                await autoTriggerInlineCompletionWithReferences()
                const firstSession = sessionManager.getCurrentSession()

                await features.doLogInlineCompletionSessionResults(DEFAULT_SESSION_RESULT_DATA)

                clock.tick(1234)

                setServiceResponse(DEFAULT_SUGGESTIONS, {
                    ...EXPECTED_RESPONSE_CONTEXT,
                    codewhispererSessionId: 'cwspr-session-id-2',
                })
                await autoTriggerInlineCompletionWithReferences()

                // Trigger 3rd session to close second one
                await autoTriggerInlineCompletionWithReferences()

                // For first session previous data does not exist
                sinon.assert.calledTwice(telemetryServiceSpy)
                const firstCallArgs = telemetryServiceSpy.getCall(0).args[0]
                const secondCallArgs = telemetryServiceSpy.getCall(1).args[0]
                sinon.assert.match(
                    firstCallArgs,
                    aUserTriggerDecision({
                        previousTriggerDecision: undefined,
                        previousTriggerDecisionTime: undefined,
                        responseContext: {
                            requestId: 'cwspr-request-id',
                            codewhispererSessionId: 'cwspr-session-id-1',
                        },
                        id: 'some-random-session-uuid-0',
                        startTime: 1483228800000,
                        closeTime: 1483228802000,
                        state: 'CLOSED',
                        codewhispererSessionId: 'cwspr-session-id-1',
                        suggestions: [
                            { itemId: 'cwspr-item-id-1', content: 'recommendation', insertText: 'recommendation' },
                            { itemId: 'cwspr-item-id-2', content: 'recommendation', insertText: 'recommendation' },
                            { itemId: 'cwspr-item-id-3', content: 'recommendation', insertText: 'recommendation' },
                        ],
                        suggestionsAfterRightContextMerge: [
                            {
                                itemId: 'cwspr-item-id-1',
                                insertText: 'recommendation',
                                range: undefined,
                                references: undefined,
                                mostRelevantMissingImports: undefined,
                            },
                            {
                                itemId: 'cwspr-item-id-2',
                                insertText: 'recommendation',
                                range: undefined,
                                references: undefined,
                                mostRelevantMissingImports: undefined,
                            },
                            {
                                itemId: 'cwspr-item-id-3',
                                insertText: 'recommendation',
                                range: undefined,
                                references: undefined,
                                mostRelevantMissingImports: undefined,
                            },
                        ],
                        suggestionsStates: new Map([
                            ['cwspr-item-id-1', 'Reject'],
                            ['cwspr-item-id-2', 'Reject'],
                            ['cwspr-item-id-3', 'Reject'],
                        ]),
                        completionSessionResult: {
                            'cwspr-item-id-1': { seen: true, accepted: false, discarded: false },
                            'cwspr-item-id-2': { seen: true, accepted: false, discarded: false },
                            'cwspr-item-id-3': { seen: true, accepted: false, discarded: false },
                        },
                    })
                )
                sinon.assert.match(secondCallArgs, {
                    id: 'some-random-session-uuid-1',
                    document: {
                        _uri: 'file:///test.cs',
                        _languageId: 'csharp',
                        _version: 1,
                        _content:
                            'class HelloWorld\n{\n    static void Main()\n    {\n        Console.WriteLine("Hello World!");\n    }\n}\n',
                        _lineOffsets: [0, 17, 19, 42, 48, 91, 97, 99],
                    },
                    startTime: 1483228803234,
                    closeTime: 1483228805234,
                    state: 'DISCARD',
                    codewhispererSessionId: 'cwspr-session-id-2',
                    startPosition: {
                        line: 2,
                        character: 21,
                    },
                    suggestions: [
                        {
                            itemId: 'cwspr-item-id-1',
                            content: 'recommendation',
                            insertText: 'recommendation',
                        },
                        {
                            itemId: 'cwspr-item-id-2',
                            content: 'recommendation',
                            insertText: 'recommendation',
                        },
                        {
                            itemId: 'cwspr-item-id-3',
                            content: 'recommendation',
                            insertText: 'recommendation',
                        },
                    ],
                    suggestionsStates: {},
                    responseContext: {
                        requestId: 'cwspr-request-id',
                        codewhispererSessionId: 'cwspr-session-id-2',
                    },
                    triggerType: 'AutoTrigger',
                    autoTriggerType: 'SpecialCharacters',
                    triggerCharacter: '(',
                    classifierResult: getNormalizeOsName() === 'Linux' ? 0.5748673583477094 : 0.5611518554232429,
                    classifierThreshold: 0.43,
                    language: 'csharp',
                    requestContext: {
                        fileContext: {
                            filename: 'test.cs',
                            programmingLanguage: {
                                languageName: 'csharp',
                            },
                            leftFileContent: 'class HelloWorld\n{\n    static void Main(',
                            rightFileContent: ')\n    {\n        Console.WriteLine("Hello World!");\n    }\n}\n',
                            workspaceFolder: undefined,
                        },
                        maxResults: 1,
                    },
                    timeToFirstRecommendation: 2000,
                    credentialStartUrl: 'teststarturl',
                    previousTriggerDecision: 'Reject',
                    previousTriggerDecisionTime: 1483228802000,
                    reportedUserDecision: true,
                })
            })
        })

        // we are blocking subsequent completion request as long as inflight is running
        describe('Case 4. Inflight session is closed by subsequent completion request', function () {
            it.skip('should emit Discard user trigger decision event when REQUESTING session is closed before becoming ACTIVE', async () => {
                // Chain requests in a callbacks
                let concurrentCount = 0
                let requests: Promise<InlineCompletionListWithReferences>[] = []

                service.generateSuggestions.callsFake(_request => {
                    clock.tick(1000)
                    let i = concurrentCount

                    if (concurrentCount < 2) {
                        // Trigger second request before first one was resolved
                        concurrentCount++
                        const req =
                            autoTriggerInlineCompletionWithReferences() as Promise<InlineCompletionListWithReferences>
                        requests.push(req)
                        clock.tick(10)
                    }

                    clock.tick(250)

                    return Promise.resolve({
                        suggestions: DEFAULT_SUGGESTIONS,
                        responseContext: {
                            ...EXPECTED_RESPONSE_CONTEXT,
                            codewhispererSessionId: `cwspr-session-id-${i}`,
                        },
                        suggestionType: SuggestionType.COMPLETION,
                    })
                })

                const result = [await autoTriggerInlineCompletionWithReferences(), ...(await Promise.all(requests))]

                assert.deepEqual(result, [
                    EMPTY_RESULT,
                    EMPTY_RESULT,
                    { ...EXPECTED_RESULT, sessionId: 'some-random-session-uuid-2' },
                ])

                // 3 sessions were created, each one closes previous one in REQUESTING state
                assert.equal(SESSION_IDS_LOG.length, 3)
                sinon.assert.calledTwice(telemetryServiceSpy)
                const firstCallArgs = telemetryServiceSpy.getCall(0).args[0]
                const secondCallArgs = telemetryServiceSpy.getCall(1).args[0]
                sinon.assert.match(
                    firstCallArgs,
                    aUserTriggerDecision({
                        codewhispererSessionId: 'cwspr-session-id-0',
                        state: 'DISCARD',
                        suggestions: [
                            { itemId: 'cwspr-item-id-1', content: 'recommendation', insertText: 'recommendation' },
                            { itemId: 'cwspr-item-id-2', content: 'recommendation', insertText: 'recommendation' },
                            { itemId: 'cwspr-item-id-3', content: 'recommendation', insertText: 'recommendation' },
                        ],
                        suggestionsStates: new Map([
                            ['cwspr-item-id-1', 'Discard'],
                            ['cwspr-item-id-2', 'Discard'],
                            ['cwspr-item-id-3', 'Discard'],
                        ]),
                        responseContext: {
                            requestId: 'cwspr-request-id',
                            codewhispererSessionId: 'cwspr-session-id-0',
                        },
                        timeToFirstRecommendation: 1260,
                        closeTime: 1483228801260,
                    })
                )
                sinon.assert.match(secondCallArgs, {
                    id: 'some-random-session-uuid-1',
                    document: {
                        _uri: 'file:///test.cs',
                        _languageId: 'csharp',
                        _version: 1,
                        _content:
                            'class HelloWorld\n{\n    static void Main()\n    {\n        Console.WriteLine("Hello World!");\n    }\n}\n',
                        _lineOffsets: [0, 17, 19, 42, 48, 91, 97, 99],
                    },
                    startTime: 1483228801260,
                    closeTime: 1483228802520,
                    state: 'DISCARD',
                    codewhispererSessionId: 'cwspr-session-id-1',
                    startPosition: { line: 2, character: 21 },
                    suggestions: [
                        { itemId: 'cwspr-item-id-1', content: 'recommendation', insertText: 'recommendation' },
                        { itemId: 'cwspr-item-id-2', content: 'recommendation', insertText: 'recommendation' },
                        { itemId: 'cwspr-item-id-3', content: 'recommendation', insertText: 'recommendation' },
                    ],
                    suggestionsStates: {},
                    responseContext: { requestId: 'cwspr-request-id', codewhispererSessionId: 'cwspr-session-id-1' },
                    triggerType: 'AutoTrigger',
                    autoTriggerType: 'SpecialCharacters',
                    triggerCharacter: '(',
                    classifierResult: classifierResult,
                    classifierThreshold: 0.43,
                    language: 'csharp',
                    requestContext: {
                        fileContext: {
                            filename: 'test.cs',
                            programmingLanguage: { languageName: 'csharp' },
                            leftFileContent: 'class HelloWorld\n{\n    static void Main(',
                            rightFileContent: ')\n    {\n        Console.WriteLine("Hello World!");\n    }\n}\n',
                            workspaceFolder: undefined,
                        },
                        maxResults: 1,
                    },
                    timeToFirstRecommendation: 1260,
                    credentialStartUrl: 'teststarturl',
                    previousTriggerDecision: 'Discard',
                    previousTriggerDecisionTime: 1483228801260,
                    reportedUserDecision: true,
                })
                sinon.assert.neverCalledWithMatch(telemetryServiceSpy, {
                    codewhispererSessionId: 'cwspr-session-id-2',
                })
                telemetryServiceSpy.resetHistory()
                const activeSession = sessionManager.getActiveSession()
                assert.equal(activeSession?.id, SESSION_IDS_LOG[2])

                await features.doLogInlineCompletionSessionResults({
                    ...DEFAULT_SESSION_RESULT_DATA,
                    sessionId: SESSION_IDS_LOG[2],
                })
                sinon.assert.calledWithMatch(
                    telemetryServiceSpy,
                    aUserTriggerDecision({
                        id: 'some-random-session-uuid-2',
                        startTime: 1483228802520,
                        closeTime: 1483228803770,
                        codewhispererSessionId: 'cwspr-session-id-2',
                        suggestionsAfterRightContextMerge: [
                            {
                                itemId: 'cwspr-item-id-1',
                                insertText: 'recommendation',
                                range: undefined,
                                references: undefined,
                                mostRelevantMissingImports: undefined,
                            },
                            {
                                itemId: 'cwspr-item-id-2',
                                insertText: 'recommendation',
                                range: undefined,
                                references: undefined,
                                mostRelevantMissingImports: undefined,
                            },
                            {
                                itemId: 'cwspr-item-id-3',
                                insertText: 'recommendation',
                                range: undefined,
                                references: undefined,
                                mostRelevantMissingImports: undefined,
                            },
                        ],
                        suggestions: [
                            { itemId: 'cwspr-item-id-1', content: 'recommendation', insertText: 'recommendation' },
                            { itemId: 'cwspr-item-id-2', content: 'recommendation', insertText: 'recommendation' },
                            { itemId: 'cwspr-item-id-3', content: 'recommendation', insertText: 'recommendation' },
                        ],
                        suggestionsStates: new Map([
                            ['cwspr-item-id-1', 'Reject'],
                            ['cwspr-item-id-2', 'Reject'],
                            ['cwspr-item-id-3', 'Reject'],
                        ]),
                        previousTriggerDecision: 'Discard',
                        previousTriggerDecisionTime: 1483228802520,
                        timeToFirstRecommendation: 1250,
                        completionSessionResult: {
                            'cwspr-item-id-1': { seen: true, accepted: false, discarded: false },
                            'cwspr-item-id-2': { seen: true, accepted: false, discarded: false },
                            'cwspr-item-id-3': { seen: true, accepted: false, discarded: false },
                        },
                        responseContext: {
                            requestId: 'cwspr-request-id',
                            codewhispererSessionId: 'cwspr-session-id-2',
                        },
                    }),
                    'Discard'
                )
            })
        })

        it('should report user trigger decision only once for a session', async () => {
            setServiceResponse(DEFAULT_SUGGESTIONS, {
                ...EXPECTED_RESPONSE_CONTEXT,
                codewhispererSessionId: 'cwspr-session-id-1',
            })
            await autoTriggerInlineCompletionWithReferences()
            const firstSession = sessionManager.getCurrentSession()

            sinon.assert.neverCalledWithMatch(telemetryServiceSpy)

            // Record session results and close the session
            await features.doLogInlineCompletionSessionResults(DEFAULT_SESSION_RESULT_DATA)
            sinon.assert.calledWithMatch(
                telemetryServiceSpy,
                aUserTriggerDecision({
                    codewhispererSessionId: 'cwspr-session-id-1',
                    suggestions: [
                        { itemId: 'cwspr-item-id-1', content: 'recommendation', insertText: 'recommendation' },
                        { itemId: 'cwspr-item-id-2', content: 'recommendation', insertText: 'recommendation' },
                        { itemId: 'cwspr-item-id-3', content: 'recommendation', insertText: 'recommendation' },
                    ],
                    suggestionsAfterRightContextMerge: [
                        {
                            itemId: 'cwspr-item-id-1',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                        {
                            itemId: 'cwspr-item-id-2',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                        {
                            itemId: 'cwspr-item-id-3',
                            insertText: 'recommendation',
                            range: undefined,
                            references: undefined,
                            mostRelevantMissingImports: undefined,
                        },
                    ],
                    suggestionsStates: new Map([
                        ['cwspr-item-id-1', 'Reject'],
                        ['cwspr-item-id-2', 'Reject'],
                        ['cwspr-item-id-3', 'Reject'],
                    ]),
                    responseContext: {
                        requestId: 'cwspr-request-id',
                        codewhispererSessionId: 'cwspr-session-id-1',
                    },
                    completionSessionResult: {
                        'cwspr-item-id-1': { seen: true, accepted: false, discarded: false },
                        'cwspr-item-id-2': { seen: true, accepted: false, discarded: false },
                        'cwspr-item-id-3': { seen: true, accepted: false, discarded: false },
                    },
                }),
                'Reject',
                0,
                0,
                0,
                undefined,
                undefined,
                0
            )
            assert.equal(firstSession?.state, 'CLOSED')

            telemetryServiceSpy.resetHistory()

            // Triggering new completion request creates new session
            // and should not emit telemetry for previous session, which was closed earlier
            setServiceResponse(DEFAULT_SUGGESTIONS, {
                ...EXPECTED_RESPONSE_CONTEXT,
                codewhispererSessionId: 'cwspr-session-id-2',
            })
            await autoTriggerInlineCompletionWithReferences()

            // Or attempt to record data
            await features.doLogInlineCompletionSessionResults(DEFAULT_SESSION_RESULT_DATA)
            sinon.assert.neverCalledWithMatch(
                telemetryServiceSpy,
                {
                    codewhispererSessionId: 'cwspr-session-id-1',
                },
                0
            )
        })
    })
})
