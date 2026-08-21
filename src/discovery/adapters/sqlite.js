import fs from "node:fs";

/**
 * `node:sqlite` is still flagged experimental, so Node prints a warning on first use.
 * backpass opens several read-only stores; the warning is noise the user cannot act on,
 * so it is filtered here (and only here) rather than suppressed process-wide.
 */
let DatabaseSync = null;
let loadError = null;

function filterExperimentalWarning() {
  const listeners = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (w) => {
    if (w.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return;
    for (const listener of listeners) listener(w);
    if (!listeners.length) console.error(w.stack || String(w));
  });
}

async function loadDriver() {
  if (DatabaseSync || loadError) return;
  filterExperimentalWarning();
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (err) {
    loadError = err;
  }
}

/**
 * Open a SQLite file read-only. Returns null (never throws) when the store is missing,
 * locked, or the driver is unavailable - discovery is fail-soft per harness.
 */
export async function openReadOnly(file) {
  if (!fs.existsSync(file)) return null;
  await loadDriver();
  if (!DatabaseSync) {
    throw new Error(`node:sqlite unavailable (${loadError?.message || "unknown"}); Node >= 22.5 is required`);
  }
  return new DatabaseSync(file, { readOnly: true });
}

export function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
