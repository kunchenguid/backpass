import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CANONICAL_SKILLS_DIR,
  CLAUDE_SKILLS_LINK,
  CLAUDE_SKILLS_LINK_TARGET,
  ensureSkillsLayout,
  loadSkills,
  parseFrontmatter,
  renderSkillFile,
  resolveOverflowTarget,
  writeSkill,
} from "../src/skills.js";
import { applyDecisions } from "../src/apply/writer.js";
import { DEFAULT_CONFIG } from "../src/config.js";

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "backpass-skills-"));
}

const SKILL = {
  name: "release-signing",
  description: "Use when signing a release\nor rotating the signing key.",
  body: "# Release signing\n\n1. Fetch the key.\n2. Sign the tarball.\n",
  path: `${CANONICAL_SKILLS_DIR}/release-signing/SKILL.md`,
};

test("the default skills dir is the auto-loaded .agents/skills", () => {
  assert.equal(DEFAULT_CONFIG.skillsDir, CANONICAL_SKILLS_DIR);
});

test("generated SKILL.md frontmatter marks the skill non-invocable and internal", () => {
  const text = renderSkillFile(SKILL);
  const lines = text.split("\n");
  assert.equal(lines[0], "---");
  assert.ok(lines.includes("user-invocable: false"), text);
  const metadataAt = lines.indexOf("metadata:");
  assert.ok(metadataAt > 0, text);
  assert.equal(lines[metadataAt + 1], "  internal: true");
  assert.equal(lines[metadataAt + 2], "---");
  const frontmatter = parseFrontmatter(text);
  assert.equal(frontmatter.name, "release-signing");
  assert.equal(frontmatter.description, "Use when signing a release or rotating the signing key.");
  assert.equal(frontmatter["user-invocable"], "false");
  assert.ok(text.endsWith("2. Sign the tarball.\n"));
});

test("writeSkill lands in .agents/skills and links .claude/skills to it", () => {
  const root = tmpRepo();
  const result = writeSkill(root, SKILL);

  const canonical = path.join(root, CANONICAL_SKILLS_DIR, "release-signing", "SKILL.md");
  assert.equal(result.target, canonical);
  assert.ok(fs.existsSync(canonical));
  assert.ok(!fs.existsSync(path.join(root, "skills")));

  const link = path.join(root, CLAUDE_SKILLS_LINK);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readlinkSync(link), CLAUDE_SKILLS_LINK_TARGET);
  assert.equal(fs.readFileSync(path.join(link, "release-signing", "SKILL.md"), "utf8"), renderSkillFile(SKILL));
  assert.deepEqual(result.created, [CANONICAL_SKILLS_DIR, `${CLAUDE_SKILLS_LINK} -> ${CLAUDE_SKILLS_LINK_TARGET}`]);
  assert.deepEqual(result.warnings, []);

  // Both harness views index the same single file.
  assert.deepEqual(
    loadSkills(root, CLAUDE_SKILLS_LINK).map((s) => s.name),
    loadSkills(root, CANONICAL_SKILLS_DIR).map((s) => s.name),
  );

  const again = writeSkill(root, SKILL);
  assert.deepEqual(again.created, []);
});

test("resolveOverflowTarget prefers .agents/skills and never auto-picks bare skills/", () => {
  const empty = tmpRepo();
  assert.deepEqual(resolveOverflowTarget(empty), { kind: "skills", dir: CANONICAL_SKILLS_DIR, warnings: [] });
  assert.equal(resolveOverflowTarget(empty, ".claude/skills").dir, CANONICAL_SKILLS_DIR);

  const bare = tmpRepo();
  fs.mkdirSync(path.join(bare, "skills"));
  fs.mkdirSync(path.join(bare, "docs"));
  assert.equal(resolveOverflowTarget(bare).dir, CANONICAL_SKILLS_DIR);
  assert.equal(resolveOverflowTarget(bare, ".claude/skills").dir, CANONICAL_SKILLS_DIR);

  // An explicitly configured directory that exists is the user's call.
  assert.equal(resolveOverflowTarget(bare, "skills").dir, "skills");
  // ...but one that does not exist falls back to the canonical dir.
  assert.equal(resolveOverflowTarget(bare, "nope/skills").dir, CANONICAL_SKILLS_DIR);
});

