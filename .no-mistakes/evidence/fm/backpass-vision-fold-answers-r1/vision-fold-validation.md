# VISION.md fold validation

## End-user contract

The final repository presents `VISION.md` as the single vision-alignment surface. `AGENTS.md` tells reviewers to run the accept/resist test against that file alone.

Acceptance checks produced this result:

```text
PASS: VISION-ANSWERS.md is deleted
PASS: no VISION-ANSWERS reference remains anywhere in the worktree
PASS: VISION.md contains no H-1 through H-13 ledger labels
Changed files:
AGENTS.md
VISION-ANSWERS.md
VISION.md
PASS: change is confined to the allowed documentation files
VISION.md final size: 92 lines, 1722 words
PASS: tested documentation matches target commit
```

## Ruling coverage review

The deleted record was compared with the final, user-facing `VISION.md`. Each ruling's resulting principle and reason is independently understandable without the hypothetical ledger:

| Ruling | Final principle and rationale in VISION.md | Result |
| --- | --- | --- |
| H-1 | Pooling derived evidence can extend beyond one machine because independent observers seeing the same gap are the strongest evidence; transcripts remain unshared and backpass owns no infrastructure. | Covered |
| H-2 | Model-authored instructions always pass the review gate, including the first proposal; creating an empty starter is safe because it is not itself an instruction and overwrites nothing. | Covered |
| H-3 | Per-edit review remains the default, while an explicit looser mode is compatible with human control because the owner chooses how their own weights are updated. | Covered |
| H-4 | Whole-file rewriting is excluded because it is not a gradient step, cannot be accepted edit by edit, and leaves no rejection to remember. | Covered |
| H-5 | A harness must expose real transcripts because a model summary is not evidence. | Covered |
| H-6 | Mechanically extracted signals remain quoteless noise until judgment and a real trace quote anchor them. | Covered |
| H-7 | A missing capability is fixed or reported rather than hidden behind a degraded fallback, because the fallback conceals rather than closes the gap. | Covered |
| H-8 | Project scope remains the default because learned knowledge belongs with its repo and an implicit user-level write would pollute every project. | Covered |
| H-9 | Best-effort association stays opt-in because incorrect attribution is worse than missing evidence; accuracy wins over coverage. | Covered |
| H-10 | Stricter redaction may warn or be offered but cannot refuse by default on guesses, because high-entropy false positives would reject normal sessions and encourage users to disable protection. | Covered |
| H-11 | Singleton gaps never become proposals because a visible list becomes a one-session to-do; aggregate counting remains useful for distinguishing a healthy run from a broken adapter. | Covered |
| H-12 | New harnesses are welcome only when they cannot destabilize existing ones, with pinned fixtures and fail-soft adapters defining that safety boundary. | Covered |
| H-13 | User-level memory is trainable only when explicitly named as the run scope, preserving human choice for users whose instructions live there; project and user evidence remain isolated so corroboration cannot leak between scopes. The evidence bar remains sessions, not projects. | Covered |

## Scope review

The commit changes only `VISION.md`, `AGENTS.md`, and the required deletion of `VISION-ANSWERS.md`. `README.md` had no pointer to remove. No source code, tests, generated files, or runtime behavior changed.
