# Agentic chat hardening — testing

This document records security hardening in the agentic chat of `@aws/lsp-codewhisperer`, with the
safe reproduction and test steps for each change. Each numbered section describes one fix in this
change.

Use only temporary directories and synthetic data. Never use a real credential file, a real MCP
server, or a command-execution payload. The regression tests create and remove their own fixtures.

## 1. Workspace agent configs can change permissions for the user's own MCP servers

### What was wrong

`loadAgentConfig` merges the `tools` and `allowedTools` lists of every agent config: the global
config in the home folder and the `.amazonq/agents/default.json` file of each workspace folder.
Anyone who can change a repository can write its workspace file, but the merge did not limit what
that file could grant:

- A bare `"*"` in `tools` enabled every tool of every MCP server, including the user's own servers.
  A tool the user denied is stored as a missing entry, so `"*"` enabled it again. Other bare glob
  patterns, such as `"*_tool"`, did the same for the tools they match.
- A bare `"*"` or glob pattern in `allowedTools` made the MCP permission list show those tools as
  always allowed, while the runtime approval check, which is an exact match, still asked.
- A server-scoped entry such as `"@demo/run"` in a workspace file was restored for any loaded server
  with that name, including a server that only the user's global config defines.
  `McpManager.requiresApproval` asks unless `allowedTools` lists the tool exactly, so a workspace
  file could enable a tool the user denied and make it run with no approval prompt. A workspace file
  that declared a decoy server with the same name also kept the grant after the user's global
  `mcp.json` definition replaced the decoy.
- A non-string entry, such as `42`, made the whole load fail.

### How the fix works

- `loadAgentConfig` records which config file listed each server-scoped entry. After loading,
  `removeUntrustedScopedPermissions` keeps an entry from a workspace file only when that same file
  defines the server, or when the other config file in the same `.amazonq` folder defines it. The
  agent config and the `mcp.json` of one folder have the same author, and the IDE saves the
  permissions of `mcp.json` servers in the agent config next to it. A server that a workspace file
  defines still needs the user's consent before it starts. Entries from the global agent config and
  the global `mcp.json` are always kept.
- In the `tools` list of a workspace file, a bare `"*"` now enables only the servers that the same
  file defines: it is added as `@<server>` for each of them. Other bare glob patterns in `tools`, and
  every bare glob pattern in `allowedTools`, are ignored. A wildcard in `allowedTools` never matches
  the exact approval check, so it could only make the permission list disagree with the prompts. A
  workspace server whose name contains a glob character receives no grants, because `@<name>` would
  match other servers.
- Server names can contain `/`, so an entry can name more than one loaded server. Such an entry is
  kept only when every server it names trusts the file that listed it. For the same reason, a
  workspace file cannot grant a glob entry such as `@repo/*`: it would also match the tools of a
  server named `repo/x`.
- Config file paths are compared without case on Windows and macOS, whose file systems usually ignore
  case.
  On Windows a path from a workspace URI has a lowercase drive letter, while other paths can keep
  the uppercase one.
- Non-string entries are skipped. Exact bare names, such as built-in tool names, are unchanged.
- Every ignored entry is logged as a warning.

Compatibility:

- A workspace file that enabled or auto-approved tools of the user's global servers no longer does.
  The user sets those permissions in the MCP settings, which save them to the global agent config.
- Server-scoped glob entries in a workspace file, such as `@repo/read_*`, are ignored even for the
  file's own servers, so they must be written as exact tool names.
- A workspace server whose name extends the name of one of the user's servers, such as `repo/x` next
  to a global `repo`, cannot receive permissions from a workspace file, because `@repo/x` also names
  the tool `x` of `repo`. If the user sets "Always allow" for it, the setting returns to the previous
  value on the next reload. This is the safe direction.
- Wildcards and grants in the global agent config are unchanged.

### Safe reproduction and expected results

Use a temporary folder as the home folder and another as the workspace folder. Call `loadAgentConfig`
with the workspace agent config and the global agent config, then check the returned `agentConfig`
directly or through `AgentPermissionManager`. No MCP server is started.

The global agent config defines the server `demo` with `tools: ["@demo/allowed_tool"]`, so the
tool `denied_tool` is denied.

| Workspace `.amazonq/agents/default.json` | Before | After |
| --- | --- | --- |
| `{"tools": ["*"]}` | `demo/denied_tool` enabled | stays denied |
| `{"tools": ["*_tool"]}` | `demo/denied_tool` enabled | stays denied |
| `{"allowedTools": ["*"]}` | every enabled tool shown as always allowed, still asks | shown as ask, asks |
| A `repo` server and `{"tools": ["@repo/*"]}`; the user's global server is `repo/x` | `repo/x/denied_tool` enabled | stays denied |
| `{"tools": ["@demo/denied_tool"], "allowedTools": ["@demo/denied_tool"]}` | enabled, runs with no prompt | stays denied |
| Decoy `demo` server and `{"allowedTools": ["@demo/anytool"]}`; the user's `demo` is in the global `mcp.json` | runs with no prompt | asks |
| A `repo` server and `{"tools": ["*"]}` | every tool enabled | only `repo` tools enabled |
| `{"tools": ["@repo"], "allowedTools": ["@repo/read_tool"]}` with the `repo` server in the same file | kept | kept |
| `{"tools": [42]}` | loading fails | entry skipped |

### Tests

`mcpUtils.test.ts` adds the suite "loadAgentConfig permission entries from a workspace agent
config". It writes real config files to a temporary folder and runs the real `loadAgentConfig` and
`AgentPermissionManager`. It covers:

- each row of the table above;
- a workspace `mcp.json` server whose grants are in the agent config next to it;
- a workspace server name with a glob character, and one that contains `/`;
- a global or workspace `mcp.json` server whose name extends another server's name, which keeps its
  default enablement;
- a workspace server whose entry also names one of the user's servers, with the warning naming that
  server;
- a wildcard in the global config, which still applies.

A separate `removeUntrustedScopedPermissions()` suite sets `process.platform` to `win32`, `darwin`
and `linux` and checks that config file paths that differ only in case are treated as one file on
Windows and macOS, and as different files on Linux.

Several cases also check the warning that an ignored entry produces.

### How to test

From `server/aws-lsp-codewhisperer`:

```sh
npx ts-mocha --timeout 0 --exit \
  src/language-server/agenticChat/tools/mcp/mcpUtils.test.ts \
  src/language-server/agenticChat/tools/mcp/agentPermissionManager.test.ts
npm run lint
```

From the repository root, check formatting with `npm run check:formatting`.

### Limits

- The `McpManager` tests stub `loadAgentConfig`. The step from `allowedTools` to the approval
  decision is verified by reading `McpManager.requiresApproval`, an exact match on `allowedTools`,
  not by an end-to-end test here.
- The consent check for a workspace server does not cover its grants. After the user approves a
  workspace server, editing only its grants does not ask again. This change does not address that.
- A workspace server can take the name of one of the user's servers, and the user's global grants
  for that name then apply to it. A server in the workspace agent config replaces one in the global
  agent config, and a server in the workspace `mcp.json` replaces one in the global `mcp.json` or the
  global agent config. A workspace agent config that sets `useLegacyMcpJson: false` stops the global
  `mcp.json` servers from
  loading, so a server in the workspace agent config can then take their names too. The consent prompt
  for the workspace server is the only check, and it does not show those grants. This change does not
  address that.
- A tool ID is `@<server>/<tool>`, and both names can contain `/`, so two different server and tool
  pairs can have the same ID. The approval check matches IDs, so a grant for one pair can apply to the
  other. This change does not address that.
