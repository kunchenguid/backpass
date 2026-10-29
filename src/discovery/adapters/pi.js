import fs from "node:fs";
import path from "node:path";

import { emptyInteractionSignals } from "../../interaction.js";
import {
  attachToolResults,
  contentToEvents,
  home,
  listDirs,
  listFiles,
  parseJsonLine,
  readHeadLines,
  readJsonl,
  statOrNull,
} from "./shared.js";

/**
 * Pi writes standalone sessions under
 * `~/.pi/agent/sessions/<escaped-cwd>/<ISO-ts>_<uuid>.jsonl`. omp (Oh My Pi) uses the
 * same JSONL shape under `~/.omp/agent/sessions/` (opt-in via `discovery.includeOmp`)
 * and honors `PI_CODING_AGENT_DIR`, but
 * prepends a fixed-width `{type:"title"}` record, so the `{type:"session", cwd, id}`
 * entry is line 2 there. Only the opt-in OMP store gets the title and nested handling
 * below; every other store is read one level deep with a line-1 header, as before.
 * omp also writes subagent transcripts one level deeper, at
 * `<escaped-cwd>/<session-id>/<Name>.jsonl`, and their own subagents at
 * `<escaped-cwd>/<session-id>/<Name>/<Name>.<Child>.jsonl`. Ancestor headers establish
 * observer provenance; nested layout alone marks automation. BB's Pi bridge writes the
 * same JSONL shape directly under `<bb-data-dir>/pi-bridge-sessions/`.
 *
 * Entries form a parent/child tree but arrive in order, so a linear read is faithful.
 * `model_change` / `thinking_level_change` records give the model actually used
 * (`modelId` on pi, `model` on omp). No remote is recorded - dead worktrees reach tier 3
 * only.
 */

export const name = "pi";

const SUBAGENT_DEPTH = 2;

export function storeRoot() {
  return home(".pi", "agent", "sessions");
}

function expandEnvPath(value) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed === "~") return home();
  if (trimmed.startsWith("~/")) return path.join(home(), trimmed.slice(2));
  return path.resolve(trimmed);
}

