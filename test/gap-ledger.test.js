import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { State } from "../src/state.js";
import { parseMemoryUnits } from "../src/memory.js";
import { foldForRun } from "../src/commands/propose.js";
import { foldEvidence, renderEvidenceForPrompt } from "../src/fold.js";
import { gapEntryId, mergeGapEntries, pruneGapLedger, recordGapObservations } from "../src/gap-ledger.js";

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
    gaps: gaps.map((gap) => ({
      proposedInstruction: typeof gap === "string" ? gap : gap.proposedInstruction,
      mistake: "re-derived it",
      quote: `quote from ${id}`,
      recurrenceRisk: "high",
      ...(typeof gap === "string" ? {} : gap),
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
async function run(h, records, file = memoryFile(), memoryHash = "h1") {
  for (const r of records) h.state.writeEvidence(r.transcript.id, r);
  return foldForRun(h.ctx, file, memoryHash);
}

const GAP = "Read docs/db.md before writing queries.";
const GAP_REPHRASED = "Read docs/db.md before writing any queries";

test("a gap seen once now and once on a later run accumulates to two sessions and graduates", async () => {
  const h = harness();
  const first = await run(h, [record("claude-s1", [GAP])]);
  assert.equal(first.gaps.length, 0, "one session is not enough on the first run");
  assert.equal(first.totals.droppedGapSingletons, 1);

  // Later run: s1's evidence was rewritten against a changed memory file and the model
  // no longer mentions the gap; a new session s2 reports it in different words, both
  // analyzed against the new hash.
  const second = await run(
    h,
    [record("claude-s1", [], { memoryHash: "h2" }), record("claude-s2", [GAP_REPHRASED], { memoryHash: "h2" })],
    memoryFile(),
    "h2",
  );
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

test("a legacy session-id observation migrates without counting the identity as a second session", async () => {
  const h = harness();
  await run(h, [record("claude-s1", [GAP])]);
  const before = h.state.readGapLedger();
  const beforeEntry = Object.values(before.entries)[0];
  const firstObservedAt = beforeEntry.sessions["claude-s1"].firstObservedAt;

  const migrated = record("claude-s1", [GAP_REPHRASED]);
  migrated.transcript.identity = "stable-identity-s1";
  const summary = await run(h, [migrated]);

  assert.equal(summary.gaps.length, 0, "one upgraded session must remain a singleton");
  const entry = Object.values(h.state.readGapLedger().entries)[0];
  assert.deepEqual(Object.keys(entry.sessions), ["stable-identity-s1"]);
  assert.equal(entry.sessions["stable-identity-s1"].firstObservedAt, firstObservedAt);
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
  const summary = await run(
    h,
    [record("claude-s1", [GAP], { memoryHash: "h2" }), record("claude-s2", [GAP], { memoryHash: "h2" })],
    memoryFile(),
    "h2",
  );
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

// ---------- judged identity: analysis citations ----------

const PARAPHRASE = "Consult the database schema documentation prior to composing any SQL.";

test("an analysis that cites an existing gap id corroborates it, however different the words", async () => {
  const h = harness();
  await run(h, [record("claude-s1", [GAP])]);
  const entryId = gapEntryId(MEMORY_PATH, GAP);
  assert.ok(h.state.readGapLedger().entries[entryId], "the first sighting created the citable entry");

  // A later session phrases the same gap so differently that no lexical match exists;
  // its analysis saw the open-gap index and cited the id instead.
  const summary = await run(h, [record("codex-s2", [{ proposedInstruction: PARAPHRASE, matchesGap: entryId }])]);
  assert.equal(summary.gaps.length, 1, "the citation is what lines the two sightings up");
  assert.equal(summary.gaps[0].sessions, 2);
  assert.equal(Object.keys(h.state.readGapLedger().entries).length, 1, "no split entry for the paraphrase");
});

test("a citation to an id the ledger does not hold falls back to lexical identity", async () => {
  const h = harness();
  const summary = await run(h, [record("claude-s1", [{ proposedInstruction: GAP, matchesGap: "00000000deadbeef" }])]);
  assert.equal(summary.gaps.length, 0);
  const entries = Object.values(h.state.readGapLedger().entries);
  assert.equal(entries.length, 1, "the sighting still lands as a fresh entry");
  assert.equal(entries[0].proposedInstruction, GAP);
});

// ---------- orchestration-domain gaps stay out of project proposals ----------

test("orchestration-domain gaps are counted but never cluster into a proposal", async () => {
  const h = harness();
  const orchestration = { proposedInstruction: "Stop after the report on scout tasks.", domain: "orchestration" };
  const summary = await run(h, [record("claude-s1", [orchestration]), record("codex-s2", [orchestration])]);

  assert.equal(summary.gaps.length, 0, "two sessions corroborate it, and it still never becomes a proposal");
  assert.equal(summary.totals.orchestrationGapSightings, 2, "but the run stays legible about what it excluded");
  assert.match(renderEvidenceForPrompt(summary), /2 orchestration-domain sighting\(s\).*excluded/);

  // The same shape in the project domain clusters as usual - the exclusion is the
  // domain, not the text.
  const control = harness();
  const project = { proposedInstruction: "Stop after the report on scout tasks.", domain: "project" };
  const clustered = await run(control, [record("claude-s1", [project]), record("codex-s2", [project])]);
  assert.equal(clustered.gaps.length, 1);
});

// ---------- consolidation-pass merges (the mechanical half) ----------

function ledgerWith(...entries) {
  const ledger = { version: 1, entries: {} };
  for (const { id, text, sessions, memoryPath = MEMORY_PATH } of entries) {
    ledger.entries[id] = {
      id,
      memoryPath,
      proposedInstruction: text,
      sessions: Object.fromEntries(
        sessions.map((s) => [
          s,
          { firstObservedAt: "2026-08-01T00:00:00.000Z", observedAt: "2026-08-01T00:00:00.000Z" },
        ]),
      ),
    };
  }
  return ledger;
}

test("mergeGapEntries unions sessions without double-counting and keeps the shortest phrasing", () => {
  const ledger = ledgerWith(
    { id: "a".repeat(16), text: "A long and winding phrasing of the same gap.", sessions: ["s1", "shared"] },
    { id: "b".repeat(16), text: "The short phrasing.", sessions: ["s2", "shared"] },
  );
  const absorbed = mergeGapEntries(ledger, [["a".repeat(16), "b".repeat(16)]]);

  assert.equal(absorbed, 1);
  const entries = Object.values(ledger.entries);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].proposedInstruction, "The short phrasing.");
  assert.deepEqual(Object.keys(entries[0].sessions).sort(), ["s1", "s2", "shared"], "a session never counts twice");
});

test("merged gap identities remain durable as the canonical phrasing changes", () => {
  const first = "Always inspect the database schema documentation before composing a production SQL query.";
  const absorbed = "Consult schema before SQL.";
  const shortest = "Check DB docs.";
  const firstId = gapEntryId(MEMORY_PATH, first);
  const absorbedId = gapEntryId(MEMORY_PATH, absorbed);
  const ledger = ledgerWith(
    { id: firstId, text: first, sessions: ["s1", "s2"] },
    { id: absorbedId, text: absorbed, sessions: ["s3"] },
  );

  mergeGapEntries(ledger, [[firstId, absorbedId]]);
  recordGapObservations(ledger, [
    record("s4", [{ proposedInstruction: shortest, matchesGap: firstId }]),
    record("s5", [first]),
    record("s6", [absorbed]),
  ]);

  assert.deepEqual(Object.keys(ledger.entries), [firstId]);
  assert.equal(ledger.entries[firstId].proposedInstruction, shortest);
  assert.deepEqual(Object.keys(ledger.entries[firstId].sessions).sort(), ["s1", "s2", "s3", "s4", "s5", "s6"]);
  assert.equal(ledger.entries[firstId].sessions.s1.firstObservedAt, "2026-08-01T00:00:00.000Z");
});

test("coverage by any judged phrasing retires a merged gap", () => {
  const first = "Always inspect schema documentation before SQL.";
  const shortest = "Check DB docs.";
  const firstId = gapEntryId(MEMORY_PATH, first);
  const shortestId = gapEntryId(MEMORY_PATH, shortest);
  const ledger = ledgerWith(
    { id: firstId, text: first, sessions: ["s1", "s2"] },
    { id: shortestId, text: shortest, sessions: ["s3"] },
  );

  mergeGapEntries(ledger, [[firstId, shortestId]]);
  const covered = memoryFile(`# T\n\n- ${first}\n`);
  const stats = pruneGapLedger(ledger, { memoryFile: covered, memoryPath: MEMORY_PATH, maxAge: "all" });

  assert.equal(stats.covered, 3);
  assert.deepEqual(ledger.entries, {});
});

test("mergeGapEntries drops what it cannot verify instead of guessing", () => {
  const ledger = ledgerWith(
    { id: "a".repeat(16), text: "One gap.", sessions: ["s1"] },
    { id: "b".repeat(16), text: "Another gap.", sessions: ["s2"] },
    { id: "c".repeat(16), text: "A gap for another file.", sessions: ["s3"], memoryPath: "CLAUDE.md" },
  );

  assert.equal(mergeGapEntries(ledger, [["a".repeat(16), "0".repeat(16)]]), 0, "an unknown id shrinks the group");
  assert.equal(mergeGapEntries(ledger, [["a".repeat(16), "c".repeat(16)]]), 0, "cross-path groups are refused");
  assert.equal(mergeGapEntries(ledger, "not an array"), 0);
  assert.equal(Object.keys(ledger.entries).length, 3, "nothing merged, nothing lost");

  // An id already claimed by one group cannot be claimed again by a later one.
  const twice = mergeGapEntries(ledger, [
    ["a".repeat(16), "b".repeat(16)],
    ["b".repeat(16), "c".repeat(16)],
  ]);
  assert.equal(twice, 1, "only the first group merged");
  assert.ok(!ledger.entries["b".repeat(16)], "b was absorbed into a");
  assert.ok(ledger.entries["c".repeat(16)], "c stayed untouched");
});
