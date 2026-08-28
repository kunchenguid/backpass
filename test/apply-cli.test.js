import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildProposal } from "../src/proposal.js";
import { stageAndMeasure } from "./helpers/staging.js";

/**
 * The propose-then-drift-then-apply path, through the real CLI.
 *
 * This is the shape that produced the 0.1.6 partial apply: a proposal measured against
 * one image of AGENTS.md, an upstream commit that rewrites text inside a hunk's window,
 * and an apply that then walks into a file it never measured. The assertions are the
 * ones a user can check - the process exit code, what it printed, and what is on disk -
 * so they stay true however the writer is refactored.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "backpass");
const FAKE_LAVISH = path.join(ROOT, "test", "fixtures", "fake-lavish", "lavish-axi");

const MEMORY_TEXT = [
  "# Demo agent memory",
  "",
  "## Build",
  "",
  "- Run `make build` before every push.",
  "",
  "## CI",
  "",
  "- `ci_timeout` is an idle timeout, not an absolute deadline; only the anchor re-arms.",
  "- CI readiness never treats an empty check list as green.",
  "- A cancelled check is never a job verdict, so the rerun runs before any fix round.",
  "",
  "## Release",
  "",
  "- Every macOS artifact is Developer ID signed on a macOS runner.",
  "- The executable identifier and Team ID are permanent and must never change.",
  "",
  "## Style",
  "",
  "- Never use the em dash.",
  "",
].join("\n");

/** The upstream commit that lands inside the CI hunk's window between propose and apply. */
const DRIFT_BULLET = "- GitHub's raw rollup returns superseded check runs; collapse them.\n";

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-apply-cli-")));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), MEMORY_TEXT);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "memory"], dir);
  return dir;
}

const sectionBody = (text, heading) => new RegExp(`(?<=## ${heading}\\n\\n)[\\s\\S]*?(?=\\n## )`).exec(text)[0];

/**
 * Produce a real proposal the way a run does: stage the memory file, let a stand-in
 * synthesis harness edit the staging copy with plain writes, measure it, and annotate
 * the measured changes. No model is involved and nothing textual is invented - the
 * hunks are cut from the file, exactly as in production.
 */
function proposeExtractions(dir) {
  const repo = { root: dir, realRoot: dir, name: path.basename(dir), worktrees: [dir], remotes: [] };
  const config = {
    budgetTokens: 5000,
    maxEditsPerRun: 20,
    minGapEvidence: 2,
    skillsDir: ".agents/skills",
    analysis: {},
    synthesis: {},
  };

  const staged = stageAndMeasure({
    repo,
    edit: (workspace) => {
      const memory = path.join(workspace, "AGENTS.md");
      let text = fs.readFileSync(memory, "utf8");
      for (const [heading, skill] of [
        ["CI", "ci-details"],
        ["Release", "release-details"],
      ]) {
        const body = sectionBody(text, heading);
        text = text.replace(body, `- Load \`${skill}\` for this topic.`);
        const dir_ = path.join(workspace, ".agents/skills", skill);
        fs.mkdirSync(dir_, { recursive: true });
        fs.writeFileSync(
          path.join(dir_, "SKILL.md"),
          `---\nname: ${skill}\ndescription: Use when touching ${heading.toLowerCase()}.\n---\n\n${body}\n`,
        );
      }
      fs.writeFileSync(memory, text);
    },
  });

  const hunks = staged.measured.changes.filter((c) => c.kind === "hunk");
  const created = staged.measured.changes.filter((c) => c.kind === "created");
  const skillOf = (name) => created.find((c) => c.file.includes(name)).id;
  const evidence = (text) => [{ polarity: "negative", text, source: "claude · fixture · turn 1" }];

  const { proposal, violations } = buildProposal(
    {
      edits: [
        {
          kind: "extract",
          title: "Move CI detail into a triggered skill",
          rationale: "always-loaded detail that few sessions need",
          changes: [hunks[0].id, skillOf("ci-details")],
          evidence: evidence("it re-read the CI section it never used"),
          transcripts: 3,
        },
        {
          kind: "extract",
          title: "Move release detail into a triggered skill",
          rationale: "same",
          changes: [hunks[1].id, skillOf("release-details")],
          evidence: evidence("release detail loaded on every turn"),
          transcripts: 3,
        },
      ],
    },
    {
      memoryFile: staged.memoryFile,
      config,
      repo,
      summary: { analyzedSessions: 3, totals: { positive: 1, negative: 2, gapClusters: 0 } },
      measured: staged.measured,
    },
  );
  assert.deepEqual(violations, [], "the fixture proposal must clear the gates");
  assert.equal(proposal.edits.length, 2);
  staged.state.writeProposal(proposal);
  return /** @type {any} */ (proposal);
}

