import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { home, listDirs, readJsonFile, statOrNull } from "./shared.js";
import { openReadOnly, safeJsonParse } from "./sqlite.js";

/**
 * Cursor CLI: ~/.cursor/chats/<md5(cwd)>/<session-uuid>/{meta.json, store.db}
 *
 * The chat directory name is md5 of the cwd (verified by reproducing the digest), so a
 * live worktree can be looked up directly instead of scanning. meta.json carries the
 * exact `cwd` and timestamps.
 *
 * store.db is `blobs(id TEXT PRIMARY KEY, data BLOB)`: a content-addressed graph whose
 * index blobs are an undocumented binary format. Plain-JSON `{role, content}` message
 * blobs are readable and are what backpass uses; anything that does not parse is
 * skipped. Because the store is content-addressed there is no recorded message order,
 * so blobs are read in insertion (rowid) order - the closest available proxy.
 */

export const name = "cursor";
export const sqliteBacked = true;

export function storeRoot() {
  return home(".cursor", "chats");
}

export function cwdHash(cwd) {
  return crypto.createHash("md5").update(cwd, "utf8").digest("hex");
}

export function enumerate() {
  const out = [];
  for (const hashDir of listDirs(storeRoot())) {
    for (const sessionDir of listDirs(hashDir)) {
      const meta = path.join(sessionDir, "meta.json");
      const stat = statOrNull(meta);
      if (!stat) continue;
      out.push({ key: sessionDir, path: sessionDir, mtimeMs: stat.mtimeMs, bytes: stat.size });
    }
  }
  return out;
}

export function classify(candidate) {
  const meta = readJsonFile(path.join(candidate.path, "meta.json"));
  if (!meta?.cwd) return null;
  return {
    id: path.basename(candidate.path),
    cwd: meta.cwd,
    gitBranch: null,
    remotes: [],
    title: meta.title || null,
    startedAt: meta.createdAtMs || candidate.mtimeMs,
    model: null,
  };
}

export async function read(ref) {
  const db = await openReadOnly(path.join(ref.path, "store.db"));
  if (!db) return { events: [], model: null };

  try {
    const rows = db.prepare("SELECT data FROM blobs ORDER BY rowid").all();
    const events = [];

    for (const row of rows) {
      const text = toUtf8(row.data);
      if (!text || text[0] !== "{") continue;
      const value = safeJsonParse(text);
      if (!value || typeof value !== "object") continue;
      const role = value.role;
      if (role !== "user" && role !== "assistant") continue;
      pushContent(role, value.content, events);
    }

    return { events, model: null };
  } finally {
    db.close();
  }
}

function toUtf8(data) {
  if (typeof data === "string") return data.trim();
  if (data instanceof Uint8Array || Buffer.isBuffer(data)) return Buffer.from(data).toString("utf8").trim();
  return null;
}

function pushContent(role, content, events) {
  if (typeof content === "string") {
    if (content.trim()) events.push({ kind: "message", role, text: content });
    return;
  }
  if (!Array.isArray(content)) return;
  const texts = content
    .map((b) => (typeof b === "string" ? b : b?.text))
    .filter((t) => typeof t === "string" && t.trim());
  if (texts.length) events.push({ kind: "message", role, text: texts.join("\n") });
}

/**
 * Fast path for live worktrees: the md5 lookup finds the chat directory without
 * scanning every session on the machine.
 */
export function directoriesForCwd(cwd) {
  const dir = path.join(storeRoot(), cwdHash(cwd));
  return fs.existsSync(dir) ? listDirs(dir) : [];
}
