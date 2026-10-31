import { z } from "zod";
import type { Adb } from "./adb.js";
import type { UiNode, UiSnapshot } from "./ui.js";
import { findByRef, nodeTarget } from "./ui.js";

export const ACTION_NAMES = [
  "tap",
  "tap_xy",
  "type",
  "swipe",
  "key",
  "launch",
  "wait",
  "done",
  "fail",
] as const;

export type ActionName = (typeof ACTION_NAMES)[number];

const rawActionSchema = z
  .object({
    action: z.enum(ACTION_NAMES),
    ref: z.string().regex(/^e\d+$/).optional(),
    x: z.number().int().nonnegative().optional(),
    y: z.number().int().nonnegative().optional(),
    text: z.string().max(2000).optional(),
    direction: z.enum(["up", "down", "left", "right"]).optional(),
    duration_ms: z.number().int().min(50).max(5000).optional(),
    key: z.string().max(40).optional(),
    package: z.string().max(200).optional(),
    ms: z.number().int().min(0).max(30_000).optional(),
    summary: z.string().max(1000).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();

export interface Action {
  action: ActionName;
  ref?: string;
  x?: number;
  y?: number;
  text?: string;
  direction?: "up" | "down" | "left" | "right";
  duration_ms?: number;
  key?: string;
  package?: string;
  ms?: number;
  summary?: string;
  reason?: string;
}

export class ActionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionValidationError";
  }
}

export function parseAction(raw: unknown): Action {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ActionValidationError("action is not valid JSON");
    }
  }
  const parsed = rawActionSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "action"}: ${issue.message}`).join("; ");
    throw new ActionValidationError(`invalid action: ${issues}`);
  }
  const action = parsed.data as Action;
  if (action.action === "tap" && !action.ref) throw new ActionValidationError("tap requires ref");
  if (action.action === "tap_xy" && (action.x === undefined || action.y === undefined)) {
    throw new ActionValidationError("tap_xy requires x and y");
  }
  if (action.action === "type" && (action.text === undefined || action.text.length === 0)) {
    throw new ActionValidationError("type requires non-empty text");
  }
  if (action.action === "swipe" && !action.direction) throw new ActionValidationError("swipe requires direction");
  if (action.action === "key" && !action.key) throw new ActionValidationError("key requires key");
  if (action.action === "launch" && !action.package) throw new ActionValidationError("launch requires package");
  if (action.action === "launch" && action.package && !/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+$/.test(action.package)) {
    throw new ActionValidationError(`invalid package name: ${action.package}`);
  }
  if (action.action === "wait" && action.ms === undefined) throw new ActionValidationError("wait requires ms");
  if (action.action === "done" && !action.summary) throw new ActionValidationError("done requires summary");
  if (action.action === "fail" && !action.summary && !action.reason) {
    throw new ActionValidationError("fail requires summary or reason");
  }
  return action;
}

const KEY_CODES: Record<string, string> = {
  HOME: "KEYCODE_HOME",
  BACK: "KEYCODE_BACK",
  ENTER: "KEYCODE_ENTER",
  TAB: "KEYCODE_TAB",
  ESCAPE: "KEYCODE_ESCAPE",
  ESC: "KEYCODE_ESCAPE",
  DEL: "KEYCODE_DEL",
  DELETE: "KEYCODE_FORWARD_DEL",
  SPACE: "KEYCODE_SPACE",
  POWER: "KEYCODE_POWER",
  APP_SWITCH: "KEYCODE_APP_SWITCH",
  RECENTS: "KEYCODE_APP_SWITCH",
  MENU: "KEYCODE_MENU",
  VOLUME_UP: "KEYCODE_VOLUME_UP",
  VOLUME_DOWN: "KEYCODE_VOLUME_DOWN",
  DPAD_UP: "KEYCODE_DPAD_UP",
  DPAD_DOWN: "KEYCODE_DPAD_DOWN",
  DPAD_LEFT: "KEYCODE_DPAD_LEFT",
  DPAD_RIGHT: "KEYCODE_DPAD_RIGHT",
  DPAD_CENTER: "KEYCODE_DPAD_CENTER",
};

export function resolveKeyCode(key: string): string {
  const normalized = key.trim().toUpperCase().replace(/^KEYCODE_/, "");
  if (KEY_CODES[normalized]) return KEY_CODES[normalized];
  if (/^\d+$/.test(normalized)) return normalized;
  if (/^KEYCODE_[A-Z0-9_]+$/.test(key.trim().toUpperCase())) return key.trim().toUpperCase();
  throw new ActionValidationError(
    `unknown key "${key}" — use ${Object.keys(KEY_CODES).join(", ")} or a numeric keycode`,
  );
}

/**
 * Android's `input text` has no Unicode support and no quoting layer.
 * Spaces become %s; shell metacharacters are backslash-escaped.
 */
export function encodeAdbText(text: string): string {
  if (/[^\u0000-\u007F]/.test(text)) {
    throw new ActionValidationError(
      "Android `input text` não digita Unicode; use texto ASCII ou cole via clipboard/ADBKeyboard",
    );
  }
  if (text.includes("\n") || text.includes("\r")) {
    throw new ActionValidationError("text must be a single line; use the key action with ENTER after typing");
  }
  if (text.length > 1200) throw new ActionValidationError("text is too long (max 1200 chars)");
  const withSpaces = text.replace(/ /g, "%s");
  return withSpaces.replace(/([\\`$&|;<>()[\]{}*?!#~^"'])/g, "\\$1");
}

