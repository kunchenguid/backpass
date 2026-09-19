import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { UserError, warn } from "./logger.js";
import { normalizeSkillsDir } from "./skills.js";

export const CONFIG_FILENAME = ".backpassrc.json";
export const STATE_DIRNAME = ".backpass";

export const ALL_HARNESSES = ["claude", "codex", "pi", "opencode", "grok", "cursor", "hermes"];
/** Cursor IDE is deferred to v1.1 and only ever runs behind --include-cursor-ide. */
export const OPT_IN_HARNESSES = ["cursor-ide"];

/**
 * The ordered candidate ladders behind the auto-pick (ordered-defaults design, section 8.2).
 * Each rung is one model id served by several harnesses in preference order; rungs are
 * flattened model-outer / harness-inner, and the first candidate that is installed,
 * authenticated, and serves the model wins. Model ids are the bare ids the vendors use;
 * per-harness spellings (`openai-codex/...`, `openai/...`, `xai/...`) are resolved at
 * probe time against what the adapter advertises - never hard-coded. A collision of the
 * same bare id under two providers is ranked by auth class (subscription over API key;
 * see `src/provider-auth.js`); an unrankable collision is refused, not guessed. Ladders
 * live in config so a user can reorder or shorten them in `.backpassrc.json` without a
 * release.
 */
export const DEFAULT_LADDERS = {
  analysis: [
    { model: "gpt-5.6-luna", agents: ["pi", "opencode", "codex"] },
    { model: "claude-sonnet-5", agents: ["claude"] },
    { model: "grok-4.6", agents: ["pi", "opencode", "grok"] },
  ],
  synthesis: [
    { model: "gpt-5.6-sol", agents: ["pi", "opencode", "codex"] },
    { model: "claude-opus-5", agents: ["claude"] },
    { model: "grok-4.6", agents: ["pi", "opencode", "grok"] },
  ],
};

/** Applied to a role whenever no layer set an effort, auto-picked or pinned. */
export const DEFAULT_EFFORT = { analysis: "medium", synthesis: "high" };

/** What `--no-auto-agent` pins: the pre-ladder fixed defaults. */
export const LEGACY_DEFAULT_AGENTS = { analysis: "codex", synthesis: "claude" };

export const DEFAULT_CONFIG = {
  memoryFiles: ["AGENTS.md", "CLAUDE.md"],
  budgetTokens: 5000,
  skillsDir: ".agents/skills",
  /**
   * Extra directories to consult for *existing* skills, alongside `skillsDir`, when
   * deciding whether an AGENTS.md pointer already resolves, whether a failed trigger
   * needs a description edit instead of duplicate content, and whether an extraction
   * should point at a shared skill rather than create a new one. `~` is expanded. These
   * are read-only awareness: writes always target only `skillsDir`, never a search path
   * (a skill resolving outside the repo is withheld from the synthesis staging copy).
   */
  skillSearchPaths: [],
  /** `null` means adaptive: see `effectiveMaxEdits` in proposal.js. An integer pins it. */
  maxEditsPerRun: null,
  minGapEvidence: 2,
  /**
   * Gap observations persist across runs in `.backpass/gap-ledger.json`, but only
   * observations from the current selected sample count toward `minGapEvidence`.
   * A session's observations retire past this age (a duration like 90d, `all` to never expire).
   */
  gapLedgerMaxAge: "90d",
  /**
   * Cap on transcripts analyzed per run; past it a deterministic, recency-weighted sample
   * is drawn (`src/sample.js`). `0` or "all" disables the cap. `sampleHalfLife` is the age
   * at which a transcript's sampling weight halves; `seed` selects a different reproducible
   * sample.
   */
  maxTranscripts: 100,
  sampleHalfLife: "14d",
  seed: null,
  /**
   * `agent: null` means auto-pick from `ladders[role]`; `effort: null` means
   * `DEFAULT_EFFORT[role]`, except OpenCode which omits the overlay until effort
   * is set. Setting `agent` pins the role and skips the ladder.
   */
  analysis: { agent: null, model: null, effort: null },
  synthesis: { agent: null, model: null, effort: null },
  autoAgent: true,
  ladders: DEFAULT_LADDERS,
  discovery: {
    harnesses: ALL_HARNESSES,
    since: "30d",
    worktreeGlobs: [],
    /**
     * Extra directories to search for local clones that share this repo's remotes
     * (sibling of the current checkout is searched automatically). Each entry is a
     * checkout or a parent of checkouts. Discovery only reads git identity there.
     */
    cloneRoots: [],
    /**
     * SSH destinations whose harness stores this run also collects from
     * (`src/discovery/hosts.js`). Personal configuration only: a repository file that
     * sets it is refused by name, so a checked-in config can never point a
     * contributor's backpass at a machine. Entries are an ssh destination string, or
     * `{ host, node, env, harnesses, connectTimeoutSeconds }`.
     */
    hosts: [],
    minUserTurns: 2,
    includeCursorIde: false,
  },
  jobs: 4,
  timeoutSeconds: 300,
  promptRetries: 1,
  /** Live progress ink set: "auto" queries the terminal background, or force "dark" / "light". */
  theme: "auto",
};

