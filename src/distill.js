import { redact, redactWithOffsets } from "./redact.js";
import { estimateTokens } from "./tokens.js";

/**
 * Stage 0 of the pipeline (design section 3): turn a raw session log into a distilled
 * markdown trace, with no model involved.
 *
 * The point is cheap-first analysis. Raw transcripts on this machine run to megabytes,
 * almost all of it tool-call noise. Distillation keeps what carries the loss signal -
 * what the human asked, what the agent said, and a one-line shape of each tool call -
 * and drops the rest. The trace ends with the raw transcript path so the analysis agent
 * can open the original when (and only when) a claim needs it.
 *
 * Adapters produce a normalized event stream; everything below is shared.
 */

const TOOL_INPUT_CHARS = 160;
const TOOL_OUTPUT_CHARS = 200;
const MESSAGE_CHARS = 6000;

function oneLine(text, limit) {
  const original = String(text ?? "");
  const trimmed = original.trim();
  const offset = original.length - original.trimStart().length;
  const replacements = [];
  let delta = 0;
  const flat = trimmed.replace(/\s+/g, (match, sourceStart) => {
    const start = sourceStart + delta;
    if (start < limit) replacements.push({ start, end: start + 1, sourceStart, sourceEnd: sourceStart + match.length });
    delta += 1 - match.length;
    return " ";
  });
  return {
    text: flat.length > limit ? `${flat.slice(0, limit)}...` : flat,
    redactions: [replacements],
    offset,
    sourceEnd: offset + sourceOffset(Math.min(flat.length, limit), replacements, true),
  };
}

function clampMessage(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length <= MESSAGE_CHARS) return trimmed;
  const head = trimmed.slice(0, MESSAGE_CHARS - 1200);
  const tail = trimmed.slice(-1000);
  return `${head}\n\n[... ${trimmed.length - MESSAGE_CHARS} chars elided ...]\n\n${tail}`;
}

function describeToolInput(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === "string") return { text: input, field: ["input"] };
  // Prefer the field a human would recognise for the common tools.
  for (const key of ["command", "cmd", "file_path", "path", "pattern", "query", "url", "description"]) {
    if (typeof input[key] === "string" && input[key].trim()) {
      return { text: input[key], field: ["input", key] };
    }
  }
  try {
    return { text: JSON.stringify(input), field: ["input"], representation: "json" };
  } catch {
    return null;
  }
}

