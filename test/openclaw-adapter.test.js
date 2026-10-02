import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";
import zlibRuntime from "node:zlib";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { SELF_SESSION_SENTINEL } from "../src/sentinel.js";
import { DatabaseSync } from "node:sqlite";
import * as openclaw from "../src/discovery/adapters/openclaw.js";
import { classifyInteraction } from "../src/interaction.js";
import { transcriptIdentity } from "../src/transcript.js";
import { emptyGapLedger, recordGapObservations } from "../src/gap-ledger.js";
import { ADAPTERS, capInferred, discoverTranscripts } from "../src/discovery/index.js";
import { loadConfig } from "../src/config.js";
import { resolveScope } from "../src/scope.js";
import { main } from "../src/cli.js";
import { distill } from "../src/distill.js";
import { buildFixture, timestamp } from "./fixtures/openclaw/build.js";

function setEnv(t, key, value) {
  const previous = process.env[key];
  if (value == null) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-openclaw-test-"));
  setEnv(t, "HOME", dir);
  setEnv(t, "OPENCLAW_AGENT", "main");
  setEnv(t, "OPENCLAW_STATE_DIR", null);
  const file = path.join(dir, "database.sqlite");
  setEnv(t, "BACKPASS_OPENCLAW_DB", file);
  buildFixture(file);
  t.after(() => {
    openclaw.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, file };
}

test("openclaw discovers live and archive generations, excludes probes and overlap, and resolves cwd", async (t) => {
  const { dir } = setup(t);
  fs.mkdirSync(path.join(dir, ".openclaw"));
  fs.writeFileSync(
    path.join(dir, ".openclaw/openclaw.json"),
    JSON.stringify({
      agents: { defaults: { workspace: "/synthetic/default" }, list: [{ id: "main", workspace: "/synthetic/agent" }] },
    }),
  );
  const rows = await openclaw.discover();
  const dashboard = rows.find((r) => r.extra.sessionId === "dashboard");
  assert.equal(dashboard.cwd, "/synthetic/metadata");
  assert.equal(dashboard.startedAt, timestamp);
  const fallback = rows.find((r) => r.extra.sessionId === "fallback");
  assert.equal(fallback.cwd, "/synthetic/agent");
  assert.equal(fallback.extra.cwdSource, "configured-workspace");
  assert.equal(rows.find((r) => r.extra.sessionId === "slack").cwd, "/synthetic/header");
  assert.equal(rows.filter((r) => r.extra.sessionId === "archive").length, 1);
  assert.equal(rows.filter((r) => r.extra.sessionId === "dashboard").length, 1);
  assert.ok(
    !rows.some((r) =>
      /^(test|bakeoff|content-lane-eval|explicit|pra\d+-|internal-session-effects|memory-health-probe|routing-smoke|r3-routing)/.test(
        r.extra.sessionKey.split(":")[2],
      ),
    ),
  );
  assert.deepEqual(await openclaw.discover({ cutoffMs: timestamp + 10000 }), []);
});

test("openclaw classifies human channels and automated keys through shared interaction signals", async (t) => {
  setup(t);
  const rows = await openclaw.discover();
  for (const row of rows) {
    const expected = /^(cron|subagent|heartbeat|acp|hook)/.test(row.extra.sessionKey.split(":")[2])
      ? "non-interactive"
      : "interactive";
    assert.equal(classifyInteraction({ ...row, harness: "openclaw" }), expected, row.extra.sessionKey);
  }
});

test("openclaw strips injected context, drops system turns and stale branches, and folds tools", async (t) => {
  setup(t);
  const row = (await openclaw.discover()).find((r) => r.extra.sessionId === "dashboard");
  const { events } = await openclaw.read(row);
  assert.deepEqual(
    events.filter((e) => e.kind === "message").map((e) => e.text),
    ["Keep my actual words.", "Verbatim answer."],
  );
  assert.deepEqual(
    events.find((e) => e.kind === "tool"),
    { kind: "tool", name: "read", input: { path: "demo.txt" }, result: "synthetic result", status: "error" },
  );
  assert.doesNotMatch(
    distill(events, { ...row, harness: "openclaw" }).trace,
    /OPENCLAW_INTERNAL_CONTEXT|bootstrap|Stale branch/,
  );
});

test("openclaw decodes identity and zstd archives and compressed live events", async (t) => {
  setup(t);
  const rows = await openclaw.discover();
  const row = rows.find((r) => r.extra.sessionId === "archive");
  assert.equal((await openclaw.read(row)).events[0].text, "Archived human request.");
  if (typeof zlib.zstdDecompressSync === "function") {
    for (const [id, text] of [
      ["compressed", "Compressed human request."],
      ["compressed-live", "Compressed live request."],
    ]) {
      const found = rows.find((r) => r.extra.sessionId === id);
      assert.ok(found, id);
      assert.equal((await openclaw.read(found)).events[0].text, text);
    }
  } else assert.ok(!rows.some((r) => r.extra.sessionId === "compressed"));
});

test("openclaw missing and drifted stores fail soft with named warnings", async (t) => {
  const { file } = setup(t);
  const warnings = [];
  t.mock.method(console, "error", (...args) => warnings.push(args.join(" ")));
  fs.rmSync(file);
  assert.deepEqual(await openclaw.discover(), []);
  assert.match(warnings.join("\n"), /openclaw.*snapshot/i);
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE wrong (id TEXT)");
  db.close();
  assert.deepEqual(await openclaw.discover(), []);
  assert.match(warnings.join("\n"), /openclaw.*unreadable/i);
  assert.deepEqual((await openclaw.read({ path: file, extra: { sessionId: "absent" } })).events, []);
});

test("openclaw P1-4 live-to-archive identity and duplicate generations preserve one gap sighting", async (t) => {
  const { file } = setup(t);
  const before = (await openclaw.discover()).find((r) => r.extra.sessionId === "slack");
  const db = new DatabaseSync(file);
  const entries = db.prepare("SELECT event_json FROM transcript_events WHERE session_id='slack' ORDER BY seq").all();
  const bytes = Buffer.from(entries.map((r) => r.event_json).join("\n"));
  const insert = db.prepare(
    "INSERT INTO session_transcript_archives VALUES ('slack', ?, 'agent:main:slack', 'deleted', 'identity', ?, ?)",
  );
  insert.run("generation-1", bytes, timestamp + 2000);
  insert.run("generation-2", bytes, timestamp + 3000);
  db.exec("DELETE FROM session_windows WHERE session_id='slack'");
  const after = (await openclaw.discover()).filter((r) => r.extra.sessionId === "slack");
  assert.equal(after.length, 1);
  assert.match(before.id, /^slack:[0-9a-f]{64}$/);
  const identity = (row) => transcriptIdentity({ ...row, harness: "openclaw", nativeId: row.id });
  assert.equal(identity(before), identity(after[0]));
  assert.equal(identity(before), identity({ ...after[0], path: "/relocated/database.sqlite" }));
  const ledger = emptyGapLedger();
  for (const row of [before, after[0]])
    recordGapObservations(ledger, [
      {
        status: "ok",
        memoryPath: "AGENTS.md",
        transcript: { ...row, identity: identity(row), harness: "openclaw" },
        gaps: [{ proposedInstruction: "Read the setup guide.", quote: "Human request." }],
      },
    ]);
  assert.equal(Object.keys(Object.values(ledger.entries)[0].sessions).length, 1);
  insert.run(
    "generation-3",
    Buffer.from(bytes.toString().replace("Human request.", "A genuinely different request.")),
    timestamp + 4000,
  );
  db.close();
  const distinct = (await openclaw.discover()).filter((r) => r.extra.sessionId === "slack");
  assert.equal(distinct.length, 2);
  assert.equal(identity(distinct[0]), identity(before));
  assert.notEqual(identity(distinct[0]), identity(distinct[1]));
});

test("openclaw creates one private snapshot per run and cleans only owned snapshots", async (t) => {
  const { file } = setup(t);
  setEnv(t, "BACKPASS_OPENCLAW_DB", null);
  setEnv(t, "OPENCLAW_AGENT", "other");
  let calls = 0;
  let directory;
  const run = async (bin, args) => {
    calls++;
    assert.equal(bin, "openclaw");
    assert.deepEqual(args.slice(0, 5), ["backup", "sqlite", "create", "--agent", "other"]);
    directory = args[6];
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    const snapshotPath = path.join(directory, "snapshot");
    fs.mkdirSync(snapshotPath);
    fs.copyFileSync(file, path.join(snapshotPath, "database.sqlite"));
    return {
      code: 0,
      stdout: JSON.stringify({ snapshotPath, manifest: { artifact: { path: "database.sqlite" } } }),
      stderr: "",
    };
  };
  const [one, two] = await Promise.all([openclaw.resolveSnapshot({ run }), openclaw.resolveSnapshot({ run })]);
  assert.equal(one, two);
  assert.equal(calls, 1);
  assert.ok(fs.existsSync(one));
  openclaw.cleanup();
  assert.ok(!fs.existsSync(directory));
  assert.ok(fs.existsSync(file));
  await openclaw.resolveSnapshot({ run });
  assert.equal(calls, 2);
});

test("openclaw backup errors, timeout and shim refusal warn once and never open a store", async (t) => {
  setup(t);
  setEnv(t, "BACKPASS_OPENCLAW_DB", null);
  const warnings = [];
  t.mock.method(console, "error", (...args) => warnings.push(args.join(" ")));
  for (const result of [
    { code: 1 },
    { code: null, spawnError: Object.assign(new Error("denied"), { code: "EACCES" }) },
    { code: 0, timedOut: true },
    { code: null, spawnError: Object.assign(new Error("unsafe argument"), { code: "ERR_WINDOWS_SHIM_UNSAFE_ARG" }) },
    { code: 0, stdout: "not json" },
    { code: 0, stdout: JSON.stringify({ snapshotPath: "/outside", manifest: { artifact: { path: "missing" } } }) },
  ]) {
    openclaw.cleanup();
    let calls = 0;
    const run = async () => {
      calls++;
      return { stdout: "", stderr: "", ...result };
    };
    assert.equal(await openclaw.resolveSnapshot({ run }), null);
    assert.equal(await openclaw.resolveSnapshot({ run }), null);
    assert.equal(calls, 1);
  }
  assert.match(warnings.join("\n"), /failed \(1\)/);
  assert.match(warnings.join("\n"), /EACCES/);
  assert.match(warnings.join("\n"), /timed out/);
  assert.match(warnings.join("\n"), /ERR_WINDOWS_SHIM_UNSAFE_ARG/);
});

test("openclaw an absent openclaw binary is an empty harness with no warning", async (t) => {
  setup(t);
  setEnv(t, "BACKPASS_OPENCLAW_DB", null);
  const warnings = [];
  t.mock.method(console, "error", (...args) => warnings.push(args.join(" ")));
  let calls = 0;
  let directory;
  const run = async (bin, args) => {
    calls++;
    directory = args[6];
    return {
      code: null,
      stdout: "",
      stderr: "",
      spawnError: Object.assign(new Error("not found"), { code: "ENOENT" }),
    };
  };
  assert.equal(await openclaw.resolveSnapshot({ run }), null);
  assert.deepEqual(await openclaw.discover(), []);
  assert.equal(calls, 1);
  assert.deepEqual(warnings, []);
  assert.ok(!fs.existsSync(directory));
});

test("openclaw corrupt archives skip independently and other agents are not collected", async (t) => {
  const { file } = setup(t);
  const warnings = [];
  t.mock.method(console, "error", (...args) => warnings.push(args.join(" ")));
  const db = new DatabaseSync(file);
  db.prepare("UPDATE session_transcript_archives SET archive_blob = ? WHERE session_id = 'archive'").run(
    Buffer.from("broken json"),
  );
  db.close();
  const rows = await openclaw.discover();
  assert.ok(rows.some((r) => r.extra.sessionId === "dashboard"));
  assert.ok(!rows.some((r) => r.extra.sessionId === "archive"));
  assert.match(warnings.join("\n"), /2 session\(s\) skipped/);
  setEnv(t, "OPENCLAW_AGENT", "other");
  assert.deepEqual(await openclaw.discover(), []);
});

test("openclaw wrapper stripping preserves ordinary text, repeated blocks and timestamp-like prose", () => {
  const human = "  Keep whitespace and `code`.\nNext line.  ";
  assert.equal(openclaw.stripScaffolding(human), human);
  assert.equal(
    openclaw.stripScaffolding("Discuss [Sun 2026-09-27 21:24 EDT] tomorrow."),
    "Discuss [Sun 2026-09-27 21:24 EDT] tomorrow.",
  );
  assert.equal(
    openclaw.stripScaffolding(
      "<active_memory_plugin>one</active_memory_plugin><active_memory_plugin>two</active_memory_plugin>Human",
    ),
    "Human",
  );
});

test("openclaw missing zstd support skips compressed sessions without breaking identity archives", async (t) => {
  setup(t);
  const warnings = [];
  t.mock.method(console, "error", (...args) => warnings.push(args.join(" ")));
  const saved = zlibRuntime.zstdDecompressSync;
  try {
    zlibRuntime.zstdDecompressSync = undefined;
    syncBuiltinESMExports();
    const rows = await openclaw.discover();
    assert.ok(rows.some((r) => r.extra.sessionId === "archive"));
    assert.ok(!rows.some((r) => r.extra.sessionId.startsWith("compressed")));
    assert.match(warnings.join("\n"), /zstd decompression unavailable/);
  } finally {
    zlibRuntime.zstdDecompressSync = saved;
    syncBuiltinESMExports();
  }
});

test("openclaw defaults cwd, preserves text spacing and excludes its own prompts after stripping", async (t) => {
  const { file, dir } = setup(t);
  const rows = await openclaw.discover();
  assert.equal(rows.find((r) => r.extra.sessionId === "fallback").cwd, path.join(dir, ".openclaw/workspace"));
  const db = new DatabaseSync(file);
  const event = { type: "message", message: { role: "user", content: [{ type: "text", text: "  Human words.\n  " }] } };
  db.prepare("UPDATE transcript_events SET event_json=? WHERE session_id='fallback'").run(JSON.stringify(event));
  assert.equal(
    (await openclaw.read(rows.find((r) => r.extra.sessionId === "fallback"))).events[0].text,
    "  Human words.\n  ",
  );
  const prompt = `${SELF_SESSION_SENTINEL}\nself analysis`;
  const update = (text) => {
    event.message.content[0].text = text;
    db.prepare("UPDATE transcript_events SET event_json=? WHERE session_id='fallback'").run(JSON.stringify(event));
  };
  const kept = async () => (await openclaw.discover()).some((r) => r.extra.sessionId === "fallback");
  update(prompt);
  assert.equal(await kept(), false);
  update("<active_memory_plugin>injected</active_memory_plugin>\n" + prompt);
  assert.equal(await kept(), false, "the sentinel right after a closed wrapper is Backpass's own prompt");
  // A quoted sentinel is human text: nothing before it is cut, so these sessions stay in the corpus.
  for (const wrapper of [
    "Why does backpass prepend ",
    "<active_memory_plugin>unclosed injected memory\n",
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>unclosed context\n",
  ]) {
    update(wrapper + prompt);
    assert.equal(await kept(), true, wrapper);
  }
  db.close();
});

test("openclaw P1-1 excludes tokenized eval namespaces and prefers typed routing over key fallback", async (t) => {
  const { file } = setup(t);
  const db = new DatabaseSync(file);
  db.exec(`UPDATE session_nodes SET created_via='spawn' WHERE current_session_id='dashboard';
    UPDATE session_nodes SET created_via='run' WHERE current_session_id='fallback';
    UPDATE session_nodes SET spawned_by='parent' WHERE current_session_id='discord';
    UPDATE session_nodes SET parent_session_key='parent' WHERE current_session_id='telegram';
    UPDATE session_nodes SET created_via='cron' WHERE current_session_id='webchat';
    UPDATE session_nodes SET created_via='operator' WHERE current_session_id='acp:child';
    UPDATE session_windows SET channel='slack', chat_type='channel' WHERE session_id='subagent:child';
    UPDATE session_windows SET chat_type='direct' WHERE session_id IN ('hook:gmail', 'dashboard');
    UPDATE session_windows SET spawned_by='parent' WHERE session_id='signal:direct:person';
    UPDATE session_windows SET parent_session_key='parent' WHERE session_id='slack';`);
  db.close();
  const rows = await openclaw.discover();
  const byId = new Map(rows.map((r) => [r.extra.sessionId, r]));
  for (const id of [
    "routing-smoke-fable-20260715",
    "r3-routing-muse-smoke-20260910",
    "r3-routing-fable-review-20260910",
    "pra290-router-main-interactive",
    "pra373-review-case",
  ])
    assert.ok(!byId.has(id), id);
  for (const id of ["fallback", "dashboard", "discord", "telegram", "webchat", "signal:direct:person", "slack"])
    assert.equal(classifyInteraction({ ...byId.get(id), harness: "openclaw" }), "non-interactive", id);
  for (const id of ["retrieval", "evaluation", "slack:channel:eval", "acp:child", "subagent:child", "hook:gmail"]) {
    assert.ok(byId.has(id), id);
    assert.equal(classifyInteraction({ ...byId.get(id), harness: "openclaw" }), "interactive", id);
  }
});

test("openclaw P1-2 gateway state-root headers fall through to labelled configured workspace", async (t) => {
  const { file, dir } = setup(t);
  const db = new DatabaseSync(file);
  const update = db.prepare("UPDATE transcript_events SET event_json=? WHERE session_id='slack' AND seq=0");
  for (const stateRoot of [path.join(dir, ".openclaw"), path.join(dir, "custom-state")]) {
    setEnv(t, "OPENCLAW_STATE_DIR", stateRoot);
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(
      path.join(stateRoot, "openclaw.json"),
      JSON.stringify({ agents: { defaults: { workspace: "/synthetic/configured" } } }),
    );
    update.run(JSON.stringify({ type: "session", cwd: stateRoot + "/", timestamp }));
    const rows = await openclaw.discover();
    const row = rows.find((r) => r.extra.sessionId === "slack");
    assert.equal(row.cwd, "/synthetic/configured");
    assert.equal(row.extra.cwdSource, "configured-workspace");
    assert.equal(rows.find((r) => r.extra.sessionId === "dashboard").extra.cwdSource, "session-metadata");
  }
  update.run(JSON.stringify({ type: "session", cwd: "/other/project/worktree", timestamp }));
  db.close();
  assert.equal((await openclaw.discover()).find((r) => r.extra.sessionId === "slack").cwd, "/other/project/worktree");
});

test("openclaw P1-3 archived since uses newest event activity, with archive time only when undated", async (t) => {
  const { file } = setup(t);
  const db = new DatabaseSync(file);
  db.exec(`UPDATE session_transcript_archives SET created_at=${timestamp + 100000} WHERE session_id='archive'`);
  assert.ok(!(await openclaw.discover({ cutoffMs: timestamp + 5000 })).some((r) => r.extra.sessionId === "archive"));
  const entries = [
    { type: "session", timestamp },
    {
      type: "message",
      timestamp: new Date(timestamp + 6000).toISOString(),
      message: { role: "user", content: "Later activity." },
    },
  ];
  db.prepare("UPDATE session_transcript_archives SET archive_blob=? WHERE session_id='archive'").run(
    Buffer.from(entries.map((e) => JSON.stringify(e)).join("\n")),
  );
  assert.equal(
    (await openclaw.discover({ cutoffMs: timestamp + 5000 })).find((r) => r.extra.sessionId === "archive").mtimeMs,
    timestamp + 6000,
  );
  delete entries[0].timestamp;
  delete entries[1].timestamp;
  db.prepare("UPDATE session_transcript_archives SET archive_blob=? WHERE session_id='archive'").run(
    Buffer.from(entries.map((e) => JSON.stringify(e)).join("\n")),
  );
  db.close();
  assert.equal(
    (await openclaw.discover({ cutoffMs: timestamp + 5000 })).find((r) => r.extra.sessionId === "archive").mtimeMs,
    timestamp + 100000,
  );
});

test("openclaw P2-6 unterminated internal context preserves the remaining human turn verbatim", () => {
  const human = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>truncated context\n\nPlease keep these human words.";
  assert.equal(openclaw.stripScaffolding(human), human);
  assert.equal(
    openclaw.stripScaffolding(
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>complete<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\n" + human,
    ),
    human,
  );
});

test("openclaw an unclosed active memory block drops only its opening tag and keeps the words that follow", () => {
  const human = "<active_memory_plugin>truncated memory\n\nPlease keep these human words.";
  const kept = "truncated memory\n\nPlease keep these human words.";
  assert.equal(openclaw.stripScaffolding(human), kept);
  assert.equal(openclaw.stripScaffolding("<active_memory_plugin>complete</active_memory_plugin>\n" + human), kept);
});

test("openclaw a quoted self sentinel after an unclosed wrapper keeps every preceding character", () => {
  const prompt = `${SELF_SESSION_SENTINEL}\nself analysis`;
  const closed = "<active_memory_plugin>complete</active_memory_plugin>\n";
  for (const opener of [
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>truncated context\n  I asked about ",
    'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"id":"synthetic"}\n  I asked about ',
  ]) {
    assert.equal(openclaw.stripScaffolding(opener + prompt), opener + prompt);
    assert.equal(openclaw.stripScaffolding(closed + opener + prompt), opener + prompt);
  }
  const memory = "<active_memory_plugin>truncated memory\n  I asked about ";
  const remainder = memory.slice("<active_memory_plugin>".length) + prompt;
  assert.equal(openclaw.stripScaffolding(memory + prompt), remainder);
  assert.equal(openclaw.stripScaffolding(closed + memory + prompt), remainder);
  // Only a closed leading wrapper leaves the sentinel first.
  assert.equal(openclaw.stripScaffolding(closed + prompt), prompt);
  assert.equal(openclaw.stripScaffolding("Human quotes " + prompt), "Human quotes " + prompt);
});

test("openclaw a Backpass session behind an unclosed wrapper is still excluded by the state-dir cwd check", async (t) => {
  const { file, dir } = setup(t);
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(dir, "repo-")));
  const config = loadConfig(repoRoot, { discovery: { harnesses: ["openclaw"], since: "all" } });
  const cache = { version: 1, entries: {} };
  config.state = { root: path.join(repoRoot, ".backpass"), readScanCache: () => cache, writeScanCache: () => {} };
  const repo = { name: "demo", root: repoRoot, worktrees: [repoRoot], remotes: [] };
  const db = new DatabaseSync(file);
  const text = `<active_memory_plugin>unclosed injected memory\n${SELF_SESSION_SENTINEL}\nself analysis`;
  const event = { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
  for (const id of ["fallback", "slack"])
    db.prepare(
      "UPDATE transcript_events SET event_json=? WHERE session_id=? AND seq=(SELECT MAX(seq) FROM transcript_events WHERE session_id=?)",
    ).run(JSON.stringify(event), id, id);
  // Both sessions belong to the repo; Backpass runs its own harness sessions with cwd inside its
  // state dir (the synthesis staging copy), which is what distinguishes them.
  const workspace = (id, cwd) =>
    db
      .prepare("UPDATE session_nodes SET entry_json=? WHERE current_session_id=?")
      .run(JSON.stringify({ systemPromptReport: { workspaceDir: cwd } }), id);
  workspace("slack", repoRoot);
  workspace("fallback", path.join(config.state.root, "synthesis"));
  db.close();
  const { transcripts, perHarness } = await discoverTranscripts({ repo, config });
  const ids = transcripts.map((transcript) => transcript.extra.sessionId);
  assert.ok(!ids.includes("fallback"), "Backpass's own session is excluded by cwd");
  assert.ok(ids.includes("slack"), "a human session quoting the sentinel after an unclosed wrapper is kept");
  assert.equal(perHarness.openclaw.self, 1);
});