/**
 * User-scope defaults, layered on `DEFAULT_CONFIG` when `--scope user`.
 *
 * Canonical user memory is the first existing file in this list (captain, issue #97):
 * `~/.agents/AGENTS.md` first (AGENTS.md is the cross-harness file), then Claude Code's
 * configured `CLAUDE.md` (allowed as a pointer), then Codex's configured `AGENTS.md`.
 * `CLAUDE_CONFIG_DIR` and `CODEX_HOME` relocate the latter two defaults.
 * `minGapProjects` defaults to 1: the gate exists and is configurable, but cross-project
 * corroboration is not required. Phase 1 discovery and user-level edit targets cover
 * Claude Code and Codex (plus the shared `.agents` layout).
 */
export const USER_MEMORY_FILES = [".agents/AGENTS.md", ".claude/CLAUDE.md", ".codex/AGENTS.md"];
export const USER_SKILLS_DIRS = [".agents/skills", ".claude/skills", ".codex/skills"];

export function userClaudeSkillsDir() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || ".claude", "skills");
}

function userHarnessPaths() {
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR || ".claude";
  const codexRoot = process.env.CODEX_HOME || ".codex";
  return {
    memoryFiles: [".agents/AGENTS.md", path.join(claudeRoot, "CLAUDE.md"), path.join(codexRoot, "AGENTS.md")],
    skillsDirs: [".agents/skills", userClaudeSkillsDir(), path.join(codexRoot, "skills")],
  };
}

export const USER_CONFIG_DEFAULTS = {
  memoryFiles: USER_MEMORY_FILES,
  skillsDir: ".agents/skills",
  skillsDirs: USER_SKILLS_DIRS,
  minGapProjects: 1,
  discovery: {
    harnesses: ["claude", "codex"],
    includeProjects: [],
    excludeProjects: [],
    maxTranscriptsPerProject: null,
  },
};

/** True for a filesystem root spelling: `/`, repeated separators, or a Windows volume root. */
function isFilesystemRoot(p) {
  const s = p.trim();
  if (/^\/+$/.test(s) || /^\\+$/.test(s)) return true;
  if (/^[A-Za-z]:[/\\]*$/.test(s)) return true;
  return false;
}

/** True when `candidate` is `root`, or lies inside it. Both must already be resolved. */
export function isAncestorOrEqual(root, candidate) {
  return root === candidate || candidate.startsWith(`${root}${path.sep}`);
}

