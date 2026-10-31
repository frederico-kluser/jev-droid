import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { sdkPaths, type SdkPaths } from "../config.js";
import { ensureDir, run } from "../util.js";
import { Adb, listDevices, resolveSerial } from "./adb.js";
import { androidEnv } from "./sdk.js";

export interface AvdInfo {
  name: string;
  path: string;
  target?: string;
  image?: string;
  device?: string;
  ram?: string;
}

export interface CreateAvdOptions {
  paths: SdkPaths;
  name: string;
  api?: number;
  variant?: "google_apis" | "google_apis_playstore" | "aosp_atd" | "google_atd" | "default";
  abi?: string;
  device?: string;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  javaHome?: string;
  ramMb?: number;
  cores?: number;
}

export interface StartEmulatorOptions {
  paths: SdkPaths;
  avdName: string;
  port?: number;
  headless?: boolean;
  gpu?: "auto" | "swiftshader_indirect" | "host";
  logFile?: string;
  env?: NodeJS.ProcessEnv;
  wipeData?: boolean;
  extraArgs?: string[];
}

export interface StartedEmulator {
  pid: number;
  serial: string;
  logFile: string;
}

export function avdConfigPath(paths: SdkPaths, name: string): string {
  return path.join(paths.avdHome, `${name}.avd`, "config.ini");
}

export function avdExists(paths: SdkPaths, name: string): boolean {
  return fs.existsSync(avdConfigPath(paths, name));
}

