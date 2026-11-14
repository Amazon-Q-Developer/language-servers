# Agentic tool approval hardening — testing

This document records security hardening to the agentic chat tool-approval checks in
`@aws/lsp-codewhisperer`, with the safe reproduction and test steps for each change. Each
numbered section describes one fix in this change.

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
command is read-only, so no approval prompt appears, while `cmd.exe` still opens the real file. Only
the unquoted backslash form is affected; a quoted path keeps its backslashes through `shlex` and was
already checked.

Two other drive forms were not bypasses. A forward-slash drive path (`C:/Users/alice/...`) keeps its
slashes through `shlex`, so the token looks absolute and the workspace check already required
approval. A bare drive-relative path (`C:secrets.txt`) also stays as it is, and the check resolves
it against the current folder of drive C, where `cmd.exe` reads it. The detection below requires
approval for both forms anyway.

### How the fix works

On Windows the check now detects a drive-letter path in the raw command, before tokenizing, and
requires approval. `hasWindowsDrivePath` matches a single drive letter followed by a colon at a
token boundary, which covers `C:\...`, `C:/...`, and the bare drive-relative `C:name`. Requiring a
token boundary keeps a URI scheme such as `https:` from being read as a drive.

The result is folded into the existing `requiresShellApproval` flag, which is evaluated at the end
of the check. The per-argument loop still runs first, so when the path is visible as a token (for
example a quoted path) the loop's more specific credential or out-of-workspace warning still takes
precedence; only the mangled forms fall through to the raw-command requirement. Section 6 adds a
check, after that loop, of the words that `cmd.exe` reads, so a mangled form that names a credential
file or a path outside the workspace also gets that warning. The change only adds approval
requirements. It never removes one, so it cannot weaken an existing prompt.

### Safe reproduction and expected results

Configure a test workspace at `C:\workspace\folder` and call `requiresAcceptance` only. Do not call
`invoke`; no command is executed.

| Command | Before | After |
| --- | --- | --- |
| `type C:\Users\alice\.aws\credentials` | no prompt | requires approval |
| `dir C:\Users\victim` | no prompt | requires approval |
| `cat C:/Users/alice/secrets.txt` | requires approval | requires approval |
| `type C:secrets.txt` (drive-relative, resolves in the cwd) | no prompt | requires approval |
| `type "C:\Users\alice\secrets.txt"` (quoted) | requires approval | requires approval |
| `cat project/notes.txt` (in-workspace) | no prompt | no prompt |
| `ls -la` | no prompt | no prompt |

### Tests

`executeBash.test.ts` adds a `hasWindowsDrivePath` suite that runs on every platform. It asserts the
drive forms above are detected and that look-alikes are not flagged: a URI scheme (`https:`), a
colon after a multi-character token (`npm run test:unit`), and a `key:value` argument. The
Windows-gated suite "requiresAcceptance on Windows path forms (real filesystem)" asserts that an
unquoted drive path, and a quoted drive path to a file in the workspace, require approval. Its
workspace is a real temporary folder that is also the cwd, and its control cases (`type notes.txt`
and `type app\notes.txt`) run without approval, so a prompt in the other cases comes from the path
form. The suite skips on a non-Windows host because the platform predicate is fixed at module load,
which matches the repository's existing Windows tests.

### How to test

From `server/aws-lsp-codewhisperer`:

```sh
npx ts-mocha --timeout 0 --exit src/language-server/agenticChat/tools/executeBash.test.ts
npm run lint
```

From the repository root, check formatting with `npm run check:formatting`. Run the Windows CI job
to exercise the platform-gated end-to-end case; a Linux or macOS run does not establish Windows
behavior.

## 2. Windows UNC and environment-variable arguments

### What was wrong

At the original review snapshot, two more Windows argument forms skipped the shell approval check
through the same tokenizer gap. A UNC path `dir \\host\share` tokenized to `\hostshare`, so the UNC
test never matched and the argument was not checked, while `cmd.exe` opened the share and could
trigger outbound SMB authentication to an attacker-named host. An environment-variable argument
`type %USERPROFILE%\secrets.txt` resolved against the working directory as a literal name, stayed
inside the workspace, and ran with no prompt, while `cmd.exe` expanded it to the real file.

### How the fix works

This change does not reach the vulnerable snapshot: both forms are already blocked on this branch.
`%VAR%` is covered by the Windows expansion-character requirement (any `%` in the raw command
requires approval). UNC was blocked only incidentally, as a side effect of how a leading backslash
survives tokenization, so this change adds an explicit raw-command UNC detection
(`hasWindowsUncPath`) alongside the drive-letter detection from the previous section and folds it
into the same fail-closed requirement. The control no longer depends on a tokenizer side effect.