/** Expand a leading `~` to the home directory; other paths pass through unchanged. */
export function expandHomePath(p, home = os.homedir()) {
  if (typeof p !== "string") return p;
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

/**
 * Canonical identities of the configured `skillSearchPaths` roots, resolved EXACTLY the
 * way a skill source is (`prepareWorkspace` builds a source with `path.join(repo.root, ...)`
 * then compares `fs.realpathSync` identities): expand `~`, resolve a relative entry
 * against the repository root - never the process working directory - then follow links.
 * Building it any other way is how the read-only promise fails open: `fs.realpathSync` on a
 * raw relative value resolves against `process.cwd()`, so it never matches the real source
 * and the refusal never fires.
 *
 * Fail CLOSED: a configured root that exists but cannot be canonicalised raises a clear
 * error naming `config.skillSearchPaths` rather than being dropped - silently discarding it
 * would delete the promise instead of enforcing it. A not-yet-existing root (`ENOENT`)
 * keeps its resolved absolute path as its identity: nothing can load from, or be written
 * to, a directory that does not exist, so the promise stays whole either way.
 *
 * A root that is the repository itself, an ancestor of it (e.g. "~" with the repo checked
 * out under $HOME), or that equals or contains the repo's own configured `skillsDir` (e.g.
 * ".agents" covering ".agents/skills") is dropped rather than registered: `validate()`
 * below rejects that shape at load time, but this function is also reachable directly
 * (tests, future callers), and such a root would otherwise mark files backpass exists to
 * write as "inside a search path" - the repo's own containment must win for its own files.
 */
export function canonicalizeSearchPathRoots(repoRoot, roots = [], skillsDir = null, home = os.homedir()) {
  // Reference points (the repo root and its skillsDir) resolve leniently: any resolution
  // failure falls back to the plain absolute path rather than aborting, since a not-yet-
  // created skillsDir must still win its own containment check.
  const resolveReference = (candidate) => {
    const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(repoRoot, candidate);
    try {
      return fs.realpathSync(absolute);
    } catch {
      return absolute;
    }
  };
  const identities = new Set();
  const repoIdentity = resolveReference(repoRoot);
  const skillsIdentity = skillsDir ? resolveReference(skillsDir) : null;
  for (const raw of roots) {
    const expanded = expandHomePath(raw, home);
    const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(repoRoot, expanded);
    let identity;
    try {
      identity = fs.realpathSync(absolute);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        identity = absolute;
      } else {
        throw new UserError(
          `config.skillSearchPaths root "${raw}" cannot be resolved (${err.message})`,
          "point it at a readable directory, or remove it from skillSearchPaths",
        );
      }
    }
    if (isAncestorOrEqual(identity, repoIdentity)) continue;
    if (skillsIdentity && isAncestorOrEqual(identity, skillsIdentity)) continue;
    identities.add(identity);
  }
  return identities;
}

export function parseScopeKind(value) {
  if (value === undefined || value === null || value === "") return "project";
  if (value === "project" || value === "user") return value;
  throw new UserError(`--scope must be "project" or "user" (got "${value}")`);
}

export function userConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "backpass", "config.json");
}

/** Isolated user-scope state: `~/.config/backpass/user/` (honours `XDG_CONFIG_HOME`). */
export function userStateDir() {
  return path.join(path.dirname(userConfigPath()), "user");
}

function readJsonIfPresent(file) {
  if (!fs.existsSync(file)) return null;
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new UserError(`${file} is not valid JSON: ${err.message}`);
  }
  if (!isPlainObject(value)) {
    throw new UserError(`${file} must contain a JSON object`);
  }
  return value;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    result[key] = isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return result;
}

/**
 * Parse a duration like `30d`, `12h`, `90m` into milliseconds.
 * `all` / `0` disables the cutoff.
 */
export function parseSince(since) {
  if (since === null || since === undefined || since === "all" || since === "0") return null;
  const match = String(since)
    .trim()
    .match(/^(\d+)\s*([dhwm])$/i);
  if (!match) {
    throw new UserError(`invalid --since value "${since}"`, "use forms like 30d, 12h, 2w, 90m, or all");
  }
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  const ms = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit];
  return n * ms;
}

/** Normalize a user-facing cap: `0`, `all`, null, or undefined disables it. */
export function parseMaxTranscripts(value, flag = "maxTranscripts") {
  if (value === null || value === undefined || value === "all" || value === "0" || value === 0) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new UserError(
      `${flag} must be a non-negative integer or "all" (got "${value}")`,
      'use a positive integer, or 0 / "all" to analyze every transcript',
    );
  }
  return n;
}

export function sinceCutoff(since, now = Date.now()) {
  const window = parseSince(since);
  return window === null ? null : now - window;
}

