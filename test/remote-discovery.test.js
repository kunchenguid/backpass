import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { applyHostFlag, loadConfig } from "../src/config.js";
import {
  discoverProject,
  initRepo,
  projectRun,
  sshCalls,
  tmpdir,
  withRemoteEnv,
  writeClaudeSession,
} from "./helpers/remote.js";
import {
  disambiguateSourceLabels,
  gapSource,
  ledgerGapObservations,
  recordGapObservations,
} from "../src/gap-ledger.js";
import { classifySshFailure, closeSshMasters } from "../src/discovery/remote/ssh.js";
import { discoverTranscripts } from "../src/discovery/index.js";
import { resolveHostList } from "../src/discovery/hosts.js";
import { resolveScope } from "../src/scope.js";
import { State } from "../src/state.js";
import { SELF_SESSION_SENTINEL } from "../src/sentinel.js";
import { UserError, setLoggerSink } from "../src/logger.js";
import { clearProgressSink, setProgressSink } from "../src/progress.js";
import { foldEvidence } from "../src/fold.js";
import { INTERACTIVE, NON_INTERACTIVE } from "../src/interaction.js";
import { distill, findQuoteProvenance } from "../src/distill.js";

const schemaQuote = "read the schema";
const schemaProvenance = findQuoteProvenance(
  schemaQuote,
  distill([{ kind: "message", role: "assistant", text: schemaQuote }], {}).sources,
);

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

