import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { classifyAcpxFailure } from "../src/acpx.js";
import { quoteShimArg, runCapture } from "../src/subprocess.js";

test(
  "a timed leader close still kills a descendant that ignores termination",
  { skip: process.platform === "win32" && "POSIX process-group behavior" },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-timeout-leader-close-"));
    const harnessPath = path.join(dir, "harness.cjs");
    const acpxPath = path.join(dir, "acpx.cjs");
    const pidPath = path.join(dir, "harness.pid");
    const signalPath = path.join(dir, "harness.signal");

    fs.writeFileSync(
      harnessPath,
      `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(signalPath)}, "SIGTERM");
});
setInterval(() => {}, 1000);
`,
    );
    fs.writeFileSync(
      acpxPath,
      `const { spawn } = require("node:child_process");
spawn(process.execPath, [${JSON.stringify(harnessPath)}], { stdio: "ignore" });
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 100));
setInterval(() => {}, 1000);
`,
    );

    let harnessPid;
    try {
      const result = await runCapture(process.execPath, [acpxPath], { timeoutMs: 250 });
      assert.equal(result.timedOut, true);
      assert.ok(fs.existsSync(pidPath));
      assert.equal(fs.readFileSync(signalPath, "utf8"), "SIGTERM");
      harnessPid = Number(fs.readFileSync(pidPath, "utf8"));
      let alive = true;
      for (let attempt = 0; attempt < 100 && alive; attempt += 1) {
        try {
          process.kill(harnessPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 10));
        } catch (err) {
          if (err.code !== "ESRCH") throw err;
          alive = false;
        }
      }
      assert.equal(alive, false);
    } finally {
      if (!harnessPid && fs.existsSync(pidPath)) harnessPid = Number(fs.readFileSync(pidPath, "utf8"));
      if (harnessPid) {
        try {
          process.kill(harnessPid, "SIGKILL");
        } catch {
          // The timed process may already be gone.
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a timeout terminates the captured command's harness descendant",
  { skip: process.platform === "win32" && "POSIX process-group behavior" },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-timeout-tree-"));
    const harnessPath = path.join(dir, "harness.cjs");
    const acpxPath = path.join(dir, "acpx.cjs");
    const pidPath = path.join(dir, "harness.pid");
    const signalPath = path.join(dir, "harness.signal");

    fs.writeFileSync(
      harnessPath,
      `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(signalPath)}, "SIGTERM");
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
    );
    fs.writeFileSync(
      acpxPath,
      `const { spawn } = require("node:child_process");
spawn(process.execPath, [${JSON.stringify(harnessPath)}], { stdio: "inherit" });
setInterval(() => {}, 1000);
`,
    );

    let harnessPid;
    try {
      const result = await runCapture(process.execPath, [acpxPath], { timeoutMs: 1000 });
      assert.equal(result.timedOut, true);
      assert.ok(fs.existsSync(pidPath), "the harness descendant started before timeout");
      assert.equal(fs.readFileSync(signalPath, "utf8"), "SIGTERM");
      harnessPid = Number(fs.readFileSync(pidPath, "utf8"));
      let alive = true;
      for (let attempt = 0; attempt < 100 && alive; attempt += 1) {
        try {
          process.kill(harnessPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 10));
        } catch (err) {
          if (err.code !== "ESRCH") throw err;
          alive = false;
        }
      }
      assert.equal(alive, false, "the harness descendant was reaped after termination");
    } finally {
      if (!harnessPid && fs.existsSync(pidPath)) harnessPid = Number(fs.readFileSync(pidPath, "utf8"));
      if (harnessPid) {
        try {
          process.kill(harnessPid, "SIGKILL");
        } catch {
          // The timeout should already have terminated the harness.
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

/**
 * Windows npm-shim launch (issue #43).
 *
 * These drive the real `runCapture` with an injected platform and spawn, so they run,
 * and can fail, on every CI platform. A win32-gated test would be skipped exactly
 * where the regression it guards would land.
 */

const SPACED_PATH = "C:\\dir with spaces\\repo";

function fakeSpawn(record) {
  return (file, args, options) => {
    record.push({ file, args, options });
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { end() {} },
    });
    setImmediate(() => child.emit("close", 0));
    return child;
  };
}

function shimFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-win-shim-"));
  fs.writeFileSync(path.join(dir, "acpx.cmd"), "@echo off\r\n");
  return {
    dir,
    lookupEnv: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe" },
  };
}

test("a windows npm .cmd shim is launched through the command interpreter", async () => {
  const { dir, lookupEnv } = shimFixture();
  const calls = [];
  try {
    await runCapture("acpx", ["--cwd", SPACED_PATH, "--format", "quiet"], {
      platform: "win32",
      lookupEnv,
      spawnFn: fakeSpawn(calls),
    });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.file, "C:\\Windows\\system32\\cmd.exe");
    assert.deepEqual(call.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(call.options.windowsVerbatimArguments, true);
    assert.ok(call.args[3].includes(path.join(dir, "acpx.cmd")), "the resolved shim leads the command line");
    // The path with spaces must survive as ONE quoted argument. Node's own
    // `shell: true` joins argv with bare spaces and would split it here.
    assert.ok(
      call.args[3].includes(`"${SPACED_PATH}"`),
      `a path with spaces must stay one quoted argument, got: ${call.args[3]}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a quoted PATH entry still resolves the shim", async () => {
  const { dir, lookupEnv } = shimFixture();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-win-shim-other-"));
  const shim = path.join(dir, "acpx.cmd");
  // Windows PATH entries may carry surrounding quotes. Kept verbatim, the entry never
  // stats, the shim goes undetected, and the plain spawn fails with the ENOENT this
  // whole launch policy exists to prevent. The unquoted arm is the control: a resolver
  // that stopped resolving anything at all must not read as a pass.
  const arms = [
    ["unquoted", [other, dir].join(path.delimiter)],
    ["quoted", [other, `"${dir}"`].join(path.delimiter)],
  ];
  try {
    for (const [label, PATH] of arms) {
      const calls = [];
      await runCapture("acpx", ["--format", "quiet"], {
        platform: "win32",
        lookupEnv: { ...lookupEnv, PATH },
        spawnFn: fakeSpawn(calls),
      });
      assert.equal(calls[0].file, lookupEnv.ComSpec, `${label}: must go through the command interpreter`);
      assert.ok(calls[0].args[3].includes(shim), `${label}: the resolved shim leads the command line`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("a binary that is genuinely missing still reaches spawn as itself", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-win-shim-empty-"));
  const calls = [];
  try {
    await runCapture("definitely-not-installed", ["--version"], {
      platform: "win32",
      lookupEnv: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      spawnFn: fakeSpawn(calls),
    });
    // Not rewritten into a cmd.exe call: the caller must still see its own ENOENT,
    // which `classifyAcpxFailure` maps to `unreachable`.
    assert.equal(calls[0].file, "definitely-not-installed");
    assert.deepEqual(calls[0].args, ["--version"]);
    assert.equal(calls[0].options.windowsVerbatimArguments, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a real executable and every non-windows platform are left alone", async () => {
  const { dir, lookupEnv } = shimFixture();
  fs.writeFileSync(path.join(dir, "acpx.exe"), "");
  const calls = [];
  try {
    await runCapture("acpx", ["--version"], { platform: "win32", lookupEnv, spawnFn: fakeSpawn(calls) });
    assert.equal(calls[0].file, "acpx", ".exe resolves ahead of .cmd in PATHEXT and needs no shim");

    await runCapture("acpx", ["--version"], { platform: "linux", lookupEnv, spawnFn: fakeSpawn(calls) });
    assert.equal(calls[1].file, "acpx");
    assert.equal(calls[1].options.windowsVerbatimArguments, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shim arguments are quoted for both cmd.exe and the target's argv parser", () => {
  // Left bare: nothing either parser acts on.
  assert.equal(quoteShimArg("--format"), "--format");
  assert.equal(quoteShimArg("gpt-5.6-luna"), "gpt-5.6-luna");
  assert.equal(quoteShimArg("100%done"), "100%done");
  // Quoted: whitespace, or an operator cmd.exe would act on outside quotes.
  assert.equal(quoteShimArg("with space"), '"with space"');
  for (const operator of ["a&b", "a|b", "a<b", "a>b", "a^b", "a(b", "a)b", "a!b"]) {
    assert.equal(quoteShimArg(operator), `"${operator}"`, `${operator} must not reach cmd.exe unquoted`);
  }
  // A trailing backslash must not escape the closing quote: MSVCRT doubles the run.
  assert.equal(quoteShimArg("C:\\dir with spaces\\"), '"C:\\dir with spaces\\\\"');
  assert.equal(quoteShimArg(""), '""');
});

test("an argument no quoting can neutralise is refused by name, not passed on", async () => {
  const { dir, lookupEnv } = shimFixture();
  // Quoting suppresses none of these: cmd.exe expands %VAR% inside quotes, the two
  // parsers disagree on how a quote is escaped, and a newline ends the command line.
  // Passing any of them on would silently become several arguments, or commands.
  const refused = [["--cwd", "%USERPROFILE%\\repo"], ['a"&whoami&"b'], ["a\nwhoami"], ["a\rwhoami"]];
  try {
    for (const args of refused) {
      const calls = [];
      const result = await runCapture("acpx", args, {
        platform: "win32",
        lookupEnv,
        spawnFn: fakeSpawn(calls),
      });
      assert.equal(calls.length, 0, `${JSON.stringify(args)} must not reach spawn`);
      assert.equal(result.spawnError.code, "ERR_WINDOWS_SHIM_UNSAFE_ARG");
      assert.equal(result.spawnError.value, args[args.length - 1]);
      assert.ok(result.stderr.includes(JSON.stringify(args[args.length - 1])), result.stderr);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a percent that is not a variable reference still runs", async () => {
  const { dir, lookupEnv } = shimFixture();
  const calls = [];
  try {
    // cmd.exe expands neither a lone `%` nor `%%` on a command line, so refusing them
    // would turn a working Windows run into a hard failure over a legal path.
    await runCapture("acpx", ["--cwd", "C:\\dev\\50%-off\\repo%%x", "--model", "100%done"], {
      platform: "win32",
      lookupEnv,
      spawnFn: fakeSpawn(calls),
    });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args[3].includes("C:\\dev\\50%-off\\repo%%x"), calls[0].args[3]);
    assert.ok(calls[0].args[3].includes("100%done"), calls[0].args[3]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a refusal is not an availability verdict: it must not demote the harness", async () => {
  const { dir, lookupEnv } = shimFixture();
  const calls = [];
  try {
    const failure = await runCapture("acpx", ["--cwd", "%USERPROFILE%\\repo"], {
      platform: "win32",
      lookupEnv,
      spawnFn: fakeSpawn(calls),
    });
    // Classifying it would silently drop the candidate, and the next harness would
    // fail on the very same argument. `test/shim-refusal.test.js` covers how each spawn
    // boundary does surface it.
    assert.equal(classifyAcpxFailure(failure), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
