import fs from "node:fs";

import * as claude from "./adapters/claude.js";
import * as codex from "./adapters/codex.js";
import * as pi from "./adapters/pi.js";
import * as grok from "./adapters/grok.js";
import * as opencode from "./adapters/opencode.js";
import * as hermes from "./adapters/hermes.js";
import * as cursorCli from "./adapters/cursor-cli.js";
import * as cursorIde from "./adapters/cursor-ide.js";

import { associate, passesStrict } from "./association.js";
import { collectHosts, resolveHostList } from "./hosts.js";
import { isSelfSession } from "./self.js";
import { classifyInteraction, emptyInteractionSignals, hasInteractionSignals } from "../interaction.js";
import { sinceCutoff } from "../config.js";
import { emitProgress } from "../progress.js";
import { warn } from "../logger.js";
import { transcriptIdentity } from "../transcript.js";
import { passesProjectFilter } from "../scope.js";

export const ADAPTERS = Object.assign(Object.create(null), {
  claude,
  codex,
  pi,
  grok,
  opencode,
  hermes,
  cursor: cursorCli,
  "cursor-ide": cursorIde,
});

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
 * SQLite-backed stores (opencode, hermes, cursor IDE) answer the same question with one
 * indexed query, so they skip the cache entirely.
 *
 * Every harness is fail-soft: a store that is missing, unreadable, or has drifted into
 * an unrecognised format produces a named warning and is skipped, never a failed run.
 *
 * Sessions backpass itself created (its analysis and synthesis calls, which the harness
 * files under this repo's cwd) are excluded after association and counted in
 * `perHarness[h].self` - see `./self.js`.
 *
 * Configured ssh hosts (`./hosts.js`) are collected after the local harnesses and join
 * the same corpus: same tiers, same sample, same cap. They have no tier of their own and
 * no budget of their own. A session that exists on two machines - a synced or copied
 * store - is kept once, or one session would satisfy `minGapEvidence` by itself.
 */
export async function discoverTranscripts({
  repo,
  scope = null,
  config,
  strict = false,
  harnesses = null,
  now = Date.now(),
}) {
  const cutoffMs = sinceCutoff(config.discovery.since, now);
  const selected = harnesses || config.discovery.harnesses;
  const cache = config.state.readScanCache();
  const associateFn =
    scope?.associate ||
    ((descriptor) => associate(descriptor, repo, { worktreeGlobs: config.discovery.worktreeGlobs }));
  const stateDir = config.state?.root;
  const userFilter = scope?.kind === "user";

  const transcripts = [];
  const identities = new Set();
  const perHarness = {};
  let cacheDirty = false;
  const hosts = resolveHostList(config);

  emitProgress("discover:start", { harnesses: selected.filter((h) => getAdapter(h)) });

  for (const harness of selected) {
    const adapter = getAdapter(harness);
    if (!adapter) {
      warn(`no adapter for harness "${harness}" - skipped`);
      continue;
    }

    const stats = { scanned: 0, matched: 0, cached: 0, skipped: 0, self: 0, error: null };
    perHarness[harness] = stats;
    emitProgress("discover:harness:start", { harness });

    try {
      const found = adapter.discover
        ? await discoverDirect(adapter, {
            repo,
            config,
            cutoffMs,
            strict,
            stats,
            associateFn,
            stateDir,
            userFilter,
          })
        : discoverFiles(adapter, {
            repo,
            config,
            cutoffMs,
            strict,
            stats,
            cache,
            associateFn,
            stateDir,
            userFilter,
            markDirty: () => {
              cacheDirty = true;
            },
          });
      const unique = found.filter((transcript) => {
        if (identities.has(transcript.identity)) return false;
        identities.add(transcript.identity);
        return true;
      });
      transcripts.push(...unique);
      stats.matched = unique.length;
      emitProgress("discover:harness:done", {
        harness,
        scanned: stats.scanned,
        cached: stats.cached,
        matched: stats.matched,
        self: stats.self,
        tiers: tierCounts(unique),
      });
    } catch (err) {
      stats.error = err.message;
      warn(`${harness}: transcript store unreadable (${err.message}) - harness skipped`);
      emitProgress("discover:harness:done", { harness, error: err.message });
    }
  }

  if (cacheDirty) config.state.writeScanCache(cache);

  const perHost = [];
  if (hosts.length) {
    const collected = await collectHosts({ hosts, harnesses: selected.filter((h) => getAdapter(h)), cutoffMs });
    for (const result of collected) {
      const entry = hosts.find((h) => h.host === result.host);
      transcripts.push(...remoteTranscripts(result, entry, { scope, repo, config, strict, identities }));
      perHost.push(hostSummary(result));
    }
  }

  const duplicates = dropCrossHostDuplicates(transcripts);
  for (const row of perHost) row.duplicates = duplicates.get(row.host) || 0;

  scope?.normalizeProjects?.(transcripts);
  transcripts.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  emitProgress("discover:done", { total: transcripts.length });
  return { transcripts, perHarness, perHost, cutoffMs };
}

function hostSummary(result) {
  return {
    host: result.host,
    node: result.nodeVersion,
    platform: result.platform,
    hostname: result.hostname,
    harnesses: result.harnesses,
    scanned: result.scanned,
    matched: result.matched,
    self: result.self,
    skipped: result.skipped,
    duplicates: 0,
    warnings: result.warnings,
    error: result.error,
  };
}

/**
 * Turn one host's descriptors into transcripts, applying the same gates local discovery
 * applies: association (against the facts the probe computed where the paths are real),
 * `--strict`, and the user-scope project filter. The probe already dropped backpass's
 * own sessions on that machine, so none of them ever crossed the wire.
 */
function remoteTranscripts(result, entry, { scope, repo, config, strict, identities }) {
  if (result.error) return [];
  const associateFn =
    scope?.associateRemote ||
    ((descriptor, options) =>
      associate(descriptor, repo, { ...options, worktreeGlobs: config.discovery.worktreeGlobs }));
  const userFilter = scope?.kind === "user";
  const out = [];

  for (const descriptor of result.descriptors) {
    const adapter = getAdapter(descriptor.harness);
    if (!adapter) continue;
    const association = associateFn(
      { cwd: descriptor.cwd, remotes: descriptor.remotes || [], gitRoot: descriptor.gitRoot },
      { facts: result.facts, host: result.host, home: result.home || "" },
    );
    if (!passesStrict(association, strict)) {
      result.skipped += 1;
      continue;
    }
    const transcript = toTranscript(adapter, descriptor, association, descriptor.id, {
      host: result.host,
      remote: {
        host: result.host,
        node: result.node,
        env: entry?.env || {},
        connectTimeoutSeconds: entry?.connectTimeoutSeconds,
        controlPersistSeconds: result.controlPersistSeconds,
        kind: descriptor.kind,
        key: descriptor.key,
      },
    });
    if (userFilter && !passesProjectFilter(transcript, config)) {
      result.skipped += 1;
      continue;
    }
    if (identities.has(transcript.identity)) continue;
    identities.add(transcript.identity);
    out.push(transcript);
  }
  result.matched = out.length;
  return out;
}

/**
 * A store synced or copied between machines shows the same session twice. Keep it once -
 * the local copy first, then in configured host order, which is the order transcripts
 * arrive in - and only ever collapse copies that came from *different* machines, so a
 * store legitimately split across two local roots keeps both records.
 *
 * @returns {Map<string, number>} drops attributed to the host whose copy was dropped
 */
function dropCrossHostDuplicates(transcripts) {
  const seen = new Map();
  const drops = new Map();
  let write = 0;
  for (const transcript of transcripts) {
    const key = `${transcript.harness}\n${transcript.nativeId}`;
    const previous = seen.get(key);
    if (previous && previous.host !== (transcript.host || null)) {
      const host = transcript.host || "local";
      drops.set(host, (drops.get(host) || 0) + 1);
      continue;
    }
    if (!previous) seen.set(key, { host: transcript.host || null });
    transcripts[write] = transcript;
    write += 1;
  }
  transcripts.length = write;
  return drops;
}

function tierCounts(found) {
  const tiers = {};
  for (const transcript of found) {
    const tier = transcript.association?.tier;
    if (tier) tiers[tier] = (tiers[tier] || 0) + 1;
  }
  return tiers;
}

async function discoverDirect(adapter, { repo, config, cutoffMs, strict, stats, associateFn, stateDir, userFilter }) {
  const rows = await adapter.discover({ cutoffMs, repo, config });
  const out = [];
  for (const row of rows) {
    stats.scanned += 1;
    const association = associateFn({ cwd: row.cwd, remotes: row.remotes || [], gitRoot: row.gitRoot });
    if (!passesStrict(association, strict)) {
      stats.skipped += 1;
      continue;
    }
    const transcript = toTranscript(adapter, row, association, row.id);
    if (userFilter && !passesProjectFilter(transcript, config)) {
      stats.skipped += 1;
      continue;
    }
    if (isSelfSession(transcript, { stateDir })) {
      stats.self += 1;
      continue;
    }
    out.push(transcript);
  }
  return out;
}

function discoverFiles(
  adapter,
  { repo, config, cutoffMs, strict, stats, cache, markDirty, associateFn, stateDir, userFilter },
) {
  const candidates = adapter.enumerate({ cutoffMs, repo, config });
  const out = [];

  for (const candidate of candidates) {
    if (cutoffMs && candidate.mtimeMs < cutoffMs) continue;
    stats.scanned += 1;
    // Large stores (codex holds 10k+ session files) get a live scan tick; the
    // classify loop is synchronous, so this is the only paint opportunity.
    if (stats.scanned % 25 === 0) {
      emitProgress("discover:harness:tick", {
        harness: adapter.name,
        scanned: stats.scanned,
        total: candidates.length,
        matched: out.length,
      });
    }

    const cacheKey = `${adapter.name}:${candidate.key}`;
    const cached = cache.entries[cacheKey];
    let descriptor;

    if (
      cached &&
      cached.mtimeMs === candidate.mtimeMs &&
      cached.bytes === candidate.bytes &&
      hasInteractionSignals(cached.descriptor)
    ) {
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

    const association = associateFn({
      cwd: descriptor.cwd,
      remotes: descriptor.remotes || [],
      gitRoot: descriptor.gitRoot,
    });
    if (!passesStrict(association, strict)) {
      stats.skipped += 1;
      continue;
    }

    const transcript = toTranscript(adapter, { ...candidate, ...descriptor }, association, descriptor.id);
    if (userFilter && !passesProjectFilter(transcript, config)) {
      stats.skipped += 1;
      continue;
    }
    // backpass's own acpx runs land in this store under this cwd; drop them here so
    // they never reach sampling or analysis (see ./self.js).
    if (isSelfSession(transcript, { stateDir })) {
      stats.self += 1;
      continue;
    }
    out.push(transcript);
  }

  return out;
}

function toTranscript(adapter, row, association, id, { host = null, remote = null } = {}) {
  const transcript = {
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
    contentSignature: row.contentSignature || null,
    experimental: Boolean(adapter.experimental),
    association,
    extra: row.extra || {},
    interactionSignals: row.interactionSignals ?? row.extra?.interactionSignals ?? emptyInteractionSignals(),
    project: association?.project || null,
    projectRoot: association?.projectRoot || null,
    /** The ssh destination this session was collected from; null for a local store. */
    host,
    /** How to fetch and read it again: host, node, cache kind and key. Null when local. */
    remote,
  };
  transcript.identity = transcriptIdentity(transcript);
  transcript.interaction = classifyInteraction(transcript);
  return transcript;
}

/**
 * Read one transcript through its adapter and normalize it to distiller events.
 *
 * A remote session reads from the copy the fetch step cached locally. For a file-backed
 * store that copy is the transcript file itself, so the adapter runs unchanged and
 * `rawPath` names a real local file - which is what keeps the analysis prompt's
 * raw-transcript escape hatch working for a session that ran on another machine. A
 * SQLite store has no per-session file to copy, so the probe ran `read()` over there and
 * the cache holds its events, exactly the situation a local SQLite session is already in.
 */
export async function readTranscript(transcript) {
  const adapter = getAdapter(transcript.harness);
  if (!adapter) throw new Error(`no adapter for harness ${transcript.harness}`);

  if (transcript.host) {
    if (transcript.remoteError) throw new Error(transcript.remoteError);
    const cached = transcript.remote?.cachePath;
    if (!cached) throw new Error("remote fetch incomplete");
    if (transcript.remote.kind === "events") {
      const payload = JSON.parse(fs.readFileSync(cached, "utf8"));
      return {
        events: payload.events || [],
        model: payload.model || transcript.model || null,
        rawPath: cached,
      };
    }
    const local = { ...transcript, path: cached, extra: { ...transcript.extra, chatPath: cached } };
    const result = await adapter.read(local);
    return {
      events: result.events || [],
      model: result.model || transcript.model || null,
      rawPath: cached,
    };
  }

  const result = await adapter.read(transcript);
  return {
    events: result.events || [],
    model: result.model || transcript.model || null,
    rawPath: adapter.rawPath ? adapter.rawPath(transcript) : transcript.path,
  };
}