test("openclaw a session with no recorded cwd is capped at best-effort tier 3 and dropped by --strict", async (t) => {
  const { file, dir } = setup(t);
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(dir, "repo-")));
  // The configured workspace IS the repo, so the guessed cwd would otherwise reach tier 1.
  fs.mkdirSync(path.join(dir, ".openclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".openclaw/openclaw.json"),
    JSON.stringify({ agents: { defaults: { workspace: repoRoot } } }),
  );
  const config = loadConfig(repoRoot, { discovery: { harnesses: ["openclaw"], since: "all" } });
  const cache = { version: 1, entries: {} };
  config.state = { root: path.join(repoRoot, ".backpass"), readScanCache: () => cache, writeScanCache: () => {} };
  const repo = { name: "demo", root: repoRoot, worktrees: [repoRoot], remotes: [] };
  const db = new DatabaseSync(file);
  db.prepare("UPDATE session_nodes SET entry_json=? WHERE current_session_id='dashboard'").run(
    JSON.stringify({ systemPromptReport: { workspaceDir: repoRoot } }),
  );
  db.close();
  const rows = await openclaw.discover();
  assert.equal(rows.find((r) => r.extra.sessionId === "fallback").cwdInferred, true);
  assert.equal(rows.find((r) => r.extra.sessionId === "dashboard").cwdInferred, false);

  const scope = resolveScope(repoRoot, { scope: "project" }, config, repo);
  const loose = await discoverTranscripts({ repo, config, scope });
  const byId = (list, id) => list.transcripts.find((transcript) => transcript.extra.sessionId === id);
  assert.equal(byId(loose, "dashboard").association.tier, 1, "a recorded cwd keeps its deterministic tier");
  const guessed = byId(loose, "fallback").association;
  assert.equal(guessed.tier, 3);
  assert.equal(guessed.confidence, "inferred");
  assert.match(guessed.reason, /^inferred cwd/);
  assert.equal(guessed.project, repoRoot, "the cap keeps the scope's project");
  assert.equal(guessed.projectRoot, repoRoot);
  assert.equal(byId(loose, "fallback").project, repoRoot);

  const strict = await discoverTranscripts({ repo, config, scope, strict: true });
  assert.ok(byId(strict, "dashboard"), "--strict keeps the recorded-cwd session");
  assert.equal(byId(strict, "fallback"), undefined, "--strict drops the inferred-cwd session");
});

