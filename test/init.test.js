import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { cmdInit } from "../src/commands/init.js";
import { loadConfig } from "../src/config.js";

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-init-"));
  git(["init", "-q", "-b", "main"], dir);
  // CI runners have no global git identity - configure one locally so the commit below works.
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  git(["commit", "--allow-empty", "-q", "-m", "init"], dir);
  return dir;
}

async function runInit(dir, flags = {}) {
  const repo = { root: dir, realRoot: dir, name: path.basename(dir), worktrees: [dir], remotes: [] };
  const config = loadConfig(dir);
  return cmdInit({ repo, config, flags });
}

test("init excludes .backpass/ via .git/info/exclude and never touches a tracked .gitignore", async () => {
  const dir = initRepo();

  await runInit(dir);

  const excludePath = path.join(dir, ".git", "info", "exclude");
  assert.match(fs.readFileSync(excludePath, "utf8"), /^\.backpass\/$/m);
  assert.equal(fs.existsSync(path.join(dir, ".gitignore")), false);
});

test("running init twice does not duplicate the exclude line", async () => {
  const dir = initRepo();

  await runInit(dir);
  await runInit(dir, { force: true });

  const excludePath = path.join(dir, ".git", "info", "exclude");
  const lines = fs
    .readFileSync(excludePath, "utf8")
    .split("\n")
    .filter((l) => l.trim() === ".backpass/");
  assert.equal(lines.length, 1);
});

test("a non-git directory is handled gracefully: no error, no .gitignore created", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-init-nongit-"));

  await assert.doesNotReject(() => runInit(dir));

  assert.equal(fs.existsSync(path.join(dir, ".gitignore")), false);
  assert.equal(fs.existsSync(path.join(dir, ".git")), false);
});

test("a tracked .gitignore that already lists .backpass/ (from an older backpass) is left untouched", async () => {
  const dir = initRepo();
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n.backpass/\n");
  const before = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");

  await runInit(dir);

  assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), before, "the tracked file is never rewritten");
  // The local exclude is still the source of truth going forward.
  const excludePath = path.join(dir, ".git", "info", "exclude");
  assert.match(fs.readFileSync(excludePath, "utf8"), /^\.backpass\/$/m);
});
