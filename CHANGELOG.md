# Changelog

All notable changes to **jev-droid** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

- Versions are tagged as `v<MAJOR>.<MINOR>.<PATCH>` from `main`.
- Entries are generated from [Conventional Commits](https://www.conventionalcommits.org/)
  at release time (see `cliff.toml` and the release automation in `.github/workflows/`).
- Compare views: <https://github.com/frederico-kluser/jev-droid/compare/>

## 1.0.0 (2026-10-31)


### Features

* bootstrap jev-droid Android automation agent ([#1](https://github.com/frederico-kluser/jev-droid/issues/1)) ([5132d8a](https://github.com/frederico-kluser/jev-droid/commit/5132d8a63b02a25296edebeaaff7c76044bf4b1a))

## [Unreleased]

### Added

- Agente de automação Android que combina DeepSeek V4.1 Flash 1017 (decisão) e JEV 1.13
  (triagem de ecrã e guardrail) via OpenRouter.
- Emulador oficial Android 36 `google_apis` com WHPX/Hyper-V nativo, `sdkmanager`,
  `avdmanager` e `emulator`, sem Android Studio.
- Controlo por ADB local: `uiautomator dump`, screenshots, tap/swipe/text/key/launch/wait.
- Parser de UI hierarchy com refs estáveis, herança de rótulos e resumo compacto para LLM.
- Guardrail JEV com bandas `auto`/`hitl`/`abstain` e confirmação humana para ações sensíveis.
- CLI com `doctor`, `run`, `avd`, `ui`, `jev`, `models`, `selftest` e `setup`.
- Artefactos por execução: XML, PNG, decisões, tokens, custo e resumo.
- Setup Windows idempotente (`scripts/setup-android.ps1`) e documentação de troubleshooting.
- Governança open-source: CI, testes em matriz, OpenSSF Scorecard, Dependabot, rulesets e hooks.

### Security

- Prompt injection tratada como risco: o texto da UI é marcado como não confiável e o modelo
  só pode emitir o schema de ações.
- Texto digitado é redigido dos logs e do pedido ao JEV.
- Chave OpenRouter apenas em `.env` (ignorado pelo git), com redação no diagnóstico.

<!--
  [Unreleased]: https://github.com/frederico-kluser/jev-droid/compare/v0.1.0...HEAD
-->
