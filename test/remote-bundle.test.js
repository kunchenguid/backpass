import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildProbeProgram,
  createFrameReader,
  encodeEndFrame,
  encodeFrameHeader,
  PROBE_ENTRY,
  PROBE_MANIFEST,
  probeSources,
} from "../src/discovery/remote/bundle.js";
import { LOCATE_COMMAND, probeCommand } from "../src/discovery/hosts.js";
import { initRepo, tmpdir, writeClaudeSession } from "./helpers/remote.js";

test("the probe runs from a directory holding only the manifest, so no hidden import can break a host", async () => {
  const dir = tmpdir("probe-isolated");
  const files = probeSources();
  assert.deepEqual(Object.keys(files).sort(), [...PROBE_MANIFEST].sort());
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }

  const home = tmpdir("probe-isolated-home");
  const clone = initRepo(path.join(home, "demo"), "git@github.com:acme/demo.git");
  writeClaudeSession(home, { cwd: clone });

  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const probe = await import(pathToFileURL(path.join(dir, PROBE_ENTRY)).href);
    const response = await probe.discover({ harnesses: ["claude"], cutoffMs: null });
    assert.equal(response.protocol, 1);
    assert.equal(response.transcripts.length, 1);
    assert.equal(response.transcripts[0].cwd, clone);
    assert.equal(response.paths[clone].exists, true);
    assert.deepEqual(response.paths[clone].remotes, ["git@github.com:acme/demo.git"]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("everything backpass puts on a remote command line survives any shell quoting", () => {
  // These strings are backpass's own half of the wire contract, not implementation
  // detail: the locate snippet is wrapped in `sh -c '...'` so a fish or csh login shell
  // cannot misparse it, and the loader is the program that carries the adapters over.
  // A single quote would end that wrapper; a backslash or a bang changes meaning between
  // shells. There is nowhere else these values can be checked.
  const program = buildProbeProgram({ protocol: 1, op: "discover", harnesses: [], cutoffMs: null });
  const payloadStart = program.indexOf('Buffer.from("');
  const payloadEnd = program.indexOf('", "base64")');
  const loaderOnly = program.slice(0, payloadStart) + program.slice(payloadEnd);
  const quote = String.fromCharCode(39);
  const backslash = String.fromCharCode(92);

  for (const [name, text] of [
    ["the locate command", LOCATE_COMMAND.slice(LOCATE_COMMAND.indexOf(quote) + 1, -1)],
    ["the probe command", probeCommand("/usr/bin/node").replaceAll(quote, "")],
    ["the loader", loaderOnly],
  ]) {
    assert.ok(!text.includes(quote), `${name} must contain no single quote`);
    assert.ok(!text.includes(backslash), `${name} must contain no backslash`);
    assert.ok(!text.includes("!"), `${name} must contain no history-expansion bang`);
  }
});

test("a fetch frame is read back byte for byte, and a torn stream is reported rather than parsed", () => {
  const body = Buffer.from([0x61, 0x0a, 0x62, 0x00, 0x63, 0x7b, 0x22, 0x65, 0x6e, 0x64, 0x22]);
  const stream = Buffer.concat([
    encodeFrameHeader({ key: "one", bytes: body.length, kind: "raw" }),
    body,
    encodeEndFrame(),
  ]);

  const whole = createFrameReader();
  const frames = [];
  for (let i = 0; i < stream.length; i += 7) frames.push(...whole.push(stream.subarray(i, i + 7)));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].header.key, "one");
  assert.deepEqual(frames[0].body, body, "a body holding newlines and NULs must survive the frame");
  assert.equal(whole.ended, true);

  // Cut mid-body: the header promised more bytes than arrived, which is what a dropped
  // connection looks like and what must never be analyzed as a whole session.
  const torn = createFrameReader();
  assert.deepEqual(torn.push(stream.subarray(0, stream.length - encodeEndFrame().length - 4)), []);
  assert.equal(torn.ended, false);
  assert.equal(torn.incomplete.header.key, "one");
  assert.equal(torn.incomplete.received, body.length - 4);
});
