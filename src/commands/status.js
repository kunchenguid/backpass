import fs from "node:fs";
import path from "node:path";

import { userClaudeSkillsDir } from "../config.js";
import { color, json, out } from "../logger.js";
import { memorySurfaceHash, resolveMemoryFiles } from "../memory.js";
import {
  layerNestedWeights,
  nestedBudget,
  nestedReachWarning,
  nestedStateDir,
  readNestedReach,
  resolveNestedMemoryFiles,
} from "../nested.js";
import {
  loadProjectSkills,
  resolveOverflowTarget,
  resolveProjectSkillDirs,
  skillDescriptionTokens,
} from "../skills.js";
import { crossSurfaceDuplicates } from "../overlap.js";
import { HostCache, pruneHostCache } from "../discovery/cache.js";
import { budgetBar, budgetStatus, formatTokens } from "../tokens.js";
import { table } from "./scan.js";
import { candidateKey, isProbeEntryFresh, resolvedEffort } from "../agents.js";
import { MAX_UNPARSED_REPLIES, State } from "../state.js";

export async function cmdStatus(ctx) {
  const { repo, config, scope } = ctx;
  const state = config.state;

  const resolved = resolveMemoryFiles(repo.root, config.memoryFiles, { allowExternal: scope?.kind === "user" });
  const files = resolved.all;

  const cache = state.readScanCache();
  pruneHostCache(state.root);
  const hostCache = new HostCache(state.root).stats();
  const summary = state.readSummary();
  const proposal = state.readProposal();
  const rejections = state.readRejections();
  const userScope = scope?.kind === "user";
  const overflow = resolveOverflowTarget(repo.root, config.skillsDir, {
    claudeSkillsDir: userScope ? userClaudeSkillsDir() : undefined,
    allowExternal: userScope,
  });
  const skillDirs = resolveProjectSkillDirs(repo.root, overflow.dir, config.skillsDirs || [], { exact: userScope });
  const skills = loadProjectSkills(repo.root, overflow.dir, config.skillsDirs || [], { exact: userScope });
  const descriptionTokens = skillDescriptionTokens(skills);
  const nestedWeights = resolveNestedMemoryFiles(repo.root, config);

  // Each trained memory file keeps its own evidence store, keyed to its own surface hash.
  const trained = nestedWeights.filter((weight) => weight.file && !weight.pointerTo);
  const stores = [
    { path: resolved.primary?.path ?? null, state, memoryHash: memorySurfaceHash(resolved.hash, skills) },
    ...(resolved.primary ? layerNestedWeights(resolved.primary, trained, skills) : []).map((weight) => ({
      path: weight.path,
      state: new State(repo.root, { stateDir: nestedStateDir(state, weight.path) }),
      memoryHash: weight.hash,
    })),
  ];
  const counts = { ok: 0, failed: 0, skipped: 0 };
  const failed = [];
  const evidenceByFile = stores.map((store) => {
    const own = { path: store.path, ok: 0, failed: 0, skipped: 0, gaveUp: 0 };
    for (const e of store.state.listEvidence()) {
      counts[e.status] = (counts[e.status] || 0) + 1;
      own[e.status] = (own[e.status] || 0) + 1;
      if (e.status !== "failed") continue;
      const givenUp = isGivenUp(e, store.memoryHash);
      if (givenUp) own.gaveUp += 1;
      failed.push({ record: e, memory: store.path, givenUp });
    }
    return own;
  });
  const gaveUp = failed.filter((f) => f.givenUp).length;
  const labelMemory = stores.length > 1;

  const duplicates = files
    .filter((file) => !resolved.pointers.includes(file))
    .flatMap((file) => crossSurfaceDuplicates(file, skills));

  const budgets = files.map((file) => {
    const includesSkills = file === resolved.primary && skills.length > 0;
    return {
      path: file.path,
      label: includesSkills ? `${file.path} + skill descriptions` : file.path,
      ...budgetStatus(file.text, null, config.budgetTokens, {
        current: includesSkills ? descriptionTokens : 0,
      }),
      instructions: file.units.length,
      pointerTo: resolved.pointers.includes(file) ? resolved.primary.path : null,
      separate: resolved.separate.includes(file),
    };
  });
  // Nested memory files are weights of their own, each under its own budget.
  for (const weight of nestedWeights) {
    budgets.push({
      path: weight.path,
      label: weight.path,
      ...(weight.file ? budgetStatus(weight.file.text, null, nestedBudget(config)) : {}),
      instructions: weight.file?.units.length ?? 0,
      pointerTo: weight.pointerTo,
      separate: false,
      nested: weight.dir,
      missing: !weight.file,
    });
  }

  // How many sampled sessions each nested file could learn from at the last attribution,
  // read back from state rather than re-discovered: `status` stays instant. Report-only.
  const reach = nestedWeights.length ? readNestedReach(state) : null;
  const nestedAttribution = nestedWeights.length
    ? {
        measuredAt: reach?.measuredAt ?? null,
        files: nestedWeights
          .filter((weight) => weight.file)
          .map((weight) => {
            const entry = reach?.files.find((candidate) => candidate.path === weight.path);
            return {
              path: weight.path,
              dir: weight.dir,
              measured: Boolean(entry),
              sessions: entry?.sessions ?? null,
              sampledSessions: entry?.sampledSessions ?? null,
              minGapEvidence: entry?.minGapEvidence ?? null,
              belowMinGapEvidence: entry?.belowMinGapEvidence ?? null,
            };
          }),
      }
    : null;

  if (ctx.flags.json) {
    json({
      repo: repo.name,
      budgets,
      ...(nestedAttribution ? { nestedAttribution } : {}),
      crossSurfaceDuplicates: duplicates,
      evidence: { ...counts, gaveUp, files: evidenceByFile },
      scanCacheEntries: Object.keys(cache.entries).length,
      hosts: hostCache,
      summary: summary ? { analyzedSessions: summary.analyzedSessions, totals: summary.totals } : null,
      proposal: proposal ? { generatedAt: proposal.generatedAt, edits: proposal.edits.length } : null,
      rejections: Object.keys(rejections.entries).length,
      skills: skills.length,
    });
    return 0;
  }

  out(`${color.bold(ctx.scope?.kind === "user" ? "user scope" : repo.name)} ${color.dim(repo.root)}`);
  out("");

  out(color.dim("BUDGET (always-loaded)"));
  if (!budgets.length) out("  no memory file found");
  const width = budgets.some((b) => b.nested) ? Math.max(14, ...budgets.map((b) => b.label.length)) : 14;
  for (const b of budgets) {
    if (b.missing) {
      out(`  ${b.path.padEnd(width)} ${color.yellow("nested - does not exist, not trained")}`);
      continue;
    }
    if (b.pointerTo) {
      out(`  ${b.path.padEnd(width)} ${color.dim(`pointer to ${b.pointerTo}`)}`);
      continue;
    }
    const state_ =
      (b.withinBudget ? "" : color.red(` ${b.over} OVER`)) +
      (b.separate ? color.yellow(" separate - not optimized") : "") +
      (b.nested ? color.dim(` · nested, loads under ${b.nested}/`) : "");
    out(
      `  ${b.label.padEnd(width)} ${budgetBar(b)} ${formatTokens(b.current)} / ${formatTokens(b.capTokens)} tok` +
        ` · ${b.instructions} instructions${state_}`,
    );
  }
  if (skills.length) {
    const skillTokens = skills.reduce((n, s) => n + s.bodyTokens, 0);
    out(
      color.dim(
        `  overflow: ${skills.length} skill(s) in ${skillDirs.join(", ")} · ${formatTokens(skillTokens)} tok on trigger, ` +
          `${formatTokens(descriptionTokens)} tok always loaded`,
      ),
    );
  }
  if (nestedAttribution?.files.length) {
    out("");
    const when = nestedAttribution.measuredAt
      ? `sampled sessions at the last attribution, ${nestedAttribution.measuredAt.slice(0, 16).replace("T", " ")}; `
      : "";
    out(color.dim(`NESTED EVIDENCE REACH (${when}report-only)`));
    for (const entry of nestedAttribution.files) {
      if (!entry.measured) {
        out(`  ${entry.path}: ${color.dim("not yet measured - run `backpass` or `backpass analyze`")}`);
        continue;
      }
      out(
        `  ${entry.path}: ${entry.sessions} of ${entry.sampledSessions} sampled session(s) worked only under ${entry.dir}/`,
      );
      const warning = nestedReachWarning(entry);
      if (warning) out(`    ${color.yellow(warning)}`);
    }
  }
  if (duplicates.length) {
    out("");
    out(color.dim("CROSS-SURFACE (report-only)"));
    for (const hit of duplicates) {
      const where = hit.memoryPath && hit.memoryPath !== resolved.primary?.path ? ` ${hit.memoryPath}` : "";
      const placement =
        hit.surface === "description" ? " · duplicated always loaded" : " · body loads on trigger; weigh placement";
      out(
        `  ${hit.instruction}${where} restates ${hit.skill} ${hit.surface}` +
          ` · ${formatTokens(hit.tokens)} tok · similarity ${hit.score.toFixed(2)}${placement}`,
      );
    }
  }
  out("");

  out(color.dim("CACHE"));
  out(`  scan cache      ${Object.keys(cache.entries).length} file(s) fingerprinted`);
  out(
    `  evidence        ${counts.ok || 0} ok · ${counts.skipped || 0} skipped · ${color.red(String(counts.failed || 0))} failed` +
      (gaveUp ? ` (${gaveUp} skipped after ${MAX_UNPARSED_REPLIES} failures)` : ""),
  );
  if (summary) {
    const eligibleClusters = summary.totals.gapClusters;
    const reportOnlyClusters = summary.totals.reportOnlyGapClusters || 0;
    const totalClusters = eligibleClusters + reportOnlyClusters;
    const clusterSplit = reportOnlyClusters
      ? ` (${eligibleClusters} synthesis eligible · ${reportOnlyClusters} report only)`
      : "";
    out(
      `  gradients       ${summary.analyzedSessions} session(s) · ${summary.totals.positive}+ ` +
        `${summary.totals.negative}- · ${totalClusters} gap cluster(s)${clusterSplit}`,
    );
  }
  out(`  rejections      ${Object.keys(rejections.entries).length} remembered`);
  out("");

  const hostRows = Object.entries(hostCache);
  if (hostRows.length) {
    out(color.dim("HOSTS (fetched transcripts, pruned after 30 days unused)"));
    for (const [host, row] of hostRows) {
      out(`  ${host.padEnd(14)}  ${row.entries} transcript(s) · ${formatBytes(row.bytes)}`);
    }
    out("");
  }

  if (counts.failed) {
    out(color.dim("FAILED TRANSCRIPTS (retried on the next run unless skipped)"));
    const rows = [[...(labelMemory ? ["MEMORY"] : []), "HARNESS", "SESSION", "REPLY", "NEXT RUN", "ERROR"]];
    for (const { record: e, memory, givenUp } of failed.slice(0, 10)) {
      rows.push([
        ...(labelMemory ? [memory] : []),
        e.transcript.harness,
        String(e.transcript.id).slice(-12),
        describeReply(e.reply),
        givenUp ? `skipped after ${MAX_UNPARSED_REPLIES} failures` : "retry",
        String(e.error).slice(0, 60),
      ]);
    }
    out(table(rows));
    if (failed.some((f) => f.record.reply)) {
      out(
        color.dim(
          labelMemory
            ? "  each unparseable reply's redacted head and tail are kept in its memory file's evidence/<identity>.json" +
                " (.backpass/ for the root, .backpass/nested/<file>/ for a nested file)"
            : "  each unparseable reply's redacted head and tail are kept in .backpass/evidence/<identity>.json",
        ),
      );
    }
    out("");
  }

  out(color.dim("PROPOSAL"));
  if (!proposal) {
    out("  none yet - run `backpass`");
  } else {
    out(`  generated       ${proposal.generatedAt}`);
    out(
      `  edits           ${proposal.edits.length}${proposal.violations?.length ? color.red(" (failed its gates)") : ""}`,
    );
    const surface = path.join(state.applyDir, "apply.html");
    if (fs.existsSync(surface)) out(color.dim(`  surface         ${surface}`));
    if (!proposal.violations?.length && proposal.edits.length) out("  review with `backpass apply`");
  }

  out("");
  out(color.dim("MODELS"));
  for (const role of ["analysis", "synthesis"]) out(`  ${role.padEnd(10)}      ${describeRole(config, role)}`);
  return 0;
}

