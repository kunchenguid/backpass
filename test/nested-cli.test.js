import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Nested memory files through the real CLI, the way a monorepo user runs them: a root
 * AGENTS.md and an `apps/api/AGENTS.md` named in `nestedMemoryFiles`, pi sessions that
 * worked either under `apps/api/` or under `apps/web/`, and a stand-in acpx that reports
 * one lesson per kind of session. `backpass` must feed the nested file only its own
 * sessions, land each lesson in the file that owns it, and hand both files to one
 * `backpass apply`; with nothing configured the run must stay the single-file run it was.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "backpass.js");
const FAKE_LAVISH = path.join(ROOT, "test", "fixtures", "fake-lavish", "lavish-axi");

const API_QUOTE = "Please fix the api handler timeout in the orders route.";
const WEB_QUOTE = "Please fix the web checkout button styling.";
const API_GAP = "Run the api contract tests before editing a handler.";
const WEB_GAP = "Build the web bundle before opening a pull request.";

const ROOT_MEMORY = "# Monorepo memory\n\n- Use pnpm for every package script.\n";
const API_MEMORY = "# API memory\n\n- Handlers live in apps/api/src/routes.\n";

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-nested-bin-"));
const fakePi = path.join(binDir, "pi");
const fakeAcpx = path.join(binDir, "acpx");
fs.writeFileSync(fakePi, `#!${process.execPath}\nprocess.exit(0);\n`);
fs.chmodSync(fakePi, 0o755);

/**
 * The stand-in harness. Analysis reports the lesson whose quote is in the trace; the
 * synthesis edit turn appends every lesson the evidence it was shown carries; the annotate
 * turn claims those changes with the quotes and source labels that evidence issued.
 */
