import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { UserError } from "../src/logger.js";
import { readMemoryFile } from "../src/memory.js";
import { buildProposal } from "../src/proposal.js";
import { resolveScope } from "../src/scope.js";
import { State } from "../src/state.js";
import { resolveTarget } from "../src/target.js";
import { skillDescriptionTokens, loadProjectSkills } from "../src/skills.js";
import { estimateTokens } from "../src/tokens.js";
import { measureWorkspace, prepareWorkspace } from "../src/workspace.js";
import { makeRepo, writeIn } from "./helpers/staging.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "backpass.js");
const AGENTS = "# Memory\n\n- Run tests before pushing.\n- Keep the README current.\n";
const DB =
  "---\nname: db\ndescription: Load before touching the database.\n---\n\n- Wrap migrations in a transaction.\n";
const REVIEW = "---\nname: review\ndescription: Load before reviewing a pull request.\n---\n\n- Ask for tests.\n";
const QUOTE = [
  { polarity: "negative", text: "it skipped the migration wrapper", source: "claude · abc · turn 3" },
  { polarity: "negative", text: "and skipped it again in a second session", source: "codex · def · turn 8" },
];
const SUMMARY = {
  analyzedSessions: 4,
  totals: { positive: 0, negative: 2, gapClusters: 0 },
  sources: QUOTE.map((q) => q.source),
  instructions: [],
};

function projectScope(files = {}) {
  const repo = makeRepo({ "AGENTS.md": AGENTS, ".agents/skills/db/SKILL.md": DB, ...files });
  const config = loadConfig(repo.root);
  return { repo, config, scope: resolveScope(repo.root, { scope: "project" }, config, repo) };
}

test("--target resolves only an exact configured memory-file entry or an exact loaded skill name", () => {
  const { scope } = projectScope({ "README.md": "# readme\n", ".agents/skills/review/SKILL.md": REVIEW });
  assert.deepEqual(resolveTarget(undefined, scope), { kind: "surface" });
  assert.deepEqual(resolveTarget("AGENTS.md", scope), { kind: "memory", path: "AGENTS.md" });
  assert.deepEqual(resolveTarget("./AGENTS.md", scope), { kind: "memory", path: "AGENTS.md" });
  assert.deepEqual(resolveTarget("db", scope), { kind: "skill", path: ".agents/skills/db/SKILL.md", name: "db" });
  for (const spec of ["README.md", ".agents/skills/db/SKILL.md", ".agents/skills/db", "d*", "", "DB"]) {
    assert.throws(
      () => resolveTarget(spec, scope),
      (err) =>
        err instanceof UserError &&
        /not a configured memory file or a loaded skill/.test(err.message) &&
        /memory files: AGENTS\.md, CLAUDE\.md · skills: db, review/.test(err.hint),
      spec,
    );
  }
  // Configured is not enough: a targeted run never creates the file it is asked to train.
  assert.throws(() => resolveTarget("CLAUDE.md", scope), /is configured but does not exist/);
});

test("a pointer-only memory target is rejected with its imported canonical file", () => {
  const assertPointerRejected = (scope) =>
    assert.throws(
      () => resolveTarget("CLAUDE.md", scope),
      (err) =>
        err instanceof UserError &&
        /CLAUDE\.md is only a pointer to AGENTS\.md/.test(err.message) &&
        /target AGENTS\.md instead/.test(err.hint),
    );

  assertPointerRejected(projectScope({ "CLAUDE.md": "@AGENTS.md\n" }).scope);

  const repo = makeRepo({ "AGENTS.md": AGENTS, "CLAUDE.md": "@AGENTS.md\n" });
  const config = loadConfig(repo.root, { memoryFiles: ["CLAUDE.md"] });
  assertPointerRejected(resolveScope(repo.root, { scope: "project" }, config, repo));
});

test("a target validates every configured project memory path before narrowing", () => {
  const repo = makeRepo({ "AGENTS.md": AGENTS });
  const config = loadConfig(repo.root, { memoryFiles: ["AGENTS.md", "../private.txt"] });
  const scope = resolveScope(repo.root, { scope: "project" }, config, repo);
  assert.throws(() => resolveTarget("AGENTS.md", scope), /private\.txt resolves outside the project root/);
});

test("a name that is both a skill and a memory file is refused, never picked", () => {
  const { scope } = projectScope({ ".agents/skills/agents/SKILL.md": DB.replace("name: db", "name: AGENTS.md") });
  assert.throws(() => resolveTarget("AGENTS.md", scope), /ambiguous: it names AGENTS\.md and \.agents\/skills\/agents/);
});

test("user scope resolves against the user-level memory files and skill dirs", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-target-home-")));
  writeIn(home, ".agents/AGENTS.md", AGENTS);
  writeIn(home, ".agents/skills/db/SKILL.md", DB);
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  let scope;
  try {
    scope = resolveScope(home, { scope: "user" }, loadConfig(null, {}, { kind: "user" }), null, { home });
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
  assert.deepEqual(resolveTarget("db", scope), { kind: "skill", path: ".agents/skills/db/SKILL.md", name: "db" });
  assert.deepEqual(resolveTarget(".agents/AGENTS.md", scope), { kind: "memory", path: ".agents/AGENTS.md" });
  assert.throws(() => resolveTarget("AGENTS.md", scope), /not a configured memory file/);
});

