import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";

import * as claude from "../src/discovery/adapters/claude.js";
import * as codex from "../src/discovery/adapters/codex.js";
import * as pi from "../src/discovery/adapters/pi.js";
import * as grok from "../src/discovery/adapters/grok.js";
import * as cursorCli from "../src/discovery/adapters/cursor-cli.js";
import * as hermes from "../src/discovery/adapters/hermes.js";
import * as opencode from "../src/discovery/adapters/opencode.js";
import { statOrNull } from "../src/discovery/adapters/shared.js";
import { associate } from "../src/discovery/association.js";
import { discoverTranscripts } from "../src/discovery/index.js";
import { associateUser } from "../src/scope.js";
import { readOpencodeFixture, withOpencodeHome, writeOpencodeStore } from "./helpers/opencode.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function candidateFor(file) {
  const stat = statOrNull(file);
  return { key: file, path: file, mtimeMs: stat.mtimeMs, bytes: stat.size };
}

function messages(events) {
  return events.filter((e) => e.kind === "message");
}

function tools(events) {
  return events.filter((e) => e.kind === "tool");
}

test("claude adapter classifies a session by its per-line cwd", () => {
  const file = path.join(FIXTURES, "claude-session.jsonl");
  const descriptor = claude.classify(candidateFor(file));

  assert.equal(descriptor.id, "11111111-2222-3333-4444-555555555555");
  assert.equal(descriptor.cwd, "/repo/demo");
  assert.equal(descriptor.gitBranch, "main");
  // Claude records no remote, which is why dead worktrees cannot reach tier 2.
  assert.deepEqual(descriptor.remotes, []);
});

test("claude adapter reads messages, folds tool results, and drops sidechains", () => {
  const file = path.join(FIXTURES, "claude-session.jsonl");
  const { events, model } = claude.read({ path: file });

  assert.equal(model, "claude-opus-5");
  assert.deepEqual(
    messages(events).map((m) => `${m.role}: ${m.text}`),
    ["user: Open a PR for the parser fix.", "assistant: I'll run the tests first.", "assistant: Opened PR #2731."],
  );

  const [toolCall] = tools(events);
  assert.equal(toolCall.name, "Bash");
  assert.equal(toolCall.input.command, "npm test");
  assert.equal(toolCall.result, "2 passing");
});

function writeClaudeStore(configRoot, sessionName) {
  const dir = path.join(configRoot, "projects", "-repo-demo");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, "claude-session.jsonl"), path.join(dir, `${sessionName}.jsonl`));
}

function enumerateClaude(homeDir, configDir) {
  const prevHome = process.env.HOME;
  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = homeDir;
  if (configDir) process.env.CLAUDE_CONFIG_DIR = configDir;
  else delete process.env.CLAUDE_CONFIG_DIR;
  try {
    return claude
      .enumerate()
      .map((candidate) => path.basename(candidate.path))
      .sort();
  } finally {
    process.env.HOME = prevHome;
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  }
}

test("claude adapter enumerates the default store and CLAUDE_CONFIG_DIR, without double-counting", () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-claude-home-"));
  const defaultRoot = path.join(fakeHome, ".claude");
  const workRoot = path.join(fakeHome, ".claude-work");
  writeClaudeStore(defaultRoot, "personal");
  writeClaudeStore(workRoot, "work");

  assert.deepEqual(enumerateClaude(fakeHome, workRoot), ["personal.jsonl", "work.jsonl"]);
  assert.deepEqual(enumerateClaude(fakeHome, null), ["personal.jsonl"]);
  assert.deepEqual(enumerateClaude(fakeHome, defaultRoot), ["personal.jsonl"]);
});

