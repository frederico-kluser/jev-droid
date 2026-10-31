import assert from "node:assert/strict";
import test from "node:test";
import { parseUiHierarchy } from "../src/android/ui.js";
import {
  actionTarget,
  encodeAdbText,
  parseAction,
  resolveKeyCode,
  riskyTarget,
} from "../src/android/actions.js";

const XML = `<hierarchy rotation="0"><node text="" class="android.widget.FrameLayout" package="com.android.settings" bounds="[0,0][1080,2400]"><node text="Delete account" resource-id="com.android.settings:id/delete" class="android.widget.Button" package="com.android.settings" clickable="true" bounds="[100,1000][980,1100]" /><node text="Password" resource-id="com.android.settings:id/password" class="android.widget.EditText" package="com.android.settings" clickable="true" focused="true" bounds="[100,500][980,600]" /></node></hierarchy>`;

test("parseAction accepts tap and rejects unsafe shapes", () => {
  assert.equal(parseAction({ action: "tap", ref: "e1" }).ref, "e1");
  assert.throws(() => parseAction({ action: "tap", ref: "button" }), /invalid action|ref/);
  assert.throws(() => parseAction({ action: "type" }), /text/);
  assert.throws(() => parseAction({ action: "type", text: "" }), /non-empty/);
  assert.throws(() => parseAction({ action: "launch", package: "not a package" }), /package/);
  assert.throws(() => parseAction({ action: "done" }), /summary/);
});

test("encodeAdbText keeps ASCII, encodes spaces and escapes shell characters", () => {
  assert.equal(encodeAdbText("hello world"), "hello%sworld");
  assert.equal(encodeAdbText("a&b"), "a\\&b");
  assert.equal(encodeAdbText("user@example.com"), "user@example.com");
  assert.throws(() => encodeAdbText("olá"), /Unicode/);
  assert.throws(() => encodeAdbText("two\nlines"), /single line/);
});

test("resolveKeyCode maps friendly names and numbers", () => {
  assert.equal(resolveKeyCode("back"), "KEYCODE_BACK");
  assert.equal(resolveKeyCode("KEYCODE_HOME"), "KEYCODE_HOME");
  assert.equal(resolveKeyCode("4"), "4");
  assert.throws(() => resolveKeyCode("NOPE"), /unknown key/);
});

test("riskyTarget flags destructive labels only", () => {
  const snapshot = parseUiHierarchy(XML);
  assert.equal(riskyTarget({ action: "tap", ref: "e1" }, snapshot), 'Button "Delete account" id=delete');
  assert.equal(riskyTarget({ action: "tap", ref: "e2" }, snapshot), undefined);
  assert.equal(riskyTarget({ action: "key", key: "BACK" }, snapshot), undefined);
  assert.equal(riskyTarget({ action: "key", key: "ENTER" }, snapshot), "key ENTER");
});

test("actionTarget redacts typed content", () => {
  const snapshot = parseUiHierarchy(XML);
  const target = actionTarget({ action: "type", ref: "e2", text: "s3cr3t-password" }, snapshot);
  assert.ok(target.label.includes("15 chars"));
  assert.ok(!target.label.includes("s3cr3t"));
});
