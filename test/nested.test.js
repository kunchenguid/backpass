import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { nestedCorpora } from "../src/commands/analyze.js";
import { foldEvidence, renderEvidenceForPrompt } from "../src/fold.js";
import { setLoggerSink } from "../src/logger.js";
import { buildProposal } from "../src/proposal.js";
import { applyDecisions } from "../src/apply/writer.js";
import { State } from "../src/state.js";
import { transcriptIdentity } from "../src/transcript.js";
import {
  applyNestedMemoryConfig,
  attributeTranscripts,
  checkoutRoots,
  mergeNestedProposals,
  nestedContext,
  owningFile,
  reportNestedMemoryFiles,
  resolveNestedMemoryFiles,
  routingFor,
  workedPaths,
} from "../src/nested.js";
import { makeRepo, stageAndMeasure, writeIn } from "./helpers/staging.js";

/**
 * Nested memory files, stage by stage: the opt-in config, where a session worked, which
 * file owns a lesson, how the fold and the proposal gate route by it, and the per-file
 * budget the writer enforces. `test/nested-cli.test.js` drives the same contract through
 * the real CLI.
 */

// Keep a developer's own global config out of `loadConfig`.
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-nested-xdg-"));

const API = { path: "apps/api/AGENTS.md", dir: "apps/api" };
const DB = { path: "apps/api/db/AGENTS.md", dir: "apps/api/db" };
const WEB = { path: "apps/web/AGENTS.md", dir: "apps/web" };

const ATTRIBUTION = new Map([
  ["api-1", ["apps/api/src/orders.ts"]],
  ["api-2", ["apps/api/routes/index.ts"]],
  ["db-1", ["apps/api/db/schema.sql"]],
  ["db-2", ["apps/api/db/migrate.ts"]],
  ["web-1", ["apps/web/checkout.tsx"]],
  ["web-2", ["apps/web"]],
  ["both", ["apps/api/src/orders.ts", "apps/web/checkout.tsx"]],
  ["root-and-api", ["", "apps/api/src/orders.ts"]],
  ["root", [""]],
  ["remote", null],
]);

function captureWarnings(fn) {
  const lines = [];
  setLoggerSink((line) => lines.push(line));
  try {
    return { result: fn(), lines };
  } catch (err) {
    return { error: err, lines };
  } finally {
    setLoggerSink(null);
  }
}

// ---------- configuration: nested files are named, never discovered ----------

test("unset, nestedMemoryFiles changes nothing: the root list and the resolved weights are what they were", () => {
  const repo = makeRepo({ "AGENTS.md": "# root\n", "apps/api/AGENTS.md": "# api\n" });
  const config = loadConfig(repo.root);
  assert.deepEqual(config.nestedMemoryFiles, []);
  assert.equal(config.nestedBudgetTokens, null);
  const memoryFiles = [...config.memoryFiles];
  assert.equal(applyNestedMemoryConfig(repo.root, config), config);
  assert.deepEqual(config.memoryFiles, memoryFiles);
  assert.deepEqual(resolveNestedMemoryFiles(repo.root, config), [], "an existing nested file is never picked up");
});

test("nestedMemoryFiles is validated as a list of paths, and only for project scope", () => {
  const repo = makeRepo({ "AGENTS.md": "# root\n" });
  assert.throws(() => loadConfig(repo.root, { nestedMemoryFiles: "apps/api/AGENTS.md" }), /must be an array/);
  assert.throws(() => loadConfig(repo.root, { nestedMemoryFiles: [""] }), /must be an array/);
  assert.throws(() => loadConfig(repo.root, { nestedBudgetTokens: 0 }), /nestedBudgetTokens must be a positive number/);
  assert.throws(
    () => loadConfig(null, { nestedMemoryFiles: ["apps/api/AGENTS.md"] }, { kind: "user" }),
    /project-scope only/,
  );
});