export function listAvdDetails(paths: SdkPaths): AvdInfo[] {
  if (!fs.existsSync(paths.avdHome)) return [];
  const result: AvdInfo[] = [];
  for (const entry of fs.readdirSync(paths.avdHome)) {
    if (!entry.endsWith(".ini")) continue;
    const name = entry.slice(0, -4);
    const iniPath = path.join(paths.avdHome, entry);
    const ini = fs.readFileSync(iniPath, "utf8");
    const avdPath = ini.match(/^path=(.+)$/m)?.[1]?.trim() ?? path.join(paths.avdHome, `${name}.avd`);
    const configPath = path.join(avdPath, "config.ini");
    let config = "";
    try {
      config = fs.readFileSync(configPath, "utf8");
    } catch {
      continue;
    }
    const value = (key: string): string | undefined => config.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim();
    result.push({
      name,
      path: avdPath,
      target: value("target") ?? ini.match(/^target=(.+)$/m)?.[1]?.trim(),
      image: value("image.sysdir.1"),
      device: value("hw.device.name"),
      ram: value("hw.ramSize"),
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function setIniValue(content: string, key: string, value: string): string {
  const lines = content.split(/\r?\n/);
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) next.push(`${key}=${value}`);
  return next.filter((line, index, array) => line !== "" || index < array.length - 1).join("\n");
}

export function configureAvd(
  configPath: string,
  options: { ramMb?: number; cores?: number; gpuMode?: string; dataPartition?: string } = {},
): void {
  let content = fs.readFileSync(configPath, "utf8");
  const overrides: Record<string, string> = {
    "hw.ramSize": String(options.ramMb ?? 4096),
    "vm.heapSize": "512",
    "hw.cpu.ncore": String(options.cores ?? 4),
    "hw.gpu.enabled": "yes",
    "hw.gpu.mode": options.gpuMode ?? "swiftshader_indirect",
    "hw.keyboard": "yes",
    "hw.audioInput": "no",
    "hw.audioOutput": "no",
    showDeviceFrame: "no",
    "fastboot.forceColdBoot": "yes",
    "fastboot.forceFastBoot": "no",
    "fastboot.forceChosenSnapshotBoot": "no",
    "disk.dataPartition.size": options.dataPartition ?? "8G",
  };
  for (const [key, value] of Object.entries(overrides)) content = setIniValue(content, key, value);
  fs.writeFileSync(configPath, content, "utf8");
}

export async function createAvd(options: CreateAvdOptions): Promise<{ name: string; configPath: string; created: boolean }> {
  const api = options.api ?? 36;
  const variant = options.variant ?? "google_apis";
  const abi = options.abi ?? "x86_64";
  const packageName = `system-images;android-${api};${variant};${abi}`;
  const env = options.env ?? process.env;
  if (options.javaHome) env.JAVA_HOME = options.javaHome;
  const configPath = avdConfigPath(options.paths, options.name);

  if (fs.existsSync(configPath) && !options.force) {
    return { name: options.name, configPath, created: false };
  }
  const imageDir = path.join(options.paths.root, "system-images", `android-${api}`, variant, abi);
  if (!fs.existsSync(path.join(imageDir, "system.img"))) {
    throw new Error(
      `imagem ${packageName} não instalada — rode: sdkmanager "${packageName}" (ou use scripts/setup-android.ps1)`,
    );
  }
  if (!fs.existsSync(options.paths.avdmanager)) {
    throw new Error(`avdmanager não encontrado em ${options.paths.avdmanager}`);
  }

  const args = [
    "create",
    "avd",
    "--name",
    options.name,
    "--package",
    packageName,
    "--device",
    options.device ?? "pixel_6",
  ];
  if (options.force) args.push("--force");
  const result = await run(options.paths.avdmanager, args, {
    env,
    input: "no\n",
    timeoutMs: 120_000,
  });
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `avdmanager não criou o AVD ${options.name}: ${(result.stderr || result.stdout).trim().slice(0, 1200)}`,
    );
  }
  configureAvd(configPath, { ramMb: options.ramMb, cores: options.cores });
  if (variant.includes("playstore")) {
    let content = fs.readFileSync(configPath, "utf8");
    content = setIniValue(content, "PlayStore.enabled", "yes");
    content = setIniValue(content, "tag.id", "google_apis_playstore");
    content = setIniValue(content, "tag.display", "Google Play");
    fs.writeFileSync(configPath, content, "utf8");
  }
  return { name: options.name, configPath, created: true };
}

export function buildEmulatorArgs(options: StartEmulatorOptions): string[] {
  const headless = options.headless ?? true;
  const gpu = options.gpu ?? (headless ? "swiftshader_indirect" : "auto");
  const args = [
    "-avd",
    options.avdName,
    "-port",
    String(options.port ?? 5554),
    "-no-audio",
    "-no-boot-anim",
    "-gpu",
    gpu,
    "-no-snapshot",
    "-accel",
    "on",
    "-netfast",
    "-no-metrics",
  ];
  if (headless) args.push("-no-window");
  if (options.wipeData) args.push("-wipe-data");
  args.push(...(options.extraArgs ?? []));
  return args;
}

export async function startEmulator(options: StartEmulatorOptions): Promise<StartedEmulator> {
  if (!avdExists(options.paths, options.avdName)) {
    throw new Error(`AVD "${options.avdName}" não existe — rode: jev-droid avd create --name ${options.avdName}`);
  }
  if (!fs.existsSync(options.paths.emulator)) {
    throw new Error(`emulator não encontrado em ${options.paths.emulator}`);
  }
  const port = options.port ?? 5554;
  const serial = `emulator-${port}`;
  const existing = await listDevices(options.paths.adb, options.env);
  if (existing.some((device) => device.serial === serial && device.state === "device")) {
    return { pid: 0, serial, logFile: options.logFile ?? "" };
  }

  const logFile =
    options.logFile ??
    path.join(process.cwd(), "artifacts", "logs", `emulator-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  ensureDir(path.dirname(logFile));
  const fd = fs.openSync(logFile, "a");
  const args = buildEmulatorArgs(options);
  fs.writeSync(fd, `\n=== ${new Date().toISOString()} emulator ${args.join(" ")} ===\n`);
  const child = spawn(options.paths.emulator, args, {
    env: options.env ?? process.env,
    cwd: options.paths.root,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  fs.closeSync(fd);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  if (child.exitCode !== null) {
    const tail = tailFile(logFile, 4000);
    throw new Error(`emulador terminou imediatamente (exit ${child.exitCode}).\n${tail}`);
  }
  return { pid: child.pid ?? 0, serial, logFile };
}

export function tailFile(file: string, maxBytes = 4000): string {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

export async function waitForEmulator(
  adb: Adb,
  timeoutMs: number,
  onTick?: (elapsedMs: number, detail: string) => void,
): Promise<void> {
  const started = Date.now();
  let lastDetail = "aguardando adb";
  while (Date.now() - started < timeoutMs) {
    const result = await adb.exec(["get-state"], { timeoutMs: 10_000 });
    const state = result.stdout.trim();
    if (state === "device") {
      const boot = await adb.shell("getprop", "sys.boot_completed").catch(() => "");
      const anim = await adb.shell("getprop", "init.svc.bootanim").catch(() => "");
      lastDetail = `boot_completed=${boot || "?"} bootanim=${anim || "?"}`;
      if (boot === "1" && (anim === "stopped" || anim === "")) return;
    } else {
      lastDetail = `adb state=${state || "offline"}`;
    }
    onTick?.(Date.now() - started, lastDetail);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`emulador não arrancou em ${Math.round(timeoutMs / 1000)}s (${lastDetail})`);
}

export async function prepareDevice(adb: Adb): Promise<void> {
  await adb.shell("settings", "put", "global", "window_animation_scale", "0").catch(() => "");
  await adb.shell("settings", "put", "global", "transition_animation_scale", "0").catch(() => "");
  await adb.shell("settings", "put", "global", "animator_duration_scale", "0").catch(() => "");
  await adb.shell("svc", "power", "stayon", "true").catch(() => "");
  await adb.shell("wm", "dismiss-keyguard").catch(() => "");
  await adb.shell("input", "keyevent", "82").catch(() => "");
}

export async function stopEmulator(adb: Adb): Promise<void> {
  await adb.killEmulator().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

export interface EnsureEmulatorOptions {
  config: Config;
  headless?: boolean;
  restart?: boolean;
  port?: number;
  wipeData?: boolean;
}

export interface EnsuredEmulator {
  adb: Adb;
  serial: string;
  started: boolean;
  pid?: number;
  logFile?: string;
}

/** Reuse a booted device when possible; otherwise boot the configured AVD. */
export async function ensureEmulator(options: EnsureEmulatorOptions): Promise<EnsuredEmulator> {
  const { config } = options;
  const paths = sdkPaths(config.sdkRoot);
  const env = androidEnv(config);
  const port = options.port ?? 5554;
  const preferred = config.serial ?? `emulator-${port}`;
  let existingSerial = await resolveSerial(paths.adb, preferred, env);
  // Never hijack a physical phone just because it is the only adb device.
  if (!config.serial && existingSerial && !existingSerial.startsWith("emulator-")) existingSerial = undefined;

  if (existingSerial && !options.restart) {
    const adb = new Adb({ adbPath: paths.adb, serial: existingSerial, env });
    try {
      // An emulator that is still booting shows as `offline`; wait for it instead
      // of launching a second instance on the same port.
      await adb.waitForDevice(30_000);
      await waitForEmulator(adb, config.bootTimeoutMs);
      await prepareDevice(adb);
      return { adb, serial: existingSerial, started: false };
    } catch {
      // Stale/offline device: fall through and try a fresh boot.
    }
  }

  if (existingSerial && options.restart) {
    const adb = new Adb({ adbPath: paths.adb, serial: existingSerial, env });
    await stopEmulator(adb);
  }

  const logFile = path.join(config.artifactsDir, "logs", `emulator-${Date.now()}.log`);
  const started = await startEmulator({
    paths,
    avdName: config.avdName,
    port,
    headless: options.headless ?? config.headless,
    logFile,
    env,
    wipeData: options.wipeData,
  });
  const adb = new Adb({ adbPath: paths.adb, serial: started.serial, env });
  await waitForEmulator(adb, config.bootTimeoutMs);
  await prepareDevice(adb);
  return { adb, serial: started.serial, started: true, pid: started.pid, logFile: started.logFile };
}
