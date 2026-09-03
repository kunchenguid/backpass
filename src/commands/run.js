import { UserError, color, info, json, out } from "../logger.js";
import { ProposalViolation } from "../proposal.js";
import { runAnalysis } from "./analyze.js";
import { bootstrapJson, bootstrapRun, printBootstrap } from "./bootstrap.js";
import { printProposal, printSynthesisFailure, runProposal, synthesisFailureHint } from "./propose.js";
import { budgetBar, formatTokens } from "../tokens.js";
import { skillDescriptionTokens } from "../skills.js";
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
  const { repo, scope, config } = ctx;
  const tui = await startTui(ctx);

  try {
    info(
      `${color.bold("backpass")} ${color.dim(
        `v${ctx.version} · ${scope?.kind === "user" ? "user scope" : repo.name} · budget ${formatTokens(config.budgetTokens)} tok · since ${config.discovery.since}`,
      )}`,
    );

    config.state.clearProposal();

    if (!resolveMemoryFiles(repo.root, config.memoryFiles, { allowExternal: scope?.kind === "user" }).primary) {
      if (scope?.kind === "user") {
        throw new UserError(
          `no user memory file found (looked for ${config.memoryFiles.join(", ")})`,
          "set user.memoryFiles in ~/.config/backpass/config.json",
        );
      }
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
      if (scope?.kind === "user") {
        out("No agent transcripts found for user scope yet.");
        out(color.dim("  `backpass scan --scope user --since all` widens the time window."));
      } else {
        out("No agent transcripts are associated with this repo yet.");
        out(
          color.dim(
            "  `backpass scan --since all` widens the time window; --include-cursor-ide adds the Cursor IDE store.",
          ),
        );
      }
      return 0;
    }

    // The banner shows what the gate measures: the always-loaded surface, which is the
    // memory file plus every skill description line.
    const descriptionTokens = skillDescriptionTokens(analysis.skills || []);
    const alwaysLoaded = analysis.file.tokens + descriptionTokens;
    const budget = budgetBar({
      utilization: alwaysLoaded / config.budgetTokens,
      withinBudget: alwaysLoaded <= config.budgetTokens,
    });
    info(
      `${color.cyan("·")} ${analysis.file.path}${descriptionTokens ? " + skill descriptions" : ""}: ${budget} ` +
        `${formatTokens(alwaysLoaded)} / ` +
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
