import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";

import * as claude from "../src/discovery/adapters/claude.js";
import * as codex from "../src/discovery/adapters/codex.js";
import * as pi from "../src/discovery/adapters/pi.js";
import * as grok from "../src/discovery/adapters/grok.js";
import * as cursorCli from "../src/discovery/adapters/cursor-cli.js";
import * as hermes from "../src/discovery/adapters/hermes.js";
import * as opencode from "../src/discovery/adapters/opencode.js";
import { statOrNull } from "../src/discovery/adapters/shared.js";
import { classifyInteraction, INTERACTIVE, NON_INTERACTIVE } from "../src/interaction.js";
import { discoverTranscripts } from "../src/discovery/index.js";
import { loadConfig } from "../src/config.js";
import { foldEvidence, renderEvidenceForPrompt } from "../src/fold.js";
import { analyzeTranscripts } from "../src/analyze.js";
import { foldForRun, printProposal } from "../src/commands/propose.js";
import { cmdScan } from "../src/commands/scan.js";
import { renderApplySurface } from "../src/apply/lavish.js";
import { evidenceKey, State } from "../src/state.js";
import { transcriptIdentity } from "../src/transcript.js";
import { sampleTranscripts, capTranscripts } from "../src/sample.js";
import { setLoggerSink } from "../src/logger.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "backpass.js");
const FIXTURES = path.join(ROOT, "test", "fixtures");
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 22);

function candidateFor(file) {
  const stat = statOrNull(file);
  return { key: file, path: file, mtimeMs: stat.mtimeMs, bytes: stat.size };
}

function labeled(harness, descriptor) {
  return classifyInteraction({ harness, ...descriptor, extra: descriptor.extra });
}

function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

test("claude sessions are interactive for cli entrypoint and non-interactive for sdk", () => {
  const cli = claude.classify(candidateFor(path.join(FIXTURES, "claude-session.jsonl")));
  assert.equal(cli.interactionSignals.entrypoint, "cli");
  assert.equal(labeled("claude", cli), INTERACTIVE);

  const file = path.join(os.tmpdir(), `backpass-claude-sdk-${process.pid}.jsonl`);
  writeJsonl(file, [
    {
      type: "user",
      message: { role: "user", content: "Run the pipeline." },
      cwd: "/repo/demo",
      gitBranch: "main",
      sessionId: "sdk-session",
      entrypoint: "sdk-cli",
      timestamp: "2026-08-01T10:00:00.000Z",
    },
  ]);
  const sdk = claude.classify(candidateFor(file));
  assert.equal(sdk.interactionSignals.entrypoint, "sdk-cli");
  assert.equal(labeled("claude", sdk), NON_INTERACTIVE);
});

test("codex originator/source classify exec as non-interactive and tui as interactive", () => {
  const execSession = codex.classify(candidateFor(path.join(FIXTURES, "codex-rollout.jsonl")));
  assert.equal(execSession.interactionSignals.originator, "codex_exec");
  assert.equal(execSession.interactionSignals.source, "exec");
  assert.equal(labeled("codex", execSession), NON_INTERACTIVE);

  const file = path.join(os.tmpdir(), `backpass-codex-tui-${process.pid}.jsonl`);
  writeJsonl(file, [
    {
      timestamp: "2026-08-02T09:00:00.000Z",
      type: "session_meta",
      payload: {
        session_id: "tui-1",
        cwd: "/repo/demo",
        source: "cli",
        originator: "codex-tui",
        git: { repository_url: "git@github.com:acme/demo.git", branch: "main" },
      },
    },
  ]);
  const tui = codex.classify(candidateFor(file));
  assert.equal(tui.interactionSignals.originator, "codex-tui");
  assert.equal(labeled("codex", tui), INTERACTIVE);
});

