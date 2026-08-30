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
 * Synthesis also requests `writeAccess`: native file-write / code-mode must be on for
 * this spawn, never by rewriting `~/.codex/config.toml` or other harness defaults.
 *   codex     `INITIAL_AGENT_MODE=agent`, `CODEX_CONFIG` `features.code_mode_host=true`,
 *             `CODEX_PATH` wrapper `--enable code_mode_host`, ACP `set-mode agent`
 *   grok      process `--always-approve --permission-mode bypassPermissions --sandbox workspace`
 *   pi        no extra flags (the adapter always exposes write/edit; modes are thinking)
 *   claude    acpx `--approve-all` on the prompt (client-side permission) is the contract
 *   opencode  no proven process overlay; `--approve-all` remains the client-side gate
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
 *   sessionMode: string | null,
 *   sessionModeRequired: boolean,
 *   acpxAgentCommand: string | null,
 *   requiredBuiltinAgent: string | null,
 *   notes: string[],
 *   dispose: () => void,
 * }} HarnessInvocation
 */

/**
 * @param {{ agent: string, model?: string | null, effort?: string | null, writeAccess?: boolean }} options
 * @returns {HarnessInvocation}
 */
export function prepareHarnessInvocation({ agent, model = null, effort = null, writeAccess = false }) {
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
  const overlay = Boolean(requestedModel || requestedEffort);

  if (!overlay && !writeAccess) return baseInvocation({ notes, dispose });

  try {
    let invocation;
    if (agent === "pi") {
      invocation = overlay
        ? piInvocation({ requestedModel, requestedEffort, notes, cleanups, dispose })
        : baseInvocation({ notes, dispose });
    } else if (agent === "grok") {
      invocation = grokInvocation({ requestedModel, requestedEffort, writeAccess, notes, cleanups, dispose });
    } else if (agent === "claude" || agent === "codex") {
      invocation = {
        ...baseInvocation({ notes, dispose }),
        acpxModel: requestedModel,
        setEffortKey: requestedEffort ? SESSION_LOCAL_EFFORT_KEYS[agent] : null,
        requiredBuiltinAgent: overlay ? agent : null,
      };
    } else if (agent === "opencode") {
      if (requestedEffort) {
        notes.push(`${agent} does not advertise a reasoning-effort option; ran without effort=${requestedEffort}`);
      }
      invocation = {
        ...baseInvocation({ notes, dispose }),
        acpxModel: requestedModel,
        requiredBuiltinAgent: overlay ? agent : null,
      };
    } else if (overlay) {
      throw new UserError(
        `${agent} has no proven invocation-scoped way to apply ${describeOverride(requestedModel, requestedEffort)} without writing persistent harness defaults`,
        "pin pi, claude, codex, grok, or opencode, or omit the model and effort override",
      );
    } else {
      invocation = baseInvocation({ notes, dispose });
    }
    if (writeAccess && agent === "codex") applyCodexWriteAccess(invocation, { cleanups });
    return invocation;
  } catch (err) {
    dispose();
    throw err;
  }
}

function baseInvocation({ notes, dispose }) {
  return {
    env: undefined,
    acpxModel: null,
    setEffortKey: null,
    sessionMode: null,
    sessionModeRequired: false,
    acpxAgentCommand: null,
    requiredBuiltinAgent: null,
    notes,
    dispose,
  };
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
    sessionMode: null,
    sessionModeRequired: false,
    acpxAgentCommand: null,
    requiredBuiltinAgent: "pi",
    notes,
    dispose,
  };
}

function grokInvocation({ requestedModel, requestedEffort, writeAccess = false, notes, cleanups, dispose }) {
  if (process.platform === "win32") {
    throw new UserError(
      `cannot apply ${describeOverride(requestedModel, requestedEffort) || "file-write flags"} through acpx --agent on Windows`,
      "pin pi, claude, codex, or opencode, or omit the model and effort override",
    );
  }
  const extra = [];
  if (writeAccess) {
    // Permission bypass prevents edit prompts; the OS sandbox still confines approved
    // file and command tools to the staging cwd rather than granting host-wide writes.
    extra.push("--always-approve", "--permission-mode", "bypassPermissions", "--sandbox", "workspace");
  }
  if (requestedModel) extra.push("-m", requestedModel);
  if (requestedEffort) extra.push("--reasoning-effort", requestedEffort);
  extra.push("agent", "stdio");
  const real = resolveOnPath("grok");
  if (!real) {
    throw new UserError(
      `cannot apply ${describeOverride(requestedModel, requestedEffort) || "file-write flags"} as grok process flags because grok was not found on PATH`,
      "install the grok CLI, or pin a different agent / omit the model and effort override",
    );
  }
  const { nodeCommand, dir } = writeArgvWrapper({ realCommand: real, extraArgs: extra, binName: "grok" });
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    env: undefined,
    acpxModel: null,
    setEffortKey: null,
    sessionMode: null,
    sessionModeRequired: false,
    acpxAgentCommand: nodeCommand,
    requiredBuiltinAgent: null,
    notes,
    dispose,
  };
}

