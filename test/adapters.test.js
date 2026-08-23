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
 * @param {{ sessions?: object[], messages?: object[], schema?: string, activeColumn?: boolean }} [spec]
 */
function writeHermesDb(dir, { sessions = [], messages = [], schema, activeColumn = false } = {}) {
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
      `INSERT INTO sessions (id, source, model, model_config, system_prompt, title, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of sessions) {
      insertSession.run(
        s.id,
        s.source,
        s.model ?? null,
        s.model_config ?? null,
        s.system_prompt ?? null,
        s.title ?? null,
        s.started_at,
        s.ended_at ?? null,
      );
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
