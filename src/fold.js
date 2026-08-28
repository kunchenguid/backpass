import { similarity } from "./memory.js";
import { GAP_SIMILARITY_THRESHOLD, gapSource } from "./gap-ledger.js";

/**
 * Stage 2 of the pipeline (design section 3): fold per-transcript evidence into one
 * compact summary. Entirely deterministic - no model involved.
 *
 * Three things happen here that the synthesis pass depends on:
 *
 *  1. Evidence is grouped by instruction id, giving per-instruction positive/negative
 *     counts and, crucially, `relevance` = sessions where the instruction drew any
 *     evidence / sessions analyzed. That ratio is what decides memory-file vs skill
 *     placement in section 7.
 *  2. Near-duplicate gaps from different sessions are clustered, so "three sessions
 *     re-derived the db schema" arrives as one item with three quotes. Judged identity
 *     happens upstream (analysis citations and the consolidation pass reshape the
 *     ledger); the clustering here stays deterministic. Orchestration-domain sightings
 *     are excluded before clustering and surfaced only as a count.
 *  3. Gap clusters below `minGapEvidence` are dropped. Batch size > 1: one bad session
 *     never rewrites the weights. Sessions are counted across runs, not per run: when the
 *     caller passes `gapObservations` (the pruned gap ledger, `src/gap-ledger.js`) the
 *     clusters are built from those instead of this run's records, so a gap seen once now
 *     and once on a later run graduates. Without a ledger the records alone are used.
 */

/**
 * @param {object[]} evidenceRecords
 * @param {{ minGapEvidence?: number, memoryFile?: object|null, gapObservations?: object[]|null }} [options]
 */
export function foldEvidence(evidenceRecords, { minGapEvidence = 2, memoryFile = null, gapObservations = null } = {}) {
  const usable = evidenceRecords.filter((e) => e && e.status === "ok");
  const analyzedSessions = usable.length;

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
        harmSessions: new Set(),
        quotes: [],
      });
    }
    return instructions.get(id);
  };

  const recordObservations = [];
  for (const record of usable) {
    if (record.usedRawTranscript) usedRawCount += 1;
    const source = gapSource(record.transcript);

    for (const polarity of ["positive", "negative"]) {
      for (const item of record[polarity] || []) {
        const entry = touch(item.instruction);
        entry[polarity] += 1;
        const sessionIdentity = record.transcript.identity || record.transcript.id;
        entry.sessions.add(sessionIdentity);
        // `class` is what a negative means (harm vs non-compliance vs irrelevant);
        // `harmSessions` is what the removal-evidence floor counts. A record from
        // before the class existed carries none and never counts as harm.
        if (polarity === "negative" && item.class === "harm") entry.harmSessions.add(sessionIdentity);
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
      });
    }
  }

  // Orchestration-domain sightings are about the task-management layer around the
  // session, not this repository's engineering; they are counted for legibility but
  // never cluster, so they can never corroborate into a project proposal.
  const allObservations = gapObservations ?? recordObservations;
  const projectObservations = allObservations.filter((obs) => obs?.domain !== "orchestration");
  const orchestrationGapSightings = allObservations.length - projectObservations.length;

  const gapClusters = clusterGapObservations(projectObservations);

  // Instructions that exist in the file but drew no evidence at all are the strongest
  // removal / extraction candidates, so they must appear in the summary too.
  if (memoryFile) {
    for (const unit of memoryFile.units) touch(unit.id);
  }

  const instructionRows = [...instructions.values()]
    .map((entry) => {
      const unit = memoryFile?.units.find((u) => u.id === entry.instruction) || null;
      return {
        instruction: entry.instruction,
        positive: entry.positive,
        negative: entry.negative,
        harmSessions: entry.harmSessions.size,
        sessions: entry.sessions.size,
        relevance: analyzedSessions ? entry.sessions.size / analyzedSessions : 0,
        tokens: unit?.tokens ?? null,
        section: unit?.section ?? null,
        known: Boolean(unit),
        quotes: entry.quotes.slice(0, 6),
      };
    })
    .sort((a, b) => b.negative - a.negative || b.sessions - a.sessions || a.instruction.localeCompare(b.instruction));

  const gaps = gapClusters
    .map((cluster) => ({
      proposedInstruction: cluster.proposedInstruction,
      sessions: cluster.sessions.size,
      recurrenceRisk: highestRisk(cluster.items),
      quotes: cluster.items.slice(0, 6).map((i) => ({ text: i.quote, effect: i.mistake, source: i.source })),
    }))
    .filter((cluster) => cluster.sessions >= minGapEvidence)
    .sort((a, b) => b.sessions - a.sessions);

  const droppedGapSingletons = gapClusters.length - gaps.length;

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    analyzedSessions,
    totals: {
      positive: positiveCount,
      negative: negativeCount,
      gapClusters: gaps.length,
      droppedGapSingletons,
      orchestrationGapSightings,
      usedRawTranscript: usedRawCount,
    },
    instructions: instructionRows,
    gaps,
  };
}

