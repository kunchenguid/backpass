import test from "node:test";
import assert from "node:assert/strict";

import {
  clipLine,
  fitPlain,
  formatBytes,
  formatCount,
  formatElapsed,
  gaugeBar,
  lr,
  renderFrame,
  spinnerFrame,
  stripAnsi,
  visibleWidth,
  SPINNER_FRAMES,
} from "../src/tui/render.js";
import { initialState, reduceEvent } from "../src/tui/index.js";
import { makeTheme } from "../src/tui/theme.js";

const plain = makeTheme({ depth: 0 });
const T0 = Date.parse("2026-08-21T10:00:00Z");

function baseMeta() {
  return { version: "1.1.0", repoName: "eddies-wallet", worktrees: 3, since: "30d", maxEdits: 5 };
}

/** Replay one event script into a fresh state, advancing the clock per step. */
function stateAfter(events) {
  const state = initialState(baseMeta());
  events.forEach(([event, data], index) => reduceEvent(state, event, data, T0 + index * 1000));
  return state;
}

function render(state, { width = 110, now = T0 + 60_000 } = {}) {
  return renderFrame(state, { width, theme: plain, now, spin: "⠸" });
}

// ---------- text helpers ----------

test("visibleWidth ignores ANSI escapes", () => {
  assert.equal(visibleWidth("\x1b[38;2;1;2;3mabc\x1b[0m"), 3);
  assert.equal(stripAnsi("\x1b[1mx\x1b[0m"), "x");
});

test("clipLine truncates by visible cells and keeps escapes intact", () => {
  const painted = `\x1b[31m${"a".repeat(20)}\x1b[0m`;
  const clipped = clipLine(painted, 10);
  assert.equal(visibleWidth(clipped), 10);
  assert.ok(stripAnsi(clipped).endsWith("…"));
  assert.equal(clipLine("short", 10), "short");
});

test("fitPlain pads and ellipsizes", () => {
  assert.equal(fitPlain("ab", 4), "ab  ");
  assert.equal(fitPlain("ab", 4, "right"), "  ab");
  assert.equal(fitPlain("abcdef", 4), "abc…");
});

test("lr right-aligns and drops the right side when it cannot fit", () => {
  assert.equal(lr("left", "right", 20), "left" + " ".repeat(11) + "right");
  assert.equal(lr("a-very-long-left-side", "right", 22), "a-very-long-left-side");
});

test("formatters produce the mock's vocabulary", () => {
  assert.equal(formatBytes(1.9 * 1024 * 1024), "1.9 MB");
  assert.equal(formatBytes(412 * 1024), "412.0 KB");
  assert.equal(formatBytes(83), "83 B");
  assert.equal(formatElapsed(12), "12ms");
  assert.equal(formatElapsed(4000), "0:04");
  assert.equal(formatElapsed(245_000), "4:05");
  assert.equal(formatCount(10317), "10,317");
});

test("gaugeBar fills by ratio and marks overflow with !!", () => {
  assert.equal(gaugeBar(plain, 0.5, 10), "▰▰▰▰▰▱▱▱▱▱");
  assert.equal(gaugeBar(plain, 0, 10), "▱".repeat(10));
  assert.equal(gaugeBar(plain, 1, 10), "▰".repeat(10));
  assert.equal(gaugeBar(plain, 1.04, 10), "▰".repeat(8) + "!!");
});

test("spinner cycles through the braille frames on an 80ms cadence", () => {
  assert.equal(spinnerFrame(0), SPINNER_FRAMES[0]);
  assert.equal(spinnerFrame(80), SPINNER_FRAMES[1]);
  assert.equal(spinnerFrame(80 * SPINNER_FRAMES.length), SPINNER_FRAMES[0]);
});

// ---------- event reduction ----------

test("discovery events accumulate per-harness rows and totals", () => {
  const state = stateAfter([
    ["discover:start", { harnesses: ["claude", "codex", "pi"] }],
    ["discover:harness:start", { harness: "claude" }],
    ["discover:harness:done", { harness: "claude", scanned: 214, cached: 131, matched: 38, tiers: { 1: 36, 2: 2 } }],
    ["discover:harness:start", { harness: "codex" }],
    ["discover:harness:tick", { harness: "codex", scanned: 8912, total: 10317, matched: 9 }],
  ]);

  assert.equal(state.discover.status, "active");
  assert.equal(state.discover.harnesses.claude.status, "done");
  assert.equal(state.discover.harnesses.claude.newCount, 83);
  assert.equal(state.discover.harnesses.codex.status, "scanning");
  assert.equal(state.discover.totalMatched, 47);
  assert.equal(state.discover.storesOk, 1);
});

