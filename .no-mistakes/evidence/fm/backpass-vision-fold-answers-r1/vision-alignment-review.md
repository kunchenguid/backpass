# VISION.md standalone alignment review

Reviewed target `fa872aec4d707934157106dd9b93ff7fa897c47c` against base `69b337a1479a4b8fd28ead10e2c16d5da6283481` using the final `VISION.md` as the sole decision surface.

## End-user acceptance result

A reviewer can recover all 13 recorded decisions and their supporting reasoning from `VISION.md` alone:

| Check | Decision recoverable from VISION.md | Supporting reason present in the prose |
|---|---|---|
| Pool corroboration across machines or a team | Accept derived evidence sharing, resist transcript sharing or a backpass-owned service | Independent observers provide especially strong evidence; backpass owns nothing and transcripts stay local |
| Bootstrap a repo with no memory file | Accept only a fixed, non-model-authored starter; resist an unreviewed learned instruction | There is no prior file to protect, while model-authored instructions are exactly the writes the review gate exists to control |
| Opt-in unattended application | Accept explicit user opt-in, resist making it the default | Choosing how their own weights update preserves human control |
| Whole-file rewrite | Resist | A rewrite is not a gradient step, cannot be accepted edit by edit, and leaves no rejection unit to remember |
| Harness backed only by model summaries | Resist | A summary is not transcript evidence, so real transcripts are required |
| Deterministic but quoteless evidence | Resist | Mechanically extracted signals are noisy without judgment anchored to a real quoted moment |
| Model-described edit fallback | Resist | A weaker path hides a missing capability rather than solving or naming it |
| Project run writing user-level memory | Resist | Learned knowledge belongs with its repo by default, and an accidental global write pollutes every project |
| Best-effort association by default | Resist; keep it opt-in | Wrong attribution is worse than missing evidence, so accuracy wins over coverage |
| Strict redaction heuristic blocking by default | Resist; permit warning or opt-in | High-entropy guesses would reject many real sessions and encourage users to disable redaction |
| Explain an empty run and count singleton gaps | Accept counts and explanations, resist singleton proposals | Counts distinguish a healthy run from a broken adapter, while singleton lists would become one-session rewrite to-dos |
| Add another harness | Accept when isolated, fixture-backed, and fail-soft | Broader harness coverage must not destabilize working integrations |
| Explicit user-level scope | Accept only when the person names that scope; isolate it from project scope; keep the evidence bar session-based rather than project-based | The human chooses which weights to train, people with only user-level instructions need a target, and evidence from one scope must not launder the other |

The closing accept/resist rules are consistent with those decisions: strengthen verifiable evidence, preserve remembered human control, retain the two-session floor, avoid default write widening, favor shrinking over growth, own no keys/services/transcripts, prefer accuracy, and reject degraded fallback behavior.

## Surface and repository checks

- `VISION-ANSWERS.md` is absent.
- `git grep` finds no tracked reference to `VISION-ANSWERS` or any `H-n` ruling label.
- Tracked documentation contains no prescription for principle-plus-rationale lines, rationale lines, one-or-two-sentence rules, or per-ruling structure.
- The commit changes only `VISION.md`, `AGENTS.md`, and deletion of `VISION-ANSWERS.md`; `README.md` is unchanged because it contained no pointer.
- `AGENTS.md` directs reviewers to run the accept/resist test against `VISION.md` alone.
- `VISION.md` remains a compact principles document at 92 lines and 1,722 words, with no ledger, hypothetical framing, ruling labels, or board transcript.
- `git diff --check` reports no whitespace errors.
