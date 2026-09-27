import fs from "node:fs";
import path from "node:path";

import { readTranscript } from "./discovery/index.js";
import { UserError, warn } from "./logger.js";
import {
  memorySetHash,
  memorySurfaceHash,
  pointerImportPath,
  resolveMemoryFiles,
  resolveMemoryPath,
  separateFileWarning,
} from "./memory.js";
import { pathInRoot } from "./scope.js";
import { State, safeFileName, sha256 } from "./state.js";
import { budgetStatus } from "./tokens.js";
import { transcriptIdentity } from "./transcript.js";

/**
 * Nested memory files: a monorepo's per-directory weights.
 *
 * Memory in a monorepo is layered. The root file loads in every session, and a file such
 * as `apps/api/AGENTS.md` loads on top of it only when a session works under `apps/api/`.
 * A surface run trains every file named in `nestedMemoryFiles` as a weight of its own -
 * nothing is ever discovered, so what a run writes is always a file a human named:
 *
 *   evidence   only the sessions that worked under the file's directory, judged against
 *              that file with the root file shown as already loaded
 *   routing    a new instruction belongs to the most specific named file whose directory
 *              every session behind it worked in (`owningFile`); evidence that spans
 *              unrelated directories, or any session that cannot be placed, stays with
 *              the root file
 *   budget     each nested file has its own, `nestedBudgetTokens` (`budgetTokens` when unset)
 *   state      its own `.backpass/nested/<file>/` - evidence, gap ledger, prompts, staging -
 *              sharing only the rejections a human recorded at apply
 *
 * Where a session worked is deterministic: the paths its tool calls name in structured
 * fields (and the file headers of an apply_patch body), resolved against the checkouts
 * of this repository that discovery already knows. Paths outside known checkouts are
 * ignored: only in-repo paths define directory scope. Without paths, its cwd is used.
 * Nothing is read out of shell command text. A session that ran on another machine,
 * or whose paths resolve to no known checkout, worked nowhere in particular and feeds
 * only the root file: a wrong attribution is worse evidence than none.
 *
 * With `nestedMemoryFiles` unset nothing here runs, and a run is exactly the
 * single-primary run it always was.
 */

export const ATTRIBUTION_VERSION = 2;

/** Tool-input fields that name a file or directory a session worked in. */
const PATH_FIELDS = ["file_path", "filePath", "notebook_path", "path"];
/** File headers of the apply_patch grammar (Codex); each names one file the patch touches. */
const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

/** A nested file's always-loaded budget. */
export function nestedBudget(config) {
  return config.nestedBudgetTokens ?? config.budgetTokens;
}

/**
 * Normalize `nestedMemoryFiles` against the repository, once, before the scope is built.
 * Each entry becomes a repo-relative path in a subdirectory, one per directory. An entry
 * also listed in `memoryFiles` is a nested weight and leaves the root list, so it is never
 * mistaken for a separate root file that ought to be consolidated.
 */
export function applyNestedMemoryConfig(repoRoot, config) {
  const entries = config.nestedMemoryFiles || [];
  if (!entries.length) return config;
  const byDir = new Map();
  for (const entry of entries) {
    const relative = pathInRoot(entry, repoRoot);
    if (path.isAbsolute(relative)) {
      throw new UserError(`nestedMemoryFiles entry ${entry} is outside the repository`);
    }
    resolveMemoryPath(repoRoot, relative);
    const dir = path.posix.dirname(relative);
    if (dir === ".") {
      throw new UserError(
        `nestedMemoryFiles entry ${entry} is at the repository root`,
        "the root memory file belongs in memoryFiles; nestedMemoryFiles names files in subdirectories",
      );
    }
    if (byDir.has(dir)) {
      throw new UserError(
        `nestedMemoryFiles names ${byDir.get(dir)} and ${relative}, two memory files in ${dir}/`,
        "name one memory file per directory; the other can be a pointer to it",
      );
    }
    byDir.set(dir, relative);
  }
  const nested = [...byDir.values()];
  const rootFiles = config.memoryFiles.filter((entry) => !nested.includes(pathInRoot(entry, repoRoot)));
  if (!rootFiles.length) {
    throw new UserError(
      "every memoryFiles entry is also listed in nestedMemoryFiles",
      "memoryFiles names the root memory file; nestedMemoryFiles names the files below it",
    );
  }
  config.memoryFiles = rootFiles;
  config.nestedMemoryFiles = nested;
  return config;
}

