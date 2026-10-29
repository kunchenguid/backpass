import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { resolveRepo } from "../src/repo.js";
import { loadConfig } from "../src/config.js";
import { discoverForRun } from "../src/commands/scan.js";
import { State } from "../src/state.js";
import { resolveMemoryFiles } from "../src/memory.js";
import { foldForRun } from "../src/commands/propose.js";
import { emptyGapLedger, gapEntryId, mergeGapEntries, recordGapObservations } from "../src/gap-ledger.js";
import { readTranscript } from "../src/discovery/index.js";
import { distill } from "../src/distill.js";
import { redact } from "../src/redact.js";

/**
 * The reuse-miss incident, through the public CLI (design section on evidence keys,
 * `src/state.js` `evidenceKey`/`isEvidenceFresh`, `src/commands/propose.js` `foldForRun`).
 *
 * A memory-hash change is supposed to invalidate cached evidence - that part always
 * worked. Two things did not: the CLI gave no reason a full reanalysis happened without
 * `--force` (silent invalidation), and `foldForRun` picked up every evidence file for the
 * memory path regardless of which memory-file hash it was judged against, so a session
 * that fell out of the current sample (window, cap, or a since-removed transcript) still
 * counted in the fold under a stale hash (fold contamination). This file drives the real
 * CLI against a fake acpx, then reads the same `.backpass/` state files a user or `backpass
 * status` would.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "backpass.js");

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-reuse-bin-"));
const fakePi = path.join(binDir, "pi");
const fakeAcpx = path.join(binDir, "acpx");
const renderedToolQuote = String.raw`echo \"before\" echo PASSWORD=[redacted]`;

fs.writeFileSync(fakePi, `#!${process.execPath}\nprocess.exit(0);\n`);
fs.chmodSync(fakePi, 0o755);

// One canned analysis answer for every `--file` call: a positive hit on AG-001 and one
// gap proposal, regardless of which transcript or memory hash asked for it. Good enough
// to see whether fold and the gap ledger scope evidence to the current hash.
fs.writeFileSync(
  fakeAcpx,
  `#!${process.execPath}
const argv = process.argv.slice(2);
if (argv.includes("config") && argv.includes("show")) {
  process.stdout.write(JSON.stringify({ agents: {} }) + "\\n");
  process.exit(0);
}
if (argv.includes("--file")) {
  const prompt = require("node:fs").readFileSync(argv[argv.indexOf("--file") + 1], "utf8");
  const marker = prompt.match(/\\[\\.\\.\\. \\d+ chars elided \\.\\.\\.\\]/)?.[0];
  const growth = prompt.includes("session-growth");
  const redaction = prompt.includes("session-redaction");
  const renderedTool = prompt.includes("session-rendered-tool");
  process.stdout.write(JSON.stringify({
    positive: [{ instruction: "AG-001", moment: "start", effect: "followed it", quote: "Ran make build as instructed." }],
    negative: marker ? [{ instruction: "AG-001", quote: marker, class: "harm" }] : [],
    gaps: [{ mistake: "skipped lint", proposedInstruction: "Always run lint before pushing.", recurrenceRisk: "high", quote: "Now run the tests too." },
      ...(growth ? [
        { proposedInstruction: "Check generated elisions before planning.", quote: "[... 2000 chars elided ...]", quoteProvenance: { kind: "source", event: 0, field: ["text"], start: 0, end: 26 } },
        { proposedInstruction: "Validate architecture decisions using recorded tradeoffs.", quote: "The genuine database contract was overlooked." },
      ] : []),
      ...(redaction ? [
        { proposedInstruction: "Document configuration failures using sanitized command output.", quote: "The command printed PASSWORD=[redacted]" },
      ] : []),
      ...(renderedTool ? [
        { proposedInstruction: "Keep rendered command evidence.", quote: ${JSON.stringify(renderedToolQuote)} },
      ] : [])],
    usedRawTranscript: growth,
  }) + "\\n");
  process.exit(0);
}
process.exit(0);
`,
);
fs.chmodSync(fakeAcpx, 0o755);

function git(args, cwd) {
  spawnSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(memory) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-reuse-repo-")));
  git(["init", "--quiet", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), memory);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "memory"], dir);
  return dir;
}

/** A minimal Pi session, non-trivial enough to clear the triviality filter. */
function writeSession(home, id, cwd, userText = "Please build the project.") {
  const dir = path.join(home, ".pi", "agent", "sessions", id);
  fs.mkdirSync(dir, { recursive: true });
  const entries = [
    { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd },
    { type: "message", message: { role: "user", content: userText } },
    { type: "message", message: { role: "assistant", content: "Ran make build as instructed." } },
    { type: "message", message: { role: "user", content: "Now run the tests too." } },
    { type: "message", message: { role: "assistant", content: "Tests pass." } },
  ];
  const file = path.join(dir, `${Date.now()}_${id}.jsonl`);
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return file;
}

const ANALYZE_ARGS = [
  "analyze",
  "--harness",
  "pi",
  "--since",
  "all",
  "--analysis-agent",
  "pi",
  "--jobs",
  "1",
  "--json",
];

