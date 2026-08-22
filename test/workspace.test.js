import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { readMemoryFile } from "../src/memory.js";
import { State } from "../src/state.js";
import {
  isSkillFilePath,
  measureWorkspace,
  parseSkillFile,
  prepareWorkspace,
  repoFingerprint,
} from "../src/workspace.js";
import { makeRepo, writeIn } from "./helpers/staging.js";

const AGENTS = "# M\n\n- one\n- two\n";
const SKILL = "---\nname: db\ndescription: Load before touching the database.\n---\n\n## Body\n";

function stage(files = {}) {
  const repo = makeRepo({ "AGENTS.md": AGENTS, ...files });
  const state = new State(repo.root).ensure();
  const memoryFile = readMemoryFile(repo.root, "AGENTS.md");
  const workspace = prepareWorkspace({ state, repo, memoryFile, skillsDir: ".agents/skills" });
  return { repo, state, memoryFile, workspace };
}

test("the staging copy holds exactly the memory file and the skills directory, under .backpass/", () => {
  const { repo, workspace } = stage({
    ".agents/skills/db/SKILL.md": SKILL,
    ".agents/skills/db/notes.txt": "n",
    "src/index.js": "code",
  });
  assert.equal(workspace.root, path.join(repo.root, ".backpass", "synthesis"));
  assert.equal(fs.readFileSync(path.join(workspace.root, "AGENTS.md"), "utf8"), AGENTS);
  assert.equal(fs.readFileSync(path.join(workspace.root, ".agents/skills/db/SKILL.md"), "utf8"), SKILL);
  assert.ok(
    fs.existsSync(path.join(workspace.root, ".agents/skills/db/notes.txt")),
    "skill directories are copied whole",
  );
  assert.ok(!fs.existsSync(path.join(workspace.root, "src")), "the code is read from the repo, never copied");
  assert.deepEqual(
    [...workspace.originals.keys()].sort(),
    ["AGENTS.md", ".agents/skills/db/SKILL.md", ".agents/skills/db/notes.txt"].sort(),
  );

  // A fresh staging copy replaces any leftover from an earlier run.
  writeIn(workspace.root, "AGENTS.md", "stale edit\n");
  const again = prepareWorkspace({
    state: new State(repo.root),
    repo,
    memoryFile: readMemoryFile(repo.root, "AGENTS.md"),
    skillsDir: ".agents/skills",
  });
  assert.equal(fs.readFileSync(path.join(again.root, "AGENTS.md"), "utf8"), AGENTS);
});

test("an untouched workspace measures as no change, and ids are stable across re-measurement", () => {
  const { workspace } = stage();
  const first = measureWorkspace(workspace);
  assert.deepEqual(first.changes, []);

  writeIn(workspace.root, "AGENTS.md", (t) => t.replace("- two", "- 2"));
  writeIn(workspace.root, ".agents/skills/new/SKILL.md", SKILL.replace("db", "new"));
  const a = measureWorkspace(workspace);
  const b = measureWorkspace(workspace);
  assert.deepEqual(
    a.changes.map((c) => [c.id, c.kind, c.file]),
    [
      ["H1", "hunk", "AGENTS.md"],
      ["H2", "created", ".agents/skills/new/SKILL.md"],
    ],
  );
  assert.equal(a.signature, b.signature);
  assert.equal(a.changes[1].skill.name, "new");
  assert.notEqual(first.signature, a.signature);
});

test("only the skill layouts a harness loads count as created skills; anything else is stray", () => {
  assert.equal(isSkillFilePath(".agents/skills/db/SKILL.md", ".agents/skills"), true);
  assert.equal(isSkillFilePath(".agents/skills/db.md", ".agents/skills"), true);
  assert.equal(isSkillFilePath(".agents/skills/db/reference.md", ".agents/skills"), false);
  assert.equal(isSkillFilePath(".agents/skills/a/b/SKILL.md", ".agents/skills"), false);
  assert.equal(isSkillFilePath("skills/db/SKILL.md", ".agents/skills"), false);

  assert.deepEqual(parseSkillFile("x/SKILL.md", SKILL), {
    name: "db",
    description: "Load before touching the database.",
    path: "x/SKILL.md",
    body: "## Body",
  });
  assert.equal(parseSkillFile("x/SKILL.md", "no frontmatter\n"), null);
  assert.equal(
    parseSkillFile("x/SKILL.md", "---\nname: only\n---\nbody\n"),
    null,
    "a description is the trigger; required",
  );
});

test("the repo fingerprint notices a changed or removed guarded file", () => {
  const { repo } = stage({ ".agents/skills/db/SKILL.md": SKILL });
  const files = ["AGENTS.md", ".agents/skills/db/SKILL.md", "missing.md"];
  const before = repoFingerprint(repo, files);
  assert.equal(before["missing.md"], null);
  assert.deepEqual(repoFingerprint(repo, files), before);
  fs.appendFileSync(path.join(repo.root, "AGENTS.md"), "- three\n");
  const after = repoFingerprint(repo, files);
  assert.notEqual(after["AGENTS.md"], before["AGENTS.md"]);
  assert.equal(after[".agents/skills/db/SKILL.md"], before[".agents/skills/db/SKILL.md"]);
});
