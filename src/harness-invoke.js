import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { UserError } from "./logger.js";

/**
 * Invocation-scoped model and effort overlays (`src/acpx.js` is the caller).
 *
 * A one-off model or reasoning level must ride on this spawn only. Isolated Pi
 * reproduction (throwaway `PI_CODING_AGENT_DIR`): RPC `set_model` /
 * `set_thinking_level` rewrite `settings.json`; `pi --model` / `--thinking` at
 * process start select the values for that process and leave defaults untouched.
 * acpx `--model` after `session/new` is ACP `setSessionModel`, which is that
 * persist path for Pi, so Pi never gets `--model` on acpx or a later `set`.
 *
 * How each invoked harness applies a requested overlay for this spawn:
 *   pi        process argv via `PI_ACP_PI_COMMAND` wrapper: `--model`, `--thinking`
 *   grok      process argv via acpx `--agent` wrapper: `-m`, `--reasoning-effort`
 *   claude    acpx `--model` at `sessions new` (session/new `_meta`); ACP `set effort`
 *   codex     acpx `--model` at `sessions new`; ACP `set reasoning_effort`
 *   opencode  acpx `--model` at `sessions new`; no effort overlay (report, never pretend)
 *
 * No overlay requested means no wrapper, no `--model`, no `set` - same spawn as before.
 * A requested overlay with no proven invocation-scoped mechanism throws rather than
 * writing persistent defaults or silently ignoring the request. OpenCode effort is the
 * sole explicit exception: it is skipped with a report note.
 */

/** ACP session-config ids used only when that `set` is session-local, not a persist path. */
const SESSION_LOCAL_EFFORT_KEYS = { codex: "reasoning_effort", claude: "effort" };

/**
 * @typedef {{
 *   env: Record<string, string> | undefined,
 *   acpxModel: string | null,
 *   setEffortKey: string | null,
 *   acpxAgentCommand: string | null,
 *   requiredBuiltinAgent: string | null,
 *   notes: string[],
 *   dispose: () => void,
 * }} HarnessInvocation
 */

/**
 * @param {{ agent: string, model?: string | null, effort?: string | null }} options
 * @returns {HarnessInvocation}
 */
export function prepareHarnessInvocation({ agent, model = null, effort = null }) {
  const notes = [];
  const cleanups = [];
  const dispose = () => {
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        // Temp wrappers are best-effort to remove.
      }
    }
  };

  const requestedModel = typeof model === "string" && model.trim() ? model.trim() : null;
  const requestedEffort = typeof effort === "string" && effort.trim() ? effort.trim() : null;

  if (!requestedModel && !requestedEffort) {
    return {
      env: undefined,
      acpxModel: null,
      setEffortKey: null,
      acpxAgentCommand: null,
      requiredBuiltinAgent: null,
      notes,
      dispose,
    };
  }

  try {
    if (agent === "pi") return piInvocation({ requestedModel, requestedEffort, notes, cleanups, dispose });
    if (agent === "grok") return grokInvocation({ requestedModel, requestedEffort, notes, cleanups, dispose });
    if (agent === "claude" || agent === "codex") {
      return {
        env: undefined,
        acpxModel: requestedModel,
        setEffortKey: requestedEffort ? SESSION_LOCAL_EFFORT_KEYS[agent] : null,
        acpxAgentCommand: null,
        requiredBuiltinAgent: agent,
        notes,
        dispose,
      };
    }
    if (agent === "opencode") {
      if (requestedEffort) {
        notes.push(`${agent} does not advertise a reasoning-effort option; ran without effort=${requestedEffort}`);
      }
      return {
        env: undefined,
        acpxModel: requestedModel,
        setEffortKey: null,
        acpxAgentCommand: null,
        requiredBuiltinAgent: agent,
        notes,
        dispose,
      };
    }
    throw new UserError(
      `${agent} has no proven invocation-scoped way to apply ${describeOverride(requestedModel, requestedEffort)} without writing persistent harness defaults`,
      "pin pi, claude, codex, grok, or opencode, or omit the model and effort override",
    );
  } catch (err) {
    dispose();
    throw err;
  }
}

function describeOverride(model, effort) {
  const bits = [];
  if (model) bits.push(`model=${model}`);
  if (effort) bits.push(`effort=${effort}`);
  return bits.join(" and ");
}