test("an unreadable store becomes an error row, not a failed run", () => {
  const state = stateAfter([
    ["discover:start", { harnesses: ["pi"] }],
    ["discover:harness:start", { harness: "pi" }],
    ["discover:harness:done", { harness: "pi", error: "ENOENT" }],
    ["discover:done", { total: 0 }],
  ]);
  assert.equal(state.discover.harnesses.pi.status, "error");
  assert.equal(state.discover.storesOk, 0);
  assert.equal(state.discover.status, "done");
});

test("analyze events drive lanes, counters, and the running evidence tally", () => {
  const state = stateAfter([
    ["analyze:start", { pending: 25, cached: 33, total: 58, jobs: 4, agent: "codex", model: "gpt-5.2-mini" }],
    ["analyze:lane", { slot: 0, harness: "claude", id: "7c1f39aa", title: "refactor wallet sync", phase: "distill" }],
    [
      "analyze:lane",
      {
        slot: 0,
        harness: "claude",
        id: "7c1f39aa",
        title: "refactor wallet sync",
        phase: "model",
        rawBytes: 1_990_000,
        distilledBytes: 12_700,
      },
    ],
    ["analyze:evidence", { positive: 4, negative: 1, gaps: 2 }],
    ["analyze:tick", { slot: 0, done: 1, ok: 1, skipped: 0, failed: 0 }],
  ]);

  assert.equal(state.analyze.status, "active");
  assert.equal(state.analyze.lanes.length, 4);
  assert.equal(state.analyze.lanes[0], null);
  assert.equal(state.analyze.done, 1);
  assert.deepEqual(state.analyze.evidence, { positive: 4, negative: 1, gaps: 2 });
});

test("fold and synthesis events settle the tail stages", () => {
  const state = stateAfter([
    ["fold:done", { instructions: 24, clustersFound: 9, clustersKept: 4, minGapEvidence: 2, ms: 12 }],
    [
      "synth:start",
      {
        agent: "claude",
        model: "claude-opus-5",
        effort: "high",
        attempt: 1,
        sessionName: "backpass-synth-1",
        gapClusters: 4,
        instructions: 24,
        suppressed: 1,
      },
    ],
    ["synth:violations", { attempt: 1, violations: ["projected file is 5,180 tok"] }],
    [
      "synth:start",
      { agent: "claude", model: "claude-opus-5", effort: "high", attempt: 2, sessionName: "backpass-synth-1" },
    ],
  ]);

  assert.equal(state.fold.status, "done");
  assert.equal(state.fold.clustersKept, 4);
  assert.equal(state.synthesize.attempt, 2);
  assert.deepEqual(state.synthesize.violations, ["projected file is 5,180 tok"]);
});

// ---------- full frames ----------

const DISCOVERY_SCRIPT = [
  ["memory", { path: "AGENTS.md", tokens: 2412, budget: 5000, units: 63 }],
  ["discover:start", { harnesses: ["claude", "codex", "opencode", "grok", "pi"] }],
  ["discover:harness:start", { harness: "claude" }],
  ["discover:harness:done", { harness: "claude", scanned: 214, cached: 131, matched: 38, tiers: { 1: 36, 2: 2 } }],
  ["discover:harness:start", { harness: "codex" }],
  ["discover:harness:tick", { harness: "codex", scanned: 8912, total: 10317, matched: 9 }],
  ["discover:harness:start", { harness: "opencode" }],
  ["discover:harness:done", { harness: "opencode", scanned: 4, cached: 0, matched: 4, tiers: { 1: 4 } }],
  ["discover:harness:start", { harness: "grok" }],
  ["discover:harness:done", { harness: "grok", scanned: 41, cached: 36, matched: 3, tiers: { 2: 3 } }],
  ["discover:harness:start", { harness: "pi" }],
  ["discover:harness:done", { harness: "pi", error: "store unreadable" }],
];

