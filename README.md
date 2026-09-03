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
what happened in them, and proposes evidence-backed edits to your memory surface - the
memory file and project skills - under a token budget, gated by you.

- **Local-first** - Reads the transcript stores of seven agent harnesses directly from disk.
  No API, no upload; transcripts never leave your machine except into an agent you already
  authenticated, and obvious secrets are redacted before they do.
- **Evidence-gated** - Every proposed edit carries verbatim quotes from real sessions,
  and every `add`, `rewrite`, or `remove` edit needs evidence from at least two distinct
  sessions. Small, noisy, bounded steps - not a rewrite.
- **Human in the loop** - Analysis never writes. `backpass apply` is the only writing
  command, and it shows each edit with its evidence for you to accept or reject.

```
AGENTS.md / CLAUDE.md + skills (the weights)
  → agent session               (forward pass)
  → transcript on disk          (loss signal)
  → backpass: collect samples, distill, calculate loss, aggregate gradients
  → backpass: gradient descent  (diffs + skill extractions)
  → you accept or reject        (the human gate)
  → back to the weights
```

One run is one bounded gradient step.

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

### User-level memory

A run is one scope. The default is the checkout you are in. `backpass --scope user`
trains the always-loaded user file and user-level skills from Claude Code and Codex
sessions across projects, and writes only those files. A project-scoped run never
writes a user-level file.

Canonical user memory is the first existing file in this order: `~/.agents/AGENTS.md`,
`$CLAUDE_CONFIG_DIR/CLAUDE.md` (default `~/.claude/CLAUDE.md`), and
`$CODEX_HOME/AGENTS.md` (default `~/.codex/AGENTS.md`). User-level skill extractions
follow the project layout at `~/.agents/skills`, with a warning if Claude's active
`skills` path is a real directory rather than the usual symlink.

In user scope every `add`, `rewrite`, or `remove` edit also clears `minGapProjects`
(default `1`): the distinct projects behind its own quotes, counted from the gap
clusters it cites and from the session-to-project map behind the instruction evidence
rows. `extract` and `move` edits remain exempt.

State lives in `$XDG_CONFIG_HOME/backpass/user/` (default
`~/.config/backpass/user/`) with mode 0700, isolated from every project's
`.backpass/`. User-scope evidence, ledgers, proposals, and apply surfaces stay in
that one directory.

Harness load paths, verified for v1:

- **Claude Code** loads `CLAUDE.md` from `CLAUDE_CONFIG_DIR` (default `~/.claude`)
  and inlines `@` imports, including `~/` and absolute paths. A CLAUDE.md containing
  only an import that resolves to the canonical user memory is a valid pointer, such
  as `@~/.agents/AGENTS.md` with the default paths.
- **Codex** loads `AGENTS.md` from `CODEX_HOME` (default `~/.codex`). It follows the
  AGENTS.md convention; `@` import is not assumed.

A target that is a symlink into a read-only store (dotfiles, nix) is refused with
`<path> is a symlink to <real>, which is not writable; edit the source that generates it`.

```sh
backpass init --scope user
backpass --scope user
backpass apply --scope user
```

## How It Works

### 1. Collect samples - which sessions belong to this repo

backpass reads the local transcript stores of seven harnesses directly. No API, no upload.

| Harness        | Store                                          | Repo tie                                            |
| -------------- | ---------------------------------------------- | --------------------------------------------------- |
| **claude**     | `~/.claude/projects/<munged-cwd>/<uuid>.jsonl` | per-line `cwd`                                      |
| **codex**      | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `cwd` + recorded `git.repository_url`               |
| **pi**         | standalone and BB-managed Pi JSONL stores      | session-header `cwd`                                |
| **opencode**   | `~/.local/share/opencode/opencode.db` (sqlite) | `session.directory`                                 |
| **grok**       | `~/.grok/sessions/<encoded-cwd>/<uuid>/`       | `summary.json` `cwd` + `git_remotes`                |
| **cursor CLI** | `~/.cursor/chats/<md5(cwd)>/<uuid>/`           | `meta.json` `cwd`                                   |
| **hermes**     | `~/.hermes/state.db` (sqlite)                  | session cwd, with CLI prompt / ACP config fallbacks |

