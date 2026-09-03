import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { UserError } from "./logger.js";
import { estimateTokens } from "./tokens.js";

/**
 * Skills as overflow (design section 7).
 *
 * A skill's description IS its when-useful condition: the description is always loaded
 * and cheap, the body is free until the trigger fires. That makes extraction the release
 * valve for the always-loaded budget - a 640-token procedure that matters in 4% of
 * sessions becomes a 35-token description line.
 *
 * The placement rule the synthesis prompt encodes:
 *
 *                    | trigger detectable | trigger not detectable
 *   broad (>=20%)    | memory file        | memory file (must be ambient)
 *   narrow           | SKILL              | deletion candidate
 */

export const BROAD_RELEVANCE_THRESHOLD = 0.2;

function logicalSkillDir(repoRoot, skillsDir) {
  const absolute = path.isAbsolute(skillsDir) ? skillsDir : path.resolve(repoRoot, skillsDir);
  const relative = path.relative(path.resolve(repoRoot), absolute);
  if (relative === "") return ".";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return absolute;
  return relative.split(path.sep).join("/");
}

/** Read the existing skills so synthesis can tune a description instead of duplicating it. */
export function loadSkills(repoRoot, skillsDir) {
  const root = path.isAbsolute(skillsDir) ? skillsDir : path.join(repoRoot, skillsDir);
  if (!fs.existsSync(root)) return [];

  const skills = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    const file = entry.isDirectory()
      ? path.join(root, entry.name, "SKILL.md")
      : entry.name.endsWith(".md")
        ? path.join(root, entry.name)
        : null;
    if (!file || !fs.existsSync(file)) continue;
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const frontmatter = parseFrontmatter(text);
    skills.push({
      name: frontmatter.name || entry.name.replace(/\.md$/, ""),
      description: frontmatter.description || "",
      path: (() => {
        const relative = path.relative(repoRoot, file);
        return relative.startsWith("..") || path.isAbsolute(relative) ? file : relative.split(path.sep).join("/");
      })(),
      body: skillBody(text),
      bodyTokens: estimateTokens(text),
      descriptionTokens: estimateTokens(frontmatter.description || ""),
    });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve supported skill roots without double-counting directories reached by symlink.
 * Project scope includes the conventional roots; exact mode uses only the configured
 * harness roots and overflow target.
 */
export function resolveProjectSkillDirs(
  repoRoot,
  overflowDir = CANONICAL_SKILLS_DIR,
  extraDirs = [],
  { exact = false } = {},
) {
  const dirs = [];
  const seen = new Set();
  const candidates = exact
    ? [overflowDir, ...extraDirs]
    : [overflowDir, CANONICAL_SKILLS_DIR, CLAUDE_SKILLS_LINK, ...extraDirs];
  for (const dir of candidates) {
    if (!dir) continue;
    const absolute = path.isAbsolute(dir) ? dir : path.join(repoRoot, dir);
    const exists = fs.existsSync(absolute);
    if (!exists && dir !== overflowDir) continue;
    let identity = path.resolve(absolute);
    if (exists) {
      try {
        identity = fs.realpathSync(absolute);
      } catch {
        continue;
      }
    }
    if (seen.has(identity)) continue;
    seen.add(identity);
    dirs.push(logicalSkillDir(repoRoot, dir));
  }
  return dirs;
}

/** Load generated and human-authored project skills across every supported root. */
export function loadProjectSkills(repoRoot, overflowDir = CANONICAL_SKILLS_DIR, extraDirs = [], options = {}) {
  return resolveProjectSkillDirs(repoRoot, overflowDir, extraDirs, options)
    .flatMap((dir) => loadSkills(repoRoot, dir))
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

/** The markdown after the frontmatter block - what a harness loads when the trigger fires. */
export function skillBody(text) {
  const end = /^---\n[\s\S]*?\n---\n?/.exec(text);
  return (end ? text.slice(end[0].length) : text).trim();
}

/**
 * The always-loaded token cost of the skill layer: every description line, nothing
 * else. Bodies are free until triggered by design - this sum is what joins the memory
 * file under the one always-loaded budget cap.
 */
export function skillDescriptionTokens(skills) {
  return (skills || []).reduce((sum, s) => sum + (s.descriptionTokens ?? estimateTokens(s.description || "")), 0);
}

/** Minimal YAML frontmatter reader for plain values and `>` / `|` multi-line values. */
export function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return {};
  const result = {};
  let currentKey = null;
  let block = null;

  const finishBlock = () => {
    if (!block) return;
    const lines = block.lines;
    let value;
    if (block.style === "|") {
      value = lines.length ? `${lines.join("\n")}\n` : "";
    } else {
      value = foldBlockLines(lines);
    }
    if (block.chomp === "-") value = value.replace(/\n+$/, "");
    if (block.chomp === "") value = value.replace(/\n*$/, lines.some(Boolean) ? "\n" : "");
    result[block.key] = value;
    block = null;
  };

  for (const line of match[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      finishBlock();
      currentKey = kv[1];
      const rawValue = kv[2].trim();
      const blockIndicator = /^([>|])([+-]?)$/.exec(rawValue);
      if (blockIndicator) {
        result[currentKey] = "";
        block = { key: currentKey, style: blockIndicator[1], chomp: blockIndicator[2], indent: null, lines: [] };
      } else {
        result[currentKey] = rawValue.replace(/^["']|["']$/g, "");
      }
    } else if (block && /^\s*$/.test(line)) {
      block.lines.push("");
    } else if (block && /^\s+\S/.test(line)) {
      if (block.indent === null) block.indent = /^\s+/.exec(line)[0].length;
      block.lines.push(line.slice(block.indent));
    } else if (currentKey && !block && /^\s+\S/.test(line)) {
      result[currentKey] = `${result[currentKey]} ${line.trim()}`.trim();
    }
  }
  finishBlock();
  return result;
}

function foldBlockLines(lines) {
  let value = "";
  let previousContent = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === "") continue;
    if (previousContent < 0) value += "\n".repeat(i);
    else value += i === previousContent + 1 ? " " : "\n".repeat(i - previousContent - 1);
    value += lines[i];
    previousContent = i;
  }
  if (previousContent >= 0) value += "\n".repeat(lines.length - previousContent);
  else value = "\n".repeat(lines.length);
  return value;
}

export function renderSkillIndex(skills) {
  if (!skills.length) return "(no skills directory found in this repo)";
  return skills
    .map(
      (s) =>
        `- ${s.name} (${s.path}; ${s.bodyTokens} tok body, ${s.descriptionTokens} tok description) :: ${s.description || "(no description)"}`,
    )
    .join("\n");
}

/**
 * The skill index the analysis prompt sees: name, path, and trigger description only.
 * Bodies are deliberately absent - the analysis turn opens a SKILL.md by path when a
 * description looks relevant to a mistake, instead of paying for every body on every
 * transcript.
 */
export function renderSkillIndexForAnalysis(skills) {
  if (!skills.length) return "(this repo has no skills)";
  return skills.map((s) => `- ${s.name} (${s.path}) :: ${s.description || "(no description)"}`).join("\n");
}

/** Serialize a skill draft to the common SKILL.md shape. */
export function renderSkillFile(skill) {
  const description = skill.description.replace(/\n+/g, " ").trim();
  // Generated skills are reference material that fires on its description, never a
  // slash-command: mark them non-invocable and internal so harnesses keep them out of
  // the user-facing command list.
  const frontmatter = [
    `name: ${skill.name}`,
    `description: ${description}`,
    "user-invocable: false",
    "metadata:",
    "  internal: true",
  ].join("\n");
  return `---\n${frontmatter}\n---\n\n${skill.body.trim()}\n`;
}

/**
 * The skills one extract creates.
 *
 * Usually one. Several arrive together when the measurement merged their removals into a
 * single change (`anchoredHunks`), which makes them one accept/reject decision - accepting
 * half a merged change is not a thing a file can do. Proposals written before that was
 * possible carry a single `skill`, so both shapes read the same way here.
 *
 * @returns {object[]}
 */
export function editSkills(edit) {
  if (Array.isArray(edit?.skills)) return edit.skills.filter(Boolean);
  return edit?.skill ? [edit.skill] : [];
}

/**
 * The budget arithmetic that makes extraction worth it, reported per edit:
 * "-1,900 tok always-loaded, +140 tok description".
 */
export function extractionBudgetEffect(edit) {
  const skills = editSkills(edit);
  if (edit.kind !== "extract" || !skills.length) return null;
  const pairs = (Array.isArray(edit.hunks) ? edit.hunks : [edit]).filter(
    (part) => !part.file || !edit.file || part.file === edit.file,
  );
  const removedFromMemory = pairs.reduce((sum, p) => sum + estimateTokens(p.find) - estimateTokens(p.replace), 0);
  const descriptionCost = skills.reduce((sum, skill) => sum + estimateTokens(skill.description), 0);
  return {
    alwaysLoadedDelta: -removedFromMemory,
    descriptionCost,
    net: descriptionCost - removedFromMemory,
    skillBodyTokens: skills.reduce((sum, skill) => sum + estimateTokens(skill.body), 0),
  };
}

/** Where agents actually auto-load skills from: the AGENTS.md convention. */
export const CANONICAL_SKILLS_DIR = ".agents/skills";
/** Claude reads this path; it is kept as a symlink into the canonical dir, never a copy. */
export const CLAUDE_SKILLS_LINK = ".claude/skills";
export const CLAUDE_SKILLS_LINK_TARGET = path.posix.join("..", CANONICAL_SKILLS_DIR);

export function normalizeSkillsDir(skillsDir) {
  if (typeof skillsDir !== "string" || !skillsDir.trim()) {
    throw new UserError("config.skillsDir must be a non-empty path string");
  }
  const normalized = skillsDir.replaceAll("\\", "/");
  const withoutTrailingSlashes = normalized.replace(/\/+$/, "");
  const volumeRoot = /^([A-Za-z]:)\/+$/u.exec(normalized);
  const result = volumeRoot ? `${volumeRoot[1]}/` : withoutTrailingSlashes;
  if (!result) throw new UserError("config.skillsDir must be a non-empty path string");
  return result;
}

/**
 * Pick the directory skill extractions target.
 *
 * Skills only pay off if the harness loads them, so the answer is the canonical
 * `.agents/skills` (mirrored to `.claude/skills` by symlink) unless the user explicitly
 * configured an existing harness-loaded directory, including `.claude/skills`. The bare
 * `skills/` dir is an installer/public convention that no harness auto-loads, so it is
 * never auto-detected - it is only honored when named in the config. Resolution is
 * read-only; the layout is created at write time (`ensureSkillsLayout`), which keeps every pre-apply stage
 * side-effect free.
 */
export function resolveOverflowTarget(
  repoRoot,
  skillsDir = CANONICAL_SKILLS_DIR,
  { claudeSkillsDir = CLAUDE_SKILLS_LINK, allowExternal = false } = {},
) {
  const configuredDir = normalizeSkillsDir(skillsDir);
  const warnings = [];
  const canonical = path.join(repoRoot, CANONICAL_SKILLS_DIR);
  const claudeLink = path.isAbsolute(claudeSkillsDir) ? claudeSkillsDir : path.join(repoRoot, claudeSkillsDir);
  const target = path.relative(path.dirname(claudeLink), canonical) || ".";
  const claude = inspectClaudeSkillsLink(repoRoot, claudeSkillsDir);
  const explicit = configuredDir && configuredDir !== CANONICAL_SKILLS_DIR;
  const resolvedSkillsDir = path.isAbsolute(configuredDir) ? configuredDir : path.join(repoRoot, configuredDir);
  if (explicit && !allowExternal) assertSkillsDirInsideRepo(repoRoot, configuredDir, resolvedSkillsDir);
  const dir =
    explicit && fs.existsSync(resolvedSkillsDir) ? logicalSkillDir(repoRoot, configuredDir) : CANONICAL_SKILLS_DIR;
  if (claude.state === "dir" && dir === CANONICAL_SKILLS_DIR)
    warnings.push(claudeSkillsDirWarning(claudeSkillsDir, target));
  return { kind: "skills", dir, warnings };
}

function assertSkillsDirInsideRepo(repoRoot, configuredDir, resolvedSkillsDir) {
  const root = path.resolve(repoRoot);
  if (!isPathInside(root, path.resolve(resolvedSkillsDir))) throw invalidSkillsDir(configuredDir);
  if (!fs.existsSync(resolvedSkillsDir)) return;

  try {
    if (!isPathInside(fs.realpathSync(root), fs.realpathSync(resolvedSkillsDir))) throw invalidSkillsDir(configuredDir);
  } catch (err) {
    if (err instanceof UserError) throw err;
  }
}

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function invalidSkillsDir(configuredDir) {
  return new UserError(
    `config.skillsDir "${configuredDir}" must resolve inside the repository`,
    "use a skills directory inside the project, such as .claude/skills",
  );
}

function claudeSkillsDirWarning(claudeSkillsDir = CLAUDE_SKILLS_LINK, target = CLAUDE_SKILLS_LINK_TARGET) {
  return (
    `${claudeSkillsDir} is a real directory, not a symlink to ${target}; ` +
    `left untouched. Claude will not see skills written to ${CANONICAL_SKILLS_DIR} until you ` +
    `merge it in and replace it with the symlink (ln -s ${target} ${claudeSkillsDir}).`
  );
}

function inspectClaudeSkillsLink(repoRoot, claudeSkillsDir = CLAUDE_SKILLS_LINK) {
  const link = path.isAbsolute(claudeSkillsDir) ? claudeSkillsDir : path.join(repoRoot, claudeSkillsDir);
  let stat;
  try {
    stat = fs.lstatSync(link);
  } catch {
    return { state: "missing" };
  }
  if (stat.isSymbolicLink()) return { state: "symlink" };
  if (stat.isDirectory()) return { state: "dir" };
  return { state: "other" };
}

function pathIdentity(stat) {
  return { dev: stat.dev, ino: stat.ino };
}

function restoreQuarantinedPath(quarantine, destination) {
  const stat = fs.lstatSync(quarantine);
  if (stat.isDirectory()) {
    // Restore the directory object itself. Recursively copying it can fail for valid
    // entries such as Unix sockets and would turn restoration into a lossy clone. On
    // POSIX, an empty directory created with mkdir is an atomic no-clobber reservation;
    // rename may replace that reservation, but cannot replace it after another process
    // has populated it.
    if (process.platform === "win32") {
      fs.renameSync(quarantine, destination);
      return;
    }

    fs.mkdirSync(destination, { mode: stat.mode & 0o7777 });
    try {
      fs.renameSync(quarantine, destination);
    } catch (err) {
      try {
        fs.rmdirSync(destination);
      } catch {
        // Another process populated the reservation. Preserve both directory trees.
      }
      throw err;
    }
    return;
  }
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(quarantine), destination);
    fs.unlinkSync(quarantine);
    return;
  }
  fs.linkSync(quarantine, destination);
  fs.unlinkSync(quarantine);
}