/**
 * Load each configured nested file with the same pointer model the root pair uses, per
 * directory: the named file is that directory's primary, a sibling `CLAUDE.md` that only
 * imports it is fine, and a sibling with content of its own is reported as separate.
 * Pure - `reportNestedMemoryFiles` turns the result into warnings and refusals.
 *
 * @returns {{ path: string, dir: string, file: object | null, pointerTo: string | null, separate: object[] }[]}
 */
export function resolveNestedMemoryFiles(repoRoot, config) {
  const rootNames = [
    ...new Set([
      ...config.memoryFiles.map((entry) => path.posix.basename(pathInRoot(entry, repoRoot))),
      "AGENTS.md",
      "CLAUDE.md",
    ]),
  ];
  return (config.nestedMemoryFiles || []).map((relative) => {
    const dir = path.posix.dirname(relative);
    const siblings = rootNames.map((name) => path.posix.join(dir, name)).filter((sibling) => sibling !== relative);
    const resolved = resolveMemoryFiles(repoRoot, [relative, ...siblings]);
    const file = resolved.all.find((candidate) => candidate.path === relative) || null;
    if (!file) return { path: relative, dir, file: null, pointerTo: null, separate: [] };
    const imported = pointerImportPath(file.text, { fromDir: path.dirname(file.absolute) });
    return {
      path: relative,
      dir,
      file,
      pointerTo: imported ? pathInRoot(imported, repoRoot) : null,
      separate: resolved.separate,
    };
  });
}

/** Warn about what a run will not train, and refuse a nested entry that is only a pointer. */
export function reportNestedMemoryFiles(weights) {
  for (const weight of weights) {
    if (weight.pointerTo) {
      throw new UserError(
        `nestedMemoryFiles entry ${weight.path} is only a pointer to ${weight.pointerTo} and cannot be trained directly`,
        `name ${weight.pointerTo} in nestedMemoryFiles instead`,
      );
    }
    if (!weight.file) {
      warn(`nested memory file ${weight.path} does not exist, so it is not trained; backpass never creates one`);
      continue;
    }
    for (const other of weight.separate) warn(separateFileWarning(other, weight.file));
  }
  return weights.filter((weight) => weight.file);
}

/**
 * The hash a nested file's evidence is keyed to. The analysis prompt shows the root file
 * as already loaded, and the skills, so a change to either re-judges the nested evidence.
 */
export function nestedSurfaceHash(rootFile, file, skills) {
  return memorySurfaceHash(memorySetHash([rootFile, file]), skills);
}

export function nestedStateDir(rootState, weightPath) {
  return path.join(rootState.root, "nested", `${safeFileName(weightPath)}-${sha256(weightPath).slice(0, 8)}`);
}

/**
 * The run context one nested file is trained in: its own state, its own budget, and a
 * memory target on that one file. Rejections stay shared, because apply records them
 * once over the whole proposal.
 */
export function nestedContext(ctx, weight) {
  const rootState = ctx.config.state;
  const state = new State(ctx.repo.root, {
    stateDir: nestedStateDir(rootState, weight.path),
    mode: rootState.dirMode,
    exclude: false,
  }).ensure();
  state.rejectionsPath = rootState.rejectionsPath;
  return {
    ...ctx,
    config: {
      ...ctx.config,
      state,
      memoryFiles: [weight.path],
      budgetTokens: nestedBudget(ctx.config),
      target: { kind: "memory", path: weight.path, nested: true },
    },
  };
}

/** The root text as the nested analysis prompt shows it: loaded, but not under audit. */
export function renderAlsoLoaded(rootFile, weight) {
  return (
    `\n\n## Also loaded in this session - not under audit\n\n` +
    `${weight.path} is a nested memory file: harnesses load it on top of the root memory file ` +
    `below, and only when a session works under ${weight.dir}/. The root file is audited in its own ` +
    `pass, so never attribute evidence to it, and a mistake it already covers is not a gap here.\n\n` +
    `### Root memory file: ${rootFile.path}\n\n${rootFile.text.trim()}`
  );
}

