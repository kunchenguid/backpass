import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { distill } from "../src/distill.js";
import { cwdHash } from "../src/discovery/adapters/cursor-cli.js";
import { evidenceKey } from "../src/state.js";
import { SELF_SESSION_SENTINEL } from "../src/sentinel.js";
import { prefetchRemoteTranscripts } from "../src/discovery/hosts.js";
import { readTranscript } from "../src/discovery/index.js";
import {
  discoverProject,
  initRepo,
  sshCalls,
  tmpdir,
  withRemoteEnv,
  writeClaudeSession,
  writeHermesStore,
} from "./helpers/remote.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "backpass.js");

/** One host carrying a claude session and a hermes session, both in a clone of this repo. */
function scenario({ variant = {}, harnesses = ["claude"], remoteCloneName = "demo" } = {}) {
  const localHome = tmpdir("fetch-local");
  const remoteHome = tmpdir("fetch-home");
  const repoRoot = initRepo(path.join(localHome, "demo"), "https://github.com/acme/demo.git");
  const remoteClone = initRepo(path.join(remoteHome, "code", remoteCloneName), "git@github.com:acme/demo.git");
  writeClaudeSession(remoteHome, { cwd: remoteClone });
  if (harnesses.includes("hermes")) writeHermesStore(remoteHome, { cwd: remoteClone });
  return {
    localHome,
    remoteHome,
    repoRoot,
    remoteClone,
    harnesses,
    log: path.join(localHome, "ssh-calls.log"),
    /** @type {Record<string, Record<string, any>>} */
    hosts: { "mac-home": { home: remoteHome, ...variant } },
  };
}

function fetchCalls(log) {
  return sshCalls(log).filter((call) => call.op === "fetch");
}

async function collectAndFetch(s, overrides = {}) {
  return withRemoteEnv({ localHome: s.localHome, hosts: s.hosts, log: s.log }, async () => {
    const result = await discoverProject(s.repoRoot, {
      discovery: { hosts: ["mac-home"], harnesses: s.harnesses },
      ...overrides,
    });
    const stats = await prefetchRemoteTranscripts(result.transcripts, { config: result.config });
    return { ...result, stats };
  });
}

