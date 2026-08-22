import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { UserError } from "./logger.js";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function realpathOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Normalize a git remote to a comparable identity.
 *
 *   git@github.com:kunchenguid/backpass.git  ->  github.com/kunchenguid/backpass
 *   https://github.com/kunchenguid/backpass  ->  github.com/kunchenguid/backpass
 *   /Users/kun/src/backpass                  ->  /users/kun/src/backpass  (local path remote)
 */
export function normalizeRemote(remote) {
  if (!remote) return null;
  let s = String(remote).trim();
  if (!s) return null;
  s = s.replace(/^[a-z+]+:\/\//i, "");
  s = s.replace(/^[^/@]+@/, "");
  s = s.replace(/:(?=[^/])/, "/");
  s = s.replace(/\.git\/?$/i, "");
  s = s.replace(/\/+$/, "");
  return s.toLowerCase() || null;
}

/** Worktree paths for the repo, realpath-normalized (design section 2.1, tier 1). */
function listWorktrees(root) {
  let raw;
  try {
    raw = git(["worktree", "list", "--porcelain"], root);
  } catch {
    return [realpathOrSelf(root)];
  }
  const paths = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(realpathOrSelf(line.slice("worktree ".length)));
  }
  if (!paths.length) paths.push(realpathOrSelf(root));
  return [...new Set(paths)];
}

function listRemotes(root) {
  let raw;
  try {
    raw = git(["remote", "-v"], root);
  } catch {
    return [];
  }
  const out = new Set();
  for (const line of raw.split("\n")) {
    const url = line.split(/\s+/)[1];
    const norm = normalizeRemote(url);
    if (norm) out.add(norm);
  }
  return [...out];
}

/**
 * Ensure `line` is present in this repo's *local* git exclude file
 * (`.git/info/exclude`) - never a tracked file the user owns. The path is
 * resolved via `git rev-parse --git-path info/exclude` rather than assumed,
 * since in a worktree or submodule `.git` is a file, not a directory, and
 * `info/exclude` lives in the shared common git dir. Idempotent: a line
 * already present is left alone.
 *
 * Returns `{ status: "added" | "present" | "no-git", path? }`.
 */
export function ensureLocalExclude(root, line) {
  let excludePath;
  try {
    excludePath = git(["rev-parse", "--git-path", "info/exclude"], root);
  } catch {
    return { status: "no-git" };
  }
  const resolved = path.isAbsolute(excludePath) ? excludePath : path.join(root, excludePath);

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const current = fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "";
  if (current.split("\n").some((l) => l.trim() === line)) {
    return { status: "present", path: resolved };
  }
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(resolved, `${separator}${line}\n`);
  return { status: "added", path: resolved };
}

/**
 * Repo identity used by every discovery adapter.
 * `commonDir` distinguishes worktrees of the same repository.
 */
export function resolveRepo(cwd = process.cwd()) {
  let root;
  try {
    root = git(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    throw new UserError("not inside a git repository", "backpass runs per-repo; cd into a repo and retry");
  }
  const realRoot = realpathOrSelf(root);
  return {
    root,
    realRoot,
    name: path.basename(realRoot),
    worktrees: listWorktrees(root),
    remotes: listRemotes(root),
  };
}
