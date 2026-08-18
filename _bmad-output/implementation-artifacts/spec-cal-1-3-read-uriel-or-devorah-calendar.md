---
title: "Read Uriel's or Devorah's Calendar"
type: 'feature'
created: '2026-08-18'
status: 'in-progress'
review_loop_iteration: 0
context: []
baseline_commit: '794087f'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** There's no way to ask the agent what's on either calendar. CAP-2's success criterion — "answers from real, current calendar data, never memory or a guess" — has no tool to back it yet.

**Approach:** A new `list_calendar_events` MCP tool in the same `calendar.ts` file, reusing `create_calendar_event`'s `calendar`→`calendarId` mapping, timezone conversion (`parseZonedToUtc`/`TIMEZONE`), gateway-error handling, and TLS shim — this is purely additive to what Story cal-1.2 already built and live-verified, no new plumbing.

## Boundaries & Constraints

**Always:**
- New tool `list_calendar_events`, same file, same `McpToolDefinition`/`registerTools()` convention.
- Arguments: `calendar` (required, `uriel`|`devorah`, same `CALENDAR_IDS` mapping `create_calendar_event` already has — factor it into a shared constant/function both tools use, don't duplicate the mapping), `from`/`to` (optional, naive local wall-clock, same shape as `create_calendar_event`'s `start`/`end` — default to "today" through "7 days from now" in the group's own timezone when omitted, a reasonable default for "what's coming up"), `query` (optional free-text string, mapped to Google's own `q` search parameter for "when is X"-style questions).
- Calls `GET https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events` with `timeMin`/`timeMax` (from the resolved `from`/`to`, ISO + explicit offset, same construction as `create_calendar_event`'s `dateTime`) and `q` when given, `singleEvents=true`/`orderBy=startTime` (so a recurring event—if one ever exists, even though creating one is out of scope—lists as individual occurrences in chronological order, not the recurrence master).
- Response lists each matching event's title, start/end (formatted via the group's existing timezone display convention, not raw UTC), location if present, and its real Google `id` (needed by `update_calendar_event`, Story cal-1.5, to target a specific event without re-searching).
- No events found: says so plainly — never a guess, never silence.
- Same gateway-error handling as `create_calendar_event` (AD-8): not-connected surfaces `connect_url`; a real permissions/API error (e.g. Devorah's calendar not yet shared) surfaces as-is, never relabeled.
- A request naming both calendars ("what's on mine and Devorah's") is one tool call per calendar (AD-11) — this is agent/persona behavior (SKILL.md), not tool-level logic; the tool itself only ever queries one calendar per call.

**Ask First:**
- If `events.list`'s actual response shape differs materially from what's expected (missing fields, unexpected pagination behavior for a small result set) — adapt; only HALT if genuinely ambiguous after checking a live response.

**Never:**
- Never adds a Google API client library.
- Never silently caps/truncates results without saying so if there happen to be more events than fit a reasonable single response (a `maxResults` bound is fine — Google defaults to 250 — but if hit, say results were capped rather than silently showing a partial list as if it were complete).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| List today's events | `calendar: uriel`, no `from`/`to` | Real events for the default window (today→+7d), each with id/title/time/location | N/A |
| List a specific range | `calendar`, `from`, `to` given | Real events in that exact range | N/A |
| Free-text search | `calendar`, `query: "dentist"` | Real events matching Google's own `q` search | N/A |
| No matching events | Valid range, nothing found | Says so plainly | N/A |
| Devorah's calendar not yet shared | `calendar: devorah`, no writer/reader access | Real `403` surfaced as-is (not "not connected") | MCP error text |
| Calendar not connected at all | Gateway `401`/`403` with `connect_url` | Surfaced per AD-8 | MCP error text |

</frozen-after-approval>

## Code Map

- `container/agent-runner/src/mcp-tools/calendar.ts` — factor `CALENDAR_IDS` (currently a private const) into something both `create_calendar_event` and the new `list_calendar_events` reference — no duplication.
- Same file — reuse `TIMEZONE`, `parseZonedToUtc`, `extractSetupUrl`, `notConnectedMessage` (generalize the wording slightly if it's create-specific), the `eventsUrl`-style URL builder (extend for the `events.list` query-param shape), and the `AbortSignal.timeout` pattern.
- `container/agent-runner/src/mcp-tools/calendar.test.ts` — new tests alongside the existing `create_calendar_event` ones.
- `container/skills/calendar/SKILL.md` — document `list_calendar_events`.

## Tasks & Acceptance

**Execution:**
- [ ] `container/agent-runner/src/mcp-tools/calendar.ts` -- `list_calendar_events` tool; shared `CALENDAR_IDS` factored out
- [ ] `container/agent-runner/src/mcp-tools/calendar.test.ts` -- bun:test coverage for the I/O matrix (mocked `fetch`)
- [ ] `container/skills/calendar/SKILL.md` -- document the new tool

**Acceptance Criteria:**
- Given the story is complete, when `cd container/agent-runner && bun test` runs, then all tests pass using mocked `fetch`.
- Given a real container with both calendars reachable (already true — Story cal-1.2 live-verified this), when a user asks what's on either calendar, then real events come back with correct details — verify live once implemented.

## Spec Change Log

(none yet)

## Design Notes

Google's `events.list` real endpoint: `GET https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events?timeMin=...&timeMax=...&q=...&singleEvents=true&orderBy=startTime` — confirmed shape from the same API family already used for `events.insert` (Story cal-1.2), no new research needed beyond this one endpoint's query-param names.

## Verification

**Commands:**
- `cd container/agent-runner && bun test`
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
- `./container/build.sh build`

## Suggested Review Order

(filled in at story completion)
