import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseScopeKind, userStateDir } from "./config.js";
import { associate as associateProject, globToRegExp } from "./discovery/association.js";
import { UserError, info } from "./logger.js";
import { gitProjectIdentity, gitToplevel, listWorktrees, normalizeRemote } from "./repo.js";

/**
 * A run scope is the triple (weights surface, session corpus, state directory).
 *
 * Project scope is today's behaviour: git checkout, `<repo>/.backpass/`, sessions
 * associated with this repo. User scope trains the always-loaded user file and
 * user-level skills from Claude and Codex sessions across projects, with state isolated under
 * `~/.config/backpass/user/` (0700). A run is exactly one scope, chosen by `--scope`.
 */

export function expandUserPath(p, home = os.homedir()) {
  if (typeof p !== "string") return p;
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

/**
 * Path relative to `root` when it sits under it, otherwise the absolute path.
 * Staging and apply both use this spelling, so a file outside home still has one name.
 */
export function pathInRoot(p, root, home = os.homedir()) {
  const expanded = expandUserPath(p, home);
  const absolute = path.isAbsolute(expanded) ? expanded : path.join(root, expanded);
  const rel = path.relative(root, absolute);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join("/");
  }
  return absolute;
}

export function resolveInRoot(root, p) {
  if (!p) return p;
  const expanded = expandUserPath(p);
  return path.isAbsolute(expanded) ? expanded : path.join(root, expanded);
}

function realpathOrResolve(p) {
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

/**
 * User-scope association: keep every session with a cwd, stamp a project key.
 *
 *   tier 1  live git toplevel (passes --strict)
 *   tier 2  recorded remote, for deleted worktrees (codex, grok)
 *   tier 3  cwd string; excluded by --strict
 */
export function associateUser(descriptor, { strict = false } = {}) {
  const cwd = descriptor?.cwd;
  if (!cwd) return null;

  const liveRoot = gitToplevel(cwd);
  if (liveRoot) {
    return {
      tier: 1,
      confidence: "git",
      reason: `cwd is in ${liveRoot}`,
      project: gitProjectIdentity(liveRoot),
      projectRoot: liveRoot,
    };
  }

  const remote = (descriptor.remotes || []).map(normalizeRemote).find(Boolean);
  if (remote) {
    return {
      tier: 2,
      confidence: "remote",
      reason: `remote ${remote}`,
      project: remote,
      projectRoot: null,
    };
  }

  if (strict) return null;

  const key = realpathOrResolve(cwd);
  return {
    tier: 3,
    confidence: "cwd",
    reason: `cwd ${key}`,
    project: key,
    projectRoot: null,
  };
}

function matchesAnyGlob(values, globs) {
  if (!globs?.length) return false;
  return values.some((value) => globs.some((glob) => globToRegExp(glob).test(value)));
}

/** Include/exclude globs over project keys and cwds. Applied only in user scope. */
export function passesProjectFilter(transcript, config) {
  const include = config.discovery?.includeProjects || [];
  const exclude = config.discovery?.excludeProjects || [];
  const haystacks = [transcript.project, transcript.cwd].filter(Boolean);
  if (exclude.length && matchesAnyGlob(haystacks, exclude)) return false;
  if (include.length && !matchesAnyGlob(haystacks, include)) return false;
  return true;
}

function syntheticUserRepo(home) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(home);
  } catch {
    realRoot = path.resolve(home);
  }
  return {
    root: home,
    realRoot,
    name: "user",
    worktrees: [],
    remotes: [],
    cloneRemotes: [],
    siblingWorktrees: [],
  };
}

function resolveProjectScope(repo, config) {
  return {
    kind: "project",
    repo,
    root: repo.root,
    name: repo.name,
    stateDir: path.join(repo.root, ".backpass"),
    modelCwd: repo.root,
    memoryFiles: config.memoryFiles,
    skillDirs: config.skillsDirs || [],
    overflowDir: config.skillsDir,
    associate: (descriptor, options = {}) => {
      const result = associateProject(descriptor, repo, {
        worktreeGlobs: options.worktreeGlobs || config.discovery?.worktreeGlobs || [],
      });
      if (result) {
        result.project = repo.root;
        result.projectRoot = repo.root;
      }
      return result;
    },
  };
}

function resolveUserScope(cwd, config, { strict = false, home = os.homedir(), associateUserFn = associateUser } = {}) {
  const root = home;
  const memoryFiles = (config.memoryFiles || []).map((file) => pathInRoot(file, root, home));
  const overflowDir = pathInRoot(config.skillsDir || ".agents/skills", root, home);
  const skillDirs = (config.skillsDirs || []).map((dir) => pathInRoot(dir, root, home));
  const repo = syntheticUserRepo(root);
  const stateDir = userStateDir();
  const associationCache = new Map();
  const knownWorktrees = new Map();
  const indexedRoots = new Set();
  const associate = (descriptor) => {
    const key = JSON.stringify([descriptor?.cwd || null, descriptor?.remotes || []]);
    if (!associationCache.has(key)) {
      const association = associateUserFn(descriptor, { strict });
      associationCache.set(key, association);
      if (association?.tier === 1 && association.projectRoot && !indexedRoots.has(association.projectRoot)) {
        indexedRoots.add(association.projectRoot);
        for (const worktree of listWorktrees(association.projectRoot)) {
          knownWorktrees.set(realpathOrResolve(worktree), association.project);
        }
      }
    }
    return associationCache.get(key);
  };
  const normalizeProjects = (transcripts) => {
    for (const transcript of transcripts) {
      if (transcript.association?.tier !== 3 || !transcript.cwd) continue;
      const cwdPath = realpathOrResolve(transcript.cwd);
      const match = [...knownWorktrees.entries()]
        .filter(([worktree]) => cwdPath === worktree || cwdPath.startsWith(`${worktree}${path.sep}`))
        .sort(([a], [b]) => b.length - a.length)[0];
      if (!match) continue;
      const [worktree, project] = match;
      transcript.project = project;
      transcript.association.project = project;
      transcript.association.confidence = "git";
      transcript.association.reason = `cwd is in registered worktree ${worktree}`;
    }
    return transcripts;
  };
  return {
    kind: "user",
    repo,
    root,
    name: "user",
    stateDir,
    modelCwd: stateDir,
    memoryFiles,
    skillDirs,
    overflowDir,
    associate,
    normalizeProjects,
    cwdNote: gitToplevel(cwd)
      ? "user scope: this checkout is not a write target; edits go to the user-level memory file and skills"
      : null,
  };
}

/**
 * Build the run scope. `config` is already loaded for this kind.
 *
 * @param {string} cwd
 * @param {{ scope?: string, strict?: boolean }} flags
 * @param {object} config
 * @param {object | null} [repo] required for project scope
 * @param {{ home?: string, associateUserFn?: (descriptor: any, options?: { strict?: boolean }) => any }} [options]
 */
export function resolveScope(cwd, flags, config, repo = null, options = {}) {
  const kind = parseScopeKind(flags?.scope);
  if (kind === "user") {
    const home = options.home || os.homedir();
    return resolveUserScope(cwd, config, {
      strict: Boolean(flags?.strict),
      home,
      associateUserFn: options.associateUserFn,
    });
  }
  if (!repo) {
    throw new UserError("backpass runs per-repo; cd into a repo and retry", "or pass --scope user");
  }
  return resolveProjectScope(repo, config);
}

export function printScopeNote(scope) {
  if (scope.kind === "user" && scope.cwdNote) info(scope.cwdNote);
}
