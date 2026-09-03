import fs from "node:fs";

import { loadConfig } from "./config.js";
import { classifyInteraction, INTERACTIVE, NON_INTERACTIVE } from "./interaction.js";
import { findInstructionUnit, instructionUnits, resolveMemoryFiles, similarity } from "./memory.js";
import { GAP_COVERED_THRESHOLD, GAP_SIMILARITY_THRESHOLD, gapSource, normalizeSourceLabel } from "./gap-ledger.js";
import { crossSurfaceDuplicates } from "./overlap.js";

/**
 * Stage 2 of the pipeline (design section 3): fold per-transcript evidence into one
 * compact summary. Entirely deterministic - no model involved.
 *
 * Four things happen here that the synthesis pass depends on:
 *
 *  1. Evidence is grouped by instruction id, giving per-instruction positive/negative
 *     counts and, crucially, `relevance` = sessions where the instruction drew any
 *     evidence / sessions analyzed, plus the same ratio split by interactive vs
 *     non-interactive so a robot-heavy corpus cannot hide that an instruction only
 *     fired in one category. That ratio is what decides memory-file vs skill
 *     placement in section 7.
 *  2. Near-duplicate gaps from different sessions are clustered, so "three sessions
 *     re-derived the db schema" arrives as one item with three quotes. Judged identity
 *     happens upstream (analysis citations and the consolidation pass reshape the
 *     ledger); the clustering here stays deterministic. Per-sighting `domain` votes
 *     travel with the cluster; the fold decides the cluster domain after grouping
 *     (majority orchestration is excluded from proposals; mixed clusters stay visible).
 *  3. Gap clusters below `minGapEvidence` are ineligible for synthesis. Mixed-domain
 *     clusters remain visible as report-only diagnostics; other under-floor clusters are
 *     dropped. Batch size > 1 means one bad session never rewrites the weights. Sessions
 *     are counted across runs, not per run: when the caller passes `gapObservations` (the
 *     pruned gap ledger, `src/gap-ledger.js`) the clusters are built from those instead of
 *     this run's records, so a gap seen once now and once on a later run graduates. Without
 *     a ledger the records alone are used.
 *  4. Memory-file units whose text substantially overlaps a skill description or body are
 *     flagged (`crossSurfaceDuplicates` in `src/overlap.js`). Description overlap exposes
 *     duplicated always-loaded tokens; body overlap is placement evidence because skill
 *     bodies load only on trigger. Both are report-only: nothing is deleted here.
 */

/**
 * @param {object[]} evidenceRecords
 * @param {{ minGapEvidence?: number, minGapProjects?: number, checkProjectCoverage?: boolean, memoryFile?: object|null, gapObservations?: object[]|null, skills?: object[] }} [options]
 */
