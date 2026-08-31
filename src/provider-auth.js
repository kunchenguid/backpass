import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Auth-class signals for advertised-model tie-breaks (`resolveModelId` in `src/agents.js`).
 *
 * The ACP/status surface backpass consumes is a flat list of `provider/id` (or bare)
 * strings with no auth type. When a bare ladder id matches more than one advertised id,
 * rank by auth class - subscription over API key - using the best signal that harness
 * exposes. Provider-definition modes (path a) and the harness auth file's `type` (path
 * c2) are the Pi model; other harnesses reuse the same ranker with their own signals.
 *
 * Per-harness investigation (2026-08-30, backpass v0.1.15; advertised lists from acpx
 * status / native CLIs; auth *types* only, never secret values):
 *
 *   pi        `provider/id`. Duplicate bare ids: yes - `openai` vs `openai-codex` for
 *             seven gpt-5.x ids when `OPENAI_API_KEY` is set (reproduced with a dummy
 *             key). Dual-auth providers exist (`xai`, `anthropic`, `openrouter`,
 *             `radius`) but share one advertised id. Auth type is not on the ACP list;
 *             Pi's provider definitions plus `~/.pi/agent/auth.json` `type` (honours
 *             `PI_CODING_AGENT_DIR`). Env-var keys never appear in that file.
 *   opencode  `provider/id`. No duplicate bare ids observed (`openai` is ChatGPT OAuth
 *             here; a dummy `OPENAI_API_KEY` did not add a second provider). Dual-auth
 *             across providers is possible. Auth type in
 *             `~/.local/share/opencode/auth.json` `type` (honours `XDG_DATA_HOME`).
 *             Prefix semantics differ from Pi: OpenCode files ChatGPT OAuth under
 *             `openai`, so a global prefix preference list would mis-rank.
 *   codex     Bare ids, no slash, no collision. Dual login exists (`auth_mode: chatgpt`
 *             vs `codex login --with-api-key`) but is one model namespace - Codex
 *             picks the credential, it does not advertise two prefixed ids. Auth type
 *             is in `~/.codex/auth.json` `auth_mode` and is not an id-ranking signal.
 *   claude    Aliases (`default`, `sonnet`, `opus[1m]`, ...). `TRUSTING_MODEL_AGENTS`
 *             skips resolve. Dual auth (`claude.ai` vs API key) is on `claude auth
 *             status` (`authMethod` / `subscriptionType`), not used for id ranking.
 *   grok      Bare ids (`grok-4.6`, `grok-4.5`), no collision. grok.com OIDC vs API
 *             key is one namespace. No prefix to rank.
 *   cursor    Parameterized bare ids (`gpt-5.6-luna[context=...]`), no prefixes, no
 *             collision. Dual auth (`login` vs `--api-key`) is process-level. Not on
 *             the default ladder; a custom ladder uses the same resolver.
 *   hermes    Discovery only; not an acpx model-resolution backend.
 *
 * Harnesses with no auth-class signal (codex/claude/grok/cursor, and custom-ladder
 * acpx agents) keep unique matches unchanged and refuse unrankable collisions loudly.
 */

/** @typedef {"subscription" | "api_key"} AuthClass */

/**
 * Pi built-in provider auth modes from Pi's own provider definitions
 * (`docs/providers.md`). Dual-auth providers (`xai`, `anthropic`, `openrouter`,
 * `radius`) are omitted so a live `auth.json` `type` decides. Without that signal,
 * their auth class remains unknown.
 *
 * This is a mode table, not a winner list: ranking is always subscription over
 * API key, never a named-provider preference order.
 */
export const PI_PROVIDER_AUTH_MODE = {
  "openai-codex": "subscription",
  "github-copilot": "subscription",
  openai: "api_key",
};

/** Provider prefix before the first `/`; empty when the id is bare. */
export function providerOf(advertisedId) {
  const text = String(advertisedId);
  const slash = text.indexOf("/");
  return slash === -1 ? "" : text.slice(0, slash);
}

/**
 * Map a harness credential `type` onto the two ranking classes.
 * @param {unknown} type
 * @returns {AuthClass | null}
 */
export function credentialTypeToAuthClass(type) {
  if (type === "oauth" || type === "oidc" || type === "chatgpt") return "subscription";
  if (type === "api_key" || type === "api") return "api_key";
  return null;
}

/**
 * Pull `{ provider: authClass }` out of a harness auth.json object. Values that are
 * not objects, or whose `type` is unknown, are skipped - never guessed from key names.
 * @param {unknown} value
 * @returns {Record<string, AuthClass>}
 */
