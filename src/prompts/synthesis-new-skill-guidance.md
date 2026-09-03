To extract a section into a new skill, create `./{{SKILLS_DIR}}/<skill-name>/SKILL.md`
with this exact shape, then remove the extracted detail from `./{{MEMORY_PATH}}`
(optionally leaving a one-line pointer):

```
---
name: <skill-name>
description: <one line - this IS the trigger condition>
---

<the full markdown body of the skill>
```

Existing skills are context only and must not be edited.
