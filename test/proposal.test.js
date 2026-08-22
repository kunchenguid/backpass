import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
import { estimateTokens } from "../src/tokens.js";
import { isSuppressedByRejection, recordRejection } from "../src/state.js";
import { applyDecisions } from "../src/apply/writer.js";
import { injectPayload, parseDecisions } from "../src/apply/lavish.js";
import { extractJson, parseTokenLine, stripAcpxNoise } from "../src/acpx.js";
import { makeRepo, stageAndMeasure, writeIn } from "./helpers/staging.js";

const MEMORY_TEXT = [
  "# Demo agent instructions",
  "",
  "## Rules",
  "",
  "- Whenever a PR is mentioned, include its URL.",
  "- Prefer small commits.",
  "- Use Node 18 via nvm before running any script.",
  "",
].join("\n");

const QUOTE = [{ polarity: "negative", text: "it used a bare #2731 reference", source: "claude · abc · turn 3" }];

function config(overrides = {}) {
  return {
    budgetTokens: 5000,
    maxEditsPerRun: 5,
    minGapEvidence: 2,
    skillsDir: ".agents/skills",
    analysis: { agent: "codex" },
    synthesis: { agent: "claude" },
    ...overrides,
  };
}

/**
 * Stage `text`, let `edit` change the staging copy, and run the gate over `annotation`
 * (the model's answer to the annotate turn). Returns everything a test may inspect.
 */
function gate({ text = MEMORY_TEXT, files = {}, edit, annotation, config: cfg = config(), context = {} }) {
  const repo = makeRepo({ "AGENTS.md": text, ...files });
  const staged = stageAndMeasure({ repo, skillsDir: cfg.skillsDir, edit });
  const summary = { analyzedSessions: 4, totals: { positive: 3, negative: 2, gapClusters: 1 } };
  const result = buildProposal(annotation, {
    memoryFile: staged.memoryFile,
    config: cfg,
    repo,
    summary,
    measured: staged.measured,
    ...context,
  });
  return { ...result, ...staged, repo };
}

const memoryEdit = (fn) => (root) => writeIn(root, "AGENTS.md", fn);
const claim = (changes, extra = {}) => ({
  changes,
  kind: "rewrite",
  title: "t",
  evidence: QUOTE,
  transcripts: 3,
  ...extra,
});

// ---------- the mechanical applier ----------

test("a legacy rewrite edit replaces exactly the text it names", () => {
  const next = applyEdit(MEMORY_TEXT, {
    id: "e1",
    file: "AGENTS.md",
    find: "- Whenever a PR is mentioned, include its URL.",
    replace: "- Whenever a PR is mentioned, include its full https:// URL.",
  });
  assert.ok(next.includes("full https:// URL"));
  assert.ok(!next.includes("include its URL."));
});

test("a legacy add edit inserts after its anchor, and appends when there is none", () => {
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

  // Overlapping occurrences count too: a run of identical lines is not unique.
  assert.throws(
    () => applyEdit("- a\n- a\n- a\n", { id: "e1", file: "AGENTS.md", find: "- a\n- a\n", replace: "" }),
    /appears 2 times/,
  );
});

test("a measured edit applies each of its hunks, and refuses once the file has drifted", () => {
  const { proposal, violations } = gate({
    edit: memoryEdit((t) => t.replace("include its URL.", "include its full URL.").replace("Node 18", "Node 22")),
    annotation: { edits: [claim(["H1", "H2"], { title: "both" })] },
  });
  assert.deepEqual(violations, []);
  assert.equal(proposal.edits[0].hunks.length, 2);
  const applied = applyEdit(MEMORY_TEXT, proposal.edits[0]);
  assert.ok(applied.includes("full URL") && applied.includes("Node 22"));

  const drifted = MEMORY_TEXT.replace("Node 18", "Node 20");
  assert.throws(() => applyEdit(drifted, proposal.edits[0]), /\(H2\): "find" text does not appear/);
});

// ---------- the skew that motivated native editing ----------

