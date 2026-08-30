/**
 * Every discovered session is either interactive or non-interactive. There is no
 * unknown bucket on the public surface: a missing harness signal defaults to
 * interactive (human TTY sessions are what older stores recorded, and they are the
 * scarce signal a robot-heavy corpus would otherwise drown).
 *
 * Non-interactive is detected best-effort from per-harness metadata (codex
 * `originator: codex_exec` / `source: exec`, claude `entrypoint` values that start
 * with `sdk`, an OpenCode child `parent_id`, Hermes cron/gateway/whatsapp if they
 * ever leak past discovery) and from cwd (a `.no-mistakes` path segment - pipeline
 * worktrees are one kind of non-interactive run, not their own category).
 */

export const INTERACTIVE = "interactive";
export const NON_INTERACTIVE = "non-interactive";

const CODEX_NONINTERACTIVE_ORIGINATORS = new Set(["codex_exec"]);
const CODEX_NONINTERACTIVE_SOURCES = new Set(["exec"]);
const HERMES_NONINTERACTIVE_SOURCES = new Set(["cron", "gateway", "whatsapp"]);

export function emptyInteractionSignals() {
  return {};
}

export function interactionSignals(fields = {}) {
  const out = {};
  for (const key of ["originator", "source", "entrypoint", "parentId"]) {
    const value = fields[key];
    if (value != null && String(value).trim()) out[key] = String(value);
  }
  return out;
}

/** True when a cached classify/discover descriptor was written after interaction tagging. */
export function hasInteractionSignals(descriptor) {
  if (descriptor == null) return true;
  return Object.prototype.hasOwnProperty.call(descriptor, "interactionSignals");
}

export function pathLooksNonInteractive(cwd) {
  if (typeof cwd !== "string" || !cwd) return false;
  return cwd.replaceAll("\\", "/").split("/").includes(".no-mistakes");
}

function signalsOf(transcript) {
  return transcript?.interactionSignals || transcript?.extra?.interactionSignals || {};
}

function claudeEntrypointIsNonInteractive(entrypoint) {
  if (!entrypoint) return false;
  const value = String(entrypoint).toLowerCase();
  if (value === "cli") return false;
  if (value.startsWith("sdk")) return true;
  if (value.includes("github") || value.includes("action") || value === "ci") return true;
  return false;
}

/**
 * Map a discovered transcript (or adapter descriptor) onto the two public categories.
 * Explicit `transcript.interaction` is trusted when it is already one of the two labels.
 */
export function classifyInteraction(transcript) {
  const stamped = transcript?.interaction;
  if (stamped === INTERACTIVE || stamped === NON_INTERACTIVE) return stamped;

  const harness = transcript?.harness;
  const signals = signalsOf(transcript);
  const cwd = transcript?.cwd;

  if (harness === "codex") {
    const originator = String(signals.originator || "")
      .toLowerCase()
      .replaceAll("-", "_");
    const source = String(signals.source || "").toLowerCase();
    if (CODEX_NONINTERACTIVE_ORIGINATORS.has(originator) || CODEX_NONINTERACTIVE_SOURCES.has(source)) {
      return NON_INTERACTIVE;
    }
  }

  if (harness === "claude" && claudeEntrypointIsNonInteractive(signals.entrypoint)) {
    return NON_INTERACTIVE;
  }

  if (harness === "opencode" && signals.parentId) return NON_INTERACTIVE;

  if (harness === "hermes") {
    const source = String(signals.source || transcript?.extra?.source || "").toLowerCase();
    if (HERMES_NONINTERACTIVE_SOURCES.has(source)) return NON_INTERACTIVE;
  }

  if (pathLooksNonInteractive(cwd)) return NON_INTERACTIVE;

  return INTERACTIVE;
}

export function corpusMix(transcripts) {
  let interactive = 0;
  let nonInteractive = 0;
  for (const transcript of transcripts || []) {
    if (classifyInteraction(transcript) === NON_INTERACTIVE) nonInteractive += 1;
    else interactive += 1;
  }
  return { interactive, nonInteractive, total: interactive + nonInteractive };
}

export function formatCorpusMix(mix) {
  if (!mix) return "";
  return `interactive ${mix.interactive} · non-interactive ${mix.nonInteractive}`;
}

export function mixFromCounts(analyzedByInteraction, total) {
  if (!analyzedByInteraction) return null;
  const interactive = Number(analyzedByInteraction[INTERACTIVE]) || 0;
  const nonInteractive = Number(analyzedByInteraction[NON_INTERACTIVE]) || 0;
  return { interactive, nonInteractive, total: total ?? interactive + nonInteractive };
}