export function foldEvidence(
  evidenceRecords,
  {
    minGapEvidence = 2,
    minGapProjects = 0,
    checkProjectCoverage = false,
    memoryFile = null,
    gapObservations = null,
    skills = [],
  } = {},
) {
  const usable = evidenceRecords.filter((e) => e && e.status === "ok");
  const analyzedSessions = usable.length;
  const analyzedByInteraction = { [INTERACTIVE]: 0, [NON_INTERACTIVE]: 0 };
  const analyzedByProject = new Map();
  for (const record of usable) {
    analyzedByInteraction[classifyInteraction(record.transcript)] += 1;
    const projectKey = record.transcript?.project;
    if (projectKey) analyzedByProject.set(projectKey, (analyzedByProject.get(projectKey) || 0) + 1);
  }

  const instructions = new Map();
  let positiveCount = 0;
  let negativeCount = 0;
  let usedRawCount = 0;

  const touch = (id) => {
    if (!instructions.has(id)) {
      instructions.set(id, {
        instruction: id,
        positive: 0,
        negative: 0,
        sessions: new Set(),
        sessionsByInteraction: { [INTERACTIVE]: new Set(), [NON_INTERACTIVE]: new Set() },
        sessionsByProject: new Map(),
        harmSessions: new Set(),
        nonComplianceSessions: new Set(),
        quotes: [],
      });
    }
    return instructions.get(id);
  };

  const recordObservations = [];
  // Which project each quote's source label came from. Instruction-row quotes carry no
  // project of their own, so this is what lets the user-scope project floor count a
  // rewrite's evidence instead of only a gap cluster's. `sources` is the same labels
  // without the project requirement, so a project-scoped run still has an allowlist.
  const sources = new Set();
  const sourceProjects = {};
  for (const record of usable) {
    if (record.usedRawTranscript) usedRawCount += 1;
    const source = normalizeSourceLabel(gapSource(record.transcript));
    sources.add(source);
    if (record.transcript.project) sourceProjects[source] = record.transcript.project;

    for (const polarity of ["positive", "negative"]) {
      for (const item of record[polarity] || []) {
        const entry = touch(item.instruction);
        entry[polarity] += 1;
        const sessionIdentity = record.transcript.identity || record.transcript.id;
        const category = classifyInteraction(record.transcript);
        entry.sessions.add(sessionIdentity);
        entry.sessionsByInteraction[category].add(sessionIdentity);
        const projectKey = record.transcript.project;
        if (projectKey) {
          if (!entry.sessionsByProject.has(projectKey)) entry.sessionsByProject.set(projectKey, new Set());
          entry.sessionsByProject.get(projectKey).add(sessionIdentity);
        }
        // `class` is what a negative means (harm vs non-compliance vs irrelevant);
        // `harmSessions` is what the removal-evidence floor counts. A record from
        // before the class existed carries none and never counts as harm.
        if (polarity === "negative" && item.class === "harm") entry.harmSessions.add(sessionIdentity);
        if (polarity === "negative" && item.class === "non-compliance") {
          entry.nonComplianceSessions.add(sessionIdentity);
        }
        entry.quotes.push({
          polarity,
          text: item.quote,
          effect: item.effect,
          moment: item.moment,
          class: polarity === "negative" ? (item.class ?? null) : undefined,
          source,
        });
        if (polarity === "positive") positiveCount += 1;
        else negativeCount += 1;
      }
    }

    for (const gap of record.gaps || []) {
      recordObservations.push({
        proposedInstruction: gap.proposedInstruction,
        mistake: gap.mistake,
        quote: gap.quote,
        recurrenceRisk: gap.recurrenceRisk,
        source,
        sessionId: record.transcript.identity || record.transcript.id,
        domain: gap.domain === "orchestration" ? "orchestration" : "project",
        project: record.transcript.project || null,
        projectRoot: record.transcript.projectRoot || null,
        ...(gap.coveredBySkill ? { coveredBySkill: gap.coveredBySkill } : {}),
      });
    }
  }

  // Orchestration-domain votes are mistakes caused not by this repository but by the
  // external agent harness or tooling that orchestrated the session. They still cluster
  // with project sightings of the same gap; a cluster is withheld from proposals only
  // when a majority of its sightings vote orchestration. Mixed clusters stay visible
  // so one inconsistent classifier call cannot drop a real recurrence below the floor.
  const allObservations = gapObservations ?? recordObservations;
  for (const observation of allObservations) {
    const source = normalizeSourceLabel(observation?.source);
    if (source) sources.add(source);
  }
  const orchestrationGapSightings = allObservations.filter((obs) => obs?.domain === "orchestration").length;

  const gapClusters = clusterGapObservations(allObservations, { checkProjectCoverage });

  // Instructions that exist in the file but drew no evidence at all are the strongest
  // removal / extraction candidates, so they must appear in the summary too.
  if (memoryFile) {
    for (const unit of instructionUnits(memoryFile)) touch(unit.id);
  }

  const duplicates = crossSurfaceDuplicates(memoryFile, skills);
  const overlapById = new Map(duplicates.map((hit) => [hit.instruction, hit]));

  const parentHarmSessions = parentSessionCounts(memoryFile, instructions, "harmSessions");
  const parentNonComplianceSessions = parentSessionCounts(memoryFile, instructions, "nonComplianceSessions");

  const instructionRows = [...instructions.values()]
    .map((entry) => {
      const unit = findInstructionUnit(memoryFile, entry.instruction);
      const skillOverlap = overlapById.get(entry.instruction);
      return {
        instruction: entry.instruction,
        positive: entry.positive,
        negative: entry.negative,
        harmSessions: entry.harmSessions.size,
        sessions: entry.sessions.size,
        relevance: analyzedSessions ? entry.sessions.size / analyzedSessions : 0,
        relevanceByInteraction: {
          [INTERACTIVE]: analyzedByInteraction[INTERACTIVE]
            ? entry.sessionsByInteraction[INTERACTIVE].size / analyzedByInteraction[INTERACTIVE]
            : 0,
          [NON_INTERACTIVE]: analyzedByInteraction[NON_INTERACTIVE]
            ? entry.sessionsByInteraction[NON_INTERACTIVE].size / analyzedByInteraction[NON_INTERACTIVE]
            : 0,
        },
        ...(analyzedByProject.size
          ? { relevanceByProject: relevanceByProject(entry.sessionsByProject, analyzedByProject) }
          : {}),
        tokens: unit?.tokens ?? null,
        section: unit?.section ?? null,
        known: Boolean(unit),
        parentId: unit?.parentId ?? null,
        nonCompliance: entry.quotes.filter((q) => q.polarity === "negative" && q.class === "non-compliance").length,
        nonComplianceSessions: entry.nonComplianceSessions.size,
        quotes: entry.quotes.slice(0, 6),
        ...(skillOverlap ? { skillOverlap } : {}),
      };
    })
    .sort((a, b) => b.negative - a.negative || b.sessions - a.sessions || a.instruction.localeCompare(b.instruction));

  const decided = gapClusters.map((cluster) => {
    const eligibleItems = cluster.items.filter((item) => !item.projectCovered);
    const vote = clusterDomainVote(eligibleItems);
    return {
      proposedInstruction: cluster.proposedInstruction,
      sessions: cluster.sessions.size,
      projects: cluster.projects.size,
      projectCoveredSessions: cluster.projectCoveredSessions.size,
      recurrenceRisk: highestRisk(eligibleItems),
      quotes: eligibleItems.slice(0, 6).map((i) => ({ text: i.quote, effect: i.mistake, source: i.source })),
      orchestrationSightings: vote.orchestrationSightings,
      mixed: vote.mixed,
      majorityOrchestration: vote.majorityOrchestration,
      ...failedTriggerOf(eligibleItems, minGapEvidence),
      ...projectSpecificNote(cluster, minGapProjects),
    };
  });

  const proposalClusters = decided.filter((cluster) => !cluster.majorityOrchestration);
  // Default 1 means the gate exists but does not require a second project.
  const clearsProjectGate = (cluster) => minGapProjects < 2 || cluster.projects >= minGapProjects;
  const gaps = proposalClusters
    .filter((cluster) => cluster.sessions >= minGapEvidence && clearsProjectGate(cluster))
    .sort((a, b) => b.sessions - a.sessions);
  const reportOnlyGaps = decided
    .filter((cluster) =>
      cluster.mixed
        ? cluster.majorityOrchestration || cluster.sessions < minGapEvidence || !clearsProjectGate(cluster)
        : (cluster.majorityOrchestration && cluster.sessions >= minGapEvidence) ||
          (cluster.sessions >= minGapEvidence && !clearsProjectGate(cluster) && !cluster.majorityOrchestration),
    )
    .sort((a, b) => b.sessions - a.sessions);

  const droppedGapSingletons = decided.filter((cluster) => cluster.sessions < minGapEvidence && !cluster.mixed).length;

  // Why each report-only cluster is report-only, in the same priority the filter above
  // uses. Display only: the apply surface names the reason on its own drop line instead
  // of lumping three different refusals under one count. Nothing here gates anything.
  const reportOnlyByReason = { majorityOrchestration: 0, belowFloorMixed: 0, tooFewProjects: 0 };
  for (const cluster of reportOnlyGaps) {
    if (cluster.majorityOrchestration) reportOnlyByReason.majorityOrchestration += 1;
    else if (cluster.sessions < minGapEvidence) reportOnlyByReason.belowFloorMixed += 1;
    else reportOnlyByReason.tooFewProjects += 1;
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    analyzedSessions,
    analyzedByInteraction,
    totals: {
      positive: positiveCount,
      negative: negativeCount,
      // The missing-instruction lane's findings count: every sighting this fold clustered
      // over (the pruned ledger when one is passed, this run's records otherwise).
      // Orchestration sightings are per-sighting votes; cluster domain is decided after grouping.
      gapSightings: allObservations.length,
      gapClusters: gaps.length,
      reportOnlyGapClusters: reportOnlyGaps.length,
      reportOnlyByReason,
      droppedGapSingletons,
      orchestrationGapSightings,
      // The existing-instruction lane's candidate count: how many instructions the
      // negatives land on. Display only; no gate reads it.
      instructionsWithNegatives: instructionRows.filter((row) => row.negative > 0).length,
      usedRawTranscript: usedRawCount,
      crossSurfaceDuplicates: duplicates.length,
    },
    instructions: instructionRows,
    sources: [...sources],
    sourceProjects,
    parentHarmSessions,
    gaps,
    crossSurfaceDuplicates: duplicates,
    reportOnlyGaps,
    oversized: oversizedRestructureTargets(memoryFile, parentNonComplianceSessions, minGapEvidence),
  };
}

