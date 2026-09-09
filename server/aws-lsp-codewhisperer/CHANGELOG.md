# Changelog

## [0.0.127](https://github.com/Amazon-Q-Developer/language-servers/compare/lsp-codewhisperer/v0.0.126...lsp-codewhisperer/v0.0.127) (2026-08-24)


### Bug Fixes

* **amazonq:** cover merged env and headers in MCP consent fingerprint ([#2851](https://github.com/Amazon-Q-Developer/language-servers/issues/2851)) ([#2853](https://github.com/Amazon-Q-Developer/language-servers/issues/2853)) ([529aed4](https://github.com/Amazon-Q-Developer/language-servers/commit/529aed43259503cf71b475fb3496de7bfab25f17))
* beam - flat-named transformed zips + lightweight discovery + IsLbvPending ([#2849](https://github.com/Amazon-Q-Developer/language-servers/issues/2849)) ([863c5bf](https://github.com/Amazon-Q-Developer/language-servers/commit/863c5bf00a6c30ec7658056a155f1ca1005127e6))
* surface backend interactive mode in getTransformInfo ([836b756](https://github.com/Amazon-Q-Developer/language-servers/commit/836b756ee2d8a553d9b26cf095e12979141e2367))

## [0.0.126](https://github.com/Amazon-Q-Developer/language-servers/compare/lsp-codewhisperer/v0.0.125...lsp-codewhisperer/v0.0.126) (2026-08-20)


### Bug Fixes

* **amazonq:** narrow tool-use   truncation detection and classify retries in telemetry ([#2847](https://github.com/Amazon-Q-Developer/language-servers/issues/2847)) ([1eb2f9f](https://github.com/Amazon-Q-Developer/language-servers/commit/1eb2f9f270c479ca457658e22f2ef0d06f6517ca))
* scope and forward stepId for the planning-branch LBV HITL ([#2835](https://github.com/Amazon-Q-Developer/language-servers/issues/2835)) ([9f8bb89](https://github.com/Amazon-Q-Developer/language-servers/commit/9f8bb8943c41edc105c460d4b2c60836183cdd2b))

## [0.0.125](https://github.com/Amazon-Q-Developer/language-servers/compare/lsp-codewhisperer/v0.0.124...lsp-codewhisperer/v0.0.125) (2026-08-18)


### Features

* **amazonq:** initialize Q services when credentials arrive ([#2840](https://github.com/Amazon-Q-Developer/language-servers/issues/2840)) ([4e0d3b0](https://github.com/Amazon-Q-Developer/language-servers/commit/4e0d3b0d69e0aa7a230f64a1b168a09bcfd4b7cd))


### Bug Fixes

* **amazonq:** retry truncated tool-use streams instead of dropping them silently ([#2841](https://github.com/Amazon-Q-Developer/language-servers/issues/2841)) ([368a099](https://github.com/Amazon-Q-Developer/language-servers/commit/368a099cc9b5cc3cf7bb1f2298718824a1ab1118))
* repoint CODEOWNERS and package repository URLs to the new org ([#2838](https://github.com/Amazon-Q-Developer/language-servers/issues/2838)) ([43e44dc](https://github.com/Amazon-Q-Developer/language-servers/commit/43e44dc5af94703f51456cd8a913f0d61af7570e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @aws/lsp-core bumped from ^0.0.21 to ^0.0.22

## [0.0.124](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.123...lsp-codewhisperer/v0.0.124) (2026-08-13)


### Features

* **amazonq:** surface Q Developer plugin access-blocked rejections to the client ([#2794](https://github.com/aws/language-servers/issues/2794)) ([724f629](https://github.com/aws/language-servers/commit/724f62909ef16e750f52f5ba8b570b42b8bf00c8))
* scope local build verification to the loaded beamed repo and add beam discovery/download ([#2798](https://github.com/aws/language-servers/issues/2798)) ([49867d7](https://github.com/aws/language-servers/commit/49867d7d2d3c93a5ac9472aaac33b0a26c23cf00))


### Bug Fixes

* **amazonq:** deliver Q Developer access-blocked notifications to the client ([#2800](https://github.com/aws/language-servers/issues/2800)) ([5e92430](https://github.com/aws/language-servers/commit/5e924300c371f36df57994b56666e96b5b5b0c1d))

## [0.0.123](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.122...lsp-codewhisperer/v0.0.123) (2026-07-23)


### Bug Fixes

* canonicalize symlinks (including dangling links) in workspace boundary check ([#2787](https://github.com/aws/language-servers/issues/2787)) ([b15d04e](https://github.com/aws/language-servers/commit/b15d04e05d7248864c72f4209c4a19baee9b7dda))

## [0.0.122](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.121...lsp-codewhisperer/v0.0.122) (2026-07-09)


### Bug Fixes

* show friendly error message for govcloud regions ([#2779](https://github.com/aws/language-servers/issues/2779)) ([9acc756](https://github.com/aws/language-servers/commit/9acc756298427e7ca99f19c0270fe0bff7a17673))

## [0.0.121](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.120...lsp-codewhisperer/v0.0.121) (2026-07-02)


### Bug Fixes

* pass customUserAgent to CodeWhispererServiceToken in QCodeAnalysisServer ([#2772](https://github.com/aws/language-servers/issues/2772)) ([2f6d1ae](https://github.com/aws/language-servers/commit/2f6d1ae5f23acc41896eb76d65750bdf60ecb5a5))

## [0.0.120](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.119...lsp-codewhisperer/v0.0.120) (2026-06-30)


### Features

* **amazonq:** add client-side chat delivery metrics ([#2766](https://github.com/aws/language-servers/issues/2766)) ([614bbf5](https://github.com/aws/language-servers/commit/614bbf5e122f30c381d7b4dbf9def3679b4d49be))
* **amazonq:** enable two-way workspace sync for customer edits ([#2769](https://github.com/aws/language-servers/issues/2769)) ([f066772](https://github.com/aws/language-servers/commit/f066772903633db5d9f140c48ab607856adeadce))


### Bug Fixes

* **amazonq:** bind MCP consent to workspace+config ([#2767](https://github.com/aws/language-servers/issues/2767)) ([1c84ba6](https://github.com/aws/language-servers/commit/1c84ba6c89a212bbea0f9d650bf54bddd8e5abfa))
* **amazonq:** preserve customer edits on checkpoint apply (DealerFx netTransform) ([#2765](https://github.com/aws/language-servers/issues/2765)) ([e2118f3](https://github.com/aws/language-servers/commit/e2118f383d1acb2952110275573d82ae16b69d59))

## [0.0.119](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.118...lsp-codewhisperer/v0.0.119) (2026-06-09)


### Features

* **integ:** rewrite ATX integ tests for new chatty-agent handler ([#2751](https://github.com/aws/language-servers/issues/2751)) ([2599bb3](https://github.com/aws/language-servers/commit/2599bb3368bf64d2d9aaf4909b6d0c241969fa45))
* rejecting atx .ent v1 agent jobs ([#2761](https://github.com/aws/language-servers/issues/2761)) ([7df75d0](https://github.com/aws/language-servers/commit/7df75d094a1ca1dd354906e80d09a13bc2504e76))

## [0.0.118](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.117...lsp-codewhisperer/v0.0.118) (2026-05-28)


### Features

* adding worklogs and chat pagination support ([#2752](https://github.com/aws/language-servers/issues/2752)) ([8db1a33](https://github.com/aws/language-servers/commit/8db1a33872895a23db7f5087b3b6a1caf1b81d16))


### Bug Fixes

* surface lbv and checkpoint hitls regardless of job status ([#2755](https://github.com/aws/language-servers/issues/2755)) ([0df9444](https://github.com/aws/language-servers/commit/0df9444730116bc6edbf79ae2e1aa9de8f677e16))

## [0.0.117](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.116...lsp-codewhisperer/v0.0.117) (2026-05-22)


### Bug Fixes

* canonicalize paths through filesystem in requiresPathAcceptance ([#2742](https://github.com/aws/language-servers/issues/2742)) ([6c279b0](https://github.com/aws/language-servers/commit/6c279b083cc192aa5df1f38c2c185576fd5234f5))
* surface post-build checkpoint hitl after local build verification ([#2737](https://github.com/aws/language-servers/issues/2737)) ([31e3528](https://github.com/aws/language-servers/commit/31e35285256435706e679ec165d663bb6f6e308b))

## [0.0.116](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.115...lsp-codewhisperer/v0.0.116) (2026-05-18)


### Bug Fixes

* **amazonq:** prevent file link click from crashing language server ([#2718](https://github.com/aws/language-servers/issues/2718)) ([#2730](https://github.com/aws/language-servers/issues/2730)) ([51e1849](https://github.com/aws/language-servers/commit/51e184948387714bccd5b9c5e50e07d47d771fb1))

## [0.0.115](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.114...lsp-codewhisperer/v0.0.115) (2026-05-13)


### Features

* chatty-agent transformation flow ([927bd03](https://github.com/aws/language-servers/commit/927bd03d1b7f72acbc7d9e1748759598251cd8ed))

## [0.0.114](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.113...lsp-codewhisperer/v0.0.114) (2026-05-05)


### Bug Fixes

* **amazonq:** route inline chat through getChatResponse for correct API selection ([#2713](https://github.com/aws/language-servers/issues/2713)) ([#2714](https://github.com/aws/language-servers/issues/2714)) ([b6226e7](https://github.com/aws/language-servers/commit/b6226e758d52d8db85c844cab82e6b604566e2ef))

## [0.0.113](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.112...lsp-codewhisperer/v0.0.113) (2026-04-29)


### Features

* **amazonq:** add consent prompt for workspace-scoped MCP servers ([#2708](https://github.com/aws/language-servers/issues/2708)) ([7b8595a](https://github.com/aws/language-servers/commit/7b8595a4e638562f79d5f71dcf22b0c700490458))


### Bug Fixes

* **amazonq:** improve MCP consent gate reliability and cleanup ([#2711](https://github.com/aws/language-servers/issues/2711)) ([f5aa1a3](https://github.com/aws/language-servers/commit/f5aa1a3b25aa38bfe8dd0e830b5839e1cea1d410))
* deprecate [@workspace](https://github.com/workspace) vector search + fix [@folder](https://github.com/folder) files not appearing in context ([#2698](https://github.com/aws/language-servers/issues/2698)) ([ae7d3fc](https://github.com/aws/language-servers/commit/ae7d3fcd26f57d6cc5d3d26dd5ec79983c4103df))
* guard workspaceFolderManager null reference in updateConfiguration ([#2695](https://github.com/aws/language-servers/issues/2695)) ([dcd7829](https://github.com/aws/language-servers/commit/dcd78298766d09902ba51cb12547780f518d48a9))

## [0.0.112](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.111...lsp-codewhisperer/v0.0.112) (2026-04-07)


### Bug Fixes

* correct URI mapping in onDidRenameFiles handler ([#2688](https://github.com/aws/language-servers/issues/2688)) ([e2e0b2c](https://github.com/aws/language-servers/commit/e2e0b2cd56dbe48f462064d0d0a5cc8397975be7))


### Performance Improvements

* **amazonq:** context command performance ([#2682](https://github.com/aws/language-servers/issues/2682)) ([f8dec9a](https://github.com/aws/language-servers/commit/f8dec9a65b7e72e78e5e16cbbfd470b2d69e75b0))

## [0.0.111](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.110...lsp-codewhisperer/v0.0.111) (2026-03-31)


### Features

* **amazonq:** align mcp oauth client with mcp sdk auth patterns ([#2679](https://github.com/aws/language-servers/issues/2679)) ([4ff5ab0](https://github.com/aws/language-servers/commit/4ff5ab0e6ab4bf1659ffdb07a72bba4d6c358339))


### Bug Fixes

* cache subscription status to prevent excessive CreateSubscriptionToken API calls ([#2680](https://github.com/aws/language-servers/issues/2680)) ([d26edb7](https://github.com/aws/language-servers/commit/d26edb7dfd321122515373e0d08b757f6e367561))


### Reverts

* undo revert of fix for tool permissions in allowed paths per tool ([#2601](https://github.com/aws/language-servers/issues/2601)) ([#2683](https://github.com/aws/language-servers/issues/2683)) ([#2684](https://github.com/aws/language-servers/issues/2684)) ([8a615fa](https://github.com/aws/language-servers/commit/8a615faf27c6b519045263f5bddf0bfe98f609e0))

## [0.0.110](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.109...lsp-codewhisperer/v0.0.110) (2026-03-17)


### Features

* add cwsprChatHasWorkspaceContext metric to amazonq_addMessage event ([#2665](https://github.com/aws/language-servers/issues/2665)) ([#2668](https://github.com/aws/language-servers/issues/2668)) ([7d71d0a](https://github.com/aws/language-servers/commit/7d71d0a38d1e9adbb29210fff1c2b6b5e6d7d120))


### Bug Fixes

* amazon q ignores rules for other os, so adding fallback ([#2663](https://github.com/aws/language-servers/issues/2663)) ([4be527a](https://github.com/aws/language-servers/commit/4be527a69b4cecc801e23009a63c8d3301b84f2d))
* deduplicate rules in multi workspace mode ([#2660](https://github.com/aws/language-servers/issues/2660)) ([c8022fe](https://github.com/aws/language-servers/commit/c8022feb7637c64f71330856ecb3cb96096dccb7))
* rules created in default file is not working ([#2652](https://github.com/aws/language-servers/issues/2652)) ([#2655](https://github.com/aws/language-servers/issues/2655)) ([b380e97](https://github.com/aws/language-servers/commit/b380e97051251a0ead0a7bc3314f8850f14073ac))

## [0.0.109](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.108...lsp-codewhisperer/v0.0.109) (2026-03-10)


### Bug Fixes

* tools always ask for permissions ([#2647](https://github.com/aws/language-servers/issues/2647)) ([#2648](https://github.com/aws/language-servers/issues/2648)) ([997793d](https://github.com/aws/language-servers/commit/997793dd13b8d7685997b43ea06774ce2f609ea5))

## [0.0.108](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.107...lsp-codewhisperer/v0.0.108) (2026-03-03)


### Bug Fixes

* adding HITL handling for Missing Private Packages ([#2630](https://github.com/aws/language-servers/issues/2630)) ([77b6e7d](https://github.com/aws/language-servers/commit/77b6e7d0974eb5c1aaebab7b888c9d2f53cb85c2))
* **amazonq:** sanitize MCP tool schemas for Ajv draft-07 compatibility ([#2638](https://github.com/aws/language-servers/issues/2638)) ([69b275f](https://github.com/aws/language-servers/commit/69b275f001b964d024ac88d4c5bef70b83bac0e7))
* support stripped indexing folder in bundled LSP and also update indexing bundle to AWSVectorConsolasLocalWorkspaceIndexing `d6762f8b` ([#2629](https://github.com/aws/language-servers/issues/2629)) ([a005b29](https://github.com/aws/language-servers/commit/a005b29d66d88abacd41d55954110d92c7e7a616))
* toBase64() encoder which only accepts string ([#2636](https://github.com/aws/language-servers/issues/2636)) ([#2637](https://github.com/aws/language-servers/issues/2637)) ([5e4fda8](https://github.com/aws/language-servers/commit/5e4fda89499ac9266fa56e290c0805febffa7f81))

## [0.0.107](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.106...lsp-codewhisperer/v0.0.107) (2026-02-20)


### Bug Fixes

* add proxy support for ATX Transform using sdkInitializator ([#2619](https://github.com/aws/language-servers/issues/2619)) ([83d3bc9](https://github.com/aws/language-servers/commit/83d3bc9dd8f2d58dc44ca59a4daa6176b569024f))


### Reverts

* fix for tool permissions in allowed paths per tool ([#2601](https://github.com/aws/language-servers/issues/2601)) ([#2615](https://github.com/aws/language-servers/issues/2615)) ([7b62151](https://github.com/aws/language-servers/commit/7b62151acd4908073fe8b369f1a3e9ca1ba0be9e))

## [0.0.106](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.105...lsp-codewhisperer/v0.0.106) (2026-02-17)


### Features

* copy private package's nupkg file to artifacts folder ([#2613](https://github.com/aws/language-servers/issues/2613)) ([99cb9a8](https://github.com/aws/language-servers/commit/99cb9a8f87d750a496c13b0678cae82de101b99d))


### Bug Fixes

* **amazonq:** bumping up the language server runtime version ([#2621](https://github.com/aws/language-servers/issues/2621)) ([33c9eba](https://github.com/aws/language-servers/commit/33c9eba1fcc5ab7da5c520842c239e22b2237e4c))
* **amazonq:** emit modelid per tab ([#2620](https://github.com/aws/language-servers/issues/2620)) ([640179f](https://github.com/aws/language-servers/commit/640179f021d68a8bef5ece710d1b928e2c17fed1))
* **amazonq:** fix improperly formed requests ([#2616](https://github.com/aws/language-servers/issues/2616)) ([2739718](https://github.com/aws/language-servers/commit/273971834e2a307fe79402bef329b53b8bb51a4e))
* **amazonq:** prevent path traversal bypass in agentic chat workspace ([#2612](https://github.com/aws/language-servers/issues/2612)) ([13159f8](https://github.com/aws/language-servers/commit/13159f842e4c50aae03ace586c42085446a50986))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @aws/lsp-core bumped from ^0.0.20 to ^0.0.21

## [0.0.105](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.104...lsp-codewhisperer/v0.0.105) (2026-02-10)


### Bug Fixes

* amazon q chat history restoration to display rich ui elements and persisting model/agentic toggle preferences. ([#2610](https://github.com/aws/language-servers/issues/2610)) ([75135dd](https://github.com/aws/language-servers/commit/75135ddf2342a355a1fcba463dd6a42d040b75fa))
* extend SageMaker env detection to support both SMUS and SMAI ([#2598](https://github.com/aws/language-servers/issues/2598)) ([12fbc4c](https://github.com/aws/language-servers/commit/12fbc4c4f355ab0a8500de697a5fd7bd7950f661))

## [0.0.104](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.103...lsp-codewhisperer/v0.0.104) (2026-02-05)


### Bug Fixes

* add OAuth client support to MCP manager ([#2607](https://github.com/aws/language-servers/issues/2607)) ([81c1e08](https://github.com/aws/language-servers/commit/81c1e089750e90efb4ea302279a915b08eddc0ad))
* Add optional `x-amzn-qt-test-id` header to ATX Transform API requests for test traffic classification.   ([#2602](https://github.com/aws/language-servers/issues/2602)) ([2321687](https://github.com/aws/language-servers/commit/2321687b1b6ae7e5c4fdc9fcd15792cd54f138c9))
* add programming language to chatInteractWithMessageEvent ([#2605](https://github.com/aws/language-servers/issues/2605)) ([af86c21](https://github.com/aws/language-servers/commit/af86c218af8f904a806ca43c8695fcb6053e347c))
* **amazonq:** disable WCS feature by default ([#2604](https://github.com/aws/language-servers/issues/2604)) ([990f727](https://github.com/aws/language-servers/commit/990f7273d39925beba46035597a7d84983eff19f))
* **amazonq:** fix for tool permissions in allowed paths per tool ([#2601](https://github.com/aws/language-servers/issues/2601)) ([01ea0d7](https://github.com/aws/language-servers/commit/01ea0d74404baae14462e5557f488b22085bb8d3))

## [0.0.103](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.102...lsp-codewhisperer/v0.0.103) (2026-01-26)


### Bug Fixes

* include conversationId in generateAssistantResponse API request ([#2595](https://github.com/aws/language-servers/issues/2595)) ([a8ac33e](https://github.com/aws/language-servers/commit/a8ac33ea4e26f2ca898e5d4ed2625e11f53922aa))
* patch [#2589](https://github.com/aws/language-servers/issues/2589) and fix NEP invalidation error ([#2590](https://github.com/aws/language-servers/issues/2590)) ([07960d0](https://github.com/aws/language-servers/commit/07960d0fcd169bae0d632d05d953475fec98c05c))

## [0.0.102](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.101...lsp-codewhisperer/v0.0.102) (2026-01-13)


### Bug Fixes

* **amazonq:** add variables for registry server refresh and re-init ([#2585](https://github.com/aws/language-servers/issues/2585)) ([9c260f1](https://github.com/aws/language-servers/commit/9c260f10041a6b6fee5b40fb80b2885142dbe64b))
* **amazonq:** adding truncation logic to fileText for inline suggestions ([#2589](https://github.com/aws/language-servers/issues/2589)) ([2c236ce](https://github.com/aws/language-servers/commit/2c236ce085f7b347d077de58c4fa497a0fa18722))

## [0.0.101](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.100...lsp-codewhisperer/v0.0.101) (2026-01-09)


### Reverts

* editor state is casuing validation error ([fb76a79](https://github.com/aws/language-servers/commit/fb76a79aa7db149abbdb6e455d8eb5fcf340e81f))

## [0.0.100](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.99...lsp-codewhisperer/v0.0.100) (2026-01-07)


### Bug Fixes

* **amazonq:** adding failed state for pin context features ([#2573](https://github.com/aws/language-servers/issues/2573)) ([981c6e1](https://github.com/aws/language-servers/commit/981c6e1c733d3bb8d171bd9697f443fab7a50c20))
* **amazonq:** reduce excessive logging from amazon q token service manager causing performance issues [#6111](https://github.com/aws/language-servers/issues/6111) ([#2578](https://github.com/aws/language-servers/issues/2578)) ([8cce456](https://github.com/aws/language-servers/commit/8cce4567729edea58ea9b20aeeaf7143bc494550))
* generateCompletion request is missing editorState metadata ([#2574](https://github.com/aws/language-servers/issues/2574)) ([aec6a90](https://github.com/aws/language-servers/commit/aec6a90893e1f4837b15d70972444bf751d460d0))
* let missing registry servers fail naturally during installation ([#2577](https://github.com/aws/language-servers/issues/2577)) ([ecde90a](https://github.com/aws/language-servers/commit/ecde90a9cbb424d4ab1a30fa1f68f05f4b0a8285))

## [0.0.99](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.98...lsp-codewhisperer/v0.0.99) (2025-12-19)


### Bug Fixes

* network connection error caused by server runtime dependency changes on windows machine ([#2568](https://github.com/aws/language-servers/issues/2568)) ([5d38b12](https://github.com/aws/language-servers/commit/5d38b1297a384e5c30d88b05bce075afbaa1a2fa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @aws/lsp-core bumped from ^0.0.19 to ^0.0.20

## [0.0.98](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.97...lsp-codewhisperer/v0.0.98) (2025-12-17)


### Features

* add alphabetical sorting for MCP registry servers and URL validation ([#2555](https://github.com/aws/language-servers/issues/2555)) ([d936673](https://github.com/aws/language-servers/commit/d936673e570301b9abc4e587ef0d7cc92e1d470b))
* **amazonq:** show kiro pricing information for Amazon Q builderId paid tier users ([#2556](https://github.com/aws/language-servers/issues/2556)) ([5896298](https://github.com/aws/language-servers/commit/58962981604d1d0d5363b23c0e52df119bcc824e))
* Update SMAI clients to return SM_AI_STUDIO_IDE origin ([#2558](https://github.com/aws/language-servers/issues/2558)) ([dc1d216](https://github.com/aws/language-servers/commit/dc1d21652d48c2ebeb6ddebc6b6ab351d688017c))
* web search ([09c4769](https://github.com/aws/language-servers/commit/09c47695c48df967e0a22e93290cc69f95b32ac3))


### Bug Fixes

* cve and bump language server runtime version to 0.3.10 ([#2544](https://github.com/aws/language-servers/issues/2544)) ([d06e09f](https://github.com/aws/language-servers/commit/d06e09f1c7c2ce017d0a5b4394cc8d17454e2862))
* fix for mcp registry error handling ([#2561](https://github.com/aws/language-servers/issues/2561)) ([f5f8b36](https://github.com/aws/language-servers/commit/f5f8b36aa6a6b4ca6228ba3c1110d0532cda65bd))
* fix for mcp servers refresh ([#2550](https://github.com/aws/language-servers/issues/2550)) ([cd75394](https://github.com/aws/language-servers/commit/cd753948c3b3b9b07b626fc41391bd91b55a0d39))
* fix null value for codewhisperer percentage ([#2523](https://github.com/aws/language-servers/issues/2523)) ([e898ab4](https://github.com/aws/language-servers/commit/e898ab4a84e7976f6478a434b5ba7694e6ddcb38))
* prevent MCP server process duplicates with lightweight tracking ([#2562](https://github.com/aws/language-servers/issues/2562)) ([4ba6eb2](https://github.com/aws/language-servers/commit/4ba6eb27400fe352660128f406e837df34acc247))
* remove s3 artifact upload and download timeout ([#2560](https://github.com/aws/language-servers/issues/2560)) ([c0b3523](https://github.com/aws/language-servers/commit/c0b35232c0946d4957ffca7bbd5b8cbf66b88b4e))
* update inputLimit calculation to use fixed 100K reserved characters ([#2557](https://github.com/aws/language-servers/issues/2557)) ([ef04639](https://github.com/aws/language-servers/commit/ef0463937898570e33b45d48800a9d33bc6adc3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @aws/lsp-core bumped from ^0.0.18 to ^0.0.19

## [0.0.97](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.96...lsp-codewhisperer/v0.0.97) (2025-12-08)


### Features

* use dynamic token limits from listAvailableModels API ([#2539](https://github.com/aws/language-servers/issues/2539)) ([f87ac9f](https://github.com/aws/language-servers/commit/f87ac9fce32d235649f81957b71d424264aae9c8))


### Bug Fixes

* ATX Transform Fix Retrieve Job Erroring on Profile changes ([#2538](https://github.com/aws/language-servers/issues/2538)) ([870d540](https://github.com/aws/language-servers/commit/870d5400dd5eb77f32e5592089525dacc001cb81))

## [0.0.96](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.95...lsp-codewhisperer/v0.0.96) (2025-12-01)


### Features

* adding new regions ([#2532](https://github.com/aws/language-servers/issues/2532)) ([29f08a6](https://github.com/aws/language-servers/commit/29f08a60e9919026c4e1a2b2502148d5c738554b))

## [0.0.95](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.94...lsp-codewhisperer/v0.0.95) (2025-11-26)


### Features

* Adding ATX-FES apis support for transformation ([#2521](https://github.com/aws/language-servers/issues/2521)) ([56ee489](https://github.com/aws/language-servers/commit/56ee4891a2e19b259c129fd531f8b06f763c1b57))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @aws/lsp-core bumped from ^0.0.17 to ^0.0.18

## [0.0.94](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.93...lsp-codewhisperer/v0.0.94) (2025-11-25)


### Bug Fixes

* fix for mcp tool resgistration on smus ([#2524](https://github.com/aws/language-servers/issues/2524)) ([8584723](https://github.com/aws/language-servers/commit/8584723839447dda878474e17a3b21a315ffc759))

## [0.0.93](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.92...lsp-codewhisperer/v0.0.93) (2025-11-21)


### Bug Fixes

* fix for permission update for servers ([#2517](https://github.com/aws/language-servers/issues/2517)) ([ef86b5c](https://github.com/aws/language-servers/commit/ef86b5ce474993265f9ffa8cb184e96eb1d0daee))

## [0.0.92](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.91...lsp-codewhisperer/v0.0.92) (2025-11-21)


### Features

* **amazonq:** adding MCP registry for governance for Amazon Q ([#2512](https://github.com/aws/language-servers/issues/2512)) ([e8d4bf5](https://github.com/aws/language-servers/commit/e8d4bf588e9b7bc13102b33ee03bd357f9698811))


### Bug Fixes

* **amazonq:** prevent base64 encoding error by passing undefined instead of empty object ([#2492](https://github.com/aws/language-servers/issues/2492)) ([30e28b7](https://github.com/aws/language-servers/commit/30e28b75499b1a55da904697fd446a30c6a87665))
* incorrect error reference in previous fix ([9fddc8e](https://github.com/aws/language-servers/commit/9fddc8e11f583dbf089f93979e1602d8c8795a16))
* preserve registry server config when updating permissions ([#2515](https://github.com/aws/language-servers/issues/2515)) ([49ca3bb](https://github.com/aws/language-servers/commit/49ca3bbb6dbf9eac4b281aa80cd5ff30b94b3a7e))
* resolve process crash when managing BID subscription ([#2501](https://github.com/aws/language-servers/issues/2501)) ([5d6590a](https://github.com/aws/language-servers/commit/5d6590a1d8c7aeb80b75036eb0e1b3802afe5c08))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @aws/lsp-core bumped from ^0.0.16 to ^0.0.17

## [0.0.91](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.90...lsp-codewhisperer/v0.0.91) (2025-11-18)


### Bug Fixes

* **amazonq:** handle large results ([#2497](https://github.com/aws/language-servers/issues/2497)) ([b3efa7c](https://github.com/aws/language-servers/commit/b3efa7cff0b23608dd0cca796c9c95a672c9321a))
* resolve broken error handling in setPaidTierMode ([#2500](https://github.com/aws/language-servers/issues/2500)) ([8ccb067](https://github.com/aws/language-servers/commit/8ccb06768c4a386b0a4699d8b2e299f0aad110b1))

## [0.0.90](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.89...lsp-codewhisperer/v0.0.90) (2025-11-13)


### Bug Fixes

* bearer client will not pick up telemetry optout and its always optout ([#2484](https://github.com/aws/language-servers/issues/2484)) ([ec6771f](https://github.com/aws/language-servers/commit/ec6771fc5dc162f9c65df4e979dcfc3ae4838f06))

## [0.0.89](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.88...lsp-codewhisperer/v0.0.89) (2025-11-12)


### Features

* ab test setup for new repomap strategy ([#2474](https://github.com/aws/language-servers/issues/2474)) ([d28867f](https://github.com/aws/language-servers/commit/d28867f2a5e06693b83d0cfd0286f017cdc5e5b3))
* differentiate implicit and explicit reject for inline completion ([#2475](https://github.com/aws/language-servers/issues/2475)) ([4b68eea](https://github.com/aws/language-servers/commit/4b68eea03374db79b8ad728aa048b623de8efa91))


### Bug Fixes

* McpManager not initialized error ([#2479](https://github.com/aws/language-servers/issues/2479)) ([7e2707b](https://github.com/aws/language-servers/commit/7e2707b8c2b4467aae1fe1c77bb419043e193ddc))

## [0.0.88](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.87...lsp-codewhisperer/v0.0.88) (2025-10-28)


### Bug Fixes

* add venv in the common gitignore patterns ([#2445](https://github.com/aws/language-servers/issues/2445)) ([d030288](https://github.com/aws/language-servers/commit/d030288a2508356db337dfa34ee64c8be1deb8e9))
* enforce MAX_TOOL_NAME_LENGTH check in createNamespacedToolName ([#2447](https://github.com/aws/language-servers/issues/2447)) ([6663f87](https://github.com/aws/language-servers/commit/6663f87e68c9645af6ffb004eaf725e5102fe5ab))
* strenghen NEP trigger conditions ([#2438](https://github.com/aws/language-servers/issues/2438)) ([82e2340](https://github.com/aws/language-servers/commit/82e2340cf86a5eba20f8d18f1293c136c0022dd9))

## [0.0.87](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.86...lsp-codewhisperer/v0.0.87) (2025-10-21)


### Features

* **amazonq:** add user requirement to zipfile for code review tool ([#2430](https://github.com/aws/language-servers/issues/2430)) ([2c33b38](https://github.com/aws/language-servers/commit/2c33b384a0e406bcd8d3888a911d5482ce1f38ef))
* nep auto trigger ([#2424](https://github.com/aws/language-servers/issues/2424)) ([2292bd7](https://github.com/aws/language-servers/commit/2292bd75fded0848208de9401d15d3399a9c297b))
* send pinned context button immediately with pending state  ([#2353](https://github.com/aws/language-servers/issues/2353)) ([bee5cad](https://github.com/aws/language-servers/commit/bee5cadeaf8840a8af08acfe8b58442aac7ad567))


### Bug Fixes

* classifier last token sometimes fail to capture the right values ([#2434](https://github.com/aws/language-servers/issues/2434)) ([7420d59](https://github.com/aws/language-servers/commit/7420d591a0fcf5da834f0165696aa50b99fd4d3a))

## [0.0.86](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.85...lsp-codewhisperer/v0.0.86) (2025-10-15)


### Reverts

* revert for mid-loop compaction ([3f48b12](https://github.com/aws/language-servers/commit/3f48b12bce4faba474404f7c74a9520c379552fe))

## [0.0.85](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.84...lsp-codewhisperer/v0.0.85) (2025-10-14)


### Bug Fixes

* inline, nep telemetry not sent and throw sessionId not found ([#2419](https://github.com/aws/language-servers/issues/2419)) ([c96106d](https://github.com/aws/language-servers/commit/c96106d18c9e9d846765665ce2ee50304af4ff7f))

## [0.0.84](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.83...lsp-codewhisperer/v0.0.84) (2025-10-09)


### Features

* add model description to dropdown ([#2374](https://github.com/aws/language-servers/issues/2374)) ([ed8c6dd](https://github.com/aws/language-servers/commit/ed8c6dda1312f728e9ee7472f7ca447196ad9d84))
* **amazonq:** adding classification based retry strategy for chat ([#2234](https://github.com/aws/language-servers/issues/2234)) ([#2409](https://github.com/aws/language-servers/issues/2409)) ([15d1b1f](https://github.com/aws/language-servers/commit/15d1b1f5947a1b83dab65c9d3fef901ab8a033c9))
* **amazonq:** env var change for JupyterLab conversation history on refresh support ([#2395](https://github.com/aws/language-servers/issues/2395)) ([a908195](https://github.com/aws/language-servers/commit/a9081954bcaf20b7d0fbe0af11e61b8f82c7e82f))
* **amazonq:** support JupyterLab conversation history on refresh ([#2325](https://github.com/aws/language-servers/issues/2325)) ([0980351](https://github.com/aws/language-servers/commit/09803514d1ce31ca77a532161e071e1d037e3fb1))


### Bug Fixes

* add in-loop compaction ([#2387](https://github.com/aws/language-servers/issues/2387)) ([35f0795](https://github.com/aws/language-servers/commit/35f0795fa5d09f3610e6a29cb72d49f32cc5534e))
* addonly EDITS should be handled as COMPLETIONS ([#2133](https://github.com/aws/language-servers/issues/2133)) ([4f5a9da](https://github.com/aws/language-servers/commit/4f5a9dacf3bfd68aeb40920fb800adf001ed43d5))
* patch [#2133](https://github.com/aws/language-servers/issues/2133) and handle more variants of FIM suggestions ([#2407](https://github.com/aws/language-servers/issues/2407)) ([f3086d7](https://github.com/aws/language-servers/commit/f3086d71808bd49336e0df9ba30f5be5fda837c3))

## [0.0.83](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.82...lsp-codewhisperer/v0.0.83) (2025-10-01)


### Bug Fixes

* **amazonq:** escaping user input to mitigate xss issue ([#2360](https://github.com/aws/language-servers/issues/2360)) ([45b86be](https://github.com/aws/language-servers/commit/45b86bef1a93cf9ced6fbf0c222cf5410de04c81))
* **amazonq:** fix to add opt-out header to streaming client ([#2365](https://github.com/aws/language-servers/issues/2365)) ([692e77b](https://github.com/aws/language-servers/commit/692e77bc99770ac7d676928e95e3dc43bb91e7f0))
* **amazonq:** handle IAM credentials expiration field to be aws sdk versions compatible and add refresh logic to codewhisperer IAM client ([#2349](https://github.com/aws/language-servers/issues/2349)) ([5eb3768](https://github.com/aws/language-servers/commit/5eb3768bf020d61d0ade767d62e13839048146e4))
* **amazonq:** send full finding details to plugin, partial to agent ([#2356](https://github.com/aws/language-servers/issues/2356)) ([961e6ca](https://github.com/aws/language-servers/commit/961e6ca11b122481685f9f65b3da14c6a2497cc4))
* improve history management ([#2312](https://github.com/aws/language-servers/issues/2312)) ([#2357](https://github.com/aws/language-servers/issues/2357)) ([e7aa2a6](https://github.com/aws/language-servers/commit/e7aa2a6545bcb1a8238abfde69a05432be0b6615))
* optimize memory bank token usage and add new tab support ([#2366](https://github.com/aws/language-servers/issues/2366)) ([3057d56](https://github.com/aws/language-servers/commit/3057d56e4a3047d1715d6e3560e9f934d1de469c))
* private package mapping during artifact generation ([#2348](https://github.com/aws/language-servers/issues/2348)) ([d56bfa1](https://github.com/aws/language-servers/commit/d56bfa191954fac8068e2bf390c2d0b88ef8b168))
* trim new line when emitting error message ([#2359](https://github.com/aws/language-servers/issues/2359)) ([d8733a7](https://github.com/aws/language-servers/commit/d8733a75487f74815302b838802eccbf3ffec55e))


### Reverts

* fix to add opt-out header to streaming client ([#2365](https://github.com/aws/language-servers/issues/2365)) ([#2370](https://github.com/aws/language-servers/issues/2370)) ([b29478f](https://github.com/aws/language-servers/commit/b29478fa1ecc58e331ff330ff79f46b0d8c38d9e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @aws/lsp-core bumped from ^0.0.15 to ^0.0.16

## [0.0.82](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.81...lsp-codewhisperer/v0.0.82) (2025-09-24)


### Features

* memory bank support ([#2314](https://github.com/aws/language-servers/issues/2314)) ([0e215fc](https://github.com/aws/language-servers/commit/0e215fc0e475b4c40a8237492371716982d4d532))


### Bug Fixes

* **amazonq:** fix to emit event for same region profile switch ([#2320](https://github.com/aws/language-servers/issues/2320)) ([aa1a482](https://github.com/aws/language-servers/commit/aa1a4827871a1cfa9fcd76f7ba420107a5d44b01))
* **amazonq:** reduce number of findings to 30 as a quick fix ([#2318](https://github.com/aws/language-servers/issues/2318)) ([b31cf67](https://github.com/aws/language-servers/commit/b31cf67ddc68a2ca2e0a4ebd9ee94d0545afc656))
* **amazonq:** removing a bracket from full review message ([#2317](https://github.com/aws/language-servers/issues/2317)) ([6d321ac](https://github.com/aws/language-servers/commit/6d321ac6f318c27b01f9f97eee45a62798a60cf5))
* emit error code on failed user messages ([#2322](https://github.com/aws/language-servers/issues/2322)) ([a949ac0](https://github.com/aws/language-servers/commit/a949ac0a9d7a4dbce5fb7c8480952cee0a674b55))
* inline latency telemetry should account for preprocess time ([#2323](https://github.com/aws/language-servers/issues/2323)) ([68c6d14](https://github.com/aws/language-servers/commit/68c6d1465a3325612052740496cc1e6e50f56b9a))
* userTriggerDecision STE suggestionType validation error ([#2313](https://github.com/aws/language-servers/issues/2313)) ([8f30ac0](https://github.com/aws/language-servers/commit/8f30ac0ec5f4f7b7c343f5e889aec64a282897ea))

## [0.0.81](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.80...lsp-codewhisperer/v0.0.81) (2025-09-19)


### Bug Fixes

* **amazonq:** fix for delete mcp for mcp config, disable and create corresponding agent file ([#2298](https://github.com/aws/language-servers/issues/2298)) ([8641860](https://github.com/aws/language-servers/commit/8641860295c4e089d09154fa5411c305f2f4ecce))
* **amazonq:** fix for legacy mcp permission consistentcy and config update ([#2300](https://github.com/aws/language-servers/issues/2300)) ([c8aa7bd](https://github.com/aws/language-servers/commit/c8aa7bd3e9d39ed327972bbc950ad72e8e401581))
* **amazonq:** fix for mcp permissions read/write inconsistencies ([#2296](https://github.com/aws/language-servers/issues/2296)) ([c7a9a8e](https://github.com/aws/language-servers/commit/c7a9a8e1ba5c1a284d661e683dd46133860a1d3d))
* **amazonq:** fix to add filewatcher for mcp config files ([#2295](https://github.com/aws/language-servers/issues/2295)) ([fcee77c](https://github.com/aws/language-servers/commit/fcee77c1b06e69f9096d8e98a0cfcc42d7fddb01))
* **amazonq:** fix to normlize workspace paths in windows ([#2306](https://github.com/aws/language-servers/issues/2306)) ([fab073c](https://github.com/aws/language-servers/commit/fab073c855109b15005bfd880894471c35652ffc))
* **amazonq:** improve messaging for code review ([#2303](https://github.com/aws/language-servers/issues/2303)) ([60bc68d](https://github.com/aws/language-servers/commit/60bc68d1d4d2ce8a0373be6ce7551e961fc2cdb8))
* **amazonq:** support mcp config files for backwards compatbility ([#2292](https://github.com/aws/language-servers/issues/2292)) ([41c99af](https://github.com/aws/language-servers/commit/41c99af02b3f415e39898f11c3c21ac530f9c406))
* inline UTD empty cases dont differentiate Edit and Completion ([#2287](https://github.com/aws/language-servers/issues/2287)) ([84e2c8c](https://github.com/aws/language-servers/commit/84e2c8c12f5d828192a302fa11483063d33b059c))
* inline UTD telemetry empty cases dont differentiate Edit and Completion ([#2288](https://github.com/aws/language-servers/issues/2288)) ([d207b6e](https://github.com/aws/language-servers/commit/d207b6e9dfded650c6f65c675ee45c52f8222571))
* quick fix for repeated logging from squashed commit ([#2291](https://github.com/aws/language-servers/issues/2291)) ([36f3eed](https://github.com/aws/language-servers/commit/36f3eedd1cad3fca4fc48792ba40b6470f733bfa))


### Reverts

* inline UTD telemetry empty cases dont differentiate Edit and Completion ([#2288](https://github.com/aws/language-servers/issues/2288)) ([#2297](https://github.com/aws/language-servers/issues/2297)) ([eb081e6](https://github.com/aws/language-servers/commit/eb081e6bc6bef4182ab89e295bff97c4e828096b))

## [0.0.80](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.79...lsp-codewhisperer/v0.0.80) (2025-09-16)


### Features

* **amazonq:** semantic search tool integration ([#2283](https://github.com/aws/language-servers/issues/2283)) ([8eb3c34](https://github.com/aws/language-servers/commit/8eb3c340534f3c66fd9082a83b31e84a4d9348bb))
* **amazonq:** support for wildcard permissions from agent config ([#2249](https://github.com/aws/language-servers/issues/2249)) ([2f6e86b](https://github.com/aws/language-servers/commit/2f6e86b0a676674744b962b0e335543c6c39e9e1))
* support sending requests with the 'external_idp' type ([#2247](https://github.com/aws/language-servers/issues/2247)) ([4d3b938](https://github.com/aws/language-servers/commit/4d3b938b7e961def0db2a51fba57e8fe73ea0a01))


### Bug Fixes

* filetype filtering and consolidation of other filtering logic during artifact generation ([#2233](https://github.com/aws/language-servers/issues/2233)) ([a3e66f2](https://github.com/aws/language-servers/commit/a3e66f2d414060adde90cc7312f07c6359ae3246))

## [0.0.79](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.78...lsp-codewhisperer/v0.0.79) (2025-09-10)


### Features

* feature to add iam inline suggestion support in codeWhispererservice ([#2223](https://github.com/aws/language-servers/issues/2223)) ([8e19f19](https://github.com/aws/language-servers/commit/8e19f19a71e63a1196f4cb67ded8360c8da8129e))

## [0.0.78](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.77...lsp-codewhisperer/v0.0.78) (2025-09-09)


### Features

* add custom_transformation folder support to artifact.zip ([#2201](https://github.com/aws/language-servers/issues/2201)) ([1222905](https://github.com/aws/language-servers/commit/12229059421b773d3e99d28809fdff4abf242b26))
* add support for getSupplementalContext LSP API ([#2212](https://github.com/aws/language-servers/issues/2212)) ([2ddcae7](https://github.com/aws/language-servers/commit/2ddcae7a4fac6b89cbc9784911959743ea0a6d11))
* **amazonq:** default to diff-based scans ([#2195](https://github.com/aws/language-servers/issues/2195)) ([da4c3db](https://github.com/aws/language-servers/commit/da4c3db5329bd50cfe249bf8c1d59afa9bcb0157))
* model selection for code review tool ([#2196](https://github.com/aws/language-servers/issues/2196)) ([34bc9bd](https://github.com/aws/language-servers/commit/34bc9bd1d3433bbb1d903eb0f212b10709ea8412))


### Bug Fixes

* **amazonq:** add IntelliSense autotriggerType ([#2199](https://github.com/aws/language-servers/issues/2199)) ([013aa59](https://github.com/aws/language-servers/commit/013aa5913c242451a91ed36b0dcf961a3f8ec697))
* **amazonq:** fix to correct the client for getProfile request ([#2211](https://github.com/aws/language-servers/issues/2211)) ([8bde8c9](https://github.com/aws/language-servers/commit/8bde8c97e1e3bcd67d9816a3385c50c7765c3b2f))
* **amazonq:** fix to update MCP servers list when last server is removed from agent config ([#2206](https://github.com/aws/language-servers/issues/2206)) ([512502a](https://github.com/aws/language-servers/commit/512502af947dcfed9288be2f67fc58affd4445fe))
* **amazonq:** update to the agent config format to bring parity with Q CLI ([#2202](https://github.com/aws/language-servers/issues/2202)) ([698d06c](https://github.com/aws/language-servers/commit/698d06c643897da6ca37a49e6544b150b72678a3))
* potential xss issue reported in `mynah-ui` ([#2209](https://github.com/aws/language-servers/issues/2209)) ([cf585cd](https://github.com/aws/language-servers/commit/cf585cd400dab6274f8220139ae94287c0d96824))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @aws/lsp-core bumped from ^0.0.14 to ^0.0.15

## [0.0.77](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.76...lsp-codewhisperer/v0.0.77) (2025-09-02)


### Features

* passing suggestionTypes and pluginVersion/lspVersion to STE ([#2180](https://github.com/aws/language-servers/issues/2180)) ([66742ad](https://github.com/aws/language-servers/commit/66742adfc44f33efbd8dd33b803000e08241e5ce))


### Bug Fixes

* auto trigger should only respect previous decisions in the past 2mins ([#2189](https://github.com/aws/language-servers/issues/2189)) ([852b21b](https://github.com/aws/language-servers/commit/852b21b66f793102c52e35c2baec07a772e5134a))
* compact UI is not updated correctly when multiple nudges are displayed ([#2192](https://github.com/aws/language-servers/issues/2192)) ([ef7d793](https://github.com/aws/language-servers/commit/ef7d7931954f5083e4a5c358e67c6dc652fa1a40))
* emit acceptedLineCount metric and AgenticCodeAccepted interaction type ([#2167](https://github.com/aws/language-servers/issues/2167)) ([c53f672](https://github.com/aws/language-servers/commit/c53f672b6173ebda530917ccb4e0c2f26f5c8f79))
* emit errorMessage in addMessage ([#2197](https://github.com/aws/language-servers/issues/2197)) ([58f2064](https://github.com/aws/language-servers/commit/58f20649d345f159080006120e23cde559826df1))
* fix calculation for num-lines contributed by the LLM ([#2191](https://github.com/aws/language-servers/issues/2191)) ([fd71e6c](https://github.com/aws/language-servers/commit/fd71e6cf3fc843242936564061061418edf83f56))
* should send classifier score after taking sigmoid ([#2188](https://github.com/aws/language-servers/issues/2188)) ([f4e2e6e](https://github.com/aws/language-servers/commit/f4e2e6e885e665834a5d7b7cbb5f4ba4ff9bbb65))


### Performance Improvements

* only process edit requests 1 at a time ([#2187](https://github.com/aws/language-servers/issues/2187)) ([b497540](https://github.com/aws/language-servers/commit/b4975409a3ed518550290b72ac310895a293be4b))


### Reverts

* PR 2172 dedupe openTabs supplemental contexts ([#2194](https://github.com/aws/language-servers/issues/2194)) ([94723d4](https://github.com/aws/language-servers/commit/94723d46073a1ea8211e7ae8f9dfce3fcb809604))

## [0.0.76](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.75...lsp-codewhisperer/v0.0.76) (2025-08-27)


### Features

* add basic OAuth client for remote MCP ([#2136](https://github.com/aws/language-servers/issues/2136)) ([2fb896e](https://github.com/aws/language-servers/commit/2fb896e094de0bc5a1b4881067e7dcceb3826015))
* **amazonq:** emit metric for each issue ([#2179](https://github.com/aws/language-servers/issues/2179)) ([5a3f481](https://github.com/aws/language-servers/commit/5a3f481ebe8c6033e3833abcd81799d26c2aa03e))
* Auto fetch models from listAvailableModels API ([#2171](https://github.com/aws/language-servers/issues/2171)) ([8600c52](https://github.com/aws/language-servers/commit/8600c524877abb459e9338399352446c0dcff6f0))
* disable pkce flow during plugin load ([#2153](https://github.com/aws/language-servers/issues/2153)) ([71b3595](https://github.com/aws/language-servers/commit/71b35952333e7581921644ce40fabbc1e6d3c02f))
* update MCP manager and utilities ([#2158](https://github.com/aws/language-servers/issues/2158)) ([b99df82](https://github.com/aws/language-servers/commit/b99df82826d0ba1a1d52df578cb80674c90505b9))


### Bug Fixes

* adding streakTracker to track streakLength across Completions and Edits ([#2147](https://github.com/aws/language-servers/issues/2147)) ([a6c64f2](https://github.com/aws/language-servers/commit/a6c64f2995a17697e3d71d30a1f411f5cf0db279))
* **amazonq:** dedupe openTabs supplemental contexts ([#2172](https://github.com/aws/language-servers/issues/2172)) ([aa87ae2](https://github.com/aws/language-servers/commit/aa87ae2bd95edc1f38bf90f56093c5bf5ff18c53))
* **amazonq:** fix for mcp servers operations to edit server config only ([#2165](https://github.com/aws/language-servers/issues/2165)) ([d28df09](https://github.com/aws/language-servers/commit/d28df09ae41871430cd53064eac1f3050c95ea84))
* **amazonq:** fix to add mcp server tool error handling and status for card ([#2176](https://github.com/aws/language-servers/issues/2176)) ([23f5ec3](https://github.com/aws/language-servers/commit/23f5ec343cb4e0de32926204dbcf99e51af829f9))
* **amazonq:** status message update for mcp tool permission accpetance ([#2178](https://github.com/aws/language-servers/issues/2178)) ([4893344](https://github.com/aws/language-servers/commit/489334466fa084774d6e4737569468d654dc6359))
* fix pkce windows url path ([#2173](https://github.com/aws/language-servers/issues/2173)) ([d7b184c](https://github.com/aws/language-servers/commit/d7b184cb12979877722fa0293e9aebec91ff2c18))
* multiple fixes on auth flow edge cases ([#2155](https://github.com/aws/language-servers/issues/2155)) ([472220a](https://github.com/aws/language-servers/commit/472220a745cff4fe91a2cabae4ae059a164ceddd))
* reduce auto trigger frequency for VSC ([#2168](https://github.com/aws/language-servers/issues/2168)) ([00e11ff](https://github.com/aws/language-servers/commit/00e11ff48eafaa0baec48177fa4aa6d60048af2f))


### Reverts

* reduce auto trigger frequency for VSC ([#2168](https://github.com/aws/language-servers/issues/2168))" ([#2177](https://github.com/aws/language-servers/issues/2177)) ([08720c6](https://github.com/aws/language-servers/commit/08720c6c3fa83f9b3b6775d4ae4d848ce145b94b))

## [0.0.75](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.74...lsp-codewhisperer/v0.0.75) (2025-08-21)


### Bug Fixes

* **amazonq:** don't let flare send discard for the still valid suggestion in JB ([#2145](https://github.com/aws/language-servers/issues/2145)) ([0767e07](https://github.com/aws/language-servers/commit/0767e074c91682a91d2fe7a6b2a7369c4dea280c))

## [0.0.74](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.73...lsp-codewhisperer/v0.0.74) (2025-08-19)


### Features

* **amazonq:** added mcp admin level configuration with GetProfile ([#2000](https://github.com/aws/language-servers/issues/2000)) ([fd6e9a8](https://github.com/aws/language-servers/commit/fd6e9a829c6229c276de5340dffce52b426a864d))
* **amazonq:** read tool ui revamp ([#2113](https://github.com/aws/language-servers/issues/2113)) ([#2121](https://github.com/aws/language-servers/issues/2121)) ([93cf229](https://github.com/aws/language-servers/commit/93cf229149ba60491f9f5763793db4a9f570b611))
* remove project type validation from LSP layer ([#2103](https://github.com/aws/language-servers/issues/2103)) ([d397161](https://github.com/aws/language-servers/commit/d397161cc3448c63016e27f5ac2a1917cdaae1cb))


### Bug Fixes

* **amazonq:** add server side control for WCS features ([#2128](https://github.com/aws/language-servers/issues/2128)) ([5e4435d](https://github.com/aws/language-servers/commit/5e4435dfaea7bf8c00e6a27b9bb0d40f699d4e01))
* **amazonq:** fix regression of mcp config in agent config ([#2101](https://github.com/aws/language-servers/issues/2101)) ([e4e8bbb](https://github.com/aws/language-servers/commit/e4e8bbb89e4b597926582bead2b14ffc43f2a7f8))
* **amazonq:** handle case where multiple rules are provided with the same name ([#2118](https://github.com/aws/language-servers/issues/2118)) ([0e23e2d](https://github.com/aws/language-servers/commit/0e23e2d29b8cad14403d372b9bbb08ca8ffa7ac7))
* **amazonq:** persist mcp configs in agent json on start-up ([#2112](https://github.com/aws/language-servers/issues/2112)) ([817cfe2](https://github.com/aws/language-servers/commit/817cfe2656cb1deec6111c699c4ba46b4ba53e00))
* empty userTriggerDecision not being sent for NEP code path ([#2140](https://github.com/aws/language-servers/issues/2140)) ([b8e5268](https://github.com/aws/language-servers/commit/b8e52682ac2b2337e1d0a32759e8beccde889cee))
* fix for button text and remove profilearn caching ([#2137](https://github.com/aws/language-servers/issues/2137)) ([2a4171a](https://github.com/aws/language-servers/commit/2a4171a74c15c23c23c481060496162bcc9e6284))
* fix to add disk caching for mcp admin state ([#2139](https://github.com/aws/language-servers/issues/2139)) ([f947e1a](https://github.com/aws/language-servers/commit/f947e1a9da4431d6089b22825f992010c30a470b))
* fix to turn on and off MCP servers incase of error based on last state ([#2143](https://github.com/aws/language-servers/issues/2143)) ([04588df](https://github.com/aws/language-servers/commit/04588dfc33f0d85dbd488814a474b5e354398df0))
* proper path handling for additional context ([#2129](https://github.com/aws/language-servers/issues/2129)) ([971eaa5](https://github.com/aws/language-servers/commit/971eaa505d948e9d2090c85f9b965f554ea7f2c8))
* Use file context override in the inline completion params for Jupyter Notebook ([#2114](https://github.com/aws/language-servers/issues/2114)) ([91c8398](https://github.com/aws/language-servers/commit/91c839857f8aa4d79098189f9fb620b361c51289))


### Performance Improvements

* remove edit completion retry mechanism on document change ([#2124](https://github.com/aws/language-servers/issues/2124)) ([963b6e9](https://github.com/aws/language-servers/commit/963b6e9b7887da23a85a826c55a6ed95ff36d956))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @aws/lsp-core bumped from ^0.0.13 to ^0.0.14

## [0.0.73](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.72...lsp-codewhisperer/v0.0.73) (2025-08-11)


### Features

* **amazonq:** read tool ui revamp ([c65428b](https://github.com/aws/language-servers/commit/c65428bab2cf5e47badf1e3a9453babcf881e60c))


### Bug Fixes

* **amazonq:** add fallback classpath generation ([#2077](https://github.com/aws/language-servers/issues/2077)) ([3a6ef14](https://github.com/aws/language-servers/commit/3a6ef14e78fa2e75b837bba6524751d65038f416))
* **amazonq:** emit failed status for amazonq_invokeLLM ([#2071](https://github.com/aws/language-servers/issues/2071)) ([ee52a41](https://github.com/aws/language-servers/commit/ee52a41bc869b275fff708d7955b59f43b93bbd4))
* **amazonq:** fix fallout of [#2051](https://github.com/aws/language-servers/issues/2051) ([#2057](https://github.com/aws/language-servers/issues/2057)) ([565066b](https://github.com/aws/language-servers/commit/565066bb61adda60333c9646db958d4208bcc8af))
* **amazonq:** leverage lcs to find the chars added and removed ([#2092](https://github.com/aws/language-servers/issues/2092)) ([40379a8](https://github.com/aws/language-servers/commit/40379a887f8d42cc184239ca3175b4e673cc5286))
* **amazonq:** skips continuous monitoring when WCS sees workspace as idle ([#2066](https://github.com/aws/language-servers/issues/2066)) ([9cb959d](https://github.com/aws/language-servers/commit/9cb959d4cc450d0907f8bf5265ba01d2aa68bcd0))
* creating a new sesion for Edits trigger with next token ([#2094](https://github.com/aws/language-servers/issues/2094)) ([1da8730](https://github.com/aws/language-servers/commit/1da8730b6ed6ad53b6561368bf722e56d59596a4))
* remove edit cache logic ([#2079](https://github.com/aws/language-servers/issues/2079)) ([9bc5b9c](https://github.com/aws/language-servers/commit/9bc5b9c1d77e5fee6f518f7f5016d3a0043a5a77))
* sessionManager misused because there are 2 types of manager now ([#2090](https://github.com/aws/language-servers/issues/2090)) ([8db059a](https://github.com/aws/language-servers/commit/8db059ab83d94fd7c3ba3eb265044add31c80aea))
* update client name to support Sagemaker AI origin for agentic chat ([#2093](https://github.com/aws/language-servers/issues/2093)) ([a746fe8](https://github.com/aws/language-servers/commit/a746fe845d5e09563b475f01ce44059dca9fd10f))

## [0.0.72](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.71...lsp-codewhisperer/v0.0.72) (2025-08-06)


### Features

* add support for SMUS Q CodeEditor client to send MD IDE origin ([#2032](https://github.com/aws/language-servers/issues/2032)) ([a8725b4](https://github.com/aws/language-servers/commit/a8725b4b7dcb7718864620721aa3633151e8877b))
* **amazonq:** enable sonnet 4 for fra region ([#2069](https://github.com/aws/language-servers/issues/2069)) ([3a4b8df](https://github.com/aws/language-servers/commit/3a4b8df981b2c3b0532360a11472169fffec7924))


### Bug Fixes

* **amazonq:** add distinctive identifier for cloud trail ([#2059](https://github.com/aws/language-servers/issues/2059)) ([18bbc2c](https://github.com/aws/language-servers/commit/18bbc2c54f5cc72e2624020fc17214c448926b0e))
* **amazonq:** fix to add disable/enable feature back to mcp servers ([#2052](https://github.com/aws/language-servers/issues/2052)) ([c03e017](https://github.com/aws/language-servers/commit/c03e017b9ccbbbb9c80a3c3afd5da38a50bd6cff))
* **amazonq:** make display findings tool run more often ([#2067](https://github.com/aws/language-servers/issues/2067)) ([479ccd0](https://github.com/aws/language-servers/commit/479ccd0a1b8b7e98684275c66274d284599c5933))
* outdated history when trimming happens, add missing metric for compaction ([#2047](https://github.com/aws/language-servers/issues/2047)) ([8390f66](https://github.com/aws/language-servers/commit/8390f6686c804dfbeff91018635df21e9dd89236))
* should keep reporting UTDE telemetry if there are still pending Edits suggestions ([#2051](https://github.com/aws/language-servers/issues/2051)) ([78c67b1](https://github.com/aws/language-servers/commit/78c67b1a29821f54006d160695e997870d17f3b5))

## [0.0.71](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.70...lsp-codewhisperer/v0.0.71) (2025-08-04)


### Features

* adding inline chat telemetry ([#2001](https://github.com/aws/language-servers/issues/2001)) ([8b1c9c7](https://github.com/aws/language-servers/commit/8b1c9c7c3859cdfbbd0abb059066a5c6fe2ffaf2))
* **amazonq:** implement displayFindings tool ([#2029](https://github.com/aws/language-servers/issues/2029)) ([da11663](https://github.com/aws/language-servers/commit/da1166340f3d13e1d7fd83b260359661443230ea))
* improve code review tool reliability and error handling ([#2033](https://github.com/aws/language-servers/issues/2033)) ([124244e](https://github.com/aws/language-servers/commit/124244ee7d97adf71a52c4fde7ddb908dbc0bd08))
* support http transport without authorization for MCP ([97e806c](https://github.com/aws/language-servers/commit/97e806ce7ea5e5be1fd60c4a4d9a54cf76c8f8cb))


### Bug Fixes

* add bash command parsing for telemetry metrics ([#2039](https://github.com/aws/language-servers/issues/2039)) ([01d8112](https://github.com/aws/language-servers/commit/01d811225281a2e32f9cd6dab1b575aad8c0b4d6))
* adding acceptedCharacterCount to UserTriggerDecisionEvent ([#2014](https://github.com/aws/language-servers/issues/2014)) ([3f94486](https://github.com/aws/language-servers/commit/3f944865483a6913138335fe61eee70ae71d7c03))
* adjust bash command categories ([#2030](https://github.com/aws/language-servers/issues/2030)) ([25ed99f](https://github.com/aws/language-servers/commit/25ed99fcf0eeaa86b0a5e040e90d69becf625c71))
* adjust cross file context config ([#2011](https://github.com/aws/language-servers/issues/2011)) ([f7ade37](https://github.com/aws/language-servers/commit/f7ade3767e714d5178f24fd9cc90349c5f417979))
* **amazonq:** fix for mcp server permissions ([#2026](https://github.com/aws/language-servers/issues/2026)) ([89ae720](https://github.com/aws/language-servers/commit/89ae720dc036a90338d192aca801a858e8fa19f8))
* **amazonq:** fix for mcp server permissions to prefer workspace agent config files ([#2038](https://github.com/aws/language-servers/issues/2038)) ([d2ac614](https://github.com/aws/language-servers/commit/d2ac614f0f16faa8bf689ac9c8bff09d64fc3a3b))
* **amazonq:** fix processing empty unsupported workspace file ([#2017](https://github.com/aws/language-servers/issues/2017)) ([9e4d0af](https://github.com/aws/language-servers/commit/9e4d0af244b5edba73771b6cb4290d922ef83c43))
* correct the implementation of gathering open tabs in cross file context ([#2040](https://github.com/aws/language-servers/issues/2040)) ([b7b7a2b](https://github.com/aws/language-servers/commit/b7b7a2bd2020f50069ce89f6505cc2a36b1f3fa7))
* remove malicious characters from prompt input ([#2009](https://github.com/aws/language-servers/issues/2009)) ([bf8a1e6](https://github.com/aws/language-servers/commit/bf8a1e6136801532132f2bf82def4ca5bf49c82f))
* sanitize request input ([#2025](https://github.com/aws/language-servers/issues/2025)) ([7c0efd7](https://github.com/aws/language-servers/commit/7c0efd73d5e9a0e3f42d143a10c16782f6e35db8))
* skip image sanitization ([#2031](https://github.com/aws/language-servers/issues/2031)) ([f02fc23](https://github.com/aws/language-servers/commit/f02fc231136940bd644c426d2b222ae2cba779c4))
* sometimes Enter does not auto trigger ([#2005](https://github.com/aws/language-servers/issues/2005)) ([c9af035](https://github.com/aws/language-servers/commit/c9af0353a6c6f3b2ca4eead02f19e8ab5ddb8ef1))
* use fast glob streaming when collecting files ([#2003](https://github.com/aws/language-servers/issues/2003)) ([f7c0a0b](https://github.com/aws/language-servers/commit/f7c0a0b0ef9ce3ecd620acfef00e55745db3d71f))
* use new language server runtime ([#2023](https://github.com/aws/language-servers/issues/2023)) ([83ea1e4](https://github.com/aws/language-servers/commit/83ea1e42fe52990696eb9b878fa11e2c5331bec5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @aws/lsp-core bumped from ^0.0.12 to ^0.0.13

## [0.0.70](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.69...lsp-codewhisperer/v0.0.70) (2025-07-29)


### Features

* **amazonq:** add new model error handling code ([#1972](https://github.com/aws/language-servers/issues/1972)) ([905f0fc](https://github.com/aws/language-servers/commit/905f0fcbb274926d22bcf30600ad4bd419ac8ee4))
* **amazonq:** enable compaction, minor UI changes ([#1979](https://github.com/aws/language-servers/issues/1979)) ([2b56ca8](https://github.com/aws/language-servers/commit/2b56ca87f442a06b554043fee86edd79f96c638d))
* **amazonq:** enhance workspaceContext classpath generation ([#1955](https://github.com/aws/language-servers/issues/1955)) ([f7ed20b](https://github.com/aws/language-servers/commit/f7ed20bc4010996c508f6ea8ca87950e117e43c1))
* **amazonq:** redirect /review, rename CodeReview tool, emit metrics, modify prompts ([#1964](https://github.com/aws/language-servers/issues/1964)) ([ad8e2db](https://github.com/aws/language-servers/commit/ad8e2db77e34f369fef9af71cdda2d3522f555c6))
* **amazonq:** revert auto-approve ([#2002](https://github.com/aws/language-servers/issues/2002)) ([c8181f7](https://github.com/aws/language-servers/commit/c8181f7a1de224dfcc7a77cd0bfc905fa1018372))
* enhance profile fetching logs to diagnose developerProfiles errors ([#1969](https://github.com/aws/language-servers/issues/1969)) ([eb688c2](https://github.com/aws/language-servers/commit/eb688c272df1251cd5c14ada7894bcaf625b6453))


### Bug Fixes

* **amazonq:** wrong path in the logs for the function ([#1978](https://github.com/aws/language-servers/issues/1978)) ([ed8b4f6](https://github.com/aws/language-servers/commit/ed8b4f6755accb624e7dc8c645ecd5cd9370a0f2))
* emit metric for tool error ([#1954](https://github.com/aws/language-servers/issues/1954)) ([c3bbcea](https://github.com/aws/language-servers/commit/c3bbceabcea3d7aea2e414abc632c3a744b0e02b))
* enable repomap for all users ([#1967](https://github.com/aws/language-servers/issues/1967)) ([6954085](https://github.com/aws/language-servers/commit/69540851e54b65729b2affbe3ae7d98629bdb5f4))
* move network commands out of ro category ([#1985](https://github.com/aws/language-servers/issues/1985)) ([3cc9fd9](https://github.com/aws/language-servers/commit/3cc9fd91ae2f78ee28e224d5390ba78509de3615))
* remove malicious characters from MCP tool description ([#1977](https://github.com/aws/language-servers/issues/1977)) ([64d4e3e](https://github.com/aws/language-servers/commit/64d4e3ebade706b01d256682cafe8d4ff8b85f41))

## [0.0.69](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.68...lsp-codewhisperer/v0.0.69) (2025-07-23)


### Features

* enable webforms to blazor transformation via validation bypass ([#1929](https://github.com/aws/language-servers/issues/1929)) ([528f820](https://github.com/aws/language-servers/commit/528f8206b101e8f0c785b7fc0aceb87d6ef3de7b))


### Bug Fixes

* **amazonq:** revert commit f17b631d9e06371a11ef8e9cb1413762fb51a143 ([#1965](https://github.com/aws/language-servers/issues/1965)) ([8c2cab6](https://github.com/aws/language-servers/commit/8c2cab6995922c96030b5bbdf3cbbdef7eadd7c2))
* **amazonq:** stop continuous monitor when WCS sees ServiceQuotaExceeded ([#1957](https://github.com/aws/language-servers/issues/1957)) ([81e19b9](https://github.com/aws/language-servers/commit/81e19b97017edddf486ac92fa6a8dc5fb184e008))
* fix for mcp delete to remove it from mcp config file ([#1956](https://github.com/aws/language-servers/issues/1956)) ([ad71312](https://github.com/aws/language-servers/commit/ad713122fcb9da90c17301f1312de13ba1d28d01))


### Reverts

* revert for all commits for emergency deployment ([#1966](https://github.com/aws/language-servers/issues/1966)) ([519f75d](https://github.com/aws/language-servers/commit/519f75d22466b72702793b4f1d1ed846c02bbd14))

## [0.0.68](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.67...lsp-codewhisperer/v0.0.68) (2025-07-22)


### Features

* **amazonq:** enable show logs feature ([#1947](https://github.com/aws/language-servers/issues/1947)) ([86ea83d](https://github.com/aws/language-servers/commit/86ea83dd53b447f6decccf16559b76f4989ea712))

## [0.0.67](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.66...lsp-codewhisperer/v0.0.67) (2025-07-22)


### Features

* adding extra context as a workspace config for inline chat ([#1942](https://github.com/aws/language-servers/issues/1942)) ([1b402bb](https://github.com/aws/language-servers/commit/1b402bb8b083c5505a4e13ecf7e097a43388d10b))
* **chat-client:** add auto-approve (trust mode) for built-in tools ([#1949](https://github.com/aws/language-servers/issues/1949)) ([f17b631](https://github.com/aws/language-servers/commit/f17b631d9e06371a11ef8e9cb1413762fb51a143))
* **chat-client:** add shortcut for stop/reject/run commands ([#1932](https://github.com/aws/language-servers/issues/1932)) ([087f338](https://github.com/aws/language-servers/commit/087f3387ba736e92d014274e195f7ef76e377f1e))


### Bug Fixes

* **amazonq:** add image context to chat history ([#1859](https://github.com/aws/language-servers/issues/1859)) ([788920b](https://github.com/aws/language-servers/commit/788920bdd2de0448fd335734b62ac80aba9cff82))
* **amazonq:** avoid workspace context server missing historical dependency events ([#1946](https://github.com/aws/language-servers/issues/1946)) ([3362956](https://github.com/aws/language-servers/commit/3362956ded75d77296fa98abb172bd87d66e5d5e))
* **amazonq:** continueous edits trigger returns earlier as first session is already closed ([#1907](https://github.com/aws/language-servers/issues/1907)) ([a2dc5a8](https://github.com/aws/language-servers/commit/a2dc5a87e488e523c12270b98749c1f835b55e87))
* **amazonq:** fix for mcp server unnecessary refresh from file watchers ([#1933](https://github.com/aws/language-servers/issues/1933)) ([208909b](https://github.com/aws/language-servers/commit/208909b55ecda40ff8d412b2b3be890eccee70bc))
* **amazonq:** make JSTSDependencyHandler process scoped packages correctly ([#1910](https://github.com/aws/language-servers/issues/1910)) ([3034494](https://github.com/aws/language-servers/commit/303449454254987047649c49b7a377d45ad284b6))
* **amazonq:** update mcp and persona config to agent config ([#1897](https://github.com/aws/language-servers/issues/1897)) ([530977f](https://github.com/aws/language-servers/commit/530977f8c73c7946a0205f02014248d71b4b1fe0))
* bug for credential refresh in StreamingClientServiceIAM ([#1944](https://github.com/aws/language-servers/issues/1944)) ([a69ec0c](https://github.com/aws/language-servers/commit/a69ec0c63423187c96bdd2b03d14da8a723c192e))
* fix blocking regex calls being made before indexing ([#1916](https://github.com/aws/language-servers/issues/1916)) ([3c0592f](https://github.com/aws/language-servers/commit/3c0592fec53922b0493f51b7e88313971cb54e93))
* fix to remove config from agent file for failed initialization ([#1948](https://github.com/aws/language-servers/issues/1948)) ([45645c2](https://github.com/aws/language-servers/commit/45645c2cd7c241c54ddfebced6f377f38e077957))
* Make the classifier of auto trigger output the same score as the IDE auto trigger classifier ([#1930](https://github.com/aws/language-servers/issues/1930)) ([be3231f](https://github.com/aws/language-servers/commit/be3231f27d545daf137df149e5f9fd23042c82a9))
* put compaction feature behind a feature flag ([#1945](https://github.com/aws/language-servers/issues/1945)) ([51f4161](https://github.com/aws/language-servers/commit/51f4161571679408d6b11b61d70d8027097a6ef6))
* remove hardcoded EDITS predictionTypes for trigger on acceptance ([#1937](https://github.com/aws/language-servers/issues/1937)) ([8ef7986](https://github.com/aws/language-servers/commit/8ef7986424dc4ced8e7414c1378dfca872150fb4))
* replace cancel with stop ([#1935](https://github.com/aws/language-servers/issues/1935)) ([2f51923](https://github.com/aws/language-servers/commit/2f51923f9d3497469c70162235482b569e2d796e))
* update ChatHandlers before adding new types dependency ([#1925](https://github.com/aws/language-servers/issues/1925)) ([e94e581](https://github.com/aws/language-servers/commit/e94e581a00fb99d862527ee7b91bf37ef47f4013))

## [0.0.66](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.65...lsp-codewhisperer/v0.0.66) (2025-07-17)


### Features

* add active user tracking with state persistence ([#1892](https://github.com/aws/language-servers/issues/1892)) ([a5587c5](https://github.com/aws/language-servers/commit/a5587c59e4a07074ad8afba930c6596dc28c693b))
* add conversation compaction ([#1895](https://github.com/aws/language-servers/issues/1895)) ([8bb7144](https://github.com/aws/language-servers/commit/8bb7144e45cfce6cc9337fd49de7edbee61105b8))
* adding streakLength back to UTDE telemetry ([#1902](https://github.com/aws/language-servers/issues/1902)) ([152f1c5](https://github.com/aws/language-servers/commit/152f1c5f23698f8c574120bcf4f2214e4540e7e6))


### Bug Fixes

* add proper encoding support for shell output ([#1903](https://github.com/aws/language-servers/issues/1903)) ([44a6d62](https://github.com/aws/language-servers/commit/44a6d629af7702662a02f384a6a542c0d72ccc39))
* align auto trigger classifier with documentChangeEvent ([#1914](https://github.com/aws/language-servers/issues/1914)) ([f308e17](https://github.com/aws/language-servers/commit/f308e17912df0b8f03f4e655cc34f2f875f4e65c))
* **amazonq:** replacing image's large binary in log ([#1905](https://github.com/aws/language-servers/issues/1905)) ([a06ed62](https://github.com/aws/language-servers/commit/a06ed626e118c5f846e494630ef0577ce1ace628))
* editor state does not use the same language id as file context ([#1924](https://github.com/aws/language-servers/issues/1924)) ([c10866d](https://github.com/aws/language-servers/commit/c10866d70070173aba63be1c78945a4da6129018))
* pinned `@Code` symbols do not persist between IDE sessions ([#1887](https://github.com/aws/language-servers/issues/1887)) ([b5c715f](https://github.com/aws/language-servers/commit/b5c715ff5ee303c2d48ffb9c1c6c98a9d985e2f1))
* replace thinking with working and replace stop with cancel ([#1922](https://github.com/aws/language-servers/issues/1922)) ([371e731](https://github.com/aws/language-servers/commit/371e731545f7572d3356d061cd8b94db35e4c333))
* should trigger edits if one of the following lines is non-empty ([#1915](https://github.com/aws/language-servers/issues/1915)) ([b298602](https://github.com/aws/language-servers/commit/b2986026293e26bff0cacbaf1554999c12fb429c))
* treat `echo`/`find`/`grep` as mutating ([#1921](https://github.com/aws/language-servers/issues/1921)) ([ef801a3](https://github.com/aws/language-servers/commit/ef801a3b9c435c25899eaa3712cabf6d5c4b9922))
* use document change events for auto trigger classifier input ([#1912](https://github.com/aws/language-servers/issues/1912)) ([2204da6](https://github.com/aws/language-servers/commit/2204da6193f2030ee546f61c969b1a664d8025e3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @aws/lsp-core bumped from ^0.0.11 to ^0.0.12

## [0.0.65](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.64...lsp-codewhisperer/v0.0.65) (2025-07-15)


### Features

* **amazonq:** add a/b testing info into agenticChat toolkit metrics ([#1898](https://github.com/aws/language-servers/issues/1898)) ([6ab9b2c](https://github.com/aws/language-servers/commit/6ab9b2cef0125846c2f20fd8554f591808b59cd0))
* **amazonq:** added full system information to the logs ([#1875](https://github.com/aws/language-servers/issues/1875)) ([7795c6b](https://github.com/aws/language-servers/commit/7795c6b43274211731aa9bb295b41ec89db41a6d))
* **amazonq:** Adding QCodeReview tool to amazonQ ([#1882](https://github.com/aws/language-servers/issues/1882)) ([07e343b](https://github.com/aws/language-servers/commit/07e343b9fcef319bdbec80c48388e44b4b19269a))
* **amazonq:** allow opt-out for workspace context server ([#1867](https://github.com/aws/language-servers/issues/1867)) ([72b6d76](https://github.com/aws/language-servers/commit/72b6d76c5ed8e240aad6be80f65eab3497caaacf))
* **chat-client:** add built-in tool permission and enable auto-approve ([#1890](https://github.com/aws/language-servers/issues/1890)) ([03b59c8](https://github.com/aws/language-servers/commit/03b59c8fba58db0f6b6c387cf5d53227c3f54673))
* **chat-client:** handle keyboard shortcut for run/reject/stop shell commands and tooltips ([#1885](https://github.com/aws/language-servers/issues/1885)) ([f8e9461](https://github.com/aws/language-servers/commit/f8e94615b5ce8a3f4bf8837627fa4816a09cbef2))
* update UserTriggerDecisionEventStreakLengthInteger min value ([#1878](https://github.com/aws/language-servers/issues/1878)) ([e06f180](https://github.com/aws/language-servers/commit/e06f18017864ea33e316059a708cb87aa6d8c562))


### Bug Fixes

* **amazonq:** additional checks for binary and credential files ([#1866](https://github.com/aws/language-servers/issues/1866)) ([76656c9](https://github.com/aws/language-servers/commit/76656c9b2bb5080f64f581bb3b39cd55a3015bdf))
* **amazonq:** catch mcp initialization errors ([#1873](https://github.com/aws/language-servers/issues/1873)) ([afdd6a4](https://github.com/aws/language-servers/commit/afdd6a4bd1db7c3990a7a279ebbbfbe0640e27c3))
* **chat-client:** revert for add built-in tool permission and enable auto-approve ([#1890](https://github.com/aws/language-servers/issues/1890)) ([#1900](https://github.com/aws/language-servers/issues/1900)) ([34b41b8](https://github.com/aws/language-servers/commit/34b41b8f87c21d2ee6b98643339dbdfa71efcb77))
* **chat-client:** revert for amazon q keyboard shortcuts feature ([#1901](https://github.com/aws/language-servers/issues/1901)) ([522f8de](https://github.com/aws/language-servers/commit/522f8de6dba8dfa9b4363934cd7fcea905add1ce))
* Disable Concurrent inline completion handler ([#1880](https://github.com/aws/language-servers/issues/1880)) ([61eeb8c](https://github.com/aws/language-servers/commit/61eeb8c93b5454c5a99ebb79b5593007d08007e5))
* Forward slash shown in rules list in multi-root workspaces on windows ([#1855](https://github.com/aws/language-servers/issues/1855)) ([061caa6](https://github.com/aws/language-servers/commit/061caa6450946e20cd1630b92f9b6dada8058edd))


### Reverts

* adding streakLength back for UserTriggerDecisionEvent ([#1877](https://github.com/aws/language-servers/issues/1877)) ([b199100](https://github.com/aws/language-servers/commit/b199100153aa0629890c49e12a56efbb9c627154))

## [0.0.64](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.63...lsp-codewhisperer/v0.0.64) (2025-07-11)


### Bug Fixes

* **amazonq:** add files created by fsWrite tool to @Files list ([#1784](https://github.com/aws/language-servers/issues/1784)) ([cfeb3be](https://github.com/aws/language-servers/commit/cfeb3be43e425fae89d795cacad62031cc1ee029))
* **amazonq:** remove the deep copy logic in updateRequestInputWithToolResults ([#1870](https://github.com/aws/language-servers/issues/1870)) ([f209a15](https://github.com/aws/language-servers/commit/f209a15785106af43fd97bfa99b393a13d9a9bab))
* use absolute file path for shell ([#1871](https://github.com/aws/language-servers/issues/1871)) ([f863735](https://github.com/aws/language-servers/commit/f863735c8dc734a1af4b26fbe8b9c436a32c21ca))


### Reverts

* adding files on VSC windows properly triggers reindexing ([#1820](https://github.com/aws/language-servers/issues/1820))" ([#1860](https://github.com/aws/language-servers/issues/1860)) ([423cdbc](https://github.com/aws/language-servers/commit/423cdbc48d9439e29ba69c37dc289a739f83475f))
* revert: adding files on VSC windows properly triggers reindexing ([#18](https://github.com/aws/language-servers/issues/18)…" ([#1862](https://github.com/aws/language-servers/issues/1862)) ([8e0c88b](https://github.com/aws/language-servers/commit/8e0c88b91d4f04e3209bbe35ee5678793c94b0f1))

## [0.0.63](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.62...lsp-codewhisperer/v0.0.63) (2025-07-08)


### Features

* added file watchers to listen to mcp and persona config ([#1714](https://github.com/aws/language-servers/issues/1714)) ([4c5a7f8](https://github.com/aws/language-servers/commit/4c5a7f893bad37bea1946d37d06f57197c3ef04b))
* adding streakLength back for UserTriggerDecisionEvent ([#1841](https://github.com/aws/language-servers/issues/1841)) ([7052132](https://github.com/aws/language-servers/commit/7052132a5198944ef05ddbf857d622ba518e71da))
* **amazonq:** add transformation preferences functionality to input gen ([#1792](https://github.com/aws/language-servers/issues/1792)) ([095f737](https://github.com/aws/language-servers/commit/095f737b86e6234b2568c6d4deafbbb90967bdbc))
* **amazonq:** update workspace context server A/B testing filter ([#1830](https://github.com/aws/language-servers/issues/1830)) ([faeeee3](https://github.com/aws/language-servers/commit/faeeee3da7a8712f3501055ba8d485528185cdb6))
* **flags:** change flag name to enablewebformtransform([#1804](https://github.com/aws/language-servers/issues/1804)) ([3b6c3be](https://github.com/aws/language-servers/commit/3b6c3be7630248cd00c19c16637f016d799ef8d1))
* passing partialResultToken to onInlineCompletionHandler result for EDITS ([#1840](https://github.com/aws/language-servers/issues/1840)) ([270d5a3](https://github.com/aws/language-servers/commit/270d5a3c5adba6b49d938f310ac89ae9b7fbc401))
* support listAvailableModels server request ([#1808](https://github.com/aws/language-servers/issues/1808)) ([9f1ddb3](https://github.com/aws/language-servers/commit/9f1ddb327778dba6da49337b79c5fef19023b52d))


### Bug Fixes

* adding agenticcoding field to amazonqaddMessage metric([#1849](https://github.com/aws/language-servers/issues/1849)) ([d677c52](https://github.com/aws/language-servers/commit/d677c52c6139859bc0f2dd8e7ffe6a85b87db3f6))
* adding files on VSC windows properly triggers reindexing ([#1820](https://github.com/aws/language-servers/issues/1820)) ([0c2d8eb](https://github.com/aws/language-servers/commit/0c2d8eb7dd875dfe86d1b2d094ec53a2a1221b97))
* **amazonq:** allow taking .jpg file as image context, add image cont… ([#1814](https://github.com/aws/language-servers/issues/1814)) ([4d36fa4](https://github.com/aws/language-servers/commit/4d36fa4a0a04692dba720bc0288c6cee7f45a1fc))
* **amazonq:** change the customer UI message to out of the workspace ([#1822](https://github.com/aws/language-servers/issues/1822)) ([624def5](https://github.com/aws/language-servers/commit/624def51e4d9e21ee8d045ffe528455b69cdfecb))
* **amazonq:** change the image filter used in open file dialog ([#1838](https://github.com/aws/language-servers/issues/1838)) ([d9da4cb](https://github.com/aws/language-servers/commit/d9da4cbb7b1995ef43aaba1b7e67d26fd61a3c57))
* **amazonq:** fix to add upper limit validation for tool description ([#1760](https://github.com/aws/language-servers/issues/1760)) ([2d18a3b](https://github.com/aws/language-servers/commit/2d18a3ba69d22b26dea5170656d79b9eacc202b1))
* **amazonq:** fix typo in image context list ([#1836](https://github.com/aws/language-servers/issues/1836)) ([179b553](https://github.com/aws/language-servers/commit/179b553a1444201e696fd52e7705dc0c05154eab))
* **amazonq:** handle undefined paths gracefully and retry ([#1825](https://github.com/aws/language-servers/issues/1825)) ([c52b017](https://github.com/aws/language-servers/commit/c52b017eef0666433cbb0b6d8086254dc1af5fee))
* **amazonq:** include tsx and jsx files in workspace context server ([#1790](https://github.com/aws/language-servers/issues/1790)) ([79691ef](https://github.com/aws/language-servers/commit/79691ef607d9bc98032fe2e59a5031601a4dba9a))
* **amazonq:** make workspace context server upload dependency chunks sequentially ([#1769](https://github.com/aws/language-servers/issues/1769)) ([c8329e6](https://github.com/aws/language-servers/commit/c8329e6b90be2c24d72a4525b8903384746de2ab))
* **amazonq:** prevent WCS matching workspaceFolder with only prefix ([#1782](https://github.com/aws/language-servers/issues/1782)) ([988d952](https://github.com/aws/language-servers/commit/988d952485b0f026200a19d17cacd323cd9e359e))
* **amazonq:** shouldn't exit inline  flow before we're sure there is no Edit/Completion trigger ([#1819](https://github.com/aws/language-servers/issues/1819)) ([dc8d89b](https://github.com/aws/language-servers/commit/dc8d89b39ee230aba6cfb032f81bda3476a5cc84))
* imagecontext image name bug, mutliple images in pinned context ([#1834](https://github.com/aws/language-servers/issues/1834)) ([27d60ab](https://github.com/aws/language-servers/commit/27d60ab5f5249635a9e73be1ee96ecb820133f9a))
* remove redundent thinking... for file operations ([#1839](https://github.com/aws/language-servers/issues/1839)) ([0078602](https://github.com/aws/language-servers/commit/00786023c9c257c9bb8066c36715864b32b4e069))
* should always trigger EDIT suggestion if triggering via acceptance ([#1826](https://github.com/aws/language-servers/issues/1826)) ([6c9e522](https://github.com/aws/language-servers/commit/6c9e5225a58d7cf43931d84e7ae63275d6f9c066))

## [0.0.62](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.61...lsp-codewhisperer/v0.0.62) (2025-07-02)


### Bug Fixes

* **amazonq:** show active file in Context dropdown ([#1815](https://github.com/aws/language-servers/issues/1815)) ([fe1156c](https://github.com/aws/language-servers/commit/fe1156cdd6becbda4b7218cbb06f615a5d919def))

## [0.0.61](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.60...lsp-codewhisperer/v0.0.61) (2025-07-02)


### Features

* add logic to merge with previous suggestions for EDITS ([#1791](https://github.com/aws/language-servers/issues/1791)) ([072d13b](https://github.com/aws/language-servers/commit/072d13b08168f256ea3695bea03cf37b27d91f81))
* **amazonq:** migrating / agents to q agentic chat ([#1799](https://github.com/aws/language-servers/issues/1799)) ([559b2ba](https://github.com/aws/language-servers/commit/559b2baec7da7b8fffb697990e3b249ffffcb85c))
* **amazonq:** read and validate the images as context ([#1716](https://github.com/aws/language-servers/issues/1716)) ([7a5d41f](https://github.com/aws/language-servers/commit/7a5d41f3cff7309d04d952fbb5dc063fb8658a06))


### Bug Fixes

* adjust vs code auto trigger coefficients ([#1806](https://github.com/aws/language-servers/issues/1806)) ([25b1d1a](https://github.com/aws/language-servers/commit/25b1d1a1930f7d0cb922d3a085cbaac2a09340b9))
* **amazonq:** remove the stack trace check from service unavailable exceptions ([#1810](https://github.com/aws/language-servers/issues/1810)) ([a5677f0](https://github.com/aws/language-servers/commit/a5677f03d54aa8e42a71e71c524700c23825ed35))

* **amazonq:** send pinned context and rules as message pair ([#1762](https://github.com/aws/language-servers/issues/1762)) ([322add6](https://github.com/aws/language-servers/commit/322add6f8b3b6edd5b3e4b37fc783a1079f15596))
* connect chat history to workspace file ([#1767](https://github.com/aws/language-servers/issues/1767)) ([4575727](https://github.com/aws/language-servers/commit/4575727911a4efb21a3f24a3d400c7844451c243))
* do not auto trigger when there is immediate right context for VSC/JB ([#1802](https://github.com/aws/language-servers/issues/1802)) ([fdb29d4](https://github.com/aws/language-servers/commit/fdb29d472c5a0bc7e0a89f5611245248c380cfe8))
* setting shouldDisplayMessage to false for /agents ([#1811](https://github.com/aws/language-servers/issues/1811)) ([4a72cf7](https://github.com/aws/language-servers/commit/4a72cf7bbc9081f65c4e88c3ab42441a21ec6e03))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @aws/lsp-core bumped from ^0.0.10 to ^0.0.11

## [0.0.60](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.59...lsp-codewhisperer/v0.0.60) (2025-06-30)


### Bug Fixes

* **amazonq:** change the icon for error and reduce the count ([#1789](https://github.com/aws/language-servers/issues/1789)) ([758d31c](https://github.com/aws/language-servers/commit/758d31c186b163712312fdffb04ee692cfe11de8))
* **amazonq:** change the icon for error and reduce the count ([#1789](https://github.com/aws/language-servers/issues/1789)) ([758d31c](https://github.com/aws/language-servers/commit/758d31c186b163712312fdffb04ee692cfe11de8))
* **amazonq:** fix to add grep to read only commands ([#1787](https://github.com/aws/language-servers/issues/1787)) ([6762b27](https://github.com/aws/language-servers/commit/6762b275e9b21de268a7c89e5dc0f37e3295ee60))
* put streakLength under feature flag ([#1796](https://github.com/aws/language-servers/issues/1796)) ([dc4a8fd](https://github.com/aws/language-servers/commit/dc4a8fdd6e94fafe9b1dbe6cb1419c55a285df70))


### Reverts

* Revert "fix: adding files on windows properly triggers reindexing ([#1755](https://github.com/aws/language-servers/issues/1755))" ([#1794](https://github.com/aws/language-servers/issues/1794)) ([bb4fb25](https://github.com/aws/language-servers/commit/bb4fb25e3e8c9b0a99b75cde08e9617053d69993))

## [0.0.59](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.58...lsp-codewhisperer/v0.0.59) (2025-06-26)


### Features

* add client side ide diagnostics to telemetry event ([#1768](https://github.com/aws/language-servers/issues/1768)) ([d08fc6c](https://github.com/aws/language-servers/commit/d08fc6cccb9238cef9c2ba485e116c0516839537))
* enable iam auth for agentic chat ([#1736](https://github.com/aws/language-servers/issues/1736)) ([16b287b](https://github.com/aws/language-servers/commit/16b287b9edb3cb3a99b2b3f74c61df216641c5a6))
* Implement dynamic model selection based on extension capabilities and improve error handling ([#1737](https://github.com/aws/language-servers/issues/1737)) ([97db5d8](https://github.com/aws/language-servers/commit/97db5d8dd0a2c8214d37429375ec57aa68a462ee))
* make origin a configurable parameter and pass it to downstream calls ([#1773](https://github.com/aws/language-servers/issues/1773)) ([a1c33d1](https://github.com/aws/language-servers/commit/a1c33d1d7e2bbea693a6d8a9885491c1815f7f62))


### Bug Fixes

* add missing tools from the list ([#1756](https://github.com/aws/language-servers/issues/1756)) ([4b965d2](https://github.com/aws/language-servers/commit/4b965d279716bb17be3c9402610835d33887adf6))
* Add persistent pair programming mode setting with database storage and UI synchronization([#1757](https://github.com/aws/language-servers/issues/1757)) ([ba683cc](https://github.com/aws/language-servers/commit/ba683cc6dc120863350025a4a082ecf3a95b5905))
* add workspace folder to the relativePath ([#1764](https://github.com/aws/language-servers/issues/1764)) ([48a7769](https://github.com/aws/language-servers/commit/48a77697b26590e599a13e731f2cc5c62a893eae))
* adding files on windows properly triggers reindexing ([#1743](https://github.com/aws/language-servers/issues/1743)) ([a9d4c39](https://github.com/aws/language-servers/commit/a9d4c39afac6112294c9f486a834153a89656966))
* adding files on windows properly triggers reindexing ([#1755](https://github.com/aws/language-servers/issues/1755)) ([d0abaad](https://github.com/aws/language-servers/commit/d0abaade0e302b7d932254a95f47fa50906963d8))
* adjust overall limit per request to 570K characters ([#1771](https://github.com/aws/language-servers/issues/1771)) ([07cf383](https://github.com/aws/language-servers/commit/07cf38325847b586190aed6864ffb86782af743a))
* **amazonq:** add jitter for websocket client re-connections ([#1752](https://github.com/aws/language-servers/issues/1752)) ([0542858](https://github.com/aws/language-servers/commit/0542858891ec982bd22369ed42318ff93537f600))
* **amazonq:** fix the order of publishing the chat stop ack message ([#1761](https://github.com/aws/language-servers/issues/1761)) ([20c2263](https://github.com/aws/language-servers/commit/20c22638a34d557fc755e33aed798abc1ce3a6d9))
* **amazonq:** fix to include explanation field in mcp tools schema but remove it for tool execution ([#1759](https://github.com/aws/language-servers/issues/1759)) ([b66c772](https://github.com/aws/language-servers/commit/b66c77218d3cc5476cec32922dc22fccd9ca1861))
* **amazonq:** init mcp servers in batch of 5 ([#1758](https://github.com/aws/language-servers/issues/1758)) ([43018a6](https://github.com/aws/language-servers/commit/43018a6bb9d782a5e46d2d60f5a07fffd73cc613))
* **amazonq:** init mcp servers in parallel ([#1754](https://github.com/aws/language-servers/issues/1754)) ([92527c6](https://github.com/aws/language-servers/commit/92527c6b0cee41634c3bce74173f1c2ced08a985))
* **amazonq:** nep auto trigger should use file uri but filename is used ([#1753](https://github.com/aws/language-servers/issues/1753)) ([d010c66](https://github.com/aws/language-servers/commit/d010c6610e457fab1a5982e1c677f699150fefe0))
* **amazonq:** remove the unnecessary new line after the chat shell command output ([#1750](https://github.com/aws/language-servers/issues/1750)) ([c9f8989](https://github.com/aws/language-servers/commit/c9f8989c7e66e2f594e8c56ad55ce586fb9f6b34))
* **amazonq:** return empty if nep auto trigger is not triggered ([#1766](https://github.com/aws/language-servers/issues/1766)) ([e5c1708](https://github.com/aws/language-servers/commit/e5c17085d43747e8fc852f47182a458ca6e81abb))
* **amazonq:** save one unnecessary listWorkspaceMetadata call ([#1742](https://github.com/aws/language-servers/issues/1742)) ([a9eb908](https://github.com/aws/language-servers/commit/a9eb908b183a85257958c511e47faf2bc29410df))
* emit latency as an int for creating visualizations ([#1763](https://github.com/aws/language-servers/issues/1763)) ([34bf564](https://github.com/aws/language-servers/commit/34bf5644444bf66dc5d6b87fc70bd3561d48728a))
* include toolSpec count for history trimming ([#1778](https://github.com/aws/language-servers/issues/1778)) ([8a5322a](https://github.com/aws/language-servers/commit/8a5322a1f2e2452d5535d5cfcacd6c2bfd595b0e))
* move ignore walk from app/package.json to server/package.json ([#1748](https://github.com/aws/language-servers/issues/1748)) ([6f88dad](https://github.com/aws/language-servers/commit/6f88dad8423aeccc7668e644d33323037fc7a90c))
* remove hardcoding of builtIn and builtInWrite tools ([#1774](https://github.com/aws/language-servers/issues/1774)) ([fc8cc10](https://github.com/aws/language-servers/commit/fc8cc106617249c81a5c48601418b5f31451865c))
* update fsReplace toolSpec to emphasize JSON array syntax ([#1751](https://github.com/aws/language-servers/issues/1751)) ([31f6994](https://github.com/aws/language-servers/commit/31f6994c25d2a24709fd7119463d1be269cd68b1))


### Reverts

* fix adding files on windows properly triggers reindexing ([#1743](https://github.com/aws/language-servers/issues/1743)) ([08d15e6](https://github.com/aws/language-servers/commit/08d15e67e1ff690dab8bf2dca5c0cf977afc0ba9))
* use cw streaming client from npm ([#1552](https://github.com/aws/language-servers/issues/1552)) ([788d8ed](https://github.com/aws/language-servers/commit/788d8ed58f828b16ddce9029b8d640ed1fe885bc))

## [0.0.58](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.57...lsp-codewhisperer/v0.0.58) (2025-06-23)


### Features

* surface file operation errors in tooltip ([#1713](https://github.com/aws/language-servers/issues/1713)) ([8d80e06](https://github.com/aws/language-servers/commit/8d80e06a18e89c1ae33430676ba461b2d7acd314))


### Bug Fixes

* **amazonq:** Handle throttling errors gracefully and give correct error message([#1733](https://github.com/aws/language-servers/issues/1733)) ([232e7ea](https://github.com/aws/language-servers/commit/232e7eac9556af3ab5e8cc86185b0c90b144cdd7))
* fsReplace still available when agentic mode off ([#1731](https://github.com/aws/language-servers/issues/1731)) ([7904ea1](https://github.com/aws/language-servers/commit/7904ea18849bb5b9aa6c0e1eb4c6491f3d1598f4))
* ide mapping for VS/Eclipse for send telemetry API ([#1724](https://github.com/aws/language-servers/issues/1724)) ([84373c5](https://github.com/aws/language-servers/commit/84373c537087492445dbf1d3c9d7b86254603ceb))
* separate executeBash toolspec for mac and windows ([#1727](https://github.com/aws/language-servers/issues/1727)) ([33e0e4b](https://github.com/aws/language-servers/commit/33e0e4b2347e858ccb0c82c333aeaa8938b24c22))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @aws/lsp-core bumped from ^0.0.9 to ^0.0.10

## [0.0.57](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.56...lsp-codewhisperer/v0.0.57) (2025-06-20)


### Features

* **amazonq:** bundle dependency events from workspace context server ([#1712](https://github.com/aws/language-servers/issues/1712)) ([587da41](https://github.com/aws/language-servers/commit/587da4152ed1273117fc549f49d0b81eef7d98a9))


### Bug Fixes

* **amazonq:** removed explanation field for mcp servers ([#1717](https://github.com/aws/language-servers/issues/1717)) ([cfc6831](https://github.com/aws/language-servers/commit/cfc683111307dc25c619177e0267860c096fcfe1))
* make file collection for indexing non blocking ([#1701](https://github.com/aws/language-servers/issues/1701)) ([036efde](https://github.com/aws/language-servers/commit/036efdead9c68c4ee6e6590ee2e877ace4cabce6))
* undefined path causing the loop to break ([#1718](https://github.com/aws/language-servers/issues/1718)) ([8e48b86](https://github.com/aws/language-servers/commit/8e48b866221c70c79156b714f036413816748b6c))

## [0.0.56](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.55...lsp-codewhisperer/v0.0.56) (2025-06-19)


### Bug Fixes

* **amazonq:** add ignore pattern for file events from workspace context server ([#1703](https://github.com/aws/language-servers/issues/1703)) ([7a0dd88](https://github.com/aws/language-servers/commit/7a0dd88a2f5251af8018084c55406cd8b9eaf51a))

## [0.0.55](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.54...lsp-codewhisperer/v0.0.55) (2025-06-19)


### Bug Fixes

* **amazonq:** serialize S3 uploads for file events from workspace context server ([#1700](https://github.com/aws/language-servers/issues/1700)) ([1884c57](https://github.com/aws/language-servers/commit/1884c5793d46227d871e8cf25c940f7a87795f04))

## [0.0.54](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.53...lsp-codewhisperer/v0.0.54) (2025-06-19)


### Features

* adding current working directory to the stdio transport for mcp… ([#1691](https://github.com/aws/language-servers/issues/1691)) ([02c4d64](https://github.com/aws/language-servers/commit/02c4d645a8c2778deab7af9f5377c26e99d01f20))


### Bug Fixes

* add fsReplace tool to batch edits ([#1533](https://github.com/aws/language-servers/issues/1533)) ([4125134](https://github.com/aws/language-servers/commit/4125134f6e7eee8276d6146a507834b3309c2ec5))
* **amazonq:** itemid was accidentally removed by [#1689](https://github.com/aws/language-servers/issues/1689) ([#1698](https://github.com/aws/language-servers/issues/1698)) ([33524c0](https://github.com/aws/language-servers/commit/33524c092af8088705a3cbae09c6249ad5940ce6))
* **amazonq:** profile is not set after re-auth ([#1690](https://github.com/aws/language-servers/issues/1690)) ([2a445ee](https://github.com/aws/language-servers/commit/2a445eef4cc2a70471fd1fc49e6ca4e301051442))
* diff reports no lines added or removed ([#1549](https://github.com/aws/language-servers/issues/1549)) ([562f13e](https://github.com/aws/language-servers/commit/562f13e0223a8a01fefc9ca449aad02da9734709))
* thinking doesn't get removed if response is empty ([#1699](https://github.com/aws/language-servers/issues/1699)) ([9a63c99](https://github.com/aws/language-servers/commit/9a63c99b3195c9da0f537980324998138f25a3fa))


### Reverts

* **amazonq:** bring back [#1684](https://github.com/aws/language-servers/issues/1684) ([#1697](https://github.com/aws/language-servers/issues/1697)) ([5e7aa76](https://github.com/aws/language-servers/commit/5e7aa76b6ebcf8e0a7489d3574cc14ed3d0ceebe))
* **amazonq:** bring back [#1689](https://github.com/aws/language-servers/issues/1689) ([5b84b0e](https://github.com/aws/language-servers/commit/5b84b0e4c42c344d91ef9c99a04d3a2671221aa1))

## [0.0.53](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.52...lsp-codewhisperer/v0.0.53) (2025-06-18)


### Reverts

* **amazonq:** fix filter languages at workspace context server onDeleteFiles ([403c26a](https://github.com/aws/language-servers/commit/403c26a91f25d0035d92bfd21835b747a0dbafce))
* **amazonq:** nep cherrypick codewhispererService.ts ([#1689](https://github.com/aws/language-servers/issues/1689))" ([#1692](https://github.com/aws/language-servers/issues/1692)) ([69f1071](https://github.com/aws/language-servers/commit/69f10717c2eff8d4479ffa8a18220e15c03f865d))

## [0.0.52](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.51...lsp-codewhisperer/v0.0.52) (2025-06-17)


### Bug Fixes

* **amazonq:** filter languages at workspace context server onDeleteFiles ([#1684](https://github.com/aws/language-servers/issues/1684)) ([4272eec](https://github.com/aws/language-servers/commit/4272eec6ce4554560fdf8888d85d31315db2d964))
* send AmazonQ.md as a rule, do not automatically send README.md ([#1688](https://github.com/aws/language-servers/issues/1688)) ([c7a0656](https://github.com/aws/language-servers/commit/c7a0656ae3624082062f697b1564e589e943e4a8))
* update MCP tools implementation ([#1676](https://github.com/aws/language-servers/issues/1676)) ([51b7870](https://github.com/aws/language-servers/commit/51b7870d7144d593249a3da001b7f1047aa3b642))

## [0.0.51](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.50...lsp-codewhisperer/v0.0.51) (2025-06-17)


### Features

* add packageId property to references in req.json ([#1570](https://github.com/aws/language-servers/issues/1570)) ([3b14b17](https://github.com/aws/language-servers/commit/3b14b173369936fe9bcee130a15f2ae1d39c9cb9))
* support per region model selection ([#1683](https://github.com/aws/language-servers/issues/1683)) ([0b81b37](https://github.com/aws/language-servers/commit/0b81b37c15a8c407ec04904abb4bdccf829aa1c1))


### Bug Fixes

* add latency metrics for invokeLLM metric ([#1681](https://github.com/aws/language-servers/issues/1681)) ([0cac52c](https://github.com/aws/language-servers/commit/0cac52c3d037da8fc4403f030738256b07195e76))
* adding normalizePathFromUri to mcpUtils to handle uri paths ([#1653](https://github.com/aws/language-servers/issues/1653)) ([20532bf](https://github.com/aws/language-servers/commit/20532bf276967c33c43a677e1c1621451c58b9a9))
* **amazonq:** prevent workspace context server initialization workflow from overlapping ([#1668](https://github.com/aws/language-servers/issues/1668)) ([1625abd](https://github.com/aws/language-servers/commit/1625abd2a9fa969859236cfe1b57fa1cdd2dcc33))
* clear IDE context for auto-retry requests not initiated by the user ([#1680](https://github.com/aws/language-servers/issues/1680)) ([13c9455](https://github.com/aws/language-servers/commit/13c94558706d0181c1a2d64b439be90a601e8f74))
* timeout only works for the first time in the loop ([#1675](https://github.com/aws/language-servers/issues/1675)) ([ab50985](https://github.com/aws/language-servers/commit/ab50985eb0dac1888769f7fb703aa8d6f50c1b89))
* use NodeHttpHandler when configuring requestHandler ([#1670](https://github.com/aws/language-servers/issues/1670)) ([7b620a8](https://github.com/aws/language-servers/commit/7b620a82b7acb4fbdbb5b88661be661dd575d152))
* when user add a new server, it would load global persona at first time ([#1667](https://github.com/aws/language-servers/issues/1667)) ([a3cf388](https://github.com/aws/language-servers/commit/a3cf3880d178ae74f2136abb798f6a8f08fe76e2))

## [0.0.50](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.49...lsp-codewhisperer/v0.0.50) (2025-06-16)


### Features

* add EnableWebFormsToBlazorTransform flag to support WebForms to Blazor transformation ([#1577](https://github.com/aws/language-servers/issues/1577)) ([8c6e9f6](https://github.com/aws/language-servers/commit/8c6e9f6e0a6fd1a7464b26572c1b613b3864b27a))
* **amazonq:** edit predition auto trigger ([#1662](https://github.com/aws/language-servers/issues/1662)) ([cbcd82b](https://github.com/aws/language-servers/commit/cbcd82bf6632859539e46d1fbe12ec75ab505fb4))
* **amazonq:** model throttling message as card instead of chat message ([#1657](https://github.com/aws/language-servers/issues/1657)) ([7ee1f2a](https://github.com/aws/language-servers/commit/7ee1f2ac0bdaa9f73fb63fc6d20d0de6d7b07523))
* **amazonq:** pinned context and rules ([#1663](https://github.com/aws/language-servers/issues/1663)) ([25e7a5a](https://github.com/aws/language-servers/commit/25e7a5ab8b6630525a4fd6acc0524f67f00af817))
* update list of models and set default to 4 ([#1659](https://github.com/aws/language-servers/issues/1659)) ([1991658](https://github.com/aws/language-servers/commit/19916584d3f46049d30f0c23b41c3857a07bc622))


### Bug Fixes

* **agenticChat:** UX fixes for MCP ([#1661](https://github.com/aws/language-servers/issues/1661)) ([bbdb4b4](https://github.com/aws/language-servers/commit/bbdb4b451352af50a914df684d7654686142a13b))
* **amazonq:** properly deposit workspace context server resources on exit ([#1647](https://github.com/aws/language-servers/issues/1647)) ([34efb2b](https://github.com/aws/language-servers/commit/34efb2b0e4ded031b33ed1ed7b96cf41fbe8e03b))
* increase timeout value for the streaming client ([#1654](https://github.com/aws/language-servers/issues/1654)) ([439a488](https://github.com/aws/language-servers/commit/439a488fc95683ab0da2df18a5044d66b689f4ed))

## [0.0.49](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.48...lsp-codewhisperer/v0.0.49) (2025-06-13)


### Features

* **amazonq:** code edit tracker impl for next edit prediction ([#1617](https://github.com/aws/language-servers/issues/1617)) ([cae8993](https://github.com/aws/language-servers/commit/cae89938fe9b7e25d9a1b6552d573e79d29e97f3))
* **amazonq:** cursor tracker implementation ([#1600](https://github.com/aws/language-servers/issues/1600)) ([9be5a96](https://github.com/aws/language-servers/commit/9be5a9688647d1b4fac3aae852bd0ff4b026a873))
* **amazonq:** next edit prediction configuration and feature flag ([#1635](https://github.com/aws/language-servers/issues/1635)) ([c1a01ac](https://github.com/aws/language-servers/commit/c1a01ace6413222af3c21d19033716a343b85434))
* **amazonq:** rejectedEditTracker impl for next edit prediction ([#1631](https://github.com/aws/language-servers/issues/1631)) ([46246f1](https://github.com/aws/language-servers/commit/46246f1ab677ad7db0f12d88d80debd6264ff3f5))
* **amazonq:** utils for NEP(next edit prediction) ([#1615](https://github.com/aws/language-servers/issues/1615)) ([e3e582e](https://github.com/aws/language-servers/commit/e3e582e425e0b9838a81bef04c2b1917fb6cfb66))
* apply a max 200MB total history size ([#1587](https://github.com/aws/language-servers/issues/1587)) ([62252f2](https://github.com/aws/language-servers/commit/62252f2470b4780b0f1c85558ee5f51366cc64b5))
* language keywords detector impl for NEP ([#1614](https://github.com/aws/language-servers/issues/1614)) ([c48cd82](https://github.com/aws/language-servers/commit/c48cd824c67d42076c60a150035d8867204c198a))


### Bug Fixes

* remove /manage options from the chat prompt popup ([#1650](https://github.com/aws/language-servers/issues/1650)) ([d9de456](https://github.com/aws/language-servers/commit/d9de4565bf1848d91693f1e44b5cbb478ae75d44))

## [0.0.48](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.47...lsp-codewhisperer/v0.0.48) (2025-06-12)


### Bug Fixes

* default model should be undefined until feature is enabled ([#1640](https://github.com/aws/language-servers/issues/1640)) ([8d2e6f0](https://github.com/aws/language-servers/commit/8d2e6f0faaa7ec155e75e22b24e11e9f5896833f))

## [0.0.47](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.46...lsp-codewhisperer/v0.0.47) (2025-06-11)


### Bug Fixes

* **amazonq:** remove storing zips under workspaceContextArtifacts ([#1601](https://github.com/aws/language-servers/issues/1601)) ([c8445d5](https://github.com/aws/language-servers/commit/c8445d562a11153cc77fac52237f914478f54cb7))
* fix for overwriting in workspace level config and persona files ([#1624](https://github.com/aws/language-servers/issues/1624)) ([b201e0c](https://github.com/aws/language-servers/commit/b201e0c938f98329d83ea6ba39776d36ca7e44d0))
* fix to remove tool name sanitization ([#1621](https://github.com/aws/language-servers/issues/1621)) ([e4e6d96](https://github.com/aws/language-servers/commit/e4e6d9621d8ce70a626e9153859cd4660ccb4c26))

## [0.0.46](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.45...lsp-codewhisperer/v0.0.46) (2025-06-11)


### Bug Fixes

* add more detailed log when mcp server initialize failed and tooltip change ([#1594](https://github.com/aws/language-servers/issues/1594)) ([cdab4d6](https://github.com/aws/language-servers/commit/cdab4d6b59c4ded425822063cb568c4b831402e8))
* **amazonq:** differentiate listWorkspaceMetadata failure and empty result ([#1566](https://github.com/aws/language-servers/issues/1566)) ([ae792d5](https://github.com/aws/language-servers/commit/ae792d5b1266c1c41b2a3f9129002ba3ce091c2b))
* **amazonq:** skip sending websocket request when uploading fails ([#1562](https://github.com/aws/language-servers/issues/1562)) ([fec6fbd](https://github.com/aws/language-servers/commit/fec6fbd563826afc3f944b90b85178f9e2f9c8aa))
* correct icon for mcp button ([#1605](https://github.com/aws/language-servers/issues/1605)) ([a2e7d57](https://github.com/aws/language-servers/commit/a2e7d571eafb3767471b401242ac8a25b41961cd))
* fix for empty description of mcp tools ([#1612](https://github.com/aws/language-servers/issues/1612)) ([820c3bf](https://github.com/aws/language-servers/commit/820c3bfde935cba32b608dad4ac19fdc40a45203))
* **paidtier:** Upgrade success message is unreliable ([#1602](https://github.com/aws/language-servers/issues/1602)) ([e0b274f](https://github.com/aws/language-servers/commit/e0b274ffee2e091e09574de03fe38e0a234e2f6e))
* Relaxed MCP server naming constraints to align with Q CLI standards ([#1610](https://github.com/aws/language-servers/issues/1610)) ([52fd0ff](https://github.com/aws/language-servers/commit/52fd0ff5acbb699ec16edbdecb1e6ecc5b84a33b))
* remove the tool from the mapping after user set incase the conflict ([#1609](https://github.com/aws/language-servers/issues/1609)) ([48b996d](https://github.com/aws/language-servers/commit/48b996d1a325e2f2cd4a843bf687f1c2c7cc4df4))

## [0.0.45](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.44...lsp-codewhisperer/v0.0.45) (2025-06-10)


### Features

* add C8 test coverage support ([#1567](https://github.com/aws/language-servers/issues/1567)) ([eee5048](https://github.com/aws/language-servers/commit/eee5048c783ffc300073865d391372d5a583365c))
* adding mcp servers feature to the language-server ([#1544](https://github.com/aws/language-servers/issues/1544)) ([f37bf5f](https://github.com/aws/language-servers/commit/f37bf5f91921d7611c124de6d54dd6ec653038c6))
* **amazonq:** inline unit test generation ([#1406](https://github.com/aws/language-servers/issues/1406)) ([b01610c](https://github.com/aws/language-servers/commit/b01610cdbaa54b0c4340322cdf02785134d0f472))
* bundle nupkg files into artifact.zip ([#1510](https://github.com/aws/language-servers/issues/1510)) ([b47da11](https://github.com/aws/language-servers/commit/b47da112f256625e274a9156a09e1a4bdd6b6da3))
* **q:** builderid "paid tier" [#1197](https://github.com/aws/language-servers/issues/1197) ([d25bcb6](https://github.com/aws/language-servers/commit/d25bcb696572dd52938253bd15d838b1a0f57d68))
* remove auto model selection option ([#1548](https://github.com/aws/language-servers/issues/1548)) ([71fc801](https://github.com/aws/language-servers/commit/71fc80165a7e987ca4d103f40aa93980bcd015da))


### Bug Fixes

* **amazonq:** utg shouldnt throw when there is no corresponding config as its not handled at callers ([#1572](https://github.com/aws/language-servers/issues/1572)) ([cf79a8c](https://github.com/aws/language-servers/commit/cf79a8c69fcf81beec0e3b138bcb4f09172f12dc))
* handle dangling tool results when history is cleared due to size limits ([#1527](https://github.com/aws/language-servers/issues/1527)) ([9082323](https://github.com/aws/language-servers/commit/9082323d1affe9cb71001aa76a216b690e892b06))
* incorrect history when user aborts in-progress toolUse ([#1542](https://github.com/aws/language-servers/issues/1542)) ([0288d85](https://github.com/aws/language-servers/commit/0288d850f34ab0498f300da0a83c123bf7c62e54))
* return QModelResponse as a response not an error ([#1523](https://github.com/aws/language-servers/issues/1523)) ([5d2b3ec](https://github.com/aws/language-servers/commit/5d2b3ecf13ab4bbcbab35a6a9c5788048170f09d))


### Reverts

* fix(amazonq): always restore chat tabs when onReady is received ([#1524](https://github.com/aws/language-servers/issues/1524)) ([#1536](https://github.com/aws/language-servers/issues/1536)) ([60b3b63](https://github.com/aws/language-servers/commit/60b3b63ded17e81e3dc12ff0f14b652bdff01667))

## [0.0.44](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.43...lsp-codewhisperer/v0.0.44) (2025-06-05)


### Bug Fixes

* **amazonq:** always restore chat tabs when onReady is received ([#1524](https://github.com/aws/language-servers/issues/1524)) ([54fa813](https://github.com/aws/language-servers/commit/54fa813eb124cc3e59c30390a9ec2cc7303f9a1d))
* rename fuzzySearch tool name ([#1512](https://github.com/aws/language-servers/issues/1512)) ([4d65c92](https://github.com/aws/language-servers/commit/4d65c92c87fb1138fcaa6f023518122823b60ba4))

## [0.0.43](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.42...lsp-codewhisperer/v0.0.43) (2025-06-04)


### Bug Fixes

* disable grep search ([#1514](https://github.com/aws/language-servers/issues/1514)) ([f4f66fa](https://github.com/aws/language-servers/commit/f4f66fa3d5f8a335ae696506a4e92afe0deb262b))
* model doesn't update in session for new tabs ([#1506](https://github.com/aws/language-servers/issues/1506)) ([89aa1ef](https://github.com/aws/language-servers/commit/89aa1efade5ff9421eaf8c66db55d0a9fb8bd283))

## [0.0.42](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.41...lsp-codewhisperer/v0.0.42) (2025-06-02)


### Features

* **amazonq:** send relative file path for inline completion ([#1481](https://github.com/aws/language-servers/issues/1481)) ([35e4143](https://github.com/aws/language-servers/commit/35e4143dbaaeec8f3921b8859ce5a7451f099859))
* model selection for agentic chat ([#1294](https://github.com/aws/language-servers/issues/1294)) ([10abd04](https://github.com/aws/language-servers/commit/10abd041d340b1b6fe6adad81cc1f6bd1610826e))


### Bug Fixes

* add environment variable override to disable indexing library init ([#1504](https://github.com/aws/language-servers/issues/1504)) ([01e9662](https://github.com/aws/language-servers/commit/01e9662cafb5a86e63a23cf908c0d01aede4db89))
* **amazonq:** fix line endings before fswrite for windows ([#1483](https://github.com/aws/language-servers/issues/1483)) ([9e4c284](https://github.com/aws/language-servers/commit/9e4c28480f0660e10cbfce154323996ace7aea2b))
* **amazonq:** pagination request should also used truncated left/right context ([#1497](https://github.com/aws/language-servers/issues/1497)) ([0a4ab2c](https://github.com/aws/language-servers/commit/0a4ab2ceffe0d3d759587199912adbc84dfb598f))
* extra line when user run the command ([#1499](https://github.com/aws/language-servers/issues/1499)) ([86a17f5](https://github.com/aws/language-servers/commit/86a17f582ed21000ebc48fcab317b2cb212c4488))
* fix paths array issue in fsRead ([#1496](https://github.com/aws/language-servers/issues/1496)) ([4bf8624](https://github.com/aws/language-servers/commit/4bf8624f6474590cb0632c9530ca6ff624ac2358))
* grepSearch on Windows ([#1494](https://github.com/aws/language-servers/issues/1494)) ([57fca2f](https://github.com/aws/language-servers/commit/57fca2f0423ad485570f59e6921f36addb7d43a7))
* improve the executeBash tool spec ([#1465](https://github.com/aws/language-servers/issues/1465)) ([cab801b](https://github.com/aws/language-servers/commit/cab801b3f7ad77c1fc99d06426fd8ba481109b54))

## [0.0.41](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.40...lsp-codewhisperer/v0.0.41) (2025-05-30)


### Features

* **amazonq:** add abap as supported language [#1463](https://github.com/aws/language-servers/issues/1463) ([116ea07](https://github.com/aws/language-servers/commit/116ea07d4ae4744bb105f474d0d964c366673e7e))


### Bug Fixes

* add tests for workspace change supports ([#1484](https://github.com/aws/language-servers/issues/1484)) ([30559cb](https://github.com/aws/language-servers/commit/30559cb8a394e2f0e11b3150d7480d463014ea78))
* **amazonq:** fix for honouring the index cache dir path value ([#1448](https://github.com/aws/language-servers/issues/1448)) ([40e15b7](https://github.com/aws/language-servers/commit/40e15b75ec514bb7019affdebdb12b923370bf27))
* **amazonq:** fix UTDE suggestion state for pagination cases ([#1433](https://github.com/aws/language-servers/issues/1433)) ([6bf21e5](https://github.com/aws/language-servers/commit/6bf21e52fc0b7cefb7ee8c0ac820ad7825ba7de7))
* **amazonq:** wrap sspc lsp handlers in try/catch so failures do not take down server ([#1464](https://github.com/aws/language-servers/issues/1464)) ([6a731cb](https://github.com/aws/language-servers/commit/6a731cb680d0574b4033f1fe209f788eb1fae221))
* convert array values to comma-separated strings in telemetry metrics emitAgencticLoop_InvokeLLM ([#1458](https://github.com/aws/language-servers/issues/1458)) ([6682e21](https://github.com/aws/language-servers/commit/6682e2169f7f3815362d2d3a4bcdef809dea8c27))
* decode UTF-16LE shell output on Windows ([#1456](https://github.com/aws/language-servers/issues/1456)) ([ae48442](https://github.com/aws/language-servers/commit/ae48442f499589560ff0bc9e3832171c98e53abb))
* enable fuzzySearch tool ([#1328](https://github.com/aws/language-servers/issues/1328)) ([93d9c9c](https://github.com/aws/language-servers/commit/93d9c9ca704b59769eca0ce45857db6f9de88aa6))
* enable grepSearch tool ([#1396](https://github.com/aws/language-servers/issues/1396)) ([a3a39de](https://github.com/aws/language-servers/commit/a3a39de85f822e10fe5a9e9d88165fa26739bc87))
* ensure local index server updates with workspaceChangeEvent and bump runtimes ([#1424](https://github.com/aws/language-servers/issues/1424)) ([9babbb6](https://github.com/aws/language-servers/commit/9babbb643daa2893454dbc977d3802822b2c0aa6))
* fix uncaught exception in workspaceFolderManager ([#1428](https://github.com/aws/language-servers/issues/1428)) ([1b15457](https://github.com/aws/language-servers/commit/1b154570c9cf1eb1d56141095adea4459426b774))
* increase the code start and end line number by 1 ([#1470](https://github.com/aws/language-servers/issues/1470)) ([743666f](https://github.com/aws/language-servers/commit/743666fd18f262363a49a56bbd5063c24f1d4d31))
* properly tokenize command args using shlex.split() for Windows ([#1440](https://github.com/aws/language-servers/issues/1440)) ([9355003](https://github.com/aws/language-servers/commit/9355003f5feb030a7b3984122e180368bae29d06))
* reorder cancellation operations ([#1478](https://github.com/aws/language-servers/issues/1478)) ([0d392a7](https://github.com/aws/language-servers/commit/0d392a7996f6430d13e4d7171e320d5b0b0aaf43))
* update executeBash UI for failures during command existence check ([#1462](https://github.com/aws/language-servers/issues/1462)) ([7165301](https://github.com/aws/language-servers/commit/7165301ac8de36c34011d9fc8b066fa2fe3aff7e))
* use updated version of vecLib and use local context controller to raise context command updates ([#1479](https://github.com/aws/language-servers/issues/1479)) ([6d4280d](https://github.com/aws/language-servers/commit/6d4280d1eb61d3b10674a0aa137ae6fd2f5446bf))

## [0.0.40](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.39...lsp-codewhisperer/v0.0.40) (2025-05-22)


### Features

* **amazonq:** add fileUri to FileContext ([#1399](https://github.com/aws/language-servers/issues/1399)) ([e5ede36](https://github.com/aws/language-servers/commit/e5ede36518557bcf969d0b7eecf1f3e6bda2f618))
* **amazonq:** integrate server side workspace context with inline completion ([#1402](https://github.com/aws/language-servers/issues/1402)) ([cf0f6b3](https://github.com/aws/language-servers/commit/cf0f6b38f8b6bc22f134c50642fcba8281a24479))
* bump logging level of critical messages ([#1358](https://github.com/aws/language-servers/issues/1358)) ([d0bf283](https://github.com/aws/language-servers/commit/d0bf283e9af9321baf8fc2333c702f0317ad7daa))
* integrate server side project context into agentic chat ([#1405](https://github.com/aws/language-servers/issues/1405)) ([e4d8f61](https://github.com/aws/language-servers/commit/e4d8f6144aefdd59543f380be59ab63c6bf9e291))
* launch one remote workspace for all workspace folders ([#1348](https://github.com/aws/language-servers/issues/1348)) ([c240997](https://github.com/aws/language-servers/commit/c24099727c708994f319d9294068f6dee2a75b26))
* migrate inline completion telemetry to Flare ([#1336](https://github.com/aws/language-servers/issues/1336)) ([fcbdde4](https://github.com/aws/language-servers/commit/fcbdde4593cb55a728b996d3e04e90f9b6c6fa70))


### Bug Fixes

* accidental formatting [#1410](https://github.com/aws/language-servers/issues/1410) ([3774f40](https://github.com/aws/language-servers/commit/3774f405921a9ba26df4de6cc4044d1fa70f09a3))
* add crypto import ([#1408](https://github.com/aws/language-servers/issues/1408)) ([6d5a5cf](https://github.com/aws/language-servers/commit/6d5a5cf545d882e7ce3afb93028ad2b4a4bcbb8e))
* add grepSearch implementation ([#1359](https://github.com/aws/language-servers/issues/1359)) ([1260dce](https://github.com/aws/language-servers/commit/1260dcedb0839d7dd6ee0bb159e5f5bb3cbe5f3a))
* add requestIds for each LLM call for amazonq_addMessage metric ([#1338](https://github.com/aws/language-servers/issues/1338)) ([4324c90](https://github.com/aws/language-servers/commit/4324c90224ad9f94b82d9e68e80f7563bdb5f2ea))
* add robust validation logic to fixHistory ([#1340](https://github.com/aws/language-servers/issues/1340)) ([14dac87](https://github.com/aws/language-servers/commit/14dac87358c7e1fd79a5e49614fd33c46d43bf72))
* add validation for empty chat history ([#1403](https://github.com/aws/language-servers/issues/1403)) ([83d83b0](https://github.com/aws/language-servers/commit/83d83b0a22a5c3fb7cdad18c1fa829ee54f37119))
* adding error handling for export tab ([#1350](https://github.com/aws/language-servers/issues/1350)) ([6bdd1ac](https://github.com/aws/language-servers/commit/6bdd1acb22bb089f8a5fd257a2fe47e212650382))
* adding new telemetry metrics and addtional fields for existing metrics ([#1341](https://github.com/aws/language-servers/issues/1341)) ([d242225](https://github.com/aws/language-servers/commit/d2422252a27c57b05609c0829b0741b29c4d9236))
* **amazonq:** Use common utility to determine workspaceFolders and fix tests ([#1353](https://github.com/aws/language-servers/issues/1353)) ([483f532](https://github.com/aws/language-servers/commit/483f532b940d3ff2e914c0824f7501c3fe6a6235))
* change the version to axios to ^1.8.4 ([#1421](https://github.com/aws/language-servers/issues/1421)) ([f127538](https://github.com/aws/language-servers/commit/f127538832d01ebaf0638a0512dc9f0837b8f2ff))
* convert RTS improperly formed request error to 500 ([#1356](https://github.com/aws/language-servers/issues/1356)) ([9d74a17](https://github.com/aws/language-servers/commit/9d74a17dd850dbe59a34b75ffb563e037856485b))
* emit telemetry event to RTS when failed or cancelled ([#1384](https://github.com/aws/language-servers/issues/1384)) ([2e542ae](https://github.com/aws/language-servers/commit/2e542aebb2da37a747ae9dbd6b1fd25e95cf6d93))
* handle requestAborted errors silently ([#1394](https://github.com/aws/language-servers/issues/1394)) ([6b12b54](https://github.com/aws/language-servers/commit/6b12b544fbd84b9c57662754ba27aea491be9048))
* missing handle connection expired error for inline suggestions ([#1373](https://github.com/aws/language-servers/issues/1373)) ([05c7728](https://github.com/aws/language-servers/commit/05c772821e60ba8a6b066b26ca6811d3d9c55455))
* move generateAssistant request log statement ([#1379](https://github.com/aws/language-servers/issues/1379)) ([e258409](https://github.com/aws/language-servers/commit/e258409fb811769aa700046568c269622daf1ec9))
* only do render on partial results for fsWrite ([#1354](https://github.com/aws/language-servers/issues/1354)) ([9931592](https://github.com/aws/language-servers/commit/993159293edc32f7dc5bd0cfb999562ffee830ed))
* re-categorize error status code ([#1355](https://github.com/aws/language-servers/issues/1355)) ([a98a842](https://github.com/aws/language-servers/commit/a98a842fb5ac8d680e973d97058c22a49e5c3284))
* Reduce perceived latency of fsWrite. Show fsWrite errors in the UX  ([#1351](https://github.com/aws/language-servers/issues/1351)) ([f1e873b](https://github.com/aws/language-servers/commit/f1e873b95fbd119a0303ae1f234f9f1efa1fef56))
* remove limit on agentic loop ([#1367](https://github.com/aws/language-servers/issues/1367)) ([5943222](https://github.com/aws/language-servers/commit/59432220ba9495d3e5cdfd2d42321f412d1f2b13))
* Render timeout error, JSON parse error, cancellation to the in progress fs.write UI ([#1382](https://github.com/aws/language-servers/issues/1382)) ([f930297](https://github.com/aws/language-servers/commit/f9302976d9e916a88daac546efb8acba45c5a66e))
* Revert status code convertion ([#1370](https://github.com/aws/language-servers/issues/1370)) ([73e0c5b](https://github.com/aws/language-servers/commit/73e0c5b93861ed48c075588cd99e716066c2bc95))
* Set `source` parameter chat request context to 'IDE' ([#1407](https://github.com/aws/language-servers/issues/1407)) ([c8d6edf](https://github.com/aws/language-servers/commit/c8d6edf58e824c994ffe5c10bb970665375e0eb7))
* SSPC dependency upload and watcher fixes ([#1377](https://github.com/aws/language-servers/issues/1377)) ([a5833fe](https://github.com/aws/language-servers/commit/a5833fea3488f2e31877b5677fd532f5415b339c))
* the new prompt wont stop the process properly ([#1404](https://github.com/aws/language-servers/issues/1404)) ([6e3ec9b](https://github.com/aws/language-servers/commit/6e3ec9b7483fee74563b735440789d4add9158e0))
* truncate API payload ([#1368](https://github.com/aws/language-servers/issues/1368)) ([1120272](https://github.com/aws/language-servers/commit/112027253ca773e0b674c0527dd48c9ee8d9ddc4))
* Truncate API request context first, then truncate chat history ([#1372](https://github.com/aws/language-servers/issues/1372)) ([80fdbdf](https://github.com/aws/language-servers/commit/80fdbdfc27849e136b30d7a68727b3f53b03c8af))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @aws/lsp-core bumped from ^0.0.8 to ^0.0.9

## [0.0.39](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.38...lsp-codewhisperer/v0.0.39) (2025-05-14)


### Bug Fixes

* **amazonq:** export q chat in windows not working due to invalid path ([#1330](https://github.com/aws/language-servers/issues/1330)) ([2dfc9cb](https://github.com/aws/language-servers/commit/2dfc9cbf53dad772ae40f96ce6e026b41d887a51))

## [0.0.38](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.37...lsp-codewhisperer/v0.0.38) (2025-05-14)


### Features

* add userWrittenCodeTracker ([#1308](https://github.com/aws/language-servers/issues/1308)) ([c10819e](https://github.com/aws/language-servers/commit/c10819ea2c25ce564c75fb43a6792f3c919b757a))
* **amazonq:** telemetry for chat history and export ([#1314](https://github.com/aws/language-servers/issues/1314)) ([aaa08a4](https://github.com/aws/language-servers/commit/aaa08a4f29ac34f85ec9badf975d6e2e8d114627))
* merge updates for inline completions ([#1299](https://github.com/aws/language-servers/issues/1299)) ([44d81f0](https://github.com/aws/language-servers/commit/44d81f0b5754747d77bda60b40cc70950413a737))


### Bug Fixes

* allowing reading multiple files with fsRead, minor tool validation fix ([#1297](https://github.com/aws/language-servers/issues/1297)) ([6568811](https://github.com/aws/language-servers/commit/65688116c4ebf4e4bda821d30226bdb2a334ca3d))
* **amazonq:** 500k max input limit in user input box. Align payload prompt with user typed prompt. ([#1325](https://github.com/aws/language-servers/issues/1325)) ([3338cc1](https://github.com/aws/language-servers/commit/3338cc1b5dcfd375385d7db2fa693870687dba8a))
* bug fix for exportResultsArchive to call with profileArn as parameter ([#1300](https://github.com/aws/language-servers/issues/1300)) ([16162f6](https://github.com/aws/language-servers/commit/16162f67315d174acacb2feb163fa8d9044e147f))
* bug in skip edit for userWrittenCode ([#1315](https://github.com/aws/language-servers/issues/1315)) ([86a136b](https://github.com/aws/language-servers/commit/86a136b5db9c3a3d15e12421e9b941107842b475))
* bump runtimes and fix broken test ([#1323](https://github.com/aws/language-servers/issues/1323)) ([7d1a7b9](https://github.com/aws/language-servers/commit/7d1a7b9700ee2cc154dfe357ebbb62597d3f1582))
* duplicate suggestion in inline response ([#1331](https://github.com/aws/language-servers/issues/1331)) ([23b0c90](https://github.com/aws/language-servers/commit/23b0c901b9f98490af93b75abe6ccd44ed56fddf))
* truncate userInputMessage to first 500k characters ([#1327](https://github.com/aws/language-servers/issues/1327)) ([d6f84db](https://github.com/aws/language-servers/commit/d6f84db58f59afe85351380d7fad5320a2889f1c))
* update fileSearch toolSpec and implementation ([#1320](https://github.com/aws/language-servers/issues/1320)) ([4b18f25](https://github.com/aws/language-servers/commit/4b18f25dfb8595f18b2773dddaa5bfbc64cf519d))
* update ignore pattern of glob for sspc ([#1319](https://github.com/aws/language-servers/issues/1319)) ([6f56600](https://github.com/aws/language-servers/commit/6f566008a7b5b726418e3de535e55c63285de532))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @aws/lsp-core bumped from ^0.0.7 to ^0.0.8

## [0.0.37](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.36...lsp-codewhisperer/v0.0.37) (2025-05-09)


### Features

* add request id to default log level ([#1221](https://github.com/aws/language-servers/issues/1221)) ([fe31f26](https://github.com/aws/language-servers/commit/fe31f266eb481d9899c4924f878fe49f6bfe94aa))
* adding a check before invoking workspace context ([#1227](https://github.com/aws/language-servers/issues/1227)) ([3202b6e](https://github.com/aws/language-servers/commit/3202b6e0654a8037a3be3c50afa60960ce7bda91))
* **amazonq:** add error code handling for transformation jobs ([#1174](https://github.com/aws/language-servers/issues/1174)) ([634587c](https://github.com/aws/language-servers/commit/634587c93f08315f0676608b6f8687d309104cac))
* customizations profiles update ([#1246](https://github.com/aws/language-servers/issues/1246)) ([ea589c5](https://github.com/aws/language-servers/commit/ea589c5422f478be84f112295d82b0edb902ff21))
* server side workspace context capability ([a65fec9](https://github.com/aws/language-servers/commit/a65fec9e0cb092ddc941b164fc049fb13bb628c5))


### Bug Fixes

* abandon requests with invalid toolResults ([#1274](https://github.com/aws/language-servers/issues/1274)) ([fd6ffcb](https://github.com/aws/language-servers/commit/fd6ffcba75ce116fb8b28edccd2424f07ff72834))
* add more common ignore patterns for listDirectory ([#1287](https://github.com/aws/language-servers/issues/1287)) ([e983bfe](https://github.com/aws/language-servers/commit/e983bfe116c1d77460a6a932b6bbd8345b46a6a0))
* add requestId to chat for QModelResponse errors ([#1284](https://github.com/aws/language-servers/issues/1284)) ([cfea9fa](https://github.com/aws/language-servers/commit/cfea9fa0ee58dcb936bb2debe63494870ea10ab0))
* add support for determing workspace folder with root uri/path on initialize ([#1210](https://github.com/aws/language-servers/issues/1210)) ([5fd3174](https://github.com/aws/language-servers/commit/5fd3174f386fd0e97b8f631d26f457f574d145c4))
* address bugs impacting indexing disabled functionality ([#1293](https://github.com/aws/language-servers/issues/1293)) ([18d86d4](https://github.com/aws/language-servers/commit/18d86d45ab4751a0cc981d440e9fda6c52029922))
* **amazonq:** add codewhispererCustomizationArn to codewhisperer_perceivedLatency ([#1285](https://github.com/aws/language-servers/issues/1285)) ([b0562ca](https://github.com/aws/language-servers/commit/b0562cac4e5cf9b6477e5fbce4a2ee14a0d2b562))
* clear history for `inputTooLong` errors ([#1268](https://github.com/aws/language-servers/issues/1268)) ([b00b014](https://github.com/aws/language-servers/commit/b00b0146b55452c6472d3bc9b44a80afe393b686))
* emit all errors to get total # of errors ([#1252](https://github.com/aws/language-servers/issues/1252)) ([b425a66](https://github.com/aws/language-servers/commit/b425a667082e67a20e6f265cb0e41d049d5149af))
* errors/cancellation not resetting undoAll state ([#1273](https://github.com/aws/language-servers/issues/1273)) ([823b199](https://github.com/aws/language-servers/commit/823b199b77de7e715caf31479b9ccc55b0a17445))
* filter out .git folder from listDirectory ([#1286](https://github.com/aws/language-servers/issues/1286)) ([547ecaf](https://github.com/aws/language-servers/commit/547ecafb561fd3d6bf7a264def829160901dd23a))
* fix for permission case for execute bash ([66612cd](https://github.com/aws/language-servers/commit/66612cd5fe625dba6d951bc300e538e896e5f392))
* fix for permission case for execute bash ([#1220](https://github.com/aws/language-servers/issues/1220)) ([66612cd](https://github.com/aws/language-servers/commit/66612cd5fe625dba6d951bc300e538e896e5f392))
* fix the extra line on executeBash and wrong warning msg for outside workspace ([#1240](https://github.com/aws/language-servers/issues/1240)) ([eacc047](https://github.com/aws/language-servers/commit/eacc0475f2fe0362c155a2bd6be1715b2561d356))
* hide non-user-generated messages when reloading history ([#1257](https://github.com/aws/language-servers/issues/1257)) ([9540f12](https://github.com/aws/language-servers/commit/9540f12c7d9495b481d0cf61ad2b2c0b8339f156))
* improve data synchronization of server side workspace context ([#1278](https://github.com/aws/language-servers/issues/1278)) ([f50c4a7](https://github.com/aws/language-servers/commit/f50c4a71103b82a9780e542eef2e3622c16332d5))
* make LLM less apologetic, increase listDirectory result size ([#1242](https://github.com/aws/language-servers/issues/1242)) ([572cabb](https://github.com/aws/language-servers/commit/572cabb1036171438fe97898f72c85383628bcfd))
* only keep toolUses with `stop` = true in history ([#1235](https://github.com/aws/language-servers/issues/1235)) ([1edb6af](https://github.com/aws/language-servers/commit/1edb6af0425a3613d7dccb795b7d8178bf1c803c))
* permission check ux changes ([#1290](https://github.com/aws/language-servers/issues/1290)) ([170113f](https://github.com/aws/language-servers/commit/170113f97eccf7827cfc72da33d9dc9c7e4afb3f))
* prevent timeout messages from displaying ([#1282](https://github.com/aws/language-servers/issues/1282)) ([a154209](https://github.com/aws/language-servers/commit/a154209f0c2f16ab95eee4cf629676c811431011))
* projectRoot passed to vecLib was malformed ([#1250](https://github.com/aws/language-servers/issues/1250)) ([def522d](https://github.com/aws/language-servers/commit/def522daee62ea37556fefe12352ef28f38523d1))
* regex should match workspace text in bold style and startLine can be 0 ([#1272](https://github.com/aws/language-servers/issues/1272)) ([16d6a9d](https://github.com/aws/language-servers/commit/16d6a9d6bc6b23bfda09fb08147e76941809e3f1))
* removing warning icon for shell commands ([#1233](https://github.com/aws/language-servers/issues/1233)) ([18b2a18](https://github.com/aws/language-servers/commit/18b2a183ddeb3b58e3ebc9931cea08c1cf781bb7))
* server side timeout causes ISE ([#1254](https://github.com/aws/language-servers/issues/1254)) ([9cb2440](https://github.com/aws/language-servers/commit/9cb2440c165a296e11e0597e14b6c6aa7205f313))
* set streamingClient timeout config ([#1283](https://github.com/aws/language-servers/issues/1283)) ([cc7680d](https://github.com/aws/language-servers/commit/cc7680da85c6528d5f54f347b7ce922ffbba25b0))
* show context transparency list when using [@workspace](https://github.com/workspace) ([#1241](https://github.com/aws/language-servers/issues/1241)) ([291c0ba](https://github.com/aws/language-servers/commit/291c0ba945f311f6c1c071d048792de8735d17b8))
* show tooltip for warning message and remove the warning text  ([#1259](https://github.com/aws/language-servers/issues/1259)) ([312b04d](https://github.com/aws/language-servers/commit/312b04dbde37fbf1a1cc5d8884d62728edbc2810))
* switch to ignore entries over patterns ([#1236](https://github.com/aws/language-servers/issues/1236)) ([49ae714](https://github.com/aws/language-servers/commit/49ae7141024f9802d3ce671441f978f487a399aa))
* typo in cwsprChatTimeToFirstChunk and remove all zeros ([#1222](https://github.com/aws/language-servers/issues/1222)) ([4c940bc](https://github.com/aws/language-servers/commit/4c940bc20a3417e39d66ea73532f99a312d05e35))
* update header ignore status ([#1239](https://github.com/aws/language-servers/issues/1239)) ([6abf2fd](https://github.com/aws/language-servers/commit/6abf2fd27e8702a89f1ab306f363e04dfa27b978))
* update listDirectory tool to output in tree-like format to reduce toolSize ([#1260](https://github.com/aws/language-servers/issues/1260)) ([becfee0](https://github.com/aws/language-servers/commit/becfee0d36e9e2a5fb5239c1e34cc6661ca01d94))
* update reject button status ([#1253](https://github.com/aws/language-servers/issues/1253)) ([78c12c8](https://github.com/aws/language-servers/commit/78c12c8620367ac4276fb564e28ca58292cc8456))
* update undo-all-changes button icon to undo ([#1238](https://github.com/aws/language-servers/issues/1238)) ([6ebd5eb](https://github.com/aws/language-servers/commit/6ebd5eb8896a487189b79b1bbf1612ec9e95d064))
* use proper condition for trigger index enablement response ([#1258](https://github.com/aws/language-servers/issues/1258)) ([5aeb694](https://github.com/aws/language-servers/commit/5aeb694f495b8365c958bc9b626d0daf11718458))
* wrap load chats on ready in try-catch ([#1289](https://github.com/aws/language-servers/issues/1289)) ([7de86f0](https://github.com/aws/language-servers/commit/7de86f01460c8615f60548d3bd27a87bbc03e6f8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @aws/lsp-core bumped from ^0.0.6 to ^0.0.7

## [0.0.36](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.35...lsp-codewhisperer/v0.0.36) (2025-05-07)


### Features

* add request id to default log level ([#1221](https://github.com/aws/language-servers/issues/1221)) ([fe31f26](https://github.com/aws/language-servers/commit/fe31f266eb481d9899c4924f878fe49f6bfe94aa))
* adding a check before invoking workspace context ([#1227](https://github.com/aws/language-servers/issues/1227)) ([3202b6e](https://github.com/aws/language-servers/commit/3202b6e0654a8037a3be3c50afa60960ce7bda91))
* **amazonq:** add error code handling for transformation jobs ([#1174](https://github.com/aws/language-servers/issues/1174)) ([634587c](https://github.com/aws/language-servers/commit/634587c93f08315f0676608b6f8687d309104cac))
* customizations profiles update ([#1246](https://github.com/aws/language-servers/issues/1246)) ([ea589c5](https://github.com/aws/language-servers/commit/ea589c5422f478be84f112295d82b0edb902ff21))
* server side workspace context capability ([a65fec9](https://github.com/aws/language-servers/commit/a65fec9e0cb092ddc941b164fc049fb13bb628c5))


### Bug Fixes

* add support for determing workspace folder with root uri/path on initialize ([#1210](https://github.com/aws/language-servers/issues/1210)) ([5fd3174](https://github.com/aws/language-servers/commit/5fd3174f386fd0e97b8f631d26f457f574d145c4))
* clear history for `inputTooLong` errors ([#1268](https://github.com/aws/language-servers/issues/1268)) ([b00b014](https://github.com/aws/language-servers/commit/b00b0146b55452c6472d3bc9b44a80afe393b686))
* emit all errors to get total # of errors ([#1252](https://github.com/aws/language-servers/issues/1252)) ([b425a66](https://github.com/aws/language-servers/commit/b425a667082e67a20e6f265cb0e41d049d5149af))
* errors/cancellation not resetting undoAll state ([#1273](https://github.com/aws/language-servers/issues/1273)) ([823b199](https://github.com/aws/language-servers/commit/823b199b77de7e715caf31479b9ccc55b0a17445))
* fix for permission case for execute bash ([66612cd](https://github.com/aws/language-servers/commit/66612cd5fe625dba6d951bc300e538e896e5f392))
* fix for permission case for execute bash ([#1220](https://github.com/aws/language-servers/issues/1220)) ([66612cd](https://github.com/aws/language-servers/commit/66612cd5fe625dba6d951bc300e538e896e5f392))
* fix the extra line on executeBash and wrong warning msg for outside workspace ([#1240](https://github.com/aws/language-servers/issues/1240)) ([eacc047](https://github.com/aws/language-servers/commit/eacc0475f2fe0362c155a2bd6be1715b2561d356))
* hide non-user-generated messages when reloading history ([#1257](https://github.com/aws/language-servers/issues/1257)) ([9540f12](https://github.com/aws/language-servers/commit/9540f12c7d9495b481d0cf61ad2b2c0b8339f156))
* improve data synchronization of server side workspace context ([#1278](https://github.com/aws/language-servers/issues/1278)) ([f50c4a7](https://github.com/aws/language-servers/commit/f50c4a71103b82a9780e542eef2e3622c16332d5))
* make LLM less apologetic, increase listDirectory result size ([#1242](https://github.com/aws/language-servers/issues/1242)) ([572cabb](https://github.com/aws/language-servers/commit/572cabb1036171438fe97898f72c85383628bcfd))
* only keep toolUses with `stop` = true in history ([#1235](https://github.com/aws/language-servers/issues/1235)) ([1edb6af](https://github.com/aws/language-servers/commit/1edb6af0425a3613d7dccb795b7d8178bf1c803c))
* projectRoot passed to vecLib was malformed ([#1250](https://github.com/aws/language-servers/issues/1250)) ([def522d](https://github.com/aws/language-servers/commit/def522daee62ea37556fefe12352ef28f38523d1))
* removing warning icon for shell commands ([#1233](https://github.com/aws/language-servers/issues/1233)) ([18b2a18](https://github.com/aws/language-servers/commit/18b2a183ddeb3b58e3ebc9931cea08c1cf781bb7))
* server side timeout causes ISE ([#1254](https://github.com/aws/language-servers/issues/1254)) ([9cb2440](https://github.com/aws/language-servers/commit/9cb2440c165a296e11e0597e14b6c6aa7205f313))
* show context transparency list when using [@workspace](https://github.com/workspace) ([#1241](https://github.com/aws/language-servers/issues/1241)) ([291c0ba](https://github.com/aws/language-servers/commit/291c0ba945f311f6c1c071d048792de8735d17b8))
* switch to ignore entries over patterns ([#1236](https://github.com/aws/language-servers/issues/1236)) ([49ae714](https://github.com/aws/language-servers/commit/49ae7141024f9802d3ce671441f978f487a399aa))
* typo in cwsprChatTimeToFirstChunk and remove all zeros ([#1222](https://github.com/aws/language-servers/issues/1222)) ([4c940bc](https://github.com/aws/language-servers/commit/4c940bc20a3417e39d66ea73532f99a312d05e35))
* update header ignore status ([#1239](https://github.com/aws/language-servers/issues/1239)) ([6abf2fd](https://github.com/aws/language-servers/commit/6abf2fd27e8702a89f1ab306f363e04dfa27b978))
* update listDirectory tool to output in tree-like format to reduce toolSize ([#1260](https://github.com/aws/language-servers/issues/1260)) ([becfee0](https://github.com/aws/language-servers/commit/becfee0d36e9e2a5fb5239c1e34cc6661ca01d94))
* update reject button status ([#1253](https://github.com/aws/language-servers/issues/1253)) ([78c12c8](https://github.com/aws/language-servers/commit/78c12c8620367ac4276fb564e28ca58292cc8456))
* update undo-all-changes button icon to undo ([#1238](https://github.com/aws/language-servers/issues/1238)) ([6ebd5eb](https://github.com/aws/language-servers/commit/6ebd5eb8896a487189b79b1bbf1612ec9e95d064))
* use proper condition for trigger index enablement response ([#1258](https://github.com/aws/language-servers/issues/1258)) ([5aeb694](https://github.com/aws/language-servers/commit/5aeb694f495b8365c958bc9b626d0daf11718458))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @aws/lsp-core bumped from ^0.0.5 to ^0.0.6

## [0.0.35](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.34...lsp-codewhisperer/v0.0.35) (2025-05-06)


### Bug Fixes

* emit all errors to get total # of errors ([#1252](https://github.com/aws/language-servers/issues/1252)) ([b425a66](https://github.com/aws/language-servers/commit/b425a667082e67a20e6f265cb0e41d049d5149af))
* hide non-user-generated messages when reloading history ([#1257](https://github.com/aws/language-servers/issues/1257)) ([9540f12](https://github.com/aws/language-servers/commit/9540f12c7d9495b481d0cf61ad2b2c0b8339f156))
* make LLM less apologetic, increase listDirectory result size ([#1242](https://github.com/aws/language-servers/issues/1242)) ([572cabb](https://github.com/aws/language-servers/commit/572cabb1036171438fe97898f72c85383628bcfd))
* projectRoot passed to vecLib was malformed ([#1250](https://github.com/aws/language-servers/issues/1250)) ([def522d](https://github.com/aws/language-servers/commit/def522daee62ea37556fefe12352ef28f38523d1))
* server side timeout causes ISE ([#1254](https://github.com/aws/language-servers/issues/1254)) ([9cb2440](https://github.com/aws/language-servers/commit/9cb2440c165a296e11e0597e14b6c6aa7205f313))
* show context transparency list when using [@workspace](https://github.com/workspace) ([#1241](https://github.com/aws/language-servers/issues/1241)) ([291c0ba](https://github.com/aws/language-servers/commit/291c0ba945f311f6c1c071d048792de8735d17b8))
* switch to ignore entries over patterns ([#1236](https://github.com/aws/language-servers/issues/1236)) ([49ae714](https://github.com/aws/language-servers/commit/49ae7141024f9802d3ce671441f978f487a399aa))
* update header ignore status ([#1239](https://github.com/aws/language-servers/issues/1239)) ([6abf2fd](https://github.com/aws/language-servers/commit/6abf2fd27e8702a89f1ab306f363e04dfa27b978))
* update reject button status ([#1253](https://github.com/aws/language-servers/issues/1253)) ([78c12c8](https://github.com/aws/language-servers/commit/78c12c8620367ac4276fb564e28ca58292cc8456))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @aws/lsp-core bumped from ^0.0.4 to ^0.0.5

## [0.0.34](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.33...lsp-codewhisperer/v0.0.34) (2025-05-02)


### Features

* add request id to default log level ([#1221](https://github.com/aws/language-servers/issues/1221)) ([fe31f26](https://github.com/aws/language-servers/commit/fe31f266eb481d9899c4924f878fe49f6bfe94aa))
* **amazonq:** add error code handling for transformation jobs ([#1174](https://github.com/aws/language-servers/issues/1174)) ([634587c](https://github.com/aws/language-servers/commit/634587c93f08315f0676608b6f8687d309104cac))


### Bug Fixes

* add support for determing workspace folder with root uri/path on initialize ([#1210](https://github.com/aws/language-servers/issues/1210)) ([5fd3174](https://github.com/aws/language-servers/commit/5fd3174f386fd0e97b8f631d26f457f574d145c4))
* fix for permission case for execute bash ([66612cd](https://github.com/aws/language-servers/commit/66612cd5fe625dba6d951bc300e538e896e5f392))
* fix for permission case for execute bash ([#1220](https://github.com/aws/language-servers/issues/1220)) ([66612cd](https://github.com/aws/language-servers/commit/66612cd5fe625dba6d951bc300e538e896e5f392))
* fix the extra line on executeBash and wrong warning msg for outside workspace ([#1240](https://github.com/aws/language-servers/issues/1240)) ([eacc047](https://github.com/aws/language-servers/commit/eacc0475f2fe0362c155a2bd6be1715b2561d356))
* only keep toolUses with `stop` = true in history ([#1235](https://github.com/aws/language-servers/issues/1235)) ([1edb6af](https://github.com/aws/language-servers/commit/1edb6af0425a3613d7dccb795b7d8178bf1c803c))
* removing warning icon for shell commands ([#1233](https://github.com/aws/language-servers/issues/1233)) ([18b2a18](https://github.com/aws/language-servers/commit/18b2a183ddeb3b58e3ebc9931cea08c1cf781bb7))
* typo in cwsprChatTimeToFirstChunk and remove all zeros ([#1222](https://github.com/aws/language-servers/issues/1222)) ([4c940bc](https://github.com/aws/language-servers/commit/4c940bc20a3417e39d66ea73532f99a312d05e35))
* update undo-all-changes button icon to undo ([#1238](https://github.com/aws/language-servers/issues/1238)) ([6ebd5eb](https://github.com/aws/language-servers/commit/6ebd5eb8896a487189b79b1bbf1612ec9e95d064))

## [0.0.33](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.32...lsp-codewhisperer/v0.0.33) (2025-05-01)


### Features

* add [@workspace](https://github.com/workspace) context in agentic chat ([#1029](https://github.com/aws/language-servers/issues/1029)) ([f2916f4](https://github.com/aws/language-servers/commit/f2916f45c351a42a9951ff00bcb7f7eed3ce7274))
* add cancellation handling to tools ([#1057](https://github.com/aws/language-servers/issues/1057)) ([f2ea9ac](https://github.com/aws/language-servers/commit/f2ea9ac349dbd2825ca8e6934f44c1270653dc61))
* add configurable file indexing logic ([#967](https://github.com/aws/language-servers/issues/967)) ([dd49420](https://github.com/aws/language-servers/commit/dd49420beeae58d6a425b192dffd3f59f6b1bb7b))
* add context related telemetry to add message ([#1180](https://github.com/aws/language-servers/issues/1180)) ([18eff11](https://github.com/aws/language-servers/commit/18eff11bc1c1dcfdd65e20a70534161492d3e0fe))
* add enablerazorviewtransform ([527ae03](https://github.com/aws/language-servers/commit/527ae03521642e9b6940f3ba71ca61327d8d28b8))
* add explanation text as directive ([#1054](https://github.com/aws/language-servers/issues/1054)) ([a0ca8e0](https://github.com/aws/language-servers/commit/a0ca8e0059a26ac7f21e04940ad120c3de268df9))
* add file search tool ([#1103](https://github.com/aws/language-servers/issues/1103)) ([91bfef8](https://github.com/aws/language-servers/commit/91bfef83d167ab8271b48ff1e499331b667fd818))
* add IAM Q Streaming Client to language-servers ([#927](https://github.com/aws/language-servers/issues/927)) ([ef89fdf](https://github.com/aws/language-servers/commit/ef89fdf228f4799a29a22a60dc105ade4ee99ab3))
* add iam support in q chat server and q agentic server ([#945](https://github.com/aws/language-servers/issues/945)) ([2ac19b7](https://github.com/aws/language-servers/commit/2ac19b76731cb07bd7a5621c049b9c9ff18a8d45))
* add ide category to auto-trigger threshold computation ([#1104](https://github.com/aws/language-servers/issues/1104)) ([28161f9](https://github.com/aws/language-servers/commit/28161f97873af931307d6a19ea1e25ea5aa6ed3b))
* add LSP based tools for listing files, file contents, and updating files ([33fbf03](https://github.com/aws/language-servers/commit/33fbf03c9065deaf86ccf9f859b731fc8d3f6026))
* add mcp client ([#1034](https://github.com/aws/language-servers/issues/1034)) ([626b126](https://github.com/aws/language-servers/commit/626b126598c20fa6589ccf25b75c9d661728dca4))
* add permission check for all tools and add UI permission cards ([6194a75](https://github.com/aws/language-servers/commit/6194a7565bc86d09c589b2c0b9117f4823abe89e))
* add permission check for all tools and add UI permission cards ([#1078](https://github.com/aws/language-servers/issues/1078)) ([6194a75](https://github.com/aws/language-servers/commit/6194a7565bc86d09c589b2c0b9117f4823abe89e))
* add prevalidation step for request ([#1208](https://github.com/aws/language-servers/issues/1208)) ([de154a6](https://github.com/aws/language-servers/commit/de154a6e24cb393fc9ae980addb23a61509e87f6))
* add proper windows support for executeBash and remove mocks in tests. ([#934](https://github.com/aws/language-servers/issues/934)) ([148062f](https://github.com/aws/language-servers/commit/148062f51d9ef54fdce7be5658bb878b6a9fccc7))
* add stop button for execute bash ([#1150](https://github.com/aws/language-servers/issues/1150)) ([9cf2013](https://github.com/aws/language-servers/commit/9cf2013d30434a8a03f2497fc9b1e2a727c33918))
* add text based tool updates for agentic-chat ([#984](https://github.com/aws/language-servers/issues/984)) ([12dc8d7](https://github.com/aws/language-servers/commit/12dc8d767be42d04d50303143e1a551fb103bdc5))
* add the code search tool to support semantic search in the workspacke ([#1151](https://github.com/aws/language-servers/issues/1151)) ([d2105cd](https://github.com/aws/language-servers/commit/d2105cddbd2fee5c45c4773bc2d49d45eae1b119))
* add the grepSearch tool ([#1109](https://github.com/aws/language-servers/issues/1109)) ([6016264](https://github.com/aws/language-servers/commit/601626428b6ac968fe85257a09478e94263a5a1e))
* add tools to request in agentic chat controller and log tool usages ([39e9472](https://github.com/aws/language-servers/commit/39e947286e64d80677d231b87cf62acab16e756b))
* added icons to help and clear action ([#942](https://github.com/aws/language-servers/issues/942)) ([694bbb8](https://github.com/aws/language-servers/commit/694bbb85580cc79313d65ad77b224875f74280c2))
* added support for injecting additional context commands ([#1045](https://github.com/aws/language-servers/issues/1045)) ([d755da3](https://github.com/aws/language-servers/commit/d755da36bd7bf76684aceafb6a2cbc2f8f76291e))
* allow backend errors to be handled seperately ([#1167](https://github.com/aws/language-servers/issues/1167)) ([4c828d4](https://github.com/aws/language-servers/commit/4c828d40611e4354a17ff60179bca57ff9f2bb33))
* allow generateAssistantResponse throughout chatSession and triggerContext ([091f99f](https://github.com/aws/language-servers/commit/091f99f6535de981efecc7b07337e027432a35e2))
* **amazonq:** add auth follow up for pending profile selection ([#935](https://github.com/aws/language-servers/issues/935)) ([34a75ef](https://github.com/aws/language-servers/commit/34a75ef62c49ea6323104902f6485803155d57c6))
* **amazonq:** add pair programming toggle ([#1013](https://github.com/aws/language-servers/issues/1013)) ([7266d32](https://github.com/aws/language-servers/commit/7266d32b2fb73ead40abecb22749a2c9e5206a2a))
* **amazonq:** centralize configuration handling to base service manager class ([#906](https://github.com/aws/language-servers/issues/906)) ([b3aa8fa](https://github.com/aws/language-servers/commit/b3aa8fa54c7b13144fd8a924b1ad6e4f4a25fca4))
* **amazonq:** chat history and conversation persistence ([#941](https://github.com/aws/language-servers/issues/941)) ([bf944e0](https://github.com/aws/language-servers/commit/bf944e08e6044eb286a16ba451e70dbc5d88837a))
* **amazonq:** implement shared q service server ([#1052](https://github.com/aws/language-servers/issues/1052)) ([0eef371](https://github.com/aws/language-servers/commit/0eef371e24b0a098e861a598f7afa40077eebcdf))
* **amazonq:** initial implementation of read/list chat result ([#1024](https://github.com/aws/language-servers/issues/1024)) ([890e45e](https://github.com/aws/language-servers/commit/890e45eae48930370089936880c77b10edb83059))
* **amazonq:** initial UI for execute bash chat message ([#1041](https://github.com/aws/language-servers/issues/1041)) ([b3ed518](https://github.com/aws/language-servers/commit/b3ed518f27251742c392138f05b02281dfcddcac))
* **amazonq:** integrate with local context server ([71f4a44](https://github.com/aws/language-servers/commit/71f4a4465ab80264563f83f99fdc3ab0f0241d0b))
* **amazonq:** support context commands in agentic chat ([#948](https://github.com/aws/language-servers/issues/948)) ([71f4a44](https://github.com/aws/language-servers/commit/71f4a4465ab80264563f83f99fdc3ab0f0241d0b))
* cancel transformation polling when region is changed ([#1077](https://github.com/aws/language-servers/issues/1077)) ([99dd29c](https://github.com/aws/language-servers/commit/99dd29c16f9eb882ab298231db239233042a63c3))
* **chat-client:** implement export conversation flow ([#944](https://github.com/aws/language-servers/issues/944)) ([63fd2dc](https://github.com/aws/language-servers/commit/63fd2dc773e742c47040fd66aac4912664d91dd0))
* enable different variants in tool usage, inputs, and results ([0707d86](https://github.com/aws/language-servers/commit/0707d866893052ebcf15d9b205304852f19a555b))
* enable inline project context in suggestion requests ([#983](https://github.com/aws/language-servers/issues/983)) ([501d3fe](https://github.com/aws/language-servers/commit/501d3fe01b44aa04bebd41e3ce0ad8a921756c11))
* enable inline project context in suggestion requests ([#993](https://github.com/aws/language-servers/issues/993)) ([b6d0e25](https://github.com/aws/language-servers/commit/b6d0e250f021f776e3b4d609823f072f302a476d))
* expose configuration for GPU acceleration and index worker threads in context server ([#960](https://github.com/aws/language-servers/issues/960)) ([0ecb9dd](https://github.com/aws/language-servers/commit/0ecb9dd6782b1b22e8031613d99c87a05dd2a6ab))
* extend logging utilts to support errors ([03c5bdd](https://github.com/aws/language-servers/commit/03c5bdd7f9861a222c21ce4a6594d1cc7b39d217))
* fsWrite undo button ([#1053](https://github.com/aws/language-servers/issues/1053)) ([e5d2f6a](https://github.com/aws/language-servers/commit/e5d2f6a952d8ed0ad01223e05446cb87d4c6d406))
* improve symlink handling ([#998](https://github.com/aws/language-servers/issues/998)) ([db917b3](https://github.com/aws/language-servers/commit/db917b348e50124ee976998f1ab3e36777868ad0))
* increase file limit and move to relevantTextDocument ([#1200](https://github.com/aws/language-servers/issues/1200)) ([ed9454a](https://github.com/aws/language-servers/commit/ed9454a507dbf917402208eb06548676119b4901))
* initial fsWrite chat message ([#1026](https://github.com/aws/language-servers/issues/1026)) ([3fc6e85](https://github.com/aws/language-servers/commit/3fc6e85e14614a86982b9fb85317c923784a05af))
* initial support for local project context ([#949](https://github.com/aws/language-servers/issues/949)) ([1318d29](https://github.com/aws/language-servers/commit/1318d294307d77ffd43e70828afb98788b871295))
* loop until the model does no longer return tool usages ([4f2eb3c](https://github.com/aws/language-servers/commit/4f2eb3c03182a9aea8b7682a959afb820fa9d0dd))
* open use input prompt for agentic chat and new prompt should stop current response ([90007d0](https://github.com/aws/language-servers/commit/90007d0b05fe8d7415748ea6e539e9d307583970))
* port executeBash tool from VSC ([#912](https://github.com/aws/language-servers/issues/912)) ([1ccba58](https://github.com/aws/language-servers/commit/1ccba58a9e339ab7d5e4370cf40fa7268f802fd8))
* port listDirectory from VSC ([#930](https://github.com/aws/language-servers/issues/930)) ([7feb127](https://github.com/aws/language-servers/commit/7feb127f33570d2349852781e16cc9d6763a92b8))
* remove fileSearch and codeSearch tools from Amazon Q language server ([#1160](https://github.com/aws/language-servers/issues/1160)) ([456225f](https://github.com/aws/language-servers/commit/456225f87e0333ec807aa132ea8ba2e5a1b3b588))
* render additional chat messages ([#1025](https://github.com/aws/language-servers/issues/1025)) ([3a87baa](https://github.com/aws/language-servers/commit/3a87baa96cacba40f3fa920e4a02d26aa01a7058))
* route button event through chat-client.  ([#1037](https://github.com/aws/language-servers/issues/1037)) ([c6bb6c5](https://github.com/aws/language-servers/commit/c6bb6c5e81f0c639657e36e1989f6bae3ef47f38))
* send chat update on undo ([#1068](https://github.com/aws/language-servers/issues/1068)) ([c965db2](https://github.com/aws/language-servers/commit/c965db2b3a723b3a5b430f496819b8b424dcaf95))
* show agentLoop error in chat ([#1169](https://github.com/aws/language-servers/issues/1169)) ([a7bfc1a](https://github.com/aws/language-servers/commit/a7bfc1a0da42392a26fe07ba5918c1d7d761de86))
* show customer facing message for inputTooLong error ([#1175](https://github.com/aws/language-servers/issues/1175)) ([0ad66a2](https://github.com/aws/language-servers/commit/0ad66a2619bfa16091aeef88c7b43e31b5d5c3d6))
* stream the execute bash output ([#1083](https://github.com/aws/language-servers/issues/1083)) ([0ea098b](https://github.com/aws/language-servers/commit/0ea098b27844691e52d58199ab585929284bf79e))
* support file snapshot for diffs ([#1138](https://github.com/aws/language-servers/issues/1138)) ([7040a1c](https://github.com/aws/language-servers/commit/7040a1cdfc57a27a9a437d4db1439a8b24740258))
* support for project context in Q Chat ([#1061](https://github.com/aws/language-servers/issues/1061)) ([#1101](https://github.com/aws/language-servers/issues/1101)) ([392a31d](https://github.com/aws/language-servers/commit/392a31d2e7adc6eb0bd08ae9aa28d4a1eac3119d))
* support generateAssistantResponse as well as sendMessage ([a96f864](https://github.com/aws/language-servers/commit/a96f86444147757f20cc1fd033b018a12c915622))
* support view diff for fsWrite ([#1042](https://github.com/aws/language-servers/issues/1042)) ([98291cb](https://github.com/aws/language-servers/commit/98291cb62a43176ec176bcdd92aa7746d08b9740))
* undo-all button ([#1153](https://github.com/aws/language-servers/issues/1153)) ([82ffd10](https://github.com/aws/language-servers/commit/82ffd106b550bc314f46d52ffb30470316022825))
* update confirm header after button click WIP ([#1062](https://github.com/aws/language-servers/issues/1062)) ([f396bd6](https://github.com/aws/language-servers/commit/f396bd658df4200b595cd62687d2ed19ef68ec58))
* use enableLocalIndexing to control actual indexing ([#1201](https://github.com/aws/language-servers/issues/1201)) ([dbf99af](https://github.com/aws/language-servers/commit/dbf99af8c2ec943130472cbab1372a544b14093a))
* workspace open settings ([#1055](https://github.com/aws/language-servers/issues/1055)) ([f3018da](https://github.com/aws/language-servers/commit/f3018da706663b0f64bc5b4becc2fd600d5ff5b6))


### Bug Fixes

* add code reference to response stream ([#1217](https://github.com/aws/language-servers/issues/1217)) ([5938402](https://github.com/aws/language-servers/commit/5938402ea7608a60286c80e151ef6e3639dbef39))
* add file list card separate from permission card for tool execut… ([#1129](https://github.com/aws/language-servers/issues/1129)) ([e9b654e](https://github.com/aws/language-servers/commit/e9b654ecd5ba998e57fc67ae61278a9a497e060a))
* add file list card separate from permission card for tool executions outside workspace ([e9b654e](https://github.com/aws/language-servers/commit/e9b654ecd5ba998e57fc67ae61278a9a497e060a))
* add formatChatHistoryMessage to chatDb ([#1110](https://github.com/aws/language-servers/issues/1110)) ([353843a](https://github.com/aws/language-servers/commit/353843a6467adf63b43cbc9262d7067ebfac2cd3))
* add history to request on each chat prompt ([e9589cd](https://github.com/aws/language-servers/commit/e9589cd67fc9a47b4e3a36490f43347d913c71ff))
* add onTabBarAction and getSerializedChat to Omit list of Chat handlers temporarily ([#961](https://github.com/aws/language-servers/issues/961)) ([573588c](https://github.com/aws/language-servers/commit/573588c2929b97594660d6b256f1c6353bc8c2bc))
* add profileArn for STE and fix timeBetweenChunks ([#1189](https://github.com/aws/language-servers/issues/1189)) ([9285b75](https://github.com/aws/language-servers/commit/9285b75e63e3bf9516906f10efacde7c50efc0c0))
* add result attribute when emitting amazonq_toolUseSuggested telemetry ([#1107](https://github.com/aws/language-servers/issues/1107)) ([d882b18](https://github.com/aws/language-servers/commit/d882b188bfdf09d40340d59190839df3acde8e41))
* add result attribute when emitting telemetry event ([#1088](https://github.com/aws/language-servers/issues/1088)) ([90007d0](https://github.com/aws/language-servers/commit/90007d0b05fe8d7415748ea6e539e9d307583970))
* add result field for agentic chat interaction telemetry ([84ba395](https://github.com/aws/language-servers/commit/84ba39596b6240aa71d19e73e15858013dd01e18))
* add workspace folders as context for agentic-chat ([#995](https://github.com/aws/language-servers/issues/995)) ([f300ca5](https://github.com/aws/language-servers/commit/f300ca5acae03a993114c31d0b88d88b6cd26dc4))
* added/deleted lines is incorrect ([#1044](https://github.com/aws/language-servers/issues/1044)) ([294bfec](https://github.com/aws/language-servers/commit/294bfec899e2b208e960b718a2c2b7ae2e9db9ff))
* adding fixHistory logic for agentic Chat ([#1050](https://github.com/aws/language-servers/issues/1050)) ([4a7ad34](https://github.com/aws/language-servers/commit/4a7ad3441668d9c2103c68220ec2339c28b7b955))
* adding message if user clicks on stop button ([#1219](https://github.com/aws/language-servers/issues/1219)) ([50de37d](https://github.com/aws/language-servers/commit/50de37d6ab3d6d91fcb180653ef9b9e35869d517))
* adding tooltip description to filePaths ([#1136](https://github.com/aws/language-servers/issues/1136)) ([a0bdf7d](https://github.com/aws/language-servers/commit/a0bdf7d6e17c042c6882859b8fea85161140753a))
* addtional case for error metric and emit languageServerVersion ([#1143](https://github.com/aws/language-servers/issues/1143)) ([911ddea](https://github.com/aws/language-servers/commit/911ddea52e061697d631ddbae9a283aa146c5131))
* **agenticChat:** Only show the file name in chat ([#1080](https://github.com/aws/language-servers/issues/1080)) ([dd9c2b5](https://github.com/aws/language-servers/commit/dd9c2b5167e5bb2505d2658b4783f67a8fce29eb))
* allowing access to a folder should implicitly give access to sub folders ([#1170](https://github.com/aws/language-servers/issues/1170)) ([d589c11](https://github.com/aws/language-servers/commit/d589c11c1be053c2c96b36d2541833262f852d44))
* allowing read access to a folder should implicitly give read access to all subfolders ([d589c11](https://github.com/aws/language-servers/commit/d589c11c1be053c2c96b36d2541833262f852d44))
* also remove loading if execute failed ([#1096](https://github.com/aws/language-servers/issues/1096)) ([08a5d31](https://github.com/aws/language-servers/commit/08a5d31de1c79b9e936d7a29da0e467c1d0997af))
* **amazonq:** add cancel support to loading developer profiles ([#940](https://github.com/aws/language-servers/issues/940)) ([d07f79a](https://github.com/aws/language-servers/commit/d07f79a54d259024d0e8331122d718ee0b461864))
* **amazonq:** add missing paginator to list profiles call ([#938](https://github.com/aws/language-servers/issues/938)) ([0435c80](https://github.com/aws/language-servers/commit/0435c80b05fd3c7065da7f831e1e2d9281da0b2e))
* **amazonq:** add regionalization support to .NET Transform server ([#952](https://github.com/aws/language-servers/issues/952)) ([7571ffd](https://github.com/aws/language-servers/commit/7571ffdb87662698da0c086dad18a9db4947ce08))
* **amazonq:** add validation for create a saved prompt UX ([#1116](https://github.com/aws/language-servers/issues/1116)) ([a72d4d2](https://github.com/aws/language-servers/commit/a72d4d2cf2df883ae3c4b143b65d1373433a4b58))
* **amazonq:** avoid double rendering on confirmation. ([#1067](https://github.com/aws/language-servers/issues/1067)) ([e9e63b5](https://github.com/aws/language-servers/commit/e9e63b5e67d4122547cf4599d3d5a0af070e4029))
* **amazonq:** avoid ERR_UNSUPPORTED_ESM_URL_SCHEME error when loading indexer on Windows ([#1135](https://github.com/aws/language-servers/issues/1135)) ([e1f403f](https://github.com/aws/language-servers/commit/e1f403f5d35a268b782b256a2901c4b3a775ac0c))
* **amazonq:** Code items show symbol name instead of file name ([#1157](https://github.com/aws/language-servers/issues/1157)) ([a21ec17](https://github.com/aws/language-servers/commit/a21ec17962189000fab5d7d269a8c409e049ecb8))
* **amazonq:** deduplicate files in context list ([#1120](https://github.com/aws/language-servers/issues/1120)) ([00cc54b](https://github.com/aws/language-servers/commit/00cc54b5f2d54a5783facfb5042635e3f1a5d288))
* **amazonq:** fetch profiles only for requested profile region when updating profile ([4793504](https://github.com/aws/language-servers/commit/4793504f10713f0685c1766fb0123172104e6f4c))
* **amazonq:** fix context transparency doesn't show for file & file c… ([#1015](https://github.com/aws/language-servers/issues/1015)) ([15c445a](https://github.com/aws/language-servers/commit/15c445aa30a6a94f114d1649d68ce3345c0d9ae7))
* **amazonq:** fixes and refactor ([71f4a44](https://github.com/aws/language-servers/commit/71f4a4465ab80264563f83f99fdc3ab0f0241d0b))
* **amazonq:** increase timeout for project index init ([#1005](https://github.com/aws/language-servers/issues/1005)) ([cf88282](https://github.com/aws/language-servers/commit/cf8828294d36c9459c199e888b43c37309a7f3f6))
* **amazonq:** move context command provider to agentic chat controller ([#999](https://github.com/aws/language-servers/issues/999)) ([0ad24d4](https://github.com/aws/language-servers/commit/0ad24d40e4b8bf50809db6cb4f4ceb00da4deb01))
* **amazonq:** recursively create directory for saved user prompts ([#1148](https://github.com/aws/language-servers/issues/1148)) ([94290cb](https://github.com/aws/language-servers/commit/94290cb1ea8668d76f37ae19d099d50717aff670))
* **amazonq:** workspace rules and saved prompts not working ([#1063](https://github.com/aws/language-servers/issues/1063)) ([ae67519](https://github.com/aws/language-servers/commit/ae67519904767cb1178e92a69906edadd0fd789f))
* bubble up throttling error for ListAvailableProfiles API to client ([#1127](https://github.com/aws/language-servers/issues/1127)) ([daca805](https://github.com/aws/language-servers/commit/daca805d06f731d2a5dd3f86172b86580cf0e69e))
* change in reject button placement in execute bash ([#1182](https://github.com/aws/language-servers/issues/1182)) ([7d36434](https://github.com/aws/language-servers/commit/7d36434e38012a13c18ba3481c3fd3da25b495f8))
* change log-level for request logs ([#1147](https://github.com/aws/language-servers/issues/1147)) ([26abff9](https://github.com/aws/language-servers/commit/26abff97c17816bc8c765535b673e65fca64671a))
* change PPM switch info text cards ([c8c7d05](https://github.com/aws/language-servers/commit/c8c7d056a571bc407d029345d19de9f7709e181f))
* chat response in windows uses mac-like path/command ([#1166](https://github.com/aws/language-servers/issues/1166)) ([80d5e82](https://github.com/aws/language-servers/commit/80d5e82645986d464821cdab0c5aa35da8e1c44a))
* **chat-client:** disable click event for empty history list item ([#973](https://github.com/aws/language-servers/issues/973)) ([bc20a04](https://github.com/aws/language-servers/commit/bc20a04277a7b603e0d0c5e623c87b2a5c4dc4d4))
* **chat-client:** fix the warning icon ([#1126](https://github.com/aws/language-servers/issues/1126)) ([c3ecda6](https://github.com/aws/language-servers/commit/c3ecda6317d2b78bac03d2fb4b3b6b011763cd00))
* **chat-client:** return message for rejecting command ([#1140](https://github.com/aws/language-servers/issues/1140)) ([db90ec0](https://github.com/aws/language-servers/commit/db90ec0f65689377bd5e9684d50b06b7b90472f5))
* **chat-client:** workspace checks for permission cards ([#1089](https://github.com/aws/language-servers/issues/1089)) ([bdecb10](https://github.com/aws/language-servers/commit/bdecb1095b1a19b5d09f20d7f7762aabcb4090ca))
* ci failing due to invalid argument ([#1198](https://github.com/aws/language-servers/issues/1198)) ([47c0c84](https://github.com/aws/language-servers/commit/47c0c846f1da587701accb4a82f992700ee1aa57))
* clicking files on Windows doesn't work ([#1168](https://github.com/aws/language-servers/issues/1168)) ([9d50420](https://github.com/aws/language-servers/commit/9d5042041db6342f33b03a94ef463ff1277b016f))
* context transparency list not displayed ([#1095](https://github.com/aws/language-servers/issues/1095)) ([9919654](https://github.com/aws/language-servers/commit/9919654baf1625eeba3c2023028811b947495809))
* disable timeout for tests in aws-lsp-codewhisperer and core packages ([#955](https://github.com/aws/language-servers/issues/955)) ([254e36c](https://github.com/aws/language-servers/commit/254e36cf1a34b114a9397c688784293367dc1d63))
* do not include references in request history ([#1066](https://github.com/aws/language-servers/issues/1066)) ([55cf8d1](https://github.com/aws/language-servers/commit/55cf8d1ef577210d06dbaf959857c046342e1966))
* don't crash if local indexing controller does not start in 60 seconds ([1457cb3](https://github.com/aws/language-servers/commit/1457cb3e3be1b2ae9b835f7df977e4c6a9f93f82))
* duplicate explanation ([#1186](https://github.com/aws/language-servers/issues/1186)) ([8a92df7](https://github.com/aws/language-servers/commit/8a92df708dc8650e82bb42ee105821f201d77139))
* ensure chat history consistency by fixing database state before each request ([#1082](https://github.com/aws/language-servers/issues/1082)) ([eac472a](https://github.com/aws/language-servers/commit/eac472a60250f0baa43e8d327ee64096d5807aa2))
* error message metric now correctly emitted ([#1123](https://github.com/aws/language-servers/issues/1123)) ([79043df](https://github.com/aws/language-servers/commit/79043df47c3c2ad0cdd3d38d75f455354175d409))
* execute bash output formatting ([#1121](https://github.com/aws/language-servers/issues/1121)) ([c3fd570](https://github.com/aws/language-servers/commit/c3fd5703f0a95c79b9b074f2184a0ffc52c13a7e))
* execute command should show when no approval required & add more loading ([#1091](https://github.com/aws/language-servers/issues/1091)) ([5c48989](https://github.com/aws/language-servers/commit/5c48989d18665b84578b9c4bc49a5f3928754619))
* extra thinking in the end ([#1146](https://github.com/aws/language-servers/issues/1146)) ([6708413](https://github.com/aws/language-servers/commit/670841357d68fa49f1f792bd9936f2421410458d))
* falcon context file clicks ([#1094](https://github.com/aws/language-servers/issues/1094)) ([d68d148](https://github.com/aws/language-servers/commit/d68d1486cb2a563b153c967112a0eada0cc772df))
* fallback to fs if document context fails to sync ([#1017](https://github.com/aws/language-servers/issues/1017)) ([69db2bd](https://github.com/aws/language-servers/commit/69db2bd8dd631af226c5c96115e4102825019b0c))
* file should be grey out and unclickable after undo ([#1184](https://github.com/aws/language-servers/issues/1184)) ([120bdc5](https://github.com/aws/language-servers/commit/120bdc563a39718f0639e19da25fb38323495e03))
* fix execute bash test command failing on pipeline ([#956](https://github.com/aws/language-servers/issues/956)) ([461957d](https://github.com/aws/language-servers/commit/461957dc7856ca3490ccdd756e6dd4cb1351698c))
* fix execute command header flickering issue ([#1177](https://github.com/aws/language-servers/issues/1177)) ([dc5d360](https://github.com/aws/language-servers/commit/dc5d36029102f845617ed791f252e115fef57686))
* fix for context list flickering ux ([#1181](https://github.com/aws/language-servers/issues/1181)) ([a7fc6fe](https://github.com/aws/language-servers/commit/a7fc6fe1acb35b1257f98e5b426b5ee3437716e1))
* fix header incorrectly added to other message issue ([dc5d360](https://github.com/aws/language-servers/commit/dc5d36029102f845617ed791f252e115fef57686))
* fix ppm mode switch texts ([#1196](https://github.com/aws/language-servers/issues/1196)) ([c8c7d05](https://github.com/aws/language-servers/commit/c8c7d056a571bc407d029345d19de9f7709e181f))
* fix project root not passed to buildIndex ([3237ffe](https://github.com/aws/language-servers/commit/3237ffef10f4b57cda600397343cbc1e6d40ec38))
* fix the context list bug and show the tooltip ([c2d61f4](https://github.com/aws/language-servers/commit/c2d61f42214c8a55354f54f1300252acfab3481b))
* Fixes the issue of collapsing the files and folders while streaming response. ([#1161](https://github.com/aws/language-servers/issues/1161)) ([8d8521b](https://github.com/aws/language-servers/commit/8d8521bbec0e9bf068bef34fac45f224c0ca9b05))
* format objects in the logs properly. ([#1139](https://github.com/aws/language-servers/issues/1139)) ([1ff522c](https://github.com/aws/language-servers/commit/1ff522c7005bae518cf8ae3ed80a0faa82d11435))
* further improvements for thinking/loading ([#1125](https://github.com/aws/language-servers/issues/1125)) ([5e091d7](https://github.com/aws/language-servers/commit/5e091d704cbd3dd4cd3a2a97f0234f029cc49247))
* handle indexing library import when require.main is undefined ([#982](https://github.com/aws/language-servers/issues/982)) ([f5dac38](https://github.com/aws/language-servers/commit/f5dac38c03585ee5001beddbccd8a184bb48c5a7))
* handle undefined workspace folders in context controller ([#964](https://github.com/aws/language-servers/issues/964)) ([a01262c](https://github.com/aws/language-servers/commit/a01262cf0fc94134b6f00c9d2806c99796233551))
* hardcoded class and function names logging to avoid uglified naming when bundled ([#909](https://github.com/aws/language-servers/issues/909)) ([68e692a](https://github.com/aws/language-servers/commit/68e692a754a1262261e734a7ac85468e6470db17))
* history not persisted for agentic chat via IdC signin ([1d2ca01](https://github.com/aws/language-servers/commit/1d2ca018f2248106690438b860d40a7ee67ac728))
* implement proper error handling. ([#1115](https://github.com/aws/language-servers/issues/1115)) ([4a7bfdc](https://github.com/aws/language-servers/commit/4a7bfdc1402d6c0eaa1da23c61dc5559605e670a))
* improve chat rendering if there are additional chat messages ([#1039](https://github.com/aws/language-servers/issues/1039)) ([70a086a](https://github.com/aws/language-servers/commit/70a086a823fc56dcd068dee0fa3147cb06684b9a))
* increase information on request logs ([#1209](https://github.com/aws/language-servers/issues/1209)) ([469449e](https://github.com/aws/language-servers/commit/469449e10b03649384a16c469ee4909c78ed12d9))
* invalid json aborts the loop ([#1141](https://github.com/aws/language-servers/issues/1141)) ([222aee8](https://github.com/aws/language-servers/commit/222aee8bc1788f15d85527ca2469d978e2d9c790))
* isInWorkspace should work on closed files.  ([#1004](https://github.com/aws/language-servers/issues/1004)) ([a96651e](https://github.com/aws/language-servers/commit/a96651ea1edd296b5dfa7ee4fdd1c6d378a14858))
* keep falcon context in history ([d80fafd](https://github.com/aws/language-servers/commit/d80fafd74b3c76b0f8b9b19d58c5af66fd604c02))
* llm not breaking down requests when input is too large ([#1159](https://github.com/aws/language-servers/issues/1159)) ([f69bac5](https://github.com/aws/language-servers/commit/f69bac55ba25393f5383ba5622965ba43de4a187))
* loading appears too often ([#1179](https://github.com/aws/language-servers/issues/1179)) ([80aa92e](https://github.com/aws/language-servers/commit/80aa92e6b658fe07258bc3d04cb453656e69b7f7))
* log entire raw request ([#1218](https://github.com/aws/language-servers/issues/1218)) ([0662893](https://github.com/aws/language-servers/commit/066289332dd6fe2b3accde69c7076eb3b3ac8822))
* Make RemoveDuplicateNugetPackage failure a non-blocker for transformation ([29727e6](https://github.com/aws/language-servers/commit/29727e6fcd9f3c2a7bdc422419c549e29dbf9f20))
* metric to show tool distribution ([#1090](https://github.com/aws/language-servers/issues/1090)) ([bdf3019](https://github.com/aws/language-servers/commit/bdf3019c76ab32a73398478358f8bf977505b1db))
* more robust handling of file paths in context server ([#985](https://github.com/aws/language-servers/issues/985)) ([b2033d7](https://github.com/aws/language-servers/commit/b2033d756d52d1e8094c97203f1fe0952aa0162f))
* never leave body undefined in history, even if that assistant response did not have content ([1612eb0](https://github.com/aws/language-servers/commit/1612eb0ba1721b9b4a0e4813a5f037b2781ed0b0))
* new ignored status for execute bash tool ([#1203](https://github.com/aws/language-servers/issues/1203)) ([be135ec](https://github.com/aws/language-servers/commit/be135ec48afe3f50b918a33e90971c0531ac656e))
* onFileClick logic is crashing the whole process if no workspace is open ([#1119](https://github.com/aws/language-servers/issues/1119)) ([0211223](https://github.com/aws/language-servers/commit/0211223a93dd3ddcb5b7b06882e2a10eb09fa01c))
* output validation is incorrect for json output ([#1224](https://github.com/aws/language-servers/issues/1224)) ([fc3281f](https://github.com/aws/language-servers/commit/fc3281f17f06147b5ce41d41a5fe414a1df16bc4))
* pair programming mode toggle is not respected ([#1145](https://github.com/aws/language-servers/issues/1145)) ([2b11a55](https://github.com/aws/language-servers/commit/2b11a552f7cd4d23db2345f75a09d39fa960d5aa))
* parsing AmazonQWorkspaceConfiguration ([#996](https://github.com/aws/language-servers/issues/996)) ([5475521](https://github.com/aws/language-servers/commit/5475521d77880e82fd394dba0c345c3087787b64))
* polishing the read ux for file ([#1070](https://github.com/aws/language-servers/issues/1070)) ([e83d7ba](https://github.com/aws/language-servers/commit/e83d7ba3ac93e4af7f7524166bf1cb0f6d58f486))
* prevent double-writing executeBash command block on Reject button click ([#1087](https://github.com/aws/language-servers/issues/1087)) ([68df8f9](https://github.com/aws/language-servers/commit/68df8f9835471697687a75606c50796b193fc828))
* propagate errors from tools back to the model invocation ([d296091](https://github.com/aws/language-servers/commit/d2960913f886452742e5a4be6b18c9511595eaa3))
* reject button for executeBash tool ([#1133](https://github.com/aws/language-servers/issues/1133)) ([b498c6d](https://github.com/aws/language-servers/commit/b498c6d8992dcaeb8540e6a43df7965597a3fe56))
* reject should terminate agentic loop ([#1056](https://github.com/aws/language-servers/issues/1056)) ([befaeca](https://github.com/aws/language-servers/commit/befaecae91f01461c13a1ce7ce80deea4c4f805e))
* related tools in toolSpec causes hallucination ([#1187](https://github.com/aws/language-servers/issues/1187)) ([d8e433e](https://github.com/aws/language-servers/commit/d8e433eb5524228987d84b235bdf8f92dd6512aa))
* remove guessIntentFromPrompt functionality while preserving user Intent property ([#1156](https://github.com/aws/language-servers/issues/1156)) ([1108ff5](https://github.com/aws/language-servers/commit/1108ff52ef59de6ba135412d52a4f20a2a397ee9))
* remove loading when stop clicked and add loading when request in progress ([#1117](https://github.com/aws/language-servers/issues/1117)) ([40098dd](https://github.com/aws/language-servers/commit/40098ddc0277a1f29339b15d0950917143d2178b))
* request id and error message in error metric ([#1076](https://github.com/aws/language-servers/issues/1076)) ([84bccc6](https://github.com/aws/language-servers/commit/84bccc6055487df4d4cb30448dabc492f786f6a8))
* save ([#1035](https://github.com/aws/language-servers/issues/1035)) ([d115563](https://github.com/aws/language-servers/commit/d115563b96c41ae571fdf0d0525776ce83de9026))
* see if message is apart of agentic loop ([#1178](https://github.com/aws/language-servers/issues/1178)) ([a047be0](https://github.com/aws/language-servers/commit/a047be0207cb5f7b05e482c35d8cbe9f41dd0cfb))
* some chat messages are not added to history ([#1102](https://github.com/aws/language-servers/issues/1102)) ([0813bf3](https://github.com/aws/language-servers/commit/0813bf31a160e2213ec567ddae63e94690731111))
* stop button fix while waiting for permission check ([#1113](https://github.com/aws/language-servers/issues/1113)) ([a113a0d](https://github.com/aws/language-servers/commit/a113a0d6fa1558bcedacc182d66abc7159bbcdc1))
* stop button kills the shell executions ([1ff522c](https://github.com/aws/language-servers/commit/1ff522c7005bae518cf8ae3ed80a0faa82d11435))
* stop button kills the shell executions ([6597a5c](https://github.com/aws/language-servers/commit/6597a5c2a97bcd3449a075fc861642bb84f4bcd1))
* stop button kills the shell executions ([#1142](https://github.com/aws/language-servers/issues/1142)) ([6597a5c](https://github.com/aws/language-servers/commit/6597a5c2a97bcd3449a075fc861642bb84f4bcd1))
* telemetry for `@Files`, `@Folders`, `@Prompts`, `@Code` ([#1194](https://github.com/aws/language-servers/issues/1194)) ([c9c9f09](https://github.com/aws/language-servers/commit/c9c9f0930746bfb58af19c6150e2f4a004380728))
* telemetry for agentic chat interactions ([#1164](https://github.com/aws/language-servers/issues/1164)) ([9582275](https://github.com/aws/language-servers/commit/95822751b0e06eb85cad3d2698541d45eaa24c38))
* temporary fix for error where undefined is being passed to path.join ([#980](https://github.com/aws/language-servers/issues/980)) ([49e717c](https://github.com/aws/language-servers/commit/49e717cc22b67e954b2362c64a75945c3a6f72bb))
* thinking does not always appear ([#1152](https://github.com/aws/language-servers/issues/1152)) ([df231b9](https://github.com/aws/language-servers/commit/df231b9d73807d1696c3f7cdd474186dd8530b26))
* typo in response code metric field ([#1192](https://github.com/aws/language-servers/issues/1192)) ([57ca5bb](https://github.com/aws/language-servers/commit/57ca5bb162f7924ff071d26521bd7cac5f16cdcb))
* ui polish for execute confirmation ([#1072](https://github.com/aws/language-servers/issues/1072)) ([4539f21](https://github.com/aws/language-servers/commit/4539f21dd8232ef5b288771dda4d8ae25ebc5ffc))
* undo all appears between writes ([#1207](https://github.com/aws/language-servers/issues/1207)) ([2548d17](https://github.com/aws/language-servers/commit/2548d177fcc1b978100d6414a6f352492619386c))
* up the agent loop limit ([#1022](https://github.com/aws/language-servers/issues/1022)) ([0483fcb](https://github.com/aws/language-servers/commit/0483fcb6bb7411202d49b840253129892748ae3e))
* update context commands on file add/delete ([#1158](https://github.com/aws/language-servers/issues/1158)) ([b3b376e](https://github.com/aws/language-servers/commit/b3b376ea052444667d7d8e3db13664b158c6a59e))
* update dynamic import for vector library to avoid webpack resolution interference ([#1030](https://github.com/aws/language-servers/issues/1030)) ([6e6c229](https://github.com/aws/language-servers/commit/6e6c229eace97964685a33a7ea31119e306047f1))
* update fsWrite spec specify absolute path only ([#1008](https://github.com/aws/language-servers/issues/1008)) ([d1a2b62](https://github.com/aws/language-servers/commit/d1a2b628ca54edab376cf202355217bc69cf3abc))
* update fsWrite toolSpec ([#1064](https://github.com/aws/language-servers/issues/1064)) ([20e3680](https://github.com/aws/language-servers/commit/20e3680021cb6dd7f2dee70e5079b62aa3d209b4))
* update header on execute bash completion ([#1163](https://github.com/aws/language-servers/issues/1163)) ([72f7bef](https://github.com/aws/language-servers/commit/72f7bef68f7ba05241b766b0915bc007d7e83b7e))
* update spec to require absolute path ([#1009](https://github.com/aws/language-servers/issues/1009)) ([1e77b9f](https://github.com/aws/language-servers/commit/1e77b9f40946e5f623a609bdc5f76b121408f66a))
* update toolSpec for fsRead, fsWrite and listDirectory ([#1144](https://github.com/aws/language-servers/issues/1144)) ([1a5f745](https://github.com/aws/language-servers/commit/1a5f745f828f63e773165b58479d5ef513a04c0b))
* updated spacings through mynah-ui update ([#1214](https://github.com/aws/language-servers/issues/1214)) ([b8e8fab](https://github.com/aws/language-servers/commit/b8e8fab94c5d8b9b8ed4dacff8bb38de0a31750d))
* ux polish for list directory tool messages. ([#1075](https://github.com/aws/language-servers/issues/1075)) ([7cefc1f](https://github.com/aws/language-servers/commit/7cefc1f5dbcc7518e7b67b0de8f3204f12a74ea4))
* validate tool output content size ([#1111](https://github.com/aws/language-servers/issues/1111)) ([e22fd16](https://github.com/aws/language-servers/commit/e22fd1605142b1700060e5df20eaa55393dd116b))
* wrong path for file click uri ([#1059](https://github.com/aws/language-servers/issues/1059)) ([b6c16b4](https://github.com/aws/language-servers/commit/b6c16b4e6a0936fdb3c85430b73b05eb6c5acb64))


### Reverts

* enable inline project context in suggestion requests ([#991](https://github.com/aws/language-servers/issues/991)) ([9750a9f](https://github.com/aws/language-servers/commit/9750a9f5a106f25a2cc416d19a94bf8f74677d84))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @aws/lsp-core bumped from ^0.0.3 to ^0.0.4

## [0.0.32](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.31...lsp-codewhisperer/v0.0.32) (2025-04-08)


### Bug Fixes

* pin typescript version and fix compile errors ([#924](https://github.com/aws/language-servers/issues/924)) ([7400fa3](https://github.com/aws/language-servers/commit/7400fa3d143fb2c22575485eec7aeb75a63b3612))

## [0.0.31](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.30...lsp-codewhisperer/v0.0.31) (2025-04-07)


### Features

* Add support for inline chat ([#897](https://github.com/aws/language-servers/issues/897)) ([9fd97ea](https://github.com/aws/language-servers/commit/9fd97ea946712dbbd4490752d41c395d508c8d0c))
* **amazonq:** add streaming client caching and inflight-request cancellation ([#901](https://github.com/aws/language-servers/issues/901)) ([ecb323d](https://github.com/aws/language-servers/commit/ecb323dbd3835193c1f8478d797b6a37d89b5961))
* **amazonq:** optimize service manager reuse ([#886](https://github.com/aws/language-servers/issues/886)) ([84f46ef](https://github.com/aws/language-servers/commit/84f46ef88fbae72a246c3e966ee525124eb8915a))
* context data selection support in chat-client ([#902](https://github.com/aws/language-servers/issues/902)) ([a22dea5](https://github.com/aws/language-servers/commit/a22dea51c0039f198a403e88f774ad7769b15d29))
* port fs related tools from VSC.  ([#894](https://github.com/aws/language-servers/issues/894)) ([a368acc](https://github.com/aws/language-servers/commit/a368accfcd0b5c88b81f407d4cd7b73be2782b9b))
* update artifact manager for qct .net to include private package support ([#872](https://github.com/aws/language-servers/issues/872)) ([9c86cac](https://github.com/aws/language-servers/commit/9c86caceb2ebaf803d3e47ad257d49c8ab87bded))


### Bug Fixes

* **amazonq:** do not throw when receiving null profile while client not connected ([#908](https://github.com/aws/language-servers/issues/908)) ([a04eed1](https://github.com/aws/language-servers/commit/a04eed1d3527009d848c4d00d0860dc0adf70d80))
* **amazonq:** reduce noisy logging from Q Service Manager ([7ef13b5](https://github.com/aws/language-servers/commit/7ef13b585130e264f4fa9a2ba4fae2e923fb940a))
* for transformation failure with incorrect filePath while extracting ([#875](https://github.com/aws/language-servers/issues/875)) ([54310cc](https://github.com/aws/language-servers/commit/54310cc15a8cfb3d0eb44559f0d560bdd70581e5))
* handle large file uploads using streams ([#874](https://github.com/aws/language-servers/issues/874)) ([b5999aa](https://github.com/aws/language-servers/commit/b5999aa7c54addd4e6b92483a2bb28c2fe70ffa6))
* update null check for net core compatibility version and path for private package support ([#914](https://github.com/aws/language-servers/issues/914)) ([30a0d80](https://github.com/aws/language-servers/commit/30a0d80591dbe73fd54ad3783e0d75526d994af8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @aws/lsp-core bumped from ^0.0.2 to ^0.0.3

## [0.0.30](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.29...lsp-codewhisperer/v0.0.30) (2025-03-27)


### Features

* copied test files and added README to clarify purpose of this folder ([6a18e55](https://github.com/aws/language-servers/commit/6a18e55a1392aa9e68a202a8ca6f1a8b5c55bb4b))
* create copy of chat server and controller to use in agentic chat ([035b30e](https://github.com/aws/language-servers/commit/035b30ec98b85faad5696034e56dbafef67e7f79))


### Bug Fixes

* **amazonq:** select corrert Service manager mode in completion server factory ([8041934](https://github.com/aws/language-servers/commit/8041934de1021cfe570fc2686e4000749fe297a6))
* **amazonq:** use relative path of document with chat params ([#867](https://github.com/aws/language-servers/issues/867)) ([fbc667e](https://github.com/aws/language-servers/commit/fbc667e44767ca8ddcb743b9377bf1331a27fb29))

## [0.0.29](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.28...lsp-codewhisperer/v0.0.29) (2025-03-26)


### Features

* abort all inflight requests when resetCodewhispererService is invoked ([#848](https://github.com/aws/language-servers/issues/848)) ([681889b](https://github.com/aws/language-servers/commit/681889bd40a0fb84ea624f177b07ef579864303a))
* added auth listener to reset the service manager state in case of bearer token signout ([#842](https://github.com/aws/language-servers/issues/842)) ([780be3f](https://github.com/aws/language-servers/commit/780be3fdb92917e58524472ea5967f405f802db5))
* **amazonq:** accept extra context for Q Inline Suggestions ([4a508df](https://github.com/aws/language-servers/commit/4a508dfcba714301145089263bdce8b8f18ec03b))
* **amazonq:** add eu-central-1 endpoint ([83133d6](https://github.com/aws/language-servers/commit/83133d61815c5acfba7ead1c87d0aaef206e72d4))
* **amazonq:** add regionalization support to security scan server ([#859](https://github.com/aws/language-servers/issues/859)) ([9945398](https://github.com/aws/language-servers/commit/99453989934849eddf1029763c22208cdb13be74))
* **amazonq:** add regionalization support to Telemetry service ([6937c7f](https://github.com/aws/language-servers/commit/6937c7fa53c94f23dab323d0cd92970edafd4452))
* **amazonq:** add support for setting profile to null ([b02906d](https://github.com/aws/language-servers/commit/b02906d04fad42f09e32d44120c4dd32cb2a649c))
* **amazonq:** attach profileArn to API calls when available ([00fe7e2](https://github.com/aws/language-servers/commit/00fe7e2d1327b519042480b8216d663a48dced54))
* **amazonq:** Cancel inflight updateProfile requests ([#861](https://github.com/aws/language-servers/issues/861)) ([a4a4309](https://github.com/aws/language-servers/commit/a4a4309ef1f7c0978aa44a4063d1e8160ad53bb6))
* **amazonq:** centralize access to Q Service SDK instance and add support for Q Developer profiles ([#814](https://github.com/aws/language-servers/issues/814)) ([5f11549](https://github.com/aws/language-servers/commit/5f11549bb37acf3788c991a4ceeb38a7b17f1324))
* **amazonq:** integrate q service manager with configuration server ([#852](https://github.com/aws/language-servers/issues/852)) ([c0e3290](https://github.com/aws/language-servers/commit/c0e32905e5940a79f59b19913aac9f989e85f8fe))
* **amazonq:** intergrate regionalization support into Q Chat server ([#853](https://github.com/aws/language-servers/issues/853)) ([394104c](https://github.com/aws/language-servers/commit/394104c3702055f55ababbbfb056bf7904f5115e))


### Bug Fixes

* **amazonq:** await for recordMetric in CodeDiff tracker ([ee04afc](https://github.com/aws/language-servers/commit/ee04afc7775e83bfa3868b4b661cf59ff3c7f949))
* **amazonq:** handle exceptions in TelemetryService ([e8f6375](https://github.com/aws/language-servers/commit/e8f637524fe878c26c72f506de4abea86b481fde))
* **amazonq:** specify code analysis scope and scan name when running scans ([#858](https://github.com/aws/language-servers/issues/858)) ([a925297](https://github.com/aws/language-servers/commit/a925297aabc89334f4f9eed6c13146f4fd20b164))
* update @aws/language-server-runtimes to 0.2.83 ([e1f620a](https://github.com/aws/language-servers/commit/e1f620ac2b59b4f61daff842a9f29ded1b8fa04e))

## [0.0.28](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.27...lsp-codewhisperer/v0.0.28) (2025-03-18)


### Features

* **amazonq:** add support for listing available q developer profiles ([40ee2ff](https://github.com/aws/language-servers/commit/40ee2ff254e0cfdeb54fef850bcfb1c45dd898ab))
* **amazonq:** handle client signalling support for q developer profiles ([#839](https://github.com/aws/language-servers/issues/839)) ([8b1b4ad](https://github.com/aws/language-servers/commit/8b1b4ad88138091bacacdaa7abcccaafed85b1ff))
* **amazonq:** stop emitting userDecision telemetry event ([dc51d24](https://github.com/aws/language-servers/commit/dc51d2472390f14490ec175ce94e841f5ee24417))
* **chat-client:** handle 'openTab' requests ([#817](https://github.com/aws/language-servers/issues/817)) ([fdd0b87](https://github.com/aws/language-servers/commit/fdd0b87ad2d2c9a540d2594bb9243cad01b5887a))
* **chat-client:** openTab returns error for tab create if tabs limit hit ([#832](https://github.com/aws/language-servers/issues/832)) ([aa85848](https://github.com/aws/language-servers/commit/aa8584815da1ef6298b83c8d1bb2a1011ed66fe5))
* **identity:** device code support ([#823](https://github.com/aws/language-servers/issues/823)) ([6d5368e](https://github.com/aws/language-servers/commit/6d5368e33a36a3003dc04e9c429b63edda6989de))
* Setting a flag with environment variable to retain generated input artifacts ([#807](https://github.com/aws/language-servers/issues/807)) ([fc9a5b5](https://github.com/aws/language-servers/commit/fc9a5b5fe4e4ae8babbff0bbed28263ae99c1385))


### Bug Fixes

* replace setInterval with recursive setTimeout for browser compatibility ([48b8fd1](https://github.com/aws/language-servers/commit/48b8fd1fd780770cb4b94bb1be33882f204a77e8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @aws/lsp-core bumped from ^0.0.1 to ^0.0.2

## [0.0.27](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.26...lsp-codewhisperer/v0.0.27) (2025-02-20)


### Bug Fixes

* fixing model change for skipped step ([#670](https://github.com/aws/language-servers/issues/670)) ([630e6fd](https://github.com/aws/language-servers/commit/630e6fde0b70bb1148e6acdc67c96d40319b6ce7))
* prevent override of client request listeners in CodeWhispererServiceIAM ([#784](https://github.com/aws/language-servers/issues/784)) ([cd85931](https://github.com/aws/language-servers/commit/cd85931f1981921cd5692944fbe1b638124e4457))

## [0.0.26](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.25...lsp-codewhisperer/v0.0.26) (2025-02-03)


### Bug Fixes

* revert "feat: bugfix for artifacts upload" ([#766](https://github.com/aws/language-servers/issues/766)) ([0c07a17](https://github.com/aws/language-servers/commit/0c07a175218d5deaa2cc4c3cd23641ed8ad0f71e))

## [0.0.25](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.24...lsp-codewhisperer/v0.0.25) (2025-01-28)


### Bug Fixes

* revert "chore: bump archiver from 6.0.2 to 7.0.1" ([#762](https://github.com/aws/language-servers/issues/762)) ([8d490e5](https://github.com/aws/language-servers/commit/8d490e5022e9ae2dd3ba8514a7dd3dbd1609e290))

## [0.0.24](https://github.com/aws/language-servers/compare/lsp-codewhisperer-v0.0.23...lsp-codewhisperer/v0.0.24) (2025-01-28)


### Features

* bugfix for artifacts upload ([#749](https://github.com/aws/language-servers/issues/749)) ([71c0a19](https://github.com/aws/language-servers/commit/71c0a19974428037160152cc7e40cd6c399ceec9))


### Bug Fixes

* convert makeProxyConfig to sync to allow proxy configs to be loa… ([#725](https://github.com/aws/language-servers/issues/725)) ([7ea8150](https://github.com/aws/language-servers/commit/7ea81505c4c69a0a3ba3b595a51fd40b9db14947))
* make proxy nodejs only ([#716](https://github.com/aws/language-servers/issues/716)) ([37cf726](https://github.com/aws/language-servers/commit/37cf726e4926640da158ee67d86a1937b2c89c68))
* marking aws field as optional in initializationOptions ([#757](https://github.com/aws/language-servers/issues/757)) ([d435c99](https://github.com/aws/language-servers/commit/d435c992c44214523eadfe252bb80d70ffa191f6))
* move CW streaming client to tarball ([#743](https://github.com/aws/language-servers/issues/743)) ([a1a17d8](https://github.com/aws/language-servers/commit/a1a17d853bd1d33897e2deaacec53d6d62bbe2ec))
* removing duplicated nuget packages folder ([#746](https://github.com/aws/language-servers/issues/746)) ([24b44d0](https://github.com/aws/language-servers/commit/24b44d03ce6d2127099a6ce8c33cd63b55fae290))


### Performance Improvements

* dispose chat controller in chatController tests ([#717](https://github.com/aws/language-servers/issues/717)) ([b0e6b78](https://github.com/aws/language-servers/commit/b0e6b78bcee5970eac8159d2a46bae152f1d238d))

## [0.0.23](https://github.com/aws/language-servers/compare/lsp-codewhisperer-v0.0.22...lsp-codewhisperer/v0.0.23) (2025-01-28)


### Features

* bugfix for artifacts upload ([#749](https://github.com/aws/language-servers/issues/749)) ([71c0a19](https://github.com/aws/language-servers/commit/71c0a19974428037160152cc7e40cd6c399ceec9))


### Bug Fixes

* convert makeProxyConfig to sync to allow proxy configs to be loa… ([#725](https://github.com/aws/language-servers/issues/725)) ([7ea8150](https://github.com/aws/language-servers/commit/7ea81505c4c69a0a3ba3b595a51fd40b9db14947))
* make proxy nodejs only ([#716](https://github.com/aws/language-servers/issues/716)) ([37cf726](https://github.com/aws/language-servers/commit/37cf726e4926640da158ee67d86a1937b2c89c68))
* marking aws field as optional in initializationOptions ([#757](https://github.com/aws/language-servers/issues/757)) ([d435c99](https://github.com/aws/language-servers/commit/d435c992c44214523eadfe252bb80d70ffa191f6))
* move CW streaming client to tarball ([#743](https://github.com/aws/language-servers/issues/743)) ([a1a17d8](https://github.com/aws/language-servers/commit/a1a17d853bd1d33897e2deaacec53d6d62bbe2ec))
* removing duplicated nuget packages folder ([#746](https://github.com/aws/language-servers/issues/746)) ([24b44d0](https://github.com/aws/language-servers/commit/24b44d03ce6d2127099a6ce8c33cd63b55fae290))


### Performance Improvements

* dispose chat controller in chatController tests ([#717](https://github.com/aws/language-servers/issues/717)) ([b0e6b78](https://github.com/aws/language-servers/commit/b0e6b78bcee5970eac8159d2a46bae152f1d238d))

## [0.0.22](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.21...lsp-codewhisperer/v0.0.22) (2025-01-27)


### Bug Fixes

* move CW streaming client to tarball ([#743](https://github.com/aws/language-servers/issues/743)) ([a1a17d8](https://github.com/aws/language-servers/commit/a1a17d853bd1d33897e2deaacec53d6d62bbe2ec))

## [0.0.21](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.20...lsp-codewhisperer/v0.0.21) (2025-01-16)


### Bug Fixes

* convert makeProxyConfig to sync to allow proxy configs to be loa… ([#725](https://github.com/aws/language-servers/issues/725)) ([7ea8150](https://github.com/aws/language-servers/commit/7ea81505c4c69a0a3ba3b595a51fd40b9db14947))

## [0.0.20](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.19...lsp-codewhisperer/v0.0.20) (2025-01-15)


### Bug Fixes

* make proxy nodejs only ([#716](https://github.com/aws/language-servers/issues/716)) ([37cf726](https://github.com/aws/language-servers/commit/37cf726e4926640da158ee67d86a1937b2c89c68))


### Performance Improvements

* dispose chat controller in chatController tests ([#717](https://github.com/aws/language-servers/issues/717)) ([b0e6b78](https://github.com/aws/language-servers/commit/b0e6b78bcee5970eac8159d2a46bae152f1d238d))

## [0.0.19](https://github.com/aws/language-servers/compare/lsp-codewhisperer/v0.0.18...lsp-codewhisperer/v0.0.19) (2025-01-08)


### Features

* handle virtual spaces when inserting code to cursor position ([#675](https://github.com/aws/language-servers/issues/675)) ([f2949d4](https://github.com/aws/language-servers/commit/f2949d4f54c5a91b78b02e4d5ff99b8f5c8961b5))
* pass supplemental contexts only for token client ([#697](https://github.com/aws/language-servers/issues/697)) ([7242835](https://github.com/aws/language-servers/commit/72428352db009835b7702977bd50492ab8b79606))


### Bug Fixes

* adding tests for covering the special characters case for auto trigger ([#680](https://github.com/aws/language-servers/issues/680)) ([873fdae](https://github.com/aws/language-servers/commit/873fdae39ad59f7d681b37cfc0b5c2d7062395b9))

## [0.0.18] - 2024-11-20

### Changed

- .NET Transform: Adding status skipped in step and substep of transformation
- .NET Transform: Updated supported types

## [0.0.17] - 2024-11-13

### Added

- .NET Transform: Pass .NET Standard flag to requirement.json
- .NET Transform: add solution file path to requirement.json
- .NET Transform: Add 'netstandard2.0' and 'net9.0' to target framework map
- Amazon Q Telemetry: Emit chat and inline events to destination
- Amazon Q Telemetry: Emit user modification SendTelemetryEvent events for chat and inline completions
- Amazon Q Telemetry: Emit chat add message event
- Logging: Add logging support in case of failures from STE call
- Amazon Q: Make AWS Q endpoint url configurable
- Amazon Q Telemetry: Chat interact with message event integration with SendTelemetryEvent
- Q Inline Completions: Add autotrigger parameters for new languages
- Q Inline Completions: Add support for new languages
- Amazon Q Telemetry: Add makeUserContext utility to create UserContext payload for sendTelemetry event

### Removed

- .NET Transform: Removed optional parameters from the .NET Transform capability to align with a breaking change on the backend
- Amazon Q Chat: Disabled FQN module
- .NET Transform: Trimming logs to not show steps
- .NET Transform: remove webforms from supported projects

### Changed

- Amazon Q Telemetry: Port logic for CodePercentage modifications calculation
- Amazon Q Telemetry: Load proxy configurations in code whisperer base class
- Amazon Q Chat: Migrate to SendMessage streaming endpoint for chat
- Amazon Q Telemetry: Telemetry service with common components encapsulated
- Amazon Q Chat: Handle insertToCursorPosition event in the chat server
- Amazon Q: Update service definition and types for bearer token service client

### Fixed

- Security Scan: Fixed no recursive for the remove
- Amazon Q: fix proxy server configuration
- Amazon Q Telemetry: recalculate connetionType in shouldSendTelemetry event from credentialsProvider at invocation

## [0.0.16] - 2024-10-15

### Added

- Amazon Q Inline Code Completions: The server now supports all languages supported by Q, including `go`, `php`, `rust`, `kotlin`, `terraform`, `ruby`, `shell`, `scala`

### Changed

- Amazon Q Inline Code Completions and Q Chat:  Extend Chat and Completion Telemetry with Customization (#493).
- .Net Transform: Transform result is moved to the artifact location (#495).

## [0.0.15] - 2024-10-09

### Added

- Amazon Q Configuration: Amazon Q Configuration Server and implement fetching available Q Customizations (#462).
- Amazon Q Inline Code Completions: Supplemental cross-file context for source code for `java`, `python`, `javascript`, `typescript`, `javascriptreact`, `typescriptreact` language ids (#463).

### Fixed

- .Net Transform: Add transform logSuggestionForFailureResponse (#483)
- .Net Transform: Add logging when polling get transformation status failed (#476).
- .Net Transform: Add target framework and fix bug in copy file logic (#477).
- .Net Transform: Specify StartTransformation error message (#468).

## [0.0.14] - 2024-09-13
- .Net Transform: Removing manually setting job status to failed after any error from CodeWhisperer API

## [0.0.13] - 2024-09-02
- Set customUserAgent for SDK calls in Q Servers
- Add retry to pollTransformation
- Fix autotrigger - LF
- Add sql to supported file types
- Fix: failed to upload due to cert validation failed

## [0.0.12] - 2024-08-19
- Allow sending document without active focus in Chat requests

## [0.0.11] - 2024-08-14
- Fix issue with source framework selection on transform

## [0.0.10] - 2024-07-29
- **Feature**: Add Q .NET Transform Server
- Add default response for "How can Amazon Q help me?"
- Allow "0" to be used as partial token in chat handler

## [0.0.9] - 2024-07-01
- Update security scans to exclude gitignored files

## [0.0.8] - 2024-06-26
- Create new streaming client on each request

## [0.0.7] - 2024-06-26
- Implemented chat server logic
- fix: send 'x-amzn-codewhisperer-optout' header with IAM server
- Update the streaming client

## [0.0.6] - 2024-05-23
- Send telemetry for vote, copyCodeToClipboard and authFollowUpClicked events
- Rename CodeWhisperer to Amazon Q

## [0.0.5] - 2024-05-15
- Create Chat server export it for consumption
- Fix duplicate hover message in security scan
- Clear security scan finding when a project is unloaded
- Fix the consumption of streaming client
- Add `json`, `yaml` and `java` to list of supported languages

## [0.0.4] - 2024-03-28
- Integrate dependency graph with RunSecurityScan function
- Add server for transform feature
- Add diagnostics, handle hover for security scan findings, handler for cancel scan, and security scan telemetry event
- Migrate consumption of `@aws/language-server-runtimes` from local to NPMJS

## [0.0.3] - 2024-02-01
- Add support for using AWS SDK through proxy

## [0.0.2] - 2023-11-21
- Initial release supporting telemetry, session management, authentication, context matching and auto-trigger
