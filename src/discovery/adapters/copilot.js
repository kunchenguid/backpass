import path from "node:path";

import { emptyInteractionSignals } from "../../interaction.js";
import { attachToolResults, home, listDirs, parseJsonLine, readHeadLines, readJsonl, statOrNull } from "./shared.js";

/**
 * GitHub Copilot CLI: ~/.copilot/session-state/<session-uuid>/events.jsonl
 *
 * Every line is an event `{ type, data, id, timestamp, parentId }`. The first is
 * `session.start`, whose `data.context` carries `cwd`, `gitRoot` and `branch`. The recorded
 * `repository` is a host-specific label (`owner/name`, or `org/project/repo` on Azure
 * DevOps), not a git remote URL, so no remote is reported and association relies on the
 * cwd tiers, as for Claude Code.
 *
 * `COPILOT_HOME` relocates the whole config dir.
 *
 * Sub-agent work (`parentToolCallId`) is a sidechain and is skipped. `user.message` events
 * the harness injected itself (instruction discovery, skills, system notices, prompts
 * delegated to sub-agents) carry a non-user `source` and are skipped too.
 */

const HEADER_LINES = 5;
const EVENTS_FILE = "events.jsonl";
const USER_SOURCES = new Set(["user", "autopilot-objective"]);

export const name = "copilot";

export function storeRoot() {
  return process.env.COPILOT_HOME
    ? path.join(process.env.COPILOT_HOME, "session-state")
    : home(".copilot", "session-state");
}

export function enumerate() {
  const out = [];
  for (const dir of listDirs(storeRoot())) {
    const file = path.join(dir, EVENTS_FILE);
    const stat = statOrNull(file);
    if (!stat) continue;
    out.push({ key: file, path: file, mtimeMs: stat.mtimeMs, bytes: stat.size });
  }
  return out;
}

export function classify(candidate) {
  for (const line of readHeadLines(candidate.path, HEADER_LINES)) {
    const entry = parseJsonLine(line);
    if (!entry || entry.type !== "session.start") continue;
    const data = entry.data || {};
    const context = data.context || {};
    if (!context.cwd) return null;
    return {
      id: data.sessionId || path.basename(path.dirname(candidate.path)),
      cwd: context.cwd,
      gitRoot: context.gitRoot || null,
      gitBranch: context.branch || null,
      remotes: [],
      startedAt: data.startTime ? Date.parse(data.startTime) : candidate.mtimeMs,
      model: data.selectedModel || null,
      interactionSignals: emptyInteractionSignals(),
    };
  }
  return null;
}

export function read(ref) {
  const entries = readJsonl(ref.path);
  const events = [];
  let model = null;

  for (const entry of entries) {
    const data = entry.data || {};
    switch (entry.type) {
      case "session.start":
        model = model || data.selectedModel || null;
        break;
      case "user.message": {
        if (data.source && !USER_SOURCES.has(data.source)) break;
        if (typeof data.content === "string" && data.content.trim()) {
          events.push({ kind: "message", role: "user", text: data.content });
        }
        break;
      }
      case "assistant.message": {
        if (data.parentToolCallId) break;
        model = model || data.model || null;
        if (typeof data.content === "string" && data.content.trim()) {
          events.push({ kind: "message", role: "assistant", text: data.content });
        }
        for (const request of data.toolRequests || []) {
          events.push({
            kind: "tool",
            name: request.name,
            input: request.arguments,
            pendingId: request.toolCallId,
          });
        }
        break;
      }
      case "tool.execution_complete": {
        if (data.parentToolCallId) break;
        events.push({
          kind: "tool-result",
          id: data.toolCallId,
          result: data.result?.content ?? data.error?.message ?? data.error,
          status: data.success === false ? "error" : "completed",
        });
        break;
      }
      default:
        break;
    }
  }

  return { events: attachToolResults(events), model };
}