function parentSessionCounts(memoryFile, instructions, field) {
  const counts = {};
  for (const unit of memoryFile?.units || []) {
    if (!unit.parts?.length) continue;
    const sessions = new Set(instructions.get(unit.id)?.[field] || []);
    for (const part of unit.parts) {
      for (const session of instructions.get(part.id)?.[field] || []) sessions.add(session);
    }
    counts[unit.id] = sessions.size;
  }
  return counts;
}

/**
 * An oversized paragraph whose sentence-parts drew repeated non-compliance. Synthesis
 * should split that blob into list items, not slap a bold label on it.
 */
function oversizedRestructureTargets(memoryFile, nonComplianceSessions, minGapEvidence) {
  if (!memoryFile) return [];
  const targets = [];
  for (const unit of memoryFile.units) {
    if (!unit.parts?.length) continue;
    const sessions = nonComplianceSessions[unit.id] || 0;
    if (sessions < minGapEvidence) continue;
    targets.push({
      id: unit.id,
      tokens: unit.tokens,
      parts: unit.parts.map((part) => part.id),
      sessions,
    });
  }
  return targets;
}

/**
 * Greedy similarity clustering over gap observations. A cluster counts each session once
 * no matter how many observations it contributed (re-analysis, duplicate reports).
 * A user-scope sighting the session's own project memory already covers is recorded but
 * does not count toward `sessions` or `projects`.
 */
