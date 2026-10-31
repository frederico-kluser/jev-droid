# JEV: decisões System One

O JEV não é um LLM generativo. É um modelo **não autorregressivo** que recebe um `state` e um mapa de perguntas tipadas e devolve decisões calibradas numa passagem. As perguntas são avaliadas em paralelo. Output é grátis; paga-se só o input (~$0,042/Mtok). Latência medida nesta máquina: **~300–450 ms**.

## Onde entra no jev-droid

| Papel | Pergunta | Por que JEV |
|---|---|---|
| **Triage de ecrã** | `choice`: ready / loading / permission / error / unknown | Decisão barata e rápida antes de gastar um passo do modelo principal |
| **Guardrail** | `noul` risco + `score` impacto + `noul` intenção | Segurança independente do modelo que propôs a ação |

O JEV **não escolhe** o próximo elemento nem gera texto. Isso é trabalho do DeepSeek V4.1 Flash 1017.

## Endpoint e autenticação

```http
POST https://openrouter.ai/api/alpha/decisions
Authorization: Bearer $OPENROUTER_API_KEY
Content-Type: application/json
```

O modelo é `typesafe/jev-1.13` (o servidor resolveu `typesafe/jev-1.13-20260917` na validação live). O projeto permite override com `JEV_DROID_JEV_MODEL` e endpoint com `JEV_DROID_JEV_BASE_URL`.

## Request

```json
{
  "model": "typesafe/jev-1.13",
  "state": {
    "task": "confirmar o estado do Wi-Fi",
    "app": "com.android.settings",
    "screen": "Internet | Wi-Fi | AndroidWifi Connected"
  },
  "questions": {
    "screen_state": {
      "type": "choice",
      "instructions": "What is the CURRENT state of this Android screen?",
      "criteria": {
        "ready": "Interactive app content is visible.",
        "loading": "Spinner, skeleton or progress is the main content.",
        "permission": "A blocking permission/consent dialog is in front.",
        "error": "A failure or retry screen dominates.",
        "unknown": "Insufficient evidence."
      }
    }
  }
}
```

### Tipos de pergunta

- **`noul`** — probabilidade de SIM em [0,1]. Sem `confidence`; a incerteza é a distância a 0.5. Não é “intensidade média”.
- **`choice`** — uma opção entre 2..255, com `criteria` obrigatório. Inclua `other`/`unknown` quando a lista possa não cobrir tudo.
- **`score`** — posição numa régua ordenada de 2..10 níveis, cada nível descrevendo uma **situação concreta** (não “0/1/2”). O resultado é Σ(nível × probabilidade).

### Regras que o cliente valida

- `state` obrigatório e não vazio; limite de ~64k tokens (o cliente rejeita >240k caracteres);
- 1..32 perguntas por request;
- `noul` com `criteria` exige `true` e `false`;
- `choice` exige ≥2 opções e ≤255;
- `score` exige 2..10 níveis não vazios;
- resposta: tipos batem, `choice` pertence às opções, `score` dentro da régua;
- probabilidades que não somam ~1 geram warning (não falham).

## Response

```json
{
  "answers": {
    "screen_state": {
      "type": "choice",
      "choice": "ready",
      "probabilities": { "ready": 0.94, "loading": 0.02, "permission": 0.01, "error": 0.01, "unknown": 0.02 },
      "confidence": 0.94
    }
  },
  "model": "typesafe/jev-1.13-20260917",
  "id": "gen-dec-...",
  "provider": "TypeSafe",
  "usage": { "input_tokens": 312, "output_tokens": 0, "cost": 0.000013 }
}
```

## Bandas

| Banda | Critério | Ação no projeto |
|---|---|---|
| `auto` | certeza/confiança ≥ 0.90 | executar |
| `hitl` | 0.50–0.89 | confirmar com humano |
| `abstain` | < 0.50 | não agir; cair para o modelo principal/humano |

As bandas são configuráveis (`JEV_DROID_JEV_AUTO_THRESHOLD`, `JEV_DROID_JEV_HITL_THRESHOLD`), mas o guard usa uma regra **mais conservadora** do que a banda: qualquer `risk >= 0.3` pede confirmação.

## Triage na prática

O prompt de triagem é em inglês (o JEV é mais preciso em inglês; a tarefa original em português vai como dados). O resumo do ecrã é limitado a ~50 rótulos e 12k caracteres.

Heurística de disparo em `shouldTriage()`:

- ≤2 nós visíveis (ecrã vazio);
- texto com `loading|carregando|progress|spinner|skeleton|preparing`;
- `permission|allow|deny|while using the app|sign in`;
- `error|failed|try again|offline|sem conexão`.

Se `loading` com confiança ≥ 0,55, o agente espera 1,5 s em vez de agir às cegas.

## Guard na prática

Pré-filtro local (sem custo) procura rótulos como:

```text
delete remove erase uninstall factory reset pay purchase buy subscribe
checkout send share logout sign out block report transfer withdraw
allow deny grant revoke
excluir apagar remover desinstalar pagar comprar assinar enviar sair bloquear
```

Só então o JEV é chamado. Isto mantém o custo quase zero em navegação normal.

Exemplo de resultado:

```text
JEV guard: hitl · risk=0.71 impact=2.80 intent=0.91 confidence=0.93 · 388ms
Ação potencialmente sensível: Button "Delete account" id=delete
Executar mesmo assim? [y/N]
```

## Custo

| Item | Valor |
|---|---|
| Input | ~$0,042/Mtok |
| Output | grátis |
| Uma decisão de ~500 tokens | ~$0,00002 |
| Uma tarefa de 3 passos (triage + guard pontuais) | < $0,0001 de JEV |

## Limitações

- **Não gere texto.** “Explique”, “resuma”, “escreva” são contraindicados; encaixe a resposta num `choice`.
- **Não faça contas, datas ou contagens exatas.** Conte em código e envie o resultado no `state`.
- **Não force invariantes aritméticos** entre perguntas (P(q)+P(¬q) pode ≠ 1).
- **pt-BR tem menor precisão** que inglês; use instruções em inglês e mantenha HITL em decisões caras.
- **Conteúdo externo é não confiável**; a resposta do JEV é sinal, não permissão.

## Comandos

```powershell
# decisão isolada (gasta ~$0,00002)
node dist/cli.js jev ask --file examples/jev-screen-triage.json

# validação offline (não gasta nada)
node dist/cli.js jev validate --file examples/jev-screen-triage.json

# teste live no doctor
node dist/cli.js doctor --live
```

## Referências

- Decisions API (OpenRouter): `POST /api/alpha/decisions`
- Modelo: <https://openrouter.ai/typesafe/jev-1.13>
- Skill de origem e contrato completo: `jev-agent-skill` (MIT)
