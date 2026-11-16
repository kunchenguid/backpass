import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { prepareHarnessInvocation } from "../src/harness-invoke.js";

test(
  "copilot model and effort reach the real binary as flags, ahead of the ACP stdio flags",
  { skip: process.platform === "win32" },
  () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "bp-copilot-bin-"));
    const log = path.join(bin, "args.log");
    fs.writeFileSync(path.join(bin, "copilot"), `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${log}"\n`, {
      mode: 0o755,
    });
    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${prevPath}`;
    const inv = prepareHarnessInvocation({ agent: "copilot", model: "some-model", effort: "high" });
    try {
      assert.ok(inv.acpxAgentCommand);
      const run = spawnSync("/bin/sh", ["-c", inv.acpxAgentCommand], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [
        "--model",
        "some-model",
        "--reasoning-effort",
        "high",
        "--acp",
        "--stdio",
      ]);
    } finally {
      inv.dispose();
      process.env.PATH = prevPath;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  },
);

test("copilot without overrides needs no wrapper", () => {
  const inv = prepareHarnessInvocation({ agent: "copilot" });
  assert.equal(inv.acpxAgentCommand, null);
});
