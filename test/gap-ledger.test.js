import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { evidenceKey, State } from "../src/state.js";
import { distill, findQuoteProvenance } from "../src/distill.js";
import { parseMemoryUnits } from "../src/memory.js";
import { foldForRun } from "../src/commands/propose.js";
import { foldEvidence, renderEvidenceForPrompt, renderEvidenceReport } from "../src/fold.js";
import {
  gapEntryId,
  ledgerGapObservations,
  mergeGapEntries,
  pruneGapLedger,
  recordGapObservations,
  normalizeGapLedgerSessions,
} from "../src/gap-ledger.js";
import { routingFor, workedPaths } from "../src/nested.js";
import { buildProposal } from "../src/proposal.js";
import { makeRepo, stageAndMeasure, writeIn } from "./helpers/staging.js";

const MEMORY_PATH = "AGENTS.md";
const DAY = 86_400_000;

function sourceProof(quote) {
  const { sources } = distill([{ kind: "message", role: "assistant", text: quote }], {});
  return findQuoteProvenance(quote, sources);
}

function memoryFile(text = "# T\n\n- Run pnpm test before pushing.\n- Keep the README current.\n") {
  return { path: MEMORY_PATH, units: parseMemoryUnits(text) };
}

function record(id, gaps, { startedAt = Date.parse("2026-08-01T00:00:00Z"), memoryHash = "h1" } = {}) {
  const transcript = { id, identity: id, harness: "claude", startedAt, interaction: "interactive" };
  return {
    status: "ok",
    transcript,
    memoryPath: MEMORY_PATH,
    memoryHash,
    key: evidenceKey(transcript, memoryHash),
    positive: [],
    negative: [],
    gaps: gaps.map((gap) => {
      const observed = {
        proposedInstruction: typeof gap === "string" ? gap : gap.proposedInstruction,
        mistake: "re-derived it",
        quote: `quote from ${id}`,
        recurrenceRisk: "high",
        ...(typeof gap === "string" ? {} : gap),
      };
      return { ...observed, quoteProvenance: sourceProof(observed.quote) };
    }),
  };
}

/** A throwaway `.backpass/` and a ctx shaped like the one `foldForRun` reads. */
function harness(overrides = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-ledger-")));
  const state = new State(root).ensure();
  const ctx = { config: { state, minGapEvidence: 2, gapLedgerMaxAge: "90d", ...overrides } };
  return { root, state, ctx };
}

/** One backpass run: the evidence files on disk at the time, then the fold. */
async function run(h, records, file = memoryFile(), memoryHash = "h1") {
  for (const r of records) h.state.writeEvidence(r.transcript.id, r);
  const selected = h.state
    .listEvidence()
    .filter((evidence) => evidence.memoryHash === memoryHash)
    .map((evidence) => evidence.transcript);
  return foldForRun(h.ctx, file, memoryHash, [], selected);
}

const GAP = "Read docs/db.md before writing queries.";
const GAP_REPHRASED = "Read docs/db.md before writing any queries";

test("keyless legacy evidence stays out of the fold", async () => {
  const h = harness();
  const stale = record("claude-old", [GAP]);
  delete stale.key;
  const summary = await run(h, [stale]);

  assert.equal(summary.analyzedSessions, 0);
  assert.equal(summary.totals.gapSightings, 0);
  assert.deepEqual(h.state.readGapLedger().entries, {});
});

test("a gap seen once now and once on a later run accumulates to two sessions and graduates", async () => {
  const h = harness();
  const first = await run(h, [record("claude-s1", [GAP])]);
  assert.equal(first.gaps.length, 0, "one session is not enough on the first run");
  assert.equal(first.totals.droppedGapSingletons, 1);

  // Later run: s1's evidence was rewritten against a changed memory file and the model
  // no longer mentions the gap; a new session s2 reports it in different words, both
  // analyzed against the new hash.
  const second = await run(
    h,
    [record("claude-s1", [], { memoryHash: "h2" }), record("claude-s2", [GAP_REPHRASED], { memoryHash: "h2" })],
    memoryFile(),
    "h2",
  );
  assert.equal(second.gaps.length, 1, "the gap graduates once two distinct sessions have reported it");
  assert.equal(second.gaps[0].sessions, 2);
  assert.equal(second.gaps[0].proposedInstruction, GAP, "the shortest phrasing is canonical");
  assert.deepEqual(second.gaps[0].quotes.map((q) => q.text).sort(), ["quote from claude-s1", "quote from claude-s2"]);
});

test("persisted selected gap sources remain fold-issued without fresh evidence", async () => {
  const h = harness();
  const old = record("claude-s1", [GAP]);
  await run(h, [old]);

  const fresh = record("claude-s2", [GAP_REPHRASED], { memoryHash: "h2" });
  h.state.writeEvidence(fresh.transcript.id, fresh);
  const summary = await foldForRun(h.ctx, memoryFile(), "h2", [], [old.transcript, fresh.transcript]);

  assert.equal(summary.analyzedSessions, 1, "the stale evidence record stays excluded");
  assert.equal(summary.gaps.length, 1, "its selected ledger observation still corroborates the gap");
  assert.equal(summary.gaps[0].sessions, 2);
  for (const quote of summary.gaps[0].quotes) {
    assert.ok(summary.sources.includes(quote.source), `fold-issued gap source missing from allowlist: ${quote.source}`);
  }
});

test("selected native provenance migrates durable observers without a fresh matching gap", async () => {
  for (const [oldObserver, currentObserver] of [
    ["child-observer", "ancestor-observer"],
    ["old-host:observer", "canonical-host:observer"],
  ]) {
    for (const reanalyzed of [false, true]) {
      const h = harness({ gapLedgerMaxAge: "all" });
      const native = (id, observer, gaps, memoryHash) => {
        const evidence = record(id, gaps, { memoryHash });
        evidence.transcript = {
          ...evidence.transcript,
          harness: "pi",
          nativeId: id,
          corroborationIdentity: observer,
        };
        evidence.key = evidenceKey(evidence.transcript, memoryHash);
        return evidence;
      };
      const old = native("G", oldObserver, [{ proposedInstruction: GAP, domain: "orchestration" }], "h1");
      await run(h, [old]);
      const entryId = gapEntryId(MEMORY_PATH, GAP);
      const before = h.state.readGapLedger().entries[entryId].sessions[oldObserver];
      const current = native("G", currentObserver, [], "h2");
      const independent = native("X", "independent-observer", [GAP_REPHRASED], "h2");
      if (reanalyzed) h.state.writeEvidence(current.transcript.id, current);
      h.state.writeEvidence(independent.transcript.id, independent);
      const summary = await foldForRun(h.ctx, memoryFile(), "h2", [], [current.transcript, independent.transcript]);
      assert.equal(summary.analyzedSessions, reanalyzed ? 2 : 1);
      assert.equal(summary.gaps.length, 1);
      assert.equal(summary.gaps[0].sessions, 2);
      assert.deepEqual(summary.gaps[0].quotes.map((quote) => quote.text).sort(), ["quote from G", "quote from X"]);
      const sessions = h.state.readGapLedger().entries[entryId].sessions;
      assert.equal(sessions[oldObserver], undefined);
      assert.equal(sessions[currentObserver].firstObservedAt, before.firstObservedAt);
      assert.equal(sessions[currentObserver].observedAt, before.observedAt);
      assert.equal(sessions[currentObserver].memoryHash, "h1");
      assert.equal(sessions[currentObserver].sourceSessionId, "G");
      assert.deepEqual(sessions[currentObserver].sightingIds, ["G"]);
      assert.equal(sessions[currentObserver].domain, "orchestration");
    }
  }
});

test("observer migration requires complete selected unambiguous native provenance", () => {
  const selected = (identity, observer) => ({
    id: `pi-${identity}`,
    identity,
    harness: "pi",
    corroborationIdentity: observer,
  });
  const cases = [
    { name: "convergent", transcripts: [selected("G", "R"), selected("H", "R")], move: true },
    { name: "unselected sighting", transcripts: [selected("G", "R")], move: false },
    { name: "unselected representative", transcripts: [selected("H", "R")], move: false },
    { name: "divergent", transcripts: [selected("G", "R"), selected("H", "S")], move: false },
    {
      name: "ambiguous native",
      transcripts: [selected("G", "R"), selected("G", "S"), selected("H", "R")],
      move: false,
    },
    {
      name: "unattributed",
      transcripts: [selected("G", "R"), selected("H", "R")],
      move: false,
      unattributedSightings: true,
    },
  ];
  for (const scenario of cases) {
    for (const oldKey of ["C", "G"]) {
      const entryId = gapEntryId(MEMORY_PATH, GAP);
      const observation = {
        firstObservedAt: "2026-08-01T00:00:00Z",
        observedAt: "2026-08-03T00:00:00Z",
        source: "pi · G · 2026-08-01",
        sourceSessionId: "G",
        sightingIds: ["H"],
        quote: "representative quote",
        quoteProvenance: sourceProof("representative quote"),
        domain: "project",
        ...(scenario.unattributedSightings ? { unattributedSightings: true } : {}),
      };
      const ledger = {
        version: 1,
        entries: {
          [entryId]: {
            id: entryId,
            memoryPath: MEMORY_PATH,
            proposedInstruction: GAP,
            sessions: { [oldKey]: structuredClone(observation) },
          },
        },
      };
      normalizeGapLedgerSessions(ledger, scenario.transcripts);
      const observations = ledgerGapObservations(ledger, MEMORY_PATH);
      assert.equal(observations.length, 1, scenario.name);
      assert.equal(observations[0].sessionId, scenario.move ? "R" : oldKey, scenario.name);
      const summary = foldEvidence([], {
        minGapEvidence: 1,
        gapObservations: observations.filter((observation) => observation.sessionId === "R"),
      });
      assert.equal(summary.gaps.length, scenario.move ? 1 : 0, scenario.name);
      if (!scenario.move) assert.deepEqual(ledger.entries[entryId].sessions[oldKey], observation);
      else {
        assert.equal(observations[0].sourceSessionId, "G");
        assert.deepEqual(observations[0].sightingIds, ["H"]);
      }
    }
  }
});

