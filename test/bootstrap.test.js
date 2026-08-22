import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bootstrapRun } from "../src/commands/bootstrap.js";
import { detectRepoFacts, renderPointer, renderStarterMemory } from "../src/bootstrap.js";
import { loadConfig } from "../src/config.js";
import { setLoggerSink } from "../src/logger.js";
import { isPointerTo, parseMemoryUnits } from "../src/memory.js";
import { State } from "../src/state.js";

function makeRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-bootstrap-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return { root: dir, realRoot: dir, name: "demo-repo", worktrees: [dir], remotes: [] };
}

function makeCtx(repo, overrides = {}) {
  const config = loadConfig(repo.root, overrides);
  config.state = new State(repo.root).ensure();
  return { repo, config, flags: {}, version: "test" };
}

function transcript(id) {
  return { id, nativeId: id, harness: "claude", path: `/x/${id}.jsonl`, mtimeMs: 1, bytes: 10, startedAt: 1 };
}

const discoverNone = async () => ({ transcripts: [], perHarness: {} });
const discoverTwo = async () => ({ transcripts: [transcript("s1"), transcript("s2")], perHarness: { claude: {} } });

/** Stands in for the tier-1 model: every session reports the same gap against the starter. */
function fakeAnalyze({ transcripts, memoryFile, config, memoryHash }) {
  for (const t of transcripts) {
    config.state.writeEvidence(t.id, {
      status: "ok",
      transcript: { id: t.id, harness: t.harness, startedAt: t.startedAt },
      memoryHash,
      memoryPath: memoryFile.path,
      positive: [],
      negative: [],
      gaps: [
        {
          mistake: "ran migrations against the shared db",
          proposedInstruction: "Run migrations only against a scratch database.",
          recurrenceRisk: "high",
          quote: "applied the migration to prod-db",
        },
      ],
    });
  }
  return { total: transcripts.length, analyzed: transcripts.length, cached: 0, skipped: 0, failed: 0, usage: [] };
}

function fakeSynthesize(captured) {
  return async ({ memoryFile, summary, runNote }) => {
    captured.runNote = runNote;
    captured.gapClusters = summary.totals.gapClusters;
    const { buildProposal } = await import("../src/proposal.js");
    const { proposal, violations } = buildProposal(
      {
        edits: [
          {
            kind: "rewrite",
            file: memoryFile.path,
            title: "record the migration trap",
            find: "- None recorded yet. backpass adds evidence-backed entries here from real sessions.",
            replace: "- Run migrations only against a scratch database, never the shared one.",
            evidence: [
              { polarity: "negative", text: "applied the migration to prod-db", source: "claude · s1" },
              { polarity: "negative", text: "applied the migration to prod-db", source: "claude · s2" },
            ],
            transcripts: 2,
          },
        ],
      },
      { memoryFile, config: captured.config, repo: captured.repo, summary },
    );
    assert.deepEqual(violations, []);
    return { proposal, violations };
  };
}

function withSink(fn) {
  const lines = [];
  setLoggerSink((l) => lines.push(l));
  return fn().then(
    (r) => {
      setLoggerSink(null);
      return { result: r, lines };
    },
    (e) => {
      setLoggerSink(null);
      throw e;
    },
  );
}

