---
title: "Update an Event on Uriel's or Devorah's Calendar"
type: 'feature'
created: '2026-08-18'
status: 'in-progress'
review_loop_iteration: 0
context: []
baseline_commit: '794087f'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Once an event exists (Story cal-1.2), there's no way to fix a mistake or reschedule it without deleting and recreating (deletion is a spec non-goal — not even available).

**Approach:** A new `update_calendar_event` MCP tool, same file, same shared plumbing as Stories cal-1.2/1.3. Depends on Story cal-1.3 (`list_calendar_events`) for event discovery — build cal-1.3 first (or in the same batch), since this tool's disambiguation path calls the same underlying search logic.

## Boundaries & Constraints

**Always:**
- New tool `update_calendar_event`, same file/convention.
- Two ways to target the event, both taking `calendar` (required):
  1. **`eventId` given directly** (the real Google event id, e.g. already known from a prior `list_calendar_events` response) — update proceeds immediately against that exact event, no search.
  2. **`eventId` omitted, `eventQuery` (free-text) + optionally `from`/`to` given instead** — internally searches the same way `list_calendar_events` does (reuse its search logic, don't duplicate). Exactly one match: proceeds directly. Zero matches: declines clearly. Two or more matches: presents a numbered candidate list (id, title, time) and asks the agent to re-call with the specific `eventId` — same disambiguation precedent as `spec-document-memory`'s CAP-2/CAP-3 (AD-7), always same-turn/same-container (no relay, per the pivot).
- At least one of `title`, `start`, `end`, `description`, `location` must be given to change — declines clearly if none are (nothing to update).
- `PATCH https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}` with only the changed field(s) in the body — never re-sends unrelated fields as if resetting them (a real `PATCH`, not a full replace).
- `start`/`end`, if given, go through the same `parseZonedToUtc`/`TIMEZONE` construction as `create_calendar_event` (AD-13) — if only one of `start`/`end` is given, the other is left untouched (Google's `PATCH` semantics already support partial event-body updates; don't fetch-then-resend the unchanged one unless the API actually requires both together — verify against a live call).
- Same gateway-error handling as the other two tools (AD-8).
- Confirmation is built from what Google's response actually echoes back (same precedent as `create_calendar_event`'s guest-confirmation fix) — never just restates the request as if it were guaranteed to have landed exactly that way.

**Ask First:**
- If Google's `events.patch` requires both `start` and `end` together even when only one changed (some calendar APIs do) — research and, if so, fetch the existing event's untouched field first rather than omitting it; only HALT if genuinely ambiguous after checking a live response.

**Never:**
- Never deletes/cancels an event (spec non-goal — no such tool exists at all).
- Never updates the wrong event on an ambiguous multi-match — always disambiguates first.
- Never a full-replace `PUT` when a partial `PATCH` is all that's needed.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Update by known eventId | `calendar`, `eventId`, one changed field | Real `PATCH`, only that field changes, rest of event unchanged | N/A |
| Update by search, one match | `calendar`, `eventQuery`, changed field(s) | Resolves to the one match, updates it | N/A |
| Update by search, zero matches | `calendar`, `eventQuery` matching nothing | Declines clearly | MCP error text |
| Update by search, multiple matches | `calendar`, `eventQuery` matching 2+ | Numbered candidate list (id/title/time), waits for a specific `eventId` re-call | N/A (not an error — a discovery response) |
| No changed field given | `calendar` + `eventId` only, nothing to change | Declines clearly | MCP error text |
| Devorah's calendar / not connected | Same as Stories cal-1.2/1.3 | Same AD-8 handling | MCP error text |

</frozen-after-approval>

## Code Map

- `container/agent-runner/src/mcp-tools/calendar.ts` — new `update_calendar_event`; reuse `list_calendar_events`'s search internals (extract a shared `searchEvents(calendarId, query, from, to)` helper both tools call, rather than `update_calendar_event` reimplementing the search).
- `container/agent-runner/src/mcp-tools/calendar.test.ts` — new tests.
- `container/skills/calendar/SKILL.md` — document `update_calendar_event`, including the eventId-vs-eventQuery choice and the candidate-list flow.

## Tasks & Acceptance

**Execution:**
- [ ] `container/agent-runner/src/mcp-tools/calendar.ts` -- `update_calendar_event` tool; shared search helper factored out of `list_calendar_events`
- [ ] `container/agent-runner/src/mcp-tools/calendar.test.ts` -- bun:test coverage for the I/O matrix (mocked `fetch`)
- [ ] `container/skills/calendar/SKILL.md` -- document the new tool

**Acceptance Criteria:**
- Given the story is complete, when `cd container/agent-runner && bun test` runs, then all tests pass using mocked `fetch`.
- Given a real container, when a user asks to reschedule/edit a real event (found via search or a known id), then the change lands correctly on the real calendar and nothing else about the event changes — verify live once implemented.

## Spec Change Log

(none yet)

## Design Notes

Google's `events.patch`: `PATCH https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}` — same auth/base-URL family as `events.insert`/`events.list`, already exercised live in Stories cal-1.2/1.3.

## Verification

**Commands:**
- `cd container/agent-runner && bun test`
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
- `./container/build.sh build`

## Suggested Review Order

(filled in at story completion)
