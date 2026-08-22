import path from "node:path";

import { parseMemoryUnits } from "./memory.js";
import { sha256 } from "./state.js";
import { estimateTokens } from "./tokens.js";

/**
 * The starter memory file backpass seeds when a repo has none.
 *
 * Bootstrap = a minimal skeleton + the normal backward pass. The skeleton is deliberately
 * tiny (purpose, an empty `## Learnings` section, a self-governance section): every
 * starter line is paid on every session, so nothing generic is pre-filled. What the
 * repo's own transcripts teach is layered on top by the same analyze -> fold ->
 * synthesize pipeline a normal run uses, with this text standing in as the "current
 * weights"; evidence-backed entries land under `## Learnings`.
 *
 * The canonical file is AGENTS.md; CLAUDE.md is the `@AGENTS.md` pointer so both harness
 * families read one source of truth. Writing happens in `src/apply/writer.js`.
 */

export const CANONICAL_MEMORY_FILE = "AGENTS.md";
export const POINTER_MEMORY_FILE = "CLAUDE.md";

/** The convention's two-line pointer form; `isPointerTo` recognizes it round-trip. */
export function renderPointer(target = CANONICAL_MEMORY_FILE) {
  return `<!-- Points Claude at ${target} via import; edit ${target}, not this file. -->\n@${target}\n`;
}

/**
 * What a bootstrap creates for a config: the canonical file is the first configured
 * memory file (a user override still wins), and CLAUDE.md becomes a pointer to it unless
 * CLAUDE.md itself is the canonical file.
 */
export function bootstrapTargets(memoryFiles) {
  const canonical = memoryFiles[0] || CANONICAL_MEMORY_FILE;
  const pointer =
    path.basename(canonical) === POINTER_MEMORY_FILE && path.dirname(canonical) === "." ? null : POINTER_MEMORY_FILE;
  return { canonical, pointer };
}

export const MAINTAINING_SECTION = `## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
`;

/** Render the default AGENTS.md for a repo. Deterministic for a given checkout. */
export function renderStarterMemory({ repo }) {
  return `# Project agent memory

${repo.name}: this file is the always-loaded memory for agents working in this repo.
It is kept short on purpose - every line here is paid on every session.

## Learnings

- None recorded yet. backpass adds evidence-backed entries here from real sessions.

${MAINTAINING_SECTION}`;
}

/** An in-memory memory file object in the shape `readMemoryFile` returns, never on disk. */
export function starterMemoryFile(repo, relativePath = CANONICAL_MEMORY_FILE) {
  const text = renderStarterMemory({ repo });
  return {
    path: relativePath,
    absolute: path.join(repo.root, relativePath),
    text,
    hash: `sha256:${sha256(text).slice(0, 16)}`,
    tokens: estimateTokens(text),
    units: parseMemoryUnits(text),
  };
}
