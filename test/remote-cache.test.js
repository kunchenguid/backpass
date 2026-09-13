import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { HostCache, PRUNE_MAX_AGE_MS, pruneHostCache } from "../src/discovery/cache.js";
import { tmpdir } from "./helpers/remote.js";

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
