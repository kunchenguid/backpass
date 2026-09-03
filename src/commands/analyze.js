import path from "node:path";

import { analyzeTranscripts } from "../analyze.js";
import { UserError, color, info, json, out, warn } from "../logger.js";
import { memorySurfaceHash, resolveMemoryFiles } from "../memory.js";
import { skillDescriptionTokens } from "../skills.js";
import { loadScopeSkills } from "../target.js";
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
 * `hash` is the memory-surface hash: the memory files plus the skill description
 * lines, since analysis is judged against both. Evidence keys, fold scoping, and the
 * gap ledger all flow from this one value, so analyze and propose can never disagree
 * about which surface a judgment belongs to. The loaded `skills` ride along so every
 * downstream stage reads the same snapshot this hash describes.
 *
 * When no configured file exists, `backpass` (the default run) bootstraps one; every
 * other command fails with a pointer to that.
 *
 * `--target` narrows the write surface. A skill target makes that SKILL.md the file
 * under audit; a memory-file target still sees every skill as read-only analysis
 * context so failed triggers stay visible, but those skills are not writable.
 */
export function primaryMemoryFile(repo, config, scope = null) {
  const runTarget = config.runTarget || { kind: "surface" };
  const { skills: allSkills } = loadScopeSkills(repo, config, scope);
  if (runTarget.kind === "skill") {
    const file = runTarget.file;
    file.alwaysLoadedTokens = skillDescriptionTokens([runTarget.skill]);
    return {
      file,
      all: [file],
      hash: file.hash,
      resolved: { primary: file, all: [file], pointers: [], separate: [], hash: file.hash },
      skills: [],
      allSkills,
      runTarget,
    };
  }

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
  if (runTarget.kind !== "memory") {
    for (const other of resolved.separate) {
      const relativeImport = path
        .relative(path.dirname(other.absolute), resolved.primary.absolute)
        .split(path.sep)
        .join("/");
      const pointerImport = relativeImport;
      warn(
        `${other.path} is a separate memory file and will NOT be updated - only ${resolved.primary.path} is optimized. ` +
          `To cover both, consolidate: move its content into ${resolved.primary.path} and make ${other.path} a pointer ` +
          `(a single line: @${pointerImport}).`,
      );
    }
  }
  // Overflow-layout warnings are the synthesis stage's to print; this resolution is read-only.
  return {
    file: resolved.primary,
    all: resolved.all,
    hash: memorySurfaceHash(resolved.hash, allSkills),
    resolved,
    skills: allSkills,
    allSkills,
    runTarget,
  };
}

export async function runAnalysis(ctx) {
  const { repo, scope, config } = ctx;
  const { file, hash, skills } = primaryMemoryFile(repo, config, scope);
  // Deterministic by design: tokens and units come from parsing the file, no model.
  const descriptionTokens = skillDescriptionTokens(skills);
  const alwaysLoaded = file.alwaysLoadedTokens ?? file.tokens + descriptionTokens;
  emitProgress("memory", {
    path: file.path,
    label: skills.length ? `${file.path} + skill descriptions` : file.path,
    tokens: alwaysLoaded,
    budget: config.budgetTokens,
    units: file.units.length,
  });
  // The cap bounds the expensive per-transcript calls; cached evidence is reused as usual.
  const { transcripts, perHarness } = capTranscripts(await discoverForRun(ctx), config);

  if (!transcripts.length) {
    info(`${color.yellow("·")} no transcripts associated with this ${scope?.kind === "user" ? "user" : "repo"}`);
    return { file, hash, skills, transcripts, perHarness, summary: null };
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
  });

  return { file, hash, skills, transcripts, perHarness, summary };
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
