import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A stand-in acpx that reproduces what each harness really leaves behind for backpass
 * to account from. codex answers and prints the per-run `[acpx] tokens:` line on
 * stderr, exactly as the real `--format quiet` does when the ACP adapter returns
 * usage. pi answers and prints no line at all (pi-acp returns a bare `{ stopReason }`),
 * but - like the real pi - files the session under `~/.pi/agent/sessions/<escaped-cwd>/`
 * with the prompt as its first user message and per-turn `usage` on every assistant
 * turn. The usage numbers live only in that file; backpass has to go and read them.
 */
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-usage-home-"));
process.env.HOME = fakeHome;

const fakeAcpxDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-fake-acpx-"));
const fakeAcpx = path.join(fakeAcpxDir, "acpx");
const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-usage-cwd-")));
const piSessionDir = path.join(fakeHome, ".pi", "agent", "sessions", `-${workDir.replace(/\//g, "-")}--`);

/** The per-turn usage the fake pi writes; shape copied from a real pi 0.82 session. */
const PI_TURNS = [
  { input: 9608, output: 158, cacheRead: 0, cacheWrite: 0, reasoning: 106, totalTokens: 9766 },
  { input: 1170, output: 50, cacheRead: 8704, cacheWrite: 0, reasoning: 13, totalTokens: 9924 },
];

fs.writeFileSync(
  fakeAcpx,
  `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const agent = argv.find((a) => a === "codex" || a === "pi");
// Session management calls (new / set / close) succeed silently, as acpx's do.
if (argv.includes("sessions") || argv.includes("set")) process.exit(0);
const cwd = argv[argv.indexOf("--cwd") + 1];
const promptFile = argv[argv.indexOf("--file") + 1];
process.stdout.write('{"ok":true}\\n');
if (agent === "codex") {
  process.stderr.write("[acpx] tokens: input=14585 output=5 cache_read=11008 total=25598\\n");
} else if (agent === "pi" && process.env.FAKE_PI_SESSION_FILE) {
  // A follow-up turn in a named session: pi appends to the session's own file.
  const file = process.env.FAKE_PI_SESSION_FILE;
  const usage = { input: 300, output: 40, cacheRead: 9000, cacheWrite: 0, reasoning: 20, totalTokens: 9360 };
  fs.appendFileSync(file, JSON.stringify({
    type: "message", id: "turn-followup-" + Date.now(), parentId: "turn1",
    message: { role: "assistant", content: [{ type: "text", text: '{"ok":true}' }], usage, stopReason: "stop" },
  }) + "\\n");
} else if (agent === "pi" && !process.env.FAKE_PI_NO_STORE) {
  const prompt = fs.readFileSync(promptFile, "utf8");
  const dir = ${JSON.stringify(piSessionDir)};
  fs.mkdirSync(dir, { recursive: true });
  const id = "01a02b65-" + Date.now().toString(16) + "-" + process.pid;
  const turns = ${JSON.stringify(PI_TURNS)};
  const lines = [
    { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd },
    { type: "model_change", id: "b7e9dc92", parentId: null, provider: "openai-codex", modelId: "gpt-5.6-sol" },
    { type: "thinking_level_change", id: "72a6aaad", parentId: "b7e9dc92", thinkingLevel: "high" },
    { type: "message", id: "9a9e48f3", parentId: "72a6aaad", message: { role: "user", content: [{ type: "text", text: prompt }] } },
  ];
  let parent = "9a9e48f3";
  turns.forEach((usage, i) => {
    const mid = "turn" + i;
    lines.push({
      type: "message", id: mid, parentId: parent,
      message: { role: "assistant", content: [{ type: "thinking", thinking: "..." }, { type: "text", text: i === 0 ? "Working." : '{"ok":true}' }],
        api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-sol", usage: { ...usage, cost: { total: 0.002 } }, stopReason: "stop" },
    });
    parent = mid;
  });
  const file = path.join(dir, new Date().toISOString().replace(/[:.]/g, "-") + "_" + id + ".jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\\n") + "\\n");
  if (process.env.FAKE_PI_SESSION_FILE_OUT) fs.writeFileSync(process.env.FAKE_PI_SESSION_FILE_OUT, file);
}
`,
);
fs.chmodSync(fakeAcpx, 0o755);
process.env.BACKPASS_ACPX_BIN = fakeAcpx;

