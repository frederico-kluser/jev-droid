# Arquitetura

## Objetivo

Automatizar a UI de um Android **oficial e local** a partir de uma tarefa em linguagem natural, com duas responsabilidades separadas:

1. **System Two (DeepSeek V4.1 Flash 1017)** — entende a tarefa, interpreta a árvore de acessibilidade e escolhe a próxima ação.
2. **System One (JEV 1.13)** — decisões tipadas e baratas: o ecrã está em loading/erro/permissão? A ação é perigosa? Vale a pena bloquear?

O agente não usa Appium, UiAutomator2 server, Docker, cloud de dispositivos nem Android Studio. Fala diretamente com `adb` e com o emulador oficial.

## Non-goals

- Substituir testes instrumentados (Espresso/UiAutomator) em CI.
- Garantir apps que escondem a árvore de acessibilidade (Canvas puro, jogos, alguns WebViews).
- Controlar vários dispositivos em paralelo numa só execução.
- Fazer OCR ou visão computacional por omissão.

## Componentes

| Módulo | Responsabilidade | Não faz |
|---|---|---|
| `src/cli.ts` | parsing de argumentos, comandos, exit codes | lógica de agente |
| `src/config.ts` | `.env`, SDK/Java, limites, paths | validação de dispositivos |
| `src/openrouter.ts` | HTTP OpenAI-compatible, retries, JSON, custo | prompts |
| `src/jev.ts` | Decisions API, validação, bandas, triage/guard | rede Android |
| `src/android/sdk.ts` | probe de JDK/adb/emulator/WHPX, imagens, AVDs | executar ações |
| `src/android/adb.ts` | `adb` tipado, dump, screenshot, input | decidir o que tocar |
| `src/android/ui.ts` | parser de `uiautomator` → snapshot compacto | executar |
| `src/android/emulator.ts` | criar/afinar AVD, arrancar, esperar boot | decidir |
| `src/android/actions.ts` | schema, validação, execução, pré-filtro de risco | confirmação humana |
| `src/agent/prompt.ts` | system prompt, histórico, reparação | chamadas de rede |
| `src/agent/loop.ts` | ciclo perceber→decidir→proteger→agir→verificar | detalhes de ADB |
| `src/agent/guard.ts` | JEV guard + confirmação | executar ações |
| `src/agent/artifacts.ts` | run dir, XML/PNG/JSONL/summary | telemetria remota |

## Fluxo de uma execução

```text
runTask()
  ├─ valida tarefa e OPENROUTER_API_KEY
  ├─ resolve dispositivo:
  │    serial explícito? → adb wait-for-device + boot
  │    senão → ensureEmulator() → reutiliza ou arranca AVD → boot
  ├─ cria artifacts/runs/<timestamp>-<slug>/
  └─ loop (maxSteps):
       1. captureScreen()
          ├─ adb dumpsys window → package/activity
          ├─ adb shell uiautomator dump → XML
          └─ parseUiHierarchy() → refs e1..eN + assinatura
       2. screenshot (opcional, para auditoria)
       3. JEV triage (só se o ecrã parecer ambíguo)
          └─ loading → espera; permission/error → hint
       4. decide()
          ├─ system prompt + tarefa + ecrã + histórico
          ├─ POST /chat/completions (JSON object)
          └─ parseAction(); se inválido → 1 reparação
       5. done/fail? → termina
       6. guardAction()
          ├─ pré-filtro local de rótulos perigosos
          ├─ JEV guard (risco/impacto/intenção)
          └─ confirmação humana se necessário
       7. executeAction() via adb
       8. grava step.json/xml/png + histórico
       9. deteta loop (3 ações no mesmo ecrã) → hint
```

## Contrato do snapshot

`UiSnapshot` contém:

