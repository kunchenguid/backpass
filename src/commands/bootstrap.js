import { analyzeTranscripts } from "../analyze.js";
import { applyDecisions, writeBootstrapFiles } from "../apply/writer.js";
import { bootstrapTargets, renderPointer, starterMemoryFile } from "../bootstrap.js";
import { UserError, color, info, json, out, warn } from "../logger.js";
import { resolveMemoryFiles } from "../memory.js";
import { emitProgress } from "../progress.js";
import { ProposalViolation } from "../proposal.js";
import { synthesizeProposal } from "../synthesize.js";
import { budgetBar, formatTokens } from "../tokens.js";
import { discoverForRun } from "./scan.js";
import { accountForConsolidationUsage, foldForRun, printProposal } from "./propose.js";

/**
 * Bootstrap: the default run when the repo has no memory file at all.
 *
 * Instead of failing, backpass seeds a starter AGENTS.md (a minimal skeleton, see
 * `src/bootstrap.js`) plus a CLAUDE.md pointer, then runs the ordinary backward pass with
 * the starter as the current weights: the transcripts' gaps and recurring mistakes
 * become the first evidence-backed instructions. Every edit of that first proposal is
 * applied directly - the file is brand new, so there is nothing to protect with the
 * human gate and `git diff` is the review. Later runs go through the normal
 * propose -> apply flow.
 *
 * Safety: files are only ever created, never overwritten, and a failure anywhere after
 * the seed still leaves a valid defaults-only memory file behind.
 */

const BOOTSTRAP_RUN_NOTE =
  "This memory file was just seeded from generic defaults and has never steered a session, " +
  "so the evidence is gaps and mistakes only. Turn recurring gaps into concrete instructions " +
  "(`add` under `## Learnings`, replacing the placeholder bullet there; never create a new " +
  "section for them) and `rewrite` any default the evidence contradicts. " +
  "Skip anything a single session suggests.";

/**
 * `deps` exists so the flow is testable offline: the three model/disk-facing stages
 * default to the real pipeline and can be swapped for fakes.
 */
