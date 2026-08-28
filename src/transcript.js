import crypto from "node:crypto";

export function transcriptIdentity(transcript) {
  if (typeof transcript?.identity === "string" && transcript.identity) return transcript.identity;
  const harness = String(transcript?.harness ?? "");
  let nativeId = String(transcript?.nativeId ?? transcript?.id ?? "");
  if (transcript?.nativeId == null && harness && nativeId.startsWith(`${harness}-`)) {
    nativeId = nativeId.slice(harness.length + 1);
  }
  const source = String(transcript?.path ?? "");
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([harness, nativeId, source]), "utf8")
    .digest("hex");
}