function renderToolSource(event, descriptor, limit, quoted = false) {
  if (!descriptor) return { summary: "", source: null };
  const flat = oneLine(descriptor.text, limit);
  const redacted = redactWithOffsets(flat.text);
  const escapes = [];
  let delta = 0;
  const escaped = quoted
    ? // eslint-disable-next-line no-control-regex -- JSON string escaping requires matching ASCII control characters.
      redacted.text.replace(/["\\\u0000-\u001f\ud800-\udfff]/gu, (match, sourceStart) => {
        const replacement = JSON.stringify(match).slice(1, -1);
        const start = sourceStart + delta;
        escapes.push({ start, end: start + replacement.length, sourceStart, sourceEnd: sourceStart + match.length });
        delta += replacement.length - match.length;
        return replacement;
      })
    : redacted.text;
  return {
    summary: quoted && redacted.text ? JSON.stringify(redacted.text) : redacted.text,
    source: {
      event,
      field: descriptor.field,
      ...(descriptor.representation ? { representation: descriptor.representation } : {}),
      text: escaped,
      redactions: [...flat.redactions, ...redacted.redactions, ...(quoted ? [escapes] : [])],
      offset: flat.offset,
      sourceEnd: flat.sourceEnd,
    },
  };
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Injected harness scaffolding (system reminders, environment dumps, plugin lists) is
 * not user intent and is identical across every session; keeping it would drown the
 * real signal and inflate every prompt.
 */
const BOILERPLATE = [
  /^<system-reminder>/,
  /^<user_info>/,
  /^<recommended_plugins>/,
  /^<permissions instructions>/,
  /^<env>/,
  /^Caveat: The messages below were generated/,
];

export function isBoilerplate(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return true;
  return BOILERPLATE.some((re) => re.test(trimmed));
}

export function findQuoteProvenance(quote, sources) {
  if (typeof quote !== "string" || quote.trim().length < 8) return null;
  const pattern = quote
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const matcher = new RegExp(pattern);
  for (const source of sources) {
    const match = matcher.exec(source.text);
    if (match) {
      let start = match.index;
      let end = start + match[0].length;
      // Each pass maps its transformed offsets to the preceding representation. Undo
      // the passes in reverse order to reach the genuine event's UTF-16 offsets.
      for (const replacements of [...source.redactions].reverse()) {
        start = sourceOffset(start, replacements, false);
        end = sourceOffset(end, replacements, true);
      }
      start += source.offset ?? 0;
      end += source.offset ?? 0;
      if (end > (source.sourceEnd ?? Infinity)) continue;
      return {
        kind: "source",
        event: source.event,
        field: source.field,
        ...(source.representation ? { representation: source.representation } : {}),
        start,
        end,
      };
    }
  }
  return null;
}

function sourceOffset(offset, replacements, end) {
  let delta = 0;
  for (const replacement of replacements) {
    if (offset <= replacement.start) break;
    if (offset < replacement.end) return end ? replacement.sourceEnd : replacement.sourceStart;
    delta = replacement.sourceEnd - replacement.end;
  }
  return offset + delta;
}

/**
 * Normalized event shapes accepted from adapters:
 *   { kind: 'message', role: 'user'|'assistant', text }
 *   { kind: 'tool', name, input, result, status }
 *   { kind: 'thinking', text }   (dropped - reasoning traces are noise for this purpose)
 */
export function distill(events, meta, options = {}) {
  const maxTraceTokens = options.maxTraceTokens ?? 12000;
  const lines = [];
  const sources = [];
  const collectSource = (event, field, value) => {
    if (typeof value === "string") sources.push({ event, field, ...redactWithOffsets(value) });
    else if (value && typeof value === "object") {
      if (field.length === 1)
        sources.push({ event, field, ...redactWithOffsets(JSON.stringify(value)), representation: "json" });
      for (const [key, child] of Object.entries(value)) collectSource(event, [...field, key], child);
    }
  };
  let userTurns = 0;
  let assistantTurns = 0;
  let toolCalls = 0;
  let turn = 0;

  for (const [eventIndex, event] of events.entries()) {
    if (!event) continue;
    for (const field of ["text", "input", "result"]) collectSource(eventIndex, [field], event[field]);
    if (event.kind === "message") {
      const text = clampMessage(redact(event.text));
      if (!text || isBoilerplate(text)) continue;
      turn += 1;
      if (event.role === "user") userTurns += 1;
      else assistantTurns += 1;
      lines.push(`### turn ${turn} · ${event.role}`);
      lines.push(text);
      lines.push("");
    } else if (event.kind === "tool") {
      toolCalls += 1;
      const input = renderToolSource(eventIndex, describeToolInput(event.input), TOOL_INPUT_CHARS, true);
      const resultText =
        event.result == null ? null : typeof event.result === "string" ? event.result : safeStringify(event.result);
      const result = renderToolSource(
        eventIndex,
        resultText === null
          ? null
          : {
              text: resultText,
              field: ["result"],
              ...(typeof event.result === "string" ? {} : { representation: "json" }),
            },
        TOOL_OUTPUT_CHARS,
      );
      if (input.source) sources.push(input.source);
      if (result.source) sources.push(result.source);
      const bytes = resultText === null ? 0 : Buffer.byteLength(resultText, "utf8");
      const output =
        bytes > TOOL_OUTPUT_CHARS ? `${result.summary} (output ${formatBytes(bytes)}, truncated)` : result.summary;
      const status = event.status && event.status !== "completed" ? ` [${event.status}]` : "";
      const arrow = output ? ` -> ${output}` : "";
      lines.push(`tool: ${event.name || "unknown"}${input.summary ? ` ${input.summary}` : ""}${status}${arrow}`);
    }
  }

  const header = [
    `# session ${meta.id}`,
    `harness: ${meta.harness}`,
    meta.model ? `model: ${meta.model}` : null,
    meta.startedAt ? `date: ${new Date(meta.startedAt).toISOString()}` : null,
    meta.cwd ? `cwd: ${meta.cwd}` : null,
    meta.gitBranch ? `branch: ${meta.gitBranch}` : null,
    `association: tier ${meta.association?.tier} (${meta.association?.confidence})`,
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");

  const footer = [
    "",
    "---",
    `raw transcript: ${meta.rawPath}`,
    "Tool calls above are one-line summaries and tool output is truncated. Open the raw",
    "transcript only if a specific claim needs the full text.",
  ].join("\n");

  const { body, elided } = capTrace(lines.join("\n").trim(), maxTraceTokens);
  const trace = `${header}\n${body}\n${footer}\n`;

  return {
    trace,
    sources,
    stats: {
      userTurns,
      assistantTurns,
      toolCalls,
      elided,
      distilledTokens: estimateTokens(trace),
    },
  };
}

/**
 * Long sessions still blow past what a cheap analysis pass should read. Keep the head
 * (the task as stated) and the tail (how it actually ended) and elide the middle - the
 * raw transcript path in the footer remains the escape hatch for anything in between.
 */
function capTrace(body, maxTraceTokens) {
  if (estimateTokens(body) <= maxTraceTokens) return { body, elided: false };
  const budgetChars = maxTraceTokens * 4;
  const headChars = Math.floor(budgetChars * 0.45);
  const tailChars = Math.floor(budgetChars * 0.45);
  const head = body.slice(0, headChars);
  const tail = body.slice(-tailChars);
  const droppedTokens = estimateTokens(body) - estimateTokens(head) - estimateTokens(tail);
  return {
    body: `${head}\n\n[... middle of session elided: ~${droppedTokens} tokens. Open the raw transcript below if a claim needs it ...]\n\n${tail}`,
    elided: true,
  };
}
