import test from "node:test";
import assert from "node:assert/strict";

import { distill, isBoilerplate } from "../src/distill.js";
import { redact } from "../src/redact.js";
import { estimateTokens } from "../src/tokens.js";
import { sanitizeEvidence } from "../src/analyze.js";
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

function sourceTexts(...texts) {
  return distill(
    texts.map((text) => ({ kind: "message", role: "assistant", text })),
    META,
  ).sources;
}

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

test("standalone apikey credentials are redacted case-insensitively with a 16-character floor", () => {
  const lower = `apikey_${"a".repeat(64)}`;
  const upper = `APIKEY_${"B".repeat(64)}`;
  const mixed = "ApiKey_aB3_-aB3_-aB3_-x";
  const label = "[redacted:API_KEY]";
  for (const token of [lower, upper, mixed, `apikey_${"c".repeat(16)}`]) {
    assert.equal(redact(token), label);
    assert.equal(redact(`(${token}), next.`), `(${label}), next.`);
  }
  assert.equal(redact(`before\n${lower}\n${upper}\nafter`), `before\n${label}\n${label}\nafter`);
  for (const text of [
    "apikey",
    "apikey_documentation",
    `apikey_${"a".repeat(15)}`,
    `APIKEY_${"B".repeat(15)}`,
    `not${lower}`,
  ]) {
    assert.equal(redact(text), text);
  }
});

test("standalone apikey matching cannot expose secret assignment values", () => {
  for (const name of ["apikey_openrouter_production", "APIKEY_OPENROUTER_PRODUCTION"]) {
    for (const separator of ["=", ":"]) {
      for (const value of [
        "hunter2hunter2",
        '"hunter2hunter2,secret"',
        "'hunter2hunter2,secret'",
        '"hunter2\nhunter2"',
      ]) {
        const assignment = `${name} ${separator} ${value}`;
        assert.equal(redact(assignment), "[redacted:API_KEY]=[redacted]");
        const { trace } = distill(
          [
            { kind: "message", role: "user", text: assignment },
            { kind: "message", role: "assistant", text: assignment },
            { kind: "tool", name: "Bash", input: assignment, result: assignment },
            { kind: "tool", name: "Bash", input: { command: assignment }, result: assignment },
          ],
          META,
        );
        assert.ok(!trace.includes("hunter2"), "assignment values must not survive in any trace field");
        assert.equal(trace.match(/\[redacted:API_KEY\]=\[redacted\]/g)?.length, 6);
      }
    }
  }
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
  const clean = sanitizeEvidence(
    {
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
    },
    null,
    sourceTexts("the agent posted the full URL", "it used a bare #2731 reference", "walked migrations for 18 turns"),
  );

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
    sourceTexts(
      "followed the entire oversized paragraph",
      "followed the second sentence precisely",
      "cited an instruction that does not exist",
    ),
  );
  assert.deepEqual(
    clean.positive.map((item) => item.instruction),
    ["AG-001.2"],
  );
});

test("a quote that is not in the source events is a paraphrase and is discarded", () => {
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
    sourceTexts(trace),
  );
  assert.deepEqual(
    clean.positive.map((item) => item.instruction),
    ["AG-001"],
  );
  assert.equal(clean.negative.length, 1, "whitespace and line breaks fold before matching");
  assert.equal(clean.gaps.length, 1);
});

test("rejections are counted when raw access is not a literal boolean", () => {
  const clean = sanitizeEvidence(
    {
      positive: [
        { instruction: "AG-001", quote: "text the distiller elided" },
        { instruction: "AG-002", quote: "another invented sentence" },
      ],
      usedRawTranscript: "false",
    },
    null,
    sourceTexts("nothing here matches"),
  );
  assert.equal(clean.usedRawTranscript, false);
  assert.deepEqual(clean.positive, []);
  assert.equal(clean.quotesNotInTrace, 2);
});

test("claiming raw transcript access cannot replace source provenance", () => {
  const clean = sanitizeEvidence(
    { positive: [{ instruction: "AG-001", quote: "text the distiller elided" }], usedRawTranscript: true },
    null,
    sourceTexts("nothing here matches"),
  );
  assert.equal(clean.positive.length, 0);
});

test("distiller elisions cannot supply evidence, even with the raw-transcript escape hatch", () => {
  const distilled = distill([{ kind: "message", role: "user", text: "é🙂".repeat(3000) }], META);
  const marker = "[... 3000 chars elided ...]";
  assert.ok(distilled.trace.includes(marker));
  for (const usedRawTranscript of [false, true]) {
    const clean = sanitizeEvidence(
      {
        positive: [{ instruction: "AG-001", quote: marker }],
        negative: [{ instruction: "AG-001", quote: `é🙂 ${marker}`, class: "harm" }],
        gaps: [{ proposedInstruction: "Checkpoint long sessions.", quote: "chars elided" }],
        usedRawTranscript,
      },
      null,
      distilled.sources,
    );
    assert.deepEqual([clean.positive, clean.negative, clean.gaps], [[], [], []]);
    assert.equal(clean.quotesNotInTrace, 3);
  }
});