test("pi, grok, and cursor CLI default interactive; a .no-mistakes cwd is non-interactive", () => {
  const piSession = pi.classify(candidateFor(path.join(FIXTURES, "pi-session.jsonl")));
  assert.equal(labeled("pi", piSession), INTERACTIVE);

  const grokDir = path.join(FIXTURES, "grok-session", "%2Frepo%2Fdemo", "grok-9999");
  const grokSession = grok.classify({ path: grokDir, mtimeMs: 0 });
  assert.equal(labeled("grok", grokSession), INTERACTIVE);

  const cursorDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-cursor-"));
  fs.writeFileSync(
    path.join(cursorDir, "meta.json"),
    JSON.stringify({ cwd: "/repo/demo", createdAtMs: NOW, title: "chat" }),
  );
  const cursorSession = cursorCli.classify({ path: cursorDir, mtimeMs: NOW });
  assert.equal(labeled("cursor", cursorSession), INTERACTIVE);

  const pipelineCwd = "/Users/me/.no-mistakes/worktrees/abc/session";
  assert.equal(classifyInteraction({ harness: "pi", cwd: pipelineCwd, interactionSignals: {} }), NON_INTERACTIVE);
  assert.equal(classifyInteraction({ harness: "grok", cwd: pipelineCwd, interactionSignals: {} }), NON_INTERACTIVE);
  assert.equal(classifyInteraction({ harness: "cursor", cwd: pipelineCwd, interactionSignals: {} }), NON_INTERACTIVE);
  assert.equal(classifyInteraction({ harness: "cursor-ide", cwd: "/repo/demo", interactionSignals: {} }), INTERACTIVE);
});

