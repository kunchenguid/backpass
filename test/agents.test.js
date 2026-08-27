import test from "node:test";
import assert from "node:assert/strict";

import {
  AgentResolver,
  candidateKey,
  flattenLadder,
  isProbeEntryFresh,
  probeCandidate,
  resolveModelId,
} from "../src/agents.js";
import { AcpxError, acpxAgentName, classifyAcpxFailure, effortOptionKey } from "../src/acpx.js";
import { DEFAULT_LADDERS, loadConfig } from "../src/config.js";
import { UserError, setQuiet } from "../src/logger.js";

setQuiet(true);

/** In-memory stand-in for `State`'s probe cache. */
function memoryState(initial = { version: 1, acpxVersion: "0.13.0", entries: {} }) {
  let cache = structuredClone(initial);
  return {
    readProbeCache: () => structuredClone(cache),
    writeProbeCache: (value) => {
      cache = structuredClone(value);
    },
    get cache() {
      return cache;
    },
  };
}

/**
 * A scripted probe: `verdicts` maps "agent|model" to the probe outcome. Unlisted
 * candidates read as not installed. Every probe is recorded so tests can assert on
 * the walk order and on caching.
 */
function scriptedProbe(verdicts) {
  const calls = [];
  const probe = async (candidate) => {
    calls.push(candidateKey(candidate));
    const v = verdicts[candidateKey(candidate)];
    if (!v) return { verdict: "unreachable", detail: "not installed", resolvedModel: null };
    if (typeof v === "string") return { verdict: v, detail: "", resolvedModel: null };
    return { verdict: "ok", detail: "", resolvedModel: candidate.model, ...v };
  };
  return { probe, calls };
}

/**
 * @param {Record<string, any>} verdicts
 * @param {{ config?: any, state?: ReturnType<typeof memoryState>, now?: () => number,
 *   bypassCache?: boolean, acpxVersion?: () => Promise<string | null> }} [options]
 */
function resolverWith(verdicts, { config = loadConfig(tmpRepo()), state = memoryState(), ...deps } = {}) {
  const { probe, calls } = scriptedProbe(verdicts);
  const resolver = new AgentResolver(config, {
    state,
    probeCandidate: probe,
    acpxVersion: async () => "0.13.0",
    ...deps,
  });
  return { resolver, calls, state };
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_FILENAME } from "../src/config.js";

function tmpRepo(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-agents-"));
  if (config) fs.writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify(config));
  return dir;
}

function authRequired(agent) {
  return new AcpxError(`acpx ${agent} session prompt failed (exit 1)`, {
    stderr: "[acpx] error: RUNTIME AUTH_REQUIRED Authentication required\n",
    code: 1,
  });
}

test("the ladders flatten model-outer, harness-inner, in the captain's order", () => {
  assert.deepEqual(
    flattenLadder(DEFAULT_LADDERS.analysis).map((c) => `${c.model}@${c.agent}`),
    [
      "gpt-5.6-luna@pi",
      "gpt-5.6-luna@opencode",
      "gpt-5.6-luna@codex",
      "claude-sonnet-5@claude",
      "grok-4.6@pi",
      "grok-4.6@opencode",
      "grok-4.6@grok",
    ],
  );
  assert.equal(flattenLadder(DEFAULT_LADDERS.synthesis)[0].model, "gpt-5.6-sol");
  assert.equal(flattenLadder(DEFAULT_LADDERS.synthesis)[3].model, "claude-opus-5");
});

