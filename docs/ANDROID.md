# Android, WHPX e AVD

## Por que WHPX (e não HAXM)

O emulador oficial usa aceleração por hipervisor. No Windows moderno o caminho suportado é **WHPX** (Windows Hypervisor Platform), a API de virtualização que corre sobre o hipervisor do Windows (Hyper-V/VBS). HAXM está descontinuado. Não é preciso Hyper-V Manager nem Windows Pro: o **Windows 11 Home** suporta o Windows Hypervisor Platform.

O projeto usa a stack toda oficial e gratuita:

- `sdkmanager` para instalar pacotes;
- `avdmanager` para criar o AVD;
- `emulator` para arrancar;
- `adb` para falar com o dispositivo;
- `uiautomator dump` para a árvore de acessibilidade.

> O `sdkmanager` imprime um aviso de depreciação a favor do novo `android` CLI. Continua funcional e é o que o projeto usa, tal como pedido; o `android` CLI pode ser adotado no futuro sem mudar o AVD.

## 1. Ativar WHPX

Numa consola **Administrador**:

```powershell
dism /Online /Enable-Feature /FeatureName:HypervisorPlatform /All
# reinicie se o DISM pedir
```

Verificar:

```powershell
Get-CimInstance Win32_OptionalFeature -Filter "Name='HypervisorPlatform'" |
  Select-Object Name,InstallState      # 1 = ativo
```

O script `scripts/setup-android.ps1` faz isto sozinho quando corre como Administrador.

## 2. Instalar JDK, SDK e imagem

```powershell
npm run setup:android
```

O script:

1. ativa WHPX se necessário;
2. instala o Microsoft OpenJDK 21 via winget se não existir;
3. descarrega as command-line tools oficiais para `%LOCALAPPDATA%\Android\Sdk`;
4. aceita licenças e instala `platform-tools`, `emulator`, `platforms;android-36` e `system-images;android-36;google_apis;x86_64`;
5. cria o AVD `jev_google_36` com perfil `pixel_6`;
6. afina o AVD (4 GB RAM, 4 vCPU, GPU SwiftShader, cold boot, 8 GB de dados);
7. grava `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT` e o `PATH` do utilizador;
8. corre `emulator -accel-check` e lista os AVDs.

A instalação é idempotente. Para recriar o AVD, use `-Force`:

```powershell
npm run setup:android -- -Force
```

## 3. Layout do SDK

```text
%LOCALAPPDATA%\Android\Sdk\
  cmdline-tools\latest\bin\sdkmanager.bat
  cmdline-tools\latest\bin\avdmanager.bat
  platform-tools\adb.exe
  emulator\emulator.exe
  platforms\android-36\
  system-images\android-36\google_apis\x86_64\
```

O projeto lê `ANDROID_HOME`, `ANDROID_SDK_ROOT` ou o caminho padrão, por esta ordem. `JEV_DROID_SDK_ROOT` pode forçar outro.

## 4. Escolher a imagem

| Imagem | Tamanho | Traz Definições/launcher/Chrome? | Quando usar |
|---|---:|---|---|
| `google_apis_playstore;x86_64` | ~1,6 GB | Sim + **Google Play Store** | Instalar apps pela loja; precisa de conta Google |
| `google_apis;x86_64` | ~1,5 GB | Sim (Settings, Chrome, launcher, GMS básico) | **Predefinição**, automação geral |
| `default;x86_64` | ~1,2 GB | Parcial | Testes AOSP simples |
| `aosp_atd;x86_64` | ~700 MB | Não (só `fakesystemapp`) | Testes instrumentados, boot rápido |
| `google_atd;x86_64` | ~800 MB | Mínimo + GMS | Testes instrumentados com Google APIs |

**Play Store:** a imagem `google_apis` inclui Google Play Services, mas **não** inclui a Google Play Store (pode existir um stub `com.android.vending` sem activity de launcher). Para ter a loja, use `google_apis_playstore`; a imagem só está disponível para perfis Pixel/Nexus e o primeiro acesso pede uma conta Google.

