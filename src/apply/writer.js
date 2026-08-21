import fs from 'node:fs';
import path from 'node:path';

import { applyEdit } from '../proposal.js';
import { budgetStatus } from '../tokens.js';
import { recordRejection } from '../state.js';
import { writeSkill } from '../skills.js';

/**
 * The only place in backpass that writes to the repo.
 *
 * Everything upstream is read-only analysis; a run only changes the weights here, after
 * a human accepted specific edits. Writes are grouped per file so a memory file is
 * rewritten once, atomically, rather than edit by edit.
 */
export function applyDecisions({ proposal, decisions, repo, state, config, dryRun = false }) {
  const accepted = proposal.edits.filter((e) => decisions[e.id] === 'accepted');
  const rejected = proposal.edits.filter((e) => decisions[e.id] === 'rejected');

  const byFile = new Map();
  const results = { written: [], skills: [], failed: [], accepted: accepted.length, rejected: rejected.length };

  for (const edit of accepted) {
    if (!byFile.has(edit.file)) byFile.set(edit.file, []);
    byFile.get(edit.file).push(edit);
  }

  for (const [relative, edits] of byFile) {
    const absolute = path.join(repo.root, relative);
    if (!fs.existsSync(absolute)) {
      results.failed.push({ file: relative, error: 'file does not exist' });
      continue;
    }

    const before = fs.readFileSync(absolute, 'utf8');
    let text = before;
    const applied = [];

    for (const edit of edits) {
      try {
        text = applyEdit(text, edit);
        applied.push(edit.id);
      } catch (err) {
        results.failed.push({ file: relative, edit: edit.id, error: err.message });
      }
    }

    if (text === before) continue;

    const budget = relative === proposal.memoryFile.path
      ? budgetStatus(before, text, config.budgetTokens)
      : null;

    if (!dryRun) fs.writeFileSync(absolute, text);
    results.written.push({ file: relative, edits: applied, budget, dryRun });
  }

  for (const edit of accepted) {
    if (edit.kind !== 'extract' || !edit.skill) continue;
    try {
      if (!dryRun) writeSkill(repo.root, edit.skill);
      results.skills.push({ path: edit.skill.path, dryRun });
    } catch (err) {
      results.failed.push({ file: edit.skill.path, edit: edit.id, error: err.message });
    }
  }

  // Rejections are remembered so the same edit is not re-proposed without new evidence.
  if (!dryRun && rejected.length) {
    const rejections = state.readRejections();
    for (const edit of rejected) recordRejection(edit, rejections);
    state.writeRejections(rejections);
  }

  return results;
}
