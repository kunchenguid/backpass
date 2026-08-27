import { renderHunkLines } from "./diff.js";
import { editSkills } from "./skills.js";
import { budgetGateKind, budgetStatus, estimateTokens } from "./tokens.js";

/**
 * The proposal model: what a synthesis pass is allowed to produce, and the mechanical
 * gates it must clear before a human ever sees it (design sections 3, 6, 7). The
 * budget gate (`budgetGateKind`) runs again on the accepted subset at apply.
 *
 * The synthesis agent edits a staging copy of the memory file natively
 * (`src/workspace.js`); backpass measures the result as anchored hunks (`src/diff.js`)
 * and the agent annotates them - kind, title, rationale, evidence - by id. An edit is
 * therefore a group of measured changes against one file:
 *
 *   add      only inserts text                  (gated like a new instruction)
 *   remove   only deletes text
 *   rewrite  replaces text
 *   extract  memory-file change(s) + the created SKILL.md file(s) they pay for
 *
 * Each hunk carries a `find`/`replace` pair copied out of the original file by
 * construction; `find` occurs exactly once there. That is what the writer applies later,
 * against whatever the file is by then: anything that no longer matches is rejected
 * rather than guessed at - a memory file is not something to fuzzy-patch.
 */

export const EDIT_KINDS = ["add", "remove", "rewrite", "extract"];

/**
 * The per-run edit cap is adaptive (design section 6). Near or under budget it is the
 * gentle learning rate: DEFAULT_MAX_EDITS small, reviewable steps. A file that is over
 * budget needs a shrink plan, and a flat cap would stretch that plan across many runs,
 * so the allowance scales with the overage: one edit per SHRINK_EDIT_TOKENS of overage,
 * never below the default and never above SHRINK_MAX_EDITS, which keeps a single apply
 * review manageable. An explicit `maxEditsPerRun` (flag or config) always wins.
 */
export const DEFAULT_MAX_EDITS = 5;
export const SHRINK_MAX_EDITS = 20;
/** A typical memory-file instruction removal or tightening trims about this many tokens. */
export const SHRINK_EDIT_TOKENS = 40;

export function effectiveMaxEdits(memoryFile, config) {
  if (Number.isInteger(config.maxEditsPerRun) && config.maxEditsPerRun > 0) return config.maxEditsPerRun;
  const overage = memoryFile.tokens - config.budgetTokens;
  if (overage <= 0) return DEFAULT_MAX_EDITS;
  return Math.min(SHRINK_MAX_EDITS, Math.max(DEFAULT_MAX_EDITS, Math.ceil(overage / SHRINK_EDIT_TOKENS)));
}

/**
 * A synthesis run that ended without a valid proposal, carrying *why* it ended.
 *
 * `reason` is the terminal condition - "gates", "empty", "unparseable", "editing" - and
 * `saved` is the last parseable-but-gated proposal written to disk, if any, with the
 * annotation attempt that produced it. They are separate because they can disagree: a run
 * whose last turn was empty still leaves an older rejected proposal on disk, and reporting
 * that proposal's violations as the empty turn's result is how a run gets diagnosed wrong.
 */
export class ProposalViolation extends Error {
  /**
   * @param {string} message
   * @param {string[]} violations
   * @param {{ reason?: string, attempts?: number,
   *   saved?: { attempt: number, violations: string[] } | null, proposalPath?: string | null }} [detail]
   */
  constructor(message, violations, detail = {}) {
    super(message);
    this.name = "ProposalViolation";
    this.violations = violations;
    this.reason = detail.reason || "gates";
    this.attempts = detail.attempts ?? 0;
    this.saved = detail.saved || null;
    this.proposalPath = detail.proposalPath || null;
  }
}

function normalizeEdit(raw, index) {
  const kind = String(raw?.kind || "").toLowerCase();
  const refs = Array.isArray(raw?.changes) ? raw.changes : Array.isArray(raw?.hunks) ? raw.hunks : [];
  return {
    id: `e${index + 1}`,
    kind,
    changeIds: refs.map((c) => String(c).trim().toUpperCase()).filter(Boolean),
    title: String(raw?.title || "").trim() || "(untitled edit)",
    rationale: String(raw?.rationale || "").trim(),
    instructions: Array.isArray(raw?.instructions) ? raw.instructions.map(String) : [],
    evidence: normalizeEvidence(raw?.evidence),
    transcripts: Number.isFinite(raw?.transcripts) ? Number(raw.transcripts) : countSources(raw?.evidence),
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

/** Overlapping count: a run of identical lines must not pass as unique. */
function occurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + 1);
  }
  return count;
}

function replaceOnce(text, find, replace, label, file) {
  const found = occurrences(text, find);
  if (found === 0) throw new Error(`${label}: "find" text does not appear in ${file}`);
  if (found > 1) throw new Error(`${label}: "find" text appears ${found} times in ${file}; must be unique`);
  return text.replace(find, () => replace);
}