function runAnalyze(dir, home, extraArgs = []) {
  const result = spawnSync(process.execPath, [CLI, ...ANALYZE_ARGS, ...extraArgs], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      BACKPASS_ACPX_BIN: fakeAcpx,
      NO_COLOR: "1",
    },
    encoding: "utf8",
    timeout: 20000,
  });
  return { ...result, output: `${result.stdout}${result.stderr}`, summary: JSON.parse(result.stdout).summary };
}

const MEMORY = "# Agent instructions\n\n- Run `make build` before every push.\n";
const MEMORY_EDITED = "# Agent instructions\n\n- Run `make build` before every push.\n- Never skip the changelog.\n";

test("standalone apikey credentials never reach the cached analysis prompt", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-redact-home-"));
  const dir = initRepo(MEMORY);
  const tokens = [`apikey_${"a".repeat(64)}`, `APIKEY_${"B".repeat(64)}`];
  const assignments = [];
  const secrets = [];
  for (const name of ["apikey_openrouter_production", "APIKEY_OPENROUTER_PRODUCTION"]) {
    for (const separator of ["=", ":"]) {
      for (const quote of ["", '"', "'"]) {
        const secret = `synthetic-secret-${secrets.length}`;
        secrets.push(secret);
        assignments.push(`${name}${separator}${quote}${secret}${quote}`);
      }
    }
  }
  writeSession(
    home,
    "redacted-session",
    dir,
    `Please build the project using (${tokens[0]}).\n${tokens[1]}\n${assignments.join("\n")}`,
  );

  const result = runAnalyze(dir, home);
  assert.equal(result.status, 0, result.output);
  assert.equal(result.summary.analyzed, 1);
  const promptDir = path.join(dir, ".backpass", "prompts");
  const prompts = fs.readdirSync(promptDir);
  assert.equal(prompts.length, 1);
  const prompt = fs.readFileSync(path.join(promptDir, prompts[0]), "utf8");
  assert.match(prompt, /Please build the project using \(\[redacted:API_KEY\]\)\.\n\[redacted:API_KEY\]/);
  for (const token of tokens)
    assert.ok(!prompt.includes(token), "the cached model prompt must not contain a full credential");
  for (const secret of secrets)
    assert.ok(!prompt.includes(secret), "the cached model prompt must not contain an assignment secret");
  assert.equal(prompt.match(/\[redacted:API_KEY\]=\[redacted\]/g)?.length, assignments.length);
});

test("the first analysis performs work, an unchanged second reuses it, and --force reanalyzes anyway", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-reuse-home-"));
  const dir = initRepo(MEMORY);
  writeSession(home, "session-a", dir);

  const first = runAnalyze(dir, home);
  assert.equal(first.status, 0, first.output);
  assert.deepEqual([first.summary.analyzed, first.summary.cached], [1, 0], "the first pass has no cache to hit");

  const second = runAnalyze(dir, home);
  assert.equal(second.status, 0, second.output);
  assert.deepEqual(
    [second.summary.analyzed, second.summary.cached],
    [0, 1],
    "an unchanged memory file is a free rerun",
  );
  assert.equal(second.summary.staleMemoryHash, 0, "nothing is stale when the memory file did not change");

  const forced = runAnalyze(dir, home, ["--force"]);
  assert.equal(forced.status, 0, forced.output);
  assert.deepEqual(
    [forced.summary.analyzed, forced.summary.cached],
    [1, 0],
    "--force reanalyzes even evidence that would otherwise still be fresh",
  );
});

test("evidence from the previous analysis index is reanalyzed once without --force", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-reuse-home-"));
  const dir = initRepo(MEMORY);
  writeSession(home, "session-a", dir);

  const first = runAnalyze(dir, home);
  assert.equal(first.status, 0, first.output);
  const evidenceDir = path.join(dir, ".backpass", "evidence");
  const evidenceFile = path.join(
    evidenceDir,
    fs.readdirSync(evidenceDir).find((name) => name.endsWith(".json")),
  );
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
  evidence.key =
    `${evidence.transcript.identity}:${evidence.transcript.mtimeMs}:${evidence.transcript.bytes}:` +
    evidence.memoryHash;
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);

  const upgraded = runAnalyze(dir, home);
  assert.equal(upgraded.status, 0, upgraded.output);
  assert.deepEqual([upgraded.summary.analyzed, upgraded.summary.cached], [1, 0]);

  const reused = runAnalyze(dir, home);
  assert.equal(reused.status, 0, reused.output);
  assert.deepEqual([reused.summary.analyzed, reused.summary.cached], [0, 1]);
});

test("analysis rejects a distiller marker before caching evidence", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-elision-home-"));
  const dir = initRepo(MEMORY);
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = writeSession(home, "session-elision", dir);
  fs.appendFileSync(
    file,
    `${JSON.stringify({ type: "message", message: { role: "assistant", content: "x".repeat(8000) } })}\n`,
  );

  const analyzed = runAnalyze(dir, home);
  assert.equal(analyzed.status, 0, analyzed.output);
  assert.equal(analyzed.summary.analyzed, 1);
  assert.equal(analyzed.summary.quotesNotInTrace, 1);
  const [record] = new State(dir).ensure().listEvidence();
  assert.equal(record.positive.length, 1, "the real session quote survives");
  assert.deepEqual(record.negative, [], "the generated quote never reaches the evidence cache");
});

