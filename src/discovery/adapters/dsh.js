import fs from "node:fs";
import path from "node:path";
import * as zlib from "node:zlib";

import { emptyInteractionSignals } from "../../interaction.js";
import { attachToolResults, contentToEvents, home, listDirs, statOrNull } from "./shared.js";
import { headHasSelfSentinel } from "../self.js";

/**
 * dsh: ~/.dsh/sessions/<encoded-cwd>/<session-dir>/session.v4.jsonl.zstd
 *
 * The session file is an append-only sequence of zstd frames, each holding JSONL
 * records. Node's one-shot zstd helper stops at the first frame, so this adapter walks
 * the frame headers itself and decompresses each complete frame. A torn final frame is
 * left unread instead of failing the store.
 *
 * The header record carries the exact cwd, id, and creation time; the directory name is
 * only a lossy fallback for a readable file whose header frame is damaged. Discovery is
 * opt-in through `discovery.includeDsh`, mirroring the OMP store setting.
 *
 * Records seen in the v4 stream: a `session` header; `user/message` and
 * `assistant/message` conversation records; `tool/call` and `tool/result` events; and
 * `request/context` / `request/header` records that name the active model. Insight
 * records such as reasoning are dropped by the shared content reader.
 */

export const name = "dsh";

export function storeRoot() {
  return home(".dsh", "sessions");
}

/** @param {{ config?: { discovery?: { includeDsh?: boolean } } }} [options] */
export function enumerate({ config } = {}) {
  if (config?.discovery?.includeDsh !== true) return [];
  const out = [];
  for (const cwdDir of listDirs(storeRoot())) {
    for (const sessionDir of listDirs(cwdDir)) {
      const file = path.join(sessionDir, "session.v4.jsonl.zstd");
      const stat = statOrNull(file);
      if (!stat) continue;
      out.push({
        key: sessionDir,
        path: file,
        sessionDir,
        mtimeMs: stat.mtimeMs,
        bytes: stat.size,
      });
    }
  }
  return out;
}

export function classify(candidate) {
  const entries = readEntries(candidate.path);
  if (!entries.length) return null;

  const sessionDir = candidate.sessionDir || path.dirname(candidate.path);
  const header = entries.find((entry) => entry.type === "session" && typeof entry.cwd === "string" && entry.cwd);
  const cwd = header?.cwd || decodeDirName(path.basename(path.dirname(sessionDir)));
  if (!cwd) return null;

  const id = header?.id || path.basename(sessionDir);
  const title = entries.find((entry) => entry.type === "session/title")?.data?.title || null;
  const firstUser = entries.find((entry) => entry.type === "user/message");
  const firstUserContent = firstUser?.data?.content ?? firstUser?.data?.message?.content;

  return {
    id: String(id).replace(/^session-/, ""),
    cwd,
    gitBranch: null,
    remotes: [],
    startedAt: Number.isFinite(header?.createdAt) ? header.createdAt : candidate.mtimeMs,
    title,
    model: null,
    self: firstUserContent ? headHasSelfSentinel(JSON.stringify(firstUserContent)) : false,
    interactionSignals: emptyInteractionSignals(),
  };
}

export function read(ref) {
  const entries = readEntries(ref.path);
  const events = [];
  let model = null;

  for (const entry of entries) {
    switch (entry.type) {
      case "request/context":
        model = model || entry.data?.model || null;
        break;
      case "request/header":
        model = model || entry.data?.header?.config?.model || null;
        break;
      case "user/message":
        contentToEvents("user", entry.data?.content ?? entry.data?.message?.content, events);
        break;
      case "assistant/message": {
        const message = entry.data?.message;
        model = model || message?.source?.model || null;
        contentToEvents("assistant", message?.content, events);
        break;
      }
      case "tool/call":
        events.push({
          kind: "tool",
          name: entry.data?.name,
          input: parseMaybeJson(entry.data?.arguments ?? entry.data?.input),
          pendingId: entry.data?.callId ?? entry.data?.id,
        });
        break;
      case "tool/result":
        events.push({
          kind: "tool-result",
          id: entry.data?.toolCallId ?? entry.data?.callId,
          result: textOf(entry.data?.content ?? entry.data?.message?.content),
        });
        break;
      default:
        break;
    }
  }

  return { events: attachToolResults(events), model };
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content
    .map((block) => (typeof block === "string" ? block : (block?.text ?? "")))
    .filter(Boolean)
    .join("\n");
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** A readable fallback for the encoded `--Users-name-repo--` directory layout. */
function decodeDirName(encoded) {
  if (typeof encoded !== "string" || !encoded.startsWith("--") || !encoded.endsWith("--")) return null;
  const body = encoded.slice(2, -2);
  if (!body) return null;
  return process.platform === "win32" ? body.replaceAll("-", "\\") : `/${body.replaceAll("-", "/")}`;
}

function readEntries(file) {
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch {
    return [];
  }

  const text = decompressFrames(buffer);
  if (!text) return [];

  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A partial line at a frame boundary is not a record.
    }
  }
  return entries;
}

/**
 * Decompress a concatenated zstd stream. The frame walker is deliberately strict about
 * what it accepts and simply stops at the first incomplete or malformed frame, so a
 * session that was still being appended to when it was read loses only the tail.
 */
function decompressFrames(buffer) {
  const chunks = [];
  for (const frame of frameRanges(buffer)) {
    try {
      chunks.push(zlib.zstdDecompressSync(frame));
    } catch {
      // A corrupt frame is skipped; later complete frames may still be readable.
    }
  }
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
}

const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_SKIPPABLE_MASK = 0xfffffff0;
const ZSTD_SKIPPABLE_MAGIC = 0x184d2a50;

function frameRanges(buffer) {
  const ranges = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const magic = buffer.readUInt32LE(offset);
    if ((magic & ZSTD_SKIPPABLE_MASK) === ZSTD_SKIPPABLE_MAGIC) {
      if (offset + 8 > buffer.length) break;
      const size = buffer.readUInt32LE(offset + 4);
      if (offset + 8 + size > buffer.length) break;
      offset += 8 + size;
      continue;
    }
    if (magic !== ZSTD_MAGIC) break;
    const end = frameEnd(buffer, offset);
    if (end === null) break;
    ranges.push(buffer.subarray(offset, end));
    offset = end;
  }
  return ranges;
}

/** @returns {number | null} the byte after a complete frame, or null when it is torn. */
function frameEnd(buffer, offset) {
  if (offset + 5 > buffer.length) return null;
  const descriptor = buffer[offset + 4];
  if (descriptor & 0x08) return null;

  const contentSizeFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const checksum = (descriptor >> 2) & 1;
  const dictionaryFlag = descriptor & 3;

  let cursor = offset + 5;
  if (!singleSegment) cursor += 1;
  cursor += [0, 1, 2, 4][dictionaryFlag];
  cursor += contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][contentSizeFlag];
  if (cursor > buffer.length) return null;

  while (true) {
    if (cursor + 3 > buffer.length) return null;
    const blockHeader = buffer.readUIntLE(cursor, 3);
    cursor += 3;
    const last = blockHeader & 1;
    const type = (blockHeader >> 1) & 3;
    const size = blockHeader >> 3;
    if (type === 3) return null;
    if (type === 0 || type === 2) {
      if (cursor + size > buffer.length) return null;
      cursor += size;
    } else {
      if (cursor + 1 > buffer.length) return null;
      cursor += 1;
    }
    if (last) break;
  }

  if (checksum) {
    if (cursor + 4 > buffer.length) return null;
    cursor += 4;
  }
  return cursor;
}
