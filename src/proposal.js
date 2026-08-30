import { renderHunkLines } from "./diff.js";
import { mixFromCounts } from "./interaction.js";
import { memoryTextHash } from "./memory.js";
import { editSkills, parseFrontmatter, skillDescriptionTokens } from "./skills.js";
import { budgetGateKind, budgetStatus, estimateTokens } from "./tokens.js";
import { isSkillFilePath, normalizeRecoveryLine, recoveredLineCounts } from "./workspace.js";

/**
 * The proposal model: what a synthesis pass is allowed to produce, and the mechanical
 * gates it must clear before a human ever sees it (design sections 3, 6, 7). The
 * budget gate (`budgetGateKind`) runs again on the accepted subset at apply.
 *
 * The synthesis agent edits a staging copy of the memory file and project skills natively
 * (`src/workspace.js`); backpass measures the result as anchored hunks (`src/diff.js`)
 * and the agent annotates them - kind, title, rationale, evidence - by id. An edit is
 * therefore a group of measured changes, normally against one file (an extract also
 * includes its destination skill files):
 *
 *   add      only inserts text                  (gated like a new instruction)
 *   remove   only deletes text
 *   rewrite  replaces text
 *   extract  memory-file change(s) + the SKILL.md file(s) they pay for
 *            (created, or an existing skill that still has every prior line plus
 *            every line the memory hunks remove)
 *   move     memory-file change(s) whose normalized removed and added line
 *            multisets match exactly - repositioning, not deletion or addition
 *
 * Each hunk carries a `find`/`replace` pair copied out of the original file by
 * construction; `find` occurs exactly once there. That is what the writer applies later,
 * against whatever the file is by then: anything that no longer matches is rejected
 * rather than guessed at - a memory file is not something to fuzzy-patch.
 */

export const EDIT_KINDS = ["add", "remove", "rewrite", "extract", "move"];

/** Kinds whose deletions stay on the always-loaded surface, so the harm floor does not apply. */
function preservesAlwaysLoaded(kind) {
  return kind === "extract" || kind === "move";
}

/** Every file an edit's hunks touch. Created skills are not hunks; they live on `edit.skills`. */
export function filesOfEdit(edit) {
  if (Array.isArray(edit.hunks) && edit.hunks.length) {
    return [...new Set(edit.hunks.map((hunk) => hunk.file || edit.file).filter(Boolean))];
  }
  return edit.file ? [edit.file] : [];
}

/** The subset of an edit that applies to one file, or null when that file is not a target. */
export function sliceEditForFile(edit, file) {
  if (!Array.isArray(edit.hunks)) return edit.file === file ? edit : null;
  const hunks = edit.hunks.filter((hunk) => (hunk.file || edit.file) === file);
  if (!hunks.length) return null;
  return { ...edit, file, hunks };
}

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

export function effectiveMaxEdits(memoryFile, config, alwaysLoadedExtraTokens = 0) {
  if (Number.isInteger(config.maxEditsPerRun) && config.maxEditsPerRun > 0) return config.maxEditsPerRun;
  const overage = memoryFile.tokens + alwaysLoadedExtraTokens - config.budgetTokens;
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
   *   saved?: { attempt: number, violations: string[], notes?: string[] } | null, proposalPath?: string | null }} [detail]
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

/** The del-line texts of a hunk that are not carried by `lineCounts` (blank lines ignored). */
function unrecoveredRemovedLines(hunk, lineCounts) {
  const missing = [];
  for (const line of hunk.lines || []) {
    if (line.type !== "del") continue;
    const normalized = normalizeRecoveryLine(line.text);
    if (!normalized) continue;
    const remaining = lineCounts.get(normalized) || 0;
    if (remaining > 0) lineCounts.set(normalized, remaining - 1);
    else missing.push(line.text);
  }
  return missing;
}

/**
 * The memory units a pure-removal hunk deletes. For a pure removal every file line in
 * [oldStart, oldEnd] is removed, so this is a plain range intersection with unit lines.
 */
function unitsRemovedBy(hunk, memoryFile) {
  return memoryFile.units.filter((unit) => unit.startLine <= hunk.oldEnd && unit.endLine >= hunk.oldStart);
}

/**
 * One edit's always-loaded cost outside the memory file, measured from the real texts:
 * an extract pays for the description line(s) of the skills it creates, and an edit to
 * an existing skill pays (or earns) the change to its `description:` line. Everything
 * else in a skill file is body - loaded on trigger, never billed here.
 */
