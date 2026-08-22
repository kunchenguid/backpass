import { warn } from "./logger.js";
import { runCapture } from "./subprocess.js";

/**
 * The acpx execution layer (design section 4).
 *
 * backpass owns no API keys. Every model call goes through acpx to a harness the user
 * has already authenticated, which is also why this is the only module that knows how
 * models are invoked - acpx self-describes as alpha, so the blast radius of a change in
 * its CLI surface stops here.
 *
 * v1 deliberately uses plain `exec` one-shots and short-lived named sessions. acpx
 * flows are marked experimental upstream and are the v2 path.
 */

export const ACPX_BIN = process.env.BACKPASS_ACPX_BIN || "acpx";

/**
 * backpass's user-facing harness names versus acpx's agent registry. The only
 * mismatch today is grok: backpass calls the harness `grok` everywhere (config,
 * discovery, --harness) while acpx registers it as `grok-build`. Translate at this
 * boundary only, so the user never has to know.
 */
const ACPX_AGENT_NAMES = { grok: "grok-build" };

export function acpxAgentName(agent) {
  return ACPX_AGENT_NAMES[agent] || agent;
}

/**
 * The session config-option id each adapter uses for reasoning effort. There is no
 * shared ACP name for it and `acpx status` does not expose config options, so this
 * small table is measured (see the ordered-defaults design report) rather than
 * derived. Adapters absent here (grok, opencode) advertise no effort option at all;
 * effort is then skipped with a report note, never silently.
 */
export const EFFORT_OPTION_KEYS = { codex: "reasoning_effort", claude: "effort", pi: "thought_level" };

export function effortOptionKey(agent) {
  return EFFORT_OPTION_KEYS[agent] || null;
}

export class AcpxError extends Error {
  constructor(message, { stdout = "", stderr = "", code = null, timedOut = false, spawnError = null } = {}) {
    super(message);
    this.name = "AcpxError";
    this.stdout = stdout;
    this.stderr = stderr;
    this.code = code;
    this.timedOut = timedOut;
    this.spawnError = spawnError;
  }
}

/**
 * @param {string[]} args
 * @param {{ timeoutMs?: number, cwd?: string, input?: string }} [options]
 */
function run(args, options = {}) {
  return runCapture(ACPX_BIN, args, options);
}

function notFoundError(result) {
  return new AcpxError(`acpx not found on PATH (looked for "${ACPX_BIN}")`, result);
}

/**
 * Availability verdicts for a failed acpx call. Only a *classifiable* failure is a
 * reason to drop a candidate and fall through to the next one; anything else (a
 * timeout on a long prompt, garbage output) stays a plain error so a run never
 * silently switches models after real work has started.
 *
 * acpx reports these on stderr as `[acpx] error: RUNTIME AUTH_REQUIRED ...` and
 * `Cannot apply --model "x": the ACP agent did not advertise that model`.
 *
 * @param {{ stderr?: string, spawnError?: { code?: string } | null, timedOut?: boolean }} failure
 * @returns {"unauthenticated" | "model-unavailable" | "unreachable" | null}
 */
export function classifyAcpxFailure(failure) {
  if (!failure) return null;
  if (failure.spawnError?.code === "ENOENT") return "unreachable";
  const text = failure.stderr || "";
  if (/AUTH_REQUIRED|authentication required/i.test(text)) return "unauthenticated";
  if (/did not advertise that model/i.test(text)) return "model-unavailable";
  if (/\b(ENOENT|command not found|not found on PATH|failed to spawn|spawn .* ENOENT)\b/i.test(text)) {
    return "unreachable";
  }
  return null;
}

/** acpx prints a per-run accounting line: `[acpx] tokens: input=10 output=47 ... total=34194`. */
export function parseTokenLine(text) {
  const match = /\[acpx\]\s+tokens:\s+(.+)/.exec(text || "");
  if (!match) return null;
  const usage = {};
  for (const pair of match[1].trim().split(/\s+/)) {
    const [key, value] = pair.split("=");
    const n = Number(value);
    if (key && Number.isFinite(n)) usage[key] = n;
  }
  return Object.keys(usage).length ? usage : null;
}

/** Strip acpx's own accounting/status lines from the model's answer. */
export function stripAcpxNoise(text) {
  return (text || "")
    .split("\n")
    .filter((line) => !line.startsWith("[acpx]"))
    .join("\n")
    .trim();
}

/**
 * Pull a JSON object out of a model reply, tolerating prose or a fenced block around it.
 */
export function extractJson(text) {
  const cleaned = stripAcpxNoise(text);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(cleaned);

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to brace scanning
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // keep trying
      }
    }
  }
  return null;
}

