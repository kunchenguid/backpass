import { analyzeTranscripts } from "../analyze.js";
import { UserError, color, info, json, out } from "../logger.js";
import { loadMemoryFiles, memorySetHash } from "../memory.js";
import { sumUsage, formatUsage } from "../acpx.js";
import { discoverForRun } from "./scan.js";

/** The memory file a run optimizes: the first configured file that exists. */
export function primaryMemoryFile(repo, config) {
  const files = loadMemoryFiles(repo.root, config.memoryFiles);
  if (!files.length) {
    throw new UserError(
      `no memory file found (looked for ${config.memoryFiles.join(", ")})`,
      "create an AGENTS.md, or set memoryFiles in .backpassrc.json",
    );
  }
  return { file: files[0], all: files, hash: memorySetHash(files) };
}

export async function runAnalysis(ctx) {
  const { repo, config } = ctx;
  const { file, hash } = primaryMemoryFile(repo, config);
  const { transcripts, perHarness } = await discoverForRun(ctx);

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
  const usage = sumUsage(summary.usage);
  out(`  tier-1 tokens: ${formatUsage(usage)}`);
  if (summary.failed) {
    out(color.dim("  failed transcripts are listed by `backpass status` and retried next run"));
  }
  return 0;
}
