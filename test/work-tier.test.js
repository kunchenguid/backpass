import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { setLoggerSink } from "../src/logger.js";

import { passesStrict } from "../src/discovery/association.js";
import { ADAPTERS, discoverTranscripts } from "../src/discovery/index.js";
import { workPaths, workTier } from "../src/discovery/work.js";
import { loadConfig } from "../src/config.js";
import { associateUser } from "../src/scope.js";
import { resolveRepo } from "../src/repo.js";
import { State, evidenceKey, isEvidenceFresh } from "../src/state.js";
import { attributeTranscripts } from "../src/nested.js";

/**
 * Tier 2.5: a session that started in no checkout is placed by where its tool calls
 * worked. The fixtures are real git checkouts: this repo, another repo, an undiscovered
 * clone of this repo, and a scratch folder that is no checkout at all.
 */

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function checkout(dir, remote) {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  if (remote) git(["remote", "add", "origin", remote], dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "app.ts"), "export {};\n");
  return fs.realpathSync(dir);
}

function layout() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-work-")));
  const repoRoot = checkout(path.join(base, "demo"), "https://github.com/acme/demo.git");
  const otherRoot = checkout(path.join(base, "other"), "https://github.com/acme/other.git");
  const cloneRoot = checkout(path.join(base, "elsewhere", "demo-copy"), "git@github.com:acme/demo.git");
  const scratch = path.join(base, "scratch");
  fs.mkdirSync(scratch);
  return { base, repoRoot, otherRoot, cloneRoot, scratch, repo: resolveRepo(repoRoot) };
}

test("a session is a candidate only when it started in a live directory inside no checkout", () => {
  const { repo, otherRoot, scratch } = layout();
  const tier = workTier(repo, { wsl: null });
  assert.equal(tier.isCandidate({ cwd: scratch }), true);
  assert.equal(tier.isCandidate({ cwd: otherRoot }), false, "a checkout of another repo owns its sessions");
  assert.equal(tier.isCandidate({ cwd: path.join(otherRoot, "src") }), false);
  assert.equal(tier.isCandidate({ cwd: scratch, gitRoot: otherRoot }), false, "so does a recorded root inside one");
  assert.equal(
    tier.isCandidate({ cwd: scratch, remotes: ["https://github.com/acme/other.git"] }),
    false,
    "a recorded remote names the session's repository",
  );
  assert.equal(tier.isCandidate({ cwd: path.join(scratch, "gone") }), false, "a dead cwd is tier 3 territory");
  assert.equal(tier.isCandidate({ cwd: "scratch" }), false, "a relative cwd names nothing");
  assert.equal(tier.isCandidate({ cwd: "C:\\Users\\me\\setup" }), false, "neither does a Windows path off WSL");
});

test("the session belongs here when this repo's checkouts hold most of its checkout paths", () => {
  const { repo, repoRoot, otherRoot, cloneRoot, scratch } = layout();
  const tier = workTier(repo, { wsl: null });
  const here = (...names) => names.map((name) => path.join(repoRoot, name));

  const worked = tier.associate([...here("src/app.ts", "src/new.ts", "README.md"), path.join(otherRoot, "src/app.ts")]);
  assert.equal(worked.tier, 2.5);
  assert.equal(worked.confidence, "work");
  assert.equal(worked.reason, `tool calls worked in ${repoRoot} (3 of 4 paths in a checkout)`);
  assert.equal(passesStrict(worked, true), true, "deterministic, so --strict keeps it");

  assert.equal(
    tier.associate([...here("src/app.ts"), path.join(otherRoot, "a.ts"), path.join(otherRoot, "b.ts")]),
    null,
    "most of the work was in another repository",
  );
  assert.equal(tier.associate([...here("src/app.ts"), path.join(otherRoot, "a.ts")]), null, "a tie is no majority");
  assert.equal(
    tier.associate([path.join(scratch, "notes.md"), "/tmp/backpass-work-scratch.txt"]),
    null,
    "paths in no checkout place nothing",
  );
  assert.equal(
    tier.associate([...here("src/app.ts"), path.join(scratch, "a"), path.join(scratch, "b")])?.tier,
    2.5,
    "scratch paths count for neither side",
  );
  assert.equal(
    tier.associate([path.join(cloneRoot, "src/app.ts")])?.tier,
    2.5,
    "a checkout that shares a remote with this repo is this repo, discovered or not",
  );
  assert.equal(
    tier.associate(here("src/deleted/since.ts"))?.tier,
    2.5,
    "a file deleted since still lies in its checkout",
  );
});

