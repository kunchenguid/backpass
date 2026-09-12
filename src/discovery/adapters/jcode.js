import path from "node:path";

import { interactionSignals } from "../../interaction.js";
import { attachToolResults, contentToEvents, home, listFiles, readJsonFile, readJsonl, statOrNull } from "./shared.js";

/**
 * Jcode stores one JSON snapshot per session under `~/.jcode/sessions/` and may keep
 * newer append-only events in a sibling `.journal.jsonl` file. The snapshot is a
 * single JSON value rather than JSONL, so classification deliberately parses the
 * whole file. Scan caching keeps that cost to changed sessions only.
 */

export const name = "jcode";

const NON_CONVERSATIONAL_DISPLAY_ROLES = new Set(["system", "background_task"]);

export function storeRoot() {
  const configured = process.env.JCODE_HOME?.trim();
  return configured ? path.join(path.resolve(configured), "sessions") : home(".jcode", "sessions");
}

function journalPath(snapshotPath) {
  return snapshotPath.replace(/\.json$/, ".journal.jsonl");
}

function sessionData(snapshotPath) {
  const snapshot = readJsonFile(snapshotPath);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;

  const data = { ...snapshot };
  const messages = Array.isArray(snapshot.messages) ? [...snapshot.messages] : [];
  const seenMessageIds = new Set(messages.map((message) => message?.id).filter(Boolean));
  const journal = journalPath(snapshotPath);

  for (const entry of readJsonl(journal)) {
    if (entry.meta && typeof entry.meta === "object" && !Array.isArray(entry.meta)) {
      Object.assign(data, entry.meta);
    }
    if (!Array.isArray(entry.append_messages)) continue;
    for (const message of entry.append_messages) {
      const id = message?.id;
      if (id && seenMessageIds.has(id)) continue;
      if (id) seenMessageIds.add(id);
      messages.push(message);
    }
  }

  data.messages = messages;
  return data;
}

export function enumerate() {
  const root = storeRoot();
  const out = [];
  for (const file of listFiles(root, ".json")) {
    if (!path.basename(file).startsWith("session_")) continue;
    const snapshot = statOrNull(file);
    if (!snapshot) continue;
    const journal = statOrNull(journalPath(file));
    out.push({
      key: file,
      path: file,
      mtimeMs: Math.max(snapshot.mtimeMs, journal?.mtimeMs || 0),
      bytes: snapshot.size + (journal?.size || 0),
    });
  }
  return out;
}

export function classify(candidate) {
  const data = sessionData(candidate.path);
  if (!data || typeof data.working_dir !== "string" || !data.working_dir) return null;

  return {
    id: data.id || path.basename(candidate.path, ".json"),
    cwd: data.working_dir,
    gitBranch: data.git_branch || data.branch || null,
    remotes: Array.isArray(data.remotes) ? data.remotes : [],
    startedAt: data.created_at ? Date.parse(data.created_at) : candidate.mtimeMs,
    model: data.model || null,
    interactionSignals: interactionSignals({ parentId: data.parent_id }),
  };
}

export function read(ref) {
  const data = sessionData(ref.path);
  if (!data) return { events: [], model: null };

  const events = [];
  for (const message of data.messages || []) {
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    if (NON_CONVERSATIONAL_DISPLAY_ROLES.has(message.display_role)) continue;
    contentToEvents(message.role, message.content, events);
  }

  return { events: attachToolResults(events), model: data.model || null };
}