test("ordered selection picks the first available+authed candidate per role", async () => {
  const { resolver, calls } = resolverWith({
    "pi|gpt-5.6-luna": "unauthenticated",
    "opencode|gpt-5.6-luna": "model-unavailable",
    "codex|gpt-5.6-luna": { resolvedModel: "gpt-5.6-luna" },
    "pi|gpt-5.6-sol": "timeout",
    "opencode|gpt-5.6-sol": "model-unavailable",
    "codex|gpt-5.6-sol": "unauthenticated",
    "claude|claude-opus-5": { resolvedModel: "claude-opus-5" },
  });

  const analysis = await resolver.resolve("analysis");
  assert.equal(analysis.agent, "codex");
  assert.equal(analysis.model, "gpt-5.6-luna");
  assert.equal(analysis.effort, "medium", "analysis defaults to medium effort");
  assert.equal(analysis.pinned, false);
  assert.match(analysis.reason, /pi\/gpt-5.6-luna \(not logged in\)/);

  const synthesis = await resolver.resolve("synthesis");
  assert.equal(synthesis.agent, "claude");
  assert.equal(synthesis.model, "claude-opus-5");
  assert.equal(synthesis.effort, "high", "synthesis defaults to high effort");

  assert.deepEqual(
    calls,
    [
      "pi|gpt-5.6-luna",
      "opencode|gpt-5.6-luna",
      "codex|gpt-5.6-luna",
      "pi|gpt-5.6-sol",
      "opencode|gpt-5.6-sol",
      "codex|gpt-5.6-sol",
      "claude|claude-opus-5",
    ],
    "the walk stops at the first ok and never probes lower rungs",
  );
});

test("the resolved model id is the adapter's spelling, never the bare id", async () => {
  const { resolver } = resolverWith({ "pi|gpt-5.6-luna": { resolvedModel: "openai-codex/gpt-5.6-luna" } });
  const pick = await resolver.resolve("analysis");
  assert.equal(pick.agent, "pi");
  assert.equal(pick.model, "openai-codex/gpt-5.6-luna");
  assert.equal(pick.ladderModel, "gpt-5.6-luna");
});

