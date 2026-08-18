---
title: 'Idempotency Guard on Event Creation'
type: 'feature'
created: '2026-08-18'
status: 'done'
review_loop_iteration: 1
context: []
baseline_commit: '2d911360de9e2917d8dcd932c2ba63c17f90adf8'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A retried or racing `create_calendar_event` call (network hiccup, agent retry, two chat surfaces firing close together) can silently double-book the same event — no guard exists today.

**Approach:** Before the `POST`, run a `GET` (reusing `fetchEvents`) bracketed around the new event's own start/end window. On a timezone-normalized-instant + title match against a non-recurring event created in the last 10 minutes, block via `askUserQuestion` in-process ("create anyway" vs "skip") before ever issuing the `POST` — never a `confirm`-style argument the agent could self-authorize past.

## Boundaries & Constraints

**Always:** A match requires: same `calendarId` + candidate's `start.dateTime`/`start.timeZone` resolving to the same instant as the new event's start (never raw-string comparison) + case-insensitive-trimmed title match + candidate is not part of any recurring series (excludes both a master event, which carries `recurrence`, AND an expanded instance, which carries `recurringEventId` instead — `fetchEvents` already sets `singleEvents=true`, so Google returns instances, not masters, and instances never carry `recurrence`; excluding on `recurrence` alone is a no-op against real API responses) + candidate `created` within the last 10 minutes. On a match, call a new `createHooks.confirmCreation` seam (mirrors `deleteHooks.confirmDeletion`) which calls `askUserQuestion.handler(...)` in-process, offering "create anyway" / "skip, likely already exists." Reuse `fetchEvents` for the pre-check `GET` — same AD-8 gateway-error/not-connected handling, same 30s timeout — never a second, parallel error-handling path. Every branch that resolves the guard (duplicate found + confirmed, duplicate found + skipped) logs an outcome via the existing `log(...)` convention this file already uses for every other branch (create success, update, delete, gateway errors) — a silent guard is undiagnosable in container logs.

**Ask First:** None anticipated.

**Never:** Not a guarantee under true concurrency (best-effort only — two genuinely-simultaneous calls can both pass the pre-check before either `POST` lands; do not claim otherwise in comments/docs). Do not touch the `calendar` argument's `CALENDAR_IDS` shape (Story 2.3's registry work). Do not touch the `recurrence` field itself (Story 2.2) — only exclude recurring candidates from matching. Do not build a generic/reusable dedup utility beyond this one tuple.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| No recent duplicate | Pre-check GET returns no matching event | `POST` proceeds normally, event created | N/A |
| Duplicate found, user confirms | Matching event exists; user picks "create anyway" | `POST` proceeds, event created | N/A |
| Duplicate found, user declines | Matching event exists; user picks "skip" | No `POST` issued; `ok()` message explains why | N/A |
| Same local time, different `timeZone` | Candidate's `start.timeZone` differs from new event's | Correctly NOT a match (different real instant) — `POST` proceeds | N/A |
| Recurring series master | Candidate has `recurrence` set | Excluded from matching — `POST` proceeds | N/A |
| Recurring series instance (the realistic case — `fetchEvents` uses `singleEvents=true`) | Candidate has `recurringEventId` set, no `recurrence` | Excluded from matching — `POST` proceeds | N/A |
| Match outside recency window | Candidate `created` > 10 minutes ago | Not treated as a match — `POST` proceeds | N/A |
| Candidate `created` in the future (clock skew) | Candidate `created` is after "now" | Not treated as a match (negative age fails the recency check) — `POST` proceeds | N/A |
| Pre-check GET truncated (`nextPageToken` present) | `fetchEvents` returns `truncated: true` | Guard still runs against the returned page; outcome is logged as best-effort (a duplicate past the cutoff can be missed) | N/A |
| Pre-check GET fails / not connected | `fetchEvents` returns `{ error }` (401/403/`app_not_connected`) | Surfaced as-is via existing AD-8 path; `POST` never attempted | Reuse `fetchEvents`'s existing error return, no new handling |

</frozen-after-approval>

## Code Map