fs.writeFileSync(
  fakeAcpx,
  `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const at = (flag) => (argv.indexOf(flag) >= 0 ? argv[argv.indexOf(flag) + 1] : null);
if (argv.includes("config") && argv.includes("show")) {
  process.stdout.write(JSON.stringify({ agents: {} }) + "\\n");
  process.exit(0);
}
if (argv.includes("sessions") || argv.includes("set")) {
  if (argv.includes("new")) process.stdout.write("fake-session-id\\n");
  process.exit(0);
}
const promptFile = at("--file");
if (!promptFile) process.exit(0);
const prompt = fs.readFileSync(promptFile, "utf8");
const cwd = at("--cwd") || process.cwd();
const statePath = process.env.FAKE_STATE;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { log: [], shown: {} };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const lessons = ${JSON.stringify([
    { gap: API_GAP, quote: API_QUOTE },
    { gap: WEB_GAP, quote: WEB_QUOTE },
  ])};
if (process.env.FAKE_SHARED_GAP) lessons[1].gap = lessons[0].gap;

if (prompt.includes("You are auditing one past agent session")) {
  const audited = /## The memory file under audit: (\\S+)/.exec(prompt)[1];
  const gaps = lessons
    .filter((lesson) => prompt.includes(lesson.quote))
    .map((lesson) => ({
      mistake: "the session had to work it out by hand",
      proposedInstruction: lesson.gap,
      recurrenceRisk: "high",
      domain: "project",
      quote: lesson.quote,
    }));
  state.log.push({ turn: "analysis", audited, gaps: gaps.map((gap) => gap.proposedInstruction), alsoLoaded: prompt.includes("## Also loaded in this session") });
  save();
  process.stdout.write(JSON.stringify({ positive: [], negative: [], gaps }) + "\\n");
  process.exit(0);
}
if (prompt.includes("You are consolidating the gap ledger")) {
  process.stdout.write(JSON.stringify({ merges: [] }) + "\\n");
  process.exit(0);
}
if (prompt.includes("You are performing the synthesis step")) {
  const memory = /## Current memory file: (\\S+)/.exec(prompt)[1];
  const pairs = [...prompt.matchAll(/"([^"]+)" \\((pi · [^)]+)\\)/g)].map((m) => ({ text: m[1], source: m[2] }));
  const shown = lessons.filter((lesson, index) =>
    prompt.includes(":: " + lesson.gap) && lessons.findIndex((entry) => entry.gap === lesson.gap) === index);
  state.shown[memory] = shown.map((lesson) => ({
    ...lesson,
    evidence: pairs.filter((pair) => lessons.some((entry) => entry.gap === lesson.gap && entry.quote === pair.text)),
  }));
  const budgetCount = prompt.includes("The count is this file PLUS every skill's \\\`description:\\\` line;\\nskill bodies are free until triggered.")
    ? "surface"
    : prompt.includes("The count is this file alone") ? "file" : null;
  const nestedRule = prompt.includes("This run trains the nested memory file");
  state.log.push({ turn: "edit", memory, lessons: shown.map((lesson) => lesson.gap), budgetCount, nestedRule });
  save();
  const target = path.join(cwd, memory);
  let text = fs.readFileSync(target, "utf8");
  for (const lesson of shown) text += "- " + lesson.gap + "\\n";
  fs.writeFileSync(target, text);
  process.stdout.write("Added the lessons the evidence carries.\\n");
  process.exit(0);
}
if (prompt.includes("## Measured changes")) {
  const memory = /staging copy of (\\S+?)\\. Every change/.exec(prompt)[1];
  const changes = [...prompt.matchAll(/\\[(H\\d+):/g)].map((m) => m[1]);
  const shown = state.shown[memory] || [];
  state.log.push({ turn: "annotate", memory, changes });
  save();
  const edits = shown.length
    ? [{
        changes,
        kind: "add",
        title: shown.map((lesson) => lesson.gap).join(" "),
        rationale: "two sessions hit it",
        evidence: shown.flatMap((lesson) => lesson.evidence.map((pair) => ({ polarity: "negative", text: pair.text, source: pair.source }))),
      }]
    : [];
  process.stdout.write(JSON.stringify({ edits, verdicts: [], notes: [] }) + "\\n");
  process.exit(0);
}
process.exit(0);
`,
);
fs.chmodSync(fakeAcpx, 0o755);

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A monorepo checkout with a root memory file and one nested one. */
function makeMonorepo({ config = null } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-nested-repo-")));
  const files = {
    "AGENTS.md": ROOT_MEMORY,
    "apps/api/AGENTS.md": API_MEMORY,
    "apps/api/src/routes/orders.ts": "export const orders = 1;\n",
    "apps/web/src/checkout.tsx": "export const checkout = 1;\n",
    ...(config ? { ".backpassrc.json": `${JSON.stringify(config)}\n` } : {}),
  };
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "monorepo"], dir);
  return dir;
}

/** A pi session rooted at the repo that edits one file, named by a repo-relative path. */
function writeSession(home, id, cwd, { quote, file }) {
  const dir = path.join(home, ".pi", "agent", "sessions", id);
  fs.mkdirSync(dir, { recursive: true });
  const entries = [
    { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd },
    { type: "message", message: { role: "user", content: quote } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Reading the file first." },
          { type: "toolCall", id: `${id}-read`, name: "read", arguments: { path: file } },
        ],
      },
    },
    { type: "message", message: { role: "toolResult", toolCallId: `${id}-read`, content: "export const x = 1;" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: `${id}-edit`, name: "edit", arguments: { path: file, edits: [] } }],
      },
    },
    { type: "message", message: { role: "toolResult", toolCallId: `${id}-edit`, content: "edited" } },
    { type: "message", message: { role: "user", content: "Now run the tests too." } },
    { type: "message", message: { role: "assistant", content: "Tests pass." } },
  ];
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

/** Two sessions that worked under apps/api, two under apps/web. */
function makeCorpus(dir) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-nested-home-"));
  writeSession(home, "api-one", dir, { quote: API_QUOTE, file: "apps/api/src/routes/orders.ts" });
  writeSession(home, "api-two", dir, { quote: API_QUOTE, file: "apps/api/src/routes/orders.ts" });
  writeSession(home, "web-one", dir, { quote: WEB_QUOTE, file: "apps/web/src/checkout.tsx" });
  writeSession(home, "web-two", dir, { quote: WEB_QUOTE, file: "apps/web/src/checkout.tsx" });
  return home;
}

