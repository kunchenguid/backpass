import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { loadConfig } from "../src/config.js";
import { associateUser, passesProjectFilter, resolveScope } from "../src/scope.js";

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `backpass-scope-${name}-`));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  git(["commit", "--allow-empty", "-q", "-m", "init"], dir);
  return fs.realpathSync(dir);
}

test("resolveScope project uses the checkout and .backpass state", () => {
  const root = initRepo("proj");
  const repo = { root, realRoot: root, name: path.basename(root), worktrees: [root], remotes: [] };
  const config = loadConfig(root);
  const scope = resolveScope(root, { scope: "project" }, config, repo);
  assert.equal(scope.kind, "project");
  assert.equal(scope.root, root);
  assert.equal(scope.stateDir, path.join(root, ".backpass"));
  assert.equal(scope.modelCwd, root);
  assert.equal(scope.associate({ cwd: root }).tier, 1);
});

test("resolveScope user uses homedir weights and isolated config state", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-user-home-"));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  try {
    const config = loadConfig(null, {}, { kind: "user" });
    let associationCalls = 0;
    const associateUserFn = (descriptor) => {
      associationCalls += 1;
      return { tier: 2, project: descriptor.remotes?.[0] || descriptor.cwd };
    };
    const scope = resolveScope(home, { scope: "user" }, config, null, { home, associateUserFn });
    assert.equal(scope.kind, "user");
    assert.equal(scope.root, home);
    assert.equal(scope.name, "user");
    assert.equal(scope.stateDir, path.join(home, ".config", "backpass", "user"));
    assert.equal(scope.modelCwd, scope.stateDir);
    assert.deepEqual(scope.memoryFiles, [".agents/AGENTS.md", ".claude/CLAUDE.md", ".codex/AGENTS.md"]);
    assert.equal(scope.overflowDir, ".agents/skills");
    assert.deepEqual(scope.skillDirs, [".agents/skills", ".claude/skills", ".codex/skills"]);
    assert.equal(config.minGapProjects, 1);

    const descriptor = { cwd: "/repos/alpha", remotes: ["https://example.com/alpha.git"] };
    assert.equal(scope.associate(descriptor).project, descriptor.remotes[0]);
    assert.equal(scope.associate({ ...descriptor, remotes: [...descriptor.remotes] }).project, descriptor.remotes[0]);
    assert.equal(associationCalls, 1);
    scope.associate({ ...descriptor, remotes: ["https://example.com/fork.git"] });
    assert.equal(associationCalls, 2);
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  }
});

test("user association stamps a live git toplevel as the project key", () => {
  const root = initRepo("live");
  const nested = path.join(root, "src");
  fs.mkdirSync(nested);
  const result = associateUser({ cwd: nested });
  assert.equal(result.tier, 1);
  assert.equal(result.project, root);
  assert.equal(result.projectRoot, root);
});

test("user association groups worktrees and deleted sessions by the origin remote", () => {
  const root = initRepo("worktree");
  const sibling = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-scope-worktree-parent-")), "sibling");
  git(["remote", "add", "upstream", "https://github.com/aaa/upstream.git"], root);
  git(["remote", "add", "origin", "git@github.com:acme/example.git"], root);
  git(["worktree", "add", "-q", "-b", "sibling", sibling], root);

  const first = associateUser({ cwd: root });
  const second = associateUser({ cwd: sibling });
  const deleted = associateUser({ cwd: "/deleted/example", remotes: ["git@github.com:acme/example.git"] });
  assert.equal(first.project, "github.com/acme/example");
  assert.equal(second.project, first.project);
  assert.equal(deleted.project, first.project);
  assert.notEqual(first.projectRoot, second.projectRoot);
});

test("user association groups local worktrees by their shared git directory", () => {
  const root = initRepo("local-worktree");
  const sibling = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-scope-local-worktree-parent-")), "sibling");
  git(["worktree", "add", "-q", "-b", "local-sibling", sibling], root);

  const first = associateUser({ cwd: root });
  const second = associateUser({ cwd: sibling });
  assert.equal(first.project, root);
  assert.equal(second.project, first.project);
  assert.notEqual(first.projectRoot, second.projectRoot);
});

test("user association groups a deleted worktree by recorded remote", () => {
  const result = associateUser({
    cwd: "/vanished/worktree/demo",
    remotes: ["https://github.com/acme/other.git"],
  });
  assert.equal(result.tier, 2);
  assert.equal(result.project, "github.com/acme/other");
  assert.equal(result.projectRoot, null);
});

test("user --strict drops sessions with only a dead unrecognisable cwd", () => {
  assert.equal(associateUser({ cwd: "/vanished/no-remote" }, { strict: true }), null);
  const kept = associateUser({ cwd: "/vanished/no-remote" }, { strict: false });
  assert.equal(kept.tier, 3);
  assert.ok(kept.project);
});

test("passesProjectFilter includes and excludes by project key or cwd", () => {
  const transcript = { project: "/repos/alpha", cwd: "/repos/alpha" };
  assert.equal(passesProjectFilter(transcript, { discovery: {} }), true);
  assert.equal(passesProjectFilter(transcript, { discovery: { includeProjects: ["**/alpha"] } }), true);
  assert.equal(passesProjectFilter(transcript, { discovery: { includeProjects: ["**/beta"] } }), false);
  assert.equal(passesProjectFilter(transcript, { discovery: { excludeProjects: ["**/alpha"] } }), false);
});
