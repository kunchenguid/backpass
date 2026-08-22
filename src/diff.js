/**
 * Line diff between a file as backpass read it and the copy the synthesis agent edited
 * natively (design section 3, native-edit revision).
 *
 * The synthesis model never hands backpass text to locate in a file; it edits a staging
 * copy with its own file tools and backpass measures what changed. Each measured hunk is
 * then turned into a find/replace pair whose `find` is copied out of the original file by
 * construction - so it always matches, and `applyEdit` can apply it later (at apply time,
 * against whatever the file is by then) with no fuzzing.
 *
 * Two guarantees make the hunks independently reviewable:
 *   - each `find` is widened with context lines until it occurs exactly once in the file
 *   - hunks whose context windows touch are merged, so accepting one never moves
 *     another's anchor
 */

/** Myers refinement is bounded; past this many edit steps the middle is one hunk. */
const MAX_EDIT_DISTANCE = 4000;

/**
 * Shortest edit script between two line arrays (Myers, O(ND)), as a list of ops:
 * `{ type: "equal" | "delete" | "insert", oldIndex, newIndex }`.
 */
export function diffOps(oldLines, newLines) {
  // Common prefix/suffix first: a real edit touches a tiny fraction of the file.
  let prefix = 0;
  const maxPrefix = Math.min(oldLines.length, newLines.length);
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < maxPrefix - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const ops = [];
  for (let i = 0; i < prefix; i += 1) ops.push({ type: "equal", oldIndex: i, newIndex: i });

  const a = oldLines.slice(prefix, oldLines.length - suffix);
  const b = newLines.slice(prefix, newLines.length - suffix);
  for (const op of myers(a, b)) {
    ops.push({ type: op.type, oldIndex: op.oldIndex + prefix, newIndex: op.newIndex + prefix });
  }

  for (let i = 0; i < suffix; i += 1) {
    ops.push({
      type: "equal",
      oldIndex: oldLines.length - suffix + i,
      newIndex: newLines.length - suffix + i,
    });
  }
  return ops;
}

function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return [];
  if (!n) return b.map((_, j) => ({ type: "insert", oldIndex: 0, newIndex: j }));
  if (!m) return a.map((_, i) => ({ type: "delete", oldIndex: i, newIndex: 0 }));

  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max;
  const trace = [];
  let v = new Int32Array(2 * max + 2);
  v[offset + 1] = 0;
  let found = false;

  for (let d = 0; d <= max && !found; d += 1) {
    const snapshot = new Int32Array(v);
    trace.push(snapshot);
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }

  if (!found) {
    // Too different to refine within bounds: one hunk replacing the whole middle.
    return [
      ...a.map((_, i) => ({ type: "delete", oldIndex: i, newIndex: 0 })),
      ...b.map((_, j) => ({ type: "insert", oldIndex: n, newIndex: j })),
    ];
  }

  // Backtrack through the recorded frontiers.
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const frontier = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && frontier[offset + k - 1] < frontier[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = frontier[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ type: "equal", oldIndex: x, newIndex: y });
    }
    if (d > 0) {
      if (x === prevX) {
        y -= 1;
        ops.push({ type: "insert", oldIndex: x, newIndex: y });
      } else {
        x -= 1;
        ops.push({ type: "delete", oldIndex: x, newIndex: y });
      }
    }
  }
  ops.reverse();
  return ops;
}

/**
 * Raw hunks: maximal runs of non-equal ops, as half-open line ranges into each side.
 */
export function rawHunks(ops) {
  const hunks = [];
  let current = null;
  let oldCursor = 0;
  let newCursor = 0;
  for (const op of ops) {
    if (op.type === "equal") {
      if (current) {
        hunks.push(current);
        current = null;
      }
      oldCursor = op.oldIndex + 1;
      newCursor = op.newIndex + 1;
      continue;
    }
    if (!current) current = { oldStart: oldCursor, oldEnd: oldCursor, newStart: newCursor, newEnd: newCursor };
    if (op.type === "delete") {
      current.oldEnd = op.oldIndex + 1;
      oldCursor = op.oldIndex + 1;
    } else {
      current.newEnd = op.newIndex + 1;
      newCursor = op.newIndex + 1;
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

/**
 * Occurrences may overlap (a run of identical lines): counting them non-overlapping
 * would call a window unique while the first match sits somewhere else entirely.
 */
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + 1);
  }
  return count;
}

