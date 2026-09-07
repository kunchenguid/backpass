import fs from "node:fs";
import path from "node:path";

import { anchoredHunks, countOccurrences, span } from "./diff.js";
import { warn } from "./logger.js";
import { parseMemoryUnits, readOnlyResolvedPath, resolveMemoryPath } from "./memory.js";
import { isDirectoryEntry, parseFrontmatter, skillBody } from "./skills.js";
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

export function workspacePathFor(file) {
  if (!path.isAbsolute(file)) return file.split(path.sep).join("/");
  return path.posix.join(".external", sha256(file).slice(0, 16), path.basename(file));
}

/**
 * Build a fresh staging copy. `originals` records every file placed there, so the
 * measurement can tell a modified file from a created or deleted one. `stagedSkills`
 * narrows which existing skill files are copied (a targeted run stages only its write
 * surface); the skill-dir mappings stay, so a created SKILL.md is still measured.
 */
export function prepareWorkspace({
  state,
  repo,
  memoryFile,
  skillsDir,
  skillDirs = [skillsDir],
  stagedSkills = null,
  allowExternal = false,
}) {
  const root = workspaceRoot(state);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  const originals = new Map();
  const stagedPaths = new Map();
  const memoryWorkspacePath = workspacePathFor(memoryFile.path);
  const memoryTarget = path.join(root, memoryWorkspacePath);
  fs.mkdirSync(path.dirname(memoryTarget), { recursive: true });
  fs.writeFileSync(memoryTarget, memoryFile.text);
  originals.set(memoryFile.path, memoryFile.text);
  stagedPaths.set(memoryFile.path, memoryWorkspacePath);

  // A skill that resolves outside the repository is still loaded and still billed, but
  // project scope cannot write it - `resolveMemoryPath` refuses the path at apply, and a
  // refusal there drops the whole round. Leaving it out of staging is what makes it
  // impossible for such a file to become an edit at all.
  const confineTo = allowExternal ? null : realPath(repo.root) || path.resolve(repo.root);
  const skillMappings = skillDirs.map((logical) => ({
    logical,
    staged: workspacePathFor(logical),
    source: path.isAbsolute(logical) ? logical : path.join(repo.root, logical),
  }));
  const unstageable = [];
  const stagedIdentities = new Map();
  for (const { logical: sourceDir, staged: stagedDir, source: skillsSource } of skillMappings) {
    if (!fs.existsSync(skillsSource) || !fs.statSync(skillsSource).isDirectory()) continue;
    const confined = [];
    const toLogical = (relative) =>
      path.isAbsolute(sourceDir) ? path.join(sourceDir, relative) : path.posix.join(sourceDir, relative);
    for (const relative of walkFiles(skillsSource, "", confineTo, confined)) {
      const from = path.join(skillsSource, relative);
      const logical = toLogical(relative);
      if (stagedSkills && !stagedSkills.includes(logical)) continue;
      // Two links to one library are two names the harness loads, so both are walked and
      // both are billed - but one file cannot be two independently editable copies, and
      // apply refuses a round whose targets collide. The first name owns the write.
      const identity = realPath(from);
      const owner = identity && stagedIdentities.get(identity);
      if (owner) {
        unstageable.push({ path: logical, reason: `the same file is already staged as ${owner}` });
        continue;
      }
      // Outside a repository a link can land in a store nothing may write - the layout
      // this whole change exists to follow. Apply refuses such a path and that refusal
      // drops the round, so staging declares it read-only instead of offering the edit.
      if (allowExternal && readOnlyResolvedPath(from)) {
        unstageable.push({ path: logical, reason: READ_ONLY_UNWRITABLE, identity });
        continue;
      }
      const staged = path.posix.join(stagedDir, relative);
      const to = path.join(root, staged);
      // Following links means `from` can be any file in a foreign store, so a store this
      // user cannot read is skipped and named the way `loadSkills` skips one - never an
      // errno thrown out of workspace preparation.
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        originals.set(logical, fs.readFileSync(from, "utf8"));
      } catch (err) {
        fs.rmSync(to, { force: true });
        originals.delete(logical);
        unstageable.push({ path: logical, reason: READ_ONLY_UNREADABLE });
        warn(`${logical} could not be read (${err.message}); it stays out of the staging copy`);
        continue;
      }
      if (identity) stagedIdentities.set(identity, logical);
      stagedPaths.set(logical, staged);
    }
    unstageable.push(...confined.map((relative) => ({ path: toLogical(relative), reason: READ_ONLY_OUTSIDE_REPO })));
  }
  fs.mkdirSync(path.join(root, workspacePathFor(skillsDir)), { recursive: true });

  return {
    root,
    memoryPath: memoryFile.path,
    memoryWorkspacePath,
    skillsDir,
    skillDirs,
    skillMappings,
    stagedPaths,
    originals,
    confineTo,
    unstageable,
    stagedIdentities,
  };
}

