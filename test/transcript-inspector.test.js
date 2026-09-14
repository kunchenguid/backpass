import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  createInspectorState,
  createTranscriptInspector,
  inspectTranscript,
  INSPECTOR_CALL_BYTES,
  INSPECTOR_SESSION_CALLS,
  INSPECTOR_SESSION_BYTES,
  readInspectorManifest,
} from "../src/transcript-inspector.js";
import registerBackpassTranscriptInspector from "../src/pi-transcript-inspector.js";

function textOf(result) {
  return result.content.map((part) => part.text).join("\n");
}

test("the inspector returns exact redacted excerpts without exposing a source path", () => {
  const inspector = createTranscriptInspector({
    ref: "/home/u/private/transcript.jsonl",
    events: [
      { kind: "message", role: "user", text: "Please investigate the migration failure." },
      {
        kind: "tool",
        name: "Bash",
        input: { command: "echo GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123" },
        result: "migration failed",
      },
      { kind: "message", role: "assistant", text: "The migration failed because the lock was stale." },
    ],
  });

  try {
    const manifest = readInspectorManifest(inspector.manifestPath);
    const result = inspectTranscript(
      manifest,
      { query: "migration failed", role: "assistant" },
      createInspectorState(),
    );
    const text = textOf(result);
    assert.match(text, /The migration failed because the lock was stale/);
    assert.doesNotMatch(text, /ghp_abcdefghijklmnopqrstuvwxyz0123/);
    assert.doesNotMatch(text, /\/home\/u\/private\/transcript\.jsonl/);
    assert.doesNotMatch(JSON.stringify(manifest), /rawPath|sourcePath/);
  } finally {
    inspector.dispose();
  }

  assert.equal(fs.existsSync(inspector.manifestPath), false);
});

test("one inspector response and the complete session stay within hard byte budgets", () => {
  const manifest =
    /** @type {{ ref: string, records: Array<{ index: number, turn: number, kind: "message" | "tool", role?: string, text: string }> }} */ ({
      ref: "large-session",
      records: Array.from({ length: 8 }, (_, index) => ({
        index,
        turn: index + 1,
        kind: "message",
        role: "assistant",
        text: `needle-${index} ${"padding ".repeat(500)}`,
      })),
    });
  const state = createInspectorState();
  const first = inspectTranscript(manifest, { query: "needle", maxMatches: 8, maxChars: 8192 }, state);
  assert.ok(Buffer.byteLength(textOf(first), "utf8") <= INSPECTOR_CALL_BYTES);
  assert.match(textOf(first), /needle/);

  while (state.usedBytes < INSPECTOR_SESSION_BYTES && state.calls < INSPECTOR_SESSION_CALLS) {
    inspectTranscript(manifest, { query: "needle", maxMatches: 8, maxChars: 8192 }, state);
  }

  assert.ok(state.usedBytes <= INSPECTOR_SESSION_BYTES);
  assert.ok(state.calls <= INSPECTOR_SESSION_CALLS);
  assert.equal(state.calls, INSPECTOR_SESSION_CALLS);
  const exhausted = inspectTranscript(manifest, { query: "needle" }, state);
  assert.match(textOf(exhausted), /inspection limit reached/);

  const finalByteState = createInspectorState();
  finalByteState.usedBytes = INSPECTOR_SESSION_BYTES - 1;
  const finalByte = inspectTranscript(manifest, { query: "needle" }, finalByteState);
  assert.ok(Buffer.byteLength(textOf(finalByte), "utf8") <= 1);
  assert.equal(finalByteState.usedBytes, INSPECTOR_SESSION_BYTES);
});

test("the inspector can return neighboring turns without allowing arbitrary reads", () => {
  const manifest =
    /** @type {{ ref: string, records: Array<{ index: number, turn: number, kind: "message" | "tool", role?: string, text: string }> }} */ ({
      ref: "context-session",
      records: [
        { index: 0, turn: 1, kind: "message", role: "user", text: "The deploy is failing." },
        { index: 1, turn: 2, kind: "message", role: "assistant", text: "I found the failing check." },
        { index: 2, turn: 3, kind: "message", role: "user", text: "Please explain the rollback." },
      ],
    });
  const result = inspectTranscript(manifest, { query: "failing check", contextTurns: 1 }, createInspectorState());
  const text = textOf(result);
  assert.match(text, /I found the failing check/);
  assert.match(text, /The deploy is failing/);
  assert.doesNotMatch(text, /path|offset|raw/i);
});

test("the Pi extension registers the bounded tool and serves the current manifest", async () => {
  const inspector = createTranscriptInspector({
    ref: "extension-session",
    events: [{ kind: "message", role: "assistant", text: "The lockfile caused the failure." }],
  });
  const previous = process.env.BACKPASS_TRANSCRIPT_INSPECTOR_MANIFEST;
  /** @type {{ name: string, execute: (id: string, params: object) => Promise<unknown> } | undefined} */
  let registered;
  try {
    process.env.BACKPASS_TRANSCRIPT_INSPECTOR_MANIFEST = inspector.manifestPath;
    registerBackpassTranscriptInspector({
      registerTool(tool) {
        registered = tool;
      },
    });
    assert.ok(registered);
    assert.equal(registered.name, "backpass_inspect_transcript");
    const result = await registered.execute("call-1", { query: "lockfile" });
    assert.match(textOf(result), /lockfile caused the failure/);
  } finally {
    inspector.dispose();
    if (previous === undefined) delete process.env.BACKPASS_TRANSCRIPT_INSPECTOR_MANIFEST;
    else process.env.BACKPASS_TRANSCRIPT_INSPECTOR_MANIFEST = previous;
  }
});
