import { UserError, color, info, json, out, warn } from "../logger.js";
import { applyDecisions } from "../apply/writer.js";
import { closeApplySurface, openApplySurface, pollDecisions, renderApplySurface } from "../apply/lavish.js";
import { reviewInTerminal } from "../apply/terminal.js";
import { openInBrowser } from "../apply/browser.js";
import { budgetBar, formatTokens } from "../tokens.js";

/**
 * The human gate. `backpass apply` is the only command that writes to the repo.
 *
 * By default it serves the shipped static template through lavish-axi and waits for one
 * structured decision vector; `--no-ui` keeps the same ACCEPT/REJECT decision in the
 * terminal. `applyDecisions` revalidates the accepted subset against the budget before
 * writing; a failing set records no rejections.
 */
export async function cmdApply(ctx) {
  const { config, repo } = ctx;
  const proposal = config.state.readProposal();

  if (!proposal) {
    throw new UserError("no proposal to apply", "run `backpass` first to produce one");
  }
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

  const editIds = proposal.edits.map((e) => e.id);
  let decisions;
  let surfaceFile = null;

  if (ctx.flags["no-ui"]) {
    decisions = await reviewInTerminal(proposal);
  } else {
    surfaceFile = renderApplySurface(proposal, config.state, ctx.version);
    const url = await openApplySurface(surfaceFile);
    info(`${color.cyan("·")} review surface: ${url || surfaceFile}`);
    // Best effort: the printed URL above is the fallback when nothing opens.
    if (!ctx.flags["no-open"]) openInBrowser(url);
    decisions = await pollDecisions(surfaceFile, editIds);
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
  });

  if (surfaceFile) await closeApplySurface(surfaceFile);

  if (ctx.flags.json) {
    json({ decisions, results });
    return results.failed.length ? 1 : 0;
  }

  out("");
  const prefix = ctx.flags["dry-run"] ? color.yellow("[dry-run] ") : "";
  out(`${prefix}${results.accepted} accepted · ${results.rejected} rejected`);

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
    out(`  ${color.red("failed")} ${failure.file}${failure.edit ? ` (${failure.edit})` : ""}: ${failure.error}`);
  }

  if (results.rejectionsRecorded) {
    out(color.dim("  rejections recorded - they will not be re-proposed without new evidence"));
  }
  if (!results.written.length && !results.skills.length) out("  nothing written");

  return results.failed.length ? 1 : 0;
}
