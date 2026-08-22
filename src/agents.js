import { UserError, color, info, warn } from "./logger.js";
import { DEFAULT_EFFORT, LEGACY_DEFAULT_AGENTS } from "./config.js";
import { AcpxError, acpxVersion, classifyAcpxFailure, probeSession } from "./acpx.js";
import { runCapture } from "./subprocess.js";

/**
 * Ordered agent selection (the ordered-defaults design, section 8).
 *
 * Each role (analysis, synthesis) has a ladder of candidates - a model id served by a
 * few harnesses, in preference order. This module walks the ladder and picks the first
 * candidate that is installed, authenticated, and serves the model, using a ~1.5s
 * zero-token probe per candidate. The probe is a *filter*, not a guarantee: the first
 * real call is the decider, and a classifiable failure there (AUTH_REQUIRED, model
 * rejected, adapter missing) demotes the candidate and falls through to the next one.
 *
 * All model invocation still goes through `src/acpx.js`. The one documented exception
 * is `NATIVE_PROBES` below: the claude adapter creates sessions happily while logged
 * out and only fails at prompt time, so its login state has to come from the harness's
 * own `claude auth status`. opencode's ACP session has been seen to wedge for minutes
 * on a large profile, so `opencode models` answers first and the ACP probe is capped.
 *
 * Verdicts are cached in `.backpass/agent-probe-cache.json` (12h for ok, 30min for
 * negatives, invalidated on an acpx version change) and memoized for the run.
 */

const OK_TTL_MS = 12 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 60 * 1000;
const NATIVE_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_BY_AGENT = { opencode: 10_000 };

