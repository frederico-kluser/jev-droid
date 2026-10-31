# Contributing to jev-droid

Obrigado pelo interesse. Este documento define o fluxo, as convenções e a qualidade mínima de qualquer alteração a `frederico-kluser/jev-droid`.

Ao participar, aceita o [Código de Conduta](CODE_OF_CONDUCT.md).

## Preparar o ambiente

```powershell
git clone https://github.com/frederico-kluser/jev-droid.git
cd jev-droid
npm ci
npm run build
npm test
npm run selftest
```

Requisitos completos em [README](README.md) e [docs/ANDROID.md](docs/ANDROID.md). Para trabalhar no agente sem emulador, os testes offline chegam; para testar UI, siga o setup Android.

## Branches

`main` é protegida: **nunca faça commit/push direto**. Use uma branch efémera:

```text
<type>/<slug>
```

Tipos fechados: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `revert`, `hotfix`, `release`.

Exemplos: `feat/unicode-input`, `fix/adb-timeout`, `docs/whpx-setup`.

Slug curto em kebab-case. Datas, nomes de pessoas e espaços são rejeitados pelo ruleset e pelo hook local.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), cabeçalho ≤ 72 caracteres:

```text
feat: add long-press action
fix(adb): retry uiautomator dump on empty XML
docs: explain WHPX on Windows Home
feat!: require Node 22
```

Tipos: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

`!` ou `BREAKING CHANGE:` no rodapé → MAJOR. O CI valida as mensagens no job `build`; instale os hooks locais para falhar mais cedo:

```bash
bash ~/.dsh/skills/opensource-project/scripts/oss-hooks.sh install
```

## Qualidade

Antes de abrir o PR:

```powershell
npm run typecheck
npm test
npm run build
npm run selftest
```

- Adicione/atualize testes para cada mudança de comportamento.
- Um bug fix deve trazer um teste de regressão que falha sem a correção.
- Não commite `artifacts/`, `.env`, `node_modules/` nem SDKs.
- Não inclua segredos nem dados de ecrãs reais em testes/fixtures.

## Pull request

1. Título = mensagem Conventional Commit (vira a mensagem do squash).
2. Corpo com motivação, abordagem e alternativas; use o template.
3. Ligue issues com `Closes #123`.
4. Mantenha o PR pequeno e focado.
5. O CI tem de estar verde: `build` é o status obrigatório.
6. **Sincronize com merge, nunca rebase**: `git fetch origin && git merge origin/main` (ou `git pull`). `git rebase` e `git pull --rebase` são proibidos.
7. O maintainer integra com **squash merge** e apaga a branch.

O projeto é solo-maintainer: não há aprovações obrigatórias, mas o PR e os checks são obrigatórios. Contribuições externas são bem-vindas e revistas pelo maintainer.

## Reportar bugs

Use o template de bug e inclua:

- passos para reproduzir;
- comportamento esperado vs. observado;
- `node dist/cli.js doctor --live` (com a chave redigida);
- versão do Node, Windows, modelo e AVD;
- `artifacts/runs/<run>/summary.json` e, se possível, o PNG do passo.

**Vulnerabilidades não vão para issues públicas.** Siga [SECURITY.md](SECURITY.md).

## Licença

Ao contribuir, concorda que a sua contribuição é licenciada sob a MIT deste repositório.
