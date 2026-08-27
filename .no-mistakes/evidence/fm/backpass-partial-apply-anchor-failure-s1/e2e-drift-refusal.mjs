import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { memoryTextHash } from "/Users/kunchen/.no-mistakes/worktrees/26c81f74111f/01M104S3MN2T22SKSF90TS75EB/src/memory.js";

const root = "/Users/kunchen/.no-mistakes/worktrees/26c81f74111f/01M104S3MN2T22SKSF90TS75EB";
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-evidence-"));
const scenarioDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-evidence-scenario-"));
const git = (args, options = {}) => execFileSync("git", args, { cwd: repo, encoding: "utf8", ...options });

try {
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Evidence Test"]);

  const original = "# Agent memory\n\n## CI\n\n- Preserve the exact release checklist.\n\n## Style\n\n- Prefer small commits.\n";
  fs.writeFileSync(path.join(repo, "AGENTS.md"), original);
  git(["add", "AGENTS.md"]);
  git(["commit", "-q", "-m", "proposal baseline"]);

  fs.mkdirSync(path.join(repo, ".backpass"), { recursive: true });
  const proposal = {
    memoryFile: { path: "AGENTS.md", hash: memoryTextHash(original) },
    edits: [{
      id: "e1",
      kind: "extract",
      title: "Extract CI checklist",
      rationale: "Load detailed CI guidance only when needed",
      file: "AGENTS.md",
      hunks: [{ id: "H1", find: "- Preserve the exact release checklist.", replace: "- Load the ci-checklist skill." }],
      skill: {
        name: "ci-checklist",
        description: "Use when changing CI or release checks.",
        body: "Preserve the exact release checklist.",
        path: ".agents/skills/ci-checklist/SKILL.md"
      },
      evidence: [],
      transcripts: 2
    }]
  };
  fs.writeFileSync(path.join(repo, ".backpass", "proposal.json"), JSON.stringify(proposal, null, 2));

  const drifted = original.replace("## Style\n", "## Style\n\n- Upstream added this instruction after propose.\n");
  fs.writeFileSync(path.join(repo, "AGENTS.md"), drifted);
  git(["commit", "-qam", "upstream memory change"]);
  const beforeHash = memoryTextHash(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8"));

  const scenario = path.join(scenarioDir, "scenario.json");
  fs.writeFileSync(scenario, JSON.stringify({ polls: [
    'prompts[1]{uid,prompt,selector,tag,text}:\n  "1","BACKPASS_DECISIONS e1=accepted",button#btn-apply,choice,e1=accepted'
  ] }));

  const result = spawnSync(process.execPath, [path.join(root, "bin", "backpass"), "apply", "--no-open"], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      BACKPASS_LAVISH_BIN: path.join(root, "test", "fixtures", "fake-lavish", "lavish-axi"),
      FAKE_LAVISH_SCENARIO: scenario
    }
  });
  const afterText = fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8");

  console.log("COMMAND: backpass apply --no-open");
  console.log(`EXIT: ${result.status}`);
  console.log("--- CLI OUTPUT ---");
  process.stdout.write(result.stdout);
  process.stdout.write(result.stderr);
  console.log("--- OBSERVED DISK STATE ---");
  console.log(`AGENTS.md byte-identical to drifted input: ${afterText === drifted}`);
  console.log(`AGENTS.md hash before apply: ${beforeHash}`);
  console.log(`AGENTS.md hash after apply:  ${memoryTextHash(afterText)}`);
  console.log(`.agents exists: ${fs.existsSync(path.join(repo, ".agents"))}`);
  console.log(`.claude exists: ${fs.existsSync(path.join(repo, ".claude"))}`);
  console.log(`git status --porcelain: ${JSON.stringify(git(["status", "--porcelain"]).trim())}`);
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(scenarioDir, { recursive: true, force: true });
}
