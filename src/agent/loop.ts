import path from "node:path";
import { sdkPaths, type Config } from "../config.js";
import { Adb, resolveSerial } from "../android/adb.js";
import { ensureEmulator, prepareDevice } from "../android/emulator.js";
import { parseUiHierarchy, shouldTriage, triageSummary, type UiSnapshot } from "../android/ui.js";
import { executeAction, parseAction, type Action } from "../android/actions.js";
import { OpenRouterClient, extractJsonObject, type ChatMessage, type ChatResult, type Usage } from "../openrouter.js";
import { JevClient } from "../jev.js";
import { SYSTEM_PROMPT, buildRepairPrompt, buildUserPrompt, summarizeAction, type HistoryEntry } from "./prompt.js";
import { RunArtifacts, type RunMeta, type RunSummary, type StepArtifact } from "./artifacts.js";
import { guardAction } from "./guard.js";
import type { Logger } from "../logger.js";
import { formatDuration, sleep } from "../util.js";
import { VERSION } from "../version.js";
import { androidEnv } from "../android/sdk.js";

export interface RunOptions {
  config: Config;
  task: string;
  logger: Logger;
  serial?: string;
  headless?: boolean;
  maxSteps?: number;
  yes?: boolean;
  dryRun?: boolean;
  captureScreenshots?: boolean;
  restart?: boolean;
  noStart?: boolean;
  model?: string;
  confirm?: (question: string) => Promise<boolean>;
}

export class AgentRunError extends Error {
  readonly summary?: RunSummary;
  constructor(message: string, summary?: RunSummary) {
    super(message);
    this.name = "AgentRunError";
    this.summary = summary;
  }
}

interface Decision {
  action: Action;
  chat: ChatResult;
  usage: Usage;
}

function addUsage(total: { cost: number; prompt: number; completion: number }, usage: Usage | undefined): void {
  if (!usage) return;
  total.prompt += usage.prompt_tokens ?? 0;
  total.completion += usage.completion_tokens ?? 0;
  total.cost += usage.cost ?? 0;
}

function toStepUsage(usage: Usage): StepArtifact["usage"] {
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    cost: usage.cost,
  };
}

