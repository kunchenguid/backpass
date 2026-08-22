import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyEdit,
  buildProposal,
  DEFAULT_MAX_EDITS,
  effectiveMaxEdits,
  projectWithDecisions,
  SHRINK_EDIT_TOKENS,
  SHRINK_MAX_EDITS,
} from "../src/proposal.js";
import { parseMemoryUnits } from "../src/memory.js";
import { estimateTokens } from "../src/tokens.js";
import { isSuppressedByRejection, recordRejection, State } from "../src/state.js";
import { applyDecisions } from "../src/apply/writer.js";
import { injectPayload, parseDecisions } from "../src/apply/lavish.js";
import { extractJson, parseTokenLine, stripAcpxNoise } from "../src/acpx.js";

const MEMORY_TEXT = [
  "# Demo agent instructions",
  "",
  "## Rules",
  "",
  "- Whenever a PR is mentioned, include its URL.",
  "- Use Node 18 via nvm before running any script.",
  "",
].join("\n");

function memoryFile(text = MEMORY_TEXT) {
  return {
    path: "AGENTS.md",
    text,
    hash: "sha256:test",
    tokens: estimateTokens(text),
    units: parseMemoryUnits(text),
  };
}

function context(overrides = {}) {
  return {
    memoryFile: memoryFile(),
    repo: { name: "demo", root: "/repo/demo" },
    summary: { analyzedSessions: 4, totals: { positive: 3, negative: 2, gapClusters: 1 } },
    config: {
      budgetTokens: 5000,
      maxEditsPerRun: 5,
      minGapEvidence: 2,
      skillsDir: ".claude/skills",
      analysis: { agent: "codex" },
      synthesis: { agent: "claude" },
    },
    skillFiles: [],
    ...overrides,
  };
}

const QUOTE = [{ polarity: "negative", text: "it used a bare #2731 reference", source: "claude · abc · turn 3" }];

test("a rewrite edit replaces exactly the text it names", () => {
  const next = applyEdit(MEMORY_TEXT, {
    id: "e1",
    file: "AGENTS.md",
    find: "- Whenever a PR is mentioned, include its URL.",
    replace: "- Whenever a PR is mentioned, include its full https:// URL.",
  });
  assert.ok(next.includes("full https:// URL"));
  assert.ok(!next.includes("include its URL."));
});

test("an add edit inserts after its anchor, and appends when there is none", () => {
  const anchored = applyEdit(MEMORY_TEXT, {
    id: "e1",
    file: "AGENTS.md",
    find: "",
    anchor: "## Rules",
    replace: "- Read docs/db.md before writing queries.",
  });
  const rulesAt = anchored.indexOf("## Rules");
  const newRuleAt = anchored.indexOf("- Read docs/db.md");
  const oldRuleAt = anchored.indexOf("- Whenever a PR");
  assert.ok(rulesAt < newRuleAt && newRuleAt < oldRuleAt, "insertion lands directly after the anchor");

  const appended = applyEdit(MEMORY_TEXT, { id: "e2", file: "AGENTS.md", find: "", replace: "- Appended rule." });
  assert.ok(appended.trimEnd().endsWith("- Appended rule."));
});

test("a remove edit deletes its text", () => {
  const next = applyEdit(MEMORY_TEXT, {
    id: "e1",
    file: "AGENTS.md",
    find: "- Use Node 18 via nvm before running any script.\n",
    replace: "",
  });
  assert.ok(!next.includes("Node 18"));
});

test("an edit whose find text is missing or ambiguous is refused, never guessed at", () => {
  assert.throws(
    () => applyEdit(MEMORY_TEXT, { id: "e1", file: "AGENTS.md", find: "text that is not there", replace: "x" }),
    /does not appear/,
  );

  const doubled = `${MEMORY_TEXT}\n- Whenever a PR is mentioned, include its URL.\n`;
  assert.throws(
    () =>
      applyEdit(doubled, {
        id: "e1",
        file: "AGENTS.md",
        find: "- Whenever a PR is mentioned, include its URL.",
        replace: "x",
      }),
    /appears 2 times/,
  );
});

