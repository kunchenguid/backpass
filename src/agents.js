import { UserError, color, info, warn } from "./logger.js";
import { DEFAULT_EFFORT, LEGACY_DEFAULT_AGENTS } from "./config.js";
import { AcpxError, SESSION_CREATE_TIMEOUT_MS, acpxVersion, classifyAcpxFailure, probeSession } from "./acpx.js";
import { ambiguousModelDetail, providerAuthState, rankCollidingIds, readProviderAuthTypes } from "./provider-auth.js";
import { runCapture } from "./subprocess.js";

/**
 * Ordered agent selection (the ordered-defaults design, section 8).
 *
 * Each role (analysis, synthesis) has a ladder of candidates - a model id served by a
 * few harnesses, in preference order. This module walks the ladder and picks the first
 * candidate that is installed, authenticated, and serves the model, using a zero-token
 * probe per candidate. The probe is a *filter*, not a guarantee: the first
 * real call is the decider, and a classifiable failure there (AUTH_REQUIRED, model
 * rejected, adapter missing) demotes the candidate and falls through to the next one.
 *
 * Bare ladder ids are matched against the advertised list (`resolveModelId`). A unique
 * `provider/id` wins; a collision is ranked by auth class (subscription over API key)
 * from `src/provider-auth.js`. An unrankable collision is a loud non-match that names
 * the ids - never an arbitrary pick, and never silent fallthrough disguised as
 * "model not advertised".
 *
 * All model invocation still goes through `src/acpx.js`. The one documented exception
 * is `NATIVE_PROBES` below: the claude adapter creates sessions happily while logged
 * out and only fails at prompt time, so its login state has to come from the harness's
 * own `claude auth status`. `opencode models` answers first because its ACP session has
 * been seen to wedge on a large profile.
 *
 * Verdicts are cached in `.backpass/agent-probe-cache.json` (12h for ok, 30min for
 * negatives) and memoized for the run. An acpx version change invalidates every entry;
 * Pi and OpenCode entries are also keyed to credential environment and auth-file state.
 *
 * A busy harness (another backpass run, a wedged ACP session) looks like a probe
 * timeout, a bare `exit 1`, or an empty advertised-model list. Those retry once with
 * backoff before the walk demotes and are never written to the on-disk cache: a
 * transient miss must not become a 30-minute negative verdict for the next run.
 */

const OK_TTL_MS = 12 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 60 * 1000;
const NATIVE_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_BY_AGENT = { opencode: 10_000 };
const PROBE_RETRY_BACKOFF_MS = 1_000;

/** Adapters whose model list is open-ended: any id is forwarded, none can be verified. */
const TRUSTING_MODEL_AGENTS = new Set(["claude"]);
const PROVIDER_AUTH_SENSITIVE_AGENTS = new Set(["pi", "opencode"]);

export const VERDICT_LABELS = {
  ok: "ok",
  unauthenticated: "not logged in",
  "model-unavailable": "model not advertised",
  unreachable: "not installed / not spawnable",
  timeout: "probe timed out",
};

const LOGIN_HINTS = {
  codex: "codex login",
  claude: "claude auth login",
  grok: "grok login",
  opencode: "opencode auth login",
  pi: "pi login",
};

/**
 * Per-harness native status commands. Each returns a verdict or null (inconclusive, so
 * the acpx probe decides). See the module header for why this table exists at all.
 */
