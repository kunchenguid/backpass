import fs from "node:fs";
import path from "node:path";

import { emptyInteractionSignals } from "../../interaction.js";
import { home, parseJsonLine, readHeadLines, statOrNull } from "./shared.js";
import * as pi from "./pi.js";

/**
 * Oh My Pi stores Pi-shaped message records under `~/.omp/agent/sessions/`, but its
 * files have a title/header prefix and may be nested more deeply than standalone Pi
 * sessions. The message reader is intentionally shared with Pi; only discovery differs.
 */

export const name = "omp";

function expandPath(value) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed === "~") return home();
  if (trimmed.startsWith("~/")) return path.join(home(), trimmed.slice(2));
  return path.resolve(trimmed);
}

export function storeRoot() {
  const configured = expandPath(process.env.OMP_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR);
  return configured ? path.join(configured, "sessions") : home(".omp", "agent", "sessions");
}

function sessionFiles(root) {
  const out = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(file);
    }
  }
  return out;
}

export function enumerate() {
  return sessionFiles(storeRoot())
    .map((file) => {
      const stat = statOrNull(file);
      return stat ? { key: file, path: file, mtimeMs: stat.mtimeMs, bytes: stat.size } : null;
    })
    .filter(Boolean);
}

export function classify(candidate) {
  const records = readHeadLines(candidate.path, 32).map(parseJsonLine).filter(Boolean);
  const session = records.find((entry) => entry.type === "session" && entry.cwd);
  if (!session) return null;

  const modelChange = records.find((entry) => entry.type === "model_change" && (entry.model || entry.modelId));
  const header = records.find((entry) => entry.type === "title");
  return {
    id: session.id || path.basename(candidate.path, ".jsonl"),
    cwd: session.cwd,
    gitBranch: null,
    remotes: [],
    title: header?.title || null,
    startedAt: session.timestamp ? Date.parse(session.timestamp) : candidate.mtimeMs,
    model: modelChange?.model || modelChange?.modelId || null,
    interactionSignals: emptyInteractionSignals(),
  };
}

export function read(ref) {
  return pi.read(ref);
}