test("checkout ownership follows symlinks for cwd, recorded roots, and tool paths", () => {
  const { repo, repoRoot, otherRoot, scratch } = layout();
  const tier = workTier(repo);
  for (const [name, root] of [
    ["ours", repoRoot],
    ["theirs", otherRoot],
  ]) {
    const link = path.join(scratch, name);
    fs.symlinkSync(path.join(root, "src"), link, "junction");
    assert.equal(tier.isCandidate({ cwd: link }), false);
    assert.equal(tier.isCandidate({ cwd: scratch, gitRoot: link }), false);
    assert.equal(tier.isCandidate({ cwd: scratch, gitRoot: path.join(link, "missing") }), false);
    for (const file of ["app.ts", "missing/new.ts"]) {
      const linkedPath = path.join(link, file);
      assert.deepEqual(tier.associate([linkedPath]), tier.associate([path.join(root, "src", file)]));
      assert.equal(
        tier.associate([path.join(repoRoot, "src/app.ts"), linkedPath])?.tier ?? null,
        root === repoRoot ? 2.5 : null,
      );
    }
  }
  const fileLink = path.join(scratch, "app.ts");
  fs.symlinkSync(path.join(otherRoot, "src/app.ts"), fileLink, "file");
  assert.equal(tier.associate([path.join(repoRoot, "src/app.ts"), fileLink]), null);
});

test("physical path votes are distinct on both sides, including file links and nonexistent descendants", () => {
  const { repo, repoRoot, otherRoot, scratch } = layout();
  const tier = workTier(repo);
  for (const [root, opponent] of [
    [repoRoot, otherRoot],
    [otherRoot, repoRoot],
  ]) {
    const dirLink = path.join(scratch, path.basename(root));
    fs.symlinkSync(path.join(root, "src"), dirLink, "junction");
    const fileLink = `${dirLink}.ts`;
    fs.symlinkSync(path.join(root, "src/app.ts"), fileLink, "file");
    for (const file of ["app.ts", "missing/new.ts"]) {
      const paths = [path.join(root, "src", file), path.join(dirLink, file), path.join(opponent, "src/app.ts")];
      if (file === "app.ts") paths.push(fileLink);
      assert.equal(tier.associate(paths), null, "aliases cannot turn a tie into a majority on either side");
    }
    const paths = [
      path.join(root, "src/app.ts"),
      path.join(dirLink, "app.ts"),
      path.join(opponent, "src/app.ts"),
      path.join(opponent, "src/new.ts"),
    ];
    assert.equal(tier.associate(paths)?.tier ?? null, opponent === repoRoot ? 2.5 : null);
  }
});

test("work paths are the structured tool-call paths, resolved the way nested attribution resolves them", () => {
  const { repoRoot, scratch } = layout();
  const unc = `\\\\wsl.localhost\\Ubuntu${repoRoot.replaceAll("/", "\\")}`;
  const events = [
    { kind: "tool", name: "read", input: { path: `${unc}\\src\\app.ts` } },
    { kind: "tool", name: "edit", input: { filePath: "notes.md" } },
    { kind: "tool", name: "grep", input: { path: "src", workdir: repoRoot } },
    {
      kind: "tool",
      name: "apply_patch",
      input: `*** Begin Patch\n*** Add File: ${repoRoot}/src/new.ts\n*** End Patch`,
    },
    { kind: "tool", name: "shell", input: { command: `cd ${repoRoot} && npm test` } },
    { kind: "tool", name: "read", input: { path: "~/secrets.txt" } },
    { kind: "message", role: "user", text: `look at ${repoRoot}/README.md` },
  ];
  const wsl = { distro: "Ubuntu", drives: new Map() };
  assert.deepEqual(workPaths({ cwd: scratch }, events, { wsl }).sort(), [
    path.join(repoRoot, "src"),
    path.join(repoRoot, "src", "app.ts"),
    path.join(repoRoot, "src", "new.ts"),
    path.join(scratch, "notes.md"),
  ]);
});

