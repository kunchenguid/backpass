import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import * as claude from "../src/discovery/adapters/claude.js";
import * as codex from "../src/discovery/adapters/codex.js";
import * as pi from "../src/discovery/adapters/pi.js";
import * as grok from "../src/discovery/adapters/grok.js";
import * as cursorCli from "../src/discovery/adapters/cursor-cli.js";
import * as hermes from "../src/discovery/adapters/hermes.js";
import { statOrNull } from "../src/discovery/adapters/shared.js";
import { associate } from "../src/discovery/association.js";

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
    assert.deepEqual(
      pi
        .enumerate()
        .map((candidate) => path.basename(candidate.path))
        .sort(),
      [
        "custom-agent.jsonl",
        "custom-data.jsonl",
        "custom-session.jsonl",
        "default-bb.jsonl",
        "direct-override.jsonl",
        "standalone.jsonl",
      ],
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

test("hermes adapter recovers v26 cli cwd from sessions.cwd when system_prompt is null, and still skips cron", async () => {
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
        id: "cron-v26",
        source: "cron",
        cwd: "/repo/demo",
        system_prompt: "Current working directory: /repo/demo\n",
        started_at: 1_700_000_200,
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
      ["acp-v26", "cli-v26"],
      "v26 cli/acp are kept; cron is skipped even when sessions.cwd is set",
    );
    const cli = found.find((row) => row.id === "cli-v26");
    const acp = found.find((row) => row.id === "acp-v26");
    assert.equal(cli.cwd, "/repo/demo");
    assert.equal(acp.cwd, "/repo/demo");
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
