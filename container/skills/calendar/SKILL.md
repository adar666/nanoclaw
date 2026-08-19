---
name: calendar
description: >-
  Create, read, update, and delete real events on this group's configured
  Google Calendars (at minimum Uriel's own; an operator may add more, e.g.
  Devorah's) via create_calendar_event, list_calendar_events,
  update_calendar_event, and delete_calendar_event. Use whenever asked to
  schedule, book, put something on the calendar, check what's coming up,
  answer "when is X", reschedule/edit an existing event, cancel/delete
  one, or set up a recurring/repeating event (e.g. a weekly standup) — for
  any configured calendar, not just this agent's own identity. Also covers
  the OneCLI connect-link flow for a not-yet-connected calendar (create and
  delete each block on their own built-in confirmation — nothing to
  orchestrate), and the deliberate distinction from second-brain's own,
  unrelated Google OAuth (never disclose that one).
metadata:
  author: nanoclaw
  version: "1.11.0"
---

# Calendar

Four tools operate on **this group's configured calendars** — at minimum
Uriel's own, and possibly more (e.g. Devorah's) if an operator has added
them (see "More than two calendars" below). All configured calendars are reachable
through the one Google account this system has connected — a non-Uriel
calendar isn't a separate connection, it's shared with the connected
account (Google Calendar's own sharing feature), so every tool reaches it
the same way it reaches Uriel's own.

- `create_calendar_event` — schedule something new.
- `list_calendar_events` — answer "what's on my/their calendar" or
  "when is X" questions. **Always** use this instead of answering from
  memory or a guess — calendar state changes and you don't have it cached.
- `update_calendar_event` — fix a mistake or reschedule an existing event.
- `delete_calendar_event` — cancel/remove an event. Irreversible — always
  requires an explicit confirmation step first, see below.

**If a user names a calendar you don't recognize, try the tool anyway —
don't assume it doesn't exist and don't refuse from memory.** This
group's actual calendar set is config-driven (see "More than two
calendars" below) and can change without you knowing — the only source
of truth is the tool call itself, which validates the name for real and
tells you the current full set if it's wrong. Declining or asking "are
you sure?" before even trying is worse than just calling the tool: a
real "Unknown calendar" error (with the real list) is more useful to the
user than your guess about what's configured.

## Household people (names, emails)

Sender identity and guest-email resolution (below) both read from the same
household people file — its actual path **depends on which group is
asking**, since each group's memory is isolated:

- The `household` group has it natively, at its own
  `/workspace/agent/memory/household/people.md`.
- `dm-with-uriel` and `dm-with-partner` don't have their own copy — they get
  a **read-only mount** of the same file, at
  `/workspace/extra/household-shared/people.md`.
- Check whichever of the two paths actually exists in *your* workspace. If
  neither does, this group has no way to resolve names to emails — say so
  rather than guessing.

## create_calendar_event

- `calendar` (required) — one of this group's configured calendar names
  (at minimum `"uriel"`; see "More than two calendars" below for any
  others, e.g. `"devorah"`). Pick based on who the event is actually for, not who's
  asking — an unqualified "my calendar" in the shared household chat must
  be resolved against the real sender's identity (see "Household people"
  above), never defaulted to Uriel. If it's genuinely unclear whose
  calendar is meant, ask — don't guess.
- `title` (required) — event title.
- `start` / `end` (required) — naive local wall-clock time, no offset or
  `Z`, e.g. `"2026-08-20T15:00:00"`. This is interpreted in this group's own
  configured timezone — write times the way a person would say them
  ("3pm Wednesday"), not converted to UTC yourself.
- `description`, `location` (optional).
- `recurrence` (optional) — a single RFC5545 `RRULE` line to make this a
  repeating event, e.g. `"RRULE:FREQ=WEEKLY;BYDAY=TH"` for every Thursday.
  Omit for a single, one-off event (the default, unchanged behavior). One
  line only — don't combine it with `EXDATE`/`RDATE` lines, not supported.
  If `start`'s day doesn't match the rule (e.g. `start` on a Monday with
  `BYDAY=TH`), Google may shift the actual first occurrence — when relaying
  the confirmation, translate the raw `RRULE:...` into plain language
  ("every Thursday") rather than reading it back verbatim. No validation on
  the shape beyond requiring a string — a malformed RRULE surfaces as a
  real error from Google, not a client-side check. There is currently no
  way to add/change/remove recurrence on an *existing* event via
  `update_calendar_event` — recreate the event instead.
- `guests` (optional) — array of email addresses to invite. If someone
  names a guest by first name, nickname, or Hebrew name only (not an
  email) — this group's own memory file records people by whichever name
  form they actually use, not a canonical English first name — resolve it
  yourself against the household people file ("Household people" above)
  *before* calling this tool, the same resolve-yourself approach as the
  sender-identity rule above, never a hardcoded name. (If neither path
  exists in this group's workspace, skip straight to asking for the
  email.) A clear
  single match resolves to that person's known email with no extra turn
  spent. A recognized person with *no* email recorded (this file doesn't
  guarantee one for everyone) — treat the same as no match: ask directly,
  don't invent one. More than one plausible match: present a numbered
  candidate list — this is a persona-level judgment call against free
  text, not the tool-backed candidate list `update_calendar_event`/
  `delete_calendar_event` build from real Google data elsewhere in this
  skill, but the same never-guess principle applies. No match at all: ask
  for the email directly rather than guessing or silently dropping the
  guest. More than one guest to resolve in one request: resolve each
  independently, and if more than one needs a question, ask them together
  in one turn rather than one at a time. Whatever you resolve, relay which
  email each name mapped to along with the rest of the confirmation (see
  below) — and remember a real guest invite emails that person, so this
  isn't a no-consequence guess to get wrong. Only pass this tool a real
  email address — it validates the shape and rejects anything else with a
  clear error, which is the floor this behavior sits on top of, not a
  substitute for resolving proactively. `update_calendar_event` has no
  `guests` argument at all today — it can't add, change, or remove
  attendees on an existing event.

