import fs from "node:fs";
import path from "node:path";

import { parseMemoryUnits } from "./memory.js";
import { sha256 } from "./state.js";
import { estimateTokens } from "./tokens.js";

/**
 * The starter memory file backpass seeds when a repo has none.
 *
 * Bootstrap = sensible defaults + the normal backward pass. The defaults here are the
 * skeleton every good memory file shares (purpose, orientation, conventions, a
 * self-governance section); what the repo's own transcripts teach is layered on top by
 * the same analyze -> fold -> synthesize pipeline a normal run uses, with this text
 * standing in as the "current weights". Whatever is deterministically detectable from
 * the checkout (package manager, check commands) is filled in; nothing is guessed.
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

const LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
];

const SCRIPT_LABELS = [
  ["check", "the full local gate"],
  ["test", "tests"],
  ["lint", "lint"],
  ["typecheck", "type checks"],
  ["build", "the build"],
  ["format:check", "formatting"],
];

/** What the checkout itself says, without reading transcripts or calling a model. */
export function detectRepoFacts(root) {
  const facts = { packageManager: null, scripts: [], readme: null };
  const exists = (name) => fs.existsSync(path.join(root, name));

  for (const [file, manager] of LOCKFILES) {
    if (exists(file)) {
      facts.packageManager = manager;
      break;
    }
  }

  const pkgPath = path.join(root, "package.json");
  if (exists("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (!facts.packageManager && pkg.packageManager) {
        facts.packageManager = String(pkg.packageManager).split("@")[0];
      }
      const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
      for (const [name, label] of SCRIPT_LABELS) {
        if (typeof scripts[name] === "string") facts.scripts.push({ name, label });
      }
      if (!facts.packageManager) facts.packageManager = "npm";
    } catch {
      // An unparseable package.json is not a bootstrap problem; the defaults stay generic.
    }
  }

  for (const name of ["README.md", "README", "readme.md"]) {
    if (exists(name)) {
      facts.readme = name;
      break;
    }
  }
  return facts;
}

function runCommand(manager, script) {
  if (!manager || manager === "npm") return `npm run ${script}`;
  return `${manager} run ${script}`;
}

/** Render the default AGENTS.md for a repo. Deterministic for a given checkout. */
export function renderStarterMemory({ repo, facts = detectRepoFacts(repo.root) }) {
  if (!facts) facts = detectRepoFacts(repo.root);
  const orientation = [];
  if (facts.readme) orientation.push(`- \`${facts.readme}\` documents the user-facing surface; start there.`);
  if (facts.packageManager) {
    orientation.push(`- ${facts.packageManager} is the package manager; do not switch it or add a second lockfile.`);
  }
  if (facts.scripts.length) {
    const gate = facts.scripts.find((s) => s.name === "check") || facts.scripts[0];
    const others = facts.scripts
      .filter((s) => s !== gate)
      .map((s) => `\`${runCommand(facts.packageManager, s.name)}\` (${s.label})`)
      .join(", ");
    orientation.push(
      `- \`${runCommand(facts.packageManager, gate.name)}\` runs ${gate.label}${others ? `; also ${others}` : ""}. ` +
        "Run it before declaring work done.",
    );
  }
  if (!orientation.length) {
    orientation.push("- Read the top-level README and directory layout before changing anything.");
  }

  return `# Project agent memory

${repo.name}: this file is the always-loaded memory for agents working in this repo.
It is kept short on purpose - every line here is paid on every session.

## Orientation

${orientation.join("\n")}

## Conventions

- Read the surrounding code and follow its existing patterns before adding new ones.
- Reproduce a bug end to end before fixing it, then keep the reproduction as a test.
- Run the project's checks (lint, tests, types) before declaring work done; fix what
  they report even when it is unrelated to the task.
- Never hand-edit generated files (lockfiles, changelogs, build output).
- Keep changes scoped to the task; call out follow-ups instead of silently widening scope.

## Sharp edges

- None recorded yet. backpass adds evidence-backed entries here from real sessions.

${MAINTAINING_SECTION}`;
}

/** An in-memory memory file object in the shape `readMemoryFile` returns, never on disk. */
export function starterMemoryFile(repo, relativePath = CANONICAL_MEMORY_FILE, facts = null) {
  const text = renderStarterMemory({ repo, facts });
  return {
    path: relativePath,
    absolute: path.join(repo.root, relativePath),
    text,
    hash: `sha256:${sha256(text).slice(0, 16)}`,
    tokens: estimateTokens(text),
    units: parseMemoryUnits(text),
  };
}
