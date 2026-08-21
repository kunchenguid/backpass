import test from "node:test";
import assert from "node:assert/strict";

import { distill, isBoilerplate } from "../src/distill.js";
import { redact } from "../src/redact.js";
import { estimateTokens } from "../src/tokens.js";
import { sanitizeEvidence } from "../src/analyze.js";

const META = {
  id: "claude-abc",
  harness: "claude",
  model: "claude-opus-5",
  cwd: "/repo/demo",
  gitBranch: "main",
  startedAt: Date.parse("2026-08-01T10:00:00.000Z"),
  association: { tier: 1, confidence: "exact" },
  rawPath: "/home/u/.claude/projects/x/abc.jsonl",
};

test("the distilled trace keeps turns verbatim and reduces tool calls to one line each", () => {
  const { trace, stats } = distill(
    [
      { kind: "message", role: "user", text: "Open a PR for the parser fix." },
      { kind: "tool", name: "Bash", input: { command: "npm test" }, result: "ok" },
      { kind: "message", role: "assistant", text: "Opened PR #2731." },
    ],
    META,
  );

  assert.match(trace, /harness: claude/);
  assert.match(trace, /association: tier 1 \(exact\)/);
  assert.match(trace, /### turn 1 · user/);
  assert.match(trace, /Open a PR for the parser fix\./);
  assert.match(trace, /tool: Bash "npm test" -> ok/);
  assert.equal(stats.userTurns, 1);
  assert.equal(stats.assistantTurns, 1);
  assert.equal(stats.toolCalls, 1);
});

test("the trace ends with the raw transcript path - the cheap-first escape hatch", () => {
  const { trace } = distill([{ kind: "message", role: "user", text: "hello there" }], META);
  assert.match(trace, /raw transcript: \/home\/u\/\.claude\/projects\/x\/abc\.jsonl/);
});

test("large tool output is truncated and its real size reported", () => {
  const { trace } = distill(
    [{ kind: "tool", name: "Bash", input: { command: "cat big.log" }, result: "x".repeat(50_000) }],
    META,
  );
  assert.ok(trace.includes("truncated"), "must say it truncated");
  assert.ok(trace.includes("49KB"), "must report the original size");
  assert.ok(estimateTokens(trace) < 500, "truncation must actually shrink the trace");
});

test("injected harness scaffolding is dropped, not analyzed as user intent", () => {
  assert.equal(isBoilerplate("<system-reminder>\nsome injected note\n</system-reminder>"), true);
  assert.equal(isBoilerplate("<user_info>\nOS Version: darwin\n</user_info>"), true);
  assert.equal(isBoilerplate("   "), true);
  assert.equal(isBoilerplate("Please fix the failing test."), false);

  const { stats } = distill(
    [
      { kind: "message", role: "user", text: "<system-reminder>ignore</system-reminder>" },
      { kind: "message", role: "user", text: "Real request." },
    ],
    META,
  );
  assert.equal(stats.userTurns, 1);
});

test("a very long session is elided in the middle rather than truncated at the end", () => {
  const events = [];
  for (let i = 0; i < 400; i += 1) {
    events.push({ kind: "message", role: "user", text: `request number ${i} ${"padding ".repeat(40)}` });
    events.push({ kind: "message", role: "assistant", text: `reply number ${i} ${"padding ".repeat(40)}` });
  }

  const { trace, stats } = distill(events, META, { maxTraceTokens: 3000 });
  assert.equal(stats.elided, true);
  assert.ok(estimateTokens(trace) < 3600, "capped trace must respect the budget");
  assert.match(trace, /middle of session elided/);
  assert.ok(trace.includes("request number 0"), "the task as stated must survive");
  assert.ok(trace.includes("reply number 399"), "how it ended must survive");
});

test("obvious secrets are redacted before a trace reaches any model", () => {
  assert.match(redact("export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123"), /\[redacted:GITHUB_TOKEN\]/);
  assert.match(redact("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz"), /\[redacted:ANTHROPIC_KEY\]/);
  assert.match(redact("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"), /redacted/);
  assert.match(redact("MY_SECRET: hunter2hunter2"), /MY_SECRET=\[redacted\]/);
  assert.equal(redact("nothing sensitive here"), "nothing sensitive here");
});

test("redaction runs on tool input and output inside the trace", () => {
  const { trace } = distill(
    [
      {
        kind: "tool",
        name: "Bash",
        input: { command: 'curl -H "token: ghp_abcdefghijklmnopqrstuvwxyz0123"' },
        result: "ok",
      },
    ],
    META,
  );
  assert.ok(!trace.includes("ghp_abcdefghijklmnopqrstuvwxyz0123"));
});

test("evidence items without a verbatim quote are discarded at parse time", () => {
  const clean = sanitizeEvidence({
    positive: [
      { instruction: "AG-001", quote: "the agent posted the full URL", effect: "no follow-up" },
      { instruction: "AG-002", effect: "claimed without a quote" },
      { instruction: "AG-003", quote: "short" },
    ],
    negative: [{ instruction: "AG-004", quote: "it used a bare #2731 reference" }],
    gaps: [
      {
        proposedInstruction: "Read docs/db.md before writing queries.",
        quote: "walked migrations for 18 turns",
        recurrenceRisk: "high",
      },
      { proposedInstruction: "No quote here", recurrenceRisk: "high" },
    ],
    usedRawTranscript: true,
  });

  assert.equal(clean.positive.length, 1);
  assert.equal(clean.negative.length, 1);
  assert.equal(clean.gaps.length, 1);
  assert.equal(clean.usedRawTranscript, true);
  assert.equal(clean.gaps[0].recurrenceRisk, "high");
});

test("sanitizeEvidence tolerates a malformed model response", () => {
  const clean = sanitizeEvidence(null);
  assert.deepEqual(clean, { positive: [], negative: [], gaps: [], usedRawTranscript: false });
  assert.deepEqual(sanitizeEvidence({ positive: "not an array" }).positive, []);
});
