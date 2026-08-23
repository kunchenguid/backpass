import path from "node:path";

import { home, contentToEvents, attachToolResults } from "./shared.js";
import { openReadOnly, safeJsonParse } from "./sqlite.js";

/**
 * hermes: ~/.hermes/state.db (sqlite)
 *
 * Observed schema version 13 (upstream is 26; SELECT named columns so additive
 * columns are tolerated). v26 adds sessions.cwd; CLI rows leave system_prompt
 * NULL and store the project path there. ACP still snapshots cwd on
 * model_config. Prefer the cwd column when present, then the v13 paths:
 *   acp - model_config.cwd when it is an absolute path
 *   cli - first `Current working directory:` / `Working directory:` line in
 *         system_prompt
 * Gateway / cron / whatsapp sessions are skipped even if sessions.cwd is set:
 * their path is the gateway process cwd, not a project, and would pin
 * unrelated sessions to one repo. Sessions with no recoverable cwd are skipped.
 *
 * Timestamps are epoch seconds; backpass uses milliseconds (x1000).
 * Structured content uses a `\x00json:` prefix; node:sqlite truncates TEXT at
 * NUL, so message content is read as BLOB and decoded.
 * JSONL leftovers under ~/.hermes/sessions/ are abandoned and not read.
 * Honor HERMES_HOME; do not walk profile directories.
 */

export const name = "hermes";
export const sqliteBacked = true;

const CLI_ACP = new Set(["cli", "acp"]);
const JSON_PREFIX = "\x00json:";
const CWD_LINE = /^(?:Current working directory|Working directory):\s*(.+)$/m;

export function storeRoot() {
  return process.env.HERMES_HOME || home(".hermes");
}

export function dbPath() {
  return path.join(storeRoot(), "state.db");
}

function toMs(epochSeconds) {
  const n = Number(epochSeconds);
  return Number.isFinite(n) ? Math.round(n * 1000) : null;
}

function looksAbsolute(value) {
  return typeof value === "string" && value.length > 0 && path.isAbsolute(value);
}

function cwdFromConfig(raw) {
  const parsed = typeof raw === "string" ? safeJsonParse(raw) : raw;
  return looksAbsolute(parsed?.cwd) ? parsed.cwd : null;
}

function cwdFromPrompt(prompt) {
  if (typeof prompt !== "string" || !prompt) return null;
  const match = prompt.match(CWD_LINE);
  if (!match) return null;
  const cwd = match[1].trim();
  return looksAbsolute(cwd) ? cwd : null;
}

function recoverCwd(row, source) {
  if (looksAbsolute(row.cwd)) return row.cwd;
  if (source === "acp") return cwdFromConfig(row.model_config);
  if (source === "cli") return cwdFromPrompt(row.system_prompt);
  return null;
}

function tableHasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((entry) => entry.name === column);
}

function activeMessageFilter(db, alias = "") {
  return tableHasColumn(db, "messages", "active") ? ` AND ${alias}active = 1` : "";
}

function sessionCwdSelect(db) {
  return tableHasColumn(db, "sessions", "cwd") ? ", s.cwd" : "";
}

/**
 * Discovery is one indexed query. The caller applies the shared association
 * tiers and handles schema errors per harness. A missing DB yields an empty list.
 * @param {{ cutoffMs?: number }} [options]
 */
