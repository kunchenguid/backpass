import { parseMaxTranscripts, parseSince } from "./config.js";
import { color, info } from "./logger.js";

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
 * O(n log n). The RNG is a seedable splitmix32 so runs are reproducible with `--seed`.
 *
 * This module is pure: it never touches the cache, so evidence for a sampled transcript
 * is reused by the analyzer exactly as before.
 */

export const DEFAULT_SAMPLE_HALF_LIFE = "14d";

/** splitmix32: small, seedable, and uniform enough for sampling keys. */
export function seededRandom(seed) {
  let state = Number(seed) >>> 0 || 0x9e3779b9;
  return () => {
    state = (state + 0x9e3779b9) | 0;
    let t = state ^ (state >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return (t >>> 0) / 4294967296;
  };
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
  const random = seededRandom(seed ?? Math.floor(Math.random() * 0xffffffff));
  const halfLifeMs = parseSince(halfLife) ?? Infinity;
  const keyed = transcripts.map((transcript, index) => {
    const u = random() || Number.EPSILON;
    return { index, key: -Math.log(u) / recencyWeight(transcript, { now, halfLifeMs }) };
  });
  keyed.sort((a, b) => a.key - b.key);
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
