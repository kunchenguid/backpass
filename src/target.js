import fs from "node:fs";
import path from "node:path";

import { userClaudeSkillsDir } from "./config.js";
import { UserError, info } from "./logger.js";
import { readMemoryFile, resolveMemoryPath } from "./memory.js";
import { expandUserPath } from "./scope.js";
import { loadProjectSkills, resolveOverflowTarget, resolveProjectSkillDirs } from "./skills.js";

/**
 * A run's write surface. Default is the whole project or user surface (the primary
 * memory file plus every skill). `--target` names one memory file or one skill, and
 * that choice must not silently widen to the rest of the surface.
 *
 *   surface  today's default: primary memory file + all skills
 *   memory   that memory file; new skill extracts allowed; existing skills are not writable
 *   skill    that skill file only; the memory file and every other skill stay out
 */

export const SURFACE_TARGET = { kind: "surface" };

/**
 * Skills and overflow layout for this scope. Synthesis prints overflow-layout
 * warnings; this resolution is read-only.
 */
export function loadScopeSkills(repo, config, scope = null) {
  const userScope = scope?.kind === "user";
  const configuredSkillsDir = scope?.overflowDir ?? config.skillsDir;
  const configuredSkillDirs = scope?.skillDirs ?? config.skillsDirs ?? [];
  const overflow = resolveOverflowTarget(repo.root, configuredSkillsDir, {
    claudeSkillsDir: userScope ? userClaudeSkillsDir() : undefined,
  });
  const skillDirs = resolveProjectSkillDirs(repo.root, overflow.dir, configuredSkillDirs, {
    exact: userScope,
  });
  const skills = loadProjectSkills(repo.root, overflow.dir, configuredSkillDirs, { exact: userScope });
  return { overflow, skillDirs, skills };
}

function posixRel(root, absolute) {
  const rel = path.relative(root, absolute);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return absolute;
  return rel.split(path.sep).join("/");
}

function specPath(spec, root) {
  const expanded = expandUserPath(spec);
  const absolute = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
  return { absolute, relative: posixRel(root, absolute) };
}

function skillFileAt(absolute) {
  if (!fs.existsSync(absolute)) return null;
  const stat = fs.statSync(absolute);
  if (stat.isFile() && path.basename(absolute) === "SKILL.md") return absolute;
  if (stat.isDirectory()) {
    const nested = path.join(absolute, "SKILL.md");
    if (fs.existsSync(nested) && fs.statSync(nested).isFile()) return nested;
  }
  if (stat.isFile() && absolute.endsWith(".md")) return absolute;
  return null;
}

function matchSkill(spec, skills, { root }) {
  const { absolute, relative } = specPath(spec, root);
  const byName = skills.filter((skill) => skill.name === spec);
  const byPath = skills.filter((skill) => {
    if (skill.path === spec || skill.path === relative || skill.path === absolute) return true;
    const skillAbs = path.isAbsolute(skill.path) ? skill.path : path.resolve(root, skill.path);
    return path.resolve(skillAbs) === absolute;
  });

  const unique = [...new Map([...byName, ...byPath].map((skill) => [skill.path, skill])).values()];
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) {
    throw new UserError(
      `--target "${spec}" matches ${unique.length} skills (${unique.map((s) => s.path).join(", ")})`,
      "pass the SKILL.md path to disambiguate",
    );
  }

  const file = skillFileAt(absolute);
  if (!file) return null;
  const logical = posixRel(root, file);
  if (path.basename(file) === "SKILL.md" || /(?:^|\/)skills\/.+\.md$/.test(logical.replaceAll("\\", "/"))) {
    return skills.find((skill) => skill.path === logical) || { name: path.basename(path.dirname(file)), path: logical };
  }
  return null;
}

