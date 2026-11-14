import { TextDocument } from 'vscode-languageserver-textdocument'
import { CodeWhispererServiceBase, ResponseContext, Suggestion } from './codeWhispererService'
import { TestFeatures } from '@aws/language-server-runtimes/testing'
import { stubInterface } from 'ts-sinon'
import { SessionData } from '../language-server/inline-completion/session/sessionManager'
import { WorkspaceFolder } from '@aws/language-server-runtimes/protocol'
import { SsoConnectionType } from '@aws/language-server-runtimes/server-interface'

export const HELLO_WORLD_IN_CSHARP = `class HelloWorld
{
    static void Main()
    {
        Console.WriteLine("Hello World!");
    }
}`

export const SPECIAL_CHARACTER_HELLO_WORLD = `{class HelloWorld`

export const HELLO_WORLD_WITH_WINDOWS_ENDING = HELLO_WORLD_IN_CSHARP.replaceAll('\n', '\r\n')

export const SOME_FILE = TextDocument.create('file:///test.cs', 'csharp', 1, HELLO_WORLD_IN_CSHARP)
export const SOME_FILE_WITH_ALT_CASED_LANGUAGE_ID = TextDocument.create(
    // Use unsupported extension, so that we can test that we get a match based on the LanguageId
    'file:///test.seesharp',
    'CSharp',
    1,
    HELLO_WORLD_IN_CSHARP
)
export const SOME_CLOSED_FILE = TextDocument.create('file:///closed.cs', 'csharp', 1, HELLO_WORLD_IN_CSHARP)
export const SOME_UNSUPPORTED_FILE = TextDocument.create(
    'file:///hopper.fm',
    'flow-matic',
    1,
    'INPUT HELLO ; OUTPUT WORLD'
)
export const SOME_FILE_WITH_EXTENSION = TextDocument.create('file:///missing.hpp', '', 1, HELLO_WORLD_IN_CSHARP)
export const SOME_WORKSPACE_FOLDER: WorkspaceFolder = {
    uri: 'file:///tmp/workspaceFolderTest',
    name: 'workspaceFolderTest',
}
export const SOME_FILE_UNDER_WORKSPACE_FOLDER = TextDocument.create(
    `${SOME_WORKSPACE_FOLDER.uri}/relativePath/test.cs`,
    'csharp',
    1,
    HELLO_WORLD_IN_CSHARP
)

export const SAMPLE_FILE_OF_60_LINES_IN_JAVA = `import java.util.List;
// we need this comment on purpose because chunk will be trimed right, adding this to avoid trimRight and make assertion easier
/**
 * 
 * 
 * 
 * 
 * 
 **/
class Main {
    public static void main(String[] args) {
        Calculator calculator = new Calculator();
        calculator.add(1, 2);
        calculator.subtract(1, 2);
        calculator.multiply(1, 2);
        calculator.divide(1, 2);
        calculator.remainder(1, 2);
    }
}
//
class Calculator {
    public Calculator() {
        System.out.println("constructor");
    }
//
    public add(int num1, int num2) {
        System.out.println("add");
        return num1 + num2;
    }
//
    public subtract(int num1, int num2) {
        System.out.println("subtract");
        return num1 - num2;
    }
//
    public multiply(int num1, int num2) {
        System.out.println("multiply");
        return num1 * num2;    
    }
//
    public divide(int num1, int num2) {
        System.out.println("divide");
        return num1 / num2;
    }
//
    public remainder(int num1, int num2) {
        System.out.println("remainder");
        return num1 % num2;
    }
//
    public power(int num1, int num2) {
        System.out.println("power");
        return (int) Math.pow(num1, num2);
    }
//
    public squareRoot(int num1) {
        System.out.println("squareRoot");
        return (int) Math.sqrt(num1);
    }
}`