export function removeOwnedSkillPaths(paths) {
  const removed = [];
  const conflicts = [];
  for (const item of [...paths].reverse()) {
    let stat;
    try {
      stat = fs.lstatSync(item.absolute);
    } catch {
      continue;
    }
    const observed = pathIdentity(stat);
    if (observed.dev !== item.identity.dev || observed.ino !== item.identity.ino) {
      conflicts.push(item);
      continue;
    }
    if (item.text !== undefined) {
      let text;
      try {
        text = fs.readFileSync(item.absolute, "utf8");
      } catch {
        conflicts.push(item);
        continue;
      }
      if (text !== item.text) {
        conflicts.push(item);
        continue;
      }
    }

    // Move the pathname out of the way atomically, then validate the object that was
    // actually moved. A second pathname check followed by unlink would let a concurrent
    // replacement slip between those operations and be deleted as if it were ours.
    const quarantine = path.join(
      path.dirname(item.absolute),
      `.${path.basename(item.absolute)}.backpass-rollback-${randomUUID()}`,
    );
    let quarantined = false;
    try {
      fs.renameSync(item.absolute, quarantine);
      quarantined = true;
      const moved = pathIdentity(fs.lstatSync(quarantine));
      const identityMatches = moved.dev === item.identity.dev && moved.ino === item.identity.ino;
      const textMatches = item.text === undefined || fs.readFileSync(quarantine, "utf8") === item.text;
      if (identityMatches && textMatches) {
        fs.unlinkSync(quarantine);
        removed.push(item);
        continue;
      }

      restoreQuarantinedPath(quarantine, item.absolute);
      conflicts.push(item);
    } catch {
      if (quarantined) {
        try {
          restoreQuarantinedPath(quarantine, item.absolute);
        } catch {
          fs.existsSync(quarantine);
        }
      }
      conflicts.push(item);
    }
  }
  return { removed, conflicts };
}

