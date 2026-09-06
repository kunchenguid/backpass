import fs from "node:fs";
import path from "node:path";

import { userClaudeSkillsDir } from "./config.js";
import { UserError, info } from "./logger.js";
import { pointerImportPath, readOnlyResolvedPath, resolveMemoryFiles, resolveMemoryPath } from "./memory.js";
import { pathInRoot, resolveInRoot } from "./scope.js";
import { loadProjectSkills, resolveOverflowTarget } from "./skills.js";

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
 * valid names. The target is a write surface, not a second scope: analysis, evidence,
 * and state are unchanged, only staging and the proposal gate narrow.
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
  // Several links to one library are several names for one file, and staging already
  // resolves that layout by giving the first name the write. Only distinct files sharing
  // a name are genuinely ambiguous - there, renaming really is the fix.
  const aliased = skillMatches.length > 1 && sameFile(root, skillMatches);
  const selected = aliased ? [skillMatches[0]] : skillMatches;

  const found = memoryMatches.length + selected.length;
  if (found > 1) {
    const names = [...memoryMatches, ...skillMatches.map((skill) => skill.path)];
    throw new UserError(
      `--target "${spec}" is ambiguous: it names ${names.join(" and ")}`,
      "rename the skill so one name means one file",
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
  if (selected.length) {
    const skill = selected[0];
    // The same path gate apply applies: a skill reached through a symlink out of the repo
    // is loaded and billed, but project scope can never write it - say so here rather than
    // staging nothing and failing the synthesis turn with an unrelated hint.
    try {
      resolveMemoryPath(root, skill.path, { allowExternal: user });
    } catch {
      throw new UserError(
        `--target ${spec} is at ${skill.path}, which resolves outside the repository`,
        "project scope can read and bill that skill but never write it; edit it where it really lives, or run `--scope user`",
      );
    }
    // The same probe staging and apply use: a skill that resolves into a store nothing may
    // write is loaded and billed, but a run targeting it could only end in a refusal.
    const unwritable = readOnlyResolvedPath(resolveInRoot(root, skill.path));
    if (unwritable) {
      throw new UserError(
        `--target ${spec} is at ${skill.path}, which resolves to ${unwritable} and cannot be written`,
        "edit the source that generates it, or point the link at a writable copy",
      );
    }
    if (aliased) {
      info(`${spec} is one file under ${skillMatches.length} links; targeting it as ${skill.path}`);
    }
    return { kind: "skill", path: skill.path, name: skill.name };
  }
  const memoryList = scope.memoryFiles.length ? scope.memoryFiles.join(", ") : "(none configured)";
  const skillList = skills.length ? skills.map((skill) => skill.name).join(", ") : "(none)";
  throw new UserError(
    `--target "${spec}" is not a configured memory file or a loaded skill in this ${user ? "user scope" : "repo"}`,
    `memory files: ${memoryList} · skills: ${skillList}`,
  );
}

/** True when every match is the same file on disk, reached under different names. */
function sameFile(root, matches) {
  const identity = (skill) => {
    try {
      return fs.realpathSync(resolveInRoot(root, skill.path));
    } catch {
      return null;
    }
  };
  const first = identity(matches[0]);
  return first !== null && matches.every((skill) => identity(skill) === first);
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
