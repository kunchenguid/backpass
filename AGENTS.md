# Project agent memory

backpass is an npm CLI that runs a "backward pass" over a repo's agent memory files: it
discovers past agent-session transcripts tied to the repo, analyzes them, and proposes
evidence-backed edits to `AGENTS.md` / `CLAUDE.md` under a token budget.

## Orientation

- `README.md` documents the user-facing surface; `src/cli.js` is the authoritative flag list.
- The pipeline is one stage per module, in order: `src/discovery/` -> `src/distill.js` ->
  `src/analyze.js` -> `src/fold.js` -> `src/synthesize.js` -> `src/proposal.js` -> `src/apply/`.
  Each module's header comment explains its role; read those before changing a stage.
- Zero runtime dependencies, ESM, no build step. Node >= 22.5 (for `node:sqlite`).
- pnpm is the package manager; `pnpm run check` runs lint, format:check, typecheck, and
  tests. All tests are offline and use fixtures under `test/fixtures/`. Supply-chain
  settings (release-age cooldown, build-script deny) live in `pnpm-workspace.yaml`.
- Releases are automated by release-please (`.github/workflows/release-please.yml`,
  npm trusted publishing). Never hand-edit `CHANGELOG.md` or
  `.release-please-manifest.json`; CI guards reject PRs that touch them.

## Sharp edges

- **Transcript formats are undocumented and drift.** Every adapter in
  `src/discovery/adapters/` is pinned by a golden fixture in `test/fixtures/`. When a
  harness changes its on-disk shape, fix the adapter and update its fixture together.
  Adapters must stay fail-soft: an unreadable store warns and is skipped, never throws.
- **The live progress view is an enhancement layer, never a dependency.** Pipeline stages
  emit events through `src/progress.js`; `src/tui/` renders them on stderr during the
  default run and buffers/replays the plain logger lines on teardown. Every path must
  behave identically when it is inactive (non-TTY, CI, NO_COLOR, --quiet, --json) - plain
  line output on stderr and clean stdout are the contract. Rendering logic stays pure
  (`src/tui/render.js`) so it is testable as text.
- **`src/apply/writer.js` is the only module that writes to the repo.** Keep it that way -
  every other stage is read-only analysis, which is what makes a run safe to interrupt.
- **Never trust model-reported numbers.** Token deltas and budget projections are measured
  in `src/proposal.js` from the actual text; the synthesis model's own figures are ignored.
- **acpx is alpha.** All model invocation is isolated behind `src/acpx.js` so an upstream
  CLI change has one blast radius. v1 uses plain `exec` and named sessions only; acpx flows
  are deferred until they are stable upstream.
- Cursor IDE support is deliberately deferred to v1.1 (`--include-cursor-ide`, best effort);
  see the header of `src/discovery/adapters/cursor-ide.js` for why.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
