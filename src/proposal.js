import { budgetStatus, estimateTokens } from "./tokens.js";

/**
 * The proposal model: what a synthesis pass is allowed to produce, and the mechanical
 * gates it must clear before a human ever sees it (design sections 3, 6, 7).
 *
 * An edit is a find/replace against one file, which keeps the contract narrow enough to
 * validate deterministically and to apply without a patch library:
 *
 *   add      find === ''      insert `replace` after `anchor`
 *   remove   replace === ''   delete `find`
 *   rewrite  both set         replace `find` with `replace`
 *   extract  both set + skill move detail into a new SKILL.md, leave a pointer behind
 *
 * `find` must match exactly once in the target file. Anything else is rejected rather
 * than guessed at - a memory file is not something to fuzzy-patch.
 */

export const EDIT_KINDS = ["add", "remove", "rewrite", "extract"];

export class ProposalViolation extends Error {
  constructor(message, violations) {
    super(message);
    this.name = "ProposalViolation";
    this.violations = violations;
  }
}

function normalizeEdit(raw, index, defaults) {
  const kind = String(raw?.kind || "").toLowerCase();
  return {
    id: `e${index + 1}`,
    kind,
    file: raw?.file || defaults.memoryPath,
    title: String(raw?.title || "").trim() || "(untitled edit)",
    find: typeof raw?.find === "string" ? raw.find : "",
    replace: typeof raw?.replace === "string" ? raw.replace : "",
    anchor: typeof raw?.anchor === "string" && raw.anchor.trim() ? raw.anchor : null,
    rationale: String(raw?.rationale || "").trim(),
    instructions: Array.isArray(raw?.instructions) ? raw.instructions.map(String) : [],
    evidence: normalizeEvidence(raw?.evidence),
    transcripts: Number.isFinite(raw?.transcripts) ? Number(raw.transcripts) : countSources(raw?.evidence),
    skill: normalizeSkill(raw?.skill),
  };
}

function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence)) return [];
  return evidence
    .filter((e) => e && typeof e.text === "string" && e.text.trim())
    .map((e) => ({
      polarity: e.polarity === "positive" ? "positive" : e.polarity === "neutral" ? "neutral" : "negative",
      text: String(e.text).trim().slice(0, 600),
      source: String(e.source || "unknown source").slice(0, 120),
    }));
}

function countSources(evidence) {
  if (!Array.isArray(evidence)) return 0;
  return new Set(evidence.map((e) => e?.source).filter(Boolean)).size;
}

function normalizeSkill(skill) {
  if (!skill || typeof skill !== "object") return null;
  if (!skill.name || !skill.description) return null;
  return {
    name: String(skill.name).trim(),
    path: skill.path ? String(skill.path) : null,
    description: String(skill.description).trim(),
    body: String(skill.body || "").trim(),
  };
}

function occurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Apply one edit to file text. Returns the new text, or throws with a precise reason -
 * that reason is what gets fed back to the model in the single re-prompt.
 */
export function applyEdit(text, edit) {
  if (edit.find) {
    const found = occurrences(text, edit.find);
    if (found === 0) throw new Error(`edit ${edit.id}: "find" text does not appear in ${edit.file}`);
    if (found > 1)
      throw new Error(`edit ${edit.id}: "find" text appears ${found} times in ${edit.file}; must be unique`);
    return text.replace(edit.find, () => edit.replace);
  }

  if (!edit.replace) throw new Error(`edit ${edit.id}: nothing to add and nothing to remove`);

  if (!edit.anchor) {
    const separator = text.endsWith("\n") ? "" : "\n";
    return `${text}${separator}\n${edit.replace}\n`;
  }

  const found = occurrences(text, edit.anchor);
  if (found === 0) throw new Error(`edit ${edit.id}: "anchor" text does not appear in ${edit.file}`);
  if (found > 1)
    throw new Error(`edit ${edit.id}: "anchor" text appears ${found} times in ${edit.file}; must be unique`);
  const at = text.indexOf(edit.anchor) + edit.anchor.length;
  return `${text.slice(0, at)}\n\n${edit.replace}${text.slice(at)}`;
}

/** Apply a set of edits to one file, in order. */
export function applyEdits(text, edits) {
  return edits.reduce((current, edit) => applyEdit(current, edit), text);
}

/**
 * Validate a raw synthesis result against the mechanical gates. Returns
 * `{ proposal, violations }`; the caller decides whether to re-prompt or fail loudly.
 */
