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
import { isSuppressedByRejection, recordRejection, State } from "../src/state.js";
import { applyDecisions } from "../src/apply/writer.js";
import { injectPayload, parseDecisions, renderApplySurface } from "../src/apply/lavish.js";
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
  // Default: every unit carries harm-class corroboration, so removal fixtures whose
  // subject is not the removal-evidence floor sail through it. Floor tests pass their
  // own summary through `context`.
  const summary = {
    analyzedSessions: 4,
    totals: { positive: 3, negative: 2, gapClusters: 1 },
    instructions: Array.from({ length: 20 }, (_, i) => ({
      instruction: `AG-${String(i + 1).padStart(3, "0")}`,
      positive: 0,
      negative: 4,
      harmSessions: 4,
      sessions: 4,
      relevance: 1,
      quotes: [],
    })),
  };
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

// An extraction must carry every line it removes; `carried` is that line (or lines).
const skillFile = (name, carried = "") =>
  `---\nname: ${name}\ndescription: Load before ${name}.\n---\n\n## Steps\n\n1. do it\n${carried}`;

test("an extract is the created SKILL.md file(s) grouped with the memory change that pays for them", () => {
  const extractEdit = (root) => {
    writeIn(root, "AGENTS.md", (t) =>
      t.replace("- Use Node 18 via nvm before running any script.", "- See the release-signing skill."),
    );
    writeIn(
      root,
      ".agents/skills/release-signing/SKILL.md",
      skillFile("release-signing", "- Use Node 18 via nvm before running any script.\n"),
    );
  };

  const good = gate({
    edit: extractEdit,
    annotation: { edits: [claim(["H1", "H2"], { kind: "extract", title: "x" })] },
  });
  assert.deepEqual(good.violations, []);
  assert.deepEqual(
    good.proposal.edits[0].skills.map((s) => [s.path, s.name, s.body]),
    [
      [
        ".agents/skills/release-signing/SKILL.md",
        "release-signing",
        "## Steps\n\n1. do it\n- Use Node 18 via nvm before running any script.",
      ],
    ],
  );
  assert.equal(good.proposal.stats.skillExtractions, 1);

  const split = gate({
    edit: extractEdit,
    annotation: { edits: [claim(["H1"], { kind: "extract", title: "x" }), claim(["H2"], { kind: "add", title: "y" })] },
  });
  assert.ok(split.violations.some((v) => /kind "extract" must group created SKILL\.md file\(s\)/.test(v)));
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

test("skills whose removals were measured as one change may share an extract; separately measured ones may not", () => {
  // Two neighbouring rules leave together, so the measurement merges their removal into a
  // single hunk. Their two skills then cannot be accepted apart from each other.
  const coalesced = gate({
    edit: (root) => {
      writeIn(root, "AGENTS.md", (t) =>
        t.replace(
          "- Prefer small commits.\n- Use Node 18 via nvm before running any script.\n",
          "- See the commit-style and node-setup skills.\n",
        ),
      );
      writeIn(root, ".agents/skills/commit-style/SKILL.md", skillFile("commit-style", "- Prefer small commits.\n"));
      writeIn(
        root,
        ".agents/skills/node-setup/SKILL.md",
        skillFile("node-setup", "- Use Node 18 via nvm before running any script.\n"),
      );
    },
    annotation: { edits: [claim(["H1", "H2", "H3"], { kind: "extract", title: "extract two playbooks" })] },
  });
  assert.deepEqual(coalesced.violations, [], "one measured change plus two skills is one honest decision");
  assert.equal(coalesced.proposal.edits.length, 1);
  assert.deepEqual(coalesced.proposal.edits[0].skills.map((s) => s.name).sort(), ["commit-style", "node-setup"]);
  assert.equal(coalesced.proposal.edits[0].hunks.length, 1);
  assert.equal(coalesced.proposal.stats.skillExtractions, 2, "the stat counts skills, not cards");

  // Two rules with an untouched line between them stay two measured changes, so they stay
  // two decisions: bundling them would take away the reviewer's ability to split them.
  const separate = gate({
    edit: (root) => {
      writeIn(root, "AGENTS.md", (t) =>
        t
          .replace("- Whenever a PR is mentioned, include its URL.", "- See the url-policy skill.")
          .replace("- Use Node 18 via nvm before running any script.", "- See the node-setup skill."),
      );
      writeIn(
        root,
        ".agents/skills/url-policy/SKILL.md",
        skillFile("url-policy", "- Whenever a PR is mentioned, include its URL.\n"),
      );
      writeIn(
        root,
        ".agents/skills/node-setup/SKILL.md",
        skillFile("node-setup", "- Use Node 18 via nvm before running any script.\n"),
      );
    },
    annotation: { edits: [claim(["H1", "H2", "H3", "H4"], { kind: "extract", title: "extract both" })] },
  });
  assert.ok(
    separate.violations.some((v) => /groups 2 created skills against 2 separate changes/.test(v)),
    `expected a split demand, got ${JSON.stringify(separate.violations)}`,
  );
  assert.ok(separate.violations.some((v) => /give each skill its own extract/.test(v)));
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
  assert.equal(results.rejectionsRecorded, true);
  assert.equal(results.failed.length, 0);
  assert.ok(results.written[0].budget.delta < 0);

  const remembered = state.readRejections();
  assert.equal(Object.keys(remembered.entries).length, 1);
});

test("apply refuses an accepted subset that exceeds the memory cap before writing any file", () => {
  const skill = "---\nname: db\ndescription: old trigger\n---\n\nbody\n";
  const cap = estimateTokens(MEMORY_TEXT);
  const { proposal, violations, repo, state } = gate({
    files: { ".agents/skills/db/SKILL.md": skill },
    edit: (root) => {
      writeIn(root, "AGENTS.md", (text) =>
        text
          .replace("- Use Node 18 via nvm before running any script.\n", "")
          .replace("include its URL.", "include its full https:// URL."),
      );
      writeIn(root, ".agents/skills/db/SKILL.md", (text) =>
        text.replace("old trigger", "Load before touching the database."),
      );
    },
    annotation: {
      edits: [
        claim(["H2"], { kind: "remove", title: "drop node pin" }),
        claim(["H1"], { title: "expand URL rule" }),
        claim(["H3"], { title: "fix skill trigger" }),
      ],
    },
    config: config({ budgetTokens: cap }),
  });
  assert.deepEqual(violations, [], "the complete proposal is valid because the removal pays for the addition");

  const results = applyDecisions({
    proposal,
    decisions: { e1: "rejected", e2: "accepted", e3: "accepted" },
    repo,
    state,
    config: { budgetTokens: cap },
  });

  assert.match(results.failed[0].error, /accepted edits leave AGENTS\.md .* over the .* budget/);
  assert.equal(results.rejectionsRecorded, false);
  assert.deepEqual(results.written, []);
  assert.deepEqual(results.skills, []);
  assert.equal(fs.readFileSync(path.join(repo.root, "AGENTS.md"), "utf8"), MEMORY_TEXT);
  assert.equal(fs.readFileSync(path.join(repo.root, ".agents/skills/db/SKILL.md"), "utf8"), skill);
  assert.equal(Object.keys(state.readRejections().entries).length, 0, "the reviewer can retry with a valid subset");
});

test("apply refuses a non-shrinking accepted subset when memory already exceeds the cap", () => {
  const cap = estimateTokens(MEMORY_TEXT) - 1;
  const { proposal, violations, repo, state } = gate({
    edit: memoryEdit((text) =>
      text
        .replace("- Use Node 18 via nvm before running any script.\n", "")
        .replace("include its URL.", "include its full https:// URL."),
    ),
    annotation: {
      edits: [claim(["H2"], { kind: "remove", title: "drop node pin" }), claim(["H1"], { title: "expand URL rule" })],
    },
    config: config({ budgetTokens: cap }),
  });
  assert.deepEqual(violations, [], "the complete proposal is a valid shrink step");

  const results = applyDecisions({
    proposal,
    decisions: { e1: "rejected", e2: "accepted" },
    repo,
    state,
    config: { budgetTokens: cap },
  });

  assert.match(results.failed[0].error, /accepted edits must shrink it, but they change it by \+/);
  assert.equal(results.rejectionsRecorded, false);
  assert.deepEqual(results.written, []);
  assert.equal(fs.readFileSync(path.join(repo.root, "AGENTS.md"), "utf8"), MEMORY_TEXT);
  assert.equal(Object.keys(state.readRejections().entries).length, 0, "the reviewer can retry with a valid subset");
});

test("rejecting every edit remains valid when memory already exceeds the cap", () => {
  const cap = estimateTokens(MEMORY_TEXT) - 1;
  const { proposal, violations, repo, state } = gate({
    edit: memoryEdit((text) => text.replace("- Use Node 18 via nvm before running any script.\n", "")),
    annotation: { edits: [claim(["H1"], { kind: "remove", title: "drop node pin" })] },
    config: config({ budgetTokens: cap }),
  });
  assert.deepEqual(violations, []);

  const results = applyDecisions({
    proposal,
    decisions: { e1: "rejected" },
    repo,
    state,
    config: { budgetTokens: cap },
  });

  assert.deepEqual(results.failed, []);
  assert.deepEqual(results.written, []);
  assert.equal(results.rejectionsRecorded, true);
  assert.equal(Object.keys(state.readRejections().entries).length, 1);
});

test("one inapplicable accepted edit leaves the whole file unwritten", () => {
  const { proposal, repo, state } = gate({
    edit: memoryEdit((t) => t.replace("- Use Node 18 via nvm before running any script.\n", "")),
    annotation: { edits: [claim(["H1"], { kind: "remove", title: "drop node pin" })] },
  });
  const stale = structuredClone(proposal.edits[0]);
  stale.id = "e-stale";
  stale.hunks[0].find = "text that is not in the file at all";
  stale.hunks[0].replace = "x";
  proposal.edits.push(stale);

  const results = applyDecisions({
    proposal,
    decisions: { e1: "accepted", "e-stale": "accepted" },
    repo,
    state,
    config: { budgetTokens: 5000 },
  });

  assert.deepEqual(results.written, [], "a file takes every accepted edit or none of them");
  assert.equal(
    fs.readFileSync(path.join(repo.root, "AGENTS.md"), "utf8"),
    MEMORY_TEXT,
    "the applicable edit is not written either",
  );
  assert.ok(
    results.failed.some((f) => f.edit === "e-stale" && /does not appear/.test(f.error)),
    "the edit that could not apply is named",
  );
  assert.ok(
    results.failed.some((f) => !f.edit && /left unchanged/.test(f.error)),
    "and so is the consequence for the file",
  );
});

test("a stale edit in another file aborts the whole accepted run", () => {
  const skill = "---\nname: db\ndescription: old trigger\n---\n\nbody\n";
  const { proposal, repo, state } = gate({
    files: { ".agents/skills/db/SKILL.md": skill },
    edit: (root) => {
      writeIn(root, "AGENTS.md", (text) =>
        text
          .replace("- Use Node 18 via nvm before running any script.\n", "")
          .replace("include its URL.", "include its full https:// URL."),
      );
      writeIn(root, ".agents/skills/db/SKILL.md", (text) =>
        text.replace("old trigger", "Load before touching the database."),
      );
    },
    annotation: {
      edits: [
        claim(["H2"], { kind: "remove", title: "drop node pin" }),
        claim(["H1"], { title: "expand URL rule" }),
        claim(["H3"], { title: "fix skill trigger" }),
      ],
    },
  });
  proposal.edits[2].hunks[0].find = "stale skill text";

  const results = applyDecisions({
    proposal,
    decisions: { e1: "accepted", e2: "rejected", e3: "accepted" },
    repo,
    state,
    config: { budgetTokens: 5000 },
  });

  assert.deepEqual(results.written, []);
  assert.equal(fs.readFileSync(path.join(repo.root, "AGENTS.md"), "utf8"), MEMORY_TEXT);
  assert.equal(fs.readFileSync(path.join(repo.root, ".agents/skills/db/SKILL.md"), "utf8"), skill);
  assert.equal(results.rejectionsRecorded, false);
  assert.equal(Object.keys(state.readRejections().entries).length, 0);
  assert.ok(results.failed.some((failure) => failure.edit === "e3" && /does not appear/.test(failure.error)));
});

test("apply refuses every edit once the memory file changed under the proposal", () => {
  const { proposal, repo, state } = gate({
    edit: memoryEdit((t) => t.replace("- Prefer small commits.", "- Prefer small, reviewable commits.")),
    annotation: { edits: [claim(["H1"], { title: "sharpen the commit rule" })] },
  });

  // The drift is somewhere else in the file, so the hunk itself would still apply.
  const memory = path.join(repo.root, "AGENTS.md");
  const drifted = MEMORY_TEXT.replace("## Rules\n", "## Rules\n\n- Run the linter before pushing.\n");
  fs.writeFileSync(memory, drifted);
  assert.doesNotThrow(() => applyEdit(drifted, proposal.edits[0]), "the edit still composes; only the file moved");

  const results = applyDecisions({
    proposal,
    decisions: { e1: "accepted" },
    repo,
    state,
    config: { budgetTokens: 5000 },
  });

  assert.deepEqual(results.written, []);
  assert.equal(fs.readFileSync(memory, "utf8"), drifted, "the drifted file is left exactly as found");
  assert.equal(results.failed.length, 1);
  assert.match(results.failed[0].error, /changed after this proposal was made/);
  assert.match(results.failed[0].error, new RegExp(proposal.memoryFile.hash), "names the image it was measured on");
  assert.match(results.failed[0].error, /Run `backpass`/, "names the command that re-measures");
});

test("memory drift also refuses an all-rejected decision without recording it", () => {
  const { proposal, repo, state } = gate({
    edit: memoryEdit((text) => text.replace("- Prefer small commits.", "- Prefer small, reviewable commits.")),
    annotation: { edits: [claim(["H1"], { title: "sharpen the commit rule" })] },
  });
  const memory = path.join(repo.root, "AGENTS.md");
  const drifted = MEMORY_TEXT.replace("## Rules\n", "## Rules\n\n- Run the linter before pushing.\n");
  fs.writeFileSync(memory, drifted);

  const results = applyDecisions({
    proposal,
    decisions: { e1: "rejected" },
    repo,
    state,
    config: { budgetTokens: 5000 },
  });

  assert.deepEqual(results.written, []);
  assert.equal(fs.readFileSync(memory, "utf8"), drifted);
  assert.equal(results.rejectionsRecorded, false);
  assert.equal(Object.keys(state.readRejections().entries).length, 0);
  assert.match(results.failed[0].error, /changed after this proposal was made/);
});

test("a missing memory file refuses an all-rejected decision without recording it", () => {
  const { proposal, repo, state } = gate({
    edit: memoryEdit((text) => text.replace("- Prefer small commits.", "- Prefer small, reviewable commits.")),
    annotation: { edits: [claim(["H1"], { title: "sharpen the commit rule" })] },
  });
  const memory = path.join(repo.root, "AGENTS.md");
  fs.rmSync(memory);

  const results = applyDecisions({
    proposal,
    decisions: { e1: "rejected" },
    repo,
    state,
    config: { budgetTokens: 5000 },
  });

  assert.deepEqual(results.written, []);
  assert.equal(results.rejectionsRecorded, false);
  assert.equal(Object.keys(state.readRejections().entries).length, 0);
  assert.match(results.failed[0].error, /AGENTS\.md no longer exists/);
  assert.match(results.failed[0].error, /Run `backpass`/);
});

test("an unchanged memory file still applies, so the freshness check costs nothing", () => {
  const { proposal, repo, state } = gate({
    edit: memoryEdit((t) => t.replace("- Prefer small commits.", "- Prefer small, reviewable commits.")),
    annotation: { edits: [claim(["H1"], { title: "sharpen the commit rule" })] },
  });

  const results = applyDecisions({
    proposal,
    decisions: { e1: "accepted" },
    repo,
    state,
    config: { budgetTokens: 5000 },
  });

  assert.deepEqual(results.failed, []);
  assert.equal(results.written.length, 1);
  assert.match(fs.readFileSync(path.join(repo.root, "AGENTS.md"), "utf8"), /small, reviewable commits/);
});

test("a skill is written only when the memory-file edit that points at it lands", () => {
  const skillText =
    "---\nname: node-setup\ndescription: Load before running any script.\n---\n\nuse nvm\n- Use Node 18 via nvm before running any script.\n";
  const { proposal, repo, state } = gate({
    edit: (root) => {
      writeIn(root, "AGENTS.md", (t) =>
        t.replace("- Use Node 18 via nvm before running any script.", "- Load the node-setup skill."),
      );
      writeIn(root, ".agents/skills/node-setup/SKILL.md", skillText);
    },
    annotation: { edits: [claim(["H1", "H2"], { kind: "extract", title: "extract the node pin" })] },
  });
  proposal.edits[0].hunks[0].find = "text that is not in the file at all";

  const results = applyDecisions({
    proposal,
    decisions: { e1: "accepted" },
    repo,
    state,
    config: { budgetTokens: 5000 },
  });

  assert.deepEqual(results.skills, [], "no skill for an edit that did not land");
  assert.equal(fs.existsSync(path.join(repo.root, ".agents/skills/node-setup/SKILL.md")), false);
  assert.equal(fs.existsSync(path.join(repo.root, ".claude/skills")), false, "and no layout side effects");
});

test("a failed later skill write rolls back skill paths written earlier", () => {
  const skillText =
    "---\nname: node-setup\ndescription: Load before running any script.\n---\n\nuse nvm\n- Use Node 18 via nvm before running any script.\n";
  const { proposal, repo, state } = gate({
    edit: (root) => {
      writeIn(root, "AGENTS.md", (text) =>
        text.replace("- Use Node 18 via nvm before running any script.", "- Load the node-setup skill."),
      );
      writeIn(root, ".agents/skills/node-setup/SKILL.md", skillText);
    },
    annotation: { edits: [claim(["H1", "H2"], { kind: "extract", title: "extract the node pin" })] },
  });
  const second = structuredClone(proposal.edits[0]);
  second.id = "e2";
  second.hunks = [
    {
      id: "H-extra",
      find: "- Whenever a PR is mentioned, include its URL.",
      replace: "- See the url-policy skill.",
    },
  ];
  second.skills = [
    { ...second.skills[0], name: "url-policy", path: ".agents/skills", body: "Always include the full URL." },
  ];
  proposal.edits.push(second);

  const results = applyDecisions({
    proposal,
    decisions: { e1: "accepted", e2: "accepted" },
    repo,
    state,
    config: { budgetTokens: 5000 },
  });

  assert.deepEqual(results.written, []);
  assert.equal(fs.readFileSync(path.join(repo.root, "AGENTS.md"), "utf8"), MEMORY_TEXT);
  assert.equal(fs.existsSync(path.join(repo.root, ".agents/skills/node-setup/SKILL.md")), false);
  assert.ok(
    results.failed.some(
      (failure) => /rolled back/.test(failure.error) && failure.error.includes(".agents/skills/node-setup/SKILL.md"),
    ),
  );
});

test("an accepted extract writes the skill the agent drafted, in the canonical layout", () => {
  const skillText =
    "---\nname: release-signing\ndescription: Load before tagging a release.\n---\n\n- Use Node 18 via nvm before running any script.\n\n## Steps\n\n1. sign\n";
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

// A string second argument to `String.prototype.replace` treats `$&`, `` $` ``, `$'`, and
// `$$` as replacement-pattern tokens, not literal text. Proposal evidence is untrusted
// human/model prose and can contain any of these verbatim (a possessive "the tool$'s
// state", a shell snippet with "$(...)" abbreviated as "$`...`", a price "$$5"), so the
// injector must treat the whole payload as opaque data regardless of its content.
const REPLACEMENT_TOKEN_PAYLOADS = {
  "dollar-apostrophe": "the agent read the tool$'s cached state",
  "dollar-ampersand": "grep matched $& in the log line",
  "dollar-backtick": "ran a subshell command: $`date`",
  "doubled-dollar": "the invoice showed a $$5 line item",
  combination: "$$ then $& then $`x` then it's $'s turn, all in one line",
  "evidence-shaped": [
    "Session AG-014: the agent tried $'hi\\x27' to test ANSI-C quoting,",
    "then noted the budget was $$50 over and the diff matched $& in its own grep,",
    "before falling back to a subshell: $`date`.",
  ].join(" "),
};

function extractInjectedPayload(html) {
  const match = /window\.__BACKPASS_PROPOSAL__ = (.*);<\/script>/.exec(html);
  assert.ok(match, `no injected payload found in:\n${html}`);
  return JSON.parse(match[1]);
}

for (const [name, title] of Object.entries(REPLACEMENT_TOKEN_PAYLOADS)) {
  test(`injectPayload treats a ${name} evidence payload as opaque data`, () => {
    const template = "<html><head><title>t</title></head><body>ORIGINAL BODY MARKER</body></html>";
    const payload = { edits: [{ title, evidence: [{ quote: title }] }] };
    const html = injectPayload(template, payload, "0.1.0");

    assert.equal((html.match(/<body>/g) || []).length, 1, "template suffix must not duplicate");
    assert.equal((html.match(/<\/html>/g) || []).length, 1, "template suffix must not duplicate");
    assert.equal((html.match(/<\/head>/g) || []).length, 1, "injection point must not duplicate");
    assert.equal((html.match(/ORIGINAL BODY MARKER/g) || []).length, 1, "body content must not duplicate");

    const parsed = extractInjectedPayload(html);
    assert.deepEqual(parsed, { ...payload, toolVersion: "0.1.0" }, "the full payload must survive unchanged");
  });
}

test("replacement tokens combined with markup still get both defenses", () => {
  const template = "<html><head></head><body>MARKER</body></html>";
  const title = "</script><img onerror=alert(1)> and a possessive tool$'s state, plus $$ $&";
  const html = injectPayload(template, { edits: [{ title }] }, "0.1.0");

  assert.equal((html.match(/<body>/g) || []).length, 1, "template suffix must not duplicate");
  assert.equal((html.match(/MARKER/g) || []).length, 1, "body content must not duplicate");
  assert.ok(!html.includes("</script><img"), "injected markup must not break out of the script tag");
  assert.deepEqual(extractInjectedPayload(html), { edits: [{ title }], toolVersion: "0.1.0" });
});

test("renderApplySurface writes one valid document through the real template", () => {
  const repo = makeRepo();
  const state = new State(repo.root);
  const payload = {
    edits: [
      { title: REPLACEMENT_TOKEN_PAYLOADS["combination"] },
      { title: REPLACEMENT_TOKEN_PAYLOADS["evidence-shaped"] },
    ],
  };

  const target = renderApplySurface(payload, state, "0.1.0");
  const html = fs.readFileSync(target, "utf8");

  assert.equal((html.match(/<!doctype html>/gi) || []).length, 1, "must be a single document");
  assert.equal((html.match(/<body[ >]/gi) || []).length, 1, "template suffix must not duplicate");
  assert.equal((html.match(/<\/html>/gi) || []).length, 1, "template suffix must not duplicate");
  assert.equal((html.match(/<\/head>/gi) || []).length, 1, "injection point must not duplicate");

  assert.deepEqual(extractInjectedPayload(html), { ...payload, toolVersion: "0.1.0" });
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

// ---------- the removal-evidence floor, and what deliberately stays soft ----------

const TWO_SECTIONS = [
  "# T",
  "",
  "## Alpha",
  "",
  "- Alpha one is a rule about the build.",
  "- Alpha two is a rule about the tests.",
  "",
  "## Beta",
  "",
  "- Beta one is a rule about releases.",
  "- Beta two is a rule about signing.",
  "",
  "## Keep",
  "",
  "- Stay here.",
  "",
].join("\n");

const BETA_BLOCK = "## Beta\n\n- Beta one is a rule about releases.\n- Beta two is a rule about signing.\n\n";
const ALPHA_AND_BETA =
  "## Alpha\n\n- Alpha one is a rule about the build.\n- Alpha two is a rule about the tests.\n\n" + BETA_BLOCK;
const ALPHA_SKILL =
  "---\nname: alpha\ndescription: Load before build work.\n---\n\n" +
  "## Alpha\n\n- Alpha one is a rule about the build.\n- Alpha two is a rule about the tests.\n";

/** Summary rows for the two Beta units, with the class mix under test. */
const betaRows = ({ harmSessions }) => ({
  analyzedSessions: 10,
  totals: { positive: 0, negative: 5, gapClusters: 0 },
  instructions: ["AG-003", "AG-004"].map((id) => ({
    instruction: id,
    positive: 0,
    negative: 5,
    harmSessions,
    sessions: 5,
    relevance: 0.5,
    quotes: [],
  })),
});

test("non-compliance never satisfies the removal-evidence floor; harm does", () => {
  const dropBeta = memoryEdit((t) => t.replace(BETA_BLOCK, ""));
  const annotation = { edits: [claim(["H1"], { kind: "remove", title: "drop the beta rules" })] };

  // Five sessions violated the Beta rules; not one shows harm from following them.
  const skipped = gate({
    text: TWO_SECTIONS,
    edit: dropBeta,
    annotation,
    context: { summary: betaRows({ harmSessions: 0 }) },
  });
  assert.equal(skipped.proposal.edits.length, 0);
  assert.ok(
    skipped.violations.some((v) => /harm-class negative evidence/.test(v) && /non-compliance never counts/.test(v)),
    skipped.violations.join("\n"),
  );

  // The same deletion with two sessions of harm-class evidence clears the floor.
  const harmed = gate({
    text: TWO_SECTIONS,
    edit: dropBeta,
    annotation,
    context: { summary: betaRows({ harmSessions: 2 }) },
  });
  assert.deepEqual(harmed.violations, []);
  assert.equal(harmed.proposal.edits.length, 1);
});

test("a removal is measured, not declared: relabeling the edit does not dodge the floor", () => {
  const { violations } = gate({
    text: TWO_SECTIONS,
    edit: memoryEdit((t) => t.replace(BETA_BLOCK, "")),
    annotation: { edits: [claim(["H1"], { kind: "rewrite", title: "tidy the beta section" })] },
    context: { summary: betaRows({ harmSessions: 0 }) },
  });
  assert.ok(
    violations.some((v) => /harm-class negative evidence/.test(v)),
    violations.join("\n"),
  );
});

test("the declined 20%-relevance retention rule is guidance, not a gate: extraction needs no such clearance", () => {
  // The highest-relevance, purely-positive instruction in the corpus can still be
  // extracted with zero violations - the captain kept retention as prompt guidance.
  const { violations, proposal } = gate({
    text: TWO_SECTIONS,
    edit: (root) => {
      writeIn(root, "AGENTS.md", (t) =>
        t.replace(
          "## Alpha\n\n- Alpha one is a rule about the build.\n- Alpha two is a rule about the tests.\n",
          "## Alpha\n\n- See the alpha skill.\n",
        ),
      );
      writeIn(root, ".agents/skills/alpha/SKILL.md", ALPHA_SKILL);
    },
    annotation: { edits: [claim(["H1", "H2"], { kind: "extract", title: "extract alpha" })] },
    context: {
      summary: {
        analyzedSessions: 20,
        totals: { positive: 17, negative: 0, gapClusters: 0 },
        instructions: ["AG-001", "AG-002"].map((id) => ({
          instruction: id,
          positive: 17,
          negative: 0,
          harmSessions: 0,
          sessions: 17,
          relevance: 0.85,
          quotes: [],
        })),
      },
    },
  });
  assert.deepEqual(violations, [], "no retention gate exists in code, by decision");
  assert.equal(proposal.edits.length, 1);
});

// ---------- adjacent extraction and deletion stay separate decisions ----------

test("a removal mixing extracted and deleted text is measured as two changes, split at the decision boundary", () => {
  const staged = gate({
    text: TWO_SECTIONS,
    edit: (root) => {
      writeIn(root, "AGENTS.md", (t) => t.replace(ALPHA_AND_BETA, ""));
      writeIn(root, ".agents/skills/alpha/SKILL.md", ALPHA_SKILL);
    },
    annotation: {
      edits: [
        claim(["H1", "H3"], { kind: "extract", title: "extract alpha" }),
        claim(["H2"], { kind: "remove", title: "drop the beta rules" }),
      ],
    },
    context: { summary: betaRows({ harmSessions: 2 }) },
  });

  const memoryHunks = staged.measured.changes.filter((c) => c.kind === "hunk");
  assert.equal(memoryHunks.length, 2, "one contiguous removal, two decisions, two measured changes");
  assert.ok(memoryHunks[0].find.includes("## Alpha") && !memoryHunks[0].find.includes("## Beta"));
  assert.ok(memoryHunks[1].find.includes("## Beta") && !memoryHunks[1].find.includes("## Alpha"));

  assert.deepEqual(staged.violations, []);
  assert.equal(staged.proposal.edits.length, 2);

  // Independently applicable in every combination the reviewer may choose.
  const onlyExtract = projectWithDecisions(TWO_SECTIONS, staged.proposal.edits, ["e1"], 5000);
  assert.ok(!onlyExtract.text.includes("## Alpha") && onlyExtract.text.includes("## Beta"));
  const onlyRemove = projectWithDecisions(TWO_SECTIONS, staged.proposal.edits, ["e2"], 5000);
  assert.ok(onlyRemove.text.includes("## Alpha") && !onlyRemove.text.includes("## Beta"));
  const both = projectWithDecisions(TWO_SECTIONS, staged.proposal.edits, ["e1", "e2"], 5000);
  assert.ok(!both.text.includes("## Alpha") && !both.text.includes("## Beta") && both.text.includes("## Keep"));
});

test("a recovery transition inside a multiline instruction keeps the removal indivisible", () => {
  const text = [
    "# Memory",
    "",
    "## Rules",
    "",
    "- Carry this instruction into a skill.",
    "  This continuation is part of the same instruction.",
    "- Delete this adjacent instruction.",
    "",
  ].join("\n");
  const skill = [
    "---",
    "name: partial",
    "description: Partial extraction fixture.",
    "---",
    "",
    "- Carry this instruction into a skill.",
    "",
  ].join("\n");
  const staged = gate({
    text,
    edit: (root) => {
      writeIn(root, "AGENTS.md", (memory) =>
        memory.replace(
          "- Carry this instruction into a skill.\n  This continuation is part of the same instruction.\n- Delete this adjacent instruction.\n",
          "",
        ),
      );
      writeIn(root, ".agents/skills/partial/SKILL.md", skill);
    },
    annotation: { edits: [claim(["H1", "H2"], { kind: "extract", title: "partial extraction" })] },
  });

  const memoryHunks = staged.measured.changes.filter((change) => change.kind === "hunk");
  assert.equal(memoryHunks.length, 1);
  assert.match(memoryHunks[0].find, /Carry this instruction[\s\S]*continuation[\s\S]*Delete this adjacent/);
  assert.ok(staged.violations.some((violation) => /do not carry/.test(violation)));
});

test("one carried copy cannot recover two identical removed instructions", () => {
  const text = "# Memory\n\n## Rules\n\n- Repeat this rule.\n- Repeat this rule.\n";
  const skill = [
    "---",
    "name: repeated-rule",
    "description: Carries one repeated rule.",
    "---",
    "",
    "- Repeat this rule.",
    "",
  ].join("\n");
  const staged = gate({
    text,
    edit: (root) => {
      writeIn(root, "AGENTS.md", (memory) => memory.replace("- Repeat this rule.\n- Repeat this rule.\n", ""));
      writeIn(root, ".agents/skills/repeated-rule/SKILL.md", skill);
    },
    annotation: { edits: [claim(["H1", "H2"], { kind: "extract", title: "extract one repeated rule" })] },
  });

  assert.equal(staged.measured.changes.filter((change) => change.kind === "hunk").length, 1);
  assert.ok(staged.violations.some((violation) => /do not carry/.test(violation)));
});

test("a recovered heading cannot be separated from its deleted instruction", () => {
  const text = "# Memory\n\n## Extracted\n\n- This instruction vanishes.\n\n## Deleted\n\n- Delete this too.\n";
  const skill = [
    "---",
    "name: heading-only",
    "description: Carries only a heading.",
    "---",
    "",
    "## Extracted",
    "",
  ].join("\n");
  const staged = gate({
    text,
    edit: (root) => {
      writeIn(root, "AGENTS.md", () => "# Memory\n");
      writeIn(root, ".agents/skills/heading-only/SKILL.md", skill);
    },
    annotation: { edits: [claim(["H1", "H2"], { kind: "extract", title: "heading-only extraction" })] },
  });

  const memoryHunks = staged.measured.changes.filter((change) => change.kind === "hunk");
  assert.equal(memoryHunks.length, 1);
  assert.match(memoryHunks[0].find, /## Extracted[\s\S]*This instruction vanishes/);
});

test("an extract cannot smuggle the adjacent deletion: its skills must carry every removed line", () => {
  const { violations } = gate({
    text: TWO_SECTIONS,
    edit: (root) => {
      writeIn(root, "AGENTS.md", (t) => t.replace(ALPHA_AND_BETA, ""));
      writeIn(root, ".agents/skills/alpha/SKILL.md", ALPHA_SKILL);
    },
    annotation: { edits: [claim(["H1", "H2", "H3"], { kind: "extract", title: "extract alpha and more" })] },
    context: { summary: betaRows({ harmSessions: 0 }) },
  });
  assert.ok(
    violations.some(
      (v) => /removes text its created skill\(s\) do not carry/.test(v) && /separate "remove" edit/.test(v),
    ),
    violations.join("\n"),
  );
});

test("a mixed removal reaching EOF without a trailing newline stays one merged hunk", () => {
  // The reachable layout from review: at the file's true tail, span's tail rule makes
  // the final sub-hunk's leading newline the same character as its predecessor's
  // trailing newline, so split decisions would compose in only one order. The split
  // must fail soft to the merged hunk, where the extract gate still tells the truth.
  const text = [
    "# Memory",
    "",
    "## Doomed",
    "",
    "- Delete this instruction.",
    "",
    "## Carried",
    "",
    "- Keep this instruction in a skill.",
  ].join("\n");
  const skill = [
    "---",
    "name: carried",
    "description: Carries the tail section.",
    "---",
    "",
    "## Carried",
    "",
    "- Keep this instruction in a skill.",
    "",
  ].join("\n");
  const staged = gate({
    text,
    edit: (root) => {
      writeIn(root, "AGENTS.md", () => "# Memory\n");
      writeIn(root, ".agents/skills/carried/SKILL.md", skill);
    },
    annotation: { edits: [claim(["H1", "H2"], { kind: "extract", title: "tail extraction" })] },
    context: { summary: betaRows({ harmSessions: 0 }) },
  });

  const memoryHunks = staged.measured.changes.filter((change) => change.kind === "hunk");
  assert.equal(memoryHunks.length, 1, "no split at the unanchorable tail seam");
  assert.match(memoryHunks[0].find, /## Doomed[\s\S]*## Carried/);
  assert.ok(
    staged.violations.some((violation) => /do not carry/.test(violation)),
    "the merged hunk still cannot smuggle the deletion through the extract gate",
  );
});
