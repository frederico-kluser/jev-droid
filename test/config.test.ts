import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findSdkRoot, loadConfig, redactKey, sdkPaths } from "../src/config.js";

test("loadConfig applies env overrides and clamps values", () => {
  const config = loadConfig({
    cwd: os.tmpdir(),
    loadEnvFile: false,
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "sk-or-v1-test-1234567890",
      JEV_DROID_MODEL: "deepseek/deepseek-v4.1-flash-1017",
      JEV_DROID_MAX_STEPS: "999",
      JEV_DROID_TEMPERATURE: "-3",
      JEV_DROID_AVD: "my_avd",
      JEV_DROID_HEADLESS: "false",
      JEV_DROID_SDK_ROOT: "C:\\Android\\Sdk",
      JEV_DROID_JEV_TRIAGE: "no",
    },
  });
  assert.equal(config.model, "deepseek/deepseek-v4.1-flash-1017");
  assert.equal(config.maxSteps, 100);
  assert.equal(config.temperature, 0);
  assert.equal(config.avdName, "my_avd");
  assert.equal(config.headless, false);
  assert.equal(config.jevTriage, false);
  assert.equal(config.sdkRoot, path.resolve("C:\\Android\\Sdk"));
});

test("redactKey never leaks the middle of a key", () => {
  const redacted = redactKey("sk-or-v1-1234567890abcdef");
  assert.match(redacted, /^sk-or-v1/);
  assert.ok(!redacted.includes("234567890abc"));
  assert.equal(redactKey(undefined), "(ausente)");
});

test("sdkPaths points at the standard command-line tools", () => {
  const paths = sdkPaths("C:\\Android\\Sdk");
  assert.ok(paths.adb.endsWith("adb.exe") || paths.adb.endsWith("adb"));
  assert.ok(paths.emulator.includes("emulator"));
  assert.ok(paths.sdkmanager.includes("sdkmanager"));
  assert.ok(paths.avdmanager.includes("avdmanager"));
});

test("findSdkRoot prefers ANDROID_HOME when it exists", () => {
  const existing = path.resolve(".");
  const root = findSdkRoot({ ...process.env, ANDROID_HOME: existing });
  assert.equal(root, existing);
});
