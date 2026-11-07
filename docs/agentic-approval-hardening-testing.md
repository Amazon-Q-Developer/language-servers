# Agentic tool approval hardening — testing

This document records security hardening to the agentic chat tool-approval checks in
`@aws/lsp-codewhisperer`, with the safe reproduction and test steps for each change. Each
top-level section corresponds to one commit in this change.

Use only temporary directories and synthetic data. Never use a real credential file or a
command-execution payload. The regression tests create and remove their own fixtures.

The approval check and the Windows shell both read the same command string, but they interpret it
differently: `ExecuteBash.requiresAcceptance` tokenizes the command with `shlex` (POSIX rules),
while the Windows shell is `cmd.exe`, which runs the raw string. The `shlex` tokenizer treats a
backslash as an escape character and deletes it, so Windows path forms are hidden from the
token-based workspace, credential, and traversal checks. Several of the changes below close that
gap by inspecting the raw command on Windows and failing closed.

## 1. Windows drive-letter paths bypass the shell approval check

### What was wrong

`ExecuteBash.requiresAcceptance` validated the `shlex` tokens, not the raw command. On Windows a
drive path such as `type C:\Users\alice\.aws\credentials` tokenizes to the single token
`C:Usersalice.awscredentials`: the backslashes are gone, so it no longer looks absolute, it
resolves inside the working directory, and it passes the workspace and credential checks. The
command is read-only, so no approval prompt appears, while `cmd.exe` still opens the real file. A
forward-slash drive path (`C:/Users/alice/...`) and a bare drive-relative path (`C:secrets.txt`)
behave the same way. Only the unquoted form is affected; a quoted path keeps its backslashes
through `shlex` and was already checked.

### How the fix works

On Windows the check now detects a drive-letter path in the raw command, before tokenizing, and
requires approval. `hasWindowsDrivePath` matches a single drive letter followed by a colon at a
token boundary, which covers `C:\...`, `C:/...`, and the bare drive-relative `C:name`. Requiring a
token boundary keeps a URI scheme such as `https:` from being read as a drive.

The result is folded into the existing `requiresShellApproval` flag, which is evaluated at the end
of the check. The per-argument loop still runs first, so when the path is visible as a token (for
example a quoted path) the loop's more specific credential or out-of-workspace warning still takes
precedence; only the mangled forms fall through to the raw-command requirement. The change only
adds approval requirements. It never removes one, so it cannot weaken an existing prompt.

### Safe reproduction and expected results

Configure a test workspace at `C:\workspace\folder` and call `requiresAcceptance` only. Do not call
`invoke`; no command is executed.

| Command | Before | After |
| --- | --- | --- |
| `type C:\Users\alice\.aws\credentials` | no prompt | requires approval |
| `dir C:\Users\victim` | no prompt | requires approval |
| `cat C:/Users/alice/secrets.txt` | no prompt | requires approval |
| `type C:secrets.txt` (drive-relative) | no prompt | requires approval |
| `type "C:\Users\alice\secrets.txt"` (quoted) | requires approval | requires approval |
| `cat project/notes.txt` (in-workspace) | no prompt | no prompt |
| `ls -la` | no prompt | no prompt |

### Tests

`executeBash.test.ts` adds a `hasWindowsDrivePath` suite that runs on every platform. It asserts the
drive forms above are detected and that look-alikes are not flagged: a URI scheme (`https:`), a
colon after a multi-character token (`npm run test:unit`), and a `key:value` argument. A
Windows-gated end-to-end case asserts `requiresAcceptance` returns `true` for an unquoted drive
path; it skips on a non-Windows host because the platform predicate is fixed at module load, which
matches the repository's existing Windows tests.

### How to test

From `server/aws-lsp-codewhisperer`:

```sh
npx ts-mocha --timeout 0 --exit src/language-server/agenticChat/tools/executeBash.test.ts
npm run lint
```

From the repository root, check formatting with `npm run check:formatting`. Run the Windows CI job
to exercise the platform-gated end-to-end case; a Linux or macOS run does not establish Windows
behavior.
