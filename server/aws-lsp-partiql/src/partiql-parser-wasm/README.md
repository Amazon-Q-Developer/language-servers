# PartiQL Parser WASM

This folder contains the binary encoded as a base64 string, and bindings for the WASM compiled verion of the Rust PartiQL parser: https://github.com/partiql/partiql-lang-rust

Bindings and binary are generated from: https://github.com/partiql/partiql-rust-playground

The binary and the bindings in this folder are older than the release that `build-scripts/compile-inline-partiql-wasm.mts` names. They were added with the server in May 2024 (#257), and the script has not replaced them yet. The next update replaces them with the files of that release.

The server does not use this binary at runtime: `src/server/language-service.ts` parses with ANTLR and keeps the WASM parser import commented out until [partiql/partiql-lang-rust#472](https://github.com/partiql/partiql-lang-rust/issues/472) is resolved. The binary stays so the parser path can be turned back on without regenerating it, so `npm run compile` still writes the no-op `partiql_playground_bg.wasm` that the Webpack import check needs.

`partiql_playground_bg.wasm.sha256` holds the SHA-256 of the binary in `partiql-wasm-parser-inline.ts`, and `partiql-wasm-parser-inline.test.ts` checks that the binary matches it. A change to the binary therefore also changes that file.

Binary and bindings can be updated by running `npm run update-parser-binary`. The script `build-scripts/compile-inline-partiql-wasm.mts` downloads the release archive of the playground that it names, checks the archive against the SHA-256 in the script before it uses any file in it, and then writes the binary, the bindings and the checksum file. To use another release, change the version and the SHA-256 in the script. Review the bindings and run the tests of this package after an update.

After an update, also:

- Run `npm run format` from the root of the repository. The script does not write the files in the format of the repository, and the CI checks the format.
- Check the license files of the release. The script copies the text of `LICENSE` and `NOTICE` into the header of `partiql-wasm-parser-inline.ts`, and copies `THIRD_PARTY_LICENSES.txt` into this folder when the release has one (the 0.3.0 archive does), so the attribution of the crates compiled into the binary is versioned next to it.
