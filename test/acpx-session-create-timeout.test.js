import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Regression for a real backpass run against acpx 0.13.0.
 *
 * acpx spawns most built-in ACP adapters through an npm package-exec bridge, so
 * `sessions new` can sit for minutes before the adapter process exists. backpass kills
 * the call on its own timeout, and acpx exits 130 on SIGTERM with nothing on stderr -
 * a plain non-zero exit. Read generically that landed in the `unsupported` branch, and
 * every stalled harness (claude, codex, pi) failed the run with "its acpx adapter does
 * not support sessions - upgrade acpx or omit the effort override". All three claims
 * were false and the advice could not help. `timedOut` is the only signal that
 * separates the two, so it has to be read before the exit code.
 */
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-acpx-create-timeout-"));
const promptFile = path.join(fixtureDir, "prompt.md");
fs.writeFileSync(promptFile, "analyze this\n");

/**
 * One fake acpx, two behaviours picked at spawn time by `FAKE_ACPX_MODE`:
 *   hang        `sessions new` never answers, then exits 130 on SIGTERM as acpx does
 *   no-sessions `sessions new` is rejected outright, the genuine unsupported case
 *   model-rejected `sessions new` fails after the adapter turned down `--model`
 * `ACPX_BIN` is bound when `src/acpx.js` is imported, so the mode cannot be a second path.
 */
const fakeAcpx = path.join(fixtureDir, "acpx");
fs.writeFileSync(
  fakeAcpx,
  `#!${process.execPath}
const argv = process.argv.slice(2);
// An effort overlay verifies the adapter config before creating the session.
if (argv.includes("config") && argv.includes("show")) {
  process.stdout.write(JSON.stringify({ agents: {} }));
  process.exit(0);
}
const creating = argv.includes("sessions") && argv.includes("new");
const status = argv.includes("status");
const closing = argv.includes("sessions") && argv.includes("close");
if (creating && process.env.FAKE_ACPX_MODE === "timeout-exit") {
  process.stderr.write(process.env.FAKE_ACPX_STDERR || "");
  process.exit(3);
}
if (creating && process.env.FAKE_ACPX_MODE === "no-sessions") {
  process.stderr.write("error: unknown command 'sessions'\\n");
  process.exit(2);
}
if (creating && process.env.FAKE_ACPX_MODE === "model-rejected") {
  process.stderr.write(process.env.FAKE_ACPX_STDERR || "");
  process.exit(1);
}
if (creating && process.env.FAKE_ACPX_MODE === "scoped-timeouts") {
  setTimeout(() => process.exit(0), 300);
} else if ((status || closing) && process.env.FAKE_ACPX_MODE === "scoped-timeouts") {
  process.on("SIGTERM", () => process.exit(130));
  setInterval(() => {}, 1000);
} else if (creating) {
  process.on("SIGTERM", () => process.exit(130));
  setInterval(() => {}, 1000);
} else {
  process.exit(0);
}
`,
);
fs.chmodSync(fakeAcpx, 0o755);

process.env.BACKPASS_ACPX_BIN = fakeAcpx;
process.env.FAKE_ACPX_MODE = "hang";
const { AcpxError, classifyAcpxFailure, openSession, probeSession, sessionPrompt } = await import("../src/acpx.js");
const { UserError } = await import("../src/logger.js");