function baseArgs({ cwd, model, timeoutSeconds, approveReads, suppressReads }) {
  const args = [];
  if (cwd) args.push("--cwd", cwd);
  if (approveReads) args.push("--approve-reads");
  else args.push("--deny-all");
  if (suppressReads) args.push("--suppress-reads");
  args.push("--non-interactive-permissions", "deny");
  if (timeoutSeconds) args.push("--timeout", String(timeoutSeconds));
  if (model) args.push("--model", model);
  args.push("--format", "quiet");
  return args;
}

/** `acpx --version`, used to key the probe cache. Null when acpx is missing. */
export async function acpxVersion({ timeoutMs = 10_000 } = {}) {
  const result = await run(["--version"], { timeoutMs });
  if (result.code !== 0) return null;
  const line = firstLine(result.stdout);
  return line || null;
}

/**
 * Zero-token availability probe: spawn the adapter, handshake, create a session,
 * read what it advertises, close it. For codex / pi / grok, `sessions new` is a
 * real auth gate (ACP -32000); for claude it is not, which is why `src/agents.js`
 * checks `claude auth status` before ever calling this.
 *
 * @returns {Promise<{ verdict: "ok" | "unauthenticated" | "model-unavailable" | "unreachable" | "timeout",
 *   detail: string, availableModels: string[] }>}
 */
export async function probeSession({ agent, sessionName, cwd = undefined, timeoutMs = 20_000 }) {
  const acpxAgent = acpxAgentName(agent);
  const created = await run([acpxAgent, "sessions", "new", "--name", sessionName], { timeoutMs, cwd });
  if (created.spawnError?.code === "ENOENT") throw notFoundError(created);
  if (created.timedOut) {
    return {
      verdict: "timeout",
      detail: `probe timed out after ${Math.round(timeoutMs / 1000)}s`,
      availableModels: [],
    };
  }
  if (created.code !== 0) {
    const verdict = classifyAcpxFailure(created) || "unreachable";
    return { verdict, detail: firstLine(created.stderr) || `exit ${created.code}`, availableModels: [] };
  }

  try {
    const status = await run(["--format", "json", acpxAgent, "status", "-s", sessionName], { timeoutMs, cwd });
    let availableModels = [];
    if (status.code === 0) {
      try {
        const parsed = JSON.parse(status.stdout.trim().split("\n").at(-1) || "{}");
        if (Array.isArray(parsed.availableModels)) availableModels = parsed.availableModels.map(String);
      } catch {
        // Leave the list empty; the caller decides whether it needs one.
      }
    }
    return { verdict: "ok", detail: "", availableModels };
  } finally {
    const closed = await run([acpxAgent, "sessions", "close", sessionName], { timeoutMs, cwd });
    if (closed.code !== 0) warn(`could not close acpx probe session ${sessionName}`);
  }
}

/**
 * Tier 1 - one-shot analysis call (design section 5).
 *
 * `--approve-reads` is what makes the cheap-first escape hatch work: the agent may open
 * the raw transcript when a claim needs it, but writes are never approved.
 */
