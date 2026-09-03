To extract a section into a skill, create `./{{SKILLS_DIR}}/<skill-name>/SKILL.md` with
this exact shape, or append the extracted lines to an existing SKILL.md that should own
them, then remove the extracted detail from `./{{MEMORY_PATH}}`
(optionally leaving a one-line pointer):

```
---
name: <skill-name>
description: <one line - this IS the trigger condition>
---

<the full markdown body of the skill>
```

To tune an existing skill's trigger, edit its `description:` line under `./{{SKILLS_DIR}}/`.
