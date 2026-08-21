import { similarity } from "./memory.js";

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
 *     re-derived the db schema" arrives as one item with three quotes.
 *  3. Gap clusters below `minGapEvidence` are dropped. Batch size > 1: one bad session
 *     never rewrites the weights.
 */

const GAP_SIMILARITY_THRESHOLD = 0.45;

function sourceLabel(evidence) {
  const t = evidence.transcript || {};
  const date = t.startedAt ? new Date(t.startedAt).toISOString().slice(0, 10) : "unknown date";
  return `${t.harness} · ${String(t.id || "")
    .replace(/^[a-z-]+-/, "")
    .slice(0, 8)} · ${date}`;
}

export function foldEvidence(evidenceRecords, { minGapEvidence = 2, memoryFile = null } = {}) {
  const usable = evidenceRecords.filter((e) => e && e.status === "ok");
  const analyzedSessions = usable.length;

  const instructions = new Map();
  const gapClusters = [];
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
        quotes: [],
      });
    }
    return instructions.get(id);
  };

  for (const record of usable) {
    if (record.usedRawTranscript) usedRawCount += 1;
    const source = sourceLabel(record);

    for (const polarity of ["positive", "negative"]) {
      for (const item of record[polarity] || []) {
        const entry = touch(item.instruction);
        entry[polarity] += 1;
        entry.sessions.add(record.transcript.id);
        entry.quotes.push({ polarity, text: item.quote, effect: item.effect, moment: item.moment, source });
        if (polarity === "positive") positiveCount += 1;
        else negativeCount += 1;
      }
    }

    for (const gap of record.gaps || []) {
      const cluster = gapClusters.find(
        (c) => similarity(c.proposedInstruction, gap.proposedInstruction) >= GAP_SIMILARITY_THRESHOLD,
      );
      const item = {
        mistake: gap.mistake,
        quote: gap.quote,
        recurrenceRisk: gap.recurrenceRisk,
        source,
        sessionId: record.transcript.id,
      };
      if (cluster) {
        cluster.items.push(item);
        cluster.sessions.add(record.transcript.id);
        // Keep the shortest phrasing: it generalizes best.
        if (gap.proposedInstruction.length < cluster.proposedInstruction.length) {
          cluster.proposedInstruction = gap.proposedInstruction;
        }
      } else {
        gapClusters.push({
          proposedInstruction: gap.proposedInstruction,
          sessions: new Set([record.transcript.id]),
          items: [item],
        });
      }
    }
  }

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
      usedRawTranscript: usedRawCount,
    },
    instructions: instructionRows,
    gaps,
  };
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
  for (const row of summary.instructions) {
    const relevance = `${(row.relevance * 100).toFixed(1)}%`;
    const cost = row.tokens === null ? "" : ` cost=${row.tokens}tok`;
    lines.push(
      `- [${row.instruction}] +${row.positive} -${row.negative} sessions=${row.sessions} relevance=${relevance}${cost}` +
        (row.known ? "" : " (id not found in current file - stale reference)"),
    );
    for (const quote of row.quotes.slice(0, 3)) {
      lines.push(`    ${quote.polarity === "negative" ? "-" : "+"} "${oneLine(quote.text)}" (${quote.source})`);
    }
  }

  lines.push("");
  lines.push("### Gap clusters (mistakes no current instruction covers)");
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

function oneLine(text) {
  const flat = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > 240 ? `${flat.slice(0, 240)}...` : flat;
}
