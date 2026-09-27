import { analyzeTranscripts } from "../analyze.js";
import { userClaudeSkillsDir } from "../config.js";
import { UserError, color, info, json, out, warn } from "../logger.js";
import { memorySurfaceHash, resolveMemoryFiles, separateFileWarning } from "../memory.js";
import {
  attributeTranscripts,
  nestedContext,
  renderAlsoLoaded,
  reportNestedMemoryFiles,
  resolveNestedMemoryFiles,
  nestedSurfaceHash,
  workedUnder,
} from "../nested.js";
import { transcriptIdentity } from "../transcript.js";
import { loadProjectSkills, resolveOverflowTarget, skillDescriptionTokens } from "../skills.js";
import { emitProgress } from "../progress.js";
import { closeRemoteDiscovery, discoverForRun } from "./scan.js";
import { printUsage } from "./usage.js";
import { capTranscripts } from "../sample.js";
import { prefetchRemoteTranscripts } from "../discovery/hosts.js";
import { pruneHostCache } from "../discovery/cache.js";

/**
 * The memory file a run optimizes: the first configured file that exists (AGENTS.md by
 * default - canonical). Resolution is pointer-aware: a CLAUDE.md that is just
 * `@AGENTS.md` is covered by optimizing AGENTS.md and needs no mention. A second file
 * with its own content is NOT updated - that would either be ignored silently or
 * double-written into divergence - so the run says so and recommends consolidating.
 *
 * `hash` is the memory-surface hash: the memory files plus the skill description
 * lines, since analysis is judged against both. Evidence keys, fold scoping, and the
 * gap ledger all flow from this one value, so analyze and propose can never disagree
 * about which surface a judgment belongs to. The loaded `skills` ride along so every
 * downstream stage reads the same snapshot this hash describes.
 *
 * When no configured file exists, `backpass` (the default run) bootstraps one; every
 * other command fails with a pointer to that.
 */
export function primaryMemoryFile(repo, config, scope = null) {
  const resolved = resolveMemoryFiles(repo.root, config.memoryFiles, { allowExternal: scope?.kind === "user" });
  if (!resolved.primary) {
    if (scope?.kind === "user") {
      throw new UserError(
        `no user memory file found (looked for ${config.memoryFiles.join(", ")})`,
        "set user.memoryFiles in ~/.config/backpass/config.json",
      );
    }
    throw new UserError(
      `no memory file found (looked for ${config.memoryFiles.join(", ")})`,
      "run `backpass` to bootstrap an AGENTS.md, or set memoryFiles in .backpassrc.json",
    );
  }
  for (const other of resolved.separate) warn(separateFileWarning(other, resolved.primary));
  // Overflow-layout warnings are the synthesis stage's to print; this resolution is read-only.
  const userScope = scope?.kind === "user";
  const overflow = resolveOverflowTarget(repo.root, config.skillsDir, {
    claudeSkillsDir: userScope ? userClaudeSkillsDir() : undefined,
    allowExternal: userScope,
  });
  const skills = loadProjectSkills(repo.root, overflow.dir, config.skillsDirs || [], { exact: userScope });
  // Nested memory files are weights of their own, named in `nestedMemoryFiles` - never a
  // separate root file to consolidate (`src/nested.js`).
  const named = reportNestedMemoryFiles(resolveNestedMemoryFiles(repo.root, config));
  const nested = named.map((weight) => {
    const ancestors = named
      .filter((candidate) => weight.dir.startsWith(`${candidate.dir}/`))
      .sort((a, b) => a.dir.length - b.dir.length);
    const layered = { ...weight, ancestors };
    return { ...layered, hash: nestedSurfaceHash(resolved.primary, layered, skills) };
  });
  return {
    file: resolved.primary,
    all: resolved.all,
    hash: memorySurfaceHash(resolved.hash, skills),
    resolved,
    skills,
    nested,
  };
}

export async function runAnalysis(ctx) {
  try {
    return await runAnalysisCore(ctx);
  } finally {
    await closeRemoteDiscovery(ctx);
    pruneHostCache(ctx.config.state.root);
  }
}

