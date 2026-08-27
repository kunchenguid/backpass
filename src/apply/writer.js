import fs from "node:fs";
import path from "node:path";

import { applyEdit, projectWithDecisions } from "../proposal.js";
import { memoryTextHash } from "../memory.js";
import { budgetGateKind, budgetStatus, formatTokens } from "../tokens.js";
import { recordRejection } from "../state.js";
import { writeSkill } from "../skills.js";

function acceptedSubsetBudgetFailure({ proposal, accepted, repo, capTokens, memoryText }) {
  if (!accepted.length) return null;

  const relative = proposal.memoryFile.path;
  const absolute = path.join(repo.root, relative);
  if (memoryText === null && !fs.existsSync(absolute)) return null;

  const before = memoryText ?? fs.readFileSync(absolute, "utf8");
  const { budget } = projectWithDecisions(
    before,
    accepted,
    accepted.map((edit) => edit.id),
    capTokens,
  );
  const gate = budgetGateKind(budget);
  if (gate === "cap") {
    return {
      file: relative,
      error:
        `accepted edits leave ${relative} at ${budget.projected} tokens, ${budget.over} over the ` +
        `${capTokens}-token budget; choose a compatible set of edits`,
    };
  }
  if (gate === "shrink") {
    return {
      file: relative,
      error:
        `${relative} is already ${budget.current - capTokens} tokens over the ${capTokens}-token budget, ` +
        `so accepted edits must shrink it, but they change it by ${budget.delta >= 0 ? "+" : ""}${budget.delta} ` +
        "tokens; choose a compatible set of edits",
    };
  }
  return null;
}

/**
 * Freshness before mutation.
 *
 * Every hunk was cut from one exact image of the memory file, and the proposal records
 * that image's hash. If the file has disappeared or changed since - an upstream merge,
 * a hand edit, another agent - then the hunks describe text that may no longer exist, and the ones
 * that still happen to match would leave the file half-descended: part of a shrink plan
 * applied against a file the plan was never measured against. So the run is refused
 * before it writes anything, and the fix is to re-measure, not to salvage.
 *
 * A proposal saved before this field existed carries no hash and is left alone.
 */
function memoryFileSnapshot(proposal, repo) {
  const expected = proposal.memoryFile?.hash;
  const relative = proposal.memoryFile?.path;
  if (!relative) return { text: null };

  const absolute = path.join(repo.root, relative);
  if (!fs.existsSync(absolute)) {
    if (!expected) return { text: null };
    return {
      text: null,
      failure: {
        file: relative,
        error:
          `${relative} no longer exists, so its edits no longer describe the file on disk; nothing was written. ` +
          `Run \`backpass\` to re-propose against the current repository.`,
      },
    };
  }

  const text = fs.readFileSync(absolute, "utf8");
  if (!expected) return { text };

  const observed = memoryTextHash(text);
  if (observed === expected) return { text };

  return {
    text,
    failure: {
      file: relative,
      error:
        `${relative} changed after this proposal was made (${expected} -> ${observed}), so its edits ` +
        `no longer describe the file on disk; nothing was written. Run \`backpass\` to re-propose ` +
        `against the current ${relative}.`,
    },
  };
}

function overBudgetWarning(relative, budget) {
  return (
    `${relative} is still ${formatTokens(budget.over)} tokens over the ${formatTokens(budget.capTokens)}-token ` +
    "budget; run `backpass` again for the next shrink step"
  );
}

/**
 * The only place in backpass that writes to the repo.
 *
 * Everything upstream is read-only analysis; a run only changes the weights here, after
 * a human accepted specific edits. Three gates run before the first byte is written:
 * the memory file must still be the file the proposal was measured against
 * (`memoryFileSnapshot`), the accepted subset must clear the same cap/shrink budget gate as
 * the full proposal (`budgetGateKind`), and every accepted edit for a file must compose
 * against that file's single pre-write image. Any of them failing writes nothing and
 * records no rejection.
 *
 * A file is therefore applied all at once or not at all. Skills are written only after
 * every accepted edit has composed, and before the files that reference them.
 */