- `container/agent-runner/src/mcp-tools/calendar.ts:126` — `export const createCalendarEvent: McpToolDefinition`, handler at line 162. `EventBody` built lines 198–207; the raw `POST fetch()` is inline at lines 209–219 — insert the pre-check + confirmation branch after `eventBody` construction (line 198), before that `fetch()`.
- `container/agent-runner/src/mcp-tools/calendar.ts:402` — `fetchEvents(calendarId, { timeMinIso, timeMaxIso, q? })`: existing GET helper with AD-8 error handling + 30s timeout. Reuse directly, bracketing `timeMin`/`timeMax` around the new event's own `startUtc`/`endUtc` (already computed lines 190–201 via `parseZonedToUtc(start, TIMEZONE)`).
- `container/agent-runner/src/mcp-tools/calendar.ts:886` — `defaultConfirmDeletion(question)` + `container/agent-runner/src/mcp-tools/interactive.ts:37` `askUserQuestion` — the exact in-process confirmation pattern to mirror. `deleteHooks` exported at line 904 as the testability seam; add an analogous `createHooks = { confirmCreation: defaultConfirmCreation }`.
- `container/agent-runner/src/mcp-tools/calendar.ts:999–1005` — delete handler's confirm/branch shape (`if ('error' in confirmResult) return confirmResult.error; if (!confirmResult.confirmed) return ok(...)`) — mirror for create's "create anyway / skip" branch.
- `container/agent-runner/src/mcp-tools/calendar.ts:49,53` — `ok(text)` / `err(text)` response shape, already used throughout.
- `container/agent-runner/src/timezone.ts:75` — `TIMEZONE` (module-level constant, `resolveContainerTimezone()`), imported at calendar.ts:27 alongside `parseZonedToUtc`, `formatLocalTime`. Use for instant-comparison, never raw string comparison of `dateTime`.
- `container/agent-runner/src/mcp-tools/calendar.test.ts` — `bun:test`; `stubFetch`/`stubFetchSequence`/`stubFetchThrows` (lines 41/68/55) for mocking `fetch`; `stubConfirmDeletion` (line 30) is the pattern to mirror as `stubConfirmCreation` once `createHooks.confirmCreation` exists. `describe('create_calendar_event MCP tool', ...)` starts at line 84 — add new tests there.

- `container/agent-runner/src/mcp-tools/calendar.ts:402` `fetchEvents` sets `singleEvents=true` (confirmed by reading its implementation directly) — per Google Calendar API semantics this means `events.list` returns expanded recurring **instances**, never the master event, and an instance's own `recurrence` field is always absent; the field to check is `recurringEventId` (present on every instance) instead of, or alongside, `recurrence` (present only on a master, which this call path never returns). `CalendarEventItem` needs a `recurringEventId?: string` field added alongside the existing `recurrence?: string[]`.
- `container/agent-runner/src/mcp-tools/calendar.test.ts:288,305,322,343,506,522` — the six existing POST-error-path tests for `create_calendar_event`, each still using single-response `stubFetch`. These must move to `stubFetchSequence` with a leading empty precheck response, same as the success-path tests already updated in review loop 0.
- `container/skills/calendar/SKILL.md` — version `1.2.1` as of review loop 0; `delete_calendar_event`'s section is the model for how to document a tool that can block on a confirmation card.

## Tasks & Acceptance