test("source provenance rejects elisions in both capped trace boundaries", () => {
  const marker = "[... 2000 chars elided ...]";
  const distilled = distill(
    [{ kind: "message", role: "user", text: "h".repeat(4800) + "x".repeat(2200) + "t".repeat(1000) }],
    META,
    { maxTraceTokens: 700 },
  );
  assert.equal(distilled.stats.elided, true);
  const middle = distilled.trace.match(/\[\.\.\. middle of session elided:[^\]]+\]/)[0];
  assert.ok(distilled.trace.includes(marker), "the message marker survives in the capped tail");
  const clean = sanitizeEvidence(
    {
      gaps: [marker, middle, `hhh ${middle}`, `${middle} ttt`, "hhhhhhhh", "tttttttt"].map((quote) => ({
        proposedInstruction: "Keep real evidence.",
        quote,
      })),
    },
    null,
    distilled.sources,
  );
  assert.deepEqual(
    clean.gaps.map((gap) => gap.quote),
    ["hhhhhhhh", "tttttttt"],
  );
  assert.equal(clean.quotesNotInTrace, 4);
});

test("marker-shaped session text and repeated real matches remain valid evidence", () => {
  const marker = "[... 2000 chars elided ...]";
  const distilled = distill(
    [
      { kind: "message", role: "user", text: "x".repeat(8000) },
      { kind: "message", role: "assistant", text: `The literal example was ${marker}.` },
    ],
    META,
  );
  const clean = sanitizeEvidence({ positive: [{ instruction: "AG-001", quote: marker }] }, null, distilled.sources);
  assert.equal(clean.positive.length, 1, "a later match from the session still counts");
  assert.equal(clean.quotesNotInTrace, 0);
});

test("source provenance identifies Unicode and tool-field spans without trusting model metadata", () => {
  const events = [
    { kind: "message", role: "user", text: "🙂 prefix\nReal  source\twords followed." },
    {
      kind: "tool",
      name: "Bash",
      input: { command: "printf inspect-database" },
      result: { lines: ["schema was missing"] },
    },
  ];
  const distilled = distill(events, META);
  const clean = sanitizeEvidence(
    {
      gaps: [
        {
          proposedInstruction: "Preserve genuine evidence.",
          quote: "Real source words",
          quoteProvenance: { kind: "generated" },
        },
        { proposedInstruction: "Inspect the database.", quote: "inspect-database" },
        { proposedInstruction: "Check schema availability.", quote: "schema was missing" },
        { proposedInstruction: "Check the structured result.", quote: '"lines":["schema was missing"]' },
        {
          proposedInstruction: "Reject fabricated evidence.",
          quote: "fabricated source words",
          quoteProvenance: { kind: "source" },
        },
      ],
    },
    null,
    distilled.sources,
  );
  assert.equal(clean.gaps.length, 4);
  for (const gap of clean.gaps) {
    const { kind, event, field, representation, start, end } = gap.quoteProvenance;
    assert.equal(kind, "source");
    const source = field.reduce((value, key) => value[key], events[event]);
    const text = representation === "json" ? JSON.stringify(source) : source;
    assert.equal(text.slice(start, end).replace(/\s+/g, " "), gap.quote);
  }
  assert.equal(clean.gaps[0].quoteProvenance.start, events[0].text.indexOf("Real"));
});