function writeOmpSession(file, id, cwd, timestamp = "2026-08-27T00:00:00.000Z") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: "title", v: 1, title: "" })}\n` +
      `${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd })}\n`,
  );
}

async function withRemotePiEnv(scenario, fn) {
  const keys = ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "BB_DATA_DIR", "BB_PI_BRIDGE_SESSION_DIR"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    return await withRemoteEnv({ localHome: scenario.localHome, hosts: scenario.hosts }, fn);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function observerRecords(transcripts) {
  return transcripts.map((transcript) => ({
    status: "ok",
    memoryPath: "AGENTS.md",
    transcript,
    negative: [{ instruction: "db-rule", class: "harm", quote: "following the rule caused damage" }],
    gaps: [
      {
        proposedInstruction: "Read docs/db.md before writing queries.",
        mistake: "re-derived the schema",
        quote: schemaQuote,
        quoteProvenance: schemaProvenance,
        recurrenceRisk: "high",
        domain: "project",
      },
    ],
  }));
}

function assertSingletonObserver(transcripts, identity) {
  const records = observerRecords(transcripts);
  const folded = foldEvidence(records, { minGapEvidence: 2 });
  assert.equal(folded.gaps.length, 0);
  assert.equal(folded.totals.droppedGapSingletons, 1);
  assert.equal(folded.instructions[0].harmSessions, 1);
  const ledger = { version: 1, entries: {} };
  recordGapObservations(ledger, records);
  const sessions = Object.values(ledger.entries)[0].sessions;
  assert.deepEqual(Object.keys(sessions), [identity]);
  assert.deepEqual(sessions[identity].sightingIds.sort(), transcripts.map((transcript) => transcript.identity).sort());
  assert.equal(sessions[identity].sourceSessionId, transcripts.at(-1).identity);
  assert.equal(sessions[identity].source, gapSource(transcripts.at(-1)));
  assert.ok(sessions[identity].source.includes(transcripts.at(-1).nativeId));
  const persisted = foldEvidence(records, {
    minGapEvidence: 2,
    gapObservations: ledgerGapObservations(ledger, "AGENTS.md"),
  });
  assert.equal(persisted.gaps.length, 0);
  assert.equal(persisted.instructions[0].harmSessions, 1);
}

test("remote OMP subagents keep their parent's corroboration identity", async () => {
  const s = scenario();
  const sessionDir = path.join(s.remoteHome, ".omp", "agent", "sessions", "-repo-demo");
  const parentName = "2026-08-27T00-00-00.000Z_parent-folder";
  const parentPath = path.join(sessionDir, `${parentName}.jsonl`);
  const childPath = path.join(sessionDir, parentName, "Subagent.jsonl");
  writeOmpSession(parentPath, "parent-native", s.remoteClone);
  writeOmpSession(childPath, "child-native", s.remoteClone, "2026-08-27T00:01:00.000Z");

  const piEnv = ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "BB_DATA_DIR", "BB_PI_BRIDGE_SESSION_DIR"];
  const previous = Object.fromEntries(piEnv.map((key) => [key, process.env[key]]));
  for (const key of piEnv) delete process.env[key];
  let result;
  try {
    const disabled = await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts }, () =>
      discoverProject(s.repoRoot, {
        discovery: { hosts: ["mac-home"], harnesses: ["pi"], since: "all" },
      }),
    );
    assert.deepEqual(disabled.transcripts, [], "the remote OMP store is opt-in too");
    result = await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts }, () =>
      discoverProject(s.repoRoot, {
        discovery: { hosts: ["mac-home"], harnesses: ["pi"], since: "all", includeOmp: true },
      }),
    );
  } finally {
    for (const key of piEnv) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }

  const parent = result.transcripts.find((transcript) => transcript.nativeId === "parent-native");
  const child = result.transcripts.find((transcript) => transcript.nativeId === "child-native");
  assert.ok(parent && child);
  assert.notEqual(parent.identity, child.identity);
  assert.equal(child.parentSessionId, "parent-native");
  assert.equal(child.corroborationIdentity, parent.identity);
  assert.equal(child.corroborationNativeId, "parent-native");
  assert.equal(child.corroborationStartedAt, parent.startedAt);
});

test("a copied OMP root and retained remote descendants count as one observer without merging local split roots", async () => {
  const s = scenario();
  const rootName = "2026-08-27T00-00-00.000Z_root";
  const localRoot = path.join(s.localHome, ".omp", "agent", "sessions", "-repo-demo");
  const remoteRoot = path.join(s.remoteHome, ".omp", "agent", "sessions", "-repo-demo");
  writeOmpSession(path.join(localRoot, `${rootName}.jsonl`), "root-native", s.repoRoot);
  writeOmpSession(path.join(remoteRoot, `${rootName}.jsonl`), "root-native", s.remoteClone);
  writeOmpSession(path.join(remoteRoot, rootName, "Child.jsonl"), "child-native", s.remoteClone);
  writeOmpSession(
    path.join(remoteRoot, rootName, "Child", "Child.Grandchild.jsonl"),
    "grandchild-native",
    s.remoteClone,
  );
  const discover = () =>
    withRemotePiEnv(s, () =>
      discoverProject(s.repoRoot, {
        discovery: { hosts: ["mac-home"], harnesses: ["pi"], since: "all", includeOmp: true },
      }),
    );
  const result = await discover();
  assert.equal(result.transcripts.length, 3);
  assert.equal(result.perHost[0].duplicates, 1);
  const root = result.transcripts.find((transcript) => transcript.nativeId === "root-native");
  assert.equal(root.host, null);
  assert.equal(new Set(result.transcripts.map((transcript) => transcript.identity)).size, 3);
  assert.equal(new Set(result.transcripts.map((transcript) => transcript.nativeId)).size, 3);
  for (const descendant of result.transcripts.filter((transcript) => transcript !== root)) {
    assert.equal(descendant.host, "mac-home");
    assert.ok(descendant.path.startsWith(remoteRoot));
    assert.equal(descendant.parentSessionId, "root-native");
    assert.equal(descendant.corroborationIdentity, root.identity);
    assert.equal(descendant.corroborationNativeId, "root-native");
    assert.equal(descendant.interaction, NON_INTERACTIVE);
  }
  const records = result.transcripts.map((transcript) => ({
    status: "ok",
    memoryPath: "AGENTS.md",
    transcript,
    gaps: [
      {
        proposedInstruction: "Read docs/db.md before writing queries.",
        mistake: "re-derived the schema",
        quote: schemaQuote,
        quoteProvenance: schemaProvenance,
        recurrenceRisk: "high",
        domain: "project",
      },
    ],
  }));
  const folded = foldEvidence(records, { minGapEvidence: 2 });
  assert.equal(folded.gaps.length, 0);
  assert.equal(folded.totals.droppedGapSingletons, 1);
  const ledger = { version: 1, entries: {} };
  recordGapObservations(ledger, records);
  assert.deepEqual(Object.keys(Object.values(ledger.entries)[0].sessions), [root.identity]);

  const splitPath = path.join(s.localHome, ".omp", "agent", "sessions", "-repo-demo", "split-root.jsonl");
  writeOmpSession(splitPath, "root-native", s.repoRoot);
  writeOmpSession(path.join(localRoot, rootName, "Child.jsonl"), "child-native", s.repoRoot);
  writeOmpSession(path.join(remoteRoot, "independent.jsonl"), "independent-native", s.remoteClone);
  const split = await discover();
  const roots = split.transcripts.filter((transcript) => transcript.nativeId === "root-native");
  assert.equal(roots.length, 2);
  assert.ok(roots.every((transcript) => transcript.host === null));
  assert.equal(new Set(roots.map((transcript) => transcript.corroborationIdentity)).size, 2);
  const localChild = split.transcripts.find((transcript) => transcript.nativeId === "child-native");
  assert.equal(localChild.host, null);
  assert.equal(localChild.corroborationIdentity, root.identity);
  const grandchild = split.transcripts.find((transcript) => transcript.nativeId === "grandchild-native");
  const splitRoot = roots.find((transcript) => transcript.path === splitPath);
  assert.equal(grandchild.corroborationIdentity, localChild.corroborationIdentity);
  assert.notEqual(grandchild.corroborationIdentity, splitRoot.identity);
  assertSingletonObserver([localChild, grandchild], root.identity);
  const independentRootEvidence = foldEvidence(observerRecords([localChild, grandchild, splitRoot]), {
    minGapEvidence: 2,
  });
  assert.equal(independentRootEvidence.gaps.length, 1);
  assert.equal(independentRootEvidence.instructions[0].harmSessions, 2);
  const independent = split.transcripts.find((transcript) => transcript.nativeId === "independent-native");
  assert.ok(independent);
  assert.equal(independent.corroborationIdentity, independent.identity);
  assert.ok(roots.every((transcript) => transcript.corroborationIdentity !== independent.identity));
});

for (const remoteOnly of [false, true]) {
  for (const filtered of [false, true]) {
    test(`copied orphan siblings reconcile every readable-root correspondence (${remoteOnly ? "remote-only" : "local"}, ${filtered ? "filtered" : "all"})`, async () => {
      const s = scenario();
      const now = Date.parse("2026-08-28T12:00:00.000Z");
      const old = "2026-08-27T00:00:00.000Z";
      const recent = "2026-08-28T11:00:00.000Z";
      const firstHome = remoteOnly ? s.remoteHome : s.localHome;
      const firstCwd = remoteOnly ? s.remoteClone : s.repoRoot;
      const secondHome = remoteOnly ? tmpdir("remote-other") : s.remoteHome;
      const secondCwd = remoteOnly
        ? initRepo(path.join(secondHome, "code", "demo"), `https://${REMOTE}.git`)
        : s.remoteClone;
      if (remoteOnly) s.hosts["mac-other"] = { home: secondHome };
      const rootName = "2026-08-27T00-00-00.000Z_root";
      const firstDirectory = path.join(firstHome, ".omp", "agent", "sessions", "-repo-demo");
      const secondDirectory = path.join(secondHome, ".omp", "agent", "sessions", "-repo-demo");
      const write = (file, id, cwd, timestamp) => {
        writeOmpSession(file, id, cwd, timestamp);
        fs.utimesSync(file, Date.parse(timestamp) / 1000, Date.parse(timestamp) / 1000);
      };
      write(path.join(firstDirectory, `${rootName}.jsonl`), "root-native", firstCwd, old);
      fs.writeFileSync(path.join(firstDirectory, `${rootName}.jsonl`), "not a session header\n");
      write(path.join(secondDirectory, `${rootName}.jsonl`), "root-native", secondCwd, old);
      for (const [name, id] of [
        ["A", "a-native"],
        ["B", "b-native"],
      ]) {
        write(path.join(firstDirectory, rootName, `${name}.jsonl`), id, firstCwd, recent);
        write(path.join(secondDirectory, rootName, `${name}.jsonl`), id, secondCwd, recent);
      }
      write(path.join(secondDirectory, rootName, "C.jsonl"), "c-native", secondCwd, recent);
      const result = await withRemotePiEnv(s, async () => {
        const options = projectRun(s.repoRoot, {
          discovery: {
            hosts: remoteOnly ? ["mac-home", "mac-other"] : ["mac-home"],
            harnesses: ["pi"],
            since: filtered ? "1d" : "all",
            includeOmp: true,
          },
        });
        const discovered = await discoverTranscripts({ ...options, now });
        await closeSshMasters(discovered.remoteMasters);
        return discovered;
      });
      assert.equal(result.transcripts.length, filtered ? 3 : 4);
      assert.equal(result.perHost.at(-1).duplicates, 2);
      const a = result.transcripts.find((transcript) => transcript.nativeId === "a-native");
      const b = result.transcripts.find((transcript) => transcript.nativeId === "b-native");
      const c = result.transcripts.find((transcript) => transcript.nativeId === "c-native");
      assert.ok(a && b && c);
      assert.notEqual(a.identity, b.identity);
      for (const transcript of [a, b]) {
        assert.equal(transcript.host, remoteOnly ? "mac-home" : null);
        assert.equal(transcript.parentSessionId, undefined);
        assert.equal(transcript.corroborationNativeId, transcript.nativeId);
        assert.equal(transcript.interactionSignals.source, "subagent");
        assert.equal(transcript.interaction, NON_INTERACTIVE);
      }
      assert.equal(c.host, remoteOnly ? "mac-other" : "mac-home");
      assert.equal(c.parentSessionId, "root-native");
      assert.equal(c.corroborationNativeId, "root-native");
      assert.equal(c.corroborationStartedAt, Date.parse(old));
      assert.equal(new Set(result.transcripts.map((transcript) => transcript.corroborationIdentity)).size, 1);
      assertSingletonObserver(result.transcripts, a.corroborationIdentity);
    });
  }
}

