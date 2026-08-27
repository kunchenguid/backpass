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

function currentMemoryFailure(proposal, repo) {
  if (!proposal.memoryFile?.hash) return null;
  return memoryFileSnapshot(proposal, repo).failure ?? null;
}

function acquireApplyLock(repoRoot) {
  const stateDir = path.join(repoRoot, ".backpass");
  fs.mkdirSync(stateDir, { recursive: true });
  const lock = path.join(stateDir, "apply.lock");

  let fd;
  try {
    fd = fs.openSync(lock, "wx");
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const owner = Number.parseInt(fs.readFileSync(lock, "utf8"), 10);
    let live = Number.isInteger(owner);
    if (live) {
      try {
        process.kill(owner, 0);
      } catch (probeError) {
        live = probeError.code === "EPERM";
      }
    }
    if (live) throw new Error(`another backpass apply is running (pid ${owner})`, { cause: err });
    fs.rmSync(lock, { force: true });
    fd = fs.openSync(lock, "wx");
  }
  fs.writeFileSync(fd, String(process.pid));

  return () => {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  };
}

function fileSnapshot(target) {
  if (!fs.existsSync(target)) return { target, existed: false };
  return { target, existed: true, text: fs.readFileSync(target), mode: fs.statSync(target).mode };
}

function restoreSnapshot(snapshot) {
  if (!snapshot.existed) {
    fs.rmSync(snapshot.target, { force: true });
    return;
  }
  fs.writeFileSync(snapshot.target, snapshot.text, { mode: snapshot.mode });
  fs.chmodSync(snapshot.target, snapshot.mode);
}

function layoutSnapshot(repoRoot) {
  return [".agents", ".agents/skills", ".claude", ".claude/skills"].map((relative) => {
    let existed = true;
    try {
      fs.lstatSync(path.join(repoRoot, relative));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      existed = false;
    }
    return { relative, existed };
  });
}

function removeCreatedLayout(repoRoot, snapshot) {
  for (const { relative, existed } of [...snapshot].reverse()) {
    if (existed) continue;
    const target = path.join(repoRoot, relative);
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) fs.unlinkSync(target);
      else if (stat.isDirectory() && fs.readdirSync(target).length === 0) fs.rmdirSync(target);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
}

function rollbackApply(repoRoot, fileSnapshots, layout, results) {
  const failures = [];
  for (const snapshot of [...fileSnapshots].reverse()) {
    try {
      restoreSnapshot(snapshot);
    } catch (err) {
      failures.push({ file: path.relative(repoRoot, snapshot.target), error: `rollback failed: ${err.message}` });
    }
  }
  try {
    removeCreatedLayout(repoRoot, layout);
  } catch (err) {
    failures.push({ file: ".agents/skills", error: `layout rollback failed: ${err.message}` });
  }
  results.written = [];
  results.skills = [];
  results.failed.push(...failures);
}

function skillWritePreflight(repoRoot, edits) {
  const targets = edits.map((edit) => path.resolve(repoRoot, edit.skill.path));
  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index];
    const target = targets[index];
    if (targets.some((other, otherIndex) => otherIndex !== index && other.startsWith(`${target}${path.sep}`))) {
      return { file: edit.skill.path, edit: edit.id, error: "skill path is not a file" };
    }
    try {
      if (fs.existsSync(target)) {
        if (!fs.statSync(target).isFile()) {
          return { file: edit.skill.path, edit: edit.id, error: "skill path is not a file" };
        }
        fs.accessSync(target, fs.constants.W_OK);
        continue;
      }

      let parent = path.dirname(target);
      while (!fs.existsSync(parent)) parent = path.dirname(parent);
      if (!fs.statSync(parent).isDirectory()) {
        return { file: edit.skill.path, edit: edit.id, error: "skill parent path is not a directory" };
      }
      fs.accessSync(parent, fs.constants.W_OK);
    } catch (err) {
      return { file: edit.skill.path, edit: edit.id, error: err.message };
    }
  }
  return null;
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
 * every accepted edit has composed, and before the files that reference them. The commit
 * holds an apply lock, and a handled I/O failure compensates earlier writes before returning.
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

  // Skills go in before the memory file. Preflight every target before the first write,
  // so a malformed or unwritable later target cannot leave an earlier skill behind.
  const skillEdits = accepted.filter((edit) => edit.kind === "extract" && edit.skill && landed.has(edit.id));
  const skillFailure = skillWritePreflight(repo.root, skillEdits);
  if (skillFailure) {
    results.failed.push(skillFailure);
    return results;
  }

  const ordered = [...planned].sort(
    (a, b) => Number(a.relative === proposal.memoryFile.path) - Number(b.relative === proposal.memoryFile.path),
  );

  if (dryRun) {
    for (const edit of skillEdits) results.skills.push({ path: edit.skill.path, dryRun: true, created: [] });
    for (const { relative, before, text, applied } of ordered) {
      const budget = relative === proposal.memoryFile.path ? budgetStatus(before, text, config.budgetTokens) : null;
      results.written.push({ file: relative, edits: applied, budget, dryRun: true });
      if (budget && !budget.withinBudget) results.warnings.push(overBudgetWarning(relative, budget));
    }
  } else {
    let releaseLock;
    try {
      releaseLock = acquireApplyLock(repo.root);
    } catch (err) {
      results.failed.push({ file: proposal.memoryFile.path, error: `could not lock apply: ${err.message}` });
      return results;
    }

    const skillSnapshots = skillEdits.map((edit) => fileSnapshot(path.join(repo.root, edit.skill.path)));
    const changedSnapshots = [];
    const layoutBefore = layoutSnapshot(repo.root);
    let commitFailed = false;

    try {
      // Planning can take time. Hold the apply lock and revalidate at the shared
      // pre-write boundary so two backpass processes cannot race this check.
      const preWriteFailure = currentMemoryFailure(proposal, repo);
      if (preWriteFailure) {
        results.failed.push(preWriteFailure);
        commitFailed = true;
      }

      if (!commitFailed) {
        for (const edit of skillEdits) {
          const layout = writeSkill(repo.root, edit.skill);
          results.skills.push({ path: edit.skill.path, dryRun: false, created: layout.created });
          for (const w of layout.warnings) if (!results.warnings.includes(w)) results.warnings.push(w);
        }

        // The memory file remains last. Revalidate while still holding the lock after
        // skill I/O, then compensate every earlier write if this or any write fails.
        for (const { relative, absolute, before, text, applied } of ordered) {
          if (relative === proposal.memoryFile.path) {
            const failure = currentMemoryFailure(proposal, repo);
            if (failure) {
              results.failed.push(failure);
              commitFailed = true;
              break;
            }
          }
          const budget = relative === proposal.memoryFile.path ? budgetStatus(before, text, config.budgetTokens) : null;
          changedSnapshots.push(fileSnapshot(absolute));
          fs.writeFileSync(absolute, text);
          results.written.push({ file: relative, edits: applied, budget, dryRun: false });
          if (budget && !budget.withinBudget) results.warnings.push(overBudgetWarning(relative, budget));
        }
      }
    } catch (err) {
      results.failed.push({ file: proposal.memoryFile.path, error: err.message });
      commitFailed = true;
    } finally {
      if (commitFailed) rollbackApply(repo.root, [...skillSnapshots, ...changedSnapshots], layoutBefore, results);
      releaseLock();
    }

    if (commitFailed) return results;
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
