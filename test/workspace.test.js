import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readMemoryFile } from "../src/memory.js";
import { loadSkills, skillDescriptionTokens } from "../src/skills.js";
import { State } from "../src/state.js";
import {
  isSkillFilePath,
  measureWorkspace,
  parseSkillFile,
  prepareWorkspace,
  repoFingerprint,
  workspacePathFor,
} from "../src/workspace.js";
import { makeRepo, stageAndMeasure, writeIn } from "./helpers/staging.js";

const AGENTS = "# M\n\n- one\n- two\n";
const SKILL = "---\nname: db\ndescription: Load before touching the database.\n---\n\n## Body\n";

/** Every file actually present under a staging directory, relative to it. */
function walkStaged(dir, prefix = "") {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? walkStaged(path.join(dir, entry.name), path.posix.join(prefix, entry.name))
        : [path.posix.join(prefix, entry.name)],
    )
    .sort();
}

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

test("external user memory and skills use workspace-relative staging paths", () => {
  const repo = makeRepo({});
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-external-workspace-"));
  const memoryPath = path.join(external, "CLAUDE.md");
  const skillsDir = path.join(external, "skills");
  fs.mkdirSync(path.join(skillsDir, "db"), { recursive: true });
  fs.writeFileSync(memoryPath, AGENTS);
  fs.writeFileSync(path.join(skillsDir, "db/SKILL.md"), SKILL);
  const workspace = prepareWorkspace({
    state: new State(repo.root).ensure(),
    repo,
    memoryFile: readMemoryFile(repo.root, memoryPath, { allowExternal: true }),
    skillsDir,
    skillDirs: [skillsDir],
    allowExternal: true,
  });

  assert.equal(path.isAbsolute(workspace.memoryWorkspacePath), false);
  writeIn(workspace.root, workspace.memoryWorkspacePath, (text) => text.replace("- two", "- 2"));
  writeIn(path.join(workspace.root, workspacePathFor(skillsDir)), "new/SKILL.md", SKILL.replace("db", "new"));
  const measured = measureWorkspace(workspace);
  assert.deepEqual(
    measured.changes.map((change) => [change.kind, change.file]),
    [
      ["hunk", memoryPath],
      ["created", path.join(skillsDir, "new/SKILL.md")],
    ],
  );
});

test("split external memory hunks retain their staged path", () => {
  const repo = makeRepo({});
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-external-split-"));
  const memoryPath = path.join(external, "CLAUDE.md");
  const skillsDir = path.join(external, "skills");
  fs.writeFileSync(memoryPath, "# M\n\n- carry\n- delete\n- keep\n");
  const workspace = prepareWorkspace({
    state: new State(repo.root).ensure(),
    repo,
    memoryFile: readMemoryFile(repo.root, memoryPath, { allowExternal: true }),
    skillsDir,
    skillDirs: [skillsDir],
    allowExternal: true,
  });
  writeIn(workspace.root, workspace.memoryWorkspacePath, (text) => text.replace("- carry\n- delete\n", ""));
  writeIn(
    path.join(workspace.root, workspacePathFor(skillsDir)),
    "carry/SKILL.md",
    "---\nname: carry\ndescription: Load for carry rules.\n---\n\n- carry\n",
  );

  const hunks = measureWorkspace(workspace).changes.filter((change) => change.kind === "hunk");
  assert.equal(hunks.length, 2);
  assert.equal(
    hunks.every((hunk) => hunk.workspaceFile === workspace.memoryWorkspacePath),
    true,
  );
});

