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

**Verdict.** In vision

**Author's reasoning.** (recorded with no reasoning note; clarified by the annotation on the locality heading: "i may actually relax this in the future. it's possible that a person works across a number of machines, or a team wants to use this to aggregate the whole team's memory. that does NOT conflict with my vision")

**Folded in as.** Section renamed from "It reads the machine it is on and owns nothing else" to "It reads what you already have and owns nothing", and two lines added: "One machine is the default, not the limit: pooling corroboration across a person's machines, or across a team, is a change of scale and not a change of kind" and "What may be shared is the derived evidence, carried by infrastructure the user already owns, never a transcript and never through anything backpass runs." The resist test still refuses holding a copy of someone else's transcripts. OPEN: the privacy fork in issue #24 (share quotes vs counting-only) was not ruled on and is deliberately left undecided.

## H-2 - Close the bootstrap exception

**Proposal.** A repo with no memory file gets the starter files created, and that run's first model-authored proposal is written directly, stamped `appliedBy: bootstrap`. Proposal: create the files, then stop, leaving the proposal for `backpass apply`. PR #6 raised this as an open call for you and it was never settled.

**Principle tested.** "The single write that skips the gate is creating a memory file where none existed."

**Why it was not obvious.** For: the ungated write is not the file creation, it is a model-authored instruction landing unreviewed, the exact class of write everything else refuses. Against: a file that did not exist a second ago has nothing to protect, `git diff` reviews it completely, and a review panel on an empty repo makes the first run a chore.

**Verdict.** In vision

**Folded in as.** "The human owns the weights" now reads "Nothing reaches the memory file except through that gate, including the first proposal in a repo that had no memory file", and the old asterisk becomes "Creating a starter file where none existed is the one write that is not an edit, and it only ever creates, never overwrites." This makes today's bootstrap behaviour, which applies its first proposal directly, a deviation to fix.

## H-3 - An unattended apply for trusted repos

**Proposal.** A user runs backpass nightly in their own CI on their own repo and asks for `backpass apply --yes`, off by default, accepting every edit that clears the mechanical gates and was not previously rejected. The gates already encode the policy, they argue.

**Principle tested.** "Automation may prepare a change and argue for it, but it does not land the change on the human's behalf."

**Why it was not obvious.** For: the gates are mechanical and already run, and someone approving their fiftieth identical edit is rubber-stamping; refusing fails the people running the most sessions. Against: the gates check form, not truth, and the human gate is the only step asking whether an instruction is right for this repo.

**Verdict.** In vision

**Author's reasoning.** if it's opt-in only, that's fine, because that's basically still the human in control of how they would like this to operate

**Folded in as.** Replaced "Automation may prepare a change and argue for it, but it does not land the change on the human's behalf" with a default-plus-opt-in pair: "By default every edit is reviewed on its own..." and "A user may opt in to something looser for their own repo, because choosing how their own weights get updated is the human in control, but that is an explicit choice and never a default." The resist test changed from "without a per-edit human decision" to "makes anything but per-edit review the default."

## H-4 - A whole-file rewrite mode

**Proposal.** For a file several times over budget, offer one whole-file rewrite reviewed as a single diff instead of many runs of up-to-20 edits. The adaptive shrink cap in PR #11 already concedes a fixed learning rate cannot recover the worst files.

**Principle tested.** "It does not rewrite a memory file and will not offer to."

**Why it was not obvious.** For: reviewing twenty edits across five sittings is a worse experience and a worse outcome than one careful pass over a document you wrote yourself. Against: a rewrite collapses review to all-or-nothing, rejection memory is keyed to a hunk and evaporates, and nothing then stops a confident model from dropping a load-bearing instruction.

**Verdict.** Off mission

**Author's reasoning.** rewrite is not gradient descent

**Folded in as.** Your reasoning became the budget section's line: "A rewrite is not a gradient step, so the cap grows with a bad file and never turns into starting over." The Scope non-goal is unchanged.

## H-5 - A Copilot adapter over summaries

