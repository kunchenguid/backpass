/**
 * Progress event bus between the pipeline and the live progress view.
 *
 * Pipeline stages emit structured events through `emitProgress`; they are dropped
 * unless a renderer registered a sink. This keeps every stage free of rendering
 * concerns and guarantees that runs without a TTY behave exactly as before -
 * the events simply go nowhere.
 */

let sink = null;

/** Register the single active sink (the TUI controller). */
export function setProgressSink(fn) {
  sink = fn;
}

export function clearProgressSink() {
  sink = null;
}

/** Emit one progress event. A throwing sink must never break the pipeline. */
export function emitProgress(event, data = {}) {
  if (!sink) return;
  try {
    sink(event, data);
  } catch {
    // Rendering is best-effort; the run itself is what matters.
  }
}