function validate(config, { kind = "project", repoRoot = null } = {}) {
  if (!Array.isArray(config.memoryFiles) || config.memoryFiles.length === 0) {
    throw new UserError("config.memoryFiles must be a non-empty array");
  }
  if (!Number.isFinite(config.budgetTokens) || config.budgetTokens <= 0) {
    throw new UserError("config.budgetTokens must be a positive number");
  }
  if (config.maxEditsPerRun !== null && (!Number.isInteger(config.maxEditsPerRun) || config.maxEditsPerRun <= 0)) {
    throw new UserError("config.maxEditsPerRun must be a positive integer, or null for the adaptive cap");
  }
  if (!Number.isInteger(config.minGapEvidence) || config.minGapEvidence < 1) {
    throw new UserError("config.minGapEvidence must be an integer >= 1");
  }
  if (kind === "user" || config.minGapProjects !== undefined) {
    const minGapProjects = config.minGapProjects ?? 1;
    if (!Number.isInteger(minGapProjects) || minGapProjects < 1) {
      throw new UserError("config.minGapProjects must be an integer >= 1");
    }
    config.minGapProjects = minGapProjects;
  }
  if (config.skillsDirs !== undefined) {
    if (!Array.isArray(config.skillsDirs) || config.skillsDirs.some((d) => typeof d !== "string")) {
      throw new UserError("config.skillsDirs must be an array of paths");
    }
  }
  if (config.skillSearchPaths !== undefined) {
    if (!Array.isArray(config.skillSearchPaths) || config.skillSearchPaths.some((d) => typeof d !== "string")) {
      throw new UserError("config.skillSearchPaths must be an array of paths");
    }
    for (const entry of config.skillSearchPaths) {
      if (!entry.trim()) {
        throw new UserError("config.skillSearchPaths entries must be non-empty path strings");
      }
      // The filesystem root as a search path would mark every path read-only and leave
      // nothing stageable - a degenerate value that must be rejected, not enforced.
      if (isFilesystemRoot(entry)) {
        throw new UserError(
          `config.skillSearchPaths entry "${entry}" must not be the filesystem root`,
          "name a specific shared skills directory",
        );
      }
      // A root that is the repo itself, an ancestor of it (e.g. "~" with the repo checked
      // out under $HOME), or that equals or contains the repo's own configured skillsDir
      // (e.g. ".agents" covering ".agents/skills") would mark files backpass exists to
      // write as "inside a search path" too - the same degenerate shape as the
      // filesystem-root case above. `canonicalizeSearchPathRoots` is the one place that
      // decides this, both here (reject at load) and at runtime (drop for direct callers) -
      // never duplicate the comparison.
      if (repoRoot && canonicalizeSearchPathRoots(repoRoot, [entry], config.skillsDir).size === 0) {
        throw new UserError(
          `config.skillSearchPaths entry "${entry}" must not be the repository root or its skillsDir, or an ancestor of either`,
          "name a shared skills directory outside the repository",
        );
      }
    }
  }
  const includeProjects = config.discovery.includeProjects;
  const excludeProjects = config.discovery.excludeProjects;
  if (
    includeProjects !== undefined &&
    (!Array.isArray(includeProjects) || includeProjects.some((g) => typeof g !== "string"))
  ) {
    throw new UserError("config.discovery.includeProjects must be an array of globs");
  }
  if (
    excludeProjects !== undefined &&
    (!Array.isArray(excludeProjects) || excludeProjects.some((g) => typeof g !== "string"))
  ) {
    throw new UserError("config.discovery.excludeProjects must be an array of globs");
  }
  const maxPerProject = config.discovery.maxTranscriptsPerProject;
  if (maxPerProject != null) {
    if (!Number.isInteger(maxPerProject) || maxPerProject < 1) {
      throw new UserError("config.discovery.maxTranscriptsPerProject must be a positive integer or null");
    }
  }
  config.maxTranscripts = parseMaxTranscripts(config.maxTranscripts, "config.maxTranscripts");
  try {
    parseSince(config.gapLedgerMaxAge);
  } catch {
    throw new UserError(`config.gapLedgerMaxAge must be a duration like 90d or all (got "${config.gapLedgerMaxAge}")`);
  }
  if (parseSince(config.sampleHalfLife) === null) {
    throw new UserError(`config.sampleHalfLife must be a duration like 14d (got "${config.sampleHalfLife}")`);
  }
  if (config.seed !== null && !Number.isInteger(config.seed)) {
    throw new UserError("config.seed must be an integer or null");
  }
  if (!Number.isInteger(config.jobs) || config.jobs < 1) {
    throw new UserError("config.jobs must be an integer >= 1");
  }
  for (const role of ["analysis", "synthesis"]) {
    if (config[role].model && !config[role].agent) {
      throw new UserError(
        `config.${role}.model is set but config.${role}.agent is not`,
        `set --${role}-agent too, or leave both unset to auto-pick from the ladder`,
      );
    }
    const ladder = config.ladders?.[role];
    if (!Array.isArray(ladder) || ladder.length === 0) {
      throw new UserError(`config.ladders.${role} must be a non-empty array of { model, agents } rungs`);
    }
    for (const rung of ladder) {
      if (!rung || typeof rung.model !== "string" || !Array.isArray(rung.agents) || !rung.agents.length) {
        throw new UserError(`config.ladders.${role} rungs must look like { "model": "<id>", "agents": ["<harness>"] }`);
      }
    }
  }
  if (!["auto", "dark", "light"].includes(config.theme)) {
    throw new UserError(`config.theme must be "auto", "dark", or "light" (got "${config.theme}")`);
  }
  const known = new Set([...ALL_HARNESSES, ...OPT_IN_HARNESSES]);
  for (const h of config.discovery.harnesses) {
    if (!known.has(h)) {
      warn(`unknown harness "${h}" in config.discovery.harnesses - ignoring`);
    }
  }
  config.discovery.harnesses = config.discovery.harnesses.filter((h) => known.has(h));
  parseSince(config.discovery.since);
  if (!Array.isArray(config.discovery.cloneRoots) || config.discovery.cloneRoots.some((p) => typeof p !== "string")) {
    throw new UserError("config.discovery.cloneRoots must be an array of paths");
  }
  if (config.discovery.hosts !== undefined && !Array.isArray(config.discovery.hosts)) {
    throw new UserError("config.discovery.hosts must be an array of ssh destinations");
  }
  return config;
}

