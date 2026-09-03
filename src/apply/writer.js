import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { applyEdit, filesOfEdit, sliceEditForFile } from "../proposal.js";
import { memoryTextHash, resolveMemoryPath } from "../memory.js";
import { userClaudeSkillsDir } from "../config.js";
import { budgetGateKind, budgetStatus, estimateTokens, formatTokens } from "../tokens.js";
import { recordRejection } from "../state.js";
import {
  CANONICAL_SKILLS_DIR,
  CLAUDE_SKILLS_LINK,
  editSkills,
  ensureSkillsLayout,
  loadProjectSkills,
  parseFrontmatter,
  removeOwnedSkillPaths,
  resolveOverflowTarget,
  skillDescriptionTokens,
  writeSkill,
} from "../skills.js";

/**
 * The always-loaded label a budget number carries: the surface when skill descriptions
 * are part of the count, the bare file when there are none - a number shown to a person
 * must describe the thing it measures.
 */
function resolveTarget(root, relative) {
  if (!relative) return relative;
  return path.isAbsolute(relative) ? relative : path.join(root, relative);
}

/** Named refusal when a user-level target is a symlink into a read-only store. */
export function readOnlySymlinkMessage(absolute, realPath) {
  return `${absolute} is a symlink to ${realPath}, which is not writable; edit the source that generates it`;
}

function refuseReadOnlySymlink(absolute) {
  let lstat;
  try {
    lstat = fs.lstatSync(absolute);
  } catch {
    return null;
  }
  if (!lstat.isSymbolicLink()) return null;
  let real;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    return null;
  }
  try {
    fs.accessSync(real, fs.constants.W_OK);
    fs.accessSync(path.dirname(real), fs.constants.W_OK | fs.constants.X_OK);
    return null;
  } catch {
    return readOnlySymlinkMessage(absolute, real);
  }
}

function surfaceLabel(memoryPath, descriptionTokens) {
  return descriptionTokens ? `the always-loaded surface (${memoryPath} + skill descriptions)` : memoryPath;
}

function descriptionTokensIn(text) {
  return estimateTokens(parseFrontmatter(text).description || "");
}