export function clusterGapObservations(observations, { checkProjectCoverage = false } = {}) {
  const clusters = [];
  for (const obs of observations) {
    if (!obs || !obs.proposedInstruction) continue;
    const projectCovered = Boolean(checkProjectCoverage && isProjectCoveredSighting(obs));
    const cluster = clusters.find(
      (c) => similarity(c.proposedInstruction, obs.proposedInstruction) >= GAP_SIMILARITY_THRESHOLD,
    );
    const item = {
      mistake: obs.mistake,
      quote: obs.quote,
      recurrenceRisk: obs.recurrenceRisk,
      source: obs.source,
      sessionId: obs.sessionId,
      domain: observationDomain(obs),
      project: obs.project || null,
      projectCovered,
      coveredBySkills: new Set(obs.coveredBySkill ? [obs.coveredBySkill] : []),
    };
    if (cluster) {
      const sessionItem = cluster.items.find((candidate) => candidate.sessionId === obs.sessionId);
      if (sessionItem) {
        if (obs.coveredBySkill) sessionItem.coveredBySkills.add(obs.coveredBySkill);
        if (observationDomain(obs) !== "orchestration") sessionItem.domain = "project";
        if (projectCovered) sessionItem.projectCovered = true;
      } else {
        cluster.items.push(item);
      }
      if (obs.proposedInstruction.length < cluster.proposedInstruction.length) {
        cluster.proposedInstruction = obs.proposedInstruction;
      }
    } else {
      clusters.push({
        proposedInstruction: obs.proposedInstruction,
        sessions: new Set(),
        projects: new Set(),
        projectCoveredSessions: new Set(),
        items: [item],
      });
    }
  }
  for (const cluster of clusters) {
    cluster.sessions = new Set(cluster.items.filter((item) => !item.projectCovered).map((item) => item.sessionId));
    cluster.projects = new Set(
      cluster.items.filter((item) => !item.projectCovered && item.project).map((item) => item.project),
    );
    cluster.projectCoveredSessions = new Set(
      cluster.items.filter((item) => item.projectCovered).map((item) => item.sessionId),
    );
  }
  return clusters;
}

