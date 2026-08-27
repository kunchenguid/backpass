/**
 * Pure rendering for the live progress view: (state, options) -> lines.
 *
 * Everything here is deterministic - no timers, no terminal, no I/O - which is
 * what makes the layout testable as plain text (depth-0 theme). The visual
 * contract is the captain-approved mock: prompt echo is the shell's, then a
 * bordered run header with the budget gauge, a four-stage rail, one detail
 * panel for the stage currently spending time, and a hint footer.
 *
 * Layout rules from the approved behavior contract:
 *  - never wider than the terminal (lines are truncated, never wrapped)
 *  - below NARROW_COLUMNS the right-hand column (timers, notes) is dropped
 *  - every number shown is measured by backpass, never model-reported
 */

import { NARROW_COLUMNS } from "./term.js";

export const SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
export const SPINNER_INTERVAL_MS = 80;

/** The frame glyph for a wall-clock instant - even cadence however paints are driven. */
export function spinnerFrame(now) {
  return SPINNER_FRAMES[Math.floor(now / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];
}

const MAX_WIDTH = 110;

const HARNESS_HUES = {
  claude: "peach",
  codex: "green",
  pi: "purple",
  opencode: "mint",
  grok: "magenta",
  cursor: "blue",
  "cursor-ide": "blue",
  hermes: "yellow",
};

/**
 * Display names for the four pipeline stages, in the tool's training-loop vocabulary.
 * Internal stage keys and event names stay as they are; only what the user reads changes.
 */
export const STAGE_LABELS = {
  discover: "collect samples",
  analyze: "calculate loss",
  fold: "aggregate gradients",
  synthesize: "gradient descent",
};
const STAGE_LABEL_WIDTH = Math.max(...Object.values(STAGE_LABELS).map((label) => label.length)) + 1;

const TIER_LABELS = { 1: "ran in this repo", 2: "git remote match", 3: "path match (best-effort)" };

// eslint-disable-next-line no-control-regex -- matching ANSI SGR escapes is the point
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text) {
  return String(text).replace(ANSI_PATTERN, "");
}

export function visibleWidth(text) {
  return [...stripAnsi(text)].length;
}

/** Truncate a painted line to `width` visible cells, preserving escapes and reset. */
export function clipLine(line, width) {
  if (visibleWidth(line) <= width) return line;
  let out = "";
  let used = 0;
  let sawEscape = false;
  // eslint-disable-next-line no-control-regex -- splitting on ANSI SGR escapes is the point
  const parts = String(line).split(/(\x1b\[[0-9;]*m)/);
  for (const part of parts) {
    if (part.startsWith("\x1b[")) {
      out += part;
      sawEscape = true;
      continue;
    }
    for (const ch of part) {
      if (used >= width - 1) return sawEscape ? `${out}\x1b[0m…` : `${out}…`;
      out += ch;
      used += 1;
    }
  }
  return out;
}

/** Pad a plain string to `width` characters; longer strings get an ellipsis. */
export function fitPlain(text, width, align = "left") {
  const chars = [...String(text)];
  if (chars.length > width) return width > 0 ? `${chars.slice(0, Math.max(width - 1, 0)).join("")}…` : "";
  const pad = " ".repeat(width - chars.length);
  return align === "right" ? pad + chars.join("") : chars.join("") + pad;
}

/** Pad an already painted string to `width` visible cells. */
export function padVis(text, width, align = "left") {
  const missing = width - visibleWidth(text);
  if (missing <= 0) return text;
  const pad = " ".repeat(missing);
  return align === "right" ? pad + text : text + pad;
}

/** Left content with right-aligned content; the right side is dropped when it cannot fit. */
export function lr(left, right, width) {
  if (!right) return left;
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap < 2) return left;
  return left + " ".repeat(gap) + right;
}

export function formatCount(n) {
  return Number(n || 0).toLocaleString("en-US");
}

