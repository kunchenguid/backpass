import test from "node:test";
import assert from "node:assert/strict";

import { AcpxError, assertNonEmptyOutput, classifyAcpxFailure } from "../src/acpx.js";

/**
 * Regression for a real backpass run: an OpenAI account out of credits made pi's ACP
 * bridge exit 0 with empty stdout and no stderr detail at all. Every transcript in the
 * run failed with the generic "no parseable JSON" message and the ladder never fell
 * through to a healthy candidate, because nothing about that result was classifiable.
 */

test("assertNonEmptyOutput passes through a real answer unchanged", () => {
  const result = { text: '{"positive":[]}', raw: '{"positive":[]}' };
  assert.equal(assertNonEmptyOutput(result, { agent: "pi", model: "openai/gpt-5.6-luna" }), result);
});

test("assertNonEmptyOutput throws a classifiable AcpxError on blank text", () => {
  assert.throws(
    () => assertNonEmptyOutput({ text: "   ", raw: "   " }, { agent: "pi", model: "openai/gpt-5.6-luna" }),
    (err) => {
      assert.ok(err instanceof AcpxError, String(err));
      assert.equal(err.message, "pi (openai/gpt-5.6-luna) returned no output");
      assert.equal(err.emptyOutput, true);
      assert.equal(classifyAcpxFailure(err), "empty-output");
      return true;
    },
  );
});
