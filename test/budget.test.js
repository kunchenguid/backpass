import test from "node:test";
import assert from "node:assert/strict";

import { budgetBar, budgetGateKind, budgetStatus, estimateTokens, formatTokens } from "../src/tokens.js";
import {
  ATTRIBUTION_SPLIT_TOKENS,
  parseMemoryUnits,
  renderInstructionIndex,
  similarity,
  reanchor,
  unitHash,
} from "../src/memory.js";
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
  assert.notEqual(over, full, "twice the cap must not render as merely full");
  assert.match(over, /!!\]$/, "the overflow marker gets its own cells past 100%");
  assert.equal(over.length, full.length, "both bars stay the same width");
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

function oversizedParagraph(count = 5) {
  return Array.from(
    { length: count },
    (_, i) =>
      `Sentence ${i + 1} states an independent requirement about builds, releases, adapters, and review that an agent must actually follow rather than skip.`,
  ).join(" ");
}

test("an oversized paragraph keeps its positional alias and exposes sentence parts for attribution", () => {
  const blob = oversizedParagraph();
  const units = parseMemoryUnits(`# Memory\n\n${blob}\n\n- Keep the next unit's id stable.\n`);
  assert.ok(estimateTokens(blob) > ATTRIBUTION_SPLIT_TOKENS);
  assert.deepEqual(
    units.map((u) => u.id),
    ["AG-001", "AG-002"],
    "later units keep positional aliases; parts are dotted, not extra AG-nnn ids",
  );
  assert.equal(units[1].text, "- Keep the next unit's id stable.");
  assert.ok(units[0].parts?.length >= 2, "the blob splits on sentence boundaries");
  assert.deepEqual(
    units[0].parts.map((p) => p.id),
    units[0].parts.map((_, i) => `AG-001.${i + 1}`),
  );
  assert.equal(units[0].parts[0].parentId, "AG-001");
  assert.ok(units[0].parts.every((p) => p.startLine === units[0].startLine && p.endLine === units[0].endLine));
  assert.ok(units[0].parts.every((p) => blob.includes(p.text)));

  const index = renderInstructionIndex({ units });
  assert.match(index, /Oversized paragraph AG-001/);
  assert.match(index, /\[AG-001\.1\]/);
  assert.match(index, /\[AG-001\.2\]/);
  assert.match(index, /split the paragraph into list items/);
  assert.match(index, /bold label on the blob is not a strengthen/);
  assert.doesNotMatch(index, /\[AG-001\]/, "the blob itself is not an attribution target");
});

test("oversized Markdown-heavy paragraphs split realistic sentences without splitting abbreviations", () => {
  const cycle =
    "Review with Dr. Smith before release. `pnpm test` verifies behavior. deploy now checks lowercase commands. Écrivez les résultats clairement.";
  const blob = Array.from({ length: 8 }, () => cycle).join(" ");
  const [unit] = parseMemoryUnits(`# T\n\n${blob}\n`);

  assert.ok(estimateTokens(blob) > ATTRIBUTION_SPLIT_TOKENS);
  assert.ok(unit.parts?.length > 8);
  assert.ok(unit.parts.some((part) => part.text.startsWith("`pnpm test`")));
  assert.ok(unit.parts.some((part) => part.text.startsWith("deploy now")));
  assert.ok(unit.parts.some((part) => part.text.startsWith("Écrivez")));
  assert.ok(unit.parts.every((part) => part.text !== "Review with Dr."));
  assert.ok(unit.parts.some((part) => part.text.startsWith("Review with Dr. Smith")));
});

test("the confidence segmenter handles abbreviations, Markdown endings, and short sentences", () => {
  const cycle =
    "Consult Capt. Smith before release. Run **checks**. Deploy safely. Run `pnpm test`. Deploy safely. Run checks. pnpm test verifies them.";
  const blob = Array.from({ length: 8 }, () => cycle).join(" ");
  const [unit] = parseMemoryUnits(`# T\n\n${blob}\n`);

  assert.ok(estimateTokens(blob) > ATTRIBUTION_SPLIT_TOKENS);
  assert.ok(unit.parts?.every((part) => part.text !== "Consult Capt."));
  assert.ok(unit.parts?.some((part) => part.text === "Consult Capt. Smith before release."));
  assert.ok(unit.parts?.some((part) => part.text === "Run **checks**."));
  assert.ok(unit.parts?.some((part) => part.text === "Run `pnpm test`."));
  assert.ok(unit.parts?.some((part) => part.text === "Run checks."));
  assert.ok(unit.parts?.some((part) => part.text === "pnpm test verifies them."));
});

test("clear short sentences split regardless of segment length", () => {
  const cycle = "Run checks. pnpm test verifies them.";
  const blob = Array.from({ length: 20 }, () => cycle).join(" ");
  const [unit] = parseMemoryUnits(`# T\n\n${blob}\n`);

  assert.ok(estimateTokens(blob) > ATTRIBUTION_SPLIT_TOKENS);
  assert.ok(unit.parts?.some((part) => part.text === "Run checks."));
  assert.ok(unit.parts?.some((part) => part.text === "pnpm test verifies them."));
});

test("ambiguous abbreviations stay attached while clear sentence boundaries still split", () => {
  const cycle = "See approx. Five checks follow. A clear requirement governs deployment.";
  const blob = Array.from({ length: 12 }, () => cycle).join(" ");
  const [unit] = parseMemoryUnits(`# T\n\n${blob}\n`);

  assert.ok(estimateTokens(blob) > ATTRIBUTION_SPLIT_TOKENS);
  assert.ok(unit.parts?.length > 12);
  assert.ok(unit.parts.every((part) => part.text !== "See approx."));
  assert.ok(unit.parts.some((part) => part.text === "See approx. Five checks follow."));
  assert.ok(unit.parts.some((part) => part.text === "A clear requirement governs deployment."));
});