/**
 * The pick for a role without probing: a pinned agent as configured, otherwise the
 * ladder with whatever the probe cache already knows. `status` must stay instant.
 */
function describeRole(config, role) {
  const pinned = config.agents.pinned(role);
  if (pinned) {
    return `${pinned.agent}${pinned.model ? `/${pinned.model}` : ""} (effort ${formatEffort(resolvedEffort(role, pinned.agent, config))}, ${pinned.reason})`;
  }
  const cache = config.state.readProbeCache();
  for (const candidate of config.agents.ladder(role)) {
    const entry = cache.entries[candidateKey(candidate)];
    if (!isProbeEntryFresh(entry)) continue;
    if (entry.verdict === "ok") {
      return `${candidate.agent}/${entry.resolvedModel || candidate.model} (effort ${formatEffort(resolvedEffort(role, candidate.agent, config))}, auto - probed ${entry.checkedAt.slice(0, 16).replace("T", " ")})`;
    }
  }
  const configured =
    typeof config[role].effort === "string" && config[role].effort.trim() ? config[role].effort.trim() : null;
  const count = `auto - ${config.agents.ladder(role).length} candidates, none probed yet`;
  return color.dim(configured ? `${count} (effort ${configured})` : count);
}

/**
 * Whether the analysis stage gave up on a failed record at the current memory surface.
 * `status` neither discovers transcripts nor resolves the analysis agent, so a changed
 * transcript or agent still analyzes it again on the next run (`hasGivenUp` in src/analyze.js).
 */
function isGivenUp(record, memoryHash) {
  return (
    record.memoryHash === memoryHash &&
    Number.isInteger(record.unparsedReplies) &&
    record.unparsedReplies >= MAX_UNPARSED_REPLIES
  );
}

/** The class and size of an unparseable reply; "-" for any other failure or an older record. */
function describeReply(reply) {
  if (!reply || typeof reply.class !== "string") return "-";
  return Number.isInteger(reply.chars) ? `${reply.class} · ${reply.chars} chars` : reply.class;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatEffort(effort) {
  return effort || "unset";
}
