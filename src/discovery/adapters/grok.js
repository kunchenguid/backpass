import fs from "node:fs";
import path from "node:path";

import { attachToolResults, contentToEvents, home, listDirs, readJsonFile, readJsonl, statOrNull } from "./shared.js";

/**
 * grok: ~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/
 *         chat_history.jsonl  - the conversation
 *         summary.json        - {info:{cwd}, git_root_dir, git_remotes[], head_branch, ...}
 *
 * `git_remotes` is recorded at session start, so grok reaches tier 2 for dead worktrees.
 * The unit of discovery is the session directory rather than a single file.
 */

export const name = "grok";

export function storeRoot() {
  return home(".grok", "sessions");
}

export function enumerate() {
  const out = [];
  for (const cwdDir of listDirs(storeRoot())) {
    for (const sessionDir of listDirs(cwdDir)) {
      const chat = path.join(sessionDir, "chat_history.jsonl");
      const stat = statOrNull(chat);
      if (!stat) continue;
      out.push({ key: sessionDir, path: sessionDir, chatPath: chat, mtimeMs: stat.mtimeMs, bytes: stat.size });
    }
  }
  return out;
}

export function classify(candidate) {
  const summary = readJsonFile(path.join(candidate.path, "summary.json"));
  const cwd = summary?.info?.cwd ?? decodeDirName(path.basename(path.dirname(candidate.path)));
  if (!cwd) return null;
  return {
    id: summary?.info?.id || path.basename(candidate.path),
    cwd,
    gitRoot: summary?.git_root_dir || null,
    gitBranch: summary?.head_branch || null,
    remotes: Array.isArray(summary?.git_remotes) ? summary.git_remotes : [],
    startedAt: summary?.created_at ? Date.parse(summary.created_at) : candidate.mtimeMs,
    model: summary?.current_model_id || null,
    extra: { chatPath: candidate.chatPath || path.join(candidate.path, "chat_history.jsonl") },
  };
}

function decodeDirName(encoded) {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

export function read(ref) {
  const chatPath = ref.extra?.chatPath || path.join(ref.path, "chat_history.jsonl");
  if (!fs.existsSync(chatPath)) return { events: [], model: null };

  const entries = readJsonl(chatPath);
  const events = [];
  let model = null;

  for (const entry of entries) {
    switch (entry.type) {
      case "user":
        contentToEvents("user", entry.content, events);
        break;
      case "assistant":
        model = model || entry.model_id || null;
        contentToEvents("assistant", entry.content, events);
        // grok hangs tool calls off the assistant record rather than emitting blocks.
        for (const call of entry.tool_calls || []) {
          events.push({
            kind: "tool",
            name: call.name,
            input: parseMaybeJson(call.arguments ?? call.input),
            pendingId: call.id,
          });
        }
        break;
      case "tool_result":
        events.push({ kind: "tool-result", id: entry.tool_call_id ?? entry.id, result: entry.content });
        break;
      default:
        break;
    }
  }

  return { events: attachToolResults(events), model };
}

/** Exported for the raw-transcript escape hatch: the analysis agent opens this file. */
export function rawPath(ref) {
  return ref.extra?.chatPath || path.join(ref.path, "chat_history.jsonl");
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
