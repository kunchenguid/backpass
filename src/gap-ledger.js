import { similarity } from "./memory.js";
import { parseSince } from "./config.js";
import { sha256 } from "./state.js";

/**
 * Durable gap corroboration across runs (`.backpass/gap-ledger.json`).
 *
 * The fold stage only promotes a gap once `minGapEvidence` distinct sessions report it.
 * Counting those sessions from the evidence that happens to be on disk is lossy: a
 * transcript's evidence file is rewritten every time it is re-analyzed against a changed
 * memory file (every apply changes the hash), and the analysis model rephrases gaps
 * between runs, so two observations of one gap rarely line up in a single fold. This
 * ledger keeps every gap observation, keyed by gap identity and session, so a gap seen in
 * one session now and in another session on a later run still reaches the bar.
 *
 * Identity and freshness rules:
 *
 *  - A gap's identity is its proposed instruction, matched by the same bigram similarity
 *    the in-run clustering uses (`GAP_SIMILARITY_THRESHOLD`), against the ledger's
 *    canonical phrasing (the shortest seen). The entry id is a hash of the first phrasing
 *    and never changes, so rephrasing does not split an entry.
 *  - Sessions are keyed by transcript id (harness + native session id), so re-analyzing
 *    or re-sampling the same session overwrites its observation and never adds a count.
 *  - A gap is a fact about its session: re-analysis that no longer mentions it is model
 *    noise, not the session changing, so observations are only ever replaced, not removed
 *    by absence. They retire in exactly two ways: the memory file gains an instruction
 *    that covers the gap (`GAP_COVERED_THRESHOLD`, the `reanchor` bar), or the sighting
 *    has waited longer than `gapLedgerMaxAge` for a partner, counted from when backpass
 *    first saw it (re-analysis never refreshes that clock; session age itself is already
 *    bounded by discovery's `since` at entry). Keying to the memory hash instead would
 *    reset the count on every unrelated edit, which is the failure this ledger fixes.
 *  - The file is fail-soft: a missing or corrupt ledger is rebuilt from this run's
 *    evidence, which is exactly what the pre-ledger fold saw.
 */

/** Two gap phrasings at or above this Sorensen-Dice bigram score are one gap. */
export const GAP_SIMILARITY_THRESHOLD = 0.45;
/** A memory-file instruction this similar to a gap's proposal covers it. */
export const GAP_COVERED_THRESHOLD = 0.6;

export function emptyGapLedger() {
  return { version: 1, entries: {} };
}

export function gapSource(transcript = {}) {
  const date = transcript.startedAt ? new Date(transcript.startedAt).toISOString().slice(0, 10) : "unknown date";
  return `${transcript.harness} · ${String(transcript.id || "")
    .replace(/^[a-z-]+-/, "")
    .slice(0, 8)} · ${date}`;
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function gapEntryId(memoryPath, proposedInstruction) {
  return sha256(`${memoryPath}\n${normalize(proposedInstruction)}`).slice(0, 16);
}

/** The ledger entry a proposed instruction belongs to, or null. */
export function findGapEntry(ledger, memoryPath, proposedInstruction) {
  let best = null;
  let bestScore = 0;
  for (const entry of Object.values(ledger.entries)) {
    if (entry.memoryPath !== memoryPath) continue;
    const score = similarity(entry.proposedInstruction, proposedInstruction);
    if (score >= GAP_SIMILARITY_THRESHOLD && score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Fold this run's evidence into the ledger. One observation per (gap, session); a
 * session seen again replaces its own observation and keeps its first-seen timestamp.
 */
export function recordGapObservations(ledger, evidenceRecords, { now = new Date() } = {}) {
  const observedAt = new Date(now).toISOString();
  let recorded = 0;
  for (const record of evidenceRecords) {
    if (!record || record.status !== "ok" || !record.memoryPath) continue;
    const transcript = record.transcript || {};
    if (!transcript.id) continue;
    for (const gap of record.gaps || []) {
      if (!gap || !gap.proposedInstruction) continue;
      let entry = findGapEntry(ledger, record.memoryPath, gap.proposedInstruction);
      if (!entry) {
        const id = gapEntryId(record.memoryPath, gap.proposedInstruction);
        entry = ledger.entries[id] = {
          id,
          memoryPath: record.memoryPath,
          proposedInstruction: gap.proposedInstruction,
          sessions: {},
        };
      } else if (gap.proposedInstruction.length < entry.proposedInstruction.length) {
        // Keep the shortest phrasing: it generalizes best (same rule as the in-run fold).
        entry.proposedInstruction = gap.proposedInstruction;
      }
      const prior = entry.sessions[transcript.id];
      entry.sessions[transcript.id] = {
        firstObservedAt: prior?.firstObservedAt || observedAt,
        observedAt,
        sessionStartedAt: transcript.startedAt ?? prior?.sessionStartedAt ?? null,
        memoryHash: record.memoryHash || null,
        source: gapSource(transcript),
        mistake: gap.mistake,
        quote: gap.quote,
        recurrenceRisk: gap.recurrenceRisk,
      };
      recorded += 1;
    }
  }
  return recorded;
}

/**
 * Retire observations that no longer count: sightings first seen more than `maxAge` ago
 * (a duration like `90d`, `all` to disable) and gaps the current memory file now covers.
 */
export function pruneGapLedger(
  ledger,
  { memoryFile = null, memoryPath = null, maxAge = "90d", now = new Date() } = {},
) {
  const maxAgeMs = parseSince(maxAge);
  const cutoff = maxAgeMs === null ? -Infinity : new Date(now).getTime() - maxAgeMs;
  const stats = { expired: 0, covered: 0 };

  for (const [id, entry] of Object.entries(ledger.entries)) {
    const applies = memoryPath === null || entry.memoryPath === memoryPath;
    if (applies && memoryFile && isCovered(memoryFile, entry.proposedInstruction)) {
      stats.covered += Object.keys(entry.sessions).length;
      delete ledger.entries[id];
      continue;
    }
    for (const [sessionId, obs] of Object.entries(entry.sessions)) {
      const when = Date.parse(obs.firstObservedAt || obs.observedAt);
      if (!Number.isFinite(when) || when < cutoff) {
        stats.expired += 1;
        delete entry.sessions[sessionId];
      }
    }
    if (!Object.keys(entry.sessions).length) delete ledger.entries[id];
  }
  return stats;
}

function isCovered(memoryFile, proposedInstruction) {
  return (memoryFile.units || []).some((unit) => similarity(unit.text, proposedInstruction) >= GAP_COVERED_THRESHOLD);
}

/** Flatten the ledger into the observation list `foldEvidence` clusters over. */
export function ledgerGapObservations(ledger, memoryPath) {
  const observations = [];
  for (const entry of Object.values(ledger.entries)) {
    if (entry.memoryPath !== memoryPath) continue;
    for (const [sessionId, obs] of Object.entries(entry.sessions)) {
      observations.push({
        proposedInstruction: entry.proposedInstruction,
        sessionId,
        source: obs.source,
        mistake: obs.mistake,
        quote: obs.quote,
        recurrenceRisk: obs.recurrenceRisk,
      });
    }
  }
  return observations;
}