export const HELLO_WORLD_LINE = `Console.WriteLine("Hello World!");`
// Single line file will not have the full line contents
export const SINGLE_LINE_FILE_CUTOFF_INDEX = 2
export const SOME_SINGLE_LINE_FILE = TextDocument.create(
    'file:///single.cs',
    'csharp',
    1,
    HELLO_WORLD_LINE.substring(SINGLE_LINE_FILE_CUTOFF_INDEX)
)

export const EXPECTED_SUGGESTION: Suggestion[] = [{ itemId: 'cwspr-item-id', content: 'recommendation' }]

export const EXPECTED_RESPONSE_CONTEXT: ResponseContext = {
    requestId: 'cwspr-request-id',
    codewhispererSessionId: 'cwspr-session-id',
}
export const EXPECTED_SESSION_ID = 'some-random-session-uuid-0'

export const EXPECTED_RESULT = {
    sessionId: EXPECTED_SESSION_ID,
    items: [
        {
            itemId: EXPECTED_SUGGESTION[0].itemId,
            insertText: EXPECTED_SUGGESTION[0].content,
            range: undefined,
            references: undefined,
            mostRelevantMissingImports: undefined,
        },
    ],
    partialResultToken: undefined,
}

export const EXPECTED_RESULT_EDITS = {
    sessionId: EXPECTED_SESSION_ID,
    items: [
        {
            itemId: EXPECTED_SUGGESTION[0].itemId,
            insertText: EXPECTED_SUGGESTION[0].content,
            isInlineEdit: true,
        },
    ],
    partialResultToken: undefined,
}

export const EXPECTED_NEXT_TOKEN = 'randomNextToken'

export const EXPECTED_REFERENCE = {
    licenseName: 'test license',
    repository: 'test repository',
    url: 'test url',
    recommendationContentSpan: { start: 0, end: 1 },
}

export const EXPECTED_SUGGESTION_LIST: Suggestion[] = [
    {
        itemId: 'cwspr-item-id-1',
        content: 'recommendation without reference',
    },
    { itemId: 'cwspr-item-id-2', content: 'recommendation with reference', references: [EXPECTED_REFERENCE] },
]

export const EXPECTED_SUGGESTION_LIST_WITH_IMPORTS: Suggestion[] = [
    {
        itemId: 'cwspr-item-id-1',
        content: 'recommendation with import',
        mostRelevantMissingImports: [{ statement: 'import_foo' }],
    },
]

export const EXPECTED_RESULT_WITH_IMPORTS = {
    sessionId: EXPECTED_SESSION_ID,
    items: [
        {
            itemId: EXPECTED_SUGGESTION_LIST_WITH_IMPORTS[0].itemId,
            insertText: EXPECTED_SUGGESTION_LIST_WITH_IMPORTS[0].content,
            range: undefined,
            references: undefined,
            mostRelevantMissingImports: [{ statement: 'import_foo' }],
        },
    ],
    partialResultToken: undefined,
}

export const EXPECTED_RESULT_WITHOUT_IMPORTS = {
    ...EXPECTED_RESULT_WITH_IMPORTS,
    items: [{ ...EXPECTED_RESULT_WITH_IMPORTS.items[0], mostRelevantMissingImports: undefined }],
}

export const EXPECTED_RESULT_WITH_REFERENCES = {
    sessionId: EXPECTED_SESSION_ID,
    items: [
        {
            itemId: EXPECTED_SUGGESTION_LIST[0].itemId,
            insertText: EXPECTED_SUGGESTION_LIST[0].content,
            range: undefined,
            references: undefined,
            mostRelevantMissingImports: undefined,
        },
        {
            itemId: EXPECTED_SUGGESTION_LIST[1].itemId,
            insertText: EXPECTED_SUGGESTION_LIST[1].content,
            range: undefined,
            references: [
                {
                    licenseName: EXPECTED_REFERENCE.licenseName,
                    referenceName: EXPECTED_REFERENCE.repository,
                    referenceUrl: EXPECTED_REFERENCE.url,
                    position: {
                        startCharacter: EXPECTED_REFERENCE.recommendationContentSpan?.start,
                        endCharacter: EXPECTED_REFERENCE.recommendationContentSpan?.end,
                    },
                },
            ],
            mostRelevantMissingImports: undefined,
        },
    ],
    partialResultToken: undefined,
}