**Proposal.** Issue #25 asks for a `copilot.js` adapter. Copilot CLI keeps checkpoint markdown summaries under `~/.copilot/session-state/`, with no confirmed cwd index and no turn-level log, so the adapter would associate at tier 3 and distill model-written summaries as the trace.

**Principle tested.** "Every claim a model makes carries a verbatim quote copied from the trace."

**Why it was not obvious.** For: those users are told there are no transcripts today, and tier 3 exists precisely for weak association and is already labelled. Against: a checkpoint summary is a model's account of a session, so quoting it verbatim yields a verbatim quote of a paraphrase, passing the gate while defeating it.

**Verdict.** Off mission

**Author's reasoning.** for this to work reliably and consistently, transcripts are must-have

**Folded in as.** New harness-qualification line: "A harness qualifies when it records real session transcripts, because a store holding only a model's summary of a session is not evidence."

## H-6 - Deterministic evidence, no quote

**Proposal.** Allow one class of quoteless evidence: facts backpass extracts itself with no model involved, such as the same failing command appearing in six sessions. They are stronger than a model-chosen quote precisely because no model produced them, yet they carry no `quote` field and are discarded today.

**Principle tested.** "A claim without one is discarded rather than softened."

**Why it was not obvious.** For: the quote rule exists to stop a model confabulating influence, so applying it to a measured fact enforces the letter against its own purpose and throws away the pipeline's most trustworthy evidence. Against: the rule's power is that it is absolute and needs no adjudication; every future exception arrives argued as deterministic too.

**Verdict.** Off mission

**Author's reasoning.** these errors can be noisy without some judgment applied

**Folded in as.** New line under "Evidence is the only currency": "A signal extracted mechanically, with no judgment applied to it, is noise until a quote anchors it to a real moment, so there is no quoteless path into the file."

## H-7 - Model-described edits as a fallback

**Proposal.** Some harnesses cannot write through acpx: PR #17 hit this with codex when `features.code_mode_host` is false, and it replied DONE having changed nothing. Proposal: when synthesis produces no measured change, ask the model for `find`/`replace` text and locate it in the raw file.

**Principle tested.** "backpass measures what changed instead of accepting text the model describes."

**Why it was not obvious.** For: those users get an empty run with no explanation of why their harness is second-class, and a fallback that fails closed when the text is not found beats nothing. Against: PR #17 exists because model-supplied find text was structurally broken; re-adding it as a fallback re-opens that failure on the harnesses least likely to be exercised.

**Verdict.** Off mission

**Author's reasoning.** these fallback behaviors can be a degradation. instead, we should try to get to a real solution

**Folded in as.** New line under "Failure is loud and named": "A gap in capability is fixed or reported, never papered over with a weaker path that quietly produces worse results", and a matching resist test: "...or trades a real fix for a quieter degraded path."

## H-8 - Edit global memory across repos

**Proposal.** backpass already sees sessions across every repo on the machine. A gap corroborating in five different repos is by definition not repo-specific, and `~/.claude/CLAUDE.md` is loaded in every session everywhere. Proposal: propose edits there when a gap clears the bar across N repos.

**Principle tested.** "It does not edit global memory, which is context to read and never a target to write."

**Why it was not obvious.** For: the always-loaded-token argument applies harder there than to any repo file, so refusing means watching the most expensive file on the machine degrade. Against: a global file has no repo to scope evidence to and no owner in the sense the design assumes, and one wrong instruction pollutes every project at once.

**Verdict.** Off mission

**Author's reasoning.** for now, my philosophy is that global memory should be handwritten by the user and only contains their preferences. all the learned knowledge is better put into project-level memory

**Folded in as.** The opener now carries the positive half of your reasoning: "a person's own ~/.claude/CLAUDE.md is handwritten preference, and anything learned belongs in project memory instead." The Scope non-goal was tightened to match.

## H-9 - Make --strict the default

