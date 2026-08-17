---
name: calendar
description: >-
  Create a real event on Uriel's or Devora's Google Calendar via the
  create_calendar_event tool. Use whenever asked to schedule, book, put
  something on the calendar, or set up a meeting/appointment at a specific
  date/time — for either person, not just this agent's own identity. Also
  covers the OneCLI connect-link flow for a not-yet-connected calendar, and
  the deliberate distinction from second-brain's own, unrelated Google
  OAuth (never disclose that one).
metadata:
  author: nanoclaw
  version: "1.0.0"
---

# Calendar

`create_calendar_event` creates a real event on **Uriel's or Devora's**
Google Calendar. Both are reachable through the one Google account this
system has connected — Devora's calendar isn't a separate connection, she
shares it with the connected account (Google Calendar's own sharing
feature), so the tool reaches it the same way it reaches Uriel's own. Use
it whenever asked to schedule, book, or add something to "the calendar,"
"my calendar," or a meeting/appointment for a specific date and time.

## Arguments

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

## Two calendars, either one, from any chat

This is reachable from household, dm-with-uriel, or dm-with-partner alike —
there's no "wrong" chat to ask from, and no need to relay/forward a request
anywhere. If a request names both people ("check mine and Devora's" /
"put it on both calendars"), call the tool once per calendar named — never
a single combined call, and never silently drop the second one.

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

If a call targeting Devora's calendar specifically fails with an access
error (not a "not connected" link, but a real permission error), the most
likely cause is she hasn't shared her calendar with the connected account
yet — say that plainly rather than implying the whole tool is broken.
