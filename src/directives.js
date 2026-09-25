/**
 * Direct task and steering instructions as addressable instruction sources.
 *
 * Backpass indexes project memory files as instruction sources, but in real sessions
 * much of what governs agent behaviour comes straight from the user: the initial task
 * message and later steering turns. Without ids those read only as undifferentiated
 * transcript evidence, so analysis cannot say "the agent followed the user's direct
 * instruction" apart from "the agent followed the memory file". This module makes each
 * substantive user turn citable:
 *
 *   - the first user turn with a non-empty envelope is the task span (`TASK-1`)
 *   - each later user turn with a non-empty envelope is a steering span (`STEER-<turn>`)
 *   - every span carries source kind, turn, an authority tier distinct from project
 *     memory (`direct-task` / `direct-steering`), and a lifetime running from its turn
 *     onward
 *
 * Only the authoritative envelope of a user message becomes a span. Quoted transcripts
 * (`>` blockquotes), pasted tool output and code (fenced blocks), retry reasons and
 * planned actions embedded as quotes or pastes are structurally excluded: indexing
 * them as authority would invert instructions that say to treat that text as
 * untrusted evidence. Assistant messages and tool results never become spans.
 *
 * Spans are extracted from the distilled message turns, so turn numbers match the
 * trace the analysis model reads. Each turn carries the envelope `distill` carved from
 * its full pre-clamp text, so a closing fence lost to message clamping cannot demote an
 * instruction to a paste. The prompt index renders spans by reference (id plus a
 * `see turn N` pointer, or a note that the turn was elided or clamped out of the trace), never by
 * duplicating turn text: task and steering text is private by default, and only ids plus
 * metadata (`directives` on the evidence record) ever persist.
 *
 * A span is session authority, never durable project memory: a mistake only a direct
 * instruction covered is still a gap, because the next session starts without it.
 */

export const TASK_ID = "TASK-1";
export const TASK_AUTHORITY = "direct-task";
export const STEERING_AUTHORITY = "direct-steering";

const FENCE = /^([ \t]*)(`{3,}|~{3,})([^\n]*)$/;
const QUOTE = /^\s*>/;

// CommonMark counts a tab as four columns, and fence indentation is relative: an opener
// may sit at any indentation (a list-item code block is still a fence), while its closer
// may be indented at most three columns further.
function indentColumns(prefix) {
  let columns = 0;
  for (const char of prefix) columns += char === "\t" ? 4 : 1;
  return columns;
}

/** A span id is stable by construction: kind plus the distilled turn it points at. */
export function isDirectiveId(id) {
  return id === TASK_ID || /^STEER-\d+$/.test(String(id || ""));
}

function steeringId(turn) {
  return `STEER-${turn}`;
}

/**
 * The authoritative envelope of a user message. Fenced code blocks (pasted tool output,
 * code, retry logs) and blockquote lines (quoted transcripts, pasted replies, planned
 * actions quoted back) are evidence-only, never authority, so they are stripped.
 */
export function carveEnvelope(text) {
  const kept = [];
  let opener = null;

  for (const line of String(text ?? "").split("\n")) {
    const fence = FENCE.exec(line);
    if (opener) {
      // CommonMark: only a fence of the opener's character, at least as long, with
      // nothing but whitespace after it and indented no more than three columns past
      // the opener, closes the block. A shorter, different or deeper inner fence is
      // part of the paste.
      if (
        fence &&
        fence[2][0] === opener.char &&
        fence[2].length >= opener.length &&
        fence[3].trim() === "" &&
        indentColumns(fence[1]) <= opener.indent + 3
      ) {
        opener = null;
      }
      // An unclosed fence still withholds the rest: a pasted log without a closing
      // marker is still a paste, not an instruction.
      continue;
    }
    // CommonMark: a backtick fence's info string may not contain a backtick, so a line
    // of inline code is instruction text, not an opener.
    if (fence && !(fence[2][0] === "`" && fence[3].includes("`"))) {
      opener = { char: fence[2][0], length: fence[2].length, indent: indentColumns(fence[1]) };
      continue;
    }
    if (QUOTE.test(line)) continue;
    kept.push(line);
  }

  return kept.join("\n").trim();
}

/**
 * Index the user turns of one session that carry an authoritative envelope. `turns` are
 * the distilled message turns (`{ turn, role, envelope, elided, clamped }`) in trace order,
 * so ids stay stable across runs of the same transcript and each span knows whether its
 * turn text survived into the trace.
 */
export function extractDirectives(turns) {
  const spans = [];
  let seenFirstUser = false;
  for (const entry of Array.isArray(turns) ? turns : []) {
    if (!entry || entry.role !== "user") continue;
    if (!entry.envelope) continue;
    const span = !seenFirstUser
      ? { id: TASK_ID, kind: "task", turn: entry.turn, authority: TASK_AUTHORITY }
      : { id: steeringId(entry.turn), kind: "steering", turn: entry.turn, authority: STEERING_AUTHORITY };
    seenFirstUser = true;
    spans.push({
      ...span,
      elided: entry.elided === true,
      clamped: entry.clamped === true,
      lifetime: { fromTurn: entry.turn, toTurn: null },
    });
  }
  return spans;
}

/** Metadata that may persist on an evidence record: ids and spans, never turn text. */
export function directiveMetadata(spans) {
  return (Array.isArray(spans) ? spans : []).map((span) => ({
    id: span.id,
    kind: span.kind,
    turn: span.turn,
    authority: span.authority,
    lifetime: { ...span.lifetime },
  }));
}

/**
 * The analysis-prompt index. By reference only: each entry names the turn whose text is
 * already in the trace, or says the turn's text was elided or clamped out of it, so no
 * user-turn text is duplicated into the prompt.
 */
export function renderDirectiveIndex(spans) {
  const list = Array.isArray(spans) ? spans : [];
  if (!list.length) return "(none - no substantive user instruction found in the trace)";
  return list
    .map(
      (span) =>
        `[${span.id}] ${span.kind} · turn ${span.turn} · authority ${span.authority} · ` +
        `lifetime turns ${span.lifetime?.fromTurn ?? span.turn}+ - ` +
        (span.elided
          ? `turn ${span.turn} - elided from the trace, open the raw transcript for its text`
          : span.clamped
            ? `turn ${span.turn} - clamped from the trace, open the raw transcript for its text`
            : `see turn ${span.turn} in the trace`),
    )
    .join("\n");
}
