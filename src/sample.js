import crypto from "node:crypto";

import { parseMaxTranscripts, parseSince } from "./config.js";
import { classifyInteraction, corpusMix, formatCorpusMix, NON_INTERACTIVE } from "./interaction.js";
import { color, info } from "./logger.js";
import { transcriptIdentity } from "./transcript.js";

/**
 * Recency-weighted capping of the discovered transcript set.
 *
 * Analysis costs one model call per transcript, so a repo with a long history (or a
 * `--since all` run) needs a bound. A plain "newest N" cut would silently erase the
 * older history; instead, when discovery exceeds `maxTranscripts` we draw a weighted
 * sample WITHOUT replacement where each transcript's weight decays exponentially with
 * its age: weight = 2^(-age / halfLife). Recent sessions are almost always kept, old
 * ones are still represented in proportion to their weight.
 *
 * When both interactive and non-interactive sessions are present, the draw is
 * stratified. Slots are allocated proportional-with-floor (see `mixAllocations`): the
 * sample follows the corpus mix when both sides are healthy, but a category that would
 * fall below 20% of the cap is boosted up to that floor (or all of its members, if
 * fewer). That is why a 98% non-interactive corpus still keeps its interactive
 * sessions in the sample instead of letting recency-weighted chance drop them. A
 * 50/50 split is not forced - balanced-then-fill would distort a genuinely mixed
 * corpus. One category only falls back to the historical single-pool draw.
 *
 * Sampling uses the Efraimidis-Spirakis one-pass scheme: key = -ln(u) / weight with
 * u ~ U(0, 1), keep the N smallest keys. That is exactly weighted sampling without
 * replacement (an exponential race with rate = weight), needs no rejection loop, and is
 * O(n log n).
 *
 * `u` is NOT drawn from a shared PRNG stream stepped once per transcript - that would
 * make every transcript's draw depend on how many other transcripts came before it in
 * the array, so an unrelated insertion or a reordering would reshuffle everyone's draw
 * (and, with `config.seed` defaulting to null, the CLI reseeded from `Math.random()` on
 * every invocation, so even an unchanged rerun drew a different sample - see the
 * `sample-reuse` regression tests). Instead each transcript's `u` is `sampleUnit`, a hash
 * of that transcript's canonical discovery identity, never its array position, plus the
 * configured seed. That makes sampling: (1)
 * deterministic and sticky by default, with no persisted state - the same corpus and
 * config always draw the same `u` per transcript; (2) stable under growth - a transcript
 * already in the corpus keeps the exact same `u` (and so the same key, modulo its own
 * weight) when other transcripts are added, removed, or reordered; new transcripts just
 * compete for slots on the same footing. `--seed` still selects a different, equally
 * reproducible hash input.
 *
 * This module is pure: it never touches the cache, so evidence for a sampled transcript
 * is reused by the analyzer exactly as before.
 */

export const DEFAULT_SAMPLE_HALF_LIFE = "14d";

/** Minimum share of the cap reserved for each category that has at least one session. */
export const SAMPLE_MIX_FLOOR = 0.2;

/**
 * Deterministic draw in [0, 1) for one transcript: a SHA-256 of its durable identity
 * and `seed` (or a fixed default when unseeded), so it depends only on that transcript and
 * the configured seed - never on discovery order, the cap, or which other
 * transcripts are present. Discovery removes duplicate canonical identities, while
 * distinct identities that happen to draw equal keys are ordered by identity.
 */
export function sampleUnit(transcript, seed) {
  const digest = crypto
    .createHash("sha256")
    .update(`${seed ?? "default"} ${transcriptIdentity(transcript)}`, "utf8")
    .digest();
  return digest.readUInt32BE(0) / 0x100000000;
}

/** Epoch ms a transcript is dated to: the session start, else the file mtime. */
export function transcriptTime(transcript) {
  const at = Number(transcript.startedAt);
  if (Number.isFinite(at) && at > 0) return at;
  const mtime = Number(transcript.mtimeMs);
  return Number.isFinite(mtime) && mtime > 0 ? mtime : null;
}

/** 2^(-age / halfLife), clamped so an undated or ancient transcript still has a chance. */
export function recencyWeight(transcript, { now, halfLifeMs }) {
  const at = transcriptTime(transcript);
  if (at === null) return 1e-9;
  const age = Math.max(0, now - at);
  return Math.max(1e-9, Math.pow(2, -age / halfLifeMs));
}

/**
 * Slot counts for a two-category sample. Start from corpus proportion, then raise any
 * present category that would land below `floorRatio` of the cap (clipped to how many
 * members it has). A 98% non-interactive pool therefore keeps its interactive sessions
 * instead of rounding them out of a recency-weighted draw. When both floors cannot fit,
 * fall back to the corpus proportion because representing both sides is impossible.
 */
