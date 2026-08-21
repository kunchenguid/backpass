import fs from "node:fs";
import path from "node:path";

import {
  attachToolResults,
  contentToEvents,
  home,
  parseJsonLine,
  readHeadLines,
  readJsonl,
  statOrNull,
} from "./shared.js";

/**
 * Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *
 * Line 1 is a `session_meta` record carrying `cwd` and, for sessions started inside a
 * repo, `git.repository_url` - which is why codex stays deterministic even after the
 * worktree is deleted (tier 2). The store is date-sharded and large (10k+ rollouts on
 * a working machine), so discovery reads only line 1 and leans on the scan cache.
 */

export const name = "codex";

export function storeRoot() {
  return home(".codex", "sessions");
}

/**
 * Walk the YYYY/MM/DD shards, skipping whole day directories outside the time window.
 * @param {{ cutoffMs?: number }} [options]
 */
export function enumerate({ cutoffMs } = {}) {
  const root = storeRoot();
  const out = [];
  if (!fs.existsSync(root)) return out;

  for (const year of shardDirs(root)) {
    for (const month of shardDirs(year)) {
      for (const day of shardDirs(month)) {
        if (cutoffMs && dayIsBefore(root, day, cutoffMs)) continue;
        let files;
        try {
          files = fs.readdirSync(day, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of files) {
          if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
          const file = path.join(day, entry.name);
          const stat = statOrNull(file);
          if (!stat) continue;
          out.push({ key: file, path: file, mtimeMs: stat.mtimeMs, bytes: stat.size });
        }
      }
    }
  }
  return out;
}

function shardDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** The shard path itself dates the sessions, so whole days can be skipped without stat-ing. */
function dayIsBefore(root, dayDir, cutoffMs) {
  const parts = path.relative(root, dayDir).split(path.sep);
  if (parts.length !== 3) return false;
  const [y, m, d] = parts.map(Number);
  if (!y || !m || !d) return false;
  // End of that day in UTC+14 (the earliest a local timestamp can roll over).
  const endOfDay = Date.UTC(y, m - 1, d + 1) + 14 * 3600_000;
  return endOfDay < cutoffMs;
}

export function classify(candidate) {
  const [first] = readHeadLines(candidate.path, 1);
  const entry = first && parseJsonLine(first);
  if (!entry || entry.type !== "session_meta") return null;
  const payload = entry.payload || {};
  const git = payload.git || {};
  return {
    id: payload.session_id || payload.id || path.basename(candidate.path, ".jsonl"),
    cwd: payload.cwd || null,
    gitBranch: git.branch || null,
    remotes: git.repository_url ? [git.repository_url] : [],
    startedAt: payload.timestamp ? Date.parse(payload.timestamp) : candidate.mtimeMs,
    model: payload.model || null,
  };
}

export function read(ref) {
  const entries = readJsonl(ref.path);
  const events = [];
  let model = null;

  for (const entry of entries) {
    if (entry.type === "turn_context" && entry.payload?.model) {
      model = model || entry.payload.model;
      continue;
    }
    if (entry.type !== "response_item") continue;
    const payload = entry.payload || {};

    switch (payload.type) {
      case "message": {
        // `developer` messages are harness scaffolding, never user intent.
        if (payload.role !== "user" && payload.role !== "assistant") break;
        contentToEvents(payload.role, payload.content, events);
        break;
      }
      case "function_call":
      case "custom_tool_call":
        events.push({
          kind: "tool",
          name: payload.name,
          input: parseMaybeJson(payload.arguments ?? payload.input),
          pendingId: payload.call_id,
        });
        break;
      case "function_call_output":
      case "custom_tool_call_output":
        events.push({
          kind: "tool-result",
          id: payload.call_id,
          result: flattenOutput(payload.output),
        });
        break;
      default:
        break;
    }
  }

  return { events: attachToolResults(events), model };
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function flattenOutput(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((b) => (typeof b === "string" ? b : (b?.text ?? "")))
      .filter(Boolean)
      .join("\n");
  }
  return output;
}