for (const filtered of [false, true]) {
  test(`established orphan correspondence wins native-root fallback on later hosts (${filtered ? "filtered" : "all"})`, async () => {
    const s = scenario();
    const otherHome = tmpdir("remote-other");
    const otherClone = initRepo(path.join(otherHome, "code", "demo"), `https://${REMOTE}.git`);
    s.hosts["mac-other"] = { home: otherHome };
    const now = Date.parse("2026-08-28T12:00:00.000Z");
    const old = "2026-08-27T00:00:00.000Z";
    const recent = "2026-08-28T11:00:00.000Z";
    const rootName = "2026-08-27T00-00-00.000Z_root";
    const localDirectory = path.join(s.localHome, ".omp", "agent", "sessions", "-repo-demo");
    const remoteDirectory = path.join(s.remoteHome, ".omp", "agent", "sessions", "-repo-demo");
    const otherDirectory = path.join(otherHome, ".omp", "agent", "sessions", "-repo-demo");
    const independentPath = path.join(s.localHome, ".omp", "agent", "sessions", "-repo-demo", "split-root.jsonl");
    const write = (file, id, cwd, timestamp) => {
      writeOmpSession(file, id, cwd, timestamp);
      fs.utimesSync(file, Date.parse(timestamp) / 1000, Date.parse(timestamp) / 1000);
    };
    write(independentPath, "root-native", s.repoRoot, recent);
    write(path.join(localDirectory, `${rootName}.jsonl`), "root-native", s.repoRoot, old);
    fs.writeFileSync(path.join(localDirectory, `${rootName}.jsonl`), "not a session header\n");
    write(path.join(localDirectory, rootName, "A.jsonl"), "a-native", s.repoRoot, recent);
    write(path.join(remoteDirectory, `${rootName}.jsonl`), "root-native", s.remoteClone, old);
    write(path.join(remoteDirectory, rootName, "A.jsonl"), "a-native", s.remoteClone, recent);
    write(path.join(remoteDirectory, rootName, "B.jsonl"), "b-native", s.remoteClone, recent);
    write(path.join(otherDirectory, `${rootName}.jsonl`), "root-native", otherClone, old);
    write(path.join(otherDirectory, rootName, "C.jsonl"), "c-native", otherClone, recent);
    const result = await withRemotePiEnv(s, async () => {
      const options = projectRun(s.repoRoot, {
        discovery: {
          hosts: ["mac-home", "mac-other"],
          harnesses: ["pi"],
          since: filtered ? "1d" : "all",
          includeOmp: true,
        },
      });
      const discovered = await discoverTranscripts({ ...options, now });
      await closeSshMasters(discovered.remoteMasters);
      return discovered;
    });
    assert.equal(result.transcripts.length, 4);
    assert.deepEqual(
      result.perHost.map((host) => host.duplicates),
      filtered ? [1, 0] : [2, 1],
    );
    const independent = result.transcripts.find((transcript) => transcript.path === independentPath);
    const a = result.transcripts.find((transcript) => transcript.nativeId === "a-native");
    const b = result.transcripts.find((transcript) => transcript.nativeId === "b-native");
    const c = result.transcripts.find((transcript) => transcript.nativeId === "c-native");
    assert.ok(independent && a && b && c);
    assert.equal(independent.host, null);
    assert.equal(independent.interaction, INTERACTIVE);
    assert.equal(independent.parentSessionId, undefined);
    assert.equal(independent.corroborationIdentity, independent.identity);
    assert.equal(a.host, null);
    assert.equal(a.parentSessionId, undefined);
    assert.equal(a.interactionSignals.source, "subagent");
    assert.equal(a.corroborationNativeId, "a-native");
    assert.equal(a.corroborationIdentity, a.identity);
    assert.equal(b.host, "mac-home");
    assert.equal(c.host, "mac-other");
    for (const transcript of [b, c]) {
      assert.equal(transcript.parentSessionId, "root-native");
      assert.equal(transcript.corroborationNativeId, "root-native");
      assert.equal(transcript.corroborationStartedAt, Date.parse(old));
      assert.equal(transcript.corroborationIdentity, a.identity);
      assert.equal(transcript.interaction, NON_INTERACTIVE);
      assert.notEqual(transcript.identity, a.identity);
    }
    assert.notEqual(independent.corroborationIdentity, a.corroborationIdentity);
    assertSingletonObserver([b, c], a.identity);
    assertSingletonObserver([a, b, c], a.identity);
    const records = observerRecords([independent, b, c]);
    const folded = foldEvidence(records, { minGapEvidence: 2 });
    assert.equal(folded.gaps.length, 1);
    assert.equal(folded.instructions[0].harmSessions, 2);
    const ledger = { version: 1, entries: {} };
    recordGapObservations(ledger, records);
    assert.deepEqual(
      Object.keys(Object.values(ledger.entries)[0].sessions).sort(),
      [independent.identity, a.identity].sort(),
    );
    const persisted = foldEvidence(records, {
      minGapEvidence: 2,
      gapObservations: ledgerGapObservations(ledger, "AGENTS.md"),
    });
    assert.equal(persisted.gaps.length, 1);
    assert.equal(persisted.instructions[0].harmSessions, 2);
  });
}