test("a file-backed remote session is cached as its own file, so the trace footer still names a real transcript", async () => {
  const s = scenario();
  const { transcripts, stats, config } = await collectAndFetch(s);

  assert.equal(transcripts.length, 1);
  assert.equal(stats.fetched, 1);
  const [transcript] = transcripts;
  assert.equal(transcript.remote.kind, "raw");

  const cached = transcript.remote.cachePath;
  assert.ok(cached.startsWith(path.join(config.state.root, "hosts")), `cache escaped its directory: ${cached}`);
  assert.equal(
    fs.readFileSync(cached, "utf8"),
    fs.readFileSync(
      path.join(
        s.remoteHome,
        ".claude",
        "projects",
        `-${s.remoteClone.replaceAll("/", "-")}`,
        `${transcript.nativeId}.jsonl`,
      ),
      "utf8",
    ),
    "the raw file must arrive byte for byte, since the analysis agent may open it",
  );
  assert.equal((fs.statSync(path.join(config.state.root, "hosts")).mode & 0o777).toString(8), "700");
  const persistValues = sshCalls(s.log).map((call) =>
    Number(call.options.find((option) => option.startsWith("ControlPersist="))?.split("=")[1]),
  );
  assert.equal(persistValues.length, 3);
  assert.ok(persistValues.every((seconds) => seconds > 60 && seconds === persistValues[0]));

  const raw = await readTranscript(transcript);
  assert.equal(raw.rawPath, cached);
  assert.deepEqual(
    raw.events.filter((event) => event.kind === "message").map((event) => event.text),
    ["Open a PR for the parser fix.", "I'll run the tests first.", "Opened PR #2731."],
  );
  const { trace } = distill(raw.events, { ...transcript, rawPath: raw.rawPath });
  assert.match(trace, new RegExp(`raw transcript: ${cached.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("a SQLite-backed remote session arrives as events, since there is no per-session file to copy", async () => {
  const s = scenario({ harnesses: ["claude", "hermes"] });
  const { transcripts, stats } = await collectAndFetch(s);

  const hermes = transcripts.find((transcript) => transcript.harness === "hermes");
  assert.ok(hermes, `expected a hermes session, got ${transcripts.map((t) => t.harness).join(", ")}`);
  assert.equal(hermes.remote.kind, "events");
  assert.equal(stats.fetched, 2);

  const raw = await readTranscript(hermes);
  assert.equal(raw.model, "claude-sonnet-5");
  assert.deepEqual(
    raw.events.filter((event) => event.kind === "message").map((event) => event.text),
    ["Ship the remote collection tier.", "Fetched the transcript over ssh."],
  );
});

test("fetch bookkeeping keeps identical keys from different harnesses separate", async () => {
  const s = scenario();
  await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts, log: s.log }, async () => {
    const discovered = await discoverProject(s.repoRoot, {
      discovery: { hosts: ["mac-home"], harnesses: ["claude"] },
    });
    const claude = discovered.transcripts[0];
    const codex = {
      ...claude,
      harness: "codex",
      nativeId: claude.nativeId,
      remote: { ...claude.remote },
    };

    const stats = await prefetchRemoteTranscripts([claude, codex], { config: discovered.config });
    assert.equal(stats.fetched, 2);
    assert.equal(stats.failed, 0);
    assert.ok(fs.existsSync(claude.remote.cachePath));
    assert.ok(fs.existsSync(codex.remote.cachePath));
    assert.notEqual(claude.remote.cachePath, codex.remote.cachePath);
  });
});

test("a second run reuses the cached copy and makes no fetch call at all", async () => {
  const s = scenario();
  const first = await collectAndFetch(s);
  assert.equal(first.stats.fetched, 1);
  assert.equal(fetchCalls(s.log).length, 1);

  const second = await collectAndFetch(s);
  assert.equal(second.stats.fetched, 0);
  assert.equal(second.stats.reused, 1);
  assert.equal(fetchCalls(s.log).length, 1, "an unchanged remote session must not cross the wire twice");
  assert.ok(fs.existsSync(second.transcripts[0].remote.cachePath));
});

test("a truncated cached payload is refetched instead of reused", async () => {
  const s = scenario();
  const first = await collectAndFetch(s);
  const cached = first.transcripts[0].remote.cachePath;
  const complete = fs.readFileSync(cached);
  fs.writeFileSync(cached, complete.subarray(0, Math.floor(complete.length / 2)));

  const second = await collectAndFetch(s);
  assert.equal(second.stats.reused, 0);
  assert.equal(second.stats.fetched, 1);
  assert.equal(fetchCalls(s.log).length, 2);
  assert.deepEqual(fs.readFileSync(second.transcripts[0].remote.cachePath), complete);
});

test("a torn fetch stream fails that transcript by name and leaves the next run free to refetch", async () => {
  const s = scenario({ variant: { truncateFetch: 40 } });
  const torn = await collectAndFetch(s);

  assert.equal(torn.stats.failed, 1);
  assert.equal(torn.stats.fetched, 0);
  const [transcript] = torn.transcripts;
  assert.equal(transcript.remoteError, "mac-home: remote fetch incomplete");
  await assert.rejects(() => readTranscript(transcript), /remote fetch incomplete/);

  // Nothing was cached, so the next run fetches again rather than reading a prefix.
  s.hosts["mac-home"].truncateFetch = undefined;
  const retried = await collectAndFetch(s);
  assert.equal(retried.stats.fetched, 1);
  assert.equal(retried.transcripts[0].remoteError, undefined);
});

test("a clean terminated stream commits every complete item", async () => {
  const s = scenario();
  writeClaudeSession(s.remoteHome, {
    cwd: s.remoteClone,
    id: "22222222-3333-4444-5555-666666666666",
    prefixText: "Review the second parser fix.",
  });

  const fetched = await collectAndFetch(s);
  assert.equal(fetched.transcripts.length, 2);
  assert.equal(fetched.stats.fetched, 2);
  assert.equal(fetched.stats.failed, 0);
  assert.equal(fetched.transcripts.filter((transcript) => transcript.remote.cachePath).length, 2);
});

test("a missing frame before the terminator fails only that item", async () => {
  const s = scenario({ variant: { omitFetchFrame: 2 } });
  writeClaudeSession(s.remoteHome, {
    cwd: s.remoteClone,
    id: "22222222-3333-4444-5555-666666666666",
    prefixText: "Review the second parser fix.",
  });

  const fetched = await collectAndFetch(s);
  assert.equal(fetched.transcripts.length, 2);
  assert.equal(fetched.stats.fetched, 1);
  assert.equal(fetched.stats.failed, 1);
  assert.equal(fetched.transcripts.filter((transcript) => transcript.remote.cachePath).length, 1);
  assert.equal(
    fetched.transcripts.filter((transcript) => transcript.remoteError === "mac-home: remote fetch incomplete").length,
    1,
  );
});

test("a torn frame body does not discard a complete sibling transcript", async () => {
  const s = scenario({ variant: { truncateFetchFrame: 2 } });
  writeClaudeSession(s.remoteHome, {
    cwd: s.remoteClone,
    id: "22222222-3333-4444-5555-666666666666",
    prefixText: "Review the second parser fix.",
  });

  const torn = await collectAndFetch(s);
  assert.equal(torn.transcripts.length, 2);
  assert.equal(torn.stats.fetched, 1);
  assert.equal(torn.stats.failed, 1);
  assert.equal(
    torn.transcripts.filter((transcript) => transcript.remote.cachePath).length,
    1,
    "the complete frame is committed only after the stream finishes",
  );
  assert.equal(
    torn.transcripts.filter((transcript) => transcript.remoteError === "mac-home: remote fetch incomplete").length,
    1,
  );

  delete s.hosts["mac-home"].truncateFetchFrame;
  const retried = await collectAndFetch(s);
  assert.equal(retried.stats.reused, 1);
  assert.equal(retried.stats.fetched, 1);
  assert.equal(retried.stats.failed, 0);
});

test("a torn frame header does not discard a complete sibling transcript", async () => {
  const s = scenario({ variant: { truncateFetchHeader: 2 } });
  writeClaudeSession(s.remoteHome, {
    cwd: s.remoteClone,
    id: "22222222-3333-4444-5555-666666666666",
    prefixText: "Review the second parser fix.",
  });

  const torn = await collectAndFetch(s);
  assert.equal(torn.transcripts.length, 2);
  assert.equal(torn.stats.fetched, 1);
  assert.equal(torn.stats.failed, 1);
  assert.equal(torn.transcripts.filter((transcript) => transcript.remote.cachePath).length, 1);
  assert.equal(
    torn.transcripts.filter((transcript) => transcript.remoteError === "mac-home: remote fetch incomplete").length,
    1,
  );
});

test("a unicode header torn mid-character preserves its complete sibling", async () => {
  const s = scenario({
    variant: { truncateFetchHeaderMidUnicode: 2 },
    remoteCloneName: "démonstration",
  });
  writeClaudeSession(s.remoteHome, {
    cwd: s.remoteClone,
    id: "22222222-3333-4444-5555-666666666666",
    prefixText: "Review the unicode parser fix.",
  });

  const torn = await collectAndFetch(s);
  assert.equal(torn.stats.fetched, 1);
  assert.equal(torn.stats.failed, 1);
  assert.equal(torn.transcripts.filter((transcript) => transcript.remote.cachePath).length, 1);
  assert.equal(
    torn.transcripts.filter((transcript) => transcript.remoteError === "mac-home: remote fetch incomplete").length,
    1,
  );
});

test("a truncated terminator rejects every otherwise complete item", async () => {
  const s = scenario({ variant: { truncateEndFrame: true } });
  writeClaudeSession(s.remoteHome, {
    cwd: s.remoteClone,
    id: "22222222-3333-4444-5555-666666666666",
    prefixText: "Review the second parser fix.",
  });

  const rejected = await collectAndFetch(s);
  assert.equal(rejected.stats.fetched, 0);
  assert.equal(rejected.stats.failed, 2);
  assert.equal(rejected.transcripts.filter((transcript) => transcript.remote.cachePath).length, 0);
  assert.equal(
    rejected.transcripts.filter((transcript) => transcript.remoteError === "mac-home: remote fetch incomplete").length,
    2,
  );

  delete s.hosts["mac-home"].truncateEndFrame;
  const retried = await collectAndFetch(s);
  assert.equal(retried.stats.reused, 0);
  assert.equal(retried.stats.fetched, 2);
  assert.equal(retried.stats.failed, 0);
});

test("complete frames are rejected unless the fetch terminates successfully", async () => {
  for (const variant of [{ omitEndFrame: true }, { fetchExitCode: 23 }]) {
    const s = scenario({ variant });
    const rejected = await collectAndFetch(s);
    assert.equal(rejected.stats.failed, 1);
    assert.equal(rejected.stats.fetched, 0);
    assert.equal(rejected.transcripts[0].remote.cachePath, undefined);

    delete s.hosts["mac-home"].omitEndFrame;
    delete s.hosts["mac-home"].fetchExitCode;
    const retried = await collectAndFetch(s);
    assert.equal(retried.stats.fetched, 1);
  }
});

test("event-backed fetch updates its signature when the remote database grows", async () => {
  const s = scenario({ harnesses: ["hermes"] });

  await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts, log: s.log }, async () => {
    const discovered = await discoverProject(s.repoRoot, {
      discovery: { hosts: ["mac-home"], harnesses: ["hermes"] },
    });
    const transcript = discovered.transcripts[0];
    const beforeSignature = transcript.contentSignature;
    const beforeEvidence = evidenceKey(transcript, "memory");
    const dbPath = path.join(s.remoteHome, ".hermes", "state.db");
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(`INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)`).run(
        3,
        transcript.nativeId,
        "assistant",
        "A message added after discovery.",
        1_800_000_030,
      );
    } finally {
      db.close();
    }
    const changedAt = new Date(Date.now() + 2_000);
    fs.utimesSync(dbPath, changedAt, changedAt);

    const stats = await prefetchRemoteTranscripts(discovered.transcripts, { config: discovered.config });
    assert.equal(stats.fetched, 1);
    assert.notEqual(transcript.contentSignature, beforeSignature);
    assert.notEqual(evidenceKey(transcript, "memory"), beforeEvidence);
    const fetched = await readTranscript(transcript);
    assert.ok(fetched.events.some((event) => event.text === "A message added after discovery."));
  });
});

test("an event-backed self session is excluded before it reaches the corpus", async () => {
  const s = scenario({ harnesses: ["hermes"] });
  const db = new DatabaseSync(path.join(s.remoteHome, ".hermes", "state.db"));
  try {
    db.prepare("UPDATE messages SET content = ? WHERE id = 1").run(
      `${SELF_SESSION_SENTINEL}\nAnalyze this transcript.`,
    );
  } finally {
    db.close();
  }

  const result = await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts, log: s.log }, () =>
    discoverProject(s.repoRoot, { discovery: { hosts: ["mac-home"], harnesses: ["hermes"] } }),
  );
  assert.deepEqual(result.transcripts, []);
  assert.equal(result.perHost[0].self, 1);
});

test("an unrelated Hermes session update preserves another session's cached events", async () => {
  const s = scenario({ harnesses: ["hermes"] });
  const dbPath = path.join(s.remoteHome, ".hermes", "state.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      `INSERT INTO sessions (id, source, model, system_prompt, title, started_at, ended_at)
       VALUES (?, 'cli', 'claude-sonnet-5', ?, 'second session', ?, ?)`,
    ).run("cli-remote-2", `Current working directory: ${s.remoteClone}\n`, 1_800_000_100, 1_800_000_160);
    const insert = db.prepare(`INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)`);
    insert.run(10, "cli-remote-2", "user", "Second session question.", 1_800_000_110);
    insert.run(11, "cli-remote-2", "assistant", "Second session answer.", 1_800_000_120);
  } finally {
    db.close();
  }

  const first = await collectAndFetch(s);
  assert.equal(first.stats.fetched, 2);
  const signatures = new Map(first.transcripts.map((transcript) => [transcript.nativeId, transcript.contentSignature]));

  const grown = new DatabaseSync(dbPath);
  try {
    grown
      .prepare(`INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)`)
      .run(12, "cli-remote-2", "assistant", "Only the second session changed.", 1_800_000_130);
  } finally {
    grown.close();
  }

  const second = await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts, log: s.log }, async () => {
    const discovered = await discoverProject(s.repoRoot, {
      discovery: { hosts: ["mac-home"], harnesses: ["hermes"] },
    });
    assert.equal(
      discovered.transcripts.find((transcript) => transcript.nativeId === "cli-remote-1").contentSignature,
      signatures.get("cli-remote-1"),
    );
    assert.notEqual(
      discovered.transcripts.find((transcript) => transcript.nativeId === "cli-remote-2").contentSignature,
      signatures.get("cli-remote-2"),
    );
    const stats = await prefetchRemoteTranscripts(discovered.transcripts, { config: discovered.config });
    return { ...discovered, stats };
  });
  assert.equal(second.stats.reused, 1);
  assert.equal(second.stats.fetched, 1);
});

test("one unreadable Cursor session does not drop readable sessions", async () => {
  const s = scenario({ harnesses: ["cursor"] });
  const root = path.join(s.remoteHome, ".cursor", "chats", cwdHash(s.remoteClone));
  const good = path.join(root, "cursor-good");
  const bad = path.join(root, "cursor-bad");
  for (const dir of [good, bad]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ cwd: s.remoteClone, title: path.basename(dir), createdAtMs: 1_800_000_000_000 }),
    );
  }
  const db = new DatabaseSync(path.join(good, "store.db"));
  db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
  db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(
    "one",
    Buffer.from(JSON.stringify({ role: "user", content: "Readable session" })),
  );
  db.close();
  fs.writeFileSync(path.join(bad, "store.db"), "not a sqlite database");

  const result = await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts, log: s.log }, () =>
    discoverProject(s.repoRoot, { discovery: { hosts: ["mac-home"], harnesses: ["cursor"] } }),
  );
  assert.deepEqual(
    result.transcripts.map((transcript) => transcript.nativeId),
    ["cursor-good"],
  );
  assert.ok(result.perHost[0].warnings.some((warning) => /cursor session cursor-bad skipped:/.test(warning)));
  assert.equal(result.perHost[0].error, null);
});

test("Cursor database growth invalidates cached events even when meta.json is unchanged", async () => {
  const s = scenario({ harnesses: ["cursor"] });
  const sessionDir = path.join(s.remoteHome, ".cursor", "chats", cwdHash(s.remoteClone), "cursor-remote-1");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "meta.json"),
    JSON.stringify({ cwd: s.remoteClone, title: "remote cursor", createdAtMs: 1_800_000_000_000 }),
  );
  const dbPath = path.join(sessionDir, "store.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
  db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(
    "one",
    Buffer.from(JSON.stringify({ role: "user", content: "First message" })),
  );
  db.close();

  const first = await collectAndFetch(s);
  assert.equal(first.stats.fetched, 1);
  const metaMtime = fs.statSync(path.join(sessionDir, "meta.json")).mtimeMs;

  const grown = new DatabaseSync(dbPath);
  grown
    .prepare("INSERT INTO blobs (id, data) VALUES (?, ?)")
    .run("two", Buffer.from(JSON.stringify({ role: "assistant", content: "Second message" })));
  grown.close();
  const changedAt = new Date(Date.now() + 2_000);
  fs.utimesSync(dbPath, changedAt, changedAt);

  const second = await collectAndFetch(s);
  assert.equal(second.stats.fetched, 1);
  assert.equal(second.stats.reused, 0);
  assert.equal(fs.statSync(path.join(sessionDir, "meta.json")).mtimeMs, metaMtime);
  const fetched = await readTranscript(second.transcripts[0]);
  assert.deepEqual(
    fetched.events.filter((event) => event.kind === "message").map((event) => event.text),
    ["First message", "Second message"],
  );
});

test("a remote item failure names its host", async () => {
  const s = scenario();
  await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts, log: s.log }, async () => {
    const discovered = await discoverProject(s.repoRoot, {
      discovery: { hosts: ["mac-home"], harnesses: ["claude"] },
    });
    fs.rmSync(discovered.transcripts[0].path);
    const stats = await prefetchRemoteTranscripts(discovered.transcripts, { config: discovered.config });
    assert.equal(stats.failed, 1);
    assert.match(discovered.transcripts[0].remoteError, /^mac-home: /);
    await assert.rejects(() => readTranscript(discovered.transcripts[0]), /mac-home: /);
  });
});

test("scan --json carries the host on each transcript and one perHost row", async () => {
  const s = scenario();
  const output = await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts, log: s.log }, () =>
    execFileSync(
      process.execPath,
      [CLI, "scan", "--json", "--since", "all", "--harness", "claude", "--host", "mac-home"],
      {
        cwd: s.repoRoot,
        encoding: "utf8",
        env: process.env,
      },
    ),
  );
  const parsed = JSON.parse(output);

  assert.equal(parsed.transcripts.length, 1);
  assert.equal(parsed.transcripts[0].host, "mac-home");
  assert.equal(Object.hasOwn(parsed.transcripts[0], "remote"), false);
  assert.equal(parsed.perHost.length, 1);
  assert.equal(parsed.perHost[0].host, "mac-home");
  assert.equal(parsed.perHost[0].error, null);
  assert.equal(parsed.perHost[0].matched, 1);
  assert.match(parsed.perHost[0].node, /^v\d+\./);
});

test("--host none collects locally only, and never spawns ssh", async () => {
  const s = scenario();
  writeClaudeSession(s.localHome, { cwd: s.repoRoot, id: "aaaaaaaa-1111-2222-3333-444444444444" });

  const output = await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts, log: s.log }, () =>
    execFileSync(
      process.execPath,
      [CLI, "scan", "--json", "--since", "all", "--harness", "claude", "--host", "mac-home", "--host", "none"],
      { cwd: s.repoRoot, encoding: "utf8", env: process.env },
    ),
  );
  const parsed = JSON.parse(output);

  assert.deepEqual(parsed.perHost, []);
  assert.equal(parsed.transcripts.length, 1);
  assert.equal(parsed.transcripts[0].host, null);
  assert.deepEqual(sshCalls(s.log), []);
});