test("an edit spanning several single-newline list items lands: find is measured from the raw file", () => {
  // The report's failing shape: adjacent list items the instruction index shows with a
  // blank line between them. The agent edits the raw copy; nothing is copied by hand.
  const text = [
    "# Memory",
    "",
    "## Sharp edges",
    "",
    "- Transcript formats drift; adapters are pinned by golden fixtures.",
    "- The live progress view is an enhancement layer, never a dependency.",
    "- Only src/apply/writer.js writes to the repo.",
    "- Skills only count if a harness loads them.",
    "",
    "## Other",
    "",
    "- Keep this file short.",
    "",
  ].join("\n");
  const { proposal, violations, measured, memoryFile, repo } = gate({
    text,
    edit: memoryEdit((t) =>
      t
        .replace(
          "- Transcript formats drift; adapters are pinned by golden fixtures.\n- The live progress view is an enhancement layer, never a dependency.\n",
          "",
        )
        .replace("- Keep this file short.", "- Keep this file short; point at files instead of copying them."),
    ),
    annotation: {
      edits: [
        { ...claim(["H1"]), kind: "remove", title: "drop two dead sharp edges" },
        { ...claim(["H2"]), kind: "rewrite", title: "sharpen the brevity rule" },
      ],
    },
  });

  assert.deepEqual(violations, []);
  assert.equal(measured.changes.length, 2);
  for (const edit of proposal.edits) {
    for (const hunk of edit.hunks) {
      assert.equal(text.split(hunk.find).length, 2, `${hunk.id} find text occurs exactly once in the raw file`);
      assert.ok(!hunk.find.includes("[AG-"), "no index headers leak into the find text");
    }
  }
  const applied = applyEdit(memoryFile.text, proposal.edits[0]);
  const both = applyEdit(applied, proposal.edits[1]);
  assert.equal(both, fs.readFileSync(path.join(repo.root, ".backpass", "synthesis", "AGENTS.md"), "utf8"));
  assert.ok(proposal.edits[0].deltaTokens < 0);
});

// ---------- evidence gates ----------

test("the per-run edit cap is enforced - it is the learning rate", () => {
  const lines = Array.from({ length: 6 }, (_, i) => `- Rule number ${i}.`);
  const text = `# T\n\n${lines.join("\n")}\n`;
  const { violations } = gate({
    text,
    edit: memoryEdit((t) => lines.reduce((acc, line, i) => acc.replace(line, `- Rule ${i} rewritten.`), t)),
    annotation: { edits: Array.from({ length: 6 }, (_, i) => claim([`H${i + 1}`], { title: `edit ${i}` })) },
  });
  assert.ok(violations.some((v) => /per-run cap is 5/.test(v)));
});

test("a new instruction backed by too few sessions is rejected, whatever kind the model declares", () => {
  const insert = memoryEdit((t) => t.replace("## Rules\n\n", "## Rules\n\n- Speculative rule.\n"));
  for (const kind of ["add", "rewrite"]) {
    const { proposal, violations } = gate({
      edit: insert,
      annotation: { edits: [claim(["H1"], { kind, title: "new rule from one session", transcripts: 1 })] },
    });
    assert.equal(proposal.edits.length, 0, `${kind}: measured as an addition`);
    assert.ok(violations.some((v) => /backed by 1 session/.test(v)));
  }
});

test("an edit with no verbatim quote is rejected", () => {
  const { proposal, violations } = gate({
    edit: memoryEdit((t) => t.replace("- Use Node 18 via nvm before running any script.\n", "")),
    annotation: { edits: [claim(["H1"], { kind: "remove", title: "unsupported", evidence: [] })] },
  });
  assert.equal(proposal.edits.length, 0);
  assert.ok(violations.some((v) => /no verbatim evidence quote/.test(v)));
});