export async function discover({ cutoffMs } = {}) {
  const db = await openReadOnly(dbPath());
  if (!db) return [];

  const cutoffSec = cutoffMs == null ? null : cutoffMs / 1000;
  try {
    const activeFilter = activeMessageFilter(db, "m.");
    const cwdSelect = sessionCwdSelect(db);
    const rows = db
      .prepare(
        `SELECT s.id, s.source, s.model, s.model_config, s.system_prompt, s.title,
                s.started_at, s.ended_at${cwdSelect},
                MAX(s.started_at,
                    COALESCE(s.ended_at, s.started_at),
                    COALESCE((SELECT MAX(m.timestamp)
                                FROM messages m
                               WHERE m.session_id = s.id${activeFilter}),
                             s.started_at)) AS activity_at
           FROM sessions s
          WHERE lower(s.source) IN ('cli', 'acp')
            AND (? IS NULL OR
                 MAX(s.started_at,
                     COALESCE(s.ended_at, s.started_at),
                     COALESCE((SELECT MAX(m.timestamp)
                                 FROM messages m
                                WHERE m.session_id = s.id${activeFilter}),
                              s.started_at)) >= ?)`,
      )
      .all(cutoffSec, cutoffSec ?? 0);

    const out = [];
    for (const row of rows) {
      const source = String(row.source || "").toLowerCase();
      if (!CLI_ACP.has(source)) continue;
      const cwd = recoverCwd(row, source);
      if (!cwd) continue;
      const startedAt = toMs(row.started_at);
      const activityAt = toMs(row.activity_at);
      out.push({
        key: `hermes:${row.id}`,
        id: row.id,
        path: dbPath(),
        cwd,
        gitRoot: null,
        gitBranch: null,
        remotes: [],
        title: row.title || null,
        startedAt,
        mtimeMs: activityAt || startedAt || 0,
        bytes: 0,
        model: row.model || null,
        extra: { sessionId: row.id, source },
      });
    }
    return out;
  } finally {
    db.close();
  }
}

/** node:sqlite truncates TEXT at a NUL, so `\x00json:` payloads must be read as BLOB. */
function sqliteText(value) {
  if (value == null) return value;
  if (typeof value === "string") return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return new TextDecoder("utf8").decode(value);
  }
  return String(value);
}

function decodeContent(content) {
  const text = sqliteText(content);
  if (typeof text !== "string") return content;
  if (!text.startsWith(JSON_PREFIX)) return text;
  const parsed = safeJsonParse(text.slice(JSON_PREFIX.length));
  return parsed == null ? text : parsed;
}

function emitTools(raw, events, idAlias) {
  const text = sqliteText(raw);
  const parsed = typeof text === "string" ? safeJsonParse(text) : text;
  if (!Array.isArray(parsed)) return;
  for (const call of parsed) {
    if (!call || typeof call !== "object") continue;
    const fn = call.function && typeof call.function === "object" ? call.function : {};
    const name = fn.name || call.name;
    let input = fn.arguments ?? call.arguments;
    if (typeof input === "string") {
      const parsedInput = safeJsonParse(input);
      if (parsedInput !== null) input = parsedInput;
    }
    const pendingId = call.id || call.call_id;
    if (call.id) idAlias.set(call.id, pendingId);
    if (call.call_id) idAlias.set(call.call_id, pendingId);
    events.push({ kind: "tool", name, input, pendingId });
  }
}

export async function read(ref) {
  const db = await openReadOnly(dbPath());
  if (!db) return { events: [], model: ref.model || null };

  try {
    const sessionId = ref.extra?.sessionId || ref.id;
    const activeFilter = activeMessageFilter(db);
    const rows = db
      .prepare(
        `SELECT role, CAST(content AS BLOB) AS content, tool_call_id, tool_calls, tool_name
           FROM messages
          WHERE session_id = ?${activeFilter}
          ORDER BY timestamp, id`,
      )
      .all(sessionId);

    const events = [];
    const idAlias = new Map();
    for (const row of rows) {
      const role = row.role;
      if (role === "session_meta") continue;
      const content = decodeContent(row.content);
      if (role === "user" || role === "assistant") {
        contentToEvents(role, content, events);
        if (role === "assistant") emitTools(row.tool_calls, events, idAlias);
        continue;
      }
      if (role === "tool") {
        events.push({
          kind: "tool-result",
          id: idAlias.get(row.tool_call_id) || row.tool_call_id,
          result: content,
          status: "completed",
        });
      }
    }
    return { events: attachToolResults(events), model: ref.model || null };
  } catch {
    return { events: [], model: ref.model || null };
  } finally {
    db.close();
  }
}
