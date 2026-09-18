# Changelog

## [0.5.1](https://github.com/pedronastasi/manychat-ai-agent/compare/manychat-ai-agent-v0.5.0...manychat-ai-agent-v0.5.1) (2026-09-18)


### Bug Fixes

* never ask the closing question twice ([f9c10b7](https://github.com/pedronastasi/manychat-ai-agent/commit/f9c10b7e0f69d7c43a1496ffb15b19654c19b863))
* never ask the closing question twice ([2c6f897](https://github.com/pedronastasi/manychat-ai-agent/commit/2c6f897fc4bc4224d74d2b10c30de773c35207cf))

## [0.5.0](https://github.com/pedronastasi/manychat-ai-agent/compare/manychat-ai-agent-v0.4.1...manychat-ai-agent-v0.5.0) (2026-09-18)


### Features

* make the closing question a field rather than a hope ([65072d8](https://github.com/pedronastasi/manychat-ai-agent/commit/65072d8dd97632554a4f94d6e68dcdc77af7409e))
* make the closing question a field rather than a hope ([cf7ee19](https://github.com/pedronastasi/manychat-ai-agent/commit/cf7ee19f725e3416c0a1e1e13685d95362c317b9))


### Bug Fixes

* count content lines, and give the suite its own latency budget ([31d4382](https://github.com/pedronastasi/manychat-ai-agent/commit/31d43826f285ce3a6d0b79a4ba05fb775d009b53))
* count content lines, and give the suite its own latency budget ([ae21d99](https://github.com/pedronastasi/manychat-ai-agent/commit/ae21d99bf3b7af61db546e78b43c1bc3be5b8c15))
* ground prices documented in catalog prose ([281613c](https://github.com/pedronastasi/manychat-ai-agent/commit/281613cc07edfa74b20318a85430143e21c3f12d))
* ground prices documented in catalog prose ([8a93597](https://github.com/pedronastasi/manychat-ai-agent/commit/8a935975e305a68b2db91c6dcd50e48c538829e7))
* last Spanish string in an integration test fixture ([c22e82d](https://github.com/pedronastasi/manychat-ai-agent/commit/c22e82dc2511fda88e41cd84750b1bbcdf8daa83))
* omit temperature for models that reject it ([1f934c8](https://github.com/pedronastasi/manychat-ai-agent/commit/1f934c843e661646a157a1acdc96265092e04afd))
* omit temperature for models that reject it ([279d6fb](https://github.com/pedronastasi/manychat-ai-agent/commit/279d6fb66022cd5f5d94c07335339ea4a87b0bf2))
* remove Spanish and real deployment data from test fixtures ([9fd5797](https://github.com/pedronastasi/manychat-ai-agent/commit/9fd5797398955894fb7c6a5ad7bbf6d3c19755be))
* stop discarding every message after the first on WhatsApp ([5e39c07](https://github.com/pedronastasi/manychat-ai-agent/commit/5e39c07b7afa496641fb111df4e2e1b527d50ce8))
* stop discarding every message after the first on WhatsApp ([bdc797e](https://github.com/pedronastasi/manychat-ai-agent/commit/bdc797e4630547597612a9feaede5f49adaed473))


### Specs and Docs

* document EVAL_MAX_LATENCY_MS in .env.example ([2f7cec0](https://github.com/pedronastasi/manychat-ai-agent/commit/2f7cec0db8741a6d4ff2b81f772770ac000a3376))

## [0.4.1](https://github.com/pedronastasi/manychat-ai-agent/compare/manychat-ai-agent-v0.4.0...manychat-ai-agent-v0.4.1) (2026-09-17)


### Refactors

* migrate from deprecated generateObject to generateText ([3988740](https://github.com/pedronastasi/manychat-ai-agent/commit/3988740ce567edc1440b7d27bf12b9fa7c146ba6))
* migrate from deprecated generateObject to generateText ([7319a6f](https://github.com/pedronastasi/manychat-ai-agent/commit/7319a6f4a20a62f052727243446a7cc333d0e49e))

## [0.4.0](https://github.com/pedronastasi/manychat-ai-agent/compare/manychat-ai-agent-v0.3.6...manychat-ai-agent-v0.4.0) (2026-09-17)


### Features

* cap reasoning effort, and make a dead model call visible ([c9cb90a](https://github.com/pedronastasi/manychat-ai-agent/commit/c9cb90a21f127f45d1560569e3966db1ca6fff5a))
* cap reasoning effort, and make a dead model call visible ([257f039](https://github.com/pedronastasi/manychat-ai-agent/commit/257f039a05fc84b82739b45c3854ab1637f755d0))


### Bug Fixes

* add serial seq column to turns for deterministic ordering ([7ecf70f](https://github.com/pedronastasi/manychat-ai-agent/commit/7ecf70f28292e9eceb104c3195c77da16ed5d332))
* deterministic turn ordering with serial seq column ([537ec70](https://github.com/pedronastasi/manychat-ai-agent/commit/537ec70a1f12ede6a8b0794ce01ef64c23ca62ce))
* prevent false escalation on short conversational replies ([85af807](https://github.com/pedronastasi/manychat-ai-agent/commit/85af8076fcf3d2b071212761db16e7f441ca8bed))
* prevent false escalation on short conversational replies ([7c4992e](https://github.com/pedronastasi/manychat-ai-agent/commit/7c4992e9157c6322d4c9235a25e7199d907eedc7))
* reload the persona and catalog on SIGHUP ([7293d59](https://github.com/pedronastasi/manychat-ai-agent/commit/7293d59751aca0afd65321cefbbecc7b1de088a1))
* reload the persona and catalog on SIGHUP ([c43222e](https://github.com/pedronastasi/manychat-ai-agent/commit/c43222e44838a68188e43978250303eab6f87107))

## [0.3.6](https://github.com/pedronastasi/manychat-ai-agent/compare/manychat-ai-agent-v0.3.5...manychat-ai-agent-v0.3.6) (2026-09-16)


### Bug Fixes

* **docker:** copy pnpm-workspace.yaml into build stage ([89441f6](https://github.com/pedronastasi/manychat-ai-agent/commit/89441f6a5116e58b42918d41ab44fc21371a439d))
* **docker:** copy pnpm-workspace.yaml into build stage ([11d39f5](https://github.com/pedronastasi/manychat-ai-agent/commit/11d39f5ee4209ce1f1e37a2817967ed1e956d8d7))

## [0.3.5](https://github.com/pedronastasi/manychat-ai-agent/compare/manychat-ai-agent-v0.3.4...manychat-ai-agent-v0.3.5) (2026-09-16)


### Bug Fixes

* **release:** map chore(deps) to a visible Dependencies changelog section ([0d259eb](https://github.com/pedronastasi/manychat-ai-agent/commit/0d259eb339cc619233877cf9676674ea0b03e99b))
* **release:** map chore(deps) to visible Dependencies section ([571935c](https://github.com/pedronastasi/manychat-ai-agent/commit/571935ccf37939bb6681a2642d12864f528e3314))
* **renovate:** remove semanticCommitType override ([9a29ce4](https://github.com/pedronastasi/manychat-ai-agent/commit/9a29ce4d4726db11c0ea6c11724e3be9537eb6ad))
* **renovate:** remove semanticCommitType override so :semanticCommits preset controls PR prefixes ([566cd84](https://github.com/pedronastasi/manychat-ai-agent/commit/566cd84e6620cc364d6773b1125ff9271d599b2d))


### Dependencies

* **deps:** update dependency ai to v7.0.105 ([c0388d2](https://github.com/pedronastasi/manychat-ai-agent/commit/c0388d28bf8f08879265e06bed262a32f32e5982))
* **deps:** update dependency ai to v7.0.105 ([4a8843b](https://github.com/pedronastasi/manychat-ai-agent/commit/4a8843b7ef27d2512cc42d3aa6583c58278226f3))
* **deps:** update pnpm to v12.4.2 ([c9ea9b4](https://github.com/pedronastasi/manychat-ai-agent/commit/c9ea9b439f500e1fd79e95a76d2a05288f052bad))
* **deps:** update pnpm to v12.4.2 ([c508eef](https://github.com/pedronastasi/manychat-ai-agent/commit/c508eefbfee3757ff392cbf14d7177ae1766ed1e))

## [0.3.4](https://github.com/pedronastasi/manychat-ai-agent/compare/manychat-ai-agent-v0.3.3...manychat-ai-agent-v0.3.4) (2026-09-16)


### Bug Fixes

* restore pnpm-workspace.yaml with minimumReleaseAge disabled ([6c96d58](https://github.com/pedronastasi/manychat-ai-agent/commit/6c96d58571d3d8943356e59097a125a4873e2f98))


### Specs and Docs

* add deps prefix to spec 010 changelog table ([d0b7b67](https://github.com/pedronastasi/manychat-ai-agent/commit/d0b7b672e67a5768431ff4ca6847b0d0a650e8d0))

## [0.3.3](https://github.com/pedronastasi/manychat-ai-agent/compare/manychat-ai-agent-v0.3.2...manychat-ai-agent-v0.3.3) (2026-09-16)


### Bug Fixes

* regenerate lockfile for pnpm 12 and add workspace config ([67fc8d8](https://github.com/pedronastasi/manychat-ai-agent/commit/67fc8d8fbc1e0f1c3a44b142175175cac5f52243))

## [0.3.2](https://github.com/pedronastasi/manychat-ai-agent/compare/manychat-ai-agent-v0.3.1...manychat-ai-agent-v0.3.2) (2026-09-16)


### Bug Fixes

* downgrade to TypeScript 6.0 — typescript-eslint does not support TS 7 ([c26a70d](https://github.com/pedronastasi/manychat-ai-agent/commit/c26a70d49eb54c1f1473ca4818e12c4528445e00))

## [0.3.1](https://github.com/pedronastasi/manychat-ai-agent/compare/manychat-ai-agent-v0.3.0...manychat-ai-agent-v0.3.1) (2026-09-16)


### Bug Fixes

* gate release-please to the public repo only ([fa58933](https://github.com/pedronastasi/manychat-ai-agent/commit/fa58933e11787c6c91650d5aac3789115ace160e))
* gate release-please to the public repo only ([b545948](https://github.com/pedronastasi/manychat-ai-agent/commit/b545948228aca002a2ec39683c16fe491e5da610))

## [0.3.0](https://github.com/pedronastasi/manychat-ai-agent/compare/manychat-ai-agent-v0.2.0...manychat-ai-agent-v0.3.0) (2026-09-16)


### Features

* batch dependency updates and auto-merge only patches ([7bfb068](https://github.com/pedronastasi/manychat-ai-agent/commit/7bfb0687c4c1fc577ac48de8d232cf3bfa2835f8))
* batch dependency updates and auto-merge only patches ([d628930](https://github.com/pedronastasi/manychat-ai-agent/commit/d6289304d83587ff0d16ed0f96ad4d1d8eba64dd))


### Specs and Docs

* record the PR that landed specs/011 ([cc0c14a](https://github.com/pedronastasi/manychat-ai-agent/commit/cc0c14ae166b714a376f24193cd9d160ab46358c))

## [0.2.0](https://github.com/pedronastasi/manychat-ai-agent/compare/manychat-ai-agent-v0.1.0...manychat-ai-agent-v0.2.0) (2026-09-16)


### Features

* add Ollama as a local model provider ([1274bac](https://github.com/pedronastasi/manychat-ai-agent/commit/1274bacaa9882db22cc558c7cad7ffcfeb898738))
* add Ollama as a local model provider (specs/007) ([aa1da2f](https://github.com/pedronastasi/manychat-ai-agent/commit/aa1da2f0f5ba078a5ea45260eccea24f779040e1))
* cut releases from a reviewable Release PR ([de2a4c6](https://github.com/pedronastasi/manychat-ai-agent/commit/de2a4c645f5d5c728cd44f175ccee8b3543c4045))
* cut releases from a reviewable Release PR ([d8c4364](https://github.com/pedronastasi/manychat-ai-agent/commit/d8c4364c77d49c52f778367b67f327c227a309ac))
* implement the agent gateway MVP ([63be48a](https://github.com/pedronastasi/manychat-ai-agent/commit/63be48a28c8251d883d356b7a652ac61f3c316b0))
* implement the agent gateway MVP ([aba2203](https://github.com/pedronastasi/manychat-ai-agent/commit/aba2203c7215c1e84634e2f0360bf89452928c18))
* let a tenant carry its own eval suite ([e2b50da](https://github.com/pedronastasi/manychat-ai-agent/commit/e2b50dacc3cfd759fe31a1c5779491caa574e42e))
* let a tenant carry its own eval suite ([704e530](https://github.com/pedronastasi/manychat-ai-agent/commit/704e530c6aa22e836d17b7ffd3ff63ea160e8f93))
* make a spec state whether its behaviour exists yet ([89f653a](https://github.com/pedronastasi/manychat-ai-agent/commit/89f653a60cd90e7192efcefe475c6ffb6915e01a))
* make a spec state whether its behaviour exists yet ([423e318](https://github.com/pedronastasi/manychat-ai-agent/commit/423e318ec6469114060b91eb9959fcc4cdb9d375))
* replace sendContent with flow-based delivery (specs/002) ([0603016](https://github.com/pedronastasi/manychat-ai-agent/commit/0603016d4e4efbf455b4f4fc2aa8a69c8ede0ddf))
* scripted opening on a configured sentinel (specs/001) ([9bc8ff5](https://github.com/pedronastasi/manychat-ai-agent/commit/9bc8ff5c87e9375ec89018da2ee14753cb10258a))
* scripted opening trigger and flow-based delivery ([a4cd0c5](https://github.com/pedronastasi/manychat-ai-agent/commit/a4cd0c5d1800fe398ee8cb094371df2d76f70456))


### Bug Fixes

* green eval:mock on main after [#17](https://github.com/pedronastasi/manychat-ai-agent/issues/17) ([00a50c2](https://github.com/pedronastasi/manychat-ai-agent/commit/00a50c2b23d3a756b4aa6035e3453c03714864df))
* keep MODEL_ABORT_MS armed on the deferred path, record the model ([2089bcc](https://github.com/pedronastasi/manychat-ai-agent/commit/2089bcc7cd1f29adc6178f0b90588506571c12f4))
* mount config into container and update Postgres 18 volume path ([7718a3b](https://github.com/pedronastasi/manychat-ai-agent/commit/7718a3b813f90d2dc5840ed02f704507c5a8b927))


### Refactors

* English throughout, and no customer copy in source ([e3094ee](https://github.com/pedronastasi/manychat-ai-agent/commit/e3094ee83c75de1ddca78b9abb5eb0912a3a5b15))
* English throughout, and no customer copy in source ([8662c05](https://github.com/pedronastasi/manychat-ai-agent/commit/8662c0584d7041f6e74da5ca002d06de241a935c))
* implement ports as classes rather than factory functions ([1738550](https://github.com/pedronastasi/manychat-ai-agent/commit/17385504b22749a00f6aa1b7af1014ad526226e4))
* implement ports as classes rather than factory functions ([36245bd](https://github.com/pedronastasi/manychat-ai-agent/commit/36245bd7c4599a0b920f457ff8a9bea7fb92459b))


### Specs and Docs

* add CLAUDE.md with codebase documentation ([3b94ae4](https://github.com/pedronastasi/manychat-ai-agent/commit/3b94ae4943d9fe835fe36ce68785a3f4547a27af))
* add CLAUDE.md with codebase documentation ([34d24b2](https://github.com/pedronastasi/manychat-ai-agent/commit/34d24b2aee8b4ed1f1b5db64f84c3c9e03d7383b))
* add Docker setup and API walkthrough to README ([8cc50c2](https://github.com/pedronastasi/manychat-ai-agent/commit/8cc50c2c33a05136c55459321dd0970fc3b94c39))
* add the pull request template specified in 006 ([b329490](https://github.com/pedronastasi/manychat-ai-agent/commit/b329490ca49dc49261cfd095df164bf970abb63d))
* close spec 007's unkept promise and verify its claims ([a988eb2](https://github.com/pedronastasi/manychat-ai-agent/commit/a988eb2a2da203593a96b047568b2c4f8ade22fb))
* close spec 007's unkept promise and verify its claims ([0381946](https://github.com/pedronastasi/manychat-ai-agent/commit/0381946cbc4dfdbcbe034e4ea2ed2c3ba2184875))
* link to PGlite in quick-start blurb ([ef25a41](https://github.com/pedronastasi/manychat-ai-agent/commit/ef25a41177e15d120578ba5ea7ab5ee182459e32))
* record classes as the standard for port implementations ([746c874](https://github.com/pedronastasi/manychat-ai-agent/commit/746c874422d56380bc6100c3a4100bc47cfa08d2))
* record the PR that landed specs/009 ([53bdae0](https://github.com/pedronastasi/manychat-ai-agent/commit/53bdae02d67c890e317cc14d27982774295ecf9b))
* remove tenant identity from the published repo ([e24b335](https://github.com/pedronastasi/manychat-ai-agent/commit/e24b335d4965dbef9daff91a6fbbd51d6c2c4715))
* require English in the repository, and no copy in source ([395bcda](https://github.com/pedronastasi/manychat-ai-agent/commit/395bcda2426455a478cbb9c34e54165269e10627))
* specify running a real model locally via Ollama ([2aeb100](https://github.com/pedronastasi/manychat-ai-agent/commit/2aeb100a5d284f5493c1dd008fe2d3df4a930475))
* specify running a real model locally via Ollama ([7fc04ca](https://github.com/pedronastasi/manychat-ai-agent/commit/7fc04ca43e31bf0f8026ca6abf4486f61ba5203d))
* specify tenant eval suites ([faff5af](https://github.com/pedronastasi/manychat-ai-agent/commit/faff5af592282125d3166974aa51997acf2adb0c))
* specify the agent before building it ([095e7a4](https://github.com/pedronastasi/manychat-ai-agent/commit/095e7a472b0940f8e93638a593a0190f9a5062b4))
* specify the release workflow and dependency updates ([d63cdca](https://github.com/pedronastasi/manychat-ai-agent/commit/d63cdca7d595b9684a5eb11d05c14d6ea789f62a))
* specify the release workflow and dependency updates ([3253c49](https://github.com/pedronastasi/manychat-ai-agent/commit/3253c49c85ead6ba41d3ef54660be6a7f45b30a2))
* specify the testing strategy ([8b39203](https://github.com/pedronastasi/manychat-ai-agent/commit/8b392032f858acce1c27cd07ae1c5ae11c8942ee))
* specify what a pull request must say ([beeb226](https://github.com/pedronastasi/manychat-ai-agent/commit/beeb226da1f5e9d3337265696e6c1af902d3e293))