function descriptionLineDelta(before, next) {
  return (
    estimateTokens(parseFrontmatter(next).description || "") -
    estimateTokens(parseFrontmatter(before).description || "")
  );
}

function createdDescriptionCost(edit) {
  return editSkills(edit).reduce((sum, skill) => sum + estimateTokens(skill.description || ""), 0);
}

function changedLineCounts(hunks, type) {
  return recoveredLineCounts(
    hunks.flatMap((hunk) => (hunk.lines || []).filter((line) => line.type === type).map((line) => line.text)),
  );
}

function firstLineCountMismatch(left, right) {
  for (const line of new Set([...left.keys(), ...right.keys()])) {
    if ((left.get(line) || 0) !== (right.get(line) || 0)) return line;
  }
  return null;
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
    skillFiles = [],
  } = context;

  const violations = [];
  const notes = Array.isArray(rawResult?.notes) ? rawResult.notes.map(String) : [];
  const rawEdits = Array.isArray(rawResult?.edits) ? rawResult.edits : [];
  const edits = rawEdits.map((raw, i) => normalizeEdit(raw, i));
  const changesById = new Map(measured.changes.map((c) => [c.id, c]));

  // Skill description lines are always loaded, so they sit under the same cap as the
  // memory file: one always-loaded budget, per the captain's ruling.
  const descriptionTokensNow = skillDescriptionTokens(skillFiles);
  const maxEdits = effectiveMaxEdits(memoryFile, config, descriptionTokensNow);
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
    if (!edit.evidence.length) {
      violations.push(`edit ${edit.id} ("${edit.title}") carries no verbatim evidence quote`);
      continue;
    }

    const skillsDir = config.skillDirs || config.skillsDir;
    const memoryHunks = hunks.filter((hunk) => hunk.file === memoryFile.path);
    const otherHunks = hunks.filter((hunk) => hunk.file !== memoryFile.path);
    const destFiles = [...new Set(otherHunks.map((hunk) => hunk.file))];

    if (edit.kind === "extract") {
      if (!memoryHunks.length || (!created.length && !destFiles.length)) {
        violations.push(
          `edit ${edit.id}: kind "extract" must group SKILL.md file(s) (created or extended) with change(s) to ${memoryFile.path}`,
        );
        continue;
      }
      const hasMemoryRemoval = memoryHunks.some((hunk) => hunk.removed > 0);
      if (!hasMemoryRemoval) {
        if (edit.transcripts < config.minGapEvidence) {
          violations.push(
            `edit ${edit.id} ("${edit.title}") adds a new instruction backed by ${edit.transcripts} session(s); ` +
              `${config.minGapEvidence} are required`,
          );
        } else {
          violations.push(`edit ${edit.id}: kind "extract" must remove text from ${memoryFile.path}`);
        }
        continue;
      }
      const notSkill = destFiles.find((file) => !isSkillFilePath(file, skillsDir));
      if (notSkill) {
        violations.push(
          `edit ${edit.id} ("${edit.title}") changes ${notSkill}; an extract only extends a skill file alongside ${memoryFile.path}`,
        );
        continue;
      }
      // Several skills may share one extract only when their removals were merged into a
      // single measured change - a merged change cannot be accepted in halves, so that
      // grouping is the measurement's, not the model's. Skills whose removals were measured
      // separately stay separately decidable.
      const skillCount = created.length + destFiles.length;
      if (skillCount > 1 && memoryHunks.length > 1) {
        const grouped = destFiles.length ? `${skillCount} skills` : `${created.length} created skills`;
        violations.push(
          `edit ${edit.id}: groups ${grouped} against ${memoryHunks.length} separate changes to ` +
            `${memoryFile.path} (${memoryHunks.map((h) => h.id).join(", ")}); give each skill its own extract, or group ` +
            `several skills only when they share one measured change`,
        );
        continue;
      }
      const unusable = created.find((c) => !c.skill);
      if (unusable) {
        violations.push(`edit ${edit.id}: ${unusable.file} needs YAML frontmatter with \`name:\` and \`description:\``);
        continue;
      }
      // Extending an existing skill must not drop what was already there: the staged file
      // still contains every prior line, then the extracted lines on top of that.
      let droppedPrior = null;
      for (const file of destFiles) {
        const original = measured.originals?.get(file) ?? "";
        const staged = measured.texts?.get(file) ?? "";
        const missingPrior = unrecoveredRemovedLines(
          {
            lines: String(original)
              .split("\n")
              .map((text) => ({ type: "del", text })),
          },
          recoveredLineCounts([staged]),
        );
        if (missingPrior.length) {
          droppedPrior = missingPrior[0];
          break;
        }
      }
      if (droppedPrior) {
        violations.push(
          `edit ${edit.id} ("${edit.title}") drops text the existing skill already had ` +
            `(first: "${droppedPrior.trim().slice(0, 80)}"); extending a skill keeps every line it had`,
        );
        continue;
      }
      // An extraction moves text; it never doubles as a deletion. Every line its memory
      // hunks remove must land in the skills it creates or extends - a real deletion goes
      // in its own remove edit, where the removal-evidence floor below can judge it.
      const destTexts = [...created.map((c) => c.text), ...destFiles.map((file) => measured.texts?.get(file) ?? "")];
      const carried = recoveredLineCounts(destTexts);
      for (const file of destFiles) {
        unrecoveredRemovedLines(
          {
            lines: String(measured.originals?.get(file) ?? "")
              .split("\n")
              .map((text) => ({ type: "del", text })),
          },
          carried,
        );
      }
      const missing = memoryHunks.flatMap((h) => unrecoveredRemovedLines(h, carried));
      if (missing.length) {
        violations.push(
          `edit ${edit.id} ("${edit.title}") removes text its skill(s) do not carry ` +
            `(first: "${missing[0].trim().slice(0, 80)}"); an extraction preserves every line it removes - ` +
            `revert that text, or make its deletion a separate "remove" edit`,
        );
        continue;
      }
    } else if (created.length) {
      violations.push(`edit ${edit.id}: only kind "extract" may include a created file (${created[0].id})`);
      continue;
    } else if (files.length > 1) {
      violations.push(`edit ${edit.id} ("${edit.title}") changes ${files.join(" and ")}; an edit changes one file`);
      continue;
    }

    if (edit.kind === "move") {
      if (!memoryHunks.length || destFiles.length || files[0] !== memoryFile.path) {
        violations.push(`edit ${edit.id}: kind "move" must be change(s) to ${memoryFile.path} only`);
        continue;
      }
      const hasRemoval = memoryHunks.some((hunk) => hunk.removed);
      const hasAddition = memoryHunks.some((hunk) => hunk.added);
      if (!hasRemoval || !hasAddition) {
        violations.push(
          `edit ${edit.id} ("${edit.title}") is not a move: a move both removes text and re-adds it verbatim elsewhere in ${memoryFile.path}`,
        );
        continue;
      }
      const removed = changedLineCounts(memoryHunks, "del");
      const added = changedLineCounts(memoryHunks, "ins");
      const mismatch = firstLineCountMismatch(removed, added);
      if (mismatch) {
        violations.push(
          `edit ${edit.id} ("${edit.title}") removes text that does not reappear verbatim one-for-one in the same edit ` +
            `(first mismatch: "${mismatch.slice(0, 80)}"); a move's removed and added lines must match exactly - ` +
            `revert that text, or use a different edit kind`,
        );
        continue;
      }
    }

    // An addition is measured, not declared: text that only goes in is a new instruction.
    const onlyAdds = hunks.every((h) => h.removed === 0);
    if (!preservesAlwaysLoaded(edit.kind) && onlyAdds && edit.transcripts < config.minGapEvidence) {
      violations.push(
        `edit ${edit.id} ("${edit.title}") adds a new instruction backed by ${edit.transcripts} session(s); ` +
          `${config.minGapEvidence} are required`,
      );
      continue;
    }

    // A removal is measured the same way: a hunk that only deletes text, outside an
    // extraction or move, deletes instructions - whatever the edit's kind says. Deleting
    // an instruction needs the same corroboration adding one does, and only negatives the
    // analysis classified as `harm` (following the rule caused damage) count toward it.
    // Non-compliance is the rule failing to steer; it never justifies deletion. This is
    // the removal-evidence floor; the >= 20%-relevance placement table stays guidance.
    if (!preservesAlwaysLoaded(edit.kind) && files[0] === memoryFile.path) {
      const rows = new Map((summary?.instructions ?? []).map((row) => [row.instruction, row]));
      const unsupported = [];
      for (const hunk of hunks) {
        if (!hunk.removed || hunk.added) continue;
        for (const unit of unitsRemovedBy(hunk, memoryFile)) {
          const harm = rows.get(unit.id)?.harmSessions ?? 0;
          if (harm < config.minGapEvidence) unsupported.push({ unit, harm });
        }
      }
      if (unsupported.length) {
        const worst = unsupported[0];
        violations.push(
          `edit ${edit.id} ("${edit.title}") deletes [${worst.unit.id}] "${worst.unit.text.slice(0, 80)}" backed by ` +
            `${worst.harm} session(s) of harm-class negative evidence; removing an instruction needs ` +
            `${config.minGapEvidence}, and non-compliance never counts - revert the deletion` +
            (unsupported.length > 1 ? ` (${unsupported.length} unit(s) affected)` : ""),
        );
        continue;
      }
    }

    // The same floor covers every other staged file. Evidence cannot attribute to
    // skill-file text at all - there are no instruction ids for it - so no pure
    // deletion there can reach the harm bar, whatever the edit is called. Rewrites
    // (a hunk that also adds text) stay possible; only vanishing text is refused.
    if (!preservesAlwaysLoaded(edit.kind) && files[0] !== memoryFile.path) {
      const deleted = hunks
        .filter((hunk) => hunk.removed && !hunk.added)
        .flatMap((hunk) => (hunk.lines || []).filter((line) => line.type === "del").map((line) => line.text))
        .filter((text) => text.trim());
      if (deleted.length) {
        violations.push(
          `edit ${edit.id} ("${edit.title}") deletes "${deleted[0].trim().slice(0, 80)}" from ${files[0]}; ` +
            `no evidence can attribute to skill files, so no deletion there clears the ` +
            `${config.minGapEvidence}-session harm floor - revert the deletion`,
        );
        continue;
      }
    }

    const file = memoryHunks.length ? memoryFile.path : files[0];
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
        file: h.file,
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

  // Deltas are measured here, never taken from the model. `descriptionDelta` is the
  // edit's always-loaded cost outside the memory file: the change to a skill's
  // description line, or the description line(s) a created skill adds. Bodies stay
  // free-until-triggered and never enter it.
  const running = new Map();
  for (const edit of accepted) {
    const targets = filesOfEdit(edit);
    let memoryDelta = 0;
    let otherDelta = 0;
    let descriptionDelta = edit.kind === "extract" ? createdDescriptionCost(edit) : 0;
    try {
      for (const target of targets) {
        const slice = sliceEditForFile(edit, target);
        const before =
          running.get(target) ??
          (target === memoryFile.path ? memoryFile.text : (measured.originals?.get(target) ?? ""));
        const next = applyEdit(before, slice);
        running.set(target, next);
        const delta = estimateTokens(next) - estimateTokens(before);
        if (target === memoryFile.path) memoryDelta += delta;
        else {
          otherDelta += delta;
          if (isSkillFilePath(target, config.skillDirs || config.skillsDir)) {
            descriptionDelta += descriptionLineDelta(before, next);
          }
        }
      }
    } catch (err) {
      violations.push(err.message);
      edit.applicable = false;
      edit.deltaTokens = 0;
      edit.descriptionDelta = 0;
      continue;
    }
    edit.applicable = true;
    edit.deltaTokens = edit.targetsMemoryFile ? memoryDelta : otherDelta;
    edit.descriptionDelta = descriptionDelta;
  }

  const projectedText = running.get(memoryFile.path) ?? memoryFile.text;
  const descriptionTokensProjected =
    descriptionTokensNow + accepted.reduce((sum, edit) => sum + (edit.descriptionDelta || 0), 0);
  const budget = budgetStatus(memoryFile.text, projectedText, config.budgetTokens, {
    current: descriptionTokensNow,
    projected: descriptionTokensProjected,
  });

  /**
   * The budget gate has two modes (design section 6).
   *
   * Normally the post-edit always-loaded surface must fit the budget. But a surface that
   * is ALREADY over budget cannot be brought under it in one capped step - demanding that
   * would fail every run on exactly the repos that need backpass most. There, the run is a shrink
   * plan and the gate is progress: the edit set must be strictly net-negative.
   */
  budget.mode = memoryFile.tokens + descriptionTokensNow > config.budgetTokens ? "shrink" : "cap";
  budget.startedOverBudget = budget.mode === "shrink";
  // For displays: how much of `current` is the skill layer, so a surface number is
  // never presented as if it measured the file alone.
  budget.descriptionTokens = descriptionTokensNow;

  // With skills present the gated number is the surface, not the file alone; name what
  // the number actually measures.
  const surfaceLabel =
    descriptionTokensNow || descriptionTokensProjected !== descriptionTokensNow
      ? `the always-loaded surface (${memoryFile.path} + skill descriptions)`
      : memoryFile.path;
  const gate = budgetGateKind(budget);
  if (gate === "cap") {
    violations.push(
      `applying every proposed edit leaves ${surfaceLabel} at ${budget.projected} tokens, ` +
        `${budget.over} over the ${config.budgetTokens}-token budget`,
    );
  } else if (gate === "shrink") {
    violations.push(
      `${surfaceLabel} is already ${budget.current - config.budgetTokens} tokens over the ` +
        `${config.budgetTokens}-token budget, so this run must shrink it, but the proposed edits ` +
        `change it by ${budget.delta >= 0 ? "+" : ""}${budget.delta} tokens`,
    );
  }

  for (const file of measured.stray || [])
    notes.push(`ignored ${file}: synthesis wrote it outside the memory file and skills`);

  // Every non-memory file an accepted edit targets, with the fingerprint of the exact
  // image its hunks were cut from. The writer re-checks these before composing, the
  // same freshness contract `memoryFileSnapshot` gives the memory file - a skill file
  // that changed after the proposal must refuse the apply, never be patched blind.
  const targetFiles = [
    ...new Set(accepted.flatMap((edit) => filesOfEdit(edit).filter((file) => file !== memoryFile.path))),
  ]
    .filter((file) => measured.originals?.has(file))
    .map((file) => ({ file, hash: memoryTextHash(measured.originals.get(file)) }));

  const proposal = {
    version: 2,
    tool: "backpass",
    generatedAt: new Date().toISOString(),
    repo: { name: repo.name, root: repo.root },
    memoryFile: { path: memoryFile.path, hash: memoryFile.hash, tokens: memoryFile.tokens },
    targetFiles,
    budget,
    config: {
      budgetTokens: config.budgetTokens,
      maxEditsPerRun: maxEdits,
      minGapEvidence: config.minGapEvidence,
      skillsDir: config.skillsDir,
      skillDirs: config.skillDirs,
      analysis: config.analysis,
      synthesis: config.synthesis,
    },
    stats: {
      transcripts: summary?.analyzedSessions ?? 0,
      corpusMix: mixFromCounts(summary?.analyzedByInteraction, summary?.analyzedSessions),
      harnessCounts,
      positive: summary?.totals?.positive ?? 0,
      negative: summary?.totals?.negative ?? 0,
      gapClusters: summary?.totals?.gapClusters ?? 0,
      // The gap funnel, for the apply surface: sightings -> project-domain (sightings
      // minus orchestration) -> distinct gaps (clusters + dropped) -> eligible
      // (clusters). `null`, never 0, when the summary predates a count - the surface
      // hides what was not recorded rather than showing an invented zero.
      gapSightings: summary?.totals?.gapSightings ?? null,
      orchestrationGapSightings: summary?.totals?.orchestrationGapSightings ?? null,
      droppedGapSingletons: summary?.totals?.droppedGapSingletons ?? null,
      skillExtractions: accepted.reduce((n, e) => {
        if (e.kind !== "extract") return n;
        const createdSkills = editSkills(e).length;
        const extended = new Set(filesOfEdit(e).filter((file) => file !== memoryFile.path)).size;
        return n + createdSkills + extended;
      }, 0),
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
 * `descriptionTokensCurrent` is the always-loaded skill layer measured by the caller
 * (the descriptions on disk at apply time); each accepted edit's measured
 * `descriptionDelta` moves it, so the budget describes the whole surface.
 */
export function projectWithDecisions(memoryText, edits, acceptedIds, capTokens, descriptionTokensCurrent = 0) {
  const chosen = edits.filter((e) => acceptedIds.includes(e.id) && e.targetsMemoryFile && e.applicable !== false);
  let text = memoryText;
  for (const edit of chosen) {
    try {
      const slice = sliceEditForFile(edit, edit.file) ?? edit;
      text = applyEdit(text, slice);
    } catch {
      // Skip an edit that no longer applies; the writer reports it.
    }
  }
  const descriptionDelta = edits
    .filter((e) => acceptedIds.includes(e.id) && e.applicable !== false)
    .reduce((sum, e) => sum + (e.descriptionDelta || 0), 0);
  return {
    text,
    budget: budgetStatus(memoryText, text, capTokens, {
      current: descriptionTokensCurrent,
      projected: descriptionTokensCurrent + descriptionDelta,
    }),
  };
}
