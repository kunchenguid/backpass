import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * A spawn failure. `value` is set only on a Windows shim refusal
 * (`ERR_WINDOWS_SHIM_UNSAFE_ARG`), and holds the argument that was refused, so the
 * boundary reporting it can name the value rather than a generic spawn failure.
 *
 * @typedef {NodeJS.ErrnoException & { value?: string }} ShimError
 */

/**
 * Spawn a command, capture both streams, and resolve (never reject) with a
 * uniform result. Shared by the acpx boundary (`src/acpx.js`) and the native
 * harness probes (`src/agents.js`), so every subprocess in backpass is killed the
 * same way on timeout and reports a spawn failure the same way.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {{ timeoutMs?: number, cwd?: string, input?: string, env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform, lookupEnv?: NodeJS.ProcessEnv,
 *   spawnFn?: (file: string, args: string[], options: object) => any }} [options]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut?: boolean, spawnError?: ShimError }>}
 */
export function runCapture(
  bin,
  args,
  { timeoutMs, cwd, input, env, platform = process.platform, lookupEnv = process.env, spawnFn = spawn } = {},
) {
  return new Promise((resolve) => {
    const launch = windowsShimLaunch(bin, args, { platform, env: lookupEnv });
    if (launch.error) {
      // Loud and named: an argument no quoting can neutralise must not reach a shim
      // where cmd.exe would silently rewrite it into several arguments or commands.
      resolve({ code: null, stdout: "", stderr: launch.error.message, spawnError: launch.error });
      return;
    }

    const child = spawnFn(launch.file, launch.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : undefined,
      // The shim launch hands cmd.exe one already-quoted command line; Node must
      // not re-quote it.
      ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
      // Give a timed command its own POSIX process group. acpx launches adapter
      // wrappers and harnesses below itself, and killing acpx alone leaves those
      // descendants running with our capture pipes open.
      detached: platform !== "win32" && Boolean(timeoutMs),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let escalationTimer = null;

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          if (platform === "win32") {
            killWindowsTree(child.pid);
            return;
          }
          killPosixGroup(child, "SIGTERM");
          escalationTimer = setTimeout(() => killPosixGroup(child, "SIGKILL"), 5000);
          escalationTimer.unref();
        }, timeoutMs)
      : null;

    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      resolve({ code: null, stdout, stderr: `${stderr}${err.message}`, spawnError: err });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut && platform !== "win32") killPosixGroup(child, "SIGKILL");
      if (escalationTimer) clearTimeout(escalationTimer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * Windows npm-shim launch policy (issue #43).
 *
 * npm installs a JS CLI on Windows as `<name>.cmd`; there is no `<name>.exe`. A bare
 * `spawn("acpx")` goes through CreateProcess, which appends only ".exe", so it fails
 * with ENOENT even though `where acpx` succeeds - which is exactly the misleading
 * "acpx not found on PATH" the issue reports. Spawning the resolved `.cmd` directly
 * does not help either: since the CVE-2024-27980 mitigation, Node >= 18.20 refuses a
 * `.cmd`/`.bat` without a shell and throws a synchronous EINVAL, which would escape
 * `runCapture`'s promise executor and break its resolve-never-reject contract.
 *
 * So a shim has to go through the command interpreter - but NOT through Node's
 * `shell: true`, which joins argv with bare spaces and quotes nothing, splitting every
 * `--cwd` / `--file` path that contains a space. We build the command line ourselves
 * and pass it verbatim.
 *
 * Anything that is not a resolvable `.cmd`/`.bat` is left exactly as it was, so a
 * genuinely missing binary still surfaces as its own ENOENT rather than as a shim
 * failure.
 *
 * @returns {{ file: string, args: string[], verbatim: boolean, error?: ShimError }}
 */
export function windowsShimLaunch(bin, args, { platform = process.platform, env = process.env } = {}) {
  const shim = resolveShimPath(bin, { platform, env });
  if (!shim) return { file: bin, args, verbatim: false };

  for (const value of [shim, ...args]) {
    const reason = unsafeShimReason(String(value));
    if (!reason) continue;
    /** @type {ShimError} */
    const error = new Error(
      `cannot safely pass ${JSON.stringify(String(value))} to the Windows command shim for ${bin}: ${reason}`,
    );
    error.code = "ERR_WINDOWS_SHIM_UNSAFE_ARG";
    error.value = String(value);
    return { file: bin, args, verbatim: false, error };
  }

  const line = [shim, ...args].map((value) => quoteShimArg(String(value))).join(" ");
  return { file: env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

/**
 * Why an argument can never be made safe on a cmd.exe command line, or null when
 * quoting is enough. Every argument backpass passes is a flag, a model id, a session
 * name or a path, so none of these can occur legitimately and refusing costs nothing.
 *
 * `%NAME%` is expanded even inside quotes and has no command-line escape. A double
 * quote cannot be escaped for both readers at once - cmd.exe counts quotes while the
 * target's MSVCRT parser reads backslash rules - so either encoding leaves one of them
 * mis-parsing the rest of the line. A newline ends the command line outright.
 */
function unsafeShimReason(value) {
  if (EXPANDABLE_PERCENT.test(value)) {
    return "cmd.exe expands %VAR% even inside quotes, and there is no escape for it on a command line";
  }
  if (value.includes('"')) {
    return "cmd.exe counts double quotes while the target's argv parser reads backslash escapes, so no encoding satisfies both";
  }
  if (/[\r\n]/.test(value)) return "a carriage return or newline ends the cmd.exe command line and cannot be quoted";
  return null;
}

/** A plausible `%VAR%` reference. A bare or doubled `%` is left alone: cmd expands neither. */
const EXPANDABLE_PERCENT = /%[A-Za-z_]\w*%/;

/**
 * Quote one argument of a cmd.exe command line.
 *
 * Two parsers see this text: cmd.exe first, then the target's own argv parser (an npm
 * shim forwards `%*` verbatim to `node.exe`). Double quotes satisfy both - they make
 * cmd treat `& | < > ^ ( ) !` as literal, and they are what MSVCRT's parser expects -
 * so the value is quoted whenever it is empty or holds whitespace or one of those
 * operators. A trailing run of backslashes is doubled per the MSVCRT rules, so a path
 * ending in `\` cannot escape the closing quote. An embedded quote never gets here:
 * `unsafeShimReason` refuses it rather than pick an encoding one parser would misread.
 *
 * NOT `cmdQuote` from `harness-invoke.js`: that one doubles `%` for a batch *file*
 * body, which on a command *line* is not an escape - it arrives literally, turning
 * `100%done` into `100%%done`.
 */
export function quoteShimArg(value) {
  if (value.length > 0 && !/[\s&|<>^()!]/.test(value)) return value;
  return `"${value.replace(/(\\*)$/, "$1$1")}"`;
}

/**
 * The `.cmd`/`.bat` this name resolves to on Windows, or null when the plain spawn is
 * already correct (not Windows, a real executable, or a name that resolves to nothing).
 */
function resolveShimPath(bin, { platform, env }) {
  if (platform !== "win32") return null;
  const resolved = resolveOnPath(bin, { platform, env });
  return resolved && /\.(?:cmd|bat)$/i.test(resolved) ? resolved : null;
}

/**
 * First match for `bin` on PATH, honouring PATHEXT on Windows. Shared with
 * `src/harness-invoke.js`, which needs the same resolution to build argv wrappers.
 *
 * A Windows PATH entry may legally carry surrounding double quotes, and an entry kept
 * verbatim never stats: the npm shim would go undetected and the plain spawn would fail
 * with the very ENOENT this module exists to prevent.
 */
export function resolveOnPath(bin, { platform = process.platform, env = process.env } = {}) {
  if (path.isAbsolute(bin) && isExecutable(bin, platform)) return bin;
  const extensions = platform === "win32" ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const entry of (env.PATH || "").split(path.delimiter)) {
    const dir = entry.replace(/^"|"$/g, "");
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, platform === "win32" ? `${bin}${extension.toLowerCase()}` : bin);
      if (isExecutable(candidate, platform)) return candidate;
    }
  }
  return null;
}

function isExecutable(file, platform = process.platform) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && (platform === "win32" || Boolean(st.mode & 0o111));
  } catch {
    return false;
  }
}

function killPosixGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Preserve direct-child cleanup if a platform cannot address the group.
    try {
      child.kill(signal);
    } catch {
      // The child already closed.
    }
  }
}

function killWindowsTree(pid) {
  if (!pid) return;
  const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  killer.on("error", () => {
    // taskkill is part of Windows, but retain direct-child cleanup if it cannot start.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The child already closed.
    }
  });
  killer.unref();
}