/**
 * Create the canonical skills dir and the `.claude/skills -> ../.agents/skills` symlink
 * so both harness families load the same files with no duplication. An existing
 * `.claude/skills` is never clobbered: a symlink (to anywhere) is left as is, and a real
 * directory is reported so the user can merge it by hand.
 */
export function ensureSkillsLayout(repoRoot, claudeSkillsDir = CLAUDE_SKILLS_LINK) {
  const created = [];
  const warnings = [];
  const canonical = path.join(repoRoot, CANONICAL_SKILLS_DIR);
  if (!fs.existsSync(canonical)) {
    fs.mkdirSync(canonical, { recursive: true });
    created.push(CANONICAL_SKILLS_DIR);
  }

  const link = path.isAbsolute(claudeSkillsDir) ? claudeSkillsDir : path.join(repoRoot, claudeSkillsDir);
  const target = path.relative(path.dirname(link), canonical) || ".";
  const claude = inspectClaudeSkillsLink(repoRoot, claudeSkillsDir);
  if (claude.state === "missing") {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, "dir");
    created.push(`${claudeSkillsDir} -> ${target}`);
  } else if (claude.state === "dir") {
    warnings.push(claudeSkillsDirWarning(claudeSkillsDir, target));
  }
  return { created, warnings };
}

