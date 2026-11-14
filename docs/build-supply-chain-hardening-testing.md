# Build supply chain hardening — testing

This document describes changes to how the server bundles and the PartiQL parser binary are built,
and how to check them. Each numbered section describes one change.

## 1. Windows registry.node in every server bundle

### Behavior

`npm run ci:generate:agent-standalone` in `app/aws-lsp-codewhisperer-runtimes` builds the agent
bundle in `build/private/bundle/agent-standalone`, and `scripts/package.sh` zips that folder into
the `servers.zip` of every platform. The step `copy:native-deps:agent-standalone` copied
`_bundle-assets/registry-js/win32-x64/registry.node`, a prebuilt Windows binary of
[registry-js](https://github.com/desktop/registry-js) with no recorded checksum, into that folder.
So the Linux and macOS archives shipped a Windows native library too. The `servers.zip` of the
1.86.0 release for Linux x64 contains `registry.node` (696,320 bytes).

Nothing loads that file:

- `@aws/language-server-runtimes` 0.3.15 removed `registry-js` from the dependency tree (commit
  `15d5340d7`, #2649). The runtimes now read the Windows proxy settings with `reg query`
  (`runtimes/util/standalone/getProxySettings/getWindowsProxySettings.js`).
- No `.js`, `.cjs` or `.mjs` file in `node_modules`, and no source file of this repository, refers
  to `registry.node` or `registry-js`.
- `aws-lsp-codewhisperer.js` in the 1.86.0 `servers.zip` for Linux x64 does not contain the text
  `registry.node`. It loads the Windows proxy settings with `spawnSync("reg", ["query", ...])`.

The change removes the binary, the `copy:native-deps:agent-standalone` script and its use in
`ci:generate:agent-standalone`, and the section about the binary in the README of the package.

Not covered: the bundle still contains `crypt32-ia32.node` and `crypt32-x64.node` on every platform.
webpack emits them because `win-ca` 3.5.1, which the runtimes use on Windows, loads them; unlike
`registry.node`, they are in use, and `package-lock.json` pins `win-ca` with an integrity hash. This
document does not record the source of the `qserver` and `ripgrep` archives in `_bundle-assets`.

### How to test

1. Check that nothing refers to the file. The search excludes this document, which names the file:

   ```sh
   git grep -n -e "registry\.node" -e "registry-js" -e "native-deps" -- ':!package-lock.json' \
     ':!docs/build-supply-chain-hardening-testing.md'
   ```

   Expected: no output.

2. Build the archives, as the release does, from `app/aws-lsp-codewhisperer-runtimes`:

   ```sh
   npm run ci:generate:agent-standalone
   for zip in build/archives/agent-standalone/*/servers.zip; do
     echo "$zip: $(unzip -l "$zip" | grep -c 'registry\.node')"
   done
   ```

   Before: each archive lists `registry.node` once. After: each count is 0.

3. On Windows behind a proxy that is set in the Windows settings, start the IDE with the new
   `servers.zip` and send a chat message. The language server log shows that it read the proxy
   settings, as it does with the current release.

## 2. Pinned source for the PartiQL parser binary

### Behavior

`server/aws-lsp-partiql/src/partiql-parser-wasm/partiql-wasm-parser-inline.ts` holds the PartiQL parser
as a WebAssembly binary in base64 (3,509,655 bytes after decoding). `npm run update-parser-binary`
regenerated it, and the bindings next to it, in a Docker image. That build had nothing pinned: it used
the `amazonlinux:2023` tag, installed `zx`, `tsx` and `wasm-pack` at their latest versions, piped the
rustup installer from `https://sh.rustup.rs` to `sh`, and cloned the default branch of
[partiql-rust-playground](https://github.com/partiql/partiql-rust-playground), which had no lock file.
Nothing recorded which source or toolchain produced the committed binary.

After this change:

- `build-scripts/compile-inline-partiql-wasm.mts` downloads one release archive of the playground,
  `partiql-playground-web-0.3.0.tar.gz`, and checks it against the SHA-256 in the script
  (`0aedd0df190d218aac9e10469daceea17ef7330dae44ddcd933b1c368205fee8`, the same value as the `.sha256`
  file of the release) before it uses any file in it. Its `build-info.json` names commit
  `82932c481d34ffb3a41e0c94dec7ca52849bef20`, PartiQL 0.15.0, wasm-bindgen 0.2.129 and wasm-pack 0.15.0.
  The playground builds that archive with a pinned toolchain and `Cargo.lock`, so it can be rebuilt from
  source to check it. The SHA-256 in the script comes from the same release as the archive: it stops a
  later change of the archive, but it does not show that the release was built from that commit. The
  archive was not rebuilt from source for this change.
- The script writes the binary and the bindings as before, and also writes the SHA-256 of the binary
  to `partiql_playground_bg.wasm.sha256` in the same folder. The Docker files are removed.
- `partiql_playground_bg.wasm.sha256` records the SHA-256 of the binary that is committed now:
  `4240735401c2a725d16038283b148b1bbe3c5acfe6cd2e6284b1ce519e453456`. A new test,
  `partiql-wasm-parser-inline.test.ts`, checks that the committed binary matches it, so a change to
  the binary also changes that file in the same diff.
- The README of the folder records where the committed binary most likely comes from: its `producers`
  section names rustc 1.78.0 and wasm-bindgen 0.2.92, and the `main` branch of the playground was at
  commit `abdc1638c4feb4c1b71cfa29cce3aea6a7985725` (version 0.2.0) from 2024-01-23 until after the
  binary was added on 2024-05-24. It was not rebuilt to confirm this.
- The committed binary and bindings are unchanged.

Not covered:

- An update to release 0.3.0 changes the parser. With the binary and bindings that the script writes
  from 0.3.0, two tests of `src/server/language-service.test.ts` fail ("should correctly parse errors
  for UnexpectedEndOfInput" and "... UnterminatedIonLiteral"). The update itself, and the changes that
  it needs, are left for a separate change.
- `src/tree-sitter-wasm/tree-sitter-partiql.wasm`, which `build-scripts/compile-inline-tree-sitter-parser-wasm.mts`
  inlines, also has no recorded source or checksum.
- The CI job on Linux runs `npm run test:coverage`, which this package does not define, so the checksum
  test runs only in the Windows CI job, which runs `npm run test`.

### How to test

From `server/aws-lsp-partiql`:

```sh
npx jest src/partiql-parser-wasm
```

Expected: both tests pass. Change one character of `partiql_playground_bg.wasm.sha256`, and the test
"matches the SHA-256 that is recorded next to it" fails.

To check the script without changing this repository, copy `server/aws-lsp-partiql` to a scratch folder
next to a `node_modules` folder of this repository, and run `npm run update-parser-binary` there. It
prints the SHA-256 of the new binary (`e91c4a6c9a928c505e204c7ac6bbb5f4b152bff61c52283a5c2f30165518dd08`
for 0.3.0) and writes the same value to the checksum file, so the test above passes in the copy. To
see the check of the archive fail, change one character of `PLAYGROUND_ARCHIVE_SHA256` in the copy; the
script then stops before it writes any file.
