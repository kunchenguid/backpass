import test from "node:test";
import assert from "node:assert/strict";

import { foldEvidence, renderEvidenceForPrompt } from "../src/fold.js";
import { parseMemoryUnits } from "../src/memory.js";

function record(id, overrides = {}) {
  return {
    status: "ok",
    transcript: { id, harness: "claude", startedAt: Date.parse("2026-08-01T00:00:00Z") },
    positive: [],
    negative: [],
    gaps: [],
    ...overrides,
  };
}

const memoryFile = {
  units: parseMemoryUnits("# T\n\n- First rule\n- Second rule\n- Third rule\n"),
};

test("evidence is grouped per instruction with session-level relevance", () => {
  const summary = foldEvidence(
    [
      record("s1", { positive: [{ instruction: "AG-001", quote: "q1" }] }),
      record("s2", { negative: [{ instruction: "AG-001", quote: "q2" }] }),
      record("s3", {}),
      record("s4", {}),
    ],
    { memoryFile },
  );

  assert.equal(summary.analyzedSessions, 4);
  const row = summary.instructions.find((i) => i.instruction === "AG-001");
  assert.equal(row.positive, 1);
  assert.equal(row.negative, 1);
  assert.equal(row.sessions, 2);
  assert.equal(row.relevance, 0.5);
});

test("instructions with no evidence still appear - they are the removal candidates", () => {
  const summary = foldEvidence([record("s1", { positive: [{ instruction: "AG-001", quote: "q" }] })], { memoryFile });

  const dead = summary.instructions.find((i) => i.instruction === "AG-003");
  assert.ok(dead, "an instruction that drew no evidence must still be reported");
  assert.equal(dead.sessions, 0);
  assert.equal(dead.relevance, 0);
  assert.ok(dead.tokens > 0, "its always-loaded cost is what makes it a removal candidate");
});

test("near-duplicate gaps from different sessions cluster into one item", () => {
  const summary = foldEvidence(
    [
      record("s1", {
        gaps: [
          {
            proposedInstruction: "Read docs/db.md before writing queries.",
            quote: "walked migrations",
            recurrenceRisk: "high",
          },
        ],
      }),
      record("s2", {
        gaps: [
          {
            proposedInstruction: "Read docs/db.md before writing database queries.",
            quote: "rebuilt the schema",
            recurrenceRisk: "medium",
          },
        ],
      }),
    ],
    { minGapEvidence: 2 },
  );

  assert.equal(summary.gaps.length, 1);
  assert.equal(summary.gaps[0].sessions, 2);
  assert.equal(summary.gaps[0].recurrenceRisk, "high", "the cluster inherits the highest risk");
  assert.equal(summary.gaps[0].quotes.length, 2);
});

test("a gap seen in only one session is dropped - batch size greater than one", () => {
  const summary = foldEvidence(
    [
      record("s1", {
        gaps: [{ proposedInstruction: "Always vendor the lockfile.", quote: "q", recurrenceRisk: "low" }],
      }),
    ],
    { minGapEvidence: 2 },
  );

  assert.equal(summary.gaps.length, 0);
  assert.equal(summary.totals.droppedGapSingletons, 1);
});

test("the fold records the sightings it clustered over - the gap funnel's top", () => {
  const fromRecords = foldEvidence(
    [
      record("s1", {
        gaps: [
          { proposedInstruction: "Always vendor the lockfile.", quote: "q", recurrenceRisk: "low" },
          {
            proposedInstruction: "Never bypass the release gate.",
            quote: "q",
            recurrenceRisk: "low",
            domain: "orchestration",
          },
        ],
      }),
      record("s2", {
        gaps: [{ proposedInstruction: "Always vendor the lockfile.", quote: "q", recurrenceRisk: "low" }],
      }),
    ],
    { minGapEvidence: 2 },
  );
  assert.equal(fromRecords.totals.gapSightings, 3, "every sighting counts, orchestration included");
  assert.equal(fromRecords.totals.orchestrationGapSightings, 1);
  assert.equal(fromRecords.totals.gapClusters, 1);

  // With a ledger the fold clusters over its observations, so the funnel counts those.
  const fromLedger = foldEvidence([record("s1")], {
    minGapEvidence: 2,
    gapObservations: [
      { proposedInstruction: "Always vendor the lockfile.", sessionId: "a", domain: "project" },
      { proposedInstruction: "Always vendor the lockfile.", sessionId: "b", domain: "project" },
      { proposedInstruction: "Never bypass the release gate.", sessionId: "a", domain: "orchestration" },
      { proposedInstruction: "Pin the schema version.", sessionId: "c", domain: "project" },
    ],
  });
  assert.equal(fromLedger.totals.gapSightings, 4);
  assert.equal(fromLedger.totals.orchestrationGapSightings, 1);
  assert.equal(fromLedger.totals.gapClusters, 1, "two sessions corroborate the lockfile gap");
  assert.equal(fromLedger.totals.droppedGapSingletons, 1, "the schema gap stays below the floor");
});