/**
 * Apply one edit to file text. Returns the new text, or throws with a precise reason.
 *
 * A measured edit applies each of its hunks; the hunks' windows never overlap, so they
 * apply in any order and any subset. The legacy single `find`/`replace`/`anchor` shape
 * is still honored so a proposal saved by an earlier version stays applicable.
 */
export function applyEdit(text, edit) {
  if (Array.isArray(edit.hunks)) {
    let current = text;
    for (const hunk of edit.hunks) {
      const label = `edit ${edit.id} (${hunk.id || "hunk"})`;
      if (!hunk.find) {
        if (current !== "") throw new Error(`${label}: ${edit.file} is no longer empty`);
        current = hunk.replace;
        continue;
      }
      current = replaceOnce(current, hunk.find, hunk.replace, label, edit.file);
    }
    return current;
  }

  if (edit.find) return replaceOnce(text, edit.find, edit.replace, `edit ${edit.id}`, edit.file);

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

/** One-line label for a measured change, used in gate messages and the annotate prompt. */
export function describeChange(change) {
  if (change.kind === "created") return `${change.id}: new file ${change.file}`;
  if (change.kind === "deleted") return `${change.id}: deletes ${change.file}`;
  const where = change.removed
    ? change.oldStart === change.oldEnd
      ? `line ${change.oldStart}`
      : `lines ${change.oldStart}-${change.oldEnd}`
    : `after line ${change.oldStart - 1}`;
  return `${change.id}: ${change.file} ${where} (-${change.removed}/+${change.added})`;
}

/** The measured changes as the annotate prompt shows them. */
export function renderChangesForPrompt(measured, memoryFile) {
  if (!measured.changes.length) return "(no changes - the staging copy is identical to the original)";
  const unitsAt = (change) => {
    if (change.file !== memoryFile.path || change.kind !== "hunk") return "";
    const from = change.oldStart;
    const to = change.removed ? change.oldEnd : change.oldStart;
    const ids = memoryFile.units.filter((u) => u.startLine <= to && u.endLine >= from).map((u) => u.id);
    return ids.length ? ` · ${ids.join(", ")}` : "";
  };
  return measured.changes
    .map((change) => {
      const head = `[${describeChange(change)}${unitsAt(change)}]`;
      if (change.kind === "deleted") return head;
      if (change.kind === "created") {
        return `${head}\n${renderHunkLines(
          change.text.split("\n").map((text) => ({ type: "ins", text })),
          { maxLines: 80 },
        )}`;
      }
      return `${head}\n${renderHunkLines(change.lines)}`;
    })
    .join("\n\n");
}

/**
 * Validate the annotated, measured changes against the mechanical gates. Returns
 * `{ proposal, violations }`; the caller decides whether to re-prompt or fail loudly.
 *
 * `context.measured` is the workspace measurement (`measureWorkspace`); `rawResult` is
 * the model's annotation. Nothing textual is taken from the model: the hunks, their
 * deltas, the projected budget, and even whether an edit is an addition are measured.
 */
export function buildProposal(rawResult, context) {
  const {
    memoryFile,
    config,
    repo,
    summary,
    measured = { changes: [], stray: [] },
    harnessCounts = {},
    rejections = { entries: {} },
    isSuppressed = () => false,
  } = context;

  const violations = [];
  const notes = Array.isArray(rawResult?.notes) ? rawResult.notes.map(String) : [];
  const rawEdits = Array.isArray(rawResult?.edits) ? rawResult.edits : [];
  const edits = rawEdits.map((raw, i) => normalizeEdit(raw, i));
  const changesById = new Map(measured.changes.map((c) => [c.id, c]));

  const maxEdits = effectiveMaxEdits(memoryFile, config);
  if (edits.length > maxEdits) {
    violations.push(`proposed ${edits.length} edits but the per-run cap is ${maxEdits} (the learning rate)`);
  }

  // Every measured change must be claimed exactly once.
  const claimedBy = new Map();
  for (const edit of edits) {
    for (const id of edit.changeIds) {
      if (!changesById.has(id)) {
        violations.push(`edit ${edit.id} refers to ${id}, which is not a measured change`);
        continue;
      }
      if (claimedBy.has(id)) {
        violations.push(`${id} is claimed by both edit ${claimedBy.get(id)} and edit ${edit.id}`);
        continue;
      }
      claimedBy.set(id, edit.id);
    }
  }
  for (const change of measured.changes) {
    if (change.kind === "deleted") {
      violations.push(`${describeChange(change)}; backpass cannot propose deletions - restore the file`);
      continue;
    }
    if (!claimedBy.has(change.id)) {
      violations.push(
        `${describeChange(change)} is not part of any edit; every change needs an edit with evidence, or revert it`,
      );
    }
  }

  const accepted = [];
  for (const edit of edits) {
    const changes = edit.changeIds.map((id) => changesById.get(id)).filter(Boolean);
    const created = changes.filter((c) => c.kind === "created");
    const hunks = changes.filter((c) => c.kind === "hunk");
    const files = [...new Set(hunks.map((h) => h.file))];

    if (!EDIT_KINDS.includes(edit.kind)) {
      violations.push(`edit ${edit.id}: unknown kind "${edit.kind}"`);
      continue;
    }
    if (!changes.length) {
      violations.push(`edit ${edit.id} ("${edit.title}") names no measured change`);
      continue;
    }
    if (files.length > 1) {
      violations.push(`edit ${edit.id} ("${edit.title}") changes ${files.join(" and ")}; an edit changes one file`);
      continue;
    }
    if (!edit.evidence.length) {
      violations.push(`edit ${edit.id} ("${edit.title}") carries no verbatim evidence quote`);
      continue;
    }
    if (edit.kind === "extract") {
      if (!created.length || !hunks.length || files[0] !== memoryFile.path) {
        violations.push(
          `edit ${edit.id}: kind "extract" must group created SKILL.md file(s) with change(s) to ${memoryFile.path}`,
        );
        continue;
      }
      // Several skills may share one extract only when their removals were merged into a
      // single measured change - a merged change cannot be accepted in halves, so that
      // grouping is the measurement's, not the model's. Skills whose removals were measured
      // separately stay separately decidable.
      if (created.length > 1 && hunks.length > 1) {
        violations.push(
          `edit ${edit.id}: groups ${created.length} created skills against ${hunks.length} separate changes to ` +
            `${memoryFile.path} (${hunks.map((h) => h.id).join(", ")}); give each skill its own extract, or group ` +
            `several skills only when they share one measured change`,
        );
        continue;
      }
      const unusable = created.find((c) => !c.skill);
      if (unusable) {
        violations.push(`edit ${edit.id}: ${unusable.file} needs YAML frontmatter with \`name:\` and \`description:\``);
        continue;
      }
    } else if (created.length) {
      violations.push(`edit ${edit.id}: only kind "extract" may include a created file (${created[0].id})`);
      continue;
    }

    // An addition is measured, not declared: text that only goes in is a new instruction.
    const onlyAdds = hunks.every((h) => h.removed === 0);
    if (edit.kind !== "extract" && onlyAdds && edit.transcripts < config.minGapEvidence) {
      violations.push(
        `edit ${edit.id} ("${edit.title}") adds a new instruction backed by ${edit.transcripts} session(s); ` +
          `${config.minGapEvidence} are required`,
      );
      continue;
    }

    const file = files[0];
    const proposed = {
      id: edit.id,
      kind: edit.kind,
      file,
      title: edit.title,
      rationale: edit.rationale,
      instructions: edit.instructions,
      evidence: edit.evidence,
      transcripts: edit.transcripts,
      skills: created.map((c) => c.skill),
      hunks: hunks.map((h) => ({
        id: h.id,
        find: h.find,
        replace: h.replace,
        oldStart: h.oldStart,
        oldEnd: h.oldEnd,
        removed: h.removed,
        added: h.added,
        lines: h.lines,
      })),
      targetsMemoryFile: file === memoryFile.path,
    };

    if (isSuppressed(proposed, rejections)) {
      // Rejections are respected until materially new evidence arrives (captain tweak 3).
      continue;
    }
    accepted.push(proposed);
  }

  // Deltas are measured here, never taken from the model.
  const running = new Map();
  for (const edit of accepted) {
    const before =
      running.get(edit.file) ?? (edit.targetsMemoryFile ? memoryFile.text : (measured.originals?.get(edit.file) ?? ""));
    let next;
    try {
      next = applyEdit(before, edit);
    } catch (err) {
      violations.push(err.message);
      edit.applicable = false;
      edit.deltaTokens = 0;
      continue;
    }
    edit.applicable = true;
    edit.deltaTokens = estimateTokens(next) - estimateTokens(before);
    running.set(edit.file, next);
  }

  const projectedText = running.get(memoryFile.path) ?? memoryFile.text;
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

  const gate = budgetGateKind(budget);
  if (gate === "cap") {
    violations.push(
      `applying every proposed edit leaves ${memoryFile.path} at ${budget.projected} tokens, ` +
        `${budget.over} over the ${config.budgetTokens}-token budget`,
    );
  } else if (gate === "shrink") {
    violations.push(
      `${memoryFile.path} is already ${budget.current - config.budgetTokens} tokens over the ` +
        `${config.budgetTokens}-token budget, so this run must shrink it, but the proposed edits ` +
        `change it by ${budget.delta >= 0 ? "+" : ""}${budget.delta} tokens`,
    );
  }

  for (const file of measured.stray || [])
    notes.push(`ignored ${file}: synthesis wrote it outside the memory file and skills`);

  const proposal = {
    version: 2,
    tool: "backpass",
    generatedAt: new Date().toISOString(),
    repo: { name: repo.name, root: repo.root },
    memoryFile: { path: memoryFile.path, hash: memoryFile.hash, tokens: memoryFile.tokens },
    budget,
    config: {
      budgetTokens: config.budgetTokens,
      maxEditsPerRun: maxEdits,
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
      skillExtractions: accepted.reduce((n, e) => n + editSkills(e).length, 0),
    },
    edits: accepted,
    verdicts: Array.isArray(rawResult?.verdicts) ? rawResult.verdicts : [],
    notes,
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
