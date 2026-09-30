import fs from "node:fs";
import path from "node:path";

import { isCloneOf } from "../repo.js";
import { isWindowsPath, localPath } from "./paths.js";

/**
 * Where a session worked, from the paths its tool calls name.
 *
 * The same structured paths place a session's work in two places. Nested memory files
 * (`src/nested.js`) use the repo-relative paths under this repository's checkouts to pick
 * the file a lesson belongs to. Association uses them for tier 2.5 below: which checkout
 * a session worked in, when where it started says nothing.
 *
 * A work path is a path a tool call names in a structured field (`PATH_FIELDS`), or a
 * file header of an apply_patch body, resolved against the call's workdir or the
 * session's cwd and read through `localPath`. Nothing is read out of shell command text,
 * and a `~` path, whose home is unknown, is not placed.
 *
 * See README.md's association tiers for tier-2.5 eligibility and majority rules.
 * Discovery calls this only after all descriptor-based tiers failed, including tier 3.
 * Candidate checks must reject both cwd and recorded-root checkout ownership, and any
 * recorded remote, so tool paths cannot override a session's existing repository tie.
 * Checkout lookup follows symlinks and the nearest `.git`, not lexical path containment.
 */

/** Tool-input fields that name a file or directory a session worked in. */
const PATH_FIELDS = ["file_path", "filePath", "notebook_path", "path"];
/** File headers of the apply_patch grammar (Codex); each names one file the patch touches. */
const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

export const WORK_TIER = 2.5;
export const WORK_PATHS_VERSION = 2;

/** The paths a session's tool calls name, as recorded. */
export function toolPaths(events) {
  const out = [];
  const patchFiles = (text, workdir) => {
    if (!text.includes("*** Begin Patch")) return;
    for (const match of text.matchAll(PATCH_FILE)) out.push({ raw: match[1].trim(), workdir });
  };
  for (const event of events || []) {
    if (event?.kind !== "tool") continue;
    const input = event.input;
    if (typeof input === "string") {
      if (event.name === "apply_patch") patchFiles(input, null);
      continue;
    }
    if (!input || typeof input !== "object") continue;
    const workdir =
      [input.workdir, input.cwd].find((value) => typeof value === "string" && value.trim())?.trim() || null;
    for (const key of PATH_FIELDS) {
      if (typeof input[key] === "string" && input[key].trim()) out.push({ raw: input[key].trim(), workdir });
    }
    if (event.name === "apply_patch") {
      for (const value of Object.values(input)) if (typeof value === "string") patchFiles(value, workdir);
    }
  }
  return out;
}

/**
 * The session's cwd as this machine spells it, or null when it is not an absolute path here.
 *
 * @param {{ cwd?: string | null }} transcript
 * @param {{ wsl?: import("./paths.js").WslEnvironment | null }} [options]
 */
export function localCwd(transcript, { wsl } = {}) {
  const cwd = localPath(transcript?.cwd, { wsl });
  return cwd && path.isAbsolute(cwd) ? cwd : null;
}

/**
 * The absolute local path one recorded tool path names, or null when it cannot be placed:
 * a path this machine cannot spell, a relative path whose call ran in such a workdir, a
 * `~` path, or a relative path with no absolute base to resolve it against. An absolute
 * path needs no workdir. A relative or backslash-rooted path recorded against a Windows
 * base is resolved with Windows semantics before it is mapped, so a drive or share root
 * stays the boundary for `..`.
 *
 * @param {{ raw: string, workdir: string | null }} entry
 * @param {{ cwd?: string | null }} transcript
 * @param {{ wsl?: import("./paths.js").WslEnvironment | null }} [options]
 */
export function resolveToolPath(entry, transcript, { wsl } = {}) {
  const cwd = localCwd(transcript, { wsl });
  const independent = path.isAbsolute(entry.raw) || isWindowsPath(entry.raw);
  if (entry.raw.startsWith("~") || (!independent && entry.workdir?.startsWith("~"))) return null;
  let recordedWorkdir = entry.workdir;
  if (
    recordedWorkdir &&
    !path.isAbsolute(recordedWorkdir) &&
    !isWindowsPath(recordedWorkdir) &&
    isWindowsPath(transcript?.cwd)
  ) {
    recordedWorkdir = path.win32.resolve(`${transcript.cwd}\\`, recordedWorkdir);
  }
  const workdir = recordedWorkdir === null ? null : localPath(recordedWorkdir, { wsl });
  if (!independent && entry.workdir !== null && workdir === null) return null;
  const recordedBase = workdir && path.isAbsolute(workdir) ? recordedWorkdir : transcript?.cwd;
  const recordedRaw =
    !independent && isWindowsPath(recordedBase) ? path.win32.resolve(`${recordedBase}\\`, entry.raw) : entry.raw;
  const raw = localPath(recordedRaw, { wsl });
  if (raw === null) return null;
  const base = workdir ? (path.isAbsolute(workdir) ? workdir : cwd ? path.resolve(cwd, workdir) : null) : cwd;
  if (!path.isAbsolute(raw) && !base) return null;
  return path.resolve(base || "", raw);
}

