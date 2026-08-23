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
 * omp (oh-my-pi): ~/.omp/agent/sessions/<escaped-cwd>/<ts>_<uuid>.jsonl
 *
 * OMP is a fork of pi and keeps a compatible on-disk format, with two drifts
 * verified against a real ~10k-file store:
 * - Most sessions START with a `{type:"title", title, ...}` line; the
 *   `{type:"session", id, timestamp, cwd}` header follows it (older files lead
 *   with the session header directly), so classify scans the first few lines.
 * - `model_change` records carry the model as `model` (never `modelId`), but
 *   both are accepted for safety.
 * The title line also carries a human-readable session title, which is
 * surfaced on the descriptor. Entries form a parent/child tree that arrives in
 * order. No remote is recorded - dead worktrees reach tier 3 only.
 */

export const name = "omp";

/** How many leading lines classify() scans to find the session header. */
const HEADER_SCAN_LINES = 8;

export function storeRoot() {
  return home(".omp", "agent", "sessions");
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
  const lines = readHeadLines(candidate.path, HEADER_SCAN_LINES);
  let session = null;
  let title = null;
  for (const line of lines) {
    const entry = parseJsonLine(line);
    if (!entry || typeof entry !== "object") continue;
    // Real stores write the human-readable title once, as the first line.
    if (entry.type === "title" && typeof entry.title === "string") {
      if (title === null) title = entry.title;
      continue;
    }
    if (entry.type === "session" && entry.cwd && !session) {
      session = entry;
    }
  }
  if (!session) return null;
  return {
    id: session.id || path.basename(candidate.path, ".jsonl"),
    cwd: session.cwd,
    gitBranch: null,
    remotes: [],
    startedAt: session.timestamp ? Date.parse(session.timestamp) : candidate.mtimeMs,
    model: null,
    title: title || null,
  };
}

export function read(ref) {
  const entries = readJsonl(ref.path);
  const events = [];
  let model = null;

  for (const entry of entries) {
    if (entry.type === "model_change") {
      model = entry.model ?? entry.modelId ?? model;
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