Claude collection covers `$CLAUDE_CONFIG_DIR/projects` alongside the default store, so a
relocated config dir does not hide its sessions. The variable is read from backpass's own
environment: if you reach that profile through an alias that only prefixes `claude`, set it
for the backpass run too (`CLAUDE_CONFIG_DIR=~/.claude-work backpass`, or export it).

Pi collection covers standalone sessions under `~/.pi/agent/sessions/` and BB-managed Pi
sessions under `~/.bb/pi-bridge-sessions/`. It also honors `PI_CODING_AGENT_DIR`,
`PI_CODING_AGENT_SESSION_DIR`, `BB_DATA_DIR`, and `BB_PI_BRIDGE_SESSION_DIR` when they are
set in backpass's environment. When roots overlap, backpass scans every applicable layout
and reads each JSONL file once.

Hermes collection includes CLI and ACP sessions only. Gateway, cron, and WhatsApp sessions
are excluded because their recorded cwd belongs to the shared gateway process, not a project.

Association runs in four tiers:

1. **Tier 1 - deterministic.** The session's cwd is (or sits inside) one of this repo's
   worktrees.
2. **Tier 1.5 - deterministic, sibling clone.** The cwd is a live local clone (or one of
   its worktrees) that shares a git remote with this repo. `git worktree list` only sees
   worktrees from one clone, and Claude records no remote, so without this tier a sibling
   clone's interactive history is invisible. Backpass searches the parent
   of each of this repo's worktrees, plus any `discovery.cloneRoots` you configure, and
   only reads git identity there. Each clone root may be a checkout or a directory whose
   immediate children are checkouts; relative paths resolve from the repo root. `--strict`
   keeps this tier.
3. **Tier 2 - deterministic, survives deletion.** A git remote recorded in the transcript
   matches one of the repo's remotes. This is how codex and grok stay attributable long
   after the worktree is gone.
4. **Tier 3 - best-effort.** A dead path whose last segment is the repo's directory name,
   or one matching a glob you configured. Labelled as such, and excluded by `--strict`.

Collection is incremental. Codex alone can hold 10,000+ rollouts, so verdicts are cached in
`.backpass/scan-cache.json` by path, mtime and size - re-scans cost only the new files.
A harness whose store is missing or has drifted into an unrecognised shape produces a
warning and is skipped; the run continues. backpass's own loss and gradient-descent calls land
in these same stores under the repo's cwd; every prompt it sends is tagged, and tagged
sessions are excluded from the corpus (the `SELF` column in `backpass scan`).

Every remaining session is labelled **interactive** or **non-interactive** (`src/interaction.js`).
Codex `codex exec` / `originator: codex_exec`, Claude SDK, GitHub, action, and CI
entrypoints, OpenCode child sessions (`parent_id`), and a cwd with a `.no-mistakes` path
segment are non-interactive. Hermes gateway, cron, and WhatsApp sessions are classified the
same way if they leak past collection's source filter. A no-mistakes pipeline run is just one
kind of non-interactive session, not its own category. Missing harness metadata defaults to
interactive. `backpass scan`, the proposal, and apply all print the mix so relevance is never
silently computed against a robot-skewed pool.

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
ones stay represented in proportion. When both interactive and non-interactive sessions
are present, slots are allocated in proportion to the corpus with a 20% floor per category,
subject to available sessions and the cap. This keeps a scarce category in the sample
without forcing a genuinely mixed corpus to 50/50. When this happens the run says so on
stderr
(`discovered 340 transcript(s), analyzing a recency-weighted sample of 100`).

The draw is deterministic and sticky: it is derived from each transcript's own durable
identity, not from a fresh random seed, so rerunning does not trigger a fresh draw that
randomly reshuffles the sample and wastes model calls. Existing transcripts keep their
draws as the corpus grows, while new sessions compete for room on the same footing. Recency
weights still evolve as transcripts age, so the selected set can change over time. Pass
`--max-transcripts all` to analyze every transcript, or `--seed <n>` to draw a different,
equally reproducible sample.

