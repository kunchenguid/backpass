import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../../src/config.js";
import { discoverTranscripts } from "../../src/discovery/index.js";
import { resolveScope } from "../../src/scope.js";
import { State } from "../../src/state.js";
import { resolveRepo } from "../../src/repo.js";

/**
 * Offline scaffolding for the ssh collection tier.
 *
 * Nothing here stubs backpass: the fake `ssh` runs the real option set, the real stdin
 * program, the real loader and the real adapters against a fixture home, so a test
 * failing here is a behaviour failing, not a mock drifting.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(HERE, "..", "fixtures");
export const FAKE_SSH = path.join(FIXTURES, "fake-ssh", "ssh");

export function tmpdir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `backpass-${prefix}-`)));
}

export function initRepo(dir, remote) {
  const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  git(["commit", "--allow-empty", "-q", "-m", "init"]);
  if (remote) git(["remote", "add", "origin", remote]);
  return dir;
}

/** A claude session file in `home`'s store, recorded as having run in `cwd`. */
export function writeClaudeSession(home, { cwd, id = "11111111-2222-3333-4444-555555555555", prefixText = null }) {
  const dir = path.join(home, ".claude", "projects", `-${cwd.replaceAll("/", "-")}`);
  fs.mkdirSync(dir, { recursive: true });
  let text = fs.readFileSync(path.join(FIXTURES, "claude-session.jsonl"), "utf8");
  text = text.replaceAll("/repo/demo", cwd).replaceAll("11111111-2222-3333-4444-555555555555", id);
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, prefixText ? text.replace("Open a PR for the parser fix.", prefixText) : text);
  return file;
}

/** A minimal hermes store: one CLI session with two messages, in `home`. */
export function writeHermesStore(home, { cwd, id = "cli-remote-1" }) {
  const dir = path.join(home, ".hermes");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "state.db"));
  try {
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, model_config TEXT,
                             system_prompt TEXT, title TEXT, started_at REAL, ended_at REAL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
                             tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL);
    `);
    db.prepare(
      `INSERT INTO sessions (id, source, model, system_prompt, title, started_at, ended_at)
       VALUES (?, 'cli', 'claude-sonnet-5', ?, 'remote hermes session', ?, ?)`,
    ).run(id, `You are Hermes.\nCurrent working directory: ${cwd}\n`, 1_800_000_000, 1_800_000_060);
    const insert = db.prepare(`INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)`);
    insert.run(1, id, "user", "Ship the remote collection tier.", 1_800_000_010);
    insert.run(2, id, "assistant", "Fetched the transcript over ssh.", 1_800_000_020);
  } finally {
    db.close();
  }
  return dir;
}

/**
 * Run `fn` with the environment a remote test needs: an empty local HOME so the local
 * adapters find nothing of the developer's own, an isolated XDG config so no personal
 * `discovery.hosts` leaks in, and the fake ssh wired up.
 */
export async function withRemoteEnv({ localHome, hosts, log = null }, fn) {
  const mapFile = path.join(localHome, "fake-ssh-map.json");
  fs.writeFileSync(mapFile, JSON.stringify(hosts, null, 2));
  const overrides = {
    HOME: localHome,
    USERPROFILE: localHome,
    XDG_CONFIG_HOME: path.join(localHome, ".config"),
    CLAUDE_CONFIG_DIR: undefined,
    CODEX_HOME: undefined,
    HERMES_HOME: path.join(localHome, ".hermes-absent"),
    BACKPASS_SSH_BIN: FAKE_SSH,
    BACKPASS_FAKE_SSH_MAP: mapFile,
    BACKPASS_FAKE_SSH_LOG: log ?? undefined,
  };
  const previous = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

/** Load config + scope + state exactly as the CLI does, for one project-scope run. */
export function projectRun(repoRoot, overrides = {}) {
  const repo = resolveRepo(repoRoot);
  const config = loadConfig(repoRoot, {
    discovery: { since: "all", harnesses: ["claude"], ...overrides.discovery },
    ...overrides.config,
  });
  const scope = resolveScope(repoRoot, { scope: "project", strict: Boolean(overrides.strict) }, config, repo);
  config.state = new State(scope.root, { stateDir: scope.stateDir }).ensure();
  return { repo, config, scope };
}

export async function discoverProject(repoRoot, overrides = {}) {
  const { repo, config, scope } = projectRun(repoRoot, overrides);
  const result = await discoverTranscripts({ repo, scope, config, strict: Boolean(overrides.strict) });
  return { ...result, repo, config, scope };
}

/** Calls the fake ssh recorded in a log file, oldest first. */
export function sshCalls(log) {
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
