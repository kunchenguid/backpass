# Changelog

## [0.1.13](https://github.com/kunchenguid/backpass/compare/backpass-v0.1.12...backpass-v0.1.13) (2026-08-29)


### Features

* **prompts:** make gap domain a causal test and soften the extraction nudge ([#67](https://github.com/kunchenguid/backpass/issues/67)) ([4ae93a6](https://github.com/kunchenguid/backpass/commit/4ae93a6aa00cab2ad128ae0cb342f8f39e06b7b7))

## [0.1.12](https://github.com/kunchenguid/backpass/compare/backpass-v0.1.11...backpass-v0.1.12) (2026-08-28)


### Features

* judge gap identity and safeguard instruction removals ([#64](https://github.com/kunchenguid/backpass/issues/64)) ([85d5105](https://github.com/kunchenguid/backpass/commit/85d51055568cd106f516acca0df5f20603ede939))


### Bug Fixes

* keep EOF-reaching mixed removals merged ([#65](https://github.com/kunchenguid/backpass/issues/65)) ([8b5f625](https://github.com/kunchenguid/backpass/commit/8b5f6252c728f6181d56f889b699b2a890cf2471))
* make transcript sampling deterministic and sticky ([#62](https://github.com/kunchenguid/backpass/issues/62)) ([d177b06](https://github.com/kunchenguid/backpass/commit/d177b06a5fa6767391f17a26efeab862b4bc258a))

## [0.1.11](https://github.com/kunchenguid/backpass/compare/backpass-v0.1.10...backpass-v0.1.11) (2026-08-28)


### Bug Fixes

* **apply:** stop replacement-token expansion from corrupting apply.html ([#60](https://github.com/kunchenguid/backpass/issues/60)) ([f5d3c3a](https://github.com/kunchenguid/backpass/commit/f5d3c3addec9d3b9b900ab000da7fb01019a3187))

## [0.1.10](https://github.com/kunchenguid/backpass/compare/backpass-v0.1.9...backpass-v0.1.10) (2026-08-28)


### Bug Fixes

* **discovery:** discover BB-managed Pi sessions ([#58](https://github.com/kunchenguid/backpass/issues/58)) ([450c1a2](https://github.com/kunchenguid/backpass/commit/450c1a20ecb1a4655c56adcbea20c5f12b9d98f2))

## [0.1.9](https://github.com/kunchenguid/backpass/compare/backpass-v0.1.8...backpass-v0.1.9) (2026-08-28)


### Bug Fixes

* scope evidence reuse to the current memory hash ([#54](https://github.com/kunchenguid/backpass/issues/54)) ([2fc6dbf](https://github.com/kunchenguid/backpass/commit/2fc6dbf48648f921879935a521535f55d77205e4))

## [0.1.8](https://github.com/kunchenguid/backpass/compare/backpass-v0.1.7...backpass-v0.1.8) (2026-08-27)


### Bug Fixes

* correct synthesis orchestration and apply rollback ([#52](https://github.com/kunchenguid/backpass/issues/52)) ([8466e65](https://github.com/kunchenguid/backpass/commit/8466e65b59874ea5ab045664591244296b6d9518))
* keep harness model and effort overrides invocation-scoped ([#49](https://github.com/kunchenguid/backpass/issues/49)) ([c6d9ba8](https://github.com/kunchenguid/backpass/commit/c6d9ba8179e16fb9f720213afd705b5acb2ec88f))

## [0.1.7](https://github.com/kunchenguid/backpass/compare/backpass-v0.1.6...backpass-v0.1.7) (2026-08-27)


### Bug Fixes

* **apply:** prevent partial writes from stale proposals ([#47](https://github.com/kunchenguid/backpass/issues/47)) ([2f0df29](https://github.com/kunchenguid/backpass/commit/2f0df29e3394a8321502e79774b04024fe84419b))

## [0.1.6](https://github.com/kunchenguid/backpass/compare/backpass-v0.1.5...backpass-v0.1.6) (2026-08-26)


### Bug Fixes

* **apply:** reopen ended Lavish review sessions ([#45](https://github.com/kunchenguid/backpass/issues/45)) ([b0d92bc](https://github.com/kunchenguid/backpass/commit/b0d92bcb4f17175b9fcb24787ac1304991392d23))

## [0.1.5](https://github.com/kunchenguid/backpass/compare/backpass-v0.1.4...backpass-v0.1.5) (2026-08-25)


### Bug Fixes

* **discovery:** scan CLAUDE_CONFIG_DIR alongside the default claude store ([#41](https://github.com/kunchenguid/backpass/issues/41)) ([8d0b423](https://github.com/kunchenguid/backpass/commit/8d0b423a164bcd691b9ae6ac6fbcf3f1435aff3e))

## [0.1.4](https://github.com/kunchenguid/backpass/compare/backpass-v0.1.3...backpass-v0.1.4) (2026-08-25)


### Bug Fixes

* **apply:** revalidate accepted edit subsets ([#38](https://github.com/kunchenguid/backpass/issues/38)) ([1f473f2](https://github.com/kunchenguid/backpass/commit/1f473f22c30128cb4b2c27f7fe0e7910f9c6787c))

## [0.1.3](https://github.com/kunchenguid/backpass/compare/backpass-v0.1.2...backpass-v0.1.3) (2026-08-23)


### Bug Fixes

* **discovery:** recover Hermes v26 CLI sessions ([#28](https://github.com/kunchenguid/backpass/issues/28)) ([37457f9](https://github.com/kunchenguid/backpass/commit/37457f96c0907c746b983c511f0b4ba158834c7b))

## [0.1.2](https://github.com/kunchenguid/backpass/compare/backpass-v0.1.1...backpass-v0.1.2) (2026-08-23)


### Features

* **discovery:** add Hermes transcript support ([#26](https://github.com/kunchenguid/backpass/issues/26)) ([0445c33](https://github.com/kunchenguid/backpass/commit/0445c330701fc82686c1113483ea35c9226da1e1))

## [0.1.1](https://github.com/kunchenguid/backpass/compare/backpass-v0.1.0...backpass-v0.1.1) (2026-08-23)


### Features

* initial commit ([df73d32](https://github.com/kunchenguid/backpass/commit/df73d3255b0a78b4d5ada0f3f733c4a131cb59ae))


### Bug Fixes

* **apply:** open the review surface in the browser, announce waits once, and strip the quoted URL ([#18](https://github.com/kunchenguid/backpass/issues/18)) ([b922b9e](https://github.com/kunchenguid/backpass/commit/b922b9e4a57cee592684c8146f5ffbab6ab5fce7))
