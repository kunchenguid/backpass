import fs from "node:fs";
import path from "node:path";

import { normalizeRemote } from "../repo.js";

/**
 * Three-tier repo/worktree association (design section 2.1).
 *
 *   tier 1  deterministic  - transcript cwd is (or sits under) a live worktree path
 *   tier 2  deterministic  - a recorded git remote matches one of the repo's remotes;
 *                            survives worktree deletion (codex, grok)
 *   tier 3  best-effort    - dead cwd whose last segment is the repo dir name, or that
 *                            matches a user-supplied worktree glob; excluded by --strict
 *
 * Returns null when the transcript belongs to some other repo.
 */

function realpathOrResolve(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isUnder(child, parent) {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** Glob support is intentionally minimal: `*` (one segment) and `**` (many). */
export function globToRegExp(glob) {
  const expanded = glob.startsWith("~/") ? path.join(process.env.HOME || "", glob.slice(2)) : glob;
  let out = "";
  for (let i = 0; i < expanded.length; i += 1) {
    const c = expanded[i];
    if (c === "*") {
      if (expanded[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (expanded[i + 1] === "/") i += 1;
      } else {
        out += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}/?$`);
}

export function associate({ cwd, remotes = [], gitRoot = null }, repo, options = {}) {
  const globs = options.worktreeGlobs || [];
  const candidates = [cwd, gitRoot].filter(Boolean);

  // Tier 1 - live path under a known worktree.
  for (const candidate of candidates) {
    const real = realpathOrResolve(candidate);
    for (const worktree of repo.worktrees) {
      if (real === worktree) {
        return { tier: 1, confidence: "exact", reason: `cwd is worktree ${worktree}` };
      }
      if (isUnder(real, worktree)) {
        return { tier: 1, confidence: "nested", reason: `cwd is inside worktree ${worktree}` };
      }
    }
  }

  // Tier 2 - recorded remote, valid even when the worktree is long gone.
  const repoRemotes = new Set(repo.remotes);
  for (const remote of remotes) {
    const norm = normalizeRemote(remote);
    if (norm && repoRemotes.has(norm)) {
      return { tier: 2, confidence: "remote", reason: `recorded remote ${norm}` };
    }
  }

  // Tier 3 - best-effort, only for paths that no longer exist.
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) continue;
    if (path.basename(resolved.replace(/\/+$/, "")) === repo.name) {
      return { tier: 3, confidence: "path", reason: `dead path ending in /${repo.name}` };
    }
    for (const glob of globs) {
      if (globToRegExp(glob).test(resolved)) {
        return { tier: 3, confidence: "glob", reason: `dead path matches glob ${glob}` };
      }
    }
  }

  return null;
}

export function passesStrict(association, strict) {
  if (!association) return false;
  return strict ? association.tier <= 2 : true;
}
