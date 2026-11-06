import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A new closure contract for #112: top-level exchanges own invocation outcomes.
// The method and id of a setup exchange are deliberately varied. A parser must
// preserve its error without recognizing an enumerated set of setup operations.
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-exchange-closure-"));
const scenarioFile = path.join(fixtures, "scenario.json");
const callsFile = path.join(fixtures, "calls.jsonl");
const fakeAcpx = path.join(fixtures, "acpx");
fs.writeFileSync(
  fakeAcpx,
  `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("config")) { process.stdout.write('{"agents":{}}'); process.exit(0); }
if (!args.includes("--file")) process.exit(0);
const prior = fs.readFileSync(${JSON.stringify(callsFile)}, "utf8").trim();
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + "\\n");
const scenario = JSON.parse(fs.readFileSync(${JSON.stringify(scenarioFile)}, "utf8"));
const reply = prior && scenario.fallback ? scenario.fallback : scenario;
const json = args[args.indexOf("--format") + 1] === "json";
const records = reply.records.map(record => reply.echoPrompt && record.method === "session/prompt"
  ? { ...record, params: { ...record.params, prompt: [{ type: "text", text: fs.readFileSync(args[args.indexOf("--file") + 1], "utf8") }] } }
  : record);
fs.writeSync(1, json ? records.map(record => JSON.stringify(record)).join("\\n") + "\\n" : reply.text);
if (reply.stderr) fs.writeSync(2, reply.stderr);
process.exit(reply.code);
`,
  { mode: 0o755 },
);
process.env.BACKPASS_ACPX_BIN = fakeAcpx;
const { execOneShot, sessionPrompt, runModelCall, AcpxError, classifyAcpxFailure } = await import("../src/acpx.js");
const { analyzeTranscripts } = await import("../src/analyze.js");
const { AgentResolver } = await import("../src/agents.js");
const { State } = await import("../src/state.js");
const { parseMemoryUnits } = await import("../src/memory.js");
const { setLoggerSink } = await import("../src/logger.js");