test("foldForRun leaves ambiguous and incompletely selected old observers outside corroboration", async () => {
  const native = (identity, observer) => ({
    id: identity,
    identity,
    harness: "pi",
    corroborationIdentity: observer,
    startedAt: Date.parse("2026-08-01T00:00:00Z"),
    interaction: "interactive",
  });
  const scenarios = [
    { selected: [native("G", "R")], sightingIds: ["G", "H"] },
    { selected: [native("G", "R"), native("H", "S")], sightingIds: ["G", "H"] },
    { selected: [native("G", "R"), native("G", "S")], sightingIds: ["G"] },
    { selected: [native("G", "R")], sightingIds: ["G"], unattributedSightings: true },
  ];
  for (const scenario of scenarios) {
    const h = harness({ gapLedgerMaxAge: "all" });
    const entryId = gapEntryId(MEMORY_PATH, GAP);
    const old = {
      observedAt: "2026-08-01T00:00:00Z",
      source: "pi · G · 2026-08-01",
      sourceSessionId: "G",
      sightingIds: scenario.sightingIds,
      quote: "old G quote",
      quoteProvenance: sourceProof("old G quote"),
      ...(scenario.unattributedSightings ? { unattributedSightings: true } : {}),
    };
    h.state.writeGapLedger({
      version: 1,
      entries: {
        [entryId]: { id: entryId, memoryPath: MEMORY_PATH, proposedInstruction: GAP, sessions: { C: old } },
      },
    });
    const independent = record("X", [GAP], { memoryHash: "h2" });
    h.state.writeEvidence(independent.transcript.id, independent);
    const summary = await foldForRun(h.ctx, memoryFile(), "h2", [], [...scenario.selected, independent.transcript]);
    assert.equal(summary.analyzedSessions, 1);
    assert.deepEqual(summary.gaps, []);
    assert.deepEqual(h.state.readGapLedger().entries[entryId].sessions.C, old);
    assert.equal(h.state.readGapLedger().entries[entryId].sessions.R, undefined);
  }
});

test("a selected representative cannot grant its former selected observer to one quote", async () => {
  const native = (id, observer, gaps, memoryHash) => {
    const evidence = record(id, gaps, { memoryHash });
    evidence.transcript = {
      ...evidence.transcript,
      harness: "pi",
      nativeId: id,
      corroborationIdentity: observer,
    };
    evidence.key = evidenceKey(evidence.transcript, memoryHash);
    return evidence;
  };
  for (const parentFresh of [false, true]) {
    for (const matchingGap of [false, true]) {
      const h = harness({ gapLedgerMaxAge: "all" });
      const ledger = { version: 1, entries: {} };
      recordGapObservations(ledger, [native("P", "P", [GAP], "h1"), native("G", "P", [GAP], "h1")]);
      const entryId = gapEntryId(MEMORY_PATH, GAP);
      const historical = structuredClone(ledger.entries[entryId].sessions.P);
      assert.equal(historical.sourceSessionId, "G");
      assert.deepEqual(historical.sightingIds, ["P", "G"]);
      h.state.writeGapLedger(ledger);

      const parent = native("P", "P", [], parentFresh ? "h2" : "h1");
      const representative = native("G", "L", matchingGap ? [GAP] : [], "h2");
      representative.negative = [
        {
          instruction: "AG-001",
          quote: "G skipped the database documentation",
          quoteProvenance: sourceProof("G skipped the database documentation"),
          class: "non-compliance",
        },
      ];
      const independent = native("X", "X", [GAP], "h2");
      for (const evidence of [parent, representative, independent]) {
        h.state.writeEvidence(evidence.transcript.id, evidence);
      }
      const route = { weight: null, rootPath: MEMORY_PATH, ownerOf: () => null };
      const summary = await foldForRun(
        h.ctx,
        memoryFile(),
        "h2",
        [],
        [parent.transcript, representative.transcript, independent.transcript],
        { route },
      );

      assert.equal(summary.analyzedSessions, parentFresh ? 3 : 2);
      assert.equal(summary.totals.gapSightings, matchingGap ? 2 : 1);
      assert.equal(summary.gaps.length, matchingGap ? 1 : 0);
      if (matchingGap) {
        assert.equal(summary.gaps[0].sessions, 2);
        assert.deepEqual(summary.gaps[0].quotes.map((quote) => quote.text).sort(), ["quote from G", "quote from X"]);
      }
      const quote = summary.instructions.find((row) => row.instruction === "AG-001").quotes[0];
      assert.equal(summary.sourceObservers[quote.source], "L");
      assert.ok(!summary.rootOwnedGaps.flat().some((item) => item.sessionId === "P"));
      assert.deepEqual(h.state.readGapLedger().entries[entryId].sessions.P, historical);

      const repo = makeRepo({ [MEMORY_PATH]: "# T\n\n- Run pnpm test before pushing.\n- Keep the README current.\n" });
      const staged = stageAndMeasure({
        repo,
        edit: (root) => writeIn(root, MEMORY_PATH, (text) => `${text}- ${GAP}\n`),
      });
      const built = buildProposal(
        {
          edits: [
            {
              changes: staged.measured.changes.map((change) => change.id),
              kind: "add",
              title: "Read the database documentation",
              rationale: "Avoid re-deriving query behavior",
              evidence: [{ polarity: "negative", text: quote.text, source: quote.source }],
            },
          ],
        },
        {
          repo,
          memoryFile: staged.memoryFile,
          measured: staged.measured,
          summary,
          config: { ...h.ctx.config, budgetTokens: 5000, maxEditsPerRun: 5, skillsDir: ".agents/skills" },
        },
      );
      assert.equal(built.proposal.edits.length, 0);
      assert.ok(built.violations.some((violation) => /backed by 1 session\(s\); 2 are required/.test(violation)));
    }
  }
});

test("an occupied incompatible observer preserves its native alias through normalization and recording", () => {
  const native = (id, observer, gaps = []) => {
    const evidence = record(id, gaps);
    evidence.transcript = { ...evidence.transcript, harness: "pi", nativeId: id, corroborationIdentity: observer };
    evidence.key = evidenceKey(evidence.transcript, evidence.memoryHash);
    return evidence;
  };
  const selected = [native("P", "P"), native("G", "L"), native("H", "P"), native("X", "X")];
  const ledger = { version: 1, entries: {} };
  recordGapObservations(ledger, [native("P", "P", [GAP]), native("G", "P", [GAP]), native("H", "H", [GAP])], {
    now: new Date("2026-08-02T00:00:00Z"),
  });
  const entryId = gapEntryId(MEMORY_PATH, GAP);
  const historical = structuredClone(ledger.entries[entryId].sessions.P);
  const valid = structuredClone(ledger.entries[entryId].sessions.H);
  normalizeGapLedgerSessions(
    ledger,
    selected.map((evidence) => evidence.transcript),
  );
  assert.deepEqual(ledger.entries[entryId].sessions.P, historical);
  assert.deepEqual(ledger.entries[entryId].sessions.H, valid);
  recordGapObservations(ledger, [native("H", "P", [GAP])], {
    now: new Date("2026-08-03T00:00:00Z"),
  });
  assert.deepEqual(
    ledger.entries[entryId].sessions.P,
    historical,
    "standalone recording also rejects unresolved destinations",
  );
  assert.deepEqual(ledger.entries[entryId].sessions.H.sightingIds, ["H"]);
  recordGapObservations(ledger, [native("H", "P", [GAP])], {
    transcripts: selected.map((evidence) => evidence.transcript),
    now: new Date("2026-08-03T00:00:00Z"),
  });
  assert.deepEqual(ledger.entries[entryId].sessions.P, historical);
  assert.equal(ledger.entries[entryId].sessions.H.firstObservedAt, valid.firstObservedAt);
  assert.deepEqual(ledger.entries[entryId].sessions.H.sightingIds, ["H"]);
});

