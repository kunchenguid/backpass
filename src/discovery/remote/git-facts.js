import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * The filesystem and git facts association needs about one session's cwd.
 *
 * Association is a local decision (which repo does this session belong to), but the
 * inputs are facts about paths, and on a remote host those paths are only real over
 * there: `fs.existsSync` on a remote cwd is always false here, so a naive mirror would
 * file every live remote session as a dead path. This module computes the facts where
 * the paths are real; `src/discovery/association.js` then applies exactly the same tier
 * rules to them.
 *
 * It is deliberately dependency-free (no logger, no config): it ships to the remote
 * inside the probe bundle, where nothing but `node:` builtins exists. Every call is
 * fail-soft - a missing path, a missing git, or a directory that is not a checkout all
 * read as "no toplevel, no remotes", never a throw.
 */

/** @typedef {{ real: string, exists: boolean, toplevel: string | null, remotes: string[] }} PathFacts */

function realpathOrResolve(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function toplevelOf(dir) {
  try {
    return realpathOrResolve(git(["rev-parse", "--show-toplevel"], dir));
  } catch {
    return null;
  }
}

/**
 * Every distinct remote URL configured in a checkout, in `git remote -v` order.
 * Spelling is left alone; `normalizeRemote` on the local side owns comparison.
 */
export function remotesOf(toplevel) {
  let raw;
  try {
    raw = git(["remote", "-v"], toplevel);
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const url = line.split(/\s+/)[1];
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

/**
 * Facts for each distinct path, with remotes memoised per toplevel so a host with
 * hundreds of sessions in a handful of checkouts runs a handful of `git remote` calls.
 *
 * @param {Iterable<string>} paths
 * @param {{ git?: boolean }} [options] `git: false` when the host has no git at all:
 *   liveness is still reported, so tier 3 keeps working while tiers 1.5 and 2 cannot.
 * @returns {Record<string, PathFacts>}
 */
export function collectPathFacts(paths, { git: hasGit = true } = {}) {
  /** @type {Record<string, PathFacts>} */
  const facts = Object.create(null);
  const remotesByToplevel = new Map();

  for (const candidate of paths) {
    if (typeof candidate !== "string" || !candidate || Object.hasOwn(facts, candidate)) continue;
    const exists = fs.existsSync(candidate);
    const real = exists ? realpathOrResolve(candidate) : path.resolve(candidate);
    const toplevel = exists && hasGit ? toplevelOf(candidate) : null;
    if (toplevel && !remotesByToplevel.has(toplevel)) remotesByToplevel.set(toplevel, remotesOf(toplevel));
    facts[candidate] = { real, exists, toplevel, remotes: toplevel ? remotesByToplevel.get(toplevel) : [] };
  }
  return facts;
}
