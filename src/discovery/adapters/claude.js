import path from "node:path";

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
 * Claude Code: ~/.claude/projects/<munged-cwd>/<session-uuid>.jsonl
 *
 * Every message line carries `cwd`, `gitBranch`, `sessionId` and `version`. The
 * directory name is a lossy munge of the cwd (slashes and dots both become dashes),
 * so it is only used to narrow the search - the per-line `cwd` is the authority.
 * No git remote is recorded, so a deleted worktree can only reach tier 3.
 *
 * `CLAUDE_CONFIG_DIR` relocates the whole config dir, and it is commonly set per
 * invocation (a shell alias for a work profile), which splits a machine's sessions across
 * two stores rather than moving them - so both roots are scanned. The variable is read
 * from this process's environment; an alias that only prefixes `claude` never reaches it.
 */

const HEADER_LINES = 40;

export const name = "claude";

export function storeRoots() {
  const roots = [home(".claude", "projects")];
  const configured = process.env.CLAUDE_CONFIG_DIR;
  if (configured) roots.push(path.join(configured, "projects"));
  return [...new Set(roots)];
}

export function enumerate() {
  const out = [];
  for (const root of storeRoots()) {
    for (const dir of listDirs(root)) {
      for (const file of listFiles(dir, ".jsonl")) {
        const stat = statOrNull(file);
        if (!stat) continue;
        out.push({ key: file, path: file, mtimeMs: stat.mtimeMs, bytes: stat.size });
      }
    }
  }
  return out;
}

export function classify(candidate) {
  for (const line of readHeadLines(candidate.path, HEADER_LINES)) {
    const entry = parseJsonLine(line);
    if (!entry || !entry.cwd) continue;
    return {
      id: entry.sessionId || path.basename(candidate.path, ".jsonl"),
      cwd: entry.cwd,
      gitBranch: entry.gitBranch || null,
      remotes: [],
      startedAt: entry.timestamp ? Date.parse(entry.timestamp) : candidate.mtimeMs,
      model: null,
    };
  }
  return null;
}

export function read(ref) {
  const entries = readJsonl(ref.path);
  const events = [];
  let model = null;

  for (const entry of entries) {
    if (entry.type === "user" && entry.message) {
      if (entry.isSidechain) continue;
      contentToEvents("user", entry.message.content, events);
    } else if (entry.type === "assistant" && entry.message) {
      if (entry.isSidechain) continue;
      model = model || entry.message.model || null;
      contentToEvents("assistant", entry.message.content, events);
    }
  }

  return { events: attachToolResults(events), model };
}
