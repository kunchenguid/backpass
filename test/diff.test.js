import test from "node:test";
import assert from "node:assert/strict";

import { anchoredHunks, diffOps, rawHunks, renderHunkLines } from "../src/diff.js";
import { applyEdit } from "../src/proposal.js";

function applyAll(text, hunks) {
  return hunks.reduce((t, h, i) => applyEdit(t, { id: `e${i}`, file: "f", hunks: [{ ...h, id: `H${i}` }] }), text);
}

test("diffOps is a shortest edit script that replays the new text", () => {
  const a = ["a", "b", "c", "d"];
  const b = ["a", "x", "c", "d", "e"];
  const ops = diffOps(a, b);
  assert.deepEqual(
    ops.map((o) => o.type),
    ["equal", "delete", "insert", "equal", "equal", "insert"],
  );
  assert.deepEqual(rawHunks(ops), [
    { oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 },
    { oldStart: 4, oldEnd: 4, newStart: 4, newEnd: 5 },
  ]);
});

test("each hunk's find is copied from the original, occurs once, and the set rebuilds the new text", () => {
  const old = "# T\n\n- one\n- two\n- three\n\n## S\n\n- four\n";
  const next = "# T\n\n- one\n- TWO\n- three\n\n## S\n\n- four\n- five\n";
  const hunks = anchoredHunks(old, next);
  assert.equal(hunks.length, 2);
  for (const h of hunks) assert.equal(old.split(h.find).length, 2, `${h.find} occurs once`);
  assert.deepEqual(
    hunks.map((h) => [h.oldStart, h.oldEnd, h.removed, h.added]),
    [
      [4, 4, 1, 1],
      [10, 9, 0, 1],
    ],
  );
  assert.equal(applyAll(old, hunks), next);
  assert.equal(applyAll(old, [...hunks].reverse()), next, "hunks are independent of application order");
  assert.equal(applyAll(old, [hunks[1]]), "# T\n\n- one\n- two\n- three\n\n## S\n\n- four\n- five\n");
});

test("a change inside a run of identical lines is widened until it is unique, never matched elsewhere", () => {
  const old = "- a\n- a\n- a\n- a\n- b\n";
  const next = "- a\n- a\n- a\n- b\n";
  const hunks = anchoredHunks(old, next);
  assert.equal(hunks.length, 1);
  assert.equal(applyAll(old, hunks), next);
  // Overlapping occurrences are counted: a find of three "- a" lines would match twice.
  assert.ok(hunks[0].find.includes("- b"), "context reaches the distinct line");
});

test("changes at the head and the tail of a file, and whole-line deletions, splice cleanly", () => {
  assert.equal(applyAll("x\ny\n", anchoredHunks("x\ny\n", "w\nx\ny\n")), "w\nx\ny\n");
  assert.equal(applyAll("x\ny\n", anchoredHunks("x\ny\n", "x\ny\nz\n")), "x\ny\nz\n");
  assert.equal(applyAll("x\ny\n", anchoredHunks("x\ny\n", "y\n")), "y\n");
  assert.equal(applyAll("x\ny", anchoredHunks("x\ny", "x")), "x");
  assert.equal(applyAll("x\ny\n", anchoredHunks("x\ny\n", "")), "");
});

test("an empty original becomes one whole-file insertion that only applies while the file is still empty", () => {
  const hunks = anchoredHunks("", "# New\n");
  assert.deepEqual(
    hunks.map((h) => [h.find, h.replace, h.removed, h.added]),
    [["", "# New\n", 0, 2]],
  );
  assert.equal(applyAll("", hunks), "# New\n");
  assert.throws(() => applyAll("already here\n", hunks), /no longer empty/);
});

test("hunks whose context windows touch are merged so accepting one never moves another", () => {
  // Two edits one line apart, where uniqueness needs the shared middle line as context.
  const old = "- a\n- m\n- a\n- m\n- a\n";
  const next = "- A\n- m\n- a\n- m\n- B\n";
  const hunks = anchoredHunks(old, next);
  assert.equal(applyAll(old, hunks), next);
  const starts = hunks.map((h) => h.oldStart);
  assert.deepEqual(
    starts,
    [...starts].sort((x, y) => x - y),
  );
  for (let i = 1; i < hunks.length; i += 1) {
    assert.ok(hunks[i].oldStart > hunks[i - 1].oldEnd, "windows never overlap");
  }
});

test("display lines carry context, removals, and additions in file order", () => {
  const hunks = anchoredHunks("- one\n- two\n- two\n", "- one\n- two\n- three\n");
  // The minimal unique window reaches one "- two" line of context, not further.
  assert.equal(renderHunkLines(hunks[0].lines), ["  - two", "- - two", "+ - three"].join("\n"));
  assert.equal(renderHunkLines(hunks[0].lines, { maxLines: 2 }), "  - two\n- - two\n  ... 1 more line(s)");
});

test("identical texts measure as no change", () => {
  assert.deepEqual(anchoredHunks("same\n", "same\n"), []);
});