export function parseAuthFileTypes(value) {
  /** @type {Record<string, AuthClass>} */
  const types = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return types;
  for (const [provider, rec] of Object.entries(value)) {
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
    const mapped = credentialTypeToAuthClass(/** @type {{ type?: unknown }} */ (rec).type);
    if (mapped) types[provider] = mapped;
  }
  return types;
}

function readJsonObject(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // Missing, unreadable, or invalid: degrade to provider definitions.
  }
  return null;
}

export function piAuthFilePath({ env = process.env, homedir = os.homedir() } = {}) {
  const override = env.PI_CODING_AGENT_DIR;
  if (typeof override === "string" && override.trim()) return path.join(override.trim(), "auth.json");
  return path.join(homedir, ".pi", "agent", "auth.json");
}

export function opencodeAuthFilePath({ env = process.env, homedir = os.homedir() } = {}) {
  const xdg = env.XDG_DATA_HOME;
  const base = typeof xdg === "string" && xdg.trim() ? xdg.trim() : path.join(homedir, ".local", "share");
  return path.join(base, "opencode", "auth.json");
}

export function providerAuthState(agent, options = {}) {
  const { env = process.env, homedir = os.homedir() } = options;
  const file =
    options.authFile === undefined
      ? agent === "pi"
        ? piAuthFilePath({ env, homedir })
        : agent === "opencode"
          ? opencodeAuthFilePath({ env, homedir })
          : null
      : options.authFile;
  const hash = crypto.createHash("sha256");
  hash.update(`${agent}\0${file || ""}\0`);
  if (file) {
    try {
      hash.update(fs.readFileSync(file));
    } catch {
      hash.update("missing");
    }
  }
  const credentialEnv = Object.entries(env)
    .filter(
      ([name, value]) =>
        typeof value === "string" && /(?:^|_)(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_ACCESS_KEY)$/.test(name),
    )
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [name, value] of credentialEnv) hash.update(`\0${name}\0${value}`);
  return hash.digest("hex");
}

/**
 * Auth-class map for one harness. File reads are fail-soft and never log contents.
 *
 * @param {string} agent
 * @param {{ advertised?: string[], env?: NodeJS.ProcessEnv, homedir?: string,
 *   authFile?: string | null }} [options]
 * @returns {Record<string, AuthClass>}
 */
export function readProviderAuthTypes(agent, options = {}) {
  const { env = process.env, homedir = os.homedir() } = options;
  /** @type {Record<string, AuthClass>} */
  const types = {};
  if (agent === "pi") Object.assign(types, PI_PROVIDER_AUTH_MODE);

  const file =
    options.authFile === undefined
      ? agent === "pi"
        ? piAuthFilePath({ env, homedir })
        : agent === "opencode"
          ? opencodeAuthFilePath({ env, homedir })
          : null
      : options.authFile;
  if (file && (agent === "pi" || agent === "opencode")) {
    const parsed = readJsonObject(file);
    if (parsed) Object.assign(types, parseAuthFileTypes(parsed));
  }

  return types;
}

/**
 * Rank colliding advertised ids by auth class. Exactly one subscription and the
 * rest API-key wins; anything else (unknown, two subscriptions, two API keys) refuses.
 *
 * @param {string[]} colliding
 * @param {Record<string, AuthClass> | undefined} providerAuthTypes
 * @returns {{ id: string, tieBreak: { preferred: string, over: string[] } }
 *   | { id: null, ambiguous: string[] }}
 */
export function rankCollidingIds(colliding, providerAuthTypes) {
  if (!Array.isArray(colliding) || colliding.length < 2) {
    return { id: null, ambiguous: colliding || [] };
  }
  if (!providerAuthTypes || typeof providerAuthTypes !== "object") {
    return { id: null, ambiguous: colliding };
  }
  const classes = colliding.map((id) => ({
    id,
    auth: providerAuthTypes[providerOf(id)] || null,
  }));
  if (classes.some((row) => !row.auth)) return { id: null, ambiguous: colliding };
  const subscription = classes.filter((row) => row.auth === "subscription");
  const apiKey = classes.filter((row) => row.auth === "api_key");
  if (subscription.length === 1 && apiKey.length === classes.length - 1) {
    return {
      id: subscription[0].id,
      tieBreak: { preferred: subscription[0].id, over: apiKey.map((row) => row.id) },
    };
  }
  return { id: null, ambiguous: colliding };
}

/** Probe/ladder copy when a collision cannot be ranked. */
export function ambiguousModelDetail(ids, { source = "advertised ids" } = {}) {
  return `ambiguous among ${source}: ${ids.join(", ")} (cannot rank auth types; disambiguate with a provider-qualified id)`;
}
