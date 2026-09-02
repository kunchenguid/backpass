import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { primaryMemoryFile } from "../src/commands/analyze.js";
import { applyDecisions } from "../src/apply/writer.js";
import { loadConfig } from "../src/config.js";
import { setLoggerSink } from "../src/logger.js";
import { isPointerTo, resolveMemoryFiles } from "../src/memory.js";
import { buildProposal } from "../src/proposal.js";
import { renderPointer } from "../src/bootstrap.js";
import { stageAndMeasure, writeIn } from "./helpers/staging.js";

const AGENTS = "# Memory\n\n## Rules\n\n- Run the tests before pushing.\n- Never edit generated files.\n";
const SEPARATE_CLAUDE = "# Claude notes\n\n- Prefer bun over npm.\n";

function repoWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-memres-"));
  for (const [name, text] of Object.entries(files)) {
    const absolute = path.join(dir, name);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, text);
  }
  return { root: dir, realRoot: dir, name: path.basename(dir), worktrees: [dir], remotes: [] };
}

function captureWarnings(fn) {
  const lines = [];
  setLoggerSink((line) => lines.push(line));
  try {
    return { result: fn(), warnings: lines.filter((l) => l.includes("warn")) };
  } finally {
    setLoggerSink(null);
  }
}

/** One evidence-backed edit against AGENTS.md, staged like synthesis and pushed through the real writer. */
function applyOneEdit(repo, config) {
  const { file } = primaryMemoryFile(repo, config);
  const summary = {
    analyzedSessions: 2,
    instructions: [],
    gaps: [],
    totals: { positive: 0, negative: 2, gapClusters: 0 },
  };
  const { measured, state } = stageAndMeasure({
    repo,
    memoryPath: file.path,
    skillsDir: config.skillsDir,
    edit: (root) =>
      writeIn(root, file.path, (t) =>
        t.replace("- Run the tests before pushing.", "- Run the full test suite before pushing."),
      ),
  });
  const { proposal, violations } = buildProposal(
    {
      edits: [
        {
          changes: ["H1"],
          kind: "rewrite",
          title: "tighten",
          evidence: [{ polarity: "negative", text: "skipped tests", source: "claude · s1 · turn 2" }],
          transcripts: 2,
        },
      ],
    },
    { memoryFile: file, config, repo, summary, measured },
  );
  assert.deepEqual(violations, []);
  return applyDecisions({ proposal, decisions: { e1: "accepted" }, repo, state, config });
}

test("isPointerTo accepts the @AGENTS.md import forms and nothing else", () => {
  assert.equal(isPointerTo("@AGENTS.md\n", "AGENTS.md"), true);
  assert.equal(isPointerTo("@./AGENTS.md", "AGENTS.md"), true);
  assert.equal(isPointerTo(renderPointer("AGENTS.md"), "AGENTS.md"), true);
  assert.equal(isPointerTo("\n<!-- c -->\n\n@AGENTS.md\n\n", "AGENTS.md"), true);
  assert.equal(isPointerTo("@AGENTS.md\n- plus a real rule\n", "AGENTS.md"), false);
  assert.equal(isPointerTo("@docs/AGENTS.md", "AGENTS.md"), false);
  assert.equal(isPointerTo(SEPARATE_CLAUDE, "AGENTS.md"), false);
  assert.equal(isPointerTo("", "AGENTS.md"), false);
});

test("a relative pointer resolves from the importing file's directory", () => {
  const repo = repoWith({
    ".agents/AGENTS.md": AGENTS,
    ".claude/CLAUDE.md": renderPointer("AGENTS.md"),
  });

  const relative = resolveMemoryFiles(repo.root, [".agents/AGENTS.md", ".claude/CLAUDE.md"]);
  assert.equal(relative.pointers.length, 0);
  assert.equal(relative.separate.length, 1);
  const { warnings } = captureWarnings(() =>
    primaryMemoryFile(
      repo,
      { memoryFiles: [".agents/AGENTS.md", ".claude/CLAUDE.md"], skillsDir: ".agents/skills" },
      { kind: "user" },
    ),
  );
  assert.match(warnings[0], /@\.\.\/\.agents\/AGENTS\.md/);

  fs.writeFileSync(path.join(repo.root, ".claude/CLAUDE.md"), `@${path.join(repo.root, ".agents/AGENTS.md")}\n`);
  const absolute = resolveMemoryFiles(repo.root, [".agents/AGENTS.md", ".claude/CLAUDE.md"]);
  assert.equal(absolute.pointers.length, 1);
  assert.equal(absolute.separate.length, 0);
});

test("only CLAUDE.md can cover a secondary memory file by import", () => {
  const repo = repoWith({ ".claude/CLAUDE.md": AGENTS, ".codex/AGENTS.md": "@placeholder\n" });
  fs.writeFileSync(path.join(repo.root, ".codex/AGENTS.md"), `@${path.join(repo.root, ".claude/CLAUDE.md")}\n`);
  const resolved = resolveMemoryFiles(repo.root, [".claude/CLAUDE.md", ".codex/AGENTS.md"]);
  assert.equal(resolved.pointers.length, 0);
  assert.deepEqual(
    resolved.separate.map((file) => file.path),
    [".codex/AGENTS.md"],
  );
});

