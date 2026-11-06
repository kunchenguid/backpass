import { formatCorpusMix } from "../interaction.js";
import { UserError, color, info, json, out, warn } from "../logger.js";
import { applyDecisions, budgetMismatchHint, budgetMismatchMessage, budgetMismatches } from "../apply/writer.js";
import { closeApplySurface, openApplySurface, pollDecisions, renderApplySurface } from "../apply/lavish.js";
import { reviewInTerminal } from "../apply/terminal.js";
import { openInBrowser } from "../apply/browser.js";
import { REJECT_REASONS } from "../state.js";
import { budgetBar, formatTokens } from "../tokens.js";
import { describeTarget } from "../target.js";

/**
 * The human gate. `backpass apply` is the only command that writes to the repo.
 *
 * By default it serves the shipped static template through lavish-axi and waits for one
 * structured decision vector; `--no-ui` keeps the same ACCEPT/REJECT decision in the
 * terminal, and `--decisions` takes a vector decided elsewhere. `applyDecisions` owns the
 * pre-write freshness, budget, and composition gates; a failing gate records no rejections.
 */
/** A run-level failure carries no `file`; only a per-edit one does. */
export function formatFailureLine(failure) {
  const location = failure.file ? ` ${failure.file}${failure.edit ? ` (${failure.edit})` : ""}` : "";
  return `${color.red("failed")}${location}: ${failure.error}`;
}

/**
 * `--decisions`: the vector the review surface sends (`e1=accepted e2=rejected:too-narrow`),
 * typed by whoever decided. Unlike the surface's comment box it is parsed strictly - every
 * token names one edit of this proposal once, a verdict, and at most a known reject reason -
 * so a typo stops the apply instead of silently leaving an edit undecided.
 * Repeated flags form one vector, but each must name an edit on its own, so a blank one is
 * refused rather than dropped.
 *
 * @param {string | string[]} vectors
 * @param {string[]} editIds
 * @returns {{ decisions: Record<string, string>, reasons: Record<string, string> }}
 */
export function parseDecisionsFlag(vectors, editIds) {
  const usage = `e.g. --decisions "${editIds.map((id, i) => `${id}=${i ? "rejected:too-narrow" : "accepted"}`).join(" ")}"`;
  const tokens = [];
  for (const vector of Array.isArray(vectors) ? vectors : [vectors]) {
    const own = String(vector).trim().split(/\s+/).filter(Boolean);
    if (!own.length) throw new UserError("--decisions names no edit", usage);
    tokens.push(...own);
  }
  /** @type {Record<string, string>} */
  const decisions = {};
  /** @type {Record<string, string>} */
  const reasons = {};
  for (const token of tokens) {
    const match = /^(e\d+)=(accepted|rejected)(?::(.+))?$/.exec(token);
    if (!match) {
      throw new UserError(`--decisions: "${token}" is not <edit>=accepted or <edit>=rejected[:<reason>]`, usage);
    }
    const [, id, verdict, reason] = match;
    if (!editIds.includes(id)) {
      throw new UserError(`--decisions: ${id} is not an edit of this proposal`, `its edits: ${editIds.join(", ")}`);
    }
    if (decisions[id]) throw new UserError(`--decisions: ${id} is decided twice`);
    if (reason !== undefined && (verdict !== "rejected" || !REJECT_REASONS.includes(reason))) {
      throw new UserError(
        `--decisions: "${token}" carries a reason that is not a reject reason`,
        `reasons: ${REJECT_REASONS.join(", ")}`,
      );
    }
    decisions[id] = verdict;
    if (reason) reasons[id] = reason;
  }
  return { decisions, reasons };
}

