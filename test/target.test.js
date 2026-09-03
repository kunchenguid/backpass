import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { primaryMemoryFile } from "../src/commands/analyze.js";
import { loadConfig } from "../src/config.js";
import { UserError } from "../src/logger.js";
import { readMemoryFile } from "../src/memory.js";
import { buildProposal } from "../src/proposal.js";
import { State } from "../src/state.js";
import { resolveRunTarget } from "../src/target.js";
import { prepareWorkspace, measureWorkspace, workspacePathFor } from "../src/workspace.js";
import { makeRepo, writeIn } from "./helpers/staging.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "backpass.js");

const AGENTS = "# Memory\n\n- Run tests before pushing.\n- Keep the README current.\n";
const DB_SKILL =
  "---\nname: db\ndescription: Load before touching the database.\n---\n\n- Wrap migrations in a transaction.\n";
const REVIEW_SKILL =
  "---\nname: review\ndescription: Load before reviewing a pull request.\n---\n\n- Request tests for behavior changes.\n";

const QUOTE = [
  { polarity: "negative", text: "it skipped the migration wrapper the first time", source: "claude · abc · turn 3" },
  { polarity: "negative", text: "and skipped the wrapper on a second session too", source: "codex · def · turn 8" },
];

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function repoWith(files) {
  const repo = makeRepo({ "AGENTS.md": AGENTS, ...files });
  return repo;
}

function cfg(repo, extra = {}) {
  return loadConfig(repo.root, extra);
}

function summary() {
  return {
    analyzedSessions: 4,
    totals: { positive: 0, negative: 2, gapClusters: 0 },
    sources: ["claude · abc · turn 3", "codex · def · turn 8"],
    instructions: Array.from({ length: 10 }, (_, i) => ({
      instruction: `AG-${String(i + 1).padStart(3, "0")}`,
      positive: 0,
      negative: 4,
      harmSessions: 4,
      sessions: 4,
      relevance: 1,
      quotes: [],
    })),
  };
}

test("resolveRunTarget names one memory file without picking up skills", () => {
  const repo = repoWith({
    ".agents/skills/db/SKILL.md": DB_SKILL,
    ".agents/skills/review/SKILL.md": REVIEW_SKILL,
  });
  const config = cfg(repo);
  const target = resolveRunTarget("AGENTS.md", { repo, config });
  assert.equal(target.kind, "memory");
  assert.equal(target.path, "AGENTS.md");
});

test("resolveRunTarget accepts a skill by name or SKILL.md path", () => {
  const repo = repoWith({
    ".agents/skills/db/SKILL.md": DB_SKILL,
    ".agents/skills/review/SKILL.md": REVIEW_SKILL,
  });
  const config = cfg(repo);
  const byName = resolveRunTarget("db", { repo, config });
  assert.equal(byName.kind, "skill");
  assert.equal(byName.name, "db");
  assert.equal(byName.path, ".agents/skills/db/SKILL.md");
  const byPath = resolveRunTarget(".agents/skills/review/SKILL.md", { repo, config });
  assert.equal(byPath.kind, "skill");
  assert.equal(byPath.name, "review");
  const byDir = resolveRunTarget(".agents/skills/db", { repo, config });
  assert.equal(byDir.path, ".agents/skills/db/SKILL.md");
});

test("resolveRunTarget refuses an unknown name instead of falling back to the whole surface", () => {
  const repo = repoWith({ ".agents/skills/db/SKILL.md": DB_SKILL });
  const config = cfg(repo);
  assert.throws(() => resolveRunTarget("nope", { repo, config }), UserError);
  assert.throws(() => resolveRunTarget("nope", { repo, config }), /not a memory file or skill/);
});

test("resolveRunTarget refuses a name that matches two skills", () => {
  const repo = repoWith({
    ".agents/skills/db/SKILL.md": DB_SKILL,
    ".claude/skills/db/SKILL.md": DB_SKILL.replace("Wrap migrations", "- Also wrap reads"),
  });
  const config = cfg(repo);
  assert.throws(() => resolveRunTarget("db", { repo, config }), /matches 2 skills/);
});