async function captureScreen(adb: Adb, logger: Logger): Promise<UiSnapshot> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const focus: { activity?: string } = await adb.currentFocus().catch(() => ({}));
      const xml = await adb.dumpUiXml();
      return parseUiHierarchy(xml, { activity: focus.activity });
    } catch (error) {
      lastError = error;
      logger.debug(`UI dump falhou (tentativa ${attempt + 1}/3): ${error instanceof Error ? error.message : String(error)}`);
      await sleep(900);
    }
  }
  throw new AgentRunError(
    `não foi possível capturar a UI: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function providerFor(config: Config): Record<string, unknown> {
  const provider: Record<string, unknown> = {
    sort: { by: "price", partition: "none" },
    allow_fallbacks: true,
  };
  if (config.provider) provider.order = [config.provider];
  return provider;
}

async function decide(input: {
  router: OpenRouterClient;
  config: Config;
  model: string;
  task: string;
  step: number;
  maxSteps: number;
  snapshot: UiSnapshot;
  history: HistoryEntry[];
  hint?: string;
  triage?: string;
  logger: Logger;
  cost: { cost: number; prompt: number; completion: number };
}): Promise<Decision> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: buildUserPrompt({
        task: input.task,
        step: input.step,
        maxSteps: input.maxSteps,
        snapshot: input.snapshot,
        history: input.history,
        hint: input.hint,
        triage: input.triage,
      }),
    },
  ];
  const request = {
    model: input.model,
    messages,
    temperature: input.config.temperature,
    maxTokens: 1000,
    responseFormat: { type: "json_object" as const },
    provider: providerFor(input.config),
    timeoutMs: input.config.requestTimeoutMs,
  };
  let chat = await input.router.chat(request);
  addUsage(input.cost, chat.usage);
  input.logger.detail(
    `LLM ${chat.model} · ${chat.latencyMs}ms · in=${chat.usage.prompt_tokens ?? "?"} out=${chat.usage.completion_tokens ?? "?"}`,
  );

  const parse = (content: string): Action => {
    const action = parseAction(extractJsonObject(content));
    if (
      (action.action === "tap" || (action.action === "type" && action.ref)) &&
      !input.snapshot.nodes.some((node) => node.ref === action.ref)
    ) {
      throw new Error(`element ref ${action.ref} does not exist on the current screen`);
    }
    return action;
  };

  try {
    return { action: parse(chat.content), chat, usage: chat.usage };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    input.logger.warn(`Resposta inválida do modelo (${reason}); a pedir reparação uma vez.`);
    messages.push({ role: "assistant", content: chat.content });
    messages.push({ role: "user", content: buildRepairPrompt(reason) });
    const repair = await input.router.chat({ ...request, messages });
    addUsage(input.cost, repair.usage);
    input.logger.detail(`LLM repair · ${repair.latencyMs}ms`);
    try {
      return {
        action: parse(repair.content),
        chat: repair,
        usage: {
          prompt_tokens: (chat.usage.prompt_tokens ?? 0) + (repair.usage.prompt_tokens ?? 0),
          completion_tokens: (chat.usage.completion_tokens ?? 0) + (repair.usage.completion_tokens ?? 0),
          cost: (chat.usage.cost ?? 0) + (repair.usage.cost ?? 0),
        },
      };
    } catch (repairError) {
      throw new AgentRunError(
        `modelo não devolveu uma ação válida: ${repairError instanceof Error ? repairError.message : String(repairError)}`,
      );
    }
  }
}

export async function runTask(options: RunOptions): Promise<RunSummary> {
  const { config, logger } = options;
  const task = options.task.trim();
  if (task.length < 3) throw new AgentRunError("a tarefa é demasiado curta");
  if (task.length > 4000) throw new AgentRunError("a tarefa excede 4000 caracteres");
  if (!config.openRouterKey) {
    throw new AgentRunError("OPENROUTER_API_KEY ausente — copie .env.example para .env e preencha a chave");
  }

  const model = options.model ?? config.model;
  const maxSteps = Math.max(1, Math.min(100, options.maxSteps ?? config.maxSteps));
  const paths = sdkPaths(config.sdkRoot);
  const env = androidEnv(config);
  const router = new OpenRouterClient({
    apiKey: config.openRouterKey,
    baseUrl: config.openRouterBaseUrl,
    appName: config.appName,
    appUrl: config.appUrl,
    timeoutMs: config.requestTimeoutMs,
  });
  const jev = new JevClient({
    apiKey: config.openRouterKey,
    baseUrl: config.jevBaseUrl,
    model: config.jevModel,
    appName: config.appName,
    appUrl: config.appUrl,
    thresholds: { auto: config.jevAutoThreshold, hitl: config.jevHitlThreshold },
  });

  let adb: Adb;
  let serial: string | undefined;
  if (options.serial ?? config.serial) {
    const preferred = options.serial ?? config.serial;
    serial = await resolveSerial(paths.adb, preferred, env);
    if (!serial) throw new AgentRunError(`dispositivo "${preferred}" não encontrado — inicie o emulador com "jev-droid avd start"`);
    adb = new Adb({ adbPath: paths.adb, serial, env });
    await adb.waitForDevice(60_000);
    await adb.waitForBoot(config.bootTimeoutMs);
    await prepareDevice(adb);
    logger.success(`Dispositivo ${serial} pronto`);
  } else if (options.noStart) {
    serial = await resolveSerial(paths.adb, undefined, env);
    if (!serial) throw new AgentRunError("nenhum dispositivo ligado e --no-start foi usado");
    adb = new Adb({ adbPath: paths.adb, serial, env });
    logger.success(`Dispositivo ${serial} pronto`);
  } else {
    logger.info(`A preparar AVD "${config.avdName}" (${options.headless ?? config.headless ? "headless" : "janela"})…`);
    const ensured = await ensureEmulator({
      config,
      headless: options.headless ?? config.headless,
      restart: options.restart,
    });
    adb = ensured.adb;
    serial = ensured.serial;
    logger.success(
      `Emulador ${serial} pronto${ensured.started ? ` (pid ${ensured.pid})` : " (reutilizado)"} · ${config.avdName}`,
    );
  }

  const meta: RunMeta = {
    task,
    model,
    jevModel: config.jevModel,
    serial,
    avd: config.avdName,
    headless: options.headless ?? config.headless,
    startedAt: new Date().toISOString(),
    cwd: config.cwd,
    version: VERSION,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
  };
  const artifacts = new RunArtifacts(config.artifactsDir, meta);
  logger.detail(`Artefactos: ${artifacts.dir}`);

  const usage = { cost: 0, prompt: 0, completion: 0 };
  const history: HistoryEntry[] = [];
  const started = Date.now();
  let steps = 0;
  let ok = false;
  let summaryText = "sem conclusão";
  let hint: string | undefined;
  let sameScreenCount = 0;
  let loadingWaits = 0;

  try {
    for (let step = 1; step <= maxSteps; step += 1) {
      steps = step;
      const snapshot = await captureScreen(adb, logger);
      logger.step(step, maxSteps, `${snapshot.packageName ?? "?"}/${snapshot.activity ?? "?"} · ${snapshot.nodes.length} elementos`);
      const png = options.captureScreenshots === false ? undefined : await adb.screenshot().catch(() => undefined);

      let triageNote: string | undefined;
      let triageRecord: unknown;
      if (config.jevTriage && shouldTriage(snapshot)) {
        try {
          const triage = await jev.screenTriage({
            task,
            packageName: snapshot.packageName,
            summary: triageSummary(snapshot),
          });
          triageRecord = triage;
          triageNote = `JEV says screen_state=${triage.state} (confidence ${triage.confidence}, ${triage.latencyMs}ms)`;
          logger.detail(`JEV triage: ${triage.state} · conf ${triage.confidence} · ${triage.latencyMs}ms`);
          if (triage.state === "loading" && triage.confidence >= 0.55 && loadingWaits < 3) {
            loadingWaits += 1;
            const record: StepArtifact = {
              step,
              at: new Date().toISOString(),
              screen: {
                packageName: snapshot.packageName,
                activity: snapshot.activity,
                width: snapshot.width,
                height: snapshot.height,
                nodes: snapshot.nodes.length,
                signature: snapshot.signature,
              },
              triage: triageRecord,
            };
            artifacts.writeStep(step, { xml: snapshot.xml, png, record });
            logger.info("Ecrã ainda em carregamento — a aguardar 1.5s");
            await sleep(1500);
            continue;
          }
          if (triage.state === "loading") loadingWaits = 0;
          if (triage.state === "permission") {
            hint = "A permission/consent dialog may be blocking the task. Choose the least-privilege option or fail if it is unclear.";
          } else if (triage.state === "error") {
            hint = "The screen looks like an error/retry state. Recover deliberately instead of repeating the same tap.";
          }
        } catch (error) {
          logger.warn(`JEV triage indisponível: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (history.length >= 3) {
        const last = history.slice(-3);
        if (last.every((entry) => entry.screenSignature === snapshot.signature)) {
          sameScreenCount += 1;
          if (sameScreenCount >= 2) {
            hint =
              "The screen has not changed for at least three actions. Stop repeating taps; scroll, press BACK, or choose a different element.";
          }
        } else {
          sameScreenCount = 0;
        }
      }

      let decision: Decision;
      try {
        decision = await decide({
          router,
          config,
          model,
          task,
          step,
          maxSteps,
          snapshot,
          history,
          hint,
          triage: triageNote,
          logger,
          cost: usage,
        });
      } catch (error) {
        const record: StepArtifact = {
          step,
          at: new Date().toISOString(),
          screen: {
            packageName: snapshot.packageName,
            activity: snapshot.activity,
            width: snapshot.width,
            height: snapshot.height,
            nodes: snapshot.nodes.length,
            signature: snapshot.signature,
          },
          triage: triageRecord,
          error: error instanceof Error ? error.message : String(error),
        };
        artifacts.writeStep(step, { xml: snapshot.xml, png, record });
        throw error;
      }

      const action = decision.action;
      logger.info(`→ ${summarizeAction(action)}${action.reason ? ` · ${action.reason}` : ""}`);

      const record: StepArtifact = {
        step,
        at: new Date().toISOString(),
        screen: {
          packageName: snapshot.packageName,
          activity: snapshot.activity,
          width: snapshot.width,
          height: snapshot.height,
          nodes: snapshot.nodes.length,
          signature: snapshot.signature,
        },
        action,
        triage: triageRecord,
        usage: toStepUsage(decision.usage),
        llm: { model: decision.chat.model, latencyMs: decision.chat.latencyMs, finishReason: decision.chat.finishReason },
      };

      if (action.action === "done") {
        ok = true;
        summaryText = action.summary ?? "tarefa concluída";
        record.result = { ok: true, detail: summaryText };
        artifacts.writeStep(step, { xml: snapshot.xml, png, record });
        break;
      }
      if (action.action === "fail") {
        ok = false;
        summaryText = action.summary ?? action.reason ?? "agente desistiu";
        record.result = { ok: false, detail: summaryText };
        artifacts.writeStep(step, { xml: snapshot.xml, png, record });
        break;
      }
      if (options.dryRun) {
        ok = true;
        summaryText = `dry-run: ${summarizeAction(action)}`;
        record.result = { ok: true, detail: "dry-run (ação não executada)" };
        artifacts.writeStep(step, { xml: snapshot.xml, png, record });
        logger.info("Dry-run: ação não executada.");
        break;
      }

      const guard = await guardAction({
        config,
        task,
        action,
        snapshot,
        jev,
        assumeYes: options.yes ?? false,
        logger,
        confirm: options.confirm,
      });
      record.guard = guard;
      if (!guard.allowed) {
        history.push({
          step,
          action: summarizeAction(action),
          result: `blocked: ${guard.reason}`,
          screenSignature: snapshot.signature,
          screen: `${snapshot.packageName ?? "?"}/${snapshot.activity ?? "?"}`,
          ok: false,
        });
        record.result = { ok: false, detail: `guard: ${guard.reason}` };
        artifacts.writeStep(step, { xml: snapshot.xml, png, record });
        logger.warn(`Ação bloqueada: ${guard.reason}`);
        hint = "The previous action was blocked by the safety guard. Choose a safer alternative or fail.";
        continue;
      }

      try {
        const result = await executeAction({ adb, action, snapshot });
        record.result = { ok: result.ok, detail: result.detail };
        history.push({
          step,
          action: summarizeAction(action),
          result: result.detail,
          screenSignature: snapshot.signature,
          screen: `${snapshot.packageName ?? "?"}/${snapshot.activity ?? "?"}`,
          ok: result.ok,
        });
        logger.detail(result.detail);
        artifacts.writeStep(step, { xml: snapshot.xml, png, record });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        record.result = { ok: false, detail: message };
        record.error = message;
        history.push({
          step,
          action: summarizeAction(action),
          result: `error: ${message}`,
          screenSignature: snapshot.signature,
          screen: `${snapshot.packageName ?? "?"}/${snapshot.activity ?? "?"}`,
          ok: false,
        });
        artifacts.writeStep(step, { xml: snapshot.xml, png, record });
        logger.warn(`Ação falhou: ${message}`);
        hint = `The previous action failed: ${message}. Adapt instead of repeating it.`;
      }

      loadingWaits = 0;
      await sleep(config.stepDelayMs);
    }
  } catch (error) {
    const summary: RunSummary = {
      ok: false,
      summary: error instanceof Error ? error.message : String(error),
      steps,
      costUsd: usage.cost,
      promptTokens: usage.prompt,
      completionTokens: usage.completion,
      durationMs: Date.now() - started,
      model,
      artifactsDir: artifacts.dir,
      finishedAt: new Date().toISOString(),
    };
    artifacts.finalize(summary);
    throw new AgentRunError(summary.summary, summary);
  }

  const summary: RunSummary = {
    ok,
    summary: summaryText,
    steps,
    costUsd: usage.cost,
    promptTokens: usage.prompt,
    completionTokens: usage.completion,
    durationMs: Date.now() - started,
    model,
    artifactsDir: artifacts.dir,
    finishedAt: new Date().toISOString(),
  };
  artifacts.finalize(summary);
  if (ok) logger.success(`Concluído em ${formatDuration(summary.durationMs)} · ${summary.steps} passos · $${summary.costUsd.toFixed(5)}`);
  else logger.error(`Falhou após ${formatDuration(summary.durationMs)} · ${summary.summary}`);
  return summary;
}

export function defaultRunPaths(config: Config): { artifacts: string; emulatorLog: string } {
  return {
    artifacts: config.artifactsDir,
    emulatorLog: path.join(config.artifactsDir, "logs", "emulator.log"),
  };
}
