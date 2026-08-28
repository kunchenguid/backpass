import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { capTranscripts, recencyWeight, sampleTranscripts, sampleUnit } from "../src/sample.js";
import { CONFIG_FILENAME, loadConfig, parseMaxTranscripts } from "../src/config.js";
import { transcriptIdentity } from "../src/transcript.js";
import { UserError, setLoggerSink } from "../src/logger.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 22);

/** `count` transcripts spread evenly over `spanDays`, newest first like discovery. */
function transcripts(count, spanDays, { harness = "claude", offset = 0 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    harness,
    id: `t${i + offset}`,
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

test("sampleUnit is deterministic per transcript identity, uniform, and seed-sensitive", () => {
  const t = { harness: "claude", id: "abc" };
  assert.equal(
    sampleUnit(t, 1),
    sampleUnit({ harness: "claude", id: "abc" }, 1),
    "same identity, same seed -> same draw",
  );
  assert.notEqual(sampleUnit(t, 1), sampleUnit(t, 2), "a different seed draws differently");
  assert.notEqual(
    sampleUnit(t, undefined),
    sampleUnit({ harness: "claude", id: "abd" }, undefined),
    "a different identity draws differently",
  );
  assert.equal(sampleUnit(t, null), sampleUnit(t, undefined), "null and undefined seed both mean unseeded");

  const set = Array.from({ length: 1000 }, (_, i) => ({ harness: "claude", id: `t${i}` }));
  const seq = set.map((transcript) => sampleUnit(transcript, 7));
  assert.ok(seq.every((x) => x >= 0 && x < 1));
  const mean = seq.reduce((s, x) => s + x, 0) / seq.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05, `mean ${mean} is not close to 0.5`);
  assert.equal(new Set(seq).size, seq.length, "distinct identities draw distinct values in practice");
});

test("transcript identity combines harness, native id, and durable source without using titles", () => {
  const original = { harness: "claude", nativeId: "s1", path: "/store/a.jsonl", title: "Fix the bug" };
  assert.equal(transcriptIdentity(original), transcriptIdentity({ ...original, title: "Totally different title" }));
  assert.notEqual(
    transcriptIdentity(original),
    transcriptIdentity({ ...original, harness: "codex" }),
    "the same native id under a different harness is a different identity",
  );
  assert.notEqual(
    transcriptIdentity(original),
    transcriptIdentity({ ...original, path: "/store/b.jsonl" }),
    "colliding native ids at different sources remain distinct",
  );
  assert.equal(
    transcriptIdentity(original),
    transcriptIdentity({ ...original, identity: transcriptIdentity(original) }),
  );
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

test("with no --seed the default draw is deterministic across separate runs (no persisted state)", () => {
  const set = transcripts(147, 200);
  const a = sampleTranscripts(set, 100, { now: NOW });
  const b = sampleTranscripts(set, 100, { now: NOW });
  assert.equal(a.length, 100);
  assert.deepEqual(a, b, "an unchanged rerun with no seed selects the identical sample");
});

test("reordering the discovered array changes only display order, never which transcripts are sampled", () => {
  const set = transcripts(147, 200);
  const reversed = [...set].reverse();
  const shuffled = [...set].sort((a, b) => (a.id > b.id ? 1 : -1));
  const idsOf = (kept) => new Set(kept.map((t) => t.id));

  const baseline = idsOf(sampleTranscripts(set, 100, { now: NOW }));
  assert.deepEqual(idsOf(sampleTranscripts(reversed, 100, { now: NOW })), baseline);
  assert.deepEqual(idsOf(sampleTranscripts(shuffled, 100, { now: NOW })), baseline);
});

test("growing the corpus is sticky: previously sampled transcripts stay sampled except where new ones outcompete them", () => {
  // The captain's exact reproduction: 147 discovered, capped to 100.
  const base = transcripts(147, 200);
  const before = new Set(sampleTranscripts(base, 100, { now: NOW }).map((t) => t.id));
  assert.equal(before.size, 100);

  // 20 new sessions land at arbitrary positions, with the same age distribution as the
  // rest - a fresh random draw would reshuffle everyone; a sticky one can only ever have
  // new items displace old ones, never the reverse, so the intersection is bounded below
  // by count - inserted.
  const inserted = transcripts(20, 200, { offset: 1000 });
  const insertedIds = new Set(inserted.map((t) => t.id));
  const grown = [...base.slice(0, 60), ...inserted, ...base.slice(60)];
  assert.equal(grown.length, 167);

  const after = sampleTranscripts(grown, 100, { now: NOW });
  assert.equal(after.length, 100);
  const afterIds = new Set(after.map((t) => t.id));
  const stillKept = [...before].filter((id) => afterIds.has(id));
  assert.ok(
    stillKept.length >= 100 - inserted.length,
    `expected at least ${100 - inserted.length} of the original 100 to survive, got ${stillKept.length}`,
  );

  // Not a fluke of an unusually small displacement: some genuine competition happened.
  const newlyKept = after.filter((t) => insertedIds.has(t.id)).length;
  assert.ok(newlyKept > 0, "at least one inserted transcript should have won a slot");
});

test("raising the cap only adds to the sample; it never drops what a smaller cap already kept", () => {
  const set = transcripts(300, 90);
  const small = new Set(sampleTranscripts(set, 50, { now: NOW }).map((t) => t.id));
  const medium = new Set(sampleTranscripts(set, 100, { now: NOW }).map((t) => t.id));
  const large = new Set(sampleTranscripts(set, 150, { now: NOW }).map((t) => t.id));
  assert.ok(
    [...small].every((id) => medium.has(id)),
    "cap 50 is a subset of cap 100",
  );
  assert.ok(
    [...medium].every((id) => large.has(id)),
    "cap 100 is a subset of cap 150",
  );
});

test("undated transcripts and duplicate-looking titles never crash or collide the sample", () => {
  const set = [
    ...transcripts(50, 60),
    ...Array.from({ length: 5 }, (_, i) => ({ harness: "claude", id: `undated${i}`, title: "Untitled" })),
  ];
  const kept = sampleTranscripts(set, 40, { now: NOW });
  assert.equal(kept.length, 40);
  assert.equal(new Set(kept.map((t) => t.id)).size, 40, "no duplicate selections");
});

test("every supported harness's id namespace is sampled independently, never deduped across harnesses", () => {
  const harnesses = ["claude", "codex", "pi", "opencode", "grok", "cursor", "hermes", "cursor-ide"];
  const set = harnesses.map((harness) => ({ harness, id: "s1", startedAt: NOW, mtimeMs: 0 }));
  const kept = sampleTranscripts(set, harnesses.length - 1, { now: NOW });
  assert.equal(kept.length, harnesses.length - 1, "same id under each harness is a distinct sampling entry");
  assert.equal(new Set(kept.map((t) => t.harness)).size, kept.length);
});

test("colliding native ids select the same source regardless of discovery order", () => {
  const distinct = transcripts(8, 60);
  const dupA = { harness: "claude", nativeId: "dup", id: "claude-dup", path: "/store/a.jsonl" };
  const dupB = { harness: "claude", nativeId: "dup", id: "claude-dup", path: "/store/b.jsonl" };
  const selectedCollision = (set) =>
    sampleTranscripts(set, 9, { now: NOW })
      .filter((transcript) => transcript.nativeId === "dup")
      .map((transcript) => transcriptIdentity(transcript));

  const forward = selectedCollision([...distinct, dupA, dupB]);
  const reversed = selectedCollision([dupB, dupA, ...distinct]);
  assert.equal(forward.length, 1, "the cap forces exactly one colliding native id out");
  assert.deepEqual(reversed, forward, "reordering cannot change which durable source survives");
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