for (const remoteOnly of [false, true]) {
  for (const filtered of [false, true]) {
    test(`copied descendants retain their split-root family (${remoteOnly ? "remote-only" : "local"}, ${filtered ? "filtered" : "all"})`, async () => {
      const s = scenario();
      const now = Date.parse("2026-08-28T12:00:00.000Z");
      const old = "2026-08-27T00:00:00.000Z";
      const recent = "2026-08-28T11:00:00.000Z";
      const firstHome = remoteOnly ? s.remoteHome : s.localHome;
      const firstCwd = remoteOnly ? s.remoteClone : s.repoRoot;
      const secondHome = remoteOnly ? tmpdir("remote-other") : s.remoteHome;
      const secondCwd = remoteOnly
        ? initRepo(path.join(secondHome, "code", "demo"), `https://${REMOTE}.git`)
        : s.remoteClone;
      if (remoteOnly) s.hosts["mac-other"] = { home: secondHome };
      const rootName = "2026-08-27T00-00-00.000Z_root";
      const familyDirectory = path.join(firstHome, ".omp", "agent", "sessions", "-repo-demo");
      const independentPath = path.join(familyDirectory, "split-root.jsonl");
      const familyPath = path.join(familyDirectory, `${rootName}.jsonl`);
      const childPath = path.join(familyDirectory, rootName, "Child.jsonl");
      const copiedDirectory = path.join(secondHome, ".omp", "agent", "sessions", "-repo-demo");
      const grandchildPath = path.join(copiedDirectory, rootName, "Child", "Child.Grandchild.jsonl");
      const write = (file, id, cwd, timestamp) => {
        writeOmpSession(file, id, cwd, timestamp);
        fs.utimesSync(file, Date.parse(timestamp) / 1000, Date.parse(timestamp) / 1000);
      };
      write(independentPath, "root-native", firstCwd, recent);
      write(familyPath, "root-native", firstCwd, old);
      write(childPath, "child-native", firstCwd, recent);
      write(path.join(copiedDirectory, `${rootName}.jsonl`), "root-native", secondCwd, old);
      write(path.join(copiedDirectory, rootName, "Child.jsonl"), "child-native", secondCwd, recent);
      write(grandchildPath, "grandchild-native", secondCwd, recent);
      const result = await withRemotePiEnv(s, async () => {
        const options = projectRun(s.repoRoot, {
          discovery: {
            hosts: remoteOnly ? ["mac-home", "mac-other"] : ["mac-home"],
            harnesses: ["pi"],
            since: filtered ? "1d" : "all",
            includeOmp: true,
          },
        });
        const discovered = await discoverTranscripts({ ...options, now });
        await closeSshMasters(discovered.remoteMasters);
        return discovered;
      });
      assert.equal(result.transcripts.length, filtered ? 3 : 4);
      assert.equal(result.perHost.at(-1).duplicates, filtered ? 1 : 2);
      const independent = result.transcripts.find((transcript) => transcript.path === independentPath);
      const family = result.transcripts.find((transcript) => transcript.path === familyPath);
      const child = result.transcripts.find((transcript) => transcript.nativeId === "child-native");
      const grandchild = result.transcripts.find((transcript) => transcript.nativeId === "grandchild-native");
      assert.ok(independent && child && grandchild);
      assert.equal(child.path, childPath);
      assert.equal(child.host, remoteOnly ? "mac-home" : null);
      assert.equal(grandchild.path, grandchildPath);
      assert.equal(grandchild.host, remoteOnly ? "mac-other" : "mac-home");
      assert.notEqual(child.identity, grandchild.identity);
      assert.equal(independent.nativeId, "root-native");
      assert.equal(independent.corroborationIdentity, independent.identity);
      assert.notEqual(independent.corroborationIdentity, child.corroborationIdentity);
      assert.equal(grandchild.corroborationIdentity, child.corroborationIdentity);
      for (const transcript of [child, grandchild]) {
        assert.equal(transcript.parentSessionId, "root-native");
        assert.equal(transcript.corroborationNativeId, "root-native");
        assert.equal(transcript.corroborationStartedAt, Date.parse(old));
        assert.equal(transcript.interaction, NON_INTERACTIVE);
      }
      if (filtered) {
        assert.equal(family, undefined);
      } else {
        assert.ok(family);
        assert.equal(family.nativeId, independent.nativeId);
        assert.notEqual(family.identity, independent.identity);
        assert.equal(family.corroborationIdentity, family.identity);
        assert.equal(child.corroborationIdentity, family.identity);
      }
      assertSingletonObserver([child, grandchild], child.corroborationIdentity);
      const records = observerRecords([child, grandchild, independent]);
      const folded = foldEvidence(records, { minGapEvidence: 2 });
      assert.equal(folded.gaps.length, 1);
      assert.equal(folded.instructions[0].harmSessions, 2);
      const ledger = { version: 1, entries: {} };
      recordGapObservations(ledger, records);
      assert.equal(Object.keys(Object.values(ledger.entries)[0].sessions).length, 2);
      const persisted = foldEvidence(records, {
        minGapEvidence: 2,
        gapObservations: ledgerGapObservations(ledger, "AGENTS.md"),
      });
      assert.equal(persisted.gaps.length, 1);
      assert.equal(persisted.instructions[0].harmSessions, 2);
    });
  }
}