test("CLAUDE.md as a pointer resolves AGENTS.md silently and only AGENTS.md is written", () => {
  const repo = repoWith({ "AGENTS.md": AGENTS, "CLAUDE.md": renderPointer("AGENTS.md") });
  const config = loadConfig(repo.root);

  const { result, warnings } = captureWarnings(() => primaryMemoryFile(repo, config));
  assert.equal(result.file.path, "AGENTS.md");
  assert.deepEqual(warnings, []);
  assert.equal(result.resolved.pointers.length, 1);
  assert.equal(result.resolved.separate.length, 0);

  const written = applyOneEdit(repo, config);
  assert.deepEqual(
    written.written.map((w) => w.file),
    ["AGENTS.md"],
  );
  assert.match(fs.readFileSync(path.join(repo.root, "AGENTS.md"), "utf8"), /full test suite/);
  assert.equal(fs.readFileSync(path.join(repo.root, "CLAUDE.md"), "utf8"), renderPointer("AGENTS.md"));
});

test("two separate full files: AGENTS.md is optimized, CLAUDE.md is left alone with a consolidate warning", () => {
  const repo = repoWith({ "AGENTS.md": AGENTS, "CLAUDE.md": SEPARATE_CLAUDE });
  const config = loadConfig(repo.root);

  const { result, warnings } = captureWarnings(() => primaryMemoryFile(repo, config));
  assert.equal(result.file.path, "AGENTS.md");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /CLAUDE\.md is a separate memory file and will NOT be updated/);
  assert.match(warnings[0], /@AGENTS\.md/);

  const written = applyOneEdit(repo, config);
  assert.deepEqual(
    written.written.map((w) => w.file),
    ["AGENTS.md"],
  );
  assert.equal(fs.readFileSync(path.join(repo.root, "CLAUDE.md"), "utf8"), SEPARATE_CLAUDE);
});

test("a single AGENTS.md or a single CLAUDE.md resolves as before, without warnings", () => {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const repo = repoWith({ [name]: AGENTS });
    const { result, warnings } = captureWarnings(() => primaryMemoryFile(repo, loadConfig(repo.root)));
    assert.equal(result.file.path, name);
    assert.deepEqual(warnings, []);
    assert.equal(result.all.length, 1);
  }
});

test("project memory resolution rejects external paths while user resolution permits them", () => {
  const repo = repoWith({ "AGENTS.md": AGENTS });
  const external = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-external-memory-")), "AGENTS.md");
  fs.writeFileSync(external, AGENTS);

  assert.throws(() => resolveMemoryFiles(repo.root, [external]), /outside the project root/);
  assert.equal(resolveMemoryFiles(repo.root, [external], { allowExternal: true }).primary.absolute, external);
});

test("a configured memoryFiles override still picks its own primary", () => {
  const repo = repoWith({ "AGENTS.md": AGENTS });
  fs.mkdirSync(path.join(repo.root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo.root, "docs", "MEMORY.md"), AGENTS);
  const config = loadConfig(repo.root, { memoryFiles: ["docs/MEMORY.md"] });
  const resolved = resolveMemoryFiles(repo.root, config.memoryFiles);
  assert.equal(resolved.primary.path, "docs/MEMORY.md");
  assert.equal(resolved.all.length, 1);
});

test("no memory file: primaryMemoryFile fails with a pointer to bootstrap", () => {
  const repo = repoWith({});
  assert.throws(() => primaryMemoryFile(repo, loadConfig(repo.root)), /no memory file found/);
  assert.equal(resolveMemoryFiles(repo.root, ["AGENTS.md", "CLAUDE.md"]).primary, null);
});

test("the run hash is the memory surface: skill identity and descriptions move it, bodies do not", () => {
  const skill = (description, body, name = "db") => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
  const repo = repoWith({ "AGENTS.md": AGENTS, ".agents/skills/db/SKILL.md": skill("old trigger", "- body v1") });
  const config = loadConfig(repo.root);

  const noSkills = primaryMemoryFile(repoWith({ "AGENTS.md": AGENTS }), config);
  const v1 = primaryMemoryFile(repo, config);
  assert.notEqual(v1.hash, noSkills.hash, "the skill layer is part of the judged surface");
  assert.equal(v1.skills.length, 1, "the loaded skills ride along with the hash they are part of");

  const humanSkill = path.join(repo.root, ".claude/skills/review/SKILL.md");
  fs.mkdirSync(path.dirname(humanSkill), { recursive: true });
  fs.writeFileSync(humanSkill, skill("review trigger", "- review body", "review"));
  const withHumanSkill = primaryMemoryFile(repo, config);
  assert.equal(withHumanSkill.skills.length, 2, "a real Claude skill root joins the same project memory surface");
  assert.notEqual(withHumanSkill.hash, v1.hash);
  fs.rmSync(path.join(repo.root, ".claude"), { recursive: true });

  fs.writeFileSync(path.join(repo.root, ".agents/skills/db/SKILL.md"), skill("old trigger", "- body v2 changed"));
  const v2 = primaryMemoryFile(repo, config);
  assert.equal(v2.hash, v1.hash, "a body edit invalidates nothing - evidence is never judged against bodies");

  fs.writeFileSync(path.join(repo.root, ".agents/skills/db/SKILL.md"), skill("new trigger", "- body v2 changed"));
  const v3 = primaryMemoryFile(repo, config);
  assert.notEqual(v3.hash, v1.hash, "a description edit invalidates evidence like a memory-file edit does");

  fs.writeFileSync(
    path.join(repo.root, ".agents/skills/db/SKILL.md"),
    skill("new trigger", "- body v2 changed", "database"),
  );
  const v4 = primaryMemoryFile(repo, config);
  assert.notEqual(v4.hash, v3.hash, "a rendered skill rename invalidates evidence carrying the old name");
});
