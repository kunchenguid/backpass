backpass measured the changes you made in the staging copy. Every change below is
identified by an id; annotate each one so a human can review it with its evidence.

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
5. `kind: "extract"` is exactly an edit whose changes include one created `SKILL.md`
   and at least one change to `{{MEMORY_PATH}}`. Any other edit must not include a
   created file, and an edit changes one file only.
6. **Budget:** {{BUDGET_RULE}}

If you still need to change the files, do that first and then answer; backpass
re-measures after this reply and shows you the new ids if anything moved.
