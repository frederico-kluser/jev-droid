<#
.SYNOPSIS
    Instala e configura o stack Android gratuito do jev-droid no Windows.

.DESCRIPTION
    Idempotente: instala o JDK 21 (se faltar), as command-line tools oficiais,
    platform-tools, emulator, a imagem oficial Android e cria o AVD.
    Usa WHPX / Windows Hypervisor Platform (nativo, sem licenças).
    Não requer Android Studio.

.PARAMETER SdkRoot
    Pasta do Android SDK. Predefinição: %LOCALAPPDATA%\Android\Sdk

.PARAMETER AvdName
    Nome do AVD a criar. Predefinição: jev_google_36

.PARAMETER Api
    Nível de API. Predefinição: 36

.PARAMETER Variant
    google_apis (completa), aosp_atd/google_atd (leve para testes) ou default.

.PARAMETER Device
    Perfil de hardware do avdmanager. Predefinição: pixel_6

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-android.ps1
#>
[CmdletBinding()]
param(
  [string]$SdkRoot = "$env:LOCALAPPDATA\Android\Sdk",
  [string]$AvdName = "jev_google_36",
  [int]$Api = 36,
  [ValidateSet("google_apis", "google_apis_playstore", "aosp_atd", "google_atd", "default")]
  [string]$Variant = "google_apis",
  [string]$Device = "pixel_6",
  [string]$CmdlineToolsUrl = "https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip",
  [switch]$SkipJava,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "  [ok] $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "  [!]  $Message" -ForegroundColor Yellow }

if ($env:OS -ne "Windows_NT") {
  throw "Este script é para Windows. Noutro SO use sdkmanager/avdmanager manualmente."
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)

Write-Step "1/6 Windows Hypervisor Platform (WHPX)"
$feature = Get-CimInstance -ClassName Win32_OptionalFeature -Filter "Name='HypervisorPlatform'" -ErrorAction SilentlyContinue
if ($feature -and $feature.InstallState -eq 1) {
  Write-Ok "WHPX já está ativo"
} elseif ($isAdmin) {
  Write-Host "  A ativar WHPX (pode exigir reinício)…"
  $dism = & dism.exe /Online /Enable-Feature /FeatureName:HypervisorPlatform /All /NoRestart 2>&1
  if ($LASTEXITCODE -ne 0) { Write-Warn "DISM devolveu $LASTEXITCODE; verifique manualmente." }
  else { Write-Ok "WHPX ativado" }
} else {
  Write-Warn "WHPX não está ativo e a sessão não é admin. Execute como Administrador:"
  Write-Host '    dism /Online /Enable-Feature /FeatureName:HypervisorPlatform /All' -ForegroundColor DarkGray
}

Write-Step "2/6 JDK 21"
$javaHome = $env:JAVA_HOME
if (-not $SkipJava) {
  if (-not $javaHome -or -not (Test-Path (Join-Path $javaHome "bin\java.exe"))) {
    $jdk = Get-ChildItem "C:\Program Files\Microsoft" -Directory -Filter "jdk-21*" -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending | Select-Object -First 1
    if ($jdk) { $javaHome = $jdk.FullName }
  }
  if (-not $javaHome -or -not (Test-Path (Join-Path $javaHome "bin\java.exe"))) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) { throw "JDK 21 ausente e winget indisponível. Instale https://learn.microsoft.com/java/openjdk/download" }
    Write-Host "  A instalar Microsoft OpenJDK 21 via winget…"
    & winget install --id Microsoft.OpenJDK.21 -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
    if ($LASTEXITCODE -ne 0) { throw "winget falhou ao instalar o JDK (exit $LASTEXITCODE)" }
    $jdk = Get-ChildItem "C:\Program Files\Microsoft" -Directory -Filter "jdk-21*" |
      Sort-Object Name -Descending | Select-Object -First 1
    if (-not $jdk) { throw "JDK instalado mas pasta não encontrada em C:\Program Files\Microsoft" }
    $javaHome = $jdk.FullName
  }
  $env:JAVA_HOME = $javaHome
  Write-Ok "JAVA_HOME=$javaHome"
} else {
  Write-Warn "JDK ignorado (-SkipJava)"
}

Write-Step "3/6 Android command-line tools"
$cmdlineDir = Join-Path $SdkRoot "cmdline-tools\latest"
$sdkmanager = Join-Path $cmdlineDir "bin\sdkmanager.bat"
if (-not (Test-Path $sdkmanager)) {
  New-Item -ItemType Directory -Force -Path $SdkRoot | Out-Null
  $zip = Join-Path $env:TEMP "android-cmdline-tools.zip"
  $extract = Join-Path $env:TEMP "android-cmdline-tools-extract"
  Write-Host "  A descarregar $CmdlineToolsUrl"
  Invoke-WebRequest -Uri $CmdlineToolsUrl -OutFile $zip -UseBasicParsing
  if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
  Expand-Archive -Path $zip -DestinationPath $extract -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $SdkRoot "cmdline-tools") | Out-Null
  if (Test-Path $cmdlineDir) { Remove-Item -Recurse -Force $cmdlineDir }
  Move-Item (Join-Path $extract "cmdline-tools") $cmdlineDir
  Write-Ok "sdkmanager instalado em $cmdlineDir"
} else {
  Write-Ok "sdkmanager já existe"
}

