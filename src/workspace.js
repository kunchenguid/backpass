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
 * reviews. The copy is wiped and rebuilt on every synthesis.
 */

export const WORKSPACE_DIRNAME = "synthesis";

export function workspaceRoot(state) {
  return path.join(state.root, WORKSPACE_DIRNAME);
}

/**
 * Build a fresh staging copy. `originals` records every file placed there, so the
 * measurement can tell a modified file from a created or deleted one.
 */
export function prepareWorkspace({ state, repo, memoryFile, skillsDir }) {
  const root = workspaceRoot(state);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  const originals = new Map();
  const memoryTarget = path.join(root, memoryFile.path);
  fs.mkdirSync(path.dirname(memoryTarget), { recursive: true });
  fs.writeFileSync(memoryTarget, memoryFile.text);
  originals.set(memoryFile.path, memoryFile.text);

  const skillsSource = path.join(repo.root, skillsDir);
  if (fs.existsSync(skillsSource) && fs.statSync(skillsSource).isDirectory()) {
    for (const relative of walkFiles(skillsSource)) {
      const from = path.join(skillsSource, relative);
      const to = path.join(root, skillsDir, relative);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      originals.set(path.posix.join(skillsDir, relative), fs.readFileSync(from, "utf8"));
    }
  }
  fs.mkdirSync(path.join(root, skillsDir), { recursive: true });

  return { root, memoryPath: memoryFile.path, skillsDir, originals };
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
