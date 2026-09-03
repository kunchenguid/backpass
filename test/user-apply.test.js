import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyDecisions, readOnlySymlinkMessage } from "../src/apply/writer.js";
import { cmdApply } from "../src/commands/apply.js";
import { cmdInit } from "../src/commands/init.js";
import { loadConfig } from "../src/config.js";
import { UserError } from "../src/logger.js";
import { memoryTextHash } from "../src/memory.js";
import { resolveScope } from "../src/scope.js";
import { State } from "../src/state.js";

async function withXdg(home, fn) {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
}

test("user state creation tightens an existing directory to mode 0700", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-user-state-mode-"));
  const stateDir = path.join(home, ".config", "backpass", "user");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.chmodSync(stateDir, 0o777);

  new State(home, { stateDir, mode: 0o700, exclude: false }).ensure();

  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
});

test("apply refuses a user-level memory file that is a symlink to a read-only path", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-uapply-home-"));
  const source = path.join(home, "dotfiles", "AGENTS.md");
  const link = path.join(home, ".agents", "AGENTS.md");
  const text = "# User memory\n\n- Keep secrets out of prompts.\n";
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.writeFileSync(source, text);
  fs.chmodSync(source, 0o444);
  fs.symlinkSync(source, link);

  const state = new State(home, {
    stateDir: path.join(home, ".config", "backpass", "user"),
    mode: 0o700,
    exclude: false,
  }).ensure();
  const results = applyDecisions({
    proposal: {
      memoryFile: { path: ".agents/AGENTS.md", hash: memoryTextHash(text), tokens: 20 },
      edits: [{ id: "e1", kind: "rewrite", file: ".agents/AGENTS.md" }],
      config: { budgetTokens: 5000, skillsDir: ".agents/skills" },
    },
    decisions: { e1: "accepted" },
    repo: { root: home, name: "user" },
    state,
    config: { budgetTokens: 5000, skillsDir: ".agents/skills" },
  });

  assert.equal(results.written.length, 0);
  assert.equal(results.rejectionsRecorded, false);
  assert.equal(results.failed[0].error, readOnlySymlinkMessage(link, fs.realpathSync(source)));
  assert.match(results.failed[0].error, /is a symlink to .+ which is not writable; edit the source that generates it/);
  assert.equal(fs.readFileSync(source, "utf8"), text);
  assert.equal(fs.readlinkSync(link), source);
});

test("apply names a symlink whose writable file is in a read-only store", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-uapply-store-"));
  const store = path.join(home, "readonly-store");
  const source = path.join(store, "AGENTS.md");
  const link = path.join(home, ".agents", "AGENTS.md");
  const text = "# User memory\n\n- Keep secrets out of prompts.\n";
  fs.mkdirSync(store, { recursive: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.writeFileSync(source, text, { mode: 0o644 });
  fs.symlinkSync(source, link);
  fs.chmodSync(store, 0o555);

  try {
    const state = new State(home, {
      stateDir: path.join(home, ".config", "backpass", "user"),
      mode: 0o700,
      exclude: false,
    }).ensure();
    const results = applyDecisions({
      proposal: {
        memoryFile: { path: ".agents/AGENTS.md", hash: memoryTextHash(text), tokens: 20 },
        edits: [{ id: "e1", kind: "rewrite", file: ".agents/AGENTS.md" }],
        config: { budgetTokens: 5000, skillsDir: ".agents/skills" },
      },
      decisions: { e1: "accepted" },
      repo: { root: home, name: "user" },
      state,
      config: { budgetTokens: 5000, skillsDir: ".agents/skills" },
    });

    assert.equal(results.written.length, 0);
    assert.equal(results.failed[0].error, readOnlySymlinkMessage(link, fs.realpathSync(source)));
    assert.equal(fs.readFileSync(source, "utf8"), text);
  } finally {
    fs.chmodSync(store, 0o755);
  }
});

test("project apply refuses an external memory target", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-project-apply-"));
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-external-apply-"));
  const external = path.join(externalRoot, "AGENTS.md");
  const text = "# External\n";
  fs.writeFileSync(external, text);
  const state = new State(repoRoot).ensure();
  const results = applyDecisions({
    proposal: {
      scope: "project",
      memoryFile: { path: external, hash: memoryTextHash(text), tokens: 2 },
      edits: [{ id: "e1", kind: "rewrite", file: external, hunks: [] }],
      config: { budgetTokens: 5000, skillsDir: ".agents/skills" },
    },
    decisions: { e1: "accepted" },
    repo: { root: repoRoot, name: "project" },
    state,
    config: { budgetTokens: 5000, skillsDir: ".agents/skills" },
  });
  assert.equal(results.written.length, 0);
  assert.match(results.failed[0].error, /outside the project root/);
  assert.equal(fs.readFileSync(external, "utf8"), text);
});

test("apply refuses a proposal from the other scope", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-uapply-scope-"));
  const state = {
    readProposal: () => ({ scope: "user", edits: [{ id: "e1" }] }),
  };
  await assert.rejects(
    () => cmdApply({ repo: { root: home, name: "demo" }, scope: { kind: "project" }, config: { state }, flags: {} }),
    (err) => {
      assert.ok(err instanceof UserError);
      assert.match(err.message, /this proposal is user scope; run `backpass apply --scope user`/);
      return true;
    },
  );
});

test("init --scope user writes the user block and a 0700 state directory", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-uinit-"));
  await withXdg(home, async () => {
    const config = loadConfig(null, {}, { kind: "user" });
    const scope = resolveScope(home, { scope: "user" }, config, null, { home });
    config.state = new State(scope.root, {
      stateDir: scope.stateDir,
      mode: 0o700,
      exclude: false,
    }).ensure();
    await cmdInit({ repo: scope.repo, scope, config, flags: {} });
    const target = path.join(home, ".config", "backpass", "config.json");
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal(parsed.user.minGapProjects, 1);
    assert.equal("memoryFiles" in parsed.user, false);
    assert.equal("skillsDirs" in parsed.user, false);
    assert.equal(fs.statSync(scope.stateDir).mode & 0o777, 0o700);
    assert.equal(config.state.exclude.status, "skipped");
  });
});
