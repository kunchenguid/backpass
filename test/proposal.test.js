import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import {
  applyEdit,
  buildProposal,
  DEFAULT_MAX_EDITS,
  effectiveMaxEdits,
  projectWithDecisions,
  SHRINK_EDIT_TOKENS,
  SHRINK_MAX_EDITS,
} from "../src/proposal.js";
import { foldEvidence, renderEvidenceForPrompt, renderEvidenceReport } from "../src/fold.js";
import { estimateTokens } from "../src/tokens.js";
import { parseMemoryUnits } from "../src/memory.js";
import { isSuppressedByRejection, recordRejection, State } from "../src/state.js";
import { applyDecisions } from "../src/apply/writer.js";
import { injectPayload, parseDecisions, renderApplySurface } from "../src/apply/lavish.js";
import { renderEdit } from "../src/apply/terminal.js";
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

// Two sources, because every edit that changes the always-loaded surface now clears the
// session floor. Tests whose subject is that floor pass their own evidence.
const QUOTE = [
  { polarity: "negative", text: "it used a bare #2731 reference", source: "claude · abc · turn 3" },
  { polarity: "negative", text: "the PR was named without a link", source: "codex · def · turn 8" },
];
const ONE_SESSION = [QUOTE[0]];

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

test("folded domain votes separate synthesis evidence from report-only diagnostics", () => {
  const phrasing = "Read docs/sshhip.md before changing the tunnel.";
  const folded = (domains, minGapEvidence) =>
    foldEvidence(
      domains.map((domain, index) => ({
        status: "ok",
        transcript: {
          id: `s${index + 1}`,
          harness: "claude",
          startedAt: Date.parse("2026-08-01T00:00:00Z"),
        },
        positive: [],
        negative: [],
        gaps: [
          {
            proposedInstruction: phrasing,
            mistake: `mistake ${index + 1}`,
            quote: `quote ${index + 1}`,
            recurrenceRisk: "high",
            domain,
          },
        ],
      })),
      { minGapEvidence },
    );
  const propose = (summary, minGapEvidence) => {
    const displayed = summary.gaps[0] || summary.reportOnlyGaps[0];
    const evidence = displayed.quotes.slice(0, minGapEvidence).map((quote) => ({
      polarity: "negative",
      text: quote.text,
      source: quote.source,
    }));
    return gate({
      edit: memoryEdit((text) => `${text}- ${phrasing}\n`),
      annotation: { edits: [claim(["H1"], { kind: "add", evidence })] },
      config: config({ minGapEvidence }),
      context: { summary },
    });
  };

  const eligible = propose(folded(["project", "orchestration"], 2), 2);
  assert.equal(eligible.violations.length, 0);
  assert.equal(eligible.proposal.edits.length, 1);

  for (const summary of [
    folded(["orchestration", "orchestration", "project"], 2),
    folded(["project", "orchestration"], 3),
  ]) {
    const prompt = renderEvidenceForPrompt(summary);
    assert.doesNotMatch(prompt, /Read docs\/sshhip\.md|quote [123]|REPORT ONLY/);
    const report = renderEvidenceReport(summary);
    assert.match(report, /REPORT ONLY - not synthesis-eligible evidence/);
    assert.match(report, /Read docs\/sshhip\.md/);
    assert.doesNotMatch(report, /quote [123]/);
  }
});

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
      annotation: { edits: [claim(["H1"], { kind, title: "new rule from one session", evidence: ONE_SESSION })] },
    });
    assert.equal(proposal.edits.length, 0, `${kind}: measured as an addition`);
    assert.ok(violations.some((v) => /backed by 1 session/.test(v)));
  }
});

// The always-loaded session floor. Its whole point is that it asks nothing of the text:
// a rewrite is not classified as "really an addition" or "really a tightening" - the
// only question is how many distinct sessions the edit's own quotes come from. The
// shapes below are the ones that broke every lexical proxy tried before it.
const REWRITE_SHAPES = {
  "append a sentence": (t) =>
    t.replace(
      "- Whenever a PR is mentioned, include its URL.",
      "- Whenever a PR is mentioned, include its URL. Check for and replace every bare number.",
    ),
  "append four tokens": (t) => t.replace("- Prefer small commits.", "- Prefer small commits. Same for PRs."),
  "pure tightening, shared words": (t) =>
    t.replace("- Use Node 18 via nvm before running any script.", "- Use Node 18 with nvm."),
  "paraphrase tightening, few shared words": (t) =>
    t.replace("- Use Node 18 via nvm before running any script.", "- Run every script under nvm's Node 18."),
  negation: (t) => t.replace("- Prefer small commits.", "- Never prefer small commits."),
  "version bump": (t) => t.replace("Node 18", "Node 22"),
  "unrelated net-negative substitution": (t) =>
    t.replace("- Use Node 18 via nvm before running any script.", "- Route SSH through the bastion."),
  "split one rule into two bullets": (t) =>
    t.replace(
      "- Use Node 18 via nvm before running any script.",
      "- Use Node 18 via nvm.\n- Do it before running any script.",
    ),
  "reword and extend": (t) =>
    t.replace("- Prefer small commits.", "- Keep commits small and focused, and squash fixups before review."),
  "append plus an innocent word fix in the same line": (t) =>
    t.replace(
      "- Whenever a PR is mentioned, include its URL.",
      "- Whenever a PR is mentioned, include its full URL. Check for and replace every bare number.",
    ),
};

test("a single-session rewrite is refused whatever shape it takes, and the model's own session count is ignored", () => {
  for (const [name, rewrite] of Object.entries(REWRITE_SHAPES)) {
    const { proposal, violations } = gate({
      edit: memoryEdit(rewrite),
      annotation: {
        edits: [
          // 20 declared sessions over one quoted source: the declared number is not read.
          claim(["H1"], { kind: "rewrite", title: name, evidence: ONE_SESSION, transcripts: 20 }),
        ],
      },
    });
    assert.equal(proposal.edits.length, 0, `${name} was accepted on one session`);
    assert.ok(
      violations.some((v) => /changes AGENTS\.md backed by 1 session\(s\); 2 are required/.test(v)),
      `${name}: ${violations.join("\n")}`,
    );
  }
});

test("empty evidence cannot pad a single-session rewrite", () => {
  const { proposal, violations } = gate({
    edit: memoryEdit(REWRITE_SHAPES["append a sentence"]),
    annotation: {
      edits: [
        claim(["H1"], {
          kind: "rewrite",
          evidence: [...ONE_SESSION, { polarity: "negative", text: "  ", source: "fake-session" }],
        }),
      ],
    },
  });
  assert.equal(proposal.edits.length, 0);
  assert.ok(
    violations.some((v) => /backed by 1 session/.test(v)),
    violations.join("\n"),
  );
});

test("sourceless evidence cannot pad a single-session rewrite and remains visible", () => {
  for (const source of [undefined, "", "   "]) {
    const sourceless = { polarity: "negative", text: "another quote", ...(source === undefined ? {} : { source }) };
    const { proposal, violations } = gate({
      edit: memoryEdit(REWRITE_SHAPES["append a sentence"]),
      annotation: {
        edits: [claim(["H1"], { kind: "rewrite", evidence: [...ONE_SESSION, sourceless] })],
      },
    });
    assert.equal(proposal.edits.length, 0);
    assert.ok(
      violations.some((v) => /backed by 1 session/.test(v)),
      violations.join("\n"),
    );
  }

  const { proposal, violations } = gate({
    edit: memoryEdit(REWRITE_SHAPES["append a sentence"]),
    annotation: {
      edits: [
        claim(["H1"], {
          kind: "rewrite",
          evidence: [...QUOTE, { polarity: "negative", text: "visible quote" }],
        }),
      ],
    },
  });
  assert.deepEqual(violations, []);
  assert.equal(proposal.edits[0].transcripts, 2);
  assert.deepEqual(
    proposal.edits[0].evidence.find((item) => item.text === "visible quote"),
    { polarity: "negative", text: "visible quote", source: "unknown source" },
  );
});

test("source-label whitespace cannot pad a single-session rewrite", () => {
  const repeated = { ...ONE_SESSION[0], source: "claude  ·  abc · turn 3" };
  const { proposal, violations } = gate({
    edit: memoryEdit(REWRITE_SHAPES["append a sentence"]),
    annotation: {
      edits: [claim(["H1"], { kind: "rewrite", evidence: [...ONE_SESSION, repeated] })],
    },
  });
  assert.equal(proposal.edits.length, 0);
  assert.ok(
    violations.some((v) => /backed by 1 session/.test(v)),
    violations.join("\n"),
  );
});

