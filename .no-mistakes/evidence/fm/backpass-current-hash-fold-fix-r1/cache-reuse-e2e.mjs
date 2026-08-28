import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const cli = path.join(root, "bin", "backpass.js");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-evidence-"));
const repo = path.join(sandbox, "repo");
const home = path.join(sandbox, "home");
const bin = path.join(sandbox, "bin");
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(bin, { recursive: true });

function executable(name, body) {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}`);
  fs.chmodSync(file, 0o755);
}
executable("pi", "process.exit(0);\n");
executable("acpx", `
const argv = process.argv.slice(2);
if (argv.includes("config") && argv.includes("show")) {
  console.log(JSON.stringify({ agents: {} }));
} else if (argv.includes("--file")) {
  console.log(JSON.stringify({
    positive: [{ instruction: "AG-001", moment: "start", effect: "followed it", quote: "followed the build rule exactly as written" }],
    negative: [],
    gaps: [],
  }));
}
`);

for (const args of [
  ["init", "--quiet", "-b", "main"],
  ["config", "user.email", "test@example.com"],
  ["config", "user.name", "test"],
]) spawnSync("git", args, { cwd: repo, stdio: "inherit" });
const original = "# Agent instructions\n\n- Run `make build` before every push.\n";
const edited = `${original}- Never skip the changelog.\n`;
fs.writeFileSync(path.join(repo, "AGENTS.md"), original);
spawnSync("git", ["add", "AGENTS.md"], { cwd: repo });
spawnSync("git", ["commit", "-q", "-m", "memory"], { cwd: repo });

const sessionDir = path.join(home, ".pi", "agent", "sessions", "session-a");
fs.mkdirSync(sessionDir, { recursive: true });
const entries = [
  { type: "session", version: 3, id: "session-a", timestamp: new Date().toISOString(), cwd: repo },
  { type: "message", message: { role: "user", content: "Please build the project." } },
  { type: "message", message: { role: "assistant", content: "Ran make build as instructed." } },
  { type: "message", message: { role: "user", content: "Now run the tests too." } },
  { type: "message", message: { role: "assistant", content: "Tests pass." } },
];
fs.writeFileSync(path.join(sessionDir, "session.jsonl"), entries.map(JSON.stringify).join("\n") + "\n");

function analyze(extra = []) {
  const result = spawnSync(process.execPath, [cli, "analyze", "--harness", "pi", "--since", "all", "--analysis-agent", "pi", "--jobs", "1", "--json", ...extra], {
    cwd: repo,
    env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, BACKPASS_ACPX_BIN: path.join(bin, "acpx"), NO_COLOR: "1" },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  const summary = JSON.parse(result.stdout).summary;
  return { summary, stderr: result.stderr.trim() };
}
function show(label, result) {
  console.log(`\n## ${label}`);
  if (result.stderr) console.log(result.stderr);
  console.log(JSON.stringify({ total: result.summary.total, analyzed: result.summary.analyzed, reused: result.summary.cached, staleMemoryHash: result.summary.staleMemoryHash }));
}

show("First analysis", analyze());
show("Unchanged second analysis", analyze());
fs.writeFileSync(path.join(repo, "AGENTS.md"), edited);
show("After editing AGENTS.md without --force", analyze());
show("Explicit --force", analyze(["--force"]));
