import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { redact } from "./redact.js";

/** Pi tool exposed only for the transcript currently being analyzed. */
export const TRANSCRIPT_INSPECTOR_TOOL = "backpass_inspect_transcript";

/** Large sessions use the bounded inspector instead of exposing their raw path. */
export const LARGE_TRANSCRIPT_BYTES = 64 * 1024;

/** Hard cap for one inspector response. */
export const INSPECTOR_CALL_BYTES = 8 * 1024;

/** Hard cap for all inspector responses in one model session. */
export const INSPECTOR_SESSION_BYTES = 64 * 1024;

/** Hard cap for repeated lookup turns in one model session. */
export const INSPECTOR_SESSION_CALLS = 6;

const MAX_MATCHES = 8;
const MAX_CONTEXT_TURNS = 2;
const MAX_QUERY_CHARS = 400;
const MANIFEST_VERSION = 1;

/** @typedef {{ index: number, turn: number, kind: "message" | "tool", role?: string, name?: string, text: string }} TranscriptRecord */

/** @returns {{ calls: number, usedBytes: number }} */
export function createInspectorState() {
  return { calls: 0, usedBytes: 0 };
}

/**
 * Make a private, normalized search manifest for one transcript. The model never receives
 * the source path. The manifest is removed when the corresponding Pi invocation closes.
 *
 * @param {{ events: Array<Record<string, unknown>>, ref: string }} options
 */
export function createTranscriptInspector({ events, ref }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-transcript-inspector-"));
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = {
    version: MANIFEST_VERSION,
    ref: opaqueReference(ref),
    records: normalizeEvents(events),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });

  return {
    manifestPath,
    ref: manifest.ref,
    dispose() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** @param {unknown} ref */
function opaqueReference(ref) {
  return `transcript-${crypto
    .createHash("sha256")
    .update(String(ref || "transcript"), "utf8")
    .digest("hex")
    .slice(0, 16)}`;
}

/** @param {string} manifestPath */
export function readInspectorManifest(manifestPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (
      !manifest ||
      manifest.version !== MANIFEST_VERSION ||
      typeof manifest.ref !== "string" ||
      !Array.isArray(manifest.records)
    ) {
      throw new Error("invalid manifest shape");
    }
    return manifest;
  } catch (error) {
    throw new Error(`could not load transcript inspector manifest: ${error.message}`, { cause: error });
  }
}

/**
 * Search the normalized manifest and return bounded exact excerpts. This function is used
 * by the Pi extension and directly by tests so the byte budget is enforced in one place.
 *
 * @param {{ ref: string, records: TranscriptRecord[] }} manifest
 * @param {{ query?: unknown, role?: unknown, contextTurns?: unknown, maxMatches?: unknown, maxChars?: unknown }} params
 * @param {{ calls: number, usedBytes: number }} state
 */
export function inspectTranscript(manifest, params, state) {
  const query = typeof params?.query === "string" ? params.query.trim().slice(0, MAX_QUERY_CHARS) : "";
  if (!query) return errorResult("A non-empty query is required.", state);

  const role = params?.role === "user" || params?.role === "assistant" || params?.role === "tool" ? params.role : null;
  const contextTurns = clampInteger(params?.contextTurns, 0, MAX_CONTEXT_TURNS, 0);
  const maxMatches = clampInteger(params?.maxMatches, 1, MAX_MATCHES, MAX_MATCHES);
  const requestedBytes = clampInteger(params?.maxChars, 512, INSPECTOR_CALL_BYTES, INSPECTOR_CALL_BYTES);
  const remainingBytes = INSPECTOR_SESSION_BYTES - state.usedBytes;
  if (state.calls >= INSPECTOR_SESSION_CALLS) {
    return errorResult(
      `Transcript inspection limit reached after ${state.calls} call(s). Do not call this tool again; continue with the distilled trace.`,
      state,
    );
  }
  if (remainingBytes <= 0) {
    return errorResult(
      `Transcript inspection budget exhausted after ${state.calls} call(s). Continue with the distilled trace.`,
      state,
    );
  }

  const queryLower = query.toLowerCase();
  const matches = manifest.records
    .filter(
      (record) => (!role || (record.role || record.kind) === role) && record.text.toLowerCase().includes(queryLower),
    )
    .slice(0, maxMatches);
  const relevant = collectRelevantRecords(manifest.records, matches, contextTurns);
  const body = [
    `Transcript ${manifest.ref}`,
    `query: ${JSON.stringify(query)}${role ? ` · role: ${role}` : ""}`,
    matches.length ? `matches: ${matches.length}` : "matches: 0",
    "",
    ...(matches.length
      ? relevant.map((record) =>
          formatRecord(
            record,
            query,
            matches.some((match) => match.index === record.index),
          ),
        )
      : ["No matching transcript events. Try a narrower or different query."]),
  ].join("\n");

  return successResult(body, state, requestedBytes, {
    query,
    role,
    matches: matches.length,
    contextTurns,
  });
}

