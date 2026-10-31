import fs from "node:fs";
import path from "node:path";
import { ensureDir, slugify, timestampSlug } from "../util.js";

export interface RunMeta {
  task: string;
  model: string;
  jevModel: string;
  serial?: string;
  avd: string;
  headless: boolean;
  startedAt: string;
  cwd: string;
  version: string;
  node: string;
  platform: string;
}

export interface StepArtifact {
  step: number;
  at: string;
  screen?: { packageName?: string; activity?: string; width: number; height: number; nodes: number; signature: string };
  action?: unknown;
  result?: { ok: boolean; detail: string };
  guard?: unknown;
  triage?: unknown;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  llm?: { model: string; latencyMs: number; finishReason?: string };
  error?: string;
}

export interface RunSummary {
  ok: boolean;
  summary: string;
  steps: number;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  model: string;
  artifactsDir: string;
  finishedAt: string;
}

export class RunArtifacts {
  readonly dir: string;
  readonly stepsDir: string;
  private readonly eventsFile: string;

  constructor(baseDir: string, meta: RunMeta) {
    this.dir = path.join(baseDir, "runs", `${timestampSlug()}-${slugify(meta.task)}`);
    this.stepsDir = path.join(this.dir, "steps");
    this.eventsFile = path.join(this.dir, "events.jsonl");
    ensureDir(this.stepsDir);
    fs.writeFileSync(path.join(this.dir, "run.json"), JSON.stringify(meta, null, 2), "utf8");
    this.appendEvent({ type: "run.start", at: meta.startedAt, meta });
  }

  appendEvent(event: Record<string, unknown>): void {
    fs.appendFileSync(this.eventsFile, `${JSON.stringify(event)}\n`, "utf8");
  }

  writeStep(
    step: number,
    data: { xml?: string; png?: Buffer; record: StepArtifact },
  ): { xmlPath?: string; pngPath?: string; jsonPath: string } {
    const padded = String(step).padStart(3, "0");
    let xmlPath: string | undefined;
    let pngPath: string | undefined;
    if (data.xml) {
      xmlPath = path.join(this.stepsDir, `${padded}.xml`);
      fs.writeFileSync(xmlPath, data.xml, "utf8");
    }
    if (data.png) {
      pngPath = path.join(this.stepsDir, `${padded}.png`);
      fs.writeFileSync(pngPath, data.png);
    }
    const jsonPath = path.join(this.stepsDir, `${padded}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(data.record, null, 2), "utf8");
    this.appendEvent({ type: "step", ...data.record });
    return { xmlPath, pngPath, jsonPath };
  }

  finalize(summary: RunSummary): void {
    fs.writeFileSync(path.join(this.dir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
    this.appendEvent({ type: "run.end", ...summary });
  }
}