test("starter memory is a real file: purpose, detected facts, conventions, and self-governance", () => {
  const repo = makeRepo({
    "package.json": JSON.stringify({ name: "demo", scripts: { check: "x", test: "y" } }),
    "pnpm-lock.yaml": "",
    "README.md": "# demo",
  });
  const facts = detectRepoFacts(repo.root);
  assert.equal(facts.packageManager, "pnpm");
  const text = renderStarterMemory({ repo, facts });
  assert.match(text, /^# Project agent memory/);
  assert.match(text, /demo-repo/);
  assert.match(text, /`pnpm run check` runs the full local gate/);
  assert.match(text, /`README.md` documents/);
  assert.match(text, /## Conventions/);
  assert.match(text, /## Maintaining this file/);
  assert.ok(parseMemoryUnits(text).length >= 8, "the starter is not a stub");

  const bare = renderStarterMemory({ repo: makeRepo(), facts: detectRepoFacts(makeRepo().root) });
  assert.match(bare, /Read the top-level README/);
  assert.match(bare, /## Maintaining this file/);
});

test("no memory file and no transcripts: seeds AGENTS.md from defaults plus a CLAUDE.md pointer", async () => {
  const repo = makeRepo();
  const ctx = makeCtx(repo);
  const { result, lines } = await withSink(() => bootstrapRun(ctx, { discover: discoverNone }));

  assert.equal(result.seededFrom, "defaults");
  assert.deepEqual(
    result.files.written.map((w) => w.file),
    ["AGENTS.md", "CLAUDE.md"],
  );
  assert.ok(
    lines.some((l) => /no memory file found.*bootstrapping AGENTS\.md from 0 transcript\(s\) \+ defaults/.test(l)),
  );

  const agents = fs.readFileSync(path.join(repo.root, "AGENTS.md"), "utf8");
  assert.match(agents, /## Maintaining this file/);
  const claude = fs.readFileSync(path.join(repo.root, "CLAUDE.md"), "utf8");
  assert.equal(claude, renderPointer("AGENTS.md"));
  assert.equal(isPointerTo(claude, "AGENTS.md"), true);
});

test("with transcripts: analysis gaps become the first evidence-backed instruction", async () => {
  const repo = makeRepo();
  const ctx = makeCtx(repo);
  const captured = { config: ctx.config, repo };
  const { result, lines } = await withSink(() =>
    bootstrapRun(ctx, { discover: discoverTwo, analyze: fakeAnalyze, synthesize: fakeSynthesize(captured) }),
  );

  assert.ok(lines.some((l) => /bootstrapping AGENTS\.md from 2 transcript\(s\) \+ defaults/.test(l)));
  assert.match(captured.runNote, /seeded from generic defaults/);
  assert.equal(captured.gapClusters, 1, "the two sessions' gaps folded into one cluster");
  assert.equal(result.seededFrom, "transcripts + defaults");
  assert.deepEqual(
    result.applied.written.map((w) => w.file),
    ["AGENTS.md"],
  );

  const agents = fs.readFileSync(path.join(repo.root, "AGENTS.md"), "utf8");
  assert.match(agents, /scratch database/);
  assert.doesNotMatch(agents, /None recorded yet/);
  assert.match(agents, /## Maintaining this file/);
  assert.equal(fs.readFileSync(path.join(repo.root, "CLAUDE.md"), "utf8"), renderPointer("AGENTS.md"));

  // The applied proposal is marked so `backpass apply` cannot replay it onto the new file.
  const saved = ctx.config.state.readProposal();
  assert.equal(saved.appliedBy, "bootstrap");
  assert.ok(saved.appliedAt);
});

test("bootstrap never overwrites: a CLAUDE.md that appears is kept, only the missing file is created", async () => {
  const repo = makeRepo({ "CLAUDE.md": "# mine\n" });
  // Config looks only for AGENTS.md, so there is "no memory file" yet CLAUDE.md exists on disk.
  const ctx = makeCtx(repo, { memoryFiles: ["AGENTS.md"] });
  const { result } = await withSink(() => bootstrapRun(ctx, { discover: discoverNone }));

  assert.deepEqual(
    result.files.written.map((w) => w.file),
    ["AGENTS.md"],
  );
  assert.deepEqual(result.files.skipped, [{ file: "CLAUDE.md", reason: "already exists" }]);
  assert.equal(fs.readFileSync(path.join(repo.root, "CLAUDE.md"), "utf8"), "# mine\n");
});

test("a memoryFiles override bootstraps that path, with CLAUDE.md pointing at it", async () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo.root, "docs"));
  const ctx = makeCtx(repo, { memoryFiles: ["docs/AGENTS.md"] });
  const { result } = await withSink(() => bootstrapRun(ctx, { discover: discoverNone }));

  assert.deepEqual(
    result.files.written.map((w) => w.file),
    ["docs/AGENTS.md", "CLAUDE.md"],
  );
  const claude = fs.readFileSync(path.join(repo.root, "CLAUDE.md"), "utf8");
  assert.equal(isPointerTo(claude, "docs/AGENTS.md"), true);
});