function realpathDeepest(p) {
  const absolute = path.resolve(p);
  let existing = absolute;
  const tail = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return absolute;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(fs.realpathSync(existing), ...tail);
  } catch {
    return absolute;
  }
}

/** Every checkout of this repository discovery knows, deepest first. */
export function checkoutRoots(repo) {
  const roots = [repo.realRoot, ...(repo.worktrees || []), ...(repo.siblingWorktrees || [])].filter(Boolean);
  return [...new Set(roots.map(realpathDeepest))].sort((a, b) => b.length - a.length);
}

/** Only in-repo work paths count toward directory attribution. */
export function projectWorkPath(absolute, roots) {
  const real = realpathDeepest(absolute);
  for (const root of roots) {
    const relative = path.relative(root, real);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    return relative.split(path.sep).join("/");
  }
  return null;
}

/** The paths a session's tool calls name, as recorded. */
export function toolPaths(events) {
  const out = [];
  const patchFiles = (text, workdir) => {
    if (!text.includes("*** Begin Patch")) return;
    for (const match of text.matchAll(PATCH_FILE)) out.push({ raw: match[1].trim(), workdir });
  };
  for (const event of events || []) {
    if (event?.kind !== "tool") continue;
    const input = event.input;
    if (typeof input === "string") {
      patchFiles(input, null);
      continue;
    }
    if (!input || typeof input !== "object") continue;
    const workdir =
      [input.workdir, input.cwd].find((value) => typeof value === "string" && value.trim())?.trim() || null;
    for (const key of PATH_FIELDS) {
      if (typeof input[key] === "string" && input[key].trim()) out.push({ raw: input[key].trim(), workdir });
    }
    for (const value of Object.values(input)) if (typeof value === "string") patchFiles(value, workdir);
  }
  return out;
}

/**
 * Where one session worked, as sorted repo-relative paths from tool calls, falling back
 * to its cwd when no tool paths are recorded. Paths outside known checkouts are dropped.
 */
export function workedPaths(transcript, events, roots) {
  const cwd = transcript.cwd || null;
  const out = new Set();
  const named = toolPaths(events);
  if (!named.length && cwd) named.push({ raw: cwd, workdir: null });
  for (const { raw, workdir } of named) {
    if (raw.startsWith("~") || workdir?.startsWith("~")) continue;
    const base = workdir ? path.resolve(cwd || "", workdir) : cwd;
    if (!path.isAbsolute(raw) && !base) continue;
    const relative = projectWorkPath(path.resolve(base || "", raw), roots);
    if (relative !== null) out.add(relative);
  }
  return [...out].sort();
}

/**
 * Where each transcript worked, keyed by transcript identity: sorted repo-relative paths,
 * or null for a session that cannot be placed (collected over ssh, or unreadable).
 * Cached by content signature in `.backpass/nested/attribution.json`, so a run reads a
 * transcript for this only once.
 *
 * @returns {Promise<Map<string, string[] | null>>}
 */
export async function attributeTranscripts(transcripts, repo, state) {
  const roots = checkoutRoots(repo);
  const cachePath = path.join(state.root, "nested", "attribution.json");
  const cache = state.readJsonFile(cachePath, null);
  const prior =
    cache?.version === ATTRIBUTION_VERSION &&
    cache.roots?.length === roots.length &&
    cache.roots.every((root, index) => root === roots[index]) &&
    cache.entries
      ? cache.entries
      : {};
  const entries = {};
  const attribution = new Map();
  for (const transcript of transcripts) {
    const identity = transcriptIdentity(transcript);
    if (transcript.host) {
      attribution.set(identity, null);
      continue;
    }
    const content = transcript.contentSignature || `${transcript.mtimeMs}:${transcript.bytes}`;
    let paths = prior[identity]?.content === content ? prior[identity].paths : null;
    if (!paths) {
      try {
        paths = workedPaths(transcript, (await readTranscript(transcript)).events, roots);
      } catch {
        paths = null;
      }
    }
    if (paths) entries[identity] = { content, paths };
    attribution.set(identity, paths);
  }
  state.writeJsonFile(cachePath, { version: ATTRIBUTION_VERSION, roots, entries });
  return attribution;
}

