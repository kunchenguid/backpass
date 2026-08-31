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
import { AcpxError, acpxAgentName, classifyAcpxFailure, effortOptionKey, probeSession } from "../src/acpx.js";
import { DEFAULT_LADDERS, loadConfig } from "../src/config.js";
import { UserError, setLoggerSink, setQuiet } from "../src/logger.js";

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
  const queues = Object.create(null);
  const probe = async (candidate) => {
    calls.push(candidateKey(candidate));
    const key = candidateKey(candidate);
    let v = verdicts[key];
    if (Array.isArray(v)) {
      if (!queues[key]) queues[key] = [...v];
      v = queues[key].length > 1 ? queues[key].shift() : queues[key][0];
    }
    if (!v) return { verdict: "unreachable", detail: "not installed", resolvedModel: null };
    if (typeof v === "string") return { verdict: v, detail: "", resolvedModel: null };
    return { verdict: "ok", detail: "", resolvedModel: candidate.model, ...v };
  };
  return { probe, calls };
}

/**
 * @param {Record<string, any>} verdicts
 * @param {{ config?: any, state?: ReturnType<typeof memoryState>, now?: () => number,
 *   bypassCache?: boolean, acpxVersion?: () => Promise<string | null>,
 *   providerAuthState?: (agent: string) => string,
 *   sleep?: (ms: number) => Promise<void> }} [options]
 */