export async function bootstrapRun(ctx, deps = {}) {
  const { repo, config } = ctx;
  const discover = deps.discover || discoverForRun;
  const analyze = deps.analyze || analyzeTranscripts;
  const synthesize = deps.synthesize || synthesizeProposal;
  const fold = deps.fold || foldForRun;
  const { canonical, pointer } = bootstrapTargets(config.memoryFiles);

  const { transcripts, perHarness } = await discover(ctx);
  info(
    `${color.yellow("·")} no memory file found (looked for ${config.memoryFiles.join(", ")}) - ` +
      `bootstrapping ${canonical} from ${transcripts.length} transcript(s) + defaults`,
  );

  const starter = starterMemoryFile(repo, canonical);
  const seed = [{ path: canonical, text: starter.text }];
  if (pointer) seed.push({ path: pointer, text: renderPointer(canonical) });
  const seeded = writeBootstrapFiles(repo.root, seed);
  const resolved = resolveMemoryFiles(repo.root, config.memoryFiles);
  for (const w of seeded.written) info(`${color.green("·")} wrote ${w.file}`);
  for (const s of seeded.skipped) warn(`${s.file} ${s.reason} - left untouched`);

  const canonicalSkipped = seeded.skipped.some((entry) => entry.file === canonical);
  if (canonicalSkipped || resolved.primary?.path !== starter.path || resolved.primary?.text !== starter.text) {
    throw new UserError(
      `${canonical} changed while backpass was bootstrapping it`,
      "run `backpass` again to analyze the memory file that now exists",
    );
  }
  const memoryFile = resolved.primary;
  const memoryHash = resolved.hash;

  emitProgress("memory", {
    path: memoryFile.path,
    tokens: memoryFile.tokens,
    budget: config.budgetTokens,
    units: memoryFile.units.length,
  });

  const result = {
    bootstrap: true,
    seededFrom: "defaults",
    files: seeded,
    memoryFile: canonical,
    transcripts: transcripts.length,
    perHarness,
    summary: null,
    proposal: null,
    applied: null,
  };

  if (!transcripts.length) return result;

  result.summary = await analyze({
    transcripts,
    memoryFile,
    config,
    repo,
    memoryHash,
    force: Boolean(ctx.flags.force),
  });
  info(
    `${color.cyan("·")} evidence: ${result.summary.analyzed} new · ${result.summary.cached} cached · ` +
      `${result.summary.skipped} too short · ${result.summary.failed} failed`,
  );

  const folded = await fold(ctx, memoryFile, memoryHash);
  config.state.writeSummary(folded);
  emitProgress("fold:done", {
    instructions: folded.instructions.length,
    clustersFound: folded.totals.gapClusters + folded.totals.droppedGapSingletons,
    clustersKept: folded.totals.gapClusters,
    minGapEvidence: config.minGapEvidence,
    ms: 0,
  });
  if (!folded.analyzedSessions) return result;

  try {
    const { proposal } = await synthesize({
      memoryFile,
      summary: folded,
      config,
      repo,
      transcripts,
      runNote: BOOTSTRAP_RUN_NOTE,
    });
    accountForConsolidationUsage(proposal, folded);
    const decisions = Object.fromEntries(proposal.edits.map((e) => [e.id, "accepted"]));
    const applied = applyDecisions({ proposal, decisions, repo, state: config.state, config });
    proposal.appliedAt = new Date().toISOString();
    proposal.appliedBy = "bootstrap";
    config.state.writeProposal(proposal);
    result.proposal = proposal;
    result.applied = applied;
    if (proposal.edits.length) result.seededFrom = "transcripts + defaults";
  } catch (err) {
    if (!(err instanceof ProposalViolation)) throw err;
    // The seed is already on disk, so a bad synthesis degrades to defaults-only.
    for (const violation of err.violations) warn(violation);
    warn("gradient descent failed its gates; the memory file stays defaults-only this run");
  }
  return result;
}

export function printBootstrap(result, config) {
  out("");
  const files = result.files.written.map((w) => w.file).join(" + ");
  out(`${color.bold("bootstrapped")} ${files || "nothing"} ${color.dim(`(seeded from ${result.seededFrom})`)}`);
  for (const s of result.files.skipped) out(`  ${color.yellow("kept")} ${s.file} (${s.reason})`);

  if (!result.transcripts) {
    out("  no transcripts associated with this repo yet - the defaults stand until later runs find some");
    out(color.dim("  `backpass scan --since all` widens the time window"));
  } else if (!result.proposal) {
    out(`  ${result.transcripts} transcript(s) found, but none produced usable evidence; defaults stand`);
  } else {
    printProposal(result.proposal, { applied: true });
    for (const w of result.applied.written) {
      out(`  ${color.green("wrote")} ${w.file} (${w.edits.join(", ")})`);
      if (w.budget) {
        out(
          `    budget ${budgetBar(w.budget)} ${formatTokens(w.budget.current)} -> ` +
            `${formatTokens(w.budget.projected)} / ${formatTokens(w.budget.capTokens)} tok`,
        );
      }
    }
    for (const s of result.applied.skills) out(`  ${color.green("wrote")} ${s.path} (new skill)`);
    for (const f of result.applied.failed) {
      out(`  ${color.red("failed")} ${f.file}${f.edit ? ` (${f.edit})` : ""}: ${f.error}`);
    }
  }
  out("");
  out(
    `Review with \`git diff\`; later runs keep refining under the ${formatTokens(config.budgetTokens)}-token budget.`,
  );
}

export function bootstrapJson(result) {
  json({
    bootstrap: true,
    seededFrom: result.seededFrom,
    memoryFile: result.memoryFile,
    files: result.files,
    transcripts: result.transcripts,
    proposal: result.proposal,
    applied: result.applied,
  });
}