test("redacted evidence maps to genuine source offsets without retaining secrets", () => {
  const secret = "synthetic-" + "password-value";
  const token = "ghp_" + "a".repeat(32);
  const prefix = `🙂 ${token}\nPASSWORD=${secret}\n`;
  const quote = "The command printed PASSWORD=[redacted]";
  const text = `${prefix}The command printed PASSWORD=${secret}\nGenuine words after redactions.`;
  const events = [
    { kind: "message", role: "assistant", text },
    { kind: "tool", input: { command: text } },
    { kind: "tool", result: { output: text } },
  ];
  for (const event of events) {
    const distilled = distill([event], META);
    const clean = sanitizeEvidence(
      {
        positive: [{ instruction: "AG-001", quote }],
        negative: [{ instruction: "AG-001", quote, class: "harm" }],
        gaps: [
          { proposedInstruction: "Protect credentials.", quote },
          { proposedInstruction: "Keep trailing evidence.", quote: "Genuine words after redactions." },
          { proposedInstruction: "Reject generated evidence.", quote: "[... 2000 chars elided ...]" },
          { proposedInstruction: "Reject boundary overlap.", quote: `${quote} [... 2000 chars elided ...]` },
        ],
      },
      null,
      distilled.sources,
    );
    assert.deepEqual([clean.positive.length, clean.negative.length, clean.gaps.length], [1, 1, 2]);
    for (const item of [...clean.positive, ...clean.negative, ...clean.gaps]) {
      const { field, representation, start, end } = item.quoteProvenance;
      const source = field.reduce((value, key) => value[key], event);
      const original = representation === "json" ? JSON.stringify(source) : source;
      assert.equal(redact(original.slice(start, end)), item.quote);
      if (item.quote === quote) assert.equal(start, original.indexOf("The command"));
    }
    assert.equal(clean.quotesNotInTrace, 2);
    for (const record of [distilled, clean]) {
      assert.ok(!JSON.stringify(record).includes(secret), "returned records exclude the synthetic password");
      assert.ok(!JSON.stringify(record).includes(token), "returned records exclude the synthetic token");
    }
  }
  const jsonEvent = { kind: "tool", result: { token } };
  const jsonQuote = '"token":"[redacted:GITHUB_TOKEN]"';
  const jsonDistilled = distill([jsonEvent], META);
  const jsonClean = sanitizeEvidence(
    { gaps: [{ proposedInstruction: "Protect structured output.", quote: jsonQuote }] },
    null,
    jsonDistilled.sources,
  );
  assert.equal(jsonClean.gaps.length, 1);
  const { representation, start, end } = jsonClean.gaps[0].quoteProvenance;
  assert.equal(representation, "json");
  assert.equal(redact(JSON.stringify(jsonEvent.result).slice(start, end)), jsonQuote);
  assert.ok(!JSON.stringify(jsonDistilled).includes(token), "serialized source provenance excludes the token");
});

test("rendered tool quotes map flattened and escaped text to genuine source offsets", () => {
  const secret = "synthetic-" + "tool-password";
  const command = `  echo "before"\necho PASSWORD=${secret}\t🙂  `;
  const inputs = [
    command,
    ...["command", "cmd", "file_path", "path", "pattern", "query", "url", "description"].map((key) => ({
      [key]: command,
    })),
    { other: command },
  ];
  for (const input of inputs) {
    const event = { kind: "tool", name: "Bash", input };
    const distilled = distill([event], META);
    const quote = distilled.trace.split("tool: Bash ")[1].split("\n")[0].slice(1, -1);
    const clean = sanitizeEvidence(
      {
        positive: [{ instruction: "AG-001", quote }],
        negative: [{ instruction: "AG-001", quote, class: "harm" }],
        gaps: [{ proposedInstruction: "Keep rendered command evidence.", quote }],
        usedRawTranscript: true,
      },
      null,
      distilled.sources,
    );
    assert.deepEqual([clean.positive.length, clean.negative.length, clean.gaps.length], [1, 1, 1]);
    for (const item of [...clean.positive, ...clean.negative, ...clean.gaps]) {
      const { event: index, field, representation, start, end } = item.quoteProvenance;
      assert.equal(index, 0);
      const original = field.reduce((value, key) => value[key], event);
      const source = representation === "json" ? JSON.stringify(original) : original;
      assert.equal(JSON.stringify(redact(source.slice(start, end).replace(/\s+/g, " "))).slice(1, -1), quote);
    }
    assert.ok(!JSON.stringify([distilled, clean]).includes(secret));
  }
  for (const result of [command, { other: command }]) {
    const event = { kind: "tool", name: "Bash", result };
    const distilled = distill([event], META);
    const quote = distilled.trace.split(" -> ")[1].split("\n")[0];
    const clean = sanitizeEvidence(
      { gaps: [{ proposedInstruction: "Keep rendered output evidence.", quote }] },
      null,
      distilled.sources,
    );
    assert.equal(clean.gaps.length, 1);
    const { field, representation, start, end } = clean.gaps[0].quoteProvenance;
    const original = field.reduce((value, key) => value[key], event);
    const source = representation === "json" ? JSON.stringify(original) : original;
    assert.equal(redact(source.slice(start, end).replace(/\s+/g, " ")), quote);
    assert.ok(!JSON.stringify([distilled, clean]).includes(secret));
  }
});