test("unresolved occupied destinations do not absorb valid selected native aliases", () => {
  const native = (id, observer) => ({
    id,
    identity: id,
    harness: "pi",
    corroborationIdentity: observer,
    startedAt: Date.parse("2026-08-01T00:00:00Z"),
    interaction: "interactive",
  });
  for (const scenario of [
    { selected: [native("H", "P")] },
    { selected: [native("H", "P"), native("G", "P"), native("G", "L")] },
    { selected: [native("H", "P"), native("G", "P")], unattributedSightings: true },
  ]) {
    const entryId = gapEntryId(MEMORY_PATH, GAP);
    const unresolved = {
      observedAt: "2026-08-01T00:00:00Z",
      sourceSessionId: "G",
      sightingIds: ["G"],
      source: "pi · G · 2026-08-01",
      quote: "unresolved G quote",
      quoteProvenance: sourceProof("unresolved G quote"),
      ...(scenario.unattributedSightings ? { unattributedSightings: true } : {}),
    };
    const valid = {
      observedAt: "2026-08-02T00:00:00Z",
      sourceSessionId: "H",
      sightingIds: ["H"],
      source: "pi · H · 2026-08-01",
      quote: "valid H quote",
      quoteProvenance: sourceProof("valid H quote"),
    };
    const ledger = {
      version: 1,
      entries: {
        [entryId]: {
          id: entryId,
          memoryPath: MEMORY_PATH,
          proposedInstruction: GAP,
          sessions: { P: structuredClone(unresolved), H: structuredClone(valid) },
        },
      },
    };
    normalizeGapLedgerSessions(ledger, scenario.selected);
    assert.deepEqual(ledger.entries[entryId].sessions.P, unresolved);
    assert.deepEqual(ledger.entries[entryId].sessions.H, valid);
    const fresh = { ...record("H", [GAP]), transcript: scenario.selected[0] };
    recordGapObservations(ledger, [fresh], { transcripts: scenario.selected });
    assert.deepEqual(ledger.entries[entryId].sessions.P, unresolved);
    assert.deepEqual(ledger.entries[entryId].sessions.H.sightingIds, ["H"]);
  }
});

test("selected native history corroborates separately from an incompatible occupied observer on disk", async () => {
  for (const reanalyzed of [false, true]) {
    for (const matchingGap of [false, true]) {
      const h = harness({ gapLedgerMaxAge: "all" });
      const native = (id, observer, gaps, memoryHash) => {
        const evidence = record(id, gaps, { memoryHash });
        evidence.transcript = {
          ...evidence.transcript,
          harness: "pi",
          nativeId: id,
          corroborationIdentity: observer,
        };
        evidence.key = evidenceKey(evidence.transcript, memoryHash);
        return evidence;
      };
      const ledger = { version: 1, entries: {} };
      recordGapObservations(
        ledger,
        [native("P", "P", [GAP], "h1"), native("G", "P", [GAP], "h1"), native("H", "H", [GAP], "h1")],
        { now: new Date("2026-08-02T00:00:00Z") },
      );
      const entryId = gapEntryId(MEMORY_PATH, GAP);
      const historical = structuredClone(ledger.entries[entryId].sessions.P);
      const valid = structuredClone(ledger.entries[entryId].sessions.H);
      h.state.writeGapLedger(ledger);
      const current = [
        native("P", "P", [], reanalyzed ? "h2" : "h1"),
        native("G", "L", [], reanalyzed ? "h2" : "h1"),
        native("H", "P", matchingGap ? [GAP] : [], reanalyzed || matchingGap ? "h2" : "h1"),
        native("X", "X", [GAP], "h2"),
      ];
      for (const evidence of current) h.state.writeEvidence(evidence.transcript.id, evidence);
      const summary = await foldForRun(
        h.ctx,
        memoryFile(),
        "h2",
        [],
        current.map((evidence) => evidence.transcript),
        {
          route: { weight: null, rootPath: MEMORY_PATH, ownerOf: () => null },
        },
      );
      assert.equal(summary.analyzedSessions, reanalyzed ? 4 : matchingGap ? 2 : 1);
      assert.equal(summary.totals.gapSightings, 2);
      assert.equal(summary.gaps[0].sessions, 2);
      assert.deepEqual(summary.gaps[0].quotes.map((quote) => quote.text).sort(), ["quote from H", "quote from X"]);
      assert.equal(summary.sourceObservers["pi · H · 2026-08-01"], "P");
      assert.ok(!summary.rootOwnedGaps.flat().some((item) => /quote from [PG]$/.test(item.quote)));
      const sessions = h.state.readGapLedger().entries[entryId].sessions;
      assert.deepEqual(sessions.P, historical);
      if (!matchingGap) assert.deepEqual(sessions.H, valid);
      else {
        assert.equal(sessions.H.firstObservedAt, valid.firstObservedAt);
        assert.deepEqual(sessions.H.sightingIds, ["H"]);
      }
      const repo = makeRepo({ [MEMORY_PATH]: "# T\n\n- Run pnpm test before pushing.\n- Keep the README current.\n" });
      const staged = stageAndMeasure({
        repo,
        edit: (root) => writeIn(root, MEMORY_PATH, (text) => `${text}- ${GAP}\n`),
      });
      const build = (quotes) =>
        buildProposal(
          {
            edits: [
              {
                changes: staged.measured.changes.map((change) => change.id),
                kind: "add",
                title: "Read the database documentation",
                rationale: "Avoid re-deriving query behavior",
                evidence: quotes.map((quote) => ({ polarity: "negative", ...quote })),
              },
            ],
          },
          {
            repo,
            memoryFile: staged.memoryFile,
            measured: staged.measured,
            summary,
            config: { ...h.ctx.config, budgetTokens: 5000, maxEditsPerRun: 5, skillsDir: ".agents/skills" },
          },
        );
      assert.equal(build(summary.gaps[0].quotes).proposal.edits.length, 1);
      const hQuote = summary.gaps[0].quotes.find((quote) => quote.text === "quote from H");
      const duplicate = build([hQuote, hQuote]);
      assert.equal(duplicate.proposal.edits.length, 0);
      assert.ok(duplicate.violations.some((violation) => /backed by 1 session\(s\); 2 are required/.test(violation)));
    }
  }
});

test("fresh native evidence retains a deterministic sibling when its own observer slot is incompatible", async () => {
  const h = harness({ gapLedgerMaxAge: "all" });
  const native = (id, observer, gaps, memoryHash) => {
    const evidence = record(id, gaps, { memoryHash });
    evidence.transcript = { ...evidence.transcript, harness: "pi", nativeId: id, corroborationIdentity: observer };
    evidence.key = evidenceKey(evidence.transcript, memoryHash);
    return evidence;
  };
  const ledger = { version: 1, entries: {} };
  recordGapObservations(ledger, [native("P", "P", [GAP], "h1"), native("G", "P", [GAP], "h1")]);
  const entryId = gapEntryId(MEMORY_PATH, GAP);
  const historical = structuredClone(ledger.entries[entryId].sessions.P);
  h.state.writeGapLedger(ledger);
  const current = [native("P", "P", [GAP], "h2"), native("G", "L", [], "h2"), native("X", "X", [GAP], "h2")];
  for (const evidence of current) h.state.writeEvidence(evidence.transcript.id, evidence);
  for (let run = 0; run < 2; run += 1) {
    const summary = await foldForRun(
      h.ctx,
      memoryFile(),
      "h2",
      [],
      current.map((evidence) => evidence.transcript),
    );
    assert.equal(summary.gaps[0].sessions, 2);
    assert.equal(summary.totals.gapSightings, 2);
    assert.deepEqual(summary.gaps[0].quotes.map((quote) => quote.text).sort(), ["quote from P", "quote from X"]);
    const sessions = h.state.readGapLedger().entries[entryId].sessions;
    assert.deepEqual(sessions.P, historical);
    assert.equal(Object.keys(sessions).length, 3);
    assert.deepEqual(sessions[JSON.stringify(["P", "P"])].sightingIds, ["P"]);
  }
});

test("selected historical sightings remain admitted when their representative is not selected", async () => {
  const h = harness({ gapLedgerMaxAge: "all" });
  const entryId = gapEntryId(MEMORY_PATH, GAP);
  const historical = {
    observedAt: "2026-08-01T00:00:00Z",
    source: "pi · G · 2026-08-01",
    sourceSessionId: "G",
    sightingIds: ["P", "G"],
    quote: "historical G quote",
    quoteProvenance: sourceProof("historical G quote"),
  };
  h.state.writeGapLedger({
    version: 1,
    entries: {
      [entryId]: { id: entryId, memoryPath: MEMORY_PATH, proposedInstruction: GAP, sessions: { P: historical } },
    },
  });
  const parent = record("P", [], { memoryHash: "h2" });
  parent.transcript = { ...parent.transcript, harness: "pi", corroborationIdentity: "P" };
  parent.key = evidenceKey(parent.transcript, "h2");
  const independent = record("X", [GAP], { memoryHash: "h2" });
  for (const evidence of [parent, independent]) h.state.writeEvidence(evidence.transcript.id, evidence);
  const route = { weight: null, rootPath: MEMORY_PATH, ownerOf: () => null };
  const summary = await foldForRun(h.ctx, memoryFile(), "h2", [], [parent.transcript, independent.transcript], {
    route,
  });
  assert.equal(summary.gaps[0].sessions, 2);
  assert.equal(summary.sourceObservers[historical.source], "P");
  assert.deepEqual(h.state.readGapLedger().entries[entryId].sessions.P, historical);
});

