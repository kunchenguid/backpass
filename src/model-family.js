/**
 * Model family + tier resolution.
 *
 * A ladder rung names a *family* and an optional *tier* (`{ family: "gpt", tier: "sol" }`)
 * instead of a generation id. The generation itself is chosen at probe time from the
 * catalog the harness advertises, so a newer model in the same family/tier is picked up
 * without a backpass release. The catalog is authoritative: nothing here guesses what a
 * harness can serve.
 *
 * `parseModelId` splits an advertised id into the same pieces:
 * `provider/family-9.2-tier` -> family `family`, version `[9, 2]`, tier `tier`. A
 * provider prefix and any trailing `:effort` overlay are stripped first, then the
 * first numeric token is the version - tokens before it are the family, non-numeric
 * tokens after it are the tier.
 */

/** A version token: one or more dot-separated numbers (`6`, `6.1`, `5.6.3`). */
const VERSION_TOKEN = /^\d+(?:\.\d+)*$/;
/** A trailing ACP effort overlay such as `:medium`; not part of the model id. */
const EFFORT_SUFFIX = /:[a-z0-9._-]+$/i;

/** Drop a provider prefix (`openrouter/vendor/id`) and any `:effort` overlay. */
function bareId(raw) {
  let id = String(raw ?? "").trim();
  if (!id) return "";
  const slash = id.lastIndexOf("/");
  if (slash !== -1) id = id.slice(slash + 1);
  return id.replace(EFFORT_SUFFIX, "");
}

/**
 * @param {string} raw an advertised or configured model id
 * @returns {{ family: string, tier: string, version: number[] | null } | null}
 */
export function parseModelId(raw) {
  const id = bareId(raw);
  if (!id) return null;
  const tokens = id.split("-").filter(Boolean);
  const at = tokens.findIndex((token) => VERSION_TOKEN.test(token));
  if (at === -1) {
    return { family: tokens.join("-").toLowerCase(), tier: "", version: null };
  }
  return {
    family: tokens.slice(0, at).join("-").toLowerCase(),
    tier: tokens
      .slice(at + 1)
      .filter((token) => !VERSION_TOKEN.test(token))
      .join("-")
      .toLowerCase(),
    version: tokens[at].split(".").map(Number),
  };
}

/** Compare dotted versions segment by segment; a missing version sorts below any real one. */
function compareVersions(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/** The provider a catalog id names, or `""` when the id is bare. */
export function providerOf(id) {
  const text = String(id ?? "").trim();
  const slash = text.indexOf("/");
  return slash === -1 ? "" : text.slice(0, slash).toLowerCase();
}

/**
 * True when an advertised id may serve a rung that declares `provider`.
 *
 * A bare id carries no provider claim - it is the adapter's own namespace (`codex`
 * advertises `gpt-6.1-sol`, not `openai-codex/gpt-6.1-sol`) - so it is accepted. A
 * prefixed id must name the rung's provider exactly. That equality is what keeps GPT
 * work on the subscription route when a rung declares `openai-codex`: the catalog also
 * lists the same generation under the API-billed `openai` and `openrouter` namespaces,
 * and picking across them is exactly the money bug this rule deletes.
 */
export function matchesProvider(id, provider) {
  const want = String(provider ?? "")
    .trim()
    .toLowerCase();
  if (!want) return true;
  const actual = providerOf(id);
  return actual === "" || actual === want;
}

/**
 * The newest advertised id in `family` (and `tier`, when named) served by `provider`.
 *
 * Returns `null` when the catalog has nothing that fits - a missing family or provider is
 * a model-unavailable verdict, never a guess, a fallback to a sibling tier, or a pick
 * from another provider's namespace. A rung that declares no provider resolves nothing:
 * "highest version across every advertised id" is the behaviour this deletes. Ties on
 * version prefer the un-tiered id, so a `-fast` variant never wins over the base model
 * for a rung that named no tier.
 *
 * @param {string[]} advertised model ids as the harness spells them
 * @param {string} family
 * @param {string} [tier]
 * @param {string} [provider] the rung's declared provider, e.g. `openai-codex`
 * @returns {string | null}
 */
export function newestInFamily(advertised, family, tier, provider = "") {
  const wantFamily = String(family ?? "")
    .trim()
    .toLowerCase();
  if (!wantFamily) return null;
  const wantProvider = String(provider ?? "")
    .trim()
    .toLowerCase();
  if (!wantProvider) return null;
  const wantTier = String(tier ?? "")
    .trim()
    .toLowerCase();
  let best = null;
  let bestVersion = null;
  let bestExactTier = false;
  for (const id of advertised || []) {
    if (!matchesProvider(id, wantProvider)) continue;
    const parsed = parseModelId(id);
    if (!parsed || parsed.family !== wantFamily) continue;
    if (wantTier && parsed.tier !== wantTier) continue;
    const exactTier = parsed.tier === "";
    const cmp = compareVersions(parsed.version, bestVersion);
    if (cmp > 0 || (cmp === 0 && exactTier && !bestExactTier)) {
      best = id;
      bestVersion = parsed.version;
      bestExactTier = exactTier;
    }
  }
  return best;
}
