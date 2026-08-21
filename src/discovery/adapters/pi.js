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
 * pi: ~/.pi/agent/sessions/<escaped-cwd>/<ISO-ts>_<uuid>.jsonl
 *
 * Line 1 is `{type:"session", cwd, id}`. Entries form a parent/child tree but arrive in
 * order, so a linear read is faithful. `model_change` / `thinking_level_change` records
 * give the model actually used. No remote is recorded - dead worktrees reach tier 3 only.
 */

export const name = "pi";

export function storeRoot() {
  return home(".pi", "agent", "sessions");
}

export function enumerate() {
  const out = [];
  for (const dir of listDirs(storeRoot())) {
    for (const file of listFiles(dir, ".jsonl")) {
      const stat = statOrNull(file);
      if (!stat) continue;
      out.push({ key: file, path: file, mtimeMs: stat.mtimeMs, bytes: stat.size });
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