### Safe reproduction and expected results

Configure a test workspace at `C:\workspace\folder` and call `requiresAcceptance` only.

| Command | At original snapshot | On this branch |
| --- | --- | --- |
| `dir \\host\share` | no prompt | requires approval |
| `type %USERPROFILE%\secrets.txt` | no prompt | requires approval |
| `curl https://example.com` | (own category) | unchanged |

### Tests

`executeBash.test.ts` adds a `hasWindowsUncPath` suite that runs on every platform: it detects the
`\\host\share`, `//host/share`, quoted, and first-token forms, and does not flag a URI authority
(`https://`) or a double slash inside a token (`a//b`). The Windows-gated suite from section 1
asserts that a UNC path and a `%VAR%` argument each require approval.

### How to test

Same commands as the previous section. The Windows-gated cases require the Windows CI job.

## 3. Approved paths recorded only after approval

### What was wrong

At the original review snapshot, the chat controller recorded an approved path for every tool call
that carried a `path` or `cwd`, outside the approval branches. A read-only command that needed no
prompt (for example because its `cwd` was the workspace root) still recorded that path. A recorded
path then short-circuits the credential, binary, and workspace checks for the rest of the session,
so a path that was harmless on first use could later skip the checks after it became something the
user should be asked about.

### How the fix works

This change does not reach the vulnerable snapshot: the controller on this branch already records a
path only when the user was actually asked and approved it (`toolApprovalGranted`) and the tool then
succeeded. A rejected tool use, a failed tool use, and a command that exits with an error all record
nothing. This commit adds the regression test that pins that behavior.

### Safe reproduction and expected results

With a controller test, stub the acceptance check so a read-only `executeBash` call returns
`requiresAcceptance: false`, run it to success, and inspect the session.

- At the original snapshot: the working directory is recorded in `approvedPaths`.
- On this branch: `addApprovedPath` is not called and `approvedPaths` stays empty.

### Tests

`agenticChatController.test.ts` adds a case to the executeBash approval-recording suite: a read-only
command that needs no approval records nothing, asserted by both `addApprovedPath` not being called
and `approvedPaths.size` remaining zero. It sits beside the existing cases that already cover record
after approval, no record on rejection, no record on failure, and no record on a non-zero exit. This
case is platform-independent and runs on every host.

### How to test

From `server/aws-lsp-codewhisperer`:

```sh
npx ts-mocha --timeout 0 --exit --grep "working directory" \
  src/language-server/agenticChat/agenticChatController.test.ts
```

## 4. Windows root-relative backslash paths (dropping the drive letter)

### What was wrong

The drive-letter detection in section 1 is defeated by dropping the drive letter. A root-relative
path `type \Users\alice\.aws\credentials` has no drive letter, no UNC prefix, and no `\..`
sequence, and shlex deletes its single leading backslash, so it collapses to `Usersalice...`, which
resolves inside the working directory and runs with no approval prompt, while `cmd.exe` reads the
path from the root of the working directory's drive — the same unprompted credential read as a full
drive path, two characters shorter.

### How the fix works