/**
 * The text of lines [start, end) together with the separators that make them whole lines
 * in `lines.join("\n")`: a newline after each line, except that the file's tail carries the
 * newline *before* it instead. Both sides of a hunk share tail-ness (the suffix after the
 * change is identical), so `find` and `replace` built this way splice cleanly.
 */
function span(lines, start, end) {
  if (end <= start) return "";
  const body = lines.slice(start, end).join("\n");
  if (end === lines.length) return `${start > 0 ? "\n" : ""}${body}`;
  return `${body}\n`;
}

/**
 * Widen a hunk's window symmetrically until its `find` text occurs exactly once in the
 * original. Terminates because the whole file occurs once.
 */
function uniqueWindow(oldLines, oldText, hunk) {
  let before = 0;
  let after = 0;
  for (;;) {
    const start = hunk.oldStart - before;
    const end = hunk.oldEnd + after;
    const find = span(oldLines, start, end);
    if (find && countOccurrences(oldText, find) === 1) return { before, after };
    const canBefore = start > 0;
    const canAfter = end < oldLines.length;
    if (!canBefore && !canAfter) return { before, after };
    // Grow the side that still has room, alternating when both do.
    if (canBefore && (!canAfter || before <= after)) before += 1;
    else after += 1;
  }
}

function mergeTouching(windows) {
  const merged = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.oldStart - w.before <= last.oldEnd + last.after) {
      last.oldEnd = Math.max(last.oldEnd, w.oldEnd);
      last.newEnd = Math.max(last.newEnd, w.newEnd);
      last.touched = true;
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

/** Display lines for one window: context, removed, and added lines in file order. */
function displayLines(oldSlice, newSlice) {
  const lines = [];
  for (const op of diffOps(oldSlice, newSlice)) {
    if (op.type === "equal") lines.push({ type: "ctx", text: oldSlice[op.oldIndex] });
    else if (op.type === "delete") lines.push({ type: "del", text: oldSlice[op.oldIndex] });
    else lines.push({ type: "ins", text: newSlice[op.newIndex] });
  }
  return lines;
}

/**
 * Measure `newText` against `oldText` as anchored hunks:
 *
 *   {
 *     find, replace,        // context-widened; `find` occurs exactly once in oldText
 *     oldStart, oldEnd,     // 1-based inclusive line range of the changed lines in oldText
 *                           // (oldEnd === oldStart - 1 for a pure insertion)
 *     removed, added,       // changed line counts, context excluded
 *     lines,                // [{ type: "ctx" | "del" | "ins", text }] for display
 *   }
 *
 * Hunks are independent: their context windows never overlap, so any subset applies in
 * any order via `applyEdit`.
 */
export function anchoredHunks(oldText, newText) {
  if (oldText === newText) return [];
  if (!oldText) {
    return [
      {
        find: "",
        replace: newText,
        oldStart: 1,
        oldEnd: 0,
        removed: 0,
        added: newText.split("\n").length,
        lines: newText.split("\n").map((text) => ({ type: "ins", text })),
      },
    ];
  }

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let windows = rawHunks(diffOps(oldLines, newLines)).map((h) => ({ ...h, ...uniqueWindow(oldLines, oldText, h) }));

  // Merging can widen a window past a neighbour; iterate to a fixed point.
  for (;;) {
    const merged = mergeTouching(windows);
    const settled = merged.map((w) =>
      w.touched ? { ...w, ...uniqueWindow(oldLines, oldText, w), touched: false } : w,
    );
    if (settled.length === windows.length) {
      windows = settled;
      break;
    }
    windows = settled;
  }

  return windows.map((w) => {
    const start = w.oldStart - w.before;
    const end = w.oldEnd + w.after;
    const newStart = w.newStart - w.before;
    const newEnd = w.newEnd + w.after;
    return {
      find: span(oldLines, start, end),
      replace: span(newLines, newStart, newEnd),
      oldStart: w.oldStart + 1,
      oldEnd: w.oldEnd,
      removed: w.oldEnd - w.oldStart,
      added: w.newEnd - w.newStart,
      lines: displayLines(oldLines.slice(start, end), newLines.slice(newStart, newEnd)),
    };
  });
}

/** Plain-text rendering of a hunk's lines, unified-diff style, for prompts and terminals. */
export function renderHunkLines(lines, { maxLines = 400 } = {}) {
  const marks = { ctx: " ", del: "-", ins: "+" };
  const shown = lines.slice(0, maxLines).map((l) => `${marks[l.type]} ${l.text}`);
  if (lines.length > maxLines) shown.push(`  ... ${lines.length - maxLines} more line(s)`);
  return shown.join("\n");
}
