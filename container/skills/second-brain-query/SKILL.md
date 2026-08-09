---
name: second-brain-query
description: >-
  Query the second-brain event log — past calls, emails, calendar events,
  and project decisions. Use this whenever asked to recall something
  specific from history (a price agreed, a date promised, what someone
  said, what was decided and why) rather than guessing or saying you
  don't have access. Covers query CLI syntax, source list, and the
  Hebrew-search tokenizer quirk.
metadata:
  author: nanoclaw
  version: "1.0.0"
---

# second-brain events database (read-only)

You have read-only access to the second-brain event log — a normalized
record of everything below, all queryable the same way.

**Sources** (filter with `--source`):

| `source` | What it holds |
|---|---|
| `recorder` | Voice-call transcripts — mic + system-audio loopback, capture doesn't care which app (Zoom/Meet/WhatsApp/phone all land the same way) |
| `gcal` | Your own Google Calendar events |
| `gcal-shared` | A cross-viewed shared calendar, for visibility only — it's not your own time; never report it as your own |
| `gmail` | Email summaries from senders ruled `household` |
| `gmail-private` | Email summaries from senders ruled `private` — never reaches `household.db` |
| `hq` | Project decision log — architecture/business decisions across projects, stored with the reasoning (why, what was rejected and why) alongside the conclusion, not just the conclusion. `thread_id` is the project name when the decision named one, `hq` for cross-cutting or charter entries. **This is where "what did we decide about project X, and why" lives — check `--source hq` before ever saying you don't have that.** |

New sources get added to this table as they're wired in. If unsure what's
actually there, `recent` with no `--source` filter shows everything,
newest first.

**Before saying you don't have access to something, check whether a
source above would already answer it.** "What projects do I have" isn't
a filesystem question — it's answerable from `hq`'s distinct `thread_id`
values (`recent --source hq`, then look at what `thread_id`s come back).
Query first; only say you don't have something after you've actually
checked, not before.

Query by shelling out to the compiled CLI (adjust `--db` path(s) to
whichever databases are mounted for this group):

```
node /workspace/extra/second-brain/dist/bin/query.js search --text "<phrase>" --db <path> [--db <path2>] [--source recorder] [--thread-id <id>] [--from <date>] [--to <date>] [--limit <n>]
node /workspace/extra/second-brain/dist/bin/query.js recent --db <path> [--db <path2>] [--source recorder] [--thread-id <id>] [--from <date>] [--to <date>] [--limit <n>]
```

- Always pass `--db` explicitly — the tool's own default doesn't match
  where it's mounted here. Pass `--db` twice to search across both at
  once; each result row carries a `db` field so you always know which
  one a fact came from.
- `search` full-text-searches the `--text` phrase; `recent` browses
  newest-first with no text filter. Both accept the same optional
  filters.
- `--from`/`--to` accept `YYYY-MM-DD` or a full ISO datetime.
- Output is one line of JSON — an array of event objects (`text`,
  `occurred_at` as unix seconds, `author`, `participants`, `thread_id`,
  `source`, `lang`, `db`, ...). Empty results print `[]`, not an error.
- **Hebrew search quirk:** the search tokenizer has no Hebrew morphology
  awareness. A word with an attached prefix (ש/ו/ב/ל/מ/כ/ה — e.g.
  `שהמחיר`) won't match a search for the bare word (`המחיר`). If a
  search for an obvious term comes up empty, try a fuller phrase or the
  word with a likely prefix before concluding it isn't there.
- This tool has no write path at all — don't look for one, there isn't
  one. You cannot add, edit, delete, or project events from here.
  (Projection — deriving `household.db` facts from `uriel.db` — is a
  separate operator-run tool, not something you can trigger.)

**Always re-query — never answer from what you said earlier in this
conversation.** These databases change between turns: new events get
ingested, a bad summary gets fixed and re-projected, a rule changes.
Your own previous answer is not a cache of the current data — if asked
the same or a related question again, even minutes later, query fresh
rather than repeating what you said before. "As I said a moment ago" is
exactly the failure mode to avoid: it means trusting your own memory
over the actual database, and the database is the only thing that's
allowed to be authoritative here.
