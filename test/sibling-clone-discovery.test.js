import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { discoverForRun } from "../src/commands/scan.js";
import { resolveRepo } from "../src/repo.js";
import { loadConfig } from "../src/config.js";

/**
 * A Claude session whose cwd is a sibling clone sharing origin used to vanish:
 * Claude records no remote, and `git worktree list` cannot see another clone.
 * These tests drive real discovery (enumerate → classify → associate).
 */

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function initClone(dir, remote) {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  git(["commit", "--allow-empty", "-q", "-m", "init"], dir);
  if (remote) git(["remote", "add", "origin", remote], dir);
  return fs.realpathSync(dir);
}

function writeClaudeSession(homeDir, cwd, id, text) {
  const projectDir = path.join(homeDir, ".claude", "projects", cwd.replace(/[/.]/g, "-"));
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${id}.jsonl`);
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "mode", mode: "normal", sessionId: id }),
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        type: "user",
        message: { role: "user", content: text },
        uuid: "u1",
        timestamp: "2026-08-20T10:00:00.000Z",
        cwd,
        gitBranch: "main",
        sessionId: id,
      }),
    ].join("\n") + "\n",
  );
  return file;
}

function configFor(repoRoot) {
  const config = loadConfig(repoRoot, { discovery: { harnesses: ["claude"], since: "all" } });
  const cache = { version: 1, entries: {} };
  config.state = { readScanCache: () => cache, writeScanCache: () => {} };
  return config;
}

/**
 * @param {string} repoRoot
 * @param {{ homeDir: string, cloneRoots?: string[], strict?: boolean }} opts
 */
function discoverFrom(repoRoot, { homeDir, cloneRoots = [], strict = false }) {
  const prevHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const repo = resolveRepo(repoRoot);
    const config = configFor(repoRoot);
    config.discovery.cloneRoots = cloneRoots;
    return discoverForRun({ repo, config, strict, limit: null });
  } finally {
    process.env.HOME = prevHome;
  }
}

function userEntries(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name !== ".git")
    .sort();
}

test("discovery attaches a Claude session whose cwd is a sibling clone sharing the remote", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-sib-"));
  const remote = "https://github.com/acme/sshhhip.git";
  const primary = initClone(path.join(parent, "sshhhip-firstmate"), remote);
  const sibling = initClone(path.join(parent, "sshhhip"), remote);
  const other = initClone(path.join(parent, "unrelated"), "https://github.com/acme/other.git");
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-sib-home-"));

  writeClaudeSession(homeDir, sibling, "sibling-session", "Ship the SSHHIP parser.");
  writeClaudeSession(homeDir, other, "foreign-session", "Work on a different repo.");

  const beforeSibling = userEntries(sibling);
  const marker = path.join(sibling, "KEEP.txt");
  fs.writeFileSync(marker, "untouched\n");
  const statusBefore = git(["status", "--porcelain"], sibling);

  const { transcripts } = await discoverFrom(primary, { homeDir });

  assert.deepEqual(
    transcripts.map((t) => t.nativeId).sort(),
    ["sibling-session"],
    "the sibling clone session is in the corpus; the foreign clone is not",
  );
  assert.equal(transcripts[0].association.tier, 1.5);
  assert.equal(transcripts[0].association.confidence, "sibling");
  assert.equal(transcripts[0].cwd, sibling);

  const strict = await discoverFrom(primary, { homeDir, strict: true });
  assert.equal(strict.transcripts.length, 1);
  assert.equal(strict.transcripts[0].association.tier, 1.5);

  assert.deepEqual(userEntries(sibling).sort(), [...beforeSibling, "KEEP.txt"].sort());
  assert.equal(fs.readFileSync(marker, "utf8"), "untouched\n");
  assert.equal(fs.existsSync(path.join(sibling, ".backpass")), false);
  assert.equal(git(["status", "--porcelain"], sibling), statusBefore);
});

test("a nested extra cloneRoot attaches a clone that is not a directory sibling", async () => {
  const primaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-pri-"));
  const extraParent = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-extra-"));
  const remote = "https://github.com/acme/sshhhip.git";
  const primary = initClone(path.join(primaryParent, "checkout"), remote);
  const nested = initClone(path.join(extraParent, "lab", "sshhhip"), remote);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-extra-home-"));

  writeClaudeSession(homeDir, nested, "nested-session", "History lives in the lab clone.");

  const without = await discoverFrom(primary, { homeDir });
  assert.equal(without.transcripts.length, 0, "a non-sibling clone is not found by default");

  const withRoot = await discoverFrom(primary, { homeDir, cloneRoots: [path.join(extraParent, "lab")] });
  assert.equal(withRoot.transcripts.length, 1);
  assert.equal(withRoot.transcripts[0].nativeId, "nested-session");
  assert.equal(withRoot.transcripts[0].association.tier, 1.5);
});

test("a worktree of the sibling clone is attached, not only the clone root", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-wt-"));
  const remote = "https://github.com/acme/sshhhip.git";
  const primary = initClone(path.join(parent, "primary"), remote);
  const sibling = initClone(path.join(parent, "sibling"), remote);
  const worktree = path.join(parent, "sibling-wt");
  git(["worktree", "add", "-q", worktree, "-b", "wt-branch"], sibling);
  const wtReal = fs.realpathSync(worktree);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-wt-home-"));

  writeClaudeSession(homeDir, wtReal, "wt-session", "Session ran in the sibling worktree.");

  const { transcripts } = await discoverFrom(primary, { homeDir });
  assert.equal(transcripts.length, 1);
  assert.equal(transcripts[0].nativeId, "wt-session");
  assert.equal(transcripts[0].association.tier, 1.5);
  assert.match(transcripts[0].association.reason, /sibling clone/);
});
