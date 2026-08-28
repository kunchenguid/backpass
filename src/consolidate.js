import fs from "node:fs";
import path from "node:path";

import { execOneShot, extractJson, sessionPrompt, usageRecord } from "./acpx.js";
import { mergeGapEntries } from "./gap-ledger.js";
import { renderPrompt } from "./prompts.js";
import { warn } from "./logger.js";

/**
 * Pre-synthesis gap consolidation: one bounded model call that sees the full open gap
 * set for the memory file and merges entries that are paraphrases of one gap.
 *
 * This is the second half of gap identity. The first half - the analysis turn citing an
 * existing gap id (`matchesGap`) - covers a sighting that arrives AFTER its partner is
 * already on the books. It cannot cover two sightings of a brand-new gap landing in the
 * same run's parallel fan-out: neither analysis saw the other's entry, so both coin one.
 * Consolidation runs after this run's observations are recorded and before the fold
 * clusters, so those same-run paraphrases still corroborate.
 *
 * Judgment is required here by design: word-bigram similarity cannot recognize a real
 * paraphrase (measured on a production ledger: 89 entries containing at least six
 * multi-session gaps, highest cross-session score 0.34 against the 0.45 bar). The model
 * is asked only "same gap or not", the merge itself is mechanical (`mergeGapEntries`),
 * unknown ids and malformed groups are dropped, and a session is never double-counted
 * however the entries merge. Strict admission is untouched: merging changes how
 * sightings line up, never how many distinct sessions a proposal needs.
 *
 * Exactly one call per run, and only when at least two entries exist. Failure is
 * fail-soft with a warning: the run degrades to lexical identity (the pre-consolidation
 * behavior), it never aborts - the next run re-judges the same open entries.
 */

/** Ledger entries below this count never need a call; nothing could merge. */
const MIN_ENTRIES = 2;

let callCounter = 0;

function renderEntries(entries) {
  return entries
    .map((entry) => {
      const sessions = Object.keys(entry.sessions).length;
      const mistake = firstMistake(entry);
      return (
        `[${entry.id}] (sessions=${sessions}) ${entry.proposedInstruction}` +
        (mistake ? `\n    mistake: ${mistake}` : "")
      );
    })
    .join("\n");
}

function firstMistake(entry) {
  for (const obs of Object.values(entry.sessions)) {
    const flat = String(obs.mistake || "")
      .replace(/\s+/g, " ")
      .trim();
    if (flat) return flat.length > 160 ? `${flat.slice(0, 160)}...` : flat;
  }
  return "";
}

/**
 * Run the consolidation call and apply the merges to `ledger` in place.
 * Returns `{ merged, usage }`, `{ skipped }`, or `{ failed }` - never throws for a
 * model-side failure, because a run without consolidation is still a valid run.
 */
export async function consolidateGapLedger({ ledger, memoryPath, config, repo }) {
  const entries = Object.values(ledger.entries).filter((e) => e.memoryPath === memoryPath);
  if (entries.length < MIN_ENTRIES) return { skipped: "fewer than two open gaps" };
  if (!config.agents) return { skipped: "no agent resolver" };

  const prompt = renderPrompt("consolidate", { GAP_ENTRIES: renderEntries(entries) });
  const promptFile = path.join(config.state.root, "prompts", "consolidate-gaps.md");
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, prompt);

  let ranWith = null;
  let result;
  try {
    result = await config.agents.withFallthrough("analysis", async (pick) => {
      ranWith = pick.agent;
      const call = {
        agent: pick.agent,
        model: pick.model,
        promptFile,
        cwd: repo.root,
        timeoutSeconds: config.timeoutSeconds,
        promptRetries: config.promptRetries,
      };
      if (!pick.effort) return execOneShot(call);
      callCounter += 1;
      return sessionPrompt({
        ...call,
        effort: pick.effort,
        sessionName: `backpass-consolidate-${process.pid}-${callCounter}`,
      });
    });
  } catch (err) {
    warn(`gap consolidation failed (${err.message}); continuing with lexical gap identity for this run`);
    return { failed: err.message };
  }

  const parsed = extractJson(result.text);
  if (!parsed || !Array.isArray(parsed.merges)) {
    warn("gap consolidation returned no parseable merge list; continuing with lexical gap identity for this run");
    return { failed: "no parseable merge list", usage: usageRecord(ranWith, result) };
  }

  const merged = mergeGapEntries(ledger, parsed.merges);
  return { merged, usage: usageRecord(ranWith, result) };
}
