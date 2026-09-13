import { UserError, info, warn } from "../logger.js";
import { emitProgress } from "../progress.js";
import { HostCache } from "./cache.js";
import { buildProbeProgram, createFrameReader, PROTOCOL, REMOTE_ENV_ALLOWLIST } from "./remote/bundle.js";
import {
  assertSafeSshValue,
  classifySshFailure,
  closeSshMaster,
  closeSshMasters,
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  runSsh,
  startSshMaster,
} from "./remote/ssh.js";
import { compareNodeVersions, MIN_SQLITE_NODE, parseNodeVersion, supportsNodeSqlite } from "./remote/runtime.js";

export { MIN_SQLITE_NODE } from "./remote/runtime.js";

/**
 * Per-host orchestration for the ssh collection tier (design section 6.3).
 *
 * Three remote commands per host, multiplexed over one connection: find a Node and a git, run the
 * probe's `discover`, and later run its `fetch` for the sampled sessions that still need
 * content. Every host is fail-soft in exactly the way a harness whose store is
 * unreadable already is - the run continues on local sessions and the host becomes one
 * named row - because a laptop that is asleep must not be able to fail a run.
 *
 * Hosts are personal configuration. A repository can never point a contributor's
 * backpass at a machine (`src/config.js` refuses `discovery.hosts` in `.backpassrc.json`),
 * which is what keeps this feature on the right side of the vision's "never someone
 * else's transcripts" line.
 */

const LOCATE_TIMEOUT_MS = 60_000;
const DISCOVER_TIMEOUT_MS = 300_000;
const FETCH_TIMEOUT_MS = 900_000;

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);

/**
 * Where a Node might be on a machine whose login profile never ran. A non-interactive
 * ssh session gets a bare PATH, so `node` alone misses every version manager - and a
 * first-match glob picks whichever nvm version sorts first, which on a real host was
 * v16. Every candidate that answers is reported with its version and the newest one
 * wins.
 *
 * The snippet carries no single quote, backslash, or `!`, so it survives being wrapped
 * in `sh -c '...'` - which is itself deliberate, so a fish or csh login shell cannot
 * misparse it.
 */
export const LOCATE_SNIPPET =
  "for n in node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node /run/current-system/sw/bin/node " +
  "$HOME/.nvm/versions/node/*/bin/node $HOME/.volta/bin/node $HOME/.local/share/fnm/aliases/default/bin/node; " +
  'do p=$(command -v "$n" 2>/dev/null) || continue; v=$("$p" -p process.version 2>/dev/null) || continue; ' +
  'echo "node|$p|$v"; done; echo "git|$(command -v git 2>/dev/null)"; ' +
  'echo "uname|$(uname -s 2>/dev/null)"; echo "home|$HOME"';

export const LOCATE_COMMAND = `sh -c '${LOCATE_SNIPPET}'`;

/** The only thing variable about a probe call: which Node runs it. Everything else travels on stdin. */
export function probeCommand(nodePath) {
  assertSafeSshValue("remote node path", nodePath);
  return `'${nodePath}' -`;
}

/**
 * @param {string | object} entry
 * @returns {{ host: string, node: string | null, env: Record<string, string>,
 *   harnesses: string[] | null, connectTimeoutSeconds: number }}
 */
