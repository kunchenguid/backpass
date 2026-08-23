# Vision

`backpass` exists so that a repository's agent memory file improves from what actually happened in its agent sessions, instead of from whatever a human happened to remember.
It serves the developer who owns an `AGENTS.md` and runs coding agents against their own repo, and it turns transcripts already sitting on their disk into a small set of reviewable edits.
It owns exactly one thing: the backward pass from session transcripts to a proposed change in the memory file.

## Evidence is the only currency

Every claim a model makes carries a verbatim quote copied from the trace, and a claim without one is discarded rather than softened.
A visible violation outranks any number of "it went fine" observations, because negative evidence is what proves the file was steering anything at all.
A new instruction needs corroboration from at least two distinct sessions, and one session never counts twice however often it is re-analyzed.
Corroboration accumulates across runs in a ledger rather than resetting each run, so a gap seen today and again next week still graduates.
An uncorroborated gap stays out of the proposal entirely, and is not surfaced as a hint, a watchlist, or a maybe.
One bad session never rewrites the weights.

## The human owns the weights

Every stage is read-only analysis and one module does all the writing, which is what makes a run safe to interrupt at any point.
Each proposed edit is reviewed on its own, with its diff and the quotes behind it, and accepted or rejected one at a time.
A rejection is remembered and never re-proposed until materially new evidence arrives, so review effort is not spent twice on the same answer.
The single write that skips the gate is creating a memory file where none existed, and it can only create, never overwrite.
Automation may prepare a change and argue for it, but it does not land the change on the human's behalf.
Convenience is not a reason to widen what writes.

## Nothing the model says is taken on faith

The synthesis agent edits a staging copy with its own file tools, and `backpass` measures what changed instead of accepting text the model describes.
Every hunk is cut from the real file, so "that text does not appear in the file" is impossible by construction rather than by prompt discipline.
Token deltas, budget projections, and usage figures are measured from the artifacts themselves, never quoted from the model's own arithmetic.
An agent that changed nothing yields an empty proposal, never an invented one.
A number shown to a person must describe the thing it claims to describe, so a display that quietly compares two different measurements is a defect, not a cosmetic issue.

## The budget is the constraint, not a setting

Every always-loaded token is paid on every future session forever, and instruction following dilutes as the file grows.
So a run is one gradient step under a fixed budget: few enough edits that a person actually reviews each one in a single sitting.
When a file is over budget the step scales with the overage, because a tool that cannot help the worst files is useless on exactly the repos that need it most.
When a file is at budget the step is zero-sum, and every addition names the removal or extraction that pays for it.
A skill's description is its trigger, which makes extraction the release valve, and the relevance deciding memory-file versus skill placement is measured from evidence rather than guessed.
Growth of the memory file is never reported as progress.

## It reads the machine it is on and owns nothing else

Transcripts are read from local harness stores, never uploaded, and they leave the machine only into an agent the user already authenticated.
`backpass` holds no API key of its own, so it can never become a bill or a service the user did not ask for.
All model invocation stays behind one module, so an upstream change has exactly one blast radius.
State lives under `.backpass/` and is excluded through the repository's local git exclude, because a user's tracked files are theirs and not a place to leave state.
Every harness is read on equal terms, and a store that is missing or has drifted warns and is skipped while the run continues.
Supporting a harness means a pinned fixture and a fail-soft adapter, not a row in the README.
An association that cannot be made deterministically is labelled best-effort, never presented as a match.

## Failure is loud and named

A gate violation re-prompts with the exact breach, then fails the run and saves the rejected proposal, and never silently truncates to fit.
A missing capability is named along with the command that would fix it, and `n/a` is not an acceptable thing to print at a person.
A drifted store must never look identical to a repo with no history.
A bug is fixed at its root and verified against the real shape that produced it, not patched where it happened to be noticed.
A test earns its place by failing when the behavior it names is removed, so a test that only restates the implementation is deleted.

## Scope

`backpass` is not a code reviewer, not a CI system, not a linter, not a harness, and not a model provider.
It does not edit global memory such as `~/.claude/CLAUDE.md`, which is context to read and never a target to write.
It does not rewrite a memory file and will not offer to, because a rewrite cannot be accepted edit by edit and leaves nothing for a rejection to remember.
Vocabulary is deliberate: the user reads the training loop, while subcommands and internals keep their short names.
The repo holds itself to its own standard, including excluding its own sessions from the corpus it analyzes.

A change aligns when it makes the evidence behind a proposal stronger, cheaper to verify, or harder to fabricate.
A change aligns when it lets a person say no faster, or say no once and have it remembered.
A change aligns when it replaces a reported number with a measured one.
A change should be resisted when it widens what writes, lowers the two-session bar, or lets a proposal reach the file without a per-edit human decision.
A change should be resisted when it makes the memory file easier to grow than to shrink.
A change should be resisted when it requires `backpass` to hold a key, a server, or a copy of someone else's transcripts.
A change should be resisted when it adds a surface the maintainer cannot pin with a fixture and cannot keep honest when it drifts.
