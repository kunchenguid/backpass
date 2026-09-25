# Project agent memory

backpass is an npm CLI that runs a "backward pass" over a repo's agent memory files: it
discovers past agent-session transcripts tied to the repo, analyzes them, and proposes
evidence-backed edits to `AGENTS.md` / `CLAUDE.md` under a token budget.

## Orientation

- `VISION.md` is the acceptance policy; run its closing accept/resist test against `VISION.md` alone.
- `README.md` documents the user-facing surface and how each stage works; `src/cli.js` is the authoritative flag list.
- Pipeline, one stage per module: `src/discovery/` -> `src/sample.js` -> `src/distill.js` -> `src/analyze.js` ->
  `src/consolidate.js` + `src/fold.js` -> `src/synthesize.js` (`src/workspace.js`, `src/diff.js`) ->
  `src/proposal.js` -> `src/apply/`. Read a module's header comment before changing its stage.
- User-facing step names are training-loop terms (`STAGE_LABELS` in `src/tui/render.js`); internal keys and
  subcommands (`scan`, `analyze`, `propose`) keep short names. Never introduce a multi-word subcommand.
- Zero runtime dependencies, ESM, no build step, Node >= 22.5 (`node:sqlite`). pnpm; `pnpm run check` runs
  lint, format:check, typecheck, and offline tests (fixtures under `test/fixtures/`).
- Releases are release-please; never hand-edit `CHANGELOG.md` or `.release-please-manifest.json`.
- `.github/workflows/no-mistakes-required.yml` calls the upstream `require-no-mistakes` action pinned to a
  commit SHA (never `@main`); change enforcement upstream, bump the pin in a separate PR, and push through
  `git push no-mistakes` (see `CONTRIBUTING.md`).

## Hard invariants

Each owning file's comments and tests hold the detail; read them before touching the area.

- **Only `src/apply/writer.js` writes to the repo**; every other stage is read-only. Apply writes nothing unless
  every hash, budget, composition, skill-dir, and target gate passes, and each file lands whole or not at all.
  Bootstrap (`src/commands/bootstrap.js`) only ever creates files.
- **Synthesis edits a staging copy** (`.backpass/synthesis/`, `prepareWorkspace`). Never pass `approveAll` with
  the repo as `cwd`; staging and the fingerprint stay in step except `skillSearchPaths` skills are withheld
  but fingerprinted: a direct write fails `assertRepoUntouched` (`src/synthesize.js`). Keep that protection.
  The model never supplies `find` text; hunks are cut from the raw file (`anchoredHunks`).
- **Never trust model-reported numbers.** Token deltas, budgets, and session counts are measured in
  `src/proposal.js`; usage comes from acpx's stderr line or a harness store (`src/acpx.js`), printed only by
  `src/commands/usage.js`.
- **Evidence floors live in `buildProposal`** (`src/proposal.js`): every non-`extract`/`move` edit needs
  `minGapEvidence` distinct sessions from `summary.sources`; deletions need `harm`-class sessions; a pure
  deletion inside a skill file is refused. Extraction and deletion never share one decision. Never add a
  lexical or text-shape classifier to these gates, and non-compliance never counts as harm. The >= 20%
  relevance placement table (`src/prompts/synthesis.md`) stays prompt guidance, never a `buildProposal` gate.
- **Quotes must be found in the trace they cite** (`sanitizeEvidence` in `src/analyze.js`), so fake agents in
  tests must quote real session text. Bump `ANALYSIS_INDEX_VERSION` (`src/state.js`) for any change to what
  analysis accepts.
- **Sampling is deterministic and sticky** (`src/sample.js`): a per-transcript hash of `transcriptIdentity` and
  `config.seed`, never `Math.random()` or an index/position-derived draw.
- **Corpus mix is interactive vs non-interactive, never an unknown bucket** (`src/interaction.js`).
- **backpass must never analyze itself**: keep `SELF_SESSION_SENTINEL` (`src/prompts.js`) at the start of every
  model-facing prompt (`src/discovery/self.js` drops those sessions).
- **Gap evidence**: one ledger sighting per (gap, transcript) (`src/gap-ledger.js`); record before pruning;
  never surface uncorroborated singletons; gap identity is judged by the consolidation call, with bigram
  similarity only as fallback; there is no orchestrator-memory write path.
- **Fold uses only selected, fresh evidence** (`foldForRun` in `src/commands/propose.js`, `isEvidenceFresh`).
- **Presentation never gates**: the apply funnel counters and cross-surface duplicates (`src/overlap.js`) are
  report-only.
- **Scopes and targets**: user-scope state never enters `<repo>/.backpass/` and a project run never writes a
  user file (`src/scope.js`). `--target` accepts only an exact configured memory file or skill name
  (`src/target.js`), never a basename, directory, or glob.
- **SSH hosts** (`src/discovery/hosts.js`): `src/discovery/remote/ssh.js` is the only ssh spawn boundary; nothing
  installs remotely and the probe bundle must stay self-contained (`PROBE_MANIFEST`); `discovery.hosts` in a
  repo's `.backpassrc.json` is an error; host keys are never auto-accepted. Remote cache names are hashed
  (`src/discovery/cache.js`) and a short fetch is never analyzed as a whole session.
- **Adapters drift and must stay fail-soft**: fix an adapter and its golden fixture together
  (`src/discovery/adapters/`). Hermes ingests only `cli`/`acp` sessions (see its header).
- **Skills** (`src/skills.js`): a bare `skills/` dir is never auto-detected; writes never target
  `skillSearchPaths`; search-path and out-of-repo skills are withheld from staging (`src/workspace.js`).
- **Memory resolution is pointer-aware** (`resolveMemoryFiles` in `src/memory.js`); a second full file is warned
  about, never silently ignored or double-written.
- **Spawns**: a Windows shim refusal (`ERR_WINDOWS_SHIM_UNSAFE_ARG`, `src/subprocess.js`) must be raised by name
  before any generic result handling at every spawn boundary. All model calls go through `src/acpx.js`
  (acpx is alpha); only session creation gets the cold-start timeout, and `result.timedOut` is handled before
  generic exits.
- **Model and effort overrides are invocation-scoped** (`src/harness-invoke.js`): never ACP `set model` or Pi
  `set thought_level`, never edit-then-restore harness defaults.
- **Agent auto-pick is probe-then-verify** (`src/agents.js`, `AgentResolver.withFallthrough`); a timeout or bare
  exit is never cached as a negative probe. An ambiguous advertised model is ranked by auth class
  (`src/provider-auth.js`) or fails loudly, never guessed.
- **Lavish apply surface** (`src/apply/lavish.js`): parse URLs with `extractUrl`, and splice the payload with a
  function replacer, never a string one (untrusted text can contain `$&`).
- **The live TUI is an enhancement layer** (`src/tui/`): output must be identical with it inactive (non-TTY, CI,
  `NO_COLOR`, `--quiet`, `--json`), with clean stdout.
- Cursor IDE support is deferred; see the header of `src/discovery/adapters/cursor-ide.js`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
