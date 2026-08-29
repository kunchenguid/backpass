import { parseMemoryUnits, similarity } from "./memory.js";
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
 *  - A gap's identity is judged first and matched lexically second. The analysis turn is
 *    shown the ledger's open entries (`renderOpenGapIndex`) and cites an entry id
 *    (`matchesGap`) when its gap is one already on the books; a valid citation wins
 *    outright, because word overlap cannot recognize a paraphrase and the analysis model
 *    has both sentences in front of it. Without a citation, bigram similarity
 *    (`GAP_SIMILARITY_THRESHOLD`) against the canonical phrasing (the shortest seen) is
 *    the fallback. The entry id is a hash of the first phrasing and never changes, so
 *    rephrasing does not split an entry. Two entries later judged to be one gap are
 *    merged by the pre-synthesis consolidation pass (`mergeGapEntries`, driven by
 *    `src/consolidate.js`), which is what lets two same-run parallel sightings - neither
 *    of which could cite the other - still corroborate.
 *  - Every observation carries the `domain` the analysis judged: `orchestration` when the
 *    mistake was not caused by this repository but by an external agent harness or tooling
 *    that orchestrated the task, `project` for every other mistake.
 *    Orchestration sightings are recorded for legibility but never counted toward
 *    corroboration and never surface in a proposal; a missing domain counts as project,
 *    so evidence from before the field existed keeps its old behavior.
 *  - Sessions are keyed by transcript id (harness + native session id), so re-analyzing
 *    or re-sampling the same session overwrites its observation and never adds a count.
 *  - A gap is a fact about its session: re-analysis that no longer mentions it is model
 *    noise, not the session changing, so observations are only ever replaced, not removed
 *    by absence. They retire in exactly two ways: the memory surface gains content
 *    that covers the gap - a memory-file instruction or a skill's description/body
 *    (`GAP_COVERED_THRESHOLD`, the `reanchor` bar) - or the sighting
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

function gapEntryById(ledger, id) {
  const direct = ledger.entries[id];
  if (direct) return direct;
  return Object.values(ledger.entries).find((entry) => (entry.aliases || []).includes(id)) || null;
}

