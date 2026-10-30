/**
 * acpx JSON output contains both sides of nested RPC exchanges. Record every
 * exchange, including setup, before interpreting an answer. A root exchange owns
 * the invocation outcome; a nested tool failure cannot replace that outcome.
 * Request ids retain their JSON types and may be reused by the opposite peer.
 */
export function readAcpxOutput(stdout) {
  const pending = new Map();
  const open = [];
  const roots = [];
  const exchanges = [];
  let terminal = null;
  let valid = true;
  let recognized = false;
  let index = 0;
  for (const line of stdout.trim().split("\n")) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      if (!recognized) return null;
      valid = false;
      continue;
    }
    if (message?.jsonrpc !== "2.0") {
      if (!recognized) return null;
      valid = false;
      continue;
    }
    recognized = true;
    index += 1;
    if (message.id === null && message.error && !message.method) {
      terminal = { error: message.error, index };
    } else if (typeof message.method === "string" && message.id != null) {
      // acpx issues one lifecycle request at a time. Requests from the adapter
      // during it belong to that root; concurrent tool calls are siblings.
      const parent = open[0] || null;
      const exchange = { request: message, parent, chunks: [], response: null, start: index, end: 0 };
      if (!parent) roots.push(exchange);
      exchanges.push(exchange);
      const stack = pending.get(message.id) || [];
      stack.push(exchange);
      pending.set(message.id, stack);
      open.push(exchange);
    } else if (!message.method && message.id != null) {
      const stack = pending.get(message.id);
      const exchange = stack?.pop();
      if (!exchange) {
        valid = false;
        continue;
      }
      exchange.response = message;
      exchange.end = index;
      if (open.some((item) => item.parent === exchange)) valid = false;
      open.splice(open.indexOf(exchange), 1);
    } else if (message.method === "session/update") {
      const prompt = open.find((item) => !item.parent && item.request.method === "session/prompt");
      const update = message.params?.update;
      if (
        prompt &&
        message.params?.sessionId === prompt.request.params?.sessionId &&
        update?.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text" &&
        typeof update.content.text === "string"
      )
        prompt.chunks.push(update.content.text);
    }
  }
  if (!recognized) return null;
  const root = roots.at(-1);
  const result = root?.response?.result;
  const complete =
    valid && open.length === 0 && root?.request.method === "session/prompt" && typeof result?.stopReason === "string";
  const error = terminal && terminal.index > (root?.end || root?.start || 0) ? terminal.error : root?.response?.error;
  // The protocol defines these permission outcomes. Other tool errors carry no
  // count-bearing permission field, so never guess a count from their prose.
  let denials = 0;
  for (const exchange of exchanges) {
    if (exchange.request.method !== "session/request_permission") continue;
    const outcome = exchange.response?.result?.outcome;
    const options = exchange.request.params?.options;
    if (
      outcome?.outcome === "cancelled" ||
      (outcome?.outcome === "selected" &&
        Array.isArray(options) &&
        options.some(
          (option) => option?.optionId === outcome.optionId && ["reject_once", "reject_always"].includes(option.kind),
        ))
    )
      denials += 1;
  }
  return {
    text: complete ? root.chunks.join("") : "",
    completed: complete && result.stopReason === "end_turn",
    deniedRequests: denials || null,
    usage: complete ? readUsage(result.usage) : null,
    diagnostic: [
      error?.data?.acpxCode,
      error?.data?.detailCode,
      error?.message,
      error?.data?.details,
      error?.data?.acp?.message,
      error?.data?.acp?.data?.details,
    ]
      .filter((value) => typeof value === "string" && value.trim())
      .join(" "),
  };
}

/** Usage is ACP result metadata, not text supplied by the model. */
function readUsage(raw) {
  /** @type {Record<string, number>} */
  const usage = {};
  for (const [key, aliases] of Object.entries({
    input: ["inputTokens", "input_tokens"],
    output: ["outputTokens", "output_tokens"],
    cache_read: ["cachedReadTokens", "cacheReadInputTokens", "cache_read_input_tokens"],
    cache_write: ["cachedWriteTokens", "cacheCreationInputTokens", "cache_creation_input_tokens"],
    total: ["totalTokens", "total_tokens"],
  })) {
    const value = aliases.map((alias) => raw?.[alias]).find(Number.isFinite);
    if (value !== undefined) usage[key] = value;
  }
  return Object.keys(usage).length ? usage : null;
}