test("only the skill layouts a harness loads count as created skills; anything else is stray", () => {
  assert.equal(isSkillFilePath(".agents/skills/db/SKILL.md", ".agents/skills"), true);
  assert.equal(isSkillFilePath(".agents/skills/db.md", ".agents/skills"), true);
  assert.equal(isSkillFilePath(".agents/skills/db/reference.md", ".agents/skills"), false);
  assert.equal(isSkillFilePath(".agents/skills/a/b/SKILL.md", ".agents/skills"), false);
  assert.equal(isSkillFilePath("skills/db/SKILL.md", ".agents/skills"), false);
  assert.equal(isSkillFilePath(".claude/skills/db/SKILL.md", ".claude/skills/"), true);
  assert.equal(isSkillFilePath(".claude/skills/db/SKILL.md", ".claude\\skills\\"), true);

  const staged = stageAndMeasure({
    repo: makeRepo({ "AGENTS.md": AGENTS, ".claude/skills/existing/SKILL.md": SKILL }),
    skillsDir: ".claude/skills",
    edit: (root) => writeIn(root, ".claude/skills/new/SKILL.md", SKILL.replace("db", "new")),
  });
  assert.deepEqual(
    staged.measured.changes.map((change) => [change.kind, change.file]),
    [["created", ".claude/skills/new/SKILL.md"]],
  );
  assert.equal(isSkillFilePath("C:\\cfg\\skills\\db\\SKILL.md", "C:\\cfg\\skills"), true);
  assert.equal(isSkillFilePath("C:\\cfg\\skills\\db.md", "C:\\cfg\\skills"), true);
  assert.equal(isSkillFilePath("C:\\cfg\\other\\db\\SKILL.md", "C:\\cfg\\skills"), false);

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

test("a symlinked skill is staged and measured, so a run can edit what the harness actually loads", () => {
  const repo = makeRepo({ "AGENTS.md": AGENTS });
  // The library-plus-symlinks layout: content lives outside the loaded directory.
  const library = path.join(repo.root, "library", "db");
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(path.join(library, "SKILL.md"), SKILL);
  const loaded = path.join(repo.root, ".agents", "skills");
  fs.mkdirSync(loaded, { recursive: true });
  fs.symlinkSync(library, path.join(loaded, "db"));

  const state = new State(repo.root).ensure();
  const memoryFile = readMemoryFile(repo.root, "AGENTS.md");
  const workspace = prepareWorkspace({ state, repo, memoryFile, skillsDir: ".agents/skills" });

  const staged = ".agents/skills/db/SKILL.md";
  assert.ok(workspace.originals.has(staged), "the symlinked skill is part of the staging copy");
  assert.equal(workspace.originals.get(staged), SKILL);

  const copy = path.join(workspace.root, workspace.stagedPaths.get(staged));
  assert.ok(fs.existsSync(copy), "it is copied, not linked, so edits never reach the library");
  assert.ok(!fs.lstatSync(copy).isSymbolicLink());

  fs.writeFileSync(copy, SKILL.replace("Load before touching", "Load before migrating"));
  const measured = measureWorkspace(workspace);
  const hunks = measured.changes.filter((c) => c.file === staged);
  assert.equal(hunks.length, 1, "an edit to the symlinked skill is measured as a change to it");
  assert.equal(hunks[0].kind, "hunk");
  assert.equal(fs.readFileSync(path.join(library, "SKILL.md"), "utf8"), SKILL, "the library is untouched");
});

test("a symlinked skill directory is never recursed, so no cycle can be walked", () => {
  const repo = makeRepo({ "AGENTS.md": AGENTS });
  const loaded = path.join(repo.root, ".agents", "skills");
  const real = path.join(loaded, "db");
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, "SKILL.md"), SKILL);
  // The three shapes a directory link can take: a self link, a link back to an ancestor,
  // and a mutual pair. Staging takes at most one leaf per link and never descends, so
  // none of them can be entered. (The ancestry guard in walkFiles is a second line of
  // defence for that; only the top-level self link still reaches it.)
  fs.symlinkSync(real, path.join(real, "self"));
  fs.symlinkSync(loaded, path.join(real, "up"));
  const a = path.join(loaded, "a");
  const b = path.join(loaded, "b");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.symlinkSync(b, path.join(a, "to-b"));
  fs.symlinkSync(a, path.join(b, "to-a"));

  const state = new State(repo.root).ensure();
  const memoryFile = readMemoryFile(repo.root, "AGENTS.md");
  const workspace = prepareWorkspace({ state, repo, memoryFile, skillsDir: ".agents/skills" });

  const staged = ".agents/skills/db/SKILL.md";
  assert.ok(workspace.originals.has(staged), "the real skill behind the cycle is still staged");
  assert.equal(workspace.originals.get(staged), SKILL);
  // The cycle is pruned, not walked: no staged path may repeat a directory segment.
  for (const p of workspace.originals.keys()) {
    const segments = p.split("/").slice(0, -1);
    assert.equal(new Set(segments).size, segments.length, `${p} revisits a directory`);
  }
});