test("the per-run edit cap is enforced - it is the learning rate", () => {
  const edits = Array.from({ length: 6 }, (_, i) => ({
    kind: "rewrite",
    file: "AGENTS.md",
    title: `edit ${i}`,
    find: "- Use Node 18 via nvm before running any script.",
    replace: `- Rule ${i}.`,
    evidence: QUOTE,
    transcripts: 3,
  }));

  const { violations } = buildProposal({ edits }, context());
  assert.ok(violations.some((v) => /per-run cap is 5/.test(v)));
});

test("a new instruction backed by too few sessions is rejected", () => {
  const { proposal, violations } = buildProposal(
    {
      edits: [
        {
          kind: "add",
          file: "AGENTS.md",
          title: "new rule from one session",
          find: "",
          anchor: "## Rules",
          replace: "- Speculative rule.",
          evidence: QUOTE,
          transcripts: 1,
        },
      ],
    },
    context(),
  );

  assert.equal(proposal.edits.length, 0);
  assert.ok(violations.some((v) => /backed by 1 session/.test(v)));
});

test("an edit with no verbatim quote is rejected", () => {
  const { proposal, violations } = buildProposal(
    {
      edits: [
        {
          kind: "remove",
          file: "AGENTS.md",
          title: "unsupported",
          find: "- Use Node 18 via nvm before running any script.\n",
          replace: "",
          evidence: [],
        },
      ],
    },
    context(),
  );

  assert.equal(proposal.edits.length, 0);
  assert.ok(violations.some((v) => /no verbatim evidence quote/.test(v)));
});

test("token deltas are measured by backpass, not taken from the model", () => {
  const { proposal, violations } = buildProposal(
    {
      edits: [
        {
          kind: "remove",
          file: "AGENTS.md",
          title: "drop the stale Node pin",
          find: "- Use Node 18 via nvm before running any script.\n",
          replace: "",
          evidence: QUOTE,
          transcripts: 3,
          deltaTokens: 9999,
        },
      ],
    },
    context(),
  );

  assert.deepEqual(violations, []);
  assert.equal(proposal.edits.length, 1);
  assert.ok(proposal.edits[0].deltaTokens < 0, "a removal must reduce the always-loaded cost");
  assert.notEqual(proposal.edits[0].deltaTokens, 9999);
  assert.equal(proposal.budget.projected, proposal.budget.current + proposal.edits[0].deltaTokens);
});

test("a proposal that would exceed the budget fails the gate", () => {
  const big = "x".repeat(4800); // ~1,200 tok, over a tiny cap
  const { violations } = buildProposal(
    {
      edits: [
        {
          kind: "add",
          file: "AGENTS.md",
          title: "bloat",
          find: "",
          anchor: "## Rules",
          replace: big,
          evidence: QUOTE,
          transcripts: 3,
        },
      ],
    },
    context({ config: { ...context().config, budgetTokens: 100 } }),
  );

  assert.ok(violations.some((v) => /over the 100-token budget/.test(v)));
});

test("an extract edit requires a skill draft, and a non-extract must not carry one", () => {
  const skill = { name: "release-signing", description: "Load before tagging a release.", body: "steps" };

  const missing = buildProposal(
    {
      edits: [
        {
          kind: "extract",
          file: "AGENTS.md",
          title: "x",
          find: "- Use Node 18 via nvm before running any script.",
          replace: "see skill",
          evidence: QUOTE,
          transcripts: 2,
        },
      ],
    },
    context(),
  );
  assert.ok(missing.violations.some((v) => /requires a skill draft/.test(v)));

  const stray = buildProposal(
    {
      edits: [
        {
          kind: "rewrite",
          file: "AGENTS.md",
          title: "x",
          find: "- Use Node 18 via nvm before running any script.",
          replace: "y",
          evidence: QUOTE,
          transcripts: 2,
          skill,
        },
      ],
    },
    context(),
  );
  assert.ok(stray.violations.some((v) => /only kind "extract"/.test(v)));

  const good = buildProposal(
    {
      edits: [
        {
          kind: "extract",
          file: "AGENTS.md",
          title: "x",
          find: "- Use Node 18 via nvm before running any script.",
          replace: "- See the release-signing skill.",
          evidence: QUOTE,
          transcripts: 2,
          skill,
        },
      ],
    },
    context(),
  );
  assert.deepEqual(good.violations, []);
  assert.equal(good.proposal.edits[0].skill.path, ".claude/skills/release-signing/SKILL.md");
  assert.equal(good.proposal.stats.skillExtractions, 1);
});

