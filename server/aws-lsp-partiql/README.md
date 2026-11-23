# PartiQL LSP server

LSP server for the [PartiQL language](https://partiql.org/). This server offers diagnostics for PartiQL files by parsing the file using the [Rust parser maintained by the PartiQL team](https://github.com/partiql/partiql-lang-rust).

This parser is compiled to a WebAssembly binary using the bindings maintained by the PartiQL team in the [PartiQL playground package](https://github.com/partiql/partiql-rust-playground). This binary is further encoded as a base64 string in a Javascript file to make it easy to be bundled together with the other assets of the server.

### Updating the binary

To update the binary used by the server, run `npm run update-parser-binary`. The script `build-scripts/compile-inline-partiql-wasm.mts` downloads the release archive of the PartiQL playground that it names, checks the archive against the SHA-256 in the script, and writes the binary encoded into base64 in a TypeScript file, the bindings, and the SHA-256 of the binary to the `src/partiql-parser-wasm` folder. See [the README of that folder](src/partiql-parser-wasm/README.md). Running `npm run compile` will then transpile the binary file to JavaScript and place it in the `out` folder.

To update the binary used in package `web-tree-sitter`, run `npm run update-treesitter-wasm`. This update is forced to make everytime upgrading the version of `web-tree-sitter`. This will compile the `tree-sitter.wasm` file inside the package into a base64 string in a TypeScript file to the `src/tree-sitter-parser` folder as `tree-sitter-inline.ts`. 

### Updating the ANTLR lexer and parser

The ANTLR lexer and parser grammars are defined in `src/antlr-grammar`, the files in `src/antlr-generated` are automatically generated from the grammar files. To 
update these files, run `npm run update-antlr`. The current grammar files can be found at https://github.com/partiql/partiql-lang-kotlin/tree/main/partiql-parser/src/main/antlr.

### Tests

Tests for this package are run using [Jest](https://jestjs.io/), to run the tests in this package run `-npm run test`. 

### Potential improvements

This package currently has a couple of potential points-of-improvement:

- In the bindings for the parser WASM binary, there is a code path which imports the `partiql_playground_bg.wasm` file. We don't use this file and code path at runtime due to the inlining of the WASM binary. When doing import checks however, Webpack fails building because it cannot find this binary. To work around this, we include a no-op file with the expected name.
- In the tests for the language service, there are a couple of untested happy paths. Input couldn't be found to trigger these happy paths.