test("claude is decided by `claude auth status`, not by the acpx session probe", async () => {
  // The acpx probe for claude always says ok (a logged-out claude still creates a
  // session). Run the real native check against a fake `claude` on PATH and assert
  // the verdict comes from it.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-fakebin-"));
  const script = path.join(bin, "claude");
  const marker = path.join(bin, "acpx-probe-was-called");
  fs.writeFileSync(
    script,
    `#!/bin/sh\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo '{"loggedIn": false, "authMethod": "none"}'; exit 1; fi\nexit 2\n`,
  );
  fs.chmodSync(script, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    let acpxProbed = false;
    const verdict = await probeCandidate(
      { agent: "claude", model: "claude-sonnet-5" },
      {
        sessionName: "t",
        probeSession: async () => {
          acpxProbed = true;
          fs.writeFileSync(marker, "");
          return { verdict: "ok", detail: "", availableModels: ["default", "sonnet", "opus[1m]"] };
        },
      },
    );
    assert.equal(verdict.verdict, "unauthenticated");
    assert.match(verdict.detail, /loggedIn=false/);
    assert.equal(acpxProbed, false, "a logged-out claude never reaches the (false-positive) acpx probe");

    // Logged in: the native check passes, the acpx probe runs, and the model is taken on faith.
    fs.writeFileSync(
      script,
      `#!/bin/sh\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo '{"loggedIn": true, "authMethod": "claude.ai"}'; exit 0; fi\nexit 2\n`,
    );
    const ok = await probeCandidate(
      { agent: "claude", model: "claude-sonnet-5" },
      {
        sessionName: "t",
        probeSession: async () => ({ verdict: "ok", detail: "", availableModels: ["default", "sonnet"] }),
      },
    );
    assert.equal(ok.verdict, "ok");
    assert.equal(ok.resolvedModel, "claude-sonnet-5", "claude forwards any id; it is not matched against the list");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("non-claude candidates resolve the bare id against the advertised list", async () => {
  const piLike = async () => ({
    verdict: "ok",
    detail: "",
    availableModels: ["kimi-coding/k3", "openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol", "xai/grok-4.6"],
  });
  const luna = await probeCandidate({ agent: "pi", model: "gpt-5.6-luna" }, { sessionName: "t", probeSession: piLike });
  assert.deepEqual([luna.verdict, luna.resolvedModel], ["ok", "openai-codex/gpt-5.6-luna"]);

  const missing = await probeCandidate(
    { agent: "pi", model: "claude-opus-5" },
    { sessionName: "t", probeSession: piLike },
  );
  assert.equal(missing.verdict, "model-unavailable");

  const unauth = await probeCandidate(
    { agent: "codex", model: "gpt-5.6-luna" },
    {
      sessionName: "t",
      probeSession: async () => ({
        verdict: "unauthenticated",
        detail: "Authentication required",
        availableModels: [],
      }),
    },
  );
  assert.equal(unauth.verdict, "unauthenticated");
});

test("AUTH_REQUIRED mid-run falls through to the next candidate", async () => {
  const { resolver, calls, state } = resolverWith({
    "pi|gpt-5.6-luna": { resolvedModel: "openai-codex/gpt-5.6-luna" },
    "opencode|gpt-5.6-luna": "model-unavailable",
    "codex|gpt-5.6-luna": { resolvedModel: "gpt-5.6-luna" },
  });

  const attempts = [];
  const result = await resolver.withFallthrough("analysis", async (pick) => {
    attempts.push(`${pick.agent}/${pick.model}`);
    if (pick.agent === "pi") throw authRequired("pi");
    return "evidence";
  });

  assert.equal(result, "evidence");
  assert.deepEqual(attempts, ["pi/openai-codex/gpt-5.6-luna", "codex/gpt-5.6-luna"]);
  assert.deepEqual(calls, ["pi|gpt-5.6-luna", "opencode|gpt-5.6-luna", "codex|gpt-5.6-luna"]);
  assert.equal(state.cache.entries["pi|gpt-5.6-luna"].verdict, "unauthenticated", "the failure is remembered");
  assert.equal((await resolver.resolve("analysis")).agent, "codex", "later calls in the run stay on the fallback");
});

test("parallel workers failing on the same candidate fall through once, together", async () => {
  const { resolver } = resolverWith({
    "pi|gpt-5.6-luna": { resolvedModel: "openai-codex/gpt-5.6-luna" },
    "codex|gpt-5.6-luna": { resolvedModel: "gpt-5.6-luna" },
  });
  const picks = [];
  await Promise.all(
    [1, 2, 3].map(() =>
      resolver.withFallthrough("analysis", async (pick) => {
        picks.push(pick.agent);
        if (pick.agent === "pi") throw authRequired("pi");
        return "ok";
      }),
    ),
  );
  assert.deepEqual(picks.filter((p) => p === "codex").length, 3);
  assert.equal(resolver.probeCount, 3, "pi, opencode, codex - probed once each despite three workers");
});

test("only classifiable failures fall through; real-work errors propagate unchanged", async () => {
  const { resolver } = resolverWith({
    "pi|gpt-5.6-luna": { resolvedModel: "openai-codex/gpt-5.6-luna" },
    "codex|gpt-5.6-luna": { resolvedModel: "gpt-5.6-luna" },
  });
  const timeout = new AcpxError("acpx pi session prompt timed out after 300s", { timedOut: true, stderr: "" });
  await assert.rejects(
    resolver.withFallthrough("analysis", async () => {
      throw timeout;
    }),
    (err) => err === timeout,
  );
  assert.equal((await resolver.resolve("analysis")).agent, "pi", "a timeout on real work does not demote");
  await assert.rejects(
    resolver.withFallthrough("analysis", async () => {
      throw new Error("analysis returned no parseable JSON");
    }),
    /no parseable JSON/,
  );
});

test("explicit config or CLI flags pin the role and skip the ladder entirely", async () => {
  const config = loadConfig(tmpRepo({ analysis: { agent: "grok" } }), {
    synthesis: { agent: "claude", model: "claude-opus-5", effort: "max" },
  });
  const { resolver, calls } = resolverWith({}, { config });

  const analysis = await resolver.resolve("analysis");
  assert.deepEqual(
    { agent: analysis.agent, model: analysis.model, effort: analysis.effort, pinned: analysis.pinned },
    { agent: "grok", model: null, effort: "medium", pinned: true },
  );
  const synthesis = await resolver.resolve("synthesis");
  assert.deepEqual(
    { agent: synthesis.agent, model: synthesis.model, effort: synthesis.effort, pinned: synthesis.pinned },
    { agent: "claude", model: "claude-opus-5", effort: "max", pinned: true },
  );
  assert.deepEqual(calls, [], "nothing was probed");

  // A pinned agent is the user's decision: an auth failure surfaces, it does not fall through.
  await assert.rejects(
    resolver.withFallthrough("synthesis", async () => {
      throw authRequired("claude");
    }),
    AcpxError,
  );
});

test("--no-auto-agent pins the pre-ladder defaults", async () => {
  const config = loadConfig(tmpRepo(), { autoAgent: false });
  const { resolver, calls } = resolverWith({}, { config });
  assert.equal((await resolver.resolve("analysis")).agent, "codex");
  assert.equal((await resolver.resolve("synthesis")).agent, "claude");
  assert.equal((await resolver.resolve("synthesis")).effort, "high");
  assert.deepEqual(calls, []);
});

test("an exhausted ladder fails with one actionable error listing every candidate", async () => {
  const { resolver } = resolverWith({
    "pi|gpt-5.6-sol": "unauthenticated",
    "codex|gpt-5.6-sol": "unauthenticated",
    "claude|claude-opus-5": "unauthenticated",
    "grok|grok-4.6": "timeout",
  });
  await assert.rejects(
    () => resolver.resolve("synthesis"),
    (err) => {
      assert.ok(err instanceof UserError);
      assert.match(err.message, /no available agent for the synthesis pass/);
      for (const line of [
        /gpt-5.6-sol\s+pi\s+not logged in.*pi login/,
        /gpt-5.6-sol\s+opencode\s+not installed/,
        /gpt-5.6-sol\s+codex\s+not logged in.*codex login/,
        /claude-opus-5\s+claude\s+not logged in.*claude auth login/,
        /grok-4.6\s+grok\s+probe timed out/,
      ]) {
        assert.match(err.message, line);
      }
      assert.match(err.hint, /--synthesis-agent <agent> --synthesis-model <id>/);
      return true;
    },
  );
});

test("a missing acpx is reported once, not once per candidate", async () => {
  const config = loadConfig(tmpRepo());
  let probes = 0;
  const resolver = new AgentResolver(config, {
    state: memoryState(),
    acpxVersion: async () => null,
    probeCandidate: async () => {
      probes += 1;
      throw new AcpxError('acpx not found on PATH (looked for "acpx")');
    },
  });
  await assert.rejects(
    () => resolver.resolve("analysis"),
    (err) => err instanceof UserError && /acpx not found/.test(err.message),
  );
  assert.equal(probes, 1);
});

test("probe verdicts are cached with TTLs and invalidated on an acpx version change", async () => {
  let now = Date.parse("2026-08-22T00:00:00Z");
  const state = memoryState();
  const verdicts = {
    "pi|gpt-5.6-luna": "unauthenticated",
    "opencode|gpt-5.6-luna": { resolvedModel: "openai/gpt-5.6-luna" },
  };

  const first = resolverWith(verdicts, { state, now: () => now });
  assert.equal((await first.resolver.resolve("analysis")).agent, "opencode");
  assert.equal(first.calls.length, 2);

  // 10 minutes later: both verdicts are fresh, nothing is probed.
  now += 10 * 60 * 1000;
  const second = resolverWith(verdicts, { state, now: () => now });
  assert.equal((await second.resolver.resolve("analysis")).agent, "opencode");
  assert.deepEqual(second.calls, []);

  // 45 minutes later: the negative expired (30min) and is re-probed; the ok (12h) is not.
  now += 35 * 60 * 1000;
  const third = resolverWith(
    { ...verdicts, "pi|gpt-5.6-luna": { resolvedModel: "openai-codex/gpt-5.6-luna" } },
    {
      state,
      now: () => now,
    },
  );
  assert.equal((await third.resolver.resolve("analysis")).agent, "pi", "logging in is picked up within 30min");
  assert.deepEqual(third.calls, ["pi|gpt-5.6-luna"]);

  // --force bypasses the cache.
  const forced = resolverWith(verdicts, { state, now: () => now, bypassCache: true });
  await forced.resolver.resolve("analysis");
  assert.ok(forced.calls.length >= 1);

  // A new acpx drops every entry.
  const upgraded = resolverWith(verdicts, { state, now: () => now, acpxVersion: async () => "0.14.0" });
  await upgraded.resolver.resolve("analysis");
  assert.deepEqual(upgraded.calls, ["pi|gpt-5.6-luna", "opencode|gpt-5.6-luna"]);
  assert.equal(state.cache.acpxVersion, "0.14.0");

  assert.equal(isProbeEntryFresh(null), false);
  assert.equal(isProbeEntryFresh({ verdict: "ok", checkedAt: "garbage" }), false);
});

test("bare model ids resolve by segment equality, never by prefix", () => {
  const opencode = ["opencode/free", "openai/gpt-5.6-luna", "openai/gpt-5.6-luna-fast", "openai/gpt-5.6-sol"];
  assert.equal(resolveModelId("gpt-5.6-luna", opencode).id, "openai/gpt-5.6-luna");
  assert.equal(resolveModelId("gpt-5.6-sol", opencode).id, "openai/gpt-5.6-sol");
  assert.equal(resolveModelId("gpt-5.6-terra", opencode).id, null);
  assert.equal(resolveModelId("gpt-5.6-luna", ["gpt-5.6-luna", "gpt-5.5"]).id, "gpt-5.6-luna");
  assert.equal(resolveModelId("opus", ["default", "opus[1m]", "sonnet"]).id, "opus[1m]");
  const ambiguous = resolveModelId("grok-4.6", ["xai/grok-4.6", "other/grok-4.6"]);
  assert.equal(ambiguous.id, null);
  assert.deepEqual(ambiguous.ambiguous, ["xai/grok-4.6", "other/grok-4.6"]);
});

test("acpx failure classification and the per-adapter tables", () => {
  assert.equal(
    classifyAcpxFailure({ stderr: "[acpx] error: RUNTIME AUTH_REQUIRED Authentication required" }),
    "unauthenticated",
  );
  assert.equal(
    classifyAcpxFailure({ stderr: "Authentication required\nhint: run `acpx config show`" }),
    "unauthenticated",
  );
  assert.equal(
    classifyAcpxFailure({ stderr: 'Cannot apply --model "x": the ACP agent did not advertise that model.' }),
    "model-unavailable",
  );
  assert.equal(classifyAcpxFailure({ spawnError: { code: "ENOENT" } }), "unreachable");
  assert.equal(classifyAcpxFailure({ stderr: "[acpx] error: TIMEOUT prompt exceeded 300s" }), null);
  assert.equal(classifyAcpxFailure({ stderr: "" }), null);

  assert.equal(acpxAgentName("grok"), "grok-build", "backpass's grok is acpx's grok-build");
  assert.equal(acpxAgentName("codex"), "codex");
  assert.equal(effortOptionKey("codex"), "reasoning_effort");
  assert.equal(effortOptionKey("claude"), "effort");
  assert.equal(effortOptionKey("pi"), null, "Pi effort is process --thinking, not ACP set");
  assert.equal(effortOptionKey("grok"), null);
});
