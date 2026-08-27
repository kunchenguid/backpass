import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  makeCliRepo,
  readJson,
  runCli,
  snapshotTree,
} from "/Users/kunchen/.no-mistakes/worktrees/26c81f74111f/01M10RFE9FCP48AYMBF9PXKE84/test/helpers/synthesis-cli.js";

const pin = ["--synthesis-agent", "claude", "--synthesis-model", "fake-model"];
const memory = `# Demo agent memory

## Build

- Run \`make build\` before every push.

## Release checklist

- Tag the release commit with the version.
- Push the tag before the artifacts.
- Never hand-edit CHANGELOG.md.

## Incident response

- Page the on-call before rolling back.
- Write the postmortem within two days.
- Link the postmortem from the incident channel.

## Style

- Never use long dash punctuation.
`;
const sections = `## Release checklist

- Tag the release commit with the version.
- Push the tag before the artifacts.
- Never hand-edit CHANGELOG.md.

## Incident response

- Page the on-call before rolling back.
- Write the postmortem within two days.
- Link the postmortem from the incident channel.

`;
const pointers = `## Playbooks
- Release steps: .agents/skills/release-checklist/SKILL.md
- Incidents: .agents/skills/incident-response/SKILL.md

`;
const split = `## Release checklist

- Release steps: .agents/skills/release-checklist/SKILL.md

## Incident response

- Incidents: .agents/skills/incident-response/SKILL.md

`;
const skill = (name) => `---\nname: ${name}\ndescription: Load before ${name} work.\n---\n\n## Steps\n\n1. do it\n`;
const edit = {
  "AGENTS.md": { replace: [[sections, pointers]] },
  ".agents/skills/release-checklist/SKILL.md": skill("release-checklist"),
  ".agents/skills/incident-response/SKILL.md": skill("incident-response"),
};
const quote = {
  polarity: "negative",
  text: "session 1 re-derived the release steps by hand",
  source: "claude · s1 · turn 4",
};
const extract = (changes, title, evidence = [quote]) => ({
  changes,
  kind: "extract",
  title,
  rationale: "the evidence shows these steps are looked up, not remembered",
  evidence,
  transcripts: 3,
});
const splitAnswer = {
  edits: [
    extract(["H1", "H4"], "extract the release checklist"),
    extract(["H2", "H3"], "extract incident response"),
  ],
};
const dir = makeCliRepo({ memory });
const tree = () => snapshotTree(path.join(dir, ".backpass", "synthesis"));
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

const failed = runCli(dir, ["propose", ...pin], {
  script: {
    edit,
    annotations: [
      { reply: { edits: [extract(["H1", "H2", "H3"], "extract two playbooks", [])] } },
      { editFirst: { "AGENTS.md": { replace: [[pointers, split]] } }, reply: { edits: [] } },
      { empty: true },
      { empty: true },
    ],
  },
});
const before = tree();
console.log("=== FAILED PROPOSE: user-visible CLI ===");
console.log(`exit: ${failed.status}`);
console.log(failed.output.trim());
console.log(`sessions opened: ${failed.sessionsOpened()}`);
console.log(`edit turns: ${failed.editTurns()}`);
console.log(`annotation turns: ${failed.annotateTurns()}`);
console.log(`staged tree sha256: ${hash(before)}`);
console.log(`saved rejected proposal: ${JSON.stringify(readJson(path.join(dir, ".backpass", "proposal.json")), null, 2)}`);

fs.writeFileSync(
  path.join(dir, ".backpass", "evidence-summary.json"),
  JSON.stringify({ analyzedSessions: 99, instructions: [], totals: { gapClusters: 0 } }),
);
const resumed = runCli(dir, ["propose", "--resume", ...pin], {
  script: { edit: {}, annotations: [{ reply: splitAnswer }] },
});
const after = tree();
const proposal = readJson(path.join(dir, ".backpass", "proposal.json"));
console.log("\n=== RESUMED PROPOSE: user-visible CLI ===");
console.log(`exit: ${resumed.status}`);
console.log(resumed.output.trim());
console.log(`sessions opened: ${resumed.sessionsOpened()}`);
console.log(`edit turns: ${resumed.editTurns()}`);
console.log(`annotation turns: ${resumed.annotateTurns()}`);
console.log(`staged tree sha256: ${hash(after)}`);
console.log(`staged tree preserved byte-for-byte: ${JSON.stringify(after) === JSON.stringify(before)}`);
console.log(`proposal attempt: ${proposal.attempt}`);
console.log(`proposal edit count: ${proposal.edits.length}`);
console.log(`evidence sessions used: ${proposal.stats.transcripts}`);
console.log(`notes: ${proposal.notes.join(" | ")}`);

const coalescedDir = makeCliRepo({ memory });
const coalesced = runCli(coalescedDir, ["propose", ...pin], {
  script: {
    edit,
    annotations: [
      { reply: { edits: [extract(["H1", "H2", "H3"], "extract two playbooks")] } },
    ],
  },
});
const reviewScenario = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-evidence-review-")), "scenario.json");
fs.writeFileSync(
  reviewScenario,
  JSON.stringify({
    polls: [
      'prompts[1]{uid,prompt,selector,tag,text}:\n  "1","BACKPASS_DECISIONS e1=accepted",button#btn-apply,choice,e1=accepted',
    ],
  }),
);
const applied = runCli(coalescedDir, ["apply", "--no-open"], {
  env: {
    BACKPASS_LAVISH_BIN: "/Users/kunchen/.no-mistakes/worktrees/26c81f74111f/01M10RFE9FCP48AYMBF9PXKE84/test/fixtures/fake-lavish/lavish-axi",
    FAKE_LAVISH_SCENARIO: reviewScenario,
  },
});
const appliedProposal = readJson(path.join(coalescedDir, ".backpass", "proposal.json"));
console.log("\n=== COALESCED MULTI-SKILL EXTRACT AND APPLY ===");
console.log(`propose exit: ${coalesced.status}`);
console.log(coalesced.output.trim());
console.log(`review cards: ${appliedProposal.edits.length}`);
console.log(`skills on accepted card: ${appliedProposal.edits[0].skills.map((item) => item.name).join(", ")}`);
console.log(`apply exit: ${applied.status}`);
console.log(applied.output.trim());
console.log("final AGENTS.md:");
console.log(fs.readFileSync(path.join(coalescedDir, "AGENTS.md"), "utf8").trim());
for (const name of ["release-checklist", "incident-response"]) {
  const target = path.join(coalescedDir, ".agents", "skills", name, "SKILL.md");
  console.log(`${name} skill written: ${fs.existsSync(target)}`);
}