const NATIVE_PROBES = {
  async claude({ model }, capture) {
    const result = await capture("claude", ["auth", "status"], { timeoutMs: NATIVE_TIMEOUT_MS });
    if (result.spawnError?.code === "ENOENT") {
      return { verdict: "unreachable", detail: "claude CLI not found on PATH", resolvedModel: model };
    }
    if (result.timedOut) {
      return { verdict: "timeout", detail: "claude auth status timed out" };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      // Not the JSON we expect; let the acpx probe have a look.
    }
    if (parsed && typeof parsed.loggedIn === "boolean") {
      if (!parsed.loggedIn) return { verdict: "unauthenticated", detail: "claude auth status: loggedIn=false" };
      return null;
    }
    if (result.code !== 0) {
      return {
        verdict: "unreachable",
        detail: firstLine(result.stderr) || `claude auth status exit ${result.code}`,
        transient: true,
      };
    }
    return null;
  },
  async opencode({ model }, capture, options = {}) {
    const result = await capture("opencode", ["models"], { timeoutMs: NATIVE_TIMEOUT_MS });
    if (result.spawnError?.code === "ENOENT") {
      return { verdict: "unreachable", detail: "opencode CLI not found on PATH" };
    }
    if (result.timedOut) return { verdict: "timeout", detail: "opencode models timed out" };
    if (result.code !== 0) return null;
    const advertised = result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!advertised.length) {
      return { verdict: "model-unavailable", detail: "`opencode models` advertised no models" };
    }
    const resolved = resolveAdvertisedModel(model, advertised, "opencode", options);
    if (!resolved.id) {
      return {
        verdict: "model-unavailable",
        detail: resolved.ambiguous
          ? ambiguousModelDetail(resolved.ambiguous, { source: "`opencode models`" })
          : "absent from `opencode models` (provider not logged in?)",
      };
    }
    return null;
  },
};

function firstLine(text) {
  return (text || "").split("\n").find((l) => l.trim()) || "";
}

/**
 * Match a model id against what an adapter advertises (design section 4.1): exact,
 * then a unique match after the provider prefix (`openai-codex/x`,
 * `openrouter/vendor/x`), then a unique `x[...]` variant. Equality is deliberate:
 * `gpt-5.6-luna-fast`
 * must not satisfy `gpt-5.6-luna`. More than one survivor is ranked by auth class
 * (subscription over API key) when `providerAuthTypes` can decide; otherwise it is
 * a loud non-match that names the ids - never an arbitrary pick.
 *
 * @param {string} bareId
 * @param {string[]} advertised
 * @param {{ providerAuthTypes?: Record<string, "subscription" | "api_key"> }} [options]
 * @returns {{ id: string | null, ambiguous?: string[],
 *   tieBreak?: { preferred: string, over: string[] } }}
 */
export function resolveModelId(bareId, advertised, options = {}) {
  if (advertised.includes(bareId)) return { id: bareId };
  const modelName = (id) => {
    const slash = id.indexOf("/");
    return slash === -1 ? id : id.slice(slash + 1);
  };
  const bySegment = advertised.filter((id) => modelName(id) === bareId);
  if (bySegment.length === 1) return { id: bySegment[0] };
  if (bySegment.length > 1) return rankCollidingIds(bySegment, options.providerAuthTypes);
  const byVariant = advertised.filter((id) => modelName(id).startsWith(`${bareId}[`));
  if (byVariant.length === 1) return { id: byVariant[0] };
  if (byVariant.length > 1) return rankCollidingIds(byVariant, options.providerAuthTypes);
  return { id: null };
}

function resolveAdvertisedModel(bareId, advertised, agent, options = {}) {
  const types =
    options.providerAuthTypes ?? (options.readProviderAuthTypes || readProviderAuthTypes)(agent, { advertised });
  return resolveModelId(bareId, advertised, { providerAuthTypes: types });
}

/** Flatten a ladder model-outer / harness-inner into `{ model, agent }` candidates. */
export function flattenLadder(ladder) {
  return ladder.flatMap((rung) => rung.agents.map((agent) => ({ model: rung.model, agent })));
}

export function candidateKey({ agent, model }) {
  return `${agent}|${model}`;
}

