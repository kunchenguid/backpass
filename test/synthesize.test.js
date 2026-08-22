import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * End-to-end synthesis against a stand-in acpx that behaves like a harness with native
 * file tools: on the editing turn it changes `<cwd>/AGENTS.md` (and only when writes
 * are approved), on each annotate turn it answers with scripted JSON - optionally
 * editing again first, as a real agent may. Every invocation is logged so the tests can
 * assert the session lifecycle and the permission flags backpass passed.
 */
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-fake-synth-"));
const fakeAcpx = path.join(fakeDir, "acpx");
fs.writeFileSync(
  fakeAcpx,
  `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_ACPX_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
const script = JSON.parse(fs.readFileSync(process.env.FAKE_ACPX_SCRIPT, "utf8"));
const cwdAt = argv.indexOf("--cwd");
const cwd = cwdAt >= 0 ? argv[cwdAt + 1] : process.cwd();
if (argv.includes("sessions")) {
  if (argv.includes("new")) process.stdout.write("fake-session-id\\n");
  process.exit(0);
}
if (argv.includes("set")) process.exit(0);
const fileAt = argv.indexOf("--file");
if (fileAt < 0) process.exit(2);
const prompt = fs.readFileSync(argv[fileAt + 1], "utf8");
const statePath = process.env.FAKE_ACPX_STATE;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { annotate: 0 };
function applyEdits(edits) {
  for (const [file, change] of Object.entries(edits || {})) {
    const target = path.isAbsolute(file) ? file : path.join(cwd, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (typeof change === "string") { fs.writeFileSync(target, change); continue; }
    if (change === null) { fs.rmSync(target, { recursive: true, force: true }); continue; }
    let text = fs.readFileSync(target, "utf8");
    for (const [from, to] of change.replace) {
      if (!text.includes(from)) throw new Error("fake harness: cannot find " + JSON.stringify(from));
      text = text.replace(from, to);
    }
    fs.writeFileSync(target, text);
  }
}
if (!prompt.includes("## Measured changes")) {
  if (!argv.includes("--approve-all")) {
    process.stdout.write("I could not edit the file: write permission was denied.\\n");
    process.exit(0);
  }
  applyEdits(script.edit);
  process.stdout.write("Edited the staging copy.\\n");
  process.stderr.write("[acpx] tokens: input=1000 output=20 total=1020\\n");
} else {
  const step = script.annotations[Math.min(state.annotate, script.annotations.length - 1)];
  state.annotate += 1;
  if (step.editFirst) applyEdits(step.editFirst);
  process.stdout.write(typeof step.reply === "string" ? step.reply : JSON.stringify(step.reply) + "\\n");
  process.stderr.write("[acpx] tokens: input=500 output=30 total=530\\n");
}
fs.writeFileSync(statePath, JSON.stringify(state));
`,
);
fs.chmodSync(fakeAcpx, 0o755);
process.env.BACKPASS_ACPX_BIN = fakeAcpx;

const { synthesizeProposal, ANNOTATE_TURNS } = await import("../src/synthesize.js");
const { applyDecisions } = await import("../src/apply/writer.js");
const { loadConfig } = await import("../src/config.js");
const { readMemoryFile } = await import("../src/memory.js");
const { ProposalViolation } = await import("../src/proposal.js");
const { State } = await import("../src/state.js");
const { UserError, setLoggerSink } = await import("../src/logger.js");
const { makeRepo } = await import("./helpers/staging.js");

setLoggerSink(() => {});

const AGENTS = [
  "# Memory",
  "",
  "## Sharp edges",
  "",
  "- Transcript formats drift; adapters are pinned by golden fixtures.",
  "- The live progress view is an enhancement layer, never a dependency.",
  "- Only src/apply/writer.js writes to the repo.",
  "- Skills only count if a harness loads them.",
  "",
  "## Style",
  "",
  "- Keep this file short.",
  "",
].join("\n");

const TWO_ITEMS =
  "- Transcript formats drift; adapters are pinned by golden fixtures.\n- The live progress view is an enhancement layer, never a dependency.\n";
const QUOTE = {
  polarity: "negative",
  text: "the agent re-read the adapter fixture instead",
  source: "claude · s1 · turn 4",
};
const removal = (changes) => ({
  changes,
  kind: "remove",
  title: "drop two sharp edges nobody hits",
  evidence: [QUOTE],
  transcripts: 3,
});
const tighten = (changes) => ({
  changes,
  kind: "rewrite",
  title: "sharpen the brevity rule",
  evidence: [QUOTE],
  transcripts: 2,
});

function summaryFor(sessions = 3) {
  return {
    analyzedSessions: sessions,
    instructions: [],
    gaps: [],
    totals: { positive: 1, negative: 2, gapClusters: 0, droppedGapSingletons: 0 },
  };
}

/** A pinned synthesis candidate; the ladder walk is covered in agents.test.js. */
const pick = { agent: "claude", model: "claude-opus-5", effort: "high", pinned: true };
const agents = { resolve: async () => pick, withFallthrough: async (_role, fn) => fn(pick) };

