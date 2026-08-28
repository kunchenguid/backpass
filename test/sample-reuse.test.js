import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * The captain's no-mistakes incident, through the public CLI (`src/sample.js`
 * `capTranscripts`/`sampleTranscripts`, wired in `src/commands/analyze.js`).
 *
 * An unchanged rerun discovered 147 sessions and applied the default 100-session cap.
 * The prior pass had 43 successful analyses; the rerun reused only 30 of them, because
 * `sampleTranscripts` drew its random keys from a PRNG stream reseeded from
 * `Math.random()` on every invocation whenever `config.seed` was null (the default) -
 * so the default 100-of-147 sample changed on every run, and 70 previously-analyzed
 * sessions fell out of it. This file drives the real CLI against a fake acpx and proves,
 * through `summary.analyzed`/`summary.cached` (never source inspection), that an
 * unchanged rerun now selects the identical sample and spends zero new model calls.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "backpass.js");

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-sample-reuse-bin-"));
const fakePi = path.join(binDir, "pi");
const fakeAcpx = path.join(binDir, "acpx");

fs.writeFileSync(fakePi, `#!${process.execPath}\nprocess.exit(0);\n`);
fs.chmodSync(fakePi, 0o755);

// One canned, cheap analysis answer for every `--file` call - the content doesn't
// matter here, only whether the model was invoked at all.
fs.writeFileSync(
  fakeAcpx,
  `#!${process.execPath}
const argv = process.argv.slice(2);
if (argv.includes("config") && argv.includes("show")) {
  process.stdout.write(JSON.stringify({ agents: {} }) + "\\n");
  process.exit(0);
}
if (argv.includes("--file")) {
  process.stdout.write(JSON.stringify({ positive: [], negative: [], gaps: [] }) + "\\n");
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
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-sample-reuse-repo-")));
  git(["init", "--quiet", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Agent instructions\n\n- Run `make build` before every push.\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "memory"], dir);
  return dir;
}

/** A minimal, non-trivial Pi session (clears the triviality filter). */
function writeSession(home, id, cwd, ageMs) {
  const dir = path.join(home, ".pi", "agent", "sessions", id);
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = new Date(Date.now() - ageMs).toISOString();
  const entries = [
    { type: "session", version: 3, id, timestamp, cwd },
    { type: "message", message: { role: "user", content: `Please build the project (${id}).` } },
    { type: "message", message: { role: "assistant", content: "Ran make build as instructed." } },
    { type: "message", message: { role: "user", content: "Now run the tests too." } },
    { type: "message", message: { role: "assistant", content: "Tests pass." } },
  ];
  const file = path.join(dir, `${Date.now()}_${id}.jsonl`);
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

/** `count` sessions spread over a year so the recency weighting has real spread. */
function writeSessions(home, dir, count, offset = 0) {
  const year = 365 * 86_400_000;
  for (let i = 0; i < count; i++) {
    writeSession(home, `session-${i + offset}`, dir, (i * year) / count);
  }
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
  "4",
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
    timeout: 90_000,
  });
  return { ...result, output: `${result.stdout}${result.stderr}`, summary: JSON.parse(result.stdout).summary };
}

test("147 discovered, capped to 100: an unchanged rerun reuses all 100 and spends zero new model calls", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-sample-reuse-home-"));
  const dir = initRepo();
  writeSessions(home, dir, 147);

  const first = runAnalyze(dir, home);
  assert.equal(first.status, 0, first.output);
  assert.equal(first.summary.total, 100, "the default cap of 100 applied to 147 discovered sessions");
  assert.equal(first.summary.analyzed, 100, "every sampled session is a fresh model call the first time");
  assert.equal(first.summary.cached, 0);

  const second = runAnalyze(dir, home);
  assert.equal(second.status, 0, second.output);
  assert.equal(second.summary.total, 100, "the cap still applies identically");
  assert.equal(second.summary.cached, 100, "the identical sample was drawn, so every prior analysis is reused");
  assert.equal(second.summary.analyzed, 0, "zero new model calls on an unchanged rerun");
});

test("growing the corpus past the cap keeps most of the prior sample cached, not a fresh random draw", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-sample-reuse-home-"));
  const dir = initRepo();
  writeSessions(home, dir, 147);

  const first = runAnalyze(dir, home);
  assert.equal(first.status, 0, first.output);
  assert.equal(first.summary.analyzed, 100);

  // 20 more sessions arrive - discovery now finds 167. A fresh random draw of 100-of-167
  // would overlap the prior 100-of-147 sample by roughly 100*100/167 =~ 60 on average
  // (the same math behind the captain's incident); a sticky draw can only ever lose seats
  // to the 20 newcomers, bounding the loss at 20.
  writeSessions(home, dir, 20, 147);

  const second = runAnalyze(dir, home);
  assert.equal(second.status, 0, second.output);
  assert.equal(second.summary.total, 100);
  assert.ok(
    second.summary.cached >= 100 - 20,
    `expected at least 80 cached out of the prior 100, got ${second.summary.cached}`,
  );
  assert.ok(second.summary.analyzed > 0, "at least one newly discovered session won a slot");
  assert.equal(second.summary.cached + second.summary.analyzed, 100);
});
