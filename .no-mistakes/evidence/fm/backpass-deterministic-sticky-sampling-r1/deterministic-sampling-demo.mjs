import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = "/Users/kunchen/.no-mistakes/worktrees/26c81f74111f/01M14TSNK9HYJ333Q6TPM95PZ1";
const cli = path.join(root, "bin/backpass.js");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-evidence-"));
const repo = path.join(scratch, "repo");
const home = path.join(scratch, "home");
const bin = path.join(scratch, "bin");
const calls = path.join(scratch, "analysis-calls.txt");
fs.mkdirSync(repo);
fs.mkdirSync(home);
fs.mkdirSync(bin);
fs.writeFileSync(calls, "0");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} failed:\n${result.stdout}${result.stderr}`);
  return result;
}
run("git", ["init", "--quiet", "-b", "main"], { cwd: repo });
run("git", ["config", "user.email", "test@example.com"], { cwd: repo });
run("git", ["config", "user.name", "Evidence Demo"], { cwd: repo });
fs.writeFileSync(path.join(repo, "AGENTS.md"), "# Agent instructions\n\n- Run tests before every push.\n");
run("git", ["add", "AGENTS.md"], { cwd: repo });
run("git", ["commit", "--quiet", "-m", "instructions"], { cwd: repo });

const fakePi = path.join(bin, "pi");
fs.writeFileSync(fakePi, `#!${process.execPath}\nprocess.exit(0);\n`);
fs.chmodSync(fakePi, 0o755);
const fakeAcpx = path.join(bin, "acpx");
fs.writeFileSync(fakeAcpx, `#!${process.execPath}
import fs from "node:fs";
const argv = process.argv.slice(2);
if (argv.includes("config") && argv.includes("show")) {
  process.stdout.write(JSON.stringify({ agents: {} }) + "\\n");
  process.exit(0);
}
if (argv.includes("--file")) {
  const file = process.env.EVIDENCE_CALL_FILE;
  fs.writeFileSync(file, String(Number(fs.readFileSync(file, "utf8")) + 1));
  process.stdout.write(JSON.stringify({ positive: [], negative: [], gaps: [] }) + "\\n");
}
`);
fs.chmodSync(fakeAcpx, 0o755);

for (let i = 0; i < 147; i += 1) {
  const id = `session-${i}`;
  const sessionDir = path.join(home, ".pi", "agent", "sessions", id);
  fs.mkdirSync(sessionDir, { recursive: true });
  const entries = [
    { type: "session", version: 3, id, timestamp: new Date(Date.now() - i * 86_400_000).toISOString(), cwd: repo },
    { type: "message", message: { role: "user", content: `Please update the project (${id}).` } },
    { type: "message", message: { role: "assistant", content: "Updated it." } },
    { type: "message", message: { role: "user", content: "Now run tests." } },
    { type: "message", message: { role: "assistant", content: "Tests pass." } },
  ];
  fs.writeFileSync(path.join(sessionDir, `${id}.jsonl`), entries.map(JSON.stringify).join("\n") + "\n");
}

function analyze() {
  const result = run(process.execPath, [cli, "analyze", "--harness", "pi", "--since", "all", "--analysis-agent", "pi", "--jobs", "4", "--json"], {
    cwd: repo,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      BACKPASS_ACPX_BIN: fakeAcpx,
      EVIDENCE_CALL_FILE: calls,
      NO_COLOR: "1",
    },
    timeout: 90_000,
  });
  return JSON.parse(result.stdout).summary;
}

const first = analyze();
const callsAfterFirst = Number(fs.readFileSync(calls, "utf8"));
const second = analyze();
const callsAfterSecond = Number(fs.readFileSync(calls, "utf8"));
console.log("Backpass public CLI reproduction: 147 discovered sessions, default cap 100");
console.log(JSON.stringify({ run: 1, total: first.total, analyzed: first.analyzed, cached: first.cached, cumulativeAnalysisModelCalls: callsAfterFirst }));
console.log(JSON.stringify({ run: 2, total: second.total, analyzed: second.analyzed, cached: second.cached, cumulativeAnalysisModelCalls: callsAfterSecond }));
console.log(`New analysis model calls on unchanged rerun: ${callsAfterSecond - callsAfterFirst}`);