test("each nested entry is one repo-relative file in a subdirectory, and leaves the root list", () => {
  const repo = makeRepo({ "AGENTS.md": "# root\n", "apps/api/AGENTS.md": "# api\n" });
  const config = (nestedMemoryFiles, memoryFiles = ["AGENTS.md", "CLAUDE.md"]) => ({ memoryFiles, nestedMemoryFiles });

  const named = applyNestedMemoryConfig(
    repo.root,
    config(["./apps/api/AGENTS.md"], ["AGENTS.md", "apps/api/AGENTS.md", "CLAUDE.md"]),
  );
  assert.deepEqual(named.nestedMemoryFiles, ["apps/api/AGENTS.md"]);
  assert.deepEqual(named.memoryFiles, ["AGENTS.md", "CLAUDE.md"], "a nested weight is never a separate root file");

  assert.throws(() => applyNestedMemoryConfig(repo.root, config(["AGENTS.md"])), /at the repository root/);
  assert.throws(
    () => applyNestedMemoryConfig(repo.root, config(["apps/api/AGENTS.md", "apps/api/CLAUDE.md"])),
    /two memory files in apps\/api\//,
  );
  assert.throws(() => applyNestedMemoryConfig(repo.root, config(["../elsewhere/AGENTS.md"])), /outside/);
  assert.throws(
    () => applyNestedMemoryConfig(repo.root, config(["apps/api/AGENTS.md"], ["apps/api/AGENTS.md"])),
    /every memoryFiles entry is also listed in nestedMemoryFiles/,
  );
});

test("a nested directory keeps the root pair's pointer model: a pointer is refused, a missing file is named", () => {
  const repo = makeRepo({
    "AGENTS.md": "# root\n",
    "apps/api/AGENTS.md": "# api\n\n- Handlers live in src/routes.\n",
    "apps/api/CLAUDE.md": "# api for claude\n\n- Something else entirely.\n",
    "apps/web/AGENTS.md": "# web\n",
    "apps/web/CLAUDE.md": "@AGENTS.md\n",
  });
  const config = {
    memoryFiles: ["AGENTS.md", "CLAUDE.md"],
    nestedMemoryFiles: ["apps/api/AGENTS.md", "apps/docs/AGENTS.md"],
  };
  const { result, lines } = captureWarnings(() => reportNestedMemoryFiles(resolveNestedMemoryFiles(repo.root, config)));
  assert.deepEqual(
    result.map((weight) => weight.path),
    ["apps/api/AGENTS.md"],
  );
  assert.ok(
    lines.some((line) =>
      /apps\/api\/CLAUDE\.md is a separate memory file.*only apps\/api\/AGENTS\.md is optimized/.test(line),
    ),
    lines.join("\n"),
  );
  assert.ok(lines.some((line) => /nested memory file apps\/docs\/AGENTS\.md does not exist/.test(line)));
  const singleRoot = captureWarnings(() =>
    reportNestedMemoryFiles(
      resolveNestedMemoryFiles(repo.root, { memoryFiles: ["AGENTS.md"], nestedMemoryFiles: ["apps/api/AGENTS.md"] }),
    ),
  );
  assert.ok(singleRoot.lines.some((line) => /apps\/api\/CLAUDE\.md is a separate memory file/.test(line)));

  const pointer = captureWarnings(() =>
    reportNestedMemoryFiles(
      resolveNestedMemoryFiles(repo.root, { memoryFiles: ["AGENTS.md"], nestedMemoryFiles: ["apps/web/CLAUDE.md"] }),
    ),
  );
  assert.match(pointer.error?.message ?? "", /apps\/web\/CLAUDE\.md is only a pointer to apps\/web\/AGENTS\.md/);
});

// ---------- where a session worked ----------

test("a session worked where its cwd and its tool calls' path fields point, never where its shell text mentions", () => {
  const repo = makeRepo({ "apps/api/src/orders.ts": "", "apps/web/checkout.tsx": "" });
  const roots = checkoutRoots(repo);
  const events = [
    { kind: "tool", name: "Read", input: { file_path: path.join(repo.root, "apps/api/src/orders.ts") } },
    { kind: "tool", name: "read", input: { path: "apps/web/checkout.tsx" } },
    {
      kind: "tool",
      name: "exec_command",
      input: { cmd: "cat apps/docs/README.md", workdir: path.join(repo.root, "packages/ui") },
    },
    {
      kind: "tool",
      name: "apply_patch",
      input: `*** Begin Patch\n*** Update File: ${path.join(repo.root, "apps/api/src/new.ts")}\n@@\n-a\n+b\n*** Add File: libs/core/index.ts\n+x\n*** End Patch`,
    },
    { kind: "tool", name: "Bash", input: { command: "cd apps/mobile && npm test" } },
    { kind: "tool", name: "Read", input: { file_path: "/etc/hosts" } },
    { kind: "message", role: "user", text: "look at apps/admin too" },
  ];
  assert.deepEqual(workedPaths({ cwd: repo.root }, events, roots), [
    "",
    "apps/api/src/new.ts",
    "apps/api/src/orders.ts",
    "apps/web/checkout.tsx",
    "libs/core/index.ts",
    "packages/ui",
  ]);
  assert.deepEqual(workedPaths({ cwd: path.join(repo.root, "apps/api") }, [], roots), ["apps/api"]);
});