/**
 * Greedy similarity clustering over gap observations. A cluster counts each session once
 * no matter how many observations it contributed (re-analysis, duplicate reports).
 */
export function clusterGapObservations(observations) {
  const clusters = [];
  for (const obs of observations) {
    if (!obs || !obs.proposedInstruction) continue;
    const cluster = clusters.find(
      (c) => similarity(c.proposedInstruction, obs.proposedInstruction) >= GAP_SIMILARITY_THRESHOLD,
    );
    const item = {
      mistake: obs.mistake,
      quote: obs.quote,
      recurrenceRisk: obs.recurrenceRisk,
      source: obs.source,
      sessionId: obs.sessionId,
    };
    if (cluster) {
      if (!cluster.sessions.has(obs.sessionId)) cluster.items.push(item);
      cluster.sessions.add(obs.sessionId);
      // Keep the shortest phrasing: it generalizes best.
      if (obs.proposedInstruction.length < cluster.proposedInstruction.length) {
        cluster.proposedInstruction = obs.proposedInstruction;
      }
    } else {
      clusters.push({
        proposedInstruction: obs.proposedInstruction,
        sessions: new Set([obs.sessionId]),
        items: [item],
      });
    }
  }
  return clusters;
}

function highestRisk(items) {
  const order = { high: 3, medium: 2, low: 1 };
  return items.reduce((best, i) => (order[i.recurrenceRisk] > order[best] ? i.recurrenceRisk : best), "low");
}

/** Compact rendering of the folded evidence for the synthesis prompt. */
export function renderEvidenceForPrompt(summary) {
  const lines = [];

  lines.push(`Sessions analyzed: ${summary.analyzedSessions}`);
  lines.push(
    `Totals: ${summary.totals.positive} positive, ${summary.totals.negative} negative, ` +
      `${summary.totals.gapClusters} gap clusters (${summary.totals.droppedGapSingletons} singletons dropped below threshold)`,
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
    const cost = row.tokens === null ? "" : ` cost=${row.tokens}tok`;
    const harm = row.negative > 0 ? ` harm-sessions=${row.harmSessions ?? 0}` : "";
    lines.push(
      `- [${row.instruction}] +${row.positive} -${row.negative}${harm} sessions=${row.sessions} relevance=${relevance}${cost}` +
        (row.known ? "" : " (id not found in current file - stale reference)"),
    );
    for (const quote of row.quotes.slice(0, 3)) {
      const sign = quote.polarity === "negative" ? "-" : "+";
      const cls = quote.polarity === "negative" ? ` [${quote.class ?? "unclassified"}]` : "";
      const effect = quote.effect ? ` :: ${oneLine(quote.effect, 200)}` : "";
      lines.push(`    ${sign}${cls} "${oneLine(quote.text)}"${effect} (${quote.source})`);
    }
  }

  lines.push("");
  lines.push("### Gap clusters (mistakes no current instruction covers)");
  if (summary.totals.orchestrationGapSightings) {
    lines.push(
      `- ${summary.totals.orchestrationGapSightings} orchestration-domain sighting(s) about the ` +
        `task-management layer were excluded; they never enter this repository's memory file`,
    );
  }
  if (!summary.gaps.length) {
    lines.push("- none above the evidence threshold");
  }
  for (const gap of summary.gaps) {
    lines.push(`- sessions=${gap.sessions} risk=${gap.recurrenceRisk} :: ${gap.proposedInstruction}`);
    for (const quote of gap.quotes.slice(0, 3)) {
      lines.push(`    "${oneLine(quote.text)}" (${quote.source})`);
    }
  }

  return lines.join("\n");
}

function oneLine(text, max = 240) {
  const flat = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}
