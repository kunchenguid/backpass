import test from "node:test";
import assert from "node:assert/strict";

import { transcriptLabel } from "../src/analyze.js";

const uuid = "0f3b6a2e-9d1c-4e7a-b8c5-1d2e3f4a5b6c";

test("transcriptLabel prefers the real title", () => {
  assert.equal(
    transcriptLabel({ nativeId: uuid, title: "refactor wallet sync", startedAt: 1 }),
    "refactor wallet sync",
  );
});

test("transcriptLabel falls back to the session date/time, never the id", () => {
  const startedAt = new Date(2026, 7, 21, 14, 3).getTime();
  const label = transcriptLabel({ nativeId: uuid, title: "", startedAt });
  assert.equal(label, "session 2026-08-21 14:03");
  assert.ok(!label.includes(uuid.slice(0, 8)));
});

test("transcriptLabel falls back to (untitled) without a title or a start time", () => {
  assert.equal(transcriptLabel({ nativeId: uuid, title: null, startedAt: null }), "(untitled)");
  assert.equal(transcriptLabel({ nativeId: uuid, startedAt: 0 }), "(untitled)");
});
