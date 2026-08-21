import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { associate, globToRegExp, passesStrict } from "../src/discovery/association.js";
import { normalizeRemote } from "../src/repo.js";

/** A repo identity backed by one real directory, so tier-1/tier-3 liveness is genuine. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-assoc-"));
  const live = fs.realpathSync(dir);
  return {
    repo: {
      name: "demo",
      root: live,
      realRoot: live,
      worktrees: [live],
      remotes: ["github.com/acme/demo"],
    },
    live,
  };
}

test("normalizeRemote collapses ssh, https and .git spellings to one identity", () => {
  const expected = "github.com/acme/demo";
  assert.equal(normalizeRemote("git@github.com:acme/demo.git"), expected);
  assert.equal(normalizeRemote("https://github.com/acme/demo"), expected);
  assert.equal(normalizeRemote("https://user@github.com/acme/demo.git/"), expected);
  assert.equal(normalizeRemote("ssh://git@github.com/acme/demo.git"), expected);
  assert.equal(normalizeRemote(""), null);
});

test("tier 1: a cwd that is a worktree, or sits inside one, is deterministic", () => {
  const { repo, live } = makeRepo();

  const exact = associate({ cwd: live }, repo);
  assert.equal(exact.tier, 1);
  assert.equal(exact.confidence, "exact");

  const nested = associate({ cwd: path.join(live, "src", "deep") }, repo);
  assert.equal(nested.tier, 1);
  assert.equal(nested.confidence, "nested");
});

test("tier 2: a recorded remote associates a session whose worktree is long gone", () => {
  const { repo } = makeRepo();
  const result = associate(
    { cwd: "/vanished/worktree/somewhere", remotes: ["https://github.com/acme/demo.git"] },
    repo,
  );
  assert.equal(result.tier, 2);
  assert.equal(result.confidence, "remote");
});

test("tier 3: a dead path ending in the repo name is best-effort only", () => {
  const { repo } = makeRepo();
  const result = associate({ cwd: "/vanished/treehouse/7/demo" }, repo);
  assert.equal(result.tier, 3);
  assert.equal(result.confidence, "path");
});

test("tier 3 never fires for a live path that belongs to a different repo", () => {
  const { repo } = makeRepo();
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "demo-")));
  assert.equal(associate({ cwd: other }, repo), null);
});

test("a user worktree glob promotes a dead path to tier 3", () => {
  const { repo } = makeRepo();
  const cwd = "/vanished/.treehouse/demo-abc123/4/checkout";

  assert.equal(associate({ cwd }, repo), null);

  const globbed = associate({ cwd }, repo, { worktreeGlobs: ["/vanished/.treehouse/demo-*/*/*"] });
  assert.equal(globbed.tier, 3);
  assert.equal(globbed.confidence, "glob");
});

test("--strict keeps only the deterministic tiers", () => {
  assert.equal(passesStrict({ tier: 1 }, true), true);
  assert.equal(passesStrict({ tier: 2 }, true), true);
  assert.equal(passesStrict({ tier: 3 }, true), false);
  assert.equal(passesStrict({ tier: 3 }, false), true);
  assert.equal(passesStrict(null, false), false);
});

test("globToRegExp treats * as one segment and ** as many", () => {
  assert.ok(globToRegExp("/a/*/c").test("/a/b/c"));
  assert.ok(!globToRegExp("/a/*/c").test("/a/b/x/c"));
  assert.ok(globToRegExp("/a/**/c").test("/a/b/x/c"));
});
