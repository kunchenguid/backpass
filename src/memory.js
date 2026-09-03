import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sha256 } from "./state.js";
import { estimateTokens } from "./tokens.js";
import { UserError } from "./logger.js";

/**
 * Memory files are the weights. To talk about them precisely, backpass parses each
 * file into addressable instruction units (design section 3.1):
 *
 *   - sections come from markdown headings
 *   - units come from list items and paragraphs inside those sections
 *   - each unit gets a content hash (survives cosmetic edits elsewhere in the file)
 *     and a readable alias AG-001, AG-002, ... used in prompts and evidence
 *   - eligible prose above ATTRIBUTION_SPLIT_TOKENS is conservatively split at
 *     high-confidence sentence boundaries into AG-nnn.m attribution parts; the parent
 *     alias and line span stay put
 *
 * Evidence anchors to an addressable instruction id; the hash lets it re-anchor across runs.
 */

/** Eligible prose above this is too coarse to attribute and may get dotted sentence-part ids. */
export const ATTRIBUTION_SPLIT_TOKENS = 120;

const FENCE = /^\s*(```|~~~)/;

function normalizeForHash(text) {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function unitHash(text) {
  return sha256(normalizeForHash(text)).slice(0, 12);
}

function alias(index) {
  return `AG-${String(index + 1).padStart(3, "0")}`;
}

/**
 * Split memory-file text into instruction units. Fenced code blocks stay attached to
 * the paragraph they belong to rather than being split into nonsense lines.
 */
export function parseMemoryUnits(text) {
  const lines = text.split("\n");
  const units = [];
  const headings = [];

  let buffer = [];
  let bufferStart = 0;
  let inFence = false;
  let fenceMarker = null;

  const flush = (endLine) => {
    const raw = buffer.join("\n");
    if (raw.trim()) {
      units.push({
        text: raw.replace(/\s+$/, ""),
        section: headings.join(" > "),
        startLine: bufferStart + 1,
        endLine,
      });
    }
    buffer = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (FENCE.test(line)) {
      const marker = line.trim().slice(0, 3);
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
      }
      if (!buffer.length) bufferStart = i;
      buffer.push(line);
      continue;
    }

    if (inFence) {
      buffer.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush(i);
      const depth = heading[1].length;
      headings.length = Math.min(headings.length, depth - 1);
      headings[depth - 1] = heading[2].trim();
      for (let d = 0; d < depth - 1; d += 1) headings[d] = headings[d] ?? "";
      continue;
    }

    const isListItem = /^\s*([-*+]|\d+[.)])\s+/.test(line);
    const isBlank = line.trim() === "";

    if (isBlank) {
      flush(i);
      continue;
    }
    // A new list item starts a new unit; continuation lines stay with it.
    if (isListItem && buffer.length && /^\s*([-*+]|\d+[.)])\s+/.test(buffer[0])) {
      flush(i);
    }
    if (!buffer.length) bufferStart = i;
    buffer.push(line);
  }
  flush(lines.length);

  return units.map((unit, index) => {
    const base = {
      id: alias(index),
      hash: unitHash(unit.text),
      tokens: estimateTokens(unit.text),
      ...unit,
    };
    const parts = attributionParts(base);
    return parts ? { ...base, parts } : base;
  });
}

function isListItemText(text) {
  return /^\s*([-*+]|\d+[.)])\s+/m.test(text);
}

function unitHasFence(text) {
  return text.split("\n").some((line) => FENCE.test(line));
}

const ABBREVIATIONS = new Set([
  "approx",
  "capt",
  "cf",
  "cmdr",
  "col",
  "dept",
  "dr",
  "e.g",
  "etc",
  "fig",
  "gen",
  "gov",
  "i.e",
  "inc",
  "jr",
  "lt",
  "misc",
  "mr",
  "mrs",
  "ms",
  "no",
  "prof",
  "rep",
  "rev",
  "sen",
  "sr",
  "st",
  "v",
  "vs",
]);

function confidentSentenceBoundary(text, sentenceStart, terminator) {
  let end = terminator + 1;
  while (end < text.length && /["')\]}*_~\u2019\u201d]/u.test(text[end])) end += 1;
  if (end >= text.length || !/\s/u.test(text[end])) return null;

  let next = end;
  while (next < text.length && /\s/u.test(text[next])) next += 1;
  let visibleNext = next;
  while (visibleNext < text.length && /["'([{*`_~\u2018\u201c]/u.test(text[visibleNext])) visibleNext += 1;
  if (visibleNext >= text.length || !/[\p{L}\p{N}$@/\\]/u.test(text[visibleNext])) return null;

  if (text[terminator] === ".") {
    if (terminator === 0 || /\s/u.test(text[terminator - 1])) return null;
    const beforeTerminator = text.slice(sentenceStart, terminator);
    const precedingToken = beforeTerminator.match(/\S+$/u)?.[0] || "";
    if (/[\\/]/u.test(precedingToken)) {
      const nextTokens = text.slice(next).trimStart().split(/\s+/u).slice(0, 2).join(" ");
      const finalPathSegment = precedingToken.split(/[\\/]/u).at(-1) || "";
      const pathEndsWithExtension = /\.[\p{L}\p{N}]+$/u.test(finalPathSegment);
      if (/[\\/]/u.test(nextTokens) && !pathEndsWithExtension) return null;
    }
    const rawPrefix = beforeTerminator.trim();
    if (/^\d+$/u.test(rawPrefix)) return null;
    const prefix = rawPrefix.replace(/["')\]}*`_~\u2019\u201d]+$/u, "");
    const token = prefix.match(/([\p{L}\p{N}.]+)$/u)?.[1] || "";
    if (!token) return null;
    if (ABBREVIATIONS.has(token.toLowerCase()) || /^\p{L}$/u.test(token) || /^(?:\p{L}\.)+\p{L}$/u.test(token)) {
      return null;
    }
  }

  return { end, next };
}

export function splitAttributionSentences(text) {
  const sentences = [];
  let start = 0;
  let codeDelimiter = 0;
  let quotedPathEnd = -1;
  for (let i = 0; i < text.length; i += 1) {
    let backslashes = 0;
    while (text[i - backslashes - 1] === "\\") backslashes += 1;
    const escaped = backslashes % 2 === 1;

    if (text[i] === "`") {
      let run = 1;
      while (text[i + run] === "`") run += 1;
      if (!escaped) {
        if (codeDelimiter === 0) codeDelimiter = run;
        else if (codeDelimiter === run) codeDelimiter = 0;
      }
      i += run - 1;
      continue;
    }
    if (codeDelimiter) continue;

    if (i === quotedPathEnd) {
      quotedPathEnd = -1;
      continue;
    }
    if (quotedPathEnd > i) continue;
    if (!escaped && ['"', "'"].includes(text[i])) {
      let closing = i + 1;
      while (closing < text.length) {
        if (text[closing] === text[i] && text[closing - 1] !== "\\") break;
        closing += 1;
      }
      const value = text.slice(i + 1, closing);
      if (closing < text.length && /^(?:[A-Za-z]:[\\/]|\\\\|\.{0,2}[\\/]|~[\\/])|[\\/]/u.test(value)) {
        quotedPathEnd = closing;
        continue;
      }
    }

    if (![".", "!", "?"].includes(text[i])) continue;
    const boundary = confidentSentenceBoundary(text, start, i);
    if (!boundary) continue;
    sentences.push(text.slice(start, boundary.end).trim());
    start = boundary.next;
    i = boundary.next - 1;
  }
  sentences.push(text.slice(start).trim());
  return sentences.length >= 2 ? sentences.filter(Boolean) : [];
}

function attributionParts(unit) {
  if (unit.tokens <= ATTRIBUTION_SPLIT_TOKENS) return null;
  if (isListItemText(unit.text) || unitHasFence(unit.text)) return null;
  const sentences = splitAttributionSentences(unit.text);
  if (sentences.length < 2) return null;
  return sentences.map((text, index) => ({
    id: `${unit.id}.${index + 1}`,
    hash: unitHash(text),
    tokens: estimateTokens(text),
    text,
    section: unit.section,
    startLine: unit.startLine,
    endLine: unit.endLine,
    parentId: unit.id,
  }));
}

/** Addressable instructions for analysis, fold, and prompts: sentence parts when present. */
export function instructionUnits(memoryFile) {
  return (memoryFile?.units || []).flatMap((unit) => (unit.parts?.length ? unit.parts : [unit]));
}

/** Resolve an AG-nnn or AG-nnn.m id onto the parent unit or an attribution part. */
export function findInstructionUnit(memoryFile, id) {
  if (!memoryFile?.units || !id) return null;
  for (const unit of memoryFile.units) {
    if (unit.id === id) return unit;
    const part = unit.parts?.find((candidate) => candidate.id === id);
    if (part) return part;
  }
  return null;
}

/**
 * The fingerprint of one memory file's exact bytes. It is written into the proposal and
 * re-checked at apply, so it has exactly one definition: a proposal and the freshness
 * check that guards it can never disagree about what "unchanged" means.
 */
export function memoryTextHash(text) {
  return `sha256:${sha256(text).slice(0, 16)}`;
}

export function resolveMemoryPath(repoRoot, configuredPath, { allowExternal = false } = {}) {
  const expanded =
    configuredPath === "~" || configuredPath.startsWith("~/")
      ? path.join(os.homedir(), configuredPath.slice(configuredPath === "~" ? 1 : 2))
      : configuredPath;
  const root = path.resolve(repoRoot);
  const absolute = path.resolve(root, expanded);
  if (!allowExternal) {
    let existing = absolute;
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
    let realRoot;
    let realExisting;
    try {
      realRoot = fs.realpathSync(root);
      realExisting = fs.realpathSync(existing);
    } catch {
      realRoot = root;
      realExisting = existing;
    }
    const resolved = path.resolve(realExisting, path.relative(existing, absolute));
    const relative = path.relative(realRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new UserError(`${configuredPath} resolves outside the project root; project scope cannot access it`);
    }
  }
  return absolute;
}

export function readMemoryFile(repoRoot, relativePath, options = {}) {
  const absolute = resolveMemoryPath(repoRoot, relativePath, options);
  if (!fs.existsSync(absolute)) return null;
  const text = fs.readFileSync(absolute, "utf8");
  return {
    path: relativePath,
    absolute,
    text,
    hash: memoryTextHash(text),
    tokens: estimateTokens(text),
    units: parseMemoryUnits(text),
  };
}

/** Load every configured memory file that actually exists in the repo. */
export function loadMemoryFiles(repoRoot, memoryFiles, options = {}) {
  return memoryFiles.map((f) => readMemoryFile(repoRoot, f, options)).filter(Boolean);
}

/** Combined hash across all memory files - the "weights version" evidence is keyed to. */
export function memorySetHash(files) {
  return `sha256:${sha256(files.map((f) => `${f.path}:${f.hash}`).join("|")).slice(0, 16)}`;
}

/**
 * The memory-surface hash: the memory-set hash extended with the always-loaded skill
 * layer, which is exactly the description lines. Analysis is judged against the
 * instruction index AND the skill descriptions, so editing a description invalidates
 * cached evidence the same way editing the memory file does - while a body edit
 * invalidates nothing, because nothing is judged against bodies. A repo without skills
 * keeps the plain set hash, so its cached evidence survives this hash unchanged.
 */
export function memorySurfaceHash(setHash, skills) {
  if (!skills?.length) return setHash;
  const layer = skills.map((s) => `${s.path}:${s.name || ""}:${s.description || ""}`).join("|");
  return `sha256:${sha256(`${setHash}|${layer}`).slice(0, 16)}`;
}

function formatIndexEntry(unit) {
  const lines = unit.startLine === unit.endLine ? `L${unit.startLine}` : `L${unit.startLine}-${unit.endLine}`;
  return `[${unit.id}] (${unit.tokens} tok, ${lines})${unit.section ? ` <${unit.section}>` : ""}\n${unit.text}`;
}

/**
 * Render the instruction index that both prompt tiers see. It is a lookup table keyed
 * by alias, never a stand-in for the file: units are listed with the lines they occupy
 * so the synthesis agent can find them in the raw file it edits. Oversized paragraphs
 * retain an unbracketed positional AG-nnn alias for line-oriented edits and expose only
 * their bracketed AG-nnn.m sentence parts as attribution targets.
 */
export function renderInstructionIndex(file) {
  const blocks = [];
  for (const unit of file.units) {
    if (unit.parts?.length) {
      const lines = unit.startLine === unit.endLine ? `L${unit.startLine}` : `L${unit.startLine}-${unit.endLine}`;
      blocks.push(
        `Oversized paragraph ${unit.id} (${unit.tokens} tok, ${lines})` +
          `${unit.section ? ` <${unit.section}>` : ""} is one blob; ${unit.id} is only its line-oriented alias. ` +
          `Attribute evidence only to the sentence-part IDs below ` +
          `(${unit.parts.map((part) => part.id).join(", ")}). If these fail to steer, split the ` +
          `paragraph into list items in place - a bold label on the blob is not a strengthen.`,
      );
      for (const part of unit.parts) blocks.push(formatIndexEntry(part));
    } else {
      blocks.push(formatIndexEntry(unit));
    }
  }
  return blocks.join("\n\n");
}

export function similarityFeatures(text) {
  const words = normalizeForHash(text).split(" ").filter(Boolean);
  if (words.length < 2) return new Set(words);
  const out = new Set();
  for (let i = 0; i < words.length - 1; i += 1) out.add(`${words[i]} ${words[i + 1]}`);
  return out;
}

export function featureSimilarity(a, b) {
  if (!a.size || !b.size) return a.size === b.size ? 1 : 0;
  let shared = 0;
  for (const feature of a) if (b.has(feature)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/** Sorensen-Dice similarity over word bigrams, used for re-anchoring. */
export function similarity(a, b) {
  return featureSimilarity(similarityFeatures(a), similarityFeatures(b));
}

/**
 * Re-anchor an instruction reference from a previous run onto the current file.
 * Exact hash match wins; otherwise the best fuzzy match above threshold; otherwise stale.
 */
export function reanchor(reference, file, threshold = 0.6) {
  if (reference.hash) {
    const exact = file.units.find((u) => u.hash === reference.hash);
    if (exact) return { unit: exact, match: "hash", score: 1 };
  }
  if (reference.id) {
    const byId = file.units.find((u) => u.id === reference.id);
    if (byId && (!reference.text || similarity(byId.text, reference.text) >= threshold)) {
      return { unit: byId, match: "id", score: 1 };
    }
  }
  if (!reference.text) return { unit: null, match: "stale", score: 0 };

  let best = null;
  let bestScore = 0;
  for (const unit of file.units) {
    const score = similarity(unit.text, reference.text);
    if (score > bestScore) {
      best = unit;
      bestScore = score;
    }
  }
  if (best && bestScore >= threshold) return { unit: best, match: "fuzzy", score: bestScore };
  return { unit: null, match: "stale", score: bestScore };
}

/**
 * Pointer detection. The convention for covering both harness families without
 * duplicating content is a canonical AGENTS.md plus a CLAUDE.md that only contains the
 * `@AGENTS.md` import (Claude Code inlines it at load time). Such a file carries no
 * instructions of its own, so optimizing the target is fully correct and the pointer
 * stays valid afterwards.
 *
 * A file is a pointer to `target` when, ignoring blank lines and HTML comments, its
 * only content is the import line (`@AGENTS.md` or `@./AGENTS.md`).
 */
export function isPointerTo(text, target, options = {}) {
  const lines = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length !== 1) return false;
  const imported = lines[0].replace(/^@\.\//, "@");
  if (!imported.startsWith("@")) return false;

  const spec = imported.slice(1);
  const home = options.home || os.homedir();
  const fromDir = options.fromDir || options.root || "";
  const expand = (p) => {
    if (p === "~") return home;
    if (p.startsWith("~/")) return path.join(home, p.slice(2));
    return p;
  };
  const resolvedSpec = path.isAbsolute(expand(spec)) ? expand(spec) : path.resolve(fromDir || ".", spec);
  const resolvedTarget = path.isAbsolute(expand(target)) ? expand(target) : path.resolve(fromDir || ".", target);
  return resolvedSpec === resolvedTarget;
}

/**
 * Resolve the memory file a run optimizes from the configured order.
 *
 *   primary   the first configured file that exists (null when none does)
 *   pointers  other configured files that are pointers to the primary - silently fine
 *   separate  other configured files with their own content - NOT updated by a run;
 *             the caller warns so divergence is never silent
 *
 * The weights hash still covers every existing file, as before, so cached evidence
 * survives this resolution unchanged.
 */
export function resolveMemoryFiles(repoRoot, memoryFiles, options = {}) {
  const files = loadMemoryFiles(repoRoot, memoryFiles, options);
  if (!files.length) return { primary: null, all: files, pointers: [], separate: [], hash: null };
  const [primary, ...others] = files;
  const pointers = others.filter(
    (f) =>
      path.basename(f.absolute).toLowerCase() === "claude.md" &&
      isPointerTo(f.text, primary.absolute, { fromDir: path.dirname(f.absolute) }),
  );
  const separate = others.filter((f) => !pointers.includes(f));
  return { primary, all: files, pointers, separate, hash: memorySetHash(files) };
}
