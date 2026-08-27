# Vision

`backpass` exists so that a repository's agent memory file improves from what actually happened in its agent sessions, instead of from whatever a human happened to remember.
It serves the developer who owns that file, whether it is `AGENTS.md` or the `CLAUDE.md` Claude Code reads in its place, and it turns transcripts already sitting on their disk into a small set of reviewable edits.
The project file is the one it trains; a person's own `~/.claude/CLAUDE.md` is handwritten preference, and anything learned belongs in project memory instead.
It owns exactly one thing: the backward pass from session transcripts to a proposed change in the memory file.

## Evidence is the only currency

Every claim a model makes carries a verbatim quote copied from the trace, and a claim without one is discarded rather than softened.
A signal extracted mechanically, with no judgment applied to it, is noise until a quote anchors it to a real moment, so there is no quoteless path into the file.
A visible violation outranks any number of "it went fine" observations, because negative evidence is what proves the file was steering anything at all.
A new instruction needs corroboration from at least two distinct sessions, and one session never counts twice however often it is re-analyzed.
Corroboration accumulates across runs in a ledger rather than resetting each run, so a gap seen today and again next week still graduates.
An uncorroborated gap never becomes a proposal, though counting one is fair where that helps a person understand a run.
One bad session never rewrites the weights, because a single session can go wrong for reasons that have nothing to do with the file.

## The human owns the weights

Every stage is read-only analysis and one module does all the writing, which is what makes a run safe to interrupt at any point.
By default every edit is reviewed on its own, with its diff and the quotes behind it, and accepted or rejected one at a time.
A rejection is remembered and never re-proposed until materially new evidence arrives, so review effort is not spent twice on the same answer.
Nothing reaches the memory file except through that gate, including the first proposal in a repo that had no memory file.
Creating a starter file where none existed is the one write that is not an edit, and it only ever creates, never overwrites.
A user may opt in to something looser for their own repo, because choosing how their own weights get updated is the human in control, but that is an explicit choice and never a default.

## Nothing the model says is taken on faith

The synthesis agent edits a staging copy with its own file tools, and `backpass` measures what changed instead of accepting text the model describes.
Every hunk is cut from the real file, so "that text does not appear in the file" is impossible by construction rather than by prompt discipline.
Token deltas, budget projections, and usage figures are measured from the artifacts themselves, never quoted from the model's own arithmetic.
An agent that changed nothing yields an empty proposal, never an invented one.
A number shown to a person must describe the thing it claims to describe, so a display that quietly compares two different measurements is a defect, not a cosmetic issue.
Every rule here is enforced in code and never merely asked for in a prompt, because a rule the model can decline is not a rule.

## The budget is the constraint, not a setting

Every always-loaded token is paid on every future session forever, and instruction following dilutes as the file grows.
A memory file decays by accretion into one of four states, empty, bloated, stale or drifted, because appending a line is always easier than consolidating or pruning one.
So a run is one gradient step under a fixed budget: few enough edits that a person actually reviews each one in a single sitting.
When a file is over budget the step scales with the overage, because a tool that cannot help the worst files is useless on the repos that need it most.
A rewrite is not a gradient step, so the cap grows with a bad file and never turns into starting over.
When a file is at budget the step is zero-sum, and every addition names the removal or extraction that pays for it.
An instruction earns its always-loaded place by mattering in a large share of sessions, measured rather than guessed, or by being safety-critical.
Anything narrow with a detectable trigger becomes a skill, whose description is that trigger, and anything narrow without one is a deletion candidate.
Growth of the memory file is never reported as progress.

## It reads what you already have and owns nothing

Transcripts are read from local harness stores, never uploaded, and they leave the machine only into an agent the user already authenticated.
`backpass` holds no API key of its own, so it can never become a bill or a service the user did not ask for.
One machine is the default, not the limit: pooling corroboration across a person's machines, or across a team, is a change of scale and not a change of kind.
What may be shared is the derived evidence, carried by infrastructure the user already owns, never a transcript and never through anything `backpass` runs.
Redaction is a coarse net and says so, so a stricter check may warn or be offered but never blocks a run by default on a guess.
All model invocation stays behind one module, so an upstream change has exactly one blast radius.
A harness qualifies when it records real session transcripts, because a store holding only a model's summary of a session is not evidence.
Supporting one means a pinned fixture and a fail-soft adapter, not a row in the README, and a missing or drifted store warns and is skipped while the run continues.
More harnesses is always welcome, provided a new one cannot destabilise the ones already working.
An association that cannot be made deterministically is labelled best-effort and stays opt-in, because a wrong attribution is worse evidence than none.
When coverage and accuracy are in tension, accuracy wins.

## Failure is loud and named

A parseable proposal with gate violations is saved with its provenance before the exact breaches are re-prompted; any terminal failure is named, and the run never silently truncates to fit.
A missing capability is named along with the command that would fix it, and `n/a` is not an acceptable thing to print at a person.
A gap in capability is fixed or reported, never papered over with a weaker path that quietly produces worse results.
A drifted store must never look identical to a repo with no history.
A run that proposes nothing explains why.
A bug is fixed at its root and verified against the real shape that produced it, not patched where it happened to be noticed.
A test earns its place by failing when the behavior it names is removed, so a test that only restates the implementation is deleted.

## Scope

`backpass` is not a code reviewer, not a CI system, not a linter, not a harness, and not a model provider.
It does not train a person's own `~/.claude/CLAUDE.md`, which is handwritten preference and not a target to write.
It does not rewrite a memory file and will not offer to, because a rewrite cannot be accepted edit by edit and leaves nothing for a rejection to remember.
Vocabulary is deliberate: the user reads the training loop, while subcommands and internals keep their short names.
The repo holds itself to its own standard, including excluding its own sessions from the corpus it analyzes.

A change aligns when it makes the evidence behind a proposal stronger, cheaper to verify, or harder to fabricate.
A change aligns when it lets a person say no faster, or say no once and have it remembered.
A change should be resisted when it widens what writes, lowers the two-session bar, or makes anything but per-edit review the default.
A change should be resisted when it makes the memory file easier to grow than to shrink.
A change should be resisted when it requires `backpass` to hold a key, a server, or a copy of someone else's transcripts.
A change should be resisted when it buys coverage with accuracy, or trades a real fix for a quieter degraded path.
