import test from "node:test";
import assert from "node:assert/strict";

import { parseMemoryUnits } from "../src/memory.js";
import { crossSurfaceDuplicates } from "../src/overlap.js";

const texts = (text) => parseMemoryUnits(text).map((unit) => unit.text);

test("a thematic break is not a unit and keeps the text around it apart", () => {
  const units = parseMemoryUnits(
    "# Guide\n\nRun the linter before you commit.\n\n---\n\n## Tests\n\nRun the unit tests with `make test`.\n\n---\n\nKeep commits small.\n",
  );
  assert.deepEqual(
    units.map((unit) => [unit.id, unit.text]),
    [
      ["AG-001", "Run the linter before you commit."],
      ["AG-002", "Run the unit tests with `make test`."],
      ["AG-003", "Keep commits small."],
    ],
  );
  assert.equal(units[2].section, "Guide > Tests");
});

test("CommonMark thematic break variants are skipped and flush the current unit", () => {
  for (const rule of ["***", "___", "- - -", "* * *", "_ _ _", "   ----", "-----  ", "*\t*\t*"]) {
    assert.deepEqual(texts(`- First rule.\n${rule}\n- Second rule.\n`), ["- First rule.", "- Second rule."], rule);
    assert.deepEqual(texts(`First rule.\n\n${rule}\nSecond rule.\n`), ["First rule.", "Second rule."], rule);
  }
});

test("near-misses of a thematic break stay content", () => {
  assert.deepEqual(texts("Rule one.\n\n--\n"), ["Rule one.", "--"]);
  assert.deepEqual(texts("Rule one.\n\n    ---\n"), ["Rule one.", "    ---"], "four leading spaces is code");
  assert.deepEqual(texts("Rule one.\n\n-*-\n"), ["Rule one.", "-*-"], "mixed characters are not a break");
});

test("a list item is still a unit", () => {
  assert.deepEqual(texts("# Rules\n\n- item\n- another item\n"), ["- item", "- another item"]);
});

test("a thematic break inside a fence is preserved as content", () => {
  const fenced = "Example frontmatter:\n```yaml\n---\nname: x\n---\n***\n```";
  assert.deepEqual(texts(`# Rules\n\n${fenced}\n`), [fenced]);
});

test("a dash run directly under a paragraph is a setext heading, not a unit", () => {
  const units = parseMemoryUnits("# Guide\n\nRelease steps\n---\n\nTag the commit.\n\n## Other\n\nShip it.\n");
  assert.deepEqual(
    units.map((unit) => [unit.text, unit.section]),
    [
      ["Tag the commit.", "Guide > Release steps"],
      ["Ship it.", "Guide > Other"],
    ],
  );
});

test("a dash run under a list item, quote, indented code, or fence is a break, not a setext underline", () => {
  assert.deepEqual(texts("- Keep it small.\n---\nNext.\n"), ["- Keep it small.", "Next."]);
  assert.deepEqual(texts("> Quoted rule.\n---\nNext.\n"), ["> Quoted rule.", "Next."]);
  assert.deepEqual(texts("```\ncode\n```\n---\nNext.\n"), ["```\ncode\n```", "Next."]);
  assert.deepEqual(texts("    npm test\n---\nNext.\n"), ["    npm test", "Next."], "indented code is not a title");
  assert.deepEqual(texts("\tnpm test\n---\nNext.\n"), ["\tnpm test", "Next."], "tab-indented code is not a title");
  assert.deepEqual(texts("Paragraph.\n***\nNext.\n"), ["Paragraph.", "Next."], "only dashes underline a heading");
});

test("a shared thematic break is not a cross-surface overlap", () => {
  const memoryFile = {
    path: "AGENTS.md",
    units: parseMemoryUnits("# Guide\n\nRun the linter.\n\n---\n\nKeep commits small.\n"),
  };
  const skill = {
    name: "demo",
    path: ".agents/skills/demo/SKILL.md",
    description: "Use when releasing.",
    body: "# Release\n\nTag the commit, then push the tag.\n\n---\n\nWrite the changelog entry.",
  };
  assert.deepEqual(crossSurfaceDuplicates(memoryFile, [skill]), []);
});