test("generic punctuation cannot suppress later clear attribution boundaries", () => {
  const cycle =
    "Keep retries < 3. Deploy safely. Verify results. Mark *critical text. Continue safely. Work from . Next verify.";
  const blob = Array.from({ length: 12 }, () => cycle).join(" ");
  const [unit] = parseMemoryUnits(`# T\n\n${blob}\n`);

  assert.ok(estimateTokens(blob) > ATTRIBUTION_SPLIT_TOKENS);
  assert.ok(unit.parts?.some((part) => part.text === "Keep retries < 3."));
  assert.ok(unit.parts?.some((part) => part.text === "Deploy safely."));
  assert.ok(unit.parts?.some((part) => part.text === "Verify results."));
  assert.ok(unit.parts?.some((part) => part.text === "Continue safely."));
  assert.ok(unit.parts?.some((part) => part.text === "Work from . Next verify."));
});

test("paths, URLs, and inline code do not create fragment attribution targets", () => {
  const cycle =
    'Read docs/config.md before editing. Read docs/config.md. Then verify the result. Read docs/config.md. src/main.js does the work. Read "C:\\Program Files\\Foo. Bar\\config" before editing. Read C:\\Program Files\\Foo. Bar\\config before editing. Read docs/Program Files/Foo. Bar/config before editing. Read docs/Foo. Bar Baz/config before editing. Visit https://example.test/docs/config.md before editing. Run `node app.js. --watch` afterward.';
  const blob = Array.from({ length: 8 }, () => cycle).join(" ");
  const [unit] = parseMemoryUnits(`# T\n\n${blob}\n`);

  assert.ok(estimateTokens(blob) > ATTRIBUTION_SPLIT_TOKENS);
  assert.ok(unit.parts?.length > 8);
  assert.ok(unit.parts.some((part) => part.text === "Read docs/config.md before editing."));
  assert.ok(unit.parts.some((part) => part.text === "Read docs/config.md."));
  assert.ok(unit.parts.some((part) => part.text === "Then verify the result."));
  assert.ok(unit.parts.every((part) => part.text !== "Read docs/config.md. Then verify the result."));
  assert.ok(unit.parts.some((part) => part.text === "src/main.js does the work."));
  assert.ok(unit.parts.every((part) => part.text !== "Read docs/config.md. src/main.js does the work."));
  assert.ok(unit.parts.some((part) => part.text === 'Read "C:\\Program Files\\Foo. Bar\\config" before editing.'));
  assert.ok(unit.parts.every((part) => part.text !== 'Read "C:\\Program Files\\Foo.'));
  assert.ok(unit.parts.some((part) => part.text === "Read C:\\Program Files\\Foo. Bar\\config before editing."));
  assert.ok(unit.parts.every((part) => part.text !== "Read C:\\Program Files\\Foo."));
  assert.ok(unit.parts.some((part) => part.text === "Read docs/Program Files/Foo. Bar/config before editing."));
  assert.ok(unit.parts.every((part) => part.text !== "Read docs/Program Files/Foo."));
  assert.ok(unit.parts.some((part) => part.text === "Read docs/Foo. Bar Baz/config before editing."));
  assert.ok(unit.parts.every((part) => part.text !== "Read docs/Foo."));
  assert.ok(unit.parts.some((part) => part.text === "Visit https://example.test/docs/config.md before editing."));
  assert.ok(unit.parts.some((part) => part.text === "Run `node app.js. --watch` afterward."));
  assert.ok(unit.parts.every((part) => !part.text.startsWith("--watch`")));
});

test("URL-ending questions and exclamations remain sentence boundaries", () => {
  const cycle =
    "Is it https://example.com/docs? Check the result! Visit https://example.com/search?q=one!two before release. Follow AG-001.2 before editing.";
  const blob = Array.from({ length: 8 }, () => cycle).join(" ");
  const [unit] = parseMemoryUnits(`# T\n\n${blob}\n`);

  assert.ok(estimateTokens(blob) > ATTRIBUTION_SPLIT_TOKENS);
  assert.ok(unit.parts?.some((part) => part.text === "Is it https://example.com/docs?"));
  assert.ok(unit.parts?.some((part) => part.text === "Check the result!"));
  assert.ok(unit.parts?.some((part) => part.text === "Visit https://example.com/search?q=one!two before release."));
  assert.ok(unit.parts?.some((part) => part.text === "Follow AG-001.2 before editing."));
});

test("an escaped literal backtick cannot disable sentence attribution", () => {
  const blob =
    "Write \\` for literal output. " +
    Array.from({ length: 12 }, (_, i) => `Run check ${i + 1} before deployment. Deploy safely afterward.`).join(" ");
  const [unit] = parseMemoryUnits(`# T\n\n${blob}\n`);

  assert.ok(estimateTokens(blob) > ATTRIBUTION_SPLIT_TOKENS);
  assert.ok(unit.parts?.length > 12);
  assert.equal(unit.parts[0].text, "Write \\` for literal output.");
  assert.ok(unit.parts.some((part) => part.text === "Deploy safely afterward."));
});

test("list items and fenced blocks are not sentence-split even when oversized", () => {
  const blob = oversizedParagraph();
  const listed = parseMemoryUnits(`# T\n\n- ${blob}\n`);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "AG-001");
  assert.equal(listed[0].parts, undefined);

  const fenced = parseMemoryUnits(`# T\n\n\`\`\`\n${blob}\n\`\`\`\n`);
  assert.equal(fenced.length, 1);
  assert.equal(fenced[0].parts, undefined);
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
