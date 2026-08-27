import fs from "node:fs";
import path from "node:path";

import { anchoredHunks } from "./diff.js";
import { parseFrontmatter } from "./skills.js";
import { sha256 } from "./state.js";

/**
 * The synthesis staging workspace (design section 3, native-edit revision).
 *
 * The synthesis agent edits the memory file with its harness's own file tools - the
 * same `edit`/`write` it uses on any repo - instead of handing backpass text to splice.
 * So that a run stays safe to interrupt and `src/apply/writer.js` stays the only module
 * that writes to the repo, those tools never see the repo: they run in a staging copy
 * under `.backpass/synthesis/` holding only the memory file and the skills directory.
 * The agent reads the real repository by absolute path for grounding; what it changes in
 * the copy is measured here (`measureWorkspace`) and becomes the proposal the human
 * reviews. The copy is wiped and rebuilt on every synthesis - with one exception:
 * `backpass propose --resume` re-opens the copy an earlier run left behind
 * (`restoreWorkspace`), which is what the `synthesis.json` manifest written here is for.
 */

export const WORKSPACE_DIRNAME = "synthesis";
/** The manifest's shape. A tree written by a different shape is refused, never rebuilt over. */
export const WORKSPACE_MANIFEST_VERSION = 2;

export function workspaceRoot(state) {
  return path.join(state.root, WORKSPACE_DIRNAME);
}

/**
 * Build a fresh staging copy. `originals` records every file placed there, so the
 * measurement can tell a modified file from a created or deleted one.
 *
 * The same record is written next to the copy as `synthesis.json`, because `originals`
 * is what the measurement is *against*: without it a later process looking at the tree
 * could not tell an edit from the file it started as. That manifest is what makes
 * `backpass propose --resume` possible, and what lets it refuse a tree whose repo has
 * moved on rather than measure against the wrong baseline.
 */
export function prepareWorkspace({ state, repo, memoryFile, skillsDir, harnessCounts = {}, summary = null }) {
  const root = workspaceRoot(state);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  const originals = new Map();
  const memoryTarget = path.join(root, memoryFile.path);
  fs.mkdirSync(path.dirname(memoryTarget), { recursive: true });
  fs.writeFileSync(memoryTarget, memoryFile.text);
  originals.set(memoryFile.path, memoryFile.text);

  const skills = [];
  const skillsSource = path.join(repo.root, skillsDir);
  if (fs.existsSync(skillsSource) && fs.statSync(skillsSource).isDirectory()) {
    for (const relative of walkFiles(skillsSource)) {
      const from = path.join(skillsSource, relative);
      const to = path.join(root, skillsDir, relative);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      const text = fs.readFileSync(from, "utf8");
      const staged = path.posix.join(skillsDir, relative);
      originals.set(staged, text);
      skills.push({ path: staged, hash: sha256(text) });
    }
  }
  fs.mkdirSync(path.join(root, skillsDir), { recursive: true });

  state.writeWorkspaceManifest({
    version: WORKSPACE_MANIFEST_VERSION,
    stagedAt: new Date().toISOString(),
    repoRoot: repo.root,
    repoName: repo.name,
    memoryPath: memoryFile.path,
    memoryHash: memoryFile.hash,
    skillsDir,
    skills,
    harnessCounts,
    summary,
  });

  return { root, memoryPath: memoryFile.path, skillsDir, originals };
}

/**
 * Re-open the staging copy a previous run left behind, without touching a byte of it.
 *
 * Returns `{ workspace, manifest }`, or `{ refusal }` naming what is incompatible. Every
 * check is a read: a tree that cannot be resumed is left exactly as it is, because it is
 * the only copy of an expensive editing turn and the human may still want it.
 */
