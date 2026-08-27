import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCapture } from "../src/subprocess.js";

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
