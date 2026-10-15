import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { extractJson } from "../src/acpx.js";
import { classifyUnparsedReply, hasGivenUp, replyFailureKey, unparsedReplyTrace } from "../src/analyze.js";
import { MAX_UNPARSED_REPLIES, evidenceKey } from "../src/state.js";

/**
 * An analysis reply with no parseable JSON (issue #193). The failed evidence record keeps
 * a redacted trace of the reply and a class naming why it did not parse, and a transcript
 * that answers unparseably `MAX_UNPARSED_REPLIES` times in a row for the same evidence key
 * and analysis call is skipped - by name - instead of being retried every run.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "backpass.js");

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-failtrace-bin-"));
const fakePi = path.join(binDir, "pi");
const fakeAcpx = path.join(binDir, "acpx");

fs.writeFileSync(fakePi, `#!${process.execPath}\nprocess.exit(0);\n`);
fs.chmodSync(fakePi, 0o755);

// Every prompt turn answers with the contents of FAKE_REPLY_FILE and appends one line to
// FAKE_CALL_LOG, so a test can change the reply between runs and count the model calls.
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
  fs.appendFileSync(process.env.FAKE_CALL_LOG, "call\\n");
  const reply = fs.readFileSync(process.env.FAKE_REPLY_FILE, "utf8");
  // acpx's own timeout exit: a per-transcript failure with no reply to keep.
  if (reply === "__TIMEOUT__") process.exit(3);
  process.stdout.write(reply);
  process.exit(0);
}
process.exit(0);
`,
);
fs.chmodSync(fakeAcpx, 0o755);

const PROSE = "I reviewed the session and the agent followed the build instruction without trouble.";

test("each unparseable reply is classed from its text alone", () => {
  const cases = [
    ["", "empty"],
    [" \n\t ", "empty"],
    ['```json\n{"positive": [], "negative": []', "truncated"],
    ['{"positive": [{"instruction": "AG-001", "quote": "a } brace in a string', "truncated"],
    ['Here is the result:\n{"positive": [{"instruction": "AG-001"}', "truncated"],
    ["{positive: [], negative: []}", "unparsed"],
    ["```json\nnot json at all\n```", "unparsed"],
    [PROSE, "prose"],
  ];
  for (const [reply, expected] of cases) {
    // Every case is a reply the extractor really rejects, so the class is never asked of
    // a reply analysis would have accepted.
    assert.equal(extractJson(reply), null, `extractJson must reject ${JSON.stringify(reply)}`);
    assert.equal(classifyUnparsedReply(reply), expected, JSON.stringify(reply));
  }
});

test("the saved reply trace is redacted before it is cut, and measures the raw reply", () => {
  const key = "sk-ant-abcdefghijklmnopqrstuvwxyz0123";
  const long = `export ANTHROPIC_API_KEY=${key}\n${"x".repeat(1000)}\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz`;
  const trace = unparsedReplyTrace(long);
  assert.equal(trace.class, "prose");
  assert.equal(trace.chars, long.length);
  assert.equal(trace.head.length, 300);
  assert.equal(trace.tail.length, 300);
  assert.ok(!trace.head.includes(key) && !trace.tail.includes("ghp_"), "no secret survives into either snippet");
  assert.match(trace.head, /\[redacted/);
  assert.match(trace.tail, /\[redacted/);

  const short = unparsedReplyTrace(PROSE);
  assert.deepEqual(short, { class: "prose", chars: PROSE.length, head: PROSE }, "a short reply is kept whole");

  const medium = "y".repeat(500);
  assert.deepEqual(unparsedReplyTrace(medium), { class: "prose", chars: 500, head: medium });
});

test("a streak gives up only for the same evidence key and the same analysis call", () => {
  const transcript = { harness: "pi", id: "pi:s", nativeId: "s", contentSignature: "sig" };
  const pick = { agent: "pi", model: "m1", effort: "medium" };
  const key = evidenceKey(transcript, "sha256:a");
  const record = {
    status: "failed",
    key,
    failureKey: replyFailureKey(key, pick),
    unparsedReplies: MAX_UNPARSED_REPLIES,
  };
  assert.equal(hasGivenUp(record, transcript, "sha256:a", pick), true);
  assert.equal(
    hasGivenUp({ ...record, unparsedReplies: MAX_UNPARSED_REPLIES - 1 }, transcript, "sha256:a", pick),
    false,
  );
  assert.equal(hasGivenUp(record, transcript, "sha256:b", pick), false, "a memory change starts over");
  assert.equal(hasGivenUp(record, { ...transcript, contentSignature: "grew" }, "sha256:a", pick), false);
  assert.equal(hasGivenUp(record, transcript, "sha256:a", { ...pick, model: "m2" }), false, "a model change too");
  assert.equal(hasGivenUp(record, transcript, "sha256:a", { ...pick, effort: "high" }), false);
  const legacy = { status: "failed", key, error: "analysis returned no parseable JSON" };
  assert.equal(hasGivenUp(legacy, transcript, "sha256:a", pick), false, "a record from before the count retries");
});

function git(args, cwd) {
  spawnSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(memory) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-failtrace-repo-")));
  git(["init", "--quiet", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), memory);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "memory"], dir);
  return dir;
}

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
  fs.writeFileSync(path.join(dir, `1_${id}.jsonl`), `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

function harness() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-failtrace-home-"));
  const dir = initRepo("# Agent instructions\n\n- Run `make build` before every push.\n");
  writeSession(home, "session-a", dir);
  const replyFile = path.join(home, "reply.txt");
  const callLog = path.join(home, "calls.log");
  fs.writeFileSync(replyFile, PROSE);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    BACKPASS_ACPX_BIN: fakeAcpx,
    FAKE_REPLY_FILE: replyFile,
    FAKE_CALL_LOG: callLog,
    NO_COLOR: "1",
  };
  const cli = (args) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: "utf8", timeout: 20000 });
    return { ...result, output: `${result.stdout}${result.stderr}` };
  };
  const analyze = (extra = []) => {
    const result = cli([
      "analyze",
      "--harness",
      "pi",
      "--since",
      "all",
      "--analysis-agent",
      "pi",
      "--jobs",
      "1",
      ...extra,
    ]);
    assert.equal(result.status, 0, result.output);
    return result;
  };
  const analyzeJson = (extra = []) => {
    const result = analyze(["--json", ...extra]);
    return { ...result, summary: JSON.parse(result.stdout).summary };
  };
  const calls = () =>
    fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8").split("\n").filter(Boolean).length : 0;
  const record = () => {
    const evidenceDir = path.join(dir, ".backpass", "evidence");
    const [file] = fs.readdirSync(evidenceDir).filter((name) => name.endsWith(".json"));
    return JSON.parse(fs.readFileSync(path.join(evidenceDir, file), "utf8"));
  };
  return { dir, replyFile, cli, analyze, analyzeJson, calls, record };
}

test("a failed analysis keeps a redacted, classed trace of the reply", () => {
  const h = harness();
  const reply = `Sorry, I cannot produce JSON. TOKEN=supersecretvalue123\n${"z".repeat(700)}\n{"positive": [`;
  fs.writeFileSync(h.replyFile, reply);

  const run = h.analyzeJson();
  assert.equal(run.summary.failed, 1);
  assert.match(run.stderr, /analysis returned no parseable JSON \(truncated\)/);

  const record = h.record();
  assert.equal(record.status, "failed");
  assert.equal(record.error, "analysis returned no parseable JSON (truncated)");
  assert.equal(record.reply.class, "truncated");
  assert.equal(record.reply.chars, reply.trim().length, "measured from the reply text, not reported by the model");
  assert.ok(!record.reply.head.includes("supersecretvalue123"));
  assert.match(record.reply.head, /TOKEN=\[redacted\]/);
  assert.ok(record.reply.tail.endsWith('{"positive": ['));
  assert.equal(record.unparsedReplies, 1);

  const status = h.cli(["status"]);
  assert.equal(status.status, 0, status.output);
  assert.match(status.stdout, /REPLY\s+NEXT RUN\s+ERROR/);
  assert.match(status.stdout, new RegExp(`truncated · ${record.reply.chars} chars\\s+retry`));
});

test(`after ${MAX_UNPARSED_REPLIES} unparseable replies in a row a transcript is skipped by name until its key changes`, () => {
  const h = harness();
  for (let n = 1; n <= MAX_UNPARSED_REPLIES; n += 1) {
    const run = h.analyzeJson();
    assert.deepEqual([run.summary.failed, run.summary.gaveUp], [1, 0], `run ${n} still calls the model`);
    assert.equal(h.record().unparsedReplies, n);
    assert.equal(h.record().reply.class, "prose");
  }
  assert.equal(h.calls(), MAX_UNPARSED_REPLIES);

  const skipped = h.analyze();
  assert.equal(h.calls(), MAX_UNPARSED_REPLIES, "no model call for a transcript given up on");
  assert.match(skipped.stdout, new RegExp(`0 failed · 1 skipped after ${MAX_UNPARSED_REPLIES} failures`));
  assert.match(skipped.stderr, /1 transcript\(s\) skipped after 3 unparseable replies in a row/);
  assert.equal(h.record().reply.class, "prose", "the last failure trace is kept");
  assert.equal(h.record().status, "failed", "a skipped transcript never counts as evidence");

  const status = h.cli(["status"]);
  assert.match(status.stdout, /1 failed \(1 skipped after 3 failures\)/);
  assert.match(status.stdout, new RegExp(`prose · ${PROSE.length} chars\\s+skipped after 3 failures`));
  const structured = JSON.parse(h.cli(["status", "--json"]).stdout);
  assert.deepEqual([structured.evidence.failed, structured.evidence.gaveUp], [1, 1]);

  // --force asks again; one more unparseable reply keeps the streak.
  assert.equal(h.analyzeJson(["--force"]).summary.failed, 1);
  assert.equal(h.calls(), MAX_UNPARSED_REPLIES + 1);

  // A different analysis model is a new question, so the streak starts over.
  assert.equal(h.analyzeJson(["--analysis-model", "other/model"]).summary.failed, 1);
  assert.equal(h.record().unparsedReplies, 1);
  assert.equal(h.analyzeJson(["--analysis-model", "other/model"]).summary.gaveUp, 0);

  // So is a memory-surface change, and a parseable answer then lands as evidence.
  fs.writeFileSync(path.join(h.dir, "AGENTS.md"), "# Agent instructions\n\n- Always run lint.\n");
  fs.writeFileSync(h.replyFile, JSON.stringify({ positive: [], negative: [], gaps: [] }));
  const recovered = h.analyzeJson();
  assert.deepEqual([recovered.summary.analyzed, recovered.summary.gaveUp], [1, 0]);
  assert.equal(h.record().status, "ok");
});

test("status names a give-up only while the memory surface it gave up at is current", () => {
  const h = harness();
  for (let n = 1; n <= MAX_UNPARSED_REPLIES; n += 1) h.analyzeJson();
  assert.equal(JSON.parse(h.cli(["status", "--json"]).stdout).evidence.gaveUp, 1);

  fs.writeFileSync(path.join(h.dir, "AGENTS.md"), "# Agent instructions\n\n- Always run lint.\n");
  const status = h.cli(["status"]);
  assert.match(status.stdout, new RegExp(`prose · ${PROSE.length} chars\\s+retry`));
  assert.doesNotMatch(status.stdout, /skipped after/);
  assert.equal(JSON.parse(h.cli(["status", "--json"]).stdout).evidence.gaveUp, 0);
  assert.equal(h.analyzeJson().summary.gaveUp, 0, "the next run does retry it");
});

test("a timeout resets the streak and keeps no reply trace", () => {
  const h = harness();
  h.analyzeJson();
  h.analyzeJson();
  assert.equal(h.record().unparsedReplies, 2);

  fs.writeFileSync(h.replyFile, "__TIMEOUT__");
  assert.equal(h.analyzeJson().summary.failed, 1);
  const record = h.record();
  assert.match(record.error, /timeout/);
  assert.equal(record.unparsedReplies, undefined);
  assert.equal(record.reply, undefined);

  fs.writeFileSync(h.replyFile, PROSE);
  h.analyzeJson();
  assert.equal(h.record().unparsedReplies, 1, "the streak counts only consecutive unparseable replies");
});

test("status still lists an older failed record without the trace fields", () => {
  const h = harness();
  h.analyzeJson();
  const evidenceDir = path.join(h.dir, ".backpass", "evidence");
  const [file] = fs.readdirSync(evidenceDir);
  const legacy = h.record();
  delete legacy.reply;
  delete legacy.failureKey;
  delete legacy.unparsedReplies;
  legacy.error = "analysis returned no parseable JSON";
  fs.writeFileSync(path.join(evidenceDir, file), JSON.stringify(legacy));

  const status = h.cli(["status"]);
  assert.equal(status.status, 0, status.output);
  assert.match(status.stdout, /-\s+retry\s+analysis returned no parseable JSON/);

  const run = h.analyzeJson();
  assert.equal(run.summary.failed, 1, "a legacy failed record is retried");
  assert.equal(h.record().unparsedReplies, 1);
});
