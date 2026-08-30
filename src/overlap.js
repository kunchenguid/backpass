import { parseMemoryUnits, similarity } from "./memory.js";

/**
 * Cross-surface duplication (always-loaded memory file vs skills).
 *
 * A skill's description is already always-loaded; an index line or restated procedure
 * in the memory file pays those tokens twice, and relevance credit still lands on the
 * memory-file alias. This pass flags the overlap so a shrink can drop the copy. It
 * never deletes: detection and report only.
 *
 * The score is the same Sorensen-Dice word-bigram `similarity` used to re-anchor
 * instructions and to decide gap coverage. The bar matches `GAP_COVERED_THRESHOLD`
 * (0.6): substantial overlap, not a shared stopword.
 */

/** Same bar as gap coverage / re-anchor: enough to call the texts the same unit. */
export const CROSS_SURFACE_OVERLAP_THRESHOLD = 0.6;

/**
 * Surfaces a memory-file unit can duplicate: the skill's always-loaded description,
 * the full body, and each body unit (so a restated paragraph still matches).
 */
function textVariants(text) {
  const original = String(text || "").trim();
  if (!original) return [];
  const withoutListMarker = original.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
  return withoutListMarker === original ? [original] : [original, withoutListMarker];
}

function normalizeIndexLabel(text) {
  return text
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function overlapScore(unitText, candidate) {
  const unitVariants = textVariants(unitText);
  const unmarked = unitVariants.at(-1);
  const indexed = /^(.*?)(?:::|:|\s+-\s+)([\s\S]+)$/.exec(unmarked);
  if (indexed && normalizeIndexLabel(indexed[1]) === normalizeIndexLabel(candidate.skill)) {
    unitVariants.push(indexed[2].trim());
  }

  let best = 0;
  for (const unitVariant of unitVariants) {
    for (const candidateVariant of textVariants(candidate.text)) {
      best = Math.max(best, similarity(unitVariant, candidateVariant));
    }
  }
  return best;
}

function skillSurfaces(skill) {
  const surfaces = [];
  const description = String(skill?.description || "").trim();
  if (description) {
    surfaces.push({ surface: "description", text: description });
  }
  const body = String(skill?.body || "").trim();
  if (body) {
    surfaces.push({ surface: "body", text: body });
    for (const unit of parseMemoryUnits(body)) {
      if (unit.text.trim()) surfaces.push({ surface: "body", text: unit.text });
    }
  }
  return surfaces;
}

/**
 * Memory-file units whose normalized text substantially overlaps a skill description
 * or body. One best hit per unit (highest score); report-only.
 *
 * @param {{ path?: string, units?: object[] }|null} memoryFile
 * @param {object[]} [skills]
 * @param {number} [threshold]
 */
export function crossSurfaceDuplicates(memoryFile, skills = [], threshold = CROSS_SURFACE_OVERLAP_THRESHOLD) {
  const units = memoryFile?.units || [];
  if (!units.length || !skills.length) return [];

  const catalog = skills.flatMap((skill) =>
    skillSurfaces(skill).map((entry) => ({
      skill: skill.name,
      path: skill.path,
      ...entry,
    })),
  );
  if (!catalog.length) return [];

  const hits = [];
  for (const unit of units) {
    let best = null;
    for (const candidate of catalog) {
      const score = overlapScore(unit.text, candidate);
      if (score < threshold) continue;
      if (!best || score > best.score) {
        best = {
          instruction: unit.id,
          tokens: unit.tokens,
          skill: candidate.skill,
          path: candidate.path,
          surface: candidate.surface,
          score,
          ...(memoryFile.path ? { memoryPath: memoryFile.path } : {}),
        };
      }
    }
    if (best) hits.push(best);
  }
  return hits;
}
