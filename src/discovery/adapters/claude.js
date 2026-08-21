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
 */

const HEADER_LINES = 40;

export const name = "claude";

export function storeRoot() {
  return home(".claude", "projects");
}

export function enumerate() {
  const out = [];
  for (const dir of listDirs(storeRoot())) {
    for (const file of listFiles(dir, ".jsonl")) {
      const stat = statOrNull(file);
      if (!stat) continue;
      out.push({ key: file, path: file, mtimeMs: stat.mtimeMs, bytes: stat.size });
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
