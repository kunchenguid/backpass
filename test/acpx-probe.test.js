import test from "node:test";
import assert from "node:assert/strict";

import { probeSession } from "../src/acpx.js";

/**
 * The kill path of the availability probe.
 *
 * These drive `probeSession` through an injected runner rather than a real hanging
 * subprocess on purpose. Whether a killed child's buffered output reaches the parent at
 * all is a race - the same fixture captured stderr on one run and lost it on the next -
 * so a test built on a real kill would assert a coin flip. Injecting the two shapes
 * pins the decision `probeSession` makes about each, which is the part backpass owns.
 */

/** A runner whose `sessions new` returns `result`; later calls are never reached. */
function runnerReturning(result) {
  const calls = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args.join(" "));
      return { code: null, stdout: "", stderr: "", ...result };
    },
  };
}

test("a killed probe is classified from whatever the adapter had already printed", async () => {
  const { run, calls } = runnerReturning({
    timedOut: true,
    stderr: "[acpx] error: RUNTIME AUTH_REQUIRED codex is not logged in\n",
  });
  const verdict = await probeSession({ agent: "codex", sessionName: "probe", timeoutMs: 10_000, run });

  assert.equal(verdict.verdict, "unauthenticated", "a diagnosis already on stderr is a verdict, not a stall");
  assert.match(verdict.detail, /AUTH_REQUIRED/);
  assert.deepEqual(verdict.availableModels, []);
  assert.equal(calls.length, 1, "a probe that never came up is not asked for its model list");
});

test("a probe that hangs without saying anything stays a timeout", async () => {
  const { run } = runnerReturning({ timedOut: true, stderr: "" });
  const verdict = await probeSession({ agent: "pi", sessionName: "probe", timeoutMs: 10_000, run });

  assert.equal(verdict.verdict, "timeout", "an unexplained hang must not be given a name it did not earn");
  assert.match(verdict.detail, /no answer in 10s/, "the detail names the wait the user actually paid");
});

test("a killed probe is never reported as `not installed`", async () => {
  // The distinction that matters to the person reading the exhausted-ladder table:
  // `unreachable` tells them to install a CLI, which is wrong advice for one that is
  // installed and merely wedged.
  for (const stderr of ["", "starting adapter...\n", "[acpx] error: TIMEOUT prompt exceeded 300s\n"]) {
    const { run } = runnerReturning({ timedOut: true, stderr });
    const verdict = await probeSession({ agent: "codex", sessionName: "probe", timeoutMs: 10_000, run });
    assert.equal(verdict.verdict, "timeout", `unclassifiable stderr ${JSON.stringify(stderr)} is a timeout`);
  }
});