for (const remoteOnly of [false, true]) {
  for (const missingFirstRoot of [false, true]) {
    for (const filtered of [false, true]) {
      test(`copied descendants share an observer with a missing ${missingFirstRoot ? "retained" : "dropped"} ancestor (${remoteOnly ? "remote-only" : "local"}, ${filtered ? "filtered" : "all"})`, async () => {
        const s = scenario();
        const now = Date.parse("2026-08-28T12:00:00.000Z");
        const old = "2026-08-27T00:00:00.000Z";
        const recent = "2026-08-28T11:00:00.000Z";
        const firstHome = remoteOnly ? s.remoteHome : s.localHome;
        const firstCwd = remoteOnly ? s.remoteClone : s.repoRoot;
        const secondHome = remoteOnly ? tmpdir("remote-other") : s.remoteHome;
        const secondCwd = remoteOnly
          ? initRepo(path.join(secondHome, "code", "demo"), `https://${REMOTE}.git`)
          : s.remoteClone;
        if (remoteOnly) s.hosts["mac-other"] = { home: secondHome };
        const rootName = "2026-08-27T00-00-00.000Z_root";
        const firstDirectory = path.join(firstHome, ".omp", "agent", "sessions", "-repo-demo");
        const secondDirectory = path.join(secondHome, ".omp", "agent", "sessions", "-repo-demo");
        const firstRootPath = path.join(firstDirectory, `${rootName}.jsonl`);
        const secondRootPath = path.join(secondDirectory, `${rootName}.jsonl`);
        const childPath = path.join(firstDirectory, rootName, "Child.jsonl");
        const copiedChildPath = path.join(secondDirectory, rootName, "Child.jsonl");
        const grandchildPath = path.join(secondDirectory, rootName, "Child", "Child.Grandchild.jsonl");
        const independentPath = path.join(firstHome, ".omp", "agent", "sessions", "-repo-demo", "split-root.jsonl");
        const write = (file, id, cwd, timestamp) => {
          writeOmpSession(file, id, cwd, timestamp);
          fs.utimesSync(file, Date.parse(timestamp) / 1000, Date.parse(timestamp) / 1000);
        };
        write(independentPath, "root-native", firstCwd, recent);
        write(firstRootPath, "root-native", firstCwd, old);
        write(secondRootPath, "root-native", secondCwd, old);
        fs.writeFileSync(missingFirstRoot ? firstRootPath : secondRootPath, "not a session header\n");
        write(childPath, "child-native", firstCwd, recent);
        write(copiedChildPath, "child-native", secondCwd, recent);
        write(grandchildPath, "grandchild-native", secondCwd, recent);
        const result = await withRemotePiEnv(s, async () => {
          const options = projectRun(s.repoRoot, {
            discovery: {
              hosts: remoteOnly ? ["mac-home", "mac-other"] : ["mac-home"],
              harnesses: ["pi"],
              since: filtered ? "1d" : "all",
              includeOmp: true,
            },
          });
          const discovered = await discoverTranscripts({ ...options, now });
          await closeSshMasters(discovered.remoteMasters);
          return discovered;
        });
        assert.equal(result.transcripts.length, !filtered && !missingFirstRoot ? 4 : 3);
        assert.equal(result.perHost.at(-1).duplicates, !filtered && missingFirstRoot ? 2 : 1);
        const independent = result.transcripts.find((transcript) => transcript.path === independentPath);
        const child = result.transcripts.find((transcript) => transcript.nativeId === "child-native");
        const grandchild = result.transcripts.find((transcript) => transcript.nativeId === "grandchild-native");
        assert.ok(independent && child && grandchild);
        assert.equal(child.path, childPath);
        assert.equal(child.host, remoteOnly ? "mac-home" : null);
        assert.equal(grandchild.path, grandchildPath);
        assert.equal(grandchild.host, remoteOnly ? "mac-other" : "mac-home");
        assert.notEqual(child.identity, grandchild.identity);
        assert.equal(child.parentSessionId, missingFirstRoot ? undefined : "root-native");
        assert.equal(grandchild.parentSessionId, missingFirstRoot ? "root-native" : "child-native");
        assert.equal(child.interactionSignals.source, "subagent");
        assert.equal(child.interaction, NON_INTERACTIVE);
        assert.equal(grandchild.interaction, NON_INTERACTIVE);
        const familyIdentity = missingFirstRoot ? child.identity : child.corroborationIdentity;
        assert.equal(grandchild.corroborationIdentity, familyIdentity);
        assert.equal(independent.corroborationIdentity, independent.identity);
        assert.notEqual(independent.identity, familyIdentity);
        if (missingFirstRoot) {
          assert.equal(child.corroborationIdentity, child.identity);
          assert.equal(child.corroborationNativeId, "child-native");
        } else {
          assert.equal(child.corroborationNativeId, "root-native");
          const family = result.transcripts.find((transcript) => transcript.path === firstRootPath);
          if (filtered) assert.equal(family, undefined);
          else assert.equal(family.identity, familyIdentity);
        }
        assertSingletonObserver([child, grandchild], familyIdentity);
        const records = observerRecords([child, grandchild, independent]);
        const folded = foldEvidence(records, { minGapEvidence: 2 });
        assert.equal(folded.gaps.length, 1);
        assert.equal(folded.instructions[0].harmSessions, 2);
        const ledger = { version: 1, entries: {} };
        recordGapObservations(ledger, records);
        assert.deepEqual(
          Object.keys(Object.values(ledger.entries)[0].sessions).sort(),
          [familyIdentity, independent.identity].sort(),
        );
        const persisted = foldEvidence(records, {
          minGapEvidence: 2,
          gapObservations: ledgerGapObservations(ledger, "AGENTS.md"),
        });
        assert.equal(persisted.gaps.length, 1);
        assert.equal(persisted.instructions[0].harmSessions, 2);
      });
    }
  }
}