test("attribution reads a local session once, and never places a session that ran on another machine", async () => {
  const repo = makeRepo({ "AGENTS.md": "# root\n" });
  const state = new State(repo.root).ensure();
  const sessionPath = path.join(repo.root, "..", `${path.basename(repo.root)}-pi-session.jsonl`);
  const entries = [
    { type: "session", version: 3, id: "s1", timestamp: new Date().toISOString(), cwd: repo.root },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "apps/api/src/orders.ts" } }],
      },
    },
  ];
  fs.writeFileSync(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const local = { harness: "pi", id: "pi-s1", nativeId: "s1", path: sessionPath, cwd: repo.root, mtimeMs: 1, bytes: 2 };
  const remote = { ...local, id: "pi-s2", nativeId: "s2", host: "mac-home" };
  const unreadable = { ...local, id: "pi-s3", nativeId: "s3", path: `${sessionPath}.missing` };

  const first = await attributeTranscripts([local, remote, unreadable], repo, state);
  assert.deepEqual(first.get(transcriptIdentity(local)), ["", "apps/api/src/orders.ts"]);
  assert.equal(first.get(transcriptIdentity(remote)), null, "a session from another machine is never placed");
  assert.deepEqual(first.get(transcriptIdentity(unreadable)), [""], "no readable tool call: the cwd alone places it");

  // Same content signature: the cached placement stands without reading the file again.
  fs.rmSync(sessionPath);
  const second = await attributeTranscripts([local], repo, state);
  assert.deepEqual(second.get(transcriptIdentity(local)), ["", "apps/api/src/orders.ts"]);
});

