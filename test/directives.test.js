import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { distill } from "../src/distill.js";
import { sanitizeEvidence } from "../src/analyze.js";
import { foldEvidence, renderEvidenceForPrompt, renderEvidenceReport } from "../src/fold.js";
import { parseMemoryUnits } from "../src/memory.js";
import { estimateTokens } from "../src/tokens.js";
import {
  TASK_ID,
  carveEnvelope,
  directiveMetadata,
  extractDirectives,
  isDirectiveId,
  renderDirectiveIndex,
} from "../src/directives.js";
import * as claude from "../src/discovery/adapters/claude.js";
import * as pi from "../src/discovery/adapters/pi.js";

const FIXTURES = path.dirname(fileURLToPath(import.meta.url));
const META = {
  id: "directive-demo",
  harness: "claude",
  association: { tier: 1, confidence: "exact" },
  rawPath: "/tmp/directive-spans.jsonl",
};

function fixtureEvents() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, "fixtures/directive-spans.json"), "utf8"));
}

test("only the authoritative envelope becomes instruction text", () => {
  const envelope = carveEnvelope(fixtureEvents()[0].text);
  assert.match(envelope, /Migrate the auth module/);
  assert.match(envelope, /Keep the public function names unchanged/);
  assert.ok(!envelope.includes("previous assistant said"), "quoted transcript must not be authority");
  assert.ok(!envelope.includes("401 Unauthorized"), "quoted tool output must not be authority");
  assert.ok(!envelope.includes("refreshSession"), "pasted tool output must not be authority");
});

test("a nested inner fence stays inside the paste; the outer fence closes it", () => {
  const envelope = carveEnvelope(
    [
      "Update the README:",
      "````md",
      "# doc",
      "```bash",
      "rm -rf build",
      "```",
      "````",
      "Keep the examples short.",
    ].join("\n"),
  );
  assert.ok(!envelope.includes("rm -rf build"), "pasted command must not be authority");
  assert.ok(!envelope.includes("# doc"), "pasted doc body must not be authority");
  assert.match(envelope, /Update the README:/);
  assert.match(envelope, /Keep the examples short\./);
});

test("a tilde fence never closes a backtick block", () => {
  const envelope = carveEnvelope(["Fix this:", "```", "~~~", "rm -rf build", "```", "Run the tests."].join("\n"));
  assert.ok(!envelope.includes("rm -rf build"), "the tilde line does not close the backtick fence");
  assert.match(envelope, /Run the tests\./);
});

test("a line of inline code is instruction text, not a fence opener", () => {
  const envelope = carveEnvelope("```pnpm run check``` must pass before you push.\nAlso update the README.");
  assert.match(envelope, /must pass before you push\./);
  assert.match(envelope, /Also update the README\./);
});

test("an unclosed fence still withholds the paste", () => {
  assert.equal(carveEnvelope("Do the migration.\n```\nError: boom"), "Do the migration.");
});

test("an indented fence line inside a paste neither opens nor closes", () => {
  const envelope = carveEnvelope(
    [
      "Fix the docs:",
      "```md",
      "Example:",
      "    ```bash",
      "    npm ci",
      "    ```",
      "End.",
      "```",
      "Use pnpm, not npm.",
    ].join("\n"),
  );
  assert.ok(!envelope.includes("npm ci"), "the indented block stays inside the paste");
  assert.ok(!envelope.includes("End."), "the paste remainder never re-enters the envelope");
  assert.match(envelope, /Fix the docs:/);
  assert.match(envelope, /Use pnpm, not npm\./);
});

test("an over-limit turn keeps its instruction when the closing fence falls in the clamped region", () => {
  const log = "2026-01-01T00:00:00Z some CI log line\n".repeat(200);
  const { turns } = distill(
    [
      { kind: "message", role: "user", text: `\`\`\`\n${log}\`\`\`\n\nKeep the public API stable.` },
      { kind: "message", role: "assistant", text: "Will do." },
    ],
    META,
  );
  assert.ok(turns[0].text.includes("chars elided"), "the turn text is clamped");
  const spans = extractDirectives(turns);
  assert.deepEqual(
    spans.map((span) => [span.id, span.turn]),
    [[TASK_ID, 1]],
  );
  assert.equal(turns[0].envelope, "Keep the public API stable.");
});