function isProjectCoveredSighting(obs) {
  const root = obs.projectRoot;
  const phrasings = obs.phrasings?.length ? obs.phrasings : [obs.proposedInstruction];
  if (!root || !phrasings.some(Boolean)) return false;
  try {
    if (!fs.existsSync(root)) return false;
    const resolved = resolveMemoryFiles(root, loadConfig(root).memoryFiles);
    if (!resolved.primary) return false;
    return resolved.all
      .filter((file) => !resolved.pointers.includes(file))
      .some((file) =>
        instructionUnits(file).some((unit) =>
          phrasings.some((phrasing) => similarity(unit.text, phrasing) >= GAP_COVERED_THRESHOLD),
        ),
      );
  } catch {
    return false;
  }
}

function projectSpecificNote(cluster, minGapProjects) {
  if (minGapProjects < 2 || cluster.projects.size >= minGapProjects || cluster.sessions.size < 1) return {};
  const projects = [...cluster.projects];
  if (projects.length === 1) {
    return {
      reportOnlyReason: `project-specific: seen in ${projects[0]} only; run \`backpass\` there`,
    };
  }
  return {
    reportOnlyReason: projects.length
      ? `project-specific: seen in ${projects.length} projects; minGapProjects is ${minGapProjects}`
      : "project-specific: below minGapProjects",
  };
}

function relevanceByProject(sessionsByProject, analyzedByProject, topK = 5) {
  const rows = [...sessionsByProject.entries()]
    .map(([project, sessions]) => ({
      project,
      relevance: analyzedByProject.get(project) ? sessions.size / analyzedByProject.get(project) : 0,
      sessions: sessions.size,
    }))
    .sort((a, b) => b.sessions - a.sessions || a.project.localeCompare(b.project));
  const top = rows.slice(0, topK);
  const rest = rows.slice(topK);
  const out = Object.fromEntries(top.map((row) => [row.project, row.relevance]));
  if (rest.length) {
    const sessions = rest.reduce((n, row) => n + row.sessions, 0);
    const analyzed = rest.reduce((n, row) => n + (analyzedByProject.get(row.project) || 0), 0);
    out.other = analyzed ? sessions / analyzed : 0;
  }
  return out;
}

function observationDomain(obs) {
  return obs?.domain === "orchestration" ? "orchestration" : "project";
}

/**
 * Cluster domain is a majority of per-sighting votes, not a pre-filter. Ties (including
 * 1 of 2) stay project so one inconsistent analysis call cannot kill a real recurrence.
 */
function clusterDomainVote(items) {
  const orchestrationSightings = items.filter((item) => item.domain === "orchestration").length;
  const sightings = items.length;
  return {
    orchestrationSightings,
    mixed: orchestrationSightings > 0 && orchestrationSightings < sightings,
    majorityOrchestration: sightings > 0 && orchestrationSightings * 2 > sightings,
  };
}

function highestRisk(items) {
  const order = { high: 3, medium: 2, low: 1 };
  return items.reduce((best, i) => (order[i.recurrenceRisk] > order[best] ? i.recurrenceRisk : best), "low");
}

