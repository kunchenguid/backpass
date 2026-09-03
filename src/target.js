import fs from "node:fs";
import path from "node:path";

import { userClaudeSkillsDir } from "./config.js";
import { UserError, info } from "./logger.js";
import { pointerImportPath, resolveMemoryFiles } from "./memory.js";
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

  const found = memoryMatches.length + skillMatches.length;
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
  if (skillMatches.length) {
    const skill = skillMatches[0];
    return { kind: "skill", path: skill.path, name: skill.name };
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
