import { XMLParser } from "fast-xml-parser";
import { shortHash, truncate } from "../util.js";

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface UiNode {
  ref: string;
  index: number;
  text: string;
  contentDesc: string;
  hint: string;
  resourceId: string;
  className: string;
  packageName: string;
  bounds: Bounds;
  center: { x: number; y: number };
  clickable: boolean;
  longClickable: boolean;
  scrollable: boolean;
  editable: boolean;
  checkable: boolean;
  checked: boolean;
  selected: boolean;
  enabled: boolean;
  focused: boolean;
  password: boolean;
  label: string;
}

export interface UiSnapshot {
  xml: string;
  packageName?: string;
  activity?: string;
  rotation: number;
  width: number;
  height: number;
  nodes: UiNode[];
  totalNodes: number;
  signature: string;
  capturedAt: string;
}

interface RawNode {
  [key: string]: unknown;
  node?: RawNode | RawNode[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
});

function asString(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function asBool(value: unknown): boolean {
  return asString(value).toLowerCase() === "true";
}

export function parseBounds(value: string): Bounds | undefined {
  const match = value.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
  if (!match) return undefined;
  const [, left, top, right, bottom] = match;
  const bounds = {
    left: Number(left),
    top: Number(top),
    right: Number(right),
    bottom: Number(bottom),
  };
  if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) return undefined;
  return bounds;
}

function childrenOf(node: RawNode): RawNode[] {
  const children = node.node;
  if (!children) return [];
  return Array.isArray(children) ? children : [children];
}

function shortClass(className: string): string {
  const parts = className.split(".");
  return parts.at(-1) ?? className;
}

