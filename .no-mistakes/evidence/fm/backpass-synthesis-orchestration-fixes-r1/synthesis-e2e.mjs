import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeCliRepo, readJson, runCli } from "/Users/kunchen/.no-mistakes/worktrees/26c81f74111f/01M10RFE9FCP48AYMBF9PXKE84/test/helpers/synthesis-cli.js";

const root = "/Users/kunchen/.no-mistakes/worktrees/26c81f74111f/01M10RFE9FCP48AYMBF9PXKE84";
const memory = `# Demo agent memory

## Build

- Run make build before every push.

## Release checklist

- Tag the release commit with the version.
- Push the tag before the artifacts.
- Never hand-edit CHANGELOG.md.

## Incident response

- Page the on-call before rolling back.
- Write the postmortem within two days.
- Link the postmortem from the incident channel.

## Style

- Never use the em dash.
`;
const removed = `## Release checklist

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
const skill = (name) => `---\nname: ${name}\ndescription: Load before ${name} work.\n---\n\n## Steps\n\n1. do it\n`;
const dir = makeCliRepo({ memory });
const quote = { polarity: "negative", text: "session 1 re-derived the release steps by hand", source: "claude · s1 · turn 4" };
const answer = { edits: [{ changes: ["H1", "H2", "H3"], kind: "extract", title: "extract two playbooks", rationale: "the evidence shows these steps are looked up, not remembered", evidence: [quote], transcripts: 3 }] };
const proposed = runCli(dir, ["propose", "--synthesis-agent", "claude", "--synthesis-model", "fake-model"], {
  script: {
    edit: {
      "AGENTS.md": { replace: [[removed, pointers]] },
      ".agents/skills/release-checklist/SKILL.md": skill("release-checklist"),
      ".agents/skills/incident-response/SKILL.md": skill("incident-response"),
    },
    annotations: [{ empty: true }, { reply: answer }],
  },
});
if (proposed.status !== 0) throw new Error(proposed.output);
const proposal = readJson(path.join(dir, ".backpass", "proposal.json"));

const fakeLavish = path.join(root, "test", "fixtures", "fake-lavish", "lavish-axi");
const scenario = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-evidence-")), "scenario.json");
fs.writeFileSync(scenario, JSON.stringify({ polls: ['prompts[1]{uid,prompt,selector,tag,text}:\n  "1","BACKPASS_DECISIONS e1=accepted",button#btn-apply,choice,e1=accepted'] }));
const applied = runCli(dir, ["apply", "--no-open"], { env: { BACKPASS_LAVISH_BIN: fakeLavish, FAKE_LAVISH_SCENARIO: scenario } });
if (applied.status !== 0) throw new Error(applied.output);

console.log("=== backpass propose user-visible output ===");
console.log((proposed.stdout + proposed.stderr).trim());
console.log("\n=== observed orchestration ===");
console.log(JSON.stringify({ exit: proposed.status, editTurns: proposed.editTurns(), annotationTurns: proposed.annotateTurns(), sessionsOpened: proposed.sessionsOpened(), proposalAttempt: proposal.attempt, reviewCards: proposal.edits.length, skillsOnCard: proposal.edits[0].skills.map((s) => s.name) }, null, 2));
console.log("\n=== backpass apply user-visible output ===");
console.log((applied.stdout + applied.stderr).trim());
console.log("\n=== persisted result ===");
console.log(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8").trim());
for (const name of ["release-checklist", "incident-response"]) {
  const target = path.join(dir, ".agents", "skills", name, "SKILL.md");
  console.log(`${path.relative(dir, target)}: ${fs.existsSync(target) ? "written" : "MISSING"}`);
}
