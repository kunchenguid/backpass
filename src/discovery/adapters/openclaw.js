import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";

import { interactionSignals } from "../../interaction.js";
import { warn, terminalSafe } from "../../logger.js";
import { runCapture } from "../../subprocess.js";
import { SELF_SESSION_SENTINEL } from "../../sentinel.js";
import { home, contentToEvents, attachToolResults } from "./shared.js";
import { openReadOnly } from "./sqlite.js";

/**
 * OpenClaw schema 23: ONLY online backup snapshots, never the live agent DB.
 * One private snapshot is shared until CLI completion (exit is a cleanup backstop).
 * Windows use the active branch index; deleted/reset archives contain JSONL, optionally
 * zstd. Times are milliseconds. Every generation, live or archived, is identified by
 * session_id plus a digest of its anchor (start time and first event): a live window shares
 * that anchor with its own archive, so identity survives archival and never moves as a live
 * session grows. Identity is assigned after every generation is read (`identify`), so it never
 * depends on processing order: when distinct-content generations share an anchor, the live one
 * keeps the anchor id and each archive is keyed by its generation. The only identity moves
 * left are a live member of such a collision group being archived, and a lone archive gaining
 * its first colliding sibling. Live copies win over content-equal archives, and duplicate
 * generations cannot corroborate themselves.
 * Schema/codec drift warns and skips; a damaged session cannot hide healthy sessions.
 * Metadata cwd wins, then session headers, then a labelled configured-workspace fallback.
 * Self exclusion here counts the sentinel only as the first non-wrapper content of the first user
 * message (at the very start, or right after closed leading wrappers), so a human who quotes it is
 * kept. The tradeoff: a Backpass prompt behind an unterminated wrapper is not recognised here and
 * relies on the cwd/state-dir check in `../self.js`, which Backpass-spawned sessions always hit.
 */
export const name = "openclaw";
export const sqliteBacked = true;
export const localOnly = true;
let snapshotPromise = null;
let snapshotDir = null;

export function cleanup() {
  if (snapshotDir) {
    try {
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    } catch {
      warn("openclaw: could not remove temporary snapshot directory");
    }
  }
  snapshotDir = null;
  snapshotPromise = null;
}
process.once("exit", cleanup);

function diagnostic(message) {
  warn(`openclaw: ${terminalSafe(message)}`);
}

function expandHome(value) {
  return value?.startsWith("~/") ? home(value.slice(2)) : value;
}

/** Exported so the backup boundary can be tested without invoking a live gateway. */
export async function resolveSnapshot({ run = runCapture } = {}) {
  if (process.env.BACKPASS_OPENCLAW_DB) return path.resolve(expandHome(process.env.BACKPASS_OPENCLAW_DB));
  if (!snapshotPromise) snapshotPromise = createSnapshot(run);
  return snapshotPromise;
}

async function createSnapshot(run) {
  snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-openclaw-"));
  fs.chmodSync(snapshotDir, 0o700);
  try {
    const result = await run(
      "openclaw",
      [
        "backup",
        "sqlite",
        "create",
        "--agent",
        process.env.OPENCLAW_AGENT || "main",
        "--repository",
        snapshotDir,
        "--json",
      ],
      { timeoutMs: 120_000 },
    );
    if (result.spawnError?.code === "ERR_WINDOWS_SHIM_UNSAFE_ARG") {
      throw new Error(`ERR_WINDOWS_SHIM_UNSAFE_ARG: ${result.spawnError.message}`);
    }
    if (result.timedOut) throw new Error("online backup timed out");
    if (result.spawnError?.code === "ENOENT") {
      fs.rmSync(snapshotDir, { recursive: true, force: true });
      snapshotDir = null;
      return null;
    }
    if (result.spawnError || result.code !== 0)
      throw new Error(
        `online backup failed (${result.spawnError?.code || result.code}); set BACKPASS_OPENCLAW_DB to a snapshot`,
      );
    const response = JSON.parse(result.stdout);
    const artifact = response.manifest?.artifact?.path;
    if (typeof response.snapshotPath !== "string" || typeof artifact !== "string")
      throw new Error("online backup returned no snapshot artifact");
    const file = fs.realpathSync(path.resolve(response.snapshotPath, artifact));
    const relative = path.relative(fs.realpathSync(snapshotDir), file);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
      throw new Error("online backup artifact is outside its private repository");
    return file;
  } catch (err) {
    diagnostic(`${err.message} - harness skipped`);
    // Retain the failed promise so repeated discovery does not repeatedly launch backup.
    if (snapshotDir) fs.rmSync(snapshotDir, { recursive: true, force: true });
    snapshotDir = null;
    return null;
  }
}

