import os from "node:os";
import path from "node:path";

import { UserError } from "../../logger.js";
import { runCapture } from "../../subprocess.js";

/**
 * The one ssh spawn boundary (design section 6.3), the way `src/acpx.js` is the one
 * model-call boundary: an upstream ssh behaviour change has exactly one blast radius,
 * and every remote failure is classified in one table instead of at each call site.
 *
 * backpass holds no credential. `ssh` authenticates with whatever the person's own
 * `~/.ssh/config` already says - keys, an agent, certificates, a ProxyJump, Tailscale
 * SSH - which is the "infrastructure the user already owns" clause of the vision,
 * literally. `BatchMode=yes` turns a password prompt into a named failure rather than a
 * hung run, and host keys are never auto-accepted: an unknown or changed key is
 * reported with what to do about it and never with a bypass flag.
 */

/** `BACKPASS_SSH_BIN` lets the offline tests substitute a fake, like `BACKPASS_LAVISH_BIN`. */
export function sshBin() {
  return process.env.BACKPASS_SSH_BIN || "ssh";
}

export const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
export const DEFAULT_CONTROL_PERSIST_SECONDS = 60;
/** Wall clock per call. `ConnectTimeout` alone cannot bound a connection that succeeds and then waits. */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

export function controlPath() {
  return path.join(os.tmpdir(), "backpass-ssh-%C");
}

/**
 * Values that reach the ssh command line. A destination starting with `-` would be read
 * as an option, and a quote, backslash or newline cannot be neutralised for the remote
 * login shell - the same posture `windowsShimLaunch` takes, and for the same reason:
 * refusing by name costs nothing, because no legitimate ssh destination or node path
 * contains one.
 *
 * @param {string} kind what the value is, for the message
 * @param {unknown} value
 */
