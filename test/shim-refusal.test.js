import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * The Windows npm-shim refusal (issue #43) as each boundary that spawns a shim reports
 * it: acpx for every model call, lavish-axi for `backpass apply`, which is reachable
 * without any model call at all.
 *
 * A refused argument resolves as `{ code: null, spawnError }`, which every generic
 * result inspection would otherwise read as "no session support", "session prompt failed
 * (exit null)" or "failed to open the apply surface" - none of which names the argument,
 * and the first of which sends `sessionPrompt` into an exec fallback that fails
 * identically. These drive the real entry points to prove the refusal is raised, not
 * merely constructible.
 *
 * `--cwd` is the argument that carries a repo path onto argv (`baseArgs`), which is why
 * the fixture repo's own directory name holds the `%VAR%` sequence. The refusal fires
 * before any spawn, so the stand-in interpreter only has to let `sessions new` succeed;
 * `test/subprocess.test.js` owns the command line itself. Both stand-ins are real files,
 * so this runs on every platform rather than being skipped where it matters.
 */
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-shim-refusal-"));
const fakeAcpx = path.join(fixtureDir, "acpx.cmd");
fs.writeFileSync(fakeAcpx, "@echo off\r\nexit /b 0\r\n");
const fakeLavish = path.join(fixtureDir, "lavish-axi.cmd");
fs.writeFileSync(fakeLavish, "@echo off\r\nexit /b 0\r\n");

let fakeComSpec;
if (process.platform === "win32") {
  fakeComSpec = process.env.ComSpec || "C:\\Windows\\system32\\cmd.exe";
} else {
  fakeComSpec = path.join(fixtureDir, "fake-cmd");
  fs.writeFileSync(fakeComSpec, `#!${process.execPath}\nprocess.exit(0);\n`);
  fs.chmodSync(fakeComSpec, 0o755);
}

const promptFile = path.join(fixtureDir, "prompt.md");
fs.writeFileSync(promptFile, "analyze this\n");

/** A real, existing repo directory whose name cmd.exe would expand. */
const refusedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-%BUILD%-"));
const refusedInMessage = JSON.stringify(refusedCwd);

process.env.BACKPASS_ACPX_BIN = fakeAcpx;
process.env.BACKPASS_LAVISH_BIN = fakeLavish;

const { AcpxError, execOneShot, openSession } = await import("../src/acpx.js");
const { openApplySurface } = await import("../src/apply/lavish.js");
const { UserError } = await import("../src/logger.js");

async function asWindows(fn) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const previousComSpec = process.env.ComSpec;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  process.env.ComSpec = fakeComSpec;
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (previousComSpec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = previousComSpec;
  }
}

test.after(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  fs.rmSync(refusedCwd, { recursive: true, force: true });
});

test("a per-turn prompt refusal is named, not reported as a failed session turn", async () => {
  await asWindows(async () => {
    // `sessions new` carries no repo path on argv, so the session opens normally and the
    // refusal lands on the first turn - the dominant path for every analysis call.
    const session = await openSession({ agent: "codex", sessionName: "backpass-refusal-turn", cwd: refusedCwd });
    try {
      await assert.rejects(
        () => session.prompt({ promptFile, timeoutSeconds: 5 }),
        (err) => {
          assert.ok(err instanceof UserError, `expected a UserError, got ${String(err)}`);
          assert.ok(err.message.includes(refusedInMessage), err.message);
          assert.ok(!(err instanceof AcpxError), err.message);
          assert.doesNotMatch(err.message, /session prompt failed|exit null/);
          return true;
        },
      );
    } finally {
      await session.close();
    }
  });
});

test("the exec one-shot fallback names the same refusal", async () => {
  await asWindows(async () => {
    await assert.rejects(
      () => execOneShot({ agent: "codex", promptFile, cwd: refusedCwd, timeoutSeconds: 5 }),
      (err) => {
        assert.ok(err instanceof UserError, `expected a UserError, got ${String(err)}`);
        assert.ok(err.message.includes(refusedInMessage), err.message);
        assert.ok(!(err instanceof AcpxError), err.message);
        return true;
      },
    );
  });
});

test("the apply surface names the refusal as its headline", async () => {
  await asWindows(async () => {
    // `backpass apply` needs no model call, so this is the boundary a user hits first.
    const surface = path.join(refusedCwd, ".backpass", "apply", "apply.html");
    await assert.rejects(
      () => openApplySurface(surface),
      (err) => {
        assert.ok(err instanceof UserError, `expected a UserError, got ${String(err)}`);
        assert.ok(err.message.includes(JSON.stringify(surface)), err.message);
        assert.doesNotMatch(err.message, /failed to open the apply surface|not found on PATH/);
        return true;
      },
    );
  });
});

test("a session that opens against an acceptable path still works", async () => {
  await asWindows(async () => {
    // Guards the fixture itself: the refusals above must come from the argument, not
    // from a stand-in that can never open a session.
    const session = await openSession({ agent: "codex", sessionName: "backpass-refusal-ok", cwd: fixtureDir });
    const result = await session.prompt({ promptFile, timeoutSeconds: 5 });
    assert.equal(result.text, "");
    await session.close();
  });
});
