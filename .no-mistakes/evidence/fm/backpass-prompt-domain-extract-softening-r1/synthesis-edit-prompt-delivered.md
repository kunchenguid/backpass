<!-- backpass:self-session -->
You are performing the synthesis step of a backward pass over a repository's agent
memory file. Evidence from many past agent sessions has already been gathered and
folded. Your job is to turn that evidence into a small set of concrete, budget-aware
edits - one gradient step on the weights, not a rewrite - by editing the file directly.

## Repository

backpass-cli-v4aket - 3 sessions analyzed across none.


## Where you are

Your working directory is a staging copy, not the repository. It holds exactly two
things: the memory file at `./AGENTS.md` and the skills directory at
`./.agents/skills/`. The repository itself is at `/Users/kunchen/.no-mistakes/evidence/01M15JF8JW2NT2B0Y38C00WB9Y/tmp/backpass-cli-v4aket` - open any file there
to ground or verify an edit against the real code, but NEVER write there. Nothing you
change in the staging copy reaches the repository until a human reviews each change.

**Make your edits by editing `./AGENTS.md` in place with your file tools.** Do not
paste the edited text into your reply; backpass measures what you changed in the file.

## Current memory file: AGENTS.md

Budget: 98 / 5000 estimated tokens (within budget).

Every token in this file is paid on every future session, forever, and instruction
following dilutes as the file grows. The budget is the constraint you optimize under.

The index below is a lookup table, not the file: it names each instruction (`AG-nnn`),
its always-loaded cost, and the lines it occupies in `./AGENTS.md`. The evidence
refers to instructions by these ids.

[AG-001] (10 tok, L5) <Demo agent memory > Build>
- Run `make build` before every push.

[AG-002] (11 tok, L9) <Demo agent memory > Release checklist>
- Tag the release commit with the version.

[AG-003] (9 tok, L10) <Demo agent memory > Release checklist>
- Push the tag before the artifacts.

[AG-004] (8 tok, L11) <Demo agent memory > Release checklist>
- Never hand-edit CHANGELOG.md.

[AG-005] (10 tok, L15) <Demo agent memory > Incident response>
- Page the on-call before rolling back.

[AG-006] (10 tok, L16) <Demo agent memory > Incident response>
- Write the postmortem within two days.

[AG-007] (12 tok, L17) <Demo agent memory > Incident response>
- Link the postmortem from the incident channel.

[AG-008] (6 tok, L21) <Demo agent memory > Style>
- Never use the em dash.

## Existing skills (load-on-trigger, in .agents/skills)

(no skills directory found in this repo)

To extract a section into a skill, create `./.agents/skills/<skill-name>/SKILL.md` with
this exact shape, then remove the extracted detail from `./AGENTS.md`
(optionally leaving a one-line pointer):

```
---
name: <skill-name>
description: <one line - this IS the trigger condition>
---

<the full markdown body of the skill>
```

To tune an existing skill's trigger, edit its `description:` line under `./.agents/skills/`.

## Folded evidence

`sessions` is how many distinct sessions produced the item. `relevance` is the share of
analyzed sessions in which an instruction drew any evidence at all.

Sessions analyzed: 3
Totals: 0 positive, 3 negative, 0 gap clusters (0 singletons dropped below threshold)

### Per-instruction evidence
A negative's class is what it means: `harm` = following the instruction caused damage (evidence against it); `non-compliance` = the agent ignored it (evidence it failed to steer - argues for reinforcement, never deletion); `irrelevant` = no real bearing.
- [AG-001] +0 -3 harm-sessions=3 sessions=3 relevance=100.0% cost=10tok
    - [harm] "session 1 re-derived the release steps by hand" :: following the stale steps wasted a turn (claude · claude:s · unknown date)
    - [harm] "session 2 re-derived the release steps by hand" :: following the stale steps wasted a turn (claude · claude:s · unknown date)
    - [harm] "session 3 re-derived the release steps by hand" :: following the stale steps wasted a turn (claude · claude:s · unknown date)
- [AG-002] +0 -0 sessions=0 relevance=0.0% cost=11tok
- [AG-003] +0 -0 sessions=0 relevance=0.0% cost=9tok
- [AG-004] +0 -0 sessions=0 relevance=0.0% cost=8tok
- [AG-005] +0 -0 sessions=0 relevance=0.0% cost=10tok
- [AG-006] +0 -0 sessions=0 relevance=0.0% cost=10tok
- [AG-007] +0 -0 sessions=0 relevance=0.0% cost=12tok
- [AG-008] +0 -0 sessions=0 relevance=0.0% cost=6tok

### Gap clusters (mistakes no current instruction covers)
- none above the evidence threshold

## Previously rejected edits - do not re-propose these

(none)

## Hard rules - a violation fails the whole proposal

1. **At most 5 edits.** This is the learning rate. An edit is one change a
   human can decide on; pick the highest-signal ones. A small correct step beats a large
   speculative one.
2. **New instructions need evidence from at least 2 distinct
   sessions.** One bad session never rewrites the weights.
3. **Removing an instruction outright needs harm evidence from at least
   2 distinct sessions** (`harm-sessions` in the evidence rows).
   Only `harm` negatives - following the instruction caused damage - argue against an
   instruction. `non-compliance` means it failed to steer: reinforce it, reposition it,
   or improve its trigger, never delete it for being ignored. Text you delete that does
   not land in a created skill is a removal, whatever the edit is called.
4. **An extraction preserves every line it removes** in the SKILL.md it creates. A
   deletion is never part of an extract: it is its own `remove` edit, decided on its
   own evidence.
5. **Every edit must be backed by at least one verbatim quote** from the evidence. You
   will attach the quotes in the next step, so only make changes you can back.
6. **Budget:** The post-edit file must stay at or below 5000 tokens (4902 tokens of headroom today).
7. You can extract a long, narrow, crisply-triggered section instead of deleting it:
   extraction frees the same always-loaded tokens and loses nothing.
8. Change only `./AGENTS.md` and files under `./.agents/skills/`. Never delete a
   file. Do not create notes, scripts, or scratch files.

## Where an instruction belongs

|                          | Trigger fits in one description line | Trigger not detectable |
|--------------------------|--------------------------------------|------------------------|
| Broad (>= 20% of sessions, or safety-critical) | memory file | memory file |
| Conditional / narrow     | **skill** (the description is the condition) | deletion candidate |

A skill's description is always loaded and its body is free until triggered, so moving a
section into a skill trades its always-loaded cost for that one description line.

**Skill descriptions are weights too.** If the evidence shows an agent lacked knowledge
an existing skill already contains, that is a failed trigger: rewrite that skill's
description line instead of duplicating content in the memory file.

## When you are done

Reply with a short plain-text summary of what you changed and why (a few lines). No
JSON yet - backpass will measure the changes and ask you to annotate each one next.
If the evidence does not justify any change, change nothing and say so.