- `packageName`, `activity`, `rotation`, `width`, `height`;
- `nodes[]` com `ref`, `label`, `text`, `contentDesc`, `resourceId`, `className`, `bounds`, `center`, flags (`clickable`, `scrollable`, `editable`, `checked`, `enabled`, `focused`, `password`);
- `totalNodes` (árvore completa) e `signature` estável para deteção de loop;
- `xml` original (guardado em artefacto, não enviado inteiro ao LLM).

O parser ignora nós sem rótulo e sem interação, limita a 140 nós e **herda rótulos dos filhos para contentores clicáveis** (ex.: uma linha `LinearLayout` sem texto passa a `"Network & internet · Mobile, Wi‑Fi, hotspot"`). Isto é essencial: no Android, a linha clicável raramente tem `text`.

## Contrato de ações

Uma ação por turno, JSON estrito. O modelo não pode chamar shell, ADB, HTTP ou código. Ver [AGENT.md](AGENT.md).

## Artefactos

```text
artifacts/runs/20261031-182205-.../
  run.json          metadados (modelo, AVD, serial, versão, plataforma)
  events.jsonl      log append-only de eventos
  summary.json      ok, resumo, passos, tokens, custo, duração
  steps/001.xml     dump UI Automator
  steps/001.png     screenshot
  steps/001.json    ação, resultado, guard, triage, usage, latência
```

Isto permite auditar uma decisão sem reproduzir o modelo: vê-se o ecrã, a ação, o resultado e o custo.

## Erros, retries e idempotência

- **OpenRouter**: retry em 408/409/425/429/5xx/524/529 com backoff e `Retry-After`; erros 401/402/404/422 são terminais.
- **JEV**: mesmos códigos transitórios; 400/422 indicam pedido inválido (não repetir).
- **ADB**: `uiautomator dump` tenta 3 vezes; se falhar, tenta `exec-out uiautomator dump /dev/tty`.
- **Modelo**: uma resposta JSON inválida ou um `ref` inexistente disparam **uma** reparação; se voltar a falhar, a execução termina com erro e artefactos.
- **Guard**: se o JEV estiver indisponível, a ação sensível cai para confirmação humana; sem TTY e sem `--yes`, é bloqueada.
- **Emulador**: `ensureEmulator` reutiliza um dispositivo `emulator-*` já bootado; nunca agarra um telefone físico por engano.

## Custo e latência (medição real nesta máquina)

| Operação | Latência | Custo |
|---|---|---|
| Decisão JEV (1 pergunta) | ~409 ms | ~$0,000013 |
| Triagem JEV (1 choice) | ~300–450 ms | ~$0,00002 |
| Decisão DeepSeek (1 ação) | ~0,4–4,4 s | ~$0,00005–0,0001 |
| Tarefa demo (3 passos) | 20,9 s | **$0,00019** |
| Boot do AVD google_apis | ~90 s | $0 |

O JEV é chamado **só quando há sinal de ambiguidade** ou **rótulo potencialmente perigoso**, portanto o custo extra é desprezável.

## Segurança

- **Fronteira de confiança**: o XML da UI é conteúdo de terceiros. O system prompt marca-o explicitamente como não confiável. O modelo não tem ferramentas de shell; mesmo que “obedeça” a uma injeção, só consegue emitir ações limitadas.
- **Guardrail independente**: o JEV avalia a ação antes de o ADB a executar; o humano é o último recurso.
- **Redação**: texto digitado não aparece em logs nem no pedido ao JEV; só o modelo principal o recebe.
- **Segredos**: a chave vive no `.env`, nunca em logs/artefactos; `doctor` mostra só `sk-or-v1-…abcd`.

## Extensões previstas

- `screenshot`/visão opcional por passo (o modelo suporta imagem).
- Ações `long_press`, `scroll_until`, `open_url`.
- Backend Appium/UiAutomator2 para dispositivos físicos.
- Suporte a ADBKeyboard para Unicode.
- `serve` MCP para outros agentes chamarem o jev-droid.
