import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * backpass's own analysis/synthesis calls are filed by each harness under this repo's
 * cwd, so discovery would pick them up as tier-1 sessions. These tests drive real
 * discovery over a fake HOME holding the three acpx-backed stores (pi, codex, claude),
 * each with one genuine session and one session whose first user message is an actual
 * prompt backpass rendered, and assert only the genuine ones come back.
 */
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-self-home-"));
process.env.HOME = fakeHome;

const { discoverTranscripts } = await import("../src/discovery/index.js");
const { renderPrompt, SELF_SESSION_SENTINEL } = await import("../src/prompts.js");
const { isSelfSession } = await import("../src/discovery/self.js");
const { loadConfig } = await import("../src/config.js");
const { transcriptIdentity } = await import("../src/transcript.js");

const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-self-repo-"));
const realRoot = fs.realpathSync(repoRoot);
const repo = { name: "demo", root: realRoot, worktrees: [realRoot], remotes: [] };

const analysisPrompt = renderPrompt("analysis", {
  MEMORY_PATH: "AGENTS.md",
  INSTRUCTION_INDEX: "1. Run pnpm check before pushing.",
  TRACE: "user: fix the flaky test\nagent: ran the suite",
});
const synthesisPrompt = renderPrompt("synthesis", { REPO_NAME: "demo", MEMORY_PATH: "AGENTS.md" });

function jsonl(lines) {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function writePiSession(dir, id, firstUserText) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-08-20T10-00-00-000Z_${id}.jsonl`);
  fs.writeFileSync(
    file,
    jsonl([
      { type: "session", version: 3, id, timestamp: "2026-08-20T10:00:00.000Z", cwd: realRoot },
      { type: "model_change", id: "m1", parentId: null, provider: "openai-codex", modelId: "gpt-5.6-sol" },
      {
        type: "message",
        id: "e1",
        parentId: "m1",
        message: { role: "user", content: [{ type: "text", text: firstUserText }] },
      },
      {
        type: "message",
        id: "e2",
        parentId: "e1",
        message: { role: "assistant", content: [{ type: "text", text: "{}" }] },
      },
    ]),
  );
  return file;
}

function writeCodexSession(dir, id, firstUserText) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-08-20T10-00-00-${id}.jsonl`);
  fs.writeFileSync(
    file,
    jsonl([
      {
        timestamp: "2026-08-20T10:00:00.000Z",
        type: "session_meta",
        payload: { session_id: id, cwd: realRoot, source: "exec", git: { branch: "main" } },
      },
      { timestamp: "2026-08-20T10:00:01.000Z", type: "turn_context", payload: { cwd: realRoot, model: "gpt-5.2" } },
      {
        timestamp: "2026-08-20T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "<permissions instructions>ignore me" }],
        },
      },
      {
        timestamp: "2026-08-20T10:00:03.000Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: firstUserText }] },
      },
      {
        timestamp: "2026-08-20T10:00:04.000Z",
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "{}" }] },
      },
    ]),
  );
  return file;
}

function writeClaudeSession(dir, id, firstUserText) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(
    file,
    jsonl([
      { type: "mode", mode: "normal", sessionId: id },
      {
        parentUuid: null,
        isSidechain: false,
        type: "user",
        message: { role: "user", content: firstUserText },
        uuid: "u1",
        timestamp: "2026-08-20T10:00:00.000Z",
        cwd: realRoot,
        gitBranch: "main",
        sessionId: id,
      },
      {
        parentUuid: "u1",
        isSidechain: false,
        type: "assistant",
        message: { model: "claude-opus-5", role: "assistant", content: [{ type: "text", text: "{}" }] },
        uuid: "a1",
        timestamp: "2026-08-20T10:00:05.000Z",
        cwd: realRoot,
        sessionId: id,
      },
    ]),
  );
  return file;
}

const piDir = path.join(fakeHome, ".pi", "agent", "sessions", `-${realRoot.replace(/\//g, "-")}--`);
const codexDir = path.join(fakeHome, ".codex", "sessions", "2026", "08", "20");
const claudeDir = path.join(fakeHome, ".claude", "projects", realRoot.replace(/[/.]/g, "-"));

writePiSession(piDir, "pi-real", "Add the changelog entry.");
writePiSession(piDir, "pi-self", analysisPrompt);
writeCodexSession(codexDir, "codex-real", "Fix the flaky test.");
writeCodexSession(codexDir, "codex-self", synthesisPrompt);
writeClaudeSession(claudeDir, "claude-real", "Open a PR for the parser fix.");
writeClaudeSession(claudeDir, "claude-self", analysisPrompt);
// A genuine session that merely *talks about* the sentinel is not a self-session.
writePiSession(piDir, "pi-mentions", `Why does backpass prepend ${SELF_SESSION_SENTINEL} to its prompts?`);

function configFor() {
  const config = loadConfig(realRoot, { discovery: { harnesses: ["pi", "codex", "claude"], since: "all" } });
  const cache = { version: 1, entries: {} };
  config.state = { readScanCache: () => cache, writeScanCache: () => {} };
  return config;
}

test("every prompt backpass sends begins with the self-session sentinel", () => {
  assert.ok(analysisPrompt.startsWith(`${SELF_SESSION_SENTINEL}\n`));
  assert.ok(synthesisPrompt.startsWith(`${SELF_SESSION_SENTINEL}\n`));
});

test("discovery excludes backpass-originated sessions from every acpx-backed harness", async () => {
  const { transcripts, perHarness } = await discoverTranscripts({ repo, config: configFor() });

  const ids = transcripts.map((t) => t.nativeId).sort();
  assert.deepEqual(ids, ["claude-real", "codex-real", "pi-mentions", "pi-real"]);
  assert.equal(perHarness.pi.self, 1);
  assert.equal(perHarness.codex.self, 1);
  assert.equal(perHarness.claude.self, 1);
  assert.equal(perHarness.pi.matched, 2);
  assert.equal(perHarness.codex.matched, 1);
  assert.equal(perHarness.claude.matched, 1);
  for (const t of transcripts) {
    assert.equal(t.association.tier, 1);
    assert.equal(t.identity, transcriptIdentity(t));
  }
  assert.equal(new Set(transcripts.map((t) => t.identity)).size, transcripts.length);
});

test("the exclusion survives the scan cache (a cached descriptor is still checked)", async () => {
  const config = configFor();
  await discoverTranscripts({ repo, config });
  const second = await discoverTranscripts({ repo, config });
  assert.deepEqual(second.transcripts.map((t) => t.nativeId).sort(), [
    "claude-real",
    "codex-real",
    "pi-mentions",
    "pi-real",
  ]);
  assert.equal(second.perHarness.pi.cached, 3);
  assert.equal(second.perHarness.pi.self, 1);
});

test("isSelfSession is fail-soft on a missing or directory path", () => {
  assert.equal(isSelfSession({ path: path.join(fakeHome, "nope.jsonl") }), false);
  assert.equal(isSelfSession({ path: fakeHome }), false);
  assert.equal(isSelfSession({ path: null }), false);
});