test("a previously rejected edit is suppressed until new evidence arrives", () => {
  const edit = {
    kind: "remove",
    file: "AGENTS.md",
    title: "drop the stale Node pin",
    find: "- Use Node 18 via nvm before running any script.\n",
    replace: "",
    evidence: QUOTE,
    transcripts: 3,
  };

  const rejections = recordRejection({ ...edit, id: "e1" }, { version: 1, entries: {} });

  const suppressed = buildProposal({ edits: [edit] }, context({ rejections, isSuppressed: isSuppressedByRejection }));
  assert.equal(suppressed.proposal.edits.length, 0, "same evidence weight stays rejected");

  const revived = buildProposal(
    { edits: [{ ...edit, transcripts: 9 }] },
    context({ rejections, isSuppressed: isSuppressedByRejection }),
  );
  assert.equal(revived.proposal.edits.length, 1, "materially new evidence revives the edit");
});

test("projectWithDecisions tracks the budget for the subset the human accepted", () => {
  const { proposal } = buildProposal(
    {
      edits: [
        {
          kind: "remove",
          file: "AGENTS.md",
          title: "a",
          find: "- Use Node 18 via nvm before running any script.\n",
          replace: "",
          evidence: QUOTE,
          transcripts: 3,
        },
        {
          kind: "rewrite",
          file: "AGENTS.md",
          title: "b",
          find: "- Whenever a PR is mentioned, include its URL.",
          replace: "- Whenever a PR is mentioned, include its full https:// URL before any shorthand.",
          evidence: QUOTE,
          transcripts: 3,
        },
      ],
    },
    context(),
  );

  const none = projectWithDecisions(MEMORY_TEXT, proposal.edits, [], 5000);
  assert.equal(none.budget.delta, 0);

  const both = projectWithDecisions(MEMORY_TEXT, proposal.edits, ["e1", "e2"], 5000);
  assert.equal(both.budget.projected, proposal.budget.projected);

  const onlyFirst = projectWithDecisions(MEMORY_TEXT, proposal.edits, ["e1"], 5000);
  assert.ok(onlyFirst.budget.delta < 0);
  assert.ok(!onlyFirst.text.includes("Node 18"));
  assert.ok(onlyFirst.text.includes("include its URL."), "the unaccepted edit is not applied");
});

test("applying decisions writes accepted edits, skips rejected ones, and remembers rejections", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-apply-"));
  fs.writeFileSync(path.join(dir, "AGENTS.md"), MEMORY_TEXT);
  const state = new State(dir).ensure();

  const { proposal } = buildProposal(
    {
      edits: [
        {
          kind: "remove",
          file: "AGENTS.md",
          title: "drop node pin",
          find: "- Use Node 18 via nvm before running any script.\n",
          replace: "",
          evidence: QUOTE,
          transcripts: 3,
        },
        {
          kind: "rewrite",
          file: "AGENTS.md",
          title: "pr url",
          find: "- Whenever a PR is mentioned, include its URL.",
          replace: "- Always include the full PR URL.",
          evidence: QUOTE,
          transcripts: 3,
        },
      ],
    },
    context({ repo: { name: "demo", root: dir } }),
  );

  const results = applyDecisions({
    proposal,
    decisions: { e1: "accepted", e2: "rejected" },
    repo: { root: dir },
    state,
    config: { budgetTokens: 5000 },
  });

  const written = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.ok(!written.includes("Node 18"), "the accepted removal is applied");
  assert.ok(written.includes("include its URL."), "the rejected rewrite is not applied");
  assert.equal(results.accepted, 1);
  assert.equal(results.rejected, 1);
  assert.equal(results.failed.length, 0);
  assert.ok(results.written[0].budget.delta < 0);

  const remembered = state.readRejections();
  assert.equal(Object.keys(remembered.entries).length, 1);
});