export function normalizeHostEntry(entry) {
  const raw = typeof entry === "string" ? { host: entry } : entry;
  if (!raw || typeof raw !== "object" || typeof raw.host !== "string") {
    throw new UserError(
      `each discovery.hosts entry must be an ssh destination string or an object with a "host" field ` +
        `(got ${JSON.stringify(entry)})`,
    );
  }
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(raw.env || {})) {
    if (!REMOTE_ENV_ALLOWLIST.includes(key)) {
      throw new UserError(
        `discovery.hosts[].env may only set store locations (${REMOTE_ENV_ALLOWLIST.join(", ")}); got "${key}"`,
      );
    }
    if (typeof value !== "string") throw new UserError(`discovery.hosts[].env.${key} must be a string`);
    env[key] = value;
  }
  if (raw.node !== undefined && raw.node !== null && (typeof raw.node !== "string" || !raw.node.startsWith("/"))) {
    throw new UserError("discovery.hosts[].node must be an absolute POSIX path string");
  }
  if (raw.harnesses !== undefined && raw.harnesses !== null) {
    if (!Array.isArray(raw.harnesses) || raw.harnesses.some((h) => typeof h !== "string")) {
      throw new UserError("discovery.hosts[].harnesses must be an array of harness names");
    }
  }
  const connectTimeoutSeconds = raw.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS;
  if (!Number.isInteger(connectTimeoutSeconds) || connectTimeoutSeconds <= 0) {
    throw new UserError("discovery.hosts[].connectTimeoutSeconds must be a positive integer");
  }
  return {
    host: raw.host,
    node: raw.node || null,
    env,
    harnesses: raw.harnesses ? [...raw.harnesses] : null,
    connectTimeoutSeconds,
  };
}

/**
 * The hosts this run collects from: the configured list, plus any `--host`, or none at
 * all when the person passed `--host none`.
 */
export function resolveHostList(config) {
  const entries = config.discovery?.hosts;
  if (!entries) return [];
  if (!Array.isArray(entries)) throw new UserError("config.discovery.hosts must be an array");
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const normalized = normalizeHostEntry(entry);
    if (seen.has(normalized.host)) continue;
    seen.add(normalized.host);
    assertSafeSshValue("ssh destination", normalized.host);
    if (normalized.node) assertSafeSshValue("remote node path", normalized.node);
    out.push(normalized);
  }
  return out;
}

/** @returns {{ nodes: {path: string, version: string, parsed: number[]}[], git: string|null, uname: string|null, home: string|null }} */
export function parseLocateOutput(stdout) {
  const nodes = [];
  let git = null;
  let uname = null;
  let home = null;
  for (const line of String(stdout || "").split("\n")) {
    const [kind, ...rest] = line.trim().split("|");
    if (kind === "node") {
      const [nodePath, version] = rest;
      const parsed = parseNodeVersion(version);
      if (nodePath && parsed) nodes.push({ path: nodePath, version, parsed });
    } else if (kind === "git" && rest[0]) {
      git = rest[0];
    } else if (kind === "uname" && rest[0]) {
      uname = rest[0];
    } else if (kind === "home" && rest[0]) {
      home = rest[0];
    }
  }
  const unique = [];
  for (const node of nodes) {
    if (!unique.some((other) => other.path === node.path)) unique.push(node);
  }
  unique.sort((a, b) => compareNodeVersions(b.parsed, a.parsed));
  return { nodes: unique, git, uname, home };
}

/** Newest Node at or above 22.5 if there is one, else the newest there is. */
export function chooseNode(nodes) {
  return nodes.find((node) => compareNodeVersions(node.parsed, MIN_SQLITE_NODE) >= 0) || nodes[0] || null;
}

export function platformFromUname(uname) {
  const value = String(uname || "").toLowerCase();
  if (value === "darwin") return "darwin";
  if (value === "linux") return "linux";
  return value || null;
}

function emptyHostResult(entry) {
  return {
    host: entry.host,
    node: entry.node,
    nodeVersion: null,
    platform: null,
    hostname: null,
    home: null,
    git: null,
    master: null,
    descriptors: [],
    facts: {},
    harnesses: {},
    warnings: [],
    error: null,
    scanned: 0,
    matched: 0,
    self: 0,
    skipped: 0,
    duplicates: 0,
  };
}

async function locate(entry, controlPath) {
  // One call answers all three questions - platform, git, and every Node on the box -
  // so a configured `node` skips the choosing, not the call.
  const result = await runSsh({
    destination: entry.host,
    command: LOCATE_COMMAND,
    timeoutMs: LOCATE_TIMEOUT_MS,
    connectTimeoutSeconds: entry.connectTimeoutSeconds,
    controlPath,
  });
  const failure = classifySshFailure(result, {
    destination: entry.host,
    connectTimeoutSeconds: entry.connectTimeoutSeconds,
    timeoutMs: LOCATE_TIMEOUT_MS,
  });
  if (failure) return { failure };
  const parsed = parseLocateOutput(result.stdout);
  const configured = entry.node ? parsed.nodes.find((candidate) => candidate.path === entry.node) : null;
  const node = entry.node ? configured || { path: entry.node, version: null, parsed: null } : chooseNode(parsed.nodes);
  return { parsed, node };
}

