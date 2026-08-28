import crypto from "node:crypto";

import { parseMaxTranscripts, parseSince } from "./config.js";
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
 * Weighted sample without replacement of `count` transcripts. Returns the kept
 * transcripts in their original (newest-first) order so downstream output is stable.
 */
/**
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
  info(
    `${color.yellow("·")} discovered ${discovered} transcript(s), analyzing a recency-weighted sample of ${sampled.length} (--max-transcripts)`,
  );
  return { ...result, transcripts: sampled, sampledFrom: discovered };
}
