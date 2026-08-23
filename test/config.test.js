import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CONFIG_FILENAME, loadConfig, parseSince, sinceCutoff } from "../src/config.js";
import { evidenceKey, isEvidenceFresh, safeFileName, State } from "../src/state.js";
import { UserError } from "../src/logger.js";

function tempRepo(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-config-"));
  if (config !== undefined) {
    fs.writeFileSync(path.join(dir, CONFIG_FILENAME), typeof config === "string" ? config : JSON.stringify(config));
  }
  return dir;
}

test("the defaults match the approved design", () => {
  const config = loadConfig(tempRepo());
  assert.equal(config.budgetTokens, 5000);
  assert.equal(config.maxEditsPerRun, null, "the edit cap is adaptive unless pinned");
  assert.equal(config.minGapEvidence, 2);
  assert.equal(config.jobs, 4);
  assert.equal(config.discovery.since, "30d");
  assert.deepEqual(config.discovery.harnesses, ["claude", "codex", "pi", "opencode", "grok", "cursor", "hermes"]);
  assert.ok(!config.discovery.harnesses.includes("cursor-ide"), "Cursor IDE is deferred to v1.1");
  assert.deepEqual(config.analysis, { agent: null, model: null, effort: null }, "agents are auto-picked by default");
  assert.deepEqual(config.synthesis, { agent: null, model: null, effort: null });
  assert.equal(config.autoAgent, true);
  assert.deepEqual(
    config.ladders.analysis.map((r) => r.model),
    ["gpt-5.6-luna", "claude-sonnet-5", "grok-4.6"],
  );
  assert.deepEqual(
    config.ladders.synthesis.map((r) => r.model),
    ["gpt-5.6-sol", "claude-opus-5", "grok-4.6"],
  );
});

test("a model without an agent is rejected rather than half-auto-picked", () => {
  assert.throws(() => loadConfig(tempRepo({ synthesis: { model: "claude-opus-5" } })), UserError);
  const ok = loadConfig(tempRepo({ synthesis: { agent: "claude", model: "claude-opus-5" } }));
  assert.equal(ok.synthesis.agent, "claude");
});

test("ladders are user-editable and validated", () => {
  const config = loadConfig(tempRepo({ ladders: { analysis: [{ model: "gpt-5.5", agents: ["codex"] }] } }));
  assert.deepEqual(config.ladders.analysis, [{ model: "gpt-5.5", agents: ["codex"] }]);
  assert.equal(config.ladders.synthesis.length, 3, "the other role keeps its default ladder");
  assert.throws(() => loadConfig(tempRepo({ ladders: { analysis: [] } })), UserError);
  assert.throws(() => loadConfig(tempRepo({ ladders: { synthesis: [{ model: "x" }] } })), UserError);
});

test("repo config overrides defaults, and CLI flags override both", () => {
  const dir = tempRepo({ budgetTokens: 3000, analysis: { agent: "pi" } });

  const fromFile = loadConfig(dir);
  assert.equal(fromFile.budgetTokens, 3000);
  assert.equal(fromFile.analysis.agent, "pi");
  assert.equal(fromFile.synthesis.agent, null, "untouched defaults survive a partial override (null = auto-pick)");

  const withFlags = loadConfig(dir, { budgetTokens: 8000, analysis: { model: "gpt-5.2" } });
  assert.equal(withFlags.budgetTokens, 8000);
  assert.equal(withFlags.analysis.agent, "pi", "a nested flag override merges, it does not replace");
  assert.equal(withFlags.analysis.model, "gpt-5.2");
});

test("--include-cursor-ide is the only way the deferred store is scanned", () => {
  const config = loadConfig(tempRepo(), { discovery: { includeCursorIde: true } });
  assert.ok(config.discovery.harnesses.includes("cursor-ide"));
});

test("unknown harness names are dropped rather than failing the run", () => {
  const config = loadConfig(tempRepo({ discovery: { harnesses: ["claude", "not-a-harness"] } }));
  assert.deepEqual(config.discovery.harnesses, ["claude"]);
});

test("invalid config values fail loudly with a usable message", () => {
  assert.throws(() => loadConfig(tempRepo({ budgetTokens: 0 })), UserError);
  assert.throws(() => loadConfig(tempRepo({ memoryFiles: [] })), UserError);
  assert.throws(() => loadConfig(tempRepo({ minGapEvidence: 0 })), UserError);
  assert.throws(() => loadConfig(tempRepo({ discovery: { since: "yesterday" } })), UserError);
  assert.throws(() => loadConfig(tempRepo("{ not json")), UserError);
  assert.throws(() => loadConfig(tempRepo('"a bare string"')), UserError);
});

test('--since accepts durations and an explicit "all"', () => {
  assert.equal(parseSince("30d"), 30 * 86_400_000);
  assert.equal(parseSince("12h"), 12 * 3_600_000);
  assert.equal(parseSince("2w"), 2 * 604_800_000);
  assert.equal(parseSince("90m"), 90 * 60_000);
  assert.equal(parseSince("all"), null);
  assert.equal(sinceCutoff("all"), null);
  assert.equal(sinceCutoff("1d", 1_000_000_000), 1_000_000_000 - 86_400_000);
  assert.throws(() => parseSince("30 fortnights"), UserError);
});

test("evidence is keyed to both the transcript and the memory file it was judged against", () => {
  const transcript = { mtimeMs: 111, bytes: 222 };
  const key = evidenceKey(transcript, "sha256:aaa");
  const evidence = { status: "ok", key };

  assert.equal(isEvidenceFresh(evidence, transcript, "sha256:aaa"), true);
  assert.equal(isEvidenceFresh(evidence, transcript, "sha256:bbb"), false, "edited weights invalidate evidence");
  assert.equal(
    isEvidenceFresh(evidence, { mtimeMs: 999, bytes: 222 }, "sha256:aaa"),
    false,
    "a changed transcript invalidates",
  );
  assert.equal(isEvidenceFresh({ status: "failed", key }, transcript, "sha256:aaa"), false, "failures are retried");
  assert.equal(
    isEvidenceFresh({ status: "skipped", key }, transcript, "sha256:aaa"),
    false,
    "skip decisions depend on config, so they are re-derived rather than cached",
  );
  assert.equal(isEvidenceFresh(null, transcript, "sha256:aaa"), false);
});

test("state round-trips through disk and survives a corrupt file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-state-"));
  const state = new State(dir).ensure();

  state.writeEvidence("claude-abc", { status: "ok", key: "k" });
  assert.equal(state.readEvidence("claude-abc").key, "k");
  assert.equal(state.listEvidence().length, 1);

  state.writeScanCache({ version: 1, entries: { a: { mtimeMs: 1, bytes: 2, descriptor: null } } });
  assert.equal(Object.keys(state.readScanCache().entries).length, 1);

  fs.writeFileSync(state.scanCachePath, "not json at all");
  assert.deepEqual(state.readScanCache(), { version: 1, entries: {} }, "a corrupt cache resets instead of crashing");
});

test("transcript ids are turned into safe filenames", () => {
  assert.equal(safeFileName("claude-abc/../../etc/passwd"), "claude-abc_.._.._etc_passwd");
  assert.equal(safeFileName("opencode:ses_25de1e"), "opencode_ses_25de1e");
});
