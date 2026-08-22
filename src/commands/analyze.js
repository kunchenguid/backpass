import { analyzeTranscripts } from "../analyze.js";
import { UserError, color, info, json, out, warn } from "../logger.js";
import { resolveMemoryFiles } from "../memory.js";
import { emitProgress } from "../progress.js";
import { discoverForRun } from "./scan.js";
import { printUsage } from "./usage.js";
import { capTranscripts } from "../sample.js";

/**
 * The memory file a run optimizes: the first configured file that exists (AGENTS.md by
 * default - canonical). Resolution is pointer-aware: a CLAUDE.md that is just
 * `@AGENTS.md` is covered by optimizing AGENTS.md and needs no mention. A second file
 * with its own content is NOT updated - that would either be ignored silently or
 * double-written into divergence - so the run says so and recommends consolidating.
 *
 * When no configured file exists, `backpass` (the default run) bootstraps one; every
 * other command fails with a pointer to that.
 */
export function primaryMemoryFile(repo, config) {
  const resolved = resolveMemoryFiles(repo.root, config.memoryFiles);
  if (!resolved.primary) {
    throw new UserError(
      `no memory file found (looked for ${config.memoryFiles.join(", ")})`,
      "run `backpass` to bootstrap an AGENTS.md, or set memoryFiles in .backpassrc.json",
    );
  }
  for (const other of resolved.separate) {
    warn(
      `${other.path} is a separate memory file and will NOT be updated - only ${resolved.primary.path} is optimized. ` +
        `To cover both, consolidate: move its content into ${resolved.primary.path} and make ${other.path} a pointer ` +
        `(a single line: @${resolved.primary.path}).`,
    );
  }
  return { file: resolved.primary, all: resolved.all, hash: resolved.hash, resolved };
}

export async function runAnalysis(ctx) {
  const { repo, config } = ctx;
  const { file, hash } = primaryMemoryFile(repo, config);
  // Deterministic by design: tokens and units come from parsing the file, no model.
  emitProgress("memory", {
    path: file.path,
    tokens: file.tokens,
    budget: config.budgetTokens,
    units: file.units.length,
  });
  // The cap bounds the expensive per-transcript calls; cached evidence is reused as usual.
  const { transcripts, perHarness } = capTranscripts(await discoverForRun(ctx), config);

  if (!transcripts.length) {
    info(`${color.yellow("·")} no transcripts associated with this repo`);
    return { file, hash, transcripts, perHarness, summary: null };
  }

  const summary = await analyzeTranscripts({
    transcripts,
    memoryFile: file,
    config,
    repo,
    memoryHash: hash,
    force: Boolean(ctx.flags.force),
  });

  return { file, hash, transcripts, perHarness, summary };
}

export async function cmdAnalyze(ctx) {
  const { file, transcripts, summary } = await runAnalysis(ctx);

  if (ctx.flags.json) {
    json({ memoryFile: file.path, transcripts: transcripts.length, summary });
    return 0;
  }

  if (!summary) return 0;

  out("");
  out(`analyzed against ${file.path} (${file.units.length} instructions, ${file.tokens} tok)`);
  out(
    `  ${summary.analyzed} newly analyzed · ${summary.cached} cached · ` +
      `${summary.skipped} skipped (too short) · ${summary.failed} failed`,
  );
  if (summary.failed) {
    out(color.dim("  failed transcripts are listed by `backpass status` and retried next run"));
  }
  printUsage({ tier1: summary.usage });
  return 0;
}