/** The ledger entry a proposed instruction belongs to, or null. */
export function findGapEntry(ledger, memoryPath, proposedInstruction) {
  let best = null;
  let bestScore = 0;
  for (const entry of Object.values(ledger.entries)) {
    if (entry.memoryPath !== memoryPath) continue;
    const phrasings = [...new Set([entry.proposedInstruction, ...(entry.phrasings || [])])];
    const score = Math.max(...phrasings.map((phrasing) => similarity(phrasing, proposedInstruction)));
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
 *
 * @param {{ now?: Date, skills?: unknown[] }} [options]
 */
export function recordGapObservations(ledger, evidenceRecords, options = {}) {
  const { now = new Date() } = options;
  const observedAt = new Date(now).toISOString();
  let recorded = 0;
  for (const record of evidenceRecords) {
    if (!record || record.status !== "ok" || !record.memoryPath) continue;
    const transcript = record.transcript || {};
    const sessionIdentity = transcript.identity || transcript.id;
    if (!sessionIdentity) continue;
    for (const gap of record.gaps || []) {
      if (!gap || !gap.proposedInstruction) continue;
      // A citation from the analysis turn wins over word overlap: the model saw both
      // sentences and judged them the same gap. An id that names nothing (stale index,
      // typo) falls back to the lexical match rather than failing the record.
      const cited = gap.matchesGap ? gapEntryById(ledger, gap.matchesGap) : null;
      const deterministicId = gapEntryId(record.memoryPath, gap.proposedInstruction);
      const deterministic = gapEntryById(ledger, deterministicId);
      let entry =
        (cited && cited.memoryPath === record.memoryPath ? cited : null) ||
        findGapEntry(ledger, record.memoryPath, gap.proposedInstruction) ||
        (deterministic && deterministic.memoryPath === record.memoryPath ? deterministic : null);
      if (!entry) {
        entry = ledger.entries[deterministicId] = {
          id: deterministicId,
          memoryPath: record.memoryPath,
          proposedInstruction: gap.proposedInstruction,
          phrasings: [gap.proposedInstruction],
          sessions: {},
        };
      } else {
        entry.phrasings = [
          ...new Set([entry.proposedInstruction, ...(entry.phrasings || []), gap.proposedInstruction]),
        ];
        if (gap.proposedInstruction.length < entry.proposedInstruction.length) {
          // Keep the shortest phrasing: it generalizes best (same rule as the in-run fold).
          entry.proposedInstruction = gap.proposedInstruction;
        }
      }
      const identityPrior = entry.sessions[sessionIdentity];
      const aliasPrior = transcript.id && transcript.id !== sessionIdentity ? entry.sessions[transcript.id] : null;
      const priors = [identityPrior, aliasPrior].filter(Boolean);
      const firstObservedAt = priors
        .map((observation) => observation.firstObservedAt || observation.observedAt)
        .filter((value) => Number.isFinite(Date.parse(value)))
        .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
      if (aliasPrior) delete entry.sessions[transcript.id];
      const coveredBySkill =
        gap.coveredBySkill || priors.find((observation) => observation.coveredBySkill)?.coveredBySkill;
      entry.sessions[sessionIdentity] = {
        firstObservedAt: firstObservedAt || observedAt,
        observedAt,
        sessionStartedAt:
          transcript.startedAt ?? identityPrior?.sessionStartedAt ?? aliasPrior?.sessionStartedAt ?? null,
        memoryHash: record.memoryHash || null,
        source: gapSource(transcript),
        mistake: gap.mistake,
        quote: gap.quote,
        recurrenceRisk: gap.recurrenceRisk,
        domain: gap.domain === "orchestration" ? "orchestration" : "project",
        // A failed trigger: the analysis judged an existing skill's content to cover
        // this mistake. Absent when no skill covers it (including all pre-existing
        // observations), and absence never counts as a citation.
        ...(coveredBySkill ? { coveredBySkill } : {}),
      };
      recorded += 1;
    }
  }
  return recorded;
}

/**
 * Retire observations that no longer count: sightings first seen more than `maxAge` ago
 * (a duration like `90d`, `all` to disable) and gaps the current memory surface now
 * covers - a memory-file instruction OR a skill's content (its description line or a
 * body unit). Skills count because a gap resolved by extracting or writing a skill is
 * resolved; without them the entry would haunt every analysis prompt until it expires.
 */
export function pruneGapLedger(
  ledger,
  { memoryFile = null, memoryPath = null, skills = [], maxAge = "90d", now = new Date() } = {},
) {
  const maxAgeMs = parseSince(maxAge);
  const cutoff = maxAgeMs === null ? -Infinity : new Date(now).getTime() - maxAgeMs;
  const stats = { expired: 0, covered: 0 };
  const coverage = coverageUnits(memoryFile, skills);

  for (const [id, entry] of Object.entries(ledger.entries)) {
    const applies = memoryPath === null || entry.memoryPath === memoryPath;
    if (applies && coverage.length && isCovered(coverage, entry)) {
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

/** Every unit of always-available knowledge a gap can be covered by. */
function coverageUnits(memoryFile, skills) {
  return [
    ...(memoryFile?.units || []).map((unit) => ({ text: unit.text })),
    ...(skills || []).flatMap((skill) => [
      { text: skill.description || "", skill: skill.name, kind: "description" },
      ...parseMemoryUnits(skill.body || "").map((unit) => ({
        text: unit.text,
        skill: skill.name,
        kind: "body",
      })),
    ]),
  ].filter((unit) => unit.text.trim());
}

function isCovered(coverage, entry) {
  const phrasings = [...new Set([entry.proposedInstruction, ...(entry.phrasings || [])])];
  return coverage.some((unit) => {
    const isCitedBody =
      unit.kind === "body" &&
      Object.values(entry.sessions).some((observation) => observation.coveredBySkill === unit.skill);
    return !isCitedBody && phrasings.some((phrasing) => similarity(unit.text, phrasing) >= GAP_COVERED_THRESHOLD);
  });
}

/** Flatten the ledger into the observation list `foldEvidence` clusters over. */
export function ledgerGapObservations(ledger, memoryPath, skills = null) {
  const observations = [];
  const skillNames = skills ? new Set(skills.map((skill) => skill.name)) : null;
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
        domain: obs.domain === "orchestration" ? "orchestration" : "project",
        ...(obs.coveredBySkill && (!skillNames || skillNames.has(obs.coveredBySkill))
          ? { coveredBySkill: obs.coveredBySkill }
          : {}),
      });
    }
  }
  return observations;
}

/**
 * The ledger's open entries for one memory path, rendered for the analysis prompt so the
 * model can cite an existing gap instead of coining a paraphrase of it. An accumulator,
 * not a detector: a gap nobody has reported yet is simply absent, and the analysis
 * reports it fresh.
 */
export function renderOpenGapIndex(ledger, memoryPath, { max = 200 } = {}) {
  const entries = Object.values(ledger.entries).filter((e) => e.memoryPath === memoryPath);
  if (!entries.length) return "(none yet)";
  const lines = entries.slice(0, max).map((e) => `[gap:${e.id}] ${e.proposedInstruction}`);
  if (entries.length > max) lines.push(`... ${entries.length - max} more`);
  return lines.join("\n");
}

/**
 * Merge groups of ledger entries the consolidation pass judged to be one gap. Each group
 * keeps the entry with the most sessions (its id stays citable), unions the session maps
 * without ever double-counting a session (an observation already present keeps its
 * earliest firstObservedAt), and keeps the shortest phrasing as canonical - the same rule
 * recording uses. Unknown ids, cross-path groups, and groups that shrink below two known
 * entries are dropped rather than guessed at. Returns how many entries were absorbed.
 */
export function mergeGapEntries(ledger, groups) {
  let absorbed = 0;
  const claimed = new Set();
  for (const group of Array.isArray(groups) ? groups : []) {
    const ids = [...new Set((Array.isArray(group) ? group : []).map(String))].filter(
      (id) => ledger.entries[id] && !claimed.has(id),
    );
    if (ids.length < 2) continue;
    const paths = new Set(ids.map((id) => ledger.entries[id].memoryPath));
    if (paths.size !== 1) continue;
    for (const id of ids) claimed.add(id);

    const entries = ids.map((id) => ledger.entries[id]);
    const target = entries.reduce((best, e) =>
      Object.keys(e.sessions).length > Object.keys(best.sessions).length ? e : best,
    );
    for (const entry of entries) {
      if (entry === target) continue;
      for (const [sessionId, obs] of Object.entries(entry.sessions)) {
        const prior = target.sessions[sessionId];
        if (!prior) {
          target.sessions[sessionId] = obs;
        } else {
          const earlier =
            Date.parse(obs.firstObservedAt || obs.observedAt) < Date.parse(prior.firstObservedAt || prior.observedAt);
          if (earlier) prior.firstObservedAt = obs.firstObservedAt || obs.observedAt;
          if (!prior.coveredBySkill && obs.coveredBySkill) prior.coveredBySkill = obs.coveredBySkill;
        }
      }
      target.aliases = [...new Set([...(target.aliases || []), entry.id, ...(entry.aliases || [])])];
      target.phrasings = [
        ...new Set([
          target.proposedInstruction,
          ...(target.phrasings || []),
          entry.proposedInstruction,
          ...(entry.phrasings || []),
        ]),
      ];
      if (entry.proposedInstruction.length < target.proposedInstruction.length) {
        target.proposedInstruction = entry.proposedInstruction;
      }
      delete ledger.entries[entry.id];
      absorbed += 1;
    }
  }
  return absorbed;
}
