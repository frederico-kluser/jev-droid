import { sleep } from "./util.js";

export const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 524, 529]);

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ResponseFormat {
  type: "json_object" | "text";
}

export interface ProviderPreferences {
  only?: string[];
  order?: string[];
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: "allow" | "deny";
  sort?: { by?: "price" | "throughput" | "latency"; partition?: "none" | "model" };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: ResponseFormat;
  provider?: ProviderPreferences;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface ChatResult {
  content: string;
  model: string;
  id?: string;
  finishReason?: string;
  usage: Usage;
  latencyMs: number;
  attempts: number;
  generationId?: string;
}

export interface OpenRouterClientOptions {
  apiKey: string;
  baseUrl?: string;
  appName?: string;
  appUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class OpenRouterError extends Error {
  readonly status: number;
  readonly code?: string | number;
  readonly type?: string;
  readonly body?: string;
  readonly retriable: boolean;
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string | number;
      type?: string;
      body?: string;
      retriable?: boolean;
      retryAfterMs?: number | null;
    } = {},
  ) {
    super(message);
    this.name = "OpenRouterError";
    this.status = options.status ?? 0;
    this.code = options.code;
    this.type = options.type;
    this.body = options.body;
    this.retriable = options.retriable ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function isRetriableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

function backoffMs(attempt: number): number {
  const base = Math.min(15_000, 750 * 2 ** attempt);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text ?? "");
        return "";
      })
      .join("");
  }
  return "";
}

export class OpenRouterClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly appName: string;
  readonly appUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenRouterClientOptions) {
    if (!options.apiKey) throw new OpenRouterError("OPENROUTER_API_KEY is missing");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    this.appName = options.appName ?? "jev-droid";
    this.appUrl = options.appUrl ?? "https://github.com/frederico-kluser/jev-droid";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": this.appUrl,
      "X-OpenRouter-Title": this.appName,
    };
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    options: { retries?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ response: Response; text: string; attempts: number }> {
    const retries = Math.max(0, options.retries ?? 3);
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    let lastError: OpenRouterError | null = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
        const response = await this.fetchImpl(url, { ...init, signal });
        const text = await response.text();
        if (response.ok) return { response, text, attempts: attempt + 1 };

        let parsed: {
          error?: { code?: string | number; message?: string; type?: string; metadata?: unknown };
        } = {};
        try {
          parsed = JSON.parse(text) as typeof parsed;
        } catch {
          // Keep raw text for the error message.
        }
        const error = parsed.error;
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        lastError = new OpenRouterError(error?.message ?? `OpenRouter HTTP ${response.status}`, {
          status: response.status,
          code: error?.code,
          type: error?.type,
          body: text.slice(0, 4000),
          retriable: isRetriableStatus(response.status),
          retryAfterMs,
        });
        if (!isRetriableStatus(response.status) || attempt === retries) throw lastError;
        await sleep(retryAfterMs ?? backoffMs(attempt));
      } catch (error) {
        if (error instanceof OpenRouterError) {
          if (!error.retriable || attempt === retries) throw error;
          lastError = error;
          await sleep(error.retryAfterMs ?? backoffMs(attempt));
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        lastError = new OpenRouterError(`network error calling OpenRouter: ${message}`, {
          retriable: true,
          body: message,
        });
        if (attempt === retries) throw lastError;
        await sleep(backoffMs(attempt));
      }
    }
    throw lastError ?? new OpenRouterError("OpenRouter request failed");
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream: false,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.responseFormat) body.response_format = request.responseFormat;
    if (request.provider) body.provider = request.provider;

    const { response, text, attempts } = await this.fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      },
      { retries: request.retries, timeoutMs: request.timeoutMs, signal: request.signal },
    );

    let json: {
      id?: string;
      model?: string;
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: string; error?: unknown }>;
      usage?: Usage;
      error?: { message?: string };
    };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      throw new OpenRouterError("OpenRouter returned a non-JSON response", {
        status: response.status,
        body: text.slice(0, 2000),
      });
    }
    if (json.error) {
      throw new OpenRouterError(json.error.message ?? "OpenRouter returned an error in the body", {
        status: response.status,
        body: text.slice(0, 2000),
      });
    }
    const choice = json.choices?.[0];
    if (!choice) {
      throw new OpenRouterError("OpenRouter response has no choices", {
        status: response.status,
        body: text.slice(0, 2000),
      });
    }
    return {
      content: contentToText(choice.message?.content),
      model: json.model ?? request.model,
      id: json.id,
      finishReason: choice.finish_reason,
      usage: json.usage ?? {},
      latencyMs: Date.now() - started,
      attempts,
      generationId: response.headers.get("x-generation-id") ?? undefined,
    };
  }

  async listModels(query?: string): Promise<ModelInfo[]> {
    const url = new URL(`${this.baseUrl}/models`);
    if (query) url.searchParams.set("q", query);
    const { text } = await this.fetchWithRetry(url.toString(), { method: "GET", headers: this.headers() }, { retries: 2 });
    const json = JSON.parse(text) as { data?: ModelInfo[] };
    return json.data ?? [];
  }

  async modelInfo(modelId: string): Promise<ModelInfo | undefined> {
    const { text } = await this.fetchWithRetry(
      `${this.baseUrl}/model/${modelId}`,
      { method: "GET", headers: this.headers() },
      { retries: 2 },
    );
    const json = JSON.parse(text) as { data?: ModelInfo };
    return json.data;
  }

  async keyInfo(): Promise<KeyInfo> {
    const { text } = await this.fetchWithRetry(
      `${this.baseUrl}/key`,
      { method: "GET", headers: this.headers() },
      { retries: 1 },
    );
    const json = JSON.parse(text) as { data?: KeyInfo };
    return json.data ?? {};
  }
}

export interface ModelInfo {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: string[];
}

export interface KeyInfo {
  label?: string;
  limit?: number | null;
  limit_remaining?: number | null;
  usage?: number;
  usage_monthly?: number;
  is_free_tier?: boolean;
}

/**
 * Extract the first balanced JSON object from a model response.
 * Handles ```json fences, leading prose and braces inside strings.
 */
export function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1]?.trim() ?? text.trim();
  const start = source.indexOf("{");
  if (start === -1) throw new Error("response contains no JSON object");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("response contains an unterminated JSON object");
}