test("openclaw an inferred cwd stays tier 3 inferred under user scope even when the workspace is a git toplevel", async (t) => {
  const { file, dir } = setup(t);
  setEnv(t, "XDG_CONFIG_HOME", path.join(dir, ".config"));
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(dir, "repo-")));
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "test"],
    ["commit", "--allow-empty", "-q", "-m", "init"],
  ])
    execFileSync("git", args, { cwd: repoRoot, stdio: "ignore" });
  fs.mkdirSync(path.join(dir, ".openclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".openclaw/openclaw.json"),
    JSON.stringify({ agents: { defaults: { workspace: repoRoot } } }),
  );
  const db = new DatabaseSync(file);
  db.prepare("UPDATE session_nodes SET entry_json=? WHERE current_session_id='dashboard'").run(
    JSON.stringify({ systemPromptReport: { workspaceDir: repoRoot } }),
  );
  db.close();
  const config = loadConfig(null, { discovery: { harnesses: ["openclaw"], since: "all" } }, { kind: "user" });
  const cache = { version: 1, entries: {} };
  const discover = async (strict) => {
    const scope = resolveScope(dir, { scope: "user", strict }, config, null, { home: dir });
    config.state = { root: scope.stateDir, readScanCache: () => cache, writeScanCache: () => {} };
    const result = await discoverTranscripts({ repo: scope.repo, scope, config, strict });
    return (id) => result.transcripts.find((transcript) => transcript.extra.sessionId === id);
  };
  const loose = await discover(false);
  const recorded = loose("dashboard").association;
  assert.equal(recorded.tier, 1);
  assert.equal(recorded.confidence, "git");
  const guessed = loose("fallback").association;
  assert.equal(guessed.tier, 3);
  assert.equal(guessed.confidence, "inferred");
  assert.match(guessed.reason, /^inferred cwd/);
  assert.equal(guessed.projectRoot, repoRoot);
  const strict = await discover(true);
  assert.ok(strict("dashboard"), "--strict keeps the recorded-cwd session");
  assert.equal(strict("fallback"), undefined, "--strict drops the inferred-cwd session");
});

