---
name: calendar
description: >-
  Create a real event on this agent's own Google Calendar via the
  create_calendar_event tool. Use whenever asked to schedule, book, put
  something on the calendar, or set up a meeting/appointment at a specific
  date/time. Also covers the OneCLI connect-link flow for a not-yet-connected
  calendar, and the deliberate distinction from second-brain's own,
  unrelated Google OAuth (never disclose that one).
metadata:
  author: nanoclaw
  version: "1.0.0"
---

# Calendar

`create_calendar_event` creates a real event on **this agent's own** Google
Calendar (`calendarId=primary`, under whichever Google identity is connected
to this agent group). Use it whenever asked to schedule, book, or add
something to "the calendar," "my calendar," or a meeting/appointment for a
specific date and time.

## Arguments

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

## Only your own calendar (for now)

This tool always targets `calendarId=primary` for whichever Google account
this agent group's OneCLI agent is connected to — it has no notion of
"someone else's calendar." If asked to put something on a *different*
person's calendar, say plainly that you can only create events on this
identity's own calendar right now; don't attempt a workaround or guess at
who else might be reachable.

## Two different Google connections — do not conflate them

This install may also have **second-brain**, a separate system that reads
Google Calendar/Gmail/etc. into an event log for recall. It and this tool
both involve "connecting Google," but they are unrelated systems with
opposite disclosure rules:

| | second-brain's own OAuth (event-log ingestion) | OneCLI's Google Calendar app connection (this tool) |
|---|---|---|
| Purpose | Feeds second-brain's queryable event log (calls, emails, calendar, decisions) | Lets `create_calendar_event` actually write an event |
| Who sets it up | The operator, directly, through second-brain's own per-tenant flow — never through you | Whoever connects the OneCLI `google-calendar` app |
| Disclosing a setup link to the user | **Never** — if a group's own instructions tell you not to hand out a second-brain connect link, that rule is unchanged and still applies | **Always**, when the gateway returns one (see below) — this is the opposite rule, for an unrelated system |

If you're ever unsure which one a "connect my calendar" request is about:
this tool's own connect link (below) is the one you're always allowed to
share. A second-brain ingestion link is a different thing entirely and that
rule, wherever it's stated for this group, still stands.

## When not connected

If `create_calendar_event` returns an error containing a connect link (the
gateway's `connect_url`), that's the OneCLI connection for *this tool* —
present it plainly, the same as the `onecli-gateway` skill's general rule
for any not-connected app:

> To connect Google Calendar, open this link: [connect_url]

Then let the user know you'll retry once they've connected.

## Not yet supported

Creating an event on someone else's calendar (cross-agent relay) isn't
built yet. Recognize a request like that and say so rather than guessing at
a workaround — a later capability will handle it.
