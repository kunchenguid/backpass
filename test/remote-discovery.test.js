import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { applyHostFlag, loadConfig } from "../src/config.js";
import { discoverProject, initRepo, sshCalls, tmpdir, withRemoteEnv, writeClaudeSession } from "./helpers/remote.js";
import { disambiguateSourceLabels, gapSource } from "../src/gap-ledger.js";
import { classifySshFailure } from "../src/discovery/remote/ssh.js";
import { discoverTranscripts } from "../src/discovery/index.js";
import { resolveHostList } from "../src/discovery/hosts.js";
import { resolveScope } from "../src/scope.js";
import { State } from "../src/state.js";
import { SELF_SESSION_SENTINEL } from "../src/sentinel.js";
import { UserError, setLoggerSink } from "../src/logger.js";
import { clearProgressSink, setProgressSink } from "../src/progress.js";

const REMOTE = "github.com/acme/demo";

/**
 * One host, one remote clone of this repo, one claude session recorded in it.
 * `variant` patches the host's fixture entry so a test can simulate a failure.
 */
function scenario({ variant = {}, cwdOverride = null, sessionText = null } = {}) {
  const localHome = tmpdir("remote-local");
  const remoteHome = tmpdir("remote-home");
  const repoRoot = initRepo(path.join(localHome, "demo"), `https://${REMOTE}.git`);
  const remoteClone = initRepo(path.join(remoteHome, "code", "demo"), `git@github.com:acme/demo.git`);
  const cwd = cwdOverride ?? remoteClone;
  writeClaudeSession(remoteHome, { cwd, prefixText: sessionText });
  const log = path.join(localHome, "ssh-calls.log");
  return {
    localHome,
    remoteHome,
    repoRoot,
    remoteClone,
    log,
    /** @type {Record<string, Record<string, any>>} */
    hosts: { "mac-home": { home: remoteHome, ...variant } },
  };
}

test("host collection has plain progress without duplicating live progress", async () => {
  const plain = scenario();
  const lines = [];
  setLoggerSink((line) => lines.push(line));
  try {
    await withRemoteEnv({ localHome: plain.localHome, hosts: plain.hosts }, () =>
      discoverProject(plain.repoRoot, { discovery: { hosts: ["mac-home"] } }),
    );
  } finally {
    setLoggerSink(null);
  }
  assert.ok(lines.includes("ssh mac-home connecting"));
  assert.ok(lines.some((line) => /^ssh mac-home done · node v.* · 1 scanned$/.test(line)));

  const live = scenario();
  const liveLines = [];
  const events = [];
  setLoggerSink((line) => liveLines.push(line));
  setProgressSink((event, data) => events.push({ event, data }));
  try {
    await withRemoteEnv({ localHome: live.localHome, hosts: live.hosts }, () =>
      discoverProject(live.repoRoot, { discovery: { hosts: ["mac-home"] } }),
    );
  } finally {
    clearProgressSink();
    setLoggerSink(null);
  }
  assert.equal(
    liveLines.some((line) => line.startsWith("ssh mac-home ")),
    false,
  );
  assert.deepEqual(
    events.filter(({ event }) => event.startsWith("discover:host:")).map(({ event }) => event),
    ["discover:host:start", "discover:host:done"],
  );
});

test("a remote session in a clone that shares this repo's remote is tier 1.5, named by host, and survives --strict", async () => {
  const s = scenario();
  const result = await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts, log: s.log }, () =>
    discoverProject(s.repoRoot, { discovery: { hosts: ["mac-home"] }, strict: true }),
  );

  assert.equal(result.transcripts.length, 1);
  const [transcript] = result.transcripts;
  assert.equal(transcript.host, "mac-home");
  assert.equal(transcript.association.tier, 1.5);
  assert.match(transcript.association.reason, /on mac-home$/);
  assert.match(transcript.association.reason, new RegExp(s.remoteClone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // Two multiplexed calls: locate, then discover. Nothing is fetched until analysis.
  assert.deepEqual(
    sshCalls(s.log).map((call) => [call.destination, call.op]),
    [
      ["mac-home", null],
      ["mac-home", "discover"],
    ],
  );
});

test("a dead remote path ending in the repo name is tier 3 and --strict drops it", async () => {
  const s = scenario({ cwdOverride: "/vanished/checkouts/demo" });

  const loose = await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts }, () =>
    discoverProject(s.repoRoot, { discovery: { hosts: ["mac-home"] } }),
  );
  assert.equal(loose.transcripts.length, 1);
  assert.equal(loose.transcripts[0].association.tier, 3);
  assert.equal(loose.transcripts[0].association.reason, "dead path ending in /demo on mac-home");

  const strict = await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts }, () =>
    discoverProject(s.repoRoot, { discovery: { hosts: ["mac-home"] }, strict: true }),
  );
  assert.equal(strict.transcripts.length, 0);
});