test("fresh matching evidence cannot bypass rejected attributed alias migration", async () => {
  for (const destination of [null, "other-observer"]) {
    const h = harness({ gapLedgerMaxAge: "all" });
    const entryId = gapEntryId(MEMORY_PATH, GAP);
    const old = {
      observedAt: "2026-08-01T00:00:00Z",
      source: "old native source",
      sourceSessionId: "G",
      sightingIds: ["G", "H"],
      quote: "old mixed quote",
      quoteProvenance: sourceProof("old mixed quote"),
    };
    h.state.writeGapLedger({
      version: 1,
      entries: {
        [entryId]: { id: entryId, memoryPath: MEMORY_PATH, proposedInstruction: GAP, sessions: { G: old } },
      },
    });
    const fresh = record("G", [GAP], { memoryHash: "h2" });
    fresh.transcript = { ...fresh.transcript, harness: "pi", corroborationIdentity: "R" };
    fresh.key = evidenceKey(fresh.transcript, "h2");
    h.state.writeEvidence(fresh.transcript.id, fresh);
    const selected = [fresh.transcript];
    if (destination)
      selected.push({
        ...record("H", [], { memoryHash: "h2" }).transcript,
        harness: "pi",
        corroborationIdentity: destination,
      });
    const summary = await foldForRun(h.ctx, memoryFile(), "h2", [], selected);
    assert.equal(summary.analyzedSessions, 1);
    assert.deepEqual(summary.gaps, []);
    assert.equal(summary.totals.gapSightings, 1);
    const sessions = h.state.readGapLedger().entries[entryId].sessions;
    assert.deepEqual(sessions.G, old);
    assert.equal(sessions.R.sourceSessionId, "G");
    assert.deepEqual(sessions.R.sightingIds, ["G"]);
  }
});

test("direct recording still migrates provenance-free legacy aliases", () => {
  const entryId = gapEntryId(MEMORY_PATH, GAP);
  const ledger = {
    version: 1,
    entries: {
      [entryId]: {
        id: entryId,
        memoryPath: MEMORY_PATH,
        proposedInstruction: GAP,
        sessions: { legacy: { observedAt: "2026-08-01T00:00:00Z", quote: "legacy quote" } },
      },
    },
  };
  const fresh = record("legacy", [GAP]);
  fresh.transcript.identity = "current-native";
  recordGapObservations(ledger, [fresh], { legacyIds: new Set(["legacy"]) });
  assert.equal(ledger.entries[entryId].sessions.legacy, undefined);
  const observation = ledgerGapObservations(ledger, MEMORY_PATH)[0];
  assert.equal(observation.sessionId, "current-native");
  assert.equal(observation.sourceSessionId, "current-native");
});

test("the same session is never double-counted across runs", async () => {
  const h = harness();
  await run(h, [record("claude-s1", [GAP])]);
  const again = await run(h, [record("claude-s1", [GAP_REPHRASED])]);
  assert.equal(again.gaps.length, 0, "re-observing s1 must not graduate a one-off");
  const third = await run(h, [record("claude-s1", [GAP])]);
  assert.equal(third.gaps.length, 0);

  const ledger = h.state.readGapLedger();
  const entries = Object.values(ledger.entries);
  assert.equal(entries.length, 1, "rephrasings of one gap share one ledger entry");
  assert.deepEqual(Object.keys(entries[0].sessions), ["claude-s1"]);
});
test("OMP parent and subagent persist one ledger sighting and keep it in the child sample", async () => {
  const h = harness();
  const startedAt = Date.parse("2026-08-01T00:00:00Z");
  const parentPath = "/omp/sessions/-repo-demo/parent-session.jsonl";
  const parentIdentity = "pi-parent-session";
  const parent = {
    id: "pi-parent",
    nativeId: "parent-native",
    identity: "pi-file-parent",
    corroborationIdentity: parentIdentity,
    corroborationNativeId: "parent-native",
    corroborationStartedAt: startedAt,
    harness: "pi",
    path: parentPath,
    startedAt,
    interaction: "interactive",
  };
  const child = {
    id: "pi-child",
    nativeId: "child-native",
    identity: "pi-file-child",
    parentSessionId: "parent-native",
    corroborationIdentity: parentIdentity,
    corroborationNativeId: "parent-native",
    corroborationStartedAt: startedAt,
    harness: "pi",
    path: "/omp/sessions/-repo-demo/parent-session/Subagent.jsonl",
    startedAt: startedAt + 1_000,
    interaction: "non-interactive",
  };
  const independent = {
    id: "claude-independent",
    nativeId: "independent",
    identity: "independent-session",
    corroborationIdentity: "independent-session",
    corroborationNativeId: "independent",
    corroborationStartedAt: startedAt + 2_000,
    harness: "claude",
    path: "/claude/independent.jsonl",
    startedAt: startedAt + 2_000,
    interaction: "interactive",
  };
  const evidence = (transcript) => {
    const result = record(transcript.id, [GAP]);
    result.transcript = transcript;
    result.key = evidenceKey(transcript, result.memoryHash);
    return result;
  };
  const parentEvidence = evidence(parent);
  const childEvidence = evidence(child);

  const first = await run(h, [parentEvidence, childEvidence]);
  assert.equal(first.gaps.length, 0, "a parent plus its subagent remains one observer");
  assert.deepEqual(Object.keys(Object.values(h.state.readGapLedger().entries)[0].sessions), [parentIdentity]);

  const childOnly = await foldForRun(h.ctx, memoryFile(), "h1", [], [child]);
  assert.equal(
    childOnly.totals.gapSightings,
    2,
    "unresolved history and fresh native evidence remain separate sightings",
  );
  assert.equal(childOnly.gaps.length, 0);

  const independentEvidence = evidence(independent);
  h.state.writeEvidence(independent.id, independentEvidence);
  const withIndependent = await foldForRun(h.ctx, memoryFile(), "h1", [], [child, independent]);
  assert.equal(withIndependent.gaps.length, 1);
  assert.equal(withIndependent.gaps[0].sessions, 2);
});
test("a selected OMP child keeps unresolved legacy parent history separate with one observer vote", async () => {
  const h = harness({ gapLedgerMaxAge: "all" });
  const startedAt = Date.parse("2026-08-01T00:00:00Z");
  const parentIdentity = "pi-parent-session";
  const parent = {
    id: "pi-parent",
    nativeId: "parent-native",
    identity: parentIdentity,
    harness: "pi",
    path: "/omp/sessions/-repo-demo/parent-session.jsonl",
    startedAt,
    interaction: "interactive",
  };
  const child = {
    id: "pi-child",
    nativeId: "child-native",
    identity: "pi-file-child",
    parentSessionId: "parent-native",
    corroborationIdentity: parentIdentity,
    corroborationNativeId: "parent-native",
    corroborationStartedAt: startedAt,
    harness: "pi",
    path: "/omp/sessions/-repo-demo/parent-session/Subagent.jsonl",
    startedAt: startedAt + 1_000,
    interaction: "non-interactive",
  };
  const asEvidence = (transcript) => {
    const result = record(transcript.id, [GAP]);
    result.transcript = transcript;
    result.key = evidenceKey(transcript, result.memoryHash);
    return result;
  };
  const legacyChild = { ...child };
  delete legacyChild.parentSessionId;
  delete legacyChild.corroborationIdentity;
  delete legacyChild.corroborationNativeId;
  delete legacyChild.corroborationStartedAt;
  const ledger = { version: 1, entries: {} };
  recordGapObservations(ledger, [asEvidence(parent), asEvidence(legacyChild)], {
    now: new Date(startedAt + 2_000),
  });
  const before = structuredClone(Object.values(ledger.entries)[0].sessions);
  h.state.writeGapLedger(ledger);

  const currentChildEvidence = asEvidence(child);
  currentChildEvidence.gaps = [];
  h.state.writeEvidence(child.id, currentChildEvidence);
  const summary = await foldForRun(h.ctx, memoryFile(), "h1", [], [child]);

  assert.equal(summary.gaps.length, 0, "old parent and child keys still represent one observer");
  assert.equal(summary.totals.droppedGapSingletons, 1);
  const sessions = Object.values(h.state.readGapLedger().entries)[0].sessions;
  assert.deepEqual(sessions, before, "the unresolved occupied parent and valid child stay intact on disk");
  assert.deepEqual(Object.keys(sessions).sort(), [parentIdentity, child.identity].sort());
});

