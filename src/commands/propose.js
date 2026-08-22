import { foldEvidence } from "../fold.js";
import { ledgerGapObservations, pruneGapLedger, recordGapObservations } from "../gap-ledger.js";
import { synthesizeProposal } from "../synthesize.js";
import { ProposalViolation } from "../proposal.js";
import { UserError, color, info, json, out } from "../logger.js";
import { budgetBar, formatTokens } from "../tokens.js";
import { emitProgress } from "../progress.js";
import { primaryMemoryFile } from "./analyze.js";
import { printUsage } from "./usage.js";
import { discoverForRun } from "./scan.js";

/**
 * Fold on-disk evidence for the memory file. Gap corroboration is counted through the
 * persisted ledger so sessions accumulate across runs: record this run's observations,
 * prune what the current file now covers or what aged out (after recording, because the
 * evidence files that fed an expired sighting are still on disk and would re-add it),
 * then cluster from the ledger.
 */
export async function foldForRun(ctx, memoryFile) {
  const { state, minGapEvidence, gapLedgerMaxAge } = ctx.config;
  const evidence = state.listEvidence();
  const relevant = evidence.filter((e) => e.memoryPath === memoryFile.path);

  const ledger = state.readGapLedger();
  recordGapObservations(ledger, relevant);
  pruneGapLedger(ledger, { memoryFile, memoryPath: memoryFile.path, maxAge: gapLedgerMaxAge });
  state.writeGapLedger(ledger);

  return foldEvidence(relevant, {
    minGapEvidence,
    memoryFile,
    gapObservations: ledgerGapObservations(ledger, memoryFile.path),
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
      "no loss calculated yet: nothing to run gradient descent on",
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

/**
 * @param {object} proposal
 * @param {{ applied?: boolean, analysisUsage?: import("../acpx.js").UsageRecord[] }} [options]
 *   `analysisUsage` is the tier-1 accounting of the same run, when the caller ran it.
 */
export function printProposal(proposal, { applied = false, analysisUsage = [] } = {}) {
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

  printUsage({ tier1: analysisUsage, tier2: proposal.usage || [] });
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