function isWithin(relative, dir) {
  return relative === dir || relative.startsWith(`${dir}/`);
}

export function workedUnder(paths, dir) {
  return Array.isArray(paths) && paths.length > 0 && paths.every((relative) => isWithin(relative, dir));
}

export function rootOwnsGap(items, rootOwnedGaps = []) {
  return (
    items.length > 0 &&
    rootOwnedGaps.some((sightings) =>
      items.every((item) =>
        sightings.some((sighting) => sighting.sessionId === item.sessionId && sighting.quote === item.quote),
      ),
    )
  );
}

/**
 * The nested file that owns evidence from these sessions, or null for the root file.
 *
 * A file qualifies when every session worked under its directory. The qualifying files
 * must form one chain of nested directories, and the deepest one owns the evidence; two
 * unrelated directories mean the lesson is cross-cutting, and so does a session with no
 * attribution at all. Both land in the root file, the always-loaded default.
 */
export function owningFile(sessionIds, weights, attribution) {
  if (!sessionIds.length) return null;
  const qualifying = weights
    .filter((weight) => sessionIds.every((id) => workedUnder(attribution.get(id), weight.dir)))
    .sort((a, b) => a.dir.length - b.dir.length);
  if (!qualifying.length) return null;
  for (let i = 1; i < qualifying.length; i += 1) {
    if (!isWithin(qualifying[i].dir, qualifying[i - 1].dir)) return null;
  }
  return qualifying.at(-1).path;
}

/**
 * One proposal over every trained file, reviewed in one apply: the root proposal, then
 * each nested file's edits renumbered after it and labeled with their file. A nested
 * file's image joins `targetFiles`, so apply refuses it if it changed since, the same
 * freshness contract every non-root target has; `nested` carries each file's own budget,
 * which apply re-checks against the accepted subset.
 */
export function mergeNestedProposals(root, passes) {
  const edits = [...root.edits];
  const targetFiles = [...(root.targetFiles || [])];
  const usage = [...(root.usage || [])];
  const notes = [...(root.notes || [])];
  const nested = passes.map((pass) => {
    const { weight, proposal } = pass;
    const ids = [];
    for (const edit of proposal?.edits || []) {
      const id = `e${edits.length + 1}`;
      edits.push({ ...edit, id, targetsMemoryFile: false, nestedMemoryFile: weight.path });
      ids.push(id);
    }
    if (ids.length) targetFiles.push({ file: weight.path, hash: weight.file.hash });
    if (proposal) {
      usage.push(...(proposal.usage || []));
      notes.push(...(proposal.notes || []).map((note) => `${weight.path}: ${note}`));
    }
    const consolidation = pass.summary?.consolidation?.usage;
    if (consolidation) usage.push(consolidation);
    return {
      memoryFile: { path: weight.path, hash: weight.file.hash, tokens: weight.file.tokens },
      dir: weight.dir,
      sessions: pass.transcripts.length,
      budget: proposal?.budget ?? budgetStatus(weight.file.text, null, pass.cap),
      maxEdits: proposal?.config?.maxEditsPerRun ?? null,
      edits: ids,
      ...(pass.skipped ? { skipped: pass.skipped } : {}),
    };
  });
  return { ...root, edits, targetFiles, usage, notes, nested };
}

/**
 * The routing one pass folds and gates with. `weight` is the nested file this pass
 * trains, or null for the root file.
 *
 * @param {{ path: string, dir: string }[]} weights
 * @param {Map<string, string[] | null>} attribution
 * @param {string} rootPath
 * @param {string | null} weight
 */
export function routingFor(weights, attribution, rootPath, weight) {
  return {
    weight,
    rootPath,
    ownerOf: (sessionIds) => owningFile(sessionIds, weights, attribution),
  };
}