test("ensureSkillsLayout creates the dir and symlink when none exists and is idempotent", () => {
  const root = tmpRepo();
  const first = ensureSkillsLayout(root);
  assert.ok(fs.statSync(path.join(root, CANONICAL_SKILLS_DIR)).isDirectory());
  assert.equal(fs.readlinkSync(path.join(root, CLAUDE_SKILLS_LINK)), CLAUDE_SKILLS_LINK_TARGET);
  assert.equal(first.created.length, 2);
  assert.deepEqual(ensureSkillsLayout(root), { created: [], warnings: [] });
});

test("an existing .claude/skills symlink is left alone even if it points elsewhere", () => {
  const root = tmpRepo();
  fs.mkdirSync(path.join(root, ".claude"));
  fs.mkdirSync(path.join(root, "custom-skills"));
  fs.symlinkSync("../custom-skills", path.join(root, CLAUDE_SKILLS_LINK), "dir");
  const result = ensureSkillsLayout(root);
  assert.equal(fs.readlinkSync(path.join(root, CLAUDE_SKILLS_LINK)), "../custom-skills");
  assert.deepEqual(result.created, [CANONICAL_SKILLS_DIR]);
  assert.deepEqual(result.warnings, []);
});

test("a real .claude/skills directory is warned about and never clobbered", () => {
  const root = tmpRepo();
  const existing = path.join(root, CLAUDE_SKILLS_LINK, "hand-written", "SKILL.md");
  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, "---\nname: hand-written\ndescription: keep me\n---\n\nbody\n");

  const resolved = resolveOverflowTarget(root);
  assert.equal(resolved.dir, CANONICAL_SKILLS_DIR);
  assert.equal(resolved.warnings.length, 1);
  assert.match(resolved.warnings[0], /\.claude\/skills is a real directory/);

  const result = writeSkill(root, SKILL);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /left untouched/);
  assert.ok(fs.lstatSync(path.join(root, CLAUDE_SKILLS_LINK)).isDirectory());
  assert.ok(!fs.lstatSync(path.join(root, CLAUDE_SKILLS_LINK)).isSymbolicLink());
  assert.equal(fs.readFileSync(existing, "utf8").includes("keep me"), true);
  assert.ok(!fs.existsSync(path.join(root, CLAUDE_SKILLS_LINK, "release-signing")));
  assert.ok(fs.existsSync(path.join(root, CANONICAL_SKILLS_DIR, "release-signing", "SKILL.md")));
});

test("applyDecisions writes accepted extractions through the skills layout and surfaces warnings", () => {
  const root = tmpRepo();
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Memory\n\n- Sign releases with the key.\n");
  const edit = {
    id: "e1",
    kind: "extract",
    file: "AGENTS.md",
    find: "- Sign releases with the key.",
    replace: "- Release signing: see the release-signing skill.",
    skill: SKILL,
  };
  const proposal = { memoryFile: { path: "AGENTS.md" }, edits: [edit] };
  const state = { readRejections: () => [], writeRejections: () => {} };

  const dry = applyDecisions({
    proposal,
    decisions: { e1: "accepted" },
    repo: { root },
    state,
    config: { budgetTokens: 5000 },
    dryRun: true,
  });
  assert.ok(!fs.existsSync(path.join(root, CANONICAL_SKILLS_DIR)));
  assert.deepEqual(dry.skills, [{ path: SKILL.path, dryRun: true, created: [] }]);

  const results = applyDecisions({
    proposal,
    decisions: { e1: "accepted" },
    repo: { root },
    state,
    config: { budgetTokens: 5000 },
  });
  assert.equal(results.failed.length, 0);
  assert.deepEqual(results.warnings, []);
  assert.deepEqual(results.skills[0].created, [
    CANONICAL_SKILLS_DIR,
    `${CLAUDE_SKILLS_LINK} -> ${CLAUDE_SKILLS_LINK_TARGET}`,
  ]);
  assert.ok(fs.existsSync(path.join(root, CLAUDE_SKILLS_LINK, "release-signing", "SKILL.md")));
});
