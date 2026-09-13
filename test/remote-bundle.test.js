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
import { runSsh } from "../src/discovery/remote/ssh.js";
import { initRepo, sshCalls, tmpdir, withRemoteEnv, writeClaudeSession } from "./helpers/remote.js";

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

test("the locate command and shipped probe execute through the supported remote shell path", async () => {
  const localHome = tmpdir("probe-shell-local");
  const remoteHome = tmpdir("probe-shell-remote");
  const log = path.join(localHome, "ssh.log");

  await withRemoteEnv({ localHome, hosts: { shellhost: { home: remoteHome } }, log }, async () => {
    const located = await runSsh({ destination: "shellhost", command: LOCATE_COMMAND });
    assert.equal(located.code, 0);
    assert.match(located.stdout, /node\|/);
    assert.match(located.stdout, /uname\|/);

    const probed = await runSsh({
      destination: "shellhost",
      command: probeCommand(process.execPath),
      input: buildProbeProgram({ protocol: 1, op: "discover", harnesses: [], cutoffMs: null }),
    });
    assert.equal(probed.code, 0);
    const response = JSON.parse(probed.stdout.trim());
    assert.equal(response.protocol, 1);
    assert.deepEqual(response.transcripts, []);
  });

  assert.deepEqual(
    sshCalls(log).map(({ destination, op }) => ({ destination, op })),
    [
      { destination: "shellhost", op: null },
      { destination: "shellhost", op: "discover" },
    ],
  );
});

test("a fetch frame is read back byte for byte, and a torn stream is reported rather than parsed", () => {
  const body = Buffer.from([0x61, 0x0a, 0x62, 0x00, 0x63, 0x7b, 0x22, 0x65, 0x6e, 0x64, 0x22]);
  const stream = Buffer.concat([
    encodeFrameHeader({ key: "one", harness: "claude", bytes: body.length, kind: "raw" }),
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

test("malformed fetch headers are rejected instead of becoming empty transcripts", () => {
  for (const header of [
    { key: "one", harness: "claude", bytes: "invalid", kind: "raw" },
    { key: "one", harness: "claude", bytes: -1, kind: "raw" },
    { key: "one", bytes: 0, kind: "raw" },
    { key: "one", harness: "claude", bytes: 0, kind: "unknown" },
    { key: "one", harness: "claude", bytes: 1, kind: "error", error: "failed" },
  ]) {
    const reader = createFrameReader();
    assert.throws(() => reader.push(encodeFrameHeader(header)), /probe response unreadable/);
    assert.equal(reader.ended, false);
  }
});
