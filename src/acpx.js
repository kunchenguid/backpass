import fs from "node:fs";

import { UserError, warn } from "./logger.js";
import { runCapture } from "./subprocess.js";
import { prepareHarnessInvocation } from "./harness-invoke.js";
import * as piStore from "./discovery/adapters/pi.js";
import { readJsonl } from "./discovery/adapters/shared.js";

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
 * The session config-option id each adapter uses for reasoning effort when that
 * `set` is session-local. Pi is absent: ACP `set thought_level` rewrites
 * `~/.pi/agent/settings.json`, so Pi effort is process `--thinking` instead
 * (`src/harness-invoke.js`). Grok uses process `--reasoning-effort`. OpenCode
 * uses ACP `set effort`, which is session-local variant state.
 */
export const EFFORT_OPTION_KEYS = { codex: "reasoning_effort", claude: "effort", opencode: "effort" };

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
    /** Set when the adapter has no session support at all (not an availability verdict). */
    this.unsupported = false;
  }
}

/**
 * Every acpx call goes through here, which is also where a Windows command-shim
 * refusal (`src/subprocess.js`) is raised. It has to be raised at the funnel rather
 * than at each caller: a refusal resolves as `{ code: null, spawnError }`, which every
 * result inspection downstream would read as a generic failure - `openSession` would
 * call it "no session support" and the per-turn prompt "exit null", neither naming the
 * argument backpass refused to pass. Widening `classifyAcpxFailure` is wrong for a
 * related reason: `unreachable` would silently demote the harness and the next
 * candidate would fail on the very same argument.
 *
 * @param {string[]} args
 * @param {{ timeoutMs?: number, cwd?: string, input?: string, env?: NodeJS.ProcessEnv }} [options]
 */
async function run(args, options = {}) {
  const result = await runCapture(ACPX_BIN, args, options);
  const spawnError = result.spawnError;
  if (spawnError?.code === "ERR_WINDOWS_SHIM_UNSAFE_ARG") {
    const value = spawnError.value === undefined ? "" : JSON.stringify(String(spawnError.value));
    throw new UserError(
      `backpass refused to pass ${value} to ${ACPX_BIN} through the Windows command interpreter`,
      spawnError.message,
    );
  }
  return result;
}

function notFoundError(result) {
  return new AcpxError(`acpx not found on PATH (looked for "${ACPX_BIN}")`, result);
}

/**
 * How long `acpx <agent> sessions new` may take before backpass kills it.
 *
 * acpx spawns most built-in ACP adapters through an npm package-exec bridge
 * (`acpx --verbose` prints it: `npm exec --yes --package=@agentclientprotocol/codex-acp@...`,
 * `npx pi-acp@...`), so session create can include a cold package install before the
 * adapter process exists at all. The codex adapter alone pulls a ~270MB platform binary,
 * which no 60s budget can cover on a first run; npm also performs a registry
 * security-advisory round-trip per spawn, which stalls session create when that endpoint
 * is slow. An agent acpx launches as a local binary (grok) never pays either cost.
 */
export const SESSION_CREATE_TIMEOUT_MS = 180_000;

/**
 * A session-create timeout must be raised by name, before any generic handling.
 *
 * backpass kills the call itself, and acpx exits 130 on SIGTERM, so the result reaching
 * `openSession` is an ordinary non-zero exit with empty stderr. Read generically it lands
 * in the `unsupported` branch and the run stops with "its acpx adapter does not support
 * sessions - upgrade acpx or omit the effort override": three claims that are all false
 * for a harness whose adapter simply had not started yet, and advice that cannot help.
 * `result.timedOut` is the only signal that separates the two, so it is checked first.
 */
