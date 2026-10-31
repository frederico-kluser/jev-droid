import assert from "node:assert/strict";
import test from "node:test";
import { extractJsonObject } from "../src/openrouter.js";
import { buildUserPrompt, formatHistory, summarizeAction } from "../src/agent/prompt.js";
import { parseUiHierarchy } from "../src/android/ui.js";

const XML = `<hierarchy rotation="0"><node text="" class="android.widget.FrameLayout" package="com.android.settings" bounds="[0,0][1080,2400]"><node text="Wi-Fi" resource-id="com.android.settings:id/wifi" class="android.widget.Switch" package="com.android.settings" clickable="true" checkable="true" checked="true" bounds="[0,300][1080,450]" /></node></hierarchy>`;

test("extractJsonObject handles fences, prose and braces in strings", () => {
  assert.equal(extractJsonObject('```json\n{"action":"done","summary":"ok"}\n```'), '{"action":"done","summary":"ok"}');
  assert.equal(
    extractJsonObject('prefix {"action":"done","summary":"use {braces}"} suffix'),
    '{"action":"done","summary":"use {braces}"}',
  );
  assert.throws(() => extractJsonObject("no json here"), /no JSON/);
});

test("buildUserPrompt includes task, screen and history", () => {
  const snapshot = parseUiHierarchy(XML);
  const prompt = buildUserPrompt({
    task: "Toggle Wi-Fi",
    step: 2,
    maxSteps: 10,
    snapshot,
    history: [
      { step: 1, action: "tap e1", result: "ok", screenSignature: "abc", screen: "settings", ok: true },
    ],
    hint: "watch out",
    triage: "screen_state=ready",
  });
  assert.match(prompt, /TASK: Toggle Wi-Fi/);
  assert.match(prompt, /STEP: 2\/10/);
  assert.match(prompt, /e1 Switch "Wi-Fi"/);
  assert.match(prompt, /#1 tap e1/);
  assert.match(prompt, /HINT: watch out/);
});

test("formatHistory keeps only the most recent entries", () => {
  const history = Array.from({ length: 10 }, (_, index) => ({
    step: index + 1,
    action: `tap e${index + 1}`,
    result: "ok",
    screenSignature: "sig",
    screen: "screen",
    ok: true,
  }));
  const text = formatHistory(history, 3);
  assert.match(text, /#8/);
  assert.doesNotMatch(text, /#7 /);
});

test("summarizeAction redacts typed text", () => {
  assert.equal(summarizeAction({ action: "type", text: "secret", ref: "e2" }), "type 6 chars into e2");
});