function writePiSession(home, { id, cwd, paths = [], tools = [] }) {
  const dir = path.join(home, ".pi", "agent", "sessions", `-${cwd.replaceAll("/", "-")}--`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-09-29T10-00-00-000Z_${id}.jsonl`);
  const lines = [
    { type: "session", version: 3, id, timestamp: "2026-09-29T10:00:00.000Z", cwd },
    { type: "message", message: { role: "user", content: [{ type: "text", text: `Do the ${id} work.` }] } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          ...paths.map((p, index) => ({ type: "toolCall", id: `t${index}`, name: "edit", arguments: { path: p } })),
          ...tools.map((tool, index) => ({ type: "toolCall", id: `extra${index}`, ...tool })),
        ],
      },
    },
  ];
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return file;
}

test("discovery keeps a session that worked here from outside every checkout, and nothing else it did not", async () => {
  const { base, repo, repoRoot, otherRoot, scratch } = layout();
  const home = path.join(base, "home");
  const orchestrator = writePiSession(home, {
    id: "orchestrator",
    cwd: scratch,
    paths: [`${repoRoot}/src/app.ts`, `${repoRoot}/src/new.ts`, `${otherRoot}/src/app.ts`, `${scratch}/plan.md`],
  });
  writePiSession(home, { id: "unrelated", cwd: scratch, paths: [`${otherRoot}/src/app.ts`, `${scratch}/plan.md`] });
  writePiSession(home, { id: "other-repo", cwd: otherRoot, paths: [`${repoRoot}/src/app.ts`] });
  const linkedCwd = path.join(scratch, "api");
  fs.symlinkSync(path.join(otherRoot, "src"), linkedCwd, "junction");
  writePiSession(home, { id: "linked-other-repo", cwd: linkedCwd, paths: [`${repoRoot}/src/app.ts`] });
  writePiSession(home, { id: "plain", cwd: repoRoot, paths: [] });

  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const config = loadConfig(repoRoot, { discovery: { harnesses: ["pi"], since: "all" } });
    let stored = { version: 1, entries: {} };
    config.state = {
      root: path.join(repoRoot, ".backpass"),
      readScanCache: () => stored,
      writeScanCache: (cache) => {
        stored = structuredClone(cache);
      },
    };

    const first = await discoverTranscripts({ repo, config, strict: true });
    const tiers = Object.fromEntries(first.transcripts.map((t) => [t.nativeId, t.association.tier]));
    assert.deepEqual(tiers, { orchestrator: 2.5, plain: 1 });
    const worked = first.transcripts.find((t) => t.nativeId === "orchestrator");
    assert.equal(worked.association.confidence, "work");
    assert.equal(first.perHarness.pi.matched, 2);
    assert.equal(first.perHarness.pi.skipped, 3, "unrelated sessions and other checkouts are not this repo's");
    assert.equal(Object.keys(stored.work).length, 2, "both scratch-folder sessions' work paths are cached");

    const other = await discoverTranscripts({ repo: resolveRepo(otherRoot), config, strict: true });
    assert.equal(other.transcripts.find((t) => t.nativeId === "linked-other-repo")?.association.tier, 1);

    // Same content signature: the cached work paths stand without reading the file again.
    if (process.getuid?.() !== 0) {
      fs.chmodSync(orchestrator, 0o000);
      try {
        const second = await discoverTranscripts({ repo, config, strict: true });
        assert.equal(second.transcripts.find((t) => t.nativeId === "orchestrator")?.association.tier, 2.5);
      } finally {
        fs.chmodSync(orchestrator, 0o644);
      }
    }
  } finally {
    process.env.HOME = previousHome;
  }
});

function cachedDiscovery(t, direct) {
  const { base, repo, repoRoot, scratch } = layout();
  const file = writePiSession(path.join(base, "home"), {
    id: "cached",
    cwd: scratch,
    paths: [path.join(repoRoot, "src/app.ts")],
  });
  const original = ADAPTERS.pi;
  const enumerate = () => {
    const stat = fs.statSync(file);
    return [{ key: file, path: file, mtimeMs: stat.mtimeMs, bytes: stat.size }];
  };
  const adapter = { ...original, enumerate };
  if (direct) {
    adapter.discover = ({ cutoffMs }) =>
      enumerate()
        .filter((row) => !cutoffMs || row.mtimeMs >= cutoffMs)
        .map((row) => ({ ...row, ...original.classify(row), contentSignature: `${row.mtimeMs}:${row.bytes}` }));
  }
  ADAPTERS.pi = adapter;
  t.after(() => {
    ADAPTERS.pi = original;
  });
  const read = t.mock.method(adapter, "read");
  const config = loadConfig(repoRoot, { discovery: { harnesses: ["pi"], since: "all" } });
  let stored = { version: 1, entries: {} };
  config.state = {
    root: path.join(repoRoot, ".backpass"),
    readScanCache: () => structuredClone(stored),
    writeScanCache: (cache) => {
      stored = structuredClone(cache);
    },
  };
  return {
    adapter,
    config,
    read,
    file,
    cache: () => stored,
    scan: (options = {}) => discoverTranscripts({ repo, config, strict: true, ...options }),
  };
}

test("discovery retries an actual file read failure and names it", async (t) => {
  const fixture = cachedDiscovery(t, false);
  const warnings = [];
  setLoggerSink((line) => warnings.push(line));
  t.after(() => setLoggerSink(null));
  const originalRead = fs.readFileSync;
  const diskRead = t.mock.method(fs, "readFileSync", function (file, ...args) {
    if (file === fixture.file) throw new Error("EACCES: transcript unreadable");
    return originalRead.call(this, file, ...args);
  });
  const failed = await fixture.scan();
  diskRead.mock.restore();
  assert.equal(failed.transcripts.length, 0);
  assert.deepEqual(fixture.cache().work || {}, {});
  assert.ok(warnings.some((line) => line.includes("pi") && line.includes("cached") && line.includes("EACCES")));
  assert.equal((await fixture.scan()).transcripts[0]?.association.tier, 2.5);
});

test("SQLite content changes invalidate only work paths while transcript signatures stay adapter-owned", async (t) => {
  const { base, repo, repoRoot, otherRoot, scratch } = layout();
  const home = path.join(base, "hermes");
  fs.mkdirSync(home);
  const previousHome = process.env.HERMES_HOME;
  process.env.HERMES_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHome;
  });
  const db = new DatabaseSync(path.join(home, "state.db"));
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE sessions (id TEXT, source TEXT, model TEXT, model_config TEXT,
      system_prompt TEXT, title TEXT, started_at REAL, ended_at REAL, cwd TEXT);
    CREATE TABLE messages (id INTEGER, session_id TEXT, role TEXT, content TEXT,
      tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL);
  `);
  db.prepare("INSERT INTO sessions VALUES ('s', 'cli', NULL, NULL, NULL, NULL, 100, 100, ?)").run(scratch);
  db.exec("INSERT INTO messages VALUES (1, 's', 'assistant', '', NULL, NULL, NULL, 100)");
  const update = (root, file = "src/app.ts") =>
    db
      .prepare("UPDATE messages SET tool_calls = ?")
      .run(
        JSON.stringify([
          { id: "t", function: { name: "read", arguments: JSON.stringify({ path: path.join(root, file) }) } },
        ]),
      );
  const original = ADAPTERS.hermes;
  ADAPTERS.hermes = { ...original };
  const read = t.mock.method(ADAPTERS.hermes, "read");
  t.after(() => {
    ADAPTERS.hermes = original;
  });
  const config = loadConfig(repoRoot, { discovery: { harnesses: ["hermes"], since: "all" } });
  config.state = new State(repoRoot);
  const scan = (options = {}) => discoverTranscripts({ repo, config, strict: true, ...options });
  update(repoRoot);
  const placed = (await scan()).transcripts[0];
  assert.equal(placed?.association.tier, 2.5);
  const evidence = { status: "ok", key: evidenceKey({ ...placed, contentSignature: null }, "memory") };
  assert.equal(placed.contentSignature, null);
  assert.equal(isEvidenceFresh(evidence, placed, "memory"), true, "existing timestamp-keyed evidence stays fresh");
  assert.deepEqual((await attributeTranscripts([placed], repo, config.state)).get(placed.identity), ["src/app.ts"]);
  assert.equal(isEvidenceFresh(evidence, (await scan()).transcripts[0], "memory"), true);
  update(repoRoot, "src/new.ts");
  const changed = (await scan()).transcripts[0];
  assert.equal(changed.mtimeMs, placed.mtimeMs);
  assert.equal(changed.bytes, placed.bytes);
  assert.equal(changed.contentSignature, null);
  assert.equal(isEvidenceFresh(evidence, changed, "memory"), true, "work hashes do not change evidence keys");
  const attributionReads = read.mock.callCount();
  assert.deepEqual((await attributeTranscripts([changed], repo, config.state)).get(changed.identity), ["src/app.ts"]);
  assert.equal(read.mock.callCount(), attributionReads, "existing nested attribution stays cached");
  read.mock.resetCalls();
  update(otherRoot);
  assert.equal((await scan()).transcripts.length, 0, "changed tool input must not reuse the old majority");
  update(repoRoot);
  assert.equal((await scan()).transcripts[0]?.association.tier, 2.5);
  await scan();
  assert.equal(read.mock.callCount(), 3, "each SQLite candidate is read only once per scan, including cache hits");

  const userScope = { kind: "user", associate: associateUser };
  const userPlaced = (await scan({ scope: userScope, strict: false })).transcripts[0];
  assert.equal(userPlaced.association.tier, 3);
  assert.equal(evidenceKey(userPlaced, "memory"), evidence.key, "signatures do not depend on association tier");
  for (const scope of [null, userScope]) {
    db.prepare("UPDATE sessions SET cwd = ?").run(repoRoot);
    update(repoRoot);
    const ordinary = (await scan({ scope })).transcripts[0];
    assert.equal(ordinary.association.tier, 1);
    const cached = { status: "ok", key: evidenceKey(ordinary, "memory") };
    assert.deepEqual((await attributeTranscripts([ordinary], repo, config.state)).get(ordinary.identity), [
      "src/app.ts",
    ]);
    assert.equal(isEvidenceFresh(cached, (await scan({ scope })).transcripts[0], "memory"), true);
    update(repoRoot, "src/new.ts");
    const revised = (await scan({ scope })).transcripts[0];
    assert.equal(revised.mtimeMs, ordinary.mtimeMs);
    assert.equal(revised.contentSignature, null);
    assert.equal(isEvidenceFresh(cached, revised, "memory"), true);
    assert.deepEqual((await attributeTranscripts([revised], repo, config.state)).get(revised.identity), ["src/app.ts"]);
  }
  db.prepare("UPDATE sessions SET cwd = ?").run(scratch);
  update(repoRoot);

  const prior = config.state.readScanCache().work;
  const warnings = [];
  setLoggerSink((line) => warnings.push(line));
  t.after(() => setLoggerSink(null));
  // Discovery still works, but the read query fails after its header was classified.
  db.exec("ALTER TABLE messages RENAME COLUMN tool_calls TO broken");
  assert.equal((await scan()).transcripts.length, 0);
  assert.deepEqual(config.state.readScanCache().work, prior);
  assert.ok(warnings.some((line) => line.includes("hermes") && line.includes("tool_calls")));
  read.mock.resetCalls();
  assert.equal((await scan({ scope: userScope, strict: false })).transcripts[0]?.association.tier, 3);
  db.prepare("UPDATE sessions SET cwd = ?").run(repoRoot);
  for (const scope of [null, userScope]) {
    assert.equal((await scan({ scope })).transcripts[0]?.association.tier, 1);
  }
  assert.equal(read.mock.callCount(), 0, "already-associated sessions need no SQLite event read at scan time");
  db.prepare("UPDATE sessions SET cwd = ?").run(scratch);
  db.exec("ALTER TABLE messages RENAME COLUMN broken TO tool_calls");
  assert.equal((await scan()).transcripts[0]?.association.tier, 2.5);

  t.mock.method(ADAPTERS.hermes, "discover", async (options) =>
    (await original.discover(options)).map((row) => ({ ...row, contentSignature: "adapter-owned" })),
  );
  assert.equal((await scan()).transcripts[0].contentSignature, "adapter-owned");
  assert.equal((await scan({ scope: userScope, strict: false })).transcripts[0].contentSignature, "adapter-owned");
  update(otherRoot);
  assert.equal((await scan()).transcripts.length, 0, "work paths still use the freshly read events' hash");
});