test("a memory-file target stages the memory file and an empty skills dir, not existing skills", () => {
  const repo = repoWith({
    ".agents/skills/db/SKILL.md": DB_SKILL,
    ".agents/skills/review/SKILL.md": REVIEW_SKILL,
  });
  const memoryFile = readMemoryFile(repo.root, "AGENTS.md");
  const workspace = prepareWorkspace({
    state: new State(repo.root).ensure(),
    repo,
    memoryFile,
    skillsDir: ".agents/skills",
    copyExistingSkills: false,
  });
  assert.equal(fs.readFileSync(path.join(workspace.root, "AGENTS.md"), "utf8"), AGENTS);
  assert.ok(fs.existsSync(path.join(workspace.root, ".agents/skills")));
  assert.equal(fs.existsSync(path.join(workspace.root, ".agents/skills/db/SKILL.md")), false);
  assert.equal(fs.existsSync(path.join(workspace.root, ".agents/skills/review/SKILL.md")), false);
  assert.deepEqual([...workspace.originals.keys()], ["AGENTS.md"]);
});

test("a skill target stages that skill as the file under audit and does not copy the memory file or other skills", () => {
  const repo = repoWith({
    ".agents/skills/db/SKILL.md": DB_SKILL,
    ".agents/skills/review/SKILL.md": REVIEW_SKILL,
  });
  const memoryFile = readMemoryFile(repo.root, ".agents/skills/db/SKILL.md");
  const workspace = prepareWorkspace({
    state: new State(repo.root).ensure(),
    repo,
    memoryFile,
    skillsDir: ".agents/skills",
    skillDirs: [],
    copyExistingSkills: false,
  });
  assert.ok(fs.existsSync(path.join(workspace.root, workspacePathFor(memoryFile.path))));
  assert.equal(fs.existsSync(path.join(workspace.root, "AGENTS.md")), false);
  assert.equal(fs.existsSync(path.join(workspace.root, ".agents/skills/review/SKILL.md")), false);
  assert.deepEqual([...workspace.originals.keys()], [".agents/skills/db/SKILL.md"]);
});

test("a whole-surface workspace still copies every skill", () => {
  const repo = repoWith({
    ".agents/skills/db/SKILL.md": DB_SKILL,
    ".agents/skills/review/SKILL.md": REVIEW_SKILL,
  });
  const workspace = prepareWorkspace({
    state: new State(repo.root).ensure(),
    repo,
    memoryFile: readMemoryFile(repo.root, "AGENTS.md"),
    skillsDir: ".agents/skills",
  });
  assert.deepEqual(
    [...workspace.originals.keys()].sort(),
    ["AGENTS.md", ".agents/skills/db/SKILL.md", ".agents/skills/review/SKILL.md"].sort(),
  );
});

test("primaryMemoryFile on a skill target audits that skill and does not hand synthesis the rest of the surface", () => {
  const repo = repoWith({
    ".agents/skills/db/SKILL.md": DB_SKILL,
    ".agents/skills/review/SKILL.md": REVIEW_SKILL,
  });
  const config = cfg(repo);
  config.runTarget = resolveRunTarget("db", { repo, config });
  const resolved = primaryMemoryFile(repo, config);
  assert.equal(resolved.file.path, ".agents/skills/db/SKILL.md");
  assert.deepEqual(resolved.skills, []);
  assert.equal(resolved.allSkills.length, 2);
  assert.equal(resolved.runTarget.kind, "skill");
  assert.notEqual(resolved.hash, primaryMemoryFile(repo, cfg(repo)).hash);
});

test("buildProposal on a memory-file target refuses to recreate an existing skill", () => {
  const repo = repoWith({ ".agents/skills/db/SKILL.md": DB_SKILL });
  const memoryFile = readMemoryFile(repo.root, "AGENTS.md");
  const state = new State(repo.root).ensure();
  const workspace = prepareWorkspace({
    state,
    repo,
    memoryFile,
    skillsDir: ".agents/skills",
    copyExistingSkills: false,
  });
  writeIn(workspace.root, "AGENTS.md", (text) => text.replace("- Keep the README current.\n", ""));
  writeIn(workspace.root, ".agents/skills/db/SKILL.md", DB_SKILL);
  const measured = measureWorkspace(workspace);
  const created = measured.changes.find((c) => c.kind === "created");
  assert.equal(created?.file, ".agents/skills/db/SKILL.md");
  const { proposal, violations } = buildProposal(
    {
      edits: [
        {
          changes: measured.changes.map((c) => c.id),
          kind: "extract",
          title: "extract the readme rule",
          evidence: QUOTE,
        },
      ],
    },
    {
      memoryFile,
      config: { budgetTokens: 5000, maxEditsPerRun: 5, minGapEvidence: 2, skillsDir: ".agents/skills" },
      repo,
      summary: summary(),
      measured,
      runTarget: { kind: "memory", path: "AGENTS.md" },
    },
  );
  assert.equal(proposal.edits.length, 0);
  assert.ok(violations.some((v) => /already exists/.test(v)));
  assert.equal(proposal.target.kind, "memory");
});