test("filtered OMP roots still share one cross-host gap and harm observer", async () => {
  const now = Date.parse("2026-08-28T12:00:00.000Z");
  const old = Date.parse("2026-08-27T00:00:00.000Z");
  const recent = "2026-08-28T11:00:00.000Z";
  for (const includeLocal of [true, false]) {
    const s = scenario();
    const otherHome = tmpdir("remote-other");
    const otherClone = initRepo(path.join(otherHome, "code", "demo"), `https://${REMOTE}.git`);
    s.hosts["mac-other"] = { home: otherHome };
    const rootName = "2026-08-27T00-00-00.000Z_root";
    const stores = [
      [s.localHome, s.repoRoot],
      [s.remoteHome, s.remoteClone],
      [otherHome, otherClone],
    ].map(([home, cwd]) => ({
      directory: path.join(home, ".omp", "agent", "sessions", "-repo-demo"),
      cwd,
    }));
    for (const store of stores) {
      const rootPath = path.join(store.directory, `${rootName}.jsonl`);
      writeOmpSession(rootPath, "root-native", store.cwd);
      fs.utimesSync(rootPath, old / 1000, old / 1000);
    }
    const writeRecent = (file, id, cwd) => {
      writeOmpSession(file, id, cwd, recent);
      fs.utimesSync(file, Date.parse(recent) / 1000, Date.parse(recent) / 1000);
    };
    if (includeLocal) {
      writeRecent(path.join(stores[0].directory, rootName, "Local.jsonl"), "local-child", s.repoRoot);
    }
    writeRecent(path.join(stores[1].directory, rootName, "Remote.jsonl"), "remote-child", s.remoteClone);
    writeRecent(path.join(stores[2].directory, rootName, "Other.jsonl"), "other-child", otherClone);
    writeRecent(
      path.join(stores[2].directory, rootName, "Other", "Other.Grandchild.jsonl"),
      "other-grandchild",
      otherClone,
    );
    const discover = () =>
      withRemotePiEnv(s, async () => {
        const options = projectRun(s.repoRoot, {
          discovery: { hosts: ["mac-home", "mac-other"], harnesses: ["pi"], since: "1d", includeOmp: true },
        });
        const result = await discoverTranscripts({ ...options, now });
        await closeSshMasters(result.remoteMasters);
        return result;
      });
    const result = await discover();
    assert.equal(result.cutoffMs, now - 24 * 60 * 60 * 1000);
    assert.deepEqual(
      result.transcripts.map((transcript) => transcript.nativeId).sort(),
      [...(includeLocal ? ["local-child"] : []), "other-child", "other-grandchild", "remote-child"].sort(),
      "old roots are excluded while every distinct recent descendant is retained",
    );
    assert.ok(result.perHost.every((host) => host.duplicates === 0));
    assert.equal(new Set(result.transcripts.map((transcript) => transcript.identity)).size, result.transcripts.length);
    assert.equal(new Set(result.transcripts.map((transcript) => transcript.corroborationIdentity)).size, 1);
    for (const transcript of result.transcripts) {
      assert.equal(transcript.parentSessionId, "root-native");
      assert.equal(transcript.corroborationNativeId, "root-native");
      assert.equal(transcript.corroborationStartedAt, old);
      assert.equal(transcript.interaction, NON_INTERACTIVE);
    }
    const recordsFor = (transcripts) =>
      transcripts.map((transcript) => ({
        status: "ok",
        memoryPath: "AGENTS.md",
        transcript,
        negative: [{ instruction: "db-rule", class: "harm", quote: "following the rule caused damage" }],
        gaps: [
          {
            proposedInstruction: "Read docs/db.md before writing queries.",
            mistake: "re-derived the schema",
            quote: schemaQuote,
            quoteProvenance: schemaProvenance,
            recurrenceRisk: "high",
            domain: "project",
          },
        ],
      }));
    const records = recordsFor(result.transcripts);
    const folded = foldEvidence(records, { minGapEvidence: 2 });
    assert.equal(folded.gaps.length, 0);
    assert.equal(folded.totals.droppedGapSingletons, 1);
    assert.equal(folded.instructions[0].harmSessions, 1);
    const ledger = { version: 1, entries: {} };
    recordGapObservations(ledger, records, { now: new Date(now) });
    assert.equal(Object.keys(Object.values(ledger.entries)[0].sessions).length, 1);
    const persisted = foldEvidence(records, {
      minGapEvidence: 2,
      gapObservations: ledgerGapObservations(ledger, "AGENTS.md"),
    });
    assert.equal(persisted.gaps.length, 0);
    assert.equal(persisted.instructions[0].harmSessions, 1);

    if (includeLocal) {
      const splitPath = path.join(s.localHome, ".omp", "agent", "sessions", "-repo-demo", "split-root.jsonl");
      writeRecent(splitPath, "root-native", s.repoRoot);
      const split = await discover();
      const ordinary = split.transcripts.find((transcript) => transcript.path === splitPath);
      const localChild = split.transcripts.find((transcript) => transcript.nativeId === "local-child");
      assert.equal(ordinary.interaction, INTERACTIVE);
      assert.equal(ordinary.parentSessionId, undefined);
      assert.equal(ordinary.corroborationIdentity, ordinary.identity);
      assert.notEqual(ordinary.corroborationIdentity, localChild.corroborationIdentity);
      assert.equal(new Set(split.transcripts.map((transcript) => transcript.corroborationIdentity)).size, 2);
      const splitFolded = foldEvidence(recordsFor(split.transcripts), { minGapEvidence: 2 });
      assert.equal(splitFolded.gaps.length, 1);
      assert.equal(splitFolded.instructions[0].harmSessions, 2);
    }
  }
});