/**
 * Every distinct absolute path a session's tool calls name.
 *
 * @param {{ cwd?: string | null }} transcript
 * @param {object[]} events
 * @param {{ wsl?: import("./paths.js").WslEnvironment | null }} [options]
 * @returns {string[]}
 */
export function workPaths(transcript, events, { wsl } = {}) {
  const out = new Set();
  for (const entry of toolPaths(events)) {
    const absolute = resolveToolPath(entry, transcript, { wsl });
    if (absolute !== null) out.add(absolute);
  }
  return [...out];
}

/** The path with its deepest existing ancestor resolved through links. */
export function realpathDeepest(p) {
  const absolute = path.resolve(p);
  let existing = absolute;
  const tail = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return absolute;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(fs.realpathSync(existing), ...tail);
  } catch {
    return absolute;
  }
}

/** Every checkout of this repository discovery knows, deepest first. */
export function checkoutRoots(repo) {
  const roots = [repo.realRoot, ...(repo.worktrees || []), ...(repo.siblingWorktrees || [])].filter(Boolean);
  return [...new Set(roots.map(realpathDeepest))].sort((a, b) => b.length - a.length);
}

/** The repo-relative spelling of a path under one of `roots`, or null outside them. */
export function projectWorkPath(absolute, roots) {
  const real = realpathDeepest(absolute);
  for (const root of roots) {
    const relative = path.relative(root, real);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    return relative.split(path.sep).join("/");
  }
  return null;
}

/**
 * A lookup from a path to the checkout it lies in - the nearest directory at or above
 * its deepest existing ancestor that holds `.git` - or null. Memoized per directory.
 *
 * @returns {(p: string) => string | null}
 */
export function checkoutLocator() {
  const memo = new Map();
  return (p) => {
    let dir = realpathDeepest(p);
    while (!fs.existsSync(dir)) {
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    try {
      if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
    } catch {
      return null;
    }
    const visited = [];
    let found = null;
    for (let current = dir; ; current = path.dirname(current)) {
      if (memo.has(current)) {
        found = memo.get(current);
        break;
      }
      visited.push(current);
      if (fs.existsSync(path.join(current, ".git"))) {
        found = realpathDeepest(current);
        break;
      }
      if (path.dirname(current) === current) break;
    }
    for (const dirname of visited) memo.set(dirname, found);
    return found;
  };
}

/**
 * The work-path tier for one repository.
 *
 * @param {{ realRoot?: string, worktrees?: string[], siblingWorktrees?: string[], cloneRemotes?: string[], root?: string }} repo
 * @param {{ wsl?: import("./paths.js").WslEnvironment | null, cloneOf?: (dir: string) => boolean }} [options]
 */
export function workTier(repo, { wsl, cloneOf = (dir) => isCloneOf(dir, repo.cloneRemotes || []) } = {}) {
  const locate = checkoutLocator();
  const ours = new Set(checkoutRoots(repo));
  const verdicts = new Map();
  const isOurs = (checkout) => {
    if (!verdicts.has(checkout)) verdicts.set(checkout, ours.has(checkout) || cloneOf(checkout));
    return verdicts.get(checkout);
  };
  return {
    /**
     * A session this tier may place: started in a live directory inside no checkout, and
     * recorded no remote of its own.
     *
     * @param {{ cwd?: string | null, gitRoot?: string | null, remotes?: string[] }} descriptor
     */
    isCandidate(descriptor) {
      if ((descriptor.remotes || []).length) return false;
      const cwd = localCwd(descriptor, { wsl });
      if (!cwd) return false;
      try {
        if (!fs.statSync(cwd).isDirectory()) return false;
      } catch {
        return false;
      }
      const root = localPath(descriptor.gitRoot, { wsl });
      return locate(cwd) === null && (!root || !path.isAbsolute(root) || locate(root) === null);
    },
    /**
     * @param {string[]} paths the session's `workPaths`
     * @returns {{ tier: number, confidence: string, reason: string } | null}
     */
    associate(paths) {
      let here = 0;
      let elsewhere = 0;
      const places = new Map();
      // Resolve at voting time, not in the content cache: links can change between scans.
      for (const p of new Set(paths.map(realpathDeepest))) {
        const checkout = locate(p);
        if (!checkout) continue;
        if (!isOurs(checkout)) {
          elsewhere += 1;
          continue;
        }
        here += 1;
        places.set(checkout, (places.get(checkout) || 0) + 1);
      }
      if (here === 0 || here <= elsewhere) return null;
      const [where] = [...places.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        tier: WORK_TIER,
        confidence: "work",
        reason: `tool calls worked in ${where} (${here} of ${here + elsewhere} paths in a checkout)`,
      };
    },
  };
}
