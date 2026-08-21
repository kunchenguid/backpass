import * as claude from './adapters/claude.js';
import * as codex from './adapters/codex.js';
import * as pi from './adapters/pi.js';
import * as grok from './adapters/grok.js';
import * as opencode from './adapters/opencode.js';
import * as cursorCli from './adapters/cursor-cli.js';
import * as cursorIde from './adapters/cursor-ide.js';

import { associate, passesStrict } from './association.js';
import { sinceCutoff } from '../config.js';
import { warn } from '../logger.js';

export const ADAPTERS = {
  claude,
  codex,
  pi,
  grok,
  opencode,
  cursor: cursorCli,
  'cursor-ide': cursorIde,
};

export function getAdapter(harness) {
  return ADAPTERS[harness] || null;
}

/**
 * Discovery (design section 2).
 *
 * For file-backed stores the expensive step is reading each transcript's header, so
 * results are memoised in `.backpass/scan-cache.json` keyed by path + mtime + size.
 * Re-scans are then O(new files) - which matters: codex alone had 10,317 rollouts on
 * the machine this was designed against.
 *
 * SQLite-backed stores (opencode, cursor IDE) answer the same question with one indexed
 * query, so they skip the cache entirely.
 *
 * Every harness is fail-soft: a store that is missing, unreadable, or has drifted into
 * an unrecognised format produces a named warning and is skipped, never a failed run.
 */
export async function discoverTranscripts({ repo, config, strict = false, harnesses = null, now = Date.now() }) {
  const cutoffMs = sinceCutoff(config.discovery.since, now);
  const selected = harnesses || config.discovery.harnesses;
  const cache = config.state.readScanCache();

  const transcripts = [];
  const perHarness = {};
  let cacheDirty = false;

  for (const harness of selected) {
    const adapter = getAdapter(harness);
    if (!adapter) {
      warn(`no adapter for harness "${harness}" - skipped`);
      continue;
    }

    const stats = { scanned: 0, matched: 0, cached: 0, skipped: 0, error: null };
    perHarness[harness] = stats;

    try {
      const found = adapter.discover
        ? await discoverDirect(adapter, { repo, config, cutoffMs, strict, stats })
        : discoverFiles(adapter, { repo, config, cutoffMs, strict, stats, cache, markDirty: () => { cacheDirty = true; } });
      transcripts.push(...found);
      stats.matched = found.length;
    } catch (err) {
      stats.error = err.message;
      warn(`${harness}: transcript store unreadable (${err.message}) - harness skipped`);
    }
  }

  if (cacheDirty) config.state.writeScanCache(cache);

  transcripts.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  return { transcripts, perHarness, cutoffMs };
}

async function discoverDirect(adapter, { repo, config, cutoffMs, strict, stats }) {
  const rows = await adapter.discover({ cutoffMs, repo, config });
  const out = [];
  for (const row of rows) {
    stats.scanned += 1;
    const association = associate(
      { cwd: row.cwd, remotes: row.remotes || [], gitRoot: row.gitRoot },
      repo,
      { worktreeGlobs: config.discovery.worktreeGlobs },
    );
    if (!passesStrict(association, strict)) {
      stats.skipped += 1;
      continue;
    }
    out.push(toTranscript(adapter, row, association, row.id));
  }
  return out;
}

function discoverFiles(adapter, { repo, config, cutoffMs, strict, stats, cache, markDirty }) {
  const candidates = adapter.enumerate({ cutoffMs, repo, config });
  const out = [];

  for (const candidate of candidates) {
    if (cutoffMs && candidate.mtimeMs < cutoffMs) continue;
    stats.scanned += 1;

    const cacheKey = `${adapter.name}:${candidate.key}`;
    const cached = cache.entries[cacheKey];
    let descriptor;

    if (cached && cached.mtimeMs === candidate.mtimeMs && cached.bytes === candidate.bytes) {
      stats.cached += 1;
      descriptor = cached.descriptor;
    } else {
      descriptor = adapter.classify(candidate, { repo, config }) || null;
      cache.entries[cacheKey] = { mtimeMs: candidate.mtimeMs, bytes: candidate.bytes, descriptor };
      markDirty();
    }

    if (!descriptor) {
      stats.skipped += 1;
      continue;
    }

    const association = associate(
      { cwd: descriptor.cwd, remotes: descriptor.remotes || [], gitRoot: descriptor.gitRoot },
      repo,
      { worktreeGlobs: config.discovery.worktreeGlobs },
    );
    if (!passesStrict(association, strict)) {
      stats.skipped += 1;
      continue;
    }

    out.push(toTranscript(adapter, { ...candidate, ...descriptor }, association, descriptor.id));
  }

  return out;
}

function toTranscript(adapter, row, association, id) {
  return {
    harness: adapter.name,
    id: `${adapter.name}-${id}`,
    nativeId: id,
    path: row.path,
    cwd: row.cwd || null,
    gitBranch: row.gitBranch || null,
    title: row.title || null,
    model: row.model || null,
    startedAt: row.startedAt || null,
    mtimeMs: row.mtimeMs || 0,
    bytes: row.bytes || 0,
    experimental: Boolean(adapter.experimental),
    association,
    extra: row.extra || {},
  };
}

/** Read one transcript through its adapter and normalize it to distiller events. */
export async function readTranscript(transcript) {
  const adapter = getAdapter(transcript.harness);
  if (!adapter) throw new Error(`no adapter for harness ${transcript.harness}`);
  const result = await adapter.read(transcript);
  return {
    events: result.events || [],
    model: result.model || transcript.model || null,
    rawPath: adapter.rawPath ? adapter.rawPath(transcript) : transcript.path,
  };
}
