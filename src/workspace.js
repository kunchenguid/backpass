import fs from "node:fs";
import path from "node:path";

import { anchoredHunks, countOccurrences, span } from "./diff.js";
import { parseMemoryUnits } from "./memory.js";
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
 * One line's identity for extraction-recovery checks: verbatim modulo the noise a
 * faithful move is allowed to make. Unicode dashes fold to "-" (house style normalizes
 * them during moves) and interior whitespace collapses; anything more is a real change.
 */
export function normalizeRecoveryLine(line) {
  return String(line ?? "")
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** The normalized non-blank lines of a set of file texts, with occurrence counts. */
export function recoveredLineCounts(texts) {
  const counts = new Map();
  for (const text of texts) {
    for (const line of String(text ?? "").split("\n")) {
      const normalized = normalizeRecoveryLine(line);
      if (normalized) counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }
  }
  return counts;
}

/**
 * Split one pure-removal memory-file hunk at the boundary between text that lands in a
 * created skill and text that vanishes. Adjacent removals merge into one measured change
 * (`anchoredHunks`), so without this split an extraction and an unrelated deletion that
 * happen to sit next to each other in the file fuse into a single accept/reject decision.
 * The boundary is a decision boundary, and it falls on instruction-unit edges because a
 * skill carries whole sections.
 *
 * Returns the sub-hunks, or null when there is nothing to split (one kind only) or the
 * sub-hunks cannot be given unique, non-overlapping spans, in which case the merged hunk
 * is kept instead.
 */
export function splitRemovalHunk(hunk, { oldText, oldLines, recovered }) {
  // A removal that reaches the file's true tail cannot be split into independent
  // sub-hunks: `span`'s tail rule gives the final sub-hunk a LEADING newline, and that
  // is the same character its predecessor owns as its trailing newline. Applying one
  // decision then consumes the separator the other one's `find` needs, so the pair
  // composes in only one order - which breaks the any-subset-any-order contract the
  // writer relies on. No non-overlapping anchoring exists at that seam; keep the
  // merged hunk instead (a file ending in "\n" is unaffected: its final split("\n")
  // element is the empty string, which no text removal reaches).
  if (hunk.oldEnd === oldLines.length) return null;

  const lineKinds = new Map();
  for (let lineNo = hunk.oldStart; lineNo <= hunk.oldEnd; lineNo += 1) {
    const normalized = normalizeRecoveryLine(oldLines[lineNo - 1]);
    if (!normalized) continue;
    const remaining = recovered.get(normalized) || 0;
    lineKinds.set(lineNo, remaining > 0 ? "recovered" : "deleted");
    if (remaining > 0) recovered.set(normalized, remaining - 1);
  }

  for (const unit of parseMemoryUnits(oldText)) {
    const start = Math.max(unit.startLine, hunk.oldStart);
    const end = Math.min(unit.endLine, hunk.oldEnd);
    if (start > end) continue;
    const kinds = new Set();
    for (let lineNo = start; lineNo <= end; lineNo += 1) {
      if (lineKinds.has(lineNo)) kinds.add(lineKinds.get(lineNo));
    }
    if (kinds.size > 1) return null;
  }

  for (let lineNo = hunk.oldStart; lineNo <= hunk.oldEnd; lineNo += 1) {
    if (!/^#{1,6}\s+/.test(oldLines[lineNo - 1] || "")) continue;
    let contentLine = lineNo + 1;
    while (contentLine <= hunk.oldEnd && !normalizeRecoveryLine(oldLines[contentLine - 1])) contentLine += 1;
    if (contentLine > hunk.oldEnd || /^#{1,6}\s+/.test(oldLines[contentLine - 1] || "")) continue;
    if (lineKinds.get(lineNo) !== lineKinds.get(contentLine)) return null;
  }

  // Group the removed lines into maximal runs by recovery; blank lines never start a
  // run and attach to whichever run surrounds them.
  const runs = [];
  for (let lineNo = hunk.oldStart; lineNo <= hunk.oldEnd; lineNo += 1) {
    const kind = lineKinds.get(lineNo);
    if (!kind) continue;
    const current = runs[runs.length - 1];
    if (current && current.kind === kind) current.last = lineNo;
    else runs.push({ kind, first: lineNo, last: lineNo });
  }
  if (runs.length < 2) return null;

  const subHunks = runs.map((run, index) => {
    const start = index === 0 ? hunk.oldStart : runs[index - 1].last + 1;
    const end = index === runs.length - 1 ? hunk.oldEnd : run.last;
    const find = span(oldLines, start - 1, end);
    return {
      find,
      replace: "",
      oldStart: start,
      oldEnd: end,
      removed: end - start + 1,
      added: 0,
      lines: oldLines.slice(start - 1, end).map((text) => ({ type: "del", text })),
    };
  });

  if (subHunks.some((sub) => !sub.find || countOccurrences(oldText, sub.find) !== 1)) return null;
  return subHunks;
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

  // With the created files known, split any memory-file removal that mixes extracted
  // text (recovered in a created file) with deleted text, so the deletion is its own
  // measured change and stays independently decidable.
  const createdTexts = changes.filter((c) => c.kind === "created").map((c) => c.text);
  if (createdTexts.length) {
    const recovered = recoveredLineCounts(createdTexts);
    const oldText = originals.get(memoryPath) ?? "";
    const oldLines = oldText.split("\n");
    const measured = [];
    for (const change of changes) {
      if (change.kind !== "hunk" || change.file !== memoryPath || !change.removed || change.added) {
        measured.push(change);
        continue;
      }
      const subHunks = splitRemovalHunk(change, { oldText, oldLines, recovered });
      if (subHunks) measured.push(...subHunks.map((sub) => ({ kind: "hunk", file: memoryPath, ...sub })));
      else measured.push(change);
    }
    changes.splice(0, changes.length, ...measured);
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
