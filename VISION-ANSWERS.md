# Vision review: recorded answers

Durable calibration material for `VISION.md`.
Each hypothetical was put to the author on a `/vision` review board; the verdict and reasoning below are his, recorded verbatim.
Keep this file next to the vision: it is the record of why the vision says what it says, and the first place to look when a future change argues one of these calls should go the other way.

Board: `/vision` review, 12 hypotheticals, from-scratch draft r1 (2026-08-23).
Evidence base: the 20 merged pull requests authored by the repo owner in `kunchenguid/backpass` (#1 through #26), the open issues #23, #24 and #25, community pull request #21, and the module header comments those changes left behind.

## H-1 - Pool the gap ledger across a team

**Proposal.** Issue #24 proposes sharding the gap ledger into git (`gap-ledger.d/<dev>.json`) so corroboration pools across a team. The union is provably safe; the requester declines to decide the privacy fork: commit colleagues' verbatim quotes into repo history, or a counting-only mode that drops `quote`.

**Principle tested.** "It reads the machine it is on and owns nothing else."

**Why it was not obvious.** For: two people hitting one gap independently is the strongest evidence there is, and the per-machine ledger makes exactly that case invisible. Against: `redact.js` calls itself a coarse net, so this commits a colleague's raw session text with no per-quote review, and the safe variant leaves an unreviewable count.

**Verdict.** _pending_

## H-2 - Close the bootstrap exception

**Proposal.** A repo with no memory file gets the starter files created, and that run's first model-authored proposal is written directly, stamped `appliedBy: bootstrap`. Proposal: create the files, then stop, leaving the proposal for `backpass apply`. PR #6 raised this as an open call for you and it was never settled.

**Principle tested.** "The single write that skips the gate is creating a memory file where none existed."

**Why it was not obvious.** For: the ungated write is not the file creation, it is a model-authored instruction landing unreviewed, the exact class of write everything else refuses. Against: a file that did not exist a second ago has nothing to protect, `git diff` reviews it completely, and a review panel on an empty repo makes the first run a chore.

**Verdict.** _pending_

## H-3 - An unattended apply for trusted repos

**Proposal.** A user runs backpass nightly in their own CI on their own repo and asks for `backpass apply --yes`, off by default, accepting every edit that clears the mechanical gates and was not previously rejected. The gates already encode the policy, they argue.

**Principle tested.** "Automation may prepare a change and argue for it, but it does not land the change on the human's behalf."

**Why it was not obvious.** For: the gates are mechanical and already run, and someone approving their fiftieth identical edit is rubber-stamping; refusing fails the people running the most sessions. Against: the gates check form, not truth, and the human gate is the only step asking whether an instruction is right for this repo.

**Verdict.** _pending_

## H-4 - A whole-file rewrite mode

**Proposal.** For a file several times over budget, offer one whole-file rewrite reviewed as a single diff instead of many runs of up-to-20 edits. The adaptive shrink cap in PR #11 already concedes a fixed learning rate cannot recover the worst files.

**Principle tested.** "It does not rewrite a memory file and will not offer to."

**Why it was not obvious.** For: reviewing twenty edits across five sittings is a worse experience and a worse outcome than one careful pass over a document you wrote yourself. Against: a rewrite collapses review to all-or-nothing, rejection memory is keyed to a hunk and evaporates, and nothing then stops a confident model from dropping a load-bearing instruction.

**Verdict.** _pending_

## H-5 - A Copilot adapter over summaries

**Proposal.** Issue #25 asks for a `copilot.js` adapter. Copilot CLI keeps checkpoint markdown summaries under `~/.copilot/session-state/`, with no confirmed cwd index and no turn-level log, so the adapter would associate at tier 3 and distill model-written summaries as the trace.

**Principle tested.** "Every claim a model makes carries a verbatim quote copied from the trace."

**Why it was not obvious.** For: those users are told there are no transcripts today, and tier 3 exists precisely for weak association and is already labelled. Against: a checkpoint summary is a model's account of a session, so quoting it verbatim yields a verbatim quote of a paraphrase, passing the gate while defeating it.

**Verdict.** _pending_

## H-6 - Deterministic evidence, no quote

**Proposal.** Allow one class of quoteless evidence: facts backpass extracts itself with no model involved, such as the same failing command appearing in six sessions. They are stronger than a model-chosen quote precisely because no model produced them, yet they carry no `quote` field and are discarded today.

**Principle tested.** "A claim without one is discarded rather than softened."

**Why it was not obvious.** For: the quote rule exists to stop a model confabulating influence, so applying it to a measured fact enforces the letter against its own purpose and throws away the pipeline's most trustworthy evidence. Against: the rule's power is that it is absolute and needs no adjudication; every future exception arrives argued as deterministic too.

**Verdict.** _pending_

## H-7 - Model-described edits as a fallback

**Proposal.** Some harnesses cannot write through acpx: PR #17 hit this with codex when `features.code_mode_host` is false, and it replied DONE having changed nothing. Proposal: when synthesis produces no measured change, ask the model for `find`/`replace` text and locate it in the raw file.

**Principle tested.** "backpass measures what changed instead of accepting text the model describes."

**Why it was not obvious.** For: those users get an empty run with no explanation of why their harness is second-class, and a fallback that fails closed when the text is not found beats nothing. Against: PR #17 exists because model-supplied find text was structurally broken; re-adding it as a fallback re-opens that failure on the harnesses least likely to be exercised.

**Verdict.** _pending_

## H-8 - Edit global memory across repos

**Proposal.** backpass already sees sessions across every repo on the machine. A gap corroborating in five different repos is by definition not repo-specific, and `~/.claude/CLAUDE.md` is loaded in every session everywhere. Proposal: propose edits there when a gap clears the bar across N repos.

**Principle tested.** "It does not edit global memory, which is context to read and never a target to write."

**Why it was not obvious.** For: the always-loaded-token argument applies harder there than to any repo file, so refusing means watching the most expensive file on the machine degrade. Against: a global file has no repo to scope evidence to and no owner in the sense the design assumes, and one wrong instruction pollutes every project at once.

**Verdict.** _pending_

## H-9 - Make --strict the default

**Proposal.** Tier 3 matches a dead path whose last segment is the repo's directory name, or a user glob, and it is on by default. Proposal: default to deterministic tier-1 and tier-2 matches only, and move best-effort association behind an opt-in flag.

**Principle tested.** "An association that cannot be made deterministically is labelled best-effort, never presented as a match."

**Why it was not obvious.** For: a directory-name match can attribute another repo's sessions to yours, and against a two-session bar one wrong attribution is half the evidence needed to write a permanent instruction. Against: worktrees here are deleted constantly, so tier 3 is often the only thing that finds anything at all.

**Verdict.** _pending_

## H-10 - Refuse traces we cannot fully redact

**Proposal.** Harden the boundary: before a distilled trace goes to a model, refuse the transcript if it holds a high-entropy string redaction could not classify. `redact.js` describes itself as a coarse net and not a guarantee, and the failure mode is a real secret reaching a third-party model.

**Principle tested.** "They leave the machine only into an agent the user already authenticated."

**Why it was not obvious.** For: the module admits the net is coarse, a miss is irreversible, and a tool reading raw shell transcripts should fail closed on what it cannot afford to get wrong. Against: hashes, UUIDs and minified output would refuse most real sessions, and the predictable response is to disable redaction entirely.

**Verdict.** _pending_

## H-11 - Explain an empty run

**Proposal.** Issue #23 is a user who got nothing back and could not tell whether the tool was broken. The diagnosis behind PR #15 was 35 gaps folding to 0 clusters. Proposal: report uncorroborated singletons as counts in `backpass status`, never as proposals, so an empty run becomes legible.

**Principle tested.** "An uncorroborated gap is not surfaced as a hint, a watchlist, or a maybe."

**Why it was not obvious.** For: a count is not a proposal, and a user staring at zero edits cannot distinguish a healthy file from a broken adapter or an auth failure. Against: shown versus proposed does not survive contact with a person reading it, and the list becomes a to-do list that reintroduces one-session rewrites by hand.

**Verdict.** _pending_

## H-12 - Merge the community omp adapter

**Proposal.** PR #21 adds an `omp.js` adapter for oh-my-pi, a pi fork sharing pi's format. It is a near-copy of `pi.js` differing in store root and one field name, verified against roughly 800 real sessions, and it ships with no golden fixture. The alternative is a store-root parameter on the pi adapter.

**Principle tested.** "Supporting a harness means a pinned fixture and a fail-soft adapter."

**Why it was not obvious.** For: real verified demand from outside the fleet, and turning away a working adapter over its shape discourages the contributions an open harness-neutral tool depends on. Against: drifting formats are the project's sharpest edge, so a fixture-less near-duplicate doubles maintenance while parameterizing pi's store root covers the next fork free.

**Verdict.** _pending_