**Execution:**
- [x] `container/agent-runner/src/mcp-tools/calendar.ts` -- add pre-check `GET` (via `fetchEvents`), match logic (instant + title + not-part-of-any-recurring-series [`recurrence` OR `recurringEventId`] + 10-min recency with a clock-skew-safe lower bound) + `CalendarEventItem.recurringEventId?: string` field + `createHooks.confirmCreation` seam + branch before the `POST` -- implements AD-16, corrected for real `singleEvents=true` API shape (review loop 1)
- [x] `container/agent-runner/src/mcp-tools/calendar.ts` -- `log(...)` an outcome on both guard-resolved branches (duplicate confirmed-anyway, duplicate skipped) and when `precheck.truncated` is true, matching this file's existing log convention on every other branch -- diagnosability (review loop 1)
- [x] `container/agent-runner/src/mcp-tools/calendar.ts` -- confirmation question text states the candidate's actual age (e.g. "created N minutes ago") instead of a hardcoded "a few minutes ago" -- accuracy (review loop 1)
- [x] `container/agent-runner/src/mcp-tools/calendar.test.ts` -- add `stubConfirmCreation` helper + tests for all I/O Matrix scenarios (including the corrected recurring-instance case, the future-`created` clock-skew case, and the truncated-precheck case) -- coverage for AD-16's match tuple and confirmation branch
- [x] `container/agent-runner/src/mcp-tools/calendar.test.ts` -- update the 6 pre-existing `create_calendar_event` POST-error-path tests (401/403 connect_url, 403 no-setup-url, non-2xx generic, fetch-throws, timeout) to `stubFetchSequence([{status:200,body:{items:[]}}, <original error response>])` and assert on `calls[1]`, not `calls[0]` -- without this, the new pre-check GET silently absorbs these tests and the POST's own error handling ships untested (review loop 1, verification-gap finding)
- [x] `container/skills/calendar/SKILL.md` -- add a short note to `create_calendar_event`'s section stating it may block on a "possible duplicate" confirmation card before returning a created event, mirroring how `delete_calendar_event`'s section already documents its own confirmation-blocking behavior -- an agent relying on the skill doc alone currently has no warning (review loop 1, verification-gap finding)
- [x] `container/agent-runner/src/mcp-tools/calendar.ts` -- `fetchEvents` gained an optional `notConnectedAction` param (default `'list events'`); the pre-check `GET` passes `'create the event'` so a not-connected error during create doesn't say "Can't list events" -- patch (review loop 2)
- [x] `container/agent-runner/src/mcp-tools/calendar.ts` -- `findDuplicateCandidate`'s recency check now explicitly rejects `Number.isNaN(ageMs)` (an unparseable `created` string previously bypassed both bounds and false-matched) -- correctness patch (review loop 2)
- [x] `container/agent-runner/src/mcp-tools/calendar.ts` -- `formatConfirmationSummary` trims `ev.summary` before display, so a whitespace-variant match (already accepted by the guard) doesn't show stray spaces in the user-facing card -- patch (review loop 2)
- [x] `container/skills/calendar/SKILL.md` -- top-level `description:` frontmatter updated to mention create also blocks on its own confirmation (previously only delete was mentioned there, though the body section was already correct) -- patch (review loop 2)
- [x] `container/agent-runner/src/mcp-tools/calendar.test.ts` -- 5 new tests: precheck `timeMin`/`timeMax` window assertion, precheck network-throw (with corrected not-connected wording), multi-item scan past a non-matching candidate, missing-`summary` candidate, unparseable-`created` candidate -- coverage (review loop 2)

**Acceptance Criteria:**
- Given a create request whose `calendarId`, timezone-normalized start instant, and case-insensitive-trimmed title all match a non-recurring event already on that calendar, `created` within the last 10 minutes, when `create_calendar_event` runs, then it calls `askUserQuestion` in-process before any `POST`, and only proceeds on an explicit "create anyway" answer
- Given the match check compares start times across different `timeZone` values, when two events share the same local numerals but different real instants, then they are never false-matched
- Given a candidate event is part of a recurring series — whether it's the master (`recurrence` set) or an expanded instance (`recurringEventId` set, the realistic case since `fetchEvents` uses `singleEvents=true`) — when the match check runs, then it is excluded from matching entirely
- Given the pre-check `GET` itself fails or returns a not-connected/permission error, when `create_calendar_event` runs, then that error surfaces via the existing `fetchEvents` error path and no `POST` is attempted

## Spec Change Log

**Review loop 1 (intent_gap):** Blind-hunter review found that the original Boundaries text ("candidate has no `recurrence` field") is a no-op against real Google Calendar API responses — `fetchEvents` sets `singleEvents=true`, so a recurring event's occurrences are returned as expanded *instances* carrying `recurringEventId`, never as the master event carrying `recurrence`. Root cause lived inside `<frozen-after-approval>`, so this is an intent_gap: code was reverted to `baseline_commit`, the Boundaries text and I/O Matrix were amended to exclude on `recurrence` OR `recurringEventId`, and every other finding from the same review round (verification-gap: 6 pre-existing POST-error tests silently repointed at the wrong fetch call, missing SKILL.md note; blind-hunter: missing outcome logging, inaccurate "a few minutes ago" wording, untested clock-skew/recency-boundary/truncated-flag cases) was folded into Tasks & Acceptance in the same pass to avoid a second loopback for what are otherwise mechanical patch-level fixes.

