import { sleep } from "./util.js";

export const DEFAULT_JEV_MODEL = "typesafe/jev-1.13";
export const DEFAULT_JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface DecisionsRequest {
  model: string;
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, Question>;
  provider?: Record<string, unknown>;
  session_id?: string;
  user?: string;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend?: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionsResponse {
  answers: Record<string, Answer>;
  model?: string;
  id?: string;
  provider?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
}

export type Band = "auto" | "hitl" | "abstain";

export interface Decision {
  questionId: string;
  type: Question["type"];
  value: number | string;
  band: Band;
  confidence?: number;
  pYes?: number;
  certainty?: number;
  ambiguous?: boolean;
  probabilities?: Record<string, number>;
}

export interface Thresholds {
  auto: number;
  hitl: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = Object.freeze({ auto: 0.9, hitl: 0.5 });

export class JevError extends Error {
  readonly status: number;
  readonly retriable: boolean;
  readonly body?: string;

  constructor(message: string, options: { status?: number; retriable?: boolean; body?: string } = {}) {
    super(message);
    this.name = "JevError";
    this.status = options.status ?? 0;
    this.retriable = options.retriable ?? false;
    this.body = options.body;
  }
}

export interface JevClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  appName?: string;
  appUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  thresholds?: Thresholds;
}

export interface DecideOptions {
  retries?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DecideResult {
  response: DecisionsResponse;
  decisions: Record<string, Decision>;
  latencyMs: number;
  attempts: number;
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

export function validateRequest(request: DecisionsRequest): string[] {
  const errors: string[] = [];
  if (!request.model?.trim()) errors.push("model is required");
  if (request.state === undefined || request.state === null) errors.push("state is required");
  if (request.state !== undefined && typeof request.state === "string" && request.state.trim() === "") {
    errors.push("state must not be empty");
  }
  const entries = Object.entries(request.questions ?? {});
  if (entries.length === 0) errors.push("questions must contain at least one question");
  if (entries.length > 32) errors.push("questions must contain at most 32 questions per request");
  for (const [id, question] of entries) {
    if (!question || typeof question !== "object") {
      errors.push(`${id}: question must be an object`);
      continue;
    }
    if (!id.trim()) errors.push("question id must not be empty");
    if (!question.instructions || typeof question.instructions !== "string" || !question.instructions.trim()) {
      errors.push(`${id}: instructions is required`);
    }
    if (question.type === "noul") {
      if (question.criteria) {
        if (!question.criteria.true || !question.criteria.false) {
          errors.push(`${id}: noul criteria requires both "true" and "false"`);
        }
      }
    } else if (question.type === "choice") {
      const options = Object.keys(question.criteria ?? {});
      if (options.length < 2) errors.push(`${id}: choice needs at least 2 criteria options`);
      if (options.length > 255) errors.push(`${id}: choice supports at most 255 options`);
    } else if (question.type === "score") {
      const levels = question.criteria ?? [];
      if (levels.length < 2 || levels.length > 10) errors.push(`${id}: score needs 2..10 criteria levels`);
      if (levels.some((level) => typeof level !== "string" || !level.trim())) {
        errors.push(`${id}: every score level must be a non-empty string`);
      }
    } else {
      errors.push(`${id}: unknown question type`);
    }
  }
  const size = JSON.stringify(request).length;
  if (size > 240_000) errors.push(`request is too large (~${Math.round(size / 4)} tokens; JEV limit is 64k tokens)`);
  return errors;
}

export function bandFor(answer: Answer, thresholds: Thresholds = DEFAULT_THRESHOLDS): {
  band: Band;
  confidence?: number;
  pYes?: number;
  certainty?: number;
  ambiguous?: boolean;
} {
  if (answer.type === "noul") {
    const p = Number(answer.noul);
    if (!Number.isFinite(p)) return { band: "abstain", ambiguous: true };
    const certainty = Math.max(p, 1 - p);
    const band: Band = certainty >= thresholds.auto ? "auto" : certainty >= Math.max(thresholds.hitl, 0.5) ? "hitl" : "abstain";
    return { band, pYes: round4(p), certainty: round4(certainty), ambiguous: Math.abs(p - 0.5) < 0.1 };
  }
  const confidence = Number(answer.confidence);
  if (!Number.isFinite(confidence)) return { band: "abstain" };
  const band: Band = confidence >= thresholds.auto ? "auto" : confidence >= thresholds.hitl ? "hitl" : "abstain";
  return { band, confidence: round4(confidence) };
}

export function validateResponse(
  request: DecisionsRequest,
  response: DecisionsResponse,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): { decisions: Record<string, Decision>; warnings: string[] } {
  const warnings: string[] = [];
  if (!response || typeof response !== "object" || !response.answers || typeof response.answers !== "object") {
    throw new JevError("JEV response has no answers object");
  }
  const decisions: Record<string, Decision> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = response.answers[id];
    if (!answer) throw new JevError(`JEV response is missing answer "${id}"`);
    if (answer.type !== question.type) {
      throw new JevError(`JEV answer "${id}" has type ${answer.type}, expected ${question.type}`);
    }
    const band = bandFor(answer, thresholds);
    if (answer.type === "noul") {
      const p = Number(answer.noul);
      if (!Number.isFinite(p) || p < 0 || p > 1) throw new JevError(`JEV noul "${id}" is outside [0,1]`);
      decisions[id] = { questionId: id, type: "noul", value: round4(p), ...band };
      continue;
    }
    const probabilities = answer.probabilities ?? {};
    const sum = Object.values(probabilities).reduce((total, value) => total + Number(value), 0);
    if (Math.abs(sum - 1) > 0.05) warnings.push(`answer "${id}" probabilities sum to ${round4(sum)}`);
    if (answer.type === "choice") {
      if (question.type !== "choice") throw new JevError(`JEV question "${id}" is not a choice`);
      if (!(answer.choice in question.criteria)) {
        throw new JevError(`JEV choice "${id}" returned unknown option "${answer.choice}"`);
      }
      decisions[id] = {
        questionId: id,
        type: "choice",
        value: answer.choice,
        ...band,
        probabilities,
      };
    } else {
      if (question.type !== "score") throw new JevError(`JEV question "${id}" is not a score`);
      const score = Number(answer.score);
      if (!Number.isFinite(score) || score < 0 || score > question.criteria.length - 1) {
        throw new JevError(`JEV score "${id}" is outside the 0..${question.criteria.length - 1} range`);
      }
      decisions[id] = {
        questionId: id,
        type: "score",
        value: round4(score),
        ...band,
        probabilities,
      };
    }
  }
  return { decisions, warnings };
}

export interface ScreenTriage {
  state: "ready" | "loading" | "permission" | "error" | "unknown";
  confidence: number;
  band: Band;
  latencyMs: number;
  costUsd?: number;
}

export interface GuardResult {
  allowed: boolean;
  needsHuman: boolean;
  band: Band;
  risk: number;
  impact: number;
  reason: string;
  latencyMs: number;
  costUsd?: number;
}

export class JevClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly appName: string;
  readonly appUrl: string;
  readonly thresholds: Thresholds;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: JevClientOptions) {
    if (!options.apiKey) throw new JevError("OPENROUTER_API_KEY is missing");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_JEV_ENDPOINT).replace(/\/$/, "");
    this.model = options.model ?? DEFAULT_JEV_MODEL;
    this.appName = options.appName ?? "jev-droid";
    this.appUrl = options.appUrl ?? "https://github.com/frederico-kluser/jev-droid";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": this.appUrl,
      "X-OpenRouter-Title": this.appName,
    };
  }

  async decide(request: DecisionsRequest, options: DecideOptions = {}): Promise<DecideResult> {
    const errors = validateRequest(request);
    if (errors.length > 0) throw new JevError(`invalid JEV request: ${errors.join("; ")}`);
    const retries = Math.max(0, options.retries ?? 2);
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const started = Date.now();
    let lastError: JevError | null = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
        const response = await this.fetchImpl(this.baseUrl, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(request),
          signal,
        });
        const text = await response.text();
        if (!response.ok) {
          const retriable = [408, 429, 500, 502, 503, 504, 524, 529].includes(response.status);
          const retryAfter = Number(response.headers.get("retry-after"));
          lastError = new JevError(`JEV HTTP ${response.status}: ${text.slice(0, 500)}`, {
            status: response.status,
            retriable,
            body: text.slice(0, 2000),
          });
          if (!retriable || attempt === retries) throw lastError;
          await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 750 * 2 ** attempt);
          continue;
        }
        let parsed: DecisionsResponse;
        try {
          parsed = JSON.parse(text) as DecisionsResponse;
        } catch {
          throw new JevError("JEV returned a non-JSON response", { body: text.slice(0, 1000) });
        }
        const { decisions } = validateResponse(request, parsed, this.thresholds);
        return { response: parsed, decisions, latencyMs: Date.now() - started, attempts: attempt + 1 };
      } catch (error) {
        if (error instanceof JevError) {
          if (!error.retriable || attempt === retries) throw error;
          lastError = error;
          await sleep(750 * 2 ** attempt);
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        lastError = new JevError(`network error calling JEV: ${message}`, { retriable: true });
        if (attempt === retries) throw lastError;
        await sleep(750 * 2 ** attempt);
      }
    }
    throw lastError ?? new JevError("JEV request failed");
  }

  async screenTriage(input: {
    task: string;
    packageName?: string;
    summary: string;
    signal?: AbortSignal;
  }): Promise<ScreenTriage> {
    const result = await this.decide(
      {
        model: this.model,
        state: {
          task: input.task,
          app: input.packageName ?? "unknown",
          screen: input.summary.slice(0, 12_000),
        },
        questions: {
          screen_state: {
            type: "choice",
            instructions:
              "What is the CURRENT state of this Android screen? Choose loading while a spinner, skeleton or progress indicator is still the main content; permission when a system permission/rationale dialog blocks the task; error when a failure message or retry button dominates; ready when interactive content is available; unknown when the evidence is insufficient.",
            criteria: {
              ready: "Interactive app content is visible and the user can act.",
              loading: "The screen is still loading: spinner, skeleton, progress bar, blank placeholder.",
              permission: "A permission, consent, sign-in or other blocking system dialog is in front.",
              error: "A failure, offline warning or retry screen dominates the content.",
              unknown: "The text does not make the screen state clear.",
            },
          },
        },
        session_id: "jev-droid-triage",
      },
      { signal: input.signal, timeoutMs: 20_000 },
    );
    const decision = result.decisions.screen_state;
    const state = (decision?.value as ScreenTriage["state"]) ?? "unknown";
    return {
      state,
      confidence: decision?.confidence ?? 0,
      band: decision?.band ?? "abstain",
      latencyMs: result.latencyMs,
      costUsd: result.response.usage?.cost,
    };
  }

  async guardAction(input: {
    task: string;
    action: string;
    target: string;
    packageName?: string;
    signal?: AbortSignal;
  }): Promise<GuardResult> {
    const result = await this.decide(
      {
        model: this.model,
        state: {
          task: input.task,
          app: input.packageName ?? "unknown",
          action: input.action,
          target: input.target.slice(0, 1000),
        },
        questions: {
          risky: {
            type: "noul",
            instructions:
              "Could executing this action cause data loss, a charge, a logout, an account or permission change, a message sent to another person, or another irreversible side effect? Navigation, opening apps and filling non-sensitive fields are not risky.",
            criteria: {
              true: "The action may delete data, spend money, change permissions/accounts, send a message or otherwise be hard to undo.",
              false: "The action is ordinary navigation, inspection or reversible input.",
            },
          },
          impact: {
            type: "score",
            instructions: "If this action runs, how severe is the worst realistic consequence?",
            criteria: [
              "Fully reversible: navigation, opening a screen, scrolling.",
              "Reversible with effort: typing, toggling a local setting, dismissing a dialog.",
              "Potentially destructive: deleting data, sending a message, changing permissions.",
              "Financial, legal or account-level: paying, subscribing, deleting an account, factory reset.",
            ],
          },
          intent: {
            type: "noul",
            instructions:
              "Does this action directly advance the user's stated task, rather than an unrelated or accidental target?",
            criteria: {
              true: "The action is a plausible step toward the task.",
              false: "The action looks unrelated, accidental or opposed to the task.",
            },
          },
        },
        session_id: "jev-droid-guard",
      },
      { signal: input.signal, timeoutMs: 20_000 },
    );
    const risk = Number(result.decisions.risky?.value ?? 0.5);
    const impact = Number(result.decisions.impact?.value ?? 0);
    const intent = Number(result.decisions.intent?.value ?? 0.5);
    const confidence = result.decisions.risky?.certainty ?? 0;
    const needsHuman = risk >= 0.3 || impact >= 2.5 || intent < 0.5 || confidence < 0.5;
    const band: Band = needsHuman ? (confidence >= 0.5 ? "hitl" : "abstain") : "auto";
    const reason = `risk=${risk.toFixed(2)} impact=${impact.toFixed(2)} intent=${intent.toFixed(2)} confidence=${confidence.toFixed(2)}`;
    return {
      allowed: !needsHuman,
      needsHuman,
      band,
      risk,
      impact,
      reason,
      latencyMs: result.latencyMs,
      costUsd: result.response.usage?.cost,
    };
  }
}