export function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** m:ss for anything from a second up; bare milliseconds below that (aggregating gradients is instant). */
export function formatElapsed(ms) {
  const value = Math.max(0, Math.round(Number(ms) || 0));
  if (value < 1000) return `${value}ms`;
  const seconds = Math.floor(value / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** ▰▱ progress cells; the gradient marks descent, `!!` marks over-budget (as budgetBar does). */
export function gaugeBar(theme, ratio, cells) {
  const value = Number.isFinite(ratio) ? Math.max(ratio, 0) : 0;
  const over = value > 1;
  const filled = Math.min(cells, Math.round(value * cells));
  const overflow = over ? Math.min(cells - Math.min(filled, cells - 2), 2) : 0;
  const solid = over ? cells - overflow : filled;
  const empty = Math.max(cells - solid - overflow, 0);
  return (
    theme.gradient("▰".repeat(solid)) +
    (overflow ? theme.paint("!".repeat(overflow), "red", { bold: true }) : "") +
    theme.paint("▱".repeat(empty), "faint")
  );
}

function stageElapsed(stage, now) {
  if (!stage?.startedAt) return null;
  return formatElapsed((stage.endedAt || now) - stage.startedAt);
}

function tierLabel(tiers = {}) {
  let best = null;
  for (const tier of [1, 2, 3]) {
    if ((tiers[tier] || 0) > (tiers[best] || 0)) best = tier;
  }
  return best ? TIER_LABELS[best] : "";
}

function headerLines(state, theme, width, spin) {
  const inner = width - 4;
  const border = (text) => theme.paint(text, "faint");
  const lines = [border(`╭${"─".repeat(width - 2)}╮`)];

  const brand = `${theme.gradient("∇", { bold: true })} ${theme.paint("backpass", "text", { bold: true })} ${theme.paint(`v${state.meta.version}`, "faint")}`;
  const contextParts = [state.meta.repoName];
  if (state.meta.worktrees > 1) contextParts.push(`${state.meta.worktrees} worktrees`);
  contextParts.push(`since ${state.meta.since}`);
  lines.push(wrapBox(lr(brand, theme.paint(contextParts.join(" · "), "dim"), inner), inner, border));

  const memory = state.memory;
  if (memory) {
    const ratio = memory.tokens / memory.budget;
    const cells = state.narrow ? 16 : 24;
    const over = memory.tokens > memory.budget;
    const left =
      `${theme.paint(memory.path, "dim")}  ${gaugeBar(theme, ratio, cells)}  ` +
      `${theme.paint(formatCount(memory.tokens), over ? "red" : "mint")} ${theme.paint("/", "faint")} ${theme.paint(`${formatCount(memory.budget)} tok`, "text")}`;
    const right = over
      ? `${theme.paint("OVER", "red", { bold: true })}${theme.paint(" · shrink plan", "faint")}`
      : theme.paint(`${formatCount(memory.units)} instructions · budget ${Math.round(ratio * 100)}%`, "faint");
    lines.push(wrapBox(lr(left, right, inner), inner, border));
  } else {
    lines.push(wrapBox(theme.paint(`reading memory file${spin ? "…" : ""}`, "faint"), inner, border));
  }

  lines.push(border(`╰${"─".repeat(width - 2)}╯`));
  return lines;
}

function wrapBox(content, inner, border) {
  return `${border("│")} ${padVis(clipLine(content, inner), inner)} ${border("│")}`;
}

function mark(theme, status, spin) {
  if (status === "active") return theme.paint(spin, "mint");
  if (status === "done") return theme.paint("✓", "mint");
  if (status === "error") return theme.paint("!", "yellow");
  return theme.paint("○", "faint");
}

function railLine(theme, state, key, summary, stage, width, spin) {
  const status = stage?.status || "pending";
  const name = fitPlain(STAGE_LABELS[key], STAGE_LABEL_WIDTH);
  const label =
    status === "pending" ? theme.paint(name, "faint") : theme.paint(name, "text", { bold: status === "active" });
  const left = ` ${mark(theme, status, spin)} ${label}${summary || ""}`;
  const elapsed = state.narrow ? null : stageElapsed(stage, state.now);
  return lr(left, elapsed ? theme.paint(elapsed, "faint") : null, width);
}

function discoverSummary(theme, d) {
  if (!d || d.status === "pending") return "";
  if (d.status === "active") {
    return theme.paint(
      `scanning ${d.storesTotal} local stores · ${formatCount(d.totalMatched)} sessions from this repo so far`,
      "dim",
    );
  }
  const parts = [`${formatCount(d.totalMatched)} sessions from this repo`, `${d.storesOk}/${d.storesTotal} stores`];
  if (d.files) parts.push(`${formatCount(d.files)} files, ${formatCount(d.newFiles)} new`);
  return theme.paint(parts.join(" · "), "dim");
}

function analyzeSummary(theme, a, narrow) {
  if (!a || a.status === "pending") return "";
  if (a.status === "active") {
    const bar = gaugeBar(theme, a.pending ? a.done / a.pending : 1, narrow ? 10 : 14);
    return `${bar} ${theme.paint(`${a.done}/${a.pending}`, "text", { bold: true })} ${theme.paint(
      `· ${a.cached} already analyzed · jobs ${a.jobs}`,
      "dim",
    )}`;
  }
  return theme.paint(`${a.ok} ok · ${a.skipped} skipped · ${a.failed} failed · ${a.cached} reused`, "dim");
}

function foldSummary(theme, f) {
  if (!f || f.status !== "done") return "";
  return (
    theme.paint(`${f.instructions} instructions scored · ${f.clustersFound} gaps → `, "dim") +
    theme.paint(`${f.clustersKept} clusters kept`, "text") +
    theme.paint(` (seen in ≥${f.minGapEvidence} sessions)`, "faint")
  );
}

function synthSummary(theme, s) {
  if (!s || s.status === "pending") return "";
  const model = [s.agent, s.model].filter(Boolean).join(" · ");
  const effort = s.effort ? ` · effort ${s.effort}` : "";
  if (s.status === "done") return theme.paint(`${s.edits} edit(s) · passed validation`, "dim");
  if (s.phase === "annotate" && s.annotateCondition === "empty") {
    return theme.paint("fresh session after an empty turn · ", "dim") + theme.paint(`${model}${effort}`, "dim");
  }
  if (s.phase === "annotate" && s.attempt > 1) {
    return (
      theme.paint("re-prompt ", "dim") +
      theme.paint(`${s.attempt - 1}`, "yellow") +
      theme.paint(` · ${model}${effort}`, "dim")
    );
  }
  const phase = s.phase === "annotate" ? "annotating" : "editing";
  return theme.paint(`${phase} · ${model}${effort}`, "dim");
}

function sectionRule(theme, name, description, width) {
  const left = `${theme.paint("──", "faint")} ${theme.paint(name, "text", { bold: true })}${theme.paint(` · ${description} `, "faint")}`;
  const remaining = width - visibleWidth(left);
  return left + theme.paint("─".repeat(Math.max(remaining, 0)), "faint");
}

function harnessDot(theme, harness) {
  return theme.paint("●", HARNESS_HUES[harness] || "blue");
}

function discoverDetail(state, theme, width, spin) {
  const d = state.discover;
  const lines = [sectionRule(theme, STAGE_LABELS.discover, "local stores only · nothing leaves this machine", width)];
  const countWidth = 15;
  const howWidth = 25;
  const activityWidth = width - 2 - 2 - 11 - countWidth - (state.narrow ? 0 : howWidth) - 4;

  for (const harness of d.order) {
    const h = d.harnesses[harness];
    const dot = harnessDot(theme, harness);
    const name = theme.paint(fitPlain(harness, 10), "text");

    let activity;
    let count;
    let how = theme.paint(fitPlain(tierLabel(h.tiers), howWidth, "right"), "faint");
    if (h.status === "error") {
      activity = theme.paint(fitPlain("store unreadable · harness skipped, run continues", activityWidth), "yellow");
      count = theme.paint(fitPlain("–", countWidth, "right"), "faint");
      how = theme.paint(fitPlain("fail-soft", howWidth, "right"), "faint");
    } else if (h.status === "scanning") {
      const showBar = (h.total || 0) >= 500;
      const text = showBar
        ? `${formatCount(h.scanned)}/${formatCount(h.total)} sessions`
        : `${formatCount(h.scanned)} sessions`;
      const bar = showBar ? `${gaugeBar(theme, h.total ? h.scanned / h.total : 0, state.narrow ? 8 : 10)} ` : "";
      activity = bar + theme.paint(fitPlain(text, activityWidth - (showBar ? (state.narrow ? 9 : 11) : 0)), "dim");
      count = padVis(
        `${theme.paint(formatCount(h.matched), "text", { bold: true })} ${theme.paint("so far", "faint")}`,
        countWidth,
        "right",
      );
    } else {
      const scanned = `${formatCount(h.scanned)} sessions`;
      const fresh = h.newCount > 0 || h.scanned > 0 ? ` · ${formatCount(h.newCount)} new` : "";
      const self = h.self > 0 ? ` · ${formatCount(h.self)} self` : "";
      const query = harness === "opencode" || harness === "hermes" ? "1 sqlite query" : `${scanned}${fresh}${self}`;
      activity = theme.paint(fitPlain(query, activityWidth), "dim");
      count = padVis(
        `${theme.paint(formatCount(h.matched), "text", { bold: true })} ${theme.paint("this repo", "faint")}`,
        countWidth,
        "right",
      );
    }

    const glyph =
      h.status === "scanning" ? theme.paint(spin, "mint") : mark(theme, h.status === "error" ? "error" : "done", spin);
    const row = ` ${glyph} ${dot} ${name}${activity}${count}${state.narrow ? "" : how}`;
    lines.push(row);
  }

  lines.push("");
  lines.push(theme.paint("new = not seen by a previous scan · re-scans only read new or changed files", "faint"));
  return lines;
}

/** Outcome counters with parentheticals that shrink until the line fits. */
function countersLine(a, theme, width) {
  const build = (skippedNote, failedNote, reusedNote) =>
    ` ${theme.paint(String(a.ok), "mint")} ${theme.paint("ok", "dim")} ${theme.paint("·", "faint")} ` +
    `${theme.paint(String(a.skipped), "text")} ${theme.paint("skipped", "dim")}${skippedNote ? ` ${theme.paint(skippedNote, "faint")}` : ""} ${theme.paint("·", "faint")} ` +
    `${theme.paint(String(a.failed), "yellow")} ${theme.paint("failed", "dim")}${failedNote ? ` ${theme.paint(failedNote, "faint")}` : ""} ${theme.paint("·", "faint")} ` +
    `${theme.paint(String(a.cached), "blue")} ${theme.paint("reused", "dim")}${reusedNote ? ` ${theme.paint(reusedNote, "faint")}` : ""}`;

  const variants = [
    build("(trivial session)", "(will retry)", "(analyzed in an earlier run)"),
    build("(trivial)", "(will retry)", "(earlier run)"),
    build(null, null, null),
  ];
  return variants.find((line) => visibleWidth(line) <= width) || variants[variants.length - 1];
}

function analyzeDetail(state, theme, width, spin) {
  const a = state.analyze;
  const model = [a.agent, a.model].filter(Boolean).join(" · ");
  const lines = [sectionRule(theme, STAGE_LABELS.analyze, `one cheap call per transcript · ${model}`, width)];

  const receiptWidth = 27;
  const timeWidth = 6;
  const titleWidth = Math.max(width - 2 - 2 - 2 - 11 - receiptWidth - (state.narrow ? 0 : timeWidth) - 7, 10);

  a.lanes.forEach((lane, index) => {
    if (!lane) return;
    const receipt =
      lane.phase === "model"
        ? padVis(
            `${theme.paint("distilled", "faint")} ${theme.paint(formatBytes(lane.rawBytes), "dim")} ${theme.paint("▸", "faint")} ${theme.paint(formatBytes(lane.distilledBytes), "dim")}`,
            receiptWidth,
            "right",
          )
        : theme.paint(fitPlain("distilling…", receiptWidth, "right"), "faint");
    const elapsed = state.narrow
      ? ""
      : theme.paint(fitPlain(formatElapsed(state.now - lane.startedAt), timeWidth, "right"), "faint");
    lines.push(
      ` ${theme.paint(spin, "mint")} ${theme.paint(String(index + 1), "faint")} ${harnessDot(theme, lane.harness)} ` +
        `${theme.paint(fitPlain(lane.harness, 9), "text")} ` +
        `${theme.paint(fitPlain(lane.title, titleWidth), "dim")} ${receipt}${elapsed}`,
    );
  });

  lines.push("");
  lines.push(countersLine(a, theme, width));
  lines.push(
    ` ${theme.paint("evidence so far", "dim")}   ${theme.paint(`✓ ${a.evidence.positive}`, "mint")} ${theme.paint("helped", "faint")}` +
      `   ${theme.paint(`✗ ${a.evidence.negative}`, "red")} ${theme.paint("violated", "faint")}` +
      `   ${theme.paint(`◆ ${a.evidence.gaps}`, "yellow")} ${theme.paint("gaps", "faint")}`,
  );
  return lines;
}

function synthesizeDetail(state, theme, width, spin) {
  const s = state.synthesize;
  const lines = [
    sectionRule(theme, STAGE_LABELS.synthesize, `aggregated gradients → at most ${state.meta.maxEdits} edits`, width),
  ];

  // A re-measurement and an empty turn are named for what they are: neither spent one of
  // the annotation attempts, and saying "violated 1 gate(s)" for either is how a run gets
  // read as almost-passing when nothing was judged at all.
  if (s.phase === "annotate" && s.annotateCondition === "remeasure") {
    lines.push(
      ` ${theme.paint("~", "yellow")} ${theme.paint("the files moved; re-annotating the new ids", "text")} ${theme.paint("· no annotation attempt spent", "dim")}`,
    );
  }
  if (s.phase === "annotate" && s.annotateCondition === "empty") {
    lines.push(
      ` ${theme.paint("~", "yellow")} ${theme.paint("the harness returned an empty turn", "text")} ${theme.paint("· retrying in a fresh session", "dim")}`,
    );
  }
  if (s.phase === "annotate" && s.attempt > 1 && s.violations.length) {
    lines.push(
      ` ${theme.paint("!", "yellow")} ${theme.paint(`synthesis violated ${s.violations.length} gate(s)`, "text")} ${theme.paint("· re-prompting with the exact breaches", "dim")}`,
    );
    for (const violation of s.violations.slice(0, 4)) {
      lines.push(`    ${theme.paint("✗", "red")} ${theme.paint(clipPlain(violation, width - 8), "dim")}`);
    }
  }

  const doing =
    s.phase === "annotate"
      ? `annotating ${s.changes ?? 0} measured change(s) with evidence…`
      : `weighing ${s.gapClusters} gap clusters + ${s.instructions} instruction records against the budget…`;
  lines.push(
    lr(
      ` ${theme.paint(spin, "mint")} ${doing}`,
      state.narrow || !s.sessionName ? null : theme.paint(`session ${s.sessionName}`, "faint"),
      width,
    ),
  );

  if (s.suppressed > 0) {
    lines.push("");
    lines.push(
      theme.paint(
        `${s.suppressed} previously rejected edit(s) suppressed · re-proposed only on materially new evidence`,
        "faint",
      ),
    );
  }
  return lines;
}

function clipPlain(text, width) {
  return fitPlain(String(text), width).trimEnd();
}

/** The active detail panel: the stage currently spending time, else the latest one. */
function activePanel(state) {
  if (state.synthesize.status === "active") return "synthesize";
  if (state.analyze.status === "active") return "analyze";
  if (state.discover.status === "active") return "discover";
  if (state.synthesize.status === "done") return "synthesize";
  if (state.analyze.status === "done") return "analyze";
  if (state.discover.status === "done") return "discover";
  return null;
}

/**
 * Render one frame. `state` is the controller's reduced event state; options
 * carry the terminal width, theme, wall-clock, and current spinner glyph.
 */
export function renderFrame(state, { width, theme, now, spin }) {
  const cols = Math.max(Math.min(width || 80, MAX_WIDTH), 40);
  const frameState = { ...state, now, narrow: (width || 80) < NARROW_COLUMNS };

  const lines = [];
  lines.push(...headerLines(frameState, theme, cols, spin));

  lines.push(
    railLine(
      theme,
      frameState,
      "discover",
      discoverSummary(theme, frameState.discover),
      frameState.discover,
      cols,
      spin,
    ),
  );
  lines.push(
    railLine(
      theme,
      frameState,
      "analyze",
      analyzeSummary(theme, frameState.analyze, frameState.narrow),
      frameState.analyze,
      cols,
      spin,
    ),
  );
  lines.push(railLine(theme, frameState, "fold", foldSummary(theme, frameState.fold), frameState.fold, cols, spin));
  lines.push(
    railLine(
      theme,
      frameState,
      "synthesize",
      synthSummary(theme, frameState.synthesize),
      frameState.synthesize,
      cols,
      spin,
    ),
  );
  lines.push("");

  const panel = activePanel(frameState);
  if (panel === "discover") lines.push(...discoverDetail(frameState, theme, cols, spin));
  if (panel === "analyze") lines.push(...analyzeDetail(frameState, theme, cols, spin));
  if (panel === "synthesize") lines.push(...synthesizeDetail(frameState, theme, cols, spin));

  return lines.map((line) => clipLine(line, cols).trimEnd());
}
