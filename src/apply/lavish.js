import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { UserError, color, info, warn } from "../logger.js";

/**
 * The apply surface (captain decision 4).
 *
 * A static HTML template ships in the package. The CLI injects exactly one JSON payload
 * as `window.__BACKPASS_PROPOSAL__` and serves the result through `lavish-axi`, so the
 * review surface is instant, deterministic, and identical every run - no model
 * regenerates it. Decisions come back as one structured vector through `lavish-axi poll`.
 */

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "templates", "apply.html");

export const LAVISH_BIN = process.env.BACKPASS_LAVISH_BIN || "lavish-axi";

/** Inline a JSON payload safely: `</script>` inside data must not close the tag. */
export function injectPayload(template, payload, toolVersion) {
  const json = JSON.stringify({ ...payload, toolVersion })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const tag = `<script>window.__BACKPASS_PROPOSAL__ = ${json};</script>`;
  if (!template.includes("</head>")) return `${tag}\n${template}`;
  // A function replacer, not a string one: a string second argument to `replace` treats
  // `$&`, `` $` ``, `$'`, and `$$` in it as replacement patterns, and `tag` embeds
  // untrusted proposal text that can contain any of those sequences verbatim.
  return template.replace("</head>", () => `${tag}\n</head>`);
}

export function renderApplySurface(proposal, state, toolVersion) {
  if (!fs.existsSync(TEMPLATE)) {
    throw new UserError(`apply template missing at ${TEMPLATE}`, "reinstall backpass");
  }
  const html = injectPayload(fs.readFileSync(TEMPLATE, "utf8"), proposal, toolVersion);
  const target = path.join(state.applyDir, "apply.html");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, html);
  return target;
}

function runLavish(args, { inherit = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(LAVISH_BIN, args, { stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    if (!inherit) {
      child.stdout.on("data", (d) => {
        stdout += d;
      });
      child.stderr.on("data", (d) => {
        stderr += d;
      });
    }
    child.on("error", (err) => resolve({ code: null, stdout, stderr, spawnError: err }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Parse the decision vector the surface queues back:
 *   `BACKPASS_DECISIONS e1=accepted e2=rejected e3=accepted`
 * Parsing is tolerant because the text travels through a human-facing comment box.
 */
export function parseDecisions(text, editIds) {
  const decisions = {};
  const pattern = /\b(e\d+)\s*=\s*(accepted|rejected|accept|reject)\b/gi;
  let match = pattern.exec(text || "");
  while (match) {
    const id = match[1].toLowerCase();
    if (editIds.includes(id)) {
      decisions[id] = match[2].toLowerCase().startsWith("accept") ? "accepted" : "rejected";
    }
    match = pattern.exec(text || "");
  }
  return Object.keys(decisions).length ? decisions : null;
}

export async function openApplySurface(file) {
  // `backpass apply` is itself the human asking for the review surface, so a session the
  // reviewer ended from the browser in an earlier run has to be reopened, not refused.
  // lavish-axi keys sessions by file path and `ended_by: "user"` is sticky, so without
  // `--reopen` it exits 0 and prints the dead session's URL - which apply would then hand
  // the reviewer as if it were live. On a live or agent-ended session the flag is a no-op.
  const result = await runLavish([file, "--reopen", "--no-open"]);
  if (result.spawnError && result.spawnError.code === "ENOENT") {
    throw new UserError(
      `${LAVISH_BIN} not found on PATH`,
      "install lavish-axi, or run `backpass apply --no-ui` for the terminal fallback",
    );
  }
  if (result.code !== 0) {
    throw new UserError(`${LAVISH_BIN} failed to open the apply surface`, result.stderr.trim().slice(0, 400));
  }
  return extractUrl(`${result.stdout}\n${result.stderr}`);
}

/**
 * Pull the session URL out of lavish-axi's output. The CLI prints it YAML-style as
 * `url: "http://..."`, so a bare `\S+` would swallow the closing quote; stop at any
 * quote or bracket and drop trailing punctuation.
 */
export function extractUrl(text) {
  const match = /https?:\/\/[^\s"'<>()[\]]+/.exec(text || "");
  if (!match) return null;
  return match[0].replace(/[.,;:!?]+$/, "");
}

/** Breathing room between polls that came back without a decision vector. */
export const POLL_RETRY_DELAY_MS = 1000;

/**
 * Long-poll for the human's decision vector. `lavish-axi poll` blocks until the reviewer
 * sends feedback, so this is intentionally a foreground wait.
 *
 * Feedback that is not a decision vector (a comment, a queued layout report) keeps the
 * wait going. Each state is announced once: the wait line on entry, and a single note the
 * first time non-decision feedback arrives - never one line per poll cycle, which on a
 * chatty surface floods the terminal.
 */
export async function pollDecisions(file, editIds, { delayMs = POLL_RETRY_DELAY_MS } = {}) {
  info(
    `${color.dim("waiting for your decisions in the browser (Ctrl-C to abort; nothing is written until you send)")}`,
  );
  let notedOtherFeedback = false;

  for (;;) {
    const result = await runLavish(["poll", file]);
    if (result.spawnError) {
      throw new UserError(`${LAVISH_BIN} poll failed: ${result.spawnError.message}`);
    }
    const text = `${result.stdout}\n${result.stderr}`;
    if (result.code !== 0) {
      throw new UserError("lavish-axi poll exited unexpectedly", text.trim().slice(0, 400));
    }

    const decisions = parseDecisions(text, editIds);
    if (decisions) return decisions;

    // lavish-axi reports an end through the session fields, never in prose: `status: ended`
    // when nothing was queued, `session_ended: true` alongside the final `status: feedback`.
    // Scope these fields to the leading session metadata block so field-like feedback or
    // diagnostics cannot end the wait. parseDecisions has already run, so a `Send & End`
    // carrying a vector still applies.
    const session = /^session:\s*\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))*)/m.exec(text)?.[1] || "";
    if (/^\s*status:\s*ended\b/m.test(session) || /^\s*session_ended:\s*true\b/m.test(session)) {
      warn("review session ended without a decision vector - nothing applied");
      return null;
    }

    if (!notedOtherFeedback) {
      notedOtherFeedback = true;
      info(
        `${color.dim("feedback arrived without a decision vector - click APPLY in the browser and send from the panel; still waiting")}`,
      );
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

export async function closeApplySurface(file) {
  await runLavish(["end", file]);
}
