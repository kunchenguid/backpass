import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { analyzeTranscripts } from "../src/analyze.js";
import { State } from "../src/state.js";

/**
 * Regression for the outcome-overwrite fix (#203 follow-up): a successful model call
 * whose evidence write then throws (e.g. ENOSPC) must still count as "called a model"
 * for the warm-up gate. Before the fix, the catch block unconditionally recomputed
 * `outcome` from `err.modelCallAttempted` alone, which is unset for an error raised by
 * `state.writeEvidence` after `analyzeOne` already returned - so a disk fault on the
 * very first transcript silently fell back to the pre-#203 fully-parallel fan-out
 * instead of serializing a second transcript's call first.
 *
 * Drives the real `analyzeTranscripts`/`analyzePending` pipeline with real session
 * files and a `State` subclass that injects exactly one write fault, observing the
 * actual call overlap it produces - not the source of the fix.
 */

function initRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-warmup-fault-repo-")));
  return dir;
}

function writeSession(home, id) {
  const dir = path.join(home, ".pi", "agent", "sessions", id);
  fs.mkdirSync(dir, { recursive: true });
  const entries = [
    { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: "/repo" },
    { type: "message", message: { role: "user", content: `Do the ${id} work.` } },
    { type: "message", message: { role: "assistant", content: "Working on it." } },
    { type: "message", message: { role: "user", content: "Now run the tests too." } },
    { type: "message", message: { role: "assistant", content: "Tests pass." } },
  ];
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return file;
}

test("a model call that succeeds but whose evidence write then throws still counts as the warm-up call", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-warmup-fault-home-"));
  const dir = initRepo();
  const ids = ["t1", "t2", "t3", "t4"];
  const transcripts = ids.map((id) => ({
    harness: "pi",
    id: `pi-${id}`,
    nativeId: id,
    path: writeSession(home, id),
    mtimeMs: Date.now(),
    bytes: 200,
  }));

  class FaultingState extends State {
    writeEvidence(transcript, evidence) {
      if (evidence.status === "ok" && transcript.nativeId === "t1" && !this.faulted) {
        this.faulted = true;
        throw new Error("ENOSPC: no space left on device, write");
      }
      return super.writeEvidence(transcript, evidence);
    }
  }
  const state = new FaultingState(dir, { exclude: false }).ensure();

  const calls = [];
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const config = {
    state,
    jobs: 4,
    discovery: { minUserTurns: 2 },
    agents: {
      resolve: async () => ({ agent: "claude" }),
      withFallthrough: async () => {
        const call = { id: calls.length, start: Date.now() };
        calls.push(call);
        await delay(50);
        call.end = Date.now();
        return { text: JSON.stringify({ positive: [], negative: [], gaps: [] }) };
      },
    },
  };

  const summary = await analyzeTranscripts({
    transcripts,
    memoryFile: { path: "AGENTS.md", units: [] },
    memoryHash: "test-memory",
    repo: { root: dir },
    config,
  });

  // t1's model call succeeded, but its evidence write faulted: the record on disk must
  // reflect the write failure (status "failed"), not a successful "ok".
  const evidence = state.listEvidence();
  const t1 = evidence.find((record) => record.transcript.id === "pi-t1");
  assert.equal(t1.status, "failed");
  assert.equal(summary.failed, 1);
  assert.equal(summary.analyzed, 3);

  // The fix: t1 still counted as "called a model", so only one call ran start-to-finish
  // before the rest fanned out together in parallel. Without the fix, the warm-up would
  // not have recognized t1 as called and would have serialized a second transcript too,
  // i.e. the second call would not start until after the first one's `end`.
  assert.equal(calls.length, 4);
  const [first, ...rest] = calls.sort((a, b) => a.start - b.start);
  assert.ok(
    first.end <= rest[0].start,
    `expected the first call to finish before any other started: ${JSON.stringify(calls)}`,
  );
  const restOverlap = rest.every((call) => call.start < rest[0].end);
  assert.ok(restOverlap, `expected the remaining calls to run concurrently with each other: ${JSON.stringify(calls)}`);
});