test("Cursor CLI SQLite edits invalidate only work-cache misses despite unchanged file headers", async (t) => {
  const { base, repo, repoRoot, scratch } = layout();
  const dir = path.join(base, "cursor-session");
  fs.mkdirSync(dir);
  const meta = path.join(dir, "meta.json");
  fs.writeFileSync(meta, JSON.stringify({ cwd: repoRoot }));
  const db = new DatabaseSync(path.join(dir, "store.db"));
  t.after(() => db.close());
  db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
  const update = (text) =>
    db
      .prepare("INSERT OR REPLACE INTO blobs VALUES ('message', ?)")
      .run(JSON.stringify({ role: "user", content: text }));
  const original = ADAPTERS.cursor;
  ADAPTERS.cursor = {
    ...original,
    enumerate: () => {
      const stat = fs.statSync(meta);
      return [{ key: dir, path: dir, mtimeMs: stat.mtimeMs, bytes: stat.size }];
    },
  };
  t.after(() => {
    ADAPTERS.cursor = original;
  });
  const config = loadConfig(repoRoot, { discovery: { harnesses: ["cursor"], since: "all" } });
  config.state = new State(repoRoot);
  const scan = () => discoverTranscripts({ repo, config, strict: true });
  update("Original request");
  const first = (await scan()).transcripts[0];
  assert.equal(first.association.tier, 1);
  const evidence = { status: "ok", key: evidenceKey({ ...first, contentSignature: null }, "memory") };
  assert.equal(first.contentSignature, null);
  assert.equal(isEvidenceFresh(evidence, (await scan()).transcripts[0], "memory"), true);
  update("Revised request");
  const revised = (await scan()).transcripts[0];
  assert.equal(revised.mtimeMs, first.mtimeMs);
  assert.equal(revised.bytes, first.bytes);
  assert.equal(revised.contentSignature, null);
  assert.equal(isEvidenceFresh(evidence, revised, "memory"), true);
  db.exec("ALTER TABLE blobs RENAME TO unreadable");
  assert.equal((await scan()).transcripts[0]?.association.tier, 1, "associated sessions need no signing read");
  db.exec("ALTER TABLE unreadable RENAME TO blobs");

  fs.writeFileSync(meta, JSON.stringify({ cwd: scratch }));
  assert.equal((await scan()).transcripts.length, 0);
  const prior = config.state.readScanCache().work;
  update("Another request");
  assert.equal((await scan()).transcripts.length, 0);
  const refreshed = config.state.readScanCache().work;
  assert.notEqual(refreshed[first.identity].content, prior[first.identity].content);
  await scan();
  assert.deepEqual(config.state.readScanCache().work, refreshed);
});

