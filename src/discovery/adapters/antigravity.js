import fs from "node:fs";
import path from "node:path";

import {
  attachToolResults,
  contentToEvents,
  home,
  listDirs,
  parseJsonLine,
  readHeadLines,
  readJsonl,
  statOrNull,
} from "./shared.js";

/**
 * Antigravity: ~/.gemini/antigravity-cli (or ANTIGRAVITY_HOME)
 *   history.jsonl - { display, timestamp, workspace, conversationId }
 *   brain/<conversation-id>/.system_generated/logs/transcript.jsonl - JSONL step events
 *
 * Each step record carries `step_index`, `type`, `source`, `status`, `created_at`, etc.
 * `USER_INPUT` (source: USER_EXPLICIT) holds user prompt in `content`.
 * `PLANNER_RESPONSE` (source: MODEL) holds model content, `thinking`, and `tool_calls`.
 * `GENERIC` / `TOOL_RESULT` holds tool result content.
 * System steps (`CONVERSATION_HISTORY`, `CHECKPOINT`) are dropped.
 */

export const name = "antigravity";

export function storeRoot() {
  return process.env.ANTIGRAVITY_HOME || home(".gemini", "antigravity-cli");
}

function loadHistoryMap(historyFile) {
  const map = new Map();
  const entries = readJsonl(historyFile);
  for (const entry of entries) {
    if (!entry || !entry.conversationId) continue;
    if (!map.has(entry.conversationId)) {
      map.set(entry.conversationId, {
        workspace: entry.workspace || null,
        timestamp:
          typeof entry.timestamp === "number" ? entry.timestamp : entry.timestamp ? Date.parse(entry.timestamp) : null,
      });
    }
  }
  return map;
}

function conversationIdFromPath(filePath) {
  const parts = filePath.split(path.sep);
  const brainIdx = parts.lastIndexOf("brain");
  if (brainIdx !== -1 && brainIdx + 1 < parts.length) {
    return parts[brainIdx + 1];
  }
  return path.basename(filePath, ".jsonl");
}

function findCwdFromHistory(transcriptPath, id) {
  try {
    const parts = transcriptPath.split(path.sep);
    const brainIdx = parts.lastIndexOf("brain");
    if (brainIdx > 0) {
      const root = parts.slice(0, brainIdx).join(path.sep);
      const historyFile = path.join(root, "history.jsonl");
      if (fs.existsSync(historyFile)) {
        const historyMap = loadHistoryMap(historyFile);
        return historyMap.get(id)?.workspace || null;
      }
    }
  } catch {
    // fail soft
  }
  return null;
}

/**
 * @param {{ cutoffMs?: number }} [options]
 */
export function enumerate({ cutoffMs } = {}) {
  const root = storeRoot();
  const brainDir = path.join(root, "brain");
  const historyMap = loadHistoryMap(path.join(root, "history.jsonl"));
  const out = [];

  for (const sessionDir of listDirs(brainDir)) {
    const conversationId = path.basename(sessionDir);
    let transcriptPath = path.join(sessionDir, ".system_generated", "logs", "transcript.jsonl");
    let stat = statOrNull(transcriptPath);
    if (!stat) {
      transcriptPath = path.join(sessionDir, "transcript.jsonl");
      stat = statOrNull(transcriptPath);
    }
    if (!stat) continue;
    if (cutoffMs && stat.mtimeMs < cutoffMs) continue;

    const historyInfo = historyMap.get(conversationId);
    out.push({
      key: transcriptPath,
      path: transcriptPath,
      mtimeMs: stat.mtimeMs,
      bytes: stat.size,
      extra: {
        conversationId,
        cwd: historyInfo?.workspace || null,
        startedAt: historyInfo?.timestamp || null,
      },
    });
  }
  return out;
}

export function classify(candidate) {
  let cwd = candidate.extra?.cwd || null;
  let id = candidate.extra?.conversationId || null;
  let startedAt = candidate.extra?.startedAt || null;
  let model = null;

  const lines = readHeadLines(candidate.path, 40);
  for (const line of lines) {
    const entry = parseJsonLine(line);
    if (!entry) continue;
    if (!cwd) {
      cwd = entry.workspace || entry.cwd || entry.metadata?.workspace || entry.metadata?.cwd || null;
    }
    if (!id) {
      id = entry.conversationId || entry.conversation_id || entry.id || entry.sessionId || null;
    }
    if (!startedAt) {
      if (entry.created_at) startedAt = Date.parse(entry.created_at);
      else if (typeof entry.timestamp === "number") startedAt = entry.timestamp;
      else if (entry.timestamp) startedAt = Date.parse(entry.timestamp);
    }
    if (!model) {
      model = entry.model || entry.model_id || entry.modelId || null;
    }
    if (cwd && id && startedAt && model) break;
  }

  if (!id) {
    id = conversationIdFromPath(candidate.path);
  }

  if (!cwd) {
    cwd = findCwdFromHistory(candidate.path, id);
  }

  if (!cwd) return null;

  return {
    id,
    cwd,
    gitBranch: null,
    remotes: [],
    startedAt: startedAt || candidate.mtimeMs,
    model: model || null,
  };
}

export function read(ref) {
  const entries = readJsonl(ref.path);
  const events = [];
  let model = null;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;

    // Ignore system and checkpoint steps
    if (
      entry.source === "SYSTEM" ||
      entry.type === "CONVERSATION_HISTORY" ||
      entry.type === "CHECKPOINT" ||
      entry.type === "SYSTEM"
    ) {
      continue;
    }

    if (entry.type === "USER_INPUT" || entry.source === "USER_EXPLICIT" || entry.role === "user") {
      contentToEvents("user", entry.content ?? entry.text ?? entry.message, events);
      continue;
    }

    if (
      entry.type === "TOOL_RESULT" ||
      entry.type === "tool_result" ||
      entry.type === "GENERIC" ||
      entry.source === "TOOL" ||
      entry.role === "tool"
    ) {
      events.push({
        kind: "tool-result",
        id:
          entry.tool_call_id ?? entry.call_id ?? entry.toolCallId ?? (entry.type === "GENERIC" ? entry.id : undefined),
        result: flattenOutput(entry.result ?? entry.output ?? entry.content ?? entry.text),
        status: entry.status === "ERROR" || entry.status === "error" || entry.is_error ? "error" : "completed",
      });
      continue;
    }

    if (entry.type === "PLANNER_RESPONSE" || entry.source === "MODEL" || entry.role === "assistant") {
      model = model || entry.model || entry.model_id || entry.modelId || null;

      if (Array.isArray(entry.tool_calls)) {
        for (const call of entry.tool_calls) {
          if (!call || typeof call !== "object") continue;
          events.push({
            kind: "tool",
            name: call.name,
            input: parseMaybeJson(call.args ?? call.input ?? call.arguments),
            pendingId: call.id ?? call.call_id ?? call.tool_call_id ?? call.toolCallId,
          });
        }
      }

      contentToEvents("assistant", entry.content, events);
      continue;
    }
  }

  return { events: attachToolResults(events), model };
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function flattenOutput(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((b) => (typeof b === "string" ? b : (b?.text ?? "")))
      .filter(Boolean)
      .join("\n");
  }
  return output ?? "";
}