/**
 * Probe one candidate end to end: native status command first (when one exists),
 * then the zero-token acpx session probe, then model-id resolution.
 *
 * @param {{ agent: string, model: string }} candidate
 * @param {{ cwd?: string, sessionName?: string,
 *   probeSession?: (args: { agent: string, sessionName: string, cwd?: string,
 *     timeoutMs?: number, createTimeoutMs?: number }) =>
 *     Promise<{ verdict: string, detail: string, availableModels?: string[], transient?: boolean }>,
 *   runCapture?: typeof runCapture,
 *   providerAuthTypes?: Record<string, "subscription" | "api_key">,
 *   readProviderAuthTypes?: typeof readProviderAuthTypes }} [options]
 * @returns {Promise<{ verdict: string, detail: string, resolvedModel: string | null,
 *   transient?: boolean, tieBreak?: { preferred: string, over: string[] } }>}
 */
export async function probeCandidate(candidate, options = {}) {
  const { cwd, sessionName, probeSession: probe = probeSession, runCapture: capture = runCapture } = options;
  const { agent, model } = candidate;
  const native = NATIVE_PROBES[agent];
  if (native) {
    const early = await native(candidate, capture, options);
    if (early) return { resolvedModel: null, ...early };
  }

  const result = await probe({
    agent,
    sessionName,
    cwd,
    timeoutMs: PROBE_TIMEOUT_BY_AGENT[agent] || PROBE_TIMEOUT_MS,
    createTimeoutMs: SESSION_CREATE_TIMEOUT_MS,
  });
  if (result.verdict !== "ok") {
    return {
      verdict: result.verdict,
      detail: result.detail,
      resolvedModel: null,
      ...(result.transient ? { transient: true } : {}),
    };
  }

  if (TRUSTING_MODEL_AGENTS.has(agent)) {
    return { verdict: "ok", detail: "model accepted on faith; the first real call verifies it", resolvedModel: model };
  }
  const advertised = result.availableModels || [];
  const resolved = resolveAdvertisedModel(model, advertised, agent, options);
  if (!resolved.id) {
    const detail = resolved.ambiguous
      ? ambiguousModelDetail(resolved.ambiguous)
      : advertised.length
        ? `not among ${advertised.length} advertised model(s)`
        : "adapter advertised no models";
    return { verdict: "model-unavailable", detail, resolvedModel: null };
  }
  const tieBreak = resolved.tieBreak;
  const detail = tieBreak
    ? `preferred subscription provider ${tieBreak.preferred} over ${tieBreak.over.join(", ")}`
    : "";
  return { verdict: "ok", detail, resolvedModel: resolved.id, ...(tieBreak ? { tieBreak } : {}) };
}

/**
 * A cache entry is fresh when it is within its TTL. The caller separately checks the
 * acpx version and, where provider resolution depends on it, auth state. Negatives expire
 * fast: "I just logged in" is the common repair.
 */
export function isProbeEntryFresh(entry, { now = Date.now() } = {}) {
  if (!entry || !entry.checkedAt) return false;
  if (isTransientProbeResult(entry)) return false;
  const age = now - Date.parse(entry.checkedAt);
  if (!Number.isFinite(age) || age < 0) return false;
  return age < (entry.verdict === "ok" ? OK_TTL_MS : NEGATIVE_TTL_MS);
}

/**
 * Probe misses that are often the harness being busy, not a durable capability gap.
 * One retry, then skip for this run; never persist them as a negative cache hit.
 */
