import test from "node:test";
import assert from "node:assert/strict";

import { runAnalysis } from "../src/commands/analyze.js";
import { loadConfig } from "../src/config.js";
import { clearProgressSink, setProgressSink } from "../src/progress.js";
import { State } from "../src/state.js";
import { estimateTokens } from "../src/tokens.js";
import { makeRepo } from "./helpers/staging.js";

const MEMORY = "# Rules\n\n- Keep changes focused.\n";
const DESCRIPTION = "Load before changing database queries.";
const SKILL = `---\nname: database\ndescription: ${DESCRIPTION}\n---\n\nRead the schema first.\n`;

test("analysis emits the always-loaded surface for live progress", async () => {
  const repo = makeRepo({
    "AGENTS.md": MEMORY,
    ".agents/skills/database/SKILL.md": SKILL,
  });
  const config = loadConfig(repo.root, {
    memoryFiles: ["AGENTS.md"],
    skillsDir: ".agents/skills",
    discovery: { harnesses: [] },
  });
  config.state = new State(repo.root).ensure();

  const events = [];
  setProgressSink((event, data) => events.push({ event, data }));
  try {
    await runAnalysis({ repo, config, flags: {}, strict: false });
  } finally {
    clearProgressSink();
  }

  const memory = events.find((event) => event.event === "memory");
  assert.ok(memory);
  assert.equal(memory.data.label, "AGENTS.md + skill descriptions");
  assert.equal(memory.data.tokens, estimateTokens(MEMORY) + estimateTokens(DESCRIPTION));
});
