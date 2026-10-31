# Troubleshooting

## Instalação / Windows

### `spawn EINVAL` ao criar o AVD

O Node no Windows não consegue executar `.bat`/`.cmd` diretamente. O projeto já trata disso passando por `cmd.exe /d /s /c`. Se vir este erro, está a correr uma versão antiga: `npm run build` e tente de novo.

### `Enable-WindowsOptionalFeature` devolve “Classe não registrada”

Use o DISM diretamente, numa consola **Administrador**:

```powershell
dism /Online /Enable-Feature /FeatureName:HypervisorPlatform /All
```

Reinicie se for pedido e confirme:

```powershell
Get-CimInstance Win32_OptionalFeature -Filter "Name='HypervisorPlatform'" |
  Select-Object Name,InstallState     # 1
emulator -accel-check                 # WHPX ... is installed and usable
```

### `npm install` avisa de `esbuild` com install scripts

O npm desta máquina pode ter `allow-scripts` ativo. Aprove o script do esbuild:

```powershell
npm approve-scripts esbuild
# ou
npm approve-scripts --allow-scripts-pending
```

Sem isso, `tsx` pode falhar com “esbuild binary not found”. Alternativa: `npm rebuild esbuild`.

### `avdmanager` escreve `Error: Could not load devices ... devices.xml`

Aviso benigno das imagens ATD/Google APIs: o `devices.xml` não existe na imagem, mas o AVD é criado na mesma. Confirme com:

```powershell
emulator -list-avds
Test-Path "$env:USERPROFILE\.android\avd\jev_google_36.avd\config.ini"
```

## Emulador

### `emulator` arranca mas fica `offline`

1. Espere 90–120 s (cold boot).
2. Veja o log: `artifacts/logs/emulator-*.log`.
3. `adb kill-server; adb start-server; adb devices`.
4. Se houver um processo antigo: `Get-Process emulator,qemu-system-x86_64 -ErrorAction SilentlyContinue | Stop-Process -Force`.
5. Confirme que o porto 5554 está livre: `Get-NetTCPConnection -LocalPort 5554`.

### `boot_completed` nunca chega a 1

- AVD com RAM insuficiente: confirme `hw.ramSize=4096` no `config.ini`.
- Imagem corrompida: `sdkmanager --install "system-images;android-36;google_apis;x86_64" --force`.
- Tente `-wipe-data` uma vez: `node dist/cli.js avd start --name jev_google_36 --wipe`.
- Veja o log do emulador; erros de WHPX aparecem nas primeiras linhas.

### `WHPX is not installed` / `HAXM is not installed`

- WHPX é o único caminho suportado; ative a feature e reinicie.
- Não instale HAXM (descontinuado e incompatível com Hyper-V).
- Em máquinas com VBS/Core Isolation, o hipervisor já corre; o que falta é a API WHPX.

### AVD `aosp_atd` não tem Definições/launcher

É esperado. A imagem ATD é stripped para testes instrumentados. Use a imagem `google_apis` e o AVD `jev_google_36` para automação geral.

## ADB / UI

### `uiautomator dump` devolve “UI hierchary dumped” mas o XML está vazio

O projeto tenta o ficheiro e, em fallback, `exec-out uiautomator dump /dev/tty`. Se ambos falharem:

```powershell
adb -s emulator-5554 shell uiautomator dump /sdcard/window_dump.xml
adb -s emulator-5554 exec-out cat /sdcard/window_dump.xml
```

Se o XML tiver `<hierarchy>` mas poucos nós, a app pode não expor acessibilidade (Canvas/WebView). Não há solução só com UI Automator.

### `input text` não escreve acentos/emoji

Limitação do `input` do Android. Use ASCII ou instale ADBKeyboard e envie por broadcast. O projeto rejeita Unicode com uma mensagem clara em vez de escrever lixo.

### Toque no sítio errado

- O ecrã pode ter mudado entre o dump e o tap. O agente volta a capturar no passo seguinte; se persistir, use `--max-steps` maior e veja os PNGs.
- Contentores clicáveis sem rótulo são enriquecidos com os rótulos dos filhos; ainda assim, prefira refs de linhas (`LinearLayout` com label herdado).

### `adb devices` mostra `unauthorized`

Aceite o diálogo de depuração USB no dispositivo. Em emulador, reinicie com `-wipe-data` se o diálogo estiver corrompido.

## OpenRouter / modelo

| Erro | Causa | Solução |
|---|---|---|
| 401 | chave inválida/revogada | gere outra em <https://openrouter.ai/keys> |
| 402 | créditos insuficientes | adicione créditos ou use outra chave |
| 404 | modelo/provider inexistente ou restrições | confirme `JEV_DROID_MODEL`; remova `JEV_DROID_PROVIDER` |
| 429 | rate limit | o cliente já faz backoff; reduza concorrência |
| 503 | nenhum provider disponível | remova restrições de provider e tente de novo |

Diagnóstico:

```powershell
node dist/cli.js doctor --live
node dist/cli.js models --query deepseek
node dist/cli.js run "..." --dry-run
```

### O modelo devolve JSON inválido

O agente tenta uma reparação automática. Se falhar:

- confirme que o modelo suporta `response_format` (`doctor` avisa);
- baixe `JEV_DROID_TEMPERATURE` para 0;
- use `--model deepseek/deepseek-v4.1-flash-1017` para garantir o slug.

### A tarefa termina em `fail` ou no limite de passos

- Veja `summary.json` e os PNGs em `artifacts/runs/...`.
- Aumente `--max-steps`.
- Simplifique a tarefa (“abrir Definições”, depois “entrar em Rede”).
- Se um diálogo de permissão bloquear, o modelo deve escolher a opção de menor privilégio; se não o fizer, use `--yes` com supervisão.

## JEV

| Erro | Causa | Solução |
|---|---|---|
| 400/422 | pedido inválido | `jev validate --file` antes de gastar tokens |
| 401 | chave | igual ao OpenRouter |
| 402 | créditos | idem |
| 429 | rate limit | retry automático; reduza chamadas |
| resposta sem `answers` | endpoint errado | confirme `JEV_DROID_JEV_BASE_URL` |

O guard nunca confia cegamente no JEV: se ele falhar, a ação sensível cai para confirmação humana.

## GitHub / governança

### O ruleset bloqueia o merge

- `main` exige PR, histórico linear e o status check `build`.
- O projeto é solo-maintainer: 0 aprovações obrigatórias, mas checks verdes são obrigatórios.
- Se o check `build` não aparecer, confirme que o workflow `ci.yml` correu no PR.

### `gh` com 403/404

Verifique escopos (`gh auth status`) e SSO da organização. Nunca imprima o token.

## Recolher diagnóstico

```powershell
node dist/cli.js doctor --live > doctor.txt 2>&1
node dist/cli.js ui dump --raw > ui.xml
Get-Content artifacts/logs/emulator-*.log -Tail 100
Get-Content artifacts/runs/<run>/summary.json
```

Antes de abrir issue, remova do `doctor.txt`/`ui.xml` qualquer dado pessoal.