test("an over-limit turn whose only instruction is clamped out is marked clamped, not pointed at", () => {
  const filler = (label) => `${label} log line detail\n`.repeat(300);
  const { turns, trace } = distill(
    [
      {
        kind: "message",
        role: "user",
        text: `${filler("head")}Keep the public API stable.\n${filler("tail")}`,
      },
      { kind: "message", role: "assistant", text: "Will do." },
    ],
    META,
  );
  assert.ok(!turns[0].text.includes("Keep the public API stable."), "the instruction sits in the clamped middle");
  assert.ok(!trace.includes("Keep the public API stable."), "the trace never carries the instruction");
  assert.match(turns[0].envelope, /Keep the public API stable\./);
  const spans = extractDirectives(turns);
  assert.equal(spans[0].clamped, true);
  const section = renderDirectiveIndex(spans);
  assert.match(section, /turn 1 - clamped from the trace, open the raw transcript for its text/);
  assert.ok(!section.includes("see turn 1 in the trace"));
});

test("the first user turn is the task, later ones are steering; assistant and tool turns never index", () => {
  const { turns } = distill(fixtureEvents(), META);
  const spans = extractDirectives(turns);
  assert.deepEqual(
    spans.map((span) => [span.id, span.kind, span.turn, span.authority]),
    [
      [TASK_ID, "task", 1, "direct-task"],
      ["STEER-3", "steering", 3, "direct-steering"],
      ["STEER-4", "steering", 4, "direct-steering"],
    ],
  );
  assert.ok(
    spans.every((span) => span.turn !== 2),
    "the assistant reply and the tool result never index",
  );
  assert.ok(isDirectiveId("TASK-1") && isDirectiveId("STEER-4"));
  assert.ok(!isDirectiveId("AG-001") && !isDirectiveId("TASK-2") && !isDirectiveId("banana"));
});

test("a short imperative is addressable: length never decides which turn is the task", () => {
  const { turns } = distill(
    [
      { kind: "message", role: "user", text: "ship it" },
      { kind: "message", role: "user", text: "Add tests." },
      { kind: "message", role: "user", text: "Use pnpm, never npm." },
    ],
    META,
  );
  const spans = extractDirectives(turns);
  assert.deepEqual(
    spans.map((span) => [span.id, span.kind, span.turn]),
    [
      [TASK_ID, "task", 1],
      ["STEER-2", "steering", 2],
      ["STEER-3", "steering", 3],
    ],
  );
});

test("every lifetime runs from its own turn onward; later steering never closes it", () => {
  const { turns } = distill(fixtureEvents(), META);
  const spans = extractDirectives(turns);
  for (const span of spans) assert.deepEqual(span.lifetime, { fromTurn: span.turn, toTurn: null });
});