export function applyDecisions({ proposal, decisions, repo, state, config, dryRun = false }) {
  const accepted = proposal.edits.filter((e) => decisions[e.id] === "accepted");
  const rejected = proposal.edits.filter((e) => decisions[e.id] === "rejected");

  const byFile = new Map();
  const results = {
    written: [],
    skills: [],
    failed: [],
    warnings: [],
    accepted: accepted.length,
    rejected: rejected.length,
    rejectionsRecorded: false,
  };

  let memoryText = null;
  if (accepted.length || rejected.length) {
    const snapshot = memoryFileSnapshot(proposal, repo);
    if (snapshot.failure) {
      results.failed.push(snapshot.failure);
      return results;
    }
    memoryText = snapshot.text;
  }

  const budgetFailure = acceptedSubsetBudgetFailure({
    proposal,
    accepted,
    repo,
    capTokens: config.budgetTokens,
    memoryText,
  });
  if (budgetFailure) {
    results.failed.push(budgetFailure);
    return results;
  }

  for (const edit of accepted) {
    if (!byFile.has(edit.file)) byFile.set(edit.file, []);
    byFile.get(edit.file).push(edit);
  }

  // Compose first, write later. Each file's accepted edits are applied to one immutable
  // image of that file; only a set that composes completely earns a write.
  const planned = [];
  const landed = new Set();

  for (const [relative, edits] of byFile) {
    const absolute = path.join(repo.root, relative);
    if (!fs.existsSync(absolute)) {
      results.failed.push({ file: relative, error: "file does not exist" });
      continue;
    }

    const before =
      relative === proposal.memoryFile?.path && memoryText !== null ? memoryText : fs.readFileSync(absolute, "utf8");
    let text = before;
    const applied = [];
    const failures = [];

    for (const edit of edits) {
      try {
        text = applyEdit(text, edit);
        applied.push(edit.id);
      } catch (err) {
        failures.push({ file: relative, edit: edit.id, error: err.message });
      }
    }

    if (failures.length) {
      results.failed.push(...failures);
      if (applied.length) {
        results.failed.push({
          file: relative,
          error: `${relative} was left unchanged: a file takes every accepted edit or none of them`,
        });
      }
      continue;
    }

    if (text === before) continue;
    planned.push({ relative, absolute, before, text, applied });
    for (const id of applied) landed.add(id);
  }

  if (results.failed.length) return results;

  // Skills go in before the memory file. A skill nothing points at yet is inert, while a
  // memory file pointing at a skill that is not there is actively wrong - so if a skill
  // cannot be written, the files that would reference it are left alone.
  const skillFailures = [];
  const writtenSkillPaths = [];
  for (const edit of accepted) {
    if (edit.kind !== "extract" || !edit.skill) continue;
    if (!landed.has(edit.id)) continue;
    try {
      const layout = dryRun ? { created: [], warnings: [] } : writeSkill(repo.root, edit.skill);
      results.skills.push({ path: edit.skill.path, dryRun, created: layout.created });
      if (!dryRun) writtenSkillPaths.push(edit.skill.path);
      for (const w of layout.warnings) if (!results.warnings.includes(w)) results.warnings.push(w);
    } catch (err) {
      skillFailures.push({ file: edit.skill.path, edit: edit.id, error: err.message });
    }
  }

  if (skillFailures.length) {
    results.failed.push(...skillFailures);
    if (writtenSkillPaths.length) {
      results.failed.push({
        error: `skill paths already written in this round: ${writtenSkillPaths.join(", ")}; remove them before retrying`,
      });
    }
    for (const { relative } of planned) {
      results.failed.push({
        file: relative,
        error: `${relative} was left unchanged: its edits point at a skill that could not be written`,
      });
    }
    return results;
  }

  for (const { relative, absolute, before, text, applied } of planned) {
    const budget = relative === proposal.memoryFile.path ? budgetStatus(before, text, config.budgetTokens) : null;

    if (!dryRun) fs.writeFileSync(absolute, text);
    results.written.push({ file: relative, edits: applied, budget, dryRun });

    // Shrinking over several runs is the design, so this is a heading, not a failure.
    if (budget && !budget.withinBudget) results.warnings.push(overBudgetWarning(relative, budget));
  }

  // Rejections are remembered so the same edit is not re-proposed without new evidence.
  if (!dryRun && rejected.length) {
    const rejections = state.readRejections();
    for (const edit of rejected) recordRejection(edit, rejections);
    state.writeRejections(rejections);
    results.rejectionsRecorded = true;
  }

  return results;
}

/**
 * Seed a repo that has no memory file: the canonical file plus the pointer. Each file
 * is created only if absent - bootstrap never overwrites, so a pre-existing file (say a
 * CLAUDE.md the user wrote while a run was in flight) is reported, not replaced.
 */
export function writeBootstrapFiles(repoRoot, files) {
  const results = { written: [], skipped: [] };
  for (const { path: relative, text } of files) {
    const absolute = path.join(repoRoot, relative);
    if (fs.existsSync(absolute)) {
      results.skipped.push({ file: relative, reason: "already exists" });
      continue;
    }
    fs.writeFileSync(absolute, text, { flag: "wx" });
    results.written.push({ file: relative, bytes: Buffer.byteLength(text, "utf8") });
  }
  return results;
}
