---
title: 'Recurring Events'
type: 'feature'
created: '2026-08-18'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '510f3b27bb57df4e04544b83aba83d8a8aefc47d'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `create_calendar_event` only creates single-occurrence events — "every Thursday at 3pm" today requires the user (or agent) to ask for the same event created by hand, over and over.

**Approach:** Add an optional `recurrence` argument to `create_calendar_event` — a single RFC5545 `RRULE` string. The handler wraps it as `recurrence: [recurrenceArg]` in the Google Calendar API request body (Google's `Event.recurrence` field is an array of strings, not a bare string — confirmed by web search against `developers.google.com/workspace/calendar/api/v3/reference/events`). No new tool, no new dependency.

## Boundaries & Constraints

**Always:** `recurrence` is optional at the tool-call interface (a single RRULE string, e.g. `RRULE:FREQ=WEEKLY;BYDAY=TH`); the handler wraps it as an array (`recurrence: [recurrenceArg]`) only when building the outgoing API request body — never a bare string sent to Google. The confirmation text states the recurrence pattern actually set, sourced from Google's own response (`event.recurrence`, falling back to what was sent only if Google's response omits it) — same echo-preference pattern this file already uses for `attendees`. No recurrence argument given → behavior is byte-for-byte unchanged from the single-occurrence path (regression safety).

**Ask First:** None anticipated.

**Never:** No RRULE-shape validation — matches this file's existing precedent for `description`/`location` (zero validation, let Google's API reject a malformed RRULE with its own error, surfaced via the existing non-2xx error path). Do not touch the idempotency guard's existing recurring-candidate exclusion logic (`ev.recurrence || ev.recurringEventId`, Story 2.1 — already correct and untouched by this story). Do not implement editing or cancelling a single occurrence of a series (non-goal, `SPEC-google-calendar/SPEC.md`). Do not touch `update_calendar_event` or `delete_calendar_event`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| No recurrence given | `recurrence` omitted | Single-occurrence event created, unchanged from today | N/A |
| Valid RRULE given | `recurrence: 'RRULE:FREQ=WEEKLY;BYDAY=TH'` | Recurring event created (`recurrence: [arg]` in the request body); confirmation states the pattern Google's response echoes back | N/A |
| Empty string recurrence | `recurrence: ''` | Treated as falsy, same as `description`/`location` today — no `recurrence` field sent, single-occurrence event created | N/A |
| Google rejects a malformed RRULE | Google returns non-2xx for an invalid `RRULE` | Surfaced via the existing non-2xx error path — no new handling, no client-side validation | Existing generic-error-text path |
| A recurring create still trips the idempotency guard against an existing one-off | An unrelated existing (non-recurring) event matches instant+title+recency | Guard still blocks/asks as normal (Story 2.1) — creating with `recurrence` doesn't bypass or change the guard's own match logic | N/A |

</frozen-after-approval>

## Code Map