/** Run `backpass apply` for real, with the fake review surface accepting every edit. */
function applyInvocation(dir, editIds) {
  const decisions = editIds.map((id) => `${id}=accepted`).join(" ");
  // Outside the repo: the assertions below read `git status`, so the harness must not
  // leave a file there itself.
  const scenario = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-lavish-")), "scenario.json");
  fs.writeFileSync(
    scenario,
    JSON.stringify({
      polls: [
        `prompts[1]{uid,prompt,selector,tag,text}:\n  "1","BACKPASS_DECISIONS ${decisions}",button#btn-apply,choice,${decisions}`,
      ],
    }),
  );
  return {
    args: [CLI, "apply", "--no-open"],
    options: {
      cwd: dir,
      encoding: /** @type {BufferEncoding} */ ("utf8"),
      env: /** @type {NodeJS.ProcessEnv} */ ({
        ...process.env,
        NO_COLOR: "1",
        BACKPASS_LAVISH_BIN: FAKE_LAVISH,
        FAKE_LAVISH_SCENARIO: scenario,
      }),
    },
  };
}

function runApply(dir, editIds) {
  const { args, options } = applyInvocation(dir, editIds);
  const result = spawnSync(process.execPath, args, options);
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

function runApplyAsync(dir, editIds) {
  const { args, options } = applyInvocation(dir, editIds);
  const child = spawn(process.execPath, args, options);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr, output: `${stdout}${stderr}` }));
  });
}

const porcelain = (dir) => execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim();

test("a memory file that changed after the proposal is left untouched by apply", () => {
  const dir = initRepo();
  const proposal = proposeExtractions(dir);

  // Upstream lands one bullet inside the CI hunk's window, exactly as #855 did.
  const memory = path.join(dir, "AGENTS.md");
  const drifted = fs
    .readFileSync(memory, "utf8")
    .replace("- CI readiness never treats an empty check list as green.\n", (line) => `${DRIFT_BULLET}${line}`);
  fs.writeFileSync(memory, drifted);
  git(["commit", "-qam", "upstream: collapse superseded check runs"], dir);
  assert.equal(porcelain(dir), "", "the repo is clean going in");

  const applied = runApply(
    dir,
    proposal.edits.map((e) => e.id),
  );

  assert.equal(applied.status, 1, `apply should fail:\n${applied.output}`);
  assert.equal(fs.readFileSync(memory, "utf8"), drifted, "AGENTS.md is byte-identical to what apply found");
  assert.equal(fs.existsSync(path.join(dir, ".agents")), false, "no skills directory");
  assert.equal(fs.existsSync(path.join(dir, ".claude")), false, "no .claude/skills symlink");
  assert.equal(porcelain(dir), "", "nothing at all landed in the project");

  assert.match(applied.output, /changed after this proposal was made/);
  assert.match(applied.output, new RegExp(proposal.memoryFile.hash), "names the image the edits were measured on");
  assert.match(applied.output, /nothing was written/);
  assert.match(applied.output, /Run `backpass`/, "names the command that regenerates against the current file");
  assert.match(
    applied.output,
    /reanalyzes transcripts against the new file, it does not reuse the stale judgments/,
    "explains that recovery does not reuse the proposal's stale analysis",
  );
});