export function isTransientProbeResult(result) {
  if (!result) return false;
  if (result.transient || result.verdict === "timeout") return true;
  if (result.verdict === "model-unavailable" && /advertised no models/i.test(result.detail || "")) {
    return true;
  }
  if (
    result.verdict === "unreachable" &&
    /^(?:claude auth status )?exit (?:\d+|null)\b/i.test((result.detail || "").trim())
  ) {
    return true;
  }
  return false;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hintFor(agent, verdict) {
  if (verdict === "unauthenticated" && LOGIN_HINTS[agent]) return `-> run: ${LOGIN_HINTS[agent]}`;
  if (verdict === "unreachable") return `-> install the ${agent} CLI`;
  return "";
}

/**
 * Resolves the agent for each role once per run and owns the fall-through state.
 *
 * `resolve(role)` returns `{ agent, model, effort, pinned, reason }`. The analysis and
 * synthesis stages call it lazily, so read-only commands (`scan`, `status`) never probe.
 * `demote(role, pick, verdict)` records a mid-run classifiable failure; the next
 * `resolve(role)` walks on from the following candidate.
 */
export class AgentResolver {
  /**
   * @param {object} config
   * @param {{ state?: { readProbeCache: Function, writeProbeCache: Function }, cwd?: string,
   *   bypassCache?: boolean, probeCandidate?: Function, acpxVersion?: Function, now?: () => number,
   *   providerAuthState?: typeof providerAuthState, sleep?: (ms: number) => Promise<void>,
   *   probeRetryBackoffMs?: number }} [deps]
   */
  constructor(config, deps = {}) {
    this.config = config;
    this.state = deps.state || null;
    this.cwd = deps.cwd;
    this.bypassCache = Boolean(deps.bypassCache);
    this.probeCandidate = deps.probeCandidate || probeCandidate;
    this.acpxVersion = deps.acpxVersion || acpxVersion;
    this.providerAuthState = deps.providerAuthState || providerAuthState;
    this.now = deps.now || (() => Date.now());
    this.sleep = deps.sleep || defaultSleep;
    this.probeRetryBackoffMs = deps.probeRetryBackoffMs ?? PROBE_RETRY_BACKOFF_MS;
    /** In-process memo for the run: key -> { verdict, detail, resolvedModel, checkedAt }. */
    this.memo = new Map();
    /** Probes in flight, so parallel analysis workers never double-probe a candidate. */
    this.inflight = new Map();
    this.picks = {};
    this.cache = null;
    this.version = undefined;
    this.probeCount = 0;
  }

  async loadCache() {
    if (this.cache) return this.cache;
    if (this.version === undefined) this.version = await this.acpxVersion();
    const stored = this.state ? this.state.readProbeCache() : { version: 1, acpxVersion: null, entries: {} };
    if (stored.acpxVersion !== this.version) stored.entries = {};
    stored.acpxVersion = this.version;
    this.cache = stored;
    return stored;
  }

  saveCache() {
    if (this.state && this.cache) this.state.writeProbeCache(this.cache);
  }

  async verdictFor(candidate) {
    const key = candidateKey(candidate);
    if (this.memo.has(key)) return this.memo.get(key);
    if (this.inflight.has(key)) return this.inflight.get(key);
    const pending = this.probeAndRecord(candidate, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return pending;
  }

  async probeAndRecord(candidate, key) {
    const cache = await this.loadCache();
    const cached = cache.entries[key];
    const authState = PROVIDER_AUTH_SENSITIVE_AGENTS.has(candidate.agent)
      ? this.providerAuthState(candidate.agent)
      : null;
    const authStateMatches = authState === null || cached?.authState === authState;
    if (!this.bypassCache && authStateMatches && isProbeEntryFresh(cached, { now: this.now() })) {
      this.memo.set(key, { ...cached, cached: true });
      return this.memo.get(key);
    }

    this.probeCount += 1;
    let result = await this.probeCandidate(candidate, {
      cwd: this.cwd,
      sessionName: `backpass-probe-${process.pid}-${this.probeCount}`,
    });
    if (isTransientProbeResult(result)) {
      await this.sleep(this.probeRetryBackoffMs);
      this.probeCount += 1;
      result = await this.probeCandidate(candidate, {
        cwd: this.cwd,
        sessionName: `backpass-probe-${process.pid}-${this.probeCount}`,
      });
    }
    const entry = {
      verdict: result.verdict,
      detail: result.detail || "",
      resolvedModel: result.resolvedModel || null,
      checkedAt: new Date(this.now()).toISOString(),
      ...(authState === null ? {} : { authState }),
      ...(result.tieBreak ? { tieBreak: result.tieBreak } : {}),
    };
    this.memo.set(key, entry);
    if (isTransientProbeResult(entry)) {
      delete cache.entries[key];
    } else {
      cache.entries[key] = entry;
    }
    this.saveCache();
    return entry;
  }

  /** The candidates for a role, in order, as `{ agent, model }`. */
  ladder(role) {
    return flattenLadder(this.config.ladders[role]);
  }

  pinned(role) {
    const explicit = this.config[role];
    if (explicit.agent) {
      return { agent: explicit.agent, model: explicit.model || null, pinned: true, reason: "configured" };
    }
    if (this.config.autoAgent === false) {
      return { agent: LEGACY_DEFAULT_AGENTS[role], model: null, pinned: true, reason: "--no-auto-agent" };
    }
    return null;
  }

  /**
   * @param {"analysis" | "synthesis"} role
   * @returns {Promise<{ agent: string, model: string | null, ladderModel?: string, effort: string | null, pinned: boolean, reason: string }>}
   */
  async resolve(role) {
    if (this.picks[role]) return this.picks[role];

    const pinned = this.pinned(role);
    if (pinned) {
      let model = pinned.model;
      if (model && !model.includes("/") && !TRUSTING_MODEL_AGENTS.has(pinned.agent)) {
        let entry;
        try {
          entry = await this.verdictFor({ agent: pinned.agent, model });
        } catch (err) {
          if (err instanceof AcpxError) throw new UserError(err.message, "install acpx (npm i -g acpx) and retry");
          throw err;
        }
        if (entry.verdict !== "ok") throw pinnedResolutionError(role, pinned, entry);
        model = entry.resolvedModel || model;
      }
      this.picks[role] = { ...pinned, model, effort: resolvedEffort(role, pinned.agent, this.config) };
      return this.picks[role];
    }

    const trail = [];
    for (const candidate of this.ladder(role)) {
      let entry;
      try {
        entry = await this.verdictFor(candidate);
      } catch (err) {
        // acpx itself is missing: one clean error, not one per candidate.
        if (err instanceof AcpxError) throw new UserError(err.message, "install acpx (npm i -g acpx) and retry");
        throw err;
      }
      trail.push({ ...candidate, ...entry });
      if (entry.verdict === "ok") {
        this.picks[role] = {
          agent: candidate.agent,
          model: entry.resolvedModel || candidate.model,
          ladderModel: candidate.model,
          effort: resolvedEffort(role, candidate.agent, this.config),
          pinned: false,
          reason: describeTrail(trail),
        };
        this.announce(role, this.picks[role], trail);
        return this.picks[role];
      }
    }
    throw exhaustedError(role, trail);
  }

  announce(role, pick, trail) {
    const losers = trail.filter((t) => t.verdict !== "ok");
    const winner = trail.at(-1);
    const cached = winner?.cached ? color.dim(" (cached)") : "";
    info(`${color.cyan("·")} ${role}: ${pick.agent} (${pick.model}) effort=${pick.effort || "unset"}${cached}`);
    if (winner?.tieBreak) {
      info(
        color.dim(
          `    preferred subscription provider ${winner.tieBreak.preferred} over ${winner.tieBreak.over.join(", ")}`,
        ),
      );
    }
    for (const t of losers) {
      const label = VERDICT_LABELS[t.verdict] || t.verdict;
      const extra = t.detail && /ambiguous/i.test(t.detail) ? ` (${t.detail})` : "";
      info(color.dim(`    skipped ${t.agent}/${t.model}: ${label}${extra}`));
    }
  }

  /**
   * Record a classifiable mid-run failure for the chosen candidate. Returns true when
   * there is something to fall through to (the next `resolve(role)` walks on), false
   * when the pick was pinned by the user - then the error is theirs to see.
   */
  async demote(role, pick, verdict, detail = "") {
    if (pick.pinned) return false;
    const key = candidateKey({ agent: pick.agent, model: pick.ladderModel });
    if (this.memo.get(key)?.verdict === "ok") {
      // First worker to see the failure records it; the rest just re-resolve.
      const authState = PROVIDER_AUTH_SENSITIVE_AGENTS.has(pick.agent) ? this.providerAuthState(pick.agent) : null;
      const entry = {
        verdict,
        detail,
        resolvedModel: null,
        checkedAt: new Date(this.now()).toISOString(),
        ...(authState === null ? {} : { authState }),
      };
      this.memo.set(key, entry);
      const cache = await this.loadCache();
      cache.entries[key] = entry;
      this.saveCache();
      warn(`${role}: ${pick.agent} (${pick.model}) ${VERDICT_LABELS[verdict] || verdict} mid-run; falling through`);
    }
    if (this.picks[role] === pick) delete this.picks[role];
    return true;
  }

  /**
   * Run `fn(pick)` for a role, falling through the ladder on classifiable failures.
   * Unclassifiable errors (a timeout on real work, garbage output) propagate unchanged.
   */
  async withFallthrough(role, fn) {
    for (;;) {
      const pick = await this.resolve(role);
      try {
        return await fn(pick);
      } catch (err) {
        const isAcpxError = err instanceof AcpxError;
        const verdict = isAcpxError ? classifyAcpxFailure(err) : null;
        if (isAcpxError && pick.pinned) throw pinnedFailureError(role, pick, verdict, err);
        if (!verdict) throw err;
        await this.demote(role, pick, verdict, err.message);
      }
    }
  }
}

/** OpenCode variants are per-model, so role defaults do not become an overlay. */
export function resolvedEffort(role, agent, config) {
  const configured = config[role].effort;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  if (agent === "opencode") return null;
  return DEFAULT_EFFORT[role];
}

function describeTrail(trail) {
  const losers = trail.filter((t) => t.verdict !== "ok");
  if (!losers.length) return "first candidate in the ladder";
  return `after skipping ${losers.map((t) => `${t.agent}/${t.model} (${VERDICT_LABELS[t.verdict] || t.verdict})`).join(", ")}`;
}

function pinnedResolutionError(role, pick, entry) {
  const label = VERDICT_LABELS[entry.verdict] || entry.verdict;
  const detail = entry.detail ? ` (${entry.detail})` : "";
  const hint = entry.detail?.includes("provider-qualified")
    ? `pass a provider-qualified id with --${role}-model`
    : `pin a different model or harness with --${role}-model <id> or --${role}-agent <agent>`;
  return new UserError(`pinned ${role} agent ${pick.agent} (${pick.model}) ${label}${detail}`, hint);
}

function pinnedFailureError(role, pick, verdict, err) {
  const label = verdict ? VERDICT_LABELS[verdict] || verdict : "failed unexpectedly";
  const model = pick.model ? ` (${pick.model})` : "";
  const pin = `or pin a different harness: backpass --${role}-agent <agent>`;
  let hint = `check the ${pick.agent}/acpx failure above and retry; ${pin}`;
  if (verdict === "unauthenticated" && LOGIN_HINTS[pick.agent]) {
    hint = `run: ${LOGIN_HINTS[pick.agent]}; ${pin}`;
  } else if (verdict === "unreachable") {
    hint = `install the ${pick.agent} CLI; ${pin}`;
  } else if (verdict) {
    hint = pin;
  }
  const detail = err?.message ? ` (${String(err.message).split("\n")[0]})` : "";
  return new UserError(`pinned ${role} agent ${pick.agent}${model} ${label}${detail}`, hint);
}

function exhaustedError(role, trail) {
  const width = Math.max(...trail.map((t) => t.model.length));
  const lines = trail.map((t) => {
    const label = VERDICT_LABELS[t.verdict] || t.verdict;
    const hint = hintFor(t.agent, t.verdict);
    return `  ${t.model.padEnd(width)}  ${t.agent.padEnd(9)} ${label}${t.detail ? ` (${t.detail})` : ""}${hint ? `  ${hint}` : ""}`;
  });
  return new UserError(
    `no available agent for the ${role} pass\n\n${lines.join("\n")}`,
    `log in to one of the harnesses above, or pin one explicitly: backpass --${role}-agent <agent> --${role}-model <id>`,
  );
}