/**
 * A repository may not name a machine.
 *
 * `.backpassrc.json` is checked in and shared, so a `discovery.hosts` there would let one
 * contributor point every other contributor's backpass at a host - which is exactly the
 * "someone else's transcripts" the vision resists. Hosts are personal configuration and
 * live in the person's own global file, or on the command line for one run.
 */
function refuseRepoHosts(repoFile, file) {
  if (!repoFile?.discovery || repoFile.discovery.hosts === undefined) return;
  throw new UserError(
    `${file} sets discovery.hosts, but ssh hosts are personal configuration`,
    `move them to ${userConfigPath()}, or pass --host <destination> for one run`,
  );
}

/**
 * Layered config.
 *
 * Project: defaults < ~/.config/backpass/config.json (minus its `user` block) <
 *   <repo>/.backpassrc.json < CLI flags.
 * User: defaults < user-scope defaults < ~/.config/backpass/config.json `user` block <
 *   CLI flags. `.backpassrc.json` is never read.
 *
 * `discovery.hosts` is the one setting a repository file may not carry at all
 * (`refuseRepoHosts`). In user scope it defaults to the global file's top-level list, so
 * a person names their machines once rather than once per scope.
 */
export function loadConfig(repoRoot, overrides = {}, { kind = "project" } = {}) {
  const scopeKind = parseScopeKind(kind);
  let merged;
  if (scopeKind === "user") {
    const globalFile = readJsonIfPresent(userConfigPath());
    const userBlock = isPlainObject(globalFile?.user) ? globalFile.user : {};
    const harnessPaths = userHarnessPaths();
    merged = [DEFAULT_CONFIG, { ...USER_CONFIG_DEFAULTS, ...harnessPaths }, userBlock, overrides].reduce(
      (acc, layer) => (layer ? deepMerge(acc, layer) : acc),
      {},
    );
    if (userBlock.discovery?.hosts === undefined && overrides.discovery?.hosts === undefined) {
      merged.discovery.hosts = globalFile?.discovery?.hosts ?? DEFAULT_CONFIG.discovery.hosts;
    }
  } else {
    const globalFile = readJsonIfPresent(userConfigPath());
    const projectGlobal = globalFile ? { ...globalFile } : null;
    if (projectGlobal) delete projectGlobal.user;
    const repoFile = repoRoot ? readJsonIfPresent(path.join(repoRoot, CONFIG_FILENAME)) : null;
    refuseRepoHosts(repoFile, repoRoot ? path.join(repoRoot, CONFIG_FILENAME) : CONFIG_FILENAME);
    merged = [projectGlobal, repoFile, overrides].reduce(
      (acc, layer) => (layer ? deepMerge(acc, layer) : acc),
      DEFAULT_CONFIG,
    );
  }

  const config = structuredClone(merged);
  config.skillsDir = normalizeSkillsDir(config.skillsDir);
  if (config.discovery.includeCursorIde && !config.discovery.harnesses.includes("cursor-ide")) {
    config.discovery.harnesses = [...config.discovery.harnesses, "cursor-ide"];
  }
  const validated = validate(config, { kind: scopeKind, repoRoot });
  // `skillSearchPaths` is the read-side awareness key. It rides the existing `skillsDirs`
  // awareness list (consulted after `skillsDir` in list order) rather than a second plumbing;
  // `~` is expanded here so the loaders that join `repoRoot` never mishandle a home path.
  const searchPaths = (validated.skillSearchPaths || []).map((p) => expandHomePath(p));
  if (searchPaths.length) validated.skillsDirs = [...(validated.skillsDirs || []), ...searchPaths];
  return validated;
}

