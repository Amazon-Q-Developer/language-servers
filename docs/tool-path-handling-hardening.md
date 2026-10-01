# Tool path handling

This document explains changes to Git execution, path approval, and CodeReview artifact-boundary enforcement in `@aws/lsp-codewhisperer`.

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

### CodeReview artifact boundary

The CodeReview tool zips the file, folder, and rule artifact paths it is given and uploads them for analysis, and it runs Git on each path.
It did not confirm that these paths were inside an open workspace folder.
A path supplied by the model, by a configured rule file, or by a crafted context could point anywhere on disk, including through an in-workspace symlink whose target is outside the workspace.
The tool could therefore read an out-of-workspace file and upload its contents, or run Git in an out-of-workspace directory.
Unlike the file-read and file-write tools, CodeReview does not go through the shared path-approval prompt, so nothing gated these paths.

The folder walk added each discovered file by joining the directory entry's reported parent path with its name, and it did not re-check discovered files.
A regular file with more than one hard link was also not detected. Its other name may be outside the workspace, so reading it exposes data shared with that name.

For a code-diff review, the tool asked Git for the diff of the whole submitted folder path, after the zip walk had already skipped dotfiles and non-allowlisted files.
Git still reported the changed content of those skipped files, so their diff text was added to the uploaded `codeDiff` even though their file content was never zipped.
A file artifact that the extension or dotfile filter skipped was also still handed to Git, so its diff text was uploaded the same way.

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

### CodeReview artifact validation

CodeReview now validates every submitted artifact before it reads any content or runs any Git command.
The check runs inside artifact preparation, which completes before the upload URL is created, before the upload request, and before analysis starts.
A single violation aborts the whole request, and nothing is uploaded.

For each path in `fileLevelArtifacts`, `folderLevelArtifacts`, and `ruleArtifacts`, the tool requires all of the following:

- The path is absolute. A relative path or a leading `~` is rejected. The tilde is not expanded.
- The path resolves on disk with a strict `fs.promises.realpath`. A missing, dangling, or cyclic path is rejected. The tool does not fall back to a lexical resolve.
- A strict `fs.promises.stat` succeeds and reports the expected type: a regular file for file and rule artifacts, a directory for folder artifacts.
- A regular file has a single hard link. A file with more than one link is rejected, because its other names may be outside the workspace. Directories are not rejected for their link count, which is normally above one.
- The canonical path is inside a canonical workspace root. Each workspace root is resolved with the same strict `fs.promises.realpath` and then strictly stat'd; a root that cannot be resolved, or that does not resolve to a directory, is dropped rather than kept as a lexical path. If no workspace folder is open, or none resolves to a directory, the request is rejected.

The validated canonical paths are then used for the content reads and the Git calls, so the check and the use derive the same location.
Immediately before each read, the stored canonical path is re-resolved with a strict `fs.promises.realpath`, the resolved path is re-checked (regular file, single link, inside the workspace), and that same resolved path is used for the read and the Git call.
The path as submitted is kept only to preserve the caller's intended file name and the existing extension allowlist decision, so a symlink whose name is inside the workspace cannot broaden or narrow that filter through canonical renaming.

The Git diff for a code-diff review is derived only from the files that were actually read into the customer-code zip.
A file artifact that the dotfile or extension filter skips is not read and is not passed to Git, so its diff text cannot reach the upload.
For a folder artifact, the walk records each file it reads, and the tool then runs Git per recorded file. There is no whole-folder Git request, so a skipped dotfile or non-allowlisted file inside the folder cannot contribute diff text to the uploaded `codeDiff`.

The folder walk builds each child path from the canonical directory it is scanning, not from the directory entry's reported parent path.
Every discovered file is resolved and re-checked (regular file, single link, inside the workspace) immediately before it is read, and the resolved path is what the read and the per-file Git call use.
Each subdirectory is confirmed to stay inside the workspace before the walk descends into it.
Symlink entries are skipped, as before, so the walk never follows a link out of the workspace. A skipped entry is never read and never passed to Git.
A discovered file that cannot be resolved, is multiply linked, or resolves outside the workspace aborts the whole request. Some earlier in-workspace files may already have been read locally, but the rejected path is never read and nothing is uploaded.

