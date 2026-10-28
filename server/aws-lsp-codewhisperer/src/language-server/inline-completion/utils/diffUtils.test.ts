import * as assert from 'assert'
import {
    categorizeUnifieddiff,
    extractAdditions,
    getAddedAndDeletedLines,
    getCharacterDifferences,
    generateDiffContexts,
    MAX_LCS_CELLS,
} from './diffUtils'

describe('extractAdditions', function () {
    interface Case {
        udiff: string
        expected: string
    }

    const cases: Case[] = [
        {
            udiff: `--- file:///Volumes/workplace/ide/sample_projects/Calculator/src/main/hello/MathUtil.java
+++ file:///Volumes/workplace/ide/sample_projects/Calculator/src/main/hello/MathUtil.java
@@ -1,9 +1,10 @@
 public class MathUtil {
     // write a function to add 2 numbers
     public static int add(int a, int b) {
 
+        return a + b;
     }
 
     // write a function to subtract 2 numbers
     public static int subtract(int a, int b) {
         return a - b;`,
            expected: '        return a + b;',
        },
        {
            udiff: `--- file:///Volumes/workplace/ide/sample_projects/Calculator/src/main/hello/MathUtil.java
+++ file:///Volumes/workplace/ide/sample_projects/Calculator/src/main/hello/MathUtil.java
@@ -1,9 +1,17 @@
 public class MathUtil {
     // write a function to add 2 numbers
     public static int add(int a, int b) { 

+        if (a > Integer.MAX_VALUE - b){
+            throw new IllegalArgumentException("Overflow!");
+        }
+        else if (a < Integer.MIN_VALUE - b){
+            throw new IllegalArgumentException("Underflow");
+        }
+        else{
+            return a + b;
+        }
     }
 
     // write a function to subtract 2 numbers
     public static int subtract(int a, int b) {
         return a - b;`,
            expected: `        if (a > Integer.MAX_VALUE - b){
            throw new IllegalArgumentException("Overflow!");
        }
        else if (a < Integer.MIN_VALUE - b){
            throw new IllegalArgumentException("Underflow");
        }
        else{
            return a + b;
        }`,
        },
        {
            udiff: `--- file:///Volumes/workplace/ide/sample_projects/Calculator-2/src/main/hello/MathUtil.java
+++ file:///Volumes/workplace/ide/sample_projects/Calculator-2/src/main/hello/MathUtil.java
@@ -6,7 +6,11 @@
 
     // write a function to subtract 2 numbers
      public static int subtract(int a, int b) {
         return a - b;
     }
-    
+
+    // write a function to multiply 2 numbers
+    public static int multiply(int a, int b) {
+        return a * b;
+    }
 }`,
            expected: `
    // write a function to multiply 2 numbers
    public static int multiply(int a, int b) {
        return a * b;
    }`,
        },
        {
            udiff: `--- file:///Volumes/workplace/ide/sample_projects/Calculator-2/src/main/hello/MathUtil.java
+++ file:///Volumes/workplace/ide/sample_projects/Calculator-2/src/main/hello/MathUtil.java
@@ -3,7 +3,9 @@
     public static int add(int a, int b) {
         return a + b;
     }
 
     // write a function to subtract 2 numbers
-    
+    public static int subtract(int a, int b) {
+        return a - b;
+    }
 }`,
            expected: `    public static int subtract(int a, int b) {
        return a - b;
    }`,
        },
    ]

    for (let i = 0; i < cases.length; i++) {
        it(`case ${i}`, function () {
            const c = cases[i]
            const udiff = c.udiff
            const expected = c.expected

            const actual = extractAdditions(udiff)
            assert.strictEqual(actual, expected)
        })
    }
})