function sessionCreateTimeoutError({ agent, acpxAgentArgs, timeoutMs }) {
  const seconds = Math.round(timeoutMs / 1000);
  return new UserError(
    `acpx ${agent} did not create a session within ${seconds}s`,
    `its ACP adapter did not finish starting; adapter initialization or a cold or stalled npm package fetch can block session creation - check with: acpx --verbose ${acpxAgentArgs.join(" ")} sessions new --name backpass-probe`,
  );
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

/**
 * acpx prints a per-run accounting line: `[acpx] tokens: input=10 output=47 ... total=34194`.
 * @returns {Record<string, number> | null}
 */
export function parseTokenLine(text) {
  const match = /\[acpx\]\s+tokens:\s+(.+)/.exec(text || "");
  if (!match) return null;
  /** @type {Record<string, number>} */
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

/**
 * Permission modes. `approveAll` is what native editing needs: the harness's own
 * `edit`/`write` tools are approved, which is why every call that sets it runs with a
 * staging workspace as `cwd` (`src/workspace.js`), never the repo. acpx's policy rules
 * match tool kinds, not paths, so the workspace is the blast-radius boundary.
 */
function baseArgs({ cwd, model, timeoutSeconds, approveReads, approveAll = false, suppressReads }) {
  const args = [];
  if (cwd) args.push("--cwd", cwd);
  if (approveAll) args.push("--approve-all");
  else if (approveReads) args.push("--approve-reads");
  else args.push("--deny-all");
  if (suppressReads) args.push("--suppress-reads");
  args.push("--non-interactive-permissions", "deny");
  if (timeoutSeconds) args.push("--timeout", String(timeoutSeconds));
  if (model) args.push("--model", model);
  args.push("--format", "quiet");
  return args;
}

function invocationAgentArgs(invocation, agent) {
  return invocation.acpxAgentCommand ? ["--agent", invocation.acpxAgentCommand] : [acpxAgentName(agent)];
}

async function verifyHarnessInvocation(invocation, cwd) {
  if (!invocation.requiredBuiltinAgent) return;
  const args = [...(cwd ? ["--cwd", cwd] : []), "config", "show", "--format", "json"];
  const result = await run(args, { timeoutMs: 10_000, cwd, env: invocation.env });
  if (result.code !== 0) {
    throw new UserError(
      `cannot verify acpx adapter configuration for ${invocation.requiredBuiltinAgent}: ${firstLine(result.stderr) || `exit ${result.code}`}`,
      "upgrade acpx or omit the model and effort override",
    );
  }

  let config;
  try {
    config = JSON.parse(result.stdout);
  } catch {
    throw new UserError(
      `cannot verify acpx adapter configuration for ${invocation.requiredBuiltinAgent}: config show returned invalid JSON`,
      "upgrade acpx or omit the model and effort override",
    );
  }

  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    !config.agents ||
    typeof config.agents !== "object"
  ) {
    throw new UserError(
      `cannot verify acpx adapter configuration for ${invocation.requiredBuiltinAgent}: config show omitted the resolved agents map`,
      "upgrade acpx or omit the model and effort override",
    );
  }

  if (Object.prototype.hasOwnProperty.call(config.agents, invocation.requiredBuiltinAgent)) {
    throw new UserError(
      `cannot safely apply model or effort overrides because acpx agents.${invocation.requiredBuiltinAgent} replaces the proven built-in adapter`,
      `remove the agents.${invocation.requiredBuiltinAgent} replacement or omit the model and effort override`,
    );
  }
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
 *   detail: string, availableModels: string[], transient?: boolean }>}
 */
export async function probeSession({
  agent,
  sessionName,
  cwd = undefined,
  timeoutMs = 20_000,
  createTimeoutMs = timeoutMs,
}) {
  const acpxAgent = acpxAgentName(agent);
  const created = await run([acpxAgent, "sessions", "new", "--name", sessionName], {
    timeoutMs: createTimeoutMs,
    cwd,
  });
  if (created.spawnError?.code === "ENOENT") throw notFoundError(created);
  if (created.timedOut) {
    return {
      verdict: "timeout",
      detail: `probe timed out after ${Math.round(createTimeoutMs / 1000)}s`,
      availableModels: [],
    };
  }
  if (created.code !== 0) {
    const classified = classifyAcpxFailure(created);
    return {
      verdict: classified || "unreachable",
      detail: firstLine(created.stderr) || `exit ${created.code}`,
      availableModels: [],
      ...(!classified ? { transient: true } : {}),
    };
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
  effort = null,
  promptFile,
  cwd,
  timeoutSeconds = 300,
  promptRetries = 1,
  approveReads = true,
  suppressReads = true,
}) {
  const invocation = prepareHarnessInvocation({ agent, model, effort });
  const args = [
    ...baseArgs({ cwd, model: invocation.acpxModel, timeoutSeconds, approveReads, suppressReads }),
    "--prompt-retries",
    String(promptRetries),
    ...invocationAgentArgs(invocation, agent),
    "exec",
    "--file",
    promptFile,
  ];

  const startedAt = Date.now();
  try {
    await verifyHarnessInvocation(invocation, cwd);
    if (effort && invocation.setEffortKey) {
      throw new UserError(
        `${agent} cannot apply invocation-scoped effort=${effort} in an exec one-shot`,
        "use a named session or omit the effort override",
      );
    }
    const result = await run(args, { timeoutMs: (timeoutSeconds + 30) * 1000, cwd, env: invocation.env });
    if (result.spawnError && result.spawnError.code === "ENOENT") throw notFoundError(result);
    if (result.timedOut) {
      throw new AcpxError(`acpx ${agent} exec timed out after ${timeoutSeconds}s`, result);
    }
    if (result.code !== 0) {
      throw new AcpxError(
        `acpx ${agent} exec failed (exit ${result.code}): ${firstLine(result.stderr) || `exit ${result.code}`}`,
        result,
      );
    }

    const combined = `${result.stdout}\n${result.stderr}`;
    const usage = parseTokenLine(combined) ?? recoverUsageFromStore({ agent, promptFile, cwd, startedAt });
    return { text: stripAcpxNoise(result.stdout), usage, raw: result.stdout, notes: invocation.notes };
  } finally {
    invocation.dispose();
  }
}

