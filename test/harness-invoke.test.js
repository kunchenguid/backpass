import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

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
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify(args) + "\\n");
if (!args.includes("--model")) {
  const settings = JSON.parse(fs.readFileSync(process.env.FAKE_HARNESS_SETTINGS, "utf8"));
  process.stdout.write(JSON.stringify({
    provider: settings.defaultProvider,
    model: settings.defaultModel,
    thinking: settings.defaultThinkingLevel,
  }) + "\\n");
}
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
if (argv.includes("config") && argv.includes("show")) {
  const replacement = process.env.FAKE_REPLACEMENT_AGENT;
  const agents = replacement ? { [replacement]: { argv: ["custom-adapter"] } } : {};
  process.stdout.write(JSON.stringify({ agents }) + "\\n");
  process.exit(0);
}
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
function splitAgentCommand(value) {
  const parts = [];
  let current = "";
  let quote = null;
  let escaping = false;
  let hasPart = false;
  for (const ch of value) {
    if (escaping) {
      current += ch;
      escaping = false;
      hasPart = true;
    } else if (ch === "\\\\" && quote !== "'") {
      escaping = true;
    } else if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      hasPart = true;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      hasPart = true;
    } else if (/\\s/.test(ch)) {
      if (hasPart) parts.push(current);
      current = "";
      hasPart = false;
    } else {
      current += ch;
      hasPart = true;
    }
  }
  if (escaping) current += "\\\\";
  if (quote) process.exit(3);
  if (hasPart) parts.push(current);
  return parts;
}
function spawnOverriddenAgent() {
  const at = argv.indexOf("--agent");
  if (at < 0) return;
  const parts = splitAgentCommand(argv[at + 1]);
  spawnSync(parts[0], parts.slice(1), { stdio: "ignore", env: process.env });
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
  process.stdout.write('{"edits":[],"notes":[]}\\n');
  process.exit(0);
}
if (argv.includes("--file")) {
  process.stdout.write('{"edits":[],"notes":[]}\\n');
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
const { prepareHarnessInvocation } = await import("../src/harness-invoke.js");

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

const cli = fileURLToPath(new URL("../bin/backpass.js", import.meta.url));
let cliRun = 0;

function makeCliRepo(label) {
  cliRun += 1;
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `backpass-cli-${label}-`)));
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: repo });
  assert.equal(initialized.status, 0);
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "# Agent instructions\n\n- Keep changes focused.\n");

  const id = `${label}-${cliRun}`;
  const sessionDir = path.join(fakeHome, ".pi", "agent", "sessions", id);
  fs.mkdirSync(sessionDir, { recursive: true });
  const entries = [
    { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: repo },
    { type: "message", message: { role: "user", content: "Please inspect the implementation." } },
    { type: "message", message: { role: "assistant", content: "I inspected the implementation." } },
    { type: "message", message: { role: "user", content: "Now explain the behavior." } },
    { type: "message", message: { role: "assistant", content: "The behavior is isolated per invocation." } },
  ];
  fs.writeFileSync(
    path.join(sessionDir, `${Date.now()}_${id}.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  return repo;
}

function runBackpass(repo, args, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repo,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    timeout: 15_000,
  });
}

function analysisArgs(agent, model, effort = "high") {
  return [
    "analyze",
    "--harness",
    "pi",
    "--since",
    "all",
    "--analysis-agent",
    agent,
    "--analysis-model",
    model,
    "--analysis-effort",
    effort,
    "--jobs",
    "1",
    "--json",
  ];
}

function assertBareDefaults(before) {
  const bare = spawnSync(fakePi, ["--mode", "rpc", "--no-themes"], {
    env: process.env,
    encoding: "utf8",
  });
  assert.equal(bare.status, 0);
  assert.deepEqual(JSON.parse(bare.stdout), { provider: "xai", model: "grok-4.6", thinking: "high" });
  assert.equal(settingsBytes().compare(before), 0);
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

test("a configured replacement Pi adapter is rejected before model or effort can be claimed", async () => {
  resetLogsAndSettings();
  const before = Buffer.from(settingsBytes());
  process.env.FAKE_REPLACEMENT_AGENT = "pi";
  try {
    await assert.rejects(
      () =>
        openSession({
          agent: "pi",
          model: "provider/model",
          effort: "high",
          sessionName: "bp-pi-replaced",
          cwd: workDir,
        }),
      {
        name: "UserError",
        message: /agents\.pi replaces the proven built-in adapter/,
      },
    );
  } finally {
    delete process.env.FAKE_REPLACEMENT_AGENT;
  }
  assert.equal(settingsBytes().compare(before), 0);
  assert.ok(acpxCalls().some((c) => c.argv.includes("config") && c.argv.includes("show")));
  assert.ok(!acpxCalls().some((c) => c.argv.includes("new") || c.argv.includes("exec")));
  assert.deepEqual(jsonl(piLog), []);
});

test("a custom PI_ACP_PI_COMMAND is rejected before launch", async () => {
  resetLogsAndSettings();
  const before = Buffer.from(settingsBytes());
  process.env.PI_ACP_PI_COMMAND = fakePi;
  try {
    await assert.rejects(
      () =>
        openSession({
          agent: "pi",
          model: "provider/model",
          effort: "high",
          sessionName: "bp-pi-custom-command",
          cwd: workDir,
        }),
      { name: "UserError", message: /PI_ACP_PI_COMMAND replaces the proven Pi command/ },
    );
  } finally {
    delete process.env.PI_ACP_PI_COMMAND;
  }
  assert.equal(settingsBytes().compare(before), 0);
  assert.deepEqual(acpxCalls(), []);
  assert.deepEqual(jsonl(piLog), []);
});

test("the process wrapper escalates when its harness child ignores termination", async () => {
  const signalBin = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-signal-bin-"));
  const signalChild = path.join(signalBin, "pi");
  const readyPath = path.join(binDir, "signal-child.ready");
  const signalPath = path.join(binDir, "signal-child.signal");
  fs.writeFileSync(
    signalChild,
    `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(signalPath)}, "SIGTERM");
});
setInterval(() => {}, 1000);
`,
  );
  fs.chmodSync(signalChild, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${signalBin}${path.delimiter}${previousPath || ""}`;
  const invocation = prepareHarnessInvocation({ agent: "pi", model: "provider/model" });
  process.env.PATH = previousPath;

  let wrapper;
  let childPid;
  try {
    wrapper = spawn(invocation.env.PI_ACP_PI_COMMAND, [], { stdio: "ignore" });
    for (let attempt = 0; attempt < 100 && !fs.existsSync(readyPath); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(fs.existsSync(readyPath));
    childPid = Number(fs.readFileSync(readyPath, "utf8"));
    const exited = new Promise((resolve) => wrapper.once("close", (code, signal) => resolve({ code, signal })));
    wrapper.kill("SIGTERM");
    const outcome = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 6000).unref()),
    ]);
    assert.notEqual(outcome, "timeout");
    assert.deepEqual(outcome, { code: null, signal: "SIGKILL" });
    assert.equal(fs.readFileSync(signalPath, "utf8"), "SIGTERM");
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  } finally {
    if (wrapper?.exitCode === null && wrapper?.signalCode === null) wrapper.kill("SIGKILL");
    if (childPid) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // The child may already have exited after the wrapper was killed.
      }
    }
    invocation.dispose();
  }
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

