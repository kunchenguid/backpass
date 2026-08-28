import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { UserError, fail, setQuiet } from "./logger.js";
import { loadConfig, parseMaxTranscripts } from "./config.js";
import { resolveRepo } from "./repo.js";
import { State } from "./state.js";
import { AgentResolver } from "./agents.js";

import { cmdInit } from "./commands/init.js";
import { cmdScan } from "./commands/scan.js";
import { cmdAnalyze } from "./commands/analyze.js";
import { cmdPropose } from "./commands/propose.js";
import { cmdApply } from "./commands/apply.js";
import { cmdStatus } from "./commands/status.js";
import { cmdRun } from "./commands/run.js";

const PKG = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
);

export const VERSION = PKG.version;

/** @type {import("node:util").ParseArgsOptionsConfig} */
const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  quiet: { type: "boolean", short: "q" },
  json: { type: "boolean" },

  since: { type: "string" },
  harness: { type: "string" },
  jobs: { type: "string" },
  strict: { type: "boolean" },
  "include-cursor-ide": { type: "boolean" },

  budget: { type: "string" },
  "max-edits": { type: "string" },
  "max-transcripts": { type: "string" },
  seed: { type: "string" },
  "min-gap-evidence": { type: "string" },
  "memory-file": { type: "string", multiple: true },
  "skills-dir": { type: "string" },

  "analysis-agent": { type: "string" },
  "analysis-model": { type: "string" },
  "analysis-effort": { type: "string" },
  "synthesis-agent": { type: "string" },
  "synthesis-model": { type: "string" },
  "synthesis-effort": { type: "string" },

  "dry-run": { type: "boolean" },
  "no-ui": { type: "boolean" },
  "no-open": { type: "boolean" },
  "no-auto-agent": { type: "boolean" },
  force: { type: "boolean" },
  limit: { type: "string" },
  theme: { type: "string" },
};

const HELP = `backpass v${VERSION} - gradient descent for your agent memory

A backward pass over AGENTS.md / CLAUDE.md: it finds the agent sessions that ran in this
repo, reads what actually happened in them, and proposes evidence-backed edits to the
memory file - under a token budget, gated by you.

USAGE
  backpass [command] [options]

COMMANDS
  (none)     the full pass: collect samples → calculate loss → aggregate gradients →
             gradient descent. Never writes.
  scan       collect samples only: which transcripts belong to this repo, and how we know
  analyze    calculate loss: one cheap model call per new transcript (tier 1)
  propose    aggregate gradients, then high-reasoning gradient descent
             turning the aggregated evidence into edits (tier 2)
  apply      review the proposal and write the accepted edits (the only writer)
  status     cache state, evidence counts, and the budget bar
  init       write .backpassrc.json and exclude .backpass/ via .git/info/exclude

COLLECT SAMPLES
  --since <dur>            only sessions newer than this (30d, 12h, 2w, all)  [30d]
  --harness <a,b>          limit to these harnesses
                           (claude, codex, pi, opencode, grok, cursor, hermes)
  --strict                 deterministic associations only (tiers 1 and 2)
  --include-cursor-ide     also scan the Cursor IDE store (best-effort, v1.1 preview)
  --limit <n>              analyze at most N transcripts this run (newest first)
  --max-transcripts <n>    cap per run; past it a recency-weighted sticky sample
                           is analyzed. 0 or "all" disables the cap          [100]
  --seed <n>               draw a different reproducible transcript sample

MODELS (two-tier: cheap analysis, smart synthesis - all through acpx)
  By default each pass auto-picks the first harness in its ladder that is installed,
  logged in, and serves the model (a ~1.5s zero-token probe per candidate, cached):
    analysis   gpt-5.6-luna via pi, opencode, codex  >  claude-sonnet-5 via claude  >  grok-4.6 via pi, opencode, grok
    synthesis  gpt-5.6-sol  via pi, opencode, codex  >  claude-opus-5  via claude  >  grok-4.6 via pi, opencode, grok
  Setting an agent pins that pass and skips its ladder.
  --analysis-agent <a>     acpx agent for the per-transcript pass       [auto]
  --analysis-model <id>    model id for the analysis pass (needs --analysis-agent)
  --analysis-effort <e>    one-off reasoning effort, when supported          [medium]
  --synthesis-agent <a>    acpx agent for the final proposal pass       [auto]
  --synthesis-model <id>   model id for the synthesis pass (needs --synthesis-agent)
  --synthesis-effort <e>   one-off reasoning effort for synthesis            [high]
  --no-auto-agent          skip the ladders and pin codex / claude (the pre-0.2 defaults)
  --jobs <n>               parallel analysis calls                      [4]

BUDGET AND SHAPE
  --budget <tokens>        always-loaded budget per memory file         [5000]
  --max-edits <n>          edits per run - the learning rate            [adaptive]
  --min-gap-evidence <n>   sessions needed to add or remove instruction [2]
  --memory-file <path>     memory file to optimize (repeatable)
  --skills-dir <path>      where skill extractions are written          [.agents/skills]

APPLY
  --no-ui                  terminal accept/reject instead of the Lavish surface
  --no-open                print the review surface URL without opening a browser
  --dry-run                show what would be written, write nothing
  --force                  re-analyze transcripts that already have fresh evidence,
                           and re-probe agents instead of trusting the probe cache

OTHER
  --theme <mode>           live progress ink set: auto, dark, or light    [auto]
  --json                   machine-readable output on stdout
  -q, --quiet              suppress progress output (also disables the live view)
  -h, --help               this help
  -v, --version            print version

The default run renders a live progress view on an interactive terminal. It draws
to stderr only and falls back to plain lines when piped, in CI, under NO_COLOR,
or below 60 columns - stdout and --json output are identical either way.

EXAMPLES
  backpass                                  a full run, ending with a proposal
  backpass scan --since 7d --strict         what would be collected, deterministic only
  backpass --synthesis-agent claude --synthesis-model claude-opus-5
  backpass apply --no-ui                    review and write from the terminal
`;