/** Resolved identity of a path, or null when it cannot be resolved (broken link). */
function realPath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

/** "dir", "file", or null once symlinks are followed; a broken link is null, never a throw. */
function entryKind(dir, entry) {
  if (isDirectoryEntry(dir, entry)) return "dir";
  if (entry.isFile()) return "file";
  if (!entry.isSymbolicLink()) return null;
  try {
    return fs.statSync(path.join(dir, entry.name)).isFile() ? "file" : null;
  } catch {
    return null;
  }
}

const SKILL_FILENAME = "SKILL.md";

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** True when an already-resolved path lies strictly inside `root`; a null root confines nothing. */
function withinRoot(root, resolved) {
  if (!root) return true;
  if (!resolved) return false;
  const relative = path.relative(root, resolved);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function walkFiles(dir, prefix = "", confineTo = null, confined = [], ancestors = null) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  // Following directory links hands the walk cycles it must not recurse into: a self
  // link, a link back to an ancestor, or a mutual pair. The guard is ancestry, not a
  // global visited set - two separate links to one shared library are two directories
  // the harness really loads, and each must still be walked and billed.
  //
  // Leaf-only staging (below) currently keeps this dormant: a symlinked directory is
  // never recursed into, and a real directory is always deeper than its ancestors, so the
  // only live effect left is skipping a top-level self-link back to the skills root. It
  // re-arms the moment subtree walking under a symlinked directory is restored.
  const chain = ancestors || new Set([realPath(dir)].filter(Boolean));
  // One rule for taking a file, wherever the walk reaches it: a path that resolves
  // outside the root is named for the caller instead of staged, so the containment
  // invariant cannot hold on one branch and not its sibling.
  const take = (absolute, relativePath) => {
    if (!confineTo || withinRoot(confineTo, realPath(absolute))) out.push(relativePath);
    else confined.push(relativePath);
  };
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    // Follow symlinks: a skills directory is commonly a set of links into a shared
    // library, and those are the files the harness loads. Staging copies what it finds,
    // so an edit lands in the staging copy and never writes through a link.
    const target = entryKind(dir, entry);
    if (target === "dir") {
      const child = path.join(dir, entry.name);
      const identity = realPath(child);
      if (!identity || chain.has(identity)) continue;
      // Pruned here, but named: the caller tells the model these are read-only rather
      // than letting a proposed edit to one be discarded without a reason.
      if (!withinRoot(confineTo, identity)) {
        confined.push(relative);
        continue;
      }
      // A link may point at anything - in the layout that motivated following links at
      // all, a whole plugin repository. Only the file the skill layout loads is taken,
      // so the target's subtree is never walked, copied, or read.
      if (entry.isSymbolicLink()) {
        const leaf = path.join(child, SKILL_FILENAME);
        if (prefix === "" && isFile(leaf)) take(leaf, path.posix.join(relative, SKILL_FILENAME));
        continue;
      }
      out.push(...walkFiles(child, relative, confineTo, confined, new Set(chain).add(identity)));
    } else if (target === "file") {
      take(path.join(dir, entry.name), relative);
    }
  }
  return out;
}

