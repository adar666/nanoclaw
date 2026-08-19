# Epic 2 Context: Calendar Hardening & Extensions

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Epic 1 shipped the core Google Calendar loop (create, read, update, delete on Uriel's or Devorah's calendar from chat). Epic 2 hardens and extends that loop without touching its core mechanism: it guards event creation against silent duplicates, adds recurring-event support, opens the calendar set beyond the original two people via a config-driven registry, and auto-resolves guests the agent already half-knows from household memory. None of this blocks anything already shipped in Epic 1 — all four stories extend the existing `calendar.ts` tools in place.

## Stories

- Story 2.1: Idempotency guard on event creation
- Story 2.2: Recurring events
- Story 2.3: Calendars beyond Uriel's and Devorah's
- Story 2.4: Automatic guest-list validation against household memory

## Requirements & Constraints

- A duplicate or retried `create_calendar_event` call must never silently double-book — it must decline, dedupe, or ask.
- A user must be able to create a recurring event ("every Thursday at 3pm") through the same tool used for single events.
- A calendar beyond the original two named people must be reachable through the same four tools, addable via configuration, never a code change.
- A guest named by first name only (not a full email) must be checked against household memory automatically, not only when the agent happens to already have it in context.
- Google Calendar only; credentials never pass through chat, code, or env vars — routed exclusively through the OneCLI Gateway proxy.
- The target calendar is always an explicit selection, never inferred when ambiguous — this holds for any calendar in the registry, hardcoded or config-added.
- All calendar writes are triggered by an explicit same-turn user chat instruction — no autonomous/background writes.
- Non-goals: free-busy conflict detection or scheduling suggestions; editing or cancelling a single occurrence of a recurring series independently of the whole series (creation-only for now — flagged as not yet structurally enforced, see Cross-Story Dependencies).
- The idempotency check is scoped per-calendar, not global — a near-identical event on two different calendars is not treated as a duplicate.
- Known, accepted limit: the duplicate-creation guard is best-effort, not atomic — two genuinely concurrent create calls can both pass the pre-check before either write lands. No server-side idempotency-key primitive exists to close this fully; not being built now given this system's household scale.

## Technical Decisions

- All four calendar tools (`create`/`list`/`update`/`delete_calendar_event`) live in `container/agent-runner/src/mcp-tools/calendar.ts`, registered via the existing `McpToolDefinition` + `registerTools()` convention. No new HTTP client dependency — direct `fetch()` against Google Calendar REST API v3 through the container's `HTTPS_PROXY`.
- **Duplicate guard (idempotency):** before the `POST`, run a `GET` bracketed by `timeMin`/`timeMax` around the requested start. A hit requires same `calendarId` + same timezone-normalized instant (never raw-string time comparison — two equal local numerals with different `timeZone` values are different instants) + case-insensitive-trimmed title match + candidate has no `recurrence` field set + candidate `created` within the last 10 minutes. On a hit, call `askUserQuestion` directly, in-process — "create anyway" vs. "skip, likely already exists" — never silently decide. This mirrors `delete_calendar_event`'s existing in-process-confirmation pattern (a `confirm`-style argument was already tried and rejected there after a live incident showed the agent could self-authorize past it).
- **Recurrence:** extend `create_calendar_event` with an optional `recurrence` argument — a single RFC5545 `RRULE` string. The handler wraps it as `recurrence: [recurrenceArg]` in the request body (Google's `Event.recurrence` field is an array of strings, not a bare string). No new tool, no new NL-to-RRULE dependency — the agent constructs the RRULE itself. Omitting the argument leaves single-occurrence behavior unchanged.
- **Calendar registry:** the `calendar` argument moves from a closed `uriel`/`devorah` enum to a DB-backed registry (`name → {calendarId, ownerEmail}`), following the same pattern as `src/db/container-configs.ts` (a DB row, not a `.ts` constants file — a source-file change would need a rebuild + service restart per this project's rebuild rules, which a DB write avoids). A newly added calendar's owner grants access the same way Devorah already does — native Google Calendar sharing with the one connected account, no second OAuth grant. Every existing hardcoded `uriel`/`devorah` reference (in `calendar.ts`, `container/skills/calendar/SKILL.md`, any validation/enum code) needs sweeping to the open registry.
- **Guest auto-validation:** before constructing the `attendees` array, every guest token that isn't already a valid email string is looked up automatically against `groups/household/memory/household/people.md` — not only when the agent already has it in context.
- **Ordering rule (load-bearing across stories):** when a single `create_calendar_event` call needs both a guest-resolution question (Story 2.4) and a duplicate-check question (Story 2.1), guest resolution always resolves first, the duplicate check runs second — the two questions are never asked simultaneously.
- Every event `dateTime` continues to carry an explicit `timeZone` resolved via the existing `resolveGroupTimezone` convention — this is what makes the idempotency guard's instant-normalized comparison correct, not a second timezone mechanism.
- Sender-to-calendar resolution ("my calendar") continues to read from `groups/household/memory/household/people.md`, never a hardcoded name — the same memory file Story 2.4's guest lookup also reads.

## UX & Interaction Patterns

- Ambiguous matches (multiple candidate events, multiple candidate guests) are always presented as a numbered list with the tool waiting for a pick — never a guess, matching the precedent already established for event disambiguation.
- Any blocking confirmation a tool needs (duplicate-creation hit, unmatched/ambiguous guest) is issued via `askUserQuestion` called directly inside the tool handler, in-process — never gated behind an agent-settable boolean argument the agent could self-authorize past. This lesson came from a live incident on the delete-confirmation flow and applies to every new blocking check added in this epic.
- An unmatched guest name (no household-memory match at all) is asked for directly and blocks rather than silently proceeding without an email.

## Cross-Story Dependencies

- Story order follows a dependency shape: 2.1 (idempotency) touches the same `create_calendar_event` path every other story in this epic also touches, so it goes first; then 2.2 (recurrence); then 2.3 (registry, which the other stories' calendar-argument resolution depends on); then 2.4 (guest validation — lowest-risk, most independent, but must respect the ordering rule against 2.1).
- Story 2.1's duplicate-match check must exclude any candidate event with a `recurrence` field set, so Story 2.2's recurring events don't cause false-positive duplicate matches against later occurrences.
- Story 2.3's registry change is a superseding rule for Story 2.1 and 2.2's calendar-argument handling — any calendar in the registry (not just the original two) must get the same idempotency and recurrence handling with no special-casing.
- Story 2.4 and Story 2.1 can both need to ask a question on the same `create_calendar_event` call — 2.4's guest question must resolve before 2.1's duplicate question runs (see Technical Decisions).
- Open, unresolved before Story 2.2 ships: whether `list_calendar_events` exposes individual occurrence `eventId`s for a recurring series (`singleEvents=true` semantics) — if so, `update_calendar_event`/`delete_calendar_event` need an explicit decision on whether to refuse single-occurrence edits, since that's currently a prose-only non-goal, not structurally enforced.