test("every measured change must be claimed by exactly one edit", () => {
  const twoChanges = memoryEdit((t) =>
    t.replace("include its URL.", "include its full URL.").replace("Node 18", "Node 22"),
  );

  const unclaimed = gate({ edit: twoChanges, annotation: { edits: [claim(["H1"])] } });
  assert.ok(unclaimed.violations.some((v) => /H2: AGENTS\.md line 7 \(-1\/\+1\) is not part of any edit/.test(v)));

  const doubled = gate({ edit: twoChanges, annotation: { edits: [claim(["H1", "H2"]), claim(["H2"])] } });
  assert.ok(doubled.violations.some((v) => /H2 is claimed by both edit e1 and edit e2/.test(v)));

  const phantom = gate({ edit: twoChanges, annotation: { edits: [claim(["H1", "H2", "H9"])] } });
  assert.ok(phantom.violations.some((v) => /H9, which is not a measured change/.test(v)));

  const nothing = gate({ edit: () => {}, annotation: { edits: [] } });
  assert.deepEqual(nothing.violations, []);
  assert.equal(nothing.proposal.edits.length, 0);
});

test("token deltas and the projected budget are measured by backpass, not taken from the model", () => {
  const { proposal, violations } = gate({
    edit: memoryEdit((t) => t.replace("- Use Node 18 via nvm before running any script.\n", "")),
    annotation: { edits: [claim(["H1"], { kind: "remove", title: "drop the stale Node pin", deltaTokens: 9999 })] },
  });

  assert.deepEqual(violations, []);
  assert.equal(proposal.edits.length, 1);
  assert.ok(proposal.edits[0].deltaTokens < 0, "a removal must reduce the always-loaded cost");
  assert.notEqual(proposal.edits[0].deltaTokens, 9999);
  assert.equal(proposal.budget.projected, proposal.budget.current + proposal.edits[0].deltaTokens);
  assert.equal(
    proposal.budget.projected,
    estimateTokens(MEMORY_TEXT.replace("- Use Node 18 via nvm before running any script.\n", "")),
  );
});

test("a proposal that would exceed the budget fails the gate", () => {
  const big = "x".repeat(4800); // ~1,200 tok, over a tiny cap
  const { violations } = gate({
    edit: memoryEdit((t) => t.replace("## Rules\n\n", `## Rules\n\n${big}\n`)),
    annotation: { edits: [claim(["H1"], { kind: "add", title: "bloat" })] },
    config: config({ budgetTokens: 100 }),
  });
  assert.ok(violations.some((v) => /over the 100-token budget/.test(v)));
});

test("an extract is one created SKILL.md grouped with the memory change that pays for it", () => {
  const skillText =
    "---\nname: release-signing\ndescription: Load before tagging a release.\n---\n\n## Steps\n\n1. sign\n";
  const extractEdit = (root) => {
    writeIn(root, "AGENTS.md", (t) =>
      t.replace("- Use Node 18 via nvm before running any script.", "- See the release-signing skill."),
    );
    writeIn(root, ".agents/skills/release-signing/SKILL.md", skillText);
  };

  const good = gate({
    edit: extractEdit,
    annotation: { edits: [claim(["H1", "H2"], { kind: "extract", title: "x" })] },
  });
  assert.deepEqual(good.violations, []);
  assert.equal(good.proposal.edits[0].skill.path, ".agents/skills/release-signing/SKILL.md");
  assert.equal(good.proposal.edits[0].skill.name, "release-signing");
  assert.equal(good.proposal.edits[0].skill.body, "## Steps\n\n1. sign");
  assert.equal(good.proposal.stats.skillExtractions, 1);

  const split = gate({
    edit: extractEdit,
    annotation: { edits: [claim(["H1"], { kind: "extract", title: "x" }), claim(["H2"], { kind: "add", title: "y" })] },
  });
  assert.ok(split.violations.some((v) => /kind "extract" must group exactly one created SKILL\.md/.test(v)));
  assert.ok(split.violations.some((v) => /only kind "extract" may include a created file \(H2\)/.test(v)));

  const headless = gate({
    edit: (root) => {
      extractEdit(root);
      writeIn(root, ".agents/skills/release-signing/SKILL.md", "no frontmatter here\n");
    },
    annotation: { edits: [claim(["H1", "H2"], { kind: "extract", title: "x" })] },
  });
  assert.ok(headless.violations.some((v) => /needs YAML frontmatter/.test(v)));
});

