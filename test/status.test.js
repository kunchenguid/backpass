import test from "node:test";
import assert from "node:assert/strict";

import { cmdStatus } from "../src/commands/status.js";
import { loadConfig } from "../src/config.js";
import { nestedReach, writeNestedReach } from "../src/nested.js";
import { State } from "../src/state.js";
import { estimateTokens } from "../src/tokens.js";
import { makeRepo } from "./helpers/staging.js";

const MEMORY = "# Rules\n\n- Keep changes focused.\n";
const DESCRIPTION = "Load before changing database queries.";
const SKILL = `---\nname: database\ndescription: ${DESCRIPTION}\n---\n\n# Database\n\nRead the schema first.\n`;

async function captureStatus(repo, json, overrides = {}) {
  const config = loadConfig(repo.root, {
    memoryFiles: ["AGENTS.md"],
    skillsDir: ".agents/skills",
    budgetTokens: estimateTokens(MEMORY),
    ...overrides,
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

test("status neither counts nor reports thematic breaks as instructions (#192)", async () => {
  const repo = makeRepo({
    "AGENTS.md":
      "# Guide\n\nRun the linter before you commit.\n\n---\n\n## Tests\n\nRun the unit tests with `make test`.\n\n---\n\nKeep commits small.\n",
    ".agents/skills/demo/SKILL.md":
      "---\nname: demo\ndescription: Use when releasing.\n---\n\n# Release\n\nTag the commit, then push the tag.\n\n---\n\nWrite the changelog entry.\n",
  });

  const structured = JSON.parse((await captureStatus(repo, true)).join("\n"));
  assert.deepEqual(structured.crossSurfaceDuplicates, []);

  const text = (await captureStatus(repo, false)).join("\n");
  assert.match(text, /· 3 instructions/);
  assert.doesNotMatch(text, /restates demo/);
});

test("status shows each nested file's sampled-session reach and warns only below minGapEvidence", async () => {
  const repo = makeRepo({
    "AGENTS.md": MEMORY,
    "apps/api/AGENTS.md": "# API\n\n- Handlers live in src/routes.\n",
    "apps/web/AGENTS.md": "# Web\n\n- Components live in src/ui.\n",
    "apps/docs/AGENTS.md": "# Docs\n\n- Pages live in src/pages.\n",
  });
  const nested = { nestedMemoryFiles: ["apps/api/AGENTS.md", "apps/web/AGENTS.md", "apps/docs/AGENTS.md"] };
  const state = new State(repo.root).ensure();
  const corpus = (n) => Array.from({ length: n }, () => ({}));
  writeNestedReach(
    state,
    nestedReach(
      [
        { weight: { path: "apps/api/AGENTS.md", dir: "apps/api" }, transcripts: corpus(1) },
        { weight: { path: "apps/web/AGENTS.md", dir: "apps/web" }, transcripts: corpus(2) },
      ],
      78,
      2,
    ),
  );

  const text = (await captureStatus(repo, false, nested)).join("\n");
  assert.match(text, /NESTED EVIDENCE REACH \(sampled sessions at the last attribution, [^;]+; report-only\)/);
  assert.match(
    text,
    /apps\/api\/AGENTS\.md: 1 of 78 sampled session\(s\) worked only under apps\/api\/\n {4}below minGapEvidence \(2\); no add, rewrite, or remove edit can reach this file/,
  );
  assert.match(
    text,
    /apps\/web\/AGENTS\.md: 2 of 78 sampled session\(s\) worked only under apps\/web\/\n(?! {4}below)/,
  );
  assert.equal((text.match(/below minGapEvidence/g) || []).length, 1);
  assert.match(text, /apps\/docs\/AGENTS\.md: not yet measured - run `backpass` or `backpass analyze`/);

  const structured = JSON.parse((await captureStatus(repo, true, nested)).join("\n"));
  assert.deepEqual(
    structured.nestedAttribution.files.map((entry) => [
      entry.path,
      entry.measured,
      entry.sessions,
      entry.sampledSessions,
      entry.minGapEvidence,
      entry.belowMinGapEvidence,
    ]),
    [
      ["apps/api/AGENTS.md", true, 1, 78, 2, true],
      ["apps/web/AGENTS.md", true, 2, 78, 2, false],
      ["apps/docs/AGENTS.md", false, null, null, null, null],
    ],
  );

  const plain = JSON.parse((await captureStatus(repo, true)).join("\n"));
  assert.equal(plain.nestedAttribution, undefined);
});
