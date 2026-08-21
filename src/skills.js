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
  return `---\nname: ${skill.name}\ndescription: ${description}\n---\n\n${skill.body.trim()}\n`;
}

/**
 * The budget arithmetic that makes extraction worth it, reported per edit:
 * "-1,900 tok always-loaded, +140 tok description".
 */
export function extractionBudgetEffect(edit) {
  if (edit.kind !== "extract" || !edit.skill) return null;
  const removedFromMemory = estimateTokens(edit.find) - estimateTokens(edit.replace);
  const descriptionCost = estimateTokens(edit.skill.description);
  return {
    alwaysLoadedDelta: -removedFromMemory,
    descriptionCost,
    net: descriptionCost - removedFromMemory,
    skillBodyTokens: estimateTokens(edit.skill.body),
  };
}

/**
 * Repos with no skills convention get `docs/` extraction plus a pointer line instead
 * (design section 7, format note). Detected rather than configured so the common case
 * needs no setup.
 */
export function resolveOverflowTarget(repoRoot, skillsDir) {
  if (fs.existsSync(path.join(repoRoot, skillsDir))) return { kind: "skills", dir: skillsDir };
  for (const candidate of [".claude/skills", ".agents/skills", "skills"]) {
    if (fs.existsSync(path.join(repoRoot, candidate))) return { kind: "skills", dir: candidate };
  }
  if (fs.existsSync(path.join(repoRoot, "docs"))) return { kind: "docs", dir: "docs" };
  return { kind: "skills", dir: skillsDir };
}

/** Write an accepted skill extraction to disk. */
export function writeSkill(repoRoot, skill) {
  const target = path.join(repoRoot, skill.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderSkillFile(skill));
  return target;
}