test("upgrade revalidates persisted gap quotes before folding selected sessions", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-ledger-upgrade-home-"));
  const dir = initRepo(MEMORY);
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const buriedQuote = "Buried original evidence remains valid.";
  for (const id of ["session-a", "session-b"]) {
    const file = writeSession(home, id, dir);
    const content = "x".repeat(4800) + buriedQuote + "x".repeat(3200 - buriedQuote.length);
    fs.appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "assistant", content } })}\n`);
  }
  assert.equal(runAnalyze(dir, home).status, 0);
  const state = new State(dir).ensure();
  const records = state.listEvidence();
  const fabricated = "Check generated elisions before planning.";
  const overlapping = "Require caution when interpreting truncated session boundaries.";
  const legitimate = "Read docs/db.md before writing queries.";
  const rawBacked = "Validate architecture decisions using recorded tradeoffs.";
  const ledger = emptyGapLedger();
  recordGapObservations(
    ledger,
    records.map((record) => ({
      ...record,
      gaps: [
        { proposedInstruction: fabricated, quote: "[... 2000 chars elided ...]" },
        { proposedInstruction: overlapping, quote: "xxxxx [... 2000 chars elided ...] xxxxx" },
        { proposedInstruction: legitimate, quote: "Ran make build as instructed." },
        { proposedInstruction: rawBacked, quote: buriedQuote },
      ],
    })),
  );
  const nestedId = gapEntryId("docs/AGENTS.md", fabricated);
  ledger.entries[nestedId] = {
    ...structuredClone(ledger.entries[gapEntryId("AGENTS.md", fabricated)]),
    id: nestedId,
    memoryPath: "docs/AGENTS.md",
  };
  for (const entry of Object.values(ledger.entries)) {
    const first = records[0].transcript;
    entry.sessions["old-linked-observer"] = entry.sessions[first.identity];
    delete entry.sessions[first.identity];
    const second = records[1].transcript;
    entry.sessions[second.id] = entry.sessions[second.identity];
    delete entry.sessions[second.identity];
    delete entry.sessions[second.id].sourceSessionId;
  }
  state.writeGapLedger(ledger);
  const persisted = state.readGapLedger();
  for (const record of records) {
    state.writeEvidence(record.transcript, {
      ...record,
      key: record.key.replace(/analysis-index-v\d+$/, "analysis-index-v4"),
    });
  }

  const upgraded = runAnalyze(dir, home);
  assert.equal(upgraded.status, 0, upgraded.output);
  assert.deepEqual([upgraded.summary.analyzed, upgraded.summary.cached], [2, 0]);
  const revalidated = state.readGapLedger();
  for (const proposal of [fabricated, overlapping]) {
    const entry = revalidated.entries[gapEntryId("AGENTS.md", proposal)];
    assert.ok(Object.values(entry.sessions).every((observation) => observation.quoteProvenance.kind === "unverified"));
  }
  assert.ok(
    Object.values(revalidated.entries[nestedId].sessions).every(
      (observation) => observation.quoteProvenance.kind === "unverified",
    ),
    "all memory surfaces for the source are revalidated",
  );
  for (const proposal of [legitimate, rawBacked]) {
    const id = gapEntryId("AGENTS.md", proposal);
    for (const [session, observation] of Object.entries(revalidated.entries[id].sessions)) {
      const { quoteProvenance, ...history } = observation;
      assert.equal(quoteProvenance.kind, "source");
      assert.deepEqual(history, persisted.entries[id].sessions[session], "valid history and timestamps survive");
    }
  }
  const current = state.listEvidence();
  const repo = resolveRepo(dir);
  const memoryFile = resolveMemoryFiles(dir, ["AGENTS.md", "CLAUDE.md"]).primary;
  const ctx = { repo, config: { state, minGapEvidence: 2, gapLedgerMaxAge: "90d" } };
  const summary = await foldForRun(
    ctx,
    memoryFile,
    current[0].memoryHash,
    [],
    current.map((r) => r.transcript),
  );
  assert.equal(summary.analyzedSessions, 2);
  assert.ok(!summary.gaps.some((gap) => gap.proposedInstruction === fabricated), "generated quotes cannot corroborate");
  assert.equal(summary.gaps.find((gap) => gap.proposedInstruction === legitimate)?.sessions, 2);
  assert.equal(summary.gaps.find((gap) => gap.proposedInstruction === rawBacked)?.sessions, 2);
  const cached = runAnalyze(dir, home);
  assert.equal(cached.status, 0, cached.output);
  assert.deepEqual([cached.summary.analyzed, cached.summary.cached], [0, 2]);
});

test("redacted quotes retain fresh and legacy corroboration through growth and merges", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-redaction-home-"));
  const dir = initRepo(MEMORY);
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const secret = "synthetic-" + "ledger-password";
  const quote = "The command printed PASSWORD=[redacted]";
  const files = [];
  const appendTurn = (file, content) =>
    fs.appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "assistant", content } })}\n`);
  for (const id of ["session-redaction-a", "session-redaction-b"]) {
    const file = writeSession(home, id, dir);
    files.push(file);
    for (let i = 0; i < 7; i += 1) appendTurn(file, "p".repeat(3000));
    appendTurn(file, `${"x".repeat(3000)}The command printed PASSWORD=${secret}\n${"x".repeat(5000)}`);
  }
  const first = runAnalyze(dir, home);
  assert.equal(first.status, 0, first.output);
  const state = new State(dir).ensure();
  const records = state.listEvidence();
  const fresh = "Document configuration failures using sanitized command output.";
  const legacy = "Read docs/database.md before provisioning databases.";
  const generated = "Check generated elisions before planning.";
  const ledger = emptyGapLedger();
  recordGapObservations(
    ledger,
    records.map((record) => ({
      ...record,
      gaps: [
        ...record.gaps.filter((gap) => gap.proposedInstruction === fresh),
        { proposedInstruction: legacy, quote },
        { proposedInstruction: generated, quote: "[... 2000 chars elided ...]" },
      ],
    })),
  );
  state.writeGapLedger(ledger);
  const historyBefore = state.readGapLedger();
  for (const file of files) {
    for (let i = 0; i < 10; i += 1) appendTurn(file, "t".repeat(3000));
  }
  const grown = runAnalyze(dir, home);
  assert.equal(grown.status, 0, grown.output);
  assert.deepEqual([grown.summary.analyzed, grown.summary.cached], [2, 0]);
  const current = state.listEvidence();
  for (const record of current) {
    const gap = record.gaps.find((gap) => gap.proposedInstruction === fresh);
    assert.ok(gap, "fresh redacted quotes are admitted");
    assert.equal(gap.quote, quote);
    const raw = await readTranscript(record.transcript);
    assert.ok(!distill(raw.events, record.transcript).trace.includes(quote), "growth hides the original quote");
    const { event, field, start, end } = gap.quoteProvenance;
    const source = field.reduce((value, key) => value[key], raw.events[event]);
    assert.equal(redact(source.slice(start, end)), quote, "offsets still identify the genuine original span");
  }
  const repo = resolveRepo(dir);
  const memoryFile = resolveMemoryFiles(dir, ["AGENTS.md", "CLAUDE.md"]).primary;
  const summary = await foldForRun(
    { repo, config: { state, minGapEvidence: 2, gapLedgerMaxAge: "90d" } },
    memoryFile,
    current[0].memoryHash,
    [],
    current.map((record) => record.transcript),
  );
  for (const instruction of [fresh, legacy]) {
    assert.equal(summary.gaps.find((gap) => gap.proposedInstruction === instruction)?.sessions, 2);
  }
  assert.ok(!summary.gaps.some((gap) => gap.proposedInstruction === generated));
  const persisted = state.readGapLedger();
  const legacyId = gapEntryId("AGENTS.md", legacy);
  const freshId = gapEntryId("AGENTS.md", fresh);
  for (const [session, observation] of Object.entries(persisted.entries[freshId].sessions)) {
    assert.deepEqual(observation.quoteProvenance, historyBefore.entries[freshId].sessions[session].quoteProvenance);
    assert.equal(observation.firstObservedAt, historyBefore.entries[freshId].sessions[session].firstObservedAt);
  }
  for (const [session, observation] of Object.entries(persisted.entries[legacyId].sessions)) {
    const { quoteProvenance, ...history } = observation;
    assert.deepEqual(history, historyBefore.entries[legacyId].sessions[session], "legacy history is retained");
    assert.deepEqual(
      quoteProvenance,
      current.find((record) => record.transcript.identity === session).gaps.at(-1).quoteProvenance,
    );
  }
  for (const reverse of [false, true]) {
    const merged = structuredClone(persisted);
    const expected = structuredClone(merged.entries[legacyId].sessions);
    mergeGapEntries(merged, [reverse ? [legacyId, freshId] : [freshId, legacyId]]);
    const sessions = (merged.entries[legacyId] || merged.entries[freshId]).sessions;
    assert.deepEqual(Object.keys(sessions), Object.keys(expected));
    for (const [session, observation] of Object.entries(sessions)) {
      assert.equal(observation.quote, expected[session].quote);
      assert.deepEqual(observation.quoteProvenance, expected[session].quoteProvenance);
      assert.equal(observation.firstObservedAt, expected[session].firstObservedAt);
    }
    assert.ok(!JSON.stringify(merged).includes(secret), "merged ledger records exclude the original secret");
  }
  for (const record of [persisted, current, summary, first.output, grown.output]) {
    assert.ok(!JSON.stringify(record).includes(secret), "stored and reported evidence excludes the original secret");
  }
});

