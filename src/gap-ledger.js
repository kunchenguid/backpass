import { parseMemoryUnits, similarity } from "./memory.js";
import { parseSince } from "./config.js";
import { sha256 } from "./state.js";
import { corroborationIdentityOf } from "./transcript.js";

/**
 * Durable gap corroboration across runs (`.backpass/gap-ledger.json`).
 *
 * The fold stage only promotes a gap once `minGapEvidence` distinct observers report it.
 * Counting those observers from the evidence that happens to be on disk is lossy: a
 * transcript's evidence file is rewritten every time it is re-analyzed against a changed
 * memory file (every apply changes the hash), and the analysis model rephrases gaps
 * between runs, so two observations of one gap rarely line up in a single fold. This
 * ledger preserves gap history across runs, so observations collected separately can
 * still reach the bar when their observers are together in a later run's selected sample.
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
 *    Domain voting is owned by `clusterDomainVote` in `src/fold.js`. A missing domain
 *    counts as project, so evidence from before the field existed keeps its old behavior.
 *  - Observations normally use discovery's shared observer identity for linked OMP
 *    descendants, the transcript's own otherwise (`corroborationIdentityOf`). Linkage
 *    rules live in `src/discovery/adapters/pi.js`.
 *    Older per-file keys migrate only when selected native provenance and any occupied
 *    destination are compatible; legacy id keys additionally require unambiguous
 *    `legacyIds`. Incompatible history stays separately keyed, and recording uses a
 *    native or source-qualified key rather than overwriting it. Storage keys do not
 *    grant extra observer votes. Persisted observations require verified source-span
 *    provenance to contribute; unverified history stays on disk. They count only when their
 *    admitted observer belongs to the current selected sample, so sessions outside the
 *    window or cap cannot skew fold.
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

/**
 * Fold-issued source label for one native transcript. `summary.sources` and
 * `sourceProjects` key off this string; observer identities carry evidence floors.
 * Time-prefixed Codex ULIDs share an 8-character prefix when they start in the same
 * minute; keep the native id whole.
 *
 * A session collected over ssh carries its host, so the apply surface shows what
 * cross-machine corroboration actually is: two machines hitting one gap, named.
 */
export function gapSource(transcript = {}) {
  const date = transcript.startedAt ? new Date(transcript.startedAt).toISOString().slice(0, 10) : "unknown date";
  const host = transcript.host ? ` · ${transcript.host}` : "";
  return `${transcript.harness} · ${sessionSourceId(transcript)} · ${date}${host}`;
}

export function sessionSourceId(transcript = {}) {
  const native = String(transcript.nativeId ?? "").trim();
  if (native) return native;
  const raw = String(transcript.id || "").trim();
  const harness = String(transcript.harness || "");
  if (harness && raw.startsWith(`${harness}-`)) return raw.slice(harness.length + 1);
  return raw.replace(/^[a-z-]+-/, "") || String(transcript.identity || "").trim();
}

