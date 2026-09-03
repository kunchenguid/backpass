import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { foldEvidence, renderEvidenceForPrompt, renderEvidenceReport } from "../src/fold.js";
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

test("fold lists every analyzed session source even when the record has no project", () => {
  const quoted = record("alpha1", { positive: [{ instruction: "AG-001", quote: "q1" }] });
  const silent = record("beta2", {});
  const otherProject = record("gamma3", {
    transcript: {
      id: "gamma3",
      harness: "codex",
      project: "wheelhouse",
      startedAt: Date.parse("2026-08-02T00:00:00Z"),
    },
    negative: [{ instruction: "AG-001", quote: "q2", class: "non-compliance" }],
  });
  const summary = foldEvidence([quoted, silent, otherProject], { memoryFile });

  assert.equal(summary.sources.length, 3, "every usable record issues a source, including one with no quotes");
  assert.equal(summary.sourceProjects[summary.sources.find((label) => label.startsWith("codex"))], "wheelhouse");
  assert.equal(
    Object.keys(summary.sourceProjects).length,
    1,
    "project-less records must not be dropped from sources just because sourceProjects is empty for them",
  );
  const instructionQuoteSources = summary.instructions
    .flatMap((row) => row.quotes.map((quote) => quote.source))
    .filter(Boolean);
  for (const source of instructionQuoteSources) {
    assert.ok(summary.sources.includes(source), `fold-issued quote source missing from sources: ${source}`);
  }
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
  assert.equal(
    fromLedger.totals.droppedGapSingletons,
    2,
    "the schema and pure-orchestration gaps stay below the floor",
  );
});

test("the fold counts the funnel's display splits: candidate instructions and why report-only", () => {
  const summary = foldEvidence(
    [
      record("s1", {
        positive: [{ instruction: "AG-003", quote: "followed it" }],
        negative: [{ instruction: "AG-001", quote: "n1", class: "non-compliance" }],
      }),
      record("s2", {
        negative: [
          { instruction: "AG-001", quote: "n2", class: "non-compliance" },
          { instruction: "AG-002", quote: "n3", class: "non-compliance" },
        ],
      }),
    ],
    {
      memoryFile,
      minGapEvidence: 3,
      minGapProjects: 2,
      gapObservations: [
        // Eligible: three sessions, two projects, nobody blamed the tooling.
        { proposedInstruction: "Always vendor the lockfile.", sessionId: "a", domain: "project", project: "p1" },
        { proposedInstruction: "Always vendor the lockfile.", sessionId: "b", domain: "project", project: "p2" },
        { proposedInstruction: "Always vendor the lockfile.", sessionId: "c", domain: "project", project: "p2" },
        // Report only, majority orchestration: every sighting blamed the tooling.
        {
          proposedInstruction: "Never bypass the release gate.",
          sessionId: "a",
          domain: "orchestration",
          project: "p1",
        },
        {
          proposedInstruction: "Never bypass the release gate.",
          sessionId: "b",
          domain: "orchestration",
          project: "p2",
        },
        {
          proposedInstruction: "Never bypass the release gate.",
          sessionId: "c",
          domain: "orchestration",
          project: "p2",
        },
        // Report only, too few projects: corroborated, but only ever in one project.
        { proposedInstruction: "Pin the schema version.", sessionId: "a", domain: "project", project: "p1" },
        { proposedInstruction: "Pin the schema version.", sessionId: "b", domain: "project", project: "p1" },
        { proposedInstruction: "Pin the schema version.", sessionId: "c", domain: "project", project: "p1" },
        // Report only, mixed and still below the floor: two sessions, one vote each way.
        { proposedInstruction: "Rotate the deploy token.", sessionId: "a", domain: "project", project: "p1" },
        { proposedInstruction: "Rotate the deploy token.", sessionId: "b", domain: "orchestration", project: "p2" },
        // Dropped singleton: one session, no orchestration vote to make it mixed.
        { proposedInstruction: "Tag the release commit.", sessionId: "c", domain: "project", project: "p3" },
      ],
    },
  );

  assert.equal(summary.totals.instructionsWithNegatives, 2, "AG-001 and AG-002 drew a negative; AG-003 only positives");
  assert.equal(summary.totals.gapClusters, 1);
  assert.equal(summary.totals.reportOnlyGapClusters, 3);
  assert.equal(summary.totals.droppedGapSingletons, 1);
  assert.deepEqual(summary.totals.reportOnlyByReason, {
    majorityOrchestration: 1,
    belowFloorMixed: 1,
    tooFewProjects: 1,
  });
  assert.equal(
    summary.totals.reportOnlyByReason.majorityOrchestration +
      summary.totals.reportOnlyByReason.belowFloorMixed +
      summary.totals.reportOnlyByReason.tooFewProjects,
    summary.totals.reportOnlyGapClusters,
    "every report-only cluster is attributed to exactly one reason",
  );
});