test("codex adapter honors CODEX_HOME", () => {
  const previous = process.env.CODEX_HOME;
  const relocated = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-codex-home-"));
  process.env.CODEX_HOME = relocated;
  try {
    assert.equal(codex.storeRoot(), path.join(relocated, "sessions"));
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test("codex adapter reads the recorded git remote, enabling tier-2 association", () => {
  const file = path.join(FIXTURES, "codex-rollout.jsonl");
  const descriptor = codex.classify(candidateFor(file));

  assert.equal(descriptor.cwd, "/repo/demo");
  assert.deepEqual(descriptor.remotes, ["git@github.com:acme/demo.git"]);
});

test("codex adapter keeps user/assistant turns and skips developer scaffolding", () => {
  const file = path.join(FIXTURES, "codex-rollout.jsonl");
  const { events, model } = codex.read({ path: file });

  assert.equal(model, "gpt-5.2");
  assert.deepEqual(
    messages(events).map((m) => m.role),
    ["user", "assistant"],
  );
  assert.ok(!JSON.stringify(events).includes("ignore me"), "developer message must not survive");
  assert.ok(!JSON.stringify(events).includes("OPAQUE"), "encrypted reasoning must not survive");

  const [toolCall] = tools(events);
  assert.equal(toolCall.name, "shell");
  assert.equal(toolCall.input.command, "npm test");
  assert.equal(toolCall.result, "1 failing");
});

test("pi adapter reads the session header and drops thinking blocks", () => {
  const file = path.join(FIXTURES, "pi-session.jsonl");
  const descriptor = pi.classify(candidateFor(file));
  assert.equal(descriptor.id, "pi-1234");
  assert.equal(descriptor.cwd, "/repo/demo");

  const { events, model } = pi.read({ path: file });
  assert.equal(model, "gpt-5.6-sol");
  assert.ok(!JSON.stringify(events).includes("internal reasoning"), "thinking must be dropped");

  const [toolCall] = tools(events);
  assert.equal(toolCall.name, "bash");
  assert.equal(toolCall.result, "nothing to commit");
});

test("pi adapter classifies omp sessions past the title record and reads model", () => {
  const file = path.join(FIXTURES, "omp-session.jsonl");
  const descriptor = pi.classify(candidateFor(file));
  assert.equal(descriptor.id, "omp-5678");
  assert.equal(descriptor.cwd, "/repo/demo");

  const { events, model } = pi.read({ path: file });
  assert.equal(model, "cursor/composer-2.5", "omp model_change carries model, not modelId");
  const [toolCall] = tools(events);
  assert.equal(toolCall.name, "bash");
  assert.equal(toolCall.result, "nothing to commit");
});
test("pi adapter accepts only line one or line two after a title header", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-omp-header-"));
  const title = JSON.stringify({ type: "title", v: 1, title: "" });
  const session = JSON.stringify({ type: "session", version: 3, id: "late", cwd: "/repo/demo" });
  const other = JSON.stringify({ type: "message", message: { role: "user", content: "hello" } });
  const afterTitle = path.join(dir, "after-title.jsonl");
  const afterOther = path.join(dir, "after-other.jsonl");

  fs.writeFileSync(afterTitle, `${title}\n${other}\n${session}\n`);
  fs.writeFileSync(afterOther, `${other}\n${session}\n`);

  assert.equal(pi.classify(candidateFor(afterTitle)), null, "line three is outside the header");
  assert.equal(pi.classify(candidateFor(afterOther)), null, "line two is a header only after a title record");
});

test("pi adapter links an OMP subagent to its sibling parent session", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-omp-parent-"));
  const sessionDir = path.join(root, "-repo-demo");
  const parentName = "2026-08-27T00-00-00.000Z_parent-folder";
  const parentPath = path.join(sessionDir, `${parentName}.jsonl`);
  const childPath = path.join(sessionDir, parentName, "Subagent.jsonl");
  writeOmpSession(parentPath, { id: "parent-native", cwd: "/repo/demo" });
  writeOmpSession(childPath, { id: "child-native", cwd: "/repo/demo" });

  const child = pi.classify(candidateFor(childPath));
  assert.equal(child.parentSessionId, "parent-native");
  assert.equal(child.parentSessionPath, parentPath);
  assert.equal(child.parentSessionStartedAt, Date.parse("2026-08-27T00:00:00.000Z"));
  assert.equal(pi.classify(candidateFor(parentPath)).parentSessionId, undefined);
});

test("pi adapter links a second-level OMP subagent to the root session", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-omp-nested-"));
  const sessionDir = path.join(root, "-repo-demo");
  const parentName = "2026-08-27T00-00-00.000Z_parent-folder";
  const parentPath = path.join(sessionDir, `${parentName}.jsonl`);
  const childPath = path.join(sessionDir, parentName, "Subagent.jsonl");
  const grandchildPath = path.join(sessionDir, parentName, "Subagent", "Subagent.Child.jsonl");
  writeOmpSession(parentPath, { id: "parent-native", cwd: "/repo/demo" });
  writeOmpSession(childPath, { id: "child-native", cwd: "/repo/demo" });
  writeOmpSession(grandchildPath, { id: "grandchild-native", cwd: "/repo/demo" });

  const grandchild = pi.classify(candidateFor(grandchildPath));
  assert.equal(grandchild.id, "grandchild-native");
  assert.equal(grandchild.parentSessionId, "parent-native");
  assert.equal(grandchild.parentSessionPath, parentPath);
  assert.equal(grandchild.parentSessionStartedAt, Date.parse("2026-08-27T00:00:00.000Z"));
});

test("pi adapter links OMP subagents by nested path even when their cwd differs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-omp-cwd-"));
  const sessionDir = path.join(root, "-repo-demo");
  const parentName = "2026-08-27T00-00-00.000Z_parent-folder";
  const parentPath = path.join(sessionDir, `${parentName}.jsonl`);
  const childPath = path.join(sessionDir, parentName, "Subagent.jsonl");
  const grandchildPath = path.join(sessionDir, parentName, "Subagent", "Subagent.Child.jsonl");
  writeOmpSession(parentPath, { id: "parent-native", cwd: "/repo/demo" });
  writeOmpSession(childPath, { id: "child-native", cwd: "/repo/demo/packages/api" });
  writeOmpSession(grandchildPath, { id: "grandchild-native", cwd: "/worktrees/demo-isolated" });

  const child = pi.classify(candidateFor(childPath));
  assert.equal(child.cwd, "/repo/demo/packages/api", "association still uses the subagent's own cwd");
  assert.equal(child.parentSessionId, "parent-native");
  assert.equal(child.parentSessionPath, parentPath);

  const grandchild = pi.classify(candidateFor(grandchildPath));
  assert.equal(grandchild.cwd, "/worktrees/demo-isolated");
  assert.equal(grandchild.parentSessionId, "parent-native");
  assert.equal(grandchild.parentSessionPath, parentPath);
});

test("pi discovery checks a missing parent path once per scan", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-pi-parent-cache-"));
  const sessionDir = path.join(root, "sessions", "-repo-demo");
  const firstPath = path.join(sessionDir, "first.jsonl");
  const secondPath = path.join(sessionDir, "second.jsonl");
  writePiSession(firstPath, { id: "first", cwd: "/repo/demo" });
  writePiSession(secondPath, { id: "second", cwd: "/repo/demo" });
  const candidates = [candidateFor(firstPath), candidateFor(secondPath)];
  const missingParentPath = path.join(root, "sessions", "-repo-demo.jsonl");
  const scanContext = pi.createScanContext();
  const originalStatSync = fs.statSync;
  let parentProbes = 0;

  fs.statSync = function (file, ...args) {
    if (file === missingParentPath) parentProbes += 1;
    return originalStatSync.call(this, file, ...args);
  };
  try {
    for (const candidate of candidates) pi.classify(candidate, { scanContext });
  } finally {
    fs.statSync = originalStatSync;
  }

  assert.ok(parentProbes <= 1, "ordinary sessions in one store should not repeat the same missing-parent lookup");
});
function writeOmpSession(file, { id, cwd }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: "title", v: 1, title: "", updatedAt: "2026-08-27T00:00:00.000Z", pad: "  " })}\n` +
      `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-08-27T00:00:00.000Z", cwd })}\n`,
  );
}

