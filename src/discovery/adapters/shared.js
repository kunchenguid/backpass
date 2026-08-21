import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** Read at most `maxLines` lines (or `maxBytes`) from the head of a file. */
export function readHeadLines(file, maxLines = 1, maxBytes = 512 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, 0);
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    // A final partial line is only safe to use when we read the whole file.
    if (length < size) lines.pop();
    return lines.filter((l) => l.trim()).slice(0, maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function readJsonl(file, { maxBytes = 64 * 1024 * 1024 } = {}) {
  let text;
  try {
    const stat = fs.statSync(file);
    if (stat.size > maxBytes) {
      // Very large sessions are read tail-first: recent turns carry the loss signal.
      const fd = fs.openSync(file, "r");
      const buffer = Buffer.alloc(maxBytes);
      fs.readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes);
      fs.closeSync(fd);
      text = buffer.toString("utf8");
      text = text.slice(text.indexOf("\n") + 1);
    } else {
      text = fs.readFileSync(file, "utf8");
    }
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const value = parseJsonLine(line);
    if (value) out.push(value);
  }
  return out;
}

export function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

export function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

export function listFiles(dir, suffix) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && (!suffix || e.name.endsWith(suffix)))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

export function home(...segments) {
  return path.join(os.homedir(), ...segments);
}

/**
 * Normalize an assistant/user `content` value into distiller events. Every harness
 * settled on some variant of "string, or array of typed blocks", so one tolerant
 * reader covers claude, codex, pi, grok and cursor with adapter-specific tweaks
 * layered on top.
 */
export function contentToEvents(role, content, events) {
  if (content === null || content === undefined) return;
  if (typeof content === "string") {
    if (content.trim()) events.push({ kind: "message", role, text: content });
    return;
  }
  if (!Array.isArray(content)) {
    if (typeof content.text === "string") events.push({ kind: "message", role, text: content.text });
    return;
  }
  const texts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      if (typeof block === "string") texts.push(block);
      continue;
    }
    switch (block.type) {
      case "text":
      case "input_text":
      case "output_text":
        if (block.text) texts.push(block.text);
        break;
      case "tool_use":
      case "toolCall":
        events.push({
          kind: "tool",
          name: block.name,
          input: block.input ?? block.arguments,
          pendingId: block.id ?? block.call_id,
        });
        break;
      case "tool_result":
      case "toolResult":
        events.push({
          kind: "tool-result",
          id: block.tool_use_id ?? block.id,
          result: block.content ?? block.output ?? block.text,
          status: block.is_error ? "error" : "completed",
        });
        break;
      case "thinking":
      case "reasoning":
        break;
      default:
        if (typeof block.text === "string") texts.push(block.text);
        break;
    }
  }
  if (texts.length) {
    const joined = texts.join("\n").trim();
    if (joined) events.push({ kind: "message", role, text: joined });
  }
}

/**
 * Fold `tool-result` events back into the `tool` call they answer, so the distiller
 * emits one line per tool call rather than two.
 */
export function attachToolResults(events) {
  const out = [];
  const byId = new Map();
  for (const event of events) {
    if (event.kind === "tool") {
      out.push(event);
      if (event.pendingId) byId.set(event.pendingId, event);
      continue;
    }
    if (event.kind === "tool-result") {
      const target = event.id && byId.get(event.id);
      if (target) {
        target.result = event.result;
        target.status = event.status;
      } else {
        // Orphan result (truncated log, or a harness that does not correlate ids).
        const last = [...out].reverse().find((e) => e.kind === "tool" && e.result === undefined);
        if (last) {
          last.result = event.result;
          last.status = event.status;
        }
      }
      continue;
    }
    out.push(event);
  }
  for (const event of out) delete event.pendingId;
  return out;
}