function run(dir, home, args, extraEnv = {}) {
  const statePath = path.join(home, "fake-state.json");
  const result = spawnSync(
    process.execPath,
    [
      CLI,
      ...args,
      "--harness",
      "pi",
      "--since",
      "all",
      "--analysis-agent",
      "pi",
      "--synthesis-agent",
      "claude",
      "--synthesis-model",
      "fake-model",
      "--jobs",
      "1",
    ],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: 60000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        BACKPASS_ACPX_BIN: fakeAcpx,
        FAKE_STATE: statePath,
        NO_COLOR: "1",
        CI: "1",
        ...extraEnv,
      },
    },
  );
  const log = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")).log : [];
  return { ...result, output: `${result.stdout}${result.stderr}`, log };
}

function applyAll(dir, editIds) {
  const decisions = editIds.map((id) => `${id}=accepted`).join(" ");
  const scenario = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-nested-lavish-")), "scenario.json");
  fs.writeFileSync(
    scenario,
    JSON.stringify({
      polls: [
        `prompts[1]{uid,prompt,selector,tag,text}:\n  "1","BACKPASS_DECISIONS ${decisions}",button#btn-apply,choice,${decisions}`,
      ],
    }),
  );
  const result = spawnSync(process.execPath, [CLI, "apply", "--no-open"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", BACKPASS_LAVISH_BIN: FAKE_LAVISH, FAKE_LAVISH_SCENARIO: scenario },
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("a named nested file learns only from its subtree, and each lesson lands in the file that owns it", () => {
  const dir = makeMonorepo({ config: { nestedMemoryFiles: ["apps/api/AGENTS.md"] } });
  const home = makeCorpus(dir);

  const result = run(dir, home, []);
  assert.equal(result.status, 0, result.output);

  // The nested surface is named for what it is, never as a file to consolidate.
  assert.match(
    result.output,
    /apps\/api\/AGENTS\.md is a nested memory file: 2 of 4 session\(s\) worked under apps\/api\//,
  );
  assert.doesNotMatch(result.output, /consolidate/);

  // Evidence scoping: the root file is audited on every session, the nested one only on
  // the two that worked under apps/api, with the root shown as already loaded.
  const analyses = result.log.filter((entry) => entry.turn === "analysis");
  assert.equal(analyses.filter((entry) => entry.audited === "AGENTS.md").length, 4);
  const nestedAnalyses = analyses.filter((entry) => entry.audited === "apps/api/AGENTS.md");
  assert.equal(nestedAnalyses.length, 2);
  assert.ok(nestedAnalyses.every((entry) => entry.alsoLoaded && entry.gaps.join() === API_GAP));
  assert.ok(analyses.filter((entry) => entry.audited === "AGENTS.md").every((entry) => !entry.alsoLoaded));

  // Routing: the api lesson reaches only the nested synthesis, the web lesson only the root.
  // The nested synthesis is told what it trains and budgets that file alone.
  const edits = result.log.filter((entry) => entry.turn === "edit");
  assert.deepEqual(
    edits.map((entry) => [entry.memory, entry.lessons, entry.budgetCount, entry.nestedRule]),
    [
      ["AGENTS.md", [WEB_GAP], "surface", false],
      ["apps/api/AGENTS.md", [API_GAP], "file", true],
    ],
  );

  // One proposal covers both files, each edit labeled by its file, each file its own budget.
  const proposal = readJson(path.join(dir, ".backpass", "proposal.json"));
  assert.deepEqual(
    proposal.edits.map((edit) => [edit.id, edit.file, edit.nestedMemoryFile ?? null]),
    [
      ["e1", "AGENTS.md", null],
      ["e2", "apps/api/AGENTS.md", "apps/api/AGENTS.md"],
    ],
  );
  assert.equal(proposal.nested.length, 1);
  assert.equal(proposal.nested[0].memoryFile.path, "apps/api/AGENTS.md");
  assert.equal(proposal.nested[0].sessions, 2);
  assert.deepEqual(proposal.nested[0].edits, ["e2"]);
  assert.ok(proposal.targetFiles.some((target) => target.file === "apps/api/AGENTS.md"));
  assert.match(result.output, /e2 ADD\s+apps\/api\/AGENTS\.md: /);
  assert.match(result.output, /nested apps\/api\/AGENTS\.md · 2 session\(s\) under apps\/api\/ · budget /);

  // The nested file's state is its own; the root's evidence dir holds only root evidence.
  const nestedState = path.join(dir, ".backpass", "nested");
  assert.ok(fs.existsSync(path.join(nestedState, "attribution.json")));
  const rootEvidence = fs
    .readdirSync(path.join(dir, ".backpass", "evidence"))
    .map((file) => readJson(path.join(dir, ".backpass", "evidence", file)));
  assert.ok(rootEvidence.every((record) => record.memoryPath === "AGENTS.md"));

  // One apply writes both files, and only apply writes.
  assert.equal(fs.readFileSync(path.join(dir, "apps/api/AGENTS.md"), "utf8"), API_MEMORY);
  const applied = applyAll(dir, ["e1", "e2"]);
  assert.equal(applied.status, 0, applied.output);
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), `${ROOT_MEMORY}- ${WEB_GAP}\n`);
  assert.equal(fs.readFileSync(path.join(dir, "apps/api/AGENTS.md"), "utf8"), `${API_MEMORY}- ${API_GAP}\n`);
  assert.match(applied.output, /wrote apps\/api\/AGENTS\.md \(e2\)/);
});

test("a gap spanning API and web is proposed only in root, not again from its API subset", () => {
  const dir = makeMonorepo({ config: { nestedMemoryFiles: ["apps/api/AGENTS.md"] } });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-nested-shared-home-"));
  writeSession(home, "api-one", dir, { quote: API_QUOTE, file: "apps/api/src/routes/orders.ts" });
  writeSession(home, "api-two", dir, { quote: API_QUOTE, file: "apps/api/src/routes/orders.ts" });
  writeSession(home, "web-one", dir, { quote: WEB_QUOTE, file: "apps/web/src/checkout.tsx" });

  const result = run(dir, home, [], { FAKE_SHARED_GAP: "1" });
  assert.equal(result.status, 0, result.output);
  const proposal = readJson(path.join(dir, ".backpass", "proposal.json"));
  assert.deepEqual(
    proposal.edits.map((edit) => edit.file),
    ["AGENTS.md"],
  );
  assert.deepEqual(proposal.nested[0].edits, []);
  assert.deepEqual(
    result.log.filter((entry) => entry.turn === "edit").map((entry) => entry.lessons),
    [[API_GAP], []],
  );
});

test("with no nested file named, a run trains the root file from every session, as it always did", () => {
  const dir = makeMonorepo();
  const home = makeCorpus(dir);

  const result = run(dir, home, []);
  assert.equal(result.status, 0, result.output);

  const analyses = result.log.filter((entry) => entry.turn === "analysis");
  assert.equal(analyses.length, 4);
  assert.ok(analyses.every((entry) => entry.audited === "AGENTS.md" && !entry.alsoLoaded));
  // Both lessons compete for the one root file, exactly as before nested files existed.
  assert.deepEqual(
    result.log
      .filter((entry) => entry.turn === "edit")
      .map((entry) => [entry.memory, [...entry.lessons].sort(), entry.budgetCount, entry.nestedRule]),
    [["AGENTS.md", [API_GAP, WEB_GAP].sort(), "surface", false]],
  );
  const proposal = readJson(path.join(dir, ".backpass", "proposal.json"));
  assert.equal(proposal.nested, undefined);
  assert.ok(proposal.edits.every((edit) => edit.file === "AGENTS.md" && edit.nestedMemoryFile === undefined));
  assert.ok(!fs.existsSync(path.join(dir, ".backpass", "nested")), "no nested state without a nested file");
  assert.doesNotMatch(result.output, /nested memory file|\(nested\)|^ {2}nested /m);
});

test("an unchanged over-budget root permits nested training but not an unconfigured or edited root", () => {
  const named = makeMonorepo({
    config: { budgetTokens: 1, nestedBudgetTokens: 2000, nestedMemoryFiles: ["apps/api/AGENTS.md"] },
  });
  const apiHome = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-nested-api-home-"));
  writeSession(apiHome, "api-one", named, { quote: API_QUOTE, file: "apps/api/src/routes/orders.ts" });
  writeSession(apiHome, "api-two", named, { quote: API_QUOTE, file: "apps/api/src/routes/orders.ts" });
  const nested = run(named, apiHome, []);
  assert.equal(nested.status, 0, nested.output);
  const proposal = readJson(path.join(named, ".backpass", "proposal.json"));
  assert.deepEqual(
    proposal.edits.map((edit) => edit.file),
    ["apps/api/AGENTS.md"],
  );
  assert.ok(proposal.budget.startedOverBudget);
  assert.equal(proposal.budget.delta, 0);

  const editedRoot = makeMonorepo({
    config: { budgetTokens: 1, nestedBudgetTokens: 2000, nestedMemoryFiles: ["apps/api/AGENTS.md"] },
  });
  const edited = run(editedRoot, makeCorpus(editedRoot), []);
  assert.equal(edited.status, 1, edited.output);
  assert.match(edited.output, /this run must shrink it/);

  const unconfigured = makeMonorepo({ config: { budgetTokens: 1 } });
  const noGapHome = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-nested-no-gap-home-"));
  writeSession(noGapHome, "plain-one", unconfigured, {
    quote: "Review the file.",
    file: "apps/api/src/routes/orders.ts",
  });
  writeSession(noGapHome, "plain-two", unconfigured, {
    quote: "Review the file.",
    file: "apps/api/src/routes/orders.ts",
  });
  const root = run(unconfigured, noGapHome, []);
  assert.equal(root.status, 1, root.output);
  assert.match(root.output, /this run must shrink it/);
});

test("a subdirectory file listed only in memoryFiles still gets the consolidate warning; named as nested, it does not", () => {
  const listed = makeMonorepo({ config: { memoryFiles: ["AGENTS.md", "apps/api/AGENTS.md"] } });
  const home = makeCorpus(listed);
  const unconfigured = run(listed, home, ["analyze"]);
  assert.equal(unconfigured.status, 0, unconfigured.output);
  assert.match(
    unconfigured.output,
    /apps\/api\/AGENTS\.md is a separate memory file and will NOT be updated - only AGENTS\.md is optimized/,
  );

  const named = makeMonorepo({
    config: { memoryFiles: ["AGENTS.md", "apps/api/AGENTS.md"], nestedMemoryFiles: ["apps/api/AGENTS.md"] },
  });
  const namedHome = makeCorpus(named);
  const nested = run(named, namedHome, ["analyze"]);
  assert.equal(nested.status, 0, nested.output);
  assert.doesNotMatch(nested.output, /separate memory file/);
  assert.match(
    nested.output,
    /apps\/api\/AGENTS\.md is a nested memory file: 2 of 4 session\(s\) worked under apps\/api\//,
  );
  assert.match(
    nested.output,
    /analyzed against apps\/api\/AGENTS\.md \(nested, 1 instructions, \d+ tok\) from 2 session\(s\) under apps\/api\//,
  );
});

test("--target on a nested file is refused by name, and a targeted run never trains a nested file", () => {
  const dir = makeMonorepo({ config: { nestedMemoryFiles: ["apps/api/AGENTS.md"] } });
  const home = makeCorpus(dir);

  const refused = run(dir, home, ["analyze", "--target", "apps/api/AGENTS.md"]);
  assert.equal(refused.status, 1);
  assert.match(refused.output, /--target apps\/api\/AGENTS\.md is a nested memory file/);

  const targeted = run(dir, home, ["analyze", "--target", "AGENTS.md"]);
  assert.equal(targeted.status, 0, targeted.output);
  assert.ok(targeted.log.every((entry) => entry.audited === "AGENTS.md"));
  assert.doesNotMatch(targeted.output, /nested memory file/);
});
