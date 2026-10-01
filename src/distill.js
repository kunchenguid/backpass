import { redact } from "./redact.js";
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
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

function clampMessage(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length <= MESSAGE_CHARS) return trimmed;
  const head = trimmed.slice(0, MESSAGE_CHARS - 1200);
  const tail = trimmed.slice(-1000);
  return `${head}\n\n[... ${trimmed.length - MESSAGE_CHARS} chars elided ...]\n\n${tail}`;
}

function describeToolInput(input) {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return oneLine(input, TOOL_INPUT_CHARS);
  // Prefer the field a human would recognise for the common tools.
  for (const key of ["command", "cmd", "file_path", "path", "pattern", "query", "url", "description"]) {
    if (typeof input[key] === "string" && input[key].trim()) {
      return oneLine(input[key], TOOL_INPUT_CHARS);
    }
  }
  try {
    return oneLine(JSON.stringify(input), TOOL_INPUT_CHARS);
  } catch {
    return "";
  }
}

function describeToolResult(result) {
  if (result === null || result === undefined) return "";
  const text = typeof result === "string" ? result : safeStringify(result);
  const bytes = Buffer.byteLength(text, "utf8");
  const summary = oneLine(text, TOOL_OUTPUT_CHARS);
  return bytes > TOOL_OUTPUT_CHARS ? `${summary} (output ${formatBytes(bytes)}, truncated)` : summary;
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

/**
 * Normalized event shapes accepted from adapters:
 *   { kind: 'message', role: 'user'|'assistant', text }
 *   { kind: 'tool', name, input, result, status }
 *   { kind: 'thinking', text }   (dropped - reasoning traces are noise for this purpose)
 */
export function distill(events, meta, options = {}) {
  const maxTraceTokens = options.maxTraceTokens ?? 12000;
  const lines = [];
  let userTurns = 0;
  let assistantTurns = 0;
  let toolCalls = 0;
  let turn = 0;

  for (const event of events) {
    if (!event) continue;
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
      const input = redact(describeToolInput(event.input));
      const result = redact(describeToolResult(event.result));
      const status = event.status && event.status !== "completed" ? ` [${event.status}]` : "";
      const arrow = result ? ` -> ${result}` : "";
      lines.push(`tool: ${event.name || "unknown"}${input ? ` ${JSON.stringify(input)}` : ""}${status}${arrow}`);
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
