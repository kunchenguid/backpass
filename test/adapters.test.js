import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as claude from "../src/discovery/adapters/claude.js";
import * as codex from "../src/discovery/adapters/codex.js";
import * as pi from "../src/discovery/adapters/pi.js";
import * as grok from "../src/discovery/adapters/grok.js";
import * as cursorCli from "../src/discovery/adapters/cursor-cli.js";
import { statOrNull } from "../src/discovery/adapters/shared.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function candidateFor(file) {
  const stat = statOrNull(file);
  return { key: file, path: file, mtimeMs: stat.mtimeMs, bytes: stat.size };
}

function messages(events) {
  return events.filter((e) => e.kind === "message");
}

function tools(events) {
  return events.filter((e) => e.kind === "tool");
}

test("claude adapter classifies a session by its per-line cwd", () => {
  const file = path.join(FIXTURES, "claude-session.jsonl");
  const descriptor = claude.classify(candidateFor(file));

  assert.equal(descriptor.id, "11111111-2222-3333-4444-555555555555");
  assert.equal(descriptor.cwd, "/repo/demo");
  assert.equal(descriptor.gitBranch, "main");
  // Claude records no remote, which is why dead worktrees cannot reach tier 2.
  assert.deepEqual(descriptor.remotes, []);
});

test("claude adapter reads messages, folds tool results, and drops sidechains", () => {
  const file = path.join(FIXTURES, "claude-session.jsonl");
  const { events, model } = claude.read({ path: file });

  assert.equal(model, "claude-opus-5");
  assert.deepEqual(
    messages(events).map((m) => `${m.role}: ${m.text}`),
    ["user: Open a PR for the parser fix.", "assistant: I'll run the tests first.", "assistant: Opened PR #2731."],
  );

  const [toolCall] = tools(events);
  assert.equal(toolCall.name, "Bash");
  assert.equal(toolCall.input.command, "npm test");
  assert.equal(toolCall.result, "2 passing");
});

test("codex adapter reads the recorded git remote, enabling tier-2 association", () => {
  const file = path.join(FIXTURES, "codex-rollout.jsonl");
  const descriptor = codex.classify(candidateFor(file));

  assert.equal(descriptor.cwd, "/repo/demo");
  assert.deepEqual(descriptor.remotes, ["git@github.com:acme/demo.git"]);
});

test("codex adapter keeps user/assistant turns and skips developer scaffolding", () => {
  const file = path.join(FIXTURES, "codex-rollout.jsonl");
  const { events, model } = codex.read({ path: file });

  assert.equal(model, "gpt-5.2");
  assert.deepEqual(
    messages(events).map((m) => m.role),
    ["user", "assistant"],
  );
  assert.ok(!JSON.stringify(events).includes("ignore me"), "developer message must not survive");
  assert.ok(!JSON.stringify(events).includes("OPAQUE"), "encrypted reasoning must not survive");

  const [toolCall] = tools(events);
  assert.equal(toolCall.name, "shell");
  assert.equal(toolCall.input.command, "npm test");
  assert.equal(toolCall.result, "1 failing");
});

test("pi adapter reads the session header and drops thinking blocks", () => {
  const file = path.join(FIXTURES, "pi-session.jsonl");
  const descriptor = pi.classify(candidateFor(file));
  assert.equal(descriptor.id, "pi-1234");
  assert.equal(descriptor.cwd, "/repo/demo");

  const { events, model } = pi.read({ path: file });
  assert.equal(model, "gpt-5.6-sol");
  assert.ok(!JSON.stringify(events).includes("internal reasoning"), "thinking must be dropped");

  const [toolCall] = tools(events);
  assert.equal(toolCall.name, "bash");
  assert.equal(toolCall.result, "nothing to commit");
});

test("grok adapter reads remotes from summary.json and tool calls off the assistant record", () => {
  const sessionDir = path.join(FIXTURES, "grok-session", "%2Frepo%2Fdemo", "grok-9999");
  const descriptor = grok.classify({ path: sessionDir, mtimeMs: 0 });
  assert.deepEqual(descriptor.remotes, ["git@github.com:acme/demo.git"]);
  assert.equal(descriptor.cwd, "/repo/demo");
  assert.equal(descriptor.model, "grok-4.5");
  assert.equal(descriptor.id, "grok-9999");

  const { events, model } = grok.read({ path: sessionDir });
  assert.equal(model, "grok-4.5");
  assert.deepEqual(
    messages(events).map((m) => `${m.role}: ${m.text}`),
    ["user: Deploy the staging build.", "assistant: Staging is live."],
  );

  const [toolCall] = tools(events);
  assert.equal(toolCall.name, "run_terminal_command");
  assert.equal(toolCall.input.command, "make deploy");
  assert.equal(toolCall.result, "deployed to staging");
});

test("cursor CLI chat directories are addressed by md5 of the cwd", () => {
  // Verified against the real store: md5 of the cwd is the on-disk directory name.
  assert.equal(
    cursorCli.cwdHash("/Users/kunchen/.treehouse/sshhip-b697bb/9/sshhip"),
    "43ed8ea0825f9a5321fbe6d772769411",
  );
});