export interface ExecuteResult {
  ok: boolean;
  detail: string;
  targetNode?: UiNode;
}

function directionPoints(direction: "up" | "down" | "left" | "right", width: number, height: number) {
  const cx = Math.round(width / 2);
  const cy = Math.round(height / 2);
  switch (direction) {
    case "up":
      return { x1: cx, y1: Math.round(height * 0.72), x2: cx, y2: Math.round(height * 0.28) };
    case "down":
      return { x1: cx, y1: Math.round(height * 0.28), x2: cx, y2: Math.round(height * 0.72) };
    case "left":
      return { x1: Math.round(width * 0.8), y1: cy, x2: Math.round(width * 0.2), y2: cy };
    case "right":
      return { x1: Math.round(width * 0.2), y1: cy, x2: Math.round(width * 0.8), y2: cy };
  }
}

export async function executeAction(input: {
  adb: Adb;
  action: Action;
  snapshot: UiSnapshot;
}): Promise<ExecuteResult> {
  const { adb, action, snapshot } = input;
  switch (action.action) {
    case "tap": {
      const node = findByRef(snapshot, action.ref ?? "");
      if (!node) throw new ActionValidationError(`ref ${action.ref} não existe no ecrã atual`);
      await adb.tap(node.center.x, node.center.y);
      return { ok: true, detail: `tap ${nodeTarget(node)} @${node.center.x},${node.center.y}`, targetNode: node };
    }
    case "tap_xy": {
      const x = action.x ?? 0;
      const y = action.y ?? 0;
      if (x > snapshot.width || y > snapshot.height) {
        throw new ActionValidationError(`tap_xy (${x},${y}) fora do ecrã ${snapshot.width}x${snapshot.height}`);
      }
      await adb.tap(x, y);
      return { ok: true, detail: `tap @${x},${y}` };
    }
    case "type": {
      const node = action.ref ? findByRef(snapshot, action.ref) : undefined;
      if (action.ref && !node) throw new ActionValidationError(`ref ${action.ref} não existe no ecrã atual`);
      if (node) {
        await adb.tap(node.center.x, node.center.y);
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
      const encoded = encodeAdbText(action.text ?? "");
      await adb.inputText(encoded);
      return {
        ok: true,
        detail: `type ${(action.text ?? "").length} chars${node ? ` em ${nodeTarget(node)}` : ""}`,
        targetNode: node,
      };
    }
    case "swipe": {
      const points = directionPoints(action.direction ?? "up", snapshot.width, snapshot.height);
      await adb.swipe(points.x1, points.y1, points.x2, points.y2, action.duration_ms ?? 320);
      return { ok: true, detail: `swipe ${action.direction}` };
    }
    case "key": {
      const code = resolveKeyCode(action.key ?? "");
      await adb.keyevent(code);
      return { ok: true, detail: `key ${code}` };
    }
    case "launch": {
      const pkg = action.package ?? "";
      if (!/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+$/.test(pkg)) {
        throw new ActionValidationError(`package inválido: ${pkg}`);
      }
      await adb.launchPackage(pkg);
      return { ok: true, detail: `launch ${pkg}` };
    }
    case "wait": {
      await new Promise((resolve) => setTimeout(resolve, action.ms ?? 0));
      return { ok: true, detail: `wait ${action.ms}ms` };
    }
    case "done":
      return { ok: true, detail: `done: ${action.summary ?? ""}` };
    case "fail":
      return { ok: false, detail: `fail: ${action.summary ?? action.reason ?? ""}` };
  }
}

const RISKY_TARGET =
  /\b(delete|remove|erase|clear data|uninstall|factory reset|wipe|pay|purchase|buy|subscribe|checkout|place order|send|share|logout|log out|sign out|delete account|block|report|transfer|withdraw|allow|deny|grant|revoke)\b/i;
const RISKY_TARGET_PT =
  /\b(excluir|apagar|remover|limpar dados|desinstalar|restaurar padrão|pagar|comprar|assinar|finalizar compra|enviar|compartilhar|sair|bloquear|denunciar|transferir|sacar|permitir|negar|conceder|revogar)\b/i;

export function actionTarget(action: Action, snapshot: UiSnapshot): { label: string; node?: UiNode } {
  switch (action.action) {
    case "tap": {
      const node = findByRef(snapshot, action.ref ?? "");
      return { label: nodeTarget(node), node };
    }
    case "tap_xy":
      return { label: `tap at ${action.x},${action.y}` };
    case "type": {
      const node = action.ref ? findByRef(snapshot, action.ref) : undefined;
      return {
        label: `type ${(action.text ?? "").length} chars${node ? ` into ${nodeTarget(node)}` : ""}`,
        node,
      };
    }
    case "swipe":
      return { label: `swipe ${action.direction}` };
    case "key":
      return { label: `key ${action.key}` };
    case "launch":
      return { label: `launch ${action.package}` };
    case "wait":
      return { label: `wait ${action.ms}ms` };
    case "done":
      return { label: `done: ${action.summary ?? ""}` };
    case "fail":
      return { label: `fail: ${action.summary ?? action.reason ?? ""}` };
  }
}

/** Cheap local pre-filter: only ask JEV when the target text looks consequential. */
export function riskyTarget(action: Action, snapshot: UiSnapshot): string | undefined {
  if (action.action === "key") {
    // ENTER may activate the focused button; DEL/POWER can also have side effects.
    if (/^(ENTER|DEL|DELETE|POWER)$/i.test((action.key ?? "").replace(/^KEYCODE_/i, ""))) {
      return `key ${action.key}`;
    }
    return undefined;
  }
  if (!["tap", "tap_xy", "type", "launch"].includes(action.action)) return undefined;
  const { label } = actionTarget(action, snapshot);
  if (RISKY_TARGET.test(label) || RISKY_TARGET_PT.test(label)) return label;
  return undefined;
}

export const ACTION_HELP = `Actions (return exactly ONE JSON object):
- {"action":"tap","ref":"e12","reason":"..."} — tap an element by ref
- {"action":"tap_xy","x":540,"y":1200,"reason":"..."} — tap raw coordinates (avoid when possible)
- {"action":"type","ref":"e3","text":"hello","reason":"..."} — focus a field and type ASCII text
- {"action":"swipe","direction":"up|down|left|right","duration_ms":320,"reason":"..."} — scroll
- {"action":"key","key":"BACK|HOME|ENTER|TAB|DEL|ESCAPE|APP_SWITCH","reason":"..."} — press a key
- {"action":"launch","package":"com.android.settings","reason":"..."} — open an app
- {"action":"wait","ms":1500,"reason":"..."} — wait for the UI to settle
- {"action":"done","summary":"what was accomplished"} — finish successfully
- {"action":"fail","summary":"why it cannot continue"} — give up`;