/**
 * A named session that stays open across turns (design section 5).
 *
 * Model and effort are applied as invocation-scoped overlays (`src/harness-invoke.js`),
 * never by rewriting persistent harness defaults. `exec` cannot carry process-level
 * effort for every harness, so an effortful call still goes through a session when
 * the overlay needs one. Synthesis also needs more than one turn in the same context:
 * the agent edits the staging copy, then annotates the changes backpass measured.
 * A requested overlay without a proven mechanism stops rather than pretending it applied.
 *
 * Resolves to the handle, or throws an `AcpxError` (`unsupported: true` when the adapter
 * has no session support; `sessionPrompt` only falls back when it can preserve the requested overlays).
 * A `sessions new` that backpass itself killed on timeout is raised by name first
 * (`SESSION_CREATE_TIMEOUT_MS`), never as missing session support.
 *
 * @returns {Promise<{ notes: string[],
 *   prompt: (options: { promptFile: string, timeoutSeconds?: number, promptRetries?: number,
 *     approveReads?: boolean, approveAll?: boolean, suppressReads?: boolean }) =>
 *     Promise<{ text: string, usage: Record<string, number> | null, raw: string, notes: string[] }>,
 *   close: () => Promise<void> }>}
 */
export async function openSession({
  agent,
  model = null,
  effort = null,
  sessionName,
  cwd,
  writeAccess = false,
  createTimeoutMs = SESSION_CREATE_TIMEOUT_MS,
}) {
  const invocation = prepareHarnessInvocation({ agent, model, effort, writeAccess });
  const notes = [...invocation.notes];
  const acpxAgentArgs = invocationAgentArgs(invocation, agent);
  // The adapter is already up once the session exists, so the later `set` calls do not
  // need the cold-start budget `sessions new` gets.
  const runOpts = { timeoutMs: 60_000, cwd, env: invocation.env };
  /** @type {Awaited<ReturnType<typeof run>>} */
  let created;
  try {
    await verifyHarnessInvocation(invocation, cwd);
    created = await run(
      [
        ...(invocation.acpxModel ? ["--model", invocation.acpxModel] : []),
        ...acpxAgentArgs,
        "sessions",
        "new",
        "--name",
        sessionName,
      ],
      { ...runOpts, timeoutMs: createTimeoutMs },
    );
  } catch (err) {
    invocation.dispose();
    throw err;
  }
  if (created.spawnError && created.spawnError.code === "ENOENT") {
    invocation.dispose();
    throw notFoundError(created);
  }
  if (created.timedOut) {
    invocation.dispose();
    throw sessionCreateTimeoutError({ agent, acpxAgentArgs, timeoutMs: createTimeoutMs });
  }
  if (created.code !== 0) {
    invocation.dispose();
    // An auth or spawn failure must surface as such so the caller can fall through.
    if (classifyAcpxFailure(created)) {
      throw new AcpxError(`acpx ${agent} session create failed: ${firstLine(created.stderr)}`, created);
    }
    const err = new AcpxError(
      `acpx ${agent} has no session support: ${firstLine(created.stderr) || `exit ${created.code}`}`,
      created,
    );
    err.unsupported = true;
    throw err;
  }

  const startedAt = Date.now();
  let closed = false;
  let firstPromptFile = null;
  let storeUsageSeen = null;

  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      const result = await run([...acpxAgentArgs, "sessions", "close", sessionName], {
        timeoutMs: 30_000,
        cwd,
        env: invocation.env,
      });
      if (result.code !== 0) warn(`could not close acpx session ${sessionName}`);
    } finally {
      invocation.dispose();
    }
  };

  try {
    if (invocation.sessionMode) {
      const setMode = await run([...acpxAgentArgs, "-s", sessionName, "set-mode", invocation.sessionMode], runOpts);
      if (setMode.code !== 0) {
        // Same degradation as session create: backpass kills the call, acpx exits 130 with
        // no stderr, and `exit 130` would read as the harness rejecting the mode.
        const detail = setMode.timedOut ? "timed out" : firstLine(setMode.stderr) || `exit ${setMode.code}`;
        if (invocation.sessionModeRequired) {
          throw new AcpxError(
            `acpx ${agent} could not enable write session mode=${invocation.sessionMode}: ${detail}`,
            setMode,
          );
        }
        notes.push(
          `${agent} did not accept session mode ${invocation.sessionMode}; continuing with the adapter default`,
        );
      }
    }
    if (effort && invocation.setEffortKey) {
      const set = await run([...acpxAgentArgs, "-s", sessionName, "set", invocation.setEffortKey, effort], runOpts);
      if (set.code !== 0) {
        // Same degradation as session create: a killed call exits 130 with no stderr, and
        // `exit 130` would read as the adapter refusing the effort key.
        const detail = set.timedOut ? "timed out" : firstLine(set.stderr) || `exit ${set.code}`;
        throw new AcpxError(`acpx ${agent} could not apply invocation-scoped effort=${effort}: ${detail}`, set);
      }
    }
  } catch (err) {
    await close();
    throw err;
  }

  const prompt = async ({
    promptFile,
    timeoutSeconds = 900,
    promptRetries = 1,
    approveReads = true,
    approveAll = false,
    suppressReads = true,
  }) => {
    if (closed) throw new AcpxError(`acpx ${agent} session ${sessionName} is closed`);
    firstPromptFile = firstPromptFile || promptFile;
    const args = [
      ...baseArgs({ cwd, model: null, timeoutSeconds, approveReads, approveAll, suppressReads }),
      "--prompt-retries",
      String(promptRetries),
      ...acpxAgentArgs,
      // `--agent <command>` has no `-s` of its own (acpx 0.13.1/0.13.2: `unknown
      // option '-s'`, exit 2). `-s`/`--file` live on `prompt`. Built-in agents still
      // accept the implicit form (`acpx codex -s ... --file ...`); `acpx codex prompt
      // --help` documents the subcommand too, but changing that path is unnecessary.
      ...(invocation.acpxAgentCommand ? ["prompt"] : []),
      "-s",
      sessionName,
      "--file",
      promptFile,
    ];
    const result = await run(args, { timeoutMs: (timeoutSeconds + 30) * 1000, cwd, env: invocation.env });
    if (result.timedOut) throw new AcpxError(`acpx ${agent} session prompt timed out after ${timeoutSeconds}s`, result);
    if (result.code !== 0) {
      throw new AcpxError(
        `acpx ${agent} session prompt failed (exit ${result.code}): ${firstLine(result.stderr) || `exit ${result.code}`}`,
        result,
      );
    }

    const combined = `${result.stdout}\n${result.stderr}`;
    /** @type {Record<string, number> | null} */
    let usage = parseTokenLine(combined);
    if (!usage) {
      // The harness store holds the whole session's usage; this turn is the increase.
      const cumulative = recoverUsageFromStore({ agent, promptFile: firstPromptFile, cwd, startedAt });
      usage = cumulative ? subtractUsage(cumulative, storeUsageSeen) : null;
      if (cumulative) storeUsageSeen = cumulative;
    }
    return { text: stripAcpxNoise(result.stdout), usage, raw: result.stdout, notes };
  };

  return { notes, prompt, close };
}

