---
name: calendar
description: >-
  Create, read, and update real events on Uriel's or Devorah's Google
  Calendar via create_calendar_event, list_calendar_events, and
  update_calendar_event. Use whenever asked to schedule, book, put
  something on the calendar, check what's coming up, answer "when is X",
  or reschedule/edit an existing event — for either person, not just this
  agent's own identity. Also covers the OneCLI connect-link flow for a
  not-yet-connected calendar, and the deliberate distinction from
  second-brain's own, unrelated Google OAuth (never disclose that one).
metadata:
  author: nanoclaw
  version: "1.1.1"
---

# Calendar

Three tools operate on **Uriel's or Devorah's** real Google Calendar. Both
calendars are reachable through the one Google account this system has
connected — Devorah's calendar isn't a separate connection, she shares it
with the connected account (Google Calendar's own sharing feature), so
every tool reaches it the same way it reaches Uriel's own.

- `create_calendar_event` — schedule something new.
- `list_calendar_events` — answer "what's on my/their calendar" or
  "when is X" questions. **Always** use this instead of answering from
  memory or a guess — calendar state changes and you don't have it cached.
- `update_calendar_event` — fix a mistake or reschedule an existing event.
  There is no delete/cancel tool; if asked to cancel an event, say plainly
  that's not something you can do yet.

## create_calendar_event

- `calendar` (required) — `"uriel"` or `"devorah"`. Pick based on who the
  event is actually for, not who's asking — an unqualified "my calendar" in
  the shared household chat must be resolved against the real sender's
  identity (see `groups/household/memory/household/people.md`), never
  defaulted to Uriel. If it's genuinely unclear whose calendar is meant,
  ask — don't guess.
- `title` (required) — event title.
- `start` / `end` (required) — naive local wall-clock time, no offset or
  `Z`, e.g. `"2026-08-20T15:00:00"`. This is interpreted in this group's own
  configured timezone — write times the way a person would say them
  ("3pm Wednesday"), not converted to UTC yourself.
- `description`, `location` (optional).
- `guests` (optional) — array of email addresses to invite.

A successful call returns the real event's details plus its Google-assigned
`htmlLink`. Always relay that link and the details actually set back to the
user — never invent or describe a confirmation of your own; the tool's
response is the only source of truth for what was actually created.

## list_calendar_events

- `calendar` (required) — same `"uriel"`/`"devorah"` resolution rule as above.
- `from` / `to` (optional) — same naive local wall-clock shape as
  create's `start`/`end`. Omit both for the default window: today through
  7 days out. Give just `from` to shift the window; give both for an exact
  range.
- `query` (optional) — free-text search (Google's own search across
  title/description/location), e.g. `"dentist"` for "when's my dentist
  appointment".

Returns each matching event's real `id`, title, time, and location if set.
Keep the `id` around if the next step is an update — passing it as
`eventId` to `update_calendar_event` skips a redundant search. "No events
found" is a real, plain answer — never paper over it with a guess. A
request naming both people ("what's on mine and Devorah's") is one call per
calendar — never a single combined call.

## update_calendar_event

Two ways to target the event to change:

1. **Already know the `eventId`** (e.g. from a `list_calendar_events` call
   moments ago) — pass it directly, the tool updates that exact event with
   no search.
2. **Don't know it** — pass `eventQuery` (free text) instead, optionally
   with `from`/`to` to narrow the search window (same defaults as
   `list_calendar_events`). Exactly one match updates directly. Zero
   matches declines clearly. Two or more return a numbered list (id/title/
   time) — re-call the tool with the specific `eventId` from that list
   rather than guessing which one was meant.

At least one of `title`, `start`, `end`, `description`, `location` must be
given — the tool declines if there's nothing to change. Only the field(s)
given are changed; everything else about the event is left alone (a real
partial update, not a recreate). There is no delete/cancel capability.

The confirmation reflects what Google's response actually echoes back, not
just a restatement of the request — relay that, same as `create_calendar_event`.

## Two calendars, either one, from any chat

All three tools are reachable from household, dm-with-uriel, or
dm-with-partner alike — there's no "wrong" chat to ask from, and no need to
relay/forward a request anywhere. If a request names both people ("check
mine and Devorah's" / "put it on both calendars"), call the tool once per
calendar named — never a single combined call, and never silently drop the
second one.

## Two different Google connections — do not conflate them

This install may also have **second-brain**, a separate system that reads
Google Calendar/Gmail/etc. into an event log for recall. It and this tool
both involve "connecting Google," but they are unrelated systems with
opposite disclosure rules:

| | second-brain's own OAuth (event-log ingestion) | OneCLI's Google Calendar app connection (this tool) |
|---|---|---|
| Purpose | Feeds second-brain's queryable event log (calls, emails, calendar, decisions) | Lets these tools actually read and write real calendar events |
| Who sets it up | The operator, directly, through second-brain's own per-tenant flow — never through you | Whoever connects the OneCLI `google-calendar` app |
| Disclosing a setup link to the user | **Never** — if a group's own instructions tell you not to hand out a second-brain connect link, that rule is unchanged and still applies | **Always**, when the gateway returns one (see below) — this is the opposite rule, for an unrelated system |

If you're ever unsure which one a "connect my calendar" request is about:
this tool's own connect link (below) is the one you're always allowed to
share. A second-brain ingestion link is a different thing entirely and that
rule, wherever it's stated for this group, still stands.

## When not connected

If any of the three tools returns an error containing a connect link (the
gateway's `connect_url`), that's the OneCLI connection for *these tools* —
present it plainly, the same as the `onecli-gateway` skill's general rule
for any not-connected app:

> To connect Google Calendar, open this link: [connect_url]

Then let the user know you'll retry once they've connected.

If a call targeting Devorah's calendar specifically fails with an access
error (not a "not connected" link, but a real permission error), the most
likely cause is she hasn't shared her calendar with the connected account
yet — say that plainly rather than implying the whole tool is broken.