describe('categorizeUnifieddiffV2v2 should return correct type (addOnly, edit, deleteOnly)', function () {
    interface Case {
        udiff: string
    }

    describe('addOnly', function () {
        const addOnlyCases: Case[] = [
            {
                udiff: `--- a/src/main/hello/MathUtil.java
+++ b/src/main/hello/MathUtil.java
@@ -10,6 +10,6 @@ public class MathUtil {
     }   
 
     public static int multiply(int a, int b) {
-        return a * b;
+        return a * b * c;
     }
 }`,
            },
            {
                udiff: `--- file:///Volumes/workplace/ide/sample_projects/Calculator-2/src/main/hello/MathUtil.java
+++ file:///Volumes/workplace/ide/sample_projects/Calculator-2/src/main/hello/MathUtil.java
@@ -6,2 +6,3 @@
-        return a * b;
+        return a * b *
+               c * d;
 }`,
            },
            {
                udiff: `--- file:///Volumes/workplace/ide/sample_projects/Calculator-2/src/main/hello/MathUtil.java
+++ file:///Volumes/workplace/ide/sample_projects/Calculator-2/src/main/hello/MathUtil.java
@@ -6,7 +6,11 @@
 
     // write a function to subtract 2 numbers
      public static int subtract(int a, int b) {
         return a - b;
     }
-    
+
+    // write a function to multiply 2 numbers
+    public static int multiply(int a, int b) {
+        return a * b;
+    }
 }`,
            },
            {
                udiff: `--- a/src/main/hello/MathUtil.java
+++ b/src/main/hello/MathUtil.java
@@ -8,5 +8,10 @@ public class MathUtil {
     public static int subtract(int a, int b) {
         return a - b;
     }
-    
+
+
+    // write a function to multiply 2 numbers
+    public static int multiply(int a, int b) {
+        return a * b;
+    }
 }`,
            },
            {
                udiff: `--- file:///Volumes/workplace/ide/sample_projects/Calculator-2/src/main/hello/MathUtil.java
+++ file:///Volumes/workplace/ide/sample_projects/Calculator-2/src/main/hello/MathUtil.java
@@ -6,7 +6,11 @@
 
     // write a function to subtract 2 numbers
      public static int subtract(int a, int b) {
         return a - b;
     }
-    
+      
+    // write a function to multiply 2 numbers
+    public static int multiply(int a, int b) {
+        return a * b;
+    }
 }`,
            },
            {
                udiff: `--- file:///Volumes/workplace/ide/sample_projects/Calculator/src/main/hello/MathUtil.java
+++ file:///Volumes/workplace/ide/sample_projects/Calculator/src/main/hello/MathUtil.java
@@ -1,9 +1,10 @@
 public class MathUtil {
     // write a function to add 2 numbers
     public static int add(int a, int b) {

+        return a + b;
     }

     // write a function to subtract 2 numbers
     public static int subtract(int a, int b) {
         return a - b;`,
            },
            {
                udiff: `--- file:///Volumes/workplace/ide/sample_projects/Calculator-2/src/main/hello/MathUtil.java
+++ file:///Volumes/workplace/ide/sample_projects/Calculator-2/src/main/hello/MathUtil.java
@@ -3,7 +3,9 @@
     public static int add(int a, int b) {
         return a + b;
     }
 
     // write a function to subtract 2 numbers
-    
+    public static int subtract(int a, int b) {
+        return a - b;
+    }
 }`,
            },
            {
                udiff: `--- file:///Volumes/workplace/ide/sample_projects/Calculator-2/src/main/hello/MathUtil.java
+++ file:///Volumes/workplace/ide/sample_projects/Calculator-2/src/main/hello/MathUtil.java
@@ -4,8 +4,8 @@
         return a + b;
     }
 
     // write a function to subtract 2 numbers
     public static int subtract(int a, int b) {
-        return 
+        return a - b;
     }
 }`,
            },
            {
                udiff: `--- file:///Volumes/workplace/ide/sample_projects/Calculator/src/main/hello/LRUCache.java
+++ file:///Volumes/workplace/ide/sample_projects/Calculator/src/main/hello/LRUCache.java
@@ -7,7 +7,11 @@
     private Map<Integer, Node> map;
     private DoubleLinkedList list;
     private int capacity;
 
     // get
-    public LruCache
+    public LruCache(int capacity) {
+        this.capacity = capacity;
+        map = new HashMap<>();
+        list = new DoubleLinkedList();
+    }
 }`,
            },
        ]

        for (let i = 0; i < addOnlyCases.length; i++) {
            it(`case ${i}`, function () {
                const actual = categorizeUnifieddiff(addOnlyCases[i].udiff)
                assert.strictEqual(actual, 'addOnly')
            })
        }
    })

    describe('edit', function () {
        const cases: Case[] = [
            {
                udiff: `--- a/src/main/hello/MathUtil.java
+++ b/src/main/hello/MathUtil.java
@@ -1,6 +1,6 @@
 public class MathUtil {
     // write a function to add 2 numbers
-    public static int add(int a, int b) {
+    public static double add(double a, double b) {
         return a + b;
     }
 `,
            },
            {
                udiff: `--- a/server/aws-lsp-codewhisperer/src/shared/codeWhispererService.ts
+++ b/server/aws-lsp-codewhisperer/src/shared/codeWhispererService.ts
@@ -502,11 +502,7 @@ export class CodeWhispererServiceToken extends CodeWhispererServiceBase {
             : undefined
     }
 
-    private withProfileArn<T extends object>(request: T): T {
-        if (!this.profileArn) return request
-
-        return { ...request, profileArn: this.profileArn }
-    }
+   // ddddddddddddddddd
 
     async generateSuggestions(request: BaseGenerateSuggestionsRequest): Promise<GenerateSuggestionsResponse> {
         // Cast is now safe because GenerateTokenSuggestionsRequest extends GenerateCompletionsRequest`,
            },
            {
                udiff: `--- file:///Users/atona/workplace/NEP/language-servers/server/aws-lsp-codewhisperer/src/language-server/inline-completion/utils/textDocumentUtils.ts
+++ file:///Users/atona/workplace/NEP/language-servers/server/aws-lsp-codewhisperer/src/language-server/inline-completion/utils/textDocumentUtils.ts
@@ -15,11 +15,11 @@
         return ''
     }
 }
 
 export const getTextDocument = async (uri: string, workspace: any, logging: any): Promise<TextDocument | undefined> => {
-    let 
+    if (!textDocument) {
     if (!textDocument) {
         try {
             const content = await workspace.fs.readFile(URI.parse(uri).fsPath)
             const languageId = getLanguageIdFromUri(uri)
             textDocument = TextDocument.create(uri, languageId, 0, content)`,
            },
            {
                udiff: `--- a/src/main/hello/MathUtil.java
+++ b/src/main/hello/MathUtil.java
@@ -12,4 +12,5 @@ public class MathUtil {
 
     // write a function to multiply 2 numbers
     public static int multiply(int a, int b) {
-        return a * b;
+        return a * b * c;
+    }`,
            },
        ]

        for (let i = 0; i < cases.length; i++) {
            it(`case ${i}`, function () {
                const actual = categorizeUnifieddiff(cases[i].udiff)
                assert.strictEqual(actual, 'edit')
            })
        }
    })
})