test("openclaw capInferred leaves recorded-cwd and already best-effort associations alone", () => {
  const tier1 = { tier: 1, confidence: "exact", reason: "cwd is worktree /r", project: "/r", projectRoot: "/r" };
  assert.equal(capInferred(tier1, { cwdInferred: false }), tier1);
  assert.equal(capInferred(null, { cwdInferred: true }), null);
  const tier3 = { tier: 3, confidence: "path", reason: "dead path" };
  assert.equal(capInferred(tier3, { cwdInferred: true }), tier3);
  assert.deepEqual(capInferred(tier1, { cwdInferred: true }), {
    tier: 3,
    confidence: "inferred",
    reason: "inferred cwd (no recorded cwd): cwd is worktree /r",
    project: "/r",
    projectRoot: "/r",
  });
});

test("openclaw P2-2 absent optional routing columns degrade and schema drift warns once", async (t) => {
  const { file } = setup(t);
  const warnings = [];
  t.mock.method(console, "error", (...args) => warnings.push(args.join(" ")));
  const db = new DatabaseSync(file);
  db.exec(`ALTER TABLE session_windows DROP COLUMN acp_owned;
    ALTER TABLE session_windows DROP COLUMN hook_external_content_source;
    ALTER TABLE session_windows DROP COLUMN channel;
    ALTER TABLE session_windows DROP COLUMN chat_type;
    ALTER TABLE session_nodes DROP COLUMN created_via;
    ALTER TABLE session_nodes DROP COLUMN spawned_by;
    ALTER TABLE session_nodes DROP COLUMN parent_session_key;
    PRAGMA user_version=24;`);
  db.close();
  assert.ok((await openclaw.discover()).some((r) => r.extra.sessionId === "dashboard"));
  assert.equal(warnings.filter((w) => /schema version 24/.test(w)).length, 1);
  assert.ok(!warnings.some((w) => /snapshot unreadable/.test(w)));
});