test("native sightings union across recording, migration and consolidation with one root vote", () => {
  const h = harness({ gapLedgerMaxAge: "all" });
  const gapA = "Always verify the API schema before adding a handler.";
  const gapB = "Check deployment permissions when releasing services.";
  const native = (id, root, gap, relative) => {
    const transcript = {
      id: `pi-${id}`,
      identity: id,
      nativeId: id,
      harness: "pi",
      corroborationIdentity: root,
      startedAt: Date.parse("2026-08-02T00:00:00Z"),
      interaction: "non-interactive",
      cwd: h.root,
    };
    return {
      ...record(id, [gap]),
      transcript,
      relative,
    };
  };
  const records = [
    native("child-api", "observer-a", gapA, "apps/api/a.ts"),
    native("child-web", "observer-a", gapB, "apps/web/a.ts"),
    native("independent-api", "observer-b", gapA, "apps/api/b.ts"),
  ];
  const ledger = { version: 1, entries: {} };
  recordGapObservations(ledger, records);
  const apiEntry = Object.values(ledger.entries).find((entry) => entry.proposedInstruction === gapA);
  const webEntry = Object.values(ledger.entries).find((entry) => entry.proposedInstruction === gapB);
  assert.equal(mergeGapEntries(ledger, [[apiEntry.id, webEntry.id]]), 1);
  normalizeGapLedgerSessions(
    ledger,
    records.map((record) => record.transcript),
  );
  const observations = ledgerGapObservations(ledger, MEMORY_PATH);
  const shared = observations.find((observation) => observation.sessionId === "observer-a");
  assert.equal(shared.sourceSessionId, "child-api");
  assert.deepEqual(shared.sightingIds.sort(), ["child-api", "child-web"]);
  assert.equal(shared.source, "pi · child-api · 2026-08-02");
  const attribution = new Map(
    records.map((record) => [
      record.transcript.identity,
      workedPaths(record.transcript, [{ kind: "tool", input: { path: record.relative } }], [h.root]),
    ]),
  );
  const api = { path: "apps/api/AGENTS.md", dir: "apps/api" };
  const route = routingFor([api], attribution, MEMORY_PATH, null);
  const summary = foldEvidence([], { minGapEvidence: 2, gapObservations: observations, route });
  assert.equal(summary.gaps.length, 1);
  assert.equal(summary.gaps[0].sessions, 2);
  assert.equal(summary.sourceObservers[shared.source], "observer-a");
  assert.equal(
    foldEvidence([], {
      minGapEvidence: 2,
      gapObservations: observations,
      route: { ...route, weight: api.path },
    }).gaps.length,
    0,
  );

  recordGapObservations(ledger, [records[1]]);
  const preserved = ledgerGapObservations(ledger, MEMORY_PATH);
  const prior = preserved.find((observation) => observation.sessionId === "observer-a");
  assert.deepEqual(prior, shared);
  const fresh = preserved.find((observation) => observation.sessionId === "child-web");
  assert.equal(fresh.sourceSessionId, "child-web");
  assert.deepEqual(fresh.sightingIds, ["child-web"]);
  const refolded = foldEvidence(records, { minGapEvidence: 2, gapObservations: preserved, route });
  assert.equal(refolded.gaps[0].sessions, 2);
});

test("ordinary non-OMP selected legacy observations keep their native routing identity", async () => {
  const h = harness({ gapLedgerMaxAge: "all" });
  const selected = [record("ordinary-a", [GAP]), record("ordinary-b", [GAP])].map((record) => ({
    ...record.transcript,
    cwd: h.root,
  }));
  const entryId = gapEntryId(MEMORY_PATH, GAP);
  h.state.writeGapLedger({
    version: 1,
    entries: {
      [entryId]: {
        id: entryId,
        memoryPath: MEMORY_PATH,
        proposedInstruction: GAP,
        sessions: Object.fromEntries(
          selected.map((transcript) => [
            transcript.identity,
            {
              observedAt: "2026-08-03T00:00:00Z",
              source: `claude · ${transcript.id} · 2026-08-01`,
              quote: `quote ${transcript.id}`,
              quoteProvenance: sourceProof(`quote ${transcript.id}`),
            },
          ]),
        ),
      },
    },
  });
  const api = { path: "apps/api/AGENTS.md", dir: "apps/api" };
  const attribution = new Map(
    selected.map((transcript) => [
      transcript.identity,
      workedPaths(transcript, [{ kind: "tool", input: { path: "apps/api/handler.ts" } }], [h.root]),
    ]),
  );
  const summary = await foldForRun(h.ctx, memoryFile(), "h1", [], selected, {
    route: routingFor([api], attribution, MEMORY_PATH, api.path),
  });
  assert.equal(summary.gaps[0].sessions, 2);
  for (const observation of ledgerGapObservations(h.state.readGapLedger(), MEMORY_PATH)) {
    assert.equal(observation.sourceSessionId, observation.sessionId);
    assert.deepEqual(observation.sightingIds, [observation.sessionId]);
    assert.equal(summary.sourceSessions[observation.source], observation.sessionId);
  }
});

test("an OMP parent and subagent sharing a root vote project in one run whatever the order", () => {
  const startedAt = Date.parse("2026-08-01T00:00:00Z");
  const rootIdentity = "pi-parent-session";
  const observe = (id, domain) => {
    const transcript = {
      id,
      nativeId: `${id}-native`,
      identity: `pi-file-${id}`,
      corroborationIdentity: rootIdentity,
      corroborationNativeId: "parent-native",
      corroborationStartedAt: startedAt,
      harness: "pi",
      startedAt,
      interaction: "interactive",
    };
    const result = record(id, [{ proposedInstruction: GAP, domain }]);
    result.transcript = transcript;
    result.key = evidenceKey(transcript, result.memoryHash);
    return result;
  };
  const parent = observe("pi-parent", "project");
  const child = observe("pi-child", "orchestration");
  const domainAfter = (records, ledger = { version: 1, entries: {} }, now = new Date(startedAt + DAY)) => {
    recordGapObservations(ledger, records, { now, transcripts: [parent.transcript, child.transcript] });
    const [entry] = Object.values(ledger.entries);
    assert.deepEqual(Object.keys(entry.sessions), [rootIdentity]);
    return { ledger, domain: entry.sessions[rootIdentity].domain };
  };

  assert.equal(domainAfter([parent, child]).domain, "project");
  assert.equal(domainAfter([child, parent]).domain, "project");

  const { ledger } = domainAfter([parent]);
  assert.equal(
    domainAfter([child], ledger, new Date(startedAt + 2 * DAY)).domain,
    "orchestration",
    "a later run still replaces the earlier vote",
  );
});

test("a legacy session-id observation migrates without counting the identity as a second session", async () => {
  const h = harness();
  await run(h, [record("claude-s1", [GAP])]);
  const before = h.state.readGapLedger();
  const beforeEntry = Object.values(before.entries)[0];
  const firstObservedAt = beforeEntry.sessions["claude-s1"].firstObservedAt;

  const migrated = record("claude-s1", [GAP_REPHRASED]);
  migrated.transcript.identity = "stable-identity-s1";
  migrated.key = evidenceKey(migrated.transcript, migrated.memoryHash);
  const summary = await run(h, [migrated]);

  assert.equal(summary.gaps.length, 0, "one upgraded session must remain a singleton");
  const entry = Object.values(h.state.readGapLedger().entries)[0];
  assert.deepEqual(Object.keys(entry.sessions), ["stable-identity-s1"]);
  assert.equal(entry.sessions["stable-identity-s1"].firstObservedAt, firstObservedAt);
});

test("an ambiguous legacy session id never migrates onto a selected session", async () => {
  const h = harness({ gapLedgerMaxAge: "all" });
  const evidenceFor = (transcript, gaps) => {
    const result = record(transcript.id, gaps);
    result.transcript = transcript;
    result.key = evidenceKey(transcript, result.memoryHash);
    return result;
  };
  const shared = (identity) => ({
    ...record("claude-shared", []).transcript,
    nativeId: "shared",
    identity,
    path: `/claude/${identity}.jsonl`,
  });
  const a = shared("session-a");
  const b = shared("session-b");
  const c = record("claude-c", []).transcript;
  const ledger = { version: 1, entries: {} };
  recordGapObservations(ledger, [record("claude-shared", [GAP]), record("claude-c", [GAP])]);
  h.state.writeGapLedger(ledger);
  h.state.writeEvidence(a, evidenceFor(a, []));
  h.state.writeEvidence(b, evidenceFor(b, [GAP]));

  const summary = await foldForRun(h.ctx, memoryFile(), "h1", [], [a, c]);

  assert.equal(summary.gaps.length, 0, "a sighting that may be B's must not corroborate A");
  const [entry] = Object.values(h.state.readGapLedger().entries);
  assert.deepEqual(Object.keys(entry.sessions).sort(), ["claude-c", "claude-shared"]);
});

test("a selected session recording a gap never inherits an ambiguous legacy id's sighting", async () => {
  const h = harness();
  const shared = (identity) => ({
    ...record("claude-shared", []).transcript,
    nativeId: "shared",
    identity,
    path: `/claude/${identity}.jsonl`,
  });
  const a = shared("session-a");
  const b = shared("session-b");
  const evidenceFor = (transcript, gaps) => {
    const result = record(transcript.id, gaps);
    result.transcript = transcript;
    result.key = evidenceKey(transcript, result.memoryHash);
    return result;
  };
  const ledger = { version: 1, entries: {} };
  const bFirstObservedAt = new Date(Date.now() - 80 * DAY);
  recordGapObservations(ledger, [record("claude-shared", [GAP])], { now: bFirstObservedAt });
  h.state.writeGapLedger(ledger);
  h.state.writeEvidence(a, evidenceFor(a, [GAP]));
  h.state.writeEvidence(b, evidenceFor(b, [GAP]));

  const summary = await foldForRun(h.ctx, memoryFile(), "h1", [], [a]);

  assert.equal(summary.gaps.length, 0, "B's sighting must not corroborate A");
  const [entry] = Object.values(h.state.readGapLedger().entries);
  assert.deepEqual(Object.keys(entry.sessions).sort(), ["claude-shared", "session-a"]);
  assert.equal(entry.sessions["claude-shared"].firstObservedAt, bFirstObservedAt.toISOString());
  assert.ok(
    Date.parse(entry.sessions["session-a"].firstObservedAt) > bFirstObservedAt.getTime(),
    "A's fresh sighting keeps its own first-seen time",
  );
});

test("a genuine one-off never graduates, however many runs see it", async () => {
  const h = harness();
  for (let i = 0; i < 5; i += 1) {
    const summary = await run(h, [record("claude-s1", [GAP]), record("claude-s2", ["Never force-push to main."])]);
    assert.equal(summary.gaps.length, 0);
    assert.equal(summary.totals.droppedGapSingletons, 2);
  }
});