/**
 * `--host` adds a destination to this run's list; `--host none` collects locally only.
 * It adds rather than replaces because the flag is for "also look over there today",
 * and the one case that needs replacing - skip everything configured - has its own word.
 */
export function applyHostFlag(configured, flagValues) {
  if (!flagValues?.length) return configured;
  const named = flagValues.map((value) => String(value));
  if (named.includes("none")) return [];
  const out = [...(configured || [])];
  for (const host of named) {
    const already = out.some((entry) => (typeof entry === "string" ? entry : entry?.host) === host);
    if (!already) out.push(host);
  }
  return out;
}

export function repoConfigPath(repoRoot) {
  return path.join(repoRoot, CONFIG_FILENAME);
}

/** The subset written by `backpass init` - defaults stay implicit so upgrades reach users. */
export function initialConfig() {
  return {
    memoryFiles: ["AGENTS.md"],
    budgetTokens: DEFAULT_CONFIG.budgetTokens,
    skillsDir: DEFAULT_CONFIG.skillsDir,
    // maxEditsPerRun stays unset so the adaptive cap applies; set it to pin a number.
    minGapEvidence: DEFAULT_CONFIG.minGapEvidence,
    maxTranscripts: DEFAULT_CONFIG.maxTranscripts,
    // Agent roles stay unset so initialized repos inherit global pins, or the default
    // auto-pick when no global pin exists.
    discovery: { harnesses: ALL_HARNESSES, since: "30d", worktreeGlobs: [], minUserTurns: 2 },
    jobs: DEFAULT_CONFIG.jobs,
  };
}

/** The `user` block written by `backpass init --scope user`. */
export function initialUserConfig() {
  return {
    skillsDir: USER_CONFIG_DEFAULTS.skillsDir,
    budgetTokens: DEFAULT_CONFIG.budgetTokens,
    minGapEvidence: DEFAULT_CONFIG.minGapEvidence,
    minGapProjects: USER_CONFIG_DEFAULTS.minGapProjects,
    discovery: {
      harnesses: USER_CONFIG_DEFAULTS.discovery.harnesses,
      since: "30d",
      includeProjects: [],
      excludeProjects: [],
      maxTranscriptsPerProject: null,
    },
  };
}
