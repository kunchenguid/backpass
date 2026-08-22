import { foldEvidence } from "../fold.js";
import { synthesizeProposal } from "../synthesize.js";
import { ProposalViolation } from "../proposal.js";
import { UserError, color, info, json, out } from "../logger.js";
import { budgetBar, formatTokens } from "../tokens.js";
import { formatUsage, sumUsage } from "../acpx.js";
import { emitProgress } from "../progress.js";
import { primaryMemoryFile } from "./analyze.js";
import { discoverForRun } from "./scan.js";

export async function foldForRun(ctx, memoryFile) {
  const evidence = ctx.config.state.listEvidence();
  const relevant = evidence.filter((e) => e.memoryPath === memoryFile.path);
  return foldEvidence(relevant, {
    minGapEvidence: ctx.config.minGapEvidence,
    memoryFile,
  });
}

export async function runProposal(ctx, precomputed = null) {
  const { repo, config } = ctx;
  const { file } = precomputed || primaryMemoryFile(repo, config);
  const transcripts = precomputed?.transcripts || (await discoverForRun(ctx)).transcripts;

  const foldStarted = Date.now();
  const summary = await foldForRun(ctx, file);
  config.state.writeSummary(summary);
  emitProgress("fold:done", {
    instructions: summary.instructions.length,
    clustersFound: summary.totals.gapClusters + summary.totals.droppedGapSingletons,
    clustersKept: summary.totals.gapClusters,
    minGapEvidence: config.minGapEvidence,
    ms: Date.now() - foldStarted,
  });

  if (!summary.analyzedSessions) {
    throw new UserError(
      "no analyzed transcripts to synthesize from",
      "run `backpass analyze` first, or `backpass` for the full pass",
    );
  }

  const { proposal } = await synthesizeProposal({
    memoryFile: file,
    summary,
    config,
    repo,
    transcripts,
  });

  config.state.writeProposal(proposal);
  return { proposal, summary, memoryFile: file };
}

export function printProposal(proposal, { applied = false } = {}) {
  out("");
  out(
    `${color.bold("proposal")} · ${proposal.repo.name} · ${proposal.memoryFile.path} · ` +
      `${proposal.edits.length} edit(s) from ${proposal.stats.transcripts} session(s)`,
  );
  out(
    `  budget ${budgetBar(proposal.budget)} ${formatTokens(proposal.budget.current)} -> ` +
      `${formatTokens(proposal.budget.projected)} / ${formatTokens(proposal.budget.capTokens)} tok` +
      (proposal.budget.mode === "shrink"
        ? color.dim(`  [shrink plan: ${formatTokens(proposal.budget.over)} still over]`)
        : ""),
  );
  out(
    `  evidence: ${proposal.stats.positive} positive · ${proposal.stats.negative} negative · ` +
      `${proposal.stats.gapClusters} gap clusters`,
  );
  out("");

  if (!proposal.edits.length) {
    out("  no edits proposed - the evidence did not clear the thresholds this run");
  }

  for (const edit of proposal.edits) {
    const kind = edit.kind === "extract" ? "EXTRACT" : edit.kind.toUpperCase();
    const delta = edit.deltaTokens || 0;
    out(
      `  ${color.cyan(edit.id)} ${kind.padEnd(8)} ${edit.title} ` +
        color.dim(`(${delta > 0 ? "+" : ""}${delta} tok, ${edit.transcripts} transcript(s))`),
    );
  }

  for (const note of proposal.notes || []) out(color.dim(`  note: ${note}`));

  const usage = sumUsage(proposal.usage || []);
  out("");
  out(color.dim(`  tier-2 tokens: ${formatUsage(usage)}`));
  if (applied) return;
  out("");
  out("Review and apply with `backpass apply` (nothing has been written).");
}

export async function cmdPropose(ctx) {
  try {
    const { proposal } = await runProposal(ctx);
    if (ctx.flags.json) {
      json(proposal);
      return 0;
    }
    printProposal(proposal);
    return 0;
  } catch (err) {
    if (err instanceof ProposalViolation) {
      // Loud failure, never silent truncation (design section 6).
      info("");
      for (const violation of err.violations) info(`  ${color.red("x")} ${violation}`);
      info("");
      info(color.dim(`  the rejected proposal was saved to ${ctx.config.state.proposalPath}`));
      throw new UserError(err.message, "try a stronger synthesis model, or raise --budget / --max-edits");
    }
    throw err;
  }
}