/**
 * Discover on every configured host, fail-soft per host.
 *
 * @param {{ hosts: object[], harnesses: string[], cutoffMs: number | null, controlPath: string }} options
 * @returns {Promise<object[]>} one result per host, in configured order
 */
export async function collectHosts({ hosts, harnesses, cutoffMs, controlPath }) {
  const results = [];
  for (const entry of hosts) {
    const result = emptyHostResult(entry);
    results.push(result);
    const liveProgress = emitProgress("discover:host:start", { host: entry.host });
    if (!liveProgress) info(`ssh ${entry.host} connecting`);

    try {
      const masterCall = await startSshMaster({
        destination: entry.host,
        connectTimeoutSeconds: entry.connectTimeoutSeconds,
        timeoutMs: LOCATE_TIMEOUT_MS,
        controlPath,
      });
      const masterFailure = classifySshFailure(masterCall, {
        destination: entry.host,
        connectTimeoutSeconds: entry.connectTimeoutSeconds,
        timeoutMs: LOCATE_TIMEOUT_MS,
      });
      if (masterFailure) {
        result.error = `failed to start ssh control master: ${masterFailure.message}`;
      } else {
        result.master = masterCall.master;
        await collectOneHost(entry, { harnesses, cutoffMs }, result);
      }
    } catch (err) {
      if (err instanceof UserError) {
        await closeSshMasters(results.map((hostResult) => hostResult.master).filter(Boolean));
        throw err;
      }
      result.error = err.message;
    }

    if (result.error && result.master) await closeSshMaster(result.master);
    if (result.error) warn(`${entry.host}: ${result.error} - host skipped, run continues`);
    for (const note of result.warnings) warn(`${entry.host}: ${note}`);
    emitProgress("discover:host:done", {
      host: entry.host,
      node: result.nodeVersion,
      error: result.error,
      harnesses: result.harnesses,
      scanned: result.scanned,
    });
    if (!liveProgress && !result.error) {
      info(
        `ssh ${entry.host} done · ${result.nodeVersion ? `node ${result.nodeVersion} · ` : ""}${result.scanned} scanned`,
      );
    }
  }
  return results;
}

