import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * Claude's OAuth refresh lock (#203): when the token is due, whichever Claude process
 * starts first takes `.oauth_refresh.lock` and must stay alive until the refresh is done.
 * backpass opens each analysis call with a short-lived `sessions new` helper, so four of
 * them racing at `--jobs 4` can abandon the lock and every session then fails. The first
 * analysis call with Claude therefore runs alone, start to finish, before the fan-out.
 * This drives the real CLI against a fake acpx that logs when each call begins and ends.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "backpass.js");

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-warmup-bin-"));
const callLog = path.join(binDir, "calls.log");
const fakeAcpx = path.join(binDir, "acpx");
const fakeClaude = path.join(binDir, "claude");
const fakePi = path.join(binDir, "pi");

fs.writeFileSync(fakeClaude, `#!${process.execPath}\nprocess.stdout.write('{"loggedIn":true}\\n');\n`);
fs.writeFileSync(fakePi, `#!${process.execPath}\nprocess.exit(0);\n`);
// Every call is logged as it begins and ends: `new`/`end` per `sessions new`, `prompt`/`done` per prompt.
fs.writeFileSync(
  fakeAcpx,
  `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
const log = (what) => fs.appendFileSync(${JSON.stringify(callLog)}, what + "\\n");
if (argv.includes("config") && argv.includes("show")) {
  process.stdout.write(JSON.stringify({ agents: {} }) + "\\n");
  process.exit(0);
}
if (argv.includes("sessions") && argv.includes("new")) {
  log("new");
  setTimeout(() => { process.stdout.write("fake-session-id\\n"); process.exit(0); }, 200);
} else if (argv.includes("--file")) {
  const prompt = fs.readFileSync(argv[argv.indexOf("--file") + 1], "utf8");
  const session = /Do the (\\S+) work\\./.exec(prompt)[1];
  log("prompt " + session);
  setTimeout(() => {
    // A session id starting with "fail" returns unparseable text: the model call itself
    // completes (so it is a genuine call attempt), but analysis fails afterward.
    if (session.startsWith("fail")) {
      log("failed " + session);
      process.stdout.write("not json\\n");
      process.exit(0);
    }
    log("done " + session);
    process.stdout.write(JSON.stringify({ positive: [], negative: [], gaps: [] }) + "\\n");
    process.exit(0);
  }, 500);
} else {
  process.exit(0);
}
`,
);
for (const file of [fakeAcpx, fakeClaude, fakePi]) fs.chmodSync(file, 0o755);

function git(args, cwd) {
  spawnSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-warmup-repo-")));
  git(["init", "--quiet", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Agent instructions\n\n- Run `make build` before every push.\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "memory"], dir);
  return dir;
}

function writeSession(home, id, cwd, ageSeconds, trivial = false) {
  const dir = path.join(home, ".pi", "agent", "sessions", id);
  fs.mkdirSync(dir, { recursive: true });
  const entries = [
    { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd },
    { type: "message", message: { role: "user", content: `Do the ${id} work.` } },
    ...(trivial
      ? []
      : [
          { type: "message", message: { role: "assistant", content: "Working on it." } },
          { type: "message", message: { role: "user", content: "Now run the tests too." } },
          { type: "message", message: { role: "assistant", content: "Tests pass." } },
        ]),
  ];
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  const at = new Date(Date.now() - ageSeconds * 1000);
  fs.utimesSync(file, at, at);
}

function analyze(agent, jobs, sessions) {
  fs.rmSync(callLog, { force: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-warmup-home-"));
  const dir = initRepo();
  sessions.forEach((session, index) => writeSession(home, session.id, dir, 60 * (index + 1), session.trivial));
  const result = spawnSync(
    process.execPath,
    [CLI, "analyze", "--harness", "pi", "--since", "all", "--analysis-agent", agent, "--jobs", String(jobs)],
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
      timeout: 60000,
    },
  );
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  return fs.readFileSync(callLog, "utf8").trim().split("\n");
}

const ids = (...names) => names.map((id) => ({ id }));

test("with claude at jobs above one, the first analysis call finishes before any other call starts", () => {
  const calls = analyze("claude", 4, ids("a1", "a2", "a3", "a4", "a5"));
  const firstDone = calls.findIndex((line) => line.startsWith("done "));
  assert.ok(firstDone > 0, calls.join("\n"));
  assert.deepEqual(
    calls.slice(0, firstDone + 1).map((line) => line.split(" ")[0]),
    ["new", "prompt", "done"],
    `nothing else may start while the first call runs:\n${calls.join("\n")}`,
  );
  assert.equal(calls.filter((line) => line.startsWith("done ")).length, 5, "the rest still run");
});

test("a trivial session that makes no model call does not count as the warm-up", () => {
  const calls = analyze("claude", 4, [{ id: "t1", trivial: true }, ...ids("b1", "b2", "b3")]);
  const firstDone = calls.findIndex((line) => line.startsWith("done "));
  assert.deepEqual(
    calls.slice(0, firstDone + 1).map((line) => line.split(" ")[0]),
    ["new", "prompt", "done"],
    calls.join("\n"),
  );
});

test("when the first analysis call fails, it still finishes alone and the rest run together", () => {
  const calls = analyze("claude", 4, [{ id: "failing1" }, ...ids("e1", "e2", "e3", "e4")]);
  const firstEnd = calls.findIndex((line) => line.startsWith("failed ") || line.startsWith("done "));
  assert.ok(firstEnd > 0 && calls[firstEnd].startsWith("failed "), calls.join("\n"));
  assert.deepEqual(
    calls.slice(0, firstEnd + 1).map((line) => line.split(" ")[0]),
    ["new", "prompt", "failed"],
    `nothing else may start while the first (failing) call runs:\n${calls.join("\n")}`,
  );
  const afterFirst = calls.slice(firstEnd + 1);
  assert.ok(
    afterFirst.filter((line) => line.startsWith("prompt ")).length > 1,
    `the remaining calls should overlap, not run one at a time:\n${calls.join("\n")}`,
  );
  assert.equal(afterFirst.filter((line) => line.startsWith("done ")).length, 4, "the rest still run and succeed");
});

test("other agents keep the full fan-out from the first call", () => {
  const calls = analyze("pi", 4, ids("c1", "c2", "c3", "c4", "c5"));
  const firstDone = calls.findIndex((line) => line.startsWith("done "));
  const startedBefore = calls.slice(0, firstDone).filter((line) => line.startsWith("prompt ")).length;
  assert.ok(startedBefore > 1, `calls overlap without the warm-up:\n${calls.join("\n")}`);
});