test("a session present in the local store and on a host is kept once, as the local copy", async () => {
  const s = scenario();
  // The same session id, filed locally against this checkout: a synced store.
  writeClaudeSession(s.localHome, { cwd: s.repoRoot });

  const result = await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts }, () =>
    discoverProject(s.repoRoot, { discovery: { hosts: ["mac-home"] } }),
  );

  assert.equal(result.transcripts.length, 1);
  assert.equal(result.transcripts[0].host, null);
  assert.equal(result.perHost[0].duplicates, 1);
});

test("a remote session whose first user message is backpass's own is counted as self and never collected", async () => {
  const s = scenario({ sessionText: `${SELF_SESSION_SENTINEL}\\nAnalyze this transcript.` });

  const result = await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts }, () =>
    discoverProject(s.repoRoot, { discovery: { hosts: ["mac-home"] } }),
  );

  assert.equal(result.transcripts.length, 0);
  assert.equal(result.perHost[0].self, 1);
  assert.equal(result.perHost[0].error, null);
});

test("an authentication failure skips the host with the command to make succeed, and keeps local results", async () => {
  const s = scenario({
    variant: { fail: { stderr: "kunchen@mac-home: Permission denied (publickey,keyboard-interactive)." } },
  });
  writeClaudeSession(s.localHome, { cwd: s.repoRoot, id: "aaaaaaaa-1111-2222-3333-444444444444" });

  const result = await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts }, () =>
    discoverProject(s.repoRoot, { discovery: { hosts: ["mac-home"] } }),
  );

  assert.equal(result.transcripts.length, 1, "the local session is still collected");
  assert.equal(result.transcripts[0].host, null);
  assert.match(result.perHost[0].error, /make "ssh mac-home true" succeed without a prompt/);
});

test("an unknown host key names the interactive connection and never offers a bypass", async () => {
  const s = scenario({
    variant: {
      fail: {
        stderr: "Host key verification failed.",
      },
    },
  });

  const result = await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts }, () =>
    discoverProject(s.repoRoot, { discovery: { hosts: ["mac-home"] } }),
  );

  const { error } = result.perHost[0];
  assert.match(error, /connect once interactively \(ssh mac-home\) to accept the host key/);
  assert.doesNotMatch(error, /StrictHostKeyChecking/);
});

test("a changed host key is reported as a change to verify, not as an unreachable host", async () => {
  const s = scenario({
    variant: { fail: { stderr: "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@" } },
  });

  const result = await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts }, () =>
    discoverProject(s.repoRoot, { discovery: { hosts: ["mac-home"] } }),
  );

  assert.match(result.perHost[0].error, /host key for mac-home changed; verify the change out of band/);
});

test("a host with no Node is skipped by name, and an old Node keeps the file-backed harnesses", async () => {
  const noNode = scenario({ variant: { locateOutput: "git|/usr/bin/git\nuname|Linux\nhome|/home/kun" } });
  const skipped = await withRemoteEnv({ localHome: noNode.localHome, hosts: noNode.hosts }, () =>
    discoverProject(noNode.repoRoot, { discovery: { hosts: ["mac-home"] } }),
  );
  assert.match(skipped.perHost[0].error, /has no Node; install Node >= 22\.5 or set discovery\.hosts\[\]\.node/);

  const old = scenario({ variant: { nodeOptions: "--no-experimental-detect-module" } });
  old.hosts["mac-home"].locateOutput = [
    `node|${process.execPath}|v16.20.2`,
    "git|/usr/bin/git",
    `uname|${process.platform === "darwin" ? "Darwin" : "Linux"}`,
    `home|${old.remoteHome}`,
  ].join("\n");
  const kept = await withRemoteEnv({ localHome: old.localHome, hosts: old.hosts }, () =>
    discoverProject(old.repoRoot, {
      discovery: { hosts: [{ host: "mac-home", node: process.execPath }], harnesses: ["claude", "hermes"] },
    }),
  );
  assert.equal(kept.transcripts.length, 1, "claude still crosses with Node 16 module semantics");
  assert.ok(
    kept.perHost[0].warnings.some((note) => /hermes skipped: node v16\.20\.2 lacks node:sqlite/.test(note)),
    `expected a named sqlite skip, got ${JSON.stringify(kept.perHost[0].warnings)}`,
  );
});