function setup(script, { text = AGENTS, overrides = {} } = {}) {
  const repo = makeRepo({ "AGENTS.md": text });
  const config = loadConfig(repo.root, overrides);
  config.state = new State(repo.root).ensure();
  config.agents = agents;
  const log = path.join(fakeDir, `log-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  fs.writeFileSync(log, "");
  process.env.FAKE_ACPX_LOG = log;
  process.env.FAKE_ACPX_SCRIPT = path.join(repo.root, "fake-script.json");
  process.env.FAKE_ACPX_STATE = path.join(repo.root, "fake-state.json");
  fs.writeFileSync(process.env.FAKE_ACPX_SCRIPT, JSON.stringify(script));
  const memoryFile = readMemoryFile(repo.root, "AGENTS.md");
  const run = () =>
    synthesizeProposal({ memoryFile, summary: summaryFor(), config, repo, transcripts: [{ harness: "claude" }] });
  const calls = () =>
    fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { repo, config, memoryFile, run, calls };
}

test("synthesis edits the staging copy natively; measured hunks anchor to the raw file and nothing touches the repo until apply", async () => {
  const { repo, config, run, calls } = setup({
    edit: {
      "AGENTS.md": {
        replace: [
          [TWO_ITEMS, ""],
          ["- Keep this file short.", "- Keep this file short; point at files instead of copying them."],
        ],
      },
    },
    annotations: [{ reply: { edits: [removal(["H1"]), tighten(["H2"])], verdicts: [], notes: ["one note"] } }],
  });

  const { proposal, violations } = await run();
  assert.deepEqual(violations, []);
  assert.equal(proposal.edits.length, 2);
  assert.deepEqual(
    proposal.edits.map((e) => [e.id, e.kind, e.hunks.map((h) => h.id)]),
    [
      ["e1", "remove", ["H1"]],
      ["e2", "rewrite", ["H2"]],
    ],
  );
  for (const edit of proposal.edits) {
    for (const hunk of edit.hunks) {
      assert.equal(AGENTS.split(hunk.find).length, 2, `${hunk.id}: find occurs exactly once in the raw file`);
    }
  }
  assert.ok(proposal.edits[0].deltaTokens < 0);
  assert.ok(proposal.budget.delta < 0);
  assert.deepEqual(proposal.notes, ["one note"]);
  assert.equal(proposal.usage.length, 2, "one usage record per turn");

  // The repo is untouched: the staging copy under .backpass/ is where the agent wrote.
  assert.equal(fs.readFileSync(path.join(repo.root, "AGENTS.md"), "utf8"), AGENTS);
  const staged = fs.readFileSync(path.join(repo.root, ".backpass", "synthesis", "AGENTS.md"), "utf8");
  assert.ok(!staged.includes("Transcript formats drift"));

  // Session lifecycle: new -> set model -> set effort -> edit turn -> annotate turn -> close,
  // every turn in the staging workspace with writes approved, never --deny-all.
  const invocations = calls();
  const workspace = path.join(repo.root, ".backpass", "synthesis");
  assert.deepEqual(
    invocations.map((c) =>
      c.argv
        .filter((a) =>
          [
            "sessions",
            "new",
            "close",
            "set",
            "model",
            "effort",
            "--file",
            "--approve-all",
            "--deny-all",
            "--approve-reads",
          ].includes(a),
        )
        .join(" "),
    ),
    ["sessions new", "set model", "set effort", "--approve-all --file", "--approve-all --file", "sessions close"],
  );
  for (const turn of invocations.filter((c) => c.argv.includes("--file"))) {
    assert.equal(turn.argv[turn.argv.indexOf("--cwd") + 1], workspace);
    assert.equal(turn.cwd, workspace);
  }
  const editPrompt = fs.readFileSync(path.join(repo.root, ".backpass", "prompts", "synthesis-edit.md"), "utf8");
  assert.match(editPrompt, /^<!-- backpass:self-session -->/);
  assert.ok(editPrompt.includes(`The repository itself is at \`${repo.root}\``));
  assert.ok(editPrompt.includes("[AG-001] ("), "the index stays as the lookup table");
  const annotatePrompt = fs.readFileSync(
    path.join(repo.root, ".backpass", "prompts", "synthesis-annotate-1.md"),
    "utf8",
  );
  assert.match(annotatePrompt, /^<!-- backpass:self-session -->/);
  assert.ok(annotatePrompt.includes("[H1: AGENTS.md lines 5-6 (-2/+0) · AG-001, AG-002]"));
  assert.ok(annotatePrompt.includes("- - The live progress view is an enhancement layer, never a dependency."));
  assert.ok(annotatePrompt.includes("[H2: AGENTS.md line 12 (-1/+1) · AG-005]"));

  // The human gate is unchanged: accept one, reject one, the writer applies the raw-file hunks.
  const results = applyDecisions({
    proposal,
    decisions: { e1: "accepted", e2: "rejected" },
    repo,
    state: config.state,
    config,
  });
  assert.equal(results.failed.length, 0);
  assert.equal(fs.readFileSync(path.join(repo.root, "AGENTS.md"), "utf8"), AGENTS.replace(TWO_ITEMS, ""));
});