test("rendered tool quotes retain fresh and legacy ledger corroboration", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-tool-home-"));
  const dir = initRepo(MEMORY);
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const secret = "synthetic-" + "tool-password";
  for (const id of ["session-rendered-tool-a", "session-rendered-tool-b"]) {
    const file = writeSession(home, id, dir);
    const toolCall = {
      type: "toolCall",
      id: "bash",
      name: "Bash",
      arguments: { command: `echo "before"\necho PASSWORD=${secret}` },
    };
    fs.appendFileSync(
      file,
      `${JSON.stringify({ type: "message", message: { role: "assistant", content: [toolCall] } })}\n`,
    );
  }
  const first = runAnalyze(dir, home);
  assert.equal(first.status, 0, first.output);
  const state = new State(dir).ensure();
  const records = state.listEvidence();
  for (const record of records) {
    const gap = record.gaps.find((item) => item.proposedInstruction === "Keep rendered command evidence.");
    assert.ok(gap, "fresh rendered quotes are admitted");
    assert.equal(gap.quote, renderedToolQuote);
  }
  const legacy = "Preserve legacy command evidence.";
  const ledger = emptyGapLedger();
  recordGapObservations(
    ledger,
    records.map((record) => ({ ...record, gaps: [{ proposedInstruction: legacy, quote: renderedToolQuote }] })),
  );
  state.writeGapLedger(ledger);
  const before = state.readGapLedger();
  const rerun = runAnalyze(dir, home, ["--force"]);
  assert.equal(rerun.status, 0, rerun.output);
  const persisted = state.readGapLedger();
  const id = gapEntryId("AGENTS.md", legacy);
  for (const [session, observation] of Object.entries(persisted.entries[id].sessions)) {
    const { quoteProvenance, ...history } = observation;
    assert.equal(quoteProvenance.kind, "source");
    assert.deepEqual(history, before.entries[id].sessions[session]);
    const record = state.listEvidence().find((item) => item.transcript.identity === session);
    const raw = await readTranscript(record.transcript);
    const { event, field, start, end } = quoteProvenance;
    const source = field.reduce((value, key) => value[key], raw.events[event]);
    assert.equal(JSON.stringify(redact(source.slice(start, end).replace(/\s+/g, " "))).slice(1, -1), renderedToolQuote);
  }
  const memoryFile = resolveMemoryFiles(dir, ["AGENTS.md", "CLAUDE.md"]).primary;
  const summary = await foldForRun(
    { repo: resolveRepo(dir), config: { state, minGapEvidence: 2, gapLedgerMaxAge: "90d" } },
    memoryFile,
    records[0].memoryHash,
    [],
    records.map((record) => record.transcript),
  );
  assert.equal(summary.gaps.find((gap) => gap.proposedInstruction === legacy)?.sessions, 2);
  for (const record of [persisted, state.listEvidence(), summary, first.output, rerun.output]) {
    assert.ok(!JSON.stringify(record).includes(secret));
  }
});