test("a two-sighting cluster with one orchestration vote survives instead of dropping below the floor", () => {
  const phrasing = "Read docs/sshhip.md before changing the tunnel.";
  const summary = foldEvidence(
    [
      record("s1", {
        gaps: [{ proposedInstruction: phrasing, quote: "rewrote the tunnel", recurrenceRisk: "high" }],
      }),
      record("s2", {
        gaps: [
          {
            proposedInstruction: phrasing,
            quote: "rewrote the tunnel again",
            recurrenceRisk: "high",
            domain: "orchestration",
          },
        ],
      }),
    ],
    { minGapEvidence: 2 },
  );

  assert.equal(summary.gaps.length, 1, "one inconsistent orchestration vote cannot kill a two-session recurrence");
  assert.equal(summary.gaps[0].sessions, 2);
  assert.equal(summary.gaps[0].orchestrationSightings, 1);
  assert.equal(summary.gaps[0].mixed, true);
  assert.equal(summary.gaps[0].majorityOrchestration, false);
  assert.equal(summary.totals.orchestrationGapSightings, 1);
  assert.equal(summary.totals.droppedGapSingletons, 0);
  assert.match(renderEvidenceForPrompt(summary), /2 sightings, 1 orchestration/);

  const majorityOrch = foldEvidence(
    [
      record("s1", {
        gaps: [{ proposedInstruction: phrasing, quote: "q1", recurrenceRisk: "low", domain: "orchestration" }],
      }),
      record("s2", {
        gaps: [{ proposedInstruction: phrasing, quote: "q2", recurrenceRisk: "low", domain: "orchestration" }],
      }),
      record("s3", {
        gaps: [{ proposedInstruction: phrasing, quote: "q3", recurrenceRisk: "low" }],
      }),
    ],
    { minGapEvidence: 2 },
  );
  assert.equal(
    majorityOrch.gaps.length,
    0,
    "a majority orchestration vote still withholds the cluster from a proposal",
  );
  assert.equal(majorityOrch.reportOnlyGaps.length, 1);
  assert.equal(majorityOrch.reportOnlyGaps[0].sessions, 3);
  assert.equal(majorityOrch.totals.reportOnlyGapClusters, 1);
  const renderedMajority = renderEvidenceReport(majorityOrch);
  assert.match(renderedMajority, /1 gap clusters \(0 synthesis eligible, 1 report only/);
  assert.match(renderedMajority, /3 sightings, 2 orchestration; domain excluded by majority vote/);
  assert.match(renderedMajority, /no gap cluster is eligible for a repository proposal/);
  assert.doesNotMatch(renderedMajority, /none above the evidence threshold/);
  assert.doesNotMatch(renderEvidenceForPrompt(majorityOrch), /Read docs\/sshhip\.md|REPORT ONLY/);
});

test("a below-threshold mixed cluster remains visible only in the report", () => {
  const phrasing = "Read docs/sshhip.md before changing the tunnel.";
  const summary = foldEvidence(
    [
      record("s1", {
        gaps: [{ proposedInstruction: phrasing, quote: "q1", recurrenceRisk: "high" }],
      }),
      record("s2", {
        gaps: [
          {
            proposedInstruction: phrasing,
            quote: "q2",
            recurrenceRisk: "high",
            domain: "orchestration",
          },
        ],
      }),
    ],
    { minGapEvidence: 3 },
  );

  assert.equal(summary.gaps.length, 0);
  assert.equal(summary.reportOnlyGaps.length, 1);
  assert.equal(summary.totals.reportOnlyGapClusters, 1);
  assert.equal(summary.totals.droppedGapSingletons, 0);
  assert.match(renderEvidenceReport(summary), /2 sightings, 1 orchestration/);
  assert.match(renderEvidenceReport(summary), /Read docs\/sshhip\.md/);
  assert.doesNotMatch(renderEvidenceForPrompt(summary), /Read docs\/sshhip\.md|REPORT ONLY/);
});

test("a pure orchestration singleton stays hidden below the evidence floor", () => {
  const phrasing = "Stop after the report on scout tasks.";
  const summary = foldEvidence(
    [
      record("s1", {
        gaps: [
          {
            proposedInstruction: phrasing,
            quote: "q1",
            recurrenceRisk: "low",
            domain: "orchestration",
          },
        ],
      }),
    ],
    { minGapEvidence: 2 },
  );

  assert.equal(summary.gaps.length, 0);
  assert.equal(summary.reportOnlyGaps.length, 0);
  assert.equal(summary.totals.reportOnlyGapClusters, 0);
  assert.equal(summary.totals.droppedGapSingletons, 1);
  assert.doesNotMatch(renderEvidenceForPrompt(summary), /Stop after the report/);
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

test("failed-trigger citations count per skill and reach the synthesis prompt with the cluster", () => {
  const covered = (id, phrasing) =>
    record(id, {
      gaps: [
        {
          proposedInstruction: phrasing,
          quote: `dropped a column in ${id}`,
          recurrenceRisk: "high",
          coveredBySkill: "db-schema",
        },
      ],
    });

  const summary = foldEvidence(
    [covered("s1", "Wrap migrations in a transaction."), covered("s2", "Wrap migrations in one transaction.")],
    { memoryFile, minGapEvidence: 2 },
  );

  assert.equal(summary.gaps.length, 1, "the two phrasings are one gap");
  assert.equal(summary.gaps[0].failedTriggerSkill, "db-schema");
  assert.equal(summary.gaps[0].failedTriggerSessions, 2);

  const rendered = renderEvidenceForPrompt(summary);
  assert.match(rendered, /FAILED TRIGGER: the existing skill "db-schema" already covers this/);
  assert.match(rendered, /fix that skill's description/);

  // The floor is untouched: one cited sighting is still a hidden singleton.
  const single = foldEvidence([covered("s1", "Wrap migrations in a transaction.")], { memoryFile, minGapEvidence: 2 });
  assert.equal(single.gaps.length, 0, "a failed-trigger citation never lowers the corroboration bar");

  const partlyCited = foldEvidence(
    [
      covered("s1", "Wrap migrations in a transaction."),
      record("s2", {
        gaps: [{ proposedInstruction: "Wrap migrations in one transaction.", quote: "migration escaped" }],
      }),
    ],
    { memoryFile, minGapEvidence: 2 },
  );
  assert.equal(partlyCited.gaps.length, 1, "the gap itself still clears its corroboration floor");
  assert.equal(
    partlyCited.gaps[0].failedTriggerSkill,
    undefined,
    "one skill citation cannot clear a two-session floor",
  );

  const citedAfterDuplicate = foldEvidence(
    [
      record("s1", {
        gaps: [
          { proposedInstruction: "Wrap migrations in a transaction.", quote: "first uncited s1" },
          {
            proposedInstruction: "Wrap migrations in a transaction.",
            quote: "later cited s1",
            coveredBySkill: "db-schema",
          },
        ],
      }),
      record("s2", {
        gaps: [
          { proposedInstruction: "Wrap migrations in one transaction.", quote: "first uncited s2" },
          {
            proposedInstruction: "Wrap migrations in one transaction.",
            quote: "later cited s2",
            coveredBySkill: "db-schema",
          },
        ],
      }),
    ],
    { memoryFile, minGapEvidence: 2 },
  );
  assert.equal(citedAfterDuplicate.gaps[0].sessions, 2);
  assert.equal(citedAfterDuplicate.gaps[0].failedTriggerSkill, "db-schema");
  assert.equal(citedAfterDuplicate.gaps[0].failedTriggerSessions, 2);
});

test("a cluster nobody tied to a skill renders without a failed-trigger line", () => {
  const summary = foldEvidence(
    [
      record("s1", { gaps: [{ proposedInstruction: "Pin the Node version.", quote: "used system node v20" }] }),
      record("s2", {
        gaps: [{ proposedInstruction: "Pin the Node version everywhere.", quote: "node drifted again" }],
      }),
    ],
    { memoryFile, minGapEvidence: 2 },
  );
  assert.equal(summary.gaps.length, 1);
  assert.equal(summary.gaps[0].failedTriggerSkill, undefined);
  assert.ok(!renderEvidenceForPrompt(summary).includes("FAILED TRIGGER"));
});

function oversizedParagraph(count = 5) {
  return Array.from(
    { length: count },
    (_, i) =>
      `Sentence ${i + 1} states an independent requirement about builds, releases, adapters, and review that an agent must actually follow rather than skip.`,
  ).join(" ");
}

test("sentence-part harm renders the parent paragraph's removal aggregate", () => {
  const blob = oversizedParagraph();
  const blobFile = { units: parseMemoryUnits(`# T\n\n${blob}\n`) };
  const summary = foldEvidence(
    [
      record("s1", {
        negative: [{ instruction: "AG-001.1", quote: "sentence one caused damage", class: "harm" }],
      }),
      record("s2", {
        negative: [{ instruction: "AG-001.2", quote: "sentence two caused damage", class: "harm" }],
      }),
    ],
    { memoryFile: blobFile },
  );

  assert.equal(summary.instructions.find((row) => row.instruction === "AG-001.1").harmSessions, 1);
  assert.equal(summary.instructions.find((row) => row.instruction === "AG-001.2").harmSessions, 1);
  assert.equal(summary.parentHarmSessions["AG-001"], 2);
  assert.match(
    renderEvidenceForPrompt(summary),
    /Parent paragraph removal evidence aggregated across sentence parts:\n- AG-001 harm-sessions=2/,
  );
});

test("an oversized parent preserves its cross-surface warning without becoming an attribution target", () => {
  const blob = oversizedParagraph();
  const blobFile = { units: parseMemoryUnits(`# T\n\n${blob}\n`) };
  const summary = foldEvidence([], {
    memoryFile: blobFile,
    skills: [{ name: "oversized-rules", path: ".agents/skills/oversized-rules/SKILL.md", description: blob, body: "" }],
  });

  assert.equal(summary.crossSurfaceDuplicates[0].instruction, "AG-001");
  const rendered = renderEvidenceForPrompt(summary);
  assert.match(rendered, /Parent paragraph cross-surface overlap:\n- AG-001 parent paragraph/);
  assert.match(rendered, /CROSS-SURFACE: restates skill "oversized-rules" description/);
  assert.doesNotMatch(rendered, /\[AG-001\](?!\.)/);
});

test("an oversized high-non-compliance paragraph attributes per sentence and invites a restructure, not a bold label", () => {
  const blob = oversizedParagraph();
  const blobFile = { units: parseMemoryUnits(`# T\n\n${blob}\n\n- Keep this list item whole.\n`) };
  assert.ok(blobFile.units[0].parts?.length >= 2);
  assert.equal(blobFile.units[1].id, "AG-002");

  const oneSession = foldEvidence(
    [
      record("s1", {
        negative: [
          { instruction: "AG-001.2", quote: "skipped sentence two", class: "non-compliance" },
          { instruction: "AG-001.3", quote: "skipped sentence three", class: "non-compliance" },
        ],
      }),
    ],
    { memoryFile: blobFile, minGapEvidence: 2 },
  );
  assert.equal(oneSession.oversized.length, 0, "several misses in one session do not corroborate a rewrite");

  const summary = foldEvidence(
    [
      record("s1", {
        negative: [
          {
            instruction: "AG-001.2",
            quote: "skipped the second sentence of the blob entirely here",
            effect: "the rest of the paragraph never steered",
            class: "non-compliance",
          },
        ],
      }),
      record("s2", {
        negative: [
          {
            instruction: "AG-001.2",
            quote: "ignored sentence two again on the follow-up session",
            class: "non-compliance",
          },
        ],
      }),
    ],
    { memoryFile: blobFile },
  );

  const hot = summary.instructions.find((row) => row.instruction === "AG-001.2");
  const quiet = summary.instructions.find((row) => row.instruction === "AG-001.1");
  const parent = summary.instructions.find((row) => row.instruction === "AG-001");
  assert.equal(hot.negative, 2);
  assert.equal(hot.parentId, "AG-001");
  assert.equal(hot.nonCompliance, 2);
  assert.equal(quiet.sessions, 0, "a sibling sentence is not smeared with the hot one's evidence");
  assert.equal(parent, undefined, "the parent blob is not a dead removal candidate of its own");
  assert.equal(summary.oversized.length, 1);
  assert.equal(summary.oversized[0].id, "AG-001");
  assert.equal(summary.oversized[0].sessions, 2);
  assert.ok(summary.oversized[0].tokens > 120);

  const rendered = renderEvidenceForPrompt(summary);
  assert.match(rendered, /\[AG-001\.2\] \+0 -2/);
  assert.match(rendered, /### Oversized units that failed to steer/);
  assert.match(rendered, /Preferred reinforcement is a restructure-in-place/);
  assert.match(rendered, /bold label on the blob is not a strengthen/);
  assert.match(rendered, /- AG-001 is \d+ tokens as one paragraph \(attribution: \[AG-001\.1\]/);
  assert.doesNotMatch(rendered, /\[AG-001\](?!\.)/);
  assert.doesNotMatch(rendered, /\[AG-001\] \+0 -0/);
});

test("minGapProjects 2 keeps a single-project cluster report-only", () => {
  const phrasing = "Always vendor the lockfile.";
  const summary = foldEvidence(
    [
      record("s1", {
        transcript: { id: "s1", harness: "claude", project: "/repos/alpha" },
        gaps: [{ proposedInstruction: phrasing, quote: "q", recurrenceRisk: "high" }],
      }),
      record("s2", {
        transcript: { id: "s2", harness: "claude", project: "/repos/alpha" },
        gaps: [{ proposedInstruction: phrasing, quote: "q2", recurrenceRisk: "high" }],
      }),
    ],
    { minGapEvidence: 2, minGapProjects: 2 },
  );
  assert.equal(summary.gaps.length, 0);
  assert.equal(summary.reportOnlyGaps.length, 1);
  assert.equal(summary.reportOnlyGaps[0].sessions, 2);
  assert.equal(summary.reportOnlyGaps[0].projects, 1);
  assert.match(summary.reportOnlyGaps[0].reportOnlyReason, /project-specific/);
});

test("report-only gaps name the actual number of observed projects", () => {
  const phrasing = "Always vendor the lockfile.";
  const summary = foldEvidence(
    [
      record("s1", {
        transcript: { id: "s1", harness: "claude", project: "/repos/alpha" },
        gaps: [{ proposedInstruction: phrasing, quote: "q", recurrenceRisk: "high" }],
      }),
      record("s2", {
        transcript: { id: "s2", harness: "claude", project: "/repos/beta" },
        gaps: [{ proposedInstruction: phrasing, quote: "q2", recurrenceRisk: "high" }],
      }),
    ],
    { minGapEvidence: 2, minGapProjects: 3 },
  );

  assert.equal(summary.reportOnlyGaps.length, 1);
  assert.equal(summary.reportOnlyGaps[0].projects, 2);
  assert.match(summary.reportOnlyGaps[0].reportOnlyReason, /seen in 2 projects; minGapProjects is 3/);
  assert.doesNotMatch(summary.reportOnlyGaps[0].reportOnlyReason, /only/);
});

test("minGapProjects 2 admits a cluster seen in two projects", () => {
  const phrasing = "Always vendor the lockfile.";
  const summary = foldEvidence(
    [
      record("s1", {
        transcript: { id: "s1", harness: "claude", project: "/repos/alpha" },
        gaps: [{ proposedInstruction: phrasing, quote: "q", recurrenceRisk: "high" }],
      }),
      record("s2", {
        transcript: { id: "s2", harness: "claude", project: "/repos/beta" },
        gaps: [{ proposedInstruction: phrasing, quote: "q2", recurrenceRisk: "high" }],
      }),
    ],
    { minGapEvidence: 2, minGapProjects: 2 },
  );
  assert.equal(summary.gaps.length, 1);
  assert.equal(summary.gaps[0].projects, 2);
  assert.equal(summary.reportOnlyGaps.length, 0);
});

test("the default minGapProjects of 1 does not require a second project", () => {
  const phrasing = "Always vendor the lockfile.";
  const summary = foldEvidence(
    [
      record("s1", {
        transcript: { id: "s1", harness: "claude", project: "/repos/alpha" },
        gaps: [{ proposedInstruction: phrasing, quote: "q", recurrenceRisk: "high" }],
      }),
      record("s2", {
        transcript: { id: "s2", harness: "claude", project: "/repos/alpha" },
        gaps: [{ proposedInstruction: phrasing, quote: "q2", recurrenceRisk: "high" }],
      }),
    ],
    { minGapEvidence: 2, minGapProjects: 1 },
  );
  assert.equal(summary.gaps.length, 1);
  assert.equal(summary.gaps[0].projects, 1);
});

test("duplicate sightings from a covered session do not count toward gap sessions", () => {
  const coveredRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-fold-duplicate-covered-"));
  const covered = "Always pin the Node version with nvm.";
  const similarUncovered = "Pin the Node version using nvm.";
  fs.writeFileSync(path.join(coveredRoot, "AGENTS.md"), `# T\n\n- ${covered}\n`);
  const records = [
    record("s1", {
      transcript: { id: "s1", harness: "claude", project: coveredRoot, projectRoot: coveredRoot },
      gaps: [
        { proposedInstruction: similarUncovered, quote: "q1", recurrenceRisk: "high" },
        { proposedInstruction: covered, quote: "q2", recurrenceRisk: "high" },
      ],
    }),
    record("s2", {
      transcript: { id: "s2", harness: "claude", project: "/repos/other", projectRoot: null },
      gaps: [{ proposedInstruction: similarUncovered, quote: "q3", recurrenceRisk: "high" }],
    }),
  ];

  const belowFloor = foldEvidence(records, { minGapEvidence: 2, checkProjectCoverage: true });
  assert.equal(belowFloor.gaps.length, 0);
  assert.equal(belowFloor.totals.droppedGapSingletons, 1);

  const eligible = foldEvidence(records, { minGapEvidence: 1, checkProjectCoverage: true });
  assert.equal(eligible.gaps.length, 1);
  assert.equal(eligible.gaps[0].sessions, 1);
  assert.equal(eligible.gaps[0].projectCoveredSessions, 1);
  assert.equal(eligible.gaps[0].projects, 1);
});

test("project-covered sightings do not control eligible cluster metadata", () => {
  const coveredRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-fold-covered-votes-"));
  const phrasing = "Always pin deployment artifact digests.";
  fs.writeFileSync(path.join(coveredRoot, "AGENTS.md"), `# T\n\n- ${phrasing}\n`);
  const records = [
    record("p1", {
      transcript: { id: "p1", harness: "claude", project: "/repos/one", projectRoot: null },
      gaps: [{ proposedInstruction: phrasing, quote: "eligible one", recurrenceRisk: "medium" }],
    }),
    record("p2", {
      transcript: { id: "p2", harness: "claude", project: "/repos/two", projectRoot: null },
      gaps: [{ proposedInstruction: phrasing, quote: "eligible two", recurrenceRisk: "medium" }],
    }),
    ...["c1", "c2", "c3"].map((id) =>
      record(id, {
        transcript: { id, harness: "claude", project: coveredRoot, projectRoot: coveredRoot },
        gaps: [
          {
            proposedInstruction: phrasing,
            quote: `covered ${id}`,
            recurrenceRisk: "high",
            domain: "orchestration",
            coveredBySkill: "deploy",
          },
        ],
      }),
    ),
  ];
  const summary = foldEvidence(records, { minGapEvidence: 2, checkProjectCoverage: true });
  assert.equal(summary.gaps.length, 1);
  assert.equal(summary.gaps[0].sessions, 2);
  assert.equal(summary.gaps[0].projectCoveredSessions, 3);
  assert.equal(summary.gaps[0].orchestrationSightings, 0);
  assert.equal(summary.gaps[0].majorityOrchestration, false);
  assert.equal(summary.gaps[0].recurrenceRisk, "medium");
  assert.deepEqual(
    summary.gaps[0].quotes.map((quote) => quote.text),
    ["eligible one", "eligible two"],
  );
  assert.equal(summary.gaps[0].failedTriggerSkill, undefined);
});

test("project coverage honors the project's configured memory file", () => {
  const coveredRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-fold-custom-memory-"));
  const phrasing = "Always read the deployment guide before releasing.";
  fs.mkdirSync(path.join(coveredRoot, "docs"), { recursive: true });
  fs.writeFileSync(path.join(coveredRoot, "AGENTS.md"), "# T\n\n- Keep releases reproducible.\n");
  fs.writeFileSync(path.join(coveredRoot, "docs/AI.md"), `# T\n\n- ${phrasing}\n`);
  fs.writeFileSync(
    path.join(coveredRoot, ".backpassrc.json"),
    JSON.stringify({ memoryFiles: ["AGENTS.md", "docs/AI.md"] }),
  );
  const summary = foldEvidence(
    [
      record("s1", {
        transcript: { id: "s1", harness: "claude", project: coveredRoot, projectRoot: coveredRoot },
        gaps: [{ proposedInstruction: phrasing, quote: "q", recurrenceRisk: "high" }],
      }),
      record("s2", {
        transcript: { id: "s2", harness: "claude", project: "/repos/other", projectRoot: null },
        gaps: [{ proposedInstruction: phrasing, quote: "q2", recurrenceRisk: "high" }],
      }),
    ],
    { minGapEvidence: 2, checkProjectCoverage: true },
  );
  assert.equal(summary.gaps.length, 0);
  assert.equal(summary.totals.droppedGapSingletons, 1);
});

test("a project-covered sighting does not count toward gap sessions", () => {
  const coveredRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-fold-covered-"));
  const phrasing = "Always pin the Node version with nvm.";
  fs.writeFileSync(path.join(coveredRoot, "AGENTS.md"), `# T\n\n- ${phrasing}\n`);
  const summary = foldEvidence(
    [
      record("s1", {
        transcript: { id: "s1", harness: "claude", project: coveredRoot, projectRoot: coveredRoot },
        gaps: [{ proposedInstruction: phrasing, quote: "q", recurrenceRisk: "high" }],
      }),
      record("s2", {
        transcript: { id: "s2", harness: "claude", project: "/repos/other", projectRoot: null },
        gaps: [{ proposedInstruction: phrasing, quote: "q2", recurrenceRisk: "high" }],
      }),
    ],
    { minGapEvidence: 2, checkProjectCoverage: true },
  );
  assert.equal(summary.gaps.length, 0);
  assert.equal(summary.totals.droppedGapSingletons, 1);
  const cluster = [...summary.gaps, ...summary.reportOnlyGaps];
  assert.equal(cluster.length, 0);
  // Re-fold at minGapEvidence 1 so the uncovered session is eligible, and the covered one is not.
  const uncovered = foldEvidence(
    [
      record("s1", {
        transcript: { id: "s1", harness: "claude", project: coveredRoot, projectRoot: coveredRoot },
        gaps: [{ proposedInstruction: phrasing, quote: "q", recurrenceRisk: "high" }],
      }),
      record("s2", {
        transcript: { id: "s2", harness: "claude", project: "/repos/other", projectRoot: null },
        gaps: [{ proposedInstruction: phrasing, quote: "q2", recurrenceRisk: "high" }],
      }),
    ],
    { minGapEvidence: 1, checkProjectCoverage: true },
  );
  assert.equal(uncovered.gaps.length, 1);
  assert.equal(uncovered.gaps[0].sessions, 1);
  assert.equal(uncovered.gaps[0].projectCoveredSessions, 1);
  assert.equal(uncovered.gaps[0].projects, 1);
});