ATD = *Automated Test Device*: system image oficial, stripped, sem launcher. É excelente para correr APKs de teste, mas **não** para tarefas como “abrir as Definições”. Por isso o AVD de automação geral usa `google_apis` ou `google_apis_playstore`.

## 5. AVD

Criar/afinar manualmente:

```powershell
node dist/cli.js avd create --name jev_google_36 --api 36 --variant google_apis --device pixel_6

# Variante com Google Play Store (instalar apps pela loja)
node dist/cli.js avd create --name jev_playstore_36 --api 36 --variant google_apis_playstore --device pixel_6
```

Listar:

```powershell
node dist/cli.js avd list
```

Configuração aplicada em `~/.android/avd/jev_google_36.avd/config.ini`:

```ini
hw.ramSize=4096
vm.heapSize=512
hw.cpu.ncore=4
hw.gpu.enabled=yes
hw.gpu.mode=swiftshader_indirect
hw.keyboard=yes
hw.audioInput=no
hw.audioOutput=no
showDeviceFrame=no
fastboot.forceColdBoot=yes
fastboot.forceFastBoot=no
fastboot.forceChosenSnapshotBoot=no
disk.dataPartition.size=8G
```

## 6. Arrancar e verificar

```powershell
npm run emulator:start
```

Flags usadas pelo projeto:

```text
-avd jev_google_36 -port 5554 -no-window -no-audio -no-boot-anim
-gpu swiftshader_indirect -no-snapshot -accel on -netfast -no-metrics
```

Verificações:

```powershell
adb devices -l
adb -s emulator-5554 shell getprop sys.boot_completed    # 1
adb -s emulator-5554 shell getprop ro.build.version.sdk  # 36
adb -s emulator-5554 shell wm size                       # 1080x2400
emulator -accel-check                                    # WHPX ... usable
```

Para ver a janela: `node dist/cli.js avd start --headed`. Para encerrar: `node dist/cli.js avd stop`.

## 7. ADB e UI hierarchy

O agente usa um subconjunto pequeno e estável de ADB:

```powershell
adb shell input tap 540 731
adb shell input swipe 540 1700 540 600 320
adb shell input text "hello%sworld"
adb shell input keyevent KEYCODE_BACK
adb shell monkey -p com.android.settings -c android.intent.category.LAUNCHER 1
adb shell uiautomator dump /sdcard/window_dump.xml
adb exec-out cat /sdcard/window_dump.xml
adb exec-out screencap -p > screen.png
```

O dump XML não inclui todos os detalhes visuais, mas inclui o essencial para automação:

- `text`, `content-desc`, `resource-id`, `class`, `package`;
- `bounds` em píxeis, `clickable`, `scrollable`, `checkable`, `checked`, `enabled`, `focused`, `password`;
- hierarquia e `rotation`.

`parseUiHierarchy` achata a árvore, calcula centros, remove nós inúteis, herda rótulos de contentores clicáveis e atribui refs `e1..eN`. O LLM recebe apenas esse resumo, não o XML inteiro.

## 8. Desempenho

- Cold boot com `google_apis` neste i9-14900HX: **~90 s**. Com snapshot seria mais rápido, mas o projeto usa cold boot para determinismo.
- SwiftShader evita depender de GPU/ANGLE em headless; é mais lento a desenhar, mas estável.
- 4 vCPU / 4 GB é um bom equilíbrio. Mais RAM não acelera o boot; mais vCPU ajuda pouco acima de 4.
- Desativar animações (`window_animation_scale=0`) é feito automaticamente após o boot.
- `uiautomator dump` leva ~0,5–1,5 s; é o principal custo por passo além do LLM.

## 9. Dispositivo físico

O projeto foi desenhado para emulador, mas aceita um dispositivo real:

```powershell
npm run dev -- run "Abrir as Definições" --serial <serial>
```

Nesse caso o AVD não é arrancado. Use por sua conta e risco: ações reais têm consequências reais.
