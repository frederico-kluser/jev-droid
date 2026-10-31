import { isTty } from "./util.js";

const COLORS = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
} as const;

type Color = keyof typeof COLORS;

export interface LoggerOptions {
  quiet?: boolean;
  debug?: boolean;
  color?: boolean;
  stream?: NodeJS.WriteStream;
  errorStream?: NodeJS.WriteStream;
}

export class Logger {
  readonly quiet: boolean;
  readonly debugEnabled: boolean;
  private readonly color: boolean;
  private readonly stream: NodeJS.WriteStream;
  private readonly errorStream: NodeJS.WriteStream;

  constructor(options: LoggerOptions = {}) {
    this.quiet = options.quiet ?? false;
    this.debugEnabled = options.debug ?? false;
    this.color = options.color ?? (isTty() && !process.env.NO_COLOR);
    this.stream = options.stream ?? process.stdout;
    this.errorStream = options.errorStream ?? process.stderr;
  }

  paint(value: string, color: Color): string {
    if (!this.color) return value;
    return `${COLORS[color]}${value}${COLORS.reset}`;
  }

  info(message = ""): void {
    if (!this.quiet) this.stream.write(`${message}\n`);
  }

  detail(message: string): void {
    if (!this.quiet) this.stream.write(`${this.paint("·", "gray")} ${message}\n`);
  }

  success(message: string): void {
    if (!this.quiet) this.stream.write(`${this.paint("✓", "green")} ${message}\n`);
  }

  warn(message: string): void {
    this.errorStream.write(`${this.paint("!", "yellow")} ${message}\n`);
  }

  error(message: string): void {
    this.errorStream.write(`${this.paint("✗", "red")} ${message}\n`);
  }

  step(step: number, total: number, message: string): void {
    if (this.quiet) return;
    const counter = this.paint(`[${step}/${total}]`, "cyan");
    this.stream.write(`${counter} ${message}\n`);
  }

  debug(message: string): void {
    if (!this.debugEnabled || this.quiet) return;
    this.stream.write(`${this.paint("debug", "gray")} ${message}\n`);
  }

  heading(message: string): void {
    if (this.quiet) return;
    this.stream.write(`\n${this.paint(message, "bold")}\n`);
  }

  raw(message: string): void {
    this.stream.write(message.endsWith("\n") ? message : `${message}\n`);
  }
}