const { execOneShot, openSession, describeUsage, usageRecord, sumUsage } = await import("../src/acpx.js");
const { printProposal } = await import("../src/commands/propose.js");
const { printUsage } = await import("../src/commands/usage.js");

function captureStdout(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

function proposalWith(usage) {
  return {
    repo: { name: "demo" },
    memoryFile: { path: "AGENTS.md" },
    edits: [],
    notes: [],
    stats: { transcripts: 2, positive: 1, negative: 0, gapClusters: 0 },
    budget: { current: 100, projected: 100, capTokens: 5000, utilization: 0.02, withinBudget: true, mode: "cap" },
    usage,
  };
}

const promptFile = path.join(fakeAcpxDir, "prompt.md");
fs.writeFileSync(promptFile, "<!-- backpass:self-session -->\nAudit this session.\n\n- a list item\n");

test("a harness that reports usage through acpx yields a numeric record", async () => {
  const result = await execOneShot({ agent: "codex", promptFile, cwd: workDir, timeoutSeconds: 5 });
  const record = usageRecord("codex", result);
  assert.deepEqual(record, { agent: "codex", usage: { input: 14585, output: 5, cache_read: 11008, total: 25598 } });
  assert.equal(describeUsage([record, record]), "input=29,170 output=10 cache_read=22,016 total=51,196");
});

test("pi usage is recovered from pi's own session file when acpx prints no tokens line", async () => {
  // An older pi session in the same cwd with a different prompt must not be mistaken for ours.
  fs.mkdirSync(piSessionDir, { recursive: true });
  const decoy = path.join(piSessionDir, "2026-08-01T00-00-00-000Z_decoy.jsonl");
  fs.writeFileSync(
    decoy,
    [
      JSON.stringify({ type: "session", version: 3, id: "decoy", timestamp: "2026-08-01T00:00:00.000Z", cwd: workDir }),
      JSON.stringify({
        type: "message",
        id: "u",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "something else" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "a",
        parentId: "u",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "no" }],
          usage: { input: 1, output: 1, totalTokens: 2 },
        },
      }),
      "",
    ].join("\n"),
  );
  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(decoy, old, old);

  const result = await execOneShot({ agent: "pi", promptFile, cwd: workDir, timeoutSeconds: 5 });
  const record = usageRecord("pi", result);
  assert.deepEqual(record, {
    agent: "pi",
    usage: { input: 10778, output: 208, cache_read: 8704, cache_write: 0, reasoning: 119, total: 19690 },
  });
  assert.equal(
    describeUsage([record]),
    "input=10,778 output=208 cache_read=8,704 cache_write=0 reasoning=119 total=19,690",
  );
});

test("across the turns of one pi session, each turn is accounted as its own increase", async () => {
  const sessionPrompt = path.join(fakeAcpxDir, "prompt-session.md");
  fs.writeFileSync(sessionPrompt, "<!-- backpass:self-session -->\nEdit the staging copy.\n");
  const followUp = path.join(fakeAcpxDir, "prompt-annotate.md");
  fs.writeFileSync(followUp, "<!-- backpass:self-session -->\nAnnotate the measured changes.\n");
  const fileOut = path.join(fakeAcpxDir, "pi-session-file.txt");
  process.env.FAKE_PI_SESSION_FILE_OUT = fileOut;
  try {
    const session = await openSession({ agent: "pi", effort: "high", sessionName: "bp-test", cwd: workDir });
    const first = await session.prompt({ promptFile: sessionPrompt, approveAll: true, timeoutSeconds: 5 });
    assert.deepEqual(first.usage, {
      input: 10778,
      output: 208,
      cache_read: 8704,
      cache_write: 0,
      reasoning: 119,
      total: 19690,
    });

    // The second turn appends to the same session file; only the increase is this turn's.
    process.env.FAKE_PI_SESSION_FILE = fs.readFileSync(fileOut, "utf8");
    const second = await session.prompt({ promptFile: followUp, approveAll: true, timeoutSeconds: 5 });
    assert.deepEqual(second.usage, {
      input: 300,
      output: 40,
      cache_read: 9000,
      cache_write: 0,
      reasoning: 20,
      total: 9360,
    });
    await session.close();

    const total = sumUsage([usageRecord("pi", first), usageRecord("pi", second)]);
    assert.equal(total.total, 19690 + 9360);
  } finally {
    delete process.env.FAKE_PI_SESSION_FILE;
    delete process.env.FAKE_PI_SESSION_FILE_OUT;
  }
});

