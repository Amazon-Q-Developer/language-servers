# Agentic chat hardening — testing

This document describes behavior changes in the chat servers of `@aws/lsp-codewhisperer` and how to
test them. Each numbered section describes one change.

The tests use only temporary folders and synthetic data. They create and remove their own fixtures.

## 1. Tool permissions in workspace agent configs

### Behavior

A server's permissions come from the global agent config and, for a server loaded from a workspace
folder's `.amazonq` folder, also from the `.amazonq/agents/default.json` file in that folder. The
server can be loaded from that agent config or from the `mcp.json` file in the same folder.

- A server-scoped entry (`@server` or `@server/tool`) in a workspace agent config is kept only for a
  server loaded from the same `.amazonq` folder.
- In the `tools` list of a workspace agent config, `"*"` enables the servers that the same file
  defines, except servers whose names contain `*` or `?`. Other glob patterns in a workspace agent
  config, including `"*"` in `allowedTools`, are ignored.
- Exact entries without `@`, such as built-in tool names, are merged as before.
- Entries that are not strings are skipped in every agent config.
- Each ignored entry is logged as a warning that names the file and the reason. The warning quotes the
  entry and the server names as JSON strings, so a newline in them does not start another log line.
- When an entry is matched to the folder that loads its server, config file paths are compared without
  case on Windows and macOS.
- Otherwise, permissions from the global agent config and the global `mcp.json` behave as before.

Compatibility:

- To change the permissions of a server that the global config loads, use the MCP settings.
- Write workspace grants as exact tool names, such as `@repo/read_file`, not as patterns such as
  `@repo/read_*`.
- A workspace server whose name extends the name of a server loaded from another config, such as
  `repo/x` next to a global `repo`, receives no permissions from workspace config files. This includes
  its default enablement from a workspace `mcp.json`. Changes to its permissions in the MCP settings
  do not last past a reload.

### How to test

From `server/aws-lsp-codewhisperer`:

```sh
npx ts-mocha --timeout 0 --exit \
  src/language-server/agenticChat/tools/mcp/mcpUtils.test.ts \
  src/language-server/agenticChat/tools/mcp/agentPermissionManager.test.ts
npm run lint
```

The suite "loadAgentConfig permission entries from a workspace agent config" loads real config files
from a temporary folder with `loadAgentConfig` and checks the result with `AgentPermissionManager`. It
covers each rule above, servers from a workspace `mcp.json`, server names with glob characters or
`/`, and a wildcard in the global agent config. The suite "removeUntrustedScopedPermissions()" sets
`process.platform` to `win32`, `darwin` and `linux` and checks the path comparison on each.

These suites check `AgentPermissionManager`. The `McpManager` tests stub `loadAgentConfig`, so no
test runs `McpManager.requiresApproval` on loaded config files.

From the repository root, check formatting with `npm run check:formatting`.

## 2. Errors in chat notification handlers

### Behavior

- When a chat notification handler throws, or returns a promise that rejects, the chat server logs
  the error and continues to run. The log line names the notification method, for example
  `Chat notification aws/chat/createPrompt failed:`. This applies to the agentic chat server
  (`agenticChat/qAgenticChatServer.ts`) and to the chat server in `chat/qChatServer.ts`. Both use
  `logNotificationErrors` from `chat/notificationErrors.ts`.
- A notification has no response, so the client receives no error. Request handlers are unchanged:
  the JSON-RPC layer already sends an error response when a request handler fails.
- When the chat UI is ready, the agentic chat server starts a background update of the code symbols
  for context commands. A failure of that update is logged as
  `Error updating code symbols for context commands:`.
- `aws/chat/createPrompt` with `isRule: true` creates the rule in the `.amazonq/rules` folder of the
  first workspace folder, as before. When no workspace folder is open, it creates a saved prompt in
  the user prompts folder (`~/.aws/amazonq/prompts`), the same as a request without `isRule`.

### How to test

From `server/aws-lsp-codewhisperer`:

```sh
npx ts-mocha --timeout 0 --exit \
  src/language-server/chat/notificationErrors.test.ts \
  src/language-server/chat/qChatServer.test.ts \
  src/language-server/agenticChat/qAgenticChatServer.test.ts \
  src/language-server/agenticChat/agenticChatController.test.ts
npm run lint
```

- In `qAgenticChatServer.test.ts` and `qChatServer.test.ts`, the suite "notification handler
  failures" calls each notification handler that the server registers while the controller method
  rejects. Each test checks that the error is logged with the notification method and that this
  rejection is not left unhandled. Other tests check a controller method that throws, a rule request with
  no workspace folder open (agentic chat server), and an insert notification whose `code` is not a
  string (chat server).
- The suite "request handler results" in each of those files checks that each request handler still
  returns the result of its controller method.
- The suite "logNotificationErrors()" checks the wrapper without a server, including an error that
  cannot be formatted and a logger that throws.
