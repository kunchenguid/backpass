# Project agent memory

backpass is an npm CLI that runs a "backward pass" over a repo's agent memory files: it
discovers past agent-session transcripts tied to the repo, analyzes them, and proposes
evidence-backed edits to `AGENTS.md` / `CLAUDE.md` under a token budget.

## Orientation

- `VISION.md` is the acceptance policy: what a change must be true to, and its closing
  accept/resist tests. `VISION-ANSWERS.md` records the hypotheticals the author ruled on and
  why, so a change that argues one of those calls should go the other way starts there.
- `README.md` documents the user-facing surface; `src/cli.js` is the authoritative flag list.
- The pipeline is one stage per module, in order: `src/discovery/` -> `src/sample.js` (cap) -> `src/distill.js` ->
  `src/analyze.js` -> `src/fold.js` -> `src/synthesize.js` (with `src/workspace.js` + `src/diff.js`) ->
  `src/proposal.js` -> `src/apply/`. Each module's header comment explains its role; read those
  before changing a stage.
- **User-facing step names are the training-loop terms**, not the module names: discover =
  "collect samples", analyze = "calculate loss", fold = "aggregate gradients", synthesize =
  "gradient descent" (`STAGE_LABELS` in `src/tui/render.js`). Internal keys, event names, and
  the typed subcommands (`scan`, `analyze`, `propose`) keep their short names; only what the
  user reads changes. Never introduce a multi-word subcommand.
- Zero runtime dependencies, ESM, no build step. Node >= 22.5 (for `node:sqlite`).
- pnpm is the package manager; `pnpm run check` runs lint, format:check, typecheck, and
  tests. All tests are offline and use fixtures under `test/fixtures/`. Supply-chain
  settings (release-age cooldown, build-script deny) live in `pnpm-workspace.yaml`.
- Releases are automated by release-please (`.github/workflows/release-please.yml`,
  npm trusted publishing). Never hand-edit `CHANGELOG.md` or
  `.release-please-manifest.json`; CI guards reject PRs that touch them.
- `.github/workflows/no-mistakes-required.yml` is a thin caller of the shared
  `kunchenguid/no-mistakes/.github/actions/require-no-mistakes` composite action, pinned
  to an immutable commit SHA and never `@main`. Enforcement logic and tests live upstream
  in the no-mistakes repository; change enforcement there, never by copying it locally,
  and bump the pin in a deliberate separate PR. This repo still owns the `on:`,
  `concurrency`, `permissions`, job name, and author-exemption `if:`. The action binds the
  attestation to the head SHA, so a PR whose body no-mistakes did not rewrite for the
  current head goes red by contract: push through `git push no-mistakes`.

## Sharp edges

- **Transcript formats are undocumented and drift.** File adapters in
  `src/discovery/adapters/` are pinned by golden fixtures in `test/fixtures/`; SQLite
  adapters (opencode, hermes) build tiny temp databases in tests. When a harness changes
  its on-disk shape, fix the adapter and its fixture/test together. Adapters must stay
  fail-soft: an unreadable store warns and is skipped, never throws.
- **Hermes is first-class but source-filtered.** `src/discovery/adapters/hermes.js` reads
  `~/.hermes/state.db` (`HERMES_HOME`). Only `cli` and `acp` sessions are ingested;
  gateway/cron rows share a process cwd and would pollute association. v26 stores CLI cwd
  on `sessions.cwd` (system_prompt is often NULL); ACP still uses `model_config.cwd`.
  Timestamps are epoch seconds and must be converted to ms. Message content is read as
  BLOB because node:sqlite truncates TEXT at the `\x00json:` NUL. There is no JSONL fallback.
- **The live progress view is an enhancement layer, never a dependency.** Pipeline stages
  emit events through `src/progress.js`; `src/tui/` renders them on stderr during the
  default run and buffers/replays the plain logger lines on teardown. Every path must
  behave identically when it is inactive (non-TTY, CI, NO_COLOR, --quiet, --json) - plain
  line output on stderr and clean stdout are the contract. Rendering logic stays pure
  (`src/tui/render.js`) so it is testable as text.