test("a skill's description can be rewritten in place; deletions and stray files are refused or ignored", () => {
  const skill = "---\nname: db\ndescription: old trigger\n---\n\nbody\n";
  const rewritten = gate({
    files: { ".agents/skills/db/SKILL.md": skill },
    edit: (root) =>
      writeIn(root, ".agents/skills/db/SKILL.md", (t) =>
        t.replace("old trigger", "Load before touching the database."),
      ),
    annotation: { edits: [claim(["H1"], { title: "fix the trigger" })] },
  });
  assert.deepEqual(rewritten.violations, []);
  assert.equal(rewritten.proposal.edits[0].file, ".agents/skills/db/SKILL.md");
  assert.equal(rewritten.proposal.edits[0].targetsMemoryFile, false);
  assert.equal(rewritten.proposal.budget.delta, 0, "skill files are not always-loaded");

  const deleted = gate({
    files: { ".agents/skills/db/SKILL.md": skill },
    edit: (root) => fs.rmSync(path.join(root, ".agents/skills/db"), { recursive: true }),
    annotation: { edits: [claim(["H1"], { kind: "remove", title: "drop the skill" })] },
  });
  assert.ok(
    deleted.violations.some((v) =>
      /H1: deletes \.agents\/skills\/db\/SKILL\.md; backpass cannot propose deletions/.test(v),
    ),
  );

  const stray = gate({
    edit: (root) => {
      writeIn(root, "notes.md", "scratch");
      writeIn(root, "AGENTS.md", (t) => t.replace("Node 18", "Node 22"));
    },
    annotation: { edits: [claim(["H1"])] },
  });
  assert.deepEqual(stray.violations, []);
  assert.ok(stray.proposal.notes.some((n) => /ignored notes\.md/.test(n)));
});

test("a previously rejected edit is suppressed until new evidence arrives", () => {
  const edit = memoryEdit((t) => t.replace("- Use Node 18 via nvm before running any script.\n", ""));
  const first = gate({
    edit,
    annotation: { edits: [claim(["H1"], { kind: "remove", title: "drop the stale Node pin" })] },
  });
  const rejections = recordRejection(first.proposal.edits[0], { version: 1, entries: {} });

  const suppressed = gate({
    edit,
    annotation: { edits: [claim(["H1"], { kind: "remove", title: "drop the stale Node pin" })] },
    context: { rejections, isSuppressed: isSuppressedByRejection },
  });
  assert.equal(suppressed.proposal.edits.length, 0, "same evidence weight stays rejected");
  assert.deepEqual(suppressed.violations, [], "a suppressed edit is dropped, not a violation");

  const revived = gate({
    edit,
    annotation: { edits: [claim(["H1"], { kind: "remove", title: "drop the stale Node pin", transcripts: 9 })] },
    context: { rejections, isSuppressed: isSuppressedByRejection },
  });
  assert.equal(revived.proposal.edits.length, 1, "materially new evidence revives the edit");
});

test("projectWithDecisions tracks the budget for the subset the human accepted", () => {
  const { proposal } = gate({
    edit: memoryEdit((t) =>
      t
        .replace("- Use Node 18 via nvm before running any script.\n", "")
        .replace("include its URL.", "include its full https:// URL before any shorthand."),
    ),
    annotation: { edits: [claim(["H2"], { kind: "remove", title: "a" }), claim(["H1"], { title: "b" })] },
  });

  const none = projectWithDecisions(MEMORY_TEXT, proposal.edits, [], 5000);
  assert.equal(none.budget.delta, 0);

  const both = projectWithDecisions(MEMORY_TEXT, proposal.edits, ["e1", "e2"], 5000);
  assert.equal(both.budget.projected, proposal.budget.projected);

  const onlyFirst = projectWithDecisions(MEMORY_TEXT, proposal.edits, ["e1"], 5000);
  assert.ok(onlyFirst.budget.delta < 0);
  assert.ok(!onlyFirst.text.includes("Node 18"));
  assert.ok(onlyFirst.text.includes("include its URL."), "the unaccepted edit is not applied");
});

// ---------- the human gate ----------

