import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { avdConfigPath, avdExists, listAvdDetails } from "../android/emulator.js";
import { listDevices } from "../android/adb.js";
import { probeSdk, androidEnv } from "../android/sdk.js";
import { JevClient } from "../jev.js";
import { OpenRouterClient } from "../openrouter.js";
import { redactKey } from "../config.js";
import type { Logger } from "../logger.js";
import { VERSION } from "../version.js";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  config: {
    sdkRoot: string;
    javaHome?: string;
    avd: string;
    model: string;
    jevModel: string;
    serial?: string;
    apiKey: string;
  };
}

export interface DoctorOptions {
  live?: boolean;
  offline?: boolean;
  logger: Logger;
}

function check(name: string, status: DoctorCheck["status"], detail: string, fix?: string): DoctorCheck {
  return { name, status, detail, fix };
}

function nodeMajor(): number {
  return Number(process.versions.node.split(".")[0]);
}

export async function runDoctor(config: Config, options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const { logger } = options;

  checks.push(
    nodeMajor() >= 22
      ? check("Node.js", "ok", process.version)
      : check("Node.js", "fail", `${process.version} (precisa >=22)`, "Instale Node 22+ (fnm/nvm ou nodejs.org)"),
  );

  checks.push(
    config.openRouterKey
      ? check("OPENROUTER_API_KEY", "ok", redactKey(config.openRouterKey))
      : check("OPENROUTER_API_KEY", "fail", "ausente", "Copie .env.example para .env e defina a chave"),
  );

  const paths = path.join(config.cwd, ".env");
  checks.push(
    fs.existsSync(paths)
      ? check(".env", "ok", paths)
      : check(".env", "warn", "não existe (variáveis podem vir do ambiente)", "cp .env.example .env"),
  );

  const sdk = await probeSdk(config);
  checks.push(
    sdk.java.ok
      ? check("Java (JDK)", "ok", sdk.java.version ?? "ok")
      : check("Java (JDK)", "fail", sdk.java.error ?? "ausente", "Rode scripts/setup-android.ps1 ou instale um JDK 21"),
  );
  checks.push(
    sdk.adb.ok ? check("adb", "ok", sdk.adb.version ?? "ok") : check("adb", "fail", sdk.adb.error ?? "ausente", "sdkmanager platform-tools"),
  );
  checks.push(
    sdk.emulator.ok
      ? check("emulator", "ok", sdk.emulator.version ?? "ok")
      : check("emulator", "fail", sdk.emulator.error ?? "ausente", "sdkmanager emulator"),
  );
  checks.push(
    sdk.acceleration.ok
      ? check("Aceleração (WHPX/Hyper-V)", "ok", sdk.acceleration.detail.split(/\r?\n/).filter(Boolean).join(" · "))
      : check(
          "Aceleração (WHPX/Hyper-V)",
          "fail",
          sdk.acceleration.detail || "WHPX indisponível",
          "Ative Windows Hypervisor Platform (scripts/setup-android.ps1) e reinicie",
        ),
  );

  let imageRel = path.join("system-images", "android-36", "google_apis", "x86_64");
  let playStore = false;
  const activeConfig = avdConfigPath(sdk.paths, config.avdName);
  if (fs.existsSync(activeConfig)) {
    const avdConfig = fs.readFileSync(activeConfig, "utf8");
    const configuredImage = avdConfig.match(/^image\.sysdir\.1=(.+)$/m)?.[1]?.trim();
    if (configuredImage) imageRel = configuredImage;
    playStore = /^PlayStore\.enabled=yes$/im.test(avdConfig);
  }
  const image = path.join(config.sdkRoot, imageRel, "system.img");
  const imageLabel = imageRel.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  checks.push(
    fs.existsSync(image)
      ? check("Imagem do AVD", "ok", `${imageLabel}${playStore ? " · Play Store ativa" : ""}`)
      : check(
          "Imagem do AVD",
          "warn",
          `${imageLabel} não instalada`,
          `sdkmanager "system-images;android-36;${playStore ? "google_apis_playstore" : "google_apis"};x86_64"`,
        ),
  );

  const avds = listAvdDetails(sdk.paths);
  if (avdExists(sdk.paths, config.avdName)) {
    checks.push(check("AVD", "ok", `${config.avdName} · ${avdConfigPath(sdk.paths, config.avdName)}`));
  } else {
    checks.push(
      check(
        "AVD",
        "fail",
        `"${config.avdName}" não existe (AVDs: ${avds.map((avd) => avd.name).join(", ") || "nenhum"})`,
        "npm run avd:setup",
      ),
    );
  }

  const env = androidEnv(config);
  const devices = await listDevices(sdk.paths.adb, env);
  const emulator = devices.find((device) => device.serial.startsWith("emulator-"));
  checks.push(
    devices.length > 0
      ? check(
          "adb devices",
          emulator?.state === "device" ? "ok" : "warn",
          devices.map((device) => `${device.serial}=${device.state}`).join(", "),
          emulator ? undefined : "npm run emulator:start",
        )
      : check("adb devices", "warn", "nenhum dispositivo ligado", "npm run emulator:start"),
  );

  if (config.openRouterKey && !options.offline) {
    const router = new OpenRouterClient({
      apiKey: config.openRouterKey,
      baseUrl: config.openRouterBaseUrl,
      appName: config.appName,
      appUrl: config.appUrl,
      timeoutMs: 30_000,
    });
    try {
      const key = await router.keyInfo();
      checks.push(
        check(
          "OpenRouter /key",
          "ok",
          `label=${key.label ?? "?"} free_tier=${key.is_free_tier ?? "?"} usage=$${(key.usage ?? 0).toFixed(2)}`,
        ),
      );
    } catch (error) {
      checks.push(
        check("OpenRouter /key", "fail", error instanceof Error ? error.message : String(error), "Verifique a chave e a rede"),
      );
    }
    try {
      const model = await router.modelInfo(config.model);
      if (!model) throw new Error("modelo não encontrado no catálogo");
      const input = Number(model.pricing?.prompt ?? 0) * 1_000_000;
      const output = Number(model.pricing?.completion ?? 0) * 1_000_000;
      checks.push(
        check(
          "Modelo principal",
          "ok",
          `${model.id} · ${(model.context_length ?? 0).toLocaleString("en-US")} tokens · $${input.toFixed(2)}/$${output.toFixed(
            2,
          )} por Mtok`,
        ),
      );
      if (!model.supported_parameters?.includes("response_format")) {
        checks.push(check("JSON mode", "warn", "response_format não listado para o modelo", "O agente tenta reparar JSON inválido"));
      }
    } catch (error) {
      checks.push(
        check(
          "Modelo principal",
          "fail",
          error instanceof Error ? error.message : String(error),
          "Confirme JEV_DROID_MODEL ou o slug em openrouter.ai/models",
        ),
      );
    }
    if (options.live) {
      try {
        const response = await router.chat({
          model: config.model,
          messages: [{ role: "user", content: 'Reply with exactly this JSON: {"ok":true}' }],
          temperature: 0,
          maxTokens: 40,
          responseFormat: { type: "json_object" },
          timeoutMs: 60_000,
        });
        checks.push(check("Modelo live", "ok", `${response.model} · ${response.latencyMs}ms · "${response.content.slice(0, 80)}"`));
      } catch (error) {
        checks.push(check("Modelo live", "fail", error instanceof Error ? error.message : String(error), "Verifique créditos/roteamento"));
      }
      try {
        const jev = new JevClient({
          apiKey: config.openRouterKey,
          baseUrl: config.jevBaseUrl,
          model: config.jevModel,
          appName: config.appName,
          appUrl: config.appUrl,
        });
        const result = await jev.decide({
          model: config.jevModel,
          state: "ping",
          questions: {
            ping: {
              type: "noul",
              instructions: "Is this request a health check?",
              criteria: { true: "It is a health check", false: "It is not" },
            },
          },
        });
        checks.push(
          check(
            "JEV live",
            "ok",
            `${result.response.model ?? config.jevModel} · ${result.latencyMs}ms · p=${Number(
              result.decisions.ping?.value ?? 0,
            ).toFixed(2)} · $${(result.response.usage?.cost ?? 0).toFixed(6)}`,
          ),
        );
      } catch (error) {
        checks.push(check("JEV live", "fail", error instanceof Error ? error.message : String(error), "Verifique o endpoint /api/alpha/decisions"));
      }
    }
  }

  const ok = !checks.some((item) => item.status === "fail");
  for (const item of checks) {
    const symbol = item.status === "ok" ? "✓" : item.status === "warn" ? "!" : "✗";
    const line = `${symbol} ${item.name}: ${item.detail}`;
    if (item.status === "ok") logger.info(line);
    else if (item.status === "warn") logger.warn(line);
    else logger.error(line);
    if (item.fix && item.status !== "ok") logger.detail(`  correção: ${item.fix}`);
  }
  logger.heading(ok ? "Doctor: pronto" : "Doctor: há bloqueios");
  if (ok) logger.info(`SDK: ${config.sdkRoot}`);
  logger.info(`Modelo: ${config.model} · JEV: ${config.jevModel} · AVD: ${config.avdName}`);
  logger.detail(`jev-droid ${VERSION}`);

  return {
    ok,
    checks,
    config: {
      sdkRoot: config.sdkRoot,
      javaHome: config.javaHome,
      avd: config.avdName,
      model: config.model,
      jevModel: config.jevModel,
      serial: config.serial,
      apiKey: redactKey(config.openRouterKey),
    },
  };
}