test("openclaw P2-5 bad workspace config warns by name and keeps sessions with a fallback", async (t) => {
  const { dir } = setup(t);
  const warnings = [];
  t.mock.method(console, "error", (...args) => warnings.push(args.join(" ")));
  fs.mkdirSync(path.join(dir, ".openclaw"));
  for (const config of ["{broken", JSON.stringify({ agents: { defaults: { workspace: "relative/path" } } })]) {
    fs.writeFileSync(path.join(dir, ".openclaw/openclaw.json"), config);
    const rows = await openclaw.discover();
    const row = rows.find((r) => r.extra.sessionId === "fallback");
    assert.ok(row);
    assert.equal(row.cwd, path.join(dir, ".openclaw/workspace"));
    assert.equal(row.extra.cwdSource, "configured-workspace");
  }
  assert.equal(warnings.filter((w) => /workspace config/.test(w)).length, 2);
  assert.ok(!warnings.some((w) => /snapshot unreadable/.test(w)));
});

test("openclaw P2-4 CLI completion runs every adapter cleanup without name checks", async (t) => {
  assert.equal(ADAPTERS.openclaw, openclaw);
  let cleanups = 0;
  ADAPTERS.fixture = { name: "fixture", cleanup: () => cleanups++, discover: async () => [] };
  t.after(() => delete ADAPTERS.fixture);
  t.mock.method(console, "error", () => {});
  assert.equal(await main(["status", "--scope", "invalid"]), 1);
  assert.equal(cleanups, 1);
});