export async function execOneShot({
  agent,
  model = null,
  promptFile,
  cwd,
  timeoutSeconds = 300,
  promptRetries = 1,
  approveReads = true,
  suppressReads = true,
}) {
  const args = [
    ...baseArgs({ cwd, model, timeoutSeconds, approveReads, suppressReads }),
    "--prompt-retries",
    String(promptRetries),
    acpxAgentName(agent),
    "exec",
    "--file",
    promptFile,
  ];

  const result = await run(args, { timeoutMs: (timeoutSeconds + 30) * 1000, cwd });
  if (result.spawnError && result.spawnError.code === "ENOENT") throw notFoundError(result);
  if (result.timedOut) {
    throw new AcpxError(`acpx ${agent} exec timed out after ${timeoutSeconds}s`, result);
  }
  if (result.code !== 0) {
    throw new AcpxError(`acpx ${agent} exec failed (exit ${result.code})`, result);
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  return { text: stripAcpxNoise(result.stdout), usage: parseTokenLine(combined), raw: result.stdout };
}

/**
 * A prompt through a short-lived named session (design section 5).
 *
 * Reasoning effort is a session config option on every adapter that has one, and
 * `exec` cannot set it - so any call that wants effort applied goes through here:
 * the synthesis pass always, and the analysis pass whenever an effort is configured.
 * Adapters that do not advertise an effort option skip that step with a report line -
 * never silently.
 */
export async function sessionPrompt({
  agent,
  model = null,
  effort = null,
  sessionName,
  promptFile,
  cwd,
  timeoutSeconds = 900,
  promptRetries = 1,
  approveReads = true,
  suppressReads = true,
}) {
  const notes = [];
  const acpxAgent = acpxAgentName(agent);
  const created = await run([acpxAgent, "sessions", "new", "--name", sessionName], { timeoutMs: 60_000, cwd });
  if (created.spawnError && created.spawnError.code === "ENOENT") throw notFoundError(created);
  if (created.code !== 0) {
    // An auth or spawn failure must surface as such so the caller can fall through.
    if (classifyAcpxFailure(created)) {
      throw new AcpxError(`acpx ${agent} session create failed: ${firstLine(created.stderr)}`, created);
    }
    // No session support for this adapter: fall back to a one-shot, and say so.
    notes.push(`session unsupported for ${agent}; fell back to exec one-shot`);
    if (effort) notes.push(`${agent} cannot set effort without a session; ran without effort=${effort}`);
    const fallback = await execOneShot({
      agent,
      model,
      promptFile,
      cwd,
      timeoutSeconds,
      promptRetries,
      approveReads,
      suppressReads,
    });
    return { ...fallback, notes };
  }

  try {
    if (model) {
      const set = await run([acpxAgent, "-s", sessionName, "set", "model", model], { timeoutMs: 60_000, cwd });
      if (set.code !== 0) {
        if (classifyAcpxFailure(set) === "model-unavailable") {
          throw new AcpxError(`acpx ${agent} rejected model ${model}: ${firstLine(set.stderr)}`, set);
        }
        notes.push(`could not set model=${model} on ${agent}: ${firstLine(set.stderr)}`);
      }
    }
    if (effort) {
      const key = effortOptionKey(agent);
      const set = key
        ? await run([acpxAgent, "-s", sessionName, "set", key, effort], { timeoutMs: 60_000, cwd })
        : null;
      if (!set || set.code !== 0) {
        notes.push(`${agent} does not advertise a reasoning-effort option; ran without effort=${effort}`);
      }
    }

    const args = [
      ...baseArgs({ cwd, model: null, timeoutSeconds, approveReads, suppressReads }),
      "--prompt-retries",
      String(promptRetries),
      acpxAgent,
      "-s",
      sessionName,
      "--file",
      promptFile,
    ];
    const result = await run(args, { timeoutMs: (timeoutSeconds + 30) * 1000, cwd });
    if (result.timedOut) throw new AcpxError(`acpx ${agent} session prompt timed out after ${timeoutSeconds}s`, result);
    if (result.code !== 0) throw new AcpxError(`acpx ${agent} session prompt failed (exit ${result.code})`, result);

    const combined = `${result.stdout}\n${result.stderr}`;
    return { text: stripAcpxNoise(result.stdout), usage: parseTokenLine(combined), raw: result.stdout, notes };
  } finally {
    const closed = await run([acpxAgent, "sessions", "close", sessionName], { timeoutMs: 30_000, cwd });
    if (closed.code !== 0) warn(`could not close acpx session ${sessionName}`);
  }
}

function firstLine(text) {
  return (text || "").split("\n").find((l) => l.trim()) || "";
}

/**
 * Per-call usage accounting (design section 9).
 *
 * acpx prints its `[acpx] tokens:` line only when the ACP adapter returns `usage` in
 * the `session/prompt` result. codex and claude do; pi does not (its result is a bare
 * `{ stopReason }`), so a pi-backed pass legitimately has nothing to report. A record
 * therefore keeps the harness next to the (possibly null) usage, so the report can say
 * *who* stayed silent instead of printing a meaningless "n/a".
 *
 * @typedef {{ agent: string, usage: Record<string, number> | null }} UsageRecord
 */

/** @returns {UsageRecord} */
export function usageRecord(agent, result) {
  return { agent, usage: result?.usage || null };
}

/** Sum the usage maps of the records that reported one. */
export function sumUsage(records) {
  const total = {};
  for (const record of records) {
    const usage = record?.usage ?? record;
    if (!usage || typeof usage !== "object") continue;
    for (const [key, value] of Object.entries(usage)) {
      if (Number.isFinite(value)) total[key] = (total[key] || 0) + value;
    }
  }
  return total;
}

export function formatUsage(usage) {
  if (!usage || !Object.keys(usage).length) return "n/a";
  return Object.entries(usage)
    .map(([k, v]) => `${k}=${v.toLocaleString("en-US")}`)
    .join(" ");
}

/**
 * Describe a pass's usage for the report, or null when the pass made no model calls
 * (everything cached, or a different command ran it) - the caller then prints nothing.
 *
 * @param {(UsageRecord | null | undefined)[]} records
 * @returns {string | null}
 */
export function describeUsage(records) {
  const calls = (records || []).filter((r) => r && typeof r === "object" && "agent" in r);
  if (!calls.length) return null;
  const reported = calls.filter((r) => r.usage && Object.keys(r.usage).length);
  if (!reported.length) {
    const agents = [...new Set(calls.map((r) => r.agent))].join(", ");
    return `not reported by ${agents}`;
  }
  const text = formatUsage(sumUsage(reported));
  if (reported.length === calls.length) return text;
  return `${text} (${reported.length} of ${calls.length} calls reported)`;
}