function stateRoot() {
  return path.resolve(expandHome(process.env.OPENCLAW_STATE_DIR) || home(".openclaw"));
}

function workspace(agent) {
  const file = path.join(stateRoot(), "openclaw.json");
  if (!fs.existsSync(file)) return path.join(stateRoot(), "workspace");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const configured =
    config.agents?.list?.find((entry) => entry.id === agent)?.workspace ?? config.agents?.defaults?.workspace;
  if (configured == null) return path.join(stateRoot(), "workspace");
  const resolved = expandHome(configured);
  if (typeof resolved !== "string" || !path.isAbsolute(resolved))
    throw new Error("configured workspace is not an absolute path");
  return resolved;
}

// Match only routing namespace tokens, never channel IDs or human text.
const EXCLUDED_NAMESPACES = [
  /(?:^|[-_])(eval|test|probe|bakeoff|smoke)(?:$|[-_])/, // Evaluation and smoke families.
  /^r\d+-routing-.*(?:^|[-_])review(?:$|[-_])/, // Routing model-review runs.
  /^pra\d+(?:$|[-_])/, // Ticket-scoped scripted runs (not just PRA-245).
  /^(explicit|internal-session-effects|child-steer-launcher)$/, // Internal test launchers.
  /^grok\d+eval(?:$|[-_])/, // Legacy eval namespace without a separator.
];

/** Typed routing wins over key heuristics; excluded namespaces always stay excluded. */
export function sessionSource(key, agent = process.env.OPENCLAW_AGENT || "main", routing = {}) {
  const prefix = `agent:${agent}:`;
  if (!key?.startsWith(prefix)) return null;
  const source = key.slice(prefix.length).split(":")[0].toLowerCase();
  if (EXCLUDED_NAMESPACES.some((pattern) => pattern.test(source))) return null;
  if (routing.created_via === "run") return "run";
  if (routing.hook_external_content_source) return "hook";
  if (routing.acp_owned) return "acp";
  if (routing.created_via === "cron") return "cron";
  if (routing.created_via === "spawn" || routing.spawned_by || routing.parent_session_key) return "subagent";
  if (
    ["channel", "operator"].includes(routing.created_via) ||
    routing.channel ||
    ["direct", "group", "channel"].includes(routing.chat_type)
  )
    return "human";
  if (/^(cron|subagent|heartbeat|acp|hooks?)(?:$|[-_])/.test(source))
    return source.split(/[-_]/)[0].replace(/^hooks$/, "hook");
  return source;
}

function cwdOf(value) {
  for (const cwd of [
    value?.workspaceDir,
    value?.cwd,
    value?.spawnedWorkspaceDir,
    value?.spawnedCwd,
    value?.systemPromptReport?.workspaceDir,
  ]) {
    if (typeof cwd === "string" && path.isAbsolute(cwd)) return cwd;
  }
  return null;
}

function decompress(blob, limit) {
  if (typeof zlib.zstdDecompressSync !== "function")
    throw new Error("zstd decompression unavailable; use a Node version with zstdDecompressSync (Node 26 recommended)");
  return zlib.zstdDecompressSync(blob, { maxOutputLength: limit }).toString("utf8");
}

function entriesFor(db, ref) {
  const { sessionId, generation } = ref.extra;
  if (generation != null) {
    const row = db
      .prepare("SELECT encoding, archive_blob FROM session_transcript_archives WHERE session_id = ? AND generation = ?")
      .get(sessionId, generation);
    if (!row) throw new Error("archive generation missing");
    if (row.encoding !== "identity" && row.encoding !== "zstd") throw new Error("unsupported archive encoding");
    if (row.archive_blob.byteLength > 128 * 1024 * 1024) throw new Error("archive exceeds 128 MiB read limit");
    const text =
      row.encoding === "zstd"
        ? decompress(row.archive_blob, 128 * 1024 * 1024)
        : Buffer.from(row.archive_blob).toString("utf8");
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }
  const active = db
    .prepare(
      `SELECT e.event_json, e.event_zstd FROM session_transcript_active_events a
    JOIN transcript_events e ON e.session_id = a.session_id AND e.seq = a.event_seq
    WHERE a.session_id = ? ORDER BY a.active_position`,
    )
    .all(sessionId)
    .map((row) => JSON.parse(row.event_json ?? decompress(row.event_zstd, 4 * 1024 * 1024)));
  // Schema 23 omits the session header from the active branch index.
  const header = db
    .prepare("SELECT event_json, event_zstd FROM transcript_events WHERE session_id = ? AND seq = 0")
    .get(sessionId);
  if (header && !active.some((entry) => entry.type === "session")) {
    const entry = JSON.parse(header.event_json ?? decompress(header.event_zstd, 4 * 1024 * 1024));
    if (entry.type === "session") active.unshift(entry);
  }
  return active;
}

