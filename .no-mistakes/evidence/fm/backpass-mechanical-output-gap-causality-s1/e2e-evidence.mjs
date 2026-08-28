import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeCliRepo, runCli } from "/Users/kunchen/.no-mistakes/worktrees/26c81f74111f/01M153W98A39AB69NA8BQFBAFQ/test/helpers/synthesis-cli.js";

const memory = "# Demo memory\n\n## Release checklist\n\n- Tag the release commit.\n\n## Style\n\n- Keep output concise.\n";
const removed = "## Release checklist\n\n- Tag the release commit.\n\n";
const pointer = "## Release checklist\n\n- See .agents/skills/release/SKILL.md.\n\n";
const skill = "---\nname: release\ndescription: Load before release work.\n---\n\n## Release checklist\n\n- Tag the release commit.\n";
const dir = makeCliRepo({ memory });
const proposed = runCli(dir, ["propose", "--synthesis-agent", "claude", "--synthesis-model", "fake-model"], {
  script: {
    edit: {
      "AGENTS.md": { replace: [[removed, pointer]] },
      ".agents/skills/release/SKILL.md": skill,
    },
    annotations: [{ reply: { edits: [{ changes: ["H1", "H2"], kind: "extract", title: "Extract release checklist", rationale: "Keep procedural detail on demand", evidence: [{ polarity: "negative", text: "session 1 re-derived the release steps by hand", source: "claude · s1 · turn 4" }], transcripts: 3 }] } }],
  },
});
console.log("$ backpass propose --synthesis-agent claude --synthesis-model fake-model");
console.log(`exit: ${proposed.status}`);
console.log(proposed.output.trim());
const proposal = JSON.parse(fs.readFileSync(path.join(dir, ".backpass/proposal.json"), "utf8"));
console.log("\nproposal decisions:");
console.log(JSON.stringify(proposal.edits.map(e => ({ id: e.id, kind: e.kind, title: e.title, skills: e.skills.map(s => s.path) })), null, 2));
const prompt = fs.readFileSync(path.join(dir, ".backpass/prompts/synthesis-edit.md"), "utf8");
console.log("\nevidence delivered to synthesis agent:");
console.log(prompt.split("\n").filter(line => line.includes("harm-sessions=") || line.includes("[harm]")).join("\n"));

const scenario = path.join(dir, ".backpass/lavish-scenario.json");
fs.writeFileSync(scenario, JSON.stringify({ polls: ["prompts[1]{uid,prompt,selector,tag,text}:\n  \"1\",\"BACKPASS_DECISIONS e1=accepted\",button#btn-apply,choice,e1=accepted"] }));
const applied = runCli(dir, ["apply", "--no-open"], { env: {
  BACKPASS_LAVISH_BIN: "/Users/kunchen/.no-mistakes/worktrees/26c81f74111f/01M153W98A39AB69NA8BQFBAFQ/test/fixtures/fake-lavish/lavish-axi",
  FAKE_LAVISH_SCENARIO: scenario,
} });
console.log("\n$ backpass apply --no-open  # reviewer accepts e1");
console.log(`exit: ${applied.status}`);
console.log(applied.output.trim());
console.log("\nfinal AGENTS.md:");
console.log(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8").trim());
console.log("\ncreated skill:");
console.log(fs.readFileSync(path.join(dir, ".agents/skills/release/SKILL.md"), "utf8").trim());
