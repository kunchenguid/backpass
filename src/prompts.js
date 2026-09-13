import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SELF_SESSION_SENTINEL } from "./sentinel.js";

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
 * Re-exported so every prompt-facing caller keeps one import. The constant itself lives
 * in `src/sentinel.js`, which has no dependencies, because `src/discovery/self.js` and
 * the remote probe bundle need it without prompt loading.
 */
export { SELF_SESSION_SENTINEL };

export function renderPrompt(name, values) {
  return `${SELF_SESSION_SENTINEL}\n${render(loadPrompt(name), values)}`;
}