test("a non-POSIX remote is refused by name rather than probed", async () => {
  const s = scenario({
    variant: { locateOutput: `node|${process.execPath}|v24.0.0\ngit|C:/git\nuname|MINGW64_NT-10.0\nhome|C:/Users/kun` },
  });

  const result = await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts }, () =>
    discoverProject(s.repoRoot, { discovery: { hosts: ["mac-home"] } }),
  );

  assert.match(result.perHost[0].error, /Windows and other non-POSIX remotes are not supported/);
});

test("a malformed probe response skips only that host", async () => {
  const malformed = [
    { protocol: 1, harnesses: {}, transcripts: null, paths: {}, warnings: [] },
    {
      protocol: 1,
      node: process.version,
      platform: process.platform,
      hostname: "mac-home",
      home: "/home/kun",
      harnesses: {},
      transcripts: [
        {
          harness: "claude",
          id: "remote-id",
          key: "/remote/demo/session.jsonl",
          path: "/remote/demo/session.jsonl",
          cwd: "/remote/demo",
          gitRoot: null,
          remotes: [],
          title: null,
          model: null,
          startedAt: null,
          mtimeMs: 0,
          bytes: 0,
          contentSignature: null,
          extra: {},
          interactionSignals: {},
          kind: "raw",
        },
      ],
      paths: {
        "/remote/demo": { real: "/remote/demo", exists: true, toplevel: "/remote/demo", remotes: "invalid" },
      },
      warnings: [],
    },
    {
      protocol: 1,
      node: process.version,
      platform: process.platform,
      hostname: "mac-home",
      home: {},
      harnesses: {},
      transcripts: [],
      paths: {},
      warnings: [],
    },
  ];

  for (const response of malformed) {
    const s = scenario({ variant: { discoverOutput: JSON.stringify(response) } });
    writeClaudeSession(s.localHome, { cwd: s.repoRoot, id: "aaaaaaaa-1111-2222-3333-444444444444" });
    const result = await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts }, () =>
      discoverProject(s.repoRoot, { discovery: { hosts: ["mac-home"], harnesses: ["claude"] } }),
    );
    assert.equal(result.transcripts.length, 1);
    assert.equal(result.transcripts[0].host, null);
    assert.equal(result.perHost[0].error, "probe response unreadable");
  }
});

test("discovery.hosts in the repository config is refused and points at the personal file", async () => {
  const localHome = tmpdir("remote-repoconf");
  const repoRoot = initRepo(path.join(localHome, "demo"), `https://${REMOTE}.git`);
  fs.writeFileSync(
    path.join(repoRoot, ".backpassrc.json"),
    JSON.stringify({ discovery: { hosts: ["mac-home"] } }, null, 2),
  );

  const error = await withRemoteEnv({ localHome, hosts: {} }, async () => {
    try {
      loadConfig(repoRoot, {});
    } catch (err) {
      return err;
    }
    return null;
  });
  assert.ok(error instanceof UserError, "a repository file naming a machine must fail the run");
  assert.match(error.message, /\.backpassrc\.json sets discovery\.hosts, but ssh hosts are personal configuration/);
  assert.match(error.hint, /backpass[/\\]config\.json/);
});

test("a destination that could be read as an option or break quoting is refused before any ssh runs", async () => {
  const s = scenario();
  for (const destination of ["-oProxyCommand=touch /tmp/pwned", 'mac"home', "mac'home", "mac\\home"]) {
    await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts, log: s.log }, async () => {
      assert.throws(
        () => resolveHostList({ discovery: { hosts: [destination] } }),
        UserError,
        `expected ${destination} to be refused`,
      );
    });
  }
  assert.deepEqual(sshCalls(s.log), [], "nothing may be spawned for a destination that was refused");
});

test("host configuration requires an absolute node path and treats each flag as one exact destination", () => {
  assert.throws(
    () => resolveHostList({ discovery: { hosts: [{ host: "mac-home", node: "node" }] } }),
    /absolute POSIX path/,
  );
  assert.deepEqual(applyHostFlag([], ["mac-home,mac-work"]), ["mac-home,mac-work"]);
  assert.deepEqual(applyHostFlag(["configured"], ["NONE"]), ["configured", "NONE"]);
  assert.deepEqual(applyHostFlag(["configured"], ["none"]), []);
});

test("an evidence source label carries the host and stays one label per session", () => {
  const local = { harness: "claude", nativeId: "abc123", startedAt: Date.parse("2026-09-01"), identity: "id-local" };
  const remote = { ...local, host: "mac-home", identity: "id-remote" };

  assert.equal(gapSource(local), "claude · abc123 · 2026-09-01");
  assert.equal(gapSource(remote), "claude · abc123 · 2026-09-01 · mac-home");

  const labels = disambiguateSourceLabels([
    { source: gapSource(local), identity: local.identity },
    { source: gapSource(remote), identity: remote.identity },
  ]);
  assert.equal(new Set(labels).size, 2, "two machines' copies must not collapse into one label");
});