function shortId(resourceId: string): string {
  return resourceId.replace(/^.*:id\//, "");
}

function labelOf(text: string, contentDesc: string, hint: string): string {
  return (text || contentDesc || hint).replace(/\s+/g, " ").trim();
}

function isInteractive(node: UiNode): boolean {
  return (
    node.clickable ||
    node.longClickable ||
    node.scrollable ||
    node.editable ||
    node.checkable ||
    node.focused ||
    /EditText|Button|CheckBox|RadioButton|Switch|Spinner|SeekBar|Tab/i.test(node.className)
  );
}

/** Parse a UI Automator XML dump into a flat, LLM-friendly snapshot. */
export function parseUiHierarchy(xml: string, options: { activity?: string; maxNodes?: number } = {}): UiSnapshot {
  const parsed = parser.parse(xml) as { hierarchy?: RawNode };
  const hierarchy = parsed.hierarchy;
  if (!hierarchy) throw new Error("XML sem elemento <hierarchy>");
  const rootNode = Array.isArray(hierarchy.node) ? hierarchy.node[0] : hierarchy.node;
  if (!rootNode) throw new Error("XML sem <node> raiz");
  const rootBounds = parseBounds(asString(rootNode.bounds)) ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const width = Math.max(rootBounds.right - rootBounds.left, 0);
  const height = Math.max(rootBounds.bottom - rootBounds.top, 0);

  const flat: UiNode[] = [];
  let totalNodes = 0;
  let index = 0;

  const walk = (raw: RawNode): void => {
    totalNodes += 1;
    const bounds = parseBounds(asString(raw.bounds));
    const className = asString(raw.class);
    const text = asString(raw.text);
    const contentDesc = asString(raw["content-desc"]);
    const hint = asString(raw.hint);
    const label = labelOf(text, contentDesc, hint);
    const interactive =
      asBool(raw.clickable) ||
      asBool(raw["long-clickable"]) ||
      asBool(raw.scrollable) ||
      /EditText|Button|CheckBox|RadioButton|Switch|Spinner|SeekBar/i.test(className);

    if (bounds && (label || interactive)) {
      const node: UiNode = {
        ref: "",
        index,
        text,
        contentDesc,
        hint,
        resourceId: asString(raw["resource-id"]),
        className,
        packageName: asString(raw.package),
        bounds,
        center: {
          x: Math.round((bounds.left + bounds.right) / 2),
          y: Math.round((bounds.top + bounds.bottom) / 2),
        },
        clickable: asBool(raw.clickable),
        longClickable: asBool(raw["long-clickable"]),
        scrollable: asBool(raw.scrollable),
        editable: /EditText/i.test(className),
        checkable: asBool(raw.checkable),
        checked: asBool(raw.checked),
        selected: asBool(raw.selected),
        enabled: raw.enabled === undefined ? true : asBool(raw.enabled),
        focused: asBool(raw.focused),
        password: asBool(raw.password),
        label,
      };
      flat.push(node);
      index += 1;
    }
    for (const child of childrenOf(raw)) walk(child);
  };

  walk(rootNode);

  const maxNodes = options.maxNodes ?? 140;
  const nodes = flat.slice(0, maxNodes);
  nodes.forEach((node, i) => {
    node.ref = `e${i + 1}`;
  });

  // Android clickable rows are usually unlabeled containers with labeled children.
  // Fold those child labels into the interactive parent so the LLM can tap the row.
  const contains = (outer: Bounds, inner: Bounds): boolean =>
    inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom;
  for (const node of nodes) {
    if (node.label || !isInteractive(node) || node.scrollable) continue;
    const labels: string[] = [];
    for (const other of nodes) {
      if (other === node || !other.label) continue;
      if (!contains(node.bounds, other.bounds)) continue;
      if (other.bounds.left === node.bounds.left && other.bounds.top === node.bounds.top) continue;
      if (!labels.includes(other.label)) labels.push(other.label);
      if (labels.length >= 3) break;
    }
    if (labels.length > 0) node.label = truncate(labels.join(" · "), 110);
  }

  const packageName =
    nodes.find((node) => node.packageName && !node.packageName.startsWith("android"))?.packageName ??
    nodes.find((node) => node.packageName)?.packageName;

  const signatureSource = [
    packageName ?? "",
    options.activity ?? "",
    ...nodes.map((node) => `${node.ref}:${node.label}|${node.resourceId}|${node.center.x},${node.center.y}|${isInteractive(node)}`),
  ].join("\n");

  return {
    xml,
    packageName,
    activity: options.activity,
    rotation: Number(asString(hierarchy.rotation) || "0"),
    width,
    height,
    nodes,
    totalNodes,
    signature: shortHash(signatureSource),
    capturedAt: new Date().toISOString(),
  };
}

export function formatNode(node: UiNode, maxText = 72): string {
  const className = shortClass(node.className) || "Node";
  const label = truncate(node.label || "(sem rótulo)", maxText).replace(/"/g, '\\"');
  const id = node.resourceId ? ` id=${truncate(shortId(node.resourceId), 40)}` : "";
  const flags: string[] = [];
  if (node.clickable) flags.push("click");
  if (node.longClickable) flags.push("long");
  if (node.scrollable) flags.push("scroll");
  if (node.editable) flags.push("edit");
  if (node.checkable) flags.push(node.checked ? "checked" : "unchecked");
  if (node.selected) flags.push("selected");
  if (node.focused) flags.push("focused");
  if (!node.enabled) flags.push("disabled");
  if (node.password) flags.push("password");
  const flagText = flags.length > 0 ? ` [${flags.join(",")}]` : "";
  return `${node.ref} ${className} "${label}"${id} @(${node.center.x},${node.center.y})${flagText}`;
}

export function compactSummary(snapshot: UiSnapshot, maxNodes = 80): string {
  const shown = snapshot.nodes.slice(0, maxNodes);
  const header = [
    `screen=${snapshot.width}x${snapshot.height}`,
    `app=${snapshot.packageName ?? "?"}`,
    `activity=${snapshot.activity ?? "?"}`,
    `elements=${snapshot.nodes.length}${snapshot.totalNodes > snapshot.nodes.length ? ` (tree has ${snapshot.totalNodes} nodes)` : ""}`,
  ].join(" | ");
  const lines = shown.map((node) => formatNode(node));
  const omitted = snapshot.nodes.length - shown.length;
  if (omitted > 0) lines.push(`... ${omitted} more elements omitted`);
  return `${header}\n${lines.join("\n")}`;
}

export function triageSummary(snapshot: UiSnapshot, maxNodes = 50): string {
  const labels = snapshot.nodes
    .slice(0, maxNodes)
    .map((node) => `${shortClass(node.className)}: ${truncate(node.label, 60)}${node.clickable ? " (clickable)" : ""}`)
    .join("\n");
  return `app=${snapshot.packageName ?? "?"} activity=${snapshot.activity ?? "?"}\n${labels}`;
}

export function findByRef(snapshot: UiSnapshot, ref: string): UiNode | undefined {
  return snapshot.nodes.find((node) => node.ref === ref);
}

export function findRefByText(snapshot: UiSnapshot, text: string): UiNode | undefined {
  const needle = text.trim().toLowerCase();
  if (!needle) return undefined;
  return (
    snapshot.nodes.find((node) => node.label.toLowerCase() === needle) ??
    snapshot.nodes.find((node) => node.label.toLowerCase().includes(needle))
  );
}

export function nodeTarget(node: UiNode | undefined): string {
  if (!node) return "(desconhecido)";
  return `${shortClass(node.className)} "${node.label}"${node.resourceId ? ` id=${shortId(node.resourceId)}` : ""}`;
}

const LOADING_HINT =
  /loading|carregando|loading\.\.\.|please wait|aguarde|progress|spinner|skeleton|preparing|inicializando|starting/i;
const PERMISSION_HINT =
  /permission|permitir|allow|deny|negar|while using the app|só desta vez|somente desta vez|sign in|entrar com|choose an account/i;
const ERROR_HINT = /error|erro|failed|falhou|try again|tente novamente|offline|sem conexão|something went wrong/i;

export function hasLoadingHint(snapshot: UiSnapshot): boolean {
  return snapshot.nodes.some((node) => LOADING_HINT.test(node.label));
}

export function hasPermissionHint(snapshot: UiSnapshot): boolean {
  return snapshot.nodes.some((node) => PERMISSION_HINT.test(node.label));
}

export function hasErrorHint(snapshot: UiSnapshot): boolean {
  return snapshot.nodes.some((node) => ERROR_HINT.test(node.label));
}

/** Run the cheap JEV triage only when the screen actually looks ambiguous. */
export function shouldTriage(snapshot: UiSnapshot): boolean {
  if (snapshot.nodes.length <= 2) return true;
  if (hasLoadingHint(snapshot) || hasPermissionHint(snapshot) || hasErrorHint(snapshot)) return true;
  return false;
}

export function describeScreen(snapshot: UiSnapshot): string {
  return `${snapshot.packageName ?? "?"}/${snapshot.activity ?? "?"} ${snapshot.width}x${snapshot.height} (${snapshot.nodes.length} nodes)`;
}
