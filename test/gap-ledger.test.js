import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { State } from "../src/state.js";
import { parseMemoryUnits } from "../src/memory.js";
import { foldForRun } from "../src/commands/propose.js";
import { foldEvidence } from "../src/fold.js";

const MEMORY_PATH = "AGENTS.md";
const DAY = 86_400_000;

function memoryFile(text = "# T\n\n- Run pnpm test before pushing.\n- Keep the README current.\n") {
  return { path: MEMORY_PATH, units: parseMemoryUnits(text) };
}

function record(id, gaps, { startedAt = Date.parse("2026-08-01T00:00:00Z"), memoryHash = "h1" } = {}) {
  return {
    status: "ok",
    transcript: { id, harness: "claude", startedAt },
    memoryPath: MEMORY_PATH,
    memoryHash,
    positive: [],
    negative: [],
    gaps: gaps.map((proposedInstruction) => ({
      proposedInstruction,
      mistake: "re-derived it",
      quote: `quote from ${id}`,
      recurrenceRisk: "high",
    })),
  };
}

/** A throwaway `.backpass/` and a ctx shaped like the one `foldForRun` reads. */
function harness(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-ledger-"));
  const state = new State(root).ensure();
  const ctx = { config: { state, minGapEvidence: 2, gapLedgerMaxAge: "90d", ...overrides } };
  return { root, state, ctx };
}

/** One backpass run: the evidence files on disk at the time, then the fold. */
async function run(h, records, file = memoryFile()) {
  for (const r of records) h.state.writeEvidence(r.transcript.id, r);
  return foldForRun(h.ctx, file);
}

const GAP = "Read docs/db.md before writing queries.";
const GAP_REPHRASED = "Read docs/db.md before writing any queries";

test("a gap seen once now and once on a later run accumulates to two sessions and graduates", async () => {
  const h = harness();
  const first = await run(h, [record("claude-s1", [GAP])]);
  assert.equal(first.gaps.length, 0, "one session is not enough on the first run");
  assert.equal(first.totals.droppedGapSingletons, 1);

  // Later run: s1's evidence was rewritten against a changed memory file and the model
  // no longer mentions the gap; a new session s2 reports it in different words.
  const second = await run(h, [record("claude-s1", [], { memoryHash: "h2" }), record("claude-s2", [GAP_REPHRASED])]);
  assert.equal(second.gaps.length, 1, "the gap graduates once two distinct sessions have reported it");
  assert.equal(second.gaps[0].sessions, 2);
  assert.equal(second.gaps[0].proposedInstruction, GAP, "the shortest phrasing is canonical");
  assert.deepEqual(second.gaps[0].quotes.map((q) => q.text).sort(), ["quote from claude-s1", "quote from claude-s2"]);
});

test("the same session is never double-counted across runs", async () => {
  const h = harness();
  await run(h, [record("claude-s1", [GAP])]);
  const again = await run(h, [record("claude-s1", [GAP_REPHRASED])]);
  assert.equal(again.gaps.length, 0, "re-observing s1 must not graduate a one-off");
  const third = await run(h, [record("claude-s1", [GAP])]);
  assert.equal(third.gaps.length, 0);

  const ledger = h.state.readGapLedger();
  const entries = Object.values(ledger.entries);
  assert.equal(entries.length, 1, "rephrasings of one gap share one ledger entry");
  assert.deepEqual(Object.keys(entries[0].sessions), ["claude-s1"]);
});

test("a genuine one-off never graduates, however many runs see it", async () => {
  const h = harness();
  for (let i = 0; i < 5; i += 1) {
    const summary = await run(h, [record("claude-s1", [GAP]), record("claude-s2", ["Never force-push to main."])]);
    assert.equal(summary.gaps.length, 0);
    assert.equal(summary.totals.droppedGapSingletons, 2);
  }
});

test("two distinct sessions in a single run still clear the gate as before", async () => {
  const h = harness();
  const summary = await run(h, [record("claude-s1", [GAP]), record("codex-s2", [GAP_REPHRASED])]);
  assert.equal(summary.gaps.length, 1);
  assert.equal(summary.gaps[0].sessions, 2);
  assert.equal(summary.totals.gapClusters, 1);
  assert.equal(summary.totals.droppedGapSingletons, 0);
});

/** Backdate every sighting in the ledger, as if the runs had happened `days` ago. */
function age(h, days) {
  const ledger = h.state.readGapLedger();
  const then = new Date(Date.now() - days * DAY).toISOString();
  for (const entry of Object.values(ledger.entries)) {
    for (const obs of Object.values(entry.sessions)) obs.firstObservedAt = then;
  }
  h.state.writeGapLedger(ledger);
}

test("a sighting older than gapLedgerMaxAge expires instead of resurfacing indefinitely", async () => {
  const h = harness({ gapLedgerMaxAge: "90d" });
  await run(h, [record("claude-s1", [GAP])]);
  age(h, 120);
  const summary = await run(h, [record("claude-s2", [GAP])]);
  assert.equal(summary.gaps.length, 0, "an expired sighting must not corroborate a fresh one");
  assert.deepEqual(
    Object.values(h.state.readGapLedger().entries).flatMap((e) => Object.keys(e.sessions)),
    ["claude-s2"],
  );

  const forever = harness({ gapLedgerMaxAge: "all" });
  await run(forever, [record("claude-s1", [GAP])]);
  age(forever, 120);
  const kept = await run(forever, [record("claude-s2", [GAP])]);
  assert.equal(kept.gaps.length, 1, "`all` disables expiry");
});

test("re-analysis of a session does not restart its expiry clock", async () => {
  const h = harness({ gapLedgerMaxAge: "90d" });
  await run(h, [record("claude-s1", [GAP])]);
  age(h, 120);
  const summary = await run(h, [record("claude-s1", [GAP], { memoryHash: "h2" }), record("claude-s2", [GAP])]);
  assert.equal(summary.gaps.length, 0, "the re-seen old sighting keeps its original first-seen time");
});

test("a gap the memory file now covers is retired from the ledger", async () => {
  const h = harness();
  await run(h, [record("claude-s1", [GAP])]);
  const addressed = memoryFile("# T\n\n- Read docs/db.md before writing queries.\n");
  const summary = await run(h, [record("claude-s2", [GAP])], addressed);
  assert.equal(summary.gaps.length, 0, "a covered gap must not graduate");
  const sessions = Object.values(h.state.readGapLedger().entries).flatMap((e) => Object.keys(e.sessions));
  assert.deepEqual(sessions, [], "the covered entry is dropped, including this run's sighting");
});

test("a missing or corrupt ledger is rebuilt from the run's evidence, never a crash", async () => {
  const h = harness();
  fs.writeFileSync(h.state.gapLedgerPath, "{not json");
  const summary = await run(h, [record("claude-s1", [GAP]), record("claude-s2", [GAP])]);
  assert.equal(summary.gaps.length, 1);
  assert.equal(h.state.readGapLedger().version, 1);

  fs.writeFileSync(h.state.gapLedgerPath, JSON.stringify({ version: 99, entries: "nope" }));
  const again = await run(h, []);
  assert.equal(again.gaps.length, 1, "the evidence on disk is enough to rebuild the count");
});

test("foldEvidence without a ledger keeps the per-run behavior", () => {
  const summary = foldEvidence([record("claude-s1", [GAP]), record("claude-s1", [GAP_REPHRASED])], {
    memoryFile: memoryFile(),
  });
  assert.equal(summary.gaps.length, 0, "one session reporting twice is still one session");
});