test("rendered tool provenance excludes generated truncation and overlapping quotes", () => {
  for (const field of ["input", "result"]) {
    const event = { kind: "tool", name: "Bash", [field]: `echo "before"\n${"x".repeat(300)}` };
    const distilled = distill([event], META);
    const quote =
      field === "input"
        ? distilled.trace.split("tool: Bash ")[1].split("\n")[0].slice(1, -1)
        : distilled.trace.split(" -> ")[1].split("\n")[0];
    const prefix = quote.split("...")[0];
    const clean = sanitizeEvidence(
      {
        gaps: [
          { proposedInstruction: "Keep genuine prefixes.", quote: prefix },
          { proposedInstruction: "Reject truncation.", quote },
          { proposedInstruction: "Reject overlaps.", quote: quote.slice(prefix.length - 8) },
          { proposedInstruction: "Reject elisions.", quote: "[... 2000 chars elided ...]" },
        ],
        usedRawTranscript: true,
      },
      null,
      distilled.sources,
    );
    assert.deepEqual(
      clean.gaps.map((gap) => gap.quote),
      [prefix],
    );
    assert.equal(clean.quotesNotInTrace, 3);
  }
});

test("raw-access evidence is redacted before quotes and descriptions are persisted", () => {
  const secret = "synthetic-" + "raw-password";
  const assignment = `PASSWORD=${secret}`;
  const clean = sanitizeEvidence(
    {
      usedRawTranscript: true,
      positive: [{ instruction: "AG-001", quote: assignment, moment: assignment, effect: assignment }],
      negative: [{ instruction: "AG-001", quote: assignment, moment: assignment, effect: assignment, class: "harm" }],
      gaps: [{ proposedInstruction: assignment, quote: assignment, mistake: assignment, coveredBySkill: assignment }],
    },
    null,
    sourceTexts(assignment),
  );
  assert.deepEqual([clean.positive.length, clean.negative.length, clean.gaps.length], [1, 1, 1]);
  assert.ok(!JSON.stringify(clean).includes(secret), "evidence descriptions and provenance exclude the secret");
  assert.equal(clean.gaps[0].quote, "PASSWORD=[redacted]");
});

test("source validation rejects generated quotes in short sessions", () => {
  const distilled = distill([{ kind: "message", role: "user", text: "Actual source text is enough." }], META);
  assert.equal(distilled.stats.elided, false);
  const clean = sanitizeEvidence(
    {
      gaps: [
        { proposedInstruction: "Keep actual evidence.", quote: "Actual source text" },
        { proposedInstruction: "Reject old elisions.", quote: "[... 2000 chars elided ...]" },
      ],
      usedRawTranscript: true,
    },
    null,
    distilled.sources,
  );
  assert.deepEqual(
    clean.gaps.map((gap) => gap.quote),
    ["Actual source text"],
  );
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
  const clean = sanitizeEvidence(
    {
      gaps: [gap({ coveredBySkill: "  db-schema  " }), gap({ coveredBySkill: "" }), gap({ coveredBySkill: 42 })],
    },
    null,
    sourceTexts("dropped the column with no backfill plan"),
  );
  assert.equal(clean.gaps.length, 3);
  assert.equal(clean.gaps[0].coveredBySkill, "db-schema");
  assert.ok(!("coveredBySkill" in clean.gaps[1]), "an empty citation is no citation");
  assert.ok(!("coveredBySkill" in clean.gaps[2]), "a non-string citation is dropped, not coerced");
});

test("a negative's class survives only as one of the judged values, and never invents harm", () => {
  const clean = sanitizeEvidence(
    {
      negative: [
        { instruction: "AG-001", quote: "followed the stale pin and broke the build", class: "harm" },
        { instruction: "AG-002", quote: "skipped the failing-test-first step", class: "non-compliance" },
        { instruction: "AG-003", quote: "an unrelated grumble about tooling", class: "irrelevant" },
        { instruction: "AG-004", quote: "a record from before the field existed" },
        { instruction: "AG-005", quote: "a made-up value must not pass", class: "catastrophic" },
      ],
    },
    null,
    sourceTexts(
      "followed the stale pin and broke the build",
      "skipped the failing-test-first step",
      "an unrelated grumble about tooling",
      "a record from before the field existed",
      "a made-up value must not pass",
    ),
  );
  assert.deepEqual(
    clean.negative.map((item) => item.class),
    ["harm", "non-compliance", "irrelevant", undefined, undefined],
  );
});

test("a gap's domain defaults to project, and a citation is kept only when it looks like a ledger id", () => {
  const clean = sanitizeEvidence(
    {
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
    },
    null,
    sourceTexts(
      "published an attestation for the wrong commit",
      "opened a PR during a scout task",
      "walked migrations for 18 turns",
    ),
  );
  assert.deepEqual(
    clean.gaps.map((gap) => [gap.domain, gap.matchesGap]),
    [
      ["project", "d5ff4883e71499f5"],
      ["orchestration", undefined],
      ["project", undefined],
    ],
  );
});
