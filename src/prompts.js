import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROMPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts");

const cache = new Map();

export function loadPrompt(name) {
  if (!cache.has(name)) {
    cache.set(name, fs.readFileSync(path.join(PROMPT_DIR, `${name}.md`), "utf8"));
  }
  return cache.get(name);
}

/** Simple, explicit {{TOKEN}} substitution - no template engine, no surprises. */
export function render(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}

/**
 * Every prompt backpass sends to a harness starts with this line. The harness records
 * the prompt as the session's first user message in its own store - the very store
 * discovery reads - so without a marker backpass's analysis and synthesis runs would
 * be discovered as ordinary sessions on the next pass and the loop would analyze
 * itself. Discovery (`src/discovery/self.js`) drops any transcript whose first user
 * message begins with it. It keys on content backpass owns, so it survives harness
 * format drift and needs nothing from acpx.
 */
export const SELF_SESSION_SENTINEL = "<!-- backpass:self-session -->";

export function renderPrompt(name, values) {
  return `${SELF_SESSION_SENTINEL}\n${render(loadPrompt(name), values)}`;
}
