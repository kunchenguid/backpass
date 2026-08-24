<h1 align="center">backpass</h1>
<p align="center">
  <a href="https://github.com/kunchenguid/backpass/actions/workflows/ci.yml"
    ><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/kunchenguid/backpass/ci.yml?style=flat-square&label=ci"
  /></a>
  <a href="https://github.com/kunchenguid/backpass/actions/workflows/release-please.yml"
    ><img alt="Release" src="https://img.shields.io/github/actions/workflow/status/kunchenguid/backpass/release-please.yml?style=flat-square&label=release"
  /></a>
  <a href="https://www.npmjs.com/package/backpass"
    ><img alt="npm" src="https://img.shields.io/npm/v/backpass?style=flat-square"
  /></a>
  <a href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue?style=flat-square"
    ><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue?style=flat-square"
  /></a>
  <a href="https://x.com/kunchenguid"
    ><img alt="X" src="https://img.shields.io/badge/X-@kunchenguid-black?style=flat-square"
  /></a>
  <a href="https://discord.gg/Wsy2NpnZDu"
    ><img
      alt="Discord"
      src="https://img.shields.io/discord/1439901831038763092?style=flat-square&label=discord"
  /></a>
</p>

<h3 align="center">Gradient descent for your agent memory.</h3>

Your `AGENTS.md` is a set of weights. Every agent session is a forward pass. The
transcript that session leaves on disk is the loss signal - and today nothing reads it.
The loop only closes when a human happens to remember a failure and edits the file by hand.

`backpass` closes it. It finds the agent sessions that actually ran in your repo, reads
what happened in them, and proposes evidence-backed edits to your memory file - under a
token budget, gated by you.

- **Local-first** - Reads the transcript stores of seven agent harnesses directly from disk.
  No API, no upload; transcripts never leave your machine except into an agent you already
  authenticated, and obvious secrets are redacted before they do.
- **Evidence-gated** - Every proposed edit carries verbatim quotes from real sessions, a
  new instruction needs evidence from at least two independent sessions, and one run
  proposes at most five edits. Small, noisy, repeated steps - not a rewrite.
- **Human in the loop** - Analysis never writes. `backpass apply` is the only writing
  command, and it shows each edit with its evidence for you to accept or reject.

```
AGENTS.md / CLAUDE.md          (the weights)
  → agent session               (forward pass)
  → transcript on disk          (loss signal)
  → backpass: collect samples, distill, calculate loss, aggregate gradients
  → backpass: gradient descent  (diffs + skill extractions)
  → you accept or reject        (the human gate)
  → back to the weights
```

One run is one gradient step: at most five edits, and a new instruction needs evidence
from at least two independent sessions.

## Quick Start

```sh
npm install -g backpass
# or run it without installing
npx backpass
```