export function buildProposal(rawResult, context) {
  const {
    memoryFile,
    config,
    repo,
    summary,
    harnessCounts = {},
    rejections = { entries: {} },
    isSuppressed = () => false,
    skillFiles = [],
  } = context;

  const violations = [];
  const rawEdits = Array.isArray(rawResult?.edits) ? rawResult.edits : [];
  const edits = rawEdits.map((raw, i) => normalizeEdit(raw, i, { memoryPath: memoryFile.path }));

  if (edits.length > config.maxEditsPerRun) {
    violations.push(
      `proposed ${edits.length} edits but the per-run cap is ${config.maxEditsPerRun} (the learning rate)`,
    );
  }

  const accepted = [];
  const knownSkillPaths = new Set(skillFiles.map((s) => s.path));

  for (const edit of edits) {
    if (!EDIT_KINDS.includes(edit.kind)) {
      violations.push(`edit ${edit.id}: unknown kind "${edit.kind}"`);
      continue;
    }
    if (!edit.evidence.length) {
      violations.push(`edit ${edit.id} ("${edit.title}") carries no verbatim evidence quote`);
      continue;
    }
    if (edit.kind === "add" && edit.transcripts < config.minGapEvidence) {
      violations.push(
        `edit ${edit.id} ("${edit.title}") adds a new instruction backed by ${edit.transcripts} session(s); ` +
          `${config.minGapEvidence} are required`,
      );
      continue;
    }
    if (edit.kind === "extract" && !edit.skill) {
      violations.push(`edit ${edit.id}: kind "extract" requires a skill draft`);
      continue;
    }
    if (edit.kind !== "extract" && edit.skill) {
      violations.push(`edit ${edit.id}: only kind "extract" may carry a skill draft`);
      continue;
    }
    if (isSuppressed(edit, rejections)) {
      // Rejections are respected until materially new evidence arrives (captain tweak 3).
      continue;
    }

    edit.targetsMemoryFile = edit.file === memoryFile.path;
    if (!edit.targetsMemoryFile && !knownSkillPaths.has(edit.file) && edit.kind !== "extract") {
      violations.push(`edit ${edit.id}: targets ${edit.file}, which is neither the memory file nor a known skill`);
      continue;
    }
    if (edit.kind === "extract" && edit.skill && !edit.skill.path) {
      edit.skill.path = `${config.skillsDir}/${slug(edit.skill.name)}/SKILL.md`;
    }

    accepted.push(edit);
  }

  // Deltas are measured here, never taken from the model.
  const memoryEdits = accepted.filter((e) => e.targetsMemoryFile);
  let running = memoryFile.text;
  for (const edit of accepted) {
    if (!edit.targetsMemoryFile) {
      edit.deltaTokens = estimateTokens(edit.replace) - estimateTokens(edit.find);
      continue;
    }
    let next;
    try {
      next = applyEdit(running, edit);
    } catch (err) {
      violations.push(err.message);
      edit.applicable = false;
      edit.deltaTokens = 0;
      continue;
    }
    edit.applicable = true;
    edit.deltaTokens = estimateTokens(next) - estimateTokens(running);
    running = next;
  }

  const applicableMemoryEdits = memoryEdits.filter((e) => e.applicable);
  let projectedText;
  try {
    projectedText = applyEdits(memoryFile.text, applicableMemoryEdits);
  } catch {
    projectedText = running;
  }

  const budget = budgetStatus(memoryFile.text, projectedText, config.budgetTokens);

  /**
   * The budget gate has two modes (design section 6).
   *
   * Normally the post-edit file must fit the budget. But a file that is ALREADY over
   * budget cannot be brought under it in one capped step - demanding that would fail
   * every run on exactly the repos that need backpass most. There, the run is a shrink
   * plan and the gate is progress: the edit set must be strictly net-negative.
   */
  budget.mode = memoryFile.tokens > config.budgetTokens ? "shrink" : "cap";
  budget.startedOverBudget = budget.mode === "shrink";

  if (budget.mode === "cap" && !budget.withinBudget) {
    violations.push(
      `applying every proposed edit leaves ${memoryFile.path} at ${budget.projected} tokens, ` +
        `${budget.over} over the ${config.budgetTokens}-token budget`,
    );
  } else if (budget.mode === "shrink" && budget.delta >= 0) {
    violations.push(
      `${memoryFile.path} is already ${budget.current - config.budgetTokens} tokens over the ` +
        `${config.budgetTokens}-token budget, so this run must shrink it, but the proposed edits ` +
        `change it by ${budget.delta >= 0 ? "+" : ""}${budget.delta} tokens`,
    );
  }

  const proposal = {
    version: 1,
    tool: "backpass",
    generatedAt: new Date().toISOString(),
    repo: { name: repo.name, root: repo.root },
    memoryFile: { path: memoryFile.path, hash: memoryFile.hash, tokens: memoryFile.tokens },
    budget,
    config: {
      budgetTokens: config.budgetTokens,
      maxEditsPerRun: config.maxEditsPerRun,
      minGapEvidence: config.minGapEvidence,
      skillsDir: config.skillsDir,
      analysis: config.analysis,
      synthesis: config.synthesis,
    },
    stats: {
      transcripts: summary?.analyzedSessions ?? 0,
      harnessCounts,
      positive: summary?.totals?.positive ?? 0,
      negative: summary?.totals?.negative ?? 0,
      gapClusters: summary?.totals?.gapClusters ?? 0,
      skillExtractions: accepted.filter((e) => e.kind === "extract").length,
    },
    edits: accepted,
    verdicts: Array.isArray(rawResult?.verdicts) ? rawResult.verdicts : [],
    notes: Array.isArray(rawResult?.notes) ? rawResult.notes.map(String) : [],
  };

  return { proposal, violations };
}

export function slug(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "skill"
  );
}

/**
 * Project the memory file forward under a specific set of accepted edit ids - used by
 * both the apply surface's live budget gauge and the actual writer.
 */
export function projectWithDecisions(memoryText, edits, acceptedIds, capTokens) {
  const chosen = edits.filter((e) => acceptedIds.includes(e.id) && e.targetsMemoryFile && e.applicable !== false);
  let text = memoryText;
  for (const edit of chosen) {
    try {
      text = applyEdit(text, edit);
    } catch {
      // Skip an edit that no longer applies; the writer reports it.
    }
  }
  return { text, budget: budgetStatus(memoryText, text, capTokens) };
}
