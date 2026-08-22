import fs from "node:fs";
import path from "node:path";

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

/** Read the existing skills so synthesis can tune a description instead of duplicating it. */
export function loadSkills(repoRoot, skillsDir) {
  const root = path.join(repoRoot, skillsDir);
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
      path: path.relative(repoRoot, file),
      bodyTokens: estimateTokens(text),
      descriptionTokens: estimateTokens(frontmatter.description || ""),
    });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Minimal YAML frontmatter reader: only `key: value` and folded multi-line values. */
export function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return {};
  const result = {};
  let currentKey = null;
  for (const line of match[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      currentKey = kv[1];
      result[currentKey] = kv[2].trim().replace(/^["']|["']$/g, "");
    } else if (currentKey && /^\s+\S/.test(line)) {
      result[currentKey] = `${result[currentKey]} ${line.trim()}`.trim();
    }
  }
  return result;
}

export function renderSkillIndex(skills) {
  if (!skills.length) return "(no skills directory found in this repo)";
  return skills
    .map(
      (s) =>
        `- ${s.name} (${s.bodyTokens} tok body, ${s.descriptionTokens} tok description) :: ${s.description || "(no description)"}`,
    )
    .join("\n");
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
 * The budget arithmetic that makes extraction worth it, reported per edit:
 * "-1,900 tok always-loaded, +140 tok description".
 */
export function extractionBudgetEffect(edit) {
  if (edit.kind !== "extract" || !edit.skill) return null;
  const pairs = Array.isArray(edit.hunks) ? edit.hunks : [edit];
  const removedFromMemory = pairs.reduce((sum, p) => sum + estimateTokens(p.find) - estimateTokens(p.replace), 0);
  const descriptionCost = estimateTokens(edit.skill.description);
  return {
    alwaysLoadedDelta: -removedFromMemory,
    descriptionCost,
    net: descriptionCost - removedFromMemory,
    skillBodyTokens: estimateTokens(edit.skill.body),
  };
}

/** Where agents actually auto-load skills from: the AGENTS.md convention. */
export const CANONICAL_SKILLS_DIR = ".agents/skills";
/** Claude reads this path; it is kept as a symlink into the canonical dir, never a copy. */
export const CLAUDE_SKILLS_LINK = ".claude/skills";
export const CLAUDE_SKILLS_LINK_TARGET = path.posix.join("..", CANONICAL_SKILLS_DIR);

/**
 * Pick the directory skill extractions target.
 *
 * Skills only pay off if the harness loads them, so the answer is the canonical
 * `.agents/skills` (mirrored to `.claude/skills` by symlink) unless the user explicitly
 * configured another directory that already exists. The bare `skills/` dir is an
 * installer/public convention that no harness auto-loads, so it is never auto-detected -
 * it is only honored when named in the config. Resolution is read-only; the layout is
 * created at write time (`ensureSkillsLayout`), which keeps every pre-apply stage
 * side-effect free.
 */
export function resolveOverflowTarget(repoRoot, skillsDir = CANONICAL_SKILLS_DIR) {
  const warnings = [];
  const claude = inspectClaudeSkillsLink(repoRoot);
  if (claude.state === "dir") warnings.push(claudeSkillsDirWarning());

  const explicit = skillsDir && skillsDir !== CANONICAL_SKILLS_DIR && skillsDir !== CLAUDE_SKILLS_LINK;
  if (explicit && fs.existsSync(path.join(repoRoot, skillsDir))) {
    return { kind: "skills", dir: skillsDir, warnings };
  }
  return { kind: "skills", dir: CANONICAL_SKILLS_DIR, warnings };
}

function claudeSkillsDirWarning() {
  return (
    `${CLAUDE_SKILLS_LINK} is a real directory, not a symlink to ${CLAUDE_SKILLS_LINK_TARGET}; ` +
    `left untouched. Claude will not see skills written to ${CANONICAL_SKILLS_DIR} until you ` +
    `merge it in and replace it with the symlink (ln -s ${CLAUDE_SKILLS_LINK_TARGET} ${CLAUDE_SKILLS_LINK}).`
  );
}

function inspectClaudeSkillsLink(repoRoot) {
  let stat;
  try {
    stat = fs.lstatSync(path.join(repoRoot, CLAUDE_SKILLS_LINK));
  } catch {
    return { state: "missing" };
  }
  if (stat.isSymbolicLink()) return { state: "symlink" };
  if (stat.isDirectory()) return { state: "dir" };
  return { state: "other" };
}

/**
 * Create the canonical skills dir and the `.claude/skills -> ../.agents/skills` symlink
 * so both harness families load the same files with no duplication. An existing
 * `.claude/skills` is never clobbered: a symlink (to anywhere) is left as is, and a real
 * directory is reported so the user can merge it by hand.
 */
export function ensureSkillsLayout(repoRoot) {
  const created = [];
  const warnings = [];
  const canonical = path.join(repoRoot, CANONICAL_SKILLS_DIR);
  if (!fs.existsSync(canonical)) {
    fs.mkdirSync(canonical, { recursive: true });
    created.push(CANONICAL_SKILLS_DIR);
  }

  const claude = inspectClaudeSkillsLink(repoRoot);
  if (claude.state === "missing") {
    const link = path.join(repoRoot, CLAUDE_SKILLS_LINK);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(CLAUDE_SKILLS_LINK_TARGET, link, "dir");
    created.push(`${CLAUDE_SKILLS_LINK} -> ${CLAUDE_SKILLS_LINK_TARGET}`);
  } else if (claude.state === "dir") {
    warnings.push(claudeSkillsDirWarning());
  }
  return { created, warnings };
}

/** Write an accepted skill extraction to disk, setting up the load layout on first use. */
export function writeSkill(repoRoot, skill) {
  const inCanonical = skill.path === CANONICAL_SKILLS_DIR || skill.path.startsWith(`${CANONICAL_SKILLS_DIR}/`);
  const layout = inCanonical ? ensureSkillsLayout(repoRoot) : { created: [], warnings: [] };
  const target = path.join(repoRoot, skill.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderSkillFile(skill));
  return { target, ...layout };
}
