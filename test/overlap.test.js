import test from "node:test";
import assert from "node:assert/strict";

import { foldEvidence, renderEvidenceForPrompt } from "../src/fold.js";
import { parseMemoryUnits } from "../src/memory.js";
import { CROSS_SURFACE_OVERLAP_THRESHOLD, crossSurfaceDuplicates } from "../src/overlap.js";

const DESCRIPTION = "Load before changing database queries.";

function skill(overrides = {}) {
  return {
    name: "database",
    path: ".agents/skills/database/SKILL.md",
    description: DESCRIPTION,
    body: "Read the schema first.",
    ...overrides,
  };
}

test("a memory unit that restates a skill description is flagged", () => {
  const memoryFile = {
    path: "AGENTS.md",
    units: parseMemoryUnits(`# Rules\n\n- ${DESCRIPTION}\n- Keep changes focused.\n`),
  };
  const hits = crossSurfaceDuplicates(memoryFile, [skill()]);
  assert.equal(hits.length, 1, "only the restated description is a duplicate");
  assert.equal(hits[0].instruction, "AG-001");
  assert.equal(hits[0].skill, "database");
  assert.equal(hits[0].surface, "description");
  assert.ok(hits[0].score >= CROSS_SURFACE_OVERLAP_THRESHOLD);
  assert.equal(
    hits.some((hit) => hit.instruction === "AG-002"),
    false,
    "an unrelated unit is not a duplicate",
  );
});

test("a short skill index entry is compared without its structural prefix", () => {
  const memoryFile = {
    path: "AGENTS.md",
    units: parseMemoryUnits("# Skills\n\n- deploy: Run deployments.\n"),
  };
  const hits = crossSurfaceDuplicates(memoryFile, [
    skill({ name: "deploy", description: "Run deployments.", body: "Deployment details." }),
  ]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].instruction, "AG-001");
  assert.equal(hits[0].surface, "description");
  assert.equal(hits[0].score, 1);
});

test("a qualifying description match takes precedence over a stronger body match", () => {
  const memoryText = "Run deployments safely";
  const memoryFile = {
    path: "AGENTS.md",
    units: parseMemoryUnits(`# Skills\n\n- ${memoryText}\n`),
  };
  const hits = crossSurfaceDuplicates(memoryFile, [
    skill({
      name: "deploy",
      description: "Run deployments safely in production.",
      body: memoryText,
    }),
  ]);

  assert.equal(hits.length, 1);
  assert.equal(hits[0].surface, "description");
  assert.ok(hits[0].score >= CROSS_SURFACE_OVERLAP_THRESHOLD);
  assert.ok(hits[0].score < 1);
});

test("a memory unit that restates a skill body paragraph is flagged against the body", () => {
  const body = "Always wrap migrations in a transaction before applying them.";
  const memoryFile = {
    path: "AGENTS.md",
    units: parseMemoryUnits(`# Rules\n\n- ${body}\n`),
  };
  const hits = crossSurfaceDuplicates(memoryFile, [skill({ description: "Database skill.", body })]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].surface, "body");
  assert.equal(hits[0].skill, "database");
});

test("fold renders body overlap without always-loaded drop advice", () => {
  const body = "Always wrap migrations in a transaction before applying them.";
  const memoryFile = {
    path: "AGENTS.md",
    units: parseMemoryUnits(`# Rules\n\n- ${body}\n`),
  };
  const summary = foldEvidence([], {
    memoryFile,
    skills: [skill({ description: "Database skill.", body })],
  });

  const rendered = renderEvidenceForPrompt(summary);
  assert.match(rendered, /triggered skill-body overlap \(report-only\)/);
  assert.match(rendered, /weigh relevance and trigger suitability/);
  assert.doesNotMatch(rendered, /duplicated always-loaded tokens/);
  assert.doesNotMatch(rendered, /drop the memory-file copy/);
});

test("empty skills or empty memory produce no flags", () => {
  const memoryFile = { path: "AGENTS.md", units: parseMemoryUnits("# T\n\n- Keep changes focused.\n") };
  assert.deepEqual(crossSurfaceDuplicates(memoryFile, []), []);
  assert.deepEqual(crossSurfaceDuplicates(null, [skill()]), []);
  assert.deepEqual(crossSurfaceDuplicates(memoryFile, [skill({ description: "", body: "" })]), []);
});

test("fold stamps the flag on the instruction row and renders it for synthesis", () => {
  const memoryFile = {
    path: "AGENTS.md",
    units: parseMemoryUnits(`# Rules\n\n- ${DESCRIPTION}\n- Keep changes focused.\n`),
  };
  const summary = foldEvidence(
    [
      {
        status: "ok",
        transcript: { id: "s1", harness: "claude" },
        positive: [{ instruction: "AG-001", quote: "opened the schema" }],
        negative: [],
        gaps: [],
      },
    ],
    { memoryFile, skills: [skill()] },
  );

  const row = summary.instructions.find((item) => item.instruction === "AG-001");
  assert.equal(row.skillOverlap.skill, "database");
  assert.equal(row.skillOverlap.surface, "description");
  assert.equal(summary.totals.crossSurfaceDuplicates, 1);
  assert.equal(summary.crossSurfaceDuplicates.length, 1);

  const unrelated = summary.instructions.find((item) => item.instruction === "AG-002");
  assert.equal(unrelated.skillOverlap, undefined);

  const rendered = renderEvidenceForPrompt(summary);
  assert.match(rendered, /CROSS-SURFACE: restates skill "database" description/);
  assert.match(rendered, /drop the memory-file copy/);
});