test("a pi call that leaves no session file stays honest: named, never n/a", async () => {
  process.env.FAKE_PI_NO_STORE = "1";
  const silentPrompt = path.join(fakeAcpxDir, "prompt-silent.md");
  fs.writeFileSync(silentPrompt, "<!-- backpass:self-session -->\nA prompt no session file answers.\n");
  try {
    const result = await execOneShot({ agent: "pi", promptFile: silentPrompt, cwd: workDir, timeoutSeconds: 5 });
    const record = usageRecord("pi", result);
    assert.deepEqual(record, { agent: "pi", usage: null });
    assert.equal(describeUsage([record]), "not reported by pi");
  } finally {
    delete process.env.FAKE_PI_NO_STORE;
  }
});

test("describeUsage: no calls means nothing to say; a partial report says how partial", () => {
  assert.equal(describeUsage([]), null);
  assert.equal(describeUsage(undefined), null);
  const codex = { agent: "codex", usage: { input: 10, output: 2 } };
  const pi = { agent: "pi", usage: null };
  assert.equal(describeUsage([codex, pi]), "input=10 output=2 (1 of 2 calls reported)");
  assert.deepEqual(sumUsage([codex, pi, null]), { input: 10, output: 2 });
});

test("a full run prints tier-1 then tier-2 exactly once, before the apply hint", () => {
  const analysisUsage = [
    { agent: "codex", usage: { input: 100, output: 10 } },
    { agent: "codex", usage: { input: 200, output: 20 } },
  ];
  const proposal = proposalWith([{ agent: "codex", usage: { input: 5000, output: 300 } }]);
  const lines = captureStdout(() => printProposal(proposal, { analysisUsage }));

  const tier1 = lines.findIndex((l) => l.includes("tier-1 tokens:"));
  const tier2 = lines.findIndex((l) => l.includes("tier-2 tokens:"));
  const apply = lines.findIndex((l) => l.startsWith("Review and apply"));
  assert.equal(lines.filter((l) => l.includes("tier-1 tokens:")).length, 1);
  assert.equal(lines.filter((l) => l.includes("tier-2 tokens:")).length, 1);
  assert.ok(tier1 < tier2 && tier2 < apply, `order was tier1=${tier1} tier2=${tier2} apply=${apply}`);
  assert.match(lines[tier1], /tier-1 tokens: input=300 output=30$/);
  assert.match(lines[tier2], /tier-2 tokens: input=5,000 output=300$/);
  assert.ok(!lines.some((l) => l.includes("n/a")));
});

test("standalone propose prints only the synthesis tier, and never n/a", () => {
  const proposal = proposalWith([{ agent: "claude", usage: { input: 1, output: 2, total: 3 } }]);
  const lines = captureStdout(() => printProposal(proposal));
  assert.ok(!lines.some((l) => l.includes("tier-1 tokens:")));
  assert.equal(lines.filter((l) => l.includes("tier-2 tokens:")).length, 1);
  assert.ok(
    lines.findIndex((l) => l.includes("tier-2 tokens:")) < lines.findIndex((l) => l.startsWith("Review and apply")),
  );
  assert.ok(!lines.some((l) => l.includes("n/a")));
});

test("a pi-backed run names the silent harness and an applied proposal skips the hint", () => {
  const proposal = proposalWith([{ agent: "pi", usage: null }]);
  const lines = captureStdout(() =>
    printProposal(proposal, { applied: true, analysisUsage: [{ agent: "pi", usage: null }] }),
  );
  assert.deepEqual(
    lines.filter((l) => l.includes("tokens:")).map((l) => l.trim()),
    ["tier-1 tokens: not reported by pi", "tier-2 tokens: not reported by pi"],
  );
  assert.ok(!lines.some((l) => l.startsWith("Review and apply")));
});

test("with no model calls at all, no accounting line is printed", () => {
  assert.deepEqual(
    captureStdout(() => printUsage({ tier1: [], tier2: [] })),
    [],
  );
  const lines = captureStdout(() => printProposal(proposalWith([])));
  assert.ok(!lines.some((l) => l.includes("tokens:")));
  assert.ok(!lines.some((l) => l.includes("n/a")));
});