function piInvocation({ requestedModel, requestedEffort, notes, cleanups, dispose }) {
  if (process.env.PI_ACP_PI_COMMAND) {
    throw new UserError(
      "cannot safely apply Pi model or effort overrides when PI_ACP_PI_COMMAND replaces the proven Pi command",
      "unset PI_ACP_PI_COMMAND or omit the model and effort override",
    );
  }
  const extra = [];
  if (requestedModel) extra.push("--model", requestedModel);
  if (requestedEffort) extra.push("--thinking", requestedEffort);
  const real = resolveOnPath("pi");
  if (!real || (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(real))) {
    throw new UserError(
      `cannot apply ${describeOverride(requestedModel, requestedEffort)} as safe Pi process arguments on this platform`,
      "install Pi as a directly executable binary, or omit the model and effort override",
    );
  }
  const { wrapperPath, dir } = writeArgvWrapper({ realCommand: real, extraArgs: extra, binName: "pi" });
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    env: { PI_ACP_PI_COMMAND: wrapperPath },
    acpxModel: null,
    setEffortKey: null,
    acpxAgentCommand: null,
    requiredBuiltinAgent: "pi",
    notes,
    dispose,
  };
}

function grokInvocation({ requestedModel, requestedEffort, notes, cleanups, dispose }) {
  if (process.platform === "win32") {
    throw new UserError(
      `cannot apply ${describeOverride(requestedModel, requestedEffort)} through acpx --agent on Windows`,
      "pin pi, claude, codex, or opencode, or omit the model and effort override",
    );
  }
  const extra = [];
  if (requestedModel) extra.push("-m", requestedModel);
  if (requestedEffort) extra.push("--reasoning-effort", requestedEffort);
  extra.push("agent", "stdio");
  const real = resolveOnPath("grok");
  if (!real) {
    throw new UserError(
      `cannot apply ${describeOverride(requestedModel, requestedEffort)} as grok process flags because grok was not found on PATH`,
      "install the grok CLI, or pin a different agent / omit the model and effort override",
    );
  }
  const { nodeCommand, dir } = writeArgvWrapper({ realCommand: real, extraArgs: extra, binName: "grok" });
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    env: undefined,
    acpxModel: null,
    setEffortKey: null,
    acpxAgentCommand: nodeCommand,
    requiredBuiltinAgent: null,
    notes,
    dispose,
  };
}

/**
 * Write a node wrapper that prepends `extraArgs` and execs `realCommand` with
 * inherited stdio. Args are JSON-encoded so values with spaces or `$()` stay literal.
 *
 * @param {{ realCommand: string, extraArgs: string[], binName: string }} options
 */
function writeArgvWrapper({ realCommand, extraArgs, binName }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-harness-wrap-"));
  const scriptPath = path.join(dir, `${binName}.cjs`);
  const payload = JSON.stringify({ real: realCommand, extra: extraArgs });
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { real, extra } = ${payload};
const child = spawn(real, extra.concat(process.argv.slice(2)), { stdio: "inherit" });
const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
let escalationTimer = null;
const forwardSignal = (signal) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill(signal); } catch {}
  if (!escalationTimer) {
    escalationTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch {}
      }
    }, 4000);
    escalationTimer.unref();
  }
};
const signalHandlers = new Map(signals.map((signal) => [signal, () => forwardSignal(signal)]));
for (const [signal, handler] of signalHandlers) process.on(signal, handler);
child.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (escalationTimer) clearTimeout(escalationTimer);
  for (const [name, handler] of signalHandlers) process.removeListener(name, handler);
  if (signal) {
    try {
      process.kill(process.pid, signal);
      return;
    } catch {}
  }
  process.exit(code ?? 1);
});
`,
  );
  let wrapperPath = scriptPath;
  if (process.platform === "win32") {
    wrapperPath = path.join(dir, `${binName}.cmd`);
    fs.writeFileSync(wrapperPath, `@echo off\r\n${cmdQuote(process.execPath)} ${cmdQuote(scriptPath)} %*\r\n`);
  } else {
    fs.chmodSync(scriptPath, 0o755);
  }
  return { wrapperPath, nodeCommand: renderCommandArgv([process.execPath, scriptPath]), dir };
}

function renderCommandArgv(argv) {
  return argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
}

function cmdQuote(value) {
  return `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
}

function resolveOnPath(bin) {
  if (path.isAbsolute(bin) && isExecutable(bin)) return bin;
  const extensions = process.platform === "win32" ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, process.platform === "win32" ? `${bin}${extension.toLowerCase()}` : bin);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutable(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && (process.platform === "win32" || Boolean(st.mode & 0o111));
  } catch {
    return false;
  }
}
