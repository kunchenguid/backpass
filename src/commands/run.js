import { UserError, color, info, json, out } from '../logger.js';
import { formatUsage, sumUsage } from '../acpx.js';
import { ProposalViolation } from '../proposal.js';
import { runAnalysis } from './analyze.js';
import { printProposal, runProposal } from './propose.js';
import { budgetBar, formatTokens } from '../tokens.js';

/**
 * The default command: one full backward pass.
 *
 *   discover -> distill -> analyze (cheap, fanned out) -> fold -> synthesize (one big call)
 *
 * It never writes. Applying is a separate, human-gated step.
 */
export async function cmdRun(ctx) {
  const { repo, config } = ctx;

  info(
    `${color.bold('backpass')} ${color.dim(
      `v${ctx.version} · ${repo.name} · budget ${formatTokens(config.budgetTokens)} tok · since ${config.discovery.since}`,
    )}`,
  );

  const analysis = await runAnalysis(ctx);

  if (!analysis.transcripts.length) {
    out('');
    out('No agent transcripts are associated with this repo yet.');
    out(color.dim('  `backpass scan --since all` widens the time window; --include-cursor-ide adds the Cursor IDE store.'));
    return 0;
  }

  const budget = budgetBar({
    utilization: analysis.file.tokens / config.budgetTokens,
    withinBudget: analysis.file.tokens <= config.budgetTokens,
  });
  info(
    `${color.cyan('·')} ${analysis.file.path}: ${budget} ${formatTokens(analysis.file.tokens)} / ` +
      `${formatTokens(config.budgetTokens)} tok · ${analysis.file.units.length} instructions`,
  );

  if (analysis.summary) {
    info(
      `${color.cyan('·')} evidence: ${analysis.summary.analyzed} new · ${analysis.summary.cached} cached · ` +
        `${analysis.summary.skipped} too short · ${analysis.summary.failed} failed`,
    );
  }

  try {
    const { proposal } = await runProposal(ctx, analysis);

    if (ctx.flags.json) {
      json(proposal);
      return 0;
    }

    printProposal(proposal);

    const tier1 = sumUsage(analysis.summary?.usage || []);
    const tier2 = sumUsage(proposal.usage || []);
    out(color.dim(`  tier-1 tokens: ${formatUsage(tier1)}`));
    out(color.dim(`  tier-2 tokens: ${formatUsage(tier2)}`));
    return 0;
  } catch (err) {
    if (err instanceof ProposalViolation) {
      info('');
      for (const violation of err.violations) info(`  ${color.red('x')} ${violation}`);
      info('');
      info(color.dim(`  the rejected proposal was saved to ${config.state.proposalPath}`));
      throw new UserError(err.message, 'try a stronger synthesis model, or raise --budget / --max-edits');
    }
    throw err;
  }
}