async function collectOneHost(entry, { harnesses, cutoffMs }, result) {
  const located = await locate(entry, result.master.controlPath);
  if (located.failure) {
    result.error = located.failure.message;
    return;
  }

  const platform = platformFromUname(located.parsed.uname);
  if (!platform || !SUPPORTED_PLATFORMS.has(platform)) {
    result.error = located.parsed.uname
      ? `Windows and other non-POSIX remotes are not supported (uname said "${located.parsed.uname}")`
      : "could not identify the remote platform (uname produced nothing)";
    return;
  }
  result.platform = platform;
  result.home = located.parsed.home;
  result.git = located.parsed.git;

  const node = located.node;
  if (!node) {
    result.error = `${entry.host} has no Node; install Node >= 22.5 or set discovery.hosts[].node`;
    return;
  }
  result.node = node.path;
  result.nodeVersion = node.version;

  let selected = entry.harnesses ? harnesses.filter((h) => entry.harnesses.includes(h)) : [...harnesses];
  if (node.version && !supportsNodeSqlite(node.version)) {
    const dropped = selected.filter((h) => SQLITE_HARNESSES.has(h));
    selected = selected.filter((h) => !SQLITE_HARNESSES.has(h));
    if (dropped.length) result.warnings.push(`${dropped.join(", ")} skipped: node ${node.version} lacks node:sqlite`);
  }
  if (!located.parsed.git) {
    result.warnings.push("live-path association unavailable (no git on the non-interactive PATH); tiers 2 and 3 only");
  }

  let command;
  try {
    command = probeCommand(node.path);
  } catch (err) {
    // A path the remote itself reported is this host's problem, not the run's.
    result.error = err.message;
    return;
  }

  const program = buildProbeProgram(
    { protocol: PROTOCOL, op: "discover", harnesses: selected, cutoffMs },
    {
      env: entry.env,
    },
  );
  const call = await runSsh({
    destination: entry.host,
    command,
    input: program,
    timeoutMs: DISCOVER_TIMEOUT_MS,
    connectTimeoutSeconds: entry.connectTimeoutSeconds,
    controlPath: result.master.controlPath,
  });
  const failure = classifySshFailure(call, {
    destination: entry.host,
    connectTimeoutSeconds: entry.connectTimeoutSeconds,
    timeoutMs: DISCOVER_TIMEOUT_MS,
  });
  if (failure) {
    result.error = failure.reason === "exit" ? `probe failed: ${failure.message}` : failure.message;
    return;
  }

  let response;
  try {
    response = JSON.parse(call.stdout.trim().split("\n").pop() || "");
  } catch {
    result.error = "probe response unreadable";
    return;
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    result.error = "probe response unreadable";
    return;
  }
  if (response.protocol !== PROTOCOL) {
    result.error = `probe spoke protocol ${response.protocol}, this backpass speaks ${PROTOCOL}`;
    return;
  }
  const validDescriptors =
    Array.isArray(response.transcripts) &&
    response.transcripts.every(
      (descriptor) =>
        descriptor &&
        typeof descriptor === "object" &&
        typeof descriptor.harness === "string" &&
        typeof descriptor.id === "string" &&
        typeof descriptor.path === "string" &&
        typeof descriptor.key === "string" &&
        (descriptor.cwd === null || typeof descriptor.cwd === "string") &&
        (descriptor.gitRoot === null || typeof descriptor.gitRoot === "string") &&
        Array.isArray(descriptor.remotes) &&
        descriptor.remotes.every((remote) => typeof remote === "string") &&
        (descriptor.title === null || typeof descriptor.title === "string") &&
        (descriptor.model === null || typeof descriptor.model === "string") &&
        (descriptor.startedAt === null || Number.isFinite(descriptor.startedAt)) &&
        Number.isFinite(descriptor.mtimeMs) &&
        Number.isFinite(descriptor.bytes) &&
        (descriptor.contentSignature === null || typeof descriptor.contentSignature === "string") &&
        descriptor.extra &&
        typeof descriptor.extra === "object" &&
        !Array.isArray(descriptor.extra) &&
        descriptor.interactionSignals &&
        typeof descriptor.interactionSignals === "object" &&
        !Array.isArray(descriptor.interactionSignals) &&
        (descriptor.kind === "raw" || descriptor.kind === "events"),
    );
  const validRecords = [response.harnesses, response.paths].every(
    (value) => value && typeof value === "object" && !Array.isArray(value),
  );
  const validScalars =
    typeof response.node === "string" &&
    typeof response.platform === "string" &&
    typeof response.hostname === "string" &&
    typeof response.home === "string" &&
    response.home.length > 0;
  const validHarnesses =
    validRecords &&
    Object.values(response.harnesses).every(
      (stats) =>
        stats &&
        typeof stats === "object" &&
        !Array.isArray(stats) &&
        Number.isFinite(stats.scanned) &&
        Number.isFinite(stats.classified) &&
        Number.isFinite(stats.self) &&
        (stats.error === null || typeof stats.error === "string"),
    );
  const validFacts =
    validRecords &&
    Object.values(response.paths).every(
      (facts) =>
        facts &&
        typeof facts === "object" &&
        !Array.isArray(facts) &&
        typeof facts.real === "string" &&
        typeof facts.exists === "boolean" &&
        (facts.toplevel === null || typeof facts.toplevel === "string") &&
        Array.isArray(facts.remotes) &&
        facts.remotes.every((remote) => typeof remote === "string"),
    );
  const validDescriptorFacts =
    validDescriptors &&
    validFacts &&
    response.transcripts.every((descriptor) =>
      [descriptor.cwd, descriptor.gitRoot]
        .filter((candidate) => candidate !== null)
        .every((candidate) => candidate.length > 0 && Object.hasOwn(response.paths, candidate)),
    );
  if (
    !validDescriptors ||
    !validRecords ||
    !validScalars ||
    !validHarnesses ||
    !validFacts ||
    !validDescriptorFacts ||
    !Array.isArray(response.warnings) ||
    response.warnings.some((note) => typeof note !== "string")
  ) {
    result.error = "probe response unreadable";
    return;
  }

  result.nodeVersion = response.node || result.nodeVersion;
  result.hostname = response.hostname || null;
  result.home = response.home || result.home;
  result.harnesses = response.harnesses || {};
  result.descriptors = response.transcripts || [];
  result.facts = response.paths || {};
  result.scanned = Object.values(result.harnesses).reduce((n, s) => n + (s?.scanned || 0), 0);
  result.self = Object.values(result.harnesses).reduce((n, s) => n + (s?.self || 0), 0);
  for (const note of response.warnings || []) result.warnings.push(note);
}

