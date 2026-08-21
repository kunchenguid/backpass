import fs from 'node:fs';
import path from 'node:path';

import { color, json, out } from '../logger.js';
import { loadMemoryFiles } from '../memory.js';
import { loadSkills, resolveOverflowTarget } from '../skills.js';
import { budgetBar, budgetStatus, formatTokens } from '../tokens.js';
import { table } from './scan.js';

export async function cmdStatus(ctx) {
  const { repo, config } = ctx;
  const state = config.state;

  const files = loadMemoryFiles(repo.root, config.memoryFiles);
  const evidence = state.listEvidence();
  const counts = { ok: 0, failed: 0, skipped: 0 };
  for (const e of evidence) counts[e.status] = (counts[e.status] || 0) + 1;

  const cache = state.readScanCache();
  const summary = state.readSummary();
  const proposal = state.readProposal();
  const rejections = state.readRejections();
  const overflow = resolveOverflowTarget(repo.root, config.skillsDir);
  const skills = loadSkills(repo.root, overflow.dir);

  const budgets = files.map((file) => ({
    path: file.path,
    ...budgetStatus(file.text, null, config.budgetTokens),
    instructions: file.units.length,
  }));

  if (ctx.flags.json) {
    json({
      repo: repo.name,
      budgets,
      evidence: counts,
      scanCacheEntries: Object.keys(cache.entries).length,
      summary: summary ? { analyzedSessions: summary.analyzedSessions, totals: summary.totals } : null,
      proposal: proposal ? { generatedAt: proposal.generatedAt, edits: proposal.edits.length } : null,
      rejections: Object.keys(rejections.entries).length,
      skills: skills.length,
    });
    return 0;
  }

  out(`${color.bold(repo.name)} ${color.dim(repo.root)}`);
  out('');

  out(color.dim('BUDGET (always-loaded)'));
  if (!budgets.length) out('  no memory file found');
  for (const b of budgets) {
    const state_ = b.withinBudget ? '' : color.red(` ${b.over} OVER`);
    out(
      `  ${b.path.padEnd(14)} ${budgetBar(b)} ${formatTokens(b.current)} / ${formatTokens(b.capTokens)} tok` +
        ` · ${b.instructions} instructions${state_}`,
    );
  }
  if (skills.length) {
    const skillTokens = skills.reduce((n, s) => n + s.bodyTokens, 0);
    const descTokens = skills.reduce((n, s) => n + s.descriptionTokens, 0);
    out(
      color.dim(
        `  overflow: ${skills.length} skill(s) in ${overflow.dir} · ${formatTokens(skillTokens)} tok on trigger, ` +
          `${formatTokens(descTokens)} tok always loaded`,
      ),
    );
  }
  out('');

  out(color.dim('CACHE'));
  out(`  scan cache      ${Object.keys(cache.entries).length} file(s) fingerprinted`);
  out(`  evidence        ${counts.ok || 0} ok · ${counts.skipped || 0} skipped · ${color.red(String(counts.failed || 0))} failed`);
  if (summary) {
    out(
      `  folded          ${summary.analyzedSessions} session(s) · ${summary.totals.positive}+ ` +
        `${summary.totals.negative}- · ${summary.totals.gapClusters} gap cluster(s)`,
    );
  }
  out(`  rejections      ${Object.keys(rejections.entries).length} remembered`);
  out('');

  if (counts.failed) {
    out(color.dim('FAILED TRANSCRIPTS (retried on the next run)'));
    const rows = [['HARNESS', 'SESSION', 'ERROR']];
    for (const e of evidence.filter((x) => x.status === 'failed').slice(0, 10)) {
      rows.push([e.transcript.harness, String(e.transcript.id).slice(-12), String(e.error).slice(0, 60)]);
    }
    out(table(rows));
    out('');
  }

  out(color.dim('PROPOSAL'));
  if (!proposal) {
    out('  none yet - run `backpass`');
  } else {
    out(`  generated       ${proposal.generatedAt}`);
    out(`  edits           ${proposal.edits.length}${proposal.violations?.length ? color.red(' (failed its gates)') : ''}`);
    const surface = path.join(state.applyDir, 'apply.html');
    if (fs.existsSync(surface)) out(color.dim(`  surface         ${surface}`));
    if (!proposal.violations?.length && proposal.edits.length) out('  review with `backpass apply`');
  }

  out('');
  out(
    color.dim(
      `models: analysis ${config.analysis.agent}${config.analysis.model ? `/${config.analysis.model}` : ''} · ` +
        `synthesis ${config.synthesis.agent}${config.synthesis.model ? `/${config.synthesis.model}` : ''}` +
        `${config.synthesis.effort ? ` (effort ${config.synthesis.effort})` : ''}`,
    ),
  );
  return 0;
}
