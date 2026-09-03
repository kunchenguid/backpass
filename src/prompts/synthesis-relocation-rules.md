4. **An extraction preserves every line it removes** in the SKILL.md it creates or
   extends. Extending an existing skill keeps every line that file already had, then adds
   the extracted lines. A deletion is never part of an extract: it is its own `remove`
   edit, decided on its own evidence.
5. **A move's removed and added lines match one-for-one** in `./{{MEMORY_PATH}}`.
   Group the deletion and the re-add as one change. Do not duplicate, rewrite, or add a
   rule in order to "move" it.