export function restoreWorkspace({ state, repo, memoryFile, skillsDir }) {
  const root = workspaceRoot(state);
  const manifest = state.readWorkspaceManifest();

  if (!fs.existsSync(root)) {
    return { refusal: { message: "there is no staged synthesis to resume", hint: "run `backpass propose` first" } };
  }
  if (!manifest) {
    // A tree staged before the manifest existed. What it was measured against is not
    // recoverable, and guessing the baseline is how a hunk lands on text it never saw.
    return {
      refusal: {
        message: `the staged synthesis in ${root} has no record of what it was measured against`,
        hint: "it was staged before backpass kept one; run `backpass propose` and a failure of that run will be resumable - nothing was deleted",
      },
    };
  }
  if (manifest.version !== WORKSPACE_MANIFEST_VERSION) {
    return {
      refusal: {
        message: `the staged synthesis in ${root} was written by a different version of backpass (manifest v${manifest.version})`,
        hint: "run `backpass propose` for a fresh synthesis; nothing was deleted",
      },
    };
  }
  if (manifest.repoRoot !== repo.root) {
    return {
      refusal: {
        message: `the staged synthesis belongs to ${manifest.repoRoot}, not ${repo.root}`,
        hint: "resume it from that checkout; nothing was deleted",
      },
    };
  }
  if (manifest.memoryPath !== memoryFile.path || manifest.skillsDir !== skillsDir) {
    return {
      refusal: {
        message:
          `the staged synthesis targets ${manifest.memoryPath} with skills in ${manifest.skillsDir}, ` +
          `but this run targets ${memoryFile.path} with skills in ${skillsDir}`,
        hint: "re-run without the differing flags, or run `backpass propose` for a fresh synthesis",
      },
    };
  }
  if (manifest.memoryHash !== memoryFile.hash) {
    return {
      refusal: {
        message:
          `${memoryFile.path} changed after the staged synthesis was measured ` +
          `(${manifest.memoryHash} -> ${memoryFile.hash}), so its edits no longer describe the file on disk`,
        hint: "run `backpass propose` to re-synthesize against the current file; the staged copy was left untouched",
      },
    };
  }
  if (!manifest.summary?.analyzedSessions) {
    return {
      refusal: {
        message: "the staged synthesis has no usable snapshot of the evidence it was built from",
        hint: "run `backpass propose` for a fresh synthesis; nothing was deleted",
      },
    };
  }

  const originals = new Map([[memoryFile.path, memoryFile.text]]);
  for (const entry of manifest.skills || []) {
    const source = path.join(repo.root, entry.path);
    if (!fs.existsSync(source)) {
      return {
        refusal: {
          message: `${entry.path} was in the repository when the synthesis was staged and is gone now`,
          hint: "run `backpass propose` to re-synthesize against the current repository; the staged copy was left untouched",
        },
      };
    }
    const text = fs.readFileSync(source, "utf8");
    if (sha256(text) !== entry.hash) {
      return {
        refusal: {
          message: `${entry.path} changed after the staged synthesis was measured`,
          hint: "run `backpass propose` to re-synthesize against the current repository; the staged copy was left untouched",
        },
      };
    }
    originals.set(entry.path, text);
  }

  if (!fs.existsSync(path.join(root, memoryFile.path))) {
    return {
      refusal: {
        message: `the staged synthesis in ${root} is incomplete: ${memoryFile.path} is missing from it`,
        hint: "run `backpass propose` for a fresh synthesis; nothing was deleted",
      },
    };
  }

  for (const relative of walkFiles(path.join(root, skillsDir))) {
    const staged = path.posix.join(skillsDir, relative);
    if (!originals.has(staged) && fs.existsSync(path.join(repo.root, staged))) {
      return {
        refusal: {
          message: `${staged} was created in the repository after this synthesis was staged`,
          hint: "move or remove the conflicting file, or run `backpass propose` for a fresh synthesis; nothing was deleted",
        },
      };
    }
  }

  return { workspace: { root, memoryPath: memoryFile.path, skillsDir, originals }, manifest };
}

function walkFiles(dir, prefix = "") {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(path.join(dir, entry.name), relative));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

/** A created file counts as a skill only in the layouts `loadSkills` reads. */
export function isSkillFilePath(relative, skillsDir) {
  const prefix = `${skillsDir}/`;
  if (!relative.startsWith(prefix)) return false;
  const inside = relative.slice(prefix.length);
  const parts = inside.split("/");
  if (parts.length === 1) return parts[0].endsWith(".md");
  return parts.length === 2 && parts[1] === "SKILL.md";
}

/** Split a SKILL.md into the fields `writeSkill` needs; null when the frontmatter is unusable. */
export function parseSkillFile(relative, text) {
  const frontmatter = parseFrontmatter(text);
  if (!frontmatter.name || !frontmatter.description) return null;
  const end = /^---\n[\s\S]*?\n---\n?/.exec(text);
  const body = end ? text.slice(end[0].length) : text;
  return {
    name: String(frontmatter.name).trim(),
    description: String(frontmatter.description).trim(),
    path: relative,
    body: body.trim(),
  };
}

/**
 * Everything that differs between the originals and the workspace now, as changes with
 * stable ids the annotate turn refers to:
 *
 *   { id: "H1", kind: "hunk",    file, find, replace, oldStart, oldEnd, removed, added, lines }
 *   { id: "H4", kind: "created", file, text, skill | null }   a new SKILL.md
 *   { id: "H5", kind: "deleted", file }                        a staged file removed
 *
 * Files outside the memory file and the skill layouts are `stray` - reported, never
 * carried. Ids are assigned in file order so a re-measurement after an unchanged
 * workspace yields identical ids.
 */
export function measureWorkspace(workspace) {
  const { root, memoryPath, skillsDir, originals } = workspace;
  /** @type {any[]} */
  const changes = [];
  const stray = [];
  const texts = new Map();

  const present = new Set(walkFiles(root).map((p) => p.split(path.sep).join("/")));

  const ordered = [memoryPath, ...[...originals.keys()].filter((f) => f !== memoryPath).sort()];
  for (const relative of ordered) {
    const original = originals.get(relative);
    if (!present.has(relative)) {
      changes.push({ kind: "deleted", file: relative });
      continue;
    }
    const text = fs.readFileSync(path.join(root, relative), "utf8");
    texts.set(relative, text);
    for (const hunk of anchoredHunks(original, text)) changes.push({ kind: "hunk", file: relative, ...hunk });
  }

  for (const relative of [...present].sort()) {
    if (originals.has(relative)) continue;
    if (!isSkillFilePath(relative, skillsDir)) {
      stray.push(relative);
      continue;
    }
    const text = fs.readFileSync(path.join(root, relative), "utf8");
    texts.set(relative, text);
    changes.push({ kind: "created", file: relative, text, skill: parseSkillFile(relative, text) });
  }

  changes.forEach((change, index) => {
    change.id = `H${index + 1}`;
  });

  return { changes, stray, texts, originals, signature: signatureOf(changes) };
}

function signatureOf(changes) {
  return sha256(
    JSON.stringify(changes.map((c) => [c.kind, c.file, c.find ?? "", c.replace ?? "", c.text ?? ""])),
  ).slice(0, 16);
}

/** The files backpass must find untouched in the repo after synthesis: a moved write is a bug, loudly. */
export function repoFingerprint(repo, files) {
  const out = {};
  for (const relative of files) {
    const absolute = path.join(repo.root, relative);
    out[relative] = fs.existsSync(absolute) ? sha256(fs.readFileSync(absolute, "utf8")) : null;
  }
  return out;
}
