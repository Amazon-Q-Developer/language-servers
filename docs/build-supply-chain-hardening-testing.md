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
