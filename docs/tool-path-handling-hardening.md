# Tool path handling

This document explains changes to Git execution and path approval in `@aws/lsp-codewhisperer`.

## What was wrong

### CodeReview Git arguments

`CodeReviewUtils` constructed shell command strings from artifact paths. It passed these strings to `child_process.exec`.
A shell could interpret spaces and special characters as command syntax instead of filename characters.
Both the working directory and the Git path argument came from the artifact path.

### executeBash path approval

`ExecuteBash.requiresAcceptance` checked paths without following symlinks. A link inside the workspace could point outside it and pass the boundary check.
The working-directory check had the same problem.

The path detector also omitted bare relative names such as `notes.txt` and `sub/notes.txt`.
These arguments skipped the path checks even when they referred to symlinks.
Credential-name checks examined only the link name and not its target name.

### grepSearch path approval

`GrepSearch.requiresAcceptance` also used a lexical boundary check.
The tool is currently disabled. Its check must still be correct before the tool is enabled.

## How the fix works

### Git execution

Git now runs with `execFile('git', args, { cwd })`. No shell parses the paths.
All four staged, unstaged, diff, and name-only calls use this form.

Each artifact path follows `--` and has the Git pathspec prefix `:(literal)`.
The separator prevents option or revision interpretation. The prefix prevents wildcard and pathspec-magic interpretation.

```typescript
execFile('git', ['diff', '--name-only', '--', `:(literal)${artifactPath}`], { cwd: directoryPath }, callback)
```

Staged and unstaged results still combine as before. Git command failures still produce an empty result and a warning.

### Path approval

executeBash resolves argument paths and the working directory through `resolveSymlinkAwarePath`.
It canonicalizes workspace folders before comparing boundaries.
It checks canonical paths against prior approvals.
It applies the credential and executable-file heuristics to both the argument name and the canonical target name.
A link named like a credential or an executable that points to an ordinary file still raises the matching warning.

The additional relative-path detector requires a working directory and excludes flag-like tokens.
It recognizes an argument when the argument contains a separator, has an extension, or names an existing filesystem entry.
It uses `lstat` for the existence check, so dangling symlinks count as entries.

An ordinary file inside the workspace remains allowed. A link to an outside target requires approval.
The existing command-category checks still require approval for mutation and destructive commands.

grepSearch now uses `requiresPathAcceptance`, the shared helper used by the file tools.
This includes symlink-aware boundaries and sensitive-location warnings.

## Safe reproduction and expected results

Use only temporary directories and synthetic data. Do not use real credential files or command-execution payloads.
The regression tests below create and remove their own fixtures.

### Git path handling

The real-repository tests create a temporary repository with an inert filename, `note;echo.txt`.
They modify that file and call both `getGitDiffNames` and `getGitDiff`.

Before the fix, a shell splits the filename at the semicolon. The requested file is not selected correctly.
After the fix, the name-only result contains `note;echo.txt`, and the diff contains that file's change.
The tests never execute the old shell command or a payload.

A second test modifies `star*.txt` and `starXYZ.txt`.
A request for `star*.txt` must return only that literal filename.
Windows cannot create a filename containing `*`, so this real-filesystem test skips there.
Argument-construction tests still check literal pathspecs on every platform.

### Symlink path approval

To inspect the defect without running a shell command:

1. Create temporary sibling directories named `workspace` and `outside`.
2. Create `outside/data.txt` with synthetic text.
3. Create `workspace/notes.txt` as a symlink to `outside/data.txt`.
4. Configure the test workspace to use `workspace`.
5. Call `requiresAcceptance` with `command: 'cat notes.txt'` and `cwd` set to `workspace`.
6. Inspect the returned approval decision. Do not call `invoke`.

Before the fix, the bare name skips the path checks. After the fix, the decision requires approval with an outside-workspace warning.
The tests also cover a nested relative path, an extensionless link, and a dangling link to an outside target.

For the working-directory case, create a directory symlink inside `workspace` that points to `outside`.
Call `requiresAcceptance` with `command: 'ls'` and that link as `cwd`.
The fixed check requires approval without executing `ls`.

For the credential-name case, link `workspace/notes.txt` to a synthetic `workspace/credentials.txt` fixture.
The fixed check requires approval based on the target name.
A reverse case also applies: a link named `workspace/.env` that points to an ordinary in-workspace file requires approval based on the link name.
Control tests confirm that ordinary files and links whose targets remain inside the workspace are allowed.

The grepSearch tests check direct outside paths, an outside-target symlink, and allowed workspace paths.
Symlink tests skip when the host cannot create the required links.

## How to test

Install the repository's locked dependencies using the contributor setup instructions.
From `server/aws-lsp-codewhisperer`, run the package build and focused suites:

```sh
npm run compile
npx ts-mocha --timeout 0 \
  src/language-server/agenticChat/tools/qCodeAnalysis/codeReviewUtils.test.ts \
  src/language-server/agenticChat/tools/executeBash.test.ts \
  src/language-server/agenticChat/tools/grepSearch.test.ts \
  src/language-server/agenticChat/tools/toolShared.test.ts \
  src/language-server/agenticChat/tools/symlinkBoundary.test.ts \
  src/language-server/agenticChat/tools/fsRead.test.ts
npm run lint
```

From the repository root, check formatting with `npm run check:formatting`.
For the complete package unit suite, run `npm run test:unit` from `server/aws-lsp-codewhisperer`.
Run platform CI before merging. A Linux run does not establish Windows or macOS behavior.

## Scope and limitations

- The tool schema requires `cwd`, but the TypeScript interface permits its omission. Bare relative arguments without `cwd` retain their previous behavior.
- Nonexistent names without separators or extensions are treated as text. Flag-like tokens are not handled as bare relative paths.
- The shell parser and command classification are unchanged. This patch does not claim complete validation of shell expansion or command-specific option syntax.
- Filesystem checks describe the state at approval time. They do not prevent a path from changing before execution.
- Existing shared-helper fallback behavior, hard-link handling, and approval recording are outside this patch.
- Credential and executable-file checks remain heuristics, not content inspection.
- Git paths outside the repository still produce an empty result when Git reports an error.
- grepSearch remains disabled. This patch does not enable it or change CodeReview's approval flow.
