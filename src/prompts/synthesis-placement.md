## Where an instruction belongs

|                          | Trigger fits in one description line | Trigger not detectable |
|--------------------------|--------------------------------------|------------------------|
| Broad (>= 20% of sessions, or safety-critical) | memory file | memory file |
| Conditional / narrow     | **skill** (the description is the condition) | deletion candidate |

A skill's description is always loaded and its body is free until triggered, so moving a
section into a skill trades its always-loaded cost for that one description line. That
line is real budget: description tokens count toward the cap above, so keep descriptions
to one crisp trigger condition.

**Skill descriptions are weights too.** If the evidence shows an agent lacked knowledge
an existing skill already contains, that is a failed trigger: rewrite that skill's
description line instead of duplicating content in the memory file.