async function runAnalysisCore(ctx) {
  const { repo, scope, config } = ctx;
  const { file, hash, skills, nested: weights } = primaryMemoryFile(repo, config, scope);
  // Deterministic by design: tokens and units come from parsing the file, no model.
  const descriptionTokens = skillDescriptionTokens(skills);
  emitProgress("memory", {
    path: file.path,
    label: skills.length ? `${file.path} + skill descriptions` : file.path,
    tokens: file.tokens + descriptionTokens,
    budget: config.budgetTokens,
    units: file.units.length,
  });
  // The cap bounds the expensive per-transcript calls; cached evidence is reused as usual.
  const { transcripts, perHarness } = capTranscripts(await discoverForRun(ctx), config);

  if (!transcripts.length) {
    info(`${color.yellow("·")} no transcripts associated with this ${scope?.kind === "user" ? "user" : "repo"}`);
    return { file, hash, skills, transcripts, perHarness, summary: null, nested: [], attribution: null };
  }

  const summary = await analyzeTranscripts({
    transcripts,
    memoryFile: file,
    skills,
    config,
    repo,
    modelCwd: scope?.modelCwd || repo.root,
    memoryHash: hash,
    force: Boolean(ctx.flags.force),
    prefetch: (pending) => prefetchRemoteTranscripts(pending, { config }),
  });

  const { nested, attribution } = await analyzeNested(ctx, { file, skills, weights, transcripts });
  return { file, hash, skills, transcripts, perHarness, summary, nested, attribution };
}

/**
 * The sessions each nested memory file learns from: those that worked under its
 * directory (`src/nested.js`). Attribution is computed only when a nested file is named.
 */
export async function nestedCorpora(ctx, weights, transcripts, attribution = null) {
  if (!weights.length) return { corpora: [], attribution: null };
  const placed = attribution || (await attributeTranscripts(transcripts, ctx.repo, ctx.config.state));
  const corpora = weights.map((weight) => ({
    weight,
    transcripts: transcripts.filter((transcript) =>
      workedUnder(placed.get(transcriptIdentity(transcript)), weight.dir),
    ),
  }));
  return { corpora, attribution: placed };
}

/**
 * Analyze every nested memory file against its own corpus, in its own state, with the
 * root file shown as already loaded. Nothing runs when no nested file is named.
 */
async function analyzeNested(ctx, { file, skills, weights, transcripts }) {
  const { corpora, attribution } = await nestedCorpora(ctx, weights, transcripts);
  const nested = [];
  for (const { weight, transcripts: corpus } of corpora) {
    info(
      `${color.cyan("·")} ${weight.path} is a nested memory file: ${corpus.length} of ${transcripts.length} ` +
        `session(s) worked under ${weight.dir}/`,
    );
    const summary = corpus.length
      ? await analyzeTranscripts({
          transcripts: corpus,
          memoryFile: weight.file,
          skills,
          alsoLoaded: renderAlsoLoaded(file, weight),
          config: nestedContext(ctx, weight).config,
          repo: ctx.repo,
          modelCwd: ctx.scope?.modelCwd || ctx.repo.root,
          memoryHash: weight.hash,
          force: Boolean(ctx.flags.force),
        })
      : null;
    nested.push({ weight, transcripts: corpus, summary });
  }
  return { nested, attribution };
}

export async function cmdAnalyze(ctx) {
  const { file, transcripts, summary, nested = [] } = await runAnalysis(ctx);

  if (ctx.flags.json) {
    json({
      memoryFile: file.path,
      transcripts: transcripts.length,
      summary,
      ...(nested.length
        ? {
            nested: nested.map((entry) => ({
              memoryFile: entry.weight.path,
              transcripts: entry.transcripts.length,
              summary: entry.summary,
            })),
          }
        : {}),
    });
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
  for (const { weight, transcripts: corpus, summary: nestedSummary } of nested) {
    out(
      `analyzed against ${weight.path} (nested, ${weight.file.units.length} instructions, ${weight.file.tokens} tok) ` +
        `from ${corpus.length} session(s) under ${weight.dir}/`,
    );
    if (nestedSummary) {
      out(
        `  ${nestedSummary.analyzed} newly analyzed · ${nestedSummary.cached} cached · ` +
          `${nestedSummary.skipped} skipped (too short) · ${nestedSummary.failed} failed`,
      );
    }
  }
  printUsage({ tier1: [...summary.usage, ...nested.flatMap((entry) => entry.summary?.usage || [])] });
  return 0;
}
