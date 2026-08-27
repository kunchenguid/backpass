import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { annotatePrompts, makeCliRepo, readJson, runCli, snapshotTree } from "./helpers/synthesis-cli.js";

/**
 * The synthesis orchestration, through `backpass propose` as a user runs it.
 *
 * These cover the run that produced the 0.1.7 "synthesis returned no parseable JSON
 * object": a shrink that extracted two neighbouring sections (whose removals the
 * measurement merges into ONE change), a turn that re-edited the staging copy so the ids
 * moved, and a final turn where the harness returned success with no text at all. Each of
 * those three is a separate condition with a separate right answer, and the assertions
 * here are what a user can see: the exit code, what was printed, what is in
 * `.backpass/proposal.json`, and what is left in `.backpass/synthesis/`.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_LAVISH = path.join(ROOT, "test", "fixtures", "fake-lavish", "lavish-axi");
const PIN = ["--synthesis-agent", "claude", "--synthesis-model", "fake-model"];

const MEMORY = [
  "# Demo agent memory",
  "",
  "## Build",
  "",
  "- Run `make build` before every push.",
  "",
  "## Release checklist",
  "",
  "- Tag the release commit with the version.",
  "- Push the tag before the artifacts.",
  "- Never hand-edit CHANGELOG.md.",
  "",
  "## Incident response",
  "",
  "- Page the on-call before rolling back.",
  "- Write the postmortem within two days.",
  "- Link the postmortem from the incident channel.",
  "",
  "## Style",
  "",
  "- Never use the em dash.",
  "",
].join("\n");

/** The two sections the editing turn lifts out, as one contiguous span of the file. */
const BOTH_SECTIONS = [
  "## Release checklist",
  "",
  "- Tag the release commit with the version.",
  "- Push the tag before the artifacts.",
  "- Never hand-edit CHANGELOG.md.",
  "",
  "## Incident response",
  "",
  "- Page the on-call before rolling back.",
  "- Write the postmortem within two days.",
  "- Link the postmortem from the incident channel.",
  "",
].join("\n");

/** What the editing turn leaves: one pointer block, so the removals measure as ONE change. */
const POINTERS = [
  "## Playbooks",
  "- Release steps: .agents/skills/release-checklist/SKILL.md",
  "- Incidents: .agents/skills/incident-response/SKILL.md",
  "",
].join("\n");

/** What an agent rewrites the copy into when it wants the two extractions measured apart. */
const SPLIT = [
  "## Release checklist",
  "",
  "- Release steps: .agents/skills/release-checklist/SKILL.md",
  "",
  "## Incident response",
  "",
  "- Incidents: .agents/skills/incident-response/SKILL.md",
  "",
].join("\n");

const skill = (name) => `---\nname: ${name}\ndescription: Load before ${name} work.\n---\n\n## Steps\n\n1. do it\n`;

const EDIT_TURN = {
  "AGENTS.md": { replace: [[BOTH_SECTIONS, POINTERS]] },
  ".agents/skills/release-checklist/SKILL.md": skill("release-checklist"),
  ".agents/skills/incident-response/SKILL.md": skill("incident-response"),
};

const QUOTE = {
  polarity: "negative",
  text: "session 1 re-derived the release steps by hand",
  source: "claude · s1 · turn 4",
};

const extract = (changes, title, extra = {}) => ({
  changes,
  kind: "extract",
  title,
  rationale: "the evidence shows these steps are looked up, not remembered",
  evidence: [QUOTE],
  transcripts: 3,
  ...extra,
});

/** The coalesced layout: one merged memory change (H1) plus the two created skills. */
const COALESCED_ANSWER = { edits: [extract(["H1", "H2", "H3"], "extract two playbooks")] };
/** The layout after the copy is split: each skill with its own measured change. */
const SPLIT_ANSWER = {
  edits: [extract(["H1", "H4"], "extract the release checklist"), extract(["H2", "H3"], "extract incident response")],
};
/** A turn that edits the copy so the ids the agent was given no longer describe it. */
const SPLIT_THE_COPY = { editFirst: { "AGENTS.md": { replace: [[POINTERS, SPLIT]] } }, reply: { edits: [] } };