/**
 * Remove complete harness wrappers; a missing terminator must not eat human words, so an
 * unterminated memory block loses only its opening tag and every character after it is kept.
 * Nothing here searches for the self sentinel: a human may quote it.
 */
export function stripScaffolding(text) {
  return text
    .replace(/<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\s*/g, "")
    .replace(/Conversation info: ⟦openclaw:ctx⟧[^\r\n]*\r?\n\s*```(?:json)?[^\r\n]*\r?\n[\s\S]*?```\s*/g, "")
    .replace(/<active_memory_plugin>[\s\S]*?<\/active_memory_plugin>\s*/g, "")
    .replace(/^\s*\[(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})? [^\]\r\n]+\]\s*/, "")
    .replace(/^\s*<active_memory_plugin>/, "");
}

function normalized(entries) {
  /** @type {any[]} */
  const events = [];
  let model = null;
  for (const entry of entries) {
    if (entry.type === "model_change") model = entry.modelId || model;
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    const role = message.role;
    if (role === "toolResult") {
      const result = Array.isArray(message.content)
        ? message.content.map((block) => (typeof block === "string" ? block : block?.text || "")).join("\n")
        : message.content;
      events.push({
        kind: "tool-result",
        id: message.toolCallId ?? message.id,
        result,
        status: message.isError ? "error" : "completed",
      });
    } else if (role === "user" || role === "assistant") {
      if (["internal_system", "inter_session"].includes(message.provenance?.kind)) continue;
      if (role === "assistant") model = message.model || model;
      const before = events.length;
      contentToEvents(role, message.content, events);
      for (const event of events.slice(before)) {
        if (event.kind !== "message") continue;
        // The shared helper trims array text; preserve OpenClaw's actual words/spacing.
        if (Array.isArray(message.content)) {
          event.text = message.content
            .filter((block) => typeof block === "string" || block?.type === "text")
            .map((block) => (typeof block === "string" ? block : block.text))
            .join("\n");
        }
        if (role === "user") event.text = stripScaffolding(event.text);
      }
    }
  }
  return { events: attachToolResults(events.filter((event) => event.kind !== "message" || event.text.trim())), model };
}

/**
 * Assign ids to one session_id's distinct-content generations from the whole set, never from
 * processing order: `${session_id}:${sha256(anchor)}`, except that archives sharing an anchor with
 * another generation are keyed by `${anchor}\n${generation}` while the live window keeps the anchor id.
 */
function identify(sessionId, generations) {
  const digest = (text) => createHash("sha256").update(text).digest("hex");
  const byAnchor = new Map();
  for (const generation of generations) {
    if (!byAnchor.has(generation.anchor)) byAnchor.set(generation.anchor, []);
    byAnchor.get(generation.anchor).push(generation);
  }
  for (const [anchor, group] of byAnchor) {
    for (const { record } of group) {
      const keyed = group.length > 1 && record.extra.generation != null;
      record.id = `${sessionId}:${digest(keyed ? `${anchor}\n${String(record.extra.generation)}` : anchor)}`;
      record.key = `openclaw:${record.id}`;
    }
  }
}