- In `agenticChatController.test.ts`, the `onCreatePrompt` tests check rule creation with and without
  a workspace folder. The `onReady` test checks that a failed code symbol update is logged and leaves
  no unhandled rejection.

## 3. Invisible characters in chat requests

### Behavior

`sanitizeInput` in `shared/utils.ts` removes characters that can hide content. Most of them are not
visible in rendered text. The agentic chat server applies it to the chat prompt, to each request of
the agent loop and of history compaction (with their history, context, tool results and tool
descriptions), and to the descriptions of MCP tools.

- It removes every character with the Unicode property `Default_Ignorable_Code_Point`, except the
  presentation selectors described below, in addition to the ranges that it removed before. The new
  characters include the variation selectors (U+FE00–U+FE0F and U+E0100–U+E01EF), the soft hyphen
  (U+00AD), the combining grapheme joiner (U+034F), the Arabic letter mark (U+061C), the Hangul fillers
  and U+FEFF.
- A presentation selector that belongs to an emoji is kept: U+FE0E or U+FE0F directly after a
  character with the Unicode property `Extended_Pictographic`, or the U+FE0F of a keycap sequence such
  as `1️⃣` (1 U+FE0F U+20E3). So an emoji such as `⚠️` (U+26A0 U+FE0F) reaches the model unchanged. In
  a run of variation selectors, at most the first one is kept.
- Every character that it removed before is still removed. Control characters, including tab, newline
  and carriage return, are kept, as before.
- Other variation sequences, for example of CJK ideographs, Mongolian letters and mathematical
  symbols, reach the model in their default form.
- As with the characters that were removed before, the removal also applies to file and folder names in
  the request. An edit does not match when the file text that it replaces contains a removed character,
  and a file that the model rewrites in full no longer contains these characters.

### How to test

From `server/aws-lsp-codewhisperer`:

```sh
npx ts-mocha --timeout 0 --exit \
  src/shared/utils.test.ts \
  src/language-server/agenticChat/agenticChatController.test.ts \
  src/language-server/agenticChat/tools/mcp/mcpManager.test.ts
npm run lint
```

- The suite "sanitizeInput" checks characters from each newly removed range, a run of variation
  selectors after an emoji, the presentation selectors that are kept and removed, and every character
  in the earlier ranges. Other tests check HTML escaping, visible text in several scripts, and that a
  second pass gives the same result.
- The suite "sanitizeRequestInput" checks the message, context, history, tool results and tool
  descriptions of one request.
- In `agenticChatController.test.ts`, the tests "removes variation selectors from the prompt and keeps
  emoji", "removes variation selectors from the chat history in the request" and "removes variation
  selectors from the chat history in the compaction request" check the requests that a chat prompt and
  `/compact` produce.
- In `mcpManager.test.ts`, the suite "tool descriptions from an MCP server" checks the description of a
  tool that a server lists.

## 4. Invisible characters in inline chat requests

### Behavior

- The agentic chat server applies `sanitizeRequestInput` to each inline chat request before it sends
  it. The characters that section 3 says `sanitizeInput` removes are removed from the prompt, the
  document text and the rest of the request.
- The inline chat prompt is not HTML-escaped, as before.
- Code that inline chat rewrites loses the removed characters that it contained.

### How to test

From `server/aws-lsp-codewhisperer`:

```sh
npx ts-mocha --timeout 0 --exit -g "onInlineChatPrompt" \
  src/language-server/agenticChat/agenticChatController.test.ts
npm run lint
```

The test "removes invisible characters from the prompt and the document text without escaping HTML"
opens a document, sends an inline chat prompt for it, and checks the request that is sent.

## 5. Invisible characters in other chat requests

### Behavior

- The agentic chat server applies `sanitizeRequestInput` to the file ranking request of memory bank
  generation. That request lists workspace file paths. As in section 3, a path that contains a removed
  character reaches the model without that character.
- In the chat server in `chat/qChatServer.ts`, `chat/chatController.ts` applies `sanitizeRequestInput`
  to each chat request and each inline chat request. Before this change, this server removed no
  characters from requests. Now the characters that section 3 says `sanitizeInput` removes are removed
  from the prompt, the document text and the rest of the request. The prompt is not HTML-escaped, as
  before. Code that inline chat rewrites loses the removed characters that it contained.

### How to test

From `server/aws-lsp-codewhisperer`:

```sh
npx ts-mocha --timeout 0 --exit src/language-server/chat/chatController.test.ts
npx ts-mocha --timeout 0 --exit -g "memory bank generation" \
  src/language-server/agenticChat/agenticChatController.test.ts
npm run lint
```

- In `chatController.test.ts`, the suites "onChatPrompt" and "onInlineChatPrompt" each have the test
  "removes invisible characters from the prompt and the document text without escaping HTML". It
  checks the request that is sent.
- In `agenticChatController.test.ts`, the test "removes invisible characters from the file ranking
  request without escaping HTML" checks the ranking request of memory bank generation.
