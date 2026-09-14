# Changelog

## [0.0.22](https://github.com/Amazon-Q-Developer/language-servers/compare/lsp-core/v0.0.21...lsp-core/v0.0.22) (2026-08-18)


### Bug Fixes

* repoint CODEOWNERS and package repository URLs to the new org ([#2838](https://github.com/Amazon-Q-Developer/language-servers/issues/2838)) ([43e44dc](https://github.com/Amazon-Q-Developer/language-servers/commit/43e44dc5af94703f51456cd8a913f0d61af7570e))

## [0.0.21](https://github.com/aws/language-servers/compare/lsp-core/v0.0.20...lsp-core/v0.0.21) (2026-02-17)


### Bug Fixes

* **amazonq:** bumping up the language server runtime version ([#2621](https://github.com/aws/language-servers/issues/2621)) ([33c9eba](https://github.com/aws/language-servers/commit/33c9eba1fcc5ab7da5c520842c239e22b2237e4c))
* **amazonq:** prevent path traversal bypass in agentic chat workspace ([#2612](https://github.com/aws/language-servers/issues/2612)) ([13159f8](https://github.com/aws/language-servers/commit/13159f842e4c50aae03ace586c42085446a50986))

## [0.0.20](https://github.com/aws/language-servers/compare/lsp-core/v0.0.19...lsp-core/v0.0.20) (2025-12-19)


### Bug Fixes

* network connection error caused by server runtime dependency changes on windows machine ([#2568](https://github.com/aws/language-servers/issues/2568)) ([5d38b12](https://github.com/aws/language-servers/commit/5d38b1297a384e5c30d88b05bce075afbaa1a2fa))

## [0.0.19](https://github.com/aws/language-servers/compare/lsp-core/v0.0.18...lsp-core/v0.0.19) (2025-12-17)


### Bug Fixes

* cve and bump language server runtime version to 0.3.10 ([#2544](https://github.com/aws/language-servers/issues/2544)) ([d06e09f](https://github.com/aws/language-servers/commit/d06e09f1c7c2ce017d0a5b4394cc8d17454e2862))

## [0.0.18](https://github.com/aws/language-servers/compare/lsp-core/v0.0.17...lsp-core/v0.0.18) (2025-11-26)


### Features

* Adding ATX-FES apis support for transformation ([#2521](https://github.com/aws/language-servers/issues/2521)) ([56ee489](https://github.com/aws/language-servers/commit/56ee4891a2e19b259c129fd531f8b06f763c1b57))

## [0.0.17](https://github.com/aws/language-servers/compare/lsp-core/v0.0.16...lsp-core/v0.0.17) (2025-11-21)


### Features

* **amazonq:** adding MCP registry for governance for Amazon Q ([#2512](https://github.com/aws/language-servers/issues/2512)) ([e8d4bf5](https://github.com/aws/language-servers/commit/e8d4bf588e9b7bc13102b33ee03bd357f9698811))

## [0.0.16](https://github.com/aws/language-servers/compare/lsp-core/v0.0.15...lsp-core/v0.0.16) (2025-10-01)


### Bug Fixes

* **amazonq:** Fix mock fs clean; Node version upgrade ([#2324](https://github.com/aws/language-servers/issues/2324)) ([1d9afd4](https://github.com/aws/language-servers/commit/1d9afd410e19624223e300ca06ea7d08a112cc82))
* **amazonq:** handle IAM credentials expiration field to be aws sdk versions compatible and add refresh logic to codewhisperer IAM client ([#2349](https://github.com/aws/language-servers/issues/2349)) ([5eb3768](https://github.com/aws/language-servers/commit/5eb3768bf020d61d0ade767d62e13839048146e4))

## [0.0.15](https://github.com/aws/language-servers/compare/lsp-core/v0.0.14...lsp-core/v0.0.15) (2025-09-09)


### Features

* add support for getSupplementalContext LSP API ([#2212](https://github.com/aws/language-servers/issues/2212)) ([2ddcae7](https://github.com/aws/language-servers/commit/2ddcae7a4fac6b89cbc9784911959743ea0a6d11))

## [0.0.14](https://github.com/aws/language-servers/compare/lsp-core/v0.0.13...lsp-core/v0.0.14) (2025-08-19)


### Features

* **amazonq:** added mcp admin level configuration with GetProfile ([#2000](https://github.com/aws/language-servers/issues/2000)) ([fd6e9a8](https://github.com/aws/language-servers/commit/fd6e9a829c6229c276de5340dffce52b426a864d))


### Bug Fixes

* Use file context override in the inline completion params for Jupyter Notebook ([#2114](https://github.com/aws/language-servers/issues/2114)) ([91c8398](https://github.com/aws/language-servers/commit/91c839857f8aa4d79098189f9fb620b361c51289))

## [0.0.13](https://github.com/aws/language-servers/compare/lsp-core/v0.0.12...lsp-core/v0.0.13) (2025-08-04)


### Bug Fixes

* use new language server runtime ([#2023](https://github.com/aws/language-servers/issues/2023)) ([83ea1e4](https://github.com/aws/language-servers/commit/83ea1e42fe52990696eb9b878fa11e2c5331bec5))

## [0.0.12](https://github.com/aws/language-servers/compare/lsp-core/v0.0.11...lsp-core/v0.0.12) (2025-07-17)


### Bug Fixes

* add proper encoding support for shell output ([#1903](https://github.com/aws/language-servers/issues/1903)) ([44a6d62](https://github.com/aws/language-servers/commit/44a6d629af7702662a02f384a6a542c0d72ccc39))
* use document change events for auto trigger classifier input ([#1912](https://github.com/aws/language-servers/issues/1912)) ([2204da6](https://github.com/aws/language-servers/commit/2204da6193f2030ee546f61c969b1a664d8025e3))

## [0.0.11](https://github.com/aws/language-servers/compare/lsp-core/v0.0.10...lsp-core/v0.0.11) (2025-07-02)


### Bug Fixes

* **amazonq:** add handling for relative paths for isInWorkspace ([#1801](https://github.com/aws/language-servers/issues/1801)) ([3c273a7](https://github.com/aws/language-servers/commit/3c273a7aeac88a7afe40abaf490bc0950e517c01))

## [0.0.10](https://github.com/aws/language-servers/compare/lsp-core/v0.0.9...lsp-core/v0.0.10) (2025-06-23)


### Bug Fixes

* **amazonq:** workspace files being tagged as out of workspace issue ([#1726](https://github.com/aws/language-servers/issues/1726)) ([4bd9aea](https://github.com/aws/language-servers/commit/4bd9aeab439d15dc425634b14470fd3c67986c4a))

## [0.0.9](https://github.com/aws/language-servers/compare/lsp-core/v0.0.8...lsp-core/v0.0.9) (2025-05-22)


### Bug Fixes

* **amazonq:** Use common utility to determine workspaceFolders and fix tests ([#1353](https://github.com/aws/language-servers/issues/1353)) ([483f532](https://github.com/aws/language-servers/commit/483f532b940d3ff2e914c0824f7501c3fe6a6235))

## [0.0.8](https://github.com/aws/language-servers/compare/lsp-core/v0.0.7...lsp-core/v0.0.8) (2025-05-14)


### Bug Fixes

* update fileSearch toolSpec and implementation ([#1320](https://github.com/aws/language-servers/issues/1320)) ([4b18f25](https://github.com/aws/language-servers/commit/4b18f25dfb8595f18b2773dddaa5bfbc64cf519d))

## [0.0.7](https://github.com/aws/language-servers/compare/lsp-core/v0.0.6...lsp-core/v0.0.7) (2025-05-09)


### Bug Fixes

* switch to ignore entries over patterns ([#1236](https://github.com/aws/language-servers/issues/1236)) ([49ae714](https://github.com/aws/language-servers/commit/49ae7141024f9802d3ce671441f978f487a399aa))
* update listDirectory tool to output in tree-like format to reduce toolSize ([#1260](https://github.com/aws/language-servers/issues/1260)) ([becfee0](https://github.com/aws/language-servers/commit/becfee0d36e9e2a5fb5239c1e34cc6661ca01d94))

## [0.0.6](https://github.com/aws/language-servers/compare/lsp-core/v0.0.5...lsp-core/v0.0.6) (2025-05-07)


### Bug Fixes

* switch to ignore entries over patterns ([#1236](https://github.com/aws/language-servers/issues/1236)) ([49ae714](https://github.com/aws/language-servers/commit/49ae7141024f9802d3ce671441f978f487a399aa))
* update listDirectory tool to output in tree-like format to reduce toolSize ([#1260](https://github.com/aws/language-servers/issues/1260)) ([becfee0](https://github.com/aws/language-servers/commit/becfee0d36e9e2a5fb5239c1e34cc6661ca01d94))

## [0.0.5](https://github.com/aws/language-servers/compare/lsp-core/v0.0.4...lsp-core/v0.0.5) (2025-05-06)


### Bug Fixes

* switch to ignore entries over patterns ([#1236](https://github.com/aws/language-servers/issues/1236)) ([49ae714](https://github.com/aws/language-servers/commit/49ae7141024f9802d3ce671441f978f487a399aa))

## [0.0.4](https://github.com/aws/language-servers/compare/lsp-core/v0.0.3...lsp-core/v0.0.4) (2025-05-01)


### Features

* add cancellation handling to tools ([#1057](https://github.com/aws/language-servers/issues/1057)) ([f2ea9ac](https://github.com/aws/language-servers/commit/f2ea9ac349dbd2825ca8e6934f44c1270653dc61))
* extend logging utilts to support errors ([03c5bdd](https://github.com/aws/language-servers/commit/03c5bdd7f9861a222c21ce4a6594d1cc7b39d217))
* port executeBash tool from VSC ([#912](https://github.com/aws/language-servers/issues/912)) ([1ccba58](https://github.com/aws/language-servers/commit/1ccba58a9e339ab7d5e4370cf40fa7268f802fd8))
* port listDirectory from VSC ([#930](https://github.com/aws/language-servers/issues/930)) ([7feb127](https://github.com/aws/language-servers/commit/7feb127f33570d2349852781e16cc9d6763a92b8))
* port readDirectoryRecursively from VSC ([#923](https://github.com/aws/language-servers/issues/923)) ([af48204](https://github.com/aws/language-servers/commit/af48204201fbe531d9d5185b927936e8adbb695f))


### Bug Fixes

* add workspace folders as context for agentic-chat ([#995](https://github.com/aws/language-servers/issues/995)) ([f300ca5](https://github.com/aws/language-servers/commit/f300ca5acae03a993114c31d0b88d88b6cd26dc4))
* disable timeout for tests in aws-lsp-codewhisperer and core packages ([#955](https://github.com/aws/language-servers/issues/955)) ([254e36c](https://github.com/aws/language-servers/commit/254e36cf1a34b114a9397c688784293367dc1d63))
* format objects in the logs properly. ([#1139](https://github.com/aws/language-servers/issues/1139)) ([1ff522c](https://github.com/aws/language-servers/commit/1ff522c7005bae518cf8ae3ed80a0faa82d11435))
* isInWorkspace should work on closed files.  ([#1004](https://github.com/aws/language-servers/issues/1004)) ([a96651e](https://github.com/aws/language-servers/commit/a96651ea1edd296b5dfa7ee4fdd1c6d378a14858))
* stop button kills the shell executions ([1ff522c](https://github.com/aws/language-servers/commit/1ff522c7005bae518cf8ae3ed80a0faa82d11435))

## [0.0.3](https://github.com/aws/language-servers/compare/lsp-core/v0.0.2...lsp-core/v0.0.3) (2025-04-07)


### Features

* port fs related tools from VSC.  ([#894](https://github.com/aws/language-servers/issues/894)) ([a368acc](https://github.com/aws/language-servers/commit/a368accfcd0b5c88b81f407d4cd7b73be2782b9b))

## [0.0.2](https://github.com/aws/language-servers/compare/lsp-core/v0.0.1...lsp-core/v0.0.2) (2025-03-18)


### Features

* **identity:** device code support ([#823](https://github.com/aws/language-servers/issues/823)) ([6d5368e](https://github.com/aws/language-servers/commit/6d5368e33a36a3003dc04e9c429b63edda6989de))

[0.0.1] - 2024-06-07

- Intial release containing helper classes and functions that are used in `@aws/lsp-yaml`, `@aws/lsp-json` and other packages
