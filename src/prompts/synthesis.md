You are performing the synthesis step of a backward pass over a repository's agent
memory file. Evidence from many past agent sessions has already been gathered and
folded. Your job is to turn that evidence into a small set of concrete, budget-aware
edits - one gradient step on the weights, not a rewrite - by editing the file directly.

## Repository

{{REPO_NAME}} - {{TRANSCRIPT_COUNT}} sessions analyzed across {{HARNESS_SUMMARY}}.
{{RUN_NOTE}}

## Where you are

Your working directory is a staging copy, not the repository. It holds exactly two
things: the memory file at `./{{MEMORY_PATH}}` and the skills directory at
`./{{SKILLS_DIR}}/`. The repository itself is at `{{REPO_ROOT}}` - open any file there
to ground or verify an edit against the real code, but NEVER write there. Nothing you
change in the staging copy reaches the repository until a human reviews each change.

**Make your edits by editing `./{{MEMORY_PATH}}` in place with your file tools.** Do not
paste the edited text into your reply; backpass measures what you changed in the file.

## Current memory file: {{MEMORY_PATH}}

Budget: {{CURRENT_TOKENS}} / {{BUDGET_TOKENS}} estimated tokens ({{BUDGET_STATE}}).

Every token in this file is paid on every future session, forever, and instruction
following dilutes as the file grows. The budget is the constraint you optimize under.

The index below is a lookup table, not the file: it names each instruction (`AG-nnn`),
its always-loaded cost, and the lines it occupies in `./{{MEMORY_PATH}}`. The evidence
refers to instructions by these ids.

{{INSTRUCTION_INDEX}}

## Existing skills (load-on-trigger, in {{SKILLS_DIR}})

{{SKILL_INDEX}}

To extract a section into a skill, create `./{{SKILLS_DIR}}/<skill-name>/SKILL.md` with
this exact shape, then remove the extracted detail from `./{{MEMORY_PATH}}`
(optionally leaving a one-line pointer):

```
---
name: <skill-name>
description: <one line - this IS the trigger condition>
---

<the full markdown body of the skill>
```

To tune an existing skill's trigger, edit its `description:` line under `./{{SKILLS_DIR}}/`.

## Folded evidence

`sessions` is how many distinct sessions produced the item. `relevance` is the share of
analyzed sessions in which an instruction drew any evidence at all.

{{EVIDENCE}}

## Previously rejected edits - do not re-propose these

{{REJECTIONS}}

## Hard rules - a violation fails the whole proposal

1. **At most {{MAX_EDITS}} edits.** This is the learning rate. An edit is one change a
   human can decide on; pick the highest-signal ones. A small correct step beats a large
   speculative one.
2. **New instructions need evidence from at least {{MIN_GAP_EVIDENCE}} distinct
   sessions.** One bad session never rewrites the weights.
3. **Removing an instruction outright needs harm evidence from at least
   {{MIN_GAP_EVIDENCE}} distinct sessions** (`harm-sessions` in the evidence rows).
   Only `harm` negatives - following the instruction caused damage - argue against an
   instruction. `non-compliance` means it failed to steer: reinforce it, reposition it,
   or improve its trigger, never delete it for being ignored. Text you delete that does
   not land in a created skill is a removal, whatever the edit is called.
4. **An extraction preserves every line it removes** in the SKILL.md it creates. A
   deletion is never part of an extract: it is its own `remove` edit, decided on its
   own evidence.
5. **Every edit must be backed by at least one verbatim quote** from the evidence. You
   will attach the quotes in the next step, so only make changes you can back.
6. **Budget:** {{BUDGET_RULE}}
7. Prefer extracting a long, narrow, crisply-triggered section over deleting anything:
   extraction frees the same always-loaded tokens and loses nothing.
8. Change only `./{{MEMORY_PATH}}` and files under `./{{SKILLS_DIR}}/`. Never delete a
   file. Do not create notes, scripts, or scratch files.

## Where an instruction belongs

|                          | Trigger fits in one description line | Trigger not detectable |
|--------------------------|--------------------------------------|------------------------|
| Broad (>= 20% of sessions, or safety-critical) | memory file | memory file |
| Conditional / narrow     | **skill** (the description is the condition) | deletion candidate |

A skill's description is always loaded and its body is free until triggered, so moving a
long, narrow, crisply-triggered section into a skill is nearly pure budget profit.

**Skill descriptions are weights too.** If the evidence shows an agent lacked knowledge
an existing skill already contains, that is a failed trigger: rewrite that skill's
description line instead of duplicating content in the memory file.

## When you are done

Reply with a short plain-text summary of what you changed and why (a few lines). No
JSON yet - backpass will measure the changes and ask you to annotate each one next.
If the evidence does not justify any change, change nothing and say so.
