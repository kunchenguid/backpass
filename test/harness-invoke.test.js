import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Isolated harness-default mutation coverage.
 *
 * End-user failure: Backpass synthesis selected a Pi model via ACP `set model`,
 * which Pi persists into `settings.json`. A later bare Pi launch then inherited
 * that default. Isolated reproduction (temp PI_CODING_AGENT_DIR, live settings
 * never touched): RPC `set_model` / `set_thinking_level` rewrite defaults;
 * `pi --model` / `--thinking` at process start do not.
 *
 * This file drives Backpass's public acpx boundary against a fake acpx that
 * mutates a settings fixture on `set model` / `set thought_level` (the persist
 * path) and, when Backpass injects a process wrapper, actually spawns it the
 * way pi-acp spawns `pi --mode rpc --no-themes`. Assertions are launched argv,
 * wrapper-forwarded process argv, and byte-for-byte settings stability.
 */

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-harness-home-"));
process.env.HOME = fakeHome;

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-harness-bin-"));
const fakeAcpx = path.join(binDir, "acpx");
const fakePi = path.join(binDir, "pi");
const fakeGrok = path.join(binDir, "grok");
const settingsPath = path.join(fakeHome, ".pi", "agent", "settings.json");
const acpxLog = path.join(binDir, "acpx.log");
const piLog = path.join(binDir, "pi.log");
const grokLog = path.join(binDir, "grok.log");
const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-harness-cwd-")));

const ORIGINAL_SETTINGS = `{
  "lastChangelogVersion": "0.84.1",
  "defaultProvider": "xai",
  "defaultModel": "grok-4.6",
  "defaultThinkingLevel": "high"
}
`;

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, ORIGINAL_SETTINGS);

fs.writeFileSync(
  fakePi,
  `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(0);
`,
);
fs.chmodSync(fakePi, 0o755);

fs.writeFileSync(
  fakeGrok,
  `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_GROK_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(0);
`,
);
fs.chmodSync(fakeGrok, 0o755);

fs.writeFileSync(
  fakeAcpx,
  `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_ACPX_LOG, JSON.stringify({
  argv,
  cwd: process.cwd(),
  PI_ACP_PI_COMMAND: process.env.PI_ACP_PI_COMMAND || null,
}) + "\\n");
const settings = process.env.FAKE_HARNESS_SETTINGS;
const setAt = argv.indexOf("set");
if (setAt >= 0) {
  const key = argv[setAt + 1];
  if (key === "model" || key === "thought_level") {
    fs.writeFileSync(settings, JSON.stringify({ mutated: true, key }));
  }
  process.exit(0);
}
function spawnWrappedPi() {
  const wrap = process.env.PI_ACP_PI_COMMAND;
  if (!wrap) return;
  spawnSync(wrap, ["--mode", "rpc", "--no-themes"], { stdio: "ignore", env: process.env });
}
function spawnOverriddenAgent() {
  const at = argv.indexOf("--agent");
  if (at < 0) return;
  spawnSync(argv[at + 1], [], { stdio: "ignore", env: process.env });
}
if (argv.includes("sessions") && argv.includes("new")) {
  if (process.env.FAKE_SESSIONS_UNSUPPORTED === "1") {
    process.stderr.write("sessions unsupported\\n");
    process.exit(2);
  }
  spawnWrappedPi();
  spawnOverriddenAgent();
  process.exit(0);
}
if (argv.includes("exec")) {
  spawnWrappedPi();
  spawnOverriddenAgent();
  process.stdout.write('{"ok":true}\\n');
  process.exit(0);
}
if (argv.includes("--file")) {
  process.stdout.write('{"ok":true}\\n');
  process.exit(0);
}
process.exit(0);
`,
);
fs.chmodSync(fakeAcpx, 0o755);

