import { describeUsage } from "../acpx.js";
import { color, out } from "../logger.js";

/**
 * Print the model-usage accounting for a run, one line per pass that actually made
 * calls: tier-1 (the per-transcript analysis pass) then tier-2 (synthesis). This is the
 * only place that prints these lines - `run` and `propose` both end in `printProposal`,
 * and `analyze` prints just its own tier through the same helper - so the accounting
 * appears exactly once, in order, before the apply hint.
 *
 * A pass that made no calls this run (all evidence cached, or analysis ran in an earlier
 * command) prints nothing rather than a meaningless "n/a"; a pass whose harness returned
 * no usage says so by name (see `describeUsage`).
 *
 * @param {{ tier1?: import("../acpx.js").UsageRecord[], tier2?: import("../acpx.js").UsageRecord[] }} usage
 */
export function printUsage({ tier1 = [], tier2 = [] } = {}) {
  const lines = [
    ["tier-1", describeUsage(tier1)],
    ["tier-2", describeUsage(tier2)],
  ].filter(([, text]) => text);
  if (!lines.length) return;
  out("");
  for (const [tier, text] of lines) out(color.dim(`  ${tier} tokens: ${text}`));
}