A third detector, `hasWindowsRootedPath`, matches a backslash at a token boundary and is folded into
the same fail-closed requirement, so a path that begins with a backslash (including the UNC form, a
superset) requires approval. It matches only a leading backslash. A path with a backslash later in a
word, such as `sub\file`, is relative to the working directory, but it can still name a credential
file or pass through a junction to a folder outside the workspace; section 6 checks it as `cmd.exe`
reads it. A `..\` traversal is left to the existing traversal checks. The `\..` pre-check catches a
multi-segment `..\..\` traversal, because its second segment contains a literal `\..`. A single-hop
`..\name` from the workspace root also requires approval. shlex deletes the backslash, so the token
check sees `..name` and counts it as outside the workspace because its relative path starts with
`..`. The word check of section 6 also reads `..\name` as a path in the parent folder, so the result
does not depend only on that token.

### Safe reproduction and expected results

Configure a test workspace at `C:\workspace\folder` and call `requiresAcceptance` only.

| Command | Before | After |
| --- | --- | --- |
| `type \Users\alice\.aws\credentials` | no prompt | requires approval |
| `dir \Windows\System32` | no prompt | requires approval |
| `type ..\secret.txt` (from the workspace root) | requires approval | requires approval |
| `cat sub\notes.txt` (in-workspace) | no prompt | no prompt |

### Tests

`executeBash.test.ts` adds a `hasWindowsRootedPath` suite that runs on every platform: it detects
the leading-backslash and UNC forms and does not flag a mid-token backslash (`sub\file`), a `..\`
traversal, or a forward-slash path. The Windows-gated suite from section 1 asserts that a
leading-backslash path requires approval, and that `type ..\notes.txt` from the workspace root
requires approval with the out-of-workspace warning.

### How to test

Same commands as section 1. The Windows-gated case requires the Windows CI job.

## 5. Hidden characters in the command of a shell card

### What was wrong

The approval card of `executeBash`, and the card that shows the command while and after it runs,
showed the command as the model sent it. A command can hold characters that the card does not show
as they are: bidirectional overrides and isolates (U+202A–U+202E, U+2066–U+2069) change the order in
which the text appears, zero-width characters and tag characters (U+E0000–U+E007F) do not appear at
all, and a carriage return or a line separator can split one line of the command into two lines on
screen. So the user could approve a command that looked different from the command that runs.

### How the fix works

`shellCommandBlockStart` in `agenticChat/textFormatting.ts`, which every shell card uses (also through
`shellCommandBlock`), now shows each of these characters as an escape: `\uXXXX`, or `\u{XXXXX}` above
U+FFFF. It escapes control characters other than line feeds and tabs, format characters, line and
paragraph separators, spaces other than U+0020, and the other default ignorable characters. Only the
shown copy changes; the command that runs is the original. An escape has no backticks, so the code
fence of the shown command is the fence of the original command, and the fence that closes the output
of a running command still matches.

A command that contains text such as `\u202E` as written looks the same in the card as a command with
that character. A variation selector after an emoji and a zero-width joiner in an emoji sequence are
shown as escapes too.

### Safe reproduction and expected results

The Before and After columns show the text of the code block in the card. Do not run these commands.

| Command | Before | After |
| --- | --- | --- |
| `echo safe <U+202E># ~ fr- mr` | `echo safe ` followed by `rm -rf ~ #` in right-to-left order | `echo safe \u202E# ~ fr- mr` |
| `cat <U+200B>notes.txt` | `cat notes.txt` | `cat \u200Bnotes.txt` |
| `echo a<CR>rm -rf b` | `echo a` and `rm -rf b` on two lines | `echo a\u000Drm -rf b` |
| `ls -la` | `ls -la` | `ls -la` |

### Tests

`textFormatting.test.ts` adds three cases to the "shell command blocks" suite: hidden characters of
each kind become escapes in `shellCommandBlock` and `shellCommandBlockStart`; line feeds, tabs,
spaces, shell syntax and visible non-ASCII text stay as they are; and the fence of the shown command
equals the fence of the original command when hidden characters sit next to backticks.
`agenticChatController.test.ts` adds a case to "shell command cards": the approval card shows the
escapes, and the tool runs with the original command.

### How to test

From `server/aws-lsp-codewhisperer`:

```sh
npx ts-mocha --timeout 0 --exit -g "shell command" \
  src/language-server/agenticChat/textFormatting.test.ts \
  src/language-server/agenticChat/agenticChatController.test.ts
```

To see it in the IDE, ask the agent to run `echo` with a right-to-left override in its argument, for
example by pasting the text from the first row of the table into the prompt. Look at the approval
card, then choose **Reject**.

## 6. Windows paths with a backslash inside a word

### What was wrong

Sections 1, 2, and 4 handle a backslash at the start of a path. shlex still deleted a backslash
inside a word, so the path checks saw a different path than `cmd.exe` opens. `type app\.env` reached
the checks as the token `app.env`, a name in the working directory that does not exist, so the
credential check did not run and the command ran with no prompt, while `cmd.exe` read `app\.env`.
In the same way, `type link\data.txt`, where `link` is a junction to a folder outside the
workspace, reached the checks as `linkdata.txt` inside the workspace, while `cmd.exe` followed the
junction. A junction needs no privilege on Windows. `cmd.exe` also splits the arguments of a
built-in command such as `type` at a comma or an equals sign, and shlex does not, so
`type notes.txt,.env` hid `.env` in the token `notes.txt,.env`.

The code comment of `hasWindowsRootedPath` and section 4 said that a path with a backslash inside a
word stays inside the workspace.

### How the fix works

On Windows, `requiresAcceptance` also splits the raw command into the words that `cmd.exe` gives to a
built-in command (`windowsCommandWords`). Whitespace, a comma, or an equals sign outside double quotes
ends a word, the double quotes are removed, and a backslash stays in its word. After the loop over
the shlex tokens, each word that is not also a token goes through the same path checks as a token:
credential file, binary file, hard link, approved path, and workspace boundary. One method,
`pathArgumentApproval`, now does these checks for tokens and words. A double quote that is not closed
requires approval. The word check only adds approval requirements.