/**
 * Codex 0.147+ fails closed when `features.code_mode_host` is off: every file/exec tool
 * returns "code-mode host is disabled". The adapter honors invocation env
 * (`INITIAL_AGENT_MODE`, `CODEX_CONFIG`) and a `CODEX_PATH` wrapper; ACP `set-mode agent`
 * is the session-local follow-through. None of this writes `~/.codex/config.toml`.
 */
function applyCodexWriteAccess(invocation, { cleanups }) {
  invocation.env = { ...(invocation.env || {}) };
  invocation.env.INITIAL_AGENT_MODE = "agent";
  invocation.env.CODEX_CONFIG = mergeCodexConfig(process.env.CODEX_CONFIG, invocation.env.CODEX_CONFIG, {
    features: { code_mode_host: true },
  });
  invocation.sessionMode = "agent";
  invocation.sessionModeRequired = true;

  const real = process.env.CODEX_PATH || null;
  const { wrapperPath, dir } = writeArgvWrapper({
    realCommand: real,
    bundledPackageBin: real ? null : ["@openai", "codex", "bin", "codex.js"],
    extraArgs: ["--enable", "code_mode_host"],
    binName: "codex",
  });
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  invocation.env.CODEX_PATH = wrapperPath;
  invocation.requiredBuiltinAgent = "codex";
}

function mergeCodexConfig(...layers) {
  /** @type {Record<string, unknown>} */
  const merged = {};
  for (const layer of layers) {
    if (!layer) continue;
    let parsed = layer;
    if (typeof layer === "string") {
      try {
        parsed = JSON.parse(layer);
      } catch {
        throw new UserError(
          "cannot enable Codex file-write access because CODEX_CONFIG is not valid JSON",
          "unset CODEX_CONFIG or set it to a valid JSON object",
        );
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new UserError(
          "cannot enable Codex file-write access because CODEX_CONFIG is not a JSON object",
          "unset CODEX_CONFIG or set it to a valid JSON object",
        );
      }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "features" && value && typeof value === "object" && !Array.isArray(value)) {
        const currentFeatures = merged.features;
        merged.features = {
          ...(currentFeatures && typeof currentFeatures === "object" && !Array.isArray(currentFeatures)
            ? currentFeatures
            : {}),
          ...value,
        };
      } else {
        merged[key] = value;
      }
    }
  }
  return JSON.stringify(merged);
}

/**
 * Write a node wrapper that prepends `extraArgs` and execs `realCommand` with
 * inherited stdio. Args are JSON-encoded so values with spaces or `$()` stay literal.
 *
 * @param {{ realCommand: string | null, bundledPackageBin?: string[] | null, extraArgs: string[], binName: string }} options
 */
function writeArgvWrapper({ realCommand, bundledPackageBin = null, extraArgs, binName }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-harness-wrap-"));
  const scriptPath = path.join(dir, `${binName}.cjs`);
  const payload = JSON.stringify({ real: realCommand, bundledPackageBin, extra: extraArgs });
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { real, bundledPackageBin, extra } = ${payload};
const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
let child = null;
let pendingSignal = null;
let escalationTimer = null;
const forwardSignal = (signal) => {
  if (!child) {
    pendingSignal ??= signal;
    return;
  }
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
let command = real;
let args = extra.concat(process.argv.slice(2));
if (bundledPackageBin) {
  const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const packageBin = pathEntries
    .map((entry) => path.resolve(entry.replace(/^"|"$/g, ""), "..", ...bundledPackageBin))
    .find((candidate) => {
      try { return fs.statSync(candidate).isFile(); } catch { return false; }
    });
  if (!packageBin) {
    console.error("could not locate the Codex executable bundled with the acpx adapter");
    process.exit(1);
  }
  command = process.execPath;
  args = [packageBin, ...args];
}
const shell = process.platform === "win32" && /\\.(?:cmd|bat)$/i.test(command);
child = spawn(command, args, { stdio: "inherit", shell });
if (pendingSignal) forwardSignal(pendingSignal);
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
