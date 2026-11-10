# Agentic chat hardening — testing

This document describes behavior changes in the language servers and the chat client, and how to test
them. Each numbered section describes one change.

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

## 6. Subscription upgrade URL

### Behavior

When a Builder ID user on the free tier chooses to upgrade (the upgrade button in chat, the upgrade
action of the free-tier limit message, or the `aws/chat/manageSubscription` command with no AWS
account ID), the agentic chat server requests a subscription token. It then asks the client to open
the `encodedVerificationUrl` of the response in the external browser.

- The server asks the client to open the URL only when it is an https URL on the AWS sign-in host
  (`signin.aws.amazon.com`), with no user name, no password and the default port. The service builds
  the URL on `https://signin.aws.amazon.com/oauth`. Subdomains of the sign-in host are not accepted,
  because AWS accounts can choose subdomains of it for their own sign-in pages.
- `parseSubscriptionUpgradeUrl` in `paidTier/paidTier.ts` checks the URL. The server sends the URL in
  the normalized form that `URL` returns.
- For any other URL, the server does not ask the client to open it, does not set the "upgrade pending"
  state, and shows the error "Subscription request failed.", as it already did for a response with no
  URL.
- The server logs the subscription status, but not the URL, because the URL contains an activation
  token.

### How to test

From `server/aws-lsp-codewhisperer`:

```sh
npx ts-mocha --timeout 0 --exit src/language-server/paidTier/paidTier.test.ts
npx ts-mocha --timeout 0 --exit -g "onManageSubscription|setPaidTierMode caching" \
  src/language-server/agenticChat/agenticChatController.test.ts
npm run lint
```

- The suite "parseSubscriptionUpgradeUrl" checks URLs that are accepted and their normalized form,
  and URLs that are rejected: other schemes, http, other hosts, subdomains of the sign-in host, a host
  that only ends with the sign-in host name, a user name or password, and a non-default port.
- The suite "onManageSubscription" checks that the server asks the client to open the sign-in URL in
  the external browser, in normalized form. It also checks that the server shows the error for each
  rejected URL and for a missing URL, and that no log line contains the activation token.
- The test "logs the subscription status without the subscription URL" checks the log line that the
  server writes when a chat tab opens.

## 7. Source links in chat responses

### Behavior

A chat response can include source links, which the service sends as the supplementary web links of
the response. The chat UI shows them under the answer, and a click on one asks the IDE to open it.

- The agentic chat server (`agenticChat/agenticChatEventParser.ts`) and the chat server in
  `chat/qChatServer.ts` (`chat/chatEventParser.ts`) keep a source link only when its URL is an
  absolute `http` or `https` URL with a host name. `isWebUrl` in `shared/utils.ts` checks the URL.
  The servers drop every other source link, for example a link with another scheme, a relative link
  or a link with no URL. A kept link is sent unchanged, in the order of the response.
- When none of the links of a response event is kept, the server adds no related content for that
  event. The telemetry count of source link events still counts the event.
- The chat client sends a source link click to the IDE (`aws/chat/sourceLinkClick`) only when
  `classifyChatLink` classifies the link as a web link. Clicks on links in answers and on info links
  already used this check. For any other source link, the client records the `sourceLinkClick`
  telemetry event, does not send the click to the IDE, and shows the "Link not opened" notification.

### How to test

From `server/aws-lsp-codewhisperer`:

```sh
npx ts-mocha --timeout 0 --exit -g "source links|isWebUrl" \
  src/language-server/agenticChat/agenticChatEventParser.test.ts \
  src/language-server/chat/chatEventParser.test.ts \
  src/shared/utils.test.ts
npm run lint
```

From `chat-client`, run the whole suite. A run filtered with `-g` skips setup in `chat.test.ts` that the
tests in `mynahUi.test.ts` need.

```sh
npm run test:unit
```

- The suite "isWebUrl" checks URLs that are accepted, and URLs that are rejected: other schemes in
  several spellings, a URL with no host, a URL with no scheme, and relative and absolute paths.
