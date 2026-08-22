/**
 * Terminal capability detection for the live progress view.
 *
 * Three questions are answered here, all decided in the approved design review:
 *
 *  1. Is a live view appropriate at all? (TTY, not CI, no NO_COLOR, wide enough)
 *  2. How much color can we emit? Truecolor gets the house theme; anything else
 *     falls back to the nearest ANSI-16 colors.
 *  3. Is the background dark or light? Queried via OSC 11 (~50ms budget) with
 *     COLORFGBG as fallback; unknown assumes dark. A config key / --theme flag
 *     can force either.
 */

/** Minimum columns below which the TUI does not start and plain lines are used. */
export const MIN_COLUMNS = 60;

/** Columns below which the right-hand column (timers, notes) is dropped. */
export const NARROW_COLUMNS = 84;

/**
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {{ isTTY?: boolean, columns?: number }} [options.stderr]
 * @param {boolean} [options.quiet]
 * @param {boolean} [options.json]
 */
export function tuiEligible({ env = process.env, stderr = process.stderr, quiet = false, json = false } = {}) {
  if (quiet || json) return false;
  if (!stderr.isTTY) return false;
  if (env.NO_COLOR !== undefined) return false;
  if (env.CI) return false;
  if ((env.TERM || "") === "dumb") return false;
  if ((stderr.columns || 80) < MIN_COLUMNS) return false;
  return true;
}

/**
 * 24 for truecolor terminals, 4 for everything else (ANSI-16), 0 when color is off.
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {{ isTTY?: boolean }} [options.stderr]
 */
export function colorDepth({ env = process.env, stderr = process.stderr } = {}) {
  if (env.NO_COLOR !== undefined || !stderr.isTTY) return 0;
  const colorterm = (env.COLORTERM || "").toLowerCase();
  if (colorterm.includes("truecolor") || colorterm.includes("24bit")) return 24;
  return 4;
}

/**
 * Classify a COLORFGBG value like "15;0" (fg;bg). By rxvt convention the last
 * field is the background color index: 0-6 and 8 are dark, 7 and 9-15 light.
 */
export function backgroundFromColorFgBg(value) {
  if (!value) return null;
  const parts = String(value).split(";");
  const bg = Number(parts[parts.length - 1]);
  if (!Number.isInteger(bg) || bg < 0 || bg > 255) return null;
  return bg === 7 || bg >= 9 ? "light" : "dark";
}

/**
 * Classify an OSC 11 response like `\x1b]11;rgb:0b0b/0e0e/1414\x07`.
 * Channels may be 1-4 hex digits per the XParseColor spec.
 */
export function backgroundFromOscResponse(text) {
  const match = /\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(String(text || ""));
  if (!match) return null;
  const channel = (hex) => parseInt(hex, 16) / (16 ** hex.length - 1);
  const [r, g, b] = [match[1], match[2], match[3]].map(channel);
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luma > 0.5 ? "light" : "dark";
}

/**
 * Ask the terminal for its background color. Resolves "dark" | "light".
 * Never rejects; any failure falls back to COLORFGBG, then dark.
 */
export function detectBackground({
  env = process.env,
  stdin = process.stdin,
  stderr = process.stderr,
  timeoutMs = 50,
} = {}) {
  const fallback = backgroundFromColorFgBg(env.COLORFGBG) || "dark";

  if (!stdin.isTTY || typeof stdin.setRawMode !== "function" || !stderr.isTTY) {
    return Promise.resolve(fallback);
  }

  return new Promise((resolve) => {
    let settled = false;
    let response = "";
    const wasRaw = stdin.isRaw === true;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      try {
        if (!wasRaw) stdin.setRawMode(false);
        stdin.pause();
      } catch {
        // Terminal state restoration is best-effort.
      }
      resolve(value);
    };

    const onData = (chunk) => {
      response += chunk.toString("utf8");
      const parsed = backgroundFromOscResponse(response);
      if (parsed) finish(parsed);
      // A terminator without a parseable color means the terminal answered
      // something we do not understand - stop waiting.
      else if (response.includes("\x07") || response.includes("\x1b\\")) finish(fallback);
    };

    const timer = setTimeout(() => finish(fallback), timeoutMs);

    try {
      stdin.setRawMode(true);
      stdin.on("data", onData);
      stdin.resume();
      stderr.write("\x1b]11;?\x07");
    } catch {
      finish(fallback);
    }
  });
}
