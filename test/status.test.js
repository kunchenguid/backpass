import test from "node:test";
import assert from "node:assert/strict";

import { cmdStatus } from "../src/commands/status.js";
import { loadConfig } from "../src/config.js";
import { State } from "../src/state.js";
import { estimateTokens } from "../src/tokens.js";
import { makeRepo } from "./helpers/staging.js";

const MEMORY = "# Rules\n\n- Keep changes focused.\n";
const DESCRIPTION = "Load before changing database queries.";
const SKILL = `---\nname: database\ndescription: ${DESCRIPTION}\n---\n\n# Database\n\nRead the schema first.\n`;

async function captureStatus(repo, json) {
  const config = loadConfig(repo.root, {
    memoryFiles: ["AGENTS.md"],
    skillsDir: ".agents/skills",
    budgetTokens: estimateTokens(MEMORY),
  });
  config.state = new State(repo.root).ensure();
  config.agents = {
    pinned: () => ({ agent: "test", model: null, reason: "test" }),
    ladder: () => [],
  };

  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await cmdStatus({ repo, config, flags: { json } });
  } finally {
    console.log = original;
  }
  return lines;
}

test("status counts synthesis-eligible and report-only gap clusters", async () => {
  const repo = makeRepo({ "AGENTS.md": MEMORY });
  const state = new State(repo.root).ensure();
  state.writeSummary({
    analyzedSessions: 4,
    totals: {
      positive: 2,
      negative: 1,
      gapClusters: 1,
      reportOnlyGapClusters: 2,
    },
  });

  const text = (await captureStatus(repo, false)).join("\n");
  assert.match(text, /3 gap cluster\(s\) \(1 synthesis eligible · 2 report only\)/);
});

test("status reports one always-loaded budget over memory and skill descriptions", async () => {
  const repo = makeRepo({
    "AGENTS.md": MEMORY,
    ".agents/skills/database/SKILL.md": SKILL,
  });
  const expected = estimateTokens(MEMORY) + estimateTokens(DESCRIPTION);

  const structured = JSON.parse((await captureStatus(repo, true)).join("\n"));
  assert.equal(structured.budgets.length, 1);
  assert.equal(structured.budgets[0].current, expected);
  assert.equal(structured.budgets[0].projected, expected);
  assert.equal(structured.budgets[0].label, "AGENTS.md + skill descriptions");
  assert.equal(structured.budgets[0].over, estimateTokens(DESCRIPTION));

  const text = (await captureStatus(repo, false)).join("\n");
  assert.match(text, new RegExp(`AGENTS\\.md \\+ skill descriptions.*${expected} /`));
  assert.equal((text.match(/AGENTS\.md \+ skill descriptions/g) || []).length, 1);
  assert.equal(structured.crossSurfaceDuplicates.length, 0);
});

test("status reports a memory unit that restates a skill description", async () => {
  const repo = makeRepo({
    "AGENTS.md": `# Rules\n\n- ${DESCRIPTION}\n- Keep changes focused.\n`,
    ".agents/skills/database/SKILL.md": SKILL,
  });

  const structured = JSON.parse((await captureStatus(repo, true)).join("\n"));
  assert.equal(structured.crossSurfaceDuplicates.length, 1);
  assert.equal(structured.crossSurfaceDuplicates[0].instruction, "AG-001");
  assert.equal(structured.crossSurfaceDuplicates[0].skill, "database");
  assert.equal(structured.crossSurfaceDuplicates[0].surface, "description");

  const text = (await captureStatus(repo, false)).join("\n");
  assert.match(text, /CROSS-SURFACE \(report-only\)/);
  assert.match(text, /AG-001 restates database description.*duplicated always loaded/);
});

test("status identifies body overlap as triggered placement evidence", async () => {
  const body = "Always wrap migrations in a transaction before applying them.";
  const repo = makeRepo({
    "AGENTS.md": `# Rules\n\n- ${body}\n`,
    ".agents/skills/database/SKILL.md": `---\nname: database\ndescription: Database skill.\n---\n\n${body}\n`,
  });

  const structured = JSON.parse((await captureStatus(repo, true)).join("\n"));
  assert.equal(structured.crossSurfaceDuplicates.length, 1);
  assert.equal(structured.crossSurfaceDuplicates[0].surface, "body");

  const text = (await captureStatus(repo, false)).join("\n");
  assert.match(text, /AG-001 restates database body.*body loads on trigger; weigh placement/);
  assert.doesNotMatch(text, /duplicated always loaded/);
});