test("a dry run reports what it would write without touching the file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-dry-"));
  fs.writeFileSync(path.join(dir, "AGENTS.md"), MEMORY_TEXT);
  const state = new State(dir).ensure();

  const { proposal } = buildProposal(
    {
      edits: [
        {
          kind: "remove",
          file: "AGENTS.md",
          title: "drop node pin",
          find: "- Use Node 18 via nvm before running any script.\n",
          replace: "",
          evidence: QUOTE,
          transcripts: 3,
        },
      ],
    },
    context({ repo: { name: "demo", root: dir } }),
  );

  const results = applyDecisions({
    proposal,
    decisions: { e1: "accepted" },
    repo: { root: dir },
    state,
    config: { budgetTokens: 5000 },
    dryRun: true,
  });

  assert.equal(results.written.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), MEMORY_TEXT, "dry run must not write");
});

test("the apply surface receives one payload, with markup in the data neutralised", () => {
  const template = "<html><head><title>t</title></head><body></body></html>";
  const html = injectPayload(template, { edits: [{ title: "</script><img onerror=alert(1)>" }] }, "0.1.0");

  assert.ok(html.includes("window.__BACKPASS_PROPOSAL__"));
  assert.ok(!html.includes("</script><img"), "injected markup must not break out of the script tag");
  assert.ok(html.includes("\\u003c/script"));
  assert.ok(html.indexOf("__BACKPASS_PROPOSAL__") < html.indexOf("</head>"));
});

test("the decision vector from the review surface is parsed back into decisions", () => {
  const ids = ["e1", "e2", "e3"];
  assert.deepEqual(parseDecisions("BACKPASS_DECISIONS e1=accepted e2=rejected e3=accepted", ids), {
    e1: "accepted",
    e2: "rejected",
    e3: "accepted",
  });
  assert.deepEqual(parseDecisions("prefix noise\ne1=accept  e2=reject\ntrailing", ids), {
    e1: "accepted",
    e2: "rejected",
  });
  assert.equal(parseDecisions("just a comment from the reviewer", ids), null);
  assert.deepEqual(parseDecisions("e9=accepted e1=accepted", ids), { e1: "accepted" }, "unknown ids are ignored");
});

test("acpx output is separated from the model answer, and usage is accounted", () => {
  const raw = '{"edits": []}\n[acpx] tokens: input=10 output=47 cache_read=11700 total=34194';
  assert.equal(stripAcpxNoise(raw), '{"edits": []}');
  assert.deepEqual(parseTokenLine(raw), { input: 10, output: 47, cache_read: 11700, total: 34194 });
  assert.equal(parseTokenLine("no accounting here"), null);
});

test("JSON is recovered from a fenced or prose-wrapped model reply", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a":2}\n```\nhope that helps'), { a: 2 });
  assert.deepEqual(extractJson('prefix {"a":3} suffix'), { a: 3 });
  assert.equal(extractJson("no json at all"), null);
});

test('an over-budget file switches the gate from "fit the cap" to "make progress"', () => {
  // 30,000 bytes ~= 7,500 tok against a 5,000 cap: unreachable in one capped run.
  const overBudget = `${MEMORY_TEXT}\n${"padding text. ".repeat(2000)}`;
  const ctx = context({ memoryFile: memoryFile(overBudget) });

  const shrinking = buildProposal(
    {
      edits: [
        {
          kind: "remove",
          file: "AGENTS.md",
          title: "drop the stale Node pin",
          find: "- Use Node 18 via nvm before running any script.\n",
          replace: "",
          evidence: QUOTE,
          transcripts: 3,
        },
      ],
    },
    ctx,
  );

  assert.deepEqual(shrinking.violations, [], "a net-negative step passes even though the cap is not reached");
  assert.equal(shrinking.proposal.budget.mode, "shrink");
  assert.equal(shrinking.proposal.budget.startedOverBudget, true);
  assert.ok(shrinking.proposal.budget.over > 0, "it reports how far over it still is");
  assert.ok(shrinking.proposal.budget.delta < 0);
});