Each distilled trace goes to a cheap model with the memory file, the project skill index,
and a rubric. It returns strict JSON: which instructions helped, which were violated, and
what mistakes no current instruction covers. Every negative carries a class - `harm` (following the instruction
caused damage), `non-compliance` (the agent ignored it), or `irrelevant` - because those
argue for opposite fates: harm argues against an instruction, non-compliance argues for
reinforcing it. Every gap carries a domain - `orchestration` when the mistake was caused
not by this repository but by an external agent harness or tooling that orchestrated the
task, `project` for every other mistake (including when this repository is the
orchestrating tool) - and the
analysis is shown the ledger's open gaps so it can cite an existing gap id instead of
coining a paraphrase of it.

**Every claim must carry a verbatim quote.** Quoteless items are discarded - the single
most important defence against a model confabulating influence. Negative evidence is
weighted highest, but its class determines what it supports: non-compliance supports
reinforcement, while only harm supports removal.

To avoid smearing evidence across a large prose blob, backpass splits eligible prose
paragraphs above 120 tokens at high-confidence sentence boundaries for attribution only.
Ambiguous boundaries stay unsplit, and the paragraph remains one line-oriented edit unit.
When its sentence parts
draw repeated non-compliance, synthesis is steered to restructure the paragraph into list
items instead of adding a cosmetic label.

Results are cached per transcript, keyed to the transcript's content, the effective
memory-surface hash, and the analysis-index version. The surface hash covers the memory-file
set plus every project skill's name and description. Edit a memory file or skill description
and the evidence correctly re-computes; edit only a skill body and the cache remains valid
because bodies are inspected only for failed-trigger confirmation. A repo without skills
keeps the prior memory-set hash. A surface edit therefore reanalyzes without `--force` - that
is not a cache miss, it is the cache doing its job - and the run says so on stderr, naming the
old and new hash, so a "0 reused" line reads as "the surface changed" rather than "reuse is
broken." Evidence files that are not refreshed remain on disk but are excluded while their
full cache key is stale. They become eligible again only when that complete key is current
and the selected-sample and interaction-stamp rules below apply; evidence for transcripts
included in the new analysis is replaced with fresh judgments.

### 4. Aggregate gradients - and one judged consolidation call

Evidence is grouped by instruction, giving each one a positive/negative count, a count of
distinct sessions with harm-class negatives, and a **relevance** figure: the share of
analyzed sessions in which it mattered at all. Relevance is reported both overall and
separately for interactive and non-interactive sessions. The fold also reports memory-file
units that substantially overlap a project skill. An overlap with a skill description duplicates
always-loaded tokens and points the shrink at the memory-file copy; an overlap with a
triggered skill body is placement evidence only, since the memory copy may be the only
always-loaded coverage. Neither kind is deleted automatically. Duplicate gaps across
sessions are clustered, and only clusters seen in at least `minGapEvidence` sessions
(default 2) are eligible for synthesis. Mixed-domain clusters below that floor remain
visible as report-only diagnostics. One bad session never rewrites the weights.

Whether two sightings are one gap is a judgment call, not a word-overlap score - models
paraphrase, and a paraphrase that fails a lexical match would hide real recurrence.
Identity is judged twice: the quote-anchored analysis turn cites an existing gap id when
it sees a gap already on the books, and, when at least two open entries exist, one bounded
consolidation call sees the full open gap set and merges entries that describe the same
mistake. That second judgment is what lets two sightings of a brand-new gap in the same
run's parallel fan-out corroborate. A failed consolidation call degrades the run to
lexical identity and says so; it never aborts. All sightings cluster before their domain
is decided. Each sighting votes `project` or `orchestration`; only a majority-orchestration
cluster is excluded from synthesis, while a tie stays eligible. Mixed clusters are always
reported with their orchestration count, even below the evidence floor. A corroborated
majority-excluded cluster, including a pure-orchestration cluster, remains clearly labeled
as a report-only diagnostic rather than becoming an instruction in the project's memory
file; an uncorroborated pure-orchestration singleton stays hidden.

Only evidence with the current transcript, memory-surface, and analysis-index cache key,
stamped with one of the two interaction categories, and belonging to this run's selected
sample is folded into a proposal. A transcript that fell outside the time window or
`maxTranscripts` cap, disappeared, or still has legacy evidence can leave an evidence file
on disk. That file is left untouched, but it does not count toward this run's session total
or instruction scores, or add a gap observation, until ordinary discovery and analysis
select and refresh it.