test("two links to one shared library are both billed, and exactly one of them is writable", () => {
  const repo = makeRepo({ "AGENTS.md": AGENTS });
  const library = path.join(repo.root, "library", "db");
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(path.join(library, "SKILL.md"), SKILL);
  const loaded = path.join(repo.root, ".agents", "skills");
  fs.mkdirSync(loaded, { recursive: true });
  // The harness loads both names, so both cost description tokens.
  fs.symlinkSync(library, path.join(loaded, "db"));
  fs.symlinkSync(library, path.join(loaded, "database"));

  const loadedSkills = loadSkills(repo.root, ".agents/skills");
  assert.deepEqual(
    loadedSkills.map((skill) => skill.path),
    [".agents/skills/database/SKILL.md", ".agents/skills/db/SKILL.md"],
    "both names are walked and loaded",
  );
  assert.equal(
    skillDescriptionTokens(loadedSkills),
    2 * loadedSkills[0].descriptionTokens,
    "both descriptions are billed against the always-loaded budget",
  );

  const state = new State(repo.root).ensure();
  const memoryFile = readMemoryFile(repo.root, "AGENTS.md");
  const workspace = prepareWorkspace({ state, repo, memoryFile, skillsDir: ".agents/skills" });

  // One file cannot be two independently editable copies: apply refuses a round whose
  // accepted targets resolve to the same path, and that refusal drops every other edit.
  assert.deepEqual([...workspace.originals.keys()], ["AGENTS.md", ".agents/skills/database/SKILL.md"]);
  assert.equal(fs.existsSync(path.join(workspace.root, ".agents/skills/db/SKILL.md")), false);
  assert.deepEqual(workspace.unstageable, [
    {
      path: ".agents/skills/db/SKILL.md",
      reason: "the same file is already staged as .agents/skills/database/SKILL.md",
    },
  ]);
});

test("a skill file linked out of the repo through an in-repo library is never staged", () => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-outside-store-")));
  fs.writeFileSync(path.join(outside, "SKILL.md"), SKILL);

  const repo = makeRepo({ "AGENTS.md": AGENTS });
  // The library is inside the repository, so the directory link itself passes
  // containment - but the file it holds is a link to something the repo does not own.
  fs.mkdirSync(path.join(repo.root, "library", "db"), { recursive: true });
  fs.symlinkSync(path.join(outside, "SKILL.md"), path.join(repo.root, "library", "db", "SKILL.md"));
  const loaded = path.join(repo.root, ".agents", "skills");
  fs.mkdirSync(loaded, { recursive: true });
  fs.symlinkSync(path.join(repo.root, "library", "db"), path.join(loaded, "db"));

  const state = new State(repo.root).ensure();
  const memoryFile = readMemoryFile(repo.root, "AGENTS.md");
  const workspace = prepareWorkspace({ state, repo, memoryFile, skillsDir: ".agents/skills" });

  assert.deepEqual([...workspace.originals.keys()], ["AGENTS.md"]);
  assert.deepEqual(walkStaged(path.join(workspace.root, ".agents/skills")), []);
  assert.deepEqual(workspace.unstageable, [
    { path: ".agents/skills/db/SKILL.md", reason: "resolves outside the repository" },
  ]);

  // User scope owns files outside any repository, so there the same layout still stages.
  const external = prepareWorkspace({
    state,
    repo,
    memoryFile,
    skillsDir: ".agents/skills",
    allowExternal: true,
  });
  assert.equal(external.originals.get(".agents/skills/db/SKILL.md"), SKILL);
});

