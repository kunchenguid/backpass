import fs from 'node:fs';
import path from 'node:path';

import { sha256 } from './state.js';
import { estimateTokens } from './tokens.js';

/**
 * Memory files are the weights. To talk about them precisely, backpass parses each
 * file into addressable instruction units (design section 3.1):
 *
 *   - sections come from markdown headings
 *   - units come from list items and paragraphs inside those sections
 *   - each unit gets a content hash (survives cosmetic edits elsewhere in the file)
 *     and a readable alias AG-001, AG-002, ... used in prompts and evidence
 *
 * Evidence anchors to the alias; the hash is what lets us re-anchor across runs.
 */

const FENCE = /^\s*(```|~~~)/;

function normalizeForHash(text) {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function unitHash(text) {
  return sha256(normalizeForHash(text)).slice(0, 12);
}

function alias(index) {
  return `AG-${String(index + 1).padStart(3, '0')}`;
}

/**
 * Split memory-file text into instruction units. Fenced code blocks stay attached to
 * the paragraph they belong to rather than being split into nonsense lines.
 */
export function parseMemoryUnits(text) {
  const lines = text.split('\n');
  const units = [];
  const headings = [];

  let buffer = [];
  let bufferStart = 0;
  let inFence = false;
  let fenceMarker = null;

  const flush = (endLine) => {
    const raw = buffer.join('\n');
    if (raw.trim()) {
      units.push({
        text: raw.replace(/\s+$/, ''),
        section: headings.join(' > '),
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
      for (let d = 0; d < depth - 1; d += 1) headings[d] = headings[d] ?? '';
      continue;
    }

    const isListItem = /^\s*([-*+]|\d+[.)])\s+/.test(line);
    const isBlank = line.trim() === '';

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

  return units.map((unit, index) => ({
    id: alias(index),
    hash: unitHash(unit.text),
    tokens: estimateTokens(unit.text),
    ...unit,
  }));
}

export function readMemoryFile(repoRoot, relativePath) {
  const absolute = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolute)) return null;
  const text = fs.readFileSync(absolute, 'utf8');
  return {
    path: relativePath,
    absolute,
    text,
    hash: `sha256:${sha256(text).slice(0, 16)}`,
    tokens: estimateTokens(text),
    units: parseMemoryUnits(text),
  };
}

/** Load every configured memory file that actually exists in the repo. */
export function loadMemoryFiles(repoRoot, memoryFiles) {
  return memoryFiles.map((f) => readMemoryFile(repoRoot, f)).filter(Boolean);
}

/** Combined hash across all memory files - the "weights version" evidence is keyed to. */
export function memorySetHash(files) {
  return `sha256:${sha256(files.map((f) => `${f.path}:${f.hash}`).join('|')).slice(0, 16)}`;
}

/** Render the instruction index that both prompt tiers see. */
export function renderInstructionIndex(file) {
  return file.units
    .map((u) => `[${u.id}] (${u.tokens} tok)${u.section ? ` <${u.section}>` : ''}\n${u.text}`)
    .join('\n\n');
}

function bigrams(text) {
  const words = normalizeForHash(text).split(' ').filter(Boolean);
  if (words.length < 2) return new Set(words);
  const out = new Set();
  for (let i = 0; i < words.length - 1; i += 1) out.add(`${words[i]} ${words[i + 1]}`);
  return out;
}

/** Sorensen-Dice similarity over word bigrams, used for re-anchoring. */
export function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return A.size === B.size ? 1 : 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared += 1;
  return (2 * shared) / (A.size + B.size);
}

/**
 * Re-anchor an instruction reference from a previous run onto the current file.
 * Exact hash match wins; otherwise the best fuzzy match above threshold; otherwise stale.
 */
export function reanchor(reference, file, threshold = 0.6) {
  if (reference.hash) {
    const exact = file.units.find((u) => u.hash === reference.hash);
    if (exact) return { unit: exact, match: 'hash', score: 1 };
  }
  if (reference.id) {
    const byId = file.units.find((u) => u.id === reference.id);
    if (byId && (!reference.text || similarity(byId.text, reference.text) >= threshold)) {
      return { unit: byId, match: 'id', score: 1 };
    }
  }
  if (!reference.text) return { unit: null, match: 'stale', score: 0 };

  let best = null;
  let bestScore = 0;
  for (const unit of file.units) {
    const score = similarity(unit.text, reference.text);
    if (score > bestScore) {
      best = unit;
      bestScore = score;
    }
  }
  if (best && bestScore >= threshold) return { unit: best, match: 'fuzzy', score: bestScore };
  return { unit: null, match: 'stale', score: bestScore };
}