test("openclaw P1-4 a live window keeps its identity beside a later distinct archive and across its own archival", async (t) => {
  const { file } = setup(t);
  const db = new DatabaseSync(file);
  const live = db.prepare("SELECT event_json FROM transcript_events WHERE session_id='slack' ORDER BY seq").all();
  const bytes = Buffer.from(live.map((r) => r.event_json).join("\n"));
  const insert = db.prepare(
    "INSERT INTO session_transcript_archives VALUES ('slack', ?, 'agent:main:slack', 'reset', 'identity', ?, ?)",
  );
  const slack = () => openclaw.discover().then((rows) => rows.filter((r) => r.extra.sessionId === "slack"));
  const alone = await slack();
  assert.equal(alone.length, 1);
  assert.match(alone[0].id, /^slack:[0-9a-f]{64}$/);
  insert.run("first", Buffer.from(bytes.toString().replace("Human request.", "Earlier distinct request.")), timestamp);
  const before = await slack();
  assert.equal(before.length, 2);
  assert.equal(before[0].extra.generation, "first");
  assert.notEqual(before[0].id, alone[0].id);
  assert.equal(before[1].id, alone[0].id);
  assert.equal(before[1].extra.generation, null);
  insert.run("second", bytes, timestamp + 2000);
  const overlap = await slack();
  assert.equal(overlap.length, 2);
  assert.deepEqual(
    overlap.map((r) => r.id),
    before.map((r) => r.id),
  );
  assert.equal(overlap[1].extra.generation, null);
  db.exec("DELETE FROM session_windows WHERE session_id='slack'");
  db.close();
  const after = await slack();
  assert.deepEqual(
    after.map((r) => r.id),
    before.map((r) => r.id),
  );
  assert.equal(after[1].extra.generation, "second");
});

