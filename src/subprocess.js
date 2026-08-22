import { spawn } from "node:child_process";

/**
 * Spawn a command, capture both streams, and resolve (never reject) with a
 * uniform result. Shared by the acpx boundary (`src/acpx.js`) and the native
 * harness probes (`src/agents.js`), so every subprocess in backpass is killed the
 * same way on timeout and reports a spawn failure the same way.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {{ timeoutMs?: number, cwd?: string, input?: string }} [options]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut?: boolean, spawnError?: NodeJS.ErrnoException }>}
 */
export function runCapture(bin, args, { timeoutMs, cwd, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5000).unref();
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
      resolve({ code: null, stdout, stderr: `${stderr}${err.message}`, spawnError: err });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
