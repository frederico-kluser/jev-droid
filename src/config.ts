import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseBoolean, parseNumber, which } from "./util.js";

export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017";
export const DEFAULT_JEV_MODEL = "typesafe/jev-1.13";
export const DEFAULT_AVD = "jev_google_36";
export const DEFAULT_OPENROUTER_BASE = "https://openrouter.ai/api/v1";
export const DEFAULT_JEV_BASE = "https://openrouter.ai/api/alpha/decisions";

export interface Config {
  cwd: string;
  sdkRoot: string;
  javaHome?: string;
  avdName: string;
  serial?: string;
  headless: boolean;
  model: string;
  jevModel: string;
  jevTriage: boolean;
  jevGuard: boolean;
  maxSteps: number;
  temperature: number;
  stepDelayMs: number;
  bootTimeoutMs: number;
  requestTimeoutMs: number;
  artifactsDir: string;
  provider?: string;
  jevAutoThreshold: number;
  jevHitlThreshold: number;
  openRouterKey?: string;
  openRouterBaseUrl: string;
  jevBaseUrl: string;
  appName: string;
  appUrl: string;
}

export interface LoadConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  loadEnvFile?: boolean;
}

function loadDotEnv(cwd: string): void {
  const file = path.join(cwd, ".env");
  if (!fs.existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch {
    // A malformed .env must not take the CLI down; doctor reports missing vars.
  }
}

export function findJavaHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.JAVA_HOME?.trim();
  if (explicit && fs.existsSync(explicit)) return explicit;

  const fromPath = which("java");
  if (fromPath) {
    const javaBin = path.dirname(fromPath);
    const candidate = path.dirname(javaBin);
    if (fs.existsSync(path.join(candidate, "bin"))) return candidate;
  }

  const roots =
    process.platform === "win32"
      ? [
          path.join(env.ProgramFiles ?? "C:\\Program Files", "Microsoft"),
          path.join(env.ProgramFiles ?? "C:\\Program Files", "Java"),
          path.join(env.ProgramFiles ?? "C:\\Program Files", "Eclipse Adoptium"),
          path.join(env.ProgramFiles ?? "C:\\Program Files", "Amazon Corretto"),
          path.join(env.ProgramFiles ?? "C:\\Program Files", "Zulu"),
        ]
      : ["/usr/lib/jvm", "/Library/Java/JavaVirtualMachines"];
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    const jdks = entries
      .filter((name) => /jdk|java/i.test(name))
      .map((name) => path.join(root, name))
      .filter((dir) => fs.existsSync(path.join(dir, "bin", process.platform === "win32" ? "java.exe" : "java")))
      .sort()
      .reverse();
    if (jdks[0]) return jdks[0];
  }
  return undefined;
}

export function findSdkRoot(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].filter((value): value is string => Boolean(value?.trim()));
  if (process.platform === "win32") {
    candidates.push(
      path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Android", "Sdk"),
      path.join(os.homedir(), "AppData", "Local", "Android", "Sdk"),
      "C:\\Android\\Sdk",
    );
  } else if (process.platform === "darwin") {
    candidates.push(path.join(os.homedir(), "Library", "Android", "sdk"));
  } else {
    candidates.push(path.join(os.homedir(), "Android", "Sdk"));
  }
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return path.resolve(candidate);
  }
  return path.resolve(candidates[0] ?? path.join(os.homedir(), "Android", "Sdk"));
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  if (options.loadEnvFile !== false) loadDotEnv(cwd);
  const env = options.env ?? process.env;

  const maxSteps = Math.max(1, Math.min(100, Math.trunc(parseNumber(env.JEV_DROID_MAX_STEPS, 20))));
  const temperature = Math.max(0, Math.min(2, parseNumber(env.JEV_DROID_TEMPERATURE, 0.2)));
  const autoThreshold = Math.max(0.5, Math.min(1, parseNumber(env.JEV_DROID_JEV_AUTO_THRESHOLD, 0.9)));
  const hitlThreshold = Math.max(0, Math.min(autoThreshold, parseNumber(env.JEV_DROID_JEV_HITL_THRESHOLD, 0.5)));

  return {
    cwd,
    sdkRoot: path.resolve(env.JEV_DROID_SDK_ROOT?.trim() || findSdkRoot(env)),
    javaHome: findJavaHome(env),
    avdName: env.JEV_DROID_AVD?.trim() || DEFAULT_AVD,
    serial: env.JEV_DROID_SERIAL?.trim() || undefined,
    headless: parseBoolean(env.JEV_DROID_HEADLESS, true),
    model: env.JEV_DROID_MODEL?.trim() || DEFAULT_MODEL,
    jevModel: env.JEV_DROID_JEV_MODEL?.trim() || DEFAULT_JEV_MODEL,
    jevTriage: parseBoolean(env.JEV_DROID_JEV_TRIAGE, true),
    jevGuard: parseBoolean(env.JEV_DROID_JEV_GUARD, true),
    maxSteps,
    temperature,
    stepDelayMs: Math.max(0, parseNumber(env.JEV_DROID_STEP_DELAY_MS, 800)),
    bootTimeoutMs: Math.max(30_000, parseNumber(env.JEV_DROID_BOOT_TIMEOUT_MS, 300_000)),
    requestTimeoutMs: Math.max(10_000, parseNumber(env.JEV_DROID_REQUEST_TIMEOUT_MS, 120_000)),
    artifactsDir: path.resolve(cwd, env.JEV_DROID_ARTIFACTS?.trim() || "artifacts"),
    provider: env.JEV_DROID_PROVIDER?.trim() || undefined,
    jevAutoThreshold: autoThreshold,
    jevHitlThreshold: hitlThreshold,
    openRouterKey: env.OPENROUTER_API_KEY?.trim() || undefined,
    openRouterBaseUrl: (env.JEV_DROID_OPENROUTER_BASE_URL?.trim() || DEFAULT_OPENROUTER_BASE).replace(/\/$/, ""),
    jevBaseUrl: (env.JEV_DROID_JEV_BASE_URL?.trim() || DEFAULT_JEV_BASE).replace(/\/$/, ""),
    appName: env.JEV_DROID_APP_NAME?.trim() || "jev-droid",
    appUrl: env.JEV_DROID_APP_URL?.trim() || "https://github.com/frederico-kluser/jev-droid",
  };
}

export interface SdkPaths {
  root: string;
  sdkmanager: string;
  avdmanager: string;
  emulator: string;
  adb: string;
  avdHome: string;
}

export function sdkPaths(sdkRoot: string): SdkPaths {
  const exe = process.platform === "win32" ? ".exe" : "";
  const bat = process.platform === "win32" ? ".bat" : "";
  return {
    root: sdkRoot,
    sdkmanager: path.join(sdkRoot, "cmdline-tools", "latest", "bin", `sdkmanager${bat}`),
    avdmanager: path.join(sdkRoot, "cmdline-tools", "latest", "bin", `avdmanager${bat}`),
    emulator: path.join(sdkRoot, "emulator", `emulator${exe}`),
    adb: path.join(sdkRoot, "platform-tools", `adb${exe}`),
    avdHome: path.join(os.homedir(), ".android", "avd"),
  };
}

export function redactKey(key: string | undefined): string {
  if (!key) return "(ausente)";
  if (key.length <= 12) return "***";
  return `${key.slice(0, 9)}…${key.slice(-4)}`;
}