$env:ANDROID_HOME = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot
$env:Path = "$SdkRoot\platform-tools;$SdkRoot\emulator;$cmdlineDir\bin;$javaHome\bin;$env:Path"

Write-Step "4/6 Licenças e pacotes do SDK"
1..200 | ForEach-Object { "y" } | & $sdkmanager --sdk_root=$SdkRoot --licenses | Out-Null
$image = "system-images;android-$Api;$Variant;x86_64"
$packages = @("platform-tools", "emulator", "platforms;android-$Api", $image)
Write-Host "  A instalar: $($packages -join ', ')"
1..200 | ForEach-Object { "y" } | & $sdkmanager --sdk_root=$SdkRoot @packages
if ($LASTEXITCODE -ne 0) { throw "sdkmanager falhou (exit $LASTEXITCODE)" }
Write-Ok "Pacotes instalados"

Write-Step "5/6 AVD $AvdName"
$avdmanager = Join-Path $cmdlineDir "bin\avdmanager.bat"
$avdIni = Join-Path $env:USERPROFILE ".android\avd\$AvdName.ini"
$configIni = Join-Path $env:USERPROFILE ".android\avd\$AvdName.avd\config.ini"
if ((Test-Path $configIni) -and -not $Force) {
  Write-Ok "AVD já existe (use -Force para recriar)"
} else {
  "no" | & $avdmanager create avd --name $AvdName --package $image --device $Device --force
  if (-not (Test-Path $configIni)) { throw "avdmanager não criou $configIni" }
  Write-Ok "AVD criado"
}

function Set-IniValue([string]$Path, [string]$Key, [string]$Value) {
  $lines = Get-Content $Path
  $found = $false
  $lines = $lines | ForEach-Object {
    if ($_ -match "^$([regex]::Escape($Key))=") { $found = $true; "$Key=$Value" } else { $_ }
  }
  if (-not $found) { $lines += "$Key=$Value" }
  $lines | Set-Content $Path -Encoding utf8
}

if (Test-Path $configIni) {
  $overrides = [ordered]@{
    "hw.ramSize" = "4096"
    "vm.heapSize" = "512"
    "hw.cpu.ncore" = "4"
    "hw.gpu.enabled" = "yes"
    "hw.gpu.mode" = "swiftshader_indirect"
    "hw.keyboard" = "yes"
    "hw.audioInput" = "no"
    "hw.audioOutput" = "no"
    "showDeviceFrame" = "no"
    "fastboot.forceColdBoot" = "yes"
    "fastboot.forceFastBoot" = "no"
    "fastboot.forceChosenSnapshotBoot" = "no"
    "disk.dataPartition.size" = "8G"
  }
  foreach ($key in $overrides.Keys) { Set-IniValue $configIni $key $overrides[$key] }
  Write-Ok "AVD afinado para automação (4 GB RAM, 4 vCPU, GPU SwiftShader, cold boot)"
}

Write-Step "6/6 Variáveis de ambiente e verificação"
[Environment]::SetEnvironmentVariable("JAVA_HOME", $javaHome, "User")
[Environment]::SetEnvironmentVariable("ANDROID_HOME", $SdkRoot, "User")
[Environment]::SetEnvironmentVariable("ANDROID_SDK_ROOT", $SdkRoot, "User")
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$parts = @($userPath -split ";" | Where-Object { $_ })
foreach ($p in @("$SdkRoot\platform-tools", "$SdkRoot\emulator", "$cmdlineDir\bin", "$javaHome\bin")) {
  if ($parts -notcontains $p) { $parts += $p }
}
[Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")

& (Join-Path $SdkRoot "emulator\emulator.exe") -accel-check
Write-Host ""
& (Join-Path $SdkRoot "emulator\emulator.exe") -list-avds
Write-Host ""
Write-Host "Pronto. Abra um terminal novo (para herdar JAVA_HOME/PATH) e rode:" -ForegroundColor Green
Write-Host "  npm install" -ForegroundColor Gray
Write-Host "  npm run doctor" -ForegroundColor Gray
Write-Host "  npm run emulator:start" -ForegroundColor Gray
Write-Host "  npm run dev -- run `"Abrir Definições e confirmar o estado do Wi-Fi`"" -ForegroundColor Gray