test("a rewrite spread over two hunks cannot pay for itself with one session", () => {
  const { proposal, violations } = gate({
    edit: memoryEdit((t) =>
      t
        .replace("- Use Node 18 via nvm before running any script.", "- Use Node 18 with nvm.")
        .replace(
          "- Whenever a PR is mentioned, include its URL.",
          "- Whenever a PR is mentioned, include its URL. Always.",
        ),
    ),
    annotation: { edits: [claim(["H1", "H2"], { kind: "rewrite", title: "two hunks", evidence: ONE_SESSION })] },
  });
  assert.equal(proposal.edits.length, 0);
  assert.ok(
    violations.some((v) => /backed by 1 session/.test(v)),
    violations.join("\n"),
  );
});

test("two quoted sessions carry a rewrite of any shape, including a pure tightening", () => {
  for (const [name, rewrite] of Object.entries(REWRITE_SHAPES)) {
    const { proposal, violations } = gate({
      edit: memoryEdit(rewrite),
      // `claim` quotes two sources; `transcripts` is deliberately absent from the annotation.
      annotation: { edits: [claim(["H1"], { kind: "rewrite", title: name })] },
    });
    assert.deepEqual(violations, [], `${name}: ${violations.join("\n")}`);
    assert.equal(proposal.edits.length, 1, name);
    assert.equal(proposal.edits[0].transcripts, 2, `${name}: the count is measured from the quotes`);
  }
});

test("the dry run's three appends still pass on their real quote-source counts", () => {
  // e1 to e3 of the user-scope dry run: 1-removed/1-added appends backed by 3, 2 and 2
  // distinct sources, over models that declared 11, 20 and 2.
  const source = (n) => ({ polarity: "negative", text: `quote ${n}`, source: `claude · s${n} · 2026-08-0${n}` });
  const appends = [
    {
      name: "e1 em dash",
      sources: 3,
      declared: 11,
      edit: (t) =>
        t.replace(
          "include its URL.",
          "include its URL. Before sending prose, check for and replace every bare reference.",
        ),
    },
    {
      name: "e2 repro before fix",
      sources: 2,
      declared: 20,
      edit: (t) =>
        t.replace(
          "- Prefer small commits.",
          "- Prefer small commits. Reproduce before implementing the fix, then repeat the same check after.",
        ),
    },
    {
      name: "e3 lint warnings",
      sources: 2,
      declared: 2,
      edit: (t) =>
        t.replace(
          "before running any script.",
          "before running any script. Treat warnings as issues rather than dismissing them.",
        ),
    },
  ];
  for (const append of appends) {
    const evidence = Array.from({ length: append.sources }, (_, i) => source(i + 1));
    const { proposal, violations } = gate({
      edit: memoryEdit(append.edit),
      annotation: {
        edits: [claim(["H1"], { kind: "rewrite", title: append.name, evidence, transcripts: append.declared })],
      },
    });
    assert.deepEqual(violations, [], `${append.name}: ${violations.join("\n")}`);
    assert.equal(proposal.edits[0].transcripts, append.sources, append.name);
  }
});

test("a quote counts as a session only when the fold issued its source label", () => {
  const foldRecord = (id, day, quote) => ({
    status: "ok",
    transcript: { id, harness: "claude", startedAt: Date.parse(`2026-08-${day}T00:00:00Z`) },
    positive: [],
    negative: [{ instruction: "AG-001", quote, effect: "the rule was skipped", class: "non-compliance" }],
    gaps: [],
  });
  const summary = foldEvidence(
    [foldRecord("b859b8f3deadbeef", "18", "real quote"), foldRecord("c0ffee00deadbeef", "19", "other quote")],
    { memoryFile: { units: parseMemoryUnits(MEMORY_TEXT) }, minGapEvidence: 2 },
  );
  const issued = summary.sources.find((label) => label.includes("b859b8f3"));
  assert.ok(issued, "the fold must issue a source for the cited session");
  const mistypedDate = issued.replace("2026-08-18", "2026-08-17");
  assert.notEqual(mistypedDate, issued);
  assert.equal(summary.sources.includes(mistypedDate), false);

  const rewrite = memoryEdit(REWRITE_SHAPES["append a sentence"]);
  const typo = gate({
    edit: rewrite,
    annotation: {
      edits: [
        claim(["H1"], {
          kind: "rewrite",
          title: "one session under two labels",
          evidence: [
            { polarity: "negative", text: "real quote", source: issued },
            { polarity: "negative", text: "same session, wrong date", source: mistypedDate },
          ],
        }),
      ],
    },
    context: { summary },
  });
  assert.equal(typo.proposal.edits.length, 0);
  assert.ok(
    typo.violations.some((v) => /backed by 1 session\(s\); 2 are required/.test(v)),
    typo.violations.join("\n"),
  );

  const twoIssued = gate({
    edit: rewrite,
    annotation: {
      edits: [
        claim(["H1"], {
          kind: "rewrite",
          title: "two fold-issued sessions",
          evidence: summary.sources.map((source, i) => ({
            polarity: "negative",
            text: `quote ${i}`,
            source,
          })),
        }),
      ],
    },
    context: { summary },
  });
  assert.deepEqual(twoIssued.violations, [], twoIssued.violations.join("\n"));
  assert.equal(twoIssued.proposal.edits[0].transcripts, 2);

  const unissued = gate({
    edit: rewrite,
    annotation: {
      edits: [claim(["H1"], { kind: "rewrite", title: "label the fold never issued", evidence: ONE_SESSION })],
    },
    context: { summary },
  });
  assert.equal(unissued.proposal.edits.length, 0);
  assert.ok(
    unissued.violations.some((v) => /backed by 0 session\(s\); 2 are required/.test(v)),
    unissued.violations.join("\n"),
  );
});

test("on the r1 dry-run corpus, only the edit whose second source was never issued is refused", () => {
  const foldRecord = (id, day, quote) => ({
    status: "ok",
    transcript: { id, harness: "claude", startedAt: Date.parse(`2026-08-${day}T00:00:00Z`) },
    positive: [],
    negative: [{ instruction: "AG-001", quote, effect: "the rule was skipped", class: "non-compliance" }],
    gaps: [],
  });
  const summary = foldEvidence(
    [
      foldRecord("sess0001", "01", "e1a"),
      foldRecord("sess0002", "02", "e1b"),
      foldRecord("sess0003", "03", "e1c"),
      foldRecord("sess0004", "04", "e4b"),
    ],
    { memoryFile: { units: parseMemoryUnits(MEMORY_TEXT) }, minGapEvidence: 2 },
  );
  const [s1, s2, s3, s4] = summary.sources;
  const phantom = s1.replace(/2026-08-01/, "2026-08-17");
  assert.equal(summary.sources.includes(phantom), false);

  const cases = [
    {
      name: "e1 em dash",
      expect: "pass",
      kind: "rewrite",
      sources: [s1, s2, s3],
      edit: (t) =>
        t.replace(
          "include its URL.",
          "include its URL. Before sending prose, check for and replace every bare reference.",
        ),
    },
    {
      name: "e2 repro before fix",
      expect: "pass",
      kind: "rewrite",
      sources: [s1, s2],
      edit: (t) =>
        t.replace(
          "- Prefer small commits.",
          "- Prefer small commits. Reproduce before implementing the fix, then repeat the same check after.",
        ),
    },
    {
      name: "e3 lint warnings",
      expect: "refuse",
      kind: "rewrite",
      sources: [s1, phantom],
      edit: (t) =>
        t.replace(
          "before running any script.",
          "before running any script. Treat warnings as issues rather than dismissing them.",
        ),
    },
    {
      name: "e4 current_head skill",
      expect: "pass",
      kind: "add",
      sources: [s2, s4],
      edit: (t) =>
        t.replace(
          "- Prefer small commits.",
          "- Prefer small commits.\n- Prefer the current branch head when naming git state.",
        ),
    },
  ];

  for (const item of cases) {
    const evidence = item.sources.map((source, i) => ({
      polarity: "negative",
      text: `${item.name} quote ${i}`,
      source,
    }));
    const { proposal, violations } = gate({
      edit: memoryEdit(item.edit),
      annotation: {
        edits: [claim(["H1"], { kind: item.kind, title: item.name, evidence, transcripts: 20 })],
      },
      context: { summary },
    });
    if (item.expect === "pass") {
      assert.deepEqual(violations, [], `${item.name}: ${violations.join("\n")}`);
      assert.equal(proposal.edits.length, 1, item.name);
      assert.equal(proposal.edits[0].transcripts, item.sources.length, item.name);
    } else {
      assert.equal(proposal.edits.length, 0, `${item.name} was accepted`);
      assert.ok(
        violations.some((v) => /backed by 1 session\(s\); 2 are required/.test(v)),
        `${item.name}: ${violations.join("\n")}`,
      );
    }
  }
});

