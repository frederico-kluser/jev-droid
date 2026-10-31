import assert from "node:assert/strict";
import test from "node:test";
import { compactSummary, findByRef, parseBounds, parseUiHierarchy, shouldTriage } from "../src/android/ui.js";

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.settings" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]"><node index="0" text="Settings" resource-id="com.android.settings:id/title" class="android.widget.TextView" package="com.android.settings" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,100][1080,250]" /><node index="1" text="Wi-Fi" resource-id="com.android.settings:id/wifi" class="android.widget.Switch" package="com.android.settings" content-desc="" checkable="true" checked="true" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,300][1080,450]" /><node index="2" text="" resource-id="" class="android.widget.ImageButton" package="com.android.settings" content-desc="Search" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[900,50][1050,200]" /></node></hierarchy>`;

test("parseBounds rejects empty and inverted rectangles", () => {
  assert.deepEqual(parseBounds("[0,0][100,200]"), { left: 0, top: 0, right: 100, bottom: 200 });
  assert.equal(parseBounds("[0,0][0,0]"), undefined);
  assert.equal(parseBounds("garbage"), undefined);
});

test("parseUiHierarchy flattens labelled and interactive nodes", () => {
  const snapshot = parseUiHierarchy(XML, { activity: ".Settings" });
  assert.equal(snapshot.width, 1080);
  assert.equal(snapshot.height, 2400);
  assert.equal(snapshot.nodes.length, 3);
  assert.equal(snapshot.nodes[0]?.ref, "e1");
  assert.equal(snapshot.nodes[0]?.label, "Settings");
  assert.equal(snapshot.nodes[1]?.checked, true);
  assert.equal(snapshot.nodes[1]?.center.x, 540);
  assert.equal(snapshot.nodes[1]?.center.y, 375);
  assert.equal(snapshot.nodes[2]?.label, "Search");
  assert.equal(snapshot.nodes[2]?.contentDesc, "Search");
  assert.equal(findByRef(snapshot, "e2")?.text, "Wi-Fi");
  assert.match(compactSummary(snapshot), /e2 Switch "Wi-Fi"/);
});

test("maxNodes truncates without losing the screen signature", () => {
  const snapshot = parseUiHierarchy(XML, { maxNodes: 2 });
  assert.equal(snapshot.nodes.length, 2);
  assert.match(snapshot.signature, /^[0-9a-f]+-[0-9a-f]+$/);
});

test("shouldTriage detects loading/error hints", () => {
  const loading = parseUiHierarchy(XML.replace("Settings", "Loading…"));
  assert.equal(shouldTriage(loading), true);
  const ready = parseUiHierarchy(XML);
  assert.equal(shouldTriage(ready), false);
});

test("empty hierarchy throws a clear error", () => {
  assert.throws(() => parseUiHierarchy("<root />"), /hierarchy/);
});
