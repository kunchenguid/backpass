import { UserError, color, info, json, out } from "../logger.js";
import { ProposalViolation } from "../proposal.js";
import { runAnalysis } from "./analyze.js";
import { bootstrapJson, bootstrapRun, printBootstrap } from "./bootstrap.js";
import { printProposal, printSynthesisFailure, runProposal, synthesisFailureHint } from "./propose.js";
import { budgetBar, formatTokens } from "../tokens.js";
import { startTui } from "../tui/index.js";
import { resolveMemoryFiles } from "../memory.js";

/**
 * The default command: one full backward pass.
 *
 *   discover -> distill -> analyze (cheap, fanned out) -> fold -> synthesize (high-reasoning turns)
 *
 * It never writes - with one exception: a repo with no memory file at all is
 * bootstrapped (`./bootstrap.js`), which only ever creates files. Otherwise applying
 * is a separate, human-gated step.
 *
 * On an eligible terminal a live progress view renders the run on stderr; it
 * collapses back into the plain lines below before anything is printed to
 * stdout, so piped and logged output is unchanged.
 */
export async function cmdRun(ctx) {
  const { repo, config } = ctx;
  const tui = await startTui(ctx);

  try {
    info(
      `${color.bold("backpass")} ${color.dim(
        `v${ctx.version} · ${repo.name} · budget ${formatTokens(config.budgetTokens)} tok · since ${config.discovery.since}`,
      )}`,
    );

    config.state.clearProposal();

    if (!resolveMemoryFiles(repo.root, config.memoryFiles).primary) {
      const result = await bootstrapRun(ctx);
      tui?.stop();
      if (ctx.flags.json) bootstrapJson(result);
      else printBootstrap(result, config);
      return 0;
    }

    const analysis = await runAnalysis(ctx);

    if (!analysis.transcripts.length) {
      tui?.stop();
      out("");
      out("No agent transcripts are associated with this repo yet.");
      out(
        color.dim(
          "  `backpass scan --since all` widens the time window; --include-cursor-ide adds the Cursor IDE store.",
        ),
      );
      return 0;
    }

    const budget = budgetBar({
      utilization: analysis.file.tokens / config.budgetTokens,
      withinBudget: analysis.file.tokens <= config.budgetTokens,
    });
    info(
      `${color.cyan("·")} ${analysis.file.path}: ${budget} ${formatTokens(analysis.file.tokens)} / ` +
        `${formatTokens(config.budgetTokens)} tok · ${analysis.file.units.length} instructions`,
    );

    if (analysis.summary) {
      info(
        `${color.cyan("·")} evidence: ${analysis.summary.analyzed} new · ${analysis.summary.cached} cached · ` +
          `${analysis.summary.skipped} too short · ${analysis.summary.failed} failed`,
      );
    }

    const { proposal } = await runProposal(ctx, analysis);
    tui?.stop();

    if (ctx.flags.json) {
      json(proposal);
      return 0;
    }

    printProposal(proposal, { analysisUsage: analysis.summary?.usage || [] });
    return 0;
  } catch (err) {
    tui?.stop();
    if (err instanceof ProposalViolation) {
      printSynthesisFailure(err, config.state);
      throw new UserError(err.message, synthesisFailureHint(err));
    }
    throw err;
  } finally {
    tui?.stop();
  }
}