const answer = {
  positive: [{ instruction: "AG-001", moment: "start", effect: "built it", quote: "Ran make build as instructed." }],
  negative: [],
  gaps: [],
  usedRawTranscript: false,
  deniedRequests: 999,
};
const rpc = (record) => ({ jsonrpc: "2.0", ...record });
const request = (id, method, params = {}) => rpc({ id, method, params });
const response = (id, result) => rpc({ id, result });
const failure = (id, message) => rpc({ id, error: { code: -32603, message } });
/** @param {string | number} [id] */
const begin = (id = 2) => request(id, "session/prompt", { sessionId: "s" });
const chunk = (text) =>
  rpc({
    method: "session/update",
    params: {
      sessionId: "s",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });
/** @param {string | number} [id] */
const end = (id = 2, stopReason = "end_turn") =>
  response(id, { stopReason, usage: { inputTokens: 11, outputTokens: 29 } });
const permission = (id) => [
  request(id, "session/request_permission", { sessionId: "s", options: [{ optionId: "no", kind: "reject_once" }] }),
  response(id, { outcome: { outcome: "selected", optionId: "no" } }),
];
const completed = (text = JSON.stringify(answer)) => [begin(), chunk(text), end()];

function prepare(records, code = 5, extra = {}) {
  fs.writeFileSync(callsFile, "");
  fs.writeFileSync(scenarioFile, JSON.stringify({ records, code, text: JSON.stringify(answer), ...extra }));
}

function resolver(root, effort = "medium") {
  return new AgentResolver(
    {
      analysis: { agent: null, model: null, effort },
      ladders: {
        analysis: [
          { model: "primary", agents: ["codex"] },
          { model: "fallback", agents: ["codex"] },
        ],
      },
    },
    {
      cwd: root,
      acpxVersion: async () => "fixture",
      providerAuthState: () => "fixture",
      probeCandidate: async (candidate) => ({ verdict: "ok", detail: "fixture", resolvedModel: candidate.model }),
    },
  );
}

async function analyze(records, code = 5) {
  prepare(records, code);
  const root = fs.mkdtempSync(path.join(fixtures, "repo-"));
  const file = path.join(root, "past.jsonl");
  fs.writeFileSync(
    file,
    [
      { type: "session", version: 3, id: "past", cwd: root, timestamp: new Date().toISOString() },
      { type: "message", message: { role: "user", content: "Please build it." } },
      { type: "message", message: { role: "assistant", content: "Ran make build as instructed." } },
      { type: "message", message: { role: "user", content: "Run the tests too." } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );
  const transcript = {
    harness: "pi",
    id: "past",
    nativeId: "past",
    path: file,
    mtimeMs: fs.statSync(file).mtimeMs,
    bytes: fs.statSync(file).size,
  };
  const state = new State(root).ensure();
  const logs = [];
  setLoggerSink((line) => logs.push(line));
  try {
    const summary = await analyzeTranscripts({
      transcripts: [transcript],
      memoryFile: { path: "AGENTS.md", units: parseMemoryUnits("- Run make build.\n") },
      repo: { root },
      memoryHash: "closure",
      config: {
        state,
        agents: resolver(root),
        jobs: 1,
        discovery: { minUserTurns: 2 },
        timeoutSeconds: 5,
        promptRetries: 1,
      },
    });
    const calls = fs
      .readFileSync(callsFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(calls.every((args) => args.includes("-s") && !args.includes("--approve-all")));
    return { summary, evidence: state.readEvidence(transcript), logs: logs.join("\n") };
  } finally {
    setLoggerSink(null);
  }
}

test("completed analysis survives exit 5 and persists only observed denial counts", async () => {
  const records = [
    request("setup", "extension/opaque"),
    response("setup", {}),
    begin(),
    request(2, "arbitrary/tool", { sessionId: "s" }),
    failure(2, "Authentication required"),
    ...permission("2"),
    ...permission(2),
    chunk(JSON.stringify(answer)),
    end(),
  ];
  const { summary, evidence, logs } = await analyze(records);
  assert.equal(summary.analyzed, 1);
  assert.equal(evidence.status, "ok");
  assert.equal(evidence.positive[0].quote, answer.positive[0].quote);
  assert.equal(evidence.deniedRequests, 2);
  assert.match(logs, /PERMISSION_DENIED.*deniedRequests=2/);
  assert.deepEqual(summary.usage[0].usage, { input: 11, output: 29 });
});

test("exit 5 without a count-bearing permission record reports the count as unknown", async () => {
  const { summary, evidence, logs } = await analyze(completed());
  assert.equal(summary.analyzed, 1);
  assert.equal(evidence.deniedRequests, null);
  assert.match(logs, /PERMISSION_DENIED/);
  assert.match(logs, /unknown|not reported/i);
});

test("concurrent nested exchanges may finish in either order without owning the root outcome", async () => {
  const { summary, evidence } = await analyze([
    begin(),
    request(2, "extension/tool-a", { sessionId: "s" }),
    request("2", "extension/tool-b", { sessionId: "s" }),
    failure(2, "Authentication required"),
    response("2", {}),
    ...permission("denied"),
    chunk(JSON.stringify(answer)),
    end(),
  ]);
  assert.equal(summary.analyzed, 1);
  assert.equal(evidence.deniedRequests, 1);
});

test("the final completed attempt owns text, completion, and usage after retries", async () => {
  const { summary, evidence } = await analyze(
    [
      begin("old"),
      chunk('{"wrong":'),
      failure("old", "Authentication required"),
      request(99, "extension/other"),
      failure(99, "Authentication required"),
      ...completed(),
    ],
    0,
  );
  assert.equal(summary.analyzed, 1);
  assert.equal(evidence.positive.length, 1);
  assert.equal(evidence.deniedRequests, undefined);
});

/** @type {[string, object[], number][]} */
const rejected = [
  ["empty", completed(""), 5],
  ["malformed", completed("{"), 5],
  ["wrong schema", completed('{"positive":{}}'), 5],
  ["invalid item", completed(JSON.stringify({ ...answer, positive: [{ quote: "real quote" }] })), 5],
  ["incomplete", [begin(), chunk(JSON.stringify(answer))], 5],
  ["cancelled", [begin(), chunk(JSON.stringify(answer)), end(2, "cancelled")], 5],
  ["last attempt incomplete", [...completed(), begin("next"), chunk(JSON.stringify(answer))], 5],
  ["other exit", completed(), 1],
  ["timeout", completed(), 3],
];
for (const [name, records, code] of rejected) {
  test(`${name} is never recovered as successful analysis`, async () => {
    const { summary, evidence } = await analyze(records, code);
    assert.equal(summary.analyzed, 0);
    assert.equal(summary.failed, 1);
    assert.equal(evidence.status, "failed");
  });
}

for (const route of ["exec", "session"]) {
  for (const code of [0, 5]) {
    for (const source of ["unreported", "stderr", "result"]) {
      test(`${route}: echoed RPC prompt cannot supply usage (${source}, exit ${code})`, async () => {
        const promptFile = path.join(fixtures, "prompt.md");
        const historical = "[acpx] tokens: input=100 output=20 total=120 done";
        fs.writeFileSync(promptFile, `Analyze this historical transcript:\n${historical}\n`);
        const records = [
          begin(),
          chunk(JSON.stringify(answer)),
          source === "result" ? end() : response(2, { stopReason: "end_turn" }),
        ];
        prepare(records, code, {
          echoPrompt: true,
          stderr: source === "unreported" ? "" : "[acpx] tokens: input=7 output=3 total=10 done\n",
        });
        const call = { agent: "codex", promptFile, cwd: fixtures, timeoutSeconds: 5, acceptDeniedOutput: () => true };
        const result = await (route === "exec"
          ? execOneShot(call)
          : sessionPrompt({ ...call, sessionName: "closure" }));
        const echoed = result.raw
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        assert.equal(echoed[0].params.prompt[0].text, fs.readFileSync(promptFile, "utf8"));
        assert.deepEqual(
          result.usage,
          source === "result"
            ? { input: 11, output: 29 }
            : source === "stderr"
              ? { input: 7, output: 3, total: 10 }
              : null,
        );
        assert.deepEqual(JSON.parse(result.text), answer);
        assert.equal(result.permissionDenied, code === 5);
      });
    }
  }
  test(`${route}: quiet output retains stdout token accounting`, async () => {
    const promptFile = path.join(fixtures, "prompt.md");
    fs.writeFileSync(promptFile, "Synthetic only.\n");
    prepare([], 0, { text: `${JSON.stringify(answer)}\n[acpx] tokens: input=7 output=3 total=10 done\n` });
    const call = { agent: "codex", promptFile, cwd: fixtures, timeoutSeconds: 5 };
    const result = await (route === "exec" ? execOneShot(call) : sessionPrompt({ ...call, sessionName: "closure" }));
    assert.deepEqual(result.usage, { input: 7, output: 3, total: 10 });
    assert.deepEqual(JSON.parse(result.text), answer);
  });
  test(`${route}: a swallowed zero-exit error retains diagnostics for real fallback`, async () => {
    prepare([failure(null, "Authentication required")], 0, {
      fallback: { records: completed(), code: 0, text: JSON.stringify(answer) },
    });
    const promptFile = path.join(fixtures, "prompt.md");
    fs.writeFileSync(promptFile, "Synthetic only.\n");
    const agents = resolver(fixtures);
    const attempted = [];
    const result = await agents.withFallthrough("analysis", async (pick) => {
      attempted.push(pick.model);
      return runModelCall(
        {
          agent: pick.agent,
          model: pick.model,
          promptFile,
          cwd: fixtures,
          timeoutSeconds: 5,
          acceptDeniedOutput: () => true,
        },
        { ...pick, effort: route === "session" ? "medium" : null },
        { sessionName: () => "closure" },
      );
    });
    assert.deepEqual(attempted, ["primary", "fallback"]);
    assert.equal(JSON.parse(result.text).positive.length, 1);
  });
  for (const method of ["session/new", "extension/not-a-known-setup-step"]) {
    for (const id of [2, "setup-id"]) {
      test(`${route}: root ${method} error id=${JSON.stringify(id)} preserves real resolver fallback`, async () => {
        prepare([request(id, method), failure(id, "Authentication required")], 1, {
          fallback: { records: completed(), code: 0, text: JSON.stringify(answer) },
        });
        const promptFile = path.join(fixtures, "prompt.md");
        fs.writeFileSync(promptFile, "Synthetic only.\n");
        const agents = resolver(fixtures);
        const attempted = [];
        const result = await agents.withFallthrough("analysis", async (pick) => {
          attempted.push(pick.model);
          const call = {
            agent: pick.agent,
            model: pick.model,
            promptFile,
            cwd: fixtures,
            timeoutSeconds: 5,
            acceptDeniedOutput: () => true,
          };
          return route === "exec"
            ? execOneShot(call)
            : sessionPrompt({ ...call, effort: "medium", sessionName: "closure" });
        });
        assert.deepEqual(attempted, ["primary", "fallback"]);
        assert.equal(JSON.parse(result.text).positive.length, 1);
      });
    }
  }
  for (const message of ["The ACP agent did not advertise that model", "failed to spawn ENOENT"]) {
    test(`${route}: terminal JSON error preserves its diagnostic: ${message}`, async () => {
      prepare([failure(null, message)], 1);
      const promptFile = path.join(fixtures, "prompt.md");
      fs.writeFileSync(promptFile, "Synthetic only.\n");
      const call = { agent: "codex", promptFile, cwd: fixtures, timeoutSeconds: 5, acceptDeniedOutput: () => true };
      await assert.rejects(
        route === "exec" ? execOneShot(call) : sessionPrompt({ ...call, sessionName: "closure" }),
        (error) => {
          assert.ok(error instanceof AcpxError);
          assert.ok(classifyAcpxFailure(error));
          assert.ok(error.message.includes(message));
          return true;
        },
      );
    });
  }
}