export function mixAllocations(nInteractive, nNonInteractive, cap, floorRatio = SAMPLE_MIX_FLOOR) {
  const nI = Math.max(0, nInteractive);
  const nN = Math.max(0, nNonInteractive);
  if (nI + nN <= cap) return { interactive: nI, nonInteractive: nN };
  if (nI === 0) return { interactive: 0, nonInteractive: cap };
  if (nN === 0) return { interactive: cap, nonInteractive: 0 };

  const floor = Math.max(1, Math.ceil(cap * floorRatio));
  const minI = Math.min(nI, floor);
  const minN = Math.min(nN, floor);

  if (minI + minN > cap) {
    let wantI = Math.min(nI, Math.round((nI / (nI + nN)) * cap));
    let wantN = cap - wantI;
    if (wantN > nN) {
      wantN = nN;
      wantI = cap - wantN;
    }
    return { interactive: wantI, nonInteractive: wantN };
  }

  let wantI = Math.round((nI / (nI + nN)) * cap);
  wantI = Math.min(nI, Math.max(wantI, minI));
  let wantN = cap - wantI;
  if (wantN < minN) {
    wantN = minN;
    wantI = cap - wantN;
  }
  if (wantI > nI) {
    wantI = nI;
    wantN = cap - wantI;
  }
  if (wantN > nN) {
    wantN = nN;
    wantI = cap - wantN;
  }
  return { interactive: wantI, nonInteractive: wantN };
}

function weightedSample(transcripts, count, { seed, now, halfLifeMs }) {
  if (count === null || transcripts.length <= count) return transcripts;
  const keyed = transcripts.map((transcript, index) => {
    const u = sampleUnit(transcript, seed) || Number.EPSILON;
    return {
      index,
      identity: transcriptIdentity(transcript),
      key: -Math.log(u) / recencyWeight(transcript, { now, halfLifeMs }),
    };
  });
  keyed.sort((a, b) => a.key - b.key || (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
  const kept = new Set(keyed.slice(0, count).map((k) => k.index));
  return transcripts.filter((_, index) => kept.has(index));
}

/**
 * Weighted sample without replacement of `count` transcripts. Returns the kept
 * transcripts in their original (newest-first) order so downstream output is stable.
 *
 * @param {object[]} transcripts
 * @param {number | null} count
 * @param {{ seed?: number, now?: number, halfLife?: string }} [options]
 */
export function sampleTranscripts(
  transcripts,
  count,
  { seed, now = Date.now(), halfLife = DEFAULT_SAMPLE_HALF_LIFE } = {},
) {
  if (count === null || transcripts.length <= count) return transcripts;
  const halfLifeMs = parseSince(halfLife) ?? Infinity;
  const options = { seed, now, halfLifeMs };
  const interactive = [];
  const nonInteractive = [];
  for (const transcript of transcripts) {
    if (classifyInteraction(transcript) === NON_INTERACTIVE) nonInteractive.push(transcript);
    else interactive.push(transcript);
  }
  if (interactive.length === 0 || nonInteractive.length === 0) {
    return weightedSample(transcripts, count, options);
  }
  if (count === 1 && interactive.length === nonInteractive.length) {
    return weightedSample(transcripts, count, options);
  }
  const alloc = mixAllocations(interactive.length, nonInteractive.length, count);
  const keptInteractive = new Set(weightedSample(interactive, alloc.interactive, options));
  const keptNonInteractive = new Set(weightedSample(nonInteractive, alloc.nonInteractive, options));
  return transcripts.filter((transcript) => keptInteractive.has(transcript) || keptNonInteractive.has(transcript));
}

/**
 * Apply the configured cap to a discovery result, reporting it on stderr when sampling
 * actually happened. Under the cap the set passes through untouched and nothing is
 * printed.
 */
export function capTranscripts(result, config, { now = Date.now() } = {}) {
  const cap = parseMaxTranscripts(config.maxTranscripts);
  const discovered = result.transcripts.length;
  if (cap === null || discovered <= cap) return result;
  const sampled = sampleTranscripts(result.transcripts, cap, {
    seed: config.seed ?? undefined,
    now,
    halfLife: config.sampleHalfLife,
  });
  const sampledMix = corpusMix(sampled);
  const discoveredMix = corpusMix(result.transcripts);
  const mixed = discoveredMix.interactive > 0 && discoveredMix.nonInteractive > 0;
  info(
    `${color.yellow("·")} discovered ${discovered} transcript(s), analyzing a recency-weighted sample of ${sampled.length} (--max-transcripts)` +
      (mixed ? ` · ${formatCorpusMix(sampledMix)}` : ""),
  );
  return { ...result, transcripts: sampled, sampledFrom: discovered };
}