test("an unchanged memory file applies every accepted edit and its skills", () => {
  const dir = initRepo();
  const proposal = proposeExtractions(dir);

  const applied = runApply(
    dir,
    proposal.edits.map((e) => e.id),
  );

  assert.equal(applied.status, 0, `apply should succeed:\n${applied.output}`);

  const memory = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.match(memory, /- Load `ci-details` for this topic\./);
  assert.match(memory, /- Load `release-details` for this topic\./);
  assert.ok(!memory.includes("A cancelled check is never a job verdict"), "the extracted body left the memory file");

  assert.match(
    fs.readFileSync(path.join(dir, ".agents/skills/ci-details/SKILL.md"), "utf8"),
    /A cancelled check is never a job verdict/,
  );
  assert.ok(fs.existsSync(path.join(dir, ".agents/skills/release-details/SKILL.md")));
  assert.equal(fs.lstatSync(path.join(dir, ".claude/skills")).isSymbolicLink(), true);

  assert.match(applied.output, /wrote AGENTS\.md \(e1, e2\)/);
  assert.equal(porcelain(dir).includes(".backpass"), false, "run state stays out of the working tree");
});

test("a symlinked memory file updates its target without replacing the link", () => {
  const dir = initRepo();
  const memory = path.join(dir, "AGENTS.md");
  const target = path.join(dir, "MEMORY.md");
  fs.renameSync(memory, target);
  fs.symlinkSync("MEMORY.md", memory);
  const proposal = proposeExtractions(dir);

  const applied = runApply(
    dir,
    proposal.edits.map((e) => e.id),
  );

  assert.equal(applied.status, 0, `apply should succeed:\n${applied.output}`);
  assert.equal(fs.lstatSync(memory).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(memory), "MEMORY.md");
  assert.match(fs.readFileSync(target, "utf8"), /- Load `ci-details` for this topic\./);
});

test("a concurrently created skill refuses the whole apply before any write", () => {
  const dir = initRepo();
  const proposal = proposeExtractions(dir);
  const memory = path.join(dir, "AGENTS.md");
  const before = fs.readFileSync(memory, "utf8");
  const concurrent = path.join(dir, ".agents/skills/release-details/SKILL.md");
  fs.mkdirSync(path.dirname(concurrent), { recursive: true });
  fs.writeFileSync(concurrent, "concurrent skill\n");

  const applied = runApply(
    dir,
    proposal.edits.map((e) => e.id),
  );

  assert.equal(applied.status, 1, `apply should refuse the collision:\n${applied.output}`);
  assert.match(applied.output, /release-details\/SKILL\.md already exists; nothing was written/);
  assert.equal(fs.readFileSync(memory, "utf8"), before);
  assert.equal(fs.readFileSync(concurrent, "utf8"), "concurrent skill\n");
  assert.equal(fs.existsSync(path.join(dir, ".agents/skills/ci-details/SKILL.md")), false);
  assert.equal(fs.existsSync(path.join(dir, ".claude")), false);
});

test("a later skill write failure rolls back skills written earlier in the same apply", () => {
  const dir = initRepo();
  const proposal = proposeExtractions(dir);
  const memory = path.join(dir, "AGENTS.md");
  const before = fs.readFileSync(memory, "utf8");

  // The exact skill target is absent at preflight, but its parent is a file. The first
  // skill therefore writes successfully and the second fails while creating its parent.
  const obstruction = path.join(dir, ".agents/skills/release-details");
  fs.mkdirSync(path.dirname(obstruction), { recursive: true });
  fs.writeFileSync(obstruction, "concurrent parent\n");

  const applied = runApply(
    dir,
    proposal.edits.map((e) => e.id),
  );

  assert.equal(applied.status, 1, `apply should report the write failure:\n${applied.output}`);
  assert.match(applied.output, /rolled back skill paths written earlier in this round/);
  assert.equal(fs.readFileSync(memory, "utf8"), before, "the memory pointers were not written");
  assert.equal(fs.existsSync(path.join(dir, ".agents/skills/ci-details/SKILL.md")), false);
  assert.equal(fs.readFileSync(obstruction, "utf8"), "concurrent parent\n");
  assert.equal(fs.existsSync(path.join(dir, ".claude")), false, "the new loading layout was rolled back too");
});