**Proposal.** Tier 3 matches a dead path whose last segment is the repo's directory name, or a user glob, and it is on by default. Proposal: default to deterministic tier-1 and tier-2 matches only, and move best-effort association behind an opt-in flag.

**Principle tested.** "An association that cannot be made deterministically is labelled best-effort, never presented as a match."

**Why it was not obvious.** For: a directory-name match can attribute another repo's sessions to yours, and against a two-session bar one wrong attribution is half the evidence needed to write a permanent instruction. Against: worktrees here are deleted constantly, so tier 3 is often the only thing that finds anything at all.

**Verdict.** In vision

**Author's reasoning.** accuracy of the result is a priority, so this is aligned

**Folded in as.** Best-effort association is now stated as opt-in, not merely labelled: "...is labelled best-effort and stays opt-in, because a wrong attribution is worse evidence than none." Your priority became its own line, "When coverage and accuracy are in tension, accuracy wins", and a resist test, "...when it buys coverage with accuracy."

## H-10 - Refuse traces we cannot fully redact

**Proposal.** Harden the boundary: before a distilled trace goes to a model, refuse the transcript if it holds a high-entropy string redaction could not classify. `redact.js` describes itself as a coarse net and not a guarantee, and the failure mode is a real secret reaching a third-party model.

**Principle tested.** "They leave the machine only into an agent the user already authenticated."

**Why it was not obvious.** For: the module admits the net is coarse, a miss is irreversible, and a tool reading raw shell transcripts should fail closed on what it cannot afford to get wrong. Against: hashes, UUIDs and minified output would refuse most real sessions, and the predictable response is to disable redaction entirely.

**Verdict.** Conditional

**Author's reasoning.** if we enable this by default it may be too flaky and noisy. i think we would either warn the user and let them decide, or default off

**Folded in as.** Folded as the condition you set: "Redaction is a coarse net and says so, so a stricter check may warn or be offered but never blocks a run by default on a guess."

## H-11 - Explain an empty run

**Proposal.** Issue #23 is a user who got nothing back and could not tell whether the tool was broken. The diagnosis behind PR #15 was 35 gaps folding to 0 clusters. Proposal: report uncorroborated singletons as counts in `backpass status`, never as proposals, so an empty run becomes legible.

**Principle tested.** "An uncorroborated gap is not surfaced as a hint, a watchlist, or a maybe."

**Why it was not obvious.** For: a count is not a proposal, and a user staring at zero edits cannot distinguish a healthy file from a broken adapter or an auth failure. Against: shown versus proposed does not survive contact with a person reading it, and the list becomes a to-do list that reintroduces one-session rewrites by hand.

**Verdict.** In vision

**Author's reasoning.** better clarity to human users is definitely good

**Folded in as.** Reversed the draft's absolute. "An uncorroborated gap stays out of the proposal entirely, and is not surfaced as a hint, a watchlist, or a maybe" became "An uncorroborated gap never becomes a proposal, though counting one is fair where that helps a person understand a run", plus a new line under failure: "A run that proposes nothing explains why."

## H-12 - Merge the community omp adapter

**Proposal.** PR #21 adds an `omp.js` adapter for oh-my-pi, a pi fork sharing pi's format. It is a near-copy of `pi.js` differing in store root and one field name, verified against roughly 800 real sessions, and it ships with no golden fixture. The alternative is a store-root parameter on the pi adapter.

**Principle tested.** "Supporting a harness means a pinned fixture and a fail-soft adapter."

**Why it was not obvious.** For: real verified demand from outside the fleet, and turning away a working adapter over its shape discourages the contributions an open harness-neutral tool depends on. Against: drifting formats are the project's sharpest edge, so a fixture-less near-duplicate doubles maintenance while parameterizing pi's store root covers the next fork free.

**Verdict.** In vision

**Author's reasoning.** covering more harnesses is in vision, as long as it doesn't risk existing ones

**Folded in as.** New line with your constraint attached: "More harnesses is always welcome, provided a new one cannot destabilise the ones already working", kept next to the pinned-fixture and fail-soft requirement.
