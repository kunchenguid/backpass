import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A stand-in acpx: answers on stdout and prints the per-run accounting line on stderr
 * exactly as the real `--format quiet` does for a harness that reports usage (codex,
 * claude). With FAKE_ACPX_SILENT set it behaves like pi, whose ACP result carries no
 * usage, so acpx prints no line at all.
 */
const fakeAcpxDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-fake-acpx-"));
const fakeAcpx = path.join(fakeAcpxDir, "acpx");
fs.writeFileSync(
  fakeAcpx,
  [
    "#!/bin/sh",
    "printf '{\"ok\":true}\\n'",
    'if [ -z "$FAKE_ACPX_SILENT" ]; then',
    '  echo "[acpx] tokens: input=14585 output=5 cache_read=11008 total=25598" >&2',
    "fi",
    "exit 0",
    "",
  ].join("\n"),
);
fs.chmodSync(fakeAcpx, 0o755);
process.env.BACKPASS_ACPX_BIN = fakeAcpx;

const { execOneShot, describeUsage, usageRecord, sumUsage } = await import("../src/acpx.js");
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
fs.writeFileSync(promptFile, "hello");

test("a harness that reports usage through acpx yields a numeric record", async () => {
  delete process.env.FAKE_ACPX_SILENT;
  const result = await execOneShot({ agent: "codex", promptFile, cwd: fakeAcpxDir, timeoutSeconds: 5 });
  const record = usageRecord("codex", result);
  assert.deepEqual(record, { agent: "codex", usage: { input: 14585, output: 5, cache_read: 11008, total: 25598 } });
  assert.equal(describeUsage([record, record]), "input=29,170 output=10 cache_read=22,016 total=51,196");
});

test("a harness that reports nothing (pi) is named instead of printing n/a", async () => {
  process.env.FAKE_ACPX_SILENT = "1";
  try {
    const result = await execOneShot({ agent: "pi", promptFile, cwd: fakeAcpxDir, timeoutSeconds: 5 });
    const record = usageRecord("pi", result);
    assert.deepEqual(record, { agent: "pi", usage: null });
    assert.equal(describeUsage([record]), "not reported by pi");
  } finally {
    delete process.env.FAKE_ACPX_SILENT;
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
