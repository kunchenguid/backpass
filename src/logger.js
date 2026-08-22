const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stderr.isTTY;
const CSI = "\u001b[";

const wrap = (code) => (s) => (NO_COLOR ? String(s) : `${CSI}${code}m${s}${CSI}0m`);

export const color = {
  dim: wrap("2"),
  bold: wrap("1"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  cyan: wrap("36"),
};

let quiet = false;
let sink = null;

export function setQuiet(value) {
  quiet = Boolean(value);
}

/**
 * While the live progress view owns stderr, progress lines are diverted here,
 * buffered, and replayed verbatim on teardown - so scrollback after a TUI run
 * is byte-identical to a run without one. Pass null to restore direct output.
 */
export function setLoggerSink(fn) {
  sink = fn;
}

/** Human-facing progress and diagnostics go to stderr so stdout stays pipeable. */
export function info(...args) {
  if (quiet) return;
  if (sink) {
    sink(args.join(" "));
    return;
  }
  console.error(...args);
}

export function step(label, detail = "") {
  info(`${color.cyan("·")} ${label}${detail ? ` ${color.dim(detail)}` : ""}`);
}

export function warn(message) {
  const line = `${color.yellow("warn")} ${message}`;
  if (sink) {
    sink(line);
    return;
  }
  console.error(line);
}

export function fail(message) {
  console.error(`${color.red("error")} ${message}`);
}

/** Structured results go to stdout. */
export function out(text) {
  console.log(text);
}

export function json(value) {
  console.log(JSON.stringify(value, null, 2));
}

export class UserError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = "UserError";
    this.hint = hint;
  }
}