A UNC or device path outside the workspace is not checked on disk. A file system call on a UNC path
makes Windows connect to the host that the path names, which can send the user's credentials to
that host before the user approves the command. On Windows, a token or word that resolves to a path
that starts with two slashes or backslashes (`\\host\share`, `//host/share`, `\\?\...`) and is not
in a workspace folder (`isRemoteWindowsPath`) now requires approval with the out-of-workspace
warning, with no file system call. A path in a workspace folder on a share is still checked on
disk, because the IDE already uses that host. Before this change, a token such as `//host/share`
was checked on disk; without this guard, the word check would also check `\\host\share` on disk.

### Safe reproduction and expected results

On Windows, create a temporary workspace that contains `notes.txt`, `.env`, `app\notes.txt`,
`app\.env`, and a junction `link` to a temporary folder outside the workspace that contains
`data.txt` (`mklink /J link <folder>`). Use the workspace as the cwd and call `requiresAcceptance`
only. Do not call `invoke`.

| Command | Before | After |
| --- | --- | --- |
| `type app\.env` | no prompt | requires approval (credential warning) |
| `type link\data.txt` | no prompt | requires approval (out-of-workspace warning) |
| `type notes.txt,.env` | no prompt | requires approval (credential warning) |
| `type //host.invalid/share/data.txt` | requires approval, after a file system call on the UNC path | requires approval, with no file system call |
| `type app\notes.txt` | no prompt | no prompt |

### Tests

`executeBash.test.ts` adds a `windowsCommandWords` suite that runs on every platform: a backslash
stays in its word, a comma and an equals sign split words, double quotes keep a space in a word and
are removed, a single quote is an ordinary character, and a double quote that is not closed returns
`undefined`. An `isRemoteWindowsPath` suite also runs on every platform, with Windows path rules: UNC,
forward-slash UNC, and device paths are remote, a drive path is not, and a path in a workspace folder
on a share is not remote unless it leaves that folder or names another host. The Windows-gated suite
from section 1 adds cases for the credential file `app\.env`, the junction `link\data.txt`,
`notes.txt,.env`, and two UNC forms. The UNC case also asserts that no file system call gets a path
that starts with two slashes or backslashes. The control case `type app\notes.txt` still runs
without approval.

### How to test

Same commands as section 1. The Windows-gated cases require the Windows CI job; a Linux or macOS
run checks only `windowsCommandWords`.

### Not covered

- An external program, such as `cat.exe` from Git for Windows, splits its own command line with
  rules that are not the same as those of a built-in command. The word check uses the rules of a
  built-in command, in addition to the shlex tokens.
- A path on a share outside the workspace requires approval each time, also when the user approved
  its folder before, because the approved-path check needs the canonical path from disk.

## 7. A UNC working directory

### What was wrong

The model also sends the `cwd` of a command. `requiresAcceptance` resolves the cwd on disk before it
checks the command, to find out if the cwd is in the workspace, and it resolves relative path
arguments against the cwd. On Windows, a cwd such as `\\host\share` or `//host/share` therefore made
Windows connect to that host while the check ran, before the user approved the command. Section 6
stops a file system call on a UNC path argument; it does not cover the cwd.

### How the fix works

On Windows, before any file system call on the cwd, `requiresAcceptance` checks the cwd with
`isRemoteWindowsPath` (section 6). A UNC or device cwd that is not in a workspace folder requires
approval with the out-of-workspace warning, and the result has no `approvalPaths`, so an approval
does not allow that cwd for later commands. A cwd in a workspace folder on a share is still checked
as before.

### Safe reproduction and expected results

On Windows, use a temporary workspace that contains `notes.txt`, and call `requiresAcceptance` only.
Use `host.invalid`, a name that does not resolve.

| Command | cwd | Before | After |
| --- | --- | --- | --- |
| `type notes.txt` | `\\host.invalid\share` | requires approval, after a file system call on the cwd | requires approval, with no file system call |
| `type notes.txt` | `//host.invalid/share` | requires approval, after a file system call on the cwd | requires approval, with no file system call |
| `type notes.txt` | the workspace | no prompt | no prompt |

### Tests

The Windows-gated suite from section 1 adds a case that runs `type notes.txt` with each UNC cwd above.
It asserts that each requires approval with the out-of-workspace warning and no `approvalPaths`, and
that no file system call gets a path that starts with two slashes or backslashes.

### How to test

Same commands as section 1. The Windows-gated case requires the Windows CI job.