test("discovery frame: header gauge, rail, per-harness rows, plain-language labels", () => {
  const lines = render(stateAfter(DISCOVERY_SCRIPT));
  const text = lines.join("\n");

  assert.ok(text.includes("∇ backpass v1.1.0"));
  assert.ok(text.includes("eddies-wallet · 3 worktrees · since 30d"));
  assert.ok(text.includes("2,412 / 5,000 tok"));
  assert.ok(text.includes("63 instructions · budget 48%"));
  assert.ok(text.includes("sessions from this repo so far"));
  assert.ok(
    text.includes("── collect samples · local stores only"),
    "the detail panel carries the training-loop label",
  );
  for (const label of ["collect samples", "calculate loss", "aggregate gradients", "gradient descent"]) {
    assert.ok(
      lines.some((line) => new RegExp(`^ \\S ${label}( |$)`, "u").test(line)),
      `the rail shows the stage as "${label}"`,
    );
  }
  assert.ok(!/\b(discover|analyze|fold|synthesize)\b/.test(text), "internal stage keys never reach the screen");
  assert.ok(text.includes("214 sessions · 83 new"));
  assert.ok(text.includes("38 this repo"));
  assert.ok(text.includes("ran in this repo"));
  assert.ok(text.includes("git remote match"));
  assert.ok(text.includes("8,912/10,317 sessions"));
  assert.ok(text.includes("9 so far"));
  assert.ok(text.includes("1 sqlite query"));
  assert.ok(text.includes("store unreadable · harness skipped, run continues"));
  assert.ok(text.includes("fail-soft"));
  assert.ok(text.includes("new = not seen by a previous scan"));
  // The forbidden jargon from the design review must never resurface.
  assert.ok(!text.includes("tier"));
  assert.ok(!text.includes("rollout"));
  assert.ok(!/\bmatched\b/.test(text));
});

test("every line fits the terminal and the header box is intact", () => {
  for (const width of [100, 80, 62]) {
    const lines = render(stateAfter(DISCOVERY_SCRIPT), { width });
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= Math.min(width, 110), `line overflows at width ${width}: ${stripAnsi(line)}`);
    }
    assert.ok(stripAnsi(lines[0]).startsWith("╭"));
    assert.ok(stripAnsi(lines[3]).startsWith("╰"));
  }
});

const ANALYZE_SCRIPT = [
  ...DISCOVERY_SCRIPT,
  ["discover:harness:done", { harness: "codex", scanned: 10317, cached: 9893, matched: 11, tiers: { 2: 11 } }],
  ["discover:done", { total: 53 }],
  ["analyze:start", { pending: 25, cached: 33, total: 58, jobs: 4, agent: "codex", model: "gpt-5.2-mini" }],
  [
    "analyze:lane",
    { slot: 0, harness: "claude", id: "7c1f39aa", title: "refactor wallet sync engine", phase: "distill" },
  ],
  [
    "analyze:lane",
    {
      slot: 1,
      harness: "grok",
      id: "51a7ff08",
      title: "add csv export",
      phase: "model",
      rawBytes: 640_000,
      distilledBytes: 8_400,
    },
  ],
  ["analyze:evidence", { positive: 61, negative: 14, gaps: 22 }],
  ["analyze:tick", { slot: 2, done: 18, ok: 16, skipped: 1, failed: 1 }],
];

test("analyze frame: pool bar, lanes with distill receipts, counters, evidence tally", () => {
  const lines = render(stateAfter(ANALYZE_SCRIPT));
  const text = lines.join("\n");

  assert.ok(text.includes("18/25"));
  assert.ok(text.includes("33 already analyzed · jobs 4"));
  assert.ok(text.includes("one cheap call per transcript · codex · gpt-5.2-mini"));
  assert.ok(text.includes("distilling…"));
  assert.ok(text.includes("distilled 625.0 KB ▸ 8.2 KB"));
  assert.ok(text.includes("16 ok"));
  assert.ok(text.includes("skipped (trivial session)"));
  assert.ok(text.includes("failed (will retry)"));
  assert.ok(text.includes("33 reused (analyzed in an earlier run)"));
  assert.ok(text.includes("✓ 61 helped"));
  assert.ok(text.includes("✗ 14 violated"));
  assert.ok(text.includes("◆ 22 gaps"));
  assert.ok(!text.includes("claims without a verbatim quote are dropped"));
  assert.ok(text.includes("53 sessions from this repo"));
});

test("analyze frame: lane rows show the human title and never the transcript id", () => {
  const lines = render(stateAfter(ANALYZE_SCRIPT));
  const text = lines.join("\n");

  assert.ok(text.includes("refactor wallet sync engine"));
  assert.ok(text.includes("add csv export"));
  assert.ok(!text.includes("7c1f39aa"));
  assert.ok(!text.includes("51a7ff08"));
});