test("discovery counts symlink aliases once and never treats shell patch text as work", async (t) => {
  const { base, repo, repoRoot, otherRoot, scratch } = layout();
  const home = path.join(base, "home");
  const original = ADAPTERS.pi;
  const files = [];
  ADAPTERS.pi = {
    ...original,
    enumerate: () =>
      files.map((file) => ({
        key: file,
        path: file,
        mtimeMs: fs.statSync(file).mtimeMs,
        bytes: fs.statSync(file).size,
      })),
  };
  t.after(() => {
    ADAPTERS.pi = original;
  });
  const link = path.join(scratch, "alias");
  fs.symlinkSync(path.join(repoRoot, "src"), link, "junction");
  for (const file of ["app.ts", "missing/new.ts"]) {
    files.push(
      writePiSession(home, {
        id: file.replaceAll("/", "-"),
        cwd: scratch,
        paths: [path.join(repoRoot, "src", file), path.join(link, file), path.join(otherRoot, "src/app.ts")],
      }),
    );
  }
  const patch = `*** Begin Patch\n*** Add File: ${path.join(repoRoot, "src/new.ts")}\n*** End Patch`;
  for (const [id, name, args] of [
    ["shell-object", "shell", { command: `cat <<'PATCH'\n${patch}\nPATCH` }],
    ["shell-string", "shell", patch],
    ["write-content", "write", { path: path.join(scratch, "example.md"), content: patch }],
    ["real-patch", "apply_patch", patch],
    ["object-patch", "apply_patch", { patch, workdir: scratch }],
  ]) {
    files.push(writePiSession(home, { id, cwd: scratch, tools: [{ name, arguments: args }] }));
  }
  const config = loadConfig(repoRoot, { discovery: { harnesses: ["pi"], since: "all" } });
  config.state = new State(repoRoot);
  for (let scan = 0; scan < 2; scan++) {
    const result = await discoverTranscripts({ repo, config, strict: true });
    assert.deepEqual(result.transcripts.map((item) => item.nativeId).sort(), ["object-patch", "real-patch"]);
  }
});

