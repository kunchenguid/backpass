import fs from "node:fs";

import { SELF_SESSION_SENTINEL } from "../prompts.js";

/**
 * Self-session exclusion.
 *
 * backpass's own model calls run through acpx with `--cwd <repo root>`, so the harness
 * files each one in its normal store under this repo's cwd - a tier-1 exact match for
 * discovery. Left alone, the next run would analyze backpass talking to itself (and a
 * synthesis session quotes the memory file verbatim, so the "evidence" would be
 * backpass's own text). Every prompt backpass writes begins with
 * `SELF_SESSION_SENTINEL`; a transcript whose first user message starts with it is
 * backpass's and is dropped here, before sampling, so it never takes a slot or a
 * model call.
 *
 * The check reads only the head of the file and keys on the JSON-encoded user text as
 * every file-backed harness records it (`"text":"..."` / `"content":"..."` /
 * `"message":"..."`). SQLite-backed stores (opencode, hermes, cursor IDE) have no file to
 * inspect and acpx does not drive them, so they are passed through.
 */

const HEAD_BYTES = 256 * 1024;

const SENTINEL_PATTERN = new RegExp(`"(?:text|content|message)":"${escapeRegExp(jsonInner(SELF_SESSION_SENTINEL))}`);

function jsonInner(text) {
  return JSON.stringify(text).slice(1, -1);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `text` (the head of a transcript file) opens a user message with the sentinel. */
export function headHasSelfSentinel(text) {
  return SENTINEL_PATTERN.test(text || "");
}

/**
 * @param {{ path?: string | null }} transcript
 * @returns {boolean}
 */
export function isSelfSession(transcript) {
  const file = transcript?.path;
  if (!file) return false;
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return false;
    const length = Math.min(stat.size, HEAD_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, 0);
    return headHasSelfSentinel(buffer.toString("utf8"));
  } catch {
    // Unreadable here means unreadable for the adapter too; let the adapter report it.
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
