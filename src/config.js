import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { UserError, warn } from "./logger.js";

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
 * probe time against what the adapter advertises - never hard-coded. Ladders live in
 * config so a user can reorder or shorten them in `.backpassrc.json` without a release.
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
  /** `null` means adaptive: see `effectiveMaxEdits` in proposal.js. An integer pins it. */
  maxEditsPerRun: null,
  minGapEvidence: 2,
  /**
   * Gap observations accumulate across runs in `.backpass/gap-ledger.json` so the
   * `minGapEvidence` bar counts distinct sessions over time, not per run. A session's
   * observations retire past this age (a duration like 90d, `all` to never expire).
   */
  gapLedgerMaxAge: "90d",
  /**
   * Cap on transcripts analyzed per run; past it a recency-weighted sample is drawn
   * (`src/sample.js`). `0` or "all" disables the cap. `sampleHalfLife` is the age at
   * which a transcript's sampling weight halves; `seed` makes the sample reproducible.
   */
  maxTranscripts: 100,
  sampleHalfLife: "14d",
  seed: null,
  /**
   * `agent: null` means auto-pick from `ladders[role]`; `effort: null` means
   * `DEFAULT_EFFORT[role]`. Setting `agent` pins the role and skips the ladder.
   */
  analysis: { agent: null, model: null, effort: null },
  synthesis: { agent: null, model: null, effort: null },
  autoAgent: true,
  ladders: DEFAULT_LADDERS,
  discovery: {
    harnesses: ALL_HARNESSES,
    since: "30d",
    worktreeGlobs: [],
    minUserTurns: 2,
    includeCursorIde: false,
  },
  jobs: 4,
  timeoutSeconds: 300,
  promptRetries: 1,
  /** Live progress ink set: "auto" queries the terminal background, or force "dark" / "light". */
  theme: "auto",
};

function userConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "backpass", "config.json");
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

function validate(config) {
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
  return config;
}

/**
 * Layered config: defaults < ~/.config/backpass/config.json < <repo>/.backpassrc.json < CLI flags.
 */
export function loadConfig(repoRoot, overrides = {}) {
  const merged = [
    readJsonIfPresent(userConfigPath()),
    readJsonIfPresent(path.join(repoRoot, CONFIG_FILENAME)),
    overrides,
  ].reduce((acc, layer) => (layer ? deepMerge(acc, layer) : acc), DEFAULT_CONFIG);

  const config = structuredClone(merged);
  if (config.discovery.includeCursorIde && !config.discovery.harnesses.includes("cursor-ide")) {
    config.discovery.harnesses = [...config.discovery.harnesses, "cursor-ide"];
  }
  return validate(config);
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
    // Agents stay unset so the ladder auto-pick keeps applying to initialized repos.
    analysis: { agent: null, model: null, effort: null },
    synthesis: { agent: null, model: null, effort: null },
    discovery: { harnesses: ALL_HARNESSES, since: "30d", worktreeGlobs: [], minUserTurns: 2 },
    jobs: DEFAULT_CONFIG.jobs,
  };
}
