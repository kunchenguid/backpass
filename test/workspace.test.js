import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readMemoryFile } from "../src/memory.js";
import { loadProjectSkills, loadSkills, resolveProjectSkillDirs, skillDescriptionTokens } from "../src/skills.js";
import { estimateTokens } from "../src/tokens.js";
import { State } from "../src/state.js";
import {
  READ_ONLY_SEARCH_PATH,
  STRAY_OUTSIDE_SURFACE,
  STRAY_READ_ONLY_SEARCH_PATH,
  STRAY_UNWRITABLE,
  canonicalizeSearchPathRoots,
  isSkillFilePath,
  measureWorkspace,
  parseSkillFile,
  prepareWorkspace,
  repoFingerprint,
  skillStagingRefusal,
  workspacePathFor,
} from "../src/workspace.js";
import { UserError } from "../src/logger.js";
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

test("an ignored file in an external skills directory is named by the path the user knows", () => {
  const repo = makeRepo({ "AGENTS.md": AGENTS });
  const skillsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-external-stray-")));
  fs.mkdirSync(path.join(skillsDir, "db"));
  fs.writeFileSync(path.join(skillsDir, "db/SKILL.md"), SKILL);

  const workspace = prepareWorkspace({
    state: new State(repo.root).ensure(),
    repo,
    memoryFile: readMemoryFile(repo.root, "AGENTS.md"),
    skillsDir,
    skillDirs: [skillsDir],
    allowExternal: true,
  });
  writeIn(path.join(workspace.root, workspacePathFor(skillsDir)), "notes.txt", "scratch");

  // Staging hashes an absolute skills directory into `.external/<hash>/`, which tells the
  // reader nothing about which file was ignored.
  assert.deepEqual(measureWorkspace(workspace).stray, [
    { file: path.join(skillsDir, "notes.txt"), reason: STRAY_OUTSIDE_SURFACE },
  ]);
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
  // none of them can be entered - which is the only thing standing between this layout
  // and the RangeError it used to produce.
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

test("identity-based dedupe must never reach the always-loaded token count", () => {
  // The bug this whole change exists to fix is an under-counted budget: half the real
  // skill layer was invisible, so its description lines were never billed. A library
  // reached through k links is k things the harness loads and k description lines it
  // pays for every turn. Staging may pick one owner - that is a separate decision, pinned
  // separately below - but no dedupe may ever reach this count.
  const repo = makeRepo({ "AGENTS.md": AGENTS });
  const library = path.join(repo.root, "library", "db");
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(path.join(library, "SKILL.md"), SKILL);
  const loaded = path.join(repo.root, ".agents", "skills");
  fs.mkdirSync(loaded, { recursive: true });
  for (const name of ["db", "database", "sql"]) fs.symlinkSync(library, path.join(loaded, name));

  const one = estimateTokens("Load before touching the database.");
  for (const skills of [loadSkills(repo.root, ".agents/skills"), loadProjectSkills(repo.root, ".agents/skills", [])]) {
    assert.deepEqual(
      skills.map((skill) => skill.path),
      [".agents/skills/database/SKILL.md", ".agents/skills/db/SKILL.md", ".agents/skills/sql/SKILL.md"],
      "every link is walked and loaded, and the order is by path rather than by readdir",
    );
    assert.equal(skillDescriptionTokens(skills), 3 * one, "three links cost three description lines");
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
    "both names are walked and loaded, in path order on every filesystem",
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

test("a skill in an outside search path is loaded for awareness but never staged for writing", () => {
  // The canonical library is a shared tree outside the repo, named by skillSearchPaths.
  const shared = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-search-path-")));
  fs.mkdirSync(path.join(shared, "db"));
  fs.writeFileSync(path.join(shared, "db", "SKILL.md"), SKILL);

  const repo = makeRepo({ "AGENTS.md": AGENTS });
  const state = new State(repo.root).ensure();
  const memoryFile = readMemoryFile(repo.root, "AGENTS.md");

  // The search path joins the awareness roots (this is what config merges into skillsDirs).
  const skillDirs = resolveProjectSkillDirs(repo.root, ".agents/skills", [shared]);
  assert.ok(skillDirs.includes(shared), "the outside search path is an awareness root");
  assert.deepEqual(
    loadProjectSkills(repo.root, ".agents/skills", [shared]).map((s) => s.name),
    ["db"],
    "the shared skill is visible for reference/dedup awareness",
  );

  // Project scope (allowExternal false) must withhold the outside skill from staging, so
  // synthesis can never emit an edit that writes into the shared library.
  const workspace = prepareWorkspace({ state, repo, memoryFile, skillsDir: ".agents/skills", skillDirs });
  assert.deepEqual([...workspace.originals.keys()], ["AGENTS.md"]);
  assert.deepEqual(walkStaged(path.join(workspace.root, workspacePathFor(shared))), []);
  assert.deepEqual(workspace.unstageable, [
    { path: path.join(shared, "db"), reason: "resolves outside the repository" },
  ]);
});

test("a configured search path stays read-only even in user scope, unlike an ordinary external skills dir", () => {
  const shared = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-search-path-")));
  fs.mkdirSync(path.join(shared, "db"));
  fs.writeFileSync(path.join(shared, "db", "SKILL.md"), SKILL);

  const repo = makeRepo({ "AGENTS.md": AGENTS });
  const state = new State(repo.root).ensure();
  const memoryFile = readMemoryFile(repo.root, "AGENTS.md");
  const skillDirs = resolveProjectSkillDirs(repo.root, ".agents/skills", [shared]);

  // `allowExternal` is what lets user scope write its own harness directories wherever
  // they resolve; it must never reach a root the config named in `skillSearchPaths`.
  const workspace = prepareWorkspace({
    state,
    repo,
    memoryFile,
    skillsDir: ".agents/skills",
    skillDirs,
    allowExternal: true,
    searchPathRoots: [shared],
  });
  assert.deepEqual([...workspace.originals.keys()], ["AGENTS.md"]);
  assert.deepEqual(walkStaged(path.join(workspace.root, workspacePathFor(shared))), []);
  assert.deepEqual(workspace.unstageable, [{ path: path.join(shared, "db"), reason: READ_ONLY_SEARCH_PATH }]);

  // `--target` asks this exact question before a run ever narrows to a name, and must
  // get the same answer.
  const refusal = skillStagingRefusal(repo.root, path.join(shared, "db", "SKILL.md"), {
    allowExternal: true,
    searchPathRoots: [shared],
  });
  assert.equal(refusal, READ_ONLY_SEARCH_PATH);
});

test("a file created under a search-path root during synthesis is reported stray, never a created skill", () => {
  const shared = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-search-path-new-")));

  const repo = makeRepo({ "AGENTS.md": AGENTS });
  const state = new State(repo.root).ensure();
  const memoryFile = readMemoryFile(repo.root, "AGENTS.md");
  const skillDirs = resolveProjectSkillDirs(repo.root, ".agents/skills", [shared]);

  const workspace = prepareWorkspace({
    state,
    repo,
    memoryFile,
    skillsDir: ".agents/skills",
    skillDirs,
    allowExternal: true,
    searchPathRoots: [shared],
  });
  // The library is empty, so there is no pre-existing file to refuse in advance - only
  // the created-file path can catch a model that writes a brand new one under the root.
  writeIn(
    workspace.root,
    `${workspacePathFor(shared)}/new/SKILL.md`,
    "---\nname: new\ndescription: New.\n---\n\nBody\n",
  );
  const measured = measureWorkspace(workspace);
  assert.deepEqual(
    measured.changes.filter((c) => c.kind === "created"),
    [],
  );
  assert.deepEqual(measured.stray, [
    { file: path.join(shared, "new", "SKILL.md"), reason: STRAY_READ_ONLY_SEARCH_PATH },
  ]);
});

test("a RELATIVE search-path root resolves against the repo root, not the process working directory", () => {
  // The read-only promise fails open if a relative root is canonicalised against
  // `process.cwd()` (the tests run with cwd = the backpass checkout, never the tmp repo),
  // because the real skill source resolves against the repo root and the two never match.
  const repo = makeRepo({ "AGENTS.md": AGENTS, "shared/db/SKILL.md": SKILL });
  assert.notEqual(fs.realpathSync(process.cwd()), fs.realpathSync(repo.root), "cwd must differ from the repo root");
  const state = new State(repo.root).ensure();
  const memoryFile = readMemoryFile(repo.root, "AGENTS.md");
  const skillDirs = resolveProjectSkillDirs(repo.root, ".agents/skills", ["shared"]);

  const workspace = prepareWorkspace({
    state,
    repo,
    memoryFile,
    skillsDir: ".agents/skills",
    skillDirs,
    allowExternal: true,
    searchPathRoots: ["shared"],
  });
  assert.deepEqual(walkStaged(path.join(workspace.root, workspacePathFor("shared"))), []);
  assert.deepEqual(workspace.unstageable, [{ path: "shared/db", reason: READ_ONLY_SEARCH_PATH }]);

  // The canonicalisation itself resolves a relative root against the repo root.
  const identities = canonicalizeSearchPathRoots(repo.root, ["shared"]);
  assert.ok(identities.has(fs.realpathSync(path.join(repo.root, "shared"))));
});

test("a ~-prefixed search-path root is home-expanded at the --target refusal site", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-home-")));
  fs.mkdirSync(path.join(home, "shared", "db"), { recursive: true });
  fs.writeFileSync(path.join(home, "shared", "db", "SKILL.md"), SKILL);
  const repo = makeRepo({ "AGENTS.md": AGENTS });
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // The --target path asks `skillStagingRefusal` with the raw configured root; a
    // "~"-prefixed root must be home-expanded there or realpath throws and it is dropped.
    const refusal = skillStagingRefusal(repo.root, path.join(home, "shared", "db", "SKILL.md"), {
      allowExternal: true,
      searchPathRoots: ["~/shared"],
    });
    assert.equal(refusal, READ_ONLY_SEARCH_PATH);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("a search-path root that is an ancestor of the repo never makes the repo's own skillsDir read-only", () => {
  // config.js validation rejects this shape at load time, but `canonicalizeSearchPathRoots`
  // and `prepareWorkspace` are reachable directly, so the repo's own containment must win
  // here too - e.g. skillSearchPaths: ["~"] with the repo checked out under $HOME.
  const repo = makeRepo({ "AGENTS.md": AGENTS, ".agents/skills/db/SKILL.md": SKILL });
  const ancestor = fs.realpathSync(os.tmpdir());
  assert.ok(
    fs.realpathSync(repo.root).startsWith(`${ancestor}${path.sep}`),
    "the repo must be nested under the ancestor root for this test to be meaningful",
  );

  assert.equal(canonicalizeSearchPathRoots(repo.root, [ancestor]).size, 0);
  assert.equal(canonicalizeSearchPathRoots(repo.root, [repo.root]).size, 0);

  const state = new State(repo.root).ensure();
  const memoryFile = readMemoryFile(repo.root, "AGENTS.md");
  const skillDirs = resolveProjectSkillDirs(repo.root, ".agents/skills");

  const workspace = prepareWorkspace({
    state,
    repo,
    memoryFile,
    skillsDir: ".agents/skills",
    skillDirs,
    searchPathRoots: [ancestor],
  });
  assert.deepEqual(workspace.unstageable, []);
  assert.deepEqual(walkStaged(path.join(workspace.root, workspacePathFor(".agents/skills"))), ["db/SKILL.md"]);
});

test("a search-path root that equals or contains the repo's own skillsDir never makes it read-only", () => {
  // config.js validation rejects this shape at load time, but `canonicalizeSearchPathRoots`
  // and `prepareWorkspace` are reachable directly, so the repo's own skillsDir containment
  // must win here too - e.g. skillSearchPaths: [".agents"] with skillsDir ".agents/skills".
  const repo = makeRepo({ "AGENTS.md": AGENTS, ".agents/skills/db/SKILL.md": SKILL });

  assert.equal(canonicalizeSearchPathRoots(repo.root, [".agents"], ".agents/skills").size, 0, "containing case");
  assert.equal(canonicalizeSearchPathRoots(repo.root, [".agents/skills"], ".agents/skills").size, 0, "equal case");

  const state = new State(repo.root).ensure();
  const memoryFile = readMemoryFile(repo.root, "AGENTS.md");
  const skillDirs = resolveProjectSkillDirs(repo.root, ".agents/skills");

  const workspace = prepareWorkspace({
    state,
    repo,
    memoryFile,
    skillsDir: ".agents/skills",
    skillDirs,
    searchPathRoots: [".agents"],
  });
  assert.deepEqual(workspace.unstageable, []);
  assert.deepEqual(walkStaged(path.join(workspace.root, workspacePathFor(".agents/skills"))), ["db/SKILL.md"]);
});

test("an unresolvable search-path root fails closed rather than being silently dropped", () => {
  const repo = makeRepo({ "AGENTS.md": AGENTS, afile: "x" });
  const state = new State(repo.root).ensure();
  const memoryFile = readMemoryFile(repo.root, "AGENTS.md");
  // `afile` is a regular file, so `afile/sub` cannot be canonicalised (ENOTDIR). The
  // read-only promise must abort loudly, naming the config key, not vanish.
  const badRoot = path.join(repo.root, "afile", "sub");
  assert.throws(
    () => canonicalizeSearchPathRoots(repo.root, [badRoot]),
    (err) => err instanceof UserError && /skillSearchPaths/.test(err.message),
  );
  assert.throws(
    () =>
      prepareWorkspace({
        state,
        repo,
        memoryFile,
        skillsDir: ".agents/skills",
        skillDirs: [".agents/skills"],
        searchPathRoots: [badRoot],
      }),
    UserError,
  );
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
    assert.deepEqual(
      workspace.unstageable.map(({ path: p, reason }) => ({ path: p, reason })),
      [
        { path: ".agents/skills/foo/SKILL.md", reason: "resolves to a location that cannot be written" },
        { path: ".agents/skills/shared/SKILL.md", reason: "resolves to a location that cannot be written" },
        { path: ".agents/skills/shared-alias/SKILL.md", reason: "resolves to a location that cannot be written" },
      ],
    );
  } finally {
    fs.chmodSync(store, 0o755);
    fs.chmodSync(path.join(store, "foo"), 0o755);
    fs.chmodSync(path.join(store, "shared"), 0o755);
  }
});

test("a read-only skill file in a writable directory is staged as an editable copy", () => {
  const store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-readonly-file-")));
  fs.mkdirSync(path.join(store, "foo"));
  const foo = SKILL.replace("name: db", "name: foo");
  const source = path.join(store, "foo", "SKILL.md");
  fs.writeFileSync(source, foo);
  // Apply never opens an existing target for writing: it creates a temp file in the
  // directory and renames over it, so the file's own mode decides nothing there.
  fs.chmodSync(source, 0o444);

  const repo = makeRepo({ "AGENTS.md": AGENTS, ".agents/skills/db/SKILL.md": SKILL });
  fs.symlinkSync(path.join(store, "foo"), path.join(repo.root, ".agents", "skills", "foo"));

  const workspace = prepareWorkspace({
    state: new State(repo.root).ensure(),
    repo,
    memoryFile: readMemoryFile(repo.root, "AGENTS.md"),
    skillsDir: ".agents/skills",
    allowExternal: true,
  });

  assert.deepEqual(workspace.unstageable, []);
  assert.equal(workspace.originals.get(".agents/skills/foo/SKILL.md"), foo);

  // Synthesis edits the staging copy in place, so a source mode that forbids writing must
  // not travel with it - a skill staged unwritable can only ever measure as no change.
  const staged = path.join(workspace.root, workspace.stagedPaths.get(".agents/skills/foo/SKILL.md"));
  fs.writeFileSync(staged, foo.replace("Load before touching the database.", "Load before any database work."));
  assert.deepEqual(
    measureWorkspace(workspace).changes.map((change) => [change.kind, change.file]),
    [["hunk", ".agents/skills/foo/SKILL.md"]],
  );
  assert.equal(fs.statSync(source).mode & 0o777, 0o444, "the source keeps its own mode");
  assert.equal(fs.readFileSync(source, "utf8"), foo, "the source is never written through");
});

test("a skill linked into an unwritable directory inside the repository is withheld too", () => {
  const repo = makeRepo({
    "AGENTS.md": AGENTS,
    ".agents/skills/keep/SKILL.md": SKILL.replace("name: db", "name: keep"),
    "vendor/db/SKILL.md": SKILL,
  });
  const vendor = path.join(repo.root, "vendor");
  fs.symlinkSync(path.join(vendor, "db"), path.join(repo.root, ".agents", "skills", "db"));
  fs.chmodSync(path.join(vendor, "db"), 0o555);
  fs.chmodSync(vendor, 0o555);

  try {
    // Project scope, where confinement passes: the link lands inside the repository, so
    // only writability can keep it out - and the two scopes must agree about that.
    const { workspace, measured } = stageAndMeasure({
      repo,
      edit: (root) => writeIn(root, ".agents/skills/db/SKILL.md", SKILL),
    });

    assert.deepEqual(
      workspace.unstageable.map(({ path: file, reason }) => ({ path: file, reason })),
      [{ path: ".agents/skills/db/SKILL.md", reason: "resolves to a location that cannot be written" }],
    );
    assert.equal(workspace.originals.has(".agents/skills/db/SKILL.md"), false);
    // Re-creating it is the same unwritable path, not a new skill and not an out-of-repo one.
    assert.deepEqual(measured.stray, [{ file: ".agents/skills/db/SKILL.md", reason: STRAY_UNWRITABLE }]);
  } finally {
    fs.chmodSync(vendor, 0o755);
    fs.chmodSync(path.join(vendor, "db"), 0o755);
  }
});

test("an ignored file beside an external memory file is named by the path the user knows", () => {
  const repo = makeRepo({});
  const external = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-external-memory-stray-")));
  const memoryPath = path.join(external, "CLAUDE.md");
  const skillsDir = path.join(external, "skills");
  fs.writeFileSync(memoryPath, AGENTS);
  fs.mkdirSync(skillsDir);

  const workspace = prepareWorkspace({
    state: new State(repo.root).ensure(),
    repo,
    memoryFile: readMemoryFile(repo.root, memoryPath, { allowExternal: true }),
    skillsDir,
    skillDirs: [skillsDir],
    allowExternal: true,
  });
  // The memory file stages under `.external/<hash>/` too, so a scratch file written beside
  // it matches no skill directory - and naming it by that hash tells the reader nothing.
  writeIn(path.dirname(path.join(workspace.root, workspace.memoryWorkspacePath)), "CLAUDE.md.bak", "scratch");

  assert.deepEqual(measureWorkspace(workspace).stray, [
    { file: path.join(external, "CLAUDE.md.bak"), reason: STRAY_OUTSIDE_SURFACE },
  ]);
});

test("a skill in a store this user cannot read is skipped and named, not thrown", () => {
  const store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-locked-store-")));
  fs.mkdirSync(path.join(store, "locked"));
  const unreadable = path.join(store, "locked", "SKILL.md");
  fs.writeFileSync(unreadable, SKILL);
  // The writability probe looks at the directory, never at this file, so the read failure
  // is the only thing that can keep it out.
  fs.chmodSync(unreadable, 0o000);

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
