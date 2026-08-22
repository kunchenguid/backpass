import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { capTranscripts, recencyWeight, sampleTranscripts, seededRandom } from "../src/sample.js";
import { CONFIG_FILENAME, loadConfig, parseMaxTranscripts } from "../src/config.js";
import { UserError, setLoggerSink } from "../src/logger.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 22);

/** `count` transcripts spread evenly over `spanDays`, newest first like discovery. */
function transcripts(count, spanDays) {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    startedAt: NOW - (i * spanDays * DAY) / count,
    mtimeMs: 0,
  }));
}

function tempDir(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-sample-"));
  if (config !== undefined) fs.writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify(config));
  return dir;
}

function captureInfo(fn) {
  const lines = [];
  setLoggerSink((line) => lines.push(line));
  try {
    fn();
  } finally {
    setLoggerSink(null);
  }
  return lines;
}

test("the seeded RNG is deterministic and uniform on [0, 1)", () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  const seq = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(
    seq,
    Array.from({ length: 1000 }, () => b()),
  );
  assert.ok(seq.every((x) => x >= 0 && x < 1));
  const mean = seq.reduce((s, x) => s + x, 0) / seq.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05, `mean ${mean} is not close to 0.5`);
  assert.notEqual(seededRandom(1)(), seededRandom(2)());
});

test("weight halves every half-life and never reaches zero", () => {
  const opts = { now: NOW, halfLifeMs: 14 * DAY };
  assert.equal(recencyWeight({ startedAt: NOW }, opts), 1);
  assert.ok(Math.abs(recencyWeight({ startedAt: NOW - 14 * DAY }, opts) - 0.5) < 1e-12);
  assert.ok(Math.abs(recencyWeight({ startedAt: NOW - 28 * DAY }, opts) - 0.25) < 1e-12);
  assert.ok(recencyWeight({ startedAt: NOW - 10_000 * DAY }, opts) > 0);
  assert.ok(recencyWeight({ startedAt: null, mtimeMs: NOW }, opts) === 1, "mtime is the fallback timestamp");
  assert.ok(recencyWeight({ startedAt: null, mtimeMs: 0 }, opts) > 0, "undated transcripts keep a tiny weight");
});

test("under the cap every transcript passes through untouched", () => {
  const set = transcripts(10, 30);
  assert.equal(sampleTranscripts(set, 10, { seed: 1, now: NOW }), set);
  assert.equal(sampleTranscripts(set, 100, { seed: 1, now: NOW }), set);
  assert.equal(sampleTranscripts(set, null, { seed: 1, now: NOW }), set, "null disables the cap");
});

test("over the cap exactly `cap` are kept, in discovery order, reproducibly per seed", () => {
  const set = transcripts(300, 90);
  const a = sampleTranscripts(set, 100, { seed: 7, now: NOW });
  const b = sampleTranscripts(set, 100, { seed: 7, now: NOW });
  assert.equal(a.length, 100);
  assert.deepEqual(a, b, "the same seed yields the same sample");
  assert.equal(new Set(a).size, 100, "sampling is without replacement");
  const order = a.map((t) => set.indexOf(t));
  assert.deepEqual(
    order,
    [...order].sort((x, y) => x - y),
    "original order is preserved",
  );
  assert.notDeepEqual(
    sampleTranscripts(set, 100, { seed: 8, now: NOW }),
    a,
    "a different seed yields a different sample",
  );
});

test("recent transcripts are favored over old ones", () => {
  const set = transcripts(300, 90);
  let newestKept = 0;
  let oldestKept = 0;
  for (let seed = 0; seed < 50; seed++) {
    const kept = sampleTranscripts(set, 100, { seed, now: NOW });
    newestKept += kept.filter((t) => set.indexOf(t) < 100).length;
    oldestKept += kept.filter((t) => set.indexOf(t) >= 200).length;
  }
  // Newest third is within one 14d half-life (weight >= 0.23); oldest third is 60-90 days
  // out (weight <= 0.05). Unweighted sampling would keep each third equally (~1667 each).
  assert.ok(newestKept > 2 * oldestKept, `newest ${newestKept} vs oldest ${oldestKept}`);
  assert.ok(newestKept > 1667, `newest third is over-represented: ${newestKept}`);
  assert.ok(oldestKept < 1667, `oldest third is under-represented: ${oldestKept}`);
});

test("capTranscripts reports a greppable line only when sampling happened", () => {
  const config = loadConfig(tempDir(), { seed: 3 });
  const small = { transcripts: transcripts(40, 30), perHarness: {} };
  let lines = captureInfo(() => {
    const result = capTranscripts(small, config, { now: NOW });
    assert.equal(result, small, "under the cap the result object is untouched");
  });
  assert.deepEqual(lines, []);

  const big = { transcripts: transcripts(340, 60), perHarness: {} };
  let result = big;
  lines = captureInfo(() => {
    result = capTranscripts(big, config, { now: NOW });
  });
  assert.equal(result.transcripts.length, 100);
  assert.equal(result.sampledFrom, 340);
  assert.equal(result.perHarness, big.perHarness, "other discovery fields are preserved");
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /discovered 340 transcript\(s\), analyzing a recency-weighted sample of 100 \(--max-transcripts\)/,
  );
});

test("maxTranscripts is configurable and 0 / all disable the cap", () => {
  assert.equal(loadConfig(tempDir()).maxTranscripts, 100);
  assert.equal(loadConfig(tempDir({ maxTranscripts: 25 })).maxTranscripts, 25);
  assert.equal(loadConfig(tempDir({ maxTranscripts: 25 }), { maxTranscripts: 7 }).maxTranscripts, 7, "flag wins");
  assert.equal(loadConfig(tempDir({ maxTranscripts: 25 }), { maxTranscripts: null }).maxTranscripts, null);
  assert.equal(loadConfig(tempDir({ maxTranscripts: 0 })).maxTranscripts, null);
  assert.equal(loadConfig(tempDir({ maxTranscripts: "all" })).maxTranscripts, null);
  assert.equal(parseMaxTranscripts("0", "--max-transcripts"), null);
  assert.equal(parseMaxTranscripts("all", "--max-transcripts"), null);
  assert.equal(parseMaxTranscripts("12", "--max-transcripts"), 12);
  assert.throws(() => parseMaxTranscripts("-1", "--max-transcripts"), UserError);
  assert.throws(() => parseMaxTranscripts("lots", "--max-transcripts"), UserError);
  assert.throws(() => loadConfig(tempDir({ sampleHalfLife: "soon" })), UserError);
  assert.throws(() => loadConfig(tempDir({ seed: 1.5 })), UserError);

  const big = { transcripts: transcripts(340, 60), perHarness: {} };
  const all = loadConfig(tempDir(), { maxTranscripts: null });
  const lines = captureInfo(() => assert.equal(capTranscripts(big, all, { now: NOW }), big));
  assert.deepEqual(lines, [], "no sampling line when the cap is disabled");
  const seven = loadConfig(tempDir(), { maxTranscripts: 7, seed: 1 });
  captureInfo(() => assert.equal(capTranscripts(big, seven, { now: NOW }).transcripts.length, 7));
});