export function normalizeSourceLabel(source) {
  return String(source || "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * When two sessions share a base source label, suffix the canonical session identity
 * so `summary.sources` and `sourceProjects` stay 1:1 with sessions instead of
 * last-write-wins on the colliding key.
 *
 * @param {{ source?: string, identity?: string }[]} entries
 * @returns {string[]}
 */
export function disambiguateSourceLabels(entries) {
  const normalized = (Array.isArray(entries) ? entries : []).map((entry) => ({
    source: normalizeSourceLabel(entry?.source),
    identity: String(entry?.identity || "").trim(),
  }));
  const sourceByIdentity = new Map();
  for (const entry of normalized) {
    if (entry.identity && entry.source && !sourceByIdentity.has(entry.identity)) {
      sourceByIdentity.set(entry.identity, entry.source);
    }
  }
  const canonical = normalized.map((entry) => ({
    ...entry,
    source: sourceByIdentity.get(entry.identity) || entry.source,
  }));
  const identitiesBySource = new Map();
  for (const entry of canonical) {
    if (!entry.source) continue;
    if (!identitiesBySource.has(entry.source)) identitiesBySource.set(entry.source, new Set());
    identitiesBySource.get(entry.source).add(entry.identity || entry.source);
  }
  return canonical.map((entry) => {
    const identities = identitiesBySource.get(entry.source);
    if (identities?.size > 1 && entry.identity && !entry.source.includes(entry.identity)) {
      return `${entry.source} · ${entry.identity}`;
    }
    return entry.source;
  });
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

function sessionIdentityAliases(transcript, sessionIdentity, legacyIds) {
  return [...new Set([transcript.identity, transcript.id])].filter(
    (identity) => identity && identity !== sessionIdentity && (identity !== transcript.id || legacyIds.has(identity)),
  );
}

function selectedNativeObservers(transcripts, legacyIds) {
  const observers = new Map();
  for (const transcript of transcripts) {
    if (!(transcript?.corroborationIdentity || transcript?.identity || transcript?.id)) continue;
    const observer = corroborationIdentityOf(transcript);
    for (const native of new Set([
      transcript.identity || transcript.id,
      ...(legacyIds.has(transcript.id) ? [transcript.id] : []),
    ])) {
      if (!observers.has(native)) observers.set(native, new Set());
      observers.get(native).add(observer);
    }
  }
  return observers;
}

export function resolveGapObservationObserver(observation, observersByNative) {
  if (!observation || hasUnattributedSightings(observation)) return null;
  let observer = null;
  for (const native of new Set([observation.sourceSessionId, ...(observation.sightingIds || [])])) {
    const observers = observersByNative.get(native);
    if (observers?.size !== 1) return null;
    const [selected] = observers;
    if (observer !== null && observer !== selected) return null;
    observer = selected;
  }
  return observer;
}

function isOrdinaryNative(transcript, sessionIdentity) {
  return (
    !transcript.parentSessionId &&
    !(transcript.harness === "pi" && transcript.interactionSignals?.source === "subagent") &&
    (transcript.identity || transcript.id) === sessionIdentity
  );
}

function destinationAcceptsObservation(observation, sessionIdentity, transcript, observersByNative) {
  if (!observation) return true;
  for (const native of new Set([observation.sourceSessionId, ...(observation.sightingIds || [])].filter(Boolean))) {
    const observers = observersByNative.get(native);
    if (observers && (observers.size !== 1 || !observers.has(sessionIdentity))) return false;
  }
  if (resolveGapObservationObserver(observation, observersByNative) === sessionIdentity) return true;
  const nativeIdentity = transcript.identity || transcript.id;
  return (
    (observation.unattributedSightings &&
      (observation.sourceSessionId === nativeIdentity || observation.sightingIds?.includes(nativeIdentity)) &&
      observersByNative.get(nativeIdentity)?.size === 1) ||
    (!observation.sourceSessionId &&
      isOrdinaryNative(transcript, sessionIdentity) &&
      (observation.sightingIds || []).every((native) => {
        const observers = observersByNative.get(native);
        return observers?.size === 1 && observers.has(sessionIdentity);
      }))
  );
}

function takePriorObservations(entry, sessionIdentity, aliases, transcript, destinationIdentity = sessionIdentity) {
  const nativeIdentity = transcript.identity || transcript.id;
  const current = entry.sessions[destinationIdentity];
  if (current && !current.sourceSessionId && isOrdinaryNative(transcript, sessionIdentity)) {
    current.sourceSessionId = nativeIdentity;
    current.sightingIds = [...new Set([...(current.sightingIds || []), nativeIdentity])];
    delete current.unattributedSightings;
  }
  for (const alias of aliases) {
    const observation = entry.sessions[alias];
    if (!observation || observation.sourceSessionId) continue;
    observation.sourceSessionId = nativeIdentity;
    observation.sightingIds = [...new Set([...(observation.sightingIds || []), nativeIdentity])];
    observation.source = gapSource(transcript);
  }
  const priors = [entry.sessions[destinationIdentity], ...aliases.map((identity) => entry.sessions[identity])].filter(
    Boolean,
  );
  const firstObservedAt = priors
    .map((observation) => observation.firstObservedAt || observation.observedAt)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const coveredBySkill = priors.find((observation) => observation.coveredBySkill)?.coveredBySkill;
  for (const alias of aliases) delete entry.sessions[alias];
  return { priors, firstObservedAt, coveredBySkill };
}

function hasUnattributedSightings(observation) {
  return Boolean(observation.unattributedSightings || !observation.sourceSessionId);
}

/**
 * Record this run's sightings under the identity and provenance rules above, retaining
 * the first-seen timestamp when replacing compatible history.
 *
 * @param {{ now?: Date, skills?: unknown[], legacyIds?: Set<string>, transcripts?: object[] }} [options]
 */
export function recordGapObservations(ledger, evidenceRecords, options = {}) {
  const { now = new Date(), legacyIds = new Set() } = options;
  const observedAt = new Date(now).toISOString();
  const observersByNative = selectedNativeObservers(
    options.transcripts || evidenceRecords.map((record) => record?.transcript),
    legacyIds,
  );
  let recorded = 0;
  for (const record of evidenceRecords) {
    if (!record || record.status !== "ok" || !record.memoryPath) continue;
    const transcript = record.transcript || {};
    const sessionIdentity = corroborationIdentityOf(transcript);
    if (!(transcript.corroborationIdentity || transcript.identity || transcript.id)) continue;
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
      let destinationIdentity = sessionIdentity;
      let sourceQualified = false;
      if (
        !destinationAcceptsObservation(
          entry.sessions[destinationIdentity],
          sessionIdentity,
          transcript,
          observersByNative,
        )
      ) {
        destinationIdentity = transcript.identity || transcript.id;
      }
      if (
        !destinationAcceptsObservation(
          entry.sessions[destinationIdentity],
          sessionIdentity,
          transcript,
          observersByNative,
        )
      ) {
        destinationIdentity = JSON.stringify([sessionIdentity, transcript.identity || transcript.id]);
        sourceQualified = true;
      }
      const prior = takePriorObservations(
        entry,
        sessionIdentity,
        (sourceQualified ? [] : sessionIdentityAliases(transcript, sessionIdentity, legacyIds)).filter(
          (identity) =>
            identity !== destinationIdentity &&
            !entry.sessions[identity]?.sourceSessionId &&
            (entry.sessions[identity]?.sightingIds || []).every((native) => {
              const observers = observersByNative.get(native);
              return observers?.size === 1 && observers.has(sessionIdentity);
            }),
        ),
        transcript,
        destinationIdentity,
      );
      const { priors, firstObservedAt } = prior;
      const coveredBySkill = gap.coveredBySkill || prior.coveredBySkill;
      const phrasings = [
        ...new Set([
          ...priors.flatMap(
            (observation) => observation.phrasings || [observation.proposedInstruction].filter(Boolean),
          ),
          gap.proposedInstruction,
        ]),
      ];
      entry.sessions[destinationIdentity] = {
        firstObservedAt: firstObservedAt || observedAt,
        observedAt,
        sessionStartedAt:
          transcript.corroborationStartedAt ??
          transcript.startedAt ??
          priors.find((observation) => observation.sessionStartedAt)?.sessionStartedAt ??
          null,
        memoryHash: record.memoryHash || null,
        source: gapSource(transcript),
        sourceSessionId: transcript.identity || transcript.id,
        sightingIds: [
          ...new Set(
            [
              ...priors.flatMap((observation) => observation.sightingIds || []),
              transcript.identity || transcript.id,
            ].filter(Boolean),
          ),
        ],
        ...(priors.some(hasUnattributedSightings) ? { unattributedSightings: true } : {}),
        mistake: gap.mistake,
        quote: gap.quote,
        quoteProvenance: gap.quoteProvenance,
        recurrenceRisk: gap.recurrenceRisk,
        phrasings,
        domain:
          gap.domain === "orchestration" &&
          !priors.some((observation) => observation.observedAt === observedAt && observation.domain !== "orchestration")
            ? "orchestration"
            : "project",
        // A failed trigger: the analysis judged an existing skill's content to cover
        // this mistake. Absent when no skill covers it (including all pre-existing
        // observations), and absence never counts as a citation.
        ...(coveredBySkill ? { coveredBySkill } : {}),
        ...(transcript.project ? { project: transcript.project } : {}),
        ...(transcript.projectRoot ? { projectRoot: transcript.projectRoot } : {}),
      };
      recorded += 1;
    }
  }
  return recorded;
}
/**
 * Re-key selected observations in old ledgers under the identity and provenance rules
 * above; native analysis identities remain separate from corroborating observers.
 */
export function normalizeGapLedgerSessions(ledger, transcripts, { legacyIds = new Set() } = {}) {
  const selections = [];
  const observersByNative = selectedNativeObservers(transcripts, legacyIds);
  for (const transcript of transcripts) {
    if (!(transcript?.corroborationIdentity || transcript?.identity || transcript?.id)) continue;
    const sessionIdentity = corroborationIdentityOf(transcript);
    const aliases = sessionIdentityAliases(transcript, sessionIdentity, legacyIds);
    const ordinaryNative = isOrdinaryNative(transcript, sessionIdentity);
    selections.push({ transcript, sessionIdentity, aliases, ordinaryNative });
  }

  const resolvesTo = (observation, sessionIdentity) =>
    resolveGapObservationObserver(observation, observersByNative) === sessionIdentity;
  for (const entry of Object.values(ledger.entries)) {
    for (const { transcript, sessionIdentity, aliases: nativeAliases, ordinaryNative } of selections) {
      const destination = entry.sessions[sessionIdentity];
      if (
        destination &&
        !resolvesTo(destination, sessionIdentity) &&
        !(
          ordinaryNative &&
          !destination.sourceSessionId &&
          (destination.sightingIds || []).every((native) => {
            const observers = observersByNative.get(native);
            return observers?.size === 1 && observers.has(sessionIdentity);
          })
        )
      )
        continue;
      const aliases = nativeAliases.filter((identity) => {
        const prior = entry.sessions[identity];
        return !prior?.sourceSessionId
          ? (prior?.sightingIds || []).every((native) => {
              const observers = observersByNative.get(native);
              return observers?.size === 1 && observers.has(sessionIdentity);
            })
          : resolvesTo(prior, sessionIdentity);
      });
      for (const [identity, prior] of Object.entries(entry.sessions)) {
        if (
          identity !== sessionIdentity &&
          prior.sourceSessionId === (transcript.identity || transcript.id) &&
          resolvesTo(prior, sessionIdentity) &&
          !aliases.includes(identity)
        )
          aliases.push(identity);
      }
      const observation = entry.sessions[sessionIdentity];
      if (ordinaryNative && observation && !observation.sourceSessionId) {
        observation.sourceSessionId = transcript.identity || transcript.id;
        observation.sightingIds = [...new Set([...(observation.sightingIds || []), observation.sourceSessionId])];
        delete observation.unattributedSightings;
      }
      if (!aliases.some((identity) => entry.sessions[identity])) continue;
      const { priors, firstObservedAt, coveredBySkill } = takePriorObservations(
        entry,
        sessionIdentity,
        aliases,
        transcript,
      );
      const current = priors.find((observation) => observation.quoteProvenance?.kind === "source") || priors[0];
      const project = current.project || priors.find((observation) => observation.project)?.project;
      const projectRoot = current.projectRoot || priors.find((observation) => observation.projectRoot)?.projectRoot;

      entry.sessions[sessionIdentity] = {
        ...current,
        ...(firstObservedAt ? { firstObservedAt } : {}),
        sightingIds: [...new Set(priors.flatMap((observation) => observation.sightingIds || []))],
        ...(priors.some(hasUnattributedSightings) ? { unattributedSightings: true } : {}),
        phrasings: [
          ...new Set([
            entry.proposedInstruction,
            ...priors.flatMap(
              (observation) => observation.phrasings || [observation.proposedInstruction].filter(Boolean),
            ),
          ]),
        ].filter(Boolean),
        domain: priors.some((observation) => observation.domain !== "orchestration") ? "project" : "orchestration",
        ...(coveredBySkill ? { coveredBySkill } : {}),
        ...(project ? { project } : {}),
        ...(projectRoot ? { projectRoot } : {}),
      };
    }
  }
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
      if (obs.quoteProvenance?.kind !== "source") continue;
      observations.push({
        proposedInstruction: entry.proposedInstruction,
        phrasings: obs.phrasings?.length ? obs.phrasings : [entry.proposedInstruction],
        sessionId,
        gapIds: [entry.id, ...(entry.aliases || [])],
        source: obs.source,
        ...(obs.sourceSessionId ? { sourceSessionId: obs.sourceSessionId } : {}),
        sightingIds: obs.sightingIds || [],
        unattributedSightings: hasUnattributedSightings(obs),
        mistake: obs.mistake,
        quote: obs.quote,
        quoteProvenance: obs.quoteProvenance,
        recurrenceRisk: obs.recurrenceRisk,
        domain: obs.domain === "orchestration" ? "orchestration" : "project",
        ...(obs.coveredBySkill && (!skillNames || skillNames.has(obs.coveredBySkill))
          ? { coveredBySkill: obs.coveredBySkill }
          : {}),
        ...(obs.project ? { project: obs.project } : {}),
        ...(obs.projectRoot ? { projectRoot: obs.projectRoot } : {}),
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
          if (prior.quoteProvenance?.kind !== "source" && obs.quoteProvenance?.kind === "source") {
            for (const field of [
              "quote",
              "quoteProvenance",
              "source",
              "sourceSessionId",
              "mistake",
              "recurrenceRisk",
              "project",
              "projectRoot",
            ])
              prior[field] = obs[field];
          }
          const earlier =
            Date.parse(obs.firstObservedAt || obs.observedAt) < Date.parse(prior.firstObservedAt || prior.observedAt);
          if (earlier) prior.firstObservedAt = obs.firstObservedAt || obs.observedAt;
          if (prior.domain === "orchestration" && obs.domain !== "orchestration") prior.domain = "project";
          if (!prior.coveredBySkill && obs.coveredBySkill) prior.coveredBySkill = obs.coveredBySkill;
          if (!prior.project && obs.project) prior.project = obs.project;
          if (!prior.projectRoot && obs.projectRoot) prior.projectRoot = obs.projectRoot;
          prior.sightingIds = [...new Set([...(prior.sightingIds || []), ...(obs.sightingIds || [])])];
          if (hasUnattributedSightings(prior) || hasUnattributedSightings(obs)) prior.unattributedSightings = true;
          prior.phrasings = [
            ...new Set([
              ...(prior.phrasings || [target.proposedInstruction]),
              ...(obs.phrasings || [entry.proposedInstruction]),
            ]),
          ];
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
