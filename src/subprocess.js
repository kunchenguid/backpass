import { spawn } from "node:child_process";

/**
 * Spawn a command, capture both streams, and resolve (never reject) with a
 * uniform result. Shared by the acpx boundary (`src/acpx.js`) and the native
 * harness probes (`src/agents.js`), so every subprocess in backpass is killed the
 * same way on timeout and reports a spawn failure the same way.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {{ timeoutMs?: number, cwd?: string, input?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut?: boolean, spawnError?: NodeJS.ErrnoException }>}
 */
export function runCapture(bin, args, { timeoutMs, cwd, input, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : undefined,
      // Give a timed command its own POSIX process group. acpx launches adapter
      // wrappers and harnesses below itself, and killing acpx alone leaves those
      // descendants running with our capture pipes open.
      detached: process.platform !== "win32" && Boolean(timeoutMs),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let escalationTimer = null;

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          if (process.platform === "win32") {
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
      if (timedOut && process.platform !== "win32") killPosixGroup(child, "SIGKILL");
      if (escalationTimer) clearTimeout(escalationTimer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
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
