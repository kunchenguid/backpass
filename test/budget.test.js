import test from "node:test";
import assert from "node:assert/strict";

import { budgetBar, budgetGateKind, budgetStatus, estimateTokens, formatTokens } from "../src/tokens.js";
import { parseMemoryUnits, similarity, reanchor, unitHash } from "../src/memory.js";
import { extractionBudgetEffect, parseFrontmatter, renderSkillFile } from "../src/skills.js";

test("token estimation prices UTF-8 bytes, not characters", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("a".repeat(4000)), 1000);
  // Multi-byte text costs what it costs on the wire.
  assert.equal(estimateTokens("é"), 1);
  assert.equal(estimateTokens("é".repeat(400)), 200);
});

test("budgetStatus reports the delta, the overage, and whether the gate passes", () => {
  const current = "x".repeat(16000); // 4,000 tok
  const grown = "x".repeat(24000); // 6,000 tok

  const within = budgetStatus(current, current, 5000);
  assert.equal(within.current, 4000);
  assert.equal(within.projected, 4000);
  assert.equal(within.delta, 0);
  assert.equal(within.withinBudget, true);
  assert.equal(within.over, 0);

  const over = budgetStatus(current, grown, 5000);
  assert.equal(over.projected, 6000);
  assert.equal(over.delta, 2000);
  assert.equal(over.withinBudget, false);
  assert.equal(over.over, 1000);
  assert.equal(budgetGateKind(within), null);
  assert.equal(budgetGateKind(over), "cap");
  assert.equal(budgetGateKind(budgetStatus(grown, grown, 5000)), "shrink");
  assert.equal(budgetGateKind(budgetStatus(grown, current, 5000)), null);
});

test("a shrinking edit is within budget even when the file started over it", () => {
  const before = "x".repeat(28000); // 7,000 tok
  const after = "x".repeat(18000); // 4,500 tok
  const status = budgetStatus(before, after, 5000);
  assert.equal(status.delta, -2500);
  assert.equal(status.withinBudget, true);
});

test("the budget bar marks overflow distinctly from a full bar", () => {
  const full = budgetBar(budgetStatus("x".repeat(20000), null, 5000), 10);
  const over = budgetBar(budgetStatus("x".repeat(40000), null, 5000), 10);
  assert.equal(full, "[##########]");
  assert.ok(over.includes("#"));
  assert.equal(over.length, 12);
});

test("formatTokens groups thousands for the gauge readout", () => {
  assert.equal(formatTokens(4559), "4,559");
});

test("memory files parse into addressable instruction units", () => {
  const text = [
    "# Title",
    "",
    "Intro paragraph.",
    "",
    "## Rules",
    "",
    "- First rule",
    "- Second rule",
    "  with a continuation line",
    "",
    "### Nested",
    "",
    "Closing note.",
    "",
  ].join("\n");

  const units = parseMemoryUnits(text);
  assert.deepEqual(
    units.map((u) => u.id),
    ["AG-001", "AG-002", "AG-003", "AG-004"],
  );
  assert.equal(units[0].section, "Title");
  assert.equal(units[1].text, "- First rule");
  assert.ok(units[2].text.includes("continuation line"), "continuation lines stay with their list item");
  assert.equal(units[3].section, "Title > Rules > Nested");
  assert.ok(units.every((u) => u.tokens > 0));
});

test("a fenced code block stays one unit instead of splitting into lines", () => {
  const text = "# T\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n";
  const units = parseMemoryUnits(text);
  assert.equal(units.length, 1);
  assert.ok(units[0].text.includes("const b = 2;"));
});

test("instruction hashes survive cosmetic reformatting but not meaning changes", () => {
  assert.equal(unitHash("Always include the **PR URL**"), unitHash("always include the PR URL"));
  assert.notEqual(unitHash("Always include the PR URL"), unitHash("Never include the PR URL"));
});

test("evidence re-anchors onto a lightly edited instruction and goes stale on a rewrite", () => {
  const file = { units: parseMemoryUnits("# T\n\nAlways include the full PR URL in any update.\n") };

  const byHash = reanchor({ hash: file.units[0].hash }, file);
  assert.equal(byHash.match, "hash");

  const fuzzy = reanchor({ text: "Always include the PR URL in any update." }, file);
  assert.equal(fuzzy.match, "fuzzy");
  assert.ok(fuzzy.score >= 0.6);

  const stale = reanchor({ text: "Run the database migrations before deploying." }, file);
  assert.equal(stale.match, "stale");
  assert.equal(stale.unit, null);
});

test("similarity is symmetric and bounded", () => {
  const a = "always include the pr url";
  const b = "always include the full pr url";
  assert.equal(similarity(a, b), similarity(b, a));
  assert.equal(similarity(a, a), 1);
  assert.ok(similarity(a, "totally unrelated sentence here") < 0.2);
});

test("a skill extraction reports its always-loaded saving against the description cost", () => {
  const edit = {
    kind: "extract",
    find: "x".repeat(2400), // 600 tok removed from the always-loaded file
    replace: "See the release-signing skill.",
    skill: { name: "release-signing", description: "y".repeat(120), body: "z".repeat(2400) },
  };

  const effect = extractionBudgetEffect(edit);
  assert.equal(effect.alwaysLoadedDelta, -592);
  assert.equal(effect.descriptionCost, 30);
  assert.equal(effect.net, -562);
  assert.ok(effect.net < 0, "extraction must be net-negative on the always-loaded budget");
});

test("skill frontmatter round-trips through render and parse", () => {
  const skill = {
    name: "release-signing",
    description: "Load before tagging a release or signing artifacts.",
    body: "## Steps\n\n1. Do the thing.",
  };
  const parsed = parseFrontmatter(renderSkillFile(skill));
  assert.equal(parsed.name, skill.name);
  assert.equal(parsed.description, skill.description);
});

test("folded multi-line frontmatter descriptions are joined", () => {
  const text =
    "---\nname: deploy\ndescription: Load before any production deploy,\n  or release promotion.\n---\n\nbody\n";
  assert.equal(parseFrontmatter(text).description, "Load before any production deploy, or release promotion.");
});