Gap sightings persist across runs in `.backpass/gap-ledger.json` by gap and session, but a
run only counts observations whose sessions belong to its selected sample. This prevents
older observations outside the cap from undoing the sample mix while still allowing
corroboration across runs when those sessions remain selected. The same session never counts
twice, a sighting retires once the memory file or a project skill covers it, and a session's
sightings expire after `gapLedgerMaxAge` (default 90d). Until a gap corroborates it stays out
of the proposal entirely.

### 5. Gradient descent - native edits

A high-reasoning synthesis run turns the aggregated gradients into concrete edits: ADD,
REMOVE, REWRITE, EXTRACT→SKILL, or MOVE. The agent does not describe edits for backpass to
splice in - it makes them, with its harness's own file tools, in a **staging copy** of the
memory file and project skills under `.backpass/synthesis/` (the repo itself is read-only
to it, for grounding). backpass then diffs the copy against the original and shows the agent the
measured changes by id; the agent annotates each one with a title, rationale, and the
verbatim evidence behind it. Nothing textual is ever taken from the model: every hunk's
text is copied out of your file by construction, so an edit can never "not appear" in it.
Then mechanical gates run, and they are not negotiable:

- at most `maxEditsPerRun` edits (the learning rate). By default the cap is adaptive: 5
  when the always-loaded surface is near or under budget, and in a shrink plan (surface
  over budget) one edit per ~40 tokens of overage, capped at 20, so badly overgrown
  surfaces recover in fewer runs.
  An explicit `--max-edits` or config value always pins it.
- every measured change belongs to exactly one annotated edit - an unexplained change
  is a violation, so is an edit that names no change
- every edit that changes the always-loaded surface - adding, rewriting or removing text -
  needs quotes from `minGapEvidence` distinct sessions. The count is measured from the
  edit's own quote sources; a session count the model reports is ignored. Rewrites are not
  classified by shape: a one-session tightening is refused along with a one-session
  append, because deciding which is which is a question about meaning that a line diff
  cannot answer. `extract` and `move` are exempt - they keep every always-loaded line.
- removing a memory-file instruction outright needs harm-class negatives from
  `minGapEvidence` distinct sessions - non-compliance never counts, because a rule that
  was skipped needs reinforcement, not deletion. A pure deletion in a skill file is also
  a removal, but no evidence can attribute harm to skill-file text, so it is refused.
- an extraction preserves every line it removes in the skills it creates or extends, and
  an existing skill must still contain every line it already had; a deletion is never part
  of an extract
- a move's normalized removed and added line multisets match exactly, so it repositions
  text one-for-one without smuggling additions or triggering the harm floor
- every edit carries a verbatim quote
- the post-edit always-loaded surface must fit the budget, measured from the staged files

An extraction is the `SKILL.md` (created, or an existing skill file that still carries
every prior line plus the extracted ones) plus the memory-file change that pays for it.
Neighbouring removals are merged into one measured change, and a merged change cannot be
accepted in halves - so when several sections leave together, their skills arrive as one
extract with several skills, which is one honest accept/reject decision. Skills whose
removals were measured separately stay separate decisions, and bundling them is refused.
The measurement splits a contiguous removal at an extraction-vs-deletion boundary when
both resulting changes can be anchored safely, so accepting the extraction does not
silently accept the deletion beside it. If either change cannot be anchored uniquely, it
keeps the merged change rather than guessing.

A malformed answer or gate violation triggers a re-prompt naming the exact breach (at
most two). If those also fail, backpass **fails loudly** and preserves the latest parseable
rejected proposal, if one was produced. It never silently truncates. A harness that writes
past the staging copy into the repo is an error, never an apply.

Not every annotate turn is an answer, and the three cases are kept apart because they call
for different things:

- **the agent edited the copy again** - the ids it was given no longer describe the files.
  It is shown the fresh measurement and answers again; this costs no re-prompt.
- **the turn came back empty** - the harness returned success with no text at all. Nothing
  was said, so there is nothing to correct: the annotation is retried once in a **new**
  session, since the accumulated context of the old one is the likeliest cause.
- **the turn returned text** - malformed JSON or a gate violation uses an annotation
  attempt and can trigger a re-prompt. Only a parseable, gate-rejected answer writes a
  rejected proposal, stamped with the attempt that produced it.

When a run does fail, the advice it prints comes from the condition it ended on. If the
rejected proposal included notes, the failure prints those too instead of hiding useful
diagnostic context. Run `backpass propose` again to start a fresh synthesis.