function looksLikeMemoryFile(spec, root, allowExternal, memoryFiles = []) {
  try {
    const absolute = resolveMemoryPath(root, spec, { allowExternal });
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
      return { absolute, path: posixRel(root, absolute) };
    }
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
  }
  const base = spec.split(/[/\\]/).pop();
  const matches = [];
  for (const candidate of memoryFiles) {
    try {
      const absolute = resolveMemoryPath(root, candidate, { allowExternal });
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
      const logical = posixRel(root, absolute);
      if (candidate === spec || logical === spec || path.basename(absolute) === base) {
        matches.push({ absolute, path: logical });
      }
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
    }
  }
  const unique = [...new Map(matches.map((match) => [match.absolute, match])).values()];
  if (unique.length > 1) {
    throw new UserError(
      `--target "${spec}" matches ${unique.length} memory files (${unique.map((match) => match.path).join(", ")})`,
      "pass the exact memory file path to disambiguate",
    );
  }
  return unique[0] || null;
}

/**
 * Resolve `--target` against this scope's memory files and skills.
 * A missing spec is the whole surface; an explicitly empty spec is invalid.
 *
 * @param {string | null | undefined} spec
 * @param {{ repo: { root: string }, config: object, scope?: object | null, skills?: object[], skillDirs?: string[] }} context
 */
export function resolveRunTarget(spec, { repo, config, scope = null, skills = null, skillDirs = null }) {
  if (spec == null) return { ...SURFACE_TARGET };

  const trimmed = String(spec).trim();
  if (!trimmed) {
    throw new UserError("--target cannot be empty", "name one memory file or skill, or omit --target");
  }

  const loaded = skills && skillDirs ? { skills, skillDirs } : loadScopeSkills(repo, config, scope);
  const allowExternal = scope?.kind === "user";
  const skill = matchSkill(trimmed, loaded.skills, { root: repo.root });
  const memory = looksLikeMemoryFile(trimmed, repo.root, allowExternal, scope?.memoryFiles ?? config.memoryFiles ?? []);

  if (skill && memory && skill.path !== memory.path) {
    throw new UserError(
      `--target "${trimmed}" names both skill ${skill.path} and memory file ${memory.path}`,
      "pass the SKILL.md path, or the memory file path, not a name that matches both",
    );
  }
  if (skill) {
    const file = readMemoryFile(repo.root, skill.path, { allowExternal });
    if (!file) {
      throw new UserError(`skill ${skill.path} is unreadable`, "check the SKILL.md path and retry");
    }
    return {
      kind: "skill",
      spec: trimmed,
      path: file.path,
      name: skill.name,
      skill: { ...skill, path: file.path },
      file,
    };
  }
  if (memory) {
    if (path.basename(memory.path) === "SKILL.md") {
      throw new UserError(
        `${memory.path} is a skill file; a memory-file target cannot write it`,
        `pass --target ${skillHint(memory.path)} to train that skill`,
      );
    }
    return { kind: "memory", spec: trimmed, path: memory.path };
  }

  const listed = loaded.skills.length
    ? `known skills: ${loaded.skills.map((s) => s.name).join(", ")}`
    : "this scope has no skills yet";
  throw new UserError(
    `--target "${trimmed}" is not a memory file or skill in this ${scope?.kind === "user" ? "user scope" : "repo"}`,
    listed,
  );
}

function skillHint(skillPath) {
  const parts = String(skillPath).split("/");
  const named = parts.length >= 2 && parts[parts.length - 1] === "SKILL.md" ? parts[parts.length - 2] : skillPath;
  return named;
}

export function parseTargetFlag(values) {
  const spec = values?.target;
  if (spec == null) return null;
  if (Array.isArray(spec)) {
    if (spec.length > 1) {
      throw new UserError("--target names one memory file or one skill, not several", "run once per file");
    }
    return spec[0];
  }
  return spec;
}

/** Existing skills are writable only on a whole-surface run. */
export function copyExistingSkills(runTarget) {
  return !runTarget || runTarget.kind === "surface";
}

/** Skill-dir mappings that measure created SKILL.md files. Empty for a skill-only run. */
export function workspaceSkillDirs(runTarget, skillDirs) {
  if (runTarget?.kind === "skill") return [];
  return skillDirs;
}

export function printTargetNote(runTarget) {
  if (!runTarget || runTarget.kind === "surface") return;
  if (runTarget.kind === "skill") {
    info(`targeting skill ${runTarget.name} (${runTarget.path}); the memory file and other skills are out of this run`);
    return;
  }
  info(`targeting ${runTarget.path}; existing skills are not writable this run`);
}