test("two distinct sessions in a single run still clear the gate as before", async () => {
  const h = harness();
  const summary = await run(h, [record("claude-s1", [GAP]), record("codex-s2", [GAP_REPHRASED])]);
  assert.equal(summary.gaps.length, 1);
  assert.equal(summary.gaps[0].sessions, 2);
  assert.equal(summary.totals.gapClusters, 1);
  assert.equal(summary.totals.droppedGapSingletons, 0);
});

/** Backdate every sighting in the ledger, as if the runs had happened `days` ago. */
function age(h, days) {
  const ledger = h.state.readGapLedger();
  const then = new Date(Date.now() - days * DAY).toISOString();
  for (const entry of Object.values(ledger.entries)) {
    for (const obs of Object.values(entry.sessions)) obs.firstObservedAt = then;
  }
  h.state.writeGapLedger(ledger);
}

test("ledger preserves covered duplicate phrasings for each session", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-ledger-covered-"));
  const covered = "Always pin the Node version with nvm.";
  const uncovered = "Pin the Node version using nvm.";
  fs.writeFileSync(path.join(root, "AGENTS.md"), `# T\n\n- ${covered}\n`);
  const first = record("s1", [uncovered, covered]);
  first.transcript.project = root;
  first.transcript.projectRoot = root;
  const second = record("s2", [uncovered]);
  second.transcript.project = "/repos/other";
  const ledger = { version: 1, entries: {} };

  recordGapObservations(ledger, [first, second]);
  const observations = ledgerGapObservations(ledger, MEMORY_PATH);
  const summary = foldEvidence([], {
    gapObservations: observations,
    minGapEvidence: 2,
    minGapProjects: 2,
    checkProjectCoverage: true,
  });

  const persisted = observations.find((observation) => observation.sessionId === "s1");
  assert.deepEqual(persisted.phrasings, [uncovered, covered]);
  assert.equal(summary.gaps.length, 0);
  assert.equal(summary.totals.droppedGapSingletons, 1);
});

test("a later uncited observation preserves the session's failed-trigger citation", () => {
  const phrasing = "Wrap migrations in a transaction.";
  const citedThenUncited = (id) =>
    record(id, [{ proposedInstruction: phrasing, coveredBySkill: "db-schema" }, { proposedInstruction: phrasing }]);
  const ledger = { version: 1, entries: {} };

  recordGapObservations(ledger, [citedThenUncited("s1"), citedThenUncited("s2")]);
  const observations = ledgerGapObservations(ledger, MEMORY_PATH, [{ name: "db-schema" }]);
  const summary = foldEvidence([], { gapObservations: observations, minGapEvidence: 2 });

  assert.equal(observations.length, 2);
  assert.equal(summary.gaps[0].failedTriggerSkill, "db-schema");
  assert.equal(summary.gaps[0].failedTriggerSessions, 2);
});

test("ledger observations carry the entry id onto the folded cluster", () => {
  const phrasing = "Always pin the Node version with nvm.";
  const ledger = { version: 1, entries: {} };
  recordGapObservations(ledger, [
    record("s1", [{ proposedInstruction: phrasing }]),
    record("s2", [{ proposedInstruction: phrasing }]),
  ]);
  const observations = ledgerGapObservations(ledger, MEMORY_PATH);
  assert.ok(observations.every((observation) => observation.gapIds?.length));
  const summary = foldEvidence([], { gapObservations: observations, minGapEvidence: 2 });
  const entryId = Object.keys(ledger.entries)[0];
  assert.equal(summary.gaps[0].id, entryId);
  assert.deepEqual(summary.gaps[0].ids, [entryId]);
});

test("a sighting older than gapLedgerMaxAge expires instead of resurfacing indefinitely", async () => {
  const h = harness({ gapLedgerMaxAge: "90d" });
  await run(h, [record("claude-s1", [GAP])]);
  age(h, 120);
  const summary = await run(h, [record("claude-s2", [GAP])]);
  assert.equal(summary.gaps.length, 0, "an expired sighting must not corroborate a fresh one");
  assert.deepEqual(
    Object.values(h.state.readGapLedger().entries).flatMap((e) => Object.keys(e.sessions)),
    ["claude-s2"],
  );

  const forever = harness({ gapLedgerMaxAge: "all" });
  await run(forever, [record("claude-s1", [GAP])]);
  age(forever, 120);
  const kept = await run(forever, [record("claude-s2", [GAP])]);
  assert.equal(kept.gaps.length, 1, "`all` disables expiry");
});

test("re-analysis of a session does not restart its expiry clock", async () => {
  const h = harness({ gapLedgerMaxAge: "90d" });
  await run(h, [record("claude-s1", [GAP])]);
  age(h, 120);
  const summary = await run(
    h,
    [record("claude-s1", [GAP], { memoryHash: "h2" }), record("claude-s2", [GAP], { memoryHash: "h2" })],
    memoryFile(),
    "h2",
  );
  assert.equal(summary.gaps.length, 0, "the re-seen old sighting keeps its original first-seen time");
});

test("a plain Pi session re-reporting a provenance-free sighting keeps its slot and first-seen time", async () => {
  const h = harness({ gapLedgerMaxAge: "90d" });
  const entryId = gapEntryId(MEMORY_PATH, GAP);
  const firstObservedAt = new Date(Date.now() - 50 * DAY).toISOString();
  h.state.writeGapLedger({
    version: 1,
    entries: {
      [entryId]: {
        id: entryId,
        memoryPath: MEMORY_PATH,
        proposedInstruction: GAP,
        phrasings: [GAP],
        sessions: {
          "pi-s1": {
            firstObservedAt,
            observedAt: firstObservedAt,
            memoryHash: "h1",
            source: "pi · pi-s1 · 2026-08-01",
            quote: "quote from pi-s1",
            quoteProvenance: sourceProof("quote from pi-s1"),
            phrasings: [GAP_REPHRASED],
            coveredBySkill: "db-docs",
          },
        },
      },
    },
  });
  const again = record("pi-s1", [GAP], { memoryHash: "h2" });
  again.transcript = { ...again.transcript, harness: "pi", nativeId: "pi-s1" };
  again.key = evidenceKey(again.transcript, "h2");
  await run(h, [again], memoryFile(), "h2");
  const sessions = h.state.readGapLedger().entries[entryId].sessions;
  assert.deepEqual(Object.keys(sessions), ["pi-s1"], "the main-era sighting is replaced, not duplicated");
  assert.equal(sessions["pi-s1"].firstObservedAt, firstObservedAt);
  assert.equal(sessions["pi-s1"].sourceSessionId, "pi-s1");
  assert.deepEqual(sessions["pi-s1"].phrasings, [GAP_REPHRASED, GAP]);
  assert.equal(sessions["pi-s1"].coveredBySkill, "db-docs");
});

test("a gap the memory file now covers is retired from the ledger", async () => {
  const h = harness();
  await run(h, [record("claude-s1", [GAP])]);
  const addressed = memoryFile("# T\n\n- Read docs/db.md before writing queries.\n");
  const summary = await run(h, [record("claude-s2", [GAP])], addressed);
  assert.equal(summary.gaps.length, 0, "a covered gap must not graduate");
  const sessions = Object.values(h.state.readGapLedger().entries).flatMap((e) => Object.keys(e.sessions));
  assert.deepEqual(sessions, [], "the covered entry is dropped, including this run's sighting");
});

test("a missing or corrupt ledger is rebuilt from the run's evidence, never a crash", async () => {
  const h = harness();
  fs.writeFileSync(h.state.gapLedgerPath, "{not json");
  const summary = await run(h, [record("claude-s1", [GAP]), record("claude-s2", [GAP])]);
  assert.equal(summary.gaps.length, 1);
  assert.equal(h.state.readGapLedger().version, 1);

  fs.writeFileSync(h.state.gapLedgerPath, JSON.stringify({ version: 99, entries: "nope" }));
  const again = await run(h, []);
  assert.equal(again.gaps.length, 1, "the evidence on disk is enough to rebuild the count");
});

test("foldEvidence without a ledger keeps the per-run behavior", () => {
  const summary = foldEvidence([record("claude-s1", [GAP]), record("claude-s1", [GAP_REPHRASED])], {
    memoryFile: memoryFile(),
  });
  assert.equal(summary.gaps.length, 0, "one session reporting twice is still one session");
});

// ---------- judged identity: analysis citations ----------

const PARAPHRASE = "Consult the database schema documentation prior to composing any SQL.";

test("an analysis that cites an existing gap id corroborates it, however different the words", async () => {
  const h = harness();
  await run(h, [record("claude-s1", [GAP])]);
  const entryId = gapEntryId(MEMORY_PATH, GAP);
  assert.ok(h.state.readGapLedger().entries[entryId], "the first sighting created the citable entry");

  // A later session phrases the same gap so differently that no lexical match exists;
  // its analysis saw the open-gap index and cited the id instead.
  const summary = await run(h, [record("codex-s2", [{ proposedInstruction: PARAPHRASE, matchesGap: entryId }])]);
  assert.equal(summary.gaps.length, 1, "the citation is what lines the two sightings up");
  assert.equal(summary.gaps[0].sessions, 2);
  assert.equal(Object.keys(h.state.readGapLedger().entries).length, 1, "no split entry for the paraphrase");
});