const SQLITE_HARNESSES = new Set(["opencode", "hermes", "cursor", "cursor-ide"]);

/**
 * Bring the content of the sampled remote sessions local, before the analysis pool.
 *
 * Only what is about to be analyzed moves: transcripts with fresh evidence never reach
 * here, and a cached copy whose descriptor still matches is reused without an ssh call.
 * A frame that arrives short marks that one transcript failed with a named reason and
 * leaves the rest of the run alone - never a truncated session analyzed as a whole one.
 *
 * @param {object[]} transcripts the pending set
 * @param {{ config: object }} options
 */
export async function prefetchRemoteTranscripts(transcripts, { config }) {
  const cache = new HostCache(config.state.root);
  const index = cache.readIndex();
  const stats = { fetched: 0, reused: 0, failed: 0, bytes: 0 };
  const remote = transcripts.filter((t) => t.remote?.host);

  const byHost = new Map();
  for (const transcript of remote) {
    if (!byHost.has(transcript.remote.host)) byHost.set(transcript.remote.host, []);
    byHost.get(transcript.remote.host).push(transcript);
  }

  for (const [host, group] of byHost) {
    try {
      const pending = [];
      for (const transcript of group) {
        const hit = cache.lookup(index, {
          host,
          harness: transcript.harness,
          key: transcript.remote.key,
          mtimeMs: transcript.mtimeMs,
          bytes: transcript.bytes,
          contentSignature: transcript.contentSignature,
        });
        if (hit) {
          transcript.remote.cachePath = hit.path;
          cache.touch(index, hit.name);
          stats.reused += 1;
        } else {
          pending.push(transcript);
        }
      }
      if (pending.length) await fetchHost(host, pending, { cache, index, stats });
    } finally {
      await closeSshMaster(group[0].remote.master);
    }
  }

  if (byHost.size || Object.keys(index.entries).length) {
    cache.prune(index);
    cache.writeIndex(index);
  }
  return stats;
}