export const EXPECTED_RESULT_WITHOUT_REFERENCES = {
    sessionId: EXPECTED_SESSION_ID,
    items: [
        {
            itemId: EXPECTED_SUGGESTION_LIST[0].itemId,
            insertText: EXPECTED_SUGGESTION_LIST[0].content,
            range: undefined,
            references: undefined,
            mostRelevantMissingImports: undefined,
        },
    ],
    partialResultToken: undefined,
}

export const EMPTY_RESULT = { items: [], sessionId: '' }

export const SAMPLE_SESSION_DATA: SessionData = {
    document: SOME_FILE,
    startPreprocessTimestamp: 0,
    startPosition: {
        line: 0,
        character: 0,
    },
    triggerType: 'OnDemand',
    language: 'csharp',
    requestContext: {
        fileContext: {
            filename: SOME_FILE.uri,
            programmingLanguage: { languageName: 'csharp' },
            leftFileContent: '',
            rightFileContent: HELLO_WORLD_IN_CSHARP,
        },
        maxResults: 5,
    },
}

export const createIterableResponse = <T>(data: T[]): AsyncIterable<T> => {
    let index = 0

    return {
        [Symbol.asyncIterator]() {
            return {
                next() {
                    return Promise.resolve({
                        done: index >= data.length,
                        value: data[index++],
                    })
                },
            }
        },
    }
}

/**
 * Shuffle a list, Fisher-Yates Sorting Algorithm.
 * Copy of implementation from AWS Toolkit for VSCode https://github.com/aws/aws-toolkit-vscode/blob/a2daf60dca5e5699b8b25f6dc84708295f042c38/packages/core/src/test/testUtil.ts#L482
 */
export function shuffleList<T>(list: T[]): T[] {
    const shuffledList = [...list]

    for (let i = shuffledList.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[shuffledList[i], shuffledList[j]] = [shuffledList[j], shuffledList[i]]
    }

    return shuffledList
}

export const setCredentialsForAmazonQTokenServiceManagerFactory = (getFeatures: () => TestFeatures) => {
    return (connectionType: SsoConnectionType) => {
        const features = getFeatures()
        features.credentialsProvider = stubInterface()
        features.credentialsProvider.hasCredentials.returns(true)
        features.credentialsProvider.getConnectionType.returns(connectionType)
        features.credentialsProvider.getCredentials.returns({
            token: 'test-token',
        })
    }
}

export const stubCodeWhispererService = <C extends CodeWhispererServiceBase>() => {
    const service = stubInterface<C>()

    // by default, sinon will add method stubs instead of settings these to undefined, which can lead to unintended test errors.
    service.customizationArn = undefined
    service.profileArn = undefined

    return service
}

/**
 * Runs `action` and waits for the promise that it returns, if any. Then lets pending promise callbacks run, and
 * returns the rejections that had no handler. A rejection of the promise that `action` returns is thrown, not
 * returned. Mocha re-emits an unhandled rejection from test code instead of failing on it, so a listener added
 * here receives it, possibly more than once.
 *
 * Background work from other tests can also reject in this window. Check the result for the test's own rejection
 * reason, not for an empty list.
 */
export async function unhandledRejectionsDuring(action: () => unknown): Promise<unknown[]> {
    const rejections: unknown[] = []
    const listener = (reason: unknown) => rejections.push(reason)
    process.on('unhandledRejection', listener)
    try {
        await action()
        await new Promise(resolve => setImmediate(resolve))
    } finally {
        process.removeListener('unhandledRejection', listener)
    }
    return rejections
}