test("analyze frame: a lane whose title is a clean fallback still carries no id", () => {
  const uuid = "0f3b6a2e-9d1c-4e7a-b8c5-1d2e3f4a5b6c";
  const script = [
    ...ANALYZE_SCRIPT,
    ["analyze:lane", { slot: 2, harness: "codex", id: uuid, title: "session 2026-08-21 14:03", phase: "distill" }],
    ["analyze:lane", { slot: 3, harness: "codex", id: uuid, title: "(untitled)", phase: "distill" }],
  ];
  const text = render(stateAfter(script)).join("\n");

  assert.ok(text.includes("session 2026-08-21 14:03"));
  assert.ok(text.includes("(untitled)"));
  assert.ok(!text.includes(uuid));
  assert.ok(!text.includes(uuid.slice(0, 8)));
});

const SYNTH_SCRIPT = [
  ...ANALYZE_SCRIPT,
  ["analyze:done", { total: 58, analyzed: 23, cached: 33, skipped: 1, failed: 1 }],
  ["fold:done", { instructions: 24, clustersFound: 9, clustersKept: 4, minGapEvidence: 2, ms: 12 }],
  [
    "synth:start",
    {
      agent: "claude",
      model: "claude-opus-5",
      effort: "high",
      attempt: 1,
      sessionName: "backpass-synth-84121",
      gapClusters: 4,
      instructions: 24,
      suppressed: 1,
    },
  ],
];

test("synthesis frame: fold rail line, sparse panel, suppression note - no gates checklist", () => {
  const lines = render(stateAfter(SYNTH_SCRIPT));
  const text = lines.join("\n");

  assert.ok(text.includes("23 ok · 1 skipped · 1 failed · 33 reused"));
  assert.ok(text.includes("24 instructions scored · 9 gaps → 4 clusters kept (seen in ≥2 sessions)"));
  assert.ok(text.includes("editing · claude · claude-opus-5 · effort high"));
  assert.ok(text.includes("── gradient descent · aggregated gradients → at most 5 edits"));
  assert.ok(text.includes("weighing 4 gap clusters + 24 instruction records against the budget…"));
  assert.ok(text.includes("session backpass-synth-84121"));
  assert.ok(text.includes("1 previously rejected edit(s) suppressed"));
  // Gates only surface when one fails (decided in review).
  assert.ok(!text.includes("gates"));
});

test("a gate violation renders the exact breaches and the re-prompt marker", () => {
  const lines = render(
    stateAfter([
      ...SYNTH_SCRIPT,
      ["synth:violations", { attempt: 1, violations: ["E2 adds an instruction with evidence from 1 session"] }],
      [
        "synth:start",
        {
          agent: "claude",
          model: "claude-opus-5",
          effort: "high",
          phase: "annotate",
          attempt: 2,
          changes: 3,
          sessionName: "backpass-synth-84121",
        },
      ],
    ]),
  );
  const text = lines.join("\n");

  assert.ok(text.includes("synthesis violated 1 gate(s)"));
  assert.ok(text.includes("re-prompting with the exact breaches"));
  assert.ok(text.includes("✗ E2 adds an instruction with evidence from 1 session"));
  assert.ok(text.includes("re-prompt 1"));
  assert.ok(text.includes("annotating 3 measured change(s) with evidence…"));
});

test("an over-budget file flips the header gauge into shrink-plan mode", () => {
  const lines = render(
    stateAfter([
      ["memory", { path: "AGENTS.md", tokens: 5214, budget: 5000, units: 71 }],
      ["discover:start", { harnesses: ["claude"] }],
    ]),
  );
  const text = lines.join("\n");

  assert.ok(text.includes("!!"));
  assert.ok(text.includes("5,214 / 5,000 tok"));
  assert.ok(text.includes("OVER · shrink plan"));
});

test("narrow terminals drop the right-hand column", () => {
  const wide = render(stateAfter(SYNTH_SCRIPT), { width: 110 });
  const narrow = render(stateAfter(SYNTH_SCRIPT), { width: 70 });

  assert.ok(wide.join("\n").includes("session backpass-synth-84121"));
  assert.ok(!narrow.join("\n").includes("session backpass-synth-84121"));
  for (const line of narrow) {
    assert.ok(visibleWidth(line) <= 70, `narrow line overflows: ${stripAnsi(line)}`);
  }
});
