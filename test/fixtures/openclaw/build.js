import { DatabaseSync } from "node:sqlite";
import * as zlib from "node:zlib";

// Synthetic projection of OpenClaw schema user_version=23. Never copy real content.
export const timestamp = 1_790_550_000_000;
export function buildFixture(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA user_version = 23;
    CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT, entry_json TEXT,
      created_via TEXT, spawned_by TEXT, parent_session_key TEXT);
    CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT, created_at INTEGER,
      updated_at INTEGER, acp_owned INTEGER, hook_external_content_source TEXT, channel TEXT, chat_type TEXT, spawned_by TEXT, parent_session_key TEXT);
    CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BLOB,
      created_at INTEGER, PRIMARY KEY(session_id, seq));
    CREATE TABLE session_transcript_active_events (session_id TEXT, active_position INTEGER, event_seq INTEGER);
    CREATE TABLE session_transcript_archives (session_id TEXT, generation TEXT, session_key TEXT,
      reason TEXT, encoding TEXT, archive_blob BLOB, created_at INTEGER, PRIMARY KEY(session_id, generation));
  `);
  const message = (role, content, extra = {}) => ({ type: "message", message: { role, content, ...extra } });
  const header = { type: "session", cwd: "/synthetic/header", timestamp };
  const scaffold = '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>private generated text<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\nConversation info: ⟦openclaw:ctx⟧\n```json\n{"id":"synthetic"}\n```\n<active_memory_plugin>generated memory</active_memory_plugin>\n[Sun 2026-09-27 21:24 EDT] Keep my actual words.';
  const events = [header, message("system", "bootstrap instructions"), message("user", scaffold),
    message("assistant", [{ type: "text", text: "Verbatim answer." }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "demo.txt" } }]),
    message("toolResult", [{ type: "text", text: "synthetic result" }], { toolCallId: "call-1", isError: true }),
    message("user", "Injected bootstrap", { provenance: { kind: "internal_system", sourceTool: "bootstrap" } }),
    message("user", "Injected agent announcement", { provenance: { kind: "inter_session" } }),
    message("assistant", "Stale branch must disappear.")];
  function live(id, source, metadata = {}, entries = [header, message("user", "Human request.")]) {
    const key = `agent:main:${source}`;
    db.prepare("INSERT INTO session_nodes (session_key, current_session_id, entry_json) VALUES (?, ?, ?)").run(key, id, JSON.stringify(metadata));
    db.prepare("INSERT INTO session_windows (session_id, session_key, created_at, updated_at, acp_owned) VALUES (?, ?, ?, ?, 0)").run(id, key, timestamp, timestamp + 1000);
    entries.forEach((e, seq) => {
      db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, NULL, ?)").run(id, seq, JSON.stringify(e), timestamp + seq);
      if (e.type !== "session" && (id !== "dashboard" || seq !== entries.length - 1))
        db.prepare("INSERT INTO session_transcript_active_events VALUES (?, ?, ?)").run(id, seq, seq);
    });
  }
  live("dashboard", "dashboard:demo", { systemPromptReport: { workspaceDir: "/synthetic/metadata" } }, events);
  live("fallback", "main", {}, [message("user", "Fallback request.")]);
  for (const source of ["slack", "discord", "telegram", "webchat", "signal:direct:person", "cron:job:run:1", "subagent:child", "heartbeat-tick", "acp:child", "hook:gmail", "test:case", "bakeoff:case", "content-lane-eval", "explicit:case", "pra245-check", "internal-session-effects", "memory-health-probe-main-1", "routing-smoke-fable-20260715", "r3-routing-muse-smoke-20260910", "r3-routing-fable-review-20260910", "pra290-router-main-interactive", "pra373-review-case", "retrieval", "evaluation", "slack:channel:eval"]) live(source, source);
  const archive = (id, generation, encoding, bytes, source = "dashboard:archived") => db.prepare("INSERT INTO session_transcript_archives VALUES (?, ?, ?, 'deleted', ?, ?, ?)").run(id, generation, `agent:main:${source}`, encoding, bytes, timestamp + 2000);
  const jsonl = Buffer.from([header, message("user", "Archived human request."), message("assistant", "Archived answer.")].map(e => JSON.stringify(e)).join("\n") + "\n");
  archive("archive", "generation-1", "identity", jsonl);
  archive("archive", "generation-2", "identity", jsonl);
  archive("dashboard", "overlap", "identity", Buffer.from(events.slice(0, -1).map(e => JSON.stringify(e)).join("\n")));
  // A fixed zstd frame lets older Node runtimes test the missing-decoder path too.
  const compressed = Buffer.from("KLUv/SBTPQIAYgQPFZBZB3SlyciTTW+Vz/88op9ZznTdCcB7DfJuiLEolJpRCP9GlpbQ01ROtYaaot+OhXXH1AX6nXpqlmRdAgA/Q9GihAE=", "base64");
  archive("compressed", "generation-1", "zstd", compressed);
  if (typeof zlib.zstdCompressSync === "function") {
    const blob = zlib.zstdCompressSync(Buffer.from(JSON.stringify(message("user", "Compressed live request."))));
    live("compressed-live", "dashboard:compressed", {}, [header]);
    db.prepare("INSERT INTO transcript_events VALUES (?, 1, NULL, ?, ?)").run("compressed-live", blob, timestamp + 1);
    db.prepare("INSERT INTO session_transcript_active_events VALUES (?, 1, 1)").run("compressed-live");
  }
  db.close();
}