test.after(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test("a session-create timeout is named as a timeout, not as missing session support", async () => {
  await assert.rejects(
    () =>
      openSession({ agent: "codex", sessionName: "backpass-create-timeout", cwd: fixtureDir, createTimeoutMs: 1500 }),
    (err) => {
      assert.ok(err instanceof UserError, String(err));
      assert.equal(err.message, "acpx codex did not create a session within 2s");
      assert.doesNotMatch(err.message, /support/i);
      assert.doesNotMatch(String(err.hint), /upgrade acpx/i);
      assert.match(String(err.hint), /adapter did not finish starting/);
      assert.match(String(err.hint), /adapter initialization or a cold or stalled npm package fetch/);
      return true;
    },
  );
});

test("a stalled harness no longer claims the effort override is unsupported", async () => {
  await assert.rejects(
    () =>
      sessionPrompt({
        agent: "codex",
        effort: "medium",
        sessionName: "backpass-create-timeout-effort",
        promptFile,
        cwd: fixtureDir,
        createTimeoutMs: 1500,
      }),
    (err) => {
      assert.ok(err instanceof UserError, String(err));
      assert.doesNotMatch(err.message, /does not support sessions/);
      assert.match(err.message, /did not create a session within/);
      return true;
    },
  );
});

for (const [scenario, stderr, detail] of [
  ["empty stderr", "", ""],
  ["accounting only", "[acpx] tokens: input=0 output=0 total=0\n", ""],
  ["adapter error", "\nadapter startup timed out\nextra detail\n", ": adapter startup timed out"],
  [
    "quiet-mode error after accounting",
    "[acpx] tokens: input=0 output=0 total=0\n[acpx] error: TIMEOUT GEMINI_ACP_STARTUP_TIMEOUT adapter startup timed out\n",
    ": [acpx] error: TIMEOUT GEMINI_ACP_STARTUP_TIMEOUT adapter startup timed out",
  ],
  [
    "noise before adapter error",
    "[acpx] tokens: input=0 output=0 total=0\n[acpx] session closed\nadapter startup timed out\nextra detail\n",
    ": adapter startup timed out",
  ],
]) {
  test(`acpx timeout exit identifies session creation and probing without noise: ${scenario}`, async () => {
    process.env.FAKE_ACPX_MODE = "timeout-exit";
    process.env.FAKE_ACPX_STDERR = stderr;
    try {
      const options = { agent: "codex", sessionName: "backpass-create-timeout-exit", cwd: fixtureDir };
      const message = `acpx codex session create ended at its own timeout (exit 3)${detail}`;
      const named = (err) => {
        assert.ok(err instanceof UserError, String(err));
        assert.equal(err.message, message);
        assert.equal(err.hint, "check with: acpx --verbose codex sessions new --name backpass-probe");
        return true;
      };
      await assert.rejects(() => openSession(options), named);
      await assert.rejects(() => sessionPrompt({ ...options, effort: "medium", promptFile }), named);
      assert.deepEqual(await probeSession(options), {
        verdict: "timeout",
        detail: `acpx codex probe ended at its own timeout (exit 3)${detail}`,
        availableModels: [],
      });
    } finally {
      process.env.FAKE_ACPX_MODE = "hang";
      delete process.env.FAKE_ACPX_STDERR;
    }
  });
}

test("an adapter that really rejects sessions still reports missing session support", async () => {
  process.env.FAKE_ACPX_MODE = "no-sessions";
  try {
    await assert.rejects(
      () =>
        openSession({ agent: "codex", sessionName: "backpass-no-sessions", cwd: fixtureDir, createTimeoutMs: 1500 }),
      (err) => {
        assert.ok(err instanceof AcpxError, String(err));
        assert.equal(err.unsupported, true);
        assert.match(err.message, /has no session support/);
        return true;
      },
    );
  } finally {
    process.env.FAKE_ACPX_MODE = "hang";
  }
});

/**
 * Regression for a real run with acpx 0.19.6 and claude-agent-acp 0.81.2. A Claude Code
 * build that predates the pinned model leaves it out of the advertised list, the adapter
 * turns down `--model` after `session/new`, and acpx exits 1. Read as unsupported, the
 * pinned analysis pass stopped with "its acpx adapter does not support sessions - upgrade
 * acpx or omit the effort override", although sessions worked and acpx was current.
 */
test("an adapter that turns down the pinned model is named as a model failure, not missing session support", async () => {
  process.env.FAKE_ACPX_MODE = "model-rejected";
  process.env.FAKE_ACPX_STDERR =
    '[acpx] warning: requested model "claude-haiku-5-5" was not in the Claude ACP advertised model list (default, sonnet); forwarding it to Claude Code so the adapter can accept or reject it.\n' +
    'Failed session/set_config_option for model "claude-haiku-5-5": Invalid value for config option model: claude-haiku-5-5 (ACP -32603, adapter reported "Internal error")\n';
  try {
    const options = {
      agent: "claude",
      model: "claude-haiku-5-5",
      sessionName: "backpass-model-rejected",
      cwd: fixtureDir,
      createTimeoutMs: 1500,
    };
    const named = (err) => {
      assert.ok(err instanceof AcpxError, String(err));
      assert.notEqual(err.unsupported, true);
      assert.match(err.message, /^acpx claude session create failed: /);
      assert.equal(classifyAcpxFailure(err), "model-unavailable");
      return true;
    };
    await assert.rejects(() => openSession(options), named);
    await assert.rejects(() => sessionPrompt({ ...options, effort: "medium", promptFile }), named);
  } finally {
    process.env.FAKE_ACPX_MODE = "hang";
    delete process.env.FAKE_ACPX_STDERR;
  }
});

test("the availability probe scopes the cold-start budget to session creation", async () => {
  process.env.FAKE_ACPX_MODE = "scoped-timeouts";
  const startedAt = Date.now();
  try {
    const result = await probeSession({
      agent: "codex",
      sessionName: "backpass-scoped-timeouts",
      cwd: fixtureDir,
      timeoutMs: 100,
      createTimeoutMs: 1_000,
    });

    assert.equal(result.verdict, "ok");
    assert.ok(Date.now() - startedAt < 1_500, "status and close exceeded the short operation budget");
  } finally {
    process.env.FAKE_ACPX_MODE = "hang";
  }
});