function realpathOrResolve(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function storeSpecs(config) {
  const specs = [
    { path: storeRoot(), direct: false, nested: true },
    { path: home(".bb", "pi-bridge-sessions"), direct: true, nested: false },
  ];
  if (config?.discovery?.includeOmp === true) {
    specs.push({ path: home(".omp", "agent", "sessions"), direct: false, nested: true, omp: true });
  }
  const piAgentDir = expandEnvPath(process.env.PI_CODING_AGENT_DIR);
  if (piAgentDir) specs.push({ path: path.join(piAgentDir, "sessions"), direct: false, nested: true });
  const piSessionDir = expandEnvPath(process.env.PI_CODING_AGENT_SESSION_DIR);
  if (piSessionDir) specs.push({ path: piSessionDir, direct: true, nested: false });
  const bbDataDir = expandEnvPath(process.env.BB_DATA_DIR);
  if (bbDataDir) specs.push({ path: path.join(bbDataDir, "pi-bridge-sessions"), direct: true, nested: false });
  const bridgeDir = expandEnvPath(process.env.BB_PI_BRIDGE_SESSION_DIR);
  if (bridgeDir) specs.push({ path: bridgeDir, direct: true, nested: false });

  const unique = new Map();
  for (const spec of specs) {
    const key = realpathOrResolve(spec.path);
    const existing = unique.get(key);
    if (existing) {
      existing.direct ||= spec.direct;
      existing.nested ||= spec.nested;
      existing.omp ||= spec.omp;
    } else {
      unique.set(key, spec);
    }
  }
  return [...unique.values()];
}

/** @param {{ discovery?: { includeOmp?: boolean } }} [config] */
export function storeRoots(config) {
  return storeSpecs(config).map((spec) => spec.path);
}

/** @param {{ config?: { discovery?: { includeOmp?: boolean } }, cutoffMs?: number | null, repo?: object }} [options] */
export function enumerate({ config } = {}) {
  const out = [];
  const seen = new Set();
  for (const spec of storeSpecs(config)) {
    const files = [
      ...(spec.direct ? listFiles(spec.path, ".jsonl") : []),
      ...(spec.nested ? listDirs(spec.path).flatMap((dir) => sessionFiles(dir, spec.omp ? SUBAGENT_DEPTH : 0)) : []),
    ];
    for (const file of files) {
      const key = realpathOrResolve(file);
      if (seen.has(key)) continue;
      seen.add(key);
      const stat = statOrNull(file);
      if (!stat) continue;
      out.push({
        key,
        path: file,
        mtimeMs: stat.mtimeMs,
        bytes: stat.size,
        omp: Boolean(spec.omp),
        subagent: Boolean(spec.omp) && path.relative(spec.path, file).split(path.sep).length > 2,
      });
    }
  }
  return out;
}

function sessionFiles(dir, depth) {
  return [
    ...listFiles(dir, ".jsonl"),
    ...(depth > 0 ? listDirs(dir).flatMap((sub) => sessionFiles(sub, depth - 1)) : []),
  ];
}

export function createScanContext() {
  return { parentHeaders: new Map() };
}

/** A leading `{type:"title"}` record is an omp trait; plain Pi stores read exactly as on main. */
function readSessionHeader(file, { omp = false } = {}) {
  const [firstLine, secondLine] = readHeadLines(file, omp ? 2 : 1);
  const first = parseJsonLine(firstLine);
  return first?.type === "session" ? first : omp && first?.type === "title" ? parseJsonLine(secondLine) : null;
}

function readParentSession(parentPath, scanContext) {
  const cache = scanContext?.parentHeaders;
  if (cache?.has(parentPath)) return cache.get(parentPath);
  const stat = statOrNull(parentPath);
  const entry = stat?.isFile() ? readSessionHeader(parentPath, { omp: true }) : null;
  const result =
    entry?.type === "session"
      ? {
          entry,
          stat,
          fingerprint: JSON.stringify([
            stat.dev,
            stat.ino,
            stat.mtimeMs,
            stat.ctimeMs,
            stat.size,
            entry.id ?? null,
            entry.cwd ?? null,
            entry.timestamp ?? null,
          ]),
        }
      : null;
  cache?.set(parentPath, result);
  return result;
}

function parentSessionPathFor(candidatePath) {
  const sessionDir = path.dirname(candidatePath);
  return path.join(path.dirname(sessionDir), `${path.basename(sessionDir)}.jsonl`);
}

function ancestorSessionPaths(candidatePath) {
  const out = [];
  let current = candidatePath;
  for (let depth = 0; depth < SUBAGENT_DEPTH; depth += 1) {
    current = parentSessionPathFor(current);
    out.push(current);
  }
  return out;
}

/** @param {{ scanContext?: { parentHeaders: Map<string, { entry: any, stat: import("node:fs").Stats, fingerprint: string } | null> } }} [options] */
export function cacheDependency(candidate, options = {}) {
  // Plain Pi files depend on nothing but themselves. An omp file also depends on its
  // ancestors, and carries a marker so a store first scanned without omp parsing
  // (a title-led header reads as null there) is reclassified once omp is switched on.
  if (!candidate.omp) return undefined;
  return JSON.stringify(
    candidate.subagent
      ? ancestorSessionPaths(candidate.path).map(
          (ancestorPath) => readParentSession(ancestorPath, options.scanContext)?.fingerprint ?? null,
        )
      : [],
  );
}

/** @param {{ scanContext?: { parentHeaders: Map<string, { entry: any, stat: import("node:fs").Stats, fingerprint: string } | null> } }} [options] */
export function classify(candidate, options = {}) {
  const { scanContext } = options;
  const entry = readSessionHeader(candidate.path, { omp: candidate.omp });
  if (!entry || entry.type !== "session" || !entry.cwd) return null;

  const descriptor = {
    id: entry.id || path.basename(candidate.path, ".jsonl"),
    cwd: entry.cwd,
    gitBranch: null,
    remotes: [],
    startedAt: entry.timestamp ? Date.parse(entry.timestamp) : candidate.mtimeMs,
    model: null,
    interactionSignals: candidate.subagent ? { source: "subagent" } : emptyInteractionSignals(),
  };

  for (const ancestorPath of candidate.subagent ? ancestorSessionPaths(candidate.path) : []) {
    const ancestorInfo = readParentSession(ancestorPath, scanContext);
    const ancestor = ancestorInfo?.entry;
    if (!ancestor) continue;
    descriptor.parentSessionId = ancestor.id || path.basename(ancestorPath, ".jsonl");
    descriptor.parentSessionPath = ancestorPath;
    descriptor.parentSessionStartedAt = ancestor.timestamp ? Date.parse(ancestor.timestamp) : ancestorInfo.stat.mtimeMs;
  }

  return descriptor;
}

export function read(ref) {
  const { entries, prefixDiscarded } = readJsonl(ref.path);
  const events = [];
  let model = null;
  const omp = entries[0]?.type === "title";

  for (const entry of entries) {
    if (entry.type === "model_change") {
      model = entry.modelId || (omp && entry.model) || model;
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    const role = message.role;

    if (role === "toolResult") {
      events.push({ kind: "tool-result", id: message.toolCallId ?? message.id, result: textOf(message.content) });
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    contentToEvents(role, message.content, events);
  }

  return { events: attachToolResults(events), model, prefixDiscarded };
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content
    .map((b) => (typeof b === "string" ? b : (b?.text ?? "")))
    .filter(Boolean)
    .join("\n");
}