test("a skill linked into a store nothing may write is billed but never staged writable", () => {
  const store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-readonly-store-")));
  fs.mkdirSync(path.join(store, "foo"));
  fs.writeFileSync(path.join(store, "foo", "SKILL.md"), SKILL.replace("name: db", "name: foo"));
  fs.mkdirSync(path.join(store, "shared"));
  fs.writeFileSync(path.join(store, "shared", "SKILL.md"), SKILL.replace("name: db", "name: shared"));

  const repo = makeRepo({ "AGENTS.md": AGENTS, ".agents/skills/db/SKILL.md": SKILL });
  const loaded = path.join(repo.root, ".agents", "skills");
  fs.symlinkSync(path.join(store, "foo"), path.join(loaded, "foo"));
  // Two names for one unwritable library: neither may be staged, and the second must not
  // be reported as an alias of a file that was never staged.
  fs.symlinkSync(path.join(store, "shared"), path.join(loaded, "shared"));
  fs.symlinkSync(path.join(store, "shared"), path.join(loaded, "shared-alias"));
  fs.chmodSync(path.join(store, "foo"), 0o555);
  fs.chmodSync(path.join(store, "shared"), 0o555);
  fs.chmodSync(store, 0o555);

  try {
    // The harness loads them, so they cost description tokens whatever backpass may write.
    assert.deepEqual(
      loadSkills(repo.root, ".agents/skills")
        .map((skill) => skill.name)
        .sort(),
      ["db", "foo", "shared", "shared"],
    );

    const state = new State(repo.root).ensure();
    const memoryFile = readMemoryFile(repo.root, "AGENTS.md");
    // User scope: nothing confines the walk, so only writability keeps these out.
    const workspace = prepareWorkspace({
      state,
      repo,
      memoryFile,
      skillsDir: ".agents/skills",
      allowExternal: true,
    });

    assert.deepEqual([...workspace.originals.keys()], ["AGENTS.md", ".agents/skills/db/SKILL.md"]);
    assert.deepEqual(walkStaged(path.join(workspace.root, ".agents/skills")), ["db/SKILL.md"]);
    assert.deepEqual(workspace.unstageable, [
      { path: ".agents/skills/foo/SKILL.md", reason: "resolves to a location that cannot be written" },
      { path: ".agents/skills/shared/SKILL.md", reason: "resolves to a location that cannot be written" },
      { path: ".agents/skills/shared-alias/SKILL.md", reason: "resolves to a location that cannot be written" },
    ]);
  } finally {
    fs.chmodSync(store, 0o755);
    fs.chmodSync(path.join(store, "foo"), 0o755);
    fs.chmodSync(path.join(store, "shared"), 0o755);
  }
});

test("a skill in a store this user cannot read is skipped and named, not thrown", () => {
  const store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-locked-store-")));
  fs.mkdirSync(path.join(store, "locked"));
  const unreadable = path.join(store, "locked", "SKILL.md");
  fs.writeFileSync(unreadable, SKILL);
  // Write-only: the writability probe accepts it, so only the read failure keeps it out.
  fs.chmodSync(unreadable, 0o222);

  const repo = makeRepo({ "AGENTS.md": AGENTS, ".agents/skills/db/SKILL.md": SKILL });
  const loaded = path.join(repo.root, ".agents", "skills");
  fs.symlinkSync(path.join(store, "locked"), path.join(loaded, "locked"));

  try {
    const state = new State(repo.root).ensure();
    const memoryFile = readMemoryFile(repo.root, "AGENTS.md");
    // User scope, where an out-of-repo store is legitimately stageable - so nothing but
    // the read failure itself can keep this file out.
    const workspace = prepareWorkspace({
      state,
      repo,
      memoryFile,
      skillsDir: ".agents/skills",
      allowExternal: true,
    });

    assert.deepEqual([...workspace.originals.keys()], ["AGENTS.md", ".agents/skills/db/SKILL.md"]);
    assert.deepEqual(walkStaged(path.join(workspace.root, ".agents/skills")), ["db/SKILL.md"]);
    assert.deepEqual(workspace.unstageable, [
      { path: ".agents/skills/locked/SKILL.md", reason: "could not be read when the staging copy was built" },
    ]);
    // The readable skill beside it still measures normally.
    assert.deepEqual(measureWorkspace(workspace).changes, []);
  } finally {
    fs.chmodSync(unreadable, 0o644);
  }
});