process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH || ""}`;
process.env.BACKPASS_ACPX_BIN = fakeAcpx;
process.env.FAKE_ACPX_LOG = acpxLog;
process.env.FAKE_PI_LOG = piLog;
process.env.FAKE_GROK_LOG = grokLog;
process.env.FAKE_HARNESS_SETTINGS = settingsPath;
fs.writeFileSync(acpxLog, "");
fs.writeFileSync(piLog, "");
fs.writeFileSync(grokLog, "");

const { execOneShot, openSession, sessionPrompt } = await import("../src/acpx.js");

const promptFile = path.join(binDir, "prompt.md");
fs.writeFileSync(promptFile, "<!-- backpass:self-session -->\nping\n");

function resetLogsAndSettings() {
  fs.writeFileSync(settingsPath, ORIGINAL_SETTINGS);
  fs.writeFileSync(acpxLog, "");
  fs.writeFileSync(piLog, "");
  fs.writeFileSync(grokLog, "");
}

function settingsBytes() {
  return fs.readFileSync(settingsPath);
}

function acpxCalls() {
  const text = fs.readFileSync(acpxLog, "utf8").trim();
  if (!text) return [];
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function jsonl(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return [];
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function setCalls(calls) {
  return calls.filter((c) => c.argv.includes("set"));
}

function setKey(call) {
  const i = call.argv.indexOf("set");
  return i >= 0 ? call.argv[i + 1] : null;
}

test("ACP set model against the isolated fixture is the persist path (pre-fix counterfactual)", () => {
  resetLogsAndSettings();
  const before = settingsBytes();
  const result = spawnSync(fakeAcpx, ["pi", "-s", "x", "set", "model", "openai-codex/gpt-5.6-sol"], {
    env: process.env,
  });
  assert.equal(result.status, 0);
  assert.notEqual(settingsBytes().compare(before), 0, "set model must dirty the fixture so later tests are meaningful");
});

test("a Pi session with model and effort uses process --model/--thinking and leaves defaults unchanged", async () => {
  resetLogsAndSettings();
  const before = Buffer.from(settingsBytes());
  const session = await openSession({
    agent: "pi",
    model: "openai-codex/gpt-5.6-sol",
    effort: "high",
    sessionName: "bp-pi",
    cwd: workDir,
  });
  await session.close();

  assert.equal(settingsBytes().compare(before), 0);
  const calls = acpxCalls();
  assert.ok(calls.some((c) => c.argv.includes("new")));
  assert.ok(!calls.some((c) => c.argv.includes("--model")), "acpx --model is Pi's persist path");
  assert.deepEqual(setCalls(calls).map(setKey), [], "Pi must not ACP-set model or thought_level");
  const spawned = jsonl(piLog);
  assert.ok(spawned.length >= 1);
  assert.deepEqual(spawned[0].slice(0, 4), ["--model", "openai-codex/gpt-5.6-sol", "--thinking", "high"]);
  assert.deepEqual(spawned[0].slice(4), ["--mode", "rpc", "--no-themes"]);

  const bare = spawnSync(fakePi, ["--mode", "rpc", "--no-themes"], { env: process.env });
  assert.equal(bare.status, 0);
  assert.equal(settingsBytes().compare(before), 0);
  const defaults = JSON.parse(settingsBytes().toString("utf8"));
  assert.equal(defaults.defaultProvider, "xai");
  assert.equal(defaults.defaultModel, "grok-4.6");
  assert.equal(defaults.defaultThinkingLevel, "high");
});

test("Pi process args keep values that need literal handling, including $() and spaces", async () => {
  resetLogsAndSettings();
  const pwned = path.join(fakeHome, "pwned");
  const before = Buffer.from(settingsBytes());
  const model = 'provider/foo bar $(touch "' + pwned + '")';
  const session = await openSession({
    agent: "pi",
    model,
    effort: "medium",
    sessionName: "bp-pi-quoted",
    cwd: workDir,
  });
  await session.close();
  assert.equal(settingsBytes().compare(before), 0);
  assert.ok(!fs.existsSync(pwned), "model text must not be expanded by a shell");
  const spawned = jsonl(piLog);
  assert.equal(spawned[0][0], "--model");
  assert.equal(spawned[0][1], model);
  assert.equal(spawned[0][2], "--thinking");
  assert.equal(spawned[0][3], "medium");
});

test("Pi exec one-shot with a model also uses process --model and does not persist", async () => {
  resetLogsAndSettings();
  const before = Buffer.from(settingsBytes());
  await execOneShot({
    agent: "pi",
    model: "openai-codex/gpt-5.6-sol:medium",
    promptFile,
    cwd: workDir,
    timeoutSeconds: 5,
  });
  assert.equal(settingsBytes().compare(before), 0);
  const calls = acpxCalls();
  assert.ok(calls.some((c) => c.argv.includes("exec")));
  assert.ok(!calls.some((c) => c.argv.includes("--model")));
  assert.deepEqual(setCalls(calls).map(setKey), []);
  const spawned = jsonl(piLog);
  assert.deepEqual(spawned[0].slice(0, 2), ["--model", "openai-codex/gpt-5.6-sol:medium"]);
  assert.deepEqual(spawned[0].slice(2), ["--mode", "rpc", "--no-themes"]);
});

test("Pi with no model or effort overlay does not wrap and does not persist", async () => {
  resetLogsAndSettings();
  const before = Buffer.from(settingsBytes());
  const session = await openSession({ agent: "pi", sessionName: "bp-pi-default", cwd: workDir });
  await session.close();
  assert.equal(settingsBytes().compare(before), 0);
  const calls = acpxCalls();
  assert.ok(calls.every((c) => !c.PI_ACP_PI_COMMAND));
  assert.ok(!calls.some((c) => c.argv.includes("--model")));
  assert.deepEqual(setCalls(calls).map(setKey), []);
  assert.deepEqual(jsonl(piLog), []);
});

test("Claude session passes --model at create and ACP set effort, never set model", async () => {
  resetLogsAndSettings();
  const before = Buffer.from(settingsBytes());
  const session = await openSession({
    agent: "claude",
    model: "claude-opus-5",
    effort: "high",
    sessionName: "bp-claude",
    cwd: workDir,
  });
  await session.close();
  assert.equal(settingsBytes().compare(before), 0);
  const calls = acpxCalls();
  const created = calls.find((c) => c.argv.includes("new"));
  assert.equal(created.argv[created.argv.indexOf("--model") + 1], "claude-opus-5");
  assert.deepEqual(setCalls(calls).map(setKey), ["effort"]);
  assert.ok(!setCalls(calls).some((c) => setKey(c) === "model"));
});

test("Codex session passes --model at create and ACP set reasoning_effort, never set model", async () => {
  resetLogsAndSettings();
  const before = Buffer.from(settingsBytes());
  const session = await openSession({
    agent: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    sessionName: "bp-codex",
    cwd: workDir,
  });
  await session.close();
  assert.equal(settingsBytes().compare(before), 0);
  const calls = acpxCalls();
  const created = calls.find((c) => c.argv.includes("new"));
  assert.equal(created.argv[created.argv.indexOf("--model") + 1], "gpt-5.6-sol");
  assert.deepEqual(setCalls(calls).map(setKey), ["reasoning_effort"]);
});

test("OpenCode session passes --model at create, skips effort, and does not persist", async () => {
  resetLogsAndSettings();
  const before = Buffer.from(settingsBytes());
  const session = await openSession({
    agent: "opencode",
    model: "gpt-5.6-sol",
    effort: "high",
    sessionName: "bp-opencode",
    cwd: workDir,
  });
  assert.match(session.notes.join("\n"), /does not advertise a reasoning-effort option/);
  await session.close();
  assert.equal(settingsBytes().compare(before), 0);
  const calls = acpxCalls();
  const created = calls.find((c) => c.argv.includes("new"));
  assert.equal(created.argv[created.argv.indexOf("--model") + 1], "gpt-5.6-sol");
  assert.deepEqual(setCalls(calls).map(setKey), []);
});

test("Grok session forces an acpx raw-command override with process model and effort", async () => {
  resetLogsAndSettings();
  const before = Buffer.from(settingsBytes());
  const session = await openSession({
    agent: "grok",
    model: "grok-4.6",
    effort: "high",
    sessionName: "bp-grok",
    cwd: workDir,
  });
  await session.close();

  assert.equal(settingsBytes().compare(before), 0);
  const calls = acpxCalls();
  assert.ok(calls.every((c) => c.argv.includes("--agent")));
  assert.ok(calls.every((c) => !c.argv.includes("grok-build")));
  assert.ok(!calls.some((c) => c.argv.includes("--model")));
  assert.deepEqual(setCalls(calls).map(setKey), []);
  const spawned = jsonl(grokLog);
  assert.ok(spawned.length >= 1);
  assert.deepEqual(spawned[0].slice(0, 4), ["-m", "grok-4.6", "--reasoning-effort", "high"]);
  assert.deepEqual(spawned[0].slice(4), ["agent", "stdio"]);
});

test("Pi and Grok retain process effort when session fallback uses exec", async () => {
  for (const agent of ["pi", "grok"]) {
    resetLogsAndSettings();
    process.env.FAKE_SESSIONS_UNSUPPORTED = "1";
    try {
      const result = await sessionPrompt({
        agent,
        model: agent === "pi" ? "provider/model" : "grok-4.6",
        effort: "high",
        sessionName: `bp-${agent}-fallback`,
        promptFile,
        cwd: workDir,
        timeoutSeconds: 5,
      });
      assert.match(result.notes.join("\n"), /fell back to exec one-shot/);
    } finally {
      delete process.env.FAKE_SESSIONS_UNSUPPORTED;
    }
    const spawned = jsonl(agent === "pi" ? piLog : grokLog);
    assert.ok(spawned.length >= 1);
    assert.ok(spawned.some((args) => args.includes(agent === "pi" ? "--thinking" : "--reasoning-effort")));
  }
});

test("OpenCode session fallback keeps its authorized effort omission visible", async () => {
  resetLogsAndSettings();
  process.env.FAKE_SESSIONS_UNSUPPORTED = "1";
  let result;
  try {
    result = await sessionPrompt({
      agent: "opencode",
      model: "safe-model",
      effort: "high",
      sessionName: "bp-opencode-fallback",
      promptFile,
      cwd: workDir,
      timeoutSeconds: 5,
    });
  } finally {
    delete process.env.FAKE_SESSIONS_UNSUPPORTED;
  }
  assert.match(result.notes.join("\n"), /ran without effort=high/);
  const exec = acpxCalls().find((c) => c.argv.includes("exec"));
  assert.equal(exec.argv[exec.argv.indexOf("--model") + 1], "safe-model");
});

test("Claude and Codex stop when effort cannot be applied without a session", async () => {
  for (const agent of ["claude", "codex"]) {
    resetLogsAndSettings();
    process.env.FAKE_SESSIONS_UNSUPPORTED = "1";
    try {
      await assert.rejects(
        () =>
          sessionPrompt({
            agent,
            model: "safe-model",
            effort: "high",
            sessionName: `bp-${agent}-fallback`,
            promptFile,
            cwd: workDir,
            timeoutSeconds: 5,
          }),
        { name: "UserError", message: /cannot apply invocation-scoped effort=high/ },
      );
    } finally {
      delete process.env.FAKE_SESSIONS_UNSUPPORTED;
    }
    assert.ok(!acpxCalls().some((c) => c.argv.includes("exec")));
  }
});

test("an unsupported harness with a requested model stops instead of persisting", async () => {
  resetLogsAndSettings();
  const before = Buffer.from(settingsBytes());
  await assert.rejects(
    () =>
      openSession({
        agent: "cursor",
        model: "composer-2.5",
        sessionName: "bp-cursor",
        cwd: workDir,
      }),
    { name: "UserError", message: /no proven invocation-scoped way/ },
  );
  assert.equal(settingsBytes().compare(before), 0);
  assert.deepEqual(acpxCalls(), []);
});
