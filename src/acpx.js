import { spawn } from 'node:child_process';

import { warn } from './logger.js';

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

export const ACPX_BIN = process.env.BACKPASS_ACPX_BIN || 'acpx';

export class AcpxError extends Error {
  constructor(message, { stdout = '', stderr = '', code = null } = {}) {
    super(message);
    this.name = 'AcpxError';
    this.stdout = stdout;
    this.stderr = stderr;
    this.code = code;
  }
}

function run(args, { timeoutMs, cwd, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(ACPX_BIN, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        }, timeoutMs)
      : null;

    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${err.message}`, spawnError: err });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** acpx prints a per-run accounting line: `[acpx] tokens: input=10 output=47 ... total=34194`. */
export function parseTokenLine(text) {
  const match = /\[acpx\]\s+tokens:\s+(.+)/.exec(text || '');
  if (!match) return null;
  const usage = {};
  for (const pair of match[1].trim().split(/\s+/)) {
    const [key, value] = pair.split('=');
    const n = Number(value);
    if (key && Number.isFinite(n)) usage[key] = n;
  }
  return Object.keys(usage).length ? usage : null;
}

/** Strip acpx's own accounting/status lines from the model's answer. */
export function stripAcpxNoise(text) {
  return (text || '')
    .split('\n')
    .filter((line) => !line.startsWith('[acpx]'))
    .join('\n')
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
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
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
  if (cwd) args.push('--cwd', cwd);
  if (approveReads) args.push('--approve-reads');
  else args.push('--deny-all');
  if (suppressReads) args.push('--suppress-reads');
  args.push('--non-interactive-permissions', 'deny');
  if (timeoutSeconds) args.push('--timeout', String(timeoutSeconds));
  if (model) args.push('--model', model);
  args.push('--format', 'quiet');
  return args;
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
    '--prompt-retries',
    String(promptRetries),
    agent,
    'exec',
    '--file',
    promptFile,
  ];

  const result = await run(args, { timeoutMs: (timeoutSeconds + 30) * 1000, cwd });
  if (result.spawnError && result.spawnError.code === 'ENOENT') {
    throw new AcpxError(
      `acpx not found on PATH (looked for "${ACPX_BIN}")`,
      { stderr: result.stderr },
    );
  }
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
 * Tier 2 - synthesis through a named session (design section 5).
 *
 * acpx documents both `set model` and `set reasoning_effort` on sessions, so the big
 * high-reasoning pass runs there. Adapters that do not advertise a reasoning-effort
 * config option skip that step with a report line - never silently.
 */
export async function sessionPrompt({
  agent,
  model = null,
  effort = null,
  sessionName,
  promptFile,
  cwd,
  timeoutSeconds = 900,
  approveReads = true,
  suppressReads = true,
}) {
  const notes = [];
  const created = await run([agent, 'sessions', 'new', '--name', sessionName], { timeoutMs: 60_000, cwd });
  if (created.spawnError && created.spawnError.code === 'ENOENT') {
    throw new AcpxError(`acpx not found on PATH (looked for "${ACPX_BIN}")`, created);
  }
  if (created.code !== 0) {
    // No session support for this adapter: fall back to a one-shot, and say so.
    notes.push(`session unsupported for ${agent}; fell back to exec one-shot`);
    const fallback = await execOneShot({
      agent,
      model,
      promptFile,
      cwd,
      timeoutSeconds,
      approveReads,
      suppressReads,
    });
    return { ...fallback, notes };
  }

  try {
    if (model) {
      const set = await run([agent, '-s', sessionName, 'set', 'model', model], { timeoutMs: 60_000, cwd });
      if (set.code !== 0) notes.push(`could not set model=${model} on ${agent}: ${firstLine(set.stderr)}`);
    }
    if (effort) {
      const set = await run([agent, '-s', sessionName, 'set', 'reasoning_effort', effort], {
        timeoutMs: 60_000,
        cwd,
      });
      if (set.code !== 0) {
        notes.push(`${agent} does not advertise reasoning_effort; ran without effort=${effort}`);
      }
    }

    const args = [
      ...baseArgs({ cwd, model: null, timeoutSeconds, approveReads, suppressReads }),
      agent,
      '-s',
      sessionName,
      '--file',
      promptFile,
    ];
    const result = await run(args, { timeoutMs: (timeoutSeconds + 30) * 1000, cwd });
    if (result.timedOut) throw new AcpxError(`acpx ${agent} session prompt timed out after ${timeoutSeconds}s`, result);
    if (result.code !== 0) throw new AcpxError(`acpx ${agent} session prompt failed (exit ${result.code})`, result);

    const combined = `${result.stdout}\n${result.stderr}`;
    return { text: stripAcpxNoise(result.stdout), usage: parseTokenLine(combined), raw: result.stdout, notes };
  } finally {
    const closed = await run([agent, 'sessions', 'close', sessionName], { timeoutMs: 30_000, cwd });
    if (closed.code !== 0) warn(`could not close acpx session ${sessionName}`);
  }
}

function firstLine(text) {
  return (text || '').split('\n').find((l) => l.trim()) || '';
}

/** Sum acpx usage records for cost visibility (design section 9). */
export function sumUsage(records) {
  const total = {};
  for (const usage of records) {
    if (!usage) continue;
    for (const [key, value] of Object.entries(usage)) total[key] = (total[key] || 0) + value;
  }
  return total;
}

export function formatUsage(usage) {
  if (!usage || !Object.keys(usage).length) return 'n/a';
  return Object.entries(usage)
    .map(([k, v]) => `${k}=${v.toLocaleString('en-US')}`)
    .join(' ');
}