/** Adapters whose model list is open-ended: any id is forwarded, none can be verified. */
const TRUSTING_MODEL_AGENTS = new Set(["claude"]);

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
  async claude({ model }) {
    const result = await runCapture("claude", ["auth", "status"], { timeoutMs: NATIVE_TIMEOUT_MS });
    if (result.spawnError?.code === "ENOENT") {
      return { verdict: "unreachable", detail: "claude CLI not found on PATH", resolvedModel: model };
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
      return { verdict: "unreachable", detail: firstLine(result.stderr) || `claude auth status exit ${result.code}` };
    }
    return null;
  },
  async opencode({ model }) {
    const result = await runCapture("opencode", ["models"], { timeoutMs: NATIVE_TIMEOUT_MS });
    if (result.spawnError?.code === "ENOENT") {
      return { verdict: "unreachable", detail: "opencode CLI not found on PATH" };
    }
    if (result.timedOut || result.code !== 0) return null;
    const advertised = result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const resolved = resolveModelId(model, advertised);
    if (!resolved.id) {
      return {
        verdict: "model-unavailable",
        detail: resolved.ambiguous
          ? `ambiguous in \`opencode models\`: ${resolved.ambiguous.join(", ")}`
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
 * Match a bare model id against what an adapter advertises (design section 4.1):
 * exact, then a unique last-`/`-segment match (`openai-codex/x`, `xai/x`), then a
 * unique `x[...]` variant. Segment *equality* is deliberate: `gpt-5.6-luna-fast`
 * must not satisfy `gpt-5.6-luna`. More than one survivor is a non-match, reported.
 *
 * @returns {{ id: string | null, ambiguous?: string[] }}
 */
export function resolveModelId(bareId, advertised) {
  if (advertised.includes(bareId)) return { id: bareId };
  const bySegment = advertised.filter((id) => id.split("/").at(-1) === bareId);
  if (bySegment.length === 1) return { id: bySegment[0] };
  if (bySegment.length > 1) return { id: null, ambiguous: bySegment };
  const byVariant = advertised.filter((id) => id.startsWith(`${bareId}[`));
  if (byVariant.length === 1) return { id: byVariant[0] };
  if (byVariant.length > 1) return { id: null, ambiguous: byVariant };
  return { id: null };
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
 *   probeSession?: (args: { agent: string, sessionName: string, cwd?: string, timeoutMs?: number }) =>
 *     Promise<{ verdict: string, detail: string, availableModels?: string[] }> }} [options]
 * @returns {Promise<{ verdict: string, detail: string, resolvedModel: string | null }>}
 */
export async function probeCandidate(candidate, options = {}) {
  const { cwd, sessionName, probeSession: probe = probeSession } = options;
  const { agent, model } = candidate;
  const native = NATIVE_PROBES[agent];
  if (native) {
    const early = await native(candidate);
    if (early) return { resolvedModel: null, ...early };
  }

  const result = await probe({
    agent,
    sessionName,
    cwd,
    timeoutMs: PROBE_TIMEOUT_BY_AGENT[agent] || PROBE_TIMEOUT_MS,
  });
  if (result.verdict !== "ok") return { verdict: result.verdict, detail: result.detail, resolvedModel: null };

  if (TRUSTING_MODEL_AGENTS.has(agent)) {
    return { verdict: "ok", detail: "model accepted on faith; the first real call verifies it", resolvedModel: model };
  }
  const resolved = resolveModelId(model, result.availableModels || []);
  if (!resolved.id) {
    const detail = resolved.ambiguous
      ? `ambiguous among advertised ids: ${resolved.ambiguous.join(", ")}`
      : result.availableModels?.length
        ? `not among ${result.availableModels.length} advertised model(s)`
        : "adapter advertised no models";
    return { verdict: "model-unavailable", detail, resolvedModel: null };
  }
  return { verdict: "ok", detail: "", resolvedModel: resolved.id };
}

/**
 * A cache entry is fresh when it is within its TTL and was recorded against the same
 * acpx version. Negatives expire fast: "I just logged in" is the common repair.
 */
export function isProbeEntryFresh(entry, { now = Date.now() } = {}) {
  if (!entry || !entry.checkedAt) return false;
  const age = now - Date.parse(entry.checkedAt);
  if (!Number.isFinite(age) || age < 0) return false;
  return age < (entry.verdict === "ok" ? OK_TTL_MS : NEGATIVE_TTL_MS);
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
   *   bypassCache?: boolean, probeCandidate?: Function, acpxVersion?: Function, now?: () => number }} [deps]
   */
  constructor(config, deps = {}) {
    this.config = config;
    this.state = deps.state || null;
    this.cwd = deps.cwd;
    this.bypassCache = Boolean(deps.bypassCache);
    this.probeCandidate = deps.probeCandidate || probeCandidate;
    this.acpxVersion = deps.acpxVersion || acpxVersion;
    this.now = deps.now || (() => Date.now());
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
    if (!this.bypassCache && isProbeEntryFresh(cached, { now: this.now() })) {
      this.memo.set(key, { ...cached, cached: true });
      return this.memo.get(key);
    }

    this.probeCount += 1;
    const sessionName = `backpass-probe-${process.pid}-${this.probeCount}`;
    const result = await this.probeCandidate(candidate, { cwd: this.cwd, sessionName });
    const entry = {
      verdict: result.verdict,
      detail: result.detail || "",
      resolvedModel: result.resolvedModel || null,
      checkedAt: new Date(this.now()).toISOString(),
    };
    cache.entries[key] = entry;
    this.memo.set(key, entry);
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
    const effort = this.config[role].effort || DEFAULT_EFFORT[role];

    const pinned = this.pinned(role);
    if (pinned) {
      this.picks[role] = { ...pinned, effort };
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
          effort,
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
    const cached = trail.at(-1)?.cached ? color.dim(" (cached)") : "";
    info(`${color.cyan("·")} ${role}: ${pick.agent} (${pick.model}) effort=${pick.effort}${cached}`);
    for (const t of losers) {
      info(color.dim(`    skipped ${t.agent}/${t.model}: ${VERDICT_LABELS[t.verdict] || t.verdict}`));
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
      const entry = { verdict, detail, resolvedModel: null, checkedAt: new Date(this.now()).toISOString() };
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
        const verdict = err instanceof AcpxError ? classifyAcpxFailure(err) : null;
        if (!verdict || !(await this.demote(role, pick, verdict, err.message))) throw err;
      }
    }
  }
}

function describeTrail(trail) {
  const losers = trail.filter((t) => t.verdict !== "ok");
  if (!losers.length) return "first candidate in the ladder";
  return `after skipping ${losers.map((t) => `${t.agent}/${t.model} (${VERDICT_LABELS[t.verdict] || t.verdict})`).join(", ")}`;
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
