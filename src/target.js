import fs from "node:fs";
import path from "node:path";

import { userClaudeSkillsDir } from "./config.js";
import { UserError, info } from "./logger.js";
import { pointerImportPath, resolveMemoryFiles } from "./memory.js";
import { pathInRoot, resolveInRoot } from "./scope.js";
import { loadProjectSkills, resolveOverflowTarget } from "./skills.js";
import { State, targetStateDir } from "./state.js";
import { skillStagingRefusal } from "./workspace.js";

/**
 * `--target`: one memory file or one skill instead of the whole surface.
 *
 *   surface  the default: the primary memory file plus every skill
 *   memory   that memory file only; a NEW skill may still be extracted from it, and
 *            existing skills are read-only
 *   skill    that SKILL.md only; the memory file and every other skill are read-only
 *
 * Resolution is an exact match against the scope's configured memory-file entries
 * (after the same path normalization the scope applies) or a loaded skill's `name`.
 * Nothing else resolves: no basename, directory, glob, or arbitrary existing file.
 * A spec that matches nothing, or more than one thing, is an error that lists the
 * valid names. The target is a write surface, not a second scope: a skill target, or a
 * memory target naming the default file, keeps the surface's analysis, evidence, and
 * state, and only staging and the proposal gate narrow. A memory target naming another
 * root file trains a different weight, so it keeps its own state (`surfaceState`).
 */

export const SURFACE_TARGET = Object.freeze({ kind: "surface" });

/** Subcommands a targeted run makes sense for. `apply` checks it against the saved proposal. */
export const TARGET_COMMANDS = new Set(["run", "analyze", "propose", "apply"]);

export function resolveTarget(spec, scope) {
  if (spec === undefined) return SURFACE_TARGET;
  const user = scope.kind === "user";
  const root = scope.root;
  const resolvedMemory = resolveMemoryFiles(root, scope.memoryFiles, { allowExternal: user });
  const overflow = resolveOverflowTarget(root, scope.overflowDir, {
    claudeSkillsDir: user ? userClaudeSkillsDir() : undefined,
    allowExternal: user,
  });
  const skills = loadProjectSkills(root, overflow.dir, scope.skillDirs, { exact: user });
  const normalized = pathInRoot(spec, root);
  const memoryMatches = scope.memoryFiles.filter((entry) => pathInRoot(entry, root) === normalized);
  const skillMatches = skills.filter((skill) => skill.name === spec);

  const found = memoryMatches.length + skillMatches.length;
  if (found > 1) {
    const names = [...memoryMatches, ...skillMatches.map((skill) => skill.path)];
    throw new UserError(
      `--target "${spec}" is ambiguous: it names ${names.join(" and ")}`,
      "those may be one file under several links, or genuinely different files; --target needs a name that identifies exactly one file",
    );
  }
  if (memoryMatches.length) {
    const entry = memoryMatches[0];
    if (!fs.existsSync(resolveInRoot(root, entry))) {
      throw new UserError(`--target ${entry} is configured but does not exist`, "a targeted run never creates it");
    }
    const selected = resolvedMemory.all.find((file) => file.path === entry);
    const imported = selected ? pointerImportPath(selected.text, { fromDir: path.dirname(selected.absolute) }) : null;
    if (imported) {
      const importedPath = pathInRoot(imported, root);
      throw new UserError(
        `--target ${entry} is only a pointer to ${importedPath} and cannot be trained directly`,
        `target ${importedPath} instead`,
      );
    }
    return { kind: "memory", path: entry };
  }
  if (skillMatches.length) {
    const skill = skillMatches[0];
    // A targeted run writes exactly one file, and staging is what decides whether that
    // file can be in the copy at all. Ask it here so the refusal names its own cause.
    const refusal = skillStagingRefusal(root, skill.path, {
      allowExternal: user,
      searchPathRoots: scope.skillSearchPaths || [],
      skillsDir: scope.overflowDir,
    });
    if (refusal) {
      throw new UserError(
        `--target ${spec} is at ${skill.path}, which ${refusal}`,
        "backpass loads and bills that skill but cannot write it there; edit it where it really lives, or point the link at a copy backpass can write",
      );
    }
    return { kind: "skill", path: skill.path, name: skill.name };
  }
  if ((scope.nestedMemoryFiles || []).includes(normalized)) {
    throw new UserError(
      `--target ${spec} is a nested memory file, which a run over the whole surface trains`,
      "run backpass without --target: each nested memory file learns from the sessions that worked under its directory",
    );
  }
  const memoryList = scope.memoryFiles.length ? scope.memoryFiles.join(", ") : "(none configured)";
  const skillList = skills.length ? skills.map((skill) => skill.name).join(", ") : "(none)";
  throw new UserError(
    `--target "${spec}" is not a configured memory file or a loaded skill in this ${user ? "user scope" : "repo"}`,
    `memory files: ${memoryList} · skills: ${skillList}`,
  );
}

export function describeTarget(target) {
  if (!target || target.kind === "surface") return "the whole surface";
  return target.kind === "skill" ? `skill ${target.name} (${target.path})` : target.path;
}

export function printTargetNote(target) {
  if (!target || target.kind === "surface") return;
  const rest = target.kind === "skill" ? "the memory file and other skills" : "existing skills";
  info(`targeting ${describeTarget(target)}; ${rest} are read-only this run`);
}

/**
 * The state a run keeps its per-surface files in: the scope root when the run trains the
 * file a default run would, otherwise that file's own `targets/` directory, sharing the
 * scope-level files (`src/state.js`). Without this, two root files trained in turn with
 * `--memory-file` or `--target` overwrite each other's evidence and proposal, and every
 * switch re-analyzes every transcript. Keyed on the resolved primary path, so a run named
 * by `--memory-file X` and one named by `--target X` share one directory.
 *
 * @param {State} rootState the scope's state, already ensured
 * @param {{ root: string, user: boolean, memoryFiles: string[], defaultMemoryFiles: string[] }} run
 */
export function surfaceState(rootState, { root, user, memoryFiles, defaultMemoryFiles }) {
  const trained = trainedMemoryPath(root, memoryFiles, user);
  if (!trained || trained === trainedMemoryPath(root, defaultMemoryFiles, user)) return rootState;
  return new State(root, {
    stateDir: targetStateDir(rootState, trained),
    mode: rootState.dirMode,
    exclude: false,
    shared: rootState,
    surface: trained,
  }).ensure();
}

/** The root file a run with these entries trains: the first that exists, else the first named. */
function trainedMemoryPath(root, files, user) {
  if (!files?.length) return null;
  try {
    const primary = resolveMemoryFiles(root, files, { allowExternal: user }).primary;
    if (primary) return pathInRoot(primary.path, root);
  } catch {
    // An unresolvable entry is named by the command that reads it, not here.
  }
  return pathInRoot(files[0], root);
}

/** The `backpass` command (`subcommand` empty for a full run) that reads and writes the state in `state`. */
export function stateCommand(subcommand, state, scope) {
  const command = subcommand ? `backpass ${subcommand}` : "backpass";
  if (!state?.surface) return command;
  return `${command}${scope?.kind === "user" ? " --scope user" : ""} --memory-file ${shellQuote(state.surface)}`;
}

/** One POSIX shell word for `value`: bare when it is plainly safe, else single-quoted. */
function shellQuote(value) {
  return /^[\w./@%+=:,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** The apply command that reads the proposal kept in `state`. */
export function applyCommand(state, scope) {
  return stateCommand("apply", state, scope);
}