- The two "source links" suites check that only `http` and `https` links are kept, in order and
  unchanged, and that an event with no such link adds no related content. The agentic suite also
  checks that the links of earlier events are kept.
- The suite "source link clicks" checks that `http` and `https` links go to the IDE with telemetry,
  and that other links and local paths do not go to the IDE and show the notification.

## 8. Memory bank folder cleanup

### Behavior

Before the agentic chat server generates a memory bank, `cleanMemoryBankDirectory` in
`agenticChat/context/memorybank/memoryBankController.ts` removes the four memory bank files
(`product.md`, `structure.md`, `tech.md` and `guidelines.md`) from `.amazonq/rules/memory-bank` in
the workspace folder. It then creates that folder if it does not exist.

- The server now does this only when the memory bank folder, after every symbolic link in its path is
  followed, is inside the workspace folder. It resolves the path with `resolveCanonicalPath`, as the
  file tools do, and compares it with the resolved workspace folder.
- Otherwise, the server removes and creates nothing there, and logs a warning. Memory bank generation
  continues. The files that the agent writes next go through the approval check for files outside the
  workspace, like any other file write.
- A symbolic link that stays inside the workspace folder, and a workspace folder that is opened
  through a symbolic link, work as before.

### How to test

From `server/aws-lsp-codewhisperer`:

```sh
npx ts-mocha --timeout 0 --exit -g "cleanMemoryBankDirectory" \
  src/language-server/agenticChat/context/memorybank/memoryBankController.test.ts
npm run lint
```

The suite "cleanMemoryBankDirectory" uses a temporary folder and directory links (junctions on
Windows). It checks that:

- the files are removed, and other files in the folder are kept, when the memory bank folder is in
  the workspace folder, when a link inside the workspace folder leads to it, and when the workspace
  folder is opened through a link;
- the folder is created when it does not exist;
- nothing is removed or created, and a warning is logged, when `.amazonq`, `.amazonq/rules` or
  `.amazonq/rules/memory-bank` links to a folder outside the workspace folder.

## 9. C# imports in the security scan

### Behavior

The C# dependency graph of the security scan (`securityScan/dependencyGraph/csharpDependencyGraph.ts`)
reads the `using` directives and `namespace` declarations of the C# files in the project.

- The patterns for `using` directives and `namespace` declarations now match the `.` between two
  names as a literal dot. Before this change, `.` matched any character, so a long `using` line with
  no `;` could take seconds or more to fail to match. It now fails in linear time.
- `readImports` now uses the exported `importRegex`. The pattern that it used before was the same
  except for a leading `\s*`. That `\s*` did not change the imports that it read, but it made a long
  run of whitespace take time that grew with the square of its length. That now takes linear time.
- For names made of ASCII letters, digits and `_`, the imports and namespaces that are read do not
  change. Other text can be read differently than before, because `.` no longer matches another
  character: `using Foo Bar;` and `namespace Foo Bar` are no longer read as the name `Foo Bar`, and
  `using MaßEinheit;` is no longer read as an import.

### How to test

From `server/aws-lsp-codewhisperer`:

```sh
npx ts-mocha --timeout 0 --exit -g "readImports|createNamespaceFilenameMapper" \
  src/language-server/securityScan/dependencyGraph/csharpDependencyGraph.test.ts
npm run lint
```

- The suite "Test readImports" checks indented, aliased and static imports, a dot that must be
  literal, and four lines with no `;` that must each be read in well under 500 ms: a long name, a
  long aliased name, a long dotted name and a long run of whitespace.
- The test "should treat the dot between namespace names as a literal dot" checks the namespace map.

## 10. Nested .gitignore files in the security scan

### Behavior

Before the security scan builds its dependency graph, it removes the files that the project's
`.gitignore` files ignore. `GitIgnoreFilter` in `@aws/lsp-core`
(`core/aws-lsp-core/src/util/gitIgnoreFilter.ts`) does this.