/** Map CLI flags onto the config shape so one merge order covers every layer. */
function overridesFrom(values) {
  const overrides = { discovery: {}, analysis: {}, synthesis: {} };

  if (values.since) overrides.discovery.since = values.since;
  if (values.harness) {
    overrides.discovery.harnesses = values.harness
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
  }
  if (values["include-cursor-ide"]) overrides.discovery.includeCursorIde = true;
  if (values.jobs) overrides.jobs = toInt(values.jobs, "--jobs");
  if (values.budget) overrides.budgetTokens = toInt(values.budget, "--budget");
  if (values["max-edits"]) overrides.maxEditsPerRun = toInt(values["max-edits"], "--max-edits");
  if (values["max-transcripts"] !== undefined) {
    overrides.maxTranscripts = parseMaxTranscripts(values["max-transcripts"], "--max-transcripts");
  }
  if (values.seed !== undefined) overrides.seed = toSeed(values.seed);
  if (values["min-gap-evidence"]) {
    overrides.minGapEvidence = toInt(values["min-gap-evidence"], "--min-gap-evidence");
  }
  if (values["memory-file"]?.length) overrides.memoryFiles = values["memory-file"];
  if (values["skills-dir"]) overrides.skillsDir = values["skills-dir"];
  if (values.theme) overrides.theme = values.theme;

  if (values["analysis-agent"]) overrides.analysis.agent = values["analysis-agent"];
  if (values["analysis-model"]) overrides.analysis.model = values["analysis-model"];
  if (values["analysis-effort"]) overrides.analysis.effort = values["analysis-effort"];
  if (values["synthesis-agent"]) overrides.synthesis.agent = values["synthesis-agent"];
  if (values["synthesis-model"]) overrides.synthesis.model = values["synthesis-model"];
  if (values["synthesis-effort"]) overrides.synthesis.effort = values["synthesis-effort"];
  if (values["no-auto-agent"]) overrides.autoAgent = false;

  for (const key of ["discovery", "analysis", "synthesis"]) {
    if (!Object.keys(overrides[key]).length) delete overrides[key];
  }
  return overrides;
}

function toInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UserError(`${flag} must be a positive integer (got "${value}")`);
  return n;
}

function toSeed(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new UserError(`--seed must be an integer (got "${value}")`);
  return n;
}

const COMMANDS = {
  init: cmdInit,
  scan: cmdScan,
  analyze: cmdAnalyze,
  propose: cmdPropose,
  apply: cmdApply,
  status: cmdStatus,
  run: cmdRun,
};

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    fail(err.message);
    console.error("\nRun `backpass --help` for the full option list.");
    return 2;
  }

  const { values, positionals } = parsed;

  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  setQuiet(values.quiet);

  const commandName = positionals[0] || "run";
  const command = COMMANDS[commandName];
  if (!command) {
    fail(`unknown command "${commandName}"`);
    console.error("\nRun `backpass --help` for the command list.");
    return 2;
  }

  try {
    const repo = resolveRepo(process.cwd());
    const config = loadConfig(repo.root, overridesFrom(values));
    config.state = new State(repo.root).ensure();
    config.agents = new AgentResolver(config, {
      state: config.state,
      cwd: repo.root,
      bypassCache: Boolean(values.force),
    });

    const ctx = {
      repo,
      config,
      flags: values,
      positionals: positionals.slice(1),
      version: VERSION,
      strict: Boolean(values.strict),
      limit: values.limit ? toInt(values.limit, "--limit") : null,
    };

    return (await command(ctx)) ?? 0;
  } catch (err) {
    if (err instanceof UserError) {
      fail(err.message);
      if (err.hint) console.error(`  ${err.hint}`);
      return 1;
    }
    fail(err.stack || err.message);
    return 1;
  }
}