/** Why a loaded skill is absent from the staging copy: the skill index must say which. */
const READ_ONLY_OUTSIDE_REPO = "resolves outside the repository";
const READ_ONLY_UNREADABLE = "could not be read when the staging copy was built";
const READ_ONLY_UNWRITABLE = "resolves to a location that cannot be written";

/** Why measurement dropped a file the model wrote: the note the human reads must say which. */
export const STRAY_OUTSIDE_SURFACE = "synthesis wrote it outside the memory file and skills";
export const STRAY_OUTSIDE_REPO = "it resolves outside the repository, which project scope cannot write";
export const strayAliasReason = (owner) => `it is the same file already staged as ${owner}`;
export const STRAY_UNWRITABLE =
  "it resolves to a location that cannot be written, so staging withheld it from the copy";

/** A created file counts as a skill only in the layouts `loadSkills` reads. */
export function isSkillFilePath(relative, skillsDir) {
  const dirs = Array.isArray(skillsDir) ? skillsDir : [skillsDir];
  return dirs.some((dir) => {
    if (!relative || !dir) return false;
    const windows = relative.includes("\\") || dir.includes("\\") || path.win32.isAbsolute(relative);
    const paths = windows ? path.win32 : path;
    const inside = paths.relative(dir, relative);
    if (!inside || inside === ".." || inside.startsWith(`..${paths.sep}`) || paths.isAbsolute(inside)) return false;
    const parts = inside.split(paths.sep);
    if (parts.length === 1) return parts[0].endsWith(".md");
    return parts.length === 2 && parts[1] === "SKILL.md";
  });
}

