import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { sdkPaths, type SdkPaths } from "../config.js";
import { run } from "../util.js";

export interface SdkProbe {
  paths: SdkPaths;
  java: { ok: boolean; version?: string; error?: string };
  adb: { ok: boolean; version?: string; error?: string };
  emulator: { ok: boolean; version?: string; error?: string };
  acceleration: { ok: boolean; detail: string };
  installedImages: string[];
  avds: string[];
  errors: string[];
}

export function androidEnv(config: Config): NodeJS.ProcessEnv {
  const paths = sdkPaths(config.sdkRoot);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (config.javaHome) env.JAVA_HOME = config.javaHome;
  env.ANDROID_HOME = config.sdkRoot;
  env.ANDROID_SDK_ROOT = config.sdkRoot;
  const extra = [
    config.javaHome ? path.join(config.javaHome, "bin") : undefined,
    path.dirname(paths.adb),
    path.dirname(paths.emulator),
    path.dirname(paths.sdkmanager),
  ].filter((value): value is string => Boolean(value));
  // On Windows the real key is `Path`; spreading process.env keeps `Path`, so
  // setting only `PATH` creates a duplicate that can hide System32 from cmd.exe.
  const currentPath = env.PATH ?? env.Path ?? "";
  const fullPath = [...extra, currentPath].filter(Boolean).join(path.delimiter);
  if (process.platform === "win32") {
    delete env.PATH;
    env.Path = fullPath;
  } else {
    env.PATH = fullPath;
  }
  return env;
}

export function sdkFileExists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function readInstalledImages(sdkRoot: string): string[] {
  const imagesRoot = path.join(sdkRoot, "system-images");
  const images: string[] = [];
  if (!fs.existsSync(imagesRoot)) return images;
  for (const api of fs.readdirSync(imagesRoot)) {
    const apiDir = path.join(imagesRoot, api);
    if (!fs.statSync(apiDir).isDirectory()) continue;
    for (const tag of fs.readdirSync(apiDir)) {
      const tagDir = path.join(apiDir, tag);
      if (!fs.statSync(tagDir).isDirectory()) continue;
      for (const abi of fs.readdirSync(tagDir)) {
        if (fs.existsSync(path.join(tagDir, abi, "system.img"))) {
          images.push(`system-images;${api};${tag};${abi}`);
        }
      }
    }
  }
  return images.sort();
}

export async function listAvds(paths: SdkPaths): Promise<string[]> {
  if (!sdkFileExists(paths.emulator)) return [];
  const result = await run(paths.emulator, ["-list-avds"], { timeoutMs: 20_000 });
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("INFO") && !line.startsWith("WARNING"));
}

export async function emulatorAccelCheck(paths: SdkPaths): Promise<{ ok: boolean; detail: string }> {
  if (!sdkFileExists(paths.emulator)) return { ok: false, detail: "emulator não instalado" };
  const result = await run(paths.emulator, ["-accel-check"], { timeoutMs: 30_000 });
  const detail = `${result.stdout}\n${result.stderr}`.trim();
  const ok = /is installed and usable/i.test(detail) && result.code === 0;
  return { ok, detail: detail || `exit ${result.code}` };
}

export async function probeSdk(config: Config): Promise<SdkProbe> {
  const paths = sdkPaths(config.sdkRoot);
  const env = androidEnv(config);
  const errors: string[] = [];
  const probe: SdkProbe = {
    paths,
    java: { ok: false },
    adb: { ok: false },
    emulator: { ok: false },
    acceleration: { ok: false, detail: "não verificado" },
    installedImages: readInstalledImages(config.sdkRoot),
    avds: [],
    errors,
  };

  if (!config.javaHome || !fs.existsSync(path.join(config.javaHome, "bin", process.platform === "win32" ? "java.exe" : "java"))) {
    probe.java = { ok: false, error: "JAVA_HOME não encontrado; instale um JDK 17+ (o setup faz isso)" };
  } else {
    const version = await run(path.join(config.javaHome, "bin", process.platform === "win32" ? "java.exe" : "java"), ["-version"], {
      timeoutMs: 15_000,
      env,
    });
    const text = `${version.stdout}${version.stderr}`.trim();
    probe.java = { ok: version.code === 0, version: text.split(/\r?\n/)[0], error: version.code === 0 ? undefined : text };
    if (version.code !== 0) errors.push("java não executou");
  }

  if (sdkFileExists(paths.adb)) {
    const version = await run(paths.adb, ["version"], { timeoutMs: 15_000, env });
    probe.adb = {
      ok: version.code === 0,
      version: version.stdout.split(/\r?\n/).find((line) => line.includes("Version")) ?? version.stdout.split(/\r?\n/)[0],
      error: version.code === 0 ? undefined : version.stderr,
    };
  } else {
    probe.adb = { ok: false, error: `adb não encontrado em ${paths.adb}` };
  }

  if (sdkFileExists(paths.emulator)) {
    const version = await run(paths.emulator, ["-version"], { timeoutMs: 20_000, env });
    probe.emulator = {
      ok: version.code === 0,
      version: version.stdout.split(/\r?\n/).find((line) => line.includes("Android emulator version")) ?? undefined,
      error: version.code === 0 ? undefined : version.stderr,
    };
    probe.acceleration = await emulatorAccelCheck(paths);
  } else {
    probe.emulator = { ok: false, error: `emulator não encontrado em ${paths.emulator}` };
  }

  probe.avds = await listAvds(paths);
  if (!probe.java.ok) errors.push("JDK ausente");
  if (!probe.adb.ok) errors.push("platform-tools/adb ausente");
  if (!probe.emulator.ok) errors.push("emulator ausente");
  if (!probe.acceleration.ok) errors.push("aceleração WHPX indisponível");
  return probe;
}