A successful call returns the real event's details plus its Google-assigned
`htmlLink`. Always relay that link and the details actually set back to the
user — never invent or describe a confirmation of your own; the tool's
response is the only source of truth for what was actually created.

**May block on a "possible duplicate" confirmation first.** Before creating,
the tool checks whether a non-recurring event with the same title and start
time already exists on that calendar, created in roughly the last 10
minutes — a retried or racing request must not silently double-book. If it
finds one, it blocks (same yes/no-card mechanism as `delete_calendar_event`)
asking whether to create anyway or skip. This is one call, not a flow you
orchestrate — just call the tool; it either creates the event, or shows the
user the possible duplicate and waits for their answer.

## list_calendar_events

- `calendar` (required) — same configured-calendar-name resolution rule as above.
- `from` / `to` (optional) — same naive local wall-clock shape as
  create's `start`/`end`. Omit both for the default window: today through
  7 days out. Give just `from` to shift the window; give both for an exact
  range.
- `query` (optional) — free-text search (Google's own search across
  title/description/location), e.g. `"dentist"` for "when's my dentist
  appointment".

Returns each matching event's real `id`, title, time, and location if set,
plus `(recurring)` when the event is one occurrence of a repeating series
(vs. a genuine one-off) — mention that when it's relevant, e.g. before
updating or deleting one occurrence, since the user may mean the whole
series rather than just that instance. Keep the `id` around if the next
step is an update — passing it as `eventId` to `update_calendar_event`
skips a redundant search. "No events found" is a real, plain answer — never
paper over it with a guess. A request naming both people ("what's on mine
and Devorah's") is one call per calendar — never a single combined call.

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
partial update, not a recreate). No `guests` argument exists here — this
tool can't add, change, or remove attendees on an existing event; say so
if asked, rather than silently ignoring the request. This tool never
deletes/cancels an event — use `delete_calendar_event` for that.

The confirmation reflects what Google's response actually echoes back, not
just a restatement of the request — relay that, same as `create_calendar_event`.

If both `start` and `end` are given (moving the event to a new time), the
tool checks whether that new window overlaps another event already on the
same calendar. If it does, the tool itself blocks and asks the user to
confirm — a real yes/no card, same mechanism as `delete_calendar_event`'s
confirmation — before actually moving it. Just call `update_calendar_event`
as usual; relay the result either way, don't pre-empt it with your own
"heads up, that might conflict" message. A single-sided time change (only
`start` or only `end`, not both) skips this check — there's no new resolved
window to compare against.

## delete_calendar_event

Target the event the same way as `update_calendar_event` — `eventId`
directly, or `eventQuery` (+ optional `from`/`to`) with the same
disambiguation (zero matches declines, one resolves, two or more return a
numbered candidate list, nothing deleted).

Once exactly one event is resolved, **the tool itself asks the user to
confirm** — a real yes/no card, the same mechanism as `ask_user_question` —
and only issues the actual delete if they say yes. This is one call, not a
flow you orchestrate: you don't call it once to preview and again to
confirm, and there is no `confirm` argument to set. Just call
`delete_calendar_event` with a target; it blocks, shows the user the
resolved event, and either deletes it or doesn't, depending on their
answer. Relay the result — don't send your own extra "are you sure?"
message first, the tool's card already is that question.

## This group's configured calendars, any of them, from any chat

All four tools are reachable from household, dm-with-uriel, or
dm-with-partner alike — there's no "wrong" chat to ask from, and no need to
relay/forward a request anywhere. If a request names more than one calendar
("check mine and Devorah's" / "put it on both calendars"), call the tool
once per calendar named — never a single combined call, and never silently
drop any of them.

### More than one calendar

`"uriel"` (the connected account's own calendar) is the only calendar name
built into every install. Every other name — including `"devorah"` — is
config-added, the same mechanism, whether it's the first additional
calendar or the fifth. If a user explicitly asks you to add a calendar,
call the `add_calendar` self-mod tool directly (`add_calendar({ name:
"family", calendarId: "family-cal@group.calendar.google.com", reason:
"..." })`) — same admin-approval flow as `install_packages`/`add_mcp_server`
(see the `self-customize` skill), and once approved the container restarts
itself automatically, no manual follow-up needed. This is not something to
run unprompted, only in direct response to a user's own request. The older
`ncl groups config add-calendar --id <group-id> --name <name> --calendar-id
<calendar-id>` path (followed by a group restart) still works too, but
requires a human at a terminal — `add_calendar` doesn't. Once added, the
new name works exactly like `"uriel"` in every one of these four tools —
same resolution, same sharing mechanism, nothing special
about it being a later addition. If a call names a calendar that doesn't
resolve (not added, added but the group hasn't been restarted yet, or —
for `"devorah"` specifically — simply not configured on this install),
the tool declines clearly and lists every calendar name it currently
recognizes — relay that list rather than guessing which name was meant.

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

If any of the four tools returns an error containing a connect link (the
gateway's `connect_url`), that's the OneCLI connection for *these tools* —
present it plainly, the same as the `onecli-gateway` skill's general rule
for any not-connected app:

> To connect Google Calendar, open this link: [connect_url]

Then let the user know you'll retry once they've connected.

If a call targeting a non-Uriel calendar (Devorah's, or any operator-added
calendar) fails with an access error (not a "not connected" link, but a
real permission error), the most likely cause is that calendar hasn't been
shared with the connected account yet — say that plainly rather than
implying the whole tool is broken.