/** Write an accepted skill extraction to disk, setting up the load layout on first use. */
export function writeSkill(repoRoot, skill, { exclusive = false, ensureLayout = true } = {}) {
  const inCanonical = skill.path === CANONICAL_SKILLS_DIR || skill.path.startsWith(`${CANONICAL_SKILLS_DIR}/`);
  const layout = inCanonical && ensureLayout ? ensureSkillsLayout(repoRoot) : { created: [], warnings: [] };
  const canonicalWasMissing = inCanonical && !fs.existsSync(path.join(repoRoot, CANONICAL_SKILLS_DIR));
  const target = path.isAbsolute(skill.path) ? skill.path : path.join(repoRoot, skill.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!ensureLayout && canonicalWasMissing) layout.created.push(CANONICAL_SKILLS_DIR);
  const text = renderSkillFile(skill);
  if (!exclusive) {
    fs.writeFileSync(target, text);
    return { target, ...layout };
  }

  let fd;
  /** @type {{ absolute: string, identity: { dev: number, ino: number }, relative: string, text?: string }[] | undefined} */
  let ownership;
  try {
    fd = fs.openSync(target, "wx");
    ownership = [{ absolute: target, identity: pathIdentity(fs.fstatSync(fd)), relative: skill.path }];
    fs.writeFileSync(fd, text);
    fs.closeSync(fd);
    fd = undefined;
    ownership[0].text = text;
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the original write error.
      }
    }
    removeOwnedSkillPaths(ownership ?? []);
    throw err;
  }
  return { target, ...layout, ownership };
}