function resolverWith(
  verdicts,
  { config = loadConfig(tmpRepo()), state = memoryState(), sleep = async () => {}, ...deps } = {},
) {
  const { probe, calls } = scriptedProbe(verdicts);
  const resolver = new AgentResolver(config, {
    state,
    probeCandidate: probe,
    acpxVersion: async () => "0.13.0",
    sleep,
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

test("the real ladder keeps Pi when its ambiguous model has a subscription winner", async () => {
  const config = loadConfig(tmpRepo());
  config.ladders.analysis = [{ model: "gpt-5.6-luna", agents: ["pi", "codex"] }];
  const calls = [];
  const resolver = new AgentResolver(config, {
    state: memoryState(),
    acpxVersion: async () => "0.13.0",
    probeCandidate: (candidate, options) => {
      calls.push(candidate.agent);
      return probeCandidate(candidate, {
        ...options,
        providerAuthTypes: { openai: "api_key", "openai-codex": "subscription" },
        probeSession: async () => ({
          verdict: "ok",
          detail: "",
          availableModels:
            candidate.agent === "pi" ? ["openai/gpt-5.6-luna", "openai-codex/gpt-5.6-luna"] : ["gpt-5.6-luna"],
        }),
      });
    },
  });

  const pick = await resolver.resolve("analysis");
  assert.equal(pick.agent, "pi");
  assert.equal(pick.model, "openai-codex/gpt-5.6-luna");
  assert.deepEqual(calls, ["pi"]);
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

test("an unclassified acpx probe exit remains transient when stderr has detail", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-fake-acpx-"));
  const script = path.join(bin, "acpx");
  fs.writeFileSync(script, "#!/bin/sh\necho 'another session is already running' >&2\nexit 1\n");
  fs.chmodSync(script, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    const result = await probeSession({ agent: "pi", sessionName: "busy-probe" });
    assert.equal(result.verdict, "unreachable");
    assert.equal(result.detail, "another session is already running");
    assert.equal(result.transient, true);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("native probe transients retry without caching while unsupported models demote", async () => {
  function nativeResolver(agent, nativeResults) {
    const config = loadConfig(tmpRepo());
    config.ladders.analysis = [{ model: "gpt-5.6-luna", agents: [agent, "codex"] }];
    const state = memoryState();
    const results = [...nativeResults];
    let nativeCalls = 0;
    const resolver = new AgentResolver(config, {
      state,
      acpxVersion: async () => "0.13.0",
      sleep: async () => {},
      probeCandidate: (candidate, options) =>
        probeCandidate(candidate, {
          ...options,
          runCapture: async () => {
            nativeCalls += 1;
            return results.length > 1 ? results.shift() : results[0];
          },
          probeSession: async () => ({
            verdict: "ok",
            detail: "",
            availableModels: ["openai-codex/gpt-5.6-luna"],
          }),
        }),
    });
    return { resolver, state, nativeCalls: () => nativeCalls };
  }

  const emptyThenReady = nativeResolver("opencode", [
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "openai-codex/gpt-5.6-luna\n", stderr: "" },
  ]);
  assert.equal((await emptyThenReady.resolver.resolve("analysis")).agent, "opencode");
  assert.equal(emptyThenReady.nativeCalls(), 2);

  const empty = nativeResolver("opencode", [{ code: 0, stdout: "", stderr: "" }]);
  assert.equal((await empty.resolver.resolve("analysis")).agent, "codex");
  assert.equal(empty.nativeCalls(), 2);
  assert.equal(empty.state.cache.entries["opencode|gpt-5.6-luna"], undefined);

  const timedOut = nativeResolver("claude", [{ code: null, stdout: "", stderr: "", timedOut: true }]);
  assert.equal((await timedOut.resolver.resolve("analysis")).agent, "codex");
  assert.equal(timedOut.nativeCalls(), 2);
  assert.equal(timedOut.state.cache.entries["claude|gpt-5.6-luna"], undefined);

  const stderrThenReady = nativeResolver("claude", [
    { code: 1, stdout: "", stderr: "another session is already running\n" },
    { code: 0, stdout: '{"loggedIn":true}\n', stderr: "" },
  ]);
  assert.equal((await stderrThenReady.resolver.resolve("analysis")).agent, "claude");
  assert.equal(stderrThenReady.nativeCalls(), 2);

  const unsupported = nativeResolver("opencode", [{ code: 0, stdout: "anthropic/claude-opus-5\n", stderr: "" }]);
  assert.equal((await unsupported.resolver.resolve("analysis")).agent, "codex");
  assert.equal(unsupported.nativeCalls(), 1);
  assert.equal(unsupported.state.cache.entries["opencode|gpt-5.6-luna"].verdict, "model-unavailable");
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
  const authState = () => "auth-a";
  const verdicts = {
    "pi|gpt-5.6-luna": { resolvedModel: "openai-codex/gpt-5.6-luna" },
    "opencode|gpt-5.6-luna": "model-unavailable",
    "codex|gpt-5.6-luna": { resolvedModel: "gpt-5.6-luna" },
  };
  const { resolver, calls, state } = resolverWith(verdicts, { providerAuthState: authState });

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
  assert.equal(state.cache.entries["pi|gpt-5.6-luna"].authState, "auth-a");
  assert.equal((await resolver.resolve("analysis")).agent, "codex", "later calls in the run stay on the fallback");

  const replay = resolverWith(verdicts, { state, providerAuthState: authState });
  assert.equal((await replay.resolver.resolve("analysis")).agent, "codex");
  assert.deepEqual(replay.calls, [], "the demotion remains cached while auth state is unchanged");
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
  const opencodeConfig = loadConfig(tmpRepo({ analysis: { agent: "opencode", model: "xai/grok-4.6" } }), {
    synthesis: { agent: "opencode", model: "xai/grok-4.6", effort: "xhigh" },
  });
  const { resolver: opencodeResolver, calls: opencodeCalls } = resolverWith({}, { config: opencodeConfig });
  const opencodeAnalysis = await opencodeResolver.resolve("analysis");
  assert.deepEqual(
    {
      agent: opencodeAnalysis.agent,
      model: opencodeAnalysis.model,
      effort: opencodeAnalysis.effort,
      pinned: opencodeAnalysis.pinned,
    },
    { agent: "opencode", model: "xai/grok-4.6", effort: null, pinned: true },
  );
  const opencodeSynthesis = await opencodeResolver.resolve("synthesis");
  assert.equal(opencodeSynthesis.effort, "xhigh");
  assert.deepEqual(opencodeCalls, [], "pinned OpenCode skips the ladder");

  assert.deepEqual(calls, [], "pins without a bare resolvable id are not probed");

  const bareConfig = loadConfig(tmpRepo({ analysis: { agent: "pi", model: "gpt-5.6-luna" } }));
  const { resolver: bareResolver, calls: bareCalls } = resolverWith(
    { "pi|gpt-5.6-luna": { resolvedModel: "openai-codex/gpt-5.6-luna" } },
    { config: bareConfig },
  );
  const barePick = await bareResolver.resolve("analysis");
  assert.equal(barePick.model, "openai-codex/gpt-5.6-luna");
  assert.equal(barePick.pinned, true);
  assert.deepEqual(bareCalls, ["pi|gpt-5.6-luna"]);

  const { resolver: refusedPinned } = resolverWith(
    {
      "pi|gpt-5.6-luna": {
        verdict: "model-unavailable",
        detail:
          "ambiguous among advertised ids: openai/gpt-5.6-luna, other/gpt-5.6-luna (disambiguate with a provider-qualified id)",
      },
    },
    { config: bareConfig },
  );
  await assert.rejects(
    () => refusedPinned.resolve("analysis"),
    (err) =>
      err instanceof UserError &&
      /openai\/gpt-5\.6-luna/.test(err.message) &&
      /other\/gpt-5\.6-luna/.test(err.message) &&
      /provider-qualified/.test(err.hint),
  );

  // A pinned agent is the user's decision: an auth failure surfaces as a UserError, it does not fall through.
  await assert.rejects(
    resolver.withFallthrough("synthesis", async () => {
      throw authRequired("claude");
    }),
    (err) => {
      assert.ok(err instanceof UserError);
      assert.match(err.message, /pinned synthesis agent claude/);
      assert.match(err.message, /not logged in/);
      assert.match(err.hint, /claude auth login/);
      return true;
    },
  );

  await assert.rejects(
    resolver.withFallthrough("synthesis", async () => {
      throw new AcpxError("acpx claude could not enable write session mode=agent: unsupported command");
    }),
    (err) => {
      assert.ok(err instanceof UserError);
      assert.match(err.message, /pinned synthesis agent claude/);
      assert.match(err.message, /failed unexpectedly/);
      assert.match(err.message, /unsupported command/);
      assert.match(err.hint, /check the claude\/acpx failure above and retry/);
      return true;
    },
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
  const config = loadConfig(tmpRepo());
  config.ladders.analysis = [{ model: "gpt-5.6-luna", agents: ["codex", "grok"] }];
  const verdicts = {
    "codex|gpt-5.6-luna": "unauthenticated",
    "grok|gpt-5.6-luna": { resolvedModel: "gpt-5.6-luna" },
  };

  const first = resolverWith(verdicts, { config, state, now: () => now });
  assert.equal((await first.resolver.resolve("analysis")).agent, "grok");
  assert.equal(first.calls.length, 2);

  now += 10 * 60 * 1000;
  const second = resolverWith(verdicts, { config, state, now: () => now });
  assert.equal((await second.resolver.resolve("analysis")).agent, "grok");
  assert.deepEqual(second.calls, []);

  now += 35 * 60 * 1000;
  const third = resolverWith(
    { ...verdicts, "codex|gpt-5.6-luna": { resolvedModel: "gpt-5.6-luna" } },
    { config, state, now: () => now },
  );
  assert.equal((await third.resolver.resolve("analysis")).agent, "codex", "logging in is picked up within 30min");
  assert.deepEqual(third.calls, ["codex|gpt-5.6-luna"]);

  const forced = resolverWith(verdicts, { config, state, now: () => now, bypassCache: true });
  await forced.resolver.resolve("analysis");
  assert.ok(forced.calls.length >= 1);

  const upgraded = resolverWith(verdicts, {
    config,
    state,
    now: () => now,
    acpxVersion: async () => "0.14.0",
  });
  await upgraded.resolver.resolve("analysis");
  assert.deepEqual(upgraded.calls, ["codex|gpt-5.6-luna", "grok|gpt-5.6-luna"]);
  assert.equal(state.cache.acpxVersion, "0.14.0");

  assert.equal(isProbeEntryFresh(null), false);
  assert.equal(isProbeEntryFresh({ verdict: "ok", checkedAt: "garbage" }), false);
  assert.equal(
    isProbeEntryFresh({
      verdict: "timeout",
      checkedAt: new Date(now).toISOString(),
    }),
    false,
    "a cached timeout is never treated as a durable negative",
  );
  assert.equal(
    isProbeEntryFresh({
      verdict: "unreachable",
      detail: "claude auth status exit null",
      checkedAt: new Date(now).toISOString(),
    }),
    false,
    "a legacy native timeout is never treated as a durable negative",
  );
});

test("provider-auth-sensitive cache entries are reused only while auth state matches", async () => {
  const now = Date.parse("2026-08-22T00:00:00Z");
  const state = memoryState({
    version: 1,
    acpxVersion: "0.13.0",
    entries: {
      "pi|gpt-5.6-luna": {
        verdict: "ok",
        detail: "",
        resolvedModel: "openai/gpt-5.6-luna",
        checkedAt: new Date(now).toISOString(),
        authState: "auth-a",
      },
    },
  });
  const unchanged = resolverWith(
    { "pi|gpt-5.6-luna": { resolvedModel: "openai-codex/gpt-5.6-luna" } },
    { state, now: () => now + 60_000, providerAuthState: () => "auth-a" },
  );
  assert.equal((await unchanged.resolver.resolve("analysis")).model, "openai/gpt-5.6-luna");
  assert.deepEqual(unchanged.calls, []);

  const changed = resolverWith(
    { "pi|gpt-5.6-luna": { resolvedModel: "openai-codex/gpt-5.6-luna" } },
    { state, now: () => now + 60_000, providerAuthState: () => "auth-b" },
  );
  assert.equal((await changed.resolver.resolve("analysis")).model, "openai-codex/gpt-5.6-luna");
  assert.deepEqual(changed.calls, ["pi|gpt-5.6-luna"]);
  assert.equal(state.cache.entries["pi|gpt-5.6-luna"].authState, "auth-b");
});

test("a transient probe timeout retries once and does not poison the cache", async () => {
  const delays = [];
  const state = memoryState();
  const first = resolverWith(
    {
      "pi|gpt-5.6-luna": ["timeout", { resolvedModel: "openai-codex/gpt-5.6-luna" }],
    },
    {
      state,
      sleep: async (ms) => {
        delays.push(ms);
      },
    },
  );

  const pick = await first.resolver.resolve("analysis");
  assert.equal(pick.agent, "pi");
  assert.deepEqual(first.calls, ["pi|gpt-5.6-luna", "pi|gpt-5.6-luna"]);
  assert.deepEqual(delays, [1000], "the retry waits one backoff interval");
  assert.equal(state.cache.entries["pi|gpt-5.6-luna"].verdict, "ok");

  const poisoned = memoryState();
  const miss = resolverWith(
    {
      "pi|gpt-5.6-luna": "timeout",
      "opencode|gpt-5.6-luna": { resolvedModel: "openai/gpt-5.6-luna" },
    },
    { state: poisoned },
  );
  assert.equal((await miss.resolver.resolve("analysis")).agent, "opencode");
  assert.equal(miss.calls.filter((c) => c === "pi|gpt-5.6-luna").length, 2, "timeout retries once then falls through");
  assert.equal(poisoned.cache.entries["pi|gpt-5.6-luna"], undefined, "the timeout is not persisted");

  const replay = resolverWith(
    {
      "pi|gpt-5.6-luna": { resolvedModel: "openai-codex/gpt-5.6-luna" },
    },
    { state: poisoned },
  );
  assert.equal((await replay.resolver.resolve("analysis")).agent, "pi", "the next run is free to re-probe");
  assert.deepEqual(replay.calls, ["pi|gpt-5.6-luna"]);

  const busyExit = resolverWith({
    "pi|gpt-5.6-luna": [
      {
        verdict: "unreachable",
        detail: "another session is already running",
        resolvedModel: null,
        transient: true,
      },
      { resolvedModel: "openai-codex/gpt-5.6-luna" },
    ],
  });
  assert.equal((await busyExit.resolver.resolve("analysis")).agent, "pi");
  assert.deepEqual(busyExit.calls, ["pi|gpt-5.6-luna", "pi|gpt-5.6-luna"]);
});

test("a busy empty advertised-model list retries; a genuine unsupported model still demotes", async () => {
  const emptyThenOk = resolverWith({
    "pi|gpt-5.6-luna": [
      { verdict: "model-unavailable", detail: "adapter advertised no models", resolvedModel: null },
      { resolvedModel: "openai-codex/gpt-5.6-luna" },
    ],
  });
  assert.equal((await emptyThenOk.resolver.resolve("analysis")).agent, "pi");
  assert.deepEqual(emptyThenOk.calls, ["pi|gpt-5.6-luna", "pi|gpt-5.6-luna"]);

  const { resolver, calls, state } = resolverWith({
    "pi|gpt-5.6-luna": { resolvedModel: "openai-codex/gpt-5.6-luna" },
    "opencode|gpt-5.6-luna": "model-unavailable",
    "codex|gpt-5.6-luna": { resolvedModel: "gpt-5.6-luna" },
  });
  const attempts = [];
  const result = await resolver.withFallthrough("analysis", async (pick) => {
    attempts.push(`${pick.agent}/${pick.model}`);
    if (pick.agent === "pi") {
      throw new AcpxError('Cannot apply --model "gpt-5.6-luna": the ACP agent did not advertise that model.', {
        stderr: 'Cannot apply --model "gpt-5.6-luna": the ACP agent did not advertise that model.',
        code: 1,
      });
    }
    return "evidence";
  });
  assert.equal(result, "evidence");
  assert.deepEqual(attempts, ["pi/openai-codex/gpt-5.6-luna", "codex/gpt-5.6-luna"]);
  assert.equal(
    calls.filter((c) => c === "opencode|gpt-5.6-luna").length,
    1,
    "a listed-but-missing model is not retried",
  );
  assert.equal(state.cache.entries["pi|gpt-5.6-luna"].verdict, "model-unavailable");
  assert.equal((await resolver.resolve("analysis")).agent, "codex");
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

  const nested = resolveModelId("vendor/x", ["openrouter/vendor/x", "direct/vendor/x"], {
    providerAuthTypes: { openrouter: "subscription", direct: "api_key" },
  });
  assert.equal(nested.id, "openrouter/vendor/x");
  assert.deepEqual(nested.tieBreak, {
    preferred: "openrouter/vendor/x",
    over: ["direct/vendor/x"],
  });
});

test("pi openai vs openai-codex gpt-5.6-luna prefers the subscription provider", () => {
  // Regression: with OPENAI_API_KEY set, Pi advertises the same bare id under the
  // API-key provider and the ChatGPT-subscription provider. Refusing the collision
  // used to skip pi as "model not advertised" and silently reroute the ladder.
  const advertised = ["openai/gpt-5.6-luna", "openai-codex/gpt-5.6-luna"];
  const resolved = resolveModelId("gpt-5.6-luna", advertised, {
    providerAuthTypes: { openai: "api_key", "openai-codex": "subscription" },
  });
  assert.equal(resolved.id, "openai-codex/gpt-5.6-luna");
  if (!("tieBreak" in resolved)) throw new Error("expected a tie-break");
  assert.deepEqual(resolved.tieBreak, {
    preferred: "openai-codex/gpt-5.6-luna",
    over: ["openai/gpt-5.6-luna"],
  });
});

test("each advertised-list shape ranks a subscription+API-key pair and refuses the unrankable rest", async () => {
  /** @type {Array<{
   *   agent: string,
   *   bare: string,
   *   advertised: string[],
   *   types: Record<string, "subscription" | "api_key">,
   *   prefer: string,
   *   unique: string[],
   *   uniqueId: string,
   * }>} */
  const shapes = [
    {
      agent: "pi",
      bare: "gpt-5.6-luna",
      advertised: ["openai/gpt-5.6-luna", "openai-codex/gpt-5.6-luna"],
      types: { openai: "api_key", "openai-codex": "subscription" },
      prefer: "openai-codex/gpt-5.6-luna",
      unique: ["kimi-coding/k3", "openai-codex/gpt-5.6-luna"],
      uniqueId: "openai-codex/gpt-5.6-luna",
    },
    {
      agent: "opencode",
      bare: "gpt-5.6-luna",
      advertised: ["openai/gpt-5.6-luna", "anthropic/gpt-5.6-luna"],
      types: { openai: "subscription", anthropic: "api_key" },
      prefer: "openai/gpt-5.6-luna",
      unique: ["opencode/free", "openai/gpt-5.6-luna", "openai/gpt-5.6-luna-fast"],
      uniqueId: "openai/gpt-5.6-luna",
    },
    {
      agent: "codex",
      bare: "gpt-5.6-luna",
      advertised: ["openai/gpt-5.6-luna", "azure/gpt-5.6-luna"],
      types: { openai: "subscription", azure: "api_key" },
      prefer: "openai/gpt-5.6-luna",
      unique: ["gpt-5.6-luna", "gpt-5.5"],
      uniqueId: "gpt-5.6-luna",
    },
    {
      agent: "grok",
      bare: "grok-4.6",
      advertised: ["xai/grok-4.6", "openrouter/grok-4.6"],
      types: { xai: "subscription", openrouter: "api_key" },
      prefer: "xai/grok-4.6",
      unique: ["grok-4.6", "grok-4.5"],
      uniqueId: "grok-4.6",
    },
    {
      agent: "cursor",
      bare: "gpt-5.6-luna",
      advertised: ["openai/gpt-5.6-luna", "azure/gpt-5.6-luna"],
      types: { openai: "subscription", azure: "api_key" },
      prefer: "openai/gpt-5.6-luna",
      unique: ["gpt-5.6-luna[context=272k,reasoning=medium,fast=false]", "gpt-5.5[fast=false]"],
      uniqueId: "gpt-5.6-luna[context=272k,reasoning=medium,fast=false]",
    },
  ];

  for (const shape of shapes) {
    const ranked = resolveModelId(shape.bare, shape.advertised, { providerAuthTypes: shape.types });
    assert.equal(ranked.id, shape.prefer, `${shape.agent} subscription+api_key`);
    const refused = resolveModelId(shape.bare, shape.advertised, { providerAuthTypes: {} });
    assert.equal(refused.id, null, `${shape.agent} unrankable`);
    assert.deepEqual(refused.ambiguous, shape.advertised);
    assert.equal(resolveModelId(shape.bare, shape.unique).id, shape.uniqueId, `${shape.agent} unique`);
  }

  const claude = await probeCandidate(
    { agent: "claude", model: "claude-sonnet-5" },
    {
      sessionName: "t",
      runCapture: async () => ({ code: 0, stdout: '{"loggedIn": true}\n', stderr: "" }),
      probeSession: async () => ({ verdict: "ok", detail: "", availableModels: ["default", "sonnet"] }),
    },
  );
  assert.equal(claude.resolvedModel, "claude-sonnet-5", "claude still forwards any id");

  const piProbe = await probeCandidate(
    { agent: "pi", model: "gpt-5.6-luna" },
    {
      sessionName: "t",
      probeSession: async () => ({
        verdict: "ok",
        detail: "",
        availableModels: ["openai/gpt-5.6-luna", "openai-codex/gpt-5.6-luna"],
      }),
      providerAuthTypes: { openai: "api_key", "openai-codex": "subscription" },
    },
  );
  assert.equal(piProbe.verdict, "ok");
  assert.equal(piProbe.resolvedModel, "openai-codex/gpt-5.6-luna");
  assert.match(piProbe.detail, /preferred subscription provider openai-codex\/gpt-5.6-luna over openai\/gpt-5.6-luna/);

  const loud = await probeCandidate(
    { agent: "pi", model: "gpt-5.6-luna" },
    {
      sessionName: "t",
      probeSession: async () => ({
        verdict: "ok",
        detail: "",
        availableModels: ["openai/gpt-5.6-luna", "other/gpt-5.6-luna"],
      }),
      providerAuthTypes: {},
    },
  );
  assert.equal(loud.verdict, "model-unavailable");
  assert.match(loud.detail, /openai\/gpt-5.6-luna/);
  assert.match(loud.detail, /other\/gpt-5.6-luna/);
  assert.match(loud.detail, /provider-qualified/);
});

test("a winning subscription tie-break is visible on the probe trail", async () => {
  const lines = [];
  setQuiet(false);
  setLoggerSink((line) => lines.push(String(line)));
  try {
    const { resolver } = resolverWith({
      "pi|gpt-5.6-luna": {
        resolvedModel: "openai-codex/gpt-5.6-luna",
        tieBreak: { preferred: "openai-codex/gpt-5.6-luna", over: ["openai/gpt-5.6-luna"] },
      },
    });
    await resolver.resolve("analysis");
    assert.ok(
      lines.some((line) =>
        /preferred subscription provider openai-codex\/gpt-5.6-luna over openai\/gpt-5.6-luna/.test(line),
      ),
    );
  } finally {
    setLoggerSink(null);
    setQuiet(true);
  }
});

test("opencode's native models probe ranks a subscription collision instead of skipping", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-fake-opencode-"));
  fs.writeFileSync(
    path.join(bin, "opencode"),
    `#!/bin/sh\necho 'openai/gpt-5.6-luna'\necho 'anthropic/gpt-5.6-luna'\n`,
  );
  fs.chmodSync(path.join(bin, "opencode"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    const ok = await probeCandidate(
      { agent: "opencode", model: "gpt-5.6-luna" },
      {
        sessionName: "t",
        providerAuthTypes: { openai: "subscription", anthropic: "api_key" },
        probeSession: async () => ({
          verdict: "ok",
          detail: "",
          availableModels: ["openai/gpt-5.6-luna", "anthropic/gpt-5.6-luna"],
        }),
      },
    );
    assert.equal(ok.verdict, "ok");
    assert.equal(ok.resolvedModel, "openai/gpt-5.6-luna");

    const refused = await probeCandidate(
      { agent: "opencode", model: "gpt-5.6-luna" },
      {
        sessionName: "t",
        providerAuthTypes: {},
        probeSession: async () => {
          throw new Error("acpx probe must not run when native models are unrankably ambiguous");
        },
      },
    );
    assert.equal(refused.verdict, "model-unavailable");
    assert.match(refused.detail, /openai\/gpt-5.6-luna/);
    assert.match(refused.detail, /anthropic\/gpt-5.6-luna/);
    assert.match(refused.detail, /provider-qualified/);
  } finally {
    process.env.PATH = oldPath;
  }
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
  assert.equal(effortOptionKey("opencode"), "effort");
  assert.equal(effortOptionKey("pi"), null, "Pi effort is process --thinking, not ACP set");
  assert.equal(effortOptionKey("grok"), null);
});
