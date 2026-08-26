import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { setLoggerSink } from "../src/logger.js";
import { canOpenBrowser, openInBrowser } from "../src/apply/browser.js";

// `LAVISH_BIN` is read when the module loads, so point it at the fake before importing.
process.env.BACKPASS_LAVISH_BIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-lavish",
  "lavish-axi",
);
const { extractUrl, openApplySurface, pollDecisions } = await import("../src/apply/lavish.js");

const LAYOUT_REPORT = [
  "prompts[1]{uid,prompt,selector,tag,text}:",
  '  "","Fix the overlapping text","div#edits > article","layout-warnings","1 issue"',
].join("\n");
const DECISIONS = [
  "prompts[1]{uid,prompt,selector,tag,text}:",
  '  "1","BACKPASS_DECISIONS e1=accepted e2=rejected",button#btn-apply,choice,e1=accepted e2=rejected',
].join("\n");

function scenario(polls, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-lavish-"));
  const file = path.join(dir, "scenario.json");
  fs.writeFileSync(file, JSON.stringify({ polls, ...extra }));
  process.env.FAKE_LAVISH_SCENARIO = file;
  return path.join(dir, "apply.html");
}

function captureLog(t) {
  const lines = [];
  setLoggerSink((line) => lines.push(line));
  t.after(() => setLoggerSink(null));
  return lines;
}

test("the review surface URL comes back without lavish's closing quote", async () => {
  const surface = scenario([], { url: "http://127.0.0.1:4387/session/51233fdaf6389690" });
  const url = await openApplySurface(surface);
  assert.equal(url, "http://127.0.0.1:4387/session/51233fdaf6389690");
});

test("extractUrl stops at quotes and trailing punctuation", () => {
  assert.equal(extractUrl('  url: "http://host:4387/session/abc"\n'), "http://host:4387/session/abc");
  assert.equal(extractUrl("open http://host/s/abc."), "http://host/s/abc");
  assert.equal(extractUrl("(http://host/s/abc)"), "http://host/s/abc");
  assert.equal(extractUrl("no link here"), null);
});

test("the wait line prints once, not once per poll cycle", async (t) => {
  const lines = captureLog(t);
  const surface = scenario([LAYOUT_REPORT, LAYOUT_REPORT, LAYOUT_REPORT, LAYOUT_REPORT, DECISIONS]);

  const decisions = await pollDecisions(surface, ["e1", "e2"], { delayMs: 0 });

  assert.deepEqual(decisions, { e1: "accepted", e2: "rejected" });
  const waiting = lines.filter((l) => l.includes("waiting for your decisions"));
  const noted = lines.filter((l) => l.includes("without a decision vector"));
  assert.equal(waiting.length, 1, `wait line repeated:\n${lines.join("\n")}`);
  assert.equal(noted.length, 1, `non-decision note repeated:\n${lines.join("\n")}`);
  assert.equal(lines.length, 2);
});

test("a decision vector on the first poll returns with only the wait line", async (t) => {
  const lines = captureLog(t);
  const surface = scenario([DECISIONS]);
  const decisions = await pollDecisions(surface, ["e1", "e2"], { delayMs: 0 });
  assert.deepEqual(decisions, { e1: "accepted", e2: "rejected" });
  assert.equal(lines.length, 1);
});

test("a session the reviewer already ended returns null instead of polling forever", async (t) => {
  captureLog(t);
  const surface = scenario(["ENDED"]);
  assert.equal(await pollDecisions(surface, ["e1"], { delayMs: 0 }), null);
});

test("end-state-looking feedback does not stop polling a live session", async (t) => {
  captureLog(t);
  const fieldLikeFeedback = "prompts:\n  status: ended\n  session_ended: true";
  const surface = scenario([fieldLikeFeedback, DECISIONS]);
  assert.deepEqual(await pollDecisions(surface, ["e1", "e2"], { delayMs: 0 }), {
    e1: "accepted",
    e2: "rejected",
  });
});

