import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

import * as claude from "../adapters/claude.js";
import * as codex from "../adapters/codex.js";
import * as pi from "../adapters/pi.js";
import * as grok from "../adapters/grok.js";
import * as opencode from "../adapters/opencode.js";
import * as hermes from "../adapters/hermes.js";
import * as cursorCli from "../adapters/cursor-cli.js";
import * as cursorIde from "../adapters/cursor-ide.js";

import { isSelfSession } from "../self.js";
import { collectPathFacts } from "./git-facts.js";
import { encodeEndFrame, encodeFrameHeader, PROTOCOL } from "./frames.js";
import { supportsNodeSqlite } from "./runtime.js";

/**
 * The program that runs on a remote host (design section 6.3).
 *
 * It is backpass's own adapters, shipped over stdin by `./bundle.js` and run once in a
 * temp directory the loader removes again. That is the whole point of the shipped-probe
 * transport: the adapter that reads a store is always the same version as the caller,
 * nothing is installed on the remote, and nothing persists there.
 *
 * Two operations, both read-only:
 *
 *   discover  every session in the window, plus the filesystem/git facts about each
 *             session's cwd - computed here, because only here are those paths real.
 *   fetch     the named sessions' content, as a framed stream: the raw transcript file
 *             for file-backed stores (so the raw-transcript escape hatch survives the
 *             trip) and the adapter's normalized events for SQLite stores, which have
 *             no per-session file to send.
 *
 * Nothing variable reaches the remote shell: the request arrives inside the payload, so
 * quoting cannot bite. Every import here must be in `PROBE_MANIFEST`; `test/remote-bundle.test.js`
 * runs this file from a directory holding only the manifest to keep that true.
 */

export { PROTOCOL };

const ADAPTERS = {
  claude,
  codex,
  pi,
  grok,
  opencode,
  hermes,
  cursor: cursorCli,
  "cursor-ide": cursorIde,
};

function rawPathOf(adapter, ref) {
  return adapter.rawPath ? adapter.rawPath(ref) : ref.path;
}

function fetchKind(adapter) {
  return adapter.sqliteBacked ? "events" : "raw";
}

function eventSignature(result) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([result.events || [], result.model || null]), "utf8")
    .digest("hex");
}

async function descriptorFrom(adapter, row, id) {
  const contentSignature = adapter.sqliteBacked ? eventSignature(await adapter.read(row)) : null;
  return {
    harness: adapter.name,
    kind: fetchKind(adapter),
    key: row.key ?? row.path,
    id,
    path: row.path,
    cwd: row.cwd || null,
    gitRoot: row.gitRoot || null,
    gitBranch: row.gitBranch || null,
    remotes: Array.isArray(row.remotes) ? row.remotes : [],
    title: row.title || null,
    startedAt: row.startedAt || null,
    mtimeMs: row.mtimeMs || 0,
    bytes: row.bytes || 0,
    contentSignature,
    model: row.model || null,
    extra: row.extra || {},
    interactionSignals: row.interactionSignals ?? row.extra?.interactionSignals ?? {},
    /** The file the raw fetch sends and the trace footer names; unused for SQLite stores. */
    rawPath: row.path,
  };
}

async function discoverHarness(adapter, { cutoffMs }) {
  const stats = { scanned: 0, classified: 0, self: 0, error: null };
  const out = [];

  if (adapter.discover) {
    for (const row of await adapter.discover({ cutoffMs })) {
      stats.scanned += 1;
      stats.classified += 1;
      out.push(await descriptorFrom(adapter, row, row.id));
    }
    return { stats, descriptors: out };
  }

  for (const candidate of adapter.enumerate({ cutoffMs })) {
    if (cutoffMs && candidate.mtimeMs < cutoffMs) continue;
    stats.scanned += 1;
    const classified = adapter.classify(candidate);
    if (!classified) continue;
    stats.classified += 1;
    const merged = { ...candidate, ...classified };
    const descriptor = await descriptorFrom(adapter, merged, classified.id);
    descriptor.rawPath = rawPathOf(adapter, merged);
    // backpass's own acpx sessions are filed under the repo cwd on whichever machine ran
    // them; drop a remote one here so it never crosses the wire, let alone the corpus.
    if (!adapter.sqliteBacked && isSelfSession({ path: descriptor.rawPath })) {
      stats.self += 1;
      continue;
    }
    out.push(descriptor);
  }
  return { stats, descriptors: out };
}