/** Stage the way `synthesizeProposal` does for `target`, edit the copy, and run the gate. */
function gate({ files = {}, target, edit, annotation }) {
  const { repo, config } = projectScope(files);
  const memoryFile = readMemoryFile(repo.root, "AGENTS.md");
  const skillFiles = loadProjectSkills(repo.root, config.skillsDir);
  const workspace = prepareWorkspace({
    state: new State(repo.root).ensure(),
    repo,
    memoryFile,
    skillsDir: config.skillsDir,
    stagedSkills: target.kind === "skill" ? [target.path] : [],
  });
  edit(workspace.root);
  const measured = measureWorkspace(workspace);
  const context = { memoryFile, config, repo, summary: SUMMARY, measured, skillFiles, target };
  const ids = measured.changes.map((c) => c.id);
  return { repo, memoryFile, skillFiles, workspace, measured, ...buildProposal(annotation(ids), context) };
}

const MEMORY = { kind: "memory", path: "AGENTS.md" };
const SKILL = { kind: "skill", path: ".agents/skills/db/SKILL.md", name: "db" };
const rewrite = (changes) => ({ edits: [{ changes, kind: "rewrite", title: "t", evidence: QUOTE }] });

test("a memory-file target stages no existing skill, still measures a new extract, and refuses re-creating a skill", () => {
  const extract = gate({
    target: MEMORY,
    edit: (root) => {
      assert.equal(fs.existsSync(path.join(root, ".agents/skills/db/SKILL.md")), false);
      assert.ok(fs.existsSync(path.join(root, ".agents/skills")));
      writeIn(root, "AGENTS.md", (text) => text.replace("- Keep the README current.\n", ""));
      writeIn(
        root,
        ".agents/skills/docs/SKILL.md",
        `---\nname: docs\ndescription: Docs.\n---\n\n- Keep the README current.\n`,
      );
    },
    annotation: (ids) => ({ edits: [{ changes: ids, kind: "extract", title: "t", evidence: QUOTE }] }),
  });
  assert.deepEqual(extract.violations, []);
  assert.equal(extract.proposal.target.kind, "memory");
  assert.equal(extract.proposal.edits[0].skills[0].name, "docs");

  const clash = gate({
    target: MEMORY,
    edit: (root) => writeIn(root, ".agents/skills/db/SKILL.md", DB.replace("Wrap", "Always wrap")),
    annotation: (ids) => ({ edits: [{ changes: ids, kind: "extract", title: "t", evidence: QUOTE }] }),
  });
  assert.equal(clash.proposal.edits.length, 0);
  assert.match(clash.violations.join("\n"), /SKILL\.md already exists; existing skills are read-only/);
});

test("a skill target stages that skill only; the proposal keeps the whole-surface budget and refuses every other file", () => {
  const ok = gate({
    files: { ".agents/skills/review/SKILL.md": REVIEW },
    target: SKILL,
    edit: (root) => {
      assert.equal(fs.existsSync(path.join(root, ".agents/skills/review/SKILL.md")), false);
      writeIn(root, ".agents/skills/db/SKILL.md", (text) => text.replace("touching the database", "any SQL"));
    },
    annotation: rewrite,
  });
  assert.deepEqual(ok.violations, []);
  assert.deepEqual(ok.proposal.target, SKILL);
  assert.equal(ok.proposal.edits[0].file, SKILL.path);
  assert.equal(ok.proposal.memoryFile.path, "AGENTS.md");
  const surface = estimateTokens(AGENTS) + skillDescriptionTokens(ok.skillFiles);
  assert.equal(ok.proposal.budget.current, surface);
  assert.equal(ok.proposal.budget.projected, surface + ok.proposal.edits[0].descriptionDelta);

  const widened = gate({
    target: SKILL,
    edit: (root) => writeIn(root, "AGENTS.md", (text) => text.replace("Run tests", "Always run tests")),
    annotation: rewrite,
  });
  assert.equal(widened.proposal.edits.length, 0);
  assert.match(
    widened.violations.join("\n"),
    /targets \.agents\/skills\/db\/SKILL\.md only; AGENTS\.md is out of scope/,
  );

  const created = gate({
    target: SKILL,
    edit: (root) => writeIn(root, ".agents/skills/new/SKILL.md", REVIEW),
    annotation: rewrite,
  });
  assert.match(created.violations.join("\n"), /\.agents\/skills\/new\/SKILL\.md is out of scope/);

  const deletion = gate({
    target: SKILL,
    edit: (root) =>
      writeIn(root, ".agents/skills/db/SKILL.md", (text) => text.replace("- Wrap migrations in a transaction.\n", "")),
    annotation: (ids) => ({ edits: [{ changes: ids, kind: "remove", title: "t", evidence: QUOTE }] }),
  });
  assert.equal(deletion.proposal.edits.length, 0);
  assert.match(deletion.violations.join("\n"), /no evidence can attribute to skill files/);
});

test("the CLI accepts --target only where a run narrows, and refuses it with --memory-file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-target-cli-"));
  writeIn(dir, "AGENTS.md", AGENTS);
  writeIn(dir, ".agents/skills/db/SKILL.md", DB);
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"],
  ]) {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  }
  const run = (...args) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  const status = run("status", "--target", "db");
  assert.notEqual(status.status, 0);
  assert.match(status.stderr, /--target does not apply to status/);
  const combined = run("apply", "--target", "AGENTS.md", "--memory-file", "AGENTS.md");
  assert.match(combined.stderr, /cannot be combined with --memory-file/);
  const unknown = run("apply", "--target", "nope");
  assert.match(unknown.stderr, /not a configured memory file or a loaded skill[\s\S]*skills: db/);
  // Accepted: the target resolves and is announced before apply looks for a proposal.
  const accepted = run("apply", "--target", "db");
  assert.match(accepted.stderr, /targeting skill db \(\.agents\/skills\/db\/SKILL\.md\)[\s\S]*no proposal to apply/);
});
