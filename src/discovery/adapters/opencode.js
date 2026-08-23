import path from "node:path";

import { home, listDirs, readJsonFile, statOrNull } from "./shared.js";
import { openReadOnly, safeJsonParse } from "./sqlite.js";

/**
 * opencode: ~/.local/share/opencode/opencode.db (sqlite)
 *
 *   project(id, worktree)             - one row per project root
 *   session(id, project_id, directory, title, time_created)
 *   message(id, session_id, data)     - data is JSON: {role, model, time, ...}
 *   part(id, message_id, session_id, data) - data is JSON: {type: text|tool|reasoning|...}
 *
 * This is the best-behaved store: association is a SQL predicate on
 * `session.directory`, deleted worktrees included, and both listing and reading are
 * indexed. Older opencode versions used file storage under `storage/`; that layout is
 * handled as a fallback so long-lived machines still yield transcripts.
 */

export const name = "opencode";
export const sqliteBacked = true;

export function storeRoot() {
  return home(".local", "share", "opencode");
}

export function dbPath() {
  return path.join(storeRoot(), "opencode.db");
}

/**
 * Discovery is direct: one query returns every session with its directory, and the
 * caller applies the shared association tiers.
 */
export async function discover({ cutoffMs }) {
  const db = await openReadOnly(dbPath());
  if (!db) return legacyDiscover({ cutoffMs });

  try {
    const rows = db
      .prepare(
        `SELECT s.id AS id, s.directory AS directory, s.title AS title,
                s.time_created AS time_created, s.time_updated AS time_updated,
                p.worktree AS worktree
           FROM session s
           LEFT JOIN project p ON p.id = s.project_id
          WHERE (? IS NULL OR s.time_updated >= ?)`,
      )
      .all(cutoffMs ?? null, cutoffMs ?? 0);

    return rows.map((row) => ({
      key: `opencode:${row.id}`,
      id: row.id,
      path: dbPath(),
      cwd: row.directory,
      gitRoot: row.worktree || null,
      gitBranch: null,
      remotes: [],
      title: row.title || null,
      startedAt: Number(row.time_created) || null,
      mtimeMs: Number(row.time_updated) || Number(row.time_created) || 0,
      bytes: 0,
      model: null,
      extra: { sessionId: row.id },
    }));
  } finally {
    db.close();
  }
}

export async function read(ref) {
  const db = await openReadOnly(dbPath());
  if (!db) return legacyRead();

  try {
    const sessionId = ref.extra?.sessionId || ref.id;
    const messages = db
      .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id")
      .all(sessionId);
    const parts = db
      .prepare("SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id")
      .all(sessionId);

    const partsByMessage = new Map();
    for (const part of parts) {
      if (!partsByMessage.has(part.message_id)) partsByMessage.set(part.message_id, []);
      partsByMessage.get(part.message_id).push(safeJsonParse(part.data));
    }

    const events = [];
    let model = null;

    for (const message of messages) {
      const data = safeJsonParse(message.data) || {};
      const role = data.role === "user" ? "user" : "assistant";
      model = model || data.modelID || data.model?.modelID || null;

      const texts = [];
      for (const part of partsByMessage.get(message.id) || []) {
        if (!part) continue;
        if (part.type === "text" && part.text) {
          texts.push(part.text);
        } else if (part.type === "tool") {
          events.push({
            kind: "tool",
            name: part.tool || part.name,
            input: part.state?.input ?? part.input,
            result: part.state?.output ?? part.output,
            status: part.state?.status,
          });
        }
        // reasoning / step-start / step-finish / patch / file parts carry no loss signal.
      }
      if (texts.length) events.push({ kind: "message", role, text: texts.join("\n") });
    }

    return { events, model };
  } finally {
    db.close();
  }
}

/** Pre-sqlite opencode kept JSON files under storage/. Best-effort, never fatal. */
function legacyDiscover({ cutoffMs }) {
  const projectsDir = path.join(storeRoot(), "storage", "project");
  const out = [];
  for (const dir of listDirs(projectsDir)) {
    const meta = readJsonFile(path.join(dir, "project.json"));
    const stat = statOrNull(dir);
    if (!meta?.worktree || !stat) continue;
    if (cutoffMs && stat.mtimeMs < cutoffMs) continue;
    out.push({
      key: `opencode-legacy:${dir}`,
      id: path.basename(dir),
      path: dir,
      cwd: meta.worktree,
      remotes: [],
      startedAt: stat.birthtimeMs || stat.mtimeMs,
      mtimeMs: stat.mtimeMs,
      bytes: 0,
      extra: { legacy: true },
    });
  }
  return out;
}

function legacyRead() {
  // The legacy layout stores messages per project in a shape that changed across
  // releases; rather than guess, report an empty trace so the run stays fail-soft.
  return { events: [], model: null };
}
