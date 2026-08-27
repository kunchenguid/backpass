import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The synthesis pass driven through the real CLI, against a stand-in acpx.
 *
 * `test/synthesize.test.js` calls `synthesizeProposal` directly; this helper stays one
 * level out, where a user is: a git repo with a memory file and analysis evidence already
 * on disk, `backpass propose` as its own process, and a fake `acpx` that behaves the way a
 * harness with native file tools does - it edits `<cwd>/AGENTS.md`, answers annotate turns
 * with scripted JSON, and can end a turn saying nothing at all, which is what the failure
 * this scaffolding was written for actually did.
 *
 * Every acpx invocation is logged, so a test can assert what the CLI spent: how many
 * sessions were opened, which prompts each turn carried, and whether an edit turn ran.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI = path.join(ROOT, "bin", "backpass.js");

const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-fake-cli-"));

/**
 * The stand-in harness. Driven by a JSON script:
 *
 *   {
 *     edit: { "<file>": "<text>" | { replace: [[from, to]] } | null },
 *     annotations: [ { editFirst?: <edits>, reply?: <json|string>, empty?: true } ]
 *   }
 *
 * The last annotation step repeats once the script runs out, so "and then it kept
 * answering the same way" needs no padding.
 */
const FAKE_ACPX = path.join(fakeDir, "acpx");
fs.writeFileSync(
  FAKE_ACPX,
  `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const at = (flag) => (argv.indexOf(flag) >= 0 ? argv[argv.indexOf(flag) + 1] : null);
const cwd = at("--cwd") || process.cwd();
const promptFile = at("--file");
const entry = { argv, cwd, session: at("-s"), promptFile, prompt: null };
const script = JSON.parse(fs.readFileSync(process.env.FAKE_ACPX_SCRIPT, "utf8"));
const statePath = process.env.FAKE_ACPX_STATE;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { annotate: 0, edit: 0 };

function applyEdits(edits) {
  for (const [file, change] of Object.entries(edits || {})) {
    const target = path.isAbsolute(file) ? file : path.join(cwd, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (change === null) { fs.rmSync(target, { recursive: true, force: true }); continue; }
    if (typeof change === "string") { fs.writeFileSync(target, change); continue; }
    let text = fs.readFileSync(target, "utf8");
    for (const [from, to] of change.replace) {
      if (!text.includes(from)) throw new Error("fake harness: cannot find " + JSON.stringify(from));
      text = text.replace(from, to);
    }
    fs.writeFileSync(target, text);
  }
}

function log() {
  fs.appendFileSync(process.env.FAKE_ACPX_LOG, JSON.stringify(entry) + "\\n");
}

if (argv.includes("config") && argv.includes("show")) {
  process.stdout.write(JSON.stringify({ agents: {} }) + "\\n");
  log();
  process.exit(0);
}
if (argv.includes("sessions") || argv.includes("set")) {
  if (argv.includes("new")) process.stdout.write("fake-session-id\\n");
  log();
  process.exit(0);
}
if (!promptFile) { log(); process.exit(2); }

const prompt = fs.readFileSync(promptFile, "utf8");
entry.prompt = prompt;
entry.turn = prompt.includes("## Measured changes") ? "annotate" : "edit";
log();

if (entry.turn === "edit") {
  state.edit += 1;
  if (!argv.includes("--approve-all")) {
    process.stdout.write("I could not edit the file: write permission was denied.\\n");
    process.exit(0);
  }
  applyEdits(script.edit);
  process.stdout.write("Edited the staging copy.\\n");
  process.stderr.write("[acpx] tokens: input=1000 output=20 total=1020\\n");
} else {
  const step = script.annotations[Math.min(state.annotate, script.annotations.length - 1)];
  state.annotate += 1;
  if (step.editFirst) applyEdits(step.editFirst);
  if (!step.empty) {
    process.stdout.write(typeof step.reply === "string" ? step.reply : JSON.stringify(step.reply) + "\\n");
  }
  process.stderr.write("[acpx] tokens: input=500 output=30 total=530\\n");
}
fs.writeFileSync(statePath, JSON.stringify(state));
`,
);
fs.chmodSync(FAKE_ACPX, 0o755);

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/**
 * A repo `backpass propose` will run in: a git checkout with the memory file committed,
 * and tier-1 evidence already recorded, so the run starts at the fold.
 */
