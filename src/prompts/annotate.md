{{PREFACE}}backpass measured the changes in the staging copy of {{MEMORY_PATH}}. Every change below
is identified by an id; annotate each one so a human can review it with its evidence.

## Measured changes

{{CHANGES}}

## What to produce

Return ONE JSON object and nothing else. No prose, no markdown fence.

```
{
  "edits": [
    {
      "changes": ["H1"],
      "kind": "add" | "remove" | "rewrite" | "extract",
      "title": "one line a human can decide on",
      "rationale": "why the evidence supports this",
      "instructions": ["AG-017"],
      "evidence": [{"polarity": "negative", "text": "the verbatim quote", "source": "claude · abc123 · turn 12"}],
      "transcripts": 3
    }
  ],
  "verdicts": [
    {"instruction": "AG-042", "verdict": "keep" | "strengthen" | "weaken" | "remove", "positive": 6, "negative": 1, "note": "one line"}
  ],
  "notes": ["anything a human should know that is not an edit"]
}
```

Hard rules - a violation fails the whole proposal:

1. **Every measured change belongs to exactly one edit.** Group the changes that make up
   one decision (an extraction is the new `SKILL.md` plus the removal it pays for); do
   not leave a change out. If a change should not ship, revert it in the file first.
2. **At most {{MAX_EDITS}} edits** - the learning rate. Regroup or revert if you are over.
3. **Every edit carries at least one verbatim quote in `evidence`**, with its source.
4. **New instructions need evidence from at least {{MIN_GAP_EVIDENCE}} distinct
   sessions.** `transcripts` is how many distinct sessions back the edit; an edit that
   only adds text is a new instruction whatever its `kind` says.
5. **Removing an instruction outright needs harm evidence from at least
   {{MIN_GAP_EVIDENCE}} distinct sessions** (`harm-sessions` in the evidence). Only
   `harm` negatives argue against an instruction; `non-compliance` never justifies a
   deletion. A change that only deletes text and is not part of an extract is a removal
   whatever its `kind` says - if it lacks the evidence, revert it in the file first.
6. `kind: "extract"` is an edit whose changes are one or more created `SKILL.md` files
   plus the change(s) to {{MEMORY_PATH}} that pay for them. **The skills must carry every
   line those changes remove** - a deletion is never part of an extract; give it its own
   `remove` edit. One skill per extract is the normal shape. Several skills belong in ONE
   extract exactly when their removals landed in a **single** measured change: adjacent
   removals are merged into one change, and a merged change cannot be accepted in halves.
   If each skill has its own measured change, give each its own extract. Any other kind
   must not include a created file, and an edit changes one file only.
7. **Budget:** {{BUDGET_RULE}}

If you still need to change the files, do that first and then answer; backpass
re-measures after this reply and shows you the new ids if anything moved. Re-measuring
does not use up an annotation attempt.