test("applying decisions writes accepted edits, skips rejected ones, and remembers rejections", () => {
  const { proposal, repo, state } = gate({
    edit: memoryEdit((t) =>
      t
        .replace("- Use Node 18 via nvm before running any script.\n", "")
        .replace("- Whenever a PR is mentioned, include its URL.", "- Always include the full PR URL."),
    ),
    annotation: {
      edits: [claim(["H2"], { kind: "remove", title: "drop node pin" }), claim(["H1"], { title: "pr url" })],
    },
  });
  assert.equal(
    fs.readFileSync(path.join(repo.root, "AGENTS.md"), "utf8"),
    MEMORY_TEXT,
    "synthesis never writes the repo",
  );

  const results = applyDecisions({
    proposal,
    decisions: { e1: "accepted", e2: "rejected" },
    repo,
    state,
    config: { budgetTokens: 5000 },
  });

  const written = fs.readFileSync(path.join(repo.root, "AGENTS.md"), "utf8");
  assert.ok(!written.includes("Node 18"), "the accepted removal is applied");
  assert.ok(written.includes("include its URL."), "the rejected rewrite is not applied");
  assert.equal(results.accepted, 1);
  assert.equal(results.rejected, 1);
  assert.equal(results.failed.length, 0);
  assert.ok(results.written[0].budget.delta < 0);

  const remembered = state.readRejections();
  assert.equal(Object.keys(remembered.entries).length, 1);
});

test("an accepted extract writes the skill the agent drafted, in the canonical layout", () => {
  const skillText =
    "---\nname: release-signing\ndescription: Load before tagging a release.\n---\n\n## Steps\n\n1. sign\n";
  const { proposal, repo, state } = gate({
    edit: (root) => {
      writeIn(root, "AGENTS.md", (t) =>
        t.replace("- Use Node 18 via nvm before running any script.", "- See the release-signing skill."),
      );
      writeIn(root, ".agents/skills/release-signing/SKILL.md", skillText);
    },
    annotation: { edits: [claim(["H1", "H2"], { kind: "extract", title: "x" })] },
  });
  const results = applyDecisions({
    proposal,
    decisions: { e1: "accepted" },
    repo,
    state,
    config: { budgetTokens: 5000 },
  });
  assert.equal(results.failed.length, 0);
  const written = fs.readFileSync(path.join(repo.root, ".agents/skills/release-signing/SKILL.md"), "utf8");
  assert.match(
    written,
    /^---\nname: release-signing\ndescription: Load before tagging a release\.\nuser-invocable: false/,
  );
  assert.ok(written.endsWith("## Steps\n\n1. sign\n"));
  assert.ok(fs.readFileSync(path.join(repo.root, "AGENTS.md"), "utf8").includes("See the release-signing skill."));
});

