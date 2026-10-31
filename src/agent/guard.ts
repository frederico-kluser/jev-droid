import type { Config } from "../config.js";
import type { Action } from "../android/actions.js";
import { riskyTarget } from "../android/actions.js";
import type { UiSnapshot } from "../android/ui.js";
import type { JevClient, GuardResult } from "../jev.js";
import type { Logger } from "../logger.js";

export interface GuardOutcome {
  allowed: boolean;
  asked: boolean;
  reason: string;
  jev?: GuardResult;
}

export interface GuardInput {
  config: Config;
  task: string;
  action: Action;
  snapshot: UiSnapshot;
  jev?: JevClient;
  assumeYes: boolean;
  logger: Logger;
  confirm?: (question: string) => Promise<boolean>;
}

export async function guardAction(input: GuardInput): Promise<GuardOutcome> {
  if (input.action.action === "done" || input.action.action === "fail") {
    return { allowed: true, asked: false, reason: "terminal action" };
  }
  const target = riskyTarget(input.action, input.snapshot);
  if (!target) return { allowed: true, asked: false, reason: "local pre-filter: not consequential" };

  let jevResult: GuardResult | undefined;
  if (input.config.jevGuard && input.jev) {
    try {
      jevResult = await input.jev.guardAction({
        task: input.task,
        action: input.action.action,
        target,
        packageName: input.snapshot.packageName,
      });
      input.logger.detail(
        `JEV guard: ${jevResult.allowed ? "auto" : "hitl"} · ${jevResult.reason} · ${jevResult.latencyMs}ms`,
      );
      if (jevResult.allowed) {
        return { allowed: true, asked: false, reason: `JEV auto (${jevResult.reason})`, jev: jevResult };
      }
    } catch (error) {
      input.logger.warn(
        `JEV guard indisponível (${error instanceof Error ? error.message : String(error)}); a pedir confirmação local.`,
      );
    }
  }

  if (input.assumeYes) {
    input.logger.warn(`Ação sensível permitida por --yes: ${target}`);
    return { allowed: true, asked: false, reason: "--yes", jev: jevResult };
  }
  if (!input.confirm) {
    return {
      allowed: false,
      asked: false,
      reason: `ação sensível sem confirmação disponível: ${target}`,
      jev: jevResult,
    };
  }

  const detail = jevResult ? `JEV: ${jevResult.reason}` : "JEV indisponível";
  const question = `Ação potencialmente sensível: ${target}\n${detail}\nExecutar mesmo assim?`;
  const allowed = await input.confirm(question);
  return {
    allowed,
    asked: true,
    reason: allowed ? "humano autorizou" : "humano recusou",
    jev: jevResult,
  };
}
