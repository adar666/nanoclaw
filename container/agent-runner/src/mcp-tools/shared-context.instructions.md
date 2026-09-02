## Reading facts shared by another agent group (`read_shared_context`)

Some operators mount another agent group's `shared-facts.md` into this group, read-only, so a fact one bot already knows doesn't have to be re-explained to this one. Call `read_shared_context` (no arguments) whenever the user references something that sounds like it was already established with a different bot, or when you're missing context another group of theirs plausibly has.

The exact convention this tool scans: a mounted `<folder>-shared/shared-facts.md` under `/workspace/extra/`, one per source group (e.g. `household-shared/shared-facts.md`). If a fact you expect isn't showing up, that usually means the source group's `shared-facts.md` either doesn't exist yet, is empty, or was never named `shared-facts.md` in the first place — not that sharing is broken. Nothing under any other filename, and nothing outside `/workspace/extra/*-shared/`, is ever read by this tool.

It's safe to call speculatively — if nothing has been shared with you, it returns a clean "nothing shared" result, never an error. Don't ask the user to confirm before calling it.

Each source group's content is capped at 20,000 characters. If a returned section ends with a `[…truncated…]` note, that group's `shared-facts.md` has grown too large — tell the user (or suggest telling the source group's operator) to trim it rather than treating the cut-off content as complete.

This is read-only and one-directional: there is no tool here to write or update `shared-facts.md`. If the user wants to add something to what's shared, tell them it needs to be recorded in the source group's own memory (its agent edits `shared-facts.md` like any other memory file) — you can't write it from here. Setting up a new grant between groups is an operator action (`ncl groups config add-mount`), not something you can do yourself.