test("a message that is only quotes and pastes yields no span", () => {
  const { turns } = distill(
    [
      { kind: "message", role: "user", text: "> quoted transcript line\n\n```\npasted output\n```" },
      { kind: "message", role: "assistant", text: "Noted." },
    ],
    META,
  );
  const spans = extractDirectives(turns);
  assert.deepEqual(spans, []);
  assert.match(renderDirectiveIndex(spans), /\(none/);
});

test("the index renders by reference and never repeats turn text", () => {
  const { turns, trace } = distill(fixtureEvents(), META);
  const spans = extractDirectives(turns);
  const section = renderDirectiveIndex(spans);
  assert.match(section, /\[TASK-1\] task · turn 1 · authority direct-task/);
  assert.match(section, /see turn 1 in the trace/);
  assert.match(section, /lifetime turns 1\+/);
  for (const entry of turns.filter((candidate) => candidate.role === "user")) {
    assert.ok(!section.includes(entry.envelope), `turn ${entry.turn} text must not be duplicated`);
  }
  assert.ok(trace.includes("Migrate the auth module"), "the trace itself still carries the text");
});

test("an indexed turn the trace elided is marked elided, not pointed at", () => {
  const filler = (n) => `${"pipeline detail ".repeat(400)} step ${n}`;
  const events = [
    { kind: "message", role: "user", text: "Migrate the auth module." },
    ...Array.from({ length: 30 }, (_, i) => [
      { kind: "message", role: "assistant", text: filler(i) },
      { kind: "message", role: "user", text: `Also handle case ${i}.` },
    ]).flat(),
    { kind: "message", role: "user", text: "Keep the public API stable." },
  ];
  const distilled = distill(events, META);
  assert.equal(distilled.stats.elided, true);
  const spans = extractDirectives(distilled.turns);
  const elidedSpans = spans.filter((span) => span.elided);
  assert.ok(elidedSpans.length, "the capped middle holds at least one indexed user turn");
  const section = renderDirectiveIndex(spans);
  for (const span of elidedSpans) {
    assert.ok(section.includes(`turn ${span.turn} - elided from the trace`), `span ${span.id} must be marked elided`);
    assert.ok(!section.includes(`see turn ${span.turn} in the trace`));
  }
  const kept = spans.find((span) => !span.elided);
  assert.ok(section.includes(`see turn ${kept.turn} in the trace`), "a surviving turn still points at the trace");
});

test("a fence indented inside a list item still opens a paste", () => {
  const envelope = carveEnvelope(
    ["Steps:", "10. Run:", "", "    ```bash", "    rm -rf dist", "    ```", "", "Then deploy."].join("\n"),
  );
  assert.ok(!envelope.includes("rm -rf dist"), "a list-item code block is still a paste");
  assert.match(envelope, /Steps:/);
  assert.match(envelope, /Then deploy\./);
});

test("a turn the trace only half kept is marked elided, never pointed at", () => {
  const events = Array.from({ length: 40 }, (_, i) => ({
    kind: "message",
    role: i % 2 === 0 ? "user" : "assistant",
    text: `${i % 2 === 0 ? "Also handle case" : "Handled case"} ${i}. ${"pipeline detail ".repeat(6)}marker-${i}`,
  }));
  const distilled = distill(events, META, { maxTraceTokens: 1000 });
  assert.equal(distilled.stats.elided, true);
  const spans = extractDirectives(distilled.turns);
  const section = renderDirectiveIndex(spans);
  let halfKept = 0;
  for (const span of spans) {
    const entry = distilled.turns.find((candidate) => candidate.turn === span.turn);
    const whole = distilled.trace.includes(entry.text);
    const partial = !whole && distilled.trace.includes(entry.text.slice(0, 20));
    if (partial) halfKept += 1;
    if (!span.elided) {
      assert.ok(whole, `span ${span.id} is pointed at but turn ${span.turn} is not wholly in the trace`);
      assert.ok(section.includes(`see turn ${span.turn} in the trace`));
    } else {
      assert.ok(section.includes(`turn ${span.turn} - elided from the trace`));
    }
  }
  assert.ok(halfKept >= 1, "the head or tail cut must straddle at least one indexed turn");
});

test("sanitizeEvidence accepts issued directive ids and drops the rest", () => {
  const memoryFile = { units: parseMemoryUnits("# T\n\n- First rule\n") };
  const clean = sanitizeEvidence(
    {
      positive: [
        { instruction: "TASK-1", quote: "Migrate the auth module", effect: "followed the brief" },
        { instruction: "STEER-4", quote: "keep the old refresh-token flow", effect: "kept it" },
        { instruction: "AG-001", quote: "First rule", effect: "followed memory too" },
        { instruction: "AG-999", quote: "First rule", effect: "hallucinated memory id" },
        { instruction: "STEER-9", quote: "First rule", effect: "hallucinated steering id" },
      ],
      usedRawTranscript: true,
    },
    memoryFile,
    null,
    ["TASK-1", "STEER-4"],
  );
  assert.deepEqual(
    clean.positive.map((item) => item.instruction),
    ["TASK-1", "STEER-4", "AG-001"],
  );
});

test("the fold keeps directive cites out of memory-instruction rows", () => {
  const meta = directiveMetadata(extractDirectives(distill(fixtureEvents(), META).turns));
  assert.ok(!JSON.stringify(meta).includes("Migrate"), "persisted metadata carries ids and spans, never turn text");
  const memoryFile = { units: parseMemoryUnits("# T\n\n- First rule\n") };
  const summary = foldEvidence(
    [
      {
        status: "ok",
        transcript: { id: "s1", harness: "claude", startedAt: Date.parse("2026-08-01T00:00:00Z") },
        directives: meta,
        positive: [{ instruction: "TASK-1", quote: "Migrate the auth module", effect: "followed it" }],
        negative: [{ instruction: "STEER-4", quote: "old refresh-token flow", effect: "dropped it", class: "harm" }],
        gaps: [],
      },
    ],
    { memoryFile },
  );
  assert.ok(
    !summary.instructions.some((row) => isDirectiveId(row.instruction)),
    "a directive cite never becomes a memory-instruction row",
  );
  assert.equal(summary.totals.instructionsWithNegatives, 0, "no memory instruction drew a negative here");
  for (const rendered of [renderEvidenceForPrompt(summary), renderEvidenceReport(summary)]) {
    assert.ok(!rendered.includes("[TASK-1]") && !rendered.includes("[STEER-4]"), "no directive rows are rendered");
  }
});

test("the directive index costs a fraction of duplicating the turns it points at", () => {
  const cases = [
    { file: "claude-session.jsonl", read: (ref) => claude.read(ref) },
    { file: "pi-session.jsonl", read: (ref) => pi.read(ref) },
  ];
  for (const { file, read } of cases) {
    const candidate = { key: file, path: path.join(FIXTURES, "fixtures", file) };
    const stat = fs.statSync(candidate.path);
    candidate.mtimeMs = stat.mtimeMs;
    candidate.bytes = stat.size;
    const { events } = read({ path: candidate.path });
    const distilled = distill(events, {
      ...META,
      harness: candidate.path.includes("pi-") ? "pi" : "claude",
    });
    const spans = extractDirectives(distilled.turns);
    const section = renderDirectiveIndex(spans);
    const sectionTokens = estimateTokens(section);
    // By-reference cost scales with the span count, never the turn length: one
    // bounded entry per span, whatever the turn says.
    if (spans.length) {
      assert.ok(
        sectionTokens <= spans.length * 50,
        `${file}: ${spans.length} span(s) must cost at most ~50 tok each, got ${sectionTokens} tok`,
      );
    }
    console.log(
      `directives ${file}: +${sectionTokens} tok index for ${spans.length} span(s) ` +
        `on ${estimateTokens(distilled.trace)} tok trace`,
    );
  }
  // Where it matters - long task turns - by-reference beats duplicating the text.
  const long = distill(fixtureEvents(), META);
  const longSpans = extractDirectives(long.turns);
  const longSection = estimateTokens(renderDirectiveIndex(longSpans));
  const duplicated = longSpans.reduce(
    (sum, span) => sum + estimateTokens(long.turns.find((entry) => entry.turn === span.turn)?.text || ""),
    0,
  );
  assert.ok(
    longSection < duplicated,
    `directive-spans fixture: index (${longSection} tok) must beat duplication (${duplicated} tok)`,
  );
  console.log(`directives directive-spans.json: +${longSection} tok index vs ${duplicated} tok duplicated`);
});

test("the same steer ignored in two sessions still clusters into a proposal-eligible gap", () => {
  const meta = directiveMetadata(extractDirectives(distill(fixtureEvents(), META).turns));
  const memoryFile = { units: parseMemoryUnits("# T\n\n- First rule\n") };
  const session = (id) => ({
    status: "ok",
    transcript: { id, harness: "claude", startedAt: Date.parse("2026-08-01T00:00:00Z") },
    directives: meta,
    positive: [],
    // The user had to steer it in this session, and the agent ignored the steer: a
    // directive negative for provenance, and a gap because a directive is not memory.
    negative: [
      { instruction: "STEER-4", quote: "old refresh-token flow", effect: "dropped it", class: "non-compliance" },
    ],
    gaps: [
      {
        mistake: "dropped the refresh-token flow the user asked to keep",
        proposedInstruction: "Keep the old refresh-token flow when migrating auth.",
        recurrenceRisk: "high",
        domain: "project",
        quote: "old refresh-token flow",
      },
    ],
  });
  const summary = foldEvidence([session("s1"), session("s2")], { memoryFile, minGapEvidence: 2 });
  assert.equal(summary.gaps.length, 1, "the recurring steer is one proposal-eligible gap cluster");
  assert.equal(summary.gaps[0].sessions, 2);
  assert.equal(summary.totals.gapSightings, 2);
});