test("remote nested OMP automation is non-interactive without readable ancestor provenance", async () => {
  const s = scenario();
  const sessionRoot = path.join(s.remoteHome, ".omp", "agent", "sessions", "-repo-demo");
  writeOmpSession(path.join(sessionRoot, "root", "Child.jsonl"), "child-native", s.remoteClone);
  writeOmpSession(
    path.join(sessionRoot, "other-root", "Missing", "Missing.Grandchild.jsonl"),
    "grandchild-native",
    s.remoteClone,
  );
  fs.writeFileSync(path.join(sessionRoot, "root.jsonl"), "not a session header\n");
  const result = await withRemotePiEnv(s, () =>
    discoverProject(s.repoRoot, {
      discovery: { hosts: ["mac-home"], harnesses: ["pi"], since: "all", includeOmp: true },
    }),
  );
  assert.equal(result.transcripts.length, 2);
  for (const transcript of result.transcripts) {
    assert.equal(transcript.host, "mac-home");
    assert.equal(transcript.interactionSignals.source, "subagent");
    assert.equal(transcript.interaction, NON_INTERACTIVE);
    assert.equal(transcript.parentSessionId, undefined);
    assert.equal(transcript.corroborationIdentity, transcript.identity);
    assert.equal(transcript.corroborationNativeId, transcript.nativeId);
    assert.equal(transcript.corroborationStartedAt, transcript.startedAt);
  }
  writeOmpSession(path.join(sessionRoot, "root.jsonl"), "root-native", s.remoteClone);
  writeOmpSession(path.join(sessionRoot, "other-root.jsonl"), "other-root-native", s.remoteClone);
  const refreshed = await withRemotePiEnv(s, () =>
    discoverProject(s.repoRoot, {
      discovery: { hosts: ["mac-home"], harnesses: ["pi"], since: "all", includeOmp: true },
    }),
  );
  for (const [childId, rootId] of [
    ["child-native", "root-native"],
    ["grandchild-native", "other-root-native"],
  ]) {
    const child = refreshed.transcripts.find((transcript) => transcript.nativeId === childId);
    const root = refreshed.transcripts.find((transcript) => transcript.nativeId === rootId);
    assert.equal(child.parentSessionId, rootId);
    assert.equal(child.corroborationIdentity, root.identity);
    assert.equal(child.interaction, NON_INTERACTIVE);
    assert.equal(root.interaction, INTERACTIVE);
  }
});

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
  assert.deepEqual(
    sshCalls(s.log).map((call) => [call.destination, call.op]),
    [
      ["mac-home", "master:start"],
      ["mac-home", null],
      ["mac-home", "discover"],
      ["mac-home", "master:stop"],
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

test("a control-master failure skips one host while another still collects", async () => {
  const localHome = tmpdir("remote-master-failure-local");
  const goodHome = tmpdir("remote-master-failure-good");
  const repoRoot = initRepo(path.join(localHome, "demo"), `https://${REMOTE}.git`);
  const goodClone = initRepo(path.join(goodHome, "demo"), `git@github.com:acme/demo.git`);
  writeClaudeSession(goodHome, { cwd: goodClone });
  const log = path.join(localHome, "ssh.log");
  const hosts = {
    broken: { home: goodHome, masterFail: { stderr: "broken: Permission denied (publickey).", code: 255 } },
    working: { home: goodHome },
  };

  const result = await withRemoteEnv({ localHome, hosts, log }, () =>
    discoverProject(repoRoot, { discovery: { hosts: ["broken", "working"], harnesses: ["claude"] } }),
  );

  assert.equal(result.transcripts.length, 1);
  assert.equal(result.transcripts[0].host, "working");
  assert.match(result.perHost[0].error, /make "ssh broken true" succeed without a prompt/);
  assert.equal(result.perHost[1].error, null);
  assert.deepEqual(
    sshCalls(log).map((call) => [call.destination, call.op]),
    [
      ["broken", "master:start"],
      ["working", "master:start"],
      ["working", null],
      ["working", "discover"],
      ["working", "master:stop"],
    ],
  );
});

test("an authentication failure skips the host with the command to make succeed, and keeps local results", async () => {
  const s = scenario({
    variant: { masterFail: { stderr: "kunchen@mac-home: Permission denied (publickey,keyboard-interactive)." } },
  });
  writeClaudeSession(s.localHome, { cwd: s.repoRoot, id: "aaaaaaaa-1111-2222-3333-444444444444" });

  const result = await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts }, () =>
    discoverProject(s.repoRoot, { discovery: { hosts: ["mac-home"] } }),
  );

  assert.equal(result.transcripts.length, 1, "the local session is still collected");
  assert.equal(result.transcripts[0].host, null);
  assert.match(result.perHost[0].error, /make "ssh mac-home true" succeed without a prompt/);
});