Token deltas shown to you are measured by backpass from the actual text - never taken from
the model's own arithmetic.

### 6. The budget - "model size"

Every always-loaded token is paid on every future session, forever, and instruction
following dilutes as the file grows. So the budget is the constraint the whole backward
pass optimizes under.

**Default: 5,000 estimated tokens (~20KB)** for the always-loaded surface, configurable.
The estimator is bytes/4 - harness-neutral, ±15%.

The gated number is the **memory file plus every skill's `description:` line** - that is
what an agent actually pays on every session. Skill bodies stay free until triggered and
never compete for this budget. (A repo that already carries many skills may find itself
over budget with no file having changed when upgrading to this accounting - that is the
one-time re-tune of `budgetTokens`, not a regression.)

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
not duplicate content. Failed triggers are counted, not guessed: the analysis stage sees
every skill's name and trigger line, stamps a gap it judges covered by an existing skill
with `coveredBySkill`, and the gap ledger corroborates those citations across sessions
before synthesis is told to fix the trigger. The same coverage check retires a ledger gap
once a skill's content answers it, so a gap resolved by extraction stops resurfacing.

Skills are protected by the same floors as the memory file: text deleted from a skill
file is a removal, and since no evidence can attribute to skill text, no deletion there
clears the harm floor - skill content is rewritten or extracted, never quietly dropped.
Every skill file a proposal edits is fingerprinted, and an apply refuses a skill that
changed since the proposal measured it, exactly as it refuses a drifted memory file.

### 8. Apply - the human gate

`backpass apply` is the only command that writes. It serves a review surface through
[`lavish-axi`](https://github.com/kunchenguid/lavish-axi): one card per edit with the diff,
the evidence quotes and their sources, a live budget gauge, and ACCEPT / REJECT. Above them
one funnel band runs from every finding the analysis recorded down to the edits proposed.
Blue and amber lanes distinguish existing-instruction work from missing-instruction work;
the final row counts edits by their measured shape, while the earlier rows count findings
or candidates. Each drop between two rows is named in plain words. Older proposals without
the recorded funnel counts fall back to a stat row.

The surface is a static template shipped in the package - the CLI injects one JSON payload,
so it is instant, deterministic, and identical every run. Nothing there is model-generated.
It opens in your default browser when one is available; the URL is always printed too, so
a headless box or `--no-open` just hands you the link.

There is no DEFER button, and it isn't missing: **rejections are remembered.** A rejected
edit is not proposed again unless materially new evidence arrives.

The live budget gauge is not just a readout. Apply rechecks the accepted subset against
the same budget gate as synthesis: stay under the cap, or shrink if the file is already
over. An incompatible set writes nothing and does not record rejections, so you can pick
a compatible set and try again. If the run shrinks the file but leaves it above the cap,
that is progress, not a failure: it is written, and the remaining overage is printed.

Apply preflights every decided edit before writing. The proposal was measured against exact
versions of your memory file and every skill file it proposes editing, so apply first checks
those files still exist and are still those versions. If one was removed or changed since - you pulled, edited it by hand, or another
agent did - the edits no longer describe what is on disk, so nothing is written and you are
told to run `backpass` again to re-propose against the current repository. That rerun reanalyzes
transcripts against the file that exists now; it does not reuse the stale judgments behind
the refused proposal. Within a run every file is composed from one version: it takes every
accepted edit or none of them. Apply also
refuses the whole write if any created skill target already exists or two accepted paths
resolve to the same file.

Skills and non-memory files are written only after every edit has composed, with the memory
file committed last. A later write failure rolls back files, skills, and loading-layout
entries created earlier in that round. If another process changes a committed file before
rollback reaches it, apply leaves that change untouched and reports the rollback conflict.

For compatibility, proposals created by older backpass versions that do not contain a
memory-file hash skip the freshness check. Regenerate such a proposal before applying it if
the repository may have changed.

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
| `backpass status`  | cache state, failed transcripts, budget bars, and cross-surface overlaps                 |
| `backpass init`    | initialize the selected scope's config and state                                         |

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
because its adapter accepts sessions while logged out). A potentially transient busy-harness
miss retries once and is not cached; durable verdicts are cached in
`.backpass/agent-probe-cache.json` for 12h (30min for negatives). Pi and OpenCode entries
are re-probed when their credential or auth-file state changes; `--force` re-probes every
entry. The probe is a filter, not a promise: if the chosen harness answers `AUTH_REQUIRED`
or rejects the model mid-run, backpass falls through to the next candidate and says so.
When a whole ladder is exhausted the error lists every candidate with what to run to fix it.

