You are performing the synthesis step of a backward pass over a repository's agent
memory file. Evidence from many past agent sessions has already been gathered and
folded. Your job is to turn that evidence into a small set of concrete, budget-aware
edits - one gradient step on the weights, not a rewrite.

## Repository

{{REPO_NAME}} - {{TRANSCRIPT_COUNT}} sessions analyzed across {{HARNESS_SUMMARY}}.

## Current memory file: {{MEMORY_PATH}}

Budget: {{CURRENT_TOKENS}} / {{BUDGET_TOKENS}} estimated tokens ({{BUDGET_STATE}}).

Every token in this file is paid on every future session, forever, and instruction
following dilutes as the file grows. The budget is the constraint you optimize under.

{{INSTRUCTION_INDEX}}

## Existing skills (load-on-trigger, in {{SKILLS_DIR}})

{{SKILL_INDEX}}

## Folded evidence

`sessions` is how many distinct sessions produced the item. `relevance` is the share of
analyzed sessions in which an instruction drew any evidence at all.

{{EVIDENCE}}

## Previously rejected edits - do not re-propose these

{{REJECTIONS}}

## What to produce

Return ONE JSON object and nothing else. No prose, no markdown fence.

```
{
  "edits": [
    {
      "kind": "add" | "remove" | "rewrite" | "extract",
      "file": "{{MEMORY_PATH}}",
      "title": "one line a human can decide on",
      "find": "exact existing text to replace, copied character-for-character from the memory file above; empty string for a pure addition",
      "replace": "the new text; empty string for a pure removal",
      "anchor": "when find is empty, the exact existing text this should be inserted AFTER (a heading line is ideal)",
      "rationale": "why the evidence supports this",
      "instructions": ["AG-017"],
      "evidence": [{"polarity": "negative", "text": "the verbatim quote", "source": "claude · abc123 · turn 12"}],
      "transcripts": 3,
      "skill": {
        "name": "release-signing",
        "path": "{{SKILLS_DIR}}/release-signing/SKILL.md",
        "description": "the frontmatter description - this IS the trigger condition",
        "body": "the full markdown body of the extracted skill"
      }
    }
  ],
  "verdicts": [
    {"instruction": "AG-042", "verdict": "keep" | "strengthen" | "weaken" | "remove", "positive": 6, "negative": 1, "note": "one line"}
  ],
  "notes": ["anything a human should know that is not an edit"]
}
```

Hard rules - a violation fails the whole proposal:

1. **At most {{MAX_EDITS}} edits.** This is the learning rate. Pick the highest-signal
   changes; a small correct step beats a large speculative one.
2. **`find` must be copied exactly from the memory file shown above**, including
   punctuation and leading list markers. It must appear exactly once in the file. If you
   cannot reproduce it exactly, use a shorter unique fragment.
3. **New instructions need evidence from at least {{MIN_GAP_EVIDENCE}} distinct
   sessions.** One bad session never rewrites the weights.
4. **Every edit carries at least one verbatim quote in `evidence`.**
5. **Budget:** {{BUDGET_RULE}}
6. `skill` is required for `kind: "extract"` and forbidden otherwise. An extract must
   also set `find`/`replace` to remove the extracted detail from the memory file,
   optionally leaving a one-line pointer.
7. Prefer removing a dead instruction over adding a new one. Instructions with high
   token cost and zero positive evidence across many sessions are the best removals.

## Where an instruction belongs

|                          | Trigger fits in one description line | Trigger not detectable |
|--------------------------|--------------------------------------|------------------------|
| Broad (>= 20% of sessions, or safety-critical) | memory file | memory file |
| Conditional / narrow     | **skill** (the description is the condition) | deletion candidate |

A skill's description is always loaded and its body is free until triggered, so moving a
long, narrow, crisply-triggered section into a skill is nearly pure budget profit.

**Skill descriptions are weights too.** If the evidence shows an agent lacked knowledge
an existing skill already contains, that is a failed trigger: propose a `rewrite` of that
skill's description line, not duplicate content in the memory file.
