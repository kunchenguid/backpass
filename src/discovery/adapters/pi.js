import fs from "node:fs";
import path from "node:path";

import {
  attachToolResults,
  contentToEvents,
  home,
  listDirs,
  listFiles,
  parseJsonLine,
  readHeadLines,
  readJsonl,
  statOrNull,
} from "./shared.js";

/**
 * Pi writes standalone sessions under
 * `~/.pi/agent/sessions/<escaped-cwd>/<ISO-ts>_<uuid>.jsonl`. BB's Pi bridge writes the
 * same JSONL shape directly under `<bb-data-dir>/pi-bridge-sessions/`.
 *
 * Line 1 is `{type:"session", cwd, id}`. Entries form a parent/child tree but arrive in
 * order, so a linear read is faithful. `model_change` / `thinking_level_change` records
 * give the model actually used. No remote is recorded - dead worktrees reach tier 3 only.
 */

export const name = "pi";

export function storeRoot() {
  return home(".pi", "agent", "sessions");
}

function expandEnvPath(value) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed === "~") return home();
  if (trimmed.startsWith("~/")) return path.join(home(), trimmed.slice(2));
  return path.resolve(trimmed);
}

function realpathOrResolve(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function storeSpecs() {
  const specs = [
    { path: storeRoot(), direct: false, nested: true },
    { path: home(".bb", "pi-bridge-sessions"), direct: true, nested: false },
  ];
  const piAgentDir = expandEnvPath(process.env.PI_CODING_AGENT_DIR);
  if (piAgentDir) specs.push({ path: path.join(piAgentDir, "sessions"), direct: false, nested: true });
  const piSessionDir = expandEnvPath(process.env.PI_CODING_AGENT_SESSION_DIR);
  if (piSessionDir) specs.push({ path: piSessionDir, direct: true, nested: false });
  const bbDataDir = expandEnvPath(process.env.BB_DATA_DIR);
  if (bbDataDir) specs.push({ path: path.join(bbDataDir, "pi-bridge-sessions"), direct: true, nested: false });
  const bridgeDir = expandEnvPath(process.env.BB_PI_BRIDGE_SESSION_DIR);
  if (bridgeDir) specs.push({ path: bridgeDir, direct: true, nested: false });

  const unique = new Map();
  for (const spec of specs) {
    const key = realpathOrResolve(spec.path);
    const existing = unique.get(key);
    if (existing) {
      existing.direct ||= spec.direct;
      existing.nested ||= spec.nested;
    } else {
      unique.set(key, spec);
    }
  }
  return [...unique.values()];
}

export function storeRoots() {
  return storeSpecs().map((spec) => spec.path);
}

export function enumerate() {
  const out = [];
  const seen = new Set();
  for (const spec of storeSpecs()) {
    const files = [
      ...(spec.direct ? listFiles(spec.path, ".jsonl") : []),
      ...(spec.nested ? listDirs(spec.path).flatMap((dir) => listFiles(dir, ".jsonl")) : []),
    ];
    for (const file of files) {
      const key = realpathOrResolve(file);
      if (seen.has(key)) continue;
      seen.add(key);
      const stat = statOrNull(file);
      if (!stat) continue;
      out.push({ key, path: file, mtimeMs: stat.mtimeMs, bytes: stat.size });
    }
  }
  return out;
}

export function classify(candidate) {
  const [first] = readHeadLines(candidate.path, 1);
  const entry = first && parseJsonLine(first);
  if (!entry || entry.type !== "session" || !entry.cwd) return null;
  return {
    id: entry.id || path.basename(candidate.path, ".jsonl"),
    cwd: entry.cwd,
    gitBranch: null,
    remotes: [],
    startedAt: entry.timestamp ? Date.parse(entry.timestamp) : candidate.mtimeMs,
    model: null,
  };
}

export function read(ref) {
  const entries = readJsonl(ref.path);
  const events = [];
  let model = null;

  for (const entry of entries) {
    if (entry.type === "model_change") {
      model = entry.modelId || model;
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    const role = message.role;

    if (role === "toolResult") {
      events.push({ kind: "tool-result", id: message.toolCallId ?? message.id, result: textOf(message.content) });
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    contentToEvents(role, message.content, events);
  }

  return { events: attachToolResults(events), model };
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content
    .map((b) => (typeof b === "string" ? b : (b?.text ?? "")))
    .filter(Boolean)
    .join("\n");
}