Requires **Node >= 22.5** and [`acpx`](https://github.com/openclaw/acpx) on your PATH.

backpass has **no API keys of its own**. Every model call goes through acpx to a harness
you have already authenticated.

```sh
cd your-repo
backpass init      # write .backpassrc.json, exclude .backpass/ via .git/info/exclude
backpass           # collect samples → calculate loss → aggregate gradients → gradient descent (never writes)
backpass apply     # review each edit, accept or reject, then write
```

## How It Works

### 1. Collect samples - which sessions belong to this repo

backpass reads the local transcript stores of seven harnesses directly. No API, no upload.

| Harness        | Store                                          | Repo tie                                            |
| -------------- | ---------------------------------------------- | --------------------------------------------------- |
| **claude**     | `~/.claude/projects/<munged-cwd>/<uuid>.jsonl` | per-line `cwd`                                      |
| **codex**      | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `cwd` + recorded `git.repository_url`               |
| **pi**         | `~/.pi/agent/sessions/<escaped-cwd>/*.jsonl`   | session-header `cwd`                                |
| **opencode**   | `~/.local/share/opencode/opencode.db` (sqlite) | `session.directory`                                 |
| **grok**       | `~/.grok/sessions/<encoded-cwd>/<uuid>/`       | `summary.json` `cwd` + `git_remotes`                |
| **cursor CLI** | `~/.cursor/chats/<md5(cwd)>/<uuid>/`           | `meta.json` `cwd`                                   |
| **hermes**     | `~/.hermes/state.db` (sqlite)                  | session cwd, with CLI prompt / ACP config fallbacks |

Hermes collection includes CLI and ACP sessions only. Gateway, cron, and WhatsApp sessions
are excluded because their recorded cwd belongs to the shared gateway process, not a project.

Association runs in three tiers:

1. **Tier 1 - deterministic.** The session's cwd is (or sits inside) one of this repo's
   worktrees.
2. **Tier 2 - deterministic, survives deletion.** A git remote recorded in the transcript
   matches one of the repo's remotes. This is how codex and grok stay attributable long
   after the worktree is gone.
3. **Tier 3 - best-effort.** A dead path whose last segment is the repo's directory name,
   or one matching a glob you configured. Labelled as such, and excluded by `--strict`.

Collection is incremental. Codex alone can hold 10,000+ rollouts, so verdicts are cached in
`.backpass/scan-cache.json` by path, mtime and size - re-scans cost only the new files.
A harness whose store is missing or has drifted into an unrecognised shape produces a
warning and is skipped; the run continues. backpass's own loss and gradient-descent calls land
in these same stores under the repo's cwd; every prompt it sends is tagged, and tagged
sessions are excluded from the corpus (the `SELF` column in `backpass scan`).

```sh
backpass scan --since 7d --strict
```

### 2. Distillation - cheap first

Raw transcripts are mostly tool-call noise; a megabyte of session is a few thousand tokens
of actual signal. Before any model sees anything, backpass reduces each session
deterministically: user and assistant turns verbatim, each tool call collapsed to one line
(`tool: Bash "npm test" -> 1 failing`), tool output truncated, injected harness scaffolding
dropped, secrets redacted. Typical reduction is **96-99%**.

The distilled trace ends with the path to the raw transcript, so the analysis agent can
open the original when - and only when - a specific claim needs it.

### 3. Calculate loss - one cheap call per transcript

Calculating loss costs one call per transcript, so the set is capped first: past `maxTranscripts`
(default 100, `--max-transcripts`) a **recency-weighted sample** is analyzed instead of
everything. Each transcript's weight halves every `sampleHalfLife` (default 14d), and the
sample is drawn without replacement, so recent sessions are almost always kept and old
ones stay represented in proportion. When this happens the run says so on stderr
(`discovered 340 transcript(s), analyzing a recency-weighted sample of 100`); pass
`--max-transcripts all` to analyze every transcript, or `--seed <n>` to reproduce a sample.

Each distilled trace goes to a cheap model with the memory file and a rubric. It returns
strict JSON: which instructions helped, which were violated, and what mistakes no current
instruction covers.

**Every claim must carry a verbatim quote.** Quoteless items are discarded - the single
most important defence against a model confabulating influence. Negative evidence (a
visible violation) is weighted highest.

Results are cached per transcript, keyed to both the transcript's content _and_ the memory
file's hash: edit the weights and the evidence correctly re-computes; change nothing and
the next run is free.

### 4. Aggregate gradients - deterministic, no model

Evidence is grouped by instruction, giving each one a positive/negative count and a
**relevance** figure: the share of analyzed sessions in which it mattered at all. Duplicate
gaps across sessions are clustered, and clusters seen in fewer than `minGapEvidence`
sessions (default 2) are dropped. One bad session never rewrites the weights.

Those sessions are counted across runs, not per run: every gap sighting is kept in
`.backpass/gap-ledger.json` by gap and session, so a gap seen in one session today and in
another session next week graduates on the later run. The same session never counts twice,
a sighting retires once the memory file gains an instruction that covers it, and a session's
sightings expire after `gapLedgerMaxAge` (default 90d). Until a gap corroborates it stays
out of the proposal entirely.

### 5. Gradient descent - one session, native edits

A single high-reasoning session turns the aggregated gradients into concrete edits: ADD,
REMOVE, REWRITE, or EXTRACT→SKILL. The agent does not describe edits for backpass to
splice in - it makes them, with its harness's own file tools, in a **staging copy** of the
memory file under `.backpass/synthesis/` (the repo itself is read-only to it, for
grounding). backpass then diffs the copy against the original and shows the agent the
measured changes by id; the agent annotates each one with a title, rationale, and the
verbatim evidence behind it. Nothing textual is ever taken from the model: every hunk's
text is copied out of your file by construction, so an edit can never "not appear" in it.
Then mechanical gates run, and they are not negotiable:

- at most `maxEditsPerRun` edits (the learning rate). By default the cap is adaptive: 5
  when the file is near or under budget, and in a shrink plan (file over budget) one edit
  per ~40 tokens of overage, capped at 20, so badly overgrown files recover in fewer runs.
  An explicit `--max-edits` or config value always pins it.
- every measured change belongs to exactly one annotated edit - an unexplained change
  is a violation, so is an edit that names no change
- new instructions need evidence from `minGapEvidence` distinct sessions (an edit that
  only adds text is a new instruction, whatever the model calls it)
- every edit carries a verbatim quote
- the post-edit file must fit the budget, measured on the staged file

A violation triggers a re-prompt naming the exact breach (at most two). If those also
fail, backpass **fails loudly** and saves the rejected proposal. It never silently
truncates. A harness that writes past the staging copy into the repo is an error, never
an apply.

Token deltas shown to you are measured by backpass from the actual text - never taken from
the model's own arithmetic.

### 6. The budget - "model size"

Every always-loaded token is paid on every future session, forever, and instruction
following dilutes as the file grows. So the budget is the constraint the whole backward
pass optimizes under.

**Default: 5,000 estimated tokens (~20KB)** per always-loaded memory file, configurable.
The estimator is bytes/4 - harness-neutral, ±15%.

```
AGENTS.md      [###############.................] 2,412 / 5,000 tok · 63 instructions
```

At or over budget, the synthesis prompt goes zero-sum: every addition must name the
removal or extraction that pays for it.

### 7. Skills as overflow

A skill's description **is** its when-useful condition: the description is always loaded
and cheap, the body is free until the trigger fires. That makes extraction the release
valve for the budget.

|                                                  | Trigger fits one description line | Trigger not detectable |
| ------------------------------------------------ | --------------------------------- | ---------------------- |
| **Broad** (≥20% of sessions, or safety-critical) | memory file                       | memory file            |
| **Conditional / narrow**                         | **skill**                         | deletion candidate     |

"Matters in N% of sessions" is measured, not guessed - it falls straight out of the
aggregate-gradients stage. A 640-token procedure relevant to 4% of sessions becomes a 35-token description
line, and backpass reports the arithmetic: `−611 tok always-loaded, +35 tok description`.

Skill descriptions are weights too. If the evidence shows an agent lacked knowledge a
skill already contains, that is a _failed trigger_ - backpass proposes a description edit,
not duplicate content.

### 8. Apply - the human gate

`backpass apply` is the only command that writes. It serves a review surface through
[`lavish-axi`](https://github.com/kunchenguid/lavish-axi): one card per edit with the diff,
the evidence quotes and their sources, a live budget gauge, and ACCEPT / REJECT.

The surface is a static template shipped in the package - the CLI injects one JSON payload,
so it is instant, deterministic, and identical every run. Nothing there is model-generated.
It opens in your default browser when one is available; the URL is always printed too, so
a headless box or `--no-open` just hands you the link.

There is no DEFER button, and it isn't missing: **rejections are remembered.** A rejected
edit is not proposed again unless materially new evidence arrives.

The live budget gauge is not just a readout. Apply rechecks the accepted subset against
the same budget gate as synthesis: stay under the cap, or shrink if the file is already
over. An incompatible set writes nothing and does not record rejections, so you can pick
a compatible set and try again.

```sh
backpass apply --no-ui     # same decision, in the terminal
backpass apply --no-open   # print the surface URL, don't launch a browser
backpass apply --dry-run   # show what would be written
```

### 9. Which file is the weights

`memoryFiles` is an ordered list (default `["AGENTS.md", "CLAUDE.md"]`); the first one
that exists is the file a run optimizes, so **AGENTS.md is canonical**. Resolution is
pointer-aware:

- `CLAUDE.md` containing only `@AGENTS.md` (the standard import) is a pointer: optimizing
  AGENTS.md covers both harness families and the pointer stays valid. Nothing to report.
- Two separate full files are a divergence hazard. backpass optimizes AGENTS.md, leaves
  CLAUDE.md untouched, and warns each run until you consolidate: move CLAUDE.md's content
  into AGENTS.md and make CLAUDE.md the one-line pointer.
- A repo with **no memory file** is bootstrapped on the first `backpass` run: a starter
  AGENTS.md (purpose, an empty `## Learnings` section, a `## Maintaining this file`
  section) plus a CLAUDE.md pointer. The starter is then run through the ordinary backward pass, so recurring gaps
  from your real transcripts become its first evidence-backed instructions. With no
  transcripts it is seeded from defaults alone and says so. Bootstrap only ever creates
  files; review it with `git diff`.

## CLI Reference

| Command            | What it does                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `backpass`         | collect samples → calculate loss → aggregate gradients → gradient descent. Never writes. |
| `backpass scan`    | collect samples only: the transcript table with a confidence column                      |
| `backpass analyze` | calculate loss: the tier-1 pass over pending transcripts                                 |
| `backpass propose` | aggregate gradients + gradient descent: the tier-2 pass from cached evidence             |
| `backpass apply`   | review and write the accepted edits                                                      |
| `backpass status`  | cache state, failed transcripts, budget bars                                             |
| `backpass init`    | write `.backpassrc.json`, exclude `.backpass/` locally                                   |

Run `backpass --help` for the full flag list.

### Live progress

On an interactive terminal the default run renders a live progress view: the budget gauge,
a stage rail (collect samples → calculate loss → aggregate gradients → gradient descent),
per-store collection counts, one lane
per analysis job with its distillation receipt, and a running evidence tally. It draws to
stderr only and collapses into the plain line summary when the run ends, so scrollback and
piped output are identical to a run without it.

The view never gets in the way of automation: no TTY, `NO_COLOR`, `CI`, `--quiet`, `--json`,
or a terminal under 60 columns all mean plain lines, unchanged. Truecolor terminals get the
backpass theme; everything else falls back to the nearest ANSI-16 colors. The ink set adapts
to light backgrounds automatically (queried via OSC 11, `COLORFGBG` as fallback); force one
with `--theme dark|light` or `"theme"` in `.backpassrc.json`.

### Two-tier models

Cheap analysis, smart synthesis. Both go through acpx, so backpass uses the harnesses you
already have - and by default it works out which ones those are. Each pass has an ordered
ladder of candidates, and the first one that is installed, logged in, and serves the model
wins:

| pass      | effort | 1st                                    | 2nd                          | 3rd                               |
| --------- | ------ | -------------------------------------- | ---------------------------- | --------------------------------- |
| analysis  | medium | `gpt-5.6-luna` via pi, opencode, codex | `claude-sonnet-5` via claude | `grok-4.6` via pi, opencode, grok |
| synthesis | high   | `gpt-5.6-sol` via pi, opencode, codex  | `claude-opus-5` via claude   | `grok-4.6` via pi, opencode, grok |

Each candidate is checked with a ~1.5s zero-token acpx probe (claude via `claude auth status`,
because its adapter accepts sessions while logged out); verdicts are cached in
`.backpass/agent-probe-cache.json` for 12h (30min for negatives) and re-probed with `--force`.
The probe is a filter, not a promise: if the chosen harness answers `AUTH_REQUIRED` or rejects
the model mid-run, backpass falls through to the next candidate and says so. When a whole
ladder is exhausted the error lists every candidate with what to run to fix it.

Bare model ids are resolved against what each adapter advertises (`openai-codex/gpt-5.6-luna`
on pi, `openai/gpt-5.6-luna` on opencode, `gpt-5.6-luna` on codex), so nothing is hardcoded
per harness. Ladders are ordinary config - reorder or shorten them under `"ladders"`.

Pinning an agent skips its ladder entirely:

```sh
backpass \
  --analysis-agent codex  --analysis-model gpt-5.5        --analysis-effort low \
  --synthesis-agent claude --synthesis-model claude-opus-5 --synthesis-effort high
```

`--no-auto-agent` pins the pre-ladder defaults (codex / claude). If an adapter does not
advertise reasoning effort, backpass says so in the run report rather than pretending it
applied.

### Configuration

`.backpassrc.json` in the repo root, layered over `~/.config/backpass/config.json`, with
CLI flags on top:

```json
{
  "memoryFiles": ["AGENTS.md"],
  "budgetTokens": 5000,
  "skillsDir": ".agents/skills",
  "maxEditsPerRun": null,
  "minGapEvidence": 2,
  "gapLedgerMaxAge": "90d",
  "maxTranscripts": 100,
  "sampleHalfLife": "14d",
  "analysis": { "agent": null, "model": null, "effort": null },
  "synthesis": { "agent": null, "model": null, "effort": null },
  "ladders": {
    "analysis": [
      { "model": "gpt-5.6-luna", "agents": ["pi", "opencode", "codex"] },
      { "model": "claude-sonnet-5", "agents": ["claude"] },
      { "model": "grok-4.6", "agents": ["pi", "opencode", "grok"] }
    ],
    "synthesis": [
      { "model": "gpt-5.6-sol", "agents": ["pi", "opencode", "codex"] },
      { "model": "claude-opus-5", "agents": ["claude"] },
      { "model": "grok-4.6", "agents": ["pi", "opencode", "grok"] }
    ]
  },
  "discovery": {
    "harnesses": ["claude", "codex", "pi", "opencode", "grok", "cursor", "hermes"],
    "since": "30d",
    "worktreeGlobs": [],
    "minUserTurns": 2
  },
  "jobs": 4
}
```

### State

Everything mutable lives in `.backpass/`, kept out of git via the repo's local exclude
(`.git/info/exclude`, written by `backpass init`) rather than the tracked `.gitignore`:

```
.backpass/
  scan-cache.json        collect-samples verdicts by path + mtime + size
  evidence/<id>.json     per-transcript loss
  evidence-summary.json  aggregated gradients
  proposal.json          the latest gradient-descent step
  synthesis/             the staging copy the gradient-descent agent edited (memory file + skills)
  prompts/               the exact prompts of the last run
  agent-probe-cache.json which harnesses were available and logged in, and when
  rejections.json        edits you turned down, and the evidence behind them
  gap-ledger.json        gap sightings by gap and session, accumulated across runs
  apply/apply.html       the rendered review surface
```

## Limitations

- **Causal attribution is genuinely hard.** A model can confabulate influence. The
  mitigations are structural - mandatory verbatim quotes, the two-session rule, negative
  evidence weighted highest, and a human gate - but read the evidence, not just the title.
- **Transcript formats are undocumented** and can change without notice. Each adapter is
  pinned by a golden fixture and fails soft.
- **Cursor IDE is deferred to v1.1.** Its composer→workspace link is version-dependent;
  `--include-cursor-ide` enables a best-effort pass, but it is not a v1 guarantee.
- Global memory (`~/.claude/CLAUDE.md`) is treated as context, never an edit target.
- Paths are verified on macOS and Linux.

## Development

```sh
git clone https://github.com/kunchenguid/backpass.git
cd backpass
pnpm install --frozen-lockfile
```

```sh
pnpm run check          # Run all verification commands
pnpm test               # Run node:test tests
pnpm run lint           # Run ESLint
pnpm run format:check   # Check Prettier formatting
pnpm run typecheck      # Run TypeScript checkJs validation
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contributor workflow.
