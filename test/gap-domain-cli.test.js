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
import { renderEvidenceForPrompt } from "../src/fold.js";

/**
 * A gap's `domain` decides whether it can ever become an instruction, so this drives the
 * real CLI (`backpass analyze` against a fake acpx) and then folds the evidence the way
 * `backpass propose` does, asserting both halves of the contract a user depends on:
 * the analysis prompt actually handed to the model states the causal test for
 * `orchestration` (the mistake was caused by the harness around the session, not by this
 * repository), and the mechanics behind it are unchanged - orchestration sightings are
 * recorded and counted but never corroborate, while a gap with no domain at all is still
 * treated as `project`.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "backpass.js");

const ORCHESTRATION_GAP = "Stop after the report on scout tasks.";
const UNLABELLED_GAP = "Always run lint before pushing.";

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-domain-bin-"));
const fakePi = path.join(binDir, "pi");
const fakeAcpx = path.join(binDir, "acpx");

fs.writeFileSync(fakePi, `#!${process.execPath}\nprocess.exit(0);\n`);
fs.chmodSync(fakePi, 0o755);

// Every analysis call answers with the same two gaps: one the model judged
// `orchestration`, and one from before the field existed (no `domain` at all).
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
    positive: [],
    negative: [],
    gaps: [
      {
        mistake: "kept working after the brief said to report and stop",
        proposedInstruction: ${JSON.stringify(ORCHESTRATION_GAP)},
        recurrenceRisk: "high",
        domain: "orchestration",
        quote: "opened a PR during a scout task",
      },
      {
        mistake: "skipped lint",
        proposedInstruction: ${JSON.stringify(UNLABELLED_GAP)},
        recurrenceRisk: "high",
        quote: "skipped lint entirely this time",
      },
    ],
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

function initRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-domain-repo-")));
  git(["init", "--quiet", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Agent instructions\n\n- Run `make build` before every push.\n");
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
  fs.writeFileSync(
    path.join(dir, `${Date.now()}_${id}.jsonl`),
    `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
}

function runAnalyze(dir, home) {
  const args = ["analyze", "--harness", "pi", "--since", "all", "--analysis-agent", "pi", "--jobs", "1", "--json"];
  const result = spawnSync(process.execPath, [CLI, ...args], {
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
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

function analyzedRepo() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-domain-home-"));
  const dir = initRepo();
  writeSession(home, "session-a", dir);
  writeSession(home, "session-b", dir);
  const run = runAnalyze(dir, home);
  assert.equal(run.status, 0, run.output);
  return dir;
}

test("the analysis prompt the model receives asks what caused the gap, not which category it resembles", () => {
  const dir = analyzedRepo();
  const promptDir = path.join(dir, ".backpass", "prompts");
  const prompts = fs.readdirSync(promptDir).map((f) => fs.readFileSync(path.join(promptDir, f), "utf8"));
  assert.equal(prompts.length, 2, "both analyzed sessions got a prompt");

  for (const prompt of prompts) {
    assert.match(
      prompt,
      /`orchestration` when the mistake was\s+not caused by this repository, but by an external agent harness or tooling that\s+orchestrated the task/,
      "the causal test is what the model is asked to apply",
    );
    assert.match(prompt, /every other gap is `project`/);
    assert.match(prompt, /illustration only, not a list to match against/, "examples cannot read as exhaustive");
    assert.ok(
      !/task briefs and their scope|status reporting to a supervisor|delivery-lifecycle process/.test(prompt),
      "the old enumeration no longer stands in for the definition",
    );
    assert.match(prompt, /Orchestration gaps\s+are counted but never proposed into this repository's memory file/);
  }
});

test("an orchestration gap is counted but never corroborates, while a gap with no domain is project", async () => {
  const dir = analyzedRepo();
  const state = new State(dir).ensure();
  const resolved = resolveMemoryFiles(dir, ["AGENTS.md", "CLAUDE.md"]);
  const summary = await foldForRun(
    { config: { state, minGapEvidence: 2, gapLedgerMaxAge: "90d" } },
    resolved.primary,
    resolved.hash,
  );

  assert.equal(summary.analyzedSessions, 2, "both sessions saw both gaps, so both clear the two-session floor");
  assert.equal(summary.totals.orchestrationGapSightings, 2, "orchestration sightings are recorded, not dropped");
  assert.deepEqual(
    summary.gaps.map((gap) => gap.proposedInstruction),
    [UNLABELLED_GAP],
    "only the domain-less gap - counted as project - can reach a proposal",
  );

  const rendered = renderEvidenceForPrompt(summary);
  assert.ok(!rendered.includes(ORCHESTRATION_GAP), "the orchestration gap never reaches the synthesis prompt");
  assert.match(rendered, /2 orchestration-domain sighting\(s\).*excluded/, "the run stays legible about what it cut");

  const ledger = state.readGapLedger();
  const domains = Object.values(ledger.entries).map((entry) => Object.values(entry.sessions)[0].domain);
  assert.deepEqual(domains.sort(), ["orchestration", "project"], "the ledger keeps the judged domain of each sighting");
});