test("openclaw P1-4 an undated live window keeps its identity when archived", async (t) => {
  const { file } = setup(t);
  const db = new DatabaseSync(file);
  const live = db.prepare("SELECT event_json FROM transcript_events WHERE session_id='fallback' ORDER BY seq").all();
  assert.ok(live.every((r) => JSON.parse(r.event_json).timestamp === undefined));
  const fallback = () => openclaw.discover().then((rows) => rows.filter((r) => r.extra.sessionId === "fallback"));
  const [before] = await fallback();
  assert.equal(before.extra.generation, null);
  assert.equal(before.startedAt, timestamp);
  db.prepare(
    "INSERT INTO session_transcript_archives VALUES ('fallback', 'reset', 'agent:main:main', 'reset', 'identity', ?, ?)",
  ).run(Buffer.from(live.map((r) => r.event_json).join("\n")), timestamp + 5000);
  db.exec("DELETE FROM session_windows WHERE session_id='fallback'");
  db.close();
  const after = await fallback();
  assert.equal(after.length, 1);
  assert.equal(after[0].extra.generation, "reset");
  assert.equal(after[0].startedAt, timestamp + 5000);
  assert.equal(after[0].id, before.id);
});

test("openclaw P1-4 generation identity does not depend on processing order", async (t) => {
  const { file } = setup(t);
  const db = new DatabaseSync(file);
  const live = db.prepare("SELECT event_json FROM transcript_events WHERE session_id='slack' ORDER BY seq").all();
  const bytes = Buffer.from(live.map((r) => r.event_json).join("\n"));
  const insert = db.prepare(
    "INSERT INTO session_transcript_archives VALUES ('slack', ?, 'agent:main:slack', 'reset', 'identity', ?, ?)",
  );
  insert.run("alpha", Buffer.from(bytes.toString().replace("Human request.", "Alpha request.")), timestamp + 1000);
  insert.run("beta", Buffer.from(bytes.toString().replace("Human request.", "Beta request.")), timestamp + 2000);
  const idsByGeneration = async () =>
    Object.fromEntries(
      (await openclaw.discover())
        .filter((r) => r.extra.sessionId === "slack")
        .map((r) => [String(r.extra.generation), r.id]),
    );
  const forward = await idsByGeneration();
  assert.deepEqual(Object.keys(forward).sort(), ["alpha", "beta", "null"]);
  assert.equal(new Set(Object.values(forward)).size, 3);
  db.prepare("UPDATE session_transcript_archives SET created_at = ? WHERE generation = 'alpha'").run(timestamp + 3000);
  db.close();
  assert.deepEqual(await idsByGeneration(), forward);
});

test("openclaw P1-4 a live window keeps its identity as turns append beside an older generation", async (t) => {
  const { file } = setup(t);
  const db = new DatabaseSync(file);
  const live = db.prepare("SELECT event_json FROM transcript_events WHERE session_id='slack' ORDER BY seq").all();
  const bytes = Buffer.from(live.map((r) => r.event_json).join("\n"));
  db.prepare(
    "INSERT INTO session_transcript_archives VALUES ('slack', 'first', 'agent:main:slack', 'reset', 'identity', ?, ?)",
  ).run(Buffer.from(bytes.toString().replace("Human request.", "Earlier distinct request.")), timestamp);
  const identity = (row) => transcriptIdentity({ ...row, harness: "openclaw", nativeId: row.id });
  const liveRow = () =>
    openclaw.discover().then((rows) => rows.find((r) => r.extra.sessionId === "slack" && r.extra.generation == null));
  const before = await liveRow();
  const seq = live.length;
  db.prepare("INSERT INTO transcript_events VALUES ('slack', ?, ?, NULL, ?)").run(
    seq,
    JSON.stringify({ type: "message", message: { role: "assistant", content: "A later answer." } }),
    timestamp + seq,
  );
  db.prepare("INSERT INTO session_transcript_active_events VALUES ('slack', ?, ?)").run(seq, seq);
  db.close();
  const after = await liveRow();
  assert.equal((await openclaw.read(after)).events.at(-1).text, "A later answer.");
  assert.equal(after.id, before.id);
  assert.equal(identity(after), identity(before));
});