for (const direct of [false, true]) {
  const store = direct ? "direct store" : "file store";

  test(`${store}: failed work reads are retried without changing content`, async (t) => {
    const fixture = cachedDiscovery(t, direct);
    fixture.read.mock.mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY");
    });
    const failed = await fixture.scan();
    assert.equal(failed.transcripts.length, 0);
    assert.equal(failed.perHarness.pi.skipped, 1);
    assert.deepEqual(fixture.cache().work || {}, {});
    const recovered = await fixture.scan();
    assert.equal(recovered.transcripts[0]?.association.tier, 2.5);
    await fixture.scan();
    assert.equal(fixture.read.mock.callCount(), 2);

    const prior = structuredClone(fixture.cache().work);
    fs.appendFileSync(fixture.file, "\n");
    fixture.read.mock.mockImplementationOnce(() => {
      throw new Error("EMFILE");
    });
    assert.equal((await fixture.scan()).transcripts.length, 0);
    assert.deepEqual(fixture.cache().work, prior);
    assert.equal((await fixture.scan()).transcripts[0]?.association.tier, 2.5);
    await fixture.scan();
    assert.equal(fixture.read.mock.callCount(), 4);
  });

  test(`${store}: partial scans preserve work entries`, async (t) => {
    const fixture = cachedDiscovery(t, direct);
    await fixture.scan();
    const prior = structuredClone(fixture.cache().work);
    await fixture.scan({ harnesses: [] });
    assert.deepEqual(fixture.cache().work, prior);
    fixture.config.discovery.since = "1d";
    await fixture.scan({ now: Date.now() + 10 * 86400000 });
    assert.deepEqual(fixture.cache().work, prior);
    fixture.config.discovery.since = "all";
    const method = direct ? "discover" : "enumerate";
    t.mock.method(fixture.adapter, method).mock.mockImplementationOnce(() => {
      throw new Error("store unavailable");
    });
    const failed = await fixture.scan();
    assert.equal(failed.perHarness.pi.error, "store unavailable");
    assert.deepEqual(fixture.cache().work, prior);
    assert.equal((await fixture.scan()).transcripts[0]?.association.tier, 2.5);
    assert.equal(fixture.read.mock.callCount(), 1);
  });

  test(`${store}: missing or stale resolver versions refresh cached work paths`, async (t) => {
    const fixture = cachedDiscovery(t, direct);
    await fixture.scan();
    const [identity] = Object.keys(fixture.cache().work);
    for (const version of [undefined, -1]) {
      fixture.cache().work[identity].version = version;
      fixture.cache().work[identity].paths = [];
      assert.equal((await fixture.scan()).transcripts[0]?.association.tier, 2.5);
    }
    await fixture.scan();
    assert.equal(fixture.read.mock.callCount(), 3);

    fs.appendFileSync(fixture.file, "\n");
    fixture.read.mock.mockImplementationOnce(() => ({ events: [] }));
    assert.equal((await fixture.scan()).transcripts.length, 0);
    assert.equal((await fixture.scan()).transcripts.length, 0);
    assert.equal(fixture.read.mock.callCount(), 4, "successfully read empty paths are cached");
  });
}
