import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { State } from "../src/state.js";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-state-"));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  git(["commit", "--allow-empty", "-q", "-m", "init"], dir);
  return dir;
}

test("creating the state dir without a prior `init` excludes .backpass/ from git", () => {
  const dir = initRepo();
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# memory\n");

  const state = new State(dir).ensure();
  state.writeScanCache({ version: 1, entries: {} });

  assert.equal(state.exclude.status, "added");
  const exclude = fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /^\.backpass\/$/m);
  assert.equal(fs.existsSync(path.join(dir, ".gitignore")), false, "tracked .gitignore is untouched");

  const status = git(["status", "--porcelain", "--untracked-files=all"], dir);
  assert.doesNotMatch(status, /\.backpass/, `state dir leaked into git status:\n${status}`);
  assert.match(status, /AGENTS\.md/, "user memory files are still visible to git");
});

test("ensure() is idempotent alongside `init` - the exclude line is written once", () => {
  const dir = initRepo();

  new State(dir).ensure();
  const second = new State(dir).ensure();

  assert.equal(second.exclude.status, "present");
  const lines = fs
    .readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8")
    .split("\n")
    .filter((l) => l.trim() === ".backpass/");
  assert.equal(lines.length, 1);
});

test("ensure() outside a git repo creates the state dir and does not throw", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-nogit-"));

  const state = new State(dir).ensure();

  assert.equal(state.exclude.status, "no-git");
  assert.ok(fs.existsSync(state.evidenceDir));
});
