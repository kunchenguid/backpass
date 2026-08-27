/**
 * The live progress view controller: owns the stderr repaint region during the
 * default run, reduces pipeline progress events into render state, and tears
 * itself down into today's plain line output.
 *
 * Contract (approved design, section "behavior"):
 *  - stderr only; stdout and --json are untouched
 *  - eligibility-gated: no TTY, NO_COLOR, CI, --quiet, --json, or a terminal
 *    narrower than 60 columns means the TUI never starts and nothing changes
 *  - while active, logger progress lines are buffered and replayed verbatim on
 *    teardown, so scrollback ends up exactly as it does without the TUI
 *  - all motion stops and the region is erased the moment the run ends
 */

import { DEFAULT_MAX_EDITS } from "../proposal.js";
import { clearProgressSink, setProgressSink } from "../progress.js";
import { setLoggerSink } from "../logger.js";
import { colorDepth, detectBackground, tuiEligible } from "./term.js";
import { makeTheme } from "./theme.js";
import { SPINNER_INTERVAL_MS, renderFrame, spinnerFrame } from "./render.js";

/**
 * Start the live view for one run. Returns null when the terminal is not
 * eligible - callers treat that as "no TUI" and change nothing.
 */
export async function startTui(ctx, { stderr = process.stderr } = {}) {
  if (!tuiEligible({ stderr, quiet: Boolean(ctx.flags.quiet), json: Boolean(ctx.flags.json) })) return null;

  const depth = colorDepth({ stderr });
  const preference = ctx.config.theme || "auto";
  const background = preference === "auto" ? await detectBackground({ stderr }) : preference;
  const theme = makeTheme({ depth, background });

  const tui = new Tui({
    theme,
    stderr,
    meta: {
      version: ctx.version,
      repoName: ctx.repo.name,
      worktrees: ctx.repo.worktrees?.length || 1,
      since: ctx.config.discovery.since,
      maxEdits: ctx.config.maxEditsPerRun ?? DEFAULT_MAX_EDITS,
    },
  });
  tui.start();
  return tui;
}

export function initialState(meta) {
  return {
    meta,
    memory: null,
    discover: {
      status: "pending",
      startedAt: null,
      endedAt: null,
      order: [],
      harnesses: {},
      totalMatched: 0,
      storesOk: 0,
      storesTotal: 0,
      files: 0,
      newFiles: 0,
    },
    analyze: {
      status: "pending",
      startedAt: null,
      endedAt: null,
      total: 0,
      pending: 0,
      done: 0,
      ok: 0,
      skipped: 0,
      failed: 0,
      cached: 0,
      jobs: 0,
      agent: null,
      model: null,
      lanes: [],
      evidence: { positive: 0, negative: 0, gaps: 0 },
    },
    fold: {
      status: "pending",
      startedAt: null,
      endedAt: null,
      instructions: 0,
      clustersFound: 0,
      clustersKept: 0,
      minGapEvidence: 2,
    },
    synthesize: {
      status: "pending",
      startedAt: null,
      endedAt: null,
      agent: null,
      model: null,
      effort: null,
      attempt: 0,
      phase: "edit",
      changes: null,
      sessionName: null,
      gapClusters: 0,
      instructions: 0,
      suppressed: 0,
      violations: [],
      annotateCondition: null,
      edits: 0,
    },
  };
}