/**
 * The failed-trigger reading of a cluster: which existing skill the analyses judged to
 * already cover this mistake, and in how many of the cluster's sessions. Items are one
 * per session, so counting items counts sessions. The most-cited skill wins; a cluster
 * nobody tied to a skill contributes nothing.
 */
function failedTriggerOf(items, minGapEvidence) {
  const counts = new Map();
  for (const item of items) {
    for (const skill of item.coveredBySkills) {
      counts.set(skill, (counts.get(skill) || 0) + 1);
    }
  }
  let best = null;
  for (const [skill, sessions] of counts) {
    if (!best || sessions > best.sessions) best = { skill, sessions };
  }
  return best && best.sessions >= minGapEvidence
    ? { failedTriggerSkill: best.skill, failedTriggerSessions: best.sessions }
    : {};
}

function renderSkillOverlap(lines, overlap) {
  const match =
    `    CROSS-SURFACE: restates skill "${overlap.skill}" ${overlap.surface} ` +
    `(similarity ${overlap.score.toFixed(2)})`;
  if (overlap.surface === "description") {
    lines.push(
      `${match} - duplicated always-loaded tokens; ` +
        `drop the memory-file copy, do not treat it as a second instruction`,
    );
  } else {
    lines.push(
      `${match} - triggered skill-body overlap (report-only); weigh relevance and trigger suitability, ` +
        `do not infer the memory-file copy should be dropped`,
    );
  }
}

/** Compact rendering of the folded evidence for the synthesis prompt. */
export function renderEvidenceForPrompt(summary) {
  return renderEvidence(summary, { includeReportOnly: false });
}

/** Full evidence report, including diagnostics that must never reach synthesis. */
export function renderEvidenceReport(summary) {
  return renderEvidence(summary, { includeReportOnly: true });
}

