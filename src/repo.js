import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

/**
 * Live git toplevel for a cwd, or null when the path is missing or not a checkout.
 * User-scope association uses this as the project key when the worktree still exists.
 */
export function gitToplevel(cwd) {
  if (!cwd) return null;
  try {
    if (!fs.existsSync(cwd)) return null;
    return realpathOrSelf(git(["rev-parse", "--show-toplevel"], cwd));
  } catch {
    return null;
  }
}

/** Worktree paths for the repo, realpath-normalized (design section 2.1, tier 1). */
export function listWorktrees(root) {
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

function networkRemoteIdentity(remote) {
  let host;
  let repositoryPath;

  if (/^[a-z][a-z+.-]*:\/\//i.test(remote)) {
    try {
      const parsed = new URL(remote);
      const defaultPorts = { "git:": "9418", "http:": "80", "https:": "443", "ssh:": "22" };
      const port = parsed.port && parsed.port !== defaultPorts[parsed.protocol.toLowerCase()] ? `:${parsed.port}` : "";
      host = `${parsed.hostname.toLowerCase()}${port}`;
      repositoryPath = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return null;
    }
  } else {
    const match = remote.match(/^(?:[^/@\s]+@)?([^/:\s]+):(.+)$/);
    if (!match) return null;
    host = match[1].toLowerCase();
    repositoryPath = match[2];
  }

  repositoryPath = repositoryPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return host && repositoryPath ? `remote:${host}/${repositoryPath}` : null;
}

function cloneRemoteIdentity(remote, root) {
  const value = String(remote || "").trim();
  if (!value) return null;

  if (/^file:\/\//i.test(value)) {
    try {
      return `local:${realpathOrSelf(fileURLToPath(value))}`;
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z+.-]*:\/\//i.test(value) || /^(?:[^/@\s]+@)?[^/:\s]+:.+/.test(value)) {
    return networkRemoteIdentity(value);
  }

  const expanded = expandUserPath(value);
  const resolved = realpathOrSelf(path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded));
  return `local:${resolved}`;
}

function listRemoteUrls(root) {
  let names;
  try {
    names = git(["remote"], root).split("\n").filter(Boolean);
  } catch {
    return [];
  }

  names.sort((a, b) => (a === "origin" ? -1 : b === "origin" ? 1 : a.localeCompare(b)));
  const urls = new Set();
  for (const name of names) {
    for (const args of [
      ["remote", "get-url", "--all", name],
      ["remote", "get-url", "--push", "--all", name],
    ]) {
      try {
        for (const url of git(args, root).split("\n")) {
          if (url) urls.add(url);
        }
      } catch {
        continue;
      }
    }
  }
  return [...urls];
}

function listRemotes(root) {
  return [...new Set(listRemoteUrls(root).map(normalizeRemote).filter(Boolean))];
}

export function gitProjectIdentity(root) {
  const remote = listRemotes(root)[0];
  if (remote) return remote;

  try {
    const commonDir = git(["rev-parse", "--git-common-dir"], root);
    const absolute = realpathOrSelf(path.isAbsolute(commonDir) ? commonDir : path.resolve(root, commonDir));
    return path.basename(absolute) === ".git" ? path.dirname(absolute) : `git:${absolute}`;
  } catch {
    return realpathOrSelf(root);
  }
}

function listCloneRemotes(root) {
  return [
    ...new Set(
      listRemoteUrls(root)
        .map((remote) => cloneRemoteIdentity(remote, root))
        .filter(Boolean),
    ),
  ];
}

function expandUserPath(p) {
  if (p === "~") return process.env.HOME || "";
  if (typeof p === "string" && p.startsWith("~/")) {
    return path.join(process.env.HOME || "", p.slice(2));
  }
  return p;
}

function isGitCheckout(dir) {
  try {
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

function remotesOverlap(ours, theirs) {
  if (!ours.length || !theirs.length) return false;
  const set = new Set(ours);
  return theirs.some((remote) => set.has(remote));
}

/**
 * Local checkouts that share a remote with this repo, plus their worktrees.
 *
 * Claude (and other harnesses that record cwd but no remote) only reach tier 1 when
 * the cwd is a known live path. `git worktree list` cannot see a sibling clone's
 * separate `.git`, so those sessions were invisible. Search is bounded and read-only:
 * the parent of each of this repo's worktrees, each configured extra root, and the
 * immediate children of those directories. Matching is remote identity, not directory
 * name. Fail-soft: an unreadable path is skipped.
 *
 * @param {{ cloneRemotes?: string[], worktrees?: string[], cloneRoots?: string[], repoRoot?: string }} [opts]
 */
export function listSiblingCloneWorktrees({ cloneRemotes, worktrees, cloneRoots = [], repoRoot } = {}) {
  if (!cloneRemotes?.length) return [];
  const known = new Set(worktrees || []);
  const found = [];

  const consider = (dir) => {
    let real;
    try {
      real = realpathOrSelf(dir);
    } catch {
      return;
    }
    if (known.has(real) || !isGitCheckout(real)) return;
    const theirs = listCloneRemotes(real);
    if (!remotesOverlap(cloneRemotes, theirs)) return;
    for (const wt of listWorktrees(real)) {
      if (known.has(wt)) continue;
      known.add(wt);
      found.push(wt);
    }
  };

  const searchRoots = new Set();
  for (const wt of worktrees || []) {
    const parent = path.dirname(wt);
    if (parent && parent !== wt) searchRoots.add(parent);
  }
  for (const extra of cloneRoots) {
    const expanded = expandUserPath(extra);
    if (!expanded) continue;
    searchRoots.add(path.resolve(repoRoot || worktrees?.[0] || ".", expanded));
  }

  for (const root of searchRoots) {
    consider(root);
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      consider(path.join(root, entry.name));
    }
  }

  return found;
}

/**
 * Fill `repo.siblingWorktrees` from local clones that share this repo's remotes.
 *
 * @param {{ root: string, cloneRemotes: string[], worktrees: string[], siblingWorktrees?: string[] }} repo
 * @param {string[]} [cloneRoots]
 */
export function attachSiblingClones(repo, cloneRoots = []) {
  repo.siblingWorktrees = listSiblingCloneWorktrees({
    cloneRemotes: repo.cloneRemotes,
    worktrees: repo.worktrees,
    cloneRoots,
    repoRoot: repo.root,
  });
  return repo;
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
    cloneRemotes: listCloneRemotes(root),
    siblingWorktrees: [],
  };
}