/** @returns {Record<string, number>} */
function subtractUsage(current, previous) {
  if (!previous) return current;
  /** @type {Record<string, number>} */
  const out = {};
  for (const [key, value] of Object.entries(current)) out[key] = value - (previous[key] || 0);
  return out;
}

/**
 * One prompt through a short-lived named session: open, prompt, close. The analysis
 * pass uses this whenever an effort is configured. Without session support, it falls
 * back to one-shot `exec` only when that preserves the requested overlays; otherwise it
 * stops with actionable guidance.
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
  createTimeoutMs = SESSION_CREATE_TIMEOUT_MS,
}) {
  let session;
  try {
    session = await openSession({ agent, model, effort, sessionName, cwd, createTimeoutMs });
  } catch (err) {
    if (!(err instanceof AcpxError) || !err.unsupported) throw err;
    if (effort && effortOptionKey(agent)) {
      throw new UserError(
        `${agent} cannot apply invocation-scoped effort=${effort} because its acpx adapter does not support sessions`,
        "upgrade acpx or omit the effort override",
      );
    }
    const notes = [`session unsupported for ${agent}; fell back to exec one-shot`];
    const fallback = await execOneShot({
      agent,
      model,
      effort,
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
    return await session.prompt({ promptFile, timeoutSeconds, promptRetries, approveReads, suppressReads });
  } finally {
    await session.close();
  }
}

function firstLine(text) {
  return (text || "").split("\n").find((l) => l.trim()) || "";
}

/**
 * Harness-store usage fallback.
 *
 * acpx prints its `[acpx] tokens:` line only when the ACP adapter returns `usage` in
 * the `session/prompt` result. codex and claude do; pi-acp (0.0.31) answers with a bare
 * `{ stopReason }` - but pi itself records per-turn usage in its own session file
 * (`~/.pi/agent/sessions/<escaped-cwd>/<ts>_<id>.jsonl`), the same store discovery
 * reads. A plain `exec` leaves no session id to look the file up by, so the handle is
 * the prompt text itself: pi stores it verbatim as the session's first user message.
 * The newest file under this cwd, modified during the call, whose first user message
 * equals the prompt we sent, is ours; its assistant turns' `usage` sum is the answer,
 * mapped onto acpx's key names so the two sources add up in one table.
 *
 * Strictly fail-soft: any miss (no store, no match, no usage fields) is null, which the
 * report prints as "not reported by pi" exactly as before.
 */
