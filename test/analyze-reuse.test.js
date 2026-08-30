import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { State } from "../src/state.js";
import { resolveMemoryFiles } from "../src/memory.js";
import { foldForRun } from "../src/commands/propose.js";

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
  process.stdout.write(JSON.stringify({
    positive: [{ instruction: "AG-001", moment: "start", effect: "followed it", quote: "followed the build rule exactly as written" }],
    negative: [],
    gaps: [{ mistake: "skipped lint", proposedInstruction: "Always run lint before pushing.", recurrenceRisk: "high", quote: "skipped lint entirely this time" }],
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
function writeSession(home, id, cwd) {
  const dir = path.join(home, ".pi", "agent", "sessions", id);
  fs.mkdirSync(dir, { recursive: true });
  const entries = [
    { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd },
    { type: "message", message: { role: "user", content: "Please build the project." } },
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