test("a dry run reports what it would write without touching the file", () => {
  const { proposal, repo, state } = gate({
    edit: memoryEdit((t) => t.replace("- Use Node 18 via nvm before running any script.\n", "")),
    annotation: { edits: [claim(["H1"], { kind: "remove", title: "drop node pin" })] },
  });

  const results = applyDecisions({
    proposal,
    decisions: { e1: "accepted" },
    repo,
    state,
    config: { budgetTokens: 5000 },
    dryRun: true,
  });

  assert.equal(results.written.length, 1);
  assert.equal(fs.readFileSync(path.join(repo.root, "AGENTS.md"), "utf8"), MEMORY_TEXT, "dry run must not write");
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

// ---------- the budget gate's two modes ----------

const OVER_BUDGET = `${MEMORY_TEXT}\n${"padding text. ".repeat(2000)}`; // ~7,500 tok against a 5,000 cap

test('an over-budget file switches the gate from "fit the cap" to "make progress"', () => {
  const shrinking = gate({
    text: OVER_BUDGET,
    edit: memoryEdit((t) => t.replace("- Use Node 18 via nvm before running any script.\n", "")),
    annotation: { edits: [claim(["H1"], { kind: "remove", title: "drop the stale Node pin" })] },
  });

  assert.deepEqual(shrinking.violations, [], "a net-negative step passes even though the cap is not reached");
  assert.equal(shrinking.proposal.budget.mode, "shrink");
  assert.equal(shrinking.proposal.budget.startedOverBudget, true);
  assert.ok(shrinking.proposal.budget.over > 0, "it reports how far over it still is");
  assert.ok(shrinking.proposal.budget.delta < 0);
});

test("an over-budget file still refuses an edit set that grows it", () => {
  const { violations } = gate({
    text: OVER_BUDGET,
    edit: memoryEdit((t) => t.replace("## Rules\n\n", "## Rules\n\n- Yet another rule.\n")),
    annotation: { edits: [claim(["H1"], { kind: "add", title: "more rules on an already bloated file" })] },
  });
  assert.ok(violations.some((v) => /must shrink it, but the proposed edits change it by \+/.test(v)));
});

test("a file within budget keeps the fit-the-cap gate", () => {
  const { proposal, violations } = gate({
    edit: memoryEdit((t) => t.replace("## Rules\n\n", "## Rules\n\n- A small new rule.\n")),
    annotation: { edits: [claim(["H1"], { kind: "add", title: "small" })] },
  });
  assert.deepEqual(violations, []);
  assert.equal(proposal.budget.mode, "cap");
  assert.equal(proposal.budget.startedOverBudget, false);
});

test("the edit cap scales with the overage in shrink mode and stays at the default otherwise", () => {
  const base = { budgetTokens: 5000, maxEditsPerRun: null };
  const tokens = (t) => ({ tokens: t });
  assert.equal(effectiveMaxEdits(tokens(4000), base), DEFAULT_MAX_EDITS);
  assert.equal(effectiveMaxEdits(tokens(5000), base), DEFAULT_MAX_EDITS);
  assert.equal(
    effectiveMaxEdits(tokens(5000 + SHRINK_EDIT_TOKENS * 2), base),
    DEFAULT_MAX_EDITS,
    "tiny overage keeps the floor",
  );
  assert.equal(effectiveMaxEdits(tokens(5000 + SHRINK_EDIT_TOKENS * 12), base), 12);
  assert.equal(effectiveMaxEdits(tokens(5000 + SHRINK_EDIT_TOKENS * 12 - 1), base), 12, "partial steps round up");
  assert.equal(effectiveMaxEdits(tokens(19259), base), SHRINK_MAX_EDITS, "a 4x-over file hits the ceiling");
  assert.equal(effectiveMaxEdits(tokens(19259), { ...base, maxEditsPerRun: 3 }), 3, "an explicit cap always wins");
});

test("the cap-exceeded violation fires above the effective adaptive cap, not the flat default", () => {
  const cfg = config({ budgetTokens: 200, maxEditsPerRun: null });
  const rules = [];
  let text = "";
  while (estimateTokens(text) < 200 + 400) {
    rules.push(`- rule ${rules.length + 1} keeps the file long enough to sit over the budget line`);
    text = `# Long memory\n\n${rules.join("\n")}\n`;
  }
  const cap = effectiveMaxEdits({ tokens: estimateTokens(text) }, cfg);
  assert.ok(cap > DEFAULT_MAX_EDITS);

  // Every other rule goes, so each removal is its own measured change.
  const removeEveryOther = (count) =>
    memoryEdit((t) => {
      let out = t;
      for (let i = 0; i < count; i += 1) out = out.replace(`${rules[i * 2]}\n`, "");
      return out;
    });
  const annotate = (count) => ({
    edits: Array.from({ length: count }, (_, i) =>
      claim([`H${i + 1}`], { kind: "remove", title: `remove rule ${i * 2 + 1}` }),
    ),
  });

  const within = gate({ text, edit: removeEveryOther(cap), annotation: annotate(cap), config: cfg });
  assert.equal(within.measured.changes.length, cap);
  assert.ok(!within.violations.some((v) => v.includes("per-run cap")), within.violations.join("\n"));
  assert.equal(within.proposal.config.maxEditsPerRun, cap, "the proposal records the effective cap");

  const above = gate({ text, edit: removeEveryOther(cap + 1), annotation: annotate(cap + 1), config: cfg });
  assert.ok(
    above.violations.some((v) => v.includes(`per-run cap is ${cap}`)),
    above.violations.join("\n"),
  );
});