test("a user-scope run collects from a host and keys the project by the clone's own remote", async () => {
  const localHome = tmpdir("remote-user-local");
  const remoteHome = tmpdir("remote-user-home");
  const shared = initRepo(path.join(remoteHome, "code", "shared"), "git@github.com:acme/shared.git");
  const private_ = initRepo(path.join(remoteHome, "code", "private"), null);
  writeClaudeSession(remoteHome, { cwd: shared, id: "11111111-1111-1111-1111-111111111111" });
  writeClaudeSession(remoteHome, { cwd: private_, id: "22222222-2222-2222-2222-222222222222" });

  const result = await withRemoteEnv({ localHome, hosts: { "mac-home": { home: remoteHome } } }, async () => {
    const config = loadConfig(
      null,
      { discovery: { since: "all", harnesses: ["claude"], hosts: ["mac-home"] } },
      { kind: "user" },
    );
    const scope = resolveScope(localHome, { scope: "user" }, config, null, { home: localHome });
    config.state = new State(scope.root, { stateDir: scope.stateDir, mode: 0o700, exclude: false }).ensure();
    return discoverTranscripts({ repo: scope.repo, scope, config, strict: false });
  });

  const byId = new Map(result.transcripts.map((transcript) => [transcript.nativeId, transcript]));
  assert.equal(result.transcripts.length, 2);
  // A clone with a remote agrees with the same project on any other machine, which is
  // what lets minGapProjects count two machines as one project rather than two.
  assert.equal(byId.get("11111111-1111-1111-1111-111111111111").project, "github.com/acme/shared");
  assert.equal(byId.get("11111111-1111-1111-1111-111111111111").association.tier, 1);
  // A clone with no remote has nothing to agree on, so its key names the machine.
  assert.equal(byId.get("22222222-2222-2222-2222-222222222222").project, `mac-home:${private_}`);
  for (const transcript of result.transcripts) assert.equal(transcript.host, "mac-home");
});

test("user project normalization never requalifies a hosted tier-3 path", async () => {
  const home = tmpdir("remote-user-normalize");
  const localRepo = initRepo(path.join(home, "shared"), "git@github.com:acme/shared.git");

  await withRemoteEnv({ localHome: home, hosts: {} }, async () => {
    const config = loadConfig(null, {}, { kind: "user" });
    const scope = resolveScope(home, { scope: "user" }, config, null, { home });
    assert.equal(scope.associate({ cwd: localRepo, remotes: [] }).tier, 1);
    const remote = {
      host: "mac-home",
      cwd: localRepo,
      project: `mac-home:${localRepo}`,
      association: { tier: 3, project: `mac-home:${localRepo}`, confidence: "path", reason: "remote dead path" },
    };

    scope.normalizeProjects([remote]);
    assert.equal(remote.project, `mac-home:${localRepo}`);
    assert.equal(remote.association.project, `mac-home:${localRepo}`);
    assert.equal(remote.association.reason, "remote dead path");
  });
});

test("every named ssh failure is classified into the message that says what to do next", () => {
  /** @type {[object, string | null, RegExp | null][]} */
  const cases = [
    [{ spawnError: { code: "ENOENT" }, code: null, stderr: "" }, "ssh-missing", /ssh not found on PATH/],
    [
      {
        code: 255,
        stderr:
          "Tailscale SSH requires an additional check.\nTo authenticate, visit: https://login.tailscale.com/a/l148.",
        timedOut: true,
      },
      "tailscale-check",
      /approve it at https:\/\/login\.tailscale\.com\/a\/l148 and re-run/,
    ],
    [{ code: null, stderr: "", timedOut: true }, "unreachable", /unreachable \(no response within 10s\)/],
    [
      { code: 255, stderr: "ssh: connect to host mac-home port 22: Connection refused" },
      "unreachable",
      /unreachable \(ssh: connect to host mac-home port 22: Connection refused\)/,
    ],
    [{ code: 0, stderr: "" }, null, null],
  ];

  for (const [result, reason, message] of cases) {
    const failure = classifySshFailure(result, { destination: "mac-home", timeoutMs: 10_000 });
    if (reason === null) {
      assert.equal(failure, null);
      continue;
    }
    assert.equal(failure.reason, reason);
    assert.match(failure.message, message);
  }
});