/** @param {{ cutoffMs?: number }} [options] */
export async function discover({ cutoffMs } = {}) {
  let db;
  try {
    const file = await resolveSnapshot();
    if (!file) return [];
    db = await openReadOnly(file);
    if (!db) throw new Error("snapshot missing; set BACKPASS_OPENCLAW_DB to an existing backup database.sqlite");
    const agent = process.env.OPENCLAW_AGENT || "main";
    let fallback = path.join(stateRoot(), "workspace");
    try {
      fallback = workspace(agent);
    } catch (err) {
      diagnostic(`workspace config unreadable (${err.message}); using default workspace`);
    }
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version !== 23)
      diagnostic(`snapshot schema version ${version} differs from tested version 23; reading supported columns`);
    const nodeColumns = new Set(
      db
        .prepare("PRAGMA table_info(session_nodes)")
        .all()
        .map((column) => column.name),
    );
    const windowColumns = new Set(
      db
        .prepare("PRAGMA table_info(session_windows)")
        .all()
        .map((column) => column.name),
    );
    const routingColumns = ["created_via", "spawned_by", "parent_session_key"]
      .map((column) => {
        const node = nodeColumns.has(column) ? `n.${column}` : "NULL";
        const window = windowColumns.has(column) ? `w.${column}` : "NULL";
        return `COALESCE(${node}, ${window}) AS ${column}`;
      })
      .join(", ");
    const live = db
      .prepare(
        `SELECT w.*, n.entry_json, ${routingColumns} FROM session_windows w LEFT JOIN session_nodes n
      ON n.session_key = w.session_key AND n.current_session_id = w.session_id`,
      )
      .all();
    const archives = db
      .prepare(
        "SELECT session_id, generation, session_key, created_at FROM session_transcript_archives ORDER BY created_at, generation",
      )
      .all();
    const sessions = new Map();
    const errors = new Map();
    for (const row of [...archives, ...live]) {
      const source = sessionSource(row.session_key, agent, row);
      if (source == null) continue;
      const extra = {
        sessionId: row.session_id,
        generation: row.generation ?? null,
        sessionKey: row.session_key,
        agent,
        cwdSource: "configured-workspace",
      };
      try {
        const entries = entriesFor(db, { extra });
        if (!entries.length) continue;
        const metadata = row.entry_json ? JSON.parse(row.entry_json) : null;
        const header = entries.find((entry) => entry.type === "session");
        const metadataCwd = cwdOf(metadata);
        const candidateCwd = cwdOf(header);
        const headerCwd = candidateCwd && path.resolve(candidateCwd) !== stateRoot() ? candidateCwd : null;
        extra.cwdSource = metadataCwd ? "session-metadata" : headerCwd ? "event-header" : "configured-workspace";
        const times = entries
          .map((entry) => (typeof entry.timestamp === "number" ? entry.timestamp : Date.parse(entry.timestamp)))
          .filter(Number.isFinite);
        const startedAt = times[0] ?? row.created_at;
        const mtimeMs =
          row.generation != null && times.length
            ? Math.max(...times)
            : Math.max(row.updated_at || row.created_at, ...times);
        const { events, model } = normalized(entries);
        const firstUser = events.find((event) => event.kind === "message" && event.role === "user");
        if (firstUser?.text.startsWith(SELF_SESSION_SENTINEL)) continue;
        const digest = createHash("sha256").update(JSON.stringify(events)).digest("hex");
        if (!sessions.has(row.session_id)) sessions.set(row.session_id, new Map());
        const generations = sessions.get(row.session_id);
        // The live copy wins over content-equal archives; duplicate archives keep the first read.
        if (generations.has(digest) && row.generation != null) continue;
        generations.set(digest, {
          anchor: `${String(startedAt)}\n${String(JSON.stringify(events[0]))}`,
          record: {
            key: null,
            id: null,
            path: file,
            cwd: metadataCwd || headerCwd || fallback,
            gitRoot: null,
            gitBranch: null,
            remotes: [],
            title: null,
            startedAt,
            mtimeMs,
            bytes: 0,
            model,
            extra,
            interactionSignals: interactionSignals({ source }),
          },
        });
      } catch (err) {
        errors.set(err.message, (errors.get(err.message) || 0) + 1);
      }
    }
    for (const [message, count] of errors) diagnostic(`${count} session(s) skipped (${message})`);
    const out = [];
    for (const [sessionId, generations] of sessions) {
      // Identity is resolved over every generation before --since so the window cannot rename one.
      identify(sessionId, [...generations.values()]);
      for (const { record } of generations.values())
        if (cutoffMs == null || record.mtimeMs >= cutoffMs) out.push(record);
    }
    return out;
  } catch (err) {
    diagnostic(`snapshot unreadable (${err.message}) - harness skipped`);
    return [];
  } finally {
    db?.close();
  }
}

export async function read(ref) {
  let db;
  try {
    db = await openReadOnly(ref.path);
    if (!db) throw new Error("snapshot missing");
    return normalized(entriesFor(db, ref));
  } catch (err) {
    diagnostic(`session unreadable (${err.message}) - session skipped`);
    return { events: [], model: ref.model || null };
  } finally {
    db?.close();
  }
}