function renderEvidence(summary, { includeReportOnly }) {
  const lines = [];

  const mix = summary.analyzedByInteraction;
  const mixBit = mix ? ` (interactive ${mix[INTERACTIVE] || 0} · non-interactive ${mix[NON_INTERACTIVE] || 0})` : "";
  lines.push(`Sessions analyzed: ${summary.analyzedSessions}${mixBit}`);
  const reportOnlyGapClusters = summary.totals.reportOnlyGapClusters || 0;
  const totalGapClusters = summary.totals.gapClusters + reportOnlyGapClusters;
  lines.push(
    `Totals: ${summary.totals.positive} positive, ${summary.totals.negative} negative, ` +
      `${totalGapClusters} gap clusters (${summary.totals.gapClusters} synthesis eligible, ` +
      `${reportOnlyGapClusters} report only, ${summary.totals.droppedGapSingletons} singletons dropped below threshold)`,
  );
  lines.push("");
  lines.push("### Per-instruction evidence");
  lines.push(
    "A negative's class is what it means: `harm` = following the instruction caused damage " +
      "(evidence against it); `non-compliance` = the agent ignored it (evidence it failed to " +
      "steer - argues for reinforcement, never deletion); `irrelevant` = no real bearing.",
  );
  for (const row of summary.instructions) {
    const relevance = `${(row.relevance * 100).toFixed(1)}%`;
    const byCategory = row.relevanceByInteraction
      ? ` (interactive ${(row.relevanceByInteraction[INTERACTIVE] * 100).toFixed(1)}% · non-interactive ${(row.relevanceByInteraction[NON_INTERACTIVE] * 100).toFixed(1)}%)`
      : "";
    const cost = row.tokens === null ? "" : ` cost=${row.tokens}tok`;
    const harm = row.negative > 0 ? ` harm-sessions=${row.harmSessions ?? 0}` : "";
    lines.push(
      `- [${row.instruction}] +${row.positive} -${row.negative}${harm} sessions=${row.sessions} relevance=${relevance}${byCategory}${cost}` +
        (row.known ? "" : " (id not found in current file - stale reference)"),
    );
    if (row.skillOverlap) renderSkillOverlap(lines, row.skillOverlap);
    for (const quote of row.quotes.slice(0, 3)) {
      const sign = quote.polarity === "negative" ? "-" : "+";
      const cls = quote.polarity === "negative" ? ` [${quote.class ?? "unclassified"}]` : "";
      const effect = quote.effect ? ` :: ${oneLine(quote.effect, 200)}` : "";
      lines.push(`    ${sign}${cls} "${oneLine(quote.text)}"${effect} (${quote.source})`);
    }
  }

  const representedOverlaps = new Set(
    summary.instructions.filter((row) => row.skillOverlap).map((row) => row.instruction),
  );
  const parentOverlaps = (summary.crossSurfaceDuplicates || []).filter(
    (overlap) => !representedOverlaps.has(overlap.instruction),
  );
  if (parentOverlaps.length) {
    lines.push("");
    lines.push("Parent paragraph cross-surface overlap:");
    for (const overlap of parentOverlaps) {
      lines.push(`- ${overlap.instruction} parent paragraph`);
      renderSkillOverlap(lines, overlap);
    }
  }

  const parentHarm = Object.entries(summary.parentHarmSessions || {}).filter(([, sessions]) => sessions > 0);
  if (parentHarm.length) {
    lines.push("");
    lines.push("Parent paragraph removal evidence aggregated across sentence parts:");
    for (const [id, sessions] of parentHarm) lines.push(`- ${id} harm-sessions=${sessions}`);
  }

  if (summary.oversized?.length) {
    lines.push("");
    lines.push("### Oversized units that failed to steer");
    lines.push(
      "These are one paragraph apiece. Preferred reinforcement is a restructure-in-place: split " +
        "the paragraph into list items so each claim can be followed. A bold label on the blob is " +
        "not a strengthen.",
    );
    for (const blob of summary.oversized) {
      const parts = blob.parts.map((id) => `[${id}]`).join(", ");
      lines.push(
        `- ${blob.id} is ${blob.tokens} tokens as one paragraph (attribution: ${parts}). ` +
          `Split it into list items; do not decorate the blob.`,
      );
    }
  }

  lines.push("");
  lines.push("### Synthesis-eligible gap clusters (mistakes no current instruction covers)");
  if (summary.totals.orchestrationGapSightings) {
    lines.push(
      `- ${summary.totals.orchestrationGapSightings} orchestration-domain sighting(s) counted as domain ` +
        `votes (clusters excluded only on a majority vote); they never enter this repository's memory file ` +
        `as their own instruction`,
    );
  }
  if (!summary.gaps.length) {
    lines.push(
      summary.reportOnlyGaps?.length
        ? "- no gap cluster is eligible for a repository proposal"
        : "- none above the evidence threshold",
    );
  }
  for (const gap of summary.gaps) {
    lines.push(`- ${gapSessionLabel(gap)} risk=${gap.recurrenceRisk} :: ${gap.proposedInstruction}`);
    if (gap.failedTriggerSkill) {
      lines.push(
        `    FAILED TRIGGER: the existing skill "${gap.failedTriggerSkill}" already covers this ` +
          `(judged so in ${gap.failedTriggerSessions} session(s)) - fix that skill's description ` +
          `line instead of duplicating its content in the memory file`,
      );
    }
    for (const quote of gap.quotes.slice(0, 3)) {
      lines.push(`    "${oneLine(quote.text)}" (${quote.source})`);
    }
  }

  if (includeReportOnly && summary.reportOnlyGaps?.length) {
    lines.push("");
    lines.push("### REPORT ONLY - not synthesis-eligible evidence");
    for (const gap of summary.reportOnlyGaps) {
      lines.push(`- ${gapSessionLabel(gap)} risk=${gap.recurrenceRisk} :: ${gap.proposedInstruction}`);
    }
  }

  return lines.join("\n");
}

function gapSessionLabel(gap) {
  const orch = gap.orchestrationSightings || 0;
  if (!orch) return `sessions=${gap.sessions}`;
  const extra = gap.majorityOrchestration ? "; domain excluded by majority vote" : "";
  return `sessions=${gap.sessions} (${gap.sessions} sightings, ${orch} orchestration${extra})`;
}

function oneLine(text, max = 240) {
  const flat = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}
