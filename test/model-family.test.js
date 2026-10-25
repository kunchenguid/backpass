import test from "node:test";
import assert from "node:assert/strict";

import { newestInFamily, parseModelId } from "../src/model-family.js";

test("parseModelId splits an advertised id into family, version, and tier", () => {
  assert.deepEqual(parseModelId("openai-codex/gpt-6.1-sol"), { family: "gpt", version: [6, 1], tier: "sol" });
  assert.deepEqual(parseModelId("gpt-6-luna"), { family: "gpt", version: [6], tier: "luna" });
  assert.deepEqual(parseModelId("gpt-5.6-luna:medium"), {
    family: "gpt",
    version: [5, 6],
    tier: "luna",
  });
  assert.deepEqual(parseModelId("grok-4.6"), { family: "grok", version: [4, 6], tier: "" });
  assert.deepEqual(parseModelId("claude-sonnet-5"), { family: "claude-sonnet", version: [5], tier: "" });
  assert.deepEqual(parseModelId("sonnet"), { family: "sonnet", version: null, tier: "" });
  assert.equal(parseModelId(""), null);
});

test("newestInFamily picks the highest version in the family and tier", () => {
  const advertised = [
    "openai-codex/gpt-6.1-sol",
    "openai-codex/gpt-6-luna",
    "openai-codex/gpt-5.6-sol",
    "openai-codex/gpt-5.6-luna",
  ];
  assert.equal(newestInFamily(advertised, "gpt", "sol", "openai-codex"), "openai-codex/gpt-6.1-sol");
  assert.equal(newestInFamily(advertised, "gpt", "luna", "openai-codex"), "openai-codex/gpt-6-luna");
});

test("newestInFamily compares dotted versions segment by segment", () => {
  const advertised = ["openai-codex/gpt-10-sol", "openai-codex/gpt-9.9-sol", "openai-codex/gpt-10.2-sol"];
  assert.equal(newestInFamily(advertised, "gpt", "sol", "openai-codex"), "openai-codex/gpt-10.2-sol");
});

test("newestInFamily returns null when nothing fits the family or tier", () => {
  const advertised = ["openai-codex/gpt-6-luna", "xai/grok-4.6"];
  assert.equal(newestInFamily(advertised, "gpt", "sol", "openai-codex"), null);
  assert.equal(newestInFamily(advertised, "gpt", "luna-fast", "openai-codex"), null);
  assert.equal(newestInFamily(advertised, "claude", "", "anthropic"), null);
  assert.equal(newestInFamily([], "gpt", "", "openai-codex"), null);
});

test("a tier-less rung prefers the base id over a decorated variant at the same version", () => {
  const advertised = ["grok-4.6-fast", "grok-4.6", "grok-4.5"];
  assert.equal(newestInFamily(advertised, "grok", "", "xai"), "grok-4.6");
});

test("a family rung resolves only inside its declared provider", () => {
  const advertised = [
    "openai/gpt-6-luna",
    "openrouter/openai/gpt-6-luna",
    "openai-codex/gpt-6-luna",
    "openai-codex/gpt-5.6-luna",
  ];
  assert.equal(newestInFamily(advertised, "gpt", "luna", "openai-codex"), "openai-codex/gpt-6-luna");
  assert.equal(newestInFamily(advertised, "gpt", "luna", "openai"), "openai/gpt-6-luna");
  assert.equal(newestInFamily(advertised, "gpt", "luna", "google"), null);
  assert.equal(
    newestInFamily(advertised, "gpt", "luna", ""),
    null,
    "a rung that names no provider never resolves across providers",
  );
});

test("a bare advertised id belongs to the adapter's own provider", () => {
  assert.equal(newestInFamily(["gpt-6.1-sol"], "gpt", "sol", "openai-codex"), "gpt-6.1-sol");
  assert.equal(newestInFamily(["xai/grok-4.6"], "grok", "", "openai-codex"), null);
});