describe('diffUtils', () => {
    describe('getAddedAndDeletedLines', () => {
        const SAMPLE_UNIFIED_DIFF = `--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 line1
-old line
+new line
 line3`
        it('should extract added and deleted lines from unified diff', () => {
            const result = getAddedAndDeletedLines(SAMPLE_UNIFIED_DIFF)

            assert.deepEqual(result.addedLines, ['new line'])
            assert.deepEqual(result.deletedLines, ['old line'])
        })

        it('should handle empty diff', () => {
            const result = getAddedAndDeletedLines('')
            assert.deepEqual(result.addedLines, [])
            assert.deepEqual(result.deletedLines, [])
        })
    })

    describe('getCharacterDifferences', () => {
        const ADDED_LINES = ['hello world']
        const DELETED_LINES = ['hello there']
        it('should calculate character differences using LCS', () => {
            const result = getCharacterDifferences(ADDED_LINES, DELETED_LINES)

            assert.equal(result.charactersAdded, 4)
            assert.equal(result.charactersRemoved, 4)
        })

        it('should handle empty added lines', () => {
            const result = getCharacterDifferences([], DELETED_LINES)

            assert.equal(result.charactersAdded, 0)
            assert.equal(result.charactersRemoved, 11) // 'hello there' = 11 chars
        })

        it('should handle empty deleted lines', () => {
            const result = getCharacterDifferences(ADDED_LINES, [])

            assert.equal(result.charactersAdded, 11) // 'hello world' = 11 chars
            assert.equal(result.charactersRemoved, 0)
        })

        // Dense-table LCS, the implementation before the table was bounded
        function referenceCharacterDifferences(added: string, deleted: string) {
            const dp = Array.from({ length: deleted.length + 1 }, () => new Array(added.length + 1).fill(0))
            for (let i = 1; i <= deleted.length; i++) {
                for (let j = 1; j <= added.length; j++) {
                    dp[i][j] =
                        deleted[i - 1] === added[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
                }
            }
            const lcs = dp[deleted.length][added.length]
            return { charactersAdded: added.length - lcs, charactersRemoved: deleted.length - lcs }
        }

        it('should match a dense LCS table below the size cap', () => {
            const pairs: [string, string][] = [
                ['aa', 'aaa'],
                ['aaa', 'aa'],
                ['abab', 'ba'],
                ['abcXdef', 'abcYYdef'],
                ['const x = 1', 'const y = 2'],
                ['same', 'same'],
            ]
            // Deterministic pseudo-random pairs over a small alphabet, so prefixes, suffixes and repeats all occur
            let seed = 7
            const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648)
            const randomText = (length: number) => Array.from({ length }, () => 'ab\nc'[next() % 4]).join('')
            for (let i = 0; i < 200; i++) {
                pairs.push([randomText(next() % 40), randomText(next() % 40)])
            }

            for (const [added, deleted] of pairs) {
                if (added.length === 0 || deleted.length === 0) {
                    continue
                }
                assert.deepEqual(
                    getCharacterDifferences([added], [deleted]),
                    referenceCharacterDifferences(added, deleted),
                    JSON.stringify({ added, deleted })
                )
            }
        })

        it('should only compare the text between a common prefix and suffix', () => {
            const prefix = 'p'.repeat(100_000)
            const suffix = 's'.repeat(100_000)

            const result = getCharacterDifferences([prefix + 'hello world' + suffix], [prefix + 'hello there' + suffix])

            assert.deepEqual(result, { charactersAdded: 4, charactersRemoved: 4 })
        })

        it('should not build a table above the size cap', () => {
            const added = 'a'.repeat(32_000) + 'b'.repeat(32_000)
            const deleted = 'b'.repeat(32_000) + 'a'.repeat(32_000)
            assert.ok(added.length * deleted.length > MAX_LCS_CELLS)

            const start = Date.now()
            const result = getCharacterDifferences([added], [deleted])

            assert.ok(Date.now() - start < 1_000, `took ${Date.now() - start} ms`)
            // The text is counted as entirely replaced
            assert.deepEqual(result, { charactersAdded: 64_000, charactersRemoved: 64_000 })
        })
    })

    describe('generateDiffContexts', () => {
        const TEST_FILE_PATH = '/test/file.ts'
        const CURRENT_CONTENT = 'current content'
        const OLD_CONTENT = 'old content'
        const MAX_CONTEXTS = 5
        const SNAPSHOT_CONTENTS = [
            {
                filePath: TEST_FILE_PATH,
                content: OLD_CONTENT,
                timestamp: Date.now() - 1000,
            },
        ]
        it('should generate diff contexts from snapshots', () => {
            const result = generateDiffContexts(TEST_FILE_PATH, CURRENT_CONTENT, SNAPSHOT_CONTENTS, MAX_CONTEXTS)

            assert.equal(result.isUtg, false)
            assert.equal(result.isProcessTimeout, false)
            assert.equal(result.strategy, 'recentEdits')
            assert.equal(typeof result.latency, 'number')
            assert.equal(typeof result.contentsLength, 'number')
        })

        it('should return empty context for no snapshots', () => {
            const result = generateDiffContexts(TEST_FILE_PATH, 'content', [], MAX_CONTEXTS)

            assert.equal(result.isUtg, false)
            assert.equal(result.isProcessTimeout, false)
            assert.equal(result.supplementalContextItems.length, 0)
            assert.equal(result.contentsLength, 0)
            assert.equal(result.latency, 0)
            assert.equal(result.strategy, 'recentEdits')
        })
    })
})