async function fetchHost(host, pending, { cache, index, stats }) {
  const first = pending[0].remote;
  const items = pending.map((transcript) => ({
    harness: transcript.harness,
    key: transcript.remote.key,
    kind: transcript.remote.kind,
    path: transcript.path,
    extra: transcript.extra || {},
    model: transcript.model || null,
    mtimeMs: transcript.mtimeMs,
  }));
  const reader = createFrameReader();
  const fetchIdentity = (harness, key) => JSON.stringify([harness, key]);
  const transcriptsByKey = new Map(
    pending.map((transcript) => [fetchIdentity(transcript.harness, transcript.remote.key), transcript]),
  );
  const outcomes = new Map();
  let parseError = null;

  function acceptFrame(frame) {
    const { harness, key } = frame.header;
    const identity = fetchIdentity(harness, key);
    const transcript = transcriptsByKey.get(identity);
    if (!transcript || outcomes.has(identity)) return;
    if (frame.header.kind === "error") {
      outcomes.set(identity, { error: frame.header.error || "remote fetch failed" });
      return;
    }
    try {
      const metadata = {
        host,
        harness: transcript.harness,
        key,
        kind: frame.header.kind,
        mtimeMs:
          frame.header.kind === "raw" && Number.isFinite(frame.header.mtimeMs)
            ? frame.header.mtimeMs
            : transcript.mtimeMs,
        bytes: frame.header.kind === "raw" ? frame.body.length : transcript.bytes,
        contentSignature:
          frame.header.kind === "events" && typeof frame.header.contentSignature === "string"
            ? frame.header.contentSignature
            : transcript.contentSignature,
        model: frame.header.model || null,
      };
      const staged = cache.stage(host, transcript.harness, key, frame.body);
      outcomes.set(identity, { staged, metadata });
    } catch (err) {
      outcomes.set(identity, { error: err.message });
    }
  }

  let call;
  try {
    call = await runSsh({
      destination: host,
      command: probeCommand(first.node),
      input: buildProbeProgram({ protocol: PROTOCOL, op: "fetch", items }, { env: first.env || {} }),
      timeoutMs: FETCH_TIMEOUT_MS,
      connectTimeoutSeconds: first.connectTimeoutSeconds,
      controlPath: first.master.controlPath,
      captureStdout: false,
      onStdout(chunk) {
        if (parseError) return;
        try {
          for (const frame of reader.push(chunk)) acceptFrame(frame);
        } catch (err) {
          parseError = err.message;
        }
      },
    });
  } catch (err) {
    if (err instanceof UserError) throw err;
    call = { code: null, stdout: "", stderr: err.message };
  }

  const failure = classifySshFailure(call, { destination: host, timeoutMs: FETCH_TIMEOUT_MS });
  const transportError = failure?.message || parseError;
  const incompleteIdentity = reader.incomplete
    ? fetchIdentity(reader.incomplete.header.harness, reader.incomplete.header.key)
    : null;
  const partialHeader = reader.partialHeader;
  const partialMatches = partialHeader
    ? pending.filter((transcript) => {
        const identity = fetchIdentity(transcript.harness, transcript.remote.key);
        if (outcomes.has(identity)) return false;
        const prefix = Buffer.from(
          JSON.stringify({ key: transcript.remote.key, harness: transcript.harness }).slice(0, -1),
          "utf8",
        );
        const common = Math.min(prefix.length, partialHeader.bytes.length);
        return prefix.subarray(0, common).equals(partialHeader.bytes.subarray(0, common));
      })
    : [];
  const tornOutstanding =
    (incompleteIdentity && transcriptsByKey.has(incompleteIdentity) && !outcomes.has(incompleteIdentity)) ||
    partialMatches.length === 1;
  const streamError = transportError || (!reader.ended ? "remote fetch incomplete" : null);
  for (const transcript of pending) {
    const identity = fetchIdentity(transcript.harness, transcript.remote.key);
    const outcome = outcomes.get(identity);
    const independentlyComplete = reader.ended || Boolean(tornOutstanding);
    if (outcome?.staged && !transportError && independentlyComplete) {
      try {
        const written = cache.commit(index, outcome.staged, outcome.metadata);
        transcript.mtimeMs = outcome.metadata.mtimeMs;
        transcript.bytes = outcome.metadata.bytes;
        transcript.contentSignature = outcome.metadata.contentSignature;
        transcript.remote.cachePath = written.path;
        stats.fetched += 1;
        stats.bytes += written.bytes;
        continue;
      } catch (err) {
        outcome.error = err.message;
      }
    }
    if (outcome?.staged) cache.discard(outcome.staged);
    const reason = outcome?.error || streamError || "remote fetch incomplete";
    transcript.remoteError = `${host}: ${reason}`;
    stats.failed += 1;
  }
  if (!reader.ended && !failure && !parseError) {
    warn(`${host}: the fetch stream ended early; the missing transcripts are retried next run`);
  }
}