test("configured replacement adapters are rejected for positional built-ins", async () => {
  for (const agent of ["claude", "codex", "opencode"]) {
    resetLogsAndSettings();
    const before = Buffer.from(settingsBytes());
    process.env.FAKE_REPLACEMENT_AGENT = agent;
    try {
      await assert.rejects(
        () =>
          openSession({
            agent,
            model: "safe-model",
            effort: "high",
            sessionName: `bp-${agent}-replacement`,
            cwd: workDir,
          }),
        { name: "UserError", message: new RegExp(`agents\\.${agent} replaces the proven built-in adapter`) },
      );
    } finally {
      delete process.env.FAKE_REPLACEMENT_AGENT;
    }
    assert.equal(settingsBytes().compare(before), 0);
    assert.ok(!acpxCalls().some((c) => c.argv.includes("new") || c.argv.includes("exec")));
  }
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

test("the Backpass CLI applies Pi overlays without changing persistent defaults", () => {
  resetLogsAndSettings();
  const before = Buffer.from(settingsBytes());
  const repo = makeCliRepo("pi-analysis");
  const result = runBackpass(repo, analysisArgs("pi", "openai-codex/gpt-5.6-sol"));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(settingsBytes().compare(before), 0);
  const spawned = jsonl(piLog);
  assert.ok(spawned.length >= 1);
  assert.deepEqual(spawned[0].slice(0, 4), ["--model", "openai-codex/gpt-5.6-sol", "--thinking", "high"]);
  assert.deepEqual(spawned[0].slice(4), ["--mode", "rpc", "--no-themes"]);
  assertBareDefaults(before);
});

test("the Backpass CLI preserves safe argument handling for Pi", () => {
  resetLogsAndSettings();
  const before = Buffer.from(settingsBytes());
  const repo = makeCliRepo("pi-literal");
  const pwned = path.join(repo, "pwned");
  const model = `provider/foo bar $(touch "${pwned}")`;
  const result = runBackpass(repo, analysisArgs("pi", model, "medium"));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!fs.existsSync(pwned));
  assert.deepEqual(jsonl(piLog)[0].slice(0, 4), ["--model", model, "--thinking", "medium"]);
  assertBareDefaults(before);
});

test("the Backpass CLI uses verified overlays for every positional harness", () => {
  const cases = [
    { agent: "claude", model: "claude-opus-5", effortKey: "effort" },
    { agent: "codex", model: "gpt-5.6-sol", effortKey: "reasoning_effort" },
    { agent: "opencode", model: "openai/gpt-5.6-sol", effortKey: null },
  ];
  for (const { agent, model, effortKey } of cases) {
    resetLogsAndSettings();
    const before = Buffer.from(settingsBytes());
    const repo = makeCliRepo(`${agent}-analysis`);
    const result = runBackpass(repo, analysisArgs(agent, model));
    assert.equal(result.status, 0, result.stderr);
    const calls = acpxCalls();
    const created = calls.find((call) => call.argv.includes("new"));
    assert.equal(created.argv[created.argv.indexOf("--model") + 1], model);
    const effortCalls = setCalls(calls);
    assert.deepEqual(effortCalls.map(setKey), effortKey ? [effortKey] : []);
    assert.equal(settingsBytes().compare(before), 0);
    assertBareDefaults(before);
  }
});

test("the Backpass CLI applies Grok model and effort as process arguments", () => {
  resetLogsAndSettings();
  const before = Buffer.from(settingsBytes());
  const repo = makeCliRepo("grok-analysis");
  const spacedTmp = path.join(repo, "temporary 'files\\with\nspaces");
  fs.mkdirSync(spacedTmp);
  const result = runBackpass(repo, analysisArgs("grok", "grok-4.6"), { TMPDIR: spacedTmp });
  assert.equal(result.status, 0, result.stderr);
  const calls = acpxCalls();
  assert.ok(calls.every((call) => !call.argv.includes("grok-build")));
  const spawned = jsonl(grokLog);
  assert.deepEqual(spawned[0], ["-m", "grok-4.6", "--reasoning-effort", "high", "agent", "stdio"]);
  assert.equal(settingsBytes().compare(before), 0);
  assertBareDefaults(before);
});

test("the Backpass CLI preserves safe process fallbacks and rejects unsafe ones", () => {
  for (const agent of ["pi", "grok", "opencode"]) {
    resetLogsAndSettings();
    const before = Buffer.from(settingsBytes());
    const repo = makeCliRepo(`${agent}-fallback`);
    const model = agent === "grok" ? "grok-4.6" : "safe-model";
    const result = runBackpass(repo, analysisArgs(agent, model), { FAKE_SESSIONS_UNSUPPORTED: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(acpxCalls().some((call) => call.argv.includes("exec")));
    if (agent === "pi") assert.ok(jsonl(piLog)[0].includes("--thinking"));
    if (agent === "grok") assert.ok(jsonl(grokLog)[0].includes("--reasoning-effort"));
    if (agent === "opencode") assert.match(result.stderr, /ran without effort=high/);
    assert.equal(settingsBytes().compare(before), 0);
    assertBareDefaults(before);
  }

  for (const agent of ["claude", "codex"]) {
    resetLogsAndSettings();
    const before = Buffer.from(settingsBytes());
    const repo = makeCliRepo(`${agent}-unsafe-fallback`);
    const result = runBackpass(repo, analysisArgs(agent, "safe-model"), { FAKE_SESSIONS_UNSUPPORTED: "1" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`${agent} cannot apply invocation-scoped effort=high`));
    assert.match(result.stderr, /upgrade acpx or omit the effort override/);
    assert.ok(!acpxCalls().some((call) => call.argv.includes("exec")));
    assert.equal(settingsBytes().compare(before), 0);
    assertBareDefaults(before);
  }
});

test("the Backpass CLI keeps Pi synthesis overlays invocation-scoped", () => {
  resetLogsAndSettings();
  const before = Buffer.from(settingsBytes());
  const repo = makeCliRepo("pi-synthesis");
  const result = runBackpass(repo, [
    "--harness",
    "pi",
    "--since",
    "all",
    "--analysis-agent",
    "pi",
    "--analysis-model",
    "openai-codex/gpt-5.6-luna",
    "--analysis-effort",
    "medium",
    "--synthesis-agent",
    "pi",
    "--synthesis-model",
    "openai-codex/gpt-5.6-sol",
    "--synthesis-effort",
    "high",
    "--jobs",
    "1",
    "--json",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const spawned = jsonl(piLog);
  assert.ok(spawned.some((args) => args[1] === "openai-codex/gpt-5.6-luna" && args[3] === "medium"));
  assert.ok(spawned.some((args) => args[1] === "openai-codex/gpt-5.6-sol" && args[3] === "high"));
  assert.ok(
    !acpxCalls().some((call) => call.argv.includes("set") && ["model", "thought_level"].includes(setKey(call))),
  );
  assert.equal(settingsBytes().compare(before), 0);
  assertBareDefaults(before);
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