function writePiSession(file, { id, cwd }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-08-27T00:00:00.000Z", cwd })}\n`,
  );
}

function withPiStoreEnv(
  { homeDir, piAgentDir = undefined, piSessionDir = undefined, bbDataDir = undefined, bridgeDir = undefined },
  fn,
) {
  const previous = {
    HOME: process.env.HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
    BB_DATA_DIR: process.env.BB_DATA_DIR,
    BB_PI_BRIDGE_SESSION_DIR: process.env.BB_PI_BRIDGE_SESSION_DIR,
  };
  process.env.HOME = homeDir;
  for (const [key, value] of Object.entries({
    PI_CODING_AGENT_DIR: piAgentDir,
    PI_CODING_AGENT_SESSION_DIR: piSessionDir,
    BB_DATA_DIR: bbDataDir,
    BB_PI_BRIDGE_SESSION_DIR: bridgeDir,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("pi adapter enumerates standalone and BB-managed session roots without duplicates", () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-pi-home-"));
  const piAgentDir = path.join(fakeHome, "pi-agent");
  const piSessionDir = path.join(fakeHome, "pi-session-override");
  const bbDataDir = path.join(fakeHome, "bb-data");
  const bridgeDir = path.join(fakeHome, "bridge-override");
  writePiSession(path.join(fakeHome, ".pi", "agent", "sessions", "-repo-demo", "standalone.jsonl"), {
    id: "standalone",
    cwd: "/repo/demo",
  });
  writeOmpSession(path.join(fakeHome, ".omp", "agent", "sessions", "-repo-demo", "omp-standalone.jsonl"), {
    id: "omp-standalone",
    cwd: "/repo/demo",
  });
  writeOmpSession(path.join(fakeHome, ".omp", "agent", "sessions", "-repo-demo", "omp-standalone", "Subagent.jsonl"), {
    id: "omp-subagent",
    cwd: "/repo/demo",
  });
  writeOmpSession(
    path.join(
      fakeHome,
      ".omp",
      "agent",
      "sessions",
      "-repo-demo",
      "omp-standalone",
      "Subagent",
      "Subagent.Child.jsonl",
    ),
    { id: "omp-nested-subagent", cwd: "/repo/demo" },
  );
  writePiSession(path.join(piAgentDir, "sessions", "-repo-demo", "custom-agent.jsonl"), {
    id: "custom-agent",
    cwd: "/repo/demo",
  });
  writePiSession(path.join(piSessionDir, "custom-session.jsonl"), {
    id: "custom-session",
    cwd: "/repo/demo",
  });
  writePiSession(path.join(fakeHome, ".bb", "pi-bridge-sessions", "default-bb.jsonl"), {
    id: "default-bb",
    cwd: "/repo/demo",
  });
  writePiSession(path.join(bbDataDir, "pi-bridge-sessions", "custom-data.jsonl"), {
    id: "custom-data",
    cwd: "/repo/demo",
  });
  writePiSession(path.join(bridgeDir, "direct-override.jsonl"), {
    id: "direct-override",
    cwd: "/repo/demo",
  });

  withPiStoreEnv({ homeDir: fakeHome, piAgentDir, piSessionDir, bbDataDir, bridgeDir }, () => {
    for (const config of [undefined, { discovery: { includeOmp: false } }]) {
      assert.deepEqual(
        pi
          .enumerate({ config })
          .map((candidate) => path.basename(candidate.path))
          .sort(),
        [
          "custom-agent.jsonl",
          "custom-data.jsonl",
          "custom-session.jsonl",
          "default-bb.jsonl",
          "direct-override.jsonl",
          "standalone.jsonl",
        ].sort(),
        "OMP's default store is not read unless explicitly enabled",
      );
    }
    assert.deepEqual(
      pi
        .enumerate({ config: { discovery: { includeOmp: true } } })
        .map((candidate) => path.basename(candidate.path))
        .sort(),
      [
        "custom-agent.jsonl",
        "custom-data.jsonl",
        "custom-session.jsonl",
        "default-bb.jsonl",
        "direct-override.jsonl",
        "omp-standalone.jsonl",
        "standalone.jsonl",
        "Subagent.Child.jsonl",
        "Subagent.jsonl",
      ].sort(),
    );
  });

  const defaultBridgeDir = path.join(fakeHome, ".bb", "pi-bridge-sessions");
  withPiStoreEnv(
    {
      homeDir: fakeHome,
      piAgentDir: path.join(fakeHome, ".pi", "agent"),
      bbDataDir: path.join(fakeHome, ".bb"),
      bridgeDir: defaultBridgeDir,
    },
    () => {
      assert.equal(
        pi.enumerate().filter((candidate) => path.basename(candidate.path) === "default-bb.jsonl").length,
        1,
        "the same BB root exposed by defaults and environment is scanned once",
      );
    },
  );
});

test("pi adapter merges flat and nested scans for one sessions root", () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-pi-overlap-"));
  const piAgentDir = path.join(fakeHome, ".pi", "agent");
  const sessionsDir = path.join(piAgentDir, "sessions");
  writePiSession(path.join(sessionsDir, "direct.jsonl"), {
    id: "direct",
    cwd: "/repo/demo",
  });
  writePiSession(path.join(sessionsDir, "-repo-demo", "nested.jsonl"), {
    id: "nested",
    cwd: "/repo/demo",
  });

  withPiStoreEnv({ homeDir: fakeHome, piAgentDir, piSessionDir: sessionsDir }, () => {
    assert.deepEqual(
      pi
        .enumerate()
        .map((candidate) => path.basename(candidate.path))
        .sort(),
      ["direct.jsonl", "nested.jsonl"],
    );
  });
});

test("BB-managed Pi cwd values use the existing live and deleted worktree association", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-pi-association-"));
  const live = path.join(root, "live", "hexdeck");
  const deleted = path.join(root, "deleted", "hexdeck");
  const bridgeDir = path.join(root, "bb", "pi-bridge-sessions");
  fs.mkdirSync(live, { recursive: true });
  writePiSession(path.join(bridgeDir, "live.jsonl"), { id: "live", cwd: live });
  writePiSession(path.join(bridgeDir, "deleted.jsonl"), { id: "deleted", cwd: deleted });

  withPiStoreEnv({ homeDir: path.join(root, "home"), bridgeDir }, () => {
    const descriptors = new Map(
      pi.enumerate().map((candidate) => [path.basename(candidate.path), pi.classify(candidate)]),
    );
    const liveRealpath = fs.realpathSync(live);
    const repo = { name: "hexdeck", worktrees: [liveRealpath], remotes: [] };
    assert.deepEqual(associate(descriptors.get("live.jsonl"), repo), {
      tier: 1,
      confidence: "exact",
      reason: `cwd is worktree ${liveRealpath}`,
    });
    assert.deepEqual(
      associate(descriptors.get("deleted.jsonl"), repo, { worktreeGlobs: [path.join(root, "deleted", "**")] }),
      {
        tier: 3,
        confidence: "path",
        reason: "dead path ending in /hexdeck",
      },
    );
  });
});

test("grok adapter reads remotes from summary.json and tool calls off the assistant record", () => {
  const sessionDir = path.join(FIXTURES, "grok-session", "%2Frepo%2Fdemo", "grok-9999");
  const descriptor = grok.classify({ path: sessionDir, mtimeMs: 0 });
  assert.deepEqual(descriptor.remotes, ["git@github.com:acme/demo.git"]);
  assert.equal(descriptor.cwd, "/repo/demo");
  assert.equal(descriptor.model, "grok-4.5");
  assert.equal(descriptor.id, "grok-9999");

  const { events, model } = grok.read({ path: sessionDir });
  assert.equal(model, "grok-4.5");
  assert.deepEqual(
    messages(events).map((m) => `${m.role}: ${m.text}`),
    ["user: Deploy the staging build.", "assistant: Staging is live."],
  );

  const [toolCall] = tools(events);
  assert.equal(toolCall.name, "run_terminal_command");
  assert.equal(toolCall.input.command, "make deploy");
  assert.equal(toolCall.result, "deployed to staging");
});

test("cursor CLI chat directories are addressed by md5 of the cwd", () => {
  // Verified against the real store: md5 of the cwd is the on-disk directory name.
  assert.equal(
    cursorCli.cwdHash("/Users/kunchen/.treehouse/sshhip-b697bb/9/sshhip"),
    "43ed8ea0825f9a5321fbe6d772769411",
  );
});

function withHermesHome(dir, fn) {
  const prev = process.env.HERMES_HOME;
  process.env.HERMES_HOME = dir;
  const restore = () => {
    if (prev === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = prev;
  };
  try {
    const result = fn();
    if (result && typeof result.then === "function") return result.finally(restore);
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

/**
 * @param {string} dir
 * @param {{ sessions?: object[], messages?: object[], schema?: string, activeColumn?: boolean, cwdColumn?: boolean }} [spec]
 */
function writeHermesDb(dir, { sessions = [], messages = [], schema, activeColumn = false, cwdColumn = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "state.db"));
  try {
    if (schema) {
      db.exec(schema);
      return;
    }
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT,
        model TEXT,
        model_config TEXT,
        system_prompt TEXT,
        title TEXT,
        started_at REAL,
        ended_at REAL
        ${cwdColumn ? ", cwd TEXT" : ""}
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        session_id TEXT,
        role TEXT,
        content TEXT,
        tool_call_id TEXT,
        tool_calls TEXT,
        tool_name TEXT,
        timestamp REAL NOT NULL
        ${activeColumn ? ", active INTEGER NOT NULL DEFAULT 1" : ""}
      );
    `);
    const insertSession = db.prepare(
      `INSERT INTO sessions (id, source, model, model_config, system_prompt, title, started_at, ended_at${cwdColumn ? ", cwd" : ""})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?${cwdColumn ? ", ?" : ""})`,
    );
    for (const s of sessions) {
      const values = [
        s.id,
        s.source,
        s.model ?? null,
        s.model_config ?? null,
        s.system_prompt ?? null,
        s.title ?? null,
        s.started_at,
        s.ended_at ?? null,
      ];
      if (cwdColumn) values.push(s.cwd ?? null);
      insertSession.run(...values);
    }
    const insertMessage = db.prepare(
      `INSERT INTO messages
         (id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp${activeColumn ? ", active" : ""})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?${activeColumn ? ", ?" : ""})`,
    );
    for (const m of messages) {
      const values = [
        m.id,
        m.session_id,
        m.role,
        m.content ?? null,
        m.tool_call_id ?? null,
        m.tool_calls ?? null,
        m.tool_name ?? null,
        m.timestamp ?? 1_700_000_000 + m.id,
      ];
      if (activeColumn) values.push(m.active ?? 1);
      insertMessage.run(...values);
    }
  } finally {
    db.close();
  }
}

test("hermes adapter recovers cli/acp cwd, skips gateway, converts seconds to ms, and folds tools", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-hermes-empty-"));
  await withHermesHome(empty, async () => {
    assert.deepEqual(await hermes.discover(), []);
    const emptyRead = await hermes.read({ id: "missing", extra: { sessionId: "missing" } });
    assert.deepEqual(emptyRead.events, []);
  });

  const junk = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-hermes-junk-"));
  writeHermesDb(junk, { schema: "CREATE TABLE dummy (id INTEGER)" });
  await withHermesHome(junk, async () => {
    await assert.rejects(hermes.discover(), /no such table: sessions/);
  });

  const current = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-hermes-current-"));
  writeHermesDb(current, {
    activeColumn: true,
    sessions: [
      {
        id: "cli-rewound",
        source: "cli",
        system_prompt: "Working directory: /repo/demo",
        started_at: 1_600_000_000,
      },
    ],
    messages: [
      {
        id: 1,
        session_id: "cli-rewound",
        role: "user",
        content: "Active turn",
        timestamp: 1_600_000_100,
      },
      {
        id: 2,
        session_id: "cli-rewound",
        role: "user",
        content: "Rewound turn",
        timestamp: 1_700_000_000,
        active: 0,
      },
    ],
  });
  await withHermesHome(current, async () => {
    assert.deepEqual(await hermes.discover({ cutoffMs: 1_700_000_000_000 }), []);
    const [rewound] = await hermes.discover();
    assert.deepEqual(
      messages((await hermes.read(rewound)).events).map((message) => message.text),
      ["Active turn"],
    );
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-hermes-"));
  const prompt = "You are Hermes.\nCurrent working directory: /repo/demo\n";
  const toolCalls = JSON.stringify([
    {
      id: "call_1",
      type: "function",
      function: { name: "Bash", arguments: JSON.stringify({ command: "npm test" }) },
    },
  ]);
  writeHermesDb(dir, {
    sessions: [
      {
        id: "cli-1",
        source: "cli",
        model: "claude-sonnet-4",
        system_prompt: prompt,
        title: "CLI session",
        started_at: 1_700_000_000,
        ended_at: 1_700_000_060,
      },
      {
        id: "acp-1",
        source: "acp",
        model: "claude-sonnet-4",
        model_config: JSON.stringify({ cwd: "/repo/demo" }),
        title: "ACP session",
        started_at: 1_700_000_100,
      },
      {
        id: "wa-1",
        source: "whatsapp",
        system_prompt: prompt,
        started_at: 1_700_000_200,
      },
      {
        id: "cron-1",
        source: "cron",
        system_prompt: prompt,
        started_at: 1_700_000_300,
      },
      {
        id: "cli-nocwd",
        source: "cli",
        model_config: JSON.stringify({ cwd: "/repo/wrong-source" }),
        system_prompt: "no directory line here",
        started_at: 1_700_000_400,
      },
      {
        id: "acp-nocwd",
        source: "acp",
        system_prompt: prompt,
        started_at: 1_700_000_450,
      },
      {
        id: "cli-resumed",
        source: "cli",
        system_prompt: prompt,
        started_at: 1_600_000_000,
      },
    ],
    messages: [
      { id: 1, session_id: "cli-1", role: "user", content: "Please open a PR for the parser fix." },
      {
        id: 2,
        session_id: "cli-1",
        role: "assistant",
        content: "I'll run the tests first.",
        tool_calls: toolCalls,
      },
      {
        id: 3,
        session_id: "cli-1",
        role: "tool",
        tool_call_id: "call_1",
        tool_name: null,
        content: "2 passing",
      },
      {
        id: 4,
        session_id: "cli-1",
        role: "assistant",
        content: `\x00json:${JSON.stringify([{ type: "text", text: "Opened PR #2731." }])}`,
      },
      {
        id: 5,
        session_id: "cli-1",
        role: "session_meta",
        content: "session-meta-must-not-surface",
      },
      {
        id: 6,
        session_id: "cli-resumed",
        role: "user",
        content: "Continue this old session.",
        timestamp: 1_700_000_600,
      },
      {
        id: 7,
        session_id: "cli-1",
        role: "assistant",
        content: "Imported later message.",
        timestamp: 1_700_000_050,
      },
      {
        id: 8,
        session_id: "cli-1",
        role: "user",
        content: "Imported earlier message.",
        timestamp: 1_700_000_040,
      },
    ],
  });

  await withHermesHome(dir, async () => {
    const found = await hermes.discover();
    assert.deepEqual(
      found.map((row) => row.id).sort(),
      ["acp-1", "cli-1", "cli-resumed"],
      "cli and acp are kept; disallowed sources and source-invalid cwd fields are skipped",
    );

    const cli = found.find((row) => row.id === "cli-1");
    const acp = found.find((row) => row.id === "acp-1");
    const resumed = found.find((row) => row.id === "cli-resumed");
    assert.equal(cli.cwd, "/repo/demo");
    assert.equal(acp.cwd, "/repo/demo");
    assert.equal(cli.startedAt, 1_700_000_000_000, "epoch seconds become milliseconds");
    assert.equal(cli.mtimeMs, 1_700_000_060_000);
    assert.equal(acp.mtimeMs, 1_700_000_100_000, "activity falls back to started_at");
    assert.equal(resumed.mtimeMs, 1_700_000_600_000, "latest message determines resumed-session activity");
    assert.deepEqual(
      (await hermes.discover({ cutoffMs: 1_700_000_500_000 })).map((row) => row.id),
      ["cli-resumed"],
      "a recently resumed old session passes the activity cutoff",
    );
    assert.equal(cli.extra.source, "cli");
    assert.equal(acp.extra.source, "acp");
    assert.deepEqual(cli.remotes, []);
    assert.equal(cli.gitBranch, null);

    const { events, model } = await hermes.read(cli);
    assert.equal(model, "claude-sonnet-4");
    assert.deepEqual(
      messages(events).map((m) => `${m.role}: ${m.text}`),
      [
        "user: Please open a PR for the parser fix.",
        "assistant: I'll run the tests first.",
        "assistant: Opened PR #2731.",
        "user: Imported earlier message.",
        "assistant: Imported later message.",
      ],
    );
    assert.ok(!JSON.stringify(events).includes("session-meta-must-not-surface"), "session_meta rows are dropped");

    const [toolCall] = tools(events);
    assert.equal(toolCall.name, "Bash", "tool name comes from the matching call when tool_name is null");
    assert.equal(toolCall.input.command, "npm test");
    assert.equal(toolCall.result, "2 passing");
  });
});

test("hermes adapter collects v26 interactive sessions with trustworthy cwd and skips shared sources", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-hermes-v26-"));
  writeHermesDb(dir, {
    cwdColumn: true,
    sessions: [
      {
        id: "cli-v26",
        source: "cli",
        model: "openai/gpt-4o-mini",
        cwd: "/repo/demo",
        started_at: 1_700_000_000,
      },
      {
        id: "acp-v26",
        source: "acp",
        model: "openai/gpt-4o-mini",
        model_config: JSON.stringify({ cwd: "/repo/demo" }),
        started_at: 1_700_000_100,
      },
      {
        id: "tui-v26",
        source: "tui",
        cwd: "/repo/demo",
        started_at: 1_700_000_150,
      },
      {
        id: "tui-relative",
        source: "tui",
        cwd: "repo/demo",
        system_prompt: "Current working directory: /repo/demo\n",
        started_at: 1_700_000_160,
      },
      {
        id: "tui-no-cwd",
        source: "tui",
        model_config: JSON.stringify({ cwd: "/repo/demo" }),
        started_at: 1_700_000_170,
      },
      {
        id: "cron-v26",
        source: "cron",
        cwd: "/repo/demo",
        system_prompt: "Current working directory: /repo/demo\n",
        started_at: 1_700_000_200,
      },
      {
        id: "gateway-v26",
        source: "gateway",
        cwd: "/repo/demo",
        started_at: 1_700_000_210,
      },
    ],
    messages: [
      { id: 1, session_id: "cli-v26", role: "user", content: "hello from v26 cli" },
      {
        id: 2,
        session_id: "cli-v26",
        role: "assistant",
        content: "running pwd",
        tool_calls: JSON.stringify([
          {
            id: "call_pwd",
            type: "function",
            function: { name: "terminal", arguments: JSON.stringify({ command: "pwd" }) },
          },
        ]),
      },
      {
        id: 3,
        session_id: "cli-v26",
        role: "tool",
        tool_call_id: "call_pwd",
        tool_name: null,
        content: "/repo/demo",
      },
    ],
  });

  await withHermesHome(dir, async () => {
    const found = await hermes.discover();
    assert.deepEqual(
      found.map((row) => row.id).sort(),
      ["acp-v26", "cli-v26", "tui-v26"],
      "v26 TUI needs absolute sessions.cwd; shared sources remain excluded",
    );
    const cli = found.find((row) => row.id === "cli-v26");
    const acp = found.find((row) => row.id === "acp-v26");
    const tui = found.find((row) => row.id === "tui-v26");
    assert.equal(cli.cwd, "/repo/demo");
    assert.equal(acp.cwd, "/repo/demo");
    assert.equal(tui.cwd, "/repo/demo");
    assert.equal(tui.extra.source, "tui");
    assert.equal(cli.startedAt, 1_700_000_000_000);

    const { events, model } = await hermes.read(cli);
    assert.equal(model, "openai/gpt-4o-mini");
    assert.deepEqual(
      messages(events).map((m) => `${m.role}: ${m.text}`),
      ["user: hello from v26 cli", "assistant: running pwd"],
    );
    const [toolCall] = tools(events);
    assert.equal(toolCall.name, "terminal");
    assert.equal(toolCall.input.command, "pwd");
    assert.equal(toolCall.result, "/repo/demo");
  });
});

test("normal discovery associates only trustworthy Hermes TUI sessions in project and user scope", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-hermes-scope-")));
  const repoRoot = path.join(dir, "project");
  const otherRoot = path.join(dir, "other");
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(otherRoot);
  execFileSync("git", ["init", "-q", repoRoot]);
  execFileSync("git", ["init", "-q", otherRoot]);
  writeHermesDb(path.join(dir, "hermes"), {
    cwdColumn: true,
    sessions: [
      { id: "tui-project", source: "tui", cwd: repoRoot, started_at: 1_700_000_000 },
      { id: "tui-other", source: "tui", cwd: otherRoot, started_at: 1_700_000_001 },
      { id: "tui-relative", source: "tui", cwd: "project", started_at: 1_700_000_002 },
      {
        id: "tui-fallback",
        source: "tui",
        model_config: JSON.stringify({ cwd: repoRoot }),
        started_at: 1_700_000_003,
      },
      { id: "gateway-project", source: "gateway", cwd: repoRoot, started_at: 1_700_000_004 },
      { id: "cron-project", source: "cron", cwd: repoRoot, started_at: 1_700_000_005 },
      { id: "whatsapp-project", source: "whatsapp", cwd: repoRoot, started_at: 1_700_000_006 },
    ],
  });
  const config = {
    discovery: { since: "all", harnesses: ["hermes"], worktreeGlobs: [] },
    state: { root: path.join(dir, "state"), readScanCache: () => ({}) },
  };
  const repo = { name: "project", worktrees: [repoRoot], remotes: [] };

  try {
    await withHermesHome(path.join(dir, "hermes"), async () => {
      const project = await discoverTranscripts({ repo, config, strict: true });
      assert.deepEqual(
        project.transcripts.map((row) => row.nativeId),
        ["tui-project"],
      );
      assert.equal(project.transcripts[0].association.tier, 1);
      assert.equal(project.transcripts[0].interaction, "interactive");

      const user = await discoverTranscripts({
        repo,
        config,
        strict: true,
        scope: { kind: "user", associate: associateUser },
      });
      assert.deepEqual(user.transcripts.map((row) => row.nativeId).sort(), ["tui-other", "tui-project"]);
      assert.deepEqual(new Set(user.transcripts.map((row) => row.project)), new Set([repoRoot, otherRoot]));
      assert.ok(user.transcripts.every((row) => row.association.tier === 1));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode test homes are removed and HOME restored on success and failure", async () => {
  const original = process.env.HOME;
  try {
    for (const previous of [undefined, FIXTURES]) {
      for (const failure of [null, "build", "callback"]) {
        if (previous === undefined) delete process.env.HOME;
        else process.env.HOME = previous;
        let temporaryHome;
        const error = new Error("fixture failure");
        const result = withOpencodeHome(
          (dbFile) => {
            temporaryHome = path.resolve(dbFile, "../../../..");
            assert.ok(fs.existsSync(temporaryHome));
            if (failure === "build") throw error;
          },
          async () => {
            assert.equal(process.env.HOME, temporaryHome);
            if (failure === "callback") throw error;
            return "done";
          },
        );
        if (failure) await assert.rejects(result, (caught) => caught === error);
        else assert.equal(await result, "done");
        assert.equal(process.env.HOME, previous);
        assert.equal(fs.existsSync(temporaryHome), false);
      }
    }
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
  }
});

const V2_PARENT = "ses_f17ca477affeM7vJpYuwLTunDK";
const V2_CHILD = "ses_f17c42540ffeM0ZIydCm19byyr";
const V2_SELF = "ses_f139e87ceffeqUsW26A55Cc7W1";
const V2_SELF_CHILD = "ses_f139e880dffeSelfChildSess01";
const V2_RESUMED = "ses_f0a1b2c3dffeResumedSession01";

test("opencode adapter lists an OpenCode 2 store by session_v2, dated by its newest message", async () => {
  await withOpencodeHome(
    (dbFile) => writeOpencodeStore(dbFile, readOpencodeFixture("opencode-v2-store.json")),
    async (dbFile) => {
      const rows = await opencode.discover({ cutoffMs: null });
      const byId = new Map(rows.map((row) => /** @type {[string, any]} */ ([row.id, row])));
      assert.deepEqual([...byId.keys()].sort(), [V2_RESUMED, V2_SELF, V2_SELF_CHILD, V2_CHILD, V2_PARENT].sort());
      assert.ok(!byId.has("ses_f1378472bffeProbeEmptySess1"), "a session with no messages recorded nothing");
      const parent = byId.get(V2_PARENT);
      assert.equal(parent.cwd, "/repo/demo");
      assert.equal(parent.gitRoot, "/repo/demo");
      assert.equal(parent.path, dbFile);
      assert.equal(parent.title, "Parser fix");
      assert.equal(parent.startedAt, 1790600000000);
      assert.equal(parent.mtimeMs, 1790600020800, "session_v2.time_updated does not move; the newest message does");
      assert.deepEqual(parent.extra, { sessionId: V2_PARENT, layout: "v2" });
      assert.equal(byId.get(V2_CHILD).interactionSignals.parentId, V2_PARENT, "a subagent session is a child");
      assert.equal(byId.get(V2_CHILD).self, false, "a genuine session's subagent is genuine too");
      assert.equal(byId.get(V2_SELF).self, true, "an acpx prompt opens with the sentinel");
      assert.equal(byId.get(V2_SELF_CHILD).self, true, "work backpass's own agent delegated is backpass's too");
      assert.equal(parent.self, false);

      const resumed = await opencode.discover({ cutoffMs: 1790600100000 });
      assert.ok(
        resumed.some((row) => row.id === V2_RESUMED),
        "a session created long ago but written to recently passes the window",
      );
      assert.ok(!resumed.some((row) => row.id === V2_PARENT));
      assert.deepEqual(await opencode.discover({ cutoffMs: 1790600300000 }), []);
    },
  );
});

test("opencode adapter counts epoch-dated messages as recorded", async () => {
  const fixture = readOpencodeFixture("opencode-v2-store.json");
  for (const message of fixture.rows.session_message) message.time_updated = 0;
  await withOpencodeHome(
    (dbFile) => writeOpencodeStore(dbFile, fixture),
    async () => {
      const rows = await opencode.discover({ cutoffMs: null });
      assert.deepEqual(
        rows.map((row) => row.id).sort(),
        [V2_RESUMED, V2_SELF, V2_SELF_CHILD, V2_CHILD, V2_PARENT].sort(),
      );
    },
  );
});

test("opencode adapter reads an OpenCode 2 session: turns and calls in order, harness text left out", async () => {
  await withOpencodeHome(
    (dbFile) => writeOpencodeStore(dbFile, readOpencodeFixture("opencode-v2-store.json")),
    async () => {
      const [parent] = (await opencode.discover({ cutoffMs: null })).filter((row) => row.id === V2_PARENT);
      const { events, model } = await opencode.read(parent);
      assert.equal(model, "claude-opus-5.5");
      assert.deepEqual(
        events.map((event) =>
          event.kind === "message"
            ? `${event.role}: ${event.text}`
            : `tool ${event.name} ${JSON.stringify(event.input)} [${event.status}] -> ${event.result ?? ""}`,
        ),
        [
          "user: Open a PR for the parser fix.",
          "assistant: I'll run the tests first.",
          'tool shell {"command":"npm test","workdir":"/repo/demo"} [completed] -> 2 passing',
          'tool read {"path":"/repo/demo/src/parser.ts"} [completed] -> Read file /repo/demo/src/parser.ts, lines 1-1\n1: export function parse() {}',
          'tool subagent {"agent":"general","description":"Review the parser fix","background":true,"prompt":"You are a subagent spawned by another session.\\nReview src/parser.ts."} [completed] -> <subagent sessionID="ses_f17c42540ffeM0ZIydCm19byyr" state="completed" description="Review the parser fix">\nNo blocking findings.\n</subagent>',
          "assistant: Opened PR #2731.",
          'tool edit {"path":"/repo/demo/CHANGELOG.md","oldString":"## Unreleased","newString":"## 1.2.0"} [error] -> oldString not found in content',
          'tool shell {"command":"git status --short"} [completed] -> nothing to commit',
          'tool skill {"name":"release"} [completed] -> ',
          "user: Thanks, ship it.",
          "assistant: Building the release.",
          'tool shell {"command":"npm run build","background":true} [error] -> <shell id="sh_0e84aacd7001hD1EEplKBz5KVr" state="error" command="npm run build">\nbuild failed: missing dist/\n</shell>',
          "assistant: The build failed; I will fix dist/ first.",
        ],
      );
      const raw = JSON.stringify(events);
      for (const harnessText of [
        "Instructions from",
        "Today's date",
        "The previous response was interrupted",
        "The following shell command was executed by the user",
        "## Objective",
        "Tag from main only",
        "internal reasoning",
        "OPAQUE",
      ]) {
        assert.ok(!raw.includes(harnessText), `${harnessText} is harness text, not session signal`);
      }

      const byRef = await opencode.read({ id: V2_PARENT });
      assert.deepEqual(byRef.events, events, "a ref recorded before the layout was is looked up the same way");
    },
  );
});

test("opencode adapter still reads an OpenCode 1.x store, which leaves session_message empty", async () => {
  await withOpencodeHome(
    (dbFile) => writeOpencodeStore(dbFile, readOpencodeFixture("opencode-v1-store.json")),
    async () => {
      const [row, ...rest] = await opencode.discover({ cutoffMs: null });
      assert.deepEqual(rest, []);
      assert.equal(row.id, "ses_f16e2d036ffeZd4lFcWRZCBMYV");
      assert.deepEqual(row.extra, { sessionId: row.id, layout: "v1" });
      assert.equal(row.mtimeMs, 1790605324420);
      assert.equal(row.self, false);
      const { events, model } = await opencode.read(row);
      assert.equal(model, "gpt-5.6-terra");
      assert.deepEqual(
        events.map((event) => (event.kind === "message" ? `${event.role}: ${event.text}` : `tool ${event.name}`)),
        [
          "user: Open a PR for the parser fix.",
          "tool bash",
          "assistant: I'll run the tests first.",
          "assistant: Opened PR #2731.",
        ],
      );
      const [call] = tools(events);
      assert.equal(call.input.command, "npm test");
      assert.equal(call.result, "2 passing\n");
      assert.ok(!JSON.stringify(events).includes("internal reasoning"));
    },
  );
});

test("an upgraded opencode store is read from session_v2, where each copied session continues", async () => {
  const v1 = readOpencodeFixture("opencode-v1-store.json");
  const v2 = readOpencodeFixture("opencode-v2-store.json");
  await withOpencodeHome(
    (dbFile) => {
      writeOpencodeStore(dbFile, v2);
      // What the upgrade leaves behind: the 1.x tables, holding a copy of a session that
      // now lives in session_v2 and one that was never copied.
      const projectId = v2.rows.project[0].id;
      const sessions = v1.rows.session.map((row) => ({ ...row, project_id: projectId }));
      sessions.push({ ...sessions[0], id: V2_PARENT, title: "stale 1.x copy" });
      writeOpencodeStore(
        dbFile,
        { schema: v1.schema, rows: { session: sessions, message: v1.rows.message, part: v1.rows.part } },
        { skipTables: ["project", "session_message"] },
      );
    },
    async () => {
      const rows = await opencode.discover({ cutoffMs: null });
      const layouts = Object.fromEntries(rows.map((row) => [row.id, row.extra.layout]));
      assert.equal(rows.filter((row) => row.id === V2_PARENT).length, 1, "one session, listed once");
      assert.equal(layouts[V2_PARENT], "v2");
      assert.equal(layouts["ses_f16e2d036ffeZd4lFcWRZCBMYV"], "v1");
      const parent = rows.find((row) => row.id === V2_PARENT);
      assert.equal(parent.title, "Parser fix");
      assert.equal(messages((await opencode.read(parent)).events)[0].text, "Open a PR for the parser fix.");
    },
  );
});

test("an opencode store with neither session table is named as drifted, never read as empty", async () => {
  await withOpencodeHome(
    (dbFile) => {
      fs.mkdirSync(path.dirname(dbFile), { recursive: true });
      const db = new DatabaseSync(dbFile);
      db.exec("CREATE TABLE unrelated (id INTEGER)");
      db.close();
    },
    async () => {
      await assert.rejects(opencode.discover({ cutoffMs: null }), /unrecognised opencode store/);
    },
  );
});
