import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  maxBuffer?: number;
}

export interface RunResult {
  command: string;
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Run a command without throwing; the caller decides what a non-zero code means. */
export function run(command: string, args: readonly string[] = [], options: RunOptions = {}): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    // Windows cannot CreateProcess a .bat/.cmd directly (EINVAL); go through cmd.exe.
    const isBatch = process.platform === "win32" && /\.(bat|cmd)$/i.test(command);
    const quote = (value: string): string => (/[\s"&|<>^()%!]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
    const spawnCommand = isBatch ? (process.env.ComSpec ?? "cmd.exe") : command;
    const spawnArgs = isBatch
      ? ["/d", "/s", "/c", [command, ...args].map(quote).join(" ")]
      : [...args];
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeoutMs)
      : null;

    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= maxBuffer) chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= maxBuffer) errChunks.push(chunk);
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({
        command: [command, ...args].join(" "),
        code: 127,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: `${Buffer.concat(errChunks).toString("utf8")}${error.message}`,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        command: [command, ...args].join(" "),
        code: code ?? 1,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        timedOut,
        durationMs: Date.now() - started,
      });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export async function runOrThrow(command: string, args: readonly string[] = [], options: RunOptions = {}): Promise<RunResult> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 2000);
    throw new Error(`command failed (${result.code}): ${result.command}${detail ? `\n${detail}` : ""}`);
  }
  return result;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve an executable from PATH, honouring PATHEXT on Windows. */
export function which(command: string): string | undefined {
  if (path.isAbsolute(command) && fs.existsSync(command)) return command;
  const pathValue = process.env.PATH ?? "";
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    if (process.platform === "win32" && !path.extname(command)) {
      for (const ext of extensions) {
        const withExt = `${candidate}${ext.toLowerCase()}`;
        const withExtUpper = `${candidate}${ext}`;
        if (fs.existsSync(withExt)) return withExt;
        if (fs.existsSync(withExtUpper)) return withExtUpper;
      }
    }
  }
  return undefined;
}

export function timestampSlug(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes(),
  )}${pad(date.getSeconds())}`;
}

export function slugify(value: string, max = 48): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "run";
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on", "sim"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off", "nao", "não"].includes(normalized)) return false;
  return fallback;
}

export function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function isTty(): boolean {
  return Boolean(process.stdout.isTTY);
}

/** Stable, dependency-free hash for loop detection (djb2 + length). */
export function shortHash(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return `${hash.toString(16)}-${value.length.toString(16)}`;
}

export function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}
