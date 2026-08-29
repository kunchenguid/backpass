<!-- backpass:self-session -->
You are auditing one past agent session against the repository's agent memory file.

Your job is NOT to review the code. It is to measure how well the memory file's
instructions actually steered this session, and to spot mistakes an instruction could
have prevented. This is the loss signal for a backward pass over the memory file.

## The memory file under audit: AGENTS.md

Each instruction has a stable id in [brackets]. Refer to instructions ONLY by these ids.

[AG-001] (10 tok, L3) <Agent instructions>
- Run `make build` before every push.

## Gaps already on the books

Earlier sessions reported these gaps; each has a stable id. If a gap you found is the
same underlying gap as one below - one instruction would prevent both - cite that id in
`matchesGap` and still describe what you saw. A gap that matches nothing here is new:
omit `matchesGap`.

(none yet)

## The distilled session trace

Tool calls are one-line summaries and tool output is truncated. The raw transcript path
is at the end of the trace: open it ONLY if a specific claim you want to make cannot be
verified from the distilled trace. Reading it is allowed but costs time, so do not do it
by default. Set `usedRawTranscript` accordingly.

# session pi-session-b
harness: pi
date: 2026-08-29T01:36:08.035Z
cwd: /Users/kunchen/.no-mistakes/evidence/01M15JF8JW2NT2B0Y38C00WB9Y/tmp/backpass-domain-repo-4AAlEA
association: tier 1 (exact)

### turn 1 · user
Please build the project.

### turn 2 · assistant
Ran make build as instructed.

### turn 3 · user
Now run the tests too.

### turn 4 · assistant
Tests pass.

---
raw transcript: /Users/kunchen/.no-mistakes/evidence/01M15JF8JW2NT2B0Y38C00WB9Y/tmp/backpass-domain-home-MbyIgV/.pi/agent/sessions/session-b/1787967368035_session-b.jsonl
Tool calls above are one-line summaries and tool output is truncated. Open the raw
transcript only if a specific claim needs the full text.


## What to report

Return ONE JSON object and nothing else. No prose before or after, no markdown fence.

```
{
  "positive":  [{"instruction": "AG-042", "moment": "turn 12", "effect": "what following it achieved", "quote": "verbatim text from the trace"}],
  "negative":  [{"instruction": "AG-017", "moment": "turn 3",  "effect": "what happened and what it cost", "class": "harm|non-compliance|irrelevant", "quote": "verbatim text from the trace"}],
  "gaps":      [{"mistake": "what went wrong", "proposedInstruction": "one sentence that would have prevented it", "recurrenceRisk": "high|medium|low", "domain": "project|orchestration", "matchesGap": "<id from the list above, omit when new>", "quote": "verbatim text from the trace"}],
  "usedRawTranscript": false
}
```

Rules, in order of importance:

1. **Every item needs a verbatim `quote` copied exactly from the trace.** Items without
   a real quote are discarded downstream, so an unquotable claim is wasted work.
2. **Negative evidence is the most valuable.** A visible violation, misreading, or
   ignored instruction outranks a dozen "it went fine" observations.
3. **`class` states what a negative means, and the difference decides the instruction's
   fate.** `harm`: the agent FOLLOWED the instruction and following it caused damage or
   cost - evidence against the instruction itself. `non-compliance`: the agent ignored
   or violated the instruction - evidence the instruction failed to steer, which argues
   for reinforcing it, never for deleting it. `irrelevant`: on inspection the moment
   does not actually bear on this instruction. Never report a skipped rule as `harm`.
4. **`domain` states what caused a gap.** A gap is `orchestration` when the mistake was
   not caused by this repository, but by an external agent harness or tooling that
   orchestrated the task (a task brief, a supervisor's process, the harness itself - by
   way of illustration only, not a list to match against); every other gap is `project`.
   Ask the causal question, not which category the wording resembles. Orchestration gaps
   are counted but never proposed into this repository's memory file.
5. **Do not confabulate influence.** Only call something positive when the trace shows
   the agent doing the specific thing the instruction asks for. An outcome that would
   have happened anyway is not evidence.
6. `gaps` are mistakes NOT covered by any current instruction. If an instruction exists
   and was ignored, that is `negative` with `class: "non-compliance"`, not a gap.
7. `proposedInstruction` must be one imperative sentence, specific enough to act on and
   general enough to apply beyond this one session.
8. An empty array is a valid and useful answer. Report nothing rather than something weak.