test("a Tailscale check-mode master preserves its approval URL", async () => {
  const s = scenario({
    variant: {
      masterFail: {
        stderr:
          "Tailscale SSH requires an additional check.\nTo authenticate, visit: https://login.tailscale.com/a/l148.",
        code: 255,
      },
    },
  });

  const result = await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts }, () =>
    discoverProject(s.repoRoot, { discovery: { hosts: ["mac-home"] } }),
  );

  assert.match(result.perHost[0].error, /approve it at https:\/\/login\.tailscale\.com\/a\/l148 and re-run/);
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
      paths: {},
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

test("an unsafe configured node path is refused before ssh runs", async () => {
  const s = scenario();
  const error = await withRemoteEnv({ localHome: s.localHome, hosts: s.hosts, log: s.log }, async () => {
    try {
      await discoverProject(s.repoRoot, {
        discovery: { hosts: [{ host: "mac-home", node: "/usr/bin/no'de" }], harnesses: ["claude"] },
      });
    } catch (err) {
      return err;
    }
    return null;
  });

  assert.ok(error instanceof UserError);
  assert.match(error.message, /remote node path/);
  assert.deepEqual(sshCalls(s.log), []);
});

test("host configuration validates OpenSSH values and treats each flag as one exact destination", () => {
  assert.throws(
    () => resolveHostList({ discovery: { hosts: [{ host: "mac-home", node: "node" }] } }),
    /absolute POSIX path/,
  );
  assert.throws(
    () => resolveHostList({ discovery: { hosts: [{ host: "mac-home", connectTimeoutSeconds: 0.5 }] } }),
    /connectTimeoutSeconds must be a positive integer/,
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
    const discovered = await discoverTranscripts({ repo: scope.repo, scope, config, strict: false });
    await closeSshMasters(discovered.remoteMasters);
    return discovered;
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