test("extract and move stay exempt from the session floor: they keep every always-loaded line", () => {
  const extracted = "- Use Node 18 via nvm before running any script.";
  const extract = gate({
    edit: (root) => {
      writeIn(root, "AGENTS.md", (t) => t.replace(`${extracted}\n`, ""));
      writeIn(
        root,
        ".agents/skills/setup/SKILL.md",
        `---\nname: setup\ndescription: setting up the toolchain\n---\n\n${extracted}\n`,
      );
    },
    annotation: { edits: [claim(["H1", "H2"], { kind: "extract", title: "extract setup", evidence: ONE_SESSION })] },
  });
  assert.deepEqual(extract.violations, [], extract.violations.join("\n"));

  const moved = gate({
    text: `${MEMORY_TEXT}\n## Later\n\n- Keep this nearby.\n`,
    edit: memoryEdit((t) =>
      t.replace(`${extracted}\n`, "").replace("- Keep this nearby.", `${extracted}\n- Keep this nearby.`),
    ),
    annotation: { edits: [claim(["H1", "H2"], { kind: "move", title: "reposition setup", evidence: ONE_SESSION })] },
  });
  assert.deepEqual(moved.violations, [], moved.violations.join("\n"));
});

test("the user-scope project floor counts instruction evidence, not only gap quotes", () => {
  // A rewrite reinforcing an existing instruction quotes instruction-row evidence, which
  // carries no project of its own. The fold hands the gate the session -> project map so
  // those quotes still answer the "how many projects" question.
  const record = (id, project) => ({
    status: "ok",
    transcript: { id, harness: "claude", project, startedAt: Date.parse("2026-08-01T00:00:00Z") },
    positive: [],
    negative: [
      { instruction: "AG-001", quote: `quote from ${id}`, effect: "the URL was omitted", class: "non-compliance" },
    ],
    gaps: [],
  });
  const foldFor = (projects) =>
    foldEvidence(
      projects.map((project, i) => record(`s${i + 1}`, project)),
      { minGapEvidence: 2 },
    );

  const rewrite = memoryEdit((t) => t.replace("include its URL.", "include its full https:// URL."));
  const proposeWith = (summary, minGapProjects, varySourceWhitespace = false) => {
    const evidence = summary.instructions[0].quotes.map((quote, index) => ({
      polarity: "negative",
      text: quote.text,
      source: varySourceWhitespace
        ? index === 0
          ? `  ${quote.source}  `
          : quote.source.replaceAll(" · ", "  ·   ")
        : quote.source,
    }));
    return gate({
      edit: rewrite,
      annotation: { edits: [claim(["H1"], { kind: "rewrite", title: "spell out the URL", evidence })] },
      config: config({ minGapProjects }),
      context: { summary, scope: { kind: "user" } },
    });
  };

  const oneProject = proposeWith(foldFor(["repo-a", "repo-a"]), 2);
  assert.ok(
    oneProject.violations.some((v) => /evidence from 1 project\(s\); 2 are required/.test(v)),
    oneProject.violations.join("\n"),
  );

  const twoProjects = proposeWith(foldFor(["repo-a", "repo-b"]), 2, true);
  assert.deepEqual(twoProjects.violations, [], twoProjects.violations.join("\n"));
  assert.equal(twoProjects.proposal.edits[0].projects, 2);

  // Same evidence in a project-scoped run: no project gate at all. Quote the fold's
  // own labels; a project-scoped fold still issues `sources` even when sourceProjects is empty.
  const projectSummary = foldFor(["repo-a", "repo-a"]);
  const projectScope = gate({
    edit: rewrite,
    annotation: {
      edits: [
        claim(["H1"], {
          kind: "rewrite",
          title: "spell out the URL",
          evidence: projectSummary.instructions[0].quotes.map((quote) => ({
            polarity: "negative",
            text: quote.text,
            source: quote.source,
          })),
        }),
      ],
    },
    config: config({ minGapProjects: 2 }),
    context: { summary: projectSummary, scope: { kind: "project" } },
  });
  assert.deepEqual(projectScope.violations, [], projectScope.violations.join("\n"));
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

test("the proposal carries the fold's gap-funnel counts for the apply surface", () => {
  const edit = memoryEdit((t) => t.replace("- Use Node 18 via nvm before running any script.\n", ""));
  const annotation = { edits: [claim(["H1"], { kind: "remove", title: "drop the stale Node pin" })] };

  const funneled = gate({
    edit,
    annotation,
    context: {
      summary: {
        analyzedSessions: 16,
        totals: {
          positive: 34,
          negative: 7,
          gapSightings: 9,
          gapClusters: 0,
          reportOnlyGapClusters: 2,
          reportOnlyByReason: { majorityOrchestration: 1, belowFloorMixed: 1, tooFewProjects: 0 },
          droppedGapSingletons: 3,
          orchestrationGapSightings: 6,
          instructionsWithNegatives: 3,
        },
        instructions: Array.from({ length: 20 }, (_, i) => ({
          instruction: `AG-${String(i + 1).padStart(3, "0")}`,
          harmSessions: 4,
        })),
      },
    },
  });
  assert.equal(funneled.proposal.stats.gapSightings, 9);
  assert.equal(funneled.proposal.stats.orchestrationGapSightings, 6);
  assert.equal(funneled.proposal.stats.reportOnlyGapClusters, 2);
  assert.deepEqual(funneled.proposal.stats.reportOnlyByReason, {
    majorityOrchestration: 1,
    belowFloorMixed: 1,
    tooFewProjects: 0,
  });
  assert.equal(funneled.proposal.stats.droppedGapSingletons, 3);
  assert.equal(funneled.proposal.stats.gapClusters, 0);
  assert.equal(funneled.proposal.stats.instructionsWithNegatives, 3);

  // A summary from before the counts existed yields null, never an invented zero.
  const legacy = gate({
    edit,
    annotation,
    context: {
      summary: {
        analyzedSessions: 4,
        totals: { positive: 3, negative: 2, gapClusters: 1 },
        instructions: Array.from({ length: 20 }, (_, i) => ({
          instruction: `AG-${String(i + 1).padStart(3, "0")}`,
          negative: 4,
          harmSessions: 4,
          sessions: 4,
        })),
      },
    },
  });
  assert.equal(legacy.proposal.stats.gapSightings, null);
  assert.equal(legacy.proposal.stats.orchestrationGapSightings, null);
  assert.equal(legacy.proposal.stats.reportOnlyGapClusters, null);
  assert.equal(legacy.proposal.stats.reportOnlyByReason, null);
  assert.equal(legacy.proposal.stats.droppedGapSingletons, null);
  assert.equal(legacy.proposal.stats.instructionsWithNegatives, null);
  assert.equal(legacy.proposal.stats.instructionsLeftAlone, null, "legacy instruction rows do not invent counts");
  assert.equal(legacy.proposal.stats.leftAloneMaxSessions, null);
  assert.equal(legacy.proposal.stats.instructionsSuppressed, null);
});

test("the funnel's left-alone count names the candidates no accepted edit touched", () => {
  const edit = memoryEdit((t) => t.replace("- Use Node 18 via nvm before running any script.\n", ""));
  const annotation = { edits: [claim(["H1"], { kind: "remove", title: "drop the stale Node pin" })] };
  const row = (instruction, negative, nonComplianceSessions) => ({
    instruction,
    positive: 0,
    negative,
    nonComplianceSessions,
    harmSessions: 4,
    sessions: 4,
    relevance: 1,
    quotes: [],
  });

  const gated = gate({
    edit,
    annotation,
    context: {
      summary: {
        analyzedSessions: 4,
        totals: {
          positive: 0,
          negative: 4,
          gapClusters: 0,
          gapSightings: 0,
          reportOnlyGapClusters: 0,
          reportOnlyByReason: { majorityOrchestration: 0, belowFloorMixed: 0, tooFewProjects: 0 },
          droppedGapSingletons: 0,
          instructionsWithNegatives: 2,
        },
        instructions: [
          // The accepted edit claims no instruction, so every candidate is left alone.
          row("AG-001", 3, 0),
          row("AG-002", 1, 1),
          // Only positives: never a candidate, so never "left alone" either.
          { ...row("AG-003", 0, 0), positive: 5 },
        ],
      },
    },
  });
  assert.deepEqual(gated.violations, []);
  assert.equal(gated.proposal.stats.instructionsLeftAlone, 2);
  assert.equal(gated.proposal.stats.leftAloneMaxSessions, 1, "the maximum does not imply every count is one");
  assert.ok(
    funnelLines(renderTemplateScript(gated.proposal)).some(
      (line) => line.drop === "2 dropped - no accepted edit named these candidates",
    ),
  );

  // An edit that names one of them removes it from the count, and the surviving
  // candidate's session count is reported as it stands.
  const claimed = gate({
    edit,
    annotation: { edits: [claim(["H1"], { kind: "remove", title: "drop it", instructions: ["AG-001"] })] },
    context: {
      summary: {
        analyzedSessions: 4,
        totals: {
          positive: 3,
          negative: 2,
          gapClusters: 1,
          gapSightings: 1,
          reportOnlyGapClusters: 0,
          reportOnlyByReason: { majorityOrchestration: 0, belowFloorMixed: 0, tooFewProjects: 0 },
          droppedGapSingletons: 0,
          instructionsWithNegatives: 2,
        },
        instructions: [row("AG-001", 3, 1), row("AG-002", 1, 6), { ...row("AG-003", 0, 0), positive: 5 }],
      },
    },
  });
  assert.deepEqual(claimed.violations, []);
  assert.equal(claimed.proposal.stats.instructionsLeftAlone, 1);
  assert.equal(claimed.proposal.stats.leftAloneMaxSessions, 6);
});

test("the funnel's display counters never change which edits are proposed or refused", () => {
  const edit = memoryEdit((t) => t.replace("- Use Node 18 via nvm before running any script.\n", ""));
  const annotation = { edits: [claim(["H1"], { kind: "remove", title: "drop the stale Node pin" })] };
  const instructions = Array.from({ length: 20 }, (_, i) => ({
    instruction: `AG-${String(i + 1).padStart(3, "0")}`,
    positive: 0,
    negative: 4,
    nonComplianceSessions: 4,
    harmSessions: 4,
    sessions: 4,
    relevance: 1,
    quotes: [],
  }));
  const totals = { positive: 3, negative: 2, gapClusters: 1, gapSightings: 9, droppedGapSingletons: 3 };

  const withCounters = gate({
    edit,
    annotation,
    context: {
      summary: {
        analyzedSessions: 4,
        totals: {
          ...totals,
          instructionsWithNegatives: 20,
          reportOnlyGapClusters: 2,
          reportOnlyByReason: { majorityOrchestration: 2, belowFloorMixed: 0, tooFewProjects: 0 },
        },
        instructions,
      },
    },
  });
  const without = gate({
    edit,
    annotation,
    context: { summary: { analyzedSessions: 4, totals, instructions } },
  });

  assert.deepEqual(withCounters.violations, without.violations);
  assert.deepEqual(withCounters.proposal.edits, without.proposal.edits);
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
  assert.ok(split.violations.some((v) => /kind "extract" must group SKILL\.md file\(s\)/.test(v)));
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

const noHarmRows = () => ({
  analyzedSessions: 4,
  totals: { positive: 0, negative: 4, gapClusters: 0 },
  instructions: Array.from({ length: 20 }, (_, i) => ({
    instruction: `AG-${String(i + 1).padStart(3, "0")}`,
    positive: 0,
    negative: 4,
    harmSessions: 0,
    sessions: 4,
    relevance: 1,
    quotes: [],
  })),
});

test("an extract may extend an existing SKILL.md when the staged file keeps prior lines and carries the removal", () => {
  const existing = skillFile("node-setup", "- Prefer nvm over a system node.\n");
  const extracted = "- Use Node 18 via nvm before running any script.";
  const extend = (root) => {
    writeIn(root, "AGENTS.md", (t) => t.replace(extracted, "- See the node-setup skill."));
    writeIn(root, ".agents/skills/node-setup/SKILL.md", (t) =>
      t.replace("- Prefer nvm over a system node.\n", `- Prefer nvm over a system node.\n${extracted}\n`),
    );
  };
  const files = { ".agents/skills/node-setup/SKILL.md": existing };

  const good = gate({
    files,
    edit: extend,
    annotation: { edits: [claim(["H1", "H2"], { kind: "extract", title: "fold the node pin into node-setup" })] },
    context: { summary: noHarmRows() },
  });
  assert.deepEqual(good.violations, [], good.violations.join("\n"));
  assert.equal(good.proposal.edits.length, 1);
  assert.equal(good.proposal.edits[0].kind, "extract");
  assert.equal(good.proposal.edits[0].hunks.length, 2, "memory removal and skill extension are one decision");
  assert.equal(
    good.proposal.edits[0].skills.length,
    0,
    "the skill already exists; apply patches it, it does not create it",
  );
  assert.equal(good.proposal.stats.skillExtractions, 1);
  assert.deepEqual(
    good.proposal.targetFiles.map((t) => t.file),
    [".agents/skills/node-setup/SKILL.md"],
  );

  const mixed = gate({
    files,
    edit: (root) => {
      extend(root);
      writeIn(root, ".agents/skills/release-signing/SKILL.md", skillFile("release-signing"));
    },
    annotation: {
      edits: [claim(["H1", "H2", "H3"], { kind: "extract", title: "extend setup and add signing" })],
    },
    context: { summary: noHarmRows() },
  });
  assert.deepEqual(mixed.violations, [], mixed.violations.join("\n"));
  assert.equal(mixed.proposal.stats.skillExtractions, 2, "created and extended destinations both count");

  const applied = applyDecisions({
    proposal: good.proposal,
    decisions: { e1: "accepted" },
    repo: good.repo,
    state: good.state,
    config: { budgetTokens: 5000 },
  });
  assert.equal(applied.failed.length, 0, JSON.stringify(applied.failed));
  const skill = fs.readFileSync(path.join(good.repo.root, ".agents/skills/node-setup/SKILL.md"), "utf8");
  assert.ok(skill.includes("- Prefer nvm over a system node."), "prior skill lines stay");
  assert.ok(skill.includes(extracted), "extracted lines land in the existing skill");
  const memory = fs.readFileSync(path.join(good.repo.root, "AGENTS.md"), "utf8");
  assert.ok(memory.includes("- See the node-setup skill."));
  assert.ok(!memory.includes(extracted));

  const split = gate({
    files,
    edit: extend,
    annotation: { edits: [claim(["H1", "H2"], { kind: "rewrite", title: "fold the node pin into node-setup" })] },
    context: { summary: noHarmRows() },
  });
  assert.ok(
    split.violations.some((v) => /an edit changes one file/.test(v)),
    `grouping the two files as a rewrite must fail, got ${JSON.stringify(split.violations)}`,
  );

  const cut = (root) => {
    writeIn(root, "AGENTS.md", (t) => t.replace(`${extracted}\n`, ""));
    writeIn(root, ".agents/skills/node-setup/SKILL.md", (t) =>
      t.replace("- Prefer nvm over a system node.\n", `- Prefer nvm over a system node.\n${extracted}\n`),
    );
  };
  const asRemove = gate({
    files,
    edit: cut,
    annotation: {
      edits: [
        claim(["H1"], { kind: "remove", title: "drop the node pin" }),
        claim(["H2"], { kind: "rewrite", title: "append to node-setup" }),
      ],
    },
    context: { summary: noHarmRows() },
  });
  assert.ok(
    asRemove.violations.some((v) => /harm-class negative evidence/.test(v)),
    `a bare memory deletion still needs harm, got ${JSON.stringify(asRemove.violations)}`,
  );
  const asExtract = gate({
    files,
    edit: cut,
    annotation: { edits: [claim(["H1", "H2"], { kind: "extract", title: "fold the node pin into node-setup" })] },
    context: { summary: noHarmRows() },
  });
  assert.deepEqual(asExtract.violations, [], asExtract.violations.join("\n"));

  const droppedPrior = gate({
    files,
    edit: (root) => {
      writeIn(root, "AGENTS.md", (t) => t.replace(extracted, "- See the node-setup skill."));
      writeIn(root, ".agents/skills/node-setup/SKILL.md", skillFile("node-setup", `${extracted}\n`));
    },
    annotation: { edits: [claim(["H1", "H2"], { kind: "extract", title: "replace the skill body" })] },
    context: { summary: noHarmRows() },
  });
  assert.ok(
    droppedPrior.violations.some((v) => /drops text the existing skill already had/.test(v)),
    droppedPrior.violations.join("\n"),
  );
});

test("an extended extraction requires prior skill lines plus separately carried memory lines", () => {
  const extracted = "- Use Node 18 via nvm before running any script.";
  const skill = skillFile("node-setup", `${extracted}\n`);
  const reusedPriorCopy = gate({
    files: { ".agents/skills/node-setup/SKILL.md": skill },
    edit: (root) => {
      writeIn(root, "AGENTS.md", (text) => text.replace(extracted, "- See the node-setup skill."));
      writeIn(root, ".agents/skills/node-setup/SKILL.md", (text) => `${text}- Added unrelated guidance.\n`);
    },
    annotation: { edits: [claim(["H1", "H2"], { kind: "extract", title: "extract node setup" })] },
  });

  assert.ok(
    reusedPriorCopy.violations.some((violation) => /removes text its skill\(s\) do not carry/.test(violation)),
    reusedPriorCopy.violations.join("\n"),
  );
});

test("an extract cannot bypass addition evidence without removing memory text", () => {
  const skill = skillFile("node-setup", "- Keep this setup guidance.\n");
  const files = { ".agents/skills/node-setup/SKILL.md": skill };
  const addOnly = (root) => {
    writeIn(root, "AGENTS.md", (text) => `${text}- Unsupported new memory rule.\n`);
    writeIn(root, ".agents/skills/node-setup/SKILL.md", (text) => `${text}- More skill guidance.\n`);
  };

  const unsupported = gate({
    files,
    edit: addOnly,
    annotation: {
      edits: [claim(["H1", "H2"], { kind: "extract", title: "add setup guidance", evidence: ONE_SESSION })],
    },
  });
  assert.ok(
    unsupported.violations.some((violation) => /adds a new instruction backed by 1 session/.test(violation)),
    unsupported.violations.join("\n"),
  );

  const corroborated = gate({
    files,
    edit: addOnly,
    annotation: { edits: [claim(["H1", "H2"], { kind: "extract", title: "add setup guidance" })] },
  });
  assert.ok(
    corroborated.violations.some((violation) => /kind "extract" must remove text/.test(violation)),
    corroborated.violations.join("\n"),
  );
});

test("addition project counts come from folded gap evidence", () => {
  const edit = memoryEdit((text) => `${text}- Include the full pull request URL.\n`);
  const annotation = { edits: [claim(["H1"], { kind: "add" })] };
  const summary = (projects) => ({
    analyzedSessions: 3,
    totals: { positive: 0, negative: 0, gapClusters: 1 },
    instructions: [],
    gaps: [
      {
        proposedInstruction: "Include the full pull request URL.",
        sessions: 3,
        projects,
        quotes: [{ text: QUOTE[0].text, source: QUOTE[0].source }],
      },
    ],
  });

  const oneProject = gate({
    edit,
    annotation,
    config: config({ minGapProjects: 2 }),
    context: { summary: summary(1), scope: { kind: "user" } },
  });
  assert.ok(oneProject.violations.some((violation) => /evidence from 1 project/.test(violation)));

  const twoProjects = gate({
    edit,
    annotation,
    config: config({ minGapProjects: 2 }),
    context: { summary: summary(2), scope: { kind: "user" } },
  });
  assert.deepEqual(twoProjects.violations, []);
  assert.equal(twoProjects.proposal.edits[0].projects, 2);

  const projectScope = gate({
    edit,
    annotation,
    config: config({ minGapProjects: 2 }),
    context: { summary: summary(1), scope: { kind: "project" } },
  });
  assert.deepEqual(projectScope.violations, []);
  assert.equal(projectScope.proposal.edits[0].projects, undefined);
});

test("a move repositions verbatim memory-file text without the harm floor", () => {
  const text = `${MEMORY_TEXT}\n## Later\n\n- Keep this nearby.\n`;
  const node = "- Use Node 18 via nvm before running any script.";
  const relocate = memoryEdit((t) =>
    t.replace(`${node}\n`, "").replace("- Keep this nearby.", `- Keep this nearby.\n${node}`),
  );

  const split = gate({
    text,
    edit: relocate,
    annotation: {
      edits: [
        claim(["H1"], { kind: "remove", title: "drop the node pin" }),
        claim(["H2"], { kind: "add", title: "put it later" }),
      ],
    },
    context: { summary: noHarmRows() },
  });
  assert.ok(
    split.violations.some((v) => /harm-class negative evidence/.test(v)),
    `the deletion half of a move must hit the harm floor, got ${JSON.stringify(split.violations)}`,
  );

  const moved = gate({
    text,
    edit: relocate,
    annotation: { edits: [claim(["H1", "H2"], { kind: "move", title: "park the node pin later" })] },
    context: { summary: noHarmRows() },
  });
  assert.deepEqual(moved.violations, [], moved.violations.join("\n"));
  assert.equal(moved.proposal.edits.length, 1);
  assert.equal(moved.proposal.edits[0].kind, "move");
  assert.equal(moved.proposal.edits[0].hunks.length, 2, "deletion and re-add are one decision");

  const applied = applyDecisions({
    proposal: moved.proposal,
    decisions: { e1: "accepted" },
    repo: moved.repo,
    state: moved.state,
    config: { budgetTokens: 5000 },
  });
  assert.equal(applied.failed.length, 0, JSON.stringify(applied.failed));
  const next = fs.readFileSync(path.join(moved.repo.root, "AGENTS.md"), "utf8");
  const first = next.indexOf(node);
  assert.ok(first !== -1);
  assert.equal(next.indexOf(node, first + 1), -1, "the line appears once, not duplicated");
  assert.ok(first > next.indexOf("## Later"), "the line moved below Later");

  const fake = gate({
    text,
    edit: memoryEdit((t) =>
      t.replace(`${node}\n`, "").replace("- Keep this nearby.", "- Keep this nearby.\n- Use Node 22 instead."),
    ),
    annotation: { edits: [claim(["H1", "H2"], { kind: "move", title: "rewrite disguised as move" })] },
    context: { summary: noHarmRows() },
  });
  assert.ok(
    fake.violations.some((v) => /does not reappear verbatim/.test(v)),
    fake.violations.join("\n"),
  );

  const extraAddition = gate({
    text,
    edit: memoryEdit((t) =>
      t
        .replace(`${node}\n`, "")
        .replace("- Keep this nearby.", `- Keep this nearby.\n${node}\n- Unsupported extra rule.`),
    ),
    annotation: { edits: [claim(["H1", "H2"], { kind: "move", title: "move and smuggle an addition" })] },
    context: { summary: noHarmRows() },
  });
  assert.ok(
    extraAddition.violations.some((v) => /removed and added lines must match exactly/.test(v)),
    extraAddition.violations.join("\n"),
  );

  const duplicateText = [
    MEMORY_TEXT,
    "## Middle",
    "",
    node,
    "",
    "## Spacer",
    "",
    "- Leave enough unique context between copies.",
    "",
    "## Destination",
    "",
    "- Keep this last.",
    "",
  ].join("\n");
  const doubleRemoval = gate({
    text: duplicateText,
    edit: memoryEdit((t) => t.replaceAll(`${node}\n`, "").replace("- Keep this last.", `- Keep this last.\n${node}`)),
    annotation: {
      edits: [claim(["H1", "H2", "H3"], { kind: "move", title: "collapse two copies into one" })],
    },
    context: { summary: noHarmRows() },
  });
  assert.ok(
    doubleRemoval.violations.some((v) => /removed and added lines must match exactly/.test(v)),
    doubleRemoval.violations.join("\n"),
  );
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
  // Only the description line of a skill is always-loaded: the budget moves by the
  // measured description delta, never by the body text around it.
  const descDelta = estimateTokens("Load before touching the database.") - estimateTokens("old trigger");
  assert.equal(rewritten.proposal.edits[0].descriptionDelta, descDelta);
  assert.equal(rewritten.proposal.budget.delta, descDelta, "the description line is the skill's always-loaded cost");
  assert.deepEqual(
    rewritten.proposal.targetFiles.map((t) => t.file),
    [".agents/skills/db/SKILL.md"],
    "the proposal fingerprints every non-memory file its edits target",
  );

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
    annotation: {
      edits: [claim(["H1"], { kind: "remove", title: "drop the stale Node pin", instructions: ["AG-001"] })],
    },
  });
  const rejections = recordRejection(first.proposal.edits[0], { version: 1, entries: {} });

  const suppressed = gate({
    edit,
    annotation: {
      edits: [claim(["H1"], { kind: "remove", title: "drop the stale Node pin", instructions: ["AG-001"] })],
    },
    context: {
      rejections,
      isSuppressed: isSuppressedByRejection,
      summary: {
        analyzedSessions: 4,
        totals: {
          positive: 3,
          negative: 80,
          gapClusters: 1,
          gapSightings: 1,
          reportOnlyGapClusters: 0,
          reportOnlyByReason: { majorityOrchestration: 0, belowFloorMixed: 0, tooFewProjects: 0 },
          droppedGapSingletons: 0,
          instructionsWithNegatives: 20,
        },
        instructions: Array.from({ length: 20 }, (_, i) => ({
          instruction: `AG-${String(i + 1).padStart(3, "0")}`,
          negative: 4,
          harmSessions: 4,
          sessions: 4,
        })),
      },
    },
  });
  assert.equal(suppressed.proposal.edits.length, 0, "same evidence weight stays rejected");
  assert.deepEqual(suppressed.violations, [], "a suppressed edit is dropped, not a violation");
  assert.equal(suppressed.proposal.stats.instructionsLeftAlone, 19);
  assert.equal(suppressed.proposal.stats.instructionsSuppressed, 1);

  const revived = gate({
    edit,
    annotation: {
      edits: [
        claim(["H1"], {
          kind: "remove",
          title: "drop the stale Node pin",
          evidence: [
            ...QUOTE,
            { polarity: "negative", text: "a third session hit the same pin", source: "pi · ghi · turn 2" },
          ],
          instructions: ["AG-001"],
        }),
      ],
    },
    context: { rejections, isSuppressed: isSuppressedByRejection },
  });
  assert.equal(revived.proposal.edits.length, 1, "materially new evidence revives the edit");
});

test("rejection suppression distinguishes multi-file extraction destinations", () => {
  const sharedSkill = skillFile("setup", "- Keep the existing setup step.\n");
  const files = {
    ".agents/skills/setup-a/SKILL.md": sharedSkill,
    ".agents/skills/setup-b/SKILL.md": sharedSkill,
  };
  const extracted = "- Use Node 18 via nvm before running any script.";
  const extractTo = (destination) => (root) => {
    writeIn(root, "AGENTS.md", (text) => text.replace(extracted, "- See the setup skill."));
    writeIn(root, destination, (text) => `${text}${extracted}\n`);
  };
  const annotation = {
    edits: [claim(["H1", "H2"], { kind: "extract", title: "extract setup" })],
  };

  const first = gate({ files, edit: extractTo(".agents/skills/setup-a/SKILL.md"), annotation });
  assert.deepEqual(first.violations, [], first.violations.join("\n"));
  const rejections = recordRejection(first.proposal.edits[0], { version: 1, entries: {} });

  const sameDestination = gate({
    files,
    edit: extractTo(".agents/skills/setup-a/SKILL.md"),
    annotation,
    context: { rejections, isSuppressed: isSuppressedByRejection },
  });
  assert.equal(sameDestination.proposal.edits.length, 0);

  const otherDestination = gate({
    files,
    edit: extractTo(".agents/skills/setup-b/SKILL.md"),
    annotation,
    context: { rejections, isSuppressed: isSuppressedByRejection },
  });
  assert.deepEqual(otherDestination.violations, [], otherDestination.violations.join("\n"));
  assert.equal(otherDestination.proposal.edits.length, 1, "a different destination is a materially different edit");
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
  // The cap covers the always-loaded surface: the memory file plus the skill's
  // description line, per the one-cap budget model.
  const cap = estimateTokens(MEMORY_TEXT) + estimateTokens("old trigger");
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
  proposal.config.skillsDir = "configured-but-missing";

  const results = applyDecisions({
    proposal,
    decisions: { e1: "rejected", e2: "accepted", e3: "accepted" },
    repo,
    state,
    config: { budgetTokens: cap },
  });

  assert.match(
    results.failed[0].error,
    /accepted edits leave the always-loaded surface \(AGENTS\.md \+ skill descriptions\) .* over the .* budget/,
  );
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

// Runs the real template's own script against a DOM stub small enough to keep the
// assertions textual: the surface is exercised as the browser would build it, not mocked.
function renderTemplateScript(proposal) {
  class Node {
    constructor(text = "") {
      this.textContent = text;
      this.className = "";
      this.children = [];
      this.style = {};
      this.attrs = {};
      this.hidden = false;
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    setAttribute(name, value) {
      this.attrs[name] = value;
    }
    addEventListener() {}
  }
  const nodes = new Map();
  const document = {
    createElement: () => new Node(),
    createTextNode: (text) => new Node(String(text)),
    getElementById: (id) => {
      if (!nodes.has(id)) nodes.set(id, new Node());
      return nodes.get(id);
    },
  };
  const repo = makeRepo();
  const target = renderApplySurface(proposal, new State(repo.root), "0.1.0");
  const html = fs.readFileSync(target, "utf8");
  const window = {};
  window.window = window;
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    vm.runInNewContext(match[1], { window, document });
  }
  const textOf = (node) => node.textContent + node.children.map(textOf).join("");
  return { nodes, textOf };
}

// The funnel band, read back the way it renders: one entry per bar or drop line.
function funnelLines({ nodes, textOf }) {
  return nodes.get("funnel-bars").children.map((row) => {
    if (row.className === "fdrop") return { drop: textOf(row) };
    if (row.className === "fconvert") return { conversion: textOf(row) };
    const [label, track, value] = row.children;
    return {
      label: textOf(label),
      value: textOf(value),
      lanes: track.children.filter((c) => c.className === "a" || c.className === "b").map((c) => c.style.width),
      overScale: track.children.find((c) => c.className === "overscale")?.attrs["data-l"],
      cap: track.children.find((c) => c.className === "capline")?.style.left,
    };
  });
}

test("the apply surface separates memory, description, and on-trigger deltas", () => {
  const proposal = {
    generatedAt: "2026-08-01T00:00:00.000Z",
    repo: { name: "demo" },
    memoryFile: { path: "AGENTS.md" },
    stats: { harnessCounts: {}, transcripts: 2, positive: 0, negative: 0, gapClusters: 0, skillExtractions: 1 },
    config: { maxEditsPerRun: 5, minGapEvidence: 2 },
    budget: { current: 100, projected: 82, capTokens: 200, descriptionTokens: 0, mode: "cap" },
    edits: [
      {
        id: "e1",
        kind: "extract",
        title: "extract setup",
        file: "AGENTS.md",
        targetsMemoryFile: true,
        deltaTokens: -20,
        descriptionDelta: 5,
        hunks: [
          { file: "AGENTS.md", lines: [{ type: "del", text: "- setup details" }] },
          {
            file: ".agents/skills/setup/SKILL.md",
            lines: [{ type: "ins", text: "- setup details" }],
          },
        ],
        skills: [],
        evidence: [],
      },
      {
        id: "e2",
        kind: "rewrite",
        title: "tighten trigger",
        file: ".agents/skills/db/SKILL.md",
        targetsMemoryFile: false,
        deltaTokens: -3,
        descriptionDelta: -2,
        hunks: [],
        evidence: [],
      },
    ],
  };
  const { nodes, textOf } = renderTemplateScript(proposal);

  const cards = nodes.get("edits").children;
  assert.match(textOf(cards[0]), /Δ memory -20 tok/);
  assert.match(textOf(cards[0]), /Δ description \(always-loaded\) \+5 tok/);
  assert.match(textOf(cards[0]), /files: AGENTS\.md, \.agents\/skills\/setup\/SKILL\.md/);
  const fileBoundaries = (function collect(node) {
    return [node, ...node.children.flatMap(collect)];
  })(cards[0])
    .filter((node) => node.className === "file")
    .map((node) => node.textContent);
  assert.deepEqual(fileBoundaries, ["--- AGENTS.md ---", "--- .agents/skills/setup/SKILL.md ---"]);
  assert.match(textOf(cards[1]), /Δ on trigger -1 tok/);
  assert.match(textOf(cards[1]), /Δ description \(always-loaded\) -2 tok/);
  assert.match(textOf(cards[1]), /file: \.agents\/skills\/db\/SKILL\.md/);
  assert.equal(nodes.get("gauge-title").textContent, "Always-loaded budget · AGENTS.md + skill descriptions");
});

test("the apply surface draws one funnel from findings to the edits it proposed", () => {
  const rewrite = (id, removed = 1) => ({
    id,
    kind: "rewrite",
    file: "AGENTS.md",
    targetsMemoryFile: true,
    hunks: [{ removed, added: 1 }],
    evidence: [],
  });
  const proposal = {
    generatedAt: "2026-09-02T00:00:00.000Z",
    repo: { name: "user" },
    memoryFile: { path: ".claude/CLAUDE.md" },
    stats: {
      harnessCounts: {},
      transcripts: 82,
      positive: 70,
      negative: 27,
      gapSightings: 36,
      gapClusters: 1,
      reportOnlyGapClusters: 1,
      reportOnlyByReason: { majorityOrchestration: 1, belowFloorMixed: 0, tooFewProjects: 0 },
      droppedGapSingletons: 32,
      instructionsWithNegatives: 7,
      instructionsLeftAlone: 2,
      leftAloneMaxSessions: 1,
      instructionsSuppressed: 1,
      skillExtractions: 0,
    },
    config: { maxEditsPerRun: 5, minGapEvidence: 2 },
    budget: { current: 4049, projected: 4117, capTokens: 5000, descriptionTokens: 0, mode: "cap" },
    edits: [rewrite("e1"), rewrite("e2"), rewrite("e3"), rewrite("e4", 0)],
  };
  const rendered = renderTemplateScript(proposal);

  const lines = funnelLines(rendered);
  assert.deepEqual(
    lines.map((l) => l.drop ?? l.conversion ?? `${l.label} ${l.value}`),
    [
      "findings 133",
      "70 dropped - the instruction was followed: nothing to fix",
      "22 dropped - duplicates: the same instruction or the same mistake, reported more than once",
      "candidates 41",
      "32 dropped - seen only once: a second session has to confirm them (kept for later runs)",
      "1 dropped - not this project's fault: the tooling that ran the session caused it",
      "sent to synthesis 8",
      "2 dropped - no accepted edit named these candidates",
      "1 dropped - a previous review rejected the same edit",
      "counting changes here: 5 candidates · 4 proposed edits",
      "edits proposed 4 of 5",
    ],
    "the many-to-many synthesis boundary names the unit conversion instead of implying candidates equal edits",
  );
  assert.ok(
    !lines.some((l) => (l.drop || "").includes("too few projects")),
    "a drop line that dropped nothing is never drawn",
  );

  // Every bar shares one scale (findings = 100%) so a lane can be followed down the
  // band, and each bar splits into existing-instruction then missing-instruction.
  const share = (n) => `${(n / 133) * 100}%`;
  assert.deepEqual(
    lines.filter((l) => l.label).map((l) => l.lanes),
    [
      [share(97), share(36)],
      [share(7), share(34)],
      [share(7), share(1)],
      [share(3), share(1)],
    ],
  );
  assert.equal(lines.at(-1).cap, share(5), "the cap tick sits on the same scale as the bar it crosses");

  assert.equal(
    rendered.textOf(rendered.nodes.get("funnel-facts")),
    "82 transcripts · corroboration floor · 2 sessions · cap · 5 edits",
  );
  assert.equal(rendered.nodes.get("ctx").hidden, false, "the band frame is revealed");
  assert.ok(!rendered.nodes.has("statrow"), "the band replaces the classic stat row rather than joining it");

  const projectCovered = renderTemplateScript({ ...proposal, scope: "user" });
  assert.ok(
    funnelLines(projectCovered).some(
      (line) =>
        line.drop ===
        "32 dropped - fewer than 2 sessions count toward corroboration: 2 qualifying sessions are required (kept for later runs)",
    ),
  );

  const higherFloor = renderTemplateScript({
    ...proposal,
    config: { ...proposal.config, minGapEvidence: 3 },
  });
  assert.ok(
    funnelLines(higherFloor).some(
      (line) =>
        line.drop ===
        "32 dropped - seen in fewer than 3 sessions: 3 sessions have to confirm them (kept for later runs)",
    ),
  );

  const projectFloor = (minGapProjects) =>
    renderTemplateScript({
      ...proposal,
      config: { ...proposal.config, minGapProjects },
      stats: {
        ...proposal.stats,
        reportOnlyByReason: { majorityOrchestration: 0, belowFloorMixed: 0, tooFewProjects: 1 },
      },
    });
  assert.ok(
    funnelLines(projectFloor(2)).some(
      (line) =>
        line.drop === "1 dropped - seen in too few projects: the same mistake has to show up in another project",
    ),
  );
  assert.ok(
    funnelLines(projectFloor(3)).some(
      (line) => line.drop === "1 dropped - seen in too few projects: the same mistake has to show up in 3 projects",
    ),
  );

  const overScale = renderTemplateScript({
    ...proposal,
    stats: {
      ...proposal.stats,
      positive: 0,
      negative: 1,
      gapSightings: 0,
      gapClusters: 0,
      reportOnlyGapClusters: 0,
      reportOnlyByReason: { majorityOrchestration: 0, belowFloorMixed: 0, tooFewProjects: 0 },
      droppedGapSingletons: 0,
      instructionsWithNegatives: 1,
      instructionsLeftAlone: 0,
      instructionsSuppressed: 0,
    },
    edits: [rewrite("e1"), rewrite("e2", 0)],
  });
  const overScaleLines = funnelLines(overScale);
  const findingsLine = overScaleLines.find((line) => line.label === "findings");
  const proposedLine = overScaleLines.find((line) => line.label === "edits proposed");
  assert.deepEqual(proposedLine.lanes, ["50%", "50%"], "the clamped bar preserves its lane split");
  assert.equal(proposedLine.overScale, "1 over scale", "the clamped bar is visibly marked");
  assert.equal(findingsLine.overScale, undefined, "an ordinary 100% bar has no over-scale marker");
  assert.ok(
    overScaleLines.some((line) => line.conversion === "counting changes here: 1 candidate · 2 proposed edits"),
    "several edits from one candidate are an explicit unit conversion, not an unexplained gain",
  );

  const offScaleCap = renderTemplateScript({
    ...proposal,
    stats: {
      ...proposal.stats,
      positive: 0,
      negative: 1,
      gapSightings: 0,
      gapClusters: 0,
      reportOnlyGapClusters: 0,
      reportOnlyByReason: { majorityOrchestration: 0, belowFloorMixed: 0, tooFewProjects: 0 },
      droppedGapSingletons: 0,
      instructionsWithNegatives: 1,
      instructionsLeftAlone: 0,
      instructionsSuppressed: 0,
    },
    edits: [rewrite("e1")],
  });
  const offScaleLines = funnelLines(offScaleCap);
  assert.equal(offScaleLines.at(-1).cap, undefined, "an off-scale cap tick is hidden");
  assert.ok(
    offScaleLines.some((line) => line.conversion === "counting changes here: 1 candidate · 1 proposed edit"),
    "equal numbers still name the change from candidate units to edit units",
  );

  const noCandidate = renderTemplateScript({
    ...proposal,
    stats: {
      ...proposal.stats,
      positive: 0,
      negative: 0,
      gapSightings: 0,
      gapClusters: 0,
      reportOnlyGapClusters: 0,
      reportOnlyByReason: { majorityOrchestration: 0, belowFloorMixed: 0, tooFewProjects: 0 },
      droppedGapSingletons: 0,
      instructionsWithNegatives: 0,
      instructionsLeftAlone: 0,
      instructionsSuppressed: 0,
    },
    edits: [rewrite("e1")],
  });
  assert.ok(
    funnelLines(noCandidate).some(
      (line) => line.conversion === "counting changes here: 0 candidates · 1 proposed edit",
    ),
    "an edit with no candidate attribution is visible instead of appearing as an unexplained gain",
  );
});

test("a proposal saved before the funnel counts existed falls back to the classic stat row", () => {
  const legacy = {
    generatedAt: "2026-08-01T00:00:00.000Z",
    repo: { name: "demo" },
    memoryFile: { path: "AGENTS.md" },
    // Recorded when only the gap funnel existed: no lane counts, so no band.
    stats: { harnessCounts: {}, transcripts: 9, positive: 4, negative: 2, gapClusters: 1, skillExtractions: 0 },
    config: { maxEditsPerRun: 5, minGapEvidence: 2 },
    budget: { current: 10, projected: 12, capTokens: 100, descriptionTokens: 0, mode: "cap" },
    edits: [],
  };
  const rendered = renderTemplateScript(legacy);

  assert.ok(!rendered.nodes.has("funnel-bars"), "no band is drawn without the counts it needs");
  assert.ok(!rendered.nodes.has("ctx"), "the band frame stays hidden as the markup shipped it");
  assert.equal(rendered.nodes.get("statrow").hidden, false);
  assert.equal(rendered.nodes.get("statrow").children.length, 5);
  assert.match(rendered.textOf(rendered.nodes.get("statrow")), /positive evidence/);
});

test("terminal review labels every file in a multi-file extraction", () => {
  const output = renderEdit(
    {
      kind: "extract",
      title: "extract setup",
      file: "AGENTS.md",
      targetsMemoryFile: true,
      hunks: [
        { file: "AGENTS.md", lines: [{ type: "del", text: "- setup details" }] },
        {
          file: ".agents/skills/setup/SKILL.md",
          lines: [{ type: "ins", text: "- setup details" }],
        },
      ],
      skills: [],
    },
    0,
    1,
  );

  assert.match(output, /files: AGENTS\.md, \.agents\/skills\/setup\/SKILL\.md/);
  assert.match(output, /--- AGENTS\.md ---/);
  assert.match(output, /--- \.agents\/skills\/setup\/SKILL\.md ---/);
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

test("sentence-level harm clears removal of its oversized parent paragraph", () => {
  const blob = Array.from(
    { length: 5 },
    (_, i) =>
      `Sentence ${i + 1} states an independent requirement about builds, releases, adapters, and review that an agent must follow.`,
  ).join(" ");
  const text = `# T\n\n${blob}\n\n- Keep this instruction.\n`;
  const evidence = (id, negative) => ({
    status: "ok",
    transcript: { id, harness: "claude" },
    positive: [],
    negative,
    gaps: [],
  });
  const summary = foldEvidence(
    [
      evidence("s1", [
        { instruction: "AG-001.2", quote: "following sentence two broke the build", class: "harm" },
        { instruction: "AG-001.3", quote: "sentence three caused the same failure", class: "harm" },
      ]),
      evidence("s2", [{ instruction: "AG-001.2", quote: "the rule broke release signing", class: "harm" }]),
    ],
    { memoryFile: { units: parseMemoryUnits(text) } },
  );
  assert.equal(summary.parentHarmSessions["AG-001"], 2, "the same session is counted once across sentence parts");

  const result = gate({
    text,
    edit: memoryEdit((current) => current.replace(`${blob}\n\n`, "")),
    annotation: {
      edits: [
        claim(["H1"], {
          kind: "remove",
          title: "remove the harmful paragraph",
          evidence: summary.sources.map((source, i) => ({
            polarity: "negative",
            text: `harm quote ${i}`,
            source,
          })),
        }),
      ],
    },
    context: { summary },
  });
  assert.deepEqual(result.violations, []);
  assert.equal(result.proposal.edits.length, 1);
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
    violations.some((v) => /removes text its skill\(s\) do not carry/.test(v) && /separate "remove" edit/.test(v)),
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

test("a pure deletion inside a skill file is a removal with no possible evidence: refused", () => {
  const skill =
    "---\nname: db\ndescription: Load before touching the database.\n---\n\n- Always run migrations in a transaction.\n- Never drop a column without a backfill plan.\n";
  const { violations } = gate({
    files: { ".agents/skills/db/SKILL.md": skill },
    edit: (root) =>
      writeIn(root, ".agents/skills/db/SKILL.md", (t) =>
        t.replace("- Never drop a column without a backfill plan.\n", ""),
      ),
    annotation: {
      edits: [claim(["H1"], { kind: "remove", title: "drop the backfill rule", transcripts: 9 })],
    },
  });
  assert.ok(
    violations.some((v) =>
      /deletes "- Never drop a column without a backfill plan\." from \.agents\/skills\/db\/SKILL\.md/.test(v),
    ),
    `expected the skill-deletion floor, got ${JSON.stringify(violations)}`,
  );
  assert.ok(violations.some((v) => /no evidence can attribute to skill files/.test(v)));
});

test("description bloat with an unchanged memory file trips the always-loaded cap", () => {
  const skill = "---\nname: db\ndescription: old trigger\n---\n\nbody\n";
  const bloated = "Load this skill ".repeat(40).trim(); // ~160 tok of description
  const cap = estimateTokens(MEMORY_TEXT) + estimateTokens("old trigger") + 20;
  const { violations } = gate({
    files: { ".agents/skills/db/SKILL.md": skill },
    edit: (root) => writeIn(root, ".agents/skills/db/SKILL.md", (t) => t.replace("old trigger", bloated)),
    annotation: { edits: [claim(["H1"], { title: "inflate the trigger" })] },
    config: config({ budgetTokens: cap }),
  });
  assert.ok(
    violations.some((v) => /always-loaded surface \(AGENTS\.md \+ skill descriptions\)/.test(v) && /over the/.test(v)),
    `expected the surface cap violation, got ${JSON.stringify(violations)}`,
  );
});

test("apply measures a legacy skill rewrite missing descriptionDelta", () => {
  const skill = "---\nname: db\ndescription: \n---\n\nbody\n";
  const built = gate({
    files: { ".agents/skills/db/SKILL.md": skill },
    edit: (root) =>
      writeIn(root, ".agents/skills/db/SKILL.md", (text) =>
        text.replace("description: \n", "description: Load before touching the database.\n"),
      ),
    annotation: { edits: [claim(["H1"], { title: "add the trigger" })] },
  });
  assert.deepEqual(built.violations, []);
  delete built.proposal.edits[0].descriptionDelta;

  const results = applyDecisions({
    proposal: built.proposal,
    decisions: { e1: "accepted" },
    repo: built.repo,
    state: built.state,
    config: { budgetTokens: estimateTokens(MEMORY_TEXT) },
  });
  assert.match(results.failed[0].error, /always-loaded surface \(AGENTS\.md \+ skill descriptions\)/);
  assert.equal(fs.readFileSync(path.join(built.repo.root, ".agents/skills/db/SKILL.md"), "utf8"), skill);
});

test("post-apply warnings label a newly created skill description as always-loaded", () => {
  const skillText =
    "---\nname: release-signing\ndescription: Release.\n---\n\n- Use Node 18 via nvm before running any script.\n";
  const built = gate({
    edit: (root) => {
      writeIn(root, "AGENTS.md", (text) =>
        text.replace("- Use Node 18 via nvm before running any script.", "- Use the release skill."),
      );
      writeIn(root, ".agents/skills/release-signing/SKILL.md", skillText);
    },
    annotation: { edits: [claim(["H1", "H2"], { kind: "extract", title: "extract release setup" })] },
  });
  assert.deepEqual(built.violations, []);
  assert.ok(built.proposal.budget.delta < 0);
  delete built.proposal.edits[0].descriptionDelta;

  const results = applyDecisions({
    proposal: built.proposal,
    decisions: { e1: "accepted" },
    repo: built.repo,
    state: built.state,
    config: { budgetTokens: built.proposal.budget.projected - 1 },
    dryRun: true,
  });
  assert.deepEqual(results.failed, []);
  assert.match(results.warnings[0], /always-loaded surface \(AGENTS\.md \+ skill descriptions\)/);
});

test("a skill-only shrink reports the remaining always-loaded overage", () => {
  const oldDescription = "trigger ".repeat(60).trim();
  const newDescription = "trigger ".repeat(50).trim();
  const skill = `---\nname: db\ndescription: ${oldDescription}\n---\n\nbody\n`;
  const built = gate({
    files: { ".agents/skills/db/SKILL.md": skill },
    edit: (root) => writeIn(root, ".agents/skills/db/SKILL.md", (text) => text.replace(oldDescription, newDescription)),
    annotation: { edits: [claim(["H1"], { title: "trim the trigger" })] },
    config: config({ budgetTokens: 100 }),
  });
  assert.deepEqual(built.violations, []);

  const results = applyDecisions({
    proposal: built.proposal,
    decisions: { e1: "accepted" },
    repo: built.repo,
    state: built.state,
    config: { budgetTokens: 100 },
    dryRun: true,
  });
  assert.deepEqual(results.failed, []);
  assert.equal(results.written.length, 1);
  assert.equal(results.written[0].file, ".agents/skills/db/SKILL.md");
  assert.ok(results.written[0].budget.delta < 0);
  assert.ok(results.written[0].budget.projected > 100);
  assert.match(results.warnings[0], /always-loaded surface \(AGENTS\.md \+ skill descriptions\)/);
});

test("a skill file that changed after the proposal refuses the apply; unchanged, the edit lands", () => {
  const skill = "---\nname: db\ndescription: old trigger\n---\n\nbody\n";
  const build = () =>
    gate({
      files: { ".agents/skills/db/SKILL.md": skill },
      edit: (root) =>
        writeIn(root, ".agents/skills/db/SKILL.md", (t) =>
          t.replace("old trigger", "Load before touching the database."),
        ),
      annotation: { edits: [claim(["H1"], { title: "fix the trigger" })] },
    });

  // Concurrent skill edit between propose and apply: the file no longer matches the
  // image the hunks were cut from, so nothing anywhere is written.
  const stale = build();
  assert.deepEqual(stale.violations, []);
  const skillOnDisk = path.join(stale.repo.root, ".agents/skills/db/SKILL.md");
  const concurrent = skill.replace("body", "body, hand-edited meanwhile");
  fs.writeFileSync(skillOnDisk, concurrent);
  const refused = applyDecisions({
    proposal: stale.proposal,
    decisions: { e1: "accepted" },
    repo: stale.repo,
    state: stale.state,
    config: { budgetTokens: 5000 },
  });
  assert.match(refused.failed[0].error, /\.agents\/skills\/db\/SKILL\.md changed after this proposal was made/);
  assert.deepEqual(refused.written, []);
  assert.equal(fs.readFileSync(skillOnDisk, "utf8"), concurrent, "the concurrent version is kept");
  assert.equal(refused.rejectionsRecorded, false);

  const staleRejection = build();
  const rejectedSkill = path.join(staleRejection.repo.root, ".agents/skills/db/SKILL.md");
  fs.writeFileSync(rejectedSkill, concurrent);
  const rejected = applyDecisions({
    proposal: staleRejection.proposal,
    decisions: { e1: "rejected" },
    repo: staleRejection.repo,
    state: staleRejection.state,
    config: { budgetTokens: 5000 },
  });
  assert.match(rejected.failed[0].error, /\.agents\/skills\/db\/SKILL\.md changed after this proposal was made/);
  assert.equal(rejected.rejectionsRecorded, false);
  assert.equal(Object.keys(staleRejection.state.readRejections().entries).length, 0);

  // Untouched, the same edit applies and the description lands on disk.
  const fresh = build();
  const applied = applyDecisions({
    proposal: fresh.proposal,
    decisions: { e1: "accepted" },
    repo: fresh.repo,
    state: fresh.state,
    config: { budgetTokens: 5000 },
  });
  assert.deepEqual(applied.failed, []);
  assert.match(
    fs.readFileSync(path.join(fresh.repo.root, ".agents/skills/db/SKILL.md"), "utf8"),
    /description: Load before touching the database\./,
  );
});
