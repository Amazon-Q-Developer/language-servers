# PartiQL Parser WASM

This folder contains the binary encoded as a base64 string, and bindings for the WASM compiled verion of the Rust PartiQL parser: https://github.com/partiql/partiql-lang-rust

Bindings and binary are generated from: https://github.com/partiql/partiql-rust-playground

`partiql_playground_bg.wasm.sha256` holds the SHA-256 of the binary in `partiql-wasm-parser-inline.ts`, and `partiql-wasm-parser-inline.test.ts` checks that the binary matches it. A change to the binary therefore also changes that file.

The binary in this folder was added on 2024-05-24 (#257). Its `producers` section names rustc 1.78.0 and wasm-bindgen 0.2.92. The playground then had no lock file, and its `main` branch was at commit `abdc1638c4feb4c1b71cfa29cce3aea6a7985725` (version 0.2.0) from 2024-01-23 until after that date, so that commit is most likely the source of the binary. The binary was not rebuilt to confirm this.

Binary and bindings can be updated by running `npm run update-parser-binary`. The script `build-scripts/compile-inline-partiql-wasm.mts` downloads the release archive of the playground that it names, checks the archive against the SHA-256 in the script before it uses any file in it, and then writes the binary, the bindings and the checksum file. To use another release, change the version and the SHA-256 in the script. Review the bindings and run the tests of this package after an update.

After an update, also:

- Run `npm run format` from the root of the repository. The script does not write the files in the format of the repository, and the CI checks the format.
- Check the license files of the release. The script copies the text of `LICENSE` and `NOTICE` into the header of `partiql-wasm-parser-inline.ts`. The 0.3.0 archive also has `THIRD_PARTY_LICENSES.txt`, which the script does not copy.