test("buildProposal on a skill target ignores a write to the project memory file", () => {
  const repo = repoWith({ ".agents/skills/db/SKILL.md": DB_SKILL });
  const memoryFile = readMemoryFile(repo.root, ".agents/skills/db/SKILL.md");
  const state = new State(repo.root).ensure();
  const workspace = prepareWorkspace({
    state,
    repo,
    memoryFile,
    skillsDir: ".agents/skills",
    skillDirs: [],
    copyExistingSkills: false,
  });
  writeIn(workspace.root, workspacePathFor(memoryFile.path), (text) =>
    text.replace("Wrap migrations in a transaction.", "Wrap every migration in a transaction."),
  );
  writeIn(workspace.root, "AGENTS.md", "# hijack\n");
  const measured = measureWorkspace(workspace);
  assert.ok(measured.stray.includes("AGENTS.md"), "a write to AGENTS.md is stray, not a proposed edit");
  assert.equal(
    measured.changes.some((c) => c.file === "AGENTS.md"),
    false,
  );
  const skillHunk = measured.changes.find((c) => c.kind === "hunk" && c.file === memoryFile.path);
  assert.ok(skillHunk);
  const { proposal, violations } = buildProposal(
    {
      edits: [
        {
          changes: [skillHunk.id],
          kind: "rewrite",
          title: "sharpen the transaction rule",
          evidence: QUOTE,
        },
      ],
    },
    {
      memoryFile,
      config: { budgetTokens: 5000, maxEditsPerRun: 5, minGapEvidence: 2, skillsDir: ".agents/skills" },
      repo,
      summary: summary(),
      measured,
      runTarget: { kind: "skill", path: memoryFile.path, name: "db" },
    },
  );
  assert.deepEqual(violations, []);
  assert.equal(proposal.edits.length, 1);
  assert.equal(proposal.edits[0].file, ".agents/skills/db/SKILL.md");
  assert.equal(proposal.target.kind, "skill");
  assert.equal(proposal.memoryFile.path, ".agents/skills/db/SKILL.md");
  assert.equal(
    proposal.edits.some((e) => e.file === "AGENTS.md" || (e.hunks || []).some((h) => h.file === "AGENTS.md")),
    false,
  );
});

function initGitRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-target-cli-"));
  for (const [name, text] of Object.entries(files)) {
    const absolute = path.join(dir, name);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, text);
  }
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "init"], dir);
  return fs.realpathSync(dir);
}

test("the CLI refuses --target combined with --memory-file, and an unknown target", () => {
  const dir = initGitRepo({
    "AGENTS.md": AGENTS,
    ".agents/skills/db/SKILL.md": DB_SKILL,
  });
  const env = { ...process.env, NO_COLOR: "1", CI: "1" };
  const combined = spawnSync(process.execPath, [CLI, "status", "--target", "AGENTS.md", "--memory-file", "AGENTS.md"], {
    cwd: dir,
    encoding: "utf8",
    env,
  });
  assert.notEqual(combined.status, 0);
  assert.match(`${combined.stdout}${combined.stderr}`, /cannot be combined with --memory-file/);

  const missing = spawnSync(process.execPath, [CLI, "status", "--target", "no-such-skill"], {
    cwd: dir,
    encoding: "utf8",
    env,
  });
  assert.notEqual(missing.status, 0);
  assert.match(`${missing.stdout}${missing.stderr}`, /not a memory file or skill/);

  const ok = spawnSync(process.execPath, [CLI, "status", "--target", "db"], {
    cwd: dir,
    encoding: "utf8",
    env,
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /targeting skill db/);
});
