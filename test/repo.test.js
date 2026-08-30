import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { attachSiblingClones, ensureLocalExclude, resolveRepo } from "../src/repo.js";

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initRepo() {
  const dir = tempDir("backpass-repo-");
  git(["init", "-q", "-b", "main"], dir);
  // CI runners have no global git identity - configure one locally so the commit below works.
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  git(["commit", "--allow-empty", "-q", "-m", "init"], dir);
  return dir;
}

test("writes the line to .git/info/exclude, not a tracked .gitignore", () => {
  const dir = initRepo();

  const result = ensureLocalExclude(dir, ".backpass/");

  assert.equal(result.status, "added");
  const excludePath = path.join(dir, ".git", "info", "exclude");
  assert.equal(result.path, excludePath);
  assert.match(fs.readFileSync(excludePath, "utf8"), /^\.backpass\/$/m);
  assert.equal(fs.existsSync(path.join(dir, ".gitignore")), false, "no tracked .gitignore is created");
});

test("is idempotent - a second call does not duplicate the line", () => {
  const dir = initRepo();

  ensureLocalExclude(dir, ".backpass/");
  const second = ensureLocalExclude(dir, ".backpass/");

  assert.equal(second.status, "present");
  const excludePath = path.join(dir, ".git", "info", "exclude");
  const lines = fs
    .readFileSync(excludePath, "utf8")
    .split("\n")
    .filter((l) => l.trim() === ".backpass/");
  assert.equal(lines.length, 1);
});

test("resolves the exclude path via `git rev-parse --git-path info/exclude` in a worktree", () => {
  const dir = initRepo();
  const worktree = tempDir("backpass-worktree-");
  fs.rmdirSync(worktree); // `git worktree add` requires the target not to exist yet
  git(["worktree", "add", "-q", worktree, "-b", "backpass-test-branch"], dir);

  const result = ensureLocalExclude(worktree, ".backpass/");

  assert.equal(result.status, "added");
  // The worktree's own `.git` is a file, not a directory - the real exclude file
  // lives in the *common* git dir, which only `--git-path` (not a hardcoded
  // `<root>/.git/info/exclude`) resolves correctly.
  assert.ok(fs.statSync(path.join(worktree, ".git")).isFile(), "worktree .git is a file");
  assert.equal(fs.existsSync(path.join(worktree, ".git", "info", "exclude")), false);
  const commonExclude = path.join(dir, ".git", "info", "exclude");
  assert.equal(result.path, fs.realpathSync(commonExclude));
  assert.match(fs.readFileSync(commonExclude, "utf8"), /^\.backpass\/$/m);
});

test("sibling clones that share a remote are listed; a different remote is not", () => {
  const parent = tempDir("backpass-sib-repo-");
  const remote = "https://github.com/acme/demo.git";
  const primary = path.join(parent, "primary");
  const sibling = path.join(parent, "sibling");
  const other = path.join(parent, "other");
  for (const dir of [primary, sibling, other]) {
    fs.mkdirSync(dir, { recursive: true });
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "test"], dir);
    git(["commit", "--allow-empty", "-q", "-m", "init"], dir);
  }
  git(["remote", "add", "origin", remote], primary);
  git(["remote", "add", "origin", remote], sibling);
  git(["remote", "add", "origin", "https://github.com/acme/other.git"], other);

  const repo = attachSiblingClones(resolveRepo(primary));
  const siblingReal = fs.realpathSync(sibling);
  assert.ok(repo.siblingWorktrees.includes(siblingReal));
  assert.equal(repo.siblingWorktrees.includes(fs.realpathSync(other)), false);
  assert.equal(repo.worktrees.includes(siblingReal), false);
});

test("local relative remotes are resolved from each checkout", () => {
  const parent = tempDir("backpass-relative-remotes-");
  const origin = path.join(parent, "origin.git");
  git(["init", "--bare", "-q", origin], parent);

  const primary = path.join(parent, "primary");
  const matching = path.join(parent, "nested", "matching");
  const foreignParent = path.join(parent, "foreign");
  const foreign = path.join(foreignParent, "checkout");
  for (const dir of [primary, matching, foreign]) {
    fs.mkdirSync(dir, { recursive: true });
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "test"], dir);
    git(["commit", "--allow-empty", "-q", "-m", "init"], dir);
  }
  git(["remote", "add", "origin", "../origin.git"], primary);
  git(["remote", "add", "origin", "../../origin.git"], matching);
  git(["remote", "add", "origin", "../origin.git"], foreign);

  const repo = attachSiblingClones(resolveRepo(primary), [path.dirname(matching), foreignParent]);
  assert.ok(repo.siblingWorktrees.includes(fs.realpathSync(matching)));
  assert.equal(repo.siblingWorktrees.includes(fs.realpathSync(foreign)), false);
});

test("relative clone roots are resolved from the repository root", () => {
  const parent = tempDir("backpass-relative-root-");
  const primary = path.join(parent, "primary");
  const sibling = path.join(parent, "catalog", "sibling");
  const remote = "https://github.com/acme/demo.git";
  for (const dir of [primary, sibling]) {
    fs.mkdirSync(dir, { recursive: true });
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "test"], dir);
    git(["commit", "--allow-empty", "-q", "-m", "init"], dir);
    git(["remote", "add", "origin", remote], dir);
  }

  const repo = attachSiblingClones(resolveRepo(primary), ["../catalog"]);
  assert.ok(repo.siblingWorktrees.includes(fs.realpathSync(sibling)));
});

test("a non-git directory is skipped gracefully, without creating anything", () => {
  const dir = tempDir("backpass-nongit-");

  const result = ensureLocalExclude(dir, ".backpass/");

  assert.equal(result.status, "no-git");
  assert.equal(fs.existsSync(path.join(dir, ".git")), false);
  assert.equal(fs.existsSync(path.join(dir, ".gitignore")), false);
});
