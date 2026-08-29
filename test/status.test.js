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
});
