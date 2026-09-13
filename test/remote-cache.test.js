import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { HostCache, ORPHAN_SAFETY_MS, PRUNE_MAX_AGE_MS, pruneHostCache } from "../src/discovery/cache.js";
import { initRepo, tmpdir } from "./helpers/remote.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "backpass.js");

test("cache index names cannot steer pruning outside the cache", () => {
  const stateDir = tmpdir("host-cache-index");
  const cache = new HostCache(stateDir).ensure();
  const victim = path.join(stateDir, "victim");
  fs.writeFileSync(victim, "keep");
  fs.writeFileSync(
    cache.indexPath,
    JSON.stringify({
      version: 1,
      entries: { "../victim": { usedAt: new Date(0).toISOString() } },
    }),
  );

  pruneHostCache(stateDir);
  assert.equal(fs.readFileSync(victim, "utf8"), "keep");
  assert.deepEqual(cache.readIndex().entries, {});
});

test("cache stats preserve host aliases that match prototype keys", () => {
  const stateDir = tmpdir("host-cache-stats");
  const cache = new HostCache(stateDir);
  const index = cache.readIndex();
  cache.write(
    index,
    { host: "__proto__", harness: "claude", key: "session", kind: "raw", mtimeMs: 1, bytes: 4 },
    Buffer.from("data"),
  );

  const stats = cache.stats(index);
  assert.equal(Object.hasOwn(stats, "__proto__"), true);
  assert.deepEqual(stats.__proto__, { entries: 1, bytes: 4 });
  assert.equal(Object.prototype.entries, undefined);
  assert.equal(Object.prototype.bytes, undefined);
});

test("a direct propose run prunes unused host cache entries", () => {
  const home = tmpdir("host-cache-propose-home");
  const repo = initRepo(path.join(home, "demo"), "https://github.com/acme/demo.git");
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "# Agent instructions\n");
  const cache = new HostCache(path.join(repo, ".backpass"));
  const index = cache.readIndex();
  const stale = cache.write(
    index,
    { host: "old-host", harness: "claude", key: "stale", kind: "raw", mtimeMs: 1, bytes: 5 },
    Buffer.from("stale"),
  );
  index.entries[stale.name].usedAt = new Date(Date.now() - PRUNE_MAX_AGE_MS - 1_000).toISOString();
  cache.writeIndex(index);

  const result = spawnSync(process.execPath, [CLI, "propose", "--host", "none", "--since", "all"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
  });

  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(stale.path), false);
  assert.deepEqual(cache.readIndex().entries, {});
});

test("concurrent cache work keeps fresh sibling payloads and uses private staging files", () => {
  const stateDir = tmpdir("host-cache-concurrent");
  const first = new HostCache(stateDir);
  const second = new HostCache(stateDir);
  const stagedFirst = first.stage("mac-home", "claude", "same-session", Buffer.from("first"));
  const stagedSecond = second.stage("mac-home", "claude", "same-session", Buffer.from("second"));
  assert.notEqual(stagedFirst.tmp, stagedSecond.tmp);
  assert.equal(fs.readFileSync(stagedFirst.tmp, "utf8"), "first");
  assert.equal(fs.readFileSync(stagedSecond.tmp, "utf8"), "second");

  const sibling = path.join(first.root, "a".repeat(64));
  fs.writeFileSync(sibling, "sibling run");
  const index = first.readIndex();
  assert.equal(first.prune(index), 0);
  assert.equal(fs.readFileSync(sibling, "utf8"), "sibling run");

  first.discard(stagedFirst);
  second.discard(stagedSecond);
});

test("cache pruning removes stale entries, orphan payloads, and abandoned temporary files", () => {
  const stateDir = tmpdir("host-cache");
  const cache = new HostCache(stateDir);
  const index = cache.readIndex();
  const current = cache.write(
    index,
    { host: "mac-home", harness: "claude", key: "current", kind: "raw", mtimeMs: 1, bytes: 7 },
    Buffer.from("current"),
  );
  const stale = cache.write(
    index,
    { host: "mac-home", harness: "claude", key: "stale", kind: "raw", mtimeMs: 1, bytes: 5 },
    Buffer.from("stale"),
  );
  index.entries[stale.name].usedAt = new Date(Date.now() - PRUNE_MAX_AGE_MS - 1_000).toISOString();
  cache.writeIndex(index);

  const orphan = path.join(cache.root, "f".repeat(64));
  const freshTemporary = path.join(cache.root, `${"e".repeat(64)}.tmp`);
  const staleTemporary = path.join(cache.root, `${"d".repeat(64)}.tmp`);
  fs.writeFileSync(orphan, "orphan");
  fs.writeFileSync(freshTemporary, "active");
  fs.writeFileSync(staleTemporary, "abandoned");
  const old = new Date(Date.now() - PRUNE_MAX_AGE_MS - 1_000);
  fs.utimesSync(
    orphan,
    new Date(Date.now() - ORPHAN_SAFETY_MS - 1_000),
    new Date(Date.now() - ORPHAN_SAFETY_MS - 1_000),
  );
  fs.utimesSync(staleTemporary, old, old);

  assert.equal(pruneHostCache(stateDir), 3);
  assert.ok(fs.existsSync(current.path));
  assert.ok(!fs.existsSync(stale.path));
  assert.ok(!fs.existsSync(orphan));
  assert.ok(fs.existsSync(freshTemporary));
  assert.ok(!fs.existsSync(staleTemporary));
  assert.ok(fs.existsSync(cache.indexPath));
  assert.deepEqual(Object.keys(cache.readIndex().entries), [current.name]);
});