Bare model ids are resolved against what each adapter advertises (`openai-codex/gpt-5.6-luna`
on pi, `openai/gpt-5.6-luna` on opencode, `gpt-5.6-luna` on codex), so nothing is hardcoded
per harness. When the same bare id is advertised under more than one provider, backpass
ranks by auth class - a subscription/OAuth provider over an API-key provider - from that
harness's provider definitions and auth file (see `src/provider-auth.js`). An unrankable
collision is refused with the colliding ids named; it is never an arbitrary pick. Ladders
are ordinary config - reorder or shorten them under `"ladders"`.

Pinning an agent skips its candidate ladder. A bare pinned model id is still resolved
against that harness's advertised models, including the same collision handling above.
If the pinned harness cannot resolve or serve it, backpass reports an actionable error and
keeps the pin rather than falling through or printing a raw stack:

```sh
backpass \
  --analysis-agent codex  --analysis-model gpt-5.5        --analysis-effort low \
  --synthesis-agent claude --synthesis-model claude-opus-5 --synthesis-effort high
```

`--no-auto-agent` pins the pre-ladder defaults (codex / claude). Model and effort
overrides are scoped to that Backpass invocation, so they never rewrite your harness
defaults. If an adapter has no proven overlay, backpass stops rather than pretending it
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
  "seed": null,
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
    "cloneRoots": [],
    "minUserTurns": 2
  },
  "jobs": 4
}
```

That example is the project scope. User scope ignores `.backpassrc.json` and instead
layers the `"user"` block in `$XDG_CONFIG_HOME/backpass/config.json` (default
`~/.config/backpass/config.json`) over its defaults. The user block can override the
regular settings; its path and user-only settings include `memoryFiles`, `skillsDir`,
`skillsDirs`, `minGapProjects` (default `1`), and these discovery controls:

```json
{
  "user": {
    "discovery": {
      "harnesses": ["claude", "codex"],
      "includeProjects": [],
      "excludeProjects": [],
      "maxTranscriptsPerProject": null
    }
  }
}
```

`includeProjects` and `excludeProjects` are globs matched against each project key and
session cwd. Repeated `--project <glob>` flags set the include globs for that
invocation. A non-null `maxTranscriptsPerProject` applies a sticky,
recency-weighted per-project cap before
`maxTranscripts` applies to the whole run.

### State

Project-scoped mutable state lives in `.backpass/`, kept out of git via the repo's local
exclude (`.git/info/exclude`, written by `backpass init`) rather than the tracked
`.gitignore`:

```
.backpass/
  scan-cache.json        collect-samples verdicts by path + mtime + size
  evidence/<identity>.json per-transcript loss
  evidence-summary.json  aggregated gradients
  proposal.json          the latest parseable gradient-descent step (absent if none was produced)
  synthesis/             the staging copy the gradient-descent agent edited (memory file + skills)
  prompts/               the exact prompts of the last run
  agent-probe-cache.json which harnesses were available and logged in, and when
  rejections.json        edits you turned down, and the evidence behind them
  gap-ledger.json        gap sightings by gap and session, accumulated across runs
  apply/apply.html       the rendered review surface
```

For the user-scope state location and isolation contract, see
[User-level memory](#user-level-memory).

## Limitations

- **Causal attribution is genuinely hard.** A model can confabulate influence. The
  mitigations are structural - mandatory verbatim quotes, the two-session rule, negative
  evidence weighted highest, and a human gate - but read the evidence, not just the title.
- **Transcript formats are undocumented** and can change without notice. Each adapter is
  pinned by a golden fixture and fails soft.
- **Cursor IDE is deferred to v1.1.** Its composer→workspace link is version-dependent;
  `--include-cursor-ide` enables a best-effort pass, but it is not a v1 guarantee.
- A project-scoped run never writes a user-level file. User-level edits are
  `--scope user` only (see [User-level memory](#user-level-memory)).
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