**KEEP (worked well, must survive re-derivation):** the `createHooks.confirmCreation` seam mirroring `deleteHooks.confirmDeletion` exactly (same in-process `askUserQuestion.handler` call, same testability pattern); reusing `fetchEvents` for the pre-check `GET` rather than a new fetch call (inherits AD-8 error handling and the 30s timeout for free); reusing `formatConfirmationSummary`/`formatEventLine` for the human-facing vs. agent-facing text split; the instant-based (never raw-string) `dateTime` comparison; the case-insensitive-trimmed title match; the 10-minute recency window and its `ageMs >= 0` clock-skew guard (the guard's *presence* was correct, only its *test coverage* was missing).

**Review loop 2 (patch, applied directly — no intent_gap/bad_spec, all mechanical):** three fresh review agents re-reviewed the loop-1 diff. Real, low-severity findings, all fixed in place: `fetchEvents`' hardcoded `'list events'` not-connected wording leaked into create's precheck error (added a `notConnectedAction` param); an unparseable candidate `created` string produced `NaN` age that bypassed both recency bounds instead of correctly excluding the candidate (added an explicit `Number.isNaN` check); `formatConfirmationSummary` displayed an untrimmed title verbatim for a whitespace-variant match (added `.trim()`); the skill's top-level `description:` frontmatter still only mentioned delete's confirmation-blocking behavior (updated to mention create too, body section was already correct). 5 tests added for previously-unverified paths: the precheck's `timeMin`/`timeMax` window, a network-level precheck failure, a multi-item scan past a non-matching candidate, a missing-`summary` candidate, and the unparseable-`created` regression. Findings rejected as duplicates of items already in `deferred-work.md` from loop 0 (double round-trip cost, internal-whitespace title collapsing, confirmation card not showing the new event's own details, missing try/catch around `askUserQuestion.handler`, `update_calendar_event` lacking an analogous guard) — no new entries. One new low-priority observation added to `deferred-work.md`: a zero-duration candidate landing exactly on the pre-check's exclusive `timeMin` bound would be missed (rare, not worth a design change now). Full suites re-verified after loop 2: `bun test` (container) 428 pass/8 skip/0 fail; `pnpm test` (host, vitest) 1384 pass/110 files; both typechecks clean.

## Design Notes

`fetchEvents`'s `q` param (a free-text Google Calendar search) is **not** used for the match — it's an unreliable substring/fuzzy match on Google's side. Instead, bracket `timeMin`/`timeMax` tightly around the new event's own `[startUtc, endUtc]` window (no `q`), then do the case-insensitive-trimmed title match and 10-minute `created` recency check locally in JS against the returned `events[]`. This keeps the match logic fully local, auditable, and independent of Google's search semantics.

## Verification

**Commands:**
- `cd container/agent-runner && bun test src/mcp-tools/calendar.test.ts` -- expected: all existing tests still pass, new idempotency-guard tests pass
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` -- expected: no type errors

## Suggested Review Order

**Guard mechanics (the core of the story)**

- Entry point: where the guard runs, between validation and the real `POST`.
  [`calendar.ts:216`](../../container/agent-runner/src/mcp-tools/calendar.ts#L216)

- The match tuple: instant + title + not-recurring (master or instance) + recency, with the NaN clock-skew fix.
  [`calendar.ts:522`](../../container/agent-runner/src/mcp-tools/calendar.ts#L522)

- The structural confirmation function — mirrors `defaultConfirmDeletion`, no `confirm` arg for the agent to self-authorize.
  [`calendar.ts:985`](../../container/agent-runner/src/mcp-tools/calendar.ts#L985)

**Shared-helper changes (ripple effects into `list_calendar_events`/gateway errors)**

- `fetchEvents` gains an optional not-connected action label so create's precheck error says the right verb.
  [`calendar.ts:457`](../../container/agent-runner/src/mcp-tools/calendar.ts#L457)

- Human-facing confirmation text now trims the candidate's title before display.
  [`calendar.ts:920`](../../container/agent-runner/src/mcp-tools/calendar.ts#L920)

**Docs**

- `create_calendar_event` documented as blocking on its own confirmation, mirroring delete's existing note.
  [`SKILL.md:56`](../../container/skills/calendar/SKILL.md#L56)

**Tests (peripheral — coverage for every I/O Matrix row + the 6 corrected pre-existing POST-error tests)**

- The idempotency-guard describe block: every matrix row, including the loop-2 additions (window bracketing, network throw, multi-item scan, no-summary, unparseable `created`).
  [`calendar.test.ts:637`](../../container/agent-runner/src/mcp-tools/calendar.test.ts#L637)
