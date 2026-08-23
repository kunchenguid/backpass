import { spawn } from "node:child_process";

/**
 * Open a URL in the user's default browser, best effort.
 *
 * The review surface URL is always printed as the fallback, so this must never throw or
 * block: a missing opener, a headless box, or a crashing helper all degrade to "print the
 * URL only". Returns true when an opener was launched, false when the environment opted
 * out or had no display.
 *
 * Dependencies are injectable so the decision logic is testable without a real browser.
 *
 * @typedef {(bin: string, args: string[], options: object) => { on?: Function, unref?: Function }} Spawner
 * @param {string | null} url
 * @param {{ platform?: string, env?: Record<string, string | undefined>, spawnFn?: Spawner }} [deps]
 */
export function openInBrowser(url, { platform = process.platform, env = process.env, spawnFn = spawn } = {}) {
  if (!url || !/^https?:\/\//.test(url)) return false;
  if (!canOpenBrowser({ platform, env })) return false;

  const { bin, args } = openerCommand(url, platform);
  try {
    const child = spawnFn(bin, args, { stdio: "ignore", detached: true, windowsHide: true });
    // A missing or failing opener must not surface as an unhandled error.
    child.on?.("error", () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * Headless detection: honor explicit opt-outs, CI, and display-less Linux.
 * @param {{ platform?: string, env?: Record<string, string | undefined> }} [deps]
 */
export function canOpenBrowser({ platform = process.platform, env = process.env } = {}) {
  if (env.BACKPASS_NO_BROWSER || env.CI) return false;
  if (platform === "darwin" || platform === "win32") return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** @returns {{ bin: string, args: string[] }} */
function openerCommand(url, platform) {
  if (platform === "darwin") return { bin: "open", args: [url] };
  // `start` treats its first quoted argument as the window title; pass an empty one.
  if (platform === "win32") return { bin: "cmd", args: ["/c", "start", "", url] };
  return { bin: "xdg-open", args: [url] };
}
