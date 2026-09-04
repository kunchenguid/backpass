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
if (creating && process.env.FAKE_ACPX_MODE === "no-sessions") {
  process.stderr.write("error: unknown command 'sessions'\\n");
  process.exit(2);
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
const { AcpxError, openSession, probeSession, sessionPrompt } = await import("../src/acpx.js");
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