test("a link to a whole repository stages only the skill file, never the tree behind it", () => {
  const repo = makeRepo({ "AGENTS.md": AGENTS });
  // The layout the finding names: a plugin repository linked in as a skill.
  const plugin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-plugin-repo-")));
  fs.writeFileSync(path.join(plugin, "SKILL.md"), SKILL);
  fs.writeFileSync(path.join(plugin, "README.md"), "# Plugin\n");
  fs.mkdirSync(path.join(plugin, ".git", "objects"), { recursive: true });
  fs.writeFileSync(path.join(plugin, ".git", "objects", "pack"), "binary");
  fs.mkdirSync(path.join(plugin, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(plugin, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  const loaded = path.join(repo.root, ".agents", "skills");
  fs.mkdirSync(loaded, { recursive: true });
  fs.symlinkSync(plugin, path.join(loaded, "superpowers"));

  const state = new State(repo.root).ensure();
  const memoryFile = readMemoryFile(repo.root, "AGENTS.md");
  // User scope: nothing confines the walk, so only the layout itself bounds what is taken.
  const workspace = prepareWorkspace({
    state,
    repo,
    memoryFile,
    skillsDir: ".agents/skills",
    allowExternal: true,
  });

  assert.deepEqual([...workspace.originals.keys()], ["AGENTS.md", ".agents/skills/superpowers/SKILL.md"]);
  assert.deepEqual(walkStaged(path.join(workspace.root, ".agents/skills")), ["superpowers/SKILL.md"]);
});

test("project scope bills a skill symlinked out of the repo but never stages it", () => {
  const repo = makeRepo({ "AGENTS.md": AGENTS });
  // The layout project scope cannot write: the loaded directory links into a library that
  // lives outside the repository entirely.
  const library = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-library-")));
  fs.mkdirSync(path.join(library, "db"));
  fs.writeFileSync(path.join(library, "db", "SKILL.md"), SKILL);
  fs.writeFileSync(path.join(library, "solo.md"), "---\nname: solo\ndescription: Solo.\n---\n\nBody\n");
  const loaded = path.join(repo.root, ".agents", "skills");
  fs.mkdirSync(loaded, { recursive: true });
  fs.symlinkSync(path.join(library, "db"), path.join(loaded, "db"));
  fs.symlinkSync(path.join(library, "solo.md"), path.join(loaded, "solo.md"));
  fs.mkdirSync(path.join(loaded, "local"));
  fs.writeFileSync(path.join(loaded, "local", "SKILL.md"), SKILL.replace("name: db", "name: local"));

  const loadedSkills = loadSkills(repo.root, ".agents/skills");
  assert.deepEqual(
    loadedSkills.map((s) => s.name).sort(),
    ["db", "local", "solo"],
    "the harness loads all three, so all three are billed",
  );
  assert.ok(
    loadedSkills.find((s) => s.name === "db").descriptionTokens > 0,
    "an out-of-repo skill still costs always-loaded tokens",
  );

  const state = new State(repo.root).ensure();
  const memoryFile = readMemoryFile(repo.root, "AGENTS.md");
  const workspace = prepareWorkspace({ state, repo, memoryFile, skillsDir: ".agents/skills" });

  assert.ok(workspace.originals.has(".agents/skills/local/SKILL.md"), "an in-repo skill is staged as before");
  assert.equal(workspace.originals.has(".agents/skills/db/SKILL.md"), false);
  assert.equal(workspace.originals.has(".agents/skills/solo.md"), false);
  assert.equal(fs.existsSync(path.join(workspace.root, ".agents/skills/db")), false);
  assert.equal(fs.existsSync(path.join(workspace.root, ".agents/skills/solo.md")), false);

  // User scope owns files outside any repository, so there the same layout is editable.
  const external = prepareWorkspace({ state, repo, memoryFile, skillsDir: ".agents/skills", allowExternal: true });
  assert.equal(external.originals.get(".agents/skills/db/SKILL.md"), SKILL);
  assert.ok(external.originals.has(".agents/skills/solo.md"));
});