export async function cmdApply(ctx) {
  const { config, repo } = ctx;
  const proposal = config.state.readProposal();

  if (!proposal) {
    throw new UserError("no proposal to apply", "run `backpass` first to produce one");
  }
  const proposalScope = proposal.scope || "project";
  const runScope = ctx.scope?.kind || "project";
  if (proposalScope !== runScope) {
    throw new UserError(`this proposal is ${proposalScope} scope; run \`backpass apply --scope ${proposalScope}\``);
  }
  // A proposal carries its own target; the flag on apply may only restate it.
  const savedTarget = proposal.target || { kind: "surface" };
  const sameTarget = config.target.kind === savedTarget.kind && config.target.path === savedTarget.path;
  if (ctx.flags.target !== undefined && !sameTarget) {
    throw new UserError(
      `this proposal targets ${describeTarget(savedTarget)}, not ${describeTarget(config.target)}`,
      "apply it without --target, or run backpass again with the target you want",
    );
  }
  if (savedTarget.kind !== "surface") info(`${color.cyan("·")} proposal targets ${describeTarget(savedTarget)}`);
  if (proposal.violations?.length) {
    throw new UserError(
      "the saved proposal failed its mechanical gates and was never approved for apply",
      "run `backpass propose` again",
    );
  }
  if (proposal.appliedAt) {
    throw new UserError(
      `the last proposal was already applied by ${proposal.appliedBy || "a previous apply"} (${proposal.appliedAt})`,
      "run `backpass` again to produce a fresh one",
    );
  }
  if (!proposal.edits.length) {
    out("The last run proposed no edits. Nothing to apply.");
    return 0;
  }

  // Like scope, the budget is part of what the proposal was made under: refuse before
  // the review rather than after it, so nobody decides edits that cannot be applied.
  const mismatches = budgetMismatches(proposal, config);
  if (mismatches.length) {
    throw new UserError(mismatches.map(budgetMismatchMessage).join("\n"), budgetMismatchHint(mismatches));
  }

  const editIds = proposal.edits.map((e) => e.id);
  let decisions;
  let rejectReasons = {};
  let surfaceFile = null;

  if (ctx.flags.decisions !== undefined) {
    if (ctx.flags["no-ui"]) throw new UserError("--decisions and --no-ui both decide the edits; pass one of them");
    ({ decisions, reasons: rejectReasons } = parseDecisionsFlag(ctx.flags.decisions, editIds));
  } else if (ctx.flags["no-ui"]) {
    decisions = await reviewInTerminal(proposal);
  } else {
    surfaceFile = renderApplySurface(proposal, config.state, ctx.version);
    const url = await openApplySurface(surfaceFile);
    info(`${color.cyan("·")} review surface: ${url || surfaceFile}`);
    // Best effort: the printed URL above is the fallback when nothing opens.
    if (!ctx.flags["no-open"]) openInBrowser(url);
    const parsed = await pollDecisions(surfaceFile, editIds);
    decisions = parsed?.decisions ?? null;
    rejectReasons = parsed?.reasons || {};
  }

  if (!decisions) {
    out("No decisions received - nothing was written.");
    return 0;
  }

  // Anything the reviewer never touched stays untouched.
  for (const id of editIds) if (!decisions[id]) decisions[id] = "skipped";

  const results = applyDecisions({
    proposal,
    decisions,
    repo,
    state: config.state,
    config,
    dryRun: Boolean(ctx.flags["dry-run"]),
    rejectReasons,
    appliedBy: "apply",
  });

  if (surfaceFile) await closeApplySurface(surfaceFile);

  if (ctx.flags.json) {
    json({ decisions, rejectReasons, results, mix: proposal.stats.corpusMix || null });
    return results.failed.length ? 1 : 0;
  }

  out("");
  const prefix = ctx.flags["dry-run"] ? color.yellow("[dry-run] ") : "";
  out(`${prefix}${results.accepted} accepted · ${results.rejected} rejected`);
  if (proposal.stats.corpusMix) out(`  corpus ${formatCorpusMix(proposal.stats.corpusMix)}`);

  for (const written of results.written) {
    out(`  ${color.green("wrote")} ${written.file} (${written.edits.join(", ")})`);
    if (written.budget) {
      out(
        `    budget ${budgetBar(written.budget)} ${formatTokens(written.budget.current)} -> ` +
          `${formatTokens(written.budget.projected)} / ${formatTokens(written.budget.capTokens)} tok`,
      );
    }
  }
  for (const skill of results.skills) {
    out(`  ${color.green("wrote")} ${skill.path} (new skill)`);
    for (const created of skill.created || []) out(color.dim(`    created ${created}`));
  }
  for (const warning of results.warnings || []) warn(warning);
  for (const failure of results.failed) {
    out(`  ${formatFailureLine(failure)}`);
  }

  if (results.rejectionsRecorded) {
    out(color.dim("  rejections recorded - they will not be re-proposed without new evidence"));
  }
  if (!results.written.length && !results.skills.length) out("  nothing written");

  return results.failed.length ? 1 : 0;
}
