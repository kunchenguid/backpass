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
 *
 * Evidence is also filtered to `memoryHash`: a transcript's evidence file is rewritten
 * every time it is re-analyzed against a changed memory file, but a transcript that fell
 * out of this run's sample (window, cap, or discovery drift) leaves its last evidence file
 * on disk under whatever hash it was last judged against. That leftover file is real and
 * reusable the moment its transcript is re-analyzed - or immediately, if the memory file's
 * bytes return to that hash - but folding it into *this* proposal would score it against
 * an instruction index it was never judged against (aliases are positional) and inflate
 * `analyzedSessions` with a session this run never touched. Nothing is migrated, rewritten,
 * or deleted here - only excluded from this run's fold.
 */
export async function foldForRun(ctx, memoryFile, memoryHash) {
  const { state, minGapEvidence, gapLedgerMaxAge } = ctx.config;
  const evidence = state.listEvidence();
  const relevant = evidence.filter((e) => e.memoryPath === memoryFile.path && e.memoryHash === memoryHash);

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
  // Starting a new proposal run invalidates the previous result immediately. Discovery,
  // folding, and agent resolution can all fail before synthesis starts; none of those
  // failures may leave an older proposal available to apply as if it came from this run.
  config.state.clearProposal();
  const { file, hash } = precomputed || primaryMemoryFile(repo, config);
  const transcripts = precomputed?.transcripts || (await discoverForRun(ctx)).transcripts;

  const foldStarted = Date.now();
  const summary = await foldForRun(ctx, file, hash);
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

/** True when a violation is about the always-loaded budget rather than the annotation. */
const isBudgetViolation = (v) => /-token budget/.test(v);
const isEditCapViolation = (v) => /per-run cap is \d+/.test(v);

/**
 * What to actually try next, read off the condition the run ended on.
 *
 * The old advice - a stronger model, a bigger budget, a higher edit cap - was printed for
 * every failure, including the ones where the model never spoke and the ones where the
 * budget was never the constraint. Each terminal condition has a different repair.
 */
export function synthesisFailureHint(err) {
  if (err.reason === "empty") {
    return "the synthesis harness returned no text, so nothing about the model, the budget, or the edit cap was the constraint; run `backpass propose` again to start a fresh synthesis session";
  }
  if (err.reason === "unparseable") {
    return "the model answered but not with a JSON object; run `backpass propose` again, or pin a different harness with --synthesis-agent";
  }
  if (err.reason === "editing") {
    return "the agent kept rewriting the staging copy instead of describing it; run `backpass propose` again to start fresh";
  }
  const violations = err.violations || [];
  if (violations.some(isBudgetViolation)) {
    return "the edit set did not clear the budget gate: raise --budget, or let the shrink continue over more runs";
  }
  if (violations.some(isEditCapViolation)) {
    return "the annotation proposed more edits than the per-run learning rate allows: raise --max-edits, or re-run and let the next pass take the rest";
  }
  return "the gates above are what the next synthesis must satisfy; run `backpass propose` again";
}

/**
 * Report a synthesis that ended without a valid proposal: loudly, and about the turn that
 * actually ended it (design section 6).
 *
 * The saved proposal and the terminal condition can be from different turns - a run whose
 * last turn was empty leaves the rejected proposal of an earlier one on disk - so the
 * provenance is printed rather than letting the older violations read as this turn's.
 */
export function printSynthesisFailure(err, state) {
  info("");
  for (const violation of err.violations) info(`  ${color.red("x")} ${violation}`);
  info("");
  if (!err.saved) {
    info(color.dim("  no proposal was saved: no annotation turn produced one"));
    return;
  }
  info(color.dim(`  the rejected proposal was saved to ${state.proposalPath}`));
  if (err.reason !== "gates") {
    info(color.dim(`  it is from annotation attempt ${err.saved.attempt}, not the turn above, and it lists:`));
    for (const violation of err.saved.violations) info(color.dim(`    - ${violation}`));
  }
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
      printSynthesisFailure(err, ctx.config.state);
      throw new UserError(err.message, synthesisFailureHint(err));
    }
    throw err;
  }
}