const proposalOf = (dir) => readJson(path.join(dir, ".backpass", "proposal.json"));
const stagedTree = (dir) => snapshotTree(path.join(dir, ".backpass", "synthesis"));

test("a remeasurement is not a failed annotation: it costs no attempt, and the new ids get a real one", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: EDIT_TURN,
      annotations: [
        // 1: judged and rejected - the one edit carries no evidence quote.
        { reply: { edits: [extract(["H1", "H2", "H3"], "extract two playbooks", { evidence: [] })] } },
        // 2: the agent splits the copy instead of answering. The ids move.
        SPLIT_THE_COPY,
        // 3: judged and rejected again - H4 is left out of every edit.
        { reply: { edits: [extract(["H1", "H4"], "extract the release checklist")] } },
        // 4: the third and last annotation attempt, and it passes.
        { reply: SPLIT_ANSWER },
      ],
    },
  });

  assert.equal(run.status, 0, `the run should succeed:\n${run.output}`);
  assert.equal(run.annotateTurns(), 4, "four turns, because one of them only moved the files");
  const proposal = proposalOf(dir);
  assert.equal(proposal.attempt, 3, "three annotation attempts were judged, not four");
  assert.deepEqual(proposal.violations ?? [], []);
  assert.equal(proposal.edits.length, 2);

  // turn 1 plain · turn 2 corrects turn 1 · turn 3 re-annotates the moved ids · turn 4 corrects turn 3
  const prompts = annotatePrompts(dir);
  assert.equal(prompts.length, 4);
  assert.ok(prompts[1].includes("Your previous answer was rejected"));
  assert.ok(prompts[1].includes("carries no verbatim evidence quote"));
  assert.ok(prompts[2].includes("The files moved after they were measured"));
  assert.ok(
    !prompts[2].includes("Your previous answer was rejected"),
    "the turn after a remeasurement asks for an annotation, not a correction",
  );
  assert.ok(prompts[2].includes("did not use up an annotation attempt"));
  assert.ok(prompts[2].includes("[H4: new file"), "and it asks about the re-measured ids");
  assert.ok(prompts[3].includes("Your previous answer was rejected"));
  assert.ok(prompts[3].includes("is not part of any edit"));
});

test("the remeasurement limit stops on the declared third file-moving turn", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: EDIT_TURN,
      annotations: [
        SPLIT_THE_COPY,
        { editFirst: { "AGENTS.md": { replace: [[SPLIT, POINTERS]] } }, reply: { edits: [] } },
        SPLIT_THE_COPY,
        { reply: SPLIT_ANSWER },
      ],
    },
  });

  assert.equal(run.status, 1, `the run should stop at the limit:\n${run.output}`);
  assert.equal(run.annotateTurns(), 3);
  assert.match(run.stderr, /kept editing the staging copy instead of annotating it \(3 re-measurements\)/);
});

