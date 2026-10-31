import { spawn } from "node:child_process";
import fs from "node:fs";
import { sdkPaths, type Config } from "../config.js";
import { androidEnv } from "./sdk.js";
import { run, sleep, type RunResult } from "../util.js";

export interface Device {
  serial: string;
  state: string;
  model?: string;
  product?: string;
  transportId?: string;
}

export class AdbError extends Error {
  readonly code: number;
  readonly stderr: string;

  constructor(message: string, code = 1, stderr = "") {
    super(message);
    this.name = "AdbError";
    this.code = code;
    this.stderr = stderr;
  }
}

export interface AdbOptions {
  adbPath: string;
  serial?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  logger?: (message: string) => void;
}

export class Adb {
  readonly adbPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  serial?: string;
  private readonly logger?: (message: string) => void;

  constructor(options: AdbOptions) {
    this.adbPath = options.adbPath;
    this.serial = options.serial;
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.logger = options.logger;
  }

  private prefix(): string[] {
    return this.serial ? ["-s", this.serial] : [];
  }

  async exec(args: readonly string[], options: { timeoutMs?: number } = {}): Promise<RunResult> {
    return run(this.adbPath, [...this.prefix(), ...args], {
      env: this.env,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
    });
  }

  async execOrThrow(args: readonly string[], options: { timeoutMs?: number } = {}): Promise<RunResult> {
    const result = await this.exec(args, options);
    if (result.code !== 0) {
      throw new AdbError((result.stderr || result.stdout).trim() || `adb ${args.join(" ")} failed`, result.code, result.stderr);
    }
    return result;
  }