test("source provenance rejects new and persisted generated quotes after session growth", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-growth-home-"));
  const dir = initRepo(MEMORY);
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const hidden = "The genuine database contract was overlooked.";
  const files = [];
  const appendTurn = (file, text) =>
    fs.appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "assistant", content: text } })}\n`);
  for (const id of ["session-growth-a", "session-growth-b"]) {
    const file = writeSession(home, id, dir);
    files.push(file);
    for (let i = 0; i < 7; i += 1) appendTurn(file, "p".repeat(3000));
    appendTurn(file, "x".repeat(4800) + hidden + "x".repeat(3200 - hidden.length));
  }
  const first = runAnalyze(dir, home);
  assert.equal(first.status, 0, first.output);
  const state = new State(dir).ensure();
  const records = state.listEvidence();
  const fabricated = "Check generated elisions before planning.";
  const legitimate = "Read docs/db.md before writing queries.";
  const ledger = emptyGapLedger();
  recordGapObservations(
    ledger,
    records.map((record) => ({
      ...record,
      gaps: [
        { proposedInstruction: fabricated, quote: "[... 2000 chars elided ...]" },
        { proposedInstruction: legitimate, quote: hidden },
      ],
    })),
  );
  state.writeGapLedger(ledger);
  for (const file of files) {
    for (let i = 0; i < 10; i += 1) appendTurn(file, "t".repeat(3000));
  }

  const grown = runAnalyze(dir, home);
  assert.equal(grown.status, 0, grown.output);
  assert.deepEqual([grown.summary.analyzed, grown.summary.cached], [2, 0]);
  const current = state.listEvidence();
  for (const record of current) {
    const raw = await readTranscript(record.transcript);
    const distilled = distill(raw.events, record.transcript);
    assert.equal(distilled.stats.elided, true);
    assert.ok(!distilled.trace.includes("[... 2000 chars elided ...]"), "growth hides the old message marker");
  }
  assert.ok(
    current.every((record) => !record.gaps.some((gap) => gap.proposedInstruction === fabricated)),
    "new generated quotes are rejected even when the model claims raw access",
  );
  assert.ok(
    current.every((record) => record.gaps.some((gap) => gap.quote === hidden && gap.quoteProvenance.kind === "source")),
    "new genuine quotes hidden from the trace carry measured provenance",
  );
  const repo = resolveRepo(dir);
  const memoryFile = resolveMemoryFiles(dir, ["AGENTS.md", "CLAUDE.md"]).primary;
  const ctx = { repo, config: { state, minGapEvidence: 2, gapLedgerMaxAge: "90d" } };
  const summary = await foldForRun(
    ctx,
    memoryFile,
    current[0].memoryHash,
    [],
    current.map((r) => r.transcript),
  );
  assert.ok(
    !summary.gaps.some((gap) => gap.proposedInstruction === fabricated),
    "persisted generated quotes do not corroborate",
  );
  assert.equal(summary.gaps.find((gap) => gap.proposedInstruction === legitimate)?.sessions, 2);
  assert.equal(
    summary.gaps.find((gap) => gap.proposedInstruction === "Validate architecture decisions using recorded tradeoffs.")
      ?.sessions,
    2,
  );
  const persisted = state.readGapLedger();
  assert.equal(persisted.version, 1);
  assert.equal(
    Object.keys(persisted.entries[gapEntryId("AGENTS.md", fabricated)].sessions).length,
    2,
    "unverified legacy records are preserved",
  );
  for (const observation of Object.values(persisted.entries[gapEntryId("AGENTS.md", legitimate)].sessions)) {
    assert.equal(observation.quoteProvenance.kind, "source");
    const record = current.find((candidate) => candidate.transcript.identity === observation.sourceSessionId);
    const raw = await readTranscript(record.transcript);
    const { event, field, start, end } = observation.quoteProvenance;
    const text = field.reduce((value, key) => value[key], raw.events[event]);
    assert.equal(text.slice(start, end), hidden, "stored offsets identify a genuine source span");
    assert.equal(
      observation.firstObservedAt,
      ledger.entries[gapEntryId("AGENTS.md", legitimate)].sessions[observation.sourceSessionId].firstObservedAt,
    );
  }
  const cached = runAnalyze(dir, home);
  assert.equal(cached.status, 0, cached.output);
  assert.deepEqual([cached.summary.analyzed, cached.summary.cached], [0, 2]);
});

test("editing AGENTS.md without --force reanalyzes and explains that prior evidence is stale, not missing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-reuse-home-"));
  const dir = initRepo(MEMORY);
  writeSession(home, "session-a", dir);

  runAnalyze(dir, home); // seed one fresh evidence file

  fs.writeFileSync(path.join(dir, "AGENTS.md"), MEMORY_EDITED);
  const third = runAnalyze(dir, home);
  assert.equal(third.status, 0, third.output);
  assert.deepEqual(
    [third.summary.analyzed, third.summary.cached],
    [1, 0],
    "a memory-file edit invalidates the cache, exactly as documented",
  );
  assert.equal(third.summary.staleMemoryHash, 1, "the invalidation is attributed to the hash change, not a plain miss");
  assert.match(third.stderr, /evidence from a previous memory surface/);
  assert.match(third.stderr, /stale, not missing/);
  assert.match(third.stderr, /sha256:\w+ -> sha256:\w+/, "names the old and new hash");
});

test("a skill description edit invalidates cached evidence; a body edit is free", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-reuse-home-"));
  const dir = initRepo(MEMORY);
  const skillFile = path.join(dir, ".agents", "skills", "db", "SKILL.md");
  const skill = (description, body) => `---\nname: db\ndescription: ${description}\n---\n\n${body}\n`;
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(skillFile, skill("old trigger", "- body v1"));
  writeSession(home, "session-a", dir);

  const first = runAnalyze(dir, home);
  assert.equal(first.status, 0, first.output);
  assert.deepEqual([first.summary.analyzed, first.summary.cached], [1, 0]);
  // The skill layer is part of what the analysis is judged against: the prompt the
  // model actually received names the skill and its trigger.
  const promptDir = path.join(dir, ".backpass", "prompts");
  const prompts = fs.readdirSync(promptDir).map((f) => fs.readFileSync(path.join(promptDir, f), "utf8"));
  assert.ok(
    prompts.some((p) => p.includes("db (.agents/skills/db/SKILL.md) :: old trigger")),
    "the analysis prompt carries the skill index",
  );

  fs.writeFileSync(skillFile, skill("old trigger", "- body v2, changed"));
  const second = runAnalyze(dir, home);
  assert.equal(second.status, 0, second.output);
  assert.deepEqual(
    [second.summary.analyzed, second.summary.cached],
    [0, 1],
    "nothing is judged against skill bodies, so a body edit is a free rerun",
  );

  fs.writeFileSync(skillFile, skill("new trigger", "- body v2, changed"));
  const third = runAnalyze(dir, home);
  assert.equal(third.status, 0, third.output);
  assert.deepEqual(
    [third.summary.analyzed, third.summary.cached],
    [1, 0],
    "a description line is always loaded, so editing it re-judges the evidence",
  );
  assert.equal(third.summary.staleMemoryHash, 1);
  assert.match(third.stderr, /evidence from a previous memory surface/);
});

test("old-hash leftover evidence cannot change the current fold's session count, instruction scores, or gap observations", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-reuse-home-"));
  const dir = initRepo(MEMORY);
  const fileA = writeSession(home, "session-a", dir);
  const fileB = writeSession(home, "session-b", dir);

  const both = runAnalyze(dir, home);
  assert.equal(both.status, 0, both.output);
  assert.equal(both.summary.analyzed, 2, "both sessions are analyzed under the first hash");
  void fileA;

  // Session B falls out of this run's sample (window, cap, or - as here - the transcript
  // itself is gone) while its evidence file, still stamped with the old hash, stays on
  // disk. The memory file also changes, so session A's evidence goes stale too.
  fs.renameSync(fileB, `${fileB}.bak`);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), MEMORY_EDITED);

  const onlyA = runAnalyze(dir, home);
  assert.equal(onlyA.status, 0, onlyA.output);
  assert.equal(onlyA.summary.total, 1, "session B is no longer discovered at all");
  assert.deepEqual([onlyA.summary.analyzed, onlyA.summary.cached], [1, 0]);

  // Fold this run's evidence the way `backpass propose` does - same exported function,
  // reading the same evidence directory the CLI run above just wrote to.
  const state = new State(dir).ensure();
  const resolved = resolveMemoryFiles(dir, ["AGENTS.md", "CLAUDE.md"]);
  const ctx = { config: { state, minGapEvidence: 2, gapLedgerMaxAge: "90d" } };

  const selected = state
    .listEvidence()
    .filter((evidence) => evidence.memoryHash === resolved.hash)
    .map((evidence) => evidence.transcript);
  return foldForRun(ctx, resolved.primary, resolved.hash, [], selected).then((summary) => {
    assert.equal(summary.analyzedSessions, 1, "session B's leftover evidence must not inflate the session count");

    const ag001 = summary.instructions.find((i) => i.instruction === "AG-001");
    assert.equal(ag001.positive, 1, "only session A's positive evidence is scored");
    assert.equal(ag001.sessions, 1);

    assert.equal(
      summary.gaps.length,
      0,
      "the gap needs 2 corroborating sessions; B's stale-hash sighting must not count toward that bar",
    );
    const ledger = state.readGapLedger();
    const sessionsSeen = Object.values(ledger.entries).flatMap((e) => Object.keys(e.sessions));
    const currentA = state.listEvidence().find((e) => e.transcript.path === fileA && e.memoryHash === resolved.hash);
    assert.deepEqual(
      sessionsSeen,
      [currentA.transcript.identity],
      "only the current-hash session is recorded into the ledger this run",
    );

    fs.writeFileSync(path.join(dir, "AGENTS.md"), MEMORY);
    const reverted = resolveMemoryFiles(dir, ["AGENTS.md", "CLAUDE.md"]);
    const revertedSelected = state
      .listEvidence()
      .filter((evidence) => evidence.memoryHash === reverted.hash)
      .map((evidence) => evidence.transcript);
    return foldForRun(ctx, reverted.primary, reverted.hash, [], revertedSelected).then((revertedSummary) => {
      assert.equal(
        revertedSummary.analyzedSessions,
        1,
        "the untouched session B evidence becomes reusable when its original memory bytes are current again",
      );
      assert.equal(revertedSummary.instructions.find((i) => i.instruction === "AG-001").positive, 1);
    });
  });
});

test("OMP analysis persists parent observer identity and fold restores it for legacy evidence", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-omp-fold-home-"));
  const dir = initRepo(MEMORY);
  const sessionRoot = path.join(home, ".omp", "agent", "sessions", "-repo-demo");
  const parentName = "2026-08-27T00-00-00.000Z_parent-folder";
  const childPath = path.join(sessionRoot, parentName, "Subagent.jsonl");

  const writeOmpTranscript = (file, id) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entries = [
      { type: "title", v: 1, title: "" },
      { type: "session", version: 3, id, timestamp: "2026-08-27T00:00:00.000Z", cwd: dir },
      { type: "message", message: { role: "user", content: "Please build the project." } },
      { type: "message", message: { role: "assistant", content: "Ran make build as instructed." } },
      { type: "message", message: { role: "user", content: "Now run the tests too." } },
      { type: "message", message: { role: "assistant", content: "Tests pass." } },
    ];
    fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  };

  writeOmpTranscript(path.join(sessionRoot, `${parentName}.jsonl`), "parent-native");
  writeOmpTranscript(path.join(sessionRoot, parentName, "Subagent.jsonl"), "child-native");
  const disabled = runAnalyze(dir, home);
  assert.equal(disabled.status, 0, disabled.output);
  assert.equal(JSON.parse(disabled.stdout).transcripts, 0, "the default CLI run does not read OMP sessions");
  fs.writeFileSync(path.join(dir, ".backpassrc.json"), JSON.stringify({ discovery: { includeOmp: true } }));

  const analyzed = runAnalyze(dir, home);
  assert.equal(analyzed.status, 0, analyzed.output);
  assert.equal(analyzed.summary.analyzed, 2, "the real analyzer writes evidence for parent and child");

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const repo = resolveRepo(dir);
    const config = loadConfig(dir, { discovery: { harnesses: ["pi"], since: "all", includeOmp: true } });
    const state = new State(dir).ensure();
    config.state = state;
    const ctx = { repo, config, scope: null, strict: false, limit: null };
    const { transcripts } = await discoverForRun(ctx);
    assert.equal(transcripts.length, 2, "discovery returns both OMP transcripts");
    assert.equal(new Set(transcripts.map((transcript) => transcript.corroborationIdentity)).size, 1);

    const evidence = state.listEvidence();
    assert.equal(evidence.length, 2);

    const memoryFile = resolveMemoryFiles(dir, ["AGENTS.md", "CLAUDE.md"]).primary;
    const memoryHash = evidence[0].memoryHash;
    const foldCtx = { repo, config: { ...config, minGapEvidence: 2, gapLedgerMaxAge: "90d" }, scope: null };

    const current = await foldForRun(foldCtx, memoryFile, memoryHash, [], transcripts);
    assert.equal(current.gaps.length, 0, "parent and child count as one observer, below the two-session threshold");
    const currentSessionIds = Object.values(state.readGapLedger().entries).flatMap((entry) =>
      Object.keys(entry.sessions),
    );
    assert.deepEqual(currentSessionIds, [transcripts[0].corroborationIdentity]);
    assert.ok(
      evidence.every((record) =>
        transcripts.some(
          (transcript) =>
            transcript.path === record.transcript.path &&
            transcript.corroborationIdentity === record.transcript.corroborationIdentity,
        ),
      ),
      "analysis persists the observer identity needed by later folds",
    );

    const childEvidence = evidence.find((record) => record.transcript.path === childPath);
    assert.ok(childEvidence);
    for (const field of [
      "parentSessionId",
      "corroborationIdentity",
      "corroborationNativeId",
      "corroborationStartedAt",
    ]) {
      delete childEvidence.transcript[field];
    }
    state.writeEvidence(childEvidence.transcript, childEvidence);

    const reused = runAnalyze(dir, home);
    assert.equal(reused.status, 0, reused.output);
    assert.deepEqual([reused.summary.analyzed, reused.summary.cached], [0, 2]);
    const reusedChild = state.listEvidence().find((record) => record.transcript.path === childPath);
    assert.equal(reusedChild.transcript.parentSessionId, "parent-native");
    assert.equal(reusedChild.transcript.corroborationIdentity, transcripts[0].corroborationIdentity);
    assert.equal(reusedChild.transcript.corroborationNativeId, "parent-native");

    state.writeGapLedger({ version: 1, entries: {} });
    for (const record of evidence) {
      const transcript = { ...record.transcript };
      delete transcript.parentSessionId;
      delete transcript.corroborationIdentity;
      delete transcript.corroborationNativeId;
      delete transcript.corroborationStartedAt;
      state.writeEvidence(transcript, { ...record, transcript });
    }

    const legacy = await foldForRun(foldCtx, memoryFile, memoryHash, [], transcripts);
    assert.equal(legacy.gaps.length, 0, "selected discovery metadata restores identity for older evidence");
    const legacySessionIds = Object.values(state.readGapLedger().entries).flatMap((entry) =>
      Object.keys(entry.sessions),
    );
    assert.deepEqual(legacySessionIds, [transcripts[0].corroborationIdentity]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
});

test("OMP analysis labels missing-ancestor child and grandchild as automation without invented root provenance", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-omp-missing-analysis-"));
  const dir = initRepo(MEMORY);
  const sessionRoot = path.join(home, ".omp", "agent", "sessions", "-repo-demo");
  const files = [
    [path.join(sessionRoot, "root", "Child.jsonl"), "child-native"],
    [path.join(sessionRoot, "other-root", "Missing", "Missing.Grandchild.jsonl"), "grandchild-native"],
  ];
  for (const [file, id] of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entries = [
      { type: "title", v: 1, title: "" },
      { type: "session", version: 3, id, timestamp: "2026-08-27T00:00:00.000Z", cwd: dir },
      { type: "message", message: { role: "user", content: "Please build the project." } },
      { type: "message", message: { role: "assistant", content: "Ran make build as instructed." } },
      { type: "message", message: { role: "user", content: "Now run the tests too." } },
      { type: "message", message: { role: "assistant", content: "Tests pass." } },
    ];
    fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  }
  fs.writeFileSync(path.join(sessionRoot, "root.jsonl"), "not a session header\n");
  fs.writeFileSync(path.join(dir, ".backpassrc.json"), JSON.stringify({ discovery: { includeOmp: true } }));
  const analyzed = runAnalyze(dir, home);
  assert.equal(analyzed.status, 0, analyzed.output);
  assert.equal(analyzed.summary.analyzed, 2);
  const state = new State(dir).ensure();
  const evidence = state.listEvidence();
  assert.equal(evidence.length, 2);
  for (const record of evidence) {
    assert.equal(record.transcript.interaction, "non-interactive");
    assert.equal(record.transcript.parentSessionId, null);
    assert.equal(record.transcript.corroborationIdentity, record.transcript.identity);
    assert.equal(record.transcript.corroborationNativeId, record.transcript.id.slice("pi-".length));
    assert.equal(record.transcript.corroborationStartedAt, record.transcript.startedAt);
    record.transcript.interaction = "interactive";
    state.writeEvidence(record.transcript, record);
  }
  const reused = runAnalyze(dir, home);
  assert.equal(reused.status, 0, reused.output);
  assert.deepEqual([reused.summary.analyzed, reused.summary.cached], [0, 2]);
  assert.ok(state.listEvidence().every((record) => record.transcript.interaction === "non-interactive"));
});