test("an empty turn is retried once in a fresh session, with the evidence it would otherwise have lost", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const run = runCli(dir, ["propose", ...PIN], {
    script: { edit: EDIT_TURN, annotations: [{ empty: true }, { reply: COALESCED_ANSWER }] },
  });

  assert.equal(run.status, 0, `the run should succeed:\n${run.output}`);
  assert.match(run.stderr, /ended its turn with no output; retrying the annotation once in a fresh session/);
  assert.equal(run.editTurns(), 1, "the expensive editing turn is not repeated");
  assert.equal(run.sessionsOpened(), 2, "the retry runs in a new session, not the one that went quiet");

  const sessions = run.calls().filter((c) => c.session);
  assert.equal(new Set(sessions.map((c) => c.session)).size, 2);
  assert.notEqual(
    run.calls().find((c) => c.turn === "annotate" && c.prompt.includes("joining a synthesis run")).session,
    run.calls().find((c) => c.turn === "edit").session,
  );

  // The fresh session never saw the editing turn, so the annotate prompt has to carry the
  // repository, the file, and the evidence every edit must quote.
  const [, retry] = annotatePrompts(dir);
  assert.ok(retry.includes("You are joining a synthesis run already in progress"));
  assert.ok(retry.includes("The edits below are already made."));
  assert.ok(retry.includes("session 1 re-derived the release steps by hand"), "the evidence travels with it");
  assert.ok(retry.includes("## Measured changes"));

  const proposal = proposalOf(dir);
  assert.deepEqual(proposal.violations ?? [], []);
  assert.equal(proposal.attempt, 1, "the empty turn was never an annotation attempt");
  assert.equal(proposal.edits.length, 1);
});

test("a run that ends on an empty turn says so, and never reads an older proposal as that turn's answer", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: EDIT_TURN,
      annotations: [
        { reply: { edits: [extract(["H1", "H2", "H3"], "extract two playbooks", { evidence: [] })] } },
        SPLIT_THE_COPY,
        { empty: true },
        { empty: true },
      ],
    },
  });

  assert.equal(run.status, 1, `the run should fail:\n${run.output}`);
  assert.equal(run.sessionsOpened(), 2, "the empty turn was retried in a fresh session before giving up");

  // The failure is named after the turn that ended the run.
  assert.match(run.stderr, /ended its turn with no output at all/);
  assert.match(run.stderr, /no output, in the run's session and again in a fresh one/);
  assert.doesNotMatch(run.stderr, /no parseable JSON/);

  // The proposal on disk is from an earlier attempt, and is reported as such rather than
  // as what the empty turn produced.
  assert.match(run.stderr, /it is from annotation attempt 1, not the turn above/);
  assert.match(run.stderr, /carries no verbatim evidence quote/);

  // The advice is about the condition the run actually ended on.
  assert.match(run.stderr, /run `backpass propose` again to start a fresh synthesis session/);
  assert.doesNotMatch(run.stderr, /stronger synthesis model/);
  assert.doesNotMatch(run.stderr, /--budget/);
  assert.doesNotMatch(run.stderr, /--max-edits/);

  const proposal = proposalOf(dir);
  assert.equal(proposal.attempt, 1);
  assert.equal(proposal.edits.length, 0);
  assert.ok(proposal.violations.some((v) => /carries no verbatim evidence quote/.test(v)));
  assert.ok(
    !proposal.violations.some((v) => /no output|parseable JSON/.test(v)),
    "the empty turn wrote nothing into the rejected proposal",
  );
  const staged = stagedTree(dir);
  assert.ok(staged["AGENTS.md"].includes("## Incident response"));
  assert.ok(staged[".agents/skills/release-checklist/SKILL.md"]);
  assert.ok(staged[".agents/skills/incident-response/SKILL.md"]);
});

test("a failed synthesis invalidates an older applicable proposal", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const succeeded = runCli(dir, ["propose", ...PIN], {
    script: { edit: EDIT_TURN, annotations: [{ reply: COALESCED_ANSWER }] },
  });
  assert.equal(succeeded.status, 0, `the first proposal should succeed:\n${succeeded.output}`);
  assert.equal(fs.existsSync(path.join(dir, ".backpass", "proposal.json")), true);

  const failed = runCli(dir, ["propose", ...PIN], {
    script: { edit: EDIT_TURN, annotations: [{ reply: "not json" }] },
  });
  assert.equal(failed.status, 1, `the second synthesis should fail:\n${failed.output}`);
  assert.equal(fs.existsSync(path.join(dir, ".backpass", "proposal.json")), false);

  const applied = runCli(dir, ["apply", "--no-open"]);
  assert.equal(applied.status, 1);
  assert.match(applied.stderr, /no proposal to apply/);
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), MEMORY);
});

