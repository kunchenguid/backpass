import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { State } from "../src/state.js";

/**
 * A fatal analysis error stops the run from starting more model calls.
 *
 * Per-transcript failures (a timeout, unparseable output) are recorded and the run goes
 * on; an error that fails the run - here a pinned agent failing in a way nothing can
 * classify - used to stop only the worker that hit it. The run reported the failure while
 * every other worker kept taking transcripts and paying for model calls. This drives the
 * real CLI with two jobs over five sessions: the call that fails and the one already in
 * flight run, the healthy call's evidence is saved, and no third call starts.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "backpass.js");

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-stop-bin-"));
const fakePi = path.join(binDir, "pi");
const fakeAcpx = path.join(binDir, "acpx");
const callLog = path.join(binDir, "calls.log");
const gap = {
  mistake: "Tests needed a user reminder.",
  proposedInstruction: "Run tests before declaring the work complete.",
  recurrenceRisk: "high",
  quote: "Now run the tests too.",
  domain: "project",
};

fs.writeFileSync(fakePi, `#!${process.execPath}\nprocess.exit(0);\n`);
fs.chmodSync(fakePi, 0o755);
fs.writeFileSync(
  fakeAcpx,
  `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv.includes("config") && argv.includes("show")) {
  process.stdout.write(JSON.stringify({ agents: {} }) + "\\n");
  process.exit(0);
}
if (argv.includes("--file")) {
  const prompt = fs.readFileSync(argv[argv.indexOf("--file") + 1], "utf8");
  const session = /Do the (\\S+) work\\./.exec(prompt)[1];
  fs.appendFileSync(${JSON.stringify(callLog)}, session + "\\n");
  if (session === "doomed") {
    process.stderr.write("adapter crashed\\n");
    process.exit(1);
  }
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ positive: [], negative: [], gaps: [${JSON.stringify(gap)}] }) + "\\n");
    process.exit(0);
  }, 1500);
} else {
  process.exit(0);
}
`,
);
fs.chmodSync(fakeAcpx, 0o755);

function git(args, cwd) {
  spawnSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-stop-repo-")));
  git(["init", "--quiet", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Agent instructions\n\n- Run `make build` before every push.\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "memory"], dir);
  return dir;
}

/** A Pi session, non-trivial, whose modification time orders it among the others. */
function writeSession(home, id, cwd, ageSeconds) {
  const dir = path.join(home, ".pi", "agent", "sessions", id);
  fs.mkdirSync(dir, { recursive: true });
  const entries = [
    { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd },
    { type: "message", message: { role: "user", content: `Do the ${id} work.` } },
    { type: "message", message: { role: "assistant", content: "Working on it." } },
    { type: "message", message: { role: "user", content: "Now run the tests too." } },
    { type: "message", message: { role: "assistant", content: "Tests pass." } },
  ];
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  const at = new Date(Date.now() - ageSeconds * 1000);
  fs.utimesSync(file, at, at);
}

test("a fatal analysis error stops the run from starting more model calls", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-stop-home-"));
  const dir = initRepo();
  // Newest first: the doomed session and one healthy session are the first two taken.
  ["doomed", "second", "third", "fourth", "fifth"].forEach((id, index) =>
    writeSession(home, id, dir, 60 * (index + 1)),
  );

  const result = spawnSync(
    process.execPath,
    [CLI, "analyze", "--harness", "pi", "--since", "all", "--analysis-agent", "pi", "--jobs", "2"],
    {
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
      timeout: 30000,
    },
  );
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /pinned analysis agent pi/, output);
  const calls = fs.readFileSync(callLog, "utf8").trim().split("\n").sort();
  assert.deepEqual(calls, ["doomed", "second"], "only the calls already in flight ran");

  // Read the persisted analysis contract after the CLI has exited, not its model output.
  const evidence = new State(dir).listEvidence();
  assert.equal(evidence.length, 1, "only the healthy in-flight session saved evidence");
  assert.equal(path.basename(evidence[0].transcript.path), "second.jsonl");
  assert.equal(evidence[0].status, "ok", "the in-flight analysis succeeded despite the fatal error");
  assert.deepEqual(
    evidence[0].gaps,
    [
      {
        ...gap,
        quoteProvenance: { kind: "source", event: 2, field: ["text"], start: 0, end: gap.quote.length },
      },
    ],
    "the healthy call's evidence and measured source provenance survive shutdown",
  );
});