export function makeCliRepo({ memory, sessions = 3, files = {} }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-cli-")));
  fs.writeFileSync(path.join(dir, "AGENTS.md"), memory);
  for (const [name, text] of Object.entries(files)) {
    const absolute = path.join(dir, name);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, text);
  }
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "memory"], dir);

  const evidenceDir = path.join(dir, ".backpass", "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  for (let i = 1; i <= sessions; i += 1) {
    fs.writeFileSync(
      path.join(evidenceDir, `claude_s${i}.json`),
      JSON.stringify({
        status: "ok",
        memoryPath: "AGENTS.md",
        transcript: { harness: "claude", id: `claude:s${i}`, path: `/dev/null/s${i}`, mtimeMs: 1, bytes: 10 },
        positive: [],
        negative: [
          {
            instruction: "AG-001",
            quote: `session ${i} re-derived the release steps by hand`,
            effect: "wasted a turn",
            moment: "turn 4",
          },
        ],
        gaps: [],
      }),
    );
  }
  return dir;
}

/** An isolated HOME, so discovery finds no real transcript store on this machine. */
const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-cli-home-"));

/**
 * Run the CLI for real. `script` is the fake harness's scenario for this invocation;
 * omitting it reuses whatever the previous call in this repo left on disk.
 *
 * @returns {{ status: number|null, stdout: string, stderr: string, output: string,
 *   calls: () => any[], sessionsOpened: () => number, editTurns: () => number,
 *   annotateTurns: () => number }}
 */
export function runCli(dir, args, { script = null, env = {} } = {}) {
  const scriptPath = path.join(dir, ".backpass", "fake-script.json");
  const statePath = path.join(dir, ".backpass", "fake-state.json");
  const logPath = path.join(dir, ".backpass", `fake-log-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  if (script) {
    fs.writeFileSync(scriptPath, JSON.stringify(script));
    fs.rmSync(statePath, { force: true });
  }
  fs.writeFileSync(logPath, "");

  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: emptyHome,
      USERPROFILE: emptyHome,
      NO_COLOR: "1",
      CI: "1",
      BACKPASS_ACPX_BIN: FAKE_ACPX,
      FAKE_ACPX_SCRIPT: scriptPath,
      FAKE_ACPX_STATE: statePath,
      FAKE_ACPX_LOG: logPath,
      ...env,
    },
  });

  const calls = () =>
    fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  return {
    ...result,
    output: `${result.stdout}${result.stderr}`,
    calls,
    sessionsOpened: () => calls().filter((c) => c.argv.includes("sessions") && c.argv.includes("new")).length,
    editTurns: () => calls().filter((c) => c.turn === "edit").length,
    annotateTurns: () => calls().filter((c) => c.turn === "annotate").length,
  };
}

/** The prompts a run wrote, in turn order. */
export function annotatePrompts(dir) {
  const promptDir = path.join(dir, ".backpass", "prompts");
  if (!fs.existsSync(promptDir)) return [];
  return fs
    .readdirSync(promptDir)
    .filter((f) => /^synthesis-annotate-\d+\.md$/.test(f))
    .sort((a, b) => Number(/\d+/.exec(a)[0]) - Number(/\d+/.exec(b)[0]))
    .map((f) => fs.readFileSync(path.join(promptDir, f), "utf8"));
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Every file under a directory as `relative path -> contents`, for preservation checks. */
export function snapshotTree(root) {
  const out = {};
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else if (entry.isFile()) out[relative] = fs.readFileSync(path.join(dir, entry.name), "utf8");
    }
  };
  if (fs.existsSync(root)) walk(root, "");
  return out;
}