test("a violated annotation is re-prompted with the exact breach, and the corrected answer passes", async () => {
  const { repo, run } = setup({
    edit: {
      "AGENTS.md": {
        replace: [
          [TWO_ITEMS, ""],
          ["- Keep this file short.", "- Keep it short."],
        ],
      },
    },
    annotations: [{ reply: { edits: [removal(["H1"])] } }, { reply: { edits: [removal(["H1"]), tighten(["H2"])] } }],
  });
  const { proposal, violations } = await run();
  assert.deepEqual(violations, []);
  assert.equal(proposal.edits.length, 2);
  const second = fs.readFileSync(path.join(repo.root, ".backpass", "prompts", "synthesis-annotate-2.md"), "utf8");
  assert.ok(second.includes("## Your previous answer was rejected"));
  assert.ok(second.includes("- H2: AGENTS.md line 12 (-1/+1) is not part of any edit"));
});

test("an agent that keeps editing during an annotate turn is shown the re-measured changes", async () => {
  const { repo, run } = setup({
    edit: { "AGENTS.md": { replace: [[TWO_ITEMS, ""]] } },
    annotations: [
      {
        editFirst: { "AGENTS.md": { replace: [["- Keep this file short.", "- Keep it short."]] } },
        reply: { edits: [removal(["H1"])] },
      },
      { reply: { edits: [removal(["H1"]), tighten(["H2"])] } },
    ],
  });
  const { proposal, violations } = await run();
  assert.deepEqual(violations, []);
  assert.equal(proposal.edits.length, 2);
  const second = fs.readFileSync(path.join(repo.root, ".backpass", "prompts", "synthesis-annotate-2.md"), "utf8");
  assert.ok(second.includes("the files changed after the changes were measured"));
  assert.ok(second.includes("[H2: AGENTS.md line 12 (-1/+1)"));
});

test("the budget gate is measured on the staged file: growth on an over-budget file is refused until the agent trims", async () => {
  const padded = `${AGENTS}\n${"padding text that keeps the file over budget. ".repeat(120)}\n`;
  const { run } = setup(
    {
      edit: {
        "AGENTS.md": { replace: [["## Style\n\n", "## Style\n\n- A brand new rule with three sessions behind it.\n"]] },
      },
      annotations: [
        // Attempt 1: the addition alone grows an over-budget file - refused.
        { reply: { edits: [{ ...tighten(["H1"]), kind: "add", transcripts: 3 }] } },
        // Attempt 2: the agent trims first; its answer is stale and discarded.
        { editFirst: { "AGENTS.md": { replace: [[TWO_ITEMS, ""]] } }, reply: { edits: [] } },
        // Attempt 3: annotates the re-measured changes - the removal pays for the addition.
        { reply: { edits: [removal(["H1"]), { ...tighten(["H2"]), kind: "add", transcripts: 3 }] } },
      ],
    },
    { text: padded, overrides: { budgetTokens: 200 } },
  );
  const { proposal, violations } = await run();
  assert.deepEqual(violations, []);
  assert.equal(proposal.budget.mode, "shrink");
  assert.ok(proposal.budget.delta < 0, "the accepted set is net-negative");
  assert.ok(proposal.usage.length >= 3, "the re-prompt turn is accounted");
});

test("when every re-prompt fails the gates, synthesis fails loudly and keeps the rejected proposal", async () => {
  const { config, run } = setup({
    edit: { "AGENTS.md": { replace: [[TWO_ITEMS, ""]] } },
    annotations: [{ reply: { edits: [{ ...removal(["H1"]), evidence: [] }] } }],
  });
  await assert.rejects(run(), (err) => {
    assert.ok(err instanceof ProposalViolation);
    assert.match(err.message, new RegExp(`after ${ANNOTATE_TURNS - 1} re-prompt`));
    assert.ok(err.violations.some((v) => /carries no verbatim evidence quote/.test(v)));
    return true;
  });
  const saved = config.state.readProposal();
  assert.ok(saved.violations.length, "the rejected proposal is inspectable");
  assert.equal(saved.edits.length, 0);
});

test("a harness that writes to the repository instead of the staging copy is refused, loudly", async () => {
  const { repo, run } = setup({ edit: {} });
  // The fake writes by absolute path when told to - the misbehaving case.
  fs.writeFileSync(
    process.env.FAKE_ACPX_SCRIPT,
    JSON.stringify({
      edit: { [path.join(repo.root, "AGENTS.md")]: { replace: [[TWO_ITEMS, ""]] } },
      annotations: [{ reply: { edits: [] } }],
    }),
  );
  await assert.rejects(run(), (err) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /synthesis changed AGENTS\.md in the repository directly/);
    return true;
  });
});

test("an agent that changes nothing yields an empty proposal, never an invented edit", async () => {
  const { run } = setup({ edit: {}, annotations: [{ reply: { edits: [], notes: ["the evidence is too thin"] } }] });
  const { proposal, violations } = await run();
  assert.deepEqual(violations, []);
  assert.equal(proposal.edits.length, 0);
  assert.equal(proposal.budget.delta, 0);
});