These checks fail closed. A boundary violation throws and aborts the request before any upload.

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

### CodeReview artifact boundary

Use only temporary directories and synthetic data. Do not use real credential files or command-execution payloads.
The regression tests create and remove their own fixtures under the system temporary directory.

Create sibling temporary directories, one used as the workspace and one outside it, with synthetic files in each.
Then, without any network access:

1. Call the artifact preparation step with a file, folder, or rule path that is relative, tilde-prefixed, missing, outside the workspace, a wrong type (a directory as a file or a file as a folder), a dangling symlink, a cyclic symlink, an in-workspace symlink whose target is outside, or a regular file with a second hard link. Each case rejects before any file is read and before any Git command runs. Preparation does not reach the upload, so these cases assert only that no read and no Git call occurred.
2. Submit a batch that mixes a valid in-workspace file with an out-of-workspace file. The request fails before any content is read.
3. Submit valid in-workspace files, a folder, and a rule. Inspect the prepared archive through the existing preparation methods and confirm the expected entries are present, that an in-workspace symlink keeps its submitted name while its content comes from the resolved target, that a non-allowlisted extension is still skipped, and that a multi-root workspace and a symlinked workspace are accepted.
4. Point a folder artifact at a directory that contains a symlink out of the workspace and a multiply-linked file. The symlink entry is skipped. The multiply-linked or out-of-workspace file aborts the request without an upload, and the rejected path is never read.
5. Run the full tool through `execute` with a spy on upload-URL creation, the upload, and analysis start. Give it a file, a folder, or a rule that is outside the workspace, a batch that mixes a valid file with a bad folder or a bad rule, or a folder whose walk finds a hard-linked file. Each case rejects, and none of the three spies is called. A test whose name claims "before upload" runs this full flow, not the preparation step alone.
6. Initialize a real temporary Git repository whose worktree is the workspace, using `execFile('git', argv)` with a fixed argument vector and no shell. Commit an allowlisted file, a non-allowlisted file, and a dotfile, then modify all three with distinct benign marker strings. Run a `CODE_DIFF_REVIEW` on the containing folder and read the prepared diff entry. The allowlisted file's marker is present, and the skipped dotfile's and non-allowlisted file's markers are absent. Git is not stubbed, so a fix that merely disabled Git would fail the present-marker assertion.

Symlink and hard-link cases skip when the host or user cannot create the required links. The Git regression skips when `git` is unavailable.
Expectations are compared through the same `fs.promises.realpath` the guard uses, so a Windows 8.3 short name does not cause a spurious mismatch.

## How to test

Install the repository's locked dependencies using the contributor setup instructions.
From `server/aws-lsp-codewhisperer`, run the package build and focused suites:

```sh
npm run compile
npx ts-mocha --timeout 0 \
  src/language-server/agenticChat/tools/qCodeAnalysis/codeReview.test.ts \
  src/language-server/agenticChat/tools/qCodeAnalysis/codeReviewArtifactBoundary.test.ts \
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
- grepSearch remains disabled. This patch does not enable it.
- CodeReview now rejects a file, folder, or rule artifact that is missing, unresolvable, the wrong type, multiply linked, or outside the open workspace, rather than skipping it. A configured external rule file that lives outside the workspace is therefore rejected; place rule files inside the workspace to keep them in a review. This is a deliberate compatibility change.
- The code-diff for a folder is now derived per file from the files the walk actually read, not from a single Git request over the whole folder. A change to a file the walk skipped (a dotfile, a non-allowlisted extension, a skipped directory, a symlink entry) no longer appears in the uploaded diff, and a deleted or otherwise unreadable file cannot contribute a diff, because only files that were read are queried. This narrows the diff to the reviewed content and is a deliberate behavior change, not an unchanged-semantics refactor.
- The CodeReview change adds no approval prompt or UI, and it does not change the controller or the shared file-tool path helpers. Model-supplied and configuration-supplied artifacts are all gated by the same in-tool validation.
- The CodeReview artifact checks describe the state at validation time and are repeated immediately before each read to narrow, not eliminate, the window between the check and the read. This patch does not claim complete filesystem race immunity and does not rewrite the reads to use file descriptors.