- **`src/apply/writer.js` is the only module that writes to the repo.** Keep it that way -
  every other stage is read-only analysis, which is what makes a run safe to interrupt.
  Bootstrap (`src/commands/bootstrap.js`, a repo with no memory file) is the one run that
  writes without the apply gate, and it only ever creates files, never overwrites.
  For proposals carrying a memory-file hash, nothing is written until five gates pass:
  the memory file still exists and hashes to `proposal.memoryFile.hash` (`memoryFileSnapshot`,
  using `memoryTextHash` from `src/memory.js` so the check and the proposal cannot disagree), the
  accepted subset clears `budgetGateKind` (`src/tokens.js`), every accepted edit for a file
  composes against that file's one pre-write image, and every created skill target is still
  absent. Any of them failing writes nothing and records no rejection. Accepted paths are
  resolved before mutation, and duplicate resolved targets refuse the whole apply. Each file
  is therefore applied whole or not at all. Skills and non-memory files land before the
  memory file; a later failure rolls back files, skills, and loading-layout entries created
  by the round. A rollback never overwrites a file whose identity or contents changed after
  this round committed it - that conflict is reported and the concurrent version is kept.
- **Synthesis edits natively, in a staging copy, never by describing text.** The agent
  gets `--approve-all` with `cwd` = `.backpass/synthesis/` (`prepareWorkspace`), which holds
  only the memory file and the skills dir; backpass measures the copy (`measureWorkspace`,
  `anchoredHunks`) and the agent annotates the measured changes by id, initially in the
  same session. The model never supplies `find` text - every hunk is cut from the raw
  file, widened until unique, so a hunk can only go stale by the file itself changing after
  the proposal, which apply refuses rather than part-applies. Never pass
  `approveAll` with the repo as `cwd`; the repo is fingerprinted and a harness that
  writes there fails the run loudly.
- **Annotate-loop outcomes stay distinct** (`annotateLoop` in `src/synthesize.js`): a
  moved staging tree is re-measured without spending an `ANNOTATE_TURNS` attempt (bounded
  by `REMEASURE_TURNS`); no adapter text is retried once in a new session; and only a
  non-empty answer spends an annotation attempt. Only a parseable, gate-rejected answer
  writes a rejected `proposal.json` during the loop, stamped with `attempt`.
  `ProposalViolation` carries `reason` and the `saved` proposal's own attempt/violations
  so a later empty turn is never reported as that proposal's author. A new synthesis clears
  the prior proposal before its first model
  call, so an empty-only failure cannot leave an older proposal applicable.
  `synthesisFailureHint` in `src/commands/propose.js` is
  where the advice for each terminal condition lives - never a blanket
  stronger-model/budget/max-edits line.
- **An extract is one measured memory change plus the skill(s) it pays for.** `anchoredHunks`
  merges adjacent removals, so extracting neighbouring sections yields one change and N
  created skills - one honest accept/reject decision, since a merged change cannot be
  half-accepted. `buildProposal` allows N skills only when they share ONE hunk; separately
  measured skills must stay separate edits. Edits carry `skills: []`; read them through
  `editSkills` (`src/skills.js`), which also understands the pre-0.1.8 single `skill`.
- **Skills only count if a harness loads them.** Extractions target `.agents/skills` with
  `.claude/skills -> ../.agents/skills` as a symlink (`ensureSkillsLayout` in
  `src/skills.js`, run at write time); a bare `skills/` dir is never auto-detected and a
  real `.claude/skills` directory is warned about, never replaced.
- **Memory resolution is pointer-aware** (`resolveMemoryFiles` in `src/memory.js`): the
  first configured file is canonical, a `@AGENTS.md`-only CLAUDE.md is a pointer, and a
  second full file is warned about, never silently ignored or double-written.
- **Never trust model-reported numbers.** Token deltas and budget projections are measured
  in `src/proposal.js` from the actual text; the synthesis model's own figures are ignored.
  Usage accounting comes from acpx's `[acpx] tokens:` stderr line, which acpx prints
  when the ACP adapter returns usage (codex, claude do; pi-acp does not), with one
  harness-store fallback: pi's per-turn usage is read back from its own session file,
  located by the prompt text (`recoverUsageFromStore` in `src/acpx.js`). Records are
  `{ agent, usage|null }` (`usageRecord` in `src/acpx.js`) and `src/commands/usage.js` is
  the one place that prints them - never `n/a`: nothing when no call ran, the harness by
  name when it stayed silent.
