/**
 * Distilled traces are handed to a model the user configured, but they are still built
 * from raw session logs. Obvious secret shapes are redacted before that happens
 * (design section 9, privacy). This is a coarse net, not a guarantee: it catches the
 * common token formats and `KEY=value` assignments that show up in shell transcripts.
 */

const PATTERNS = [
  [/\b(sk-ant-[A-Za-z0-9_-]{16,})/g, "ANTHROPIC_KEY"],
  [/\b(sk-proj-[A-Za-z0-9_-]{16,})/g, "OPENAI_KEY"],
  [/\b(sk-or-v1-[A-Za-z0-9_-]{16,})/g, "OPENROUTER_KEY"],
  [/\b(sk-[A-Za-z0-9]{32,})/g, "API_KEY"],
  [/\b(gh[pousr]_[A-Za-z0-9]{16,})/g, "GITHUB_TOKEN"],
  [/\b(xox[abposr]-[A-Za-z0-9-]{10,})/g, "SLACK_TOKEN"],
  [/\b(AKIA[0-9A-Z]{16})\b/g, "AWS_ACCESS_KEY_ID"],
  [/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, "JWT"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "PRIVATE_KEY"],
  [
    // An unquoted value stops at whitespace, a quote, or a comma, so one argument in
    // `max_output_tokens:12000,yield_time_ms:1000` can never swallow the next. A closed
    // quote still wins first, so a quoted secret is redacted whole even with a comma in
    // it, and an unterminated quote falls back to the bounded unquoted form. A quoted
    // value may span newlines only when its closing quote ends the line (or is followed
    // by a value separator), so a stray quote later in the prose cannot swallow it.
    /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY)[A-Za-z0-9_]*)\s*[=:]\s*(?:"([^"]{8,})"(?=[ \t]*(?:$|[,;})\]]))|'([^']{8,})'(?=[ \t]*(?:$|[,;})\]]))|"([^"\n]{8,})"|'([^'\n]{8,})'|["']?([^\s"',]{8,}))/gim,
    "ASSIGNMENT",
  ],
  // Run after assignments so a matching variable name cannot hide an unredacted value.
  [/\b(apikey_[A-Za-z0-9_-]{16,})/gi, "API_KEY"],
];

export function redact(text) {
  if (!text) return text;
  let out = String(text);
  for (const [pattern, label] of PATTERNS) {
    out = out.replace(pattern, (match, first, dqMulti, sqMulti, dq, sq, bare) => {
      if (label !== "ASSIGNMENT") return `[redacted:${label}]`;
      const second = dqMulti ?? sqMulti ?? dq ?? sq ?? bare;
      // A specific pattern above may already have replaced the value; keep its label.
      if (typeof second === "string" && second.startsWith("[redacted")) return match;
      return `${first}=[redacted]`;
    });
  }
  return out;
}
