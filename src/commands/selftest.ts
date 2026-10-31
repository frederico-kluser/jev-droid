import { parseUiHierarchy, compactSummary } from "../android/ui.js";
import { encodeAdbText, parseAction } from "../android/actions.js";
import { bandFor, validateRequest, type DecisionsRequest } from "../jev.js";
import { extractJsonObject } from "../openrouter.js";
import type { Logger } from "../logger.js";

const SAMPLE_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.settings" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]"><node index="0" text="Settings" resource-id="com.android.settings:id/title" class="android.widget.TextView" package="com.android.settings" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,100][1080,250]" /><node index="1" text="Wi-Fi" resource-id="com.android.settings:id/wifi" class="android.widget.Switch" package="com.android.settings" content-desc="" checkable="true" checked="true" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,300][1080,450]" /><node index="2" text="" resource-id="" class="android.widget.ImageButton" package="com.android.settings" content-desc="Search" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[900,50][1050,200]" /></node></hierarchy>`;

export interface SelfTestResult {
  ok: boolean;
  passed: number;
  failed: number;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

export function runSelfTest(logger: Logger): SelfTestResult {
  const checks: SelfTestResult["checks"] = [];
  const add = (name: string, fn: () => void): void => {
    try {
      fn();
      checks.push({ name, ok: true });
      logger.success(name);
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
      logger.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const assert = (condition: unknown, message: string): void => {
    if (!condition) throw new Error(message);
  };

  add("UI hierarchy: parse, refs and centers", () => {
    const snapshot = parseUiHierarchy(SAMPLE_XML);
    assert(snapshot.nodes.length === 3, `expected 3 nodes, got ${snapshot.nodes.length}`);
    assert(snapshot.nodes[0]?.ref === "e1", "first ref must be e1");
    assert(snapshot.nodes[0]?.label === "Settings", "first label");
    assert(snapshot.nodes[2]?.label === "Search", "content-desc should become label");
    assert(snapshot.nodes[1]?.center.x === 540 && snapshot.nodes[1]?.center.y === 375, "center calculation");
    assert(snapshot.width === 1080 && snapshot.height === 2400, "screen size");
    assert(compactSummary(snapshot).includes("e2 Switch \"Wi-Fi\""), "compact summary");
  });

  add("Action schema: valid tap and done", () => {
    const tap = parseAction({ action: "tap", ref: "e2", reason: "toggle wifi" });
    assert(tap.ref === "e2", "tap ref");
    const done = parseAction({ action: "done", summary: "finished" });
    assert(done.action === "done", "done action");
  });

  add("Action schema: rejects invalid ref", () => {
    let threw = false;
    try {
      parseAction({ action: "tap", ref: "button-1" });
    } catch {
      threw = true;
    }
    assert(threw, "invalid ref must throw");
  });

  add("ADB text encoding", () => {
    assert(encodeAdbText("hello world") === "hello%sworld", "spaces become %s");
    assert(encodeAdbText("a&b") === "a\\&b", "shell metacharacters are escaped");
    let threw = false;
    try {
      encodeAdbText("olá");
    } catch {
      threw = true;
    }
    assert(threw, "Unicode must throw a clear error");
  });

  add("JSON extraction from fences and prose", () => {
    const value = extractJsonObject('Sure:\n```json\n{"action":"done","summary":"ok"}\n```');
    assert(value === '{"action":"done","summary":"ok"}', "extracted JSON");
  });

  add("JEV request validation", () => {
    const request: DecisionsRequest = {
      model: "typesafe/jev-1.13",
      state: "A customer cannot check out.",
      questions: {
        is_bug: { type: "noul", instructions: "Is this a bug?", criteria: { true: "yes", false: "no" } },
        team: {
          type: "choice",
          instructions: "Which team?",
          criteria: { frontend: "UI", payments: "checkout", other: "none" },
        },
        urgency: { type: "score", instructions: "How urgent?", criteria: ["wait", "this week", "revenue blocked"] },
      },
    };
    assert(validateRequest(request).length === 0, validateRequest(request).join("; "));
    const invalid = {
      ...request,
      questions: { bad: { type: "score" as const, instructions: "x", criteria: ["only one"] } },
    };
    assert(validateRequest(invalid).length > 0, "one-level score must be rejected");
  });

  add("JEV bands", () => {
    assert(bandFor({ type: "noul", noul: 0.95 }).band === "auto", "0.95 -> auto");
    assert(bandFor({ type: "noul", noul: 0.5 }).band === "hitl", "0.5 -> hitl");
    assert(bandFor({ type: "choice", choice: "a", probabilities: { a: 0.95, b: 0.05 }, confidence: 0.95 }).band === "auto", "0.95 confidence -> auto");
    assert(bandFor({ type: "choice", choice: "a", probabilities: { a: 0.6, b: 0.4 }, confidence: 0.6 }).band === "hitl", "0.6 -> hitl");
  });

  const passed = checks.filter((check) => check.ok).length;
  const failed = checks.length - passed;
  return { ok: failed === 0, passed, failed, checks };
}