- **Fold and this-run gap-ledger ingest are scoped to the current memory-set hash.**
  `foldForRun` (`src/commands/propose.js`) filters `state.listEvidence()` by `memoryPath`
  AND `memoryHash === current set hash`, not path alone - a transcript that fell out of
  this run's sample (window, cap, or the transcript itself gone) can leave an evidence file
  on disk stamped with a stale hash, and it must not count toward `analyzedSessions`,
  per-instruction scores, or this run's gap-ledger observations (positional `AG-nnn`
  aliases can point at a different unit once the file changes). Folding does not migrate,
  rewrite, or delete stale evidence; an untouched evidence file becomes eligible again if
  the memory bytes return to its hash, while reanalysis replaces it with current evidence.
  `analyzeTranscripts` separately reports `summary.staleMemoryHash` and names the old/new
  hash on stderr, so a full reanalysis without `--force` after a memory edit reads as "the
  file changed," not as a
  broken cache - the cache-hit path itself (unchanged file, no `--force`) is unaffected.
- **Gap corroboration is counted across runs through `.backpass/gap-ledger.json`**
  (`src/gap-ledger.js`, wired in `foldForRun`): one sighting per (gap, transcript id), so a
  session never counts twice and a gap seen once per run still graduates at `minGapEvidence`.
  Record this run's evidence _before_ pruning - old evidence files stay on disk and would
  re-add an expired or covered sighting otherwise. Uncorroborated gaps stay hidden; never
  surface singletons to the prompt or report.
- **backpass must never analyze itself.** Its own acpx calls are filed by each harness
  under the repo's cwd, a tier-1 match. Every prompt starts with `SELF_SESSION_SENTINEL`
  (`src/prompts.js`) and discovery drops transcripts whose first user message begins with
  it (`src/discovery/self.js`) before sampling. Keep the sentinel on every model-facing
  prompt; the triviality filter is not a substitute.
- **acpx is alpha.** All model invocation is isolated behind `src/acpx.js` so an upstream
  CLI change has one blast radius. v1 uses plain `exec` and named sessions only; acpx flows
  are deferred until they are stable upstream. The one sanctioned exception is the
  per-harness native status table in `src/agents.js` (`claude auth status`, `opencode models`).
- **Model and effort overrides are invocation-scoped.** Never ACP `set model` / Pi
  `set thought_level` (those rewrite `~/.pi/agent/settings.json`) and never edit-then-restore
  harness defaults. `src/harness-invoke.js` owns the harness overlay mechanisms and
  `src/acpx.js` owns verification and fallback. An unproven overlay must stop rather than
  pretend; OpenCode effort alone is skipped with a report note. Preserve the current spawn
  when no override is requested.
- **Agent auto-pick is probe-then-verify, never probe-only.** `src/agents.js` walks each
  role's ladder with a zero-token probe, but the claude adapter cannot be pre-verified by
  acpx (sessions succeed while logged out), so every real call runs under
  `AgentResolver.withFallthrough`, which demotes a candidate on a classifiable failure
  (`classifyAcpxFailure`). Effortful calls go through `sessionPrompt` so the overlay in
  `src/harness-invoke.js` can apply. Verdicts cache in `.backpass/agent-probe-cache.json`.
- **The Lavish apply surface is chatty and its output is YAML-quoted.** `lavish-axi poll`
  can return feedback that is not a decision vector (a comment, a queued layout report) any
  number of times before the real one; `pollDecisions` in `src/apply/lavish.js` announces
  each wait state once and never per cycle. Session URLs are printed as `url: "http://..."`,
  so parse them with `extractUrl`, never a bare `\S+`. Browser launch is best effort
  (`src/apply/browser.js`): the printed URL is the contract. `test/fixtures/fake-lavish/`
  stands in for the CLI via `BACKPASS_LAVISH_BIN` in tests. `injectPayload` in
  `src/apply/lavish.js` must splice the templated `<script>` tag into `apply.html` with a
  function replacer, never a string one: a string second argument to `String.prototype.replace`
  interprets `$&`, `` $` ``, `$'`, and `$$` in it as replacement patterns, and the spliced
  text embeds untrusted proposal/evidence prose that can contain those sequences verbatim.
- Cursor IDE support is deliberately deferred to v1.1 (`--include-cursor-ide`, best effort);
  see the header of `src/discovery/adapters/cursor-ide.js` for why.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