test("a later file failure rolls back earlier files and leaves memory untouched", () => {
  const dir = initRepo();
  const proposal = proposeExtractions(dir);
  const memory = path.join(dir, "AGENTS.md");
  const before = fs.readFileSync(memory, "utf8");
  const existing = path.join(dir, "existing.md");
  const lockedDir = path.join(dir, "locked");
  const locked = path.join(lockedDir, "existing.md");
  fs.writeFileSync(existing, "before\n");
  fs.mkdirSync(lockedDir);
  fs.writeFileSync(locked, "locked before\n");
  proposal.edits.push(
    {
      id: "e3",
      kind: "rewrite",
      file: "existing.md",
      find: "before\n",
      replace: "after\n",
    },
    {
      id: "e4",
      kind: "rewrite",
      file: "locked/existing.md",
      find: "locked before\n",
      replace: "locked after\n",
    },
  );
  fs.writeFileSync(path.join(dir, ".backpass/proposal.json"), JSON.stringify(proposal));
  fs.chmodSync(lockedDir, 0o555);

  let applied;
  try {
    applied = runApply(
      dir,
      proposal.edits.map((e) => e.id),
    );
  } finally {
    fs.chmodSync(lockedDir, 0o755);
  }

  assert.equal(applied.status, 1, `apply should report the later write failure:\n${applied.output}`);
  assert.match(applied.output, /locked\/existing\.md could not be written/);
  assert.equal(fs.readFileSync(existing, "utf8"), "before\n", "the earlier file write was rolled back");
  assert.equal(fs.readFileSync(locked, "utf8"), "locked before\n");
  assert.equal(fs.readFileSync(memory, "utf8"), before, "the memory file stayed byte-identical");
  assert.equal(fs.existsSync(path.join(dir, ".agents/skills/ci-details/SKILL.md")), false);
  assert.equal(fs.existsSync(path.join(dir, ".agents/skills/release-details/SKILL.md")), false);
  assert.equal(fs.existsSync(path.join(dir, ".agents")), false);
  assert.equal(fs.existsSync(path.join(dir, ".claude")), false);
  assert.equal(
    fs.readdirSync(dir).some((name) => name.includes(".backpass-")),
    false,
  );
});

test("apply refuses accepted paths that resolve to the same target", () => {
  const dir = initRepo();
  const proposal = proposeExtractions(dir);
  const memory = path.join(dir, "AGENTS.md");
  const memoryBefore = fs.readFileSync(memory, "utf8");
  const existing = path.join(dir, "existing.md");
  const alias = path.join(dir, "alias.md");
  fs.writeFileSync(existing, "before\n");
  fs.symlinkSync("existing.md", alias);
  proposal.edits.push(
    {
      id: "e3",
      kind: "rewrite",
      file: "existing.md",
      find: "before\n",
      replace: "first write\n",
    },
    {
      id: "e4",
      kind: "rewrite",
      file: "alias.md",
      find: "before\n",
      replace: "second write\n",
    },
  );
  fs.writeFileSync(path.join(dir, ".backpass/proposal.json"), JSON.stringify(proposal));

  const applied = runApply(
    dir,
    proposal.edits.map((e) => e.id),
  );

  assert.equal(applied.status, 1, `apply should refuse the collision:\n${applied.output}`);
  assert.match(applied.output, /alias\.md resolves to the same target as existing\.md; nothing was written/);
  assert.equal(fs.readFileSync(existing, "utf8"), "before\n");
  assert.equal(fs.readFileSync(memory, "utf8"), memoryBefore);
  assert.equal(fs.existsSync(path.join(dir, ".agents")), false);
});