/** Split a SKILL.md into the fields `writeSkill` needs; null when the frontmatter is unusable. */
export function parseSkillFile(relative, text) {
  const frontmatter = parseFrontmatter(text);
  if (!frontmatter.name || !frontmatter.description) return null;
  return {
    name: String(frontmatter.name).trim(),
    description: String(frontmatter.description).trim(),
    path: relative,
    body: skillBody(text),
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
 * created or extended skill and text that vanishes. Adjacent removals merge into one
 * measured change (`anchoredHunks`), so without this split an extraction and an unrelated
 * deletion that happen to sit next to each other in the file fuse into a single
 * accept/reject decision.
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
  const {
    root,
    memoryPath,
    skillsDir,
    skillDirs = [skillsDir],
    skillMappings = skillDirs.map((logical) => ({ logical, staged: workspacePathFor(logical) })),
    stagedPaths = new Map([...workspace.originals.keys()].map((file) => [file, workspacePathFor(file)])),
    originals,
    confineTo = null,
    stagedIdentities = new Map(),
    unstageable = [],
  } = workspace;
  /** @type {any[]} */
  const changes = [];
  const stray = [];
  const texts = new Map();

  const present = new Set(walkFiles(root).map((p) => p.split(path.sep).join("/")));

  const ordered = [memoryPath, ...[...originals.keys()].filter((f) => f !== memoryPath).sort()];
  for (const logical of ordered) {
    const original = originals.get(logical);
    const staged = stagedPaths.get(logical) || workspacePathFor(logical);
    if (!present.has(staged)) {
      changes.push({ kind: "deleted", file: logical, workspaceFile: staged });
      continue;
    }
    const text = fs.readFileSync(path.join(root, staged), "utf8");
    texts.set(logical, text);
    for (const hunk of anchoredHunks(original, text)) {
      changes.push({ kind: "hunk", file: logical, workspaceFile: staged, ...hunk });
    }
  }

  const knownStaged = new Set(stagedPaths.values());
  for (const staged of [...present].sort()) {
    if (knownStaged.has(staged)) continue;
    const mapping = skillMappings.find(({ staged: dir }) => staged === dir || staged.startsWith(`${dir}/`));
    if (!mapping) {
      stray.push({ file: staged, reason: STRAY_OUTSIDE_SURFACE });
      continue;
    }
    const inside = staged.slice(mapping.staged.length).replace(/^\//, "");
    // Every note names the path the reader knows - the repository path, or the real one a
    // user-scope entry resolves to - never the `.external/<hash>` the staging copy uses.
    const logical = path.isAbsolute(mapping.logical)
      ? path.join(mapping.logical, inside)
      : path.posix.join(mapping.logical, inside);
    if (!isSkillFilePath(logical, skillDirs)) {
      stray.push({ file: logical, reason: STRAY_OUTSIDE_SURFACE });
      continue;
    }
    // Staging leaves out a skill that resolves outside the repository; measurement must
    // not carry one back in as a created file, which apply could never write either.
    // The gate is apply's own, so the two can never disagree about what is reachable.
    if (confineTo) {
      try {
        resolveMemoryPath(confineTo, logical);
      } catch {
        stray.push({ file: logical, reason: STRAY_OUTSIDE_REPO });
        continue;
      }
    }
    // Staging gave one name of an aliased library the write; a file written at another of
    // its names is that same file, and apply refuses a skill whose path already exists -
    // a refusal that drops every other accepted edit with it.
    const repoIdentity = mapping.source ? realPath(path.join(mapping.source, inside)) : null;
    const owner = stagedIdentities.get(repoIdentity);
    if (owner) {
      stray.push({ file: logical, reason: strayAliasReason(owner) });
      continue;
    }
    // Staging withheld this skill because a write to it could not land, and the skill
    // index says so - but the model still has its path. Writing there re-creates a file
    // apply refuses for already existing, and that refusal drops every accepted edit.
    const withheld = unstageable.some(
      (entry) =>
        entry.reason === READ_ONLY_UNWRITABLE &&
        (entry.path === logical || (entry.identity && entry.identity === repoIdentity)),
    );
    if (withheld) {
      stray.push({ file: logical, reason: STRAY_UNWRITABLE });
      continue;
    }
    const text = fs.readFileSync(path.join(root, staged), "utf8");
    texts.set(logical, text);
    changes.push({
      kind: "created",
      file: logical,
      workspaceFile: staged,
      text,
      skill: parseSkillFile(logical, text),
    });
  }

  // Split any memory-file removal that mixes extracted text (recovered in a created
  // skill or in a modified existing one) with deleted text, so the deletion is its own
  // measured change and stays independently decidable.
  const createdTexts = changes.filter((c) => c.kind === "created").map((c) => c.text);
  const extendedSkillFiles = [
    ...new Set(
      changes
        .filter((c) => c.kind === "hunk" && c.file !== memoryPath && isSkillFilePath(c.file, skillDirs))
        .map((c) => c.file),
    ),
  ];
  const recoveredTexts = [...createdTexts, ...extendedSkillFiles.map((file) => texts.get(file) ?? "")];
  if (recoveredTexts.length) {
    const recovered = recoveredLineCounts(recoveredTexts);
    const oldText = originals.get(memoryPath) ?? "";
    const oldLines = oldText.split("\n");
    const measured = [];
    for (const change of changes) {
      if (change.kind !== "hunk" || change.file !== memoryPath || !change.removed || change.added) {
        measured.push(change);
        continue;
      }
      const subHunks = splitRemovalHunk(change, { oldText, oldLines, recovered });
      if (subHunks) {
        measured.push(
          ...subHunks.map((sub) => ({
            kind: "hunk",
            file: memoryPath,
            workspaceFile: change.workspaceFile,
            ...sub,
          })),
        );
      } else measured.push(change);
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
    const absolute = path.isAbsolute(relative) ? relative : path.join(repo.root, relative);
    out[relative] = fs.existsSync(absolute) ? sha256(fs.readFileSync(absolute, "utf8")) : null;
  }
  return out;
}