test("a citation to an id the ledger does not hold falls back to lexical identity", async () => {
  const h = harness();
  const summary = await run(h, [record("claude-s1", [{ proposedInstruction: GAP, matchesGap: "00000000deadbeef" }])]);
  assert.equal(summary.gaps.length, 0);
  const entries = Object.values(h.state.readGapLedger().entries);
  assert.equal(entries.length, 1, "the sighting still lands as a fresh entry");
  assert.equal(entries[0].proposedInstruction, GAP);
});

// ---------- orchestration-domain gaps stay out of project proposals ----------

test("orchestration-domain gaps are counted but never cluster into a proposal", async () => {
  const h = harness();
  const orchestration = { proposedInstruction: "Stop after the report on scout tasks.", domain: "orchestration" };
  const summary = await run(h, [record("claude-s1", [orchestration]), record("codex-s2", [orchestration])]);

  assert.equal(summary.gaps.length, 0, "two sessions corroborate it, and it still never becomes a proposal");
  assert.equal(summary.reportOnlyGaps.length, 1);
  assert.equal(summary.totals.reportOnlyGapClusters, 1);
  assert.equal(summary.totals.orchestrationGapSightings, 2, "but the run stays legible about what it excluded");
  const prompt = renderEvidenceForPrompt(summary);
  assert.doesNotMatch(prompt, /Stop after the report on scout tasks/);
  const report = renderEvidenceReport(summary);
  assert.match(report, /1 gap clusters \(0 synthesis eligible, 1 report only/);
  assert.match(report, /2 orchestration-domain sighting\(s\).*excluded/);
  assert.match(report, /2 sightings, 2 orchestration; domain excluded by majority vote/);

  // The same shape in the project domain clusters as usual - the exclusion is the
  // domain, not the text.
  const control = harness();
  const project = { proposedInstruction: "Stop after the report on scout tasks.", domain: "project" };
  const clustered = await run(control, [record("claude-s1", [project]), record("codex-s2", [project])]);
  assert.equal(clustered.gaps.length, 1);
});

test("a mixed two-sighting cluster with one orchestration vote still graduates", async () => {
  const h = harness();
  const phrasing = "Read docs/sshhip.md before changing the tunnel.";
  const summary = await run(h, [
    record("claude-s1", [{ proposedInstruction: phrasing, domain: "project" }]),
    record("codex-s2", [{ proposedInstruction: phrasing, domain: "orchestration" }]),
  ]);

  assert.equal(summary.gaps.length, 1, "the cluster is not silently dropped below the two-session floor");
  assert.equal(summary.gaps[0].sessions, 2);
  assert.equal(summary.gaps[0].orchestrationSightings, 1);
  assert.match(renderEvidenceForPrompt(summary), /2 sightings, 1 orchestration/);
});

// ---------- consolidation-pass merges (the mechanical half) ----------

function ledgerWith(...entries) {
  const ledger = { version: 1, entries: {} };
  for (const { id, text, sessions, memoryPath = MEMORY_PATH } of entries) {
    ledger.entries[id] = {
      id,
      memoryPath,
      proposedInstruction: text,
      sessions: Object.fromEntries(
        sessions.map((s) => [
          s,
          {
            firstObservedAt: "2026-08-01T00:00:00.000Z",
            observedAt: "2026-08-01T00:00:00.000Z",
            quote: `quote from ${s}`,
            quoteProvenance: sourceProof(`quote from ${s}`),
          },
        ]),
      ),
    };
  }
  return ledger;
}

test("mergeGapEntries unions sessions without double-counting and keeps the shortest phrasing", () => {
  const ledger = ledgerWith(
    { id: "a".repeat(16), text: "A long and winding phrasing of the same gap.", sessions: ["s1", "shared"] },
    { id: "b".repeat(16), text: "The short phrasing.", sessions: ["s2", "shared"] },
  );
  const absorbed = mergeGapEntries(ledger, [["a".repeat(16), "b".repeat(16)]]);

  assert.equal(absorbed, 1);
  const entries = Object.values(ledger.entries);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].proposedInstruction, "The short phrasing.");
  assert.deepEqual(Object.keys(entries[0].sessions).sort(), ["s1", "s2", "shared"], "a session never counts twice");
});

test("merging keeps a source-backed quote and its provenance together in either direction", () => {
  for (const verifiedTarget of [false, true]) {
    const ledger = ledgerWith(
      { id: "target", text: GAP, sessions: ["shared", "extra"] },
      { id: "other", text: GAP_REPHRASED, sessions: ["shared"] },
    );
    const verified = ledger.entries[verifiedTarget ? "target" : "other"].sessions.shared;
    verified.sourceSessionId = "genuine-native";
    verified.source = "genuine session";
    const unverified = ledger.entries[verifiedTarget ? "other" : "target"].sessions.shared;
    unverified.quote = "[... 2000 chars elided ...]";
    unverified.quoteProvenance = { kind: "unverified" };
    unverified.sourceSessionId = "other-native";
    const expected = structuredClone(verified);
    mergeGapEntries(ledger, [["target", "other"]]);
    const observation = ledgerGapObservations(ledger, MEMORY_PATH).find((obs) => obs.sessionId === "shared");
    assert.equal(observation.quote, expected.quote);
    assert.equal(observation.sourceSessionId, expected.sourceSessionId);
    assert.deepEqual(observation.quoteProvenance, expected.quoteProvenance);
  }
});

test("observer normalization prefers a verified native quote over an unverified destination", () => {
  const ledger = ledgerWith({ id: "gap", text: GAP, sessions: ["native", "observer"] });
  const verified = ledger.entries.gap.sessions.native;
  verified.sourceSessionId = "native";
  const destination = ledger.entries.gap.sessions.observer;
  destination.sourceSessionId = "native";
  destination.quote = "[... 2000 chars elided ...]";
  delete destination.quoteProvenance;
  const expected = structuredClone(verified);
  normalizeGapLedgerSessions(ledger, [{ id: "pi-native", identity: "native", corroborationIdentity: "observer" }]);
  const [observation] = ledgerGapObservations(ledger, MEMORY_PATH);
  assert.equal(observation.sessionId, "observer");
  assert.equal(observation.quote, expected.quote);
  assert.deepEqual(observation.quoteProvenance, expected.quoteProvenance);
});

test("unverified legacy observations remain stored but cannot supply fold votes", () => {
  const ledger = ledgerWith({ id: "gap", text: GAP, sessions: ["genuine", "legacy"] });
  delete ledger.entries.gap.sessions.legacy.quoteProvenance;
  const summary = foldEvidence([], { gapObservations: ledgerGapObservations(ledger, MEMORY_PATH), minGapEvidence: 2 });
  assert.equal(summary.gaps.length, 0);
  assert.equal(summary.totals.droppedGapSingletons, 1);
  assert.equal(Object.keys(ledger.entries.gap.sessions).length, 2);
});

test("a merged entry keeps the absorbed entry id in its folded gap identity", () => {
  const absorbedId = "a".repeat(16);
  const targetId = "b".repeat(16);
  const ledger = ledgerWith(
    { id: absorbedId, text: "Pin the Node version with nvm before scripts.", sessions: ["s1"] },
    { id: targetId, text: "Pin Node with nvm.", sessions: ["s2", "s3"] },
  );
  mergeGapEntries(ledger, [[absorbedId, targetId]]);
  const summary = foldEvidence([], { gapObservations: ledgerGapObservations(ledger, MEMORY_PATH), minGapEvidence: 2 });
  assert.deepEqual(summary.gaps[0].ids, [absorbedId, targetId]);
});

test("mergeGapEntries reconciles conflicting domain votes without target-order bias", () => {
  const orchestrationId = "a".repeat(16);
  const projectId = "b".repeat(16);
  const phrasing = "Read docs/sshhip.md before changing the tunnel.";
  const ledger = ledgerWith(
    { id: orchestrationId, text: `${phrasing} Carefully.`, sessions: ["orch-only", "shared"] },
    { id: projectId, text: phrasing, sessions: ["project-only", "shared"] },
  );
  ledger.entries[orchestrationId].sessions["orch-only"].domain = "orchestration";
  ledger.entries[orchestrationId].sessions.shared.domain = "orchestration";
  ledger.entries[projectId].sessions["project-only"].domain = "project";
  ledger.entries[projectId].sessions.shared.domain = "project";

  mergeGapEntries(ledger, [[orchestrationId, projectId]]);
  const summary = foldEvidence([], {
    gapObservations: ledgerGapObservations(ledger, MEMORY_PATH),
    minGapEvidence: 2,
  });

  assert.equal(summary.gaps.length, 1, "the chosen merge target cannot turn a conflicting vote into orchestration");
  assert.equal(summary.gaps[0].sessions, 3);
  assert.equal(summary.gaps[0].orchestrationSightings, 1);
});

