import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";

import * as dsh from "../src/discovery/adapters/dsh.js";
import { discoverTranscripts, readTranscript } from "../src/discovery/index.js";
import { loadConfig } from "../src/config.js";
import { SELF_SESSION_SENTINEL } from "../src/prompts.js";

function frame(record) {
  return zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
}

function sessionHeader(uuid, cwd, createdAt = 1_700_000_000_000) {
  return {
    type: "session",
    version: 4,
    id: `session-${uuid}`,
    createdAt,
    cwd,
    delegationDepth: 0,
    agentPreset: "standard",
  };
}

function conversation(uuid = "11111111-2222-3333-4444-555555555555") {
  return [
    sessionHeader(uuid, "/repo/demo"),
    { type: "request/context", seq: 0, time: 1_700_000_000_001, data: { provider: "test", model: "test-model" } },
    {
      type: "user/message",
      seq: 1,
      time: 1_700_000_000_002,
      data: { content: [{ type: "text", text: "Fix the parser." }], role: "user", id: "u1" },
    },
    {
      type: "assistant/message",
      seq: 2,
      time: 1_700_000_000_003,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: "assistant",
          content: [
            { type: "reasoning", text: "private reasoning" },
            { type: "text", text: "I will run the tests." },
            { type: "tool-call", id: "call-1", name: "bash", arguments: "{}" },
          ],
          source: { kind: "model", model: "test-model" },
        },
      },
    },
    {
      type: "tool/call",
      seq: 3,
      time: 1_700_000_000_004,
      data: { callId: "call-1", name: "bash", arguments: '{"command":"npm test"}' },
    },
    {
      type: "tool/result",
      seq: 4,
      time: 1_700_000_000_005,
      data: { toolCallId: "call-1", content: [{ type: "text", text: "2 passing" }] },
    },
    { type: "session/title", seq: 5, time: 1_700_000_000_006, data: { title: "Parser fix" } },
  ];
}

function encodedDir(cwd) {
  return `--${cwd.replace(/^\/+/, "").replaceAll("/", "-")}--`;
}

