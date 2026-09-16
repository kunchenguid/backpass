# backpass 0.1.22 — findings from a real run

Untracked note, safe to delete. Written after a full `backpass` /
`backpass propose` / `backpass apply` cycle against a large repo
(`~/Projects/machtfit-oscar`, AGENTS.md 5,539 tok over a 5,000 budget,
386 transcripts, 17 pre-existing skills under `.claude/skills/`).

Six defects, grouped. Each one is reproducible from state still on disk
under `~/Projects/machtfit-oscar/.backpass/`; the applied result is
committed on the worktree `~/Projects/oscar-agents-extract`
(branch `docs-extract-rules-to-skills`, commit `77212662288`), so the
before/after is a plain `git show`.

---

## A. `apply` writes the wrong files in the wrong place

### A1 — `--skills-dir` is silently ignored by `apply`

`backpass apply --skills-dir .claude/skills` wrote all 14 skills to
`.agents/skills/` regardless. Every `path` in `.backpass/proposal.json`
is `.agents/skills/<name>/SKILL.md`, baked in by the earlier `propose`
run, and `apply` appears to write those paths verbatim.

Nothing reported the conflict. The one warning printed is about the
symlink, so the flag reads as accepted.

Expected: `apply` re-maps the skill root, or refuses when `--skills-dir`
disagrees with the proposal it is applying.

**The warning's suggested fix is destructive.** It says:

> `.claude/skills` is a real directory, not a symlink to `../.agents/skills`
> — Claude will not see skills written to `.agents/skills` until you merge
> it in and replace it with the symlink (`ln -s ../.agents/skills .claude/skills`).

Following that literally replaces a directory holding 17 skills, only 9
of which backpass wrote, with a symlink to a directory holding 14. The
other 8 skills disappear. The wording ("merge it in and") gestures at the
problem, but the command it hands over does not do it.

### A2 — `apply` rewrites the frontmatter of skills it extends

On the three extended skills that carried `allowed-tools`, apply **dropped
that key** and added `user-invocable: false` plus `metadata: internal: true`:

| skill            | before                                         | after                         |
| ---------------- | ---------------------------------------------- | ----------------------------- |
| `commit`         | `allowed-tools: Read, Bash`                    | `user-invocable: false`       |
| `pre-pr`         | `allowed-tools: Read, Grep, Glob, Bash, Agent` | `user-invocable: false`       |
| `worktree-setup` | `allowed-tools: Read, Bash`                    | `user-invocable: false`       |
| `spa-migration`  | (neither key)                                  | `user-invocable: false` added |

Both halves are wrong. Dropping `allowed-tools` widens a skill's tool
grant. Adding `user-invocable: false` disables the slash command that the
skill's own untouched description tells the user to type — `commit`'s
description reads _"Trigger … when the user says 'commit this'"_.

Expected: preserve every pre-existing frontmatter key when extending a
skill, and set `user-invocable` only on a skill backpass creates.

---

## B. The `extract` gate accepts a proposal that loses what it moves

### B1 — a moved _trigger_ satisfies a line-preservation gate

The gate requires an `extract` to carry every removed line into the skill.
A removed line that is itself the trigger passes while losing its function:
the always-loaded reminder becomes reachable only _after_ the skill fires,
and the skill's own `description` silently becomes the sole trigger.

`url-inventory/SKILL.md` is the clean case. Its entire body is the line
that was removed from AGENTS.md:

> After URL changes: `make dev-update-urls-txt` — CI breaks if missing. …
> `make check` skips this check — only CI runs it — so a missing regen
> passes locally and fails in CI.

Four CI-breaking gates were extracted this way (urls.txt, golden manifest,
frontend-audit inventory, translation catalogs), plus the force-push gate.

The same shape produces circular files: `commit/SKILL.md` now ends with
_"invoke the `commit` skill before writing any commit message"_, and
`spa-migration/SKILL.md` with _"Invoke the `spa-migration` skill …"_.

Worth considering: detect a removed line that names the skill it is moving
into, or that reads as an unconditional trigger, and either leave a
one-line pointer in the memory file or refuse that extraction. A
self-referential line is a cheap syntactic signal.

---

## C. Diagnostics point away from the cause

Context for C1–C3: pi's `openai-codex` provider held a stale OAuth
credential. Every request threw `Failed to extract accountId from token`
(`pi-ai/dist/auth/oauth/openai-codex.js`, `credentialsFromToken`) and pi
then **exited 0 with no output**. Refreshing that credential through pi's
own provider check fixed everything.

### C1 — the empty-output hint rules out the actual fix

`src/agents.js:271` — _"'empty-output' is never fixed by logging in - see
`assertNonEmptyOutput` in acpx.js"_ — and the user-facing hint follows it.
Here re-authenticating was exactly the fix, so the hint sent me looking at
budgets and models first.

The harness's own stderr carried the answer and backpass already captures
it (`AcpxError.stderr`). Surfacing one line of it on an empty-output
verdict would have ended the investigation immediately.

### C2 — a stale `ok` probe pins one stage to a dead provider

`ok` verdicts cache 12h, `empty-output` ~30min. In
`.backpass/agent-probe-cache.json`:

- `pi|gpt-5.6-luna` — re-probed 09:10, `empty-output`, so **analysis fell
  through the ladder to codex and the run worked**.
- `pi|gpt-5.6-sol` — cached `ok` from 08:00, so **synthesis stayed pinned
  to the same dead provider** and the run died.

One run, one broken provider, two different outcomes decided by cache age.
A stage that hits a real empty-output failure should invalidate that
candidate's cached `ok` and re-enter selection rather than terminate.

### C3 — an empty _edit_ turn is reported as an annotation failure

The terminal message was:

> no proposal was saved: no annotation turn produced one
> … the synthesis harness returned no text, so nothing about the model,
> the budget, or the edit cap was the constraint

All true, and all about the annotate stage. The actual event was upstream:
the **edit** turn produced nothing, `.backpass/synthesis/AGENTS.md` was
byte-identical to the original, and `.backpass/prompts/synthesis-annotate-1.md`
opens with _"(no changes - the staging copy is identical to the original)"_.

Naming that — "the edit turn made no changes" — costs one condition and
points at the right stage.

---

## Repro state on disk

- `~/Projects/machtfit-oscar/.backpass/proposal.json` — 9 accepted edits,
  every skill path under `.agents/skills/`
- `~/Projects/machtfit-oscar/.backpass/agent-probe-cache.json` — the split
  verdicts in C2
- `~/Projects/machtfit-oscar/.backpass/prompts/synthesis-annotate-1.md` —
  the empty-edit-turn prompt from C3
- `~/Projects/oscar-agents-extract` @ `77212662288` — the applied result,
  after A1 and A2 were repaired by hand