test("an over-budget file still refuses an edit set that grows it", () => {
  const overBudget = `${MEMORY_TEXT}\n${"padding text. ".repeat(2000)}`;
  const ctx = context({ memoryFile: memoryFile(overBudget) });

  const { violations } = buildProposal(
    {
      edits: [
        {
          kind: "add",
          file: "AGENTS.md",
          title: "more rules on an already bloated file",
          find: "",
          anchor: "## Rules",
          replace: "- Yet another rule.",
          evidence: QUOTE,
          transcripts: 3,
        },
      ],
    },
    ctx,
  );

  assert.ok(violations.some((v) => /must shrink it/.test(v)));
});

test("a file within budget keeps the strict cap gate", () => {
  const { proposal } = buildProposal(
    {
      edits: [
        {
          kind: "remove",
          file: "AGENTS.md",
          title: "x",
          find: "- Use Node 18 via nvm before running any script.\n",
          replace: "",
          evidence: QUOTE,
          transcripts: 3,
        },
      ],
    },
    context(),
  );
  assert.equal(proposal.budget.mode, "cap");
  assert.equal(proposal.budget.startedOverBudget, false);
});

function rawEdits(count) {
  return Array.from({ length: count }, (_, i) => ({
    kind: "remove",
    title: `remove rule ${i + 1}`,
    find: `- rule ${i + 1}`,
    replace: "",
    rationale: "no positive evidence",
    evidence: QUOTE,
    transcripts: 3,
  }));
}

function overBudgetFile(overage, budgetTokens = 200) {
  const rules = [];
  let text = "";
  let i = 0;
  while (estimateTokens(text) < budgetTokens + overage) {
    i += 1;
    rules.push(`- rule ${i} keeps the file long enough to sit over the budget line`);
    text = `# Long memory\n\n${rules.join("\n")}\n`;
  }
  return memoryFile(text);
}

test("cap mode keeps the gentle default edit cap", () => {
  const ctx = context({ config: { ...context().config, maxEditsPerRun: null } });
  assert.equal(effectiveMaxEdits(ctx.memoryFile, ctx.config), DEFAULT_MAX_EDITS);
});

test("shrink mode scales the edit cap to the overage, up to the ceiling", () => {
  const config = { ...context().config, budgetTokens: 200, maxEditsPerRun: null };
  const modest = overBudgetFile(400, 200);
  const modestCap = effectiveMaxEdits(modest, config);
  assert.ok(modestCap > DEFAULT_MAX_EDITS, `a 400-token overage should allow more than ${DEFAULT_MAX_EDITS} edits`);
  assert.ok(modestCap < SHRINK_MAX_EDITS, "a modest overage should not hit the ceiling");
  assert.equal(modestCap, Math.ceil((modest.tokens - 200) / SHRINK_EDIT_TOKENS));

  const large = overBudgetFile(5000, 200);
  assert.equal(effectiveMaxEdits(large, config), SHRINK_MAX_EDITS);
});

test("an explicit maxEditsPerRun wins over the adaptive cap in both modes", () => {
  const config = { ...context().config, budgetTokens: 200, maxEditsPerRun: 3 };
  assert.equal(effectiveMaxEdits(overBudgetFile(5000, 200), config), 3);
  assert.equal(effectiveMaxEdits(memoryFile(), config), 3);
});

test("the cap-exceeded violation fires above the effective adaptive cap, not the flat default", () => {
  const file = overBudgetFile(400, 200);
  const config = { ...context().config, budgetTokens: 200, maxEditsPerRun: null };
  const cap = effectiveMaxEdits(file, config);
  assert.ok(cap > DEFAULT_MAX_EDITS);

  const within = buildProposal({ edits: rawEdits(cap) }, context({ memoryFile: file, config }));
  assert.ok(!within.violations.some((v) => v.includes("per-run cap")), within.violations.join("\n"));
  assert.equal(within.proposal.config.maxEditsPerRun, cap, "the proposal records the effective cap");

  const above = buildProposal({ edits: rawEdits(cap + 1) }, context({ memoryFile: file, config }));
  assert.ok(
    above.violations.some((v) => v.includes(`per-run cap is ${cap}`)),
    above.violations.join("\n"),
  );
});
