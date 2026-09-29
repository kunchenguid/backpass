import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { State } from "../src/state.js";
import { setLoggerSink } from "../src/logger.js";

/**
 * User-scope state is created 0700 and read back to prove it. Windows has no POSIX mode
 * bits - chmod only toggles the read-only attribute and stat reports 0o666 - so the read-back
 * can never match there (issue #115). These pin the win32 branch: skipped silently when the
 * state dir resolves under the user's profile (where it inherits the profile's NTFS ACL), a
 * warning when it resolves elsewhere (e.g. XDG_CONFIG_HOME redirected to a synced or network
 * folder, so no ACL is inherited), and the read-back still enforced everywhere else.
 */
async function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

/** A stat that reports the directory the way Windows does, whatever the host is. */
function statAsWindows(t, stateDir) {
  const realStat = fs.statSync;
  t.mock.method(fs, "statSync", (p, ...rest) => {
    const st = realStat(p, ...rest);
    if (path.resolve(String(p)) !== path.resolve(stateDir)) return st;
    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { mode: 0o40666 });
  });
}

function captureWarnings(t) {
  const lines = [];
  setLoggerSink((line) => lines.push(line));
  t.after(() => setLoggerSink(null));
  return lines;
}

test("user-scope state dir inside the user profile is accepted on win32 with no warning", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-home-"));
  t.mock.method(os, "homedir", () => home);
  const stateDir = path.join(home, ".config", "backpass", "user");
  statAsWindows(t, stateDir);
  const warnings = captureWarnings(t);

  const state = await withPlatform("win32", () =>
    new State(os.tmpdir(), { stateDir, mode: 0o700, exclude: false }).ensure(),
  );

  assert.equal(fs.existsSync(state.evidenceDir), true, "ensure() went on to create the state layout");
  assert.equal(fs.existsSync(state.applyDir), true);
  assert.deepEqual(warnings, []);
});

test("user-scope state dir redirected outside the user profile is accepted on win32 with a warning", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-home-"));
  t.mock.method(os, "homedir", () => home);
  const stateDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-redirected-")), "user");
  statAsWindows(t, stateDir);
  const warnings = captureWarnings(t);

  const state = await withPlatform("win32", () =>
    new State(os.tmpdir(), { stateDir, mode: 0o700, exclude: false }).ensure(),
  );

  assert.equal(fs.existsSync(state.evidenceDir), true, "ensure() went on to create the state layout");
  assert.equal(fs.existsSync(state.applyDir), true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /outside your Windows user profile/);
  assert.match(warnings[0], new RegExp(stateDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("user-scope state dir that did not come out 0700 is still refused off win32", async (t) => {
  const stateDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-mode-")), "user");
  statAsWindows(t, stateDir);

  await withPlatform("linux", () =>
    assert.throws(
      () => new State(os.tmpdir(), { stateDir, mode: 0o700, exclude: false }).ensure(),
      /could not secure state directory .* as mode 700 \(got 666\)/,
    ),
  );
});