function twinArchives(db, sessionId, answers) {
  const header = { type: "session", cwd: "/synthetic/header", timestamp };
  const message = (role, content) => ({ type: "message", message: { role, content } });
  answers.forEach((answer, index) => {
    const blob = Buffer.from(
      [header, message("user", "Same opener."), message("assistant", answer)].map((e) => JSON.stringify(e)).join("\n"),
    );
    db.prepare("INSERT INTO session_transcript_archives VALUES (?, ?, ?, 'reset', 'identity', ?, ?)").run(
      sessionId,
      index + 1,
      `agent:main:${sessionId}`,
      blob,
      timestamp + 1000 * (index + 1),
    );
  });
}

test("openclaw P1-4 generations sharing a start and first event keep distinct stable identities", async (t) => {
  const { file } = setup(t);
  const db = new DatabaseSync(file);
  twinArchives(db, "twin", ["One.", "Two.", "Three."]);
  const rows = (await openclaw.discover()).filter((r) => r.extra.sessionId === "twin");
  assert.equal(rows.length, 3);
  for (const row of rows) assert.match(row.id, /^twin:[0-9a-f]{64}$/);
  assert.equal(new Set(rows.map((r) => r.id)).size, 3);
  const idsByGeneration = async () =>
    Object.fromEntries(
      (await openclaw.discover())
        .filter((r) => r.extra.sessionId === "twin")
        .map((r) => [String(r.extra.generation), r.id]),
    );
  const forward = await idsByGeneration();
  // Reversing archive processing order must not move any twin's identity.
  db.prepare("UPDATE session_transcript_archives SET created_at = ? WHERE session_id = 'twin' AND created_at = ?").run(
    timestamp + 9000,
    timestamp + 1000,
  );
  assert.deepEqual(await idsByGeneration(), forward);
  db.close();
  assert.equal((await openclaw.read(rows[2])).events.at(-1).text, "Three.");
});

test("openclaw P1-4 a live member keeps the anchor id and earlier colliding archives never move existing ids", async (t) => {
  const { file } = setup(t);
  const db = new DatabaseSync(file);
  const header = { type: "session", cwd: "/synthetic/header", timestamp };
  const message = (role, content) => ({ type: "message", message: { role, content } });
  db.prepare(
    "INSERT INTO session_windows (session_id, session_key, created_at, updated_at, acp_owned) VALUES (?, ?, ?, ?, 0)",
  ).run("twin", "agent:main:twin", timestamp, timestamp + 1000);
  [header, message("user", "Same opener."), message("assistant", "Live.")].forEach((entry, seq) => {
    db.prepare("INSERT INTO transcript_events VALUES ('twin', ?, ?, NULL, ?)").run(
      seq,
      JSON.stringify(entry),
      timestamp + seq,
    );
    if (seq) db.prepare("INSERT INTO session_transcript_active_events VALUES ('twin', ?, ?)").run(seq, seq);
  });
  const idsByGeneration = async () =>
    Object.fromEntries(
      (await openclaw.discover())
        .filter((r) => r.extra.sessionId === "twin")
        .map((r) => [String(r.extra.generation), r.id]),
    );
  const alone = await idsByGeneration();
  assert.deepEqual(Object.keys(alone), ["null"]);
  twinArchives(db, "twin", ["One.", "Two."]);
  const colliding = await idsByGeneration();
  assert.equal(colliding.null, alone.null);
  assert.equal(new Set(Object.values(colliding)).size, 3);
  // An archive created before every existing generation changes nothing already identified.
  db.prepare(
    "INSERT INTO session_transcript_archives VALUES ('twin', '0', 'agent:main:twin', 'reset', 'identity', ?, ?)",
  ).run(
    Buffer.from(
      [header, message("user", "Same opener."), message("assistant", "Zero.")].map((e) => JSON.stringify(e)).join("\n"),
    ),
    timestamp - 1000,
  );
  db.close();
  const earlier = await idsByGeneration();
  assert.equal(new Set(Object.values(earlier)).size, 4);
  for (const [generation, id] of Object.entries(colliding)) assert.equal(earlier[generation], id);
});

test("openclaw P1-4 an INTEGER generation column is read and keyed without throwing", async (t) => {
  const { file } = setup(t);
  const warnings = [];
  t.mock.method(console, "error", (...args) => warnings.push(args.join(" ")));
  const db = new DatabaseSync(file);
  db.exec(`DROP TABLE session_transcript_archives;
    CREATE TABLE session_transcript_archives (session_id TEXT, generation INTEGER, session_key TEXT,
      reason TEXT, encoding TEXT, archive_blob BLOB, created_at INTEGER, PRIMARY KEY(session_id, generation));`);
  twinArchives(db, "numbered", ["One.", "Two.", "Three."]);
  db.close();
  const rows = (await openclaw.discover()).filter((r) => r.extra.sessionId === "numbered");
  assert.deepEqual(
    rows.map((r) => r.extra.generation),
    [1, 2, 3],
  );
  assert.equal(new Set(rows.map((r) => r.id)).size, 3);
  assert.equal((await openclaw.read(rows[2])).events.at(-1).text, "Three.");
  assert.ok(!warnings.some((w) => /skipped/.test(w)), warnings.join("\n"));
});
