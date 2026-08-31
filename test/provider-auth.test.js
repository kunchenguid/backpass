import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PI_PROVIDER_AUTH_MODE,
  ambiguousModelDetail,
  credentialTypeToAuthClass,
  opencodeAuthFilePath,
  parseAuthFileTypes,
  piAuthFilePath,
  providerAuthState,
  providerOf,
  rankCollidingIds,
  readProviderAuthTypes,
} from "../src/provider-auth.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "backpass-provider-auth-"));
}

test("credential types map onto subscription vs api_key and skip unknowns", () => {
  assert.equal(credentialTypeToAuthClass("oauth"), "subscription");
  assert.equal(credentialTypeToAuthClass("oidc"), "subscription");
  assert.equal(credentialTypeToAuthClass("chatgpt"), "subscription");
  assert.equal(credentialTypeToAuthClass("api_key"), "api_key");
  assert.equal(credentialTypeToAuthClass("api"), "api_key");
  assert.equal(credentialTypeToAuthClass("unknown"), null);
  assert.equal(credentialTypeToAuthClass(undefined), null);
});

test("parseAuthFileTypes reads type only and ignores non-objects", () => {
  assert.deepEqual(
    parseAuthFileTypes({
      "openai-codex": { type: "oauth", access: "secret-must-not-be-copied", refresh: "also-secret" },
      openai: { type: "api_key", key: "sk-secret" },
      xai: { type: "mystery" },
      bare: "oauth",
    }),
    { "openai-codex": "subscription", openai: "api_key" },
  );
  assert.deepEqual(parseAuthFileTypes(null), {});
  assert.deepEqual(parseAuthFileTypes([]), {});
});

test("rankCollidingIds prefers the sole subscription provider and refuses the rest", () => {
  const pair = ["openai/gpt-5.6-luna", "openai-codex/gpt-5.6-luna"];
  const ranked = rankCollidingIds(pair, { openai: "api_key", "openai-codex": "subscription" });
  assert.equal(ranked.id, "openai-codex/gpt-5.6-luna");
  if (!("tieBreak" in ranked)) throw new Error("expected a tie-break");
  assert.deepEqual(ranked.tieBreak, { preferred: "openai-codex/gpt-5.6-luna", over: ["openai/gpt-5.6-luna"] });

  const reversed = rankCollidingIds([...pair].reverse(), { openai: "api_key", "openai-codex": "subscription" });
  assert.equal(reversed.id, "openai-codex/gpt-5.6-luna");

  const unrankable = rankCollidingIds(pair, {});
  assert.equal(unrankable.id, null);
  if (!("ambiguous" in unrankable)) throw new Error("expected an unrankable collision");
  assert.deepEqual(unrankable.ambiguous, pair);

  const twoSubs = rankCollidingIds(["a/x", "b/x"], { a: "subscription", b: "subscription" });
  assert.equal(twoSubs.id, null);
  if (!("ambiguous" in twoSubs)) throw new Error("expected an unrankable collision");
  assert.deepEqual(twoSubs.ambiguous, ["a/x", "b/x"]);

  const twoKeys = rankCollidingIds(["a/x", "b/x"], { a: "api_key", b: "api_key" });
  assert.equal(twoKeys.id, null);

  const unknownHalf = rankCollidingIds(["a/x", "b/x"], { a: "subscription" });
  assert.equal(unknownHalf.id, null);

  const nested = rankCollidingIds(["openrouter/vendor/x", "direct/vendor/x"], {
    openrouter: "subscription",
    direct: "api_key",
  });
  assert.equal(nested.id, "openrouter/vendor/x");
});

test("pi auth.json types overlay definitions while unknown providers stay unknown", () => {
  const dir = tmpDir();
  const authFile = path.join(dir, "auth.json");
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      "openai-codex": { type: "oauth", access: "x" },
      xai: { type: "oauth", access: "y" },
    }),
  );
  const types = readProviderAuthTypes("pi", {
    advertised: ["openai/gpt-5.6-luna", "openai-codex/gpt-5.6-luna", "xai/grok-4.6"],
    authFile,
    homedir: dir,
  });
  assert.equal(types["openai-codex"], "subscription");
  assert.equal(types.openai, "api_key", "provider definition");
  assert.equal(types.xai, "subscription", "live dual-auth type from auth.json");
  assert.equal(PI_PROVIDER_AUTH_MODE.openai, "api_key");

  const withoutAuth = readProviderAuthTypes("pi", {
    advertised: ["openai-codex/gpt-5.6-luna", "xai/gpt-5.6-luna"],
    authFile: path.join(dir, "missing.json"),
  });
  assert.equal(withoutAuth["openai-codex"], "subscription");
  assert.equal(withoutAuth.xai, undefined);
  assert.equal(rankCollidingIds(["openai-codex/gpt-5.6-luna", "xai/gpt-5.6-luna"], withoutAuth).id, null);
});