function writeDshSession(home, records, { uuid = "11111111-2222-3333-4444-555555555555", truncateTail = 0 } = {}) {
  const header = records.find((record) => record.type === "session");
  const cwd = header?.cwd || "/repo/demo";
  const sessionDir = path.join(home, ".dsh", "sessions", encodedDir(cwd), `session-${uuid}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  const file = path.join(sessionDir, "session.v4.jsonl.zstd");
  const frames = records.map(frame);
  let bytes = Buffer.concat(frames);
  if (truncateTail) bytes = bytes.subarray(0, bytes.length - truncateTail);
  fs.writeFileSync(file, bytes);
  return file;
}

function withHome(home, fn) {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

function configFor(root, overrides = {}) {
  return {
    discovery: { since: "all", harnesses: ["dsh"], worktreeGlobs: [], includeDsh: true, ...overrides },
    state: {
      root: path.join(root, "state"),
      readScanCache: () => ({ version: 1, entries: {} }),
      writeScanCache: () => {},
    },
  };
}

async function withDshStore(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-dsh-")));
  const home = path.join(root, "home");
  const repoRoot = path.join(root, "repo");
  fs.mkdirSync(home);
  fs.mkdirSync(repoRoot);
  try {
    return await fn({ root, home, repoRoot });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("dsh discovery is off by default and gated by includeDsh", async () => {
  assert.equal(loadConfig(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-dsh-config-"))).discovery.includeDsh, false);

  await withDshStore(async ({ root, home, repoRoot }) => {
    const records = conversation();
    records[0] = sessionHeader("11111111-2222-3333-4444-555555555555", repoRoot);
    writeDshSession(home, records);

    await withHome(home, async () => {
      assert.deepEqual(dsh.enumerate({ config: { discovery: { includeDsh: false } } }), []);
      const off = await discoverTranscripts({
        repo: { name: "repo", worktrees: [repoRoot], remotes: [] },
        config: configFor(root, { includeDsh: false }),
      });
      assert.equal(off.transcripts.length, 0);
      assert.equal(off.perHarness.dsh.scanned, 0);
    });
  });
});

test("a dsh v4 session is discovered once and attributed to its recorded cwd", async () => {
  await withDshStore(async ({ root, home, repoRoot }) => {
    const records = conversation();
    records[0] = sessionHeader("11111111-2222-3333-4444-555555555555", repoRoot);
    writeDshSession(home, records);

    await withHome(home, async () => {
      const result = await discoverTranscripts({
        repo: { name: "repo", worktrees: [repoRoot], remotes: [] },
        config: configFor(root),
      });

      assert.equal(result.perHarness.dsh.scanned, 1);
      assert.equal(result.transcripts.length, 1);
      const transcript = result.transcripts[0];
      assert.equal(transcript.harness, "dsh");
      assert.equal(transcript.nativeId, "11111111-2222-3333-4444-555555555555");
      assert.equal(transcript.cwd, repoRoot);
      assert.equal(transcript.association.tier, 1);
      assert.equal(transcript.association.reason, `cwd is worktree ${repoRoot}`);
      assert.equal(transcript.title, "Parser fix");
      assert.equal(transcript.model, null);

      const read = await readTranscript(transcript);
      assert.equal(read.model, "test-model");
      assert.deepEqual(
        read.events.filter((event) => event.kind === "message").map((event) => `${event.role}: ${event.text}`),
        ["user: Fix the parser.", "assistant: I will run the tests."],
      );
      const tool = read.events.find((event) => event.kind === "tool");
      assert.equal(tool.name, "bash");
      assert.deepEqual(tool.input, { command: "npm test" });
      assert.equal(tool.result, "2 passing");
      assert.ok(!JSON.stringify(read.events).includes("private reasoning"));
    });
  });
});

test("dsh falls back to the encoded session directory when its header frame is unreadable", async () => {
  await withDshStore(async ({ home }) => {
    const cwd = "/Users/example/repo";
    const uuid = "44444444-5555-6666-7777-888888888888";
    const sessionDir = path.join(home, ".dsh", "sessions", encodedDir(cwd), `session-${uuid}`);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "session.v4.jsonl.zstd"),
      Buffer.concat([
        frame({
          type: "user/message",
          seq: 0,
          time: 1_700_000_000_000,
          data: { content: [{ type: "text", text: "hello" }] },
        }),
      ]),
    );

    await withHome(home, () => {
      const [candidate] = dsh.enumerate({ config: { discovery: { includeDsh: true } } });
      const descriptor = dsh.classify(candidate);
      assert.equal(descriptor.cwd, cwd);
      assert.equal(descriptor.id, uuid);
      assert.equal(descriptor.self, false);
    });
  });
});

test("a torn dsh tail still yields the complete records and never fails the scan", async () => {
  await withDshStore(async ({ root, home, repoRoot }) => {
    const good = conversation("22222222-3333-4444-5555-666666666666");
    good[0] = sessionHeader("22222222-3333-4444-5555-666666666666", repoRoot);
    const torn = writeDshSession(home, good, {
      uuid: "22222222-3333-4444-5555-666666666666",
      truncateTail: 8,
    });

    const corruptDir = path.join(home, ".dsh", "sessions", encodedDir(repoRoot), "session-bad");
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, "session.v4.jsonl.zstd"), "not a zstd frame");

    await withHome(home, async () => {
      const config = configFor(root);
      const result = await discoverTranscripts({
        repo: { name: "repo", worktrees: [repoRoot], remotes: [] },
        config,
      });

      assert.equal(result.perHarness.dsh.scanned, 2);
      assert.equal(result.transcripts.length, 1);
      const transcript = result.transcripts[0];
      assert.equal(transcript.nativeId, "22222222-3333-4444-5555-666666666666");

      const read = await readTranscript(transcript);
      assert.deepEqual(
        read.events.filter((event) => event.kind === "message").map((event) => `${event.role}: ${event.text}`),
        ["user: Fix the parser.", "assistant: I will run the tests."],
        "only the torn final frame is lost",
      );
      assert.doesNotThrow(() => dsh.read({ path: torn }));
    });
  });
});

test("dsh sessions that open with backpass's sentinel are excluded as self-sessions", async () => {
  await withDshStore(async ({ root, home, repoRoot }) => {
    const records = conversation("33333333-4444-5555-6666-777777777777");
    records[0] = sessionHeader("33333333-4444-5555-6666-777777777777", repoRoot);
    records[2].data.content = [{ type: "text", text: `${SELF_SESSION_SENTINEL}\nanalyze this repo` }];
    writeDshSession(home, records, { uuid: "33333333-4444-5555-6666-777777777777" });

    await withHome(home, async () => {
      const result = await discoverTranscripts({
        repo: { name: "repo", worktrees: [repoRoot], remotes: [] },
        config: configFor(root),
      });
      assert.equal(result.transcripts.length, 0);
      assert.equal(result.perHarness.dsh.self, 1);
    });
  });
});
