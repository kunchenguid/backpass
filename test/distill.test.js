import test from "node:test";
import assert from "node:assert/strict";

import { distill, isBoilerplate } from "../src/distill.js";
import { redact } from "../src/redact.js";
import { estimateTokens } from "../src/tokens.js";
import { locateQuote, sanitizeEvidence } from "../src/analyze.js";
import { parseMemoryUnits } from "../src/memory.js";

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

test("redaction leaves benign token-count arguments alone", () => {
  assert.equal(redact("max_output_tokens:12000,yield_time_ms:1000"), "max_output_tokens:12000,yield_time_ms:1000");
  assert.equal(
    redact("usage: { prompt_tokens: 1234, completion_tokens: 56 }"),
    "usage: { prompt_tokens: 1234, completion_tokens: 56 }",
  );
  // Genuine secret assignments still redact, wherever the secret word sits.
  assert.match(redact("API_KEY=abcdef1234567890"), /API_KEY=\[redacted\]/);
  assert.match(redact("SECRET_KEY=abcdefgh12345678"), /SECRET_KEY=\[redacted\]/);
  assert.match(redact("SECRET_KEY_BASE=abcdefgh12345678"), /SECRET_KEY_BASE=\[redacted\]/);
  assert.match(redact("AWS_SECRET_KEY=abcdefgh12345678"), /AWS_SECRET_KEY=\[redacted\]/);
  assert.match(redact("auth_token: 12345678"), /auth_token=\[redacted\]/);
  assert.match(redact("GITHUB_TOKEN: abcdefgh12345678"), /GITHUB_TOKEN=\[redacted\]/);
  assert.match(redact('password="s3cr3t-p@ss!"'), /password=\[redacted\]/);
  // A fully quoted value is redacted whole, comma and all.
  assert.equal(redact('password="supersecret,withcomma"'), "password=[redacted]");
  // A truncated command leaves the quote unterminated; the secret must still go.
  assert.equal(redact('export DB_PASSWORD="hunter2hunter2secret'), "export DB_PASSWORD=[redacted]");
  assert.equal(redact("aws_secret_access_key='AKIAsecretvaluehere"), "aws_secret_access_key=[redacted]");
  // A closed quoted value may span lines when its closing quote ends the line.
  assert.equal(redact('PASSWORD="abcdefgh\nijklmnop"'), "PASSWORD=[redacted]");
  // An unterminated quote falls back to the bounded unquoted form, so the
  // following text survives.
  assert.equal(
    redact('DB_PASSWORD="hunter2hunter2secret\nRun tests and note "done"'),
    'DB_PASSWORD=[redacted]\nRun tests and note "done"',
  );
  // A match never consumes past the value into the next argument.
  assert.equal(redact("API_KEY=abcdef12345678, region=us-east-1"), "API_KEY=[redacted], region=us-east-1");
  assert.equal(redact("token=abcdefgh1234,next=1"), "token=[redacted],next=1");
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

test("split paragraphs accept only sentence-part attribution targets", () => {
  const blob = Array.from(
    { length: 8 },
    (_, i) => `Sentence ${i + 1} defines a separate requirement that should receive precise evidence attribution.`,
  ).join(" ");
  const memoryFile = { units: parseMemoryUnits(`# T\n\n${blob}\n`) };
  assert.ok(memoryFile.units[0].parts?.length > 1);

  const clean = sanitizeEvidence(
    {
      positive: [
        { instruction: "AG-001", quote: "followed the entire oversized paragraph" },
        { instruction: "AG-001.2", quote: "followed the second sentence precisely" },
        { instruction: "AG-999", quote: "cited an instruction that does not exist" },
      ],
    },
    memoryFile,
  );
  assert.deepEqual(
    clean.positive.map((item) => item.instruction),
    ["AG-001.2"],
  );
});

test("a quote that matches the distilled trace keeps a window sliced from that string", () => {
  const trace = [
    "### turn 3 · assistant",
    "the agent posted the full URL",
    "",
    "### turn 4 · user",
    "it used a  bare #2731",
    "  reference in the follow-up",
    "",
  ].join("\n");
  const clean = sanitizeEvidence(
    {
      positive: [{ instruction: "AG-001", quote: "the agent posted the full URL" }],
      negative: [{ instruction: "AG-004", quote: "it used a bare #2731 reference", class: "harm" }],
      gaps: [{ proposedInstruction: "Post full URLs.", quote: "posted the full URL" }],
    },
    null,
    trace,
  );

  assert.equal(clean.positive.length, 1);
  assert.equal(clean.positive[0].before, "### turn 3 · assistant\n");
  assert.equal(clean.positive[0].after, "\n\n### turn 4 · user\nit used a  bare #2731\n  reference in the follow-up\n");
  assert.equal(clean.positive[0].locator.turn, 3);
  assert.equal(clean.positive[0].locator.role, "assistant");
  assert.equal(typeof clean.positive[0].locator.foldedOffset, "number");
  assert.ok(!clean.positive[0].before.includes("the agent posted"));
  assert.ok(trace.includes(clean.positive[0].before + "the agent posted the full URL" + clean.positive[0].after));

  assert.equal(clean.negative[0].locator.turn, 4);
  assert.equal(clean.negative[0].locator.role, "user");
  assert.ok(clean.negative[0].before.includes("turn 4"));
  assert.ok(clean.negative[0].after.includes("in the follow-up"));
  assert.equal(clean.gaps[0].locator.turn, 3);

  const located = locateQuote(trace, "the agent posted the full URL");
  assert.deepEqual(located.locator, clean.positive[0].locator);
  assert.equal(located.before, clean.positive[0].before);
  assert.equal(located.after, clean.positive[0].after);
});

test("a quote that is not in the distilled trace is a paraphrase and is discarded", () => {
  const trace = "turn 3\n  the agent posted the full URL\n\nturn 4\n  it used a  bare #2731\n  reference\n";
  const clean = sanitizeEvidence(
    {
      positive: [
        { instruction: "AG-001", quote: "the agent posted the full URL" },
        { instruction: "AG-002", quote: "the agent shared the complete link" },
      ],
      negative: [{ instruction: "AG-004", quote: "it used a bare #2731 reference" }],
      gaps: [{ proposedInstruction: "Post full URLs.", quote: "posted the full URL" }],
    },
    null,
    trace,
  );
  assert.deepEqual(
    clean.positive.map((item) => item.instruction),
    ["AG-001"],
  );
  assert.equal(clean.negative.length, 1, "whitespace and line breaks fold before matching");
  assert.equal(clean.gaps.length, 1);
});

test("only a literal true opts out of the trace check, and rejections are counted", () => {
  const clean = sanitizeEvidence(
    {
      positive: [
        { instruction: "AG-001", quote: "text the distiller elided" },
        { instruction: "AG-002", quote: "another invented sentence" },
      ],
      usedRawTranscript: "false",
    },
    null,
    "nothing here matches",
  );
  assert.equal(clean.usedRawTranscript, false);
  assert.deepEqual(clean.positive, []);
  assert.equal(clean.quotesNotInTrace, 2);
});

test("the trace check is skipped when the model read the raw transcript", () => {
  const clean = sanitizeEvidence(
    { positive: [{ instruction: "AG-001", quote: "text the distiller elided" }], usedRawTranscript: true },
    null,
    "### turn 1 · user\nnothing here matches\n",
  );
  assert.equal(clean.positive.length, 1);
  assert.equal(clean.positive[0].locator, undefined);
  assert.equal(clean.positive[0].before, undefined);
  assert.equal(clean.positive[0].after, undefined);
});

test("sanitizeEvidence tolerates a malformed model response", () => {
  const clean = sanitizeEvidence(null);
  assert.deepEqual(clean, { positive: [], negative: [], gaps: [], usedRawTranscript: false, quotesNotInTrace: 0 });
  assert.deepEqual(sanitizeEvidence({ positive: "not an array" }).positive, []);
});

test("a gap's coveredBySkill citation survives sanitization; junk values record nothing", () => {
  const gap = (extra) => ({
    proposedInstruction: "Wrap migrations in a transaction.",
    quote: "dropped the column with no backfill plan",
    recurrenceRisk: "high",
    ...extra,
  });
  const clean = sanitizeEvidence({
    gaps: [gap({ coveredBySkill: "  db-schema  " }), gap({ coveredBySkill: "" }), gap({ coveredBySkill: 42 })],
  });
  assert.equal(clean.gaps.length, 3);
  assert.equal(clean.gaps[0].coveredBySkill, "db-schema");
  assert.ok(!("coveredBySkill" in clean.gaps[1]), "an empty citation is no citation");
  assert.ok(!("coveredBySkill" in clean.gaps[2]), "a non-string citation is dropped, not coerced");
});

test("a negative's class survives only as one of the judged values, and never invents harm", () => {
  const clean = sanitizeEvidence({
    negative: [
      { instruction: "AG-001", quote: "followed the stale pin and broke the build", class: "harm" },
      { instruction: "AG-002", quote: "skipped the failing-test-first step", class: "non-compliance" },
      { instruction: "AG-003", quote: "an unrelated grumble about tooling", class: "irrelevant" },
      { instruction: "AG-004", quote: "a record from before the field existed" },
      { instruction: "AG-005", quote: "a made-up value must not pass", class: "catastrophic" },
    ],
  });
  assert.deepEqual(
    clean.negative.map((item) => item.class),
    ["harm", "non-compliance", "irrelevant", undefined, undefined],
  );
});

test("a gap's domain defaults to project, and a citation is kept only when it looks like a ledger id", () => {
  const clean = sanitizeEvidence({
    gaps: [
      {
        proposedInstruction: "Bind the attestation to the exact head SHA.",
        quote: "published an attestation for the wrong commit",
        domain: "project",
        matchesGap: "d5ff4883e71499f5",
      },
      {
        proposedInstruction: "Stop after the report on scout tasks.",
        quote: "opened a PR during a scout task",
        domain: "orchestration",
        matchesGap: "not-a-ledger-id",
      },
      {
        proposedInstruction: "A legacy gap with neither field.",
        quote: "walked migrations for 18 turns",
        domain: "somewhere-else",
      },
    ],
  });
  assert.deepEqual(
    clean.gaps.map((gap) => [gap.domain, gap.matchesGap]),
    [
      ["project", "d5ff4883e71499f5"],
      ["orchestration", undefined],
      ["project", undefined],
    ],
  );
});