test("pi definitions alone rank openai vs openai-codex without an auth file", () => {
  const types = readProviderAuthTypes("pi", {
    advertised: ["openai/gpt-5.6-luna", "openai-codex/gpt-5.6-luna"],
    authFile: path.join(tmpDir(), "missing.json"),
    homedir: tmpDir(),
  });
  assert.equal(types["openai-codex"], "subscription");
  assert.equal(types.openai, "api_key");
  const ranked = rankCollidingIds(["openai/gpt-5.6-luna", "openai-codex/gpt-5.6-luna"], types);
  assert.equal(ranked.id, "openai-codex/gpt-5.6-luna");
});

test("opencode auth types come from its auth.json, not Pi's openai=api_key definition", () => {
  const dir = tmpDir();
  const authFile = path.join(dir, "auth.json");
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      openai: { type: "oauth", access: "x" },
      anthropic: { type: "api_key", key: "y" },
    }),
  );
  const types = readProviderAuthTypes("opencode", {
    advertised: ["openai/gpt-5.6-luna", "anthropic/gpt-5.6-luna"],
    authFile,
    homedir: dir,
  });
  assert.equal(types.openai, "subscription", "OpenCode files ChatGPT OAuth under openai");
  assert.equal(types.anthropic, "api_key");
  const ranked = rankCollidingIds(["openai/gpt-5.6-luna", "anthropic/gpt-5.6-luna"], types);
  assert.equal(ranked.id, "openai/gpt-5.6-luna");
});

test("provider auth state changes with credential files and environment keys", () => {
  const dir = tmpDir();
  const authFile = path.join(dir, "auth.json");
  fs.writeFileSync(authFile, JSON.stringify({ openai: { type: "api_key", key: "first" } }));
  const first = providerAuthState("pi", { authFile, env: { OPENAI_API_KEY: "env-first" } });
  assert.equal(first, providerAuthState("pi", { authFile, env: { OPENAI_API_KEY: "env-first" } }));

  fs.writeFileSync(authFile, JSON.stringify({ openai: { type: "api_key", key: "second" } }));
  const changedFile = providerAuthState("pi", { authFile, env: { OPENAI_API_KEY: "env-first" } });
  assert.notEqual(changedFile, first);
  assert.notEqual(providerAuthState("pi", { authFile, env: { OPENAI_API_KEY: "env-second" } }), changedFile);
});

test("codex, claude, grok, and cursor expose no auth-class map", () => {
  for (const agent of ["codex", "claude", "grok", "cursor"]) {
    assert.deepEqual(readProviderAuthTypes(agent, { advertised: ["gpt-5.6-luna", "openai/gpt-5.6-luna"] }), {});
  }
});

test("auth file path overrides honour PI_CODING_AGENT_DIR and XDG_DATA_HOME", () => {
  assert.equal(
    piAuthFilePath({ env: { PI_CODING_AGENT_DIR: "/tmp/pi-agent" } }),
    path.join("/tmp/pi-agent", "auth.json"),
  );
  assert.equal(
    piAuthFilePath({ env: {}, homedir: "/home/user" }),
    path.join("/home/user", ".pi", "agent", "auth.json"),
  );
  assert.equal(
    opencodeAuthFilePath({ env: { XDG_DATA_HOME: "/tmp/xdg" } }),
    path.join("/tmp/xdg", "opencode", "auth.json"),
  );
  assert.equal(
    opencodeAuthFilePath({ env: {}, homedir: "/home/user" }),
    path.join("/home/user", ".local", "share", "opencode", "auth.json"),
  );
});

test("ambiguousModelDetail names the ids and how to disambiguate", () => {
  const detail = ambiguousModelDetail(["openai/gpt-5.6-luna", "other/gpt-5.6-luna"]);
  assert.match(detail, /openai\/gpt-5.6-luna/);
  assert.match(detail, /other\/gpt-5.6-luna/);
  assert.match(detail, /provider-qualified/);
  assert.equal(providerOf("openai-codex/gpt-5.6-luna"), "openai-codex");
  assert.equal(providerOf("openrouter/vendor/gpt-5.6-luna"), "openrouter");
  assert.equal(providerOf("gpt-5.6-luna"), "");
});
