import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareHarnessInvocation } from "../src/harness-invoke.js";

test("copilot model and effort become process flags behind an acpx --agent wrapper", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "bp-copilot-bin-"));
  fs.writeFileSync(path.join(bin, "copilot"), "#!/bin/sh\n", { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prevPath}`;
  const inv = prepareHarnessInvocation({ agent: "copilot", effort: "high", model: "some-model" });
  try {
    assert.ok(inv.acpxAgentCommand);
    const wrapper = fs.readFileSync(inv.acpxAgentCommand.split(" ").pop().replace(/["']/g, ""), "utf8");
    assert.match(wrapper, /--reasoning-effort/);
    assert.match(wrapper, /--acp/);
  } finally {
    inv.dispose();
    process.env.PATH = prevPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("copilot without overrides needs no wrapper", () => {
  const inv = prepareHarnessInvocation({ agent: "copilot" });
  assert.equal(inv.acpxAgentCommand, null);
});