- `GitIgnoreFilter` now applies the patterns of each `.gitignore` file relative to the folder that
  contains the file, and only to the files in that folder and its subfolders, as Git does. Before this
  change, it applied the patterns of every `.gitignore` file relative to the root folder of the scan.
- For example, `/x.cs` in `sub/.gitignore` now ignores `sub/x.cs` and not `x.cs`, and `*.tmp` in
  `sub/.gitignore` no longer ignores `.tmp` files outside `sub`.
- A file is kept only when every `.gitignore` file that applies to it accepts it, as before.
- `GitIgnoreFilter.build` keeps its `rootPath` parameter so that existing callers keep working. It no
  longer uses it.

### How to test

From `core/aws-lsp-core`:

```sh
npx ts-mocha --timeout 0 --exit src/util/gitIgnoreFilter.test.ts
```

The suite "GitIgnoreFilter" checks root and nested `.gitignore` files: anchored patterns, patterns
without a slash, folder patterns, a sibling folder whose name starts with the same text, and a file
that two `.gitignore` files apply to.

## 11. Install preview for MCP registry servers

### Behavior

When an administrator configures an MCP registry for the profile, the **Add MCP Server** view lists
the servers of the registry. The list shows only the name, version and description of each server.
The registry entry decides the rest: for a local server, the package, the command (`npx`, `uvx` or
`docker`), the arguments, the environment variables and the package index; for a remote server, the
URL and the headers. A registry server is installed in the global agent configuration, so the consent
prompt for workspace MCP configurations does not apply to it.

- **Install** in the registry list now opens an **Install MCP Server** view for that server instead
  of installing it. The view shows the configuration that the server starts with after the install,
  from `McpServerConfigConverter.convertRegistryServer`: the command, every argument and every
  environment variable with its value, or the URL and every header with its value. The agent
  configuration file stores only a `type: 'registry'` entry for the server.
- The status at the top of the view shows this configuration as JSON on one line, in a code span
  that wraps, so a long value is shown in full. `formatServerConfigForReview` in `mcpConsentStore.ts`
  builds the JSON. It writes control, format and other characters that a reader would not see, such
  as a bidirectional override, and spaces other than U+0020 as `\u` escapes. It also writes `<`, `>`
  and `&` as `\u003c`, `\u003e` and `\u0026`, because the chat UI can read them as HTML in code. The
  JSON still parses to the exact values. Markdown in a value is shown as written.
- Below the status, read-only fields show the name, version, transport and each part of the
  configuration. The fields cut off a value that is longer than the field. The view leaves out a list
  that is empty.
- **Install** in this view installs the server, as **Install** in the list did before. **Cancel**
  goes back to the server list.
- The server installs only the configuration that the view showed. When the user confirms, the
  server converts the registry entry again and compares it with the shown configuration
  (`fingerprintServerConfig`, which covers the command, arguments, environment variables, URL and
  headers), and with the version. If the registry changed the entry after the view was shown, the
  server shows the view again with the warning "This server changed in the registry. Review it again
  before you install it." and installs nothing. A confirmation is used once, and the form values
  that come with it are not used. A confirmation for a server that the view did not show, or for a
  server that left the registry, installs nothing.
- A registry entry that cannot be converted, for example one with neither packages nor remotes, now
  logs an error and shows the registry list. Before, the install request failed.
- Not covered: these paths start a registry server from the current registry entry without showing
  the view:
  - The language server builds the configuration of each installed registry server from the current
    registry entry when it loads the MCP configuration: when it starts, when the user refreshes the
    server list, when an agent configuration file changes, when a registry becomes active after the
    user signs in or selects a profile, and when MCP is turned on again for the profile.
  - The periodic registry sync reinstalls a server when its version in the registry changes.
  - **Save** in the edit view of an installed registry server reinstalls it from the current registry
    entry.

### How to test

From `server/aws-lsp-codewhisperer`:

```sh
npx ts-mocha --timeout 0 --exit -g "installing a registry server|formatServerConfigForReview|code spans" \
  src/language-server/agenticChat/tools/mcp/mcpEventHandler.test.ts \
  src/language-server/agenticChat/tools/mcp/mcpConsentStore.test.ts \
  src/language-server/agenticChat/textFormatting.test.ts
npm run lint
```

From `chat-client`, run the whole suite. A run filtered with `-g` skips setup in `chat.test.ts` that
other suites need.

```sh
npm run test:unit
```

- The suite "installing a registry server" checks the view for a local server and for a remote
  server: the status text, that every field is read-only, and that empty lists are left out. It
  checks that a long value is in the status text in full, that a hidden character is escaped, and
  that backticks, markdown and HTML in a value stay inside the code span, with `<`, `>` and `&` only
  as escapes. It checks that **Install**
  installs exactly the shown configuration once and does not use form values. It checks that nothing
  is installed when the registry changed an argument, an environment variable, the package index,
  the version, the URL or a header after the view was shown, when the view showed another server or
  no server, when the server left the registry, or when the entry cannot be converted.
- The suite "formatServerConfigForReview" checks the JSON for a local and a remote server, that
  empty parts are left out, that hidden characters, spaces other than U+0020, and `<`, `>` and `&`
  become escapes and the JSON still parses to the exact values, and that visible non-ASCII
  characters are kept. The suite "code spans" checks the delimiter for text with backticks.
- In `mcpMynahUi.test.ts`, the suite "registry server install" checks that **Install** in the list
  asks for the view, that **Install** in the view asks the server to install the server that the view
  showed, and that **Cancel** goes back to the server list.

## 12. Agent config migration in a workspace folder

### Behavior

When the agentic chat server starts, it migrates the agent config of each workspace folder,
`.amazonq/agents/default.json`, in `agenticChat/tools/mcp/mcpUtils.ts`:

- If the file does not exist, `migrateToAgentConfig` creates it and copies into it the MCP servers of
  the folder's `.amazonq/mcp.json`.
- If the file exists, `migrateAgentConfigsToCLIFormat` updates it to the current format.

Both checks for the file follow symbolic links, so a link whose target did not exist yet looked like a
missing file, and the server then wrote through the link. A link at `.amazonq`, `.amazonq/agents` or
`.amazonq/agents/default.json` could make the server create or update a file outside the workspace
folder.

- The server now writes the agent config of a workspace folder in these two steps only when its path,
  after every symbolic link is followed, is inside that workspace folder. It resolves the path with
  `resolveCanonicalPath`, as the file tools do.
- Otherwise, or when the path cannot be resolved (for example, two links that point at each other),
  it writes nothing and logs a warning that starts with "Did not create the agent config" or "Did not
  update the agent config".
- A link that stays inside the workspace folder, and a workspace folder that is opened through a link,
  work as before. The migration of the global agent config is unchanged.
- Not covered: other writes to the agent config of a workspace folder still follow links in its path:
  the reinstall of a registry server by the periodic registry sync, and writes that the user starts
  in the MCP settings, such as saving a workspace server or changing the permission of one of its
  tools.

### How to test

From `server/aws-lsp-codewhisperer`:

```sh
npx ts-mocha --timeout 0 --exit -g "migrateToAgentConfig" \
  src/language-server/agenticChat/tools/mcp/mcpUtils.test.ts
```

The suite "a workspace agent config path with symbolic links" uses a temporary folder and links
(junctions on Windows for folders). It checks that:

- the agent config is created in a workspace folder with no links, through a link that stays inside
  the workspace folder, and in a workspace folder that is opened through a link;
- an existing workspace agent config and the global agent config are updated to the current format;
- nothing is created or updated, and the warning is logged once, when `default.json` is a link to a
  file outside the workspace folder (whether that file exists or not), when `.amazonq/agents` or
  `.amazonq` links to a folder outside the workspace folder, and when two links in the path point at
  each other.

The cases with a link to a file are skipped on Windows when the test cannot create one.
