import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Regression for a real backpass run: opencode's acpx adapter exited 1 with no
 * stderr detail on both `exec` and a named-session prompt. `AcpxError` built its
 * message from stderr with no fallback, so the failure surfaced as a message with
 * a dangling trailing colon instead of naming the exit code.
 */
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-acpx-empty-stderr-"));
const fakeAcpx = path.join(fixtureDir, "acpx");
const promptFile = path.join(fixtureDir, "prompt.md");
fs.writeFileSync(promptFile, "analyze this\n");

fs.writeFileSync(
  fakeAcpx,
  `#!${process.execPath}
const argv = process.argv.slice(2);
if (argv.includes("sessions") && argv.includes("new")) process.exit(0);
if (argv.includes("sessions") && argv.includes("close")) process.exit(0);
process.exit(1);
`,
);
fs.chmodSync(fakeAcpx, 0o755);

process.env.BACKPASS_ACPX_BIN = fakeAcpx;
const { AcpxError, execOneShot, openSession } = await import("../src/acpx.js");

test.after(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test("exec one-shot names the exit code when opencode exits with no stderr", async () => {
  await assert.rejects(
    () => execOneShot({ agent: "opencode", promptFile, cwd: fixtureDir, timeoutSeconds: 5 }),
    (err) => {
      assert.ok(err instanceof AcpxError, String(err));
      assert.equal(err.message, "acpx opencode exec failed (exit 1): exit 1");
      assert.doesNotMatch(err.message, /: $/);
      return true;
    },
  );
});

test("session prompt names the exit code when opencode exits with no stderr", async () => {
  const session = await openSession({ agent: "opencode", sessionName: "backpass-empty-stderr", cwd: fixtureDir });
  try {
    await assert.rejects(
      () => session.prompt({ promptFile, timeoutSeconds: 5 }),
      (err) => {
        assert.ok(err instanceof AcpxError, String(err));
        assert.equal(err.message, "acpx opencode session prompt failed (exit 1): exit 1");
        assert.doesNotMatch(err.message, /: $/);
        return true;
      },
    );
  } finally {
    await session.close();
  }
});
