import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const project = "/Users/kunchen/.no-mistakes/worktrees/26c81f74111f/01M10M04FP9JSMV2P3T7JGQKES";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-manual-e2e-"));
const home = path.join(root, "home");
const bin = path.join(root, "bin");
const repo = path.join(root, "repo");
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(repo, { recursive: true });
const settings = path.join(home, ".pi", "agent", "settings.json");
fs.mkdirSync(path.dirname(settings), { recursive: true });
const original = Buffer.from('{\n  "defaultProvider": "xai",\n  "defaultModel": "grok-4.6",\n  "defaultThinkingLevel": "high"\n}\n');
fs.writeFileSync(settings, original);
const acpxLog = path.join(root, "acpx.jsonl");
const piLog = path.join(root, "pi.jsonl");
const pi = path.join(bin, "pi");
const acpx = path.join(bin, "acpx");
fs.writeFileSync(pi, `#!${process.execPath}\nconst fs=require("node:fs"); const a=process.argv.slice(2); fs.appendFileSync(process.env.PI_LOG,JSON.stringify(a)+"\\n"); if(!a.includes("--model")){const s=JSON.parse(fs.readFileSync(process.env.SETTINGS)); console.log(JSON.stringify({provider:s.defaultProvider,model:s.defaultModel,thinking:s.defaultThinkingLevel}))}`);
fs.chmodSync(pi, 0o755);
fs.writeFileSync(acpx, `#!${process.execPath}\nconst fs=require("node:fs"),{spawnSync}=require("node:child_process"); const a=process.argv.slice(2); fs.appendFileSync(process.env.ACPX_LOG,JSON.stringify({argv:a,piCommand:process.env.PI_ACP_PI_COMMAND||null})+"\\n"); if(a.includes("config")&&a.includes("show")){console.log(JSON.stringify({agents:{}}));process.exit(0)} const i=a.indexOf("set"); if(i>=0&&(a[i+1]==="model"||a[i+1]==="thought_level")){fs.writeFileSync(process.env.SETTINGS,"MUTATED");process.exit(0)} if(a.includes("sessions")&&a.includes("new")&&process.env.PI_ACP_PI_COMMAND)spawnSync(process.env.PI_ACP_PI_COMMAND,["--mode","rpc","--no-themes"],{env:process.env}); if(a.includes("--file"))console.log(JSON.stringify({evidence:[],gaps:[],edits:[],notes:[]}));`);
fs.chmodSync(acpx, 0o755);
spawnSync("git", ["init", "--quiet"], { cwd: repo });
fs.writeFileSync(path.join(repo, "AGENTS.md"), "# Agent instructions\n\n- Keep changes focused.\n");
const sessionDir = path.join(home, ".pi", "agent", "sessions", "manual-e2e");
fs.mkdirSync(sessionDir, { recursive: true });
const rows = [
  { type: "session", version: 3, id: "manual-e2e", timestamp: new Date().toISOString(), cwd: repo },
  { type: "message", message: { role: "user", content: "Inspect this implementation." } },
  { type: "message", message: { role: "assistant", content: "I inspected it." } },
  { type: "message", message: { role: "user", content: "Explain the behavior." } },
  { type: "message", message: { role: "assistant", content: "The behavior is invocation scoped." } },
];
fs.writeFileSync(path.join(sessionDir, "session.jsonl"), rows.map(JSON.stringify).join("\n") + "\n");
const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, BACKPASS_ACPX_BIN: acpx, ACPX_LOG: acpxLog, PI_LOG: piLog, SETTINGS: settings };
const before = crypto.createHash("sha256").update(fs.readFileSync(settings)).digest("hex");
const result = spawnSync(process.execPath, [path.join(project, "bin/backpass.js"), "analyze", "--harness", "pi", "--since", "all", "--analysis-agent", "pi", "--analysis-model", "openai-codex/gpt-5.6-sol", "--analysis-effort", "high", "--jobs", "1", "--json"], { cwd: repo, env, encoding: "utf8", timeout: 15000 });
const after = crypto.createHash("sha256").update(fs.readFileSync(settings)).digest("hex");
const calls = fs.readFileSync(acpxLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const launched = fs.readFileSync(piLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const bare = spawnSync(pi, ["--mode", "rpc", "--no-themes"], { env, encoding: "utf8" });
const persistenceSets = calls.filter(c => { const i=c.argv.indexOf("set"); return i>=0 && ["model","thought_level"].includes(c.argv[i+1]); });
console.log(JSON.stringify({
  backpassExit: result.status,
  backpassOutput: result.stdout.trim(),
  launchedPiArgv: launched[0],
  acpxPersistenceSetCalls: persistenceSets,
  settingsSha256Before: before,
  settingsSha256After: after,
  settingsByteStable: before === after && fs.readFileSync(settings).equals(original),
  laterBarePiDefault: JSON.parse(bare.stdout),
}, null, 2));
fs.rmSync(root, { recursive: true, force: true });
if (result.status !== 0 || before !== after || persistenceSets.length || bare.status !== 0) process.exit(1);