test("rollback leaves concurrently changed files and skills untouched", { timeout: 15000 }, async () => {
  const dir = initRepo();
  const proposal = proposeExtractions(dir);
  const existing = path.join(dir, "existing.md");
  const concurrentSkill = path.join(dir, ".agents/skills/ci-details/SKILL.md");
  const slow = path.join(dir, "slow.md");
  const lockedDir = path.join(dir, "locked");
  const slowBefore = "a".repeat(8 * 1024 * 1024);
  const slowAfter = "b".repeat(8 * 1024 * 1024);
  fs.writeFileSync(existing, "before\n");
  fs.writeFileSync(slow, slowBefore);
  fs.mkdirSync(lockedDir);
  fs.writeFileSync(path.join(lockedDir, "existing.md"), "locked before\n");
  proposal.edits.push(
    {
      id: "e3",
      kind: "rewrite",
      file: "existing.md",
      find: "before\n",
      replace: "first write\n",
    },
    {
      id: "e4",
      kind: "rewrite",
      file: "slow.md",
      find: slowBefore,
      replace: slowAfter,
    },
    {
      id: "e5",
      kind: "rewrite",
      file: "locked/existing.md",
      find: "locked before\n",
      replace: "locked after\n",
    },
  );
  fs.writeFileSync(path.join(dir, ".backpass/proposal.json"), JSON.stringify(proposal));
  fs.chmodSync(lockedDir, 0o555);

  const applying = runApplyAsync(
    dir,
    proposal.edits.map((e) => e.id),
  );
  let changed = false;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (fs.readFileSync(existing, "utf8") === "first write\n") {
      fs.writeFileSync(existing, "concurrent write\n");
      fs.writeFileSync(concurrentSkill, "concurrent skill write\n");
      changed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  const applied = await applying;
  fs.chmodSync(lockedDir, 0o755);
  assert.equal(changed, true, `the apply never exposed its first committed file:\n${applied.output}`);
  assert.equal(applied.status, 1, `apply should fail:\n${applied.output}`);
  assert.match(applied.output, /existing\.md rollback conflict/);
  assert.match(applied.output, /ci-details\/SKILL\.md rollback conflict/);
  assert.equal(fs.readFileSync(existing, "utf8"), "concurrent write\n");
  assert.equal(fs.readFileSync(concurrentSkill, "utf8"), "concurrent skill write\n");
  assert.equal(fs.existsSync(path.join(dir, ".agents/skills/release-details/SKILL.md")), false);
  assert.equal(fs.readFileSync(slow, "utf8"), slowBefore);
});

test("skill rollback preserves a replacement made immediately before removal", () => {
  const dir = initRepo();
  const proposal = proposeExtractions(dir);
  const memory = path.join(dir, "AGENTS.md");
  const before = fs.readFileSync(memory, "utf8");
  const concurrentSkill = path.join(dir, ".agents/skills/ci-details/SKILL.md");
  const replacement = "concurrent replacement\n";
  fs.mkdirSync(path.join(dir, ".agents/skills"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude"));
  fs.symlinkSync("../.agents/skills", path.join(dir, ".claude/skills"), "dir");
  fs.chmodSync(dir, 0o555);

  const invocation = applyInvocation(
    dir,
    proposal.edits.map((edit) => edit.id),
  );
  invocation.args.unshift("--import", path.join(ROOT, "test/fixtures/replace-before-skill-rollback.js"));
  invocation.options.env = {
    ...invocation.options.env,
    BACKPASS_TEST_REPLACE_ON_ROLLBACK: concurrentSkill,
    BACKPASS_TEST_REPLACEMENT_TEXT: replacement,
  };

  let applied;
  try {
    const result = spawnSync(process.execPath, invocation.args, invocation.options);
    applied = { ...result, output: `${result.stdout}${result.stderr}` };
  } finally {
    fs.chmodSync(dir, 0o755);
  }

  assert.equal(applied.status, 1, `apply should report the write failure:\n${applied.output}`);
  assert.match(applied.output, /ci-details\/SKILL\.md rollback conflict/);
  assert.equal(fs.readFileSync(concurrentSkill, "utf8"), replacement);
  assert.equal(fs.existsSync(path.join(dir, ".agents/skills/release-details/SKILL.md")), false);
  assert.equal(fs.readFileSync(memory, "utf8"), before);
});

test("skill rollback restores an exact concurrent directory without recursively copying it", () => {
  const dir = initRepo();
  const proposal = proposeExtractions(dir);
  const concurrentSkill = path.join(dir, ".agents/skills/ci-details/SKILL.md");
  fs.mkdirSync(path.join(dir, ".agents/skills"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude"));
  fs.symlinkSync("../.agents/skills", path.join(dir, ".claude/skills"), "dir");
  fs.chmodSync(dir, 0o555);

  const invocation = applyInvocation(
    dir,
    proposal.edits.map((edit) => edit.id),
  );
  invocation.args.unshift("--import", path.join(ROOT, "test/fixtures/replace-before-skill-rollback.js"));
  invocation.options.env = {
    ...invocation.options.env,
    BACKPASS_TEST_REPLACE_ON_ROLLBACK: concurrentSkill,
    BACKPASS_TEST_REPLACEMENT_TEXT: "directory replacement\n",
    BACKPASS_TEST_REPLACEMENT_DIRECTORY: "1",
    BACKPASS_TEST_REJECT_DIRECTORY_COPY: "1",
  };

  let applied;
  try {
    const result = spawnSync(process.execPath, invocation.args, invocation.options);
    applied = { ...result, output: `${result.stdout}${result.stderr}` };
  } finally {
    fs.chmodSync(dir, 0o755);
  }

  assert.equal(applied.status, 1, `apply should report the write failure:\n${applied.output}`);
  assert.match(applied.output, /ci-details\/SKILL\.md rollback conflict/);
  assert.equal(fs.lstatSync(concurrentSkill).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(concurrentSkill, "marker.txt"), "utf8"), "directory replacement\n");
  assert.equal(
    fs.readdirSync(path.dirname(concurrentSkill)).some((name) => name.includes(".backpass-rollback-")),
    false,
  );
});

test("a memory write failure rolls back skills without truncating memory", () => {
  const dir = initRepo();
  const proposal = proposeExtractions(dir);
  const memory = path.join(dir, "AGENTS.md");
  const before = fs.readFileSync(memory, "utf8");
  fs.mkdirSync(path.join(dir, ".agents/skills"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude"));
  fs.symlinkSync("../.agents/skills", path.join(dir, ".claude/skills"), "dir");
  fs.chmodSync(dir, 0o555);

  let applied;
  try {
    applied = runApply(
      dir,
      proposal.edits.map((e) => e.id),
    );
  } finally {
    fs.chmodSync(dir, 0o755);
  }

  assert.equal(applied.status, 1, `apply should report the memory write failure:\n${applied.output}`);
  assert.match(applied.output, /AGENTS\.md could not be written/);
  assert.match(applied.output, /rolled back skill paths written earlier in this round/);
  assert.equal(fs.readFileSync(memory, "utf8"), before, "the memory file stayed byte-identical");
  assert.equal(fs.existsSync(path.join(dir, ".agents/skills/ci-details/SKILL.md")), false);
  assert.equal(fs.existsSync(path.join(dir, ".agents/skills/release-details/SKILL.md")), false);
  assert.equal(
    fs.readdirSync(dir).some((name) => name.includes(".backpass-")),
    false,
  );
});

test("apply names a memory file left over budget without refusing the shrink", () => {
  const dir = initRepo();
  const proposal = proposeExtractions(dir);
  // A cap this small cannot be met in one pass; the run is still legitimate progress.
  fs.writeFileSync(path.join(dir, ".backpassrc.json"), JSON.stringify({ budgetTokens: 20 }));

  const applied = runApply(
    dir,
    proposal.edits.map((e) => e.id),
  );

  assert.equal(applied.status, 0, `a shrinking run must not be refused:\n${applied.output}`);
  assert.match(applied.output, /wrote AGENTS\.md/);
  assert.match(applied.output, /is still \d+ tokens over the 20-token budget/);
  assert.match(applied.output, /run `backpass` again for the next shrink step/);
});