test("hermes cli/acp sessions are interactive; cron source would be non-interactive", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-hermes-mix-"));
  const db = new DatabaseSync(path.join(dir, "state.db"));
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT, model TEXT, model_config TEXT,
      system_prompt TEXT, title TEXT, started_at REAL, ended_at REAL
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
      tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL
    );
  `);
  db.prepare("INSERT INTO sessions (id, source, system_prompt, started_at) VALUES (?, ?, ?, ?)").run(
    "cli-1",
    "cli",
    "Working directory: /repo/demo",
    1_700_000_000,
  );
  db.close();

  const prev = process.env.HERMES_HOME;
  process.env.HERMES_HOME = dir;
  try {
    const [row] = await hermes.discover();
    assert.equal(row.extra.source, "cli");
    assert.equal(labeled("hermes", row), INTERACTIVE);
  } finally {
    if (prev === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = prev;
  }

  assert.equal(
    classifyInteraction({
      harness: "hermes",
      cwd: "/repo/demo",
      extra: { source: "cron" },
      interactionSignals: { source: "cron" },
    }),
    NON_INTERACTIVE,
  );
});

test("opencode parent sessions are interactive and child sessions are not", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-opencode-home-"));
  const store = path.join(home, ".local", "share", "opencode");
  fs.mkdirSync(store, { recursive: true });
  const db = new DatabaseSync(path.join(store, "opencode.db"));
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT NOT NULL,
      directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      cost REAL NOT NULL DEFAULT 0, tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0, tokens_reasoning INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read INTEGER NOT NULL DEFAULT 0, tokens_cache_write INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare("INSERT INTO project (id, worktree, time_created, time_updated) VALUES (?, ?, ?, ?)").run(
    "p1",
    "/repo/demo",
    NOW,
    NOW,
  );
  const insert = db.prepare(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("ses_parent", "p1", null, "quiet", "/repo/demo", "parent", "1.0.0", NOW, NOW);
  insert.run("ses_child", "p1", "ses_parent", "child", "/repo/demo", "child", "1.0.0", NOW, NOW);
  db.close();

  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const rows = await opencode.discover({ cutoffMs: null });
    const parent = rows.find((row) => row.id === "ses_parent");
    const child = rows.find((row) => row.id === "ses_child");
    assert.equal(labeled("opencode", parent), INTERACTIVE);
    assert.equal(labeled("opencode", child), NON_INTERACTIVE);
  } finally {
    process.env.HOME = prevHome;
  }
});

function git(args, cwd) {
  spawnSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-mix-repo-")));
  git(["init", "--quiet", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Agent instructions\n\n- Keep PRs small.\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "memory"], dir);
  return dir;
}

function writeClaude(home, { id, cwd, entrypoint }) {
  const project = path.join(home, ".claude", "projects", cwd.replaceAll(/[/\\.]/g, "-"));
  writeJsonl(path.join(project, `${id}.jsonl`), [
    {
      type: "user",
      message: { role: "user", content: `Do the work ${id}` },
      cwd,
      gitBranch: "main",
      sessionId: id,
      entrypoint,
      timestamp: "2026-08-20T10:00:00.000Z",
    },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      cwd,
      sessionId: id,
      timestamp: "2026-08-20T10:00:05.000Z",
    },
  ]);
}

test("scan prints the interactive/non-interactive mix through the CLI", () => {
  const repo = initRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-mix-home-"));
  writeClaude(home, { id: "human-1", cwd: repo, entrypoint: "cli" });
  writeClaude(home, { id: "robot-1", cwd: repo, entrypoint: "sdk-cli" });
  writeClaude(home, { id: "robot-2", cwd: repo, entrypoint: "sdk-ts" });

  const result = spawnSync(process.execPath, [CLI, "scan", "--harness", "claude", "--since", "all", "--json"], {
    cwd: repo,
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.mix, { interactive: 1, nonInteractive: 2, total: 3 });
  assert.equal(payload.transcripts.filter((t) => t.interaction === INTERACTIVE).length, 1);
  assert.equal(payload.transcripts.filter((t) => t.interaction === NON_INTERACTIVE).length, 2);

  const human = spawnSync(process.execPath, [CLI, "scan", "--harness", "claude", "--since", "all"], {
    cwd: repo,
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
    encoding: "utf8",
  });
  assert.match(human.stdout, /interactive 1 · non-interactive 2/);
});

test("cmdScan includes the mix on the human table", async () => {
  const repo = initRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-mix-scan-"));
  writeClaude(home, { id: "human-1", cwd: repo, entrypoint: "cli" });
  writeClaude(home, { id: "robot-1", cwd: repo, entrypoint: "sdk-cli" });
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const config = loadConfig(repo);
    config.state = new State(repo).ensure();
    await cmdScan({
      repo: { name: path.basename(repo), root: repo, worktrees: [repo], remotes: [] },
      config,
      flags: {},
      strict: false,
    });
  } finally {
    console.log = originalLog;
    process.env.HOME = prevHome;
  }
  assert.ok(lines.some((line) => line.includes("interactive 1 · non-interactive 1")));
  assert.ok(lines.some((line) => /\bKIND\b/.test(line) && /\bHARNESS\b/.test(line)));
});

test("propose and apply surfaces print the corpus mix", () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    printProposal({
      repo: { name: "demo" },
      memoryFile: { path: "AGENTS.md" },
      edits: [],
      notes: [],
      stats: {
        transcripts: 5,
        positive: 1,
        negative: 0,
        gapClusters: 0,
        corpusMix: { interactive: 2, nonInteractive: 3, total: 5 },
      },
      budget: { current: 100, projected: 100, capTokens: 5000, utilization: 0.02, withinBudget: true, mode: "cap" },
      usage: [],
    });
  } finally {
    console.log = originalLog;
  }
  assert.ok(lines.some((line) => line.includes("from 5 session(s) · interactive 2 · non-interactive 3")));

  class Node {
    constructor(text = "") {
      this.textContent = text;
      this.children = [];
      this.style = {};
      this.hidden = false;
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    setAttribute() {}
    addEventListener() {}
  }
  const nodes = new Map();
  const document = {
    createElement: () => new Node(),
    createTextNode: (text) => new Node(String(text)),
    getElementById: (id) => {
      if (!nodes.has(id)) nodes.set(id, new Node());
      return nodes.get(id);
    },
  };
  const textOf = (node) => node.textContent + node.children.map(textOf).join("");
  const proposal = {
    generatedAt: "2026-08-01T00:00:00.000Z",
    repo: { name: "demo" },
    memoryFile: { path: "AGENTS.md" },
    stats: {
      harnessCounts: { claude: 5 },
      transcripts: 5,
      corpusMix: { interactive: 2, nonInteractive: 3, total: 5 },
      positive: 0,
      negative: 0,
      gapClusters: 0,
      skillExtractions: 0,
    },
    config: { maxEditsPerRun: 5, minGapEvidence: 2 },
    budget: { current: 100, projected: 100, capTokens: 200, descriptionTokens: 0, mode: "cap" },
    edits: [],
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-mix-apply-"));
  const target = renderApplySurface(proposal, new State(dir), "0.1.0");
  const html = fs.readFileSync(target, "utf8");
  const window = {};
  window.window = window;
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    vm.runInNewContext(match[1], { window, document });
  }
  assert.match(textOf(nodes.get("runline")), /interactive 2 · non-interactive 3/);
});

test("cached evidence is upgraded with the current interaction category", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-mix-cache-"));
  const state = new State(dir).ensure();
  const transcript = {
    harness: "codex",
    id: "codex-robot-1",
    nativeId: "robot-1",
    path: "/sessions/robot-1.jsonl",
    mtimeMs: 100,
    bytes: 200,
    interactionSignals: { originator: "codex_exec", source: "exec" },
    interaction: NON_INTERACTIVE,
    startedAt: "2026-09-02T10:00:00.000Z",
    cwd: "/repos/restored",
    project: "github.com/acme/restored",
    projectRoot: "/repos/restored",
    association: { tier: 1, confidence: "git", reason: "restored checkout" },
  };
  const memoryHash = "sha256:memory";
  state.writeEvidence(transcript, {
    status: "ok",
    transcript: {
      harness: "codex",
      id: transcript.id,
      identity: "codex:robot-1",
      cwd: "/repos/deleted",
      project: "github.com/acme/restored",
      projectRoot: null,
      association: { tier: 2, confidence: "remote", reason: "checkout absent" },
    },
    memoryHash,
    memoryPath: "AGENTS.md",
    key: evidenceKey(transcript, memoryHash),
    positive: [],
    negative: [],
    gaps: [],
  });

  const summary = await analyzeTranscripts({
    transcripts: [transcript],
    memoryFile: { path: "AGENTS.md" },
    config: {
      state,
      jobs: 1,
      agents: { resolve: () => assert.fail("a fresh cache record should not invoke an agent") },
    },
    repo: { root: dir },
    memoryHash,
  });

  assert.deepEqual([summary.cached, summary.analyzed], [1, 0]);
  const [upgraded] = state.listEvidence();
  assert.equal(upgraded.transcript.interaction, NON_INTERACTIVE);
  assert.equal(upgraded.transcript.cwd, transcript.cwd);
  assert.equal(upgraded.transcript.project, transcript.project);
  assert.equal(upgraded.transcript.projectRoot, transcript.projectRoot);
  assert.deepEqual(upgraded.transcript.association, transcript.association);
  assert.equal(upgraded.transcript.startedAt, transcript.startedAt);
  assert.deepEqual(foldEvidence([upgraded]).analyzedByInteraction, {
    [INTERACTIVE]: 0,
    [NON_INTERACTIVE]: 1,
  });
});

test("fold excludes legacy evidence without an interaction category", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-mix-fold-cache-"));
  const state = new State(dir).ensure();
  const transcript = {
    harness: "codex",
    id: "codex-robot-outside-window",
    nativeId: "robot-outside-window",
    path: "/sessions/robot-outside-window.jsonl",
    mtimeMs: 100,
    bytes: 200,
  };
  const memoryHash = "sha256:memory";
  state.writeEvidence(transcript, {
    status: "ok",
    transcript: { harness: "codex", id: transcript.id, path: transcript.path },
    memoryHash,
    memoryPath: "AGENTS.md",
    key: evidenceKey(transcript, memoryHash),
    positive: [{ instruction: "AG-001", quote: "followed the repository rule exactly" }],
    negative: [],
    gaps: [],
  });

  const summary = await foldForRun(
    {
      repo: { root: dir },
      config: { state, minGapEvidence: 2, gapLedgerMaxAge: "90d" },
    },
    { path: "AGENTS.md", text: "", units: [] },
    memoryHash,
    [],
    [transcript],
  );

  assert.equal(summary.analyzedSessions, 0);
  assert.deepEqual(summary.analyzedByInteraction, {
    [INTERACTIVE]: 0,
    [NON_INTERACTIVE]: 0,
  });
  assert.equal(state.readEvidence(transcript).transcript.interaction, undefined);
});

test("fold selection distinguishes colliding native IDs by source", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-mix-identity-fold-"));
  const state = new State(dir).ensure();
  const memoryHash = "sha256:memory";
  const shared = {
    harness: "claude",
    id: "claude-shared",
    nativeId: "shared",
    mtimeMs: 100,
    bytes: 200,
    interaction: INTERACTIVE,
  };
  const selected = { ...shared, path: "/sessions/a.jsonl" };
  const unselected = { ...shared, path: "/sessions/b.jsonl" };
  for (const transcript of [selected, unselected]) {
    state.writeEvidence(transcript, {
      status: "ok",
      transcript,
      memoryHash,
      memoryPath: "AGENTS.md",
      key: evidenceKey(transcript, memoryHash),
      positive: [],
      negative: [],
      gaps: [],
    });
  }
  const observedAt = new Date().toISOString();
  const observation = (source) => ({
    firstObservedAt: observedAt,
    observedAt,
    source,
    quote: `${source} used production`,
    domain: "project",
  });
  state.writeGapLedger({
    version: 1,
    entries: {
      collision: {
        id: "collision",
        memoryPath: "AGENTS.md",
        proposedInstruction: "Always use the scratch database.",
        phrasings: ["Always use the scratch database."],
        sessions: {
          [transcriptIdentity(selected)]: observation("selected"),
          [selected.id]: observation("unselected legacy id"),
        },
      },
    },
  });

  const summary = await foldForRun(
    {
      repo: { root: dir },
      config: { state, minGapEvidence: 2, gapLedgerMaxAge: "90d" },
    },
    { path: "AGENTS.md", text: "", units: [] },
    memoryHash,
    [],
    [selected],
  );

  assert.equal(summary.analyzedSessions, 1);
  assert.equal(summary.gaps.length, 0);
});

test("fold keeps legacy-id gap observations for sessions in the selected sample", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-mix-legacy-gap-"));
  const state = new State(dir).ensure();
  const memoryHash = "sha256:memory";
  const transcripts = ["one", "two"].map((id) => ({
    harness: "claude",
    id: `claude-${id}`,
    identity: `canonical:${id}`,
    path: `/sessions/${id}.jsonl`,
    mtimeMs: 100,
    bytes: 200,
    interaction: INTERACTIVE,
  }));
  for (const transcript of transcripts) {
    state.writeEvidence(transcript, {
      status: "ok",
      transcript,
      memoryHash,
      memoryPath: "AGENTS.md",
      key: evidenceKey(transcript, memoryHash),
      positive: [],
      negative: [],
      gaps: [],
    });
  }

  const observedAt = new Date().toISOString();
  state.writeGapLedger({
    version: 1,
    entries: {
      legacy: {
        id: "legacy",
        memoryPath: "AGENTS.md",
        proposedInstruction: "Always use the scratch database.",
        phrasings: ["Always use the scratch database."],
        sessions: Object.fromEntries(
          transcripts.map((transcript) => [
            transcript.id,
            {
              firstObservedAt: observedAt,
              observedAt,
              source: transcript.id,
              quote: `${transcript.id} used production`,
              domain: "project",
            },
          ]),
        ),
      },
    },
  });

  const summary = await foldForRun(
    {
      repo: { root: dir },
      config: { state, minGapEvidence: 2, gapLedgerMaxAge: "90d" },
    },
    { path: "AGENTS.md", text: "", units: [] },
    memoryHash,
    [],
    transcripts,
  );

  assert.equal(summary.analyzedSessions, 2);
  assert.equal(summary.gaps.length, 1);
  assert.equal(summary.gaps[0].sessions, 2);
});

test("fold bounds evidence and ledger observations to the selected sample", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-mix-selected-fold-"));
  const state = new State(dir).ensure();
  const memoryHash = "sha256:memory";
  const memoryFile = { path: "AGENTS.md", text: "", units: [] };
  const ctx = {
    repo: { root: dir },
    config: { state, minGapEvidence: 2, gapLedgerMaxAge: "90d" },
  };
  const writeRecord = (id, interaction, gaps = []) => {
    const transcript = {
      harness: "claude",
      id: `claude-${id}`,
      identity: `claude:${id}`,
      path: `/sessions/${id}.jsonl`,
      mtimeMs: 100,
      bytes: 200,
      interaction,
    };
    state.writeEvidence(transcript, {
      status: "ok",
      transcript,
      memoryHash,
      memoryPath: "AGENTS.md",
      key: evidenceKey(transcript, memoryHash),
      positive: [],
      negative: [],
      gaps,
    });
    return transcript;
  };
  const stale = Array.from({ length: 20 }, (_, i) =>
    writeRecord(`stale-robot-${i}`, NON_INTERACTIVE, [
      {
        proposedInstruction: "Always use the scratch database.",
        mistake: "used production",
        quote: `stale robot ${i} used the production database`,
        recurrenceRisk: "high",
      },
    ]),
  );
  await foldForRun(ctx, memoryFile, memoryHash, [], stale);

  const selected = [
    ...Array.from({ length: 2 }, (_, i) => writeRecord(`human-${i}`, INTERACTIVE)),
    ...Array.from({ length: 8 }, (_, i) => writeRecord(`robot-${i}`, NON_INTERACTIVE)),
  ];
  const summary = await foldForRun(ctx, memoryFile, memoryHash, [], selected);

  assert.equal(summary.analyzedSessions, 10);
  assert.deepEqual(summary.analyzedByInteraction, {
    [INTERACTIVE]: 2,
    [NON_INTERACTIVE]: 8,
  });
  assert.equal(summary.gaps.length, 0);
  assert.equal(Object.keys(state.readGapLedger().entries).length, 1);
});

test("fold freshness uses the selected transcript's current content signature", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-mix-current-signature-"));
  const state = new State(dir).ensure();
  const memoryHash = "sha256:memory";
  const memoryFile = { path: "AGENTS.md", text: "", units: [] };
  const stored = {
    harness: "claude",
    id: "claude-session",
    identity: "claude:session",
    path: "/sessions/session.jsonl",
    mtimeMs: 100,
    bytes: 200,
    interaction: INTERACTIVE,
  };
  state.writeEvidence(stored, {
    status: "ok",
    transcript: stored,
    memoryHash,
    memoryPath: "AGENTS.md",
    key: evidenceKey(stored, memoryHash),
    positive: [{ instruction: "AG-001", quote: "followed the old transcript evidence" }],
    negative: [],
    gaps: [],
  });
  const current = { ...stored, mtimeMs: 101, bytes: 240 };
  const summary = await foldForRun(
    { repo: { root: dir }, config: { state, minGapEvidence: 2, gapLedgerMaxAge: "90d" } },
    memoryFile,
    memoryHash,
    [],
    [current],
  );

  assert.equal(summary.analyzedSessions, 0);
  assert.equal(summary.totals.positive, 0);
});

test("evidence records carry the category and fold reports relevance per category", async () => {
  const repo = initRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-mix-ev-"));
  writeClaude(home, { id: "human-1", cwd: repo, entrypoint: "cli" });
  writeClaude(home, { id: "robot-1", cwd: repo, entrypoint: "sdk-cli" });
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const config = loadConfig(repo);
    config.state = new State(repo).ensure();
    const { transcripts } = await discoverTranscripts({
      repo: { name: "demo", root: repo, worktrees: [repo], remotes: [] },
      config,
    });
    const human = transcripts.find((t) => t.interaction === INTERACTIVE);
    const robot = transcripts.find((t) => t.interaction === NON_INTERACTIVE);
    assert.ok(human && robot);

    const summary = foldEvidence([
      {
        status: "ok",
        transcript: { id: human.id, harness: "claude", interaction: human.interaction },
        positive: [{ instruction: "AG-001", quote: "kept the PR small enough" }],
        negative: [],
        gaps: [],
      },
      {
        status: "ok",
        transcript: { id: robot.id, harness: "claude", interaction: robot.interaction },
        positive: [],
        negative: [],
        gaps: [],
      },
    ]);
    assert.deepEqual(summary.analyzedByInteraction, { [INTERACTIVE]: 1, [NON_INTERACTIVE]: 1 });
    const row = summary.instructions.find((item) => item.instruction === "AG-001");
    assert.equal(row.relevance, 0.5);
    assert.equal(row.relevanceByInteraction[INTERACTIVE], 1);
    assert.equal(row.relevanceByInteraction[NON_INTERACTIVE], 0);
    assert.match(renderEvidenceForPrompt(summary), /relevance=50\.0% \(interactive 100\.0% · non-interactive 0\.0%\)/);
  } finally {
    process.env.HOME = prevHome;
  }
});

test("the sampler keeps both categories when a 98% non-interactive corpus exceeds the cap", () => {
  const interactive = Array.from({ length: 2 }, (_, i) => ({
    harness: "claude",
    id: `human-${i}`,
    interaction: INTERACTIVE,
    startedAt: NOW - i * DAY,
  }));
  const robots = Array.from({ length: 98 }, (_, i) => ({
    harness: "claude",
    id: `robot-${i}`,
    interaction: NON_INTERACTIVE,
    startedAt: NOW - i * DAY,
  }));
  const set = [...interactive, ...robots];
  const kept = sampleTranscripts(set, 20, { seed: 1, now: NOW });
  assert.equal(kept.length, 20);
  const keptInteractive = kept.filter((t) => t.interaction === INTERACTIVE);
  const keptRobots = kept.filter((t) => t.interaction === NON_INTERACTIVE);
  assert.equal(keptInteractive.length, 2, "both interactive sessions survive a 20-slot cap");
  assert.equal(keptRobots.length, 18);
  assert.deepEqual(keptInteractive.map((t) => t.id).sort(), ["human-0", "human-1"]);

  const lines = [];
  setLoggerSink((line) => lines.push(line));
  try {
    const config = loadConfig(initRepo(), { maxTranscripts: 20, seed: 3 });
    capTranscripts({ transcripts: set, perHarness: {} }, config, { now: NOW });
  } finally {
    setLoggerSink(null);
  }
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /analyzing a recency-weighted sample of 20 \(--max-transcripts\) · interactive 2 · non-interactive 18/,
  );
});