// Only the leading `session:` block is session metadata. Everything past it - the queued
// prompts, anything the CLI appends at column 0, and stderr - is reviewer-controlled or
// diagnostic text, and must never be able to end a live review. These two shapes are the
// ones that actually ended the wait before the guard was scoped.
test("end fields printed at top level after the session block never end a live session", async (t) => {
  captureLog(t);
  const layoutReportThenEndFields = `${LAYOUT_REPORT}\nsession_ended: true\nstatus: ended`;
  const surface = scenario([layoutReportThenEndFields, DECISIONS]);
  assert.deepEqual(await pollDecisions(surface, ["e1", "e2"], { delayMs: 0 }), {
    e1: "accepted",
    e2: "rejected",
  });
});

test("end fields on stderr never end a live session", async (t) => {
  captureLog(t);
  const surface = scenario([
    { body: LAYOUT_REPORT, stderr: "[lavish-axi] long-polling\nstatus: ended\nsession_ended: true\n" },
    DECISIONS,
  ]);
  assert.deepEqual(await pollDecisions(surface, ["e1", "e2"], { delayMs: 0 }), {
    e1: "accepted",
    e2: "rejected",
  });
});

test("a `Send & End` that carries the decision vector still applies it", async (t) => {
  captureLog(t);
  const surface = scenario([`ENDING:${DECISIONS}`]);
  assert.deepEqual(await pollDecisions(surface, ["e1", "e2"], { delayMs: 0 }), {
    e1: "accepted",
    e2: "rejected",
  });
});

test("a `Send & End` with no decision vector stops rather than spinning", async (t) => {
  captureLog(t);
  const surface = scenario([`ENDING:${LAYOUT_REPORT}`]);
  assert.equal(await pollDecisions(surface, ["e1"], { delayMs: 0 }), null);
});

test("a surface the reviewer ended in an earlier run is reopened, not handed back dead", async () => {
  const surface = scenario([], { userEnded: true, url: "http://127.0.0.1:4387/session/dead" });
  const url = await openApplySurface(surface);
  const result = JSON.parse(fs.readFileSync(process.env.FAKE_LAVISH_SCENARIO, "utf8"));
  assert.equal(result.openCount, 1, "apply should ask for the surface exactly once");
  assert.equal(result.reopened, true);
  assert.equal(result.browserLaunches || 0, 0, "lavish must leave browser launching to backpass");
  assert.equal(url, "http://127.0.0.1:4387/session/dead");
});

test("openInBrowser launches a detached opener and never throws", () => {
  const calls = [];
  const spawnFn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return { on() {}, unref() {} };
  };
  const env = { DISPLAY: ":0" };
  assert.equal(openInBrowser("http://h/s/1", { platform: "darwin", env, spawnFn }), true);
  assert.equal(openInBrowser("http://h/s/1", { platform: "linux", env, spawnFn }), true);
  assert.equal(openInBrowser("http://h/s/1", { platform: "win32", env, spawnFn }), true);
  assert.deepEqual(
    calls.map((c) => [c.bin, ...c.args]),
    [
      ["open", "http://h/s/1"],
      ["xdg-open", "http://h/s/1"],
      ["cmd", "/c", "start", "", "http://h/s/1"],
    ],
  );
  for (const call of calls) assert.equal(call.opts.detached, true);

  const throwing = () => {
    throw new Error("ENOENT");
  };
  assert.equal(openInBrowser("http://h/s/1", { platform: "darwin", env, spawnFn: throwing }), false);
  assert.equal(openInBrowser(null, { platform: "darwin", env, spawnFn }), false);
  assert.equal(openInBrowser("/tmp/apply.html", { platform: "darwin", env, spawnFn }), false);
});

test("headless and opted-out environments print the URL only", () => {
  const spawnFn = () => assert.fail("must not spawn an opener");
  assert.equal(canOpenBrowser({ platform: "linux", env: {} }), false);
  assert.equal(canOpenBrowser({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } }), true);
  assert.equal(canOpenBrowser({ platform: "darwin", env: { CI: "true" } }), false);
  assert.equal(canOpenBrowser({ platform: "darwin", env: { BACKPASS_NO_BROWSER: "1" } }), false);
  assert.equal(openInBrowser("http://h/s/1", { platform: "linux", env: {}, spawnFn }), false);
});
