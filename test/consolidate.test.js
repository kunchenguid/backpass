import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The pre-synthesis consolidation pass, end to end through `foldForRun` against a
 * stand-in acpx: two sessions in ONE run phrase a brand-new gap differently, no lexical
 * match or citation can line them up, and the consolidation call is the only thing that
 * lets them corroborate. The fake prints whatever reply the test scripted (or fails),
 * so the merge policy, the fail-soft path, and the bookkeeping are all observable.
 */
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-fake-consolidate-"));
const fakeAcpx = path.join(fakeDir, "acpx");
fs.writeFileSync(
  fakeAcpx,
  `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv.includes("config") && argv.includes("show")) {
  process.stdout.write('{"agents":{}}\\n');
  process.exit(0);
}
if (process.env.FAKE_CONSOLIDATE_EXIT) process.exit(Number(process.env.FAKE_CONSOLIDATE_EXIT));
process.stdout.write(fs.readFileSync(process.env.FAKE_CONSOLIDATE_REPLY, "utf8"));
process.stderr.write("[acpx] tokens: input=200 output=10 total=210\\n");
`,
);
fs.chmodSync(fakeAcpx, 0o755);
process.env.BACKPASS_ACPX_BIN = fakeAcpx;

const { foldForRun } = await import("../src/commands/propose.js");
const { gapEntryId } = await import("../src/gap-ledger.js");
const { parseMemoryUnits } = await import("../src/memory.js");
const { SELF_SESSION_SENTINEL } = await import("../src/prompts.js");
const { State } = await import("../src/state.js");
const { setLoggerSink } = await import("../src/logger.js");

setLoggerSink(() => {});

const MEMORY_PATH = "AGENTS.md";
const memoryFile = { path: MEMORY_PATH, units: parseMemoryUnits("# T\n\n- Keep the README current.\n") };

// The same underlying gap, phrased far apart: word-bigram similarity cannot merge these.
const SIGHTING_A = "Always bind the pipeline attestation to the exact head SHA before publishing.";
const SIGHTING_B = "Require every published attestation to reference the precise commit it describes.";
const UNRELATED = "Never force-push to main.";

function record(id, proposedInstruction) {
  return {
    status: "ok",
    transcript: { id, harness: "claude", startedAt: Date.parse("2026-08-01T00:00:00Z") },
    memoryPath: MEMORY_PATH,
    memoryHash: "h1",
    positive: [],
    negative: [],
    gaps: [{ proposedInstruction, mistake: "hit it", quote: `quote from ${id}`, recurrenceRisk: "high" }],
  };
}

const pick = { agent: "claude", model: null, effort: null, pinned: true };

function harness(records, reply) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-consolidate-"));
  const state = new State(root).ensure();
  for (const r of records) state.writeEvidence(r.transcript.id, r);
  const replyFile = path.join(root, "fake-reply.json");
  if (reply !== undefined) fs.writeFileSync(replyFile, typeof reply === "string" ? reply : JSON.stringify(reply));
  process.env.FAKE_CONSOLIDATE_REPLY = replyFile;
  delete process.env.FAKE_CONSOLIDATE_EXIT;
  const ctx = {
    config: {
      state,
      minGapEvidence: 2,
      gapLedgerMaxAge: "90d",
      timeoutSeconds: 30,
      promptRetries: 1,
      agents: { resolve: async () => pick, withFallthrough: async (_role, fn) => fn(pick) },
    },
    repo: { root, name: "t" },
  };
  return { root, state, ctx };
}

test("two same-run paraphrases of one brand-new gap corroborate through the consolidation pass", async () => {
  const idA = gapEntryId(MEMORY_PATH, SIGHTING_A);
  const idB = gapEntryId(MEMORY_PATH, SIGHTING_B);
  const h = harness([record("claude-s1", SIGHTING_A), record("codex-s2", SIGHTING_B)], {
    merges: [[idA, idB]],
  });

  const summary = await foldForRun(h.ctx, memoryFile, "h1");

  assert.equal(summary.gaps.length, 1, "the merged entry clears the two-session bar in a single run");
  assert.equal(summary.gaps[0].sessions, 2);
  assert.equal(summary.consolidation.merged, 1);
  assert.ok(summary.consolidation.usage, "the call is accounted for, never invisible");
  assert.equal(Object.keys(h.state.readGapLedger().entries).length, 1);

  // The judged call is a backpass self-session like every other model-facing prompt.
  const prompt = fs.readFileSync(path.join(h.state.root, "prompts", "consolidate-gaps.md"), "utf8");
  assert.ok(prompt.startsWith(SELF_SESSION_SENTINEL));
  assert.ok(prompt.includes(idA) && prompt.includes(idB), "the model is shown the citable entry ids");
});

test("materially distinct gaps stay separate when the model declines to merge", async () => {
  const h = harness([record("claude-s1", SIGHTING_A), record("codex-s2", UNRELATED)], { merges: [] });

  const summary = await foldForRun(h.ctx, memoryFile, "h1");

  assert.equal(summary.gaps.length, 0);
  assert.equal(summary.totals.droppedGapSingletons, 2, "no fabricated corroboration");
  assert.equal(summary.consolidation.merged, 0);
  assert.equal(Object.keys(h.state.readGapLedger().entries).length, 2);
});

test("a failed consolidation call degrades to lexical identity and never aborts the run", async () => {
  const h = harness([record("claude-s1", SIGHTING_A), record("codex-s2", SIGHTING_B)], { merges: [] });
  process.env.FAKE_CONSOLIDATE_EXIT = "2";

  const summary = await foldForRun(h.ctx, memoryFile, "h1");
  delete process.env.FAKE_CONSOLIDATE_EXIT;

  assert.ok(summary.consolidation.failed, "the failure is named, not hidden");
  assert.equal(summary.gaps.length, 0, "the pre-consolidation behavior is what remains");
  assert.equal(Object.keys(h.state.readGapLedger().entries).length, 2, "the ledger is untouched");
});

test("an unparseable consolidation reply is a named failure, not a guessed merge", async () => {
  const h = harness([record("claude-s1", SIGHTING_A), record("codex-s2", SIGHTING_B)], "no json here at all");

  const summary = await foldForRun(h.ctx, memoryFile, "h1");

  assert.match(String(summary.consolidation.failed), /no parseable merge list/);
  assert.equal(Object.keys(h.state.readGapLedger().entries).length, 2);
});

test("fewer than two open gaps never spends a model call", async () => {
  const h = harness([record("claude-s1", SIGHTING_A)], undefined);
  // No reply file exists: a call would crash the fake, so a green run proves no call ran.
  const summary = await foldForRun(h.ctx, memoryFile, "h1");
  assert.match(String(summary.consolidation.skipped), /fewer than two/);
});
