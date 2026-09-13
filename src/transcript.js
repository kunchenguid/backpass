import crypto from "node:crypto";

/**
 * The durable name of one session: harness, the harness's own id for it, and where it
 * came from. Sampling draws, evidence files, and the gap ledger all key off this, so it
 * must stay stable as a corpus grows and must never collapse two real sessions.
 *
 * A session collected over ssh carries its host in the source (`ssh://<host>/<path>`),
 * for two reasons: a remote file at the same path as a local one is a different session,
 * and a store synced or copied between two machines is the same session, which
 * `transcriptSource` cannot decide but cross-host dedup in `src/discovery/index.js` can.
 * SQLite stores add the row id, since every session there shares one database path.
 */
export function transcriptSource(transcript) {
  const file = String(transcript?.path ?? "");
  if (!transcript?.host) return file;
  const base = `ssh://${transcript.host}${file.startsWith("/") ? "" : "/"}${file}`;
  return transcript.remote?.kind === "events" ? `${base}#${nativeIdOf(transcript)}` : base;
}

function nativeIdOf(transcript) {
  const harness = String(transcript?.harness ?? "");
  let nativeId = String(transcript?.nativeId ?? transcript?.id ?? "");
  if (transcript?.nativeId == null && harness && nativeId.startsWith(`${harness}-`)) {
    nativeId = nativeId.slice(harness.length + 1);
  }
  return nativeId;
}

export function transcriptIdentity(transcript) {
  if (typeof transcript?.identity === "string" && transcript.identity) return transcript.identity;
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([String(transcript?.harness ?? ""), nativeIdOf(transcript), transcriptSource(transcript)]),
      "utf8",
    )
    .digest("hex");
}