/** Reduce one progress event into the render state. Exported for tests. */
export function reduceEvent(state, event, data, now = Date.now()) {
  const { discover: d, analyze: a, fold: f, synthesize: s } = state;

  switch (event) {
    case "memory":
      state.memory = { path: data.path, tokens: data.tokens, budget: data.budget, units: data.units };
      break;

    case "discover:start":
      d.status = "active";
      d.startedAt = now;
      d.order = data.harnesses;
      d.storesTotal = data.harnesses.length;
      for (const harness of data.harnesses) {
        d.harnesses[harness] = {
          status: "pending",
          scanned: 0,
          total: 0,
          matched: 0,
          newCount: 0,
          tiers: {},
          error: null,
        };
      }
      break;
    case "discover:harness:start":
      d.harnesses[data.harness].status = "scanning";
      break;
    case "discover:harness:tick": {
      const h = d.harnesses[data.harness];
      h.scanned = data.scanned;
      h.total = data.total;
      h.matched = data.matched;
      d.totalMatched = Object.values(d.harnesses).reduce((sum, row) => sum + row.matched, 0);
      break;
    }
    case "discover:harness:done": {
      const h = d.harnesses[data.harness];
      if (data.error) {
        h.status = "error";
        h.error = data.error;
      } else {
        h.status = "done";
        h.scanned = data.scanned;
        h.matched = data.matched;
        h.newCount = Math.max(data.scanned - (data.cached || 0), 0);
        h.self = data.self || 0;
        h.tiers = data.tiers || {};
        d.storesOk += 1;
        d.files += data.scanned;
        d.newFiles += h.newCount;
      }
      d.totalMatched = Object.values(d.harnesses).reduce((sum, row) => sum + row.matched, 0);
      break;
    }
    case "discover:done":
      d.status = "done";
      d.endedAt = now;
      d.totalMatched = data.total;
      break;

    case "analyze:start":
      a.status = "active";
      a.startedAt = now;
      a.total = data.total;
      a.pending = data.pending;
      a.cached = data.cached;
      a.jobs = data.jobs;
      a.agent = data.agent;
      a.model = data.model;
      a.lanes = new Array(Math.max(Math.min(data.jobs, data.pending), 0)).fill(null);
      break;
    case "analyze:lane": {
      const existing = a.lanes[data.slot] || { startedAt: now };
      a.lanes[data.slot] = { ...existing, ...data, startedAt: data.phase === "distill" ? now : existing.startedAt };
      break;
    }
    case "analyze:tick":
      a.done = data.done;
      a.ok = data.ok;
      a.skipped = data.skipped;
      a.failed = data.failed;
      a.lanes[data.slot] = null;
      break;
    case "analyze:evidence":
      a.evidence = { positive: data.positive, negative: data.negative, gaps: data.gaps };
      break;
    case "analyze:done":
      a.status = "done";
      a.endedAt = now;
      a.ok = data.analyzed;
      a.cached = data.cached;
      a.skipped = data.skipped;
      a.failed = data.failed;
      a.lanes = [];
      break;

    case "fold:done":
      f.status = "done";
      f.startedAt = now - (data.ms || 0);
      f.endedAt = now;
      f.instructions = data.instructions;
      f.clustersFound = data.clustersFound;
      f.clustersKept = data.clustersKept;
      f.minGapEvidence = data.minGapEvidence;
      break;

    case "synth:start":
      s.status = "active";
      s.startedAt = now;
      s.agent = data.agent;
      s.model = data.model;
      s.effort = data.effort;
      s.attempt = data.attempt;
      s.phase = data.phase || "edit";
      s.changes = data.changes ?? null;
      if (data.maxEdits) state.meta.maxEdits = data.maxEdits;
      s.sessionName = data.sessionName;
      s.gapClusters = data.gapClusters;
      s.instructions = data.instructions;
      s.suppressed = data.suppressed;
      break;
    case "synth:violations":
      s.violations = data.violations || [];
      s.annotateCondition = null;
      break;
    // Neither of these is a rejected answer, so neither clears into the violations list:
    // the files moved under the ids, or the harness said nothing at all.
    case "synth:remeasure":
      s.annotateCondition = "remeasure";
      s.violations = [];
      break;
    case "synth:empty":
      s.annotateCondition = "empty";
      s.violations = [];
      break;
    case "synth:done":
      s.status = "done";
      s.endedAt = now;
      s.edits = data.edits;
      break;
  }
  return state;
}

const PAINT_THROTTLE_MS = 40;

class Tui {
  constructor({ theme, stderr, meta }) {
    this.theme = theme;
    this.stderr = stderr;
    this.state = initialState(meta);
    this.buffered = [];
    this.painted = 0;
    this.lastPaint = 0;
    this.stopped = false;
    this.timer = null;
    this.onEvent = this.onEvent.bind(this);
    this.onResize = () => this.paint(true);
    this.onSigint = () => {
      this.stop();
      process.exit(130);
    };
    this.onSigterm = () => {
      this.stop();
      process.exit(143);
    };
    this.onExit = () => {
      if (!this.stopped) this.stderr.write("\x1b[?25h");
    };
  }

  start() {
    setProgressSink(this.onEvent);
    // Progress lines keep being produced for scrollback; they are buffered here
    // and replayed verbatim on teardown so the collapsed output is identical to
    // a run without the TUI.
    setLoggerSink((line) => this.buffered.push(line));
    this.stderr.write("\x1b[?25l");
    this.timer = setInterval(() => this.paint(), SPINNER_INTERVAL_MS);
    this.stderr.on("resize", this.onResize);
    process.on("SIGINT", this.onSigint);
    process.on("SIGTERM", this.onSigterm);
    process.once("exit", this.onExit);
    this.paint(true);
  }

  onEvent(event, data) {
    reduceEvent(this.state, event, data);
    this.paint();
  }

  paint(force = false) {
    if (this.stopped) return;
    const now = Date.now();
    if (!force && now - this.lastPaint < PAINT_THROTTLE_MS) return;
    this.lastPaint = now;

    const lines = renderFrame(this.state, {
      width: this.stderr.columns || 80,
      theme: this.theme,
      now,
      spin: spinnerFrame(now),
    });

    let out = "\x1b[?2026h";
    if (this.painted > 0) out += `\x1b[${this.painted}A`;
    out += "\r";
    for (const line of lines) out += `\x1b[2K${line}\n`;
    if (this.painted > lines.length) out += "\x1b[0J";
    out += "\x1b[?2026l";
    this.stderr.write(out);
    this.painted = lines.length;
  }

  /** Idempotent teardown: erase the region, restore the cursor, replay buffered lines. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    clearProgressSink();
    setLoggerSink(null);
    this.stderr.off("resize", this.onResize);
    process.off("SIGINT", this.onSigint);
    process.off("SIGTERM", this.onSigterm);

    let out = "";
    if (this.painted > 0) out += `\x1b[${this.painted}A\r\x1b[0J`;
    out += "\x1b[?25h";
    this.stderr.write(out);
    this.painted = 0;

    for (const line of this.buffered) this.stderr.write(`${line}\n`);
    this.buffered = [];
  }
}
