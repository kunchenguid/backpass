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
 * A leading title line or the session header carries a human-readable session
 * title, which is surfaced on the descriptor. Entries form a parent/child tree
 * that arrives in order. No remote is recorded - dead worktrees reach tier 3 only.
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
      if (typeof entry.title === "string" && title === null) title = entry.title;
    }
  }
  if (!session) return null;
  const parsed = session.timestamp ? Date.parse(session.timestamp) : NaN;
  return {
    id: session.id || path.basename(candidate.path, ".jsonl"),
    cwd: session.cwd,
    gitBranch: null,
    remotes: [],
    startedAt: Number.isFinite(parsed) ? parsed : candidate.mtimeMs,
    model: null,
    title: title || null,
  };
}

export function read(ref) {
  const entries = readJsonl(ref.path);
  const events = [];
  let model = null;
  // Ids of tool calls seen in this read. readJsonl reads >64MB files tail-first
  // and drops the partial boundary line, so a call can be truncated away while
  // its result survives; without tracking, attachToolResults' orphan fallback
  // would pin that stale result onto the next pending call. Unmatched results
  // are dropped instead of misattributed.
  const toolCallIds = new Set();

  for (const entry of entries) {
    if (entry.type === "model_change") {
      model = entry.model ?? entry.modelId ?? model;
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    const role = message.role;

    if (role === "toolResult") {
      events.push({
        kind: "tool-result",
        id: message.toolCallId ?? message.id,
        result: textOf(message.content),
        status: message.isError ? "error" : "completed",
      });
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    const before = events.length;
    contentToEvents(role, message.content, events);
    for (let i = before; i < events.length; i += 1) {
      const event = /** @type {{kind: string, pendingId?: string}} */ (events[i]);
      if (event.kind === "tool" && event.pendingId) toolCallIds.add(event.pendingId);
    }
  }

  // Drop results whose call never appeared (truncated tail-read); a stale
  // result must not be folded into an unrelated later call.
  const correlated = events.filter((e) => e.kind !== "tool-result" || (e.id && toolCallIds.has(e.id)));

  return { events: attachToolResults(correlated), model };
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content
    .map((b) => (typeof b === "string" ? b : (b?.text ?? "")))
    .filter(Boolean)
    .join("\n");
}