  async execBuffer(args: readonly string[], timeoutMs = this.timeoutMs): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.adbPath, [...this.prefix(), ...args], {
        env: this.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill();
        reject(new AdbError(`adb ${args.join(" ")} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new AdbError(error.message));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new AdbError(Buffer.concat(errChunks).toString("utf8").trim() || `adb exited ${code}`, code ?? 1));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
  }

  async shell(...args: string[]): Promise<string> {
    const result = await this.execOrThrow(["shell", ...args]);
    return result.stdout.replace(/\r\n/g, "\n").trim();
  }

  async getState(): Promise<string> {
    const result = await this.exec(["get-state"], { timeoutMs: 10_000 });
    return result.stdout.trim();
  }

  async waitForDevice(timeoutMs = 120_000, onTick?: (elapsedMs: number) => void): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const result = await this.exec(["get-state"], { timeoutMs: 10_000 });
      const state = result.stdout.trim();
      if (state === "device") return;
      if (state === "unauthorized") {
        throw new AdbError("dispositivo não autorizado — aceite o diálogo USB debugging no emulador");
      }
      onTick?.(Date.now() - started);
      await sleep(1500);
    }
    throw new AdbError(`dispositivo ${this.serial ?? "(default)"} não ficou pronto em ${Math.round(timeoutMs / 1000)}s`);
  }

  async waitForBoot(timeoutMs = 300_000, onTick?: (elapsedMs: number, detail: string) => void): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const boot = await this.shell("getprop", "sys.boot_completed").catch(() => "");
      const anim = await this.shell("getprop", "init.svc.bootanim").catch(() => "");
      if (boot === "1" && (anim === "stopped" || anim === "")) return;
      onTick?.(Date.now() - started, `boot_completed=${boot || "?"} bootanim=${anim || "?"}`);
      await sleep(2000);
    }
    throw new AdbError(`emulador não concluiu o boot em ${Math.round(timeoutMs / 1000)}s`);
  }

  async getProp(name: string): Promise<string> {
    return this.shell("getprop", name);
  }

  async screenSize(): Promise<{ width: number; height: number }> {
    const output = await this.shell("wm", "size");
    const matches = [...output.matchAll(/(\d+)x(\d+)/g)];
    const last = matches.at(-1);
    if (!last) throw new AdbError(`não foi possível ler o tamanho do ecrã: ${output}`);
    return { width: Number(last[1]), height: Number(last[2]) };
  }

  async currentFocus(): Promise<{ packageName?: string; activity?: string; raw?: string }> {
    // `dumpsys window windows` omits mCurrentFocus on Android 16; plain `dumpsys window` has it.
    const output = await this.shell("dumpsys", "window");
    const focus = output.match(/mCurrentFocus=Window\{[^}]*?\s+([\w.]+)\/([\w.$]+)\}/);
    if (focus) return { packageName: focus[1], activity: focus[2], raw: focus[0] };
    const app = output.match(/mFocusedApp=ActivityRecord\{[^}]*?\s+([\w.]+)\/([\w.$]+)/);
    if (app) return { packageName: app[1], activity: app[2], raw: app[0] };
    return {};
  }

  async dumpUiXml(): Promise<string> {
    const dump = await this.exec(["shell", "uiautomator", "dump", "/sdcard/window_dump.xml"], { timeoutMs: 30_000 });
    if (dump.code === 0) {
      const xml = (await this.execBuffer(["exec-out", "cat", "/sdcard/window_dump.xml"], 30_000)).toString("utf8");
      const extracted = extractXml(xml);
      if (extracted) return extracted;
    }
    const direct = await this.execBuffer(["exec-out", "uiautomator", "dump", "/dev/tty"], 30_000).catch(() => Buffer.alloc(0));
    const extracted = extractXml(direct.toString("utf8"));
    if (extracted) return extracted;
    throw new AdbError(`uiautomator dump não devolveu XML (${(dump.stderr || dump.stdout).trim().slice(0, 300)})`);
  }

  async screenshot(): Promise<Buffer> {
    const buffer = await this.execBuffer(["exec-out", "screencap", "-p"], 30_000);
    if (buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
      throw new AdbError("screencap não devolveu um PNG válido");
    }
    return buffer;
  }

  async tap(x: number, y: number): Promise<void> {
    await this.execOrThrow(["shell", "input", "tap", String(Math.round(x)), String(Math.round(y))]);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<void> {
    await this.execOrThrow([
      "shell",
      "input",
      "swipe",
      String(Math.round(x1)),
      String(Math.round(y1)),
      String(Math.round(x2)),
      String(Math.round(y2)),
      String(Math.round(durationMs)),
    ]);
  }

  async inputText(encodedText: string): Promise<void> {
    await this.execOrThrow(["shell", "input", "text", encodedText]);
  }

  async keyevent(keyCode: string | number): Promise<void> {
    await this.execOrThrow(["shell", "input", "keyevent", String(keyCode)]);
  }

  async launchPackage(packageName: string): Promise<string> {
    const monkey = await this.exec([
      "shell",
      "monkey",
      "-p",
      packageName,
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ]);
    if (monkey.code === 0 && !/No activities found/i.test(monkey.stdout)) return monkey.stdout.trim();
    const am = await this.exec([
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.MAIN",
      "-c",
      "android.intent.category.LAUNCHER",
      "-p",
      packageName,
    ]);
    if (am.code !== 0 || /Error/i.test(am.stdout)) {
      throw new AdbError(`não foi possível abrir ${packageName}: ${(am.stderr || am.stdout).trim()}`);
    }
    return am.stdout.trim();
  }

  async isPackageInstalled(packageName: string): Promise<boolean> {
    const output = await this.shell("pm", "list", "packages", packageName);
    return output.split(/\r?\n/).some((line) => line.trim() === `package:${packageName}`);
  }

  async installApk(filePath: string): Promise<string> {
    if (!fs.existsSync(filePath)) throw new AdbError(`APK não encontrado: ${filePath}`);
    const result = await this.execOrThrow(["install", "-r", "-g", filePath], { timeoutMs: 180_000 });
    return `${result.stdout}\n${result.stderr}`.trim();
  }

  async killEmulator(): Promise<void> {
    await this.exec(["emu", "kill"], { timeoutMs: 10_000 });
  }

  async version(): Promise<string> {
    const result = await this.exec(["version"], { timeoutMs: 10_000 });
    return `${result.stdout}${result.stderr}`.trim();
  }
}

export function extractXml(output: string): string | undefined {
  const start = output.indexOf("<hierarchy");
  if (start === -1) return undefined;
  const end = output.indexOf("</hierarchy>", start);
  if (end === -1) return undefined;
  return output.slice(start, end + "</hierarchy>".length);
}

export async function listDevices(adbPath: string, env?: NodeJS.ProcessEnv): Promise<Device[]> {
  const result = await run(adbPath, ["devices", "-l"], { timeoutMs: 15_000, env });
  if (result.code !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("*"))
    .map((line) => {
      const parts = line.split(/\s+/);
      const serial = parts[0] ?? "";
      const state = parts[1] ?? "unknown";
      const model = line.match(/\bmodel:(\S+)/)?.[1];
      const product = line.match(/\bproduct:(\S+)/)?.[1];
      const transportId = line.match(/\btransport_id:(\S+)/)?.[1];
      return { serial, state, model, product, transportId };
    })
    .filter((device) => device.serial);
}

export async function resolveSerial(
  adbPath: string,
  preferred?: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const devices = await listDevices(adbPath, env);
  if (preferred) {
    const match = devices.find((device) => device.serial === preferred);
    if (match) return match.serial;
  }
  return devices.find((device) => device.state === "device")?.serial ?? devices[0]?.serial;
}

export function createAdb(config: Config): Adb {
  const env = androidEnv(config);
  const paths = sdkPaths(config.sdkRoot);
  return new Adb({ adbPath: paths.adb, serial: config.serial, env });
}