test("the same gap repeated inside one session does not clear the threshold", () => {
  const summary = foldEvidence(
    [
      record("s1", {
        gaps: [
          { proposedInstruction: "Always vendor the lockfile.", quote: "a", recurrenceRisk: "low" },
          { proposedInstruction: "Always vendor the lockfile now.", quote: "b", recurrenceRisk: "low" },
        ],
      }),
    ],
    { minGapEvidence: 2 },
  );

  assert.equal(summary.gaps.length, 0, "the threshold counts distinct sessions, not items");
});

test("failed and skipped analyses are excluded from the fold", () => {
  const summary = foldEvidence(
    [
      record("s1", { positive: [{ instruction: "AG-001", quote: "q" }] }),
      { status: "failed", transcript: { id: "s2", harness: "codex" }, error: "timeout" },
      { status: "skipped", transcript: { id: "s3", harness: "pi" }, reason: "too short" },
    ],
    { memoryFile },
  );

  assert.equal(summary.analyzedSessions, 1);
  assert.equal(summary.totals.positive, 1);
});

test("the rendered evidence block carries counts, relevance, quotes, effects and classes into the prompt", () => {
  const summary = foldEvidence(
    [
      record("s1", {
        negative: [
          { instruction: "AG-002", quote: "used a bare #2731", effect: "follow-up needed", class: "non-compliance" },
        ],
      }),
      record("s2", { negative: [{ instruction: "AG-002", quote: "again a bare number" }] }),
    ],
    { memoryFile },
  );

  const rendered = renderEvidenceForPrompt(summary);
  assert.match(rendered, /Sessions analyzed: 2/);
  assert.match(rendered, /\[AG-002\] \+0 -2 harm-sessions=0 sessions=2 relevance=100\.0%/);
  // The synthesis model must see what a negative MEANS, not only its sign: the effect
  // text and the harm/non-compliance class both survive into the prompt.
  assert.match(rendered, /- \[non-compliance\] "used a bare #2731" :: follow-up needed/);
  assert.match(rendered, /- \[unclassified\] "again a bare number"/);
  assert.match(rendered, /`non-compliance` = the agent ignored it/);
  assert.match(rendered, /none above the evidence threshold/);
});

test("harm-class negatives are counted per distinct session, and only explicit harm counts", () => {
  const summary = foldEvidence(
    [
      record("s1", {
        negative: [
          { instruction: "AG-001", quote: "q1", class: "harm" },
          { instruction: "AG-001", quote: "q1b", class: "harm" },
          { instruction: "AG-002", quote: "q2", class: "non-compliance" },
        ],
      }),
      record("s2", { negative: [{ instruction: "AG-001", quote: "q3", class: "harm" }] }),
      record("s3", { negative: [{ instruction: "AG-001", quote: "q4" }] }),
    ],
    { memoryFile },
  );

  const rows = new Map(summary.instructions.map((row) => [row.instruction, row]));
  assert.equal(rows.get("AG-001").harmSessions, 2, "two distinct sessions, however many harm items each filed");
  assert.equal(rows.get("AG-001").negative, 4);
  assert.equal(rows.get("AG-002").harmSessions, 0, "non-compliance and unclassified never count as harm");
});