function acceptedSubsetBudgetFailure({
  proposal,
  capTokens,
  memoryText,
  projectedMemoryText,
  descriptionTokensNow,
  descriptionTokensProjected,
}) {
  const relative = proposal.memoryFile.path;
  if (memoryText === null) return null;

  const budget = budgetStatus(memoryText, projectedMemoryText, capTokens, {
    current: descriptionTokensNow,
    projected: descriptionTokensProjected,
  });
  const label = surfaceLabel(relative, Math.max(descriptionTokensNow, descriptionTokensProjected));
  const gate = budgetGateKind(budget);
  if (gate === "cap") {
    return {
      file: relative,
      error:
        `accepted edits leave ${label} at ${budget.projected} tokens, ${budget.over} over the ` +
        `${capTokens}-token budget; choose a compatible set of edits`,
    };
  }
  if (gate === "shrink") {
    return {
      file: relative,
      error:
        `${label} is already ${budget.current - capTokens} tokens over the ${capTokens}-token budget, ` +
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

  const absolute = resolveTarget(repo.root, relative);
  const blocked = refuseReadOnlySymlink(absolute);
  if (blocked) {
    return { text: null, failure: { file: relative, error: blocked } };
  }
  if (!fs.existsSync(absolute)) {
    if (!expected) return { text: null };
    return {
      text: null,
      failure: {
        file: relative,
        error:
          `${relative} no longer exists, so its edits no longer describe the file on disk; nothing was written. ` +
          `Run \`backpass\` to re-propose against the current repository - that pass reanalyzes transcripts ` +
          `against the file that exists now, it does not reuse the judgments behind this proposal.`,
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
        `against the current ${relative} - that pass reanalyzes transcripts against the new file, it does ` +
        `not reuse the stale judgments behind this proposal.`,
    },
  };
}

function overBudgetWarning(label, budget) {
  return (
    `${label} is still ${formatTokens(budget.over)} tokens over the ${formatTokens(budget.capTokens)}-token ` +
    "budget; run `backpass` again for the next shrink step"
  );
}

function atomicReplace(target, text) {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.backpass-${randomUUID()}`);
  const mode = fs.statSync(target).mode & 0o7777;
  let fd;
  let ownership;
  try {
    fd = fs.openSync(temp, "wx");
    const stat = fs.fstatSync(fd);
    ownership = [{ absolute: temp, identity: { dev: stat.dev, ino: stat.ino } }];
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    return { absolute: target, identity: ownership[0].identity, text };
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
}

function commitStillCurrent(commit) {
  let stat;
  try {
    stat = fs.lstatSync(commit.absolute);
    if (stat.dev !== commit.identity.dev || stat.ino !== commit.identity.ino) return false;
    return fs.readFileSync(commit.absolute, "utf8") === commit.text;
  } catch {
    return false;
  }
}

function absentParentDirectories(root, files) {
  const directories = new Set();
  for (const file of files) {
    for (
      let current = path.dirname(file);
      current !== root && path.dirname(current) !== current;
      current = path.dirname(current)
    ) {
      if (!fs.existsSync(current)) directories.add(current);
    }
  }
  return [...directories].sort((a, b) => b.length - a.length);
}

function removeEmptyDirectories(directories) {
  for (const directory of directories) {
    try {
      fs.rmdirSync(directory);
    } catch {
      continue;
    }
  }
}

/**
 * The only place in backpass that writes to the repo.
 *
 * Everything upstream is read-only analysis; a run only changes the weights here, after
 * a human accepted specific edits. Before the first byte is written, the memory file and
 * every decided non-memory target must still be the files the proposal measured; the
 * accepted subset must clear the same cap/shrink budget gate as the full proposal
 * (`budgetGateKind`); every accepted edit for a file must compose against that file's
 * single pre-write image; every created skill target must still be absent; and accepted
 * paths must resolve to distinct targets. Any failure writes nothing and records no rejection.
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

  if ((proposal.scope || "project") === "project") {
    const targets = new Set([
      proposal.memoryFile?.path,
      ...[...accepted, ...rejected].flatMap((edit) => filesOfEdit(edit)),
      ...accepted.flatMap((edit) => editSkills(edit).map((skill) => skill.path)),
    ]);
    try {
      for (const target of targets) if (target) resolveMemoryPath(repo.root, target);
    } catch (err) {
      results.failed.push({ error: err.message });
      return results;
    }
  }

  let memoryText = null;
  if (accepted.length || rejected.length) {
    const snapshot = memoryFileSnapshot(proposal, repo);
    if (snapshot.failure) {
      results.failed.push(snapshot.failure);
      return results;
    }
    memoryText = snapshot.text;
  }

  // The always-loaded skill layer as it exists on disk right now - the budget below
  // covers the whole surface, not the memory file alone.
  const userScope = proposal.scope === "user";
  const claudeSkillsLink = userScope ? userClaudeSkillsDir() : CLAUDE_SKILLS_LINK;
  const skillsDir = resolveOverflowTarget(
    repo.root,
    proposal.config?.skillsDir || config.skillsDir || CANONICAL_SKILLS_DIR,
    { claudeSkillsDir: claudeSkillsLink },
  ).dir;
  const configuredSkillDirs = proposal.config?.skillsDirs || proposal.config?.skillDirs || config.skillsDirs || [];
  const skillsNow = loadProjectSkills(repo.root, skillsDir, configuredSkillDirs, { exact: userScope });
  const descriptionTokensNow = skillDescriptionTokens(skillsNow);

  // Freshness for every non-memory file a decision targets, the same contract the
  // memory file gets: each hunk was cut from one exact image, and a file that changed
  // since no longer contains what the proposal describes - refuse, never patch blind.
  // Proposals from before the field existed carry no hashes and are left alone.
  const expectedTargetHashes = new Map((proposal.targetFiles ?? []).map((t) => [t.file, t.hash]));
  const checkedTargets = new Set();
  for (const edit of [...accepted, ...rejected]) {
    for (const relative of filesOfEdit(edit)) {
      if (!relative || relative === proposal.memoryFile?.path || checkedTargets.has(relative)) continue;
      checkedTargets.add(relative);
      const expected = expectedTargetHashes.get(relative);
      if (!expected) continue;
      const absolute = resolveTarget(repo.root, relative);
      const blocked = refuseReadOnlySymlink(absolute);
      if (blocked) {
        results.failed.push({ file: relative, error: blocked });
        continue;
      }
      if (!fs.existsSync(absolute)) {
        results.failed.push({ file: relative, error: "file does not exist" });
        continue;
      }
      const observed = memoryTextHash(fs.readFileSync(absolute, "utf8"));
      if (observed !== expected) {
        results.failed.push({
          file: relative,
          error:
            `${relative} changed after this proposal was made (${expected} -> ${observed}), so its edits ` +
            `no longer describe the file on disk; nothing was written. Run \`backpass\` to re-propose ` +
            `against the current repository.`,
        });
      }
    }
  }
  if (results.failed.length) return results;

  for (const edit of accepted) {
    for (const relative of filesOfEdit(edit)) {
      const slice = sliceEditForFile(edit, relative);
      if (!slice) continue;
      if (!byFile.has(relative)) byFile.set(relative, []);
      byFile.get(relative).push(slice);
    }
  }

  // Compose first, write later. Each file's accepted edits are applied to one immutable
  // image of that file; only a set that composes completely earns a write.
  const planned = [];
  const landed = new Set();

  for (const [relative, edits] of byFile) {
    const absolute = resolveTarget(repo.root, relative);
    if (!fs.existsSync(absolute)) {
      results.failed.push({ file: relative, error: "file does not exist" });
      continue;
    }
    const blocked = refuseReadOnlySymlink(absolute);
    if (blocked) {
      results.failed.push({ file: relative, error: blocked });
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

  const plannedTargets = new Map();
  const resolvedPlanned = [];
  for (const item of planned) {
    let resolved;
    try {
      resolved = fs.realpathSync(item.absolute);
    } catch (err) {
      results.failed.push({ file: item.relative, error: `${item.relative} could not be resolved: ${err.message}` });
      continue;
    }
    const existing = plannedTargets.get(resolved);
    if (existing) {
      results.failed.push({
        file: item.relative,
        error: `${item.relative} resolves to the same target as ${existing.relative}; nothing was written`,
      });
      continue;
    }
    const resolvedItem = { ...item, resolved };
    plannedTargets.set(resolved, resolvedItem);
    resolvedPlanned.push(resolvedItem);
  }

  if (results.failed.length) return results;

  // Skills go in before the memory file. A skill nothing points at yet is inert, while a
  // memory file pointing at a skill that is not there is actively wrong - so if a skill
  // cannot be written, the files that would reference it are left alone.
  const plannedSkills = [];
  const skillPaths = new Set();
  for (const edit of accepted) {
    if (edit.kind !== "extract" || !landed.has(edit.id)) continue;
    for (const skill of editSkills(edit)) {
      const absolute = resolveTarget(repo.root, skill.path);
      if (skillPaths.has(skill.path) || fs.existsSync(absolute)) {
        results.failed.push({
          file: skill.path,
          edit: edit.id,
          error: `${skill.path} already exists; nothing was written`,
        });
      }
      skillPaths.add(skill.path);
      plannedSkills.push({ edit, skill });
    }
  }
  if (results.failed.length) return results;

  const existingSkillPaths = new Set(skillsNow.map((skill) => skill.path));
  let descriptionTokensProjected = descriptionTokensNow;
  for (const item of resolvedPlanned) {
    if (!existingSkillPaths.has(item.relative)) continue;
    descriptionTokensProjected += descriptionTokensIn(item.text) - descriptionTokensIn(item.before);
  }
  descriptionTokensProjected += plannedSkills.reduce(
    (sum, { skill }) => sum + estimateTokens(skill.description || ""),
    0,
  );
  const memoryPlan = resolvedPlanned.find((item) => item.relative === proposal.memoryFile.path);
  if (accepted.length) {
    const budgetFailure = acceptedSubsetBudgetFailure({
      proposal,
      capTokens: config.budgetTokens,
      memoryText,
      projectedMemoryText: memoryPlan?.text ?? memoryText,
      descriptionTokensNow,
      descriptionTokensProjected,
    });
    if (budgetFailure) {
      results.failed.push(budgetFailure);
      return results;
    }
  }

  const canonical = plannedSkills.find(
    ({ skill }) => skill.path === CANONICAL_SKILLS_DIR || skill.path.startsWith(`${CANONICAL_SKILLS_DIR}/`),
  );
  const createdDirectoryCandidates = absentParentDirectories(repo.root, [
    ...plannedSkills.map(({ skill }) => resolveTarget(repo.root, skill.path)),
    ...(canonical ? [resolveTarget(repo.root, claudeSkillsLink)] : []),
  ]);
  const skillFailures = [];
  const ownedSkillPaths = [];
  for (const { edit, skill } of plannedSkills) {
    try {
      const layout = dryRun
        ? { created: [], warnings: [] }
        : writeSkill(repo.root, skill, { exclusive: true, ensureLayout: false });
      results.skills.push({ path: skill.path, dryRun, created: layout.created });
      if (!dryRun) {
        ownedSkillPaths.push(...("ownership" in layout && Array.isArray(layout.ownership) ? layout.ownership : []));
      }
      for (const w of layout.warnings) if (!results.warnings.includes(w)) results.warnings.push(w);
    } catch (err) {
      skillFailures.push({ file: skill.path, edit: edit.id, error: err.message });
    }
  }

  const rollbackSkills = () => {
    const { removed, conflicts } = removeOwnedSkillPaths(ownedSkillPaths);
    removeEmptyDirectories(createdDirectoryCandidates);
    results.skills = [];
    const removedPaths = removed.map((item) => item.relative).filter(Boolean);
    if (removedPaths.length) {
      results.failed.push({
        error: `rolled back skill paths written earlier in this round: ${removedPaths.join(", ")}`,
      });
    }
    for (const item of conflicts) {
      results.failed.push({
        file: item.relative,
        error: `${item.relative} rollback conflict: the skill changed after this apply wrote it; left untouched`,
      });
    }
  };

  if (skillFailures.length) {
    results.failed.push(...skillFailures);
    rollbackSkills();
    for (const { relative } of planned) {
      results.failed.push({
        file: relative,
        error: `${relative} was left unchanged: its edits point at a skill that could not be written`,
      });
    }
    return results;
  }

  const orderedPlanned = [...resolvedPlanned].sort((a, b) => {
    const aMemory = a.relative === proposal.memoryFile.path;
    const bMemory = b.relative === proposal.memoryFile.path;
    return Number(aMemory) - Number(bMemory);
  });
  const committed = [];
  const rollbackCommitted = () => {
    for (const written of [...committed].reverse()) {
      if (!commitStillCurrent(written.commit)) {
        results.failed.push({
          file: written.relative,
          error: `${written.relative} rollback conflict: the file changed after this apply wrote it; left untouched`,
        });
        continue;
      }
      try {
        atomicReplace(written.commit.absolute, written.before);
      } catch (rollbackError) {
        results.failed.push({
          file: written.relative,
          error: `${written.relative} could not be rolled back: ${rollbackError.message}`,
        });
      }
    }
    results.written = [];
  };
  const landedDescriptionDelta = descriptionTokensProjected - descriptionTokensNow;
  const budgetTarget = memoryPlan || orderedPlanned[0];
  const surfaceBudget = budgetTarget
    ? budgetStatus(memoryText, memoryPlan?.text ?? memoryText, config.budgetTokens, {
        current: descriptionTokensNow,
        projected: descriptionTokensNow + landedDescriptionDelta,
      })
    : null;
  for (const item of orderedPlanned) {
    const { relative, resolved, text, applied } = item;
    const budget = item === budgetTarget ? surfaceBudget : null;

    let commit = null;
    try {
      if (!dryRun) commit = atomicReplace(resolved, text);
    } catch (err) {
      const blocked = refuseReadOnlySymlink(item.absolute);
      results.failed.push({
        file: relative,
        error: blocked || `${relative} could not be written: ${err.message}`,
      });
      rollbackCommitted();
      rollbackSkills();
      return results;
    }
    committed.push({ ...item, commit });
    results.written.push({ file: relative, edits: applied, budget, dryRun });
  }

  if (surfaceBudget && !surfaceBudget.withinBudget) {
    results.warnings.push(
      overBudgetWarning(
        surfaceLabel(
          proposal.memoryFile.path,
          Math.max(descriptionTokensNow, descriptionTokensNow + landedDescriptionDelta),
        ),
        surfaceBudget,
      ),
    );
  }

  if (!dryRun && canonical) {
    try {
      const layout = ensureSkillsLayout(repo.root, claudeSkillsLink);
      const result = results.skills.find(({ path: skillPath }) => skillPath === canonical.skill.path);
      result.created = [...new Set([...result.created, ...layout.created])];
      for (const w of layout.warnings) if (!results.warnings.includes(w)) results.warnings.push(w);
    } catch (err) {
      results.failed.push({ file: claudeSkillsLink, edit: canonical.edit.id, error: err.message });
      rollbackCommitted();
      rollbackSkills();
      return results;
    }
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