/** @param {{ harnesses?: string[], cutoffMs?: number | null }} request */
export async function discover({ harnesses = [], cutoffMs = null } = {}) {
  const harnessStats = {};
  const descriptors = [];
  const warnings = [];
  let selected = harnesses;
  if (!supportsNodeSqlite(process.version)) {
    const dropped = harnesses.filter((harness) => ADAPTERS[harness]?.sqliteBacked);
    selected = harnesses.filter((harness) => !ADAPTERS[harness]?.sqliteBacked);
    if (dropped.length) warnings.push(`${dropped.join(", ")} skipped: node ${process.version} lacks node:sqlite`);
  }

  for (const harness of selected) {
    const adapter = ADAPTERS[harness];
    if (!adapter) {
      harnessStats[harness] = { scanned: 0, classified: 0, self: 0, error: "no adapter" };
      continue;
    }
    try {
      const result = await discoverHarness(adapter, { cutoffMs });
      harnessStats[harness] = result.stats;
      descriptors.push(...result.descriptors);
    } catch (err) {
      // Fail-soft per store, exactly as locally: an unreadable store is one named row,
      // never a failed host.
      harnessStats[harness] = { scanned: 0, classified: 0, self: 0, error: err.message };
    }
  }

  const paths = new Set();
  for (const descriptor of descriptors) {
    if (descriptor.cwd) paths.add(descriptor.cwd);
    if (descriptor.gitRoot) paths.add(descriptor.gitRoot);
  }
  const facts = collectPathFacts(paths, { git: hasGit() });
  if (!hasGit()) warnings.push("git is not on this host's non-interactive PATH");

  return {
    protocol: PROTOCOL,
    node: process.version,
    platform: process.platform,
    hostname: os.hostname(),
    home: os.homedir(),
    harnesses: harnessStats,
    transcripts: descriptors,
    paths: facts,
    warnings,
  };
}

/** git is optional: without it tiers 1.5 and 2 cannot be judged, but liveness still can. */
let gitAvailable = null;
function hasGit() {
  if (gitAvailable === null) {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      gitAvailable = true;
    } catch {
      gitAvailable = false;
    }
  }
  return gitAvailable;
}

function writeAll(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * @param {{ items?: object[] }} request
 * @param {{ stdout?: NodeJS.WritableStream }} [options]
 */
export async function fetchTranscripts({ items = [] } = {}, { stdout = process.stdout } = {}) {
  for (const item of items) {
    const adapter = ADAPTERS[item.harness];
    let header;
    let body;
    try {
      if (!adapter) throw new Error(`no adapter for harness ${item.harness}`);
      if (fetchKind(adapter) === "raw") {
        const file = rawPathOf(adapter, item);
        body = fs.readFileSync(file);
        header = { key: item.key, harness: item.harness, kind: "raw", bytes: body.length, mtimeMs: mtimeOf(file) };
      } else {
        const result = await adapter.read(item);
        body = Buffer.from(JSON.stringify({ events: result.events || [], model: result.model || null }), "utf8");
        header = {
          key: item.key,
          harness: item.harness,
          kind: "events",
          bytes: body.length,
          mtimeMs: item.mtimeMs ?? null,
          contentSignature: eventSignature(result),
          model: result.model || null,
        };
      }
    } catch (err) {
      header = { key: item.key, harness: item.harness, kind: "error", bytes: 0, error: err.message };
      body = Buffer.alloc(0);
    }
    await writeAll(stdout, encodeFrameHeader(header));
    if (body.length) await writeAll(stdout, body);
  }
  await writeAll(stdout, encodeEndFrame());
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** The loader's entry point: one request in, one response on stdout. */
export async function main(request, { stdout = process.stdout } = {}) {
  if (request?.op === "fetch") {
    await fetchTranscripts(request, { stdout });
    return;
  }
  const response = await discover(request || {});
  await writeAll(stdout, Buffer.from(`${JSON.stringify(response)}\n`, "utf8"));
}