export function assertSafeSshValue(kind, value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new UserError(`${kind} must be a non-empty string (got ${JSON.stringify(value)})`);
  }
  if (value.startsWith("-")) {
    throw new UserError(
      `${kind} ${JSON.stringify(value)} starts with "-" and would be read as an ssh option`,
      "name the host as user@host, or as an alias from ~/.ssh/config",
    );
  }
  const bad = value.match(/["'\\\r\n]/);
  if (bad) {
    throw new UserError(
      `${kind} ${JSON.stringify(value)} contains ${JSON.stringify(bad[0])}, which no quoting can neutralise ` +
        `for the remote shell`,
    );
  }
}

/**
 * The constant option set. `ControlMaster` multiplexes the three calls of one host over
 * a single connection; `ServerAliveInterval` notices a dropped link mid-fetch.
 */
export function sshArgs({
  destination,
  command,
  connectTimeoutSeconds = DEFAULT_CONNECT_TIMEOUT_SECONDS,
  controlPersistSeconds = DEFAULT_CONTROL_PERSIST_SECONDS,
}) {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${connectTimeoutSeconds}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${controlPath()}`,
    "-o",
    `ControlPersist=${controlPersistSeconds}`,
    "-T",
    "--",
    destination,
    command,
  ];
}

/**
 * Run one remote command. Resolves, never rejects, except for a Windows shim refusal:
 * that one must be raised by name here rather than degraded into "host unreachable" a
 * layer up, which is exactly the failure AGENTS.md records two rounds of.
 *
 * @param {{ destination: string, command: string, input?: string, timeoutMs?: number,
 *   connectTimeoutSeconds?: number, controlPersistSeconds?: number, captureStdout?: boolean,
 *   onStdout?: (chunk: Buffer) => void }} options
 */
export async function runSsh({
  destination,
  command,
  input,
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  connectTimeoutSeconds = DEFAULT_CONNECT_TIMEOUT_SECONDS,
  controlPersistSeconds = DEFAULT_CONTROL_PERSIST_SECONDS,
  captureStdout = true,
  onStdout = null,
}) {
  assertSafeSshValue("ssh destination", destination);
  const result = await runCapture(
    sshBin(),
    sshArgs({ destination, command, connectTimeoutSeconds, controlPersistSeconds }),
    {
      input,
      timeoutMs,
      captureStdout,
      onStdout,
    },
  );
  if (result.spawnError?.code === "ERR_WINDOWS_SHIM_UNSAFE_ARG") {
    throw new UserError(
      `cannot run ssh for ${destination}: ${JSON.stringify(result.spawnError.value)} cannot be passed safely ` +
        `through the Windows command shim`,
      "rename the host alias, or configure a destination without that character",
    );
  }
  return result;
}

/** The Tailscale check-mode URL, so the message can say where to approve it. */
export function tailscaleCheckUrl(stderr) {
  const match = String(stderr || "").match(/https:\/\/login\.tailscale\.com\/\S+/);
  return match ? match[0].replace(/[.,)]+$/, "") : null;
}

function tail(stderr, lines = 3) {
  return String(stderr || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lines)
    .join("; ");
}

/**
 * Why a host could not be reached, in the words the person needs (design section 6.9).
 * Returns null when the call succeeded. Every message names the next action, and none
 * of them suggests `StrictHostKeyChecking=no`: a host key that cannot be verified is a
 * decision for the person, not a flag for a tool.
 *
 * @param {{ code?: number | null, stdout?: string, stderr?: string,
 *   timedOut?: boolean, spawnError?: object }} result
 * @param {{ destination: string, connectTimeoutSeconds?: number, timeoutMs?: number }} context
 * @returns {{ reason: string, message: string } | null}
 */
export function classifySshFailure(
  result,
  { destination, connectTimeoutSeconds = DEFAULT_CONNECT_TIMEOUT_SECONDS, timeoutMs = DEFAULT_CALL_TIMEOUT_MS },
) {
  const stderr = String(result?.stderr || "");

  if (result?.spawnError && result.spawnError.code === "ENOENT") {
    return { reason: "ssh-missing", message: "ssh not found on PATH" };
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) {
    return {
      reason: "host-key-changed",
      message: `host key for ${destination} changed; verify the change out of band before continuing`,
    };
  }
  if (/Host key verification failed/i.test(stderr)) {
    return {
      reason: "host-key-unknown",
      message: `connect once interactively (ssh ${destination}) to accept the host key`,
    };
  }
  if (/Tailscale SSH requires an additional check/i.test(stderr)) {
    const url = tailscaleCheckUrl(stderr);
    return {
      reason: "tailscale-check",
      message:
        `${destination} is waiting for a Tailscale SSH check; approve it${url ? ` at ${url}` : ""} and re-run, ` +
        `or use a key-based alias`,
    };
  }
  if (/Permission denied|no matching host key|Too many authentication failures/i.test(stderr)) {
    return {
      reason: "auth",
      message: `non-interactive ssh to ${destination} failed; make "ssh ${destination} true" succeed without a prompt`,
    };
  }
  if (result?.timedOut) {
    return {
      reason: "unreachable",
      message:
        `${destination} unreachable (no response within ${Math.round(timeoutMs / 1000)}s); ` +
        `re-run with --host none to skip hosts`,
    };
  }
  if (/Could not resolve|Connection refused|No route to host|Connection timed out|Operation timed out/i.test(stderr)) {
    return {
      reason: "unreachable",
      message:
        `${destination} unreachable (${tail(stderr, 1) || `no response within ${connectTimeoutSeconds}s`}); ` +
        `re-run with --host none to skip hosts`,
    };
  }
  if (result?.spawnError) {
    return { reason: "spawn", message: `could not run ssh for ${destination}: ${result.spawnError.message}` };
  }
  if (result?.code !== 0) {
    return { reason: "exit", message: `ssh ${destination} exited ${result?.code}${stderr ? `: ${tail(stderr)}` : ""}` };
  }
  return null;
}