/** @param {Array<Record<string, unknown>>} events @returns {TranscriptRecord[]} */
function normalizeEvents(events) {
  /** @type {TranscriptRecord[]} */
  const records = [];
  let turn = 0;
  let index = 0;

  for (const event of Array.isArray(events) ? events : []) {
    if (event?.kind === "message") {
      const text = String(redact(String(event.text ?? ""))).trim();
      if (!text) continue;
      turn += 1;
      records.push({
        index: index++,
        turn,
        kind: "message",
        role: event.role === "user" ? "user" : "assistant",
        text,
      });
      continue;
    }

    if (event?.kind !== "tool") continue;
    const input = String(redact(stringify(event.input)));
    const result = String(redact(stringify(event.result)));
    const text = [input ? `input: ${input}` : "", result ? `result: ${result}` : ""].filter(Boolean).join("\n");
    if (!text && !event.name) continue;
    records.push({
      index: index++,
      turn,
      kind: "tool",
      role: "tool",
      name: String(event.name || "unknown"),
      text,
    });
  }

  return records;
}

/** @param {unknown} value */
function stringify(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** @param {TranscriptRecord[]} records @param {TranscriptRecord[]} matches @param {number} contextTurns */
function collectRelevantRecords(records, matches, contextTurns) {
  const selected = new Map(matches.map((record) => [record.index, record]));
  if (contextTurns === 0) return [...selected.values()].sort((a, b) => a.index - b.index);

  for (const match of matches) {
    for (const record of records) {
      if (Math.abs(record.turn - match.turn) <= contextTurns) selected.set(record.index, record);
    }
  }
  return [...selected.values()].sort((a, b) => a.index - b.index);
}

/** @param {TranscriptRecord} record @param {string} query @param {boolean} matched */
function formatRecord(record, query, matched) {
  const label = `${record.kind}${record.role ? ` · ${record.role}` : ""}${record.name ? ` · ${record.name}` : ""}`;
  const excerpt = matched ? excerptAround(record.text, query, 2600) : record.text.slice(0, 500);
  return `[event ${record.index} · turn ${record.turn || 0} · ${label}]\n${excerpt}`;
}

/** @param {string} text @param {string} query @param {number} limit */
function excerptAround(text, query, limit) {
  if (text.length <= limit) return text;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return `${text.slice(0, limit)}...`;
  const context = Math.floor((limit - query.length) / 2);
  const start = Math.max(0, at - context);
  const end = Math.min(text.length, start + limit);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

/** @param {string} value @param {number} maxBytes */
function clipUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "\n[... inspector response capped ...]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (maxBytes <= suffixBytes) return utf8Prefix(value, Math.max(0, maxBytes));
  const budget = maxBytes - suffixBytes;
  return `${utf8Prefix(value, budget)}${suffix}`;
}

/** @param {string} value @param {number} maxBytes */
function utf8Prefix(value, maxBytes) {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

/** @param {unknown} value @param {number} min @param {number} max @param {number} fallback */
function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** @param {string} text @param {{ calls: number, usedBytes: number }} state */
function errorResult(text, state) {
  return {
    content: [{ type: "text", text }],
    details: {
      error: true,
      calls: state.calls,
      usedBytes: state.usedBytes,
      remainingBytes: Math.max(0, INSPECTOR_SESSION_BYTES - state.usedBytes),
    },
  };
}

/** @param {string} body @param {{ calls: number, usedBytes: number }} state @param {number} requestedBytes @param {Record<string, unknown>} details */
function successResult(body, state, requestedBytes, details) {
  const maxBytes = Math.min(requestedBytes, INSPECTOR_SESSION_BYTES - state.usedBytes);
  const text = clipUtf8(body, maxBytes);
  const usedBytes = Buffer.byteLength(text, "utf8");
  state.calls += 1;
  state.usedBytes += usedBytes;
  return {
    content: [{ type: "text", text }],
    details: {
      ...details,
      calls: state.calls,
      usedBytes: state.usedBytes,
      remainingBytes: Math.max(0, INSPECTOR_SESSION_BYTES - state.usedBytes),
    },
  };
}
