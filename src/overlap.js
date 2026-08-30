import { featureSimilarity, parseMemoryUnits, similarityFeatures } from "./memory.js";

/**
 * Cross-surface duplication (always-loaded memory file vs skills).
 *
 * A skill's description is already always-loaded, so a matching memory-file unit pays
 * those tokens twice while relevance credit still lands on the memory-file alias. A
 * skill-body match is different: the body loads only on trigger, so the memory unit may
 * be the only always-loaded coverage. This pass reports both for placement decisions and
 * never deletes; only description matches point a shrink at the memory-file copy.
 *
 * The score is the same Sorensen-Dice word-bigram `similarity` used to re-anchor
 * instructions and to decide gap coverage. The bar matches `GAP_COVERED_THRESHOLD`
 * (0.6): substantial overlap, not a shared stopword.
 */

/** Same bar as gap coverage / re-anchor: enough to call the texts the same unit. */
export const CROSS_SURFACE_OVERLAP_THRESHOLD = 0.6;

/**
 * Skill surfaces a memory-file unit can overlap: the always-loaded description, the
 * full triggered body, and each body unit (so a restated paragraph still matches).
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

function preparedUnit(text) {
  const variants = textVariants(text);
  const indexed = /^(.*?)(?:::|:|\s+-\s+)([\s\S]+)$/.exec(variants.at(-1));
  return {
    features: variants.map(similarityFeatures),
    indexLabel: indexed ? normalizeIndexLabel(indexed[1]) : null,
    indexedFeatures: indexed ? similarityFeatures(indexed[2].trim()) : null,
  };
}

function overlapScore(unit, candidate) {
  let best = 0;
  for (const unitFeatures of unit.features) {
    for (const candidateFeatures of candidate.features) {
      best = Math.max(best, featureSimilarity(unitFeatures, candidateFeatures));
    }
  }
  if (unit.indexLabel === candidate.skillLabel) {
    for (const candidateFeatures of candidate.features) {
      best = Math.max(best, featureSimilarity(unit.indexedFeatures, candidateFeatures));
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
 * or body. One preferred hit per unit: a qualifying description match wins over body
 * matches, then the highest score wins within that surface; report-only.
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
      skillLabel: normalizeIndexLabel(skill.name),
      features: textVariants(entry.text).map(similarityFeatures),
    })),
  );
  if (!catalog.length) return [];

  const hits = [];
  for (const unit of units) {
    const prepared = preparedUnit(unit.text);
    let best = null;
    for (const candidate of catalog) {
      const score = overlapScore(prepared, candidate);
      if (score < threshold) continue;
      if (
        !best ||
        (candidate.surface === "description" && best.surface !== "description") ||
        (candidate.surface === best.surface && score > best.score)
      ) {
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
