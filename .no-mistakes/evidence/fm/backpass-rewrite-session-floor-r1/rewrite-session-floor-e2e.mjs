import fs from "node:fs";
import path from "node:path";
import { makeCliRepo, readJson, runCli } from "/Users/kunchen/.no-mistakes/worktrees/26c81f74111f/01M18JBD4GZJR09CHGNV0FFNEX/test/helpers/synthesis-cli.js";

const original = "- Use Node 18 via nvm before running any script.";
const memory = `# Demo agent memory\n\n## Rules\n\n${original}\n`;
const quote = [{ polarity: "negative", text: "the one session requested this change", source: "claude · s1 · turn 4" }];
const annotation = (title) => ({ edits: [{ changes: ["H1"], kind: "rewrite", title, rationale: "exercise the proposal gate", evidence: quote, transcripts: 1 }] });
const pin = ["propose", "--synthesis-agent", "claude", "--synthesis-model", "fake-model"];

function scenario(replacement, title) {
  const dir = makeCliRepo({ memory, sessions: 1 });
  const answer = annotation(title);
  const run = runCli(dir, pin, {
    script: {
      edit: { "AGENTS.md": { replace: [[original, replacement]] } },
      annotations: [{ reply: answer }],
    },
  });
  const proposalPath = path.join(dir, ".backpass", "proposal.json");
  const proposal = fs.existsSync(proposalPath) ? readJson(proposalPath) : null;
  return {
    exitCode: run.status,
    userVisibleStderr: run.stderr
      .trim()
      .split("\n")
      .filter((line) => /proposal|session|failed|ready/i.test(line))
      .map((line) => line.replace(/\/private\/.*?\/backpass-cli-[^/]+/, "<temporary-repo>")),
    acceptedEdits: proposal?.edits?.length ?? 0,
    acceptedReplacement: proposal?.edits?.[0]?.hunks?.[0]?.replace ?? null,
    violations: proposal?.violations ?? [],
  };
}

const expanded = `${original} Always route SSH through the jumphost, never store private keys in the repo, and document the hop in the PR.`;
const tighter = "- Use nvm for Node 18.";
console.log(JSON.stringify({
  command: "backpass propose --synthesis-agent claude --synthesis-model fake-model",
  singleSessionNetAdd: scenario(expanded, "expand the node rule"),
  singleSessionTightening: scenario(tighter, "tighten the node rule"),
}, null, 2));
