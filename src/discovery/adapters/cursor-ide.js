import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile } from "./shared.js";
import { openReadOnly, safeJsonParse } from "./sqlite.js";

/**
 * Cursor IDE - DEFERRED TO v1.1 (captain decision 3).
 *
 * The store is ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb:
 *   cursorDiskKV      `composerData:<id>` and `bubbleId:<composerId>:<bubbleId>` JSON
 *   composerHeaders   (composerId, workspaceId, ...) - the only repo link there is
 *
 * The repo association runs composerHeaders.workspaceId -> workspaceStorage/<id>/
 * workspace.json -> folder URI. On the machine this was designed against those
 * workspaceId rows were empty, which makes association version-dependent and
 * genuinely best-effort - hence the deferral.
 *
 * v1 ships this adapter behind --include-cursor-ide only. It never runs by default,
 * every transcript it yields is labelled tier 3, and a failure here is a warning.
 *
 * TODO(v1.1): promote to a first-class adapter once a reliable composer -> workspace
 * link exists across Cursor versions (and add Linux/Windows globalStorage paths).
 */

export const name = "cursor-ide";
export const sqliteBacked = true;
export const experimental = true;

export function storeRoot() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Cursor", "User");
  }
  return path.join(os.homedir(), ".config", "Cursor", "User");
}

function globalDbPath() {
  return path.join(storeRoot(), "globalStorage", "state.vscdb");
}

/** workspaceId -> folder path, read from workspaceStorage/<id>/workspace.json. */
function workspaceFolders() {
  const dir = path.join(storeRoot(), "workspaceStorage");
  const map = new Map();
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = readJsonFile(path.join(dir, entry.name, "workspace.json"));
    const folder = meta?.folder;
    if (typeof folder !== "string") continue;
    map.set(entry.name, decodeURIComponent(folder.replace(/^file:\/\//, "")));
  }
  return map;
}

export async function discover({ cutoffMs }) {
  const db = await openReadOnly(globalDbPath());
  if (!db) return [];

  try {
    const folders = workspaceFolders();
    let headers = [];
    try {
      headers = db.prepare("SELECT composerId, workspaceId FROM composerHeaders").all();
    } catch {
      // Older/newer Cursor builds may not have this table at all.
      return [];
    }

    const out = [];
    for (const header of headers) {
      const cwd = header.workspaceId ? folders.get(header.workspaceId) : null;
      if (!cwd) continue; // No usable repo link - the deferral in one line.
      const row = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(`composerData:${header.composerId}`);
      const data = row ? safeJsonParse(row.value) : null;
      const updatedAt = data?.lastUpdatedAt || data?.createdAt || 0;
      if (cutoffMs && updatedAt && updatedAt < cutoffMs) continue;

      out.push({
        key: `cursor-ide:${header.composerId}`,
        id: header.composerId,
        path: globalDbPath(),
        cwd,
        remotes: [],
        startedAt: data?.createdAt || null,
        mtimeMs: updatedAt,
        bytes: 0,
        model: null,
        experimental: true,
        extra: { composerId: header.composerId },
      });
    }
    return out;
  } finally {
    db.close();
  }
}

export async function read(ref) {
  const db = await openReadOnly(globalDbPath());
  if (!db) return { events: [], model: null };

  try {
    const composerId = ref.extra?.composerId || ref.id;
    const rows = db
      .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY key")
      .all(`bubbleId:${composerId}:%`);

    const events = [];
    for (const row of rows) {
      const bubble = safeJsonParse(row.value);
      if (!bubble) continue;
      const role = bubble.type === 1 ? "user" : "assistant";
      const text = bubble.text || bubble.richText || "";
      if (typeof text === "string" && text.trim()) events.push({ kind: "message", role, text });
    }
    return { events, model: null };
  } finally {
    db.close();
  }
}
