import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Regression for a real backpass run (upstream issue #143): acpx enforces `--timeout`
 * itself, and when it kills the model call at the budget, `--format quiet` exits clean
 * with blank output. backpass's own kill fires 30s later (`result.timedOut`), so the
 * blank result reached `assertNonEmptyOutput` as `empty-output` - a verdict whose
 * hints point at exhausted credits, misreporting a timeout as a provider problem.
 * Wall clock at the budget is the signal that names it a timeout instead.
 *
 * One fake acpx, two behaviours picked at spawn time by `FAKE_ACPX_MODE`:
 *   budget-blank the model turn sleeps out its `--timeout` budget, then exits 0 with
 *     no output - the acpx kill exactly as backpass sees it
 *   fast-blank  the model turn exits 0 with no output immediately - a genuine silent
 *     provider failure, which must keep the empty-output diagnosis
 */
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-acpx-exec-timeout-"));
const promptFile = path.join(fixtureDir, "prompt.md");
fs.writeFileSync(promptFile, "analyze this\n");

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
// Session management calls succeed silently, as acpx's do.
if (argv.includes("sessions") || argv.includes("set") || argv.includes("set-mode")) process.exit(0);
// The one model turn: an exec one-shot or a session prompt, both carrying --file.
if (argv.includes("--file") && process.env.FAKE_ACPX_MODE === "budget-blank") {
  const budgetMs = Number(argv[argv.indexOf("--timeout") + 1]) * 1000;
  if (Number.isFinite(budgetMs) && budgetMs > 0) setTimeout(() => process.exit(0), budgetMs);
  else process.exit(0);
} else {
  process.exit(0);
}
`,
);
fs.chmodSync(fakeAcpx, 0o755);

process.env.BACKPASS_ACPX_BIN = fakeAcpx;
process.env.FAKE_ACPX_MODE = "budget-blank";
const { AcpxError, assertNonEmptyOutput, classifyAcpxFailure, execOneShot, sessionPrompt } =
  await import("../src/acpx.js");

test.after(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test("an exec killed by acpx at its --timeout budget is named a timeout, not empty-output", async () => {
  await assert.rejects(
    () => execOneShot({ agent: "codex", promptFile, cwd: fixtureDir, timeoutSeconds: 2 }),
    (err) => {
      assert.ok(err instanceof AcpxError, String(err));
      assert.equal(err.message, "acpx codex exec timed out after 2s");
      assert.equal(err.timedOut, true);
      assert.equal(err.emptyOutput, false);
      // A timeout on real work is deliberately unclassifiable: the ladder never
      // silently switches models because a prompt ran long.
      assert.equal(classifyAcpxFailure(err), null);
      return true;
    },
  );
});

test("a blank exec clearly short of the budget keeps the empty-output diagnosis", async () => {
  process.env.FAKE_ACPX_MODE = "fast-blank";
  try {
    const result = await execOneShot({ agent: "codex", promptFile, cwd: fixtureDir, timeoutSeconds: 2 });
    assert.equal(result.text, "");
    assert.throws(
      () => assertNonEmptyOutput(result, { agent: "codex", model: null }),
      (err) => {
        assert.ok(err instanceof AcpxError, String(err));
        assert.equal(err.emptyOutput, true);
        assert.equal(classifyAcpxFailure(err), "empty-output");
        return true;
      },
    );
  } finally {
    process.env.FAKE_ACPX_MODE = "budget-blank";
  }
});

// The default analysis pick carries an effort for every harness but OpenCode, so the
// session prompt - not the exec one-shot - is the route a default run actually takes.
test("a session prompt killed by acpx at its --timeout budget is named a timeout, not empty-output", async () => {
  await assert.rejects(
    () =>
      sessionPrompt({
        agent: "codex",
        effort: "medium",
        sessionName: "backpass-exec-timeout-budget",
        promptFile,
        cwd: fixtureDir,
        timeoutSeconds: 2,
      }),
    (err) => {
      assert.ok(err instanceof AcpxError, String(err));
      assert.equal(err.message, "acpx codex session prompt timed out after 2s");
      assert.equal(err.timedOut, true);
      assert.equal(err.emptyOutput, false);
      assert.equal(classifyAcpxFailure(err), null);
      return true;
    },
  );
});

test("a blank session prompt clearly short of the budget keeps the empty-output diagnosis", async () => {
  process.env.FAKE_ACPX_MODE = "fast-blank";
  try {
    const result = await sessionPrompt({
      agent: "codex",
      effort: "medium",
      sessionName: "backpass-exec-timeout-fast",
      promptFile,
      cwd: fixtureDir,
      timeoutSeconds: 2,
    });
    assert.equal(result.text, "");
    assert.throws(
      () => assertNonEmptyOutput(result, { agent: "codex", model: null }),
      (err) => {
        assert.ok(err instanceof AcpxError, String(err));
        assert.equal(err.emptyOutput, true);
        assert.equal(classifyAcpxFailure(err), "empty-output");
        return true;
      },
    );
  } finally {
    process.env.FAKE_ACPX_MODE = "budget-blank";
  }
});
