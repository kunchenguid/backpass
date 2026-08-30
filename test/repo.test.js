import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { associate } from "../src/discovery/association.js";
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
  git(["remote", "add", "origin", "ssh://git@github.com:22/acme/demo.git"], sibling);
  git(["remote", "add", "origin", "https://github.com/acme/other.git"], other);

  const repo = attachSiblingClones(resolveRepo(primary));
  const siblingReal = fs.realpathSync(sibling);
  assert.ok(repo.siblingWorktrees.includes(siblingReal));
  assert.equal(repo.siblingWorktrees.includes(fs.realpathSync(other)), false);
  assert.equal(repo.worktrees.includes(siblingReal), false);
});

test("scheme-default ports share a sibling clone identity", () => {
  const parent = tempDir("backpass-default-ports-");
  const primary = path.join(parent, "primary");
  const secureSibling = path.join(parent, "secure-sibling");
  const plainSibling = path.join(parent, "plain-sibling");
  const gitSibling = path.join(parent, "git-sibling");
  for (const dir of [primary, secureSibling, plainSibling, gitSibling]) {
    fs.mkdirSync(dir);
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "test"], dir);
    git(["commit", "--allow-empty", "-q", "-m", "init"], dir);
  }
  git(["remote", "add", "secure", "https://example.com/acme/secure.git"], primary);
  git(["remote", "add", "plain", "http://example.com/acme/plain.git"], primary);
  git(["remote", "add", "git", "git://example.com/acme/git.git"], primary);
  git(["remote", "add", "origin", "https://example.com:443/acme/secure.git"], secureSibling);
  git(["remote", "add", "origin", "http://example.com:80/acme/plain.git"], plainSibling);
  git(["remote", "add", "origin", "git://example.com:9418/acme/git.git"], gitSibling);

  const repo = attachSiblingClones(resolveRepo(primary));
  assert.ok(repo.siblingWorktrees.includes(fs.realpathSync(secureSibling)));
  assert.ok(repo.siblingWorktrees.includes(fs.realpathSync(plainSibling)));
  assert.ok(repo.siblingWorktrees.includes(fs.realpathSync(gitSibling)));
});

test("network remote paths remain case-sensitive", () => {
  const parent = tempDir("backpass-network-case-");
  const primary = path.join(parent, "primary");
  const foreign = path.join(parent, "foreign");
  for (const dir of [primary, foreign]) {
    fs.mkdirSync(dir);
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "test"], dir);
    git(["commit", "--allow-empty", "-q", "-m", "init"], dir);
  }
  git(["remote", "add", "origin", "https://example.com/Team/Repo.git"], primary);
  git(["remote", "add", "origin", "https://example.com/team/repo.git"], foreign);

  const repo = attachSiblingClones(resolveRepo(primary));
  assert.equal(repo.siblingWorktrees.includes(fs.realpathSync(foreign)), false);
});

test("local remotes with spaces retain distinct clone identities", () => {
  const parent = tempDir("backpass-spaced-remotes-");
  const firstRemote = path.join(parent, "Project One.git");
  const secondRemote = path.join(parent, "Project Two.git");
  git(["init", "--bare", "-q", firstRemote], parent);
  git(["init", "--bare", "-q", secondRemote], parent);

  const primary = path.join(parent, "primary");
  const matching = path.join(parent, "matching");
  const foreign = path.join(parent, "foreign");
  for (const dir of [primary, matching, foreign]) {
    fs.mkdirSync(dir);
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "test"], dir);
    git(["commit", "--allow-empty", "-q", "-m", "init"], dir);
  }
  git(["remote", "add", "origin", firstRemote], primary);
  git(["remote", "add", "origin", firstRemote], matching);
  git(["remote", "add", "origin", secondRemote], foreign);

  const repo = attachSiblingClones(resolveRepo(primary));
  assert.ok(repo.siblingWorktrees.includes(fs.realpathSync(matching)));
  assert.equal(repo.siblingWorktrees.includes(fs.realpathSync(foreign)), false);
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

  const recorded = associate({ cwd: "/vanished/checkout", remotes: ["../origin.git"] }, repo);
  assert.equal(recorded.tier, 2);
  assert.equal(recorded.confidence, "remote");
});

test("distinct local paths remain distinct clone identities", () => {
  const parent = tempDir("backpass-local-identity-");
  const remotes = path.join(parent, "remotes");
  const dottedRemote = path.join(remotes, "project.git");
  const plainRemote = path.join(remotes, "project");
  fs.mkdirSync(remotes);
  git(["init", "--bare", "-q", dottedRemote], parent);
  git(["init", "--bare", "-q", plainRemote], parent);

  const primary = path.join(parent, "primary");
  const foreign = path.join(parent, "foreign");
  for (const dir of [primary, foreign]) {
    fs.mkdirSync(dir);
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "test"], dir);
    git(["commit", "--allow-empty", "-q", "-m", "init"], dir);
  }
  git(["remote", "add", "origin", dottedRemote], primary);
  git(["remote", "add", "origin", plainRemote], foreign);

  const repo = attachSiblingClones(resolveRepo(primary));
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