test("mergeGapEntries preserves absorbed citations for duplicate sessions", () => {
  const targetId = "a".repeat(16);
  const absorbedId = "b".repeat(16);
  const ledger = ledgerWith(
    { id: targetId, text: "Check the database contract before changing queries.", sessions: ["s1", "s2"] },
    { id: absorbedId, text: "Read schema docs before SQL edits.", sessions: ["s1", "s2"] },
  );
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-merged-project-"));
  fs.writeFileSync(path.join(projectRoot, "AGENTS.md"), "# T\n\n- Read schema docs before SQL edits.\n");
  ledger.entries[absorbedId].sessions.s1.coveredBySkill = "db-schema";
  ledger.entries[absorbedId].sessions.s1.project = projectRoot;
  ledger.entries[absorbedId].sessions.s1.projectRoot = projectRoot;
  ledger.entries[absorbedId].sessions.s2.coveredBySkill = "db-schema";

  mergeGapEntries(ledger, [[targetId, absorbedId]]);
  const observations = ledgerGapObservations(ledger, MEMORY_PATH, [{ name: "db-schema" }]);
  const summary = foldEvidence([], {
    gapObservations: observations,
    minGapEvidence: 1,
    checkProjectCoverage: true,
  });

  assert.equal(observations.length, 2, "each session remains one observation");
  assert.equal(observations.find((observation) => observation.sessionId === "s1").projectRoot, projectRoot);
  assert.equal(summary.gaps[0].sessions, 1);
  assert.equal(summary.gaps[0].projectCoveredSessions, 1);
  assert.equal(summary.gaps[0].failedTriggerSkill, "db-schema");
  assert.equal(summary.gaps[0].failedTriggerSessions, 1);
});

test("merged gap identities remain durable as the canonical phrasing changes", () => {
  const first = "Always inspect the database schema documentation before composing a production SQL query.";
  const absorbed = "Consult schema before SQL.";
  const shortest = "Check DB docs.";
  const firstId = gapEntryId(MEMORY_PATH, first);
  const absorbedId = gapEntryId(MEMORY_PATH, absorbed);
  const ledger = ledgerWith(
    { id: firstId, text: first, sessions: ["s1", "s2"] },
    { id: absorbedId, text: absorbed, sessions: ["s3"] },
  );

  mergeGapEntries(ledger, [[firstId, absorbedId]]);
  recordGapObservations(ledger, [
    record("s4", [{ proposedInstruction: shortest, matchesGap: firstId }]),
    record("s5", [first]),
    record("s6", [absorbed]),
  ]);

  assert.deepEqual(Object.keys(ledger.entries), [firstId]);
  assert.equal(ledger.entries[firstId].proposedInstruction, shortest);
  assert.deepEqual(Object.keys(ledger.entries[firstId].sessions).sort(), ["s1", "s2", "s3", "s4", "s5", "s6"]);
  assert.equal(ledger.entries[firstId].sessions.s1.firstObservedAt, "2026-08-01T00:00:00.000Z");
});

test("coverage by any judged phrasing retires a merged gap", () => {
  const first = "Always inspect schema documentation before SQL.";
  const shortest = "Check DB docs.";
  const firstId = gapEntryId(MEMORY_PATH, first);
  const shortestId = gapEntryId(MEMORY_PATH, shortest);
  const ledger = ledgerWith(
    { id: firstId, text: first, sessions: ["s1", "s2"] },
    { id: shortestId, text: shortest, sessions: ["s3"] },
  );

  mergeGapEntries(ledger, [[firstId, shortestId]]);
  const covered = memoryFile(`# T\n\n- ${first}\n`);
  const stats = pruneGapLedger(ledger, { memoryFile: covered, memoryPath: MEMORY_PATH, maxAge: "all" });

  assert.equal(stats.covered, 3);
  assert.deepEqual(ledger.entries, {});
});

test("mergeGapEntries drops what it cannot verify instead of guessing", () => {
  const ledger = ledgerWith(
    { id: "a".repeat(16), text: "One gap.", sessions: ["s1"] },
    { id: "b".repeat(16), text: "Another gap.", sessions: ["s2"] },
    { id: "c".repeat(16), text: "A gap for another file.", sessions: ["s3"], memoryPath: "CLAUDE.md" },
  );

  assert.equal(mergeGapEntries(ledger, [["a".repeat(16), "0".repeat(16)]]), 0, "an unknown id shrinks the group");
  assert.equal(mergeGapEntries(ledger, [["a".repeat(16), "c".repeat(16)]]), 0, "cross-path groups are refused");
  assert.equal(mergeGapEntries(ledger, "not an array"), 0);
  assert.equal(Object.keys(ledger.entries).length, 3, "nothing merged, nothing lost");

  // An id already claimed by one group cannot be claimed again by a later one.
  const twice = mergeGapEntries(ledger, [
    ["a".repeat(16), "b".repeat(16)],
    ["b".repeat(16), "c".repeat(16)],
  ]);
  assert.equal(twice, 1, "only the first group merged");
  assert.ok(!ledger.entries["b".repeat(16)], "b was absorbed into a");
  assert.ok(ledger.entries["c".repeat(16)], "c stayed untouched");
});

test("failed-trigger evidence survives skill body edits", () => {
  const phrasing = "Run pnpm lint before committing changes.";
  const citedSkill = {
    name: "lint-ritual",
    path: ".agents/skills/lint-ritual/SKILL.md",
    description: "Load before committing.",
    body: `- ${phrasing}\n`,
  };
  const ledger = { version: 1, entries: {} };
  recordGapObservations(ledger, [record("s1", [{ proposedInstruction: phrasing, coveredBySkill: "lint-ritual" }])], {
    skills: [citedSkill],
  });

  const entry = Object.values(ledger.entries)[0];
  assert.equal(Object.values(entry.sessions)[0].coveredBySkill, "lint-ritual");
  assert.equal(ledgerGapObservations(ledger, MEMORY_PATH, [citedSkill])[0].coveredBySkill, "lint-ritual");

  const unchanged = pruneGapLedger(ledger, {
    memoryFile: memoryFile(),
    memoryPath: MEMORY_PATH,
    maxAge: "all",
    skills: [citedSkill],
  });
  assert.equal(unchanged.covered, 0, "the cited pre-existing body is evidence of a failed trigger");
  assert.equal(Object.keys(ledger.entries).length, 1);

  const unrelatedEdit = { ...citedSkill, body: `# Notes\n\nUnrelated details changed.\n\n- ${phrasing}\n` };
  recordGapObservations(ledger, [record("s1", [{ proposedInstruction: phrasing, coveredBySkill: "lint-ritual" }])], {
    skills: [unrelatedEdit],
  });
  const afterUnrelatedEdit = pruneGapLedger(ledger, {
    memoryFile: memoryFile(),
    memoryPath: MEMORY_PATH,
    maxAge: "all",
    skills: [unrelatedEdit],
  });
  assert.equal(afterUnrelatedEdit.covered, 0, "an unrelated body edit preserves the failed-trigger evidence");

  const rewrittenBody = {
    ...unrelatedEdit,
    body: "# Notes\n\nUnrelated details changed.\n\n- Run pnpm lint before committing changes every time.\n",
  };
  const afterBodyRewrite = pruneGapLedger(ledger, {
    memoryFile: memoryFile(),
    memoryPath: MEMORY_PATH,
    maxAge: "all",
    skills: [rewrittenBody],
  });
  assert.equal(afterBodyRewrite.covered, 0, "body edits never invalidate judged failed-trigger evidence");
  assert.equal(Object.keys(ledger.entries).length, 1);

  const descriptionFixed = { ...rewrittenBody, description: phrasing };
  const afterDescriptionFix = pruneGapLedger(ledger, {
    memoryFile: memoryFile(),
    memoryPath: MEMORY_PATH,
    maxAge: "all",
    skills: [descriptionFixed],
  });
  assert.equal(afterDescriptionFix.covered, 1, "a covering description retires the resolved failed trigger");
  assert.deepEqual(ledger.entries, {});
});

test("a missing skill suppresses its citation while body edits preserve judged citations", () => {
  const phrasing = "Run pnpm lint before committing changes.";
  const citedSkill = {
    name: "lint-ritual",
    path: ".agents/skills/lint-ritual/SKILL.md",
    description: "Load before committing.",
    body: `- ${phrasing}\n`,
  };
  const ledger = { version: 1, entries: {} };
  recordGapObservations(
    ledger,
    [
      record("s1", [{ proposedInstruction: phrasing, coveredBySkill: "lint-ritual" }]),
      record("s2", [{ proposedInstruction: phrasing, coveredBySkill: "lint-ritual" }]),
    ],
    { skills: [citedSkill] },
  );

  const missing = ledgerGapObservations(ledger, MEMORY_PATH, []);
  assert.equal(missing.length, 2);
  assert.ok(missing.every((observation) => observation.coveredBySkill === undefined));

  const bodyEdited = ledgerGapObservations(ledger, MEMORY_PATH, [
    { ...citedSkill, body: "- Run the formatter before committing.\n" },
  ]);
  assert.equal(bodyEdited.length, 2);
  assert.ok(bodyEdited.every((observation) => observation.coveredBySkill === "lint-ritual"));
  assert.equal(Object.values(ledger.entries)[0].sessions.s1.coveredBySkill, "lint-ritual");
  assert.equal(Object.values(ledger.entries)[0].sessions.s2.coveredBySkill, "lint-ritual");
});

test("a skill's description line alone can cover a gap", () => {
  const phrasing = "Always inspect schema documentation before SQL.";
  const ledger = { version: 1, entries: {} };
  recordGapObservations(ledger, [record("s1", [phrasing])]);

  const stats = pruneGapLedger(ledger, {
    memoryFile: memoryFile(),
    memoryPath: MEMORY_PATH,
    maxAge: "all",
    skills: [{ description: "Always inspect schema documentation before writing SQL.", body: "" }],
  });
  assert.equal(stats.covered, 1);
  assert.deepEqual(ledger.entries, {});
});
