import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { discoverTranscripts } from "../src/discovery/index.js";
import { SELF_SESSION_SENTINEL } from "../src/prompts.js";
import { capTranscripts } from "../src/sample.js";
import { resolveScope } from "../src/scope.js";
import { State } from "../src/state.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `backpass-udisc-${name}-`));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  git(["commit", "--allow-empty", "-q", "-m", "init"], dir);
  return fs.realpathSync(dir);
}

async function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const previous = {};
  for (const key of keys) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function writeFixture(target, fixtureName, cwd, rewrite = {}) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let text = fs.readFileSync(path.join(FIXTURES, fixtureName), "utf8");
  text = text.replaceAll("/repo/demo", cwd);
  for (const [from, to] of Object.entries(rewrite)) text = text.replaceAll(from, to);
  fs.writeFileSync(target, text);
}

function userDiscovery(home, overrides = {}) {
  const xdg = path.join(home, ".config");
  return withEnv(
    {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: xdg,
      CLAUDE_CONFIG_DIR: undefined,
      CODEX_HOME: undefined,
      HERMES_HOME: path.join(home, ".hermes-absent"),
    },
    async () => {
      const config = loadConfig(
        null,
        { discovery: { since: "all", harnesses: ["claude", "codex"], ...overrides.discovery } },
        { kind: "user" },
      );
      const scope = resolveScope(home, { scope: "user", strict: Boolean(overrides.strict) }, config, null, { home });
      config.state = new State(scope.root, {
        stateDir: scope.stateDir,
        mode: 0o700,
        exclude: false,
      }).ensure();
      const result = await discoverTranscripts({
        repo: scope.repo,
        scope,
        config,
        strict: Boolean(overrides.strict),
      });
      return { result, scope, config };
    },
  );
}

test("user-scope discovery keeps Claude and Codex sessions from different project cwds", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-udisc-home-"));
  const alpha = initRepo("alpha");
  const beta = initRepo("beta");
  writeFixture(path.join(home, ".claude", "projects", "alpha", "alpha.jsonl"), "claude-session.jsonl", alpha);
  writeFixture(
    path.join(home, ".codex", "sessions", "2026", "08", "02", "rollout-2026-08-02T09-00-00-beta.jsonl"),
    "codex-rollout.jsonl",
    beta,
  );

  const { result, scope } = await userDiscovery(home);
  const harnesses = result.transcripts.map((t) => t.harness).sort();
  assert.deepEqual(harnesses, ["claude", "codex"]);
  const projects = new Set(result.transcripts.map((t) => t.project));
  assert.ok(projects.has(alpha), "Claude session stamps the live git toplevel");
  assert.ok(projects.has(beta), "Codex session stamps the other checkout");
  assert.equal(
    result.transcripts.every((t) => t.association.tier === 1),
    true,
  );
  assert.equal(scope.stateDir, path.join(home, ".config", "backpass", "user"));
  assert.equal(fs.statSync(scope.stateDir).mode & 0o777, 0o700);
});

test("user-scope discovery gives live and deleted registered worktrees one project identity", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-udisc-worktrees-"));
  const root = initRepo("worktrees");
  const sibling = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-udisc-parent-")), "deleted");
  git(["remote", "add", "origin", "https://github.com/acme/shared.git"], root);
  git(["worktree", "add", "-q", "-b", "deleted", sibling], root);

  writeFixture(path.join(home, ".claude", "projects", "a-deleted", "deleted.jsonl"), "claude-session.jsonl", sibling);
  writeFixture(path.join(home, ".claude", "projects", "z-live", "live.jsonl"), "claude-session.jsonl", root, {
    "11111111-2222-3333-4444-555555555555": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  });
  fs.rmSync(sibling, { recursive: true, force: true });

  const { result, config } = await userDiscovery(home, { discovery: { maxTranscriptsPerProject: 1 } });
  assert.equal(result.transcripts.length, 2);
  assert.deepEqual(
    new Set(result.transcripts.map((transcript) => transcript.project)),
    new Set(["github.com/acme/shared"]),
  );
  assert.equal(capTranscripts(result, config).transcripts.length, 1);
});

test("user-scope discovery drops self-sessions by sentinel and by cwd under the user state dir", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-udisc-self-"));
  const alpha = initRepo("alpha");
  const stateDir = path.join(home, ".config", "backpass", "user");
  writeFixture(path.join(home, ".claude", "projects", "alpha", "real.jsonl"), "claude-session.jsonl", alpha);
  writeFixture(path.join(home, ".claude", "projects", "state", "under-state.jsonl"), "claude-session.jsonl", stateDir, {
    "11111111-2222-3333-4444-555555555555": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  });
  const sentinelFile = path.join(home, ".claude", "projects", "alpha", "self.jsonl");
  fs.mkdirSync(path.dirname(sentinelFile), { recursive: true });
  fs.writeFileSync(
    sentinelFile,
    `${JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: `${SELF_SESSION_SENTINEL}\nanalyze this` },
      uuid: "u1",
      timestamp: "2026-08-01T10:00:00.000Z",
      cwd: alpha,
      sessionId: "self-sess-0000-0000-0000-000000000001",
      entrypoint: "cli",
    })}\n`,
  );

  const { result } = await userDiscovery(home);
  assert.equal(result.transcripts.length, 1);
  assert.equal(result.transcripts[0].harness, "claude");
  assert.equal(result.transcripts[0].project, alpha);
  assert.ok(result.perHarness.claude.self >= 2);
});

test("user-scope --strict drops a dead cwd with no recorded remote", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-udisc-strict-"));
  writeFixture(
    path.join(home, ".claude", "projects", "gone", "dead.jsonl"),
    "claude-session.jsonl",
    "/vanished/no-remote",
  );
  const kept = await userDiscovery(home);
  assert.equal(kept.result.transcripts.length, 1);
  assert.equal(kept.result.transcripts[0].association.tier, 3);
  const dropped = await userDiscovery(home, { strict: true });
  assert.equal(dropped.result.transcripts.length, 0);
});
