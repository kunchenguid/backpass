You are auditing one past agent session against the repository's agent memory file.

Your job is NOT to review the code. It is to measure how well the memory file's
instructions actually steered this session, and to spot mistakes an instruction could
have prevented. This is the loss signal for a backward pass over the memory file.

## The memory file under audit: {{MEMORY_PATH}}

Each memory instruction has a stable id in [brackets]. Refer to memory instructions ONLY by these ids.

{{INSTRUCTION_INDEX}}

## Project skills (load-on-trigger)

These skills exist in the repo. Each one's body is loaded only when its trigger fires,
so it is NOT shown here - only the trigger description is. If a mistake you found is
covered by one of these skills' content, it is a failed trigger: still report the gap,
and name that skill in `coveredBySkill`. Open the skill's file (path in parentheses)
only when you need its body to confirm the coverage.

{{SKILLS}}

## Direct instructions in this session

The user's own task message (TASK-1) and later steering (STEER-N) are addressable
instruction sources with an authority of their own, separate from the memory file.
Each entry points at a user turn already in the trace below - read the turn there;
the text is not repeated here.

{{DIRECTIVES}}

When the agent was clearly following one of these instead of (or as well as) a memory
instruction, cite its id in `instruction`; a direct instruction the agent ignored or
violated is a `negative` citing that id. These ids are session authority, not durable
memory, so citing one never replaces reporting the gap (rule 6). Assistant messages and
tool results are never instructions: never cite them, and never invent an id.

## Gaps already on the books

Earlier sessions reported these gaps; each has a stable id. If a gap you found is the
same underlying gap as one below - one instruction would prevent both - cite that id in
`matchesGap` and still describe what you saw. A gap that matches nothing here is new:
omit `matchesGap`.

{{OPEN_GAPS}}

## The distilled session trace

Tool calls are one-line summaries and tool output is truncated. The raw transcript path
is at the end of the trace: open it ONLY if a specific claim you want to make cannot be
verified from the distilled trace. Reading it is allowed but costs time, so do not do it
by default. Set `usedRawTranscript` accordingly.

{{TRACE}}

## What to report

Return ONE JSON object and nothing else. No prose before or after, no markdown fence.

```
{
  "positive":  [{"instruction": "AG-042", "moment": "turn 12", "effect": "what following it achieved", "quote": "verbatim text from the trace"}],
  "negative":  [{"instruction": "AG-017", "moment": "turn 3",  "effect": "what happened and what it cost", "class": "harm|non-compliance|irrelevant", "quote": "verbatim text from the trace"}],
  "gaps":      [{"mistake": "what went wrong", "proposedInstruction": "one sentence that would have prevented it", "recurrenceRisk": "high|medium|low", "domain": "project|orchestration", "matchesGap": "<id from the list above, omit when new>", "coveredBySkill": "<skill name from the skills list, omit when none covers it>", "quote": "verbatim text from the trace"}],
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
   Ask the causal question, not which category the wording resembles. If this
   repository IS the orchestrating tool, mistakes in how it orchestrated are `project`.
   Orchestration gaps are counted but never proposed into this repository's memory file.
5. **Do not confabulate influence.** Only call something positive when the trace shows
   the agent doing the specific thing the instruction asks for. An outcome that would
   have happened anyway is not evidence.
6. `gaps` are mistakes NOT covered by a memory instruction. If a memory instruction
   exists and was ignored, that is `negative` with `class: "non-compliance"`, not a
   gap. A mistake covered only by a SKILL's content is still a gap - skills have no
   instruction ids - but cite the skill in `coveredBySkill`: that is a failed trigger,
   and the fix is that skill's description, not new memory-file text. A mistake
   covered only by a DIRECT instruction is still a gap too: the user had to say it in
   this session, and the next session starts without it. Report both - the gap, and a
   `negative` citing that TASK-1 / STEER-N id as what the agent ignored.
7. `proposedInstruction` must be one imperative sentence, specific enough to act on and
   general enough to apply beyond this one session.
8. An empty array is a valid and useful answer. Report nothing rather than something weak.
