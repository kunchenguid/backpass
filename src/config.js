import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { UserError, warn } from "./logger.js";

export const CONFIG_FILENAME = ".backpassrc.json";
export const STATE_DIRNAME = ".backpass";

export const ALL_HARNESSES = ["claude", "codex", "pi", "opencode", "grok", "cursor"];
/** Cursor IDE is deferred to v1.1 and only ever runs behind --include-cursor-ide. */
export const OPT_IN_HARNESSES = ["cursor-ide"];

export const DEFAULT_CONFIG = {
  memoryFiles: ["AGENTS.md", "CLAUDE.md"],
  budgetTokens: 5000,
  skillsDir: ".claude/skills",
  maxEditsPerRun: 5,
  minGapEvidence: 2,
  analysis: { agent: "codex", model: null, effort: null },
  synthesis: { agent: "claude", model: null, effort: "high" },
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
  if (!Number.isInteger(config.maxEditsPerRun) || config.maxEditsPerRun <= 0) {
    throw new UserError("config.maxEditsPerRun must be a positive integer");
  }
  if (!Number.isInteger(config.minGapEvidence) || config.minGapEvidence < 1) {
    throw new UserError("config.minGapEvidence must be an integer >= 1");
  }
  if (!Number.isInteger(config.jobs) || config.jobs < 1) {
    throw new UserError("config.jobs must be an integer >= 1");
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
    maxEditsPerRun: DEFAULT_CONFIG.maxEditsPerRun,
    minGapEvidence: DEFAULT_CONFIG.minGapEvidence,
    analysis: { agent: "codex", model: null, effort: "low" },
    synthesis: { agent: "claude", model: null, effort: "high" },
    discovery: { harnesses: ALL_HARNESSES, since: "30d", worktreeGlobs: [], minUserTurns: 2 },
    jobs: DEFAULT_CONFIG.jobs,
  };
}