test("skills whose removals merged into one change ship as one decision, and apply writes them together", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const run = runCli(dir, ["propose", ...PIN], {
    script: { edit: EDIT_TURN, annotations: [{ reply: COALESCED_ANSWER }] },
  });

  assert.equal(run.status, 0, `two skills against one merged change is a legal extract:\n${run.output}`);
  const proposal = proposalOf(dir);
  assert.equal(proposal.edits.length, 1, "one merged change cannot be accepted in halves, so it is one decision");
  assert.equal(proposal.edits[0].hunks.length, 1);
  assert.deepEqual(proposal.edits[0].skills.map((s) => s.name).sort(), ["incident-response", "release-checklist"]);
  assert.equal(proposal.stats.skillExtractions, 2, "two skills, on one card");

  const applied = runCli(dir, ["apply", "--no-open"], { env: applyEnv("e1=accepted") });
  assert.equal(applied.status, 0, `apply should write both skills:\n${applied.output}`);

  const memory = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.ok(memory.includes("- Release steps: .agents/skills/release-checklist/SKILL.md"));
  assert.ok(memory.includes("- Incidents: .agents/skills/incident-response/SKILL.md"));
  assert.ok(!memory.includes("- Page the on-call before rolling back."));
  for (const name of ["release-checklist", "incident-response"]) {
    const written = fs.readFileSync(path.join(dir, ".agents", "skills", name, "SKILL.md"), "utf8");
    assert.ok(written.includes(`name: ${name}`), `${name} was written, so the pointer is not dangling`);
  }
});

test("skills measured as separate changes stay separate decisions: bundling them is refused with the fix", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: { ...EDIT_TURN, "AGENTS.md": { replace: [[BOTH_SECTIONS, SPLIT]] } },
      // One extract for two skills whose removals were measured apart: taking that as one
      // decision would deny the reviewer a choice the file can actually honour.
      annotations: [
        { reply: { edits: [extract(["H1", "H2", "H3", "H4"], "extract both playbooks")] } },
        { reply: SPLIT_ANSWER },
      ],
    },
  });

  assert.equal(run.status, 0, `the corrected answer should pass:\n${run.output}`);
  const second = annotatePrompts(dir)[1];
  assert.ok(second.includes("groups 2 created skills against 2 separate changes"));
  assert.ok(second.includes("give each skill its own extract"));

  const proposal = proposalOf(dir);
  assert.equal(proposal.edits.length, 2);
  assert.deepEqual(
    proposal.edits.map((e) => e.skills.length),
    [1, 1],
  );

  // Both cards are decidable on their own: one accepted, one rejected, and the file takes
  // exactly the accepted half.
  const applied = runCli(dir, ["apply", "--no-open"], { env: applyEnv("e1=accepted e2=rejected") });
  assert.equal(applied.status, 0, `apply should honour the split decision:\n${applied.output}`);
  const memory = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.ok(memory.includes("- Release steps: .agents/skills/release-checklist/SKILL.md"));
  assert.ok(memory.includes("- Page the on-call before rolling back."), "the rejected extraction stayed in the file");
  assert.equal(fs.existsSync(path.join(dir, ".agents", "skills", "release-checklist", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(dir, ".agents", "skills", "incident-response", "SKILL.md")), false);
});

/** The fake review surface, answering with one decision vector. */
function applyEnv(decisions) {
  const scenario = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-lavish-")), "scenario.json");
  fs.writeFileSync(
    scenario,
    JSON.stringify({
      polls: [
        `prompts[1]{uid,prompt,selector,tag,text}:\n  "1","BACKPASS_DECISIONS ${decisions}",button#btn-apply,choice,${decisions}`,
      ],
    }),
  );
  return { BACKPASS_LAVISH_BIN: FAKE_LAVISH, FAKE_LAVISH_SCENARIO: scenario };
}