const STORE_USAGE_RECOVERY = { pi: recoverPiUsage };

/** Slack for a harness that stamps the session timestamp slightly before we spawned it. */
const STORE_MTIME_SLACK_MS = 5_000;

/** @returns {Record<string, number> | null} */
export function recoverUsageFromStore({ agent, promptFile, cwd, startedAt }) {
  const recover = STORE_USAGE_RECOVERY[agent];
  if (!recover) return null;
  try {
    return recover({ promptFile, cwd, startedAt }) || null;
  } catch {
    return null;
  }
}

const PI_USAGE_KEYS = {
  input: "input",
  output: "output",
  cacheRead: "cache_read",
  cacheWrite: "cache_write",
  reasoning: "reasoning",
  totalTokens: "total",
};

function recoverPiUsage({ promptFile, cwd, startedAt }) {
  const prompt = fs.readFileSync(promptFile, "utf8").trim();
  if (!prompt) return null;
  const wanted = new Set([cwd, realpathOrNull(cwd)].filter(Boolean));
  const since = (startedAt || 0) - STORE_MTIME_SLACK_MS;

  const candidates = piStore
    .enumerate()
    .filter((c) => c.mtimeMs >= since)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of candidates) {
    const descriptor = piStore.classify(candidate);
    if (!descriptor || !wanted.has(descriptor.cwd)) continue;
    const entries = readJsonl(candidate.path);
    const firstUser = entries.find((e) => e.type === "message" && e.message?.role === "user");
    if (!firstUser || piMessageText(firstUser.message.content).trim() !== prompt) continue;

    const usage = {};
    for (const entry of entries) {
      if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
      const turn = entry.message.usage;
      if (!turn || typeof turn !== "object") continue;
      for (const [piKey, key] of Object.entries(PI_USAGE_KEYS)) {
        if (Number.isFinite(turn[piKey])) usage[key] = (usage[key] || 0) + turn[piKey];
      }
    }
    return Object.keys(usage).length ? usage : null;
  }
  return null;
}

function piMessageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (typeof b === "string" ? b : b?.type === "text" ? (b.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Per-call usage accounting (design section 9).
 *
 * A record keeps the harness next to the (possibly null) usage, so when neither acpx
 * nor the harness store yielded numbers the report can say *who* stayed silent instead
 * of printing a meaningless "n/a".
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