test("attribution cache changes when a sibling checkout becomes known", async () => {
  const repo = makeRepo({ "AGENTS.md": "# root\n" });
  const state = new State(repo.root).ensure();
  const sibling = path.join(repo.root, "sibling");
  fs.mkdirSync(sibling);
  const sessionPath = path.join(repo.root, "session.jsonl");
  fs.writeFileSync(sessionPath, [
    { type: "session", version: 3, id: "roots", timestamp: new Date().toISOString(), cwd: sibling },
    { type: "message", message: { role: "assistant", content: [
      { type: "toolCall", id: "t1", name: "edit", arguments: { path: "apps/api/handler.ts" } },
    ] } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const transcript = { harness: "pi", id: "pi-roots", nativeId: "roots", path: sessionPath, cwd: sibling, mtimeMs: 1, bytes: 2 };
  const first = await attributeTranscripts([transcript], repo, state);
  assert.deepEqual(first.get(transcriptIdentity(transcript)), ["sibling", "sibling/apps/api/handler.ts"]);
  const second = await attributeTranscripts([transcript], { ...repo, siblingWorktrees: [sibling] }, state);
  assert.deepEqual(second.get(transcriptIdentity(transcript)), ["", "apps/api/handler.ts"]);
});

// ---------- which file owns a lesson ----------

test("a lesson belongs to the most specific named file every session behind it worked under, else to the root", () => {
  const owner = (ids) => owningFile(ids, [API, DB, WEB], ATTRIBUTION);
  assert.equal(owner(["api-1", "api-2"]), API.path);
  assert.equal(owner(["db-1", "db-2"]), DB.path, "the deepest file in the chain owns it");
  assert.equal(owner(["db-1", "api-1"]), API.path, "sessions spread over apps/api fall back to apps/api");
  assert.equal(owner(["api-1", "web-1"]), null, "two unrelated directories are cross-cutting");
  assert.equal(owner(["both"]), null, "one session in two unrelated directories is cross-cutting too");
  assert.equal(owningFile(["both"], [API], ATTRIBUTION), null);
  assert.equal(owningFile(["root-and-api"], [API], ATTRIBUTION), null);
  assert.equal(owner(["api-1", "remote"]), null, "a session nobody could place keeps the lesson at the root");
  assert.equal(owner(["root"]), null);
  assert.equal(owner([]), null);
});

function evidenceRecord(identity, gap, extra = {}) {
  return {
    status: "ok",
    transcript: { harness: "pi", nativeId: identity, identity, startedAt: 0, interaction: "interactive" },
    positive: [],
    negative: [],
    gaps: [
      {
        mistake: "worked it out by hand",
        proposedInstruction: gap,
        recurrenceRisk: "high",
        domain: "project",
        quote: `${identity} hit it`,
        ...extra,
      },
    ],
  };
}

const API_GAP = "Run the api contract tests before editing a handler.";
const WEB_GAP = "Build the web bundle before opening a pull request.";

test("the fold keeps only the gap clusters this file owns, and names where the others went", () => {
  const records = [
    evidenceRecord("api-1", API_GAP),
    evidenceRecord("api-2", API_GAP),
    evidenceRecord("web-1", WEB_GAP),
    evidenceRecord("web-2", WEB_GAP),
  ];
  const fold = (weight) =>
    foldEvidence(records, { minGapEvidence: 2, route: routingFor([API, WEB], ATTRIBUTION, "AGENTS.md", weight) });

  const root = fold(null);
  assert.deepEqual(
    root.gaps.map((gap) => gap.proposedInstruction),
    [],
    "each lesson came from one app's sessions, so neither is the root's",
  );
  assert.deepEqual(root.routedGaps.map((gap) => [gap.owner, gap.sessions]).sort(), [
    [API.path, 2],
    [WEB.path, 2],
  ]);
  assert.match(
    renderEvidenceForPrompt(root),
    /2 more gap cluster\(s\) belong to apps\/api\/AGENTS\.md, apps\/web\/AGENTS\.md/,
  );

  const api = fold(API.path);
  assert.deepEqual(
    api.gaps.map((gap) => gap.proposedInstruction),
    [API_GAP],
  );
  assert.equal(api.sourceSessions["pi · api-1 · unknown date"], "api-1", "each issued label names its session");

  const unrouted = foldEvidence(records, { minGapEvidence: 2 });
  assert.equal(unrouted.gaps.length, 2);
  assert.ok(!("routedGaps" in unrouted) && !("sourceSessions" in unrouted), "no routing, no new summary fields");
});

test("mixed-directory sessions never enter a nested analysis corpus or own its gap", async () => {
  const transcripts = ["api-1", "both", "root-and-api"].map((identity) => ({ identity }));
  const { corpora } = await nestedCorpora({}, [API], transcripts, ATTRIBUTION);
  assert.deepEqual(corpora[0].transcripts.map((item) => item.identity), ["api-1"]);
  const records = [evidenceRecord("both", API_GAP), evidenceRecord("root-and-api", API_GAP)];
  const route = routingFor([API], ATTRIBUTION, "AGENTS.md", null);
  assert.equal(foldEvidence(records, { minGapEvidence: 2, route }).gaps.length, 1);
  assert.equal(foldEvidence(records, { minGapEvidence: 2, route: { ...route, weight: API.path } }).gaps.length, 0);
});

test("bounded quotes retain evidence of a root-owned cross-directory cluster", () => {
  const records = [...Array.from({ length: 6 }, (_, index) => evidenceRecord(`api-${index}`, API_GAP)), evidenceRecord("web-1", API_GAP)];
  const attribution = new Map(records.map((record) => [record.transcript.identity, ["apps/api/a.ts"]]));
  attribution.set("web-1", ["apps/web/b.ts"]);
  const root = foldEvidence(records, { minGapEvidence: 2, route: routingFor([API, WEB], attribution, "AGENTS.md", null) });
  assert.equal(root.gaps.length, 1);
  assert.equal(root.gaps[0].quotes.length, 6);
  assert.ok(root.gaps[0].quotes.some((quote) => quote.source.includes("web-1")));
});

test("a failed skill trigger stays with the root file, which owns the skill layer", () => {
  const records = [
    evidenceRecord("api-1", API_GAP, { coveredBySkill: "api-contract" }),
    evidenceRecord("api-2", API_GAP, { coveredBySkill: "api-contract" }),
  ];
  const fold = (weight) =>
    foldEvidence(records, { minGapEvidence: 2, route: routingFor([API], ATTRIBUTION, "AGENTS.md", weight) });
  assert.deepEqual(
    fold(null).gaps.map((gap) => gap.failedTriggerSkill),
    ["api-contract"],
  );
  assert.deepEqual(fold(API.path).gaps, []);
});

// ---------- the proposal gate routes new instructions ----------

const labelOf = (id) => `pi · ${id} · 1970-01-01`;

function routedGate({
  memoryPath,
  weight,
  sessions,
  change = (text) => `${text}- Run the contract tests first.\n`,
  kind = "add",
  routing = true,
}) {
  const repo = makeRepo({
    "AGENTS.md": "# Root\n\n- Use pnpm for every package script.\n",
    "apps/api/AGENTS.md": "# API\n\n- Handlers live in src/routes.\n",
  });
  const staged = stageAndMeasure({ repo, memoryPath, edit: (root) => writeIn(root, memoryPath, change) });
  const labels = [...ATTRIBUTION.keys()].map(labelOf);
  const summary = {
    analyzedSessions: 4,
    totals: { positive: 0, negative: 0, gapClusters: 1 },
    instructions: [],
    sources: labels,
    sourceSessions: Object.fromEntries([...ATTRIBUTION.keys()].map((id) => [labelOf(id), id])),
  };
  return buildProposal(
    {
      edits: [
        {
          changes: ["H1"],
          kind,
          title: "contract tests",
          evidence: sessions.map((id) => ({ polarity: "negative", text: `${id} hit it`, source: labelOf(id) })),
        },
      ],
    },
    {
      memoryFile: staged.memoryFile,
      config: { budgetTokens: 5000, maxEditsPerRun: 5, minGapEvidence: 2, skillsDir: ".agents/skills" },
      repo,
      summary,
      measured: staged.measured,
      routing: routing ? routingFor([API, WEB], ATTRIBUTION, "AGENTS.md", weight) : null,
    },
  );
}

test("a new instruction backed only by one app's sessions is refused in the root file and kept in the app's", () => {
  const inRoot = routedGate({ memoryPath: "AGENTS.md", weight: null, sessions: ["api-1", "api-2"] });
  assert.equal(inRoot.violations.length, 1);
  assert.match(
    inRoot.violations[0],
    /backed only by sessions that worked under apps\/api\/; it belongs in apps\/api\/AGENTS\.md/,
  );

  const inApi = routedGate({ memoryPath: API.path, weight: API.path, sessions: ["api-1", "api-2"] });
  assert.deepEqual(inApi.violations, []);
  assert.equal(inApi.proposal.edits.length, 1);

  const unconfigured = routedGate({
    memoryPath: "AGENTS.md",
    weight: null,
    sessions: ["api-1", "api-2"],
    routing: false,
  });
  assert.deepEqual(unconfigured.violations, [], "without nested files the gate does not exist");
});

test("a new instruction backed by sessions from more than one app is refused in the app's file and kept in the root", () => {
  const inApi = routedGate({ memoryPath: API.path, weight: API.path, sessions: ["api-1", "web-1"] });
  assert.equal(inApi.violations.length, 1);
  assert.match(inApi.violations[0], /cross-cutting evidence belongs in AGENTS\.md, not apps\/api\/AGENTS\.md/);

  const inRoot = routedGate({ memoryPath: "AGENTS.md", weight: null, sessions: ["api-1", "web-1"] });
  assert.deepEqual(inRoot.violations, []);
});

test("a rewrite stays with the file whose text it changes, whoever's sessions back it", () => {
  const rewrite = routedGate({
    memoryPath: "AGENTS.md",
    weight: null,
    sessions: ["api-1", "api-2"],
    kind: "rewrite",
    change: (text) => text.replace("every package script", "every package script, including the api's"),
  });
  assert.deepEqual(rewrite.violations, []);
});

// ---------- each nested file has its own budget ----------

test("a nested pass runs in its own state under its own budget, sharing only the recorded rejections", () => {
  const repo = makeRepo({ "AGENTS.md": "# root\n", "apps/api/AGENTS.md": "# api\n" });
  const rootState = new State(repo.root).ensure();
  const ctx = {
    repo,
    config: { state: rootState, budgetTokens: 5000, nestedBudgetTokens: 40, memoryFiles: ["AGENTS.md"] },
  };
  const nested = nestedContext(ctx, API);
  assert.equal(nested.config.budgetTokens, 40);
  assert.deepEqual(nested.config.memoryFiles, [API.path]);
  assert.deepEqual(nested.config.target, { kind: "memory", path: API.path, nested: true });
  assert.ok(nested.config.state.root.startsWith(path.join(rootState.root, "nested")));
  assert.equal(nested.config.state.rejectionsPath, rootState.rejectionsPath);
  assert.equal(
    nestedContext({ ...ctx, config: { ...ctx.config, nestedBudgetTokens: null } }, API).config.budgetTokens,
    5000,
  );
});

function mergedProposal() {
  const repo = makeRepo({
    "AGENTS.md": "# Root\n\n- Use pnpm for every package script.\n",
    "apps/api/AGENTS.md": "# API\n\n- Handlers live in src/routes.\n",
  });
  const config = { budgetTokens: 5000, maxEditsPerRun: 5, minGapEvidence: 2, skillsDir: ".agents/skills" };
  const rootStaged = stageAndMeasure({ repo, edit: () => {} });
  const root = buildProposal(
    { edits: [] },
    { memoryFile: rootStaged.memoryFile, config, repo, summary: null, measured: rootStaged.measured },
  );
  const apiStaged = stageAndMeasure({
    repo,
    memoryPath: API.path,
    edit: (dir) =>
      writeIn(dir, API.path, (text) => `${text}- Run the api contract tests before editing a handler, every time.\n`),
  });
  const api = buildProposal(
    {
      edits: [
        {
          changes: ["H1"],
          kind: "add",
          title: "contract tests",
          evidence: [
            { polarity: "negative", text: "api-1 hit it", source: "a" },
            { polarity: "negative", text: "api-2 hit it", source: "b" },
          ],
        },
      ],
    },
    {
      memoryFile: apiStaged.memoryFile,
      config,
      repo,
      summary: null,
      measured: apiStaged.measured,
      target: { kind: "memory", path: API.path, nested: true },
    },
  );
  assert.deepEqual(api.violations, []);
  const weight = { ...API, file: apiStaged.memoryFile };
  const quiet = { ...WEB, file: { ...apiStaged.memoryFile, path: WEB.path } };
  const proposal = mergeNestedProposals(root.proposal, [
    { weight, transcripts: [{}, {}], proposal: api.proposal, summary: null, cap: 5000, skipped: null },
    {
      weight: quiet,
      transcripts: [],
      proposal: null,
      summary: null,
      cap: 5000,
      skipped: "nothing to learn from this run",
    },
  ]);
  return { repo, proposal, state: rootStaged.state };
}

test("one proposal covers every file: nested edits are renumbered, labeled by file, and freshness-checked", () => {
  const { proposal } = mergedProposal();
  assert.deepEqual(
    proposal.edits.map((edit) => [edit.id, edit.file, edit.nestedMemoryFile, edit.targetsMemoryFile]),
    [["e1", API.path, API.path, false]],
  );
  assert.deepEqual(
    proposal.nested.map((entry) => [entry.memoryFile.path, entry.sessions, entry.edits, entry.skipped ?? null]),
    [
      [API.path, 2, ["e1"], null],
      [WEB.path, 0, [], "nothing to learn from this run"],
    ],
  );
  const quiet = proposal.nested[1].budget;
  assert.equal(quiet.projected, quiet.current, "a file with nothing to learn still shows where its budget stands");
  assert.deepEqual(
    proposal.targetFiles.map((target) => target.file),
    [API.path],
    "only a file with edits is freshness-checked",
  );
});

test("apply holds each nested file to its own budget, and writes nothing when the accepted subset breaks it", () => {
  const over = mergedProposal();
  const refused = applyDecisions({
    proposal: over.proposal,
    decisions: { e1: "accepted" },
    repo: over.repo,
    state: over.state,
    config: { budgetTokens: 5000, nestedBudgetTokens: 20 },
  });
  assert.equal(refused.written.length, 0);
  assert.match(
    refused.failed[0]?.error ?? "",
    /leave apps\/api\/AGENTS\.md at \d+ tokens, \d+ over its 20-token budget/,
  );
  assert.equal(
    fs.readFileSync(path.join(over.repo.root, API.path), "utf8"),
    "# API\n\n- Handlers live in src/routes.\n",
  );

  const within = mergedProposal();
  const written = applyDecisions({
    proposal: within.proposal,
    decisions: { e1: "accepted" },
    repo: within.repo,
    state: within.state,
    config: { budgetTokens: 5000, nestedBudgetTokens: 200 },
  });
  assert.deepEqual(written.failed, []);
  assert.deepEqual(
    written.written.map((entry) => [entry.file, entry.budget?.capTokens]),
    [[API.path, 200]],
  );
  assert.match(fs.readFileSync(path.join(within.repo.root, API.path), "utf8"), /Run the api contract tests/);
});
