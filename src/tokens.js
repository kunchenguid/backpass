/**
 * Token accounting for the length budget (design section 6).
 *
 * The estimator is deliberately harness-neutral: UTF-8 bytes / 4, the same
 * currency firstmate prices its own startup memory budget in. It is accurate
 * to roughly +/-15% across real memory files, which is the precision the
 * budget gate needs - the gate is a guardrail, not a billing system.
 */

const BYTES_PER_TOKEN = 4;

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN);
}

export function estimateTokensFromBytes(bytes) {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

export function formatTokens(n) {
  return n.toLocaleString("en-US");
}

/**
 * Budget verdict for one always-loaded memory file.
 * `over` is the amount by which projected exceeds the cap (0 when within).
 */
export function budgetStatus(currentText, projectedText, capTokens) {
  const current = estimateTokens(currentText);
  const projected = estimateTokens(projectedText ?? currentText);
  return {
    capTokens,
    current,
    projected,
    delta: projected - current,
    withinBudget: projected <= capTokens,
    over: Math.max(0, projected - capTokens),
    utilization: capTokens > 0 ? projected / capTokens : 0,
  };
}

/** Cap: stay under. Shrink: already over, so the delta must be negative. */
export function budgetGateKind(budget) {
  if (budget.current <= budget.capTokens && !budget.withinBudget) return "cap";
  if (budget.current > budget.capTokens && budget.delta >= 0) return "shrink";
  return null;
}

/**
 * Fixed-width ASCII gauge for `backpass status`.
 *
 * Over budget the `!!` marker gets its own cells rather than the leftover ones, because
 * past 100% there are no leftover cells: a file at twice its cap must not render as a
 * merely-full bar.
 */
export function budgetBar(status, width = 32) {
  const overflow = status.withinBudget ? 0 : Math.min(width, 2);
  const cells = width - overflow;
  const filled = Math.min(cells, Math.round(status.utilization * width));
  return `[${"#".repeat(filled)}${"!".repeat(overflow)}${".".repeat(Math.max(0, cells - filled))}]`;
}