- `container/agent-runner/src/mcp-tools/calendar.ts:132-160` — `create_calendar_event`'s `inputSchema.properties`. Add `recurrence: { type: 'string', description: '...' }` after `location` (152), before `guests` (153) — not in `required` (159). The `description` string is the only thing the agent sees, so it must explain "a single RFC5545 RRULE line, e.g. `RRULE:FREQ=WEEKLY;BYDAY=TH`".
- `container/agent-runner/src/mcp-tools/calendar.ts:107-114` — `EventBody` interface. Add `recurrence?: string[]` (array — Google's actual shape).
- `container/agent-runner/src/mcp-tools/calendar.ts:163-169,198-207` — arg reads and `eventBody` construction. Mirror the existing `description`/`location` pattern exactly: read `const recurrence = args.recurrence as string | undefined;` alongside the other reads, then `if (recurrence) eventBody.recurrence = [recurrence];` alongside the other conditional assignments.
- `container/agent-runner/src/mcp-tools/calendar.ts:116-124` — `EventsInsertResponse` interface (the parsed POST response). Add `recurrence?: string[]` so the handler can read back what Google actually set.
- `container/agent-runner/src/mcp-tools/calendar.ts:285-309` — success-confirmation `lines` array. Add a recurrence line (only when set) sourced from `event.recurrence` first, falling back to `eventBody.recurrence` — same echo-preference already used for `attendees` at line 303 ("prefer what Google's response actually echoes back over what we sent").
- `container/agent-runner/src/mcp-tools/calendar.ts:325-347` — `CalendarEventItem` already has `recurrence?: string[]` (Story 2.1, incoming/list shape) — separate interface from `EventBody` (outgoing/insert shape), no duplication risk, nothing to change here.
- `container/agent-runner/src/mcp-tools/calendar.ts:94-105` — `EMAIL_RE`/`validateGuestEmails` is the only regex-validation precedent in this file, on a different field (emails) — confirms the "no RRULE validation" Boundary is consistent with how this file already treats free-form optional strings.
- `container/agent-runner/src/mcp-tools/calendar.test.ts:107-891` — `describe('create_calendar_event MCP tool', ...)`. `stubFetch`/`stubFetchThrows`/`stubFetchSequence`/`PRECHECK_EMPTY` helpers (lines 61-105) — reuse directly. Insert a new `describe('recurrence (spec cal-2.2)', ...)` sibling block after the existing `describe('idempotency guard (spec cal-2.1)', ...)` block (637-890), still inside the outer describe.
- `container/skills/calendar/SKILL.md:35-64` — `## create_calendar_event` section explicitly enumerates arguments as a bullet list (37-49). Add a `recurrence` (optional) bullet; bump the version (currently `1.3.1`).

## Tasks & Acceptance

**Execution:**
- [x] `container/agent-runner/src/mcp-tools/calendar.ts` -- add `recurrence` to `inputSchema`, `EventBody`, arg-read + conditional wrap-as-array assignment, `EventsInsertResponse`, and the confirmation-text line (Google's echoed value preferred over the sent value) -- implements AD-17
- [x] `container/agent-runner/src/mcp-tools/calendar.test.ts` -- new `describe('recurrence (spec cal-2.2)', ...)` block covering all 5 I/O Matrix rows, including a regression test asserting the no-recurrence path is byte-identical to pre-story behavior
- [x] `container/skills/calendar/SKILL.md` -- add the `recurrence` argument bullet to `create_calendar_event`'s section; bump version
- [x] `container/agent-runner/src/mcp-tools/calendar.ts` -- reject a non-string `recurrence` with a clear error, no fetch attempted; trim before the truthy check (whitespace-only treated as absent) -- patch (review loop 1)
- [x] `container/agent-runner/src/mcp-tools/calendar.ts` -- `Array.isArray` guard on `event.recurrence` before treating it as confirmed -- fixes a real uncaught-`TypeError` on a malformed (non-array) Google response (review loop 1)
- [x] `container/agent-runner/src/mcp-tools/calendar.ts` -- duplicate-confirmation question notes "recurring series" when `recurrence` is set -- patch (review loop 1)
- [x] `container/skills/calendar/SKILL.md` -- frontmatter `description:` mentions recurring/repeating for routing; body notes single-line-only, plain-language relay, `update_calendar_event` doesn't support it yet -- patch (review loop 1)
- [x] `container/agent-runner/src/mcp-tools/calendar.test.ts` -- 5 new tests: schema-contract pin, non-string rejection, whitespace-only, malformed-response no-crash, recurring-aware confirmation wording -- coverage (review loop 1)

**Acceptance Criteria:**
- Given a request naming a recurrence pattern, when `create_calendar_event` runs with a `recurrence` argument, then the outgoing request body carries `recurrence: [recurrenceArg]` (an array, per Google's actual API shape) and a real recurring event is created
- Given the event was created with a recurrence pattern, when the tool confirms back to the caller, then the confirmation states the pattern Google's own response echoes back, not merely what was sent
- Given no `recurrence` argument is given, when `create_calendar_event` runs, then behavior is unchanged from before this story — a single-occurrence event, no regression
- Given Google rejects the RRULE as malformed, when the POST returns a non-2xx, then it surfaces via the existing generic error path with no new client-side validation

## Spec Change Log

**Review loop 1 (patch, applied directly — no intent_gap/bad_spec, all mechanical):** three review agents (blind-hunter, edge-case-hunter, verification-gap) reviewed the diff. Verification-gap found nothing. Real, low-severity findings from the other two, all fixed in place: no type check on `recurrence` (a non-string value flowed straight into the request body); `recurrence` wasn't trimmed, so a whitespace-only string was sent as a bogus rule; the confirmation-echo logic's `event.recurrence?.length` check passed for a malformed non-array response (a plain string also has `.length`), which would then crash on `.join` — a real uncaught-`TypeError` bug, fixed with an explicit `Array.isArray` guard; the duplicate-confirmation question read identically for a one-off and a recurring create despite the bigger blast radius of confirming "anyway" on a series — added a note when `recurrence` is set; `SKILL.md`'s frontmatter `description:` (routing-relevant) didn't mention recurring/repeating events; no doc-comment explained the deliberate array(wire)-vs-string(argument) asymmetry on `EventBody`/`EventsInsertResponse.recurrence`; no test pinned the tool's own JSON-schema contract for the new argument. Six new tests added for previously-unverified paths. Findings deferred to `deferred-work.md` as genuinely out of this story's scope (per the frozen Boundaries' own "Never" list): `update_calendar_event` silently dropping a `recurrence` argument instead of rejecting it; `list_calendar_events` not indicating recurring status; the idempotency guard's precheck only covering a new recurring series' first occurrence, not later ones. Full suites re-verified: `bun test` (container) 439 pass/8 skip/0 fail; both typechecks clean.

## Design Notes

Confirmation text should read the recurrence value from `event.recurrence` (Google's own response), not from `eventBody.recurrence` (what was sent) — mirrors the existing `attendees` handling at line ~303, which already prefers the API's echo over the outgoing payload since that's what's actually true of the created event. Fall back to `eventBody.recurrence` only if Google's response happens to omit the field (defensive, matches this file's existing style elsewhere).

## Verification

**Commands:**
- `cd container/agent-runner && bun test src/mcp-tools/calendar.test.ts` -- expected: all existing tests still pass, new recurrence tests pass
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` -- expected: no type errors

## Suggested Review Order

**Recurrence handling (the core of the story)**

- Entry point: type/whitespace validation, and the array-wrap when building the request body.
  [`calendar.ts:197`](../../container/agent-runner/src/mcp-tools/calendar.ts#L197)

- The confirmation-echo logic, with the `Array.isArray` fix for a malformed Google response.
  [`calendar.ts:331`](../../container/agent-runner/src/mcp-tools/calendar.ts#L331)

- The duplicate-confirmation question's recurring-series note.
  [`calendar.ts:256`](../../container/agent-runner/src/mcp-tools/calendar.ts#L256)

**Docs**

- `recurrence` argument documented, with the single-line/update-not-supported caveats.
  [`SKILL.md:50`](../../container/skills/calendar/SKILL.md#L50)

**Tests (peripheral — coverage for every I/O Matrix row + the loop-1 patch findings)**

- The recurrence describe block: regression, echo-preference, malformed-response, and schema-contract tests.
  [`calendar.test.ts:892`](../../container/agent-runner/src/mcp-tools/calendar.test.ts#L892)
