#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline/promises";
import { loadConfig, redactKey, sdkPaths, type Config } from "./config.js";
import { Logger } from "./logger.js";
import { VERSION } from "./version.js";
import { runDoctor } from "./commands/doctor.js";
import { runSelfTest } from "./commands/selftest.js";
import { runTask, AgentRunError, type RunOptions } from "./agent/loop.js";
import { avdExists, createAvd, listAvdDetails, prepareDevice, startEmulator, stopEmulator, waitForEmulator } from "./android/emulator.js";
import { resolveSerial, Adb, createAdb, listDevices } from "./android/adb.js";
import { androidEnv } from "./android/sdk.js";
import { compactSummary, parseUiHierarchy } from "./android/ui.js";
import { JevClient, validateRequest, type DecisionsRequest } from "./jev.js";
import { OpenRouterClient } from "./openrouter.js";
import { run } from "./util.js";

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
      continue;
    }
    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "-y") {
      flags.yes = true;
      continue;
    }
    if (arg === "-v") {
      flags.version = true;
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, flags };
}

function stringFlag(flags: ParsedArgs["flags"], key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function boolFlag(flags: ParsedArgs["flags"], key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}

function numberFlag(flags: ParsedArgs["flags"], key: string): number | undefined {
  const value = stringFlag(flags, key);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function configWithFlags(base: Config, flags: ParsedArgs["flags"]): Config {
  const config: Config = { ...base };
  const avd = stringFlag(flags, "avd");
  if (avd) config.avdName = avd;
  const serial = stringFlag(flags, "serial");
  if (serial) config.serial = serial;
  const model = stringFlag(flags, "model");
  if (model) config.model = model;
  const maxSteps = numberFlag(flags, "max-steps");
  if (maxSteps !== undefined) config.maxSteps = Math.max(1, Math.min(100, Math.trunc(maxSteps)));
  if (boolFlag(flags, "headed")) config.headless = false;
  if (boolFlag(flags, "headless")) config.headless = true;
  return config;
}

function printHelp(logger: Logger): void {
  logger.raw(`jev-droid ${VERSION} — automação Android por LLM + JEV

Uso:
  jev-droid <comando> [opções]

Comandos:
  doctor [--live] [--offline] [--json]   Diagnóstico do ambiente, SDK, WHPX, modelo e JEV
  run "<tarefa>" [opções]                Executa uma tarefa no emulador
  avd list|create|start|stop             Gere o AVD oficial (sdkmanager/avdmanager/emulator)
  ui dump [--json] [--raw]               Despeja a UI hierarchy actual (uiautomator)
  jev ask --file pedido.json             Uma decisão tipada JEV (noul/choice/score)
  jev validate --file pedido.json        Validação offline do pedido JEV
  models [--query deepseek] [--json]     Modelos e preços no OpenRouter
  selftest                               Testes offline do parser, schema e bandas
  setup                                  Corre scripts/setup-android.ps1 (Windows)
  version | help

Opções de run:
  --avd <nome>          AVD a usar (predef.: .env / jev_google_36)
  --serial <serial>     Dispositivo adb existente (não arranca AVD)
  --headed              Mostra a janela do emulador
  --max-steps <n>       Limite de passos (1..100)
  --model <slug>        Override do modelo principal
  --yes, -y             Autoriza acções sensíveis sem perguntar (usar com cuidado)
  --dry-run             Decide a primeira acção mas não executa
  --no-screenshots      Não guarda PNG por passo
  --restart             Reinicia o emulador antes da tarefa
  --no-start            Exige um dispositivo já ligado

Stack gratuita: emulador Android oficial + WHPX/Hyper-V nativo + ADB local.
Modelo: deepseek/deepseek-v4.1-flash-1017 · decisões: typesafe/jev-1.13.
Chave: OPENROUTER_API_KEY no .env (nunca commitida).

Exemplos:
  jev-droid doctor --live
  jev-droid avd create --name jev_google_36
  jev-droid avd start --name jev_google_36
  jev-droid run "Abrir Definições e confirmar que o Wi-Fi está ligado"
  jev-droid run "Abrir a app Mensagens e escrever 'olá' para o primeiro contacto" --dry-run
  jev-droid ui dump --json`);
}

async function confirmInteractive(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question}\n[y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function commandDoctor(config: Config, flags: ParsedArgs["flags"], logger: Logger): Promise<void> {
  const report = await runDoctor(config, {
    live: boolFlag(flags, "live"),
    offline: boolFlag(flags, "offline"),
    logger,
  });
  if (boolFlag(flags, "json")) console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

async function commandRun(config: Config, positionals: string[], flags: ParsedArgs["flags"], logger: Logger): Promise<void> {
  const task = stringFlag(flags, "task") ?? positionals.slice(1).join(" ").trim();
  if (!task) {
    logger.error('Erro: falta a tarefa — Solução: jev-droid run "abrir definições"');
    process.exitCode = 2;
    return;
  }
  const json = boolFlag(flags, "json");
  const assumeYes = boolFlag(flags, "yes");
  const options: RunOptions = {
    config,
    task,
    logger,
    serial: stringFlag(flags, "serial"),
    headless: !boolFlag(flags, "headed"),
    maxSteps: numberFlag(flags, "max-steps"),
    yes: assumeYes,
    dryRun: boolFlag(flags, "dry-run"),
    captureScreenshots: !boolFlag(flags, "no-screenshots"),
    restart: boolFlag(flags, "restart"),
    noStart: boolFlag(flags, "no-start"),
    model: stringFlag(flags, "model"),
    confirm: json ? undefined : confirmInteractive,
  };
  try {
    const summary = await runTask(options);
    if (json) console.log(JSON.stringify(summary, null, 2));
    process.exitCode = summary.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof AgentRunError) {
      if (json) {
        console.log(JSON.stringify(error.summary ?? { ok: false, summary: error.message }, null, 2));
      } else {
        logger.error(`Erro: ${error.message} — Solução: veja doctor e os artefactos da execução.`);
      }
    } else {
      logger.error(`Erro: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  }
}

async function commandAvd(config: Config, positionals: string[], flags: ParsedArgs["flags"], logger: Logger): Promise<void> {
  const sub = positionals[1] ?? "list";
  const paths = sdkPaths(config.sdkRoot);
  const env = androidEnv(config);

  if (sub === "list") {
    const avds = listAvdDetails(paths);
    if (boolFlag(flags, "json")) {
      console.log(JSON.stringify(avds, null, 2));
      return;
    }
    if (avds.length === 0) {
      logger.warn("Nenhum AVD. Crie com: jev-droid avd create --name jev_google_36");
      return;
    }
    for (const avd of avds) {
      logger.info(`${avd.name === config.avdName ? "*" : " "} ${avd.name} · ${avd.image ?? avd.target ?? "?"} · ${avd.ram ?? "?"} RAM`);
      logger.detail(avd.path);
    }
    return;
  }

  if (sub === "create") {
    const name = stringFlag(flags, "name") ?? config.avdName;
    const api = numberFlag(flags, "api") ?? 36;
    const variantRaw = stringFlag(flags, "variant") ?? "google_apis";
    const variants = ["google_apis", "aosp_atd", "google_atd", "default"] as const;
    if (!variants.includes(variantRaw as (typeof variants)[number])) {
      logger.error(`Erro: variante inválida "${variantRaw}" — Solução: ${variants.join(", ")}`);
      process.exitCode = 2;
      return;
    }
    const result = await createAvd({
      paths,
      name,
      api,
      variant: variantRaw as (typeof variants)[number],
      device: stringFlag(flags, "device") ?? "pixel_6",
      force: boolFlag(flags, "force"),
      env,
      javaHome: config.javaHome,
      ramMb: numberFlag(flags, "ram"),
      cores: numberFlag(flags, "cores"),
    });
    logger.success(`${result.created ? "AVD criado" : "AVD já existia"}: ${result.name}`);
    logger.detail(result.configPath);
    return;
  }

  if (sub === "start") {
    const name = stringFlag(flags, "name") ?? config.avdName;
    if (!avdExists(paths, name)) {
      logger.error(`Erro: AVD "${name}" não existe — Solução: jev-droid avd create --name ${name}`);
      process.exitCode = 2;
      return;
    }
    const port = numberFlag(flags, "port") ?? 5554;
    const started = await startEmulator({
      paths,
      avdName: name,
      port,
      headless: !boolFlag(flags, "headed"),
      wipeData: boolFlag(flags, "wipe"),
      env,
      logFile: path.join(config.artifactsDir, "logs", `emulator-${Date.now()}.log`),
    });
    logger.info(`Emulador a arrancar (pid ${started.pid}) · log ${started.logFile}`);
    const adb = new Adb({ adbPath: paths.adb, serial: started.serial, env });
    await waitForEmulator(adb, config.bootTimeoutMs, (elapsed, detail) => {
      if (elapsed % 10_000 < 2_000) logger.detail(`${Math.round(elapsed / 1000)}s · ${detail}`);
    });
    await prepareDevice(adb);
    logger.success(`${started.serial} pronto · ${name}`);
    if (boolFlag(flags, "json")) console.log(JSON.stringify({ serial: started.serial, pid: started.pid, avd: name }, null, 2));
    return;
  }

  if (sub === "stop") {
    const serial = stringFlag(flags, "serial") ?? config.serial ?? (await resolveSerial(paths.adb, undefined, env));
    if (!serial) {
      logger.warn("Nenhum dispositivo adb para parar.");
      return;
    }
    const adb = new Adb({ adbPath: paths.adb, serial, env });
    await stopEmulator(adb);
    logger.success(`Pedido de encerramento enviado a ${serial}`);
    return;
  }

  logger.error(`Erro: subcomando avd desconhecido "${sub}" — Solução: list, create, start ou stop`);
  process.exitCode = 2;
}

async function commandUi(config: Config, positionals: string[], flags: ParsedArgs["flags"], logger: Logger): Promise<void> {
  const sub = positionals[1] ?? "dump";
  if (sub !== "dump") {
    logger.error(`Erro: subcomando ui desconhecido "${sub}" — Solução: ui dump`);
    process.exitCode = 2;
    return;
  }
  const paths = sdkPaths(config.sdkRoot);
  const env = androidEnv(config);
  let serial = stringFlag(flags, "serial") ?? config.serial;
  if (!serial) serial = await resolveSerial(paths.adb, undefined, env);
  if (!serial) {
    logger.error('Erro: nenhum dispositivo ligado — Solução: jev-droid avd start');
    process.exitCode = 1;
    return;
  }
  const adb = new Adb({ adbPath: paths.adb, serial, env });
  const focus: { activity?: string } = await adb.currentFocus().catch(() => ({}));
  const xml = await adb.dumpUiXml();
  const out = stringFlag(flags, "out");
  if (out) {
    fs.writeFileSync(path.resolve(out), xml, "utf8");
    logger.success(`XML guardado em ${path.resolve(out)}`);
  }
  const snapshot = parseUiHierarchy(xml, { activity: focus.activity });
  if (boolFlag(flags, "raw")) {
    console.log(xml);
    return;
  }
  if (boolFlag(flags, "json")) {
    console.log(JSON.stringify({ ...snapshot, xml: undefined }, null, 2));
    return;
  }
  logger.info(compactSummary(snapshot, 120));
}

async function commandJev(config: Config, positionals: string[], flags: ParsedArgs["flags"], logger: Logger): Promise<void> {
  const sub = positionals[1] ?? "ask";
  const file = stringFlag(flags, "file");
  if (!file) {
    logger.error("Erro: falta --file — Solução: jev-droid jev ask --file examples/jev-screen-triage.json");
    process.exitCode = 2;
    return;
  }
  const raw = fs.readFileSync(path.resolve(file), "utf8");
  const request = JSON.parse(raw) as DecisionsRequest;
  const errors = validateRequest(request);
  if (sub === "validate") {
    if (boolFlag(flags, "json")) console.log(JSON.stringify({ ok: errors.length === 0, errors }, null, 2));
    else if (errors.length === 0) logger.success("Pedido JEV válido");
    else errors.forEach((error) => logger.error(error));
    process.exitCode = errors.length === 0 ? 0 : 2;
    return;
  }
  if (sub !== "ask") {
    logger.error(`Erro: subcomando jev desconhecido "${sub}" — Solução: ask ou validate`);
    process.exitCode = 2;
    return;
  }
  if (errors.length > 0) {
    errors.forEach((error) => logger.error(error));
    process.exitCode = 2;
    return;
  }
  if (!config.openRouterKey) {
    logger.error("Erro: OPENROUTER_API_KEY ausente — Solução: configure o .env");
    process.exitCode = 1;
    return;
  }
  const model = stringFlag(flags, "model") ?? request.model ?? config.jevModel;
  const jev = new JevClient({
    apiKey: config.openRouterKey,
    baseUrl: config.jevBaseUrl,
    model,
    appName: config.appName,
    appUrl: config.appUrl,
    thresholds: { auto: config.jevAutoThreshold, hitl: config.jevHitlThreshold },
  });
  const result = await jev.decide({ ...request, model });
  if (boolFlag(flags, "json")) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          model: result.response.model ?? model,
          decisions: result.decisions,
          usage: result.response.usage ?? null,
          latency_ms: result.latencyMs,
        },
        null,
        2,
      ),
    );
    return;
  }
  logger.success(`JEV ${result.response.model ?? model} · ${result.latencyMs}ms · $${(result.response.usage?.cost ?? 0).toFixed(6)}`);
  for (const [id, decision] of Object.entries(result.decisions)) {
    const extra = decision.type === "noul" ? `p=${decision.value}` : `confidence=${decision.confidence}`;
    logger.info(`  ${id}: ${JSON.stringify(decision.value)} [${decision.band.toUpperCase()}] ${extra}`);
  }
}

async function commandModels(config: Config, flags: ParsedArgs["flags"], logger: Logger): Promise<void> {
  if (!config.openRouterKey) {
    logger.error("Erro: OPENROUTER_API_KEY ausente — Solução: configure o .env");
    process.exitCode = 1;
    return;
  }
  const router = new OpenRouterClient({
    apiKey: config.openRouterKey,
    baseUrl: config.openRouterBaseUrl,
    appName: config.appName,
    appUrl: config.appUrl,
    timeoutMs: 30_000,
  });
  const query = stringFlag(flags, "query") ?? "deepseek";
  const models = await router.listModels(query);
  if (boolFlag(flags, "json")) {
    console.log(JSON.stringify(models, null, 2));
    return;
  }
  for (const model of models) {
    const input = Number(model.pricing?.prompt ?? 0) * 1_000_000;
    const output = Number(model.pricing?.completion ?? 0) * 1_000_000;
    logger.info(`${model.id} · ${(model.context_length ?? 0).toLocaleString("en-US")} ctx · $${input.toFixed(2)}/$${output.toFixed(2)} Mtok`);
  }
}

async function commandSetup(config: Config, flags: ParsedArgs["flags"], logger: Logger): Promise<void> {
  if (process.platform !== "win32") {
    logger.error("Erro: setup automático só está implementado para Windows — Solução: instale o SDK com sdkmanager manualmente.");
    process.exitCode = 2;
    return;
  }
  const script = path.join(config.cwd, "scripts", "setup-android.ps1");
  if (!fs.existsSync(script)) {
    logger.error(`Erro: ${script} não existe — Solução: clone o repositório completo.`);
    process.exitCode = 1;
    return;
  }
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script];
  const avd = stringFlag(flags, "avd");
  if (avd) args.push("-AvdName", avd);
  const api = numberFlag(flags, "api");
  if (api !== undefined) args.push("-Api", String(api));
  logger.info(`A correr ${script}…`);
  const result = await run(
    process.platform === "win32" ? "powershell.exe" : "pwsh",
    args,
    { timeoutMs: 45 * 60 * 1000, env: process.env },
  );
  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.error(result.stderr.trim());
  if (result.code !== 0) {
    logger.error(`Erro: setup falhou (exit ${result.code}) — Solução: leia a saída acima.`);
    process.exitCode = result.code;
    return;
  }
  logger.success("Setup concluído.");
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const flags = parsed.flags;
  const json = boolFlag(flags, "json");
  const logger = new Logger({ quiet: json, debug: boolFlag(flags, "debug") });
  const command = parsed.positionals[0] ?? "help";

  if (boolFlag(flags, "version") || command === "version") {
    console.log(VERSION);
    return;
  }
  if (command === "help" || boolFlag(flags, "help")) {
    printHelp(logger);
    return;
  }

  const baseConfig = loadConfig();
  const config = configWithFlags(baseConfig, flags);

  switch (command) {
    case "doctor":
      await commandDoctor(config, flags, logger);
      return;
    case "run":
      await commandRun(config, parsed.positionals, flags, logger);
      return;
    case "avd":
      await commandAvd(config, parsed.positionals, flags, logger);
      return;
    case "ui":
      await commandUi(config, parsed.positionals, flags, logger);
      return;
    case "jev":
      await commandJev(config, parsed.positionals, flags, logger);
      return;
    case "models":
      await commandModels(config, flags, logger);
      return;
    case "selftest": {
      const result = runSelfTest(logger);
      if (json) console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    case "setup":
      await commandSetup(config, flags, logger);
      return;
    default:
      logger.error(`Erro: comando desconhecido "${command}" — Solução: jev-droid help`);
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Erro: ${message} — Solução: rode "jev-droid doctor" e verifique o .env/SDK.`);
  process.exitCode = 1;
});
