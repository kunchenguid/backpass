import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as codex from "../src/discovery/adapters/codex.js";
import { discoverTranscripts } from "../src/discovery/index.js";
import { discover as discoverProbe } from "../src/discovery/remote/probe.js";
import { classifyInteraction, NON_INTERACTIVE } from "../src/interaction.js";
import { SELF_SESSION_SENTINEL } from "../src/sentinel.js";

const fixture = fileURLToPath(new URL("./fixtures/codex-child-rollout.jsonl", import.meta.url));

function candidateFor(file) {
  const stat = fs.statSync(file);
  return { key: file, path: file, bytes: stat.size, mtimeMs: stat.mtimeMs };
}

test("Codex child metadata keeps physical identity and structured ancestry", () => {
  const child = codex.classify(candidateFor(fixture));
  assert.equal(child.id, "child-rollout");
  assert.equal(child.parentSessionId, "parent-rollout");
  assert.equal(child.interactionSignals.source, "subagent");
  assert.equal(classifyInteraction({ harness: "codex", ...child }), NON_INTERACTIVE);
});

test("Codex child replay cannot be read as an independent task", () => {
  assert.throws(() => codex.read({ path: fixture }), /delegated rollout/);
});

function setup(t) {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-codex-ancestry-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dir = path.join(root, "sessions", ...new Date(now).toISOString().slice(0, 10).split("-"));
  fs.mkdirSync(dir, { recursive: true });
  const write = (id, metadata = {}, text = "Fix the parser.") => {
    const file = path.join(dir, `rollout-${id}.jsonl`);
    fs.writeFileSync(
      file,
      [
        { type: "session_meta", payload: { id, cwd: root, source: "cli", ...metadata } },
        { type: "response_item", payload: { type: "message", role: "user", content: text } },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    fs.utimesSync(file, new Date(now), new Date(now));
    return file;
  };
  const parent = write("parent");
  write("child", { parent_thread_id: "parent" });
  write("grandchild", { source: { subagent: { thread_spawn: { parent_thread_id: "child", depth: 2 } } } });
  write("orphan", { parent_thread_id: "missing" });
  write("subagent", { source: { subagent: "review" } });
  write("self", {}, `${SELF_SESSION_SENTINEL}\nAnalyze memory.`);
  write("self-child", { parent_thread_id: "self" }, "Review just this delegated slice.");
  write("self-grandchild", { parent_thread_id: "self-child" }, "Inspect one function.");
  return { root, parent, write, now };
}

test("Codex discovery excludes delegated evidence locally, remotely, and from a warm legacy cache", async (t) => {
  const { root, parent } = setup(t);
  const cache = { version: 1, entries: {} };
  const config = {
    discovery: { harnesses: ["codex"], since: "all", hosts: [] },
    state: { readScanCache: () => cache, writeScanCache: () => {} },
  };
  const repo = { name: "demo", root, worktrees: [root], remotes: [] };
  const scope = { kind: "user", associate: () => ({ tier: 1, project: "demo", projectRoot: root }) };
  // Pre-change cache entries have interaction signals but no ancestry or dependency version.
  for (const candidate of codex.enumerate()) {
    cache.entries[`codex:${candidate.key}`] = {
      mtimeMs: candidate.mtimeMs,
      bytes: candidate.bytes,
      descriptor: { id: path.basename(candidate.path), cwd: root, interactionSignals: {} },
    };
  }
  for (let run = 0; run < 2; run += 1) {
    const result = await discoverTranscripts({ repo, config, scope });
    assert.deepEqual(
      result.transcripts.map((row) => row.nativeId),
      ["parent"],
    );
    assert.equal(result.transcripts[0].path, parent);
    assert.equal(result.perHarness.codex.error, null);
    if (run === 1) assert.equal(result.perHarness.codex.cached, 8);
  }
  const remote = await discoverProbe({ harnesses: ["codex"] });
  assert.deepEqual(
    remote.transcripts.map((row) => row.id),
    ["parent"],
  );
  assert.equal(remote.harnesses.codex.error, null);
});

test("Codex child exclusion survives a missing or out-of-window self ancestor", async (t) => {
  const { write, now } = setup(t);
  const old = write("old-self", {}, `${SELF_SESSION_SENTINEL}\nAnalyze memory.`);
  fs.utimesSync(old, new Date(now - 120_000), new Date(now - 120_000));
  write("recent-child", { parent_thread_id: "old-self" });
  const result = await discoverProbe({ harnesses: ["codex"], cutoffMs: now - 60_000 });
  assert.deepEqual(
    result.transcripts.map((row) => row.id),
    ["parent"],
  );
});
