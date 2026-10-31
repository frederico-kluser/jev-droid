import assert from "node:assert/strict";
import test from "node:test";
import { guardAction } from "../src/agent/guard.js";
import { parseUiHierarchy } from "../src/android/ui.js";
import { loadConfig } from "../src/config.js";
import type { JevClient } from "../src/jev.js";
import { Logger } from "../src/logger.js";

const XML = `<hierarchy rotation="0"><node text="" class="android.widget.FrameLayout" package="com.android.settings" bounds="[0,0][1080,2400]"><node text="Delete account" resource-id="com.android.settings:id/delete" class="android.widget.Button" package="com.android.settings" clickable="true" bounds="[100,1000][980,1100]" /><node text="Password" resource-id="com.android.settings:id/password" class="android.widget.EditText" package="com.android.settings" clickable="true" bounds="[100,500][980,600]" /></node></hierarchy>`;

const config = loadConfig({
  cwd: process.cwd(),
  loadEnvFile: false,
  env: { ...process.env, JEV_DROID_JEV_GUARD: "true", JEV_DROID_JEV_TRIAGE: "false" },
});
const logger = new Logger({ quiet: true, color: false });
const snapshot = parseUiHierarchy(XML);

function fakeJev(allowed: boolean): JevClient {
  return {
    guardAction: async () => ({
      allowed,
      needsHuman: !allowed,
      band: allowed ? "auto" : "hitl",
      risk: allowed ? 0.05 : 0.8,
      impact: 1,
      reason: "fake",
      latencyMs: 1,
    }),
  } as unknown as JevClient;
}

test("guard skips ordinary navigation without calling JEV", async () => {
  const result = await guardAction({
    config,
    task: "type a password",
    action: { action: "tap", ref: "e2" },
    snapshot,
    assumeYes: false,
    logger,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.asked, false);
});

test("guard blocks a risky action when JEV says hitl", async () => {
  const result = await guardAction({
    config,
    task: "delete account",
    action: { action: "tap", ref: "e1" },
    snapshot,
    jev: fakeJev(false),
    assumeYes: false,
    logger,
    confirm: async () => false,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.asked, true);
  assert.match(result.reason, /humano recusou/);
});

test("guard allows a risky action after human confirmation", async () => {
  const result = await guardAction({
    config,
    task: "delete account",
    action: { action: "tap", ref: "e1" },
    snapshot,
    jev: fakeJev(false),
    assumeYes: false,
    logger,
    confirm: async () => true,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.asked, true);
  assert.match(result.reason, /humano autorizou/);
});

test("guard allows a risky action with explicit --yes", async () => {
  const result = await guardAction({
    config,
    task: "delete account",
    action: { action: "tap", ref: "e1" },
    snapshot,
    jev: fakeJev(false),
    assumeYes: true,
    logger,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.asked, false);
  assert.match(result.reason, /--yes/);
});

test("guard denies when JEV is unavailable and there is no TTY", async () => {
  const result = await guardAction({
    config,
    task: "delete account",
    action: { action: "tap", ref: "e1" },
    snapshot,
    assumeYes: false,
    logger,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.asked, false);
});
